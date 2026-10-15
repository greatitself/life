import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  CONVERSATION_HISTORY_KEY,
  ConversationHistoryPersistence,
  readCachedConversationHistory,
  reconcileConversationHistory,
} from '../src/renderer/conversation-persistence'
import { readThreads, type Thread } from '../src/renderer/state'
import { projectConversationSource } from '../src/renderer/conversation-source'
import { ConversationCheckpointEngine } from '../src/main/conversation-checkpoint-engine'
import { runEffect } from '../src/main/effect-runtime'
import type { ConversationCheckpointInput } from '../src/shared/conversations'

function thread(id = 'thread', updatedAt = 100, text = 'Exact content\n  kept  \n'): Thread {
  return {
    id,
    profileId: 'machine',
    provider: 'codex',
    messages: [{ id: `${id}-message`, role: 'assistant', text, turn: 1 }],
    title: 'Thread',
    busy: false,
    model: '',
    mode: 'review',
    updatedAt,
    turn: 1,
    pending: [],
  }
}
function storage() {
  const values = new Map<string, string>()
  return {
    getItem: vi.fn((key: string) => values.get(key) || null),
    setItem: vi.fn((key: string, value: string) => void values.set(key, value)),
    values,
  }
}
function context(
  native = true,
  incremental = false,
  supportsMessageFields = false,
  supportsMessageAppends = false,
) {
  let threads = [thread()]
  let enabled = true
  const cache = storage()
  const save = vi.fn(async (_history: unknown[], _savedAt?: number) => {})
  const checkpoint = vi.fn(async (input: ConversationCheckpointInput) => ({
    savedAt: input.savedAt,
  }))
  const onError = vi.fn()
  const persistence = new ConversationHistoryPersistence({
    getThreads: () => threads,
    getStorage: () => cache,
    getNativeSave: () => (native ? save : undefined),
    getNativeCheckpoint: () => (native && incremental ? checkpoint : undefined),
    supportsMessageFields: () => supportsMessageFields,
    supportsMessageAppends: () => supportsMessageAppends,
    onError,
    enabled: () => enabled,
  })
  return {
    cache,
    save,
    checkpoint,
    onError,
    persistence,
    change: (value: Thread[]) => (threads = value),
    enable: (value: boolean) => (enabled = value),
    capabilities: (fields: boolean, appends: boolean) => {
      supportsMessageFields = fields
      supportsMessageAppends = appends
    },
  }
}

type RawThread = Record<string, unknown> & {
  id: string
  profileId: string
  provider: 'codex' | 'claude'
  messages: unknown[]
}
const exactRecoveryText = '  Exact prompt\r\n\tUnicode café e\u0301 漢字 🧪 👩🏽‍💻  \n'
const checkpointDirectories: string[] = []

function rawThread(id = 'thread', messages: unknown[] = []): RawThread {
  return {
    ...thread(id),
    messages,
    remoteId: `native-session-${id}`,
    workspace: '/owned/project',
    futureThreadField: { retained: exactRecoveryText, values: [null, 17, true] },
  }
}

function recoverableRawThread(): RawThread {
  return {
    ...rawThread('thread', [
      {
        id: 'known',
        role: 'tool',
        text: exactRecoveryText,
        input: exactRecoveryText,
        status: 'running',
        futureMessageField: { retained: exactRecoveryText },
      },
      { id: 'opaque', role: 'system', text: exactRecoveryText, futureRole: true },
      { id: 'future', futureMessageField: { exactRecoveryText } },
    ]),
    title: '   ',
    busy: true,
    turnStatus: 'running',
    pending: [{ type: 'approval', sessionId: 'thread', requestId: 'native-request' }],
    queue: [{ id: 'queued', text: exactRecoveryText, createdAt: 50, attachments: [] }],
  }
}

async function durableContext(
  raw: RawThread[],
  supportsMessageFields = true,
  incremental = true,
  supportsMessageAppends = false,
) {
  const directory = await mkdtemp(join(tmpdir(), 'life-persistence-recovery-'))
  checkpointDirectories.push(directory)
  const original = {
    version: 1,
    savedAt: 500,
    futureEnvelope: { retained: exactRecoveryText },
    threads: raw,
  }
  await writeFile(join(directory, 'conversations.json'), JSON.stringify(original))
  const engine = new ConversationCheckpointEngine(directory)
  const c = context(true, incremental, supportsMessageFields, supportsMessageAppends)
  c.save.mockImplementation(async (history, savedAt) => {
    await runEffect(engine.saveEffect(history, savedAt!))
  })
  c.checkpoint.mockImplementation((input) => runEffect(engine.checkpointEffect(input)))
  const loaded = readThreads(raw)
  c.change(loaded)
  return {
    ...c,
    loaded,
    raw,
    original,
    engine,
    disk: async () => JSON.parse(await readFile(join(directory, 'conversations.json'), 'utf8')),
    reload: () => runEffect(new ConversationCheckpointEngine(directory).loadEffect()),
  }
}

beforeEach(() => {
  vi.useFakeTimers()
  vi.setSystemTime(10_000)
})
afterEach(() => vi.useRealTimers())
afterEach(async () => {
  await Promise.all(
    checkpointDirectories
      .splice(0)
      .map((directory) => rm(directory, { recursive: true, force: true })),
  )
})

describe('bounded conversation history persistence', () => {
  it('adopts trusted native hydration and sends a small first checkpoint without serializing settled history', async () => {
    const c = context(true, true)
    c.enable(false)
    const loaded = [thread('large', 200)]
    Object.defineProperty(loaded[0].messages[0], 'text', {
      get: () => {
        throw new Error('Read historical body')
      },
    })
    const stringify = vi.spyOn(JSON, 'stringify')
    expect(c.persistence.adoptNativeCheckpoint(loaded, 50_000)).toBe(true)
    c.change(loaded)
    c.enable(true)
    c.persistence.schedule()
    await vi.advanceTimersByTimeAsync(600)
    expect(c.save).not.toHaveBeenCalled()
    expect(c.checkpoint).toHaveBeenCalledExactlyOnceWith({
      version: 1,
      baseSavedAt: 50_000,
      savedAt: 50_001,
      order: ['large'],
      upserts: [],
    })
    expect(stringify).not.toHaveBeenCalled()
    stringify.mockRestore()
    expect(JSON.stringify(c.checkpoint.mock.calls[0][0]).length).toBeLessThan(150)
    expect(c.cache.getItem).not.toHaveBeenCalled()
    expect(c.cache.setItem).not.toHaveBeenCalled()
    expect(c.onError).not.toHaveBeenCalled()
  })

  it('patches edits selected after native hydration against the actual durable baseline', async () => {
    const c = context(true, true)
    const loaded = [thread()]
    expect(c.persistence.adoptNativeCheckpoint(loaded, 500)).toBe(true)
    const renamed = [{ ...loaded[0], title: 'Recovered title', workspace: '/resolved/project' }]
    c.change(renamed)
    expect(await c.persistence.flush()).toBe(true)
    expect(c.checkpoint.mock.calls[0][0]).toMatchObject({
      baseSavedAt: 500,
      upserts: [
        {
          thread: { title: 'Recovered title', workspace: '/resolved/project', pending: [] },
          messages: { mode: 'patch', upserts: [] },
        },
      ],
    })
    const recovered = [
      {
        ...renamed[0],
        messages: [{ ...renamed[0].messages[0], text: 'Current cache content\r\n  Ω  ' }],
      },
    ]
    c.change(recovered)
    expect(await c.persistence.flush()).toBe(true)
    expect(c.checkpoint.mock.calls[1][0]).toMatchObject({
      baseSavedAt: 10_000,
      upserts: [{ messages: { mode: 'patch', upserts: recovered[0].messages } }],
    })
    expect(c.save).not.toHaveBeenCalled()
  })

  it('refuses native adoption during queued writes without moving the checkpoint clock', async () => {
    const c = context(true, true)
    const loaded = [thread()]
    expect(c.persistence.adoptNativeCheckpoint(loaded, 500)).toBe(true)
    let release!: (ack: { savedAt: number }) => void
    c.checkpoint.mockImplementationOnce(() => new Promise((resolve) => (release = resolve)))
    c.change(loaded)
    const older = c.persistence.flush()
    expect(c.persistence.adoptNativeCheckpoint([thread('unrelated')], 99_999)).toBe(false)
    const newer = [thread('thread', 300, 'Current queued history')]
    c.change(newer)
    const latest = c.persistence.flush()
    expect(c.persistence.adoptNativeCheckpoint([thread('unrelated')], 99_999)).toBe(false)
    release({ savedAt: 10_000 })
    expect(await Promise.all([older, latest])).toEqual([true, true])
    expect(c.checkpoint.mock.calls[1][0]).toMatchObject({
      baseSavedAt: 10_000,
      savedAt: 10_001,
      order: ['thread'],
      upserts: [{ messages: { mode: 'patch', upserts: newer[0].messages } }],
    })
    expect(c.save).not.toHaveBeenCalled()
  })

  it('requires a native checkpoint bridge and valid identities, while accepting an empty durable store', async () => {
    const local = context(false)
    expect(local.persistence.adoptNativeCheckpoint([thread()], 50_000)).toBe(false)
    const fullSaveOnly = context(true)
    expect(fullSaveOnly.persistence.adoptNativeCheckpoint([thread()], 50_000)).toBe(false)
    expect(await fullSaveOnly.persistence.flush()).toBe(true)
    expect(fullSaveOnly.save).toHaveBeenCalledWith(expect.any(Array), 10_000)
    const c = context(true, true)
    expect(
      c.persistence.adoptNativeCheckpoint([thread('duplicate'), thread('duplicate')], 50_000),
    ).toBe(false)
    expect(c.persistence.adoptNativeCheckpoint([thread()], -1)).toBe(false)
    expect(c.persistence.adoptNativeCheckpoint([], 500)).toBe(true)
    c.change([])
    expect(await c.persistence.flush()).toBe(true)
    expect(c.checkpoint).toHaveBeenCalledExactlyOnceWith({
      version: 1,
      baseSavedAt: 500,
      savedAt: 10_000,
      order: [],
      upserts: [],
    })
    expect(c.save).not.toHaveBeenCalled()
  })

  it('uses acknowledged compact checkpoints and excludes live approval requests', async () => {
    const c = context(true, true)
    const first = thread()
    c.change([first])
    expect(await c.persistence.flush()).toBe(true)
    const next = {
      ...first,
      updatedAt: 200,
      pending: [
        { type: 'approval', sessionId: 'thread', requestId: 'approval' },
      ] as Thread['pending'],
      messages: [{ ...first.messages[0], text: 'Exact next\r\n  Ω 👩🏽‍💻\n' }],
    }
    c.change([next])
    expect(await c.persistence.flush()).toBe(true)
    expect(c.save).toHaveBeenCalledTimes(1)
    expect(c.checkpoint).toHaveBeenCalledTimes(1)
    expect(c.checkpoint.mock.calls[0][0]).toMatchObject({
      baseSavedAt: 10_000,
      savedAt: 10_001,
      order: ['thread'],
      upserts: [
        {
          thread: { id: 'thread', pending: [] },
          messages: { mode: 'patch', upserts: next.messages },
        },
      ],
    })
    expect(c.cache.setItem).not.toHaveBeenCalled()
    expect(next.pending).toHaveLength(1)
  })

  it('retains exact browser recovery after a failed delta and retries a complete snapshot', async () => {
    const c = context(true, true)
    await c.persistence.flush()
    const changed = [thread('thread', 200, 'Untrimmed\r\n  exact Ω\n')]
    c.change(changed)
    c.checkpoint.mockRejectedValueOnce(new Error('disk full'))
    expect(await c.persistence.flush()).toBe(true)
    expect(JSON.parse(c.cache.values.get(CONVERSATION_HISTORY_KEY)!)).toEqual(changed)
    expect(readCachedConversationHistory(c.cache).threads[0].messages[0].text).toBe(
      changed[0].messages[0].text,
    )
    expect(c.onError).toHaveBeenCalledTimes(1)
    expect(await c.persistence.flush()).toBe(true)
    expect(c.save).toHaveBeenCalledTimes(2)
    expect(c.save.mock.calls[1][0]).toEqual(changed)
    expect(c.checkpoint).toHaveBeenCalledTimes(1)
  })

  it('awaits coalesced latest history and deletion before acknowledging final flushes', async () => {
    const c = context(true, true)
    await c.persistence.flush()
    let release!: (ack: { savedAt: number }) => void
    c.checkpoint.mockImplementationOnce(() => new Promise((resolve) => (release = resolve)))
    c.change([thread('thread', 200, 'In flight')])
    const older = c.persistence.flush()
    c.change([thread('thread', 300, 'Superseded')])
    const superseded = c.persistence.flush()
    const deleted: Thread[] = []
    c.change(deleted)
    const deletion = c.persistence.flush(deleted)
    let completed = false
    void deletion.then(() => (completed = true))
    expect(c.checkpoint).toHaveBeenCalledTimes(1)
    expect(completed).toBe(false)
    release({ savedAt: 10_001 })
    expect(await Promise.all([older, superseded, deletion])).toEqual([true, true, true])
    expect(c.checkpoint).toHaveBeenCalledTimes(2)
    expect(c.checkpoint.mock.calls[1][0]).toEqual({
      version: 1,
      baseSavedAt: 10_001,
      savedAt: 10_003,
      order: [],
      upserts: [],
    })
    expect(c.cache.setItem).not.toHaveBeenCalled()
    expect(await c.persistence.flush()).toBe(true)
    expect(c.checkpoint).toHaveBeenCalledTimes(2)
  })

  it('does not write until native hydration has completed', async () => {
    const c = context()
    c.enable(false)
    c.persistence.schedule()
    await c.persistence.flush()
    await vi.advanceTimersByTimeAsync(5_000)
    expect(c.save).not.toHaveBeenCalled()
    expect(c.cache.setItem).not.toHaveBeenCalled()
    c.enable(true)
    c.persistence.schedule()
    await vi.advanceTimersByTimeAsync(600)
    expect(c.save).toHaveBeenCalledTimes(1)
  })

  it('debounces a burst but saves every two seconds during uninterrupted token streaming', async () => {
    const c = context()
    for (let index = 0; index < 39; index++) {
      c.change([thread('thread', 100 + index, `token ${index}`)])
      c.persistence.schedule()
      await vi.advanceTimersByTimeAsync(50)
    }
    expect(c.save).not.toHaveBeenCalled()
    c.change([thread('thread', 139, 'token 39')])
    c.persistence.schedule()
    await vi.advanceTimersByTimeAsync(50)
    expect(c.save).toHaveBeenCalledTimes(1)
    expect((c.save.mock.calls[0][0][0] as Thread).messages[0].text).toBe('token 39')
    for (let index = 40; index < 80; index++) {
      c.change([thread('thread', 100 + index, `token ${index}`)])
      c.persistence.schedule()
      await vi.advanceTimersByTimeAsync(50)
    }
    expect(c.save).toHaveBeenCalledTimes(2)
    await vi.advanceTimersByTimeAsync(1_000)
    expect(c.save).toHaveBeenCalledTimes(2)
  })

  it('saves exact large history natively without serializing or accessing the browser cache', async () => {
    const c = context()
    const large = [thread('large', 200, 'Response content '.repeat(3_000_000))]
    c.change(large)
    c.cache.getItem.mockImplementation(() => {
      throw new Error('browser cache unavailable')
    })
    const stringify = vi.spyOn(JSON, 'stringify')
    expect(await c.persistence.flush()).toBe(true)
    expect(stringify).not.toHaveBeenCalled()
    stringify.mockRestore()
    expect(c.save).toHaveBeenCalledTimes(1)
    expect(c.save.mock.calls[0][0]).toEqual(large)
    expect(c.cache.getItem).not.toHaveBeenCalled()
    expect(c.cache.setItem).not.toHaveBeenCalled()
    expect(c.onError).not.toHaveBeenCalled()
  })

  it('deduplicates repeated native failure feedback and retries while the exact fallback remains durable', async () => {
    const c = context()
    c.save.mockRejectedValue(new Error('disk full'))
    expect(await c.persistence.flush()).toBe(true)
    expect(c.onError).toHaveBeenCalledWith(
      'Conversation history is kept in the local cache, but the disk checkpoint failed. disk full',
    )
    c.change([thread('thread', 200)])
    await c.persistence.flush()
    expect(c.save).toHaveBeenCalledTimes(2)
    expect(c.onError).toHaveBeenCalledTimes(1)
  })

  it('keeps the cache after a failed native save and retries the same snapshot on a final flush', async () => {
    const c = context()
    c.save.mockRejectedValueOnce(new Error('disk full'))
    expect(await c.persistence.flush()).toBe(true)
    expect(c.onError).toHaveBeenCalledWith(
      'Conversation history is kept in the local cache, but the disk checkpoint failed. disk full',
    )
    expect(readCachedConversationHistory(c.cache).threads[0].messages[0].text).toBe(
      'Exact content\n  kept  \n',
    )
    await c.persistence.flush()
    expect(c.save).toHaveBeenCalledTimes(2)
  })

  it('checkpoints an explicit deletion before React commits the replacement thread state', async () => {
    const c = context()
    const retained = [thread('retained', 300)]
    let release!: () => void
    c.save.mockImplementationOnce(() => new Promise<void>((resolve) => (release = resolve)))
    let acknowledged = false
    const flush = c.persistence.flush(retained).then((saved) => (acknowledged = saved))
    expect(c.save.mock.calls[0][0]).toEqual(retained)
    expect(c.cache.setItem).not.toHaveBeenCalled()
    expect(acknowledged).toBe(false)
    release()
    await flush
    expect(acknowledged).toBe(true)
    c.change(retained)
    expect(await c.persistence.flush()).toBe(true)
    expect(c.save).toHaveBeenCalledTimes(1)
  })

  it('does not acknowledge attachment cleanup when neither storage destination accepts the deletion', async () => {
    const c = context()
    c.cache.setItem.mockImplementation(() => {
      throw new Error('quota exceeded')
    })
    c.save.mockRejectedValueOnce(new Error('disk full'))
    const deletion: Thread[] = []
    expect(await c.persistence.flush(deletion)).toBe(false)
    expect(c.onError).toHaveBeenCalledWith(
      'Conversation history could not be saved to disk or the local cache. Keep this window open. disk full',
    )
    // A later final checkpoint retries the same snapshot, rather than treating
    // a failed attempt as saved and allowing referenced attachments to disappear.
    expect(await c.persistence.flush(deletion)).toBe(true)
    expect(c.save).toHaveBeenCalledTimes(2)
    expect(c.save.mock.calls[1][0]).toEqual([])
  })

  it('flushes the latest thread reference immediately, excludes approval requests, and awaits in-flight disk work', async () => {
    const c = context()
    let release!: () => void
    c.save.mockImplementationOnce(() => new Promise<void>((resolve) => (release = resolve)))
    const current = thread('latest', 300)
    current.pending = [{ type: 'approval', sessionId: 'latest', requestId: 'request' }]
    c.change([current])
    c.persistence.schedule()
    let completed = false
    const flush = c.persistence.flush().then(() => (completed = true))
    expect(c.save.mock.calls[0][0]).toEqual([{ ...current, pending: [] }])
    expect(completed).toBe(false)
    release()
    await flush
    await vi.advanceTimersByTimeAsync(5_000)
    expect(c.save).toHaveBeenCalledTimes(1)
  })

  it('recognizes a matching cache checkpoint and ignores metadata from a partial cache write', async () => {
    const c = context(false)
    await c.persistence.flush()
    expect(readCachedConversationHistory(c.cache).savedAt).toBe(10_000)
    c.cache.setItem(CONVERSATION_HISTORY_KEY, JSON.stringify([thread('changed', 200)]))
    expect(readCachedConversationHistory(c.cache).savedAt).toBeUndefined()
    c.persistence.advanceClock(50_000)
    c.change([thread('newer', 300)])
    await c.persistence.flush()
    expect(readCachedConversationHistory(c.cache).savedAt).toBe(50_001)
  })

  it('keeps valid cached messages when only the optional checkpoint marker is damaged', async () => {
    const c = context(false)
    await c.persistence.flush()
    c.cache.setItem('life.conversation-checkpoint.v1', '{ damaged marker')
    const recovered = readCachedConversationHistory(c.cache)
    expect(recovered.threads[0].messages[0].text).toBe('Exact content\n  kept  \n')
    expect(recovered.savedAt).toBeUndefined()
  })

  it('preserves an unreadable original cache while continuing to checkpoint new history to disk', async () => {
    const c = context()
    c.cache.setItem(CONVERSATION_HISTORY_KEY, '{ original damaged history')
    await c.persistence.flush()
    expect(c.save).toHaveBeenCalledTimes(1)
    expect(c.cache.getItem(CONVERSATION_HISTORY_KEY)).toBe('{ original damaged history')
    expect(c.onError).not.toHaveBeenCalled()
  })

  it('preserves an unreadable original cache when a native failure requires fallback storage', async () => {
    const c = context()
    c.cache.setItem(CONVERSATION_HISTORY_KEY, '{ original damaged history')
    c.save.mockRejectedValue(new Error('disk full'))
    expect(await c.persistence.flush()).toBe(false)
    expect(c.cache.getItem(CONVERSATION_HISTORY_KEY)).toBe('{ original damaged history')
    expect(c.onError).toHaveBeenCalledWith(
      'Conversation history could not be saved to disk or the local cache. Keep this window open. disk full',
    )
  })

  it('never replaces a newer fallback with an older out-of-order native failure', async () => {
    const c = context()
    let rejectOlder!: (error: Error) => void
    c.save.mockImplementationOnce(
      () => new Promise<void>((_resolve, reject) => (rejectOlder = reject)),
    )
    const older = c.persistence.flush()
    c.change([thread('newer', 300, 'Newest exact fallback')])
    c.save.mockRejectedValueOnce(new Error('newer disk failure'))
    const newer = c.persistence.flush()
    await vi.runAllTicks()
    await Promise.resolve()
    expect(readCachedConversationHistory(c.cache).threads[0].id).toBe('newer')
    expect(readCachedConversationHistory(c.cache).savedAt).toBe(10_001)
    rejectOlder(new Error('older disk failure'))
    expect(await older).toBe(true)
    expect(await newer).toBe(true)
    expect(readCachedConversationHistory(c.cache).threads[0].messages[0].text).toBe(
      'Newest exact fallback',
    )
    expect(c.onError).toHaveBeenCalledTimes(1)
  })

  it('does not write a stale fallback after a newer native checkpoint succeeds', async () => {
    const c = context()
    let rejectOlder!: (error: Error) => void
    c.save.mockImplementationOnce(
      () => new Promise<void>((_resolve, reject) => (rejectOlder = reject)),
    )
    const older = c.persistence.flush()
    c.change([thread('newer', 300)])
    const newer = c.persistence.flush()
    await Promise.resolve()
    rejectOlder(new Error('late disk failure'))
    expect(await older).toBe(true)
    expect(await newer).toBe(true)
    expect(c.cache.setItem).not.toHaveBeenCalled()
    expect(c.onError).not.toHaveBeenCalled()
  })

  it('keeps browser-only persistence exact and retries rejected storage writes', async () => {
    const c = context(false)
    c.cache.setItem.mockImplementationOnce(() => {
      throw new Error('quota exceeded')
    })
    const deletion: Thread[] = []
    expect(await c.persistence.flush(deletion)).toBe(false)
    expect(await c.persistence.flush(deletion)).toBe(true)
    expect(readCachedConversationHistory(c.cache).threads).toEqual([])
    c.change([thread()])
    expect(await c.persistence.flush()).toBe(true)
    expect(readCachedConversationHistory(c.cache).threads[0].messages[0].text).toBe(
      'Exact content\n  kept  \n',
    )
    expect(c.save).not.toHaveBeenCalled()
  })

  it('does not acknowledge a deletion when both destinations reject without an Error object', async () => {
    const c = context()
    c.save.mockRejectedValue(undefined)
    c.cache.setItem.mockImplementation(() => {
      throw undefined
    })
    expect(await c.persistence.flush([])).toBe(false)
    expect(await c.persistence.flush([])).toBe(false)
    expect(c.save).toHaveBeenCalledTimes(2)
  })
})

describe('raw source recovery through the persistence controller', () => {
  beforeEach(() => vi.useFakeTimers({ toFake: ['Date'] }))

  it('checkpoints raw restored source without persisting display normalization or dropping opaque rows', async () => {
    const c = await durableContext([recoverableRawThread()])
    const view = c.loaded[0]
    expect(view.title).toBe('Untitled thread')
    expect(view.busy).toBe(false)
    expect(view.turnStatus).toBe('unknown')
    expect(view.pending).toEqual([])
    expect(view.queue?.[0].paused).toBe(true)
    expect(view.messages).toHaveLength(1)
    expect(view.messages[0].status).toBe('interrupted')
    expect(view.messages[0].turn).toBe(0)

    expect(c.persistence.adoptNativeCheckpoint(c.raw as unknown as Thread[], 500, true)).toBe(true)
    expect(await c.persistence.flush()).toBe(true)
    expect(c.checkpoint).toHaveBeenCalledExactlyOnceWith({
      version: 1,
      baseSavedAt: 500,
      savedAt: 10_000,
      order: ['thread'],
      upserts: [],
    })
    const expected = { ...c.original, savedAt: 10_000 }
    expect(await c.disk()).toEqual(expected)
    expect(await c.reload()).toEqual(expected)
    expect(c.save).not.toHaveBeenCalled()
    expect(c.cache.setItem).not.toHaveBeenCalled()
    expect(c.onError).not.toHaveBeenCalled()
    expect(view.messages[0].status).toBe('interrupted')
    expect(view.queue?.[0].paused).toBe(true)
  })

  it('keeps a queued explicit mode selection after an older checkpoint rebases the restored source', async () => {
    const raw = { ...recoverableRawThread(), mode: 'future-mode' }
    const c = await durableContext([raw])
    expect(c.loaded[0].mode).toBe('review')
    expect(c.persistence.adoptNativeCheckpoint(c.raw as unknown as Thread[], 500, true)).toBe(true)
    let release!: () => Promise<void>
    c.checkpoint.mockImplementationOnce(
      (input) =>
        new Promise((resolve, reject) => {
          release = async () => {
            try {
              resolve(await runEffect(c.engine.checkpointEffect(input)))
            } catch (error) {
              reject(error)
            }
          }
        }),
    )
    const first = { ...c.loaded[0], mode: 'full-access' as const }
    c.change([first])
    const firstWrite = c.persistence.flush()
    const newest = { ...first, mode: 'review' as const, title: 'Explicit mode while saving' }
    c.change([newest])
    const newestWrite = c.persistence.flush()
    const writesBeforeAcknowledgement = c.checkpoint.mock.calls.length
    await release()
    expect(await Promise.all([firstWrite, newestWrite])).toEqual([true, true])
    expect(writesBeforeAcknowledgement).toBe(1)
    expect(c.checkpoint.mock.calls[0][0]).toMatchObject({
      upserts: [{ thread: { mode: 'full-access' } }],
    })
    expect(c.checkpoint.mock.calls[1][0]).toMatchObject({
      baseSavedAt: 10_000,
      upserts: [{ thread: { mode: 'review', title: newest.title } }],
    })
    const expected = { ...raw, mode: 'review', title: newest.title }
    expect(await c.reload()).toEqual({ ...c.original, savedAt: 10_001, threads: [expected] })
    expect(await c.disk()).toEqual({ ...c.original, savedAt: 10_001, threads: [expected] })
    expect(c.save).not.toHaveBeenCalled()
    expect(c.cache.setItem).not.toHaveBeenCalled()

    c.change([{ ...newest, updatedAt: 300 }])
    expect(await c.persistence.flush()).toBe(true)
    expect(await c.reload()).toEqual({
      ...c.original,
      savedAt: 10_002,
      threads: [{ ...expected, updatedAt: 300 }],
    })
  })

  it('serializes legacy full saves and keeps a queued explicit mode selection after acknowledgement', async () => {
    const raw = { ...recoverableRawThread(), mode: 'future-mode' }
    const c = await durableContext([raw], false, false)
    expect(c.loaded[0].mode).toBe('review')
    expect(c.persistence.adoptNativeCheckpoint(c.raw as unknown as Thread[], 500, true)).toBe(false)
    let release!: () => Promise<void>
    c.save.mockImplementationOnce(
      (history, savedAt) =>
        new Promise<void>((resolve, reject) => {
          release = async () => {
            try {
              await runEffect(c.engine.saveEffect(history, savedAt!))
              resolve()
            } catch (error) {
              reject(error)
            }
          }
        }),
    )
    const first = { ...c.loaded[0], mode: 'full-access' as const }
    c.change([first])
    const firstWrite = c.persistence.flush()
    const newest = { ...first, mode: 'review' as const, title: 'Explicit legacy mode while saving' }
    c.change([newest])
    const newestWrite = c.persistence.flush()
    const writesBeforeAcknowledgement = c.save.mock.calls.length
    await release()
    expect(await Promise.all([firstWrite, newestWrite])).toEqual([true, true])
    expect(writesBeforeAcknowledgement).toBe(1)
    expect(c.save.mock.calls[0][0]).toEqual([{ ...raw, mode: 'full-access' }])
    const expected = { ...raw, mode: 'review', title: newest.title }
    expect(c.save.mock.calls[1]).toEqual([[expected], 10_001])
    expect(await c.reload()).toEqual({ ...c.original, savedAt: 10_001, threads: [expected] })
    expect(c.checkpoint).not.toHaveBeenCalled()
    expect(c.cache.setItem).not.toHaveBeenCalled()

    c.change([{ ...newest, updatedAt: 300 }])
    expect(await c.persistence.flush()).toBe(true)
    expect(await c.reload()).toEqual({
      ...c.original,
      savedAt: 10_002,
      threads: [{ ...expected, updatedAt: 300 }],
    })
  })

  it('refreshes a failed queued mode selection for exact fallback recovery and a later native retry', async () => {
    const raw = { ...recoverableRawThread(), mode: 'future-mode' }
    const c = await durableContext([raw])
    expect(c.persistence.adoptNativeCheckpoint(c.raw as unknown as Thread[], 500, true)).toBe(true)
    let release!: () => Promise<void>
    c.checkpoint.mockImplementationOnce(
      (input) =>
        new Promise((resolve, reject) => {
          release = async () => {
            try {
              resolve(await runEffect(c.engine.checkpointEffect(input)))
            } catch (error) {
              reject(error)
            }
          }
        }),
    )
    c.checkpoint.mockRejectedValueOnce(new Error('disk full after earlier acknowledgement'))
    const first = { ...c.loaded[0], mode: 'full-access' as const }
    c.change([first])
    const firstWrite = c.persistence.flush()
    const message = { ...first.messages[0] }
    delete message.input
    const newest = {
      ...first,
      mode: 'review' as const,
      title: 'Exact queued fallback',
      messages: [message],
    }
    c.change([newest])
    const newestWrite = c.persistence.flush()
    await release()
    expect(await Promise.all([firstWrite, newestWrite])).toEqual([true, true])
    const expectedMessage = { ...(raw.messages[0] as Record<string, unknown>) }
    delete expectedMessage.input
    const expected = {
      ...raw,
      mode: 'review',
      title: newest.title,
      messages: [expectedMessage, ...raw.messages.slice(1)],
    }
    expect(await c.reload()).toEqual({
      ...c.original,
      savedAt: 10_000,
      threads: [{ ...raw, mode: 'full-access' }],
    })
    expect(JSON.parse(c.cache.values.get(CONVERSATION_HISTORY_KEY)!)).toEqual([expected])
    const fallback = readCachedConversationHistory(c.cache)
    expect(fallback.savedAt).toBe(10_001)
    expect(fallback.threads[0].mode).toBe('review')
    expect(fallback.threads[0].messages[0].input).toBeUndefined()
    expect(c.onError).toHaveBeenCalledExactlyOnceWith(
      'Conversation history is kept in the local cache, but the disk checkpoint failed. disk full after earlier acknowledgement',
    )

    c.change([{ ...newest, updatedAt: 300 }])
    expect(await c.persistence.flush()).toBe(true)
    expect(c.save).toHaveBeenCalledExactlyOnceWith([{ ...expected, updatedAt: 300 }], 10_002)
    expect(await c.reload()).toEqual({
      ...c.original,
      savedAt: 10_002,
      threads: [{ ...expected, updatedAt: 300 }],
    })
  })

  it('acknowledges an earlier cache fallback before the queued native mode selection is refreshed', async () => {
    const raw = { ...recoverableRawThread(), mode: 'future-mode' }
    const c = await durableContext([raw])
    expect(c.loaded[0].mode).toBe('review')
    expect(c.persistence.adoptNativeCheckpoint(c.raw as unknown as Thread[], 500, true)).toBe(true)
    let rejectFirst!: (error: Error) => void
    c.checkpoint.mockImplementationOnce(
      () =>
        new Promise((_resolve, reject) => {
          rejectFirst = reject
        }),
    )
    let cacheBeforeSuccess: unknown
    let cachedRevisionBeforeSuccess: number | undefined
    let diskBeforeSuccess: unknown
    c.save.mockImplementationOnce(async (history, savedAt) => {
      const cached = c.cache.values.get(CONVERSATION_HISTORY_KEY)
      cacheBeforeSuccess = cached === undefined ? null : JSON.parse(cached)
      cachedRevisionBeforeSuccess = readCachedConversationHistory(c.cache).savedAt
      diskBeforeSuccess = await c.disk()
      await runEffect(c.engine.saveEffect(history, savedAt!))
    })
    const first = { ...c.loaded[0], mode: 'full-access' as const }
    c.change([first])
    const firstWrite = c.persistence.flush()
    const newest = {
      ...first,
      mode: 'review' as const,
      title: 'Native success after cache recovery',
    }
    c.change([newest])
    const newestWrite = c.persistence.flush()
    expect(c.save).not.toHaveBeenCalled()
    rejectFirst(new Error('first native write failed'))
    expect(await Promise.all([firstWrite, newestWrite])).toEqual([true, true])

    const cachedRaw = { ...raw, mode: 'full-access' }
    const expected = { ...raw, mode: 'review', title: newest.title }
    expect(cacheBeforeSuccess).toEqual([cachedRaw])
    expect(cachedRevisionBeforeSuccess).toBe(10_000)
    expect(diskBeforeSuccess).toEqual(c.original)
    expect(c.checkpoint).toHaveBeenCalledTimes(1)
    expect(c.checkpoint.mock.calls[0][0]).toMatchObject({
      baseSavedAt: 500,
      savedAt: 10_000,
      upserts: [{ thread: { mode: 'full-access' } }],
    })
    expect(c.save).toHaveBeenCalledExactlyOnceWith([expected], 10_001)
    expect(await c.reload()).toEqual({ ...c.original, savedAt: 10_001, threads: [expected] })
    expect(await c.disk()).toEqual({ ...c.original, savedAt: 10_001, threads: [expected] })
    const fallback = readCachedConversationHistory(c.cache)
    expect(fallback.savedAt).toBe(10_000)
    expect(JSON.parse(c.cache.values.get(CONVERSATION_HISTORY_KEY)!)).toEqual([cachedRaw])
    const restored = reconcileConversationHistory(await c.reload(), fallback)
    expect(restored[0].mode).toBe('review')
    expect(restored[0].title).toBe(newest.title)
    expect(c.onError).toHaveBeenCalledExactlyOnceWith(
      'Conversation history is kept in the local cache, but the disk checkpoint failed. first native write failed',
    )

    c.change([{ ...newest, updatedAt: 300 }])
    expect(await c.persistence.flush()).toBe(true)
    expect(await c.reload()).toEqual({
      ...c.original,
      savedAt: 10_002,
      threads: [{ ...expected, updatedAt: 300 }],
    })
  })

  it.each([
    ['null', null],
    ['missing identifier', { role: 'system', text: exactRecoveryText, futureShape: true }],
    [
      'duplicate identifier',
      { id: 'known', role: 'system', text: exactRecoveryText, futureShape: true },
    ],
  ])(
    'keeps exact cache fallback after an adopted %s source row checkpoint fails',
    async (_name, opaque) => {
      const known = { id: 'known', role: 'user', text: exactRecoveryText, turn: 1 }
      const raw = rawThread('thread', [known, opaque])
      const c = await durableContext([raw])
      expect(c.persistence.adoptNativeCheckpoint(c.raw as unknown as Thread[], 500, true)).toBe(
        true,
      )
      c.checkpoint.mockRejectedValueOnce(new Error('disk full'))
      expect(await c.persistence.flush()).toBe(true)
      expect(c.checkpoint).toHaveBeenCalledExactlyOnceWith({
        version: 1,
        baseSavedAt: 500,
        savedAt: 10_000,
        order: ['thread'],
        upserts: [],
      })
      expect(c.save).not.toHaveBeenCalled()
      expect(JSON.parse(c.cache.values.get(CONVERSATION_HISTORY_KEY)!)).toEqual([raw])
      expect(c.onError).toHaveBeenCalledTimes(1)
      expect(await c.disk()).toEqual(c.original)

      const recovered = readCachedConversationHistory(c.cache).threads[0]
      expect(recovered.messages).toHaveLength(1)
      expect(JSON.parse(JSON.stringify(projectConversationSource(recovered)))).toEqual(raw)
      const edited = { ...recovered, title: 'Recovered after native failure', updatedAt: 200 }
      c.change([edited])
      expect(await c.persistence.flush()).toBe(true)
      const expectedRaw = { ...raw, title: edited.title, updatedAt: 200 }
      expect(c.save).toHaveBeenCalledExactlyOnceWith([expectedRaw], 10_001)
      expect(await c.reload()).toEqual({ ...c.original, savedAt: 10_001, threads: [expectedRaw] })
      expect(c.checkpoint).toHaveBeenCalledTimes(1)
    },
  )

  it('keeps acknowledged field removals and message deletion through a later immutable edit', async () => {
    const first = {
      id: 'delete',
      role: 'user',
      text: '  Deleted exact prompt\r\n  ',
      turn: 1,
    }
    const second = {
      id: 'keep',
      role: 'assistant',
      text: exactRecoveryText,
      input: exactRecoveryText,
      turn: 1,
      futureMessageField: { removed: exactRecoveryText },
    }
    const opaque = { id: 'opaque', role: 'system', futureMessageField: exactRecoveryText }
    const raw = rawThread('thread', [first, opaque, second])
    const c = await durableContext([raw])
    expect(c.persistence.adoptNativeCheckpoint(c.raw as unknown as Thread[], 500, true)).toBe(true)
    const kept = { ...c.loaded[0].messages[1] }
    delete kept.input
    Reflect.deleteProperty(kept, 'futureMessageField')
    const edited = { ...c.loaded[0], title: 'Renamed exact history', messages: [kept] }
    delete edited.remoteId
    c.change([edited])
    expect(await c.persistence.flush()).toBe(true)
    const retainedRaw = { ...second }
    delete (retainedRaw as Partial<typeof second>).input
    delete (retainedRaw as Partial<typeof second>).futureMessageField
    const expected = { ...raw, title: edited.title, messages: [opaque, retainedRaw] }
    Reflect.deleteProperty(expected, 'remoteId')
    expect(await c.disk()).toEqual({ ...c.original, savedAt: 10_000, threads: [expected] })

    const later = { ...edited, updatedAt: 300, title: 'Renamed again after acknowledgement' }
    c.change([later])
    expect(await c.persistence.flush()).toBe(true)
    expect(c.checkpoint.mock.calls[1][0]).toMatchObject({
      baseSavedAt: 10_000,
      upserts: [{ messages: { mode: 'patch', upserts: [] } }],
    })
    expect(await c.reload()).toEqual({
      ...c.original,
      savedAt: 10_001,
      threads: [{ ...expected, title: later.title, updatedAt: 300 }],
    })
    expect(c.save).not.toHaveBeenCalled()
  })

  it('rebases the exact coalesced acknowledgement while retaining the newest deletion and edits', async () => {
    const first = { id: 'first', role: 'user', text: '  Remove this prompt\r\n  ', turn: 1 }
    const second = {
      id: 'second',
      role: 'assistant',
      text: exactRecoveryText,
      turn: 1,
      futureMessageField: { remove: exactRecoveryText },
    }
    const opaque = { id: 'opaque', futureRecord: exactRecoveryText }
    const raw = rawThread('thread', [first, opaque, second])
    const c = await durableContext([raw])
    expect(c.persistence.adoptNativeCheckpoint(c.raw as unknown as Thread[], 500, true)).toBe(true)
    let release!: () => Promise<void>
    c.checkpoint.mockImplementationOnce(
      (input) =>
        new Promise((resolve, reject) => {
          release = async () => {
            try {
              resolve(await runEffect(c.engine.checkpointEffect(input)))
            } catch (error) {
              reject(error)
            }
          }
        }),
    )
    const firstView = { ...c.loaded[0], title: 'First in flight' }
    c.change([firstView])
    const firstWrite = c.persistence.flush()
    const supersededView = { ...firstView, title: 'Superseded', messages: [firstView.messages[1]] }
    c.change([supersededView])
    const supersededWrite = c.persistence.flush()
    const retained = { ...supersededView.messages[0] }
    Reflect.deleteProperty(retained, 'futureMessageField')
    const newestView = { ...supersededView, title: 'Newest durable state', messages: [retained] }
    c.change([newestView])
    const newestWrite = c.persistence.flush()
    expect(c.checkpoint).toHaveBeenCalledTimes(1)
    await release()
    expect(await Promise.all([firstWrite, supersededWrite, newestWrite])).toEqual([
      true,
      true,
      true,
    ])
    expect(c.checkpoint).toHaveBeenCalledTimes(2)
    expect(c.checkpoint.mock.calls[1][0]).toMatchObject({ baseSavedAt: 10_000, savedAt: 10_002 })
    const retainedRaw = { ...second }
    delete (retainedRaw as Partial<typeof second>).futureMessageField
    const expected = { ...raw, title: newestView.title, messages: [opaque, retainedRaw] }
    expect(await c.reload()).toEqual({ ...c.original, savedAt: 10_002, threads: [expected] })

    const added = { id: 'new', role: 'user' as const, text: '  Next exact prompt\r\nΩ  ', turn: 2 }
    const addedRaw = { ...added }
    const later = { ...newestView, messages: [...newestView.messages, added], updatedAt: 300 }
    c.change([later])
    expect(await c.persistence.flush()).toBe(true)
    expect(await c.reload()).toEqual({
      ...c.original,
      savedAt: 10_003,
      threads: [{ ...expected, updatedAt: 300, messages: [opaque, retainedRaw, addedRaw] }],
    })
    expect(c.cache.setItem).not.toHaveBeenCalled()
  })

  it('sends only changed message properties through an advertised native bridge', async () => {
    const largeText = `${exactRecoveryText}${'Settled response content Ω '.repeat(40_000)}`
    const raw = rawThread('thread', [
      {
        id: 'large',
        role: 'tool',
        text: largeText,
        input: largeText,
        turn: 1,
        status: 'completed',
        futureMessageField: { retained: exactRecoveryText },
      },
    ])
    const c = await durableContext([raw], true)
    expect(c.persistence.adoptNativeCheckpoint(c.raw as unknown as Thread[], 500, true)).toBe(true)
    const changed = {
      ...c.loaded[0],
      messages: [{ ...c.loaded[0].messages[0], status: 'failed', turn: 2 }],
    }
    c.change([changed])
    expect(await c.persistence.flush()).toBe(true)
    expect(c.checkpoint.mock.calls[0][0]).toMatchObject({
      upserts: [
        {
          messages: {
            mode: 'patch',
            upserts: [],
            fields: [{ id: 'large', set: { status: 'failed', turn: 2 }, remove: [] }],
          },
        },
      ],
    })
    const packet = JSON.stringify(c.checkpoint.mock.calls[0][0])
    expect(packet.length).toBeLessThan(1_000)
    expect(packet).not.toContain('Settled response content')
    expect(await c.reload()).toEqual({
      ...c.original,
      savedAt: 10_000,
      threads: [
        {
          ...raw,
          messages: [{ ...(raw.messages[0] as object), status: 'failed', turn: 2 }],
        },
      ],
    })
    expect(c.save).not.toHaveBeenCalled()
  })

  it.each([false, true])(
    'persists exact restored streaming suffixes with append capability %s',
    async (appends) => {
      const text = `${exactRecoveryText}${'Settled response Ω '.repeat(4_000)}\ud83e`
      const suffix = '\uddea\r\n\tExact streaming suffix e\u0301 漢字  '
      const raw = rawThread('thread', [
        {
          id: 'large',
          role: 'tool',
          text,
          input: exactRecoveryText,
          status: 'running',
          futureMessageField: { retained: exactRecoveryText },
        },
      ])
      const c = await durableContext([raw], true, true, appends)
      expect(c.persistence.adoptNativeCheckpoint(c.raw as unknown as Thread[], 500, true)).toBe(
        true,
      )
      c.change([
        {
          ...c.loaded[0],
          messages: [{ ...c.loaded[0].messages[0], text: text + suffix }],
        },
      ])
      expect(await c.persistence.flush()).toBe(true)
      const messages = c.checkpoint.mock.calls[0][0].upserts[0].messages
      expect(messages.mode).toBe('patch')
      if (messages.mode !== 'patch') throw new Error('Expected message patch')
      expect(messages.fields).toEqual([
        appends
          ? {
              id: 'large',
              set: {},
              remove: [],
              append: { text: { baseLength: text.length, value: suffix } },
            }
          : { id: 'large', set: { text: text + suffix }, remove: [] },
      ])
      if (appends) expect(JSON.stringify(c.checkpoint.mock.calls[0][0]).length).toBeLessThan(1_000)
      const expected = {
        ...c.original,
        savedAt: 10_000,
        threads: [{ ...raw, messages: [{ ...(raw.messages[0] as object), text: text + suffix }] }],
      }
      expect(await c.disk()).toEqual(expected)
      expect(await c.reload()).toEqual(expected)
      expect(c.save).not.toHaveBeenCalled()
      expect(c.cache.setItem).not.toHaveBeenCalled()
      expect(c.onError).not.toHaveBeenCalled()
    },
  )

  it('honors a disabled append capability after adopting an append-capable native baseline', async () => {
    const text = exactRecoveryText.repeat(128)
    const raw = rawThread('thread', [{ id: 'large', role: 'assistant', text, future: true }])
    const c = await durableContext([raw], true, true, true)
    expect(c.persistence.adoptNativeCheckpoint(c.raw as unknown as Thread[], 500, true)).toBe(true)
    c.capabilities(true, false)
    c.change([
      { ...c.loaded[0], messages: [{ ...c.loaded[0].messages[0], text: text + '\r\n  Ω  ' }] },
    ])
    expect(await c.persistence.flush()).toBe(true)
    expect(c.checkpoint.mock.calls[0][0].upserts[0].messages).toEqual({
      mode: 'patch',
      upserts: [],
      fields: [{ id: 'large', set: { text: text + '\r\n  Ω  ' }, remove: [] }],
    })
    expect(await c.reload()).toEqual({
      ...c.original,
      savedAt: 10_000,
      threads: [
        { ...raw, messages: [{ ...(raw.messages[0] as object), text: text + '\r\n  Ω  ' }] },
      ],
    })
  })

  it('preserves raw rows and an explicit removal when native and fallback writes both fail before retry', async () => {
    const raw = recoverableRawThread()
    const c = await durableContext([raw])
    expect(c.persistence.adoptNativeCheckpoint(c.raw as unknown as Thread[], 500, true)).toBe(true)
    const message = { ...c.loaded[0].messages[0] }
    delete message.input
    const changed = { ...c.loaded[0], messages: [message], title: 'Unsaved exact edit' }
    c.change([changed])
    c.checkpoint.mockRejectedValueOnce(new Error('disk full'))
    c.cache.setItem.mockImplementationOnce(() => {
      throw new Error('quota exceeded')
    })
    expect(await c.persistence.flush()).toBe(false)
    expect(await c.disk()).toEqual(c.original)
    expect(c.onError).toHaveBeenCalledExactlyOnceWith(
      'Conversation history could not be saved to disk or the local cache. Keep this window open. disk full',
    )
    const retryView = { ...changed, updatedAt: 300 }
    c.change([retryView])
    expect(await c.persistence.flush()).toBe(true)
    const expectedMessage = { ...(raw.messages[0] as Record<string, unknown>) }
    delete expectedMessage.input
    const expected = {
      ...raw,
      title: changed.title,
      updatedAt: 300,
      messages: [expectedMessage, ...raw.messages.slice(1)],
    }
    expect(c.save).toHaveBeenCalledExactlyOnceWith([expected], 10_001)
    expect(await c.reload()).toEqual({ ...c.original, savedAt: 10_001, threads: [expected] })
  })

  it('retains cache-acknowledged removals when retrying raw source after a native checkpoint failure', async () => {
    const raw = recoverableRawThread()
    const c = await durableContext([raw])
    expect(c.persistence.adoptNativeCheckpoint(c.raw as unknown as Thread[], 500, true)).toBe(true)
    const message = { ...c.loaded[0].messages[0] }
    Reflect.deleteProperty(message, 'futureMessageField')
    const changed = { ...c.loaded[0], title: 'Cache acknowledged', messages: [message] }
    c.change([changed])
    c.checkpoint.mockRejectedValueOnce(new Error('disk full'))
    expect(await c.persistence.flush()).toBe(true)
    const expectedMessage = { ...(raw.messages[0] as Record<string, unknown>) }
    delete expectedMessage.futureMessageField
    const expected = {
      ...raw,
      title: changed.title,
      messages: [expectedMessage, ...raw.messages.slice(1)],
    }
    expect(JSON.parse(c.cache.values.get(CONVERSATION_HISTORY_KEY)!)).toEqual([expected])
    const next = { ...changed, updatedAt: 300 }
    c.change([next])
    expect(await c.persistence.flush()).toBe(true)
    expect(c.save).toHaveBeenCalledExactlyOnceWith([{ ...expected, updatedAt: 300 }], 10_001)
    expect(await c.reload()).toEqual({
      ...c.original,
      savedAt: 10_001,
      threads: [{ ...expected, updatedAt: 300 }],
    })
  })
})

describe('conversation history migration and recovery', () => {
  it('migrates legacy local history only when there is no native store', () => {
    const cached = { threads: [thread('legacy', 100)] }
    expect(reconcileConversationHistory(null, cached)[0].id).toBe('legacy')
    expect(reconcileConversationHistory({ version: 1, savedAt: 500, threads: [] }, cached)).toEqual(
      [],
    )
  })

  it('keeps newer overlapping messages while preserving native-deleted thread membership', () => {
    const recovered = reconcileConversationHistory(
      { version: 1, savedAt: 500, threads: [thread('kept', 100, 'older')] },
      { threads: [thread('kept', 200, 'latest'), thread('deleted', 300), thread('new', 600)] },
    )
    expect(recovered.map((item) => item.id)).toEqual(['new', 'kept'])
    expect(recovered[1].messages[0].text).toBe('latest')
  })

  it('preserves newer cache deletions when the latest native checkpoint failed', () => {
    const recovered = reconcileConversationHistory(
      { version: 1, savedAt: 500, threads: [thread('deleted', 300), thread('kept', 100)] },
      { savedAt: 600, threads: [thread('kept', 200, 'latest')] },
    )
    expect(recovered.map((item) => item.id)).toEqual(['kept'])
    expect(recovered[0].messages[0].text).toBe('latest')
  })

  it('treats a newer native checkpoint as authoritative over an older validated fallback', () => {
    const recovered = reconcileConversationHistory(
      { version: 1, savedAt: 700, threads: [thread('kept', 100, 'Native exact content')] },
      {
        savedAt: 600,
        threads: [thread('kept', 1_000, 'Stale fallback'), thread('deleted', 2_000)],
      },
    )
    expect(recovered.map((item) => item.id)).toEqual(['kept'])
    expect(recovered[0].messages[0].text).toBe('Native exact content')
  })

  it('restores the newer validated fallback despite imported future-dated native metadata', async () => {
    const c = context(true, true)
    const imported = thread('kept', 99_999_999, 'Imported older content')
    c.change([imported, thread('deleted', 200)])
    await c.persistence.flush()
    c.change([thread('kept', 200, 'Current exact edit\r\n  Ω 👩🏽‍💻\n')])
    c.checkpoint.mockRejectedValueOnce(new Error('disk full'))
    expect(await c.persistence.flush()).toBe(true)
    const recovered = reconcileConversationHistory(
      { version: 1, savedAt: 10_000, threads: [imported, thread('deleted', 200)] },
      readCachedConversationHistory(c.cache),
    )
    expect(recovered.map((item) => item.id)).toEqual(['kept'])
    expect(recovered[0].messages[0].text).toBe('Current exact edit\r\n  Ω 👩🏽‍💻\n')
  })

  it('normalizes restored provider work without replaying queued messages or claiming the turn completed', () => {
    const saved = thread()
    saved.busy = true
    saved.turnStatus = 'running'
    saved.queue = [{ id: 'queued', text: 'Follow-up', createdAt: 50, attachments: [] }]
    const restored = reconcileConversationHistory(
      { version: 1, savedAt: 500, threads: [saved] },
      { threads: [] },
    )
    expect(restored[0].busy).toBe(false)
    expect(restored[0].turnStatus).toBe('unknown')
    expect(restored[0].queue?.[0].paused).toBe(true)
  })
})
