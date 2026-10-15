import { Context, Effect, Fiber, Layer, ManagedRuntime, Schema } from 'effect'
import { unwrapExit } from './effect-runtime'

type NativeHandler = (...args: unknown[]) => unknown

export class NativeOperationError extends Schema.TaggedError<NativeOperationError>()(
  'NativeOperationError',
  {
    operation: Schema.String,
    message: Schema.String,
    cause: Schema.Defect(),
  },
) {}

/** One service owns native request fibers, admission checks, and tracing. */
export class NativeOperations extends Context.Service<
  NativeOperations,
  {
    invoke(
      name: string,
      args: unknown[],
      beforeDispatch?: () => void,
    ): Effect.Effect<unknown, NativeOperationError>
  }
>()('life/main/NativeOperations') {
  static layer(handlers: ReadonlyMap<string, NativeHandler>, admit: (name: string) => void) {
    return Layer.effect(
      NativeOperations,
      Effect.gen(function* () {
        const scope = yield* Effect.scope
        const invoke = Effect.fn('NativeOperations.invoke')(function* (
          name: string,
          args: unknown[],
          beforeDispatch?: () => void,
        ) {
          const fail = (cause: unknown) =>
            new NativeOperationError({
              operation: name,
              message: cause instanceof Error ? cause.message : String(cause),
              cause,
            })
          const handler = yield* Effect.try({
            try: () => {
              const operation = handlers.get(name)
              if (!operation) throw new Error(`This Life method is unavailable: ${name}`)
              return operation
            },
            catch: fail,
          })
          const operation = Effect.try({
            try: () => {
              // A request can wait for the application Layer to initialize.
              // Revalidate its sender and document at the actual dispatch edge.
              beforeDispatch?.()
              admit(name)
              return handler(...args)
            },
            catch: fail,
          }).pipe(
            Effect.flatMap((result) =>
              Effect.isEffect(result)
                ? (result as Effect.Effect<unknown, unknown>).pipe(Effect.mapError(fail))
                : Effect.tryPromise({ try: () => Promise.resolve(result), catch: fail }),
            ),
            Effect.withSpan(`Life.${name}`),
          )
          const fiber = yield* Effect.forkIn(operation, scope)
          return yield* Fiber.join(fiber).pipe(Effect.ensuring(Fiber.interrupt(fiber)))
        })
        return NativeOperations.of({ invoke })
      }),
    )
  }
}

/** The Electron and extension bridges share a single managed service layer. */
export class ApplicationRuntime {
  private readonly handlers = new Map<string, NativeHandler>()
  private readonly runtime: ManagedRuntime.ManagedRuntime<NativeOperations, never>
  private closed = false

  constructor(admit: (name: string) => void) {
    this.runtime = ManagedRuntime.make(NativeOperations.layer(this.handlers, admit))
  }

  register(name: string, handler: NativeHandler): void {
    if (this.closed) throw new Error('Life is shutting down.')
    if (this.handlers.has(name)) throw new Error(`Life method already registered: ${name}`)
    this.handlers.set(name, handler)
  }

  has(name: string): boolean {
    return this.handlers.has(name)
  }

  async invoke(
    name: string,
    args: unknown[],
    options?: { signal?: AbortSignal; beforeDispatch?: () => void },
  ): Promise<unknown> {
    if (this.closed) throw new Error('Life is shutting down.')
    return unwrapExit(
      await this.runtime.runPromiseExit(
        NativeOperations.use((operations) =>
          operations.invoke(name, args, options?.beforeDispatch),
        ),
        { signal: options?.signal },
      ),
    )
  }

  async dispose(): Promise<void> {
    this.closed = true
    await this.runtime.dispose()
  }
}
