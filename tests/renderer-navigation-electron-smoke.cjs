#!/usr/bin/env node
/*
 * Actual Life/Electron/Vite navigation and active-turn ownership regression.
 * No authenticated provider or paid inference is used: only the real loopback
 * SSH/SFTP fixture and its disposable native-protocol provider executables.
 *
 * npm run build && node tests/renderer-navigation-electron-smoke.cjs
 * LIFE_TEST_APP_ROOT selects an immutable baseline or this built candidate.
 * LIFE_TEST_NAVIGATION_CASES selects comma-separated names (default: all):
 * idle-reload,idle-vite-restart,foreign-busy,busy-vite-restart,native-busy-reload
 * LIFE_TEST_ARTIFACTS_DIR isolates baseline/candidate proof and screenshots.
 * Production source/out are read-only and hashed before/after every run.
 */
const assert = require('node:assert/strict')
const { createHash } = require('node:crypto')
const { existsSync } = require('node:fs')
const { mkdir, mkdtemp, readFile, readdir, realpath, rm, writeFile } = require('node:fs/promises')
const { createServer: createHTTPServer } = require('node:http')
const { createServer: createTCPServer } = require('node:net')
const { tmpdir } = require('node:os')
const { dirname, join, relative, resolve } = require('node:path')
const { performance } = require('node:perf_hooks')
const { spawnSync } = require('node:child_process')
const { build } = require('esbuild')
const { _electron: electron } = require('playwright')
const { readSavedThreads } = require('./helpers/desktop-history.cjs')

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
const appRoot = resolve(process.env.LIFE_TEST_APP_ROOT || repository)
const artifacts = resolve(
  repository,
  process.env.LIFE_TEST_ARTIFACTS_DIR || 'output/playwright/renderer-navigation',
)
const caseNames = [
  'idle-reload',
  'idle-vite-restart',
  'foreign-busy',
  'busy-vite-restart',
  'native-busy-reload',
]
const selectedCases = new Set(
  process.env.LIFE_TEST_NAVIGATION_CASES?.split(',').filter(Boolean) || caseNames,
)
for (const name of selectedCases) assert.ok(caseNames.includes(name), `Unknown case: ${name}`)
assert.ok(selectedCases.size, 'At least one actual navigation workflow is required')
const hash = (bytes) => createHash('sha256').update(bytes).digest('hex')
const viteLatchCounts = (code) => {
  const events = [
    ...code.matchAll(
      /window\.addEventListener\?\.\(\s*["'](beforeunload|pagehide)["']\s*,\s*\(\s*\)\s*=>\s*\{\s*willUnload\s*=\s*true\s*;\s*\}\s*\)/g,
    ),
  ].map((match) => match[1])
  return {
    beforeunload: events.filter((event) => event === 'beforeunload').length,
    pagehide: events.filter((event) => event === 'pagehide').length,
  }
}
let signalFailure

assert.equal(process.platform, 'linux', 'The real Bash SSH fixture currently requires Linux')
if (!process.env.LIFE_NAVIGATION_FIXTURE_XVFB) {
  assert.equal(spawnSync('xvfb-run', ['--help'], { stdio: 'ignore' }).status, 0)
  const child = spawnSync(
    'xvfb-run',
    ['-a', '-s', '-screen 0 1920x1080x24 -extension MIT-SHM', process.execPath, __filename],
    {
      cwd: repository,
      env: { ...process.env, LIFE_NAVIGATION_FIXTURE_XVFB: '1' },
      stdio: 'inherit',
    },
  )
  process.exit(child.status ?? 1)
}
for (const signal of ['SIGINT', 'SIGTERM'])
  process.once(signal, () => {
    signalFailure ||= new Error(`Renderer navigation fixture interrupted by ${signal}`)
  })

async function waitUntil(predicate, description, timeout = 25000) {
  const deadline = Date.now() + timeout
  while (Date.now() < deadline) {
    if (signalFailure) throw signalFailure
    if (await predicate()) return
    await new Promise((done) => setTimeout(done, 40))
  }
  throw new Error(`Timed out waiting for ${description}`)
}

async function productionManifest(root) {
  const entries = []
  const visit = async (directory) => {
    for (const entry of (await readdir(directory, { withFileTypes: true })).sort((left, right) =>
      left.name.localeCompare(right.name),
    )) {
      const path = join(directory, entry.name)
      if (entry.isDirectory()) await visit(path)
      else if (entry.isFile())
        entries.push({ path: relative(root, path), sha256: hash(await readFile(path)) })
    }
  }
  await visit(join(root, 'src'))
  await visit(join(root, 'out'))
  for (const name of ['package.json', 'electron.vite.config.ts', 'scripts/vite-renderer-reload.ts'])
    if (existsSync(join(root, name)))
      entries.push({ path: name, sha256: hash(await readFile(join(root, name))) })
  entries.sort((left, right) => left.path.localeCompare(right.path))
  return { root, sha256: hash(JSON.stringify(entries)), fileCount: entries.length, entries }
}

async function unusedLoopbackPort() {
  const listener = createTCPServer()
  await new Promise((done, reject) => {
    listener.once('error', reject)
    listener.listen(0, '127.0.0.1', done)
  })
  const port = listener.address().port
  await new Promise((done, reject) => listener.close((error) => (error ? reject(error) : done())))
  return port
}

async function run() {
  for (const root of new Set([repository, appRoot])) {
    assert.ok(existsSync(join(root, 'out/main/index.js')), `Build ${root} before running`)
    assert.ok(existsSync(join(root, 'out/preload/index.js')), `Build ${root} before running`)
  }
  await mkdir(artifacts, { recursive: true })
  const directory = await mkdtemp(join(tmpdir(), 'life-renderer-navigation-'))
  const configurationRoot = join(directory, 'configuration')
  await mkdir(configurationRoot)
  await seedPrivateSSHSelection(configurationRoot)
  const proof = {
    ok: false,
    fixtureOnly: true,
    authenticatedUpstream: false,
    paidInferenceRequested: false,
    rendererSourceRoot: repository,
    nativeAppRoot: appRoot,
    historyComparisonExcludedFields: ['gitObservedAt', 'nativeRecoveryStatus'],
    executionConditions: {
      quietHostGuaranteed: false,
      concurrentIsolatedFunctionalGatesPermitted: true,
      ipcSamplesAreDescriptive: true,
    },
    cases: [],
    rendererErrors: [],
    console: [],
    webSockets: [],
    nativeLogs: [],
    cleanup: [],
  }
  let phase = 'freeze production source and native build'
  const progress = setInterval(() => console.log(`Renderer navigation fixture: ${phase}`), 30000)
  let server
  let foreignServer
  let fixture
  let application
  let page
  let userData
  let failure
  let baseline
  let thread
  let input
  let port
  let viteGeneration = 0
  let viteConfiguration
  let modulesRoot
  const expectedPrompts = []
  const prompt = '  Native navigation fixture\n\tKeep café e\u0301 漢字 🧪 exactly.  '
  let draft = '  Unsent native navigation draft\n\tKeep café e\u0301 漢字 🧪 exactly.  '
  const composer = () =>
    page.getByRole('textbox', { name: 'Message your coding agent', exact: true })
  const stopButton = () =>
    page.getByRole('button', { name: 'Stop agent and pause queued messages', exact: true })
  const fillComposer = async (value) => {
    const field = composer()
    assert.ok(await field.isVisible(), 'The actual composer is visible')
    assert.ok(await field.isEditable(), 'The actual composer is editable')
    // See clickControl: Electron intentionally blocks navigation commits that
    // Playwright may continue treating as provisional navigation. Force here
    // skips only those prechecks; the actual textarea receives the input event.
    await field.fill(value, { force: true })
    assert.equal(await field.inputValue(), value, 'Exact composer input reaches the native UI')
  }
  const clickControl = async (button, label) => {
    assert.ok(await button.isVisible(), `The actual ${label} control is visible`)
    assert.ok(await button.isEnabled(), `The actual ${label} control is enabled`)
    const bounds = await page.evaluate(async (label) => {
      // Composer autosizing runs after React's input update. Let both the
      // layout effect and a compositor frame settle before locating the hit.
      await new Promise((done) => requestAnimationFrame(() => requestAnimationFrame(done)))
      const name = label === 'Stop' ? 'Stop agent and pause queued messages' : 'Send message'
      const matches = [...document.querySelectorAll('button')].filter(
        (button) => button.getAttribute('aria-label') === name,
      )
      if (matches.length !== 1) throw new Error(`Expected one actual ${name} button`)
      const { x, y, width, height } = matches[0].getBoundingClientRect()
      const hit = document.elementFromPoint(x + width / 2, y + height / 2)?.closest('button')
      if (hit !== matches[0]) throw new Error(`Actual pointer hit does not target ${name}`)
      return { x, y, width, height, name }
    }, label)
    assert.ok(bounds?.width > 0 && bounds.height > 0)
    // Electron prevents these navigation attempts before commit. Playwright's
    // locator action prechecks can still wait on the canceled provisional
    // navigation; real pointer input proves the existing UI remains operable.
    const clickStart = await page.evaluate(() => window.__lifeNavigationFixtureClicks.length)
    await page.mouse.click(bounds.x + bounds.width / 2, bounds.y + bounds.height / 2)
    const delivered = await page
      .evaluate((start) => window.__lifeNavigationFixtureClicks?.slice(start).at(-1), clickStart)
      .catch(() => undefined)
    if (label === 'Send') {
      assert.equal(delivered?.name, bounds.name, 'Trusted pointer input reaches the actual Send UI')
      assert.equal(delivered?.isTrusted, true, 'Send is a real browser pointer event')
    }
    const feedback = await page
      .evaluate(async () => {
        await new Promise((done) => requestAnimationFrame(() => requestAnimationFrame(done)))
        return {
          toasts: [...document.querySelectorAll('.toast[role="status"]')].map(
            (element) => element.textContent,
          ),
          composerValue: document.querySelector('[aria-label="Message your coding agent"]')?.value,
        }
      })
      .catch(() => undefined)
    proof.pointerInputs ||= []
    proof.pointerInputs.push({ phase, ...bounds, delivered, feedback, at: Date.now() })
  }
  const startVite = async () => {
    const { createServer } = await import('vite')
    server = await createServer({
      ...viteConfiguration,
      configFile: false,
      root: resolve(repository, viteConfiguration.root || 'src/renderer'),
      cacheDir: join(directory, 'vite-cache'),
      server: {
        ...viteConfiguration.server,
        host: '127.0.0.1',
        port,
        strictPort: true,
        open: false,
        fs: {
          ...viteConfiguration.server?.fs,
          allow: [...(viteConfiguration.server?.fs?.allow || []), repository, modulesRoot],
        },
      },
    })
    await server.listen()
    assert.equal(server.httpServer.address().port, port, 'Vite binds the same private port')
    proof.vite ||= []
    proof.vite.push({ action: 'started', generation: ++viteGeneration, at: Date.now(), port })
    const response = await fetch(`${proof.rendererURL}/@vite/client`, {
      signal: AbortSignal.timeout(10000),
    })
    assert.equal(response.status, 200, 'Actual served Vite client is available')
    const served = await response.text()
    const counts = viteLatchCounts(served)
    assert.deepEqual(
      counts,
      { beforeunload: 0, pagehide: 1 },
      'Served dev client retires on pagehide only',
    )
    await writeFile(join(artifacts, `served-vite-client-${viteGeneration}.mjs`), served)
    proof.viteClient.served.push({
      generation: viteGeneration,
      url: response.url,
      sha256: hash(served),
      latchCounts: counts,
    })
  }
  const stopVite = async () => {
    await server.close()
    server = undefined
    proof.vite.push({ action: 'closed', generation: viteGeneration, at: Date.now(), port })
  }
  const nativeState = () =>
    application.evaluate(({ BrowserWindow }) => {
      const window = BrowserWindow.getAllWindows()[0]
      return {
        pid: process.pid,
        windowId: window.id,
        rendererPid: window.webContents.getOSProcessId(),
        url: window.webContents.getURL(),
        events: globalThis.__lifeNavigationProof.events,
        windows: globalThis.__lifeNavigationProof.windows,
      }
    })
  const documentState = () =>
    page.evaluate(() => ({
      documentId: window.__lifeNavigationFixtureDocument,
      activeThread: localStorage.getItem('life.active-thread.v1'),
      draftStorage: localStorage.getItem('life.conversation-drafts.v1'),
      agentEvents: window.__lifeNavigationFixtureEvents,
      lifecycle: window.__lifeNavigationFixtureLifecycle,
      clickEvents: window.__lifeNavigationFixtureClicks,
      visibilityState: document.visibilityState,
    }))
  const unsafeIPC = () =>
    page.evaluate(async () => {
      await window.relay.extensions.invoke('window.configure', {})
      return { ok: true, connection: await window.relay.connection.state() }
    })
  const sampleIPC = () =>
    page.evaluate(async () => {
      const samplesMs = []
      for (let index = 0; index < 12; index++) {
        const start = performance.now()
        await window.relay.extensions.invoke('window.configure', {})
        samplesMs.push(performance.now() - start)
      }
      const sorted = [...samplesMs].sort((left, right) => left - right)
      return {
        method: 'window.configure',
        samplesMs,
        medianMs: (sorted[5] + sorted[6]) / 2,
        minMs: sorted[0],
        maxMs: sorted[11],
      }
    })
  const flush = () =>
    page.evaluate(async () => {
      await window.__lifeFlushConversationHistory?.()
    })
  const savedThread = async () =>
    (await readSavedThreads(page)).find((entry) => entry.id === thread.id)
  const identity = (value) => ({
    id: value.id,
    provider: value.provider,
    remoteId: value.remoteId,
    profileId: value.profileId,
    workspace: value.workspace,
  })
  // Fresh App documents observe the same workspace Git context again. Compare
  // persisted history fields except the Git observation timestamp and live
  // recovery-control status, which is separately checked after idle recovery.
  // Keep complete original snapshots in the proof for independent review.
  const stableHistory = (history) =>
    history.map(
      ({ gitObservedAt: _observedAt, nativeRecoveryStatus: _recoveryStatus, ...retained }) =>
        retained,
    )
  const mainCommits = (state) =>
    state.events.filter((event) => event.type === 'did-frame-navigate' && event.isMainFrame)
  const mainAttempts = (state) =>
    state.events.filter(
      (event) =>
        event.isMainFrame &&
        ['will-navigate', 'will-frame-navigate', 'did-start-navigation'].includes(event.type),
    )
  const attachDocumentObserver = async () => {
    await page.evaluate(() => {
      window.__lifeNavigationFixtureDocument ||= crypto.randomUUID()
      window.__lifeNavigationFixtureEvents ||= []
      window.__lifeNavigationFixtureLifecycle ||= []
      window.__lifeNavigationFixtureClicks ||= []
      if (!window.__lifeNavigationFixtureUIObserver) {
        window.__lifeNavigationFixtureUIObserver = true
        for (const type of ['beforeunload', 'pagehide', 'unload'])
          window.addEventListener(type, (event) => {
            window.__lifeNavigationFixtureLifecycle.push({
              type,
              at: Date.now(),
              persisted: event.persisted,
              url: location.href,
            })
          })
        document.addEventListener(
          'click',
          (event) => {
            const button = event.target instanceof Element ? event.target.closest('button') : null
            window.__lifeNavigationFixtureClicks.push({
              name: button?.getAttribute('aria-label'),
              isTrusted: event.isTrusted,
              at: Date.now(),
              x: event.clientX,
              y: event.clientY,
            })
          },
          { capture: true },
        )
      }
      if (window.__lifeNavigationFixtureUnsubscribe) return
      window.__lifeNavigationFixtureUnsubscribe = window.relay.onAgent((event) => {
        window.__lifeNavigationFixtureEvents.push(event)
        if (window.__lifeNavigationFixtureEvents.length > 200)
          window.__lifeNavigationFixtureEvents.shift()
      })
    })
  }
  const workspace = async () => {
    if (await composer().isVisible()) return
    const state = await page.evaluate(() => window.relay.customization.get())
    const navigation = page.getByRole('navigation', { name: 'Workspace views', exact: true })
    const modern = navigation.getByRole('button', { name: 'Agents', exact: true })
    const legacy = navigation.getByRole('button', {
      name: state.config.labels.workspaceTitle,
      exact: true,
    })
    await ((await modern.count()) ? modern : legacy).click()
    await composer().waitFor()
  }
  const readyDocument = async (before, label) => {
    await waitUntil(
      async () => mainCommits(await nativeState()).length > mainCommits(before.native).length,
      `${label}: actual native main-frame document commit`,
    )
    await page.locator('.app-shell').waitFor()
    await workspace()
    await attachDocumentObserver()
    assert.notEqual(
      (await documentState()).documentId,
      before.document.documentId,
      `${label}: a fresh document instance mounts`,
    )
    assert.equal(await page.locator('vite-error-overlay').count(), 0)
  }
  const capture = async () => ({
    native: await nativeState(),
    document: await documentState(),
    history: await readSavedThreads(page),
    providerLogLength: (await fixture.log()).length,
    at: Date.now(),
  })
  const assertPreserved = async (label, options = {}) => {
    const current = await nativeState()
    assert.equal(current.pid, baseline.pid, `${label}: native application PID remains stable`)
    assert.equal(current.windowId, baseline.windowId, `${label}: original native window remains`)
    assert.deepEqual(current.windows, baseline.windows, `${label}: no replacement native window`)
    assert.equal(new URL(page.url()).origin, proof.rendererURL)
    const ipc = await unsafeIPC()
    assert.equal(ipc.connection.status, 'connected', `${label}: unsafe native IPC is admitted`)
    assert.equal(ipc.connection.profile.id, thread.profileId)
    assert.equal(ipc.connection.workspace, thread.workspace)
    await flush()
    const stored = await savedThread()
    assert.deepEqual(
      identity(stored),
      identity(thread),
      `${label}: native session ownership remains`,
    )
    for (const expected of new Set(expectedPrompts))
      assert.equal(
        stored.messages.filter((message) => message.role === 'user' && message.text === expected)
          .length,
        expectedPrompts.filter((prompt) => prompt === expected).length,
        `${label}: every exact submitted prompt occurrence remains in native history`,
      )
    if (options.busy !== undefined) assert.equal(stored.busy, options.busy, `${label}: turn state`)
    const sendControl = page.getByRole('button', { name: 'Send message', exact: true })
    const uiState = {
      stopVisible: await stopButton().isVisible(),
      sendVisible: await sendControl.isVisible(),
    }
    uiState.sendEnabled = uiState.sendVisible && (await sendControl.isEnabled())
    if (options.uiIdle) {
      assert.equal(uiState.stopVisible, false, `${label}: fresh interface has no old active run`)
      assert.equal(
        uiState.sendEnabled,
        true,
        `${label}: fresh interface permits a real continuation`,
      )
    }
    assert.equal(await composer().inputValue(), draft, `${label}: exact unsent draft is visible`)
    const document = await documentState()
    assert.equal(document.activeThread, thread.id)
    assert.ok(document.draftStorage?.includes(JSON.stringify(draft).slice(1, -1)))
    const bytes = await readFile(join(userData, 'conversations.json'))
    const disk = JSON.parse(bytes.toString('utf8'))
    assert.ok(JSON.stringify(disk).includes(JSON.stringify(prompt).slice(1, -1)))
    return { native: current, document, thread: stored, diskSha256: hash(bytes), ipc, uiState }
  }
  const setDraft = async (value) => {
    draft = value
    await fillComposer(value)
    await waitUntil(
      () =>
        page.evaluate(
          (expected) =>
            Object.values(
              JSON.parse(localStorage.getItem('life.conversation-drafts.v1') || '{}'),
            ).some((value) => value?.draft === expected || value === expected),
          value,
        ),
      'exact unsent draft persisted in the real draft store',
    )
  }
  const send = async (value) => {
    await fillComposer(value)
    await clickControl(page.getByRole('button', { name: 'Send message', exact: true }), 'Send')
    expectedPrompts.push(value)
  }
  const completedContinuation = async (value, label) => {
    const start = (await fixture.log()).length
    await send(value)
    await waitUntil(async () => {
      const current = await savedThread()
      const user = current?.messages.find(
        (message) => message.role === 'user' && message.text === value,
      )
      const log = (await fixture.log()).slice(start)
      const turns = log.filter(
        (entry) =>
          entry.message?.method === 'turn/start' && entry.message.params.input[0].text === value,
      )
      return (
        current?.busy === false &&
        current.turnStatus === 'completed' &&
        user &&
        !current.messages.some(
          (message) => message.role === 'error' && message.turn === user.turn,
        ) &&
        current.messages.some(
          (message) =>
            message.role === 'assistant' &&
            message.turn === user.turn &&
            message.text === 'Hello from Codex 👋' &&
            message.finishStatus === 'completed',
        ) &&
        turns.length === 1 &&
        turns[0].message.params.threadId === thread.remoteId &&
        log.some(
          (entry) =>
            entry.kind === 'turn-completed' &&
            entry.completionEvidence?.threadId === thread.remoteId &&
            entry.completionEvidence?.prompt === value,
        )
      )
    }, `${label}: exactly one real continuation completes on the existing upstream thread`)
    const accepted = (await fixture.log())
      .slice(start)
      .filter(
        (entry) =>
          entry.message?.method === 'turn/start' && entry.message.params.input[0].text === value,
      )
    assert.equal(accepted.length, 1, `${label}: exactly one accepted native continuation`)
    assert.equal(accepted[0].message.params.threadId, thread.remoteId)
    return { prompt: value, upstreamThreadId: thread.remoteId, acceptedTurnCount: accepted.length }
  }
  const startHang = async (label) => {
    const start = (await fixture.log()).length
    const eventStart = (await documentState()).agentEvents.length
    let nativeTurn
    await send('hang')
    await waitUntil(() => stopButton().isVisible(), 'Actual Stop control appears for the new turn')
    await waitUntil(async () => {
      await flush()
      const value = await savedThread()
      nativeTurn = (await fixture.log())
        .slice(start)
        .find((entry) => entry.kind === 'turn-started' && entry.prompt === 'hang')
      return (
        value?.busy &&
        value.remoteId === thread.remoteId &&
        nativeTurn?.threadId === thread.remoteId &&
        value.messages.some(
          (message) =>
            message.role === 'assistant' &&
            message.turn === value.turn &&
            message.text === 'Hello from Codex 👋',
        )
      )
    }, `${label}: actual native hang turn and both initial deltas persist before navigation`)
    await setDraft(`  ${label} unsent draft\n\tKeep café e\u0301 漢字 🧪 exactly.  `)
    await waitUntil(
      async () =>
        (await documentState()).agentEvents
          .slice(eventStart)
          .some(
            (event) =>
              event.sessionId === thread.id &&
              event.type === 'text' &&
              event.text === 'Hello ' &&
              event.itemId === nativeTurn.turnId.replace(/^turn-/, 'message-'),
          ),
      `${label}: this native turn's exact delta reaches the current renderer receiver`,
    )
  }
  const clickStop = async () => {
    await clickControl(stopButton(), 'Stop')
  }
  const stopHang = async (label) => {
    await clickStop()
    await waitUntil(
      async () => (await savedThread())?.busy === false,
      `${label}: the actual Stop control settles the native conversation`,
    )
  }
  const record = async (name, before, result) => {
    await page.screenshot({ path: join(artifacts, `${name}.png`) })
    proof.cases.push({ name, ok: true, before, after: result, elapsedMs: Date.now() - before.at })
    await writeFile(join(artifacts, 'proof.json'), JSON.stringify(proof, null, 2) + '\n')
  }
  try {
    proof.fixtureSourceSha256 = hash(await readFile(__filename))
    const installedViteClientPath = await realpath(
      join(dirname(require.resolve('vite/package.json')), 'dist/client/client.mjs'),
    )
    const installedViteClient = await readFile(installedViteClientPath)
    proof.viteClient = {
      installedPath: installedViteClientPath,
      installedSha256Before: hash(installedViteClient),
      installedByteLength: installedViteClient.length,
      installedLatchCounts: viteLatchCounts(installedViteClient.toString('utf8')),
      served: [],
    }
    assert.deepEqual(proof.viteClient.installedLatchCounts, { beforeunload: 1, pagehide: 0 })
    await writeFile(join(artifacts, 'installed-vite-client.mjs'), installedViteClient)
    proof.productionBefore = await Promise.all(
      [...new Set([repository, appRoot])].map(productionManifest),
    )
    await writeFile(
      join(artifacts, 'source-before.json'),
      JSON.stringify(proof.productionBefore, null, 2) + '\n',
    )
    const { resolveConfig } = await import('electron-vite')
    const configured = await resolveConfig(
      { root: repository, configFile: join(repository, 'electron.vite.config.ts') },
      'serve',
      'development',
    )
    assert.ok(configured.config?.renderer)
    viteConfiguration = configured.config.renderer
    modulesRoot = await realpath(join(repository, 'node_modules'))
    port = await unusedLoopbackPort()
    proof.rendererURL = `http://127.0.0.1:${port}`
    phase = 'start isolated actual Vite and loopback SSH fixture'
    await startVite()
    const bundledFixture = join(artifacts, 'renderer-navigation-ssh-fixture.cjs')
    await build({
      entryPoints: [join(repository, 'tests/helpers/ssh-fixture.ts')],
      outfile: bundledFixture,
      bundle: true,
      platform: 'node',
      format: 'cjs',
      packages: 'external',
      logLevel: 'silent',
    })
    const { SSHFixture } = require(bundledFixture)
    fixture = await new SSHFixture(join(repository, 'tests/fixtures/fake-provider.cjs')).start()
    fixture.discoveryPorts = []
    input = fixture.input()
    const foreignRequests = []
    foreignServer = createHTTPServer((request, response) => {
      foreignRequests.push({ url: request.url, at: Date.now() })
      response.writeHead(200, { 'Content-Type': 'text/html' })
      response.end('<!doctype html><title>Foreign fixture document</title>Foreign fixture')
    })
    await new Promise((done, reject) => {
      foreignServer.once('error', reject)
      foreignServer.listen(0, '127.0.0.1', done)
    })
    proof.foreignURL = `http://127.0.0.1:${foreignServer.address().port}/foreign-document`
    phase = 'launch actual native Electron with its private profile'
    application = await electron.launch({
      executablePath: require('electron'),
      args: [
        appRoot,
        '--no-sandbox',
        '--disable-dev-shm-usage',
        `--user-data-dir=${join(configurationRoot, 'chromium')}`,
      ],
      cwd: appRoot,
      env: {
        ...process.env,
        ELECTRON_RENDERER_URL: proof.rendererURL,
        XDG_CONFIG_HOME: configurationRoot,
      },
      timeout: 30000,
    })
    proof.nativeLaunchPid = application.process().pid
    for (const [stream, output] of [
      ['stdout', application.process().stdout],
      ['stderr', application.process().stderr],
    ])
      output?.on('data', (bytes) => {
        proof.nativeLogs.push({ stream, text: String(bytes).slice(-16000) })
        while (proof.nativeLogs.reduce((length, entry) => length + entry.text.length, 0) > 96000)
          proof.nativeLogs.shift()
      })
    await application.evaluate(({ app, BrowserWindow }) => {
      const proof = { events: [], windows: [], phase: 'initial native document' }
      globalThis.__lifeNavigationProof = proof
      const scalar = (value) =>
        ['string', 'number', 'boolean'].includes(typeof value) || value === null ? value : undefined
      const frame = (value) => {
        if (value === null) return null
        if (!value) return undefined
        const result = {}
        for (const name of [
          'url',
          'name',
          'processId',
          'routingId',
          'osProcessId',
          'frameTreeNodeId',
        ])
          try {
            const entry = scalar(value[name])
            if (entry !== undefined) result[name] = entry
          } catch {
            result[name + 'Unavailable'] = true
          }
        return result
      }
      const observe = (window) => {
        proof.windows.push(window.id)
        for (const type of [
          'did-start-navigation',
          'will-navigate',
          'will-frame-navigate',
          'did-frame-navigate',
          'did-navigate',
          'did-finish-load',
          'did-fail-load',
          'render-process-gone',
        ])
          window.webContents.on(type, (...args) => {
            const details = args[0]
            const committed = type === 'did-frame-navigate'
            const navigationEvent = [
              'did-start-navigation',
              'will-navigate',
              'will-frame-navigate',
              'did-frame-navigate',
              'did-navigate',
            ].includes(type)
            const positionalMainIndex = committed || type === 'did-fail-load' ? 4 : 3
            const entry = {
              type,
              phase: proof.phase,
              at: Date.now(),
              windowId: window.id,
              modernDetails: typeof details?.url === 'string',
              url:
                details?.url ??
                (type === 'did-fail-load' ? args[3] : navigationEvent ? args[1] : undefined),
              isMainFrame:
                details?.isMainFrame ??
                (type === 'did-navigate'
                  ? true
                  : navigationEvent || type === 'did-fail-load'
                    ? args[positionalMainIndex]
                    : undefined),
              isSameDocument:
                details?.isSameDocument ??
                (committed || type === 'did-navigate'
                  ? false
                  : navigationEvent
                    ? args[2]
                    : undefined),
              frame: frame(details?.frame),
              initiator: frame(details?.initiator),
              frameProcessId: committed ? args[5] : args[4],
              frameRoutingId: committed ? args[6] : args[5],
              positionalArgumentTypes: args.slice(1).map((value) => typeof value),
              prevented: details?.defaultPrevented,
            }
            if (type === 'did-fail-load') {
              entry.errorCode = args[1]
              entry.errorDescription = args[2]
            }
            if (type === 'render-process-gone') {
              entry.reason = args[1]?.reason
              entry.exitCode = args[1]?.exitCode
            }
            proof.events.push(entry)
          })
      }
      for (const window of BrowserWindow.getAllWindows()) {
        observe(window)
        window.setBounds({ width: 1920, height: 1080 })
      }
      app.on('browser-window-created', (_event, window) => observe(window))
    })
    page = await application.firstWindow()
    page.setDefaultTimeout(25000)
    page.on('pageerror', (error) => proof.rendererErrors.push({ phase, message: error.message }))
    page.on('console', (message) => {
      if (message.type() === 'error' || message.text().includes('[vite]'))
        proof.console.push({ phase, type: message.type(), text: message.text(), at: Date.now() })
    })
    page.on('websocket', (socket) => {
      const record = { url: socket.url(), phase, openedAt: Date.now(), received: [] }
      proof.webSockets.push(record)
      socket.on('framereceived', ({ payload }) =>
        record.received.push(String(payload).slice(0, 500)),
      )
      socket.on('close', () => {
        record.closedAt = Date.now()
      })
    })
    await page.addInitScript(() => {
      window.__lifeNavigationFixtureDocument = crypto.randomUUID()
      window.__lifeNavigationFixtureEvents = []
    })
    userData = await application.evaluate(({ app }) => app.getPath('userData'))
    assert.ok(userData.startsWith(configurationRoot), `Private native profile: ${userData}`)
    proof.userData = userData
    await page.locator('.app-shell').waitFor()
    await attachDocumentObserver()
    assert.equal(new URL(page.url()).origin, proof.rendererURL)
    proof.preferences = await application.evaluate(({ BrowserWindow }) =>
      BrowserWindow.getAllWindows()[0].webContents.getLastWebPreferences(),
    )
    assert.equal(proof.preferences.contextIsolation, true)
    assert.equal(proof.preferences.nodeIntegration, false)
    assert.equal(proof.preferences.sandbox, true)
    proof.initialConnection = await page.evaluate(() => window.relay.connection.state())
    assert.equal(proof.initialConnection.status, 'disconnected')
    assert.notEqual(proof.initialConnection.profile?.transport, 'local')
    phase = 'connect actual SSH fixture and persist an exact native turn'
    await page.getByRole('button', { name: 'Connections', exact: true }).click()
    const connection = page.getByRole('dialog', { name: 'Choose an environment', exact: true })
    await connection.waitFor()
    const addSSH = connection.getByRole('button', { name: 'Add SSH machine', exact: true })
    if (await addSSH.isVisible()) await addSSH.click()
    await connection.getByPlaceholder('My development server').fill(input.name)
    await connection.getByPlaceholder('dev.example.com').fill(input.host)
    await connection.getByLabel('Port', { exact: true }).fill(String(input.port))
    await connection.getByPlaceholder('developer').fill(input.username)
    await connection.getByLabel('Authentication').selectOption('password')
    await connection.getByPlaceholder('Your SSH password').fill(input.password)
    await connection.getByRole('button', { name: 'Connect machine', exact: true }).click()
    const trust = page.getByRole('dialog', { name: 'Trust this machine?', exact: true })
    await trust.getByRole('button', { name: 'Trust and connect', exact: true }).click()
    await connection.waitFor({ state: 'hidden' })
    const picker = page.getByRole('dialog', { name: 'Select a project', exact: true })
    await picker
      .getByRole('textbox', { name: 'Project directory', exact: true })
      .fill(input.workspace)
    await picker.getByRole('button', { name: 'Open project', exact: true }).click()
    await picker.waitFor({ state: 'hidden' })
    await send(prompt)
    await waitUntil(async () => {
      const history = await readSavedThreads(page)
      thread = history.find((entry) =>
        entry.messages.some((message) => message.role === 'user' && message.text === prompt),
      )
      return (
        thread?.remoteId &&
        !thread.busy &&
        thread.title === 'Provider-generated workspace title' &&
        thread.messages.some((message) => message.role === 'assistant')
      )
    }, 'completed fixture turn with native provider identity and exact prompt')
    assert.equal(thread.workspace, input.workspace)
    assert.ok(thread.profileId)
    const initialTurns = (await fixture.log()).filter(
      (entry) => entry.kind !== 'title-metadata' && entry.message?.method === 'turn/start',
    )
    assert.equal(initialTurns.length, 1, 'Exactly one ordinary initial provider turn')
    assert.equal(
      initialTurns[0].message.params.input.find((item) => item.type === 'text').text,
      prompt,
    )
    await setDraft(draft)
    await flush()
    baseline = await nativeState()
    proof.baseline = baseline
    proof.identity = identity(thread)
    proof.initial = await assertPreserved('initial native fixture', { busy: false })
    proof.ipcTiming = { before: await sampleIPC() }

    for (const name of caseNames.filter((name) => selectedCases.has(name))) {
      phase = name
      await application.evaluate((_, name) => {
        globalThis.__lifeNavigationProof.phase = name
      }, name)
      let before
      try {
        if (name === 'idle-reload' || name === 'idle-vite-restart') {
          before = await capture()
          if (name === 'idle-reload')
            await page.evaluate(() => {
              location.reload()
            })
          else {
            await stopVite()
            await startVite()
          }
          await readyDocument(before, name)
          const after = await assertPreserved(name, { busy: false })
          assert.deepEqual(after.document.draftStorage, before.document.draftStorage)
          const recoveredHistory = await readSavedThreads(page)
          assert.equal(
            recoveredHistory.find((entry) => entry.id === thread.id)?.nativeRecoveryStatus,
            'idle',
          )
          assert.deepEqual(stableHistory(recoveredHistory), stableHistory(before.history))
          await record(name, before, after)
        } else if (name === 'foreign-busy') {
          await startHang(name)
          before = await capture()
          await page.evaluate((url) => {
            location.href = url
          }, proof.foreignURL)
          await waitUntil(
            async () =>
              mainAttempts(await nativeState()).some(
                (event) => event.url === proof.foreignURL && event.at >= before.at,
              ),
            'actual foreign renderer navigation attempt reaches native admission',
          )
          const after = await assertPreserved(name, { busy: true })
          assert.equal(after.document.documentId, before.document.documentId)
          assert.equal(mainCommits(after.native).length, mainCommits(before.native).length)
          assert.deepEqual(
            stableHistory(await readSavedThreads(page)),
            stableHistory(before.history),
          )
          assert.equal(foreignRequests.length, 0, 'Blocked foreign document is never requested')
          assert.ok(await stopButton().isEnabled(), 'Live native stop control remains usable')
          assert.equal(
            (await fixture.log())
              .slice(before.providerLogLength)
              .some((entry) => entry.message?.method === 'turn/interrupt'),
            false,
            'Rejected foreign navigation does not interrupt the real provider session',
          )
          await page.screenshot({ path: join(artifacts, 'foreign-busy-blocked.png') })
          await stopHang(name)
          const afterStop = await assertPreserved(`${name}: Stop`, { busy: false })
          assert.equal(afterStop.document.documentId, before.document.documentId)
          const retainedDraft = draft
          const continuation = await completedContinuation(
            '  Foreign navigation follow-up\n\tKeep café e\u0301 漢字 🧪 exactly.  ',
            `${name}: Stop then Send`,
          )
          await setDraft(retainedDraft)
          const afterFollowup = await assertPreserved(`${name}: Stop then Send`, { busy: false })
          assert.equal(afterFollowup.document.documentId, before.document.documentId)
          assert.equal(mainCommits(afterFollowup.native).length, mainCommits(before.native).length)
          await record(name, before, {
            ...after,
            foreignRequests,
            afterStop,
            continuation,
            afterFollowup,
          })
        } else if (name === 'busy-vite-restart') {
          await startHang(name)
          before = await capture()
          await stopVite()
          await startVite()
          await waitUntil(
            async () =>
              mainAttempts(await nativeState()).length > mainAttempts(before.native).length,
            'actual Vite reconnect attempts its same-URL full renderer reload',
          )
          const deferred = await assertPreserved(`${name}: deferred`, { busy: true })
          assert.equal(deferred.document.documentId, before.document.documentId)
          assert.equal(mainCommits(deferred.native).length, mainCommits(before.native).length)
          assert.deepEqual(
            stableHistory(await readSavedThreads(page)),
            stableHistory(before.history),
          )
          assert.ok(await stopButton().isEnabled(), 'Deferred Vite reload leaves Stop usable')
          assert.equal(
            (await fixture.log())
              .slice(before.providerLogLength)
              .some((entry) => entry.message?.method === 'turn/interrupt'),
            false,
            'Vite restart does not cancel the active native provider turn',
          )
          // Clicking the production Stop button, rather than calling a native
          // stub, is what makes the main-owned deferred reload eligible.
          await clickStop()
          await readyDocument(before, name)
          const after = await assertPreserved(name, { busy: false })
          assert.equal(after.document.draftStorage, before.document.draftStorage)
          await record(name, before, { deferred, after })
        } else if (name === 'native-busy-reload') {
          await startHang(name)
          before = await capture()
          await application.evaluate(({ BrowserWindow }) => {
            BrowserWindow.getAllWindows()[0].webContents.reload()
          })
          await readyDocument(before, name)
          await waitUntil(
            async () =>
              !(await stopButton().isVisible()) &&
              (await page.getByRole('button', { name: 'Send message', exact: true }).isEnabled()),
            'intentional native reload invalidates old live UI ownership and permits continuation',
          )
          // Lossless recovery keeps the previous raw busy marker archived until
          // a real owned turn changes it. Check actual live UI admission here;
          // the subsequent completed turn must durably settle busy=false.
          const afterReload = await assertPreserved(`${name}: fresh document`, { uiIdle: true })
          assert.equal(afterReload.document.draftStorage, before.document.draftStorage)
          const continuation = '  Native reload follow-up\n\tKeep café e\u0301 漢字 🧪 exactly.  '
          const continuationProof = await completedContinuation(continuation, name)
          await setDraft(draft)
          const afterFollowup = await assertPreserved(`${name}: follow-up`, { busy: false })
          assert.ok(
            (await fixture.log())
              .slice(before.providerLogLength)
              .some(
                (entry) =>
                  entry.message?.method === 'thread/resume' &&
                  entry.message.params.threadId === thread.remoteId,
              ),
            'Fresh native ownership resumes the existing upstream provider thread',
          )
          assert.equal(
            await page
              .locator('.chat-error')
              .filter({ hasText: /already running/i })
              .count(),
            0,
          )
          await record(name, before, {
            afterReload,
            continuation: continuationProof,
            afterFollowup,
          })
        }
      } catch (error) {
        proof.cases.push({
          name,
          ok: false,
          before,
          failure: { message: String(error), stack: error.stack },
        })
        throw error
      }
    }
    proof.final = await assertPreserved('final navigation fixture', { busy: false })
    proof.ipcTiming.after = await sampleIPC()
    proof.providerLog = await fixture.log()
    assert.deepEqual(proof.rendererErrors, [], 'No unexpected renderer exceptions')
    assert.equal(
      proof.final.native.events.some((event) => event.type === 'render-process-gone'),
      false,
      'No native renderer crash or unexpected process death',
    )
    assert.ok(
      proof.final.native.events.some(
        (event) =>
          event.modernDetails &&
          typeof event.isMainFrame === 'boolean' &&
          (event.frame || event.initiator),
      ),
      'Proof records the actual modern Electron navigation/frame details',
    )
    if (signalFailure) throw signalFailure
    proof.ok = true
  } catch (error) {
    failure = error
    proof.failure = { phase, message: String(error), stack: error.stack }
    if (application)
      proof.nativeAtFailure = await nativeState().catch((error) => ({ error: String(error) }))
    if (fixture) proof.providerLog = await fixture.log().catch(() => [])
    if (page) {
      proof.savedHistoryAtFailure = await readSavedThreads(page).catch((error) => ({
        error: String(error),
      }))
      proof.documentAtFailure = await documentState().catch((error) => ({ error: String(error) }))
      await writeFile(join(artifacts, 'failure.html'), await page.content().catch(() => ''))
      await page.screenshot({ path: join(artifacts, 'failure.png') }).catch(() => {})
    }
  } finally {
    phase = 'await owned native, Vite, SSH and private profile cleanup'
    clearInterval(progress)
    for (const [label, close] of [
      ['electron', () => application?.close()],
      ['vite', () => server?.close()],
      [
        'foreign HTTP fixture',
        () =>
          foreignServer?.listening
            ? new Promise((done, reject) =>
                foreignServer.close((error) => (error ? reject(error) : done())),
              )
            : undefined,
      ],
      ['SSH fixture and owned provider brokers', () => fixture?.close()],
      ['private profile and Vite cache', () => rm(directory, { recursive: true, force: true })],
    ])
      try {
        await close()
        proof.cleanup.push({ label, ok: true })
      } catch (error) {
        failure ||= error
        proof.ok = false
        proof.cleanup.push({ label, ok: false, error: String(error) })
      }
    try {
      if (proof.viteClient) {
        proof.viteClient.installedSha256After = hash(await readFile(proof.viteClient.installedPath))
        assert.equal(
          proof.viteClient.installedSha256After,
          proof.viteClient.installedSha256Before,
          'Installed Vite client disk bytes remain unchanged',
        )
      }
      proof.fixtureSourceAfterSha256 = hash(await readFile(__filename))
      assert.equal(
        proof.fixtureSourceAfterSha256,
        proof.fixtureSourceSha256,
        'Fixture source is frozen',
      )
      proof.productionAfter = await Promise.all(
        [...new Set([repository, appRoot])].map(productionManifest),
      )
      await writeFile(
        join(artifacts, 'source-after.json'),
        JSON.stringify(proof.productionAfter, null, 2) + '\n',
      )
      assert.deepEqual(proof.productionAfter, proof.productionBefore, 'Production graph is frozen')
      proof.productionGraphUnchanged = true
    } catch (error) {
      failure ||= error
      proof.ok = false
      proof.productionGraphUnchanged = false
      proof.graphFailure = String(error)
    }
    await writeFile(join(artifacts, 'proof.json'), JSON.stringify(proof, null, 2) + '\n')
  }
  if (failure) throw failure
  console.log(
    JSON.stringify({
      ok: proof.ok,
      fixtureOnly: true,
      cases: proof.cases.map(({ name, ok, elapsedMs }) => ({ name, ok, elapsedMs })),
      rendererErrors: proof.rendererErrors.length,
      productionGraphUnchanged: proof.productionGraphUnchanged,
      proof: join(artifacts, 'proof.json'),
    }),
  )
}

run().catch((error) => {
  console.error(error)
  process.exitCode = 1
})
