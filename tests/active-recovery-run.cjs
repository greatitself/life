#!/usr/bin/env node
// Portable tracked fixture driver. Build first; every stage retains its own evidence.
const assert = require('node:assert/strict')
const { randomInt } = require('node:crypto')
const { spawn } = require('node:child_process')
const { existsSync, mkdirSync, rmSync } = require('node:fs')
const { mkdir, readFile, readdir, writeFile } = require('node:fs/promises')
const { join, resolve } = require('node:path')
const contract = require('./helpers/active-recovery-observer/runner-contract.cjs')
const repository = resolve(__dirname, '..')
const helpers = join(repository, 'tests/helpers/active-recovery-observer')
const manifestPath = join(helpers, 'fixture-manifest.json')
const runtimeInputs = [
  'tests/active-recovery-run.cjs',
  ...[
    'contract.cjs',
    'portable-wire.cjs',
    'main-observer.cjs',
    'fixture-observer.cjs',
    'local-bootstrap.cjs',
    'local-proof.cjs',
    'runner-contract.cjs',
    'source-artifacts.cjs',
  ].map((name) => 'tests/helpers/active-recovery-observer/' + name),
  'tests/active-session-recovery-smoke.cjs',
  'tests/active-session-reload-smoke.cjs',
  'tests/helpers/active-session-recovery-steps.cjs',
  'tests/helpers/active-session-recovery-provider.cjs',
  'tests/helpers/active-session-reload-provider.cjs',
  'tests/helpers/ssh-fixture.ts',
  'tests/helpers/desktop-history.cjs',
]
const pause = (ms) => new Promise((done) => setTimeout(done, ms))
const json = async (path) => JSON.parse(await readFile(path, 'utf8'))
const save = async (path, value) =>
  writeFile(path, JSON.stringify(value, null, 2) + '\n', { mode: 0o600 })

function completionOf(child) {
  const completion = new Promise((done, reject) => {
    child.once('error', reject)
    child.once('close', (code, signal) => done({ code, signal }))
  })
  // Own an early spawn rejection while /proc/display identity reads are pending.
  void completion.catch(() => {})
  return completion
}

async function runSequence(stages, execute) {
  const results = []
  for (const name of stages) results.push(await execute(name))
  return results
}
function reserveDisplay() {
  for (let attempt = 0; attempt < 40; attempt++) {
    const display = randomInt(500, 4500)
    if (existsSync(`/tmp/.X${display}-lock`) || existsSync(`/tmp/.X11-unix/X${display}`)) continue
    const reservation = `/tmp/life-active-recovery-run-display-${display}.lock`
    try {
      mkdirSync(reservation, { mode: 0o700 })
      return { display, reservation }
    } catch (error) {
      if (error.code !== 'EEXIST') throw error
    }
  }
  throw new Error('Could not reserve an unused private X display')
}
async function execute(command, environment, cwd, record, artifacts, stagePath) {
  let display
  let activeCommand = command
  if (!record.readOnlyArtifactStage) {
    assert.equal(
      process.platform,
      'linux',
      'These fixture workflows use the existing private Linux SSH/Xvfb fixture',
    )
    display = reserveDisplay()
    record.display = { number: display.display, reservation: display.reservation }
    activeCommand = [
      'xvfb-run',
      `--server-num=${display.display}`,
      `--error-file=${join(artifacts, 'xvfb.log')}`,
      '-s',
      '-screen 0 1440x960x24 -noreset -extension MIT-SHM',
      ...command,
    ]
  }
  record.actualCommand = activeCommand
  const child = spawn(activeCommand[0], activeCommand.slice(1), {
    cwd,
    env: environment,
    stdio: record.readOnlyArtifactStage ? ['ignore', 'pipe', 'inherit'] : 'inherit',
  })
  const completion = completionOf(child)
  record.runnerChild = child.pid ? await contract.observeProcess(child.pid) : undefined
  await save(stagePath, record)
  let output = ''
  if (child.stdout)
    child.stdout.on('data', (value) => {
      output += String(value)
      if (output.length > 16 * 1024 * 1024) child.kill('SIGTERM')
    })
  let observing = false
  const observeDisplay = async () => {
    if (!display || record.display.process || observing) return
    observing = true
    try {
      const pid = Number((await readFile(`/tmp/.X${display.display}-lock`, 'utf8')).trim())
      const identity = await contract.observeProcess(pid)
      if (identity.status === 'present') {
        record.display.process = identity
        await save(stagePath, record)
      }
    } catch (error) {
      if (error.code !== 'ENOENT') record.display.observationError = String(error)
    } finally {
      observing = false
    }
  }
  const monitor = setInterval(() => {
    void observeDisplay()
  }, 40)
  let result
  try {
    result = await completion
  } finally {
    clearInterval(monitor)
    while (observing) await pause(10)
    if (display) rmSync(display.reservation, { recursive: true, force: true })
  }
  return { ...result, output }
}
async function collectProcesses(artifacts, record) {
  const identities = new Map()
  const add = (value) => {
    if (!value || !Number.isSafeInteger(value.pid) || value.pid <= 1) return
    const prior = identities.get(value.pid)
    if (prior?.startTicks && value.startTicks) assert.equal(prior.startTicks, value.startTicks)
    identities.set(value.pid, value.startTicks ? value : prior || value)
  }
  add(record.runnerChild)
  add(record.display?.process)
  let names = []
  try {
    names = await readdir(artifacts)
  } catch {}
  for (const name of names.filter((name) => name.endsWith('.json'))) {
    const evidence = await json(join(artifacts, name))
    for (const launch of evidence.launches || []) add(launch)
    for (const entry of evidence.providerLog || []) add(entry)
    for (const launch of evidence.runnerOwnership?.nativeLaunches || []) add(launch)
    for (const entry of evidence.runnerOwnership?.providers || []) add(entry)
    for (const broker of evidence.runnerOwnership?.brokers || [])
      for (const entry of broker.processes) add(entry)
    for (const phase of evidence.localRecoveryProof?.phases || []) {
      for (const native of phase.native || []) {
        add(native.broker?.providerProcess)
        add(native.broker?.brokerProcess)
      }
    }
  }
  const launchDirectory = join(artifacts, 'runner-ownership')
  try {
    for (const name of (await readdir(launchDirectory)).filter((name) =>
      /^launch-\d+\.json$/u.test(name),
    ))
      add(await json(join(launchDirectory, name)))
  } catch (error) {
    if (error.code !== 'ENOENT') throw error
  }
  return [...identities.values()]
}
async function cleanupProof(artifacts, record) {
  const expected = await collectProcesses(artifacts, record)
  const deadline = Date.now() + 10000
  let observations
  do {
    observations = await Promise.all(
      expected.map(async (original) => {
        const current = await contract.observeProcess(original.pid)
        const originalGone =
          current.status === 'absent' ||
          (original.startTicks && current.startTicks !== original.startTicks)
        return { original, current, originalGone: Boolean(originalGone) }
      }),
    )
    if (observations.every((value) => value.originalGone)) break
    await pause(40)
  } while (Date.now() < deadline)
  const display = record.display
    ? {
        ...record.display,
        socketAbsent: !existsSync(`/tmp/.X11-unix/X${record.display.number}`),
        serverLockAbsent: !existsSync(`/tmp/.X${record.display.number}-lock`),
        reservationAbsent: !existsSync(record.display.reservation),
      }
    : undefined
  const proof = {
    scope:
      'Retained fixture process identities and private display cleanup; no live host process was selected',
    processes: observations,
    display,
    passed:
      observations.every((value) => value.originalGone) &&
      (!display || (display.socketAbsent && display.serverLockAbsent && display.reservationAbsent)),
  }
  await save(join(artifacts, 'cleanup-proof.json'), proof)
  assert.equal(proof.passed, true, 'Every observed fixture process and private display is released')
  if (!record.readOnlyArtifactStage)
    assert.ok(record.display?.process, 'The actual private Xvfb process identity was retained')
  return proof
}
async function verifyCompleted(stage, selection, artifacts, identity) {
  const proof = await json(join(artifacts, 'proof.json'))
  assert.equal(proof.cases.length, selection.cases)
  assert.equal(proof.failure, undefined)
  assert.deepEqual(proof.rendererErrors, [])
  assert.equal(proof.authenticatedProviderUse, false)
  assert.equal(proof.inferenceRequests, 0)
  assert.equal(proof.mainSha256, identity.mainSha256)
  assert.equal(proof.checkpointWorkerSha256, identity.checkpointWorkerSha256)
  const consumptions = []
  for (const entry of proof.cases) {
    const evidence = await json(join(artifacts, entry.name + '.json'))
    assert.equal(evidence.runnerOwnership?.version, 1)
    consumptions.push(...contract.verifyPermissionConsumption(evidence))
    if (selection.mode === 'local') contract.verifyLocalProof(evidence.localRecoveryProof)
  }
  if (stage === 'local-claude-approval') assert.equal(consumptions.length, 1)
  await save(join(artifacts, 'native-permission-consumption.json'), consumptions)
  return proof
}
async function runStage(stage, context) {
  const selection = contract.STAGES[stage]
  const token = new Date().toISOString().replaceAll(/[:.]/g, '-') + '-' + process.pid
  const artifacts = join(context.artifactRoot, `${stage}-${token}`)
  await mkdir(artifacts, { recursive: true, mode: 0o700 })
  const stagePath = join(artifacts, 'stage.json')
  const manifest = await contract.verifyManifest(repository, manifestPath)
  for (const path of runtimeInputs)
    assert.ok(
      manifest.inputs.some((entry) => entry.path === path),
      `Tracked fixture manifest covers ${path}`,
    )
  const before = await contract.applicationIdentity(repository, context.appPath)
  await save(join(artifacts, 'inputs-before.json'), { manifest, ...before })
  let inputArtifacts
  if (selection.artifactStage) {
    const prior =
      context.completed.get(selection.artifactStage) ||
      (await json(join(context.recordRoot, `last-successful-${selection.artifactStage}.json`)))
    assert.equal(prior.appPath, context.appPath)
    assert.equal(prior.manifestSha256, manifest.sha256)
    contract.compareIdentity(prior.identity, before)
    inputArtifacts = prior.artifacts
  }
  const command = contract.stageCommand(repository, selection, inputArtifacts)
  const record = {
    stage,
    appPath: context.appPath,
    artifacts,
    inputArtifacts,
    manifestSha256: manifest.sha256,
    expectedCases: selection.cases,
    selectedCase: selection.selected,
    mode: selection.mode,
    readOnlyArtifactStage: selection.artifactStage,
    command,
    startedAt: new Date().toISOString(),
    scope:
      'Private genuine Electron/SSH or Local native-protocol stand-ins; no authentication, inference, historical baseline or performance claim',
  }
  await save(stagePath, record)
  let failure
  try {
    const result = await execute(
      command,
      contract.stageEnvironment(process.env, repository, context.appPath, artifacts, selection),
      repository,
      record,
      artifacts,
      stagePath,
    )
    record.exitCode = result.code
    record.signal = result.signal
    if (selection.artifactStage)
      await writeFile(join(artifacts, 'source-artifact-verification.json'), result.output, {
        mode: 0o600,
      })
    assert.equal(result.code, 0, `${stage} fixture process succeeded`)
    if (!selection.artifactStage) await verifyCompleted(stage, selection, artifacts, before)
  } catch (error) {
    failure = error
    record.failure = { message: String(error), stack: error.stack }
  }
  try {
    record.cleanup = await cleanupProof(artifacts, record)
  } catch (error) {
    failure ||= error
    record.cleanupFailure = String(error)
  }
  try {
    const afterManifest = await contract.verifyManifest(repository, manifestPath)
    assert.equal(afterManifest.sha256, manifest.sha256)
    const after = await contract.applicationIdentity(repository, context.appPath)
    await save(join(artifacts, 'inputs-after.json'), { manifest: afterManifest, ...after })
    contract.compareIdentity(before, after)
    record.inputsPreserved = true
  } catch (error) {
    failure ||= error
    record.verificationFailure = String(error)
  }
  record.finishedAt = new Date().toISOString()
  await save(stagePath, record)
  if (failure) throw failure
  const successful = {
    stage,
    appPath: context.appPath,
    manifestSha256: manifest.sha256,
    identity: before,
    artifacts,
    stageRecord: stagePath,
  }
  context.completed.set(stage, successful)
  await save(join(context.recordRoot, `last-successful-${stage}.json`), successful)
  console.log(JSON.stringify({ stage, passed: true, artifacts, stageRecord: stagePath }))
  return successful
}
async function main() {
  if (process.argv[2] === '--help') {
    console.log(
      JSON.stringify(
        {
          defaultStages: contract.DEFAULT_STAGES,
          stages: contract.STAGES,
          buildFirst: true,
          scope:
            'Private native-protocol stand-ins; no authentication, inference, historical comparison or performance claim',
        },
        null,
        2,
      ),
    )
    return
  }
  assert.equal(
    process.env.ESBUILD_BINARY_PATH,
    undefined,
    'Use the installed fingerprinted esbuild binary',
  )
  const stages = contract.chooseStages(process.argv[2])
  assert.equal(process.argv.length <= 3, true)
  const appPath = resolve(process.env.LIFE_TEST_APP_PATH || repository)
  const artifactRoot = resolve(
    process.env.LIFE_TEST_ARTIFACTS_DIR ||
      join(repository, 'output/playwright/active-recovery-run'),
  )
  const recordRoot = join(artifactRoot, 'stages')
  await mkdir(recordRoot, { recursive: true, mode: 0o700 })
  await runSequence(stages, (stage) =>
    runStage(stage, { appPath, artifactRoot, recordRoot, completed: contextCompleted }),
  )
}
const contextCompleted = new Map()
module.exports = {
  completionOf,
  runSequence,
  runtimeInputs,
  collectProcesses,
  cleanupProof,
  verifyCompleted,
  runStage,
  main,
}
if (require.main === module)
  main().catch((error) => {
    console.error(error)
    process.exitCode = 1
  })
