import { describe, expect, it, vi } from 'vitest'
import {
  STUDIO_HISTORY_KEY,
  createStudioSession,
  readStudioHistory,
  studioRecoveryCacheRow,
  type PreparedStudioHistoryWrite,
  type StudioSession,
} from '../src/renderer/studio-history'
import { studioSourceOwner } from '../src/renderer/studio-source'

const exact = '  request\r\n\tΩ 😀 \ud800 tail  '

function rawSession(id = 'studio-one', updatedAt = 1) {
  const draft = createStudioSession('codex', updatedAt, id)
  return {
    ...draft,
    request: exact,
    futureSession: { exact, revision: 7 },
    thread: {
      ...draft.thread,
      profileId: 'machine-one',
      remoteId: 'native-session-one',
      workspace: '/work/studio',
      futureThread: { exact },
      messages: [
        null,
        { id: 'message-one', role: 'assistant', text: exact, turn: 1, futureMessage: { exact } },
        { id: 'message-one', role: 'future-role', text: 'opaque occurrence', exact },
      ],
    },
  }
}

function open(rows: unknown[] = [rawSession()]) {
  return readStudioHistory({ getItem: () => JSON.stringify(rows) })
}

function rename(session: StudioSession, title = 'Prepared title'): StudioSession {
  return { ...session, thread: { ...session.thread, title } }
}

describe('privately prepared Studio cache writes', () => {
  it('prepares exact selected occurrences without acknowledging or changing raw recovery hashes', () => {
    const first = rawSession()
    const duplicate = {
      ...rawSession(),
      request: 'rejected duplicate',
      futureSession: { exact, revision: 8 },
    }
    const rows = ['head', first, null, duplicate, rawSession('neighbor', 2), 'tail']
    const history = open(rows)
    const original = history.sessions.find((session) => session.id === first.id)!
    const edited = rename(original)
    const next = history.sessions.map((session) => (session === original ? edited : session))
    const prepared = history.prepare(next)
    const expected = { ...first, thread: { ...first.thread, title: 'Prepared title' } }
    const view = prepared.views.find((candidate) => candidate.session === edited)!

    expect(JSON.parse(prepared.encoded)).toEqual([
      'head',
      expected,
      null,
      duplicate,
      rows[4],
      'tail',
    ])
    expect(view.row).toEqual(expected)
    expect(view.encodedRow).toBe(JSON.stringify(expected))
    expect(history.recoveryRow(edited)).toBe(JSON.stringify(first))
    expect(history.recoveryRow(original)).toBe(JSON.stringify(first))
    const storage = { setItem: vi.fn() }
    const written = history.commitPrepared(prepared, storage)

    expect(written).toBe(prepared.views)
    expect(storage.setItem).toHaveBeenCalledExactlyOnceWith(STUDIO_HISTORY_KEY, prepared.encoded)
    expect(history.recoveryRow(edited)).toBe(view.encodedRow)
    expect(JSON.parse(history.encode([edited, history.sessions[0]]))).toEqual([
      'head',
      expected,
      null,
      duplicate,
      rows[4],
      'tail',
    ])
  })

  it('preserves duplicate and opaque message slots through the next write after a prepared commit', () => {
    const raw = rawSession()
    const history = open([raw])
    const edited = rename(history.sessions[0])
    const storage = { setItem: vi.fn() }
    history.commitPrepared(history.prepare([edited]), storage)
    const streamed = {
      ...edited,
      thread: {
        ...edited.thread,
        messages: edited.thread.messages.map((message) => ({
          ...message,
          text: message.text + exact,
        })),
      },
    }
    history.write([streamed], storage)

    const saved = JSON.parse(storage.setItem.mock.calls[1][1])[0]
    expect(saved.thread.messages).toEqual([
      null,
      { ...raw.thread.messages[1]!, text: exact + exact },
      raw.thread.messages[2],
    ])
    expect(saved.futureSession).toEqual(raw.futureSession)
    expect(saved.thread.futureThread).toEqual(raw.thread.futureThread)
  })

  it.each(['copied receipt', 'JSON receipt', 'fabricated receipt'])(
    'rejects a %s without writing',
    (kind) => {
      const history = open()
      const prepared = history.prepare(history.sessions)
      const fake =
        kind === 'copied receipt'
          ? { ...prepared }
          : kind === 'JSON receipt'
            ? JSON.parse(JSON.stringify(prepared))
            : { encoded: prepared.encoded, views: [] }
      const storage = { setItem: vi.fn() }

      expect(() => history.commitPrepared(fake as PreparedStudioHistoryWrite, storage)).toThrow(
        'not owned',
      )
      expect(storage.setItem).not.toHaveBeenCalled()
    },
  )

  it('rejects a valid receipt from a different store and a receipt already consumed', () => {
    const history = open()
    const other = open()
    const prepared = history.prepare(history.sessions)
    const storage = { setItem: vi.fn() }

    expect(() => other.commitPrepared(prepared, storage)).toThrow('not owned')
    history.commitPrepared(prepared, storage)
    expect(() => history.commitPrepared(prepared, storage)).toThrow('stale')
    expect(storage.setItem).toHaveBeenCalledTimes(1)
  })

  it('rejects an older prepared write after a newer synchronous write', () => {
    const history = open()
    const original = history.sessions[0]
    const prepared = history.prepare([rename(original, 'older')])
    const latest = rename(original, 'latest')
    const storage = { setItem: vi.fn() }
    history.write([latest], storage)

    expect(() => history.commitPrepared(prepared, storage)).toThrow('stale')
    expect(storage.setItem).toHaveBeenCalledTimes(1)
    expect(history.recoveryRow(latest)).toBe(JSON.stringify(history.projectSession(latest)))
    expect(JSON.parse(storage.setItem.mock.calls[0][1])[0].thread.title).toBe('latest')
  })

  it('rejects a receipt when source ownership was independently acknowledged', () => {
    const history = open()
    const prepared = history.prepare(history.sessions)
    const source = studioSourceOwner(history.sessions[0])!
    source.acknowledge(source.project(history.sessions))
    const storage = { setItem: vi.fn() }

    expect(() => history.commitPrepared(prepared, storage)).toThrow('stale')
    expect(storage.setItem).not.toHaveBeenCalled()
  })

  it('rejects a receipt when another store takes ownership of the same private occurrence', () => {
    const history = open()
    const other = open([])
    const original = history.sessions[0]
    const prepared = history.prepare([rename(original)])
    const clone = { ...original }
    other.write([clone], { setItem: vi.fn() })
    const storage = { setItem: vi.fn() }

    expect(() => history.commitPrepared(prepared, storage)).toThrow('ownership is stale')
    expect(storage.setItem).not.toHaveBeenCalled()
    expect(history.recoveryRow(original)).toBeUndefined()
    expect(other.recoveryRow(clone)).toBe(JSON.stringify(rawSession()))
  })

  it('rejects a prepared foreign import after its source store writes a newer revision', () => {
    const source = open()
    const target = open([])
    const session = source.sessions[0]
    const prepared = target.prepare([{ ...session }])
    source.write([rename(session)], { setItem: vi.fn() })
    const storage = { setItem: vi.fn() }

    expect(() => target.commitPrepared(prepared, storage)).toThrow('ownership is stale')
    expect(storage.setItem).not.toHaveBeenCalled()
  })

  it.each(['baseline id', 'binding baseline'])(
    'rejects a changed exposed %s descriptor before ownership checks can invoke its getter',
    (kind) => {
      const history = open()
      const original = history.sessions[0]
      const source = studioSourceOwner(original)!
      const binding = source.project([original]).views[0].projection.source!
      const baseline = binding.baseline
      const prepared = history.prepare([rename(original)])
      const getter = vi.fn(() => (kind === 'baseline id' ? original.id : baseline))
      if (kind === 'baseline id')
        Object.defineProperty(baseline, 'id', { get: getter, enumerable: true })
      else Object.defineProperty(binding, 'baseline', { get: getter, enumerable: true })
      const storage = { setItem: vi.fn() }

      expect(() => history.commitPrepared(prepared, storage)).toThrow('changed before')
      expect(storage.setItem).not.toHaveBeenCalled()
      expect(getter).not.toHaveBeenCalled()
    },
  )

  it('allows retrying the same exact receipt after a failed storage write without premature acknowledgment', () => {
    const raw = rawSession()
    const history = open([raw])
    const edited = rename(history.sessions[0])
    const prepared = history.prepare([edited])
    const storage = {
      setItem: vi.fn().mockImplementationOnce(() => {
        throw new Error('Quota exceeded')
      }),
    }

    expect(() => history.commitPrepared(prepared, storage)).toThrow('Quota exceeded')
    expect(history.recoveryRow(edited)).toBe(JSON.stringify(raw))
    history.commitPrepared(prepared, storage)
    expect(storage.setItem).toHaveBeenCalledTimes(2)
    expect(storage.setItem.mock.calls[1]).toEqual([STUDIO_HISTORY_KEY, prepared.encoded])
    expect(history.recoveryRow(edited)).toBe(prepared.views[0].encodedRow)
  })

  it.each(['session field', 'nested message', 'array entry', 'getter', 'symbol', 'prototype'])(
    'rejects a changed %s between preparation and commit without invoking getters',
    (kind) => {
      const history = open()
      const edited = rename(history.sessions[0])
      const sessions = [edited]
      const prepared = history.prepare(sessions)
      const getter = vi.fn(() => exact)
      if (kind === 'session field') edited.request = 'different request'
      else if (kind === 'nested message') edited.thread.messages[0].text = 'different output'
      else if (kind === 'array entry') sessions[0] = { ...edited }
      else if (kind === 'getter')
        Object.defineProperty(edited, 'request', { get: getter, enumerable: true })
      else if (kind === 'symbol')
        Object.defineProperty(edited.thread.messages[0], Symbol('forged'), {
          value: {},
          enumerable: true,
        })
      else Object.setPrototypeOf(edited.thread, {})
      const storage = { setItem: vi.fn() }

      expect(() => history.commitPrepared(prepared, storage)).toThrow('changed before')
      expect(storage.setItem).not.toHaveBeenCalled()
      expect(getter).not.toHaveBeenCalled()
    },
  )

  it.each(['projected row', 'encoded row', 'receipt bytes', 'views array', 'raw source'])(
    'rejects a mutated %s before committing private bytes',
    (kind) => {
      const history = open()
      const edited = rename(history.sessions[0])
      const prepared = history.prepare([edited])
      if (kind === 'projected row')
        (prepared.views[0].row.thread as Record<string, unknown>).title = 'tampered'
      else if (kind === 'encoded row')
        Object.defineProperty(prepared.views[0], 'encodedRow', { value: 'tampered' })
      else if (kind === 'receipt bytes')
        Object.defineProperty(prepared, 'encoded', { value: 'tampered' })
      else if (kind === 'views array') (prepared.views as unknown[]).pop()
      else history.projectSession(history.sessions[0]).request = 'mutated old source'
      const storage = { setItem: vi.fn() }

      expect(() => history.commitPrepared(prepared, storage)).toThrow('changed before')
      expect(storage.setItem).not.toHaveBeenCalled()
    },
  )

  it('keeps successful byte-write evidence but refuses to acknowledge changed caller data in a storage callback', () => {
    const raw = rawSession()
    const history = open([raw])
    const edited = rename(history.sessions[0])
    const prepared = history.prepare([edited])
    const storage = {
      setItem: vi.fn((_key: string, _value: string) => {
        edited.thread.title = 'changed during write'
      }),
    }

    expect(() => history.commitPrepared(prepared, storage)).toThrow('bytes were stored')
    expect(storage.setItem).toHaveBeenCalledExactlyOnceWith(STUDIO_HISTORY_KEY, prepared.encoded)
    expect(JSON.parse(storage.setItem.mock.calls[0][1])[0].thread.title).toBe('Prepared title')
    expect(history.recoveryRow(edited)).toBe(JSON.stringify(raw))
    expect(() => history.commitPrepared(prepared, storage)).toThrow('stale')
  })

  it('checks post-write descriptors without invoking a getter introduced by a storage callback', () => {
    const history = open()
    const edited = rename(history.sessions[0])
    const prepared = history.prepare([edited])
    const getter = vi.fn(() => exact)
    const storage = {
      setItem: vi.fn(() => {
        Object.defineProperty(edited, 'request', { get: getter, enumerable: true })
      }),
    }

    expect(() => history.commitPrepared(prepared, storage)).toThrow('bytes were stored')
    expect(getter).not.toHaveBeenCalled()
    expect(storage.setItem).toHaveBeenCalledExactlyOnceWith(STUDIO_HISTORY_KEY, prepared.encoded)
  })

  it('refuses reentrant writes while a prepared snapshot is committing', () => {
    const history = open()
    const prepared = history.prepare(history.sessions)
    const nestedStorage = { setItem: vi.fn() }
    const storage = {
      setItem: vi.fn(() => {
        history.write(history.sessions, nestedStorage)
      }),
    }

    expect(() => history.commitPrepared(prepared, storage)).toThrow('already committing')
    expect(nestedStorage.setItem).not.toHaveBeenCalled()
    expect(history.recoveryRow(history.sessions[0])).toBe(JSON.stringify(rawSession()))
  })

  it('returns no raw recovery proof for an unowned, foreign or deleted session occurrence', () => {
    const history = open()
    const other = open()
    const original = history.sessions[0]

    expect(history.recoveryRow(createStudioSession('codex', 1, original.id))).toBeUndefined()
    expect(history.recoveryRow(other.sessions[0])).toBeUndefined()
    history.write([], { setItem: vi.fn() })
    expect(history.recoveryRow(original)).toBeUndefined()
  })

  it('retains the exact acknowledged row bytes after valid in-place edits to shared raw objects', () => {
    const history = open([])
    const fresh = createStudioSession('codex', 1, 'fresh')
    const prepared = history.prepare([fresh])
    history.commitPrepared(prepared, { setItem: vi.fn() })
    const stored = prepared.views[0].encodedRow
    fresh.thread.title = 'later mutable title'
    fresh.thread.messages.push({ id: 'later', role: 'assistant', text: exact, turn: 1 })

    expect(history.recoveryRow(fresh)).toBe(stored)
    expect(JSON.parse(stored).thread.title).toBe('New customization')
    expect(JSON.parse(stored).thread.messages).toEqual([])
    expect(history.recoveryRow({ ...fresh })).toBe(stored)
  })

  it('retains admitted row bytes after a valid archival export mutation', () => {
    const raw = rawSession()
    const history = open([raw])
    const session = history.sessions[0]
    history.projectSession(session).request = 'later raw export mutation'

    expect(history.recoveryRow(session)).toBe(JSON.stringify(raw))
  })

  it('preserves an actionable deeply nested archive when canonical hash encoding is unavailable', () => {
    const shallow = JSON.stringify(rawSession())
    const depth = 10_000
    const deep = `${'{"nested":'.repeat(depth)}0${'}'.repeat(depth)}`
    const encoded = `[${shallow.slice(0, -1)},"futureDepth":${deep}}]`
    const history = readStudioHistory({ getItem: () => encoded })

    expect(history.canSave).toBe(true)
    expect(history.sessions.map((session) => session.id)).toEqual(['studio-one'])
    expect(history.sessions[0].thread.messages[0].text).toBe(exact)
    expect(history.recoveryRow(history.sessions[0])).toBeUndefined()
  })

  it('rejects a fresh nonextensible session before writing or changing existing ownership', () => {
    const history = open()
    const original = history.sessions[0]
    const fresh = Object.freeze(createStudioSession('codex', 1, 'fresh'))
    const storage = { setItem: vi.fn() }

    expect(() => history.write([original, fresh], storage)).toThrow('private source binding')
    expect(storage.setItem).not.toHaveBeenCalled()
    expect(history.recoveryRow(original)).toBe(JSON.stringify(rawSession()))
    expect(history.hasSession(original)).toBe(true)
    expect(history.hasSession(fresh)).toBe(false)
  })

  it('rejects lost extensibility after preparation before writing or partially acknowledging rows', () => {
    const history = open()
    const original = history.sessions[0]
    const fresh = createStudioSession('codex', 1, 'fresh')
    const prepared = history.prepare([original, fresh])
    Object.preventExtensions(fresh)
    const storage = { setItem: vi.fn() }

    expect(() => history.commitPrepared(prepared, storage)).toThrow('changed before')
    expect(storage.setItem).not.toHaveBeenCalled()
    expect(history.hasSession(original)).toBe(true)
    expect(history.hasSession(fresh)).toBe(false)
    expect(JSON.parse(history.encode([original]))).toEqual([rawSession()])
  })

  it('rejects a new frozen message requiring an occurrence binding before writing', () => {
    const history = open()
    const original = history.sessions[0]
    const fresh = Object.freeze({
      id: 'fresh-message',
      role: 'assistant' as const,
      text: exact,
      turn: 1,
    })
    const next = {
      ...original,
      thread: { ...original.thread, messages: [...original.thread.messages, fresh] },
    }
    const storage = { setItem: vi.fn() }

    expect(() => history.write([next], storage)).toThrow('private source binding')
    expect(storage.setItem).not.toHaveBeenCalled()
    expect(history.recoveryRow(original)).toBe(JSON.stringify(rawSession()))
  })

  it('allows frozen already owned occurrences that require no new symbol installation', () => {
    const history = open()
    const original = history.sessions[0]
    Object.freeze(original)
    Object.freeze(original.thread.messages[0])
    const prepared = history.prepare([original])
    const storage = { setItem: vi.fn() }

    expect(history.commitPrepared(prepared, storage)).toBe(prepared.views)
    expect(storage.setItem).toHaveBeenCalledExactlyOnceWith(STUDIO_HISTORY_KEY, prepared.encoded)
    expect(history.recoveryRow(original)).toBe(prepared.views[0].encodedRow)
  })

  it('validates raw archival descriptors before returning a cold recovery hash material', () => {
    const history = open()
    const session = history.sessions[0]
    const raw = history.projectSession(session)
    const getter = vi.fn(() => exact)
    Object.defineProperty(raw, 'hidden', { get: getter, enumerable: true })

    expect(() => history.recoveryRow(session)).toThrow('getters')
    expect(getter).not.toHaveBeenCalled()
  })

  it.each(['id', 'source token'])(
    'does not invoke a forged %s getter during raw-row ownership lookup',
    (kind) => {
      const history = open()
      const session = history.sessions[0]
      const getter = vi.fn(() => session.id)
      const key = kind === 'id' ? 'id' : Object.getOwnPropertySymbols(session)[0]
      Object.defineProperty(session, key, { get: getter, enumerable: true })

      expect(history.recoveryRow(session)).toBeUndefined()
      expect(getter).not.toHaveBeenCalled()
    },
  )

  it.each(['baseline id', 'binding baseline', 'binding owner', 'binding raw'])(
    'does not invoke an exposed %s getter while looking up acknowledged recovery bytes',
    (kind) => {
      const history = open()
      const session = history.sessions[0]
      const source = studioSourceOwner(session)!
      const binding = source.project([session]).views[0].projection.source!
      const getter = vi.fn()
      if (kind === 'baseline id')
        Object.defineProperty(binding.baseline, 'id', { get: getter, enumerable: true })
      else
        Object.defineProperty(binding, kind.slice('binding '.length), {
          get: getter,
          enumerable: true,
        })

      expect(history.recoveryRow(session)).toBeUndefined()
      expect(getter).not.toHaveBeenCalled()
    },
  )

  it('rejects paired session and baseline ID getters rather than admitting undefined identity', () => {
    const history = open()
    const session = history.sessions[0]
    const source = studioSourceOwner(session)!
    const binding = source.project([session]).views[0].projection.source!
    const getter = vi.fn(() => 'studio-one')
    Object.defineProperty(session, 'id', { get: getter, enumerable: true })
    Object.defineProperty(binding.baseline, 'id', { get: getter, enumerable: true })

    expect(history.recoveryRow(session)).toBeUndefined()
    expect(getter).not.toHaveBeenCalled()
  })

  it('publishes one immutable private proof only after the actual owned row bytes are requested', () => {
    const history = open()
    const session = history.sessions[0]
    expect(studioRecoveryCacheRow(session.thread)).toBeUndefined()
    const encodedRow = history.recoveryRow(session)!
    const proof = studioRecoveryCacheRow(session.thread)!

    expect(proof.encodedRow).toBe(encodedRow)
    expect(Object.isFrozen(proof)).toBe(true)
    expect(studioRecoveryCacheRow(session.thread)).toBe(proof)
    expect({ ...proof }).not.toBe(proof)
    expect(JSON.parse(JSON.stringify(proof))).not.toBe(proof)
    expect(studioRecoveryCacheRow({ ...session.thread })).toBeUndefined()
    expect(studioRecoveryCacheRow(JSON.parse(JSON.stringify(session.thread)))).toBeUndefined()
  })

  it('does not publish a private proof for an edited Thread clone with the same cached row', () => {
    const history = open()
    const session = history.sessions[0]
    const edited = { ...session, thread: { ...session.thread, title: 'edited before recovery' } }

    expect(history.recoveryRow(edited)).toBe(JSON.stringify(rawSession()))
    expect(studioRecoveryCacheRow(edited.thread)).toBeUndefined()
  })

  it('invalidates the published private proof when a decoded message changes in place', () => {
    const history = open()
    const session = history.sessions[0]
    const encodedRow = history.recoveryRow(session)!
    const proof = studioRecoveryCacheRow(session.thread)!
    session.thread.messages[0].text += exact

    expect(history.recoveryRow(session)).toBe(encodedRow)
    expect(studioRecoveryCacheRow(session.thread)).toBeUndefined()
    expect(proof.encodedRow).toBe(encodedRow)
  })

  it('invalidates a published private proof after an archival row edit', () => {
    const history = open()
    const session = history.sessions[0]
    history.recoveryRow(session)
    expect(studioRecoveryCacheRow(session.thread)).toBeDefined()
    history.projectSession(session).request = 'edited archival row'

    expect(studioRecoveryCacheRow(session.thread)).toBeUndefined()
    expect(history.recoveryRow(session)).toBe(JSON.stringify(rawSession()))
    expect(studioRecoveryCacheRow(session.thread)).toBeUndefined()
  })

  it('revokes the old private proof after another store owns the same Thread view', () => {
    const history = open()
    const session = history.sessions[0]
    history.recoveryRow(session)
    const previous = studioRecoveryCacheRow(session.thread)!
    const other = open([])
    const imported = { ...session }
    other.write([imported], { setItem: vi.fn() })

    expect(studioRecoveryCacheRow(session.thread)).toBeUndefined()
    expect(history.recoveryRow(session)).toBeUndefined()
    other.recoveryRow(imported)
    expect(studioRecoveryCacheRow(imported.thread)).toBeDefined()
    expect(studioRecoveryCacheRow(imported.thread)).not.toBe(previous)
  })

  it('publishes the committed exact-row proof and invalidates it on a later acknowledgment', () => {
    const history = open()
    const session = rename(history.sessions[0])
    const prepared = history.prepare([session])
    history.commitPrepared(prepared, { setItem: vi.fn() })
    expect(studioRecoveryCacheRow(session.thread)).toBeUndefined()
    history.recoveryRow(session)
    const proof = studioRecoveryCacheRow(session.thread)!
    expect(proof.encodedRow).toBe(prepared.views[0].encodedRow)
    history.write([rename(session, 'newer acknowledged view')], { setItem: vi.fn() })

    expect(studioRecoveryCacheRow(session.thread)).toBeUndefined()
    expect(proof.encodedRow).toBe(prepared.views[0].encodedRow)
  })
})
