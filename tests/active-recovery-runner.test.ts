import { createRequire } from 'node:module'
import { EventEmitter } from 'node:events'
import { chmod, mkdir, mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'

const require = createRequire(import.meta.url)
const contract = require('./helpers/active-recovery-observer/runner-contract.cjs')
const runner = require('./active-recovery-run.cjs')
const local = require('./helpers/active-recovery-observer/local-proof.cjs')
const directories: string[] = []
async function temporary() {
  const root = await mkdtemp(join(tmpdir(), 'life-recovery-runner-unit-'))
  directories.push(root)
  return root
}
afterEach(async () => {
  for (const directory of directories.splice(0))
    await rm(directory, { recursive: true, force: true })
})

describe('tracked recovery runner boundaries', () => {
  it('owns an immediate spawn rejection before later process observation awaits', async () => {
    const child = new EventEmitter()
    const original = new Error('spawn ENOENT')
    const completion = runner.completionOf(child)
    queueMicrotask(() => child.emit('error', original))
    await Promise.resolve()
    await expect(completion).rejects.toBe(original)
  })
  it('runs the existing 44 cases and validators in order, stopping dependent stages on failure', async () => {
    expect(contract.chooseStages()).toEqual([
      'matrix',
      'source-commit',
      'reload',
      'source-artifacts-matrix',
      'source-artifacts-commit',
    ])
    expect(
      contract.DEFAULT_STAGES.slice(0, 3).reduce(
        (sum: number, name: string) => sum + contract.STAGES[name].cases,
        0,
      ),
    ).toBe(44)
    const observed: string[] = []
    await expect(
      runner.runSequence(contract.chooseStages(), async (name: string) => {
        observed.push(name)
        if (name === 'source-commit') throw new Error('actual stage failed')
        return name
      }),
    ).rejects.toThrow('actual stage failed')
    expect(observed).toEqual(['matrix', 'source-commit'])
    expect(contract.chooseStages('local-codex-stream')).toEqual(['local-codex-stream'])
    expect(contract.STAGES['local-codex-stream']).toMatchObject({
      selected: 'codex-stream-crash',
      cases: 1,
      mode: 'local',
    })
    expect(contract.STAGES['local-claude-approval']).toMatchObject({
      selected: 'claude-pending-approval-crash',
      cases: 1,
      mode: 'local',
    })
    expect(() => contract.chooseStages('baseline')).toThrow()
  })

  it('loads bootstrap before observer and uses only tracked repository paths', () => {
    const root = '/private/repository'
    const command = contract.stageCommand(root, contract.STAGES['local-claude-approval'])
    const required = command.filter((value: string) => value.endsWith('.cjs'))
    expect(required).toEqual(
      ['local-bootstrap.cjs', 'fixture-observer.cjs', 'runner-contract.cjs', 'local-proof.cjs']
        .map((name) => join(root, 'tests/helpers/active-recovery-observer', name))
        .concat(join(root, 'tests/active-session-recovery-smoke.cjs')),
    )
    expect(command.join(' ')).not.toContain('output/playwright')
    const original = {
      DISPLAY: ':live',
      XAUTHORITY: '/live/auth',
      NODE_OPTIONS: '--require /foreign/module',
      ELECTRON_RUN_AS_NODE: '1',
      LIFE_ELECTRON_BINARY: '/foreign/electron',
      LIFE_TEST_EXPECT_RECOVERY_GAP: '1',
      LIFE_TEST_RECOVERY_CASE: 'foreign',
      HOME: '/inherited/home',
      CODEX_HOME: '/inherited/codex',
    }
    const environment = contract.stageEnvironment(
      original,
      root,
      root,
      '/private/artifacts',
      contract.STAGES['local-claude-approval'],
    )
    expect(environment).toMatchObject({
      HOME: original.HOME,
      CODEX_HOME: original.CODEX_HOME,
      LIFE_TEST_RECOVERY_CASE: 'claude-pending-approval-crash',
      LIFE_TEST_ACTIVE_RECOVERY_MODE: 'local',
      LIFE_TEST_OBSERVER_ADAPTER: '1',
    })
    for (const name of [
      'DISPLAY',
      'XAUTHORITY',
      'NODE_OPTIONS',
      'ELECTRON_RUN_AS_NODE',
      'LIFE_ELECTRON_BINARY',
      'LIFE_TEST_EXPECT_RECOVERY_GAP',
    ])
      expect(environment).not.toHaveProperty(name)
    expect(original.DISPLAY).toBe(':live')
    expect(
      contract.stageCommand(root, contract.STAGES['source-artifacts-matrix'], '/private/completed'),
    ).toEqual([
      process.execPath,
      join(root, 'tests/helpers/active-recovery-observer/source-artifacts.cjs'),
      '/private/completed',
    ])
  })

  it('requires canonical tracked manifest paths and unchanged exact bytes/modes', async () => {
    const root = await temporary()
    const file = join(root, 'fixture.cjs')
    await writeFile(file, 'original fixture bytes', { mode: 0o600 })
    const manifestPath = join(root, 'manifest.json')
    const manifest = {
      version: 1,
      inputs: [{ path: 'fixture.cjs', sha256: local.hash(await readFile(file)), mode: 0o600 }],
    }
    await writeFile(manifestPath, JSON.stringify(manifest))
    expect((await contract.verifyManifest(root, manifestPath)).inputs).toEqual([
      { path: 'fixture.cjs', sha256: manifest.inputs[0].sha256 },
    ])
    await chmod(file, 0o644)
    await expect(contract.verifyManifest(root, manifestPath)).rejects.toThrow()
    await chmod(file, 0o600)
    await writeFile(file, 'changed bytes')
    await expect(contract.verifyManifest(root, manifestPath)).rejects.toThrow()
    for (const path of [
      '../outside',
      '/outside',
      'folder/../fixture.cjs',
      './fixture.cjs',
      'folder\\fixture.cjs',
    ])
      expect(() => contract.repositoryPath(root, path)).toThrow()
  })

  it('fingerprints source, out, dependencies and runtime files without historical paths', async () => {
    const root = await temporary()
    for (const path of ['src', 'out/main', 'node_modules/package', 'node_modules/.vite'])
      await mkdir(join(root, path), { recursive: true })
    const files: Record<string, string> = {
      'src/app.ts': 'source',
      'package.json': '{}',
      'out/main/index.js': 'main',
      'out/main/conversation-checkpoint-worker.js': 'worker',
      'node_modules/package/index.js': 'runtime dependency',
      'node_modules/.vite/transient': 'cache',
      'stock-electron': 'stock binary',
      'stock-node': 'node binary',
    }
    for (const [path, value] of Object.entries(files)) await writeFile(join(root, path), value)
    const options = {
      dependencyRoot: join(root, 'node_modules'),
      electronPath: join(root, 'stock-electron'),
      electronVersion: '44',
      nodePath: join(root, 'stock-node'),
      nodeVersion: '22',
    }
    const before = await contract.applicationIdentity(root, root, options)
    await writeFile(join(root, 'node_modules/.vite/transient'), 'changed development cache')
    contract.compareIdentity(before, await contract.applicationIdentity(root, root, options))
    await writeFile(join(root, 'node_modules/package/index.js'), 'changed runtime dependency')
    expect(() => contract.compareIdentity(before, before)).not.toThrow()
    const after = await contract.applicationIdentity(root, root, options)
    expect(() => contract.compareIdentity(before, after)).toThrow()
    expect(before).not.toHaveProperty('baselineDependencyRoot')
    const alternate = join(root, 'alternate-app')
    for (const path of ['src', 'out/main', 'node_modules'])
      await mkdir(join(alternate, path), { recursive: true })
    await writeFile(join(alternate, 'out/main/index.js'), 'alternate main')
    await expect(contract.applicationIdentity(root, alternate, options)).rejects.toThrow(
      'same fingerprinted dependency store',
    )
  })

  it('retains exact private physical and native journal bytes before root deletion', async () => {
    const root = await temporary()
    const fixtureRoot = join(root, 'fixture')
    const configurationRoot = join(root, 'profile')
    const userData = join(configurationRoot, 'Life')
    const artifacts = join(root, 'artifacts')
    const brokerRoot = join(fixtureRoot, '.life/agent-sessions/native-id')
    await mkdir(brokerRoot, { recursive: true })
    await mkdir(join(userData, 'native-recovery'), { recursive: true })
    for (const [name, value] of Object.entries({
      'state.json': '{"id":"native-id"}',
      'session.json': '{"private":"fixture-only"}',
      'journal.jsonl': '{"type":"stdout","cursor":1}\n',
      'input-digests': '1 private digest\n',
    }))
      await writeFile(join(brokerRoot, name), value)
    const filename = local.hash('native-id') + '.jsonl'
    await writeFile(join(userData, 'native-recovery', filename), 'exact native bytes\n')
    const harness = {
      name: 'codex-stream-crash',
      fixture: { root: fixtureRoot },
      configurationRoot,
      artifacts,
      launches: [{ userData }],
    }
    const retained = await contract.retainOwnershipFiles(harness, [
      { path: join(brokerRoot, 'state.json'), state: { id: 'native-id' } },
    ])
    expect(retained.map((entry: { originalPath: string }) => entry.originalPath)).toContain(
      join(brokerRoot, 'input-digests'),
    )
    await rm(fixtureRoot, { recursive: true })
    for (const item of retained)
      expect(local.hash(await readFile(item.retainedPath))).toBe(item.sha256)
    const outside = join(root, 'outside')
    await writeFile(outside, 'outside')
    await mkdir(fixtureRoot)
    const link = join(fixtureRoot, 'link')
    await symlink(outside, link)
    await expect(
      contract.retainFile(fixtureRoot, link, join(artifacts, 'untrusted')),
    ).rejects.toThrow()
  })

  it('binds explicit proc records to PID and start ticks', () => {
    const raw =
      '321 (native (fixture)) S ' +
      Array.from({ length: 19 }, (_, index) => (index === 18 ? '9001' : '0')).join(' ')
    expect(contract.processStat(321, raw)).toEqual({ pid: 321, state: 'S', startTicks: '9001' })
    expect(() => contract.processStat(322, raw)).toThrow()
    expect(local.processIdentityFromStat(321, raw)).toMatchObject({
      pid: 321,
      startTicks: '9001',
      alive: true,
    })
    expect(local.processIdentityFromStat(321, raw.replace(') S ', ') Z '))).toMatchObject({
      alive: false,
    })
  })

  it('checks Local descriptor/physical mapping/process continuity and actual controller advancement', () => {
    const owner = {
      ownerId: 'root',
      sessionId: 'local-session',
      kind: 'root',
      workspace: '/private/workspace',
      nativeThreadId: 'native-thread',
    }
    const descriptor = {
      id: 'broker',
      brokerId: 'broker',
      brokerRoot: '/logical/home/.life/agent-sessions/broker',
      launchCommand: 'exec codex app-server --listen stdio://',
      provider: 'codex',
      machine: { transport: 'local', profileId: 'local:private' },
      controller: { id: 'old', epoch: 1 },
      owners: [owner],
    }
    const mapping = {
      id: 'broker',
      originalRoot: descriptor.brokerRoot,
      root: '/private/fixture/.life/agent-sessions/broker',
      commandSha256: local.hash(descriptor.launchCommand),
      runtimeUnchanged: true,
    }
    expect(local.validateBrokerMapping(mapping, { root: '/private/fixture' }, descriptor)).toEqual(
      mapping,
    )
    const native = {
      transport: descriptor,
      mapping,
      mappingCount: 1,
      boundOwners: [owner],
      ownersHistory: [{ owner }],
      wal: { sha256: 'original-wal', device: '1', inode: '10' },
      broker: {
        session: { sha256: 'original-session', device: '1', inode: '11' },
        journal: { sha256: 'original-journal', device: '1', inode: '12' },
        state: { exited: false },
        providerProcess: { pid: 300, present: true, alive: true, startTicks: '100' },
        brokerProcess: { pid: 301, present: true, alive: true, startTicks: '101' },
      },
    }
    const before = { targetIds: ['broker'], native: [native] }
    const after = structuredClone(before)
    after.native[0].transport.controller = { id: 'new', epoch: 2 }
    after.native[0].mappingCount = 2
    Object.assign(after.native[0].wal, { originalPrefixSha256: 'original-wal' })
    Object.assign(after.native[0].broker.journal, { originalPrefixSha256: 'original-journal' })
    expect(local.assertContinuity(before, after, { requireAttachment: true })).toBe(true)
    for (const alter of [
      (value: any) => (value.transport.brokerRoot = '/another-owner'),
      (value: any) => (value.broker.providerProcess.startTicks = 'reused'),
      (value: any) => (value.mapping.root = '/another-physical-root'),
      (value: any) => (value.transport.controller = { id: 'old', epoch: 1 }),
      (value: any) => (value.wal.originalPrefixSha256 = 'different bytes'),
    ]) {
      const invalid = structuredClone(after)
      alter(invalid.native[0])
      expect(() => local.assertContinuity(before, invalid, { requireAttachment: true })).toThrow()
    }
  })

  it('rejects a Local case without every substantive proof assertion', () => {
    const proof = {
      version: 1,
      transport: 'local',
      assertions: Object.fromEntries(
        [
          'genuineLocalMachine',
          'sameLogicalDescriptor',
          'samePhysicalMapping',
          'sameNativeProcessIdentity',
          'coldHostExited',
          'realReattachment',
        ].map((name) => [name, true]),
      ),
      phases: ['before-crash', 'after-crash', 'after-reopen', 'final'].map((phase) => ({ phase })),
    }
    expect(() => contract.verifyLocalProof(proof)).not.toThrow()
    proof.assertions.realReattachment = false
    expect(() => contract.verifyLocalProof(proof)).toThrow()
  })
})
