/** A crashing interface gets one restart before recovery needs a user decision. */
export class RendererRecoveryBudget {
  private lastFailure?: number
  private failures = 0

  constructor(private readonly stableInterval = 60_000) {}

  allowAutomaticRecovery(now = performance.now()): boolean {
    if (this.lastFailure === undefined || now - this.lastFailure >= this.stableInterval)
      this.failures = 0
    this.lastFailure = now
    this.failures++
    return this.failures === 1
  }
}

const recoverySafeChannels = new Set([
  'app:info',
  'connection:state',
  'conversations:load',
  'conversations:save',
  'customization:get',
  'extensions:get',
  'forwarding:get',
  'profiles:list',
  'source-code:get',
  'source-code:context',
  'updates:get',
  'window:state',
  'window:initial-recovery',
  'window:restart',
  'extensions:recover',
])

/** Old document queues cannot acquire fresh native work while its UI is closing. */
export class RendererDocumentAdmission {
  private suspended = true
  private revision = 0

  get documentRevision(): number {
    return this.revision
  }

  suspend(): void {
    this.suspended = true
  }

  commitMainDocument(): void {
    this.revision++
    this.suspended = false
  }

  allows(channel: string): boolean {
    return !this.suspended || recoverySafeChannels.has(channel)
  }
}
