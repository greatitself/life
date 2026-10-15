import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process'
import { mkdtemp, readFile, rm, symlink } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { buildRemoteAgentBrokerCommand } from '../src/main/remote-agent-broker'
import { shellQuote } from '../src/shared/validation'

const owned: Array<{ root: string; child: ChildProcessWithoutNullStreams }> = []
afterEach(async () => {
  for (const fixture of owned.splice(0)) {
    fixture.child.kill('SIGKILL')
    // Successful fixtures exit naturally; also release a broker if an assertion
    // fails before the terminal frame has been observed.
    for (const name of ['state.json', 'daemon.lock/owner.json']) {
      try {
        const state = JSON.parse(await readFile(join(fixture.root, name), 'utf8'))
        const pid = state.brokerPid ?? state.pid
        if (Number.isSafeInteger(pid) && pid > 1) process.kill(pid, 'SIGTERM')
      } catch {}
    }
    await rm(fixture.root, { recursive: true, force: true })
  }
})

async function localBroker(inheritedRunAsNode?: string) {
  const root = await mkdtemp(join(tmpdir(), 'life-local-broker-'))
  const expected = {
    home: process.env.HOME,
    codexHome: process.env.CODEX_HOME,
    inheritedRunAsNode,
  }
  const source = `const expected=${JSON.stringify(expected)};process.stdout.write(JSON.stringify({homePreserved:process.env.HOME===expected.home,codexHomePreserved:process.env.CODEX_HOME===expected.codexHome,runAsNodePreserved:process.env.ELECTRON_RUN_AS_NODE===expected.inheritedRunAsNode})+'\\n')`
  const executable = join(root, "owned 'Electron Node' `untouched` $(printf expansion)")
  await symlink(process.execPath, executable)
  const config = {
    id: 'local-runtime',
    root,
    command: `${shellQuote(process.execPath)} -e ${shellQuote(source)}`,
    controllerId: 'local-test-runtime',
    expectedProtocol: 2,
  }
  const command = buildRemoteAgentBrokerCommand(config, { executable, inheritedRunAsNode })
  const child = spawn('/bin/sh', ['-c', command], {
    env: { ...process.env, PATH: '/life-test-no-external-runtimes' },
    stdio: 'pipe',
  })
  owned.push({ root, child })
  let output = ''
  let stderr = ''
  const frames: Array<{
    type: string
    data?: string
    code?: number
    message?: string
    protocol?: number
    terminal?: boolean
    writerLease?: { epoch: number; token: string }
  }> = []
  child.stdout.on('data', (chunk: Buffer) => {
    output += chunk.toString('utf8')
    for (;;) {
      const end = output.indexOf('\n')
      if (end < 0) break
      frames.push(JSON.parse(output.slice(0, end)))
      output = output.slice(end + 1)
    }
  })
  child.stderr.on('data', (chunk: Buffer) => {
    stderr += chunk.toString('utf8')
  })
  await new Promise<void>((resolve, reject) => {
    child.once('error', reject)
    child.once('close', (code) =>
      code === 0 ? resolve() : reject(new Error(`Broker exited ${code}: ${stderr}`)),
    )
  })
  expect(stderr).toBe('')
  expect(frames.find((frame) => frame.type === 'ready')?.protocol).toBe(2)
  expect(frames.some((frame) => frame.type === 'replayComplete')).toBe(true)
  expect(frames.filter((frame) => frame.type === 'error')).toEqual([])
  expect(frames.find((frame) => frame.type === 'exit')?.code).toBe(0)
  const providerOutput = frames
    .filter((frame) => frame.type === 'stdout')
    .map((frame) => Buffer.from(frame.data ?? '', 'base64').toString('utf8'))
    .join('')
  return { root, providerOutput, executable, command, config }
}

describe('bundled local broker runtime', () => {
  it('starts without a PATH Node or Python and removes its Electron bootstrap flag from the provider', async () => {
    const fixture = await localBroker()
    expect(JSON.parse(fixture.providerOutput)).toEqual({
      homePreserved: true,
      codexHomePreserved: true,
      runAsNodePreserved: true,
    })
    const persisted = JSON.parse(await readFile(join(fixture.root, 'session.json'), 'utf8'))
    expect(persisted.localRuntime).toEqual({})
    expect(fixture.command).toContain('export ELECTRON_RUN_AS_NODE=1; exec ')
    expect(fixture.command).toContain(shellQuote(fixture.executable))
    expect(fixture.command).not.toContain('command -v node')
    expect(persisted.protocol).toBe(2)
  })

  it('restores the inherited Electron flag instead of substituting its own value', async () => {
    const fixture = await localBroker('inherited-provider-value')
    expect(JSON.parse(fixture.providerOutput)).toEqual({
      homePreserved: true,
      codexHomePreserved: true,
      runAsNodePreserved: true,
    })
    const persisted = JSON.parse(await readFile(join(fixture.root, 'session.json'), 'utf8'))
    expect(persisted.localRuntime).toEqual({ inheritedRunAsNode: 'inherited-provider-value' })
  })

  it.each(['', '0'])('preserves an inherited flag with exact value %j', async (value) => {
    const fixture = await localBroker(value)
    expect(JSON.parse(fixture.providerOutput)).toEqual({
      homePreserved: true,
      codexHomePreserved: true,
      runAsNodePreserved: true,
    })
    const persisted = JSON.parse(await readFile(join(fixture.root, 'session.json'), 'utf8'))
    expect(persisted.localRuntime).toEqual({ inheritedRunAsNode: value })
  })

  it('keeps the original local launch metadata when a later runtime replays a completed broker', async () => {
    const fixture = await localBroker('original-provider-value')
    const metadataBefore = await readFile(join(fixture.root, 'session.json'))
    const command = buildRemoteAgentBrokerCommand(
      { ...fixture.config, launch: false, controllerId: 'replacement-runtime' },
      { executable: fixture.executable, inheritedRunAsNode: 'changed-runtime-value' },
    )
    const child = spawn('/bin/sh', ['-c', command], {
      env: { ...process.env, PATH: '/life-test-no-external-runtimes' },
      stdio: 'pipe',
    })
    owned.push({ root: fixture.root, child })
    let output = ''
    let stderr = ''
    child.stdout.on('data', (chunk: Buffer) => {
      output += chunk.toString('utf8')
    })
    child.stderr.on('data', (chunk: Buffer) => {
      stderr += chunk.toString('utf8')
    })
    await new Promise<void>((resolve, reject) => {
      child.once('error', reject)
      child.once('close', (code) =>
        code === 0 ? resolve() : reject(new Error(`Replay exited ${code}: ${stderr}`)),
      )
    })
    const frames = output
      .trim()
      .split('\n')
      .map((line) => JSON.parse(line))
    expect(frames.find((frame) => frame.type === 'ready')).toMatchObject({
      protocol: 2,
      terminal: true,
    })
    expect(frames.find((frame) => frame.type === 'ready').writerLease).toBeUndefined()
    expect(frames.some((frame) => frame.type === 'replayComplete')).toBe(true)
    expect(await readFile(join(fixture.root, 'session.json'))).toEqual(metadataBefore)
    const replayed = frames
      .filter((frame) => frame.type === 'stdout')
      .map((frame) => Buffer.from(frame.data, 'base64').toString('utf8'))
      .join('')
    expect(JSON.parse(replayed)).toEqual({
      homePreserved: true,
      codexHomePreserved: true,
      runAsNodePreserved: true,
    })
  })
})
