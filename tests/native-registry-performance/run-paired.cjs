#!/usr/bin/env node
// Existing prepared benchmark, with explicit hosted paths and an isolated-runner lease.
const assert = require('node:assert/strict')
const { randomInt } = require('node:crypto')
const { spawnSync } = require('node:child_process')
const { existsSync, mkdirSync, rmSync, readFileSync } = require('node:fs')
const { mkdir, mkdtemp, readFile, readdir, rm, writeFile } = require('node:fs/promises')
const { join, resolve } = require('node:path')
const { performance } = require('node:perf_hooks')
const { _electron: electron } = require('playwright')
const identity = require('./identity.cjs')
const probes = require('./probes.cjs')

const repository = resolve(
  process.env.LIFE_NATIVE_REGISTRY_REPOSITORY || resolve(__dirname, '../..'),
)
const baseline = resolve(process.env.LIFE_NATIVE_REGISTRY_BASELINE)
const providerPath = join(__dirname, 'provider.cjs')
const helperPath = join(__dirname, 'harness/active-session-recovery-steps.cjs')
const sshBundlePath = join(__dirname, 'ssh-fixture.cjs')
const { RecoveryHarness, waitUntil } = require(helperPath)
const { SSHFixture } = require(sshBundlePath)
const option = (name) => {
  const index = process.argv.indexOf(name)
  assert.ok(index >= 0 && process.argv[index + 1], 'Supply ' + name)
  return process.argv[index + 1]
}
const candidate = resolve(option('--candidate'))
const leasePath = resolve(option('--lease'))
assert.ok(
  candidate.startsWith(join(repository, 'output/immutable-app') + '/'),
  'Use the immutable private SSH candidate',
)
assert.notEqual(candidate, repository)
assert.equal(
  process.env.LIFE_ELECTRON_BINARY,
  undefined,
  'Use the fingerprinted installed Electron',
)
assert.equal(process.env.ESBUILD_BINARY_PATH, undefined, 'No substituted build binary')
function lease() {
  const value = JSON.parse(readFileSync(leasePath, 'utf8'))
  assert.ok(typeof value.rootQuietLeaseId === 'string' && value.rootQuietLeaseId)
  assert.ok(typeof value.parentGoId === 'string' && value.parentGoId)
  assert.equal(resolve(value.candidatePath), candidate)
  assert.equal(value.fixtureSha256, identity.sha256(readFileSync(__filename)))
  assert.ok(
    Date.now() >= Date.parse(value.validFrom) && Date.now() < Date.parse(value.validUntil),
    'An explicit live Root quiet lease and parent GO are required',
  )
  return value
}
lease()
const preparationPath = join(__dirname, 'preparation-manifest.json')
const preparation = JSON.parse(readFileSync(preparationPath, 'utf8'))
for (const entry of preparation.inputs)
  assert.equal(
    identity.sha256(readFileSync(entry.path)),
    entry.sha256,
    'Prepared benchmark input stays frozen: ' + entry.path,
  )
const fixturePaths = [
  preparationPath,
  __filename,
  providerPath,
  join(__dirname, 'identity.cjs'),
  join(__dirname, 'probes.cjs'),
  join(__dirname, 'plan.json'),
  helperPath,
  sshBundlePath,
  join(repository, 'tests/helpers/desktop-history.cjs'),
  join(repository, 'tests/helpers/ssh-fixture.ts'),
  join(repository, 'package-lock.json'),
]
const writeJSON = async (path, value) => writeFile(path, JSON.stringify(value, null, 2) + '\n')
const median = (values) => {
  const ordered = [...values].sort((a, b) => a - b)
  const middle = Math.floor(ordered.length / 2)
  return ordered.length % 2 ? ordered[middle] : (ordered[middle - 1] + ordered[middle]) / 2
}
function processIdentity(pid) {
  try {
    const stat = readFileSync(`/proc/${pid}/stat`, 'utf8')
    const fields = stat
      .slice(stat.lastIndexOf(')') + 2)
      .trim()
      .split(/\s+/)
    return {
      pid,
      startTicks: fields[19],
      state: fields[0],
      cmdline: readFileSync(`/proc/${pid}/cmdline`, 'utf8').replaceAll('\0', ' '),
    }
  } catch (error) {
    if (error.code === 'ENOENT' || error.code === 'ESRCH') return { pid, absent: true }
    throw error
  }
}
function stillPresent(original) {
  const now = processIdentity(original.pid)
  return !now.absent && (!original.startTicks || original.startTicks === now.startTicks)
}
class BenchmarkSSHFixture extends SSHFixture {
  constructor() {
    super(providerPath)
  }
}
class BenchmarkHarness extends RecoveryHarness {
  async launch() {
    // Any accidental Local discovery must resolve only private stand-ins, never installed providers.
    const saved = {
      PATH: process.env.PATH,
      RELAY_TEST_HOME: process.env.RELAY_TEST_HOME,
      RELAY_TEST_LOG: process.env.RELAY_TEST_LOG,
    }
    process.env.PATH = join(this.fixture.root, '.local/bin') + ':' + saved.PATH
    process.env.RELAY_TEST_HOME = this.fixture.root
    process.env.RELAY_TEST_LOG = join(this.fixture.root, 'provider-messages.jsonl')
    try {
      await super.launch()
    } finally {
      for (const [name, value] of Object.entries(saved)) {
        if (value === undefined) delete process.env[name]
        else process.env[name] = value
      }
    }
  }
}
async function nativeJournals(userData) {
  const directory = join(userData, 'native-recovery')
  if (!existsSync(directory)) return []
  const result = []
  for (const name of (await readdir(directory))
    .filter((name) => /^[a-f0-9]{64}\.jsonl$/.test(name))
    .sort()) {
    const bytes = await readFile(join(directory, name))
    assert.equal(bytes.at(-1), 10, 'Only complete committed journal batches count')
    const batches = bytes
      .toString('utf8')
      .trimEnd()
      .split('\n')
      .map((line) => JSON.parse(line))
    let previousHash = null
    for (let index = 0; index < batches.length; index++) {
      const { hash, ...body } = batches[index]
      assert.equal(body.index, index + 1)
      assert.equal(body.previousHash, previousHash)
      assert.equal(hash, identity.sha256(JSON.stringify(body)))
      previousHash = hash
    }
    result.push({
      name,
      sha256: identity.sha256(bytes),
      bytes: bytes.length,
      records: batches.flatMap((batch) => batch.records),
    })
  }
  return result
}
function protectedProof(main, journals, localSessionId, observeJournal) {
  const records = journals.flatMap((journal) => journal.records)
  const matched = []
  for (const ipc of main.ipc.filter((entry) =>
    entry.result?.nativeRecovery?.owners?.some((owner) => owner.sessionId === localSessionId),
  )) {
    const receipt = ipc.result.nativeRecovery
    const fileHash = ipc.result.nativeRecoveryHash
    const owner = receipt.owners.find((entry) => entry.sessionId === localSessionId)
    for (const [transportId, cursor] of Object.entries(owner.nativeRecovery)) {
      const prepare = records.find(
        (record) =>
          record.kind === 'history-prepare' &&
          record.prepare.snapshotId === receipt.snapshotId &&
          record.prepare.fileHash === fileHash &&
          record.prepare.owners.some(
            (entry) =>
              entry.sessionId === localSessionId &&
              entry.snapshotToken === cursor.snapshotToken &&
              entry.ownerGeneration === cursor.ownerGeneration &&
              entry.throughEventRevision === cursor.appliedRevision,
          ),
      )
      const ack = records.find(
        (record) =>
          record.kind === 'history-ack' &&
          record.ack.snapshotId === receipt.snapshotId &&
          record.ack.fileHash === fileHash &&
          record.ack.consumerId === 'main:' + localSessionId &&
          record.ack.snapshotToken === cursor.snapshotToken &&
          record.ack.ownerGeneration === cursor.ownerGeneration &&
          record.ack.throughEventRevision === cursor.appliedRevision,
      )
      assert.ok(
        prepare && ack,
        'Actual protected checkpoint has its exact preceding native preparation and private ACK',
      )
      const sync = main.journal.find(
        (entry) =>
          entry.path.endsWith(identity.sha256(transportId) + '.jsonl') &&
          entry.records.some(
            (record) =>
              record.kind === 'history-ack' &&
              JSON.stringify(record.ack) === JSON.stringify(ack.ack),
          ) &&
          entry.syncs.some((event) => event.success && event.endedAt >= entry.lastWriteAt),
      )
      if (observeJournal)
        assert.ok(sync, 'Visible ACK bytes require an observed successful exact journal sync')
      matched.push({
        phase: ipc.phase,
        apiAckMs: ipc.apiAckMs,
        savedAt: ipc.savedAt,
        snapshotId: receipt.snapshotId,
        fileHash,
        transportId,
        cursor,
        prepareRevision: prepare.revision,
        ackRevision: ack.revision,
        successfulAckSyncs: sync?.syncs.filter((event) => event.success),
        protectedWorkerAckObserved: true,
        exactNativeAckSyncObserved: Boolean(sync),
        proofScope: observeJournal
          ? 'successful exact fsync observed in candidate-only diagnostic probe'
          : 'actual worker ACK and matching visible journal claims; native ACK sync is not inferred',
      })
    }
  }
  return matched
}
async function phase(harness, name, targetCharacters, record) {
  lease()
  await harness.application.evaluate(probes.startMain, name)
  await harness.page.evaluate(probes.startRenderer, {
    phase: name,
    itemId: record.started.itemId,
    targetCharacters,
  })
  const started = performance.now()
  await harness.release(record.thread.remoteId, name)
  await harness.page.waitForFunction(
    (target) => window.__nativeRegistryPerformanceRenderer.characters >= target,
    targetCharacters,
    { timeout: 120_000, polling: 10 },
  )
  const controllerReleaseToObservedMs = performance.now() - started
  // The observed final native delta started the actual App flush synchronously,
  // before an automatic save could turn the explicit submission into a no-op.
  const renderer = await harness.page.evaluate(probes.finishRenderer)
  await harness.application.evaluate(probes.stopMain)
  return {
    ...renderer,
    controllerReleaseToObservedMs,
    responseCharactersPerSecond:
      renderer.characters / (renderer.releaseToRendererObservedMs / 1000),
    throughputUnits:
      'UTF-16 response characters per second; armed-renderer-to-output-observer includes command delivery and up to10ms fixture polling, excludes subsequent flush call',
  }
}
async function trackedProcesses(harness, launch) {
  const ids = new Set([
    launch.mainPid,
    launch.rendererPid,
    ...harness
      .log()
      .filter((entry) => entry.kind === 'provider-started')
      .map((entry) => entry.pid),
    ...[...harness.fixture.processes].map((child) => child.pid),
  ])
  const directory = join(harness.fixture.root, '.life/agent-sessions')
  const sessions = []
  if (existsSync(directory))
    for (const name of await readdir(directory)) {
      const path = join(directory, name, 'state.json')
      if (!existsSync(path)) continue
      const state = JSON.parse(await readFile(path, 'utf8'))
      sessions.push({ name, pid: state.pid, brokerPid: state.brokerPid })
      if (state.pid) ids.add(state.pid)
      if (state.brokerPid) ids.add(state.brokerPid)
    }
  return {
    identities: [...ids].filter((pid) => Number.isSafeInteger(pid) && pid > 1).map(processIdentity),
    sessions,
  }
}
async function runOne(variant, index, attempt, proof, { durabilityProbe = false } = {}) {
  lease()
  const startedAt = new Date().toISOString()
  const artifacts = join(
    attempt,
    String(index).padStart(2, '0') + '-' + variant + (durabilityProbe ? '-durability-probe' : ''),
  )
  await mkdir(artifacts)
  const harness = new BenchmarkHarness({
    repository,
    appPath: variant === 'baseline' ? baseline : candidate,
    artifacts,
    electron,
    SSHFixture: BenchmarkSSHFixture,
    proof,
  })
  let launch, tracked, output
  try {
    await harness.setup('native-registry-performance-' + index + '-' + variant)
    launch = await harness.application.evaluate(({ app, BrowserWindow }) => ({
      appPath: app.getAppPath(),
      mainPid: process.pid,
      rendererPid: BrowserWindow.getAllWindows()[0].webContents.getOSProcessId(),
      userData: app.getPath('userData'),
      display: process.env.DISPLAY,
      packaged: app.isPackaged,
      rendererSandboxed:
        BrowserWindow.getAllWindows()[0].webContents.getLastWebPreferences().sandbox,
    }))
    assert.equal(launch.appPath, harness.appPath)
    assert.ok(launch.userData.startsWith(harness.configurationRoot + '/'))
    assert.equal(launch.packaged, false)
    assert.equal(launch.rendererSandboxed, true)
    const capabilities = await harness.page.evaluate(() => ({
      nativeRecovery: typeof window.relay.agent.recover === 'function',
      messageFields: window.relay.conversations.supportsMessageFields === true,
      messageAppends: window.relay.conversations.supportsMessageAppends === true,
    }))
    assert.equal(capabilities.nativeRecovery, variant === 'candidate')
    assert.equal(capabilities.messageFields, true)
    assert.equal(capabilities.messageAppends, true)
    await harness.application.evaluate(probes.installMain, { observeJournal: durabilityProbe })
    await harness.page.evaluate(probes.installRenderer)
    const prompt =
      'LIFE_NATIVE_REGISTRY_PERFORMANCE:  One exact prompt\n\tQuotes " $value café e\u0301 漢字 🧪  \n'
    const record = await harness.send('codex', prompt)
    await harness.flush()
    await harness.page.waitForTimeout(200)
    // Startup, prompt admission and identity binding are deliberately outside measured phases.
    const phases = []
    phases.push(await phase(harness, 'base', 8 * 1024 * 1024, record))
    phases.push(await phase(harness, 'tail-0', 8 * 1024 * 1024 + 2048, record))
    const main = await harness.application.evaluate(probes.readMain)
    for (const measured of phases) {
      const exact = main.ipc.filter((entry) => entry.phase === measured.phase).at(-1)
      assert.ok(
        exact && !exact.error && Number.isFinite(exact.apiAckMs),
        'The measured explicit App flush reached an actual native history ACK',
      )
      measured.nativeHistoryApiAckMs = exact.apiAckMs
      measured.nativeHistoryPacketBytes = exact.inputBytes
      measured.mainTimerMaxLagMs = main.timers[measured.phase].maxLagMs
    }
    assert.ok(
      main.ipc.some((entry) => entry.phase === 'tail-0' && !entry.error),
      'Measure an actual owned App history write',
    )
    await harness.release(record.thread.remoteId, 'finish')
    await waitUntil(
      () => harness.log().some((entry) => entry.kind === 'turn-completed'),
      'small actual native semantic completion',
    )
    await waitUntil(
      async () => {
        await harness.flush()
        const current = await harness.thread(prompt)
        return current && !current.busy
      },
      'the App settles its existing streamed item without a full native replacement',
      60_000,
    )
    await harness.flush()
    const diskBytes = await readFile(join(launch.userData, 'conversations.json'))
    const disk = JSON.parse(diskBytes)
    const current = disk.threads.find((entry) => entry.id === record.thread.id)
    assert.equal(current.remoteId, record.thread.remoteId)
    assert.equal(current.profileId, record.thread.profileId)
    assert.equal(current.workspace, record.thread.workspace)
    assert.equal(
      current.messages.filter((message) => message.role === 'user' && message.text === prompt)
        .length,
      1,
    )
    const replies = current.messages.filter(
      (message) => message.role === 'assistant' && message.id.includes(record.started.itemId),
    )
    assert.equal(replies.length, 1)
    const prefix = '  Native registry response\r\n\tExact café e\u0301 漢字 🧪\r\n'
    const tailPrefix = '  native-tail-0\r\n\tExact café e\u0301 漢字 🧪  \r\n'
    const expected =
      prefix +
      'x'.repeat(8 * 1024 * 1024 - prefix.length) +
      tailPrefix +
      'z'.repeat(2048 - tailPrefix.length)
    assert.equal(replies[0].text, expected)
    assert.equal(current.busy, false)
    const logs = harness.log()
    assert.equal(
      logs.filter((entry) => entry.kind === 'turn-started' && entry.prompt === prompt).length,
      1,
    )
    assert.ok(logs.every((entry) => entry.inference !== true))
    assert.equal(
      logs.filter((entry) => entry.kind === 'fixture-error' || entry.kind === 'unsupported-input')
        .length,
      0,
    )
    const journals = await nativeJournals(launch.userData)
    const protectedHistory = protectedProof(main, journals, current.id, durabilityProbe)
    const rawEntries = main.journal.filter(
      (entry) => entry.phase === 'base' && entry.rawStdoutBytes > 0,
    )
    const successfulRawSyncs = rawEntries.flatMap((entry) =>
      entry.syncs.filter((sync) => sync.success),
    )
    const rawWireWal = durabilityProbe
      ? {
          scope: 'candidate-only diagnostic; excluded from paired timings',
          rawStdoutBytes: rawEntries.reduce((n, entry) => n + entry.rawStdoutBytes, 0),
          committedJournalBytes: rawEntries.reduce((n, entry) => n + entry.bytes, 0),
          batchCount: rawEntries.reduce((n, entry) => n + entry.batchHashes.length, 0),
          successfulSyncCount: successfulRawSyncs.length,
          syncDurationsMs: successfulRawSyncs.map((sync) => sync.endedAt - sync.startedAt),
          writeToLastSuccessfulSyncMs:
            rawEntries.length && successfulRawSyncs.length
              ? Math.max(...successfulRawSyncs.map((sync) => sync.endedAt)) -
                Math.min(...rawEntries.map((entry) => entry.firstWriteAt))
              : undefined,
        }
      : undefined
    let finalProtectedFile
    if (variant === 'candidate') {
      assert.ok(protectedHistory.some((entry) => entry.phase === 'base'))
      assert.ok(protectedHistory.some((entry) => entry.phase === 'tail-0'))
      if (durabilityProbe)
        assert.ok(
          main.journal.some(
            (entry) =>
              entry.phase === 'base' &&
              entry.rawStdoutBytes > 0 &&
              entry.syncs.some((sync) => sync.success),
          ),
        )
      const bytes = await readFile(join(launch.userData, 'conversations.recovery-receipts.json'))
      const receipts = JSON.parse(bytes).receipts
      const receipt = receipts.find(
        (entry) => entry.hash === identity.sha256(diskBytes) && entry.savedAt === disk.savedAt,
      )
      assert.ok(
        receipt?.receipt.owners.some(
          (owner) =>
            owner.sessionId === current.id &&
            owner.remoteId === current.remoteId &&
            owner.profileId === current.profileId &&
            owner.workspace === current.workspace,
        ),
        'Protected final file proof matches actual owned final history bytes',
      )
      finalProtectedFile = {
        sidecarSha256: identity.sha256(bytes),
        historyHash: receipt.hash,
        savedAt: receipt.savedAt,
        snapshotId: receipt.receipt.snapshotId,
        ownedSession: current.id,
      }
    } else {
      assert.equal(journals.length, 0)
      assert.equal(protectedHistory.length, 0)
    }
    tracked = await trackedProcesses(harness, launch)
    await writeJSON(join(artifacts, 'private-processes-before-cleanup.json'), tracked)
    output = {
      variant,
      index,
      startedAt,
      finishedBeforeCleanupAt: new Date().toISOString(),
      launch,
      privateFixture: {
        host: '127.0.0.1',
        port: harness.fixture.port,
        root: harness.fixture.root,
        workspace: harness.fixture.workspace,
        configurationRoot: harness.configurationRoot,
      },
      capabilities,
      durabilityProbe,
      timingUse: durabilityProbe
        ? 'diagnostic only; excluded from paired comparison'
        : 'paired timing with no filesystem or WAL-buffer hooks',
      promptSha256: identity.sha256(prompt),
      responseCharacters: expected.length,
      responseSha256: identity.sha256(expected),
      historyBytes: diskBytes.length,
      historySha256: identity.sha256(diskBytes),
      phases,
      main,
      protectedHistory,
      rawWireWal,
      finalProtectedFile,
      providerOutput: logs.filter((entry) => entry.kind === 'output-written'),
      journalFiles: journals.map(({ records, ...entry }) => entry),
      nativePromptSubmissions: 1,
      exactPromptAndOwnershipPreserved: true,
      completion:
        'actual turn/completed with itemsView:notLoaded; existing streamed assistant preserved',
    }
    await writeJSON(join(artifacts, 'sample.json'), output)
    assert.equal(
      proof.rendererErrors.filter((entry) => entry.scenario === harness.name).length,
      0,
      'A renderer error stops the current attempt before more paired runs',
    )
    return output
  } catch (error) {
    if (harness.application && harness.page) {
      await harness.page.screenshot({ path: join(artifacts, 'failure.png') }).catch(() => {})
      if (!tracked && launch)
        tracked = await trackedProcesses(harness, launch).catch(() => undefined)
    }
    await writeJSON(join(artifacts, 'failure.json'), {
      error: String(error),
      stack: error.stack,
      launch,
      tracked,
      nativeLogs: harness.nativeLogs,
    })
    throw error
  } finally {
    const ownedProfile = harness.configurationRoot
    const ownedRemote = harness.fixture?.root
    await harness.close()
    if (tracked) {
      await waitUntil(
        () => tracked.identities.every((entry) => !stillPresent(entry)),
        'all exact private benchmark processes leave /proc, including zombies',
        20_000,
      )
      await writeJSON(join(artifacts, 'cleanup.json'), {
        tracked: tracked.identities,
        after: tracked.identities.map((entry) => ({
          original: entry,
          now: processIdentity(entry.pid),
          originalAbsent: !stillPresent(entry),
        })),
        privateRemoteRemoved: ownedRemote ? !existsSync(ownedRemote) : undefined,
        noSharedProcessSignals: true,
      })
    }
    if (ownedProfile) {
      assert.ok(ownedProfile.startsWith('/tmp/life-active-recovery-profile-'))
      await rm(ownedProfile, { recursive: true, force: true })
    }
  }
}
async function main() {
  const attempt =
    process.env.LIFE_NATIVE_REGISTRY_ATTEMPT || (await mkdtemp(join(__dirname, 'attempt-')))
  if (process.platform === 'linux' && process.env.LIFE_NATIVE_REGISTRY_PRIVATE_XVFB !== '1') {
    let display, reservation
    for (let count = 0; count < 40 && !reservation; count++) {
      display = randomInt(500, 4500)
      const path = `/tmp/life-native-registry-performance-display-${display}.lock`
      if (existsSync(`/tmp/.X${display}-lock`) || existsSync(`/tmp/.X11-unix/X${display}`)) continue
      try {
        mkdirSync(path, { mode: 0o700 })
        reservation = path
      } catch (error) {
        if (error.code !== 'EEXIST') throw error
      }
    }
    assert.ok(reservation)
    const environment = {
      ...process.env,
      LIFE_NATIVE_REGISTRY_PRIVATE_XVFB: '1',
      LIFE_NATIVE_REGISTRY_ATTEMPT: attempt,
    }
    delete environment.DISPLAY
    delete environment.XAUTHORITY
    delete environment.ELECTRON_RENDERER_URL
    let child
    try {
      child = spawnSync(
        'xvfb-run',
        [
          `--server-num=${display}`,
          `--error-file=${join(attempt, 'xvfb.log')}`,
          '-s',
          '-screen 0 1440x960x24 -noreset -extension MIT-SHM',
          process.execPath,
          __filename,
          ...process.argv.slice(2),
        ],
        { cwd: repository, env: environment, stdio: 'inherit' },
      )
    } finally {
      rmSync(reservation, { recursive: true, force: true })
    }
    await writeJSON(join(attempt, 'display-cleanup.json'), {
      display,
      exitStatus: child?.status,
      privateDisplaySocketAbsent: !existsSync(`/tmp/.X11-unix/X${display}`),
      privateDisplayLockAbsent: !existsSync(`/tmp/.X${display}-lock`),
    })
    assert.equal(child?.status, 0)
    return
  }
  const before = {
    capturedAt: new Date().toISOString(),
    lease: lease(),
    apps: {
      baseline: await identity.application(baseline),
      candidate: await identity.application(candidate),
    },
    runtime: await identity.runtime(repository, [baseline, candidate]),
    fixtures: await identity.files(fixturePaths),
    preparationManifestSha256: identity.sha256(await readFile(preparationPath)),
  }
  await writeJSON(join(attempt, 'inputs-before.json'), before)
  const sequence = Array.from({ length: 4 }, () => [
    'baseline',
    'candidate',
    'candidate',
    'baseline',
  ]).flat()
  const proof = {
    rendererErrors: [],
    samples: [],
    startedAt: new Date().toISOString(),
    sequence,
    quietLeaseId: before.lease.rootQuietLeaseId,
    parentGoId: before.lease.parentGoId,
  }
  try {
    for (let index = 0; index < sequence.length; index++) {
      proof.samples.push(await runOne(sequence[index], index, attempt, proof))
      await writeJSON(join(attempt, 'progress.json'), proof)
      console.log(
        JSON.stringify({
          privateBenchmarkSample: index + 1,
          total: sequence.length,
          variant: sequence[index],
          attempt,
        }),
      )
    }
    assert.equal(proof.rendererErrors.length, 0)
    proof.candidateDurabilityProbe = await runOne('candidate', 16, attempt, proof, {
      durabilityProbe: true,
    })
    assert.equal(proof.rendererErrors.length, 0)
  } finally {
    const after = {
      capturedAt: new Date().toISOString(),
      apps: {
        baseline: await identity.application(baseline),
        candidate: await identity.application(candidate),
      },
      runtime: await identity.runtime(repository, [baseline, candidate]),
      fixtures: await identity.files(fixturePaths),
    }
    await writeJSON(join(attempt, 'inputs-after.json'), after)
    assert.deepEqual(
      after.apps,
      before.apps,
      'Exact immutable application bytes and modes stay fixed',
    )
    assert.deepEqual(
      after.runtime,
      before.runtime,
      'Current installed dependency and executable bytes stay fixed across both runs',
    )
    assert.deepEqual(
      after.fixtures,
      before.fixtures,
      'One exact benchmark adapter and helper graph runs both versions',
    )
  }
  const pairs = Array.from({ length: 8 }, (_, index) =>
    proof.samples.slice(index * 2, index * 2 + 2),
  )
  const matched = {}
  for (const name of ['base', 'tail-0'])
    for (const field of [
      'rendererSubmissionMs',
      'rendererFlushAckMs',
      'maxLagMs',
      'controllerReleaseToObservedMs',
      'releaseToRendererObservedMs',
      'nativeHistoryApiAckMs',
      'nativeHistoryPacketBytes',
      'mainTimerMaxLagMs',
    ]) {
      const value = (sample) => sample.phases.find((phase) => phase.phase === name)[field]
      const baselineValues = proof.samples
        .filter((sample) => sample.variant === 'baseline')
        .map(value)
      const candidateValues = proof.samples
        .filter((sample) => sample.variant === 'candidate')
        .map(value)
      matched[name + ':' + field] = {
        baselineMedian: median(baselineValues),
        candidateMedian: median(candidateValues),
        pairedCandidateMinusBaseline: pairs.map(
          (pair) =>
            value(pair.find((sample) => sample.variant === 'candidate')) -
            value(pair.find((sample) => sample.variant === 'baseline')),
        ),
      }
      matched[name + ':' + field].pairedMedian = median(
        matched[name + ':' + field].pairedCandidateMinusBaseline,
      )
    }
  proof.finishedAt = new Date().toISOString()
  proof.matchedPairs = 8
  proof.matched = matched
  proof.success = true
  proof.limitations = [
    'Private strict native protocol stand-ins; no authentication or upstream inference.',
    '8Mi UTF-16 body is eight1Mi deltas; exact2Ki suffix uses the same root, turn and item. Completion omits a final full item snapshot.',
    'Release-to-renderer measurements include up to10ms private provider polling. Optional hashes, snapshot/proof JSON encoding, file inspections and identity/correctness checks occur outside timing. Native protocol JSON encoding/emission, small release logs and the identical SSH harness broker-frame observer remain in end-to-end delivery timing.',
    'Renderer flush acknowledgement and IPC API acknowledgement are different intervals. Paired timings install no filesystem or WAL-buffer hooks. Native protected ACK sync is verified by a separate candidate-only diagnostic probe.',
    'The old app has no native registry or protected history capability. Candidate-only WAL and protected ACK metrics have no invented old-WAL ratio.',
    'Current installed dependency bytes are frozen across these new runs; the historical baseline publication had no installed-byte manifest.',
    'Paired probes retain only actual history IPC inputs/results and small timer observations. The separate durability probe retains journal buffer references; its timings are excluded from comparison. No hardware-independent latency threshold is claimed.',
  ]
  await writeJSON(join(attempt, 'paired-proof.json'), proof)
  console.log(JSON.stringify({ privateBenchmarkComplete: true, matchedPairs: 8, attempt }))
}
main().catch(async (error) => {
  console.error(error.stack || String(error))
  process.exitCode = 1
})
