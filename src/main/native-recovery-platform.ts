import { lstat, readdir, readFile } from 'node:fs/promises'
import { dirname, join, resolve } from 'node:path'
import { Context, Effect, Layer, Predicate, Schema, Semaphore } from 'effect'
import { NativeRecoveryError } from './native-recovery-types'

export type NativeRecoveryPlatformMode = 'durable' | 'unsupported-clean' | 'blocked'
export type NativeRecoveryPersistenceMode = 'native-protected' | 'ordinary' | 'read-only'
export interface NativeRecoveryPlatformStatus {
  readonly mode: NativeRecoveryPlatformMode
  readonly message?: string
}
const policyBrand: unique symbol = Symbol('life-native-recovery-platform')
const issuedPolicies = new WeakSet<object>()
export interface NativeRecoveryPlatformPolicy {
  readonly [policyBrand]: true
  readonly mode: NativeRecoveryPlatformMode
  readonly status: NativeRecoveryPlatformStatus
  readonly sourcePersistenceMode: NativeRecoveryPersistenceMode
  readonly error?: NativeRecoveryError
  assertFreshSshStartEffect(transport?: 'ssh' | 'local'): Effect.Effect<void, NativeRecoveryError>
  assertOrdinarySourceWriteEffect(directory?: string): Effect.Effect<void, NativeRecoveryError>
  assertOrdinaryHistoryWriteEffect(directory?: string): Effect.Effect<void, NativeRecoveryError>
  assertNativeRecoveryEffect(operation?: string): Effect.Effect<void, NativeRecoveryError>
}
export interface NativeRecoveryPlatformOptions {
  readonly userData: string
  /** Main supplies only after its OS single-instance lock; fixtures use an exclusive private directory. */
  readonly exclusiveRuntime: boolean
}

const error = (operation: string, path: string, message: string, cause?: unknown) =>
  new NativeRecoveryError({ operation, path, reason: 'unsupported', message, cause })
const io = <A>(operation: string, path: string, run: () => Promise<A>) =>
  Effect.tryPromise({
    try: run,
    catch: (cause) =>
      new NativeRecoveryError({
        operation,
        path,
        reason: 'ownership',
        message: 'Protected recovery state cannot be verified. Its original files were preserved.',
        cause,
      }),
  })
const missing = <A>(effect: Effect.Effect<A, NativeRecoveryError>) =>
  effect.pipe(
    Effect.catch((failure) =>
      Predicate.isObject(failure.cause) && failure.cause.code === 'ENOENT'
        ? Effect.succeed(undefined)
        : Effect.fail(failure),
    ),
  )
const stateSchema = Schema.Struct({
  format: Schema.Literal(1),
  revision: Schema.Natural,
  current: Schema.Union([Schema.Natural.check(Schema.isGreaterThan(0)), Schema.Null]),
  history: Schema.Array(
    Schema.Union([Schema.Natural.check(Schema.isGreaterThan(0)), Schema.Null]),
  ).check(Schema.isMaxLength(5)),
  enabled: Schema.Boolean,
  error: Schema.optionalKey(Schema.String),
  failed: Schema.optionalKey(
    Schema.Array(Schema.Natural.check(Schema.isGreaterThan(0))).check(Schema.isMaxLength(100)),
  ),
  recoveryActions: Schema.optionalKey(Schema.Array(Schema.Json)),
})
const historySchema = Schema.Union([
  Schema.Array(Schema.Json),
  Schema.Struct({
    version: Schema.Literal(1),
    savedAt: Schema.Natural,
    threads: Schema.Array(Schema.Json),
  }),
])
const readJson = Effect.fnUntraced(function* <S extends Schema.ConstraintDecoder<unknown>>(
  path: string,
  schema: S,
  ignoreExcess = false,
): Effect.fn.Return<S['Type'], NativeRecoveryError> {
  const bytes = yield* io('read-platform-state', path, () => readFile(path))
  const serialized = yield* Effect.try({
    try: () => new TextDecoder('utf-8', { fatal: true }).decode(bytes),
    catch: (cause) =>
      error('decode-platform-state', path, 'Protected state is not valid UTF-8.', cause),
  })
  return yield* Schema.decodeUnknownEffect(Schema.fromJsonString(schema))(serialized, {
    onExcessProperty: ignoreExcess ? 'ignore' : 'error',
  }).pipe(
    Effect.mapError((cause) =>
      error('decode-platform-state', path, 'Protected state is malformed or unsupported.', cause),
    ),
  )
})
const realDirectory = Effect.fnUntraced(function* (path: string) {
  const info = yield* missing(io('stat-platform-directory', path, () => lstat(path)))
  if (!info) return false
  if (!info.isDirectory() || info.isSymbolicLink())
    return yield* error(
      'platform-directory',
      path,
      'A protected directory is foreign or unverifiable.',
    )
  return true
})
const rejectEntry = (path: string) =>
  error(
    'platform-protected-state',
    path,
    'Existing or uncertain recovery state remains read-only on this platform.',
  )
const artifactName = (name: string) => (process.platform === 'win32' ? name.toLowerCase() : name)

/** Denial-only worker guard. This never creates a capability or normalizes imported cursor metadata. */
export const assertOrdinaryRecoveryStateEffect = Effect.fn('NativeRecoveryPlatform.inspect')(
  function* (userData: string): Effect.fn.Return<void, NativeRecoveryError> {
    const directory = resolve(userData)
    for (let parent = directory; ; parent = dirname(parent)) {
      yield* realDirectory(parent)
      if (dirname(parent) === parent) break
    }
    if (!(yield* realDirectory(directory))) return
    const entries = yield* io('list-platform-state', directory, () => readdir(directory))
    for (const name of entries) {
      const compared = artifactName(name)
      if (
        compared.startsWith('conversations.recovery-receipts.json') ||
        (compared.startsWith('conversations.json.') && compared.endsWith('.tmp')) ||
        compared.startsWith('native-recovery.') ||
        compared.startsWith('native-recovery-actions.')
      )
        return yield* rejectEntry(join(directory, name))
    }
    for (const name of ['native-recovery', 'native-recovery-actions']) {
      const path = join(directory, name)
      if (!(yield* realDirectory(path))) continue
      const protectedEntries = yield* io('list-protected-state', path, () => readdir(path))
      if (protectedEntries.length) return yield* rejectEntry(join(path, protectedEntries[0]))
    }
    const history = join(directory, 'conversations.json')
    const historyInfo = yield* missing(io('stat-platform-history', history, () => lstat(history)))
    if (historyInfo) {
      if (!historyInfo.isFile() || historyInfo.isSymbolicLink()) return yield* rejectEntry(history)
      // Cursor fields in ordinary history are opaque data, never native authority.
      yield* readJson(history, historySchema, true)
    }
    const source = join(directory, 'source-code')
    if (!(yield* realDirectory(source))) return
    const sourceEntries = yield* io('list-source-protected-state', source, () => readdir(source))
    for (const name of sourceEntries) {
      const compared = artifactName(name)
      if (compared.startsWith('state.json.') || compared.startsWith('incorporation-recovery.json'))
        return yield* rejectEntry(join(source, name))
    }
    const state = join(source, 'state.json')
    const stateInfo = yield* missing(io('stat-source-protected-state', state, () => lstat(state)))
    if (stateInfo) {
      if (!stateInfo.isFile() || stateInfo.isSymbolicLink()) return yield* rejectEntry(state)
      const saved = yield* readJson(state, stateSchema)
      if (saved.recoveryActions?.length) return yield* rejectEntry(state)
    }
    const revisions = join(source, 'revisions')
    if (!(yield* realDirectory(revisions))) return
    const generations = yield* io('list-source-generations', revisions, () => readdir(revisions))
    for (const generation of generations) {
      const path = join(revisions, generation)
      if (!(yield* realDirectory(path))) return yield* rejectEntry(path)
      const names = yield* io('list-source-generation', path, () => readdir(path))
      for (const name of names) {
        const compared = artifactName(name)
        if (compared.startsWith('recovery-action.json')) return yield* rejectEntry(join(path, name))
        if (compared.startsWith('incorporation-recovery.json.'))
          return yield* rejectEntry(join(path, name))
        if (compared !== 'incorporation-recovery.json') continue
        const archive = join(path, name)
        const info = yield* io('stat-source-incorporation', archive, () => lstat(archive))
        if (!info.isFile() || info.isSymbolicLink()) return yield* rejectEntry(archive)
        const saved = yield* readJson(
          archive,
          Schema.Struct({
            format: Schema.Literal(1),
            originalState: stateSchema,
            originalGeneration: Schema.Natural,
          }),
        )
        if (saved.originalState.recoveryActions?.length) return yield* rejectEntry(archive)
      }
    }
  },
)

export const validateNativeRecoveryPlatformPolicyEffect = Effect.fnUntraced(function* (
  policy: unknown,
) {
  if (!Predicate.isObject(policy) || !issuedPolicies.has(policy))
    return yield* error('platform-policy', '', 'Recovery platform policy was not issued by Main.')
  return policy as unknown as NativeRecoveryPlatformPolicy
})

function issue(
  mode: NativeRecoveryPlatformMode,
  options: NativeRecoveryPlatformOptions,
  semaphore: Semaphore.Semaphore,
  failure?: NativeRecoveryError,
): NativeRecoveryPlatformPolicy {
  options = Object.freeze({
    userData: resolve(options.userData),
    exclusiveRuntime: options.exclusiveRuntime === true,
  })
  const message =
    failure?.message ??
    (mode === 'unsupported-clean'
      ? 'Active recovery is unavailable on Windows. Fresh SSH sessions use attached connections.'
      : undefined)
  const guard = Effect.fnUntraced(function* () {
    if (failure) return yield* failure
    if (mode !== 'unsupported-clean') return
    if (!options.exclusiveRuntime)
      return yield* error(
        'platform-ownership',
        options.userData,
        'Exclusive application ownership is required.',
      )
    yield* assertOrdinaryRecoveryStateEffect(options.userData)
  })
  const checked = (effect: Effect.Effect<void, NativeRecoveryError>) =>
    semaphore.withPermits(1)(effect)
  const policy: NativeRecoveryPlatformPolicy = Object.freeze({
    [policyBrand]: true as const,
    mode,
    status: Object.freeze({ mode, ...(message ? { message } : {}) }),
    sourcePersistenceMode:
      mode === 'durable'
        ? 'native-protected'
        : mode === 'unsupported-clean'
          ? 'ordinary'
          : 'read-only',
    ...(failure ? { error: failure } : {}),
    assertFreshSshStartEffect: Effect.fn('NativeRecoveryPlatform.freshSsh')(function* (
      transport: 'ssh' | 'local' = 'ssh',
    ) {
      yield* checked(guard())
      if (mode === 'unsupported-clean' && transport !== 'ssh')
        return yield* error(
          'platform-local',
          options.userData,
          'Fresh local providers are unavailable in this platform mode.',
        )
    }),
    assertOrdinarySourceWriteEffect: Effect.fnUntraced(function* (directory?: string) {
      if (directory !== undefined && resolve(directory) !== join(options.userData, 'source-code'))
        return yield* error(
          'platform-source-owner',
          directory,
          'The source directory does not belong to this platform admission.',
        )
      yield* checked(guard())
    }),
    assertOrdinaryHistoryWriteEffect: Effect.fnUntraced(function* (directory?: string) {
      if (directory !== undefined && resolve(directory) !== options.userData)
        return yield* error(
          'platform-history-owner',
          directory,
          'The history directory does not belong to this platform admission.',
        )
      yield* checked(guard())
    }),
    assertNativeRecoveryEffect: Effect.fn('NativeRecoveryPlatform.native')(function* (
      operation = 'native-recovery',
    ) {
      if (failure) return yield* failure
      if (mode !== 'durable')
        return yield* error(
          operation,
          options.userData,
          'Native recovery is unsupported on this platform.',
        )
    }),
  })
  issuedPolicies.add(policy)
  return policy
}

export const blockedNativeRecoveryPlatformPolicy = (
  userData: string,
  cause: unknown,
): NativeRecoveryPlatformPolicy =>
  issue(
    'blocked',
    { userData, exclusiveRuntime: false },
    Semaphore.makeUnsafe(1),
    cause instanceof NativeRecoveryError
      ? cause
      : error(
          'platform-initialize',
          userData,
          'Recovery storage is unavailable; protected state was preserved.',
          cause,
        ),
  )

export class NativeRecoveryPlatform extends Context.Service<
  NativeRecoveryPlatform,
  NativeRecoveryPlatformPolicy
>()('life/main/NativeRecoveryPlatform') {
  static readonly make = Effect.fn('NativeRecoveryPlatform.make')(function* (
    options: NativeRecoveryPlatformOptions,
  ) {
    options = Object.freeze({
      userData: resolve(options.userData),
      exclusiveRuntime: options.exclusiveRuntime === true,
    })
    const semaphore = yield* Semaphore.make(1)
    if (process.platform !== 'win32') return issue('durable', options, semaphore)
    if (!options.exclusiveRuntime)
      return blockedNativeRecoveryPlatformPolicy(
        options.userData,
        error(
          'platform-ownership',
          options.userData,
          'Exclusive application ownership is required.',
        ),
      )
    const inspected = yield* Effect.exit(assertOrdinaryRecoveryStateEffect(options.userData))
    if (inspected._tag === 'Failure') {
      return yield* Effect.failCause(inspected.cause).pipe(
        Effect.catch((failure) =>
          Effect.succeed(blockedNativeRecoveryPlatformPolicy(options.userData, failure)),
        ),
      )
    }
    return issue('unsupported-clean', options, semaphore)
  })
  static layer(options: NativeRecoveryPlatformOptions) {
    return Layer.effect(NativeRecoveryPlatform, NativeRecoveryPlatform.make(options))
  }
}
export const assessNativeRecoveryPlatformEffect = NativeRecoveryPlatform.make
