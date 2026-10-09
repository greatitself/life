import { describe, expect, it, vi } from 'vitest'
import type { ConnectionProfile, ConnectionState } from '../src/shared/types'
import { ThreadContextController } from '../src/renderer/thread-context'

const profile: ConnectionProfile = {
  id: 'machine',
  name: 'Research machine',
  host: 'research.example',
  port: 22,
  username: 'researcher',
  auth: 'key',
  privateKeyPath: '/keys/id_ed25519',
  workspace: '/srv/other',
}
const thread = {
  id: 'thread',
  profileId: profile.id,
  workspace: '/srv/project',
  remoteId: 'conversation',
}
const connected = (workspace = '/srv/other'): ConnectionState => ({
  status: 'connected',
  profile,
  workspace,
})
function fixture(initial: ConnectionState = connected()) {
  let current = initial
  const client = {
    state: vi.fn(async (): Promise<ConnectionState> => current),
    connect: vi.fn(
      async (input: ConnectionProfile): Promise<ConnectionState> =>
        (current = { status: 'connected', profile: input }),
    ),
    selectWorkspace: vi.fn(
      async (workspace: string): Promise<ConnectionState> => (current = { ...current, workspace }),
    ),
  }
  return { client, state: () => current, setState: (state: ConnectionState) => (current = state) }
}
function deferred<T>() {
  let resolve!: (value: T) => void
  const promise = new Promise<T>((done) => {
    resolve = done
  })
  return { promise, resolve }
}

describe('restoring a thread’s saved machine and project', () => {
  it('opens Research on the saved machine without selecting its directory as an Agents project', async () => {
    const { client } = fixture()
    const research = {
      ...thread,
      purpose: 'research' as const,
      workspace: '/home/researcher/.life/research/goal',
    }
    expect(await new ThreadContextController().restore(research, [profile], client)).toMatchObject({
      kind: 'ready',
      connection: { workspace: '/srv/other' },
    })
    expect(client.connect).not.toHaveBeenCalled()
    expect(client.selectWorkspace).not.toHaveBeenCalled()
  })
  it('selects its original folder without reconnecting the same machine or replacing its conversation', async () => {
    const { client } = fixture()
    const result = await new ThreadContextController().restore(thread, [profile], client)
    expect(result).toMatchObject({ kind: 'ready', connection: { workspace: thread.workspace } })
    expect(client.connect).not.toHaveBeenCalled()
    expect(client.selectWorkspace).toHaveBeenCalledExactlyOnceWith(thread.workspace)
    expect(thread.remoteId).toBe('conversation')
    expect(profile.workspace).toBe('/srv/other')
  })

  it('does no connection or project mutation when the selected context already matches', async () => {
    const { client } = fixture(connected(thread.workspace))
    expect(await new ThreadContextController().restore(thread, [profile], client)).toMatchObject({
      kind: 'ready',
    })
    expect(client.connect).not.toHaveBeenCalled()
    expect(client.selectWorkspace).not.toHaveBeenCalled()
  })

  it('reconnects a saved key or SSH config machine before selecting its project', async () => {
    const { client } = fixture({ status: 'disconnected' })
    const fromConfig = { ...profile, sshConfig: { alias: 'research', path: '/config/ssh' } }
    const order: string[] = []
    client.connect.mockImplementation(async (input) => {
      order.push('machine')
      return { status: 'connected', profile: input }
    })
    client.selectWorkspace.mockImplementation(async (workspace) => {
      order.push('project')
      return { ...connected(workspace), profile: fromConfig }
    })
    expect(await new ThreadContextController().restore(thread, [fromConfig], client)).toMatchObject(
      { kind: 'ready' },
    )
    expect(order).toEqual(['machine', 'project'])
    expect(client.connect).toHaveBeenCalledExactlyOnceWith(fromConfig)
  })

  it('requests unavailable passwords only after the machine has disconnected', async () => {
    const passwordProfile = { ...profile, auth: 'password' as const }
    const { client } = fixture({ status: 'disconnected' })
    expect(await new ThreadContextController().restore(thread, [passwordProfile], client)).toEqual({
      kind: 'credentials',
      profileId: profile.id,
    })
    expect(client.connect).not.toHaveBeenCalled()
    const online = fixture({ ...connected(), profile: passwordProfile })
    expect(
      await new ThreadContextController().restore(thread, [passwordProfile], online.client),
    ).toMatchObject({ kind: 'ready' })
    expect(online.client.connect).not.toHaveBeenCalled()
  })

  it('preserves the original project and offers it in the picker if the folder is unavailable', async () => {
    const { client, state } = fixture()
    client.selectWorkspace.mockRejectedValueOnce(new Error('Folder was moved'))
    expect(await new ThreadContextController().restore(thread, [profile], client)).toEqual({
      kind: 'project',
      profileId: profile.id,
      path: thread.workspace,
      error: 'Folder was moved',
    })
    expect(state().workspace).toBe('/srv/other')
    expect(thread.workspace).toBe('/srv/project')
  })

  it('never adopts the selected folder for an unresolved old provider conversation', async () => {
    const { client } = fixture()
    expect(
      await new ThreadContextController().restore(
        { ...thread, workspace: undefined },
        [profile],
        client,
      ),
    ).toMatchObject({ kind: 'unavailable' })
    expect(client.state).not.toHaveBeenCalled()
    expect(client.selectWorkspace).not.toHaveBeenCalled()
  })

  it('does not disconnect the current machine if the saved machine was removed', async () => {
    const { client } = fixture({ ...connected(), profile: { ...profile, id: 'other' } })
    expect(await new ThreadContextController().restore(thread, [], client)).toMatchObject({
      kind: 'unavailable',
    })
    expect(client.connect).not.toHaveBeenCalled()
  })

  it('asks for key passphrases after a failed automatic login without looping reconnects', async () => {
    const { client } = fixture({ status: 'disconnected' })
    client.connect.mockRejectedValueOnce(new Error('Encrypted key requires a passphrase'))
    expect(await new ThreadContextController().restore(thread, [profile], client)).toEqual({
      kind: 'credentials',
      profileId: profile.id,
    })
    expect(client.connect).toHaveBeenCalledTimes(1)
    expect(client.selectWorkspace).not.toHaveBeenCalled()
  })

  it('deduplicates click and send restoration while the same folder is opening', async () => {
    const { client } = fixture()
    const slow = deferred<ConnectionState>()
    client.selectWorkspace.mockReturnValueOnce(slow.promise)
    const controller = new ThreadContextController()
    const selected = controller.restore(thread, [profile], client)
    const sending = controller.restore(thread, [profile], client)
    expect(sending).toBe(selected)
    await vi.waitFor(() => expect(client.selectWorkspace).toHaveBeenCalledTimes(1))
    slow.resolve(connected(thread.workspace))
    expect(await selected).toMatchObject({ kind: 'ready' })
  })

  it('serializes rapid selections and gives the latest selected thread the final workspace', async () => {
    const { client, setState } = fixture()
    const slow = deferred<ConnectionState>()
    client.selectWorkspace.mockImplementationOnce(() => slow.promise)
    const controller = new ThreadContextController()
    const original = controller.restore(thread, [profile], client)
    await vi.waitFor(() => expect(client.selectWorkspace).toHaveBeenCalledTimes(1))
    const skipped = controller.restore(
      { ...thread, id: 'skipped', workspace: '/srv/skipped' },
      [profile],
      client,
    )
    const latest = controller.restore(
      { ...thread, id: 'latest', workspace: '/srv/latest' },
      [profile],
      client,
    )
    expect(client.selectWorkspace).toHaveBeenCalledTimes(1)
    setState(connected(thread.workspace))
    slow.resolve(connected(thread.workspace))
    expect(await original).toEqual({ kind: 'superseded' })
    expect(await skipped).toEqual({ kind: 'superseded' })
    expect(await latest).toMatchObject({ kind: 'ready', connection: { workspace: '/srv/latest' } })
    expect(client.selectWorkspace.mock.calls.map(([path]) => path)).toEqual([
      '/srv/project',
      '/srv/latest',
    ])
  })

  it('ignores a pending selection result after the user starts a new thread', async () => {
    const { client } = fixture()
    const slow = deferred<ConnectionState>()
    client.selectWorkspace.mockReturnValueOnce(slow.promise)
    const controller = new ThreadContextController()
    const pending = controller.restore(thread, [profile], client)
    await vi.waitFor(() => expect(client.selectWorkspace).toHaveBeenCalledTimes(1))
    controller.cancel()
    slow.resolve(connected(thread.workspace))
    expect(await pending).toEqual({ kind: 'superseded' })
  })

  it('recovers subsequent selections after a connection state lookup failure', async () => {
    const { client } = fixture()
    client.state.mockRejectedValueOnce(new Error('SSH state unavailable'))
    const controller = new ThreadContextController()
    expect(await controller.restore(thread, [profile], client)).toMatchObject({
      kind: 'unavailable',
    })
    expect(await controller.restore(thread, [profile], client)).toMatchObject({ kind: 'ready' })
  })

  it('keeps manual project selection behind a cancelled in-flight restore until its SSH lock is released', async () => {
    const { client, setState, state } = fixture()
    const slow = deferred<ConnectionState>()
    client.selectWorkspace.mockReturnValueOnce(slow.promise)
    const controller = new ThreadContextController()
    const restore = controller.restore(thread, [profile], client)
    await vi.waitFor(() => expect(client.selectWorkspace).toHaveBeenCalledTimes(1))
    controller.cancel()
    expect(controller.busy).toBe(true)
    let manualStarted = false
    const manual = (async () => {
      await controller.settled()
      manualStarted = true
      return client.selectWorkspace('/srv/manually-selected')
    })()
    await Promise.resolve()
    expect(manualStarted).toBe(false)
    setState(connected(thread.workspace))
    slow.resolve(connected(thread.workspace))
    expect(await restore).toEqual({ kind: 'superseded' })
    await manual
    expect(controller.busy).toBe(false)
    expect(state().workspace).toBe('/srv/manually-selected')
    expect(client.selectWorkspace.mock.calls.map(([path]) => path)).toEqual([
      '/srv/project',
      '/srv/manually-selected',
    ])
  })
})
