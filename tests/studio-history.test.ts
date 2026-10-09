import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  STUDIO_HISTORY_KEY,
  createStudioSession,
  encodeStudioSessions,
  migrateLegacyStudioPending,
  normalizeStudioSessions,
  parseStudioSessions,
  readStudioSessions,
  type StudioSession,
} from '../src/renderer/studio-history'
import { applyEvent } from '../src/renderer/state'

const session = (id = 'studio-one', updatedAt = 10): StudioSession =>
  createStudioSession('codex', updatedAt, id)

afterEach(() => vi.unstubAllGlobals())

describe('dedicated customization Studio history', () => {
  it('constructs an independent conversation without a project or provider session', () => {
    const created = createStudioSession('claude', 123, 'studio-id')
    expect(created).toMatchObject({
      id: 'studio-id',
      stage: 'draft',
      createdAt: 123,
      updatedAt: 123,
      thread: {
        id: 'studio-id',
        profileId: '',
        provider: 'claude',
        title: 'New customization',
        mode: 'plan',
        busy: false,
        messages: [],
        pending: [],
      },
    })
    expect(created.thread.workspace).toBeUndefined()
    expect(created.thread.remoteId).toBeUndefined()
    expect(created.thread.lifeScope).toBeUndefined()
  })

  it('reads only its own key even when project and research history contain /life requests', () => {
    const projectThread = {
      ...session().thread,
      workspace: '/root/project',
      profileId: 'saved-machine',
      lifeScope: true,
      messages: [{ id: 'user', role: 'user', text: '/life make Life dark', turn: 1 }],
    }
    const storage = {
      getItem: vi.fn((key: string) => {
        if (key === STUDIO_HISTORY_KEY) return encodeStudioSessions([session()])
        if (key === 'relay.threads.v1')
          return JSON.stringify([
            projectThread,
            { ...projectThread, workspace: '/root/project/.life/research' },
          ])
        return null
      }),
    }
    expect(readStudioSessions(storage).map((item) => item.id)).toEqual(['studio-one'])
    expect(storage.getItem).toHaveBeenCalledExactlyOnceWith(STUDIO_HISTORY_KEY)
    expect(normalizeStudioSessions([projectThread])).toEqual([])
    expect(normalizeStudioSessions([{ ...projectThread, workspace: '/.research' }])).toEqual([])
  })

  it('preserves exact requests, every output, provider IDs and model choices across reload', () => {
    const original = session()
    original.request = ' \nPlease change the sidebar.\n\tDo not touch the composer.  '
    original.thread.remoteId = 'provider-session-8'
    original.thread.workspace = '/root/.life/studio'
    original.thread.model = 'gpt-example'
    original.thread.reasoningEffort = 'high'
    original.thread.serviceTier = 'fast'
    original.thread.title = 'Readable provider-generated title'
    original.thread.turn = 2
    original.thread.messages = [
      { id: 'input-1', role: 'user', text: original.request, turn: 1 },
      { id: 'output-1', role: 'assistant', text: '```tsx\nexport default App\n```\n', turn: 1 },
      {
        id: 'tool-1',
        role: 'tool',
        text: 'Full output\n' + 'details\n'.repeat(15_000),
        input: 'exact command\n',
        title: 'Build application',
        status: 'completed',
        turn: 1,
        createdAt: 1,
        finishedAt: 2,
        kind: 'subagent',
        agentId: 'agent-2',
        agentName: 'Sidebar designer',
        parentItemId: 'parent-tool',
        provider: 'codex',
        details: { agentsStates: { 'agent-2': { status: 'completed' } } },
      },
    ]
    const restored = parseStudioSessions(encodeStudioSessions([original]))[0]
    expect(restored).toEqual(original)
    expect(restored.request).toBe(original.request)
    expect(restored.thread.messages[2].text).toBe(original.thread.messages[2].text)
  })

  it('marks interrupted generation and tools while retaining a resumable provider conversation', () => {
    const original = session()
    original.stage = 'planning'
    original.thread.busy = true
    original.thread.turn = 3
    original.thread.remoteId = 'resumable-provider-id'
    original.thread.pending = [{ type: 'approval', sessionId: original.id, requestId: 'pending' }]
    original.thread.messages = [
      { id: 'prior', role: 'user', text: 'Earlier request', turn: 2, finishStatus: 'completed' },
      { id: 'current', role: 'user', text: 'Exact current request', turn: 3 },
      { id: 'tool', role: 'tool', text: 'Partial build log', turn: 3, status: 'running' },
    ]
    const encoded = encodeStudioSessions([original])
    expect(JSON.parse(encoded)[0].thread.busy).toBe(true)
    expect(JSON.parse(encoded)[0].stage).toBe('planning')
    const restored = parseStudioSessions(encoded)[0]
    expect(restored.stage).toBe('interrupted')
    expect(restored.thread.busy).toBe(false)
    expect(restored.thread.pending).toEqual([])
    expect(restored.thread.remoteId).toBe('resumable-provider-id')
    expect(restored.thread.messages).toMatchObject([
      { id: 'prior', text: 'Earlier request', finishStatus: 'completed' },
      { id: 'current', text: 'Exact current request', finishStatus: 'interrupted' },
      { id: 'tool', text: 'Partial build log', status: 'interrupted' },
    ])
    expect(original.thread.busy).toBe(true)
    expect(original.thread.messages[2].status).toBe('running')
  })

  it('never replays queued messages or an in-progress apply after restart', () => {
    const original = session()
    original.stage = 'applying'
    original.thread.queue = [
      { id: 'queue-id', text: '  Next exact request  ', createdAt: 20, attachments: [] },
    ]
    const restored = parseStudioSessions(encodeStudioSessions([original]))[0]
    expect(restored.stage).toBe('interrupted')
    expect(restored.thread.queue?.[0]).toMatchObject({
      text: '  Next exact request  ',
      paused: true,
    })
  })

  it('retains all three validated proposal types for explicit review', () => {
    const settings = session('settings')
    settings.stage = 'review'
    settings.changes = ['Theme becomes light', 'Sidebar stays unchanged']
    settings.proposal = {
      kind: 'settings',
      patch: { theme: 'light' },
      message: 'Ready for review.',
    }
    const source = session('source')
    source.stage = 'review'
    source.proposal = {
      kind: 'source',
      patch: {
        summary: 'Add a toolbar label',
        baseRevision: 8,
        files: [{ path: 'src/renderer/Label.tsx', content: 'export const Label = () => "Life"' }],
      },
      message: 'One source extension will be created.',
    }
    const extension = session('extension')
    extension.stage = 'review'
    extension.proposal = {
      kind: 'extension',
      manifest: {
        id: 'toolbar-label',
        name: 'Toolbar label',
        description: 'A label',
        version: '1',
        enabled: true,
        renderer: { html: '<p>Life</p>', css: '', js: '', placement: 'panel' },
      },
      message: 'One runtime extension will be created.',
    }
    expect(parseStudioSessions(encodeStudioSessions([settings, source, extension]))).toEqual([
      settings,
      source,
      extension,
    ])
  })

  it('drops malformed stored mutations and fails review without executing anything', () => {
    const malformed = {
      ...session(),
      stage: 'review',
      proposal: { kind: 'source', message: 'Apply me', patch: { files: [] } },
    }
    const restored = normalizeStudioSessions([malformed])[0]
    expect(restored.stage).toBe('failed')
    expect(restored.proposal).toBeUndefined()
    expect(
      normalizeStudioSessions([{ ...malformed, proposal: { kind: 'message', message: 'hi' } }])[0]
        .proposal,
    ).toBeUndefined()
  })

  it('orders by activity, deduplicates IDs and preserves provider-generated titles', () => {
    const first = session('first', 12)
    first.thread.title = 'A provider title'
    const second = session('second', 30)
    second.thread.title = 'Another provider title'
    expect(normalizeStudioSessions([first, second, { ...second, request: 'Duplicate' }])).toEqual([
      second,
      first,
    ])
    expect(
      normalizeStudioSessions([{ ...first, thread: { ...first.thread, id: 'wrong' } }]),
    ).toEqual([])
  })

  it('salvages valid messages and rejects invalid providers, identity and root shapes', () => {
    const original = session()
    const validMessage = { id: 'valid', role: 'assistant', text: 'Complete output', turn: 1 }
    const restored = normalizeStudioSessions([
      null,
      [],
      { ...original, thread: { ...original.thread, provider: 'untrusted-provider' } },
      { ...original, thread: { ...original.thread, purpose: 'research' } },
      {
        ...original,
        thread: {
          ...original.thread,
          researchContext: { scopeKey: '/root/project/.life/research', goalId: 'goal-one' },
        },
      },
      {
        ...original,
        thread: {
          ...original.thread,
          messages: [null, {}, { id: 'bad', role: 'system', text: 'invalid' }, validMessage],
        },
      },
    ])
    expect(restored).toHaveLength(1)
    expect(restored[0].thread.messages).toEqual([validMessage])
    expect(parseStudioSessions('{malformed')).toEqual([])
    expect(parseStudioSessions('{}')).toEqual([])
    expect(parseStudioSessions('null')).toEqual([])
    expect(
      readStudioSessions({
        getItem: () => {
          throw new Error('Storage is unavailable')
        },
      }),
    ).toEqual([])
  })

  it('ignores hostile objects and dangerous JSON keys without invoking code', () => {
    const invoked = vi.fn()
    const hostile = Object.defineProperty({ ...session('hostile') }, 'thread', { get: invoked })
    const toJSON = { ...session('to-json'), toJSON: invoked }
    const polluted = JSON.parse('{"id":"bad","__proto__":{"polluted":true}}')
    const circular = session('circular') as StudioSession & { self?: unknown }
    circular.self = circular
    expect(normalizeStudioSessions([hostile, toJSON, polluted, circular, session()])).toEqual([
      session(),
    ])
    expect(invoked).not.toHaveBeenCalled()
    const hostileArray = [session()]
    Object.defineProperty(hostileArray, '1', { get: invoked })
    expect(normalizeStudioSessions(hostileArray)).toEqual([session()])
    expect(invoked).not.toHaveBeenCalled()
    expect(() => encodeStudioSessions([toJSON])).toThrow('unsupported key')
    expect(invoked).not.toHaveBeenCalled()
    expect((Object.prototype as { polluted?: unknown }).polluted).toBeUndefined()
  })

  it('uses ambient storage when provided and works in a non-browser process', () => {
    const storage = { getItem: vi.fn(() => encodeStudioSessions([session()])) }
    vi.stubGlobal('localStorage', storage)
    expect(readStudioSessions()).toEqual([session()])
    expect(storage.getItem).toHaveBeenCalledExactlyOnceWith(STUDIO_HISTORY_KEY)
    vi.stubGlobal('localStorage', undefined)
    expect(readStudioSessions()).toEqual([])
  })

  it('saves actual provider messages with optional undefined fields without losing output', () => {
    const original = session()
    original.thread = applyEvent(original.thread, {
      sessionId: original.id,
      type: 'text',
      itemId: 'streamed-answer',
      text: 'The exact streamed output.',
    })
    const restored = parseStudioSessions(encodeStudioSessions([original]))[0]
    expect(restored.thread.messages[0]).toMatchObject({
      role: 'assistant',
      text: 'The exact streamed output.',
    })
  })
})

describe('legacy interrupted customization migration', () => {
  const legacyThread = () => ({
    ...session('old-project-thread').thread,
    profileId: 'remote-profile',
    purpose: undefined,
    lifeScope: true,
    workspace: '/root/project',
    remoteId: 'previous-provider-session',
    busy: true,
    title: 'Old project conversation',
    turn: 3,
    messages: [{ id: 'user-3', role: 'user' as const, text: '  Exact request\n', turn: 3 }],
  })
  const legacyPending = (thread = legacyThread()) =>
    JSON.stringify({
      id: thread.id,
      turn: thread.turn,
      request: '  Exact request\n',
      profileId: thread.profileId,
      reads: 2,
      repairs: 1,
      paths: ['src/renderer/App.tsx'],
      start: {
        sessionId: thread.id,
        provider: thread.provider,
        prompt: 'Old generated instructions which must be replaced',
        mode: 'plan',
        model: 'gpt-example',
        remoteId: thread.remoteId,
      },
    })

  it('copies a matching pending customization into an isolated session without changing the old thread', () => {
    const original = legacyThread()
    original.messages[0] = {
      ...original.messages[0],
      ...{ details: { existing: ['kept'] } },
    }
    const migrated = migrateLegacyStudioPending(
      legacyPending(original),
      [original],
      'life-studio:new-id',
      123,
    )
    expect(migrated?.session).toMatchObject({
      id: 'life-studio:new-id',
      stage: 'interrupted',
      request: '  Exact request\n',
      createdAt: 123,
      updatedAt: 123,
      thread: {
        id: 'life-studio:new-id',
        purpose: 'customization',
        title: 'Recovered customization',
        remoteId: 'previous-provider-session',
        messages: original.messages,
        busy: false,
        pending: [],
        queue: [],
      },
    })
    expect(migrated?.pending).toMatchObject({
      id: 'life-studio:new-id',
      turn: 3,
      request: '  Exact request\n',
      reads: 2,
      repairs: 1,
      paths: ['src/renderer/App.tsx'],
      start: {
        sessionId: 'life-studio:new-id',
        prompt: '  Exact request\n',
        remoteId: 'previous-provider-session',
      },
    })
    expect(original.busy).toBe(true)
    expect(original.id).toBe('old-project-thread')
    expect(original.title).toBe('Old project conversation')
    expect(migrated?.session.thread.messages).not.toBe(original.messages)
    expect(migrated?.session.thread.messages[0].details).not.toBe(
      (original.messages[0] as { details?: unknown }).details,
    )
  })

  it('does not recover ordinary project requests, research requests, mismatched turns or different providers', () => {
    const original = legacyThread()
    const raw = legacyPending(original)
    expect(migrateLegacyStudioPending(raw, [{ ...original, lifeScope: false }])).toBeUndefined()
    expect(migrateLegacyStudioPending(raw, [{ ...original, purpose: 'research' }])).toBeUndefined()
    expect(migrateLegacyStudioPending(raw, [{ ...original, turn: 4 }])).toBeUndefined()
    expect(migrateLegacyStudioPending(raw, [{ ...original, provider: 'claude' }])).toBeUndefined()
    expect(
      migrateLegacyStudioPending(raw, [{ ...original, profileId: 'different-machine' }]),
    ).toBeUndefined()
    expect(migrateLegacyStudioPending(raw, [], 'life-studio:new')).toBeUndefined()
    expect(migrateLegacyStudioPending('{broken', [original])).toBeUndefined()
    expect(migrateLegacyStudioPending(null, [original])).toBeUndefined()
    expect(migrateLegacyStudioPending(raw, [original], original.id)).toBeUndefined()
  })

  it('recovers the exact saved user message when old pending metadata stripped a /life prefix', () => {
    const original = legacyThread()
    original.messages[0].text = ' \n/life please change the sidebar.\t  '
    const old = JSON.parse(legacyPending(original))
    old.request = 'please change the sidebar.'
    old.start.prompt = 'Generated source instructions.'
    const migrated = migrateLegacyStudioPending(
      JSON.stringify(old),
      [original],
      'life-studio:exact-id',
    )
    expect(migrated?.session.request).toBe(original.messages[0].text)
    expect(migrated?.pending.request).toBe(original.messages[0].text)
    expect(migrated?.pending.start.prompt).toBe(original.messages[0].text)
  })
})
