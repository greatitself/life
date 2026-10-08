#!/usr/bin/env node
/*
 * Native Electron smoke coverage; no provider accounts or inference are used.
 * Run after npm run build. LIFE_ELECTRON_BINARY selects an unpacked packaged app;
 * LIFE_TEST_SOURCE=1 uses the development Electron binary even when a package exists.
 * Linux uses xvfb-run automatically when DISPLAY is absent. Root's --no-sandbox
 * is confined to this test launcher; application webPreferences remain sandboxed.
 */
const assert = require('node:assert/strict')
const { existsSync } = require('node:fs')
const { mkdtemp, mkdir, readFile, rm, writeFile } = require('node:fs/promises')
const { join, resolve } = require('node:path')
const { tmpdir } = require('node:os')
const { spawn, spawnSync } = require('node:child_process')
const { _electron: electron } = require('playwright')
const { build } = require('esbuild')

const repository = resolve(__dirname, '..')
const artifacts = join(repository, 'output', 'playwright')
const screenshots = join(repository, 'docs', 'images')

if (process.platform === 'linux' && !process.env.DISPLAY) {
  const probe = spawnSync('xvfb-run', ['--help'], { stdio: 'ignore' })
  if (probe.status !== 0)
    throw new Error('Native desktop tests require DISPLAY or xvfb-run on Linux.')
  const child = spawnSync(
    'xvfb-run',
    ['-a', '-s', '-screen 0 1600x1000x24', process.execPath, __filename],
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
  const bundledFixture = join(repository, 'output', 'desktop-ssh-fixture.cjs')
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
    (process.env.LIFE_TEST_SOURCE !== '1' && packagedBinary && existsSync(packagedBinary)
      ? packagedBinary
      : undefined)
  const executablePath = selectedBinary || require('electron')
  const rendererErrors = []
  let application
  let page
  let phase = 'launch'

  const launch = async () => {
    application = await electron.launch({
      executablePath,
      args: [
        ...(selectedBinary ? [] : [repository]),
        ...(process.platform === 'linux' && process.getuid?.() === 0 ? ['--no-sandbox'] : []),
        '--disable-dev-shm-usage',
      ],
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
    await page
      .getByRole('heading', { name: 'See the work. Find the next question.', exact: true })
      .waitFor()
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
  const configuration = () => page.evaluate(() => window.relay.customization.get())
  const openCustomization = async () => {
    await page.getByRole('button', { name: 'Customize Life', exact: true }).first().click()
    const dialog = page.getByRole('dialog', { name: 'Make Life yours' })
    await dialog.waitFor()
    return dialog
  }
  const closeDialog = () => page.keyboard.press('Escape')
  const applyPrompt = async (dialog, prompt) => {
    await dialog.getByRole('textbox', { name: 'Describe how to customize Life' }).fill(prompt)
    await dialog.getByRole('button', { name: 'Apply prompt', exact: true }).click()
    await dialog.locator('.form-success').waitFor()
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
  const composer = () => page.getByRole('textbox', { name: 'Message your coding agent' })
  const send = async (prompt) => {
    await composer().fill(prompt)
    await page.getByRole('button', { name: 'Send message', exact: true }).click()
  }
  const waitForSend = () =>
    page.getByRole('button', { name: 'Send message', exact: true }).waitFor()
  const extensions = () => page.evaluate(() => window.relay.extensions.get())
  const extensionFrame = () => page.frameLocator('iframe[title="Research tools"]')
  const openExtensions = async () => {
    const replacementManager = page.getByRole('button', {
      name: 'Manage extensions',
      exact: true,
    })
    if (await replacementManager.isVisible()) await replacementManager.click()
    else await page.getByRole('button', { name: /^Live extensions/ }).click()
    const manager = page.getByRole('dialog', { name: 'Build Life by prompting' })
    await manager.waitFor()
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
    phase = 'fresh research map and native window controls'
    assert.match(await page.title(), /^Life/)
    assert.equal(await page.evaluate(() => window.relay.platform), process.platform)
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

    phase = 'offline customization and persisted theme'
    const original = (await configuration()).config
    let dialog = await openCustomization()
    await applyPrompt(
      dialog,
      'Switch to light theme and set font size to 16 and use compact layout',
    )
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
    await dialog.getByRole('button', { name: 'Undo', exact: true }).click()
    await waitUntil(
      async () => JSON.stringify((await configuration()).config) === JSON.stringify(original),
      'customization undo',
    )
    await closeDialog()
    await page.getByRole('button', { name: 'Switch to light theme', exact: true }).click()
    await waitUntil(
      async () => (await configuration()).config.theme === 'light',
      'theme toggle persistence',
    )
    await application.close()
    application = undefined
    await launch()
    assert.equal(await page.locator('html').getAttribute('data-theme'), 'light')
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
    await connection.getByPlaceholder('~/projects/my-app').fill(input.workspace)
    await connection.getByRole('button', { name: 'Connect machine', exact: true }).click()
    const trust = page.getByRole('dialog', { name: 'Trust this machine?' })
    await trust.waitFor()
    assert.match(await trust.locator('code').textContent(), /^SHA256:/)
    await trust.getByRole('button', { name: 'Trust and connect', exact: true }).click()
    await connection.waitFor({ state: 'hidden' })
    await workspace()
    await page.getByText('SSH connected', { exact: true }).waitFor()
    const profiles = await page.evaluate(() => window.relay.profiles.list())
    assert.equal(profiles.length, 1)
    assert.equal(profiles[0].password, undefined)
    assert.equal(profiles[0].sshConfig.alias, 'life-fixture')
    const state = await page.evaluate(() => window.relay.connection.state())
    assert.match(state.codex, /test/)
    assert.match(state.claude, /test/)
    await page.getByRole('button', { name: 'src', exact: true }).click()
    await page.getByRole('button', { name: 'index.ts', exact: true }).click()
    await page
      .locator('.file-preview')
      .getByText('export const answer = 42', { exact: true })
      .waitFor()
    await page.getByRole('button', { name: 'Add to prompt', exact: true }).click()
    assert.match(await composer().inputValue(), /src\/index.ts/)

    phase = 'both agent providers, approvals, questions, interruption and current chat'
    for (const provider of ['codex', 'claude']) {
      if (provider === 'claude') {
        await page.getByRole('button', { name: 'New thread', exact: false }).click()
        await page.getByRole('button', { name: 'Claude Code By Anthropic' }).click()
      }
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

    phase = 'remote agent customization, commands and Mermaid panels'
    dialog = await openCustomization()
    await dialog.getByRole('combobox', { name: 'Customization agent' }).selectOption('codex')
    await applyPrompt(
      dialog,
      'Add a research notes panel, an experiment workflow diagram, and a reusable review command',
    )
    assert.match(
      await dialog.locator('.customization-output pre').textContent(),
      /<life-customization>/,
    )
    await closeDialog()
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
    dialog = await openCustomization()
    await dialog.getByRole('button', { name: 'Undo', exact: true }).click()
    await waitUntil(
      async () => (await configuration()).config.theme === 'light',
      'file customization undo',
    )
    await closeDialog()

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
    await page.getByRole('button', { name: 'src', exact: true }).waitFor()
    await screenshot('life-workspace.png')

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

    phase = 'Codex and Claude live executable extension generation'
    let generatedExtension
    for (const provider of ['codex', 'claude']) {
      const manager = await openExtensions()
      await manager.getByRole('tab', { name: 'Prompt', exact: true }).click()
      await manager.getByRole('combobox', { name: 'Extension coding agent' }).selectOption(provider)
      await manager
        .getByRole('textbox', { name: 'Describe a Life extension' })
        .fill(
          'Add a research experiment counter with local executable JavaScript and a Node worker',
        )
      await manager.getByRole('button', { name: 'Build & apply', exact: true }).click()
      await manager.locator('.form-success').waitFor()
      assert.match(await manager.locator('.form-success').textContent(), /Research tools is live/)
      const state = await extensions()
      assert.deepEqual(state.errors, {})
      generatedExtension = state.extensions.find((extension) => extension.id === 'research-tools')
      assert.equal(generatedExtension?.renderer.placement, 'view')
      assert.equal(generatedExtension?.enabled, true)
      await closeDialog()
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
      if (provider === 'codex') {
        await page.evaluate(() => window.relay.extensions.remove('research-tools'))
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

    phase = 'second instance preserves live extensions'
    await applyExtensionSource({ ...replacement, version: '4.0.0' })
    await extensionFrame()
      .getByRole('heading', { name: 'Whole workspace counter', exact: true })
      .waitFor()
    const secondary = spawn(
      executablePath,
      [
        ...(selectedBinary ? [] : [repository]),
        ...(process.platform === 'linux' && process.getuid?.() === 0 ? ['--no-sandbox'] : []),
        '--disable-dev-shm-usage',
      ],
      {
        cwd: repository,
        env: {
          ...process.env,
          XDG_CONFIG_HOME: configurationRoot,
          ...(process.platform === 'win32' ? { APPDATA: configurationRoot } : {}),
        },
        stdio: 'ignore',
      },
    )
    const secondaryExit = await new Promise((resolveExit, rejectExit) => {
      const timeout = setTimeout(() => {
        secondary.kill()
        rejectExit(new Error('The second app instance did not exit.'))
      }, 15000)
      secondary.once('error', (error) => {
        clearTimeout(timeout)
        rejectExit(error)
      })
      secondary.once('close', (code, signal) => {
        clearTimeout(timeout)
        resolveExit({ code, signal })
      })
    })
    assert.deepEqual(secondaryExit, { code: 0, signal: null })
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
    await page.getByRole('dialog', { name: 'Build Life by prompting' }).waitFor()
    await closeDialog()
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
          projectCount: projects.length,
          providerLogEntries: (await fixture.log()).length,
          rendererErrors,
          screenshots: ['life.png', 'life-light.png', 'life-workspace.png'],
          assertions: [
            'fresh empty research map',
            'isolated sandboxed Electron',
            'platform window controls',
            'persisted dark/light themes',
            'local customization and undo',
            'research dependencies and filters',
            'Mermaid SVG and download',
            'OpenSSH config resolution',
            'real loopback host trust and SFTP',
            'Codex and Claude streaming, approvals and questions',
            'interruption and saved chat navigation',
            'early initialization cancellation and replacement send',
            'remote declarative customization',
            'custom commands and Mermaid panels',
            'live configuration file watch and undo',
            'Codex and Claude executable extension generation',
            'sandboxed iframe and local Node worker',
            'worker core capabilities and UI capability rejection',
            'extension hot reload, rollback, disable and remove',
            'extension host CSS and built-in style rollback',
            'whole workspace replacement and Back to Life',
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
      `Native Electron smoke passed (${selectedBinary ? 'packaged' : 'built source'}): research, themes, native controls, config aliases, real SSH/SFTP, both providers, customization, executable extensions, hot reload, rollback and emergency recovery. Screenshots: docs/images/life{,-light,-workspace}.png`,
    )
  } catch (error) {
    console.error(`Desktop smoke failed during: ${phase}: ${error.message}`)
    if (page && !page.isClosed()) {
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
    await rm(configurationRoot, { recursive: true, force: true })
  }
}

run().catch((error) => {
  console.error(error)
  process.exitCode = 1
})
