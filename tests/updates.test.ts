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
  it('checks a release without downloading or installing until the user asks', async () => {
    const updater = new FakeUpdater()
    const states: UpdateState[] = []
    const controller = new UpdateController('0.2.0', (state) => states.push(state), updater)
    expect(updater.autoDownload).toBe(false)
    expect(updater.autoInstallOnAppQuit).toBe(false)
    expect(updater.allowDowngrade).toBe(false)
    expect(updater.allowPrerelease).toBe(false)
    expect(updater.disableWebInstaller).toBe(true)
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
    expect(updater.quitAndInstall).toHaveBeenCalledWith(false, true)
    controller.dispose()
  })

  it('uses manual updates for an unsupported installation', async () => {
    const controller = new UpdateController('0.2.0', vi.fn(), undefined, 'Install the NSIS build.')
    expect(await controller.check()).toEqual({
      status: 'unsupported',
      currentVersion: '0.2.0',
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
