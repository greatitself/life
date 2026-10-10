import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  CONVERSATION_HISTORY_KEY,
  ConversationHistoryPersistence,
  readCachedConversationHistory,
  reconcileConversationHistory,
} from '../src/renderer/conversation-persistence'
import type { Thread } from '../src/renderer/state'

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
function context() {
  let threads = [thread()]
  let enabled = true
  const cache = storage()
  const save = vi.fn(async (_history: unknown[], _savedAt?: number) => {})
  const onError = vi.fn()
  const persistence = new ConversationHistoryPersistence({
    getThreads: () => threads,
    getStorage: () => cache,
    getNativeSave: () => save,
    onError,
    enabled: () => enabled,
  })
  return {
    cache,
    save,
    onError,
    persistence,
    change: (value: Thread[]) => (threads = value),
    enable: (value: boolean) => (enabled = value),
  }
}

beforeEach(() => {
  vi.useFakeTimers()
  vi.setSystemTime(10_000)
})
afterEach(() => vi.useRealTimers())

describe('bounded conversation history persistence', () => {
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

  it('still saves natively when browser quota fails and deduplicates repeated feedback', async () => {
    const c = context()
    c.cache.setItem.mockImplementation(() => {
      throw new Error('quota exceeded')
    })
    expect(await c.persistence.flush()).toBe(true)
    expect(c.save).toHaveBeenCalledTimes(1)
    expect(c.onError).toHaveBeenCalledWith(
      'Conversation history is saved to disk, but the local cache is full or unavailable.',
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
    expect(readCachedConversationHistory(c.cache).threads.map((item) => item.id)).toEqual([
      'retained',
    ])
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
    const c = context()
    await c.persistence.flush()
    expect(readCachedConversationHistory(c.cache).savedAt).toBe(10_000)
    c.cache.setItem(CONVERSATION_HISTORY_KEY, JSON.stringify([thread('changed', 200)]))
    expect(readCachedConversationHistory(c.cache).savedAt).toBeUndefined()
    c.persistence.advanceClock(50_000)
    c.change([thread('newer', 300)])
    await c.persistence.flush()
    expect(c.save.mock.calls[1][1]).toBe(50_001)
  })

  it('keeps valid cached messages when only the optional checkpoint marker is damaged', async () => {
    const c = context()
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
    expect(c.onError).toHaveBeenCalledWith(
      'Conversation history is saved to disk. The unreadable original local cache was preserved.',
    )
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
