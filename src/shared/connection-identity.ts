import type { ConnectionProfile } from './types'

/** Local ownership is installation specific; legacy SSH keys retain their format. */
export function connectionMachineIdentity(profile: ConnectionProfile): string {
  return profile.transport === 'local'
    ? JSON.stringify(['local', profile.id])
    : JSON.stringify([profile.host, profile.port, profile.username])
}

export function sameConnectionMachine(
  first: ConnectionProfile | undefined,
  second: ConnectionProfile | undefined,
): boolean {
  return Boolean(
    first && second && connectionMachineIdentity(first) === connectionMachineIdentity(second),
  )
}
