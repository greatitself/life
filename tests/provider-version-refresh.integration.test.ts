import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { SSHConnection } from '../src/main/ssh'
import { ProviderUpdateController } from '../src/main/provider-updates'
import { providerUpdateCount } from '../src/shared/provider-updates'
import { Store } from '../src/main/store'
import type { HostKeyRequest } from '../src/shared/types'
import { SSHFixture } from './helpers/ssh-fixture'

let fixture: SSHFixture
let second: SSHFixture
let connection: SSHConnection
let sequence = 0

async function versions(target: SSHFixture, codex: string, claude: string, delay = 0) {
  await Promise.all(
    (['codex', 'claude'] as const).map((provider) =>
      writeFile(
        join(target.root, '.local/bin', provider),
        `#!/bin/bash\n${delay && provider === 'codex' ? `sleep ${delay}\n` : ''}printf '%s\\n' '${provider === 'codex' ? codex : claude}'\n`,
        { mode: 0o755 },
      ),
    ),
  )
}
beforeAll(async () => {
  fixture = await new SSHFixture().start()
  second = await new SSHFixture().start()
})
afterAll(async () => {
  await Promise.all([fixture.close(), second.close()])
})
beforeEach(async () => {
  const store = new Store(join(fixture.root, 'version-settings-' + ++sequence))
  await store.init()
  connection = new SSHConnection(store)
  connection.forwarding.setEnabled(false)
  connection.on('host-key', (request: HostKeyRequest) => connection.trust(request.id, true))
  await versions(fixture, 'codex-cli 0.162.0', '2.1.278 (Claude Code)')
  await versions(second, 'codex-cli 0.162.1', '2.1.296 (Claude Code)')
})
afterEach(() => connection.disconnect())

describe('provider version refresh over real SSH', () => {
  it('refreshes changed installations without selecting a project or starting a model', async () => {
    await connection.connect(fixture.input())
    expect(connection.state.workspace).toBeUndefined()
    expect(connection.state.codex).toBe('codex-cli 0.162.0')
    const revision = connection.state.providerVersionsRevision
    await versions(fixture, 'codex-cli 0.162.1', '2.1.296 (Claude Code)')
    const start = fixture.commands.length
    await expect(connection.refreshProviderVersions()).resolves.toMatchObject({
      codex: 'codex-cli 0.162.1',
      claude: '2.1.296 (Claude Code)',
      home: fixture.root,
    })
    expect(fixture.commands.slice(start)).toHaveLength(1)
    expect(fixture.commands.at(-1)).toContain('--version')
    expect(connection.state.workspace).toBeUndefined()
    expect(connection.state.providerVersionsRevision).toBeGreaterThan(revision || 0)
  })

  it('rejects refresh before connection without dispatching a remote command', async () => {
    const start = fixture.commands.length
    await expect(connection.refreshProviderVersions()).rejects.toThrow('Connect to a machine first')
    expect(fixture.commands).toHaveLength(start)
  })

  it('keeps independent CLI discovery when a wrapper fails or omits its newline', async () => {
    await connection.connect(fixture.input())
    const path = join(fixture.root, '.local/bin/codex')
    await writeFile(path, '#!/bin/bash\nexit 1\n', { mode: 0o755 })
    await expect(connection.refreshProviderVersions()).resolves.toMatchObject({
      codex: 'unknown',
      claude: '2.1.278 (Claude Code)',
    })
    await writeFile(path, "#!/bin/bash\nprintf 'codex-cli 0.162.1'\n", { mode: 0o755 })
    await expect(connection.refreshProviderVersions()).resolves.toMatchObject({
      codex: 'codex-cli 0.162.1',
      claude: '2.1.278 (Claude Code)',
    })
  })

  it('cannot write previous-machine versions after switching the SSH connection', async () => {
    await connection.connect(fixture.input())
    await versions(fixture, 'codex-cli 0.1.0', '1.0.0 (Claude Code)', 0.4)
    const start = fixture.commands.length
    const oldCheck = connection.refreshProviderVersions()
    const rejected = expect(oldCheck).rejects.toThrow(/cancelled|changed/)
    await vi.waitFor(() => expect(fixture.commands.length).toBeGreaterThan(start))
    await connection.connect(second.input())
    await rejected
    expect(connection.state).toMatchObject({
      home: second.root,
      codex: 'codex-cli 0.162.1',
      claude: '2.1.296 (Claude Code)',
    })
  })

  it('rechecks an auto-updated real SSH installation before publishing the timed update advisory', async () => {
    await connection.connect(fixture.input())
    const cachePath = join(fixture.root, `public-provider-cache-${sequence}.json`)
    const checkedAt = new Date(Date.now() - 24 * 60 * 60 * 1000 + 400).toISOString()
    await writeFile(
      cachePath,
      JSON.stringify({
        codex: { version: '0.162.1', checkedAt },
        claude: { version: '2.1.296', checkedAt },
      }),
    )
    const fetch = vi.fn<typeof globalThis.fetch>(
      async (url) =>
        new Response(
          JSON.stringify({ version: String(url).includes('codex') ? '0.162.1' : '2.1.296' }),
        ),
    )
    const refreshInstalled = vi.fn(() => connection.refreshProviderVersions())
    const updates = new ProviderUpdateController(
      () => connection.state,
      () => {},
      { cachePath, fetch, refreshInstalled },
    )
    const onState = () => updates.connectionChanged()
    connection.on('state', onState)
    try {
      updates.connectionChanged()
      await updates.check()
      expect(providerUpdateCount(updates.getState())).toBe(2)
      expect(refreshInstalled).not.toHaveBeenCalled()
      expect(fetch).not.toHaveBeenCalled()
      await versions(fixture, 'codex-cli 0.162.1', '2.1.296 (Claude Code)')
      await vi.waitFor(
        () => {
          expect(refreshInstalled).toHaveBeenCalledOnce()
          expect(updates.getState().checking).toBe(false)
          expect(
            updates.getState().providers.every((provider) => provider.status === 'current'),
          ).toBe(true)
        },
        { timeout: 5000, interval: 20 },
      )
      expect(providerUpdateCount(updates.getState())).toBe(0)
      expect(fetch).toHaveBeenCalledTimes(2)
    } finally {
      updates.dispose()
      connection.removeListener('state', onState)
    }
  })
})
