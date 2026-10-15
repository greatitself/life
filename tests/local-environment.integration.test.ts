import { afterEach, describe, expect, it, vi } from 'vitest'
import { readFile, readdir, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { Agents } from '../src/main/agents'
import { SSHConnection } from '../src/main/ssh'
import { Store } from '../src/main/store'
import { shellQuote } from '../src/shared/validation'
import type { AgentEvent, Provider } from '../src/shared/types'
import { LocalFixture } from './helpers/local-fixture'

const resources: Array<{ fixture: LocalFixture; connection: SSHConnection; agents: Agents }> = []
afterEach(async () => {
  for (const { fixture, connection, agents } of resources.splice(0)) {
    await agents.releaseIdleProviders()
    await agents.releaseIdleClaudeProviders()
    agents.close()
    connection.disconnect()
    await fixture.close()
  }
})

async function setup(selectProject = true) {
  const fixture = await new LocalFixture().start()
  const store = new Store(join(fixture.root, 'settings'))
  await store.init()
  const connection = new SSHConnection(store, fixture.options)
  const events: AgentEvent[] = []
  const agents = new Agents(connection, (event) => events.push(event))
  resources.push({ fixture, connection, agents })
  const hostKey = vi.fn()
  connection.on('host-key', hostKey)
  await connection.connect(store.localProfile())
  await connection.whenProviderVersionsReady()
  if (selectProject) await connection.selectWorkspace(fixture.workspace)
  return { fixture, store, connection, agents, events, hostKey }
}

const waitFor = async (predicate: () => unknown | Promise<unknown>) =>
  vi.waitFor(async () => expect(await predicate()).toBeTruthy(), { timeout: 10000, interval: 20 })
const promptFrom = (entry: Record<string, any>) =>
  entry.kind === 'title-metadata'
    ? undefined
    : entry.message?.method === 'turn/start'
      ? entry.message.params.input?.find((block: any) => block.type === 'text')?.text
      : entry.message?.type === 'user'
        ? entry.message.message.content?.find((block: any) => block.type === 'text')?.text
        : undefined

async function processRunning(pid: number) {
  try {
    process.kill(pid, 0)
    if (process.platform === 'linux') {
      const state = await readFile(`/proc/${pid}/stat`, 'utf8')
      if (state.slice(state.lastIndexOf(')') + 2).startsWith('Z')) return false
    }
    return true
  } catch (error) {
    if (['ESRCH', 'ENOENT'].includes((error as NodeJS.ErrnoException).code ?? '')) return false
    throw error
  }
}
async function brokerState(fixture: LocalFixture) {
  const root = join(fixture.root, '.life/agent-sessions')
  const entries = await readdir(root)
  const live = []
  for (const entry of entries) {
    const state = JSON.parse(await readFile(join(root, entry, 'state.json'), 'utf8'))
    if (Number.isSafeInteger(state.pid) && state.pid > 1 && (await processRunning(state.pid)))
      live.push(state)
  }
  expect(live).toHaveLength(1)
  const state = live[0]
  expect(Number.isSafeInteger(state.pid) && state.pid > 1).toBe(true)
  expect(Number.isSafeInteger(state.brokerPid) && state.brokerPid > 1).toBe(true)
  return state as { pid: number; brokerPid: number }
}

describe('actual local environment', () => {
  it('connects the canonical computer without SSH credentials, host-key prompts or auth mutation', async () => {
    const inheritedHome = process.env.HOME
    const inheritedCodexHome = process.env.CODEX_HOME
    const { fixture, store, connection, hostKey } = await setup()
    expect(connection.state).toMatchObject({
      status: 'connected',
      workspace: fixture.workspace,
      codex: 'codex-cli test.0',
      claude: '2.test.0 (Claude Code fixture)',
      profile: { id: store.localProfile().id, transport: 'local' },
    })
    expect(hostKey).not.toHaveBeenCalled()
    expect(connection.state.profile).not.toHaveProperty('password')
    expect(await connection.exec('printf LOCAL_PROCESS_READY')).toBe('LOCAL_PROCESS_READY')
    expect(process.env.HOME).toBe(inheritedHome)
    expect(process.env.CODEX_HOME).toBe(inheritedCodexHome)
    expect(fixture.env.HOME).toBe(inheritedHome)
    expect(fixture.env.CODEX_HOME).toBe(inheritedCodexHome)
  })

  it('browses real directories and previews only safe text inside the selected project', async () => {
    const { fixture, connection } = await setup()
    const folders = await connection.listDirectories(fixture.root)
    expect(folders.entries).toContainEqual({
      name: "workspace's café 🧪",
      path: fixture.workspace,
    })
    expect((await connection.list()).map((entry) => entry.name)).toContain('README.md')
    expect((await connection.list()).map((entry) => entry.name)).not.toContain('.git')
    expect((await connection.list()).map((entry) => entry.name)).not.toContain('node_modules')
    expect(await connection.read('README.md')).toBe('# Local fixture café 🧪\n')
    await expect(connection.read('escape-link')).rejects.toThrow(/outside|workspace/i)
    await expect(connection.read('../outside.txt')).rejects.toThrow(/outside|workspace/i)
    await expect(connection.read('binary.dat')).rejects.toThrow(/binary/i)
    await expect(connection.read('large.txt')).rejects.toThrow(/1 MB|limit/i)
    await expect(connection.selectWorkspace(join(fixture.root, 'missing'))).rejects.toThrow()
    expect(connection.state.workspace).toBe(fixture.workspace)
    expect(await connection.read('README.md')).toBe('# Local fixture café 🧪\n')
  })

  it('uses the local Git working tree and preserves exact filenames and Unicode changes', async () => {
    const { fixture, connection } = await setup()
    await writeFile(join(fixture.workspace, 'src/index.ts'), 'export const answer = "café 🧪"\n')
    await writeFile(join(fixture.workspace, 'untracked café.txt'), 'Untracked local text\n')
    const state = await connection.git()
    expect(state.branch).toBe(fixture.git('symbolic-ref', '--short', 'HEAD').trim())
    expect(state.diff).toContain('-export const answer = 42')
    expect(state.diff).toContain('+export const answer = "café 🧪"')
    expect(state.status).toContain('untracked café.txt')
  })

  it('provides an actual interactive TTY, accepts input and applies rows and columns', async () => {
    const { connection } = await setup()
    let output = ''
    connection.on('terminal', (chunk: string) => (output += chunk))
    await connection.openTerminal()
    await waitFor(() => output.includes('LIFE_LOCAL_SHELL_READY>'))
    connection.resizeTerminal(119, 31)
    connection.writeTerminal(
      'printf "\\nLIFE_TTY=%s:%s\\n" "$(test -t 0 && printf yes || printf no)" "$(stty size)"\n',
    )
    await waitFor(() => output.includes('LIFE_TTY=yes:31 119'))
    connection.writeTerminal('printf "\\nLIFE_INPUT=%s\\n" "café 漢字 🧪"\n')
    await waitFor(() => output.includes('LIFE_INPUT=café 漢字 🧪'))
    connection.closeTerminal()
    await waitFor(() => output.includes('[Terminal closed]'))
  })

  it('executes stdin exactly and cancels a running local process without losing the environment', async () => {
    const { connection } = await setup()
    const input = '  café 漢字 🧪\n\t$literal `shell` "quotes"  \n'
    const echo = 'process.stdin.pipe(process.stdout)'
    expect(await connection.exec(`node -e ${shellQuote(echo)}`, { input })).toBe(input)
    const controller = new AbortController()
    const running = connection.exec(`node -e ${shellQuote('setInterval(() => {}, 1000)')}`, {
      signal: controller.signal,
    })
    controller.abort()
    await expect(running).rejects.toThrow(/cancel|abort/i)
    expect(connection.state.status).toBe('connected')
    expect(await connection.exec('printf STILL_LOCAL')).toBe('STILL_LOCAL')
  })

  it('rejects forged Local connections before disturbing the active project or interactive terminal', async () => {
    const { fixture, store, connection } = await setup()
    let output = ''
    const disconnected = vi.fn()
    connection.on('disconnected', disconnected)
    connection.on('terminal', (chunk: string) => (output += chunk))
    await connection.openTerminal()
    await waitFor(() => output.includes('LIFE_LOCAL_SHELL_READY>'))
    const local = store.localProfile()
    for (const changed of [
      { host: 'another-computer.invalid' },
      { id: 'local:00000000-0000-0000-0000-000000000000' },
      { auth: 'password' as const },
      { sshConfig: { alias: 'another-machine', path: '/fixture/config' } },
      { transport: 'ssh' as const },
    ]) {
      await expect(connection.connect({ ...local, ...changed })).rejects.toThrow()
      expect(connection.state).toMatchObject({
        status: 'connected',
        profile: { id: local.id, transport: 'local' },
        workspace: fixture.workspace,
      })
    }
    expect(disconnected).not.toHaveBeenCalled()
    expect(output).not.toContain('[Terminal closed]')
    connection.writeTerminal('printf "\\nLIFE_AFTER_REJECTION=%s\\n" "STILL_OPEN"\n')
    await waitFor(() => output.includes('LIFE_AFTER_REJECTION=STILL_OPEN'))
    expect(await connection.read('README.md')).toBe('# Local fixture café 🧪\n')
  })

  it.each<Provider>(['codex', 'claude'])(
    '%s keeps native prompts, workspace, permissions and session identity through local resume',
    async (provider) => {
      const { fixture, connection, agents, events } = await setup()
      const sessionId = `local-${provider}-exact`
      const prompt = '/life  This belongs to my local project\n\tcafé 漢字 🧪 "$literal"  \n'
      expect(await agents.models(provider)).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ id: provider === 'codex' ? 'fixture-model' : 'opus' }),
        ]),
      )
      await agents.start({ sessionId, provider, prompt, mode: 'review' })
      await waitFor(() =>
        events.some((event) => event.sessionId === sessionId && event.type === 'complete'),
      )
      const first = (await fixture.log()).find((entry) => promptFrom(entry) === prompt)
      expect(first?.cwd).toBe(fixture.workspace)
      expect(first?.provider).toBe(provider)
      const nativeId = events.find(
        (event) => event.sessionId === sessionId && event.remoteId,
      )?.remoteId
      expect(nativeId).toBeTruthy()
      const approvalBaseline = events.length
      const approvalLogBaseline = (await fixture.log()).length
      await agents.start({
        sessionId,
        provider,
        prompt: 'approval',
        mode: 'review',
        remoteId: nativeId,
      })
      await waitFor(() => events.slice(approvalBaseline).some((event) => event.type === 'approval'))
      const request = events.slice(approvalBaseline).find((event) => event.type === 'approval')!
      expect(request.requestId).toBeTruthy()
      await agents.respond(sessionId, request.requestId!, true)
      await waitFor(() => events.slice(approvalBaseline).some((event) => event.type === 'complete'))
      const approvalLog = (await fixture.log())
        .slice(approvalLogBaseline)
        .filter((entry) => entry.provider === provider && entry.kind !== 'title-metadata')
      if (provider === 'codex') {
        const turn = approvalLog.find(
          (entry) => entry.kind === 'turn-started' && entry.prompt === 'approval',
        )!
        const sequence = Number(turn.turnId.replace('turn-', ''))
        const responses = approvalLog.filter(
          (entry) => entry.message?.id === 9000 + sequence && !entry.message.method,
        )
        expect(responses).toHaveLength(1)
        expect(responses[0].message.result).toEqual({ decision: 'accept' })
      } else {
        const responses = approvalLog.filter(
          (entry) =>
            entry.message?.type === 'control_response' &&
            entry.message.response.request_id === request.requestId,
        )
        expect(responses).toHaveLength(1)
        expect(responses[0].message.response).toEqual({
          subtype: 'success',
          request_id: request.requestId,
          response: { behavior: 'allow', updatedInput: { command: 'npm test' } },
        })
      }
      expect(
        events.filter((event) => event.sessionId === sessionId && event.type === 'error'),
      ).toEqual([])
      expect(
        events
          .filter((event) => event.sessionId === sessionId && event.remoteId)
          .every((event) => event.remoteId === nativeId),
      ).toBe(true)
      expect(connection.state.workspace).toBe(fixture.workspace)
      const received = (await fixture.log()).filter((entry) => promptFrom(entry) === prompt)
      expect(received).toHaveLength(1)
      if (provider === 'codex') {
        const turn = received[0].message.params
        expect(turn.approvalPolicy).toBe('untrusted')
      } else {
        const launches = (await fixture.log()).filter(
          (entry) => entry.provider === 'claude' && entry.argv,
        )
        expect(
          launches.some(
            (entry) => entry.argv.includes('--permission-mode') && entry.argv.includes('default'),
          ),
        ).toBe(true)
      }
    },
    20000,
  )

  it('acknowledges idle local Claude shutdown and resumes its exact native session without interrupting a completed turn', async () => {
    const { fixture, agents, events } = await setup()
    const sessionId = 'idle-local-claude'
    const prompt = '  Idle local Claude native session café 漢字 🧪\n'
    await agents.start({ sessionId, provider: 'claude', prompt, mode: 'review' })
    await waitFor(() =>
      events.some((event) => event.sessionId === sessionId && event.type === 'complete'),
    )
    const remoteId = events.find(
      (event) => event.sessionId === sessionId && event.remoteId,
    )?.remoteId
    expect(remoteId).toBeTruthy()
    const before = await brokerState(fixture)
    expect(await processRunning(before.pid)).toBe(true)
    const eventBaseline = events.length
    expect(await agents.releaseIdleClaudeProviders()).toEqual([true])
    await waitFor(
      async () => !(await processRunning(before.pid)) && !(await processRunning(before.brokerPid)),
    )
    expect(
      events
        .slice(eventBaseline)
        .some(
          (event) =>
            event.type === 'error' || (event.type === 'complete' && event.status === 'interrupted'),
        ),
    ).toBe(false)
    const logBaseline = (await fixture.log()).length
    const followup = '  Resume that exact local Claude session café 🧪\n'
    await agents.start({ sessionId, provider: 'claude', prompt: followup, mode: 'review' })
    await waitFor(() =>
      events
        .slice(eventBaseline)
        .some((event) => event.sessionId === sessionId && event.type === 'complete'),
    )
    const log = (await fixture.log()).filter((entry) => entry.kind !== 'title-metadata')
    expect(log.filter((entry) => promptFrom(entry) === prompt)).toHaveLength(1)
    expect(log.filter((entry) => promptFrom(entry) === followup)).toHaveLength(1)
    const resumed = (await fixture.log())
      .slice(logBaseline)
      .find(
        (entry) =>
          entry.provider === 'claude' &&
          Array.isArray(entry.argv) &&
          (entry.argv.includes('--resume') || entry.argv.includes(`--resume=${remoteId}`)),
      )
    const resumedId =
      resumed?.argv
        .find((argument: string) => argument.startsWith('--resume='))
        ?.slice('--resume='.length) || resumed?.argv[resumed.argv.indexOf('--resume') + 1]
    expect(resumedId).toBe(remoteId)
    expect(
      log.some(
        (entry) =>
          entry.message?.type === 'control_request' &&
          entry.message.request?.subtype === 'interrupt',
      ),
    ).toBe(false)
    expect(
      events
        .filter((event) => event.sessionId === sessionId && event.remoteId)
        .every((event) => event.remoteId === remoteId),
    ).toBe(true)
  }, 15000)

  it('refuses idle Claude release during live work or a pending native approval and preserves the exact acceptance response', async () => {
    const { fixture, agents, events } = await setup()
    const sessionId = 'busy-local-claude'
    await agents.start({ sessionId, provider: 'claude', prompt: 'hang', mode: 'review' })
    await waitFor(() =>
      events.some((event) => event.sessionId === sessionId && event.type === 'text'),
    )
    const owner = await brokerState(fixture)
    expect(await agents.releaseIdleClaudeProviders()).toEqual([false])
    expect(await processRunning(owner.pid)).toBe(true)
    await agents.stop(sessionId)
    const baseline = events.length
    const logBaseline = (await fixture.log()).length
    await agents.start({ sessionId, provider: 'claude', prompt: 'approval', mode: 'review' })
    await waitFor(() => events.slice(baseline).some((event) => event.type === 'approval'))
    const request = events.slice(baseline).find((event) => event.type === 'approval')!
    const pendingOwner = await brokerState(fixture)
    expect(await agents.releaseIdleClaudeProviders()).toEqual([false])
    expect(await processRunning(pendingOwner.pid)).toBe(true)
    await agents.respond(sessionId, request.requestId!, true)
    await waitFor(() => events.slice(baseline).some((event) => event.type === 'complete'))
    const log = (await fixture.log()).filter((entry) => entry.kind !== 'title-metadata')
    expect(log.filter((entry) => promptFrom(entry) === 'hang')).toHaveLength(1)
    expect(log.filter((entry) => promptFrom(entry) === 'approval')).toHaveLength(1)
    const responses = (await fixture.log())
      .slice(logBaseline)
      .filter(
        (entry) =>
          entry.message?.type === 'control_response' &&
          entry.message.response.request_id === request.requestId,
      )
    expect(responses).toHaveLength(1)
    expect(responses[0].message.response.response).toEqual({
      behavior: 'allow',
      updatedInput: { command: 'npm test' },
    })
    expect(events.slice(baseline).filter((event) => event.type === 'error')).toEqual([])
    expect(await agents.releaseIdleClaudeProviders()).toEqual([true])
    await waitFor(async () => !(await processRunning(pendingOwner.pid)))
  }, 15000)
})
