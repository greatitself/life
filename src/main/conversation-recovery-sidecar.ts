import { open, readFile } from 'node:fs/promises'
import { dirname } from 'node:path'
import { Cause, Effect, Predicate, Schema } from 'effect'
import type { ConversationNativeRecoveryReceipt } from '../shared/conversations'
import {
  atomicSnapshot,
  PersistenceError,
  persistenceError,
  persistenceIO,
} from './persistence-effects'

const natural = Schema.Natural.check(Schema.isLessThanOrEqualTo(Number.MAX_SAFE_INTEGER))
const cursorSchema = Schema.Struct({
  appliedRevision: natural,
  snapshotToken: Schema.NonEmptyString,
  ownerGeneration: natural,
})
const ownerSchema = Schema.Struct({
  sessionId: Schema.NonEmptyString,
  provider: Schema.Literals(['codex', 'claude']),
  profileId: Schema.NonEmptyString,
  workspace: Schema.NonEmptyString.check(Schema.isPattern(/^\//)),
  remoteId: Schema.NonEmptyString,
  nativeRecovery: Schema.Record(Schema.String, cursorSchema).check(
    Schema.isPropertyNames(Schema.NonEmptyString),
    Schema.isMinProperties(1),
  ),
})
const receiptSchema = Schema.Struct({
  snapshotId: Schema.NonEmptyString,
  owners: Schema.mutable(
    Schema.Array(ownerSchema).check(
      Schema.makeFilter(
        (owners) => new Set(owners.map((owner) => owner.sessionId)).size === owners.length,
        { expected: 'unique local recovery session identities' },
      ),
    ),
  ),
})
const proofSchema = Schema.Struct({
  hash: Schema.String.check(Schema.isPattern(/^[a-f0-9]{64}$/)),
  savedAt: natural,
  receipt: receiptSchema,
})
const sidecarSchema = Schema.Struct({
  format: Schema.Literal('life-conversation-recovery'),
  version: Schema.Literal(1),
  receipts: Schema.Array(proofSchema).check(
    Schema.isMaxLength(2),
    Schema.makeFilter(
      (proofs) => new Set(proofs.map((proof) => proof.hash)).size === proofs.length,
      { expected: 'unique conversation snapshot hashes' },
    ),
  ),
})
const decodeProof = Schema.decodeUnknownEffect(proofSchema, { onExcessProperty: 'error' })
const decodeSidecar = Schema.decodeUnknownEffect(Schema.fromJsonString(sidecarSchema), {
  onExcessProperty: 'error',
})

export interface ConversationRecoveryProof {
  readonly hash: string
  readonly savedAt: number
  readonly receipt: ConversationNativeRecoveryReceipt
}

export interface ConversationRecoverySidecar {
  readonly format: 'life-conversation-recovery'
  readonly version: 1
  readonly receipts: readonly ConversationRecoveryProof[]
}

/** Select only against the exact serialized history hash computed by the writer. */
export function selectConversationRecoveryProof(
  sidecar: ConversationRecoverySidecar | null,
  hash: string,
  savedAt: number,
): ConversationRecoveryProof | undefined {
  return sidecar?.receipts.find((proof) => proof.hash === hash && proof.savedAt === savedAt)
}

/** Validate only the small proof tree, before Schema can observe accessors. */
function assertOwnJson(value: unknown, ancestors = new Set<object>()): void {
  if (!Predicate.isObjectOrArray(value)) {
    if (
      value === null ||
      Predicate.isString(value) ||
      Predicate.isBoolean(value) ||
      (Predicate.isNumber(value) && Number.isFinite(value))
    )
      return
    throw new Error('Conversation recovery proofs must contain plain JSON data.')
  }
  const array = Array.isArray(value)
  const prototype = Object.getPrototypeOf(value)
  if (
    (array
      ? prototype !== Array.prototype
      : prototype !== Object.prototype && prototype !== null) ||
    ancestors.has(value)
  )
    throw new Error('Conversation recovery proofs must contain acyclic plain JSON data.')
  ancestors.add(value)
  try {
    for (const key of Reflect.ownKeys(value)) {
      if (array && key === 'length') continue
      const descriptor = Object.getOwnPropertyDescriptor(value, key)
      if (
        !Predicate.isString(key) ||
        !descriptor ||
        !('value' in descriptor) ||
        !descriptor.enumerable
      )
        throw new Error('Conversation recovery proofs must contain own data properties.')
      if (array && (!/^(0|[1-9]\d*)$/.test(key) || Number(key) >= value.length))
        throw new Error('Conversation recovery proof arrays cannot have additional properties.')
      assertOwnJson(descriptor.value, ancestors)
    }
    if (array && Object.keys(value).length !== value.length)
      throw new Error('Conversation recovery proof arrays cannot contain missing entries.')
  } finally {
    ancestors.delete(value)
  }
}

export const validateConversationRecoveryProof = Effect.fnUntraced(function* (
  path: string,
  value: unknown,
) {
  yield* Effect.try({
    try: () => assertOwnJson(value),
    catch: (cause) => persistenceError('validate', path, cause),
  })
  return yield* decodeProof(value).pipe(
    Effect.mapError((cause) => persistenceError('validate', path, cause)),
  )
})

/** This file records native-admitted claims; it never authorizes imported history claims. */
export class ConversationRecoverySidecarStore {
  constructor(readonly path: string) {}

  readonly loadEffect = Effect.fn('ConversationRecoverySidecar.load')(function* (
    this: ConversationRecoverySidecarStore,
  ): Effect.fn.Return<ConversationRecoverySidecar | null, PersistenceError> {
    const serialized = yield* persistenceIO('read', this.path, () =>
      readFile(this.path, 'utf8'),
    ).pipe(
      Effect.catchTag('PersistenceError', (error) =>
        (error.cause as NodeJS.ErrnoException)?.code === 'ENOENT'
          ? Effect.succeed(null)
          : Effect.fail(error),
      ),
    )
    if (serialized === null) return null
    return yield* decodeSidecar(serialized).pipe(
      Effect.mapError((cause) => persistenceError('validate', this.path, cause)),
    )
  })

  /**
   * The writer supplies the previously hash-validated proof and a newly native-
   * admitted candidate. Rereading first prevents damaged sidecars being replaced.
   * Keep the old proof until the separately atomic history replacement completes.
   */
  readonly stageEffect = Effect.fn('ConversationRecoverySidecar.stage')(
    function* (
      this: ConversationRecoverySidecarStore,
      candidate: ConversationRecoveryProof,
      previous?: ConversationRecoveryProof,
    ): Effect.fn.Return<ConversationRecoverySidecar, PersistenceError> {
      yield* this.loadEffect()
      const next = yield* validateConversationRecoveryProof(this.path, candidate)
      const old = previous
        ? yield* validateConversationRecoveryProof(this.path, previous)
        : undefined
      if (old?.hash === next.hash && old.savedAt !== next.savedAt)
        return yield* persistenceError(
          'validate',
          this.path,
          new Error('The same conversation hash cannot identify different saved timestamps.'),
        )
      const sidecar: ConversationRecoverySidecar = {
        format: 'life-conversation-recovery',
        version: 1,
        receipts: old && old.hash !== next.hash ? [old, next] : [next],
      }
      const serialized = yield* Effect.try({
        try: () => JSON.stringify(sidecar),
        catch: (cause) => persistenceError('serialize', this.path, cause),
      })
      yield* atomicSnapshot(this.path, serialized)
      const directory = dirname(this.path)
      yield* Effect.scoped(
        Effect.gen(function* () {
          const file = yield* Effect.acquireRelease(
            persistenceIO('open-directory', directory, () => open(directory, 'r')),
            (file) =>
              persistenceIO('close-directory', directory, () => file.close()).pipe(Effect.orDie),
          )
          yield* persistenceIO('sync-directory', directory, () => file.sync())
        }),
      )
      return sidecar
    },
    (effect) => {
      return effect.pipe(
        Effect.catchCause((cause) => {
          if (Cause.hasInterruptsOnly(cause)) return Effect.failCause(cause)
          const error = Cause.squash(cause)
          return Effect.fail(
            error instanceof PersistenceError
              ? error
              : persistenceError('sidecar-resource', this.path, error),
          )
        }),
      )
    },
  )
}
