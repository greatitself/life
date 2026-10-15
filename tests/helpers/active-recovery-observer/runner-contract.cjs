const assert = require('node:assert/strict')
const {
  readFile,
  readdir,
  lstat,
  readlink,
  realpath,
  mkdir,
  writeFile,
} = require('node:fs/promises')
const { isAbsolute, join, relative, resolve } = require('node:path')
const { hash, readJournal } = require('./contract.cjs')

const DEFAULT_STAGES = [
  'matrix',
  'source-commit',
  'reload',
  'source-artifacts-matrix',
  'source-artifacts-commit',
]
const STAGES = {
  matrix: { script: 'tests/active-session-recovery-smoke.cjs', cases: 39, mode: 'ssh' },
  'source-commit': {
    script: 'tests/active-session-recovery-smoke.cjs',
    args: ['--source-apply-commit-gap'],
    cases: 2,
    mode: 'ssh',
  },
  reload: { script: 'tests/active-session-reload-smoke.cjs', cases: 3, mode: 'ssh' },
  'source-artifacts-matrix': { artifactStage: 'matrix' },
  'source-artifacts-commit': { artifactStage: 'source-commit' },
  'ssh-thread-binding': {
    script: 'tests/active-session-recovery-smoke.cjs',
    selected: 'codex-thread-start-before-bind-crash',
    cases: 1,
    mode: 'ssh',
  },
  'ssh-turn-start': {
    script: 'tests/active-session-recovery-smoke.cjs',
    selected: 'codex-turn-start-before-reply-crash',
    cases: 1,
    mode: 'ssh',
  },
  'ssh-string-approval': {
    script: 'tests/active-session-recovery-smoke.cjs',
    selected: 'codex-pending-approval-string-id-crash',
    cases: 1,
    mode: 'ssh',
  },
  'ssh-studio': {
    script: 'tests/active-session-recovery-smoke.cjs',
    selected: 'studio-',
    cases: 8,
    mode: 'ssh',
  },
  'local-codex-stream': {
    script: 'tests/active-session-recovery-smoke.cjs',
    selected: 'codex-stream-crash',
    cases: 1,
    mode: 'local',
  },
  'local-claude-approval': {
    script: 'tests/active-session-recovery-smoke.cjs',
    selected: 'claude-pending-approval-crash',
    cases: 1,
    mode: 'local',
  },
}
const SOURCE_ROOTS = [
  'src',
  'tests',
  'build',
  'scripts',
  'package.json',
  'package-lock.json',
  'AGENTS.md',
  'CLAUDE.md',
  'electron.vite.config.ts',
  'tsconfig.json',
  'vitest.config.ts',
]
const CACHE_NAMES = ['.cache', '.vite', '.vite-*']

function chooseStages(name) {
  if (name === undefined) return [...DEFAULT_STAGES]
  assert.ok(Object.hasOwn(STAGES, name), `Choose one stage: ${Object.keys(STAGES).join(', ')}`)
  return [name]
}
function repositoryPath(root, path) {
  assert.ok(typeof path === 'string' && path.length && !isAbsolute(path) && !path.includes('\\'))
  const result = resolve(root, path)
  const inside = relative(root, result)
  assert.ok(inside && inside.split('/')[0] !== '..')
  assert.equal(inside, path, 'Manifest paths use canonical repository-relative spelling')
  return result
}
async function verifyManifest(repository, path) {
  const bytes = await readFile(path)
  const manifest = JSON.parse(bytes.toString('utf8'))
  assert.equal(manifest.version, 1)
  assert.ok(Array.isArray(manifest.inputs) && manifest.inputs.length)
  const entries = [...manifest.inputs, ...(manifest.originalInputs || [])]
  const checked = new Map()
  for (const entry of entries) {
    assert.match(entry.sha256, /^[a-f0-9]{64}$/u)
    const target = repositoryPath(repository, entry.path)
    if (checked.has(entry.path)) assert.equal(checked.get(entry.path), entry.sha256)
    const info = await lstat(target)
    assert.ok(info.isFile() && !info.isSymbolicLink())
    assert.equal(hash(await readFile(target)), entry.sha256, entry.path)
    if (entry.mode !== undefined) assert.equal(info.mode & 0o7777, entry.mode)
    checked.set(entry.path, entry.sha256)
  }
  return {
    path,
    sha256: hash(bytes),
    inputs: [...checked].map(([path, sha256]) => ({ path, sha256 })),
  }
}
async function tree(root, path = '', { dependencies = false, missing = false } = {}) {
  const absolute = join(root, path)
  let info
  try {
    info = await lstat(absolute)
  } catch (error) {
    if (missing && error.code === 'ENOENT') return [{ path, kind: 'missing' }]
    throw error
  }
  const mode = info.mode & 0o7777
  if (info.isSymbolicLink()) {
    assert.ok(dependencies, 'Source and compiled application entries must be regular files')
    assert.notEqual(
      relative(root, await realpath(absolute)).split('/')[0],
      '..',
      'Dependency symlinks remain inside the fingerprinted store',
    )
    return [{ path, kind: 'symlink', mode, target: await readlink(absolute) }]
  }
  if (info.isFile())
    return [{ path, kind: 'file', mode, bytes: info.size, sha256: hash(await readFile(absolute)) }]
  assert.ok(info.isDirectory())
  const result = [{ path, kind: 'directory', mode }]
  for (const name of (await readdir(absolute)).sort()) {
    if (
      dependencies &&
      path === '' &&
      (name === '.cache' || name === '.vite' || name.startsWith('.vite-'))
    )
      continue
    result.push(...(await tree(root, path ? join(path, name) : name, { dependencies, missing })))
  }
  return result
}
const digest = (entries) => hash(JSON.stringify(entries))
async function applicationIdentity(repository, appPath, options = {}) {
  assert.ok(
    (await lstat(join(appPath, 'src'))).isDirectory(),
    'The application retains its complete customization source',
  )
  assert.ok(
    (await lstat(join(appPath, 'out/main/index.js'))).isFile(),
    'Build the selected application first',
  )
  const source = []
  for (const path of SOURCE_ROOTS) source.push(...(await tree(repository, path, { missing: true })))
  source.sort((a, b) => a.path.localeCompare(b.path))
  const appSource = []
  for (const path of SOURCE_ROOTS) appSource.push(...(await tree(appPath, path, { missing: true })))
  appSource.sort((a, b) => a.path.localeCompare(b.path))
  const out = await tree(appPath, 'out')
  const dependencyRoot = await realpath(options.dependencyRoot || join(repository, 'node_modules'))
  assert.equal(
    await realpath(join(appPath, 'node_modules')),
    dependencyRoot,
    'The selected application resolves the same fingerprinted dependency store',
  )
  // Resolve stock Electron first: its package may install the binary lazily.
  // The initial immutable dependency graph must include that installation.
  const electronPath = options.electronPath || require('electron')
  const dependencies = await tree(dependencyRoot, '', { dependencies: true })
  const nodePath = options.nodePath || process.execPath
  const electron = {
    executable: electronPath,
    sha256: hash(await readFile(electronPath)),
    version: options.electronVersion || require('electron/package.json').version,
  }
  const node = {
    executable: nodePath,
    sha256: hash(await readFile(nodePath)),
    version: options.nodeVersion || process.version,
  }
  return {
    version: 1,
    repository,
    appPath,
    sourceGraphSha256: digest(source),
    appSourceGraphSha256: digest(appSource),
    outGraphSha256: digest(out),
    dependencyGraphSha256: digest(dependencies),
    dependencyRoot,
    excludedDevelopmentCaches: CACHE_NAMES,
    electron,
    node,
    mainSha256: hash(await readFile(join(appPath, 'out/main/index.js'))),
    checkpointWorkerSha256: hash(
      await readFile(join(appPath, 'out/main/conversation-checkpoint-worker.js')),
    ),
    graphs: { source, appSource, out, dependencies },
  }
}
function compareIdentity(before, after) {
  for (const key of [
    'repository',
    'appPath',
    'sourceGraphSha256',
    'appSourceGraphSha256',
    'outGraphSha256',
    'dependencyGraphSha256',
    'dependencyRoot',
    'mainSha256',
    'checkpointWorkerSha256',
  ])
    assert.equal(after[key], before[key], `Runtime preserves ${key}`)
  assert.deepEqual(after.electron, before.electron)
  assert.deepEqual(after.node, before.node)
}
function stageEnvironment(environment, repository, appPath, artifacts, selection) {
  const output = { ...environment, LIFE_TEST_APP_PATH: appPath, LIFE_TEST_ARTIFACTS_DIR: artifacts }
  for (const name of [
    'DISPLAY',
    'XAUTHORITY',
    'LIFE_ELECTRON_BINARY',
    'ELECTRON_RUN_AS_NODE',
    'NODE_OPTIONS',
    'LIFE_TEST_EXPECT_RECOVERY_GAP',
    'LIFE_TEST_RECOVERY_CASE',
    'LIFE_TEST_RELOAD_CASE',
    'LIFE_TEST_MAIN_OBSERVER_TAPE',
    'LIFE_TEST_OBSERVER_ADAPTER',
    'LIFE_TEST_ACTIVE_RECOVERY_MODE',
    'LIFE_TEST_LOCAL_PROOF',
    'LIFE_TEST_RUNNER_OWNERSHIP_CAPTURE',
  ])
    delete output[name]
  if (selection.selected) output.LIFE_TEST_RECOVERY_CASE = selection.selected
  if (!selection.artifactStage) {
    output.LIFE_TEST_ACTIVE_RECOVERY_MODE = selection.mode
    output.LIFE_TEST_OBSERVER_ADAPTER = '1'
    output.LIFE_TEST_RUNNER_OWNERSHIP_CAPTURE = '1'
    if (selection.mode === 'local') output.LIFE_TEST_LOCAL_PROOF = '1'
  }
  return output
}
function stageCommand(repository, selection, inputArtifacts) {
  const helpers = join(repository, 'tests/helpers/active-recovery-observer')
  if (selection.artifactStage) {
    assert.ok(inputArtifacts)
    return [process.execPath, join(helpers, 'source-artifacts.cjs'), inputArtifacts]
  }
  const args = [
    process.execPath,
    '--require',
    join(helpers, 'local-bootstrap.cjs'),
    '--require',
    join(helpers, 'fixture-observer.cjs'),
    '--require',
    join(helpers, 'runner-contract.cjs'),
  ]
  if (selection.mode === 'local') args.push('--require', join(helpers, 'local-proof.cjs'))
  args.push(join(repository, selection.script), ...(selection.args || []))
  return args
}
function processStat(pid, raw) {
  assert.ok(Number.isSafeInteger(pid) && pid > 1)
  assert.equal(Number(raw.slice(0, raw.indexOf(' '))), pid)
  const fields = raw
    .slice(raw.lastIndexOf(')') + 2)
    .trim()
    .split(/\s/u)
  assert.ok(fields.length > 19 && /^\d+$/u.test(fields[19]))
  return { pid, state: fields[0], startTicks: fields[19] }
}
async function observeProcess(pid) {
  try {
    return { status: 'present', ...processStat(pid, await readFile(`/proc/${pid}/stat`, 'utf8')) }
  } catch (error) {
    if (error.code === 'ENOENT' || error.code === 'ESRCH') return { pid, status: 'absent' }
    throw error
  }
}
async function privateBrokerStates(root) {
  const directory = join(root, '.life', 'agent-sessions')
  let names
  try {
    names = await readdir(directory)
  } catch (error) {
    if (error.code === 'ENOENT') return []
    throw error
  }
  const states = []
  assert.equal((await lstat(directory)).isSymbolicLink(), false)
  for (const name of names.sort()) {
    assert.match(name, /^[a-zA-Z0-9_-]{1,80}$/u)
    const folder = await lstat(join(directory, name))
    assert.ok(folder.isDirectory() && !folder.isSymbolicLink())
    const path = join(directory, name, 'state.json')
    const info = await lstat(path)
    assert.ok(info.isFile() && !info.isSymbolicLink())
    const bytes = await readFile(path)
    const state = JSON.parse(bytes.toString('utf8'))
    assert.equal(state.id, name)
    states.push({
      path,
      sha256: hash(bytes),
      state,
      processes: await Promise.all(
        [state.pid, state.brokerPid]
          .filter((pid) => Number.isSafeInteger(pid) && pid > 1)
          .map(observeProcess),
      ),
    })
  }
  return states
}
async function retainFile(sourceRoot, source, target) {
  const inside = relative(sourceRoot, source)
  assert.ok(inside && inside.split('/')[0] !== '..')
  let current = sourceRoot
  assert.equal((await lstat(current)).isSymbolicLink(), false)
  for (const component of inside.split('/')) {
    current = join(current, component)
    assert.equal(
      (await lstat(current)).isSymbolicLink(),
      false,
      'Only private regular fixture files are retained',
    )
  }
  assert.ok((await lstat(source)).isFile())
  const bytes = await readFile(source)
  await mkdir(resolve(target, '..'), { recursive: true, mode: 0o700 })
  await writeFile(target, bytes, { mode: 0o600, flag: 'wx' })
  return { originalPath: source, retainedPath: target, bytes: bytes.length, sha256: hash(bytes) }
}
async function retainOwnershipFiles(harness, brokers) {
  assert.match(harness.name, /^[a-zA-Z0-9_-]+$/u)
  const directory = join(harness.artifacts, 'runner-ownership', harness.name)
  const retained = []
  for (const broker of brokers) {
    const folder = resolve(broker.path, '..')
    for (const name of ['state.json', 'session.json', 'journal.jsonl', 'input-digests']) {
      const path = join(folder, name)
      try {
        retained.push(
          await retainFile(
            harness.fixture.root,
            path,
            join(directory, 'remote', broker.state.id, name),
          ),
        )
      } catch (error) {
        if (error.code !== 'ENOENT') throw error
      }
    }
  }
  const userData = harness.launches.at(-1).userData
  assert.notEqual(relative(harness.configurationRoot, userData).split('/')[0], '..')
  const nativeDirectory = join(userData, 'native-recovery')
  let names
  try {
    names = await readdir(nativeDirectory)
  } catch (error) {
    if (error.code === 'ENOENT') return retained
    throw error
  }
  for (const name of names.filter((name) => /^[a-f0-9]{64}\.jsonl$/u.test(name)).sort())
    retained.push(
      await retainFile(
        harness.configurationRoot,
        join(nativeDirectory, name),
        join(directory, 'native', name),
      ),
    )
  return retained
}
function installOwnershipCapture({ RecoveryHarness }) {
  const originalLaunch = RecoveryHarness.prototype.launch
  const originalSave = RecoveryHarness.prototype.saveEvidence
  RecoveryHarness.prototype.launch = async function (...args) {
    const result = await Reflect.apply(originalLaunch, this, args)
    this.runnerOwnedLaunches ||= []
    const identity = await observeProcess(this.application.process().pid)
    assert.equal(identity.status, 'present')
    this.runnerOwnedLaunches.push(identity)
    const directory = join(this.artifacts, 'runner-ownership')
    await mkdir(directory, { recursive: true, mode: 0o700 })
    await writeFile(
      join(directory, `launch-${identity.pid}.json`),
      JSON.stringify(identity) + '\n',
      { mode: 0o600, flag: 'wx' },
    )
    return result
  }
  RecoveryHarness.prototype.saveEvidence = async function (name, evidence) {
    const brokers = await privateBrokerStates(this.fixture.root)
    const pids = [
      ...new Set(
        this.log()
          .map((entry) => entry.pid)
          .filter((pid) => Number.isSafeInteger(pid) && pid > 1),
      ),
    ]
    const providers = await Promise.all(pids.map(observeProcess))
    const retainedArtifacts = await retainOwnershipFiles(this, brokers)
    const capture = {
      version: 1,
      fixtureRoot: this.fixture.root,
      nativeLaunches: this.runnerOwnedLaunches || [],
      brokers,
      providers,
      retainedArtifacts,
      originalOraclesUnchanged: true,
    }
    return Reflect.apply(originalSave, this, [name, { ...evidence, runnerOwnership: capture }])
  }
  return {
    restore() {
      RecoveryHarness.prototype.launch = originalLaunch
      RecoveryHarness.prototype.saveEvidence = originalSave
    },
  }
}
function verifyPermissionConsumption(evidence) {
  const observer = evidence.recoveryObserver
  assert.ok(observer)
  assert.equal(observer.artificialRecoverCalls, 0)
  assert.equal(observer.syntheticAgentEvents, 0)
  const verified = []
  for (const observation of observer.approvalObservations.filter(
    (value) => value.genuineRecovery,
  )) {
    const binding = observation.originalNativeBinding
    const requested = evidence.providerLog.filter(
      (value) =>
        value.kind === 'permission-requested' && value.threadId === binding.thread.remoteId,
    )
    const responses = evidence.providerLog.filter(
      (value) => value.kind === 'permission-response' && value.threadId === binding.thread.remoteId,
    )
    assert.equal(requested.length, 1)
    assert.equal(responses.length, 1, 'The unchanged Allow click is consumed once')
    const response = responses[0]
    assert.equal(response.pid, requested[0].pid)
    assert.deepEqual(requested[0].request, binding.originalNativeEnvelope)
    assert.equal(response.wireId, binding.originalNativeRequestId)
    assert.deepEqual(response.originalRequest, binding.originalNativeEnvelope)
    if (binding.thread.provider === 'claude') {
      assert.equal(response.message.response.subtype, 'success')
      assert.equal(response.message.response.request_id, binding.originalNativeRequestId)
      assert.equal(response.message.response.response.behavior, 'allow')
      assert.deepEqual(
        response.message.response.response.updatedInput,
        binding.originalNativeEnvelope.request.input,
      )
    } else {
      assert.equal(response.message.id, binding.originalNativeRequestId)
      assert.equal(response.message.result.decision, 'accept')
    }
    const journal = readJournal(binding.originalJournal.path)
    const nativeInputs = journal.records.filter(
      (value) =>
        value.kind === 'input' &&
        value.input.semantic.kind === 'permission-response' &&
        value.input.semantic.permissionRequestId === binding.originalNativeRequestId &&
        value.input.semantic.sessionId === binding.thread.id,
    )
    assert.equal(nativeInputs.length, 1)
    assert.equal(
      nativeInputs[0].input.semantic.ownerGeneration,
      binding.event.nativeRecovery.ownerGeneration,
    )
    const bytes = Buffer.from(nativeInputs[0].input.frame.data, 'base64')
    assert.deepEqual(JSON.parse(bytes.toString('utf8')), response.message)
    verified.push({
      name: evidence.name,
      nativeRequestId: response.wireId,
      localRequestId: binding.event.requestId,
      originalNativePID: response.pid,
      exactNativeInputSequence: nativeInputs[0].input.sequence,
      exactNativeInputSha256: hash(bytes),
      nativeGeneration: binding.event.nativeRecovery.ownerGeneration,
      originalEnvelopeSha256: binding.originalNativeLineSha256,
      consumptionCount: 1,
    })
  }
  return verified
}
function verifyLocalProof(proof) {
  assert.equal(proof.version, 1)
  assert.equal(proof.transport, 'local')
  for (const name of [
    'genuineLocalMachine',
    'sameLogicalDescriptor',
    'samePhysicalMapping',
    'sameNativeProcessIdentity',
    'coldHostExited',
    'realReattachment',
  ])
    assert.equal(proof.assertions[name], true, name)
  for (const name of ['before-crash', 'after-crash', 'after-reopen', 'final'])
    assert.ok(proof.phases.some((value) => value.phase === name))
}
module.exports = {
  DEFAULT_STAGES,
  STAGES,
  SOURCE_ROOTS,
  CACHE_NAMES,
  chooseStages,
  repositoryPath,
  verifyManifest,
  tree,
  applicationIdentity,
  compareIdentity,
  stageEnvironment,
  stageCommand,
  processStat,
  observeProcess,
  privateBrokerStates,
  retainFile,
  retainOwnershipFiles,
  installOwnershipCapture,
  verifyPermissionConsumption,
  verifyLocalProof,
}
if (
  process.env.LIFE_TEST_RUNNER_OWNERSHIP_CAPTURE === '1' &&
  process.type === undefined &&
  process.env.LIFE_TEST_BOOTSTRAP_CHILD !== '1'
) {
  const repository = resolve(__dirname, '../../..')
  installOwnershipCapture({
    RecoveryHarness: require(join(repository, 'tests/helpers/active-session-recovery-steps.cjs'))
      .RecoveryHarness,
  })
}
