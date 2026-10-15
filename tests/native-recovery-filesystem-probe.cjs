#!/usr/bin/env node
/*
 * Run only after the release build and package have been frozen.
 * node tests/native-recovery-filesystem-probe.cjs <packaged executable> [proof.json]
 * LIFE_ELECTRON_BINARY can supply the executable. LIFE_RECOVERY_BUILD_PROVENANCE
 * must name the parent build gate's life-recovery-release-build manifest.
 * This probes filesystem ownership and WAL replay; it launches no providers.
 */
const assert = require('node:assert/strict')
const { createHash } = require('node:crypto')
const { spawn } = require('node:child_process')
const { lstat, mkdir, mkdtemp, readFile, readdir, rm, writeFile } = require('node:fs/promises')
const { tmpdir } = require('node:os')
const { dirname, join, relative, resolve, sep } = require('node:path')
const { build } = require('esbuild')

const repository = resolve(__dirname, '..')
const executableInput = process.argv[2] || process.env.LIFE_ELECTRON_BINARY
assert(
  executableInput,
  'Pass the real packaged executable; a development Electron fallback is forbidden',
)
assert(process.env.LIFE_RECOVERY_BUILD_PROVENANCE, 'LIFE_RECOVERY_BUILD_PROVENANCE is required')
const executable = resolve(executableInput)
const provenancePath = resolve(process.env.LIFE_RECOVERY_BUILD_PROVENANCE)
const proofPath = resolve(
  process.argv[3] ||
    join(repository, 'output/native-recovery-filesystem-probe', `${process.platform}.json`),
)
const digest = (bytes) => createHash('sha256').update(bytes).digest('hex')

async function inventory(root, filesOnly = false) {
  const entries = []
  async function visit(path) {
    const info = await lstat(path)
    assert(!info.isSymbolicLink(), `Provenance cannot contain a link: ${path}`)
    const name = relative(root, path).split(sep).join('/') || '.'
    if (info.isDirectory()) {
      if (!filesOnly) entries.push({ path: name, type: 'directory' })
      for (const child of (await readdir(path)).sort()) await visit(join(path, child))
    } else {
      assert(info.isFile(), `Provenance requires regular files: ${path}`)
      const bytes = await readFile(path)
      entries.push({ path: name, type: 'file', size: bytes.length, sha256: digest(bytes) })
    }
  }
  await visit(root)
  return entries
}

async function resourcesDirectory() {
  for (const candidate of [
    join(dirname(executable), 'resources'),
    resolve(dirname(executable), '../Resources'),
  ]) {
    try {
      if ((await lstat(join(candidate, 'app.asar'))).isFile()) return candidate
    } catch (error) {
      if (error.code !== 'ENOENT') throw error
    }
  }
  throw new Error('The supplied executable has no packaged resources/app.asar')
}

function sidecarSource(storeModule, policyModule) {
  return String.raw`
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { lstat, mkdir, open, readFile, readdir, writeFile } from 'node:fs/promises'
import { join, relative, resolve, sep } from 'node:path'
import { Effect } from 'effect'
import { NativeRecoveryStore } from ${JSON.stringify(storeModule)}
import { assessNativeRecoveryPlatformEffect, validateNativeRecoveryPlatformPolicyEffect } from ${JSON.stringify(policyModule)}

const digest = (bytes) => createHash('sha256').update(bytes).digest('hex')
const serialize = (error) => ({
  tag: error?._tag, reason: error?.reason, operation: error?.operation,
  code: error?.code, causeCode: error?.cause?.code, message: String(error?.message || error),
})
const io = (operation) => Effect.tryPromise({
  try: operation, catch: (cause) => cause instanceof Error ? cause : new Error(String(cause)),
})
const outcome = (effect) => Effect.runPromise(effect.pipe(Effect.match({
  onFailure: (error) => ({ ok: false, error: serialize(error) }),
  onSuccess: () => ({ ok: true }),
})))

async function inventory(root, filesOnly = false) {
  const entries = []
  async function visit(path) {
    const info = await lstat(path)
    assert(!info.isSymbolicLink(), 'Probe graph contains a link: ' + path)
    const name = relative(root, path).split(sep).join('/') || '.'
    if (info.isDirectory()) {
      if (!filesOnly) entries.push({ path: name, type: 'directory' })
      for (const child of (await readdir(path)).sort()) await visit(join(path, child))
    } else {
      assert(info.isFile(), 'Probe graph contains a non-regular file: ' + path)
      const bytes = await readFile(path)
      entries.push({ path: name, type: 'file', size: bytes.length, sha256: digest(bytes) })
    }
  }
  await visit(root)
  return entries
}

async function compiledPackageGraph(resources, asarCompiled, expected) {
  const entries = new Map(asarCompiled.map((entry) => [entry.path, entry]))
  const transfers = []
  const mappings = [
    { logicalPath: 'source/package.json', resource: join(resources, 'life-source', 'package.json') },
    { logicalPath: 'source/runtime-smoke.cjs', resource: join(resources, 'life-source-runtime.cjs') },
  ]
  for (const mapping of mappings) {
    const info = await lstat(mapping.resource)
    assert(info.isFile() && !info.isSymbolicLink(), 'Transferred resource must be a regular file: ' + mapping.resource)
    const bytes = await readFile(mapping.resource)
    const entry = { path: mapping.logicalPath, type: 'file', size: bytes.length, sha256: digest(bytes) }
    assert.deepEqual(entry, expected.find((value) => value.path === mapping.logicalPath), 'Transferred resource differs from the frozen compiled file: ' + mapping.logicalPath)
    if (entries.has(mapping.logicalPath)) assert.deepEqual(entries.get(mapping.logicalPath), entry)
    entries.set(mapping.logicalPath, entry)
    transfers.push({ logicalPath: mapping.logicalPath, resource: mapping.resource, size: entry.size, sha256: entry.sha256 })
  }
  if (!entries.has('source')) entries.set('source', { path: 'source', type: 'directory' })
  assert.equal(entries.get('source').type, 'directory')
  const reconstructed = []
  const visit = (path) => {
    const entry = entries.get(path)
    assert(entry, 'Missing logical compiled entry: ' + path)
    reconstructed.push(entry)
    if (entry.type !== 'directory') return
    const prefix = path === '.' ? '' : path + '/'
    const children = [...entries.keys()].filter((name) => name !== path && name.startsWith(prefix) && !name.slice(prefix.length).includes('/')).sort()
    for (const child of children) visit(child)
  }
  visit('.')
  assert.equal(reconstructed.length, entries.size, 'The logical compiled graph contains an orphan entry')
  return { inventory: reconstructed, transfers }
}

async function observeDirectorySync(root) {
  const path = join(root, 'observed directory sync')
  await mkdir(path, { mode: 0o700 })
  let handle
  try {
    handle = await open(path, 'r')
    await handle.sync()
    return { ok: true }
  } catch (error) {
    return { ok: false, error: serialize(error) }
  } finally {
    await handle?.close()
  }
}

async function guards(policy, userData) {
  return {
    ssh: await outcome(policy.assertFreshSshStartEffect('ssh')),
    local: await outcome(policy.assertFreshSshStartEffect('local')),
    source: await outcome(policy.assertOrdinarySourceWriteEffect(join(userData, 'source-code'))),
    history: await outcome(policy.assertOrdinaryHistoryWriteEffect(userData)),
    native: await outcome(policy.assertNativeRecoveryEffect('filesystem-probe')),
    cloned: await outcome(validateNativeRecoveryPlatformPolicyEffect({ ...policy })),
  }
}

async function windowsProbe(root, userData, policy) {
  assert.equal(policy.mode, 'unsupported-clean')
  const before = await inventory(userData)
  const clean = await guards(policy, userData)
  for (const name of ['ssh', 'source', 'history']) assert.equal(clean[name].ok, true, name)
  for (const name of ['local', 'native', 'cloned']) assert.equal(clean[name].ok, false, name)
  assert.deepEqual(await inventory(userData), before, 'Clean Windows guards mutated state')
  const noOwnership = await Effect.runPromise(assessNativeRecoveryPlatformEffect({ userData, exclusiveRuntime: false }))
  assert.equal(noOwnership.mode, 'blocked')

  const protectedData = join(root, 'protected user data')
  await mkdir(join(protectedData, 'native-recovery'), { recursive: true, mode: 0o700 })
  await writeFile(join(protectedData, 'native-recovery', 'foreign-original'), Buffer.from([0, 255, 13, 10, 7]))
  const protectedBefore = await inventory(protectedData)
  const blocked = await Effect.runPromise(assessNativeRecoveryPlatformEffect({ userData: protectedData, exclusiveRuntime: true }))
  assert.equal(blocked.mode, 'blocked')
  const protectedGuards = await guards(blocked, protectedData)
  for (const value of Object.values(protectedGuards)) assert.equal(value.ok, false)
  assert.deepEqual(await inventory(protectedData), protectedBefore, 'Blocked guards changed foreign state')

  await mkdir(join(userData, 'native-recovery-actions'), { mode: 0o700 })
  await writeFile(join(userData, 'native-recovery-actions', 'late-original'), 'State appeared after assessment\r\n')
  const lateBefore = await inventory(userData)
  const late = await guards(policy, userData)
  for (const value of Object.values(late)) assert.equal(value.ok, false)
  assert.deepEqual(await inventory(userData), lateBefore, 'Late-state guards changed protected state')
  return { mode: policy.mode, storeConstructions: 0, clean, noOwnershipMode: noOwnership.mode, protectedGuards, late, cleanBefore: before, protectedBefore, lateBefore }
}

async function posixProbe(root, userData, policy, directorySync) {
  assert.equal(policy.mode, 'durable')
  assert.equal(directorySync.ok, true, 'The real filesystem did not support directory sync')
  const admitted = await guards(policy, userData)
  for (const name of ['ssh', 'local', 'source', 'history', 'native']) assert.equal(admitted[name].ok, true, name)
  assert.equal(admitted.cloned.ok, false, 'A copied policy acquired private capability')
  const directory = join(userData, 'native-recovery')
  const prompt = '  Exact filesystem prompt\r\n\tUnicode café e\u0301 漢字 🧪\u0000\ud800  '
  const inputBytes = Buffer.from(JSON.stringify({ id: 7, method: 'turn/start', params: { input: [{ type: 'text', text: prompt }] } }) + '\n')
  const transport = {
    id: 'packaged-filesystem-transport', brokerId: 'filesystem-only-broker',
    brokerRoot: '/private-filesystem-fixture/no-provider', launchCommand: 'filesystem-probe-never-executes',
    provider: 'codex', providerVersion: 'filesystem-only', nativeProtocol: 'codex-app-server-stdio', brokerProtocolVersion: 2,
    machine: { transport: 'ssh', profileId: 'private-filesystem-profile', host: 'fixture.invalid', port: 22, username: 'fixture' },
    controller: { id: 'private-filesystem-controller', epoch: 1 }, initialization: { status: 'not-started' },
    owners: [{ ownerId: 'private-root-owner', sessionId: 'private-life-session', generation: 1, snapshotToken: 'private-snapshot-token', kind: 'root', workspace: '/private-filesystem-workspace', state: 'starting', input: { sessionId: 'private-life-session', provider: 'codex', prompt, mode: 'read-only', workspace: '/private-filesystem-workspace', providerOptions: { turn: { opaqueFutureField: [null, false, 'preserve'] } } } }],
  }
  const semantic = { kind: 'user-prompt', sessionId: 'private-life-session', ownerGeneration: 1, method: 'turn/start', requestId: 7 }
  let storeConstructions = 0
  const makeStore = () => {
    storeConstructions++
    return NativeRecoveryStore.make({ directory, exclusiveRuntime: true, outputBatchDelayMs: 0 })
  }
  const leasePath = join(directory, '.writer.lock', 'owner.json')
  const journalName = digest(transport.id) + '.jsonl'
  const released = async () => {
    assert.deepEqual((await readdir(directory)).sort(), [journalName], 'Lease, temporary file, or stray writer remained')
    return inventory(directory)
  }

  const first = await Effect.runPromise(Effect.scoped(Effect.gen(function* () {
    const store = yield* makeStore()
    const initial = yield* store.createTransport(transport)
    assert.deepEqual(initial.transport, transport)
    const lease = JSON.parse(yield* io(() => readFile(leasePath, 'utf8')))
    assert.equal(lease.pid, process.pid)
    assert.equal(typeof lease.token, 'string')
    const competing = yield* Effect.scoped(makeStore()).pipe(Effect.match({
      onFailure: (error) => ({ ok: false, error: serialize(error) }),
      onSuccess: () => ({ ok: true }),
    }))
    assert.equal(competing.ok, false, 'A second writer acquired the live lease')
    assert.equal(competing.error.reason, 'ownership')
    const input = yield* store.reserveInput(transport.id, { type: 'write', data: inputBytes.toString('base64') }, semantic)
    assert.equal(input.sequence, 1)
    assert.equal(input.wire, JSON.stringify({ type: 'write', data: inputBytes.toString('base64'), sequence: 1 }) + '\n')
    assert.deepEqual(Buffer.from(input.frame.data, 'base64'), inputBytes)
    yield* store.flushEffect()
    const snapshot = yield* store.readTransport(transport.id)
    yield* store.closeEffect()
    return { input, snapshot, lease: { pid: lease.pid, token: lease.token } }
  })))
  const firstGraph = await released()

  const terminal = await Effect.runPromise(Effect.scoped(Effect.gen(function* () {
    const store = yield* makeStore()
    assert.deepEqual(yield* store.readTransport(transport.id), first.snapshot, 'Cold replay changed the original snapshot')
    const originalCandidates = yield* store.reconcileInputHighWater(transport.id, 0)
    assert.deepEqual(originalCandidates, [first.input], 'Cold replay renumbered or replaced the original wire')
    const close = yield* store.reserveInput(transport.id, { type: 'close' }, { kind: 'close', sessionId: 'private-life-session', ownerGeneration: 1, method: 'filesystem-close-intent' })
    assert.equal(close.sequence, 2)
    assert.equal(close.wire, JSON.stringify({ type: 'close', sequence: 2 }) + '\n')
    yield* store.flushEffect()
    const snapshot = yield* store.readTransport(transport.id)
    assert.equal(snapshot.closeInputSequence, close.sequence)
    assert.equal(snapshot.inputs[0].acknowledged, false)
    assert.equal(snapshot.inputs[0].written, false)
    assert.equal(snapshot.inputs[0].consumed, false)
    assert.equal(snapshot.inputs[0].cancellation, 'Superseded by explicit transport close.')
    yield* store.closeEffect()
    return { close, snapshot, originalCandidates }
  })))
  const terminalGraph = await released()
  const final = await Effect.runPromise(Effect.scoped(Effect.gen(function* () {
    const store = yield* makeStore()
    const snapshot = yield* store.readTransport(transport.id)
    assert.deepEqual(snapshot, terminal.snapshot, 'Cold replay changed terminal close ownership')
    const closeCandidates = yield* store.reconcileInputHighWater(transport.id, 0)
    assert.deepEqual(closeCandidates, [terminal.close], 'Terminal close replay leaked an earlier prompt')
    const closedInput = yield* store.reserveInput(transport.id, { type: 'write', data: 'bmV2ZXItc2VuZA==' }, semantic).pipe(Effect.match({
      onSuccess: () => ({ rejected: false }), onFailure: (error) => ({ rejected: true, error: serialize(error) }),
    }))
    assert.equal(closedInput.rejected, true)
    assert.equal(closedInput.error.reason, 'closed')
    yield* store.flushEffect()
    assert.deepEqual(yield* store.readTransport(transport.id), snapshot)
    yield* store.closeEffect()
    return { snapshot, closeCandidates, closedInput }
  })))
  assert.deepEqual(await released(), terminalGraph, 'Cold read or refused input changed durable bytes')
  return { mode: policy.mode, storeConstructions, admitted, first, terminal, final, firstGraph, terminalGraph, leaseReleasedAfterEveryScope: true, exclusiveWriterObserved: true, providerDeliveryObserved: false }
}

async function run() {
  const config = JSON.parse(await readFile(process.argv[3], 'utf8'))
  assert(process.versions.electron, 'The filesystem probe requires packaged Electron Node mode')
  assert(process.versions.node && process.versions.uv, 'Packaged Node and libuv identity is required')
  assert.equal(process.platform, config.platform)
  assert.equal(resolve(process.execPath).toLowerCase(), resolve(config.executable).toLowerCase())
  const resources = resolve(process.argv[2])
  const asarCompiled = await inventory(join(resources, 'app.asar', 'out'))
  const reconstructed = await compiledPackageGraph(resources, asarCompiled, config.compiled)
  const packagedCompiled = reconstructed.inventory
  const packagedSource = await inventory(join(resources, 'life-source', 'src'), true)
  assert.deepEqual(packagedCompiled, config.compiled, 'The complete ASAR and transferred-resource graph differs from the frozen build graph')
  assert.deepEqual(packagedSource, config.source, 'Packaged source differs from the frozen source graph')
  const userData = join(config.root, 'private user data')
  await mkdir(userData, { mode: 0o700 })
  const directorySync = await observeDirectorySync(config.root)
  const policy = await Effect.runPromise(assessNativeRecoveryPlatformEffect({ userData, exclusiveRuntime: true }))
  const filesystem = process.platform === 'win32'
    ? await windowsProbe(config.root, userData, policy)
    : await posixProbe(config.root, userData, policy, directorySync)
  await writeFile(process.argv[4], JSON.stringify({
    ok: true, runtime: { platform: process.platform, arch: process.arch, execPath: process.execPath, resources, versions: process.versions },
    directorySync, filesystem, packagedCompiled, asarCompiled, compiledTransfers: reconstructed.transfers, packagedSource, nativeProviderProcesses: 0,
    claim: 'Real packaged filesystem, lease, private capability and WAL replay only; no provider delivery or authenticated upstream use',
  }, null, 2) + '\n')
}
run().catch((error) => { console.error(error); process.exitCode = 1 })
`
}

function runPackagedNode(script, args) {
  return new Promise((done, fail) => {
    const child = spawn(executable, [script, ...args], {
      cwd: repository,
      env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' },
      windowsHide: true,
      stdio: ['ignore', 'pipe', 'pipe'],
    })
    let stdout = '',
      stderr = '',
      timedOut = false
    child.stdout.on('data', (bytes) => {
      stdout = (stdout + bytes.toString()).slice(-64000)
    })
    child.stderr.on('data', (bytes) => {
      stderr = (stderr + bytes.toString()).slice(-64000)
    })
    const timer = setTimeout(() => {
      timedOut = true
      child.kill()
    }, 120000)
    child.once('error', (error) => {
      clearTimeout(timer)
      fail(error)
    })
    child.once('close', (code, signal) => {
      clearTimeout(timer)
      if (timedOut || code !== 0)
        fail(
          new Error(
            `Packaged filesystem probe failed (code ${code}, signal ${signal}, timed out ${timedOut})\n${stdout}\n${stderr}`,
          ),
        )
      else done({ stdout, stderr })
    })
  })
}

async function run() {
  const startedAt = new Date().toISOString()
  const resources = await resourcesDirectory()
  const packagedSource = join(resources, 'life-source')
  const provenanceBytes = await readFile(provenancePath)
  const provenance = JSON.parse(provenanceBytes.toString('utf8'))
  assert.equal(provenance.format, 'life-recovery-release-build')
  assert.equal(provenance.version, 1)
  assert.equal(provenance.platform, process.platform)
  const sourceBefore = await inventory(join(repository, 'src'), true)
  const compiledBefore = await inventory(join(repository, 'out'))
  const packageBefore = {
    executableSha256: digest(await readFile(executable)),
    asarSha256: digest(await readFile(join(resources, 'app.asar'))),
  }
  assert.deepEqual(
    provenance.sourceBefore,
    provenance.sourceAfter,
    'The build source was not frozen',
  )
  assert.deepEqual(
    sourceBefore,
    provenance.sourceBefore,
    'Current source differs from build provenance',
  )
  assert.deepEqual(
    compiledBefore,
    provenance.compiled,
    'Current compiled graph differs from build provenance',
  )
  assert.deepEqual(
    packageBefore,
    provenance.package,
    'The actual package differs from build provenance',
  )
  assert.deepEqual(await inventory(join(packagedSource, 'src'), true), sourceBefore)
  const root = await mkdtemp(join(tmpdir(), 'Life packaged filesystem probe '))
  let success = false
  try {
    const script = join(root, 'filesystem-probe.cjs')
    const configPath = join(root, 'probe-config.json')
    const childProofPath = join(root, 'runtime-proof.json')
    await build({
      stdin: {
        contents: sidecarSource(
          join(packagedSource, 'src/main/native-recovery-store.ts'),
          join(packagedSource, 'src/main/native-recovery-platform.ts'),
        ),
        sourcefile: 'packaged-filesystem-probe.ts',
        resolveDir: packagedSource,
        loader: 'ts',
      },
      outfile: script,
      bundle: true,
      platform: 'node',
      format: 'cjs',
      packages: 'external',
      banner: {
        js: "require = require('node:module').createRequire(require('node:path').join(process.argv[2], 'app.asar', 'package.json'));",
      },
    })
    await writeFile(
      configPath,
      JSON.stringify({
        root,
        executable,
        platform: process.platform,
        source: sourceBefore,
        compiled: compiledBefore,
      }),
    )
    const logs = await runPackagedNode(script, [resources, configPath, childProofPath])
    const runtime = JSON.parse(await readFile(childProofPath, 'utf8'))
    assert.equal(runtime.ok, true)
    assert.equal(runtime.runtime.platform, process.platform)
    assert.equal(runtime.nativeProviderProcesses, 0)
    const sourceAfter = await inventory(join(repository, 'src'), true)
    const compiledAfter = await inventory(join(repository, 'out'))
    const packageAfter = {
      executableSha256: digest(await readFile(executable)),
      asarSha256: digest(await readFile(join(resources, 'app.asar'))),
    }
    assert.deepEqual(sourceAfter, sourceBefore)
    assert.deepEqual(compiledAfter, compiledBefore)
    assert.deepEqual(packageAfter, packageBefore)
    assert.equal(
      digest(await readFile(provenancePath)),
      digest(provenanceBytes),
      'Build provenance changed during the probe',
    )
    await mkdir(dirname(proofPath), { recursive: true })
    await writeFile(
      proofPath,
      JSON.stringify(
        {
          ...runtime,
          startedAt,
          completedAt: new Date().toISOString(),
          buildProvenance: {
            path: provenancePath,
            sha256: digest(provenanceBytes),
            manifest: provenance,
          },
          sourceBefore,
          sourceAfter,
          compiledBefore,
          compiledAfter,
          packageBefore,
          packageAfter,
          sidecarSha256: digest(await readFile(script)),
          fixtureSha256: digest(await readFile(__filename)),
          logs,
        },
        null,
        2,
      ) + '\n',
    )
    success = true
    console.log(`Packaged filesystem probe passed: ${proofPath}`)
  } catch (error) {
    console.error(`Private failed probe state retained at ${root}`)
    throw error
  } finally {
    if (success) await rm(root, { recursive: true, force: true })
  }
}

run().catch((error) => {
  console.error(error)
  process.exitCode = 1
})
