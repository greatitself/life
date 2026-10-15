import { Effect, Predicate, Schema } from 'effect'
import { hashSerializedConversationCacheEffect } from './conversation-cache-hash'
import { getConversationSourceRaw } from './conversation-source'
import { readThreads, type Thread } from './state'
import type { ConversationProjectionAdmission } from '../shared/conversations'

export const CONVERSATION_HISTORY_KEY = 'relay.threads.v1'
export const conversationCheckpointKey = 'life.conversation-checkpoint.v1'
export type HistoryStorage = Pick<Storage, 'getItem' | 'setItem'>
export interface CachedHistory {
  threads: Thread[]
  savedAt?: number
}
export interface CachedConversationRecovery {
  readonly hash: string
  readonly rows: readonly Thread[]
}
export interface CachedConversationAttestation extends CachedConversationRecovery {
  readonly projectionAdmissions: readonly ConversationProjectionAdmission[]
  readonly membershipAdmissions?: readonly ConversationProjectionAdmission[]
  readonly savedAt?: number
}
export type NativeRecoveryCacheAttestation = (input: { hash: string }) => Promise<{
  projectionAdmissions: readonly ConversationProjectionAdmission[]
  membershipAdmissions?: readonly ConversationProjectionAdmission[]
  savedAt?: number
}>
interface RowCapture {
  fields: Map<PropertyKey, unknown>
  raw: Record<string, unknown>
  rawFields: Map<PropertyKey, unknown>
  graph: readonly GraphCapture[]
  recovery?: {
    value: object
    cursors: Map<string, { value: object; fields: Map<PropertyKey, unknown> }>
  }
}
interface GraphCapture {
  value: object
  prototype: object | null
  keys: readonly string[]
  enumerable: readonly boolean[]
  fields: Map<PropertyKey, unknown>
}
interface CacheCapture {
  serialized: string
  threads: Thread[]
  rows: readonly Thread[]
  fields: Map<PropertyKey, unknown>
  rowCaptures: Map<Thread, RowCapture>
  proof?: Promise<CachedConversationRecovery | undefined>
  origin?: Readonly<{ hash: string }>
  attestedClock?: Readonly<{ hash: string; savedAt: number }>
}
const caches = new WeakMap<CachedHistory, CacheCapture>()
const rows = new WeakMap<Thread, { cache: CacheCapture; capture: RowCapture }>()
const rowFields = [
  'id',
  'profileId',
  'provider',
  'workspace',
  'workspaceUnknown',
  'remoteId',
  'messages',
  'nativeRecovery',
] as const
const markerSchema = Schema.Struct({
  savedAt: Schema.Number.check(
    Schema.isInt(),
    Schema.isGreaterThanOrEqualTo(0),
    Schema.isLessThanOrEqualTo(Number.MAX_SAFE_INTEGER),
  ),
  fingerprint: Schema.String,
})
const decodeMarker = Schema.decodeUnknownOption(markerSchema)
const admissionSchema = Schema.Struct({
  sessionId: Schema.NonEmptyString,
  transportId: Schema.NonEmptyString,
  appliedRevision: Schema.Int.check(
    Schema.isGreaterThan(0),
    Schema.isLessThanOrEqualTo(Number.MAX_SAFE_INTEGER),
  ),
  snapshotToken: Schema.NonEmptyString,
  ownerGeneration: Schema.Int.check(
    Schema.isGreaterThanOrEqualTo(0),
    Schema.isLessThanOrEqualTo(Number.MAX_SAFE_INTEGER),
  ),
  deliveryToken: Schema.NonEmptyString,
})
const decodeAttestation = Schema.decodeUnknownEffect(
  Schema.Struct({
    projectionAdmissions: Schema.Array(admissionSchema),
    membershipAdmissions: Schema.optionalKey(Schema.Array(admissionSchema)),
    savedAt: Schema.optionalKey(markerSchema.fields.savedAt),
  }),
  { onExcessProperty: 'error' },
)

class ConversationCacheAttestationError extends Schema.TaggedError<ConversationCacheAttestationError>()(
  'ConversationCacheAttestationError',
  { cause: Schema.Defect() },
) {}

/** Detect partial data/metadata writes; this small marker grants no recovery authority. */
export function conversationCacheFingerprint(value: string): string {
  let first = 2166136261
  let second = 3335557771
  for (let index = 0; index < value.length; index++) {
    const character = value.charCodeAt(index)
    first = Math.imul(first ^ character, 16777619)
    second = Math.imul(second ^ character, 2246822519)
  }
  return `${value.length}:${first >>> 0}:${second >>> 0}`
}
function captureFields(value: object, keys: readonly PropertyKey[]): Map<PropertyKey, unknown> {
  return new Map(keys.map((key) => [key, Object.getOwnPropertyDescriptor(value, key)?.value]))
}
function matchesFields(value: object, fields: Map<PropertyKey, unknown>): boolean {
  for (const [key, prior] of fields) {
    const descriptor = Object.getOwnPropertyDescriptor(value, key)
    if (descriptor?.get || descriptor?.set || !Object.is(descriptor?.value, prior)) return false
  }
  return true
}
/** Bind parsed JSON identity without re-encoding large message bodies on the renderer. */
function captureGraph(...roots: object[]): readonly GraphCapture[] {
  const seen = new WeakSet<object>()
  const pending = [...roots]
  const graph: GraphCapture[] = []
  while (pending.length) {
    const value = pending.pop()!
    if (seen.has(value)) continue
    seen.add(value)
    // String properties include array length and non-enumerable additions.
    // Internal source symbols never become part of a cached JSON capability.
    const keys = Object.getOwnPropertyNames(value)
    const enumerable: boolean[] = []
    const fields = new Map<PropertyKey, unknown>()
    for (const key of keys) {
      const descriptor = Object.getOwnPropertyDescriptor(value, key)
      if (!descriptor || descriptor.get || descriptor.set)
        throw new Error('The cached JSON graph contains an accessor.')
      fields.set(key, descriptor.value)
      enumerable.push(descriptor.enumerable === true)
      if (Predicate.isObjectOrArray(descriptor.value)) pending.push(descriptor.value)
    }
    graph.push({ value, prototype: Object.getPrototypeOf(value), keys, enumerable, fields })
  }
  return graph
}
function matchesGraph(graph: readonly GraphCapture[]): boolean {
  for (const { value, prototype, keys, enumerable, fields } of graph) {
    const current = Object.getOwnPropertyNames(value)
    if (
      Object.getPrototypeOf(value) !== prototype ||
      current.length !== keys.length ||
      current.some((key, index) => key !== keys[index]) ||
      current.some(
        (key, index) =>
          Object.getOwnPropertyDescriptor(value, key)?.enumerable !== enumerable[index],
      ) ||
      !matchesFields(value, fields)
    )
      return false
  }
  return true
}
function matchesRow(row: Thread, capture: RowCapture): boolean {
  if (
    !Object.is(getConversationSourceRaw(row), capture.raw) ||
    !matchesFields(row, capture.fields) ||
    !matchesFields(capture.raw, capture.rawFields) ||
    !matchesGraph(capture.graph)
  )
    return false
  if (!capture.recovery) return true
  const { value, cursors } = capture.recovery
  if (Object.keys(value).length !== cursors.size) return false
  for (const [transportId, cursor] of cursors) {
    const descriptor = Object.getOwnPropertyDescriptor(value, transportId)
    if (
      descriptor?.get ||
      descriptor?.set ||
      descriptor?.value !== cursor.value ||
      Reflect.ownKeys(cursor.value).length !== cursor.fields.size ||
      !matchesFields(cursor.value, cursor.fields)
    )
      return false
  }
  return true
}
function matchesCache(cache: CachedHistory, capture: CacheCapture): boolean {
  if (!matchesFields(cache, capture.fields) || capture.threads.length !== capture.rows.length)
    return false
  return capture.rows.every((row, index) => {
    const descriptor = Object.getOwnPropertyDescriptor(capture.threads, String(index))
    const rowCapture = capture.rowCaptures.get(row)
    return (
      !descriptor?.get &&
      !descriptor?.set &&
      descriptor?.value === row &&
      !!rowCapture &&
      matchesRow(row, rowCapture)
    )
  })
}

/** Only the completed Storage read attaches an origin; JSON imports never call a marker API. */
export function readCachedConversationHistory(storage?: HistoryStorage): CachedHistory {
  try {
    const cache = storage ?? localStorage
    const actual = cache.getItem(CONVERSATION_HISTORY_KEY)
    const serialized = actual ?? '[]'
    const parsed: unknown = JSON.parse(serialized)
    const threads = readThreads(parsed)
    let savedAt: number | undefined
    try {
      const marker = decodeMarker(JSON.parse(cache.getItem(conversationCheckpointKey) || 'null'))
      if (
        marker._tag === 'Some' &&
        marker.value.fingerprint === conversationCacheFingerprint(serialized)
      )
        savedAt = marker.value.savedAt
    } catch {
      // A damaged optional marker must not hide valid recoverable text.
    }
    const result: CachedHistory = { threads, ...(savedAt !== undefined ? { savedAt } : {}) }
    if (actual === null || !Array.isArray(parsed) || parsed.length !== threads.length) return result
    const capture: CacheCapture = {
      serialized,
      threads,
      rows: Object.freeze([...threads]),
      fields: captureFields(result, ['threads', 'savedAt']),
      rowCaptures: new Map(),
    }
    for (const row of threads) {
      const raw = getConversationSourceRaw(row)
      if (!raw || !Predicate.isObject(raw) || Array.isArray(raw)) return result
      const recovery = row.nativeRecovery
      const rowCapture: RowCapture = {
        fields: captureFields(row, rowFields),
        raw,
        rawFields: captureFields(raw, rowFields),
        graph: captureGraph(row, raw),
        ...(recovery
          ? {
              recovery: {
                value: recovery,
                cursors: new Map(
                  Object.entries(recovery).map(([transportId, cursor]) => [
                    transportId,
                    { value: cursor, fields: captureFields(cursor, Reflect.ownKeys(cursor)) },
                  ]),
                ),
              },
            }
          : {}),
      }
      capture.rowCaptures.set(row, rowCapture)
    }
    caches.set(result, capture)
    for (const [row, rowCapture] of capture.rowCaptures)
      rows.set(row, { cache: capture, capture: rowCapture })
    return result
  } catch {
    return { threads: [] }
  }
}

/** Hash the exact string returned by Storage, never a cloned or re-encoded projection. */
export async function getCachedConversationHistoryRecovery(
  cache: CachedHistory,
): Promise<CachedConversationRecovery | undefined> {
  const capture = caches.get(cache)
  if (!capture || !matchesCache(cache, capture)) return
  capture.proof ??= Effect.runPromise(hashSerializedConversationCacheEffect(capture.serialized))
    .then((hash) => {
      if (!matchesCache(cache, capture)) return
      capture.origin = Object.freeze({ hash })
      return Object.freeze({ hash, rows: capture.rows })
    })
    .catch(() => undefined)
  const proof = await capture.proof
  return proof && matchesCache(cache, capture) ? proof : undefined
}

export function getCachedConversationRowRecovery(
  row: Thread,
): Readonly<{ hash: string }> | undefined {
  const loaded = rows.get(row)
  return loaded?.cache.origin && matchesRow(row, loaded.capture) ? loaded.cache.origin : undefined
}

const attestCacheEffect = Effect.fnUntraced(function* (
  cache: CachedHistory,
  capture: CacheCapture,
  proof: CachedConversationRecovery,
  attest: NativeRecoveryCacheAttestation,
) {
  const response = yield* Effect.tryPromise({
    try: () => attest({ hash: proof.hash }),
    catch: (cause) => new ConversationCacheAttestationError({ cause }),
  }).pipe(
    Effect.flatMap((input) =>
      decodeAttestation(input).pipe(
        Effect.mapError((cause) => new ConversationCacheAttestationError({ cause })),
      ),
    ),
  )
  if (!matchesCache(cache, capture) || capture.origin?.hash !== proof.hash) return
  const rowIds = new Map<string, Thread>()
  const duplicates = new Set<string>()
  for (const row of proof.rows) {
    if (duplicates.has(row.id)) continue
    if (rowIds.has(row.id)) {
      rowIds.delete(row.id)
      duplicates.add(row.id)
    } else rowIds.set(row.id, row)
  }
  const membershipAdmissions = response.membershipAdmissions ?? []
  const exact =
    response.projectionAdmissions.length + membershipAdmissions.length > 0 &&
    response.projectionAdmissions.every((admission) => {
      const row = rowIds.get(admission.sessionId)
      const cursor = row?.nativeRecovery?.[admission.transportId]
      return (
        cursor &&
        cursor.appliedRevision === admission.appliedRevision &&
        cursor.snapshotToken === admission.snapshotToken &&
        cursor.ownerGeneration === admission.ownerGeneration
      )
    }) &&
    membershipAdmissions.every(
      (admission) => !rowIds.has(admission.sessionId) && !duplicates.has(admission.sessionId),
    )
  if (exact && response.savedAt !== undefined)
    capture.attestedClock = Object.freeze({ hash: proof.hash, savedAt: response.savedAt })
  return Object.freeze({
    ...proof,
    projectionAdmissions: response.projectionAdmissions,
    ...(membershipAdmissions.length ? { membershipAdmissions } : {}),
    ...(exact && response.savedAt !== undefined ? { savedAt: response.savedAt } : {}),
  })
})

/** Native preparation binds the original checkpoint clock to actual Storage bytes. */
export async function attestCachedConversationHistoryRecovery(
  cache: CachedHistory,
  attest: NativeRecoveryCacheAttestation,
): Promise<CachedConversationAttestation | undefined> {
  const capture = caches.get(cache)
  if (!capture) return
  const proof = await getCachedConversationHistoryRecovery(cache)
  if (!proof || !matchesCache(cache, capture)) return
  return Effect.runPromise(attestCacheEffect(cache, capture, proof, attest)).catch(() => undefined)
}

/** Private native clocks do not become raw cache properties or imported metadata. */
export function getEffectiveCachedConversationHistorySavedAt(
  cache: CachedHistory,
): number | undefined {
  const capture = caches.get(cache)
  const clock = capture?.attestedClock
  return capture && clock && capture.origin?.hash === clock.hash && matchesCache(cache, capture)
    ? clock.savedAt
    : cache.savedAt
}
