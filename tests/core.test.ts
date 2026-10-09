import { afterEach, describe, expect, it, vi } from 'vitest'
import { execFileSync } from 'node:child_process'
import { mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { JsonLines } from '../src/main/json-lines'
import { remoteCommand, remotePath } from '../src/main/ssh'
import { Store } from '../src/main/store'
import { connectSchema, profileSchema, shellQuote, startSchema } from '../src/shared/validation'
import { applyEvent, readThreads, type Thread } from '../src/renderer/state'
import type { AgentEvent, ConnectionProfile } from '../src/shared/types'

const profile: ConnectionProfile = {
  id: 'machine-1',
  name: 'Development',
  host: '127.0.0.1',
  port: 22,
  username: 'developer',
  auth: 'password',
  privateKeyPath: '',
  workspace: '/workspace',
}
const directories: string[] = []
afterEach(async () => {
  vi.unstubAllGlobals()
  await Promise.all(directories.splice(0).map((path) => rm(path, { recursive: true, force: true })))
})

describe('agent JSON line framing', () => {
  it('preserves multibyte characters across arbitrary SSH packet boundaries', () => {
    const received: Record<string, unknown>[] = []
    const invalid: string[] = []
    const parser = new JsonLines(
      (message) => received.push(message),
      (line) => invalid.push(line),
    )
    const encoded = Buffer.from('  {"text":"hello 👋 日本語"}\r\n\n{"id":2}\n')
    for (const byte of encoded) parser.push(Buffer.from([byte]))
    expect(received).toEqual([{ text: 'hello 👋 日本語' }, { id: 2 }])
    expect(invalid).toEqual([])
  })

  it('isolates malformed lines and ignores non-object JSON without dropping the next message', () => {
    const received: Record<string, unknown>[] = []
    const invalid: string[] = []
    const parser = new JsonLines(
      (message) => received.push(message),
      (line) => invalid.push(line),
    )
    parser.push('stderr noise\nnull\n[1,2]\n42\n{"partial":')
    expect(received).toEqual([])
    parser.push('true}\n')
    expect(received).toEqual([{ partial: true }])
    expect(invalid).toEqual(['stderr noise'])
  })

  it('drops an oversized unfinished frame and recovers for later messages', () => {
    const receive = vi.fn()
    const invalid = vi.fn()
    const parser = new JsonLines(receive, invalid)
    parser.push('x'.repeat(8_000_001))
    parser.push('untrusted frame suffix\n{"ok":true}\n')
    expect(invalid).toHaveBeenCalledOnce()
    expect(receive).toHaveBeenCalledWith({ ok: true })
  })

  it('limits each frame separately even when a packet contains many valid messages', () => {
    const received: Record<string, unknown>[] = []
    const invalid = vi.fn()
    const parser = new JsonLines((message) => received.push(message), invalid, 40)
    parser.push('{"id":1,"text":"one"}\n{"id":2,"text":"two"}\n{"id":3,"text":"three"}\n')
    expect(received.map((message) => message.id)).toEqual([1, 2, 3])
    expect(invalid).not.toHaveBeenCalled()
  })

  it('drops only an oversized complete frame while preserving subsequent frames in the same packet', () => {
    const received: Record<string, unknown>[] = []
    const invalid = vi.fn()
    const parser = new JsonLines((message) => received.push(message), invalid, 20)
    parser.push('{"oversized":"' + 'x'.repeat(30) + '"}\n{"id":2}\n')
    expect(received).toEqual([{ id: 2 }])
    expect(invalid).toHaveBeenCalledOnce()
  })
})

describe('command and input boundaries', () => {
  it.each([
    'simple',
    '',
    "a'b",
    'hello world',
    '$(printf injected); `id` & | > <',
    '日本語\nnext line',
  ])('passes %j as one literal shell argument', (value) => {
    const output = execFileSync('/bin/sh', ['-c', `printf '%s' ${shellQuote(value)}`], {
      encoding: 'utf8',
    })
    expect(output).toBe(value)
  })

  it('expands only the leading home abbreviation in a remote path', () => {
    const home = process.env.HOME || ''
    const run = (path: string) =>
      execFileSync('/bin/sh', ['-c', `printf '%s' ${remotePath(path)}`], { encoding: 'utf8' })
    expect(run('~')).toBe(home)
    expect(run("~/a'$(printf injected)")).toBe(home + "/a'$(printf injected)")
    expect(run('/a/~/literal')).toBe('/a/~/literal')
    expect(remoteCommand('printf hello')).toContain('exec "$SHELL" -lc ')
  })

  it('rejects command-like hostnames, invalid ports, control characters and empty prompts', () => {
    expect(profileSchema.safeParse({ ...profile, host: 'example.com; touch bad' }).success).toBe(
      false,
    )
    expect(profileSchema.safeParse({ ...profile, port: 0 }).success).toBe(false)
    expect(profileSchema.safeParse({ ...profile, workspace: '/tmp\nrm -rf' }).success).toBe(false)
    expect(
      startSchema.safeParse({ sessionId: 'thread', provider: 'codex', prompt: ' ', mode: 'edit' })
        .success,
    ).toBe(false)
    expect(connectSchema.parse({ ...profile, password: 'secret' }).password).toBe('secret')
  })
})

describe('connection persistence', () => {
  async function store() {
    const directory = await mkdtemp(join(tmpdir(), 'relay-store-test-'))
    directories.push(directory)
    const instance = new Store(directory)
    await instance.init()
    return { instance, directory }
  }

  it('strips password and passphrase from profiles before writing and reloading', async () => {
    const { instance, directory } = await store()
    await instance.save({
      ...profile,
      password: 'very-secret-password',
      passphrase: 'very-secret-passphrase',
    } as ConnectionProfile)
    const raw = await readFile(join(directory, 'connections.json'), 'utf8')
    expect(raw).not.toContain('very-secret')
    expect(instance.list()).toEqual([profile])
    expect((await stat(join(directory, 'connections.json'))).mode & 0o777).toBe(0o600)
    const reloaded = new Store(directory)
    await reloaded.init()
    expect(reloaded.list()).toEqual([profile])
  })

  it('serializes concurrent profile and host trust writes without losing data', async () => {
    const { instance, directory } = await store()
    await Promise.all([
      instance.save(profile),
      instance.trust('127.0.0.1:22', 'SHA256:fixture'),
      instance.save({ ...profile, id: 'machine-2', name: 'Second machine' }),
    ])
    const reloaded = new Store(directory)
    await reloaded.init()
    expect(reloaded.list().map((p) => p.id)).toEqual(['machine-1', 'machine-2'])
    expect(reloaded.hostKey('127.0.0.1:22')).toBe('SHA256:fixture')
    await reloaded.remove('machine-1')
    expect(reloaded.list().map((p) => p.id)).toEqual(['machine-2'])
  })

  it('discards invalid profiles and removes legacy secret fields on load', async () => {
    const { directory } = await store()
    await writeFile(
      join(directory, 'connections.json'),
      JSON.stringify({
        profiles: [{ ...profile, password: 'legacy-password' }, { id: 'bad' }],
        knownHosts: {},
      }),
    )
    const reloaded = new Store(directory)
    await reloaded.init()
    expect(reloaded.list()).toEqual([profile])
  })
})

describe('conversation state', () => {
  const thread = (): Thread => ({
    id: 'local-thread',
    profileId: profile.id,
    provider: 'codex',
    title: 'Fixture',
    messages: [],
    busy: true,
    model: '',
    mode: 'review',
    updatedAt: 0,
    turn: 1,
    pending: [],
  })
  const event = (value: Omit<AgentEvent, 'sessionId'>): AgentEvent => ({
    sessionId: 'local-thread',
    ...value,
  })

  it('appends partial text, replaces final text, and scopes reused item IDs to the turn', () => {
    const original = thread()
    let state = applyEvent(original, event({ type: 'text', itemId: 'message', text: 'Hel' }))
    state = applyEvent(state, event({ type: 'text', itemId: 'message', text: 'lo' }))
    expect(state.messages[0].text).toBe('Hello')
    state = applyEvent(
      state,
      event({ type: 'text', itemId: 'message', text: 'Hello world', status: 'replace' }),
    )
    state = applyEvent(
      { ...state, turn: 2 },
      event({ type: 'text', itemId: 'message', text: 'Second turn' }),
    )
    expect(state.messages.map((m) => [m.id, m.text])).toEqual([
      ['1:message', 'Hello world'],
      ['2:message', 'Second turn'],
    ])
    expect(original.messages).toEqual([])
  })

  it('keeps tool output and approval identity, then marks running tools interrupted on stop', () => {
    let state = applyEvent(
      thread(),
      event({ type: 'tool', itemId: 'command', title: 'npm test', status: 'running' }),
    )
    state = applyEvent(
      state,
      event({ type: 'tool-output', itemId: 'command', text: 'All tests passed' }),
    )
    state = applyEvent(state, event({ type: 'approval', requestId: 'permission', title: 'Allow?' }))
    state = applyEvent(
      state,
      event({ type: 'approval', requestId: 'permission', title: 'Allow command?' }),
    )
    expect(state.pending).toHaveLength(1)
    state = applyEvent(state, event({ type: 'complete', status: 'interrupted' }))
    expect(state).toMatchObject({ busy: false, pending: [] })
    expect(state.messages[0]).toMatchObject({
      text: 'All tests passed',
      title: 'npm test',
      status: 'interrupted',
    })
  })

  it('restores persisted threads as idle and removes stale permission requests', () => {
    vi.stubGlobal('localStorage', { getItem: () => JSON.stringify([thread(), { invalid: true }]) })
    const restored = readThreads()
    expect(restored).toHaveLength(1)
    expect(restored[0]).toMatchObject({ ...thread(), busy: false, pending: [], queue: [] })
    expect(restored[0].workspace).toBeUndefined()
    expect(restored[0].remoteId).toBeUndefined()
    expect(restored[0].gitBranch).toBeUndefined()
    expect(restored[0].gitHost).toBeUndefined()
    vi.stubGlobal('localStorage', { getItem: () => 'broken JSON' })
    expect(readThreads()).toEqual([])
  })

  it('retains project and provider identities while pausing saved follow-ups and interrupting unfinished tools', () => {
    const saved = {
      ...thread(),
      remoteId: 'existing-conversation',
      workspace: '/srv/research',
      gitBranch: 'research-branch',
      pending: [event({ type: 'approval', requestId: 'stale-permission' })],
      messages: [
        { id: 'user-message', role: 'user', text: 'Research this', turn: 1, createdAt: 100 },
        { id: 'tool-message', role: 'tool', text: 'Working', turn: 1, status: 'running' },
      ],
      queue: [
        {
          id: 'queued-follow-up',
          text: 'Compare the findings',
          createdAt: 200,
          attachments: [],
          paused: false,
        },
      ],
    }
    vi.stubGlobal('localStorage', { getItem: () => JSON.stringify([saved]) })
    const restored = readThreads()[0]
    expect(restored).toMatchObject({
      id: saved.id,
      profileId: saved.profileId,
      workspace: saved.workspace,
      remoteId: saved.remoteId,
      gitBranch: saved.gitBranch,
      busy: false,
      pending: [],
      queue: [{ ...saved.queue[0], paused: true }],
    })
    expect(restored.messages.map((message) => message.id)).toEqual(['user-message', 'tool-message'])
    expect(restored.messages[0]).toMatchObject({ text: 'Research this', createdAt: 100 })
    expect(restored.messages[1]).toMatchObject({ status: 'interrupted' })
  })

  it('retains remote identity and turns provider failures into visible messages', () => {
    let state = applyEvent(thread(), event({ type: 'session', remoteId: 'remote-thread' }))
    state = applyEvent(state, event({ type: 'error', text: 'Login expired' }))
    expect(state).toMatchObject({ remoteId: 'remote-thread', busy: false, pending: [] })
    expect(state.messages[0]).toMatchObject({ role: 'error', text: 'Login expired', turn: 1 })
  })

  it('preserves Life follow-up scope and ordinary remote identity when reloading thread history', () => {
    const saved = { ...thread(), lifeScope: true, remoteId: 'same-remote-conversation' }
    vi.stubGlobal('localStorage', { getItem: () => JSON.stringify([saved]) })
    expect(readThreads()[0]).toMatchObject({
      lifeScope: true,
      remoteId: saved.remoteId,
      busy: false,
    })
    vi.stubGlobal('localStorage', {
      getItem: () => JSON.stringify([{ ...saved, lifeScope: 'unsafe' }]),
    })
    expect(readThreads()[0].lifeScope).toBeUndefined()
  })
})
