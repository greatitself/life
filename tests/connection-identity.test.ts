import { describe, expect, it } from 'vitest'
import { connectionMachineIdentity, sameConnectionMachine } from '../src/shared/connection-identity'
import { providerUpdateMachineId } from '../src/shared/provider-updates'
import type { ConnectionProfile, ConnectionState } from '../src/shared/types'

const sshProfile: ConnectionProfile = {
  id: 'ssh-localhost',
  name: 'Local SSH server',
  host: 'localhost',
  port: 22,
  username: 'researcher',
  auth: 'agent',
  privateKeyPath: '',
  workspace: '/project',
}
const localProfile: ConnectionProfile = {
  ...sshProfile,
  id: 'local-installation',
  name: 'Local',
  transport: 'local',
}

describe('connection machine ownership', () => {
  it('preserves legacy SSH ownership keys, including explicitly selected SSH transport', () => {
    const expected = JSON.stringify(['localhost', 22, 'researcher'])
    expect(connectionMachineIdentity(sshProfile)).toBe(expected)
    expect(connectionMachineIdentity({ ...sshProfile, transport: 'ssh' })).toBe(expected)
    expect(
      sameConnectionMachine(sshProfile, { ...sshProfile, transport: 'ssh', id: 'another-alias' }),
    ).toBe(true)
  })

  it('separates Local from SSH even when their host, port, username and saved profile ID match', () => {
    const sameIdSSH = { ...sshProfile, id: localProfile.id }
    expect(connectionMachineIdentity(localProfile)).toBe(
      JSON.stringify(['local', 'local-installation']),
    )
    expect(connectionMachineIdentity(localProfile)).not.toBe(connectionMachineIdentity(sameIdSSH))
    expect(sameConnectionMachine(localProfile, sameIdSSH)).toBe(false)
    expect(sameConnectionMachine(sameIdSSH, localProfile)).toBe(false)
  })

  it('retains Local ownership across saved display metadata and workspace changes', () => {
    const renamed = {
      ...localProfile,
      name: 'This computer',
      host: 'display-only.local',
      port: 2222,
      username: 'display-name',
      workspace: '/another-project',
    }
    expect(connectionMachineIdentity(renamed)).toBe(connectionMachineIdentity(localProfile))
    expect(sameConnectionMachine(localProfile, renamed)).toBe(true)
  })

  it('separates different Local installations with otherwise identical metadata', () => {
    expect(
      sameConnectionMachine(localProfile, { ...localProfile, id: 'another-local-installation' }),
    ).toBe(false)
  })

  it.each([{ host: 'another-machine' }, { port: 2222 }, { username: 'another-user' }])(
    'separates SSH ownership when the endpoint changes: %j',
    (change) => {
      expect(sameConnectionMachine(sshProfile, { ...sshProfile, ...change })).toBe(false)
    },
  )

  it.each([
    [undefined, undefined],
    [undefined, localProfile],
    [sshProfile, undefined],
  ])('does not infer machine ownership from missing profiles', (first, second) => {
    expect(sameConnectionMachine(first, second)).toBe(false)
  })

  it('keeps provider update caches separate for Local and an SSH server on localhost', () => {
    const connection: ConnectionState = {
      status: 'connected',
      profile: localProfile,
      home: '/home/researcher',
    }
    expect(providerUpdateMachineId(connection)).toBe(
      JSON.stringify(['local', 'local-installation', '/home/researcher']),
    )
    expect(providerUpdateMachineId({ ...connection, profile: sshProfile })).toBe(
      JSON.stringify(['localhost', 22, 'researcher', '/home/researcher']),
    )
    expect(providerUpdateMachineId(connection)).not.toBe(
      providerUpdateMachineId({ ...connection, profile: sshProfile }),
    )
  })

  it('retains the Local update cache across display metadata changes but separates home directories', () => {
    const connection: ConnectionState = {
      status: 'connected',
      profile: localProfile,
      home: '/home/researcher',
    }
    expect(
      providerUpdateMachineId({
        ...connection,
        profile: {
          ...localProfile,
          name: 'This computer',
          host: 'display.local',
          username: 'alias',
        },
      }),
    ).toBe(providerUpdateMachineId(connection))
    expect(providerUpdateMachineId({ ...connection, home: '/another-home' })).not.toBe(
      providerUpdateMachineId(connection),
    )
  })

  it('preserves the case-normalized legacy SSH provider update cache key', () => {
    expect(
      providerUpdateMachineId({
        status: 'connected',
        profile: { ...sshProfile, host: 'LOCALHOST', transport: 'ssh' },
        home: '/home/researcher',
      }),
    ).toBe(JSON.stringify(['localhost', 22, 'researcher', '/home/researcher']))
  })

  it.each<ConnectionState>([
    { status: 'disconnected', profile: localProfile, home: '/home/researcher' },
    { status: 'connecting', profile: localProfile, home: '/home/researcher' },
    { status: 'connected', home: '/home/researcher' },
    { status: 'connected', profile: localProfile },
  ])('does not assign an update cache before the connection and home are known', (connection) => {
    expect(providerUpdateMachineId(connection)).toBeUndefined()
  })
})
