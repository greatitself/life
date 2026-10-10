import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  sidebarDaySnapshot,
  sidebarMinuteSnapshot,
  subscribeSidebarClock,
} from '../src/renderer/sidebar-clock'

let windowEvents: EventTarget
let documentEvents: EventTarget & { visibilityState: string }
const subscriptions: Array<() => void> = []

beforeEach(() => {
  vi.useFakeTimers()
  vi.setSystemTime(new Date('2026-10-10T12:00:30Z'))
  vi.stubEnv('TZ', 'America/New_York')
  windowEvents = new EventTarget()
  documentEvents = Object.assign(new EventTarget(), { visibilityState: 'visible' })
  vi.stubGlobal('window', windowEvents)
  vi.stubGlobal('document', documentEvents)
})

afterEach(() => {
  for (const unsubscribe of subscriptions.splice(0)) unsubscribe()
  vi.useRealTimers()
  vi.restoreAllMocks()
  vi.unstubAllGlobals()
  vi.unstubAllEnvs()
})

function subscribe(listener = vi.fn()) {
  const unsubscribe = subscribeSidebarClock(listener)
  subscriptions.push(unsubscribe)
  return { listener, unsubscribe }
}

describe('shared sidebar clock', () => {
  it('starts no timer until needed and resumes cleanly after every subscriber unmounts', () => {
    expect(vi.getTimerCount()).toBe(0)
    const first = subscribe()
    first.unsubscribe()
    vi.setSystemTime(new Date('2026-10-10T13:03:50Z'))
    const second = subscribe()
    expect(vi.getTimerCount()).toBe(1)
    vi.advanceTimersByTime(10_000)
    expect(first.listener).not.toHaveBeenCalled()
    expect(second.listener).toHaveBeenCalledTimes(1)
  })

  it('uses one timer for all subscribers and publishes exactly at minute boundaries', () => {
    const first = subscribe()
    const second = subscribe()
    expect(vi.getTimerCount()).toBe(1)
    const minute = sidebarMinuteSnapshot()

    vi.advanceTimersByTime(29_999)
    expect(first.listener).not.toHaveBeenCalled()
    expect(sidebarMinuteSnapshot()).toBe(minute)
    vi.advanceTimersByTime(1)
    expect(first.listener).toHaveBeenCalledTimes(1)
    expect(second.listener).toHaveBeenCalledTimes(1)
    expect(sidebarMinuteSnapshot()).toBe(minute + 1)
    expect(vi.getTimerCount()).toBe(1)

    vi.advanceTimersByTime(60_000)
    expect(first.listener).toHaveBeenCalledTimes(2)
    expect(second.listener).toHaveBeenCalledTimes(2)
    expect(vi.getTimerCount()).toBe(1)
  })

  it('removes its timer and resume listeners after the last subscription leaves', () => {
    const first = subscribe()
    const second = subscribe()
    first.unsubscribe()
    expect(vi.getTimerCount()).toBe(1)
    second.unsubscribe()
    expect(vi.getTimerCount()).toBe(0)
    vi.setSystemTime(new Date('2026-10-10T12:05:30Z'))
    windowEvents.dispatchEvent(new Event('focus'))
    documentEvents.dispatchEvent(new Event('visibilitychange'))
    expect(vi.getTimerCount()).toBe(0)
    expect(first.listener).not.toHaveBeenCalled()
    expect(second.listener).not.toHaveBeenCalled()
  })

  it('keeps identical callbacks independently subscribed', () => {
    const listener = vi.fn()
    const first = subscribe(listener)
    subscribe(listener)
    first.unsubscribe()
    vi.advanceTimersByTime(30_000)
    expect(listener).toHaveBeenCalledTimes(1)
    expect(vi.getTimerCount()).toBe(1)
  })

  it('catches up on focus and visible resume without notifying within the same minute', () => {
    const { listener } = subscribe()
    windowEvents.dispatchEvent(new Event('focus'))
    documentEvents.dispatchEvent(new Event('visibilitychange'))
    expect(listener).not.toHaveBeenCalled()
    expect(vi.getTimerCount()).toBe(1)

    vi.setSystemTime(new Date('2026-10-10T12:08:15Z'))
    documentEvents.visibilityState = 'hidden'
    documentEvents.dispatchEvent(new Event('visibilitychange'))
    expect(listener).not.toHaveBeenCalled()
    documentEvents.visibilityState = 'visible'
    documentEvents.dispatchEvent(new Event('visibilitychange'))
    expect(listener).toHaveBeenCalledTimes(1)
    windowEvents.dispatchEvent(new Event('focus'))
    expect(listener).toHaveBeenCalledTimes(1)

    vi.advanceTimersByTime(44_999)
    expect(listener).toHaveBeenCalledTimes(1)
    vi.advanceTimersByTime(1)
    expect(listener).toHaveBeenCalledTimes(2)
    expect(vi.getTimerCount()).toBe(1)
  })

  it('uses local midnight instead of UTC midnight for calendar buckets', () => {
    vi.setSystemTime(new Date('2026-10-10T23:59:30-04:00'))
    const { listener } = subscribe()
    const day = sidebarDaySnapshot()
    expect(day).toContain('2026-9-10:America/New_York:240')
    vi.advanceTimersByTime(30_000)
    expect(sidebarDaySnapshot()).toContain('2026-9-11:America/New_York:240')
    expect(sidebarDaySnapshot()).not.toBe(day)
    expect(listener).toHaveBeenCalledTimes(1)
  })

  it('keeps the local calendar date through DST while updating its offset', () => {
    vi.setSystemTime(new Date('2026-11-01T01:59:30-04:00'))
    const { listener } = subscribe()
    expect(sidebarDaySnapshot()).toContain('2026-10-1:America/New_York:240')
    vi.advanceTimersByTime(30_000)
    expect(new Date().getHours()).toBe(1)
    expect(sidebarDaySnapshot()).toContain('2026-10-1:America/New_York:300')
    expect(listener).toHaveBeenCalledTimes(1)
  })

  it('invalidates calendar snapshots when the local time zone changes on resume', () => {
    vi.setSystemTime(new Date('2026-10-10T02:15:00Z'))
    const { listener } = subscribe()
    const minute = sidebarMinuteSnapshot()
    expect(sidebarDaySnapshot()).toContain('2026-9-9:America/New_York:240')
    vi.stubEnv('TZ', 'Asia/Tokyo')
    windowEvents.dispatchEvent(new Event('focus'))
    expect(sidebarMinuteSnapshot()).toBe(minute)
    expect(sidebarDaySnapshot()).toContain('2026-9-10:Asia/Tokyo:-540')
    expect(listener).toHaveBeenCalledTimes(1)
    windowEvents.dispatchEvent(new Event('focus'))
    expect(listener).toHaveBeenCalledTimes(1)
  })

  it('detects a same-date zone change even when the current UTC offset matches', () => {
    vi.setSystemTime(new Date('2026-10-10T12:15:00Z'))
    vi.stubEnv('TZ', 'Asia/Tokyo')
    const { listener } = subscribe()
    expect(sidebarDaySnapshot()).toContain('2026-9-10:Asia/Tokyo:-540')
    vi.stubEnv('TZ', 'Asia/Seoul')
    documentEvents.dispatchEvent(new Event('visibilitychange'))
    expect(sidebarDaySnapshot()).toContain('2026-9-10:Asia/Seoul:-540')
    expect(listener).toHaveBeenCalledTimes(1)
  })
})
