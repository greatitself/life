import type { AgentEvent } from '../shared/types'

function isAppendDelta(event: AgentEvent): boolean {
  // Tool output can strip matching input after each fragment; snapshots replace rather than append.
  return (
    !event.nativeRecovery &&
    (event.type === 'text' || event.type === 'reasoning') &&
    event.status !== 'replace' &&
    typeof event.text === 'string'
  )
}

function sameDeltaMetadata(first: AgentEvent, next: AgentEvent): boolean {
  const firstKeys = Object.keys(first).filter((key) => key !== 'text')
  const nextKeys = Object.keys(next).filter((key) => key !== 'text')
  if (firstKeys.length !== nextKeys.length) return false
  return firstKeys.every(
    (key) =>
      Object.hasOwn(next, key) &&
      Object.is(first[key as keyof AgentEvent], next[key as keyof AgentEvent]),
  )
}

/** Join adjacent append deltas before projecting history, preserving every metadata boundary. */
export function coalesceAgentEvents(events: readonly AgentEvent[]): readonly AgentEvent[] {
  let compacted: AgentEvent[] | undefined
  for (let start = 0; start < events.length;) {
    const first = events[start]
    let end = start + 1
    if (isAppendDelta(first))
      while (
        end < events.length &&
        isAppendDelta(events[end]) &&
        sameDeltaMetadata(first, events[end])
      )
        end++
    if (end > start + 1) {
      compacted ??= events.slice(0, start)
      const fragments: string[] = []
      for (let index = start; index < end; index++) fragments.push(events[index].text!)
      compacted.push({ ...first, text: fragments.join('') })
    } else compacted?.push(first)
    start = end
  }
  return compacted ?? events
}

/** Keep token bursts off the render path, while actionable events retain wire order. */
export class AgentEventBatch {
  private pending: AgentEvent[] = []
  private timer?: ReturnType<typeof setTimeout>
  private disposed = false

  constructor(
    private deliver: (events: AgentEvent[]) => void,
    private interval = 16,
  ) {}

  push(event: AgentEvent): void {
    if (this.disposed) return
    this.pending.push(event)
    const streaming = ['text', 'reasoning', 'tool-output'].includes(event.type)
    if (!streaming || this.pending.length >= 500) this.flush()
    else if (!this.timer) this.timer = setTimeout(() => this.flush(), this.interval)
  }

  flush(): void {
    clearTimeout(this.timer)
    this.timer = undefined
    if (!this.pending.length) return
    const events = this.pending
    this.pending = []
    this.deliver(events)
  }

  dispose(): void {
    this.flush()
    this.disposed = true
  }
}
