import { useCallback, useEffect, useRef } from 'react'
import { Effect, Schema, Semaphore } from 'effect'
import type {
  ConversationHistorySnapshot,
  ConversationProjectionAdmission,
} from '../shared/conversations'
import { errorText } from './api'
import { readThreads, type Thread } from './state'
import { normalizedConversationThreads } from './conversation-load-protocol'
import {
  acknowledgeConversationSources,
  hasConversationSource,
  refreshConversationSources,
} from './conversation-source'
import {
  ConversationCheckpointClient,
  createHistorySnapshotProjector,
  type NativeConversationCheckpoint,
  type NativeConversationSave,
} from './conversation-checkpoint-client'
import {
  carryNativeProjectionAdmissions,
  nativeProjectionAdmissions,
  nativeProjectionMembershipAdmissions,
  carryNativeProjectionMembership,
} from './native-projection-admissions'

import {
  CONVERSATION_HISTORY_KEY,
  conversationCheckpointKey,
  conversationCacheFingerprint,
  getEffectiveCachedConversationHistorySavedAt,
  type CachedHistory,
  type HistoryStorage,
} from './main-cache-recovery'
import { hashSerializedConversationCacheEffect } from './conversation-cache-hash'
export { CONVERSATION_HISTORY_KEY, readCachedConversationHistory } from './main-cache-recovery'

type NativeSave = NativeConversationSave
export type NativePrepareRecoveryCache = (input: {
  snapshotId: string
  hash: string
  savedAt: number
  projectionAdmissions: readonly ConversationProjectionAdmission[]
  membershipAdmissions?: readonly ConversationProjectionAdmission[]
}) => Promise<void>

class ConversationCacheWriteError extends Schema.TaggedError<ConversationCacheWriteError>()(
  'ConversationCacheWriteError',
  { cause: Schema.Defect() },
) {}

/** Preserve a newer fallback checkpoint, including deletions, without reviving stale cached threads. */
export function reconcileConversationHistory(
  native: ConversationHistorySnapshot | null,
  cache: CachedHistory,
): Thread[] {
  if (native === null) return cache.threads
  const saved = normalizedConversationThreads(native) ?? readThreads(native.threads)
  // A validated fallback checkpoint records the full membership. Once a newer
  // native checkpoint is durable, that old fallback must not revive deleted
  // threads or override content (including imported future-dated messages).
  const cachedAt = getEffectiveCachedConversationHistorySavedAt(cache)
  if (cachedAt !== undefined) {
    if (cachedAt > native.savedAt)
      return carryNativeProjectionMembership(
        cache.threads,
        [...cache.threads].sort((left, right) => right.updatedAt - left.updatedAt),
      )
    return saved.sort((left, right) => right.updatedAt - left.updatedAt)
  }
  const nativeById = new Map(saved.map((thread) => [thread.id, thread]))
  const cacheById = new Map(cache.threads.map((thread) => [thread.id, thread]))
  const result = saved.map((thread) => {
    const other = cacheById.get(thread.id)
    return other && other.updatedAt > thread.updatedAt ? other : thread
  })
  for (const thread of cache.threads) {
    // A locally created thread after the native checkpoint is new work. A
    // removed older thread is deliberately absent from the native membership.
    if (!nativeById.has(thread.id) && thread.updatedAt > native.savedAt) result.push(thread)
  }
  return result.sort((left, right) => right.updatedAt - left.updatedAt)
}

interface PersistenceOptions {
  getThreads(): Thread[]
  getNativeSave(): NativeSave | undefined
  getNativeCheckpoint?(): NativeConversationCheckpoint | undefined
  getPrepareRecoveryCache?(): NativePrepareRecoveryCache | undefined
  supportsMessageFields?(): boolean
  supportsMessageAppends?(): boolean
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
  private lastNativeSavedAt = 0
  private lastCacheSavedAt = 0
  private lastWarning = ''
  private lastWarningAt = 0
  private cacheChecked = false
  private cacheWritable = true
  private lastResult = true
  private lastResultAt = 0
  private writes = new Set<Promise<boolean>>()
  private readonly snapshot = createHistorySnapshotProjector()
  private readonly nativeClient = new ConversationCheckpointClient()
  private readonly cacheWrites = Semaphore.makeUnsafe(1)

  constructor(
    private readonly options: PersistenceOptions,
    private readonly idleDelay = 600,
    private readonly checkpointDelay = 2_000,
  ) {}

  advanceClock(savedAt: number): void {
    this.lastSavedAt = Math.max(this.lastSavedAt, savedAt)
  }

  /** Adopt the owned native source; rendered projections are separate from this durable base. */
  adoptNativeCheckpoint(threads: Thread[], savedAt: number, rawSource = false): boolean {
    if (this.writes.size) return false
    const save = this.options.getNativeSave()
    const checkpoint = this.options.getNativeCheckpoint?.()
    if (!save || !checkpoint) return false
    if (
      !this.nativeClient.adoptDurableBaseline(
        rawSource ? threads : this.snapshot(threads),
        savedAt,
        save,
        checkpoint,
        {
          supportsMessageFields: this.options.supportsMessageFields?.() === true,
          supportsMessageAppends: this.options.supportsMessageAppends?.() === true,
        },
      )
    )
      return false
    this.advanceClock(savedAt)
    this.lastNativeSavedAt = Math.max(this.lastNativeSavedAt, savedAt)
    this.requested = undefined
    return true
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
      const history = this.snapshot(threads)
      const savedAt = Math.max(Date.now(), this.lastSavedAt + 1)
      this.lastSavedAt = savedAt
      const write = this.persist(history, savedAt, threads.some(hasConversationSource))
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
    sourceOwned = false,
  ): Promise<{ saved: boolean; primarySaved: boolean }> {
    const nativeSave = this.options.getNativeSave()
    let nativeError: unknown
    let nativeFailed = false
    if (nativeSave) {
      try {
        const checkpoint = this.options.getNativeCheckpoint?.()
        let acknowledgedAt = savedAt
        if (checkpoint || sourceOwned)
          acknowledgedAt = await this.nativeClient.submit(
            history,
            savedAt,
            nativeSave,
            checkpoint,
            {
              supportsMessageFields: this.options.supportsMessageFields?.() === true,
              supportsMessageAppends: this.options.supportsMessageAppends?.() === true,
            },
          )
        else {
          const projectionAdmissions = nativeProjectionAdmissions(history)
          if (projectionAdmissions) await nativeSave(history, savedAt, projectionAdmissions)
          else await nativeSave(history, savedAt)
          acknowledgeConversationSources(history, savedAt)
        }
        this.lastNativeSavedAt = Math.max(this.lastNativeSavedAt, acknowledgedAt)
        this.warn('', savedAt)
        return { saved: true, primarySaved: true }
      } catch (error) {
        nativeError = error
        nativeFailed = true
      }
      // IPC requests may settle out of order. A late failure must not replace
      // recovery history after a newer native checkpoint has been acknowledged.
      if (savedAt <= this.lastNativeSavedAt) return { saved: true, primarySaved: true }
    }
    if (savedAt <= this.lastCacheSavedAt) return { saved: true, primarySaved: !nativeSave }
    history = carryNativeProjectionAdmissions(history, refreshConversationSources(history))

    // Native checkpoints are the primary durable store. Serializing, hashing,
    // and synchronously writing a second complete history every two seconds
    // blocks input, and large histories exceed localStorage's quota anyway.
    // Keep an exact local fallback only when disk persistence is unavailable.
    let cacheFailed = false
    try {
      const written = await Effect.runPromise(this.writeCacheEffect(history, savedAt))
      if (!written) return { saved: true, primarySaved: savedAt <= this.lastNativeSavedAt }
    } catch {
      cacheFailed = true
    }
    let warning = ''
    if (nativeFailed)
      warning = cacheFailed
        ? `Conversation history could not be saved to disk or the local cache. Keep this window open. ${errorText(nativeError)}`
        : `Conversation history is kept in the local cache, but the disk checkpoint failed. ${errorText(nativeError)}`
    else if (cacheFailed)
      warning =
        'Conversation history could not be saved locally. Keep this window open and free storage space.'
    this.warn(warning, savedAt)
    return {
      saved: !cacheFailed,
      primarySaved: !nativeSave && !cacheFailed,
    }
  }

  private readonly writeCacheEffect = Effect.fnUntraced(
    function* (this: ConversationHistoryPersistence, history: Thread[], savedAt: number) {
      if (savedAt <= this.lastNativeSavedAt || savedAt <= this.lastCacheSavedAt) return false
      const storage = yield* Effect.try({
        try: () => this.options.getStorage(),
        catch: (cause) => new ConversationCacheWriteError({ cause }),
      })
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
        return yield* new ConversationCacheWriteError({
          cause: new Error('The unreadable original local history cache was preserved.'),
        })
      const serialized = yield* Effect.try({
        try: () => JSON.stringify(history),
        catch: (cause) => new ConversationCacheWriteError({ cause }),
      })
      const prepare = this.options.getPrepareRecoveryCache?.()
      const admissions = nativeProjectionAdmissions(history)
      const membershipAdmissions = nativeProjectionMembershipAdmissions(history)
      if (prepare && (admissions || membershipAdmissions)) {
        // A native preparation grants authority to these exact bytes without
        // claiming that either Storage write has happened. Failed preparation
        // leaves ordinary archival fallback available with no capability.
        yield* hashSerializedConversationCacheEffect(serialized).pipe(
          Effect.flatMap((hash) =>
            Effect.tryPromise({
              try: () =>
                prepare({
                  snapshotId: `main-cache:${savedAt}:${crypto.randomUUID()}`,
                  hash,
                  savedAt,
                  projectionAdmissions: admissions ?? [],
                  ...(membershipAdmissions ? { membershipAdmissions } : {}),
                }),
              catch: (cause) => new ConversationCacheWriteError({ cause }),
            }),
          ),
          Effect.catch(() => Effect.void),
        )
        // Hashing and native fsync can outlive a newer draft or terminal
        // checkpoint. Its prepared record remains valid for its own bytes;
        // it cannot replace the newer renderer write intent.
        if (savedAt < this.lastSavedAt) return false
      }
      if (savedAt <= this.lastNativeSavedAt || savedAt <= this.lastCacheSavedAt) return false
      yield* Effect.try({
        try: () => {
          storage.setItem(CONVERSATION_HISTORY_KEY, serialized)
          storage.setItem(
            conversationCheckpointKey,
            JSON.stringify({
              savedAt,
              fingerprint: conversationCacheFingerprint(serialized),
            }),
          )
        },
        catch: (cause) => new ConversationCacheWriteError({ cause }),
      })
      this.lastCacheSavedAt = savedAt
      acknowledgeConversationSources(history, savedAt)
      return true
    }.bind(this),
    (effect) => this.cacheWrites.withPermits(1)(effect),
  )

  private warn(warning: string, savedAt: number): void {
    if (savedAt < this.lastWarningAt) return
    if (warning && warning !== this.lastWarning) this.options.onError(warning)
    this.lastWarning = warning
    this.lastWarningAt = savedAt
  }
}

export function useConversationPersistence(
  threads: Thread[],
  nativeSave: NativeSave | undefined,
  onError: (message: string) => void,
  enabled: boolean,
  nativeCheckpoint?: NativeConversationCheckpoint,
  supportsMessageFields = false,
  supportsMessageAppends = false,
  prepareRecoveryCache?: NativePrepareRecoveryCache,
) {
  const current = useRef({
    threads,
    nativeSave,
    nativeCheckpoint,
    prepareRecoveryCache,
    supportsMessageFields,
    supportsMessageAppends,
    onError,
    enabled,
  })
  current.current = {
    threads,
    nativeSave,
    nativeCheckpoint,
    prepareRecoveryCache,
    supportsMessageFields,
    supportsMessageAppends,
    onError,
    enabled,
  }
  const checkpoint = useRef<ConversationHistoryPersistence | null>(null)
  checkpoint.current ||= new ConversationHistoryPersistence({
    getThreads: () => current.current.threads,
    getNativeSave: () => current.current.nativeSave,
    getNativeCheckpoint: () => current.current.nativeCheckpoint,
    getPrepareRecoveryCache: () => current.current.prepareRecoveryCache,
    supportsMessageFields: () => current.current.supportsMessageFields,
    supportsMessageAppends: () => current.current.supportsMessageAppends,
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
  const adoptNativeCheckpoint = useCallback(
    (snapshot: Thread[], savedAt: number, rawSource = false) =>
      persistence.adoptNativeCheckpoint(snapshot, savedAt, rawSource),
    [persistence],
  )
  return { flush, advanceClock, adoptNativeCheckpoint }
}
