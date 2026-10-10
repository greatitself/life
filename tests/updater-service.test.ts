import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const mock = vi.hoisted(() => {
  const listeners = new Map<string, Set<(...args: any[]) => void>>()
  return {
    directory: '',
    listeners,
    updater: {
      autoDownload: true,
      autoInstallOnAppQuit: true,
      allowDowngrade: true,
      allowPrerelease: true,
      disableWebInstaller: false,
      disableDifferentialDownload: true,
      on: vi.fn((event: string, listener: (...args: any[]) => void) => {
        const entries = listeners.get(event) || new Set()
        entries.add(listener)
        listeners.set(event, entries)
      }),
      removeListener: vi.fn((event: string, listener: (...args: any[]) => void) => {
        listeners.get(event)?.delete(listener)
      }),
      checkForUpdates: vi.fn<() => Promise<void>>(),
      downloadUpdate: vi.fn<() => Promise<string[]>>(),
      quitAndInstall: vi.fn(),
    },
  }
})
vi.mock('electron', () => ({
  app: {
    isPackaged: true,
    getVersion: () => '0.11.0',
    getPath: () => mock.directory,
  },
}))
vi.mock('electron-updater', () => ({ default: { autoUpdater: mock.updater } }))

import { UpdatesService } from '../src/main/updater'

const services: UpdatesService[] = []
const platformDescriptor = Object.getOwnPropertyDescriptor(process, 'platform')!
const emit = (event: string, ...args: any[]) => {
  for (const listener of mock.listeners.get(event) || []) listener(...args)
}
async function service() {
  const updates = new UpdatesService(vi.fn())
  services.push(updates)
  await updates.init()
  return updates
}
beforeEach(async () => {
  Object.defineProperty(process, 'platform', { ...platformDescriptor, value: 'win32' })
  mock.directory = await mkdtemp(join(tmpdir(), 'life-update-service-'))
  mock.listeners.clear()
  vi.clearAllMocks()
  vi.stubEnv('APPIMAGE', '/tmp/Life.AppImage')
  vi.useFakeTimers()
  mock.updater.checkForUpdates.mockImplementation(async () => {
    emit('checking-for-update')
    emit('update-available', { version: '0.12.0' })
  })
  mock.updater.downloadUpdate.mockImplementation(async () => {
    emit('update-downloaded', { version: '0.12.0' })
    return ['Life-0.12.0.exe']
  })
})
afterEach(async () => {
  for (const updates of services.splice(0)) updates.dispose()
  vi.useRealTimers()
  Object.defineProperty(process, 'platform', platformDescriptor)
  vi.unstubAllEnvs()
  await rm(mock.directory, { recursive: true, force: true })
})

describe('background Life update preparation', () => {
  it('starts after two seconds and never installs on quit automatically', async () => {
    const updates = await service()
    expect(mock.updater.on).not.toHaveBeenCalled()
    updates.start()
    updates.start()
    await vi.advanceTimersByTimeAsync(1999)
    expect(mock.updater.checkForUpdates).not.toHaveBeenCalled()
    expect(mock.updater.on).not.toHaveBeenCalled()
    await vi.advanceTimersByTimeAsync(1)
    expect(updates.getState()).toMatchObject({ status: 'downloaded', autoDownload: true })
    expect(mock.updater.checkForUpdates).toHaveBeenCalledOnce()
    expect(mock.updater.downloadUpdate).toHaveBeenCalledOnce()
    expect(mock.updater.autoInstallOnAppQuit).toBe(false)
    expect(mock.updater.quitAndInstall).not.toHaveBeenCalled()
  })

  it('coalesces lazy activation when multiple checks arrive together', async () => {
    const updates = await service()
    expect(mock.updater.on).not.toHaveBeenCalled()
    expect(await Promise.all([updates.check(), updates.check(), updates.check()])).toHaveLength(3)
    expect(mock.updater.on).toHaveBeenCalledTimes(6)
    expect(mock.updater.checkForUpdates).toHaveBeenCalledOnce()
    expect(mock.updater.downloadUpdate).toHaveBeenCalledOnce()
  })

  it('does not activate the native updater after disposal while its import is pending', async () => {
    const updates = await service()
    const check = updates.check()
    updates.dispose()
    await expect(check).rejects.toThrow('The updater has closed')
    expect(mock.updater.on).not.toHaveBeenCalled()
    expect(mock.updater.checkForUpdates).not.toHaveBeenCalled()
    expect(mock.updater.downloadUpdate).not.toHaveBeenCalled()
  })

  it('manual-only installations keep preferences without activating the updater', async () => {
    Object.defineProperty(process, 'platform', { ...platformDescriptor, value: 'darwin' })
    const updates = await service()
    updates.start()
    await updates.setAutoDownload(false)
    await vi.advanceTimersByTimeAsync(4 * 60 * 60 * 1000)
    expect(await updates.check()).toMatchObject({ status: 'unsupported', autoDownload: false })
    expect(await updates.download()).toMatchObject({ status: 'unsupported' })
    expect(mock.updater.on).not.toHaveBeenCalled()
    expect(mock.updater.checkForUpdates).not.toHaveBeenCalled()
    expect(mock.updater.downloadUpdate).not.toHaveBeenCalled()
  })

  it('checks again after four hours when no newer release was available', async () => {
    mock.updater.checkForUpdates.mockImplementation(async () => emit('update-not-available'))
    const updates = await service()
    updates.start()
    await vi.advanceTimersByTimeAsync(2000)
    expect(mock.updater.checkForUpdates).toHaveBeenCalledOnce()
    await vi.advanceTimersByTimeAsync(4 * 60 * 60 * 1000 - 2000)
    expect(mock.updater.checkForUpdates).toHaveBeenCalledTimes(2)
    expect(mock.updater.downloadUpdate).not.toHaveBeenCalled()
  })

  it('an explicit check replaces the pending startup check and stages the update', async () => {
    const updates = await service()
    updates.start()
    expect(await updates.check()).toMatchObject({ status: 'downloaded' })
    await vi.advanceTimersByTimeAsync(2000)
    expect(mock.updater.checkForUpdates).toHaveBeenCalledOnce()
    expect(mock.updater.downloadUpdate).toHaveBeenCalledOnce()
  })

  it('loads native opt-out before startup and still permits a manual download', async () => {
    await writeFile(join(mock.directory, 'updates.json'), '{"version":1,"autoDownload":false}')
    const updates = await service()
    updates.start()
    await vi.advanceTimersByTimeAsync(2000)
    expect(updates.getState()).toMatchObject({ status: 'available', autoDownload: false })
    expect(mock.updater.downloadUpdate).not.toHaveBeenCalled()
    expect(await updates.download()).toMatchObject({ status: 'downloaded', autoDownload: false })
    expect(mock.updater.quitAndInstall).not.toHaveBeenCalled()
  })

  it('saves opt-out independently from workspace customizations', async () => {
    const updates = await service()
    await updates.setAutoDownload(false)
    expect(JSON.parse(await readFile(join(mock.directory, 'updates.json'), 'utf8'))).toEqual({
      version: 1,
      autoDownload: false,
    })
    updates.dispose()
    const restarted = await service()
    restarted.start()
    await vi.advanceTimersByTimeAsync(2000)
    expect(restarted.getState()).toMatchObject({ autoDownload: false, status: 'available' })
    expect(mock.updater.downloadUpdate).not.toHaveBeenCalled()
  })

  it('prepares a release after automatic downloads are enabled', async () => {
    await writeFile(join(mock.directory, 'updates.json'), '{"version":1,"autoDownload":false}')
    const updates = await service()
    updates.start()
    await vi.advanceTimersByTimeAsync(2000)
    expect(mock.updater.downloadUpdate).not.toHaveBeenCalled()
    await updates.setAutoDownload(true)
    await vi.advanceTimersByTimeAsync(0)
    expect(mock.updater.downloadUpdate).toHaveBeenCalledOnce()
    expect(updates.getState()).toMatchObject({ status: 'downloaded', autoDownload: true })
  })

  it('returns the current checking state when enabling downloads begins a fresh probe', async () => {
    await writeFile(join(mock.directory, 'updates.json'), '{"version":1,"autoDownload":false}')
    const updates = await service()
    updates.start()
    await vi.advanceTimersByTimeAsync(2000)
    let finishCheck!: () => void
    mock.updater.checkForUpdates.mockImplementationOnce(
      () => new Promise<void>((resolve) => (finishCheck = resolve)),
    )
    expect(await updates.setAutoDownload(true)).toMatchObject({
      autoDownload: true,
      status: 'checking',
    })
    emit('update-available', { version: '0.12.0' })
    finishCheck()
    await vi.advanceTimersByTimeAsync(0)
    expect(updates.getState().status).toBe('downloaded')
  })

  it('a queued opt-out prevents an earlier enable save from starting a download', async () => {
    await writeFile(join(mock.directory, 'updates.json'), '{"version":1,"autoDownload":false}')
    const updates = await service()
    updates.start()
    await Promise.all([updates.setAutoDownload(true), updates.setAutoDownload(false)])
    await vi.advanceTimersByTimeAsync(2000)
    expect(updates.getState()).toMatchObject({ status: 'available', autoDownload: false })
    expect(mock.updater.downloadUpdate).not.toHaveBeenCalled()
  })

  it('removes both scheduled checks on disposal', async () => {
    const updates = await service()
    updates.start()
    updates.dispose()
    await vi.advanceTimersByTimeAsync(8 * 60 * 60 * 1000)
    expect(mock.updater.checkForUpdates).not.toHaveBeenCalled()
    expect(mock.updater.downloadUpdate).not.toHaveBeenCalled()
  })
})
