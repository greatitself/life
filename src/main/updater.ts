import { app } from 'electron'
import electronUpdater from 'electron-updater'
import type { UpdateState } from '../shared/updates'
import { UpdateController, type UpdateTransport } from './updater-controller'

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
  private readonly controller: UpdateController
  private startupTimer?: ReturnType<typeof setTimeout>
  private started = false

  constructor(emit: (state: UpdateState) => void) {
    const reason = unsupportedReason()
    // Access the platform updater only for a supported packaged installation.
    // electron-updater is CommonJS; the default import also works in the ESM main build.
    const transport = reason ? undefined : (electronUpdater.autoUpdater as UpdateTransport)
    this.controller = new UpdateController(app.getVersion(), emit, transport, reason)
  }

  start(): void {
    if (this.started) return
    this.started = true
    if (this.getState().status === 'unsupported') return
    this.startupTimer = setTimeout(() => {
      this.startupTimer = undefined
      void this.controller.check().catch(() => {})
    }, 12_000)
    this.startupTimer.unref()
  }

  getState(): UpdateState {
    return this.controller.getState()
  }

  check(): Promise<UpdateState> {
    // An explicit check also satisfies the pending startup check.
    if (this.startupTimer) clearTimeout(this.startupTimer)
    this.startupTimer = undefined
    return this.controller.check()
  }

  download(): Promise<UpdateState> {
    return this.controller.download()
  }

  install(): void {
    this.controller.install()
  }

  dispose(): void {
    if (this.startupTimer) clearTimeout(this.startupTimer)
    this.startupTimer = undefined
    this.controller.dispose()
  }
}
