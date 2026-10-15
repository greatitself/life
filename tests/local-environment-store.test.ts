import { afterEach, describe, expect, it } from 'vitest'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { Store } from '../src/main/store'
import type { ConnectionProfile } from '../src/shared/types'

const roots: string[] = []
afterEach(async () => {
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true })
})
async function setup() {
  const root = await mkdtemp(join(tmpdir(), 'life-local-identity-test-'))
  roots.push(root)
  const store = new Store(root)
  await store.init()
  return { root, store }
}
const remote: ConnectionProfile = {
  id: 'existing-remote-machine',
  name: 'Existing remote machine',
  host: 'example.invalid',
  port: 22,
  username: 'developer',
  auth: 'agent',
  privateKeyPath: '',
  workspace: '/projects/remote',
}

describe('built-in Local environment identity', () => {
  it('appears in a fresh profile and persists the same canonical identity across restarts', async () => {
    const { root, store } = await setup()
    const local = store.localProfile()
    expect(local.transport).toBe('local')
    expect(local.id).toMatch(/^local:[a-f\d-]{36}$/)
    expect(store.list()[0]).toEqual(local)
    expect(store.list().filter((profile) => profile.transport === 'local')).toHaveLength(1)
    const restarted = new Store(root)
    await restarted.init()
    expect(restarted.localProfile()).toEqual(local)
    expect(restarted.selectedProfile()?.id).toBe(local.id)
    expect(await readFile(join(root, 'connections.json'), 'utf8')).toContain(local.id)
  })

  it('separates computer ownership in different persisted Life profiles', async () => {
    const first = await setup()
    const second = await setup()
    expect(first.store.localProfile().id).not.toBe(second.store.localProfile().id)
    expect(() => second.store.save(first.store.localProfile())).toThrow(/local|built-in/i)
    expect(second.store.list()).toEqual([second.store.localProfile()])
  })

  it('preserves existing SSH machines and never stores secrets in the Local profile', async () => {
    const { root, store } = await setup()
    await store.save(remote)
    await store.trust('example.invalid:22', 'SHA256:existing-trust')
    const restarted = new Store(root)
    await restarted.init()
    expect(restarted.list()).toEqual([restarted.localProfile(), remote])
    expect(restarted.hostKey('example.invalid:22')).toBe('SHA256:existing-trust')
    expect(restarted.localProfile()).not.toHaveProperty('password')
    expect(restarted.localProfile()).not.toHaveProperty('passphrase')
  })

  it('protects Local from deletion or forgery while allowing its selected project to persist', async () => {
    const { root, store } = await setup()
    const local = store.localProfile()
    await expect(store.remove(local.id)).rejects.toThrow(/cannot remove|local/i)
    expect(() => store.save({ ...local, host: 'another-host.invalid' })).toThrow(/local|built-in/i)
    expect(() => store.save({ ...local, id: 'forged-local' })).toThrow(/local|built-in/i)
    expect(() => store.save({ ...remote, id: local.id })).toThrow(/local|reserved/i)
    await store.save({ ...local, workspace: '/projects/another-local-project' })
    const restarted = new Store(root)
    await restarted.init()
    expect(restarted.localProfile()).toMatchObject({
      id: local.id,
      transport: 'local',
      workspace: '/projects/another-local-project',
    })
    expect(restarted.list().filter((profile) => profile.transport === 'local')).toHaveLength(1)
  })
})
