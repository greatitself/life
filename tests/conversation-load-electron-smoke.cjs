#!/usr/bin/env node
/*
 * Measure real Electron history loading and the production browser decoder.
 * Run after npm run build; LIFE_TEST_PACKAGED=1 uses the unpacked Linux app.
 * Isolated userData only. No SSH connection, provider account, or inference.
 * Timer observations have no machine-dependent pass/fail latency threshold.
 */
const assert = require('node:assert/strict')
const { createHash } = require('node:crypto')
const { existsSync } = require('node:fs')
const { mkdir, mkdtemp, readFile, rm, writeFile } = require('node:fs/promises')
const { tmpdir } = require('node:os')
const { join, resolve } = require('node:path')
const { spawnSync } = require('node:child_process')
const esbuild = require('esbuild')
const { _electron: electron } = require('playwright')

const repository = resolve(__dirname, '..')
const artifacts = resolve(
  repository,
  process.env.LIFE_TEST_ARTIFACTS_DIR || 'output/playwright/conversation-load-electron',
)
const helperOnly = process.argv.includes('--build-helper-only')
const requiresRawPreservation = process.env.LIFE_TEST_EXPECT_RAW_PRESERVATION === '1'
const expectsMessageFields =
  requiresRawPreservation || process.env.LIFE_TEST_EXPECT_MESSAGE_FIELDS === '1'
const matchedLargeRawHash = 'eeabf62518330c2f1e7b43eb10c620e3f61c87bbbafec2cff6ee808911c2fbde'
const matchedDisplayHash = 'b503d433dc3488bd1ad07ca620eb81d3720bb0fceae57892eedb7c865b12dbf9'
const matchedMissingTurnRawHash = '20f4b24866b3000fac3bdaf883cf1c8ca7da9e54086af172fc86186ae3818852'

if (!helperOnly && process.platform === 'linux' && !process.env.DISPLAY) {
  assert.equal(
    spawnSync('xvfb-run', ['--help'], { stdio: 'ignore' }).status,
    0,
    'Conversation loading smoke requires DISPLAY or xvfb-run.',
  )
  const child = spawnSync(
    'xvfb-run',
    ['-a', '-s', '-screen 0 1440x960x24', process.execPath, __filename, ...process.argv.slice(2)],
    { cwd: repository, env: process.env, stdio: 'inherit' },
  )
  process.exit(child.status ?? 1)
}

const rendererHelper = String.raw`
import HistoryWorker from './src/renderer/conversation-load-worker?worker&inline'
import { decodeConversationHistory } from './src/renderer/conversation-load'
import { nativeCheckpointConversationThreads, normalizedConversationThreads } from './src/renderer/conversation-load-protocol'
import { createHistorySnapshotProjector } from './src/renderer/conversation-checkpoint-client'
import { reconcileConversationHistory } from './src/renderer/conversation-persistence'
import { readThreads } from './src/renderer/state'

const api = window.relay.conversations
const project = createHistorySnapshotProjector()
const encoder = new TextEncoder()
const epoch = () => performance.timeOrigin + performance.now()
let threads = []
let savedAt = Date.now() + 10_000
let legacySnapshot
let decodedSnapshot
let normalThreads
let workerSequence = 0
const workers = []
const observedPackets = new Map()

function requireValue(value, message) {
  if (!value) throw new Error(message)
}

function exact(left, right, path = 'threads') {
  if (Object.is(left, right)) return
  requireValue(left && right && typeof left === 'object' && typeof right === 'object',
    'Exact history differs at ' + path)
  requireValue(Array.isArray(left) === Array.isArray(right), 'History shape differs at ' + path)
  const leftKeys = Object.keys(left).sort()
  const rightKeys = Object.keys(right).sort()
  requireValue(JSON.stringify(leftKeys) === JSON.stringify(rightKeys), 'History keys differ at ' + path)
  for (const key of leftKeys) exact(left[key], right[key], path + '.' + key)
}

function canonical(value) {
  if (Array.isArray(value)) return '[' + value.map(canonical).join(',') + ']'
  if (value && typeof value === 'object')
    return '{' + Object.keys(value).sort().map(key =>
      JSON.stringify(key) + ':' + canonical(value[key])).join(',') + '}'
  return JSON.stringify(value)
}

function displayCheckpoint(values) {
  // JSON includes only the normalized display properties. The production
  // projector intentionally restores its private durable source instead.
  return JSON.parse(JSON.stringify(values.map(thread => ({ ...thread, pending: [] }))))
}

function createWorker() {
  const worker = new HistoryWorker()
  const observation = {
    id: ++workerSequence, loadRequests: 0, transferredInputs: 0,
    acknowledgements: 0, packets: 0, chunks: 0, messages: 0, stringFragments: 0,
    maxMessagesPerChunk: 0, maxPacketCharacters: 0,
    terminationCount: 0, terminalPacket: '', completedBeforePromise: false,
  }
  workers.push(observation)
  observedPackets.set(observation.id, [])
  let waiting = false
  worker.addEventListener('message', ({ data }) => {
    requireValue(!waiting, 'The production decoder must wait for each chunk acknowledgement')
    observation.packets++
    observedPackets.get(observation.id).push(data)
    if (data.type === 'messages') {
      observation.chunks++
      observation.messages += data.messages.length
      observation.maxMessagesPerChunk = Math.max(
        observation.maxMessagesPerChunk, data.messages.length,
      )
    }
    if (data.type === 'string') observation.stringFragments++
    if (data.type === 'done' || data.type === 'error') observation.terminalPacket = data.type
    else waiting = true
  })
  const postMessage = worker.postMessage.bind(worker)
  worker.postMessage = (message, transfers) => {
    if (message.type === 'load') {
      observation.loadRequests++
      requireValue(message.buffer instanceof ArrayBuffer, 'Native encoded history must be an ArrayBuffer')
      requireValue(transfers?.includes(message.buffer), 'History bytes must transfer into the browser worker')
      postMessage(message, transfers)
      requireValue(message.buffer.byteLength === 0, 'Transfer must detach the renderer input buffer')
      observation.transferredInputs++
      return
    }
    if (message.type === 'ack') {
      requireValue(waiting, 'Each chunk acknowledgement must belong to one pending packet')
      waiting = false
      observation.acknowledgements++
    }
    return postMessage(message, transfers)
  }
  const terminate = worker.terminate.bind(worker)
  worker.terminate = () => {
    observation.terminationCount++
    return terminate()
  }
  return worker
}

window.lifeConversationLoadFixture = {
  inspectWorkers(ids) {
    return workers.filter(worker => ids.includes(worker.id)).map(worker => {
      for (const packet of observedPackets.get(worker.id) || []) {
        let serialized
        if (packet.strings?.length) {
          // The decoder reconstructs fragment destinations in place. Measure
          // their original empty wire slots after timing, without mutating the
          // completed snapshot or copying a packet in the measured callback.
          const slots = new WeakMap()
          const root = packet.type === 'messages' ? packet.messages : packet.thread
          for (const plan of packet.strings) {
            let parent = root
            for (const key of plan.path.slice(0, -1)) parent = parent[key]
            const keys = slots.get(parent) || new Set()
            keys.add(plan.path[plan.path.length - 1])
            slots.set(parent, keys)
          }
          serialized = JSON.stringify(packet, function(key, value) {
            return slots.get(this)?.has(key) ? '' : value
          })
        } else serialized = JSON.stringify(packet)
        worker.maxPacketCharacters = Math.max(worker.maxPacketCharacters, serialized.length)
      }
      observedPackets.delete(worker.id)
      return worker
    })
  },
  prepare() {
    // Matches the existing native checkpoint fixture, with a few small records
    // which distinguish exact recovery from restoration of stale live state.
    threads = Array.from({ length: 80 }, (_, threadIndex) => ({
      id: 'checkpoint-thread-' + threadIndex,
      profileId: 'isolated-fixture-machine',
      provider: threadIndex % 2 ? 'claude' : 'codex',
      workspace: '/fixture/workspace-' + threadIndex,
      remoteId: 'native-provider-session-' + threadIndex,
      title: 'Exact history ' + threadIndex,
      model: '', mode: 'default', busy: false, pending: [],
      updatedAt: 1_800_000_000_000 - threadIndex,
      turn: 399,
      messages: Array.from({ length: 400 }, (_, messageIndex) => ({
        id: 'checkpoint-message-' + threadIndex + '-' + messageIndex,
        role: messageIndex % 2 ? 'assistant' : 'user',
        text: '  Exact  prompt\r\n\tUnicode café e\u0301 漢字 🧪\n' + 'x'.repeat(1009),
        turn: messageIndex,
      })),
    }))
    threads[0] = {
      ...threads[0], busy: true, turnStatus: 'running',
      futureNativeMetadata: { exact: 'Future field\r\n🧪' },
      queue: [{ id: 'queued-exact', text: '  Keep queued input\r\n\t🧪  ', createdAt: 123, attachments: [], paused: false }],
      messages: threads[0].messages.map((message, index) => index === 0 ? {
        ...message, input: '  Native provider input\r\n\t café e\u0301 漢字 🧪  ',
        futureMessageMetadata: { nested: ['exact', 1, null] },
      } : index === 1 ? {
        ...message, role: 'tool', status: 'running', kind: 'subagent', agentId: 'stale-child',
      } : message),
    }
    const history = project(threads)
    return { threadCount: threads.length, messageCount: 32_000,
      payloadBytes: encoder.encode(JSON.stringify(history)).length }
  },
  async seed() { await api.save(project(threads), ++savedAt) },
  async measure(mode) {
    const firstWorker = workers.length
    const intervalMs = 4
    let previous = performance.now(), maxLagMs = 0, ticks = 0
    const timer = setInterval(() => {
      const now = performance.now()
      maxLagMs = Math.max(maxLagMs, Math.max(0, now - previous - intervalMs))
      previous = now
      ticks++
    }, intervalMs)
    const start = performance.now(), startEpoch = epoch()
    let invokeReturnMs, nativeElapsedMs, nativeResolvedEpoch, decodeElapsedMs, normalizedElapsedMs, encodedBytes
    try {
      if (mode === 'legacy') {
        const pending = api.load()
        invokeReturnMs = performance.now() - start
        legacySnapshot = await pending
        nativeElapsedMs = performance.now() - start
        nativeResolvedEpoch = epoch()
        const normalizedStart = performance.now()
        normalThreads = readThreads(legacySnapshot.threads)
        normalizedElapsedMs = performance.now() - normalizedStart
      } else {
        const pending = api.loadEncoded()
        invokeReturnMs = performance.now() - start
        const buffer = await pending
        nativeElapsedMs = performance.now() - start
        nativeResolvedEpoch = epoch()
        requireValue(buffer instanceof ArrayBuffer, 'The production preload must return history bytes')
        encodedBytes = buffer.byteLength
        const decodeStart = performance.now()
        const controller = new AbortController()
        const deadline = setTimeout(() => controller.abort(new Error('History decoder did not complete.')), 30_000)
        try { decodedSnapshot = await decodeConversationHistory(buffer, createWorker, controller.signal) }
        finally { clearTimeout(deadline) }
        decodeElapsedMs = performance.now() - decodeStart
        const observation = workers[workers.length - 1]
        observation.completedBeforePromise = observation.terminalPacket === 'done' && observation.terminationCount === 1
        const normalizedStart = performance.now()
        const normalized = normalizedConversationThreads(decodedSnapshot)
        requireValue(normalized === decodedSnapshot.threads, 'Completed decoder results must retain their private normalization marker')
        const reconciled = reconcileConversationHistory(decodedSnapshot, { threads: [] })
        requireValue(reconciled.length === normalized.length && reconciled.every((thread, index) => thread === normalized[index]),
          'Reconciliation must retain normalized records without a second full normalization')
        normalizedElapsedMs = performance.now() - normalizedStart
      }
      const elapsedMs = performance.now() - start
      await new Promise(done => setTimeout(done, intervalMs * 4))
      return { mode, startEpoch, nativeResolvedEpoch, invokeReturnMs, nativeElapsedMs,
        decodeElapsedMs, normalizedElapsedMs, elapsedMs, encodedBytes,
        rendererTimerMaxLagMs: maxLagMs, rendererTimerTicks: ticks, workers: workers.slice(firstWorker) }
    } finally { clearInterval(timer) }
  },
  async verify() {
    requireValue(legacySnapshot.savedAt === savedAt && decodedSnapshot.savedAt === savedAt,
      'Both native load paths must retain the durable checkpoint timestamp')
    exact(legacySnapshot.threads, project(threads))
    // Inspect the encoded representation only outside timed samples, before
    // normalization intentionally applies the renderer restoration policy.
    const encodedBuffer = await api.loadEncoded()
    const encodedNative = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(encodedBuffer))
    exact(encodedNative, legacySnapshot, 'native snapshot')
    exact(decodedSnapshot.threads, normalThreads)
    const nativeBaseline = nativeCheckpointConversationThreads(decodedSnapshot)
    if (nativeBaseline) exact(nativeBaseline, legacySnapshot.threads, 'native checkpoint baseline')
    const first = decodedSnapshot.threads[0]
    requireValue(first.queue[0].paused === true && first.queue[0].text === threads[0].queue[0].text,
      'Restored queued work must retain exact prompts and remain paused')
    requireValue(first.busy === false && first.pending.length === 0 && first.turnStatus === 'unknown',
      'Restored history cannot establish live native activity')
    requireValue(first.messages[1].status === 'interrupted' && first.messages[1].activityStateUnknown === true,
      'Child tool activity must retain the legacy restoration policy')
    for (let index = 0; index < threads.length; index++) {
      const actual = decodedSnapshot.threads[index]
      requireValue(actual.profileId === threads[index].profileId && actual.workspace === threads[index].workspace &&
        actual.remoteId === threads[index].remoteId && actual.provider === threads[index].provider,
        'Native session identity or workspace ownership differs')
      for (let message = 0; message < threads[index].messages.length; message++) {
        requireValue(actual.messages[message].text === threads[index].messages[message].text &&
          actual.messages[message].input === threads[index].messages[message].input,
          'Prompt or provider input differs')
      }
    }
    const digest = await crypto.subtle.digest('SHA-256', encoder.encode(canonical(legacySnapshot.threads)))
    return { savedAt, threadCount: first ? decodedSnapshot.threads.length : 0,
      messageCount: decodedSnapshot.threads.reduce((count, thread) => count + thread.messages.length, 0),
      exactNativeHistorySha256: Array.from(new Uint8Array(digest), byte => byte.toString(16).padStart(2, '0')).join(''),
      encodedNativeMatchesLegacy: true,
      normalizedMatchesLegacy: true, reconciliationRetainsNormalizedRecords: true,
      nativeCheckpointBaselineRecovered: Boolean(nativeBaseline),
      queuedPromptPaused: first.queue[0].paused, restoredTurnStatus: first.turnStatus,
      providerSessionIdentityPreserved: true, workspaceOwnershipPreserved: true,
      exactPrompt: first.messages[0].text, exactProviderInput: first.messages[0].input }
  },
  async prepareLongMessage() {
    const first = threads[0]
    const prefix = '  Large exact prompt\r\n\tUnicode café e\u0301 漢字 🧪\r\n'
    // Put an emoji surrogate pair across the 64 KiB fragment boundary.
    const text = prefix + 'x'.repeat(64 * 1024 - 1 - prefix.length) + '🧪' +
      'x'.repeat(8 * 1024 * 1024 - 64 * 1024)
    threads = [{ ...first, messages: [{ ...first.messages[0], text }, ...first.messages.slice(1)] }, ...threads.slice(1)]
    await api.save(project(threads), ++savedAt)
    return { characters: text.length, bytes: encoder.encode(text).length }
  },
  async lifecycleFailure(mode) {
    const firstWorker = workers.length
    const controller = new AbortController()
    const buffer = mode === 'abort' ? await api.loadEncoded() : encoder.encode('{invalid history').buffer
    let rejection
    try {
      await decodeConversationHistory(buffer, () => {
        const worker = createWorker()
        if (mode === 'abort')
          worker.addEventListener('message', () => controller.abort(), { once: true })
        return worker
      }, controller.signal)
    } catch (error) {
      rejection = { name: error.name, message: error.message }
    }
    requireValue(rejection, 'Failed or cancelled parsing must never admit partial history')
    const observation = this.inspectWorkers([workers[firstWorker].id])[0]
    requireValue(observation.terminationCount === 1, 'A failed or cancelled decoder must release its browser worker')
    return { mode, rejection, worker: observation, partialHistoryAdmitted: false }
  },
  async expectedNormalizedCheckpoint() {
    const canonicalThreads = displayCheckpoint(decodedSnapshot.threads)
    const digest = await crypto.subtle.digest('SHA-256', encoder.encode(canonical(canonicalThreads)))
    return { savedAt: decodedSnapshot.savedAt,
      exactHistorySha256: Array.from(new Uint8Array(digest), byte => byte.toString(16).padStart(2, '0')).join(''),
      threadCount: canonicalThreads.length,
      messageCount: canonicalThreads.reduce((total, thread) => total + thread.messages.length, 0),
    }
  },
  async prepareStableNormalizedCheckpoint() {
    const native = await api.load()
    let normalized = native.threads
    let serialized = canonical(normalized)
    let normalizationPasses = 0
    let changed = false
    for (; normalizationPasses < 5; normalizationPasses++) {
      const next = displayCheckpoint(readThreads(normalized))
      const candidate = canonical(next)
      normalized = next
      if (candidate === serialized) break
      changed = true
      serialized = candidate
    }
    requireValue(normalizationPasses < 5, 'The fixture normalization must reach a stable checkpoint')
    const timestamp = changed ? Math.max(Date.now(), native.savedAt + 1) : native.savedAt
    if (changed) await api.save(normalized, timestamp)
    const digest = await crypto.subtle.digest('SHA-256', encoder.encode(canonical(normalized)))
    return { savedAt: timestamp, normalizationPasses: normalizationPasses + 1,
      externalFixtureSaveRequired: changed,
      exactHistorySha256: Array.from(new Uint8Array(digest), byte => byte.toString(16).padStart(2, '0')).join(''),
      threadCount: normalized.length,
      messageCount: normalized.reduce((total, thread) => total + thread.messages.length, 0),
    }
  },
  async prepareMissingTurnCheckpoint() {
    const native = await api.load()
    requireValue(native?.threads[0]?.messages[0]?.text.length >= 8 * 1024 * 1024,
      'The missing-turn checkpoint must retain the eight-megabyte native message')
    // Prepare the same canonical fixture on both revisions. This explicit test
    // preparation is separate from the application's lossless admission path.
    let canonicalThreads = displayCheckpoint(readThreads(native.threads))
    let serialized = canonical(canonicalThreads)
    let normalizationPasses = 1
    for (; normalizationPasses < 5; normalizationPasses++) {
      const next = displayCheckpoint(readThreads(canonicalThreads))
      const candidate = canonical(next)
      canonicalThreads = next
      if (candidate === serialized) break
      serialized = candidate
    }
    requireValue(normalizationPasses < 5, 'The missing-turn fixture must reach a stable display projection')
    const first = canonicalThreads[0]
    const { turn: previousTurn, ...message } = first.messages[0]
    requireValue(!Object.hasOwn(message, 'turn'), 'Legacy turn must be absent on the wire')
    const raw = [{ ...first, messages: [message, ...first.messages.slice(1)] }, ...canonicalThreads.slice(1)]
    const timestamp = Math.max(Date.now(), native.savedAt + 1)
    await api.save(raw, timestamp)
    const normalized = displayCheckpoint(readThreads(raw))
    requireValue(normalized[0].messages[0].turn === 0 &&
      normalized[0].messages[0].text === message.text &&
      normalized[0].messages[0].input === message.input,
      'Missing-turn restoration must preserve exact text and native provider input')
    const digest = await crypto.subtle.digest('SHA-256', encoder.encode(canonical(normalized)))
    const rawDigest = await crypto.subtle.digest('SHA-256', encoder.encode(canonical(raw)))
    const hex = buffer => Array.from(new Uint8Array(buffer), byte => byte.toString(16).padStart(2, '0')).join('')
    return { savedAt: timestamp, exactHistorySha256: hex(digest),
      exactRawHistorySha256: hex(rawDigest), threadCount: normalized.length,
      messageCount: normalized.reduce((total, thread) => total + thread.messages.length, 0),
      messageId: message.id, messageCharacters: message.text.length,
      previousTurn, restoredTurn: normalized[0].messages[0].turn,
      fixtureDisplayNormalizationPrepared: true, normalizationPasses: normalizationPasses + 1,
      rawMessageOwnsTurn: Object.hasOwn(message, 'turn'), exactTextAndProviderInput: true }
  },
  async verifyMissingTurnRestoration(expected) {
    const controller = new AbortController()
    const deadline = setTimeout(() => controller.abort(new Error('Missing-turn decoder did not complete.')), 30_000)
    let snapshot
    try { snapshot = await decodeConversationHistory(await api.loadEncoded(), createWorker, controller.signal) }
    finally { clearTimeout(deadline) }
    const normalized = normalizedConversationThreads(snapshot)
    const native = nativeCheckpointConversationThreads(snapshot)
    requireValue(normalized && native, 'Complete missing-turn loads must retain both display and durable source projections')
    const rawMessage = native[0].messages[0]
    const restoredMessage = normalized[0].messages[0]
    requireValue(rawMessage.id === expected.messageId && !Object.hasOwn(rawMessage, 'turn') &&
      restoredMessage.turn === 0 && restoredMessage.text === rawMessage.text &&
      restoredMessage.input === rawMessage.input,
      'Missing-turn decoding must retain the raw property absence and exact normalized display')
    const rawDigest = await crypto.subtle.digest('SHA-256', encoder.encode(canonical(native)))
    const normalizedDigest = await crypto.subtle.digest('SHA-256', encoder.encode(canonical(displayCheckpoint(normalized))))
    const hex = buffer => Array.from(new Uint8Array(buffer), byte => byte.toString(16).padStart(2, '0')).join('')
    return { savedAt: snapshot.savedAt, exactRawHistorySha256: hex(rawDigest),
      exactDisplayHistorySha256: hex(normalizedDigest), rawMessageOwnsTurn: false,
      restoredTurn: restoredMessage.turn, exactTextAndProviderInput: true,
      worker: this.inspectWorkers([workers[workers.length - 1].id])[0] }
  },
}
`

function canonical(value) {
  if (Array.isArray(value)) return '[' + value.map(canonical).join(',') + ']'
  if (value && typeof value === 'object')
    return (
      '{' +
      Object.keys(value)
        .sort()
        .map((key) => JSON.stringify(key) + ':' + canonical(value[key]))
        .join(',') +
      '}'
    )
  return JSON.stringify(value)
}

async function buildHelper() {
  await mkdir(artifacts, { recursive: true })
  const pluginPath = join(artifacts, 'inline-worker-plugin.cjs')
  await esbuild.build({
    entryPoints: [join(repository, 'src/main/inline-worker-plugin.ts')],
    outfile: pluginPath,
    bundle: true,
    platform: 'node',
    format: 'cjs',
    target: 'node22',
    logLevel: 'silent',
  })
  delete require.cache[pluginPath]
  const { inlineWorkerPlugin } = require(pluginPath)
  const helperPath = join(artifacts, 'conversation-load-renderer-fixture.js')
  await esbuild.build({
    stdin: {
      contents: rendererHelper,
      resolveDir: repository,
      sourcefile: 'conversation-load-renderer-fixture.ts',
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
  return helperPath
}

async function installMainProbe(application) {
  await application.evaluate(({ ipcMain }) => {
    const { Worker } = process.getBuiltinModule('node:worker_threads')
    const epoch = () => performance.timeOrigin + performance.now()
    const originalPostMessage = Worker.prototype.postMessage
    const originalEmit = Worker.prototype.emit
    const probe = {
      intervalMs: 4,
      previous: performance.now(),
      ticks: 0,
      maxLagMs: 0,
      events: [],
      requests: new Map(),
    }
    Worker.prototype.postMessage = function (message, ...args) {
      if (!['load', 'loadEncoded', 'save', 'checkpoint'].includes(message?.command?.type))
        return Reflect.apply(originalPostMessage, this, [message, ...args])
      const record = {
        workerThreadId: this.threadId,
        requestId: message.id,
        command: message.command.type,
        workerRequestEpoch: epoch(),
      }
      probe.requests.set(this.threadId + ':' + message.id, record)
      probe.events.push(record)
      const start = performance.now()
      const result = Reflect.apply(originalPostMessage, this, [message, ...args])
      record.workerRequestReturnMs = performance.now() - start
      return result
    }
    Worker.prototype.emit = function (name, ...args) {
      if (name !== 'message') return Reflect.apply(originalEmit, this, [name, ...args])
      const record = probe.requests.get(this.threadId + ':' + args[0]?.id)
      if (!record) return Reflect.apply(originalEmit, this, [name, ...args])
      record.mainWorkerResponseEpoch = epoch()
      record.workerRoundtripMs = record.mainWorkerResponseEpoch - record.workerRequestEpoch
      const start = performance.now()
      try {
        return Reflect.apply(originalEmit, this, [name, ...args])
      } finally {
        record.mainWorkerListenersMs = performance.now() - start
      }
    }
    for (const channel of [
      'conversations:load',
      'conversations:loadEncoded',
      'conversations:save',
      'conversations:checkpoint',
    ]) {
      const handler = ipcMain._invokeHandlers.get(channel)
      if (!handler) throw new Error('Production history load IPC handler missing: ' + channel)
      ipcMain.removeHandler(channel)
      ipcMain.handle(channel, async (...args) => {
        const event = { channel, mainHandlerStartEpoch: epoch() }
        if (channel === 'conversations:save' || channel === 'conversations:checkpoint') {
          const payload = args[1]
          const checkpoint = channel === 'conversations:checkpoint'
          Object.assign(event, {
            write: true,
            kind: checkpoint ? 'checkpoint' : 'save',
            savedAt: checkpoint ? payload.savedAt : args[2],
            baseSavedAt: checkpoint ? payload.baseSavedAt : undefined,
            // Inspect this retained payload after timer observations finish. The
            // real native handler owns all execution and acknowledgement.
            payload,
          })
        }
        probe.events.push(event)
        try {
          const result = await handler(...args)
          event.mainHandlerResolvedEpoch = epoch()
          event.mainHandlerElapsedMs = event.mainHandlerResolvedEpoch - event.mainHandlerStartEpoch
          if (event.write) {
            event.accepted = true
            if (event.kind === 'checkpoint') event.acknowledgedSavedAt = result?.savedAt
          }
          return result
        } catch (error) {
          if (event.write) event.error = String(error)
          throw error
        }
      })
    }
    probe.timer = setInterval(() => {
      const now = performance.now()
      probe.maxLagMs = Math.max(
        probe.maxLagMs,
        Math.max(0, now - probe.previous - probe.intervalMs),
      )
      probe.previous = now
      probe.ticks++
    }, probe.intervalMs)
    globalThis.__lifeConversationLoadProbe = probe
  })
}

async function run() {
  const helperPath = await buildHelper()
  if (helperOnly) {
    console.log('Conversation loading renderer helper built: ' + helperPath)
    return
  }
  const metadata = JSON.parse(await readFile(join(repository, 'package.json'), 'utf8'))
  const packagedBinary =
    process.platform === 'linux'
      ? join(
          repository,
          'release/linux-unpacked',
          metadata.build?.linux?.executableName || metadata.name,
        )
      : undefined
  const wantsPackaged =
    process.env.LIFE_TEST_PACKAGED === '1' || process.env.LIFE_TEST_SOURCE === '0'
  const selectedBinary =
    process.env.LIFE_ELECTRON_BINARY || (wantsPackaged ? packagedBinary : undefined)
  if (wantsPackaged)
    assert.ok(
      selectedBinary && existsSync(selectedBinary),
      'Build the unpacked Electron package first.',
    )
  if (!selectedBinary)
    assert.ok(existsSync(join(repository, 'out/main/index.js')), 'Run npm run build first.')
  const configurationRoot = await mkdtemp(join(tmpdir(), 'life-conversation-load-'))
  const rendererErrors = []
  const nativeLogs = []
  const phases = []
  let application
  let launchProof
  let phase = 'launch'
  const progressTimer = setInterval(
    () => console.log('Conversation load Electron phase: ' + phase),
    30_000,
  )
  try {
    application = await electron.launch({
      executablePath: selectedBinary || require('electron'),
      args: [
        ...(selectedBinary ? [] : [repository]),
        ...(process.platform === 'linux' ? ['--no-sandbox'] : []),
        '--disable-dev-shm-usage',
        `--user-data-dir=${join(configurationRoot, 'chromium')}`,
      ],
      cwd: repository,
      env: {
        ...process.env,
        ELECTRON_RENDERER_URL: '',
        XDG_CONFIG_HOME: configurationRoot,
        LIFE_TEST_CONFIG_HOME: configurationRoot,
        ...(process.platform === 'win32' ? { APPDATA: configurationRoot } : {}),
      },
      timeout: 30_000,
    })
    for (const stream of ['stdout', 'stderr'])
      application.process()[stream]?.on('data', (chunk) => {
        nativeLogs.push({ stream, text: String(chunk).slice(-8000) })
        if (nativeLogs.length > 20) nativeLogs.shift()
      })
    const page = await application.firstWindow()
    page.setDefaultTimeout(30_000)
    page.on('pageerror', (error) => rendererErrors.push(error.message))
    await page.locator('.app-shell').waitFor()
    await page.waitForFunction(() => typeof window.relay?.conversations?.loadEncoded === 'function')
    launchProof = await application.evaluate(({ app, BrowserWindow }) => {
      const fs = process.getBuiltinModule('node:fs'),
        path = process.getBuiltinModule('node:path')
      const workerSource = path.join(app.getAppPath(), 'out/main/conversation-checkpoint-worker.js')
      return {
        version: app.getVersion(),
        packaged: app.isPackaged,
        appPath: app.getAppPath(),
        userData: app.getPath('userData'),
        workerSource,
        embeddedWorkerExists: fs.existsSync(workerSource),
        unpackedWorkerExists:
          app.isPackaged &&
          fs.existsSync(workerSource.replace(/\.asar([/\\])/, '.asar.unpacked$1')),
        rendererSandboxed:
          BrowserWindow.getAllWindows()[0].webContents.getLastWebPreferences().sandbox,
      }
    })
    assert.ok(
      launchProof.userData.startsWith(configurationRoot),
      'History must use isolated userData.',
    )
    assert.equal(launchProof.version, metadata.version)
    assert.equal(launchProof.rendererSandboxed, true)
    assert.equal(launchProof.embeddedWorkerExists, true)
    if (wantsPackaged) {
      assert.equal(launchProof.packaged, true)
      assert.match(launchProof.appPath, /\.asar$/)
      assert.equal(
        launchProof.unpackedWorkerExists,
        false,
        'Exercise the history writer embedded in ASAR.',
      )
    }
    assert.equal(await page.evaluate(() => typeof window.require), 'undefined')
    phase = 'settle-empty-startup'
    await page.waitForTimeout(2500)
    const initial = await page.evaluate(() => window.relay.conversations.load())
    assert.ok(initial === null || initial.threads.length === 0)
    await page.evaluate(await readFile(helperPath, 'utf8'))
    const fixturePayload = await page.evaluate(() => window.lifeConversationLoadFixture.prepare())
    assert.equal(fixturePayload.threadCount, 80)
    assert.equal(fixturePayload.messageCount, 32_000)
    assert.ok(fixturePayload.payloadBytes > 32 * 1024 * 1024)
    phase = 'seed-35mb-native-history'
    await page.evaluate(() => window.lifeConversationLoadFixture.seed())
    await page.waitForTimeout(200)
    await installMainProbe(application)

    const measure = async (label, mode) => {
      phase = label
      await application.evaluate(() => {
        const probe = globalThis.__lifeConversationLoadProbe
        probe.previous = performance.now()
        probe.ticks = 0
        probe.maxLagMs = 0
        probe.events = []
        probe.requests.clear()
      })
      const renderer = await page.evaluate(
        (mode) => window.lifeConversationLoadFixture.measure(mode),
        mode,
      )
      const main = await application.evaluate(() => {
        const probe = globalThis.__lifeConversationLoadProbe
        return {
          mainTimerMaxLagMs: probe.maxLagMs,
          mainTimerTicks: probe.ticks,
          events: probe.events,
        }
      })
      renderer.workers = await page.evaluate(
        (ids) => window.lifeConversationLoadFixture.inspectWorkers(ids),
        renderer.workers.map((worker) => worker.id),
      )
      assert.ok(renderer.rendererTimerTicks > 0)
      assert.ok(main.mainTimerTicks > 0)
      assert.ok(
        Number.isFinite(renderer.rendererTimerMaxLagMs) && Number.isFinite(main.mainTimerMaxLagMs),
      )
      if (mode === 'encoded') {
        assert.equal(renderer.workers.length, 1, 'Each complete load owns one browser worker.')
        const worker = renderer.workers[0]
        assert.equal(worker.loadRequests, 1)
        assert.equal(worker.transferredInputs, 1)
        assert.equal(worker.terminationCount, 1)
        assert.equal(worker.terminalPacket, 'done')
        assert.equal(
          worker.completedBeforePromise,
          true,
          'Only complete staged snapshots are admitted.',
        )
        assert.equal(worker.acknowledgements, worker.packets - 1)
        assert.ok(worker.maxMessagesPerChunk <= 256)
        assert.ok(
          worker.maxPacketCharacters <= 256 * 1024,
          'Large scalar strings must travel in bounded fragments instead of one giant packet.',
        )
      } else assert.equal(renderer.workers.length, 0)
      const handler = main.events.find((event) => event.mainHandlerResolvedEpoch)
      const result = {
        label,
        ...renderer,
        ...main,
        mainResolvedToRendererLoadedMs:
          renderer.nativeResolvedEpoch - handler.mainHandlerResolvedEpoch,
        rendererInvokeToMainHandlerMs: handler.mainHandlerStartEpoch - renderer.startEpoch,
      }
      phases.push(result)
      await page.waitForTimeout(120)
      return result
    }
    for (let index = 0; index < 3; index++) {
      await measure('legacy-load-' + index, 'legacy')
      await measure('encoded-load-' + index, 'encoded')
    }
    phase = 'verify-exact-normalized-native-history'
    const recovery = await page.evaluate(() => window.lifeConversationLoadFixture.verify())
    const diskBytes = await readFile(join(launchProof.userData, 'conversations.json'))
    const disk = JSON.parse(diskBytes.toString('utf8'))
    assert.equal(disk.savedAt, recovery.savedAt)
    assert.equal(
      createHash('sha256').update(canonical(disk.threads)).digest('hex'),
      recovery.exactNativeHistorySha256,
    )
    assert.equal(recovery.threadCount, 80)
    assert.equal(recovery.messageCount, 32_000)
    assert.match(recovery.exactPrompt, /\r\n\tUnicode café e\u0301 漢字 🧪\n/)
    assert.match(recovery.exactProviderInput, /\r\n\t café e\u0301 漢字 🧪  $/)

    phase = 'real-browser-worker-failure-lifecycle'
    const cancelledDecoder = await page.evaluate(() =>
      window.lifeConversationLoadFixture.lifecycleFailure('abort'),
    )
    assert.equal(cancelledDecoder.rejection.name, 'AbortError')
    assert.equal(cancelledDecoder.worker.terminalPacket, '')
    const invalidDecoder = await page.evaluate(() =>
      window.lifeConversationLoadFixture.lifecycleFailure('invalid'),
    )
    assert.equal(invalidDecoder.worker.terminalPacket, 'error')
    assert.equal(invalidDecoder.worker.acknowledgements, 0)

    phase = 'seed-large-single-message'
    const largeMessage = await page.evaluate(() =>
      window.lifeConversationLoadFixture.prepareLongMessage(),
    )
    await measure('large-message-legacy', 'legacy')
    const largeMessageLoad = await measure('large-message-encoded', 'encoded')
    phase = 'verify-large-message-exact-recovery'
    const largeMessageRecovery = await page.evaluate(() =>
      window.lifeConversationLoadFixture.verify(),
    )
    assert.equal(
      largeMessageRecovery.exactNativeHistorySha256,
      matchedLargeRawHash,
      'Both revisions must load the same exact raw large-message fixture.',
    )
    const largeDisk = JSON.parse(
      await readFile(join(launchProof.userData, 'conversations.json'), 'utf8'),
    )
    assert.equal(
      createHash('sha256').update(canonical(largeDisk.threads)).digest('hex'),
      largeMessageRecovery.exactNativeHistorySha256,
    )
    assert.ok(largeMessageLoad.workers[0].terminationCount === 1)
    assert.ok(
      largeMessageLoad.workers[0].stringFragments > 128,
      'A single eight-megabyte message must be fragmented without losing its contents.',
    )

    // Reload the actual application, then observe its production decoder and
    // admission gate. Fixture data is never inserted into React state directly.
    const expectedNormalized = await page.evaluate(() =>
      window.lifeConversationLoadFixture.expectedNormalizedCheckpoint(),
    )
    assert.equal(
      expectedNormalized.exactHistorySha256,
      matchedDisplayHash,
      'The normalized display must retain the matched baseline restoration policy.',
    )
    phase = 'actual-application-history-admission'
    await page.addInitScript(() => {
      const OriginalWorker = window.Worker
      const historyWorkers = new WeakSet()
      const proof = {
        created: 0,
        totalWorkersCreated: 0,
        loadRequests: 0,
        completed: 0,
        terminated: 0,
        seenLoadingGate: false,
        startEpoch: performance.timeOrigin + performance.now(),
        rendererTimerTicks: 0,
        rendererTimerMaxLagMs: 0,
      }
      let previous = performance.now()
      proof.timer = setInterval(() => {
        const now = performance.now()
        proof.rendererTimerMaxLagMs = Math.max(
          proof.rendererTimerMaxLagMs,
          Math.max(0, now - previous - 4),
        )
        previous = now
        proof.rendererTimerTicks++
      }, 4)
      window.__lifeConversationLoadStartup = proof
      window.Worker = class extends OriginalWorker {
        constructor(...args) {
          super(...args)
          proof.totalWorkersCreated++
          this.addEventListener('message', ({ data }) => {
            if (historyWorkers.has(this) && data?.type === 'done') proof.completed++
          })
        }
        postMessage(message, ...args) {
          if (message?.type === 'load' && message.buffer instanceof ArrayBuffer) {
            if (!historyWorkers.has(this)) {
              historyWorkers.add(this)
              proof.created++
            }
            proof.loadRequests++
          }
          return super.postMessage(message, ...args)
        }
        terminate() {
          if (historyWorkers.has(this)) proof.terminated++
          return super.terminate()
        }
      }
      const observe = () => {
        const body = document.querySelector('.app-body')
        if (body?.hasAttribute('inert') || body?.getAttribute('aria-busy') === 'true')
          proof.seenLoadingGate = true
        else if (body && proof.readyEpoch === undefined)
          proof.readyEpoch = performance.timeOrigin + performance.now()
      }
      new MutationObserver(observe).observe(document, {
        childList: true,
        subtree: true,
        attributes: true,
        attributeFilter: ['inert', 'aria-busy'],
      })
      observe()
    })
    const messageFieldsSupported = await page.evaluate(
      () => window.relay.conversations.supportsMessageFields === true,
    )
    if (expectsMessageFields)
      assert.equal(
        messageFieldsSupported,
        true,
        'The candidate preload must advertise native message-field checkpoint support.',
      )
    const expectsRawPreservation =
      requiresRawPreservation ||
      (process.env.LIFE_TEST_EXPECT_RAW_PRESERVATION !== '0' && messageFieldsSupported)
    const measureAppReload = async (label, expected, checkpointExpectation) => {
      phase = label
      await application.evaluate(() => {
        const probe = globalThis.__lifeConversationLoadProbe
        probe.previous = performance.now()
        probe.ticks = 0
        probe.maxLagMs = 0
        probe.events = []
        probe.requests.clear()
      })
      await page.reload()
      await page.locator('.app-shell').waitFor()
      await page.waitForFunction(() => {
        const body = document.querySelector('.app-body')
        return body && !body.hasAttribute('inert') && body.getAttribute('aria-busy') === 'false'
      })
      await application.evaluate(
        () =>
          new Promise((resolve, reject) => {
            const probe = globalThis.__lifeConversationLoadProbe
            const deadline = setTimeout(() => {
              clearInterval(timer)
              reject(
                new Error(
                  'The application did not acknowledge its first automatic native history checkpoint.',
                ),
              )
            }, 30_000)
            const timer = setInterval(() => {
              if (!probe.events.some((event) => event.write && event.accepted)) return
              clearTimeout(deadline)
              clearInterval(timer)
              resolve(undefined)
            }, 10)
          }),
      )
      await page.waitForTimeout(20)
      const renderer = await page.evaluate(() => {
        const { timer, ...proof } = window.__lifeConversationLoadStartup
        clearInterval(timer)
        return {
          ...proof,
          historyErrorShown: [...document.querySelectorAll('button')].some(
            (button) => button.textContent?.trim() === 'Retry loading',
          ),
        }
      })
      const main = await application.evaluate(() => {
        const probe = globalThis.__lifeConversationLoadProbe
        return { mainTimerMaxLagMs: probe.maxLagMs, mainTimerTicks: probe.ticks }
      })
      // Payload inspection and sizing happen after both timer observations have
      // been captured. Counters never stringify historical bodies while timing.
      const writes = await application.evaluate(() => {
        const probe = globalThis.__lifeConversationLoadProbe
        return probe.events
          .filter((event) => event.write)
          .map(({ payload, ...event }) => {
            const checkpoint = event.kind === 'checkpoint'
            const deltas = checkpoint ? payload.upserts.map((update) => update.messages) : []
            const messageUpserts = checkpoint
              ? deltas.flatMap((delta) => (delta.mode === 'patch' ? delta.upserts : delta.values))
              : payload.flatMap((thread) => thread.messages)
            const fields = deltas.flatMap((delta) =>
              delta.mode === 'patch' ? delta.fields || [] : [],
            )
            const messageFieldChanges = fields.map((field) => ({
              id: field.id,
              setKeys: Object.keys(field.set || {}).sort(),
              removeKeys: [...(field.remove || [])].sort(),
            }))
            return {
              ...event,
              threadCount: checkpoint ? payload.order.length : payload.length,
              changedThreads: checkpoint ? payload.upserts.length : payload.length,
              changedMessages: messageUpserts.length + fields.length,
              changedMessageUpserts: messageUpserts.length,
              changedMessageFields: fields.length,
              changedMessageProperties: messageFieldChanges.reduce(
                (total, field) => total + field.setKeys.length + field.removeKeys.length,
                0,
              ),
              messageSetKeys: [
                ...new Set(messageFieldChanges.flatMap((field) => field.setKeys)),
              ].sort(),
              messageRemovedKeys: [
                ...new Set(messageFieldChanges.flatMap((field) => field.removeKeys)),
              ].sort(),
              // Small-field cases retain their exact IDs/keys. The 32,000-message
              // raw normalization is represented by aggregate property counts.
              messageFieldChanges: fields.length <= 8 ? messageFieldChanges : undefined,
              messageTextProperties:
                messageUpserts.reduce(
                  (total, message) =>
                    total +
                    Number(Object.hasOwn(message, 'text')) +
                    Number(Object.hasOwn(message, 'input')),
                  0,
                ) +
                fields.reduce(
                  (total, field) =>
                    total +
                    Number(Object.hasOwn(field.set || {}, 'text')) +
                    Number(Object.hasOwn(field.set || {}, 'input')),
                  0,
                ),
              includesMessageOrder: checkpoint && deltas.some((delta) => delta.order !== undefined),
              payloadBytes: Buffer.byteLength(JSON.stringify(payload), 'utf8'),
            }
          })
      })
      const firstAccepted = writes.find((write) => write.accepted)
      assert.ok(firstAccepted)
      assert.equal(
        writes[0],
        firstAccepted,
        'The first native write must be acknowledged without a rejected-base recovery.',
      )
      assert.ok(
        writes.every((write) => !write.error),
        'Restoration must not hide a rejected native checkpoint behind a full save.',
      )
      assert.equal(
        renderer.loadRequests,
        1,
        'StrictMode replay must share one native decoding request.',
      )
      assert.equal(renderer.completed, 1)
      assert.equal(renderer.terminated, 1)
      assert.equal(renderer.created, 1)
      assert.equal(
        renderer.seenLoadingGate,
        true,
        'The application stays inert until complete history is admitted.',
      )
      assert.equal(renderer.historyErrorShown, false)
      assert.ok(
        firstAccepted.mainHandlerStartEpoch >= renderer.readyEpoch,
        'Automatic persistence must wait until hydration has admitted the complete history.',
      )
      if (checkpointExpectation) {
        assert.equal(
          firstAccepted.kind,
          'checkpoint',
          'An admitted native baseline must begin with an exact checkpoint.',
        )
        assert.equal(firstAccepted.baseSavedAt, expected.savedAt)
        assert.equal(firstAccepted.acknowledgedSavedAt, firstAccepted.savedAt)
        assert.equal(firstAccepted.changedMessageUpserts, 0)
        assert.equal(
          firstAccepted.messageTextProperties,
          0,
          'Unchanged prompt and provider input must not cross checkpoint IPC.',
        )
        assert.equal(firstAccepted.includesMessageOrder, false)
        if (checkpointExpectation === 'unchanged' || checkpointExpectation === 'raw-preserved') {
          assert.equal(firstAccepted.changedThreads, 0)
          assert.equal(firstAccepted.changedMessages, 0)
          assert.ok(firstAccepted.payloadBytes < fixturePayload.payloadBytes / 1000)
        } else if (checkpointExpectation === 'missing-turn') {
          assert.equal(firstAccepted.changedMessageFields, 1)
          assert.equal(firstAccepted.changedMessageProperties, 1)
          assert.deepEqual(firstAccepted.messageFieldChanges, [
            {
              id: expected.messageId,
              setKeys: ['turn'],
              removeKeys: [],
            },
          ])
          assert.ok(firstAccepted.payloadBytes < fixturePayload.payloadBytes / 1000)
        } else {
          assert.ok(firstAccepted.changedMessageFields > 0)
          assert.ok(firstAccepted.changedMessageFields <= fixturePayload.messageCount)
          assert.ok(
            firstAccepted.payloadBytes < fixturePayload.payloadBytes / 10,
            'Raw restoration metadata must remain substantially smaller than full message bodies.',
          )
        }
      }
      const acknowledgedDisk = JSON.parse(
        await readFile(join(launchProof.userData, 'conversations.json'), 'utf8'),
      )
      const actualHash = createHash('sha256')
        .update(canonical(acknowledgedDisk.threads))
        .digest('hex')
      assert.equal(
        actualHash,
        expected.exactHistorySha256,
        'The first automatic native acknowledgement must preserve the expected durable history on disk.',
      )
      assert.equal(acknowledgedDisk.savedAt, firstAccepted.savedAt)
      assert.equal(acknowledgedDisk.threads.length, expected.threadCount)
      assert.equal(
        acknowledgedDisk.threads.reduce((total, thread) => total + thread.messages.length, 0),
        expected.messageCount,
      )
      return {
        label,
        ...renderer,
        ...main,
        writes,
        firstAccepted,
        disk: {
          savedAt: acknowledgedDisk.savedAt,
          exactHistorySha256: actualHash,
          threadCount: expected.threadCount,
          messageCount: expected.messageCount,
        },
      }
    }
    const expectedStartupDisk = expectsRawPreservation
      ? { ...expectedNormalized, exactHistorySha256: largeMessageRecovery.exactNativeHistorySha256 }
      : expectedNormalized
    const startup = await measureAppReload(
      'raw-history-first-automatic-save',
      expectedStartupDisk,
      expectsRawPreservation ? 'raw-preserved' : messageFieldsSupported ? 'raw' : undefined,
    )
    if (messageFieldsSupported) {
      assert.equal(recovery.nativeCheckpointBaselineRecovered, true)
      assert.equal(largeMessageRecovery.nativeCheckpointBaselineRecovered, true)
    }
    // Lossless admission can reload the same untouched durable source. Legacy
    // baseline runs retain their existing explicitly normalized fixture.
    const normalizedReloadBaseline = expectsRawPreservation
      ? {
          ...startup.disk,
          normalizationPasses: 0,
          externalFixtureSaveRequired: false,
          sameRawDurableHistory: true,
        }
      : await (async () => {
          await page.evaluate(await readFile(helperPath, 'utf8'))
          return page.evaluate(() =>
            window.lifeConversationLoadFixture.prepareStableNormalizedCheckpoint(),
          )
        })()
    const normalizedStartup = await measureAppReload(
      expectsRawPreservation
        ? 'same-raw-history-second-automatic-checkpoint'
        : 'normalized-history-first-automatic-checkpoint',
      normalizedReloadBaseline,
      'unchanged',
    )
    // Keep the original raw fixture and its hash unchanged. This separate raw
    // case makes a tiny restoration edit next to the eight-megabyte exact body.
    await page.evaluate(await readFile(helperPath, 'utf8'))
    const missingTurnBaseline = await page.evaluate(() =>
      window.lifeConversationLoadFixture.prepareMissingTurnCheckpoint(),
    )
    assert.equal(
      missingTurnBaseline.exactRawHistorySha256,
      matchedMissingTurnRawHash,
      'Both revisions must reload the same exact missing-turn fixture.',
    )
    const missingTurnRawDisk = JSON.parse(
      await readFile(join(launchProof.userData, 'conversations.json'), 'utf8'),
    )
    assert.equal(missingTurnBaseline.rawMessageOwnsTurn, false)
    assert.equal(Object.hasOwn(missingTurnRawDisk.threads[0].messages[0], 'turn'), false)
    assert.equal(missingTurnRawDisk.savedAt, missingTurnBaseline.savedAt)
    assert.equal(
      createHash('sha256').update(canonical(missingTurnRawDisk.threads)).digest('hex'),
      missingTurnBaseline.exactRawHistorySha256,
    )
    const missingTurnStartup = await measureAppReload(
      'large-message-missing-turn-first-automatic-save',
      expectsRawPreservation
        ? { ...missingTurnBaseline, exactHistorySha256: missingTurnBaseline.exactRawHistorySha256 }
        : missingTurnBaseline,
      expectsRawPreservation
        ? 'raw-preserved'
        : messageFieldsSupported
          ? 'missing-turn'
          : undefined,
    )
    let missingTurnRecovery
    if (expectsRawPreservation) {
      await page.evaluate(await readFile(helperPath, 'utf8'))
      missingTurnRecovery = await page.evaluate(
        (expected) => window.lifeConversationLoadFixture.verifyMissingTurnRestoration(expected),
        missingTurnBaseline,
      )
      assert.equal(missingTurnRecovery.savedAt, missingTurnStartup.disk.savedAt)
      assert.equal(
        missingTurnRecovery.exactRawHistorySha256,
        missingTurnBaseline.exactRawHistorySha256,
      )
      assert.equal(
        missingTurnRecovery.exactDisplayHistorySha256,
        missingTurnBaseline.exactHistorySha256,
      )
      assert.equal(missingTurnRecovery.worker.terminationCount, 1)
      assert.equal(missingTurnRecovery.worker.terminalPacket, 'done')
      assert.ok(missingTurnRecovery.worker.maxPacketCharacters <= 256 * 1024)
    }
    assert.equal(rendererErrors.length, 0, rendererErrors.join('\n'))
    const workerCommands = await application.evaluate(() => {
      const probe = globalThis.__lifeConversationLoadProbe
      clearInterval(probe.timer)
      return probe.events
        .filter((event) => event.command)
        .map((event) => ({ command: event.command, workerThreadId: event.workerThreadId }))
    })
    assert.ok(
      workerCommands.some(
        (command) => command.command === 'loadEncoded' && command.workerThreadId > 0,
      ),
    )
    const report = {
      fixture:
        '80 threads × 400 messages × approximately 1 KiB; production object load versus encoded native IPC plus owned browser parser',
      upstreamProvidersUsed: false,
      launchProof,
      fixturePayload,
      diskBytes: diskBytes.length,
      coldDiskReadMeasured: false,
      workerSnapshotState:
        'Warm after production save; actual application reload verified separately.',
      phases,
      decoderFailureLifecycle: { cancelled: cancelledDecoder, invalid: invalidDecoder },
      recovery,
      largeMessage,
      largeMessageRecovery: { ...largeMessageRecovery, exactPrompt: undefined },
      nativeCapabilities: { supportsMessageFields: messageFieldsSupported },
      expectedRawPreservation: expectsRawPreservation,
      expectedDisplayProjection: expectedNormalized,
      startup,
      normalizedReloadBaseline,
      normalizedStartup,
      missingTurnBaseline,
      missingTurnStartup,
      missingTurnRecovery,
      workerCommands,
      rendererErrors,
      measurements:
        'Native calls include real preload IPC serialization. Worker roundtrip includes native transfer/deserialization. Main-resolved-to-renderer includes Electron IPC and contextBridge work. Decoder packet callbacks retain private references and scalar counters; packet sizing happens after both timer observations finish, including original empty fragment slots. This replaces earlier candidate reports which sized packets during decode. Automatic-save payload inspection and sizing also occur after timer observations. Field patches count separately from full message upserts. The original raw fixture/hash remains unchanged; a separate raw missing-turn reload retains the eight-megabyte body. Timers sample 4 ms; no hardware-dependent latency threshold is asserted. Exact comparisons and hashes occur outside timed samples.',
    }
    await writeFile(
      join(artifacts, 'conversation-load-electron-report.json'),
      JSON.stringify(report, null, 2),
    )
    await writeFile(
      join(
        artifacts,
        launchProof.packaged
          ? 'conversation-load-electron-packaged-report.json'
          : 'conversation-load-electron-source-report.json',
      ),
      JSON.stringify(report, null, 2),
    )
    console.log(JSON.stringify(report, null, 2))
  } catch (error) {
    await writeFile(
      join(artifacts, 'conversation-load-electron-failure.json'),
      JSON.stringify(
        {
          phase,
          error: error.stack || String(error),
          launchProof,
          phases,
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
    await rm(configurationRoot, { recursive: true, force: true })
  }
}

run().catch((error) => {
  console.error(error)
  process.exitCode = 1
})
