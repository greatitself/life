import { useEffect, useState } from 'react'
import type { Thread } from '../state'

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
  let started: number | undefined
  for (let index = thread.messages.length - 1; index >= 0; index--) {
    const message = thread.messages[index]
    if (message.turn === thread.turn && message.role === 'user') {
      started = message.createdAt
      break
    }
  }
  useEffect(() => {
    if (!thread.busy || !started) return
    setNow(Date.now())
    const timer = window.setInterval(() => setNow(Date.now()), 1000)
    return () => window.clearInterval(timer)
  }, [thread.busy, started])
  const waiting = thread.pending.length > 0
  return (
    <span className="thread-card-run-status" data-waiting={waiting || undefined}>
      <i className="thread-run-ring" aria-hidden="true" />
      <span>
        {waiting ? 'Waiting' : 'Working'}
        {started ? ` ${elapsed(Math.max(now, started) - started)}` : ''}
      </span>
    </span>
  )
}
