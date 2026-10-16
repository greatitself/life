import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { Thread } from '../src/renderer/state'
import {
  nextThreadSnoozeDeadline,
  startThreadSnoozeClock,
  wakeExpiredThreadSnoozes,
} from '../src/renderer/thread-snooze-clock'

const MAX_SLEEP_MS = 2_147_483_647
const cancellations: Array<() => void> = []

function thread(id: string, overrides: Partial<Thread> = {}): Thread {
  return {
    id,
    profileId: 'machine',
    workspace: '/project',
    provider: 'codex',
    title: id,
    messages: [],
    busy: false,
    model: '',
    mode: 'review',
    updatedAt: 100,
    turn: 0,
    pending: [],
    ...overrides,
  }
}

function start(deadline: number, wake = vi.fn()) {
  const cancel = startThreadSnoozeClock(deadline, wake)
  cancellations.push(cancel)
  return { cancel, wake }
}

beforeEach(() => {
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date'] })
  vi.setSystemTime(1_000)
})

afterEach(async () => {
  for (const cancel of cancellations.splice(0)) cancel()
  await vi.advanceTimersByTimeAsync(0)
  vi.restoreAllMocks()
  vi.useRealTimers()
})

describe('thread snooze deadlines', () => {
  it('selects the earliest finite positive deadline from an unsorted list', () => {
    expect(
      nextThreadSnoozeDeadline([
        thread('later', { snoozedUntil: 900 }),
        thread('invalid', { snoozedUntil: NaN }),
        thread('first', { snoozedUntil: 200 }),
        thread('infinite', { snoozedUntil: Infinity }),
        thread('zero', { snoozedUntil: 0 }),
        thread('negative', { snoozedUntil: -200 }),
        thread('middle', { snoozedUntil: 500 }),
      ]),
    ).toBe(200)
  })

  it('does not invent a deadline when no valid snooze exists', () => {
    expect(nextThreadSnoozeDeadline([])).toBeUndefined()
    expect(
      nextThreadSnoozeDeadline([
        thread('awake'),
        thread('invalid', { snoozedUntil: NaN }),
        thread('infinite', { snoozedUntil: -Infinity }),
        thread('zero', { snoozedUntil: 0 }),
      ]),
    ).toBeUndefined()
  })

  it('clears only due deadlines while preserving snooze history, native proof, and untouched rows', () => {
    const due = thread('due', {
      snoozedAt: 50,
      snoozedUntil: 100,
      pinnedAt: 20,
      activeOrder: 4,
      remoteId: 'original-native-session',
      nativeRecovery: {
        transport: { appliedRevision: 4, snapshotToken: 'original', ownerGeneration: 1 },
      },
      messages: [{ id: 'prompt', role: 'user', text: '  Exact prompt\r\n', turn: 1 }],
    })
    const future = thread('future', { snoozedAt: 80, snoozedUntil: 201 })
    const invalid = thread('invalid', { snoozedUntil: NaN })
    const threads = [due, future, invalid, thread('boundary', { snoozedUntil: 200 })]
    const result = wakeExpiredThreadSnoozes(threads, 200)
    expect(result).not.toBe(threads)
    expect(result[0]).toEqual({ ...due, snoozedUntil: undefined })
    expect(result[0].snoozedAt).toBe(50)
    expect(result[0].nativeRecovery).toBe(due.nativeRecovery)
    expect(result[0].messages).toBe(due.messages)
    expect(result[1]).toBe(future)
    expect(result[2]).toBe(invalid)
    expect(result[3].snoozedUntil).toBeUndefined()
    expect(due.snoozedUntil).toBe(100)
    expect(wakeExpiredThreadSnoozes(result, 200)).toBe(result)
  })

  it('preserves array identity when nothing is due or the supplied clock is invalid', () => {
    const threads = [
      thread('future', { snoozedUntil: 201 }),
      thread('awake'),
      thread('zero', { snoozedUntil: 0 }),
      thread('invalid', { snoozedUntil: NaN }),
    ]
    expect(wakeExpiredThreadSnoozes(threads, 200)).toBe(threads)
    expect(wakeExpiredThreadSnoozes(threads, NaN)).toBe(threads)
    expect(wakeExpiredThreadSnoozes(threads, Infinity)).toBe(threads)
  })
})

describe('Effect-owned thread snooze clock', () => {
  it('wakes once at the deadline and releases its timer afterward', async () => {
    const { wake } = start(2_000)
    await vi.advanceTimersByTimeAsync(999)
    expect(wake).not.toHaveBeenCalled()
    await vi.advanceTimersByTimeAsync(1)
    expect(wake).toHaveBeenCalledTimes(1)
    expect(wake).toHaveBeenCalledWith(2_000)
    await vi.advanceTimersByTimeAsync(20_000)
    expect(wake).toHaveBeenCalledTimes(1)
    expect(vi.getTimerCount()).toBe(0)
  })

  it('cancels the owned wait without delivering a wake or leaving a timer', async () => {
    const { cancel, wake } = start(2_000)
    await vi.advanceTimersByTimeAsync(500)
    cancel()
    cancel()
    await vi.advanceTimersByTimeAsync(10_000)
    expect(wake).not.toHaveBeenCalled()
    expect(vi.getTimerCount()).toBe(0)
  })

  it('allows immediate cleanup to suppress an overdue wake', async () => {
    const cancelled = start(500)
    cancelled.cancel()
    await vi.advanceTimersByTimeAsync(0)
    expect(cancelled.wake).not.toHaveBeenCalled()
    const due = start(500)
    await vi.advanceTimersByTimeAsync(0)
    expect(due.wake).toHaveBeenCalledTimes(1)
    expect(due.wake).toHaveBeenCalledWith(1_000)
    expect(vi.getTimerCount()).toBe(0)
  })

  it('caps a far-future sleep and re-arms until the actual deadline', async () => {
    const timer = vi.spyOn(globalThis, 'setTimeout')
    const deadline = 1_000 + MAX_SLEEP_MS + 5_000
    const { wake } = start(deadline)
    await vi.advanceTimersByTimeAsync(0)
    expect(timer).toHaveBeenCalledWith(expect.any(Function), MAX_SLEEP_MS)
    await vi.advanceTimersByTimeAsync(MAX_SLEEP_MS)
    expect(wake).not.toHaveBeenCalled()
    expect(vi.getTimerCount()).toBe(1)
    await vi.advanceTimersByTimeAsync(4_999)
    expect(wake).not.toHaveBeenCalled()
    await vi.advanceTimersByTimeAsync(1)
    expect(wake).toHaveBeenCalledTimes(1)
    expect(wake).toHaveBeenCalledWith(deadline)
    expect(vi.getTimerCount()).toBe(0)
  })

  it('re-arms after wall-clock rollback instead of losing the wake', async () => {
    const { wake } = start(2_000)
    await vi.advanceTimersByTimeAsync(500)
    vi.setSystemTime(0)
    await vi.advanceTimersByTimeAsync(500)
    expect(wake).not.toHaveBeenCalled()
    expect(vi.getTimerCount()).toBe(1)
    await vi.advanceTimersByTimeAsync(1_499)
    expect(wake).not.toHaveBeenCalled()
    await vi.advanceTimersByTimeAsync(1)
    expect(wake).toHaveBeenCalledTimes(1)
    expect(wake).toHaveBeenCalledWith(2_000)
    expect(vi.getTimerCount()).toBe(0)
  })

  it('reports the observed clock when a forward jump makes the deadline overdue', async () => {
    const { wake } = start(2_000)
    await vi.advanceTimersByTimeAsync(0)
    vi.setSystemTime(100_000)
    await vi.advanceTimersByTimeAsync(1_000)
    expect(wake).toHaveBeenCalledTimes(1)
    expect(wake).toHaveBeenCalledWith(101_000)
  })

  it.each([NaN, Infinity, -Infinity, 0, -1])(
    'starts no wait for invalid deadline %s',
    async (deadline) => {
      const { wake } = start(deadline)
      await vi.advanceTimersByTimeAsync(10_000)
      expect(wake).not.toHaveBeenCalled()
      expect(vi.getTimerCount()).toBe(0)
    },
  )
})
