import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { ProviderUpdateController } from '../src/main/provider-updates'
import {
  compareProviderVersions,
  providerUpdateCount,
  providerUpdateMachineId,
  providerUpdateNotificationKey,
  providerVersion,
  PROVIDER_UPDATES,
} from '../src/shared/provider-updates'
import type { ConnectionState } from '../src/shared/types'

const machine = (
  host = 'machine-a',
  codex = 'codex-cli 0.162.0',
  claude = '2.1.278 (Claude Code)',
): ConnectionState => ({
  status: 'connected',
  home: '/home/research',
  profile: {
    id: host,
    name: host,
    host,
    port: 22,
    username: 'research',
    auth: 'agent',
    privateKeyPath: '',
    workspace: '',
  },
  codex,
  claude,
})

const metadata = vi.fn<typeof fetch>(
  async (url) =>
    new Response(
      JSON.stringify({
        version: String(url).includes('codex') ? '0.162.1' : '2.1.296',
      }),
    ),
)

const controllers: ProviderUpdateController[] = []
function controller(
  connection: () => ConnectionState,
  options: ConstructorParameters<typeof ProviderUpdateController>[2] = {},
) {
  const emit = vi.fn()
  const value = new ProviderUpdateController(connection, emit, { fetch: metadata, ...options })
  controllers.push(value)
  return { value, emit }
}
afterEach(() => {
  for (const value of controllers.splice(0)) value.dispose()
  metadata.mockClear()
  vi.useRealTimers()
})

describe('provider CLI version comparison', () => {
  it.each([
    ['codex-cli 0.162.1', '0.162.1'],
    ['2.1.296 (Claude Code)', '2.1.296'],
    ['codex 0.163.0-alpha.12+linux-build', '0.163.0-alpha.12+linux-build'],
    ['v1.2.3', '1.2.3'],
    ['missing', undefined],
    ['unknown', undefined],
    ['1.2', undefined],
    ['1.2.3-alpha.01', undefined],
    ['01.2.3', undefined],
  ])('parses %s without inventing an installed version', (raw, expected) => {
    expect(providerVersion(raw)).toBe(expected)
  })

  it.each([
    ['0.9.0', '0.10.0', -1],
    ['2.1.99', '2.1.296', -1],
    ['1.2.3+first-build', '1.2.3+second', 0],
    ['0.163.0-alpha.1', '0.162.1', 1],
    ['1.2.3-alpha.9', '1.2.3-alpha.10', -1],
    ['1.2.3-alpha', '1.2.3-alpha.1', -1],
    ['1.2.3-alpha.1', '1.2.3-alpha.beta', -1],
    ['1.2.3-beta', '1.2.3', -1],
    ['1.2.3-alpha.999999999999999999', '1.2.3-alpha.1000000000000000000', -1],
    ['broken', '1.2.3', undefined],
  ])('orders %s against %s using semantic versions', (left, right, expected) => {
    expect(compareProviderVersions(left, right)).toBe(expected)
  })
})

describe('provider update status', () => {
  it('queries only trusted public metadata in parallel and does not run a provider', async () => {
    const { value, emit } = controller(() => machine())
    const state = await value.check()
    expect(metadata).toHaveBeenCalledTimes(2)
    expect(metadata.mock.calls.map(([url]) => url)).toEqual([
      PROVIDER_UPDATES.codex.registryUrl,
      PROVIDER_UPDATES.claude.registryUrl,
    ])
    for (const [, options] of metadata.mock.calls) {
      expect(options).toMatchObject({ redirect: 'error', credentials: 'omit' })
    }
    expect(emit.mock.calls[0][0].checking).toBe(true)
    expect(state.checking).toBe(false)
    expect(state.providers.map((provider) => provider.status)).toEqual([
      'update-available',
      'update-available',
    ])
    expect(providerUpdateCount(state)).toBe(2)
    expect(providerUpdateNotificationKey(state)).toContain('machine-a')
  })

  it('distinguishes missing, newer prerelease, and unknown CLI versions', async () => {
    let connection = machine('a', 'missing', '2.2.0-alpha.1 (Claude Code)')
    const { value } = controller(() => connection)
    const state = await value.check()
    expect(state.providers.map((provider) => provider.status)).toEqual(['not-installed', 'ahead'])
    expect(providerUpdateCount(state)).toBe(0)
    expect(providerUpdateNotificationKey(state)).toBeUndefined()
    connection = machine('a', 'unrecognized', '2.1.296 (Claude Code)')
    expect(value.getState().providers.map((provider) => provider.status)).toEqual([
      'unknown',
      'current',
    ])
  })

  it('updates machine scope immediately and guards notifications from a previous machine', async () => {
    let connection = machine()
    const pending: Array<{ url: string; resolve: (response: Response) => void }> = []
    const fetch = vi.fn<typeof globalThis.fetch>(
      (url) =>
        new Promise((resolve) => {
          pending.push({ url: String(url), resolve })
        }),
    )
    const { value, emit } = controller(() => connection, { fetch })
    const check = value.check()
    await vi.waitFor(() => expect(fetch).toHaveBeenCalledTimes(2))
    // Install identity always comes from active state, including while old checks finish.
    connection = machine('machine-b', 'codex-cli 9.0.0', '9.0.0 (Claude Code)')
    value.connectionChanged()
    expect(emit.mock.calls.at(-1)?.[0].machineLabel).toContain('machine-b')
    for (const entry of pending)
      entry.resolve(
        new Response(
          JSON.stringify({ version: entry.url.includes('codex') ? '0.162.1' : '2.1.296' }),
        ),
      )
    await expect(check).resolves.toMatchObject({
      machineLabel: expect.stringContaining('machine-b'),
    })
    expect(value.getState().providers.every((provider) => provider.status === 'ahead')).toBe(true)
  })

  it('clears installed versions and notification counts on disconnect', async () => {
    let connection = machine()
    const { value } = controller(() => connection)
    await value.check()
    connection = { status: 'disconnected' }
    const state = value.getState()
    expect(
      state.providers.every(
        (provider) => provider.status === 'disconnected' && !provider.installedVersion,
      ),
    ).toBe(true)
    expect(providerUpdateCount(state)).toBe(0)
    expect(state.machineId).toBeUndefined()
  })

  it('records failed manual health checks only for the unchanged connected machine', async () => {
    let connection = machine()
    const { value } = controller(() => connection)
    await value.check()
    const previous = connection
    value.markInstalledCheckFailed(new Error('Version probe failed'), connection)
    expect(providerUpdateCount(value.getState())).toBe(0)
    expect(value.getState().providers[0]).toMatchObject({
      status: 'unknown',
      error: expect.stringContaining('Version probe failed'),
    })
    connection = machine('machine-b')
    value.connectionChanged()
    value.markInstalledCheckFailed(new Error('Old machine failed'), previous)
    expect(value.getState().providers[0]).toMatchObject({
      status: 'update-available',
      error: undefined,
    })
    await value.check(true)
    expect(providerUpdateCount(value.getState())).toBe(2)
  })

  it('distinguishes unrelated workspace changes from newer successful version discovery', async () => {
    let connection = { ...machine(), providerVersionsRevision: 1 }
    const { value } = controller(() => connection)
    value.connectionChanged()
    await value.check()
    const expected = connection
    connection = { ...connection, workspace: '/another/project' }
    value.connectionChanged()
    value.markInstalledCheckFailed(new Error('Probe timeout'), expected)
    expect(value.getState().providers[0].status).toBe('unknown')
    connection = { ...connection, providerVersionsRevision: 2 }
    value.connectionChanged()
    value.markInstalledCheckFailed(new Error('Superseded probe failed'), expected)
    expect(value.getState().providers[0]).toMatchObject({
      status: 'update-available',
      error: undefined,
    })
  })

  it('reuses successful metadata for a day and supports an explicit refresh', async () => {
    let now = Date.parse('2026-10-10T10:00:00Z')
    const { value } = controller(() => machine(), { now: () => now })
    await value.check()
    now += 23 * 60 * 60 * 1000
    await value.check()
    expect(metadata).toHaveBeenCalledTimes(2)
    await value.check(true)
    expect(metadata).toHaveBeenCalledTimes(4)
    now += 24 * 60 * 60 * 1000
    expect(value.getState().providers.every((provider) => provider.stale)).toBe(true)
    await value.check()
    expect(metadata).toHaveBeenCalledTimes(6)
  })

  it('preserves last verified metadata during offline checks and retries failures soon', async () => {
    let now = Date.parse('2026-10-10T10:00:00Z')
    let offline = false
    const fetch = vi.fn<typeof globalThis.fetch>(async (url) => {
      if (offline) throw new Error('Offline')
      return metadata(url)
    })
    const { value } = controller(() => machine(), { now: () => now, fetch })
    await value.check()
    offline = true
    const state = await value.check(true)
    expect(state.providers[0]).toMatchObject({
      latestVersion: '0.162.1',
      stale: true,
      error: 'Offline',
    })
    await value.check()
    expect(fetch).toHaveBeenCalledTimes(4)
    now += 60001
    await value.check()
    expect(fetch).toHaveBeenCalledTimes(6)
  })

  it('bounds hung fetches and rejects untrusted metadata without marking missing CLI outdated', async () => {
    vi.useFakeTimers()
    const fetch = vi.fn<typeof globalThis.fetch>(() => new Promise(() => {}))
    const { value } = controller(() => machine('a', 'missing'), { fetch, timeoutMs: 100 })
    const check = value.check()
    await vi.advanceTimersByTimeAsync(101)
    const state = await check
    expect(state.providers[0]).toMatchObject({
      status: 'not-installed',
      error: expect.stringContaining('timed out'),
    })
    expect(state.providers[1].status).toBe('unavailable')
    expect(providerUpdateCount(state)).toBe(0)
  })

  it.each([
    [new Response('bad json'), 'JSON'],
    [new Response(JSON.stringify({ version: '1.2.3-alpha.1' })), 'stable version'],
    [new Response('x'.repeat(256 * 1024 + 1)), 'size limit'],
    [new Response('{}', { status: 503 }), 'HTTP 503'],
  ])('tolerates malformed/offline registry responses %#', async (response, error) => {
    const fetch = vi.fn<typeof globalThis.fetch>(async () => response.clone())
    const { value } = controller(() => machine(), { fetch })
    const state = await value.check()
    expect(state.providers[0]).toMatchObject({
      status: 'unavailable',
      error: expect.stringContaining(error),
    })
  })

  it('coalesces checks and does not start disposed pending checks', async () => {
    const { value } = controller(() => machine())
    const first = value.check()
    expect(value.check(true)).toBe(first)
    value.dispose()
    await first
    expect(metadata).not.toHaveBeenCalled()
    await expect(value.check()).rejects.toThrow('closed')
  })

  it('refreshes automatically updated CLI versions before the daily background advisory without duplicating startup discovery', async () => {
    vi.useFakeTimers()
    vi.setSystemTime(new Date('2026-10-10T10:00:00Z'))
    let connection = machine()
    let value: ProviderUpdateController
    const refreshInstalled = vi.fn(async () => {
      connection = machine('machine-a', 'codex-cli 0.162.1', '2.1.296 (Claude Code)')
      // A real SSH refresh emits state before resolving; this must not schedule recursive work.
      value.connectionChanged()
    })
    value = controller(() => connection, { refreshInstalled }).value
    value.connectionChanged()
    await value.check()
    expect(refreshInstalled).not.toHaveBeenCalled()
    expect(providerUpdateCount(value.getState())).toBe(2)
    await vi.advanceTimersByTimeAsync(24 * 60 * 60 * 1000)
    expect(refreshInstalled).toHaveBeenCalledOnce()
    expect(metadata).toHaveBeenCalledTimes(4)
    expect(providerUpdateCount(value.getState())).toBe(0)
    expect(value.getState().checking).toBe(false)
    expect(vi.getTimerCount()).toBe(1)
  })

  it('does not report stale installed versions when a background health probe fails and retries after a minute', async () => {
    vi.useFakeTimers()
    vi.setSystemTime(new Date('2026-10-10T10:00:00Z'))
    let connection = machine()
    let value: ProviderUpdateController
    const refreshInstalled = vi
      .fn(async () => {
        connection = machine('machine-a', 'codex-cli 0.162.1', '2.1.296 (Claude Code)')
        value.connectionChanged()
      })
      .mockRejectedValueOnce(new Error('Remote version command timed out'))
    value = controller(() => connection, { refreshInstalled }).value
    value.connectionChanged()
    await value.check()
    await vi.advanceTimersByTimeAsync(24 * 60 * 60 * 1000)
    expect(refreshInstalled).toHaveBeenCalledOnce()
    expect(metadata).toHaveBeenCalledTimes(2)
    expect(providerUpdateCount(value.getState())).toBe(0)
    expect(value.getState().providers[0]).toMatchObject({
      status: 'unknown',
      installedVersion: undefined,
      error: expect.stringContaining('Installed version check failed'),
    })
    // Unrelated workspace state must not turn a failed health probe into a verified installation.
    connection = { ...connection, workspace: '/new/project' }
    value.connectionChanged()
    expect(value.getState().providers[0].status).toBe('unknown')
    await vi.advanceTimersByTimeAsync(60000)
    expect(refreshInstalled).toHaveBeenCalledTimes(2)
    expect(metadata).toHaveBeenCalledTimes(4)
    expect(value.getState().providers.every((provider) => provider.status === 'current')).toBe(true)
  })

  it('discards background health work when the connected machine changes during its probe', async () => {
    vi.useFakeTimers()
    vi.setSystemTime(new Date('2026-10-10T10:00:00Z'))
    let connection = machine()
    let resolve!: () => void
    const refreshInstalled = vi.fn(
      () =>
        new Promise<void>((done) => {
          resolve = done
        }),
    )
    const { value, emit } = controller(() => connection, { refreshInstalled })
    value.connectionChanged()
    await value.check()
    await vi.advanceTimersByTimeAsync(24 * 60 * 60 * 1000)
    expect(refreshInstalled).toHaveBeenCalledOnce()
    expect(value.getState().checking).toBe(true)
    connection = machine('machine-b', 'codex-cli 0.162.1', '2.1.296 (Claude Code)')
    value.connectionChanged()
    expect(emit.mock.calls.at(-1)?.[0].machineLabel).toContain('machine-b')
    resolve()
    await vi.advanceTimersByTimeAsync(0)
    expect(refreshInstalled).toHaveBeenCalledOnce()
    expect(value.getState().machineLabel).toContain('machine-b')
    expect(value.getState().providers.every((provider) => provider.status === 'current')).toBe(true)
    expect(value.getState().checking).toBe(false)
  })

  it('still records a real background health failure if only the selected workspace changes', async () => {
    vi.useFakeTimers()
    vi.setSystemTime(new Date('2026-10-10T10:00:00Z'))
    let connection = machine()
    let reject!: (error: Error) => void
    const refreshInstalled = vi.fn(
      () =>
        new Promise<void>((_, fail) => {
          reject = fail
        }),
    )
    const { value } = controller(() => connection, { refreshInstalled })
    value.connectionChanged()
    await value.check()
    await vi.advanceTimersByTimeAsync(24 * 60 * 60 * 1000)
    connection = { ...connection, workspace: '/another/project' }
    value.connectionChanged()
    reject(new Error('Version probe timeout'))
    await vi.advanceTimersByTimeAsync(0)
    expect(value.getState().providers[0]).toMatchObject({
      status: 'unknown',
      error: expect.stringContaining('Version probe timeout'),
    })
    expect(providerUpdateCount(value.getState())).toBe(0)
    expect(metadata).toHaveBeenCalledTimes(2)
    expect(vi.getTimerCount()).toBe(1)
  })

  it('persists only public latest metadata and ignores invalid/future cache entries', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'life-provider-updates-'))
    const cachePath = join(directory, 'cache.json')
    const now = Date.parse('2026-10-10T10:00:00Z')
    try {
      const first = controller(() => machine(), { cachePath, now: () => now }).value
      await first.check()
      const saved = JSON.parse(await readFile(cachePath, 'utf8'))
      expect(saved).toEqual({
        codex: { version: '0.162.1', checkedAt: new Date(now).toISOString() },
        claude: { version: '2.1.296', checkedAt: new Date(now).toISOString() },
      })
      metadata.mockClear()
      const second = controller(() => machine('b'), { cachePath, now: () => now }).value
      await second.check()
      expect(metadata).not.toHaveBeenCalled()
      expect(second.getState().machineId).toBe(providerUpdateMachineId(machine('b')))
      await writeFile(
        cachePath,
        JSON.stringify({
          codex: { version: '99.0.0', checkedAt: '2099-01-01' },
          claude: { version: 'broken', checkedAt: new Date(now).toISOString() },
        }),
      )
      await controller(() => machine(), { cachePath, now: () => now }).value.check()
      expect(metadata).toHaveBeenCalledTimes(2)
    } finally {
      await rm(directory, { recursive: true, force: true })
    }
  })
})
