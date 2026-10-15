#!/usr/bin/env node
/*
 * Real production persistence/client → preload → main → worker → disk coverage.
 * Uses an 8 MiB existing response among 80 × 400 messages, exact 2 KiB UTF-16
 * stream tails, fallback replacements, coalescing, and untouched opaque history.
 * Integrated Local correctness only: actual admitted owned provider events and
 * exact native worker/disk recovery. Timers are incidental diagnostics. Startup
 * Local provider discovery uses fixture executables, without upstream inference.
 */
const assert = require('node:assert/strict')
const { createHash } = require('node:crypto')
const { existsSync } = require('node:fs')
const { mkdir, mkdtemp, readFile, readdir, rm, writeFile } = require('node:fs/promises')
const { availableParallelism, freemem, loadavg, tmpdir, totalmem } = require('node:os')
const { join, resolve } = require('node:path')
const { spawnSync } = require('node:child_process')
const esbuild = require('esbuild')
const { _electron: electron } = require('playwright')

const repository = resolve(__dirname, '..')
const baseline = false
const artifacts = resolve(
  repository,
  process.env.LIFE_TEST_ARTIFACTS_DIR ||
    'output/playwright/local-owned-appends-integration/functional',
)
const frozen = baseline
  ? join(repository, 'output/playwright/local-owned-appends-integration')
  : artifacts
const sourceRoot = baseline ? join(frozen, 'baseline-source') : repository
const helperOnly = process.argv.includes('--build-helper-only')

if (
  require.main === module &&
  !helperOnly &&
  process.platform === 'linux' &&
  process.env.LIFE_TEST_PRIVATE_LOCAL_APPENDS_XVFB !== '1'
) {
  assert.equal(spawnSync('xvfb-run', ['--help'], { stdio: 'ignore' }).status, 0)
  const child = spawnSync(
    'xvfb-run',
    ['-a', '-s', '-screen 0 1440x960x24', process.execPath, __filename, ...process.argv.slice(2)],
    {
      cwd: repository,
      env: { ...process.env, LIFE_TEST_PRIVATE_LOCAL_APPENDS_XVFB: '1' },
      stdio: 'inherit',
    },
  )
  process.exit(child.status ?? 1)
}

const rendererHelper = String.raw`
import { ConversationHistoryPersistence } from './src/renderer/conversation-persistence'
import { applyEvent, readThreads } from './src/renderer/state'
import { createHistorySnapshotProjector } from './src/renderer/conversation-checkpoint-client'
const api = window.relay.conversations
const project = createHistorySnapshotProjector()
const encoder = new TextEncoder()
const records = []
const samples = []
let threads = []
let persistence
let phase = 'idle'
let targetIndex = 79
const targetMessageId = '399:response:final_answer'
let checkpointAckGate
const exactInput = '  Preserve exact provider input\r\n\tUnicode café e\u0301 漢字 🧪  \uD83E\r\n\uDDEA'
const prefix = '  Streaming response\r\n\tUnicode café e\u0301 漢字 🧪\r\n'
function requireValue(value, message) { if (!value) throw new Error(message) }
function exact(left, right, path = 'history') {
  if (Object.is(left, right)) return
  requireValue(left && right && typeof left === 'object' && typeof right === 'object',
    'Exact value differs at ' + path)
  requireValue(Array.isArray(left) === Array.isArray(right), 'Shape differs at ' + path)
  const keys = Object.keys(left).sort()
  requireValue(JSON.stringify(keys) === JSON.stringify(Object.keys(right).sort()),
    'Keys differ at ' + path)
  for (const key of keys) exact(left[key], right[key], path + '.' + key)
}
function corpus() {
  return Array.from({ length: 80 }, (_, threadIndex) => ({
    id: 'stream-thread-' + threadIndex, profileId: 'isolated-stream-fixture',
    provider: threadIndex % 2 ? 'claude' : 'codex', workspace: '/fixture/exact workspace-' + threadIndex,
    remoteId: 'exact-native-provider-session-' + threadIndex, title: 'History ' + threadIndex,
    model: '', mode: 'default', busy: false, pending: [], turn: 399,
    updatedAt: 1_800_000_000_000 - threadIndex,
    futureThreadField: { version: 7, exact: '  opaque thread\r\n🧪  ' },
    messages: Array.from({ length: 400 }, (_, messageIndex) => ({
      id: 'stream-message-' + threadIndex + '-' + messageIndex,
      role: messageIndex % 2 ? 'assistant' : 'user', turn: messageIndex,
      text: '  Exact prompt\r\n\tUnicode café e\u0301 漢字 🧪\n' + 'x'.repeat(1009),
    })),
  }))
}
function observe(kind, input, savedAt) {
  const record = { phase, kind, savedAt, input }
  records.push(record)
  const start = performance.now()
  let pending
  try {
    pending = kind === 'save' ? api.save(input, savedAt) : api.checkpoint(input)
    record.nativeInvokeReturnMs = performance.now() - start
  } catch (error) {
    record.nativeInvokeReturnMs = performance.now() - start
    record.error = String(error)
    throw error
  }
  return pending.then(value => {
    record.nativeAcknowledgementMs = performance.now() - start
    record.acknowledged = true
    if (kind === 'checkpoint') {
      requireValue(value?.savedAt === savedAt, 'Native checkpoint must acknowledge its exact stamp')
      record.nativeAcknowledgedAt = value.savedAt
    }
    return value
  }, error => {
    record.nativeAcknowledgementMs = performance.now() - start
    record.error = String(error)
    throw error
  })
}
let save = (history, savedAt) => observe('save', history, savedAt)
let checkpoint = input => observe('checkpoint', input, input.savedAt).then(async acknowledgement => {
  const gate = checkpointAckGate
  if (gate) {
    checkpointAckGate = undefined
    gate.committed(acknowledgement.savedAt)
    await gate.release
  }
  return acknowledgement
})
function configure() {
  persistence = new ConversationHistoryPersistence({
    getThreads: () => threads, getNativeSave: () => save,
    getNativeCheckpoint: () => checkpoint,
    supportsMessageFields: () => api.supportsMessageFields === true,
    supportsMessageAppends: () => api.supportsMessageAppends === true,
    getStorage: () => ({ getItem: () => null, setItem() {
      throw new Error('Native success must never serialize a local fallback')
    } }),
    onError(message) { throw new Error(message) }, enabled: () => true,
  })
}
function changeText(text) {
  const before = threads[targetIndex]
  const messages = [...before.messages]
  const position = messages.length - 1
  messages[position] = { ...messages[position], text, input: exactInput }
  threads = [...threads.slice(0, targetIndex), { ...before, messages }, ...threads.slice(targetIndex + 1)]
}
function applyOwnedDelta(value) {
  const before = threads[targetIndex]
  const next = applyEvent(before, { sessionId: before.id, type: 'text',
    itemId: 'response', phase: 'final_answer', text: value })
  requireValue(next.messages.length === before.messages.length &&
    next.messages.at(-1).id === targetMessageId && next.messages.at(-1).input === exactInput,
    'Provider event must update the existing response and retain exact input')
  threads = [...threads.slice(0, targetIndex), next, ...threads.slice(targetIndex + 1)]
}
async function probeLargePrefixes(operation) {
  const original = String.prototype.startsWith
  const calls = []
  String.prototype.startsWith = function(...args) {
    if (typeof args[0] === 'string' && args[0].length >= 1024 * 1024)
      calls.push({ receiverCharacters: String(this).length, prefixCharacters: args[0].length })
    return Reflect.apply(original, this, args)
  }
  try { return { result: await operation(), calls } }
  finally { String.prototype.startsWith = original }
}
function tail(index) {
  const value = (index === 0 ? '\uDDEA' : '') +
    '  tail-' + index + '\r\n\tUnicode café e\u0301 漢字 🧪  \r\n'
  return value + 'z'.repeat(2048 - value.length)
}
function currentText() { return threads[targetIndex].messages.at(-1).text }
async function sample(label, operation) {
  phase = label
  const recordStart = records.length
  const intervalMs = 4
  let previous = performance.now(), maxLagMs = 0, ticks = 0
  const timer = setInterval(() => {
    const now = performance.now()
    maxLagMs = Math.max(maxLagMs, Math.max(0, now - previous - intervalMs))
    previous = now; ticks++
  }, intervalMs)
  const start = performance.now()
  try {
    const pending = operation()
    const submissionCallMs = performance.now() - start
    const result = await pending
    const elapsedMs = performance.now() - start
    await new Promise(done => setTimeout(done, intervalMs * 3))
    const value = { label, submissionCallMs, elapsedMs, rendererTimerMaxLagMs: maxLagMs,
      rendererTimerTicks: ticks, result, recordStart, recordEnd: records.length }
    samples.push(value)
    return { ...value, sampleIndex: samples.length - 1 }
  } finally { clearInterval(timer); phase = 'idle' }
}
function inspectRecord(record) {
  const { input, ...observation } = record
  const summary = { ...observation, payloadBytes: encoder.encode(JSON.stringify(input)).length }
  if (record.kind === 'checkpoint') Object.assign(summary, {
    baseSavedAt: input.baseSavedAt, changedThreads: input.upserts.length,
    fullMessageUpserts: input.upserts.reduce((n, item) => n + (item.messages.upserts?.length || 0), 0),
    replacedMessageArrays: input.upserts.filter(item => item.messages.mode === 'replace').length,
    fieldChanges: input.upserts.reduce((n, item) => n + (item.messages.fields?.length || 0), 0),
    setCharacters: input.upserts.reduce((n, item) => n + (item.messages.fields || []).reduce((m, field) =>
      m + Object.values(field.set).reduce((s, value) => s + (typeof value === 'string' ? value.length : 0), 0), 0), 0),
    appends: input.upserts.flatMap(item => (item.messages.fields || []).flatMap(field =>
      Object.entries(field.append || {}).map(([key, append]) =>
        ({ id: field.id, key, baseLength: append.baseLength, characters: append.value.length,
          exactSuffix: append.value.length < 20_000 ? append.value : undefined })))),
  })
  return summary
}
window.lifeStreamingFixture = {
  async prepare() {
    const raw = corpus()
    const baseText = prefix + 'x'.repeat(8 * 1024 * 1024 - prefix.length - 1) + '\uD83E'
    raw[targetIndex].messages.at(-1).text = baseText
    raw[targetIndex].messages.at(-1).input = exactInput
    raw[targetIndex].messages.at(-1).id = targetMessageId
    raw[targetIndex].messages.at(-1).phase = 'final_answer'
    raw[targetIndex].messages.at(-1).createdAt = 1_800_000_000_000
    threads = readThreads(raw)
    configure()
    const seed = Date.now() + 10_000
    await api.save(raw, seed)
    requireValue(persistence.adoptNativeCheckpoint(raw, seed, true),
      'Production persistence must adopt the exact durable baseline')
    return { threadCount: raw.length, messageCount: raw.reduce((n, t) => n + t.messages.length, 0),
      payloadBytes: encoder.encode(JSON.stringify(raw)).length, baseTextCharacters: baseText.length,
      capabilities: { supportsMessageFields: api.supportsMessageFields === true,
        supportsMessageAppends: api.supportsMessageAppends === true } }
  },
  append(index) { return sample('append-' + index, () => {
    applyOwnedDelta(tail(index)); return persistence.flush()
  }) },
  splitSurrogate(part) { return sample('split-surrogate-' + part, () => {
    applyOwnedDelta(part === 0 ? '\uD83E' : '\uDDEA\r\n')
    return persistence.flush()
  }) },
  replace() { return sample('nonprefix-replacement', () => {
    changeText('R' + currentText().slice(1)); return persistence.flush()
  }) },
  shrink() { return sample('shrink-response', () => {
    changeText(currentText().slice(0, -4096)); return persistence.flush()
  }) },
  burst() { return sample('coalesced-stream', () => {
    const promises = []
    for (let index = 0; index < 6; index++) {
      applyOwnedDelta(tail(20 + index)); promises.push(persistence.flush())
    }
    return Promise.all(promises)
  }) },
  async prepareMismatch() {
    const foreign = project(threads).map((thread, index) => index ? thread : { ...thread, title: 'Foreign writer' })
    const snapshot = await api.load()
    await api.save(foreign, snapshot.savedAt + 100)
  },
  mismatch() {
    return sample('worker-base-resync', () => {
      applyOwnedDelta(tail(99)); return persistence.flush()
    })
  },
  inspect(sampleIndex) {
    const entry = samples[sampleIndex]
    return records.slice(entry.recordStart, entry.recordEnd).map(inspectRecord)
  },
  async proveOwnedAndFallbacks() {
    // This instrumentation runs after every paired performance sample. It
    // deliberately changes the builtin identity and cannot be a latency sample.
    const observed = []
    const run = async (label, operation) => {
      const first = records.length
      const observation = await probeLargePrefixes(operation)
      requireValue(observation.result === true, 'Diagnostic native save must succeed')
      const value = { label, calls: observation.calls,
        records: records.slice(first).map(inspectRecord) }
      observed.push(value)
      await window.lifeStreamingFixture.verify()
    }
    await run('owned-provider-event', () => {
      applyOwnedDelta(tail(50)); return persistence.flush()
    })
    await run('unowned-prefix-growth', () => {
      changeText(currentText() + tail(51)); return persistence.flush()
    })
    await run('mutated-certified-suffix', () => {
      applyOwnedDelta(tail(52))
      const thread = threads[targetIndex]
      const message = thread.messages.at(-1)
      // Retain the complete settled prefix, but invalidate the certified suffix.
      message.text = message.text.slice(0, -1) + '!'
      threads = [...threads.slice(0, targetIndex), { ...thread, messages: [...thread.messages] },
        ...threads.slice(targetIndex + 1)]
      return persistence.flush()
    })
    return observed
  },
  async bridgeWhileAcknowledgementPending() {
    const first = records.length
    let releaseAcknowledgement, notifyCommitted
    const release = new Promise(done => { releaseAcknowledgement = done })
    const committed = new Promise(done => { notifyCommitted = done })
    checkpointAckGate = { release, committed: notifyCommitted }
    applyOwnedDelta(tail(80))
    const oldBridgeWrite = persistence.flush()
    const oldNativeStamp = await committed
    applyOwnedDelta(tail(81))
    const queuedOldBridge = persistence.flush()
    save = (history, savedAt) => observe('save', history, savedAt)
    checkpoint = input => observe('checkpoint', input, input.savedAt)
    applyOwnedDelta(tail(82))
    const newestBridgeWrite = persistence.flush()
    releaseAcknowledgement()
    const results = await Promise.all([oldBridgeWrite, queuedOldBridge, newestBridgeWrite])
    requireValue(results.every(Boolean), 'Bridge rotation must preserve every flush subscriber')
    const bridgeRecords = records.slice(first).map(inspectRecord)
    await window.lifeStreamingFixture.verify()
    const followStart = records.length
    const follow = await probeLargePrefixes(() => {
      applyOwnedDelta(tail(83)); return persistence.flush()
    })
    requireValue(follow.result === true, 'New bridge must save its following owned event')
    await window.lifeStreamingFixture.verify()
    return { oldNativeStamp, results, records: bridgeRecords, followingCalls: follow.calls,
      followingRecords: records.slice(followStart).map(inspectRecord) }
  },
  async verify() {
    const expected = project(threads)
    const snapshot = await api.load()
    exact(snapshot.threads, expected)
    const message = snapshot.threads[targetIndex].messages.at(-1)
    requireValue(message.input === exactInput, 'Exact provider input was changed')
    requireValue(message.text === currentText(), 'Exact UTF-16 response was changed')
    requireValue(snapshot.threads.every((thread, i) => thread.remoteId === 'exact-native-provider-session-' + i &&
      thread.workspace === '/fixture/exact workspace-' + i && thread.profileId === 'isolated-stream-fixture'),
      'Native provider/session/workspace ownership changed')
    const digest = await crypto.subtle.digest('SHA-256', encoder.encode(JSON.stringify(expected)))
    return { savedAt: snapshot.savedAt, exactHistorySha256: Array.from(new Uint8Array(digest),
      value => value.toString(16).padStart(2, '0')).join(''),
      exactInput: message.input, responseCharacters: message.text.length,
      providerSessionIdentityPreserved: true, workspaceOwnershipPreserved: true }
  },
  async rejectInvalidAppend() {
    const before = await api.load()
    const first = before.threads[0]
    const last = before.threads[targetIndex]
    const { messages: ignoredFirst, ...firstMetadata } = first
    const { messages: ignoredLast, ...lastMetadata } = last
    const message = last.messages.at(-1)
    let rejection
    try {
      await api.checkpoint({ version: 1, baseSavedAt: before.savedAt, savedAt: before.savedAt + 1,
        order: before.threads.map(thread => thread.id), upserts: [
          { thread: { ...firstMetadata, title: 'Must never become durable' },
            messages: { mode: 'patch', upserts: [] } },
          { thread: lastMetadata, messages: { mode: 'patch', upserts: [], fields: [{
            id: message.id, set: { input: 'Must never overwrite the provider prompt' }, remove: [],
            append: { text: { baseLength: message.text.length + 1, value: '\r\nRejected suffix' } },
          }] } },
        ] })
    } catch (error) { rejection = String(error) }
    requireValue(rejection, 'Native append must reject a mismatched UTF-16 length')
    const after = await api.load()
    exact(after, before, 'failed transaction snapshot')
    return { rejection, exactNativeSnapshotUnchanged: true }
  },
  async prepareOpaque() {
    persistence?.cancel()
    const raw = corpus()
    raw[0].messages.splice(5, 0, null, 17, false, 'opaque scalar\r\n🧪', ['future', { exact: '  data  ' }],
      { role: 'user', text: 'missing identifier\r\n\t' },
      { id: 'opaque-future', role: 'future-provider-role', text: 'future text\r\n🧪', input: exactInput,
        futureMessageField: { nested: ['keep', '\uD83E', '\uDDEA'] } },
      { id: raw[0].messages[0].id, role: 'user', text: 'valid duplicated identifier\r\n🧪' })
    const snapshot = await api.load()
    await api.save(raw, snapshot.savedAt + 1000)
    return { payloadBytes: encoder.encode(JSON.stringify(raw)).length,
      threadCount: raw.length, rawMessageCount: raw.reduce((n, thread) => n + thread.messages.length, 0),
      sha256: Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256',
        encoder.encode(JSON.stringify(raw)))), value => value.toString(16).padStart(2, '0')).join('') }
  },
}
`

async function prepareFrozenArtifacts() {
  if (baseline) return
  await mkdir(frozen, { recursive: true })
  const manifestPath = join(frozen, 'source-freeze.json')
  if (existsSync(manifestPath)) return
  const inventory = async (root) => {
    const hashes = {}
    const visit = async (directory) => {
      for (const entry of await readdir(join(repository, directory), { withFileTypes: true })) {
        const name = directory + '/' + entry.name
        if (entry.isDirectory()) await visit(name)
        else {
          assert.ok(entry.isFile(), 'Frozen inputs must be regular files: ' + name)
          hashes[name] = createHash('sha256')
            .update(await readFile(join(repository, name)))
            .digest('hex')
        }
      }
    }
    await visit(root)
    return hashes
  }
  const sha256 = await inventory('src')
  const compiledOut = await inventory('out')
  const verifiedPath = join(repository, 'output/linux-compiled-build.json')
  let sourceCommit
  if (existsSync(verifiedPath)) {
    const verified = JSON.parse(await readFile(verifiedPath, 'utf8'))
    assert.deepEqual(
      sha256,
      Object.fromEntries(verified.source.map((row) => ['src/' + row.path, row.sha256])),
    )
    assert.deepEqual(
      compiledOut,
      Object.fromEntries(verified.compiled.map((row) => [row.path, row.sha256])),
    )
    sourceCommit = verified.sourceCommit
  }
  await writeFile(
    manifestPath,
    JSON.stringify({ sourceCommit, sha256, compiledOut }, null, 2) + '\n',
    { flag: 'wx' },
  )
}

async function buildHelper() {
  await assertFrozenSourceGraph()
  await mkdir(artifacts, { recursive: true })
  const pluginPath = join(artifacts, 'streaming-inline-worker-plugin.cjs')
  await esbuild.build({
    entryPoints: [join(sourceRoot, 'src/main/inline-worker-plugin.ts')],
    outfile: pluginPath,
    bundle: true,
    platform: 'node',
    format: 'cjs',
    target: 'node22',
    logLevel: 'silent',
  })
  delete require.cache[pluginPath]
  const { inlineWorkerPlugin } = require(pluginPath)
  const helperPath = join(artifacts, 'streaming-renderer-fixture.js')
  await esbuild.build({
    stdin: {
      contents: rendererHelper,
      resolveDir: sourceRoot,
      sourcefile: 'streaming-renderer-fixture.ts',
      loader: 'ts',
    },
    outfile: helperPath,
    bundle: true,
    platform: 'browser',
    format: 'iife',
    target: 'chrome130',
    plugins: [inlineWorkerPlugin(esbuild, { target: 'chrome130' })],
    logLevel: 'silent',
  })
  await assertFrozenSourceGraph()
  return helperPath
}
async function assertFrozenSourceGraph() {
  const manifest = JSON.parse(
    await readFile(
      baseline ? join(frozen, 'baseline-artifact-hashes.json') : join(frozen, 'source-freeze.json'),
      'utf8',
    ),
  )
  const expected = baseline
    ? Object.fromEntries(
        Object.entries(manifest.files)
          .filter(([name]) => name.startsWith('src/'))
          .map(([name, row]) => [name, row.sha256]),
      )
    : manifest.sha256
  const sourceFiles = []
  const listSourceFiles = async (directory) => {
    for (const entry of await readdir(join(sourceRoot, directory), { withFileTypes: true })) {
      const name = directory + '/' + entry.name
      if (entry.isDirectory()) await listSourceFiles(name)
      else if (entry.isFile()) sourceFiles.push(name)
      else throw new Error(`Unexpected frozen source entry: ${name}`)
    }
  }
  await listSourceFiles('src')
  assert.deepEqual(sourceFiles.sort(), Object.keys(expected).sort(), 'Frozen source graph changed')
  for (const [name, digest] of Object.entries(expected))
    assert.equal(
      createHash('sha256')
        .update(await readFile(join(sourceRoot, name)))
        .digest('hex'),
      digest,
      `Frozen source changed: ${name}`,
    )
}
async function assertFrozenArtifacts() {
  await assertFrozenSourceGraph()
  const manifest = JSON.parse(
    await readFile(
      baseline ? join(frozen, 'baseline-artifact-hashes.json') : join(frozen, 'source-freeze.json'),
      'utf8',
    ),
  )
  const expected = baseline
    ? Object.fromEntries(
        Object.entries(manifest.files)
          .filter(([name]) => name.startsWith('out/'))
          .map(([name, row]) => [name.slice(4), row.sha256]),
      )
    : Object.fromEntries(
        Object.entries(manifest.compiledOut).map(([name, hash]) => [name.slice(4), hash]),
      )
  const builtOut = baseline ? join(frozen, 'built-out') : join(repository, 'out')
  const compiledFiles = []
  const listCompiled = async (directory) => {
    for (const entry of await readdir(join(builtOut, directory), { withFileTypes: true })) {
      const name = directory ? directory + '/' + entry.name : entry.name
      if (entry.isDirectory()) await listCompiled(name)
      else if (entry.isFile()) compiledFiles.push(name)
      else throw new Error(`Unexpected frozen build entry: ${name}`)
    }
  }
  await listCompiled('')
  assert.deepEqual(
    compiledFiles.sort(),
    Object.keys(expected).sort(),
    'Frozen compiled graph changed',
  )
  for (const [name, digest] of Object.entries(expected))
    assert.equal(
      createHash('sha256')
        .update(await readFile(join(builtOut, name)))
        .digest('hex'),
      digest,
      `Frozen compiled artifact changed: ${name}`,
    )
}
async function hostSnapshot() {
  const backgroundPid = Number(process.env.LIFE_TEST_BACKGROUND_PID || 2564277)
  const snapshot = {
    capturedAt: new Date().toISOString(),
    availableParallelism: availableParallelism(),
    loadAverage: loadavg(),
    totalMemoryBytes: totalmem(),
    freeMemoryBytes: freemem(),
    background: { pid: backgroundPid },
  }
  if (process.platform === 'linux') {
    for (const [key, file] of [
      ['cpuMax', '/sys/fs/cgroup/cpu.max'],
      ['memoryMax', '/sys/fs/cgroup/memory.max'],
      ['allowedCpus', '/sys/fs/cgroup/cpuset.cpus.effective'],
    ])
      try {
        snapshot[key] = (await readFile(file, 'utf8')).trim()
      } catch {}
    try {
      const stat = await readFile(`/proc/${backgroundPid}/stat`, 'utf8')
      const fields = stat
        .slice(stat.lastIndexOf(')') + 2)
        .trim()
        .split(/\s+/)
      snapshot.background = {
        pid: backgroundPid,
        comm: (await readFile(`/proc/${backgroundPid}/comm`, 'utf8')).trim(),
        state: fields[0],
        userCpuTicks: Number(fields[11]),
        systemCpuTicks: Number(fields[12]),
        threads: Number(fields[17]),
        startedAtTicks: Number(fields[19]),
      }
    } catch (error) {
      snapshot.background.observationError = error.code || String(error)
    }
    try {
      const cpu = (await readFile('/proc/stat', 'utf8')).split('\n')[0].trim().split(/\s+/)
      snapshot.aggregateCpuTicks = cpu.slice(1).map(Number)
    } catch {}
  }
  return snapshot
}
async function installMainProbe(application) {
  await application.evaluate(({ ipcMain }) => {
    const { Worker } = process.getBuiltinModule('node:worker_threads')
    const probe = { records: [], commands: [], timer: undefined, ticks: 0, maxLagMs: 0 }
    const original = Worker.prototype.postMessage
    Worker.prototype.postMessage = function (message, ...args) {
      if (['save', 'checkpoint', 'load', 'loadEncoded'].includes(message?.command?.type))
        probe.commands.push({ threadId: this.threadId, type: message.command.type })
      return Reflect.apply(original, this, [message, ...args])
    }
    for (const channel of ['conversations:save', 'conversations:checkpoint']) {
      const originalHandler = ipcMain._invokeHandlers.get(channel)
      if (!originalHandler) throw new Error('Missing production IPC handler ' + channel)
      ipcMain.removeHandler(channel)
      ipcMain.handle(channel, async (...args) => {
        const record = {
          kind: channel.endsWith('checkpoint') ? 'checkpoint' : 'save',
          input: args[1],
          savedAt: channel.endsWith('checkpoint') ? args[1].savedAt : args[2],
        }
        probe.records.push(record)
        try {
          const result = await originalHandler(...args)
          record.acknowledged = true
          return result
        } catch (error) {
          record.error = String(error)
          throw error
        }
      })
    }
    globalThis.__lifeStreamingProbe = probe
  })
}
async function startMainProbe(application) {
  await application.evaluate(() => {
    const p = globalThis.__lifeStreamingProbe
    clearInterval(p.timer)
    p.ticks = 0
    p.maxLagMs = 0
    p.recordStart = p.records.length
    let previous = performance.now()
    p.timer = setInterval(() => {
      const now = performance.now()
      p.maxLagMs = Math.max(p.maxLagMs, Math.max(0, now - previous - 4))
      previous = now
      p.ticks++
    }, 4)
  })
}
async function stopMainProbe(application) {
  return application.evaluate(() => {
    const p = globalThis.__lifeStreamingProbe
    clearInterval(p.timer)
    return { mainTimerMaxLagMs: p.maxLagMs, mainTimerTicks: p.ticks }
  })
}
async function inspectMainWrites(application) {
  return application.evaluate(() => {
    const p = globalThis.__lifeStreamingProbe
    return p.records.slice(p.recordStart).map((record) => ({
      kind: record.kind,
      savedAt: record.savedAt,
      acknowledged: record.acknowledged,
      error: record.error,
      payloadBytes: Buffer.byteLength(JSON.stringify(record.input)),
      changedThreads: record.kind === 'checkpoint' ? record.input.upserts.length : undefined,
    }))
  })
}
async function startLocalFixture() {
  const bundled = join(artifacts, 'streaming-local-fixture.cjs')
  await esbuild.build({
    entryPoints: [join(repository, 'tests/helpers/local-fixture.ts')],
    outfile: bundled,
    bundle: true,
    platform: 'node',
    format: 'cjs',
    packages: 'external',
    logLevel: 'silent',
  })
  const { LocalFixture } = require(bundled)
  const fixture = new LocalFixture()
  try {
    return await fixture.start(join(repository, 'tests/fixtures/fake-provider.cjs'))
  } catch (error) {
    if (fixture.root) await fixture.close().catch(() => {})
    throw error
  }
}
async function run() {
  if (!helperOnly)
    for (const file of ['streaming-electron-report.json', 'streaming-electron-failure.json'])
      assert.equal(
        existsSync(join(artifacts, file)),
        false,
        'Preserve prior results by selecting a fresh LIFE_TEST_ARTIFACTS_DIR',
      )
  await prepareFrozenArtifacts()
  const helperPath = await buildHelper()
  if (helperOnly) {
    console.log(`Streaming helper built: ${helperPath}`)
    return
  }
  await assertFrozenArtifacts()
  const integratedHarnessSha256 = createHash('sha256')
    .update(await readFile(__filename))
    .digest('hex')
  const integratedManifestSha256 = createHash('sha256')
    .update(await readFile(join(frozen, 'source-freeze.json')))
    .digest('hex')
  const startupFixtureInputHashes = {}
  for (const name of [
    'tests/helpers/local-fixture.ts',
    'tests/helpers/local-command-rewrite.cjs',
    'tests/fixtures/fake-provider.cjs',
  ])
    startupFixtureInputHashes[name] = createHash('sha256')
      .update(await readFile(join(repository, name)))
      .digest('hex')
  const builtOut = baseline ? join(frozen, 'built-out') : join(repository, 'out')
  const artifactIdentities = {}
  for (const [label, path] of [
    ['main', join(builtOut, 'main/index.js')],
    ['worker', join(builtOut, 'main/conversation-checkpoint-worker.js')],
    ['preload', join(builtOut, 'preload/index.js')],
    ['rendererHelper', helperPath],
  ])
    artifactIdentities[label] = createHash('sha256')
      .update(await readFile(path))
      .digest('hex')
  const metadata = JSON.parse(await readFile(join(repository, 'package.json'), 'utf8'))
  const wantsPackaged = false
  assert.ok(!baseline || !wantsPackaged, 'Frozen baseline uses its captured source build')
  const selectedBinary = undefined
  if (selectedBinary)
    assert.ok(existsSync(selectedBinary), 'Build the unpacked Electron application first')
  let appRoot = repository
  if (baseline) {
    appRoot = join(frozen, 'baseline-app')
    await mkdir(appRoot, { recursive: true })
    await writeFile(
      join(appRoot, 'package.json'),
      JSON.stringify({ ...metadata, main: '../built-out/main/index.js' }),
    )
  }
  const configurationRoot = await mkdtemp(join(tmpdir(), 'life-streaming-electron-'))
  const hostAtLaunch = await hostSnapshot()
  const phases = [],
    rendererErrors = [],
    nativeLogs = [],
    startupProviderCalls = []
  let application,
    localFixture,
    launchProof,
    phase = 'launch',
    opaque
  const progressTimer = setInterval(() => console.log(`Streaming Electron phase: ${phase}`), 30_000)
  const launch = async () => {
    const app = await electron.launch({
      executablePath: selectedBinary || require('electron'),
      args: [
        ...(selectedBinary ? [] : [appRoot]),
        ...(process.platform === 'linux' ? ['--no-sandbox'] : []),
        '--disable-dev-shm-usage',
        `--user-data-dir=${join(configurationRoot, 'chromium')}`,
      ],
      cwd: repository,
      env: {
        ...localFixture.env,
        ELECTRON_RENDERER_URL: '',
        XDG_CONFIG_HOME: configurationRoot,
        LIFE_TEST_CONFIG_HOME: configurationRoot,
        ...(process.platform === 'win32' ? { APPDATA: configurationRoot } : {}),
      },
      timeout: 30_000,
    })
    // Publish ownership immediately so readiness failures and cold-restart
    // failures still close this private process in the outer finally.
    application = app
    for (const stream of ['stdout', 'stderr'])
      app.process()[stream]?.on('data', (chunk) => {
        nativeLogs.push({ stream, text: String(chunk).slice(-4000) })
        if (nativeLogs.length > 20) nativeLogs.shift()
      })
    const page = await app.firstWindow()
    page.setDefaultTimeout(30_000)
    page.on('pageerror', (error) => rendererErrors.push(error.message))
    await page.locator('.app-shell').waitFor()
    await page.waitForFunction(() => typeof window.relay?.conversations?.checkpoint === 'function')
    await page.locator('.app-body[aria-busy="false"]').waitFor()
    assert.equal(await page.getByRole('button', { name: 'Retry loading', exact: true }).count(), 0)
    await page.waitForFunction(() => typeof window.__lifeFlushConversationHistory === 'function')
    await page.evaluate(() => window.__lifeFlushConversationHistory())
    await page.waitForFunction(async (workspace) => {
      const state = await window.relay.connection.state()
      return (
        state.status === 'connected' &&
        state.profile?.transport === 'local' &&
        state.workspace === workspace &&
        state.providerVersionsStatus === 'ready'
      )
    }, localFixture.workspace)
    const calls = await localFixture.log()
    assert.ok(
      calls.every((call) => !Object.hasOwn(call, 'prompt') && call.kind !== 'turn-started'),
      'Persistence fixture must never start provider inference',
    )
    const state = await page.evaluate(() => window.relay.connection.state())
    assert.equal(state.workspace, localFixture.workspace)
    assert.ok(
      ['codex', 'claude'].every((provider) =>
        calls.some((call) => call.provider === provider && call.argv?.includes('--version')),
      ),
      'Both Local provider discovery commands must execute fixture-owned stand-ins',
    )
    startupProviderCalls.push({
      launch: startupProviderCalls.length + 1,
      cumulativeCalls: true,
      status: state.status,
      transport: state.profile?.transport,
      workspace: state.workspace,
      providerVersionsStatus: state.providerVersionsStatus,
      calls: calls.map((call) => ({
        provider: call.provider,
        cwd: call.cwd,
        argv: call.argv,
        kind: call.kind,
      })),
    })
    console.log(
      JSON.stringify({
        functionalNativeHandle: {
          pid: app.process().pid,
          privateProfile: configurationRoot,
          privateLocalFixture: localFixture.root,
          display: process.env.DISPLAY,
        },
      }),
    )
    return { app, page }
  }
  try {
    localFixture = await startLocalFixture()
    const privateUserData = join(configurationRoot, 'chromium')
    await mkdir(privateUserData, { recursive: true })
    await writeFile(
      join(privateUserData, 'connections.json'),
      JSON.stringify({
        profiles: [],
        knownHosts: {},
        localWorkspace: localFixture.workspace,
      }),
      { flag: 'wx' },
    )
    let page
    ;({ app: application, page } = await launch())
    launchProof = await application.evaluate(({ app, BrowserWindow }) => {
      const fs = process.getBuiltinModule('node:fs')
      const path = process.getBuiltinModule('node:path')
      const crypto = process.getBuiltinModule('node:crypto')
      const base = app.isPackaged
        ? path.join(app.getAppPath(), 'out')
        : path.resolve(
            app.getAppPath(),
            JSON.parse(fs.readFileSync(path.join(app.getAppPath(), 'package.json'), 'utf8')).main,
            '../..',
          )
      const runtimeArtifactIdentities = {}
      for (const [label, relative] of [
        ['main', 'main/index.js'],
        ['worker', 'main/conversation-checkpoint-worker.js'],
        ['preload', 'preload/index.js'],
      ])
        runtimeArtifactIdentities[label] = crypto
          .createHash('sha256')
          .update(fs.readFileSync(path.join(base, relative)))
          .digest('hex')
      return {
        version: app.getVersion(),
        appPath: app.getAppPath(),
        userData: app.getPath('userData'),
        packaged: app.isPackaged,
        runtimeArtifactIdentities,
        embeddedWorkerExists: fs.existsSync(
          path.join(base, 'main/conversation-checkpoint-worker.js'),
        ),
        unpackedWorkerExists:
          app.isPackaged &&
          fs.existsSync(
            path
              .join(base, 'main/conversation-checkpoint-worker.js')
              .replace(/\.asar([/\\])/, '.asar.unpacked$1'),
          ),
        rendererSandboxed:
          BrowserWindow.getAllWindows()[0].webContents.getLastWebPreferences().sandbox,
      }
    })
    assert.ok(launchProof.userData.startsWith(configurationRoot))
    assert.equal(
      launchProof.userData,
      join(configurationRoot, 'chromium'),
      'Integrated Local must use the exact seeded private configuration directory',
    )
    assert.equal(launchProof.rendererSandboxed, true)
    assert.equal(launchProof.packaged, wantsPackaged)
    assert.equal(launchProof.embeddedWorkerExists, true)
    if (wantsPackaged)
      assert.equal(
        launchProof.unpackedWorkerExists,
        false,
        'Worker must execute from the ASAR archive',
      )
    for (const key of ['main', 'worker', 'preload'])
      assert.equal(
        launchProof.runtimeArtifactIdentities[key],
        artifactIdentities[key],
        `Launched ${key} differs from measured build`,
      )
    await page.waitForTimeout(2500)
    await installMainProbe(application)
    const evaluatedHelper =
      (await readFile(helperPath, 'utf8')) +
      `\n//# sourceURL=owned-streaming-fixture-${baseline ? 'baseline' : 'candidate'}.js\n`
    await page.evaluate(evaluatedHelper)
    phase = 'prepare-large-response'
    const fixture = await page.evaluate(() => window.lifeStreamingFixture.prepare())
    assert.equal(fixture.threadCount, 80)
    assert.equal(fixture.messageCount, 32000)
    assert.equal(fixture.baseTextCharacters, 8 * 1024 * 1024)
    assert.equal(fixture.capabilities.supportsMessageFields, true)
    assert.equal(fixture.capabilities.supportsMessageAppends, true)
    const hostBeforePairedSamples = await hostSnapshot()
    const measure = async (method, input) => {
      phase = method + (input === undefined ? '' : '-' + input)
      if (method === 'mismatch')
        await page.evaluate(() => window.lifeStreamingFixture.prepareMismatch())
      await startMainProbe(application)
      const sample = await page.evaluate(
        ({ method, input }) => window.lifeStreamingFixture[method](input),
        { method, input },
      )
      const main = await stopMainProbe(application)
      const records = await page.evaluate(
        (index) => window.lifeStreamingFixture.inspect(index),
        sample.sampleIndex,
      )
      assert.ok(sample.rendererTimerTicks > 0 && main.mainTimerTicks > 0)
      const result = { ...sample, ...main, records }
      phases.push(result)
      await page.evaluate(() => window.lifeStreamingFixture.verify())
      return result
    }
    for (let index = 0; index < 4; index++) {
      const result = await measure('append', index)
      assert.equal(result.result, true)
      assert.equal(result.records.length, 1)
      assert.equal(result.records[0].kind, 'checkpoint')
      assert.equal(result.records[0].fullMessageUpserts, 0)
      assert.equal(result.records[0].fieldChanges, 1)
      assert.equal(result.records[0].acknowledged, true)
      assert.equal(result.records[0].appends.length, 1)
      assert.equal(result.records[0].appends[0].characters, 2048)
      assert.equal(result.records[0].setCharacters, 0)
      assert.ok(result.records[0].payloadBytes < 10_000)
    }
    const hostAfterPairedSamples = await hostSnapshot()
    for (let part = 0; part < 2; part++) await measure('splitSurrogate', part)
    for (const method of ['replace', 'shrink']) {
      const result = await measure(method)
      assert.equal(result.records.length, 1)
      assert.equal(result.records[0].appends.length, 0)
      assert.ok(result.records[0].setCharacters > 8 * 1024 * 1024 - 4096)
    }
    const burst = await measure('burst')
    assert.deepEqual(burst.result, Array(6).fill(true))
    assert.equal(
      burst.records.length,
      2,
      'One active plus one newest pending write bounds the queue',
    )
    assert.equal(burst.records[1].baseSavedAt, burst.records[0].savedAt)
    assert.deepEqual(
      burst.records.map((record) => record.appends[0].characters),
      [2048, 5 * 2048],
    )
    const mismatch = await measure('mismatch')
    assert.deepEqual(
      mismatch.records.map((record) => record.kind),
      ['checkpoint', 'save'],
    )
    assert.match(mismatch.records[0].error, /CONVERSATION_CHECKPOINT_BASE_CHANGED/)
    assert.equal(mismatch.records[1].acknowledged, true)
    phase = 'untimed-bridge-rotation-during-native-ack'
    const bridgeRotation = await page.evaluate(() =>
      window.lifeStreamingFixture.bridgeWhileAcknowledgementPending(),
    )
    assert.deepEqual(
      bridgeRotation.records.map((record) => record.kind),
      ['checkpoint', 'save'],
    )
    assert.equal(bridgeRotation.records[0].nativeAcknowledgedAt, bridgeRotation.oldNativeStamp)
    assert.equal(bridgeRotation.followingRecords.length, 1)
    assert.equal(bridgeRotation.followingRecords[0].kind, 'checkpoint')
    assert.equal(bridgeRotation.followingRecords[0].baseSavedAt, bridgeRotation.records[1].savedAt)
    assert.equal(bridgeRotation.followingRecords[0].appends[0].characters, 2048)
    assert.equal(bridgeRotation.followingCalls.length, baseline ? 1 : 0)
    phase = 'untimed-owned-proof-and-fallbacks'
    const ownershipProof = await page.evaluate(() =>
      window.lifeStreamingFixture.proveOwnedAndFallbacks(),
    )
    assert.deepEqual(
      ownershipProof.map((value) => value.label),
      ['owned-provider-event', 'unowned-prefix-growth', 'mutated-certified-suffix'],
    )
    assert.equal(
      ownershipProof[0].calls.length,
      baseline ? 1 : 0,
      'Owned provider deltas skip the large settled prefix only in the candidate',
    )
    assert.equal(ownershipProof[0].records[0].appends[0].characters, 2048)
    assert.equal(
      ownershipProof[1].calls.length,
      1,
      'Unowned growth must retain complete exact prefix verification',
    )
    assert.equal(ownershipProof[1].records[0].appends[0].characters, 2048)
    if (baseline) {
      assert.equal(ownershipProof[2].calls.length, 1)
      assert.equal(ownershipProof[2].records[0].appends[0].exactSuffix.at(-1), '!')
    } else {
      assert.equal(ownershipProof[2].calls.length, 0)
      assert.equal(ownershipProof[2].records.length, 1)
      assert.equal(
        ownershipProof[2].records[0].kind,
        'save',
        'A known mutation forces exact full recovery because shared baselines may also be stale',
      )
      assert.ok(ownershipProof[2].records[0].payloadBytes > 8 * 1024 * 1024)
    }

    const postQuarantineRecovery = []
    if (!baseline) {
      phase = 'untimed-post-quarantine-immutable-successors'
      for (const index of [60, 61]) {
        const observed = await page.evaluate(async (index) => {
          const original = String.prototype.startsWith
          const calls = []
          String.prototype.startsWith = function (...args) {
            if (typeof args[0] === 'string' && args[0].length >= 1024 * 1024)
              calls.push({
                receiverCharacters: String(this).length,
                prefixCharacters: args[0].length,
              })
            return Reflect.apply(original, this, args)
          }
          try {
            const sample = await window.lifeStreamingFixture.append(index)
            return { result: sample.result, sampleIndex: sample.sampleIndex, calls }
          } finally {
            String.prototype.startsWith = original
          }
        }, index)
        const records = await page.evaluate(
          (sampleIndex) => window.lifeStreamingFixture.inspect(sampleIndex),
          observed.sampleIndex,
        )
        const exactNative = await page.evaluate(() => window.lifeStreamingFixture.verify())
        const exactDisk = JSON.parse(
          await readFile(join(launchProof.userData, 'conversations.json'), 'utf8'),
        )
        const diskSha256 = createHash('sha256')
          .update(JSON.stringify(exactDisk.threads))
          .digest('hex')
        const recoveryObservation = {
          index,
          untimed: true,
          timingClaims: false,
          result: observed.result,
          largePrefixScans: observed.calls,
          records,
          exactNativeHistorySha256: exactNative.exactHistorySha256,
          exactDiskHistorySha256: diskSha256,
          responseCharacters: exactNative.responseCharacters,
          exactInput: exactNative.exactInput,
          providerSessionIdentityPreserved: exactNative.providerSessionIdentityPreserved,
          workspaceOwnershipPreserved: exactNative.workspaceOwnershipPreserved,
        }
        postQuarantineRecovery.push(recoveryObservation)
        await writeFile(
          join(artifacts, 'post-quarantine-recovery.json'),
          JSON.stringify(postQuarantineRecovery, null, 2),
        )
        assert.equal(observed.result, true)
        assert.equal(
          observed.calls.length,
          0,
          'Known-quarantine recovery and subsequent owned append must avoid large-prefix scans',
        )
        assert.equal(
          diskSha256,
          exactNative.exactHistorySha256,
          'Each immutable successor must exactly match native and durable history',
        )
        assert.equal(records.length, 1)
        assert.equal(records[0].acknowledged, true)
        if (index === 60) {
          assert.equal(
            records[0].kind,
            'save',
            'The first immutable successor requires one conservative recovery save',
          )
          assert.ok(records[0].payloadBytes > 8 * 1024 * 1024)
        } else {
          assert.equal(
            records[0].kind,
            'checkpoint',
            'The next immutable successor must regain the owned append checkpoint',
          )
          assert.equal(records[0].baseSavedAt, postQuarantineRecovery[0].records[0].savedAt)
          assert.equal(records[0].fullMessageUpserts, 0)
          assert.equal(records[0].setCharacters, 0)
          assert.equal(records[0].appends.length, 1)
          assert.equal(records[0].appends[0].characters, 2048)
          assert.equal(
            records[0].appends[0].baseLength,
            postQuarantineRecovery[0].responseCharacters,
          )
          const suffix = '  tail-61\r\n\tUnicode café e\u0301 漢字 🧪  \r\n'
          assert.equal(records[0].appends[0].exactSuffix, suffix + 'z'.repeat(2048 - suffix.length))
          assert.ok(records[0].payloadBytes < 10_000)
          assert.equal(exactNative.exactInput, postQuarantineRecovery[0].exactInput)
        }
      }
    }
    const diagnosticCpuProfile = { disabled: true, functionalOnly: true }
    const recovery = await page.evaluate(() => window.lifeStreamingFixture.verify())
    let disk = JSON.parse(await readFile(join(launchProof.userData, 'conversations.json'), 'utf8'))
    assert.equal(
      createHash('sha256').update(JSON.stringify(disk.threads)).digest('hex'),
      recovery.exactHistorySha256,
    )
    let rejectedAppend
    {
      phase = 'atomic-invalid-append'
      const before = await readFile(join(launchProof.userData, 'conversations.json'))
      rejectedAppend = await page.evaluate(() => window.lifeStreamingFixture.rejectInvalidAppend())
      assert.deepEqual(
        await readFile(join(launchProof.userData, 'conversations.json')),
        before,
        'A rejected append cannot alter any earlier metadata, prompt, or durable bytes',
      )
    }
    phase = 'streamed-response-native-restart'
    await application.close()
    application = undefined
    ;({ app: application, page } = await launch())
    await page.waitForTimeout(2500)
    const restartedStream = await page.evaluate(() => window.relay.conversations.load())
    assert.equal(
      createHash('sha256').update(JSON.stringify(restartedStream.threads)).digest('hex'),
      recovery.exactHistorySha256,
      'All streamed tails and exact provider input must survive a fresh native worker',
    )
    await installMainProbe(application)
    await page.evaluate(await readFile(helperPath, 'utf8'))
    phase = 'prepare-opaque-startup'
    opaque = await page.evaluate(() => window.lifeStreamingFixture.prepareOpaque())
    disk = JSON.parse(await readFile(join(launchProof.userData, 'conversations.json'), 'utf8'))
    assert.equal(
      createHash('sha256').update(JSON.stringify(disk.threads)).digest('hex'),
      opaque.sha256,
    )
    // Measure actual App restoration and its first automatic checkpoint. A new
    // renderer timer starts before app code; inspection/serialization is deferred.
    await page.addInitScript(() => {
      const probe = { ticks: 0, maxLagMs: 0 }
      let previous = performance.now()
      probe.timer = setInterval(() => {
        const now = performance.now()
        probe.maxLagMs = Math.max(probe.maxLagMs, Math.max(0, now - previous - 4))
        previous = now
        probe.ticks++
      }, 4)
      window.__lifeStartupStreamingProbe = probe
    })
    phase = 'opaque-first-app-checkpoint'
    await startMainProbe(application)
    const startupStart = performance.now()
    await page.reload()
    await page.locator('.app-shell').waitFor()
    await page.waitForTimeout(3000)
    const main = await stopMainProbe(application)
    const startupElapsedMs = performance.now() - startupStart
    const renderer = await page.evaluate(() => {
      const p = window.__lifeStartupStreamingProbe
      clearInterval(p.timer)
      return { rendererTimerMaxLagMs: p.maxLagMs, rendererTimerTicks: p.ticks }
    })
    const startupWrites = await inspectMainWrites(application)
    assert.equal(startupWrites.length, 1)
    assert.equal(startupWrites[0].acknowledged, true)
    assert.equal(startupWrites[0].kind, 'checkpoint')
    assert.equal(startupWrites[0].changedThreads, 0)
    assert.ok(startupWrites[0].payloadBytes < 10_000)
    disk = JSON.parse(await readFile(join(launchProof.userData, 'conversations.json'), 'utf8'))
    assert.equal(
      createHash('sha256').update(JSON.stringify(disk.threads)).digest('hex'),
      opaque.sha256,
      'Opaque source values must survive the first actual App autosave unchanged',
    )
    const opaqueStartup = {
      label: 'opaque-first-app-checkpoint',
      observationWindowMs: startupElapsedMs,
      settleDwellMs: 3000,
      ...main,
      ...renderer,
      records: startupWrites,
      exactRawHistoryPreserved: true,
    }
    phase = 'native-restart-recovery'
    await application.close()
    application = undefined
    ;({ app: application, page } = await launch())
    await page.waitForTimeout(2500)
    const restarted = await page.evaluate(() => window.relay.conversations.load())
    assert.equal(
      createHash('sha256').update(JSON.stringify(restarted.threads)).digest('hex'),
      opaque.sha256,
    )
    assert.equal(rendererErrors.length, 0, rendererErrors.join('\n'))
    const report = {
      fixture: '80 threads × 400 messages; 8 MiB existing response; 2 KiB exact UTF-16 appends',
      functionalOnly: true,
      timingClaims: false,
      integratedLocal: true,
      fixtureProvenance: {
        integratedHarnessSha256,
        integratedManifestSha256,
        sourceOwnedHarnessSha256:
          '38eb88ba934304b5ccd12647e53be2f50fbe8a24715e4771d92035178e46e241',
        rendererHelperBodySha256: createHash('sha256').update(rendererHelper).digest('hex'),
        startupFixtureInputHashes,
      },
      hostLoad: {
        hostAtLaunch,
        hostBeforePairedSamples,
        hostAfterPairedSamples,
        policy:
          'Unrelated editor processes remain unchanged; host noise is recorded, not suppressed.',
      },
      artifactIdentities,
      upstreamProvidersUsed: false,
      launchProof,
      fixturePayload: fixture,
      phases,
      recovery,
      ownershipProof,
      postQuarantineRecovery,
      startupProviderCalls,
      nativeStartupUsesFixtureExecutables: true,
      bridgeRotation,
      diagnosticCpuProfile,
      rejectedAppend,
      streamedResponseNativeRestartPreservesExactHistory: true,
      opaqueFixture: opaque,
      opaqueStartup,
      nativeRestartPreservesExactHistory: true,
      rendererErrors,
      measurementLimits:
        'FUNCTIONAL ONLY: incidental timers are diagnostics. No before/after timing comparison or CPU profiling. All synthetic provider events persist through actual integrated native IPC/worker/disk, without upstream inference.',
    }
    await assertFrozenArtifacts()
    assert.equal(
      createHash('sha256')
        .update(await readFile(__filename))
        .digest('hex'),
      integratedHarnessSha256,
      'Integrated fixture delivery changed during native verification',
    )
    assert.equal(
      createHash('sha256')
        .update(await readFile(join(frozen, 'source-freeze.json')))
        .digest('hex'),
      integratedManifestSha256,
      'Integrated source/build manifest changed during native verification',
    )
    const allProviderCalls = await localFixture.log()
    assert.ok(
      allProviderCalls.every(
        (call) => !Object.hasOwn(call, 'prompt') && call.kind !== 'turn-started',
      ),
      'Synthetic persistence cannot invoke upstream inference',
    )
    await writeFile(
      join(artifacts, 'native-startup-provider-calls.json'),
      JSON.stringify(
        {
          fixtureOnly: true,
          inferenceRequests: 0,
          startup: startupProviderCalls,
          allCalls: allProviderCalls.map((call) => ({
            provider: call.provider,
            cwd: call.cwd,
            argv: call.argv,
            kind: call.kind,
          })),
        },
        null,
        2,
      ),
    )
    for (const [name, digest] of Object.entries(startupFixtureInputHashes))
      assert.equal(
        createHash('sha256')
          .update(await readFile(join(repository, name)))
          .digest('hex'),
        digest,
        'Startup fixture input changed: ' + name,
      )
    report.success = true
    await writeFile(
      join(artifacts, 'streaming-electron-report.json'),
      JSON.stringify(report, null, 2),
      { flag: 'wx' },
    )
    console.log(JSON.stringify(report, null, 2))
  } catch (error) {
    await writeFile(
      join(artifacts, 'streaming-electron-failure.json'),
      JSON.stringify(
        {
          phase,
          error: error.stack || String(error),
          launchProof,
          phases,
          opaque,
          rendererErrors,
          nativeLogs,
        },
        null,
        2,
      ),
    )
    throw error
  } finally {
    clearInterval(progressTimer)
    if (application) await application.close().catch(() => {})
    if (localFixture) await localFixture.close()
    await rm(configurationRoot, { recursive: true, force: true })
  }
}
module.exports = {
  buildHelper,
  assertFrozenSourceGraph,
  assertFrozenArtifacts,
  hostSnapshot,
  installMainProbe,
  startMainProbe,
  stopMainProbe,
  inspectMainWrites,
  repository,
  artifacts,
  frozen,
  baseline,
}
if (require.main === module)
  run().catch((error) => {
    console.error(error)
    process.exitCode = 1
  })
