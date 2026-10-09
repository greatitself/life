import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { basename, join } from 'node:path'
import { existsSync } from 'node:fs'
import { mkdir, mkdtemp, rm, symlink } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { Store } from '../src/main/store'
import { SSHConnection } from '../src/main/ssh'
import { Agents } from '../src/main/agents'
import type { AgentEvent, HostKeyRequest, Provider, StartInput } from '../src/shared/types'
import { SSHFixture } from './helpers/ssh-fixture'
import { buildLifeThreadPrompt, extractLifeThreadResponse } from '../src/renderer/life-thread'
import { defaultLifeConfig } from '../src/shared/customization'

let fixture: SSHFixture
let connection: SSHConnection
let store: Store
let agents: Agents
let events: AgentEvent[]
let trustRequests: HostKeyRequest[]
let sequence = 0
const waitFor = async (predicate: () => unknown | Promise<unknown>) =>
  vi.waitFor(async () => expect(await predicate()).toBeTruthy(), { timeout: 5000, interval: 20 })
const start = (
  provider: Provider,
  prompt: string,
  extra: Partial<StartInput> = {},
): StartInput => ({ sessionId: provider + '-local', provider, prompt, mode: 'review', ...extra })
const eventOf = (type: AgentEvent['type'], sessionId?: string) =>
  events.find((event) => event.type === type && (!sessionId || event.sessionId === sessionId))

beforeAll(async () => {
  fixture = await new SSHFixture().start()
})
afterAll(async () => {
  await fixture.close()
})
beforeEach(async () => {
  events = []
  trustRequests = []
  fixture.initializationDelay = 0
  store = new Store(join(fixture.root, 'settings-' + ++sequence))
  await store.init()
  connection = new SSHConnection(store)
  agents = new Agents(connection, (event) => events.push(event))
})
afterEach(() => {
  connection.disconnect()
  agents.close()
})

async function connect(accept = true, selectProject = true) {
  connection.on('host-key', (request: HostKeyRequest) => {
    trustRequests.push(request)
    connection.trust(request.id, accept)
  })
  const state = await connection.connect(fixture.input())
  return selectProject ? connection.selectWorkspace(fixture.workspace) : state
}

describe('real SSH host verification and workspace connection', () => {
  it('requires trust on first use, persists the fingerprint, and reconnects without prompting', async () => {
    const state = await connect(true, false)
    expect(state).toMatchObject({
      status: 'connected',
      home: fixture.root,
      lastWorkspace: fixture.workspace,
      codex: 'codex-cli test.0',
      claude: '2.test.0 (Claude Code fixture)',
    })
    expect(state.workspace).toBeUndefined()
    expect(state.profile).not.toHaveProperty('password')
    expect(trustRequests).toHaveLength(1)
    expect(trustRequests[0]).toMatchObject({ host: '127.0.0.1:' + fixture.port })
    expect(trustRequests[0].fingerprint).toMatch(/^SHA256:[A-Za-z0-9+/]{43}$/)
    const reloaded = new Store(join(fixture.root, 'settings-' + sequence))
    await reloaded.init()
    expect(reloaded.hostKey(trustRequests[0].host)).toBe(trustRequests[0].fingerprint)
    connection.disconnect()
    const reconnected = await connection.connect(fixture.input())
    expect(reconnected.workspace).toBeUndefined()
    expect(reconnected.lastWorkspace).toBe(fixture.workspace)
    expect(trustRequests).toHaveLength(1)
  })

  it('rejects declined host keys and never persists them', async () => {
    await expect(connect(false)).rejects.toThrow()
    expect(connection.state.status).toBe('disconnected')
    expect(store.hostKey('127.0.0.1:' + fixture.port)).toBeUndefined()
  })

  it('blocks changed saved fingerprints without replacing the trusted identity', async () => {
    const host = '127.0.0.1:' + fixture.port
    await store.trust(host, 'SHA256:wrong-fingerprint')
    await expect(connect()).rejects.toThrow(/host key changed/i)
    expect(connection.state.status).toBe('disconnected')
    expect(store.hostKey(host)).toBe('SHA256:wrong-fingerprint')
    expect(trustRequests).toEqual([])
  })

  it('surfaces an authentication failure and clears the failed connection', async () => {
    connection.on('host-key', (request: HostKeyRequest) => connection.trust(request.id, true))
    await expect(
      connection.connect({ ...fixture.input(), password: 'incorrect-password' }),
    ).rejects.toThrow(/authentication/i)
    expect(connection.state.status).toBe('disconnected')
    await expect(connection.exec('printf unreachable')).rejects.toThrow(/connect/i)
  })
})

describe('project selection after SSH connection', () => {
  it.each([undefined, 'removed-project'])(
    'connects without a project when the saved workspace is %s',
    async (savedWorkspace) => {
      connection.on('host-key', (request: HostKeyRequest) => connection.trust(request.id, true))
      const state = await connection.connect({
        ...fixture.input(),
        workspace: savedWorkspace ? join(fixture.root, savedWorkspace) : undefined,
      })
      expect(state).toMatchObject({ status: 'connected', home: fixture.root })
      expect(state.workspace).toBeUndefined()
      expect(state.lastWorkspace).toBe(savedWorkspace ? undefined : fixture.root)
      expect(await connection.exec('printf MACHINE_READY')).toBe('MACHINE_READY')
      await connection.selectWorkspace(fixture.workspace)
      expect(connection.state.workspace).toBe(fixture.workspace)
    },
  )

  it('browses remote directories before choosing a project and keeps project operations gated', async () => {
    await connect(true, false)
    const directories = await connection.listDirectories()
    expect(directories.path).toBe(fixture.root)
    expect(directories.entries).toContainEqual({
      name: basename(fixture.workspace),
      path: fixture.workspace,
    })
    expect(directories.entries.map((entry) => entry.name)).not.toContain('outside.txt')
    for (const operation of [
      () => connection.list(),
      () => connection.read('README.md'),
      () => connection.git(),
      () => connection.openTerminal(),
      () => agents.models('codex'),
      () => agents.models('claude'),
      () => agents.start(start('codex', 'hello')),
    ])
      await expect(operation()).rejects.toThrow(/project|workspace/i)
    expect(connection.state.status).toBe('connected')
    expect(connection.state.workspace).toBeUndefined()
  })

  it('rejects missing paths and files without losing the SSH connection or current project', async () => {
    await connect()
    let terminal = ''
    connection.on('terminal', (text) => {
      terminal += text
    })
    await connection.openTerminal()
    await agents.start(start('codex', 'hang'))
    await waitFor(() => eventOf('text'))
    for (const path of [join(fixture.root, 'missing-project'), join(fixture.root, 'outside.txt')]) {
      await expect(connection.selectWorkspace(path)).rejects.toThrow()
      expect(connection.state).toMatchObject({
        status: 'connected',
        home: fixture.root,
        workspace: fixture.workspace,
      })
      expect(await connection.read('README.md')).toBe('# Fixture workspace\n')
    }
    expect(eventOf('error')).toBeUndefined()
    expect(terminal).not.toContain('[Terminal closed]')
    await expect(agents.start(start('codex', 'still-busy'))).rejects.toThrow(/already running/i)
    connection.writeTerminal("printf 'VALID_PROJECT_%s\\n' TERMINAL\n")
    await waitFor(() => terminal.includes('VALID_PROJECT_TERMINAL'))
    await agents.stop('codex-local')
  })

  it('resolves a project symlink canonically and permits projects outside the remote home', async () => {
    const externalProject = await mkdtemp(join(tmpdir(), 'life-external-project-'))
    const alias = join(fixture.root, 'external-project')
    try {
      await symlink(externalProject, alias)
      await connect(true, false)
      const state = await connection.selectWorkspace(alias)
      expect(state).toMatchObject({
        status: 'connected',
        home: fixture.root,
        workspace: externalProject,
      })
      expect((await connection.listDirectories(alias)).path).toBe(externalProject)
      expect(await connection.exec('printf STILL_CONNECTED')).toBe('STILL_CONNECTED')
    } finally {
      await rm(alias, { force: true })
      await rm(externalProject, { recursive: true, force: true })
    }
  })

  describe.each<Provider>(['codex', 'claude'])('%s project lifecycle', (provider) => {
    beforeEach(async () => {
      await connect()
    })

    it('keeps the active agent and terminal when the same canonical project is selected again', async () => {
      let terminal = ''
      connection.on('terminal', (text) => {
        terminal += text
      })
      await connection.openTerminal()
      await agents.start(start(provider, 'hang'))
      await waitFor(() => eventOf('text'))
      const beforePtys = fixture.ptys.length
      const beforeEvents = events.length
      await connection.selectWorkspace(fixture.workspace + '/.')
      expect(connection.state.workspace).toBe(fixture.workspace)
      expect(events.slice(beforeEvents).some((event) => event.type === 'error')).toBe(false)
      expect(terminal).not.toContain('[Terminal closed]')
      connection.writeTerminal("printf 'SAME_PROJECT_%s\\n' TERMINAL\n")
      await waitFor(() => terminal.includes('SAME_PROJECT_TERMINAL'))
      expect(fixture.ptys).toHaveLength(beforePtys)
      await expect(agents.start(start(provider, 'should-still-be-busy'))).rejects.toThrow(
        /already running/i,
      )
      await agents.stop(provider + '-local')
      await waitFor(() =>
        events.some((event) => event.type === 'complete' && event.status === 'interrupted'),
      )
    })

    it('closes the previous project agent and terminal before starting work in a different project', async () => {
      const nextProject = join(fixture.root, 'next-project-' + provider)
      await mkdir(nextProject, { recursive: true })
      let terminal = ''
      connection.on('terminal', (text) => {
        terminal += text
      })
      await connection.openTerminal()
      await agents.start(start(provider, 'hang'))
      await waitFor(() => eventOf('text'))
      const remoteId = eventOf('session')!.remoteId!
      await connection.selectWorkspace(nextProject)
      expect(connection.state).toMatchObject({ status: 'connected', workspace: nextProject })
      expect(terminal).toContain('[Terminal closed]')
      expect(
        events.some((event) => event.type === 'error' && /project/i.test(event.text || '')),
      ).toBe(true)
      events.length = 0
      await agents.start(start(provider, 'hello', { workspace: nextProject }))
      await waitFor(() => eventOf('complete'))
      expect(eventOf('error')).toBeUndefined()
      const logs = await fixture.log()
      if (provider === 'codex')
        expect(
          [...logs]
            .reverse()
            .find((entry) => entry.provider === 'codex' && entry.message?.method === 'thread/start')
            ?.message?.params.cwd,
        ).toBe(nextProject)
      else {
        const invocation = [...logs]
          .reverse()
          .find(
            (entry) =>
              entry.provider === 'claude' && entry.argv && !entry.argv.includes('--version'),
          )
        expect(invocation?.argv).not.toContain('--resume=' + remoteId)
        expect(
          fixture.commands.some(
            (command) => command.includes(nextProject) && command.includes('claude'),
          ),
        ).toBe(true)
      }
    })

    it('rejects an expected project mismatch before launching the provider', async () => {
      const baseline = (await fixture.log()).length
      await expect(
        agents.start(start(provider, 'must-not-run', { workspace: fixture.root })),
      ).rejects.toThrow(/project|workspace/i)
      expect((await fixture.log()).slice(baseline)).toEqual([])
      expect(connection.state.workspace).toBe(fixture.workspace)
      await agents.start(start(provider, 'hello', { workspace: fixture.workspace }))
      await waitFor(() => eventOf('complete'))
      expect(eventOf('error')).toBeUndefined()
    })
  })
})

describe('real SFTP previews and terminal channels', () => {
  beforeEach(async () => {
    await connect()
  })

  it('lists directories first, hides dependency metadata, and previews files from the workspace', async () => {
    const files = await connection.list()
    expect(files[0]).toMatchObject({ name: 'src', directory: true })
    expect(files.map((file) => file.name)).not.toContain('node_modules')
    expect(files.map((file) => file.name)).not.toContain('.git')
    expect(await connection.read('src/index.ts')).toBe('export const answer = 42\n')
    expect(await connection.read(join(fixture.workspace, 'README.md'))).toBe(
      '# Fixture workspace\n',
    )
    expect(await connection.list('src')).toEqual([
      {
        name: 'index.ts',
        path: join(fixture.workspace, 'src/index.ts'),
        directory: false,
        size: 25,
      },
    ])
  })

  it('rejects traversal, absolute outside paths, and symlink escapes after canonicalization', async () => {
    for (const path of ['../outside.txt', join(fixture.root, 'outside.txt'), 'escape-link'])
      await expect(connection.read(path)).rejects.toThrow(/outside the workspace/i)
    await expect(connection.list('..')).rejects.toThrow(/outside the workspace/i)
    await expect(connection.read('invalid\0path')).rejects.toThrow(/invalid path/i)
  })

  it('refuses oversized and binary previews', async () => {
    await expect(connection.read('large.txt')).rejects.toThrow(/1 MB/)
    await expect(connection.read('binary.dat')).rejects.toThrow(/binary/i)
  })

  it('opens an SSH PTY channel, forwards terminal input/output, and sends window resize requests', async () => {
    let output = ''
    connection.on('terminal', (text) => {
      output += text
    })
    await connection.openTerminal()
    connection.resizeTerminal(120, 32)
    connection.writeTerminal("printf 'TERMINAL_FIXTURE_%s\\n' 42\n")
    await waitFor(() => output.includes('TERMINAL_FIXTURE_42'))
    expect(fixture.ptys.at(-1)).toMatchObject({ term: 'xterm-256color', cols: 100, rows: 18 })
    await waitFor(() => fixture.resizes.at(-1)?.cols === 120)
    expect(fixture.resizes.at(-1)).toMatchObject({ cols: 120, rows: 32 })
    connection.closeTerminal()
    await waitFor(() => output.includes('[Terminal closed]'))
  })
})

describe.each<Provider>(['codex', 'claude'])(
  '%s over real SSH with a deterministic CLI',
  (provider) => {
    beforeEach(async () => {
      await connect()
    })

    it('streams Unicode text, reports remote identity, and completes the turn', async () => {
      await agents.start(start(provider, 'hello'))
      await waitFor(() => eventOf('complete'))
      expect(eventOf('session')?.remoteId).toBe(provider + '-remote-1')
      const streamed = events
        .filter((event) => event.type === 'text' && event.status !== 'replace')
        .map((event) => event.text)
        .join('')
      expect(streamed).toBe(`Hello from ${provider === 'codex' ? 'Codex' : 'Claude'} 👋`)
      expect(
        events.find((event) => event.type === 'text' && event.status === 'replace')?.text,
      ).toBe(streamed)
      expect(eventOf('error')).toBeUndefined()
    })

    it('continues Life changes and clarification in the same ordinary provider conversation', async () => {
      const baseline = (await fixture.log()).length
      await agents.start(start(provider, 'hello'))
      await waitFor(() => eventOf('complete'))
      const remoteId = eventOf('session')!.remoteId!
      for (const [request, kind] of [
        ['clarify customization', 'message'],
        ['no change customization', 'message'],
        ['make select components use shadcn', 'message'],
        ['add research panels', 'settings'],
        ['add executable extension counter', 'extension'],
      ] as const) {
        events.length = 0
        await agents.start(
          start(provider, buildLifeThreadPrompt(request, defaultLifeConfig, []), { mode: 'plan' }),
        )
        await waitFor(() => eventOf('complete'))
        const text = events
          .filter((event) => event.type === 'text' && event.status === 'replace')
          .map((event) => event.text)
          .join('\n')
        expect(extractLifeThreadResponse(text).kind, request).toBe(kind)
        expect(eventOf('error')).toBeUndefined()
        if (eventOf('session')) expect(eventOf('session')!.remoteId).toBe(remoteId)
      }
      events.length = 0
      await agents.start(start(provider, 'remote-life-markers'))
      await waitFor(() => eventOf('complete'))
      const source = events.find(
        (event) => event.type === 'text' && event.status === 'replace',
      )!.text!
      expect(extractLifeThreadResponse(source, false)).toEqual({ kind: 'message', message: source })
      const logs = (await fixture.log())
        .slice(baseline)
        .filter((entry) => entry.provider === provider)
      if (provider === 'codex') {
        const turns = logs.filter((entry) => entry.message?.method === 'turn/start')
        expect(turns).toHaveLength(7)
        expect(turns.every((entry) => entry.message?.params?.threadId === remoteId)).toBe(true)
        expect(
          turns
            .slice(1, 6)
            .every((entry) => entry.message?.params?.sandboxPolicy?.type === 'readOnly'),
        ).toBe(true)
        expect(turns.at(-1)?.message?.params?.sandboxPolicy?.type).toBe('workspaceWrite')
        expect(logs.filter((entry) => entry.message?.method === 'thread/start')).toHaveLength(1)
      } else {
        const invocations = logs.filter((entry) => entry.argv && !entry.argv.includes('--version'))
        expect(invocations).toHaveLength(7)
        expect(
          invocations.slice(1).every((entry) => entry.argv!.includes('--resume=' + remoteId)),
        ).toBe(true)
        expect(
          invocations
            .slice(1, 6)
            .every((entry) => entry.argv![entry.argv!.indexOf('--permission-mode') + 1] === 'plan'),
        ).toBe(true)
        expect(invocations.at(-1)?.argv).toContain('default')
      }
    })

    it('waits for approval and returns the provider-specific accepted response', async () => {
      await agents.start(start(provider, 'approval'))
      await waitFor(() => eventOf('approval'))
      const approval = eventOf('approval')!
      expect(approval.text).toBe('npm test')
      expect(eventOf('complete')).toBeUndefined()
      await agents.respond(approval.sessionId, approval.requestId!, true)
      await waitFor(() => eventOf('complete'))
      const logs = await fixture.log()
      if (provider === 'codex') {
        expect(events.find((event) => event.type === 'tool-output')?.text).toBe('fixture output\n')
        expect(
          [...logs]
            .reverse()
            .find((entry) => entry.provider === 'codex' && entry.message?.result?.decision)?.message
            ?.result,
        ).toEqual({ decision: 'accept' })
      } else
        expect(
          [...logs]
            .reverse()
            .find(
              (entry) => entry.provider === 'claude' && entry.message?.type === 'control_response',
            )?.message?.response.response,
        ).toEqual({ behavior: 'allow', updatedInput: { command: 'npm test' } })
      await expect(agents.respond(approval.sessionId, approval.requestId!, true)).rejects.toThrow(
        /no longer pending/i,
      )
    })

    it('returns a declined permission decision without allowing the requested tool', async () => {
      await agents.start(start(provider, 'approval'))
      await waitFor(() => eventOf('approval'))
      const approval = eventOf('approval')!
      await agents.respond(approval.sessionId, approval.requestId!, false)
      await waitFor(() => eventOf('complete'))
      const logs = await fixture.log()
      if (provider === 'codex')
        expect(
          [...logs]
            .reverse()
            .find((entry) => entry.provider === 'codex' && entry.message?.result?.decision)?.message
            ?.result,
        ).toEqual({ decision: 'decline' })
      else
        expect(
          [...logs]
            .reverse()
            .find(
              (entry) => entry.provider === 'claude' && entry.message?.type === 'control_response',
            )?.message?.response.response,
        ).toEqual({ behavior: 'deny', message: 'The user declined this action' })
    })

    it('maps user questions and answers into the corresponding provider control protocol', async () => {
      await agents.start(start(provider, 'question'))
      await waitFor(() => eventOf('question'))
      const question = eventOf('question')!
      expect(question.questions?.[0].question).toBe('Which language?')
      const answerId = question.questions![0].id
      await agents.respond(question.sessionId, question.requestId!, true, {
        [answerId]: ['TypeScript'],
      })
      await waitFor(() => eventOf('complete'))
      const logs = await fixture.log()
      if (provider === 'codex')
        expect(
          [...logs]
            .reverse()
            .find((entry) => entry.provider === 'codex' && entry.message?.result?.answers)?.message
            ?.result,
        ).toEqual({ answers: { language: { answers: ['TypeScript'] } } })
      else
        expect(
          [...logs]
            .reverse()
            .find(
              (entry) => entry.provider === 'claude' && entry.message?.type === 'control_response',
            )?.message?.response.response.updatedInput.answers,
        ).toEqual({ 'Which language?': 'TypeScript' })
    })

    it('stops an active turn, rejects simultaneous sends, and resumes the saved remote conversation', async () => {
      await agents.start(start(provider, 'hang'))
      await waitFor(() => eventOf('text'))
      await expect(agents.start(start(provider, 'another prompt'))).rejects.toThrow(
        /already running/i,
      )
      const remoteId = eventOf('session')!.remoteId!
      await agents.stop(provider + '-local')
      await waitFor(() =>
        events.find((event) => event.type === 'complete' && event.status === 'interrupted'),
      )
      const logs = await fixture.log()
      expect(
        logs.some(
          (entry) =>
            entry.provider === provider &&
            (entry.message?.method === 'turn/interrupt' ||
              entry.message?.request?.subtype === 'interrupt'),
        ),
      ).toBe(true)
      connection.disconnect()
      await connection.connect(fixture.input())
      await connection.selectWorkspace(fixture.workspace)
      events.length = 0
      await agents.start(
        start(provider, 'hello', { remoteId, mode: 'plan', model: 'fixture-model' }),
      )
      await waitFor(() => eventOf('complete'))
      const resumed = await fixture.log()
      if (provider === 'codex') {
        expect(
          [...resumed]
            .reverse()
            .find(
              (entry) => entry.provider === 'codex' && entry.message?.method === 'thread/resume',
            )?.message?.params,
        ).toMatchObject({
          threadId: remoteId,
          sandbox: 'read-only',
          approvalPolicy: 'on-request',
          model: 'fixture-model',
        })
        expect(
          [...resumed]
            .reverse()
            .find((entry) => entry.provider === 'codex' && entry.message?.method === 'turn/start')
            ?.message?.params.sandboxPolicy,
        ).toEqual({ type: 'readOnly' })
      } else {
        const argv = [...resumed]
          .reverse()
          .find(
            (entry) =>
              entry.provider === 'claude' && entry.argv && !entry.argv.includes('--version'),
          )!.argv!
        expect(argv).toEqual(
          expect.arrayContaining([
            '--resume=' + remoteId,
            '--model=fixture-model',
            '--permission-mode',
            'plan',
          ]),
        )
      }
    })

    it('stops during slow initialization without sending the canceled prompt or corrupting a replacement turn', async () => {
      const baseline = (await fixture.log()).length
      fixture.initializationDelay = 1200
      let startupSettled = false
      const starting = agents.start(start(provider, 'canceled-before-initialization')).then(() => {
        startupSettled = true
      })
      await waitFor(async () =>
        (await fixture.log())
          .slice(baseline)
          .some(
            (entry) =>
              entry.provider === provider &&
              (entry.message?.method === 'initialize' ||
                entry.message?.request?.subtype === 'initialize'),
          ),
      )
      await agents.stop(provider + '-local')
      expect(
        events.some((event) => event.type === 'complete' && event.status === 'interrupted'),
      ).toBe(true)
      await starting
      expect(startupSettled).toBe(true)
      expect(agents.hasRunningSessions()).toBe(false)
      fixture.initializationDelay = 0
      events.length = 0
      await agents.start(start(provider, 'hello'))
      await starting
      await waitFor(() => eventOf('complete'))
      expect(eventOf('error')).toBeUndefined()
      const messages = (await fixture.log())
        .slice(baseline)
        .filter((entry) => entry.provider === provider)
        .map((entry) => entry.message)
      expect(
        messages.some(
          (message) =>
            message?.params?.input?.[0]?.text === 'canceled-before-initialization' ||
            message?.message?.content?.[0]?.text === 'canceled-before-initialization',
        ),
      ).toBe(false)
    })

    it('reports provider failures without claiming the turn completed', async () => {
      await agents.start(start(provider, 'provider-error'))
      await waitFor(() => eventOf('error'))
      expect(eventOf('error')?.text).toContain('fixture login expired')
      expect(eventOf('complete')).toBeUndefined()
      events.length = 0
      await agents.start(start(provider, 'hello'))
      await waitFor(() => eventOf('complete'))
    })

    it('surfaces stderr when the remote agent process crashes', async () => {
      await agents.start(start(provider, 'process-exit'))
      await waitFor(() => eventOf('error'))
      expect(eventOf('error')?.text).toContain('fixture crashed')
      expect(eventOf('complete')).toBeUndefined()
      const remoteId = eventOf('session')!.remoteId!
      events.length = 0
      await agents.start(start(provider, 'hello'))
      await waitFor(() => eventOf('complete'))
      const logs = await fixture.log()
      if (provider === 'codex')
        expect(
          [...logs]
            .reverse()
            .find(
              (entry) => entry.provider === 'codex' && entry.message?.method === 'thread/resume',
            )?.message?.params.threadId,
        ).toBe(remoteId)
      else
        expect(
          [...logs]
            .reverse()
            .find(
              (entry) =>
                entry.provider === 'claude' && entry.argv && !entry.argv.includes('--version'),
            )?.argv,
        ).toContain('--resume=' + remoteId)
    })
  },
)

describe('provider configuration and cancellation', () => {
  beforeEach(async () => {
    await connect()
  })

  it('resumes a large saved Codex conversation without downloading its historical turns or replacing its ID', async () => {
    const baseline = (await fixture.log()).length
    await agents.start(start('codex', 'hello', { remoteId: 'codex-large-history' }))
    await waitFor(() => eventOf('complete'))
    expect(eventOf('session')?.remoteId).toBe('codex-large-history')
    expect(eventOf('error')).toBeUndefined()
    const messages = (await fixture.log()).slice(baseline).map((entry) => entry.message)
    expect(messages.find((message) => message?.method === 'thread/resume')?.params).toMatchObject({
      threadId: 'codex-large-history',
      excludeTurns: true,
      cwd: fixture.workspace,
    })
    expect(messages.some((message) => message?.method === 'thread/start')).toBe(false)
    expect(messages.filter((message) => message?.method === 'turn/start')).toHaveLength(1)
  })

  it('cancels a hung Codex resume immediately and permits another project thread to run', async () => {
    const baseline = (await fixture.log()).length
    const starting = agents.start(
      start('codex', 'never-send-this', { remoteId: 'codex-hung-resume' }),
    )
    await waitFor(async () =>
      (await fixture.log())
        .slice(baseline)
        .some(
          (entry) =>
            entry.message?.method === 'thread/resume' &&
            entry.message?.params.threadId === 'codex-hung-resume',
        ),
    )
    await agents.stop('codex-local')
    await starting
    expect(agents.hasRunningSessions()).toBe(false)
    expect(eventOf('error')).toBeUndefined()
    events.length = 0
    await agents.start(start('codex', 'hello', { sessionId: 'another-project-thread' }))
    await waitFor(() => eventOf('complete', 'another-project-thread'))
    expect(
      (await fixture.log())
        .slice(baseline)
        .some(
          (entry) =>
            entry.message?.method === 'turn/start' &&
            entry.message?.params.input?.[0]?.text === 'never-send-this',
        ),
    ).toBe(false)
  })

  it('ignores a cancelled delayed resume response and retries the same saved conversation without replaying the cancelled prompt', async () => {
    const baseline = (await fixture.log()).length
    const starting = agents.start(
      start('codex', 'cancelled-resume-prompt', { remoteId: 'codex-delayed-resume' }),
    )
    await waitFor(async () =>
      (await fixture.log())
        .slice(baseline)
        .some((entry) => entry.message?.method === 'thread/resume'),
    )
    await agents.stop('codex-local')
    await starting
    events.length = 0
    await agents.start(start('codex', 'hello'))
    await waitFor(() => eventOf('complete'))
    const messages = (await fixture.log()).slice(baseline).map((entry) => entry.message)
    expect(messages.filter((message) => message?.method === 'thread/resume')).toHaveLength(2)
    expect(messages.filter((message) => message?.method === 'turn/start')).toHaveLength(1)
    expect(eventOf('session')?.remoteId).toBe('codex-delayed-resume')
    expect(eventOf('error')).toBeUndefined()
  })

  it('discovers Codex models through app-server and offers Claude aliases', async () => {
    expect(await agents.models('codex')).toEqual([
      expect.objectContaining({
        id: '',
        name: 'Codex default',
        defaultReasoningEffort: 'low',
        isDefault: true,
      }),
      expect.objectContaining({
        id: 'fixture-model',
        name: 'Fixture Codex',
        supportedReasoningEfforts: [
          { reasoningEffort: 'low', description: 'Quick' },
          { reasoningEffort: 'high', description: 'Thorough' },
        ],
        serviceTiers: [
          { id: 'default', name: 'Standard', description: 'Standard priority' },
          { id: 'fast', name: 'Fast', description: 'Higher priority' },
        ],
      }),
    ])
    expect(await agents.models('claude')).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ id: 'sonnet', name: 'Sonnet' }),
        expect.objectContaining({
          id: 'opus',
          name: 'Opus',
          supportedReasoningEfforts: [
            { reasoningEffort: 'low' },
            { reasoningEffort: 'high' },
            { reasoningEffort: 'max' },
          ],
          serviceTiers: [
            { id: 'default', name: 'Standard' },
            { id: 'fast', name: 'Fast' },
          ],
        }),
      ]),
    )
  })

  it('uses the documented Codex review policy and workspace sandbox', async () => {
    await agents.start(start('codex', 'hello'))
    await waitFor(() => eventOf('complete'))
    const logs = await fixture.log()
    expect(
      [...logs]
        .reverse()
        .find((entry) => entry.provider === 'codex' && entry.message?.method === 'thread/start')
        ?.message?.params,
    ).toMatchObject({
      approvalPolicy: 'untrusted',
      sandbox: 'workspace-write',
      cwd: fixture.workspace,
    })
    expect(
      [...logs]
        .reverse()
        .find((entry) => entry.provider === 'codex' && entry.message?.method === 'turn/start')
        ?.message?.params.sandboxPolicy,
    ).toMatchObject({
      type: 'workspaceWrite',
      writableRoots: [fixture.workspace],
      networkAccess: false,
    })
  })

  it('does not launch a missing provider and forbids changing provider inside a running conversation', async () => {
    connection.state.claude = 'missing'
    await expect(agents.start(start('claude', 'hello'))).rejects.toThrow(/not installed/i)
    await agents.start(start('codex', 'hello'))
    await waitFor(() => eventOf('complete'))
    connection.state.claude = 'fixture-version'
    await expect(
      agents.start(start('claude', 'hello', { sessionId: 'codex-local' })),
    ).rejects.toThrow(/new thread/i)
  })

  it('returns an app-server request error to the caller and allows a later turn', async () => {
    await expect(agents.start(start('codex', 'request-error'))).rejects.toThrow(
      'Codex fixture rejected request',
    )
    await agents.start(start('codex', 'hello'))
    await waitFor(() => eventOf('complete'))
  })

  it('cancels a Codex turn requested while its start response is still pending', async () => {
    const starting = agents.start(start('codex', 'delay-start'))
    await waitFor(async () =>
      (await fixture.log()).some(
        (entry) =>
          entry.message?.method === 'turn/start' &&
          entry.message.params.input[0].text === 'delay-start',
      ),
    )
    await agents.stop('codex-local')
    await starting
    await waitFor(() =>
      events.find((event) => event.type === 'complete' && event.status === 'interrupted'),
    )
    await waitFor(async () =>
      (await fixture.log()).some((entry) => entry.message?.method === 'turn/interrupt'),
    )
  })
})

describe('fixture lifecycle', () => {
  it('closes its TCP listener and agent children even while a client remains connected', async () => {
    const isolated = await new SSHFixture().start()
    const isolatedStore = new Store(join(isolated.root, 'settings'))
    await isolatedStore.init()
    const client = new SSHConnection(isolatedStore)
    const received: AgentEvent[] = []
    const provider = new Agents(client, (event) => received.push(event))
    client.on('host-key', (request: HostKeyRequest) => client.trust(request.id, true))
    try {
      await client.connect(isolated.input())
      await client.selectWorkspace(isolated.workspace)
      await provider.start(start('claude', 'hang'))
      await waitFor(() => received.some((event) => event.type === 'text'))
      await isolated.close()
      await waitFor(() => client.state.status === 'disconnected')
      expect(existsSync(isolated.root)).toBe(false)
      expect(received.some((event) => event.type === 'error')).toBe(true)
    } finally {
      client.disconnect()
      provider.close()
      await isolated.close()
    }
  })
})
