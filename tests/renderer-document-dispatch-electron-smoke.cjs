#!/usr/bin/env node
/*
 * Observe a production native invocation admitted by one renderer document and
 * dispatched only after that same BrowserWindow reloads its main document.
 *
 * LIFE_TEST_APP_ROOT selects a frozen full source/build app. The fixture copies
 * it into a private temporary directory and adds ONE test-only main assignment:
 *   globalThis.__lifeAdmissionRuntime = operations;
 * Production handlers, admission checks, Effect services, preload and renderer
 * are otherwise unchanged. A main-process observer delays the targeted outer
 * invoke before calling its original runtime method, preserving beforeDispatch.
 *
 * No live profile, VNC display, fixed debugging port, SSH or provider inference.
 * Always starts a private Linux Xvfb. No performance claims or latency gates.
 * LIFE_TEST_EXPECT_DOCUMENT_DISPATCH may be observe (default), fulfilled, or
 * rejected; the same fixture can compare baseline and candidate outcomes.
 */
const assert = require('node:assert/strict')
const { spawn } = require('node:child_process')
const { createHash } = require('node:crypto')
const {
  cp,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  rm,
  symlink,
  writeFile,
} = require('node:fs/promises')
const { tmpdir } = require('node:os')
const { join, relative, resolve } = require('node:path')
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
const appRoot = resolve(
  process.env.LIFE_TEST_APP_ROOT ||
    '/root/.local/share/life-feedback-runtime/apps/streaming-checkpoints-9142998',
)
const artifacts = resolve(
  repository,
  process.env.LIFE_TEST_ARTIFACTS_DIR || 'output/playwright/renderer-document-dispatch-electron',
)
const expectedOutcome = process.env.LIFE_TEST_EXPECT_DOCUMENT_DISPATCH || 'observe'
const targetTitle = 'OLD_DOCUMENT_DISPATCHED'
const injection = 'globalThis.__lifeAdmissionRuntime = operations;'

function digest(bytes) {
  return createHash('sha256').update(bytes).digest('hex')
}

async function identity(root) {
  const files = {}
  const visit = async (directory) => {
    const entries = await readdir(directory, { withFileTypes: true })
    entries.sort((left, right) => left.name.localeCompare(right.name))
    for (const entry of entries) {
      const path = join(directory, entry.name)
      if (entry.isDirectory()) await visit(path)
      else if (entry.isFile()) files[relative(root, path)] = digest(await readFile(path))
      else throw new Error(`Source/build identity cannot omit a symbolic entry: ${path}`)
    }
  }
  for (const directory of ['src', 'out']) await visit(join(root, directory))
  files['package.json'] = digest(await readFile(join(root, 'package.json')))
  const selected = (prefix) => Object.entries(files).filter(([name]) => name.startsWith(prefix))
  return {
    root,
    files,
    source: { count: selected('src/').length, sha256: digest(JSON.stringify(selected('src/'))) },
    out: { count: selected('out/').length, sha256: digest(JSON.stringify(selected('out/'))) },
    native: {
      main: files['out/main/index.js'],
      preload: files['out/preload/index.js'],
      worker: files['out/main/conversation-checkpoint-worker.js'],
    },
  }
}

function waitForExit(child, timeoutMs) {
  if (child.exitCode !== null || child.signalCode !== null)
    return Promise.resolve({ code: child.exitCode, signal: child.signalCode })
  return new Promise((resolveExit, rejectExit) => {
    const timeout = setTimeout(() => {
      child.removeListener('exit', finish)
      rejectExit(new Error(`Process ${child.pid} did not exit within ${timeoutMs} ms`))
    }, timeoutMs)
    function finish(code, signal) {
      clearTimeout(timeout)
      resolveExit({ code, signal })
    }
    child.once('exit', finish)
  })
}

async function privateDisplay() {
  assert.equal(process.platform, 'linux', 'This isolated fixture requires Linux Xvfb')
  const child = spawn(
    'Xvfb',
    [
      '-displayfd',
      '3',
      '-screen',
      '0',
      '1920x1080x24',
      '-nolisten',
      'tcp',
      '-extension',
      'MIT-SHM',
    ],
    { stdio: ['ignore', 'ignore', 'pipe', 'pipe'] },
  )
  let logs = ''
  child.stderr.on('data', (chunk) => {
    logs = (logs + String(chunk)).slice(-4000)
  })
  try {
    const number = await new Promise((resolveDisplay, rejectDisplay) => {
      let received = ''
      const timeout = setTimeout(
        () => finish(new Error('Private Xvfb did not report a display')),
        10_000,
      )
      const error = (cause) => finish(cause)
      const exit = (code) =>
        finish(new Error(`Private Xvfb exited during startup: ${code}; ${logs}`))
      const data = (chunk) => {
        received += String(chunk)
        if (received.includes('\n')) {
          const value = received.trim()
          finish(
            /^\d+$/.test(value) ? undefined : new Error(`Invalid Xvfb display: ${value}`),
            value,
          )
        }
      }
      function finish(cause, value) {
        clearTimeout(timeout)
        child.removeListener('error', error)
        child.removeListener('exit', exit)
        child.stdio[3].removeListener('data', data)
        if (cause) rejectDisplay(cause)
        else resolveDisplay(value)
      }
      child.once('error', error)
      child.once('exit', exit)
      child.stdio[3].on('data', data)
    })
    return { child, display: `:${number}`, logs: () => logs }
  } catch (error) {
    if (child.pid && child.exitCode === null && child.signalCode === null) child.kill('SIGTERM')
    if (child.pid) await waitForExit(child, 10_000)
    throw error
  }
}

async function installProbe(application) {
  return application.evaluate(({ BrowserWindow, ipcMain }, title) => {
    const runtime = globalThis.__lifeAdmissionRuntime
    if (!runtime || typeof runtime.invoke !== 'function')
      throw new Error('Explicit copied-main runtime injection is unavailable')
    const windows = BrowserWindow.getAllWindows()
    if (windows.length !== 1) throw new Error('Expected one isolated Life window')
    const window = windows[0]
    const contents = window.webContents
    const originalInvoke = runtime.invoke
    const invocationMap = ipcMain._invokeHandlers
    const originalHandler = invocationMap?.get('extensions:invoke')
    const state = {
      installedAt: Date.now(),
      title,
      held: false,
      holdCount: 0,
      wrapperOutcome: 'not-dispatched',
      nativeCalls: [],
      navigation: [],
      commits: [],
      processFailures: [],
      beforeWindowId: window.id,
      beforeContentsId: contents.id,
      observerAvailable: typeof originalHandler === 'function',
    }
    const safeRead = (object, key) => {
      try {
        return object?.[key] ?? null
      } catch (error) {
        return { error: error.message }
      }
    }
    const frame = (value) => ({
      present: Boolean(value),
      url: safeRead(value, 'url'),
      processId: safeRead(value, 'processId'),
      routingId: safeRead(value, 'routingId'),
      frameTreeNodeId: safeRead(value, 'frameTreeNodeId'),
      detached: safeRead(value, 'detached'),
    })
    const describe = () => {
      let currentSenderFrame = null,
        currentSenderFrameError = null
      try {
        currentSenderFrame = state.senderEvent?.senderFrame ?? null
      } catch (error) {
        currentSenderFrameError = error.message
      }
      const currentMain = contents.mainFrame
      return {
        title: window.getTitle(),
        windowId: window.id,
        contentsId: contents.id,
        currentMain: frame(currentMain),
        receivedSender: frame(state.receivedSender),
        currentSender: frame(currentSenderFrame),
        currentSenderFrameError,
        receivedSenderEqualsCurrentMain: state.receivedSender
          ? state.receivedSender === currentMain
          : null,
        currentSenderEqualsCurrentMain: currentSenderFrame
          ? currentSenderFrame === currentMain
          : null,
        mainFrameIdentityPreserved: state.receivedMain ? state.receivedMain === currentMain : null,
        eventSenderFrameIdentityPreserved: state.receivedSender
          ? state.receivedSender === currentSenderFrame
          : null,
      }
    }
    const selected = (name, args) =>
      name === 'extensions:invoke' && args?.[0] === 'window.configure' && args?.[1]?.title === title
    let resolveHeld, resolveRelease, resolveSettled
    state.whenHeld = new Promise((done) => (resolveHeld = done))
    state.whenSettled = new Promise((done) => (resolveSettled = done))
    const releaseGate = new Promise((done) => (resolveRelease = done))
    state.release = () => {
      if (!state.releasedAt) {
        state.releasedAt = Date.now()
        state.atRelease = describe()
        resolveRelease()
      }
    }
    const wrappedHandler = function (event, ...args) {
      if (selected('extensions:invoke', args)) {
        state.senderEvent = event
        state.receivedSender = event.senderFrame
        state.receivedMain = contents.mainFrame
        state.receivedAt = Date.now()
        state.atReceive = describe()
      }
      return originalHandler.call(this, event, ...args)
    }
    if (state.observerAvailable) invocationMap.set('extensions:invoke', wrappedHandler)
    const wrappedInvoke = function (name, args, options) {
      state.nativeCalls.push({
        name,
        at: Date.now(),
        hasBeforeDispatch: Boolean(options?.beforeDispatch),
      })
      if (!selected(name, args)) return originalInvoke.call(this, name, args, options)
      if (typeof options?.beforeDispatch !== 'function')
        throw new Error('Targeted call did not retain the production beforeDispatch closure')
      state.holdCount++
      if (state.holdCount !== 1) throw new Error('Targeted invocation was delivered more than once')
      state.held = true
      state.heldAt = Date.now()
      state.atHold = describe()
      resolveHeld()
      const receiver = this
      state.pending = (async () => {
        await releaseGate
        state.originalRuntimeStartedAt = Date.now()
        try {
          const value = await originalInvoke.call(receiver, name, args, options)
          state.wrapperOutcome = 'fulfilled'
          state.wrapperResult = value
          return value
        } catch (error) {
          state.wrapperOutcome = 'rejected'
          state.wrapperError = {
            name: error?.name ?? null,
            message: error?.message ?? String(error),
          }
          throw error
        } finally {
          state.settledAt = Date.now()
          state.atSettlement = describe()
          resolveSettled()
        }
      })()
      return state.pending
    }
    runtime.invoke = wrappedInvoke
    const onNavigation = (_event, url, inPlace, isMainFrame, processId, routingId) => {
      state.navigation.push({ at: Date.now(), url, inPlace, isMainFrame, processId, routingId })
    }
    const onCommit = (_event, url, responseCode, statusText) => {
      state.commits.push({
        at: Date.now(),
        url,
        responseCode,
        statusText,
        nativeFrame: frame(contents.mainFrame),
      })
    }
    const onProcessFailure = (_event, details) => state.processFailures.push(details)
    contents.on('did-start-navigation', onNavigation)
    contents.on('did-navigate', onCommit)
    contents.on('render-process-gone', onProcessFailure)
    state.restore = () => {
      if (runtime.invoke === wrappedInvoke) runtime.invoke = originalInvoke
      if (state.observerAvailable && invocationMap.get('extensions:invoke') === wrappedHandler)
        invocationMap.set('extensions:invoke', originalHandler)
      contents.removeListener('did-start-navigation', onNavigation)
      contents.removeListener('did-navigate', onCommit)
      contents.removeListener('render-process-gone', onProcessFailure)
    }
    state.describe = describe
    globalThis.__lifeDocumentDispatchProbe = state
    return { observerAvailable: state.observerAvailable, nativeWindow: describe() }
  }, targetTitle)
}

async function run() {
  assert.ok(['observe', 'fulfilled', 'rejected'].includes(expectedOutcome))
  await mkdir(artifacts, { recursive: true })
  const temporary = await mkdtemp(join(tmpdir(), 'life-document-dispatch-'))
  const copiedApp = join(temporary, 'app')
  const configurationRoot = join(temporary, 'config')
  const proof = {
    fixture: 'queued-native-dispatch-after-main-document-commit',
    expectedOutcome,
    inputAppRoot: appRoot,
    privateAppRoot: copiedApp,
    privateConfigurationRoot: configurationRoot,
    injection: {
      testOnly: true,
      assignment: injection,
      productionDispatchModified: false,
      productionBeforeDispatchModified: false,
      optionalPrivateIpcMapObserver: true,
    },
    sshRequested: false,
    providerAuthenticationRequested: false,
    providerInferenceRequested: false,
    targetTitle,
    rendererErrors: [],
    nativeLogs: [],
    cleanup: {},
  }
  let application, applicationChild, display, originalIdentity, invocationObservation, failure
  try {
    originalIdentity = await identity(appRoot)
    proof.originalIdentity = originalIdentity
    await mkdir(copiedApp, { recursive: true })
    await mkdir(configurationRoot, { recursive: true })
    await seedPrivateSSHSelection(configurationRoot)
    for (const name of ['src', 'out', 'build', 'package.json'])
      await cp(join(appRoot, name), join(copiedApp, name), { recursive: true })
    await symlink(join(appRoot, 'node_modules'), join(copiedApp, 'node_modules'), 'dir')
    const mainPath = join(copiedApp, 'out/main/index.js')
    const originalMain = await readFile(mainPath, 'utf8')
    const assignment = 'applicationRuntime = operations;'
    assert.equal(originalMain.split(assignment).length - 1, 1, 'Expected one runtime assignment')
    assert.ok(!originalMain.includes(injection), 'Selected build already contains a test injection')
    const injectedMain = originalMain.replace(assignment, `${assignment}\n  ${injection}`)
    await writeFile(mainPath, injectedMain)
    proof.copiedIdentity = await identity(copiedApp)
    assert.equal(proof.copiedIdentity.native.preload, originalIdentity.native.preload)
    assert.equal(proof.copiedIdentity.native.worker, originalIdentity.native.worker)
    for (const [name, hash] of Object.entries(originalIdentity.files))
      if (name !== 'out/main/index.js') assert.equal(proof.copiedIdentity.files[name], hash, name)
    assert.equal(proof.copiedIdentity.native.main, digest(injectedMain))
    display = await privateDisplay()
    proof.privateDisplay = display.display
    const env = {
      ...process.env,
      DISPLAY: display.display,
      ELECTRON_RENDERER_URL: '',
      XDG_CONFIG_HOME: configurationRoot,
      LIFE_TEST_CONFIG_HOME: configurationRoot,
    }
    delete env.ELECTRON_RUN_AS_NODE
    application = await electron.launch({
      executablePath: process.env.LIFE_ELECTRON_BINARY || require('electron'),
      args: [
        copiedApp,
        '--no-sandbox',
        '--disable-dev-shm-usage',
        `--user-data-dir=${join(configurationRoot, 'chromium')}`,
      ],
      cwd: copiedApp,
      env,
      timeout: 30_000,
    })
    applicationChild = application.process()
    for (const stream of ['stdout', 'stderr'])
      applicationChild[stream]?.on('data', (chunk) => {
        proof.nativeLogs.push({ stream, text: String(chunk).slice(-4000) })
        if (proof.nativeLogs.length > 20) proof.nativeLogs.shift()
      })
    const page = await application.firstWindow()
    page.setDefaultTimeout(30_000)
    page.on('pageerror', (error) => proof.rendererErrors.push(error.message))
    await page.locator('.app-shell').waitFor()
    proof.launch = await application.evaluate(({ app, BrowserWindow }) => {
      const fs = process.getBuiltinModule('node:fs')
      const path = process.getBuiltinModule('node:path')
      const crypto = process.getBuiltinModule('node:crypto')
      const hash = (name) =>
        crypto
          .createHash('sha256')
          .update(fs.readFileSync(path.join(app.getAppPath(), name)))
          .digest('hex')
      const window = BrowserWindow.getAllWindows()[0]
      return {
        appPath: app.getAppPath(),
        userData: app.getPath('userData'),
        packaged: app.isPackaged,
        version: app.getVersion(),
        electronVersion: process.versions.electron,
        chromiumVersion: process.versions.chrome,
        windowId: window.id,
        contentsId: window.webContents.id,
        rendererSandboxed: window.webContents.getLastWebPreferences().sandbox,
        native: {
          main: hash('out/main/index.js'),
          preload: hash('out/preload/index.js'),
          worker: hash('out/main/conversation-checkpoint-worker.js'),
        },
      }
    })
    assert.equal(proof.launch.appPath, copiedApp)
    assert.ok(proof.launch.userData.startsWith(configurationRoot))
    assert.equal(proof.launch.rendererSandboxed, true)
    assert.deepEqual(proof.launch.native, proof.copiedIdentity.native)
    proof.initialConnection = await page.evaluate(() => window.relay.connection.state())
    assert.equal(proof.initialConnection.status, 'disconnected')
    assert.notEqual(proof.initialConnection.profile?.transport, 'local')
    proof.installed = await installProbe(application)
    await page.evaluate(() =>
      window.relay.extensions.invoke('window.configure', { title: 'CURRENT_DOCUMENT_ALLOWED' }),
    )
    proof.positiveControlBeforeReload = await application.evaluate(({ BrowserWindow }) =>
      BrowserWindow.getAllWindows()[0].getTitle(),
    )
    assert.equal(proof.positiveControlBeforeReload, 'CURRENT_DOCUMENT_ALLOWED')
    invocationObservation = page
      .evaluate(
        (title) => window.relay.extensions.invoke('window.configure', { title }),
        targetTitle,
      )
      .then(
        (value) => ({ outcome: 'fulfilled', value }),
        (error) => ({ outcome: 'rejected', message: error.message }),
      )
    await application.evaluate(async () => {
      const state = globalThis.__lifeDocumentDispatchProbe
      let timeout
      try {
        await Promise.race([
          state.whenHeld,
          new Promise((_, reject) => {
            timeout = setTimeout(
              () => reject(new Error('Production-admitted IPC was not held')),
              10_000,
            )
          }),
        ])
      } finally {
        clearTimeout(timeout)
      }
    })
    proof.beforeReload = await application.evaluate(() => {
      const state = globalThis.__lifeDocumentDispatchProbe
      return { held: state.held, holdCount: state.holdCount, ...state.describe() }
    })
    assert.equal(proof.beforeReload.holdCount, 1)
    assert.notEqual(
      proof.beforeReload.title,
      targetTitle,
      'Hold must precede the production dispatch',
    )
    await application.evaluate(({ BrowserWindow }) => {
      const contents = BrowserWindow.getAllWindows()[0].webContents
      return new Promise((resolveReload, rejectReload) => {
        const timeout = setTimeout(() => finish(new Error('Native reload did not finish')), 30_000)
        function finish(error) {
          clearTimeout(timeout)
          contents.removeListener('did-finish-load', finished)
          if (error) rejectReload(error)
          else resolveReload()
        }
        const finished = () => finish()
        contents.once('did-finish-load', finished)
        globalThis.__lifeDocumentDispatchProbe.reloadRequestedAt = Date.now()
        contents.reload()
      })
    })
    await page.locator('.app-shell').waitFor()
    await page.waitForFunction(() => typeof window.relay?.extensions?.invoke === 'function')
    proof.afterReloadBeforeRelease = await application.evaluate(() => {
      const state = globalThis.__lifeDocumentDispatchProbe
      return { held: state.held, commits: state.commits, ...state.describe() }
    })
    assert.ok(
      proof.afterReloadBeforeRelease.commits.length >= 1,
      'Requires a real native document commit',
    )
    assert.equal(proof.afterReloadBeforeRelease.windowId, proof.beforeReload.windowId)
    assert.equal(proof.afterReloadBeforeRelease.contentsId, proof.beforeReload.contentsId)
    assert.notEqual(proof.afterReloadBeforeRelease.title, targetTitle)
    proof.dispatch = await application.evaluate(async () => {
      const state = globalThis.__lifeDocumentDispatchProbe
      state.release()
      let timeout
      try {
        await Promise.race([
          state.whenSettled,
          new Promise((_, reject) => {
            timeout = setTimeout(
              () => reject(new Error('Released production dispatch did not settle')),
              10_000,
            )
          }),
        ])
      } finally {
        clearTimeout(timeout)
      }
      return {
        outcome: state.wrapperOutcome,
        error: state.wrapperError ?? null,
        result: state.wrapperResult ?? null,
        holdCount: state.holdCount,
        observerAvailable: state.observerAvailable,
        atReceive: state.atReceive ?? null,
        atHold: state.atHold,
        atRelease: state.atRelease,
        atSettlement: state.atSettlement,
        receivedAt: state.receivedAt ?? null,
        heldAt: state.heldAt,
        reloadRequestedAt: state.reloadRequestedAt,
        releasedAt: state.releasedAt,
        originalRuntimeStartedAt: state.originalRuntimeStartedAt,
        settledAt: state.settledAt,
        navigation: state.navigation,
        commits: state.commits,
        nativeCalls: state.nativeCalls,
        processFailures: state.processFailures,
      }
    })
    proof.oldRendererResponse = await invocationObservation
    assert.ok(['fulfilled', 'rejected'].includes(proof.dispatch.outcome))
    assert.equal(proof.dispatch.holdCount, 1)
    assert.ok(
      proof.dispatch.commits.some((commit) => commit.at >= proof.dispatch.reloadRequestedAt),
    )
    assert.ok(proof.dispatch.releasedAt >= proof.dispatch.commits.at(-1).at)
    assert.ok(proof.dispatch.originalRuntimeStartedAt >= proof.dispatch.releasedAt)
    if (proof.dispatch.outcome === 'fulfilled')
      assert.equal(proof.dispatch.atSettlement.title, targetTitle)
    else assert.notEqual(proof.dispatch.atSettlement.title, targetTitle)
    if (expectedOutcome !== 'observe') assert.equal(proof.dispatch.outcome, expectedOutcome)
    await page.evaluate(() =>
      window.relay.extensions.invoke('window.configure', { title: 'NEW_DOCUMENT_ALLOWED' }),
    )
    proof.positiveControlAfterReload = await application.evaluate(({ BrowserWindow }) =>
      BrowserWindow.getAllWindows()[0].getTitle(),
    )
    assert.equal(proof.positiveControlAfterReload, 'NEW_DOCUMENT_ALLOWED')
    proof.finalConnection = await page.evaluate(() => window.relay.connection.state())
    assert.equal(proof.finalConnection.status, 'disconnected')
    await page.screenshot({ path: join(artifacts, 'reloaded-life.png') })
    assert.deepEqual(proof.rendererErrors, [])
    assert.deepEqual(proof.dispatch.processFailures, [])
    proof.verified = true
  } catch (error) {
    failure = error
    proof.failure = { message: error.message, stack: error.stack }
  } finally {
    // Retain the observed dispatch even if a later teardown check fails.
    await writeFile(join(artifacts, 'proof.json'), JSON.stringify(proof, null, 2) + '\n')
    if (application) {
      try {
        await application.evaluate(() => {
          const state = globalThis.__lifeDocumentDispatchProbe
          state?.release()
          state?.restore()
        })
        await application.close()
        proof.cleanup.electron = await waitForExit(applicationChild, 10_000)
      } catch (error) {
        proof.cleanup.electronError = error.message
        const child = applicationChild
        if (child.exitCode === null && child.signalCode === null) child.kill('SIGTERM')
        try {
          proof.cleanup.electron = await waitForExit(child, 10_000)
        } catch (exitError) {
          proof.cleanup.electronExitError = exitError.message
          child.kill('SIGKILL')
          proof.cleanup.electron = await waitForExit(child, 10_000)
        }
        failure ??= error
      }
    }
    if (display) {
      proof.cleanup.xvfbLogs = display.logs()
      display.child.kill('SIGTERM')
      try {
        proof.cleanup.xvfb = await waitForExit(display.child, 10_000)
      } catch (error) {
        proof.cleanup.xvfbError = error.message
        display.child.kill('SIGKILL')
        proof.cleanup.xvfb = await waitForExit(display.child, 10_000)
        failure ??= error
      }
    }
    if (originalIdentity) {
      proof.inputIdentityAfter = await identity(appRoot)
      try {
        assert.deepEqual(
          proof.inputIdentityAfter,
          originalIdentity,
          'Selected app must remain unchanged',
        )
        proof.inputAppUnchanged = true
      } catch (error) {
        failure ??= error
        proof.inputAppUnchanged = false
      }
    }
    await rm(temporary, { recursive: true, force: true })
    proof.cleanup.privateFilesRemoved = true
    await writeFile(join(artifacts, 'proof.json'), JSON.stringify(proof, null, 2) + '\n')
  }
  if (failure) throw failure
  console.log(
    JSON.stringify({
      verified: proof.verified,
      outcome: proof.dispatch.outcome,
      frameIdentityPreserved: proof.dispatch.atRelease.mainFrameIdentityPreserved,
      rendererErrors: proof.rendererErrors.length,
      artifacts,
    }),
  )
}

run().catch((error) => {
  console.error(error)
  process.exitCode = 1
})
