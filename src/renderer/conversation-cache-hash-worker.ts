import { Effect, Schema } from 'effect'
import { hashConversationLoadBuffer } from './conversation-load-hash'

const requestSchema = Schema.Struct({
  type: Schema.Literal('hash'),
  serialized: Schema.String.check(
    Schema.makeFilter(
      (value: string) =>
        !/[\uD800-\uDFFF]/u.test(value) || 'Cache bytes contain an unpaired UTF-16 surrogate.',
    ),
  ),
})
const decodeRequest = Schema.decodeUnknownEffect(requestSchema, { onExcessProperty: 'error' })
const port = self as unknown as {
  postMessage(value: { type: 'hash'; hash: string } | { type: 'error'; message: string }): void
  onmessage: ((event: MessageEvent<unknown>) => void) | null
}
let started = false

const hashRequest = Effect.fnUntraced(function* (input: unknown) {
  const request = yield* decodeRequest(input)
  // Encoding the complete fallback string and hashing it both happen here,
  // away from the renderer that handles input and native event delivery.
  const bytes = new TextEncoder().encode(request.serialized)
  const hash = yield* hashConversationLoadBuffer(bytes.buffer)
  yield* Effect.sync(() => port.postMessage({ type: 'hash', hash }))
})

port.onmessage = (event) => {
  if (started) return
  started = true
  void Effect.runPromise(hashRequest(event.data)).catch(() => {
    port.postMessage({ type: 'error', message: 'Could not verify the local history cache bytes.' })
  })
}
