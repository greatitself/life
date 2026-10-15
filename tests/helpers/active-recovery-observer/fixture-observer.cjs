// Observation completion only: original fixtures and production APIs are unchanged.
const assert = require('node:assert/strict')
const { mkdirSync, writeFileSync } = require('node:fs')
const { join, resolve } = require('node:path')
const { serialize } = require('./portable-wire.cjs')
const { hash, readTape, bindPermission, recoverPending } = require('./contract.cjs')

function install({ electron, RecoveryHarness, appPath, artifacts, baseline, mainObserver }) {
  let launchNumber = 0
  const applications = new WeakMap()
  const launches = new Map()
  const harnesses = new WeakMap()
  const observerDirectory = join(artifacts, 'observer')
  mkdirSync(observerDirectory, { recursive: true, mode: 0o700 })
  function state(harness) {
    let value = harnesses.get(harness)
    if (!value) {
      value = { originals: new Map(), approvalObservations: [] }
      harnesses.set(harness, value)
    }
    return value
  }
  function currentTape(harness) {
    const launch = applications.get(harness.application)
    assert.ok(launch, 'Only the current genuine Electron application can provide recovery results')
    assert.equal(launch.pid, harness.launches.at(-1).pid)
    return readTape(launch.tape, launch.pid, appPath)
  }
  // Read only the hash-verified current Main tape; never invoke recovery to create evidence.
  RecoveryHarness.prototype.observeNativeRecovery = function () {
    return currentTape(this)
  }
  async function agentTape(harness, label) {
    const events = await harness.page.evaluate(() => window.__activeRecoveryEvents)
    const bytes = serialize(events)
    const path = join(observerDirectory, `${harness.name}-${label}-${Date.now()}.dto.json`)
    writeFileSync(path, bytes, { mode: 0o600, flag: 'wx' })
    return { events, path, bytes: bytes.length, sha256: hash(bytes) }
  }
  async function assertHealthy(harness) {
    if (harness.application) {
      assert.deepEqual(applications.get(harness.application)?.failures, [])
      const failures = await harness.application.evaluate(
        () => globalThis.__lifeMainObserver?.failures,
      )
      assert.deepEqual(failures, [], 'No observer failure can be hidden by production passthrough')
    }
  }
  const originalLaunch = electron.launch
  electron.launch = function (options) {
    assert.equal(options.executablePath, require('electron'), 'Use the frozen stock Electron')
    assert.equal(options.args[0], appPath, 'Preserve the original immutable application argument')
    assert.equal(process.env.LIFE_ELECTRON_BINARY, undefined)
    const tape = join(observerDirectory, `main-${++launchNumber}.jsonl`)
    const augmented = {
      ...options,
      args: ['-r', mainObserver, ...options.args],
      env: { ...options.env, LIFE_TEST_MAIN_OBSERVER_TAPE: tape },
    }
    const promise = Reflect.apply(originalLaunch, this, [augmented])
    promise.then(
      (application) => {
        const launch = {
          pid: application.process().pid,
          tape,
          originalArgs: options.args,
          effectiveArgs: augmented.args,
          originalAppPath: appPath,
          explicitPreload: mainObserver,
          failures: [],
        }
        applications.set(application, launch)
        launches.set(launch.pid, launch)
        try {
          writeFileSync(
            join(observerDirectory, `launch-${launch.pid}.json`),
            JSON.stringify(launch, null, 2),
          )
        } catch (error) {
          launch.failures.push(String(error))
        }
      },
      () => {},
    )
    return promise
  }
  const originalApproval = RecoveryHarness.prototype.approval
  RecoveryHarness.prototype.approval = async function (prompt) {
    await this.page.locator('.approval-card').waitFor()
    const thread = await this.thread(prompt)
    const observed = await agentTape(this, 'approval')
    const event = observed.events.findLast(
      (value) => value.type === 'approval' && value.sessionId === thread.id,
    )
    const owned = state(this)
    const original = owned.originals.get(thread.id)
    let approval, completion
    if (event?.requestId) {
      approval = await Reflect.apply(originalApproval, this, [prompt])
      if (!original && !baseline)
        owned.originals.set(thread.id, bindPermission(this, thread, approval))
      if (original) {
        completion = recoverPending(currentTape(this), original, thread)
        assert.equal(approval.requestId, original.event.requestId)
      }
    } else {
      assert.equal(baseline, false, 'Baseline cannot claim native pending recovery')
      assert.ok(original, 'A recovery observation starts from the actual original native approval')
      completion = recoverPending(currentTape(this), original, thread)
      assert.ok(
        completion.owner.acceptedAppliedRevision >= original.event.nativeRecovery.revision,
        'The snapshot observation completes an already acknowledged control, never invents replay',
      )
      approval = completion.pending
    }
    assert.equal(
      await this.page
        .locator('.approval-card')
        .getByRole('button', { name: 'Allow once', exact: true })
        .isEnabled(),
      true,
      'The original real approval UI remains actionable',
    )
    await assertHealthy(this)
    owned.approvalObservations.push({
      source: completion ? 'genuine-current-recover-owner-pending' : 'original-onAgent',
      originalOnAgentTape: observed,
      genuineRecovery: completion,
      originalNativeBinding: owned.originals.get(thread.id),
      returnedApproval: approval,
      observerOnly: true,
      artificialRecoverCalls: 0,
      syntheticAgentEvents: 0,
    })
    writeFileSync(
      join(observerDirectory, `${this.name}-approval-observations.json`),
      JSON.stringify(owned.approvalObservations, null, 2),
    )
    return approval
  }
  const originalSaveEvidence = RecoveryHarness.prototype.saveEvidence
  RecoveryHarness.prototype.saveEvidence = async function (name, evidence) {
    await assertHealthy(this)
    const tapes = this.launches.map((launch) => {
      const captured = launches.get(launch.pid)
      assert.ok(captured)
      return readTape(captured.tape, captured.pid, appPath)
    })
    const observed = this.page ? await agentTape(this, 'completed') : undefined
    const proof = {
      adapterVersion: 2,
      baseline,
      artificialRecoverCalls: 0,
      syntheticAgentEvents: 0,
      productionMutations: 0,
      originalOnAgentTape: observed,
      mainTapes: tapes,
      approvalObservations: state(this).approvalObservations,
    }
    return Reflect.apply(originalSaveEvidence, this, [
      name,
      { ...evidence, recoveryObserver: proof },
    ])
  }
  return { launches, harnesses }
}

module.exports = { install }
if (process.env.LIFE_TEST_OBSERVER_ADAPTER === '1') {
  const repository = resolve(__dirname, '../../..')
  install({
    electron: require('playwright')._electron,
    RecoveryHarness: require(join(repository, 'tests/helpers/active-session-recovery-steps.cjs'))
      .RecoveryHarness,
    appPath: resolve(process.env.LIFE_TEST_APP_PATH),
    artifacts: resolve(process.env.LIFE_TEST_ARTIFACTS_DIR),
    baseline: process.env.LIFE_TEST_EXPECT_RECOVERY_GAP === '1',
    mainObserver: join(__dirname, 'main-observer.cjs'),
  })
}
