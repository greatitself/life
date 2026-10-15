#!/usr/bin/env node
// Actual native interface replacement and cold process recovery; no SSH or provider inference.
const assert = require('node:assert/strict')
const { createHash } = require('node:crypto')
const { existsSync, readdirSync, readFileSync, statSync } = require('node:fs')
const { mkdir, mkdtemp, rm, writeFile } = require('node:fs/promises')
const { tmpdir } = require('node:os')
const { join, resolve } = require('node:path')
const { spawn } = require('node:child_process')
const { _electron: electron } = require('playwright')

const fixtureSSHProfile = {
  transport: 'ssh',
  id: 'private-native-fixture-ssh',
  name: 'Private native fixture SSH',
  host: '127.0.0.1',
  port: 1,
  username: 'fixture',
  auth: 'password',
  privateKeyPath: '',
  workspace: '~',
}

async function seedPrivateSSHSelection(configurationRoot) {
  const userData = join(configurationRoot, 'chromium')
  await mkdir(userData, { recursive: true })
  const path = join(userData, 'connections.json')
  // Select SSH before native startup; never discover or launch host Local CLIs.
  await writeFile(
    path,
    JSON.stringify({
      profiles: [fixtureSSHProfile],
      knownHosts: {},
      selectedProfileId: fixtureSSHProfile.id,
      localWorkspace: userData,
    }),
    { flag: 'wx' },
  )
}

const repository = resolve(__dirname, '..')
const appPath = resolve(process.env.LIFE_TEST_APP_PATH || repository)
const expectArchiveLoss = process.env.LIFE_TEST_EXPECT_ARCHIVE_LOSS === '1'
const artifacts = resolve(
  repository,
  process.env.LIFE_TEST_ARTIFACTS_DIR ||
    `output/playwright/studio-native-checkpoint-${expectArchiveLoss ? 'baseline' : 'candidate'}`,
)
const historyKey = 'life.studio.sessions.v1'
const activeKey = 'life.studio.active.v1'
const draftKey = 'life.studio.drafts.v1'
const chronologyKey = 'life.fixture.studio-native-checkpoint.chronology'
const selectedId = 'archival-native-checkpoint-Ω'
const title = 'Latest exact Studio title Ω 🧪'
const draft = '  Unsent Studio draft Ω 🧪\n\tKeep these spaces  \n'
const exact = '  Original native request\r\n\tUnicode café e\u0301 漢字 🧪  '

let ownedDisplay

async function bounded(pending, description) {
  let deadline
  try {
    return await Promise.race([
      pending,
      new Promise((_resolve, reject) => {
        deadline = setTimeout(() => reject(new Error(description)), 15_000)
      }),
    ])
  } finally {
    clearTimeout(deadline)
  }
}

async function isolatedDisplay(operation) {
  if (process.platform !== 'linux') return operation()
  const server = spawn(
    'Xvfb',
    ['-displayfd', '3', '-screen', '0', '1440x960x24', '-nolisten', 'tcp', '-extension', 'MIT-SHM'],
    { stdio: ['ignore', 'ignore', 'pipe', 'pipe'] },
  )
  ownedDisplay = { pid: server.pid, startedAt: new Date().toISOString(), logs: [] }
  const exited = new Promise((done) => {
    server.once('exit', (code, signal) => {
      ownedDisplay.exitCode = code
      ownedDisplay.signal = signal
      ownedDisplay.exitedAt = new Date().toISOString()
      done()
    })
  })
  server.stderr.on('data', (bytes) => ownedDisplay.logs.push(String(bytes)))
  const previousDisplay = process.env.DISPLAY
  let failed
  try {
    const display = await bounded(
      new Promise((done, reject) => {
        let output = ''
        server.once('error', reject)
        server.once('exit', () => reject(new Error('Owned Xvfb exited before display readiness')))
        server.stdio[3].on('data', (bytes) => {
          output += String(bytes)
          if (/^\d+\n$/.test(output)) done(output.trim())
        })
      }),
      'Owned Xvfb did not report display readiness',
    )
    ownedDisplay.display = ':' + display
    ownedDisplay.readyAt = new Date().toISOString()
    process.env.DISPLAY = ownedDisplay.display
    await operation()
  } catch (error) {
    failed = error
  } finally {
    if (previousDisplay === undefined) delete process.env.DISPLAY
    else process.env.DISPLAY = previousDisplay
    if (server.exitCode === null && server.signalCode === null) server.kill('SIGTERM')
    await bounded(exited, 'Owned Xvfb did not exit after fixture cleanup')
    ownedDisplay.absentAfterCleanup = !alive(server.pid)
    await mkdir(artifacts, { recursive: true })
    await writeFile(
      join(artifacts, 'display-cleanup.json'),
      JSON.stringify(ownedDisplay, null, 2) + '\n',
    )
    assert.ok(ownedDisplay.absentAfterCleanup, 'Only the owned Xvfb must be gone')
  }
  if (failed) throw failed
}

function manifest() {
  const entries = []
  const collect = (relative) => {
    const path = join(appPath, relative)
    if (statSync(path).isDirectory()) {
      for (const name of readdirSync(path).sort()) collect(join(relative, name))
      return
    }
    const bytes = readFileSync(path)
    entries.push({
      path: relative,
      bytes: bytes.length,
      sha256: createHash('sha256').update(bytes).digest('hex'),
    })
  }
  for (const path of ['src', 'out', 'package.json', 'package-lock.json', 'electron.vite.config.ts'])
    collect(path)
  return {
    files: entries,
    sha256: createHash('sha256').update(JSON.stringify(entries)).digest('hex'),
  }
}

function alive(pid) {
  try {
    process.kill(pid, 0)
    return true
  } catch {
    return false
  }
}

async function waitForAbsent(pid) {
  let timer
  try {
    await bounded(
      new Promise((done) => {
        const poll = () => {
          if (!alive(pid)) done()
        }
        timer = setInterval(poll, 40)
        poll()
      }),
      'Owned native process did not exit: ' + pid,
    )
  } finally {
    clearInterval(timer)
  }
}

function archivedRows() {
  const selected = {
    id: selectedId,
    stage: 'complete',
    createdAt: 10,
    updatedAt: 20,
    request: exact,
    futureSessionField: { exact, unchanged: true },
    thread: {
      id: selectedId,
      purpose: 'customization',
      profileId: 'original-machine-Ω',
      provider: 'codex',
      remoteId: 'original-native-session-Ω',
      workspace: '/srv/Studio Ω',
      title: 'Previous durable Studio title',
      messages: [
        { id: 'prompt', role: 'user', text: exact, turn: 1, futureMessageField: { exact } },
        { futureMessageOnly: exact },
        { id: 'reply', role: 'assistant', text: 'Original exact answer\r\nΩ', turn: 1 },
      ],
      busy: false,
      pending: [],
      model: '',
      mode: 'plan',
      updatedAt: 20,
      turn: 1,
      futureThreadField: { exact, retained: true },
    },
  }
  const duplicate = structuredClone(selected)
  duplicate.thread.title = 'Opaque duplicate occurrence'
  duplicate.futureSessionField.occurrence = 'second'
  return [null, { opaqueHead: { exact } }, selected, 37, duplicate, 'Opaque tail Ω\r\n']
}

async function run() {
  assert.ok(existsSync(join(appPath, 'out/main/index.js')), 'Build the isolated candidate first')
  await mkdir(artifacts, { recursive: true })
  const configurationRoot = await mkdtemp(join(tmpdir(), 'life-studio-native-checkpoint-'))
  await seedPrivateSSHSelection(configurationRoot)
  const before = manifest()
  const proof = {
    fixture: 'real Electron App / native window.restart / held Studio-only archival timer',
    functionalOnly: true,
    authenticatedProviderUse: false,
    startedAt: new Date().toISOString(),
    appPath,
    expectArchiveLoss,
    display: { ...ownedDisplay },
    sourceAndBuildBefore: before,
    fixtureSha256: createHash('sha256').update(readFileSync(__filename)).digest('hex'),
    ownedProcesses: [],
    rendererErrors: [],
    nativeLogs: [],
  }
  let application
  let page
  let phase = 'launch'
  let failed
  const ticker = setInterval(() => console.log('Studio native checkpoint phase: ' + phase), 30_000)
  const launch = async () => {
    if (ownedDisplay)
      assert.ok(
        ownedDisplay.exitCode === undefined && alive(ownedDisplay.pid),
        'The original owned Xvfb must still be alive before every native launch',
      )
    application = await electron.launch({
      executablePath: require('electron'),
      args: [
        appPath,
        ...(process.platform === 'linux' ? ['--no-sandbox'] : []),
        '--disable-dev-shm-usage',
        `--user-data-dir=${join(configurationRoot, 'chromium')}`,
      ],
      cwd: appPath,
      env: { ...process.env, ELECTRON_RENDERER_URL: '', XDG_CONFIG_HOME: configurationRoot },
      timeout: 30_000,
    })
    const owned = {
      pid: application.process().pid,
      startedAt: new Date().toISOString(),
      exitCode: null,
      signal: null,
    }
    proof.ownedProcesses.push(owned)
    application.process().once('exit', (code, signal) => {
      owned.exitCode = code
      owned.signal = signal
      owned.exitedAt = new Date().toISOString()
    })
    application.process().stderr?.on('data', (bytes) => {
      proof.nativeLogs.push(String(bytes).slice(-8000))
      if (proof.nativeLogs.length > 30) proof.nativeLogs.shift()
    })
    page = await application.firstWindow()
    page.setDefaultTimeout(15_000)
    page.on('pageerror', (error) => proof.rendererErrors.push(error.message))
    await page.locator('.app-shell').waitFor()
    await page.waitForLoadState('networkidle')
    const identity = await application.evaluate(({ app }) => ({
      userData: app.getPath('userData'),
      appPath: app.getAppPath(),
    }))
    assert.ok(identity.userData.startsWith(configurationRoot), 'Only a private profile is allowed')
    assert.equal(identity.appPath, appPath)
    proof.nativeIdentity = identity
    assert.equal(
      (await page.evaluate(() => window.relay.connection.state())).status,
      'disconnected',
    )
    const profiles = await page.evaluate(() => window.relay.profiles.list())
    assert.deepEqual(
      profiles
        .filter((profile) => profile.transport !== 'local')
        .map((profile) =>
          profile.transport === undefined ? { ...profile, transport: 'ssh' } : profile,
        ),
      [fixtureSSHProfile],
    )
    const localProfiles = profiles.filter((profile) => profile.transport === 'local')
    assert.ok(localProfiles.length <= 1)
    if (localProfiles.length) assert.match(localProfiles[0].id, /^local:/)
    assert.notEqual(
      (await page.evaluate(() => window.relay.connection.state())).profile?.transport,
      'local',
    )
    await application.evaluate(({ ipcMain }) => {
      globalThis.__studioNativeProviderCalls = []
      for (const name of ['agent:start', 'connection:connect']) {
        const original = ipcMain._invokeHandlers.get(name)
        if (typeof original !== 'function')
          throw new Error('Missing native fixture handler: ' + name)
        ipcMain.removeHandler(name)
        ipcMain.handle(name, (...args) => {
          globalThis.__studioNativeProviderCalls.push(name)
          return original(...args)
        })
      }
    })
  }
  const replace = async () => {
    const oldWindow = await application.evaluate(
      ({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].id,
    )
    const nextWindow = application.waitForEvent('window', { timeout: 15_000 })
    const invocation = page
      .evaluate(() => window.relay.window.restart())
      .catch((error) => {
        assert.match(error.message, /closed|destroyed|execution context/i)
      })
    page = await nextWindow
    page.on('pageerror', (error) => proof.rendererErrors.push(error.message))
    await invocation
    await page.locator('.app-shell').waitFor()
    await page.waitForLoadState('networkidle')
    const windowIds = await application.evaluate(({ BrowserWindow }) =>
      BrowserWindow.getAllWindows().map((window) => window.id),
    )
    assert.equal(windowIds.length, 1)
    assert.notEqual(windowIds[0], oldWindow)
    return { previousWindow: oldWindow, nextWindow: windowIds[0] }
  }
  const openStudio = async () => {
    const connect = page.getByRole('dialog', { name: 'Choose an environment', exact: true })
    if (await connect.isVisible())
      await connect.getByRole('button', { name: 'Close dialog', exact: true }).click()
    await page.getByRole('button', { name: 'Customize', exact: true }).click()
    const studio = page.getByRole('dialog', { name: 'Customize Life', exact: true })
    await studio.waitFor()
    return studio
  }
  const readStorage = () =>
    page.evaluate(
      ({ historyKey, draftKey, chronologyKey }) => ({
        history: localStorage.getItem(historyKey),
        drafts: localStorage.getItem(draftKey),
        chronology: JSON.parse(localStorage.getItem(chronologyKey) || '[]'),
      }),
      { historyKey, draftKey, chronologyKey },
    )
  const quit = async () => {
    const owner = application
    const nativeProcess = owner.process()
    const exited = new Promise((done) => nativeProcess.once('exit', done))
    await owner
      .evaluate(({ app }) => app.quit())
      .catch((error) => {
        assert.match(error.message, /closed|destroyed|execution context/i)
      })
    let deadline
    try {
      await Promise.race([
        exited,
        new Promise((_resolve, reject) => {
          deadline = setTimeout(() => reject(new Error('Native quit did not finish')), 15_000)
        }),
      ])
    } finally {
      clearTimeout(deadline)
    }
    assert.equal(nativeProcess.exitCode, 0)
    application = undefined
  }
  try {
    await launch()
    const rows = archivedRows()
    const drafts = { futureDraft: { exact, unchanged: true }, [selectedId]: '' }
    phase = 'hydrate archival source'
    await page.evaluate(
      ({ rows, drafts, historyKey, activeKey, draftKey, selectedId }) => {
        localStorage.setItem(historyKey, JSON.stringify(rows))
        localStorage.setItem(activeKey, selectedId)
        localStorage.setItem(draftKey, JSON.stringify(drafts))
      },
      { rows, drafts, historyKey, activeKey, draftKey, selectedId },
    )
    proof.hydrationReplacement = await replace()
    const studio = await openStudio()
    const composer = studio.getByRole('textbox', { name: 'Describe a Life customization' })
    await composer.fill(draft)
    drafts[selectedId] = draft
    const durableBefore = await readStorage()
    assert.equal(durableBefore.history, JSON.stringify(rows))
    assert.equal(durableBefore.drafts, JSON.stringify(drafts))
    await studio.getByRole('button', { name: 'Details', exact: true }).click()
    const titleInput = studio.getByRole('textbox', { name: 'Customization title', exact: true })
    await titleInput.waitFor()
    phase = 'hold only Studio archival timer'
    await page.evaluate(
      ({ historyKey, draftKey, chronologyKey }) => {
        const events = []
        const originalSet = Storage.prototype.setItem
        const originalTimeout = window.setTimeout.bind(window)
        const originalClear = window.clearTimeout.bind(window)
        const held = new Map()
        const record = (type, detail = {}) => {
          events.push({ type, at: Date.now(), ...detail })
          originalSet.call(localStorage, chronologyKey, JSON.stringify(events))
        }
        Storage.prototype.setItem = function (key, value) {
          const result = originalSet.call(this, key, value)
          if (this === localStorage && (key === historyKey || key === draftKey))
            record('storage-write', { key, value })
          return result
        }
        window.setTimeout = function (callback, delay, ...args) {
          const source =
            typeof callback === 'function' ? Function.prototype.toString.call(callback) : ''
          if (
            delay === 300 &&
            source.includes(
              'Studio history storage is full. Export older conversations before removing them.',
            )
          ) {
            const handle = originalTimeout(() => record('held-timer-due', { handle }), 300)
            held.set(handle, callback)
            record('held-studio-timer', {
              handle,
              callbackSource: source,
              stack: new Error().stack,
            })
            return handle
          }
          return originalTimeout(callback, delay, ...args)
        }
        window.clearTimeout = function (handle) {
          if (held.delete(handle)) record('held-timer-cleared', { handle })
          return originalClear(handle)
        }
        const listeners = new Map()
        for (const type of ['beforeunload', 'pagehide', 'unload', 'life:history-checkpoint']) {
          const listener = () => record(type)
          listeners.set(type, listener)
          window.addEventListener(type, listener)
        }
        window.__studioCheckpointFixture = {
          held: () => held.size,
          record,
          restore: () => {
            for (const handle of held.keys()) originalClear(handle)
            held.clear()
            window.setTimeout = originalTimeout
            window.clearTimeout = originalClear
            Storage.prototype.setItem = originalSet
            for (const [type, listener] of listeners) window.removeEventListener(type, listener)
          },
        }
        record('instrumentation-installed')
      },
      { historyKey, draftKey, chronologyKey },
    )
    await titleInput.fill(title)
    assert.equal(await titleInput.inputValue(), title)
    assert.equal(await page.evaluate(() => window.__studioCheckpointFixture.held()), 1)
    const heldBefore = await readStorage()
    assert.equal(heldBefore.history, durableBefore.history)
    assert.equal(heldBefore.drafts, durableBefore.drafts)
    proof.heldBeforeRestart = heldBefore
    phase = 'real native interface restart'
    await page.evaluate(() => window.__studioCheckpointFixture.record('restart-invoked'))
    proof.replacement = await replace()
    const after = await readStorage()
    const expected = structuredClone(rows)
    expected[2].thread.title = title
    proof.afterRestart = after
    const restored = expectArchiveLoss ? rows : expected
    assert.equal(after.history, JSON.stringify(restored))
    assert.equal(after.drafts, durableBefore.drafts)
    assert.ok(after.chronology.some((event) => event.type === 'life:history-checkpoint'))
    assert.equal(after.chronology.filter((event) => event.type === 'beforeunload').length, 0)
    assert.equal(after.chronology.filter((event) => event.type === 'unload').length, 0)
    assert.equal(after.chronology.filter((event) => event.type === 'pagehide').length, 0)
    assert.equal(
      after.chronology.filter((event) => event.type === 'storage-write' && event.key === historyKey)
        .length,
      expectArchiveLoss ? 0 : 1,
    )
    const restartedStudio = await openStudio()
    await restartedStudio.getByRole('button', { name: 'Details', exact: true }).click()
    assert.equal(
      await restartedStudio
        .getByRole('textbox', { name: 'Customization title', exact: true })
        .inputValue(),
      restored[2].thread.title,
    )
    assert.equal(
      await restartedStudio
        .getByRole('textbox', { name: 'Describe a Life customization' })
        .inputValue(),
      draft,
    )
    assert.deepEqual(await application.evaluate(() => globalThis.__studioNativeProviderCalls), [])
    phase = 'cold process relaunch'
    await quit()
    await launch()
    const cold = await readStorage()
    assert.equal(cold.history, after.history)
    assert.equal(cold.drafts, after.drafts)
    proof.afterColdRelaunch = cold
    const coldStudio = await openStudio()
    await coldStudio.getByRole('button', { name: 'Details', exact: true }).click()
    assert.equal(
      await coldStudio
        .getByRole('textbox', { name: 'Customization title', exact: true })
        .inputValue(),
      restored[2].thread.title,
    )
    assert.equal(
      await coldStudio.getByRole('textbox', { name: 'Describe a Life customization' }).inputValue(),
      draft,
    )
    assert.deepEqual(await application.evaluate(() => globalThis.__studioNativeProviderCalls), [])
    await page.screenshot({ path: join(artifacts, 'cold-relaunch.png') })
    await quit()
    proof.checks = [
      expectArchiveLoss
        ? 'Baseline proves native forced replacement loses the held Studio archive edit'
        : 'Native checkpoint saves the held Studio archive edit before forced replacement',
      'Opaque neighbors, duplicate occurrence, unknown metadata and native ownership remain exact',
      'Synchronous Unicode draft survives native replacement and cold process relaunch',
      'Native destroy emits neither beforeunload, pagehide nor unload in this real workflow',
      'No SSH connection or provider start occurs',
    ]
    assert.deepEqual(proof.rendererErrors, [])
    console.log('Studio native checkpoint smoke passed: ' + proof.checks.length + ' groups')
  } catch (error) {
    failed = error
    proof.failure = { phase, message: error.message, stack: error.stack }
    await page?.screenshot({ path: join(artifacts, 'failure.png') }).catch(() => {})
    proof.failureStorage = await readStorage().catch(() => undefined)
  } finally {
    clearInterval(ticker)
    await page?.evaluate(() => window.__studioCheckpointFixture?.restore()).catch(() => {})
    if (application) await application.close().catch(() => {})
    for (const owned of proof.ownedProcesses) {
      await waitForAbsent(owned.pid).catch((error) => {
        proof.cleanupError = error.message
      })
    }
    proof.completedAt = new Date().toISOString()
    proof.sourceAndBuildAfter = manifest()
    proof.inputsUnchanged = JSON.stringify(before) === JSON.stringify(proof.sourceAndBuildAfter)
    proof.cleanup = {
      ownedProcessesAbsent: proof.ownedProcesses.every((entry) => !alive(entry.pid)),
      profile: configurationRoot,
    }
    await rm(configurationRoot, { recursive: true, force: true })
    proof.cleanup.profileRemoved = !existsSync(configurationRoot)
    await writeFile(join(artifacts, 'proof.json'), JSON.stringify(proof, null, 2) + '\n')
    assert.ok(proof.inputsUnchanged, 'Production source and build must remain frozen through proof')
    assert.ok(proof.cleanup.ownedProcessesAbsent, 'All fixture-owned native processes must exit')
    if (failed) throw failed
  }
}

isolatedDisplay(run).catch((error) => {
  console.error(error)
  process.exitCode = 1
})
