const { spawn } = require('node:child_process')
const { createHash, randomUUID } = require('node:crypto')
const { mkdir, readFile, rename, stat, writeFile } = require('node:fs/promises')
const { join, resolve } = require('node:path')

const repository = resolve(__dirname, '../..')
const appPath = process.env.LIFE_TEST_APP_PATH
if (!appPath) throw new Error('LIFE_TEST_APP_PATH must select the verified private app snapshot')
const caseName = process.env.LIFE_METADATA_QUIT_CASE
if (
  !['local-allocated', 'ssh-allocated', 'local-preallocation', 'ssh-preallocation'].includes(
    caseName,
  )
) {
  throw new Error('Select an explicit LIFE_METADATA_QUIT_CASE')
}
const [transport, phase] = caseName.split('-')
const expectedMain = process.env.LIFE_METADATA_QUIT_EXPECT_MAIN_SHA256
if (!/^[a-f0-9]{64}$/.test(expectedMain || '')) throw new Error('Require the BUILD GO main SHA256')
const artifacts = resolve(
  process.env.LIFE_METADATA_QUIT_ARTIFACTS || join(__dirname, 'run', caseName),
)
const requestedDeadline = Number(process.env.LIFE_METADATA_QUIT_DEADLINE_MS || 150000)
if (!Number.isInteger(requestedDeadline) || requestedDeadline < 1 || requestedDeadline > 180000) {
  throw new Error('LIFE_METADATA_QUIT_DEADLINE_MS must be an integer from 1 to 180000')
}
const proofPath = join(artifacts, 'owned-runner.json')
const ledgerPath = join(artifacts, 'ownership-ledger.json')
const nativeProofPath = join(artifacts, 'proof.json')
const proof = {
  runId: randomUUID(),
  startedAt: new Date().toISOString(),
  deadlineMs: requestedDeadline,
  case: { name: caseName, transport, phase },
  appPath: resolve(appPath),
  expectedMain,
  artifacts,
  xvfbArgs: [
    '-displayfd',
    '3',
    '-screen',
    '0',
    '1920x1080x24',
    '-nolisten',
    'tcp',
    '-extension',
    'MIT-SHM',
  ],
  cleanup: [],
  ledgerReads: [],
  processInspectionErrors: [],
  nativeShutdownCertified: false,
}
let server
let fixture
let deadlineTimer
let stopReason
let stopRun
let knownLeases = []
const inspectionFailures = new Set()
const stopped = new Promise((resolveStop) => {
  stopRun = resolveStop
})
const delay = (milliseconds) => new Promise((done) => setTimeout(done, milliseconds))
const now = () => new Date().toISOString()
const identity = (lease) => `${lease.pid}:${lease.startTicks}`
function fail(message) {
  proof.error ||= message
  process.exitCode = 1
}
function requestStop(reason) {
  if (stopReason) return
  stopReason = reason
  process.exitCode = reason.kind === 'signal' ? (reason.signal === 'SIGINT' ? 130 : 143) : 1
  proof.stop = { ...reason, at: now() }
  stopRun({ stopped: true, reason })
}
const onTerm = () => requestStop({ kind: 'signal', signal: 'SIGTERM' })
const onInt = () => requestStop({ kind: 'signal', signal: 'SIGINT' })
process.on('SIGTERM', onTerm)
process.on('SIGINT', onInt)

async function readProcess(pid) {
  if (!Number.isSafeInteger(pid) || pid < 2) return null
  try {
    const value = await readFile(`/proc/${pid}/stat`, 'utf8')
    const fields = value
      .slice(value.lastIndexOf(')') + 2)
      .trim()
      .split(/\s+/)
    if (!/^\d+$/.test(fields[19] || '')) throw new Error('Invalid process start ticks')
    return { pid, startTicks: fields[19], state: fields[0] }
  } catch (error) {
    if (error.code === 'ENOENT' || error.code === 'ESRCH') return null
    throw error
  }
}
async function inspect(lease) {
  try {
    const current = await readProcess(lease.pid)
    const matched = current?.startTicks === String(lease.startTicks)
    const status = !current
      ? 'absent'
      : !matched
        ? 'different-process'
        : current.state === 'Z'
          ? 'zombie'
          : ['X', 'x'].includes(current.state)
            ? 'dead-present'
            : 'running'
    return {
      ...lease,
      observedAt: now(),
      present: Boolean(current),
      matched,
      state: current?.state || null,
      status,
      terminated: ['absent', 'different-process', 'zombie', 'dead-present'].includes(status),
    }
  } catch (error) {
    const key = `${identity(lease)}:${error.code || error.message}`
    if (!inspectionFailures.has(key)) {
      inspectionFailures.add(key)
      proof.processInspectionErrors.push({
        ...lease,
        error: error.code || error.message,
        at: now(),
      })
    }
    return {
      ...lease,
      observedAt: now(),
      status: 'unknown',
      terminated: false,
      error: error.code || error.message,
    }
  }
}
function observe(child, kind) {
  let terminal
  const childErrors = []
  let resolveExit
  const exit = new Promise((done) => {
    resolveExit = done
  })
  const finish = (value) => {
    if (!terminal) {
      terminal = { ...value, at: now() }
      resolveExit(terminal)
    }
  }
  child.on('error', (error) => {
    childErrors.push({ message: error.message, at: now() })
    if (childErrors.length > 64) childErrors.shift()
    if (!Number.isSafeInteger(child.pid))
      finish({ error: error.message, code: null, signal: null, event: 'spawn-error' })
  })
  child.once('exit', (code, signal) => finish({ code, signal, event: 'exit' }))
  child.once('close', (code, signal) => finish({ code, signal, event: 'close' }))
  if (child.exitCode !== null || child.signalCode !== null)
    finish({ code: child.exitCode, signal: child.signalCode })
  return {
    child,
    kind,
    pid: child.pid,
    spawnedAt: now(),
    startTicks: null,
    childErrors,
    exit,
    get terminal() {
      return terminal
    },
  }
}
async function identify(owned) {
  for (let attempt = 0; attempt < 10; attempt += 1) {
    owned.startTicks = (await readProcess(owned.pid))?.startTicks || null
    if (owned.startTicks || owned.terminal) return
    await delay(5)
  }
  throw new Error(`Cannot establish the owned ${owned.kind} process identity`)
}
function record(owned) {
  return (
    owned && {
      pid: owned.pid ?? null,
      startTicks: owned.startTicks,
      kind: owned.kind,
      spawnedAt: owned.spawnedAt,
      terminal: owned.terminal ?? null,
      childErrors: owned.childErrors,
    }
  )
}
async function saveProof() {
  proof.xvfb = record(server)
  proof.fixture = record(fixture)
  const temporary = `${proofPath}.${process.pid}.tmp`
  await writeFile(temporary, `${JSON.stringify(proof, null, 2)}\n`)
  await rename(temporary, proofPath)
}
async function signalLease(lease, signal) {
  const observation = await inspect(lease)
  const result = {
    pid: lease.pid,
    startTicks: String(lease.startTicks),
    kind: lease.kind,
    signal,
    matched: observation.matched === true,
    status: observation.status,
    state: observation.state || null,
    sent: false,
    at: now(),
  }
  if (observation.status === 'running' && observation.matched) {
    try {
      process.kill(lease.pid, signal)
      result.sent = true
    } catch (error) {
      result.error = error.code || error.message
    }
  } else if (observation.error) result.error = observation.error
  proof.cleanup.push(result)
  return result.sent
}
async function waitTerminated(leases, milliseconds) {
  const deadline = Date.now() + milliseconds
  let observations
  do {
    observations = await Promise.all(leases.map(inspect))
    if (observations.every((value) => value.terminated)) return observations
    if (Date.now() >= deadline) return observations
    await delay(25)
  } while (true)
}
async function ledgerLeases() {
  let lastError
  for (let attempt = 0; attempt < 3; attempt += 1) {
    try {
      const contents = await readFile(ledgerPath, 'utf8')
      const ledger = JSON.parse(contents)
      if (ledger.runId !== proof.runId)
        throw new Error('Ownership ledger belongs to a different runner invocation')
      if (ledger.appPath !== proof.appPath)
        throw new Error('Ownership ledger app does not match the selected snapshot')
      if (
        ledger.case?.name !== caseName ||
        ledger.case?.transport !== transport ||
        ledger.case?.phase !== phase
      )
        throw new Error('Ownership ledger case does not match this runner')
      if (!Array.isArray(ledger.leases)) throw new Error('Ownership ledger does not contain leases')
      const reserved = new Set([process.pid, server?.pid, fixture?.pid])
      const unique = new Map()
      for (const lease of ledger.leases) {
        if (
          !Number.isSafeInteger(lease.pid) ||
          lease.pid < 2 ||
          reserved.has(lease.pid) ||
          !/^\d+$/.test(String(lease.startTicks)) ||
          typeof lease.kind !== 'string'
        )
          throw new Error('Ownership ledger contains an invalid or reserved process lease')
        unique.set(identity(lease), {
          pid: lease.pid,
          startTicks: String(lease.startTicks),
          kind: lease.kind,
          ...(lease.sessionId ? { sessionId: lease.sessionId } : {}),
        })
      }
      proof.ledger = {
        valid: true,
        path: ledgerPath,
        sha256: createHash('sha256').update(contents).digest('hex'),
        observedAt: now(),
        leaseCount: unique.size,
      }
      proof.ledgerReads.push(proof.ledger)
      knownLeases = [...unique.values()]
      return knownLeases
    } catch (error) {
      lastError = error
      if (attempt < 2) await delay(20)
    }
  }
  proof.ledger = {
    valid: false,
    path: ledgerPath,
    observedAt: now(),
    error: lastError.code || lastError.message,
  }
  proof.ledgerReads.push(proof.ledger)
  throw lastError
}
async function stableLedger() {
  let previous
  for (let attempt = 0; attempt < 4; attempt += 1) {
    const leases = await ledgerLeases()
    if (proof.ledger.sha256 === previous) {
      proof.finalLedgerStable = true
      return leases
    }
    previous = proof.ledger.sha256
    await delay(25)
  }
  throw new Error('Final ownership ledger did not stabilize after allocator cutoff')
}
async function validateNativeQuit(leases) {
  const contents = await readFile(nativeProofPath, 'utf8')
  const native = JSON.parse(contents)
  const requireClaim = (condition, message) => {
    if (!condition) throw new Error(message)
  }
  requireClaim(native.runId === proof.runId, 'Native quit proof belongs to a different runner')
  requireClaim(
    native.case?.name === caseName &&
      native.case?.transport === transport &&
      native.case?.phase === phase,
    'Native quit proof case does not match',
  )
  requireClaim(
    native.passed === true &&
      native.inputsUnchanged === true &&
      JSON.stringify(native.inputsBefore) === JSON.stringify(native.inputsAfter),
    'Native quit proof did not pass with immutable inputs',
  )
  requireClaim(
    native.shutdown?.mainExitCode === 0 &&
      native.shutdown?.mainSignalCode === null &&
      native.shutdown?.mainActuallyReaped === true &&
      native.shutdown?.manualProcessCleanup === false &&
      native.shutdown?.allOwnedLeasesReleased === true,
    'Native quit proof does not certify normal shutdown without cleanup',
  )
  requireClaim(
    native.authenticatedProviderUse === false &&
      native.inferenceRequests === 0 &&
      Array.isArray(native.rendererErrors) &&
      native.rendererErrors.every((error) => error.stage === 'after-quit-request'),
    'Native quit proof reports auth, inference, or renderer errors before quit',
  )
  requireClaim(
    !native.failureCleanup &&
      !native.runnerCutoff &&
      !native.cleanupError &&
      !native.collectionError &&
      !native.staticServerError,
    'Native quit proof reports failure or external cleanup',
  )
  const main = native.inputsBefore?.out?.files?.find((file) => file.path === 'main/index.js')
  requireClaim(main?.sha256 === expectedMain, 'Native quit proof main does not match BUILD GO')
  const runner = native.inputsBefore?.fixtures?.find((file) => resolve(file.path) === __filename)
  requireClaim(
    runner?.sha256 === proof.runnerSha256,
    'Native quit proof runner does not match the frozen launcher',
  )
  requireClaim(
    Array.isArray(native.ownedLeases) &&
      Array.isArray(native.remainingBeforeCleanup) &&
      native.remainingBeforeCleanup.every((lease) => lease.alive === false),
    'Native quit proof lacks terminal pre-cleanup lease observations',
  )
  const nativeIds = new Set(native.ownedLeases.map(identity))
  proof.postQuitRendererErrors = native.rendererErrors
  requireClaim(
    leases.length > 0 &&
      leases.some((lease) => lease.kind === 'electron-main') &&
      leases.every((lease) => nativeIds.has(identity(lease))),
    'Native quit proof does not match ownership ledger leases',
  )
  requireClaim(
    native.ownedLeases.every((lease) => leases.some((item) => identity(item) === identity(lease))),
    'Native quit proof contains leases absent from the final ledger',
  )
  const gate = native.controlledGate
  const model = gate?.observedModel
  const read = gate?.observedDirectoryRead
  const snapshot = gate?.beforeQuitSnapshot
  requireClaim(
    gate?.modelPending === true &&
      gate.sourceRevision === native.sourceRevision &&
      snapshot?.stage === 'target',
    'Controlled target gate does not report the pending native model revision',
  )
  const phases = Array.isArray(native.phases)
    ? native.phases.filter((item) => item.stage === 'target')
    : []
  const quit = phases.find(
    (item) => item.phase === 'normal-quit-entered' && item.sourceRevision === native.sourceRevision,
  )
  requireClaim(
    typeof quit?.at === 'number' && typeof snapshot?.at === 'number' && snapshot.at < quit.at,
    'Controlled gate was not observed before normal quit',
  )
  requireClaim(
    model?.channel === 'agent:models' &&
      model.phase === 'original-handler-returned' &&
      model.stage === 'target' &&
      model.document?.mounted === true &&
      model.sourceRevision === native.sourceRevision &&
      model.at <= snapshot.at,
    'Controlled gate lacks a genuine compiled-document native model request',
  )
  if (phase === 'preallocation') {
    requireClaim(
      read?.modelObservationId === model.observationId &&
        read.stage === 'target' &&
        read.sourceRevision === native.sourceRevision &&
        read.phase === 'native-recovery-read-result-held' &&
        read.at <= snapshot.at,
      'Preallocation storage hold does not match the target native model request',
    )
  }
  requireClaim(
    phases.some(
      (item) =>
        item.phase === 'ipc-entered' &&
        item.channel === 'agent:models' &&
        item.observationId === model.observationId &&
        item.sourceRevision === native.sourceRevision &&
        item.at <= model.at,
    ),
    'Target model request has no matching actual native IPC entry',
  )
  const enteredModel = phases.find(
    (item) =>
      item.phase === 'ipc-entered' &&
      item.channel === 'agent:models' &&
      item.observationId === model.observationId &&
      item.sourceRevision === native.sourceRevision,
  )
  const modelArguments = JSON.parse(
    Buffer.from(enteredModel.rawArgumentsBase64 || '', 'base64').toString('utf8'),
  )
  requireClaim(
    Array.isArray(modelArguments) && modelArguments.length === 1 && modelArguments[0] === 'codex',
    'Controlled target native model IPC arguments are not exactly the Codex request',
  )
  requireClaim(
    phases.some(
      (item) =>
        item.phase === 'model-document-observed' &&
        item.observationId === model.observationId &&
        item.sourceRevision === native.sourceRevision &&
        item.document?.mounted === true &&
        item.document.timeOrigin === model.document.timeOrigin &&
        item.at <= snapshot.at,
    ),
    'Controlled model document does not match its actual sender-frame observation',
  )
  const modelSettlements = phases.filter(
    (item) =>
      item.channel === 'agent:models' &&
      item.observationId === model.observationId &&
      ['ipc-settled-success', 'ipc-settled-error', 'ipc-synchronous-rejection'].includes(
        item.phase,
      ),
  )
  const quitIndex = phases.indexOf(quit)
  requireClaim(
    !modelSettlements.some((item) => phases.indexOf(item) < quitIndex),
    'Target model request settled before normal quit',
  )
  const ready = phases.find(
    (item) =>
      item.channel === 'source-code:ready' &&
      item.phase === 'source-ready-delegation-held' &&
      item.requestedRevision === native.sourceRevision &&
      item.sourceRevision === native.sourceRevision &&
      item.at <= snapshot.at,
  )
  requireClaim(
    ready && gate.sourceReadyAcknowledged === false,
    'Controlled gate lacks the exact unacknowledged source-ready revision',
  )
  requireClaim(
    phases.some(
      (item) =>
        item.phase === 'ipc-entered' &&
        item.channel === 'source-code:ready' &&
        item.observationId === ready.observationId &&
        item.sourceRevision === native.sourceRevision &&
        item.at <= ready.at,
    ),
    'Target source-ready request has no matching native IPC entry',
  )
  requireClaim(
    !phases.some(
      (item) =>
        item.channel === 'source-code:ready' &&
        item.observationId === ready.observationId &&
        item.actualReadyAcknowledged === true &&
        phases.indexOf(item) < quitIndex,
    ),
    'Target source-ready revision was acknowledged before normal quit',
  )
  proof.targetNativeModelSettlements = modelSettlements.map((item) => ({
    phase: item.phase,
    at: item.at,
    ...(item.message ? { message: item.message } : {}),
    relativeToQuit:
      phases.indexOf(item) >= quitIndex ? 'after-quit-entered' : 'before-quit-entered',
  }))
  if (phase === 'allocated') {
    const allocation = gate.actualReceivedModel
    const allocatedLeases = gate.allocatedProviderAndBrokerLeases
    requireClaim(
      Array.isArray(allocatedLeases) &&
        allocatedLeases.length >= 2 &&
        allocatedLeases.every(
          (lease) => lease.alive === true && lease.present === true && lease.osState !== 'Z',
        ),
      'Allocated case did not reach provider and broker ownership',
    )
    requireClaim(
      allocation?.sourceRevision === native.sourceRevision &&
        allocation.transport === transport &&
        allocation.message?.method === 'model/list' &&
        Object.hasOwn(allocation.message, 'id') &&
        allocation.at <= snapshot.at,
      'Allocated gate lacks the actual selected provider model/list request',
    )
    const received = JSON.parse(
      Buffer.from(allocation.receivedLineBytesBase64 || '', 'base64').toString('utf8'),
    )
    requireClaim(
      JSON.stringify(received) === JSON.stringify(allocation.message),
      'Allocated model/list evidence does not match the recorded received bytes',
    )
    const session = (snapshot.brokerSessions || []).find(
      (item) =>
        item.transport === transport &&
        item.state?.pid === allocation.providerPid &&
        item.leases?.some(
          (lease) => lease.alive === true && lease.kind === `${transport}-provider`,
        ) &&
        item.leases.some((lease) => lease.alive === true && lease.kind === `${transport}-broker`),
    )
    requireClaim(
      session,
      'Allocated controlled gate lacks a live provider and broker in the same selected session',
    )
    requireClaim(
      snapshot.roots?.some((root) => root.transport === transport && root.root === allocation.root),
      'Allocated model/list request belongs to a different fixture root',
    )
    const heldLeases = session.leases.filter(
      (lease) =>
        lease.alive === true &&
        [`${transport}-provider`, `${transport}-broker`].includes(lease.kind),
    )
    requireClaim(
      heldLeases.every(
        (lease) =>
          nativeIds.has(identity(lease)) &&
          leases.some((item) => identity(item) === identity(lease)),
      ),
      'Controlled provider and broker leases are absent from final ownership evidence',
    )
    requireClaim(
      allocatedLeases.every(
        (lease) =>
          lease.sessionId === session.id &&
          heldLeases.some((item) => identity(item) === identity(lease)),
      ) &&
        heldLeases.every((lease) =>
          allocatedLeases.some((item) => identity(item) === identity(lease)),
        ),
      'Allocated gate leases do not exactly match the held provider and broker session',
    )
    requireClaim(
      heldLeases.some(
        (lease) => lease.kind === `${transport}-provider` && lease.pid === allocation.providerPid,
      ) &&
        heldLeases.some(
          (lease) => lease.kind === `${transport}-broker` && lease.pid === session.state.brokerPid,
        ),
      'Allocated gate does not match both actual recorded provider and broker PIDs',
    )
    proof.controlledAllocatedSession = {
      id: session.id,
      transport,
      snapshotAt: snapshot.at,
      leases: heldLeases.map((lease) => ({
        pid: lease.pid,
        startTicks: lease.startTicks,
        kind: lease.kind,
      })),
    }
    proof.controlledReceivedModel = {
      providerPid: allocation.providerPid,
      method: allocation.message.method,
      requestId: allocation.message.id,
      receivedLineSha256: createHash('sha256')
        .update(Buffer.from(allocation.receivedLineBytesBase64, 'base64'))
        .digest('hex'),
      framing: allocation.framing,
    }
  } else {
    requireClaim(
      !gate.actualReceivedModel &&
        Array.isArray(gate.allocatedProviderAndBrokerLeases) &&
        gate.allocatedProviderAndBrokerLeases.length === 0,
      'Preallocation case reports allocated model-provider ownership',
    )
  }
  proof.nativeQuitProof = {
    path: nativeProofPath,
    sha256: createHash('sha256').update(contents).digest('hex'),
    runId: native.runId,
    case: native.case,
    normalQuitVerified: true,
  }
}
async function releaseChild(owned, frozen = false) {
  if (!owned || owned.terminal) return true
  if (!owned.startTicks) {
    proof.cleanup.push({
      kind: owned.kind,
      pid: owned.pid ?? null,
      error: 'No verified start ticks; no signal sent',
      at: now(),
    })
    return false
  }
  await signalLease(owned, frozen ? 'SIGKILL' : 'SIGTERM')
  if (await Promise.race([owned.exit.then(() => true), delay(2000).then(() => false)])) return true
  await signalLease(owned, 'SIGKILL')
  return Promise.race([owned.exit.then(() => true), delay(2000).then(() => false)])
}
async function requestCutoff() {
  proof.allocatorCutoff = { requestedAt: now(), acknowledged: false }
  if (!fixture || fixture.terminal || !fixture.child.connected) return false
  let listener
  let timer
  const acknowledgement = new Promise((done) => {
    listener = (message) => {
      if (message?.runId !== proof.runId) return
      if (message.type === 'metadata-fixture-cutoff-complete')
        done({ acknowledged: true, at: now() })
      else if (message.type === 'metadata-fixture-cutoff-failed')
        done({
          acknowledged: false,
          reason: message.message || 'Fixture rejected cooperative cutoff',
          at: now(),
        })
    }
    fixture.child.on('message', listener)
    timer = setTimeout(() => done({ acknowledged: false, reason: 'IPC cutoff deadline' }), 8000)
    fixture.child.send({ type: 'metadata-fixture-cutoff', runId: proof.runId }, (error) => {
      if (error) done({ acknowledged: false, reason: error.message })
    })
  })
  try {
    const result = await Promise.race([
      acknowledgement,
      fixture.exit.then(() => ({
        acknowledged: false,
        reason: 'Fixture exited before cutoff acknowledgement',
      })),
    ])
    Object.assign(proof.allocatorCutoff, result)
    return result.acknowledged
  } finally {
    clearTimeout(timer)
    fixture.child.removeListener('message', listener)
  }
}
async function retireLeases(leases) {
  for (const lease of leases) await signalLease(lease, 'SIGTERM')
  let observations = await waitTerminated(leases, 2000)
  for (const lease of observations.filter((value) => !value.terminated))
    await signalLease(lease, 'SIGKILL')
  return waitTerminated(leases, 2000)
}
async function failureCleanup() {
  proof.manualNativeProcessCleanup = true
  const cutoffAcknowledged = await requestCutoff()
  let frozenFixture = false
  if (fixture && !fixture.terminal && !cutoffAcknowledged)
    frozenFixture = await signalLease(fixture, 'SIGSTOP')
  let leases
  try {
    leases = await ledgerLeases()
  } catch (error) {
    fail(`Failed cleanup ledger: ${error.message}`)
    leases = knownLeases
    proof.cleanupOwnershipIncomplete = true
  }
  const allocators = leases.filter(
    (lease) => lease.kind === 'electron-main' || lease.kind.endsWith('-broker'),
  )
  if (!cutoffAcknowledged) {
    for (const lease of allocators) await signalLease(lease, 'SIGSTOP')
    proof.cleanupOwnershipIncomplete = true
    proof.allocatorCutoff.fallback =
      'Exact fixture and recorded native allocators frozen; unrecorded late ownership remains unknown'
  }
  for (const lease of leases.filter((item) => item.kind === 'electron-main'))
    await signalLease(lease, 'SIGKILL')
  proof.nativeMainAfterCutoff = await waitTerminated(
    leases.filter((item) => item.kind === 'electron-main'),
    2000,
  )
  proof.fixtureReleased = await releaseChild(fixture, frozenFixture)
  try {
    leases = await stableLedger()
  } catch (error) {
    fail(`Final cleanup ledger: ${error.message}`)
    proof.cleanupOwnershipIncomplete = true
  }
  proof.ownedLeasesBeforeDrain = await Promise.all(leases.map(inspect))
  proof.ownedLeasesAfterDrain = await retireLeases(leases)
  proof.cleanupRecordedLeasesTerminated = proof.ownedLeasesAfterDrain.every(
    (value) => value.terminated,
  )
  if (!proof.fixtureReleased || !proof.cleanupRecordedLeasesTerminated)
    fail('Owned failure resources did not terminate within the cleanup bound')
}
async function finalizeResources() {
  await mkdir(artifacts, { recursive: true })
  proof.cleanupStartedAt = now()
  await saveProof().catch((error) => {
    proof.beforeCleanupProofError = error.message
    fail(error.message)
  })
  const candidateSuccess =
    fixture?.terminal?.code === 0 &&
    !fixture.terminal.signal &&
    !fixture.terminal.error &&
    !proof.error &&
    !stopReason
  if (candidateSuccess) {
    try {
      const leases = await stableLedger()
      await validateNativeQuit(leases)
      proof.ownedLeasesBeforeCleanup = await Promise.all(leases.map(inspect))
      if (proof.ownedLeasesBeforeCleanup.some((value) => !value.terminated))
        throw new Error('Native quit left an owned lease running or unverifiable')
      if (
        proof.ownedLeasesBeforeCleanup.some(
          (value) =>
            value.kind === 'electron-main' && ['zombie', 'dead-present'].includes(value.status),
        )
      )
        throw new Error('Native main terminated but was not reaped')
      proof.nativeShutdownCertified = true
      proof.manualNativeProcessCleanup = false
      proof.fixtureReleased = true
    } catch (error) {
      fail(error.message)
    }
  }
  if (!proof.nativeShutdownCertified) await failureCleanup()
  proof.xvfbReleased = await releaseChild(server)
  if (!proof.xvfbReleased) fail('Owned Xvfb did not exit within its release bound')
}
async function ownedDisplay(owned) {
  return new Promise((ready, reject) => {
    let received = ''
    const timer = setTimeout(
      () => reject(new Error('Xvfb did not assign its owned display')),
      10000,
    )
    owned.child.stdio[3].on('data', (bytes) => {
      received += bytes.toString()
      if (received.length > 256) {
        clearTimeout(timer)
        reject(new Error('Invalid owned display acknowledgement'))
        return
      }
      if (!received.includes('\n')) return
      clearTimeout(timer)
      const line = received.split('\n')[0].trim()
      if (!/^\d+$/.test(line)) reject(new Error('Invalid owned display acknowledgement'))
      else ready(`:${line}`)
    })
    owned.exit.then((result) => {
      clearTimeout(timer)
      reject(new Error(`Owned Xvfb exited before readiness: ${JSON.stringify(result)}`))
    })
    stopped.then(() => {
      clearTimeout(timer)
      reject(new Error('Runner stopped before owned Xvfb readiness'))
    })
  })
}
async function run() {
  await mkdir(artifacts, { recursive: true })
  proof.runner = {
    pid: process.pid,
    startTicks: (await readProcess(process.pid))?.startTicks,
    startedAt: proof.startedAt,
  }
  proof.runnerSha256 = createHash('sha256')
    .update(await readFile(__filename))
    .digest('hex')
  if (!(await stat(proof.appPath)).isDirectory())
    throw new Error('LIFE_TEST_APP_PATH must be a private app snapshot directory')
  await stat(join(__dirname, 'metadata-startup-quit-native.cjs'))
  await saveProof()
  if (stopReason) throw new Error('Runner stopped before owned Xvfb launch')
  deadlineTimer = setTimeout(
    () => requestStop({ kind: 'timeout', deadlineMs: requestedDeadline }),
    requestedDeadline,
  )
  server = observe(
    spawn('Xvfb', proof.xvfbArgs, { stdio: ['ignore', 'ignore', 'pipe', 'pipe'] }),
    'Xvfb',
  )
  let diagnostics = ''
  server.child.stderr.on('data', (bytes) => {
    diagnostics = (diagnostics + bytes.toString()).slice(-8192)
    proof.xvfbDiagnostics = diagnostics
  })
  const [, display] = await Promise.all([identify(server), ownedDisplay(server)])
  proof.display = display
  if (stopReason) throw new Error('Runner stopped before fixture launch')
  fixture = observe(
    spawn(process.execPath, [join(__dirname, 'metadata-startup-quit-native.cjs')], {
      cwd: repository,
      env: {
        ...process.env,
        DISPLAY: display,
        LIFE_TEST_APP_PATH: proof.appPath,
        LIFE_METADATA_QUIT_ARTIFACTS: artifacts,
        LIFE_METADATA_QUIT_RUN_ID: proof.runId,
      },
      stdio: ['inherit', 'inherit', 'inherit', 'ipc'],
    }),
    'metadata startup-quit fixture',
  )
  await identify(fixture)
  await saveProof()
  console.log(
    JSON.stringify({
      artifacts,
      case: proof.case,
      ownedDisplay: display,
      xvfb: record(server),
      fixture: record(fixture),
      deadlineMs: requestedDeadline,
    }),
  )
  const result = await Promise.race([
    fixture.exit.then((value) => ({ fixtureExit: value })),
    server.exit.then((value) => ({ serverExit: value })),
    stopped,
  ])
  if (result.fixtureExit) {
    proof.fixtureExit = result.fixtureExit
    process.exitCode = result.fixtureExit.code ?? 1
  } else if (result.serverExit)
    throw new Error(`Owned Xvfb exited during fixture: ${JSON.stringify(result.serverExit)}`)
  else
    throw new Error(
      result.reason.kind === 'timeout'
        ? 'Metadata startup-quit fixture exceeded its deadline'
        : `Runner received ${result.reason.signal}`,
    )
}
run()
  .catch((error) => {
    fail(error.message)
    console.error(error)
    if (stopReason?.kind === 'signal') process.exitCode = stopReason.signal === 'SIGINT' ? 130 : 143
  })
  .finally(async () => {
    clearTimeout(deadlineTimer)
    try {
      await finalizeResources()
    } catch (error) {
      proof.cleanupError = error.message
      fail(error.message)
      proof.fixtureReleased = await releaseChild(fixture, true).catch(() => false)
      proof.xvfbReleased = await releaseChild(server).catch(() => false)
    }
    proof.completedAt = now()
    proof.exitCode = process.exitCode ?? 0
    await saveProof().catch((error) => {
      console.error(error)
      process.exitCode = 1
    })
    process.removeListener('SIGTERM', onTerm)
    process.removeListener('SIGINT', onInt)
  })
