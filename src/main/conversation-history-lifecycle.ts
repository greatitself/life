import { Cause, Effect, Exit } from 'effect'
import type { ConversationStore } from './conversation-store'
import { PersistenceError } from './persistence-effects'
import type { RendererDocumentAdmission } from './renderer-recovery'

export interface CapturedHistoryDocument {
  admission: RendererDocumentAdmission
  revision: number
  ownsDocument(): boolean
}

type HistoryStore = Pick<ConversationStore, 'settledWithinEffect' | 'closeEffect'>

export const historyUncertaintyMessage =
  'Life could not confirm that your latest history was saved. New work is paused. Close and reopen Life to inspect saved history before continuing.'

/** Cleanup failures are observed independently; none can skip later owned resources. */
export const finishNativeShutdownEffect = Effect.fn('finishNativeShutdown')(function* (
  phases: readonly Effect.Effect<unknown, unknown>[],
  report: (error: unknown) => void,
) {
  for (const phase of phases) {
    const result = yield* Effect.exit(phase)
    if (Exit.isFailure(result))
      yield* Effect.try(() => report(Cause.squash(result.cause))).pipe(Effect.ignore)
  }
}, Effect.uninterruptible)

/** One native history actor retains uncertainty until the main process exits. */
export class ConversationHistoryLifecycle {
  private uncertainty?: PersistenceError
  private activeHandoffs = 0
  private handoffFailed = false
  private readonly committedDuringHandoff = new Set<RendererDocumentAdmission>()
  private readonly handoffs = new WeakMap<
    RendererDocumentAdmission,
    { count: number; committed: boolean; failed: boolean }
  >()

  get failure(): PersistenceError | undefined {
    return this.uncertainty
  }

  capture(
    admission: RendererDocumentAdmission,
    ownsDocument: () => boolean = () => true,
  ): CapturedHistoryDocument {
    const revision = admission.documentRevision
    return {
      admission,
      revision,
      ownsDocument: () => admission.documentRevision === revision && ownsDocument(),
    }
  }

  assertHealthy(): void {
    if (this.uncertainty) throw this.uncertainty
  }

  assertCanCreateDocument(): void {
    this.assertHealthy()
    if (this.activeHandoffs)
      throw new Error(
        'Life is still saving history before changing its interface. Try again when it finishes.',
      )
  }

  admit(admission: RendererDocumentAdmission, channel: string): void {
    if (this.activeHandoffs) admission.suspend()
    if (this.uncertainty) {
      admission.suspend()
      if (
        !admission.allows(channel) ||
        channel === 'conversations:save' ||
        channel === 'conversations:checkpoint'
      )
        throw this.uncertainty
    }
    if (!admission.allows(channel))
      throw new Error('Life is restarting its interface. Try again when the workspace returns.')
  }

  commitDocument(admission: RendererDocumentAdmission): void {
    const handoff = this.handoffs.get(admission)
    if (handoff) handoff.committed = true
    if (this.activeHandoffs) this.committedDuringHandoff.add(admission)
    admission.commitMainDocument(!this.uncertainty && !this.activeHandoffs)
  }

  /** Navigation can commit during a handoff, but admission waits for real healthy settlement. */
  readonly handoffEffect = Effect.fn('ConversationHistoryLifecycle.handoff')(function* <E>(
    this: ConversationHistoryLifecycle,
    store: HistoryStore | undefined,
    document: CapturedHistoryDocument | undefined,
    beforeSettlement: Effect.Effect<void, E>,
  ): Effect.fn.Return<void, E | PersistenceError> {
    if (this.uncertainty) return yield* this.uncertainty
    yield* Effect.acquireUseRelease(
      Effect.sync(() => {
        // A native commit can win the scheduler boundary after Main's owner
        // check. Claim only the captured document in this atomic acquisition.
        if (document && !document.ownsDocument()) return
        this.activeHandoffs++
        if (!document) return {}
        const admission = document.admission
        const handoff = this.handoffs.get(admission) ?? {
          count: 0,
          committed: false,
          failed: false,
        }
        handoff.count++
        this.handoffs.set(admission, handoff)
        admission.suspend()
        return { admission, handoff }
      }),
      (owned) =>
        owned
          ? beforeSettlement.pipe(Effect.andThen(this.settledEffect(store, document)))
          : Effect.void,
      (owned, result) =>
        Effect.sync(() => {
          if (!owned) return
          if (Exit.isFailure(result)) this.handoffFailed = true
          if (owned.handoff) {
            if (Exit.isFailure(result)) owned.handoff.failed = true
            if (!--owned.handoff.count) this.handoffs.delete(owned.admission)
          }
          if (--this.activeHandoffs) return
          if (!this.handoffFailed && !this.uncertainty)
            for (const admission of this.committedDuringHandoff) admission.resume()
          this.committedDuringHandoff.clear()
          this.handoffFailed = false
        }),
    )
  })

  readonly settledEffect = Effect.fn('ConversationHistoryLifecycle.settled')(function* (
    this: ConversationHistoryLifecycle,
    store: HistoryStore | undefined,
    document?: CapturedHistoryDocument,
  ): Effect.fn.Return<void, PersistenceError> {
    if (this.uncertainty) return yield* this.uncertainty
    if (store)
      yield* store.settledWithinEffect().pipe(
        Effect.tapError((error) => Effect.sync(() => this.retainFailure(error, document))),
        Effect.mapError((error) => this.uncertainty ?? error),
      )
  })

  readonly closeEffect = Effect.fn('ConversationHistoryLifecycle.close')(function* (
    this: ConversationHistoryLifecycle,
    store: HistoryStore | undefined,
    document?: CapturedHistoryDocument,
  ): Effect.fn.Return<void, PersistenceError> {
    // A poisoned Store still owns cleanup; do not bypass its close finalizers.
    if (store)
      yield* store.closeEffect().pipe(
        Effect.tapError((error) => Effect.sync(() => this.retainFailure(error, document))),
        Effect.mapError((error) => this.uncertainty ?? error),
      )
    if (this.uncertainty) return yield* this.uncertainty
  })

  private retainFailure(error: PersistenceError, document?: CapturedHistoryDocument): void {
    if (error.operation !== 'shutdown-uncertain') return
    this.uncertainty ??= new PersistenceError({
      operation: error.operation,
      path: error.path,
      message: historyUncertaintyMessage,
      cause: error,
    })
    // A stale completion poisons the actor, but cannot alter a fresh document's
    // revision. Its dispatch/commit edges enforce the same permanent gate.
    if (document?.ownsDocument()) document.admission.suspend()
  }
}
