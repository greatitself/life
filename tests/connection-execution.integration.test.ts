import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { mkdir, readFile, rm, symlink } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { join } from 'node:path'
import { executeConnectionCommand } from '../src/main/connection-execution'
import { SSHConnection } from '../src/main/ssh'
import { Store } from '../src/main/store'
import type { ConnectionExecutionInput, HostKeyRequest } from '../src/shared/types'
import { shellQuote } from '../src/shared/validation'
import { SSHFixture } from './helpers/ssh-fixture'

let fixture: SSHFixture
let connection: SSHConnection
let sequence = 0

const waitFor = async (predicate: () => unknown | Promise<unknown>) =>
  vi.waitFor(async () => expect(await predicate()).toBeTruthy(), {
    timeout: 5000,
    interval: 20,
  })

const processExists = (pid: number) => {
  try {
    process.kill(pid, 0)
    return true
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ESRCH') return false
    throw error
  }
}

beforeAll(async () => {
  fixture = await new SSHFixture().start()
})

afterAll(async () => {
  await fixture.close()
})

beforeEach(async () => {
  const store = new Store(join(fixture.root, 'command-settings-' + ++sequence))
  await store.init()
  connection = new SSHConnection(store)
  connection.forwarding.setEnabled(false)
  connection.on('host-key', (request: HostKeyRequest) => connection.trust(request.id, true))
})

afterEach(() => {
  connection.disconnect()
})

async function connect(selectProject = true) {
  await connection.connect(fixture.input())
  if (selectProject) await connection.selectWorkspace(fixture.workspace)
}

async function commandPid(filename: string) {
  let pid = 0
  await waitFor(async () => {
    try {
      pid = Number(await readFile(join(fixture.workspace, filename), 'utf8'))
      return Number.isInteger(pid) && pid > 0 && processExists(pid)
    } catch {
      return false
    }
  })
  return pid
}

describe('connected project command execution over real SSH', () => {
  it('requires a connected machine and a selected project without running commands', async () => {
    const beforeConnect = fixture.commands.length
    await expect(
      executeConnectionCommand(connection, { command: 'printf unreachable' }),
    ).rejects.toThrow(/connect to a machine/i)
    expect(fixture.commands).toHaveLength(beforeConnect)

    await connect(false)
    const beforeSelection = fixture.commands.length
    await expect(
      executeConnectionCommand(connection, { command: 'printf unreachable' }),
    ).rejects.toThrow(/select a project/i)
    expect(fixture.commands).toHaveLength(beforeSelection)
    expect(connection.listenerCount('workspace-changing')).toBe(0)
    expect(connection.listenerCount('disconnected')).toBe(0)
  })

  it('quotes the selected directory and returns command stdout from that project', async () => {
    await connect()
    expect(fixture.workspace).toContain("'")
    await expect(
      executeConnectionCommand(connection, {
        command: "pwd; cat README.md; printf 'stderr is separate' >&2",
        workspace: fixture.workspace,
      }),
    ).resolves.toBe(fixture.workspace + '\n# Fixture workspace\n')
    expect(connection.state).toMatchObject({ status: 'connected', workspace: fixture.workspace })
    expect(connection.listenerCount('workspace-changing')).toBe(0)
    expect(connection.listenerCount('disconnected')).toBe(0)
  })

  it.each([
    ["printf 'build failed with context' >&2; exit 7", /build failed with context/],
    ['exit 12', /exited with code 12/],
  ])('reports failed remote commands: %s', async (command, message) => {
    await connect()
    await expect(executeConnectionCommand(connection, { command })).rejects.toThrow(message)
    expect(connection.listenerCount('workspace-changing')).toBe(0)
    expect(connection.listenerCount('disconnected')).toBe(0)
    await expect(
      executeConnectionCommand(connection, { command: 'printf recovered' }),
    ).resolves.toBe('recovered')
  })

  it('rejects a stale expected project before dispatching the command', async () => {
    await connect()
    const commandCount = fixture.commands.length
    await expect(
      executeConnectionCommand(connection, {
        command: 'printf unreachable',
        workspace: fixture.root,
      }),
    ).rejects.toThrow(/selected project changed/i)
    expect(fixture.commands).toHaveLength(commandCount)
    expect(connection.listenerCount('workspace-changing')).toBe(0)
    expect(connection.listenerCount('disconnected')).toBe(0)
  })

  it('does not run any part of a script when its selected directory has disappeared', async () => {
    await connect()
    const workspace = join(fixture.root, 'removed-command-project-' + sequence)
    const marker = join(fixture.root, 'unexpected-command-marker-' + sequence)
    await mkdir(workspace)
    await connection.selectWorkspace(workspace)
    await rm(workspace, { recursive: true })
    await expect(
      executeConnectionCommand(connection, {
        command: `printf first; printf unexpected > ${shellQuote(marker)}`,
      }),
    ).rejects.toThrow()
    expect(existsSync(marker)).toBe(false)
    expect(connection.state.status).toBe('connected')
  })

  it('accepts the full UTF-8 command byte limit and maximum timeout', async () => {
    await connect()
    const prefix = 'printf boundary; #'
    const command = prefix + 'é'.repeat(Math.floor((100_000 - prefix.length) / 2))
    expect(Buffer.byteLength(command)).toBe(100_000)
    await expect(
      executeConnectionCommand(connection, { command, timeoutMs: 120_000 }),
    ).resolves.toBe('boundary')
  })

  it.each([
    { command: '' },
    { command: ' \n\t' },
    { command: 'printf bad\0command' },
    { command: 'x'.repeat(100_001) },
    { command: 'é'.repeat(50_001) },
    { command: 'printf unreachable', timeoutMs: 0 },
    { command: 'printf unreachable', timeoutMs: -1 },
    { command: 'printf unreachable', timeoutMs: 120_001 },
    { command: 'printf unreachable', timeoutMs: 1.5 },
    { command: 'printf unreachable', timeoutMs: Number.NaN },
    { command: 'printf unreachable', timeoutMs: Number.POSITIVE_INFINITY },
    { command: 'printf unreachable', workspace: '' },
    { command: 'printf unreachable', workspace: '/invalid\0directory' },
  ])('validates commands and limits before remote execution %#', async (input) => {
    await connect()
    const commandCount = fixture.commands.length
    await expect(
      executeConnectionCommand(connection, input as ConnectionExecutionInput),
    ).rejects.toThrow()
    expect(fixture.commands).toHaveLength(commandCount)
    expect(connection.state.status).toBe('connected')
  })

  it('accepts exactly 1 MB of multibyte output without corrupting UTF-8', async () => {
    await connect()
    const output = await executeConnectionCommand(connection, {
      command: `exec node -e 'process.stdout.write("é".repeat(500000))'`,
    })
    expect(Buffer.byteLength(output)).toBe(1_000_000)
    expect(output).toBe('é'.repeat(500_000))
  })

  it('closes a command channel when output exceeds 1 MB and preserves SSH', async () => {
    await connect()
    const filename = '.oversized-command-pid-' + sequence
    const command = `printf '%s' "$$" > ${filename}; exec node -e 'setTimeout(() => process.stdout.write("é".repeat(500001)), 200); setInterval(() => {}, 1000)'`
    const rejected = expect(executeConnectionCommand(connection, { command })).rejects.toThrow(
      /output.*limit/i,
    )
    const pid = await commandPid(filename)
    await rejected
    await waitFor(() => !processExists(pid))
    expect(connection.state.status).toBe('connected')
    expect(connection.listenerCount('workspace-changing')).toBe(0)
    expect(connection.listenerCount('disconnected')).toBe(0)
    await expect(
      executeConnectionCommand(connection, { command: 'printf still-connected' }),
    ).resolves.toBe('still-connected')
  })

  it('times out and closes a sleeping command while preserving SSH and listeners', async () => {
    await connect()
    const filename = '.timed-command-pid-' + sequence
    const command = `printf '%s' "$$" > ${filename}; exec sleep 30`
    const rejected = expect(
      executeConnectionCommand(connection, { command, timeoutMs: 250 }),
    ).rejects.toThrow(/timed out/i)
    const pid = await commandPid(filename)
    await rejected
    await waitFor(() => !processExists(pid))
    expect(connection.state.status).toBe('connected')
    expect(connection.listenerCount('workspace-changing')).toBe(0)
    expect(connection.listenerCount('disconnected')).toBe(0)
    await expect(
      executeConnectionCommand(connection, { command: 'printf after-timeout' }),
    ).resolves.toBe('after-timeout')
  })

  it('cancels an active command promptly when the selected project changes', async () => {
    await connect()
    const filename = '.project-command-pid-' + sequence
    const command = `printf '%s' "$$" > ${filename}; exec sleep 30`
    const rejected = expect(executeConnectionCommand(connection, { command })).rejects.toThrow(
      /selected project changed.*cancelled/i,
    )
    const pid = await commandPid(filename)
    const beforeSwitch = Date.now()
    await connection.selectWorkspace(fixture.root)
    await rejected
    expect(Date.now() - beforeSwitch).toBeLessThan(2000)
    await waitFor(() => !processExists(pid))
    expect(connection.state).toMatchObject({ status: 'connected', workspace: fixture.root })
    expect(connection.listenerCount('workspace-changing')).toBe(0)
    expect(connection.listenerCount('disconnected')).toBe(0)
    await expect(executeConnectionCommand(connection, { command: 'pwd' })).resolves.toBe(
      fixture.root + '\n',
    )
  })

  it('cancels an active command promptly on disconnect and leaves no listeners', async () => {
    await connect()
    const filename = '.disconnected-command-pid-' + sequence
    const command = `printf '%s' "$$" > ${filename}; exec sleep 30`
    const rejected = expect(executeConnectionCommand(connection, { command })).rejects.toThrow(
      /SSH disconnected.*cancelled/i,
    )
    const pid = await commandPid(filename)
    const beforeDisconnect = Date.now()
    connection.disconnect()
    await rejected
    expect(Date.now() - beforeDisconnect).toBeLessThan(2000)
    await waitFor(() => !processExists(pid))
    expect(connection.state.status).toBe('disconnected')
    expect(connection.listenerCount('workspace-changing')).toBe(0)
    expect(connection.listenerCount('disconnected')).toBe(0)
  })

  it('keeps an active command running when project selection fails', async () => {
    await connect()
    const marker = 'selection-failed-' + sequence
    const filename = '.unchanged-project-pid-' + sequence
    const command = `printf '%s' "$$" > ${filename}; printf '${marker}'; sleep 1; printf ':finished'`
    const output = executeConnectionCommand(connection, { command })
    await commandPid(filename)
    await expect(
      connection.selectWorkspace(join(fixture.root, 'missing-project')),
    ).rejects.toThrow()
    await expect(output).resolves.toBe(marker + ':finished')
    expect(connection.state).toMatchObject({ status: 'connected', workspace: fixture.workspace })
  })

  it('keeps an active command running when the same project is selected again', async () => {
    await connect()
    const filename = '.same-project-pid-' + sequence
    const command = `printf '%s' "$$" > ${filename}; sleep 0.5; printf same-project`
    const output = executeConnectionCommand(connection, { command })
    await commandPid(filename)
    await connection.selectWorkspace(fixture.workspace)
    await expect(output).resolves.toBe('same-project')
    expect(connection.state).toMatchObject({ status: 'connected', workspace: fixture.workspace })
    expect(connection.listenerCount('workspace-changing')).toBe(0)
    expect(connection.listenerCount('disconnected')).toBe(0)
  })
})

describe('connected machine command execution over real SSH', () => {
  it('requires a connection but does not require or select an Agents project', async () => {
    const beforeConnect = fixture.commands.length
    await expect(
      executeConnectionCommand(connection, { scope: 'machine', command: 'printf unreachable' }),
    ).rejects.toThrow(/connect to a machine/i)
    expect(fixture.commands).toHaveLength(beforeConnect)

    await connect(false)
    await expect(
      executeConnectionCommand(connection, { scope: 'machine', command: 'pwd' }),
    ).resolves.toBe(fixture.root + '\n')
    expect(connection.state.workspace).toBeUndefined()
    expect(connection.listenerCount('workspace-changing')).toBe(0)
    expect(connection.listenerCount('disconnected')).toBe(0)
  })

  it.each(['~', "~/workspace's project", "workspace's project", 'absolute', 'symlink'])(
    'resolves an existing home-scoped directory without changing the selected project: %s',
    async (requested) => {
      await connect()
      const link = join(fixture.root, 'machine-project-link-' + sequence)
      if (requested === 'symlink') await symlink(fixture.workspace, link)
      const workspace =
        requested === 'absolute' ? fixture.workspace : requested === 'symlink' ? link : requested
      await expect(
        executeConnectionCommand(connection, { scope: 'machine', workspace, command: 'pwd -P' }),
      ).resolves.toBe((requested === '~' ? fixture.root : fixture.workspace) + '\n')
      expect(connection.state.workspace).toBe(fixture.workspace)
      expect(connection.listenerCount('workspace-changing')).toBe(0)
      expect(connection.listenerCount('disconnected')).toBe(0)
    },
  )

  it.each(['absolute', 'relative', 'symlink', 'home-prefix-sibling'])(
    'rejects an explicit directory outside canonical home before running the command: %s',
    async (kind) => {
      await connect(false)
      const marker = join(fixture.root, 'unexpected-machine-command-' + sequence)
      const sibling = fixture.root + '-sibling-' + sequence
      const link = join(fixture.root, 'machine-home-escape-' + sequence)
      if (kind === 'home-prefix-sibling') await mkdir(sibling)
      if (kind === 'symlink') await symlink('/tmp', link)
      const workspace =
        kind === 'absolute'
          ? '/tmp'
          : kind === 'relative'
            ? '..'
            : kind === 'symlink'
              ? link
              : sibling
      try {
        await expect(
          executeConnectionCommand(connection, {
            scope: 'machine',
            workspace,
            command: `printf unexpected > ${shellQuote(marker)}`,
          }),
        ).rejects.toThrow(/within the connected home directory/i)
        expect(existsSync(marker)).toBe(false)
        expect(connection.state).toMatchObject({ status: 'connected', home: fixture.root })
        expect(connection.state.workspace).toBeUndefined()
      } finally {
        if (kind === 'home-prefix-sibling') await rm(sibling, { recursive: true, force: true })
      }
    },
  )

  it('keeps a machine command in its original directory during an Agents project switch', async () => {
    await connect()
    const filename = '.machine-project-switch-pid-' + sequence
    const output = executeConnectionCommand(connection, {
      scope: 'machine',
      workspace: fixture.workspace,
      command: `printf '%s' "$$" > ${filename}; sleep 0.5; pwd -P`,
    })
    await commandPid(filename)
    expect(connection.listenerCount('workspace-changing')).toBe(0)
    await connection.selectWorkspace(fixture.root)
    await expect(output).resolves.toBe(fixture.workspace + '\n')
    expect(connection.state.workspace).toBe(fixture.root)
    expect(connection.listenerCount('disconnected')).toBe(0)
  })

  it('does not execute a machine command when its explicit directory is missing', async () => {
    await connect(false)
    const marker = join(fixture.root, 'unexpected-missing-machine-command-' + sequence)
    await expect(
      executeConnectionCommand(connection, {
        scope: 'machine',
        workspace: join(fixture.root, 'missing-machine-directory-' + sequence),
        command: `printf unexpected > ${shellQuote(marker)}`,
      }),
    ).rejects.toThrow()
    expect(existsSync(marker)).toBe(false)
    expect(connection.state.workspace).toBeUndefined()
  })

  it('bounds machine commands by the same total deadline without selecting a project', async () => {
    await connect(false)
    const filename = '.machine-timeout-pid-' + sequence
    const rejected = expect(
      executeConnectionCommand(connection, {
        scope: 'machine',
        timeoutMs: 250,
        command: `printf '%s' "$$" > ${shellQuote(join(fixture.workspace, filename))}; exec sleep 30`,
      }),
    ).rejects.toThrow(/timed out/i)
    const pid = await commandPid(filename)
    await rejected
    await waitFor(() => !processExists(pid))
    expect(connection.state.workspace).toBeUndefined()
    expect(connection.listenerCount('disconnected')).toBe(0)
    await expect(
      executeConnectionCommand(connection, { scope: 'machine', command: 'printf after-timeout' }),
    ).resolves.toBe('after-timeout')
  })

  it('bounds machine output without disconnecting or selecting a project', async () => {
    await connect(false)
    await expect(
      executeConnectionCommand(connection, {
        scope: 'machine',
        command: `exec node -e 'process.stdout.write("é".repeat(500001))'`,
      }),
    ).rejects.toThrow(/output.*limit/i)
    expect(connection.state.status).toBe('connected')
    expect(connection.state.workspace).toBeUndefined()
    expect(connection.listenerCount('disconnected')).toBe(0)
    await expect(
      executeConnectionCommand(connection, {
        scope: 'machine',
        command: 'printf after-output-limit',
      }),
    ).resolves.toBe('after-output-limit')
  })

  it('cancels machine commands when the renderer changes while preserving the connection', async () => {
    await connect(false)
    const filename = '.machine-renderer-replaced-pid-' + sequence
    const rejected = expect(
      executeConnectionCommand(connection, {
        scope: 'machine',
        command: `printf '%s' "$$" > ${shellQuote(join(fixture.workspace, filename))}; exec sleep 30`,
      }),
    ).rejects.toThrow(/Life interface changed/i)
    const pid = await commandPid(filename)
    await connection.cancelRendererRequests()
    await rejected
    await waitFor(() => !processExists(pid))
    expect(connection.state).toMatchObject({ status: 'connected', home: fixture.root })
    expect(connection.state.workspace).toBeUndefined()
    expect(connection.listenerCount('disconnected')).toBe(0)
    await expect(
      executeConnectionCommand(connection, { scope: 'machine', command: 'printf recovered' }),
    ).resolves.toBe('recovered')
  })

  it.each(['disconnect', 'machine-change'])(
    'cancels machine commands promptly on %s and never adopts a replacement connection',
    async (kind) => {
      await connect(false)
      const filename = '.machine-disconnected-pid-' + sequence
      const rejected = expect(
        executeConnectionCommand(connection, {
          scope: 'machine',
          command: `printf '%s' "$$" > ${shellQuote(join(fixture.workspace, filename))}; exec sleep 30`,
        }),
      ).rejects.toThrow(/SSH disconnected.*cancelled/i)
      const pid = await commandPid(filename)
      if (kind === 'disconnect') connection.disconnect()
      else await connection.connect({ ...fixture.input(), id: 'replacement-machine' })
      await rejected
      await waitFor(() => !processExists(pid))
      expect(connection.listenerCount('workspace-changing')).toBe(0)
      expect(connection.listenerCount('disconnected')).toBe(0)
      if (kind === 'machine-change') {
        expect(connection.state.profile?.id).toBe('replacement-machine')
        await expect(
          executeConnectionCommand(connection, { scope: 'machine', command: 'pwd' }),
        ).resolves.toBe(fixture.root + '\n')
      } else expect(connection.state.status).toBe('disconnected')
    },
  )
})
