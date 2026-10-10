import { useSyncExternalStore } from 'react'

const minuteMs = 60_000
const listeners = new Set<() => void>()
let timer: ReturnType<typeof setTimeout> | undefined
let previousMinute: number
let previousDay: string

export function sidebarMinuteSnapshot(): number {
  return Math.floor(Date.now() / minuteMs)
}

/** Calendar buckets depend on the local zone, including its historical DST rules. */
export function sidebarDaySnapshot(): string {
  const now = new Date()
  return `${now.getFullYear()}-${now.getMonth()}-${now.getDate()}:${Intl.DateTimeFormat().resolvedOptions().timeZone}:${now.getTimezoneOffset()}`
}

function publish() {
  const minute = sidebarMinuteSnapshot()
  const day = sidebarDaySnapshot()
  if (minute === previousMinute && day === previousDay) return
  previousMinute = minute
  previousDay = day
  for (const listener of [...listeners]) listener()
}

function schedule() {
  if (timer !== undefined) clearTimeout(timer)
  timer = undefined
  if (!listeners.size) return
  const delay = minuteMs - (((Date.now() % minuteMs) + minuteMs) % minuteMs)
  timer = setTimeout(() => {
    timer = undefined
    publish()
    schedule()
  }, delay)
}

function resume() {
  publish()
  schedule()
}

function visibilityChanged() {
  if (document.visibilityState !== 'hidden') resume()
}

export function subscribeSidebarClock(listener: () => void): () => void {
  // Each subscription owns its entry, even if callers share a callback.
  const notify = () => listener()
  listeners.add(notify)
  if (listeners.size === 1) {
    previousMinute = sidebarMinuteSnapshot()
    previousDay = sidebarDaySnapshot()
    if (typeof window !== 'undefined') window.addEventListener('focus', resume)
    if (typeof document !== 'undefined')
      document.addEventListener('visibilitychange', visibilityChanged)
    schedule()
  }
  return () => {
    listeners.delete(notify)
    if (listeners.size) return
    if (timer !== undefined) clearTimeout(timer)
    timer = undefined
    if (typeof window !== 'undefined') window.removeEventListener('focus', resume)
    if (typeof document !== 'undefined')
      document.removeEventListener('visibilitychange', visibilityChanged)
  }
}

const noSubscription = () => () => {}
const noDaySnapshot = () => ''

export function useSidebarMinute(): number {
  return useSyncExternalStore(subscribeSidebarClock, sidebarMinuteSnapshot, sidebarMinuteSnapshot)
}

export function useSidebarDay(enabled = true): string {
  const snapshot = enabled ? sidebarDaySnapshot : noDaySnapshot
  return useSyncExternalStore(enabled ? subscribeSidebarClock : noSubscription, snapshot, snapshot)
}
