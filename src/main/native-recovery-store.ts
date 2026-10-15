import { createHash, randomUUID } from 'node:crypto'
import { mkdir, open, readFile, readdir, rename, rm, lstat } from 'node:fs/promises'
import { join } from 'node:path'
import { Cause, Context, Deferred, Effect, Layer, Predicate, Schema, Semaphore } from 'effect'
import type { FileHandle } from 'node:fs/promises'
import type * as Scope from 'effect/Scope'
import {
  NATIVE_RECOVERY_FORMAT,
  NATIVE_RECOVERY_VERSION,
  NativeRecoveryError,
  nativeRecoveryAgentEventSchema,
  nativeRecoveryCheckpointSchema,
  nativeRecoveryEventSchema,
  nativeRecoveryHistoryAckSchema,
  nativeRecoveryHistoryPrepareSchema,
  nativeRecoveryInputSchema,
  nativeRecoveryInputSemanticSchema,
  nativeRecoveryOutputSchema,
  nativeRecoveryStartInputSchema,
  nativeRecoveryTransportPatchSchema,
  nativeRecoveryTransportSchema,
  type NativeRecoveryCheckpoint,
  type NativeRecoveryEvent,
  type NativeRecoveryHistoryAck,
  type NativeRecoveryHistoryPrepare,
  type NativeRecoveryOwner,
  type NativeRecoveryInput,
  type NativeRecoveryInputReceipt,
  type NativeRecoveryInputSemantic,
  type NativeRecoveryJournalRecord,
  type NativeRecoveryNumberedInput,
  type NativeRecoveryOutput,
  type NativeRecoverySnapshot,
  type NativeRecoveryStoredEvent,
  type NativeRecoveryStoredInput,
  type NativeRecoveryTransport,
  type NativeRecoveryTransportPatch,
} from './native-recovery-types'

export interface NativeRecoveryStoreOptions {
  /** An injected private user-data directory; never inferred from HOME. */
  readonly directory: string
  readonly outputBatchDelayMs?: number
  readonly maxOutputBatchBytes?: number
  /** Supplied only after Electron's OS single-instance lock, or an exclusive fixture directory. */
  readonly exclusiveRuntime?: boolean
}

export interface NativeRecoveryStoreHandle {
  createTransport(
    transport: NativeRecoveryTransport,
  ): Effect.Effect<NativeRecoverySnapshot, NativeRecoveryError>
  readTransport(id: string): Effect.Effect<NativeRecoverySnapshot, NativeRecoveryError>
  listTransports(): Effect.Effect<readonly NativeRecoverySnapshot[], NativeRecoveryError>
  updateTransport(
    id: string,
    patch: NativeRecoveryTransportPatch,
  ): Effect.Effect<void, NativeRecoveryError>
  reserveInput(
    id: string,
    frame: NativeRecoveryInput,
    semantic: NativeRecoveryInputSemantic,
  ): Effect.Effect<NativeRecoveryNumberedInput, NativeRecoveryError>
  acknowledgeInput(id: string, sequence: number): Effect.Effect<void, NativeRecoveryError>
  cancelInput(
    id: string,
    sequence: number,
    reason: string,
  ): Effect.Effect<void, NativeRecoveryError>
  reconcileInputHighWater(
    id: string,
    remoteHighWater: number,
  ): Effect.Effect<readonly NativeRecoveryNumberedInput[], NativeRecoveryError>
  /** Calls may run concurrently; each resolves after its ordered batch is synced. */
  appendOutputs(
    id: string,
    frames: readonly NativeRecoveryOutput[],
  ): Effect.Effect<number, NativeRecoveryError>
  appendEvents(
    id: string,
    events: readonly NativeRecoveryEvent[],
  ): Effect.Effect<readonly NativeRecoveryStoredEvent[], NativeRecoveryError>
  checkpoint(
    id: string,
    checkpoint: NativeRecoveryCheckpoint,
  ): Effect.Effect<void, NativeRecoveryError>
  acknowledgeHistory(
    id: string,
    ack: NativeRecoveryHistoryAck,
  ): Effect.Effect<void, NativeRecoveryError>
  /** Commit private authority before the history worker writes the exact hashed file. */
  prepareHistory(
    id: string,
    prepare: NativeRecoveryHistoryPrepare,
  ): Effect.Effect<void, NativeRecoveryError>
  flushEffect(): Effect.Effect<void, NativeRecoveryError>
  closeEffect(): Effect.Effect<void, NativeRecoveryError>
}

type UnnumberedRecord = NativeRecoveryJournalRecord extends infer R
  ? R extends NativeRecoveryJournalRecord
    ? Omit<R, 'revision'>
    : never
  : never

const positive = Schema.Natural.check(Schema.isGreaterThan(0))
const numberedInputSchema = Schema.Struct({
  sequence: positive,
  frame: Schema.JsonObject,
  wire: Schema.String,
  semantic: nativeRecoveryInputSemanticSchema,
})
const journalRecordSchema = Schema.Union([
  Schema.Struct({
    revision: positive,
    kind: Schema.Literal('create'),
    transport: nativeRecoveryTransportSchema,
  }),
  Schema.Struct({
    revision: positive,
    kind: Schema.Literal('transport'),
    patch: nativeRecoveryTransportPatchSchema,
  }),
  Schema.Struct({ revision: positive, kind: Schema.Literal('input'), input: numberedInputSchema }),
  Schema.Struct({ revision: positive, kind: Schema.Literal('input-ack'), sequence: positive }),
  Schema.Struct({
    revision: positive,
    kind: Schema.Literal('input-cancel'),
    sequence: positive,
    reason: Schema.NonEmptyString,
  }),
  Schema.Struct({
    revision: positive,
    kind: Schema.Literal('output'),
    frame: nativeRecoveryOutputSchema,
  }),
  Schema.Struct({
    revision: positive,
    kind: Schema.Literal('event'),
    event: Schema.Struct({ ...nativeRecoveryEventSchema.fields, revision: positive }),
  }),
  Schema.Struct({
    revision: positive,
    kind: Schema.Literal('checkpoint'),
    checkpoint: nativeRecoveryCheckpointSchema,
  }),
  Schema.Struct({
    revision: positive,
    kind: Schema.Literal('history-prepare'),
    prepare: nativeRecoveryHistoryPrepareSchema,
  }),
  Schema.Struct({
    revision: positive,
    kind: Schema.Literal('history-ack'),
    ack: nativeRecoveryHistoryAckSchema,
  }),
])
const batchSchema = Schema.Struct({
  format: Schema.Literal(NATIVE_RECOVERY_FORMAT),
  version: Schema.Literal(NATIVE_RECOVERY_VERSION),
  index: positive,
  previousHash: Schema.Union([Schema.String, Schema.Null]),
  records: Schema.Array(journalRecordSchema),
  hash: Schema.String.check(Schema.isPattern(/^[a-f0-9]{64}$/)),
})
const leaseSchema = Schema.Struct({ pid: positive, token: Schema.NonEmptyString })
const hash = (value: string) => createHash('sha256').update(value).digest('hex')
const journalName = (id: string) => hash(id) + '.jsonl'
const copy = <A>(value: A): A => JSON.parse(JSON.stringify(value)) as A

/** Committed JSON entries never change; keep their chronology without copying its full payload. */
function freezeCommitted(value: unknown): void {
  if (!value || typeof value !== 'object' || Object.isFrozen(value)) return
  for (const child of Object.values(value)) freezeCommitted(child)
  Object.freeze(value)
}
function copySnapshot(snapshot: NativeRecoverySnapshot): NativeRecoverySnapshot {
  const { records, ...current } = snapshot
  const detached = copy(current)
  for (const record of records) freezeCommitted(record)
  // Each reader owns its ordered prefix. Only deeply immutable entries share identity.
  return { ...detached, records: [...records] }
}
const eventIdsByArray = new WeakMap<readonly NativeRecoveryStoredEvent[], Set<string>>()
const ownerScopesByRecords = new WeakMap<readonly NativeRecoveryJournalRecord[], Set<string>>()
const historyClaimsByRecords = new WeakMap<
  readonly NativeRecoveryJournalRecord[],
  Map<string, NativeRecoveryHistoryPrepare>
>()
const inputReceiptHighWaterByRecords = new WeakMap<readonly NativeRecoveryJournalRecord[], number>()
const leaseAdmission = Semaphore.makeUnsafe(1)

function failure(
  operation: string,
  path: string,
  reason: NativeRecoveryError['reason'],
  message: string,
  cause?: unknown,
) {
  return new NativeRecoveryError({
    operation,
    path,
    reason,
    message,
    ...(cause === undefined ? {} : { cause }),
  })
}
const io = <A>(operation: string, path: string, run: () => Promise<A>) =>
  Effect.tryPromise({
    try: run,
    catch: (cause) => failure(operation, path, 'io', 'Recovery storage operation failed.', cause),
  })

/** Inspect descriptors before any schema, getter, toJSON hook, or serialization can run. */
function assertPlainJson(value: unknown, ancestors = new Set<object>()): void {
  if (!Predicate.isObject(value)) return
  if (ancestors.has(value)) throw new Error('Cyclic recovery data')
  const prototype = Object.getPrototypeOf(value)
  if (prototype !== Object.prototype && prototype !== null && prototype !== Array.prototype)
    throw new Error('Recovery data must have plain JSON prototypes')
  ancestors.add(value)
  try {
    for (const key of Reflect.ownKeys(value)) {
      if (typeof key !== 'string') throw new Error('Symbol recovery fields are unsupported')
      const descriptor = Object.getOwnPropertyDescriptor(value, key)!
      if (!('value' in descriptor)) throw new Error('Recovery getters are unsupported')
      if (typeof descriptor.value === 'function')
        throw new Error('Callable recovery fields are unsupported')
      assertPlainJson(descriptor.value, ancestors)
    }
  } finally {
    ancestors.delete(value)
  }
}

const decode = Effect.fnUntraced(function* <A, I>(
  schema: Schema.Codec<A, I>,
  value: unknown,
  operation: string,
  path: string,
  preserve = false,
): Effect.fn.Return<A, NativeRecoveryError> {
  yield* Effect.try({
    try: () => assertPlainJson(value),
    catch: (cause) =>
      failure(operation, path, 'invalid', 'Recovery data is not plain JSON.', cause),
  })
  yield* Schema.decodeUnknownEffect(Schema.Json)(value).pipe(
    Effect.mapError((cause) =>
      failure(operation, path, 'invalid', 'Recovery data is not JSON.', cause),
    ),
  )
  const plain = copy(value)
  const decoded = yield* Schema.decodeUnknownEffect(schema, {
    onExcessProperty: preserve ? 'ignore' : 'error',
  })(plain).pipe(
    Effect.mapError((cause) =>
      failure(operation, path, 'invalid', 'Recovery descriptor validation failed.', cause),
    ),
  )
  return preserve ? (plain as A) : decoded
})

interface PendingCommit {
  readonly records: readonly UnnumberedRecord[]
  readonly bytes: number
  readonly done: Deferred.Deferred<void, NativeRecoveryError>
}
interface Journal {
  readonly path: string
  snapshot: NativeRecoverySnapshot
  index: number
  previousHash: string | null
  bytes: number
  pending: PendingCommit[]
  stagedCursor: number
  stagedEventRevision: number
  eventIndex: Map<string, NativeRecoveryStoredEvent>
  stagedEventIndex: Map<string, NativeRecoveryStoredEvent>
  stagedInputReceipts: Map<number, NonNullable<NativeRecoveryStoredInput['deliveryReceipt']>>
  pendingBytes: number
  flushing: boolean
  poisoned?: NativeRecoveryError
}

function emptySnapshot(transport: NativeRecoveryTransport): NativeRecoverySnapshot {
  return {
    transport,
    allocatedInputSequence: 0,
    acknowledgedInputSequence: 0,
    outputCursor: 0,
    eventRevision: 0,
    inputs: [],
    outputs: [],
    events: [],
    historyAcks: [],
    historyPrepares: [],
    records: [],
  }
}

const privateOwnerKey = (owner: {
  sessionId: string
  snapshotToken?: string
  ownerGeneration?: number
}) => JSON.stringify([owner.sessionId, owner.snapshotToken, owner.ownerGeneration])
const historyAckLocation = (ack: NativeRecoveryHistoryAck) => {
  if (ack.durability === 'native')
    return ack.consumerId === `main:${ack.sessionId}` ? 'native-file' : undefined
  if (ack.consumerId === `studio:${ack.sessionId}`) return 'studio-cache'
  if (ack.consumerId === `main-cache:${ack.sessionId}`) return 'main-cache'
  return undefined
}
const historyAckFamily = (state: NativeRecoverySnapshot, ack: NativeRecoveryHistoryAck) =>
  matchingHistoryPrepare(state, ack)
    ? `${ack.durability}:${historyAckLocation(ack)}`
    : `legacy:${ack.durability}`
const sameHistoryOwner = (
  state: NativeRecoverySnapshot,
  a: NativeRecoveryHistoryAck,
  b: NativeRecoveryHistoryAck,
) =>
  a.consumerId === b.consumerId &&
  privateOwnerKey(a) === privateOwnerKey(b) &&
  historyAckFamily(state, a) === historyAckFamily(state, b)
const preparedClaimKey = (
  snapshotId: string,
  fileHash: string,
  location: string,
  owner: {
    consumerId: string
    sessionId: string
    snapshotToken?: string
    ownerGeneration?: number
    throughEventRevision: number
    absent?: true
  },
) =>
  JSON.stringify([
    snapshotId,
    fileHash,
    location,
    owner.consumerId,
    privateOwnerKey(owner),
    owner.throughEventRevision,
    owner.absent === true,
  ])

function rememberHistoryPrepare(
  state: NativeRecoverySnapshot,
  prepare: NativeRecoveryHistoryPrepare,
) {
  let claims = historyClaimsByRecords.get(state.records)
  if (!claims) {
    claims = new Map()
    historyClaimsByRecords.set(state.records, claims)
  }
  for (const owner of prepare.owners)
    claims.set(
      preparedClaimKey(
        prepare.snapshotId,
        prepare.fileHash,
        prepare.location ?? 'native-file',
        owner,
      ),
      prepare,
    )
}

function rememberOwnerScopes(
  state: NativeRecoverySnapshot,
  owners: readonly NativeRecoveryOwner[],
) {
  let scopes = ownerScopesByRecords.get(state.records)
  if (!scopes) {
    scopes = new Set()
    ownerScopesByRecords.set(state.records, scopes)
  }
  for (const owner of owners)
    if (owner.snapshotToken !== undefined)
      scopes.add(
        privateOwnerKey({
          sessionId: owner.sessionId,
          snapshotToken: owner.snapshotToken,
          ownerGeneration: owner.generation ?? 0,
        }),
      )
}

const validateHistoryPrepare = Effect.fnUntraced(function* (
  state: NativeRecoverySnapshot,
  prepare: NativeRecoveryHistoryPrepare,
  path: string,
) {
  const keys = new Set<string>()
  const scopes = ownerScopesByRecords.get(state.records)
  for (const owner of prepare.owners) {
    if (
      owner.absent === true &&
      (prepare.location !== 'main-cache' || owner.consumerId !== `main-cache:${owner.sessionId}`)
    )
      return yield* failure(
        'history-prepare',
        path,
        'uncertain',
        'History absence proof is restricted to its exact main-cache consumer.',
      )
    const key = JSON.stringify([owner.consumerId, privateOwnerKey(owner)])
    if (keys.has(key))
      return yield* failure(
        'history-prepare',
        path,
        'uncertain',
        'History preparation repeats a private owner claim.',
      )
    keys.add(key)
    if (owner.throughEventRevision > state.eventRevision || !scopes?.has(privateOwnerKey(owner)))
      return yield* failure(
        'history-prepare',
        path,
        'uncertain',
        'History preparation has no matching private owner or committed event revision.',
      )
    if (
      owner.authority === 'private-ack' &&
      !state.historyAcks.some(
        (ack) =>
          ack.consumerId === owner.consumerId &&
          privateOwnerKey(ack) === privateOwnerKey(owner) &&
          ack.throughEventRevision >= owner.throughEventRevision &&
          matchingHistoryPrepare(state, ack) !== undefined,
      )
    )
      return yield* failure(
        'history-prepare',
        path,
        'uncertain',
        'History preparation has no matching prior private commit acknowledgment.',
      )
  }
})

function matchingHistoryPrepare(state: NativeRecoverySnapshot, ack: NativeRecoveryHistoryAck) {
  const location = historyAckLocation(ack)
  if (location === undefined || ack.fileHash === undefined) return
  return historyClaimsByRecords
    .get(state.records)
    ?.get(preparedClaimKey(ack.snapshotId, ack.fileHash, location, ack))
}

const sameHistoryPreparation = (a: NativeRecoveryHistoryPrepare, b: NativeRecoveryHistoryPrepare) =>
  a.snapshotId === b.snapshotId &&
  a.fileHash === b.fileHash &&
  (a.location ?? 'native-file') === (b.location ?? 'native-file') &&
  a.savedAt === b.savedAt &&
  JSON.stringify(a.owners.map(({ authority: _authority, ...owner }) => owner)) ===
    JSON.stringify(b.owners.map(({ authority: _authority, ...owner }) => owner))

const validateInputReceipt = Effect.fnUntraced(function* (
  state: NativeRecoverySnapshot,
  receipt: NativeRecoveryInputReceipt,
  prior: NativeRecoveryStoredInput['deliveryReceipt'],
  path: string,
) {
  if (state.transport.inputReceipts !== 1)
    return yield* failure(
      'input-receipt',
      path,
      'unsupported',
      'Recovery input receipt has no negotiated broker capability.',
    )
  if (state.inputs[receipt.sequence - 1]?.sequence !== receipt.sequence)
    return yield* failure(
      'input-receipt',
      path,
      'uncertain',
      'Recovery input receipt has no exact original authorized sequence.',
    )
  if (prior && (receipt.cursor !== prior.cursor || receipt.status !== prior.status))
    return yield* failure(
      'input-receipt',
      path,
      'uncertain',
      'Recovery input receipt contradicts the original final broker receipt.',
    )
})

const applyRecord = Effect.fnUntraced(function* (
  state: NativeRecoverySnapshot | undefined,
  record: NativeRecoveryJournalRecord,
  path: string,
): Effect.fn.Return<NativeRecoverySnapshot, NativeRecoveryError> {
  const reject = (message: string) => failure('replay', path, 'corrupt', message)
  if (record.revision !== (state?.records.length ?? 0) + 1)
    return yield* reject('Recovery record revisions have a gap.')
  if (!state) {
    if (record.kind !== 'create')
      return yield* reject('Recovery journal has no creation descriptor.')
    state = emptySnapshot(record.transport)
  } else if (record.kind === 'create')
    return yield* reject('Recovery journal repeats its creation descriptor.')
  let next = state
  switch (record.kind) {
    case 'create':
      yield* validateOwners(record.transport, path)
      rememberOwnerScopes(state, record.transport.owners)
      break
    case 'transport':
      next = { ...state, transport: { ...state.transport, ...record.patch } }
      yield* validateOwners(next.transport, path)
      if (record.patch.owners) rememberOwnerScopes(state, record.patch.owners)
      break
    case 'input': {
      const input = record.input
      if (
        input.sequence !== state.allocatedInputSequence + 1 ||
        input.frame.sequence !== input.sequence ||
        input.wire !== JSON.stringify(input.frame) + '\n'
      )
        return yield* reject('Recovery input numbering or exact wire is inconsistent.')
      const { sequence: _sequence, ...frame } = input.frame
      yield* decode(nativeRecoveryInputSchema, frame, 'replay-input', path).pipe(
        Effect.mapError(() => reject('Recovery input frame is invalid.')),
      )
      if (state.closeInputSequence !== undefined)
        return yield* reject('Recovery input was admitted after a terminal close barrier.')
      ;(state.inputs as NativeRecoveryStoredInput[]).push({
        ...input,
        acknowledged: false,
        written: false,
        consumed: false,
      })
      next = {
        ...state,
        allocatedInputSequence: input.sequence,
        ...(input.frame.type === 'close' ? { closeInputSequence: input.sequence } : {}),
      }
      break
    }
    case 'input-ack': {
      if (
        record.sequence > state.allocatedInputSequence ||
        record.sequence < state.acknowledgedInputSequence
      )
        return yield* reject('Recovery input acknowledgment is inconsistent.')
      next = {
        ...state,
        acknowledgedInputSequence: record.sequence,
        inputs: state.inputs.map((input) =>
          input.sequence <= record.sequence
            ? {
                ...input,
                acknowledged: true,
              }
            : input,
        ),
      }
      break
    }
    case 'input-cancel': {
      const input = state.inputs.find((input) => input.sequence === record.sequence)
      if (!input || input.acknowledged)
        return yield* reject('Recovery cancellation does not identify unresolved input.')
      next = {
        ...state,
        inputs: state.inputs.map((input) =>
          input.sequence === record.sequence ? { ...input, cancellation: record.reason } : input,
        ),
      }
      break
    }
    case 'output': {
      if (record.frame.cursor !== state.outputCursor + 1)
        return yield* reject('Recovery output journal has a missing frame.')
      if (record.frame.type === 'inputReceipt') {
        const receipt = record.frame
        const input = state.inputs[receipt.sequence - 1]
        yield* validateInputReceipt(state, receipt, input?.deliveryReceipt, path).pipe(
          Effect.mapError(() =>
            reject('Recovery input receipt has no qualified consistent evidence.'),
          ),
        )
        const { type: _type, sequence: _sequence, ...deliveryReceipt } = receipt
        const written = input.written || receipt.status === 'written'
        ;(state.inputs as NativeRecoveryStoredInput[])[receipt.sequence - 1] = {
          ...input,
          written,
          consumed: written,
          deliveryReceipt,
        }
        inputReceiptHighWaterByRecords.set(
          state.records,
          Math.max(inputReceiptHighWaterByRecords.get(state.records) ?? 0, receipt.sequence),
        )
      }
      ;(state.outputs as NativeRecoveryOutput[]).push(record.frame)
      next = { ...state, outputCursor: record.frame.cursor }
      break
    }
    case 'event': {
      let eventIds = eventIdsByArray.get(state.events)
      if (!eventIds) {
        eventIds = new Set(state.events.map((event) => event.eventId))
        eventIdsByArray.set(state.events, eventIds)
      }
      if (
        record.event.revision !== state.eventRevision + 1 ||
        record.event.outputCursor > state.outputCursor ||
        eventIds.has(record.event.eventId)
      )
        return yield* reject(
          'Recovery event revisions, identity, or output watermark are inconsistent.',
        )
      yield* decode(
        nativeRecoveryAgentEventSchema,
        record.event.event,
        'replay-event',
        path,
        true,
      ).pipe(Effect.mapError(() => reject('Recovery native event is invalid.')))
      eventIds.add(record.event.eventId)
      ;(state.events as NativeRecoveryStoredEvent[]).push(record.event)
      next = { ...state, eventRevision: record.event.revision }
      break
    }
    case 'checkpoint':
      if (
        record.checkpoint.throughOutputCursor > state.outputCursor ||
        record.checkpoint.throughEventRevision > state.eventRevision
      )
        return yield* reject('Recovery checkpoint advances beyond committed data.')
      next = { ...state, checkpoint: record.checkpoint }
      break
    case 'history-prepare': {
      yield* validateHistoryPrepare(state, record.prepare, path).pipe(
        Effect.mapError(() =>
          reject('Recovery history preparation has no admitted private authority.'),
        ),
      )
      if (state.historyPrepares.some((prepare) => prepare.snapshotId === record.prepare.snapshotId))
        return yield* reject('Recovery journal repeats a history preparation identity.')
      ;(state.historyPrepares as NativeRecoveryHistoryPrepare[]).push(record.prepare)
      rememberHistoryPrepare(state, record.prepare)
      break
    }
    case 'history-ack': {
      // Legacy unprepared ACKs remain archival data. Every hash-bearing native
      // ACK must bind an exact pre-write authority record from this chronology.
      if (
        record.ack.durability === 'native' &&
        record.ack.fileHash !== undefined &&
        !matchingHistoryPrepare(state, record.ack)
      )
        return yield* reject(
          'Recovery native history acknowledgment has no exact preceding preparation.',
        )
      const prior = state.historyAcks.find((ack) => sameHistoryOwner(state, ack, record.ack))
      if (
        record.ack.throughEventRevision > state.eventRevision ||
        (prior && record.ack.throughEventRevision < prior.throughEventRevision)
      )
        return yield* reject(
          'Recovery history acknowledgment advances beyond its data or moves backward.',
        )
      next = {
        ...state,
        historyAcks: [
          ...state.historyAcks.filter((ack) => !sameHistoryOwner(state, ack, record.ack)),
          record.ack,
        ],
      }
      break
    }
  }
  ;(state.records as NativeRecoveryJournalRecord[]).push(record)
  return next
})

const validateOwners = Effect.fnUntraced(function* (
  transport: NativeRecoveryTransport,
  path: string,
) {
  const ids = new Set<string>()
  for (const owner of transport.owners) {
    if (ids.has(owner.ownerId))
      return yield* failure('owners', path, 'invalid', 'Recovery owner IDs must be unique.')
    ids.add(owner.ownerId)
    const input = yield* decode(
      nativeRecoveryStartInputSchema,
      owner.input,
      'owner-input',
      path,
      true,
    )
    if (
      input.sessionId !== owner.sessionId ||
      input.provider !== transport.provider ||
      (owner.nativeStartPlan !== undefined &&
        owner.nativeStartPlan.provider !== transport.provider) ||
      (input.workspace !== undefined && input.workspace !== owner.workspace)
    )
      return yield* failure(
        'owners',
        path,
        'ownership',
        'Recovery owner and exact start input disagree.',
      )
    if (owner.nativeStartPlan?.provider === 'claude') {
      yield* decode(
        Schema.Struct({ subtype: Schema.Literal('initialize') }),
        owner.nativeStartPlan.initialize,
        'native-start-initialize',
        path,
        true,
      )
      yield* decode(
        Schema.Struct({
          type: Schema.Literal('user'),
          session_id: Schema.String,
          message: Schema.Struct({ role: Schema.Literal('user'), content: Schema.Json }),
        }),
        owner.nativeStartPlan.user,
        'native-start-user',
        path,
        true,
      )
    }
    if (owner.kind === 'child' && !owner.parentSessionId)
      return yield* failure(
        'owners',
        path,
        'ownership',
        'Recovery child has no parent session identity.',
      )
  }
})

const withFile = <A>(
  path: string,
  flags: string,
  use: (file: FileHandle) => Effect.Effect<A, NativeRecoveryError>,
) =>
  Effect.scoped(
    Effect.gen(function* () {
      const file = yield* Effect.acquireRelease(
        io('open', path, () => open(path, flags, 0o600)),
        (file) => io('close-file', path, () => file.close()).pipe(Effect.orDie),
      )
      return yield* use(file)
    }),
  ).pipe(
    Effect.catchCause((cause) => {
      if (Cause.hasInterruptsOnly(cause)) return Effect.failCause(cause)
      const error = Cause.squash(cause)
      return Effect.fail(
        error instanceof NativeRecoveryError
          ? error
          : failure('file-resource', path, 'io', 'Recovery file resource operation failed.', error),
      )
    }),
  )

const syncDirectory = (path: string) =>
  withFile(path, 'r', (file) => io('sync-directory', path, () => file.sync()))

const acquireLease = Effect.fnUntraced(
  function* (directory: string, exclusiveRuntime: boolean) {
    yield* io('mkdir', directory, () => mkdir(directory, { recursive: true, mode: 0o700 }))
    const lock = join(directory, '.writer.lock')
    const token = randomUUID()
    for (;;) {
      const acquired = yield* io('lease', lock, () => mkdir(lock, { mode: 0o700 })).pipe(
        Effect.map(() => true),
        Effect.catch((error) =>
          Predicate.isObject(error.cause) && error.cause.code === 'EEXIST'
            ? Effect.succeed(false)
            : Effect.fail(error),
        ),
      )
      if (acquired) {
        const ownerPath = join(lock, 'owner.json')
        yield* Effect.gen(function* () {
          yield* withFile(ownerPath, 'wx', (file) =>
            io('write-lease', ownerPath, () =>
              file.writeFile(JSON.stringify({ pid: process.pid, token }), 'utf8'),
            ).pipe(Effect.andThen(io('sync-lease', ownerPath, () => file.sync()))),
          )
          yield* syncDirectory(lock)
          yield* syncDirectory(directory)
        }).pipe(
          Effect.onError(() =>
            io('cleanup-lease', lock, () => rm(lock, { recursive: true, force: true })).pipe(
              Effect.ignore,
            ),
          ),
        )
        return { lock, token, released: false }
      }
      const ownerPath = join(lock, 'owner.json')
      const text = yield* io('read-lease', ownerPath, () => readFile(ownerPath, 'utf8')).pipe(
        Effect.mapError((cause) =>
          failure(
            'lease',
            lock,
            'ownership',
            'Recovery storage is already owned; its lease cannot be verified.',
            cause,
          ),
        ),
      )
      const owner = yield* Effect.try({
        try: () => JSON.parse(text) as unknown,
        catch: (cause) =>
          failure('lease', lock, 'ownership', 'Recovery storage lease is malformed.', cause),
      }).pipe(Effect.flatMap((value) => decode(leaseSchema, value, 'lease', lock)))
      const alive = yield* Effect.try({
        try: () => {
          try {
            process.kill(owner.pid, 0)
            return true
          } catch (cause) {
            if (Predicate.isObject(cause) && cause.code === 'ESRCH') return false
            throw cause
          }
        },
        catch: (cause) =>
          failure(
            'lease',
            lock,
            'ownership',
            'Recovery storage owner liveness cannot be verified.',
            cause,
          ),
      })
      if (alive)
        return yield* failure(
          'lease',
          lock,
          'ownership',
          'Recovery storage is owned by another live store.',
        )
      if (!exclusiveRuntime)
        return yield* failure(
          'lease',
          lock,
          'ownership',
          'Stale recovery lease requires verified exclusive application ownership.',
        )
      const stale = lock + '.stale.' + token
      yield* io('reclaim-lease', lock, () => rename(lock, stale))
      const preserveMovedLease = io('reserve-lease-restoration', lock, () =>
        mkdir(lock, { mode: 0o700 }),
      ).pipe(
        Effect.andThen(io('restore-foreign-lease', stale, () => rename(stale, lock))),
        // A failed rename retains the empty reserved primary directory, which
        // blocks subsequent writers while the unverifiable bytes remain intact.
        Effect.ignore,
      )
      const capturedPath = join(stale, 'owner.json')
      const captured = yield* io('verify-reclaimed-lease', capturedPath, () =>
        readFile(capturedPath, 'utf8'),
      ).pipe(
        Effect.flatMap((text) =>
          Effect.try({
            try: () => JSON.parse(text) as unknown,
            catch: (cause) =>
              failure(
                'lease',
                stale,
                'ownership',
                'Reclaimed recovery lease cannot be verified; it was preserved.',
                cause,
              ),
          }),
        ),
        Effect.flatMap((value) => decode(leaseSchema, value, 'reclaim-lease', capturedPath)),
        Effect.catch((cause) =>
          Effect.gen(function* () {
            yield* preserveMovedLease
            return yield* failure(
              'lease',
              lock,
              'ownership',
              'Reclaimed recovery lease cannot be verified; its bytes and admission barrier were preserved.',
              cause,
            )
          }),
        ),
      )
      if (captured.pid !== owner.pid || captured.token !== owner.token) {
        // Reserve an empty destination before restoring the moved foreign
        // lease. A concurrent owner can never be replaced during restoration.
        yield* preserveMovedLease
        return yield* failure(
          'lease',
          lock,
          'ownership',
          'Recovery lease changed during reclamation; the foreign owner was preserved.',
        )
      }
      yield* io('remove-stale-lease', stale, () => rm(stale, { recursive: true, force: true }))
    }
  },
  Effect.uninterruptible,
  leaseAdmission.withPermit,
)

const verifyLease = Effect.fnUntraced(function* (
  lease: {
    lock: string
    token: string
    released: boolean
  },
  operation: string,
) {
  if (lease.released)
    return yield* failure(
      operation,
      lease.lock,
      'ownership',
      'Recovery storage lease has been released.',
    )
  const ownerPath = join(lease.lock, 'owner.json')
  const owner = yield* io('read-own-lease', ownerPath, () => readFile(ownerPath, 'utf8')).pipe(
    Effect.mapError((cause) =>
      failure(
        operation,
        ownerPath,
        'ownership',
        'Recovery storage lease cannot be verified.',
        cause,
      ),
    ),
    Effect.flatMap((text) =>
      Effect.try({
        try: () => JSON.parse(text) as unknown,
        catch: (cause) =>
          failure(operation, ownerPath, 'ownership', 'Recovery storage lease is malformed.', cause),
      }),
    ),
    Effect.flatMap((owner) =>
      decode(leaseSchema, owner, operation, ownerPath).pipe(
        Effect.mapError((cause) =>
          failure(
            operation,
            ownerPath,
            'ownership',
            'Recovery storage lease descriptor is invalid.',
            cause,
          ),
        ),
      ),
    ),
  )
  if (owner.token !== lease.token || owner.pid !== process.pid)
    return yield* failure(
      operation,
      lease.lock,
      'ownership',
      'Recovery storage is no longer owned by this store.',
    )
})

const releaseLease = Effect.fnUntraced(function* (lease: {
  lock: string
  token: string
  released: boolean
}) {
  if (lease.released) return
  yield* verifyLease(lease, 'close')
  yield* io('release-lease', lease.lock, () => rm(lease.lock, { recursive: true }))
  lease.released = true
}, Effect.uninterruptible)

export class NativeRecoveryStore extends Context.Service<
  NativeRecoveryStore,
  NativeRecoveryStoreHandle
>()('life/main/NativeRecoveryStore') {
  static readonly make = Effect.fn('NativeRecoveryStore.make')(function* (
    options: NativeRecoveryStoreOptions,
  ): Effect.fn.Return<NativeRecoveryStoreHandle, NativeRecoveryError, Scope.Scope> {
    const scope = yield* Effect.scope
    const semaphore = yield* Semaphore.make(1)
    const lease = yield* Effect.acquireRelease(
      acquireLease(options.directory, options.exclusiveRuntime === true),
      (lease) => releaseLease(lease).pipe(Effect.ignore),
    )
    const journals = new Map<string, Journal>()
    const outputAdmissionTails = new Map<string, Deferred.Deferred<void>>()
    const delay = Math.max(0, options.outputBatchDelayMs ?? 20)
    const maximumBytes = Math.max(1, options.maxOutputBatchBytes ?? 256 * 1024)
    let closed = false

    const assertOpen = () =>
      closed
        ? Effect.fail(failure('store', options.directory, 'closed', 'Recovery store is closed.'))
        : Effect.void
    const readJournal = Effect.fnUntraced(function* (
      path: string,
      expectedId?: string,
    ): Effect.fn.Return<Journal, NativeRecoveryError> {
      const stat = yield* io('stat-journal', path, () => lstat(path))
      if (!stat.isFile() || stat.isSymbolicLink())
        return yield* failure(
          'read',
          path,
          'ownership',
          'Recovery journal must be a regular private file.',
        )
      const text = yield* io('read-journal', path, () => readFile(path, 'utf8'))
      if (!text || !text.endsWith('\n'))
        return yield* failure(
          'read',
          path,
          'corrupt',
          'Recovery journal has an incomplete committed batch; original bytes were retained.',
        )
      let state: NativeRecoverySnapshot | undefined
      let index = 0
      let previousHash: string | null = null
      for (const line of text.slice(0, -1).split('\n')) {
        const raw = yield* Effect.try({
          try: () => JSON.parse(line) as unknown,
          catch: (cause) =>
            failure(
              'read',
              path,
              'corrupt',
              'Recovery journal contains malformed JSON; original bytes were retained.',
              cause,
            ),
        })
        if (Predicate.isObject(raw) && 'version' in raw && raw.version !== NATIVE_RECOVERY_VERSION)
          return yield* failure(
            'read',
            path,
            'unsupported',
            'Recovery journal version is unsupported; original bytes were retained.',
          )
        const batch = yield* decode(batchSchema, raw, 'read-batch', path).pipe(
          Effect.mapError((cause) =>
            failure(
              'read',
              path,
              'corrupt',
              'Recovery journal batch is invalid; original bytes were retained.',
              cause,
            ),
          ),
        )
        // Struct validation reconstructs keys in schema order. Hash the admitted
        // original JSON payload, whose field order is part of this format.
        const { hash: _hash, ...payload } = raw as Record<string, Schema.Json>
        const checksum = batch.hash
        if (
          batch.index !== index + 1 ||
          batch.previousHash !== previousHash ||
          checksum !== hash(JSON.stringify(payload)) ||
          batch.records.length === 0
        )
          return yield* failure(
            'read',
            path,
            'corrupt',
            'Recovery journal checksum or ordering is inconsistent; original bytes were retained.',
          )
        for (const record of batch.records)
          state = yield* applyRecord(state, record as NativeRecoveryJournalRecord, path)
        index = batch.index
        previousHash = checksum
      }
      if (
        !state ||
        (expectedId !== undefined && state.transport.id !== expectedId) ||
        journalName(state.transport.id) !== path.slice(path.lastIndexOf('/') + 1)
      )
        return yield* failure(
          'read',
          path,
          'ownership',
          'Recovery journal transport identity does not match its private path.',
        )
      yield* validateOwners(state.transport, path)
      const eventIndex = new Map(state.events.map((event) => [event.eventId, event]))
      return {
        path,
        snapshot: state,
        index,
        previousHash,
        bytes: Buffer.byteLength(text),
        pending: [],
        stagedCursor: state.outputCursor,
        stagedEventRevision: state.eventRevision,
        eventIndex,
        stagedEventIndex: new Map(eventIndex),
        stagedInputReceipts: new Map(
          state.inputs.flatMap((input) =>
            input.deliveryReceipt ? [[input.sequence, input.deliveryReceipt] as const] : [],
          ),
        ),
        pendingBytes: 0,
        flushing: false,
      }
    })
    const get = Effect.fnUntraced(function* (id: string) {
      yield* assertOpen()
      yield* decode(Schema.NonEmptyString, id, 'transport-id', options.directory)
      const known = journals.get(id)
      if (known) {
        if (known.poisoned) return yield* known.poisoned
        return known
      }
      const journal = yield* readJournal(join(options.directory, journalName(id)), id)
      journals.set(id, journal)
      return journal
    })

    const commit = Effect.fnUntraced(function* (
      journal: Journal,
      incoming: readonly UnnumberedRecord[],
      exclusive = false,
    ): Effect.fn.Return<void, NativeRecoveryError> {
      if (journal.poisoned) return yield* journal.poisoned
      const pending = journal.pending
      const all = [...pending.flatMap((item) => item.records), ...incoming]
      if (all.length === 0) return
      const records: NativeRecoveryJournalRecord[] = []
      for (const value of all)
        records.push({
          ...value,
          revision: journal.snapshot.records.length + records.length + 1,
        } as NativeRecoveryJournalRecord)
      const payload = {
        format: NATIVE_RECOVERY_FORMAT,
        version: NATIVE_RECOVERY_VERSION,
        index: journal.index + 1,
        previousHash: journal.previousHash,
        records,
      }
      const checksum = hash(JSON.stringify(payload))
      const serialized = JSON.stringify({ ...payload, hash: checksum }) + '\n'
      const write = verifyLease(lease, 'write').pipe(
        Effect.andThen(
          withFile(journal.path, exclusive ? 'wx' : 'r+', (file) =>
            Effect.gen(function* () {
              const stat = yield* io('stat-before-write', journal.path, () => file.stat())
              if (stat.size !== journal.bytes)
                return yield* failure(
                  'write',
                  journal.path,
                  'ownership',
                  'Recovery journal changed outside its admitted writer.',
                )
              const bytes = Buffer.from(serialized, 'utf8')
              let offset = 0
              while (offset < bytes.length) {
                const written = yield* io('write-journal', journal.path, () =>
                  file.write(bytes, offset, bytes.length - offset, journal.bytes + offset),
                )
                if (written.bytesWritten === 0)
                  return yield* failure(
                    'write',
                    journal.path,
                    'io',
                    'Recovery journal write made no progress.',
                  )
                offset += written.bytesWritten
              }
              yield* io('sync-journal', journal.path, () => file.sync())
            }),
          ),
        ),
        Effect.andThen(exclusive ? syncDirectory(options.directory) : Effect.void),
      )
      yield* write.pipe(
        Effect.catch((error) =>
          Effect.gen(function* () {
            journal.poisoned = error
            journal.pending = []
            journal.pendingBytes = 0
            for (const item of pending) yield* Deferred.fail(item.done, error)
            return yield* error
          }),
        ),
      )
      let state: NativeRecoverySnapshot | undefined = exclusive ? undefined : journal.snapshot
      for (const record of records)
        state = yield* applyRecord(state, record, journal.path).pipe(
          Effect.catch((error) =>
            Effect.gen(function* () {
              journal.poisoned = error
              for (const item of pending) yield* Deferred.fail(item.done, error)
              return yield* error
            }),
          ),
        )
      journal.snapshot = state!
      journal.index++
      journal.previousHash = checksum
      journal.bytes += Buffer.byteLength(serialized)
      journal.pending = []
      journal.pendingBytes = 0
      journal.stagedCursor = state!.outputCursor
      journal.stagedEventRevision = state!.eventRevision
      for (const record of records)
        if (record.kind === 'event') journal.eventIndex.set(record.event.eventId, record.event)
      for (const item of pending) yield* Deferred.succeed(item.done, undefined)
    }, Effect.uninterruptible)

    const locked = <A>(effect: Effect.Effect<A, NativeRecoveryError>) =>
      semaphore.withPermits(1)(effect)
    const admitOutputs = <A>(id: string, effect: Effect.Effect<A, NativeRecoveryError>) =>
      Effect.suspend(() => {
        const previous = outputAdmissionTails.get(id)
        const admitted = Deferred.makeUnsafe<void>()
        outputAdmissionTails.set(id, admitted)
        // Semaphore wakeups are scheduled after freeing the permit. Reserve
        // each wire-order slot before waiting so a later fiber cannot barge.
        return (previous ? Deferred.await(previous) : Effect.void).pipe(
          Effect.andThen(locked(effect)),
          Effect.ensuring(
            Effect.sync(() => {
              if (outputAdmissionTails.get(id) === admitted) outputAdmissionTails.delete(id)
              Deferred.doneUnsafe(admitted, Effect.void)
            }),
          ),
        )
      }).pipe(Effect.uninterruptible)
    const enqueue = Effect.fnUntraced(function* (
      journal: Journal,
      records: readonly UnnumberedRecord[],
      done: Deferred.Deferred<void, NativeRecoveryError>,
    ) {
      if (records.length === 0 && journal.pending.length === 0) {
        yield* Deferred.succeed(done, undefined)
        return
      }
      const bytes = Buffer.byteLength(JSON.stringify(records))
      journal.pending.push({ records, bytes, done })
      journal.pendingBytes += bytes
      if (journal.pendingBytes >= maximumBytes) {
        yield* commit(journal, [])
        return
      }
      if (!journal.flushing) {
        journal.flushing = true
        yield* Effect.sleep(delay).pipe(
          Effect.andThen(
            locked(
              Effect.gen(function* () {
                journal.flushing = false
                if (!closed) yield* commit(journal, [])
              }),
            ),
          ),
          Effect.catch((error) =>
            Effect.sync(() => {
              journal.poisoned = error
            }),
          ),
          Effect.forkIn(scope),
        )
      }
    })
    const mutation = <A>(
      id: string,
      operation: (journal: Journal) => Effect.Effect<A, NativeRecoveryError>,
    ) =>
      locked(
        Effect.gen(function* () {
          const journal = yield* get(id)
          yield* commit(journal, [])
          return yield* operation(journal)
        }),
      ).pipe(Effect.uninterruptible)

    const closeEffect = Effect.fnUntraced(function* () {
      yield* locked(
        Effect.gen(function* () {
          if (closed) return
          closed = true
          const failures: NativeRecoveryError[] = []
          for (const journal of journals.values())
            yield* commit(journal, []).pipe(
              Effect.catch((error) =>
                Effect.sync(() => {
                  failures.push(error)
                }),
              ),
            )
          yield* releaseLease(lease)
          if (failures.length) return yield* failures[0]
        }),
      )
    }, Effect.uninterruptible)
    yield* Effect.addFinalizer(() => closeEffect().pipe(Effect.ignore))

    return NativeRecoveryStore.of({
      createTransport: Effect.fn('NativeRecoveryStore.createTransport')(function* (value) {
        return yield* locked(
          Effect.gen(function* () {
            yield* assertOpen()
            const transport = yield* decode(
              nativeRecoveryTransportSchema,
              value,
              'create',
              options.directory,
            )
            yield* validateOwners(transport, options.directory)
            const path = join(options.directory, journalName(transport.id))
            if (journals.has(transport.id))
              return yield* failure(
                'create',
                path,
                'ownership',
                'Recovery transport already exists.',
              )
            const journal: Journal = {
              path,
              snapshot: emptySnapshot(transport),
              index: 0,
              previousHash: null,
              bytes: 0,
              pending: [],
              stagedCursor: 0,
              stagedEventRevision: 0,
              eventIndex: new Map(),
              stagedEventIndex: new Map(),
              stagedInputReceipts: new Map(),
              pendingBytes: 0,
              flushing: false,
            }
            yield* commit(journal, [{ kind: 'create', transport }], true)
            journals.set(transport.id, journal)
            return copySnapshot(journal.snapshot)
          }),
        ).pipe(Effect.uninterruptible)
      }),
      readTransport: Effect.fn('NativeRecoveryStore.readTransport')((id) =>
        mutation(id, (journal) => Effect.sync(() => copySnapshot(journal.snapshot))),
      ),
      listTransports: Effect.fn('NativeRecoveryStore.listTransports')(function* () {
        return yield* locked(
          Effect.gen(function* () {
            yield* assertOpen()
            const files = yield* io('list', options.directory, () => readdir(options.directory))
            const result: NativeRecoverySnapshot[] = []
            for (const name of files.filter((name) => /^[a-f0-9]{64}\.jsonl$/.test(name)).sort()) {
              const path = join(options.directory, name)
              const cached = Array.from(journals.values()).find((journal) => journal.path === path)
              const journal = cached ?? (yield* readJournal(path))
              if (journal.poisoned) return yield* journal.poisoned
              yield* commit(journal, [])
              journals.set(journal.snapshot.transport.id, journal)
              result.push(copySnapshot(journal.snapshot))
            }
            return result
          }),
        )
      }),
      updateTransport: Effect.fn('NativeRecoveryStore.updateTransport')((id, value) =>
        mutation(id, (journal) =>
          Effect.gen(function* () {
            const patch = yield* decode(
              nativeRecoveryTransportPatchSchema,
              value,
              'update',
              journal.path,
            )
            yield* validateOwners({ ...journal.snapshot.transport, ...patch }, journal.path)
            yield* commit(journal, [{ kind: 'transport', patch }])
          }),
        ),
      ),
      reserveInput: Effect.fn('NativeRecoveryStore.reserveInput')((id, value, owner) =>
        mutation(id, (journal) =>
          Effect.gen(function* () {
            const frame = yield* decode(nativeRecoveryInputSchema, value, 'input', journal.path)
            if (Object.hasOwn(frame, 'sequence'))
              return yield* failure(
                'input',
                journal.path,
                'invalid',
                'The recovery store allocates input sequence numbers.',
              )
            const semantic = yield* decode(
              nativeRecoveryInputSemanticSchema,
              owner,
              'input-owner',
              journal.path,
            )
            if (journal.snapshot.closeInputSequence !== undefined)
              return yield* failure(
                'input',
                journal.path,
                'closed',
                'Recovery transport has an admitted terminal close.',
              )
            const sequence = journal.snapshot.allocatedInputSequence + 1
            if (!Number.isSafeInteger(sequence))
              return yield* failure(
                'input',
                journal.path,
                'uncertain',
                'Recovery input sequence is exhausted.',
              )
            const numbered = { ...frame, sequence }
            const input: NativeRecoveryNumberedInput = {
              sequence,
              frame: numbered,
              wire: JSON.stringify(numbered) + '\n',
              semantic,
            }
            const cancellations: UnnumberedRecord[] =
              frame.type === 'close'
                ? journal.snapshot.inputs
                    .filter((prior) => !prior.acknowledged && prior.cancellation === undefined)
                    .map((prior) => ({
                      kind: 'input-cancel',
                      sequence: prior.sequence,
                      reason: 'Superseded by explicit transport close.',
                    }))
                : []
            yield* commit(journal, [...cancellations, { kind: 'input', input }])
            return copy(input)
          }),
        ),
      ),
      acknowledgeInput: Effect.fn('NativeRecoveryStore.acknowledgeInput')((id, value) =>
        mutation(id, (journal) =>
          Effect.gen(function* () {
            const sequence = yield* decode(Schema.Natural, value, 'input-ack', journal.path)
            if (sequence > journal.snapshot.allocatedInputSequence)
              return yield* failure(
                'input-ack',
                journal.path,
                'uncertain',
                'Broker acknowledged an input absent from the authorized local outbox.',
              )
            if (sequence <= journal.snapshot.acknowledgedInputSequence) return
            yield* commit(journal, [{ kind: 'input-ack', sequence }])
          }),
        ),
      ),
      cancelInput: Effect.fn('NativeRecoveryStore.cancelInput')((id, value, reason) =>
        mutation(id, (journal) =>
          Effect.gen(function* () {
            const sequence = yield* decode(positive, value, 'input-cancel', journal.path)
            const cancellation = yield* decode(
              Schema.NonEmptyString,
              reason,
              'input-cancel',
              journal.path,
            )
            const input = journal.snapshot.inputs.find((input) => input.sequence === sequence)
            if (!input || input.acknowledged)
              return yield* failure(
                'input-cancel',
                journal.path,
                'uncertain',
                'Cancellation requires an unresolved original input.',
              )
            yield* commit(journal, [{ kind: 'input-cancel', sequence, reason: cancellation }])
          }),
        ),
      ),
      reconcileInputHighWater: Effect.fn('NativeRecoveryStore.reconcileInputHighWater')(
        (id, value) =>
          mutation(id, (journal) =>
            Effect.gen(function* () {
              yield* verifyLease(lease, 'reconcile')
              const highWater = yield* decode(Schema.Natural, value, 'reconcile', journal.path)
              if (
                highWater > journal.snapshot.allocatedInputSequence ||
                highWater < journal.snapshot.acknowledgedInputSequence ||
                highWater < (inputReceiptHighWaterByRecords.get(journal.snapshot.records) ?? 0)
              )
                return yield* failure(
                  'reconcile',
                  journal.path,
                  'uncertain',
                  'Broker input watermark disagrees with the durable outbox; no input was renumbered or replayed.',
                )
              if (highWater > journal.snapshot.acknowledgedInputSequence)
                yield* commit(journal, [{ kind: 'input-ack', sequence: highWater }])
              const pending = journal.snapshot.inputs.filter((input) => input.sequence > highWater)
              const close = pending.find(
                (input) => input.sequence === journal.snapshot.closeInputSequence,
              )
              if (close) {
                const {
                  acknowledged: _acknowledged,
                  consumed: _consumed,
                  written: _written,
                  deliveryReceipt: _deliveryReceipt,
                  cancellation: _cancellation,
                  ...terminal
                } = close
                return [copy(terminal)]
              }
              if (pending.some((input) => input.cancellation !== undefined))
                return yield* failure(
                  'reconcile',
                  journal.path,
                  'uncertain',
                  'A cancelled numbered delivery cannot be skipped or automatically resent.',
                )
              return copy(
                pending.map(
                  ({
                    acknowledged: _acknowledged,
                    consumed: _consumed,
                    written: _written,
                    deliveryReceipt: _deliveryReceipt,
                    cancellation: _cancellation,
                    ...input
                  }) => input,
                ),
              )
            }),
          ),
      ),
      appendOutputs: Effect.fn('NativeRecoveryStore.appendOutputs')(function* (id, values) {
        const done = yield* Deferred.make<void, NativeRecoveryError>()
        let admittedCursor = 0
        yield* admitOutputs(
          id,
          Effect.gen(function* () {
            const journal = yield* get(id)
            const frames = yield* decode(
              Schema.Array(nativeRecoveryOutputSchema),
              values,
              'output',
              journal.path,
            )
            if (frames.length === 0) {
              admittedCursor = journal.stagedCursor
              yield* Deferred.succeed(done, undefined)
              return
            }
            let cursor = journal.stagedCursor
            const receipts = new Map<
              number,
              NonNullable<NativeRecoveryStoredInput['deliveryReceipt']>
            >()
            for (const frame of frames) {
              if (frame.cursor !== cursor + 1)
                return yield* failure(
                  'output',
                  journal.path,
                  'uncertain',
                  `Recovery output frames must be contiguous; expected cursor ${cursor + 1}, received ${frame.cursor}; no frame was skipped.`,
                )
              cursor = frame.cursor
              if (frame.type === 'inputReceipt') {
                yield* validateInputReceipt(
                  journal.snapshot,
                  frame,
                  receipts.get(frame.sequence) ?? journal.stagedInputReceipts.get(frame.sequence),
                  journal.path,
                )
                const { type: _type, sequence: _sequence, ...receipt } = frame
                receipts.set(frame.sequence, receipt)
              }
            }
            const records: UnnumberedRecord[] = frames.map((frame) => ({ kind: 'output', frame }))
            admittedCursor = cursor
            journal.stagedCursor = cursor
            for (const [sequence, receipt] of receipts)
              journal.stagedInputReceipts.set(sequence, receipt)
            yield* enqueue(journal, records, done)
          }),
        )
        yield* Deferred.await(done)
        return admittedCursor
      }),
      appendEvents: Effect.fn('NativeRecoveryStore.appendEvents')(function* (id, values) {
        const done = yield* Deferred.make<void, NativeRecoveryError>()
        const result: NativeRecoveryStoredEvent[] = []
        yield* locked(
          Effect.gen(function* () {
            const journal = yield* get(id)
            const events = yield* decode(
              Schema.Array(nativeRecoveryEventSchema),
              values,
              'events',
              journal.path,
            )
            const records: UnnumberedRecord[] = []
            let revision = journal.stagedEventRevision
            const newEvents = new Map<string, NativeRecoveryStoredEvent>()
            for (const event of events) {
              yield* decode(
                nativeRecoveryAgentEventSchema,
                event.event,
                'agent-event',
                journal.path,
                true,
              )
              if (event.outputCursor > journal.stagedCursor)
                return yield* failure(
                  'events',
                  journal.path,
                  'uncertain',
                  'Native event refers to output that has not been admitted.',
                )
              const prior =
                newEvents.get(event.eventId) ?? journal.stagedEventIndex.get(event.eventId)
              if (prior) {
                const { revision: _revision, ...original } = prior
                if (JSON.stringify(original) !== JSON.stringify(event))
                  return yield* failure(
                    'events',
                    journal.path,
                    'uncertain',
                    'A stable native event ID refers to different event content.',
                  )
                result.push(prior)
                continue
              }
              const stored = { ...event, revision: ++revision }
              newEvents.set(event.eventId, stored)
              records.push({ kind: 'event', event: stored })
              result.push(stored)
            }
            journal.stagedEventRevision = revision
            for (const [eventId, event] of newEvents) journal.stagedEventIndex.set(eventId, event)
            yield* enqueue(journal, records, done)
          }).pipe(Effect.uninterruptible),
        )
        yield* Deferred.await(done)
        return copy(result)
      }),
      checkpoint: Effect.fn('NativeRecoveryStore.checkpoint')((id, value) =>
        mutation(id, (journal) =>
          Effect.gen(function* () {
            const checkpoint = yield* decode(
              nativeRecoveryCheckpointSchema,
              value,
              'checkpoint',
              journal.path,
            )
            if (
              checkpoint.throughOutputCursor > journal.snapshot.outputCursor ||
              checkpoint.throughEventRevision > journal.snapshot.eventRevision
            )
              return yield* failure(
                'checkpoint',
                journal.path,
                'uncertain',
                'Native reducer checkpoint exceeds committed journal state.',
              )
            yield* commit(journal, [{ kind: 'checkpoint', checkpoint }])
          }),
        ),
      ),
      acknowledgeHistory: Effect.fn('NativeRecoveryStore.acknowledgeHistory')((id, value) =>
        mutation(id, (journal) =>
          Effect.gen(function* () {
            const ack = yield* decode(
              nativeRecoveryHistoryAckSchema,
              value,
              'history-ack',
              journal.path,
            )
            const prior = journal.snapshot.historyAcks.find((entry) =>
              sameHistoryOwner(journal.snapshot, entry, ack),
            )
            if (
              (ack.durability === 'native' || ack.fileHash !== undefined) &&
              (ack.fileHash === undefined || !matchingHistoryPrepare(journal.snapshot, ack))
            )
              return yield* failure(
                'history-ack',
                journal.path,
                'uncertain',
                'Native history acknowledgment requires its exact durable preparation and complete file hash.',
              )
            if (
              ack.throughEventRevision > journal.snapshot.eventRevision ||
              (prior && ack.throughEventRevision < prior.throughEventRevision)
            )
              return yield* failure(
                'history-ack',
                journal.path,
                'uncertain',
                'History acknowledgment does not identify a committed forward revision.',
              )
            if (prior && JSON.stringify(prior) === JSON.stringify(ack)) return
            yield* commit(journal, [{ kind: 'history-ack', ack }])
          }),
        ),
      ),
      prepareHistory: Effect.fn('NativeRecoveryStore.prepareHistory')((id, value) =>
        mutation(id, (journal) =>
          Effect.gen(function* () {
            const prepare = yield* decode(
              nativeRecoveryHistoryPrepareSchema,
              value,
              'history-prepare',
              journal.path,
            )
            yield* validateHistoryPrepare(journal.snapshot, prepare, journal.path)
            const prior = journal.snapshot.historyPrepares.find(
              (entry) => entry.snapshotId === prepare.snapshotId,
            )
            if (prior) {
              if (!sameHistoryPreparation(prior, prepare))
                return yield* failure(
                  'history-prepare',
                  journal.path,
                  'uncertain',
                  'History preparation identity was reused for different bytes or private owner claims.',
                )
              return
            }
            yield* commit(journal, [{ kind: 'history-prepare', prepare }])
          }),
        ),
      ),
      flushEffect: Effect.fn('NativeRecoveryStore.flush')(function* () {
        yield* locked(
          Effect.gen(function* () {
            yield* assertOpen()
            for (const journal of journals.values()) yield* commit(journal, [])
          }),
        )
      }),
      closeEffect,
    })
  })

  static layer(options: NativeRecoveryStoreOptions) {
    return Layer.effect(NativeRecoveryStore, NativeRecoveryStore.make(options))
  }
}
