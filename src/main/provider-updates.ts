import { mkdir, readFile, rename, writeFile } from 'node:fs/promises'
import { dirname } from 'node:path'
import type { ConnectionState, Provider } from '../shared/types'
import {
  compareProviderVersions,
  PROVIDER_UPDATES,
  providerUpdateMachineId,
  providerVersion,
  providerVersionIsPrerelease,
  type ProviderUpdateInfo,
  type ProviderUpdatesState,
} from '../shared/provider-updates'

const DAY = 24 * 60 * 60 * 1000
const RETRY_DELAY = 60 * 1000
const PROVIDERS: Provider[] = ['codex', 'claude']

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
  private readonly fetch: typeof fetch
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
  private readonly abortControllers = new Set<AbortController>()

  constructor(
    private readonly connection: () => ConnectionState,
    private readonly emit: (state: ProviderUpdatesState) => void,
    private readonly options: ProviderUpdatesOptions = {},
  ) {
    this.fetch = options.fetch || fetch
    this.now = options.now || Date.now
    this.timeoutMs = options.timeoutMs ?? 8000
    this.ready = this.loadCache()
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
          ? `${connection.profile.name || connection.profile.host} · ${connection.profile.username}@${connection.profile.host}${connection.profile.port === 22 ? '' : `:${connection.profile.port}`}`
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
      .then(async () => {
        if (this.disposed) return
        await Promise.all(PROVIDERS.map((provider) => this.lookup(provider, force)))
        await this.saveCache()
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
    for (const controller of this.abortControllers) controller.abort()
    this.abortControllers.clear()
  }

  private async lookup(provider: Provider, force: boolean): Promise<void> {
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
    const controller = new AbortController()
    this.abortControllers.add(controller)
    let timeout: ReturnType<typeof setTimeout> | undefined
    try {
      const metadata = await Promise.race([
        this.fetch(PROVIDER_UPDATES[provider].registryUrl, {
          signal: controller.signal,
          redirect: 'error',
          credentials: 'omit',
          headers: { Accept: 'application/json' },
        }).then(async (response) => {
          if (!response.ok) throw new Error(`Release registry returned HTTP ${response.status}.`)
          const reader = response.body?.getReader()
          if (!reader) throw new Error('Release registry returned no metadata.')
          const chunks: Uint8Array[] = []
          let length = 0
          try {
            while (true) {
              const { done, value } = await reader.read()
              if (done) break
              length += value.byteLength
              if (length > 256 * 1024) {
                void reader.cancel().catch(() => {})
                throw new Error('Release metadata exceeded the size limit.')
              }
              chunks.push(value)
            }
          } finally {
            reader.releaseLock()
          }
          const body = Buffer.concat(chunks).toString('utf8')
          const result: unknown = JSON.parse(body)
          const rawVersion =
            typeof result === 'object' && result !== null && 'version' in result
              ? (result as { version: unknown }).version
              : undefined
          const version = typeof rawVersion === 'string' ? providerVersion(rawVersion) : undefined
          if (!version || version !== rawVersion || providerVersionIsPrerelease(version)) {
            throw new Error('Release registry did not return a stable version.')
          }
          return version
        }),
        new Promise<never>((_, reject) => {
          timeout = setTimeout(() => {
            controller.abort()
            reject(new Error('Release check timed out. Try again when the network is available.'))
          }, this.timeoutMs)
        }),
      ])
      if (!this.disposed) {
        this.entries[provider] = {
          version: metadata,
          checkedAt: new Date(this.now()).toISOString(),
          attemptedAt: now,
        }
      }
    } catch (error) {
      if (!this.disposed) {
        this.entries[provider] = {
          ...existing,
          attemptedAt: now,
          error: error instanceof Error ? error.message.slice(0, 400) : 'Release check failed.',
        }
      }
    } finally {
      if (timeout) clearTimeout(timeout)
      this.abortControllers.delete(controller)
    }
  }

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
          .then(() => this.refreshBackground())
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

  private async refreshBackground(): Promise<void> {
    const machineId = providerUpdateMachineId(this.connection())
    if (this.disposed || !machineId) return
    const revision = this.connectionRevision
    try {
      await this.options.refreshInstalled?.()
    } catch (error) {
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
    await this.checkRegistry()
  }

  private async loadCache(): Promise<void> {
    if (!this.options.cachePath) return
    try {
      const raw = await readFile(this.options.cachePath, 'utf8')
      if (raw.length > 4096) return
      const result: unknown = JSON.parse(raw)
      if (typeof result !== 'object' || result === null) return
      for (const provider of PROVIDERS) {
        const entry = (result as Record<string, unknown>)[provider]
        if (typeof entry !== 'object' || entry === null) continue
        const value = entry as Record<string, unknown>
        const version =
          typeof value.version === 'string' ? providerVersion(value.version) : undefined
        const checkedAt = typeof value.checkedAt === 'string' ? value.checkedAt : undefined
        const time = checkedAt ? Date.parse(checkedAt) : NaN
        if (
          version === value.version &&
          version &&
          !providerVersionIsPrerelease(version) &&
          checkedAt &&
          Number.isFinite(time) &&
          time <= this.now()
        ) {
          this.entries[provider] = { version, checkedAt }
        }
      }
    } catch {
      // The cache is optional: malformed or unavailable metadata is checked again online.
    }
  }

  private async saveCache(): Promise<void> {
    if (!this.options.cachePath || this.disposed) return
    const data = Object.fromEntries(
      PROVIDERS.flatMap((provider) => {
        const entry = this.entries[provider]
        return entry?.version && entry.checkedAt
          ? [[provider, { version: entry.version, checkedAt: entry.checkedAt }]]
          : []
      }),
    )
    try {
      await mkdir(dirname(this.options.cachePath), { recursive: true })
      const temporary = `${this.options.cachePath}.${process.pid}.tmp`
      await writeFile(temporary, JSON.stringify(data) + '\n', { mode: 0o600 })
      await rename(temporary, this.options.cachePath)
    } catch {
      // A read-only cache directory must not prevent an update status reaching the renderer.
    }
  }
}
