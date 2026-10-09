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
import { extractLifeThreadResponse } from '../src/renderer/life-thread'
import { buildStudioInstructions } from '../src/renderer/studio-instructions'
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
const conversationLog = async () =>
  (await fixture.log())
    .filter((entry) => (entry as { kind?: string }).kind !== 'title-metadata')
    .map((entry) => entry as typeof entry & Record<string, any>)

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
  agents.close()
  connection.disconnect()
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
      () => agents.start(start('codex', 'hello')),
    ])
      await expect(operation()).rejects.toThrow(/project|workspace/i)
    expect(await agents.models('codex')).toEqual(
      expect.arrayContaining([expect.objectContaining({ id: 'fixture-model' })]),
    )
    expect(await agents.models('claude')).toEqual(
      expect.arrayContaining([expect.objectContaining({ id: 'opus' })]),
    )
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

    it('keeps the previous project agent running while a new project gets its own thread and terminal', async () => {
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
      expect(eventOf('error')).toBeUndefined()
      expect(agents.hasRunningSessions()).toBe(true)
      await expect(agents.start(start(provider, 'original-still-running'))).rejects.toThrow(
        /already running/i,
      )
      events.length = 0
      await agents.start(
        start(provider, 'hello', { sessionId: provider + '-next-project', workspace: nextProject }),
      )
      await waitFor(() => eventOf('complete', provider + '-next-project'))
      expect(eventOf('error')).toBeUndefined()
      expect(agents.hasRunningSessions()).toBe(true)
      await agents.stop(provider + '-local')
      await waitFor(() => eventOf('complete', provider + '-local')?.status === 'interrupted')
      expect(agents.hasRunningSessions()).toBe(false)
      const logs = await conversationLog()
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
        expect(invocation?.cwd).toBe(nextProject)
      }
    })

    it('rejects an expected project mismatch before launching the provider', async () => {
      const baseline = (await conversationLog()).length
      await expect(
        agents.start(start(provider, 'must-not-run', { workspace: fixture.root })),
      ).rejects.toThrow(/project|workspace/i)
      expect((await conversationLog()).slice(baseline)).toEqual([])
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

    it('keeps native live settings and steering in the same active turn without an interrupt or synthetic prompt', async () => {
      const baseline = (await conversationLog()).length
      await agents.start(start(provider, 'hang'))
      await waitFor(() => eventOf('text'))
      const remoteId = eventOf('session')!.remoteId!
      const configured = await agents.configure({
        sessionId: provider + '-local',
        model: provider === 'codex' ? 'fixture-model' : 'opus',
        reasoningEffort: 'high',
      })
      expect(configured.applied).toBe('live')
      const speed = await agents.configure({ sessionId: provider + '-local', serviceTier: 'fast' })
      expect(speed.applied).toBe(provider === 'codex' ? 'live' : 'next-request')
      const steering = '  native-steer-follow-up\nKeep these exact bytes.  '
      await agents.steer({ sessionId: provider + '-local', prompt: steering })
      await waitFor(async () =>
        (await conversationLog())
          .slice(baseline)
          .some((entry) =>
            provider === 'codex'
              ? entry.message?.method === 'turn/steer' &&
                entry.message.params.input[0].text === steering
              : entry.message?.type === 'user' &&
                entry.message.priority === 'next' &&
                entry.message.message.content[0].text === steering,
          ),
      )
      expect(agents.hasRunningSessions()).toBe(true)
      const logs = (await conversationLog()).slice(baseline)
      expect(
        logs.some(
          (entry) =>
            entry.message?.method === 'turn/interrupt' ||
            entry.message?.request?.subtype === 'interrupt',
        ),
      ).toBe(false)
      if (provider === 'codex') {
        const started = logs.find((entry) => entry.message?.method === 'turn/start')!
        const applied = logs.find((entry) => entry.message?.method === 'turn/settings/update')!
        const steered = logs.find((entry) => entry.message?.method === 'turn/steer')!
        expect(applied.message!.params).toMatchObject({
          threadId: remoteId,
          model: 'fixture-model',
          effort: 'high',
        })
        expect(
          logs.find(
            (entry) =>
              entry.message?.method === 'turn/settings/update' &&
              entry.message?.params.serviceTier === 'fast',
          ),
        ).toBeDefined()
        expect(steered.message!.params).toMatchObject({
          threadId: remoteId,
          expectedTurnId: applied.message!.params.turnId,
          input: [{ type: 'text', text: steering }],
        })
        expect(logs.filter((entry) => entry.message?.method === 'turn/start')).toHaveLength(1)
        expect(started.message!.params.input).toEqual([{ type: 'text', text: 'hang' }])
      } else {
        const controls = logs.filter((entry) => entry.message?.type === 'control_request')
        expect(controls.map((entry) => entry.message!.request.subtype)).toEqual(
          expect.arrayContaining(['set_model', 'apply_flag_settings']),
        )
        expect(
          controls.find((entry) => entry.message!.request.subtype === 'apply_flag_settings')!
            .message!.request.settings,
        ).toEqual({ effortLevel: 'high' })
        expect(
          controls.find(
            (entry) =>
              entry.message!.request.subtype === 'apply_flag_settings' &&
              entry.message!.request.settings.fastMode === true,
          ),
        ).toBeDefined()
        const inputs = logs.filter((entry) => entry.message?.type === 'user')
        expect(inputs).toHaveLength(2)
        expect(inputs[1].message).toMatchObject({
          session_id: remoteId,
          priority: 'next',
          message: { role: 'user', content: [{ type: 'text', text: steering }] },
        })
      }
      await agents.stop(provider + '-local')
      await waitFor(() => eventOf('complete')?.status === 'interrupted')
    })

    it('receives provider-generated titles without replacing or extending the original user message', async () => {
      const baseline = (await fixture.log()).length
      const prompt =
        '  native-generated-title\nThis original message is longer than its provider title.  '
      await agents.start(start(provider, prompt))
      await waitFor(() => eventOf('complete'))
      await waitFor(() => eventOf('title'))
      expect(eventOf('title')?.title).toBe('Provider-generated workspace title')
      expect(eventOf('title')?.title).not.toBe(prompt.trim())
      const logs = (await fixture.log()).slice(baseline) as Array<
        Awaited<ReturnType<typeof fixture.log>>[number] & Record<string, any>
      >
      const ordinary = logs.filter((entry) => entry.kind !== 'title-metadata')
      const inputs = ordinary.filter((entry) =>
        provider === 'codex'
          ? entry.message?.method === 'turn/start'
          : entry.message?.type === 'user',
      )
      expect(inputs).toHaveLength(1)
      const blocks =
        provider === 'codex' ? inputs[0].message!.params.input : inputs[0].message!.message.content
      expect(blocks).toEqual([{ type: 'text', text: prompt }])
      expect(existsSync(join(fixture.workspace, 'AGENTS.md'))).toBe(false)
      expect(existsSync(join(fixture.workspace, 'CLAUDE.md'))).toBe(false)
      for (const metadata of logs.filter(
        (entry) => entry.kind === 'title-metadata' && entry.prompt !== undefined,
      ))
        expect(metadata.prompt).toBe(prompt)
    })

    it('preserves native subagent identity and full child output in the parent conversation', async () => {
      await agents.start(start(provider, 'native-subagent-probe'))
      await waitFor(() => eventOf('complete'))
      expect(eventOf('error')).toBeUndefined()
      const delegated = events.filter((event) => event.type === 'subagent')
      expect(delegated.length).toBeGreaterThan(0)
      expect(delegated.some((event) => event.status === 'completed' && event.agentId)).toBe(true)
      expect(
        events.some(
          (event) =>
            event.type === 'text' &&
            event.text === 'Subagent inspected every visible output block.' &&
            event.agentId &&
            event.agentName === 'Fixture researcher',
        ),
      ).toBe(true)
      expect(
        events.some(
          (event) =>
            event.type === 'text' &&
            event.text === 'Native subagent work completed with its full output visible.',
        ),
      ).toBe(true)
    })

    it('isolates Studio proposals and instruction files from exact ordinary project messages', async () => {
      const baseline = (await conversationLog()).length
      await agents.start(start(provider, 'hello'))
      await waitFor(() => eventOf('complete'))
      const ordinaryId = eventOf('session')!.remoteId!
      const studioSessionId = provider + '-studio'
      let studioRemoteId = ''
      const requests = [
        ['clarify customization', 'message'],
        ['no change customization', 'message'],
        ['make select components use shadcn', 'message'],
        ['add research panels', 'settings'],
        ['add executable extension counter', 'extension'],
      ] as const
      for (const [request, kind] of requests) {
        events.length = 0
        await agents.start(
          start(provider, request, {
            sessionId: studioSessionId,
            mode: 'plan',
            scope: 'life-customization',
            studioContext: buildStudioInstructions({
              config: defaultLifeConfig,
              extensions: [],
              capabilities: ['connection.state'],
            }),
          }),
        )
        await waitFor(() => eventOf('complete', studioSessionId))
        const text = events
          .filter((event) => event.type === 'text' && event.status === 'replace')
          .map((event) => event.text)
          .join('\n')
        expect(extractLifeThreadResponse(text).kind, request).toBe(kind)
        expect(eventOf('error')).toBeUndefined()
        if (!studioRemoteId) studioRemoteId = eventOf('session', studioSessionId)!.remoteId!
        if (eventOf('session', studioSessionId))
          expect(eventOf('session', studioSessionId)!.remoteId).toBe(studioRemoteId)
        expect(connection.state.workspace).toBe(fixture.workspace)
      }
      expect(studioRemoteId).not.toBe(ordinaryId)
      events.length = 0
      const literal = '  /life literal message\nDo not change the application.  '
      await agents.start(start(provider, literal))
      await waitFor(() => eventOf('complete', provider + '-local'))
      const source = events.find(
        (event) => event.type === 'text' && event.status === 'replace',
      )!.text!
      expect(extractLifeThreadResponse(source, false)).toEqual({ kind: 'message', message: source })
      const logs = (await conversationLog())
        .slice(baseline)
        .filter((entry) => entry.provider === provider)
      const studioEvidence = logs.filter((entry) => entry.kind === 'studio-context')
      expect(studioEvidence).toHaveLength(requests.length)
      expect(studioEvidence.map((entry) => entry.prompt)).toEqual(
        requests.map(([request]) => request),
      )
      for (const evidence of studioEvidence) {
        expect(evidence.cwd).toMatch(/\/\.life\/customization\/[a-f0-9]{64}$/)
        expect(evidence.phase).toBe('request')
        expect(evidence.instructions).toContain('# Life Customization Studio')
        expect(evidence.instructions).not.toContain(evidence.prompt)
        expect(evidence.contextFiles).toEqual(
          expect.arrayContaining([
            expect.objectContaining({ path: '.life/configuration.json' }),
            expect.objectContaining({ path: '.life/source-schema.json' }),
            expect.objectContaining({ path: '.life/bridge.json' }),
          ]),
        )
      }
      const turns = logs.filter((entry) =>
        provider === 'codex'
          ? entry.message?.method === 'turn/start'
          : entry.message?.type === 'user',
      )
      expect(turns).toHaveLength(7)
      const inputOf = (entry: (typeof turns)[number]) =>
        provider === 'codex' ? entry.message!.params.input : entry.message!.message.content
      expect(turns.map((entry) => inputOf(entry)[0].text)).toEqual([
        'hello',
        ...requests.map(([request]) => request),
        literal,
      ])
      expect(turns.every((entry) => inputOf(entry).length === 1)).toBe(true)
      if (provider === 'codex') {
        expect(turns[0].message!.params.threadId).toBe(ordinaryId)
        expect(turns.at(-1)!.message!.params.threadId).toBe(ordinaryId)
        expect(
          turns.slice(1, 6).every((entry) => entry.message!.params.threadId === studioRemoteId),
        ).toBe(true)
        expect(
          turns
            .slice(1, 6)
            .every((entry) => entry.message!.params.sandboxPolicy.type === 'readOnly'),
        ).toBe(true)
        expect(turns.at(-1)!.message!.params.sandboxPolicy.type).toBe('workspaceWrite')
        expect(logs.filter((entry) => entry.message?.method === 'thread/start')).toHaveLength(2)
      } else {
        const invocations = logs.filter((entry) =>
          entry.argv?.includes('--include-partial-messages'),
        )
        expect(invocations).toHaveLength(2)
        expect(
          invocations.find((entry) => /\/\.life\/customization\//.test(entry.cwd))?.argv,
        ).toContain('plan')
        expect(invocations.find((entry) => entry.cwd === fixture.workspace)?.argv).toContain(
          'default',
        )
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
      const logs = await conversationLog()
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
      const logs = await conversationLog()
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
      const logs = await conversationLog()
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
      const logs = await conversationLog()
      expect(
        logs.some(
          (entry) =>
            entry.provider === provider &&
            (entry.message?.method === 'turn/interrupt' ||
              entry.message?.request?.subtype === 'interrupt'),
        ),
      ).toBe(true)
      await agents.dispose(provider + '-local')
      connection.disconnect()
      await connection.connect(fixture.input())
      await connection.selectWorkspace(fixture.workspace)
      events.length = 0
      await agents.start(
        start(provider, 'hello', { remoteId, mode: 'plan', model: 'fixture-model' }),
      )
      await waitFor(() => eventOf('complete'))
      const resumed = await conversationLog()
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
      const baseline = (await conversationLog()).length
      fixture.initializationDelay = 1200
      let startupSettled = false
      const starting = agents.start(start(provider, 'canceled-before-initialization')).then(() => {
        startupSettled = true
      })
      await waitFor(async () =>
        (await conversationLog())
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
      const messages = (await conversationLog())
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
      const logs = await conversationLog()
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
    const baseline = (await conversationLog()).length
    await agents.start(start('codex', 'hello', { remoteId: 'codex-large-history' }))
    await waitFor(() => eventOf('complete'))
    expect(eventOf('session')?.remoteId).toBe('codex-large-history')
    expect(eventOf('error')).toBeUndefined()
    const messages = (await conversationLog()).slice(baseline).map((entry) => entry.message)
    expect(messages.find((message) => message?.method === 'thread/resume')?.params).toMatchObject({
      threadId: 'codex-large-history',
      excludeTurns: true,
      cwd: fixture.workspace,
    })
    expect(messages.some((message) => message?.method === 'thread/start')).toBe(false)
    expect(messages.filter((message) => message?.method === 'turn/start')).toHaveLength(1)
  })

  it('cancels a hung Codex resume immediately and permits another project thread to run', async () => {
    const baseline = (await conversationLog()).length
    const starting = agents.start(
      start('codex', 'never-send-this', { remoteId: 'codex-hung-resume' }),
    )
    await waitFor(async () =>
      (await conversationLog())
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
      (await conversationLog())
        .slice(baseline)
        .some(
          (entry) =>
            entry.message?.method === 'turn/start' &&
            entry.message?.params.input?.[0]?.text === 'never-send-this',
        ),
    ).toBe(false)
  })

  it('ignores a cancelled delayed resume response and retries the same saved conversation without replaying the cancelled prompt', async () => {
    const baseline = (await conversationLog()).length
    const starting = agents.start(
      start('codex', 'cancelled-resume-prompt', { remoteId: 'codex-delayed-resume' }),
    )
    await waitFor(async () =>
      (await conversationLog())
        .slice(baseline)
        .some((entry) => entry.message?.method === 'thread/resume'),
    )
    await agents.stop('codex-local')
    await starting
    events.length = 0
    await agents.start(start('codex', 'hello'))
    await waitFor(() => eventOf('complete'))
    const messages = (await conversationLog()).slice(baseline).map((entry) => entry.message)
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
    const logs = await conversationLog()
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
      (await conversationLog()).some(
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
      (await conversationLog()).some((entry) => entry.message?.method === 'turn/interrupt'),
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
