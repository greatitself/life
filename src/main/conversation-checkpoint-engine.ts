import { createHash } from 'node:crypto'
import { mkdir, open, readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { Array as EffectArray, Cause, Effect, Schema } from 'effect'
import type {
  ConversationCheckpointAck,
  ConversationHistorySnapshot,
  ConversationProjectionAdmission,
} from '../shared/conversations'
import { CONVERSATION_CHECKPOINT_BASE_CHANGED } from '../shared/conversations'
import { assertOrdinaryRecoveryStateEffect } from './native-recovery-platform'
import { conversationRecoveryReceipt } from './conversation-recovery-receipt'
import {
  ConversationRecoverySidecarStore,
  selectConversationRecoveryProof,
  validateConversationRecoveryProof,
  type ConversationRecoveryProof,
} from './conversation-recovery-sidecar'
import {
  atomicSnapshot,
  PersistenceError,
  persistenceError,
  persistenceIO,
} from './persistence-effects'

const identitySchema = Schema.Struct({
  id: Schema.NonEmptyString,
  profileId: Schema.String,
  provider: Schema.Literals(['codex', 'claude']),
})
const metadataSchema = Schema.StructWithRest(identitySchema, [
  Schema.Record(Schema.String, Schema.Unknown),
])
const threadSchema = Schema.StructWithRest(
  Schema.Struct({
    ...identitySchema.fields,
    id: Schema.String,
    messages: Schema.Array(Schema.Unknown),
  }),
  [Schema.Record(Schema.String, Schema.Unknown)],
)
const historySchema = Schema.Array(threadSchema)
const timestampSchema = Schema.Int.check(Schema.isGreaterThanOrEqualTo(0))
const snapshotSchema = Schema.Struct({
  version: Schema.Literals([1]),
  savedAt: timestampSchema,
  threads: historySchema,
})
const orderSchema = Schema.Array(Schema.NonEmptyString).check(Schema.isUnique())
const identifiedMessageSchema = Schema.StructWithRest(
  Schema.Struct({ id: Schema.NonEmptyString }),
  [Schema.Record(Schema.String, Schema.Unknown)],
)
const messageFieldSchema = Schema.Struct({
  id: Schema.NonEmptyString,
  set: Schema.Record(Schema.String, Schema.Unknown),
  remove: Schema.Array(Schema.String).check(Schema.isUnique()),
  append: Schema.optional(
    Schema.Record(
      Schema.String,
      Schema.Struct({
        baseLength: Schema.Int.check(Schema.isGreaterThanOrEqualTo(0)),
        value: Schema.NonEmptyString,
      }),
    ),
  ),
})
const checkpointSchema = Schema.Struct({
  version: Schema.Literals([1]),
  baseSavedAt: Schema.NullOr(timestampSchema),
  savedAt: timestampSchema,
  order: orderSchema,
  upserts: Schema.Array(
    Schema.Struct({
      thread: metadataSchema,
      messages: Schema.Union([
        Schema.Struct({ mode: Schema.Literals(['replace']), values: Schema.Array(Schema.Unknown) }),
        Schema.Struct({
          mode: Schema.Literals(['patch']),
          order: Schema.optional(orderSchema),
          upserts: Schema.Array(identifiedMessageSchema),
          fields: Schema.optional(Schema.Array(messageFieldSchema)),
        }),
      ]),
    }),
  ),
})
const decodeHistory = Schema.decodeUnknownEffect(historySchema)
const decodeSnapshot = Schema.decodeUnknownEffect(snapshotSchema)
const decodeCheckpoint = Schema.decodeUnknownEffect(checkpointSchema)
const decodeMessages = Schema.decodeUnknownEffect(Schema.Array(identifiedMessageSchema))
const decodeTimestamp = Schema.decodeUnknownEffect(timestampSchema)
const decodeJson = Schema.decodeUnknownEffect(Schema.fromJsonString(Schema.Unknown))
const projectionAdmissionsSchema = Schema.Array(
  Schema.Struct({
    sessionId: Schema.NonEmptyString,
    transportId: Schema.NonEmptyString,
    appliedRevision: Schema.Natural.check(Schema.isLessThanOrEqualTo(Number.MAX_SAFE_INTEGER)),
    snapshotToken: Schema.NonEmptyString,
    ownerGeneration: Schema.Natural.check(Schema.isLessThanOrEqualTo(Number.MAX_SAFE_INTEGER)),
    deliveryToken: Schema.NonEmptyString,
  }),
)
const decodeProjectionAdmissions = Schema.decodeUnknownEffect(projectionAdmissionsSchema)

export type ConversationHistoryPersistenceMode = 'native-protected' | 'ordinary' | 'read-only'

export interface ConversationCheckpointEngineOptions {
  persistenceMode?: ConversationHistoryPersistenceMode
  /** Only the private native ledger can admit a proposed recovery projection. */
  authorizeRecoveryReceipt?: (
    candidate: ConversationRecoveryProof,
    projectionAdmissions: readonly ConversationProjectionAdmission[],
  ) => Effect.Effect<ConversationRecoveryProof | null, unknown>
}

/** Runs entirely in the writer worker. Only a completed atomic replacement advances the base. */
export class ConversationCheckpointEngine {
  private readonly path: string
  private readonly recoverySidecar: ConversationRecoverySidecarStore
  private readonly persistenceMode: ConversationHistoryPersistenceMode
  private initialized = false
  private initializationError?: PersistenceError
  private snapshot: ConversationHistorySnapshot | null = null
  private encodedSnapshot?: string | Uint8Array<ArrayBuffer>
  private recoveryProof?: ConversationRecoveryProof
  private recoveryReceiptError?: PersistenceError
  private historyDirectorySynced = false

  constructor(
    private readonly directory: string,
    private readonly options: ConversationCheckpointEngineOptions = {},
  ) {
    this.path = join(directory, 'conversations.json')
    this.persistenceMode = options.persistenceMode ?? 'native-protected'
    this.recoverySidecar = new ConversationRecoverySidecarStore(
      join(directory, 'conversations.recovery-receipts.json'),
    )
  }

  private error(operation: string, message: string) {
    return new PersistenceError({ operation, path: this.path, message, cause: new Error(message) })
  }

  readonly loadEffect = Effect.fn('ConversationCheckpointEngine.load')(function* (
    this: ConversationCheckpointEngine,
  ) {
    // Explicit recovery reloads may admit an externally repaired original. A
    // save cannot clear this guard, and healthy acknowledged state stays cached.
    if (this.initializationError) this.initializationError = undefined
    yield* this.initializeEffect()
    return this.snapshot
  })

  readonly loadEncodedEffect = Effect.fn('ConversationCheckpointEngine.loadEncoded')(function* (
    this: ConversationCheckpointEngine,
  ) {
    const snapshot = yield* this.loadEffect()
    if (snapshot === null) return null
    // Keep just the current revision's serialization, reusing validated read or
    // commit JSON. Convert it once, then copy bytes so transfers preserve the cache.
    return yield* Effect.try({
      try: () => {
        const encoded =
          this.encodedSnapshot instanceof Uint8Array
            ? this.encodedSnapshot
            : new TextEncoder().encode(this.encodedSnapshot ?? JSON.stringify(snapshot))
        this.encodedSnapshot = encoded
        return encoded.slice().buffer
      },
      catch: (cause) => persistenceError('serialize', this.path, cause),
    })
  })

  readonly loadRecoveryReceiptEffect = Effect.fn(
    'ConversationCheckpointEngine.loadRecoveryReceipt',
  )(function* (this: ConversationCheckpointEngine) {
    const alreadyInitialized = this.initialized
    yield* this.loadEffect()
    if (this.persistenceMode !== 'native-protected') return null
    const proof = this.recoveryProof
    if (!proof) return null
    // First hydration reuses the actual bytes hashed during initialization.
    // Later reads recheck disk so external replacement cannot reuse a cached
    // private receipt with a different current file.
    if (alreadyInitialized) {
      const bytes = yield* persistenceIO('read', this.path, () => readFile(this.path))
      if (createHash('sha256').update(bytes).digest('hex') !== proof.hash) {
        this.invalidateCachedHistory()
        return null
      }
    }
    if (!this.historyDirectorySynced) yield* this.syncHistoryDirectoryEffect()
    return proof
  })

  readonly saveEffect = Effect.fn('ConversationCheckpointEngine.save')(function* (
    this: ConversationCheckpointEngine,
    threads: unknown[],
    savedAt: number,
    projectionAdmissions?: unknown,
  ) {
    if (this.persistenceMode === 'read-only')
      return yield* this.error(
        'recovery-platform',
        'Conversation history is read-only on this runtime. The original files were preserved.',
      )
    yield* decodeHistory(threads).pipe(
      Effect.mapError(() =>
        this.error(
          'validate',
          EffectArray.isArray(threads)
            ? 'Conversation history contains an invalid thread.'
            : 'Conversation history must be an array.',
        ),
      ),
    )
    yield* decodeTimestamp(savedAt).pipe(
      Effect.mapError(() =>
        this.error('validate', 'Conversation checkpoint has an invalid timestamp.'),
      ),
    )
    yield* this.initializeEffect()
    const admissions = yield* decodeProjectionAdmissions(projectionAdmissions ?? []).pipe(
      Effect.mapError((cause) => persistenceError('recovery-admission', this.path, cause)),
    )
    return yield* this.commitEffect(
      { ...this.snapshot, version: 1, savedAt, threads },
      false,
      admissions,
    )
  }, Effect.uninterruptible)

  readonly checkpointEffect = Effect.fn('ConversationCheckpointEngine.checkpoint')(function* (
    this: ConversationCheckpointEngine,
    input: unknown,
  ): Effect.fn.Return<ConversationCheckpointAck, PersistenceError> {
    if (this.persistenceMode === 'read-only')
      return yield* this.error(
        'recovery-platform',
        'Conversation history is read-only on this runtime. The original files were preserved.',
      )
    // Canonicalize only the changed wire packet. The committed tree already has
    // JSON semantics, so streaming saves do not parse the complete history again.
    const canonicalInput = yield* Effect.try({
      try: () => JSON.parse(JSON.stringify(input)),
      catch: (cause) => persistenceError('serialize', this.path, cause),
    })
    const checkpoint = yield* decodeCheckpoint(canonicalInput).pipe(
      Effect.mapError((cause) => persistenceError('validate', this.path, cause)),
    )
    const admissions = yield* decodeProjectionAdmissions(
      canonicalInput.projectionAdmissions ?? [],
    ).pipe(Effect.mapError((cause) => persistenceError('recovery-admission', this.path, cause)))
    yield* this.initializeEffect()
    if (checkpoint.baseSavedAt !== (this.snapshot?.savedAt ?? null))
      return yield* this.error('base', CONVERSATION_CHECKPOINT_BASE_CHANGED)
    if (checkpoint.savedAt <= (checkpoint.baseSavedAt ?? -1))
      return yield* this.error(
        'revision',
        'Conversation checkpoint must advance the durable timestamp.',
      )

    const previous = new Map(
      (this.snapshot?.threads ?? []).map((value) => {
        const thread = value as typeof threadSchema.Type
        return [thread.id, thread] as const
      }),
    )
    if (previous.size !== (this.snapshot?.threads.length ?? 0) || previous.has(''))
      return yield* this.error(
        'identity',
        'Conversation threads require unique nonempty identifiers before incremental updates.',
      )
    const updates = new Map<string, typeof threadSchema.Type>()
    const membership = new Set(checkpoint.order)
    for (const update of checkpoint.upserts) {
      const metadata = update.thread
      if ('messages' in metadata)
        return yield* this.error(
          'validate',
          'Conversation checkpoint metadata must keep messages in the message update.',
        )
      if (!membership.has(metadata.id) || updates.has(metadata.id))
        return yield* this.error(
          'validate',
          'Conversation checkpoint contains a duplicate or unlisted thread update.',
        )
      const current = previous.get(metadata.id)
      if (
        current &&
        update.messages.mode === 'patch' &&
        (current.profileId !== metadata.profileId || current.provider !== metadata.provider)
      )
        return yield* this.error(
          'identity',
          'Conversation checkpoint changed the workspace or provider of an existing thread.',
        )

      let messages: unknown[]
      if (update.messages.mode === 'replace') {
        messages = [...update.messages.values]
      } else {
        if (!current)
          return yield* this.error(
            'base',
            'A new conversation requires complete messages before incremental updates.',
          )
        const priorMessages = yield* decodeMessages(current.messages).pipe(
          Effect.mapError(() =>
            this.error(
              'identity',
              'Conversation messages require unique identifiers before incremental updates.',
            ),
          ),
        )
        const byId = new Map(priorMessages.map((message) => [message.id, message]))
        if (byId.size !== priorMessages.length)
          return yield* this.error(
            'identity',
            'Conversation messages require unique identifiers before incremental updates.',
          )
        const messageOrder = update.messages.order ?? priorMessages.map((message) => message.id)
        const messageMembership = new Set(messageOrder)
        const changed = new Set<string>()
        for (const message of update.messages.upserts) {
          if (!messageMembership.has(message.id) || changed.has(message.id))
            return yield* this.error(
              'validate',
              'Conversation checkpoint contains a duplicate or unlisted message update.',
            )
          changed.add(message.id)
          byId.set(message.id, message)
        }
        for (const fields of update.messages.fields ?? []) {
          if (!messageMembership.has(fields.id) || changed.has(fields.id))
            return yield* this.error(
              'validate',
              'Conversation checkpoint contains a duplicate, overlapping, or unlisted message field update.',
            )
          const message = byId.get(fields.id)
          if (!message)
            return yield* this.error(
              'base',
              'Conversation checkpoint field update refers to a message missing from its durable base.',
            )
          if (
            Object.hasOwn(fields.set, 'id') ||
            fields.remove.includes('id') ||
            Object.hasOwn(fields.append ?? {}, 'id') ||
            fields.remove.some(
              (key) => Object.hasOwn(fields.set, key) || Object.hasOwn(fields.append ?? {}, key),
            ) ||
            Object.keys(fields.append ?? {}).some((key) => Object.hasOwn(fields.set, key))
          )
            return yield* this.error(
              'validate',
              'Conversation checkpoint message fields cannot change identity or overlap set, remove, and append properties.',
            )
          changed.add(fields.id)
          // Object spread creates own data properties, including __proto__;
          // deleting a property stays distinct from assigning JSON null.
          const patched = { ...message, ...fields.set }
          for (const key of fields.remove) Reflect.deleteProperty(patched, key)
          for (const [key, append] of Object.entries(fields.append ?? {})) {
            if (!Object.hasOwn(message, key))
              return yield* this.error(
                'base',
                'Conversation checkpoint append requires an existing own string property.',
              )
            const previous = message[key]
            if (typeof previous !== 'string')
              return yield* this.error(
                'base',
                'Conversation checkpoint append requires an existing own string property.',
              )
            if (previous.length !== append.baseLength)
              return yield* this.error(
                'base',
                'Conversation checkpoint append length differs from its durable string base.',
              )
            Object.defineProperty(patched, key, {
              value: previous + append.value,
              enumerable: true,
              configurable: true,
              writable: true,
            })
          }
          byId.set(fields.id, patched)
        }
        messages = []
        for (const id of messageOrder) {
          const message = byId.get(id)
          if (!message)
            return yield* this.error(
              'base',
              'Conversation checkpoint refers to a message missing from its durable base.',
            )
          messages.push(message)
        }
      }
      updates.set(metadata.id, { ...metadata, messages })
    }
    const threads: unknown[] = []
    for (const id of checkpoint.order) {
      const thread = updates.get(id) ?? previous.get(id)
      if (!thread)
        return yield* this.error(
          'base',
          'Conversation checkpoint refers to a thread missing from its durable base.',
        )
      threads.push(thread)
    }
    return yield* this.commitEffect(
      { ...this.snapshot, version: 1, savedAt: checkpoint.savedAt, threads },
      true,
      admissions,
    )
  }, Effect.uninterruptible)

  private readonly initializeEffect = Effect.fn('ConversationCheckpointEngine.initialize')(() =>
    this.initializeUncheckedEffect().pipe(
      Effect.tapError((error) =>
        Effect.sync(() => {
          if (error.operation === 'decode' || error.operation === 'validate')
            this.initializationError = error
        }),
      ),
    ),
  )

  private readonly initializeUncheckedEffect = Effect.fnUntraced(function* (
    this: ConversationCheckpointEngine,
  ) {
    if (this.initialized) {
      if (!this.recoveryReceiptError) return
      // A failed private proof read does not poison ordinary history forever.
      // Retry actual bytes and the preserved sidecar before admitting a later
      // write, clearing the guard only after successful validation.
      this.invalidateCachedHistory()
    }
    if (this.initializationError) return yield* this.initializationError
    if (this.persistenceMode === 'native-protected')
      yield* persistenceIO('mkdir', this.directory, () =>
        mkdir(this.directory, { recursive: true }),
      )
    const bytes = yield* persistenceIO('read', this.path, () => readFile(this.path)).pipe(
      Effect.catchTag('PersistenceError', (error) =>
        (error.cause as NodeJS.ErrnoException).code === 'ENOENT'
          ? Effect.succeed(null)
          : Effect.fail(error),
      ),
    )
    if (bytes !== null) {
      const serialized = bytes.toString('utf8')
      const decoded = yield* decodeJson(serialized).pipe(
        Effect.mapError((cause) => persistenceError('decode', this.path, cause)),
      )
      if (EffectArray.isArray(decoded)) {
        yield* decodeHistory(decoded).pipe(
          Effect.mapError((cause) => persistenceError('validate', this.path, cause)),
        )
        this.snapshot = { version: 1, savedAt: 0, threads: decoded }
      } else {
        yield* decodeSnapshot(decoded).pipe(
          Effect.mapError(
            (cause) =>
              new PersistenceError({
                operation: 'validate',
                path: this.path,
                cause,
                message: 'Conversation history could not be read. The original file was preserved.',
              }),
          ),
        )
        // Retain original objects, including optional fields unknown to this version.
        this.snapshot = decoded as ConversationHistorySnapshot
        this.encodedSnapshot = serialized
      }
      if (this.persistenceMode === 'native-protected') {
        const sidecar = yield* this.recoverySidecar.loadEffect().pipe(
          Effect.catchTag('PersistenceError', (error) => {
            this.recoveryReceiptError = error
            return Effect.succeed(null)
          }),
        )
        this.recoveryProof = selectConversationRecoveryProof(
          sidecar,
          createHash('sha256').update(bytes).digest('hex'),
          this.snapshot!.savedAt,
        )
      }
    }
    this.initialized = true
  })

  private readonly commitEffect = Effect.fnUntraced(function* (
    this: ConversationCheckpointEngine,
    snapshot: ConversationHistorySnapshot,
    canonical = false,
    projectionAdmissions: readonly ConversationProjectionAdmission[] = [],
  ) {
    if (this.persistenceMode === 'read-only')
      return yield* this.error(
        'recovery-platform',
        'Conversation history is read-only on this runtime. The original files were preserved.',
      )
    const serialized = yield* Effect.try({
      try: () => JSON.stringify(snapshot),
      catch: (cause) => persistenceError('serialize', this.path, cause),
    })
    if (Buffer.byteLength(serialized, 'utf8') > 256 * 1024 * 1024)
      return yield* this.error(
        'validate',
        'Conversation history exceeds the 256 MB checkpoint limit. No history was removed.',
      )
    // Full saves establish a canonical tree once; compact updates already have
    // JSON semantics and reuse the untouched worker-owned records.
    const committed = canonical ? snapshot : (JSON.parse(serialized) as ConversationHistorySnapshot)
    if (this.persistenceMode === 'ordinary') {
      yield* assertOrdinaryRecoveryStateEffect(this.directory).pipe(
        Effect.mapError((cause) => persistenceError('recovery-platform', this.directory, cause)),
      )
      yield* persistenceIO('mkdir', this.directory, () =>
        mkdir(this.directory, { recursive: true }),
      )
    }
    const candidateReceipt =
      this.persistenceMode === 'native-protected'
        ? conversationRecoveryReceipt(committed)
        : undefined
    let admitted: ConversationRecoveryProof | undefined
    if (candidateReceipt) {
      const candidate: ConversationRecoveryProof = {
        hash: createHash('sha256').update(serialized, 'utf8').digest('hex'),
        savedAt: committed.savedAt,
        receipt: candidateReceipt,
      }
      const authorization = this.options.authorizeRecoveryReceipt
        ? yield* Effect.suspend(() =>
            this.options.authorizeRecoveryReceipt!(candidate, projectionAdmissions),
          ).pipe(
            Effect.catchCause((cause) =>
              Effect.fail(
                persistenceError(
                  'recovery-prepare',
                  this.recoverySidecar.path,
                  Cause.squash(cause),
                ),
              ),
            ),
          )
        : null
      if (authorization !== null) {
        admitted = yield* validateConversationRecoveryProof(
          this.recoverySidecar.path,
          authorization,
        )
        const proposedOwners = new Map(
          candidate.receipt.owners.map((owner) => [owner.sessionId, owner]),
        )
        if (
          admitted.hash !== candidate.hash ||
          admitted.savedAt !== candidate.savedAt ||
          admitted.receipt.snapshotId !== candidate.receipt.snapshotId ||
          admitted.receipt.owners.some((owner) => {
            const proposed = proposedOwners.get(owner.sessionId)
            return (
              !proposed ||
              proposed.provider !== owner.provider ||
              proposed.profileId !== owner.profileId ||
              proposed.workspace !== owner.workspace ||
              proposed.remoteId !== owner.remoteId ||
              Object.entries(owner.nativeRecovery).some(([transportId, cursor]) => {
                const prior = Object.getOwnPropertyDescriptor(
                  proposed.nativeRecovery,
                  transportId,
                )?.value
                return (
                  !prior ||
                  prior.appliedRevision !== cursor.appliedRevision ||
                  prior.ownerGeneration !== cursor.ownerGeneration ||
                  prior.snapshotToken !== cursor.snapshotToken
                )
              })
            )
          })
        )
          return yield* this.error(
            'recovery-prepare',
            'Native history admission differs from the prepared snapshot.',
          )
        if (admitted.receipt.owners.length) {
          if (this.recoveryReceiptError) return yield* this.recoveryReceiptError
          // Before retiring an older proof, first make the current namespace
          // durable, including any rename whose previous directory sync failed.
          if (this.snapshot && !this.historyDirectorySynced)
            yield* this.syncHistoryDirectoryEffect()
          yield* this.recoverySidecar.stageEffect(admitted, this.recoveryProof)
        } else admitted = undefined
      }
    }
    const written = yield* Effect.exit(atomicSnapshot(this.path, serialized))
    if (written._tag === 'Failure') {
      const cause = Cause.squash(written.cause)
      // File/open/write/sync/close failures precede publication. Only explicit
      // target-directory rename errors prove that rename was not published;
      // uncertain rename errors still require exact-byte reconciliation.
      if (cause instanceof PersistenceError) {
        const errno = (cause.cause as NodeJS.ErrnoException | undefined)?.code
        if (
          cause.operation !== 'cleanup' &&
          (cause.operation !== 'rename' || errno === 'EISDIR' || errno === 'ENOTDIR')
        )
          return yield* cause
      }
      // A cleanup failure can follow a completed rename. Preserve that exact
      // visible base and prepared proof instead of staging a later write against
      // stale bytes and losing recovery authority for an already written tail.
      const actual = yield* persistenceIO('read', this.path, () => readFile(this.path)).pipe(
        Effect.catchTag('PersistenceError', () => Effect.succeed(null)),
      )
      if (
        actual &&
        createHash('sha256').update(actual).digest('hex') ===
          createHash('sha256').update(serialized, 'utf8').digest('hex')
      ) {
        this.snapshot = committed
        this.encodedSnapshot = serialized
        this.recoveryProof = admitted
        this.historyDirectorySynced = false
      } else if (
        !actual ||
        this.encodedSnapshot === undefined ||
        createHash('sha256').update(actual).digest('hex') !==
          createHash('sha256').update(this.encodedSnapshot).digest('hex')
      ) {
        // An unreadable or different outcome is not proof the cached old file won.
        // Reconcile real bytes on the next read/write before using any base.
        this.invalidateCachedHistory()
      }
      return yield* cause instanceof PersistenceError
        ? cause
        : persistenceError('history-resource', this.path, cause)
    }
    this.snapshot = committed
    this.encodedSnapshot = serialized
    this.recoveryProof = admitted
    this.historyDirectorySynced = false
    // The rename is visible already. On a directory-sync failure retain the
    // new exact base/proof, fail the ACK, and leave native replay tails intact.
    if (admitted) yield* this.syncHistoryDirectoryEffect()
    return {
      savedAt: this.snapshot.savedAt,
      ...(admitted ? { nativeRecovery: admitted.receipt, nativeRecoveryHash: admitted.hash } : {}),
    } satisfies ConversationCheckpointAck
  })

  private readonly syncHistoryDirectoryEffect = Effect.fnUntraced(
    function* (this: ConversationCheckpointEngine) {
      yield* Effect.scoped(
        Effect.gen({ self: this }, function* () {
          const directory = yield* Effect.acquireRelease(
            persistenceIO('open-directory', this.directory, () => open(this.directory, 'r')),
            (file) =>
              persistenceIO('close-directory', this.directory, () => file.close()).pipe(
                Effect.orDie,
              ),
          )
          yield* persistenceIO('sync-directory', this.directory, () => directory.sync())
        }),
      )
      this.historyDirectorySynced = true
    },
    (effect) =>
      effect.pipe(
        Effect.catchCause((cause) => {
          const error = Cause.squash(cause)
          return Effect.fail(
            error instanceof PersistenceError
              ? error
              : persistenceError('history-directory-resource', this.directory, error),
          )
        }),
      ),
  )

  private invalidateCachedHistory() {
    this.initialized = false
    this.snapshot = null
    this.encodedSnapshot = undefined
    this.recoveryProof = undefined
    this.recoveryReceiptError = undefined
    this.historyDirectorySynced = false
  }
}
