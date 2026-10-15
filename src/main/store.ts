import { mkdir, readFile, realpath, stat } from 'node:fs/promises'
import { join, isAbsolute } from 'node:path'
import { homedir, userInfo } from 'node:os'
import { randomUUID } from 'node:crypto'
import { Effect, Option, Predicate, Schema, Semaphore } from 'effect'
import type { ConnectionProfile } from '../shared/types'
import { profileSchema, remoteDirectorySchema } from '../shared/validation'
import { runEffect } from './effect-runtime'
import { atomicSnapshot, persistenceError, persistenceIO } from './persistence-effects'

interface Data {
  profiles: ConnectionProfile[]
  knownHosts: Record<string, string>
  localProfileId: string
  localWorkspace: string
  selectedProfileId?: string
  archive: Record<string, unknown>
  profileEntries: unknown[]
  hostEntries: unknown
}

const storedData = Schema.fromJsonString(
  Schema.Struct({
    profiles: Schema.optional(Schema.Array(Schema.Unknown)),
    knownHosts: Schema.optional(Schema.Unknown),
    localProfileId: Schema.optional(
      Schema.String.check(
        Schema.isPattern(/^local:[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/iu),
      ),
    ),
    localWorkspace: Schema.optional(
      Schema.String.check(
        Schema.isMinLength(1),
        Schema.isMaxLength(4096),
        Schema.isPattern(/^[^\x00-\x1f]*$/u),
        Schema.makeFilter(isAbsolute),
      ),
    ),
    selectedProfileId: Schema.optional(Schema.String),
  }),
)
const decodeStoredData = Schema.decodeUnknownEffect(storedData)
const decodeKnownHosts = Schema.decodeUnknownOption(Schema.Record(Schema.String, Schema.Unknown))
const decodeArchive = Schema.decodeUnknownEffect(
  Schema.fromJsonString(Schema.Record(Schema.String, Schema.Unknown)),
)

export class Store {
  private data: Data = {
    profiles: [],
    knownHosts: {},
    localProfileId: `local:${randomUUID()}`,
    localWorkspace: homedir(),
    archive: {},
    profileEntries: [],
    hostEntries: {},
  }
  private readonly lock = Semaphore.makeUnsafe(1)
  constructor(
    private directory: string,
    private readonly options: { localWorkspace?: string } = {},
  ) {}

  init() {
    return runEffect(this.initEffect())
  }

  readonly initEffect = Effect.fn('Store.init')(function* (this: Store) {
    yield* persistenceIO('mkdir', this.directory, () => mkdir(this.directory, { recursive: true }))
    const path = join(this.directory, 'connections.json')
    const serialized = yield* persistenceIO('read', path, () => readFile(path, 'utf8')).pipe(
      Effect.catchTag('PersistenceError', (error) =>
        (error.cause as NodeJS.ErrnoException).code === 'ENOENT'
          ? Effect.succeed(null)
          : Effect.fail(error),
      ),
    )
    if (serialized === null) {
      this.data.localWorkspace = yield* this.initialLocalWorkspaceEffect()
      yield* this.writeEffect(this.data)
      return
    }
    const raw = yield* decodeStoredData(serialized).pipe(
      Effect.mapError((cause) => persistenceError('decode', path, cause)),
    )
    const archive = yield* decodeArchive(serialized).pipe(
      Effect.mapError((cause) => persistenceError('decode', path, cause)),
    )
    const knownHosts = Option.getOrElse(decodeKnownHosts(raw.knownHosts), () => ({}))
    this.data = {
      profiles: (raw.profiles ?? []).flatMap((p) => {
        const parsed = profileSchema.safeParse(p)
        return parsed.success && parsed.data.transport !== 'local' ? [parsed.data] : []
      }),
      knownHosts: Object.fromEntries(
        Object.entries(knownHosts).filter((entry): entry is [string, string] =>
          Predicate.isString(entry[1]),
        ),
      ),
      localProfileId: raw.localProfileId ?? this.data.localProfileId,
      localWorkspace: raw.localWorkspace ?? (yield* this.initialLocalWorkspaceEffect()),
      ...(raw.selectedProfileId ? { selectedProfileId: raw.selectedProfileId } : {}),
      archive,
      profileEntries: [...(raw.profiles ?? [])],
      hostEntries: Object.hasOwn(raw, 'knownHosts') ? raw.knownHosts : {},
    }
    if (this.data.profiles.some((profile) => profile.id === this.data.localProfileId))
      return yield* persistenceError(
        'decode',
        path,
        new Error('Local environment identity conflicts with a saved SSH profile.'),
      )
    if (
      raw.localProfileId !== this.data.localProfileId ||
      raw.localWorkspace !== this.data.localWorkspace
    )
      yield* this.writeEffect(this.data)
  })

  list() {
    return [this.localProfile(), ...structuredClone(this.data.profiles)]
  }
  localProfile(): ConnectionProfile {
    let username = 'user'
    try {
      username = userInfo().username.replace(/[^a-zA-Z0-9._-]/gu, '') || username
    } catch {
      // Display-only SSH fields do not govern local process credentials.
    }
    return {
      transport: 'local',
      id: this.data.localProfileId,
      name: 'Local',
      host: 'localhost',
      port: 22,
      username: username.slice(0, 100),
      auth: 'agent',
      privateKeyPath: '',
      workspace: this.data.localWorkspace,
    }
  }
  selectedProfile(): ConnectionProfile {
    return (
      this.list().find((profile) => profile.id === this.data.selectedProfileId) ??
      this.localProfile()
    )
  }
  selectionEffect(profileId: string, current: () => boolean = () => true) {
    return this.exclusive(
      Effect.suspend(() => {
        if (!current() || !this.list().some((profile) => profile.id === profileId))
          return Effect.succeed(false)
        return this.saveSelectionEffect(profileId, current)
      }),
    )
  }
  private readonly saveSelectionEffect = Effect.fnUntraced(function* (
    this: Store,
    profileId: string,
    current: () => boolean,
  ) {
    const previous = this.data
    const next = { ...previous, selectedProfileId: profileId }
    if (!(yield* this.writeEffect(next, current))) return false
    if (!current()) {
      yield* this.writeEffect(previous)
      return false
    }
    this.data = next
    return true
  })
  private readonly initialLocalWorkspaceEffect = Effect.fnUntraced(function* (this: Store) {
    const cwd = process.cwd()
    const workingDirectoryIsProject = yield* Effect.tryPromise({
      try: () => stat(join(cwd, '.git')).then(() => true),
      catch: (cause) => persistenceError('check-local-project', cwd, cause),
    }).pipe(Effect.catch(() => Effect.succeed(false)))
    const preferred = this.options.localWorkspace ?? (workingDirectoryIsProject ? cwd : homedir())
    for (const requested of [preferred, homedir()]) {
      const candidate = yield* Effect.tryPromise({
        try: async () => {
          const canonical = await realpath(requested)
          return (await stat(canonical)).isDirectory() &&
            remoteDirectorySchema.safeParse(canonical).success
            ? canonical
            : undefined
        },
        catch: (cause) => persistenceError('resolve-local-workspace', requested, cause),
      }).pipe(Effect.catch(() => Effect.succeed(undefined)))
      if (candidate) return candidate
    }
    return homedir()
  })
  save(profile: ConnectionProfile) {
    const clean = this.cleanProfile(profile)
    return runEffect(this.saveProfileEffect(clean))
  }
  saveEffect(profile: ConnectionProfile) {
    return this.decodeProfileEffect(profile).pipe(
      Effect.flatMap((clean) => this.saveProfileEffect(clean)),
    )
  }
  private saveProfileEffect(profile: ConnectionProfile) {
    return this.exclusive(
      Effect.suspend(() =>
        this.commitEffect({
          ...this.data,
          ...(profile.transport === 'local'
            ? { localWorkspace: profile.workspace }
            : {
                profiles: [...this.data.profiles.filter((p) => p.id !== profile.id), profile],
                profileEntries: this.updatedProfileEntries(this.data.profileEntries, profile),
              }),
        }),
      ),
    )
  }
  /** Publish a selected project only while the renderer that requested it still owns it. */
  saveIfCurrent(profile: ConnectionProfile, current: () => boolean, onCommit: () => void) {
    const clean = this.cleanProfile(profile)
    return runEffect(this.saveCurrentProfileEffect(clean, current, onCommit))
  }
  saveIfCurrentEffect(profile: ConnectionProfile, current: () => boolean, onCommit: () => void) {
    return this.decodeProfileEffect(profile).pipe(
      Effect.flatMap((clean) => this.saveCurrentProfileEffect(clean, current, onCommit)),
    )
  }
  private saveCurrentProfileEffect(
    profile: ConnectionProfile,
    current: () => boolean,
    onCommit: () => void,
  ) {
    const store = this
    return this.exclusive(
      Effect.gen(function* () {
        if (!current()) return false
        const previous = store.data
        const next = {
          ...previous,
          ...(profile.transport === 'local'
            ? { localWorkspace: profile.workspace }
            : {
                profiles: [...previous.profiles.filter((p) => p.id !== profile.id), profile],
                profileEntries: store.updatedProfileEntries(previous.profileEntries, profile),
              }),
        }
        if (!(yield* store.writeEffect(next, current))) return false
        if (!current()) {
          // Cancellation can arrive while the atomic rename is in flight. Restore
          // the last committed snapshot before releasing the serialized write lock.
          yield* store.writeEffect(previous)
          return false
        }
        store.data = next
        onCommit()
        return true
      }),
    )
  }
  remove(id: string) {
    return runEffect(this.removeEffect(id))
  }
  removeEffect(id: string) {
    if (id === this.data.localProfileId)
      return Effect.fail(
        persistenceError(
          'remove-profile',
          this.directory,
          new Error('Local is always available and cannot be removed.'),
        ),
      )
    return this.exclusive(
      Effect.suspend(() =>
        this.commitEffect({
          ...this.data,
          profiles: this.data.profiles.filter((p) => p.id !== id),
          profileEntries: this.data.profileEntries.filter((entry) => {
            const parsed = profileSchema.safeParse(entry)
            return !parsed.success || parsed.data.transport === 'local' || parsed.data.id !== id
          }),
          ...(this.data.selectedProfileId === id
            ? { selectedProfileId: this.data.localProfileId }
            : {}),
        }),
      ),
    )
  }
  hostKey(host: string) {
    return Object.hasOwn(this.data.knownHosts, host) ? this.data.knownHosts[host] : undefined
  }
  trust(host: string, fingerprint: string) {
    return runEffect(this.trustEffect(host, fingerprint))
  }
  trustEffect(host: string, fingerprint: string) {
    return this.exclusive(
      Effect.suspend(() =>
        this.commitEffect({
          ...this.data,
          knownHosts: { ...this.data.knownHosts, [host]: fingerprint },
          hostEntries: {
            ...Option.getOrElse(decodeKnownHosts(this.data.hostEntries), () => ({})),
            [host]: fingerprint,
          },
        }),
      ),
    )
  }
  settled() {
    return runEffect(this.settledEffect())
  }
  settledEffect() {
    // Waiting for a permit survives failed operations and includes their scoped
    // cleanup before recovery can observe the committed state.
    return this.lock.withPermit(Effect.void)
  }

  private exclusive<A, E>(operation: Effect.Effect<A, E>) {
    return this.lock.withPermit(Effect.uninterruptible(operation))
  }
  private decodeProfileEffect(profile: ConnectionProfile) {
    return Effect.try({
      try: () => this.cleanProfile(profile),
      catch: (cause) => persistenceError('validate-profile', this.directory, cause),
    })
  }
  private cleanProfile(profile: ConnectionProfile) {
    const clean = profileSchema.parse(profile)
    if (clean.transport === 'local' || clean.id === this.data.localProfileId) {
      const local = this.localProfile()
      for (const key of [
        'transport',
        'id',
        'name',
        'host',
        'port',
        'username',
        'auth',
        'privateKeyPath',
        'sshConfig',
      ] as const)
        if (clean[key] !== local[key]) throw new Error('Use the built-in Local environment.')
      if (!isAbsolute(clean.workspace)) throw new Error('Choose an absolute Local project path.')
    }
    return clean
  }
  private updatedProfileEntries(entries: unknown[], profile: ConnectionProfile): unknown[] {
    let replaced = false
    const next = entries.map((entry) => {
      const parsed = profileSchema.safeParse(entry)
      if (!parsed.success || parsed.data.transport === 'local' || parsed.data.id !== profile.id)
        return entry
      replaced = true
      const merged = { ...(entry as Record<string, unknown>), ...profile }
      for (const optional of ['sshConfig', 'transport'] as const)
        if (!Object.hasOwn(profile, optional)) delete merged[optional]
      return merged
    })
    return replaced ? next : [...next, profile]
  }
  private readonly commitEffect = Effect.fnUntraced(function* (this: Store, next: Data) {
    yield* this.writeEffect(next)
    this.data = next
  })
  private writeEffect(data: Data, current?: () => boolean) {
    const path = join(this.directory, 'connections.json')
    return atomicSnapshot(
      path,
      JSON.stringify(
        {
          ...data.archive,
          profiles: data.profileEntries.map((entry) => {
            const parsed = profileSchema.safeParse(entry)
            if (!parsed.success || parsed.data.transport === 'local') return entry
            const clean = { ...(entry as Record<string, unknown>) }
            delete clean.password
            delete clean.passphrase
            delete clean.privateKey
            return clean
          }),
          knownHosts: data.hostEntries,
          localProfileId: data.localProfileId,
          localWorkspace: data.localWorkspace,
          ...(data.selectedProfileId ? { selectedProfileId: data.selectedProfileId } : {}),
        },
        null,
        2,
      ),
      current,
    )
  }
}
