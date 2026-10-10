import { app } from 'electron'
import { join } from 'node:path'
import type { UpdateState } from '../shared/updates'
import { UpdateController, type UpdateTransport } from './updater-controller'
import { UpdatePreferences } from './update-preferences'

const STARTUP_CHECK_DELAY = 2_000
const UPDATE_CHECK_INTERVAL = 4 * 60 * 60 * 1_000

function unsupportedReason(): string | undefined {
  if (!app.isPackaged) return 'Update checks are available in the installed version of Life.'
  if (process.platform === 'darwin') {
    return 'This macOS build uses manual updates. Download the latest release and replace Life in Applications.'
  }
  if (process.platform === 'linux' && !process.env.APPIMAGE) {
    return 'Use the latest release to update this Linux installation. In-app updates are available with the AppImage.'
  }
  if (process.platform !== 'win32' && process.platform !== 'linux') {
    return 'Download the latest release to update this installation.'
  }
  return undefined
}

export class UpdatesService {
  private controller?: UpdateController
  private loading?: Promise<UpdateController>
  private state: UpdateState
  private startupTimer?: ReturnType<typeof setTimeout>
  private refreshTimer?: ReturnType<typeof setInterval>
  private started = false
  private disposed = false
  private preferenceRevision = 0
  private readonly preferences = new UpdatePreferences(
    join(app.getPath('userData'), 'updates.json'),
  )

  constructor(private readonly emit: (state: UpdateState) => void) {
    const reason = unsupportedReason()
    const currentVersion = app.getVersion()
    this.state = reason
      ? { status: 'unsupported', currentVersion, autoDownload: true, message: reason }
      : { status: 'idle', currentVersion, autoDownload: true }
  }

  async init(): Promise<void> {
    this.updateAutoDownload(await this.preferences.init())
  }

  start(): void {
    if (this.started || this.disposed) return
    this.started = true
    if (this.getState().status === 'unsupported') return
    this.startupTimer = setTimeout(() => {
      this.startupTimer = undefined
      void this.check().catch(() => {})
    }, STARTUP_CHECK_DELAY)
    this.startupTimer.unref()
    this.refreshTimer = setInterval(() => {
      void this.check().catch(() => {})
    }, UPDATE_CHECK_INTERVAL)
    this.refreshTimer.unref()
  }

  getState(): UpdateState {
    return this.controller?.getState() || { ...this.state }
  }

  async check(): Promise<UpdateState> {
    if (this.disposed) throw new Error('The updater has closed.')
    // An explicit check also satisfies the pending startup check.
    if (this.startupTimer) clearTimeout(this.startupTimer)
    this.startupTimer = undefined
    if (this.state.status === 'unsupported') return this.getState()
    return (await this.activate()).prepare()
  }

  async setAutoDownload(enabled: boolean): Promise<UpdateState> {
    if (this.disposed) throw new Error('The updater has closed.')
    const revision = ++this.preferenceRevision
    // Revoking consent takes effect before disk IO, including during an in-flight release check.
    if (!enabled) this.updateAutoDownload(false)
    const saved = await this.preferences.set(enabled)
    if (revision !== this.preferenceRevision) return this.getState()
    this.updateAutoDownload(saved)
    if (enabled && this.started && this.state.status !== 'unsupported') {
      const controller = await this.activate()
      if (revision === this.preferenceRevision && this.getState().autoDownload !== false) {
        if (this.startupTimer) clearTimeout(this.startupTimer)
        this.startupTimer = undefined
        void controller.prepare().catch(() => {})
      }
    }
    return this.getState()
  }

  async download(): Promise<UpdateState> {
    if (this.disposed) throw new Error('The updater has closed.')
    if (this.state.status === 'unsupported') return this.getState()
    return (await this.activate()).download()
  }

  install(): void {
    if (this.disposed) throw new Error('The updater has closed.')
    if (!this.controller) throw new Error('Download an update before installing it.')
    this.controller.install()
  }

  dispose(): void {
    this.disposed = true
    if (this.startupTimer) clearTimeout(this.startupTimer)
    this.startupTimer = undefined
    if (this.refreshTimer) clearInterval(this.refreshTimer)
    this.refreshTimer = undefined
    this.controller?.dispose()
  }

  private updateAutoDownload(enabled: boolean): void {
    if (this.disposed) throw new Error('The updater has closed.')
    if (this.controller) this.controller.setAutoDownload(enabled)
    else {
      this.state = { ...this.state, autoDownload: enabled }
      this.emit({ ...this.state })
    }
  }

  private activate(): Promise<UpdateController> {
    if (this.disposed) return Promise.reject(new Error('The updater has closed.'))
    if (this.controller) return Promise.resolve(this.controller)
    if (this.loading) return this.loading
    // Defer this dependency's initialization until after Life's first paint. Manual-only
    // platforms never load it. The CommonJS default works in Electron's ESM main build.
    this.loading = import('electron-updater')
      .then((module) => {
        if (this.disposed) throw new Error('The updater has closed.')
        const controller = new UpdateController(
          this.state.currentVersion,
          (state) => {
            this.state = state
            this.emit(state)
          },
          module.default.autoUpdater as UpdateTransport,
        )
        this.controller = controller
        controller.setAutoDownload(this.state.autoDownload !== false)
        return controller
      })
      .catch((error) => {
        if (!this.disposed) {
          this.state = {
            ...this.state,
            status: 'error',
            error: (error instanceof Error ? error.message : String(error)).slice(0, 2000),
          }
          this.emit({ ...this.state })
        }
        throw error
      })
      .finally(() => {
        this.loading = undefined
      })
    return this.loading
  }
}
