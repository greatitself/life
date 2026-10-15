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

type MainDocumentNavigation = {
  isMainFrame: boolean
  isSameDocument: boolean
  initiator?: unknown
}

/** Renderer attempts may still be blocked; only a native navigation retires work. */
export function isNativeMainDocumentNavigation(navigation: MainDocumentNavigation): boolean {
  return Boolean(
    navigation.isMainFrame && !navigation.isSameDocument && navigation.initiator == null,
  )
}

/** A renderer can request its existing interface again, never a foreign page. */
export function requestsRendererReload(currentURL: string, requestedURL: string): boolean {
  return Boolean(currentURL && requestedURL === currentURL)
}

/** Coalescing belongs to one document; a stale completion cannot erase its successor. */
export class RendererReloadFlights<Owner, Flight> {
  private entry?: {
    owner: Owner
    documentRevision: number | undefined
    documentId: string | undefined
    flight: Flight
  }

  get(owner: Owner, documentRevision: number | undefined, documentId?: string): Flight | undefined {
    const entry = this.entry
    return entry &&
      entry.owner === owner &&
      entry.documentRevision === documentRevision &&
      entry.documentId === documentId
      ? entry.flight
      : undefined
  }

  replace(
    owner: Owner,
    documentRevision: number | undefined,
    flight: Flight,
    documentId?: string,
  ): Flight | undefined {
    const previous = this.entry?.flight
    this.entry = { owner, documentRevision, documentId, flight }
    return previous
  }

  clear(flight: Flight): void {
    if (this.entry?.flight === flight) this.entry = undefined
  }
}

const recoverySafeChannels = new Set([
  'app:info',
  'connection:state',
  'conversations:load',
  'conversations:loadEncoded',
  'conversations:save',
  'conversations:checkpoint',
  'agent:update-recovery-owner',
  'agent:acknowledge-recovery-history',
  'agent:prepare-recovery-cache',
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

  commitMainDocument(admitted = true): void {
    this.revision++
    this.suspended = !admitted
  }

  resume(): void {
    this.suspended = false
  }

  allows(channel: string): boolean {
    return !this.suspended || recoverySafeChannels.has(channel)
  }
}
