import { useCallback, useEffect, useRef } from 'react'
import type { ConversationHistorySnapshot } from '../shared/conversations'
import { errorText } from './api'
import { readThreads, type Thread } from './state'

export const CONVERSATION_HISTORY_KEY = 'relay.threads.v1'
const checkpointKey = 'life.conversation-checkpoint.v1'
type HistoryStorage = Pick<Storage, 'getItem' | 'setItem'>
type NativeSave = (threads: unknown[], savedAt?: number) => Promise<void>

interface CachedHistory {
  threads: Thread[]
  savedAt?: number
}

// Detect a partial cache/metadata write without retaining a second copy of the
// conversation text. This is a consistency marker, not a security boundary.
function fingerprint(value: string): string {
  let first = 2166136261
  let second = 3335557771
  for (let index = 0; index < value.length; index++) {
    const character = value.charCodeAt(index)
    first = Math.imul(first ^ character, 16777619)
    second = Math.imul(second ^ character, 2246822519)
  }
  return `${value.length}:${first >>> 0}:${second >>> 0}`
}

export function readCachedConversationHistory(storage?: HistoryStorage): CachedHistory {
  try {
    const cache = storage || localStorage
    const serialized = cache.getItem(CONVERSATION_HISTORY_KEY) || '[]'
    const threads = readThreads(JSON.parse(serialized))
    let marker: { savedAt?: unknown; fingerprint?: unknown } | null = null
    try {
      marker = JSON.parse(cache.getItem(checkpointKey) || 'null')
    } catch {
      // Cache metadata is optional; a damaged marker must not hide valid text.
    }
    const savedAt =
      marker &&
      Number.isSafeInteger(marker.savedAt) &&
      typeof marker.savedAt === 'number' &&
      marker.savedAt >= 0 &&
      marker.fingerprint === fingerprint(serialized)
        ? marker.savedAt
        : undefined
    return { threads, savedAt }
  } catch {
    return { threads: [] }
  }
}

/** Preserve a newer fallback checkpoint, including deletions, without reviving stale cached threads. */
export function reconcileConversationHistory(
  native: ConversationHistorySnapshot | null,
  cache: CachedHistory,
): Thread[] {
  if (native === null) return cache.threads
  const saved = readThreads(native.threads)
  const nativeById = new Map(saved.map((thread) => [thread.id, thread]))
  const cacheById = new Map(cache.threads.map((thread) => [thread.id, thread]))
  const cacheIsNewer = cache.savedAt !== undefined && cache.savedAt > native.savedAt
  const result = (cacheIsNewer ? cache.threads : saved).map((thread) => {
    const other = (cacheIsNewer ? nativeById : cacheById).get(thread.id)
    return other && other.updatedAt > thread.updatedAt ? other : thread
  })
  if (!cacheIsNewer) {
    for (const thread of cache.threads) {
      // A locally created thread after the native checkpoint is new work. A
      // removed older thread is deliberately absent from the native membership.
      if (!nativeById.has(thread.id) && thread.updatedAt > native.savedAt) result.push(thread)
    }
  }
  return result.sort((left, right) => right.updatedAt - left.updatedAt)
}

interface PersistenceOptions {
  getThreads(): Thread[]
  getNativeSave(): NativeSave | undefined
  getStorage(): HistoryStorage
  onError(message: string): void
  enabled(): boolean
}

/** A quiet-period save plus a bounded checkpoint during uninterrupted streaming. */
export class ConversationHistoryPersistence {
  private idleTimer?: ReturnType<typeof setTimeout>
  private checkpointTimer?: ReturnType<typeof setTimeout>
  private requested?: Thread[]
  private lastSavedAt = 0
  private lastWarning = ''
  private cacheChecked = false
  private cacheWritable = true
  private lastResult = true
  private lastResultAt = 0
  private writes = new Set<Promise<boolean>>()

  constructor(
    private readonly options: PersistenceOptions,
    private readonly idleDelay = 600,
    private readonly checkpointDelay = 2_000,
  ) {}

  advanceClock(savedAt: number): void {
    this.lastSavedAt = Math.max(this.lastSavedAt, savedAt)
  }

  schedule(): void {
    if (!this.options.enabled()) return
    if (this.idleTimer !== undefined) clearTimeout(this.idleTimer)
    this.idleTimer = setTimeout(() => void this.flush(), this.idleDelay)
    this.checkpointTimer ??= setTimeout(() => void this.flush(), this.checkpointDelay)
  }

  cancel(): void {
    if (this.idleTimer !== undefined) clearTimeout(this.idleTimer)
    if (this.checkpointTimer !== undefined) clearTimeout(this.checkpointTimer)
    this.idleTimer = undefined
    this.checkpointTimer = undefined
  }

  async flush(snapshot?: Thread[]): Promise<boolean> {
    this.cancel()
    if (!this.options.enabled()) return false
    const threads = snapshot || this.options.getThreads()
    if (threads !== this.requested) {
      this.requested = threads
      const history = threads.map((thread) => ({ ...thread, pending: [] }))
      const savedAt = Math.max(Date.now(), this.lastSavedAt + 1)
      this.lastSavedAt = savedAt
      const write = this.persist(history, savedAt)
        .then(({ saved, primarySaved }) => {
          if (!primarySaved && this.requested === threads) this.requested = undefined
          if (savedAt >= this.lastResultAt) {
            this.lastResultAt = savedAt
            this.lastResult = saved
          }
          return saved
        })
        .finally(() => this.writes.delete(write))
      this.writes.add(write)
    }
    const results = await Promise.all(this.writes)
    return results.length ? results.every(Boolean) : this.lastResult
  }

  private async persist(
    history: Thread[],
    savedAt: number,
  ): Promise<{ saved: boolean; primarySaved: boolean }> {
    let cacheError: unknown
    try {
      const serialized = JSON.stringify(history)
      const storage = this.options.getStorage()
      if (!this.cacheChecked) {
        this.cacheChecked = true
        try {
          const existing = storage.getItem(CONVERSATION_HISTORY_KEY)
          if (existing !== null) {
            const parsed: unknown = JSON.parse(existing)
            if (!Array.isArray(parsed) || readThreads(parsed).length !== parsed.length)
              this.cacheWritable = false
          }
        } catch {
          this.cacheWritable = false
        }
      }
      if (!this.cacheWritable)
        throw new Error('The unreadable original local history cache was preserved.')
      storage.setItem(CONVERSATION_HISTORY_KEY, serialized)
      storage.setItem(
        checkpointKey,
        JSON.stringify({ savedAt, fingerprint: fingerprint(serialized) }),
      )
    } catch (error) {
      cacheError = error
    }
    const nativeSave = this.options.getNativeSave()
    let nativeError: unknown
    if (nativeSave) {
      try {
        await nativeSave(history, savedAt)
      } catch (error) {
        nativeError = error
      }
    }
    let warning = ''
    if (nativeError)
      warning = cacheError
        ? `Conversation history could not be saved to disk or the local cache. Keep this window open. ${errorText(nativeError)}`
        : `Conversation history is kept in the local cache, but the disk checkpoint failed. ${errorText(nativeError)}`
    else if (cacheError)
      warning = nativeSave
        ? this.cacheWritable
          ? 'Conversation history is saved to disk, but the local cache is full or unavailable.'
          : 'Conversation history is saved to disk. The unreadable original local cache was preserved.'
        : 'Conversation history could not be saved locally. Keep this window open and free storage space.'
    if (warning && warning !== this.lastWarning) this.options.onError(warning)
    this.lastWarning = warning
    return {
      saved: !cacheError || Boolean(nativeSave && !nativeError),
      primarySaved: nativeSave ? !nativeError : !cacheError,
    }
  }
}

export function useConversationPersistence(
  threads: Thread[],
  nativeSave: NativeSave | undefined,
  onError: (message: string) => void,
  enabled: boolean,
) {
  const current = useRef({ threads, nativeSave, onError, enabled })
  current.current = { threads, nativeSave, onError, enabled }
  const checkpoint = useRef<ConversationHistoryPersistence | null>(null)
  checkpoint.current ||= new ConversationHistoryPersistence({
    getThreads: () => current.current.threads,
    getNativeSave: () => current.current.nativeSave,
    getStorage: () => localStorage,
    onError: (message) => current.current.onError(message),
    enabled: () => current.current.enabled,
  })
  const persistence = checkpoint.current
  useEffect(() => {
    if (enabled) persistence.schedule()
    else persistence.cancel()
  }, [threads, enabled, persistence])
  useEffect(() => () => persistence.cancel(), [persistence])
  const flush = useCallback((snapshot?: Thread[]) => persistence.flush(snapshot), [persistence])
  const advanceClock = useCallback(
    (savedAt: number) => persistence.advanceClock(savedAt),
    [persistence],
  )
  return { flush, advanceClock }
}
