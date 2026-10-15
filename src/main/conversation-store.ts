import { join } from 'node:path'
import { Deferred, Effect, Exit, Fiber, Option, Schema, Scope, Semaphore } from 'effect'
import type {
  ConversationCheckpointAck,
  ConversationHistorySnapshot,
  ConversationProjectionAdmission,
} from '../shared/conversations'
import { runEffect } from './effect-runtime'
import { persistenceError } from './persistence-effects'
import type { PersistenceError } from './persistence-effects'
import {
  workerCheckpointTransport,
  type CheckpointCommand,
  type ConversationCheckpointTransport,
  type AuthorizeConversationRecoveryReceipt,
} from './conversation-checkpoint-transport'
import type { ConversationRecoveryProof } from './conversation-recovery-sidecar'
import {
  assertOrdinaryRecoveryStateEffect,
  type NativeRecoveryPersistenceMode,
} from './native-recovery-platform'

interface PendingWrite {
  command: Exclude<CheckpointCommand, { type: 'load' | 'loadEncoded' | 'loadRecoveryReceipt' }>
  subscribers: Set<Deferred.Deferred<ConversationCheckpointAck, PersistenceError>>
}

// Only this constant-size discriminator is inspected on the main thread.
const decodeBase = Schema.decodeUnknownOption(
  Schema.Struct({
    version: Schema.Literals([1]),
    baseSavedAt: Schema.NullOr(Schema.Int.check(Schema.isGreaterThanOrEqualTo(0))),
  }),
)
const shutdownGraceSchema = Schema.Int.check(
  Schema.isGreaterThan(0),
  Schema.isLessThanOrEqualTo(2_147_483_647),
)
const decodeShutdownGrace = Schema.decodeUnknownEffect(shutdownGraceSchema)
const decodePersistenceMode = Schema.decodeUnknownSync(
  Schema.Literals(['native-protected', 'ordinary', 'read-only']),
)

export const DEFAULT_CONVERSATION_SHUTDOWN_GRACE_MS = 10_000

function canCoalesce(previous: PendingWrite['command'], next: PendingWrite['command']): boolean {
  if (previous.type === 'save' && next.type === 'save') return true
  if (previous.type !== 'checkpoint' || next.type !== 'checkpoint') return false
  const priorBase = decodeBase(previous.input)
  const nextBase = decodeBase(next.input)
  return (
    Option.isSome(priorBase) &&
    Option.isSome(nextBase) &&
    priorBase.value.baseSavedAt === nextBase.value.baseSavedAt
  )
}

export interface ConversationStoreOptions {
  workerPath?: string
  /** Main selects the verified platform mode before this actor can own a worker. */
  persistenceMode?: NativeRecoveryPersistenceMode
  /** Shutdown policy only; ordinary writes and caller cancellation retain their existing lifetime. */
  shutdownGraceMs?: number
  /** Successful worker commits acknowledge native retention before renderer subscribers settle. */
  onCommitted?: (ack: ConversationCheckpointAck) => Effect.Effect<void, unknown>
  /** Native-owned admission runs before the worker stages any recovery proof. */
  authorizeRecoveryReceipt?: AuthorizeConversationRecoveryReceipt
  /** A scoped transport allows deterministic domain tests without replacing worker ownership in production. */
  transport?: Effect.Effect<
    ConversationCheckpointTransport['Service'],
    PersistenceError,
    Scope.Scope
  >
}

/** One scoped worker, one active write and one coalesced pending checkpoint. */
export class ConversationStore {
  private readonly path: string
  private readonly scope = Scope.makeUnsafe()
  private readonly closeLock = Semaphore.makeUnsafe(1)
  private readonly requestLock = Semaphore.makeUnsafe(1)
  private transport?: ConversationCheckpointTransport['Service']
  private transportScope?: Scope.Closeable
  private active?: PendingWrite
  private pending?: PendingWrite
  private draining?: Fiber.Fiber<void>
  private drainOwner?: object
  private closed = false
  private shutdownError?: PersistenceError
  private readonly shutdownGraceMs: number
  private readonly persistenceMode: NativeRecoveryPersistenceMode

  constructor(
    private readonly directory: string,
    private readonly options: ConversationStoreOptions = {},
  ) {
    this.path = join(directory, 'conversations.json')
    try {
      this.persistenceMode = decodePersistenceMode(options.persistenceMode ?? 'native-protected')
    } catch (cause) {
      throw persistenceError('recovery-platform', this.path, cause)
    }
    try {
      this.shutdownGraceMs = Schema.decodeUnknownSync(shutdownGraceSchema)(
        options.shutdownGraceMs ?? DEFAULT_CONVERSATION_SHUTDOWN_GRACE_MS,
      )
    } catch (cause) {
      throw persistenceError('shutdown-budget', this.path, cause)
    }
  }

  load(): Promise<ConversationHistorySnapshot | null> {
    return runEffect(this.loadEffect())
  }

  readonly loadEffect = Effect.fn('ConversationStore.load')(function* (this: ConversationStore) {
    if (this.shutdownError) return yield* this.shutdownError
    if (this.closed)
      return yield* persistenceError(
        'closed',
        this.path,
        new Error('Conversation store is closed.'),
      )
    yield* this.settledEffect()
    return (yield* this.executeEffect({ type: 'load' })) as ConversationHistorySnapshot | null
  })

  loadEncoded(): Promise<ArrayBuffer | null> {
    return runEffect(this.loadEncodedEffect())
  }

  readonly loadEncodedEffect = Effect.fn('ConversationStore.loadEncoded')(function* (
    this: ConversationStore,
  ) {
    if (this.shutdownError) return yield* this.shutdownError
    if (this.closed)
      return yield* persistenceError(
        'closed',
        this.path,
        new Error('Conversation store is closed.'),
      )
    yield* this.settledEffect()
    return (yield* this.executeEffect({ type: 'loadEncoded' })) as ArrayBuffer | null
  })

  readonly loadRecoveryReceiptEffect = Effect.fn('ConversationStore.loadRecoveryReceipt')(
    function* (this: ConversationStore) {
      if (this.shutdownError) return yield* this.shutdownError
      if (this.closed)
        return yield* persistenceError(
          'closed',
          this.path,
          new Error('Conversation store is closed.'),
        )
      yield* this.settledEffect()
      return (yield* this.executeEffect({
        type: 'loadRecoveryReceipt',
      })) as ConversationRecoveryProof | null
    },
  )

  save(
    threads: unknown[],
    savedAt = Date.now(),
    projectionAdmissions?: readonly ConversationProjectionAdmission[],
  ): Promise<void> {
    return runEffect(this.saveEffect(threads, savedAt, projectionAdmissions))
  }

  readonly saveEffect = Effect.fn('ConversationStore.save')(function* (
    this: ConversationStore,
    threads: unknown[],
    savedAt = Date.now(),
    projectionAdmissions?: unknown,
  ) {
    yield* this.enqueueEffect({
      type: 'save',
      threads,
      savedAt,
      ...(projectionAdmissions !== undefined ? { projectionAdmissions } : {}),
    })
  })

  saveCheckpoint(input: unknown): Promise<ConversationCheckpointAck> {
    return runEffect(this.saveCheckpointEffect(input))
  }

  readonly saveCheckpointEffect = Effect.fn('ConversationStore.saveCheckpoint')(function* (
    this: ConversationStore,
    input: unknown,
  ) {
    return yield* this.enqueueEffect({ type: 'checkpoint', input })
  })

  private readonly enqueueEffect = Effect.fnUntraced(function* (
    this: ConversationStore,
    command: PendingWrite['command'],
  ) {
    if (this.persistenceMode === 'read-only')
      return yield* persistenceError(
        'recovery-platform',
        this.path,
        new Error(
          'Protected history is read-only on this platform. Its original files were preserved.',
        ),
      )
    if (this.persistenceMode === 'ordinary')
      yield* assertOrdinaryRecoveryStateEffect(this.directory).pipe(
        Effect.mapError((cause) => persistenceError('recovery-platform', this.path, cause)),
      )
    return yield* Effect.uninterruptibleMask((restore) =>
      Effect.gen({ self: this }, function* () {
        const { checkpoint, completion } = yield* this.admitEffect(command)
        // Once published, the accepted write owns its scoped drain. Cancellation
        // can detach this caller only after launch ownership has been established.
        return yield* restore(Deferred.await(completion)).pipe(
          Effect.ensuring(
            Effect.sync(() => {
              checkpoint.subscribers.delete(completion)
            }),
          ),
        )
      }),
    )
  })

  private readonly admitEffect = Effect.fnUntraced(function* (
    this: ConversationStore,
    command: PendingWrite['command'],
  ) {
    if (this.shutdownError) return yield* this.shutdownError
    if (this.closed)
      return yield* persistenceError(
        'closed',
        this.path,
        new Error('Conversation store is closed.'),
      )
    const completion = yield* Deferred.make<ConversationCheckpointAck, PersistenceError>()
    // Allocation may yield to shutdown or another admission. Revalidate before
    // publishing the subscriber, and derive coalescing from the current queue.
    const retired = this.shutdownError as PersistenceError | undefined
    if (retired) return yield* retired
    if (this.closed)
      return yield* persistenceError(
        'closed',
        this.path,
        new Error('Conversation store is closed.'),
      )
    const checkpoint = this.pending ?? {
      command,
      subscribers: new Set<Deferred.Deferred<ConversationCheckpointAck, PersistenceError>>(),
    }
    if (this.pending && !canCoalesce(checkpoint.command, command))
      return yield* persistenceError(
        'queue',
        this.path,
        new Error(
          'A conversation checkpoint with a different base is already queued. Retry after the active checkpoint.',
        ),
      )
    checkpoint.command = command
    checkpoint.subscribers.add(completion)
    this.pending = checkpoint
    if (!this.drainOwner) {
      const owner = (this.drainOwner = {})
      const draining = yield* Effect.forkIn(this.drainEffect(owner), this.scope, {
        startImmediately: false,
      })
      if (this.drainOwner === owner) this.draining = draining
    }
    return { checkpoint, completion }
  })

  settled(): Promise<void> {
    return runEffect(this.settledEffect())
  }

  readonly settledEffect = Effect.fnUntraced(function* (
    this: ConversationStore,
  ): Effect.fn.Return<void, PersistenceError> {
    if (this.shutdownError) return yield* this.shutdownError
    while (this.drainOwner) {
      if (this.draining) yield* Fiber.await(this.draining)
      else yield* Effect.yieldNow
    }
    const outcome = this.shutdownError as PersistenceError | undefined
    if (outcome) return yield* outcome
  })

  settledWithin(graceMs?: number): Promise<void> {
    return runEffect(this.settledWithinEffect(graceMs))
  }

  /** Lifecycle barriers may retire a silent worker; a healthy barrier leaves the store open. */
  readonly settledWithinEffect = Effect.fn('ConversationStore.settledWithin')((graceMs?: number) =>
    this.closeLock.withPermit(this.waitWithinEffect(graceMs)),
  )

  close(): Promise<void> {
    return runEffect(this.closeEffect())
  }

  readonly closeEffect = Effect.fn('ConversationStore.close')(() =>
    this.closeLock.withPermit(
      Effect.gen({ self: this }, function* () {
        this.closed = true
        yield* this.waitWithinEffect()
        // The bounded barrier drained the current request. Closed-store guards
        // prevent queued readers from using or recreating the owned transport.
        yield* Scope.close(this.scope, Exit.void)
      }).pipe(Effect.uninterruptible),
    ),
  )

  private readonly waitWithinEffect = Effect.fnUntraced(function* (
    this: ConversationStore,
    graceMs?: number,
  ): Effect.fn.Return<void, PersistenceError> {
    if (this.shutdownError) return yield* this.shutdownError
    const grace = yield* decodeShutdownGrace(graceMs ?? this.shutdownGraceMs).pipe(
      Effect.mapError((cause) => persistenceError('shutdown-budget', this.path, cause)),
    )
    const settled = yield* Effect.gen({ self: this }, function* () {
      yield* this.settledEffect()
      yield* this.requestLock.withPermit(Effect.void)
    }).pipe(Effect.interruptible, Effect.timeoutOption(grace))
    if (Option.isSome(settled)) return
    return yield* this.retireUncertainEffect().pipe(Effect.uninterruptible)
  })

  private readonly retireUncertainEffect = Effect.fnUntraced(function* (
    this: ConversationStore,
  ): Effect.fn.Return<never, PersistenceError> {
    const error = (this.shutdownError ??= persistenceError(
      'shutdown-uncertain',
      this.path,
      new Error(
        'The conversation writer did not acknowledge accepted work before shutdown. Its disk outcome is unknown. Reopen Life to inspect saved history before retrying.',
      ),
    ))
    this.closed = true
    const outstanding = [this.active, this.pending]
    this.pending = undefined
    for (const checkpoint of outstanding) {
      if (!checkpoint) continue
      for (const completion of checkpoint.subscribers) yield* Deferred.fail(completion, error)
      checkpoint.subscribers.clear()
    }
    // The unanswered request owns requestLock. Close its resource scope directly;
    // scope finalizers await the actual worker exit, without claiming disk rollback.
    yield* Scope.close(this.scope, Exit.void)
    this.transport = undefined
    this.transportScope = undefined
    this.active = undefined
    this.pending = undefined
    this.draining = undefined
    this.drainOwner = undefined
    return yield* error
  })

  private readonly executeEffect = Effect.fn('ConversationStore.execute')(
    (command: CheckpointCommand) =>
      this.requestLock
        .withPermit(
          Effect.gen({ self: this }, function* () {
            if (this.shutdownError) return yield* this.shutdownError
            if (
              this.scope.state._tag === 'Closed' ||
              (this.closed &&
                (command.type === 'load' ||
                  command.type === 'loadEncoded' ||
                  command.type === 'loadRecoveryReceipt'))
            )
              return yield* persistenceError(
                'closed',
                this.path,
                new Error('Conversation store is closed.'),
              )
            if (command.type === 'save' || command.type === 'checkpoint') {
              if (this.persistenceMode === 'read-only')
                return yield* persistenceError(
                  'recovery-platform',
                  this.path,
                  new Error(
                    'Protected history remains read-only. No replacement writer was started.',
                  ),
                )
              if (this.persistenceMode === 'ordinary')
                yield* assertOrdinaryRecoveryStateEffect(this.directory).pipe(
                  Effect.mapError((cause) =>
                    persistenceError('recovery-platform', this.path, cause),
                  ),
                )
              const afterGuard = yield* Effect.sync(() => ({
                retired: this.shutdownError,
                closed: this.scope.state._tag === 'Closed',
              }))
              if (afterGuard.retired) return yield* afterGuard.retired
              if (afterGuard.closed)
                return yield* persistenceError(
                  'closed',
                  this.path,
                  new Error('Conversation store is closed.'),
                )
            }
            if (!this.transport) {
              const scope = yield* Scope.fork(this.scope)
              const acquired = yield* Effect.exit(
                (
                  this.options.transport ??
                  workerCheckpointTransport(
                    this.directory,
                    this.options.workerPath,
                    this.options.authorizeRecoveryReceipt
                      ? (proof, admissions) =>
                          Effect.suspend(() => {
                            if (this.shutdownError) return Effect.fail(this.shutdownError)
                            if (this.scope.state._tag === 'Closed')
                              return Effect.fail(
                                persistenceError(
                                  'closed',
                                  this.path,
                                  new Error('Conversation store is closed.'),
                                ),
                              )
                            return this.options.authorizeRecoveryReceipt!(proof, admissions)
                          })
                      : undefined,
                    this.persistenceMode,
                  )
                ).pipe(Effect.provideService(Scope.Scope, scope)),
              )
              if (Exit.isFailure(acquired)) {
                yield* Scope.close(scope, acquired)
                return yield* acquired
              }
              this.transport = acquired.value
              this.transportScope = scope
            }
            return yield* this.transport.execute(command).pipe(
              Effect.tapError((error) =>
                Effect.gen({ self: this }, function* () {
                  if (error.operation !== 'worker') return
                  const scope = this.transportScope
                  this.transport = undefined
                  this.transportScope = undefined
                  // Closing the child detaches its finalizers, keeping repeated startup retries bounded.
                  if (scope) yield* Scope.close(scope, Exit.void)
                }),
              ),
            )
          }),
        )
        .pipe(
          Effect.catchCause((cause) =>
            this.shutdownError ? Effect.fail(this.shutdownError) : Effect.failCause(cause),
          ),
        ),
  )

  private readonly drainEffect = Effect.fnUntraced(function* (
    this: ConversationStore,
    owner: object,
  ) {
    yield* Effect.addFinalizer(() =>
      Effect.sync(() => {
        if (this.drainOwner !== owner) return
        this.active = undefined
        this.draining = undefined
        this.drainOwner = undefined
      }),
    )
    yield* Effect.yieldNow
    while (this.pending) {
      const checkpoint = this.pending
      this.pending = undefined
      this.active = checkpoint
      const exit = yield* Effect.exit(
        this.executeEffect(checkpoint.command).pipe(
          Effect.map((value) => value as ConversationCheckpointAck),
        ),
      )
      if (Exit.isSuccess(exit) && this.options.onCommitted)
        yield* Effect.suspend(() =>
          this.shutdownError ? Effect.void : this.options.onCommitted!(exit.value),
        ).pipe(
          // A failed native acknowledgement leaves its ledger retained. The
          // accepted history remains durable and must not trigger a resave loop.
          Effect.catchCause(() => Effect.void),
        )
      for (const completion of checkpoint.subscribers) {
        if (this.shutdownError) yield* Deferred.fail(completion, this.shutdownError)
        else yield* Deferred.done(completion, exit)
      }
      checkpoint.subscribers.clear()
      this.active = undefined
    }
    // Relinquish normal drain ownership before returning. If a new submission
    // arrives while scoped cleanup runs, this drain's finalizer cannot clear it.
    if (this.drainOwner === owner) {
      this.draining = undefined
      this.drainOwner = undefined
    }
  }, Effect.scoped)
}
