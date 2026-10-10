import type { UpdateProgress, UpdateState } from '../shared/updates'

export interface UpdateTransport {
  autoDownload: boolean
  autoInstallOnAppQuit: boolean
  allowDowngrade: boolean
  allowPrerelease: boolean
  disableWebInstaller: boolean
  disableDifferentialDownload: boolean
  on(event: string, listener: (...args: any[]) => void): unknown
  removeListener(event: string, listener: (...args: any[]) => void): unknown
  checkForUpdates(): Promise<unknown>
  downloadUpdate(): Promise<unknown>
  quitAndInstall(isSilent?: boolean, isForceRunAfter?: boolean): void
}

/** Stages verified updates ahead of time; installation always requires an explicit restart. */
export class UpdateController {
  private state: UpdateState
  private checking?: Promise<UpdateState>
  private downloading?: Promise<UpdateState>
  private preparing?: Promise<UpdateState>
  private hasUpdate = false
  private disposed = false
  private readonly listeners: [string, (...args: any[]) => void][] = []

  constructor(
    currentVersion: string,
    private readonly emit: (state: UpdateState) => void,
    private readonly transport?: UpdateTransport,
    unsupportedReason = 'This installation uses manual updates.',
  ) {
    this.state = transport
      ? { status: 'idle', currentVersion, autoDownload: true }
      : { status: 'unsupported', currentVersion, autoDownload: true, message: unsupportedReason }
    if (!transport) return
    transport.autoDownload = false
    transport.autoInstallOnAppQuit = false
    transport.allowDowngrade = false
    transport.allowPrerelease = false
    transport.disableWebInstaller = true
    transport.disableDifferentialDownload = false
    this.listen('checking-for-update', () =>
      this.set({ status: 'checking', error: undefined, message: undefined, progress: undefined }),
    )
    this.listen('update-available', (info: { version: string }) => {
      this.hasUpdate = true
      this.set({
        status: 'available',
        version: info.version,
        checkedAt: new Date().toISOString(),
        error: undefined,
        message: undefined,
        progress: undefined,
      })
    })
    this.listen('update-not-available', () => {
      this.hasUpdate = false
      this.set({
        status: 'not-available',
        version: undefined,
        checkedAt: new Date().toISOString(),
        error: undefined,
        message: undefined,
        progress: undefined,
      })
    })
    this.listen('download-progress', (progress: UpdateProgress) =>
      this.set({
        status: 'downloading',
        progress: {
          percent: Math.min(100, Math.max(0, Number(progress.percent) || 0)),
          transferred: Math.max(0, Number(progress.transferred) || 0),
          total: Math.max(0, Number(progress.total) || 0),
          bytesPerSecond: Math.max(0, Number(progress.bytesPerSecond) || 0),
        },
      }),
    )
    this.listen('update-downloaded', (info: { version: string }) =>
      this.set({
        status: 'downloaded',
        version: info.version,
        progress: undefined,
        error: undefined,
        message: undefined,
      }),
    )
    this.listen('error', (error: unknown) => this.fail(error))
  }

  getState(): UpdateState {
    return { ...this.state, progress: this.state.progress ? { ...this.state.progress } : undefined }
  }

  setAutoDownload(enabled: boolean): UpdateState {
    if (this.disposed) throw new Error('The updater has closed.')
    this.set({ autoDownload: enabled })
    return this.getState()
  }

  /** Coalesces startup, periodic, and manual preparation, including a cached installer. */
  prepare(): Promise<UpdateState> {
    if (this.disposed) return Promise.reject(new Error('The updater has closed.'))
    if (this.preparing) return this.preparing
    this.preparing = this.check()
      .then((state) => {
        if (this.disposed) throw new Error('The updater has closed.')
        // Re-read consent after the check: the user can disable downloads while it runs.
        return state.status === 'available' && this.state.autoDownload !== false
          ? this.download()
          : this.getState()
      })
      .finally(() => {
        this.preparing = undefined
      })
    return this.preparing
  }

  check(): Promise<UpdateState> {
    if (this.disposed) return Promise.reject(new Error('The updater has closed.'))
    if (!this.transport || this.downloading || this.state.status === 'downloaded') {
      return Promise.resolve(this.getState())
    }
    if (this.checking) return this.checking
    this.hasUpdate = false
    this.set({
      status: 'checking',
      version: undefined,
      error: undefined,
      message: undefined,
      progress: undefined,
    })
    this.checking = Promise.resolve()
      .then(() => {
        if (this.disposed) throw new Error('The updater has closed.')
        return this.transport!.checkForUpdates()
      })
      .then(() => {
        if (this.state.status === 'checking') {
          this.set({ status: 'idle', message: 'Update check did not return a release. Try again.' })
        }
        return this.getState()
      })
      .catch((error) => {
        this.fail(error)
        return this.getState()
      })
      .finally(() => {
        this.checking = undefined
      })
    return this.checking
  }

  download(): Promise<UpdateState> {
    if (this.disposed) return Promise.reject(new Error('The updater has closed.'))
    if (!this.transport) return Promise.resolve(this.getState())
    if (this.downloading) return this.downloading
    if (this.state.status === 'downloaded') return Promise.resolve(this.getState())
    if (!this.hasUpdate || this.checking) {
      return Promise.reject(new Error('Check for an available update before downloading.'))
    }
    this.set({ status: 'downloading', error: undefined, message: undefined, progress: undefined })
    this.downloading = Promise.resolve()
      .then(() => {
        if (this.disposed) throw new Error('The updater has closed.')
        return this.transport!.downloadUpdate()
      })
      .then(() => this.getState())
      .catch((error) => {
        this.fail(error)
        return this.getState()
      })
      .finally(() => {
        this.downloading = undefined
      })
    return this.downloading
  }

  install(): void {
    if (this.disposed) throw new Error('The updater has closed.')
    if (!this.transport || this.state.status !== 'downloaded') {
      throw new Error('Download an update before installing it.')
    }
    // The user already chose Restart; Windows can replace Life without another installer UI.
    this.transport.quitAndInstall(true, true)
  }

  dispose(): void {
    this.disposed = true
    for (const [event, listener] of this.listeners) this.transport?.removeListener(event, listener)
    this.listeners.length = 0
  }

  private listen(event: string, listener: (...args: any[]) => void): void {
    this.transport?.on(event, listener)
    this.listeners.push([event, listener])
  }

  private fail(error: unknown): void {
    this.set({
      status: 'error',
      error: (error instanceof Error ? error.message : String(error)).slice(0, 2000),
      progress: undefined,
    })
  }

  private set(patch: Partial<UpdateState>): void {
    if (this.disposed) return
    this.state = { ...this.state, ...patch }
    this.emit(this.getState())
  }
}
