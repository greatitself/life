import { parentPort, workerData } from 'node:worker_threads'
import { Cause, Effect, Exit, Queue, Schema } from 'effect'
import { ConversationCheckpointEngine } from './conversation-checkpoint-engine'
import type {
  CheckpointRequest,
  CheckpointResponse,
  CheckpointCommand,
  CheckpointRecoveryPreparation,
  CheckpointRecoveryAdmission,
} from './conversation-checkpoint-transport'
import type { ConversationRecoveryProof } from './conversation-recovery-sidecar'
import { PersistenceError, persistenceError } from './persistence-effects'

const commandSchema = Schema.Union([
  Schema.Struct({ type: Schema.Literals(['load']) }),
  Schema.Struct({ type: Schema.Literals(['loadEncoded']) }),
  Schema.Struct({ type: Schema.Literals(['loadRecoveryReceipt']) }),
  Schema.Struct({
    type: Schema.Literals(['save']),
    threads: Schema.Array(Schema.Unknown),
    savedAt: Schema.Number,
    projectionAdmissions: Schema.optional(Schema.Unknown),
  }),
  Schema.Struct({ type: Schema.Literals(['checkpoint']), input: Schema.Unknown }),
])
const requestSchema = Schema.Struct({ id: Schema.Int, command: commandSchema })
const decodeRequest = Schema.decodeUnknownEffect(requestSchema)
const decodeData = Schema.decodeUnknownEffect(
  Schema.Struct({
    directory: Schema.String,
    persistenceMode: Schema.optional(
      Schema.Literals(['native-protected', 'ordinary', 'read-only']),
    ),
  }),
)

/** The worker queue and port listeners belong to this scope; the parent owns its lifetime. */
const run = Effect.scoped(
  Effect.gen(function* () {
    const port = parentPort
    if (!port)
      return yield* Effect.die(new Error('Conversation checkpoint writer requires a parent port.'))
    const { directory, persistenceMode } = yield* decodeData(workerData)
    const admissions = new Map<
      number,
      (effect: Effect.Effect<ConversationRecoveryProof | null, PersistenceError>) => void
    >()
    let nextAdmissionId = 0
    const engine = new ConversationCheckpointEngine(directory, {
      persistenceMode,
      authorizeRecoveryReceipt: (proof, projectionAdmissions) =>
        Effect.callback((resume) => {
          const admissionId = ++nextAdmissionId
          admissions.set(admissionId, resume)
          port.postMessage({
            type: 'recoveryPrepare',
            admissionId,
            proof,
            projectionAdmissions,
          } satisfies CheckpointRecoveryPreparation)
          return Effect.sync(() => {
            admissions.delete(admissionId)
          })
        }),
    })
    const requests = yield* Queue.bounded<CheckpointRequest, Cause.Done>(1)
    const onMessage = (request: CheckpointRequest | CheckpointRecoveryAdmission) => {
      if ('type' in request) {
        if (request.type !== 'recoveryAdmission') return
        const resume = admissions.get(request.admissionId)
        if (!resume) return
        admissions.delete(request.admissionId)
        resume(
          'error' in request
            ? Effect.fail(new PersistenceError(request.error))
            : Effect.succeed(request.proof),
        )
        return
      }
      if (!Queue.offerUnsafe(requests, request))
        port.postMessage({
          id: request.id,
          error: {
            operation: 'queue',
            path: directory,
            message: 'Conversation writer capacity exceeded.',
            cause: undefined,
          },
        } satisfies CheckpointResponse)
    }
    const onClose = () => {
      for (const resume of admissions.values())
        resume(
          Effect.fail(
            persistenceError(
              'worker',
              directory,
              new Error('Conversation recovery admission channel closed.'),
            ),
          ),
        )
      admissions.clear()
      Queue.endUnsafe(requests)
    }
    yield* Effect.acquireRelease(
      Effect.sync(() => {
        port.on('message', onMessage)
        port.on('close', onClose)
      }),
      () =>
        Effect.sync(() => {
          port.off('message', onMessage)
          port.off('close', onClose)
          Queue.shutdownUnsafe(requests)
        }),
    )
    const execute = Effect.fn('ConversationCheckpointWorker.execute')(function* (
      request: CheckpointRequest,
    ) {
      const decoded = yield* decodeRequest(request).pipe(
        Effect.mapError((cause) => persistenceError('validate', directory, cause)),
      )
      const command = decoded.command as CheckpointCommand
      switch (command.type) {
        case 'load':
          return yield* engine.loadEffect()
        case 'loadEncoded':
          return yield* engine.loadEncodedEffect()
        case 'loadRecoveryReceipt':
          return yield* engine.loadRecoveryReceiptEffect()
        case 'save':
          return yield* engine.saveEffect(
            command.threads,
            command.savedAt,
            command.projectionAdmissions,
          )
        case 'checkpoint':
          return yield* engine.checkpointEffect(command.input)
      }
    })
    while (true) {
      const next = yield* Effect.exit(Queue.take(requests))
      if (Exit.isFailure(next)) return
      const request = next.value
      const exit = yield* Effect.exit(execute(request))
      if (Exit.isSuccess(exit)) {
        const response = { id: request.id, result: exit.value } satisfies CheckpointResponse
        port.postMessage(response, exit.value instanceof ArrayBuffer ? [exit.value] : [])
      } else {
        const cause = Cause.squash(exit.cause)
        const error =
          cause instanceof PersistenceError
            ? cause
            : persistenceError('checkpoint', directory, cause)
        const nativeCause =
          error.cause instanceof Error ? (error.cause as NodeJS.ErrnoException) : undefined
        port.postMessage({
          id: request.id,
          error: {
            operation: error.operation,
            path: error.path,
            message: error.message,
            // Structured cloning an Error drops errno fields used to distinguish
            // filesystem failures. Keep these details explicit at the worker edge.
            cause: nativeCause
              ? {
                  name: nativeCause.name,
                  message: nativeCause.message,
                  stack: nativeCause.stack,
                  code: nativeCause.code,
                  syscall: nativeCause.syscall,
                  path: nativeCause.path,
                }
              : error.cause,
          },
        } satisfies CheckpointResponse)
      }
    }
  }),
)

void Effect.runPromiseExit(run).then((exit) => {
  if (Exit.isFailure(exit)) throw Cause.squash(exit.cause)
})
