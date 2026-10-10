#!/usr/bin/env node
/*
 * Native Electron smoke coverage; no provider accounts or inference are used.
 * Run after npm run build. Built source is the default; LIFE_ELECTRON_BINARY selects
 * an unpacked packaged app, or LIFE_TEST_SOURCE=0 chooses an existing Linux package.
 * LIFE_TEST_PACKAGED=1 selects that package; LIFE_TEST_TAILWIND=1 also checks its
 * optional npm-installed Tailwind compiler and its isolated native child process.
 * LIFE_TEST_ARTIFACTS_DIR and LIFE_TEST_SCREENSHOTS_DIR isolate parallel run outputs.
 * Linux uses xvfb-run automatically when DISPLAY is absent. Linux --no-sandbox
 * is confined to this test launcher; application webPreferences remain sandboxed.
 */
const assert = require('node:assert/strict')
const { existsSync } = require('node:fs')
const { mkdtemp, mkdir, readFile, readdir, rm, writeFile } = require('node:fs/promises')
const { dirname, join, resolve } = require('node:path')
const { createHash } = require('node:crypto')
const { tmpdir } = require('node:os')
const { createServer } = require('node:http')
const { spawn, spawnSync } = require('node:child_process')
const { _electron: electron } = require('playwright')
const { build } = require('esbuild')

const repository = resolve(__dirname, '..')
const artifacts = resolve(repository, process.env.LIFE_TEST_ARTIFACTS_DIR || 'output/playwright')
const screenshots = resolve(repository, process.env.LIFE_TEST_SCREENSHOTS_DIR || 'docs/images')

if (process.platform === 'linux' && !process.env.DISPLAY) {
  const probe = spawnSync('xvfb-run', ['--help'], { stdio: 'ignore' })
  if (probe.status !== 0)
    throw new Error('Native desktop tests require DISPLAY or xvfb-run on Linux.')
  const child = spawnSync(
    'xvfb-run',
    ['-a', '-s', '-screen 0 1920x1200x24', process.execPath, __filename],
    {
      cwd: repository,
      env: process.env,
      stdio: 'inherit',
    },
  )
  process.exit(child.status ?? 1)
}

async function waitUntil(predicate, description, timeout = 15000) {
  const deadline = Date.now() + timeout
  while (Date.now() < deadline) {
    if (await predicate()) return
    await new Promise((resolveDelay) => setTimeout(resolveDelay, 40))
  }
  throw new Error(`Timed out waiting for ${description}`)
}

async function run() {
  const metadata = JSON.parse(await readFile(join(repository, 'package.json'), 'utf8'))
  assert.ok(
    existsSync(join(repository, 'out/main/index.js')),
    'Run npm run build before the desktop smoke test.',
  )
  await Promise.all([
    mkdir(artifacts, { recursive: true }),
    mkdir(screenshots, { recursive: true }),
  ])
  const bundledFixture = join(artifacts, 'desktop-ssh-fixture.cjs')
  await build({
    entryPoints: [join(repository, 'tests/helpers/ssh-fixture.ts')],
    outfile: bundledFixture,
    bundle: true,
    platform: 'node',
    format: 'cjs',
    packages: 'external',
  })
  const { SSHFixture } = require(bundledFixture)
  const configurationRoot = await mkdtemp(join(tmpdir(), 'life-desktop-smoke-'))
  const fixture = await new SSHFixture(join(repository, 'tests/fixtures/fake-provider.cjs')).start()
  const activityBase = `export interface ThreadActivity {
  id: string
  kind: 'message' | 'tool' | 'reasoning'
  role?: 'user' | 'assistant'
  settled: boolean
  text: string
}

export interface ThreadReview {
  activities: ThreadActivity[]
  pending: boolean
}

/** Keep useful activity visible while a test workspace turn settles. */
export function visibleActivities(review: ThreadReview): ThreadActivity[] {
  return review.activities.filter((activity) => {
    if (activity.kind === 'tool') return true
    return !activity.settled
  })
}

export function activityLabel(activity: ThreadActivity): string {
  if (activity.kind === 'tool') return 'Tool work'
  if (activity.kind === 'reasoning') return 'Reasoning'
  return activity.role === 'assistant' ? 'Response' : 'Request'
}
`
  const activityReviewed = activityBase.replace(
    `  return review.activities.filter((activity) => {
    if (activity.kind === 'tool') return true
    return !activity.settled
  })`,
    `  const firstResponse = review.activities.findIndex(
    (activity) => activity.kind === 'message' && activity.role === 'assistant',
  )
  const lastResponse = review.activities.reduce((last, activity, index) => {
    if (activity.kind === 'message' && activity.role === 'assistant') return index
    return last
  }, -1)

  return review.activities.filter((activity, index) => {
    if (activity.kind === 'tool') return true
    if (index === firstResponse || index === lastResponse) return true
    if (activity.kind === 'reasoning') return review.pending
    return !activity.settled
  })`,
  )
  await writeFile(join(fixture.workspace, 'src/thread-activity.ts'), activityBase)
  const fixtureGit = (...args) => {
    const result = spawnSync('git', args, {
      cwd: fixture.workspace,
      encoding: 'utf8',
    })
    assert.equal(result.status, 0, `Fixture git ${args[0]} failed: ${result.stderr}`)
    return result.stdout
  }
  fixtureGit('init', '--quiet')
  await writeFile(
    join(fixture.workspace, '.gitignore'),
    'node_modules/\nbinary.dat\nlarge.txt\nescape-link\n',
  )
  fixtureGit('add', 'README.md', 'src/index.ts', 'src/thread-activity.ts', '.gitignore')
  fixtureGit(
    '-c',
    'user.name=Life desktop fixture',
    '-c',
    'user.email=life-fixture@example.invalid',
    'commit',
    '--quiet',
    '-m',
    'Create native SSH diff fixture',
  )
  const remoteService = createServer((request, response) => {
    response.writeHead(200, { 'Content-Type': 'application/json', Connection: 'close' })
    response.end(JSON.stringify({ service: 'Life SSH forwarding fixture', path: request.url }))
  })
  await new Promise((resolveListening, rejectListening) => {
    remoteService.once('error', rejectListening)
    remoteService.listen(0, '127.0.0.1', resolveListening)
  })
  const remoteServicePort = remoteService.address().port
  fixture.discoveryPorts = [remoteServicePort]
  fixture.allowedForwardPorts.add(remoteServicePort)
  const input = fixture.input()
  const packagedBinary =
    process.platform === 'linux'
      ? join(
          repository,
          'release/linux-unpacked',
          metadata.build?.linux?.executableName || metadata.name,
        )
      : undefined
  const selectedBinary =
    process.env.LIFE_ELECTRON_BINARY ||
    ((process.env.LIFE_TEST_SOURCE === '0' || process.env.LIFE_TEST_PACKAGED === '1') &&
    packagedBinary &&
    existsSync(packagedBinary)
      ? packagedBinary
      : undefined)
  const executablePath = selectedBinary || require('electron')
  const smokeLaunchArgs = [
    ...(selectedBinary ? [] : [repository]),
    ...(process.platform === 'linux' ? ['--no-sandbox'] : []),
    '--disable-dev-shm-usage',
  ]
  const rendererErrors = []
  const rendererErrorDetails = []
  const priorRendererEvents = []
  const nativeLogs = []
  const attachmentDirectories = new Set()
  let application
  let page
  let phase = 'launch'
  let failed = false
  const progressTimer = setInterval(() => console.log(`Desktop smoke phase: ${phase}`), 30000)

  const launch = async () => {
    application = await electron.launch({
      executablePath,
      args: smokeLaunchArgs,
      cwd: repository,
      env: {
        ...process.env,
        XDG_CONFIG_HOME: configurationRoot,
        ...(process.platform === 'win32' ? { APPDATA: configurationRoot } : {}),
      },
      timeout: 30000,
    })
    for (const [stream, output] of [
      ['stdout', application.process().stdout],
      ['stderr', application.process().stderr],
    ])
      output?.on('data', (chunk) => {
        nativeLogs.push({ stream, text: String(chunk).slice(-16000) })
        while (nativeLogs.reduce((size, entry) => size + entry.text.length, 0) > 64000)
          nativeLogs.shift()
      })
    page = await application.firstWindow()
    page.setDefaultTimeout(15000)
    page.on('pageerror', (error) => {
      rendererErrors.push(error.message)
      rendererErrorDetails.push({ message: error.message, stack: error.stack })
    })
    await application.evaluate(({ BrowserWindow }) =>
      BrowserWindow.getAllWindows()[0].setBounds({ width: 1440, height: 960 }),
    )
    await page.locator('.app-shell').waitFor()
    const userData = await application.evaluate(({ app }) => app.getPath('userData'))
    assert.ok(
      userData.startsWith(configurationRoot),
      `Refusing to test against non-isolated configuration: ${userData}`,
    )
    assert.equal(await page.evaluate(() => typeof window.relay), 'object')
    assert.equal(await page.evaluate(() => typeof window.require), 'undefined')
    assert.equal(await application.evaluate(({ app }) => app.getVersion()), metadata.version)
    const nativeEnvironment = await application.evaluate(() => ({
      pid: process.pid,
      display: process.env.DISPLAY,
      xauthority: process.env.XAUTHORITY,
    }))
    await writeFile(
      join(artifacts, 'desktop-native-launch-proof.json'),
      JSON.stringify(
        {
          version: metadata.version,
          packaged: Boolean(selectedBinary),
          testPid: process.pid,
          testDisplay: process.env.DISPLAY,
          nativeEnvironment,
        },
        null,
        2,
      ),
    )
    await application.evaluate(({ app, BrowserWindow }) => {
      const events = []
      const windows = []
      globalThis.__lifeRendererProof = { events, windows, expected: false }
      const observe = (window) => {
        windows.push({ type: 'created', id: window.id })
        window.webContents.on('did-finish-load', () => {
          windows.push({ type: 'loaded', id: window.id })
        })
        window.webContents.on('did-fail-load', (_event, code, description) => {
          windows.push({ type: 'load-failed', id: window.id, code, description })
        })
        window.on('closed', () => windows.push({ type: 'closed', id: window.id }))
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
    const isolation = await application.evaluate(({ BrowserWindow }) =>
      BrowserWindow.getAllWindows()[0].webContents.getLastWebPreferences(),
    )
    assert.equal(isolation.contextIsolation, true)
    assert.equal(isolation.nodeIntegration, false)
    assert.equal(isolation.sandbox, true)
  }
  const navigation = () => page.getByRole('navigation', { name: 'Workspace views' })
  const map = async () => {
    const labels = (await configuration()).config.labels
    const name = labels.researchTitle === 'Research map' ? 'Map' : labels.researchTitle
    await navigation().getByRole('button', { name, exact: true }).click()
  }
  const workspace = async () => {
    const customization = page.getByRole('dialog', { name: 'Customize Life', exact: true })
    if (await customization.isVisible())
      await customization.getByRole('button', { name: 'Close dialog', exact: true }).click()
    const labels = (await configuration()).config.labels
    const name = labels.workspaceTitle === 'Agent workspace' ? 'Agents' : labels.workspaceTitle
    await navigation().getByRole('button', { name, exact: true }).click()
  }
  const surface = async (name) => {
    const expand = page.getByRole('button', { name: 'Expand workspace sidebar', exact: true })
    if (await expand.isVisible()) await expand.click()
    const tab = page.locator('.surface-tabs').getByRole('tab', { name, exact: true })
    if (await tab.count()) {
      await tab.click()
      return
    }
    const picker = page.locator('.surface-picker')
    if (!(await picker.isVisible()))
      await page.getByRole('button', { name: 'Open a surface', exact: true }).click()
    await picker.getByRole('button', { name: new RegExp(`^${name}(?:\\s|$)`) }).click()
    await tab.waitFor()
  }
  const filesPanel = () => surface('Files')
  const selectModel = async (provider, id) => {
    const names = {
      codex: { '': 'Codex default', 'fixture-model': 'Fixture Codex' },
      claude: {
        '': 'Claude default',
        default: 'Default',
        opus: 'Opus',
        sonnet: 'Sonnet',
        haiku: 'Haiku',
      },
    }
    await page.getByRole('combobox', { name: /^Model:/ }).click()
    const option = page
      .locator('.reference-select-content')
      .getByRole('option', { name: names[provider][id] || id, exact: true })
    await option.waitFor()
    await option.click()
  }
  const runMenu = () => page.locator('.reference-run-menu[role="menu"]')
  const selectRunChoice = async (kind, value) => {
    await page.getByRole('button', { name: /^Reasoning:/ }).click()
    const labels = {
      low: 'Low',
      high: 'High',
      max: 'Max',
      xhigh: 'Extra high',
      fast: 'Fast',
      default: 'Standard',
      '': 'Default',
    }
    await runMenu()
      .getByRole('group')
      .nth(kind === 'effort' ? 0 : 1)
      .getByRole('menuitemradio', { name: labels[value] || value, exact: true })
      .click()
  }
  const selectPermission = async (value) => {
    const labels = {
      review: 'Manual',
      edit: 'Accept edits',
      'ask-for-approval': 'Ask for approval',
      'read-only': 'Read-only',
      'auto-review': 'Approve for me',
      'full-access': 'Full access',
      auto: 'Auto',
      dontAsk: "Don't ask",
    }
    await page.getByRole('combobox', { name: /^Agent permission mode:/ }).click()
    await page
      .locator('.reference-permission-menu')
      .getByRole('option', { name: new RegExp(`^${labels[value]}(?:[.\\s]|$)`) })
      .click()
  }
  const runControlSnapshot = () =>
    page
      .locator('.reference-run-controls')
      .evaluate((element) =>
        Array.from(element.querySelectorAll('[role="combobox"], button[aria-haspopup="menu"]')).map(
          (control) => ({ tag: control.tagName, label: control.getAttribute('aria-label') }),
        ),
      )
  const configuration = () => page.evaluate(() => window.relay.customization.get())
  const openSettings = async () => {
    await page.getByRole('button', { name: 'Settings', exact: true }).first().click()
    const dialog = page.getByRole('dialog', { name: 'Settings', exact: true })
    await dialog.waitFor()
    return dialog
  }
  const closeDialog = () => page.keyboard.press('Escape')
  const saveNativeDownload = async (button, path) => {
    await rm(path, { force: true })
    await application.evaluate(({ BrowserWindow }, file) => {
      globalThis.__lifeBackupDownload = undefined
      BrowserWindow.getAllWindows()[0].webContents.session.once('will-download', (_event, item) => {
        globalThis.__lifeBackupDownload = { filename: item.getFilename(), state: 'started' }
        item.setSavePath(file)
        item.once('done', (_done, state) => {
          globalThis.__lifeBackupDownload.state = state
        })
      })
    }, path)
    await button.click()
    await waitUntil(
      async () =>
        (await application.evaluate(() => globalThis.__lifeBackupDownload))?.state === 'completed',
      'native extension backup download completes',
    )
    return JSON.parse(await readFile(path, 'utf8'))
  }
  const waitForGraph = async () => {
    await page.locator('.research-graph-svg svg g.node').first().waitFor()
    await page.locator('.research-rendering').waitFor({ state: 'hidden' })
  }
  const waitForDiagram = () => page.locator('.custom-panel-diagram svg').first().waitFor()
  const screenshot = async (filename) => {
    await page
      .locator('.toast')
      .waitFor({ state: 'hidden', timeout: 6000 })
      .catch(() => {})
    await page.screenshot({ path: join(screenshots, filename) })
  }
  const composer = () =>
    page.getByRole('textbox', {
      name: /^(?:Message your coding agent|Message (?:Codex|Claude Code) about )/,
    })
  const send = async (prompt) => {
    await composer().fill(prompt)
    await page.getByRole('button', { name: 'Send message', exact: true }).click()
  }
  const waitForSend = () =>
    page.getByRole('button', { name: 'Send message', exact: true }).waitFor()
  const chooseProject = async ({
    reopen = false,
    browse = false,
    path = input.workspace,
    previousWorkspace,
  } = {}) => {
    if (reopen) await page.getByRole('button', { name: 'Add project', exact: true }).click()
    const picker = page.getByRole('dialog', { name: 'Select a project', exact: true })
    await picker.waitFor()
    assert.equal(
      (await page.evaluate(() => window.relay.connection.state())).workspace,
      previousWorkspace,
    )
    if (browse) {
      await picker
        .getByRole('button', { name: "Open folder workspace's project", exact: true })
        .waitFor()
      assert.equal(
        await picker.locator('.remote-directories header span').getAttribute('title'),
        fixture.root,
      )
      await picker.getByRole('button', { name: 'Refresh remote folders', exact: true }).click()
      await picker
        .getByRole('button', { name: "Open folder workspace's project", exact: true })
        .click()
      await picker.getByRole('button', { name: 'Open folder src', exact: true }).waitFor()
      await picker.getByRole('button', { name: 'Parent folder', exact: true }).click()
      await picker
        .getByRole('button', { name: "Open folder workspace's project", exact: true })
        .waitFor()
      await picker.getByRole('button', { name: 'Remote home folder', exact: true }).click()
      await picker
        .getByRole('button', { name: "Open folder workspace's project", exact: true })
        .click()
      await picker.getByRole('button', { name: 'Open folder src', exact: true }).waitFor()
      assert.equal(
        await picker.getByRole('textbox', { name: 'Project directory', exact: true }).inputValue(),
        input.workspace,
      )
      await screenshot('life-project-picker.png')
    } else {
      await picker.getByRole('textbox', { name: 'Project directory', exact: true }).fill(path)
    }
    await picker.getByRole('button', { name: 'Open project', exact: true }).click()
    await picker.waitFor({ state: 'hidden' })
    await waitUntil(
      async () => (await page.evaluate(() => window.relay.connection.state())).workspace === path,
      'remote project selected after machine connection',
    )
  }
  const extensions = () => page.evaluate(() => window.relay.extensions.get())
  const sourceCode = () => page.evaluate(() => window.relay.sourceCode.get())
  const openSourceCode = async () => {
    await openStudio()
    await page.getByRole('button', { name: 'Details', exact: true }).click()
    await page.getByRole('button', { name: 'Inspect Life source', exact: true }).click()
    const manager = page.getByRole('dialog', { name: 'Life source', exact: true })
    await manager.waitFor()
    return manager
  }
  const extensionFrame = () => page.frameLocator('iframe[title="Research tools"]')
  const openExtensions = async () => {
    await openStudio()
    await page.getByRole('button', { name: 'Details', exact: true }).click()
    await page.getByRole('button', { name: 'Manage and share extensions', exact: true }).click()
    const manager = page.getByRole('dialog', { name: 'Manage extensions', exact: true })
    await manager.waitFor()
    assert.equal(await manager.getByRole('tab', { name: 'Prompt', exact: true }).count(), 0)
    assert.equal(
      await manager.getByRole('button', { name: 'Build & apply', exact: true }).count(),
      0,
    )
    return manager
  }
  const applyExtensionSource = async (manifest) => {
    const manager = await openExtensions()
    await manager.getByRole('tab', { name: 'Source', exact: true }).click()
    await manager
      .getByRole('textbox', { name: 'Extension manifest' })
      .fill(JSON.stringify(manifest))
    await manager.getByRole('button', { name: 'Apply source', exact: true }).click()
    await waitUntil(
      async () =>
        (await extensions()).extensions.some(
          (extension) => extension.id === manifest.id && extension.version === manifest.version,
        ),
      `installed extension ${manifest.version}`,
    )
    assert.deepEqual((await extensions()).errors, {})
    await manager.locator('.form-success').waitFor()
    await closeDialog()
  }

  const checks = []
  const readThreads = () =>
    page.evaluate(() => JSON.parse(localStorage.getItem('relay.threads.v1') || '[]'))
  const promptFrom = (entry) => {
    if (entry.kind === 'title-metadata') return undefined
    return entry.message?.method === 'turn/start' || entry.message?.method === 'turn/steer'
      ? entry.message.params.input?.find((input) => input.type === 'text')?.text
      : entry.message?.type === 'user'
        ? entry.message.message.content?.find((input) => input.type === 'text')?.text
        : undefined
  }
  const promptsSince = async (index, provider) =>
    (await fixture.log())
      .slice(index)
      .filter((entry) => !provider || entry.provider === provider)
      .map(promptFrom)
      .filter((prompt) => typeof prompt === 'string')
  const ordinaryThread = async (prompt, provider) => {
    const find = async () =>
      (await readThreads()).find(
        (thread) =>
          thread.provider === provider &&
          thread.messages.some((message) => message.role === 'user' && message.text === prompt),
      )
    await waitUntil(
      async () => Boolean(await find()),
      `${provider} conversation history persists the exact user message`,
    )
    return find()
  }
  const newThread = async (provider) => {
    await workspace()
    await page.getByRole('button', { name: 'New thread', exact: true }).click()
    await selectModel(provider, '')
    await page.getByRole('region', { name: 'New thread', exact: true }).waitFor()
  }
  const openStudio = async () => {
    const dialog = page.getByRole('dialog', { name: 'Customize Life', exact: true })
    if (!(await dialog.isVisible()))
      await page.getByRole('button', { name: 'Customize', exact: true }).click()
    await page.getByRole('region', { name: 'Life Customization Studio', exact: true }).waitFor()
  }
  const sendStudio = async (request) => {
    await page
      .getByRole('textbox', { name: 'Describe a Life customization', exact: true })
      .fill(request)
    await page.getByRole('button', { name: 'Send customization request', exact: true }).click()
  }
  const reconnect = async () => {
    if ((await page.evaluate(() => window.relay.connection.state())).status === 'connected') return
    let dialog = page.getByRole('dialog', { name: 'Connect a machine', exact: true })
    if (!(await dialog.isVisible())) {
      await page.getByRole('button', { name: 'Connections', exact: true }).click()
      await dialog.waitFor()
    }
    const profiles = await page.evaluate(() => window.relay.profiles.list())
    const profile = profiles.find(
      (profile) => profile.host === input.host && profile.port === input.port,
    )
    assert.ok(profile, 'Saved fixture profile exists for password reconnect')
    const profileRow = dialog.locator('.saved-profile').filter({ hasText: profile.name })
    if (await profileRow.count()) await profileRow.getByRole('button').first().click()
    await dialog.getByPlaceholder('Your SSH password').fill(input.password)
    await dialog.getByRole('button', { name: 'Connect machine', exact: true }).click()
    await dialog.waitFor({ state: 'hidden' })
    await waitUntil(
      async () =>
        (await page.evaluate(() => window.relay.connection.state())).status === 'connected',
      'saved machine reconnect',
    )
    const picker = page.getByRole('dialog', { name: 'Select a project', exact: true })
    if (await picker.isVisible())
      await picker.getByRole('button', { name: 'Choose later', exact: true }).click()
  }
  const context = {
    getPage: () => page,
    setPage: (replacement) => {
      page = replacement
      page.setDefaultTimeout(15000)
      page.on('pageerror', (error) => {
        rendererErrors.push(error.message)
        rendererErrorDetails.push({ message: error.message, stack: error.stack })
      })
    },
    getApplication: () => application,
    fixture,
    artifacts,
    screenshots,
    checks,
    rendererErrors,
    input,
    waitUntil,
    send,
    composer,
    waitForSend,
    openStudio,
    sendStudio,
    workspace,
    surface,
    map,
    selectModel,
    selectRunChoice,
    selectPermission,
    chooseProject,
    newThread,
    sourceCode,
    extensions,
    configuration,
    openExtensions,
    openSourceCode,
    openSettings,
    closeDialog,
    screenshot,
    saveNativeDownload,
    applyExtensionSource,
    launch,
    reconnect,
    promptFrom,
    promptsSince,
    readThreads,
    ordinaryThread,
  }

  try {
    await launch()
    phase = 'native update preference and preload acknowledgement'
    const initialUpdates = await page.evaluate(() => window.relay.updates.get())
    assert.equal(initialUpdates.currentVersion, metadata.version)
    assert.equal(initialUpdates.autoDownload, true)
    assert.equal(
      (await page.evaluate(() => window.relay.updates.setAutoDownload(false))).autoDownload,
      false,
    )
    const updatePreferencesPath = join(
      await application.evaluate(({ app }) => app.getPath('userData')),
      'updates.json',
    )
    assert.deepEqual(JSON.parse(await readFile(updatePreferencesPath, 'utf8')), {
      version: 1,
      autoDownload: false,
    })
    checks.push('Native update download preference acknowledges only after its disk save')
    phase = 'new thread environment and platform window controls'
    assert.match(await page.title(), /^Life/)
    assert.equal(await page.evaluate(() => window.relay.platform), process.platform)
    await page.getByRole('region', { name: 'New thread', exact: true }).waitFor()
    await page.getByRole('heading', { name: 'Connect your environment', exact: true }).waitFor()
    const environmentButton = page.getByRole('button', { name: /^Current Active Environment/ })
    await environmentButton.click()
    await page
      .getByRole('dialog', { name: 'Current Active Environment', exact: true })
      .getByText('Disconnected', { exact: true })
      .waitFor()
    await page.keyboard.press('Escape')
    assert.equal((await configuration()).config.autoPortForward, true)
    assert.equal(await page.locator('html').getAttribute('data-theme'), 'dark')
    if (process.platform !== 'darwin') {
      assert.equal(await page.locator('.native-window-button').count(), 3)
      const controls = await page.locator('.native-window-button').evaluateAll((buttons) =>
        buttons.map((button) => ({
          radius: getComputedStyle(button).borderRadius,
          width: button.getBoundingClientRect().width,
        })),
      )
      assert.ok(controls.every((control) => control.radius === '0px' && control.width > 30))
      await application.evaluate(({ BrowserWindow }) => {
        const window = BrowserWindow.getAllWindows()[0]
        globalThis.__lifeSmokeActions = []
        for (const name of ['minimize', 'maximize', 'unmaximize']) {
          const native = window[name].bind(window)
          window[name] = () => {
            globalThis.__lifeSmokeActions.push(name)
            return native()
          }
        }
      })
      await page.getByRole('button', { name: 'Minimize window', exact: true }).click()
      await waitUntil(
        async () =>
          (await application.evaluate(() => globalThis.__lifeSmokeActions)).includes('minimize'),
        'native minimize',
      )
      await application.evaluate(({ BrowserWindow }) => {
        const window = BrowserWindow.getAllWindows()[0]
        window.restore()
        window.show()
      })
      await page.getByRole('button', { name: /^(Maximize|Restore) window$/ }).click()
      await waitUntil(
        async () =>
          (await application.evaluate(() => globalThis.__lifeSmokeActions)).some(
            (action) => action === 'maximize' || action === 'unmaximize',
          ),
        'native maximize',
      )
      await application.evaluate(({ BrowserWindow }) => {
        const window = BrowserWindow.getAllWindows()[0]
        window.unmaximize()
        window.setBounds({ width: 1440, height: 960 })
      })
    } else {
      assert.equal(await page.locator('.native-window-controls').count(), 0)
      await page.locator('.native-traffic-light-space').waitFor()
    }
    checks.push(
      'isolated native Electron sandbox and platform-specific window controls',
      'active project and current environment replace the empty thread greeting',
    )

    phase = 'OpenSSH config alias, host trust and post-connect project selection'
    const sshConfig = join(configurationRoot, 'ssh-test.config')
    await writeFile(
      sshConfig,
      [
        'Host life-fixture',
        `  HostName ${input.host}`,
        `  Port ${input.port}`,
        `  User ${input.username}`,
        '  IdentitiesOnly yes',
        '  ServerAliveInterval 7',
        '  Compression no',
        '',
      ].join('\n'),
    )
    await page.getByRole('button', { name: 'Connect environment', exact: true }).click()
    const connection = page.getByRole('dialog', { name: 'Connect a machine', exact: true })
    await connection.getByRole('textbox', { name: 'SSH config file path' }).fill(sshConfig)
    await connection.getByRole('button', { name: 'Reload SSH config', exact: true }).click()
    await waitUntil(
      async () => connection.getByRole('combobox', { name: 'SSH config host alias' }).isEnabled(),
      'SSH aliases parsed',
    )
    await connection
      .getByRole('combobox', { name: 'SSH config host alias' })
      .selectOption('life-fixture')
    await connection.locator('.ssh-config-options summary').click()
    assert.match(
      await connection.locator('.ssh-config-options pre').textContent(),
      /serveraliveinterval 7/,
    )
    assert.equal(await connection.getByPlaceholder('dev.example.com').inputValue(), input.host)
    await connection.getByPlaceholder('My development server').fill('Loopback test workspace')
    await connection.getByLabel('Authentication').selectOption('password')
    await connection.getByPlaceholder('Your SSH password').fill(input.password)
    assert.equal(
      await connection.getByRole('textbox', { name: 'Project directory', exact: true }).count(),
      0,
    )
    await connection.getByRole('button', { name: 'Connect machine', exact: true }).click()
    const trust = page.getByRole('dialog', { name: 'Trust this machine?', exact: true })
    await trust.waitFor()
    assert.match(await trust.locator('code').textContent(), /^SHA256:/)
    await trust.getByRole('button', { name: 'Trust and connect', exact: true }).click()
    await connection.waitFor({ state: 'hidden' })
    const initialPicker = page.getByRole('dialog', { name: 'Select a project', exact: true })
    await initialPicker.waitFor()
    const machineOnly = await page.evaluate(() => window.relay.connection.state())
    assert.equal(machineOnly.status, 'connected')
    assert.equal(machineOnly.workspace, undefined)
    assert.equal(machineOnly.home, fixture.root)
    await initialPicker.getByRole('button', { name: 'Choose later', exact: true }).click()
    const profiles = await page.evaluate(() => window.relay.profiles.list())
    assert.equal(profiles.length, 1)
    assert.equal(profiles[0].password, undefined)
    assert.equal(profiles[0].sshConfig.alias, 'life-fixture')
    checks.push(
      'OpenSSH config options, native host trust, password privacy and project selection after connection',
    )

    phase = 'Studio runs without selecting an Agents project'
    const studioOnlyBaseline = (await fixture.log()).length
    await openStudio()
    await sendStudio('explain customization')
    await waitUntil(
      async () =>
        page.evaluate(() =>
          JSON.parse(localStorage.getItem('life.studio.sessions.v1') || '[]').some(
            (session) =>
              session.stage === 'complete' &&
              !session.thread.busy &&
              session.thread.messages.some(
                (message) => message.role === 'user' && message.text === 'explain customization',
              ),
          ),
        ),
      'machine-only Studio request completes',
    )
    const machineStudio = (await fixture.log())
      .slice(studioOnlyBaseline)
      .find((entry) => entry.kind === 'studio-context')
    assert.equal(machineStudio.prompt, 'explain customization')
    assert.ok(machineStudio.cwd.startsWith(join(fixture.root, '.life', 'customization') + '/'))
    assert.equal((await page.evaluate(() => window.relay.connection.state())).workspace, undefined)
    assert.equal((await readThreads()).length, 0)
    await workspace()
    const studioReturnPicker = page.getByRole('dialog', { name: 'Select a project', exact: true })
    if (await studioReturnPicker.isVisible())
      await studioReturnPicker.getByRole('button', { name: 'Choose later', exact: true }).click()
    checks.push(
      'dedicated Studio runs through exact prompts and instruction files without choosing an Agents project',
    )

    phase = 'automatic port forwarding and persisted opt-out'
    const forwarding = () => page.evaluate(() => window.relay.forwarding.get())
    await page.getByRole('button', { name: /^Ports(?:\s|$)/ }).click()
    const ports = page.getByRole('dialog', { name: 'Port forwarding', exact: true })
    await ports.waitFor()
    const automatic = ports.getByRole('switch', { name: 'Automatic port forwarding', exact: true })
    assert.equal(await automatic.isChecked(), true)
    await waitUntil(
      async () => (await forwarding()).ports.some((port) => port.remotePort === remoteServicePort),
      'real SSH service forwarding',
    )
    const forwarded = (await forwarding()).ports.find(
      (port) => port.remotePort === remoteServicePort,
    )
    assert.notEqual(forwarded.localPort, remoteServicePort)
    assert.deepEqual(
      await (
        await fetch(`${forwarded.url}/desktop-smoke`, { signal: AbortSignal.timeout(5000) })
      ).json(),
      { service: 'Life SSH forwarding fixture', path: '/desktop-smoke' },
    )
    await automatic.click()
    await waitUntil(
      async () => !(await forwarding()).enabled && (await forwarding()).ports.length === 0,
      'forwarding opt-out closes tunnels',
    )
    assert.equal((await configuration()).config.autoPortForward, false)
    await assert.rejects(fetch(`${forwarded.url}/closed`, { signal: AbortSignal.timeout(3000) }))
    await automatic.click()
    await waitUntil(
      async () => (await forwarding()).enabled && (await forwarding()).ports.length > 0,
      'forwarding opt-in',
    )
    await closeDialog()
    checks.push('real SSH automatic port forwarding, collision handling and saved opt-out')

    phase = 'real SFTP project browsing, new thread destination, files and diff'
    await chooseProject({ reopen: true, browse: true })
    await page
      .getByRole('region', { name: 'New thread', exact: true })
      .getByRole('heading', { name: /^What do you want to do in workspace's project\s*\?$/ })
      .waitFor()
    assert.equal(
      await page.locator('.active-project-selector').textContent(),
      "workspace's project",
    )
    await environmentButton.click()
    await page.getByRole('dialog', { name: 'Current Active Environment', exact: true }).waitFor()
    assert.ok(
      (
        await page
          .getByRole('dialog', { name: 'Current Active Environment', exact: true })
          .textContent()
      ).includes(input.workspace),
    )
    await page.keyboard.press('Escape')
    await filesPanel()
    await page.getByRole('button', { name: 'src', exact: true }).click()
    await page.getByRole('button', { name: 'index.ts', exact: true }).click()
    await page
      .locator('.file-preview')
      .getByText('export const answer = 42', { exact: true })
      .waitFor()
    await page.getByRole('button', { name: 'Add to prompt', exact: true }).click()
    assert.match(await composer().inputValue(), /src\/index.ts/)
    await writeFile(
      join(fixture.workspace, 'src/index.ts'),
      "export const answer = 42\nexport const researchStatus = 'verified'\n",
    )
    await writeFile(join(fixture.workspace, 'src/thread-activity.ts'), activityReviewed)
    await writeFile(join(fixture.workspace, 'untracked-proof.txt'), 'Native SSH untracked file\n')
    await surface('Diff')
    await page.getByRole('button', { name: 'Refresh remote workspace', exact: true }).click()
    await page
      .locator('.workspace-diff-line.diff-added')
      .filter({ hasText: 'researchStatus' })
      .waitFor()
    assert.ok((await page.locator('.workspace-diff-hunk').first().textContent()).includes('@@'))
    assert.ok((await page.locator('.workspace-diff-line.diff-removed').count()) >= 1)
    await page.getByRole('button', { name: 'Collapse all diffs', exact: true }).click()
    assert.equal(await page.locator('.workspace-diff-line.diff-added').count(), 0)
    await page.getByRole('button', { name: 'Expand all diffs', exact: true }).click()
    await page
      .locator('.workspace-diff-line.diff-added')
      .filter({ hasText: 'researchStatus' })
      .waitFor()
    checks.push(
      'real SFTP browsing, project destination card, active environment details and unified Git diffs',
    )

    phase = 'real remote terminal input and resize'
    await page.evaluate(() => {
      globalThis.__lifeSmokeTerminal = ''
      globalThis.__lifeSmokeTerminalUnsubscribe = window.relay.onTerminal((data) => {
        globalThis.__lifeSmokeTerminal += data
      })
    })
    await surface('Terminal')
    await waitUntil(
      async () =>
        /bash-[\d.]+[#$] /.test(await page.evaluate(() => globalThis.__lifeSmokeTerminal)),
      'real remote shell ready',
    )
    await page.locator('.xterm-helper-textarea').focus()
    await page.keyboard.type('printf LIFE_DESKTOP_TERMINAL_OK')
    await page.keyboard.press('Enter')
    await waitUntil(
      async () =>
        (await page.evaluate(() => globalThis.__lifeSmokeTerminal)).includes(
          'LIFE_DESKTOP_TERMINAL_OK',
        ),
      'actual terminal keyboard input reaches remote shell',
    )
    assert.ok(fixture.ptys.length > 0)
    await page
      .locator('.terminal-panel')
      .getByRole('button', { name: 'Close terminal', exact: true })
      .click()
    await page.evaluate(() => globalThis.__lifeSmokeTerminalUnsubscribe())
    checks.push('native terminal keyboard input reaches the real SSH shell and closes cleanly')

    if (process.env.LIFE_TEST_PHASE !== 'features') {
      phase = 'provider approvals, questions and exact ordinary /life prompts'
      const exactPrompt =
        '/life this belongs to my project only\n  Preserve every space, "quote", $value and 🧪.\n'
      for (const provider of ['codex', 'claude']) {
        await newThread(provider)
        const initialConfig = await configuration()
        const initialSource = await sourceCode()
        const initialExtensions = await extensions()
        const baseline = (await fixture.log()).length
        await send(exactPrompt)
        await waitForSend()
        await waitUntil(
          async () => (await promptsSince(baseline, provider)).includes(exactPrompt),
          `${provider} receives exact ordinary /life user bytes`,
        )
        assert.deepEqual((await configuration()).config, initialConfig.config)
        assert.equal((await sourceCode()).revision, initialSource.revision)
        assert.equal((await extensions()).revision, initialExtensions.revision)
        const mainRequests = (await fixture.log())
          .slice(baseline)
          .filter((entry) => promptFrom(entry) === exactPrompt)
        assert.ok(mainRequests.length >= 1)
        assert.equal(mainRequests[0].cwd, input.workspace)
        await send('hello')
        await page
          .locator('.markdown')
          .getByText(`Hello from ${provider === 'codex' ? 'Codex' : 'Claude'} 👋`, { exact: true })
          .waitFor()
        await waitForSend()
        await send('approval')
        await page
          .locator('.approval-card')
          .getByText(provider === 'codex' ? 'Allow this command?' : 'Allow Bash?', { exact: true })
          .waitFor()
        await page.getByRole('button', { name: 'Allow once', exact: true }).click()
        await waitForSend()
        await send('question')
        await page
          .locator('.approval-card')
          .getByText('Your input is needed', { exact: true })
          .waitFor()
        await page
          .locator('.approval-card')
          .getByLabel('Which language?')
          .selectOption('TypeScript')
        await page.getByRole('button', { name: 'Send answers', exact: true }).click()
        await waitForSend()
        const markerConfig = await configuration()
        const markerSource = await sourceCode()
        const markerExtensions = await extensions()
        await send('remote-life-markers')
        await waitForSend()
        await page
          .locator('.markdown')
          .getByText('<life-customization>{"theme":"light"}</life-customization>', { exact: true })
          .waitFor()
        assert.deepEqual((await configuration()).config, markerConfig.config)
        assert.equal((await configuration()).revision, markerConfig.revision)
        assert.equal((await sourceCode()).revision, markerSource.revision)
        assert.equal((await extensions()).revision, markerExtensions.revision)
        await send('native-subagent-probe')
        await waitForSend()
        assert.equal(await page.locator('.thread-subagent-card').count(), 0)
        await waitUntil(async () => {
          const saved = await ordinaryThread(exactPrompt, provider)
          return (
            saved.messages.some(
              (message) =>
                message.kind === 'subagent' &&
                (message.agentId || message.agentName || message.parentItemId),
            ) &&
            JSON.stringify(saved.messages).includes(
              'Subagent inspected every visible output block.',
            )
          )
        }, `${provider} retains native subagent output arriving after parent completion`)
        const delegatedThread = await ordinaryThread(exactPrompt, provider)
        assert.ok(
          delegatedThread.messages.some(
            (message) =>
              message.kind === 'subagent' &&
              (message.agentId || message.agentName || message.parentItemId),
          ),
        )
        assert.ok(
          JSON.stringify(delegatedThread.messages).includes(
            'Subagent inspected every visible output block.',
          ),
          'The completed display retains the full subagent result in saved history',
        )
        await page.locator('.thread-work-summary').last().waitFor()
        const original = await ordinaryThread(exactPrompt, provider)
        assert.ok(original.remoteId)
        await waitUntil(
          async () => (await ordinaryThread(exactPrompt, provider))?.titleSource === 'provider',
          `${provider} generates the conversation title`,
          30000,
        )
        const titled = await ordinaryThread(exactPrompt, provider)
        assert.notEqual(titled.title, exactPrompt.split('\n')[0])
        assert.ok(titled.title.trim().length > 0)
        const titleLog = (await fixture.log())
          .slice(baseline)
          .filter((entry) => /[\/]\.life[\/]metadata[\/]title-/.test(entry.cwd || ''))
        assert.ok(
          titled.titleSource === 'provider',
          'The native provider title or an isolated metadata job supplies the title',
        )
        await writeFile(
          join(artifacts, `desktop-exact-prompt-${provider}-proof.json`),
          JSON.stringify(
            {
              provider,
              exactPrompt,
              remoteId: titled.remoteId,
              title: titled.title,
              originalCwd: mainRequests[0].cwd,
              titleJobCwd: titleLog[0]?.cwd || null,
              mainRequests: mainRequests.length,
            },
            null,
            2,
          ),
        )
        checks.push(
          `${provider} ordinary /life remains exact project text; approvals and questions; independent provider-generated title`,
        )
      }

      phase = 'project creation stress and automatic saved thread restoration'
      const original = await ordinaryThread(exactPrompt, 'claude')
      const otherProject = join(input.workspace, 'src')
      await chooseProject({ reopen: true, path: otherProject, previousWorkspace: input.workspace })
      await page.getByRole('region', { name: 'New thread', exact: true }).waitFor()
      await send('native-second-project thread')
      await waitForSend()
      const second = await ordinaryThread('native-second-project thread', 'claude')
      assert.equal(second.workspace, otherProject)
      const selectSidebarThread = async (thread) => {
        await workspace()
        const escapeRegex = (value) => value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
        const projectGroup = page.locator('.sidebar-project-thread-group').filter({
          has: page
            .locator('.sidebar-project-thread-description')
            .filter({ hasText: new RegExp(`${escapeRegex(thread.workspace)}$`) }),
        })
        const row = projectGroup
          .getByRole('button', {
            name: new RegExp(
              `^${escapeRegex(thread.title)}, ${thread.provider === 'claude' ? 'Claude Code' : 'OpenAI · Codex'},`,
            ),
          })
          .first()
        await row.click()
        await waitUntil(
          async () =>
            (await page.evaluate(() => window.relay.connection.state())).workspace ===
            thread.workspace,
          'thread restores its saved project',
        )
      }
      await selectSidebarThread(original)
      const restoreBaseline = (await fixture.log()).length
      for (let iteration = 0; iteration < 12; iteration++) {
        await chooseProject({
          reopen: true,
          path: otherProject,
          previousWorkspace: (await page.evaluate(() => window.relay.connection.state())).workspace,
        })
        await page.getByRole('region', { name: 'New thread', exact: true }).waitFor()
        assert.equal(await page.locator('.app-shell').count(), 1)
        await selectSidebarThread(second)
        await selectSidebarThread(original)
        assert.equal(
          (await readThreads()).find((thread) => thread.id === original.id).remoteId,
          original.remoteId,
        )
        assert.deepEqual(rendererErrors, [])
      }
      assert.equal(
        (await promptsSince(restoreBaseline)).length,
        0,
        'Project and thread selection never sends an agent message',
      )
      await selectSidebarThread(original)
      checks.push(
        '12 alternating project selections remain responsive; saved thread restores the correct project without extra prompts',
      )

      phase = 'native steering, completion-gated queues and live model settings'
      const queueProof = []
      for (const provider of ['codex', 'claude']) {
        await newThread(provider)
        await selectModel(provider, provider === 'codex' ? 'fixture-model' : 'opus')
        await selectRunChoice('effort', provider === 'codex' ? 'high' : 'max')
        await selectRunChoice('speed', 'fast')
        const baseline = (await fixture.log()).length
        await send('queue-delay')
        await page.getByRole('button', { name: 'Steer current response', exact: true }).waitFor()
        await composer().fill('native-queued-follow-up')
        await composer().press('Tab')
        const queued = page.getByRole('region', { name: 'Queued follow-up messages', exact: true })
        await queued.waitFor()
        await waitUntil(
          async () => (await promptsSince(baseline, provider)).includes('native-queued-follow-up'),
          `${provider} queued message follows genuine completed turn`,
        )
        await waitForSend()
        await queued.waitFor({ state: 'hidden' })
        const queueLog = (await fixture.log())
          .slice(baseline)
          .filter((entry) => entry.provider === provider)
        const completed = queueLog.findIndex(
          (entry) =>
            (entry.completionEvidence?.prompt ||
              (entry.kind === 'turn-completed' ? entry.prompt : undefined)) === 'queue-delay',
        )
        const followUp = queueLog.findIndex(
          (entry) => promptFrom(entry) === 'native-queued-follow-up',
        )
        assert.ok(
          completed >= 0 && followUp > completed,
          'Queue must wait for an authoritative completion, not a text delta or early result',
        )
        assert.equal(
          queueLog.filter((entry) => promptFrom(entry) === 'native-queued-follow-up').length,
          1,
        )
        await send('hang')
        await page.getByRole('button', { name: 'Steer current response', exact: true }).waitFor()
        const liveBaseline = (await fixture.log()).length
        await selectRunChoice('effort', provider === 'codex' ? 'low' : 'high')
        await selectRunChoice('speed', 'default')
        if (provider === 'claude') await selectModel(provider, 'sonnet')
        await waitUntil(
          async () =>
            (await fixture.log())
              .slice(liveBaseline)
              .some((entry) =>
                provider === 'codex'
                  ? entry.message?.method === 'turn/settings/update'
                  : entry.message?.type === 'control_request' &&
                    entry.message?.request?.subtype === 'apply_flag_settings',
              ),
          `${provider} applies settings to its running turn`,
        )
        const liveLog = (await fixture.log()).slice(liveBaseline)
        assert.equal(
          liveLog.filter(
            (entry) =>
              entry.message?.method === 'turn/interrupt' ||
              entry.message?.request?.subtype === 'interrupt',
          ).length,
          0,
          'Changing live choices must not stop the running turn',
        )
        await composer().fill('native-steer-follow-up')
        const steer = page.getByRole('button', { name: /Steer (?:the )?current (?:turn|response)/ })
        if (await steer.count()) await steer.click()
        else {
          await composer().press('Tab')
          await queued
            .getByRole('button', { name: /Steer (?:the )?current (?:turn|response)/ })
            .click()
        }
        await waitUntil(
          async () =>
            (await promptsSince(liveBaseline, provider)).includes('native-steer-follow-up'),
          `${provider} receives native steering input`,
        )
        const steeringLog = (await fixture.log()).slice(liveBaseline)
        const steering = steeringLog.find((entry) => promptFrom(entry) === 'native-steer-follow-up')
        if (provider === 'codex') {
          assert.equal(steering.message.method, 'turn/steer')
          assert.ok(steering.message.params.expectedTurnId)
        } else assert.equal(steering.message.priority, 'next')
        assert.equal(
          steeringLog.filter(
            (entry) =>
              entry.message?.method === 'turn/interrupt' ||
              entry.message?.request?.subtype === 'interrupt',
          ).length,
          0,
          'Steering updates the live conversation without replaying the user message',
        )
        await page
          .getByRole('button', { name: 'Stop agent and pause queued messages', exact: true })
          .click()
        await waitForSend()
        await send('hang')
        await page.getByRole('button', { name: 'Steer current response', exact: true }).waitFor()
        await composer().fill('native-paused-follow-up')
        await composer().press('Tab')
        await page
          .getByRole('button', { name: 'Stop agent and pause queued messages', exact: true })
          .click()
        await waitForSend()
        await queued.getByText('Paused', { exact: true }).waitFor()
        await waitUntil(
          async () =>
            (await readThreads()).some((thread) =>
              thread.queue?.some(
                (message) => message.text === 'native-paused-follow-up' && message.paused,
              ),
            ),
          'paused queue saved',
        )
        const pauseBaseline = (await fixture.log()).length
        await page.reload()
        await page.locator('.app-shell').waitFor()
        await queued.getByText('Paused', { exact: true }).waitFor()
        assert.equal(
          (await promptsSince(pauseBaseline, provider)).includes('native-paused-follow-up'),
          false,
        )
        await queued
          .getByRole('button', { name: 'Send this queued message now', exact: true })
          .click()
        await waitForSend()
        await queued.waitFor({ state: 'hidden' })
        await page.keyboard.press(process.platform === 'darwin' ? 'Meta+f' : 'Control+f')
        const finder = page.getByRole('dialog', { name: 'Find in this thread', exact: true })
        await finder.waitFor()
        await finder
          .getByLabel('Search messages in this thread', { exact: true })
          .fill('native-queued-follow-up')
        await finder
          .getByRole('button')
          .filter({ hasText: 'native-queued-follow-up' })
          .first()
          .click()
        await finder.waitFor({ state: 'hidden' })
        await page.locator('.message.user:focus').waitFor({ state: 'visible' })
        assert.equal(await page.locator('.message.user:focus').count(), 1)
        await page.getByRole('button', { name: /^Filters, sorting and arrangement/ }).click()
        const filters = page.getByRole('dialog', {
          name: 'Filters, sorting and arrangement',
          exact: true,
        })
        await filters.getByRole('combobox', { name: /^Agent(?:\s|$)/ }).selectOption(provider)
        await filters
          .getByRole('combobox', { name: /^Arrange by(?:\s|$)/ })
          .selectOption('provider')
        await filters.getByRole('combobox', { name: /^Sort by(?:\s|$)/ }).selectOption('title')
        await filters.getByRole('button', { name: 'Done', exact: true }).click()
        const expectedProvider = provider === 'codex' ? 'OpenAI · Codex' : 'Claude Code'
        const labels = await page
          .locator('.project-list .thread-row')
          .evaluateAll((rows) => rows.map((row) => row.getAttribute('aria-label')))
        assert.ok(labels.length > 0 && labels.every((label) => label.includes(expectedProvider)))
        await page.getByRole('button', { name: /^Filters, sorting and arrangement/ }).click()
        await filters.getByRole('button', { name: 'Reset', exact: true }).click()
        await filters.getByRole('button', { name: 'Done', exact: true }).click()
        checks.push(
          `${provider} thread search selects the complete message; sidebar provider filtering, arrangement and sorting remain functional`,
        )
        queueProof.push({
          provider,
          completedIndex: completed,
          followUpIndex: followUp,
          steeringMethod: steering.message.method || 'priority:next',
          liveControls: liveLog
            .map((entry) => entry.message?.method || entry.message?.request?.subtype)
            .filter(Boolean),
        })
        checks.push(
          `${provider} queues only after authoritative completion, steers natively, changes live settings without interruption and preserves paused queues`,
        )
      }
      await writeFile(
        join(artifacts, 'desktop-queue-live-settings-proof.json'),
        JSON.stringify(queueProof, null, 2),
      )

      phase = 'native attachments preserve prompt bytes and visible attachment information'
      for (const provider of ['codex', 'claude']) {
        await newThread(provider)
        const textReference = Buffer.from('Native Life reference data\n'.repeat(9000))
        const imageReference = Buffer.from(
          'iVBORw0KGgoAAAANSUhEUgAAAAQAAAAECAYAAACp8Z5+AAAAEklEQVQImWP4z8Dwn4GBgYGJAQoAQokH+fG8cXIAAAAASUVORK5CYII=',
          'base64',
        )
        await page.getByLabel('Choose images or files', { exact: true }).setInputFiles([
          { name: 'native-notes.txt', mimeType: 'text/plain', buffer: textReference },
          { name: 'native-reference.png', mimeType: 'image/png', buffer: imageReference },
        ])
        await waitUntil(
          async () =>
            (
              await page
                .locator('.draft-attachments .thread-attachment-open')
                .evaluateAll((buttons) => buttons.map((button) => button.title))
            ).filter((text) => text.includes('Uploaded · ready to send')).length === 2,
          'multi-part attachments uploaded',
        )
        const baseline = (await fixture.log()).length
        await send('native-attachment-probe')
        await waitForSend()
        const request = (await fixture.log())
          .slice(baseline)
          .find((entry) => promptFrom(entry) === 'native-attachment-probe')
        assert.ok(request, 'Attachments retain the exact prompt in a native text block')
        assert.equal(promptFrom(request), 'native-attachment-probe')
        const blocks = request.message.params?.input || request.message.message?.content
        if (provider === 'codex') assert.ok(blocks.some((block) => block.type === 'localImage'))
        else
          assert.ok(
            blocks.some((block) => block.type === 'image') &&
              blocks.some((block) => block.type === 'document'),
          )
        await page.locator('.message.user').getByText('native-notes.txt', { exact: true }).waitFor()
        const imagePreview = page
          .locator('.message.user')
          .getByRole('button', { name: 'Preview native-reference.png', exact: true })
        await imagePreview.waitFor()
        await imagePreview.hover()
        assert.match(await imagePreview.getAttribute('title'), /native-reference\.png/)
        await imagePreview.click()
        const imageDialog = page.getByRole('dialog', { name: 'native-reference.png', exact: true })
        await imageDialog.waitFor()
        await imageDialog
          .getByRole('heading', { name: 'native-reference.png', exact: true })
          .waitFor()
        assert.equal(await imageDialog.locator('img').evaluate((image) => image.naturalWidth), 4)
        await closeDialog()
        const attachmentLog = (await fixture.log()).slice(baseline)
        const uploaded = attachmentLog.find(
          (entry) =>
            entry.provider === provider &&
            (entry.attachmentEvidence || entry.nativeAttachmentEvidence),
        )
        const evidence = uploaded?.attachmentEvidence || uploaded?.nativeAttachmentEvidence
        assert.equal(evidence?.length, 2, 'The provider receives both selected attachment payloads')
        for (const [name, bytes] of [
          ['native-notes.txt', textReference],
          ['native-reference.png', imageReference],
        ]) {
          const file = evidence.find((file) => file.name === name)
          assert.ok(file, `The provider receives the selected file ${name}`)
          assert.equal(file.size, bytes.length)
          assert.equal(file.sha256, createHash('sha256').update(bytes).digest('hex'))
          if (file.path) attachmentDirectories.add(dirname(file.path))
        }
        if (provider === 'codex') {
          const selectedPath = evidence.find((file) => file.name === 'native-notes.txt').path
          assert.deepEqual(
            blocks.filter((block) => block.type === 'text').map((block) => block.text),
            ['native-attachment-probe', selectedPath],
            'Codex text attachments add only the exact selected file path',
          )
        }
        await writeFile(
          join(artifacts, `desktop-native-attachment-${provider}-proof.json`),
          JSON.stringify({ provider, prompt: promptFrom(request), files: evidence }, null, 2),
        )
        checks.push(
          `${provider} native attachments keep exact prompt bytes and visible file information`,
        )
      }

      phase = 'remote turn continues across actual lost SSH transport'
      const continuityProof = []
      for (const provider of ['codex', 'claude']) {
        await newThread(provider)
        const baseline = (await fixture.log()).length
        await send('continuity-delay')
        await page
          .getByRole('button', { name: 'Stop agent and pause queued messages', exact: true })
          .waitFor()
        await waitUntil(
          async () => (await promptsSince(baseline, provider)).includes('continuity-delay'),
          'provider turn starts before actual SSH cut',
        )
        const original = await ordinaryThread('continuity-delay', provider)
        fixture.dropConnections()
        await waitUntil(
          async () =>
            (await page.evaluate(() => window.relay.connection.state())).status !== 'connected',
          'real SSH transport drops',
        )
        const suspended = await ordinaryThread('continuity-delay', provider)
        assert.equal(suspended.busy, true, 'A lost SSH connection retains active remote work')
        await waitUntil(
          async () =>
            (await page.evaluate(() => window.relay.connection.state())).status === 'connected',
          'automatic SSH reconnection with in-memory authentication',
          30000,
        )
        const restoredConnection = await page.evaluate(() => window.relay.connection.state())
        assert.equal(
          restoredConnection.workspace,
          original.workspace,
          'Automatic transport recovery publishes the existing project with its connected state',
        )
        assert.equal(
          await page.getByRole('dialog', { name: 'Select a project', exact: true }).count(),
          0,
          'A continued saved thread never asks for its project again',
        )
        await waitForSend()
        await page
          .locator('.markdown')
          .getByText('Continued after transport interruption.', { exact: true })
          .waitFor()
        assert.equal(await page.getByRole('dialog').count(), 0)
        const resumed = await ordinaryThread('continuity-delay', provider)
        assert.equal(resumed.id, original.id)
        assert.equal(resumed.remoteId, original.remoteId)
        assert.equal(
          (await promptsSince(baseline, provider)).filter((prompt) => prompt === 'continuity-delay')
            .length,
          1,
          'Reconnection replays output, not user input',
        )
        continuityProof.push({
          provider,
          localId: resumed.id,
          remoteId: resumed.remoteId,
          userPromptsSent: 1,
          suspendedWasBusy: suspended.busy,
        })
        checks.push(
          `${provider} actual SSH loss keeps remote work active and resumes once without resending user input`,
        )
      }
      await writeFile(
        join(artifacts, 'desktop-ssh-continuity-proof.json'),
        JSON.stringify(continuityProof, null, 2),
      )
    }

    const {
      runResearchChecks,
      runHostHistoryChecks,
      runBuiltinChecks,
    } = require('./helpers/desktop-research-history-steps.cjs')
    phase = 'Research separation, host chat history and built-in extension controls'
    if (
      process.env.LIFE_TEST_PHASE === 'features' &&
      process.env.LIFE_TEST_SKIP_PRIOR_FEATURES === '1'
    ) {
      console.log(
        'Feature debug: previously verified Research, History and built-ins skipped for isolated Studio/recovery checks.',
      )
      await newThread('codex')
      const restartProjectPrompt = 'Validate Life Studio restart preserves this saved project.'
      await send(restartProjectPrompt)
      await waitUntil(
        async () =>
          (await readThreads()).some(
            (thread) =>
              thread.provider === 'codex' &&
              thread.workspace === input.workspace &&
              !thread.busy &&
              thread.remoteId &&
              thread.messages.some(
                (message) => message.role === 'user' && message.text === restartProjectPrompt,
              ),
          ),
        'isolated Studio debug creates a genuine saved Agents project context',
      )
    } else {
      if (process.env.LIFE_TEST_PHASE === 'features' && process.env.LIFE_TEST_SKIP_RESEARCH === '1')
        console.log(
          'Feature debug: previously verified Research helper skipped for targeted History/Studio checks.',
        )
      else {
        await runResearchChecks(context)
        const { runResearchMethodChecks } = require('./helpers/desktop-research-method-steps.cjs')
        phase = 'Research method records and immutable queued operator context'
        await runResearchMethodChecks(context)
        phase = 'host chat history and built-in extension controls'
      }
      await runHostHistoryChecks(context)
      await runBuiltinChecks(context)
    }

    phase = 'dark and light reference layout screenshots'
    await workspace()
    await page.evaluate(() => window.relay.customization.apply({ theme: 'dark' }))
    await screenshot('life.png')
    await screenshot('life-workspace.png')
    await page.evaluate(() => window.relay.customization.apply({ theme: 'light' }))
    await screenshot('life-light.png')
    await screenshot('life-workspace-light.png')
    await page.evaluate(() => window.relay.customization.apply({ theme: 'dark' }))
    checks.push('neutral dark and light themes with current reference layout screenshots')

    const { runUsageChecks } = require('./helpers/desktop-usage-steps.cjs')
    phase = 'native provider usage, cumulative totals and account limits'
    await runUsageChecks(context)

    const { runStudioChecks } = require('./helpers/desktop-studio-steps.cjs')
    phase = 'dedicated Studio settings, extensions, compile, repair and sharing'
    await runStudioChecks(context)
    assert.equal(
      (await page.evaluate(() => window.relay.updates.get())).autoDownload,
      false,
      'The native update opt-out survives Studio changes and a real cold restart',
    )
    assert.equal(
      (await page.evaluate(() => window.relay.updates.setAutoDownload(true))).autoDownload,
      true,
    )
    checks.push('Native update opt-out survives source customization and a cold restart')

    const { runRecoveryChecks } = require('./helpers/desktop-recovery-steps.cjs')
    phase = 'native Retry, actual renderer death and emergency recovery'
    await runRecoveryChecks(context)
    assert.deepEqual(rendererErrors, [])
    const rendererEvents = [
      ...priorRendererEvents,
      ...(await application.evaluate(() => globalThis.__lifeRendererProof?.events || [])),
    ]
    assert.deepEqual(
      rendererEvents.filter((event) => !event.expected),
      [],
      'All actual renderer deaths were deliberately triggered',
    )
    await writeFile(
      join(artifacts, 'desktop-smoke-result.json'),
      JSON.stringify(
        {
          ok: true,
          version: metadata.version,
          packaged: Boolean(selectedBinary),
          mode: process.env.LIFE_TEST_PHASE === 'features' ? 'features-debug' : 'full',
          fixture:
            'real loopback SSH/SFTP with deterministic fake provider CLIs; no provider account or inference',
          checks,
          rendererErrors,
          rendererErrorDetails,
          rendererEvents,
          completedAt: new Date().toISOString(),
        },
        null,
        2,
      ),
    )
    console.log(
      `Native Electron ${metadata.version} smoke passed ${checks.length} groups (${selectedBinary ? 'packaged' : 'built source'}). Proof: ${artifacts}`,
    )
  } catch (error) {
    failed = true
    console.error(`Native Electron smoke failed during ${phase}:`, error)
    try {
      await page?.screenshot({ path: join(artifacts, 'desktop-failure.png') })
      await writeFile(join(artifacts, 'desktop-failure-dom.html'), (await page?.content()) || '')
      await writeFile(
        join(artifacts, 'desktop-failure-proof.json'),
        JSON.stringify(
          {
            phase,
            error: String(error?.stack || error),
            checks,
            rendererErrors,
            rendererErrorDetails,
            nativeLogs,
            threads: await readThreads(),
            fixtureLog: await fixture.log(),
            nativeEvents: await application?.evaluate(() => globalThis.__lifeRendererProof),
          },
          null,
          2,
        ),
      )
    } catch (captureError) {
      console.error('Failure artifact capture:', captureError)
    }
    throw error
  } finally {
    clearInterval(progressTimer)
    if (application) await application.close().catch(() => {})
    await fixture.close()
    await new Promise((resolveClose) => remoteService.close(resolveClose))
    if (!failed) await rm(configurationRoot, { recursive: true, force: true })
  }
}

run().catch((error) => {
  console.error(error)
  process.exitCode = 1
})
