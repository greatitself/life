import { useEffect, useState } from 'react'
import type { Thread } from '../state'
import { threadTurnStartedAt } from '../thread-presentation'

function elapsed(milliseconds: number): string {
  const seconds = Math.max(0, Math.floor(milliseconds / 1000))
  const minutes = Math.floor(seconds / 60)
  const hours = Math.floor(minutes / 60)
  return hours
    ? `${hours}h ${minutes % 60}m`
    : minutes
      ? `${minutes}m ${seconds % 60}s`
      : `${seconds}s`
}
export function ThreadRunStatus({ thread }: { thread: Thread }) {
  const [now, setNow] = useState(Date.now)
  const started = threadTurnStartedAt(thread)
  useEffect(() => {
    if (!thread.busy || !started) return
    setNow(Date.now())
    const timer = window.setInterval(() => setNow(Date.now()), 1000)
    return () => window.clearInterval(timer)
  }, [thread.busy, started])
  const waiting = thread.pending.length > 0
  const reconnecting = thread.turnStatus === 'reconnecting' || thread.agentStatus === 'reconnecting'
  const label = waiting
    ? 'Waiting for you'
    : reconnecting
      ? 'Reconnecting'
      : thread.turnStatus === 'unknown'
        ? 'Awaiting agent'
        : 'Working'
  return (
    <span
      className="thread-card-run-status"
      data-waiting={waiting || reconnecting || undefined}
      title={thread.statusText}
    >
      <i className="thread-run-ring" aria-hidden="true" />
      <span>
        {label}
        {started ? ` ${elapsed(Math.max(now, started) - started)}` : ''}
      </span>
    </span>
  )
}
