import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  STUDIO_HISTORY_KEY,
  StudioHistoryStore,
  createStudioSession,
  encodeStudioSessions,
  normalizeStudioSessions,
  parseStudioSessions,
  readStudioHistory,
  type StudioSession,
} from '../src/renderer/studio-history'
import {
  copyConversationSourceJson,
  hasConversationSource,
} from '../src/renderer/conversation-source'
import { finishThreadTurn, readThreads, type Message, type Thread } from '../src/renderer/state'
import { resetStudioSessionRequests } from '../src/renderer/studio-source'

const exact = '  Exact request\r\n\tΩ 😀 \ud800 tail  '
const suffix = '\r\n  streamed Ω \udfff  '

interface RawSession extends Record<string, unknown> {
  id: string
  thread: Record<string, unknown> & { messages: unknown[] }
}

function rawSession(id = 'studio-one', updatedAt = 10): RawSession {
  const initial = createStudioSession('codex', updatedAt, id)
  return {
    ...initial,
    request: exact,
    futureSessionField: { exact, revision: 7 },
    thread: {
      ...initial.thread,
      remoteId: 'provider-session-Ω',
      workspace: '/root/.life/studio',
      futureThreadField: { exact, owner: 'retained' },
      messages: [rawMessage()],
    },
  }
}

function rawMessage(id = 'message-one', text = exact): Record<string, unknown> {
  return {
    id,
    role: 'assistant',
    text,
    input: exact,
    turn: 1,
    futureMessageField: { exact, occurrence: id },
  }
}

function open(raw: unknown) {
  const encoded = JSON.stringify(raw)
  const storage = { getItem: vi.fn(() => encoded) }
  return { history: readStudioHistory(storage), storage, encoded }
}

function decoded(encoded: string): unknown[] {
  return JSON.parse(encoded) as unknown[]
}

function projected(history: ReturnType<typeof readStudioHistory>, session: StudioSession) {
  return history.projectSession(session) as RawSession
}

afterEach(() => vi.unstubAllGlobals())

describe('lossless Studio recovery', () => {
  it('retains exact requests, opaque records, unknown metadata and original stored order', () => {
    const older = rawSession('older', 1)
    older.thread.messages = [
      null,
      'opaque output\r\nΩ',
      17,
      { id: 'future-message', role: 'future-provider-role', payload: { exact } },
      rawMessage(),
      { role: 'assistant', text: 'No native identity\r\n' },
    ]
    const newer = rawSession('newer', 20)
    const rejected = { id: 'future-session', futureShape: { exact } }
    const raw = [older, null, rejected, newer, 'outer opaque', 9]
    const { history, storage } = open(raw)

    expect(storage.getItem).toHaveBeenCalledExactlyOnceWith(STUDIO_HISTORY_KEY)
    expect(history.canSave).toBe(true)
    expect(history.sessions.map((session) => session.id)).toEqual(['newer', 'older'])
    expect(history.sessions[1].thread.messages).toHaveLength(1)
    expect(history.sessions[1].thread.messages[0].text).toBe(exact)
    expect(history.sessions[1].thread.messages[0].input).toBe(exact)
    expect(decoded(history.encode(history.sessions))).toEqual(raw)
    expect(decoded(encodeStudioSessions(parseStudioSessions(JSON.stringify(raw))))).toEqual(raw)
    expect(projected(history, history.sessions[1])).toEqual(older)
  })

  it('retains rejected duplicate sessions without making either occurrence an alias for the other', () => {
    const first = rawSession('same')
    const duplicate = {
      ...rawSession('same', 20),
      request: 'Second occurrence\r\n',
      futureSessionField: { occurrence: 'second' },
    }
    const neighbor = rawSession('neighbor', 30)
    const raw = ['head', first, null, duplicate, neighbor, 'tail']
    const { history } = open(raw)
    const selected = history.sessions.find((session) => session.id === 'same')!

    expect(history.sessions.filter((session) => session.id === 'same')).toHaveLength(1)
    expect(projected(history, selected)).toEqual(first)
    const edited = history.sessions.map((session) =>
      session === selected ? { ...session, request: exact + suffix } : session,
    )
    expect(decoded(history.encode(edited))).toEqual([
      'head',
      { ...first, request: exact + suffix },
      null,
      duplicate,
      neighbor,
      'tail',
    ])
    expect(
      decoded(history.encode(history.sessions.filter((session) => session !== selected))),
    ).toEqual(['head', null, duplicate, neighbor, 'tail'])
    expect(first.request).toBe(exact)
  })

  it('keeps stored root occurrence order when editing a newer session sorted to the front of the interface', () => {
    const older = rawSession('older', 1)
    const newer = rawSession('newer', 2)
    const raw = ['head', older, null, newer, 'tail']
    const { history } = open(raw)

    expect(history.sessions.map((session) => session.id)).toEqual(['newer', 'older'])
    const edited = history.sessions.map((session) =>
      session.id === 'newer'
        ? { ...session, thread: { ...session.thread, title: 'Changed newer title' } }
        : session,
    )
    expect(decoded(history.encode(edited))).toEqual([
      'head',
      older,
      null,
      { ...newer, thread: { ...newer.thread, title: 'Changed newer title' } },
      'tail',
    ])
  })

  it('keeps interrupted work inert in the interface and intact in the archival projection', () => {
    const raw = rawSession()
    raw.stage = 'applying'
    raw.thread.busy = true
    raw.thread.turn = 2
    raw.thread.turnStatus = 'running'
    raw.thread.pending = [{ type: 'approval', sessionId: raw.id, requestId: 'permission-Ω' }]
    raw.thread.queue = [{ id: 'queued', text: exact, createdAt: 1, futureQueueField: { exact } }]
    raw.thread.messages = [
      { ...rawMessage('user'), role: 'user', turn: 2 },
      { ...rawMessage('tool'), role: 'tool', status: 'running', turn: 2 },
    ]
    const { history } = open([raw])
    const recovered = history.sessions[0]

    expect(recovered.stage).toBe('interrupted')
    expect(recovered.thread.busy).toBe(false)
    expect(recovered.thread.pending).toEqual([])
    expect(recovered.thread.turnStatus).toBe('interrupted')
    expect(recovered.thread.queue?.[0].paused).toBe(true)
    expect(recovered.thread.messages).toMatchObject([
      { id: 'user', finishStatus: 'interrupted' },
      { id: 'tool', status: 'interrupted' },
    ])
    expect(decoded(history.encode([recovered]))).toEqual([raw])
    expect(projected(history, recovered)).toEqual(raw)

    const currentPending: NonNullable<StudioSession['thread']['pending']> = [
      { type: 'approval', sessionId: raw.id, requestId: 'new-permission' },
    ]
    const continuing = {
      ...recovered,
      stage: 'planning' as const,
      thread: { ...recovered.thread, busy: true, pending: currentPending },
    }
    expect(decoded(history.encode([continuing]))).toEqual([
      {
        ...raw,
        stage: 'planning',
        thread: { ...raw.thread, busy: true, pending: currentPending },
      },
    ])
  })

  it.each([
    { kind: 'source', message: 'Apply me', patch: { files: [] }, futureProposalField: { exact } },
    { kind: 'settings', message: 'Apply me', patch: { theme: 'unsupported-theme' } },
    { kind: 'extension', message: 'Apply me', manifest: { id: 'bad', renderer: { js: exact } } },
    { kind: 'future-proposal', message: exact, payload: { exact } },
  ])(
    'retains an invalid proposal for export without admitting it for execution: $kind',
    (proposal) => {
      const raw = { ...rawSession(), stage: 'review', proposal }
      const { history } = open([raw])

      expect(history.sessions[0].stage).toBe('failed')
      expect(history.sessions[0].proposal).toBeUndefined()
      expect(decoded(history.encode(history.sessions))).toEqual([raw])
      expect(projected(history, history.sessions[0]).proposal).toEqual(proposal)
      const renamed = {
        ...history.sessions[0],
        thread: { ...history.sessions[0].thread, title: 'Review retained output' },
      }
      expect(decoded(history.encode([renamed]))).toEqual([
        { ...raw, thread: { ...raw.thread, title: 'Review retained output' } },
      ])
    },
  )

  it('removes an archived invalid proposal only when the current session explicitly clears it', () => {
    const proposal = {
      kind: 'source',
      message: 'Rejected proposal',
      patch: { files: [] },
      futureProposalField: { exact },
    }
    const raw = { ...rawSession(), stage: 'review', proposal }
    const { history } = open([raw])
    const original = history.sessions[0]

    expect(Object.hasOwn(original, 'proposal')).toBe(false)
    expect(projected(history, { ...original }).proposal).toEqual(proposal)
    const cleared = { ...original, proposal: undefined }
    const expected: Record<string, unknown> = { ...raw }
    delete expected.proposal
    expect(projected(history, cleared)).toEqual(expected)
    expect(decoded(history.encode([cleared]))).toEqual([expected])
    expect(projected(history, original)).toEqual(raw)
  })

  it('overlays immutable title, request and streamed text edits without losing raw neighbors', () => {
    const raw = rawSession()
    raw.thread.messages = [null, rawMessage(), { id: 'opaque', role: 'future-role', exact }, 3]
    const { history } = open([raw])
    const original = history.sessions[0]
    const edited = {
      ...original,
      request: original.request + suffix,
      updatedAt: 40,
      thread: {
        ...original.thread,
        title: 'Renamed Studio conversation',
        messages: original.thread.messages.map((message) => ({
          ...message,
          text: message.text + suffix,
        })),
      },
    }

    expect(decoded(history.encode([edited]))).toEqual([
      {
        ...raw,
        request: exact + suffix,
        updatedAt: 40,
        thread: {
          ...raw.thread,
          title: 'Renamed Studio conversation',
          messages: [
            null,
            { ...rawMessage(), text: exact + suffix },
            { id: 'opaque', role: 'future-role', exact },
            3,
          ],
        },
      },
    ])
    expect(projected(history, original)).toEqual(raw)
  })

  it('archives explicit profile and provider field edits while preserving unknown data', () => {
    const raw = rawSession()
    const { history } = open([raw])
    const original = history.sessions[0]
    const bound = {
      ...original,
      thread: { ...original.thread, profileId: 'remote-machine', provider: 'claude' as const },
    }

    expect(decoded(history.encode([bound]))).toEqual([
      { ...raw, thread: { ...raw.thread, profileId: 'remote-machine', provider: 'claude' } },
    ])
    expect(projected(history, bound).thread.remoteId).toBe('provider-session-Ω')
    expect(projected(history, bound).futureSessionField).toEqual(raw.futureSessionField)
    expect(projected(history, original)).toEqual(raw)
  })

  it('preserves an unbound draft archive when its first run binds a profile without a provider session', () => {
    const raw = rawSession()
    delete raw.thread.remoteId
    const { history } = open([raw])
    const original = history.sessions[0]

    expect(original.thread.profileId).toBe('')
    expect(original.thread.remoteId).toBeUndefined()
    const bound = {
      ...original,
      thread: { ...original.thread, profileId: 'first-remote-machine' },
    }
    expect(decoded(history.encode([bound]))).toEqual([
      { ...raw, thread: { ...raw.thread, profileId: 'first-remote-machine' } },
    ])
    expect(projected(history, bound).thread.remoteId).toBeUndefined()
    expect(projected(history, bound).thread.futureThreadField).toEqual(raw.thread.futureThreadField)
    expect(projected(history, bound).thread.messages).toEqual(raw.thread.messages)
    expect(projected(history, original)).toEqual(raw)
  })

  it('persists explicit removal of admitted optional fields without erasing hidden metadata', () => {
    const raw = rawSession()
    const { history } = open([raw])
    const original = history.sessions[0]
    const message = { ...original.thread.messages[0] }
    delete message.input
    const thread = { ...original.thread, messages: [message] }
    delete thread.remoteId
    const edited = { ...original, thread }
    delete edited.request
    const expectedMessage = { ...rawMessage() }
    delete expectedMessage.input
    const expected: RawSession = { ...raw, thread: { ...raw.thread, messages: [expectedMessage] } }
    delete expected.request
    delete expected.thread.remoteId

    expect(decoded(history.encode([edited]))).toEqual([expected])
    expect(projected(history, original)).toEqual(raw)
  })

  it('edits and deletes only the selected duplicate message occurrence', () => {
    const first = { ...rawMessage('same'), futureMessageField: { occurrence: 'first' } }
    const second = { ...rawMessage('same'), futureMessageField: { occurrence: 'second' } }
    const opaque = { id: 'same', role: 'future-role', exact }
    const raw = rawSession()
    raw.thread.messages = ['head', first, null, second, opaque, 'tail']
    const { history } = open([raw])
    const original = history.sessions[0]

    expect(original.thread.messages).toHaveLength(2)
    const edited = {
      ...original,
      thread: {
        ...original.thread,
        messages: original.thread.messages.map((message, index) =>
          index === 1 ? { ...message, text: exact + suffix } : message,
        ),
      },
    }
    expect(projected(history, edited).thread.messages).toEqual([
      'head',
      first,
      null,
      { ...second, text: exact + suffix },
      opaque,
      'tail',
    ])
    const removed = {
      ...original,
      thread: { ...original.thread, messages: [original.thread.messages[1]] },
    }
    expect(projected(history, removed).thread.messages).toEqual([
      'head',
      null,
      second,
      opaque,
      'tail',
    ])
    expect(raw.thread.messages).toEqual(['head', first, null, second, opaque, 'tail'])
  })

  it('does not bind an admitted message to an earlier rejected row with the same ID and text', () => {
    const opaque = {
      ...rawMessage('same'),
      role: 'future-role',
      futureMessageField: { occurrence: 'rejected' },
    }
    const admitted = { ...rawMessage('same'), futureMessageField: { occurrence: 'admitted' } }
    const raw = rawSession()
    raw.thread.messages = [opaque, null, admitted]
    const { history } = open([raw])
    const original = history.sessions[0]

    expect(original.thread.messages).toHaveLength(1)
    const edited = {
      ...original,
      thread: {
        ...original.thread,
        messages: [{ ...original.thread.messages[0], text: exact + suffix }],
      },
    }
    expect(projected(history, edited).thread.messages).toEqual([
      opaque,
      null,
      { ...admitted, text: exact + suffix },
    ])
    const removed = { ...original, thread: { ...original.thread, messages: [] } }
    expect(projected(history, removed).thread.messages).toEqual([opaque, null])
  })

  it('honors visible message reorder and insertion while retaining opaque slot order', () => {
    const first = { ...rawMessage('same'), futureMessageField: { occurrence: 'first' } }
    const second = { ...rawMessage('same'), futureMessageField: { occurrence: 'second' } }
    const raw = rawSession()
    raw.thread.messages = ['head', first, null, second, 'tail']
    const { history } = open([raw])
    const original = history.sessions[0]

    expect(JSON.parse(JSON.stringify(original.thread.messages[0]))).toEqual(
      JSON.parse(JSON.stringify(original.thread.messages[1])),
    )
    expect(
      projected(history, {
        ...original,
        thread: { ...original.thread, messages: [...original.thread.messages].reverse() },
      }).thread.messages,
    ).toEqual(['head', second, null, first, 'tail'])
    const added: Message = { id: 'new', role: 'user', text: exact, turn: 2 }
    expect(
      projected(history, {
        ...original,
        thread: { ...original.thread, messages: [added, ...original.thread.messages] },
      }).thread.messages,
    ).toEqual(['head', added, first, null, second, 'tail'])
  })

  it('retains opaque messages after every actionable message is explicitly removed', () => {
    const raw = rawSession()
    const opaque = { id: 'future', role: 'future-role', exact }
    raw.thread.messages = ['head', rawMessage(), null, opaque, 'tail']
    const { history } = open([raw])
    const original = history.sessions[0]
    const removed = { ...original, thread: { ...original.thread, messages: [] } }

    expect(projected(history, removed).thread.messages).toEqual(['head', null, opaque, 'tail'])
    expect(projected(history, original)).toEqual(raw)
  })

  it('does not invent normalized defaults in a stored session with absent optional fields', () => {
    const raw = rawSession()
    delete raw.thread.pending
    delete raw.thread.busy
    delete raw.thread.model
    delete raw.thread.mode
    delete raw.thread.turn
    raw.thread.messages = [{ id: 'message', role: 'assistant', text: exact }]
    const { history } = open([raw])

    expect(history.sessions[0].thread).toMatchObject({ busy: false, pending: [], turn: 0 })
    expect(decoded(history.encode(history.sessions))).toEqual([raw])
  })
})

describe('Studio metadata is validated without coercion', () => {
  const invalidMetadata = [{ toString: 'future' }, { toString: { future: true } }, ['user'], []]

  it.each(invalidMetadata)(
    'isolates an invalid message role %j without hiding other output',
    (role) => {
      const raw = rawSession()
      const invalid = { ...rawMessage('invalid'), role }
      raw.thread.messages = [invalid, rawMessage('valid')]
      const neighbor = rawSession('neighbor', 20)
      const { history } = open([raw, neighbor])

      expect(history.sessions.map((session) => session.id)).toEqual(['neighbor', 'studio-one'])
      expect(history.sessions[1].thread.messages.map((message) => message.id)).toEqual(['valid'])
      expect(decoded(history.encode(history.sessions))).toEqual([raw, neighbor])
      expect(parseStudioSessions(JSON.stringify([raw, neighbor]))).toHaveLength(2)
    },
  )

  it.each([{ toString: 'future' }, { toString: { future: true } }, ['codex'], ['claude']])(
    'does not admit a coerced provider %j or discard neighboring valid sessions',
    (provider) => {
      const invalid = rawSession('invalid')
      invalid.thread.provider = provider
      const codex = rawSession('codex', 20)
      const claude = rawSession('claude', 30)
      claude.thread.provider = 'claude'
      const { history } = open([invalid, codex, claude])

      expect(history.sessions.map((session) => session.id)).toEqual(['claude', 'codex'])
      expect(history.sessions.map((session) => session.thread.provider)).toEqual([
        'claude',
        'codex',
      ])
      expect(decoded(history.encode(history.sessions))).toEqual([invalid, codex, claude])
      expect(parseStudioSessions(JSON.stringify([invalid, codex, claude]))).toHaveLength(2)
    },
  )

  it.each([
    { toString: 'future' },
    { toString: { future: true } },
    ['completed'],
    ['running'],
    ['reconnecting'],
    ['unknown'],
  ])('does not interpret malformed turn status %j as active or completed work', (turnStatus) => {
    const raw = rawSession()
    raw.thread.turnStatus = turnStatus
    const { history } = open([raw, rawSession('neighbor', 20)])
    const recovered = history.sessions.find((session) => session.id === raw.id)!

    expect(history.sessions).toHaveLength(2)
    expect(recovered.stage).toBe('draft')
    expect(recovered.thread.turnStatus).toBeUndefined()
    expect(decoded(history.encode(history.sessions))[0]).toEqual(raw)
  })
})

describe('Studio storage source ownership', () => {
  it('retains rejected outer rows when there is no actionable session', () => {
    const raw = [null, 17, 'exact opaque\r\nΩ', { id: 'future', payload: { exact } }]
    const { history } = open(raw)

    expect(history.sessions).toEqual([])
    expect(history.canSave).toBe(true)
    expect(decoded(history.encode(history.sessions))).toEqual(raw)
    expect(decoded(encodeStudioSessions(parseStudioSessions(JSON.stringify(raw))))).toEqual(raw)
    const fresh = createStudioSession('claude', 50, 'new-studio')
    expect(decoded(history.encode([fresh]))).toEqual([...raw, fresh])
    expect(decoded(history.encode([]))).toEqual(raw)
  })

  it('retains rejected rows after deleting the last actionable session and adding a fresh draft', () => {
    const rejected = { id: 'future', payload: { exact } }
    const original = rawSession()
    const raw = [null, original, rejected, 'tail']
    const { history } = open(raw)
    const fresh = createStudioSession('codex', 50, 'replacement')

    expect(decoded(history.encode([]))).toEqual([null, rejected, 'tail'])
    const saved = decoded(history.encode([fresh]))
    expect(saved).toContainEqual(rejected)
    expect(saved).toContainEqual(fresh)
    expect(saved).not.toContainEqual(original)
    expect(saved.filter((value) => value === null || value === 'tail')).toEqual([null, 'tail'])
  })

  it.each(['{malformed', '{}', 'null', '"outer scalar"'])(
    '%s blocks saves that would replace unreadable history',
    (raw) => {
      const history = readStudioHistory({ getItem: () => raw })

      expect(history.sessions).toEqual([])
      expect(history.canSave).toBe(false)
      expect(history.storageError).toBeTruthy()
      expect(() => history.encode([createStudioSession('codex', 1, 'new')])).toThrow()
    },
  )

  it('keeps a storage read failure distinct from an empty store', () => {
    const history = readStudioHistory({
      getItem: () => {
        throw new Error('Storage is unavailable')
      },
    })

    expect(history.sessions).toEqual([])
    expect(history.canSave).toBe(false)
    expect(history.storageError).toBeTruthy()
    expect(() => history.encode([])).toThrow()
  })

  it('allows a genuinely new store to save and reads ambient storage through the same guard', () => {
    const storage = { getItem: vi.fn(() => null) }
    vi.stubGlobal('localStorage', storage)
    const history = readStudioHistory()
    const fresh = createStudioSession('claude', 20, 'fresh')

    expect(storage.getItem).toHaveBeenCalledExactlyOnceWith(STUDIO_HISTORY_KEY)
    expect(history.canSave).toBe(true)
    expect(history.sessions).toEqual([])
    expect(decoded(history.encode([fresh]))).toEqual([fresh])
  })

  it('retains parsed prototype and toJSON keys as inert data without polluting prototypes', () => {
    const raw = JSON.parse(
      '[{"id":"opaque","__proto__":{"studioPolluted":true},"constructor":{"exact":"Ω"},"prototype":[1],"toJSON":{"exact":"raw"}}]',
    ) as unknown[]
    const valid = rawSession()
    valid.futureSessionField = JSON.parse(
      '{"__proto__":{"studioPolluted":true},"constructor":{"exact":"Ω"},"prototype":17,"toJSON":"archival"}',
    )
    const { history } = open([...raw, valid])

    expect(decoded(history.encode(history.sessions))).toEqual([...raw, valid])
    expect((Object.prototype as { studioPolluted?: unknown }).studioPolluted).toBeUndefined()
    expect(({} as { studioPolluted?: unknown }).studioPolluted).toBeUndefined()
  })

  it('does not execute hostile getters or toJSON methods while inspecting or encoding live objects', () => {
    const invoked = vi.fn()
    const hostile = Object.defineProperty(createStudioSession('codex', 1, 'hostile'), 'thread', {
      get: invoked,
    })
    const toJSON = { ...createStudioSession('codex', 1, 'to-json'), toJSON: invoked }
    const circular = createStudioSession('codex', 1, 'circular') as StudioSession & {
      self?: unknown
    }
    circular.self = circular
    const valid = createStudioSession('claude', 1, 'valid')

    expect(
      JSON.parse(JSON.stringify(normalizeStudioSessions([hostile, toJSON, circular, valid]))),
    ).toEqual([valid])
    expect(invoked).not.toHaveBeenCalled()
    expect(() => encodeStudioSessions([hostile])).toThrow()
    expect(() => encodeStudioSessions([toJSON])).toThrow()
    expect(() => encodeStudioSessions([circular])).toThrow()
    expect(invoked).not.toHaveBeenCalled()
    const array = [valid]
    Object.defineProperty(array, '1', { get: invoked })
    expect(JSON.parse(JSON.stringify(normalizeStudioSessions(array)))).toEqual([valid])
    expect(invoked).not.toHaveBeenCalled()
  })

  it('refuses a store constructor array accessor without executing it during later encoding', () => {
    const invoked = vi.fn()
    const rows = [rawSession()]
    Object.defineProperty(rows, '1', { get: invoked, enumerable: true })

    expect(() => {
      const history = new StudioHistoryStore(rows)
      history.encode(history.sessions)
    }).toThrow()
    expect(invoked).not.toHaveBeenCalled()
  })

  it('enforces the nesting limit when a shared unowned subtree is visited shallowly before its deeper path', () => {
    const shared = { child: { exact } }
    let deep: Record<string, unknown> = shared
    for (let index = 0; index < 62; index++) deep = { next: deep }
    // The last property is inspected first, so the shared subtree first passes at a shallow depth.
    const current = { ...createStudioSession('codex', 1, 'shared-depth'), deep, shallow: shared }
    const history = readStudioHistory({ getItem: () => null })

    expect(() => encodeStudioSessions([current])).toThrow('nested too deeply')
    expect(() => history.encode([current])).toThrow('nested too deeply')
  })

  it('retains deeply nested parsed archival data without applying the live-object depth limit', () => {
    let deep: Record<string, unknown> = { exact }
    for (let index = 0; index < 100; index++) deep = { next: deep }
    const raw = { ...rawSession(), futureDeepField: deep }
    const { history } = open([raw])

    expect(history.canSave).toBe(true)
    expect(history.sessions).toHaveLength(1)
    expect(decoded(history.encode(history.sessions))).toEqual([raw])
    expect(projected(history, history.sessions[0]).futureDeepField).toEqual(deep)
  })

  it.each(['method', 'getter'] as const)(
    'rejects an array subclass with an inherited toJSON %s before Studio serialization can invoke it',
    (kind) => {
      const invoked = vi.fn(() => [])
      class HostileArray<T> extends Array<T> {}
      Object.defineProperty(
        HostileArray.prototype,
        'toJSON',
        kind === 'getter' ? { get: invoked } : { value: invoked },
      )
      const session = createStudioSession('codex', 1, 'inherited-serializer')
      const root = new HostileArray<StudioSession>()
      root.push(session)
      const nested = new HostileArray<Message>()
      nested.push({ id: 'message', role: 'assistant', text: exact, turn: 1 })
      const current = { ...session, thread: { ...session.thread, messages: nested } }

      expect(() => encodeStudioSessions(root)).toThrow()
      expect(() => encodeStudioSessions([current])).toThrow()
      expect(invoked).not.toHaveBeenCalled()
    },
  )
})

describe('copying native history into the Studio JSON boundary', () => {
  function nativeThread() {
    const raw = rawSession().thread
    const thread = readThreads([raw])[0]
    return { raw, thread }
  }

  function sourceMarker(thread: Thread): symbol {
    const marker = Object.getOwnPropertySymbols(thread).find((key) =>
      key.description?.includes('conversation recovery source'),
    )
    expect(marker).toBeDefined()
    return marker!
  }

  it('copies real recovery provenance and raw opaque rows into independent plain JSON data', () => {
    const raw = rawSession().thread
    raw.messages = [null, 'opaque\r\nΩ', rawMessage(), { id: 'future', role: 'future-role', exact }]
    const thread = readThreads([raw])[0]

    expect(hasConversationSource(thread)).toBe(true)
    const copied = copyConversationSourceJson(thread)
    expect(copied).toEqual(raw)
    expect(hasConversationSource(copied)).toBe(false)
    expect(Object.getOwnPropertySymbols(copied)).toEqual([])
    expect(Object.getOwnPropertySymbols(copied.messages[2] as object)).toEqual([])
    expect(copied).not.toBe(raw)
    expect(copied.messages).not.toBe(raw.messages)
    expect(copied.messages[2]).not.toBe(raw.messages[2])
    expect(thread.messages).toHaveLength(1)
    expect(thread.messages[0].text).toBe(exact)
  })

  it('refuses a getter on the current thread before reading projection fields', () => {
    const { thread } = nativeThread()
    const invoked = vi.fn()
    Object.defineProperty(thread, 'title', { get: invoked, enumerable: true })

    expect(() => copyConversationSourceJson(thread)).toThrow()
    expect(invoked).not.toHaveBeenCalled()
  })

  it('refuses an accessor replacing the private source marker without invoking it', () => {
    const { thread } = nativeThread()
    const invoked = vi.fn()
    Object.defineProperty(thread, sourceMarker(thread), { get: invoked, enumerable: true })

    expect(() => copyConversationSourceJson(thread)).toThrow()
    expect(invoked).not.toHaveBeenCalled()
  })

  it('refuses a getter nested in a current message before reading or merging it', () => {
    const { thread } = nativeThread()
    const invoked = vi.fn()
    Object.defineProperty(thread.messages[0], 'input', { get: invoked, enumerable: true })

    expect(() => copyConversationSourceJson(thread)).toThrow()
    expect(invoked).not.toHaveBeenCalled()
  })

  it('validates hidden raw provenance before projection can read its getters', () => {
    const { raw, thread } = nativeThread()
    const invoked = vi.fn()
    Object.defineProperty(raw, 'hiddenGetter', { get: invoked, enumerable: true })

    expect(() => copyConversationSourceJson(thread)).toThrow()
    expect(invoked).not.toHaveBeenCalled()
  })

  it('validates the hidden normalized baseline before source ownership can read its getters', () => {
    const { thread } = nativeThread()
    const source = Object.getOwnPropertyDescriptor(thread, sourceMarker(thread))!.value as {
      baseline: Record<string, unknown>
    }
    const invoked = vi.fn()
    Object.defineProperty(source.baseline, 'id', { get: invoked, enumerable: true })

    expect(() => copyConversationSourceJson(thread)).toThrow()
    expect(invoked).not.toHaveBeenCalled()
  })

  it('rejects an arbitrary symbol instead of silently stripping it as a recovery marker', () => {
    const { thread } = nativeThread()
    Object.defineProperty(thread, Symbol('unowned recovery'), { value: {}, enumerable: true })

    expect(() => copyConversationSourceJson(thread)).toThrow()
  })

  it('rejects a forged value under the real source marker key without invoking its getters', () => {
    const { thread } = nativeThread()
    const invoked = vi.fn()
    const forged = Object.defineProperty({}, 'baseline', { get: invoked, enumerable: true })
    Object.defineProperty(thread, sourceMarker(thread), { value: forged, enumerable: true })

    expect(() => copyConversationSourceJson(thread)).toThrow()
    expect(invoked).not.toHaveBeenCalled()
  })

  it('rejects a forged value under a real message occurrence marker', () => {
    const { thread } = nativeThread()
    const marker = Object.getOwnPropertySymbols(thread.messages[0])[0]
    expect(marker).toBeDefined()
    Object.defineProperty(thread.messages[0], marker, { value: {}, enumerable: true })

    expect(() => copyConversationSourceJson(thread)).toThrow()
  })

  it('refuses a circular current object and a circular hidden raw source', () => {
    const current = nativeThread().thread
    Object.defineProperty(current, 'cycle', { value: current, enumerable: true })
    expect(() => copyConversationSourceJson(current)).toThrow()

    const { raw, thread } = nativeThread()
    raw.cycle = raw
    expect(() => copyConversationSourceJson(thread)).toThrow()
  })

  it('refuses a callable serializer on current or hidden raw data without executing it', () => {
    const invoked = vi.fn(() => ({}))
    const current = nativeThread().thread
    Object.defineProperty(current, 'toJSON', { value: invoked, enumerable: true })
    expect(() => copyConversationSourceJson(current)).toThrow()

    const { raw, thread } = nativeThread()
    raw.toJSON = invoked
    expect(() => copyConversationSourceJson(thread)).toThrow()
    expect(invoked).not.toHaveBeenCalled()
  })

  it.each(['method', 'getter'] as const)(
    'rejects an array subclass with an inherited toJSON %s before the native history copy can invoke it',
    (kind) => {
      const invoked = vi.fn(() => [])
      class HostileArray<T> extends Array<T> {}
      Object.defineProperty(
        HostileArray.prototype,
        'toJSON',
        kind === 'getter' ? { get: invoked } : { value: invoked },
      )
      const current = nativeThread().thread
      const messages = new HostileArray<Message>()
      messages.push(...current.messages)
      current.messages = messages
      expect(() => copyConversationSourceJson(current)).toThrow()

      const { raw, thread } = nativeThread()
      raw.futureArray = new HostileArray<string>()
      expect(() => copyConversationSourceJson(thread)).toThrow()
      expect(invoked).not.toHaveBeenCalled()
    },
  )
})

describe('Studio writes acknowledge only durable source projections', () => {
  it('persists a title change and then a reversion against the last successful write', () => {
    const raw = rawSession()
    const { history } = open([raw])
    const original = history.sessions[0]
    const storage = { setItem: vi.fn() }
    const renamed = {
      ...original,
      thread: { ...original.thread, title: 'Changed title' },
    }

    history.write([renamed], storage)
    expect(storage.setItem).toHaveBeenCalledTimes(1)
    expect(storage.setItem.mock.calls[0][0]).toBe(STUDIO_HISTORY_KEY)
    expect(decoded(storage.setItem.mock.calls[0][1])).toEqual([
      { ...raw, thread: { ...raw.thread, title: 'Changed title' } },
    ])
    const reverted = {
      ...renamed,
      thread: { ...renamed.thread, title: original.thread.title },
    }
    expect(decoded(history.encode([reverted]))).toEqual([raw])
    history.write([reverted], storage)
    expect(storage.setItem).toHaveBeenCalledTimes(2)
    expect(storage.setItem.mock.calls[1][0]).toBe(STUDIO_HISTORY_KEY)
    expect(decoded(storage.setItem.mock.calls[1][1])).toEqual([raw])
    expect(projected(history, renamed).thread.title).toBe('Changed title')
  })

  it('persists activity toggling back to its recovered UI value after a successful continuation write', () => {
    const raw = rawSession()
    raw.stage = 'applying'
    raw.thread.busy = true
    raw.thread.pending = [{ type: 'approval', sessionId: raw.id, requestId: 'old-permission' }]
    const { history } = open([raw])
    const original = history.sessions[0]
    const pending: NonNullable<StudioSession['thread']['pending']> = [
      { type: 'approval', sessionId: raw.id, requestId: 'new-permission' },
    ]
    const continuing = {
      ...original,
      stage: 'planning' as const,
      thread: { ...original.thread, busy: true, pending },
    }
    const storage = { setItem: vi.fn() }

    history.write([continuing], storage)
    const stopped = {
      ...continuing,
      stage: 'complete' as const,
      thread: { ...continuing.thread, busy: false, pending: [] },
    }
    const expected = {
      ...raw,
      stage: 'complete',
      thread: { ...raw.thread, busy: false, pending: [] },
    }
    expect(decoded(history.encode([stopped]))).toEqual([expected])
    history.write([stopped], storage)
    expect(decoded(storage.setItem.mock.calls[1][1])).toEqual([expected])
  })

  it('does not acknowledge changed activity or replace the source after a storage write fails', () => {
    const raw = rawSession()
    raw.stage = 'applying'
    raw.thread.busy = true
    raw.thread.pending = [{ type: 'approval', sessionId: raw.id, requestId: 'old-permission' }]
    const { history } = open([raw])
    const original = history.sessions[0]
    const changed = {
      ...original,
      stage: 'planning' as const,
      thread: { ...original.thread, title: 'Not durable', busy: true },
    }
    const storage = {
      setItem: vi.fn(() => {
        throw new Error('Quota exceeded')
      }),
    }

    expect(() => history.write([changed], storage)).toThrow('Quota exceeded')
    expect(storage.setItem).toHaveBeenCalledTimes(1)
    expect(decoded(history.encode([original]))).toEqual([raw])
    expect(projected(history, original)).toEqual(raw)
    expect(projected(history, changed).thread.title).toBe('Not durable')
    expect(history.canSave).toBe(true)
  })

  it('keeps export pure so exporting activity changes cannot turn a later unchanged save into a mutation', () => {
    const raw = rawSession()
    raw.stage = 'planning'
    raw.thread.busy = true
    const { history } = open([raw])
    const original = history.sessions[0]
    const changed = {
      ...original,
      stage: 'complete' as const,
      thread: { ...original.thread, busy: false },
    }

    expect(projected(history, changed).stage).toBe('complete')
    expect(decoded(history.encode([changed]))[0]).toMatchObject({ stage: 'complete' })
    expect(projected(history, original)).toEqual(raw)
    expect(decoded(history.encode([original]))).toEqual([raw])
  })

  it.each(['getter', 'cycle', 'callable serializer'] as const)(
    'rejects a later %s injected into a cached immutable export before encoding or writing',
    (kind) => {
      const raw = rawSession()
      const { history } = open([raw])
      const original = history.sessions[0]
      const edited = {
        ...original,
        thread: { ...original.thread, title: 'Immutable exported edit' },
      }
      const exported = history.projectSession(edited)
      const invoked = vi.fn(() => ({ exact }))
      if (kind === 'getter')
        Object.defineProperty(exported, 'injected', { get: invoked, enumerable: true })
      else if (kind === 'cycle') exported.injected = exported
      else exported.toJSON = invoked
      const storage = { setItem: vi.fn() }

      expect(() => history.encode([edited])).toThrow()
      expect(() => history.projectSession(edited)).toThrow()
      expect(() => history.write([edited], storage)).toThrow()
      expect(storage.setItem).not.toHaveBeenCalled()
      expect(invoked).not.toHaveBeenCalled()
      expect(decoded(history.encode([original]))).toEqual([raw])
    },
  )

  it('validates foreign hidden raw data before projecting a renamed session into another store', () => {
    const foreign = open([rawSession('foreign')]).history
    const selected = foreign.sessions[0]
    const hiddenRaw = foreign.projectSession(selected)
    const invoked = vi.fn()
    Object.defineProperty(hiddenRaw, 'hiddenGetter', { get: invoked, enumerable: true })
    const renamed = {
      ...selected,
      thread: { ...selected.thread, title: 'Foreign session rename' },
    }
    const targetRaw = rawSession('target')
    const target = open([targetRaw]).history
    const sessions = [...target.sessions, renamed]
    const storage = { setItem: vi.fn() }

    expect(() => target.encode(sessions)).toThrow()
    expect(() => target.write(sessions, storage)).toThrow()
    expect(storage.setItem).not.toHaveBeenCalled()
    expect(invoked).not.toHaveBeenCalled()
    expect(decoded(target.encode(target.sessions))).toEqual([targetRaw])
  })

  it('validates a removed occurrence raw source before accepting it again into its former store', () => {
    const { history } = open([rawSession()])
    const removed = history.sessions[0]
    const hiddenRaw = history.projectSession(removed)
    const storage = { setItem: vi.fn() }
    history.write([], storage)
    expect(decoded(storage.setItem.mock.calls[0][1])).toEqual([])
    const invoked = vi.fn()
    Object.defineProperty(hiddenRaw, 'hiddenGetter', { get: invoked, enumerable: true })
    const stale = {
      ...removed,
      thread: { ...removed.thread, title: 'Attempted stale occurrence restore' },
    }

    expect(() => history.encode([stale])).toThrow()
    expect(() => history.write([stale], storage)).toThrow()
    expect(storage.setItem).toHaveBeenCalledTimes(1)
    expect(invoked).not.toHaveBeenCalled()
    expect(decoded(history.encode([]))).toEqual([])
  })

  it('retains exact duplicate and opaque message occurrences across successive append, edit, reorder and delete saves', () => {
    const first = { ...rawMessage('same'), futureMessageField: { occurrence: 'first', exact } }
    const second = { ...rawMessage('same'), futureMessageField: { occurrence: 'second', exact } }
    const last = rawMessage('last', 'Last exact output\r\nΩ')
    const opaque = { id: 'same', role: 'future-role', text: exact, futureMessageField: { exact } }
    const raw = rawSession()
    raw.thread.messages = ['head', first, null, opaque, second, 17, last]
    const { history } = open([raw])
    const original = history.sessions[0]
    const storage = { setItem: vi.fn() }
    const added: Message = { id: 'same', role: 'assistant', text: exact, input: exact, turn: 1 }
    const addedRaw = JSON.parse(JSON.stringify(added)) as Record<string, unknown>
    const save = (session: StudioSession, messages: unknown[]) => {
      history.write([session], storage)
      const stored = decoded(storage.setItem.mock.calls.at(-1)![1])[0] as RawSession
      expect(stored.thread.messages).toEqual(messages)
      expect(stored.futureSessionField).toEqual(raw.futureSessionField)
      expect(stored.thread.futureThreadField).toEqual(raw.thread.futureThreadField)
    }

    const appended = {
      ...original,
      thread: { ...original.thread, messages: [...original.thread.messages, added] },
    }
    save(appended, ['head', first, null, opaque, second, 17, last, addedRaw])
    const edited = {
      ...appended,
      thread: {
        ...appended.thread,
        messages: appended.thread.messages.map((message, index) =>
          index === 1 ? { ...message, text: exact + suffix } : message,
        ),
      },
    }
    const editedSecond = { ...second, text: exact + suffix }
    save(edited, ['head', first, null, opaque, editedSecond, 17, last, addedRaw])
    const reordered = {
      ...edited,
      thread: { ...edited.thread, messages: [...edited.thread.messages].reverse() },
    }
    save(reordered, ['head', addedRaw, null, opaque, last, 17, editedSecond, first])
    const selectedFirst = reordered.thread.messages[3]
    const removed = {
      ...reordered,
      thread: {
        ...reordered.thread,
        messages: reordered.thread.messages.filter((message) => message !== selectedFirst),
      },
    }
    save(removed, ['head', addedRaw, null, opaque, last, 17, editedSecond])
    const changedAdded = {
      ...removed.thread.messages[0],
      text: exact + '\r\nChanged added duplicate',
    }
    delete changedAdded.input
    const changed = {
      ...removed,
      thread: {
        ...removed.thread,
        messages: [changedAdded, ...removed.thread.messages.slice(1)],
      },
    }
    const changedAddedRaw: Record<string, unknown> = { ...addedRaw, text: changedAdded.text }
    delete changedAddedRaw.input
    save(changed, ['head', changedAddedRaw, null, opaque, last, 17, editedSecond])
    const noVisibleMessages = { ...changed, thread: { ...changed.thread, messages: [] } }
    save(noVisibleMessages, ['head', null, opaque, 17])
    expect(storage.setItem).toHaveBeenCalledTimes(6)
    expect(raw.thread.messages).toEqual(['head', first, null, opaque, second, 17, last])
  })
})

describe('explicit Studio run permission resets', () => {
  function archivedPermissionSession() {
    const raw = rawSession()
    raw.stage = 'complete'
    raw.thread.turn = 4
    raw.thread.turnStatus = 'completed'
    raw.thread.pending = [
      {
        type: 'approval',
        sessionId: raw.id,
        requestId: 'old-permission',
        method: 'item/commandExecution/requestApproval',
        params: { command: '  exact native command\r\nΩ  ', futureScope: ['session', null] },
      },
    ]
    return raw
  }

  function newRun(session: StudioSession) {
    const reset = resetStudioSessionRequests(session)
    const request = exact + '\r\nNew run request Ω  '
    const user: Message = { id: 'new-user-5', role: 'user', text: request, turn: 5 }
    return {
      ...reset,
      request,
      stage: 'planning' as const,
      thread: {
        ...reset.thread,
        busy: true,
        turn: 5,
        turnStatus: 'running' as const,
        pending: [],
        messages: [...reset.thread.messages, user],
      },
    }
  }

  it('preserves archived native permissions through passive recovery and a title change', () => {
    const raw = archivedPermissionSession()
    const { history } = open([raw])
    const original = history.sessions[0]
    expect(original.thread.pending).toEqual([])
    expect(decoded(history.encode([original]))).toEqual([raw])
    const renamed = {
      ...original,
      thread: { ...original.thread, title: 'Renamed without starting work' },
    }
    const storage = { setItem: vi.fn() }

    history.write([renamed], storage)
    expect(decoded(storage.setItem.mock.calls[0][1])).toEqual([
      { ...raw, thread: { ...raw.thread, title: 'Renamed without starting work' } },
    ])
  })

  it('clears archived permissions by explicit intent even when the whole interface presentation is unchanged', () => {
    const raw = archivedPermissionSession()
    const { history } = open([raw])
    const original = history.sessions[0]
    const reset = resetStudioSessionRequests(original)

    expect(JSON.parse(JSON.stringify(reset))).toEqual(JSON.parse(JSON.stringify(original)))
    expect(reset.thread.pending).toEqual([])
    expect(decoded(history.encode([reset]))).toEqual([
      { ...raw, thread: { ...raw.thread, pending: [] } },
    ])
    expect(projected(history, reset).thread.pending).toEqual([])
    expect(projected(history, original)).toEqual(raw)
  })

  it('saves a real new run with empty current permissions and never resurrects the archived request after stopping', () => {
    const raw = archivedPermissionSession()
    const { history } = open([raw])
    const original = history.sessions[0]
    const renamed = {
      ...original,
      thread: { ...original.thread, title: 'Passive rename' },
    }
    const storage = { setItem: vi.fn() }
    history.write([renamed], storage)
    const running = newRun(renamed)
    history.write([running], storage)

    const started = decoded(storage.setItem.mock.calls[1][1])[0] as RawSession
    expect(started.request).toBe(running.request)
    expect(started.stage).toBe('planning')
    expect(started.thread).toMatchObject({
      busy: true,
      turn: 5,
      turnStatus: 'running',
      pending: [],
    })
    expect(started.thread.messages.at(-1)).toMatchObject({
      id: 'new-user-5',
      role: 'user',
      text: running.request,
      turn: 5,
    })
    const finished = {
      ...running,
      stage: 'complete' as const,
      thread: {
        ...finishThreadTurn(running.thread, 'completed', 99),
        busy: false,
        turnStatus: 'completed' as const,
        pending: [],
      },
    }
    history.write([finished], storage)
    const stopped = decoded(storage.setItem.mock.calls[2][1])[0] as RawSession
    expect(stopped.stage).toBe('complete')
    expect(stopped.thread).toMatchObject({ busy: false, pending: [], turnStatus: 'completed' })
    expect(stopped.thread.futureThreadField).toEqual(raw.thread.futureThreadField)
    expect(stopped.thread.messages.at(-1)).toMatchObject({
      id: 'new-user-5',
      text: running.request,
      finishedAt: 99,
      finishStatus: 'completed',
    })
    expect(projected(history, finished).thread.pending).toEqual([])
  })

  it('retains explicit reset intent through an immediate finish before the first save', () => {
    const raw = archivedPermissionSession()
    const { history } = open([raw])
    const running = newRun(history.sessions[0])
    const finished = {
      ...running,
      stage: 'complete' as const,
      thread: {
        ...finishThreadTurn(running.thread, 'completed', 99),
        busy: false,
        turnStatus: 'completed' as const,
        pending: [],
      },
    }
    const storage = { setItem: vi.fn() }

    history.write([finished], storage)
    const saved = decoded(storage.setItem.mock.calls[0][1])[0] as RawSession
    expect(saved.request).toBe(running.request)
    expect(saved.stage).toBe('complete')
    expect(saved.thread).toMatchObject({
      turn: 5,
      busy: false,
      pending: [],
      turnStatus: 'completed',
    })
    expect(saved.thread.messages.at(-1)).toMatchObject({
      id: 'new-user-5',
      text: running.request,
      finishedAt: 99,
      finishStatus: 'completed',
    })
  })

  it('saves an immediate stop of a real new turn without resurrecting recovered active state', () => {
    const raw = archivedPermissionSession()
    raw.stage = 'planning'
    raw.thread.busy = true
    raw.thread.turnStatus = 'running'
    const { history } = open([raw])
    const original = history.sessions[0]

    expect(original.stage).toBe('interrupted')
    expect(original.thread).toMatchObject({
      busy: false,
      turnStatus: 'interrupted',
      pending: [],
    })
    expect(decoded(history.encode([original]))).toEqual([raw])
    const renamed = {
      ...original,
      thread: { ...original.thread, title: 'Passive title change' },
    }
    expect(decoded(history.encode([renamed]))).toEqual([
      { ...raw, thread: { ...raw.thread, title: 'Passive title change' } },
    ])
    const running = newRun(renamed)
    const stopped = {
      ...running,
      stage: 'interrupted' as const,
      thread: {
        ...finishThreadTurn(running.thread, 'interrupted', 99),
        busy: false,
        turnStatus: 'interrupted' as const,
        pending: [],
      },
    }
    const storage = { setItem: vi.fn() }

    history.write([stopped], storage)
    expect(storage.setItem).toHaveBeenCalledTimes(1)
    const saved = decoded(storage.setItem.mock.calls[0][1])[0] as RawSession
    expect(saved.stage).toBe('interrupted')
    expect(saved.request).toBe(running.request)
    expect(saved.thread).toMatchObject({
      title: 'Passive title change',
      turn: 5,
      busy: false,
      turnStatus: 'interrupted',
      pending: [],
    })
    expect(saved.thread.messages.at(-1)).toMatchObject({
      id: 'new-user-5',
      role: 'user',
      text: running.request,
      turn: 5,
      finishedAt: 99,
      finishStatus: 'interrupted',
    })
    expect(saved.thread.futureThreadField).toEqual(raw.thread.futureThreadField)
    const reloaded = parseStudioSessions(storage.setItem.mock.calls[0][1])[0]
    expect(reloaded.stage).toBe('interrupted')
    expect(reloaded.thread).toMatchObject({
      turn: 5,
      busy: false,
      turnStatus: 'interrupted',
      pending: [],
    })
  })

  it('does not acknowledge a failed reset write and retries the same explicit intent after storage recovers', () => {
    const raw = archivedPermissionSession()
    const { history } = open([raw])
    const original = history.sessions[0]
    const reset = resetStudioSessionRequests(original)
    const storage = {
      setItem: vi.fn((_key: string, _encoded: string) => {}),
    }
    storage.setItem.mockImplementationOnce(() => {
      throw new Error('Transient storage failure')
    })

    expect(() => history.write([reset], storage)).toThrow('Transient storage failure')
    expect(decoded(history.encode([original]))).toEqual([raw])
    expect(projected(history, original)).toEqual(raw)
    expect(projected(history, reset).thread.pending).toEqual([])
    history.write([reset], storage)
    expect(storage.setItem).toHaveBeenCalledTimes(2)
    expect(decoded(storage.setItem.mock.calls[1][1])).toEqual([
      { ...raw, thread: { ...raw.thread, pending: [] } },
    ])
    expect(projected(history, original).thread.pending).toEqual([])
    expect(projected(history, reset).thread.pending).toEqual([])
  })
})
