import type { ConnectionProfile, ConnectionState, Provider } from '../shared/types'

export type EnvironmentScope = 'agents' | 'research' | 'customization'

export interface ProviderEnvironmentStatus {
  provider: Provider
  label: 'Codex' | 'Claude Code'
  availability: 'available' | 'missing' | 'unknown'
  detail: string
}

export interface EnvironmentDescription {
  profile?: ConnectionProfile
  status: ConnectionState['status']
  statusLabel: string
  machineName: string
  authority: string
  workspace?: string
  projectName?: string
  scopeLabel: string
  sshAlias?: string
  sshConfigPath?: string
  providerStatuses: ProviderEnvironmentStatus[]
}

const scopeLabels: Record<EnvironmentScope, string> = {
  agents: 'Agents',
  research: 'Research',
  customization: 'Customize Life',
}

const statusLabels: Record<ConnectionState['status'], string> = {
  connected: 'Connected',
  connecting: 'Connecting',
  disconnected: 'Disconnected',
}

function workspacePath(value: string | undefined): string | undefined {
  // Keep meaningful spaces in directory names. An explicitly empty override
  // represents a machine connection without an active project.
  return value?.trim() ? value : undefined
}

function projectName(path: string | undefined): string | undefined {
  if (!path) return undefined
  if (/^\/+$/u.test(path)) return '/'
  if (/^\\+$/u.test(path)) return '\\'
  if (/^[a-z]:[/\\]+$/iu.test(path)) return `${path.slice(0, 2)}${path[2]}`
  return (
    path
      .replace(/[/\\]+$/u, '')
      .split(/[/\\]/u)
      .at(-1) || path
  )
}

function authority(profile: ConnectionProfile | undefined): string {
  if (!profile) return 'No machine selected'
  const host = profile.host
  const withPort = profile.port !== 22
  const formattedHost = withPort && host.includes(':') && !host.startsWith('[') ? `[${host}]` : host
  return `${profile.username ? `${profile.username}@` : ''}${formattedHost}${withPort ? `:${profile.port}` : ''}`
}

function providerStatus(
  provider: Provider,
  connection: ConnectionState,
): ProviderEnvironmentStatus {
  const label = provider === 'codex' ? 'Codex' : 'Claude Code'
  if (connection.status !== 'connected')
    return {
      provider,
      label,
      availability: 'unknown',
      detail: 'Connect to check availability',
    }
  const version = connection[provider]?.trim()
  if (version === 'missing')
    return { provider, label, availability: 'missing', detail: 'Not installed' }
  if (version) return { provider, label, availability: 'available', detail: version }
  return { provider, label, availability: 'unknown', detail: 'Availability not checked' }
}

/** Describe the selected environment without mistaking a saved folder for an active project. */
export function describeEnvironment(
  connection: ConnectionState,
  savedProfile?: ConnectionProfile,
  workspaceOverride?: string,
  scope: EnvironmentScope = 'agents',
): EnvironmentDescription {
  const profile =
    connection.status === 'disconnected'
      ? (savedProfile ?? connection.profile)
      : (connection.profile ?? savedProfile)
  const workspace = workspacePath(
    workspaceOverride !== undefined
      ? workspaceOverride
      : connection.status === 'disconnected'
        ? profile?.workspace
        : connection.workspace,
  )
  return {
    profile,
    status: connection.status,
    statusLabel: statusLabels[connection.status],
    machineName: profile?.name.trim() || profile?.host || 'No environment selected',
    authority: authority(profile),
    workspace,
    projectName: projectName(workspace),
    scopeLabel: scopeLabels[scope],
    sshAlias: profile?.sshConfig?.alias,
    sshConfigPath: profile?.sshConfig?.path,
    providerStatuses: [providerStatus('codex', connection), providerStatus('claude', connection)],
  }
}
