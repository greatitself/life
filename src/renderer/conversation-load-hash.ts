import { Effect, Schema } from 'effect'

export class ConversationLoadHashError extends Schema.TaggedError<ConversationLoadHashError>()(
  'ConversationLoadHashError',
  { message: Schema.String, cause: Schema.Defect() },
) {}

/** The worker hashes the transferred bytes before any UTF-8 or JSON decoding. */
export const hashConversationLoadBuffer = Effect.fnUntraced(function* (buffer: ArrayBuffer) {
  const digest = yield* Effect.tryPromise({
    try: () => globalThis.crypto.subtle.digest('SHA-256', buffer),
    catch: (cause) =>
      new ConversationLoadHashError({
        message: 'Could not verify the disk history bytes.',
        cause,
      }),
  })
  return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, '0')).join('')
})
