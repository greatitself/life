#!/usr/bin/env node
/*
 * Replace a real ownership module while an actual fixture provider is streaming.
 * Uses production Vite, Electron, native storage, and loopback SSH/SFTP. Only the
 * disposable source/launcher copies are edited; no account or inference is used.
 *
 * After npm run build:
 *   node tests/renderer-ownership-hmr-electron-smoke.cjs
 *   LIFE_TEST_HMR_POLICY=ordinary LIFE_TEST_EXPECT_SOURCE_LOSS=1 node ...
 * LIFE_TEST_APP_ROOT selects another frozen, built application graph. The two
 * policies share that graph; ordinary disables ONLY the ownership-module guard.
 */
const assert = require('node:assert/strict')
const { createHash } = require('node:crypto')
const { existsSync } = require('node:fs')
const {
  cp,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  realpath,
  rename,
  rm,
  symlink,
  writeFile,
} = require('node:fs/promises')
const { tmpdir } = require('node:os')
const { join, relative, resolve } = require('node:path')
const { spawnSync } = require('node:child_process')
const { createServer: createTCPServer } = require('node:net')
const { performance } = require('node:perf_hooks')
const { isDeepStrictEqual } = require('node:util')
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
const policy = process.env.LIFE_TEST_HMR_POLICY || 'guarded'
assert.ok(['ordinary', 'guarded'].includes(policy), 'Choose ordinary or guarded HMR policy')
const artifacts = resolve(
  repository,
  process.env.LIFE_TEST_ARTIFACTS_DIR || `output/playwright/renderer-ownership-hmr-${policy}`,
)
const expectSourceLoss = process.env.LIFE_TEST_EXPECT_SOURCE_LOSS === '1'
assert.ok(!expectSourceLoss || policy === 'ordinary', 'Expected loss belongs only to baseline')
const hash = (bytes) => createHash('sha256').update(bytes).digest('hex')
const jsonHash = (value) => hash(JSON.stringify(value))
const draftKey = 'life.conversation-drafts.v1'
const exactPrompt = '  Ownership HMR fixture\n\tKeep café e\u0301 漢字 🧪 exactly.  '
const exactDraft = '  Unsent during an active native turn\n\tKeep café e\u0301 漢字 🧪 exactly.  '
const title = 'Ownership HMR archive'
let signalFailure

assert.equal(process.platform, 'linux', 'This loopback Bash SSH fixture currently supports Linux')
if (!process.env.DISPLAY) {
  assert.equal(spawnSync('xvfb-run', ['--help'], { stdio: 'ignore' }).status, 0)
  const child = spawnSync(
    'xvfb-run',
    ['-a', '-s', '-screen 0 1920x1080x24', process.execPath, __filename],
    { cwd: repository, env: process.env, stdio: 'inherit' },
  )
  process.exit(child.status ?? 1)
}
for (const signal of ['SIGINT', 'SIGTERM'])
  process.once(signal, () => {
    signalFailure ||= new Error(`Ownership HMR fixture interrupted by ${signal}`)
  })

async function waitUntil(predicate, description, timeout = 25000) {
  const deadline = Date.now() + timeout
  while (Date.now() < deadline) {
    if (signalFailure) throw signalFailure
    if (await predicate()) return
    await new Promise((done) => setTimeout(done, 30))
  }
  throw new Error(`Timed out waiting for ${description}`)
}

async function graph(root) {
  const result = []
  const visit = async (path) => {
    for (const entry of (await readdir(path, { withFileTypes: true })).sort((a, b) =>
      a.name.localeCompare(b.name),
    )) {
      const file = join(path, entry.name)
      if (entry.isDirectory()) await visit(file)
      else if (entry.isFile())
        result.push({ path: relative(root, file), sha256: hash(await readFile(file)) })
    }
  }
  for (const directory of ['src', 'out', 'scripts', 'build']) await visit(join(root, directory))
  for (const file of ['package.json', 'electron.vite.config.ts'])
    result.push({ path: file, sha256: hash(await readFile(join(root, file))) })
  return result
}

// Select exact original archive records, rather than comparing fields that a
// genuine new turn is allowed to change (busy, updatedAt, new assistant output).
function protectedArchive(thread) {
  return {
    id: thread?.id,
    profileId: thread?.profileId,
    provider: thread?.provider,
    remoteId: thread?.remoteId,
    workspace: thread?.workspace,
    futureThreadField: thread?.futureThreadField,
    messages: (thread?.messages || []).filter(
      (message) =>
        message === null ||
        typeof message !== 'object' ||
        Array.isArray(message) ||
        Object.hasOwn(message, 'fixtureArchiveOccurrence'),
    ),
  }
}

function primaryTurns(entries) {
  return entries.filter(
    (entry) => entry.kind !== 'title-metadata' && entry.message?.method === 'turn/start',
  )
}

const moduleMarker = (token) => `
// Disposable fixture observation: deliberately adds NO HMR accept boundary.
globalThis.__lifeOwnershipDocument ||= {
  id: crypto.randomUUID(), timeOrigin: performance.timeOrigin,
};
globalThis.__lifeOwnershipModule = {
  evaluations: (globalThis.__lifeOwnershipModule?.evaluations || 0) + 1,
  token: ${JSON.stringify(token)}, documentId: globalThis.__lifeOwnershipDocument.id,
};
if (import.meta.hot) {
  import.meta.hot.on('vite:beforeUpdate', payload => {
    (globalThis.__lifeOwnershipViteEvents ||= []).push({
      type: 'beforeUpdate', updates: payload.updates.map(update => update.path),
    });
  });
  import.meta.hot.on('vite:beforeFullReload', payload => {
    (globalThis.__lifeOwnershipViteEvents ||= []).push({ type: 'beforeFullReload', path: payload.path });
  });
}
`

async function run() {
  assert.ok(existsSync(join(appRoot, 'out/main/index.js')), 'Run npm run build first')
  assert.ok(existsSync(join(appRoot, 'out/preload/index.js')), 'A built native preload is required')
  await mkdir(artifacts, { recursive: true })
  const directory = await mkdtemp(join(tmpdir(), 'life-ownership-hmr-'))
  const copiedRoot = join(directory, 'app')
  const configurationRoot = join(directory, 'configuration')
  const proof = {
    ok: false,
    fixtureOnly: true,
    authenticatedProviderUse: false,
    policy,
    appRoot,
    source: [],
    checks: [],
    errors: [],
    consoleErrors: [],
    websocket: [],
    clientWebsocket: [],
    trustedStopEvents: [],
    observations: {},
    activeObservationLabels: [],
    timings: {},
  }
  let fixture
  let server
  let application
  let page
  let cdp
  let diskPath
  let threadId
  let protectedSeed
  let failure
  let phase = 'copy frozen application into a disposable graph'
  const progress = setInterval(
    () => console.log(`Ownership HMR fixture (${policy}): ${phase}`),
    30000,
  )
  const files = []
  const check = (message) => {
    proof.checks.push(message)
    console.log(`PASS: ${message}`)
  }
  const replace = async (file, bytes, restoring = false) => {
    if (signalFailure && !restoring) throw signalFailure
    assert.ok(
      (await readFile(file.path)).equals(file.expected),
      `Unexpected concurrent change: ${file.path}`,
    )
    const temporary = `${file.path}.ownership-fixture-${process.pid}.tmp`
    try {
      await writeFile(temporary, bytes)
      assert.ok(
        (await readFile(file.path)).equals(file.expected),
        'Source changed before atomic edit',
      )
      await rename(temporary, file.path)
      file.expected = bytes
    } finally {
      await rm(temporary, { force: true })
    }
  }
  const restore = async () => {
    const errors = []
    for (const file of files) {
      try {
        if (!(await readFile(file.path)).equals(file.original))
          await replace(file, file.original, true)
        assert.ok(
          (await readFile(file.path)).equals(file.original),
          'Disposable source restored exactly',
        )
      } catch (error) {
        errors.push(error)
      }
    }
    if (errors.length)
      throw new AggregateError(errors, 'Failed to restore disposable fixture source')
  }
  const composer = () =>
    page.getByRole('textbox', { name: 'Message your coding agent', exact: true })
  const stop = () =>
    page.getByRole('button', { name: 'Stop agent and pause queued messages', exact: true })
  // Prevented Electron navigation remains pending in Playwright's action
  // prechecks. Observe the actual retained DOM and use trusted pointer input.
  const composerValue = () =>
    page.evaluate(
      () => document.querySelector('textarea[aria-label="Message your coding agent"]')?.value,
    )
  const brandText = () =>
    page.evaluate(() => document.querySelector('.titlebar-brand strong')?.textContent || '')
  const shellAttribute = (name) =>
    page.evaluate(
      (attribute) => document.querySelector('.app-shell')?.getAttribute(attribute),
      name,
    )
  const stopVisible = () =>
    page.evaluate(() => {
      const button = document.querySelector(
        'button[aria-label="Stop agent and pause queued messages"]',
      )
      return Boolean(
        button &&
        button.getClientRects().length &&
        getComputedStyle(button).visibility !== 'hidden',
      )
    })
  const clickTrustedStop = async () => {
    const point = await page.evaluate(() => {
      const button = document.querySelector(
        'button[aria-label="Stop agent and pause queued messages"]',
      )
      if (!(button instanceof HTMLButtonElement) || button.disabled)
        throw new Error('The actual native Stop button must be enabled.')
      const bounds = button.getBoundingClientRect()
      const x = bounds.x + bounds.width / 2
      const y = bounds.y + bounds.height / 2
      if (!bounds.width || !bounds.height || !button.contains(document.elementFromPoint(x, y)))
        throw new Error(
          'The actual Stop button must be visible and unobstructed at its click point.',
        )
      button.addEventListener(
        'click',
        (event) => console.info('__lifeOwnershipStopTrusted__' + String(event.isTrusted)),
        { once: true },
      )
      return { x, y }
    })
    proof.stopPointer = point
    await page.mouse.click(point.x, point.y)
    await waitUntil(
      () => proof.trustedStopEvents.includes(true),
      'the actual UI Stop receives a trusted mouse click',
    )
    assert.deepEqual(
      proof.trustedStopEvents,
      [true],
      'UI Stop receives exactly one trusted pointer click',
    )
  }
  const flush = () => page.evaluate(() => window.__lifeFlushConversationHistory())
  const currentThread = async () =>
    (await readSavedThreads(page)).find((thread) => thread.id === threadId)
  const readDisk = async () => JSON.parse(await readFile(diskPath, 'utf8'))
  const marker = () =>
    page.evaluate(() => ({
      document: globalThis.__lifeOwnershipDocument,
      module: globalThis.__lifeOwnershipModule,
      react: globalThis.__lifeOwnershipReact,
      appModule: globalThis.__lifeOwnershipAppModule,
      vite: globalThis.__lifeOwnershipViteEvents || [],
    }))
  const nativeState = () =>
    application.evaluate(({ BrowserWindow }) => ({
      ...globalThis.__lifeOwnershipNative,
      currentPid: process.pid,
      currentWindowId: BrowserWindow.getAllWindows()[0].id,
      currentRendererPid: BrowserWindow.getAllWindows()[0].webContents.getOSProcessId(),
    }))
  const observe = async (label) => {
    const saved = await currentThread()
    const disk = await readDisk()
    const diskThread = disk.threads.find((thread) => thread.id === threadId)
    const providerLog = await fixture.log()
    const observation = {
      marker: await marker(),
      native: await nativeState(),
      connection: await page.evaluate(() => window.relay.connection.state()),
      savedArchive: protectedArchive(saved),
      diskArchive: protectedArchive(diskThread),
      diskSha256: hash(await readFile(diskPath)),
      draft: await composerValue(),
      draftStorage: await page.evaluate((key) => localStorage.getItem(key), draftKey),
      stopVisible: await stopVisible(),
      diskLifecycle: { busy: diskThread?.busy, turnStatus: diskThread?.turnStatus },
      nativeHeartbeats: providerLog
        .filter((entry) => entry.kind === 'hmr-heartbeat')
        .map((entry) => ({
          threadId: entry.threadId,
          turnId: entry.turnId,
          sequence: entry.sequence,
        })),
      nativeInterrupts: providerLog.filter((entry) => entry.message?.method === 'turn/interrupt')
        .length,
      primaryTurns: primaryTurns(providerLog).map((entry) => ({
        threadId: entry.message.params.threadId,
        prompt: entry.message.params.input.find((value) => value.type === 'text')?.text,
      })),
    }
    observation.savedArchiveHash = jsonHash(observation.savedArchive)
    observation.diskArchiveHash = jsonHash(observation.diskArchive)
    observation.archivePreserved =
      observation.savedArchiveHash === jsonHash(protectedSeed) &&
      observation.diskArchiveHash === jsonHash(protectedSeed)
    proof.observations[label] = observation
    await writeFile(join(artifacts, `${label}.json`), JSON.stringify(observation, null, 2) + '\n')
    return observation
  }
  const streamedSequence = () =>
    page.evaluate(() => {
      const values = [...document.querySelectorAll('.app-shell')]
        .flatMap((element) => [...element.textContent.matchAll(/HMR provider heartbeat (\d+)/g)])
        .map((match) => Number(match[1]))
      return Math.max(0, ...values)
    })
  const launch = async () => {
    application = await electron.launch({
      executablePath: require('electron'),
      args: [
        copiedRoot,
        '--no-sandbox',
        '--disable-dev-shm-usage',
        `--user-data-dir=${join(configurationRoot, 'chromium')}`,
      ],
      cwd: copiedRoot,
      env: {
        ...process.env,
        ELECTRON_RENDERER_URL: proof.rendererURL,
        XDG_CONFIG_HOME: configurationRoot,
      },
      timeout: 30000,
    })
    page = await application.firstWindow()
    page.setDefaultTimeout(25000)
    cdp = await page.context().newCDPSession(page)
    const recordFrame = (direction, event) => {
      if (event.response.opcode !== 1) return
      let payload
      try {
        payload = JSON.parse(event.response.payloadData)
      } catch {
        return
      }
      proof.clientWebsocket.push({
        direction,
        type: payload.type,
        event: payload.event,
        data: payload.data,
        path: payload.path,
        updates: payload.updates?.map((update) => ({
          type: update.type,
          path: update.path,
          acceptedPath: update.acceptedPath,
        })),
      })
    }
    cdp.on('Network.webSocketFrameSent', (event) => recordFrame('sent', event))
    cdp.on('Network.webSocketFrameReceived', (event) => recordFrame('received', event))
    await cdp.send('Network.enable')
    page.on('pageerror', (error) => proof.errors.push(error.message))
    page.on('console', (message) => {
      if (message.type() === 'error') proof.consoleErrors.push(message.text())
      if (message.text().startsWith('__lifeOwnershipStopTrusted__'))
        proof.trustedStopEvents.push(message.text() === '__lifeOwnershipStopTrusted__true')
    })
    await application.evaluate(({ app, BrowserWindow }) => {
      const window = BrowserWindow.getAllWindows()[0]
      window.setBounds({ width: 1920, height: 1080 })
      globalThis.__lifeOwnershipNative = {
        pid: process.pid,
        windowId: window.id,
        rendererPid: window.webContents.getOSProcessId(),
        navigations: [],
        attempts: [],
        windows: [],
      }
      window.webContents.on('will-navigate', (event) => {
        globalThis.__lifeOwnershipNative.attempts.push({
          url: event.url,
          prevented: event.defaultPrevented,
        })
      })
      window.webContents.on('did-start-navigation', (...arguments_) => {
        const [event, oldURL, oldInPlace, oldMainFrame] = arguments_
        const mainFrame = typeof event.isMainFrame === 'boolean' ? event.isMainFrame : oldMainFrame
        const inPlace = typeof event.isInPlace === 'boolean' ? event.isInPlace : oldInPlace
        if (mainFrame && !inPlace)
          globalThis.__lifeOwnershipNative.navigations.push(event.url || oldURL)
      })
      app.on('browser-window-created', (_event, created) => {
        globalThis.__lifeOwnershipNative.windows.push(created.id)
      })
    })
    await page.locator('.app-shell').waitFor()
    assert.equal(new URL(page.url()).origin, proof.rendererURL)
    const startupConnection = await page.evaluate(() => window.relay.connection.state())
    assert.equal(startupConnection.status, 'disconnected')
    assert.notEqual(startupConnection.profile?.transport, 'local')
    const userData = await application.evaluate(({ app }) => app.getPath('userData'))
    assert.ok(
      userData.startsWith(configurationRoot),
      'The real native application profile is isolated',
    )
    diskPath = join(userData, 'conversations.json')
    return userData
  }
  try {
    proof.inputGraph = await graph(appRoot)
    await mkdir(copiedRoot, { recursive: true })
    await mkdir(configurationRoot)
    await seedPrivateSSHSelection(configurationRoot)
    for (const path of [
      'src',
      'out',
      'scripts',
      'build',
      'package.json',
      'electron.vite.config.ts',
    ])
      await cp(join(appRoot, path), join(copiedRoot, path), { recursive: true })
    await symlink(join(appRoot, 'node_modules'), join(copiedRoot, 'node_modules'), 'dir')
    for (const [path, name] of [
      ['src/renderer/conversation-source.ts', 'conversation-source.ts'],
      ['src/renderer/components/TitleBar.tsx', 'TitleBar.tsx'],
      ['electron.vite.config.ts', 'electron.vite.config.ts'],
      ['src/renderer/App.tsx', 'App.tsx'],
      ['src/renderer/styles.css', 'styles.css'],
    ]) {
      const file = { path: join(copiedRoot, path), name }
      file.original = await readFile(file.path)
      file.expected = file.original
      files.push(file)
      await writeFile(join(artifacts, `${name}.original`), file.original)
      proof.source.push({ path, originalSha256: hash(file.original) })
    }
    const sourceFile = files[0]
    const componentFile = files[1]
    const configFile = files[2]
    const appFile = files[3]
    const styleFile = files[4]
    const appOriginal = appFile.original.toString('utf8')
    const appFunctionNeedle = 'export function App() {\n'
    assert.equal(appOriginal.split(appFunctionNeedle).length, 2, 'One real App entry exists')
    const appClassNeedle = '        className={`app-shell '
    assert.equal(
      appOriginal.split(appClassNeedle).length,
      2,
      'One app-shell property target exists',
    )
    const observedApp =
      appOriginal
        .replace(
          appFunctionNeedle,
          appFunctionNeedle +
            '  const ownershipFixtureReactRef = useRef({ id: crypto.randomUUID() })\n' +
            '  globalThis.__lifeOwnershipReact = ownershipFixtureReactRef.current\n',
        )
        .replace(
          appClassNeedle,
          '        data-ownership-hmr-probe="initial"\n' +
            '        data-ownership-direct-app-probe="initial"\n' +
            appClassNeedle,
        ) +
      '\n// Disposable fixture observes module evaluation independently of retained React hooks.\n' +
      'globalThis.__lifeOwnershipAppModule = { evaluations: (globalThis.__lifeOwnershipAppModule?.evaluations || 0) + 1, documentId: globalThis.__lifeOwnershipDocument?.id };\n'
    let pendingAppSource = observedApp
    await replace(appFile, Buffer.from(observedApp))
    await replace(
      sourceFile,
      Buffer.concat([sourceFile.original, Buffer.from(moduleMarker('baseline'))]),
    )
    if (policy === 'ordinary') {
      const configured = configFile.original.toString('utf8')
      const needle = 'lifeRendererReloadPlugin()'
      assert.equal(
        configured.split(needle).length,
        2,
        'One production reload plugin configuration exists',
      )
      await replace(
        configFile,
        Buffer.from(
          configured.replace(needle, 'lifeRendererReloadPlugin({ guardOwnershipModules: false })'),
        ),
      )
    }
    const { resolveConfig } = await import('electron-vite')
    const { createServer } = await import('vite')
    const configured = await resolveConfig(
      { root: copiedRoot, configFile: configFile.path },
      'serve',
      'development',
    )
    assert.ok(
      configured.config?.renderer,
      'The actual Electron-Vite renderer configuration resolved',
    )
    assert.ok(
      configured.config.renderer.plugins
        .flat(Infinity)
        .some((plugin) => plugin?.name === 'life-renderer-reload'),
    )
    const listener = createTCPServer()
    await new Promise((done, reject) => {
      listener.once('error', reject)
      listener.listen(0, '127.0.0.1', done)
    })
    const port = listener.address().port
    await new Promise((done) => listener.close(done))
    server = await createServer({
      ...configured.config.renderer,
      root: resolve(copiedRoot, configured.config.renderer.root || 'src/renderer'),
      cacheDir: join(directory, 'vite-cache'),
      server: {
        ...configured.config.renderer.server,
        host: '127.0.0.1',
        port,
        strictPort: true,
        open: false,
        fs: {
          ...configured.config.renderer.server?.fs,
          allow: [copiedRoot, await realpath(join(appRoot, 'node_modules'))],
        },
      },
    })
    const send = server.ws.send.bind(server.ws)
    server.ws.send = (...arguments_) => {
      const payload = arguments_[0]
      if (payload && typeof payload === 'object')
        proof.websocket.push({
          type: payload.type,
          path: payload.path,
          updates: payload.updates?.map((update) => ({
            type: update.type,
            path: update.path,
            acceptedPath: update.acceptedPath,
          })),
        })
      return send(...arguments_)
    }
    await server.listen()
    proof.rendererURL = `http://127.0.0.1:${server.httpServer.address().port}`
    const bundledFixture = join(artifacts, 'ownership-hmr-ssh-fixture.cjs')
    await build({
      entryPoints: [join(repository, 'tests/helpers/ssh-fixture.ts')],
      outfile: bundledFixture,
      bundle: true,
      platform: 'node',
      format: 'cjs',
      packages: 'external',
      logLevel: 'silent',
    })
    const providerOriginal = await readFile(
      join(repository, 'tests/fixtures/fake-provider.cjs'),
      'utf8',
    )
    const providerNeedle = "    if (text === 'hang' || text === 'delay-start') return"
    assert.equal(
      providerOriginal.split(providerNeedle).length,
      2,
      'Exactly one Codex hang branch exists',
    )
    const providerCopy = providerOriginal.replace(
      providerNeedle,
      `    if (text === 'hang') {
      let heartbeat = 0
      const interval = setInterval(() => {
        if (codexActive.get(threadId) !== turn) { clearInterval(interval); return }
        send({ method: 'item/agentMessage/delta', params: {
          threadId, itemId: turn.itemId, delta: '\\nHMR provider heartbeat ' + (++heartbeat),
        } })
        record({ kind: 'hmr-heartbeat', threadId, turnId: turn.turnId, sequence: heartbeat })
      }, 250)
      return
    }
    if (text === 'delay-start') return`,
    )
    const providerPath = join(directory, 'fake-provider.cjs')
    await writeFile(providerPath, providerCopy, { mode: 0o755 })
    proof.provider = {
      originalSha256: hash(providerOriginal),
      disposableSha256: hash(providerCopy),
      change:
        'Only the disposable Codex hang branch emits numbered native deltas every 250 ms until interrupted.',
    }
    const { SSHFixture } = require(bundledFixture)
    fixture = new SSHFixture(providerPath)
    await fixture.start()
    fixture.discoveryPorts = []
    phase = 'establish exact prompt and native session through the real UI'
    await launch()
    const input = fixture.input()
    await page.getByRole('button', { name: 'Connections', exact: true }).click()
    const connection = page.getByRole('dialog', { name: 'Choose an environment', exact: true })
    await connection.waitFor()
    const addSSH = connection.getByRole('button', { name: 'Add SSH machine', exact: true })
    await addSSH.click()
    await connection.getByPlaceholder('My development server').fill(input.name)
    await connection.getByPlaceholder('dev.example.com').fill(input.host)
    await connection.getByLabel('Port', { exact: true }).fill(String(input.port))
    await connection.getByPlaceholder('developer').fill(input.username)
    await connection.getByLabel('Authentication').selectOption('password')
    await connection.getByPlaceholder('Your SSH password').fill(input.password)
    await connection.getByRole('button', { name: 'Connect machine', exact: true }).click()
    await page
      .getByRole('dialog', { name: 'Trust this machine?', exact: true })
      .getByRole('button', { name: 'Trust and connect', exact: true })
      .click()
    await connection.waitFor({ state: 'hidden' })
    const picker = page.getByRole('dialog', { name: 'Select a project', exact: true })
    await picker
      .getByRole('textbox', { name: 'Project directory', exact: true })
      .fill(input.workspace)
    await picker.getByRole('button', { name: 'Open project', exact: true }).click()
    await picker.waitFor({ state: 'hidden' })
    await composer().fill(exactPrompt)
    await page.getByRole('button', { name: 'Send message', exact: true }).click()
    let original
    await waitUntil(async () => {
      original = (await readSavedThreads(page)).find(
        (thread) =>
          thread.remoteId &&
          !thread.busy &&
          thread.messages.some((message) => message.text === exactPrompt) &&
          thread.title === 'Provider-generated workspace title',
      )
      return Boolean(original)
    }, 'a real native session and the original exact prompt persist')
    threadId = original.id
    assert.equal(original.workspace, input.workspace)
    assert.ok(original.profileId)
    await flush()
    // Graceful closure flushes the old React view before private-disk seeding.
    await cdp.detach()
    cdp = undefined
    await application.close()
    application = undefined
    page = undefined
    const snapshot = await readDisk()
    const raw = snapshot.threads.find((thread) => thread.id === threadId)
    raw.title = title
    raw.titleSource = 'manual'
    raw.futureThreadField = {
      text: exactPrompt,
      exactInput: '  Original input\r\n\tΩ 😀  ',
      nested: [null, 17, true, { nativeFutureMetadata: 'retain the full archive' }],
    }
    raw.messages = [
      null,
      'opaque scalar Ω\r\n',
      47,
      {
        id: 'duplicate-opaque-message',
        role: 'native-future-role',
        text: 'First future native record',
        fixtureArchiveOccurrence: 1,
        providerMetadata: { exact: exactPrompt },
      },
      ...raw.messages.map((message, index) => ({
        ...message,
        fixtureArchiveOccurrence: `original-${index}`,
        futureMessageField: { exactInput: '  Original input\r\n\tΩ 😀  ', index },
      })),
      {
        id: 'duplicate-opaque-message',
        role: 'another-native-role',
        text: 'Second future native record',
        fixtureArchiveOccurrence: 2,
        providerMetadata: { values: [false, null, 0] },
      },
      { role: 'user', text: 'Missing native identity', fixtureArchiveOccurrence: 3 },
      ['future-array', { exact: exactPrompt }],
    ]
    snapshot.savedAt = Math.max(Date.now(), snapshot.savedAt) + 1000
    protectedSeed = protectedArchive(raw)
    await writeFile(diskPath, JSON.stringify(snapshot, null, 2) + '\n')
    await writeFile(join(artifacts, 'archive-seed.json'), JSON.stringify(snapshot, null, 2) + '\n')
    proof.archiveSeedHash = jsonHash(protectedSeed)
    proof.conversation = {
      threadId,
      profileId: raw.profileId,
      provider: raw.provider,
      providerSessionId: raw.remoteId,
      workspace: raw.workspace,
      exactPrompt,
      exactDraft,
    }
    phase = 'fresh production hydration of opaque raw archive'
    await launch()
    const archivedRow = page.locator('[data-thread-row]').filter({ hasText: title })
    await archivedRow.waitFor()
    const reconnect = page.getByRole('dialog', { name: 'Choose an environment', exact: true })
    const reconnectLoading = page.getByRole('dialog', {
      name: 'Choose an environment',
      exact: true,
    })
    if (!(await reconnect.or(reconnectLoading).isVisible())) await archivedRow.click()
    await reconnect.waitFor()
    assert.equal(
      await reconnect.getByPlaceholder('My development server').inputValue(),
      input.name,
      'The real saved profile owner is selected',
    )
    await reconnect.getByPlaceholder('Your SSH password').fill(input.password)
    await reconnect.getByRole('button', { name: 'Connect machine', exact: true }).click()
    await reconnect.waitFor({ state: 'hidden' })
    await archivedRow.click()
    await waitUntil(async () => {
      const state = await page.evaluate(() => window.relay.connection.state())
      return (
        state.status === 'connected' &&
        state.workspace === input.workspace &&
        state.profile?.id === raw.profileId
      )
    }, 'the actual saved owner and project reconnect')
    await composer().waitFor()
    await flush()
    const hydrated = await currentThread()
    assert.deepEqual(
      protectedArchive(hydrated),
      protectedSeed,
      'Fresh production hydration is lossless before the hot edit',
    )
    check(
      'A clean native boot preserves opaque scalar, future, duplicate message records and exact original prompt',
    )
    assert.equal(
      primaryTurns(await fixture.log()).length,
      1,
      'Setup submitted exactly one normal provider turn',
    )
    phase = 'start one native hang and persist an exact separate unsent draft'
    await composer().fill('hang')
    await page.getByRole('button', { name: 'Send message', exact: true }).click()
    await stop().waitFor()
    await waitUntil(
      async () => (await streamedSequence()) >= 2,
      'numbered native stream arrives over SSH',
    )
    await composer().fill(exactDraft)
    await waitUntil(
      () =>
        page.evaluate(
          ({ key, draft }) => {
            const stored = JSON.parse(localStorage.getItem(key) || '{}')
            return Object.values(stored).some((value) => value?.draft === draft || value === draft)
          },
          { key: draftKey, draft: exactDraft },
        ),
      'the exact unsent draft is durably saved',
    )
    await flush()
    const baseline = await observe('beforeCriticalEdit')
    assert.equal(
      baseline.archivePreserved,
      true,
      'Starting the real new turn preserves archival source',
    )
    assert.equal(baseline.stopVisible, true)
    assert.equal(baseline.draft, exactDraft)
    assert.equal(baseline.primaryTurns.length, 2)
    assert.equal(baseline.primaryTurns[1].prompt, 'hang')
    assert.equal(baseline.primaryTurns[1].threadId, raw.remoteId)
    assert.equal(baseline.marker.module.evaluations, 1, 'Initial ownership module evaluated once')
    assert.equal(baseline.marker.appModule.evaluations, 1, 'Initial App module evaluated once')
    check(
      'One native hang streams while its exact unsent draft and provider identity remain separate',
    )
    const assertActivePreserved = async (label) => {
      const observation = await observe(label)
      proof.activeObservationLabels.push(label)
      assert.equal(
        observation.native.currentPid,
        baseline.native.currentPid,
        `${label}: native PID remains stable`,
      )
      assert.equal(
        observation.native.currentWindowId,
        baseline.native.currentWindowId,
        `${label}: native window remains stable`,
      )
      assert.equal(
        observation.native.currentRendererPid,
        baseline.native.currentRendererPid,
        `${label}: native renderer process remains stable`,
      )
      assert.deepEqual(
        observation.native.windows,
        baseline.native.windows,
        `${label}: no replacement native window is created`,
      )
      assert.equal(
        observation.marker.document.id,
        baseline.marker.document.id,
        `${label}: active document remains stable`,
      )
      assert.equal(
        observation.marker.react.id,
        baseline.marker.react.id,
        `${label}: actual React hook state remains retained`,
      )
      assert.equal(observation.connection.status, 'connected', `${label}: SSH remains connected`)
      assert.equal(observation.draft, exactDraft, `${label}: exact draft remains visible`)
      assert.equal(
        observation.draftStorage,
        baseline.draftStorage,
        `${label}: exact draft storage remains intact`,
      )
      assert.deepEqual(
        observation.primaryTurns,
        baseline.primaryTurns,
        `${label}: no additional provider turn`,
      )
      if (policy === 'guarded') {
        assert.equal(
          observation.marker.appModule.evaluations,
          baseline.marker.appModule.evaluations,
          `${label}: App ownership module is not reevaluated while busy`,
        )
        assert.equal(observation.stopVisible, true, `${label}: active Stop remains available`)
        assert.equal(
          observation.marker.module.evaluations,
          baseline.marker.module.evaluations,
          `${label}: ownership module is not replaced while busy`,
        )
        assert.equal(
          observation.archivePreserved,
          true,
          `${label}: complete raw provenance remains intact`,
        )
      }
      return observation
    }
    const componentOriginal = componentFile.original.toString('utf8')
    const componentBoundaryTail =
      policy === 'guarded' ? "\nexport const lifeHMRBoundaryProbe = 'fixed'\n" : ''
    const componentNeedle = '        life\n'
    assert.equal(
      componentOriginal.split(componentNeedle).length,
      2,
      'Exactly one LifeBrand component target exists',
    )
    phase = 'harmless component hot reload before any critical edit'
    const heartbeatBeforeHarmless = await streamedSequence()
    await replace(
      componentFile,
      Buffer.from(
        componentOriginal.replace(componentNeedle, '        life harmless HMR fixture\n'),
      ),
    )
    await waitUntil(
      async () => (await brandText()).includes('harmless HMR fixture'),
      'ordinary component HMR before a critical edit',
    )
    await waitUntil(
      async () => (await streamedSequence()) >= heartbeatBeforeHarmless + 3,
      'native stream remains live after the harmless edit',
    )
    const afterHarmless = await assertActivePreserved('afterHarmlessEdit')
    assert.equal(
      afterHarmless.stopVisible,
      true,
      'A normal component edit retains Stop before ownership changes',
    )
    assert.equal(afterHarmless.archivePreserved, true)
    assert.equal(afterHarmless.marker.module.evaluations, 1)
    assert.equal(afterHarmless.marker.appModule.evaluations, 1)
    check(
      'Ordinary component HMR preserves actual React state, active Stop, exact draft and opaque provenance before a critical edit',
    )
    if (policy === 'guarded') {
      phase = 'a real React export-boundary invalidation is intercepted before App replacement'
      const boundaryFrameStart = proof.clientWebsocket.length
      const boundaryNativeBefore = await nativeState()
      const boundaryMarkerBefore = await marker()
      const heartbeatBeforeBoundary = await streamedSequence()
      await replace(
        componentFile,
        Buffer.from(
          componentOriginal.replace(componentNeedle, '        life harmless HMR fixture\n') +
            componentBoundaryTail,
        ),
      )
      await waitUntil(
        () =>
          proof.clientWebsocket
            .slice(boundaryFrameStart)
            .some(
              (frame) =>
                frame.direction === 'sent' &&
                frame.type === 'custom' &&
                frame.event === 'vite:invalidate' &&
                frame.data?.path?.endsWith('/components/TitleBar.tsx'),
            ),
        'the actual React refresh client sends a TitleBar export-boundary invalidation frame',
      )
      await waitUntil(
        () =>
          proof.clientWebsocket
            .slice(boundaryFrameStart)
            .some((frame) => frame.direction === 'received' && frame.type === 'full-reload'),
        'the outgoing protected App parent update becomes an actual full-reload frame',
      )
      await waitUntil(
        async () =>
          (await marker()).vite.filter((event) => event.type === 'beforeFullReload').length >
          boundaryMarkerBefore.vite.filter((event) => event.type === 'beforeFullReload').length,
        'the client processes the converted ownership reload',
      )
      await waitUntil(
        async () => (await nativeState()).attempts.length > boundaryNativeBefore.attempts.length,
        'native admission defers the invalidated parent App reload',
      )
      await waitUntil(
        async () => (await streamedSequence()) >= heartbeatBeforeBoundary + 3,
        'the same native turn streams after the export-boundary invalidation',
      )
      await flush()
      await assertActivePreserved('afterExportBoundaryInvalidation')
      assert.equal(await shellAttribute('data-ownership-hmr-probe'), 'initial')
      assert.equal(await shellAttribute('data-ownership-direct-app-probe'), 'initial')
      check(
        'An actual React export-boundary invalidation converts the protected App parent update into a deferred reload without reevaluating App or losing native controls',
      )
      phase = 'a direct App ownership edit is deferred before any source-module edit'
      const directWebsocketStart = proof.websocket.length
      const directNativeBefore = await nativeState()
      const directMarkerBefore = await marker()
      const heartbeatBeforeDirectApp = await streamedSequence()
      pendingAppSource = observedApp.replace(
        'data-ownership-direct-app-probe="initial"',
        'data-ownership-direct-app-probe="changed"',
      )
      await replace(appFile, Buffer.from(pendingAppSource))
      await waitUntil(
        () =>
          proof.websocket
            .slice(directWebsocketStart)
            .some((payload) => payload.type === 'full-reload'),
        'the direct App edit requests an ownership reload',
      )
      await waitUntil(
        async () =>
          (await marker()).vite.filter((event) => event.type === 'beforeFullReload').length >
          directMarkerBefore.vite.filter((event) => event.type === 'beforeFullReload').length,
        'the real Vite client receives the direct App reload request',
      )
      await waitUntil(
        async () => (await nativeState()).attempts.length > directNativeBefore.attempts.length,
        'native admission defers the direct App reload attempt',
      )
      await waitUntil(
        async () => (await streamedSequence()) >= heartbeatBeforeDirectApp + 3,
        'the native stream continues after the direct App ownership edit',
      )
      await flush()
      await assertActivePreserved('afterDirectAppOwnershipEdit')
      assert.equal(
        await shellAttribute('data-ownership-direct-app-probe'),
        'initial',
        'The direct App change is held while its native effect ownership remains active',
      )
      check(
        'A direct App ownership edit keeps the old App module, actual React state, Stop, document and registry while the same native turn streams',
      )
    }
    phase = 'actual critical ownership module hotUpdate while native turn remains active'
    const websocketStart = proof.websocket.length
    const heartbeatBeforeCritical = await streamedSequence()
    const nativeBeforeCritical = await nativeState()
    const markerBeforeCritical = await marker()
    const criticalStarted = performance.now()
    await replace(
      sourceFile,
      Buffer.concat([sourceFile.original, Buffer.from(moduleMarker('critical-edit'))]),
    )
    await waitUntil(
      () =>
        proof.websocket
          .slice(websocketStart)
          .some((payload) => ['update', 'full-reload'].includes(payload.type)),
      'an actual Vite hotUpdate is broadcast',
    )
    if (policy === 'guarded') {
      assert.ok(
        proof.websocket.slice(websocketStart).some((payload) => payload.type === 'full-reload'),
        'Ownership edits request a coordinated full reload',
      )
      await waitUntil(
        async () =>
          (await marker()).vite.filter((event) => event.type === 'beforeFullReload').length >
          markerBeforeCritical.vite.filter((event) => event.type === 'beforeFullReload').length,
        'the real Vite client receives the full reload',
      )
      await waitUntil(
        async () => (await nativeState()).attempts.length > nativeBeforeCritical.attempts.length,
        'native admission observes the reload attempt',
      )
    } else {
      await waitUntil(
        async () => (await marker()).module.token === 'critical-edit',
        'ordinary HMR evaluates the changed ownership module',
      )
    }
    await waitUntil(
      async () => (await streamedSequence()) >= heartbeatBeforeCritical + 3,
      'the same provider turn keeps streaming after the critical edit',
    )
    proof.timings.criticalObservationMs = performance.now() - criticalStarted
    await flush()
    await assertActivePreserved('afterCriticalEdit')
    await page.screenshot({ path: join(artifacts, 'critical-edit-active.png') })
    check(
      policy === 'guarded'
        ? 'A real ownership-module edit requests full reload while native admission defers replacement during the active turn'
        : 'Ordinary Vite replaces the critical module in the retained active document; provenance effects are observed separately',
    )
    phase = 'self-accepting CSS hot reload remains live after the critical edit'
    const heartbeatBeforeCss = await streamedSequence()
    await replace(
      styleFile,
      Buffer.concat([
        styleFile.original,
        Buffer.from(
          '\n/* Disposable ownership-HMR fixture. */\n.titlebar-brand { --life-ownership-hmr-css: updated; outline: 2px solid rgb(65, 135, 220); }\n',
        ),
      ]),
    )
    await waitUntil(
      () =>
        // Electron prevents the attempted navigation. Locator.evaluate waits
        // for Playwright's pending navigation signal; read this live document
        // directly, as the other ownership/stream probes do.
        page.evaluate(() => {
          const element = document.querySelector('.titlebar-brand')
          return (
            element !== null &&
            getComputedStyle(element).getPropertyValue('--life-ownership-hmr-css').trim() ===
              'updated'
          )
        }),
      'actual self-accepting CSS HMR while the ownership edit is pending',
    )
    await waitUntil(
      async () => (await streamedSequence()) >= heartbeatBeforeCss + 3,
      'the same native turn remains responsive during CSS HMR',
    )
    await flush()
    await assertActivePreserved('afterPendingCssEdit')
    check(
      'Self-accepting CSS still updates during pending ownership changes while the active document, exact draft and native stream stay intact',
    )
    phase = 'harmless React component edit still applies during the pending critical reload'
    const heartbeatBeforeComponent = await streamedSequence()
    const componentStarted = performance.now()
    const componentWebsocketStart = proof.websocket.length
    await replace(
      componentFile,
      Buffer.from(
        componentOriginal.replace(componentNeedle, '        life ownership HMR fixture\n') +
          componentBoundaryTail,
      ),
    )
    await waitUntil(
      () =>
        proof.websocket
          .slice(componentWebsocketStart)
          .some((payload) => ['update', 'full-reload'].includes(payload.type)),
      'the real component edit is broadcast while a critical change is pending',
    )
    if (policy === 'ordinary')
      await waitUntil(
        async () => (await brandText()).includes('ownership HMR fixture'),
        'harmless component Fast Refresh remains usable',
      )
    await waitUntil(
      async () => (await streamedSequence()) >= heartbeatBeforeComponent + 3,
      'the same native stream remains responsive after component HMR',
    )
    proof.timings.componentObservationMs = performance.now() - componentStarted
    await flush()
    await assertActivePreserved('afterComponentEdit')
    proof.componentUpdatedWhileCriticalPending = (await brandText()).includes(
      'ownership HMR fixture',
    )
    if (policy === 'guarded')
      assert.equal(
        proof.componentUpdatedWhileCriticalPending,
        false,
        'Subsequent JS replacements stay deferred while ownership reload is pending',
      )
    await page.screenshot({ path: join(artifacts, 'component-edit-active.png') })
    check(
      `A subsequent component edit keeps the document, native stream and draft intact; component applied while critical pending: ${proof.componentUpdatedWhileCriticalPending}`,
    )
    phase = 'harmless App property edit re-imports the affected critical dependency graph'
    const appEditWebsocketStart = proof.websocket.length
    const heartbeatBeforeAppEdit = await streamedSequence()
    await replace(
      appFile,
      Buffer.from(
        pendingAppSource.replace(
          'data-ownership-hmr-probe="initial"',
          'data-ownership-hmr-probe="changed"',
        ),
      ),
    )
    await waitUntil(
      () =>
        proof.websocket
          .slice(appEditWebsocketStart)
          .some((payload) => ['update', 'full-reload'].includes(payload.type)),
      'an actual harmless App edit reaches Vite',
    )
    if (policy === 'ordinary')
      await waitUntil(
        async () => (await shellAttribute('data-ownership-hmr-probe')) === 'changed',
        'ordinary Fast Refresh re-imports the App dependencies',
      )
    await waitUntil(
      async () => (await streamedSequence()) >= heartbeatBeforeAppEdit + 3,
      'the existing native stream survives the importing component edit',
    )
    await flush()
    await assertActivePreserved('afterImportingComponentEdit')
    if (policy === 'guarded')
      assert.equal(
        await shellAttribute('data-ownership-hmr-probe'),
        'initial',
        'The importing App module is deferred while its ownership registry is in use',
      )
    check(
      'The importing component is exercised after the critical edit, exposing stale dependency replacement while actual React state stays retained',
    )
    phase = 'actual UI Stop settles the same provider turn and admits the queued ownership reload'
    const stopped = performance.now()
    if (await stopVisible()) {
      proof.stopPath = 'actual UI Stop'
      await clickTrustedStop()
    } else {
      assert.equal(policy, 'ordinary', 'The guarded candidate must retain the real UI Stop')
      proof.stopPath = 'real native API fallback because ordinary critical HMR removed UI Stop'
      await page.evaluate((id) => window.relay.agent.stop(id), threadId)
    }
    await waitUntil(
      async () =>
        (await fixture.log()).some(
          (entry) =>
            entry.message?.method === 'turn/interrupt' &&
            entry.message.params.threadId === raw.remoteId,
        ),
      'UI Stop sends the real native interruption',
    )
    if (policy === 'guarded') {
      await waitUntil(async () => {
        const current = await marker().catch((error) => {
          if (
            /Execution context was destroyed|Cannot find context with (?:specified )?id/.test(
              String(error),
            )
          )
            return undefined
          throw error
        })
        return (
          typeof current?.document?.id === 'string' &&
          current.document.id !== baseline.marker.document.id
        )
      }, 'the deferred reload commits after native work settles')
      await page.locator('.app-shell').waitFor()
      await page.locator('[data-thread-row]').filter({ hasText: title }).waitFor()
      await composer().waitFor()
      await waitUntil(
        async () => (await composerValue()) === exactDraft,
        'fresh hydration restores the exact unsent draft',
      )
      const fresh = await marker()
      assert.equal(fresh.module.evaluations, 1, 'A new document owns a fresh source registry')
      assert.equal(
        fresh.appModule.evaluations,
        1,
        'The new document owns a freshly evaluated App module',
      )
      assert.equal(
        fresh.module.token,
        'critical-edit',
        'The new document loads the actual changed module',
      )
      assert.equal(
        await shellAttribute('data-ownership-hmr-probe'),
        'changed',
        'The fresh document applies the deferred importing component edit',
      )
      assert.equal(
        await shellAttribute('data-ownership-direct-app-probe'),
        'changed',
        'The fresh document also applies the earlier direct App ownership edit',
      )
      assert.ok(
        (await brandText()).includes('ownership HMR fixture'),
        'Fresh hydration applies the queued harmless component edit',
      )
    } else {
      await stop().waitFor({ state: 'hidden' })
    }
    proof.timings.stopToSettledObservationMs = performance.now() - stopped
    await flush()
    const settled = await observe('afterStop')
    assert.equal(settled.stopVisible, false)
    assert.equal(
      settled.draft,
      exactDraft,
      'UI Stop does not accidentally submit the newly typed draft',
    )
    assert.equal(settled.draftStorage, baseline.draftStorage)
    assert.deepEqual(
      settled.primaryTurns,
      baseline.primaryTurns,
      'Critical reload and Stop cause no replay or extra inference',
    )
    if (policy === 'guarded') {
      assert.equal(settled.archivePreserved, true)
      assert.equal(
        settled.diskLifecycle.busy,
        false,
        'The fresh durable conversation is no longer busy',
      )
      assert.equal(settled.diskLifecycle.turnStatus, 'interrupted')
      assert.equal(
        settled.native.currentPid,
        baseline.native.currentPid,
        'The deferred reload preserves the native application PID',
      )
      assert.equal(
        settled.native.currentWindowId,
        baseline.native.currentWindowId,
        'The deferred reload preserves the native window',
      )
      assert.notEqual(
        settled.marker.react.id,
        baseline.marker.react.id,
        'The committed fresh document owns fresh React state',
      )
    }
    check(
      `${proof.stopPath} interrupts only the existing native turn and preserves the unsent draft without another provider request`,
    )
    if (policy === 'guarded') {
      phase = 'ordinary component hot reload resumes after fresh owned hydration'
      const freshBeforeComponent = await marker()
      await replace(
        componentFile,
        Buffer.from(
          componentOriginal.replace(componentNeedle, '        life rehydrated HMR fixture\n') +
            componentBoundaryTail,
        ),
      )
      await waitUntil(
        async () => (await brandText()).includes('rehydrated HMR fixture'),
        'normal component HMR resumes after the native reload',
      )
      const freshAfterComponent = await marker()
      assert.equal(
        freshAfterComponent.document.id,
        freshBeforeComponent.document.id,
        'Resumed component HMR does not reload the fresh document',
      )
      assert.equal(
        freshAfterComponent.react.id,
        freshBeforeComponent.react.id,
        'Resumed component HMR preserves fresh React state',
      )
      assert.equal(
        freshAfterComponent.module.evaluations,
        1,
        'Resumed component HMR keeps the fresh ownership registry',
      )
      assert.equal(
        freshAfterComponent.appModule.evaluations,
        1,
        'Resumed component HMR does not reevaluate the fresh App module',
      )
      await flush()
      const afterRehydratedComponent = await observe('afterRehydratedComponentEdit')
      assert.equal(afterRehydratedComponent.archivePreserved, true)
      assert.equal(afterRehydratedComponent.draft, exactDraft)
      check(
        'Ordinary component HMR resumes in the fresh document with exact draft and opaque provenance preserved',
      )
    }
    phase = 'real thread edit and recovery export exercise the new registry after hydration'
    const row = () => page.locator('[data-thread-row]').filter({ hasText: title })
    await row().click({ button: 'right' })
    await page.getByRole('menuitem', { name: 'Rename thread', exact: true }).click()
    const renameDialog = page.getByRole('dialog', { name: 'Rename thread', exact: true })
    await renameDialog
      .getByRole('textbox', { name: 'Thread title', exact: true })
      .fill(`${title} renamed`)
    await renameDialog.getByRole('button', { name: 'Save title', exact: true }).click()
    await flush()
    const renamed = await currentThread()
    assert.equal(renamed.title, `${title} renamed`)
    const afterRename = await observe('afterRename')
    await page
      .locator('[data-thread-row]')
      .filter({ hasText: `${title} renamed` })
      .click({ button: 'right' })
    const nativeExportPath = join(artifacts, 'recovery-export-native.json')
    await rm(nativeExportPath, { force: true })
    await application.evaluate(({ BrowserWindow }, file) => {
      globalThis.__lifeOwnershipDownload = undefined
      BrowserWindow.getAllWindows()[0].webContents.session.once('will-download', (_event, item) => {
        globalThis.__lifeOwnershipDownload = { filename: item.getFilename(), state: 'started' }
        item.setSavePath(file)
        item.once('done', (_done, state) => {
          globalThis.__lifeOwnershipDownload.state = state
        })
      })
    }, nativeExportPath)
    await page.getByRole('menuitem', { name: 'Export recovery JSON', exact: true }).click()
    await waitUntil(
      async () =>
        (await application.evaluate(() => globalThis.__lifeOwnershipDownload))?.state ===
        'completed',
      'the genuine Electron recovery download completes',
    )
    assert.equal(
      (await application.evaluate(() => globalThis.__lifeOwnershipDownload)).filename,
      'life-thread-recovery.json',
    )
    const exported = JSON.parse(await readFile(nativeExportPath, 'utf8'))
    await writeFile(
      join(artifacts, 'recovery-export.json'),
      JSON.stringify(exported, null, 2) + '\n',
    )
    assert.equal(exported.threads.length, 1)
    proof.exportObservation = {
      archive: protectedArchive(exported.threads[0]),
      archiveHash: jsonHash(protectedArchive(exported.threads[0])),
      expectedArchiveHash: jsonHash(protectedSeed),
      matchesDurableRawThread: isDeepStrictEqual(exported.threads[0], renamed),
      filename: 'life-thread-recovery.json',
    }
    proof.exportObservation.archivePreserved =
      proof.exportObservation.archiveHash === proof.exportObservation.expectedArchiveHash
    proof.provenanceLossObserved =
      !proof.exportObservation.archivePreserved ||
      Object.values(proof.observations).some((value) => !value.archivePreserved)
    proof.activeControlLossObserved = proof.activeObservationLabels.some(
      (label) => !proof.observations[label].stopVisible,
    )
    if (policy === 'guarded') {
      assert.equal(
        proof.exportObservation.matchesDurableRawThread,
        true,
        'Actual recovery download contains the exact durable raw thread',
      )
      assert.equal(
        afterRename.archivePreserved,
        true,
        'A genuine edit after fresh hydration preserves every original raw occurrence',
      )
      assert.deepEqual(protectedArchive(exported.threads[0]), protectedSeed)
      assert.equal(proof.provenanceLossObserved, false)
      assert.equal(proof.activeControlLossObserved, false)
    } else if (expectSourceLoss) {
      assert.equal(
        proof.provenanceLossObserved,
        true,
        'The ordinary-HMR baseline reproduces actual archive provenance loss',
      )
      assert.equal(
        proof.activeControlLossObserved,
        true,
        'The ordinary-HMR baseline also reproduces loss of the active UI Stop',
      )
    }
    check(
      policy === 'guarded'
        ? 'Fresh owned hydration, a real rename and native recovery export retain the exact opaque archive and provider owner'
        : `Ordinary-HMR provenance loss observed: ${proof.provenanceLossObserved}`,
    )
    const finalTurns = primaryTurns(await fixture.log())
    assert.equal(finalTurns.length, 2)
    assert.equal(
      finalTurns[0].message.params.input.find((value) => value.type === 'text').text,
      exactPrompt,
    )
    assert.equal(
      finalTurns[1].message.params.input.find((value) => value.type === 'text').text,
      'hang',
    )
    const interruptions = (await fixture.log()).filter(
      (entry) => entry.message?.method === 'turn/interrupt',
    )
    assert.equal(interruptions.length, 1, 'Only one real native interruption is sent')
    assert.equal(
      interruptions[0].message.params.threadId,
      raw.remoteId,
      'The interruption belongs to the original native session',
    )
    assert.equal(
      interruptions[0].message.params.turnId,
      baseline.nativeHeartbeats.at(-1).turnId,
      'The interruption targets the exact same native hanging turn',
    )
    proof.providerRequests = {
      primaryTurnStarts: finalTurns.length,
      interrupts: interruptions.length,
      interruptions: interruptions.map((entry) => ({
        threadId: entry.message.params.threadId,
        turnId: entry.message.params.turnId,
      })),
      standbyMetadataTurnsExcluded: (await fixture.log()).filter(
        (entry) => entry.kind === 'title-metadata' && entry.message?.method === 'turn/start',
      ).length,
    }
    assert.deepEqual(proof.errors, [], 'No renderer exception occurred')
    await page.screenshot({ path: join(artifacts, 'fresh-recovery.png') })
    if (signalFailure) throw signalFailure
    proof.ok = true
  } catch (error) {
    failure = error
    proof.failure = { phase, message: String(error), stack: error.stack }
    if (page) {
      await writeFile(join(artifacts, 'failure.html'), await page.content().catch(() => ''))
      await page.screenshot({ path: join(artifacts, 'failure.png') }).catch(() => {})
    }
  } finally {
    phase = 'close owned resources and restore exact disposable source bytes'
    clearInterval(progress)
    for (const [label, close] of [
      ['CDP observer', () => cdp?.detach()],
      ['electron', () => application?.close()],
      ['vite', () => server?.close()],
      ['ssh', () => fixture?.close()],
    ]) {
      try {
        await close()
      } catch (error) {
        failure ||= error
        proof.ok = false
        proof.errors.push(`${label} cleanup: ${String(error)}`)
      }
    }
    try {
      await restore()
      for (let index = 0; index < files.length; index++)
        proof.source[index].restoredSha256 = hash(await readFile(files[index].path))
      proof.outputGraph = await graph(appRoot)
      assert.deepEqual(
        proof.outputGraph,
        proof.inputGraph,
        'The tested application source/build graph was never edited',
      )
      proof.sourceGraphUnchanged = true
    } catch (error) {
      failure ||= error
      proof.ok = false
      proof.restoreFailure = String(error)
    }
    if (!failure) await rm(directory, { recursive: true, force: true })
    else proof.retainedDisposableDirectory = directory
    await writeFile(join(artifacts, 'proof.json'), JSON.stringify(proof, null, 2) + '\n')
  }
  if (failure) throw failure
  console.log(
    JSON.stringify({
      ok: proof.ok,
      policy,
      checks: proof.checks.length,
      provenanceLossObserved: proof.provenanceLossObserved,
      sourceGraphUnchanged: proof.sourceGraphUnchanged,
      activeControlLossObserved: proof.activeControlLossObserved,
      proof: join(artifacts, 'proof.json'),
    }),
  )
}

run().catch((error) => {
  console.error(error)
  process.exitCode = 1
})
