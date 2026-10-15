import { Cause, Context, Effect, Layer, Schema, Stream } from 'effect'
import { HttpClient, HttpClientError, HttpClientResponse } from 'effect/http'
import {
  PROVIDER_UPDATES,
  providerVersion,
  providerVersionIsPrerelease,
} from '../shared/provider-updates'
import type { Provider } from '../shared/types'

const METADATA_LIMIT = 256 * 1024

export const StableProviderVersion = Schema.String.check(
  Schema.makeFilter(
    (version) => providerVersion(version) === version && !providerVersionIsPrerelease(version),
  ),
)
const ReleaseMetadata = Schema.Struct({ version: StableProviderVersion })
const decodeJson = Schema.decodeUnknownEffect(Schema.fromJsonString(Schema.Unknown))
const decodeMetadata = Schema.decodeUnknownEffect(ReleaseMetadata)

export class ProviderReleaseError extends Schema.TaggedError<ProviderReleaseError>()(
  'ProviderReleaseError',
  { message: Schema.String, cause: Schema.Defect() },
) {}

const releaseHttpError = (error: HttpClientError.HttpClientError): ProviderReleaseError => {
  const reason = error.reason
  const cause = 'cause' in reason ? reason.cause : error
  return new ProviderReleaseError({
    message:
      reason._tag === 'EmptyBodyError'
        ? 'Release registry returned no metadata.'
        : cause instanceof Error
          ? cause.message.slice(0, 400)
          : 'Release check failed.',
    cause,
  })
}

const responseStream = Effect.fnUntraced(function* (
  source: Response,
  response: HttpClientResponse.HttpClientResponse,
) {
  const reader = yield* Effect.acquireRelease(
    Effect.try({
      try: () => source.body!.getReader(),
      catch: (cause) =>
        new HttpClientError.HttpClientError({
          reason: new HttpClientError.DecodeError({ request: response.request, response, cause }),
        }),
    }),
    (reader) =>
      Effect.sync(() => {
        // A tee's cancellation can wait indefinitely for its other branch.
        // Release our reader and start cancellation together, without awaiting
        // the cancellation Promise on the request's shutdown critical path.
        reader.releaseLock()
        void source.body!.cancel().catch(() => {})
      }),
  )
  return Stream.fromPull(
    Effect.succeed(
      Effect.tryPromise({
        try: () => reader.read(),
        catch: (cause) =>
          new HttpClientError.HttpClientError({
            reason: new HttpClientError.DecodeError({ request: response.request, response, cause }),
          }),
      }).pipe(
        Effect.flatMap(({ done, value }) =>
          done ? Cause.done() : Effect.succeed([value] as const),
        ),
      ),
    ),
  )
})

const registryTransport = (fetch: typeof globalThis.fetch) =>
  HttpClient.make((request, url, signal) =>
    Effect.tryPromise({
      try: () =>
        fetch(url.toString(), {
          signal,
          method: request.method,
          headers: request.headers,
          redirect: 'error',
          credentials: 'omit',
        }),
      catch: (cause) =>
        new HttpClientError.HttpClientError({
          reason: new HttpClientError.TransportError({ request, cause }),
        }),
    }).pipe(
      Effect.map((source) => {
        const response = HttpClientResponse.fromWeb(request, source)
        if (source.body) {
          Object.defineProperty(response, 'stream', {
            value: Stream.unwrap(responseStream(source, response)),
          })
        }
        return response
      }),
    ),
  )

/** Trusted, bounded public release requests; each request owns its network scope. */
export class ProviderReleaseRegistry extends Context.Service<
  ProviderReleaseRegistry,
  { latest(provider: Provider, timeoutMs: number): Effect.Effect<string, ProviderReleaseError> }
>()('life/main/ProviderReleaseRegistry') {
  static layer(fetch: typeof globalThis.fetch): Layer.Layer<ProviderReleaseRegistry> {
    return Layer.effect(
      ProviderReleaseRegistry,
      Effect.gen(function* () {
        const client = (yield* HttpClient.HttpClient).pipe(HttpClient.withScope)
        const latest = Effect.fn('ProviderReleaseRegistry.latest')(
          function* (provider: Provider, timeoutMs: number) {
            const response = yield* client
              .get(PROVIDER_UPDATES[provider].registryUrl, {
                headers: { Accept: 'application/json' },
              })
              .pipe(Effect.mapError(releaseHttpError))
            if (response.status < 200 || response.status >= 300) {
              return yield* new ProviderReleaseError({
                message: `Release registry returned HTTP ${response.status}.`,
                cause: response.status,
              })
            }
            // FetchHttpClient body accessors do not enforce MaxBodySize. Read the
            // stream with a byte bound before collecting or parsing any JSON.
            const body = yield* response.stream.pipe(
              Stream.mapError(releaseHttpError),
              Stream.runFoldEffect(
                () => ({ chunks: [] as Uint8Array[], length: 0 }),
                (body, chunk) => {
                  body.length += chunk.byteLength
                  if (body.length > METADATA_LIMIT) {
                    return Effect.fail(
                      new ProviderReleaseError({
                        message: 'Release metadata exceeded the size limit.',
                        cause: body.length,
                      }),
                    )
                  }
                  body.chunks.push(chunk)
                  return Effect.succeed(body)
                },
              ),
            )
            const json = yield* decodeJson(
              Buffer.concat(body.chunks, body.length).toString('utf8'),
            ).pipe(
              Effect.mapError(
                (cause) =>
                  new ProviderReleaseError({
                    message: 'Release registry returned invalid JSON.',
                    cause,
                  }),
              ),
            )
            const metadata = yield* decodeMetadata(json).pipe(
              Effect.mapError(
                (cause) =>
                  new ProviderReleaseError({
                    message: 'Release registry did not return a stable version.',
                    cause,
                  }),
              ),
            )
            return metadata.version
          },
          Effect.scoped,
          (effect, _provider, timeoutMs) =>
            Effect.timeoutOrElse(effect, {
              duration: timeoutMs,
              orElse: () =>
                Effect.fail(
                  new ProviderReleaseError({
                    message: 'Release check timed out. Try again when the network is available.',
                    cause: timeoutMs,
                  }),
                ),
            }),
        )
        return ProviderReleaseRegistry.of({ latest })
      }),
    ).pipe(Layer.provide(Layer.succeed(HttpClient.HttpClient, registryTransport(fetch))))
  }
}
