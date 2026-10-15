import { afterEach, describe, expect, it, vi } from 'vitest'
import { existsSync } from 'node:fs'
import { readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { performance } from 'node:perf_hooks'
import { SSHConnection } from '../src/main/ssh'
import { Store } from '../src/main/store'
import type { ConnectionState } from '../src/shared/types'
import { LocalFixture } from './helpers/local-fixture'

type Resource = {
  fixture: LocalFixture
  connection: SSHConnection
  processRecord: string
}
const resources: Resource[] = []

async function running(pid: number) {
  try {
    process.kill(pid, 0)
    if (process.platform === 'linux') {
      const state = await readFile(`/proc/${pid}/stat`, 'utf8')
      return !state.slice(state.lastIndexOf(')') + 2).startsWith('Z')
    }
    return true
  } catch (error) {
    if (['ESRCH', 'ENOENT'].includes((error as NodeJS.ErrnoException).code ?? '')) return false
    throw error
  }
}

async function recordedProcesses(path: string): Promise<number[]> {
  if (!existsSync(path)) return []
  const values: unknown = JSON.parse(await readFile(path, 'utf8'))
  if (
    !Array.isArray(values) ||
    values.length !== 2 ||
    values.some((value) => !Number.isSafeInteger(value) || value <= 1)
  )
    throw new Error('The version gate did not record its fixture-owned processes')
  return values
}

afterEach(async () => {
  for (const { fixture, connection, processRecord } of resources.splice(0)) {
    connection.disconnect()
    // Failed assertions must not leave this fixture's stubborn descendant alive.
    for (const pid of await recordedProcesses(processRecord)) {
      if (!(await running(pid))) continue
      try {
        process.kill(pid, 'SIGKILL')
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ESRCH') throw error
      }
    }
    await fixture.close()
  }
})

const until = (predicate: () => unknown | Promise<unknown>, timeout = 2000) =>
  vi.waitFor(async () => expect(await predicate()).toBeTruthy(), { timeout, interval: 20 })

async function setup() {
  const fixture = await new LocalFixture().start()
  const gate = join(fixture.root, 'release-version-gate')
  const processRecord = join(fixture.root, 'version-gate-processes.json')
  const shell = join(fixture.root, 'gated-login-shell')
  const driver = join(fixture.root, 'version-gate.cjs')
  await writeFile(
    driver,
    `const { spawn } = require('node:child_process')
const { existsSync, writeFileSync } = require('node:fs')
const child = spawn(process.execPath, ['-e', "process.on('SIGTERM', () => {}); process.send('ready'); setInterval(() => {}, 1000)"], { stdio: ['ignore', 'ignore', 'ignore', 'ipc'] })
child.once('message', () => {
  writeFileSync(process.env.LIFE_TEST_VERSION_PROCESSES, JSON.stringify([process.pid, child.pid]))
  const timer = setInterval(() => {
    if (!existsSync(process.env.LIFE_TEST_VERSION_GATE)) return
    clearInterval(timer)
    child.once('exit', () => {
      const command = spawn(process.env.LIFE_TEST_BASE_SHELL, process.argv.slice(2), { stdio: 'inherit', env: process.env })
      command.once('error', error => { process.stderr.write(error.message); process.exit(1) })
      command.once('exit', code => process.exit(code ?? 1))
    })
    child.kill('SIGKILL')
  }, 20)
})
`,
  )
  await writeFile(
    shell,
    '#!/bin/bash\nif [[ "$1" == "-lc" && "$2" == *"life_codex_version="* ]]; then\n  exec "$LIFE_TEST_NODE" "$LIFE_TEST_VERSION_DRIVER" "$@"\nfi\nexec "$LIFE_TEST_BASE_SHELL" "$@"\n',
    { mode: 0o755 },
  )
  const environment: NodeJS.ProcessEnv = {
    ...fixture.env,
    SHELL: shell,
    LIFE_TEST_NODE: process.execPath,
    LIFE_TEST_BASE_SHELL: fixture.shell,
    LIFE_TEST_VERSION_DRIVER: driver,
    LIFE_TEST_VERSION_GATE: gate,
    LIFE_TEST_VERSION_PROCESSES: processRecord,
  }
  const store = new Store(join(fixture.root, 'settings'), { localWorkspace: fixture.workspace })
  const connection = new SSHConnection(store, {
    local: { ...fixture.options.local, shell, env: environment },
  })
  resources.push({ fixture, connection, processRecord })
  await store.init()
  const states: ConnectionState[] = []
  const diagnostics: string[] = []
  const hostKey = vi.fn()
  connection.on('state', (state: ConnectionState) => states.push(state))
  connection.on('diagnostic', (message: string) => diagnostics.push(message))
  connection.on('host-key', hostKey)
  return {
    fixture,
    gate,
    processRecord,
    environment,
    store,
    connection,
    states,
    diagnostics,
    hostKey,
  }
}

async function usableWhileChecking(value: Awaited<ReturnType<typeof setup>>) {
  const inheritedEnvironment = { HOME: process.env.HOME, CODEX_HOME: process.env.CODEX_HOME }
  const start = performance.now()
  const connected = await value.connection.connect(value.store.localProfile())
  expect(connected).toMatchObject({
    status: 'connected',
    providerVersionsStatus: 'checking',
    profile: { id: value.store.localProfile().id, transport: 'local' },
    workspace: value.fixture.workspace,
  })
  expect(connected.codex).toBeUndefined()
  expect(connected.claude).toBeUndefined()
  expect((await value.connection.listDirectories(value.fixture.root)).entries).toContainEqual({
    name: "workspace's café 🧪",
    path: value.fixture.workspace,
  })
  await value.connection.selectWorkspace(value.fixture.workspace)
  expect((await value.connection.list()).map((entry) => entry.name)).toContain('README.md')
  expect(await value.connection.read('README.md')).toBe('# Local fixture café 🧪\n')
  // A real five-second blocked login must not hold machine access behind it.
  expect(performance.now() - start).toBeLessThan(2000)
  await until(() => existsSync(value.processRecord))
  const processes = await recordedProcesses(value.processRecord)
  expect(await Promise.all(processes.map(running))).toEqual([true, true])
  expect(value.connection.state.providerVersionsStatus).toBe('checking')
  expect(await value.fixture.log()).toEqual([])
  expect(value.hostKey).not.toHaveBeenCalled()
  expect(value.environment.HOME).toBe(inheritedEnvironment.HOME)
  expect(value.environment.CODEX_HOME).toBe(inheritedEnvironment.CODEX_HOME)
  expect(process.env.HOME).toBe(inheritedEnvironment.HOME)
  expect(process.env.CODEX_HOME).toBe(inheritedEnvironment.CODEX_HOME)
  return processes
}

function neverInventedMissing(states: ConnectionState[]) {
  for (const state of states) {
    expect(state.codex).not.toBe('missing')
    expect(state.claude).not.toBe('missing')
    if (state.providerVersionsStatus === 'checking') {
      expect(state.codex).toBeUndefined()
      expect(state.claude).toBeUndefined()
    }
  }
}

describe.skipIf(process.platform === 'win32')('local startup with a blocked optional login', () => {
  it('opens Local and its files before discovery, then reports actual CLI versions after release', async () => {
    const value = await setup()
    const processes = await usableWhileChecking(value)
    const ready = value.connection.whenProviderVersionsReady()
    const coalesced = value.connection.refreshProviderVersions()
    await writeFile(value.gate, 'Release only this fixture-owned login\n')
    const discovered = await ready
    expect(discovered).toMatchObject({
      status: 'connected',
      providerVersionsStatus: 'ready',
      codex: 'codex-cli test.0',
      claude: '2.test.0 (Claude Code fixture)',
      workspace: value.fixture.workspace,
    })
    expect(await coalesced).toBe(discovered)
    expect((await value.fixture.log()).map((entry) => [entry.provider, entry.argv])).toEqual([
      ['codex', ['--version']],
      ['claude', ['--version']],
    ])
    expect(value.diagnostics).toEqual([])
    neverInventedMissing(value.states)
    await until(async () => (await Promise.all(processes.map(running))).every((active) => !active))
    expect(await value.connection.read('README.md')).toBe('# Local fixture café 🧪\n')
  })

  it('times out only discovery and kills its process group while Local files remain usable', async () => {
    const value = await setup()
    const processes = await usableWhileChecking(value)
    const failed = await value.connection.whenProviderVersionsReady()
    expect(failed).toMatchObject({
      status: 'connected',
      providerVersionsStatus: 'failed',
      codex: 'unknown',
      claude: 'unknown',
      workspace: value.fixture.workspace,
    })
    expect(value.diagnostics).toEqual([
      expect.stringMatching(/Provider version discovery failed:.*timed out/i),
    ])
    neverInventedMissing(value.states)
    expect(await value.fixture.log()).toEqual([])
    await until(async () => (await Promise.all(processes.map(running))).every((active) => !active))
    await value.connection.selectWorkspace(value.fixture.workspace)
    expect(await value.connection.read('README.md')).toBe('# Local fixture café 🧪\n')
    expect(value.connection.state).toMatchObject({
      status: 'connected',
      providerVersionsStatus: 'failed',
    })
  }, 10000)
})
