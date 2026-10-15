import { afterEach, describe, expect, it, vi } from 'vitest'
import { mkdir } from 'node:fs/promises'
import { join } from 'node:path'
import { SSHConnection } from '../src/main/ssh'
import { Store } from '../src/main/store'
import { LocalFiles } from '../src/main/local-files'
import { ThreadContextController } from '../src/renderer/thread-context'
import { LocalFixture } from './helpers/local-fixture'
import type { ConnectInput, ConnectionState } from '../src/shared/types'

const resources: Array<{ fixture: LocalFixture; connection: SSHConnection }> = []
afterEach(async () => {
  for (const { fixture, connection } of resources.splice(0)) {
    connection.disconnect()
    await fixture.close()
  }
  vi.restoreAllMocks()
})

async function setup() {
  const fixture = await new LocalFixture().start()
  const savedWorkspace = join(fixture.root, 'saved thread project café  ')
  await mkdir(savedWorkspace)
  const store = new Store(join(fixture.root, 'settings'), { localWorkspace: fixture.workspace })
  await store.init()
  const connection = new SSHConnection(store, fixture.options)
  resources.push({ fixture, connection })
  const original = LocalFiles.prototype.realpath
  let release: (() => void) | undefined
  let intercepted = false
  vi.spyOn(LocalFiles.prototype, 'realpath').mockImplementation(function (
    this: LocalFiles,
    path,
    callback,
  ) {
    if (!intercepted && path === fixture.workspace) {
      intercepted = true
      release = () => original.call(this, path, callback)
      return
    }
    original.call(this, path, callback)
  })
  const initial = connection.connect(store.localProfile())
  // Observe a genuine in-flight OS file-access request before the second caller.
  await vi.waitFor(() => expect(release).toBeTypeOf('function'))
  expect(connection.state).toMatchObject({ status: 'connecting' })
  return { fixture, savedWorkspace, store, connection, initial, release: () => release!() }
}

describe.skipIf(process.platform === 'win32')('Local startup and restored thread ownership', () => {
  it('joins initial Local startup before restoring the active thread’s different saved workspace', async () => {
    const value = await setup()
    const connect = vi.spyOn(value.connection, 'connect')
    const thread = {
      id: 'retained-local-thread',
      profileId: value.store.localProfile().id,
      workspace: value.savedWorkspace,
      remoteId: 'original-native-provider-session',
    }
    const restored = new ThreadContextController().restore(thread, value.store.list(), {
      state: async () => value.connection.state,
      connect: (input) => value.connection.connect(input),
      selectWorkspace: (path) => value.connection.selectWorkspace(path),
    })
    await vi.waitFor(() => expect(connect).toHaveBeenCalledOnce())
    value.release()
    expect(await value.initial).toMatchObject({
      status: 'connected',
      workspace: value.fixture.workspace,
    })
    expect(await restored).toMatchObject({
      kind: 'ready',
      connection: {
        status: 'connected',
        profile: { id: thread.profileId, transport: 'local' },
        workspace: value.savedWorkspace,
      },
    })
    expect(value.connection.state.workspace).toBe(value.savedWorkspace)
    expect(thread.remoteId).toBe('original-native-provider-session')
  })

  it('shares the canonical Local acquisition without restarting the environment', async () => {
    const value = await setup()
    const states: ConnectionState[] = []
    const disconnect = vi.spyOn(value.connection, 'disconnect')
    value.connection.on('state', (state) => states.push(state))
    const joined = value.connection.connect({
      ...value.store.localProfile(),
      workspace: '/ignored',
    })
    value.release()
    expect(await joined).toBe(await value.initial)
    expect(states.some((state) => state.status === 'connecting')).toBe(false)
    expect(disconnect).not.toHaveBeenCalled()
    expect(value.connection.state.workspace).toBe(value.fixture.workspace)
  })

  it('rejects forged Local and a different environment without cancelling the legitimate startup', async () => {
    const value = await setup()
    const profile = value.store.localProfile()
    const inputs: ConnectInput[] = [
      { ...profile, name: 'Foreign Local' },
      { ...profile, id: 'local:foreign-installation' },
      { ...profile, host: 'foreign.example' },
      { ...profile, transport: undefined },
      { ...profile, sshConfig: { alias: 'foreign', path: '/foreign/config' } },
      {
        ...profile,
        id: 'ssh-machine',
        transport: undefined,
        host: 'example.invalid',
        auth: 'agent',
      },
    ]
    for (const input of inputs) await expect(value.connection.connect(input)).rejects.toThrow()
    expect(value.connection.state.status).toBe('connecting')
    value.release()
    expect(await value.initial).toMatchObject({
      status: 'connected',
      workspace: value.fixture.workspace,
    })
  })

  it('does not trust a connecting state without its private Local acquisition', async () => {
    const value = await setup()
    value.connection.disconnect()
    value.release()
    await expect(value.initial).rejects.toThrow(/cancelled|closed/)
    value.connection.state = { status: 'connecting', profile: value.store.localProfile() }
    await expect(value.connection.connect(value.store.localProfile())).rejects.toThrow(
      'A connection is already in progress',
    )
  })

  it('cancels every joined waiter on disconnect and never adopts an obsolete startup', async () => {
    const value = await setup()
    const joined = value.connection.connect(value.store.localProfile())
    const failures = Promise.allSettled([value.initial, joined])
    value.connection.disconnect()
    value.release()
    expect((await failures).map((result) => result.status)).toEqual(['rejected', 'rejected'])
    expect(value.connection.state).toEqual({ status: 'disconnected' })
    expect(await value.connection.connect(value.store.localProfile())).toMatchObject({
      status: 'connected',
      workspace: value.fixture.workspace,
    })
  })

  it('does not select a saved project after the restoration intent is cancelled while startup is pending', async () => {
    const value = await setup()
    const controller = new ThreadContextController()
    const connect = vi.spyOn(value.connection, 'connect')
    const selectWorkspace = vi.spyOn(value.connection, 'selectWorkspace')
    const restored = controller.restore(
      {
        id: 'cancelled-thread',
        profileId: value.store.localProfile().id,
        workspace: value.savedWorkspace,
        remoteId: 'original-native-provider-session',
      },
      value.store.list(),
      {
        state: async () => value.connection.state,
        connect: (input) => value.connection.connect(input),
        selectWorkspace: (path) => value.connection.selectWorkspace(path),
      },
    )
    await vi.waitFor(() => expect(connect).toHaveBeenCalledOnce())
    controller.cancel()
    value.release()
    await value.initial
    expect(await restored).toEqual({ kind: 'superseded' })
    expect(selectWorkspace).not.toHaveBeenCalled()
    expect(value.connection.state.workspace).toBe(value.fixture.workspace)
  })
})
