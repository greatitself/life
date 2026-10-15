import { afterEach, describe, expect, it, vi } from 'vitest'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import type { ConversationCheckpointInput } from '../src/shared/conversations'
import { CONVERSATION_CHECKPOINT_BASE_CHANGED } from '../src/shared/conversations'
import {
  ConversationCheckpointClient,
  createConversationCheckpointProjector,
  createHistorySnapshotProjector,
} from '../src/renderer/conversation-checkpoint-client'
import type { Message, Thread } from '../src/renderer/state'
import { ConversationCheckpointEngine } from '../src/main/conversation-checkpoint-engine'
import { runEffect } from '../src/main/effect-runtime'

const directories: string[] = []
afterEach(async () => {
  await Promise.all(
    directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })),
  )
})

function thread(id = 'a', text = 'Exact output\r\n🙂'): Thread {
  return {
    id,
    profileId: 'machine',
    provider: 'codex',
    title: id,
    messages: [{ id: `${id}:reply`, role: 'assistant', text, turn: 1 }],
    pending: [],
    busy: false,
    turn: 1,
    updatedAt: 1,
    mode: 'review',
    model: '',
  }
}
function deferred() {
  let resolve!: () => void
  const promise = new Promise<void>((done) => {
    resolve = done
  })
  return { promise, resolve }
}

describe('incremental renderer checkpoint projection', () => {
  it('sends only a changed message and preserves exact identities and order', () => {
    const snapshot = createHistorySnapshotProjector()
    const project = createConversationCheckpointProjector()
    const original = thread()
    const unchanged = thread('b')
    const before = snapshot([original, unchanged])
    const nextMessage = { ...original.messages[0], text: 'New exact output\r\n  🙂  ' }
    const next = snapshot([{ ...original, messages: [nextMessage] }, unchanged])
    expect(next[1]).toBe(before[1])
    const delta = project(before, next, 10, 20)!
    expect(delta.order).toEqual(['a', 'b'])
    expect(delta.upserts).toHaveLength(1)
    expect(delta.upserts[0].thread).toEqual({ ...original, messages: undefined, pending: [] })
    expect(Object.hasOwn(delta.upserts[0].thread, 'messages')).toBe(false)
    expect(delta.upserts[0].messages).toEqual({ mode: 'patch', upserts: [nextMessage] })
    expect(original.messages[0].text).toBe('Exact output\r\n🙂')
  })

  it('expresses append, deletion, reordering, metadata removal, and ownership replacement', () => {
    const project = createConversationCheckpointProjector()
    const first = thread()
    const secondMessage: Message = { id: 'a:second', role: 'user', text: 'Exact prompt', turn: 2 }
    const extended = { ...first, title: 'Renamed', messages: [first.messages[0], secondMessage] }
    expect(project([first], [extended], 1, 2)!.upserts[0].messages).toEqual({
      mode: 'patch',
      order: ['a:reply', 'a:second'],
      upserts: [secondMessage],
    })
    const reordered = { ...extended, messages: [secondMessage, first.messages[0]] }
    expect(project([extended], [reordered], 2, 3)!.upserts[0].messages).toEqual({
      mode: 'patch',
      order: ['a:second', 'a:reply'],
      upserts: [],
    })
    const removed = { ...extended, messages: [secondMessage] }
    expect(project([extended], [removed], 2, 3)!.upserts[0].messages).toEqual({
      mode: 'patch',
      order: ['a:second'],
      upserts: [],
    })
    expect(project([extended], [], 2, 3)).toMatchObject({ order: [], upserts: [] })
    const changedOwner = { ...extended, profileId: 'other-machine' }
    expect(project([extended], [changedOwner], 2, 3)!.upserts[0].messages).toEqual({
      mode: 'replace',
      values: extended.messages,
    })
    const withOptional = { ...first, snoozedUntil: 100 }
    expect(
      Object.hasOwn(project([withOptional], [first], 1, 2)!.upserts[0].thread, 'snoozedUntil'),
    ).toBe(false)
  })

  it('never reads settled message bodies and retains full-save support for legacy identities', () => {
    const project = createConversationCheckpointProjector()
    const first = thread()
    Object.defineProperty(first.messages[0], 'text', {
      get: () => {
        throw new Error('Read historical body')
      },
    })
    const changed: Message = { id: 'a:reply', role: 'assistant', text: 'Current body', turn: 1 }
    expect(
      project([first], [{ ...first, messages: [changed] }], 1, 2)!.upserts[0].messages,
    ).toEqual({ mode: 'patch', upserts: [changed] })
    const duplicate = { ...first, messages: [changed, changed] }
    expect(project([first], [duplicate], 1, 2)!.upserts[0].messages).toEqual({
      mode: 'replace',
      values: duplicate.messages,
    })
    expect(project([thread('')], [thread('')], 1, 2)).toBeUndefined()
    expect(project([thread('a'), thread('a')], [thread('a')], 1, 2)).toBeUndefined()
  })

  it('sends sub-kilobyte normalization fields without serializing an 8 MiB body or reading settled bodies', () => {
    const project = createConversationCheckpointProjector()
    const largeText = 'x'.repeat(8 * 1024 * 1024)
    const current = { ...thread().messages[0], text: largeText, input: largeText }
    Reflect.deleteProperty(current, 'turn')
    Object.defineProperty(current, 'toJSON', {
      value: () => {
        throw new Error('Serialized unchanged body')
      },
    })
    const settled = { ...thread('settled').messages[0] }
    Object.defineProperty(settled, 'text', {
      get: () => {
        throw new Error('Read settled body')
      },
    })
    const before = { ...thread(), messages: [settled, current] }
    const normalized = { ...current, turn: 0, status: 'completed' }
    const serialize = vi.spyOn(JSON, 'stringify')
    const packet = project([before], [{ ...before, messages: [settled, normalized] }], 1, 2, {
      supportsMessageFields: true,
    })!
    expect(serialize).not.toHaveBeenCalled()
    serialize.mockRestore()
    expect(packet.upserts[0].messages).toEqual({
      mode: 'patch',
      upserts: [],
      fields: [{ id: current.id, set: { turn: 0, status: 'completed' }, remove: [] }],
    })
    expect(JSON.stringify(packet).length).toBeLessThan(1024)
  })

  it('patches existing message properties exactly and keeps additions as complete upserts', () => {
    const project = createConversationCheckpointProjector()
    const message = {
      ...thread().messages[0],
      status: 'running',
      futureField: 'delete this own property',
      nullableField: 'becomes null',
    }
    const before = { ...thread(), messages: [message] }
    const changed = { ...message, nullableField: null, turn: 2, status: undefined }
    Reflect.deleteProperty(changed, 'futureField')
    const added: Message = { id: 'new', role: 'user', text: '  Exact new prompt\r\n🧪  ', turn: 2 }
    const packet = project([before], [{ ...before, messages: [changed, added] }], 1, 2, {
      supportsMessageFields: true,
    })!
    expect(packet.upserts[0].messages).toEqual({
      mode: 'patch',
      order: [message.id, 'new'],
      upserts: [added],
      fields: [
        {
          id: message.id,
          set: { nullableField: null, turn: 2 },
          remove: ['status', 'futureField'],
        },
      ],
    })
  })

  it('compares changed nested properties with persisted JSON semantics and omits equal values', () => {
    const project = createConversationCheckpointProjector()
    const message = {
      ...thread().messages[0],
      future: { unchanged: true, removed: undefined, array: [undefined, 'exact'] },
      updated: { keep: true, changed: 'before' },
    }
    const before = { ...thread(), messages: [message] }
    const next = {
      ...message,
      future: { unchanged: true, array: [null, 'exact'] },
      updated: { keep: true, changed: 'after', omitted: undefined },
      status: undefined,
    }
    expect(
      project([before], [{ ...before, messages: [next] }], 1, 2, {
        supportsMessageFields: true,
      })!.upserts[0].messages,
    ).toEqual({
      mode: 'patch',
      upserts: [],
      fields: [{ id: message.id, set: { updated: next.updated }, remove: [] }],
    })
    const equal = { ...message, future: next.future, status: undefined }
    expect(
      project([before], [{ ...before, messages: [equal] }], 1, 2, {
        supportsMessageFields: true,
      })!.upserts[0].messages,
    ).toEqual({ mode: 'patch', upserts: [] })
  })

  it('retains own prototype-like JSON properties in field changes', () => {
    const project = createConversationCheckpointProjector()
    const message = Object.assign(
      { ...thread().messages[0] },
      JSON.parse('{"constructor":"old","prototype":"old"}'),
    ) as Message
    const changed = {
      ...message,
      ...JSON.parse('{"__proto__":{"kept":true},"constructor":"new","prototype":null}'),
    } as Message
    const before = { ...thread(), messages: [message] }
    const packet = project([before], [{ ...before, messages: [changed] }], 1, 2, {
      supportsMessageFields: true,
    })!
    const delta = packet.upserts[0].messages
    if (delta.mode !== 'patch') throw new Error('Expected message patch')
    const set = delta.fields![0].set
    expect(Object.getPrototypeOf(set)).toBe(Object.prototype)
    expect(Object.hasOwn(set, '__proto__')).toBe(true)
    expect(JSON.parse(JSON.stringify(set))).toEqual(
      JSON.parse('{"__proto__":{"kept":true},"constructor":"new","prototype":null}'),
    )
  })

  it('uses full upserts when a bridge does not advertise fields or a message identity is ambiguous', () => {
    const project = createConversationCheckpointProjector()
    const before = thread()
    const changed = { ...before.messages[0], status: 'completed' }
    const next = { ...before, messages: [changed] }
    for (const options of [undefined, {}, { supportsMessageFields: false }])
      expect(project([before], [next], 1, 2, options)!.upserts[0].messages).toEqual({
        mode: 'patch',
        upserts: [changed],
      })
    const duplicate = { ...before, messages: [changed, changed] }
    expect(
      project([before], [duplicate], 1, 2, { supportsMessageFields: true })!.upserts[0].messages,
    ).toEqual({ mode: 'replace', values: duplicate.messages })
  })
})

describe('acknowledged native checkpoint coordination', () => {
  it('gates fields by an explicit capability and keeps the durable baseline when the flag changes', async () => {
    const client = new ConversationCheckpointClient()
    const initial = [thread()]
    const save = vi.fn(async () => {})
    const checkpoint = vi.fn(async (input: ConversationCheckpointInput) => ({
      savedAt: input.savedAt,
    }))
    expect(
      client.adoptDurableBaseline(initial, 10, save, checkpoint, { supportsMessageFields: true }),
    ).toBe(true)
    const changed = [
      { ...initial[0], messages: [{ ...initial[0].messages[0], status: 'running' }] },
    ]
    await client.submit(changed, 11, save, checkpoint)
    expect(checkpoint.mock.calls[0][0].upserts[0].messages).toEqual({
      mode: 'patch',
      upserts: [],
      fields: [{ id: 'a:reply', set: { status: 'running' }, remove: [] }],
    })
    const completed = [
      { ...changed[0], messages: [{ ...changed[0].messages[0], status: 'completed' }] },
    ]
    await client.submit(completed, 12, save, checkpoint, { supportsMessageFields: false })
    expect(checkpoint.mock.calls[1][0].baseSavedAt).toBe(11)
    expect(checkpoint.mock.calls[1][0].upserts[0].messages).toEqual({
      mode: 'patch',
      upserts: completed[0].messages,
    })
    const edited = [
      { ...completed[0], messages: [{ ...completed[0].messages[0], text: 'Exact edit' }] },
    ]
    await client.submit(edited, 13, save, checkpoint, { supportsMessageFields: true })
    expect(checkpoint.mock.calls[2][0].baseSavedAt).toBe(12)
    expect(checkpoint.mock.calls[2][0].upserts[0].messages).toEqual({
      mode: 'patch',
      upserts: [],
      fields: [{ id: 'a:reply', set: { text: 'Exact edit' }, remove: [] }],
    })
    expect(save).not.toHaveBeenCalled()
    const newBridge = vi.fn(async () => {})
    await client.submit(edited, 14, newBridge, checkpoint)
    const last = [{ ...edited[0], messages: [{ ...edited[0].messages[0], status: 'failed' }] }]
    await client.submit(last, 15, newBridge, checkpoint)
    expect(newBridge).toHaveBeenCalledExactlyOnceWith(edited, 14)
    expect(checkpoint.mock.calls[3][0].upserts[0].messages).toEqual({
      mode: 'patch',
      upserts: last[0].messages,
    })
  })

  it('adopts already durable history and checkpoints unchanged or edited state without reading settled bodies', async () => {
    const client = new ConversationCheckpointClient()
    const initial = [thread()]
    Object.defineProperty(initial[0].messages[0], 'text', {
      get: () => {
        throw new Error('Read historical body')
      },
    })
    const save = vi.fn(async () => {})
    const checkpoint = vi.fn(async (input: ConversationCheckpointInput) => ({
      savedAt: input.savedAt,
    }))
    expect(client.adoptDurableBaseline(initial, 10, save, checkpoint)).toBe(true)
    expect(await client.submit(initial, 11, save, checkpoint)).toBe(11)
    expect(save).not.toHaveBeenCalled()
    expect(checkpoint).toHaveBeenLastCalledWith({
      version: 1,
      baseSavedAt: 10,
      savedAt: 11,
      order: ['a'],
      upserts: [],
    })
    expect(JSON.stringify(checkpoint.mock.calls[0][0]).length).toBeLessThan(150)
    const renamed = { ...initial[0], title: 'Renamed' }
    await client.submit([renamed], 12, save, checkpoint)
    expect(checkpoint).toHaveBeenLastCalledWith(
      expect.objectContaining({
        baseSavedAt: 11,
        upserts: [
          expect.objectContaining({
            thread: expect.objectContaining({ title: 'Renamed' }),
            messages: { mode: 'patch', upserts: [] },
          }),
        ],
      }),
    )
    const edited = {
      ...renamed,
      messages: [{ ...thread().messages[0], text: 'Exact edit\r\n  Ω  ' }],
    }
    await client.submit([edited], 13, save, checkpoint)
    expect(checkpoint.mock.calls[2][0].upserts[0].messages).toEqual({
      mode: 'patch',
      upserts: edited.messages,
    })
    expect(save).not.toHaveBeenCalled()
  })

  it('refuses reseeding while a checkpoint is in flight or newer history is queued', async () => {
    const client = new ConversationCheckpointClient()
    const initial = [thread()]
    const release = deferred()
    const save = vi.fn(async () => {})
    const checkpoint = vi.fn(async (input: ConversationCheckpointInput) => {
      await release.promise
      return { savedAt: input.savedAt }
    })
    expect(client.adoptDurableBaseline(initial, 10, save, checkpoint)).toBe(true)
    const first = client.submit(initial, 11, save, checkpoint)
    expect(client.adoptDurableBaseline([thread('other')], 999, save, checkpoint)).toBe(false)
    const intermediate = client.submit([thread('a', 'Intermediate')], 12, save, checkpoint)
    const latest = [thread('a', 'Latest exact content')]
    const final = client.submit(latest, 13, save, checkpoint)
    expect(client.adoptDurableBaseline([thread('other')], 999, save, checkpoint)).toBe(false)
    release.resolve()
    expect(await Promise.all([first, intermediate, final])).toEqual([11, 13, 13])
    expect(checkpoint).toHaveBeenCalledTimes(2)
    expect(checkpoint.mock.calls[1][0]).toMatchObject({
      baseSavedAt: 11,
      savedAt: 13,
      order: ['a'],
    })
    expect(checkpoint.mock.calls[1][0].upserts[0].messages).toEqual({
      mode: 'patch',
      upserts: latest[0].messages,
    })
    expect(save).not.toHaveBeenCalled()
  })

  it('refuses invalid durable identities and timestamps, retaining the complete save path', async () => {
    const invalid = [
      [thread('')],
      [thread('a'), thread('a')],
      [{ ...thread(), id: 123 as unknown as string }],
    ]
    for (const history of invalid) {
      const client = new ConversationCheckpointClient()
      const save = vi.fn(async () => {})
      const checkpoint = vi.fn(async (input: ConversationCheckpointInput) => ({
        savedAt: input.savedAt,
      }))
      expect(client.adoptDurableBaseline(history, 10, save, checkpoint)).toBe(false)
      await client.submit(history, 11, save, checkpoint)
      expect(save).toHaveBeenCalledExactlyOnceWith(history, 11)
      expect(checkpoint).not.toHaveBeenCalled()
    }
    for (const savedAt of [-1, 1.5, NaN, Infinity, Number.MAX_SAFE_INTEGER + 1]) {
      const client = new ConversationCheckpointClient()
      const save = vi.fn(async () => {})
      const checkpoint = vi.fn(async (input: ConversationCheckpointInput) => ({
        savedAt: input.savedAt,
      }))
      expect(client.adoptDurableBaseline([thread()], savedAt, save, checkpoint)).toBe(false)
      await client.submit([thread()], 11, save, checkpoint)
      expect(save).toHaveBeenCalledTimes(1)
      expect(checkpoint).not.toHaveBeenCalled()
    }
  })

  it('resynchronizes an adopted baseline when the durable base or native bridge changes', async () => {
    const client = new ConversationCheckpointClient()
    const initial = [thread()]
    const save = vi.fn(async () => {})
    const checkpoint = vi.fn(async (input: ConversationCheckpointInput) => ({
      savedAt: input.savedAt,
    }))
    expect(client.adoptDurableBaseline(initial, 10, save, checkpoint)).toBe(true)
    checkpoint.mockRejectedValueOnce(new Error(CONVERSATION_CHECKPOINT_BASE_CHANGED))
    const changed = [thread('a', 'New exact state')]
    await client.submit(changed, 11, save, checkpoint)
    expect(save).toHaveBeenCalledExactlyOnceWith(changed, 11)
    const newBridge = vi.fn(async () => {})
    await client.submit(changed, 12, newBridge, checkpoint)
    expect(newBridge).toHaveBeenCalledExactlyOnceWith(changed, 12)
    expect(checkpoint).toHaveBeenCalledTimes(1)
    await client.submit(changed, 13, newBridge, checkpoint)
    expect(checkpoint).toHaveBeenLastCalledWith(expect.objectContaining({ baseSavedAt: 12 }))
    const newCheckpoint = vi.fn(async (input: ConversationCheckpointInput) => ({
      savedAt: input.savedAt,
    }))
    await client.submit(changed, 14, newBridge, newCheckpoint)
    expect(newBridge).toHaveBeenLastCalledWith(changed, 14)
    expect(newCheckpoint).not.toHaveBeenCalled()
  })

  it('bounds backlog to the newest snapshot and derives its delta only from the acknowledged base', async () => {
    const client = new ConversationCheckpointClient()
    const release = deferred()
    const initial = [thread()]
    const save = vi.fn(async () => {
      await release.promise
    })
    const checkpoint = vi.fn(async (input: ConversationCheckpointInput) => ({
      savedAt: input.savedAt,
    }))
    const first = client.submit(initial, 1, save, checkpoint)
    const intermediate = client.submit([thread('a', 'Intermediate')], 2, save, checkpoint)
    const latestHistory = [thread('a', 'Latest exact text')]
    const latest = client.submit(latestHistory, 3, save, checkpoint)
    expect(save).toHaveBeenCalledExactlyOnceWith(initial, 1)
    expect(checkpoint).not.toHaveBeenCalled()
    release.resolve()
    expect(await Promise.all([first, intermediate, latest])).toEqual([1, 3, 3])
    expect(checkpoint).toHaveBeenCalledTimes(1)
    expect(checkpoint.mock.calls[0][0]).toMatchObject({ baseSavedAt: 1, savedAt: 3 })
    expect(checkpoint.mock.calls[0][0].upserts[0].messages).toEqual({
      mode: 'patch',
      upserts: latestHistory[0].messages,
    })
  })

  it('keeps reentrant submissions when a completed drain is releasing its ownership', async () => {
    const client = new ConversationCheckpointClient()
    const save = vi.fn(async () => {})
    const checkpoint = vi.fn(async (input: ConversationCheckpointInput) => ({
      savedAt: input.savedAt,
    }))
    const result = client.submit([thread()], 1, save, checkpoint).then(() => {
      expect(client.adoptDurableBaseline([thread('unrelated')], 999, save, checkpoint)).toBe(false)
      return client.submit([thread('a', 'Second')], 2, save, checkpoint)
    })
    expect(await result).toBe(2)
    expect(checkpoint).toHaveBeenCalledTimes(1)
    expect(checkpoint).toHaveBeenLastCalledWith(expect.objectContaining({ baseSavedAt: 1 }))
  })

  it('does not advance a failed base, retries completely, and safely resynchronizes a changed native base', async () => {
    const client = new ConversationCheckpointClient()
    const save = vi.fn(async () => {})
    const checkpoint = vi.fn(async (input: ConversationCheckpointInput) => ({
      savedAt: input.savedAt,
    }))
    await client.submit([thread()], 1, save, checkpoint)
    const failure = new Error('Disk full')
    checkpoint.mockRejectedValueOnce(failure)
    await expect(client.submit([thread('a', 'Failed')], 2, save, checkpoint)).rejects.toBe(failure)
    const retry = [thread('a', 'Recovered exact text')]
    await client.submit(retry, 3, save, checkpoint)
    expect(save).toHaveBeenLastCalledWith(retry, 3)
    checkpoint.mockRejectedValueOnce(
      new Error(`${CONVERSATION_CHECKPOINT_BASE_CHANGED}: saved history changed`),
    )
    const resync = [thread('a', 'Resynchronized')]
    await client.submit(resync, 4, save, checkpoint)
    expect(save).toHaveBeenLastCalledWith(resync, 4)
    await client.submit([thread('a', 'Next')], 5, save, checkpoint)
    expect(checkpoint).toHaveBeenLastCalledWith(expect.objectContaining({ baseSavedAt: 4 }))
  })

  it('rejects unexpected acknowledgements and establishes a fresh base when the native bridge changes', async () => {
    const client = new ConversationCheckpointClient()
    const save = vi.fn(async () => {})
    const checkpoint = vi.fn(async (_input: ConversationCheckpointInput) => ({ savedAt: 999 }))
    await client.submit([thread()], 1, save, checkpoint)
    await expect(client.submit([thread('a', 'Next')], 2, save, checkpoint)).rejects.toThrow(
      'acknowledgement changed',
    )
    const newBridge = vi.fn(async () => {})
    await client.submit([thread('a', 'New bridge')], 3, newBridge, checkpoint)
    expect(newBridge).toHaveBeenCalledTimes(1)
    expect(checkpoint).toHaveBeenCalledTimes(1)
  })

  it('round-trips exact complete history through the actual atomic engine, including deliberate deletion', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'life-checkpoint-client-'))
    directories.push(directory)
    const engine = new ConversationCheckpointEngine(directory)
    const client = new ConversationCheckpointClient()
    const save = async (history: unknown[], savedAt?: number) => {
      await runEffect(engine.saveEffect(history, savedAt!))
    }
    const checkpoint = (input: ConversationCheckpointInput) =>
      runEffect(engine.checkpointEffect(input))
    const initial = [thread('a'), thread('b')]
    await client.submit(initial, 1, save, checkpoint)
    const additional: Message = {
      id: 'a:follow-up',
      role: 'user',
      text: '  Exact prompt\r\n🙂  ',
      turn: 2,
    }
    const final = [
      {
        ...initial[0],
        title: 'Changed',
        messages: [additional, { ...initial[0].messages[0], text: 'Complete result\r\n  🙂  ' }],
      },
    ]
    await client.submit(final, 2, save, checkpoint)
    expect(await runEffect(engine.loadEffect())).toEqual({ version: 1, savedAt: 2, threads: final })
    expect(JSON.parse(await readFile(join(directory, 'conversations.json'), 'utf8'))).toEqual({
      version: 1,
      savedAt: 2,
      threads: final,
    })
  })

  it('adopts an actual durable engine load, applies exact edits, and recovers an external replacement', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'life-checkpoint-adoption-'))
    directories.push(directory)
    const engine = new ConversationCheckpointEngine(directory)
    const save = vi.fn(async (history: unknown[], savedAt?: number) => {
      await runEffect(engine.saveEffect(history, savedAt!))
    })
    const checkpoint = vi.fn((input: ConversationCheckpointInput) =>
      runEffect(engine.checkpointEffect(input)),
    )
    await runEffect(engine.saveEffect([thread('a'), thread('b')], 10))
    const loaded = (await runEffect(engine.loadEffect()))!
    const history = loaded.threads as Thread[]
    const client = new ConversationCheckpointClient()
    expect(client.adoptDurableBaseline(history, loaded.savedAt, save, checkpoint)).toBe(true)
    await client.submit(history, 11, save, checkpoint)
    expect(save).not.toHaveBeenCalled()
    expect(checkpoint.mock.calls[0][0].upserts).toEqual([])
    const changed = [
      {
        ...history[0],
        title: 'Native identity preserved',
        messages: [{ ...history[0].messages[0], text: '  Exact edited output\r\n🙂  ' }],
      },
    ]
    await client.submit(changed, 12, save, checkpoint)
    expect(await runEffect(engine.loadEffect())).toEqual({
      version: 1,
      savedAt: 12,
      threads: changed,
    })
    await runEffect(engine.saveEffect([thread('external')], 13))
    await client.submit(changed, 14, save, checkpoint)
    expect(save).toHaveBeenCalledExactlyOnceWith(changed, 14)
    expect(await runEffect(engine.loadEffect())).toEqual({
      version: 1,
      savedAt: 14,
      threads: changed,
    })
  })
})
