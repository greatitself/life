// Additive Local observations only. No native mutation, recovery request, or synthesized event.
const assert = require('node:assert/strict')
const { createHash } = require('node:crypto')
const { lstat, mkdir, readFile, readdir, realpath, writeFile } = require('node:fs/promises')
const { isAbsolute, join, relative, resolve } = require('node:path')

const hash = (bytes) => createHash('sha256').update(bytes).digest('hex')
const clone = (value) => JSON.parse(JSON.stringify(value))
const kinds = new Set([
  'create',
  'transport',
  'input',
  'input-ack',
  'input-cancel',
  'output',
  'event',
  'checkpoint',
  'history-prepare',
  'history-ack',
])
const descriptorFields = [
  'id',
  'brokerId',
  'brokerRoot',
  'launchCommand',
  'provider',
  'providerVersion',
  'nativeProtocol',
  'brokerProtocolVersion',
  'machine',
]

class LocalProofPending extends Error {}

function inside(root, path) {
  assert.ok(isAbsolute(root) && isAbsolute(path))
  const child = relative(resolve(root), resolve(path))
  assert.ok(
    child && child !== '..' && !child.startsWith('../') && !isAbsolute(child),
    'Read only a descendant of the explicit private root',
  )
  return path
}

function decodeNativeWal(raw, expectedFilename) {
  const text = Buffer.isBuffer(raw) ? raw.toString('utf8') : raw
  assert.equal(typeof text, 'string')
  if (!text.length || !text.endsWith('\n'))
    throw new LocalProofPending('The read intersects an unfinished native WAL append')
  let transport,
    initialTransport,
    previousHash = null,
    index = 0,
    revision = 0
  const ownersHistory = [],
    outputs = []
  for (const line of text.slice(0, -1).split('\n')) {
    const batch = JSON.parse(line)
    assert.equal(batch.format, 'life-native-recovery')
    assert.equal(batch.version, 1)
    assert.equal(batch.index, ++index)
    assert.equal(batch.previousHash, previousHash)
    assert.match(batch.hash, /^[a-f0-9]{64}$/u)
    const { hash: checksum, ...payload } = batch
    assert.equal(hash(JSON.stringify(payload)), checksum)
    assert.ok(Array.isArray(batch.records) && batch.records.length)
    for (const record of batch.records) {
      assert.equal(record.revision, ++revision)
      assert.ok(
        kinds.has(record.kind),
        'Observe only the current committed native journal contract',
      )
      if (record.kind === 'create') {
        assert.equal(transport, undefined)
        initialTransport = clone(record.transport)
        transport = clone(record.transport)
      } else {
        assert.ok(transport, 'The original creation descriptor precedes every observation')
        if (record.kind === 'transport') {
          assert.ok(record.patch && typeof record.patch === 'object')
          for (const key of Object.keys(record.patch))
            assert.ok(['inputReceipts', 'controller', 'initialization', 'owners'].includes(key))
          transport = { ...transport, ...clone(record.patch) }
        }
      }
      if (record.kind === 'create' || record.kind === 'transport') {
        assert.ok(Array.isArray(transport.owners))
        if (record.kind === 'create' || Object.hasOwn(record.patch, 'owners'))
          ownersHistory.push(
            ...transport.owners.map((owner) => ({ revision, owner: clone(owner) })),
          )
      }
      if (record.kind === 'output') outputs.push(clone(record.frame))
    }
    previousHash = checksum
  }
  assert.ok(transport && typeof transport.id === 'string' && transport.id.length)
  assert.ok(
    transport.controller &&
      typeof transport.controller.id === 'string' &&
      transport.controller.id.length,
  )
  assert.ok(Number.isSafeInteger(transport.controller.epoch) && transport.controller.epoch >= 0)
  if (expectedFilename !== undefined) assert.equal(expectedFilename, hash(transport.id) + '.jsonl')
  for (const field of descriptorFields) assert.deepEqual(transport[field], initialTransport[field])
  return {
    transport,
    initialTransport,
    ownersHistory,
    outputs,
    batches: index,
    revision,
    lastHash: previousHash,
    sha256: hash(raw),
  }
}

function processIdentityFromStat(pid, raw) {
  assert.ok(Number.isSafeInteger(pid) && pid > 1)
  if (raw === null) return { pid, present: false, alive: false }
  assert.equal(typeof raw, 'string')
  const end = raw.lastIndexOf(')')
  assert.ok(end > 0 && raw.startsWith(String(pid) + ' ('))
  const fields = raw
    .slice(end + 1)
    .trim()
    .split(/\s+/u)
  assert.ok(fields.length >= 20)
  assert.match(fields[19], /^\d+$/u)
  return {
    pid,
    present: true,
    state: fields[0],
    startTicks: fields[19],
    alive: !['Z', 'X', 'x'].includes(fields[0]),
    statSha256: hash(raw),
  }
}

function validateBrokerMapping(mapping, bootstrap, transport) {
  assert.match(mapping.id, /^[a-zA-Z0-9_-]{1,80}$/u)
  assert.equal(mapping.id, transport.brokerId)
  assert.equal(mapping.originalRoot, transport.brokerRoot)
  assert.equal(mapping.root, join(bootstrap.root, '.life', 'agent-sessions', mapping.id))
  inside(bootstrap.root, mapping.root)
  assert.notEqual(
    mapping.originalRoot,
    mapping.root,
    'Logical descriptor and fixture physical mapping are distinct',
  )
  assert.equal(mapping.commandSha256, hash(transport.launchCommand))
  assert.equal(mapping.runtimeUnchanged, true)
  return { ...mapping }
}

function ownerIdentity(owner) {
  return Object.fromEntries(
    [
      'ownerId',
      'sessionId',
      'kind',
      'workspace',
      'nativeThreadId',
      'nativeSessionId',
      'nativeTurnId',
    ]
      .filter((key) => owner[key] !== undefined)
      .map((key) => [key, owner[key]]),
  )
}

function assertContinuity(before, after, { requireAttachment = false, requireAlive = true } = {}) {
  assert.ok(Array.isArray(before.targetIds) && before.targetIds.length)
  for (const id of before.targetIds) {
    const prior = before.native.find((item) => item.transport.id === id)
    const current = after.native.find((item) => item.transport.id === id)
    assert.ok(prior && current, 'The original native transport remains in the same private WAL')
    for (const field of descriptorFields)
      assert.deepEqual(current.transport[field], prior.transport[field])
    assert.deepEqual(current.mapping, prior.mapping)
    assert.equal(current.broker.session.sha256, prior.broker.session.sha256)
    assert.equal(
      current.wal.originalPrefixSha256,
      prior.wal.sha256,
      'The retained native WAL extends the exact original bytes',
    )
    assert.equal(
      current.broker.journal.originalPrefixSha256,
      prior.broker.journal.sha256,
      'The same physical broker journal extends the original bytes',
    )
    for (const file of [
      [current.wal, prior.wal],
      [current.broker.session, prior.broker.session],
      [current.broker.journal, prior.broker.journal],
    ]) {
      assert.equal(file[0].device, file[1].device)
      assert.equal(
        file[0].inode,
        file[1].inode,
        'Retain the same original private journal/file identity',
      )
    }
    for (const role of ['providerProcess', 'brokerProcess']) {
      assert.equal(current.broker[role].pid, prior.broker[role].pid)
      if (current.broker[role].present)
        assert.equal(current.broker[role].startTicks, prior.broker[role].startTicks)
      if (requireAlive)
        assert.equal(current.broker[role].alive, true, 'The same original native process survives')
    }
    if (
      !requireAlive &&
      (!current.broker.providerProcess.alive || !current.broker.brokerProcess.alive)
    ) {
      assert.equal(current.broker.providerProcess.alive, false)
      assert.equal(current.broker.state.exited, true)
      assert.ok(current.broker.terminal && current.broker.terminal.nativeExitConfirmed !== false)
      assert.equal(current.broker.state.cursor, current.broker.terminal.cursor)
    }
    for (const owner of prior.boundOwners) {
      const rows = current.ownersHistory.filter((row) => row.owner.ownerId === owner.ownerId)
      assert.ok(rows.length, 'The same native owner remains in retained journal history')
      for (const [key, value] of Object.entries(owner))
        assert.ok(
          rows.some((row) => row.owner[key] === value),
          'The original native owner binding remains recorded',
        )
    }
    if (requireAttachment) {
      assert.ok(current.transport.controller.epoch >= prior.transport.controller.epoch)
      if (
        current.mappingCount <= prior.mappingCount ||
        current.transport.controller.id === prior.transport.controller.id ||
        current.transport.controller.epoch === prior.transport.controller.epoch
      )
        throw new LocalProofPending(
          'Wait for the actual reopened controller and broker writer lease',
        )
      for (const owner of prior.boundOwners) {
        const selected = current.transport.owners.find((value) => value.ownerId === owner.ownerId)
        assert.ok(selected)
        for (const [key, value] of Object.entries(owner)) assert.equal(selected[key], value)
      }
    }
  }
  return true
}

async function privateRead(root, path) {
  inside(root, path)
  inside(await realpath(root), await realpath(path))
  const metadata = await lstat(path, { bigint: true })
  assert.ok(metadata.isFile() && !metadata.isSymbolicLink())
  const bytes = await readFile(path)
  return {
    bytes,
    metadata: {
      path,
      bytes: bytes.length,
      sha256: hash(bytes),
      device: String(metadata.dev),
      inode: String(metadata.ino),
      mode: Number(metadata.mode & 0o777n),
    },
  }
}

async function retain(directory, name, observation) {
  const path = join(directory, name)
  await writeFile(path, observation.bytes, { mode: 0o600, flag: 'wx' })
  return { ...observation.metadata, retainedPath: path }
}

async function readProcess(pid, directory, label) {
  assert.ok(Number.isSafeInteger(pid) && pid > 1)
  let raw
  try {
    raw = await readFile(`/proc/${pid}/stat`, 'utf8')
  } catch (error) {
    if (error.code !== 'ENOENT' && error.code !== 'ESRCH') throw error
    raw = null
  }
  const identity = processIdentityFromStat(pid, raw)
  if (raw !== null) {
    const path = join(directory, `${label}-proc-${pid}.stat`)
    await writeFile(path, raw, { mode: 0o600, flag: 'wx' })
    identity.retainedStat = path
  }
  return identity
}

function decodeBrokerJournal(bytes) {
  const text = bytes.toString('utf8')
  if (text && !text.endsWith('\n'))
    throw new LocalProofPending('The read intersects an unfinished physical broker journal append')
  const frames = text
    ? text
        .slice(0, -1)
        .split('\n')
        .map((line) => JSON.parse(line))
    : []
  let cursor = 0,
    terminal
  for (const frame of frames) {
    assert.equal(terminal, undefined, 'Native terminal output is final')
    assert.ok(['stdout', 'stderr', 'inputReceipt', 'exit'].includes(frame.type))
    assert.equal(frame.cursor, ++cursor)
    if (frame.type === 'exit') terminal = frame
  }
  return { cursor, terminal }
}

async function connectionState(harness) {
  const bootstrap = harness.activeRecoveryBootstrap
  const state = await harness.page.evaluate(() => window.relay.connection.state())
  assert.equal(state.profile?.transport, 'local')
  assert.equal(state.profile?.id, bootstrap.localProfileId)
  if (state.status !== 'connected')
    throw new LocalProofPending('Wait for the actual default Local connection')
  assert.equal(state.workspace, bootstrap.workspace)
  return state
}

async function capture(harness, phase, state, expectedPids, attempt = 1) {
  const bootstrap = harness.activeRecoveryBootstrap
  assert.equal(bootstrap.mode, 'local')
  assert.match(harness.name, /^[a-z0-9_-]+$/u)
  const directory = join(
    resolve(harness.artifacts),
    'local-recovery-proof',
    harness.name,
    `${phase}-${attempt}`,
  )
  await mkdir(directory, { recursive: true, mode: 0o700 })
  const launch = harness.launches.at(-1)
  inside(harness.configurationRoot, launch.userData)
  const command = await privateRead(bootstrap.root, bootstrap.commandLog)
  const commandLog = await retain(directory, 'commands.jsonl', command)
  const commandText = command.bytes.toString('utf8')
  assert.ok(!commandText || commandText.endsWith('\n'))
  const commandRows = commandText
    .split('\n')
    .filter(Boolean)
    .map((line) => JSON.parse(line))
  assert.equal(commandRows.filter((row) => row.kind.startsWith('unexpected-')).length, 0)
  const native = []
  const nativeDirectory = join(launch.userData, 'native-recovery')
  for (const filename of (await readdir(nativeDirectory))
    .filter((name) => /^[a-f0-9]{64}\.jsonl$/u.test(name))
    .sort()) {
    const walRead = await privateRead(harness.configurationRoot, join(nativeDirectory, filename))
    const wal = await retain(directory, `native-${filename}`, walRead)
    const decoded = decodeNativeWal(walRead.bytes, filename)
    const transport = decoded.transport
    assert.equal(transport.machine.transport, 'local')
    assert.equal(transport.machine.profileId, bootstrap.localProfileId)
    const maps = commandRows.filter(
      (row) => row.kind === 'local-command-admitted' && row.broker?.id === transport.brokerId,
    )
    assert.ok(maps.length, 'Every native Local descriptor has an actual private broker mapping')
    const mapping = validateBrokerMapping(maps[0].broker, bootstrap, transport)
    for (const row of maps)
      assert.deepEqual(validateBrokerMapping(row.broker, bootstrap, transport), mapping)
    const brokerRoot = mapping.root
    const session = await privateRead(bootstrap.root, join(brokerRoot, 'session.json'))
    const retainedSession = await retain(directory, `${transport.brokerId}-session.json`, session)
    const persisted = JSON.parse(session.bytes.toString('utf8'))
    assert.equal(persisted.id, transport.brokerId)
    assert.equal(persisted.command, transport.launchCommand)
    const stateRead = await privateRead(bootstrap.root, join(brokerRoot, 'state.json'))
    const retainedState = await retain(directory, `${transport.brokerId}-state.json`, stateRead)
    const brokerState = JSON.parse(stateRead.bytes.toString('utf8'))
    assert.equal(brokerState.id, transport.brokerId)
    assert.equal(brokerState.protocol, transport.brokerProtocolVersion)
    const journal = await privateRead(bootstrap.root, join(brokerRoot, 'journal.jsonl'))
    const retainedJournal = await retain(directory, `${transport.brokerId}-journal.jsonl`, journal)
    const original = state.before?.native.find((item) => item.transport.id === transport.id)
    if (original) {
      assert.ok(walRead.bytes.length >= original.wal.bytes)
      assert.ok(journal.bytes.length >= original.broker.journal.bytes)
      wal.originalPrefixSha256 = hash(walRead.bytes.subarray(0, original.wal.bytes))
      retainedJournal.originalPrefixSha256 = hash(
        journal.bytes.subarray(0, original.broker.journal.bytes),
      )
    }
    const decodedJournal = decodeBrokerJournal(journal.bytes)
    const item = {
      ...decoded,
      wal,
      mapping,
      mappingCount: maps.length,
      boundOwners: transport.owners
        .filter((owner) => owner.nativeThreadId || owner.nativeSessionId)
        .map(ownerIdentity),
      broker: {
        state: brokerState,
        session: retainedSession,
        stateFile: retainedState,
        journal: retainedJournal,
        terminal: decodedJournal.terminal,
        providerProcess: await readProcess(
          brokerState.pid,
          directory,
          `${transport.brokerId}-provider`,
        ),
        brokerProcess: await readProcess(
          brokerState.brokerPid,
          directory,
          `${transport.brokerId}-broker`,
        ),
      },
    }
    native.push(item)
  }
  const targetIds =
    state.targetIds ||
    native
      .filter((item) => expectedPids.includes(item.broker.state.pid))
      .map((item) => item.transport.id)
  assert.ok(targetIds.length)
  const observation = {
    phase,
    at: Date.now(),
    directory,
    connection: harness.page ? await connectionState(harness) : null,
    hostProcess: await readProcess(launch.pid, directory, 'host'),
    commandLog,
    native,
    targetIds,
  }
  if (!state.targetIds) {
    assert.equal(targetIds.length, expectedPids.length)
    for (const id of targetIds) {
      const target = native.find((item) => item.transport.id === id)
      assert.ok(target.boundOwners.length, 'The original active transport owns bound native IDs')
      assert.equal(target.broker.providerProcess.alive, true)
      assert.equal(target.broker.brokerProcess.alive, true)
    }
  }
  await writeFile(join(directory, 'observation.json'), JSON.stringify(observation, null, 2), {
    mode: 0o600,
    flag: 'wx',
  })
  return observation
}

async function captureReopen(harness, state) {
  // The real renderer owns recovery. Observe its completed lease acquisition;
  // never trigger another recover call or substitute a projected controller.
  const deadline = Date.now() + 20000
  let attempt = 0,
    lastError
  while (Date.now() < deadline) {
    attempt++
    try {
      const current = await capture(harness, 'after-reopen', state, [], attempt)
      assertContinuity(state.before, current, { requireAttachment: true })
      assert.notEqual(current.hostProcess.pid, state.before.hostProcess.pid)
      return current
    } catch (error) {
      if (!(error instanceof LocalProofPending)) throw error
      lastError = error
      const directory = join(
        resolve(harness.artifacts),
        'local-recovery-proof',
        harness.name,
        `after-reopen-${attempt}`,
      )
      await mkdir(directory, { recursive: true, mode: 0o700 })
      await writeFile(
        join(directory, 'observation-pending.json'),
        JSON.stringify({ at: Date.now(), attempt, message: String(error) }, null, 2),
        { mode: 0o600, flag: 'wx' },
      )
      await new Promise((done) => setTimeout(done, 40))
    }
  }
  throw lastError || new Error('The actual Local recovery did not publish a new writer lease')
}

function install({ RecoveryHarness, mode }) {
  assert.equal(mode, 'local')
  assert.equal(
    process.platform,
    'linux',
    'Native process identity proof uses explicit Linux /proc/PID/stat',
  )
  const states = new WeakMap()
  const originalLaunch = RecoveryHarness.prototype.launch
  const originalShutdown = RecoveryHarness.prototype.shutdown
  const originalSaveEvidence = RecoveryHarness.prototype.saveEvidence
  const stateFor = (harness) => {
    let state = states.get(harness)
    if (!state) {
      state = { phases: [], launchCount: 0 }
      states.set(harness, state)
    }
    return state
  }
  RecoveryHarness.prototype.launch = async function (...args) {
    const result = await Reflect.apply(originalLaunch, this, args)
    const state = stateFor(this)
    state.launchCount++
    if (state.launchCount === 2) {
      assert.ok(state.before && state.afterCrash)
      const current = await captureReopen(this, state)
      state.afterReopen = current
      state.phases.push(current)
    } else assert.equal(state.launchCount, 1)
    return result
  }
  RecoveryHarness.prototype.shutdown = async function (shutdownMode, expectedPids, options) {
    assert.equal(shutdownMode, 'crash')
    const state = stateFor(this)
    assert.equal(state.before, undefined)
    const before = await capture(this, 'before-crash', state, expectedPids)
    state.before = before
    state.targetIds = before.targetIds
    state.phases.push(before)
    const result = await Reflect.apply(originalShutdown, this, [
      shutdownMode,
      expectedPids,
      options,
    ])
    const after = await capture(this, 'after-crash', state, [])
    assert.equal(after.hostProcess.alive, false, 'The original cold host has really exited')
    assertContinuity(before, after)
    state.afterCrash = after
    state.phases.push(after)
    return result
  }
  RecoveryHarness.prototype.saveEvidence = async function (name, evidence) {
    const state = stateFor(this)
    assert.ok(state.before && state.afterCrash && state.afterReopen)
    const final = await capture(this, 'final', state, [])
    assertContinuity(state.before, final, { requireAlive: false })
    state.phases.push(final)
    const proof = {
      version: 1,
      transport: 'local',
      artificialRecoverCalls: 0,
      syntheticAgentEvents: 0,
      productionMutations: 0,
      scope:
        'Logical descriptors map to private physical broker storage; original IDs, PIDs and start ticks are observed independently.',
      assertions: {
        genuineLocalMachine: true,
        sameLogicalDescriptor: true,
        samePhysicalMapping: true,
        sameNativeProcessIdentity: true,
        coldHostExited: true,
        realReattachment: true,
      },
      phases: state.phases,
      retainedArtifacts: state.phases.flatMap((phase) => [
        phase.commandLog,
        ...phase.native.flatMap((item) => [
          item.wal,
          item.broker.session,
          item.broker.stateFile,
          item.broker.journal,
        ]),
      ]),
    }
    return Reflect.apply(originalSaveEvidence, this, [
      name,
      { ...evidence, localRecoveryProof: proof },
    ])
  }
  return {
    states,
    restore() {
      RecoveryHarness.prototype.launch = originalLaunch
      RecoveryHarness.prototype.shutdown = originalShutdown
      RecoveryHarness.prototype.saveEvidence = originalSaveEvidence
    },
  }
}

module.exports = {
  hash,
  decodeNativeWal,
  processIdentityFromStat,
  validateBrokerMapping,
  assertContinuity,
  decodeBrokerJournal,
  install,
}
if (
  process.env.LIFE_TEST_ACTIVE_RECOVERY_MODE === 'local' &&
  process.env.LIFE_TEST_BOOTSTRAP_CHILD !== '1'
) {
  assert.equal(process.type, undefined, 'Local proof belongs only to the fixture driver')
  const repository = resolve(__dirname, '../../..')
  install({
    RecoveryHarness: require(join(repository, 'tests/helpers/active-session-recovery-steps.cjs'))
      .RecoveryHarness,
    mode: 'local',
  })
}
