import { mkdir, open, rename, rm, writeFile } from 'node:fs/promises'
import { dirname } from 'node:path'
import { DateTime, Effect, Layer, Option, Schema } from 'effect'
import type { ConnectionState, Provider } from '../shared/types'
import {
  compareProviderVersions,
  providerUpdateMachineId,
  providerVersion,
  type ProviderUpdateInfo,
  type ProviderUpdatesState,
} from '../shared/provider-updates'
import { runEffect } from './effect-runtime'
import { ProviderReleaseRegistry, StableProviderVersion } from './provider-release-registry'

const DAY = 24 * 60 * 60 * 1000
const RETRY_DELAY = 60 * 1000
const PROVIDERS: Provider[] = ['codex', 'claude']
const CachedRelease = Schema.Struct({
  version: StableProviderVersion,
  checkedAt: Schema.String.check(
    Schema.makeFilter((checkedAt) => Option.isSome(DateTime.make(checkedAt))),
  ),
})
const decodeCache = Schema.decodeUnknownEffect(
  Schema.fromJsonString(Schema.Record(Schema.String, Schema.Unknown)),
)
const decodeCachedRelease = Schema.decodeUnknownOption(CachedRelease)

interface RegistryEntry {
  version?: string
  checkedAt?: string
  attemptedAt?: number
  error?: string
}

export interface ProviderUpdatesOptions {
  fetch?: typeof fetch
  now?: () => number
  timeoutMs?: number
  cachePath?: string
  refreshInstalled?: () => Promise<unknown>
}

/** Tracks public releases and read-only CLI discovery without starting a model or changing an installation. */
export class ProviderUpdateController {
  private readonly entries: Partial<Record<Provider, RegistryEntry>> = {}
  private readonly registryLayer: Layer.Layer<ProviderReleaseRegistry>
  private readonly now: () => number
  private readonly timeoutMs: number
  private readonly ready: Promise<void>
  private checking?: Promise<ProviderUpdatesState>
  private background?: Promise<void>
  private machineId?: string
  private versionSignature?: string
  private connectionRevision = 0
  private installedError?: { machineId: string; message: string; attemptedAt: number }
  private disposed = false
  private refreshTimer?: ReturnType<typeof setTimeout>
  private readonly lifetime = new AbortController()

  constructor(
    private readonly connection: () => ConnectionState,
    private readonly emit: (state: ProviderUpdatesState) => void,
    private readonly options: ProviderUpdatesOptions = {},
  ) {
    this.registryLayer = ProviderReleaseRegistry.layer(options.fetch || fetch)
    this.now = options.now || Date.now
    this.timeoutMs = options.timeoutMs ?? 8000
    this.ready = runEffect(this.loadCache())
  }

  getState(): ProviderUpdatesState {
    const connection = this.connection()
    const connected = connection.status === 'connected'
    const machineId = providerUpdateMachineId(connection)
    return {
      connected,
      checking: Boolean(this.checking || this.background),
      machineId,
      machineLabel:
        connected && connection.profile
          ? connection.profile.transport === 'local'
            ? 'Local · This computer'
            : `${connection.profile.name || connection.profile.host} · ${connection.profile.username}@${connection.profile.host}${connection.profile.port === 22 ? '' : `:${connection.profile.port}`}`
          : undefined,
      providers: PROVIDERS.map((provider): ProviderUpdateInfo => {
        const entry = this.entries[provider]
        const rawVersion = connection[provider]
        const installedError =
          this.installedError?.machineId === machineId ? this.installedError : undefined
        const installedVersion =
          connected && !installedError ? providerVersion(rawVersion) : undefined
        const stale = Boolean(
          entry?.version &&
          (entry.error || !entry.checkedAt || this.now() - Date.parse(entry.checkedAt) >= DAY),
        )
        const info = {
          provider,
          installedVersion,
          latestVersion: entry?.version,
          checkedAt: entry?.checkedAt,
          stale,
          error: installedError?.message || entry?.error,
        }
        if (!connected) return { ...info, status: 'disconnected' }
        if (installedError) return { ...info, status: 'unknown' }
        if (/^missing$/i.test(rawVersion?.trim() || '')) return { ...info, status: 'not-installed' }
        if (!installedVersion) return { ...info, status: 'unknown' }
        if (!entry?.version) return { ...info, status: entry?.error ? 'unavailable' : 'unknown' }
        const compared = compareProviderVersions(installedVersion, entry.version)
        return {
          ...info,
          status:
            compared === undefined
              ? 'unknown'
              : compared < 0
                ? 'update-available'
                : compared > 0
                  ? 'ahead'
                  : 'current',
        }
      }),
    }
  }

  /** Called on every machine change; old-machine checks cannot publish old-machine installations. */
  connectionChanged(): void {
    if (this.disposed) return
    const connection = this.connection()
    const machineId = providerUpdateMachineId(connection)
    const signature = JSON.stringify([
      connection.codex,
      connection.claude,
      connection.providerVersionsRevision,
    ])
    const changed = machineId !== this.machineId
    this.machineId = machineId
    if (changed || this.versionSignature !== signature) {
      this.installedError = undefined
      ++this.connectionRevision
    }
    this.versionSignature = signature
    this.emit(this.getState())
    if (changed && machineId) {
      if (this.refreshTimer) clearTimeout(this.refreshTimer)
      this.refreshTimer = undefined
      // SSH connect just detected these versions. The first release lookup needs no duplicate probe.
      void this.ready.then(() => {
        if (!this.disposed && providerUpdateMachineId(this.connection()) === machineId) {
          void this.check().catch(() => {})
        }
      })
      return
    }
    this.scheduleRefresh()
  }

  check(force = false): Promise<ProviderUpdatesState> {
    if (this.disposed) return Promise.reject(new Error('Provider update checks have closed.'))
    if (this.background) return this.background.then(() => this.check(force))
    if (force) this.installedError = undefined
    return this.checkRegistry(force)
  }

  /** Manual version probes can fail before a registry check starts; do not retain a false update badge. */
  markInstalledCheckFailed(error: unknown, expectedConnection: ConnectionState): void {
    const connection = this.connection()
    const machineId = providerUpdateMachineId(connection)
    if (
      this.disposed ||
      !machineId ||
      machineId !== providerUpdateMachineId(expectedConnection) ||
      connection.providerVersionsRevision !== expectedConnection.providerVersionsRevision ||
      connection.codex !== expectedConnection.codex ||
      connection.claude !== expectedConnection.claude
    )
      return
    this.installedError = {
      machineId,
      attemptedAt: this.now(),
      message: `Installed version check failed: ${error instanceof Error ? error.message.slice(0, 300) : 'Try again.'}`,
    }
    this.emit(this.getState())
    this.scheduleRefresh()
  }

  private checkRegistry(force = false): Promise<ProviderUpdatesState> {
    if (this.checking) return this.checking
    const run = this.ready
      .then(() => {
        if (this.disposed) return
        return runEffect(
          Effect.forEach(PROVIDERS, (provider) => this.lookup(provider, force), {
            concurrency: PROVIDERS.length,
            discard: true,
          }).pipe(Effect.andThen(this.saveCache()), Effect.provide(this.registryLayer)),
          { signal: this.lifetime.signal },
        ).catch((error) => {
          if (!this.disposed) throw error
        })
      })
      .finally(() => {
        if (this.checking === run) this.checking = undefined
        if (!this.disposed) {
          this.emit(this.getState())
          this.scheduleRefresh()
        }
      })
      .then(() => this.getState())
    this.checking = run
    this.emit(this.getState())
    return run
  }

  dispose(): void {
    this.disposed = true
    if (this.refreshTimer) clearTimeout(this.refreshTimer)
    this.refreshTimer = undefined
    this.lifetime.abort()
  }

  private readonly lookup = Effect.fn('ProviderUpdateController.lookup')(function* (
    this: ProviderUpdateController,
    provider: Provider,
    force: boolean,
  ) {
    const existing = this.entries[provider]
    const now = this.now()
    const successfulAt = existing?.checkedAt ? Date.parse(existing.checkedAt) : 0
    if (
      !force &&
      existing &&
      ((existing.error &&
        existing.attemptedAt !== undefined &&
        now - existing.attemptedAt < RETRY_DELAY) ||
        (!existing.error && existing.version && now - successfulAt < DAY))
    ) {
      return
    }
    const registry = yield* ProviderReleaseRegistry
    yield* registry.latest(provider, this.timeoutMs).pipe(
      Effect.match({
        onSuccess: (version) => {
          if (!this.disposed) {
            this.entries[provider] = {
              version,
              checkedAt: DateTime.formatIso(DateTime.makeUnsafe(this.now())),
              attemptedAt: now,
            }
          }
        },
        onFailure: (error) => {
          if (!this.disposed) {
            this.entries[provider] = {
              ...existing,
              attemptedAt: now,
              error: error.message.slice(0, 400),
            }
          }
        },
      }),
    )
  })

  private scheduleRefresh(): void {
    if (this.refreshTimer) clearTimeout(this.refreshTimer)
    this.refreshTimer = undefined
    if (
      this.disposed ||
      this.background ||
      this.checking ||
      !providerUpdateMachineId(this.connection())
    )
      return
    const now = this.now()
    const next = this.installedError
      ? this.installedError.attemptedAt + RETRY_DELAY
      : Math.min(
          ...PROVIDERS.map((provider) => {
            const entry = this.entries[provider]
            if (!entry) return now
            return entry.error
              ? (entry.attemptedAt ?? now) + RETRY_DELAY
              : entry.checkedAt
                ? Date.parse(entry.checkedAt) + DAY
                : now
          }),
        )
    this.refreshTimer = setTimeout(
      () => {
        this.refreshTimer = undefined
        this.background = Promise.resolve()
          .then(() => runEffect(this.refreshBackground(), { signal: this.lifetime.signal }))
          .finally(() => {
            this.background = undefined
            if (!this.disposed) {
              this.emit(this.getState())
              this.scheduleRefresh()
            }
          })
        this.emit(this.getState())
        void this.background.catch(() => {})
      },
      Math.max(1, next - now),
    )
    this.refreshTimer.unref()
  }

  private readonly refreshBackground = Effect.fn('ProviderUpdateController.refreshBackground')(
    function* (this: ProviderUpdateController) {
      const machineId = providerUpdateMachineId(this.connection())
      if (this.disposed || !machineId) return
      const revision = this.connectionRevision
      const refreshed = yield* Effect.tryPromise({
        try: () => this.options.refreshInstalled?.() || Promise.resolve(),
        catch: (error) => error,
      }).pipe(Effect.result)
      if (refreshed._tag === 'Failure') {
        const error = refreshed.failure
        if (
          !this.disposed &&
          providerUpdateMachineId(this.connection()) === machineId &&
          revision === this.connectionRevision
        ) {
          this.installedError = {
            machineId,
            attemptedAt: this.now(),
            message: `Installed version check failed: ${error instanceof Error ? error.message.slice(0, 300) : 'Try again.'}`,
          }
        }
        return
      }
      if (this.disposed || providerUpdateMachineId(this.connection()) !== machineId) return
      this.installedError = undefined
      yield* Effect.tryPromise(() => this.checkRegistry())
    },
  )

  private readonly loadCache = Effect.fn('ProviderUpdateController.loadCache')(
    function* (this: ProviderUpdateController) {
      const cachePath = this.options.cachePath
      if (!cachePath) return
      const file = yield* Effect.acquireRelease(
        Effect.tryPromise(() => open(cachePath, 'r')),
        (file) => Effect.promise(() => file.close().catch(() => {})),
      )
      // The optional cache is bounded before allocating or decoding its contents.
      const buffer = Buffer.alloc(4097)
      const { bytesRead } = yield* Effect.tryPromise(() => file.read(buffer, 0, buffer.length, 0))
      if (bytesRead > 4096) return
      const result = yield* decodeCache(buffer.subarray(0, bytesRead).toString('utf8'))
      for (const provider of PROVIDERS) {
        const entry = decodeCachedRelease(result[provider])
        if (
          Option.isSome(entry) &&
          DateTime.toEpochMillis(DateTime.makeUnsafe(entry.value.checkedAt)) <= this.now()
        ) {
          this.entries[provider] = entry.value
        }
      }
    },
    Effect.scoped,
    Effect.ignore,
  )

  private readonly saveCache = Effect.fn('ProviderUpdateController.saveCache')(
    function* (this: ProviderUpdateController) {
      const cachePath = this.options.cachePath
      if (!cachePath || this.disposed) return
      const data = Object.fromEntries(
        PROVIDERS.flatMap((provider) => {
          const entry = this.entries[provider]
          return entry?.version && entry.checkedAt
            ? [[provider, { version: entry.version, checkedAt: entry.checkedAt }]]
            : []
        }),
      )
      yield* Effect.tryPromise(() => mkdir(dirname(cachePath), { recursive: true }))
      const temporary = yield* Effect.acquireRelease(
        Effect.succeed(`${cachePath}.${process.pid}.tmp`),
        (temporary) => Effect.promise(() => rm(temporary, { force: true }).catch(() => {})),
      )
      yield* Effect.tryPromise(() =>
        writeFile(temporary, JSON.stringify(data) + '\n', { mode: 0o600 }),
      )
      yield* Effect.tryPromise(() => rename(temporary, cachePath))
    },
    Effect.scoped,
    Effect.uninterruptible,
    Effect.ignore,
  )
}
