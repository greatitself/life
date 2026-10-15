#!/usr/bin/env node
/*
 * Native Electron + real SSH/SFTP ownership regression. No provider accounts,
 * inference, or credentials are used. Run against the same fixture before/after:
 * LIFE_TEST_APP_PATH=/immutable/app LIFE_TEST_EXPECT_IDLE_LEAK=1 node tests/codex-restart-ownership-smoke.cjs
 * LIFE_TEST_APP_PATH=/built/candidate node tests/codex-restart-ownership-smoke.cjs
 * Candidate-only overlapping window close / app quit regression:
 * LIFE_TEST_APP_PATH=/built/candidate node tests/codex-restart-ownership-smoke.cjs --concurrent-only
 * The stand-in holds exclusive native-thread writer locks until a delayed TERM
 * exit. Assertions and evidence are captured BEFORE SSHFixture.close can kill it.
 */
const assert = require('node:assert/strict')
const { createHash } = require('node:crypto')
const { existsSync, readFileSync } = require('node:fs')
const { mkdir, mkdtemp, readFile, rm, writeFile } = require('node:fs/promises')
const { tmpdir } = require('node:os')
const { join, resolve } = require('node:path')
const { spawnSync } = require('node:child_process')
const { performance } = require('node:perf_hooks')
const { build } = require('esbuild')
const { _electron: electron } = require('playwright')
const { readSavedThreads } = require('./helpers/desktop-history.cjs')

const repository = resolve(__dirname, '..')
const appPath = resolve(process.env.LIFE_TEST_APP_PATH || repository)
const expectLeak = process.env.LIFE_TEST_EXPECT_IDLE_LEAK === '1'
const helperOnly = process.argv.includes('--build-helper-only')
const concurrentOnly = process.argv.includes('--concurrent-only')
assert.ok(!concurrentOnly || !expectLeak, 'Concurrent-only coverage requires the candidate app')
const artifacts = resolve(
  repository,
  process.env.LIFE_TEST_ARTIFACTS_DIR ||
    `output/playwright/codex-restart-ownership-${concurrentOnly ? 'concurrent' : expectLeak ? 'baseline' : 'candidate'}`,
)
if (!helperOnly && process.platform === 'linux' && !process.env.DISPLAY) {
  assert.equal(spawnSync('xvfb-run', ['--help'], { stdio: 'ignore' }).status, 0)
  const result = spawnSync(
    'xvfb-run',
    [
      '-a',
      '-s',
      '-screen 0 1440x960x24 -extension MIT-SHM',
      process.execPath,
      __filename,
      ...process.argv.slice(2),
    ],
    { cwd: repository, env: process.env, stdio: 'inherit' },
  )
  process.exit(result.status ?? 1)
}

const alive = (pid) => {
  try {
    process.kill(pid, 0)
    return true
  } catch {
    return false
  }
}
async function waitUntil(predicate, description, timeout = 20000) {
  const deadline = Date.now() + timeout
  while (Date.now() < deadline) {
    if (await predicate()) return
    await new Promise((done) => setTimeout(done, 40))
  }
  throw new Error(`Timed out waiting for ${description}`)
}
const prompt = '  Native writer ownership first prompt\n\tUnicode café 漢字 🧪  '
const followup = '  Resume the same native session\n\tKeep this exact follow-up 🧪  '
const reply = (text) => `Writer reply: ${text}`
const readLog = (fixture) =>
  readFileSync(join(fixture.root, 'provider-messages.jsonl'), 'utf8')
    .split('\n')
    .filter(Boolean)
    .map((line) => JSON.parse(line))
const providerPids = (fixture) =>
  readLog(fixture)
    .filter((entry) => entry.kind === 'writer-provider-started')
    .map((entry) => entry.pid)
    .filter(alive)

async function run() {
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
    console.log('Built real SSH/SFTP fixture; no native application was launched.')
    return
  }
  assert.ok(existsSync(join(appPath, 'out/main/index.js')), 'Build the selected app first')
  const { SSHFixture } = require(fixtureBundle)
  const proof = {
    fixture: 'real Electron / real SSH-SFTP / exclusive writer stand-in / 200 ms TERM delay',
    authenticatedProviderUse: false,
    inferenceRequests: 0,
    appPath,
    fixtureMode: concurrentOnly ? 'concurrent-native-shutdown-only' : 'matched-four-groups',
    expectedIdleLeak: expectLeak,
    fixtureSourceSha256: createHash('sha256')
      .update(await readFile(__filename))
      .digest('hex'),
    writerStandInSha256: createHash('sha256')
      .update(await readFile(join(repository, 'tests/helpers/codex-writer-fixture.cjs')))
      .digest('hex'),
    nativeMainSha256: createHash('sha256')
      .update(await readFile(join(appPath, 'out/main/index.js')))
      .digest('hex'),
    cases: [],
    checks: [],
    rendererErrors: [],
  }
  let application
  let page
  let phase = 'initialization'
  const ticker = setInterval(() => console.log(`Codex ownership smoke phase: ${phase}`), 30000)
  const fakeSource = join(repository, 'tests/fixtures/fake-provider.cjs')
  process.env.LIFE_TEST_FAKE_PROVIDER = fakeSource
  const resources = []
  const launch = async (configurationRoot, record) => {
    const environment = { ...process.env, XDG_CONFIG_HOME: configurationRoot }
    delete environment.ELECTRON_RENDERER_URL
    application = await electron.launch({
      executablePath: process.env.LIFE_ELECTRON_BINARY || require('electron'),
      args: [
        ...(process.env.LIFE_ELECTRON_BINARY ? [] : [appPath]),
        ...(process.platform === 'linux' ? ['--no-sandbox'] : []),
        '--disable-dev-shm-usage',
      ],
      cwd: appPath,
      env: environment,
      timeout: 30000,
    })
    const nativeLog = []
    application.process().stderr?.on('data', (chunk) => {
      nativeLog.push(String(chunk).slice(-10000))
      while (nativeLog.join('').length > 50000) nativeLog.shift()
    })
    record.nativeLogs.push(nativeLog)
    page = await application.firstWindow()
    page.setDefaultTimeout(15000)
    page.on('pageerror', (error) => proof.rendererErrors.push(error.message))
    await page.locator('.app-shell').waitFor()
    await application.evaluate(({ BrowserWindow }) =>
      BrowserWindow.getAllWindows()[0].setBounds({ width: 1440, height: 960 }),
    )
    assert.ok(
      (await application.evaluate(({ app }) => app.getPath('userData'))).startsWith(
        configurationRoot,
      ),
      'The application must use a disposable profile',
    )
    await page.evaluate(() => {
      window.__writerEvents = []
      window.relay.onAgent((event) => window.__writerEvents.push(event))
    })
  }
  const connect = async (fixture, record) => {
    const input = fixture.input()
    const dialog = page.getByRole('dialog', { name: 'Connect a machine', exact: true })
    if (!(await dialog.isVisible()))
      await page.getByRole('button', { name: 'Connections', exact: true }).click()
    await dialog.waitFor()
    const profiles = await page.evaluate(() => window.relay.profiles.list())
    const profile = profiles.find((entry) => entry.host === input.host && entry.port === input.port)
    if (profile) {
      const row = dialog.locator('.saved-profile').filter({ hasText: profile.name })
      await row.getByRole('button').first().click()
    } else {
      const addSSH = dialog.getByRole('button', { name: 'Add SSH machine', exact: true })
      if (await addSSH.count()) await addSSH.click()
      await dialog.getByPlaceholder('My development server').fill(input.name)
      await dialog.getByPlaceholder('dev.example.com').fill(input.host)
      await dialog.getByLabel('Port', { exact: true }).fill(String(input.port))
      await dialog.getByPlaceholder('developer').fill(input.username)
      await dialog.getByLabel('Authentication').selectOption('password')
    }
    await dialog.getByPlaceholder('Your SSH password').fill(input.password)
    await dialog.getByRole('button', { name: 'Connect machine', exact: true }).click()
    const trust = page.getByRole('dialog', { name: 'Trust this machine?', exact: true })
    await waitUntil(
      async () =>
        (await trust.isVisible()) ||
        (await page.evaluate(() => window.relay.connection.state())).status === 'connected',
      'the real native host-key dialog or already-trusted SSH connection',
    )
    if (await trust.isVisible())
      await trust.getByRole('button', { name: 'Trust and connect', exact: true }).click()
    await dialog.waitFor({ state: 'hidden' })
    const picker = page.getByRole('dialog', { name: 'Select a project', exact: true })
    await waitUntil(
      async () =>
        (await page.evaluate(() => window.relay.connection.state())).workspace ===
          fixture.workspace || (await picker.isVisible()),
      'the saved thread restores its project or the native project picker opens',
    )
    if (
      (await page.evaluate(() => window.relay.connection.state())).workspace !== fixture.workspace
    ) {
      await picker
        .getByRole('textbox', { name: 'Project directory', exact: true })
        .fill(fixture.workspace)
      await picker.getByRole('button', { name: 'Open project', exact: true }).click()
      await picker.waitFor({ state: 'hidden' })
    }
    await waitUntil(
      async () =>
        (await page.evaluate(() => window.relay.connection.state())).workspace ===
        fixture.workspace,
      'the exact native SSH project selection settles',
    )
    assert.equal(
      (await page.evaluate(() => window.relay.connection.state())).workspace,
      fixture.workspace,
      'The native session uses its exact SSH workspace',
    )
    // Observe real server-side transport termination before fixture teardown.
    for (const client of fixture.clients) {
      for (const event of ['end', 'close'])
        client.once(event, () => {
          record.sshDisconnects.push({
            event,
            at: Date.now(),
            providers: providerPids(fixture).map((pid) => ({ pid, alive: alive(pid) })),
          })
        })
    }
    if (await picker.isVisible())
      await picker.getByRole('button', { name: /^(Cancel|Choose later)$/ }).click()
  }
  const openAgents = async () => {
    const navigation = page.getByRole('navigation', { name: 'Workspace views' })
    await navigation.getByRole('button', { name: /^(Agents|Agent workspace)$/ }).click()
  }
  const send = async (text) => {
    const composer = page.getByRole('textbox', {
      name: /^(?:Message your coding agent|Message (?:Codex|Claude Code) about )/,
    })
    await composer.fill(text)
    assert.equal(await composer.inputValue(), text, 'The actual textarea preserves the exact input')
    await page.getByRole('button', { name: 'Send message', exact: true }).click()
  }
  const completedThread = async (text) => {
    let thread
    await waitUntil(async () => {
      thread = (await readSavedThreads(page)).find((entry) =>
        entry.messages.some((message) => message.role === 'user' && message.text === text),
      )
      return (
        thread &&
        !thread.busy &&
        thread.messages.some(
          (message) => message.role === 'assistant' && message.text === reply(text),
        )
      )
    }, 'the exact prompt and complete reply persist through the native store')
    return thread
  }
  const closeNormally = async (mode, record) => {
    const quittingApplication = application
    const process = quittingApplication.process()
    const disconnectStart = record.sshDisconnects.length
    const start = performance.now()
    const before = providerPids(record.fixture)
    const exited = new Promise((done) =>
      process.once('exit', (code, signal) => done({ code, signal, at: Date.now() })),
    )
    if (mode === 'app.quit')
      await quittingApplication.evaluate(({ app }) => {
        setTimeout(() => app.quit(), 0)
      })
    else await page.evaluate(() => window.relay.window.close())
    if (mode === 'window.close + app.quit') {
      let term
      await waitUntil(() => {
        const log = readLog(record.fixture)
        term = log.find(
          (entry) => before.includes(entry.pid) && entry.kind === 'writer-provider-term',
        )
        if (!term) return false
        assert.ok(alive(term.pid), 'The first idle release still owns a living provider')
        assert.ok(
          !log.some((entry) => entry.pid === term.pid && entry.kind === 'writer-provider-exited'),
          'The controlled second quit begins while delayed provider exit is pending',
        )
        return true
      }, 'the real window close begins idle-provider TERM with exit still pending')
      record.concurrentSequence = {
        firstAction: 'window.relay.window.close',
        providerPid: term.pid,
        providerTermAt: term.at,
        providerAliveBeforeSecondQuit: alive(term.pid),
        providerExitPendingBeforeSecondQuit: true,
      }
      const secondQuitAt = await quittingApplication.evaluate(({ app }) => {
        const at = Date.now()
        app.quit()
        return at
      })
      record.concurrentSequence.secondAction = 'app.quit from Electron main'
      record.concurrentSequence.secondQuitAt = secondQuitAt
    }
    const result = await Promise.race([
      exited,
      new Promise((_, reject) =>
        setTimeout(() => reject(new Error('Normal native quit did not finish')), 15000).unref(),
      ),
    ])
    application = undefined
    assert.equal(result.code, 0, 'Normal native quit exits successfully')
    assert.equal(result.signal, null, 'Normal native quit is not killed by the test')
    const nativeQuitMs = performance.now() - start
    const providersAfterNativeExit = before.map((pid) => ({ pid, alive: alive(pid) }))
    await waitUntil(
      () => record.sshDisconnects.length > disconnectStart,
      'the real SSH server observes native disconnect',
      2000,
    )
    const observation = {
      mode,
      elapsedMs: nativeQuitMs,
      ...result,
      providerPidsBefore: before,
      providersAfterNativeExit,
      sshDisconnects: record.sshDisconnects.slice(disconnectStart),
    }
    record.quitObservations.push(observation)
    if (mode === 'window.close + app.quit') {
      const sequence = record.concurrentSequence
      const providerExit = readLog(record.fixture).find(
        (entry) => entry.pid === sequence.providerPid && entry.kind === 'writer-provider-exited',
      )
      assert.ok(providerExit, 'The first release reaches the real provider exit')
      assert.ok(
        sequence.providerTermAt <= sequence.secondQuitAt && sequence.secondQuitAt < providerExit.at,
        'Real app.quit overlaps the pending window-close provider release',
      )
      sequence.providerExitedAt = providerExit.at
      sequence.sshDisconnectedAt = observation.sshDisconnects[0].at
      sequence.nativeExitedAt = result.at
      assert.ok(
        providerExit.at <= sequence.sshDisconnectedAt && providerExit.at <= result.at,
        'Both shutdown paths wait for the same provider exit before SSH and native exit',
      )
    }
    return observation
  }
  const setup = async (name) => {
    const configurationRoot = await mkdtemp(join(tmpdir(), 'life-codex-ownership-profile-'))
    const fixture = await new SSHFixture(
      join(repository, 'tests/helpers/codex-writer-fixture.cjs'),
    ).start()
    await mkdir(join(fixture.root, '.life'), { recursive: true })
    // Keep optional title runs outside this writer test. This does not change
    // provider protocol or the primary native session being exercised.
    await writeFile(join(fixture.root, '.life/metadata'), 'Optional title staging unavailable')
    const record = {
      name,
      fixture,
      configurationRoot,
      nativeLogs: [],
      sshDisconnects: [],
      quitObservations: [],
    }
    resources.push(record)
    await launch(configurationRoot, record)
    await connect(fixture, record)
    return record
  }
  const assertIdleRelease = (record, observation) => {
    assert.ok(observation.providerPidsBefore.length, 'An idle native provider exists before quit')
    const expectedAlive = expectLeak
    assert.ok(
      observation.providersAfterNativeExit.every((entry) => entry.alive === expectedAlive),
      expectLeak
        ? 'The baseline reproduces idle writers left alive after normal quit'
        : 'Normal quit waits for every idle Codex provider to actually exit',
    )
    assert.ok(observation.sshDisconnects.length, 'Real SSH disconnect is observed before teardown')
    if (!expectLeak) {
      assert.ok(
        observation.sshDisconnects.every((entry) => entry.providers.length === 0),
        'Every idle provider has exited before SSH teardown starts',
      )
      const log = readLog(record.fixture)
      for (const pid of observation.providerPidsBefore) {
        const term = log.find((entry) => entry.pid === pid && entry.kind === 'writer-provider-term')
        const exit = log.find(
          (entry) => entry.pid === pid && entry.kind === 'writer-provider-exited',
        )
        assert.ok(term && exit, 'The idle provider observes TERM and performs its own exit')
        assert.ok(
          exit.at - term.at >= 190,
          'The native close waits through the real delayed TERM exit',
        )
        assert.ok(
          exit.at <= observation.sshDisconnects[0].at,
          'Provider exit precedes the real SSH disconnect',
        )
      }
    }
  }
  try {
    for (const mode of concurrentOnly
      ? ['window.close + app.quit']
      : ['app.quit', 'window.close']) {
      phase = `idle native session / ${mode}`
      const record = await setup(`idle-${mode}`)
      await openAgents()
      await send(prompt)
      const original = await completedThread(prompt)
      assert.ok(original.remoteId)
      assert.equal(original.workspace, record.fixture.workspace)
      const nativeFirst = readLog(record.fixture).filter(
        (entry) => entry.kind === 'writer-turn-started' && entry.prompt === prompt,
      )
      assert.equal(nativeFirst.length, 1, 'The primary native prompt is sent once')
      assert.equal(nativeFirst[0].threadId, original.remoteId)
      const observation = await closeNormally(mode, record)
      assertIdleRelease(record, observation)
      phase = `cold native restart / ${mode}`
      await launch(record.configurationRoot, record)
      const restored = (await readSavedThreads(page)).find((thread) => thread.id === original.id)
      assert.ok(restored)
      assert.equal(restored.remoteId, original.remoteId)
      assert.equal(restored.workspace, original.workspace)
      assert.equal(restored.profileId, original.profileId)
      assert.deepEqual(restored.messages, original.messages)
      await page.locator(`[data-thread-row="${original.id}"]`).waitFor()
      await page.getByRole('dialog', { name: 'Connect a machine', exact: true }).waitFor()
      await connect(record.fixture, record)
      await openAgents()
      await page.locator(`[data-thread-row="${original.id}"]`).click()
      await send(followup)
      if (expectLeak) {
        await waitUntil(
          () => readLog(record.fixture).some((entry) => entry.kind === 'writer-conflict'),
          'the baseline native resume conflicts with the orphaned writer',
        )
        await waitUntil(
          async () =>
            (await readSavedThreads(page))
              .find((thread) => thread.id === original.id)
              ?.messages.some(
                (message) =>
                  message.role === 'error' && message.text.includes('still has a writer'),
              ),
          'the native resume failure is surfaced',
        )
        assert.equal(
          readLog(record.fixture).filter(
            (entry) => entry.kind === 'writer-turn-started' && entry.prompt === followup,
          ).length,
          0,
          'A failed resume does not start the follow-up on another native session',
        )
        record.resume = { reproducedWriterConflict: true, nativeResumeFailurePersisted: true }
      } else {
        const resumed = await completedThread(followup)
        assert.equal(resumed.id, original.id)
        assert.equal(resumed.remoteId, original.remoteId)
        assert.equal(resumed.workspace, original.workspace)
        assert.equal(resumed.profileId, original.profileId)
        const log = readLog(record.fixture)
        const nativeResume = log.filter((entry) => entry.kind === 'writer-resumed')
        assert.equal(nativeResume.length, 1)
        assert.equal(nativeResume[0].threadId, original.remoteId)
        assert.equal(nativeResume[0].excludeTurns, true)
        assert.equal(log.filter((entry) => entry.message?.method === 'thread/start').length, 1)
        assert.equal(
          log.filter((entry) => entry.kind === 'writer-turn-started' && entry.prompt === followup)
            .length,
          1,
        )
        const native = JSON.parse(
          await readFile(
            join(
              record.fixture.root,
              'codex-writer-fixture',
              `${encodeURIComponent(original.remoteId)}.json`,
            ),
            'utf8',
          ),
        )
        assert.deepEqual(
          native.turns.map(
            (turn) => turn.items.find((item) => item.type === 'userMessage').content[0].text,
          ),
          [prompt, followup],
        )
        assert.deepEqual(
          native.turns.map((turn) => turn.items.find((item) => item.type === 'agentMessage').text),
          [reply(prompt), reply(followup)],
        )
        record.resume = {
          localId: original.id,
          remoteId: original.remoteId,
          profileId: original.profileId,
          workspace: original.workspace,
          nativeTurns: 2,
          exactNativePromptsAndReplies: true,
          startedNewNativeSessionOnResume: false,
        }
      }
      const finalQuit = await closeNormally(concurrentOnly ? 'app.quit' : mode, record)
      assertIdleRelease(record, finalQuit)
      proof.checks.push(
        expectLeak
          ? `${mode}: baseline reproduces orphaned idle writer and conflicting cold native resume`
          : `${mode}: idle writer release before SSH teardown; cold restart preserves exact native session and prompts`,
      )
      await writeFile(
        join(artifacts, `${record.name.replaceAll('.', '-')}-provider-before-teardown.json`),
        JSON.stringify(readLog(record.fixture), null, 2),
      )
    }
    if (!concurrentOnly) {
      phase = 'models-only idle native provider'
      const models = await setup('models-only')
      const catalog = await page.evaluate(() => window.relay.agent.models('codex'))
      assert.ok(catalog.some((model) => model.id === 'writer-fixture-model'))
      assert.equal(
        readLog(models.fixture).filter((entry) => entry.message?.method === 'thread/start').length,
        0,
        'Models-only use creates no native inference thread',
      )
      assertIdleRelease(models, await closeNormally('app.quit', models))
      proof.checks.push(
        expectLeak
          ? 'Baseline reproduces models-only idle Codex app-server surviving native quit'
          : 'Models-only Codex app-server releases before real SSH disconnect',
      )

      phase = 'active native writer survives normal quit'
      const active = await setup('active-turn')
      await openAgents()
      await send('LIFE_WRITER_HANG')
      await waitUntil(
        () => readLog(active.fixture).some((entry) => entry.kind === 'writer-turn-started'),
        'a real native turn is actively hanging before quit',
      )
      const activeQuit = await closeNormally('app.quit', active)
      assert.ok(activeQuit.providerPidsBefore.length)
      assert.ok(activeQuit.providersAfterNativeExit.every((entry) => entry.alive))
      await new Promise((done) => setTimeout(done, 300))
      assert.ok(
        activeQuit.providerPidsBefore.every(alive),
        'Active work survives beyond TERM delay',
      )
      const activeLog = readLog(active.fixture)
      assert.equal(activeLog.filter((entry) => entry.kind === 'writer-provider-term').length, 0)
      assert.equal(
        activeLog.filter((entry) => entry.message?.method === 'turn/interrupt').length,
        0,
      )
      active.activeSurvivedBeforeFixtureTeardown = true
      proof.checks.push(
        'Active hanging Codex stays alive on normal quit without TERM or native interrupt',
      )
    }
    assert.deepEqual(proof.rendererErrors, [])
    proof.passed = true
  } catch (error) {
    proof.passed = false
    proof.failure = { phase, message: error.message, stack: error.stack }
    if (page && !page.isClosed())
      await page.screenshot({ path: join(artifacts, 'failure.png') }).catch(() => {})
    if (page && !page.isClosed())
      await writeFile(
        join(artifacts, 'failure-ui.json'),
        JSON.stringify(
          await page.evaluate(() => ({
            text: document.body.innerText,
            buttons: [...document.querySelectorAll('button')].map((button) => ({
              text: button.textContent,
              label: button.getAttribute('aria-label'),
            })),
          })),
          null,
          2,
        ),
      ).catch(() => {})
    throw error
  } finally {
    clearInterval(ticker)
    // Freeze causal evidence first. Cleanup may terminate deliberately preserved
    // active jobs or baseline orphans and must never be mistaken for app behavior.
    try {
      proof.cases = resources.map(({ fixture, configurationRoot, ...record }) => ({
        ...record,
        configurationRoot,
        providerTraceBeforeFixtureTeardown: readLog(fixture),
        providerPidsBeforeFixtureTeardown: providerPids(fixture),
      }))
      await writeFile(join(artifacts, 'proof.json'), JSON.stringify(proof, null, 2))
    } finally {
      if (application) await application.close().catch(() => {})
      const cleanupErrors = []
      for (const resource of resources) {
        try {
          await resource.fixture.close()
        } catch (error) {
          cleanupErrors.push(error)
        } finally {
          await rm(resource.configurationRoot, { recursive: true, force: true }).catch((error) =>
            cleanupErrors.push(error),
          )
        }
      }
      if (cleanupErrors.length) throw new AggregateError(cleanupErrors, 'Fixture cleanup failed')
    }
  }
  console.log(JSON.stringify({ passed: proof.passed, checks: proof.checks.length, artifacts }))
}
run().catch((error) => {
  console.error(error.stack || error.message)
  process.exitCode = 1
})
