#!/usr/bin/env node
// Candidate-only actual Electron reload / delayed native exit supplement.
// The original matched 39-case fixture remains byte-for-byte frozen.
const assert = require('node:assert/strict')
const { existsSync, mkdirSync, rmSync } = require('node:fs')
const { randomInt } = require('node:crypto')
const { mkdir, readFile, writeFile } = require('node:fs/promises')
const { join, resolve } = require('node:path')
const { spawnSync } = require('node:child_process')
const { build } = require('esbuild')
const { _electron: electron } = require('playwright')
const {
  RecoveryHarness,
  waitUntil,
  INITIAL,
  MIDDLE,
  FINAL,
  alive,
  sha256,
} = require('./helpers/active-session-recovery-steps.cjs')

const repository = resolve(__dirname, '..')
const appPath = resolve(process.env.LIFE_TEST_APP_PATH || repository)
const artifacts = resolve(
  repository,
  process.env.LIFE_TEST_ARTIFACTS_DIR || 'output/playwright/active-session-reload-candidate',
)
assert.notEqual(
  process.env.LIFE_TEST_EXPECT_RECOVERY_GAP,
  '1',
  'This is an independently hashed candidate supplemental fixture',
)
if (process.platform === 'linux' && !process.env.DISPLAY) {
  let reservation, display
  for (let attempt = 0; attempt < 40 && !reservation; attempt++) {
    const candidate = randomInt(500, 4500)
    if (existsSync(`/tmp/.X${candidate}-lock`) || existsSync(`/tmp/.X11-unix/X${candidate}`))
      continue
    const lock = `/tmp/life-active-reload-display-${candidate}.lock`
    try {
      mkdirSync(lock, { mode: 0o700 })
      reservation = lock
      display = candidate
    } catch (error) {
      if (error.code !== 'EEXIST') throw error
    }
  }
  assert.ok(reservation, 'Reserve a private display')
  mkdirSync(artifacts, { recursive: true })
  let child
  try {
    child = spawnSync(
      'xvfb-run',
      [
        `--server-num=${display}`,
        `--error-file=${join(artifacts, 'xvfb.log')}`,
        '-s',
        '-screen 0 1440x960x24 -noreset -extension MIT-SHM',
        process.execPath,
        __filename,
      ],
      { cwd: repository, env: process.env, stdio: 'inherit' },
    )
  } finally {
    rmSync(reservation, { recursive: true, force: true })
  }
  process.exit(child.status ?? 1)
}

const assistants = (thread, text) =>
  thread?.messages?.filter((message) => message?.role === 'assistant' && message.text === text) ||
  []
const withMiddle = INITIAL + MIDDLE + FINAL.slice(INITIAL.length)
const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms))
const writerStarts = (harness, provider) =>
  harness
    .log()
    .filter(
      (entry) =>
        entry.kind === 'provider-started' &&
        entry.provider === provider &&
        (provider === 'codex'
          ? entry.argv?.includes('app-server')
          : entry.argv?.includes('--include-partial-messages')),
    )

async function reloadDocument(harness) {
  const original = `reload-${Date.now()}-${randomInt(0, 1e8)}`
  await harness.page.evaluate((token) => {
    window.__lifeReloadDocumentToken = token
  }, original)
  const before = await harness.application.evaluate(({ BrowserWindow }) => {
    const contents = BrowserWindow.getAllWindows()[0].webContents
    return {
      nativePID: process.pid,
      rendererPID: contents.getOSProcessId(),
      contentsId: contents.id,
      url: contents.getURL(),
    }
  })
  await harness.application.evaluate(({ BrowserWindow }) =>
    BrowserWindow.getAllWindows()[0].webContents.reload(),
  )
  await harness.page.waitForFunction(
    () => !window.__lifeReloadDocumentToken && window.relay && document.querySelector('.app-shell'),
    undefined,
    { timeout: 3500 },
  )
  await harness.observeEvents()
  const after = await harness.application.evaluate(({ BrowserWindow }) => {
    const contents = BrowserWindow.getAllWindows()[0].webContents
    return {
      nativePID: process.pid,
      rendererPID: contents.getOSProcessId(),
      contentsId: contents.id,
      url: contents.getURL(),
    }
  })
  assert.equal(after.nativePID, before.nativePID)
  assert.equal(after.contentsId, before.contentsId)
  assert.equal(after.url, before.url)
  return { before, after, discardedDocumentToken: original, actualWebContentsReload: true }
}

function assertJournalInputReceipt(frame, transport, inputs, receipts) {
  assert.deepEqual(Object.keys(frame).sort(), ['cursor', 'sequence', 'status', 'type'])
  assert.equal(frame.type, 'inputReceipt')
  assert.equal(
    transport.inputReceipts,
    1,
    'Receipt output requires the negotiated delivery contract',
  )
  assert.ok(Number.isSafeInteger(frame.cursor) && frame.cursor > 0)
  assert.ok(Number.isSafeInteger(frame.sequence) && frame.sequence > 0)
  assert.ok(['written', 'cancelled', 'uncertain'].includes(frame.status))
  assert.ok(inputs.has(frame.sequence), 'Receipt identifies an original authorized numbered input')
  assert.equal(
    receipts.has(frame.sequence),
    false,
    'A numbered input has one final receipt identity',
  )
  receipts.set(frame.sequence, { cursor: frame.cursor, status: frame.status })
}

function assertWrittenCloseReceipt(journal) {
  const closes = journal.records.filter(
    (entry) => entry.kind === 'input' && entry.input.frame.type === 'close',
  )
  assert.equal(closes.length, 1, 'The graceful close has one exact durable native intent')
  const receipts = journal.records.filter(
    (entry) =>
      entry.kind === 'output' &&
      entry.frame.type === 'inputReceipt' &&
      entry.frame.sequence === closes[0].input.sequence,
  )
  assert.equal(receipts.length, 1, 'The original graceful close has one native delivery receipt')
  assert.equal(receipts[0].frame.status, 'written', 'The native broker accepted the original close')
  assert.ok(receipts[0].revision > closes[0].revision)
  return receipts[0]
}

function assertConfirmedTerminal(frame) {
  assert.equal(frame.type, 'exit')
  assert.ok(
    frame.nativeExitConfirmed === undefined || frame.nativeExitConfirmed === true,
    'The terminal receipt confirms the original native process exited',
  )
}

async function nativeJournal(harness, brokerId, original) {
  const path = join(
    harness.launches.at(-1).userData,
    'native-recovery',
    sha256(brokerId) + '.jsonl',
  )
  const bytes = await readFile(path, 'utf8')
  assert.ok(bytes.endsWith('\n'), 'Read a complete committed native journal batch')
  let previous = null,
    index = 0,
    revision = 0,
    cursor = 0,
    terminal = false,
    transport
  const records = []
  const inputs = new Map()
  const receipts = new Map()
  for (const line of bytes.trimEnd().split('\n')) {
    const { hash, ...payload } = JSON.parse(line)
    assert.equal(payload.format, 'life-native-recovery')
    assert.equal(payload.version, 1)
    assert.ok(payload.records.length > 0)
    assert.equal(hash, sha256(JSON.stringify(payload)))
    assert.equal(payload.previousHash, previous)
    assert.equal(payload.index, ++index)
    previous = hash
    for (const record of payload.records) {
      assert.equal(record.revision, ++revision)
      if (record.kind === 'create') {
        assert.equal(record.revision, 1)
        assert.equal(transport, undefined)
        transport = structuredClone(record.transport)
      } else if (record.kind === 'transport') Object.assign(transport, record.patch)
      if (record.kind === 'input') {
        assert.ok(Number.isSafeInteger(record.input.sequence) && record.input.sequence > 0)
        assert.equal(inputs.has(record.input.sequence), false)
        inputs.set(record.input.sequence, record.input)
      }
      if (record.kind === 'output') {
        assert.equal(terminal, false, 'No native output follows its terminal receipt')
        assert.ok(['stdout', 'stderr', 'inputReceipt', 'exit'].includes(record.frame.type))
        assert.ok(Number.isSafeInteger(record.frame.cursor) && record.frame.cursor > 0)
        assert.equal(record.frame.cursor, ++cursor)
        if (record.frame.type === 'inputReceipt')
          assertJournalInputReceipt(record.frame, transport, inputs, receipts)
        if (record.frame.type === 'exit') terminal = true
      }
      records.push(record)
    }
  }
  assert.equal(transport?.id, brokerId)
  assert.equal(transport.brokerId, brokerId)
  assert.equal(transport.provider, original.thread.provider)
  assert.equal(transport.nativeProtocol, 'codex-app-server-jsonrpc')
  assert.equal(transport.brokerProtocolVersion, 2)
  assert.equal(transport.machine.transport, 'ssh')
  assert.equal(transport.machine.profileId, original.thread.profileId)
  assert.equal(transport.machine.host, '127.0.0.1')
  assert.equal(transport.machine.port, harness.fixture.port)
  assert.equal(transport.machine.username, 'fixture')
  assert.ok(
    transport.brokerRoot === harness.fixture.root ||
      transport.brokerRoot.startsWith(harness.fixture.root + '/'),
  )
  const owners = transport.owners.filter(
    (owner) => owner.sessionId === original.thread.id && owner.kind === 'root',
  )
  assert.equal(owners.length, 1)
  assert.equal(owners[0].workspace, original.thread.workspace)
  assert.equal(owners[0].nativeThreadId, original.thread.remoteId)
  assert.equal(owners[0].input.sessionId, original.thread.id)
  assert.equal(owners[0].input.prompt, original.prompt)
  return {
    path,
    sha256: sha256(bytes),
    batchCount: index,
    recordCount: revision,
    outputCursor: cursor,
    transport,
    records,
  }
}

async function activeReload(harness, provider) {
  const name = `${provider}-active-actual-renderer-reload`
  const prompt = `LIFE_RECOVERY_STREAM:  Exact ${name}\n\tQuotes \" $value café 漢字 🧪  \n`
  await harness.setup(name)
  const record = await harness.send(provider, prompt)
  await waitUntil(
    async () => assistants(await harness.thread(prompt), INITIAL).length === 1,
    'the exact initial native item before renderer replacement',
  )
  await harness.flush()
  const before = await harness.thread(prompt)
  const user = before.messages.find(
    (message) => message?.role === 'user' && message.text === prompt,
  )
  const partial = assistants(before, INITIAL)[0]
  const reload = await reloadDocument(harness)
  await harness.openAgents()
  await harness.select(record)
  await waitUntil(
    async () => assistants(await harness.thread(prompt), INITIAL).length === 1,
    'the exact original partial after real renderer reload',
  )
  const stop = harness.page.getByRole('button', {
    name: 'Stop agent and pause queued messages',
    exact: true,
  })
  await stop.waitFor()
  assert.equal(await stop.isEnabled(), true)
  assert.equal(alive(record.started.pid), true)
  assert.equal(
    writerStarts(harness, provider).length,
    1,
    'Renderer replacement never opens an unused competing native writer',
  )
  assert.equal(
    harness
      .log()
      .filter((entry) => entry.kind === 'provider-term' && entry.pid === record.started.pid).length,
    0,
  )
  await harness.release(record.thread.remoteId, 'middle')
  await waitUntil(
    async () => assistants(await harness.thread(prompt), INITIAL + MIDDLE).length === 1,
    'a fresh append-only delta reaches the new document before any complete snapshot',
  )
  const appended = await harness.assertOwnership(record)
  assert.equal(assistants(appended, INITIAL + MIDDLE)[0].id, partial.id)
  assert.equal(assistants(appended, INITIAL + MIDDLE)[0].createdAt, partial.createdAt)
  const appendedUser = appended.messages.find(
    (message) => message?.role === 'user' && message.text === prompt,
  )
  assert.equal(appendedUser.id, user.id)
  assert.equal(appendedUser.createdAt, user.createdAt)
  const freshEvents = await harness.page.evaluate(() => window.__activeRecoveryEvents)
  assert.equal(
    freshEvents.filter(
      (event) =>
        event.sessionId === record.thread.id &&
        event.itemId === record.started.itemId &&
        event.type === 'text' &&
        event.text === MIDDLE &&
        event.status !== 'replace',
    ).length,
    1,
  )
  await harness.release(record.thread.remoteId, 'finish')
  await waitUntil(async () => {
    const thread = await harness.thread(prompt)
    return !thread?.busy && assistants(thread, withMiddle).length === 1
  }, 'the original turn completes exactly once in the replacement document')
  const after = await harness.assertOwnership(record)
  assert.equal(writerStarts(harness, provider).length, 1)
  const completed = assistants(after, withMiddle)[0]
  assert.equal(completed.id, provider === 'codex' ? `${partial.id}:final_answer` : partial.id)
  assert.equal(completed.phase, provider === 'codex' ? 'final_answer' : partial.phase)
  assert.equal(completed.createdAt, partial.createdAt)
  assert.equal(
    harness
      .log()
      .filter((entry) => entry.kind === 'provider-term' && entry.pid === record.started.pid).length,
    0,
  )
  return {
    name,
    outcome: 'verified-active-native-owner-through-real-renderer-reload',
    record,
    before,
    reload,
    appended,
    after,
    freshEvents,
    opaqueArchiveSha256: await harness.assertOpaque(),
  }
}

async function slowExitReload(harness) {
  const name = 'codex-idle-window-close-slow-exit-renderer-reload'
  const prompt = `LIFE_RECOVERY_STREAM:  Exact ${name}\n\tQuotes \" $value café 漢字 🧪  \n`
  await harness.setup(name)
  const record = await harness.send('codex', prompt)
  await waitUntil(
    async () => assistants(await harness.thread(prompt), INITIAL).length === 1,
    'the original native turn streams before release',
  )
  await harness.release(record.thread.remoteId, 'finish')
  await waitUntil(async () => {
    const thread = await harness.thread(prompt)
    return !thread?.busy && assistants(thread, FINAL).length === 1
  }, 'the exact original native turn becomes idle')
  await harness.flush()
  const before = await harness.assertOwnership(record)
  const broker = harness.gate.proof.find(
    (entry) => entry.kind === 'broker-ready-observed' && entry.pid === record.started.pid,
  )
  assert.ok(broker, 'Observe the actual broker owning the original provider')
  const journalBefore = await nativeJournal(harness, broker.brokerId, record)
  assert.equal(
    journalBefore.records.filter((entry) => entry.kind === 'output' && entry.frame.type === 'exit')
      .length,
    0,
  )
  const control = join(harness.fixture.root, 'active-recovery-control')
  await writeFile(join(control, 'hold-native-exit'), 'hold only this private native process')
  const application = harness.application
  const exit = new Promise((resolve) =>
    application.process().once('exit', (code, signal) => resolve({ code, signal, at: Date.now() })),
  )
  await application.evaluate(({ BrowserWindow }) => {
    setTimeout(() => BrowserWindow.getAllWindows()[0].close(), 0)
  })
  await waitUntil(
    () =>
      harness
        .log()
        .some(
          (entry) => entry.kind === 'slow-exit-signal-accepted' && entry.pid === record.started.pid,
        ),
    'the original native process accepts actual TERM without releasing its writer',
    12000,
  )
  const accepted = harness
    .log()
    .find((entry) => entry.kind === 'slow-exit-signal-accepted' && entry.pid === record.started.pid)
  let pending, reload, observed, releaseAt, guardObservation
  try {
    assert.equal(alive(record.started.pid), true)
    reload = await reloadDocument(harness)
    pending = await harness.page.evaluate(
      (input) => {
        window.__lifeSlowExitAttempt = { input, invokedAt: Date.now(), status: 'pending' }
        void window.relay.agent.start(input).then(
          () => {
            window.__lifeSlowExitAttempt.status = 'resolved'
            window.__lifeSlowExitAttempt.settledAt = Date.now()
          },
          (error) => {
            window.__lifeSlowExitAttempt.status = 'rejected'
            window.__lifeSlowExitAttempt.error = String(error)
            window.__lifeSlowExitAttempt.settledAt = Date.now()
          },
        )
        return window.__lifeSlowExitAttempt
      },
      {
        sessionId: before.id,
        localTurn: before.turn + 1,
        provider: 'codex',
        remoteId: before.remoteId,
        prompt: 'LIFE_RECOVERY_STREAM: Same-session mutation while native exit is withheld 🧪\n',
        model: before.model,
        reasoningEffort: before.reasoningEffort,
        serviceTier: before.serviceTier,
        mode: before.mode,
        workspace: before.workspace,
      },
    )
    await delay(500)
    observed = {
      attempt: await harness.page.evaluate(() => window.__lifeSlowExitAttempt),
      providerLog: harness.log(),
      journal: await nativeJournal(harness, broker.brokerId, record),
      at: Date.now(),
    }
    assert.equal(alive(record.started.pid), true)
    assert.ok(
      ['pending', 'rejected'].includes(observed.attempt.status),
      'A nonterminal owner cannot complete the competing same-session mutation',
    )
    if (observed.attempt.status === 'rejected') {
      const documentBarrier = observed.attempt.error.includes(
        'Life is restarting its interface. Try again when the workspace returns.',
      )
      const nativeBarrier =
        observed.attempt.error.includes(
          'The previous Codex process has not produced its terminal receipt. Life did not open a replacement writer.',
        ) ||
        observed.attempt.error.includes(
          'The original native process is still closing. Wait for its terminal receipt before changing this conversation.',
        )
      assert.ok(
        documentBarrier || nativeBarrier,
        'The rejected mutation has explicit closing-document or native terminal-ownership provenance',
      )
      guardObservation = {
        barrier: documentBarrier ? 'renderer document admission' : 'native closing transport',
        nativeClosingGuardIndependentlyExercised: nativeBarrier,
      }
    } else
      guardObservation = {
        barrier: 'same-session start remains pending before the original native terminal receipt',
        nativeClosingGuardIndependentlyExercised: false,
      }
    assert.equal(
      observed.providerLog.filter(
        (entry) => entry.kind === 'provider-started' && entry.argv?.[0] === 'app-server',
      ).length,
      1,
    )
    assert.equal(observed.providerLog.filter((entry) => entry.kind === 'turn-started').length, 1)
    assert.equal(observed.providerLog.filter((entry) => entry.kind === 'writer-conflict').length, 0)
    assert.equal(
      observed.providerLog.filter(
        (entry) => entry.kind === 'writer-released' && entry.pid === record.started.pid,
      ).length,
      0,
    )
    assert.equal(
      observed.journal.records.filter(
        (entry) => entry.kind === 'output' && entry.frame.type === 'exit',
      ).length,
      0,
    )
    assertWrittenCloseReceipt(observed.journal)
    assert.ok(
      Date.now() - accepted.at < 4500,
      'Finish the deterministic slow-close boundary before the real broker force-kill deadline',
    )
  } finally {
    releaseAt = Date.now()
    await writeFile(
      join(control, `release-native-exit-${record.started.pid}`),
      'allow the accepted native close to finish',
    )
  }
  const shutdown = await Promise.race([
    exit,
    delay(15000).then(() => {
      throw new Error('The isolated app did not close after the real native exit')
    }),
  ])
  harness.application = undefined
  harness.page = undefined
  assert.equal(shutdown.code, 0)
  assert.equal(shutdown.signal, null)
  assert.equal(alive(record.started.pid), false)
  const log = harness.log()
  const nativeReleased = log.find(
    (entry) => entry.kind === 'slow-exit-released' && entry.pid === record.started.pid,
  )
  const nativeExited = log.find(
    (entry) => entry.kind === 'process-exit' && entry.pid === record.started.pid,
  )
  assert.ok(
    nativeReleased && nativeExited,
    'The provider exits through its held graceful TERM handler',
  )
  assert.ok(nativeReleased.at >= releaseAt && nativeExited.at >= nativeReleased.at)
  const journalAfter = await nativeJournal(harness, broker.brokerId, record)
  const terminal = journalAfter.records.filter(
    (entry) => entry.kind === 'output' && entry.frame.type === 'exit',
  )
  assert.equal(terminal.length, 1, 'The native registry commits the authoritative terminal receipt')
  assertConfirmedTerminal(terminal[0].frame)
  assert.equal(terminal[0].frame.code, 0)
  assert.equal(terminal[0].frame.signal, null)
  const closeReceipt = assertWrittenCloseReceipt(journalAfter)
  assert.ok(closeReceipt.frame.cursor < terminal[0].frame.cursor)
  assert.equal(
    writerStarts(harness, 'codex').length,
    1,
    'A closing application never starts a replacement writer, including after native exit but before terminal commitment',
  )
  assert.equal(
    log.filter((entry) => entry.kind === 'turn-started').length,
    1,
    'The held same-session mutation never becomes a second turn during shutdown',
  )
  return {
    name,
    outcome: 'verified-slow-native-exit-blocks-writer-through-real-renderer-reload',
    record,
    before,
    accepted,
    pending,
    reload,
    observed,
    guardObservation,
    releaseAt,
    nativeReleased,
    nativeExited,
    terminal: terminal[0],
    journalBefore,
    journalAfter,
    shutdown,
  }
}

async function main() {
  await mkdir(artifacts, { recursive: true })
  const bundle = join(artifacts, 'ssh-fixture.cjs')
  await build({
    entryPoints: [join(repository, 'tests/helpers/ssh-fixture.ts')],
    bundle: true,
    platform: 'node',
    format: 'cjs',
    outfile: bundle,
    packages: 'external',
    logLevel: 'silent',
  })
  const { SSHFixture } = require(bundle)
  class ReloadSSHFixture extends SSHFixture {
    constructor() {
      super(join(repository, 'tests/helpers/active-session-reload-provider.cjs'))
    }
    async start() {
      await super.start()
      await writeFile(
        join(this.root, 'active-session-reload-native.cjs'),
        await readFile(join(repository, 'tests/helpers/active-session-recovery-provider.cjs')),
        { mode: 0o600 },
      )
      return this
    }
  }
  const proof = {
    fixture:
      'candidate-only real Electron webContents.reload / real SSH / held graceful native TERM stand-in',
    matchedBaselineClaim: false,
    authenticatedProviderUse: false,
    inferenceRequests: 0,
    appPath,
    cases: [],
    rendererErrors: [],
    fixtureSourceSha256: sha256(await readFile(__filename)),
    helperSha256: sha256(
      await readFile(join(repository, 'tests/helpers/active-session-recovery-steps.cjs')),
    ),
    frozenNativeProviderSha256: sha256(
      await readFile(join(repository, 'tests/helpers/active-session-recovery-provider.cjs')),
    ),
    reloadProviderSha256: sha256(
      await readFile(join(repository, 'tests/helpers/active-session-reload-provider.cjs')),
    ),
    sshBundleSha256: sha256(await readFile(bundle)),
    mainSha256: sha256(await readFile(join(appPath, 'out/main/index.js'))),
    checkpointWorkerSha256: sha256(
      await readFile(join(appPath, 'out/main/conversation-checkpoint-worker.js')),
    ),
    timingInterpretation:
      'Functional deterministic hold observations; no isolated performance claims.',
  }
  const cases = ['codex-active-reload', 'claude-active-reload', 'codex-slow-exit'].filter(
    (name) =>
      !process.env.LIFE_TEST_RELOAD_CASE || name.includes(process.env.LIFE_TEST_RELOAD_CASE),
  )
  assert.ok(cases.length)
  let harness, phase
  const progress = setInterval(
    () => console.log(`Active renderer reload supplement phase: ${phase}`),
    30000,
  )
  try {
    for (phase of cases) {
      harness = new RecoveryHarness({
        repository,
        appPath,
        artifacts,
        electron,
        SSHFixture: ReloadSSHFixture,
        proof,
      })
      const result =
        phase === 'codex-slow-exit'
          ? await slowExitReload(harness)
          : await activeReload(harness, phase.startsWith('codex') ? 'codex' : 'claude')
      result.providerLog = harness.log()
      result.launches = harness.launches
      await harness.saveEvidence(result.name + '.json', result)
      if (harness.page)
        await harness.page.screenshot({ path: join(artifacts, result.name + '.png') })
      proof.cases.push({ name: result.name, outcome: result.outcome })
      console.log(`PASS: ${result.name}: ${result.outcome}`)
      await harness.close()
      harness = undefined
      await writeFile(join(artifacts, 'proof.json'), JSON.stringify(proof, null, 2))
    }
    assert.deepEqual(proof.rendererErrors, [])
  } catch (error) {
    proof.failure = { phase, message: String(error), stack: error.stack }
    if (harness) {
      const failure = {
        providerLog: harness.fixture ? harness.log() : [],
        broker: harness.gate?.proof,
        launches: harness.launches,
        nativeLogs: harness.nativeLogs,
      }
      if (harness.page) {
        await harness.page.screenshot({ path: join(artifacts, 'failure.png') }).catch(() => {})
        failure.body = await harness.page
          .locator('body')
          .innerText()
          .catch(() => '')
      }
      await writeFile(join(artifacts, 'failure.json'), JSON.stringify(failure, null, 2))
    }
    throw error
  } finally {
    clearInterval(progress)
    await writeFile(join(artifacts, 'proof.json'), JSON.stringify(proof, null, 2))
    await harness?.close()
  }
}
main().catch((error) => {
  console.error(error)
  process.exitCode = 1
})
