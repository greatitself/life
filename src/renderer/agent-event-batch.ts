import type { AgentEvent } from '../shared/types'

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
