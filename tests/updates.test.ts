import { EventEmitter } from 'node:events'
import { describe, expect, it, vi } from 'vitest'
import { UpdateController, type UpdateTransport } from '../src/main/updater-controller'
import type { UpdateState } from '../src/shared/updates'

class FakeUpdater extends EventEmitter implements UpdateTransport {
  autoDownload = true
  autoInstallOnAppQuit = true
  allowDowngrade = true
  allowPrerelease = true
  disableWebInstaller = false
  disableDifferentialDownload = true
  checkForUpdates = vi.fn(async () => {
    this.emit('checking-for-update')
    this.emit('update-available', { version: '0.3.0' })
  })
  downloadUpdate = vi.fn(async () => {
    this.emit('download-progress', {
      percent: 42,
      transferred: 4200,
      total: 10000,
      bytesPerSecond: 2000,
    })
    this.emit('update-downloaded', { version: '0.3.0' })
    return ['Life-0.3.0-win-x64.exe']
  })
  quitAndInstall = vi.fn()
}

describe('Life update lifecycle', () => {
  it('prepares an available update once and leaves restart to the user', async () => {
    const updater = new FakeUpdater()
    const controller = new UpdateController('0.2.0', vi.fn(), updater)
    const first = controller.prepare()
    expect(controller.prepare()).toBe(first)
    expect(await first).toMatchObject({ status: 'downloaded', autoDownload: true })
    expect(updater.checkForUpdates).toHaveBeenCalledOnce()
    expect(updater.downloadUpdate).toHaveBeenCalledOnce()
    expect(updater.quitAndInstall).not.toHaveBeenCalled()
    await controller.prepare()
    expect(updater.checkForUpdates).toHaveBeenCalledOnce()
    expect(updater.downloadUpdate).toHaveBeenCalledOnce()
    controller.dispose()
  })

  it('respects manual download preference without preventing a requested download', async () => {
    const updater = new FakeUpdater()
    const controller = new UpdateController('0.2.0', vi.fn(), updater)
    controller.setAutoDownload(false)
    expect(await controller.prepare()).toMatchObject({ status: 'available', autoDownload: false })
    expect(updater.downloadUpdate).not.toHaveBeenCalled()
    expect(await controller.download()).toMatchObject({ status: 'downloaded', autoDownload: false })
    expect(updater.quitAndInstall).not.toHaveBeenCalled()
    controller.dispose()
  })

  it('honors consent revoked during a pending metadata check', async () => {
    const updater = new FakeUpdater()
    let finishCheck!: () => void
    updater.checkForUpdates.mockImplementationOnce(
      () => new Promise<void>((resolve) => (finishCheck = resolve)),
    )
    const controller = new UpdateController('0.2.0', vi.fn(), updater)
    const prepared = controller.prepare()
    await Promise.resolve()
    controller.setAutoDownload(false)
    updater.emit('update-available', { version: '0.3.0' })
    finishCheck()
    expect(await prepared).toMatchObject({ status: 'available', autoDownload: false })
    expect(updater.downloadUpdate).not.toHaveBeenCalled()
    controller.dispose()
  })

  it('retries a failed background download and preserves release information', async () => {
    const updater = new FakeUpdater()
    updater.downloadUpdate.mockRejectedValueOnce(new Error('Network connection lost'))
    const controller = new UpdateController('0.2.0', vi.fn(), updater)
    expect(await controller.prepare()).toMatchObject({
      status: 'error',
      version: '0.3.0',
      error: 'Network connection lost',
    })
    expect(await controller.prepare()).toMatchObject({ status: 'downloaded', error: undefined })
    expect(updater.downloadUpdate).toHaveBeenCalledTimes(2)
    expect(updater.quitAndInstall).not.toHaveBeenCalled()
    controller.dispose()
  })

  it('does not prepare a download after a check reports no update', async () => {
    const updater = new FakeUpdater()
    updater.checkForUpdates.mockImplementationOnce(async () => {
      updater.emit('update-not-available', { version: '0.2.0' })
    })
    const controller = new UpdateController('0.2.0', vi.fn(), updater)
    expect(await controller.prepare()).toMatchObject({ status: 'not-available' })
    expect(updater.downloadUpdate).not.toHaveBeenCalled()
    controller.dispose()
  })

  it('cannot start a download after being disposed during preparation', async () => {
    const updater = new FakeUpdater()
    let finishCheck!: () => void
    updater.checkForUpdates.mockImplementationOnce(
      () => new Promise<void>((resolve) => (finishCheck = resolve)),
    )
    const controller = new UpdateController('0.2.0', vi.fn(), updater)
    const prepared = controller.prepare()
    await Promise.resolve()
    updater.emit('update-available', { version: '0.3.0' })
    controller.dispose()
    finishCheck()
    await expect(prepared).rejects.toThrow('The updater has closed')
    expect(updater.downloadUpdate).not.toHaveBeenCalled()
  })

  it('does not start queued transport IO after disposal before the first microtask', async () => {
    const checkingUpdater = new FakeUpdater()
    const checking = new UpdateController('0.2.0', vi.fn(), checkingUpdater)
    const check = checking.check()
    checking.dispose()
    await check
    expect(checkingUpdater.checkForUpdates).not.toHaveBeenCalled()

    const downloadingUpdater = new FakeUpdater()
    const downloading = new UpdateController('0.2.0', vi.fn(), downloadingUpdater)
    await downloading.check()
    const download = downloading.download()
    downloading.dispose()
    await download
    expect(downloadingUpdater.downloadUpdate).not.toHaveBeenCalled()
  })

  it('allows differential progress to restart for a full fallback and waits for verification', async () => {
    const updater = new FakeUpdater()
    let finishDownload!: () => void
    updater.downloadUpdate.mockImplementationOnce(
      () => new Promise<string[]>((resolve) => (finishDownload = () => resolve(['Life.exe']))),
    )
    const controller = new UpdateController('0.2.0', vi.fn(), updater)
    await controller.check()
    const downloading = controller.download()
    await Promise.resolve()
    updater.emit('download-progress', {
      percent: 85,
      transferred: 850,
      total: 1000,
      bytesPerSecond: 250,
    })
    updater.emit('download-progress', {
      percent: 3,
      transferred: 300,
      total: 10000,
      bytesPerSecond: 1500,
    })
    expect(controller.getState()).toMatchObject({
      status: 'downloading',
      progress: { percent: 3, total: 10000, transferred: 300, bytesPerSecond: 1500 },
    })
    updater.emit('download-progress', {
      percent: 100,
      transferred: 10000,
      total: 10000,
      bytesPerSecond: 1500,
    })
    expect(controller.getState().status).toBe('downloading')
    expect(() => controller.install()).toThrow('Download an update')
    updater.emit('update-downloaded', { version: '0.3.0' })
    finishDownload()
    await downloading
    expect(controller.getState().status).toBe('downloaded')
    controller.dispose()
  })

  it('checks a release without downloading or installing until the user asks', async () => {
    const updater = new FakeUpdater()
    const states: UpdateState[] = []
    const controller = new UpdateController('0.2.0', (state) => states.push(state), updater)
    expect(updater.autoDownload).toBe(false)
    expect(updater.autoInstallOnAppQuit).toBe(false)
    expect(updater.allowDowngrade).toBe(false)
    expect(updater.allowPrerelease).toBe(false)
    expect(updater.disableWebInstaller).toBe(true)
    expect(updater.disableDifferentialDownload).toBe(false)
    expect(await controller.check()).toMatchObject({
      status: 'available',
      currentVersion: '0.2.0',
      version: '0.3.0',
    })
    expect(updater.downloadUpdate).not.toHaveBeenCalled()
    expect(updater.quitAndInstall).not.toHaveBeenCalled()
    expect(await controller.download()).toMatchObject({ status: 'downloaded', version: '0.3.0' })
    expect(states.some((state) => state.progress?.percent === 42)).toBe(true)
    expect(updater.quitAndInstall).not.toHaveBeenCalled()
    controller.install()
    expect(updater.quitAndInstall).toHaveBeenCalledWith(true, true)
    controller.dispose()
  })

  it('uses manual updates for an unsupported installation', async () => {
    const controller = new UpdateController('0.2.0', vi.fn(), undefined, 'Install the NSIS build.')
    expect(await controller.check()).toEqual({
      status: 'unsupported',
      currentVersion: '0.2.0',
      autoDownload: true,
      message: 'Install the NSIS build.',
      progress: undefined,
    })
    expect(await controller.download()).toMatchObject({ status: 'unsupported' })
    expect(() => controller.install()).toThrow('Download an update')
  })

  it('coalesces concurrent checks and downloads instead of starting duplicate requests', async () => {
    const updater = new FakeUpdater()
    let finishCheck!: () => void
    updater.checkForUpdates.mockImplementationOnce(
      () => new Promise<void>((resolve) => (finishCheck = resolve)),
    )
    const controller = new UpdateController('0.2.0', vi.fn(), updater)
    const first = controller.check()
    const second = controller.check()
    expect(first).toBe(second)
    await Promise.resolve()
    expect(updater.checkForUpdates).toHaveBeenCalledOnce()
    updater.emit('update-available', { version: '0.3.0' })
    finishCheck()
    await first

    let finishDownload!: () => void
    updater.downloadUpdate.mockImplementationOnce(
      () => new Promise<string[]>((resolve) => (finishDownload = () => resolve(['Life.exe']))),
    )
    const download = controller.download()
    expect(controller.download()).toBe(download)
    await Promise.resolve()
    expect(updater.downloadUpdate).toHaveBeenCalledOnce()
    expect(await controller.check()).toMatchObject({ status: 'downloading' })
    expect(updater.checkForUpdates).toHaveBeenCalledOnce()
    updater.emit('update-downloaded', { version: '0.3.0' })
    finishDownload()
    await download
    expect(await controller.check()).toMatchObject({ status: 'downloaded' })
    expect(updater.checkForUpdates).toHaveBeenCalledOnce()
    controller.dispose()
  })

  it('rejects download and restart before an update is available', async () => {
    const updater = new FakeUpdater()
    const controller = new UpdateController('0.2.0', vi.fn(), updater)
    await expect(controller.download()).rejects.toThrow('Check for an available update')
    expect(() => controller.install()).toThrow('Download an update')
    expect(updater.downloadUpdate).not.toHaveBeenCalled()
    expect(updater.quitAndInstall).not.toHaveBeenCalled()
    controller.dispose()
  })

  it('preserves an available update after a failed download so it can be retried', async () => {
    const updater = new FakeUpdater()
    updater.downloadUpdate.mockRejectedValueOnce(new Error('Network connection lost'))
    const controller = new UpdateController('0.2.0', vi.fn(), updater)
    await controller.check()
    expect(await controller.download()).toMatchObject({
      status: 'error',
      version: '0.3.0',
      error: 'Network connection lost',
    })
    expect(() => controller.install()).toThrow('Download an update')
    expect(await controller.download()).toMatchObject({ status: 'downloaded', error: undefined })
    expect(updater.downloadUpdate).toHaveBeenCalledTimes(2)
    controller.dispose()
  })

  it('exposes an offline check error and clears it after the next successful check', async () => {
    const updater = new FakeUpdater()
    updater.checkForUpdates.mockRejectedValueOnce(new Error('Cannot reach GitHub'))
    const controller = new UpdateController('0.2.0', vi.fn(), updater)
    expect(await controller.check()).toMatchObject({
      status: 'error',
      error: 'Cannot reach GitHub',
    })
    expect(await controller.check()).toMatchObject({ status: 'available', error: undefined })
    controller.dispose()
  })

  it('shows the current version when GitHub has no newer release', async () => {
    const updater = new FakeUpdater()
    updater.checkForUpdates.mockImplementationOnce(async () => {
      updater.emit('update-not-available', { version: '0.2.0' })
    })
    const controller = new UpdateController('0.2.0', vi.fn(), updater)
    expect(await controller.check()).toMatchObject({ status: 'not-available', version: undefined })
    await expect(controller.download()).rejects.toThrow('Check for an available update')
    controller.dispose()
  })

  it('removes updater subscriptions when closed', async () => {
    const updater = new FakeUpdater()
    const emit = vi.fn()
    const controller = new UpdateController('0.2.0', emit, updater)
    controller.dispose()
    expect(updater.eventNames()).toEqual([])
    updater.emit('update-available', { version: '9.0.0' })
    expect(emit).not.toHaveBeenCalled()
    await expect(controller.check()).rejects.toThrow('The updater has closed')
    await expect(controller.download()).rejects.toThrow('The updater has closed')
    expect(() => controller.install()).toThrow('The updater has closed')
  })
})
