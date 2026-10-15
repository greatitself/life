import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import * as fs from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Store } from '../src/main/store'
import { runEffect } from '../src/main/effect-runtime'
import type { ConnectionProfile } from '../src/shared/types'

vi.mock('node:fs/promises', async (original) => {
  const actual = await original<typeof import('node:fs/promises')>()
  return { ...actual, rename: vi.fn(actual.rename) }
})

const original = await vi.importActual<typeof import('node:fs/promises')>('node:fs/promises')
const roots: string[] = []
const remote: ConnectionProfile = {
  id: 'existing-remote',
  name: 'Existing SSH machine',
  host: 'example.invalid',
  port: 22,
  username: 'developer',
  auth: 'agent',
  privateKeyPath: '',
  workspace: '/projects/remote',
}

beforeEach(() => {
  vi.mocked(fs.rename).mockImplementation(original.rename)
})
afterEach(async () => {
  vi.mocked(fs.rename).mockImplementation(original.rename)
  for (const root of roots.splice(0)) await fs.rm(root, { recursive: true, force: true })
})

function legacyData() {
  return {
    profiles: [
      { ...remote, name: '  Existing SSH machine  ', futureProfile: { exact: ['\r\n', null] } },
      null,
      'opaque-profile',
      { id: 'future-profile', transport: 'future', nativeIdentity: 'future-session-identity' },
      { ...remote, id: 'unreadable-ssh', workspace: { futurePath: '/future/project' } },
    ],
    knownHosts: { 'example.invalid:22': 'SHA256:existing' },
    futureTopLevel: { retained: true, nested: ['exact', null, { value: '\ud800' }] },
  }
}

async function seed(data: unknown) {
  const root = await fs.mkdtemp(join(tmpdir(), 'life-local-store-recovery-'))
  roots.push(root)
  const path = join(root, 'connections.json')
  const serialized = JSON.stringify(data, null, 2)
  await fs.writeFile(path, serialized)
  const store = new Store(root)
  return { root, path, serialized, store }
}

async function persisted(path: string) {
  return JSON.parse(await fs.readFile(path, 'utf8'))
}

function deferred() {
  let resolve!: () => void
  const promise = new Promise<void>((done) => {
    resolve = done
  })
  return { promise, resolve }
}

describe('lossless Local environment migration and selection recovery', () => {
  it('adds built-in Local fields without rewriting raw SSH metadata or discarded display rows', async () => {
    const raw = legacyData()
    const { path, store } = await seed(raw)
    await store.init()

    expect(store.list().filter((profile) => profile.transport !== 'local')).toEqual([remote])
    expect(await persisted(path)).toEqual({
      ...raw,
      localProfileId: store.localProfile().id,
      localWorkspace: store.localProfile().workspace,
    })
    expect(store.hostKey('example.invalid:22')).toBe('SHA256:existing')
  })

  it('retains raw archives through Local project, host pin, and selected environment writes', async () => {
    const raw = legacyData()
    const { root, path, store } = await seed(raw)
    await store.init()
    const local = store.localProfile()
    const project = join(root, 'selected-project')
    await fs.mkdir(project)
    await store.save({ ...local, workspace: project })
    await store.trust('another.invalid:22', 'SHA256:newer')
    await expect(runEffect(store.selectionEffect(remote.id))).resolves.toBe(true)

    expect(await persisted(path)).toEqual({
      ...raw,
      knownHosts: { ...raw.knownHosts, 'another.invalid:22': 'SHA256:newer' },
      localProfileId: local.id,
      localWorkspace: project,
      selectedProfileId: remote.id,
    })
    const restarted = new Store(root)
    await restarted.init()
    expect(restarted.localProfile()).toMatchObject({ id: local.id, workspace: project })
    expect(restarted.selectedProfile().id).toBe(remote.id)
    expect((await persisted(path)).profiles).toEqual(raw.profiles)
  })

  it('keeps legacy SSH prefix IDs executable and owned by their original profile', async () => {
    const ssh = { ...remote, id: 'local:old-import', host: 'localhost' }
    const raw = { ...legacyData(), profiles: [{ ...ssh, futureProfile: 'retained' }] }
    const { root, path, store } = await seed(raw)
    await store.init()
    expect(store.list().find((profile) => profile.id === ssh.id)).toEqual(ssh)
    expect(store.localProfile().id).not.toBe(ssh.id)
    await expect(runEffect(store.selectionEffect(ssh.id))).resolves.toBe(true)
    const restarted = new Store(root)
    await restarted.init()
    expect(restarted.selectedProfile()).toEqual(ssh)
    expect((await persisted(path)).profiles).toEqual(raw.profiles)
  })

  it('clears a removed SSH config alias while preserving unrelated raw profile metadata', async () => {
    const sshConfig = { alias: 'previous-alias', path: '/config/previous' }
    const raw = {
      ...legacyData(),
      profiles: [{ ...remote, sshConfig, futureProfile: { retained: true } }],
    }
    const { root, path, store } = await seed(raw)
    await store.init()
    const manual = { ...remote, host: 'manual-host.invalid' }
    await store.save(manual)
    expect((await persisted(path)).profiles).toEqual([
      { ...manual, futureProfile: { retained: true } },
    ])
    const restarted = new Store(root)
    await restarted.init()
    expect(restarted.list().find((profile) => profile.id === remote.id)).toEqual(manual)
  })

  it.each([null, ['opaque-host-pin', { futureHost: 'future-key-format' }]])(
    'retains opaque host archives (%j) through migration and unrelated Local changes',
    async (knownHosts) => {
      const raw = { ...legacyData(), knownHosts }
      const { root, path, store } = await seed(raw)
      await store.init()
      expect((await persisted(path)).knownHosts).toEqual(knownHosts)
      expect(store.hostKey('0')).toBeUndefined()
      const project = join(root, 'local-project')
      await fs.mkdir(project)
      await store.save({ ...store.localProfile(), workspace: project })
      await runEffect(store.selectionEffect(remote.id))
      expect((await persisted(path)).knownHosts).toEqual(knownHosts)
      const restarted = new Store(root)
      await restarted.init()
      expect((await persisted(path)).knownHosts).toEqual(knownHosts)
      expect(restarted.localProfile().workspace).toBe(project)
    },
  )

  it.each(['', 'local:corrupt-owner', 42, null])(
    'rejects a present corrupt Local identity (%j) without rebinding history or rewriting disk',
    async (localProfileId) => {
      const raw = { ...legacyData(), localProfileId, localWorkspace: '/tmp' }
      const { path, serialized, store } = await seed(raw)
      await expect(store.init()).rejects.toThrow()
      expect(await fs.readFile(path, 'utf8')).toBe(serialized)
    },
  )

  it('rolls back an obsolete selection after rename before a queued pin write can publish it', async () => {
    const raw = legacyData()
    const { root, path, store } = await seed(raw)
    await store.init()
    await runEffect(store.selectionEffect(remote.id))
    const renamed = deferred()
    const release = deferred()
    let current = true
    vi.mocked(fs.rename).mockImplementationOnce(async (...args) => {
      await original.rename(...args)
      renamed.resolve()
      await release.promise
    })
    const pending = runEffect(store.selectionEffect(store.localProfile().id, () => current))
    await renamed.promise
    expect(store.selectedProfile().id).toBe(remote.id)
    current = false
    const queued = store.trust('queued.invalid:22', 'SHA256:queued')
    release.resolve()
    await expect(pending).resolves.toBe(false)
    await queued

    const disk = await persisted(path)
    expect(disk.selectedProfileId).toBe(remote.id)
    expect(disk.profiles).toEqual(raw.profiles)
    expect(disk.futureTopLevel).toEqual(raw.futureTopLevel)
    expect(disk.knownHosts).toEqual({ ...raw.knownHosts, 'queued.invalid:22': 'SHA256:queued' })
    const restarted = new Store(root)
    await restarted.init()
    expect(restarted.selectedProfile().id).toBe(remote.id)
    expect(await fs.readdir(root)).toEqual(['connections.json'])
  })
})
