import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { ConversationHistoryHydration } from '../src/renderer/conversation-hydration'
import type { ConversationHistorySnapshot } from '../src/shared/conversations'

const saved: ConversationHistorySnapshot = {
  version: 1,
  savedAt: 100,
  threads: [{ id: 'durable' }],
}

beforeEach(() => vi.useFakeTimers())
afterEach(() => vi.useRealTimers())

describe('native conversation history hydration', () => {
  it('cancels owned decoding after the last subscriber leaves, while retaining a concurrent subscriber', async () => {
    let owned!: AbortSignal
    const read = vi.fn((signal: AbortSignal) => {
      owned = signal
      return new Promise<ConversationHistorySnapshot>((_resolve, reject) =>
        signal.addEventListener('abort', () => reject(signal.reason), { once: true }),
      )
    })
    const hydration = new ConversationHistoryHydration(read)
    const a = new AbortController()
    const b = new AbortController()
    const first = expect(hydration.load(a.signal)).rejects.toMatchObject({ name: 'AbortError' })
    const second = expect(hydration.load(b.signal)).rejects.toMatchObject({ name: 'AbortError' })
    await Promise.resolve()
    a.abort()
    await first
    expect(owned.aborted).toBe(false)
    b.abort()
    await second
    await Promise.resolve()
    expect(owned.aborted).toBe(true)
    expect(read).toHaveBeenCalledTimes(1)
  })
  it('retries a transient failure and returns durable membership before admission', async () => {
    const read = vi.fn().mockRejectedValueOnce(new Error('EIO')).mockResolvedValue(saved)
    const hydration = new ConversationHistoryHydration(read)
    let admitted = false
    const loading = hydration.load(new AbortController().signal).then((value) => {
      admitted = true
      return value
    })
    await vi.advanceTimersByTimeAsync(249)
    expect(read).toHaveBeenCalledTimes(1)
    expect(admitted).toBe(false)
    await vi.advanceTimersByTimeAsync(1)
    expect(await loading).toBe(saved)
    expect(read).toHaveBeenCalledTimes(2)
  })

  it('shares the pending native read across StrictMode cancellation and replay', async () => {
    let release!: (value: ConversationHistorySnapshot) => void
    const read = vi.fn(
      () => new Promise<ConversationHistorySnapshot>((resolve) => (release = resolve)),
    )
    const hydration = new ConversationHistoryHydration(read)
    const first = new AbortController()
    const discarded = hydration.load(first.signal)
    const cancelled = expect(discarded).rejects.toMatchObject({ name: 'AbortError' })
    first.abort()
    const retained = hydration.load(new AbortController().signal)
    await cancelled
    expect(read).toHaveBeenCalledTimes(1)
    release(saved)
    expect(await retained).toBe(saved)
    expect(read).toHaveBeenCalledTimes(1)
  })

  it('bounds repeated failures and permits an explicit later retry', async () => {
    const original = new Error('Unreadable original native history was preserved')
    const read = vi.fn().mockRejectedValue(original)
    const hydration = new ConversationHistoryHydration(read)
    const failed = expect(hydration.load(new AbortController().signal)).rejects.toBe(original)
    await vi.advanceTimersByTimeAsync(1250)
    await failed
    expect(read).toHaveBeenCalledTimes(3)
    expect(vi.getTimerCount()).toBe(0)
    read.mockResolvedValue(saved)
    expect(await hydration.load(new AbortController().signal)).toBe(saved)
    expect(read).toHaveBeenCalledTimes(4)
  })

  it('cancels retry timers without starting later native reads', async () => {
    const read = vi.fn().mockRejectedValue(new Error('EIO'))
    const hydration = new ConversationHistoryHydration(read)
    const controller = new AbortController()
    const cancelled = expect(hydration.load(controller.signal)).rejects.toMatchObject({
      name: 'AbortError',
    })
    await vi.advanceTimersByTimeAsync(100)
    controller.abort()
    await cancelled
    await vi.advanceTimersByTimeAsync(10_000)
    expect(read).toHaveBeenCalledTimes(1)
    expect(vi.getTimerCount()).toBe(0)
  })
})
