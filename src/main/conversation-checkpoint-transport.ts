import { join } from 'node:path'
import { Worker } from 'node:worker_threads'
import { Context, Effect, Fiber, Scope, Semaphore } from 'effect'
import type {
  ConversationCheckpointAck,
  ConversationHistorySnapshot,
  ConversationProjectionAdmission,
} from '../shared/conversations'
import { PersistenceError, persistenceError } from './persistence-effects'
import type { ConversationRecoveryProof } from './conversation-recovery-sidecar'
import type { NativeRecoveryPersistenceMode } from './native-recovery-platform'

export type CheckpointCommand =
  | { type: 'load' }
  | { type: 'loadEncoded' }
  | { type: 'loadRecoveryReceipt' }
  | { type: 'save'; threads: unknown[]; savedAt: number; projectionAdmissions?: unknown }
  | { type: 'checkpoint'; input: unknown }

export interface CheckpointRequest {
  id: number
  command: CheckpointCommand
}
export type CheckpointResult =
  | ConversationHistorySnapshot
  | ConversationCheckpointAck
  | ConversationRecoveryProof
  | ArrayBuffer
  | null
export type CheckpointResponse =
  | { id: number; result: CheckpointResult }
  | { id: number; error: { operation: string; path: string; message: string; cause: unknown } }

export interface CheckpointRecoveryPreparation {
  type: 'recoveryPrepare'
  admissionId: number
  proof: ConversationRecoveryProof
  projectionAdmissions: readonly ConversationProjectionAdmission[]
}
export type CheckpointRecoveryAdmission = {
  type: 'recoveryAdmission'
  admissionId: number
} & (
  | { proof: ConversationRecoveryProof | null }
  | { error: { operation: string; path: string; message: string; cause: unknown } }
)
export type AuthorizeConversationRecoveryReceipt = (
  candidate: ConversationRecoveryProof,
  projectionAdmissions: readonly ConversationProjectionAdmission[],
) => Effect.Effect<ConversationRecoveryProof | null, unknown>

export class ConversationCheckpointTransport extends Context.Service<
  ConversationCheckpointTransport,
  {
    execute(command: CheckpointCommand): Effect.Effect<CheckpointResult, PersistenceError>
  }
>()('life/conversations/ConversationCheckpointTransport') {}

export const workerCheckpointTransport = Effect.fn('ConversationCheckpointTransport.worker')(
  function* (
    directory: string,
    workerPath = join(__dirname, 'conversation-checkpoint-worker.js'),
    authorizeRecoveryReceipt?: AuthorizeConversationRecoveryReceipt,
    persistenceMode: NativeRecoveryPersistenceMode = 'native-protected',
  ): Effect.fn.Return<ConversationCheckpointTransport['Service'], PersistenceError, Scope.Scope> {
    const path = join(directory, 'conversations.json')
    const scope = yield* Effect.scope
    const worker = yield* Effect.acquireRelease(
      Effect.try({
        try: () => new Worker(workerPath, { workerData: { directory, persistenceMode } }),
        catch: (cause) => persistenceError('worker', path, cause),
      }),
      (worker) => Effect.promise(() => worker.terminate()).pipe(Effect.asVoid),
    )
    const pending = new Map<
      number,
      (effect: Effect.Effect<CheckpointResult, PersistenceError>) => void
    >()
    let sequence = 0
    let failure: PersistenceError | undefined
    const failWorker = (cause: unknown) => {
      failure ??= persistenceError('worker', path, cause)
      for (const resume of pending.values()) resume(Effect.fail(failure))
      pending.clear()
      worker.unref()
    }
    const onMessage = (response: CheckpointResponse | CheckpointRecoveryPreparation) => {
      if ('type' in response) {
        if (response.type !== 'recoveryPrepare') return
        if (failure || scope.state._tag === 'Closed') return
        const authorization = Effect.suspend(() => {
          if (failure || scope.state._tag === 'Closed')
            return Effect.fail(
              failure ?? persistenceError('worker', path, new Error('Conversation writer closed.')),
            )
          return authorizeRecoveryReceipt
            ? authorizeRecoveryReceipt(response.proof, response.projectionAdmissions)
            : Effect.succeed(null)
        }).pipe(
          Effect.matchCause({
            onFailure: () =>
              ({
                type: 'recoveryAdmission',
                admissionId: response.admissionId,
                error: {
                  operation: 'recovery-prepare',
                  path,
                  message: 'Native history recovery preparation failed.',
                  cause: undefined,
                },
              }) satisfies CheckpointRecoveryAdmission,
            onSuccess: (proof) =>
              ({
                type: 'recoveryAdmission',
                admissionId: response.admissionId,
                proof,
              }) satisfies CheckpointRecoveryAdmission,
          }),
          Effect.flatMap((admission) =>
            Effect.sync(() => {
              if (!failure && scope.state._tag !== 'Closed') worker.postMessage(admission)
            }),
          ),
          Effect.catchCause(() =>
            Effect.sync(() =>
              failWorker(new Error('Native history preparation transport failed.')),
            ),
          ),
        )
        // The EventEmitter listener is the adapter boundary; the enclosing
        // transport scope owns every admission fiber and its cancellation.
        void Effect.runPromise(
          Effect.forkIn(authorization, scope, { startImmediately: true }),
        ).catch(() => {
          failWorker(new Error('Native history preparation transport closed.'))
        })
        return
      }
      const resume = pending.get(response.id)
      if (!resume) return
      pending.delete(response.id)
      if ('error' in response) resume(Effect.fail(new PersistenceError(response.error)))
      else resume(Effect.succeed(response.result))
      if (pending.size === 0) worker.unref()
    }
    const onExit = (code: number) =>
      failWorker(new Error(`Conversation writer exited with code ${code}.`))
    yield* Effect.acquireRelease(
      Effect.sync(() => {
        worker.on('message', onMessage)
        worker.on('error', failWorker)
        worker.on('exit', onExit)
        worker.unref()
      }),
      () =>
        Effect.sync(() => {
          worker.off('message', onMessage)
          worker.off('error', failWorker)
          worker.off('exit', onExit)
          failWorker(new Error('Conversation writer closed.'))
        }),
    )
    const lock = yield* Semaphore.make(1)
    const execute = Effect.fn('ConversationCheckpointTransport.execute')(
      (command: CheckpointCommand) =>
        Effect.uninterruptibleMask((restore) =>
          Effect.gen(function* () {
            if (failure) return yield* failure
            let posted = false
            const operation = yield* Effect.forkIn(
              lock.withPermit(
                Effect.callback<CheckpointResult, PersistenceError>((resume) => {
                  if (failure) return resume(Effect.fail(failure))
                  if (scope.state._tag === 'Closed')
                    return resume(
                      Effect.fail(
                        persistenceError('worker', path, new Error('Conversation writer closed.')),
                      ),
                    )
                  const id = ++sequence
                  pending.set(id, resume)
                  worker.ref()
                  posted = true
                  try {
                    worker.postMessage({ id, command } satisfies CheckpointRequest)
                  } catch (cause) {
                    pending.delete(id)
                    if (pending.size === 0) worker.unref()
                    resume(Effect.fail(persistenceError('worker', path, cause)))
                  }
                  return Effect.sync(() => {
                    pending.delete(id)
                    if (pending.size === 0) worker.unref()
                  })
                }),
              ),
              scope,
              { startImmediately: true },
            )
            // A posted request owns the permit until its response, even when its
            // caller detaches. Unposted waiters can be cancelled immediately.
            // Scope closure interrupts both kinds and then terminates the worker.
            return yield* restore(Fiber.join(operation)).pipe(
              Effect.onInterrupt(() => (posted ? Effect.void : Fiber.interrupt(operation))),
            )
          }),
        ),
    )
    return ConversationCheckpointTransport.of({ execute })
  },
)
