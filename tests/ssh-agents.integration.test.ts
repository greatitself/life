import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { join } from 'node:path'
import { existsSync } from 'node:fs'
import { Store } from '../src/main/store'
import { SSHConnection } from '../src/main/ssh'
import { Agents } from '../src/main/agents'
import type { AgentEvent, HostKeyRequest, Provider, StartInput } from '../src/shared/types'
import { SSHFixture } from './helpers/ssh-fixture'

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

async function connect(accept = true) {
  connection.on('host-key', (request: HostKeyRequest) => {
    trustRequests.push(request)
    connection.trust(request.id, accept)
  })
  return connection.connect(fixture.input())
}

describe('real SSH host verification and workspace connection', () => {
  it('requires trust on first use, persists the fingerprint, and reconnects without prompting', async () => {
    const state = await connect()
    expect(state).toMatchObject({
      status: 'connected',
      workspace: fixture.workspace,
      codex: 'codex-cli test.0',
      claude: '2.test.0 (Claude Code fixture)',
    })
    expect(state.profile).not.toHaveProperty('password')
    expect(trustRequests).toHaveLength(1)
    expect(trustRequests[0]).toMatchObject({ host: '127.0.0.1:' + fixture.port })
    expect(trustRequests[0].fingerprint).toMatch(/^SHA256:[A-Za-z0-9+/]{43}$/)
    const reloaded = new Store(join(fixture.root, 'settings-' + sequence))
    await reloaded.init()
    expect(reloaded.hostKey(trustRequests[0].host)).toBe(trustRequests[0].fingerprint)
    connection.disconnect()
    await connection.connect(fixture.input())
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
      if (provider === 'codex') expect(startupSettled).toBe(false)
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

  it('discovers Codex models through app-server and offers Claude aliases', async () => {
    expect(await agents.models('codex')).toEqual([
      { id: '', name: 'Codex default' },
      { id: 'fixture-model', name: 'Fixture Codex' },
    ])
    expect(await agents.models('claude')).toEqual(
      expect.arrayContaining([
        { id: 'sonnet', name: 'Sonnet' },
        { id: 'opus', name: 'Opus' },
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
