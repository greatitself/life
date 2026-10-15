import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import * as fs from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Effect } from 'effect'
import { Store } from '../src/main/store'
import { runEffect } from '../src/main/effect-runtime'
import type { ConnectionProfile } from '../src/shared/types'

vi.mock('node:fs/promises', async (original) => {
  const actual = await original<typeof import('node:fs/promises')>()
  return {
    ...actual,
    open: vi.fn(actual.open),
    writeFile: vi.fn(actual.writeFile),
    rename: vi.fn(actual.rename),
  }
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
  vi.mocked(fs.open).mockImplementation(original.open)
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
  it('rejects array-shaped host pins while retaining valid sparse host records', async () => {
    const path = join(directory, 'connections.json')
    await fs.writeFile(
      path,
      JSON.stringify({ profiles: [profile], knownHosts: ['SHA256:invalid'] }),
    )
    const invalid = await persisted()
    expect(invalid.list().filter((item) => item.transport !== 'local')).toEqual([profile])
    expect(invalid.hostKey('0')).toBeUndefined()
    await fs.writeFile(
      path,
      JSON.stringify({
        profiles: [profile],
        knownHosts: { 'example:22': 'SHA256:existing', 'damaged:22': 42 },
      }),
    )
    const valid = await persisted()
    expect(valid.hostKey('example:22')).toBe('SHA256:existing')
    expect(valid.hostKey('damaged:22')).toBeUndefined()
  })

  it('serializes native Effect mutations without losing unrelated profile or host changes', async () => {
    const additional = { ...profile, id: 'another-machine', workspace: '/another-project' }
    await runEffect(
      Effect.all(
        [
          store.saveEffect(additional),
          store.trustEffect('another:22', 'SHA256:newer'),
          store.removeEffect(profile.id),
        ],
        { concurrency: 'unbounded' },
      ),
    )
    const disk = await persisted()
    expect(disk.list().filter((item) => item.transport !== 'local')).toEqual([additional])
    expect(disk.hostKey('example:22')).toBe('SHA256:existing')
    expect(disk.hostKey('another:22')).toBe('SHA256:newer')
  })

  it('removes interrupted semaphore waiters while allowing the active commit and later saves to finish', async () => {
    const started = deferred()
    const release = deferred()
    vi.mocked(fs.rename).mockImplementationOnce(async (...args) => {
      started.resolve()
      await release.promise
      return original.rename(...args)
    })
    const active = store.save({ ...profile, workspace: '/active-project' })
    await started.promise
    const controller = new AbortController()
    const interrupted = runEffect(store.saveEffect({ ...profile, id: 'interrupted-machine' }), {
      signal: controller.signal,
    })
    controller.abort()
    await expect(interrupted).rejects.toBeInstanceOf(Error)
    release.resolve()
    await active
    await store.settled()
    expect((await persisted()).list().filter((item) => item.transport !== 'local')).toEqual([
      { ...profile, workspace: '/active-project' },
    ])
    await store.save({ ...profile, workspace: '/later-project' })
    expect(
      (await persisted()).list().filter((item) => item.transport !== 'local')[0].workspace,
    ).toBe('/later-project')
  })

  it('does not let returned profile snapshots mutate committed data or a later save', async () => {
    const saved = { ...profile, sshConfig: { alias: 'project', path: '/config' } }
    await store.save(saved)
    const listed = store.list().filter((item) => item.transport !== 'local')
    listed[0].workspace = '/uncommitted'
    listed[0].sshConfig!.path = '/uncommitted-config'
    listed.length = 0
    expect(store.list().filter((item) => item.transport !== 'local')).toEqual([saved])
    await store.trust('another:22', 'SHA256:newer')
    expect((await persisted()).list().filter((item) => item.transport !== 'local')).toEqual([saved])
  })

  it('does not write or publish a selection whose renderer is already obsolete', async () => {
    const commit = vi.fn()
    await expect(
      store.saveIfCurrent({ ...profile, workspace: '/project-a' }, () => false, commit),
    ).resolves.toBe(false)
    expect(fs.open).not.toHaveBeenCalled()
    expect(commit).not.toHaveBeenCalled()
    expect(store.list().filter((item) => item.transport !== 'local')[0].workspace).toBe(
      '/project-b',
    )
    expect(
      (await persisted()).list().filter((item) => item.transport !== 'local')[0].workspace,
    ).toBe('/project-b')
  })

  it('discards a staged profile if ownership is lost while writing it', async () => {
    const started = deferred()
    const release = deferred()
    let current = true
    vi.mocked(fs.open).mockImplementationOnce(async (...args) => {
      const file = await original.open(...args)
      const write = file.writeFile.bind(file)
      vi.spyOn(file, 'writeFile').mockImplementationOnce(async (...args) => {
        started.resolve()
        await release.promise
        return write(...args)
      })
      return file
    })
    const commit = vi.fn()
    const pending = store.saveIfCurrent(
      { ...profile, workspace: '/project-a' },
      () => current,
      commit,
    )
    await started.promise
    expect(store.list().filter((item) => item.transport !== 'local')[0].workspace).toBe(
      '/project-b',
    )
    current = false
    release.resolve()
    await expect(pending).resolves.toBe(false)
    expect(commit).not.toHaveBeenCalled()
    expect(store.list().filter((item) => item.transport !== 'local')[0].workspace).toBe(
      '/project-b',
    )
    expect(
      (await persisted()).list().filter((item) => item.transport !== 'local')[0].workspace,
    ).toBe('/project-b')
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
    expect(store.list().filter((item) => item.transport !== 'local')[0].workspace).toBe(
      '/project-b',
    )
    current = false
    const newer = store.save({ ...profile, id: 'another-machine', workspace: '/another-project' })
    const trust = store.trust('another:22', 'SHA256:newer')
    const barrier = store.settled()
    release.resolve()
    await expect(pending).resolves.toBe(false)
    await Promise.all([newer, trust, barrier])
    expect(commit).not.toHaveBeenCalled()
    const disk = await persisted()
    expect(disk.list().filter((item) => item.transport !== 'local')).toEqual([
      profile,
      { ...profile, id: 'another-machine', workspace: '/another-project' },
    ])
    expect(disk.hostKey('example:22')).toBe('SHA256:existing')
    expect(disk.hostKey('another:22')).toBe('SHA256:newer')
  })

  it('publishes in-memory profile and workspace together only after a durable owned commit', async () => {
    const commit = vi.fn(() => {
      expect(store.list().filter((item) => item.transport !== 'local')[0].workspace).toBe(
        '/project-a',
      )
    })
    await expect(
      store.saveIfCurrent({ ...profile, workspace: '/project-a' }, () => true, commit),
    ).resolves.toBe(true)
    expect(commit).toHaveBeenCalledTimes(1)
    expect(
      (await persisted()).list().filter((item) => item.transport !== 'local')[0].workspace,
    ).toBe('/project-a')
  })

  it('keeps recovery available after a failed save and leaves its prior snapshot authoritative', async () => {
    const closed = vi.fn()
    vi.mocked(fs.open).mockImplementationOnce(async (...args) => {
      const file = await original.open(...args)
      const close = file.close.bind(file)
      vi.spyOn(file, 'close').mockImplementation(async () => {
        closed()
        await close()
      })
      vi.spyOn(file, 'writeFile').mockRejectedValueOnce(
        Object.assign(new Error('disk full'), { code: 'ENOSPC' }),
      )
      return file
    })
    const failed = store.save({ ...profile, workspace: '/failed-project' })
    await expect(failed).rejects.toMatchObject({
      _tag: 'PersistenceError',
      operation: 'write',
      message: 'disk full',
      cause: { code: 'ENOSPC' },
    })
    await expect(store.settled()).resolves.toBeUndefined()
    expect(closed).toHaveBeenCalledTimes(1)
    expect(await fs.readdir(directory)).toEqual(['connections.json'])
    expect(store.list().filter((item) => item.transport !== 'local')[0].workspace).toBe(
      '/project-b',
    )
    expect(
      (await persisted()).list().filter((item) => item.transport !== 'local')[0].workspace,
    ).toBe('/project-b')
    await store.save({ ...profile, workspace: '/recovered-project' })
    expect(
      (await persisted()).list().filter((item) => item.transport !== 'local')[0].workspace,
    ).toBe('/recovered-project')
  })

  it('removes its staged file after a failed atomic replacement and permits a later save', async () => {
    vi.mocked(fs.rename).mockRejectedValueOnce(
      Object.assign(new Error('disk full'), { code: 'ENOSPC' }),
    )
    await expect(store.save({ ...profile, workspace: '/failed-project' })).rejects.toThrow(
      'disk full',
    )
    expect(await fs.readdir(directory)).toEqual(['connections.json'])
    expect(store.list().filter((item) => item.transport !== 'local')[0].workspace).toBe(
      '/project-b',
    )
    expect(
      (await persisted()).list().filter((item) => item.transport !== 'local')[0].workspace,
    ).toBe('/project-b')
    await store.save({ ...profile, workspace: '/recovered-project' })
    expect(
      (await persisted()).list().filter((item) => item.transport !== 'local')[0].workspace,
    ).toBe('/recovered-project')
  })

  it('rejects a failed flush before replacing the committed profile snapshot', async () => {
    vi.mocked(fs.open).mockImplementationOnce(async (...args) => {
      const file = await original.open(...args)
      vi.spyOn(file, 'sync').mockRejectedValueOnce(
        Object.assign(new Error('flush failed'), { code: 'EIO' }),
      )
      return file
    })
    await expect(store.save({ ...profile, workspace: '/failed-project' })).rejects.toThrow(
      'flush failed',
    )
    expect(fs.rename).not.toHaveBeenCalled()
    expect(await fs.readdir(directory)).toEqual(['connections.json'])
    expect(store.list().filter((item) => item.transport !== 'local')[0].workspace).toBe(
      '/project-b',
    )
    expect(
      (await persisted()).list().filter((item) => item.transport !== 'local')[0].workspace,
    ).toBe('/project-b')
    await store.save({ ...profile, workspace: '/recovered-project' })
    expect(
      (await persisted()).list().filter((item) => item.transport !== 'local')[0].workspace,
    ).toBe('/recovered-project')
  })

  it('creates a private replacement without reusing a stale temporary file', async () => {
    const stale = join(directory, 'connections.json.tmp')
    await fs.writeFile(stale, 'stale checkpoint', { mode: 0o666 })
    await store.save({ ...profile, workspace: '/saved-project' })
    expect(await fs.readFile(stale, 'utf8')).toBe('stale checkpoint')
    expect(
      (await persisted()).list().filter((item) => item.transport !== 'local')[0].workspace,
    ).toBe('/saved-project')
    if (process.platform !== 'win32')
      expect((await fs.stat(join(directory, 'connections.json'))).mode & 0o777).toBe(0o600)
  })
})
