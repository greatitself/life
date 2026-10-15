#!/usr/bin/env node
/*
 * Real Electron IPC and disk coverage for incremental conversation checkpoints.
 * Run after npm run build; LIFE_TEST_PACKAGED=1 requires the Linux unpacked app.
 * No SSH connection, provider account, or inference is used. The renderer helper
 * imports the production projectors/client and calls the production preload API.
 * Timer measurements are observations, not machine-dependent pass thresholds.
 */
const assert = require('node:assert/strict')
const { createHash } = require('node:crypto')
const { existsSync } = require('node:fs')
const { mkdir, mkdtemp, readFile, rm, writeFile } = require('node:fs/promises')
const { tmpdir } = require('node:os')
const { join, resolve } = require('node:path')
const { spawnSync } = require('node:child_process')
const { build } = require('esbuild')
const { _electron: electron } = require('playwright')

const repository = resolve(__dirname, '..')
const artifacts = resolve(
  repository,
  process.env.LIFE_TEST_ARTIFACTS_DIR || 'output/playwright/checkpoint-electron',
)
const helperOnly = process.argv.includes('--build-helper-only')

if (!helperOnly && process.platform === 'linux' && !process.env.DISPLAY) {
  assert.equal(
    spawnSync('xvfb-run', ['--help'], { stdio: 'ignore' }).status,
    0,
    'Native checkpoint smoke requires DISPLAY or xvfb-run.',
  )
  const child = spawnSync(
    'xvfb-run',
    ['-a', '-s', '-screen 0 1440x960x24', process.execPath, __filename, ...process.argv.slice(2)],
    { cwd: repository, env: process.env, stdio: 'inherit' },
  )
  process.exit(child.status ?? 1)
}

const rendererHelper = String.raw`
import {
  ConversationCheckpointClient,
  createHistorySnapshotProjector,
} from './src/renderer/conversation-checkpoint-client'

const api = window.relay.conversations
const client = new ConversationCheckpointClient()
const project = createHistorySnapshotProjector()
const encoder = new TextEncoder()
const records = []
let threads = []
let savedAt = Date.now() + 10_000
let completePayloadBytes = 0
let currentPhase = 'idle'

function requireValue(value, message) {
  if (!value) throw new Error(message)
}

function canonical(value) {
  if (Array.isArray(value)) return '[' + value.map(canonical).join(',') + ']'
  if (value && typeof value === 'object')
    return '{' + Object.keys(value).sort().map(key =>
      JSON.stringify(key) + ':' + canonical(value[key])).join(',') + '}'
  return JSON.stringify(value)
}

function exact(left, right, path = 'threads') {
  if (Object.is(left, right)) return
  requireValue(left && right && typeof left === 'object' && typeof right === 'object',
    'Exact history differs at ' + path)
  requireValue(Array.isArray(left) === Array.isArray(right), 'History shape differs at ' + path)
  const leftKeys = Object.keys(left).sort()
  const rightKeys = Object.keys(right).sort()
  requireValue(JSON.stringify(leftKeys) === JSON.stringify(rightKeys),
    'History keys differ at ' + path)
  for (const key of leftKeys) exact(left[key], right[key], path + '.' + key)
}

function observe(kind, input, timestamp) {
  // Full payload sizing happens before sampling; compact packets are cheap to inspect.
  const payloadBytes = kind === 'save' ? completePayloadBytes : encoder.encode(JSON.stringify(input)).length
  const record = {
    phase: currentPhase,
    kind,
    savedAt: timestamp,
    payloadBytes,
    ...(kind === 'checkpoint' ? {
      baseSavedAt: input.baseSavedAt,
      threadCount: input.order.length,
      changedThreads: input.upserts.length,
      changedMessages: input.upserts.reduce((count, update) => count +
        (update.messages.mode === 'patch' ? update.messages.upserts.length : update.messages.values.length), 0),
      includesMessageOrder: input.upserts.some(update => update.messages.order !== undefined),
      modes: input.upserts.map(update => update.messages.mode),
    } : {}),
  }
  records.push(record)
  const start = performance.now()
  let pending
  try {
    pending = kind === 'save' ? api.save(input, timestamp) : api.checkpoint(input)
    record.nativeInvokeReturnMs = performance.now() - start
  } catch (error) {
    record.nativeInvokeReturnMs = performance.now() - start
    throw error
  }
  return pending.then(value => {
    record.nativeAcknowledgementMs = performance.now() - start
    record.acknowledged = true
    return value
  }, error => {
    record.nativeAcknowledgementMs = performance.now() - start
    record.error = String(error)
    throw error
  })
}

// Stable function identities are part of the production client's acknowledged baseline.
const save = (history, timestamp) => observe('save', history, timestamp)
const checkpoint = input => observe('checkpoint', input, input.savedAt)

async function sample(label, operation) {
  currentPhase = label
  const firstRecord = records.length
  const intervalMs = 4
  let previous = performance.now()
  let maxLagMs = 0
  let ticks = 0
  const timer = setInterval(() => {
    const now = performance.now()
    maxLagMs = Math.max(maxLagMs, Math.max(0, now - previous - intervalMs))
    previous = now
    ticks++
  }, intervalMs)
  const start = performance.now()
  try {
    const pending = operation()
    const submissionCallMs = performance.now() - start
    const result = await pending
    const elapsedMs = performance.now() - start
    // Also observe a short write which acknowledges before the first timer tick.
    await new Promise(done => setTimeout(done, intervalMs * 3))
    return {
      label, submissionCallMs, elapsedMs, rendererTimerMaxLagMs: maxLagMs,
      rendererTimerTicks: ticks, records: records.slice(firstRecord), result,
    }
  } finally {
    clearInterval(timer)
    currentPhase = 'idle'
  }
}

function submit() {
  return client.submit(project(threads), ++savedAt, save, checkpoint)
}

function changeMessage(index) {
  const thread = threads[threads.length - 1]
  const messages = [...thread.messages]
  messages[messages.length - 1] = {
    ...messages[messages.length - 1],
    text: '  Exact prompt ' + index + '\r\n\tUnicode café e\u0301 漢字 🧪\r\n' + 'x'.repeat(1009),
    input: '  Keep this provider input exactly\r\n\t' + index + ' 🧪  ',
  }
  threads = [...threads.slice(0, -1), { ...thread, messages }]
}

window.lifeCheckpointFixture = {
  prepare() {
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
    const first = project(threads)
    const again = project(threads)
    requireValue(first[0] === again[0] && first[0].messages === threads[0].messages,
      'History projection must retain immutable identities')
    requireValue(first.every(thread => thread.pending.length === 0),
      'Recoverable history excludes native pending requests')
    completePayloadBytes = encoder.encode(JSON.stringify(first)).length
    return { threadCount: 80, messageCount: 32_000, payloadBytes: completePayloadBytes }
  },
  seed() { return sample('complete-baseline', submit) },
  update(index) {
    changeMessage(index)
    return sample('single-message-' + index, submit)
  },
  burst() {
    return sample('coalesced-stream', () => {
      const submissions = []
      for (let index = 0; index < 12; index++) {
        changeMessage('burst-' + index)
        submissions.push(submit())
      }
      return Promise.all(submissions)
    })
  },
  deleteAndReorder() {
    const survivor = threads[threads.length - 1]
    const messages = survivor.messages.filter((_, index) => index !== 5).reverse()
    threads = [{ ...survivor, messages }, ...threads.slice(1, -1).reverse()]
    return sample('delete-and-reorder', submit)
  },
  async mismatch() {
    // A legacy native writer replaces the acknowledged base; the real checkpoint
    // rejects it and the renderer client resubmits its latest full authoritative tree.
    const foreign = [{ ...threads[0], title: 'External legacy writer' }, ...threads.slice(1)]
    await api.save(project(foreign), ++savedAt)
    changeMessage('after-base-mismatch')
    completePayloadBytes = encoder.encode(JSON.stringify(project(threads))).length
    return sample('base-mismatch-fallback', submit)
  },
  async verify() {
    const expected = project(threads)
    const snapshot = await api.load()
    requireValue(snapshot?.version === 1 && snapshot.savedAt === savedAt,
      'Native history must retain the latest durable acknowledgement')
    exact(snapshot.threads, expected)
    const bytes = encoder.encode(canonical(expected))
    const digest = await crypto.subtle.digest('SHA-256', bytes)
    return {
      savedAt,
      threadCount: expected.length,
      messageCount: expected.reduce((count, thread) => count + thread.messages.length, 0),
      threadOrder: expected.map(thread => thread.id),
      exactHistorySha256: Array.from(new Uint8Array(digest), byte => byte.toString(16).padStart(2, '0')).join(''),
      fullSaveCount: records.filter(record => record.kind === 'save').length,
      checkpointCount: records.filter(record => record.kind === 'checkpoint').length,
      finalExactPrompt: expected[0].messages.find(message => message.id === 'checkpoint-message-79-399')?.text,
    }
  },
}
`

function canonical(value) {
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`
  if (value && typeof value === 'object')
    return `{${Object.keys(value)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${canonical(value[key])}`)
      .join(',')}}`
  return JSON.stringify(value)
}

async function run() {
  await mkdir(artifacts, { recursive: true })
  await rm(join(artifacts, 'checkpoint-electron-failure.json'), { force: true })
  const helperPath = join(artifacts, 'checkpoint-renderer-fixture.js')
  await build({
    stdin: {
      contents: rendererHelper,
      resolveDir: repository,
      sourcefile: 'checkpoint-renderer-fixture.ts',
      loader: 'ts',
    },
    outfile: helperPath,
    bundle: true,
    platform: 'browser',
    format: 'iife',
    target: 'chrome130',
    logLevel: 'silent',
  })
  if (helperOnly) {
    console.log(`Checkpoint renderer helper built: ${helperPath}`)
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

  const configurationRoot = await mkdtemp(join(tmpdir(), 'life-checkpoint-electron-'))
  const rendererErrors = []
  const nativeLogs = []
  const phases = []
  let application
  let launchProof
  let phase = 'launch'
  const progressTimer = setInterval(
    () => console.log(`Checkpoint Electron phase: ${phase}`),
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
    await page.waitForFunction(() => typeof window.relay?.conversations?.checkpoint === 'function')
    launchProof = await application.evaluate(({ app, BrowserWindow }) => {
      const fs = process.getBuiltinModule('node:fs')
      const path = process.getBuiltinModule('node:path')
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
        'The fixture exercises the worker inside ASAR.',
      )
    }
    assert.equal(await page.evaluate(() => typeof window.require), 'undefined')

    // Startup's empty-history autosave owns a separate renderer client. Let it
    // finish before the fixture establishes its baseline, then leave UI state idle.
    phase = 'settle-empty-startup'
    await page.waitForTimeout(2500)
    const initial = await page.evaluate(() => window.relay.conversations.load())
    assert.ok(initial === null || initial.threads.length === 0)
    // DevTools evaluation preserves the app's CSP; adding an inline script tag
    // would be blocked by its production script-src policy.
    await page.evaluate(await readFile(helperPath, 'utf8'))
    const fixture = await page.evaluate(() => window.lifeCheckpointFixture.prepare())
    assert.equal(fixture.threadCount, 80)
    assert.equal(fixture.messageCount, 32_000)
    assert.ok(fixture.payloadBytes > 32 * 1024 * 1024)

    await application.evaluate(() => {
      const { Worker } = process.getBuiltinModule('node:worker_threads')
      const originalPostMessage = Worker.prototype.postMessage
      const probe = {
        intervalMs: 4,
        previous: performance.now(),
        ticks: 0,
        maxLagMs: 0,
        workerCommands: [],
      }
      Worker.prototype.postMessage = function (message, ...args) {
        if (['save', 'checkpoint', 'load'].includes(message?.command?.type))
          probe.workerCommands.push({
            threadId: this.threadId,
            type: message.command.type,
            requestId: message.id,
          })
        return Reflect.apply(originalPostMessage, this, [message, ...args])
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
      globalThis.__lifeCheckpointProbe = probe
    })

    const measure = async (label, method, input) => {
      phase = label
      await application.evaluate(() => {
        const probe = globalThis.__lifeCheckpointProbe
        probe.previous = performance.now()
        probe.ticks = 0
        probe.maxLagMs = 0
      })
      const result = await page.evaluate(
        ({ method, input }) => window.lifeCheckpointFixture[method](input),
        { method, input },
      )
      const main = await application.evaluate(() => {
        const probe = globalThis.__lifeCheckpointProbe
        return { mainTimerMaxLagMs: probe.maxLagMs, mainTimerTicks: probe.ticks }
      })
      assert.ok(result.rendererTimerTicks > 0)
      assert.ok(main.mainTimerTicks > 0)
      assert.ok(Number.isFinite(result.rendererTimerMaxLagMs))
      assert.ok(Number.isFinite(main.mainTimerMaxLagMs))
      phases.push({ ...result, ...main })
      return result
    }

    const baseline = await measure('complete-baseline', 'seed')
    assert.equal(baseline.records.length, 1)
    assert.equal(baseline.records[0].kind, 'save')
    for (let index = 0; index < 6; index++) {
      const update = await measure(`single-message-${index}`, 'update', index)
      assert.equal(update.records.length, 1)
      const packet = update.records[0]
      assert.equal(packet.kind, 'checkpoint')
      assert.equal(packet.changedThreads, 1)
      assert.equal(packet.changedMessages, 1)
      assert.deepEqual(packet.modes, ['patch'])
      assert.equal(packet.includesMessageOrder, false)
      assert.ok(
        packet.payloadBytes < fixture.payloadBytes / 1000,
        'A stream update must stay compact.',
      )
      assert.equal(packet.acknowledged, true)
    }
    const burst = await measure('coalesced-stream', 'burst')
    assert.equal(burst.result.length, 12)
    assert.equal(
      burst.records.length,
      2,
      'One active and one newest pending stream write bounds repeated work.',
    )
    assert.ok(
      burst.records.every((record) => record.kind === 'checkpoint' && record.changedMessages === 1),
    )
    assert.equal(burst.records[1].baseSavedAt, burst.records[0].savedAt)
    assert.ok(burst.result.slice(1).every((timestamp) => timestamp === burst.result[11]))
    const membership = await measure('delete-and-reorder', 'deleteAndReorder')
    assert.equal(membership.records.length, 1)
    assert.equal(membership.records[0].threadCount, 79)
    assert.equal(membership.records[0].includesMessageOrder, true)
    assert.equal(membership.records[0].changedMessages, 0)

    const mismatch = await measure('base-mismatch-fallback', 'mismatch')
    assert.deepEqual(
      mismatch.records.map((record) => record.kind),
      ['checkpoint', 'save'],
    )
    assert.match(mismatch.records[0].error, /CONVERSATION_CHECKPOINT_BASE_CHANGED/)
    assert.equal(mismatch.records[1].acknowledged, true)

    phase = 'exact-native-and-disk-recovery'
    const recovery = await page.evaluate(() => window.lifeCheckpointFixture.verify())
    assert.equal(recovery.threadCount, 79)
    assert.equal(recovery.messageCount, 79 * 400 - 1)
    assert.equal(
      recovery.fullSaveCount,
      2,
      'Only the baseline and a changed native base require full history.',
    )
    assert.match(recovery.finalExactPrompt, /\r\n\tUnicode café e\u0301 漢字 🧪\r\n/)
    const disk = JSON.parse(
      await readFile(join(launchProof.userData, 'conversations.json'), 'utf8'),
    )
    assert.equal(disk.savedAt, recovery.savedAt)
    assert.deepEqual(
      disk.threads.map((thread) => thread.id),
      recovery.threadOrder,
    )
    assert.equal(
      createHash('sha256').update(canonical(disk.threads)).digest('hex'),
      recovery.exactHistorySha256,
      'Every native-loaded thread and message must equal the durable disk snapshot.',
    )
    const workerCommands = await application.evaluate(() => {
      const probe = globalThis.__lifeCheckpointProbe
      clearInterval(probe.timer)
      return probe.workerCommands
    })
    assert.ok(
      workerCommands.some((command) => command.type === 'checkpoint' && command.threadId > 0),
    )
    assert.equal(new Set(workerCommands.map((command) => command.threadId)).size, 1)
    assert.equal(rendererErrors.length, 0, rendererErrors.join('\n'))

    const report = {
      fixture:
        '80 threads × 400 messages × approximately 1 KiB; actual renderer/preload/main/worker/disk roundtrip',
      upstreamProvidersUsed: false,
      launchProof,
      fixturePayload: fixture,
      phases,
      recovery,
      workerCommands,
      rendererErrors,
      measurements:
        'Native invoke return includes real preload IPC serialization. Timer lag is sampled at 4 ms; no hardware-dependent latency threshold is asserted.',
    }
    await writeFile(
      join(artifacts, 'checkpoint-electron-report.json'),
      JSON.stringify(report, null, 2),
    )
    await writeFile(
      join(
        artifacts,
        launchProof.packaged
          ? 'checkpoint-electron-packaged-report.json'
          : 'checkpoint-electron-source-report.json',
      ),
      JSON.stringify(report, null, 2),
    )
    console.log(JSON.stringify(report, null, 2))
  } catch (error) {
    await writeFile(
      join(artifacts, 'checkpoint-electron-failure.json'),
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
