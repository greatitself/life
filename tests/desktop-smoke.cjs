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
const { join, resolve } = require('node:path')
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
  let application
  let page
  let phase = 'launch'
  let failed = false

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
    page = await application.firstWindow()
    page.setDefaultTimeout(15000)
    page.on('pageerror', (error) => rendererErrors.push(error.message))
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
    const isolation = await application.evaluate(({ BrowserWindow }) =>
      BrowserWindow.getAllWindows()[0].webContents.getLastWebPreferences(),
    )
    assert.equal(isolation.contextIsolation, true)
    assert.equal(isolation.nodeIntegration, false)
    assert.equal(isolation.sandbox, true)
  }
  const navigation = () => page.getByRole('navigation', { name: 'Workspace views' })
  const map = () => navigation().getByRole('button', { name: 'Map', exact: true }).click()
  const workspace = () =>
    navigation().getByRole('button', { name: 'Workspace', exact: true }).click()
  const filesPanel = async () => {
    await page
      .locator('.workspace-panel .workspace-view-tabs')
      .getByRole('button', { name: 'Files', exact: true })
      .click()
  }
  const configuration = () => page.evaluate(() => window.relay.customization.get())
  const openSettings = async () => {
    await page.getByRole('button', { name: 'Settings', exact: true }).first().click()
    const dialog = page.getByRole('dialog', { name: 'Settings', exact: true })
    await dialog.waitFor()
    return dialog
  }
  const closeDialog = () => page.keyboard.press('Escape')
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
  const composer = () => page.getByRole('textbox', { name: 'Message your coding agent' })
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
    if (reopen)
      await page
        .locator('.workspace-header')
        .getByRole('button', { name: 'Select project', exact: true })
        .click()
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
    await page
      .getByRole('button', { name: /^Source code(?:\s|$)/ })
      .first()
      .click()
    const manager = page.getByRole('dialog', { name: 'Life source', exact: true })
    await manager.waitFor()
    return manager
  }
  const extensionFrame = () => page.frameLocator('iframe[title="Research tools"]')
  const openExtensions = async () => {
    const replacementManager = page.getByRole('button', {
      name: 'Manage extensions',
      exact: true,
    })
    if (await replacementManager.isVisible()) await replacementManager.click()
    else await page.getByRole('button', { name: /^Live extensions/ }).click()
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

  try {
    await launch()
    phase = 'fresh chat workspace, empty research map and native window controls'
    assert.match(await page.title(), /^Life/)
    assert.equal(await page.evaluate(() => window.relay.platform), process.platform)
    await page
      .getByRole('heading', { name: 'Give your next idea a place to grow.', exact: true })
      .waitFor()
    assert.equal((await configuration()).config.startView, 'workspace')
    await map()
    await page.getByRole('heading', { name: 'Give your research a map.', exact: true }).waitFor()
    assert.deepEqual(
      await page.evaluate(() => JSON.parse(localStorage.getItem('life.research.v1') || '[]')),
      [],
    )
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
        'native minimize IPC',
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
        'native maximize IPC',
      )
      await application.evaluate(({ BrowserWindow }) => {
        const window = BrowserWindow.getAllWindows()[0]
        window.unmaximize()
        window.setBounds({ width: 1440, height: 960 })
      })
      assert.equal(typeof (await page.evaluate(() => window.relay.window.state())), 'boolean')
    } else {
      assert.equal(await page.locator('.native-window-controls').count(), 0)
      await page.locator('.native-traffic-light-space').waitFor()
    }

    phase = 'offline ordinary-thread customization, Settings undo and persisted theme'
    const original = (await configuration()).config
    assert.equal(original.autoPortForward, true)
    assert.equal(await page.getByRole('button', { name: 'Customize Life', exact: true }).count(), 0)
    await workspace()
    await send('/life Switch to light theme and set font size to 16 and use compact layout')
    await waitUntil(async () => {
      const current = (await configuration()).config
      return current.theme === 'light' && current.fontSize === 16 && current.density === 'compact'
    }, 'local customization')
    assert.equal(await page.locator('html').getAttribute('data-density'), 'compact')
    assert.equal(
      await page
        .locator('html')
        .evaluate((element) => element.style.getPropertyValue('--life-font-size')),
      '16px',
    )
    await page
      .locator('.markdown')
      .getByText(/Updated Life settings locally:/)
      .waitFor()
    let dialog = await openSettings()
    assert.equal(await dialog.locator('textarea, select').count(), 0)
    await dialog.getByRole('button', { name: 'Undo', exact: true }).click()
    await waitUntil(
      async () => JSON.stringify((await configuration()).config) === JSON.stringify(original),
      'customization undo',
    )
    await closeDialog()
    await map()
    await page.getByRole('button', { name: 'Switch to light theme', exact: true }).click()
    await waitUntil(
      async () => (await configuration()).config.theme === 'light',
      'theme toggle persistence',
    )
    await waitUntil(
      async () =>
        (
          await page.evaluate(() => JSON.parse(localStorage.getItem('relay.threads.v1') || '[]'))
        ).some((thread) =>
          thread.messages.some(
            (message) =>
              message.role === 'user' &&
              message.text ===
                '/life Switch to light theme and set font size to 16 and use compact layout',
          ),
        ),
      'offline Life conversation persisted',
    )
    await application.close()
    application = undefined
    await launch()
    assert.equal(await page.locator('html').getAttribute('data-theme'), 'light')
    await map()
    await page.getByRole('heading', { name: 'Give your research a map.', exact: true }).waitFor()

    phase = 'research projects, dependencies, filters and real Mermaid export'
    async function addProject(title, status, dependency) {
      await page.getByRole('button', { name: 'New project', exact: true }).click()
      const form = page.getByRole('dialog', { name: 'New research project' })
      await form.getByLabel('Project title', { exact: true }).fill(title)
      await form
        .getByLabel('Research question or goal', { exact: true })
        .fill('Desktop smoke test project: compare reproducible agent workflows.')
      await form.getByRole('combobox', { name: /^Status/ }).selectOption(status)
      await form.getByPlaceholder('agents, evaluation, experiment').fill('agents, desktop smoke')
      if (dependency) await form.getByRole('checkbox', { name: dependency, exact: true }).check()
      await form.getByRole('button', { name: 'Add project', exact: true }).click()
      await form.waitFor({ state: 'hidden' })
      await waitForGraph()
    }
    await addProject('Agent evaluation', 'active')
    await addProject('Replication study', 'planned', 'Agent evaluation')
    const projects = await page.evaluate(() =>
      JSON.parse(localStorage.getItem('life.research.v1') || '[]'),
    )
    assert.equal(projects.length, 2)
    assert.deepEqual(projects[1].dependencies, [projects[0].id])
    await page.getByRole('button', { name: 'Show project list', exact: true }).click()
    assert.equal(await page.locator('.research-project-row').count(), 2)
    await page.getByRole('textbox', { name: 'Search research projects' }).fill('Replication')
    await waitUntil(
      async () => (await page.locator('.research-project-row').count()) === 1,
      'project search filter',
    )
    await page.getByRole('button', { name: 'Clear project search', exact: true }).click()
    await page.getByRole('combobox', { name: 'Filter project status' }).selectOption('active')
    await waitUntil(
      async () => (await page.locator('.research-project-row').count()) === 1,
      'project status filter',
    )
    await page.getByRole('combobox', { name: 'Filter project status' }).selectOption('all')
    await page.getByRole('button', { name: 'Show project graph', exact: true }).click()
    await waitForGraph()
    await writeFile(
      join(artifacts, 'desktop-graph-debug.json'),
      JSON.stringify(
        await page.locator('.research-graph-svg').evaluate((host) => ({
          markup: host.innerHTML,
          bounds: host.getBoundingClientRect().toJSON(),
          nodes: [...host.querySelectorAll('g.node')].map((node) => ({
            id: node.id,
            label: node.getAttribute('aria-label'),
            text: node.textContent,
            bounds: node.getBoundingClientRect().toJSON(),
          })),
        })),
        null,
        2,
      ),
    )
    assert.equal(await page.locator('.research-graph-svg g.node').count(), 2)
    assert.ok((await page.locator('.research-graph-svg .edgePaths path').count()) >= 1)
    await page
      .locator('.research-graph-svg')
      .getByRole('button', { name: 'Select Agent evaluation', exact: true })
      .click()
    await page
      .locator('.research-inspector')
      .getByRole('heading', { name: 'Agent evaluation', exact: true })
      .waitFor()
    await page
      .locator('.research-graph-svg')
      .getByRole('button', { name: 'Select Replication study', exact: true })
      .press('Enter')
    await page
      .locator('.research-inspector')
      .getByRole('heading', { name: 'Replication study', exact: true })
      .waitFor()
    await page.getByRole('button', { name: 'Mermaid source', exact: true }).click()
    const source = page.getByRole('dialog', { name: 'Mermaid source' })
    const mermaid = await source.locator('pre').textContent()
    assert.match(mermaid, /flowchart LR/)
    assert.match(mermaid, /Agent evaluation/)
    assert.match(mermaid, /-->/)
    await closeDialog()
    const exportedSvg = join(artifacts, 'life-research-map.svg')
    await rm(exportedSvg, { force: true })
    await application.evaluate(({ BrowserWindow }, file) => {
      BrowserWindow.getAllWindows()[0].webContents.session.once('will-download', (_event, item) =>
        item.setSavePath(file),
      )
    }, exportedSvg)
    await page.getByRole('button', { name: 'Export SVG', exact: true }).click()
    await waitUntil(async () => {
      try {
        return (await readFile(exportedSvg, 'utf8')).includes('</svg>')
      } catch {
        return false
      }
    }, 'complete SVG download')
    assert.match(await readFile(exportedSvg, 'utf8'), /<svg[\s>]/)

    phase = 'OpenSSH config alias, real host trust and SFTP'
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
    await page.getByRole('button', { name: 'Connect', exact: true }).click()
    const connection = page.getByRole('dialog', { name: 'Connect a machine' })
    await connection.getByRole('textbox', { name: 'SSH config file path' }).fill(sshConfig)
    await connection.getByRole('button', { name: 'Reload SSH config', exact: true }).click()
    await waitUntil(
      async () =>
        await connection.getByRole('combobox', { name: 'SSH config host alias' }).isEnabled(),
      'SSH aliases parsed by ssh -G',
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
    assert.equal(await connection.getByPlaceholder('dev.example.com').getAttribute('readonly'), '')
    await connection.getByPlaceholder('My development server').fill('Loopback test workspace')
    await connection.getByLabel('Authentication').selectOption('password')
    await connection.getByPlaceholder('Your SSH password').fill(input.password)
    assert.equal(await connection.getByPlaceholder('~/projects/my-app').count(), 0)
    assert.equal(
      await connection.getByRole('textbox', { name: 'Project directory', exact: true }).count(),
      0,
    )
    await connection.getByRole('button', { name: 'Connect machine', exact: true }).click()
    const trust = page.getByRole('dialog', { name: 'Trust this machine?' })
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
    await initialPicker.waitFor({ state: 'hidden' })
    await workspace()
    await page.locator('.composer-worktree-strip .status-dot.online').waitFor()
    const profiles = await page.evaluate(() => window.relay.profiles.list())
    assert.equal(profiles.length, 1)
    assert.equal(profiles[0].password, undefined)
    assert.equal(profiles[0].sshConfig.alias, 'life-fixture')
    const state = await page.evaluate(() => window.relay.connection.state())
    assert.match(state.codex, /test/)
    assert.match(state.claude, /test/)
    const blockedProjectOperations = await page.evaluate(async () => {
      const blocked = []
      for (const action of [
        () => window.relay.files.list(),
        () => window.relay.terminal.open(),
        () =>
          window.relay.agent.start({
            sessionId: 'machine-only-smoke',
            provider: 'codex',
            prompt: 'hello',
            model: '',
            mode: 'plan',
          }),
      ]) {
        try {
          await action()
          blocked.push('unexpected success')
        } catch (error) {
          blocked.push(error.message)
        }
      }
      return blocked
    })
    for (const message of blockedProjectOperations)
      assert.match(message, /select.*project|choose.*project|connect to a workspace first/i)

    phase =
      'automatic port forwarding, local collision mapping, browser address and persisted toggle'
    const forwarding = () => page.evaluate(() => window.relay.forwarding.get())
    await page.getByRole('button', { name: /^Ports(?:\s|$)/ }).click()
    let portsDialog = page.getByRole('dialog', { name: 'Port forwarding', exact: true })
    await portsDialog.waitFor()
    const automaticPorts = () =>
      portsDialog.getByRole('switch', { name: 'Automatic port forwarding', exact: true })
    assert.equal(await automaticPorts().isChecked(), true)
    await waitUntil(
      async () => (await forwarding()).ports.some((port) => port.remotePort === remoteServicePort),
      'isolated SSH service discovered and forwarded',
    )
    let forwarded = (await forwarding()).ports.find((port) => port.remotePort === remoteServicePort)
    assert.equal(forwarded.localHost, '127.0.0.1')
    assert.notEqual(
      forwarded.localPort,
      remoteServicePort,
      'The occupied matching local port maps to an available port',
    )
    assert.deepEqual(
      await (
        await fetch(`${forwarded.url}/desktop-smoke`, { signal: AbortSignal.timeout(5000) })
      ).json(),
      { service: 'Life SSH forwarding fixture', path: '/desktop-smoke' },
    )
    assert.ok(
      fixture.forwardRequests.some(
        (request) => request.host === '127.0.0.1' && request.port === remoteServicePort,
      ),
    )
    await portsDialog
      .getByRole('button', {
        name: `Copy local address for remote port ${remoteServicePort}`,
        exact: true,
      })
      .click()
    const expectedClipboard = `127.0.0.1:${forwarded.localPort}`
    await portsDialog.getByText(`Copied ${expectedClipboard}`, { exact: true }).waitFor()
    await waitUntil(
      async () =>
        (await application.evaluate(({ clipboard }) => clipboard.readText())) === expectedClipboard,
      'mapped local service address copied to the system clipboard',
    )
    await application.evaluate(({ shell }) => {
      globalThis.__lifePortURLs = []
      globalThis.__lifePortOpenExternal = shell.openExternal
      shell.openExternal = async (url) => {
        globalThis.__lifePortURLs.push(url)
      }
    })
    try {
      await portsDialog
        .getByRole('link', {
          name: `Open remote port ${remoteServicePort} in browser`,
          exact: true,
        })
        .click()
      await waitUntil(
        async () =>
          (await application.evaluate(() => globalThis.__lifePortURLs)).some(
            (url) => new URL(url).href === new URL(forwarded.url).href,
          ),
        'browser opens the mapped local service URL',
      )
    } finally {
      await writeFile(
        join(artifacts, 'desktop-port-browser-address.json'),
        JSON.stringify(
          {
            declared: forwarded.url,
            captured: await application.evaluate(() => globalThis.__lifePortURLs),
          },
          null,
          2,
        ),
      )
      await application.evaluate(({ shell }) => {
        shell.openExternal = globalThis.__lifePortOpenExternal
        delete globalThis.__lifePortOpenExternal
      })
    }
    const formerURL = forwarded.url
    await automaticPorts().click()
    await waitUntil(
      async () => !(await forwarding()).enabled && (await forwarding()).ports.length === 0,
      'automatic forwarding disabled and tunnels removed',
    )
    const forwardingConfig = await configuration()
    assert.equal(forwardingConfig.config.autoPortForward, false)
    assert.equal(JSON.parse(await readFile(forwardingConfig.path, 'utf8')).autoPortForward, false)
    await assert.rejects(fetch(`${formerURL}/closed`, { signal: AbortSignal.timeout(3000) }))
    await closeDialog()

    await page.getByRole('button', { name: /^Ports(?:\s|$)/ }).click()
    portsDialog = page.getByRole('dialog', { name: 'Port forwarding', exact: true })
    await portsDialog.waitFor()
    assert.equal(await automaticPorts().isChecked(), false)
    await automaticPorts().click()
    await waitUntil(
      async () =>
        (await forwarding()).enabled &&
        (await forwarding()).ports.some((port) => port.remotePort === remoteServicePort),
      'discovery resumes after automatic forwarding is enabled',
    )
    forwarded = (await forwarding()).ports.find((port) => port.remotePort === remoteServicePort)
    assert.deepEqual(
      await (
        await fetch(`${forwarded.url}/reenabled`, { signal: AbortSignal.timeout(5000) })
      ).json(),
      { service: 'Life SSH forwarding fixture', path: '/reenabled' },
    )
    await closeDialog()

    phase = 'post-connect project browsing, canonical selection and SFTP'
    await chooseProject({ reopen: true, browse: true })
    await filesPanel()
    await page.getByRole('button', { name: 'src', exact: true }).click()
    await page.getByRole('button', { name: 'index.ts', exact: true }).click()
    await page
      .locator('.file-preview')
      .getByText('export const answer = 42', { exact: true })
      .waitFor()
    await page.getByRole('button', { name: 'Add to prompt', exact: true }).click()
    assert.match(await composer().inputValue(), /src\/index.ts/)

    phase = 'real SSH unified Git diff and file review'
    await writeFile(
      join(fixture.workspace, 'src/index.ts'),
      "export const answer = 42\nexport const researchStatus = 'verified'\n",
    )
    await writeFile(join(fixture.workspace, 'untracked-proof.txt'), 'Native SSH untracked file\n')
    await writeFile(join(fixture.workspace, 'src/thread-activity.ts'), activityReviewed)
    await page
      .locator('.workspace-panel')
      .getByRole('button', { name: 'Diff', exact: true })
      .click()
    await page.getByRole('button', { name: 'Refresh remote workspace', exact: true }).click()
    await page
      .locator('.workspace-diff-line.diff-added')
      .filter({ hasText: 'researchStatus' })
      .waitFor()
    assert.ok((await page.locator('.workspace-diff-hunk').first().textContent()).includes('@@'))
    assert.ok((await page.locator('.workspace-diff-line .diff-line-number').count()) >= 2)
    assert.ok((await page.locator('.workspace-diff-line.diff-removed').count()) >= 1)
    const wrapDiff = page.getByRole('button', { name: 'Wrap diff lines', exact: true })
    const originalWrap = await wrapDiff.getAttribute('aria-pressed')
    await wrapDiff.click()
    assert.equal(
      await wrapDiff.getAttribute('aria-pressed'),
      originalWrap === 'true' ? 'false' : 'true',
    )
    await wrapDiff.click()
    assert.equal(await wrapDiff.getAttribute('aria-pressed'), originalWrap)
    await page.getByRole('button', { name: 'Collapse all diffs', exact: true }).click()
    assert.equal(await page.locator('.workspace-diff-line.diff-added').count(), 0)
    await page.getByRole('button', { name: 'Expand all diffs', exact: true }).click()
    await page
      .locator('.workspace-diff-line.diff-added')
      .filter({ hasText: 'researchStatus' })
      .waitFor()
    await page
      .locator('.workspace-untracked-file')
      .filter({ hasText: 'untracked-proof.txt' })
      .getByRole('button', { name: 'Open file', exact: true })
      .click()
    await page
      .locator('.file-preview')
      .getByText('Native SSH untracked file', { exact: true })
      .waitFor()
    await page.getByRole('button', { name: 'Add to prompt', exact: true }).click()
    assert.match(await composer().inputValue(), /untracked-proof\.txt/)
    await filesPanel()

    phase = 'both agent providers, approvals, questions, interruption and current chat'
    for (const provider of ['codex', 'claude']) {
      await page.getByRole('button', { name: 'New thread', exact: false }).click()
      await page
        .getByRole('button', {
          name: provider === 'codex' ? 'Codex By OpenAI' : 'Claude Code By Anthropic',
        })
        .click()
      await send('hello')
      await page
        .locator('.markdown')
        .getByText(`Hello from ${provider === 'codex' ? 'Codex' : 'Claude'} 👋`, { exact: true })
        .waitFor()
      await waitForSend()
      await send('approval')
      await page
        .getByText(provider === 'codex' ? 'Allow this command?' : 'Allow Bash?', { exact: true })
        .waitFor()
      await page.getByRole('button', { name: 'Allow once', exact: true }).click()
      await page
        .locator('.markdown')
        .getByText(provider === 'codex' ? '{"decision":"accept"}' : /"behavior":"allow"/)
        .last()
        .waitFor()
      await waitForSend()
      await send('question')
      await page.getByText('Your input is needed', { exact: true }).waitFor()
      await page.getByLabel('Which language?').selectOption('TypeScript')
      await page.getByRole('button', { name: 'Send answers', exact: true }).click()
      await waitForSend()
      await map()
      await workspace()
      assert.ok(
        (await page.locator('.messages .message').count()) >= 4,
        'Current chat survives Map/Workspace navigation',
      )
    }
    const previousResponses = await page.locator('.message.assistant').count()
    await send('hang')
    await waitUntil(
      async () => (await page.locator('.message.assistant').count()) > previousResponses,
      'active Claude streaming before interruption',
    )
    await page.getByRole('button', { name: 'Stop agent', exact: true }).click()
    await waitForSend()
    await page.evaluate(() => {
      globalThis.__lifeSmokeTerminal = ''
      globalThis.__lifeSmokeTerminalUnsubscribe = window.relay.onTerminal((data) => {
        globalThis.__lifeSmokeTerminal += data
      })
    })
    await page.getByRole('button', { name: 'Toggle remote terminal', exact: true }).click()
    await waitUntil(
      async () =>
        /bash-[\d.]+[#$] /.test(await page.evaluate(() => globalThis.__lifeSmokeTerminal)),
      'remote shell ready before terminal keyboard input',
    )
    await page.locator('.xterm-helper-textarea').focus()
    await page.keyboard.type('printf LIFE_DESKTOP_TERMINAL_OK')
    await page.keyboard.press('Enter')
    await waitUntil(
      async () =>
        (await page.evaluate(() => globalThis.__lifeSmokeTerminal)).includes(
          'LIFE_DESKTOP_TERMINAL_OK',
        ),
      'remote terminal output',
    )
    await page.getByRole('button', { name: 'Close terminal', exact: true }).click()
    await page.evaluate(() => globalThis.__lifeSmokeTerminalUnsubscribe())
    await page.keyboard.press(process.platform === 'darwin' ? 'Meta+k' : 'Control+k')
    await page.getByRole('dialog', { name: 'Find a thread' }).waitFor()
    await page.getByRole('textbox', { name: 'Search saved threads' }).fill('hello')
    assert.ok((await page.locator('.search-results button').count()) >= 2)
    await closeDialog()

    phase = 'changing projects preserves the existing conversation scope'
    const readProjectThread = () =>
      page.evaluate(() =>
        JSON.parse(localStorage.getItem('relay.threads.v1') || '[]').find(
          (thread) =>
            thread.provider === 'claude' &&
            thread.messages.some(
              (message) => message.role === 'user' && message.text === 'question',
            ),
        ),
      )
    await waitUntil(
      async () => Boolean((await readProjectThread())?.remoteId),
      'original project conversation persisted',
    )
    const originalProjectThread = await readProjectThread()
    assert.equal(originalProjectThread.workspace, input.workspace)
    const otherProject = join(input.workspace, 'src')
    await chooseProject({ reopen: true, path: otherProject, previousWorkspace: input.workspace })
    const otherFiles = await page.evaluate(() => window.relay.files.list())
    assert.deepEqual(
      otherFiles.map((file) => file.name),
      ['index.ts', 'thread-activity.ts'],
    )
    await page.keyboard.press(process.platform === 'darwin' ? 'Meta+k' : 'Control+k')
    await page.getByRole('dialog', { name: 'Find a thread' }).waitFor()
    await page.getByRole('textbox', { name: 'Search saved threads' }).fill('question')
    await page.locator('.search-results button').filter({ hasText: 'Claude Code' }).click()
    const originalConversationLog = await fixture.log()
    await send('project mismatch must not reach the agent')
    const scopedPicker = page.getByRole('dialog', { name: 'Select a project', exact: true })
    await scopedPicker.waitFor()
    assert.equal(
      await scopedPicker
        .getByRole('textbox', { name: 'Project directory', exact: true })
        .inputValue(),
      input.workspace,
    )
    const unchangedProjectThread = await readProjectThread()
    assert.equal(unchangedProjectThread.workspace, input.workspace)
    assert.equal(unchangedProjectThread.remoteId, originalProjectThread.remoteId)
    assert.deepEqual(unchangedProjectThread.messages, originalProjectThread.messages)
    assert.deepEqual(
      await fixture.log(),
      originalConversationLog,
      'A project mismatch never sends a provider turn',
    )
    await chooseProject({ previousWorkspace: otherProject })
    await send('hello')
    await waitForSend()
    await waitUntil(
      async () =>
        (await readProjectThread()).messages.length > originalProjectThread.messages.length,
      'old conversation resumes in its original project',
    )
    assert.equal((await readProjectThread()).id, originalProjectThread.id)
    assert.equal((await readProjectThread()).remoteId, originalProjectThread.remoteId)
    assert.equal((await readProjectThread()).workspace, input.workspace)
    assert.ok(
      (await fixture.log())
        .slice(originalConversationLog.length)
        .some(
          (entry) =>
            entry.provider === 'claude' &&
            entry.argv?.includes(`--resume=${originalProjectThread.remoteId}`),
        ),
    )

    phase = 'discovered provider reasoning and speed choices reach ordinary Life turns'
    for (const provider of ['codex', 'claude']) {
      await page.getByRole('button', { name: 'New thread', exact: false }).click()
      await page
        .getByRole('button', {
          name: provider === 'codex' ? 'Codex By OpenAI' : 'Claude Code By Anthropic',
        })
        .click()
      const selectedModel = provider === 'codex' ? 'fixture-model' : 'opus'
      const selectedEffort = provider === 'codex' ? 'high' : 'max'
      const modelSelect = page.getByRole('combobox', { name: 'Agent model', exact: true })
      await waitUntil(
        async () => (await modelSelect.locator(`option[value="${selectedModel}"]`).count()) === 1,
        'remote provider model catalog discovered',
      )
      await modelSelect.selectOption(selectedModel)
      const reasoningSelect = page.getByRole('combobox', { name: 'Reasoning effort', exact: true })
      const speedSelect = page.getByRole('combobox', { name: 'Service tier', exact: true })
      await reasoningSelect.selectOption(selectedEffort)
      await speedSelect.selectOption('fast')
      for (const control of [modelSelect, reasoningSelect, speedSelect])
        assert.equal(await control.evaluate((element) => element.tagName), 'SELECT')
      const controlsBaseline = (await fixture.log()).length
      await send('/life explain customization')
      await waitForSend()
      await page
        .locator('.markdown')
        .getByText('Life supports settings and executable extensions in this same conversation.', {
          exact: true,
        })
        .waitFor()
      assert.equal(await page.locator('.chat-error').count(), 0)
      const selectedControlLog = (await fixture.log()).slice(controlsBaseline)
      if (provider === 'codex') {
        const turn = selectedControlLog.find((entry) => entry.message?.method === 'turn/start')
        assert.equal(turn.message.params.model, selectedModel)
        assert.equal(turn.message.params.effort, selectedEffort)
        assert.equal(turn.message.params.serviceTier, 'fast')
        assert.ok(
          turn.message.params.input[0].text.startsWith(
            'The user is asking about Life itself from an ordinary chat thread.',
          ),
        )
      } else {
        const command = selectedControlLog.find(
          (entry) => entry.provider === provider && entry.argv,
        )
        assert.ok(command.argv.includes(`--model=${selectedModel}`))
        assert.ok(command.argv.includes(`--effort=${selectedEffort}`))
        const settingsIndex = command.argv.indexOf('--settings')
        assert.ok(settingsIndex >= 0)
        assert.equal(JSON.parse(command.argv[settingsIndex + 1]).fastMode, true)
      }
      await waitUntil(async () => {
        const thread = await page.evaluate(
          (requestedProvider) =>
            JSON.parse(localStorage.getItem('relay.threads.v1') || '[]').find(
              (item) =>
                item.provider === requestedProvider && item.title === '/life explain customization',
            ),
          provider,
        )
        return (
          thread?.model === selectedModel &&
          thread?.reasoningEffort === selectedEffort &&
          thread?.serviceTier === 'fast'
        )
      }, 'model, reasoning and tier persist on the same ordinary thread')
      const resetBaseline = (await fixture.log()).length
      if (provider === 'claude') {
        await modelSelect.selectOption('haiku')
        assert.equal(await reasoningSelect.count(), 0)
        assert.equal(await speedSelect.locator('option[value="fast"]').count(), 0)
        assert.equal(await speedSelect.inputValue(), '')
        await speedSelect.selectOption('default')
      } else {
        await reasoningSelect.selectOption('')
        await speedSelect.selectOption('')
      }
      await send('explain customization')
      await waitForSend()
      const resetLog = (await fixture.log()).slice(resetBaseline)
      if (provider === 'codex') {
        const turn = resetLog.find((entry) => entry.message?.method === 'turn/start')
        assert.equal(turn.message.params.effort, 'low')
        assert.equal(turn.message.params.serviceTier, null)
      } else {
        const command = resetLog.find((entry) => entry.provider === provider && entry.argv)
        assert.ok(command.argv.includes('--model=haiku'))
        assert.equal(
          command.argv.some((argument) => argument.startsWith('--effort')),
          false,
        )
        const settingsIndex = command.argv.indexOf('--settings')
        assert.ok(settingsIndex >= 0)
        assert.equal(JSON.parse(command.argv[settingsIndex + 1]).fastMode, false)
      }
      assert.equal(await page.locator('.chat-error').count(), 0)
    }

    phase = 'remote ordinary-thread settings, replies, clarification and preserved native selects'
    const ordinaryLifeThreads = new Map()
    for (const provider of ['codex', 'claude']) {
      await page.getByRole('button', { name: 'New thread', exact: false }).click()
      await page
        .getByRole('button', {
          name: provider === 'codex' ? 'Codex By OpenAI' : 'Claude Code By Anthropic',
        })
        .click()
      await send('hello')
      await page
        .locator('.markdown')
        .getByText(`Hello from ${provider === 'codex' ? 'Codex' : 'Claude'} 👋`, { exact: true })
        .waitFor()
      await waitForSend()
      const harnessBaseline = (await fixture.log()).length
      const settingsPrompt =
        provider === 'codex' ? '/life add research panels' : '@life add research panels'
      await send(settingsPrompt)
      await waitForSend()
      await page
        .locator('.markdown')
        .getByText(/Updated Life settings:/)
        .waitFor()
      assert.equal(await page.locator('.chat-error').count(), 0)
      const nativeSelectCount = await page.locator('.composer-options select').count()
      assert.ok(nativeSelectCount >= 3)
      const unchanged = await configuration()
      const unchangedExtensions = await extensions()
      for (const [prompt, response] of [
        ['no change customization', 'Life already has this behavior.'],
        ['clarify customization', 'Which part of Life would you like me to change?'],
        [
          'explain customization',
          'Life supports settings and executable extensions in this same conversation.',
        ],
        [
          '/life make select components use shadcn',
          'Life can change its renderer source and rebuild from this thread. Which select controls should I update?',
        ],
      ]) {
        await send(prompt)
        await waitForSend()
        await page
          .locator('.markdown')
          .getByText(response, { exact: typeof response === 'string' })
          .waitFor()
        assert.equal(await page.locator('.chat-error').count(), 0)
        assert.deepEqual((await configuration()).config, unchanged.config)
        assert.equal((await configuration()).revision, unchanged.revision)
        assert.equal((await extensions()).revision, unchangedExtensions.revision)
        assert.equal(await page.locator('.composer-options select').count(), nativeSelectCount)
        for (const label of ['Coding agent', 'Agent model', 'Agent permission mode'])
          assert.equal(
            await page
              .getByRole('combobox', { name: label, exact: true })
              .evaluate((element) => element.tagName),
            'SELECT',
          )
      }
      const remoteLog = (await fixture.log()).slice(harnessBaseline)
      assert.equal(
        remoteLog.filter(
          (entry) => entry.provider === provider && entry.message?.method === 'thread/start',
        ).length,
        0,
      )
      if (provider === 'codex')
        assert.equal(
          remoteLog.filter((entry) => entry.provider === provider && entry.argv).length,
          0,
        )
      await waitUntil(async () => {
        const saved = await page.evaluate(() =>
          JSON.parse(localStorage.getItem('relay.threads.v1') || '[]'),
        )
        const thread = saved.find(
          (item) =>
            item.provider === provider &&
            item.messages.some(
              (message) => message.role === 'user' && message.text === settingsPrompt,
            ),
        )
        if (
          !thread?.messages.some(
            (message) =>
              message.role === 'user' && message.text === '/life make select components use shadcn',
          )
        )
          return false
        ordinaryLifeThreads.set(provider, thread)
        return true
      }, 'same ordinary thread and remote identity persisted')
      assert.ok(ordinaryLifeThreads.get(provider).remoteId)
      if (provider === 'claude') {
        const resumedProcesses = remoteLog.filter(
          (entry) => entry.provider === provider && entry.argv,
        )
        assert.equal(resumedProcesses.length, 5)
        for (const entry of resumedProcesses)
          assert.ok(entry.argv.includes(`--resume=${ordinaryLifeThreads.get(provider).remoteId}`))
      }
      assert.ok(
        ordinaryLifeThreads
          .get(provider)
          .messages.some((message) => message.role === 'user' && message.text === 'hello'),
      )
      await page.getByRole('button', { name: 'Switch to dark theme', exact: true }).click()
      await waitUntil(
        async () => (await configuration()).config.theme === 'dark',
        'contrasting theme for project marker confinement',
      )
      const projectMarkerConfig = await configuration()
      await send('/project remote-life-markers')
      await waitForSend()
      await page
        .locator('.markdown')
        .getByText('<life-customization>{"theme":"light"}</life-customization>', { exact: true })
        .waitFor()
      assert.deepEqual((await configuration()).config, projectMarkerConfig.config)
      assert.equal((await configuration()).revision, projectMarkerConfig.revision)
      await page.getByRole('button', { name: 'Switch to light theme', exact: true }).click()
      await waitUntil(
        async () => (await configuration()).config.theme === 'light',
        'light theme restored after project marker confinement',
      )
      await send('Customize Life by adding research panels')
      await waitForSend()
      await page
        .locator('.markdown')
        .getByText(/Updated Life settings:/)
        .last()
        .waitFor()
      assert.equal(
        await page.getByRole('button', { name: 'Customize Life', exact: true }).count(),
        0,
      )
      phase = `${provider} Life turn cancellation, disconnect and remote conversation resume`
      const beforeCancellation = await configuration()
      const beforeCancellationExtensions = await extensions()
      const startHangingLifeTurn = async () => {
        const baseline = (await fixture.log()).length
        await send('/life hang customization')
        await waitUntil(
          async () =>
            (await fixture.log()).slice(baseline).some((entry) => {
              const text =
                entry.message?.params?.input?.[0]?.text ||
                entry.message?.message?.content?.[0]?.text ||
                ''
              return (
                entry.provider === provider &&
                text.startsWith(
                  'The user is asking about Life itself from an ordinary chat thread.',
                ) &&
                text.endsWith('"hang customization"')
              )
            }),
          'Life request received by the existing remote conversation',
        )
      }
      await startHangingLifeTurn()
      await page.getByRole('button', { name: 'Stop agent', exact: true }).click()
      await waitForSend()
      assert.deepEqual((await configuration()).config, beforeCancellation.config)
      assert.equal((await configuration()).revision, beforeCancellation.revision)
      assert.equal((await extensions()).revision, beforeCancellationExtensions.revision)
      await send('explain customization')
      await waitForSend()
      await page
        .locator('.markdown')
        .getByText('Life supports settings and executable extensions in this same conversation.', {
          exact: true,
        })
        .last()
        .waitFor()
      await startHangingLifeTurn()
      await page.evaluate(() => window.relay.connection.disconnect())
      await waitUntil(
        async () =>
          (await page.evaluate(() => window.relay.connection.state())).status === 'disconnected',
        'Life turn interrupted on SSH disconnect',
      )
      assert.deepEqual((await configuration()).config, beforeCancellation.config)
      assert.equal((await configuration()).revision, beforeCancellation.revision)
      assert.equal((await extensions()).revision, beforeCancellationExtensions.revision)
      const connectionLoss = 'SSH disconnected. Reconnect to continue this thread.'
      await page.locator('.chat-error').getByText(connectionLoss, { exact: true }).waitFor()
      assert.deepEqual(
        (await page.locator('.chat-error').allTextContents()).map((text) => text.trim()),
        [connectionLoss],
      )
      const resumeBaseline = (await fixture.log()).length
      await page.getByRole('button', { name: 'Connections', exact: true }).click()
      const reconnect = page.getByRole('dialog', { name: 'Connect a machine' })
      await reconnect.waitFor()
      assert.equal(await reconnect.getByPlaceholder('~/projects/my-app').count(), 0)
      await waitUntil(
        async () =>
          (await reconnect.getByPlaceholder('dev.example.com').inputValue()) === input.host,
        'saved machine profile selected',
      )
      await reconnect.getByPlaceholder('Your SSH password').fill(input.password)
      await reconnect.getByRole('button', { name: 'Connect machine', exact: true }).click()
      await reconnect.waitFor({ state: 'hidden' })
      await chooseProject()
      await waitUntil(
        async () =>
          (await page.evaluate(() => window.relay.connection.state())).status === 'connected',
        'saved machine reconnected',
      )
      await page.locator('.composer-worktree-strip .status-dot.online').waitFor()
      assert.equal(await page.getByRole('dialog', { name: 'Trust this machine?' }).count(), 0)
      await send('explain customization')
      await waitForSend()
      await page
        .locator('.markdown')
        .getByText('Life supports settings and executable extensions in this same conversation.', {
          exact: true,
        })
        .last()
        .waitFor()
      const resumedLog = (await fixture.log()).slice(resumeBaseline)
      const originalThread = ordinaryLifeThreads.get(provider)
      if (provider === 'codex')
        assert.ok(
          resumedLog.some(
            (entry) =>
              entry.provider === provider &&
              entry.message?.method === 'thread/resume' &&
              entry.message.params.threadId === originalThread.remoteId,
          ),
        )
      else
        assert.ok(
          resumedLog.some(
            (entry) =>
              entry.provider === provider &&
              entry.argv?.includes(`--resume=${originalThread.remoteId}`),
          ),
        )
      await waitUntil(async () => {
        const saved = await page.evaluate(() =>
          JSON.parse(localStorage.getItem('relay.threads.v1') || '[]'),
        )
        const resumed = saved.find((thread) => thread.id === originalThread.id)
        return (
          resumed?.remoteId === originalThread.remoteId &&
          resumed.turn >= originalThread.turn + 6 &&
          resumed.messages.filter(
            (message) => message.role === 'user' && message.text === '/life hang customization',
          ).length === 2
        )
      }, 'same local history and remote identity after cancellation and reconnect')
      assert.deepEqual(
        (await page.locator('.chat-error').allTextContents()).map((text) => text.trim()),
        [connectionLoss],
      )
      phase = 'remote ordinary-thread settings, replies, clarification and preserved native selects'
    }
    const extended = (await configuration()).config
    assert.equal(extended.commands[0].name, 'Review research')
    assert.equal(extended.widgets.length, 2)
    await page.getByRole('heading', { name: 'Experiment workflow', exact: true }).waitFor()
    await waitForDiagram()
    await page.getByRole('button', { name: 'Review research', exact: true }).click()
    assert.equal(
      await composer().inputValue(),
      'Review the research goals and propose the next experiment.',
    )
    await composer().fill('')
    await map()
    await page.getByRole('heading', { name: 'Experiment log', exact: true }).waitFor()
    await waitForGraph()
    await waitForDiagram()

    phase = 'live configuration file watcher and undo'
    const configState = await configuration()
    await writeFile(
      configState.path,
      JSON.stringify(
        {
          ...configState.config,
          theme: 'dark',
          density: 'compact',
          fontSize: 15,
          labels: { ...configState.config.labels, researchTitle: 'Live lab notes' },
        },
        null,
        2,
      ) + '\n',
    )
    await waitUntil(
      async () => (await page.locator('html').getAttribute('data-theme')) === 'dark',
      'live theme file reload',
    )
    await page
      .locator('.research-main .breadcrumbs')
      .getByText('Live lab notes', { exact: true })
      .waitFor()
    assert.equal(
      await page
        .locator('html')
        .evaluate((element) => element.style.getPropertyValue('--life-font-size')),
      '15px',
    )
    dialog = await openSettings()
    await dialog.getByRole('button', { name: 'Undo', exact: true }).click()
    await waitUntil(
      async () => (await configuration()).config.theme === 'light',
      'file customization undo',
    )
    await closeDialog()

    phase = 'connected fixture conversation and reference-sized documentation screenshots'
    await workspace()
    await page.getByRole('button', { name: 'New thread', exact: false }).click()
    await page.getByRole('button', { name: 'Codex By OpenAI' }).click()
    await send('Review the fixture changes')
    await page
      .locator('.markdown')
      .getByText('Reviewed the connected test workspace.', { exact: true })
      .waitFor()
    await waitForSend()
    await map()
    const referenceWorkspace = async (filename) => {
      const snapshot = await configuration()
      const bounds = await application.evaluate(({ BrowserWindow }) =>
        BrowserWindow.getAllWindows()[0].getBounds(),
      )
      try {
        await page.evaluate(() => window.relay.customization.apply({ widgets: [] }))
        await application.evaluate(({ BrowserWindow }) =>
          BrowserWindow.getAllWindows()[0].setBounds({ width: 1728, height: 1080 }),
        )
        await workspace()
        await page
          .locator('.workspace-panel')
          .getByRole('button', { name: 'Diff', exact: true })
          .click()
        await page
          .locator('.workspace-diff-line.diff-added')
          .filter({ hasText: 'firstResponse' })
          .first()
          .waitFor()
        const indexFile = page
          .locator('.workspace-diff-file')
          .filter({ hasText: 'src/index.ts' })
          .locator('.workspace-diff-file-toggle')
        if ((await indexFile.getAttribute('aria-expanded')) === 'true') await indexFile.click()
        await page
          .locator('.markdown')
          .getByText('Reviewed the connected test workspace.', { exact: true })
          .waitFor()
        const layout = await page.evaluate(() => {
          const rect = (selector) => {
            const bounds = document.querySelector(selector).getBoundingClientRect()
            return { x: bounds.x, y: bounds.y, width: bounds.width, height: bounds.height }
          }
          return {
            viewport: { width: innerWidth, height: innerHeight },
            sidebar: rect('.sidebar'),
            chat: rect('.chat-area'),
            diff: rect('.workspace-panel'),
          }
        })
        assert.ok(layout.sidebar.width >= 260 && layout.sidebar.width <= 340)
        assert.ok(layout.chat.width > 500)
        assert.ok(layout.diff.width > 400)
        assert.ok(layout.sidebar.x < layout.chat.x && layout.chat.x < layout.diff.x)
        await screenshot(filename)
        await writeFile(
          join(artifacts, filename.replace('.png', '-layout.json')),
          JSON.stringify(layout, null, 2),
        )
      } finally {
        await page.evaluate(
          (widgets) => window.relay.customization.apply({ widgets }),
          snapshot.config.widgets,
        )
        await application.evaluate(
          ({ BrowserWindow }, previous) => BrowserWindow.getAllWindows()[0].setBounds(previous),
          bounds,
        )
      }
    }
    phase = 'grayscale themes and documentation screenshots'
    const grayscale = async () => {
      const palette = await page.locator('html').evaluate((element) => {
        const style = getComputedStyle(element)
        return ['--bg', '--sidebar', '--surface', '--text', '--accent'].map((name) => ({
          name,
          value: style.getPropertyValue(name).trim(),
        }))
      })
      for (const { name, value } of palette) {
        const hex = value.match(/^#([0-9a-f]{6})$/i)
        if (hex) {
          const color = hex[1]
          assert.equal(color.slice(0, 2), color.slice(2, 4), `${name} is grayscale`)
          assert.equal(color.slice(2, 4), color.slice(4, 6), `${name} is grayscale`)
        } else
          assert.match(value, /^#([0-9a-f])\1\1$/i, `${name} has a grayscale hexadecimal color`)
      }
    }
    await grayscale()
    await waitForGraph()
    await waitForDiagram()
    await screenshot('life-light.png')
    await referenceWorkspace('life-workspace-light.png')
    await map()
    await waitForGraph()
    await page.getByRole('button', { name: 'Switch to dark theme', exact: true }).click()
    await waitUntil(
      async () => (await page.locator('html').getAttribute('data-theme')) === 'dark',
      'dark theme',
    )
    await grayscale()
    await waitForGraph()
    await waitForDiagram()
    await screenshot('life.png')
    await workspace()
    await waitForDiagram()
    await filesPanel()
    await page.getByRole('button', { name: 'src', exact: true }).waitFor()
    await referenceWorkspace('life-workspace.png')

    phase = 'slow provider initialization cancellation and replacement send'
    const cancellationBaseline = (await fixture.log()).length
    fixture.initializationDelay = 1200
    await page.getByRole('button', { name: 'New thread', exact: false }).click()
    await page.getByRole('button', { name: 'Claude Code By Anthropic' }).click()
    await send('canceled during initialization')
    await waitUntil(
      async () =>
        (await fixture.log())
          .slice(cancellationBaseline)
          .some(
            (entry) =>
              entry.provider === 'claude' && entry.message?.request?.subtype === 'initialize',
          ),
      'delayed provider initialize request',
    )
    await page.getByRole('button', { name: 'Stop agent', exact: true }).click()
    await waitForSend()
    fixture.initializationDelay = 0
    await send('hello')
    await page.locator('.markdown').getByText('Hello from Claude 👋', { exact: true }).waitFor()
    await waitForSend()
    assert.equal(
      (await fixture.log())
        .slice(cancellationBaseline)
        .some(
          (entry) =>
            entry.message?.message?.content?.[0]?.text === 'canceled during initialization',
        ),
      false,
    )

    phase = 'Codex and Claude ordinary-thread executable extension generation'
    let generatedExtension
    for (const provider of ['codex', 'claude']) {
      await workspace()
      await page.getByRole('button', { name: 'New thread', exact: false }).click()
      await page
        .getByRole('button', {
          name: provider === 'codex' ? 'Codex By OpenAI' : 'Claude Code By Anthropic',
        })
        .click()
      await send('hello')
      await waitForSend()
      const extensionHarnessBaseline = (await fixture.log()).length
      await send('/life add executable extension counter')
      await waitForSend()
      await page
        .locator('.markdown')
        .getByText(/Installed Research tools/)
        .waitFor()
      const extensionLog = (await fixture.log()).slice(extensionHarnessBaseline)
      assert.equal(
        extensionLog.filter(
          (entry) => entry.provider === provider && entry.message?.method === 'thread/start',
        ).length,
        0,
      )
      const extensionProcesses = extensionLog.filter(
        (entry) => entry.provider === provider && entry.argv,
      )
      if (provider === 'codex') assert.equal(extensionProcesses.length, 0)
      else {
        assert.equal(extensionProcesses.length, 1)
        let extensionThread
        await waitUntil(async () => {
          extensionThread = await page.evaluate(() =>
            JSON.parse(localStorage.getItem('relay.threads.v1') || '[]').find(
              (thread) =>
                thread.provider === 'claude' &&
                thread.messages.some(
                  (message) =>
                    message.role === 'user' &&
                    message.text === '/life add executable extension counter',
                ),
            ),
          )
          return Boolean(extensionThread?.remoteId)
        }, 'extension generated in the persisted ordinary Claude conversation')
        assert.ok(extensionProcesses[0].argv.includes(`--resume=${extensionThread.remoteId}`))
      }
      const state = await extensions()
      assert.deepEqual(state.errors, {})
      generatedExtension = state.extensions.find((extension) => extension.id === 'research-tools')
      assert.equal(generatedExtension?.renderer.placement, 'view')
      assert.equal(generatedExtension?.enabled, true)
      await page.getByRole('button', { name: 'Research tools', exact: true }).click()
      await extensionFrame()
        .getByRole('heading', { name: 'Research counter', exact: true })
        .waitFor()
      await extensionFrame().getByText('SSH: connected', { exact: true }).waitFor()
      await extensionFrame().getByRole('button', { name: 'Increment', exact: true }).click()
      await extensionFrame().getByText('Count: 1', { exact: true }).waitFor()
      await extensionFrame().getByRole('button', { name: 'Increment', exact: true }).click()
      await extensionFrame().getByText('Count: 2', { exact: true }).waitFor()
      assert.deepEqual(
        await page.evaluate(() => window.relay.extensions.call('research-tools', 'inspect', null)),
        { hasRequire: true },
      )
      assert.deepEqual(
        await extensionFrame()
          .locator('body')
          .evaluate(() => {
            let parentDocument = 'accessible'
            try {
              void parent.document.body
            } catch {
              parentDocument = 'denied'
            }
            return {
              require: typeof window.require,
              process: typeof window.process,
              relay: typeof window.relay,
              parentDocument,
            }
          }),
        {
          require: 'undefined',
          process: 'undefined',
          relay: 'undefined',
          parentDocument: 'denied',
        },
      )
      phase = `${provider} ordinary-thread disabled and failed extension activation`
      await workspace()
      await send('/life disabled customization extension')
      await waitForSend()
      await page
        .locator('.markdown')
        .getByText(
          'Saved Disabled fixture extension disabled. Enable it or restore its previous version in Manage extensions.',
          { exact: true },
        )
        .waitFor()
      let activationState = await extensions()
      assert.equal(
        activationState.extensions.find(
          (extension) => extension.id === 'disabled-fixture-extension',
        )?.enabled,
        false,
      )
      assert.equal(activationState.errors['disabled-fixture-extension'], undefined)
      assert.equal(await page.locator('.chat-error').count(), 0)
      await send('/life worker failure customization extension')
      await waitForSend()
      await page
        .locator('.chat-error')
        .getByText(/Life fixture activation failure/)
        .waitFor()
      activationState = await extensions()
      assert.equal(
        activationState.extensions.find((extension) => extension.id === 'broken-fixture-extension')
          ?.enabled,
        false,
      )
      assert.match(
        activationState.errors['broken-fixture-extension'],
        /Life fixture activation failure/,
      )
      assert.doesNotMatch(
        await page.locator('.messages').textContent(),
        /Installed Broken fixture extension|Broken fixture extension is live/,
      )

      phase = `${provider} local extension finalization disables streaming stop`
      const errorsBeforeDelayedApply = await page.locator('.chat-error').count()
      await send('/life delayed customization extension')
      const applying = page.getByRole('button', { name: 'Applying Life change', exact: true })
      await applying.waitFor()
      assert.equal(await applying.isDisabled(), true)
      assert.equal(await page.getByRole('button', { name: 'Stop agent', exact: true }).count(), 0)
      assert.match(await page.locator('.agent-working').textContent(), /Applying Life change/)
      await waitForSend()
      await page
        .locator('.markdown')
        .getByText(/Installed Delayed fixture extension/)
        .waitFor()
      assert.equal(
        (await extensions()).extensions.find(
          (extension) => extension.id === 'delayed-fixture-extension',
        )?.enabled,
        true,
      )
      assert.equal(await page.locator('.chat-error').count(), errorsBeforeDelayedApply)
      await page.evaluate(async () => {
        for (const id of [
          'disabled-fixture-extension',
          'broken-fixture-extension',
          'delayed-fixture-extension',
        ])
          await window.relay.extensions.remove(id)
      })
      assert.deepEqual((await extensions()).errors, {})
      await page.getByRole('button', { name: 'Research tools', exact: true }).click()
      await extensionFrame()
        .getByRole('heading', { name: 'Research counter', exact: true })
        .waitFor()
      phase = 'Codex and Claude ordinary-thread executable extension generation'
      if (provider === 'codex') {
        await page.evaluate(() => window.relay.extensions.remove('research-tools'))
        await map()
        await page
          .getByRole('heading', { name: 'See the work. Find the next question.', exact: true })
          .waitFor()
      }
    }
    assert.equal(await page.evaluate(() => typeof window.process), 'undefined')
    await page.screenshot({ path: join(artifacts, 'life-extension.png') })

    phase = 'extension hot reload, worker core capabilities and rollback'
    const revisedExtension = {
      ...generatedExtension,
      version: '2.0.0',
      hostCSS: '.workspace-header { border-bottom-width: 3px; }',
      renderer: {
        ...generatedExtension.renderer,
        html: generatedExtension.renderer.html
          .replace('Research counter', 'Research counter version two')
          .replace('>Increment<', '>Increment experiment<'),
      },
      main:
        generatedExtension.main +
        "\nlife.handle('coreUpdates', async () => life.invoke('updates.get', null));" +
        "\nlife.handle('coreConnection', async () => life.invoke('connection.state', null));" +
        "\nlife.handle('unsupportedUi', async () => life.invoke('ui.research.list', null));",
    }
    const revisedState = await page.evaluate(
      (manifest) => window.relay.extensions.apply(manifest),
      revisedExtension,
    )
    assert.deepEqual(revisedState.errors, {})
    assert.ok(revisedState.canRollback.includes('research-tools'))
    await extensionFrame()
      .getByRole('heading', { name: 'Research counter version two', exact: true })
      .waitFor()
    await extensionFrame().getByText('Count: 0', { exact: true }).waitFor()
    await waitUntil(
      async () =>
        (await page
          .locator('.workspace-header')
          .evaluate((header) => getComputedStyle(header).borderBottomWidth)) === '3px',
      'extension host CSS restyles the built-in header',
    )
    await extensionFrame()
      .getByRole('button', { name: 'Increment experiment', exact: true })
      .click()
    await extensionFrame().getByText('Count: 1', { exact: true }).waitFor()
    const workerUpdates = await page.evaluate(() =>
      window.relay.extensions.call('research-tools', 'coreUpdates', null),
    )
    assert.equal(workerUpdates.currentVersion, metadata.version)
    assert.equal(typeof workerUpdates.status, 'string')
    const workerConnection = await page.evaluate(() =>
      window.relay.extensions.call('research-tools', 'coreConnection', null),
    )
    assert.equal(workerConnection.status, 'connected')
    const unavailableUi = await page.evaluate(async () => {
      try {
        await window.relay.extensions.call('research-tools', 'unsupportedUi', null)
        return 'unexpected success'
      } catch (error) {
        return error.message
      }
    })
    assert.match(unavailableUi, /unsupported|unavailable|not available|unknown/i)
    let manager = await openExtensions()
    await manager.getByRole('tab', { name: /^Installed/ }).click()
    await manager
      .getByRole('button', { name: 'Restore previous Research tools', exact: true })
      .click()
    await waitUntil(
      async () => (await extensions()).extensions[0]?.version === '1.0.0',
      'extension rollback',
    )
    await closeDialog()
    await extensionFrame().getByRole('heading', { name: 'Research counter', exact: true }).waitFor()
    await extensionFrame().getByText('Count: 0', { exact: true }).waitFor()
    await waitUntil(
      async () =>
        (await page
          .locator('.workspace-header')
          .evaluate((header) => getComputedStyle(header).borderBottomWidth)) === '1px',
      'rollback removes extension host CSS',
    )
    assert.equal(await page.locator('style[data-life-extension]').count(), 0)

    phase = 'whole workspace replacement and extension management'
    const replacement = {
      ...generatedExtension,
      version: '3.0.0',
      renderer: {
        ...generatedExtension.renderer,
        placement: 'replace',
        html: generatedExtension.renderer.html.replace(
          'Research counter',
          'Whole workspace counter',
        ),
      },
    }
    await applyExtensionSource(replacement)
    await page.getByRole('button', { name: 'Back to Life', exact: true }).waitFor()
    await extensionFrame()
      .getByRole('heading', { name: 'Whole workspace counter', exact: true })
      .waitFor()
    await page.getByRole('button', { name: 'Back to Life', exact: true }).click()
    await map()
    await page
      .getByRole('heading', { name: 'See the work. Find the next question.', exact: true })
      .waitFor()
    const retainedProjects = await page.evaluate(() =>
      JSON.parse(localStorage.getItem('life.research.v1') || '[]'),
    )
    assert.ok(
      retainedProjects.some(
        (project) => project.name === 'Agent evaluation' || project.title === 'Agent evaluation',
      ),
    )
    assert.ok((await page.locator('.thread-row').count()) >= 2)
    manager = await openExtensions()
    await manager.getByRole('tab', { name: /^Installed/ }).click()
    await manager.getByRole('checkbox', { name: 'Enable Research tools', exact: true }).click()
    await waitUntil(
      async () => (await extensions()).extensions[0]?.enabled === false,
      'extension disabled',
    )
    await waitUntil(
      async () =>
        !(await manager
          .getByRole('checkbox', { name: 'Enable Research tools', exact: true })
          .isChecked()),
      'disabled extension rendered in the manager',
    )
    await manager.getByRole('checkbox', { name: 'Enable Research tools', exact: true }).click()
    await waitUntil(
      async () => (await extensions()).extensions[0]?.enabled === true,
      'extension enabled',
    )
    await manager.getByRole('button', { name: 'Delete Research tools', exact: true }).click()
    await manager.getByRole('button', { name: 'Remove', exact: true }).click()
    await waitUntil(async () => (await extensions()).extensions.length === 0, 'extension removed')
    await closeDialog()

    phase =
      'ordinary chats create and compile an arbitrary workspace feature with an npm dependency'
    const sourcePrompt = '/life add a hypothesis backlog directly to the Life workspace'
    const compileRepairPrompt =
      '/life repair the hypothesis backlog after a deliberate compiler failure'
    const reviewSourcePrompt = '/life retitle the hypothesis backlog from its source'
    const runtimeRepairPrompt =
      '/life repair the hypothesis backlog after a deliberate runtime failure'
    const featurePath = 'src/renderer/components/FixtureHypothesisBacklog.tsx'
    const sourceBaseline = await sourceCode()
    assert.equal(sourceBaseline.enabled, false)
    assert.equal(existsSync(join(repository, featurePath)), false)
    const sourceIndex = await page.evaluate(() => window.relay.sourceCode.getContext())
    assert.ok(sourceIndex.paths.includes('src/renderer/App.tsx'))
    assert.ok(sourceIndex.paths.includes('src/main/index.ts'))
    assert.ok(sourceIndex.paths.includes('src/preload/index.ts'))
    const readSourceThread = (prompt) =>
      page.evaluate(
        (requestedPrompt) =>
          JSON.parse(localStorage.getItem('relay.threads.v1') || '[]').find((thread) =>
            thread.messages.some(
              (message) => message.role === 'user' && message.text === requestedPrompt,
            ),
          ),
        prompt,
      )
    const selectSourceThread = async (query) => {
      await page.keyboard.press(process.platform === 'darwin' ? 'Meta+k' : 'Control+k')
      await page.getByRole('dialog', { name: 'Find a thread' }).waitFor()
      await page.getByRole('textbox', { name: 'Search saved threads' }).fill(query)
      assert.equal(await page.locator('.search-results button').count(), 1)
      await page.locator('.search-results button').click()
    }
    const board = () => page.getByRole('region', { name: 'Source hypothesis backlog', exact: true })
    const outlineCSS = () =>
      board().evaluate((element) => {
        const style = getComputedStyle(element)
        return { width: style.outlineWidth, style: style.outlineStyle, color: style.outlineColor }
      })
    const assertOutlineEnabled = async () =>
      assert.deepEqual(await outlineCSS(), {
        width: '3px',
        style: 'solid',
        color: 'rgb(17, 34, 51)',
      })
    const waitForSourceUI = async (heading) => {
      await waitUntil(
        async () => {
          try {
            await workspace()
            return await board().getByRole('heading', { name: heading, exact: true }).isVisible()
          } catch {
            return false
          }
        },
        `compiled source interface renders ${heading}`,
        90000,
      )
      await waitUntil(
        async () => !(await page.evaluate(() => localStorage.getItem('life.pendingSourceApply'))),
        'healthy source build acknowledges and clears the activation checkpoint',
      )
    }
    const watchSourceStates = async () =>
      page.evaluate(() => {
        localStorage.setItem('life.native-source-states', '[]')
        window.relay.sourceCode.onState((state) => {
          const states = JSON.parse(localStorage.getItem('life.native-source-states') || '[]')
          states.push({
            ...state,
            boardText:
              document.querySelector('[aria-label="Source hypothesis backlog"]')?.textContent ||
              null,
          })
          localStorage.setItem('life.native-source-states', JSON.stringify(states))
        })
      })
    const getSourceStates = () =>
      page.evaluate(() => JSON.parse(localStorage.getItem('life.native-source-states') || '[]'))
    await workspace()
    await page.getByRole('button', { name: 'New thread', exact: false }).click()
    await page.getByRole('button', { name: 'Codex By OpenAI' }).click()
    await page
      .getByRole('combobox', { name: 'Agent model', exact: true })
      .selectOption('fixture-model')
    await page.getByRole('combobox', { name: 'Reasoning effort', exact: true }).selectOption('high')
    await page.getByRole('combobox', { name: 'Service tier', exact: true }).selectOption('fast')
    const sourceLogStart = (await fixture.log()).length
    const firstSourceReload = page.waitForEvent('domcontentloaded', { timeout: 90000 })
    await send(sourcePrompt)
    await firstSourceReload
    await waitForSourceUI('Hypothesis backlog')
    const initialSource = await sourceCode()
    assert.equal(initialSource.revision, sourceBaseline.revision + 1)
    assert.equal(initialSource.active.revision, initialSource.revision)
    assert.equal(new URL(initialSource.active.js).protocol, 'life-code:')
    assert.ok(initialSource.path.startsWith(configurationRoot))
    assert.equal(initialSource.error, undefined)
    assert.equal(initialSource.extensions.length, 1)
    assert.equal(initialSource.extensions[0].enabled, true)
    assert.ok(initialSource.extensions[0].files.includes(featurePath))
    assert.ok(initialSource.extensions[0].files.includes('src/renderer/App.tsx'))
    assert.equal(initialSource.extensions[0].dependencies.clsx, '2.1.1')
    assert.equal(await page.locator('iframe').count(), 0)
    assert.equal(
      await board().evaluate(
        (element) => element.ownerDocument === document && window.parent === window,
      ),
      true,
    )
    await board().getByRole('button', { name: 'Add hypothesis', exact: true }).click()
    await board().getByText('Hypotheses: 1', { exact: true }).waitFor()
    assert.equal(
      await board().evaluate((element) => element.classList.contains('has-hypotheses')),
      true,
    )
    const sourceFiles = await page.evaluate(
      (path) => window.relay.sourceCode.getContext({ paths: ['src/renderer/App.tsx', path] }),
      featurePath,
    )
    assert.equal(sourceFiles.dependencies.clsx, '2.1.1')
    assert.ok(
      sourceFiles.files
        .find((file) => file.path === 'src/renderer/App.tsx')
        .content.includes('<FixtureHypothesisBacklog />'),
    )
    assert.ok(
      sourceFiles.files
        .find((file) => file.path === featurePath)
        .content.includes("import clsx from 'clsx'"),
    )
    const installedPackages = await readdir(join(initialSource.path, 'packages'))
    const installedClsx = await Promise.all(
      installedPackages.map(async (directory) => {
        try {
          return JSON.parse(
            await readFile(
              join(initialSource.path, 'packages', directory, 'node_modules/clsx/package.json'),
              'utf8',
            ),
          )
        } catch {
          return undefined
        }
      }),
    )
    assert.ok(
      installedClsx.some(
        (installed) => installed?.name === 'clsx' && installed.version === '2.1.1',
      ),
    )
    await waitUntil(
      async () => Boolean((await readSourceThread(sourcePrompt))?.remoteId),
      'source chat and its remote conversation persisted before renderer reload',
    )
    const originalSourceThread = await readSourceThread(sourcePrompt)
    assert.equal(originalSourceThread.reasoningEffort, 'high')
    assert.equal(originalSourceThread.serviceTier, 'fast')
    const sourceTurns = (await fixture.log())
      .slice(sourceLogStart)
      .filter((entry) => entry.message?.method === 'turn/start')
    assert.equal(sourceTurns.length, 2)
    for (const turn of sourceTurns) {
      assert.equal(turn.message.params.threadId, originalSourceThread.remoteId)
      assert.equal(turn.message.params.effort, 'high')
      assert.equal(turn.message.params.serviceTier, 'fast')
    }
    assert.ok(sourceTurns[1].message.params.input[0].text.includes('Life source read results:\n'))
    await selectSourceThread('hypothesis backlog directly')
    await screenshot('life-source-customization.png')
    const sourceManager = await openSourceCode()
    await sourceManager.getByText('Custom source is active', { exact: true }).waitFor()
    const sourceFilter = sourceManager.getByRole('textbox', {
      name: 'Filter Life source files',
      exact: true,
    })
    await sourceFilter.fill('renderer/App.tsx')
    await sourceManager.getByRole('button', { name: 'renderer/App.tsx', exact: true }).click()
    const appSourceEditor = sourceManager.getByRole('textbox', {
      name: 'Source of src/renderer/App.tsx',
      exact: true,
    })
    await appSourceEditor.waitFor()
    assert.equal(await appSourceEditor.getAttribute('readonly'), null)
    assert.ok((await appSourceEditor.inputValue()).includes('<FixtureHypothesisBacklog />'))
    await sourceFilter.fill('main/index.ts')
    await sourceManager.getByRole('button', { name: 'main/index.ts', exact: true }).click()
    const nativeSourceEditor = sourceManager.getByRole('textbox', {
      name: 'Source of src/main/index.ts',
      exact: true,
    })
    await nativeSourceEditor.waitFor()
    assert.equal(await nativeSourceEditor.getAttribute('readonly'), '')
    await closeDialog()

    phase = 'failed source compilation keeps the live build and repairs in the same conversation'
    await watchSourceStates()
    const compileLogStart = (await fixture.log()).length
    const repairedReload = page.waitForEvent('domcontentloaded', { timeout: 90000 })
    await send(compileRepairPrompt)
    await repairedReload
    await waitForSourceUI('Hypothesis backlog repaired')
    const repairedSource = await sourceCode()
    assert.equal(repairedSource.revision, initialSource.revision + 1)
    assert.equal(repairedSource.error, undefined)
    const failedCompile = (await getSourceStates()).find((state) =>
      state.error?.includes('Life source build failed'),
    )
    assert.ok(failedCompile)
    assert.equal(failedCompile.revision, initialSource.revision)
    assert.equal(failedCompile.active.revision, initialSource.active.revision)
    assert.equal(failedCompile.enabled, true)
    assert.match(failedCompile.error, /FixtureHypothesisBacklog\.tsx/)
    assert.match(failedCompile.boardText, /Hypotheses: 1/)
    const compileTurns = (await fixture.log())
      .slice(compileLogStart)
      .filter((entry) => entry.message?.method === 'turn/start')
    assert.equal(compileTurns.length, 2)
    for (const turn of compileTurns) {
      assert.equal(turn.message.params.threadId, originalSourceThread.remoteId)
      assert.equal(turn.message.params.effort, 'high')
      assert.equal(turn.message.params.serviceTier, 'fast')
    }
    assert.ok(compileTurns[1].message.params.input[0].text.includes('Life repair diagnostics:\n'))
    await selectSourceThread('hypothesis backlog directly')
    assert.equal(await page.locator('.chat-error').count(), 0)
    const repairedThread = await readSourceThread(sourcePrompt)
    assert.equal(repairedThread.id, originalSourceThread.id)
    assert.equal(repairedThread.remoteId, originalSourceThread.remoteId)
    assert.equal(
      repairedThread.messages.filter(
        (message) => message.role === 'user' && message.text === compileRepairPrompt,
      ).length,
      1,
    )

    phase = 'Claude reads and changes the generated source without opening a new conversation'
    await page.getByRole('button', { name: 'New thread', exact: false }).click()
    await page.getByRole('button', { name: 'Claude Code By Anthropic' }).click()
    await page.getByRole('combobox', { name: 'Agent model', exact: true }).selectOption('opus')
    await page.getByRole('combobox', { name: 'Reasoning effort', exact: true }).selectOption('max')
    await page.getByRole('combobox', { name: 'Service tier', exact: true }).selectOption('fast')
    const reviewLogStart = (await fixture.log()).length
    const reviewedReload = page.waitForEvent('domcontentloaded', { timeout: 90000 })
    await send(reviewSourcePrompt)
    await reviewedReload
    await waitForSourceUI('Hypothesis backlog reviewed')
    const reviewedSource = await sourceCode()
    assert.equal(reviewedSource.revision, repairedSource.revision + 1)
    const reviewThread = await readSourceThread(reviewSourcePrompt)
    assert.ok(reviewThread?.remoteId)
    const reviewProcesses = (await fixture.log())
      .slice(reviewLogStart)
      .filter((entry) => entry.provider === 'claude' && entry.argv?.includes('--model=opus'))
    assert.equal(reviewProcesses.length, 2)
    assert.ok(reviewProcesses[1].argv.includes(`--resume=${reviewThread.remoteId}`))
    for (const command of reviewProcesses) {
      assert.ok(command.argv.includes('--effort=max'))
      assert.equal(JSON.parse(command.argv[command.argv.indexOf('--settings') + 1]).fastMode, true)
    }

    phase = 'compiled source bootstrap and conversation history survive a real app restart'
    await application.close()
    application = undefined
    await launch()
    const restartedSource = await sourceCode()
    assert.equal(restartedSource.enabled, true)
    assert.equal(restartedSource.active.revision, reviewedSource.active.revision)
    assert.equal(restartedSource.recovered, false)
    await workspace()
    await board()
      .getByRole('heading', { name: 'Hypothesis backlog reviewed', exact: true })
      .waitFor()
    assert.equal((await readSourceThread(sourcePrompt)).remoteId, originalSourceThread.remoteId)
    assert.equal((await readSourceThread(reviewSourcePrompt)).remoteId, reviewThread.remoteId)
    await page.getByRole('button', { name: 'Connections', exact: true }).click()
    const sourceReconnect = page.getByRole('dialog', { name: 'Connect a machine' })
    await sourceReconnect.waitFor()
    await sourceReconnect
      .locator('.saved-profiles button')
      .filter({ hasText: 'Loopback test workspace' })
      .click()
    await sourceReconnect.getByPlaceholder('Your SSH password').fill(input.password)
    await sourceReconnect.getByRole('button', { name: 'Connect machine', exact: true }).click()
    await sourceReconnect.waitFor({ state: 'hidden' })
    await chooseProject()
    assert.equal(
      (await page.evaluate(() => window.relay.connection.state())).workspace,
      input.workspace,
    )

    phase = 'source management restores the prior compiled application'
    manager = await openSourceCode()
    const rollbackReload = page.waitForEvent('domcontentloaded', { timeout: 90000 })
    await manager.getByRole('button', { name: 'Restore previous', exact: true }).click()
    await rollbackReload
    await waitForSourceUI('Hypothesis backlog repaired')
    const rolledBackSource = await sourceCode()
    assert.equal(rolledBackSource.active.revision, repairedSource.active.revision)
    assert.equal(rolledBackSource.revision, reviewedSource.revision + 1)

    phase = 'runtime failure restores the native interface and repairs the same Claude conversation'
    await selectSourceThread('retitle the hypothesis backlog from its source')
    await watchSourceStates()
    const runtimeLogStart = (await fixture.log()).length
    const fallbackWindow = application.waitForEvent('window', { timeout: 90000 })
    await send(runtimeRepairPrompt)
    page = await fallbackWindow
    page.setDefaultTimeout(15000)
    page.on('pageerror', (error) => rendererErrors.push(error.message))
    let observedFallbackSnapshot
    await waitUntil(
      async () => {
        try {
          const state = await sourceCode()
          if (!state.enabled && state.error?.includes('Life runtime fixture'))
            observedFallbackSnapshot = state
          return (
            state.enabled &&
            state.summary === 'Recover the hypothesis backlog after runtime feedback'
          )
        } catch {
          return false
        }
      },
      'native fallback automatically repairs and activates source',
      90000,
    )
    await waitForSourceUI('Hypothesis backlog recovered')
    const runtimeRepairedSource = await sourceCode()
    assert.equal(runtimeRepairedSource.error, undefined)
    assert.ok(runtimeRepairedSource.revision >= rolledBackSource.revision + 3)
    const runtimeStates = await getSourceStates()
    const failedRuntime =
      runtimeStates.find(
        (state) => !state.enabled && state.error?.includes('Life runtime fixture'),
      ) || observedFallbackSnapshot
    assert.ok(failedRuntime)
    const badRuntimeRevision = runtimeStates.find(
      (state) => state.enabled && state.revision === failedRuntime.revision - 1,
    )?.active?.revision
    assert.ok(badRuntimeRevision)
    const runtimeProcesses = (await fixture.log())
      .slice(runtimeLogStart)
      .filter((entry) => entry.provider === 'claude' && entry.argv?.includes('--model=opus'))
    assert.equal(runtimeProcesses.length, 2)
    for (const command of runtimeProcesses) {
      assert.ok(command.argv.includes(`--resume=${reviewThread.remoteId}`))
      assert.ok(command.argv.includes('--effort=max'))
      assert.equal(JSON.parse(command.argv[command.argv.indexOf('--settings') + 1]).fastMode, true)
    }
    const runtimeThread = await readSourceThread(reviewSourcePrompt)
    assert.equal(runtimeThread.id, reviewThread.id)
    assert.equal(runtimeThread.remoteId, reviewThread.remoteId)
    assert.equal(
      runtimeThread.messages.filter(
        (message) => message.role === 'user' && message.text === runtimeRepairPrompt,
      ).length,
      1,
    )
    await selectSourceThread('retitle the hypothesis backlog from its source')
    assert.equal(await page.locator('.chat-error').count(), 0)
    manager = await openSourceCode()
    const healthyRollbackReload = page.waitForEvent('domcontentloaded', { timeout: 90000 })
    await manager.getByRole('button', { name: 'Restore previous', exact: true }).click()
    await healthyRollbackReload
    await waitForSourceUI('Hypothesis backlog repaired')
    assert.equal((await sourceCode()).active.revision, rolledBackSource.active.revision)
    assert.notEqual((await sourceCode()).active.revision, badRuntimeRevision)
    assert.equal(existsSync(join(repository, featurePath)), false)

    phase = 'source extension conflicts preserve the working interface'
    const conflictBaseline = await sourceCode()
    const creator = conflictBaseline.extensions.find((extension) =>
      extension.files.includes('src/renderer/App.tsx'),
    )
    assert.ok(creator, 'The original workspace feature is a manageable source extension')
    manager = await openExtensions()
    const sourceCard = (id) =>
      manager.locator(`article[data-extension-kind="source"][data-extension-id="${id}"]`)
    await sourceCard(creator.id)
      .getByRole('checkbox', { name: `Enable ${creator.name}`, exact: true })
      .click()
    await manager
      .getByRole('alert')
      .filter({ hasText: /conflict|missing|depend|apply/i })
      .waitFor()
    const conflicted = await sourceCode()
    assert.equal(conflicted.revision, conflictBaseline.revision)
    assert.deepEqual(conflicted.active, conflictBaseline.active)
    assert.deepEqual(conflicted.extensions, conflictBaseline.extensions)
    await sourceCard(creator.id)
      .getByRole('checkbox', { name: `Enable ${creator.name}`, exact: true })
      .waitFor()
    assert.equal(
      await sourceCard(creator.id)
        .getByRole('checkbox', { name: `Enable ${creator.name}`, exact: true })
        .isChecked(),
      true,
    )
    await closeDialog()
    await board().getByRole('button', { name: 'Add experiment', exact: true }).click()
    await board().getByText('Hypotheses: 1', { exact: true }).waitFor()

    phase = 'independent source layers remain live while another layer is disabled or removed'
    const outlineName = 'Workspace source outline'
    const counterName = 'Independent workspace counter'
    const sourceCSS = await page.evaluate(() =>
      window.relay.sourceCode.getContext({ paths: ['src/renderer/enhancements.css'] }),
    )
    await page.evaluate((patch) => window.relay.sourceCode.apply(patch), {
      summary: outlineName,
      baseRevision: conflicted.revision,
      files: [
        {
          path: 'src/renderer/enhancements.css',
          content: `${sourceCSS.files[0].content}\n.source-hypothesis-backlog { outline: 3px solid rgb(17, 34, 51); outline-offset: -3px; }\n`,
        },
      ],
    })
    let independentReload = page.waitForEvent('domcontentloaded', { timeout: 90000 })
    await page.evaluate(() => window.relay.sourceCode.reload())
    await independentReload
    await waitForSourceUI('Hypothesis backlog repaired')
    const outlined = await sourceCode()
    const outline = outlined.extensions.find((extension) => extension.name === outlineName)
    assert.ok(outline)
    await assertOutlineEnabled()
    const counterSource =
      'import { useState } from \'react\'\nexport function FixtureIndependentCounter() { const [count, setCount] = useState(0); return <section aria-label="Independent source counter"><button onClick={() => setCount(count + 1)}>Add source count</button><output>Source count: {count}</output></section> }\n'
    await page.evaluate((patch) => window.relay.sourceCode.apply(patch), {
      summary: counterName,
      baseRevision: outlined.revision,
      files: [
        { path: 'src/renderer/components/FixtureIndependentCounter.tsx', content: counterSource },
        {
          path: 'src/renderer/App.tsx',
          edits: [
            {
              find: "import './enhancements.css'",
              replace:
                "import { FixtureIndependentCounter } from './components/FixtureIndependentCounter'\nimport './enhancements.css'",
            },
            {
              find: '<FixtureHypothesisBacklog />',
              replace:
                '<FixtureHypothesisBacklog />\n                <FixtureIndependentCounter />',
            },
          ],
        },
      ],
    })
    independentReload = page.waitForEvent('domcontentloaded', { timeout: 90000 })
    await page.evaluate(() => window.relay.sourceCode.reload())
    await independentReload
    await waitForSourceUI('Hypothesis backlog repaired')
    const counter = () =>
      page.getByRole('region', { name: 'Independent source counter', exact: true })
    await counter().getByRole('button', { name: 'Add source count', exact: true }).click()
    await counter().getByText('Source count: 1', { exact: true }).waitFor()
    assert.ok((await sourceCode()).extensions.some((extension) => extension.name === counterName))
    manager = await openExtensions()
    let layerReload = page.waitForEvent('domcontentloaded')
    await sourceCard(outline.id)
      .getByRole('checkbox', { name: `Enable ${outlineName}`, exact: true })
      .click()
    await layerReload
    await waitForSourceUI('Hypothesis backlog repaired')
    const disabledCSSProof = await page.evaluate(async () => {
      const state = await window.relay.sourceCode.get()
      const context = await window.relay.sourceCode.getContext({
        paths: ['src/renderer/enhancements.css'],
      })
      const css = await (await fetch(state.active.css)).text()
      return {
        state,
        context,
        css,
        styleSheets: Array.from(document.styleSheets).map((sheet) => sheet.href),
        computedOutline: getComputedStyle(
          document.querySelector('[aria-label="Source hypothesis backlog"]'),
        ).outline,
      }
    })
    await writeFile(
      join(artifacts, 'desktop-source-disabled-css-proof.json'),
      JSON.stringify(disabledCSSProof, null, 2),
    )
    assert.equal(
      disabledCSSProof.context.files[0].content.includes('.source-hypothesis-backlog { outline:'),
      false,
    )
    assert.equal(disabledCSSProof.css.includes('.source-hypothesis-backlog'), false)
    assert.equal((await outlineCSS()).style, 'none')
    await counter().getByRole('button', { name: 'Add source count', exact: true }).click()
    await counter().getByText('Source count: 1', { exact: true }).waitFor()
    const disabledLayers = await sourceCode()
    assert.equal(
      disabledLayers.extensions.find((extension) => extension.id === outline.id).enabled,
      false,
    )
    assert.equal(
      disabledLayers.extensions.find((extension) => extension.name === counterName).enabled,
      true,
    )
    manager = await openExtensions()
    layerReload = page.waitForEvent('domcontentloaded')
    await sourceCard(outline.id)
      .getByRole('checkbox', { name: `Enable ${outlineName}`, exact: true })
      .click()
    await layerReload
    await waitForSourceUI('Hypothesis backlog repaired')
    await assertOutlineEnabled()

    phase = 'editing an existing source extension preserves its identity and independent layers'
    const beforeLayerEdit = await sourceCode()
    const editableLayer = await page.evaluate(
      (id) => window.relay.sourceCode.exportExtension(id),
      outline.id,
    )
    editableLayer.version = '1.0.1'
    editableLayer.files.push({
      kind: 'create',
      path: 'src/shared/native-layer-edit.ts',
      content: 'export const nativeLayerEdited = true\n',
    })
    manager = await openExtensions()
    await sourceCard(outline.id).getByRole('button', { name: 'Edit code', exact: true }).click()
    await manager.getByRole('textbox', { name: 'Extension manifest', exact: true }).fill(
      JSON.stringify({
        format: 'life-extension',
        formatVersion: 1,
        kind: 'source',
        extension: editableLayer,
      }),
    )
    layerReload = page.waitForEvent('domcontentloaded', { timeout: 90000 })
    await manager.getByRole('button', { name: 'Apply source', exact: true }).click()
    await layerReload
    await waitForSourceUI('Hypothesis backlog repaired')
    const editedLayers = await sourceCode()
    assert.equal(editedLayers.extensions.length, beforeLayerEdit.extensions.length)
    assert.equal(
      editedLayers.extensions.find((extension) => extension.id === outline.id).version,
      '1.0.1',
    )
    assert.ok(
      editedLayers.extensions
        .find((extension) => extension.id === outline.id)
        .files.includes('src/shared/native-layer-edit.ts'),
    )
    const editedFile = await page.evaluate(() =>
      window.relay.sourceCode.getContext({ paths: ['src/shared/native-layer-edit.ts'] }),
    )
    assert.equal(editedFile.files[0].content, 'export const nativeLayerEdited = true\n')
    await counter().getByRole('button', { name: 'Add source count', exact: true }).click()
    await counter().getByText('Source count: 1', { exact: true }).waitFor()

    phase = 'source extension export and explicit public sharing preview'
    manager = await openExtensions()
    await screenshot('life-extensions.png')
    const portablePath = join(artifacts, 'desktop-source-extension.life-extension.json')
    await rm(portablePath, { force: true })
    await application.evaluate(({ BrowserWindow }, file) => {
      globalThis.__lifePortableDownload = undefined
      BrowserWindow.getAllWindows()[0].webContents.session.once('will-download', (_event, item) => {
        globalThis.__lifePortableDownload = { filename: item.getFilename(), state: 'started' }
        item.setSavePath(file)
        item.once('done', (_done, state) => {
          globalThis.__lifePortableDownload.state = state
        })
      })
    }, portablePath)
    await sourceCard(outline.id)
      .getByRole('button', { name: `Export ${outlineName}`, exact: true })
      .click()
    await waitUntil(
      async () =>
        (await application.evaluate(() => globalThis.__lifePortableDownload))?.state ===
        'completed',
      'native portable extension download completed',
    )
    assert.equal(
      (await application.evaluate(() => globalThis.__lifePortableDownload)).filename,
      `${outline.id}.life-extension.json`,
    )
    const portable = JSON.parse(await readFile(portablePath, 'utf8'))
    assert.equal(portable.format, 'life-extension')
    assert.equal(portable.kind, 'source')
    assert.equal(portable.extension.id, outline.id)
    const rawExport = await page.evaluate(
      (id) => window.relay.sourceCode.exportExtension(id),
      outline.id,
    )
    assert.deepEqual(portable.extension, rawExport)
    const portableJSON = JSON.stringify(portable)
    assert.equal(portableJSON.includes('fixture-password'), false)
    assert.equal(portableJSON.includes('Loopback test workspace'), false)
    assert.equal(portableJSON.includes(originalSourceThread.remoteId), false)
    // Replace the two publication IPC handlers in this isolated test instance.
    // Production network validation and payload construction have separate unit coverage.
    // These UI checks cannot create a real Gist, even if an actual token is present in the environment.
    await application.evaluate(({ ipcMain }, bundle) => {
      globalThis.__lifeSharing = { calls: [], bundle }
      ipcMain.removeHandler('extension-sharing:publish')
      ipcMain.removeHandler('extension-sharing:inspect-public')
      ipcMain.handle('extension-sharing:publish', (_event, request) => {
        if (JSON.stringify(request.bundle) !== JSON.stringify(globalThis.__lifeSharing.bundle))
          throw new Error('Unexpected sharing payload')
        if (request.token !== `ghp_${'a'.repeat(24)}`) throw new Error('Unexpected fixture token')
        globalThis.__lifeSharing.calls.push({ method: 'publish', id: request.bundle.extension.id })
        return new Promise((resolvePublication) =>
          setTimeout(
            () =>
              resolvePublication({
                id: '0123456789abcdef0123456789abcdef',
                url: 'https://gist.github.com/0123456789abcdef0123456789abcdef',
                filename: 'extension.life-extension.json',
              }),
            1500,
          ),
        )
      })
      ipcMain.handle('extension-sharing:inspect-public', (_event, link) => {
        if (link !== 'https://gist.github.com/0123456789abcdef0123456789abcdef')
          throw new Error('Unexpected fixture public link')
        globalThis.__lifeSharing.calls.push({
          method: 'inspect',
          id: globalThis.__lifeSharing.bundle.extension.id,
        })
        return {
          id: '0123456789abcdef0123456789abcdef',
          url: link,
          bundle: globalThis.__lifeSharing.bundle,
        }
      })
    }, portable)
    await sourceCard(outline.id)
      .getByRole('button', { name: `Share ${outlineName} publicly`, exact: true })
      .click()
    const sharing = page.getByRole('dialog', { name: 'Share extension publicly', exact: true })
    await sharing.waitFor()
    await sharing.getByText('Review complete extension code', { exact: true }).click()
    assert.deepEqual(JSON.parse(await sharing.locator('pre').textContent()), portable)
    assert.equal((await application.evaluate(() => globalThis.__lifeSharing.calls)).length, 0)
    assert.equal(
      await sharing.getByRole('button', { name: 'Publish publicly', exact: true }).isDisabled(),
      true,
    )
    await sharing.getByLabel('GitHub token', { exact: true }).fill(`ghp_${'a'.repeat(24)}`)
    assert.equal((await application.evaluate(() => globalThis.__lifeSharing.calls)).length, 0)
    await sharing.getByRole('button', { name: 'Publish publicly', exact: true }).click()
    await sharing.getByRole('button', { name: 'Publishing…', exact: true }).waitFor()
    assert.equal(
      await sharing.getByRole('button', { name: 'Publishing…', exact: true }).isDisabled(),
      true,
    )
    assert.equal(
      await sharing.getByRole('button', { name: 'Cancel', exact: true }).isDisabled(),
      true,
    )
    await page.keyboard.press('Escape')
    assert.equal(await sharing.isVisible(), true)
    await sharing.getByText('Your extension is public.', { exact: true }).waitFor()
    assert.equal(
      (await application.evaluate(() => globalThis.__lifeSharing.calls)).filter(
        (call) => call.method === 'publish',
      ).length,
      1,
    )
    await sharing.getByRole('button', { name: 'Copy link', exact: true }).click()
    await sharing.getByRole('button', { name: 'Link copied', exact: true }).waitFor()
    assert.equal(
      await application.evaluate(({ clipboard }) => clipboard.readText()),
      'https://gist.github.com/0123456789abcdef0123456789abcdef',
    )
    await application.evaluate(({ shell }) => {
      globalThis.__lifeShareOpenExternal = shell.openExternal
      globalThis.__lifeShareURLs = []
      shell.openExternal = async (url) => {
        globalThis.__lifeShareURLs.push(url)
      }
    })
    try {
      await sharing.getByRole('button', { name: 'Open public page', exact: true }).click()
      await waitUntil(
        async () =>
          (await application.evaluate(() => globalThis.__lifeShareURLs)).includes(
            'https://gist.github.com/0123456789abcdef0123456789abcdef',
          ),
        'reviewed public page uses the native browser opener',
      )
    } finally {
      await application.evaluate(({ shell }) => {
        shell.openExternal = globalThis.__lifeShareOpenExternal
        delete globalThis.__lifeShareOpenExternal
      })
    }
    await sharing.getByRole('button', { name: 'Close dialog', exact: true }).click()
    await sourceCard(outline.id)
      .getByRole('button', { name: `Share ${outlineName} publicly`, exact: true })
      .click()
    await sharing.waitFor()
    assert.equal(await sharing.getByLabel('GitHub token', { exact: true }).inputValue(), '')
    await sharing.getByRole('button', { name: 'Cancel', exact: true }).click()
    assert.equal(
      (await page.evaluate(() => JSON.stringify(localStorage))).includes(`ghp_${'a'.repeat(24)}`),
      false,
    )

    const removeOutline = async () => {
      manager = await openExtensions()
      await sourceCard(outline.id)
        .getByRole('button', { name: `Delete ${outlineName}`, exact: true })
        .click()
      const reloaded = page.waitForEvent('domcontentloaded')
      await sourceCard(outline.id).getByRole('button', { name: 'Remove', exact: true }).click()
      await reloaded
      await waitForSourceUI('Hypothesis backlog repaired')
      assert.equal(
        (await sourceCode()).extensions.some((extension) => extension.id === outline.id),
        false,
      )
      assert.equal(
        (await page.evaluate(() => window.relay.sourceCode.getContext())).paths.includes(
          'src/shared/native-layer-edit.ts',
        ),
        false,
      )
      assert.equal((await outlineCSS()).style, 'none')
      await counter().getByRole('button', { name: 'Add source count', exact: true }).click()
      await counter().getByText('Source count: 1', { exact: true }).waitFor()
    }
    await closeDialog()
    await removeOutline()

    phase = 'portable source extension file import requires review before compilation'
    manager = await openExtensions()
    await manager.getByRole('tab', { name: 'Import', exact: true }).click()
    const beforeFileImport = await sourceCode()
    await manager.getByLabel('Extension file', { exact: true }).setInputFiles(portablePath)
    await manager.getByRole('button', { name: 'Preview extension', exact: true }).click()
    await manager.getByRole('button', { name: 'Install extension', exact: true }).waitFor()
    assert.equal((await sourceCode()).revision, beforeFileImport.revision)
    layerReload = page.waitForEvent('domcontentloaded')
    await manager.getByRole('button', { name: 'Install extension', exact: true }).click()
    await layerReload
    await waitForSourceUI('Hypothesis backlog repaired')
    await assertOutlineEnabled()
    assert.deepEqual(
      await page.evaluate((id) => window.relay.sourceCode.exportExtension(id), outline.id),
      rawExport,
    )
    await removeOutline()

    phase = 'public source extension link preview has no install side effects'
    manager = await openExtensions()
    await manager.getByRole('tab', { name: 'Import', exact: true }).click()
    const beforePublicImport = await sourceCode()
    await manager
      .getByRole('textbox', { name: 'Public extension link', exact: true })
      .fill('https://gist.github.com/0123456789abcdef0123456789abcdef')
    await manager.getByRole('button', { name: 'Preview public extension', exact: true }).click()
    await manager.getByRole('button', { name: 'Install extension', exact: true }).waitFor()
    assert.equal((await sourceCode()).revision, beforePublicImport.revision)
    assert.equal(
      (await application.evaluate(() => globalThis.__lifeSharing.calls)).filter(
        (call) => call.method === 'inspect',
      ).length,
      1,
    )
    layerReload = page.waitForEvent('domcontentloaded')
    await manager.getByRole('button', { name: 'Install extension', exact: true }).click()
    await layerReload
    await waitForSourceUI('Hypothesis backlog repaired')
    await assertOutlineEnabled()
    assert.equal(
      (await sourceCode()).extensions.find((extension) => extension.name === counterName).enabled,
      true,
    )
    await writeFile(
      join(artifacts, 'desktop-source-layer-proof.json'),
      JSON.stringify(
        {
          portable,
          sharing: await application.evaluate(() => globalThis.__lifeSharing.calls),
          source: await sourceCode(),
          realPublication: false,
        },
        null,
        2,
      ),
    )

    let tailwindVerified = false
    let tailwindCompilerProcessVerified = false
    if (process.env.LIFE_TEST_TAILWIND === '1') {
      phase =
        'Electron compiles optional Tailwind with real npm and an isolated native child process'
      const beforeTailwind = await sourceCode()
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
        'The native Tailwind proof must start without a previously installed Tailwind cache.',
      )
      const tailwindPatch = {
        summary:
          'Verify optional Tailwind utilities and directives in the actual Electron source compiler',
        baseRevision: beforeTailwind.revision,
        dependencies: { tailwindcss: '4.3.3', '@tailwindcss/postcss': '4.3.3', postcss: '8.5.29' },
        files: [
          {
            path: 'src/renderer/components/FixtureTailwindProof.tsx',
            content:
              'import \'../fixture-tailwind.css\'\nexport function FixtureTailwindProof() { return <div data-testid="native-tailwind-proof" className="p-[28px] font-bold underline bg-life-proof native-tailwind-apply">Native Tailwind compiled</div> }\n',
          },
          {
            path: 'src/renderer/fixture-tailwind.css',
            content:
              '@import "tailwindcss/theme.css";\n@import "tailwindcss/utilities.css";\n@theme { --color-life-proof: #123456; }\n.native-tailwind-apply { @apply px-[19px]; }\n',
          },
          {
            path: 'src/renderer/App.tsx',
            edits: [
              {
                find: "import './enhancements.css'",
                replace:
                  "import { FixtureTailwindProof } from './components/FixtureTailwindProof'\nimport './enhancements.css'",
              },
              {
                find: '<FixtureHypothesisBacklog />',
                replace: '<FixtureHypothesisBacklog />\n                <FixtureTailwindProof />',
              },
            ],
          },
        ],
      }
      // Observe the actual compiler launch in Electron main without replacing its
      // implementation, inputs or output. Keep generated code and CSS out of logs.
      await application.evaluate(() => {
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
        tailwindState = await page.evaluate(
          (patch) => window.relay.sourceCode.apply(patch),
          tailwindPatch,
        )
      } finally {
        compilerProcess = await application.evaluate(() => {
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
      assert.ok(compilerProcess.calls.length > 0, 'Tailwind must launch its own compiler process.')
      for (const call of compilerProcess.calls) {
        assert.equal(call.executable, compilerProcess.executablePath)
        assert.ok(Number.isInteger(call.pid) && call.pid !== compilerProcess.mainPid)
        assert.ok(call.cwd.startsWith(beforeTailwind.path))
        assert.equal(call.runAsNode, '1')
        assert.equal(call.windowsHide, true)
        assert.equal(call.closed, true, 'The compiler must close before source apply completes.')
        assert.equal(call.code, 0)
        assert.equal(call.signal, null)
      }
      tailwindCompilerProcessVerified = true
      const tailwindReload = page.waitForEvent('domcontentloaded', { timeout: 90000 })
      await page.evaluate(() => window.relay.sourceCode.reload())
      await tailwindReload
      await waitForSourceUI('Hypothesis backlog repaired')
      const proof = page.getByTestId('native-tailwind-proof')
      await proof.waitFor()
      const computedTailwind = await proof.evaluate((element) => {
        const style = getComputedStyle(element)
        return {
          backgroundColor: style.backgroundColor,
          paddingTop: style.paddingTop,
          paddingLeft: style.paddingLeft,
          fontWeight: style.fontWeight,
          textDecorationLine: style.textDecorationLine,
        }
      })
      assert.deepEqual(computedTailwind, {
        backgroundColor: 'rgb(18, 52, 86)',
        paddingTop: '28px',
        paddingLeft: '19px',
        fontWeight: '700',
        textDecorationLine: 'underline',
      })
      const tailwindCss = await page.evaluate(async () => {
        const state = await window.relay.sourceCode.get()
        return await (await fetch(state.active.css)).text()
      })
      assert.ok(tailwindCss.includes('.bg-life-proof'))
      assert.ok(tailwindCss.includes('.native-tailwind-apply'))
      assert.doesNotMatch(tailwindCss, /@apply|@theme|@import\s*["']tailwindcss/)
      await writeFile(
        join(artifacts, 'desktop-tailwind-proof.json'),
        JSON.stringify(
          {
            packaged: Boolean(selectedBinary),
            version: metadata.version,
            coldInstall: true,
            compilerProcess,
            source: await sourceCode(),
            computed: computedTailwind,
          },
          null,
          2,
        ),
      )
      manager = await openSourceCode()
      const tailwindRollbackReload = page.waitForEvent('domcontentloaded', { timeout: 90000 })
      await manager.getByRole('button', { name: 'Restore previous', exact: true }).click()
      await tailwindRollbackReload
      await waitForSourceUI('Hypothesis backlog repaired')
      assert.equal((await sourceCode()).active.revision, beforeTailwind.active.revision)
      assert.equal(await page.getByTestId('native-tailwind-proof').count(), 0)
      tailwindVerified = true
    }

    phase = 'second instance preserves live extensions'
    await applyExtensionSource({ ...replacement, version: '4.0.0' })
    await extensionFrame()
      .getByRole('heading', { name: 'Whole workspace counter', exact: true })
      .waitFor()
    const secondary = spawn(executablePath, smokeLaunchArgs, {
      cwd: repository,
      env: {
        ...process.env,
        XDG_CONFIG_HOME: configurationRoot,
        ...(process.platform === 'win32' ? { APPDATA: configurationRoot } : {}),
      },
      stdio: ['ignore', 'ignore', 'pipe'],
    })
    let secondaryStderr = ''
    secondary.stderr.setEncoding('utf8')
    secondary.stderr.on('data', (data) => {
      secondaryStderr = (secondaryStderr + data).slice(-16 * 1024)
    })
    const secondaryDiagnostics = () =>
      `Secondary Electron stderr (last 16384 characters):\n${secondaryStderr || '(empty)'}`
    const secondaryExit = await new Promise((resolveExit, rejectExit) => {
      const timeout = setTimeout(() => {
        secondary.kill('SIGKILL')
        rejectExit(new Error(`The second app instance did not exit.\n${secondaryDiagnostics()}`))
      }, 15000)
      secondary.once('error', (error) => {
        clearTimeout(timeout)
        rejectExit(
          new Error(
            `The second app instance failed to launch: ${error.message}\n${secondaryDiagnostics()}`,
            { cause: error },
          ),
        )
      })
      secondary.once('close', (code, signal) => {
        clearTimeout(timeout)
        resolveExit({ code, signal })
      })
    }).finally(() =>
      writeFile(join(artifacts, 'desktop-secondary-stderr.log'), secondaryStderr).catch(() => {}),
    )
    assert.deepEqual(secondaryExit, { code: 0, signal: null }, secondaryDiagnostics())
    assert.equal((await extensions()).extensions[0]?.enabled, true)
    await extensionFrame().getByRole('button', { name: 'Increment', exact: true }).click()
    await extensionFrame().getByText('Count: 1', { exact: true }).waitFor()

    phase = 'main-process recovery from a hanging generated iframe'
    const extensionDirectory = (await extensions()).path
    const hangingExtension = {
      ...replacement,
      version: '5.0.0',
      renderer: {
        ...replacement.renderer,
        js: 'document.body.dataset.smokeHang = "running"; while (true) {}',
      },
    }
    // Returning immediately keeps this call independent of the generated frame's CPU loop.
    await page.evaluate((manifest) => {
      void window.relay.extensions.apply(manifest)
    }, hangingExtension)
    await waitUntil(async () => {
      const manifest = JSON.parse(
        await readFile(join(extensionDirectory, 'research-tools.json'), 'utf8'),
      )
      return manifest.version === '5.0.0'
    }, 'hanging extension installed')
    await new Promise((resolveDelay) => setTimeout(resolveDelay, 400))
    const recoveredWindow = application.waitForEvent('window', { timeout: 15000 })
    await application.evaluate(({ BrowserWindow }) => {
      BrowserWindow.getAllWindows()[0].webContents.emit(
        'before-input-event',
        { preventDefault() {} },
        { type: 'keyDown', key: 'L', control: true, meta: false, shift: true },
      )
    })
    page = await recoveredWindow
    page.setDefaultTimeout(15000)
    page.on('pageerror', (error) => rendererErrors.push(error.message))
    await page.getByRole('dialog', { name: 'Manage extensions', exact: true }).waitFor()
    await closeDialog()
    await map()
    await page
      .getByRole('heading', { name: 'See the work. Find the next question.', exact: true })
      .waitFor()
    await waitUntil(
      async () => (await extensions()).extensions.every((extension) => !extension.enabled),
      'main recovery disables all executable extensions',
    )
    await waitUntil(
      async () => !(await page.locator('iframe[title="Research tools"]').count()),
      'hung frame removed',
    )
    assert.equal(
      (await page.evaluate(() => window.relay.connection.state())).status,
      'disconnected',
    )
    assert.deepEqual((await extensions()).errors, {})
    const recoveredSource = await sourceCode()
    assert.equal(recoveredSource.enabled, false)
    assert.equal(recoveredSource.active, undefined)
    assert.equal(
      await page.getByRole('region', { name: 'Source hypothesis backlog', exact: true }).count(),
      0,
    )
    const preservedSource = await page.evaluate(
      (path) => window.relay.sourceCode.getContext({ paths: [path] }),
      featurePath,
    )
    assert.ok(preservedSource.files[0].content.includes('FixtureHypothesisBacklog'))
    await closeDialog()
    await page
      .getByRole('heading', { name: 'See the work. Find the next question.', exact: true })
      .waitFor()

    assert.deepEqual(rendererErrors, [], 'No renderer errors across the native flows')
    await writeFile(
      join(artifacts, 'desktop-smoke-result.json'),
      JSON.stringify(
        {
          executablePath,
          packaged: Boolean(selectedBinary),
          platform: process.platform,
          version: metadata.version,
          tailwindVerified,
          tailwindCompilerProcessVerified,
          projectCount: projects.length,
          providerLogEntries: (await fixture.log()).length,
          rendererErrors,
          screenshots: [
            'life.png',
            'life-light.png',
            'life-workspace.png',
            'life-workspace-light.png',
            'life-project-picker.png',
            'life-source-customization.png',
            'life-extensions.png',
          ],
          assertions: [
            'fresh chat workspace with an empty research map',
            'isolated sandboxed Electron',
            'platform window controls',
            'persisted dark/light themes',
            'offline ordinary-thread customization and Settings undo',
            'research dependencies and filters',
            'Mermaid SVG and download',
            'OpenSSH config resolution',
            'real loopback host trust and SFTP',
            'machine connection before project selection with coding and files blocked until chosen',
            'post-connect SFTP directory browsing and project choice after reconnect',
            'real SSH unified Git diff with file ranges, line numbers, wrapping and collapse controls',
            'switching projects preserves thread scope and requires returning to its original directory',
            'real SSH HTTP forwarding with local collision mapping and browser URL',
            'automatic port forwarding default, persisted toggle and socket cleanup',
            'Codex and Claude streaming, approvals and questions',
            'interruption and saved chat navigation',
            'early initialization cancellation and replacement send',
            'same-thread Codex and Claude declarative customization',
            'normal replies, clarification and no-op proposals leave settings unchanged',
            'Life turn cancellation and SSH reconnect preserve local and remote conversation identity',
            'project response markers are never applied as Life settings',
            'existing native selects preserved while ambiguous source changes request clarification',
            'reasoning and service-tier choices discovered remotely and delivered to both providers',
            'custom commands and Mermaid panels',
            'live configuration file watch and undo',
            'same-thread Codex and Claude executable extension generation',
            'disabled and startup-failed extensions never report a live install',
            'local extension finalization disables streaming interruption until applied',
            'sandboxed iframe and local Node worker',
            'worker core capabilities and UI capability rejection',
            'extension hot reload, rollback, disable and remove',
            'extension host CSS and built-in style rollback',
            'whole workspace replacement and Back to Life',
            'ordinary chats read and rewrite actual Life TSX source with an interactive new workspace feature',
            'real npm dependency installation and bundled renderer compilation in Electron',
            ...(tailwindVerified
              ? [
                  'cold npm-installed Tailwind utilities and directives compile in a separate Electron Node child, close cleanly and render real styles',
                ]
              : []),
            'source compile failure preserves the active application and repairs the same conversation',
            'compiled source and chat history persist across reload, app restart and SSH reconnect',
            'source management inspects writable renderer and read-only native files and restores previous builds',
            'every code customization is a named manageable source extension',
            'conflicting source-layer changes preserve the active interface and installed layers',
            'source-layer disable and removal preserve independent interactive changes',
            'source-layer editing preserves its identity and replaces its stored code',
            'portable source extension file export and reviewed import roundtrip',
            'explicit public-sharing review and publish plus public-link preview and installation use mocked IPC without real publication',
            'runtime startup failure restores the built-in interface and automatically repairs the same conversation',
            'rollback avoids known-failing source revisions and native recovery preserves source files',
            'single-instance lock preserves extensions',
            'main-process recovery from hanging generated UI',
          ],
        },
        null,
        2,
      ) + '\n',
    )
    if (process.platform !== 'darwin') {
      const closed = application.waitForEvent('close')
      await page
        .getByRole('button', { name: 'Close window', exact: true })
        .click()
        .catch((error) => {
          if (!/Target page, context or browser has been closed/.test(error.message)) throw error
        })
      await closed
      application = undefined
    }
    console.log(
      `Native Electron smoke passed (${selectedBinary ? 'packaged' : 'built source'}): research, themes, native controls, config aliases, real SSH/SFTP, both providers, customization, executable extensions, hot reload, rollback and emergency recovery. Screenshots: ${screenshots}`,
    )
  } catch (error) {
    failed = true
    console.error(`Desktop smoke failed during: ${phase}: ${error.message}`)
    if (page && !page.isClosed()) {
      const diagnostics = await page
        .evaluate(async () => ({
          source: await window.relay.sourceCode.get(),
          connection: await window.relay.connection.state(),
        }))
        .catch(() => undefined)
      if (diagnostics)
        await writeFile(
          join(artifacts, 'desktop-failure-state.json'),
          JSON.stringify(diagnostics, null, 2),
        ).catch(() => {})
      await page
        .screenshot({ path: join(artifacts, 'desktop-failure.png'), timeout: 3000 })
        .catch(() => {})
      const body = await page
        .locator('body')
        .innerText({ timeout: 3000 })
        .catch(() => undefined)
      if (body !== undefined) {
        await writeFile(join(artifacts, 'desktop-failure.txt'), body).catch(() => {})
        await page
          .content()
          .then((content) => writeFile(join(artifacts, 'desktop-failure.html'), content))
          .catch(() => {})
      }
    }
    throw error
  } finally {
    if (application) {
      const child = application.process()
      const timeout = setTimeout(() => child.kill('SIGKILL'), 5000)
      try {
        await application.close().catch(() => {})
      } finally {
        clearTimeout(timeout)
      }
    }
    await fixture.close()
    remoteService.closeAllConnections()
    await new Promise((resolveClosed) => remoteService.close(resolveClosed))
    if (failed && process.env.LIFE_TEST_KEEP_FAILURE === '1') {
      console.error(`Preserved failed desktop fixture data for debugging: ${configurationRoot}`)
    } else await rm(configurationRoot, { recursive: true, force: true })
  }
}

run().catch((error) => {
  console.error(error)
  process.exitCode = 1
})
