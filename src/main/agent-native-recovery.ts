import { randomUUID } from 'node:crypto'
import { DateTime, Effect, Option, Predicate, Schema, Semaphore } from 'effect'
import type {
  AgentEvent,
  NativeRecoveryConsumer,
  NativeRecoveryCursor,
  NativeRecoveryHistoryReceipt,
} from '../shared/types'
import type {
  ConversationCheckpointAck,
  ConversationProjectionAdmission,
} from '../shared/conversations'
import type { NativeRecoveryStoreHandle } from './native-recovery-store'
import {
  validateConversationRecoveryProof,
  type ConversationRecoveryProof,
} from './conversation-recovery-sidecar'
import {
  NativeRecoveryError,
  type NativeRecoveryEvent,
  type NativeRecoveryHistoryAck,
  type NativeRecoveryHistoryPrepare,
  type NativeRecoveryHistoryPreparedOwner,
  type NativeRecoveryJson,
  type NativeRecoveryJsonObject,
  type NativeRecoveryOwner,
  type NativeRecoverySnapshot,
  type NativeRecoveryStoredEvent,
} from './native-recovery-types'
import { runEffect } from './effect-runtime'
import { JsonLines } from './json-lines'

const decodeId = Schema.decodeUnknownOption(
  Schema.Int.check(Schema.isGreaterThan(0), Schema.isLessThanOrEqualTo(Number.MAX_SAFE_INTEGER)),
)
const decodeCursor = Schema.decodeUnknownOption(
  Schema.Natural.check(Schema.isLessThanOrEqualTo(Number.MAX_SAFE_INTEGER)),
)
const decodeEvent = Schema.decodeUnknownSync(Schema.JsonObject)
const decodeMetadata = Schema.decodeUnknownOption(Schema.JsonObject)
const projectionAdmissionSchema = Schema.Struct({
  sessionId: Schema.NonEmptyString,
  transportId: Schema.NonEmptyString,
  appliedRevision: Schema.Natural.check(Schema.isLessThanOrEqualTo(Number.MAX_SAFE_INTEGER)),
  snapshotToken: Schema.NonEmptyString,
  ownerGeneration: Schema.Natural.check(Schema.isLessThanOrEqualTo(Number.MAX_SAFE_INTEGER)),
  deliveryToken: Schema.NonEmptyString,
})
const preparedCacheSchema = Schema.Struct({
  snapshotId: Schema.NonEmptyString,
  hash: Schema.String.check(Schema.isPattern(/^[a-f0-9]{64}$/)),
  transportId: Schema.NonEmptyString,
  snapshotToken: Schema.NonEmptyString,
  ownerGeneration: Schema.Natural.check(Schema.isLessThanOrEqualTo(Number.MAX_SAFE_INTEGER)),
  throughEventRevision: Schema.Natural.check(Schema.isLessThanOrEqualTo(Number.MAX_SAFE_INTEGER)),
})
const decodePreparedCache = Schema.decodeUnknownOption(preparedCacheSchema, {
  onExcessProperty: 'error',
})
const recoveryCachePrepareSchema = Schema.Struct({
  snapshotId: Schema.NonEmptyString,
  hash: Schema.String.check(Schema.isPattern(/^[a-f0-9]{64}$/)),
  savedAt: Schema.Natural.check(Schema.isLessThanOrEqualTo(Number.MAX_SAFE_INTEGER)),
  projectionAdmissions: Schema.Array(projectionAdmissionSchema),
  membershipAdmissions: Schema.optionalKey(Schema.Array(projectionAdmissionSchema)),
})
const recoveryCacheAttestSchema = Schema.Struct({
  hash: Schema.String.check(Schema.isPattern(/^[a-f0-9]{64}$/)),
})

/** Canceled allocations remain allocated: a new RPC must never reuse their IDs. */
export function maxNativeRequestId(snapshot: NativeRecoverySnapshot): number {
  let highest = 0
  const lines = new JsonLines((wire) => {
    if (!Predicate.isString(wire.method) || !wire.method) return
    const id = Option.getOrUndefined(decodeId(wire.id))
    if (id !== undefined) highest = Math.max(highest, id)
  })
  for (const input of snapshot.inputs) {
    const semanticId =
      input.semantic.kind !== 'permission-response' && input.semantic.method
        ? Option.getOrUndefined(decodeId(input.semantic.requestId))
        : undefined
    if (semanticId !== undefined) highest = Math.max(highest, semanticId)
    if (input.frame.type !== 'write') continue
    lines.push(Buffer.from(input.frame.data, 'base64'))
  }
  return highest
}

function failure(operation: string, id: string, message: string, cause?: unknown) {
  return new NativeRecoveryError({
    operation,
    path: id,
    reason: 'uncertain',
    message,
    ...(cause === undefined ? {} : { cause }),
  })
}

/** Agent output is owned domain data. Omit optional undefined fields without invoking hooks. */
function copyJson(value: unknown, ancestors = new Set<object>()): NativeRecoveryJson {
  if (!Predicate.isObject(value)) {
    return Schema.decodeUnknownSync(Schema.Json)(value)
  }
  if (ancestors.has(value)) throw new Error('Native events cannot contain cycles.')
  const array = Array.isArray(value)
  const prototype = Object.getPrototypeOf(value)
  if (
    prototype !== Object.prototype &&
    prototype !== null &&
    !(array && prototype === Array.prototype)
  )
    throw new Error('Native events require plain JSON values.')
  ancestors.add(value)
  try {
    const result: NativeRecoveryJson[] | Record<string, NativeRecoveryJson> = array ? [] : {}
    for (const key of Reflect.ownKeys(value)) {
      if (typeof key !== 'string') throw new Error('Native events cannot contain symbol fields.')
      if (array && key === 'length') continue
      const descriptor = Object.getOwnPropertyDescriptor(value, key)!
      if (!('value' in descriptor)) throw new Error('Native events cannot contain accessors.')
      if (descriptor.value === undefined && !array) continue
      if (array && !/^(?:0|[1-9][0-9]*)$/.test(key))
        throw new Error('Native event arrays cannot contain named fields.')
      Object.defineProperty(result, key, {
        value: copyJson(descriptor.value, ancestors),
        enumerable: true,
        writable: true,
        configurable: true,
      })
    }
    if (array && Object.keys(result).length !== value.length)
      throw new Error('Native event arrays cannot contain holes.')
    return result
  } finally {
    ancestors.delete(value)
  }
}

function metadataOf(stored: NativeRecoveryStoredEvent, transportId: string) {
  const original = stored.event.nativeRecovery
  const metadata = Option.getOrElse(decodeMetadata(original), (): NativeRecoveryJsonObject => ({}))
  return {
    ...metadata,
    transportId,
    revision: stored.revision,
    eventId: stored.eventId,
    ...(stored.emittedAtMs === undefined ? {} : { emittedAt: stored.emittedAtMs }),
  } as NonNullable<AgentEvent['nativeRecovery']>
}

function canonicalJson(value: NativeRecoveryJson): string {
  if (Array.isArray(value)) return '[' + value.map(canonicalJson).join(',') + ']'
  if (Predicate.isObject(value)) {
    const record = value as NativeRecoveryJsonObject
    return (
      '{' +
      Object.keys(value)
        .sort()
        .map((key) => JSON.stringify(key) + ':' + canonicalJson(record[key]))
        .join(',') +
      '}'
    )
  }
  return JSON.stringify(value)
}

function stableEventContent(event: NativeRecoveryJsonObject): NativeRecoveryJsonObject {
  const { nativeRecovery: _native, ...content } = event
  const details = Option.getOrUndefined(decodeMetadata(content.details))
  if (
    content.type === 'status' &&
    details?.usageScope === 'session' &&
    Predicate.isNumber(details.usageObservedAt)
  ) {
    const { usageObservedAt: _clock, ...stableDetails } = details
    return { ...content, details: stableDetails }
  }
  return content
}

function eventOwnerIdentity(event: NativeRecoveryJsonObject): NativeRecoveryJsonObject {
  const metadata = Option.getOrElse(
    decodeMetadata(event.nativeRecovery),
    (): NativeRecoveryJsonObject => ({}),
  )
  return {
    ...(metadata.ownerGeneration === undefined
      ? {}
      : { ownerGeneration: metadata.ownerGeneration }),
    ...(metadata.snapshotToken === undefined ? {} : { snapshotToken: metadata.snapshotToken }),
    ...(metadata.localTurn === undefined ? {} : { localTurn: metadata.localTurn }),
  }
}

export function stampRecoveryEvent(
  stored: NativeRecoveryStoredEvent,
  transportId: string,
): AgentEvent {
  return {
    ...(copyJson(stored.event) as unknown as AgentEvent),
    nativeRecovery: metadataOf(stored, transportId),
  }
}

function historicalOwners(snapshot: NativeRecoverySnapshot): NativeRecoveryOwner[] {
  const owners: NativeRecoveryOwner[] = []
  for (const record of snapshot.records) {
    if (record.kind === 'create') owners.push(...record.transport.owners)
    else if (record.kind === 'transport' && record.patch.owners) owners.push(...record.patch.owners)
  }
  owners.push(...snapshot.transport.owners)
  return owners
}

function matchingOwner(
  snapshot: NativeRecoverySnapshot,
  consumer: NativeRecoveryConsumer,
  cursor?: Pick<NativeRecoveryCursor, 'snapshotToken' | 'ownerGeneration'>,
) {
  if (consumer.profileId !== snapshot.transport.machine.profileId) return
  return historicalOwners(snapshot).find(
    (owner) =>
      owner.kind === 'root' &&
      owner.sessionId === consumer.sessionId &&
      consumer.workspace === owner.workspace &&
      (!cursor ||
        (owner.snapshotToken === cursor.snapshotToken &&
          (owner.generation ?? 0) === cursor.ownerGeneration)) &&
      (consumer.remoteId === undefined ||
        consumer.remoteId === (owner.nativeThreadId ?? owner.nativeSessionId)),
  )
}

function privateHistoryAcks(snapshot: NativeRecoverySnapshot): NativeRecoveryHistoryAck[] {
  return [
    ...snapshot.historyAcks,
    ...snapshot.records.flatMap((record) => (record.kind === 'history-ack' ? [record.ack] : [])),
  ]
}

function matchingHistoryPrepare(snapshot: NativeRecoverySnapshot, ack: NativeRecoveryHistoryAck) {
  if (!ack.fileHash || !ack.snapshotToken || ack.ownerGeneration === undefined) return
  return snapshot.historyPrepares.find(
    (prepare) =>
      (prepare.location ?? 'native-file') ===
        (ack.durability === 'native' ? 'native-file' : 'studio-cache') &&
      prepare.snapshotId === ack.snapshotId &&
      prepare.fileHash === ack.fileHash &&
      prepare.owners.some(
        (owner) =>
          owner.consumerId === ack.consumerId &&
          owner.sessionId === ack.sessionId &&
          owner.snapshotToken === ack.snapshotToken &&
          owner.ownerGeneration === ack.ownerGeneration &&
          owner.throughEventRevision === ack.throughEventRevision,
      ),
  )
}

function privateAckRevision(
  snapshot: NativeRecoverySnapshot,
  consumerId: string,
  sessionId: string,
  token: string,
  generation: number,
  requirePreparation = false,
) {
  let maximum = 0
  for (const ack of privateHistoryAcks(snapshot)) {
    if (
      ack.consumerId !== consumerId ||
      ack.sessionId !== sessionId ||
      ack.snapshotToken !== token ||
      ack.ownerGeneration !== generation ||
      (consumerId === `main:${sessionId}` && ack.durability !== 'native') ||
      ((ack.durability === 'native' || requirePreparation) &&
        !matchingHistoryPrepare(snapshot, ack))
    )
      continue
    const committed = Option.getOrUndefined(decodeCursor(ack.throughEventRevision))
    if (committed !== undefined && committed <= snapshot.eventRevision)
      maximum = Math.max(maximum, committed)
  }
  return maximum
}

/** Saved archive cursors are claims; only this private ledger's ACK authorizes suppression. */
export function acceptedRecoveryCursor(
  snapshot: NativeRecoverySnapshot,
  consumer: NativeRecoveryConsumer,
): NativeRecoveryCursor | undefined {
  const cursor = consumer.applied?.[snapshot.transport.id]
  if (!cursor?.snapshotToken || !matchingOwner(snapshot, consumer, cursor)) return
  const claimed = Option.getOrUndefined(decodeCursor(cursor.appliedRevision))
  const generation = Option.getOrUndefined(decodeCursor(cursor.ownerGeneration))
  if (claimed === undefined || generation === undefined) return
  const maximum = privateAckRevision(
    snapshot,
    `${consumer.kind}:${consumer.sessionId}`,
    consumer.sessionId,
    cursor.snapshotToken,
    generation,
  )
  return {
    appliedRevision: Math.min(claimed, maximum),
    snapshotToken: cursor.snapshotToken,
    ownerGeneration: generation,
  }
}

/** A privately ACKed session watermark covers all its earlier exact-scope generations. */
export function replayRecoveryEvents(
  snapshot: NativeRecoverySnapshot,
  consumers: readonly NativeRecoveryConsumer[],
): AgentEvent[] {
  const admitted = new Map<string, NativeRecoveryConsumer[]>()
  for (const consumer of consumers) {
    if (!matchingOwner(snapshot, consumer)) continue
    const owners = admitted.get(consumer.sessionId) ?? []
    owners.push(consumer)
    admitted.set(consumer.sessionId, owners)
  }
  return snapshot.events.flatMap((stored) => {
    const sessionId = stored.event.sessionId
    if (!Predicate.isString(sessionId)) return []
    const candidates = admitted.get(sessionId)
    if (!candidates) return []
    const event = stampRecoveryEvent(stored, snapshot.transport.id)
    const native = event.nativeRecovery!
    const consumers = candidates.filter((consumer) =>
      matchingOwner(snapshot, consumer, native.snapshotToken === undefined ? undefined : native),
    )
    if (!consumers.length) return []
    const applied = consumers.every((consumer) => {
      const cursor = acceptedRecoveryCursor(snapshot, consumer)
      if (!cursor) return false
      const revision = Option.getOrUndefined(decodeCursor(cursor.appliedRevision))
      return (
        revision !== undefined && revision <= snapshot.eventRevision && revision >= stored.revision
      )
    })
    return applied ? [] : [event]
  })
}

export interface NativeRecoveryWireContext {
  /** Input/exit-derived events have an explicit deterministic identity, independent of JSON parsing. */
  readonly eventId?: string
  readonly wireSequence?: number
  readonly outputCursor?: number
  readonly replay?: boolean
  readonly nativeRequestId?: string | number
}

/** Streaming stamps do not traverse prompts, attachments, or planner source context. */
export type NativeRecoveryOwnerStamp = Pick<
  NativeRecoveryOwner,
  'generation' | 'snapshotToken' | 'localTurn'
>

interface WireContext extends NativeRecoveryWireContext {
  index: number
}
interface QueuedEvent {
  readonly transportId: string
  readonly original: NativeRecoveryEvent
  readonly replay: boolean
}

/** Durable native event admission; Promise execution is confined to the Agents integration edge. */
export class NativeAgentRecovery {
  private readonly mutex = Semaphore.makeUnsafe(1)
  private readonly ownershipMutex = Semaphore.makeUnsafe(1)
  private readonly known = new Map<string, Map<string, NativeRecoveryStoredEvent>>()
  private readonly snapshots = new Map<string, NativeRecoverySnapshot>()
  private readonly contexts = new Map<string, WireContext>()
  private readonly queue: QueuedEvent[] = []
  private readonly pending = new Map<string, QueuedEvent>()
  private readonly delivered = new Map<string, Map<string, number>>()
  private readonly deliveryTokens = new Map<string, string>()
  private readonly validatedBaselines = new Map<string, ConversationRecoveryProof>()
  private readonly validatedMainCaches = new Map<string, number>()
  private readonly attestedMainCacheClaims = new Map<string, Map<string, number>>()
  private readonly absentMemberships = new Map<string, ConversationProjectionAdmission>()
  private readonly absentMembershipKeys = new Map<string, string>()
  private readonly validatedCaches = new Map<
    string,
    {
      revision: number
      snapshotId: string
      hash: string
    }
  >()
  private readonly localIdentity = randomUUID()
  private localSequence = 0
  private scheduled = false
  private failed?: NativeRecoveryError

  constructor(
    private readonly store: NativeRecoveryStoreHandle | undefined,
    private readonly publish: (event: AgentEvent) => unknown,
    private readonly onFailure: (error: NativeRecoveryError) => void = () => {},
  ) {}

  get failure() {
    return this.failed
  }

  getDeliveryToken(
    transportId: string,
    owner: Pick<NativeRecoveryOwner, 'sessionId' | 'snapshotToken' | 'generation'>,
  ) {
    if (!owner.snapshotToken) return
    return this.deliveryToken(
      transportId,
      owner.sessionId,
      owner.snapshotToken,
      owner.generation ?? 0,
    )
  }

  getAcceptedProjectionAdmission(
    snapshot: NativeRecoverySnapshot,
    consumer: NativeRecoveryConsumer,
    cursor: NativeRecoveryCursor | undefined,
  ): ConversationProjectionAdmission | undefined {
    if (!cursor?.snapshotToken || cursor.ownerGeneration === undefined) return
    const accepted = this.acceptedCursor(snapshot, consumer)
    if (
      !accepted ||
      accepted.appliedRevision !== cursor.appliedRevision ||
      accepted.snapshotToken !== cursor.snapshotToken ||
      accepted.ownerGeneration !== cursor.ownerGeneration
    )
      return
    const claim = {
      appliedRevision: cursor.appliedRevision,
      snapshotToken: cursor.snapshotToken,
      ownerGeneration: cursor.ownerGeneration,
    }
    return {
      sessionId: consumer.sessionId,
      transportId: snapshot.transport.id,
      ...claim,
      deliveryToken: this.deliveryToken(
        snapshot.transport.id,
        consumer.sessionId,
        cursor.snapshotToken,
        cursor.ownerGeneration,
      ),
    }
  }

  revokeDeliveryTokens() {
    this.deliveryTokens.clear()
    this.delivered.clear()
    this.validatedCaches.clear()
    this.validatedMainCaches.clear()
    this.attestedMainCacheClaims.clear()
    this.absentMemberships.clear()
    this.absentMembershipKeys.clear()
  }

  private projectionAdmitted(
    admissions: readonly ConversationProjectionAdmission[],
    transportId: string,
    sessionId: string,
    cursor: Required<NativeRecoveryCursor>,
  ) {
    const token = this.deliveryTokens.get(
      this.deliveryKey(transportId, sessionId, cursor.snapshotToken, cursor.ownerGeneration),
    )
    return (
      token !== undefined &&
      admissions.some(
        (admission) =>
          admission.sessionId === sessionId &&
          admission.transportId === transportId &&
          admission.appliedRevision === cursor.appliedRevision &&
          admission.snapshotToken === cursor.snapshotToken &&
          admission.ownerGeneration === cursor.ownerGeneration &&
          admission.deliveryToken === token,
      )
    )
  }

  private membershipAdmitted(admission: ConversationProjectionAdmission) {
    const recorded = this.absentMemberships.get(admission.deliveryToken)
    return (
      recorded !== undefined &&
      recorded.sessionId === admission.sessionId &&
      recorded.transportId === admission.transportId &&
      recorded.snapshotToken === admission.snapshotToken &&
      recorded.ownerGeneration === admission.ownerGeneration &&
      recorded.appliedRevision === admission.appliedRevision
    )
  }

  /** Suppression is authority over an actual document, separate from archived cursor claims. */
  acceptedCursor(
    snapshot: NativeRecoverySnapshot,
    consumer: NativeRecoveryConsumer,
  ): NativeRecoveryCursor | undefined {
    const claimed = consumer.applied?.[snapshot.transport.id]
    if (!claimed?.snapshotToken || !matchingOwner(snapshot, consumer, claimed)) return
    const revision = Option.getOrUndefined(decodeCursor(claimed.appliedRevision))
    const generation = Option.getOrUndefined(decodeCursor(claimed.ownerGeneration))
    if (revision === undefined || generation === undefined || revision > snapshot.eventRevision)
      return
    const cursor = {
      appliedRevision: revision,
      snapshotToken: claimed.snapshotToken,
      ownerGeneration: generation,
    }
    if (revision === 0) return cursor
    if (consumer.kind === 'studio') {
      if (!consumer.cacheHash) {
        // A missing cache can be rebuilt from events delivered in this document.
        // Saved cursors alone never grant this authority, and a supplied cache
        // hash must still match the exact privately prepared bytes below.
        return this.projectionAdmitted(
          consumer.projectionAdmissions ?? [],
          snapshot.transport.id,
          consumer.sessionId,
          cursor,
        ) &&
          revision <=
            this.deliveredRevision(
              snapshot.transport.id,
              consumer.sessionId,
              cursor.snapshotToken,
              cursor.ownerGeneration,
            )
          ? cursor
          : undefined
      }
      const prepared = snapshot.historyPrepares.find(
        (prepare) =>
          prepare.fileHash === consumer.cacheHash &&
          prepare.location === 'studio-cache' &&
          prepare.owners.some(
            (owner) =>
              owner.consumerId === `studio:${consumer.sessionId}` &&
              owner.sessionId === consumer.sessionId &&
              owner.snapshotToken === cursor.snapshotToken &&
              owner.ownerGeneration === cursor.ownerGeneration &&
              owner.throughEventRevision === cursor.appliedRevision,
          ),
      )
      if (!prepared) return
      const key = this.deliveryKey(
        snapshot.transport.id,
        consumer.sessionId,
        cursor.snapshotToken,
        cursor.ownerGeneration,
      )
      const prior = this.validatedCaches.get(key)
      if (!prior || revision >= prior.revision)
        this.validatedCaches.set(key, {
          revision,
          snapshotId: prepared.snapshotId,
          hash: prepared.fileHash,
        })
      return cursor
    }
    if (
      !this.projectionAdmitted(
        consumer.projectionAdmissions ?? [],
        snapshot.transport.id,
        consumer.sessionId,
        cursor,
      )
    )
      return
    if (consumer.cacheHash) {
      const claims = this.attestedMainCacheClaims.get(consumer.cacheHash)
      const revision = claims?.get(
        this.deliveryKey(
          snapshot.transport.id,
          consumer.sessionId,
          cursor.snapshotToken,
          cursor.ownerGeneration,
        ),
      )
      return revision === cursor.appliedRevision ? cursor : undefined
    }
    const progress = Math.max(
      this.deliveredRevision(
        snapshot.transport.id,
        consumer.sessionId,
        cursor.snapshotToken,
        cursor.ownerGeneration,
      ),
      this.validatedMainCaches.get(
        this.deliveryKey(
          snapshot.transport.id,
          consumer.sessionId,
          cursor.snapshotToken,
          cursor.ownerGeneration,
        ),
      ) ?? 0,
    )
    if (revision <= progress) return cursor
    const owner = matchingOwner(snapshot, consumer, cursor)!
    const scope: ConversationRecoveryProof['receipt']['owners'][number] = {
      sessionId: consumer.sessionId,
      provider: snapshot.transport.provider,
      profileId: consumer.profileId,
      workspace: owner.workspace,
      remoteId: owner.nativeThreadId ?? owner.nativeSessionId ?? '',
      nativeRecovery: {},
    }
    return revision <=
      privateAckRevision(
        snapshot,
        `main:${consumer.sessionId}`,
        consumer.sessionId,
        cursor.snapshotToken,
        cursor.ownerGeneration,
      ) && this.provenBaseline(scope, snapshot.transport.id, cursor)
      ? cursor
      : undefined
  }

  validateConsumerBaseline(snapshot: NativeRecoverySnapshot, consumer: NativeRecoveryConsumer) {
    if (!matchingOwner(snapshot, consumer)) return false
    const cursor = consumer.applied?.[snapshot.transport.id]
    return cursor === undefined || this.acceptedCursor(snapshot, consumer) !== undefined
  }

  isAbsentMembership(
    snapshot: NativeRecoverySnapshot,
    owner: Pick<NativeRecoveryOwner, 'sessionId' | 'snapshotToken' | 'generation'>,
    admissions: readonly ConversationProjectionAdmission[] = [],
  ) {
    if (!owner.snapshotToken) return false
    return admissions.some((admission) => {
      const recorded = this.absentMemberships.get(admission.deliveryToken)
      return (
        recorded !== undefined &&
        recorded.sessionId === owner.sessionId &&
        recorded.transportId === snapshot.transport.id &&
        recorded.snapshotToken === owner.snapshotToken &&
        recorded.ownerGeneration === (owner.generation ?? 0) &&
        admission.sessionId === recorded.sessionId &&
        admission.transportId === recorded.transportId &&
        admission.snapshotToken === recorded.snapshotToken &&
        admission.ownerGeneration === recorded.ownerGeneration &&
        admission.appliedRevision === recorded.appliedRevision
      )
    })
  }

  private deliveryKey(
    transportId: string,
    sessionId: string,
    snapshotToken: string,
    ownerGeneration: number,
  ) {
    return JSON.stringify([transportId, sessionId, snapshotToken, ownerGeneration])
  }

  private deliveryToken(
    transportId: string,
    sessionId: string,
    snapshotToken: string,
    ownerGeneration: number,
  ) {
    const key = this.deliveryKey(transportId, sessionId, snapshotToken, ownerGeneration)
    let token = this.deliveryTokens.get(key)
    if (!token) {
      token = randomUUID()
      this.deliveryTokens.set(key, token)
    }
    return token
  }

  private stampDeliveryToken(event: AgentEvent) {
    const native = event.nativeRecovery
    if (native?.snapshotToken)
      event.nativeRecovery = {
        ...native,
        deliveryToken: this.deliveryToken(
          native.transportId,
          event.sessionId,
          native.snapshotToken,
          native.ownerGeneration ?? 0,
        ),
      }
    return event
  }

  private provenBaseline(
    receipt: ConversationRecoveryProof['receipt']['owners'][number],
    transportId: string,
    cursor: ConversationRecoveryProof['receipt']['owners'][number]['nativeRecovery'][string],
    exact?: { hash: string; savedAt: number },
  ) {
    for (const baseline of this.validatedBaselines.values()) {
      if (exact && (baseline.hash !== exact.hash || baseline.savedAt !== exact.savedAt)) continue
      const owner = baseline.receipt.owners.find(
        (owner) =>
          owner.sessionId === receipt.sessionId &&
          owner.provider === receipt.provider &&
          owner.profileId === receipt.profileId &&
          owner.workspace === receipt.workspace &&
          owner.remoteId === receipt.remoteId,
      )
      const prior = owner?.nativeRecovery[transportId]
      if (
        prior &&
        prior.snapshotToken === cursor.snapshotToken &&
        prior.ownerGeneration === cursor.ownerGeneration &&
        (exact
          ? prior.appliedRevision === cursor.appliedRevision
          : prior.appliedRevision >= cursor.appliedRevision)
      )
        return true
    }
    return false
  }

  /** Called only for an original ledger event actually released to the renderer. */
  noteReplayDelivery(event: AgentEvent) {
    const native = event.nativeRecovery
    const original = native && this.known.get(native.transportId)?.get(native.eventId)
    if (
      !native ||
      !original ||
      original.revision !== native.revision ||
      original.event.sessionId !== event.sessionId ||
      canonicalJson(stableEventContent(original.event)) !==
        canonicalJson(stableEventContent(decodeEvent(copyJson(event)))) ||
      canonicalJson(eventOwnerIdentity(original.event)) !==
        canonicalJson(eventOwnerIdentity(decodeEvent(copyJson(event))))
    )
      throw failure(
        'event-delivery',
        native?.transportId ?? '',
        'Replay delivery must identify an exact original committed native event.',
      )
    this.stampDeliveryToken(event)
    return this.noteDelivery(event)
  }

  private noteDelivery(event: AgentEvent) {
    const { transportId, revision, snapshotToken, ownerGeneration } = event.nativeRecovery!
    const key = JSON.stringify([event.sessionId, snapshotToken ?? null, ownerGeneration ?? 0])
    const sessions = this.delivered.get(transportId) ?? new Map<string, number>()
    this.delivered.set(transportId, sessions)
    const prior = sessions.get(key)
    sessions.set(key, Math.max(prior ?? 0, revision))
    return () => {
      if (sessions.get(key) !== Math.max(prior ?? 0, revision)) return
      if (prior === undefined) sessions.delete(key)
      else sessions.set(key, prior)
    }
  }

  private deliveredRevision(
    transportId: string,
    sessionId: string,
    snapshotToken: string,
    ownerGeneration: number,
  ) {
    return (
      this.delivered
        .get(transportId)
        ?.get(JSON.stringify([sessionId, snapshotToken, ownerGeneration])) ?? 0
    )
  }

  seed(snapshot: NativeRecoverySnapshot) {
    const prior = this.snapshots.get(snapshot.transport.id)
    if (
      !prior ||
      (snapshot.outputCursor >= prior.outputCursor && snapshot.eventRevision >= prior.eventRevision)
    )
      this.snapshots.set(snapshot.transport.id, snapshot)
    const known =
      this.known.get(snapshot.transport.id) ?? new Map<string, NativeRecoveryStoredEvent>()
    for (const event of snapshot.events)
      if (!known.has(event.eventId)) known.set(event.eventId, event)
    this.known.set(snapshot.transport.id, known)
  }

  beginWire(transportId: string, wireSequence: number, outputCursor: number, replay = false) {
    this.contexts.set(transportId, { wireSequence, outputCursor, replay, index: 0 })
  }

  endWire(transportId: string) {
    this.contexts.delete(transportId)
  }

  originalEvent(transportId: string, wireSequence: number, index = 0) {
    const stored = this.known.get(transportId)?.get(`${transportId}:wire:${wireSequence}:${index}`)
    return stored && stampRecoveryEvent(stored, transportId)
  }

  event(
    transportId: string,
    event: AgentEvent,
    owner?: NativeRecoveryOwnerStamp,
    context?: NativeRecoveryWireContext,
  ) {
    if (!this.store) {
      if (!context?.replay && !this.contexts.get(transportId)?.replay) this.publish(event)
      return
    }
    if (this.failed) throw this.failed
    const active = context ?? this.contexts.get(transportId)
    const wireSequence = active?.wireSequence
    let eventId: string
    if (active?.eventId !== undefined) {
      if (!active.eventId)
        throw failure('events', transportId, 'Native event identities must be nonempty.')
      eventId = active.eventId
    } else if (wireSequence === undefined) {
      if (active?.replay)
        throw failure(
          'events',
          transportId,
          'Recovery events require their original native wire ordinal.',
        )
      eventId = `${transportId}:local:${this.localIdentity}:${++this.localSequence}`
    } else {
      const ordinal = Option.getOrUndefined(decodeId(wireSequence))
      if (ordinal === undefined)
        throw failure('events', transportId, 'Native wire ordinals must be positive safe integers.')
      // An explicit context can coexist with beginWire; both use the same per-wire event counter.
      let tracked = this.contexts.get(transportId)
      if (!tracked || tracked.wireSequence !== ordinal) {
        tracked = { ...active, wireSequence: ordinal, index: 0 }
        this.contexts.set(transportId, tracked)
      }
      eventId = `${transportId}:wire:${ordinal}:${tracked.index++}`
    }
    let originalEvent: NativeRecoveryJsonObject
    try {
      originalEvent = decodeEvent(copyJson(event))
    } catch (cause) {
      throw failure(
        'events',
        transportId,
        'Native event data could not be admitted without evaluating or changing it.',
        cause,
      )
    }
    const { nativeRecovery: _discarded, ...withoutNative } = originalEvent
    const metadata: NativeRecoveryJsonObject = {
      transportId,
      eventId,
      ...(owner?.generation === undefined ? {} : { ownerGeneration: owner.generation }),
      ...(owner?.snapshotToken === undefined ? {} : { snapshotToken: owner.snapshotToken }),
      ...(owner?.localTurn === undefined ? {} : { localTurn: owner.localTurn }),
    }
    const canonical = { ...withoutNative, nativeRecovery: metadata }
    const assertSameContent = (prior: NativeRecoveryEvent) => {
      if (
        canonicalJson(stableEventContent(prior.event)) !==
          canonicalJson(stableEventContent(canonical)) ||
        canonicalJson(eventOwnerIdentity(prior.event)) !==
          canonicalJson(eventOwnerIdentity(canonical))
      )
        throw failure(
          'events',
          transportId,
          'A native event identity was reused for different content or ownership.',
        )
    }
    const known = this.known.get(transportId)?.get(eventId)
    if (known) {
      assertSameContent(known)
      return stampRecoveryEvent(known, transportId)
    }
    const pendingKey = JSON.stringify([transportId, eventId])
    const pending = this.pending.get(pendingKey)
    if (pending) {
      assertSameContent(pending.original)
      return
    }
    const outputCursor = active?.outputCursor ?? this.snapshots.get(transportId)?.outputCursor ?? 0
    const admittedCursor = Option.getOrUndefined(decodeCursor(outputCursor))
    if (admittedCursor === undefined)
      throw failure('events', transportId, 'Native event output cursors must be safe integers.')
    // Provider payloads or renderer metadata cannot grant native ledger ownership.
    const queued: QueuedEvent = {
      transportId,
      replay: active?.replay === true,
      original: {
        eventId,
        outputCursor: admittedCursor,
        emittedAtMs: DateTime.toEpochMillis(DateTime.nowUnsafe()),
        ...(active?.nativeRequestId === undefined
          ? {}
          : { nativeRequestId: active.nativeRequestId }),
        event: canonical,
      },
    }
    this.queue.push(queued)
    this.pending.set(pendingKey, queued)
    this.schedule()
  }

  emit(
    event: AgentEvent,
    transportId: string,
    owner?: NativeRecoveryOwnerStamp,
    context?: NativeRecoveryWireContext,
  ) {
    this.event(transportId, event, owner, context)
  }

  replayEvents(snapshot: NativeRecoverySnapshot, consumers: readonly NativeRecoveryConsumer[]) {
    const registered = historicalOwners(snapshot)
    const admitted = consumers.flatMap((consumer) => {
      if (!this.validateConsumerBaseline(snapshot, consumer)) return []
      const scopes = new Set(
        registered
          .filter(
            (owner) =>
              owner.kind === 'root' &&
              owner.sessionId === consumer.sessionId &&
              owner.workspace === consumer.workspace &&
              (consumer.remoteId === undefined ||
                consumer.remoteId === (owner.nativeThreadId ?? owner.nativeSessionId)),
          )
          .map((owner) => JSON.stringify([owner.snapshotToken, owner.generation ?? 0])),
      )
      return [
        {
          consumer,
          scopes,
          applied: this.acceptedCursor(snapshot, consumer)?.appliedRevision ?? -1,
        },
      ]
    })
    if (!admitted.length) return []
    const sessions = new Map<string, typeof admitted>()
    for (const binding of admitted) {
      const bindings = sessions.get(binding.consumer.sessionId) ?? []
      bindings.push(binding)
      sessions.set(binding.consumer.sessionId, bindings)
    }
    return snapshot.events.flatMap((stored) => {
      if (!Predicate.isString(stored.event.sessionId)) return []
      const bindings = sessions.get(stored.event.sessionId)
      if (!bindings) return []
      const native = metadataOf(stored, snapshot.transport.id)
      const candidates = bindings.filter(
        ({ scopes }) =>
          native.snapshotToken === undefined ||
          scopes.has(JSON.stringify([native.snapshotToken, native.ownerGeneration])),
      )
      if (!candidates.length) return []
      return candidates.every(({ applied }) => applied >= stored.revision)
        ? []
        : [stampRecoveryEvent(stored, snapshot.transport.id)]
    })
  }

  readonly flushEffect = Effect.fnUntraced(
    function* (this: NativeAgentRecovery): Effect.fn.Return<void, NativeRecoveryError> {
      if (this.failed) return yield* this.failed
      if (!this.store) return
      while (this.queue.length) {
        // Preserve cross-transport emission order while batching each contiguous transport group.
        const transportId = this.queue[0].transportId
        let length = 1
        while (length < this.queue.length && this.queue[length].transportId === transportId)
          length++
        const batch = this.queue.slice(0, length)
        const stored = yield* this.store
          .appendEvents(
            transportId,
            batch.map((event) => event.original),
          )
          .pipe(
            Effect.mapError(
              (error) =>
                new NativeRecoveryError({
                  operation: error.operation,
                  path: transportId,
                  reason: error.reason,
                  message: error.message,
                  cause: error,
                }),
            ),
          )
        if (stored.length !== batch.length)
          return yield* failure(
            'events',
            transportId,
            'Durable event storage returned an incomplete admission batch.',
          )
        this.queue.splice(0, length)
        const known = this.known.get(transportId) ?? new Map<string, NativeRecoveryStoredEvent>()
        this.known.set(transportId, known)
        for (let index = 0; index < stored.length; index++) {
          this.pending.delete(JSON.stringify([transportId, stored[index].eventId]))
          known.set(stored[index].eventId, stored[index])
        }
        for (let index = 0; index < stored.length; index++) {
          if (!batch[index].replay) {
            const event = this.stampDeliveryToken(stampRecoveryEvent(stored[index], transportId))
            const native = event.nativeRecovery!
            const tokenKey = native.snapshotToken
              ? this.deliveryKey(
                  transportId,
                  event.sessionId,
                  native.snapshotToken,
                  native.ownerGeneration ?? 0,
                )
              : undefined
            const rollback = this.noteDelivery(event)
            yield* Effect.try({
              try: () => {
                if (this.publish(event) === false) rollback()
              },
              catch: (cause) => {
                rollback()
                if (tokenKey) this.deliveryTokens.delete(tokenKey)
                return failure(
                  'event-delivery',
                  transportId,
                  'A committed native event could not be delivered; its original ledger entry was retained.',
                  cause,
                )
              },
            })
          }
        }
      }
    }.bind(this),
    (effect) => this.mutex.withPermits(1)(effect),
    Effect.tapError((error) =>
      Effect.sync(() => {
        this.failed = error
      }),
    ),
    Effect.uninterruptible,
  )

  readonly updateOwnerEffect = Effect.fnUntraced(
    function* (
      this: NativeAgentRecovery,
      transportId: string,
      owner: NativeRecoveryOwner,
      admissions: readonly ConversationProjectionAdmission[] = [],
    ): Effect.fn.Return<void, NativeRecoveryError> {
      if (!this.store) return
      yield* this.flushEffect()
      const snapshot = yield* this.store.readTransport(transportId)
      const index = snapshot.transport.owners.findIndex((value) => value.ownerId === owner.ownerId)
      const owners = [...snapshot.transport.owners]
      const prior = owners[index]
      if (
        prior &&
        (prior.sessionId !== owner.sessionId ||
          prior.kind !== owner.kind ||
          prior.input.scope !== owner.input.scope ||
          (owner.generation ?? 0) < (prior.generation ?? 0) ||
          ((owner.generation ?? 0) === (prior.generation ?? 0) &&
            prior.snapshotToken !== undefined &&
            prior.snapshotToken !== owner.snapshotToken))
      )
        return yield* failure(
          'owner',
          transportId,
          'A late owner update cannot replace its native identity, change its original scope, or move its snapshot generation backward.',
        )
      const client = Option.getOrUndefined(decodeMetadata(owner.clientRecovery))
      if (client?.preparedCache !== undefined) {
        const cache = Option.getOrUndefined(decodePreparedCache(client.preparedCache))
        const registered =
          cache &&
          historicalOwners(snapshot).some(
            (entry) =>
              entry.kind === 'root' &&
              entry.sessionId === owner.sessionId &&
              entry.input.scope === 'life-customization' &&
              entry.workspace === owner.workspace &&
              entry.snapshotToken === cache.snapshotToken &&
              (entry.generation ?? 0) === cache.ownerGeneration,
          )
        if (
          !cache ||
          owner.kind !== 'root' ||
          owner.input?.scope !== 'life-customization' ||
          !registered ||
          cache.transportId !== transportId ||
          cache.throughEventRevision > snapshot.eventRevision
        )
          return yield* failure(
            'owner',
            transportId,
            'The Studio cache preparation does not identify an exact registered native owner.',
          )
        let preparedOwner: NativeRecoveryHistoryPreparedOwner = {
          consumerId: `studio:${owner.sessionId}`,
          sessionId: owner.sessionId,
          snapshotToken: cache.snapshotToken,
          ownerGeneration: cache.ownerGeneration,
          throughEventRevision: cache.throughEventRevision,
          authority: 'native-delivery',
        }
        const exact = snapshot.historyPrepares.some(
          (prepare) =>
            prepare.snapshotId === cache.snapshotId &&
            prepare.location === 'studio-cache' &&
            prepare.fileHash === cache.hash &&
            prepare.owners.some(
              (entry) =>
                entry.consumerId === preparedOwner.consumerId &&
                entry.sessionId === preparedOwner.sessionId &&
                entry.snapshotToken === preparedOwner.snapshotToken &&
                entry.ownerGeneration === preparedOwner.ownerGeneration &&
                entry.throughEventRevision === preparedOwner.throughEventRevision,
            ),
        )
        if (!exact) {
          const ownedAdmissions = yield* Effect.try({
            try: () => copyJson(admissions),
            catch: (cause) =>
              failure('owner', transportId, 'Studio projection admissions are invalid.', cause),
          }).pipe(
            Effect.flatMap((value) =>
              Schema.decodeUnknownEffect(Schema.Array(projectionAdmissionSchema), {
                onExcessProperty: 'error',
              })(value).pipe(
                Effect.mapError((cause) =>
                  failure('owner', transportId, 'Studio projection admissions are invalid.', cause),
                ),
              ),
            ),
          )
          if (
            !this.projectionAdmitted(ownedAdmissions, transportId, owner.sessionId, {
              appliedRevision: cache.throughEventRevision,
              snapshotToken: cache.snapshotToken,
              ownerGeneration: cache.ownerGeneration,
            })
          )
            return yield* failure(
              'owner',
              transportId,
              'Studio cache bytes require the exact privately admitted projection capability.',
            )
          const progress = this.deliveredRevision(
            transportId,
            owner.sessionId,
            cache.snapshotToken,
            cache.ownerGeneration,
          )
          if (cache.throughEventRevision > progress) {
            const baseline = this.validatedCaches.get(
              this.deliveryKey(
                transportId,
                owner.sessionId,
                cache.snapshotToken,
                cache.ownerGeneration,
              ),
            )
            if (!baseline || cache.throughEventRevision > baseline.revision)
              return yield* failure(
                'owner',
                transportId,
                'Studio cache bytes exceed the actual delivered or hash-proven projection.',
              )
            // A matching actual cache read proves an earlier prewrite committed even if its
            // renderer crashed before sending the ordinary ACK.
            if (
              baseline.revision >
              privateAckRevision(
                snapshot,
                `studio:${owner.sessionId}`,
                owner.sessionId,
                cache.snapshotToken,
                cache.ownerGeneration,
                true,
              )
            )
              yield* this.store.acknowledgeHistory(transportId, {
                consumerId: `studio:${owner.sessionId}`,
                sessionId: owner.sessionId,
                snapshotId: baseline.snapshotId,
                fileHash: baseline.hash,
                durability: 'admitted-cache',
                snapshotToken: cache.snapshotToken,
                ownerGeneration: cache.ownerGeneration,
                throughEventRevision: baseline.revision,
              })
            preparedOwner = { ...preparedOwner, authority: 'private-ack' }
          }
          yield* this.store.prepareHistory(transportId, {
            location: 'studio-cache',
            snapshotId: cache.snapshotId,
            fileHash: cache.hash,
            owners: [preparedOwner],
          })
        }
      }
      if (index < 0) owners.push(owner)
      else owners[index] = owner
      yield* this.store.updateTransport(transportId, { owners })
      this.seed(yield* this.store.readTransport(transportId))
    }.bind(this),
    (effect) => this.ownershipMutex.withPermits(1)(effect),
  )

  readonly acknowledgeEffect = Effect.fnUntraced(
    function* (
      this: NativeAgentRecovery,
      receipt: NativeRecoveryHistoryReceipt,
      consumers?: readonly NativeRecoveryConsumer[],
    ): Effect.fn.Return<void, NativeRecoveryError> {
      if (!this.store)
        return yield* failure(
          'history-ack',
          receipt.transportId,
          'Native recovery storage is unavailable.',
        )
      yield* this.flushEffect()
      const snapshot = yield* this.store.readTransport(receipt.transportId)
      if (
        consumers &&
        !consumers.some(
          (consumer) =>
            consumer.kind === receipt.kind &&
            consumer.sessionId === receipt.sessionId &&
            matchingOwner(snapshot, consumer),
        )
      )
        return yield* failure(
          'history-ack',
          receipt.transportId,
          'History acknowledgment has no exact admitted native consumer.',
        )
      const owner = historicalOwners(snapshot).find(
        (value) =>
          value.kind === 'root' &&
          value.sessionId === receipt.sessionId &&
          value.snapshotToken === receipt.snapshotToken,
      )
      const revision = Option.getOrUndefined(decodeCursor(receipt.throughEventRevision))
      const prepared = snapshot.historyPrepares.find(
        (prepare) =>
          prepare.location === 'studio-cache' &&
          prepare.snapshotId === receipt.snapshotId &&
          prepare.fileHash === receipt.fileHash &&
          prepare.owners.some(
            (entry) =>
              entry.consumerId === `studio:${receipt.sessionId}` &&
              entry.sessionId === receipt.sessionId &&
              entry.snapshotToken === receipt.snapshotToken &&
              entry.ownerGeneration === (owner?.generation ?? 0) &&
              entry.throughEventRevision === revision,
          ),
      )
      if (
        receipt.kind !== 'studio' ||
        receipt.durability !== 'admitted-cache' ||
        !owner?.snapshotToken ||
        owner.snapshotToken !== receipt.snapshotToken ||
        !receipt.snapshotId ||
        revision === undefined ||
        revision > snapshot.eventRevision ||
        !prepared
      )
        return yield* failure(
          'history-ack',
          receipt.transportId,
          'History acknowledgment does not identify the exact committed native owner snapshot.',
        )
      // Revisions are transport-wide. The consumer/session key confines this receipt
      // even when another root supplied the last event before its watermark.
      yield* this.store.acknowledgeHistory(receipt.transportId, {
        consumerId: `${receipt.kind}:${receipt.sessionId}`,
        sessionId: receipt.sessionId,
        snapshotId: receipt.snapshotId,
        durability: receipt.durability,
        fileHash: prepared.fileHash,
        snapshotToken: owner.snapshotToken,
        ownerGeneration: owner.generation ?? 0,
        throughEventRevision: revision,
      })
      this.seed(yield* this.store.readTransport(receipt.transportId))
    }.bind(this),
    (effect) => this.ownershipMutex.withPermits(1)(effect),
  )

  acknowledge(receipt: NativeRecoveryHistoryReceipt) {
    return runEffect(this.acknowledgeEffect(receipt))
  }

  readonly acknowledgeHistoryEffect = Effect.fnUntraced(
    function* (
      this: NativeAgentRecovery,
      receipt: NativeRecoveryHistoryReceipt,
      consumers: readonly NativeRecoveryConsumer[],
    ): Effect.fn.Return<void, NativeRecoveryError> {
      yield* this.acknowledgeEffect(receipt, consumers)
    }.bind(this),
  )

  readonly acknowledgeMainHistoryEffect = Effect.fnUntraced(
    function* (
      this: NativeAgentRecovery,
      ack: ConversationCheckpointAck,
    ): Effect.fn.Return<void, NativeRecoveryError> {
      if (!ack.nativeRecovery) return
      if (!ack.nativeRecoveryHash)
        return yield* failure(
          'history-ack',
          '',
          'Committed history requires the exact privately prepared file hash.',
        )
      yield* this.acknowledgePreparedProof({
        hash: ack.nativeRecoveryHash,
        savedAt: ack.savedAt,
        receipt: ack.nativeRecovery,
      })
    }.bind(this),
    (effect) => this.ownershipMutex.withPermits(1)(effect),
  )

  readonly authorizeRecoveryReceiptEffect = Effect.fnUntraced(
    function* (
      this: NativeAgentRecovery,
      candidate: ConversationRecoveryProof,
      admissions: readonly ConversationProjectionAdmission[] = [],
    ): Effect.fn.Return<ConversationRecoveryProof | null, NativeRecoveryError> {
      if (!this.store) return null
      const proof = yield* validateConversationRecoveryProof(
        'native-history-candidate',
        candidate,
      ).pipe(Effect.catch(() => Effect.succeed(null)))
      if (!proof) return null
      const ownedAdmissions = yield* Effect.try({
        try: () => copyJson(admissions),
        catch: () => undefined,
      }).pipe(
        Effect.flatMap((value) =>
          Schema.decodeUnknownEffect(Schema.Array(projectionAdmissionSchema), {
            onExcessProperty: 'error',
          })(value),
        ),
        Effect.catch(() => Effect.succeed(null)),
      )
      if (!ownedAdmissions) return null
      yield* this.flushEffect()
      const admitted: ConversationRecoveryProof['receipt']['owners'] = []
      const prepares = new Map<string, NativeRecoveryHistoryPreparedOwner[]>()
      for (const receipt of proof.receipt.owners) {
        const cursors: [string, (typeof receipt.nativeRecovery)[string]][] = []
        for (const [id, cursor] of Object.entries(receipt.nativeRecovery)) {
          const snapshot = yield* this.store
            .readTransport(id)
            .pipe(
              Effect.catch((error) =>
                Predicate.isObject(error.cause) && error.cause.code === 'ENOENT'
                  ? Effect.succeed(undefined)
                  : Effect.fail(error),
              ),
            )
          if (
            !snapshot ||
            snapshot.transport.provider !== receipt.provider ||
            !matchingOwner(
              snapshot,
              {
                kind: 'main',
                sessionId: receipt.sessionId,
                profileId: receipt.profileId,
                workspace: receipt.workspace,
                remoteId: receipt.remoteId,
              },
              cursor,
            ) ||
            cursor.appliedRevision > snapshot.eventRevision
          )
            continue
          const progress = Math.max(
            this.deliveredRevision(
              id,
              receipt.sessionId,
              cursor.snapshotToken,
              cursor.ownerGeneration,
            ),
            this.validatedMainCaches.get(
              this.deliveryKey(id, receipt.sessionId, cursor.snapshotToken, cursor.ownerGeneration),
            ) ?? 0,
          )
          const privateAck = privateAckRevision(
            snapshot,
            `main:${receipt.sessionId}`,
            receipt.sessionId,
            cursor.snapshotToken,
            cursor.ownerGeneration,
          )
          const token = this.deliveryTokens.get(
            this.deliveryKey(id, receipt.sessionId, cursor.snapshotToken, cursor.ownerGeneration),
          )
          const projected =
            token !== undefined &&
            ownedAdmissions.some(
              (admission) =>
                admission.sessionId === receipt.sessionId &&
                admission.transportId === id &&
                admission.appliedRevision === cursor.appliedRevision &&
                admission.snapshotToken === cursor.snapshotToken &&
                admission.ownerGeneration === cursor.ownerGeneration &&
                admission.deliveryToken === token,
            )
          const authority =
            projected && cursor.appliedRevision <= progress
              ? 'native-delivery'
              : cursor.appliedRevision <= privateAck &&
                  this.provenBaseline(
                    receipt,
                    id,
                    cursor,
                    projected ? undefined : { hash: proof.hash, savedAt: proof.savedAt },
                  )
                ? 'private-ack'
                : undefined
          if (!authority) continue
          cursors.push([id, cursor])
          const prepared = prepares.get(id) ?? []
          prepared.push({
            consumerId: `main:${receipt.sessionId}`,
            sessionId: receipt.sessionId,
            snapshotToken: cursor.snapshotToken,
            ownerGeneration: cursor.ownerGeneration,
            throughEventRevision: cursor.appliedRevision,
            authority,
          })
          prepares.set(id, prepared)
        }
        if (cursors.length)
          admitted.push({ ...receipt, nativeRecovery: Object.fromEntries(cursors) })
      }
      if (!admitted.length) return null
      for (const [id, owners] of prepares) {
        yield* this.store.prepareHistory(id, {
          location: 'native-file',
          snapshotId: proof.receipt.snapshotId,
          fileHash: proof.hash,
          owners,
        })
        this.seed(yield* this.store.readTransport(id))
      }
      return {
        hash: proof.hash,
        savedAt: proof.savedAt,
        receipt: { snapshotId: proof.receipt.snapshotId, owners: admitted },
      }
    }.bind(this),
    (effect) => this.ownershipMutex.withPermits(1)(effect),
  )

  private readonly acknowledgePreparedProof = Effect.fnUntraced(
    function* (
      this: NativeAgentRecovery,
      candidate: ConversationRecoveryProof,
    ): Effect.fn.Return<void, NativeRecoveryError> {
      if (!this.store)
        return yield* failure('history-ack', '', 'Native recovery storage is unavailable.')
      const proof = yield* validateConversationRecoveryProof(
        'native-history-proof',
        candidate,
      ).pipe(
        Effect.mapError((cause) =>
          failure('history-ack', '', 'Committed history proof is invalid.', cause),
        ),
      )
      yield* this.flushEffect()
      const planned: { id: string; ack: NativeRecoveryHistoryAck }[] = []
      for (const receipt of proof.receipt.owners)
        for (const [id, cursor] of Object.entries(receipt.nativeRecovery)) {
          const snapshot = yield* this.store.readTransport(id)
          if (
            snapshot.transport.provider !== receipt.provider ||
            !matchingOwner(
              snapshot,
              {
                kind: 'main',
                sessionId: receipt.sessionId,
                profileId: receipt.profileId,
                workspace: receipt.workspace,
                remoteId: receipt.remoteId,
              },
              cursor,
            ) ||
            cursor.appliedRevision > snapshot.eventRevision
          )
            return yield* failure(
              'history-ack',
              id,
              'Committed history does not identify an exact historically registered native owner.',
            )
          const ack: NativeRecoveryHistoryAck = {
            consumerId: `main:${receipt.sessionId}`,
            sessionId: receipt.sessionId,
            snapshotId: proof.receipt.snapshotId,
            durability: 'native',
            fileHash: proof.hash,
            snapshotToken: cursor.snapshotToken,
            ownerGeneration: cursor.ownerGeneration,
            throughEventRevision: cursor.appliedRevision,
          }
          if (!matchingHistoryPrepare(snapshot, ack))
            return yield* failure(
              'history-ack',
              id,
              'Committed history has no matching private prepared file claim.',
            )
          planned.push({ id, ack })
        }
      for (const receipt of planned) {
        yield* this.store.acknowledgeHistory(receipt.id, receipt.ack)
        this.seed(yield* this.store.readTransport(receipt.id))
      }
      this.validatedBaselines.delete(proof.hash)
      this.validatedBaselines.set(proof.hash, proof)
      while (this.validatedBaselines.size > 2)
        this.validatedBaselines.delete(this.validatedBaselines.keys().next().value!)
    }.bind(this),
  )

  readonly acknowledgeRecoveredHistoryProofEffect = Effect.fnUntraced(
    function* (
      this: NativeAgentRecovery,
      proof: ConversationRecoveryProof,
    ): Effect.fn.Return<void, NativeRecoveryError> {
      yield* this.acknowledgePreparedProof(proof)
    }.bind(this),
    (effect) => this.ownershipMutex.withPermits(1)(effect),
  )

  readonly prepareRecoveryCacheEffect = Effect.fnUntraced(
    function* (
      this: NativeAgentRecovery,
      input: {
        snapshotId: string
        hash: string
        savedAt: number
        projectionAdmissions: readonly ConversationProjectionAdmission[]
        membershipAdmissions?: readonly ConversationProjectionAdmission[]
      },
    ): Effect.fn.Return<void, NativeRecoveryError> {
      const request = yield* Effect.try({
        try: () => copyJson(input),
        catch: (cause) => failure('cache-prepare', '', 'Main cache preparation is invalid.', cause),
      }).pipe(
        Effect.flatMap((value) =>
          Schema.decodeUnknownEffect(recoveryCachePrepareSchema, {
            onExcessProperty: 'error',
          })(value).pipe(
            Effect.mapError((cause) =>
              failure('cache-prepare', '', 'Main cache preparation is invalid.', cause),
            ),
          ),
        ),
      )
      if (!request.projectionAdmissions.length && !request.membershipAdmissions?.length) return
      if (!this.store)
        return yield* failure('cache-prepare', '', 'Native recovery storage is unavailable.')
      yield* this.flushEffect()
      const planned = new Map<string, NativeRecoveryHistoryPreparedOwner[]>()
      const roles = new Map<string, { absent: boolean; revision: number }>()
      const entries = [
        ...request.projectionAdmissions.map((admission) => ({ admission, absent: false })),
        ...(request.membershipAdmissions ?? []).map((admission) => ({ admission, absent: true })),
      ]
      for (const { admission, absent } of entries) {
        const snapshot = yield* this.store.readTransport(admission.transportId)
        const owner = historicalOwners(snapshot).find(
          (owner) =>
            owner.kind === 'root' &&
            owner.sessionId === admission.sessionId &&
            owner.snapshotToken === admission.snapshotToken &&
            (owner.generation ?? 0) === admission.ownerGeneration,
        )
        if (
          !owner ||
          admission.appliedRevision > snapshot.eventRevision ||
          !(
            this.projectionAdmitted(
              [admission],
              admission.transportId,
              admission.sessionId,
              admission,
            ) ||
            (absent && this.membershipAdmitted(admission))
          )
        )
          return yield* failure(
            'cache-prepare',
            admission.transportId,
            'Main cache preparation has no exact privately admitted native projection.',
          )
        const key = this.deliveryKey(
          admission.transportId,
          admission.sessionId,
          admission.snapshotToken,
          admission.ownerGeneration,
        )
        const priorRole = roles.get(key)
        if (
          priorRole &&
          (priorRole.absent !== absent || priorRole.revision !== admission.appliedRevision)
        )
          return yield* failure(
            'cache-prepare',
            admission.transportId,
            'Main cache preparation gives one native owner conflicting membership or cursor claims.',
          )
        roles.set(key, { absent, revision: admission.appliedRevision })
        const progress = Math.max(
          this.deliveredRevision(
            admission.transportId,
            admission.sessionId,
            admission.snapshotToken,
            admission.ownerGeneration,
          ),
          this.validatedMainCaches.get(key) ?? 0,
        )
        const scope: ConversationRecoveryProof['receipt']['owners'][number] = {
          sessionId: admission.sessionId,
          provider: snapshot.transport.provider,
          profileId: snapshot.transport.machine.profileId,
          workspace: owner.workspace,
          remoteId: owner.nativeThreadId ?? owner.nativeSessionId ?? '',
          nativeRecovery: {},
        }
        const nativeBaseline =
          admission.appliedRevision <=
            privateAckRevision(
              snapshot,
              `main:${admission.sessionId}`,
              admission.sessionId,
              admission.snapshotToken,
              admission.ownerGeneration,
            ) && this.provenBaseline(scope, admission.transportId, admission)
        if (
          admission.appliedRevision > progress &&
          !nativeBaseline &&
          !(absent && this.membershipAdmitted(admission))
        )
          return yield* failure(
            'cache-prepare',
            admission.transportId,
            'Main cache preparation exceeds the actual delivered or hash-proven projection.',
          )
        const owners = planned.get(admission.transportId) ?? []
        if (
          !owners.some(
            (entry) =>
              entry.sessionId === admission.sessionId &&
              entry.snapshotToken === admission.snapshotToken &&
              entry.ownerGeneration === admission.ownerGeneration &&
              entry.throughEventRevision === admission.appliedRevision,
          )
        )
          owners.push({
            consumerId: `main-cache:${admission.sessionId}`,
            sessionId: admission.sessionId,
            snapshotToken: admission.snapshotToken,
            ownerGeneration: admission.ownerGeneration,
            throughEventRevision: admission.appliedRevision,
            authority: 'native-delivery',
            ...(absent ? { absent: true as const } : {}),
          })
        planned.set(admission.transportId, owners)
      }
      // Validate the entire packet before committing any private preparation.
      for (const [id, owners] of planned) {
        yield* this.store.prepareHistory(id, {
          location: 'main-cache',
          snapshotId: request.snapshotId,
          fileHash: request.hash,
          savedAt: request.savedAt,
          owners,
        })
        this.seed(yield* this.store.readTransport(id))
      }
    }.bind(this),
    (effect) => this.ownershipMutex.withPermits(1)(effect),
  )

  readonly attestRecoveryCacheEffect = Effect.fnUntraced(
    function* (
      this: NativeAgentRecovery,
      input: { hash: string },
    ): Effect.fn.Return<
      {
        projectionAdmissions: ConversationProjectionAdmission[]
        membershipAdmissions?: ConversationProjectionAdmission[]
        savedAt?: number
      },
      NativeRecoveryError
    > {
      const request = yield* Effect.try({
        try: () => copyJson(input),
        catch: (cause) => failure('cache-attest', '', 'Main cache attestation is invalid.', cause),
      }).pipe(
        Effect.flatMap((value) =>
          Schema.decodeUnknownEffect(recoveryCacheAttestSchema, {
            onExcessProperty: 'error',
          })(value).pipe(
            Effect.mapError((cause) =>
              failure('cache-attest', '', 'Main cache attestation is invalid.', cause),
            ),
          ),
        ),
      )
      if (!this.store) return { projectionAdmissions: [] }
      const snapshots = yield* this.store.listTransports()
      const matching: {
        snapshot: NativeRecoverySnapshot
        prepare: NativeRecoveryHistoryPrepare
        claims: NativeRecoveryHistoryPreparedOwner[]
      }[] = []
      const clocks = new Set<number | undefined>()
      for (const snapshot of snapshots) {
        const registered = historicalOwners(snapshot)
        for (const prepare of snapshot.historyPrepares) {
          if (prepare.location !== 'main-cache' || prepare.fileHash !== request.hash) continue
          const claims = prepare.owners.filter(
            (claim) =>
              claim.consumerId === `main-cache:${claim.sessionId}` &&
              claim.throughEventRevision <= snapshot.eventRevision &&
              registered.some(
                (owner) =>
                  owner.kind === 'root' &&
                  owner.sessionId === claim.sessionId &&
                  owner.snapshotToken === claim.snapshotToken &&
                  (owner.generation ?? 0) === claim.ownerGeneration,
              ),
          )
          if (!claims.length) continue
          clocks.add(prepare.savedAt)
          matching.push({ snapshot, prepare, claims })
        }
      }
      // Identical bytes retain projection proof. Conflicting prewrite clocks cannot
      // establish which attempted checkpoint's clock actually reached the browser.
      const admitted = new Map<string, ConversationProjectionAdmission>()
      const memberships = new Map<string, ConversationProjectionAdmission>()
      const hashClaims = new Map<string, number>()
      for (const { snapshot, claims } of matching) {
        for (const claim of claims) {
          const key = this.deliveryKey(
            snapshot.transport.id,
            claim.sessionId,
            claim.snapshotToken,
            claim.ownerGeneration,
          )
          if (claim.absent) {
            const prior = memberships.get(key)
            if (prior && prior.appliedRevision >= claim.throughEventRevision) continue
            const membershipKey = JSON.stringify([request.hash, key, claim.throughEventRevision])
            let deliveryToken = this.absentMembershipKeys.get(membershipKey)
            if (!deliveryToken) {
              deliveryToken = `membership:${randomUUID()}`
              this.absentMembershipKeys.set(membershipKey, deliveryToken)
            }
            const membership: ConversationProjectionAdmission = {
              sessionId: claim.sessionId,
              transportId: snapshot.transport.id,
              appliedRevision: claim.throughEventRevision,
              snapshotToken: claim.snapshotToken,
              ownerGeneration: claim.ownerGeneration,
              deliveryToken,
            }
            this.absentMemberships.set(membership.deliveryToken, Object.freeze({ ...membership }))
            memberships.set(key, membership)
            continue
          }
          const prior = admitted.get(key)
          if (prior && prior.appliedRevision >= claim.throughEventRevision) continue
          this.validatedMainCaches.set(
            key,
            Math.max(this.validatedMainCaches.get(key) ?? 0, claim.throughEventRevision),
          )
          hashClaims.set(key, claim.throughEventRevision)
          admitted.set(key, {
            sessionId: claim.sessionId,
            transportId: snapshot.transport.id,
            appliedRevision: claim.throughEventRevision,
            snapshotToken: claim.snapshotToken,
            ownerGeneration: claim.ownerGeneration,
            deliveryToken: this.deliveryToken(
              snapshot.transport.id,
              claim.sessionId,
              claim.snapshotToken,
              claim.ownerGeneration,
            ),
          })
        }
        this.seed(snapshot)
      }
      this.attestedMainCacheClaims.set(request.hash, hashClaims)
      const savedAt = clocks.size === 1 ? clocks.values().next().value : undefined
      return {
        projectionAdmissions: [...admitted.values()],
        ...(memberships.size ? { membershipAdmissions: [...memberships.values()] } : {}),
        ...(savedAt === undefined ? {} : { savedAt }),
      }
    }.bind(this),
    (effect) => this.ownershipMutex.withPermits(1)(effect),
  )

  /** Only the hash-selected native history load path may bootstrap document capabilities. */
  readonly admitLoadedHistoryProofEffect = Effect.fnUntraced(
    function* (
      this: NativeAgentRecovery,
      candidate: ConversationRecoveryProof,
    ): Effect.fn.Return<ConversationProjectionAdmission[], NativeRecoveryError> {
      const proof = yield* validateConversationRecoveryProof(
        'native-history-loaded',
        candidate,
      ).pipe(
        Effect.mapError((cause) =>
          failure('history-load', '', 'Loaded history proof is invalid.', cause),
        ),
      )
      yield* this.acknowledgePreparedProof(proof)
      const admissions: ConversationProjectionAdmission[] = []
      for (const owner of proof.receipt.owners)
        for (const [transportId, cursor] of Object.entries(owner.nativeRecovery))
          admissions.push({
            sessionId: owner.sessionId,
            transportId,
            appliedRevision: cursor.appliedRevision,
            snapshotToken: cursor.snapshotToken,
            ownerGeneration: cursor.ownerGeneration,
            deliveryToken: this.deliveryToken(
              transportId,
              owner.sessionId,
              cursor.snapshotToken,
              cursor.ownerGeneration,
            ),
          })
      return admissions
    }.bind(this),
    (effect) => this.ownershipMutex.withPermits(1)(effect),
  )

  private schedule() {
    if (this.scheduled) return
    this.scheduled = true
    queueMicrotask(() => {
      void runEffect(this.flushEffect())
        .catch((cause: unknown) => {
          const error =
            cause instanceof NativeRecoveryError
              ? cause
              : failure('events', '', 'Native event admission failed.', cause)
          this.failed = error
          this.onFailure(error)
        })
        .finally(() => {
          this.scheduled = false
          if (this.queue.length && !this.failed) this.schedule()
        })
    })
  }
}
