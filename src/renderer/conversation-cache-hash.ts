import { Effect, Schema } from 'effect'

export class ConversationCacheHashError extends Schema.TaggedError<ConversationCacheHashError>()(
  'ConversationCacheHashError',
  { message: Schema.String, cause: Schema.Defect() },
) {}

const responseSchema = Schema.Union([
  Schema.Struct({
    type: Schema.Literal('hash'),
    hash: Schema.String.check(Schema.isPattern(/^[a-f0-9]{64}$/)),
  }),
  Schema.Struct({ type: Schema.Literal('error'), message: Schema.String }),
])
const decodeResponse = Schema.decodeUnknownEffect(responseSchema, { onExcessProperty: 'error' })

const failure = (cause: unknown) =>
  new ConversationCacheHashError({
    message: 'Could not verify the local history cache bytes.',
    cause,
  })

export const hashSerializedConversationCacheEffect = Effect.fnUntraced(function* (
  serialized: string,
  createWorker?: () => Worker,
) {
  const factory =
    createWorker ??
    (yield* Effect.tryPromise({
      try: () =>
        import('./conversation-cache-hash-worker?worker&inline').then(
          ({ default: CacheWorker }) =>
            () =>
              new CacheWorker(),
        ),
      catch: failure,
    }))
  const worker = yield* Effect.acquireRelease(
    Effect.try({ try: factory, catch: failure }),
    (owned) => Effect.sync(() => owned.terminate()),
  )
  const packet = yield* Effect.callback<unknown, ConversationCacheHashError>((resume) => {
    worker.onmessage = ({ data }) => resume(Effect.succeed(data))
    worker.onerror = (event) => resume(Effect.fail(failure(event.message)))
    worker.onmessageerror = () => resume(Effect.fail(failure('Unreadable cache hash response.')))
    try {
      worker.postMessage({ type: 'hash', serialized })
    } catch (cause) {
      resume(Effect.fail(failure(cause)))
    }
    return Effect.sync(() => {
      worker.onmessage = null
      worker.onerror = null
      worker.onmessageerror = null
    })
  })
  const response = yield* decodeResponse(packet).pipe(Effect.mapError(failure))
  if (response.type === 'error') return yield* failure(response.message)
  return response.hash
}, Effect.scoped)
