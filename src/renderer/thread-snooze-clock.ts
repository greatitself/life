import { DateTime, Effect, Exit } from 'effect'
import type { Thread } from './state'

const MAX_SLEEP_MS = 2_147_483_647

export function nextThreadSnoozeDeadline(threads: readonly Thread[]): number | undefined {
  let earliest: number | undefined
  for (const thread of threads) {
    const until = thread.snoozedUntil
    if (until === undefined || !Number.isFinite(until) || until <= 0) continue
    if (earliest === undefined || until < earliest) earliest = until
  }
  return earliest
}

/** Expiry changes visibility only; the original snooze time still identifies its wake. */
export function wakeExpiredThreadSnoozes(threads: Thread[], now: number): Thread[] {
  if (!Number.isFinite(now)) return threads
  let next = threads
  for (let index = 0; index < threads.length; index++) {
    const thread = threads[index]
    const until = thread.snoozedUntil
    if (until === undefined || !Number.isFinite(until) || until <= 0 || until > now) continue
    if (next === threads) next = threads.slice()
    next[index] = { ...thread, snoozedUntil: undefined }
  }
  return next
}

const waitForThreadSnoozeDeadline = Effect.fnUntraced(function* (deadline: number) {
  // Hand the caller its cleanup before publishing even an already-due wake.
  yield* Effect.yieldNow
  while (true) {
    const current = yield* DateTime.now
    const now = DateTime.toEpochMillis(current)
    if (now >= deadline) return now
    // Re-read wall time after each bounded sleep: clock rollback must re-arm,
    // and a long deadline must never overflow the platform's timer range.
    yield* Effect.sleep(Math.min(Math.ceil(deadline - now), MAX_SLEEP_MS))
  }
})

/** React owns this interruptor; Effect owns the deadline wait and its timer cleanup. */
export function startThreadSnoozeClock(
  deadline: number,
  onWake: (now: number) => void,
): () => void {
  if (!Number.isFinite(deadline) || deadline <= 0) return () => {}
  let cancelled = false
  const interrupt = Effect.runCallback(waitForThreadSnoozeDeadline(deadline), {
    onExit: (exit) => {
      if (!cancelled && Exit.isSuccess(exit)) onWake(exit.value)
    },
  })
  return () => {
    cancelled = true
    interrupt()
  }
}
