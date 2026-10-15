import { createHash, randomUUID } from 'node:crypto'
import { lstat, mkdir, open, readFile, rename, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { Context, Effect, Layer, Predicate, Schema, Semaphore } from 'effect'
import type * as Scope from 'effect/Scope'
import { atomicSnapshot } from './persistence-effects'
import { parseLifeConfig, mergeLifeConfig } from '../shared/customization'
import { parseExtensionManifest } from '../shared/extensions'
import { parseLifeSourcePatch, parseLifeSourceRead } from '../shared/source-code'
import type { CustomizationStore } from './customization'
import type { ExtensionStore } from './extensions'
import type { SourceCodeStore } from './source-code'

const identity = Schema.NonEmptyString.check(Schema.isMaxLength(200))
const digest = Schema.String.check(Schema.isPattern(/^[a-f0-9]{64}$/))
export const nativeRecoveryActionRequestSchema = Schema.Struct({
  actionId: identity,
  transportId: identity,
  sessionId: identity,
  ownerGeneration: Schema.Natural.check(Schema.isLessThanOrEqualTo(Number.MAX_SAFE_INTEGER)),
  kind: Schema.Literals([
    'source-read',
    'settings-apply',
    'extension-apply',
    'source-apply',
    'reload',
  ]),
  intent: Schema.JsonObject,
})
const requestSchema = nativeRecoveryActionRequestSchema
const reloadIntentSchema = Schema.Struct({
  appliedActionId: identity,
  revision: Schema.Natural.check(Schema.isLessThanOrEqualTo(Number.MAX_SAFE_INTEGER)),
})
export const nativeRecoveryReloadPreparedSchema = Schema.Struct({ originalDocumentId: identity })
const reloadPreparedSchema = nativeRecoveryReloadPreparedSchema
export type NativeRecoveryReloadPrepared = typeof reloadPreparedSchema.Type
const recordSchema = Schema.Struct({
  format: Schema.Literal('life-native-recovery-action'),
  version: Schema.Literal(1),
  request: requestSchema,
  intentHash: digest,
  status: Schema.Literals(['intended', 'started', 'succeeded', 'failed', 'unknown']),
  prepared: Schema.optionalKey(Schema.Json),
  receipt: Schema.optionalKey(Schema.JsonObject),
  error: Schema.optionalKey(Schema.String),
})
const envelopeSchema = Schema.Struct({ record: recordSchema, checksum: digest })
const leaseSchema = Schema.Struct({
  pid: Schema.Natural.check(Schema.isGreaterThan(0)),
  token: identity,
})
export type NativeRecoveryActionRequest = typeof requestSchema.Type
export type NativeRecoveryActionRecord = typeof recordSchema.Type
export type NativeRecoveryActionResult = Pick<
  NativeRecoveryActionRecord,
  'status' | 'receipt' | 'error'
> & {
  readonly native: {
    readonly actionId: string
    readonly transportId: string
    readonly ownerGeneration: number
  }
}

export class NativeRecoveryActionError extends Schema.TaggedError<NativeRecoveryActionError>()(
  'NativeRecoveryActionError',
  {
    operation: Schema.String,
    path: Schema.String,
    reason: Schema.Literals([
      'invalid',
      'collision',
      'io',
      'closed',
      'ownership',
      'corrupt',
      'unsupported',
      'rejected',
    ]),
    message: Schema.String,
    cause: Schema.optionalKey(Schema.Defect()),
  },
) {}
type ActionEffect<A> = Effect.Effect<A, NativeRecoveryActionError>
export type NativeRecoveryActionReconciliation =
  | { readonly status: 'succeeded'; readonly result?: Schema.JsonObject }
  | { readonly status: 'failed'; readonly error: string }
  | { readonly status: 'unknown'; readonly error?: string }
export interface NativeRecoveryActionDriver {
  /** Read-only capture; the result is durable before execution is admitted. */
  prepare?(request: NativeRecoveryActionRequest): ActionEffect<Schema.Json>
  execute(
    request: NativeRecoveryActionRequest,
    prepared: Schema.Json | undefined,
    intentHash: string,
  ): ActionEffect<Schema.JsonObject | undefined>
  /** A started action is never executed again by the registry itself. */
  reconcile(
    request: NativeRecoveryActionRequest,
    prepared: Schema.Json | undefined,
    intentHash: string,
  ): ActionEffect<NativeRecoveryActionReconciliation>
  /** Observe already committed evidence without execution or action-record writes. */
  observe?(
    request: NativeRecoveryActionRequest,
    prepared: Schema.Json | undefined,
    intentHash: string,
  ): ActionEffect<NativeRecoveryActionReconciliation>
}
export interface NativeRecoveryActionsHandle {
  prepare(request: NativeRecoveryActionRequest): ActionEffect<NativeRecoveryActionResult>
  read(request: NativeRecoveryActionRequest): ActionEffect<NativeRecoveryActionResult | undefined>
  perform(request: NativeRecoveryActionRequest): ActionEffect<NativeRecoveryActionResult>
  reconcile(request: NativeRecoveryActionRequest): ActionEffect<NativeRecoveryActionResult>
  reconcileOnly(request: NativeRecoveryActionRequest): ActionEffect<NativeRecoveryActionResult>
  closeEffect(): ActionEffect<void>
}
export interface NativeRecoveryActionsOptions {
  readonly directory: string
  /** Obtain Electron's singleton lock before reclaiming a dead-process lease. */
  readonly exclusiveRuntime?: boolean
  readonly drivers: Readonly<
    Record<NativeRecoveryActionRequest['kind'], NativeRecoveryActionDriver>
  >
}

const hash = (value: string) => createHash('sha256').update(value).digest('hex')
const failure = (
  operation: string,
  path: string,
  reason: NativeRecoveryActionError['reason'],
  message: string,
  cause?: unknown,
) =>
  new NativeRecoveryActionError({
    operation,
    path,
    reason,
    message,
    ...(cause === undefined ? {} : { cause }),
  })
const io = <A>(operation: string, path: string, execute: () => Promise<A>): ActionEffect<A> =>
  Effect.tryPromise({
    try: execute,
    catch: (cause) =>
      failure(operation, path, 'io', 'Studio recovery storage operation failed.', cause),
  })

/** Inspect descriptors before Schema or JSON serialization can evaluate user objects. */
function assertJson(value: unknown, seen = new Set<object>(), depth = 0): void {
  if (depth > 48) throw new Error('Studio action data is too deeply nested.')
  if (!Predicate.isObject(value)) return
  if (seen.has(value)) throw new Error('Studio action data contains a cycle.')
  const array = Array.isArray(value)
  const prototype = Object.getPrototypeOf(value)
  if (
    prototype !== Object.prototype &&
    prototype !== null &&
    !(array && prototype === Array.prototype)
  )
    throw new Error('Studio action data requires plain JSON objects.')
  seen.add(value)
  let entries = 0
  for (const key of Reflect.ownKeys(value)) {
    if (
      typeof key !== 'string' ||
      ['__proto__', 'constructor', 'prototype', 'toJSON'].includes(key)
    )
      throw new Error('Studio action data contains an unsupported key.')
    const descriptor = Object.getOwnPropertyDescriptor(value, key)!
    if (!('value' in descriptor)) throw new Error('Studio action data cannot contain accessors.')
    if (array && key === 'length') continue
    if (array && !/^(?:0|[1-9][0-9]*)$/.test(key))
      throw new Error('Studio action arrays cannot contain named properties.')
    entries++
    assertJson(descriptor.value, seen, depth + 1)
  }
  if (array && entries !== value.length)
    throw new Error('Studio action arrays cannot contain holes.')
  seen.delete(value)
}
const decode = Effect.fnUntraced(function* <A, I>(
  schema: Schema.Codec<A, I>,
  value: unknown,
  path: string,
): Effect.fn.Return<A, NativeRecoveryActionError> {
  yield* Effect.try({
    try: () => assertJson(value),
    catch: (cause) =>
      failure('validate', path, 'invalid', 'Studio action data is not plain JSON.', cause),
  })
  yield* Schema.decodeUnknownEffect(Schema.Json)(value).pipe(
    Effect.mapError((cause) =>
      failure('validate', path, 'invalid', 'Studio action data is not JSON.', cause),
    ),
  )
  return yield* Schema.decodeUnknownEffect(schema, { onExcessProperty: 'error' })(value).pipe(
    Effect.mapError((cause) =>
      failure('validate', path, 'invalid', 'Studio action data is invalid.', cause),
    ),
    Effect.map((parsed) => JSON.parse(JSON.stringify(parsed)) as A),
  )
})
function canonical(value: Schema.Json): string {
  if (Array.isArray(value)) return '[' + value.map(canonical).join(',') + ']'
  if (Predicate.isObject(value))
    return (
      '{' +
      Object.keys(value)
        .sort()
        .map((key) => JSON.stringify(key) + ':' + canonical((value as Schema.JsonObject)[key]))
        .join(',') +
      '}'
    )
  return JSON.stringify(value)
}
export const nativeRecoveryActionIntentHash = (request: NativeRecoveryActionRequest) =>
  hash(canonical(request.intent))
const nativeIdentity = (request: NativeRecoveryActionRequest) => ({
  actionId: request.actionId,
  transportId: request.transportId,
  ownerGeneration: request.ownerGeneration,
})
const resultOf = (record: NativeRecoveryActionRecord): NativeRecoveryActionResult => ({
  status: record.status,
  native: nativeIdentity(record.request),
  ...(record.receipt
    ? { receipt: JSON.parse(JSON.stringify(record.receipt)) as Schema.JsonObject }
    : {}),
  ...(record.error !== undefined ? { error: record.error } : {}),
})
const withDirectorySync = (directory: string) =>
  Effect.scoped(
    Effect.gen(function* () {
      const file = yield* Effect.acquireRelease(
        io('open-directory', directory, () => open(directory, 'r')),
        (file) => io('close-directory', directory, () => file.close()).pipe(Effect.orDie),
      )
      yield* io('sync-directory', directory, () => file.sync())
    }),
  )

const leaseAdmission = Semaphore.makeUnsafe(1)
const acquireLease = Effect.fnUntraced(
  function* (directory: string, exclusiveRuntime: boolean) {
    yield* io('mkdir', directory, () => mkdir(directory, { recursive: true, mode: 0o700 }))
    const path = join(directory, '.writer.lock')
    const token = randomUUID()
    for (;;) {
      const acquired = yield* io('lease', path, () => mkdir(path, { mode: 0o700 })).pipe(
        Effect.as(true),
        Effect.catch((error) =>
          Predicate.isObject(error.cause) && error.cause.code === 'EEXIST'
            ? Effect.succeed(false)
            : Effect.fail(error),
        ),
      )
      if (acquired) {
        yield* Effect.gen(function* () {
          yield* atomicSnapshot(
            join(path, 'owner.json'),
            JSON.stringify({ pid: process.pid, token }),
          ).pipe(
            Effect.mapError((cause) =>
              failure('lease', path, 'io', 'Studio action lease could not be committed.', cause),
            ),
          )
          yield* withDirectorySync(path)
          yield* withDirectorySync(directory)
        }).pipe(
          Effect.onError(() =>
            io('cleanup-lease', path, () => rm(path, { recursive: true, force: true })).pipe(
              Effect.ignore,
            ),
          ),
        )
        return { path, token, directory, released: false }
      }
      const text = yield* io('read-lease', path, () =>
        readFile(join(path, 'owner.json'), 'utf8'),
      ).pipe(
        Effect.mapError((cause) =>
          failure(
            'lease',
            path,
            'ownership',
            'Studio action writer ownership cannot be verified.',
            cause,
          ),
        ),
      )
      const raw = yield* Effect.try({
        try: () => JSON.parse(text) as unknown,
        catch: (cause) =>
          failure('lease', path, 'ownership', 'Studio action writer lease is malformed.', cause),
      })
      const owner = yield* decode(leaseSchema, raw, path)
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
            path,
            'ownership',
            'Studio action writer liveness cannot be verified.',
            cause,
          ),
      })
      if (alive)
        return yield* failure(
          'lease',
          path,
          'ownership',
          'Studio action records are owned by another live writer.',
        )
      if (!exclusiveRuntime)
        return yield* failure(
          'lease',
          path,
          'ownership',
          'Reclaiming a stale Studio action lease requires verified exclusive application ownership.',
        )
      const stale = path + '.stale.' + token
      yield* io('reclaim-lease', path, () => rename(path, stale))
      const captured = yield* io('verify-reclaimed-lease', stale, () =>
        readFile(join(stale, 'owner.json'), 'utf8'),
      ).pipe(
        Effect.flatMap((text) =>
          Effect.try({
            try: () => JSON.parse(text) as unknown,
            catch: (cause) =>
              failure(
                'lease',
                stale,
                'ownership',
                'Reclaimed Studio action lease cannot be verified.',
                cause,
              ),
          }),
        ),
        Effect.flatMap((value) => decode(leaseSchema, value, stale)),
      )
      if (captured.token !== owner.token || captured.pid !== owner.pid)
        return yield* failure(
          'lease',
          stale,
          'ownership',
          'Studio action writer changed during reclamation; its captured ownership evidence was retained.',
        )
      yield* io('remove-stale-lease', stale, () => rm(stale, { recursive: true, force: true }))
    }
  },
  Effect.uninterruptible,
  leaseAdmission.withPermit,
)

const releaseLease = Effect.fnUntraced(function* (lease: {
  path: string
  token: string
  directory: string
  released: boolean
}) {
  if (lease.released) return
  const text = yield* io('verify-close-lease', lease.path, () =>
    readFile(join(lease.path, 'owner.json'), 'utf8'),
  )
  const raw = yield* Effect.try({
    try: () => JSON.parse(text) as unknown,
    catch: (cause) =>
      failure('close', lease.path, 'ownership', 'Studio action lease changed before close.', cause),
  })
  const owner = yield* decode(leaseSchema, raw, lease.path)
  if (owner.token !== lease.token || owner.pid !== process.pid)
    return yield* failure(
      'close',
      lease.path,
      'ownership',
      'Studio action writer lease changed before close.',
    )
  yield* io('release-lease', lease.path, () => rm(lease.path, { recursive: true }))
  lease.released = true
  yield* withDirectorySync(lease.directory)
}, Effect.uninterruptible)

/** Call only after Agents has verified the native transport, session, and owner generation. */
export class NativeRecoveryActions extends Context.Service<
  NativeRecoveryActions,
  NativeRecoveryActionsHandle
>()('life/main/NativeRecoveryActions') {
  static readonly make = Effect.fn('NativeRecoveryActions.make')(function* (
    options: NativeRecoveryActionsOptions,
  ): Effect.fn.Return<NativeRecoveryActionsHandle, NativeRecoveryActionError, Scope.Scope> {
    const lease = yield* Effect.acquireRelease(
      acquireLease(options.directory, options.exclusiveRuntime === true),
      (lease) => releaseLease(lease).pipe(Effect.orDie),
    )
    const mutex = yield* Semaphore.make(1)
    let closed = false
    const poisoned = new Map<string, NativeRecoveryActionError>()
    const verifyLease = Effect.fnUntraced(function* () {
      const text = yield* io('verify-writer', lease.path, () =>
        readFile(join(lease.path, 'owner.json'), 'utf8'),
      )
      const raw = yield* Effect.try({
        try: () => JSON.parse(text) as unknown,
        catch: (cause) =>
          failure(
            'writer',
            lease.path,
            'ownership',
            'Studio action writer lease is malformed.',
            cause,
          ),
      })
      const owner = yield* decode(leaseSchema, raw, lease.path)
      if (owner.token !== lease.token || owner.pid !== process.pid)
        return yield* failure(
          'writer',
          lease.path,
          'ownership',
          'Studio action writer lost its admitted lease; no new action was issued.',
        )
    })
    const pathOf = (request: NativeRecoveryActionRequest) =>
      join(options.directory, hash(request.actionId) + '.json')
    const checked = (request: NativeRecoveryActionRequest) =>
      decode(requestSchema, request, options.directory)
    const read = Effect.fnUntraced(function* (
      request: NativeRecoveryActionRequest,
      verifyRequest = true,
    ): Effect.fn.Return<NativeRecoveryActionRecord | undefined, NativeRecoveryActionError> {
      const path = pathOf(request)
      if (poisoned.has(path)) return yield* poisoned.get(path)!
      const info = yield* io('stat', path, () => lstat(path)).pipe(
        Effect.catch((error) =>
          Predicate.isObject(error.cause) && error.cause.code === 'ENOENT'
            ? Effect.succeed(undefined)
            : Effect.fail(error),
        ),
      )
      if (!info) return
      if (!info.isFile() || info.isSymbolicLink())
        return yield* failure(
          'read',
          path,
          'ownership',
          'Studio action record must be a regular private file.',
        )
      if (info.size > 64_000_000)
        return yield* failure(
          'read',
          path,
          'corrupt',
          'Studio action record is too large; original bytes were retained.',
        )
      const text = yield* io('read', path, () => readFile(path, 'utf8'))
      const raw = yield* Effect.try({
        try: () => JSON.parse(text) as unknown,
        catch: (cause) =>
          failure(
            'read',
            path,
            'corrupt',
            'Studio action record is malformed; original bytes were retained.',
            cause,
          ),
      })
      if (Predicate.isObject(raw) && Predicate.isObject(raw.record) && raw.record.version !== 1)
        return yield* failure(
          'read',
          path,
          'unsupported',
          'Studio action record version is unsupported; original bytes were retained.',
        )
      const envelope = yield* decode(envelopeSchema, raw, path).pipe(
        Effect.mapError((cause) =>
          failure(
            'read',
            path,
            'corrupt',
            'Studio action record is invalid; original bytes were retained.',
            cause,
          ),
        ),
      )
      const record = envelope.record
      if (
        envelope.checksum !== hash(canonical(record as unknown as Schema.Json)) ||
        record.intentHash !== nativeRecoveryActionIntentHash(record.request)
      )
        return yield* failure(
          'read',
          path,
          'corrupt',
          'Studio action record checksum is inconsistent; original bytes were retained.',
        )
      if (
        (record.status === 'succeeded') !== Boolean(record.receipt) ||
        (record.status === 'failed' && record.error === undefined)
      )
        return yield* failure(
          'read',
          path,
          'corrupt',
          'Studio action record has inconsistent completion evidence.',
        )
      if (
        record.request.actionId !== request.actionId ||
        (verifyRequest && canonical(record.request) !== canonical(request))
      )
        return yield* failure(
          'read',
          path,
          'collision',
          'Studio action ID already belongs to a different exact intent or native owner.',
        )
      return record
    })
    const commit = Effect.fnUntraced(function* (record: NativeRecoveryActionRecord) {
      yield* verifyLease()
      const path = pathOf(record.request)
      const serialized = JSON.stringify({
        record,
        checksum: hash(canonical(record as unknown as Schema.Json)),
      })
      if (Buffer.byteLength(serialized, 'utf8') > 64_000_000)
        return yield* failure(
          'write',
          path,
          'invalid',
          'Studio action receipt exceeds 64 MB; no action data was truncated.',
        )
      yield* atomicSnapshot(path, serialized).pipe(
        Effect.mapError((cause) =>
          failure(
            'write',
            path,
            'io',
            'Studio action record could not be durably committed.',
            cause,
          ),
        ),
        Effect.andThen(withDirectorySync(options.directory)),
        Effect.tapError((error) =>
          Effect.sync(() => {
            poisoned.set(path, error)
          }),
        ),
      )
      return record
    }, Effect.uninterruptible)
    const prepare = Effect.fnUntraced(function* (request: NativeRecoveryActionRequest) {
      const old = yield* read(request)
      if (old) return old
      if (request.kind === 'reload') {
        const intent = yield* decode(reloadIntentSchema, request.intent, pathOf(request))
        if (intent.appliedActionId === request.actionId)
          return yield* failure(
            'reload',
            pathOf(request),
            'invalid',
            'A reload must reference a different, committed source action.',
          )
        const original = yield* read({ ...request, actionId: intent.appliedActionId }, false)
        if (
          !original ||
          original.request.kind !== 'source-apply' ||
          original.request.transportId !== request.transportId ||
          original.request.sessionId !== request.sessionId ||
          original.request.ownerGeneration !== request.ownerGeneration
        )
          return yield* failure(
            'reload',
            pathOf(request),
            'ownership',
            'A reload must belong to the exact source action and native owner that applied it.',
          )
        const applied = yield* reconcile(original)
        if (
          applied.status !== 'succeeded' ||
          !Predicate.isObject(applied.receipt?.snapshot) ||
          applied.receipt.snapshot.revision !== intent.revision
        )
          return yield* failure(
            'reload',
            pathOf(request),
            'invalid',
            'A reload requires its original successful source revision receipt.',
          )
      }
      const driver = options.drivers[request.kind]
      const prepared = driver.prepare
        ? yield* driver
            .prepare(request)
            .pipe(Effect.flatMap((value) => decode(Schema.Json, value, pathOf(request))))
        : undefined
      return yield* commit({
        format: 'life-native-recovery-action',
        version: 1,
        request,
        intentHash: nativeRecoveryActionIntentHash(request),
        status: 'intended',
        ...(prepared === undefined ? {} : { prepared }),
      })
    })
    const completedRecord = Effect.fnUntraced(function* (
      record: NativeRecoveryActionRecord,
      outcome: NativeRecoveryActionReconciliation,
    ) {
      if (outcome.status === 'succeeded') {
        const result = yield* decode(
          Schema.JsonObject,
          outcome.result || {},
          pathOf(record.request),
        )
        if (Object.hasOwn(result, 'native'))
          return yield* failure(
            'receipt',
            pathOf(record.request),
            'invalid',
            'Only the native action registry may bind a receipt owner.',
          )
        const { error: _error, ...withoutError } = record
        return {
          ...withoutError,
          status: 'succeeded',
          receipt: { ...result, native: nativeIdentity(record.request) },
        } satisfies NativeRecoveryActionRecord
      }
      return {
        ...record,
        status: outcome.status,
        ...(outcome.error === undefined ? {} : { error: outcome.error }),
      } satisfies NativeRecoveryActionRecord
    })
    const settle = (
      record: NativeRecoveryActionRecord,
      outcome: NativeRecoveryActionReconciliation,
    ) => completedRecord(record, outcome).pipe(Effect.flatMap(commit))
    const reconcile = Effect.fnUntraced(function* (record: NativeRecoveryActionRecord) {
      if (
        record.status === 'succeeded' ||
        record.status === 'failed' ||
        record.status === 'intended'
      )
        return record
      const outcome = yield* options.drivers[record.request.kind].reconcile(
        record.request,
        record.prepared,
        record.intentHash,
      )
      return yield* settle(record, outcome)
    })
    const locked = <A>(
      request: NativeRecoveryActionRequest,
      run: (request: NativeRecoveryActionRequest) => ActionEffect<A>,
    ): ActionEffect<A> =>
      mutex.withPermits(1)(
        Effect.gen(function* () {
          if (closed)
            return yield* failure(
              'store',
              options.directory,
              'closed',
              'Studio action registry is closed.',
            )
          yield* verifyLease()
          return yield* run(yield* checked(request))
        }),
      )
    const closeEffect = Effect.fnUntraced(function* () {
      yield* mutex.withPermits(1)(
        Effect.gen(function* () {
          if (closed) return
          closed = true
          yield* releaseLease(lease)
        }),
      )
    }, Effect.uninterruptible)
    yield* Effect.addFinalizer(() => closeEffect().pipe(Effect.orDie))
    return NativeRecoveryActions.of({
      prepare: (request) =>
        locked(request, (request) => prepare(request).pipe(Effect.map(resultOf))),
      read: (request) =>
        locked(request, (request) =>
          read(request).pipe(Effect.map((record) => record && resultOf(record))),
        ),
      reconcile: (request) =>
        locked(request, (request) =>
          prepare(request).pipe(Effect.flatMap(reconcile), Effect.map(resultOf)),
        ),
      reconcileOnly: (request) =>
        locked(
          request,
          Effect.fnUntraced(function* (request) {
            const record = yield* read(request)
            if (!record)
              return {
                status: 'unknown' as const,
                native: nativeIdentity(request),
                error: 'No durable action was admitted; no action was executed.',
              }
            if (
              record.status === 'succeeded' ||
              record.status === 'failed' ||
              record.status === 'intended'
            )
              return resultOf(record)
            const observe = options.drivers[request.kind].observe
            if (!observe) return resultOf({ ...record, status: 'unknown' })
            return resultOf(
              yield* completedRecord(
                record,
                yield* observe(request, record.prepared, record.intentHash),
              ),
            )
          }),
        ),
      perform: (request) =>
        locked(
          request,
          Effect.fnUntraced(function* (request) {
            let record = yield* prepare(request)
            if (record.status !== 'intended') return resultOf(yield* reconcile(record))
            record = yield* commit({ ...record, status: 'started' })
            const outcome = yield* options.drivers[request.kind]
              .execute(request, record.prepared, record.intentHash)
              .pipe(
                Effect.map((result): NativeRecoveryActionReconciliation => ({
                  status: 'succeeded',
                  ...(result ? { result } : {}),
                })),
                Effect.catch((error) =>
                  error.reason === 'rejected' || error.reason === 'invalid'
                    ? Effect.succeed({ status: 'failed' as const, error: error.message })
                    : options.drivers[request.kind]
                        .reconcile(request, record.prepared, record.intentHash)
                        .pipe(
                          Effect.map((outcome): NativeRecoveryActionReconciliation =>
                            outcome.status === 'unknown'
                              ? { status: 'unknown', error: error.message }
                              : outcome,
                          ),
                        ),
                ),
              )
            return resultOf(yield* settle(record, outcome))
          }),
        ),
      closeEffect,
    })
  })
  static layer(options: NativeRecoveryActionsOptions) {
    return Layer.effect(this, this.make(options))
  }
}

const adapter = <A>(operation: string, run: (signal: AbortSignal) => Promise<A>): ActionEffect<A> =>
  Effect.tryPromise({
    try: run,
    catch: (cause) =>
      failure(operation, '', 'io', cause instanceof Error ? cause.message : String(cause), cause),
  })
const validateIntent = <A>(request: NativeRecoveryActionRequest, parse: () => A): ActionEffect<A> =>
  Effect.try({
    try: parse,
    catch: (cause) =>
      failure('intent', request.actionId, 'invalid', 'Studio action intent is invalid.', cause),
  })
const asJsonObject = (value: unknown) => decode(Schema.JsonObject, value, '')

/** Store adapters remain at the Promise boundary; registry ownership stays in Effect. */
export function makeStudioRecoveryActionDrivers(stores: {
  readonly sourceCode: SourceCodeStore
  readonly customization: CustomizationStore
  readonly extensions: ExtensionStore
  readonly captureReloadDocument: () => { documentId: string }
  readonly reload: (
    request: NativeRecoveryActionRequest,
    prepared: NativeRecoveryReloadPrepared,
    signal?: AbortSignal,
  ) => Promise<void>
  readonly reconcileReload: (
    request: NativeRecoveryActionRequest,
    prepared: NativeRecoveryReloadPrepared,
    signal?: AbortSignal,
  ) => Promise<boolean>
}): NativeRecoveryActionsOptions['drivers'] {
  return {
    'source-read': {
      execute: Effect.fnUntraced(function* (request) {
        const read = yield* validateIntent(request, () =>
          request.intent.read === undefined ? undefined : parseLifeSourceRead(request.intent.read),
        )
        return yield* asJsonObject({
          source: yield* adapter('source-read', () => stores.sourceCode.getContext(read)),
        })
      }),
      reconcile: Effect.fnUntraced(function* (request) {
        // No provider continuation was admitted without this receipt. Repeating a
        // source read has no mutation and captures one new, complete source revision.
        const read = yield* validateIntent(request, () =>
          request.intent.read === undefined ? undefined : parseLifeSourceRead(request.intent.read),
        )
        return {
          status: 'succeeded' as const,
          result: yield* asJsonObject({
            source: yield* adapter('source-read', () => stores.sourceCode.getContext(read)),
          }),
        }
      }),
    },
    'source-apply': {
      execute: Effect.fnUntraced(function* (request, _prepared, intentHash) {
        const patch = yield* validateIntent(request, () =>
          parseLifeSourcePatch(request.intent.patch),
        )
        const snapshot = yield* adapter('source-apply', () =>
          stores.sourceCode.apply(patch, { actionId: request.actionId, intentHash }),
        ).pipe(
          Effect.catch((error) =>
            adapter('read-source-action', () =>
              stores.sourceCode.readRecoveryAction(request.actionId, intentHash),
            ).pipe(
              Effect.flatMap((snapshot) =>
                snapshot
                  ? Effect.succeed(snapshot)
                  : Effect.fail(
                      failure('source-apply', request.actionId, 'rejected', error.message, error),
                    ),
              ),
            ),
          ),
        )
        if (
          snapshot.error ||
          !snapshot.enabled ||
          !snapshot.active ||
          snapshot.active.revision !== snapshot.revision ||
          snapshot.revision <= patch.baseRevision
        )
          return yield* failure(
            'source-apply',
            request.actionId,
            'rejected',
            snapshot.error || 'The source extension did not activate.',
          )
        return yield* asJsonObject({ snapshot })
      }),
      reconcile: Effect.fnUntraced(function* (request, _prepared, intentHash) {
        const snapshot = yield* adapter('read-source-action', () =>
          stores.sourceCode.readRecoveryAction(request.actionId, intentHash),
        )
        if (
          snapshot &&
          (snapshot.error ||
            !snapshot.enabled ||
            !snapshot.active ||
            snapshot.active.revision !== snapshot.revision)
        )
          return {
            status: 'failed' as const,
            error: snapshot.error || 'The source extension did not activate.',
          }
        return snapshot
          ? { status: 'succeeded' as const, result: yield* asJsonObject({ snapshot }) }
          : { status: 'unknown' as const }
      }),
      observe: Effect.fnUntraced(function* (request, _prepared, intentHash) {
        const snapshot = yield* adapter('read-source-action', () =>
          stores.sourceCode.readRecoveryAction(request.actionId, intentHash),
        )
        if (
          snapshot &&
          (snapshot.error ||
            !snapshot.enabled ||
            !snapshot.active ||
            snapshot.active.revision !== snapshot.revision)
        )
          return {
            status: 'failed' as const,
            error: snapshot.error || 'The source extension did not activate.',
          }
        return snapshot
          ? { status: 'succeeded' as const, result: yield* asJsonObject({ snapshot }) }
          : { status: 'unknown' as const }
      }),
    },
    'settings-apply': {
      prepare: Effect.fnUntraced(function* (request) {
        const config = stores.customization.get().config
        return yield* validateIntent(
          request,
          () =>
            JSON.parse(
              JSON.stringify(mergeLifeConfig(config, request.intent.patch)),
            ) as Schema.Json,
        )
      }),
      execute: Effect.fnUntraced(function* (request) {
        yield* adapter('settings-apply', () => stores.customization.apply(request.intent.patch))
        return undefined
      }),
      reconcile: Effect.fnUntraced(function* (_request, prepared) {
        yield* validateIntent(_request, () => parseLifeConfig(prepared))
        const text = yield* adapter('read-settings', () =>
          readFile(stores.customization.path, 'utf8'),
        )
        const current = yield* validateIntent(_request, () => parseLifeConfig(JSON.parse(text)))
        // An unrelated setting may change after the original intent is captured.
        // Only the exact admitted patch must already hold; never restore an old
        // complete configuration to manufacture a matching postimage.
        const desired = yield* validateIntent(_request, () =>
          mergeLifeConfig(current, _request.intent.patch),
        )
        return canonical(current as unknown as Schema.Json) ===
          canonical(desired as unknown as Schema.Json)
          ? { status: 'succeeded' as const }
          : { status: 'unknown' as const }
      }),
      observe: Effect.fnUntraced(function* (request, prepared) {
        yield* validateIntent(request, () => parseLifeConfig(prepared))
        const text = yield* adapter('read-settings', () =>
          readFile(stores.customization.path, 'utf8'),
        )
        const current = yield* validateIntent(request, () => parseLifeConfig(JSON.parse(text)))
        const desired = yield* validateIntent(request, () =>
          mergeLifeConfig(current, request.intent.patch),
        )
        return canonical(current as unknown as Schema.Json) ===
          canonical(desired as unknown as Schema.Json)
          ? { status: 'succeeded' as const }
          : { status: 'unknown' as const }
      }),
    },
    'extension-apply': {
      execute: Effect.fnUntraced(function* (request) {
        const manifest = yield* validateIntent(request, () =>
          parseExtensionManifest(request.intent.manifest),
        )
        const snapshot = yield* adapter('extension-apply', () => stores.extensions.apply(manifest))
        if (
          snapshot.errors[manifest.id] ||
          !snapshot.extensions.some((entry) => entry.id === manifest.id)
        )
          return yield* failure(
            'extension-apply',
            request.actionId,
            'rejected',
            snapshot.errors[manifest.id] || 'The runtime extension could not be saved.',
          )
        return undefined
      }),
      reconcile: () => Effect.succeed({ status: 'unknown' }),
    },
    reload: {
      prepare: Effect.fnUntraced(function* (request) {
        const current = yield* Effect.try({
          try: () => stores.captureReloadDocument(),
          catch: (cause) =>
            failure(
              'capture-reload-document',
              request.actionId,
              'io',
              'The Life document is unavailable for reload; the original source commit remains recoverable.',
              cause,
            ),
        })
        return yield* decode(reloadPreparedSchema, { originalDocumentId: current.documentId }, '')
      }),
      execute: Effect.fnUntraced(function* (request, rawPrepared) {
        const prepared = yield* decode(reloadPreparedSchema, rawPrepared, request.actionId)
        const intent = yield* decode(reloadIntentSchema, request.intent, request.actionId)
        const current = stores.sourceCode.get()
        if (!current.enabled || current.active?.revision !== intent.revision)
          return yield* failure(
            'reload',
            request.actionId,
            'rejected',
            'The applied source revision is no longer active. Its original commit remains recoverable.',
          )
        yield* adapter('reload', (signal) => stores.reload(request, prepared, signal))
        return undefined
      }),
      reconcile: Effect.fnUntraced(function* (request, rawPrepared) {
        const prepared = yield* decode(reloadPreparedSchema, rawPrepared, request.actionId)
        return yield* adapter('reconcile-reload', (signal) =>
          stores.reconcileReload(request, prepared, signal),
        ).pipe(
          Effect.map((ready) => ({
            status: ready ? ('succeeded' as const) : ('unknown' as const),
          })),
        )
      }),
      observe: Effect.fnUntraced(function* (request, rawPrepared) {
        const prepared = yield* decode(reloadPreparedSchema, rawPrepared, request.actionId)
        return yield* adapter('observe-reload', (signal) =>
          stores.reconcileReload(request, prepared, signal),
        ).pipe(
          Effect.map((ready) => ({
            status: ready ? ('succeeded' as const) : ('unknown' as const),
          })),
        )
      }),
    },
  }
}
