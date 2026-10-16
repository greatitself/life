#!/usr/bin/env node
/*
 * Real Electron and real SSH/SFTP, deterministic native provider stand-ins.
 * No account, authentication state, inference API or shared live profile is used.
 * Run this exact frozen fixture against both immutable application snapshots:
 * LIFE_TEST_APP_PATH=/baseline LIFE_TEST_EXPECT_RECOVERY_GAP=1 node tests/active-session-recovery-smoke.cjs
 * LIFE_TEST_APP_PATH=/candidate node tests/active-session-recovery-smoke.cjs
 * --build-helper-only bundles the SSH helper without launching anything.
 */
const assert = require('node:assert/strict')
const { existsSync, mkdirSync, rmSync } = require('node:fs')
const { randomInt } = require('node:crypto')
const { mkdir, readFile, readdir, writeFile } = require('node:fs/promises')
const { join, resolve } = require('node:path')
const { spawnSync } = require('node:child_process')
const { performance } = require('node:perf_hooks')
const { build } = require('esbuild')
const { _electron: electron } = require('playwright')
const {
  RecoveryHarness,
  waitUntil,
  INITIAL,
  FINAL,
  CHILD_FINAL,
  STUDIO_INITIAL,
  MIDDLE,
  sha256,
} = require('./helpers/active-session-recovery-steps.cjs')

const repository = resolve(__dirname, '..')
const appPath = resolve(process.env.LIFE_TEST_APP_PATH || repository)
const baseline = process.env.LIFE_TEST_EXPECT_RECOVERY_GAP === '1'
const helperOnly = process.argv.includes('--build-helper-only')
const sourceCommitGap = process.argv.includes('--source-apply-commit-gap')
assert.ok(
  !sourceCommitGap || !baseline,
  'The new durable action protocol boundary is a candidate-only supplemental fixture',
)
const artifacts = resolve(
  repository,
  process.env.LIFE_TEST_ARTIFACTS_DIR ||
    `output/playwright/active-session-recovery-${baseline ? 'baseline' : 'candidate'}`,
)
if (!helperOnly && process.platform === 'linux' && !process.env.DISPLAY) {
  assert.equal(spawnSync('xvfb-run', ['--help'], { stdio: 'ignore' }).status, 0)
  let display
  let reservation
  for (let attempt = 0; attempt < 40 && !reservation; attempt++) {
    const candidate = randomInt(500, 4500)
    const lock = `/tmp/life-active-recovery-display-${candidate}.lock`
    if (existsSync(`/tmp/.X${candidate}-lock`) || existsSync(`/tmp/.X11-unix/X${candidate}`))
      continue
    try {
      mkdirSync(lock, { mode: 0o700 })
      reservation = lock
      display = candidate
    } catch (error) {
      if (error.code !== 'EEXIST') throw error
    }
  }
  assert.ok(reservation, 'Reserve a dedicated display without touching any existing X server')
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
        ...process.argv.slice(2),
      ],
      { cwd: repository, env: process.env, stdio: 'inherit' },
    )
  } finally {
    rmSync(reservation, { recursive: true, force: true })
  }
  process.exit(child.status ?? 1)
}

const scenarios = [
  ...['codex', 'claude'].flatMap((provider) => [
    { provider, kind: 'stream', mode: 'STREAM', close: 'quit' },
    { provider, kind: 'stream', mode: 'STREAM', close: 'crash' },
    { provider, kind: 'pending-approval', mode: 'APPROVAL', close: 'quit' },
    { provider, kind: 'pending-approval', mode: 'APPROVAL', close: 'crash' },
    { provider, kind: 'approval-before-accept', mode: 'APPROVAL', close: 'crash' },
    { provider, kind: 'approval-before-ack', mode: 'APPROVAL', close: 'crash' },
    { provider, kind: 'child-only', mode: 'CHILD', close: 'quit' },
    { provider, kind: 'child-only', mode: 'CHILD', close: 'crash' },
    { provider, kind: 'offline-completion', mode: 'OFFLINE', close: 'crash' },
    { provider, kind: 'split-byte-frame', mode: 'SPLIT', close: 'crash' },
    { provider, kind: 'replay-response-guards', mode: 'STREAM', close: 'crash', guards: true },
    { provider, kind: 'history-ack-failure', mode: 'STREAM', close: 'crash' },
    { provider, kind: 'stop-before-ack', mode: 'STOP', close: 'crash' },
  ]),
  { provider: 'codex', kind: 'shared-roots', mode: 'MULTI_A', close: 'quit' },
  { provider: 'codex', kind: 'shared-roots', mode: 'MULTI_A', close: 'crash' },
  { provider: 'codex', kind: 'thread-start-before-bind', mode: 'STREAM', close: 'crash' },
  { provider: 'codex', kind: 'turn-start-before-reply', mode: 'STREAM', close: 'crash' },
  {
    provider: 'codex',
    kind: 'pending-approval-string-id',
    mode: 'APPROVAL',
    close: 'crash',
    stringId: true,
  },
  ...['codex', 'claude'].flatMap((provider) => [
    { provider, kind: 'studio-planning', mode: 'STUDIO_READ', close: 'crash', phase: 'request' },
    {
      provider,
      kind: 'studio-source-read',
      mode: 'STUDIO_READ',
      close: 'crash',
      phase: 'source-read',
    },
    {
      provider,
      kind: 'studio-source-proposal',
      mode: 'STUDIO_PATCH',
      close: 'crash',
      phase: 'source-read',
    },
    { provider, kind: 'studio-repair', mode: 'STUDIO_REPAIR', close: 'crash', phase: 'repair' },
  ]),
]

const assistantReplies = (thread, text) =>
  thread?.messages?.filter((message) => message?.role === 'assistant' && message.text === text) ||
  []
const WITH_MIDDLE = INITIAL + MIDDLE + FINAL.slice(INITIAL.length)
async function waitForNativeSource(harness) {
  await waitUntil(
    async () => {
      const failure = harness.nativeLogs
        .flat()
        .find((line) => line.includes('[Life] Source reload failed:'))
      if (failure) throw new Error(failure)
      return harness.page.getByTestId('life-active-recovery-source').isVisible()
    },
    'the original native source activation becomes visible',
    90000,
  )
}

const permissionResponses = (harness, record) =>
  harness
    .log()
    .filter(
      (entry) => entry.kind === 'permission-response' && entry.threadId === record.thread.remoteId,
    )

async function runScenario(harness, scenario, index) {
  const name = `${scenario.provider}-${scenario.kind}-${scenario.close}`
  const prompt = `LIFE_RECOVERY_${scenario.mode}:  Exact ${name} ${index}${scenario.stringId ? ' string-id' : ''}${scenario.guards ? ' replay-guards' : ''}\n\tQuotes " $value café 漢字 🧪  \n`
  await harness.setup(name)
  const records = []
  let approval
  let gate
  if (scenario.kind === 'thread-start-before-bind' || scenario.kind === 'turn-start-before-reply') {
    const method = scenario.kind === 'thread-start-before-bind' ? 'thread/start' : 'turn/start'
    gate = harness.gate.arm('native-reply', { method })
    const before = await harness.begin(scenario.provider, prompt)
    await waitUntil(() => gate.blocked, `the actual ${method} response is withheld before delivery`)
    const held = harness.gate.proof.find((entry) => entry.kind === 'native-reply-withheld')
    const nativeThread =
      method === 'thread/start'
        ? held.native.result.thread.id
        : harness.log().find((entry) => entry.kind === 'turn-started' && entry.prompt === prompt)
            .threadId
    const processStart = harness
      .log()
      .find((entry) => entry.kind === 'thread-started' && entry.threadId === nativeThread)
    records.push({
      prompt,
      thread: { ...before, remoteId: nativeThread },
      started: harness
        .log()
        .find((entry) => entry.kind === 'turn-started' && entry.prompt === prompt) || {
        pid: processStart.pid,
        threadId: nativeThread,
      },
      awaitingInitialSubmission: method === 'thread/start',
      nativeReplyBoundary: held,
    })
  } else records.push(await harness.send(scenario.provider, prompt))
  const original = records[0]
  if (scenario.kind === 'shared-roots') {
    records.push(
      await harness.send(
        'codex',
        `LIFE_RECOVERY_MULTI_B:  Exact second shared root ${index}\n\tDistinct user prompt 🧪  \n`,
      ),
    )
    assert.equal(
      records[1].started.pid,
      original.started.pid,
      'Both roots share one native Codex RPC',
    )
    assert.notEqual(records[1].thread.remoteId, original.thread.remoteId)
  }
  if (scenario.kind.includes('approval')) {
    approval = await harness.approval(prompt)
    if (scenario.kind === 'approval-before-accept' || scenario.kind === 'approval-before-ack') {
      gate = harness.gate.arm(
        scenario.kind === 'approval-before-accept' ? 'before-accept' : 'before-ack',
      )
      await harness.approve()
      await waitUntil(
        () => gate.blocked,
        'the real native permission input or broker ACK is withheld',
      )
      if (scenario.kind === 'approval-before-ack') {
        await waitUntil(
          () => permissionResponses(harness, original).length === 1,
          'the original provider consumes the native permission response before Life sees the ACK',
        )
      } else assert.equal(permissionResponses(harness, original).length, 0)
    }
  }
  if (scenario.kind === 'child-only') {
    await waitUntil(
      () => harness.log().some((entry) => entry.kind === 'child-started'),
      'a native child owns active work after root completion',
    )
    await waitUntil(async () => {
      const current = await harness.thread(prompt)
      return !current?.busy && assistantReplies(current, FINAL).length === 1
    }, 'the root is complete while its native child still runs')
  } else if (scenario.kind === 'split-byte-frame') {
    await waitUntil(
      () => harness.log().some((entry) => entry.kind === 'split-prefix'),
      'a raw native JSON message ends halfway through a four-byte UTF-8 character',
    )
    const split = harness.log().find((entry) => entry.kind === 'split-prefix')
    assert.equal(split.utf8BytesWritten, 2)
    assert.equal(split.newlineWritten, false)
    assert.equal(assistantReplies(await harness.thread(prompt), INITIAL).length, 0)
  } else if (
    !original.nativeReplyBoundary &&
    !original.awaitingInitialSubmission &&
    !scenario.kind.includes('approval')
  ) {
    await waitUntil(
      async () => assistantReplies(await harness.thread(prompt), INITIAL).length === 1,
      'the initial native response is persisted before interruption',
    )
  }
  let guardResponsesBefore
  if (scenario.guards) {
    await waitUntil(
      () =>
        harness.log().filter((entry) => entry.kind === 'guard-response').length ===
        (scenario.provider === 'codex' ? 3 : 2),
      'the original clock, unsupported and malformed requests receive their original automatic responses',
    )
    guardResponsesBefore = harness.log().filter((entry) => entry.kind === 'guard-response')
    for (const guard of guardResponsesBefore) {
      if (scenario.provider === 'codex') {
        assert.equal(guard.message.id, guard.wireId)
        if (guard.guard === 'clock') {
          assert.ok(Number.isSafeInteger(guard.message.result.currentTimeAt))
          assert.ok(
            Math.abs(guard.message.result.currentTimeAt - Math.floor(guard.at / 1000)) <= 60,
          )
        } else if (guard.guard === 'unsupported') assert.equal(guard.message.error.code, -32601)
        else
          assert.deepEqual(guard.message.result, { action: 'decline', content: null, _meta: null })
      } else {
        assert.equal(guard.message.response.request_id, guard.wireId)
        if (guard.guard === 'unsupported') assert.equal(guard.message.response.subtype, 'error')
        else {
          assert.equal(guard.message.response.subtype, 'success')
          assert.deepEqual(guard.message.response.response, { action: 'decline' })
        }
      }
    }
  }
  await harness.flush()
  const beforeShutdown = await Promise.all(records.map((record) => harness.thread(record.prompt)))
  const providerPids = [...new Set(records.map((record) => record.started.pid))]
  const shutdown = await harness.shutdown(scenario.close, providerPids)
  if (gate) harness.gate.disarm()
  if (scenario.kind === 'offline-completion') {
    await harness.release(original.thread.remoteId, 'finish')
    await waitUntil(
      () =>
        harness.log().some((entry) => entry.kind === 'turn-completed' && entry.prompt === prompt),
      'the original provider completes while no Life process or SSH attachment exists',
    )
    assert.equal(harness.fixture.clients.size, 0)
  }
  if (scenario.kind === 'split-byte-frame') await harness.release(original.thread.remoteId, 'split')
  const recoveryStarted = performance.now()
  await harness.reopen()
  await harness.select(original)
  const restoredInitially = await Promise.all(
    records.map((record) => harness.thread(record.prompt)),
  )
  const recoveredEvents = () => harness.page.evaluate(() => window.__activeRecoveryEvents)
  if (baseline) {
    // Observation only: never retry a prompt or approval through a new native process.
    // Completion delivered while closed is invisible in this historical implementation.
    for (const record of records) {
      if (
        !record.awaitingInitialSubmission &&
        scenario.kind !== 'child-only' &&
        !scenario.kind.includes('approval') &&
        scenario.kind !== 'offline-completion'
      ) {
        await harness.release(record.thread.remoteId, 'middle')
        await waitUntil(
          () =>
            harness
              .log()
              .some(
                (entry) =>
                  entry.kind === 'middle-emitted' && entry.threadId === record.thread.remoteId,
              ),
          'the original provider emits a standalone append after the baseline cold-reopens',
        )
        await harness.release(record.thread.remoteId, 'finish')
      }
    }
    if (scenario.kind === 'child-only')
      await harness.release(original.thread.remoteId, 'child-finish')
    await new Promise((done) => setTimeout(done, 3000))
    const afterObservation = await Promise.all(
      records.map((record) => harness.thread(record.prompt)),
    )
    const events = await recoveredEvents()
    let recovered
    if (scenario.kind.startsWith('pending-approval')) {
      const allow = harness.page.locator('.approval-card').getByRole('button', {
        name: 'Allow once',
        exact: true,
      })
      recovered = (await allow.count()) === 1 && (await allow.isEnabled())
      assert.equal(permissionResponses(harness, original).length, 0)
    } else if (original.awaitingInitialSubmission) {
      recovered =
        afterObservation[0]?.remoteId === original.thread.remoteId &&
        harness.log().some((entry) => entry.kind === 'turn-started' && entry.prompt === prompt)
    } else if (scenario.kind.includes('approval')) {
      recovered = afterObservation[0]?.nativeRecoveryStatus === 'running'
    } else
      recovered = records.every((record, position) =>
        scenario.kind === 'child-only'
          ? afterObservation[position]?.messages?.some((message) => message?.text === CHILD_FINAL)
          : assistantReplies(
              afterObservation[position],
              scenario.kind === 'offline-completion' ? FINAL : WITH_MIDDLE,
            ).length === 1,
      )
    assert.equal(
      recovered,
      false,
      'The matched baseline exhibits missing actionable native recovery',
    )
    for (const record of records) {
      const submissions = harness
        .log()
        .filter((entry) => entry.kind === 'turn-started' && entry.prompt === record.prompt)
      assert.equal(submissions.length, record.awaitingInitialSubmission ? 0 : 1)
    }
    return {
      name,
      outcome: 'observed-missing-cold-recovery',
      shutdown,
      beforeShutdown,
      restoredInitially,
      afterObservation,
      recoveredEvents: events,
      nativeBoundary: original.nativeReplyBoundary,
      approval,
      completionIntentionallyNotAuthorized: scenario.kind.startsWith('pending-approval'),
      gate: harness.gate.proof,
      opaqueArchiveSha256: await harness.assertOpaque(),
      recoveryObservationMs: performance.now() - recoveryStarted,
    }
  }
  if (original.awaitingInitialSubmission) {
    // Ordinary starts have no privately claimed Studio startup reservation.
    // A created upstream thread alone cannot authorize its unadmitted user turn.
    let blockedOwner
    await waitUntil(() => {
      const observed = harness.observeNativeRecovery()
      blockedOwner = observed.records
        .filter((entry) => entry.kind === 'recover-fulfilled')
        .flatMap((entry) => entry.value.result.owners)
        .findLast(
          (owner) =>
            owner.sessionId === original.thread.id &&
            owner.remoteId === original.thread.remoteId &&
            owner.status === 'unknown',
        )
      return Boolean(blockedOwner)
    }, 'genuine Main recovery retains the unadmitted original native start as unknown')
    assert.match(blockedOwner.message, /startup intent|private source proof/i)

    let retained
    await waitUntil(async () => {
      retained = await harness.thread(prompt)
      return retained?.remoteId === original.nativeReplyBoundary.native.result.thread.id
    }, 'the retained unadmitted conversation binds the exact original native thread identity')
    assert.equal(retained.id, original.thread.id)
    assert.equal(retained.profileId, original.thread.profileId)
    assert.equal(retained.workspace, original.thread.workspace)
    assert.equal(retained.remoteId, original.thread.remoteId)
    assert.deepEqual(retained.messages, beforeShutdown[0].messages)
    assert.equal(original.nativeReplyBoundary.native.result.thread.id, original.thread.remoteId)
    const users = retained.messages.filter(
      (message) => message.role === 'user' && message.text === prompt,
    )
    const originalUser = beforeShutdown[0].messages.find(
      (message) => message.role === 'user' && message.text === prompt,
    )
    assert.equal(users.length, 1)
    assert.equal(users[0].id, originalUser.id)
    assert.equal(users[0].createdAt, originalUser.createdAt)
    assert.equal(harness.log().filter((entry) => entry.kind === 'turn-started').length, 0)
    assert.equal(harness.log().filter((entry) => entry.kind === 'thread-started').length, 1)
    assert.equal(harness.log().filter((entry) => entry.kind === 'writer-conflict').length, 0)
    assert.deepEqual(
      harness
        .log()
        .filter((entry) => entry.kind === 'provider-started' && entry.argv.includes('app-server'))
        .map((entry) => entry.pid),
      [original.started.pid],
    )
    assert.doesNotThrow(
      () => process.kill(original.started.pid, 0),
      'The original native provider remains alive',
    )
    return {
      name,
      outcome: 'verified-unadmitted-native-start-retained-without-resubmission',
      blockedOwner,
      shutdown,
      beforeShutdown,
      restoredInitially,
      retained,
      nativeBoundary: original.nativeReplyBoundary,
      gate: harness.gate.proof,
      opaqueArchiveSha256: await harness.assertOpaque(),
      recoveryObservationMs: performance.now() - recoveryStarted,
    }
  }
  if (scenario.kind.startsWith('pending-approval')) {
    const recoveredApproval = await harness.approval(prompt)
    assert.equal(
      recoveredApproval.requestId,
      approval.requestId,
      'The original pending request retains its stable local identity',
    )
    await harness.approve()
    await waitUntil(
      () => permissionResponses(harness, original).length === 1,
      'the original provider consumes exactly one native permission response after recovery',
    )
  } else if (scenario.kind === 'approval-before-accept') {
    await waitUntil(
      () => permissionResponses(harness, original).length === 1,
      'the persisted exact outbox envelope is accepted once by its original broker',
    )
  } else if (scenario.kind === 'approval-before-ack') {
    await waitUntil(
      async () =>
        (await harness.page
          .locator('.approval-card')
          .getByRole('button', {
            name: 'Allow once',
            exact: true,
          })
          .count()) === 0,
      'an already answered native approval is not resurrected by output replay',
    )
    assert.equal(permissionResponses(harness, original).length, 1)
  }
  if (scenario.kind === 'child-only') {
    const child = harness.log().find((entry) => entry.kind === 'child-started')
    const childItem = harness
      .log()
      .find((entry) => entry.kind === 'turn-started' && entry.threadId === child.childId).itemId
    const initialChild = (await harness.thread(prompt)).messages.filter(
      (message) => message?.role === 'assistant' && message.id.includes(childItem),
    )
    assert.equal(initialChild.length, 1)
    assert.equal(initialChild[0].text, 'Recovered child ')
    await harness.release(child.childId, 'child-middle')
    await waitUntil(async () => {
      const messages = (await harness.thread(prompt)).messages.filter(
        (message) => message?.role === 'assistant' && message.id.includes(childItem),
      )
      return messages.length === 1 && messages[0].text === 'Recovered child intermediate Ω '
    }, 'a fresh append from the original active child updates its restored output before completion')
    await harness.release(original.thread.remoteId, 'child-finish')
    await waitUntil(async () => {
      const messages = (await harness.thread(prompt)).messages
      const outputs = messages.filter(
        (message) =>
          message?.role === 'assistant' &&
          message.id.includes(childItem) &&
          message.text === 'Recovered child intermediate Ω café 漢字 🧪',
      )
      const finished = messages.some(
        (message) =>
          message?.kind === 'subagent' &&
          message.status === 'completed' &&
          message.details?.lifecycle === 'turn' &&
          message.agentId === child.childId,
      )
      return outputs.length === 1 && finished
    }, 'the completed root receives the original active child’s final exact text')
  } else {
    if (scenario.kind !== 'offline-completion') {
      for (let position = 0; position < records.length; position++) {
        const record = records[position]
        await harness.select(record)
        let partial
        await waitUntil(async () => {
          const current = await harness.thread(record.prompt)
          partial = assistantReplies(current, INITIAL)[0]
          return (
            current?.busy &&
            partial?.id.includes(record.started.itemId) &&
            assistantReplies(current, INITIAL).length === 1
          )
        }, 'the exact original partial item is active before any final snapshot can replace it')
        const prior = assistantReplies(beforeShutdown[position], INITIAL)[0]
        if (prior) {
          assert.equal(partial.id, prior.id)
          assert.equal(partial.createdAt, prior.createdAt)
        }
        const stop = harness.page.getByRole('button', {
          name: 'Stop agent and pause queued messages',
          exact: true,
        })
        await stop.waitFor()
        assert.equal(
          await stop.isEnabled(),
          true,
          'The actual renderer admits native control ownership',
        )
        await harness.release(record.thread.remoteId, 'middle')
        await waitUntil(async () => {
          const current = await harness.thread(record.prompt)
          const updated = assistantReplies(current, INITIAL + MIDDLE)
          return updated.length === 1 && updated[0].id === partial.id && current.busy
        }, 'a fresh standalone native append updates the restored partial without a complete snapshot')
        const events = await recoveredEvents()
        assert.equal(
          events.filter(
            (event) =>
              event.sessionId === record.thread.id &&
              event.itemId === record.started.itemId &&
              event.type === 'text' &&
              event.text === MIDDLE &&
              event.status !== 'replace',
          ).length,
          1,
        )
      }
    }
    for (const record of records) await harness.release(record.thread.remoteId, 'finish')
    for (const record of records)
      await waitUntil(async () => {
        const current = await harness.thread(record.prompt)
        return (
          !current?.busy &&
          assistantReplies(current, scenario.kind === 'offline-completion' ? FINAL : WITH_MIDDLE)
            .length === 1
        )
      }, 'complete output and final status recover without duplicate appended text')
  }
  const afterRecovery = []
  for (const record of records) {
    const current = await harness.assertOwnership(record)
    if (scenario.kind !== 'child-only')
      assert.equal(
        assistantReplies(current, scenario.kind === 'offline-completion' ? FINAL : WITH_MIDDLE)
          .length,
        1,
      )
    assert.equal(
      harness
        .log()
        .filter(
          (entry) => entry.kind === 'provider-initialized' && entry.pid === record.started.pid,
        ).length,
      1,
      'Reattaching to an existing stdio transport never reinitializes its native connection',
    )
    afterRecovery.push(current)
  }
  if (scenario.kind.includes('approval')) {
    const responses = permissionResponses(harness, original)
    assert.equal(responses.length, 1)
    const response = responses[0]
    const request = response.originalRequest
    const wireId = scenario.provider === 'codex' ? request.id : request.request_id
    assert.equal(
      response.wireId,
      wireId,
      'The original native request ID and its number/string type survive',
    )
    if (scenario.provider === 'codex') assert.equal(response.message.result.decision, 'accept')
    else {
      assert.equal(response.message.response.response.behavior, 'allow')
      assert.deepEqual(response.message.response.response.updatedInput, request.request.input)
    }
    if (gate) {
      assert.equal(sha256(JSON.stringify(response.message)), sha256(JSON.stringify(gate.native)))
      const inputs = harness.gate.proof.filter(
        (entry) =>
          entry.kind === 'broker-input-observed' &&
          entry.brokerId === gate.brokerId &&
          entry.wireSha256 === gate.wireSha256,
      )
      assert.ok(inputs.length)
      assert.ok(inputs.every((entry) => entry.sequence === gate.sequence))
      if (scenario.kind === 'approval-before-accept')
        assert.ok(
          inputs.length >= 2,
          'The exact original numbered bytes are retransmitted once admitted',
        )
      else
        assert.ok(
          inputs.length >= 2 ||
            harness.gate.proof.some(
              (entry) =>
                entry.kind === 'broker-ready-observed' &&
                entry.brokerId === gate.brokerId &&
                entry.launch === false &&
                entry.lastInputSequence >= gate.sequence,
            ),
          'The accepted response is retried verbatim or reconciled against its real broker high-water',
        )
    }
    assert.equal((await harness.thread(prompt)).pending.length, 0)
  }
  assert.equal(harness.log().filter((entry) => entry.kind === 'unexpected-response').length, 0)
  if (scenario.guards) {
    const responses = harness.log().filter((entry) => entry.kind === 'guard-response')
    assert.deepEqual(
      responses,
      guardResponsesBefore,
      'Replay does not regenerate native clock, error, elicitation or dialog responses',
    )
    const dialogs = harness
      .log()
      .filter(
        (entry) =>
          entry.kind === 'guard-request' &&
          entry.request?.request?.subtype === 'request_user_dialog',
      )
    for (const dialog of dialogs)
      assert.equal(
        responses.filter((entry) => entry.wireId === dialog.request.request_id).length,
        0,
        'An undeclared native user dialog remains unanswered',
      )
  }
  return {
    name,
    outcome: 'verified-original-native-session-recovered',
    shutdown,
    beforeShutdown,
    restoredInitially,
    afterRecovery,
    recoveredEvents: await recoveredEvents(),
    nativeBoundary: original.nativeReplyBoundary,
    approval,
    gate: harness.gate.proof,
    opaqueArchiveSha256: await harness.assertOpaque(),
    recoveryToFinalSnapshotMs: performance.now() - recoveryStarted,
  }
}

async function runStudioScenario(harness, scenario, index) {
  const name = `${scenario.provider}-${scenario.kind}-${scenario.close}`
  const prompt = `LIFE_RECOVERY_${scenario.mode}:  Restore Studio ${index}\n\tExact original request café 漢字 🧪  \n`
  await harness.setup(name, { studio: true })
  const sourceBefore = await harness.page.evaluate(() => window.relay.sourceCode.get())
  const record = await harness.sendStudio(scenario.provider, prompt)
  const starts = () =>
    harness.log().filter((entry) => entry.kind === 'turn-started' && entry.prompt === prompt)
  const current = () => harness.studioSession(prompt)
  const advanceTo = async (phase) => {
    await harness.release(record.session.thread.remoteId, 'finish')
    await waitUntil(
      () => starts().some((entry) => entry.phase === phase),
      `the actual native Studio planner continues with its ${phase} instruction files`,
      phase === 'repair' ? 90000 : 20000,
    )
    await waitUntil(async () => {
      const session = await current()
      return session?.thread.busy && session.stage === 'planning'
    }, 'the continuing Studio planner stage is durably saved')
  }
  if (scenario.phase !== 'request') await advanceTo('source-read')
  if (scenario.phase === 'repair') await advanceTo('repair')
  const activeNativeTurn = starts().at(-1)
  let originalPartial
  await waitUntil(async () => {
    const session = await current()
    originalPartial = session?.thread?.messages?.find(
      (message) =>
        message?.role === 'assistant' &&
        message.id.includes(activeNativeTurn.itemId) &&
        message.text === STUDIO_INITIAL,
    )
    return session?.stage === 'planning' && session.thread.busy && Boolean(originalPartial)
  }, 'the current native Studio partial response is saved before a cold crash')
  await harness.page.evaluate(async () => {
    if (typeof window.__lifeFlushStudioHistory !== 'function')
      throw new Error('The actual Studio history checkpoint is unavailable')
    await window.__lifeFlushStudioHistory()
  })
  const beforeShutdown = await current()
  const expectedTurns = scenario.phase === 'request' ? 1 : scenario.phase === 'source-read' ? 2 : 3
  assert.equal(starts().length, expectedTurns)
  assert.ok(starts().every((entry) => entry.threadId === record.session.thread.remoteId))
  assert.ok(starts().every((entry) => entry.pid === record.started.pid))
  const shutdown = await harness.shutdown('crash', [record.started.pid])
  const recoveryStarted = performance.now()
  await harness.reopen()
  await harness.openStudio()
  const restoredInitially = await current()
  if (baseline) {
    await harness.release(record.session.thread.remoteId, 'middle')
    await waitUntil(
      () =>
        harness
          .log()
          .some(
            (entry) => entry.kind === 'middle-emitted' && entry.turnId === activeNativeTurn.turnId,
          ),
      'the original Studio provider emits the matched middle append while baseline ownership is inert',
    )
    await harness.release(record.session.thread.remoteId, 'finish')
    await waitUntil(
      () =>
        harness
          .log()
          .some(
            (entry) =>
              entry.kind === 'turn-completed' &&
              entry.prompt === prompt &&
              entry.turnId === starts().at(-1).turnId,
          ),
      'the original Studio provider completes after the baseline has cold-reopened',
    )
    await new Promise((done) => setTimeout(done, 3000))
    const afterObservation = await current()
    const source = await harness.page.evaluate(() => window.relay.sourceCode.get())
    const config = await harness.page.evaluate(() => window.relay.customization.get())
    assert.equal(
      starts().length,
      expectedTurns,
      'The baseline never re-submits the planner request',
    )
    if (scenario.mode === 'STUDIO_READ') assert.notEqual(config.config.theme, 'light')
    else assert.equal(source.active?.revision, sourceBefore.active?.revision)
    assert.notEqual(afterObservation?.stage, 'complete')
    return {
      name,
      outcome: 'observed-missing-native-studio-planner-recovery',
      beforeShutdown,
      restoredInitially,
      afterObservation,
      source,
      config,
      shutdown,
      opaqueArchiveSha256: await harness.assertOpaque(),
      opaqueStudioArchiveSha256: await harness.assertStudioOpaque(),
      recoveryObservationMs: performance.now() - recoveryStarted,
    }
  }
  await waitUntil(
    async () => (await current())?.id === record.session.id,
    'the actual saved Studio session hydrates before inspecting its recovered native identity',
  )
  const studioDialog = harness.page.getByRole('dialog', { name: 'Customize Life', exact: true })
  const studioSearch = studioDialog.getByRole('textbox', {
    name: 'Search customization conversations',
    exact: true,
  })
  await studioSearch.fill(prompt.split('\n')[0])
  const restoredRow = studioDialog.locator('.studio-session')
  assert.equal(
    await restoredRow.count(),
    1,
    'The exact original Studio request selects one recovered conversation',
  )
  await restoredRow.click()
  await studioSearch.fill('')
  const activeRestored = await current()
  assert.equal(activeRestored.id, record.session.id)
  assert.equal(activeRestored.thread.id, record.session.thread.id)
  assert.equal(activeRestored.thread.remoteId, record.session.thread.remoteId)
  assert.equal(activeRestored.thread.profileId, record.session.thread.profileId)
  assert.equal(activeRestored.thread.workspace, record.session.thread.workspace)
  const stop = harness.page.getByRole('button', { name: 'Stop customization', exact: true })
  await waitUntil(async () => {
    const session = await current()
    const partials =
      session?.thread?.messages?.filter(
        (message) =>
          message?.role === 'assistant' &&
          message.id === originalPartial.id &&
          message.text === STUDIO_INITIAL,
      ) || []
    return (
      partials.length === 1 &&
      partials[0].createdAt === originalPartial.createdAt &&
      session.stage === 'planning' &&
      session.thread.busy &&
      (await stop.count()) === 1 &&
      (await stop.isEnabled())
    )
  }, 'the actual Studio UI restores the current partial and actionable native planner ownership')
  await harness.release(record.session.thread.remoteId, 'middle')
  await waitUntil(
    () =>
      harness
        .log()
        .some(
          (entry) => entry.kind === 'middle-emitted' && entry.turnId === activeNativeTurn.turnId,
        ),
    'the existing native Studio iteration emits a standalone proposal prefix append',
  )
  const middle = harness
    .log()
    .find((entry) => entry.kind === 'middle-emitted' && entry.turnId === activeNativeTurn.turnId)
  await waitUntil(async () => {
    const session = await current()
    const partials =
      session?.thread?.messages?.filter(
        (message) =>
          message?.role === 'assistant' &&
          message.id === originalPartial.id &&
          message.text === middle.text,
      ) || []
    return partials.length === 1 && session.stage === 'planning' && session.thread.busy
  }, 'a fresh append updates the restored Studio partial before canonical completion can replace it')
  assert.equal(starts().length, expectedTurns, 'Partial replay cannot start a planner continuation')
  // Each finish releases the already-running turn. A source-read/repair is an
  // authorized planner continuation, not replay of the primary user turn.
  await harness.release(record.session.thread.remoteId, 'finish')
  if (scenario.phase === 'request') {
    await waitUntil(
      () => starts().some((entry) => entry.phase === 'source-read'),
      'the recovered planner performs its original source-read continuation once',
    )
    await harness.release(record.session.thread.remoteId, 'finish')
  }
  if (scenario.mode === 'STUDIO_READ') {
    await waitUntil(async () => {
      const session = await current()
      const config = await harness.page.evaluate(() => window.relay.customization.get())
      return (
        session?.stage === 'complete' && !session.thread.busy && config.config.theme === 'light'
      )
    }, 'the recovered planner interprets and applies its actual settings proposal')
  } else {
    await waitForNativeSource(harness)
    assert.equal(
      await harness.page.getByTestId('life-active-recovery-source').innerText(),
      scenario.mode === 'STUDIO_REPAIR' ? 'Recovery source repaired' : 'Recovery source verified',
    )
    await harness.page.locator('.app-shell').waitFor()
    await waitUntil(async () => {
      const session = await current()
      return session?.stage === 'complete' && !session.thread.busy
    }, 'the recovered source planner finishes after its native compiled interface reloads')
  }
  const afterRecovery = await current()
  const finalTurns = scenario.mode === 'STUDIO_REPAIR' ? 3 : 2
  assert.equal(starts().length, finalTurns)
  assert.deepEqual(
    starts().map((entry) => entry.phase),
    scenario.mode === 'STUDIO_REPAIR'
      ? ['request', 'source-read', 'repair']
      : ['request', 'source-read'],
    'Each original planner action produces exactly one legitimate native continuation',
  )
  assert.ok(starts().every((entry) => entry.threadId === record.session.thread.remoteId))
  assert.ok(starts().every((entry) => entry.pid === record.started.pid))
  assert.equal(
    afterRecovery.thread.messages.filter(
      (message) => message?.role === 'user' && message.text === prompt,
    ).length,
    1,
    'Studio history retains exactly one original user request through planner continuations',
  )
  assert.equal(
    harness
      .log()
      .filter((entry) => entry.kind === 'provider-initialized' && entry.pid === record.started.pid)
      .length,
    1,
  )
  const sourceAfter = await harness.page.evaluate(() => window.relay.sourceCode.get())
  const actionReceipts = await harness.studioActionReceipts(record.session.id)
  const countAction = (kind, status) =>
    actionReceipts.filter((receipt) => receipt.kind === kind && receipt.status === status).length
  const sourceReads = actionReceipts.filter(
    (receipt) => receipt.kind === 'source-read' && receipt.status === 'succeeded',
  )
  const countRead = (purpose) =>
    sourceReads.filter((receipt) => receipt.intent?.purpose === purpose).length
  assert.equal(countRead('initial'), 1)
  assert.equal(countRead('source-read'), 1)
  assert.equal(countRead('repair-index'), scenario.mode === 'STUDIO_REPAIR' ? 1 : 0)
  assert.equal(countRead('repair-files'), scenario.mode === 'STUDIO_REPAIR' ? 1 : 0)
  assert.equal(sourceReads.length, scenario.mode === 'STUDIO_REPAIR' ? 4 : 2)
  assert.equal(
    actionReceipts.filter((receipt) => !['succeeded', 'failed'].includes(receipt.status)).length,
    0,
    'Every completed planner action has authoritative terminal native evidence',
  )
  for (const receipt of actionReceipts.filter((entry) => entry.status === 'succeeded')) {
    assert.equal(receipt.native.actionId, receipt.actionId)
    assert.equal(receipt.native.transportId, receipt.transportId)
    assert.equal(receipt.native.ownerGeneration, receipt.ownerGeneration)
  }
  if (scenario.mode === 'STUDIO_READ') {
    assert.equal(countAction('settings-apply', 'succeeded'), 1)
    assert.equal(countAction('source-apply', 'succeeded'), 0)
  }
  if (scenario.mode !== 'STUDIO_READ') {
    assert.equal(countAction('source-apply', 'succeeded'), 1)
    assert.equal(countAction('source-apply', 'failed'), scenario.mode === 'STUDIO_REPAIR' ? 1 : 0)
    assert.equal(countAction('reload', 'succeeded'), 1)
    assert.equal(sourceAfter.enabled, true)
    assert.equal(sourceAfter.error, undefined)
    assert.equal(sourceAfter.extensions.filter((extension) => !extension.builtIn).length, 1)
    const context = await harness.page.evaluate(() =>
      window.relay.sourceCode.getContext({ paths: ['src/renderer/App.tsx'] }),
    )
    const source = context.files.find((file) => file.path === 'src/renderer/App.tsx').content
    assert.equal(source.split('data-testid="life-active-recovery-source"').length - 1, 1)
    assert.equal(
      starts().filter((entry) => entry.phase === 'repair').length,
      scenario.mode === 'STUDIO_REPAIR' ? 1 : 0,
    )
    const nativeState = JSON.parse(await readFile(join(sourceAfter.path, 'state.json'), 'utf8'))
    const successfulApply = actionReceipts.find(
      (entry) => entry.kind === 'source-apply' && entry.status === 'succeeded',
    )
    const committedMarkers = nativeState.recoveryActions.filter(
      (entry) => entry.actionId === successfulApply.actionId,
    )
    assert.equal(committedMarkers.length, 1)
    assert.equal(committedMarkers[0].intentHash, successfulApply.intentHash)
    assert.equal(
      committedMarkers[0].revision ?? committedMarkers[0].snapshot?.active?.revision,
      sourceAfter.active.revision,
    )
  }
  return {
    name,
    outcome: 'verified-native-studio-planner-recovered',
    shutdown,
    beforeShutdown,
    restoredInitially,
    afterRecovery,
    sourceBefore,
    sourceAfter,
    actionReceipts,
    opaqueArchiveSha256: await harness.assertOpaque(),
    opaqueStudioArchiveSha256: await harness.assertStudioOpaque(),
    recoveryToFinalSnapshotMs: performance.now() - recoveryStarted,
  }
}

async function runFailedHistoryScenario(harness, scenario, index) {
  const name = `${scenario.provider}-${scenario.kind}-${scenario.close}`
  const prompt = `LIFE_RECOVERY_STREAM:  Unacknowledged history ${index}\n\tExact user input café 漢字 🧪  \n`
  await harness.setup(name)
  const record = await harness.send(scenario.provider, prompt)
  await waitUntil(
    async () => assistantReplies(await harness.thread(prompt), INITIAL).length === 1,
    'the initial response reaches a successful native history checkpoint',
  )
  await harness.flush()
  const beforeFailure = await harness.thread(prompt)
  const originalUser = beforeFailure.messages.find(
    (message) => message?.role === 'user' && message.text === prompt,
  )
  const originalPartial = assistantReplies(beforeFailure, INITIAL)[0]
  const failureBoundary = await harness.blockHistoryWrites()
  await harness.release(record.thread.remoteId, 'middle')
  await waitUntil(
    async () =>
      (
        await harness.page.locator(`[data-message-id="${originalPartial.id}"]`).innerText()
      ).includes(MIDDLE.trim()),
    'fresh native output is visible while both history stores are unwritable',
  )
  await harness.flush()
  await waitUntil(
    async () =>
      (await harness.page.locator('body').innerText()).includes(
        'Conversation history could not be saved to disk or the local cache',
      ),
    'both native checkpoint and admitted local cache fail before the crash',
  )
  const cacheFailures = await harness.page.evaluate(() => window.__historyCacheFailures)
  assert.ok(cacheFailures.includes('relay.threads.v1'))
  const shutdown = await harness.shutdown('crash', [record.started.pid])
  await harness.restoreHistoryWrites()
  await harness.reopen()
  await harness.select(record)
  if (baseline) {
    const restored = await harness.thread(prompt)
    assert.equal(assistantReplies(restored, INITIAL + MIDDLE).length, 0)
    assert.equal(assistantReplies(restored, INITIAL).length, 1)
    await harness.release(record.thread.remoteId, 'finish')
    await waitUntil(
      () =>
        harness.log().some((entry) => entry.kind === 'turn-completed' && entry.prompt === prompt),
      'the unchanged original native provider completes after the failed-ACK baseline reopens',
    )
    const user = restored.messages.find(
      (message) => message?.role === 'user' && message.text === prompt,
    )
    assert.equal(user.id, originalUser.id)
    assert.equal(user.createdAt, originalUser.createdAt)
    assert.equal(
      harness.log().filter((entry) => entry.kind === 'turn-started' && entry.prompt === prompt)
        .length,
      1,
    )
    return {
      name,
      outcome: 'observed-unacknowledged-output-unrecovered',
      beforeFailure,
      restored,
      failureBoundary,
      cacheFailures,
      shutdown,
      opaqueArchiveSha256: await harness.assertOpaque(),
    }
  }
  await waitUntil(async () => {
    const current = await harness.thread(prompt)
    const partial = assistantReplies(current, INITIAL + MIDDLE)
    return (
      current?.busy &&
      partial.length === 1 &&
      partial[0].id === originalPartial.id &&
      partial[0].createdAt === originalPartial.createdAt
    )
  }, 'the native ledger restores output excluded from both acknowledged history stores')
  const stop = harness.page.getByRole('button', {
    name: 'Stop agent and pause queued messages',
    exact: true,
  })
  await stop.waitFor()
  assert.equal(await stop.isEnabled(), true)
  await harness.release(record.thread.remoteId, 'finish')
  await waitUntil(async () => {
    const current = await harness.thread(prompt)
    return !current?.busy && assistantReplies(current, WITH_MIDDLE).length === 1
  }, 'retained output and original completion settle once after history persistence resumes')
  const afterRecovery = await harness.assertOwnership(record)
  const user = afterRecovery.messages.find(
    (message) => message?.role === 'user' && message.text === prompt,
  )
  assert.equal(user.id, originalUser.id)
  assert.equal(user.createdAt, originalUser.createdAt)
  const finalReply = assistantReplies(afterRecovery, WITH_MIDDLE)[0]
  // The unchanged native item reveals its phase in the completed snapshot.
  // Life uses that native phase in the projected key, while retaining origin time.
  assert.equal(
    finalReply.id,
    scenario.provider === 'codex' ? `${originalPartial.id}:final_answer` : originalPartial.id,
  )
  assert.equal(
    finalReply.phase,
    scenario.provider === 'codex' ? 'final_answer' : originalPartial.phase,
  )
  assert.equal(finalReply.createdAt, originalPartial.createdAt)
  return {
    name,
    outcome: 'verified-native-tail-retained-without-history-ack',
    beforeFailure,
    afterRecovery,
    failureBoundary,
    cacheFailures,
    shutdown,
    opaqueArchiveSha256: await harness.assertOpaque(),
  }
}

async function runStopScenario(harness, scenario, index) {
  const name = `${scenario.provider}-${scenario.kind}-${scenario.close}`
  const prompt = `LIFE_RECOVERY_STOP:  Preserve explicit Stop ${index}\n\tOne original user request café 漢字 🧪  \n`
  await harness.setup(name)
  const record = await harness.send(scenario.provider, prompt)
  await waitUntil(
    async () => assistantReplies(await harness.thread(prompt), INITIAL).length === 1,
    'the exact partial turn is durably saved before the explicit Stop action',
  )
  await harness.flush()
  const beforeStop = await harness.thread(prompt)
  const originalUser = beforeStop.messages.find(
    (message) => message?.role === 'user' && message.text === prompt,
  )
  const gate = harness.gate.arm('before-ack', { selector: 'interrupt', blockOutput: true })
  await harness.page
    .getByRole('button', {
      name: 'Stop agent and pause queued messages',
      exact: true,
    })
    .click()
  await waitUntil(
    () => gate.blocked && harness.log().some((entry) => entry.kind === 'interrupt-accepted'),
    'the actual native interrupt is accepted but its broker ACK and completion are unavailable to Life',
  )
  assert.equal(harness.log().filter((entry) => entry.kind === 'interrupt-completed').length, 0)
  const shutdown = await harness.shutdown('crash', [record.started.pid])
  harness.gate.disarm()
  await harness.reopen()
  await harness.select(record)
  await harness.release(record.thread.remoteId, 'interrupt-finish')
  await waitUntil(
    () => harness.log().filter((entry) => entry.kind === 'interrupt-completed').length === 1,
    'the original accepted interrupt completes without another native interruption',
  )
  if (baseline) {
    await new Promise((done) => setTimeout(done, 1500))
    const events = await harness.page.evaluate(() => window.__activeRecoveryEvents)
    assert.equal(
      events.some(
        (event) =>
          event.sessionId === record.thread.id &&
          event.type === 'complete' &&
          event.status === 'interrupted',
      ),
      false,
    )
    assert.equal(
      harness.log().filter((entry) => entry.kind === 'turn-started' && entry.prompt === prompt)
        .length,
      1,
    )
    assert.equal(harness.log().filter((entry) => entry.kind === 'interrupt-duplicate').length, 0)
    return {
      name,
      outcome: 'observed-explicit-stop-owner-unrecovered',
      beforeStop,
      restored: await harness.thread(prompt),
      shutdown,
      gate: harness.gate.proof,
      opaqueArchiveSha256: await harness.assertOpaque(),
    }
  }
  await waitUntil(async () => {
    const current = await harness.thread(prompt)
    return !current?.busy && current.turnStatus === 'interrupted'
  }, 'the restored explicit Stop settles the original thread as interrupted')
  const afterRecovery = await harness.assertOwnership(record)
  const user = afterRecovery.messages.find(
    (message) => message?.role === 'user' && message.text === prompt,
  )
  assert.equal(user.id, originalUser.id)
  assert.equal(user.createdAt, originalUser.createdAt)
  assert.equal(assistantReplies(afterRecovery, INITIAL).length, 1)
  assert.equal(harness.log().filter((entry) => entry.kind === 'interrupt-accepted').length, 1)
  assert.equal(harness.log().filter((entry) => entry.kind === 'interrupt-duplicate').length, 0)
  const inputs = harness.gate.proof.filter(
    (entry) =>
      entry.kind === 'broker-input-observed' &&
      entry.brokerId === gate.brokerId &&
      entry.wireSha256 === gate.wireSha256,
  )
  assert.ok(inputs.length)
  assert.ok(
    inputs.every((entry) => entry.sequence === gate.sequence),
    'Any pending Stop retransmission retains its original numbered native bytes',
  )
  const archiveHash = await harness.assertOpaque()
  const idleRelease = await harness.shutdown('quit', [record.started.pid], { active: false })
  return {
    name,
    outcome: 'verified-explicit-stop-resumes-without-duplicate-command',
    beforeStop,
    afterRecovery,
    shutdown,
    idleRelease,
    gate: harness.gate.proof,
    opaqueArchiveSha256: archiveHash,
  }
}

async function runSourceCommitScenario(harness, scenario, index) {
  const name = `${scenario.provider}-source-apply-commit-gap`
  const prompt = `LIFE_RECOVERY_STUDIO_PATCH:  Source receipt crash ${index}\n\tKeep this native request exact café 漢字 🧪  \n`
  await harness.setup(name, { studio: true })
  const record = await harness.sendStudio(scenario.provider, prompt)
  const starts = () =>
    harness.log().filter((entry) => entry.kind === 'turn-started' && entry.prompt === prompt)
  await harness.release(record.session.thread.remoteId, 'finish')
  await waitUntil(
    () => starts().some((entry) => entry.phase === 'source-read'),
    'the owned planner receives the actual source before creating its apply intent',
  )
  const sourceBefore = await harness.page.evaluate(() => window.relay.sourceCode.get())
  const revisionsPath = join(sourceBefore.path, 'revisions')
  const revisionsBefore = await readdir(revisionsPath).catch((error) => {
    if (error.code === 'ENOENT') return []
    throw error
  })
  const terminalGate = harness.blockStartedSourceAction(record.session.id)
  await harness.release(record.session.thread.remoteId, 'finish')
  const boundary = await terminalGate
  let committedState
  await waitUntil(
    async () => {
      try {
        committedState = JSON.parse(await readFile(join(sourceBefore.path, 'state.json'), 'utf8'))
      } catch (error) {
        if (error.code === 'ENOENT') return false
        throw error
      }
      return committedState.recoveryActions?.some((entry) => entry.actionId === boundary.actionId)
    },
    'Source activation commits its native action marker while terminal ledger writes are blocked',
    90000,
  )
  const marker = committedState.recoveryActions.find(
    (entry) => entry.actionId === boundary.actionId,
  )
  assert.equal(marker.intentHash, boundary.intentHash)
  const revision = marker.revision ?? marker.snapshot?.active?.revision
  assert.ok(Number.isSafeInteger(revision) && revision > 0)
  const compiled = join(revisionsPath, String(revision), 'dist', 'entry.js')
  const compiledSha256 = sha256(await readFile(compiled))
  const revisionsAtCommit = await readdir(revisionsPath)
  assert.equal(revisionsAtCommit.filter((entry) => !revisionsBefore.includes(entry)).length, 1)
  const shutdown = await harness.shutdown('crash', [record.started.pid])
  await harness.restoreActionTerminal()
  await harness.reopen()
  // An unclean custom-source shutdown deliberately starts the built-in interface.
  // Mount the real Studio so its original committed action can be reconciled,
  // without treating that historical receipt as permission to reactivate source.
  const sourceAfter = await harness.page.evaluate(() => window.relay.sourceCode.get())
  assert.equal(sourceAfter.enabled, false)
  assert.equal(sourceAfter.active, undefined)
  assert.equal(sourceAfter.recovered, true)
  assert.match(sourceAfter.error, /did not close cleanly/)
  assert.equal(await harness.page.getByTestId('life-active-recovery-source').count(), 0)
  const studioDialog = await harness.openStudio()
  await waitUntil(
    async () => (await harness.studioSession(prompt))?.id === record.session.id,
    'the exact saved Studio request hydrates after the source safety fallback',
  )
  const studioSearch = studioDialog.getByRole('textbox', {
    name: 'Search customization conversations',
    exact: true,
  })
  await studioSearch.fill(prompt.split('\n')[0])
  const restoredRow = studioDialog.locator('.studio-session')
  assert.equal(await restoredRow.count(), 1)
  await restoredRow.click()
  await studioSearch.fill('')
  await waitUntil(async () => {
    const receipts = await harness.studioActionReceipts(record.session.id)
    return (
      receipts.some((entry) => entry.kind === 'source-apply' && entry.status === 'succeeded') &&
      receipts.some((entry) => entry.kind === 'reload' && entry.status === 'unknown')
    )
  }, 'the original source commit reconciles once while disabled-source reload stays uncertain')
  const restored = await harness.studioSession(prompt)
  assert.equal(restored.id, record.session.id)
  assert.equal(restored.thread.id, record.session.thread.id)
  assert.equal(restored.thread.remoteId, record.session.thread.remoteId)
  assert.equal(restored.thread.busy, false)
  assert.equal(sha256(await readFile(compiled)), compiledSha256)
  assert.deepEqual(
    (await readdir(revisionsPath)).sort(),
    revisionsAtCommit.sort(),
    'Receipt reconciliation produces no second compiler generation',
  )
  const stateAfter = JSON.parse(await readFile(join(sourceAfter.path, 'state.json'), 'utf8'))
  assert.equal(
    stateAfter.recoveryActions.filter((entry) => entry.actionId === boundary.actionId).length,
    1,
  )
  const receipts = await harness.studioActionReceipts(record.session.id)
  const applies = receipts.filter((entry) => entry.kind === 'source-apply')
  assert.equal(applies.length, 1)
  assert.equal(applies[0].actionId, boundary.actionId)
  assert.equal(applies[0].status, 'succeeded')
  const reloads = receipts.filter((entry) => entry.kind === 'reload')
  assert.equal(reloads.length, 1)
  assert.equal(reloads[0].status, 'unknown')
  assert.match(reloads[0].error, /source revision is no longer active/)
  assert.equal(stateAfter.current, revision)
  assert.equal(stateAfter.enabled, false)
  assert.equal((await harness.page.evaluate(() => window.relay.sourceCode.get())).enabled, false)
  assert.equal(await harness.page.getByTestId('life-active-recovery-source').count(), 0)
  assert.deepEqual(
    starts().map((entry) => entry.phase),
    ['request', 'source-read'],
  )
  assert.ok(
    starts().every(
      (entry) =>
        entry.pid === record.started.pid && entry.threadId === record.session.thread.remoteId,
    ),
  )
  return {
    name,
    outcome: 'verified-source-commit-reconciled-with-crash-safety-fallback',
    scope: 'candidate-only new durable action protocol boundary',
    boundary,
    shutdown,
    sourceBefore,
    sourceAfter,
    committedRevision: revision,
    compiledSha256,
    receipts,
    revisionsBefore,
    revisionsAtCommit,
    opaqueArchiveSha256: await harness.assertOpaque(),
    opaqueStudioArchiveSha256: await harness.assertStudioOpaque(),
  }
}

async function main() {
  await mkdir(artifacts, { recursive: true })
  const fixtureBundle = join(artifacts, 'ssh-fixture.cjs')
  await build({
    entryPoints: [join(repository, 'tests/helpers/ssh-fixture.ts')],
    outfile: fixtureBundle,
    bundle: true,
    platform: 'node',
    format: 'cjs',
    packages: 'external',
  })
  if (helperOnly) {
    console.log(
      'Built only the disposable SSH fixture. No Electron or provider process was launched.',
    )
    return
  }
  assert.ok(
    existsSync(join(appPath, 'out/main/index.js')),
    'Build or select an immutable app snapshot first',
  )
  const { SSHFixture } = require(fixtureBundle)
  const proof = {
    fixture:
      'real Electron / real SSH-SFTP / dedicated native protocol stand-ins / cold process restart',
    authenticatedProviderUse: false,
    inferenceRequests: 0,
    appPath,
    baseline,
    fixtureMode: sourceCommitGap
      ? 'candidate-only source action protocol boundary'
      : 'matched 39-case cold restart matrix',
    timingInterpretation:
      'Elapsed observations include application launch, SSH interaction, fixture releases and compilation; they are not isolated startup or performance benchmarks.',
    fixtureSourceSha256: sha256(await readFile(__filename)),
    fixtureHelperSha256: sha256(
      await readFile(join(__dirname, 'helpers/active-session-recovery-steps.cjs')),
    ),
    sshFixtureBundleSha256: sha256(await readFile(fixtureBundle)),
    providerSourceSha256: sha256(
      await readFile(join(__dirname, 'helpers/active-session-recovery-provider.cjs')),
    ),
    mainSha256: sha256(await readFile(join(appPath, 'out/main/index.js'))),
    checkpointWorkerSha256: sha256(
      await readFile(join(appPath, 'out/main/conversation-checkpoint-worker.js')),
    ),
    cases: [],
    rendererErrors: [],
  }
  const selected = sourceCommitGap
    ? ['codex', 'claude'].map((provider) => ({
        provider,
        kind: 'source-apply-commit-gap',
        mode: 'STUDIO_PATCH',
        close: 'crash',
      }))
    : process.env.LIFE_TEST_RECOVERY_CASE
      ? scenarios.filter((scenario) =>
          `${scenario.provider}-${scenario.kind}-${scenario.close}`.includes(
            process.env.LIFE_TEST_RECOVERY_CASE,
          ),
        )
      : scenarios
  assert.ok(selected.length, 'The selected recovery scenario exists')
  let current
  let phase = 'setup'
  const timer = setInterval(() => console.log(`Active recovery smoke phase: ${phase}`), 30000)
  try {
    for (let index = 0; index < selected.length; index++) {
      const scenario = selected[index]
      phase = `${scenario.provider}/${scenario.kind}/${scenario.close}`
      current = new RecoveryHarness({ repository, appPath, artifacts, electron, SSHFixture, proof })
      const result = await (scenario.kind === 'source-apply-commit-gap'
        ? runSourceCommitScenario(current, scenario, index)
        : scenario.kind === 'stop-before-ack'
          ? runStopScenario(current, scenario, index)
          : scenario.kind === 'history-ack-failure'
            ? runFailedHistoryScenario(current, scenario, index)
            : scenario.kind.startsWith('studio-')
              ? runStudioScenario(current, scenario, index)
              : runScenario(current, scenario, index))
      result.providerLog = current.log()
      result.launches = current.launches
      result.shutdowns = current.shutdowns
      await current.saveEvidence(`${result.name}.json`, result)
      if (current.page)
        await current.page.screenshot({ path: join(artifacts, `${result.name}.png`) })
      proof.cases.push({ name: result.name, outcome: result.outcome })
      console.log(`PASS: ${result.name}: ${result.outcome}`)
      await current.close()
      current = undefined
      await writeFile(join(artifacts, 'proof.json'), JSON.stringify(proof, null, 2))
    }
    assert.deepEqual(proof.rendererErrors, [])
  } catch (error) {
    proof.failure = { phase, message: String(error), stack: error.stack }
    if (current) {
      const failure = {
        providerLog: current.fixture ? current.log() : [],
        gate: current.gate?.proof,
        nativeLogs: current.nativeLogs,
        launches: current.launches,
        shutdowns: current.shutdowns,
      }
      if (current.page) {
        await current.page.screenshot({ path: join(artifacts, 'failure.png') }).catch(() => {})
        failure.body = await current.page
          .locator('body')
          .innerText()
          .catch(() => '')
      }
      await writeFile(join(artifacts, 'failure.json'), JSON.stringify(failure, null, 2))
    }
    throw error
  } finally {
    clearInterval(timer)
    await writeFile(join(artifacts, 'proof.json'), JSON.stringify(proof, null, 2))
    await current?.close()
  }
}

main().catch((error) => {
  console.error(error)
  process.exitCode = 1
})
