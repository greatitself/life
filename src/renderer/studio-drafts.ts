import { studioSessionIdentifier } from './studio-history'

export const STUDIO_DRAFTS_KEY = 'life.studio.drafts.v1'

export const STUDIO_DRAFT_READ_ERROR =
  'Saved Studio drafts could not be read. Existing storage has been left unchanged; use Export recovery to save your current draft.'
export const STUDIO_DRAFT_WRITE_ERROR =
  'Could not save your Studio draft. Your text is still available here; use Export recovery before closing Life.'
export const STUDIO_DRAFT_FORMAT_ERROR =
  'This conversation’s saved draft has an unsupported format. It has been left unchanged; use Export recovery to save your current draft.'

export interface StudioDraftCapture {
  readonly owner: object
  readonly id: string
  readonly revision: number
  readonly text: string
}

export interface StudioDraftWriteResult {
  readonly saved: boolean
  readonly error: string
}

/** Own the complete stored map; only selected string drafts enter the composer. */
export class StudioDraftStore {
  private readonly owner = {}
  private readonly revisions = new Map<string, number>()
  private readonly pending = new Map<string, number>()
  private readonly protectedKeys = new Set<string>()
  private readonly protectedDrafts = new Map<string, string>()
  private values: Record<string, unknown> = {}
  private readonly writable: boolean
  readonly readError: string

  constructor(
    read: () => string | null,
    private readonly write: (encoded: string) => void,
  ) {
    try {
      const encoded = read()
      const value: unknown = encoded === null ? {} : JSON.parse(encoded)
      if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error()
      this.values = value as Record<string, unknown>
      for (const [id, draft] of Object.entries(this.values)) {
        if (typeof draft !== 'string') this.protectedKeys.add(id)
      }
      this.writable = true
      this.readError = ''
    } catch {
      this.writable = false
      this.readError = STUDIO_DRAFT_READ_ERROR
    }
  }

  get dirty(): boolean {
    return this.pending.size > 0
  }

  get(id: string): string {
    if (!studioSessionIdentifier(id)) return ''
    if (this.protectedDrafts.has(id)) return this.protectedDrafts.get(id)!
    if (!Object.hasOwn(this.values, id)) return ''
    const value = this.values[id]
    return typeof value === 'string' ? value : ''
  }

  update(id: string, text: string): boolean {
    if (!studioSessionIdentifier(id)) return false
    if (text === this.get(id) && (this.protectedDrafts.has(id) || Object.hasOwn(this.values, id)))
      return false
    if (this.protectedKeys.has(id)) {
      this.protectedDrafts.set(id, text)
    } else {
      // Object spread and a computed property retain prototype-like JSON keys as inert data.
      this.values = { ...this.values, [id]: text }
    }
    const revision = (this.revisions.get(id) || 0) + 1
    this.revisions.set(id, revision)
    this.pending.set(id, revision)
    return true
  }

  capture(id: string): StudioDraftCapture {
    return { owner: this.owner, id, revision: this.revisions.get(id) || 0, text: this.get(id) }
  }

  clearIfCurrent(capture: StudioDraftCapture): boolean {
    if (
      capture.owner !== this.owner ||
      capture.revision !== (this.revisions.get(capture.id) || 0) ||
      capture.text !== this.get(capture.id)
    )
      return false
    return this.update(capture.id, '')
  }

  flush(): StudioDraftWriteResult {
    if (!this.writable) return { saved: false, error: this.readError }
    if (!this.dirty) return { saved: true, error: '' }
    const pending = [...this.pending].filter(([id]) => !this.protectedKeys.has(id))
    if (!pending.length) return { saved: false, error: STUDIO_DRAFT_FORMAT_ERROR }
    try {
      const encoded = JSON.stringify(this.values)
      this.write(encoded)
      // A write callback may synchronously cause another edit. Only acknowledge its snapshot.
      for (const [id, revision] of pending) {
        if (this.pending.get(id) === revision) this.pending.delete(id)
      }
      const blocked = [...this.pending.keys()].some((id) => this.protectedKeys.has(id))
      return { saved: !blocked, error: blocked ? STUDIO_DRAFT_FORMAT_ERROR : '' }
    } catch {
      return { saved: false, error: STUDIO_DRAFT_WRITE_ERROR }
    }
  }
}

export function studioDraftRecovery(conversation: unknown, sessionId: string, text: string) {
  return { version: 1, conversation, draft: { sessionId, text } }
}
