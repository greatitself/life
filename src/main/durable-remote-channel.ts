import { randomUUID } from 'node:crypto'
import { Duplex, PassThrough } from 'node:stream'
import { StringDecoder } from 'node:string_decoder'
import { posix } from 'node:path'
import type { ClientChannel } from 'ssh2'
import { Deferred, Effect, Option, Predicate, Schema } from 'effect'
import type { ConnectionProfile, ConnectionState } from '../shared/types'
import { buildRemoteAgentBrokerCommand, type RemoteAgentBrokerConfig } from './remote-agent-broker'
import { runEffect } from './effect-runtime'
import { nativeMachineIdentity, sameNativeMachine } from './native-machine-identity'
import type { NativeRecoveryStoreHandle } from './native-recovery-store'
import {
  NativeRecoveryError,
  isConfirmedNativeExit,
  nativeRecoveryInputSemanticSchema,
  nativeRecoveryTransportSchema,
  type NativeRecoveryInput,
  type NativeRecoveryInputReceipt,
  type NativeRecoveryInputSemantic,
  type NativeRecoveryNumberedInput,
  type NativeRecoveryOutput,
  type NativeRecoveryOwner,
  type NativeRecoverySnapshot,
  type NativeRecoveryTransport,
} from './native-recovery-types'

const natural = Schema.Natural.check(Schema.isLessThanOrEqualTo(Number.MAX_SAFE_INTEGER))
const positive = natural.check(Schema.isGreaterThan(0))
const base64 = Schema.String.check(
  Schema.isPattern(/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/),
)
const brokerFrameSchema = Schema.Union([
  Schema.Struct({
    type: Schema.Literal('ready'),
    protocol: positive,
    cursor: natural,
    lastInputSequence: natural,
    writerLease: Schema.optionalKey(
      Schema.Struct({ epoch: positive, token: Schema.NonEmptyString }),
    ),
    terminal: Schema.optionalKey(Schema.Boolean),
    observer: Schema.optionalKey(Schema.Boolean),
    writerUnavailable: Schema.optionalKey(Schema.Boolean),
    inputReceipts: Schema.optionalKey(Schema.Literal(1)),
  }),
  Schema.Struct({ type: Schema.Literal('ack'), sequence: positive }),
  Schema.Struct({ type: Schema.Literal('error'), message: Schema.String }),
  Schema.Struct({ type: Schema.Literal('stdout'), cursor: positive, data: base64 }),
  Schema.Struct({ type: Schema.Literal('stderr'), cursor: positive, data: base64 }),
  Schema.Struct({
    type: Schema.Literal('inputReceipt'),
    cursor: positive,
    sequence: positive,
    status: Schema.Literals(['written', 'cancelled', 'uncertain']),
  }).annotate({ parseOptions: { onExcessProperty: 'error' } }),
  Schema.Struct({
    type: Schema.Literal('exit'),
    cursor: positive,
    code: Schema.optionalKey(Schema.Union([Schema.Int, Schema.Null])),
    signal: Schema.optionalKey(Schema.Union([Schema.String, Schema.Null])),
    nativeExitConfirmed: Schema.optionalKey(Schema.Boolean),
  }),
  Schema.Struct({ type: Schema.Literal('replayComplete'), replayCursor: natural }),
])
const decodeBrokerFrame = Schema.decodeUnknownSync(brokerFrameSchema)
const decodeStrictBrokerFrame = Schema.decodeUnknownSync(brokerFrameSchema, {
  onExcessProperty: 'error',
})
const decodeNativeRequest = Schema.decodeUnknownSync(
  Schema.Struct({
    id: Schema.optionalKey(Schema.Union([Schema.Int, Schema.String])),
    request_id: Schema.optionalKey(Schema.NonEmptyString),
    method: Schema.optionalKey(Schema.NonEmptyString),
    type: Schema.optionalKey(Schema.NonEmptyString),
  }),
)
type Frame = typeof brokerFrameSchema.Type
type InputFrame = NativeRecoveryInput & { sequence: number }
type WriterLease = { readonly epoch: number; readonly token: string }
interface OutputDelivery {
  readonly frame: NativeRecoveryOutput
  readonly bytes: number
  readonly payload?: Buffer
  readonly published: Deferred.Deferred<void, NativeRecoveryError>
  committed: boolean
}

export interface DurableRemoteChannelRecoveryOptions {
  readonly store: NativeRecoveryStoreHandle
  readonly provider: 'codex' | 'claude'
  readonly snapshot?: NativeRecoverySnapshot
  readonly deferRecoveryInputs?: boolean
}

export interface DurableChannelHost {
  state: ConnectionState
  /** Resolve a private Local broker directory before recording its ownership. */
  agentBrokerRoot?(id: string): string | undefined
  /** Select the host runtime while retaining the complete recorded configuration. */
  agentBrokerCommand?(config: RemoteAgentBrokerConfig): string
  channel(
    command: string,
    pty?: { cols: number; rows: number },
    signal?: AbortSignal,
    timeoutMs?: number,
    rendererOwned?: boolean,
  ): Promise<ClientChannel>
  on(event: string, listener: (...args: any[]) => void): unknown
  off(event: string, listener: (...args: any[]) => void): unknown
}

const sameMachine = sameNativeMachine

/**
 * A provider's lifetime belongs to its detached remote broker. SSH transports
 * only carry the broker protocol and can disappear without closing this stream.
 * Numbered inputs are acknowledged by the broker; reattachment retries an
 * unacknowledged delivery with the same number, never as a second prompt.
 */
export class DurableRemoteChannel extends Duplex {
  readonly sessionId: string
  readonly controllerId = randomUUID()
  readonly machineIdentity: string
  readonly stderr = new PassThrough()
  readonly stdin = this
  readonly stdout = this
  readonly server = false
  readonly type = 'session' as const
  readonly subtype = 'exec' as const
  readonly incoming = undefined
  readonly outgoing = undefined
  transportState: 'connected' | 'suspended' | 'closed' = 'suspended'
  private transport?: ClientChannel
  private attachment = 0
  private attaching?: Promise<void>
  private reattachTimer?: NodeJS.Timeout
  private handshakeTimer?: NodeJS.Timeout
  private reattachAttempts = 0
  private cursor = 0
  private deliveredCursor = 0
  private readonly brokerRoot?: string
  private readonly registration = Deferred.makeUnsafe<void, NativeRecoveryError>()
  private registered = false
  private descriptor?: NativeRecoveryTransport
  private writerLease?: WriterLease
  private terminalAttachment = false
  private handshakeProcessing = false
  private recoveryOutputDeferred = false
  private recoveryInputsDeferred = false
  private replayCompleteReceived = false
  private replayCommitted = false
  private replayed = Deferred.makeUnsafe<void, NativeRecoveryError>()
  private hasAttached = false
  private operationTail = Deferred.makeUnsafe<void>()
  private outputDeliveries: OutputDelivery[] = []
  private readonly recentOutputs = new Map<number, NativeRecoveryOutput>()
  private recentOutputBytes = 0
  private pendingOutputBytes = 0
  private outputCommitBlocked = false
  private uncertainty?: NativeRecoveryError
  private readonly nativeSemantics = new WeakMap<Buffer, NativeRecoveryInputSemantic>()
  private readonly nativeDeliveryWaiters = new WeakMap<
    Buffer,
    Deferred.Deferred<void, NativeRecoveryError>
  >()
  private readonly inputDeliveryWaiters = new Map<
    number,
    Set<Deferred.Deferred<void, NativeRecoveryError>>
  >()
  private readonly inputReceipts = new Map<number, NativeRecoveryInputReceipt>()
  private inputReceiptCapability?: 1
  private nativeInputUncertain = false
  private readonly acceptedRecoveryInputs = new Set<number>()
  private readonly processedNativeInputs = new Set<number>()
  private readonly nativeInputAdmissions = new Map<number, NativeRecoveryNumberedInput>()
  private readonly closeDelivery = Deferred.makeUnsafe<void, NativeRecoveryError>()
  private closeInputSequence?: number
  private nextInput = 0
  private pending = new Map<number, InputFrame>()
  private started = false
  private closing = false
  private retired = false
  private detaching = false
  private readonly writeAdmissions = new Set<Deferred.Deferred<void, NativeRecoveryError>>()
  private exitReceived = false
  private nativeExitUnconfirmed = false
  private waitForRemoteExit = false
  private localClosePublished = false
  private readonly terminal = Deferred.makeUnsafe<boolean>()
  private stdoutBlocked = false
  private stderrBlocked = false
  private drainTransport?: () => void
  private readonly onStderrDrain = () => {
    this.stderrBlocked = false
    this.drainOutput()
    this.drainTransport?.()
  }
  private readyResolve!: () => void
  private readyReject!: (error: Error) => void
  private readonly ready = new Promise<void>((resolve, reject) => {
    this.readyResolve = resolve
    this.readyReject = reject
  })
  private readonly machine: ConnectionProfile
  private readonly onState = (state: ConnectionState) => {
    if (state.status === 'connected' && this.matchesMachine(state.profile)) {
      if (this.reattachTimer) clearTimeout(this.reattachTimer)
      this.reattachTimer = undefined
      void this.attach().catch((error) => this.transportFailure(error))
    } else if (state.status !== 'connected' || !this.matchesMachine(state.profile))
      this.suspend(new Error('SSH connection is unavailable. The remote agent is still running.'))
  }
  private readonly onDisconnected = () =>
    this.suspend(new Error('SSH connection closed. The remote agent is still running.'))

  private constructor(
    private host: DurableChannelHost,
    private command: string,
    private readonly recoveryOptions?: DurableRemoteChannelRecoveryOptions,
  ) {
    super({ autoDestroy: false })
    if (!host.state.profile) throw new Error('Connect to a machine first')
    this.machine = { ...host.state.profile }
    this.sessionId = recoveryOptions?.snapshot?.transport.brokerId ?? randomUUID()
    this.brokerRoot =
      recoveryOptions?.snapshot?.transport.brokerRoot ??
      host.agentBrokerRoot?.(this.sessionId) ??
      (host.state.home
        ? posix.join(host.state.home, '.life', 'agent-sessions', this.sessionId)
        : undefined)
    this.recoveryInputsDeferred =
      recoveryOptions?.deferRecoveryInputs ?? recoveryOptions?.snapshot !== undefined
    this.recoveryOutputDeferred = recoveryOptions?.snapshot !== undefined
    Deferred.doneUnsafe(this.operationTail, Effect.void)
    if (!recoveryOptions) Deferred.doneUnsafe(this.registration, Effect.void)
    if (recoveryOptions?.snapshot) {
      const snapshot = recoveryOptions.snapshot
      this.descriptor = snapshot.transport
      this.cursor = snapshot.outputCursor
      this.deliveredCursor = snapshot.outputCursor
      this.nextInput = snapshot.allocatedInputSequence
      this.started = true
      this.closing = snapshot.closeInputSequence !== undefined
      this.closeInputSequence = snapshot.closeInputSequence
      for (const input of snapshot.inputs) {
        if (!input.acknowledged && input.cancellation === undefined)
          this.pending.set(input.sequence, input.frame)
      }
    }
    this.machineIdentity = nativeMachineIdentity(this.machine)
    host.on('state', this.onState)
    host.on('disconnected', this.onDisconnected)
    this.stderr.on('drain', this.onStderrDrain)
    // An opening can be cancelled while its SSH exec acknowledgement is pending.
    void this.ready.catch(() => {})
  }

  get isCurrentMachine() {
    return this.matchesMachine(this.host.state.profile)
  }

  get isClosing() {
    return this.closing || this.retired || this.detaching
  }

  /** Ordinary attachments retain queued input until ACK; tracked owners require native receipts. */
  get hasPendingDelivery() {
    return (
      !this.closing && !this.retired && (this.pending.size > 0 || this.writeAdmissions.size > 0)
    )
  }

  matchesMachine(profile?: ConnectionProfile) {
    return (
      sameMachine(this.machine, profile) &&
      (!this.recoveryOptions || profile?.id === this.machine.id)
    )
  }

  get nativeRecoveryTracked() {
    return this.registered && this.recoveryOptions !== undefined
  }

  get recoveryStore() {
    return this.recoveryOptions?.store
  }

  get recoveryId() {
    return this.descriptor?.id
  }

  get recoveryDescriptor() {
    return this.descriptor
  }

  /** Broker evidence proves delivery to its native pipe or control dispatcher. */
  get nativeInputReceipts() {
    return this.inputReceiptCapability === 1
  }

  get hasUnconfirmedRecoveryInputs() {
    return (
      !this.exitReceived &&
      (this.acceptedRecoveryInputs.size > 0 ||
        this.nativeInputUncertain ||
        this.nativeExitUnconfirmed)
    )
  }

  /** Main calls this only after privately matching an original request's raw SDK reply. */
  confirmNativeInputProcessed(sequence: number): void {
    const input = this.nativeInputAdmissions.get(sequence)
    if (
      !input ||
      input.frame.type !== 'write' ||
      input.semantic.requestId === undefined ||
      input.semantic.method === 'initialized' ||
      input.semantic.requestType === 'initialized'
    )
      throw this.recoveryError(
        'native-processing',
        'ownership',
        'Native processing evidence has no exact original response-bearing request.',
      )
    try {
      const request = decodeNativeRequest(
        JSON.parse(Buffer.from(input.frame.data, 'base64').toString('utf8')),
      )
      if (
        request.method === 'initialized' ||
        (!request.method && request.type !== 'control_request') ||
        (request.id ?? request.request_id) !== input.semantic.requestId
      )
        throw this.recoveryError(
          'native-processing',
          'ownership',
          'Native processing evidence does not match the exact original request envelope.',
        )
    } catch (cause) {
      throw cause instanceof NativeRecoveryError
        ? cause
        : this.recoveryError(
            'native-processing',
            'invalid',
            'The original native request envelope cannot establish processing evidence.',
            cause,
          )
    }
    const receipt = this.inputReceipts.get(sequence)
    if (receipt?.status === 'written') return
    if (
      receipt ||
      this.inputReceiptCapability !== 1 ||
      !this.nativeRecoveryTracked ||
      this.transportState !== 'connected' ||
      this.retired ||
      this.terminalAttachment ||
      this.uncertainty ||
      this.nativeInputUncertain ||
      this.nativeExitUnconfirmed
    )
      throw this.recoveryError(
        'native-processing',
        'uncertain',
        'Native processing evidence cannot reopen an unavailable input transport.',
      )
    this.processedNativeInputs.add(sequence)
    const released = this.acceptedRecoveryInputs.delete(sequence)
    if (released && this.acceptedRecoveryInputs.size === 0)
      for (const pending of this.pending.values()) this.send(pending)
  }

  private requireInputDeliveryCapability(operation: string) {
    if (this.nativeRecoveryTracked && this.inputReceiptCapability !== 1)
      throw this.recoveryError(
        operation,
        'unsupported',
        'This broker cannot prove native input delivery. The recovered transport is read-only.',
      )
    if (this.nativeInputUncertain || this.nativeExitUnconfirmed)
      throw this.recoveryError(
        operation,
        'uncertain',
        'The original native input delivery is uncertain. This transport cannot admit mutations.',
      )
    if (this.acceptedRecoveryInputs.size > 0)
      throw this.recoveryError(
        operation,
        'uncertain',
        'An accepted original input has no final delivery evidence. This transport is read-only until that input is resolved.',
      )
  }

  private trackInputDelivery(
    sequence: number,
    waiter: Deferred.Deferred<void, NativeRecoveryError>,
  ) {
    const receipt = this.inputReceipts.get(sequence)
    if (receipt) {
      this.completeInputDelivery(receipt, waiter)
      return
    }
    const waiters = this.inputDeliveryWaiters.get(sequence) ?? new Set()
    waiters.add(waiter)
    this.inputDeliveryWaiters.set(sequence, waiters)
  }

  private completeInputDelivery(
    receipt: NativeRecoveryInputReceipt,
    waiter: Deferred.Deferred<void, NativeRecoveryError>,
  ) {
    Deferred.doneUnsafe(
      waiter,
      receipt.status === 'written'
        ? Effect.void
        : Effect.fail(
            this.recoveryError(
              'input-delivery',
              'uncertain',
              receipt.status === 'cancelled'
                ? 'The broker cancelled the original input before native delivery.'
                : 'The broker could not confirm delivery of the original native input.',
            ),
          ),
    )
  }

  private commitInputReceipt(frame: NativeRecoveryInputReceipt) {
    this.inputReceipts.set(frame.sequence, frame)
    if (frame.status === 'uncertain') {
      this.nativeInputUncertain = true
      this.recoveryFailure(
        this.recoveryError(
          'input-delivery',
          'uncertain',
          'The broker could not confirm delivery of the original native input.',
        ),
      )
      return
    }
    const released =
      frame.status === 'written' && this.acceptedRecoveryInputs.delete(frame.sequence)
    const waiters = this.inputDeliveryWaiters.get(frame.sequence)
    this.inputDeliveryWaiters.delete(frame.sequence)
    for (const waiter of waiters ?? []) this.completeInputDelivery(frame, waiter)
    if (released && this.acceptedRecoveryInputs.size === 0)
      for (const pending of this.pending.values()) this.send(pending)
  }

  /** Cursor of the raw frame currently admitted to provider consumers. */
  get outputCursor() {
    return this.deliveredCursor
  }

  static async open(
    host: DurableChannelHost,
    command: string,
    onOpeningOrOptions?:
      ((channel: DurableRemoteChannel) => void) | DurableRemoteChannelRecoveryOptions,
    recoveryOptions?: DurableRemoteChannelRecoveryOptions,
  ): Promise<DurableRemoteChannel> {
    if (host.state.status !== 'connected') throw new Error('Connect to a machine first')
    const options =
      typeof onOpeningOrOptions === 'function'
        ? recoveryOptions
        : (onOpeningOrOptions ?? recoveryOptions)
    const onOpening = typeof onOpeningOrOptions === 'function' ? onOpeningOrOptions : undefined
    const channel = new DurableRemoteChannel(host, command, options)
    const initialError = () => {}
    channel.on('error', initialError)
    try {
      onOpening?.(channel)
      if (options) await runEffect(channel.registerRecoveryEffect())
      else channel.registered = true
      await Promise.all([channel.attach(), channel.ready])
      return channel
    } catch (error) {
      channel.retire()
      channel.destroy()
      throw error
    } finally {
      channel.off('error', initialError)
    }
  }

  private readonly registerRecoveryEffect = Effect.fn('DurableRemoteChannel.registerRecovery')(
    function* (this: DurableRemoteChannel): Effect.fn.Return<void, NativeRecoveryError> {
      const options = this.recoveryOptions
      if (!options) {
        this.registered = true
        return
      }
      const profile = this.machine
      let descriptor: NativeRecoveryTransport
      if (options.snapshot) {
        const stored = yield* options.store.readTransport(options.snapshot.transport.id)
        descriptor = yield* Schema.decodeUnknownEffect(nativeRecoveryTransportSchema)(
          stored.transport,
        ).pipe(
          Effect.mapError((cause) =>
            this.recoveryError(
              'restore',
              'invalid',
              'Recorded native transport descriptor is invalid.',
              cause,
            ),
          ),
        )
        if (
          descriptor.brokerId !== this.sessionId ||
          descriptor.brokerRoot !== this.brokerRoot ||
          descriptor.launchCommand !== this.command ||
          descriptor.provider !== options.provider ||
          descriptor.machine.profileId !== profile.id ||
          !sameMachine(profile, {
            ...profile,
            ...descriptor.machine,
            transport: descriptor.machine.transport ?? 'ssh',
            id: descriptor.machine.profileId,
          })
        )
          return yield* this.recoveryError(
            'restore',
            'ownership',
            'Recorded native transport does not belong to this machine, profile, provider or launch command.',
          )
        if (descriptor.brokerProtocolVersion !== 2)
          return yield* this.recoveryError(
            'restore',
            'unsupported',
            'Recorded native transport requires an unsupported broker protocol.',
          )
        // A supplied snapshot is a checkpoint, not permission to replace durable
        // state changed by a different runtime since it was read.
        if (
          stored.outputCursor !== options.snapshot.outputCursor ||
          stored.allocatedInputSequence !== options.snapshot.allocatedInputSequence ||
          stored.records.length !== options.snapshot.records.length
        )
          return yield* this.recoveryError(
            'restore',
            'uncertain',
            'Recorded native transport changed after its recovery snapshot was read.',
          )
        for (const input of stored.inputs) {
          this.nativeInputAdmissions.set(input.sequence, input)
          if (!input.deliveryReceipt) continue
          this.inputReceipts.set(input.sequence, {
            type: 'inputReceipt',
            sequence: input.sequence,
            ...input.deliveryReceipt,
          })
          if (input.deliveryReceipt.status !== 'written') this.nativeInputUncertain = true
        }
        if (stored.closeInputSequence !== undefined)
          this.trackInputDelivery(stored.closeInputSequence, this.closeDelivery)
        // Local WAL reconstruction owns event reduction. The channel retains
        // terminal proof without emitting that historical native exit again.
        this.exitReceived = stored.outputs.some(isConfirmedNativeExit)
        this.nativeExitUnconfirmed =
          !this.exitReceived && stored.outputs.some((frame) => frame.type === 'exit')
        if (this.exitReceived) Deferred.doneUnsafe(this.terminal, Effect.succeed(true))
        descriptor = {
          ...descriptor,
          controller: { id: this.controllerId, epoch: descriptor.controller.epoch },
        }
        yield* options.store.updateTransport(descriptor.id, { controller: descriptor.controller })
      } else {
        if (!this.brokerRoot || !posix.isAbsolute(this.brokerRoot))
          return yield* this.recoveryError(
            'register',
            'ownership',
            'Native recovery requires an absolute remote home directory.',
          )
        descriptor = {
          id: this.sessionId,
          brokerId: this.sessionId,
          brokerRoot: this.brokerRoot,
          launchCommand: this.command,
          provider: options.provider,
          providerVersion: this.host.state[options.provider] || 'unknown',
          nativeProtocol:
            options.provider === 'codex' ? 'codex-app-server-jsonrpc' : 'claude-stream-json',
          brokerProtocolVersion: 2,
          machine: {
            transport: profile.transport ?? 'ssh',
            profileId: profile.id,
            host: profile.host,
            port: profile.port,
            username: profile.username,
          },
          controller: { id: this.controllerId, epoch: 0 },
          initialization: { status: 'not-started' },
          owners: [],
        }
        yield* options.store.createTransport(descriptor)
      }
      this.descriptor = descriptor
      this.registered = true
      yield* Deferred.succeed(this.registration, undefined)
    }.bind(this),
    Effect.tapError((error: unknown) =>
      Deferred.fail(
        this.registration,
        error instanceof NativeRecoveryError
          ? error
          : this.recoveryError(
              'register',
              'uncertain',
              'Native transport recovery admission failed.',
              error,
            ),
      ),
    ),
  )

  private recoveryError(
    operation: string,
    reason: NativeRecoveryError['reason'],
    message: string,
    cause?: unknown,
  ) {
    return new NativeRecoveryError({
      operation,
      path: this.descriptor?.id ?? this.sessionId,
      reason,
      message,
      ...(cause === undefined ? {} : { cause }),
    })
  }

  /** FIFO durability operations retain their order even when a caller disappears. */
  private ordered<A>(effect: Effect.Effect<A, NativeRecoveryError>): Promise<A> {
    const previous = this.operationTail
    const done = Deferred.makeUnsafe<void>()
    this.operationTail = done
    return runEffect(
      Deferred.await(previous).pipe(
        Effect.andThen(Deferred.await(this.registration)),
        Effect.andThen(
          Effect.suspend(() => (this.uncertainty ? Effect.fail(this.uncertainty) : effect)),
        ),
        Effect.ensuring(Deferred.succeed(done, undefined)),
      ),
    )
  }

  recordOwner(owner: NativeRecoveryOwner): Promise<void> {
    const store = this.recoveryStore
    if (!store) return Promise.resolve()
    return this.ordered(
      Effect.gen(
        function* (this: DurableRemoteChannel) {
          const id = this.recoveryId
          if (!id)
            return yield* this.recoveryError(
              'owner',
              'uncertain',
              'The native transport registry has not been admitted.',
            )
          const snapshot = yield* store.readTransport(id)
          const owners = [
            ...snapshot.transport.owners.filter((prior) => prior.ownerId !== owner.ownerId),
            owner,
          ]
          yield* store.updateTransport(id, { owners })
          this.descriptor = { ...snapshot.transport, owners }
        }.bind(this),
      ),
    ).catch((error) => {
      this.recoveryFailure(error)
      throw error
    })
  }

  /** Native payload provenance belongs to these exact bytes, never a next-write slot. */
  private nativeBytes(
    message: Record<string, unknown>,
    semantic: NativeRecoveryInputSemantic,
  ): Buffer {
    this.requireInputDeliveryCapability('write')
    if (
      this.closing ||
      this.retired ||
      this.detaching ||
      this.terminalAttachment ||
      this.uncertainty
    )
      throw (
        this.uncertainty ??
        this.recoveryError('write', 'closed', 'The native transport cannot admit another delivery.')
      )
    try {
      const bytes = Buffer.from(JSON.stringify(message) + '\n')
      const copied = Schema.decodeUnknownSync(nativeRecoveryInputSemanticSchema)(
        JSON.parse(JSON.stringify(semantic)),
      )
      this.nativeSemantics.set(bytes, copied)
      return bytes
    } catch (error) {
      const failure = this.recoveryError(
        'write',
        'invalid',
        'Native input or its durable ownership metadata is invalid.',
        error,
      )
      this.recoveryFailure(failure)
      throw failure
    }
  }

  writeNative(
    message: Record<string, unknown>,
    semantic: NativeRecoveryInputSemantic = { kind: 'transport' },
  ): boolean {
    return this.write(this.nativeBytes(message, semantic))
  }

  /** Resolves after this exact envelope's durable, successful broker receipt. */
  writeNativeAndWait(
    message: Record<string, unknown>,
    semantic: NativeRecoveryInputSemantic = { kind: 'transport' },
  ): Promise<void> {
    const delivered = Deferred.makeUnsafe<void, NativeRecoveryError>()
    try {
      const bytes = this.nativeBytes(message, semantic)
      this.nativeDeliveryWaiters.set(bytes, delivered)
      this.write(bytes, (error) => {
        if (error)
          Deferred.doneUnsafe(
            delivered,
            Effect.fail(
              error instanceof NativeRecoveryError
                ? error
                : this.recoveryError('write', 'uncertain', 'Native input admission failed.', error),
            ),
          )
      })
    } catch (error) {
      return Promise.reject(error)
    }
    return runEffect(Deferred.await(delivered))
  }

  override write(chunk: Uint8Array | string, callback?: (error?: Error | null) => void): boolean
  override write(
    chunk: Uint8Array | string,
    encoding: BufferEncoding,
    callback?: (error?: Error | null) => void,
  ): boolean
  override write(
    chunk: Uint8Array | string,
    encodingOrCallback?: BufferEncoding | ((error?: Error | null) => void),
    callback?: (error?: Error | null) => void,
  ): boolean {
    this.requireInputDeliveryCapability('write')
    if (this.detaching || this.retired || this.closing || this.uncertainty)
      throw (
        this.uncertainty ??
        this.recoveryError('write', 'closed', 'The native transport cannot admit another delivery.')
      )
    const encoding = typeof encodingOrCallback === 'string' ? encodingOrCallback : 'utf8'
    const done = typeof encodingOrCallback === 'function' ? encodingOrCallback : callback
    const bytes =
      typeof chunk === 'string'
        ? Buffer.from(chunk, encoding)
        : Buffer.isBuffer(chunk)
          ? chunk
          : Buffer.from(chunk)
    const admitted = Deferred.makeUnsafe<void, NativeRecoveryError>()
    this.writeAdmissions.add(admitted)
    const completed = (error?: Error | null) => {
      this.writeAdmissions.delete(admitted)
      const failure =
        error instanceof NativeRecoveryError
          ? error
          : error
            ? this.recoveryError(
                'write',
                'uncertain',
                'Native input was not durably admitted.',
                error,
              )
            : undefined
      Deferred.doneUnsafe(admitted, failure ? Effect.fail(failure) : Effect.void)
      done?.(failure)
    }
    try {
      return super.write(bytes, completed)
    } catch (error) {
      completed(error instanceof Error ? error : new Error(String(error)))
      throw error
    }
  }

  async flushRecovery(): Promise<void> {
    const accepted = [...this.writeAdmissions]
    await runEffect(
      Effect.forEach(accepted, (admission) => Deferred.await(admission), { discard: true }),
    )
    await this.ordered(this.recoveryStore?.flushEffect() ?? Effect.void)
  }

  resumeRecoveryOutput() {
    this.recoveryOutputDeferred = false
    this.drainTransport?.()
    this.drainOutput()
  }

  override resume(): this {
    const resumed = super.resume()
    // on('data') invokes resume automatically. Flowing must not grant recovery
    // permission before the caller has rebuilt its recorded native ownership.
    this.drainOutput()
    this.drainTransport?.()
    return resumed
  }

  readonly waitForReplayEffect = Effect.fn('DurableRemoteChannel.waitForReplay')(
    function* (this: DurableRemoteChannel) {
      yield* Deferred.await(this.replayed)
    }.bind(this),
  )

  waitForReplay(): Promise<void> {
    return runEffect(this.waitForReplayEffect())
  }

  async activateRecoveryInputs(): Promise<void> {
    await this.waitForReplay()
    this.requireInputDeliveryCapability('activate')
    await this.ordered(
      Effect.gen(
        function* (this: DurableRemoteChannel) {
          if (this.terminalAttachment && this.pending.size > 0)
            return yield* this.recoveryError(
              'activate',
              'uncertain',
              'Completed native transport has unresolved input; no delivery was replayed.',
            )
          this.recoveryInputsDeferred = false
          for (const frame of this.pending.values()) this.send(frame)
        }.bind(this),
      ),
    )
  }

  async detach(): Promise<void> {
    this.detaching = true
    try {
      await this.flushRecovery()
    } finally {
      this.finish()
    }
  }

  override _read() {
    this.stdoutBlocked = false
    this.drainOutput()
    this.drainTransport?.()
    // Readable calls _read before delivering buffered bytes to its consumer.
    // Revisit public receipt events after that delivery, not inside the pull.
    queueMicrotask(() => {
      this.drainOutput()
      this.drainTransport?.()
    })
  }

  override _destroy(error: Error | null, callback: (error?: Error | null) => void) {
    // Destroying a local stream releases its transport. Only close() sends the
    // provider's terminal instruction; an abandoned attachment stays detached.
    this.retire()
    this.stderr.destroy()
    callback(error)
  }

  override _write(
    chunk: Buffer | string,
    encoding: BufferEncoding,
    callback: (error?: Error) => void,
  ) {
    const bytes = typeof chunk === 'string' ? Buffer.from(chunk, encoding) : chunk
    const delivered = this.nativeDeliveryWaiters.get(bytes)
    this.nativeDeliveryWaiters.delete(bytes)
    if (this.closing && !this.uncertainty) {
      // Explicit Stop cancels buffered envelopes that have not allocated a WAL
      // sequence. Admitted envelopes are cancelled atomically by its close.
      if (delivered)
        Deferred.doneUnsafe(
          delivered,
          Effect.fail(
            this.recoveryError(
              'write',
              'uncertain',
              'Explicit close cancelled this unallocated input.',
            ),
          ),
        )
      callback()
      return
    }
    if (this.retired || this.terminalAttachment || this.uncertainty) {
      callback(this.uncertainty ?? new Error('The remote agent session is closed'))
      return
    }
    const semantic = this.nativeSemantics.get(bytes) ?? { kind: 'transport' }
    this.nativeSemantics.delete(bytes)
    void this.queue({ type: 'write', data: bytes.toString('base64') }, semantic, delivered).then(
      () => callback(),
      (error: unknown) => callback(error instanceof Error ? error : new Error(String(error))),
    )
  }

  override _final(callback: (error?: Error) => void) {
    if (this.closing || this.retired || this.terminalAttachment) {
      callback()
      return
    }
    void this.queue({ type: 'end' }, { kind: 'end' }).then(
      () => callback(),
      (error: unknown) => callback(error instanceof Error ? error : new Error(String(error))),
    )
  }

  private queue(
    frame: NativeRecoveryInput,
    semantic: NativeRecoveryInputSemantic = { kind: 'transport' },
    delivered?: Deferred.Deferred<void, NativeRecoveryError>,
  ): Promise<number> {
    const store = this.recoveryStore
    return this.ordered(
      Effect.gen(
        function* (this: DurableRemoteChannel) {
          if (this.nativeRecoveryTracked && this.inputReceiptCapability !== 1)
            return yield* this.recoveryError(
              frame.type,
              'unsupported',
              'This broker cannot prove native input delivery. The recovered transport is read-only.',
            )
          if (this.nativeInputUncertain || this.nativeExitUnconfirmed)
            return yield* this.recoveryError(
              frame.type,
              'uncertain',
              'The original native input delivery is uncertain. This transport cannot admit mutations.',
            )
          if (this.acceptedRecoveryInputs.size > 0)
            return yield* this.recoveryError(
              frame.type,
              'uncertain',
              'An accepted original input has no final delivery evidence. This transport is read-only until that input is resolved.',
            )
          const id = this.recoveryId
          if (store && !id)
            return yield* this.recoveryError(
              'write',
              'uncertain',
              'The native transport registry has not been admitted.',
            )
          if (this.retired && frame.type !== 'close')
            return yield* this.recoveryError(
              'write',
              'closed',
              'The native attachment has been retired.',
            )
          let numbered: InputFrame
          if (store && id) {
            const admitted = yield* store.reserveInput(id, frame, semantic)
            numbered = admitted.frame
            this.nextInput = admitted.sequence
            this.nativeInputAdmissions.set(admitted.sequence, admitted)
          } else {
            numbered = { ...frame, sequence: ++this.nextInput }
          }
          if (this.retired || this.uncertainty || this.nativeInputUncertain) {
            const failure =
              this.uncertainty ??
              this.recoveryError(
                'input-delivery',
                this.nativeInputUncertain ? 'uncertain' : 'closed',
                'The native attachment lost mutation authority after preserving the original input admission.',
              )
            return yield* failure
          }
          if (frame.type === 'close') {
            this.pending.clear()
            this.closeInputSequence = numbered.sequence
          }
          this.pending.set(numbered.sequence, numbered)
          if (delivered) {
            if (this.inputReceiptCapability === 1)
              this.trackInputDelivery(numbered.sequence, delivered)
            else Deferred.doneUnsafe(delivered, Effect.void)
          }
          if (!this.closing || frame.type === 'close') this.send(numbered)
          return numbered.sequence
        }.bind(this),
      ),
    ).catch((error) => {
      const failure =
        error instanceof NativeRecoveryError
          ? error
          : this.recoveryError('input', 'uncertain', 'Native input durability failed.', error)
      this.recoveryFailure(failure)
      if (delivered) Deferred.doneUnsafe(delivered, Effect.fail(failure))
      throw failure
    })
  }

  private send(frame: InputFrame) {
    const transport = this.transport
    if (
      !transport ||
      transport.destroyed ||
      this.transportState !== 'connected' ||
      this.handshakeProcessing ||
      this.recoveryInputsDeferred ||
      (this.nativeRecoveryTracked && this.inputReceiptCapability !== 1) ||
      this.nativeInputUncertain ||
      this.nativeExitUnconfirmed ||
      this.acceptedRecoveryInputs.size > 0 ||
      this.inputReceipts.has(frame.sequence) ||
      this.processedNativeInputs.has(frame.sequence) ||
      !this.writerLease ||
      this.uncertainty ||
      (this.closing && frame.type !== 'close')
    )
      return
    try {
      transport.write(JSON.stringify({ ...frame, writerLease: this.writerLease }) + '\n')
    } catch (error) {
      this.suspend(error instanceof Error ? error : new Error(String(error)))
    }
  }

  private async attach(): Promise<void> {
    if (this.retired || this.transport || !this.registered) return
    if (this.attaching) {
      // The owning attach invocation classifies its result against its own
      // generation. A concurrent state notification must not turn a rejected
      // acknowledgement from an obsolete connection into a new-session error.
      await this.attaching.catch(() => {})
      return
    }
    if (this.host.state.status !== 'connected' || !this.matchesMachine(this.host.state.profile))
      return
    const generation = ++this.attachment
    if (this.hasAttached) {
      Deferred.doneUnsafe(
        this.replayed,
        Effect.fail(
          this.recoveryError(
            'attach',
            'uncertain',
            'Native replay was interrupted by a transport change.',
          ),
        ),
      )
      this.replayed = Deferred.makeUnsafe<void, NativeRecoveryError>()
    }
    this.hasAttached = true
    const starting = (async () => {
      const launch = !this.started && this.recoveryOptions?.snapshot === undefined
      // The server may execute the bootstrap before acknowledging the SSH exec
      // request. Once sent, its outcome is uncertain after a network cut, so a
      // reattachment must locate that session rather than launch a replacement.
      this.started = true
      const configuration: RemoteAgentBrokerConfig = {
        id: this.sessionId,
        command: this.command,
        root: this.brokerRoot,
        cursor: this.cursor,
        launch,
        controllerId: this.controllerId,
        expectedProtocol: 2,
      }
      const transport = await this.host.channel(
        this.host.agentBrokerCommand?.(configuration) ??
          buildRemoteAgentBrokerCommand(configuration),
        undefined,
        undefined,
        30000,
        false,
      )
      if (this.retired || generation !== this.attachment) {
        transport.close()
        return
      }
      this.transport = transport
      this.writerLease = undefined
      this.handshakeProcessing = false
      this.terminalAttachment = false
      this.replayCompleteReceived = false
      this.replayCommitted = false
      this.handshakeTimer = setTimeout(() => {
        if (generation !== this.attachment || this.transport !== transport || this.retired) return
        this.transportFailure(
          new Error(
            'The remote agent broker did not become ready within 20 seconds. No prompt was replayed.',
          ),
        )
      }, 20000)
      this.handshakeTimer.unref()
      let buffer = ''
      let diagnostic = ''
      const decoder = new StringDecoder('utf8')
      const active = () => generation === this.attachment && this.transport === transport
      let draining = false
      const drain = () => {
        if (!active() || draining) return
        draining = true
        try {
          let offset = 0
          let newline: number
          while (true) {
            // Accept the ready handshake even if output from a previous transport
            // remains buffered, then stop replay until both consumers can read.
            if (
              this.handshakeProcessing ||
              (this.transportState === 'connected' && this.recoveryOutputDeferred) ||
              this.outputCommitBlocked
            ) {
              buffer = buffer.slice(offset)
              transport.pause()
              return
            }
            if (
              !this.closing &&
              this.transportState === 'connected' &&
              (this.stdoutBlocked || this.stderrBlocked)
            ) {
              buffer = buffer.slice(offset)
              transport.pause()
              return
            }
            newline = buffer.indexOf('\n', offset)
            // Limit individual frames, not a batch of bounded frames coalesced by
            // SSH. Keep at most the current transport chunk while paused.
            if ((newline === -1 ? buffer.length : newline) - offset > 2_000_000) {
              this.transportFailure(
                new Error('The remote agent broker returned an oversized frame'),
              )
              return
            }
            if (newline === -1) break
            const line = buffer.slice(offset, newline)
            offset = newline + 1
            if (!line.trim()) continue
            let frame: Frame
            try {
              const parsed: unknown = JSON.parse(line)
              frame =
                Predicate.isObject(parsed) && parsed.type === 'inputReceipt'
                  ? decodeStrictBrokerFrame(parsed)
                  : decodeBrokerFrame(parsed)
            } catch {
              diagnostic = (diagnostic + '\n' + line).slice(-8192)
              this.transportFailure(
                this.recoveryError(
                  'decode-frame',
                  'invalid',
                  'The remote agent broker returned an invalid protocol frame.',
                ),
              )
              return
            }
            this.receive(frame)
            if (!active()) return
          }
          buffer = buffer.slice(offset)
          if (transport.isPaused()) transport.resume()
        } finally {
          draining = false
        }
      }
      this.drainTransport = drain
      const consume = (chunk: Buffer) => {
        if (!active()) return
        buffer += decoder.write(chunk)
        drain()
      }
      transport.on('data', consume)
      transport.stderr.on('data', (chunk: Buffer) => {
        diagnostic = (diagnostic + chunk.toString()).slice(-8192)
      })
      const lost = (error?: Error) => {
        if (this.transport !== transport || generation !== this.attachment || this.retired) return
        this.transport = undefined
        this.drainTransport = undefined
        if (this.handshakeTimer) clearTimeout(this.handshakeTimer)
        this.handshakeTimer = undefined
        if (this.exitReceived) return
        // ssh2 can close child exec channels just before the parent connection
        // reports its network failure. Give that state event a turn to arrive
        // before treating a missing initial handshake as a broker failure.
        setImmediate(() => {
          if (generation !== this.attachment || this.retired || this.exitReceived) return
          if (this.host.state.status !== 'connected') this.suspend(error)
          else if (this.transportState !== 'connected')
            this.transportFailure(
              error || new Error(diagnostic.trim() || 'The remote agent broker could not start'),
            )
          else this.suspend(error)
        })
      }
      transport.on('error', lost)
      transport.on('close', () => lost())
    })()
    this.attaching = starting
    try {
      await starting
    } catch (error) {
      if (generation !== this.attachment || this.host.state.status !== 'connected') return
      throw error
    } finally {
      if (this.attaching === starting) this.attaching = undefined
      if (
        generation !== this.attachment &&
        !this.retired &&
        !this.transport &&
        this.host.state.status === 'connected' &&
        this.matchesMachine(this.host.state.profile)
      )
        void this.attach().catch((error) => this.transportFailure(error))
    }
  }

  private receive(frame: Frame) {
    if (frame.type === 'error') {
      this.transportFailure(
        this.recoveryError(
          'remote',
          'uncertain',
          frame.message || 'The remote agent session failed',
        ),
      )
      return
    }
    if (frame.type === 'ready') {
      if (this.transportState === 'connected' || this.handshakeProcessing) {
        this.transportFailure(
          this.recoveryError(
            'ready',
            'invalid',
            'The remote agent broker sent a duplicate ready handshake.',
          ),
        )
        return
      }
      if (frame.protocol !== 2) {
        this.transportFailure(
          this.recoveryError(
            'ready',
            'unsupported',
            'The remote agent broker does not support the required fenced protocol.',
          ),
        )
        return
      }
      if (frame.cursor < this.cursor) {
        this.transportFailure(
          this.recoveryError(
            'ready',
            'uncertain',
            'The remote output journal is behind the admitted local cursor.',
          ),
        )
        return
      }
      if (this.descriptor?.inputReceipts === 1 && frame.inputReceipts !== 1) {
        this.transportFailure(
          this.recoveryError(
            'ready',
            'unsupported',
            'The broker no longer supports the recorded native delivery receipt contract.',
          ),
        )
        return
      }
      if (this.exitReceived && !frame.terminal) {
        this.transportFailure(
          this.recoveryError(
            'ready',
            'uncertain',
            'A completed native transport cannot regain live mutation ownership.',
          ),
        )
        return
      }
      if ([...this.processedNativeInputs].some((sequence) => sequence > frame.lastInputSequence)) {
        this.transportFailure(
          this.recoveryError(
            'ready',
            'uncertain',
            'The broker acceptance journal is behind privately correlated native processing evidence.',
          ),
        )
        return
      }
      if (
        frame.writerUnavailable ||
        frame.observer ||
        (!frame.terminal && !frame.writerLease) ||
        (frame.terminal && frame.writerLease)
      ) {
        this.transportFailure(
          this.recoveryError(
            'ready',
            'ownership',
            'The remote agent attachment does not hold the writer lease.',
          ),
        )
        return
      }
      const generation = this.attachment
      const transport = this.transport
      this.handshakeProcessing = true
      const store = this.recoveryStore
      const id = this.recoveryId
      void this.ordered(
        Effect.gen(
          function* (this: DurableRemoteChannel) {
            if (store && id) {
              const pending = yield* store.reconcileInputHighWater(id, frame.lastInputSequence)
              this.pending = new Map(pending.map((input) => [input.sequence, input.frame]))
              const snapshot = yield* store.readTransport(id)
              this.nextInput = snapshot.allocatedInputSequence
              this.acceptedRecoveryInputs.clear()
              for (const input of snapshot.inputs) {
                this.nativeInputAdmissions.set(input.sequence, input)
                if (
                  input.acknowledged &&
                  input.cancellation === undefined &&
                  input.deliveryReceipt === undefined &&
                  !this.processedNativeInputs.has(input.sequence)
                )
                  this.acceptedRecoveryInputs.add(input.sequence)
              }
              const patch = {
                ...(frame.inputReceipts === 1 ? { inputReceipts: 1 as const } : {}),
                ...(frame.writerLease
                  ? { controller: { id: this.controllerId, epoch: frame.writerLease.epoch } }
                  : {}),
              }
              if (Object.keys(patch).length > 0) yield* store.updateTransport(id, patch)
              this.descriptor = { ...snapshot.transport, ...patch }
            } else {
              if (frame.lastInputSequence > this.nextInput)
                return yield* this.recoveryError(
                  'ready',
                  'uncertain',
                  'Broker input watermark exceeds the known local outbox.',
                )
              for (const sequence of this.pending.keys())
                if (sequence <= frame.lastInputSequence) this.pending.delete(sequence)
            }
          }.bind(this),
        ),
      ).then(
        () => {
          if (generation !== this.attachment || this.transport !== transport || this.retired) return
          this.handshakeProcessing = false
          this.inputReceiptCapability = frame.inputReceipts
          this.writerLease = frame.writerLease
          this.terminalAttachment = frame.terminal === true
          const wasSuspended = this.transportState === 'suspended'
          this.transportState = 'connected'
          if (this.handshakeTimer) clearTimeout(this.handshakeTimer)
          this.handshakeTimer = undefined
          this.reattachAttempts = 0
          if (this.reattachTimer) clearTimeout(this.reattachTimer)
          this.reattachTimer = undefined
          this.readyResolve()
          for (const pending of this.pending.values()) this.send(pending)
          if (wasSuspended) this.emit('resumed')
          this.drainTransport?.()
        },
        (error) => this.recoveryFailure(error),
      )
      return
    }
    if (this.transportState !== 'connected' || this.handshakeProcessing) {
      this.transportFailure(
        this.recoveryError(
          'receive',
          'invalid',
          'The remote agent broker sent a frame before a verified ready handshake.',
        ),
      )
      return
    }
    if (frame.type === 'ack') {
      if (frame.sequence > this.nextInput) {
        this.transportFailure(
          this.recoveryError(
            'ack',
            'uncertain',
            'Broker acknowledged an input absent from the local outbox.',
          ),
        )
        return
      }
      const store = this.recoveryStore
      const id = this.recoveryId
      void this.ordered(
        store && id ? store.acknowledgeInput(id, frame.sequence) : Effect.void,
      ).then(
        () => {
          for (const sequence of this.pending.keys())
            if (sequence <= frame.sequence) this.pending.delete(sequence)
          if (
            this.closing &&
            this.pending.size === 0 &&
            !this.waitForRemoteExit &&
            this.inputReceiptCapability !== 1
          )
            this.finish()
        },
        (error) => this.recoveryFailure(error),
      )
      return
    }
    if (frame.type === 'replayComplete') {
      if (this.replayCompleteReceived || frame.replayCursor !== this.cursor) {
        this.transportFailure(
          this.recoveryError(
            'replay',
            'uncertain',
            'The remote agent replay barrier does not match its output journal.',
          ),
        )
        return
      }
      this.replayCompleteReceived = true
      const replayed = this.replayed
      const generation = this.attachment
      const outputs = this.outputDeliveries.slice()
      // Consumer backpressure cannot own the durability FIFO: detach and Stop
      // must still preserve admissions while replay publication is held.
      void this.ordered(this.recoveryStore?.flushEffect() ?? Effect.void)
        .then(() =>
          runEffect(
            Effect.forEach(outputs, (delivery) => Deferred.await(delivery.published), {
              discard: true,
            }),
          ),
        )
        .then(
          () => {
            if (this.uncertainty || generation !== this.attachment) return
            this.replayCommitted = true
            Deferred.doneUnsafe(replayed, Effect.void)
            this.emit('replayComplete')
            this.finishConfirmedExit()
          },
          (error) => this.recoveryFailure(error),
        )
      return
    }
    if (frame.cursor <= this.cursor) {
      const known =
        this.recentOutputs.get(frame.cursor) ??
        this.recoveryOptions?.snapshot?.outputs.find((output) => output.cursor === frame.cursor)
      if (!known || JSON.stringify(known) !== JSON.stringify(frame))
        this.transportFailure(
          this.recoveryError(
            'output',
            'uncertain',
            'The remote output journal repeated a cursor with conflicting or unknown bytes.',
          ),
        )
      return
    }
    if (frame.cursor !== this.cursor + 1) {
      this.transportFailure(
        this.recoveryError(
          'output',
          'uncertain',
          'The remote agent output journal has a missing frame',
        ),
      )
      return
    }
    if (frame.type === 'inputReceipt') {
      if (this.inputReceiptCapability !== 1 || frame.sequence > this.nextInput) {
        this.transportFailure(
          this.recoveryError(
            'input-receipt',
            'uncertain',
            'Broker delivery evidence does not identify an authorized input under its negotiated contract.',
          ),
        )
        return
      }
      const prior = this.inputReceipts.get(frame.sequence)
      if (prior && (prior.status !== frame.status || prior.cursor !== frame.cursor)) {
        this.transportFailure(
          this.recoveryError(
            'input-receipt',
            'uncertain',
            'Broker delivery evidence replaces an earlier final receipt identity.',
          ),
        )
        return
      }
      // Receipt persistence is asynchronous. Fence new mutations as soon as an
      // authenticated uncertainty notice arrives, before its batched commit.
      if (frame.status !== 'written') this.nativeInputUncertain = true
    }
    const payload =
      frame.type === 'stdout' || frame.type === 'stderr'
        ? Buffer.from(frame.data, 'base64')
        : undefined
    if (
      payload &&
      payload.toString('base64') !== (frame as Extract<Frame, { type: 'stdout' | 'stderr' }>).data
    ) {
      this.transportFailure(
        this.recoveryError(
          'output',
          'invalid',
          'The remote agent broker returned noncanonical output bytes.',
        ),
      )
      return
    }
    this.cursor = frame.cursor
    this.recentOutputs.set(frame.cursor, frame)
    this.recentOutputBytes += payload?.length ?? 0
    while (this.recentOutputs.size > 128 || this.recentOutputBytes > 2 * 1024 * 1024) {
      const oldest = this.recentOutputs.entries().next().value!
      this.recentOutputBytes -=
        oldest[1].type === 'stdout' || oldest[1].type === 'stderr'
          ? Buffer.byteLength(oldest[1].data, 'base64')
          : 0
      this.recentOutputs.delete(oldest[0])
    }
    const delivery: OutputDelivery = {
      frame,
      bytes: payload?.length ?? 0,
      ...(payload ? { payload } : {}),
      published: Deferred.makeUnsafe<void, NativeRecoveryError>(),
      committed: !this.recoveryStore,
    }
    this.outputDeliveries.push(delivery)
    this.pendingOutputBytes += delivery.bytes
    this.outputCommitBlocked = this.pendingOutputBytes >= 256 * 1024
    const store = this.recoveryStore
    const id = this.recoveryId
    if (store && id) {
      // Start each append independently so the store can group raw frames into
      // one ordered fsync. Publication waits for the admitted batch, not a token
      // at a time; the memory cursor is never a durable parser checkpoint.
      void runEffect(store.appendOutputs(id, [frame])).then(
        () => {
          delivery.committed = true
          if (frame.type === 'inputReceipt') this.commitInputReceipt(frame)
          this.drainOutput()
        },
        (error) => {
          const failure =
            error instanceof NativeRecoveryError
              ? error
              : this.recoveryError('output', 'uncertain', 'Native output durability failed.', error)
          Deferred.doneUnsafe(delivery.published, Effect.fail(failure))
          this.recoveryFailure(failure)
        },
      )
    } else {
      if (frame.type === 'inputReceipt') this.commitInputReceipt(frame)
      this.drainOutput()
    }
  }

  private drainOutput() {
    if (this.retired || this.recoveryOutputDeferred) return
    while (this.outputDeliveries[0]?.committed) {
      if (!this.closing && (this.stdoutBlocked || this.stderrBlocked)) break
      if (
        !this.closing &&
        this.outputDeliveries[0].frame.type === 'inputReceipt' &&
        this.readableLength > 0
      )
        break
      const delivery = this.outputDeliveries.shift()!
      this.pendingOutputBytes -= delivery.bytes
      const frame = delivery.frame
      this.deliveredCursor = frame.cursor
      if (frame.type === 'inputReceipt') {
        this.emit('input-receipt', frame)
        if (
          frame.status === 'written' &&
          this.closing &&
          !this.waitForRemoteExit &&
          this.closeInputSequence === frame.sequence
        )
          setImmediate(() => this.finish())
        else if (frame.status === 'written') this.finishConfirmedExit()
      } else if (frame.type === 'exit') {
        if (!isConfirmedNativeExit(frame)) {
          this.nativeExitUnconfirmed = true
          this.recoveryFailure(
            this.recoveryError(
              'native-exit',
              'uncertain',
              'The broker detached without observing provider exit. Native ownership remains unresolved.',
            ),
          )
          Deferred.doneUnsafe(delivery.published, Effect.void)
          return
        }
        this.exitReceived = true
        Deferred.doneUnsafe(this.terminal, Effect.succeed(true))
        this.emit('exit', frame.code ?? undefined, frame.signal)
        this.finishConfirmedExit()
      } else if (!this.closing) {
        const bytes = delivery.payload!
        if (frame.type === 'stdout') this.stdoutBlocked = !this.push(bytes)
        else this.stderrBlocked = !this.stderr.write(bytes)
      }
      Deferred.doneUnsafe(delivery.published, Effect.void)
    }
    this.outputCommitBlocked = this.pendingOutputBytes >= 256 * 1024
    this.drainTransport?.()
  }

  private finishConfirmedExit() {
    if (
      this.exitReceived &&
      this.replayCommitted &&
      this.outputDeliveries.length === 0 &&
      (!this.waitForRemoteExit ||
        !this.closing ||
        (this.closeInputSequence !== undefined &&
          this.inputReceipts.get(this.closeInputSequence)?.status === 'written'))
    )
      setImmediate(() => this.finish())
  }

  private publishClose() {
    if (this.localClosePublished) return
    this.localClosePublished = true
    this.push(null)
    this.stderr.end()
    this.emit('close')
  }

  private recoveryFailure(error: unknown) {
    const failure =
      error instanceof NativeRecoveryError
        ? error
        : this.recoveryError(
            'durability',
            'uncertain',
            error instanceof Error
              ? error.message
              : 'Native recovery durability failed; the provider was detached without termination.',
            error,
          )
    if (this.uncertainty || this.retired) return
    this.uncertainty = failure
    this.readyReject(failure)
    Deferred.doneUnsafe(this.replayed, Effect.fail(failure))
    // Fence before publishing failure so consumer cleanup cannot turn an
    // uncertain write into a provider Stop or replacement launch.
    this.retire()
    this.emit('error', failure)
    this.publishClose()
  }

  private suspend(error?: Error) {
    if (this.retired || this.transportState === 'closed') return
    const transport = this.transport
    this.transport = undefined
    this.drainTransport = undefined
    this.writerLease = undefined
    this.handshakeProcessing = false
    if (this.handshakeTimer) clearTimeout(this.handshakeTimer)
    this.handshakeTimer = undefined
    this.attachment++
    transport?.close()
    if (this.transportState !== 'suspended') {
      this.transportState = 'suspended'
      this.emit('suspended', error || new Error('SSH connection closed'))
    }
    this.scheduleReattach()
  }

  private scheduleReattach() {
    if (
      this.retired ||
      this.reattachTimer ||
      this.host.state.status !== 'connected' ||
      !this.matchesMachine(this.host.state.profile)
    )
      return
    const delay = Math.min(3000, 100 * 2 ** Math.min(this.reattachAttempts++, 5))
    this.reattachTimer = setTimeout(() => {
      this.reattachTimer = undefined
      void this.attach().catch((error) => this.transportFailure(error))
    }, delay)
    this.reattachTimer.unref()
  }

  private transportFailure(error: unknown) {
    const failure = error instanceof Error ? error : new Error(String(error))
    if (this.host.state.status !== 'connected' && !(error instanceof NativeRecoveryError)) {
      this.suspend(failure)
      return
    }
    this.recoveryFailure(failure)
  }

  private controlSemantic(semantic: NativeRecoveryInputSemantic): NativeRecoveryInputSemantic {
    try {
      return Schema.decodeUnknownSync(nativeRecoveryInputSemanticSchema)(
        JSON.parse(JSON.stringify(semantic)),
      )
    } catch (error) {
      const failure = this.recoveryError(
        'control',
        'invalid',
        'Native control ownership metadata is invalid.',
        error,
      )
      this.recoveryFailure(failure)
      throw failure
    }
  }

  signalNativeAndWait(signalName: string, semantic: NativeRecoveryInputSemantic): Promise<void> {
    if (
      this.closing ||
      this.retired ||
      this.detaching ||
      this.terminalAttachment ||
      this.uncertainty
    )
      return Promise.reject(
        this.uncertainty ??
          this.recoveryError(
            'signal',
            'closed',
            'The native transport cannot admit another control delivery.',
          ),
      )
    let copied: NativeRecoveryInputSemantic
    try {
      this.requireInputDeliveryCapability('signal')
      copied = this.controlSemantic(semantic)
    } catch (error) {
      return Promise.reject(error)
    }
    const delivered = Deferred.makeUnsafe<void, NativeRecoveryError>()
    return this.queue(
      {
        type: 'signal',
        signal: signalName.startsWith('SIG') ? signalName : 'SIG' + signalName,
      },
      copied,
      delivered,
    ).then(() => runEffect(Deferred.await(delivered)))
  }

  signal(signalName: string) {
    if (this.closing || this.retired || this.detaching || this.terminalAttachment) return
    void this.signalNativeAndWait(signalName, { kind: 'interrupt' }).catch(() => {})
  }

  eof() {
    this.end()
  }

  /** Quit may disconnect SSH only after an idle provider has relinquished its writer. */
  readonly closeAndWaitEffect = Effect.fn('DurableRemoteChannel.closeAndWait')(
    function* (
      this: DurableRemoteChannel,
      timeoutMs = 8_000,
      semantic: NativeRecoveryInputSemantic = { kind: 'close' },
    ) {
      if (this.nativeExitUnconfirmed) {
        this.finish()
        return false
      }
      this.waitForRemoteExit = true
      yield* Effect.try({
        try: () => this.close(semantic),
        catch: (cause) =>
          cause instanceof NativeRecoveryError
            ? cause
            : this.recoveryError('close', 'uncertain', 'Native close admission failed.', cause),
      })
      return yield* Effect.all(
        [Deferred.await(this.terminal), Deferred.await(this.closeDelivery)],
        { concurrency: 'unbounded' },
      ).pipe(
        Effect.timeoutOption(timeoutMs),
        Effect.map((result) =>
          Option.match(result, { onNone: () => false, onSome: ([exited]) => exited }),
        ),
        Effect.catch((error) =>
          this.nativeExitUnconfirmed ? Effect.succeed(false) : Effect.fail(error),
        ),
        Effect.ensuring(Effect.sync(() => this.finish())),
      )
    }.bind(this),
  )

  async closeNativeAndWait(
    semantic: NativeRecoveryInputSemantic,
    timeoutMs = 8_000,
  ): Promise<boolean> {
    const copied = this.controlSemantic(semantic)
    const exited = await runEffect(this.closeAndWaitEffect(timeoutMs, copied))
    if (this.uncertainty && !this.nativeExitUnconfirmed) throw this.uncertainty
    return exited
  }

  close(semantic: NativeRecoveryInputSemantic = { kind: 'close' }) {
    if (this.closing || this.retired || this.detaching || this.terminalAttachment) return
    this.requireInputDeliveryCapability('close')
    const copied = this.controlSemantic(semantic)
    this.closing = true
    // Closing is an out-of-band terminal instruction. Discard deliveries that
    // might not have reached the remote process instead of sending a queued
    // user prompt solely to satisfy a sequence gap before termination.
    if (this.reattachTimer) clearTimeout(this.reattachTimer)
    this.reattachTimer = undefined
    void this.queue({ type: 'close' }, copied, this.closeDelivery).then(
      () => {
        if (!this.retired && this.inputReceiptCapability !== 1) this.publishClose()
      },
      () => {},
    )
    this.drainOutput()
    this.drainTransport?.()
    this.scheduleReattach()
  }

  private finish() {
    if (this.retired) return
    this.retire()
    this.publishClose()
  }

  private retire() {
    this.retired = true
    Deferred.doneUnsafe(this.terminal, Effect.succeed(false))
    const failure =
      this.uncertainty ??
      this.recoveryError('retire', 'closed', 'The remote agent session closed before it was ready.')
    this.readyReject(failure)
    Deferred.doneUnsafe(this.replayed, Effect.fail(failure))
    this.transportState = 'closed'
    for (const delivery of this.outputDeliveries)
      Deferred.doneUnsafe(delivery.published, Effect.fail(failure))
    for (const waiters of this.inputDeliveryWaiters.values())
      for (const waiter of waiters) Deferred.doneUnsafe(waiter, Effect.fail(failure))
    this.inputDeliveryWaiters.clear()
    this.outputDeliveries = []
    this.pendingOutputBytes = 0
    this.pending.clear()
    if (this.reattachTimer) clearTimeout(this.reattachTimer)
    this.reattachTimer = undefined
    if (this.handshakeTimer) clearTimeout(this.handshakeTimer)
    this.handshakeTimer = undefined
    this.host.off('state', this.onState)
    this.host.off('disconnected', this.onDisconnected)
    this.stderr.off('drain', this.onStderrDrain)
    const transport = this.transport
    this.transport = undefined
    this.drainTransport = undefined
    this.attachment++
    transport?.close()
  }
}
