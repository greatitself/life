import { Schema } from 'effect'

export const NATIVE_RECOVERY_FORMAT = 'life-native-recovery' as const
export const NATIVE_RECOVERY_VERSION = 1 as const

const nonempty = Schema.NonEmptyString
const positive = Schema.Natural.check(Schema.isGreaterThan(0))
const nativeId = Schema.Union([Schema.String, Schema.Int])
const provider = Schema.Literals(['codex', 'claude'])
const absolutePath = Schema.String.check(Schema.isPattern(/^\//))

/** Payloads remain JSON, including fields introduced by newer native providers. */
export type NativeRecoveryJson = Schema.Json
export type NativeRecoveryJsonObject = Schema.JsonObject

export const nativeRecoveryMachineSchema = Schema.Struct({
  transport: Schema.optionalKey(Schema.Literals(['ssh', 'local'])),
  profileId: nonempty,
  host: nonempty,
  port: positive.check(Schema.isLessThanOrEqualTo(65535)),
  username: nonempty,
})

export const nativeRecoveryControllerSchema = Schema.Struct({
  id: nonempty,
  epoch: Schema.Natural,
})

export const nativeRecoveryInitializationSchema = Schema.Struct({
  status: Schema.Literals(['not-started', 'pending', 'complete']),
  requestId: Schema.optionalKey(nativeId),
})

export const nativeRecoveryStartInputSchema = Schema.Struct({
  sessionId: nonempty,
  provider,
  prompt: Schema.String,
  mode: Schema.Literals([
    'review',
    'edit',
    'plan',
    'ask-for-approval',
    'read-only',
    'full-access',
    'auto-review',
    'auto',
    'dontAsk',
  ]),
  remoteId: Schema.optionalKey(Schema.String),
  workspace: Schema.optionalKey(absolutePath),
  localTurn: Schema.optionalKey(Schema.Natural),
  clientRecovery: Schema.optionalKey(Schema.Json),
})

/** Captured provider commands; execution still requires privately owned start evidence. */
export const nativeRecoveryStartPlanSchema = Schema.Union([
  Schema.Struct({
    provider: Schema.Literal('codex'),
    thread: Schema.Struct({
      method: Schema.Literals(['thread/start', 'thread/resume']),
      params: Schema.JsonObject,
    }),
    turn: Schema.Struct({ params: Schema.JsonObject }),
  }),
  Schema.Struct({
    provider: Schema.Literal('claude'),
    initialize: Schema.JsonObject,
    user: Schema.JsonObject,
    controls: Schema.optionalKey(
      Schema.Array(
        Schema.Struct({
          request: Schema.JsonObject,
          details: Schema.optionalKey(Schema.JsonObject),
        }),
      ),
    ),
  }),
])

export const nativeRecoveryOwnerSchema = Schema.Struct({
  ownerId: nonempty,
  sessionId: nonempty,
  generation: Schema.optionalKey(Schema.Natural),
  localTurn: Schema.optionalKey(Schema.Natural),
  snapshotToken: Schema.optionalKey(nonempty),
  kind: Schema.Literals(['root', 'child']),
  parentSessionId: Schema.optionalKey(nonempty),
  workspace: absolutePath,
  writableRoot: Schema.optionalKey(absolutePath),
  nativeThreadId: Schema.optionalKey(nonempty),
  nativeSessionId: Schema.optionalKey(nonempty),
  nativeTurnId: Schema.optionalKey(nonempty),
  state: Schema.Literals(['starting', 'active', 'idle', 'unknown', 'complete']),
  phase: Schema.optionalKey(Schema.Literals(['initializing', 'startingTurn', 'running'])),
  stopRequested: Schema.optionalKey(Schema.Boolean),
  ignoredTurns: Schema.optionalKey(Schema.Array(Schema.String)),
  claudeRestartForSettings: Schema.optionalKey(Schema.Boolean),
  linkedTransportId: Schema.optionalKey(nonempty),
  nativeStartIntentId: Schema.optionalKey(nonempty),
  nativeStartClaimed: Schema.optionalKey(Schema.Boolean),
  nativeStartPlan: Schema.optionalKey(nativeRecoveryStartPlanSchema),
  input: Schema.JsonObject,
  clientRecovery: Schema.optionalKey(Schema.Json),
})

export const nativeRecoveryTransportSchema = Schema.Struct({
  id: nonempty,
  brokerId: nonempty,
  brokerRoot: absolutePath,
  launchCommand: nonempty,
  provider,
  providerVersion: nonempty,
  nativeProtocol: nonempty,
  brokerProtocolVersion: positive,
  inputReceipts: Schema.optionalKey(Schema.Literal(1)),
  machine: nativeRecoveryMachineSchema,
  controller: nativeRecoveryControllerSchema,
  initialization: nativeRecoveryInitializationSchema,
  owners: Schema.Array(nativeRecoveryOwnerSchema),
})

export const nativeRecoveryTransportPatchSchema = Schema.Struct({
  inputReceipts: Schema.optionalKey(Schema.Literal(1)),
  controller: Schema.optionalKey(nativeRecoveryControllerSchema),
  initialization: Schema.optionalKey(nativeRecoveryInitializationSchema),
  owners: Schema.optionalKey(Schema.Array(nativeRecoveryOwnerSchema)),
})

export const nativeRecoveryInputSchema = Schema.Union([
  Schema.Struct({ type: Schema.Literal('write'), data: Schema.String }),
  Schema.Struct({ type: Schema.Literal('signal'), signal: nonempty }),
  Schema.Struct({ type: Schema.Literal('end') }),
  Schema.Struct({ type: Schema.Literal('close') }),
])

export const nativeRecoveryInputSemanticSchema = Schema.Struct({
  kind: Schema.Literals([
    'initialize',
    'user-prompt',
    'permission-response',
    'steer',
    'settings',
    'interrupt',
    'end',
    'close',
    'transport',
  ]),
  sessionId: Schema.optionalKey(nonempty),
  method: Schema.optionalKey(nonempty),
  requestId: Schema.optionalKey(nativeId),
  requestType: Schema.optionalKey(nonempty),
  permissionRequestId: Schema.optionalKey(nativeId),
  nativeThreadId: Schema.optionalKey(nonempty),
  nativeTurnId: Schema.optionalKey(nonempty),
  ownerGeneration: Schema.optionalKey(Schema.Natural),
  responseBinding: Schema.optionalKey(Schema.Json),
  details: Schema.optionalKey(Schema.Json),
})

export const nativeRecoveryOutputSchema = Schema.Union([
  Schema.Struct({ type: Schema.Literal('stdout'), cursor: positive, data: Schema.String }),
  Schema.Struct({ type: Schema.Literal('stderr'), cursor: positive, data: Schema.String }),
  Schema.Struct({
    type: Schema.Literal('exit'),
    cursor: positive,
    code: Schema.optionalKey(Schema.Union([Schema.Int, Schema.Null])),
    signal: Schema.optionalKey(Schema.Union([Schema.String, Schema.Null])),
    nativeExitConfirmed: Schema.optionalKey(Schema.Boolean),
  }),
  Schema.Struct({
    type: Schema.Literal('inputReceipt'),
    cursor: positive,
    sequence: positive,
    status: Schema.Literals(['written', 'cancelled', 'uncertain']),
  }),
])

export const nativeRecoveryEventSchema = Schema.Struct({
  eventId: nonempty,
  outputCursor: Schema.Natural,
  nativeRequestId: Schema.optionalKey(nativeId),
  emittedAtMs: Schema.optionalKey(Schema.Natural),
  event: Schema.JsonObject,
})

export const nativeRecoveryAgentEventSchema = Schema.Struct({
  sessionId: nonempty,
  type: Schema.Literals([
    'text',
    'tool',
    'tool-output',
    'approval',
    'question',
    'request-resolved',
    'account-usage',
    'complete',
    'error',
    'session',
    'status',
    'title',
    'settings',
    'reasoning',
    'plan',
    'subagent',
  ]),
})

export const nativeRecoveryCheckpointSchema = Schema.Struct({
  throughOutputCursor: Schema.Natural,
  throughEventRevision: Schema.Natural,
  reducerState: Schema.Json,
  parserTail: Schema.optionalKey(
    Schema.Struct({
      stdoutBase64: Schema.String,
      stderrBase64: Schema.String,
      decoderState: Schema.optionalKey(Schema.Json),
    }),
  ),
})

const historyFileHash = Schema.String.check(Schema.isPattern(/^[a-f0-9]{64}$/))

export const nativeRecoveryHistoryPreparedOwnerSchema = Schema.Struct({
  consumerId: nonempty,
  sessionId: nonempty,
  snapshotToken: nonempty,
  ownerGeneration: Schema.Natural,
  throughEventRevision: Schema.Natural,
  authority: Schema.Literals(['native-delivery', 'private-ack']),
  absent: Schema.optionalKey(Schema.Literal(true)),
})

export const nativeRecoveryHistoryPrepareSchema = Schema.Struct({
  snapshotId: nonempty,
  fileHash: historyFileHash,
  location: Schema.optionalKey(Schema.Literals(['native-file', 'studio-cache', 'main-cache'])),
  savedAt: Schema.optionalKey(Schema.Natural),
  owners: Schema.Array(nativeRecoveryHistoryPreparedOwnerSchema),
})

export const nativeRecoveryHistoryAckSchema = Schema.Struct({
  consumerId: nonempty,
  sessionId: nonempty,
  snapshotId: nonempty,
  durability: Schema.Literals(['native', 'admitted-cache']),
  snapshotToken: Schema.optionalKey(nonempty),
  ownerGeneration: Schema.optionalKey(Schema.Natural),
  fileHash: Schema.optionalKey(historyFileHash),
  throughEventRevision: Schema.Natural,
})

export type NativeRecoveryMachine = typeof nativeRecoveryMachineSchema.Type
export type NativeRecoveryController = typeof nativeRecoveryControllerSchema.Type
export type NativeRecoveryOwner = typeof nativeRecoveryOwnerSchema.Type
export type NativeRecoveryStartPlan = typeof nativeRecoveryStartPlanSchema.Type
export type NativeRecoveryTransport = typeof nativeRecoveryTransportSchema.Type
export type NativeRecoveryTransportPatch = typeof nativeRecoveryTransportPatchSchema.Type
export type NativeRecoveryInput = typeof nativeRecoveryInputSchema.Type
export type NativeRecoveryInputSemantic = typeof nativeRecoveryInputSemanticSchema.Type
export type NativeRecoveryOutput = typeof nativeRecoveryOutputSchema.Type
export type NativeRecoveryInputReceipt = Extract<
  NativeRecoveryOutput,
  { readonly type: 'inputReceipt' }
>
/** Forced broker cleanup is a notice, not proof that the native child exited. */
export function isConfirmedNativeExit(
  frame: NativeRecoveryOutput,
): frame is Extract<NativeRecoveryOutput, { readonly type: 'exit' }> {
  return frame.type === 'exit' && frame.nativeExitConfirmed !== false
}
export type NativeRecoveryEvent = typeof nativeRecoveryEventSchema.Type
export type NativeRecoveryCheckpoint = typeof nativeRecoveryCheckpointSchema.Type
export type NativeRecoveryHistoryAck = typeof nativeRecoveryHistoryAckSchema.Type
export type NativeRecoveryHistoryPrepare = typeof nativeRecoveryHistoryPrepareSchema.Type
export type NativeRecoveryHistoryPreparedOwner =
  typeof nativeRecoveryHistoryPreparedOwnerSchema.Type

export interface NativeRecoveryNumberedInput {
  readonly sequence: number
  readonly frame: NativeRecoveryInput & { readonly sequence: number }
  /** The exact transport line admitted by the write-ahead commit. */
  readonly wire: string
  readonly semantic: NativeRecoveryInputSemantic
}

export interface NativeRecoveryStoredInput extends NativeRecoveryNumberedInput {
  /** Broker acceptance or deduplication coverage; never native delivery or application. */
  readonly acknowledged: boolean
  /** Exact broker receipt for a completed transport side effect; never protocol application. */
  readonly written: boolean
  /** Legacy alias of written; never native semantic consumption. */
  readonly consumed: boolean
  readonly deliveryReceipt?: Omit<NativeRecoveryInputReceipt, 'type' | 'sequence'>
  readonly cancellation?: string
}

export interface NativeRecoveryStoredEvent extends NativeRecoveryEvent {
  readonly revision: number
}

export type NativeRecoveryJournalRecord = (
  | { readonly kind: 'create'; readonly transport: NativeRecoveryTransport }
  | { readonly kind: 'transport'; readonly patch: NativeRecoveryTransportPatch }
  | { readonly kind: 'input'; readonly input: NativeRecoveryNumberedInput }
  | { readonly kind: 'input-ack'; readonly sequence: number }
  | { readonly kind: 'input-cancel'; readonly sequence: number; readonly reason: string }
  | { readonly kind: 'output'; readonly frame: NativeRecoveryOutput }
  | { readonly kind: 'event'; readonly event: NativeRecoveryStoredEvent }
  | { readonly kind: 'checkpoint'; readonly checkpoint: NativeRecoveryCheckpoint }
  | { readonly kind: 'history-prepare'; readonly prepare: NativeRecoveryHistoryPrepare }
  | { readonly kind: 'history-ack'; readonly ack: NativeRecoveryHistoryAck }
) & { readonly revision: number }

export interface NativeRecoverySnapshot {
  readonly transport: NativeRecoveryTransport
  readonly allocatedInputSequence: number
  readonly acknowledgedInputSequence: number
  /** Terminal admission barrier; older unresolved deliveries must never be replayed. */
  readonly closeInputSequence?: number
  readonly outputCursor: number
  readonly eventRevision: number
  readonly inputs: readonly NativeRecoveryStoredInput[]
  readonly outputs: readonly NativeRecoveryOutput[]
  readonly events: readonly NativeRecoveryStoredEvent[]
  readonly checkpoint?: NativeRecoveryCheckpoint
  readonly historyAcks: readonly NativeRecoveryHistoryAck[]
  /** Durable pre-write authority only; preparations never imply history commit. */
  readonly historyPrepares: readonly NativeRecoveryHistoryPrepare[]
  /** Reader-owned ordered prefix of immutable entries; replay owners and inputs with output. */
  readonly records: readonly NativeRecoveryJournalRecord[]
}

export class NativeRecoveryError extends Schema.TaggedError<NativeRecoveryError>()(
  'NativeRecoveryError',
  {
    operation: Schema.String,
    path: Schema.String,
    reason: Schema.Literals([
      'io',
      'invalid',
      'corrupt',
      'unsupported',
      'ownership',
      'uncertain',
      'closed',
    ]),
    message: Schema.String,
    cause: Schema.optionalKey(Schema.Defect()),
  },
) {}
