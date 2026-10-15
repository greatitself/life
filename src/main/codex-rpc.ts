import type { ClientChannel } from 'ssh2'
import { Cause, Deferred, Effect, Exit, Option, Schema, type Scope } from 'effect'
import { JsonLines } from './json-lines'
import { runEffect } from './effect-runtime'
import { NativeRecoveryError, type NativeRecoveryInputSemantic } from './native-recovery-types'

export type Wire = Record<string, unknown>
export interface CodexRPCRecoveryOptions {
  /** The next unused ID; MAX_SAFE_INTEGER + 1 retains exhausted replay-only ownership. */
  readonly nextRequestId?: number
  /** Observe owned replies at their native output ordinal before continuations run. */
  readonly onResponse?: (message: Wire, semantic: NativeRecoveryInputSemantic | undefined) => void
  readonly onOrphanResponse?: (message: Wire) => void
}

type RecoveryChannel = ClientChannel & {
  readonly nativeRecoveryTracked?: boolean
  readonly recoveryId?: string
  writeNative?: (message: Wire, semantic?: NativeRecoveryInputSemantic) => boolean
  writeNativeAndWait?: (message: Wire, semantic?: NativeRecoveryInputSemantic) => Promise<void>
  detach?: () => Promise<void>
}

const uncertainMutations = new Set(['initialize', 'thread/start', 'thread/resume', 'turn/start'])
const trackedMutationKinds = new Set<NativeRecoveryInputSemantic['kind']>([
  'initialize',
  'user-prompt',
  'steer',
  'settings',
  'interrupt',
])
const settingsMutations = new Set([
  'turn/settings/update',
  'thread/settings/update',
  'config/value/write',
  'config/batchWrite',
])
const decodeNextRequestId = Schema.decodeUnknownSync(
  Schema.Union([
    Schema.Int.check(Schema.isGreaterThan(0), Schema.isLessThanOrEqualTo(Number.MAX_SAFE_INTEGER)),
    Schema.Literal(Number.MAX_SAFE_INTEGER + 1),
  ]),
)
const decodeNativeId = Schema.decodeUnknownOption(Schema.Union([Schema.String, Schema.Int]))
const decodeNonemptyString = Schema.decodeUnknownOption(Schema.NonEmptyString)
const decodeWire = Schema.decodeUnknownOption(Schema.Record(Schema.String, Schema.Unknown))
const decodeRemoteError = Schema.decodeUnknownOption(
  Schema.Struct({
    message: Schema.optionalKey(Schema.String),
    code: Schema.optionalKey(Schema.Number),
  }),
)

export class CodexRequestError extends Schema.TaggedError<CodexRequestError>()(
  'CodexRequestError',
  {
    method: Schema.String,
    message: Schema.String,
    code: Schema.optionalKey(Schema.Number),
  },
) {
  constructor(method: string, message: string, code?: number) {
    super({ method, message, ...(code === undefined ? {} : { code }) })
  }
}

export class CodexRequestCancelled extends Schema.TaggedError<CodexRequestCancelled>()(
  'CodexRequestCancelled',
  { method: Schema.String, message: Schema.String },
) {
  constructor(method: string) {
    super({ method, message: 'Codex request cancelled' })
  }
}

export class CodexTransportError extends Schema.TaggedError<CodexTransportError>()(
  'CodexTransportError',
  { message: Schema.String, cause: Schema.Defect() },
) {
  constructor(cause: unknown) {
    super({ message: cause instanceof Error ? cause.message : String(cause), cause })
  }
}

export type CodexRPCError =
  CodexRequestError | CodexRequestCancelled | CodexTransportError | NativeRecoveryError

function nativeInputSemantic(
  message: Wire,
  semantic?: NativeRecoveryInputSemantic,
): NativeRecoveryInputSemantic {
  const method = Option.getOrUndefined(decodeNonemptyString(message.method))
  const id = Option.getOrUndefined(decodeNativeId(message.id))
  const params = Option.getOrElse(decodeWire(message.params), (): Wire => ({}))
  const threadId = Option.getOrUndefined(decodeNonemptyString(params.threadId))
  const turnId =
    Option.getOrUndefined(decodeNonemptyString(params.turnId)) ??
    (method === 'turn/steer'
      ? Option.getOrUndefined(decodeNonemptyString(params.expectedTurnId))
      : undefined)
  const kind =
    method === 'initialize' || method === 'initialized'
      ? 'initialize'
      : method === 'turn/start'
        ? 'user-prompt'
        : method === 'turn/steer'
          ? 'steer'
          : method === 'turn/interrupt'
            ? 'interrupt'
            : method !== undefined && settingsMutations.has(method)
              ? 'settings'
              : 'transport'
  const inputKind = kind === 'transport' ? (semantic?.kind ?? kind) : kind
  // Semantic ownership never changes the provider payload. Wire identities
  // remain authoritative even when a caller supplies session-level metadata.
  return {
    ...semantic,
    kind: inputKind,
    ...(method === undefined ? {} : { method }),
    ...(id === undefined ? {} : { requestId: id }),
    ...(inputKind === 'permission-response' && id !== undefined ? { permissionRequestId: id } : {}),
    ...(threadId === undefined ? {} : { nativeThreadId: threadId }),
    ...(turnId === undefined ? {} : { nativeTurnId: turnId }),
  }
}

export class CodexRPC {
  private next = 1
  private failure?: CodexTransportError | NativeRecoveryError
  private stderr = ''
  private startupOutput = ''
  private suspended = false
  private replaying = false
  private messageSequence = 0
  private detachment?: Deferred.Deferred<void, CodexTransportError | NativeRecoveryError>
  private readonly lines: JsonLines
  private readonly recovery: CodexRPCRecoveryOptions
  private pending = new Map<
    number,
    {
      method: string
      semantic?: NativeRecoveryInputSemantic
      result: Deferred.Deferred<Wire, CodexRPCError>
      cleanup: () => void
      timer?: NodeJS.Timeout
      remaining: number
      started: number
      expire: () => void
    }
  >()
  constructor(
    readonly channel: ClientChannel,
    receive: (message: Wire) => void,
    private onFailure: (error: Error) => void = () => {},
    recovery: CodexRPCRecoveryOptions = {},
  ) {
    this.recovery = { ...recovery }
    this.next = decodeNextRequestId(recovery.nextRequestId ?? 1)
    this.suspended =
      (channel as ClientChannel & { transportState?: string }).transportState === 'suspended'
    channel.on('suspended', () => {
      if (this.suspended) return
      this.suspended = true
      for (const pending of this.pending.values()) {
        clearTimeout(pending.timer)
        pending.timer = undefined
        pending.remaining = Math.max(1, pending.remaining - (Date.now() - pending.started))
      }
    })
    channel.on('resumed', () => {
      if (!this.suspended || this.failure) return
      this.suspended = false
      for (const pending of this.pending.values()) {
        pending.started = Date.now()
        pending.timer = setTimeout(pending.expire, pending.remaining)
      }
    })
    this.lines = new JsonLines(
      (message) => {
        this.messageSequence++
        if (this.failure) return
        if (typeof message.id === 'number' && !message.method) {
          const pending = this.replaying ? undefined : this.pending.get(message.id)
          if (!pending) {
            try {
              this.recovery.onOrphanResponse?.(message)
            } catch (cause) {
              const error = this.uncertainError(
                'codex.recovery-response',
                'A native response could not be reconciled with its durable owner.',
                cause,
              )
              this.close(error)
              if (this.replaying) throw error
            }
            return
          }
          try {
            this.recovery.onResponse?.(message, pending.semantic)
          } catch (cause) {
            this.close(
              this.uncertainError(
                'codex.recovery-response',
                'A native response could not be reconciled with its durable owner.',
                cause,
              ),
            )
            return
          }
          if (this.failure) return
          this.pending.delete(message.id)
          pending.cleanup()
          if (message.error) {
            const error = Option.getOrElse(decodeRemoteError(message.error), () => ({
              message: undefined,
              code: undefined,
            }))
            Deferred.doneUnsafe(
              pending.result,
              Effect.fail(
                new CodexRequestError(
                  pending.method,
                  error.message || 'Codex request failed',
                  error.code,
                ),
              ),
            )
          } else
            Deferred.doneUnsafe(
              pending.result,
              Effect.succeed(Option.getOrElse(decodeWire(message.result), () => ({}))),
            )
        } else receive(message)
      },
      (line) => {
        // Login shells can print banners before exec reaches app-server. Keep
        // those separate from JSON framing failures and accept the handshake.
        if (line !== 'Agent output exceeded the message limit' && !/^\s*[\[{]/.test(line)) {
          this.startupOutput = (this.startupOutput + '\n' + line.slice(0, 2048)).slice(-8192)
          return
        }
        this.retireUncertain(
          new Error(
            line === 'Agent output exceeded the message limit'
              ? 'Codex returned a response larger than the protocol limit. Update the remote Codex installation and retry; your saved conversation is unchanged.'
              : 'Codex returned an invalid protocol message. Retry, or check the remote Codex installation and shell startup output.',
          ),
          'codex.output',
        )
      },
    )
    channel.on('data', (chunk: Buffer) => this.lines.push(chunk))
    channel.stderr.on('data', (chunk: Buffer) => {
      this.stderr = (this.stderr + chunk.toString()).slice(-8192)
    })
    channel.on('error', (error: Error) => this.retireUncertain(error, 'codex.transport'))
    channel.on('close', () => {
      this.fail(
        this.failure ||
          new Error(this.stderr || 'Codex disconnected. Retry to reopen your saved conversation.'),
      )
    })
  }
  get closed() {
    return Boolean(this.failure) || this.channel.destroyed
  }
  get hasPendingMutation() {
    return [...this.pending.values()].some(
      (request) =>
        request.method !== 'initialize' &&
        this.isUncertainMutation(request.method, request.semantic),
    )
  }
  get nextRequestId() {
    return this.next
  }
  get receivedMessageSequence() {
    return this.messageSequence
  }
  get isReplaying() {
    return this.replaying
  }
  replayOutput(chunk: Buffer | string) {
    const replaying = this.replaying
    this.replaying = true
    try {
      this.lines.push(chunk)
    } catch (cause) {
      if (!this.recoveryTracked) throw cause
      const error =
        cause instanceof NativeRecoveryError
          ? cause
          : this.uncertainError(
              'codex.replay',
              'Native recovery output could not be reconstructed; Life detached without changing the provider.',
              cause,
            )
      this.close(error)
      throw error
    } finally {
      this.replaying = replaying
    }
  }
  send(message: Wire, semantic?: NativeRecoveryInputSemantic) {
    if (this.replaying)
      throw this.uncertainError('codex.replay', 'Native sends are disabled during recovery replay.')
    if (this.closed)
      throw this.failure || new CodexTransportError(new Error('Codex is disconnected'))
    const channel = this.channel as RecoveryChannel
    try {
      if (channel.writeNative) channel.writeNative(message, nativeInputSemantic(message, semantic))
      else channel.write(JSON.stringify(message) + '\n')
    } catch (error) {
      throw this.writeFailure(error)
    }
  }
  sendAndWait(message: Wire, semantic?: NativeRecoveryInputSemantic): Promise<void> {
    return runEffect(this.sendAndWaitEffect(message, semantic))
  }
  readonly sendAndWaitEffect = Effect.fn('CodexRPC.sendAndWait')(
    function* (
      this: CodexRPC,
      message: Wire,
      semantic?: NativeRecoveryInputSemantic,
    ): Effect.fn.Return<void, CodexTransportError | NativeRecoveryError> {
      if (this.replaying)
        return yield* this.uncertainError(
          'codex.replay',
          'Native sends are disabled during recovery replay.',
        )
      if (this.closed)
        return yield* this.failure || new CodexTransportError(new Error('Codex is disconnected'))
      const channel = this.channel as RecoveryChannel
      if (channel.writeNativeAndWait) {
        yield* Effect.tryPromise({
          try: () => channel.writeNativeAndWait!(message, nativeInputSemantic(message, semantic)),
          catch: (cause) => this.writeFailure(cause),
        })
      } else {
        yield* Effect.try({
          try: () => this.send(message, semantic),
          catch: (cause) => this.writeFailure(cause),
        })
      }
    }.bind(this),
  )
  request(
    method: string,
    params: Wire = {},
    timeout = 60000,
    signal?: AbortSignal,
    semantic?: NativeRecoveryInputSemantic,
  ): Promise<Wire> {
    return runEffect(this.requestEffect(method, params, timeout, signal, semantic))
  }
  readonly requestEffect = Effect.fnUntraced(
    function* (
      this: CodexRPC,
      method: string,
      params: Wire = {},
      timeout = 60000,
      signal?: AbortSignal,
      semantic?: NativeRecoveryInputSemantic,
    ): Effect.fn.Return<Wire, CodexRPCError, Scope.Scope> {
      if (signal?.aborted) return yield* new CodexRequestCancelled(method)
      if (this.replaying)
        return yield* this.uncertainError(
          'codex.replay',
          'Native requests are disabled during recovery replay.',
        )
      if (this.closed)
        return yield* this.failure || new CodexTransportError(new Error('Codex is disconnected'))
      if (this.next > Number.MAX_SAFE_INTEGER)
        return yield* this.uncertainError(
          'codex.request',
          'Native request IDs are exhausted; the owned transport cannot safely allocate another request.',
        )
      const id = this.next++
      const nativeSemantic = nativeInputSemantic({ id, method, params }, semantic)
      const result = yield* Deferred.make<Wire, CodexRPCError>()
      let sent = false
      const cancel = () => {
        const uncertain =
          sent && !Deferred.isDoneUnsafe(result) && this.isUncertainMutation(method, semantic)
        const error = new CodexRequestCancelled(method)
        cleanup()
        try {
          if (uncertain) this.retireUncertain(error, method)
        } finally {
          Deferred.doneUnsafe(result, Effect.fail(error))
        }
      }
      const expire = () => {
        cleanup()
        const requestError = new CodexRequestError(
          method,
          `${method} did not respond within ${Math.round(timeout / 1000)} seconds. ` +
            (method === 'thread/resume'
              ? 'Your saved conversation is unchanged. Retry to restart Codex; check remote Codex or required MCP server startup if this continues.'
              : method === 'turn/start'
                ? 'The Codex connection was stopped to avoid leaving an untracked turn running. Your saved conversation is unchanged; retry to resume it.'
                : 'Retry, or check the remote Codex installation and server startup.') +
            (this.stderr
              ? `\nRemote diagnostic: ${this.stderr.trim().slice(-2000)}`
              : this.startupOutput
                ? '\nThe remote login shell printed non-protocol output. Check its startup configuration.'
                : ''),
        )
        const error =
          this.recoveryTracked && this.isUncertainMutation(method, semantic)
            ? this.uncertainError(
                method,
                `${method} did not respond within ${Math.round(timeout / 1000)} seconds. Life detached from the owned Codex transport; its native outcome must be recovered before another mutation.`,
                requestError,
              )
            : requestError
        Deferred.doneUnsafe(result, Effect.fail(error))
        // A timed-out mutation may still be running remotely. Do not reuse the
        // stream or replay a user prompt against an uncertain thread state.
        if (this.isUncertainMutation(method, semantic)) this.retireUncertain(error, method)
      }
      const cleanup = () => {
        this.pending.delete(id)
        clearTimeout(pending.timer)
        signal?.removeEventListener('abort', cancel)
      }
      const pending = {
        method,
        semantic: nativeSemantic,
        result,
        cleanup,
        remaining: timeout,
        started: Date.now(),
        expire,
        timer: undefined as NodeJS.Timeout | undefined,
      }
      yield* Effect.acquireRelease(
        Effect.sync(() => {
          this.pending.set(id, pending)
          // Only connected time counts against this deadline. The durable
          // broker can keep the same request alive through an SSH interruption.
          if (!this.suspended) pending.timer = setTimeout(expire, timeout)
          signal?.addEventListener('abort', cancel, { once: true })
        }),
        (_, exit) =>
          Effect.sync(() => {
            const interrupted = Exit.isFailure(exit) && Cause.hasInterrupts(exit.cause)
            const uncertain =
              sent && !Deferred.isDoneUnsafe(result) && this.isUncertainMutation(method, semantic)
            cleanup()
            // The remote mutation may have been accepted even if its response
            // has not arrived. Never leave that work on a reusable transport.
            if (interrupted && uncertain)
              this.retireUncertain(new CodexRequestCancelled(method), method)
          }),
      )
      if (signal?.aborted) return yield* new CodexRequestCancelled(method)
      yield* Effect.try({
        try: () => {
          sent = true
          this.send({ id, method, params }, nativeSemantic)
        },
        catch: (error) => {
          if (error instanceof NativeRecoveryError) {
            this.close(error)
            return error
          }
          return error instanceof CodexTransportError ? error : new CodexTransportError(error)
        },
      })
      return yield* Deferred.await(result)
    }.bind(this),
    Effect.scoped,
  )
  close(error = new Error('Codex connection closed')) {
    if (this.failure) return
    if (error instanceof NativeRecoveryError) {
      void this.detach(error).catch(() => {})
      return
    }
    try {
      this.fail(error)
    } finally {
      try {
        this.channel.signal('TERM')
      } catch {}
      try {
        this.channel.close()
      } catch {}
    }
  }
  detach(error: Error = new Error('Life detached from its owned Codex connection.')) {
    return runEffect(this.detachEffect(error))
  }
  readonly detachEffect = Effect.fn('CodexRPC.detach')(
    function* (
      this: CodexRPC,
      error: Error = new Error('Life detached from its owned Codex connection.'),
    ): Effect.fn.Return<void, CodexTransportError | NativeRecoveryError> {
      if (this.detachment) return yield* Deferred.await(this.detachment)
      if (this.failure) return
      const done = yield* Deferred.make<void, CodexTransportError | NativeRecoveryError>()
      this.detachment = done
      const channel = this.channel as RecoveryChannel
      const release = channel.detach
        ? Effect.tryPromise({
            try: () => channel.detach!(),
            catch: (cause) =>
              cause instanceof NativeRecoveryError ? cause : new CodexTransportError(cause),
          })
        : Effect.sync(() => {
            channel.destroy()
          })
      const notified = yield* Effect.exit(Effect.sync(() => this.fail(error)))
      const released = yield* Effect.exit(release)
      yield* Deferred.done(done, Exit.isFailure(released) ? released : notified)
      return yield* Deferred.await(done)
    }.bind(this),
    (program: Effect.Effect<void, CodexTransportError | NativeRecoveryError>, _error?: Error) =>
      Effect.uninterruptible(program),
  )
  readonly releaseEffect = Effect.fn('CodexRPC.release')(
    function* (this: CodexRPC) {
      if (this.detachment) {
        yield* Deferred.await(this.detachment)
        return false
      }
      if (this.failure instanceof NativeRecoveryError) {
        yield* this.detachEffect(this.failure)
        return false
      }
      const channel = this.channel as ClientChannel & {
        closeAndWaitEffect?: () => Effect.Effect<boolean>
      }
      if (channel.closeAndWaitEffect) {
        const notified = yield* Effect.exit(
          Effect.sync(() => this.fail(new Error('Life closed its idle Codex connection.'))),
        )
        const released = yield* Effect.exit(channel.closeAndWaitEffect())
        if (Exit.isFailure(released)) return yield* released
        yield* notified
        return released.value
      }
      this.close(new Error('Life closed its idle Codex connection.'))
      return false
    }.bind(this),
    Effect.uninterruptible,
  )
  private fail(error: Error) {
    if (this.failure) return
    this.failure =
      error instanceof CodexTransportError || error instanceof NativeRecoveryError
        ? error
        : new CodexTransportError(error)
    for (const pending of this.pending.values()) {
      pending.cleanup()
      Deferred.doneUnsafe(pending.result, Effect.fail(this.failure))
    }
    this.pending.clear()
    this.onFailure(error)
  }
  private get recoveryTracked() {
    return (this.channel as RecoveryChannel).nativeRecoveryTracked === true
  }
  private isUncertainMutation(method: string, semantic?: NativeRecoveryInputSemantic) {
    return (
      uncertainMutations.has(method) ||
      (this.recoveryTracked &&
        (trackedMutationKinds.has(nativeInputSemantic({ method }).kind) ||
          (semantic !== undefined && trackedMutationKinds.has(semantic.kind))))
    )
  }
  private writeFailure(cause: unknown): CodexTransportError | NativeRecoveryError {
    const error =
      cause instanceof NativeRecoveryError
        ? cause
        : this.recoveryTracked
          ? this.uncertainError(
              'codex.write',
              'The owned Codex delivery failed; its native outcome must be recovered before another mutation.',
              cause,
            )
          : cause instanceof CodexTransportError
            ? cause
            : new CodexTransportError(cause)
    if (error instanceof NativeRecoveryError) this.close(error)
    return error
  }
  private uncertainError(operation: string, message: string, cause?: unknown) {
    return new NativeRecoveryError({
      operation,
      path: (this.channel as RecoveryChannel).recoveryId ?? '',
      reason: 'uncertain',
      message,
      ...(cause === undefined ? {} : { cause }),
    })
  }
  private retireUncertain(error: Error, operation: string) {
    this.close(
      error instanceof NativeRecoveryError || !this.recoveryTracked
        ? error
        : this.uncertainError(operation, error.message, error),
    )
  }
}
