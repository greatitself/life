import type { ConnectionState, Provider } from './types'

export type ProviderUpdateStatus =
  | 'disconnected'
  | 'not-installed'
  | 'unknown'
  | 'current'
  | 'update-available'
  | 'ahead'
  | 'unavailable'

export interface ProviderUpdateInfo {
  provider: Provider
  status: ProviderUpdateStatus
  installedVersion?: string
  latestVersion?: string
  checkedAt?: string
  stale: boolean
  error?: string
}

export interface ProviderUpdatesState {
  machineId?: string
  machineLabel?: string
  connected: boolean
  checking: boolean
  providers: ProviderUpdateInfo[]
}

export interface ProviderUpdatesAPI {
  get(): Promise<ProviderUpdatesState>
  check(): Promise<ProviderUpdatesState>
  onState(callback: (state: ProviderUpdatesState) => void): () => void
}

export const PROVIDER_UPDATES = {
  codex: {
    name: 'Codex',
    registryUrl: 'https://registry.npmjs.org/@openai%2Fcodex/latest',
    instructionsUrl: 'https://developers.openai.com/codex/cli/',
  },
  claude: {
    name: 'Claude Code',
    registryUrl: 'https://registry.npmjs.org/@anthropic-ai%2Fclaude-code/latest',
    instructionsUrl: 'https://code.claude.com/docs/en/setup#update-claude-code',
  },
} as const

interface Version {
  core: number[]
  prerelease: string[]
  text: string
}

function parseVersion(value: string): Version | undefined {
  const match =
    /(?:^|[^\w.])v?(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-([\da-zA-Z-]+(?:\.[\da-zA-Z-]+)*))?(?:\+([\da-zA-Z-]+(?:\.[\da-zA-Z-]+)*))?(?![\w.+-])/.exec(
      value.trim(),
    )
  if (!match) return undefined
  const core = match.slice(1, 4).map(Number)
  const prerelease = match[4]?.split('.') || []
  if (
    core.some((part) => !Number.isSafeInteger(part)) ||
    prerelease.some((part) => /^\d+$/.test(part) && part.length > 1 && part.startsWith('0'))
  ) {
    return undefined
  }
  return {
    core,
    prerelease,
    text: `${core.join('.')}${match[4] ? `-${match[4]}` : ''}${match[5] ? `+${match[5]}` : ''}`,
  }
}

/** Handles the CLI's human-readable version output without comparing strings lexically. */
export function providerVersion(value: string | undefined): string | undefined {
  return value && value.length <= 2000 ? parseVersion(value)?.text : undefined
}

export function providerVersionIsPrerelease(value: string): boolean {
  return Boolean(parseVersion(value)?.prerelease.length)
}

/** SemVer ordering; build metadata has no bearing on update availability. */
export function compareProviderVersions(a: string, b: string): number | undefined {
  const left = parseVersion(a)
  const right = parseVersion(b)
  if (!left || !right) return undefined
  for (let index = 0; index < 3; index++) {
    if (left.core[index] !== right.core[index]) {
      return left.core[index] > right.core[index] ? 1 : -1
    }
  }
  if (!left.prerelease.length || !right.prerelease.length) {
    return left.prerelease.length === right.prerelease.length ? 0 : left.prerelease.length ? -1 : 1
  }
  for (let index = 0; index < Math.max(left.prerelease.length, right.prerelease.length); index++) {
    const first = left.prerelease[index]
    const second = right.prerelease[index]
    if (first === second) continue
    if (first === undefined || second === undefined) return first === undefined ? -1 : 1
    const firstNumeric = /^\d+$/.test(first)
    const secondNumeric = /^\d+$/.test(second)
    if (firstNumeric && secondNumeric) {
      // Digit counts avoid rounding arbitrarily long numeric prerelease identifiers.
      return first.length !== second.length
        ? first.length > second.length
          ? 1
          : -1
        : first > second
          ? 1
          : -1
    }
    if (firstNumeric !== secondNumeric) return firstNumeric ? -1 : 1
    return first > second ? 1 : -1
  }
  return 0
}

export function providerUpdateMachineId(connection: ConnectionState): string | undefined {
  if (connection.status !== 'connected' || !connection.profile || !connection.home) return undefined
  const { host, port, username } = connection.profile
  return JSON.stringify([host.toLowerCase(), port, username, connection.home])
}

export function providerUpdateCount(state: ProviderUpdatesState): number {
  return state.connected
    ? state.providers.filter((provider) => provider.status === 'update-available').length
    : 0
}

/** Re-notify only when this machine has a different installed/latest version pair. */
export function providerUpdateNotificationKey(state: ProviderUpdatesState): string | undefined {
  const updates = state.providers
    .filter((provider) => provider.status === 'update-available')
    .map((provider) => [provider.provider, provider.installedVersion, provider.latestVersion])
  return state.connected && state.machineId && updates.length
    ? JSON.stringify([state.machineId, updates])
    : undefined
}

export function emptyProviderUpdatesState(): ProviderUpdatesState {
  return {
    connected: false,
    checking: false,
    providers: (['codex', 'claude'] as const).map((provider) => ({
      provider,
      status: 'disconnected',
      stale: false,
    })),
  }
}
