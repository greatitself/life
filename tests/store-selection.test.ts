import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import * as fs from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Store } from '../src/main/store'
import type { ConnectionProfile } from '../src/shared/types'

vi.mock('node:fs/promises', async (original) => {
  const actual = await original<typeof import('node:fs/promises')>()
  return { ...actual, writeFile: vi.fn(actual.writeFile), rename: vi.fn(actual.rename) }
})

const original = await vi.importActual<typeof import('node:fs/promises')>('node:fs/promises')
let directory: string
let store: Store
const profile: ConnectionProfile = {
  id: 'machine',
  name: 'Machine',
  host: 'example',
  port: 22,
  username: 'test',
  auth: 'agent',
  privateKeyPath: '',
  workspace: '/project-b',
}

function deferred() {
  let resolve!: () => void
  const promise = new Promise<void>((done) => {
    resolve = done
  })
  return { promise, resolve }
}

beforeEach(async () => {
  vi.mocked(fs.writeFile).mockImplementation(original.writeFile)
  vi.mocked(fs.rename).mockImplementation(original.rename)
  directory = await fs.mkdtemp(join(tmpdir(), 'life-store-selection-'))
  store = new Store(directory)
  await store.init()
  await store.save(profile)
  await store.trust('example:22', 'SHA256:existing')
  vi.clearAllMocks()
})
afterEach(async () => {
  await fs.rm(directory, { recursive: true, force: true })
})

async function persisted() {
  const reloaded = new Store(directory)
  await reloaded.init()
  return reloaded
}

describe('owned project profile commits', () => {
  it('does not write or publish a selection whose renderer is already obsolete', async () => {
    const commit = vi.fn()
    await expect(
      store.saveIfCurrent({ ...profile, workspace: '/project-a' }, () => false, commit),
    ).resolves.toBe(false)
    expect(fs.writeFile).not.toHaveBeenCalled()
    expect(commit).not.toHaveBeenCalled()
    expect(store.list()[0].workspace).toBe('/project-b')
    expect((await persisted()).list()[0].workspace).toBe('/project-b')
  })

  it('discards a staged profile if ownership is lost while writing it', async () => {
    const started = deferred()
    const release = deferred()
    let current = true
    vi.mocked(fs.writeFile).mockImplementationOnce(async (...args) => {
      started.resolve()
      await release.promise
      await original.writeFile(...args)
    })
    const commit = vi.fn()
    const pending = store.saveIfCurrent(
      { ...profile, workspace: '/project-a' },
      () => current,
      commit,
    )
    await started.promise
    expect(store.list()[0].workspace).toBe('/project-b')
    current = false
    release.resolve()
    await expect(pending).resolves.toBe(false)
    expect(commit).not.toHaveBeenCalled()
    expect(store.list()[0].workspace).toBe('/project-b')
    expect((await persisted()).list()[0].workspace).toBe('/project-b')
    await expect(fs.stat(join(directory, 'connections.json.tmp'))).rejects.toMatchObject({
      code: 'ENOENT',
    })
  })

  it('restores the committed snapshot when cancelled during rename and preserves later unrelated writes', async () => {
    const renamed = deferred()
    const release = deferred()
    let current = true
    vi.mocked(fs.rename).mockImplementationOnce(async (...args) => {
      await original.rename(...args)
      renamed.resolve()
      await release.promise
    })
    const commit = vi.fn()
    const pending = store.saveIfCurrent(
      { ...profile, workspace: '/project-a' },
      () => current,
      commit,
    )
    await renamed.promise
    expect(store.list()[0].workspace).toBe('/project-b')
    current = false
    const newer = store.save({ ...profile, id: 'another-machine', workspace: '/another-project' })
    const trust = store.trust('another:22', 'SHA256:newer')
    const barrier = store.settled()
    release.resolve()
    await expect(pending).resolves.toBe(false)
    await Promise.all([newer, trust, barrier])
    expect(commit).not.toHaveBeenCalled()
    const disk = await persisted()
    expect(disk.list()).toEqual([
      profile,
      { ...profile, id: 'another-machine', workspace: '/another-project' },
    ])
    expect(disk.hostKey('example:22')).toBe('SHA256:existing')
    expect(disk.hostKey('another:22')).toBe('SHA256:newer')
  })

  it('publishes in-memory profile and workspace together only after a durable owned commit', async () => {
    const commit = vi.fn(() => {
      expect(store.list()[0].workspace).toBe('/project-a')
    })
    await expect(
      store.saveIfCurrent({ ...profile, workspace: '/project-a' }, () => true, commit),
    ).resolves.toBe(true)
    expect(commit).toHaveBeenCalledTimes(1)
    expect((await persisted()).list()[0].workspace).toBe('/project-a')
  })

  it('keeps recovery available after a failed save and leaves its prior snapshot authoritative', async () => {
    vi.mocked(fs.writeFile).mockRejectedValueOnce(
      Object.assign(new Error('disk full'), { code: 'ENOSPC' }),
    )
    await expect(store.save({ ...profile, workspace: '/failed-project' })).rejects.toThrow(
      'disk full',
    )
    await expect(store.settled()).resolves.toBeUndefined()
    expect(store.list()[0].workspace).toBe('/project-b')
    expect((await persisted()).list()[0].workspace).toBe('/project-b')
    await store.save({ ...profile, workspace: '/recovered-project' })
    expect((await persisted()).list()[0].workspace).toBe('/recovered-project')
  })
})
