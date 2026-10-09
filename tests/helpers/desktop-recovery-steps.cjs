const assert = require('node:assert/strict')
const { existsSync } = require('node:fs')
const { readFile, readdir, writeFile } = require('node:fs/promises')
const { join } = require('node:path')

/** Native recovery checks share the caller's live Electron/SSH fixture. */
async function runRecoveryChecks(context) {
  const {
    getPage,
    setPage,
    getApplication,
    fixture,
    artifacts,
    send,
    waitUntil,
    workspace,
    sourceCode,
    extensions,
    configuration,
    checks,
  } = context
  const page = () => getPage()
  const application = () => getApplication()
  const record = (label) => checks.push(label)
  const saveProof = (filename, proof) =>
    writeFile(join(artifacts, filename), JSON.stringify(proof, null, 2) + '\n')
  const history = () =>
    page().evaluate(() => JSON.parse(localStorage.getItem('relay.threads.v1') || '[]'))
  const connection = () => page().evaluate(() => window.relay.connection.state())
  const readyToSend = () =>
    page().getByRole('button', { name: 'Send message', exact: true }).waitFor()
  const promptFrom = (entry) =>
    entry.message?.method === 'turn/start'
      ? entry.message.params.input[0].text
      : entry.message?.type === 'user'
        ? entry.message.message.content[0].text
        : undefined
  const replacePage = async (replacement) => {
    await setPage(replacement)
    page().setDefaultTimeout(15000)
    await page().locator('.app-shell').waitFor()
  }

  // Observe actual native events without changing renderer-recovery behavior.
  await application().evaluate(({ app, BrowserWindow }) => {
    if (globalThis.__lifeRendererProof) return
    const events = []
    const windows = []
    globalThis.__lifeRendererProof = { events, windows, expected: false }
    const observe = (window) => {
      windows.push({ type: 'created', id: window.id })
      window.webContents.on('render-process-gone', (_event, detail) => {
        events.push({
          type: 'render-process-gone',
          reason: detail.reason,
          exitCode: detail.exitCode,
          expected: globalThis.__lifeRendererProof.expected,
        })
      })
      window.on('unresponsive', () => {
        events.push({ type: 'unresponsive', expected: globalThis.__lifeRendererProof.expected })
      })
    }
    for (const window of BrowserWindow.getAllWindows()) observe(window)
    app.on('browser-window-created', (_event, window) => observe(window))
  })

  // Studio coverage leaves a healthy custom renderer enabled. Exercise stock
  // renderer recovery separately so this intentional kill does not mark that
  // unrelated source generation as failed.
  const originalSource = await sourceCode()
  const previousHealthyRevision = originalSource.active?.revision
  if (originalSource.enabled) {
    await page().evaluate(() => window.relay.sourceCode.disable())
    const stockReload = page().waitForEvent('domcontentloaded', { timeout: 90000 })
    await page().evaluate(() => window.relay.sourceCode.reload())
    await stockReload
    await page().locator('.app-shell').waitFor()
    assert.equal((await sourceCode()).enabled, false)
  }

  await workspace()
  await page().getByRole('button', { name: 'New thread', exact: false }).click()
  await page()
    .getByRole('combobox', { name: /^Model:/ })
    .click()
  await page().getByRole('option', { name: 'Codex default', exact: true }).click()
  const retryLogStart = (await fixture.log()).length
  await send('hang')
  await page()
    .getByRole('button', { name: 'Stop agent and pause queued messages', exact: true })
    .waitFor()
  await waitUntil(
    async () =>
      page().evaluate(() =>
        JSON.parse(localStorage.getItem('relay.threads.v1') || '[]').some(
          (thread) =>
            thread.id === localStorage.getItem('life.active-thread.v1') && thread.remoteId,
        ),
      ),
    'busy conversation identity persists before native Retry',
  )
  const beforeRetry = {
    connection: await connection(),
    extensions: (await extensions()).extensions,
    thread: await page().evaluate(() => {
      const active = localStorage.getItem('life.active-thread.v1')
      return JSON.parse(localStorage.getItem('relay.threads.v1') || '[]').find(
        (thread) => thread.id === active,
      )
    }),
  }
  assert.ok(beforeRetry.thread?.remoteId)
  const retryWindow = application().waitForEvent('window', { timeout: 15000 })
  const retryInvocation = page()
    .evaluate(() => window.relay.window.restart())
    .catch((error) => assert.match(error.message, /closed|destroyed|execution context/i))
  await replacePage(await retryWindow)
  await retryInvocation
  await workspace()
  const afterRetryConnection = await connection()
  assert.equal(afterRetryConnection.status, 'connected')
  assert.equal(afterRetryConnection.profile.id, beforeRetry.connection.profile.id)
  assert.equal(afterRetryConnection.workspace, beforeRetry.connection.workspace)
  assert.deepEqual((await extensions()).extensions, beforeRetry.extensions)
  await readyToSend()
  await send('native-after-retry')
  await readyToSend()
  await waitUntil(
    async () =>
      (await history())
        .find((thread) => thread.id === beforeRetry.thread.id)
        ?.messages.some(
          (message) => message.role === 'user' && message.text === 'native-after-retry',
        ),
    'the same saved conversation accepts a message after native Retry',
  )
  const afterRetryThread = (await history()).find((thread) => thread.id === beforeRetry.thread.id)
  assert.equal(afterRetryThread.remoteId, beforeRetry.thread.remoteId)
  assert.equal(afterRetryThread.workspace, beforeRetry.thread.workspace)
  assert.ok(
    (await fixture.log())
      .slice(retryLogStart)
      .some((entry) => promptFrom(entry) === 'native-after-retry'),
  )
  assert.equal(
    await page()
      .locator('.chat-error')
      .filter({ hasText: /already running/i })
      .count(),
    0,
  )
  await saveProof('desktop-native-retry-proof.json', {
    threadId: afterRetryThread.id,
    remoteId: afterRetryThread.remoteId,
    workspace: afterRetryConnection.workspace,
    enabledExtensions: beforeRetry.extensions
      .filter((entry) => entry.enabled)
      .map((entry) => entry.id),
  })
  record(
    'Native Retry stops a busy agent and restores its existing conversation without losing SSH',
  )

  const recoveryExtension = {
    id: 'native-recovery-proof',
    name: 'Native recovery fixture',
    description: 'Disposable native recovery fixture; no external provider or account is used.',
    version: '1.0.0',
    enabled: true,
    renderer: {
      placement: 'view',
      html: '<main><h1>Native recovery counter</h1><button id="increment">Increment</button><output id="count">Count: 0</output><p id="connection">Checking SSH state…</p></main>',
      css: 'main{padding:24px;color:var(--text)}output{display:block;margin-top:16px}',
      js: `document.getElementById('increment').addEventListener('click', async () => {
  const result = await life.call('increment', null);
  document.getElementById('count').textContent = 'Count: ' + result.count;
});
(async () => {
  const state = await life.invoke('connection.state', {});
  document.getElementById('connection').textContent = 'SSH: ' + state.status;
})();`,
    },
    main: "let count = 0; life.handle('increment', () => ({ count: ++count }));",
  }
  await page().evaluate((manifest) => window.relay.extensions.apply(manifest), recoveryExtension)
  assert.equal((await extensions()).errors[recoveryExtension.id], undefined)
  const recoveryFrame = () => page().frameLocator('iframe[title="Native recovery fixture"]')
  const openRecoveryFrame = async () => {
    await page().getByRole('button', { name: recoveryExtension.name, exact: true }).click()
    await recoveryFrame()
      .getByRole('heading', { name: 'Native recovery counter', exact: true })
      .waitFor()
    await recoveryFrame().getByText('SSH: connected', { exact: true }).waitFor()
  }
  await openRecoveryFrame()
  await recoveryFrame().getByRole('button', { name: 'Increment', exact: true }).click()
  await recoveryFrame().getByText('Count: 1', { exact: true }).waitFor()
  await workspace()

  const beforeCrash = {
    connection: await connection(),
    extensions: await extensions(),
    config: await configuration(),
    history: await history(),
    bounds: await application().evaluate(({ BrowserWindow }) =>
      BrowserWindow.getAllWindows()[0].getBounds(),
    ),
  }
  const replacementWindow = application().waitForEvent('window', { timeout: 15000 })
  const rendererTermination = await application().evaluate(({ BrowserWindow }) => {
    globalThis.__lifeRendererProof.expected = true
    const owner = BrowserWindow.getAllWindows()[0]
    const pid = owner.webContents.mainFrame.osProcessId
    if (!Number.isInteger(pid) || pid <= 0 || pid === process.pid)
      throw new Error('Refusing to terminate an invalid main-frame renderer PID')
    const proof = {
      oldWindowId: owner.id,
      rendererPid: pid,
      mainPid: process.pid,
      method: 'SIGKILL',
    }
    // forcefullyCrashRenderer can report a Chromium fatal error without terminating
    // its process. Kill the actual owned renderer to exercise the native event.
    process.kill(pid, 'SIGKILL')
    return proof
  })
  await replacePage(await replacementWindow)
  await application().evaluate(() => {
    globalThis.__lifeRendererProof.expected = false
  })
  const recoveredWindowId = await application().evaluate(
    ({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].id,
  )
  assert.notEqual(recoveredWindowId, rendererTermination.oldWindowId)
  const rendererEvents = await application().evaluate(() => globalThis.__lifeRendererProof.events)
  assert.ok(
    rendererEvents.some(
      (event) =>
        event.type === 'render-process-gone' &&
        event.expected &&
        ['killed', 'crashed'].includes(event.reason),
    ),
    'Actual renderer termination emits a native renderer-gone event.',
  )
  const recoveredConnection = await connection()
  assert.equal(recoveredConnection.status, 'connected')
  assert.equal(recoveredConnection.profile.id, beforeCrash.connection.profile.id)
  assert.equal(recoveredConnection.workspace, beforeCrash.connection.workspace)
  assert.deepEqual((await extensions()).extensions, beforeCrash.extensions.extensions)
  assert.deepEqual((await configuration()).config, beforeCrash.config.config)
  assert.deepEqual(
    await application().evaluate(({ BrowserWindow }) =>
      BrowserWindow.getAllWindows()[0].getBounds(),
    ),
    beforeCrash.bounds,
  )
  const recoveredHistory = await history()
  for (const thread of beforeCrash.history)
    assert.equal(recoveredHistory.find((item) => item.id === thread.id)?.remoteId, thread.remoteId)
  await openRecoveryFrame()
  await recoveryFrame().getByRole('button', { name: 'Increment', exact: true }).click()
  await recoveryFrame().getByText('Count: 2', { exact: true }).waitFor()
  await saveProof('desktop-stock-renderer-recovery-proof.json', {
    connected: recoveredConnection.status,
    workspace: recoveredConnection.workspace,
    historyThreads: recoveredHistory.length,
    enabledExtensions: (await extensions()).extensions
      .filter((entry) => entry.enabled)
      .map((entry) => entry.id),
    rendererEvents,
    rendererTermination,
    replacementWindowId: recoveredWindowId,
    workerPreserved: true,
  })
  record(
    'Actual renderer PID termination preserves SSH, project, history, window bounds and extensions',
  )
  await workspace()

  let tailwindVerified = false
  if (process.env.LIFE_TEST_TAILWIND === '1') {
    const beforeTailwind = await sourceCode()
    const appContext = await page().evaluate(() =>
      window.relay.sourceCode.getContext({ paths: ['src/renderer/App.tsx'] }),
    )
    const appSource = appContext.files.find((file) => file.path === 'src/renderer/App.tsx')?.content
    assert.ok(appSource, 'The source compiler exposes the actual composed application source.')
    const titleBarAnchor = appSource.match(/^([ \t]*)<TitleBar\r?\n/m)
    assert.ok(titleBarAnchor, 'The Tailwind fixture mounts inside the real application shell.')
    const installedPackages = await readdir(join(beforeTailwind.path, 'packages')).catch(
      (error) => {
        if (error.code === 'ENOENT') return []
        throw error
      },
    )
    assert.ok(
      installedPackages.every(
        (directory) =>
          !existsSync(
            join(
              beforeTailwind.path,
              'packages',
              directory,
              'node_modules/@tailwindcss/postcss/package.json',
            ),
          ),
      ),
      'The native Tailwind proof starts without an installed Tailwind cache.',
    )
    const tailwindPatch = {
      summary: 'Verify Tailwind utilities and directives in the actual Electron source compiler',
      baseRevision: beforeTailwind.revision,
      dependencies: { tailwindcss: '4.3.3', '@tailwindcss/postcss': '4.3.3', postcss: '8.5.29' },
      files: [
        {
          path: 'src/renderer/components/FixtureNativeTailwindProof.tsx',
          content:
            'import \'../fixture-native-tailwind.css\'\nexport function FixtureNativeTailwindProof() { return <div data-testid="native-tailwind-proof" className="p-[28px] font-bold underline bg-life-proof native-tailwind-apply">Native Tailwind compiled</div> }\n',
        },
        {
          path: 'src/renderer/fixture-native-tailwind.css',
          content:
            '@import "tailwindcss/theme.css";\n@import "tailwindcss/utilities.css";\n@theme { --color-life-proof: #123456; }\n.native-tailwind-apply { @apply px-[19px]; }\n',
        },
        {
          path: 'src/renderer/App.tsx',
          edits: [
            {
              find: "import './enhancements.css'",
              replace:
                "import { FixtureNativeTailwindProof } from './components/FixtureNativeTailwindProof'\nimport './enhancements.css'",
            },
            {
              find: titleBarAnchor[0],
              replace: `${titleBarAnchor[1]}<FixtureNativeTailwindProof />\n${titleBarAnchor[0]}`,
            },
          ],
        },
      ],
    }
    await application().evaluate(() => {
      const childProcess = process.getBuiltinModule('node:child_process')
      const originalSpawn = childProcess.spawn
      const proof = {
        mainPid: process.pid,
        executablePath: process.execPath,
        calls: [],
        originalSpawn,
      }
      globalThis.__lifeCompilerProof = proof
      childProcess.spawn = function (executable, args, options) {
        const child = Reflect.apply(originalSpawn, this, arguments)
        if (
          args?.[0] === '-e' &&
          typeof args[1] === 'string' &&
          args[1].includes('@tailwindcss/postcss')
        ) {
          const call = {
            executable,
            pid: child.pid,
            cwd: options.cwd,
            runAsNode: options.env.ELECTRON_RUN_AS_NODE,
            windowsHide: options.windowsHide,
            closed: false,
          }
          proof.calls.push(call)
          child.once('close', (code, signal) => {
            call.closed = true
            call.code = code
            call.signal = signal
          })
        }
        return child
      }
    })
    let tailwindState
    let compilerProcess
    try {
      tailwindState = await page().evaluate(
        (patch) => window.relay.sourceCode.apply(patch),
        tailwindPatch,
      )
    } finally {
      compilerProcess = await application().evaluate(() => {
        const proof = globalThis.__lifeCompilerProof
        process.getBuiltinModule('node:child_process').spawn = proof.originalSpawn
        delete globalThis.__lifeCompilerProof
        return {
          mainPid: proof.mainPid,
          executablePath: proof.executablePath,
          calls: proof.calls,
          parentAlive: process.pid === proof.mainPid,
        }
      })
    }
    assert.equal(tailwindState.error, undefined)
    assert.equal(compilerProcess.parentAlive, true)
    assert.ok(compilerProcess.calls.length > 0, 'Tailwind launches its own compiler process.')
    for (const call of compilerProcess.calls) {
      assert.equal(call.executable, compilerProcess.executablePath)
      assert.ok(Number.isInteger(call.pid) && call.pid !== compilerProcess.mainPid)
      assert.ok(call.cwd.startsWith(beforeTailwind.path))
      assert.equal(call.runAsNode, '1')
      assert.equal(call.windowsHide, true)
      assert.equal(call.closed, true)
      assert.equal(call.code, 0)
      assert.equal(call.signal, null)
    }
    const tailwindReload = page().waitForEvent('domcontentloaded', { timeout: 90000 })
    await page().evaluate(() => window.relay.sourceCode.reload())
    await tailwindReload
    const proof = page().getByTestId('native-tailwind-proof')
    await proof.waitFor()
    const computed = await proof.evaluate((element) => {
      const style = getComputedStyle(element)
      return {
        backgroundColor: style.backgroundColor,
        paddingTop: style.paddingTop,
        paddingLeft: style.paddingLeft,
        fontWeight: style.fontWeight,
        textDecorationLine: style.textDecorationLine,
      }
    })
    assert.deepEqual(computed, {
      backgroundColor: 'rgb(18, 52, 86)',
      paddingTop: '28px',
      paddingLeft: '19px',
      fontWeight: '700',
      textDecorationLine: 'underline',
    })
    const css = await page().evaluate(async () => {
      const state = await window.relay.sourceCode.get()
      return (await fetch(state.active.css)).text()
    })
    assert.ok(css.includes('.bg-life-proof'))
    assert.ok(css.includes('.native-tailwind-apply'))
    assert.doesNotMatch(css, /@apply|@theme|@import\s*["']tailwindcss/)
    await saveProof('desktop-tailwind-proof.json', {
      coldInstall: true,
      compilerProcess,
      source: await sourceCode(),
      computed,
    })
    const restored = await page().evaluate(() => window.relay.sourceCode.rollback())
    if (previousHealthyRevision !== undefined)
      assert.equal(restored.active?.revision, previousHealthyRevision)
    const rolledBackContext = await page().evaluate(() =>
      window.relay.sourceCode.getContext({ paths: ['src/renderer/App.tsx'] }),
    )
    assert.equal(
      rolledBackContext.files.find((file) => file.path === 'src/renderer/App.tsx')?.content,
      appSource,
      'Tailwind rollback restores the complete previous application source.',
    )
    if (!beforeTailwind.enabled) await page().evaluate(() => window.relay.sourceCode.disable())
    const rollbackReload = page().waitForEvent('domcontentloaded', { timeout: 90000 })
    await page().evaluate(() => window.relay.sourceCode.reload())
    await rollbackReload
    await page().locator('.app-shell').waitFor()
    assert.equal(await page().getByTestId('native-tailwind-proof').count(), 0)
    tailwindVerified = true
    record(
      'Cold Tailwind compilation uses an isolated Electron child and produces actual computed styles',
    )
  }

  await openRecoveryFrame()
  const extensionDirectory = (await extensions()).path
  const emergencyHistory = await history()
  const sourceBeforeEmergency = await sourceCode()
  const sourceExtensionIds = (sourceBeforeEmergency.extensions || []).map((entry) => entry.id)
  const portableSourceBundles = await page().evaluate(async () => {
    const state = await window.relay.sourceCode.get()
    return Promise.all(
      state.extensions
        .filter((entry) => !entry.builtIn)
        .map((entry) => window.relay.sourceCode.exportExtension(entry.id)),
    )
  })
  const hangingExtension = {
    ...recoveryExtension,
    version: '2.0.0',
    renderer: {
      ...recoveryExtension.renderer,
      js: '(async () => { await life.call("hangReady", null); document.body.dataset.smokeHang = "running"; while (true) {} })()',
    },
    main: 'life.handle("hangReady", () => { require("node:fs").writeFileSync(require("node:path").join(__dirname, "native-recovery-proof.running"), "iframe entered hang fixture"); return true; });',
  }
  // Do not await renderer hydration: the replacement iframe deliberately loops.
  await page().evaluate((manifest) => {
    void window.relay.extensions.apply(manifest)
  }, hangingExtension)
  await waitUntil(
    async () =>
      JSON.parse(await readFile(join(extensionDirectory, `${recoveryExtension.id}.json`), 'utf8'))
        .version === '2.0.0',
    'hanging extension persists before emergency recovery',
  )
  await waitUntil(
    async () => existsSync(join(extensionDirectory, 'native-recovery-proof.running')),
    'the generated iframe calls its real worker before entering its CPU loop',
  )
  let hangingFrameProof
  await waitUntil(async () => {
    hangingFrameProof = await application().evaluate(async ({ BrowserWindow }, id) => {
      const owner = BrowserWindow.getAllWindows()[0]
      const frame = owner.webContents.mainFrame.framesInSubtree.find((candidate) =>
        candidate.url.startsWith(`life-extension://runtime/view/${id}?`),
      )
      if (!frame) return { exists: false, responsive: true }
      let timeout
      const outcome = await Promise.race([
        frame.executeJavaScript('document.body.dataset.smokeHang').then(
          (value) => ({ responsive: true, value }),
          (error) => ({ responsive: true, error: String(error) }),
        ),
        new Promise((resolveDelay) => {
          timeout = setTimeout(() => resolveDelay({ responsive: false }), 400)
        }),
      ])
      clearTimeout(timeout)
      return { exists: true, rendererPid: frame.osProcessId, mainPid: process.pid, ...outcome }
    }, recoveryExtension.id)
    return hangingFrameProof.exists && !hangingFrameProof.responsive
  }, 'the actual generated iframe is blocked in its CPU loop')
  assert.ok(Number.isInteger(hangingFrameProof.rendererPid) && hangingFrameProof.rendererPid > 0)
  assert.notEqual(hangingFrameProof.rendererPid, hangingFrameProof.mainPid)
  const emergencyWindow = application().waitForEvent('window', { timeout: 15000 })
  await application().evaluate(({ BrowserWindow }) => {
    globalThis.__lifeRendererProof.expected = true
    BrowserWindow.getAllWindows()[0].webContents.emit(
      'before-input-event',
      { preventDefault() {} },
      { type: 'keyDown', key: 'L', control: true, meta: false, shift: true },
    )
  })
  await replacePage(await emergencyWindow)
  await page().getByRole('dialog', { name: 'Manage extensions', exact: true }).waitFor()
  assert.equal(await page().getByRole('dialog').count(), 1)
  const emergencyIntentRemaining = await page().evaluate(() =>
    window.relay.window.initialRecovery(),
  )
  assert.equal(emergencyIntentRemaining, false, 'The new app consumes the startup intent once.')
  assert.equal(
    await page().getByRole('dialog', { name: 'Connect a machine', exact: true }).count(),
    0,
  )
  await application().evaluate(() => {
    globalThis.__lifeRendererProof.expected = false
  })
  await waitUntil(
    async () => (await extensions()).extensions.every((entry) => !entry.enabled),
    'emergency recovery disables every executable runtime extension',
  )
  assert.equal((await connection()).status, 'disconnected')
  assert.equal((await connection()).workspace, undefined)
  assert.equal(await page().evaluate(() => localStorage.getItem('life.active-thread.v1')), null)
  assert.equal(await page().locator('iframe[title="Native recovery fixture"]').count(), 0)
  assert.deepEqual((await extensions()).errors, {})
  const emergencyRecoveredHistory = await history()
  for (const thread of emergencyHistory)
    assert.equal(
      emergencyRecoveredHistory.find((entry) => entry.id === thread.id)?.remoteId,
      thread.remoteId,
      'Emergency recovery preserves every conversation identity.',
    )
  const recoveredSource = await sourceCode()
  assert.equal(recoveredSource.enabled, false)
  assert.equal(recoveredSource.active, undefined)
  assert.deepEqual(
    (recoveredSource.extensions || []).map((entry) => entry.id),
    sourceExtensionIds,
    'Emergency recovery disables source execution without removing portable extensions.',
  )
  const recoveredSourceBundles = await page().evaluate(async () => {
    const state = await window.relay.sourceCode.get()
    return Promise.all(
      state.extensions
        .filter((entry) => !entry.builtIn)
        .map((entry) => window.relay.sourceCode.exportExtension(entry.id)),
    )
  })
  assert.deepEqual(
    recoveredSourceBundles,
    portableSourceBundles,
    'Emergency recovery preserves every original portable source bundle and its contents.',
  )
  await page().keyboard.press('Escape')
  assert.equal(await page().getByRole('dialog').count(), 0)
  await saveProof('desktop-emergency-recovery-proof.json', {
    accelerator: 'Ctrl+Shift+L',
    emergencyIntentRemaining,
    hangingFrameProof,
    connection: await connection(),
    visibleDialogsAfterReview: await page().getByRole('dialog').count(),
    activeThreadId: await page().evaluate(() => localStorage.getItem('life.active-thread.v1')),
    conversationIdentities: emergencyRecoveredHistory.map(({ id, remoteId }) => ({ id, remoteId })),
    source: recoveredSource,
    preservedSourceBundleIds: recoveredSourceBundles.map((entry) => entry.id),
    runtime: await extensions(),
  })
  record('Main-process recovery terminates a hanging iframe and opens a single recovery manager')
  record('Emergency recovery clears active scope and preserves all saved conversation identities')
  return {
    tailwindVerified,
    rendererTermination,
    replacementWindowId: recoveredWindowId,
    emergencyIntentRemaining,
  }
}

module.exports = { runRecoveryChecks }
