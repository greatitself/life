#!/usr/bin/env node
/*
 * Genuine Electron / local OS process, filesystem, Git and interactive PTY.
 * Provider CLIs are deterministic native-protocol stand-ins: no account,
 * inference or auth configuration changes. HOME/CODEX_HOME stay inherited.
 * Build first. LIFE_TEST_APP_PATH selects an immutable application snapshot.
 */
const assert = require('node:assert/strict')
const { createHash } = require('node:crypto')
const { existsSync } = require('node:fs')
const {
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  realpath,
  rm,
  stat,
  writeFile,
} = require('node:fs/promises')
const { homedir, tmpdir } = require('node:os')
const { dirname, join, relative, resolve } = require('node:path')
const { spawnSync } = require('node:child_process')
const { performance } = require('node:perf_hooks')
const { build } = require('esbuild')
const { _electron: electron } = require('playwright')
const { readSavedThreads } = require('./helpers/desktop-history.cjs')

const repository = resolve(__dirname, '..')
const appPath = resolve(process.env.LIFE_TEST_APP_PATH || repository)
const artifacts = resolve(
  repository,
  process.env.LIFE_TEST_ARTIFACTS_DIR || 'output/playwright/local-native',
)
if (process.platform === 'linux' && !process.env.DISPLAY) {
  assert.equal(spawnSync('xvfb-run', ['--help'], { stdio: 'ignore' }).status, 0)
  const result = spawnSync(
    'xvfb-run',
    ['-a', '-s', '-screen 0 1920x1080x24 -extension MIT-SHM', process.execPath, __filename],
    { cwd: repository, env: process.env, stdio: 'inherit' },
  )
  process.exit(result.status ?? 1)
}
async function waitUntil(predicate, description, timeout = 20000) {
  const deadline = Date.now() + timeout
  while (Date.now() < deadline) {
    if (await predicate()) return
    await new Promise((done) => setTimeout(done, 40))
  }
  throw new Error(`Timed out waiting for ${description}`)
}
async function fileGraph(directory, filter = () => true) {
  const files = []
  const visit = async (path) => {
    for (const entry of await readdir(path, { withFileTypes: true })) {
      const child = join(path, entry.name)
      if (entry.isDirectory()) await visit(child)
      else if (entry.isFile() && filter(child))
        files.push({
          path: relative(directory, child),
          sha256: createHash('sha256')
            .update(await readFile(child))
            .digest('hex'),
        })
    }
  }
  await visit(directory)
  files.sort((left, right) => left.path.localeCompare(right.path))
  return { files, sha256: createHash('sha256').update(JSON.stringify(files)).digest('hex') }
}
async function inputGraphs() {
  const ptyDirectory = dirname(require.resolve('node-pty/package.json'))
  const fixturePaths = [
    __filename,
    join(repository, 'tests/helpers/local-fixture.ts'),
    join(repository, 'tests/helpers/local-command-rewrite.cjs'),
    join(repository, 'tests/fixtures/fake-provider.cjs'),
  ]
  const runtimePackage = {}
  if (process.env.LIFE_ELECTRON_BINARY) {
    const binary = resolve(process.env.LIFE_ELECTRON_BINARY)
    runtimePackage.binarySha256 = createHash('sha256')
      .update(await readFile(binary))
      .digest('hex')
    const resources = existsSync(join(dirname(binary), 'resources'))
      ? join(dirname(binary), 'resources')
      : join(dirname(binary), '../Resources')
    for (const name of ['app.asar', 'life-dependencies.json']) {
      const path = join(resources, name)
      if (existsSync(path))
        runtimePackage[name] = createHash('sha256')
          .update(await readFile(path))
          .digest('hex')
    }
    const nativeAssets = join(resources, 'app.asar.unpacked/node_modules/node-pty')
    if (existsSync(nativeAssets)) runtimePackage.nativeAssets = await fileGraph(nativeAssets)
  }
  return {
    src: await fileGraph(join(appPath, 'src')),
    out: await fileGraph(join(appPath, 'out')),
    pty: await fileGraph(ptyDirectory, (path) =>
      /(?:\.node|spawn-helper|package\.json|utils\.js|unixTerminal\.js)$/.test(path),
    ),
    packageSha256: createHash('sha256')
      .update(await readFile(join(appPath, 'package.json')))
      .digest('hex'),
    fixtureFiles: await Promise.all(
      fixturePaths.map(async (path) => ({
        path: relative(repository, path),
        sha256: createHash('sha256')
          .update(await readFile(path))
          .digest('hex'),
      })),
    ),
    runtimePackage,
  }
}
const promptFrom = (entry) =>
  entry.kind === 'title-metadata'
    ? undefined
    : entry.message?.method === 'turn/start'
      ? entry.message.params.input?.find((block) => block.type === 'text')?.text
      : entry.message?.type === 'user'
        ? entry.message.message.content?.find((block) => block.type === 'text')?.text
        : undefined

async function run() {
  assert.ok(existsSync(join(appPath, 'out/main/index.js')), 'Build the selected application first')
  await mkdir(artifacts, { recursive: true })
  const helper = join(artifacts, 'local-fixture.cjs')
  await build({
    entryPoints: [join(repository, 'tests/helpers/local-fixture.ts')],
    outfile: helper,
    bundle: true,
    platform: 'node',
    format: 'cjs',
    packages: 'external',
  })
  const { LocalFixture } = require(helper)
  const fixture = await new LocalFixture().start(
    join(repository, 'tests/fixtures/fake-provider.cjs'),
  )
  fixture.versionGate = join(fixture.root, 'provider-versions.ready')
  const configurationRoot = await mkdtemp(join(tmpdir(), 'life-local-native-profile-'))
  const proof = {
    fixture:
      'genuine Electron / local OS process-files-Git / interactive PTY / native CLI stand-ins',
    authenticatedProviderUse: false,
    inferenceRequests: 0,
    appPath,
    nativeMainSha256: createHash('sha256')
      .update(await readFile(join(appPath, 'out/main/index.js')))
      .digest('hex'),
    fixtureSha256: createHash('sha256')
      .update(await readFile(__filename))
      .digest('hex'),
    checks: [],
    timings: [],
    providers: [],
    rendererErrors: [],
    nativeLogs: [],
    inputsBefore: await inputGraphs(),
  }
  let application
  let page
  let phase = 'fresh local profile'
  const ticker = setInterval(() => console.log(`Local native smoke phase: ${phase}`), 30000)
  const measure = async (name, callback) => {
    const start = performance.now()
    const value = await callback()
    proof.timings.push({ name, elapsedMs: performance.now() - start })
    return value
  }
  const saveProgress = () =>
    writeFile(join(artifacts, 'progress.json'), JSON.stringify({ ...proof, phase }, null, 2))
  const ownedProcessRunning = async (pid) => {
    try {
      process.kill(pid, 0)
      if (process.platform === 'linux') {
        const state = await readFile(`/proc/${pid}/stat`, 'utf8')
        if (state.slice(state.lastIndexOf(')') + 2).startsWith('Z')) return false
      }
      return true
    } catch (error) {
      if (['ESRCH', 'ENOENT'].includes(error.code)) return false
      throw error
    }
  }
  const remainingOwnedProcesses = async () => {
    const directory = join(fixture.root, '.life/agent-sessions')
    const alive = []
    if (!existsSync(directory)) return alive
    for (const name of await readdir(directory)) {
      const state = JSON.parse(await readFile(join(directory, name, 'state.json'), 'utf8'))
      for (const [kind, pid] of [
        ['provider', state.pid],
        ['broker', state.brokerPid],
      ])
        if (Number.isSafeInteger(pid) && pid > 1 && (await ownedProcessRunning(pid)))
          alive.push({ id: name, kind, pid })
    }
    return alive
  }
  const closeNative = async () => {
    const current = application
    const process = current.process()
    const closing = current.close()
    closing.catch(() => {})
    await waitUntil(
      () => process.exitCode !== null || process.signalCode !== null,
      'the native application exits through its owned quit workflow',
      30000,
    )
    try {
      await waitUntil(
        async () => (await remainingOwnedProcesses()).length === 0,
        'native quit releases every idle local provider and broker',
        3000,
      )
      proof.shutdowns ||= []
      proof.shutdowns.push({
        mainExitCode: process.exitCode,
        localProvidersAndBrokersReleased: true,
      })
    } catch (error) {
      proof.shutdowns ||= []
      proof.shutdowns.push({
        mainExitCode: process.exitCode,
        localProvidersAndBrokersReleased: false,
        remaining: await remainingOwnedProcesses(),
      })
      application = undefined
      // Main is already terminal. Release only this fixture's processes so a
      // leaked inherited inspector descriptor cannot trap the test harness.
      await fixture.close()
      await closing.catch(() => {})
      throw error
    }
    await closing
    application = undefined
  }
  const launch = async () => {
    const environment = { ...fixture.env, XDG_CONFIG_HOME: configurationRoot }
    delete environment.ELECTRON_RENDERER_URL
    assert.equal(environment.HOME, process.env.HOME)
    assert.equal(environment.CODEX_HOME, process.env.CODEX_HOME)
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
    application.process().stderr?.on('data', (chunk) => {
      proof.nativeLogs.push(String(chunk).slice(-10000))
      while (proof.nativeLogs.join('').length > 64000) proof.nativeLogs.shift()
    })
    page = await application.firstWindow()
    page.setDefaultTimeout(15000)
    page.on('pageerror', (error) => proof.rendererErrors.push(error.message))
    await page.locator('.app-shell').waitFor()
    await application.evaluate(({ BrowserWindow }) =>
      BrowserWindow.getAllWindows()[0].setBounds({ width: 1920, height: 1080 }),
    )
    const profilePath = await application.evaluate(({ app }) => app.getPath('userData'))
    assert.ok(profilePath.startsWith(configurationRoot), 'Native profile must be disposable')
    const isolation = await application.evaluate(({ BrowserWindow }) =>
      BrowserWindow.getAllWindows()[0].webContents.getLastWebPreferences(),
    )
    assert.equal(isolation.contextIsolation, true)
    assert.equal(isolation.nodeIntegration, false)
    assert.equal(isolation.sandbox, true)
    await page.evaluate(() => {
      globalThis.__localNativeEvents = []
      window.relay.onAgent((event) => globalThis.__localNativeEvents.push(event))
    })
    await waitUntil(
      async () =>
        (await page.evaluate(() => window.relay.connection.state())).status === 'connected',
      'fresh application automatically connects the built-in Local environment',
    )
  }
  const providersReady = () =>
    waitUntil(
      async () =>
        (await page.evaluate(() => window.relay.connection.state())).providerVersionsStatus ===
        'ready',
      'native background CLI discovery finishes',
    )
  const openAgents = async () => {
    const navigation = page.getByRole('navigation', { name: 'Workspace views' })
    const configuration = await page.evaluate(() => window.relay.customization.get())
    const label = configuration.config.labels.workspaceTitle
    const button = navigation.getByRole('button', { name: label, exact: true })
    if (await button.count()) await button.click()
    else await navigation.getByRole('button', { name: 'Agents', exact: true }).click()
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
  const selectProvider = async (provider) => {
    await openAgents()
    await page.getByRole('button', { name: 'New thread', exact: true }).click()
    await page.getByRole('combobox', { name: /^Model:/ }).click()
    await page
      .locator('.reference-select-content')
      .getByRole('option', {
        name: provider === 'codex' ? 'Codex default' : 'Claude default',
        exact: true,
      })
      .click()
  }
  const send = async (prompt) => {
    await page
      .getByRole('textbox', {
        name: /^(?:Message your coding agent|Message (?:Codex|Claude Code) about )/,
      })
      .fill(prompt)
    await page.getByRole('button', { name: 'Send message', exact: true }).click()
  }
  const completedThread = async (
    prompt,
    provider,
    response = `Hello from ${provider === 'codex' ? 'Codex' : 'Claude'} 👋`,
  ) => {
    let found
    await waitUntil(async () => {
      found = (await readSavedThreads(page)).find(
        (thread) =>
          thread.provider === provider &&
          thread.messages.some((message) => message.role === 'user' && message.text === prompt),
      )
      const user = found?.messages.find(
        (message) => message.role === 'user' && message.text === prompt,
      )
      return (
        found &&
        !found.busy &&
        found.turnStatus === 'completed' &&
        found.remoteId &&
        typeof user?.turn === 'number' &&
        found.messages.some(
          (message) =>
            message.role === 'assistant' && message.turn === user.turn && message.text === response,
        )
      )
    }, `${provider} persists a completed local turn and exact prompt`)
    return found
  }
  try {
    const launchDirectoryIsProject = await stat(join(appPath, '.git')).then(
      () => true,
      () => false,
    )
    const expectedInitialWorkspace = await realpath(launchDirectoryIsProject ? appPath : homedir())
    proof.initialWorkspaceContract = {
      application: process.env.LIFE_ELECTRON_BINARY ? 'packaged' : 'source',
      launchDirectory: appPath,
      launchDirectoryIsProject,
      expectedInitialWorkspace,
      policy: 'canonical project launch directory when .git exists; otherwise canonical OS home',
    }
    await measure('fresh-profile-to-connected-local', launch)
    const profiles = await page.evaluate(() => window.relay.profiles.list())
    const checking = await page.evaluate(() => window.relay.connection.state())
    assert.equal(checking.providerVersionsStatus, 'checking')
    assert.notEqual(checking.codex, 'missing')
    assert.notEqual(checking.claude, 'missing')
    await waitUntil(
      () => existsSync(fixture.versionGate + '.started'),
      'provider version subprocess waits on fixture gate',
      5000,
    )
    const usableFiles = await page.evaluate(() => window.relay.files.list())
    assert.ok(
      usableFiles.length > 0,
      'Local files are usable while optional CLI discovery is still gated',
    )
    assert.equal(existsSync(fixture.versionGate), false)
    assert.equal(
      (await page.evaluate(() => window.relay.connection.state())).providerVersionsStatus,
      'checking',
    )
    proof.localUsableBeforeProviderVersions = true
    await writeFile(fixture.versionGate, 'release optional CLI discovery\n')
    await providersReady()
    const initial = await page.evaluate(() => window.relay.connection.state())
    const local = profiles.find((profile) => profile.transport === 'local')
    assert.ok(local)
    assert.match(local.id, /^local:[a-f\d-]{36}$/)
    assert.equal(initial.profile.id, local.id)
    assert.equal(initial.profile.transport, 'local')
    assert.equal(
      initial.workspace,
      expectedInitialWorkspace,
      'Fresh Local defaults to the canonical project launch directory or OS home',
    )
    assert.equal(initial.codex, 'codex-cli 0.162.1')
    assert.equal(initial.claude, '2.1.278 (Claude Code)')
    assert.equal(
      await page.getByRole('dialog', { name: 'Choose an environment', exact: true }).isVisible(),
      false,
    )
    proof.localId = local.id
    proof.checks.push(
      'fresh native profile automatically offers and connects Local without SSH credentials',
    )
    await page.screenshot({ path: join(artifacts, 'fresh-local-1080p.png') })
    await saveProgress()

    phase = 'actual local project selection and files'
    await openAgents()
    await page.getByRole('button', { name: 'Add project', exact: true }).click()
    const picker = page.getByRole('dialog', { name: 'Select a project', exact: true })
    await picker.waitFor()
    await picker
      .getByRole('textbox', { name: 'Project directory', exact: true })
      .fill(fixture.workspace)
    await picker.getByRole('button', { name: 'Open project', exact: true }).click()
    await picker.waitFor({ state: 'hidden' })
    await waitUntil(
      async () =>
        (await page.evaluate(() => window.relay.connection.state())).workspace ===
        fixture.workspace,
      'actual local project selection',
    )
    const files = await page.evaluate(() => window.relay.files.list())
    assert.ok(files.some((file) => file.name === 'README.md'))
    assert.ok(!files.some((file) => ['.git', 'node_modules'].includes(file.name)))
    assert.equal(
      await page.evaluate(() => window.relay.files.read('README.md')),
      '# Local fixture café 🧪\n',
    )
    const escape = await page.evaluate(async () => {
      try {
        await window.relay.files.read('escape-link')
        return { rejected: false }
      } catch (error) {
        return { rejected: true, message: error.message }
      }
    })
    assert.equal(escape.rejected, true)
    await surface('Files')
    await page.getByRole('button', { name: /^README\.md(?:\s|$)/ }).click()
    await page.getByText('# Local fixture café 🧪', { exact: true }).waitFor()
    await writeFile(
      join(fixture.workspace, 'src/index.ts'),
      'export const answer = "local café 🧪"\n',
    )
    const git = await page.evaluate(() => window.relay.files.git())
    assert.ok(git.diff.includes('+export const answer = "local café 🧪"'))
    proof.checks.push(
      'UI selects local project; native filesystem and Git preserve Unicode; symlink escape is refused',
    )
    await saveProgress()

    phase = 'actual local interactive terminal and resize'
    await page.evaluate(() => {
      globalThis.__localTerminal = ''
      window.relay.onTerminal((text) => (globalThis.__localTerminal += text))
    })
    await measure('local-terminal-ready', async () => {
      await surface('Terminal')
      await waitUntil(
        async () =>
          (await page.evaluate(() => globalThis.__localTerminal)).includes(
            'LIFE_LOCAL_SHELL_READY>',
          ),
        'interactive local shell ready',
      )
    })
    await page.evaluate(() => window.relay.terminal.resize(123, 29))
    await page.locator('.xterm-helper-textarea').focus()
    await page.keyboard.type(
      'printf "\\nLIFE_NATIVE_TTY=%s:%s\\n" "$(test -t 0 && printf yes || printf no)" "$(stty size)"',
    )
    await page.keyboard.press('Enter')
    await waitUntil(
      async () =>
        (await page.evaluate(() => globalThis.__localTerminal)).includes(
          'LIFE_NATIVE_TTY=yes:29 123',
        ),
      'genuine PTY and requested rows and columns',
    )
    await page.keyboard.type('printf "\\nLIFE_NATIVE_INPUT=%s\\n" "café 漢字 🧪"')
    await page.keyboard.press('Enter')
    await waitUntil(
      async () =>
        (await page.evaluate(() => globalThis.__localTerminal)).includes(
          'LIFE_NATIVE_INPUT=café 漢字 🧪',
        ),
      'actual local terminal keyboard input',
    )
    await page
      .locator('.terminal-panel')
      .getByRole('button', { name: 'Close terminal', exact: true })
      .click()
    await waitUntil(
      async () =>
        (await page.evaluate(() => globalThis.__localTerminal)).includes('[Terminal closed]'),
      'native terminal close acknowledgement',
    )
    await page.locator('.terminal-panel .xterm-helper-textarea').waitFor({ state: 'hidden' })
    proof.checks.push(
      'real local PTY receives keyboard input, reports isTTY, applies resize and closes cleanly',
    )
    await saveProgress()

    const originals = []
    for (const provider of ['codex', 'claude']) {
      phase = `${provider} exact native local prompt, approval and attachments`
      await selectProvider(provider)
      const prompt = `/life ${provider}: my local project only\n  Preserve café 漢字 🧪, "quotes", $literal and every space.\n`
      const original = await measure(`${provider}-native-local-turn`, async () => {
        await send(prompt)
        return completedThread(prompt, provider)
      })
      assert.equal(original.profileId, local.id)
      assert.equal(original.workspace, fixture.workspace)
      const received = (await fixture.log()).filter((entry) => promptFrom(entry) === prompt)
      assert.equal(received.length, 1)
      assert.equal(received[0].cwd, fixture.workspace)
      assert.equal(received[0].provider, provider)
      const approvalBaseline = (await fixture.log()).length
      await send('approval')
      await page
        .locator('.approval-card')
        .getByText(provider === 'codex' ? 'Allow this command?' : 'Allow Bash?', { exact: true })
        .waitFor()
      const approval = await page.evaluate(
        (id) =>
          globalThis.__localNativeEvents.findLast(
            (event) => event.sessionId === id && event.type === 'approval',
          ),
        original.id,
      )
      assert.ok(approval?.requestId)
      await page.getByRole('button', { name: 'Allow once', exact: true }).click()
      const decision =
        provider === 'codex'
          ? { decision: 'accept' }
          : { behavior: 'allow', updatedInput: { command: 'npm test' } }
      await completedThread('approval', provider, JSON.stringify(decision))
      const approvalLog = (await fixture.log())
        .slice(approvalBaseline)
        .filter((entry) => entry.provider === provider && entry.kind !== 'title-metadata')
      if (provider === 'codex') {
        const turn = approvalLog.find(
          (entry) => entry.kind === 'turn-started' && entry.prompt === 'approval',
        )
        assert.ok(turn)
        const sequence = Number(turn.turnId.replace('turn-', ''))
        const responses = approvalLog.filter(
          (entry) => entry.message?.id === 9000 + sequence && !entry.message.method,
        )
        assert.equal(responses.length, 1)
        assert.deepEqual(responses[0].message.result, decision)
      } else {
        const responses = approvalLog.filter(
          (entry) =>
            entry.message?.type === 'control_response' &&
            entry.message.response.request_id === approval.requestId,
        )
        assert.equal(responses.length, 1)
        assert.equal(responses[0].message.response.subtype, 'success')
        assert.deepEqual(responses[0].message.response.response, decision)
      }

      const notes = Buffer.from('Local attachment café 漢字 🧪\n'.repeat(4))
      const image = Buffer.from(
        'iVBORw0KGgoAAAANSUhEUgAAAAQAAAAECAYAAACp8Z5+AAAAEklEQVQImWP4z8Dwn4GBgYGJAQoAQokH+fG8cXIAAAAASUVORK5CYII=',
        'base64',
      )
      await page.getByLabel('Choose images or files', { exact: true }).setInputFiles([
        { name: 'local-notes.txt', mimeType: 'text/plain', buffer: notes },
        { name: 'native-reference.png', mimeType: 'image/png', buffer: image },
      ])
      await waitUntil(
        async () =>
          (
            await page
              .locator('.draft-attachments .thread-attachment-open')
              .evaluateAll((buttons) => buttons.map((button) => button.title))
          ).filter((text) => text.includes('Uploaded · ready to send')).length === 2,
        'local attachments staged',
      )
      const baseline = (await fixture.log()).length
      await send('native-attachment-probe')
      const settled = await completedThread(
        'native-attachment-probe',
        provider,
        'Verified 2 remote attachment files.',
      )
      assert.equal(settled.remoteId, original.remoteId)
      const attachmentLog = (await fixture.log()).slice(baseline)
      const request = attachmentLog.find((entry) => promptFrom(entry) === 'native-attachment-probe')
      assert.ok(request)
      const blocks = request.message.params?.input || request.message.message?.content
      assert.ok(
        blocks.some((block) => block.type === (provider === 'codex' ? 'localImage' : 'image')),
      )
      if (provider === 'claude')
        assert.ok(
          blocks.some((block) => block.type === 'document' && block.title === 'local-notes.txt'),
        )
      const evidence = attachmentLog.find(
        (entry) => entry.attachmentEvidence || entry.nativeAttachmentEvidence,
      )
      const files = evidence?.attachmentEvidence || evidence?.nativeAttachmentEvidence
      assert.equal(files?.length, 2)
      for (const [name, payload] of [
        ['local-notes.txt', notes],
        ['native-reference.png', image],
      ]) {
        const record = files.find((file) => file.name === name || file.path?.endsWith(name))
        assert.ok(record, `${provider} receives ${name}`)
        assert.equal(record.sha256, createHash('sha256').update(payload).digest('hex'))
      }
      originals.push(settled)
      proof.providers.push({
        provider,
        threadId: settled.id,
        nativeId: settled.remoteId,
        profileId: settled.profileId,
        workspace: settled.workspace,
        exactPrompt: prompt,
        attachmentHashesVerified: true,
      })
      proof.checks.push(
        `${provider}: exact local prompt and owner; native approval response; actual image/text attachment payloads`,
      )
      await saveProgress()
    }

    phase = 'cold native restart and exact saved native identity'
    proof.initialAgentErrors = await page.evaluate(() =>
      globalThis.__localNativeEvents.filter((event) => event.type === 'error'),
    )
    assert.deepEqual(proof.initialAgentErrors, [])
    await saveProgress()
    await closeNative()
    await measure('cold-restart-to-connected-local', launch)
    await providersReady()
    const restoredState = await page.evaluate(() => window.relay.connection.state())
    assert.equal(restoredState.profile.id, local.id)
    assert.equal(restoredState.profile.transport, 'local')
    assert.equal(restoredState.workspace, fixture.workspace)
    for (const original of originals) {
      const restored = (await readSavedThreads(page)).find((thread) => thread.id === original.id)
      assert.ok(restored)
      assert.equal(restored.remoteId, original.remoteId)
      assert.equal(restored.profileId, original.profileId)
      assert.equal(restored.workspace, original.workspace)
      assert.deepEqual(restored.messages, original.messages)
      await openAgents()
      const resumeBaseline = (await fixture.log()).length
      await page.locator(`[data-thread-row=${JSON.stringify(original.id)}]`).click()
      const followup = `  ${original.provider}: local native resume café 漢字 🧪\n`
      await send(followup)
      const resumed = await completedThread(followup, original.provider)
      assert.equal(resumed.id, original.id)
      assert.equal(resumed.remoteId, original.remoteId)
      assert.equal(resumed.profileId, original.profileId)
      assert.equal(resumed.workspace, original.workspace)
      assert.equal(
        (await fixture.log()).filter((entry) => promptFrom(entry) === followup).length,
        1,
      )
      const resumeLog = (await fixture.log())
        .slice(resumeBaseline)
        .filter((entry) => entry.provider === original.provider && entry.kind !== 'title-metadata')
      const request = resumeLog.find((entry) => promptFrom(entry) === followup)
      assert.ok(request)
      assert.equal(request.cwd, original.workspace)
      if (original.provider === 'codex') {
        assert.ok(
          resumeLog.some(
            (entry) =>
              entry.message?.method === 'thread/resume' &&
              entry.message.params.threadId === original.remoteId &&
              entry.message.params.excludeTurns === true,
          ),
        )
        assert.equal(request.message.params.threadId, original.remoteId)
      } else {
        assert.ok(
          resumeLog.some(
            (entry) =>
              Array.isArray(entry.argv) &&
              (entry.argv.includes(`--resume=${original.remoteId}`) ||
                (entry.argv.includes('--resume') &&
                  entry.argv[entry.argv.indexOf('--resume') + 1] === original.remoteId)),
          ),
        )
      }
    }
    proof.checks.push(
      'cold native restart automatically reconnects Local and resumes both saved native provider identities once',
    )
    const errors = await page.evaluate(() =>
      globalThis.__localNativeEvents.filter((event) => event.type === 'error'),
    )
    assert.deepEqual(errors, [])
    assert.deepEqual(proof.rendererErrors, [])
    const brokerConfigurations = (
      await readFile(join(fixture.root, 'broker-configs.jsonl'), 'utf8')
    )
      .split('\n')
      .filter(Boolean)
      .map((line) => JSON.parse(line))
    assert.ok(brokerConfigurations.length > 0)
    assert.ok(
      brokerConfigurations.every(
        (configuration) =>
          configuration.root === join(fixture.root, '.life/agent-sessions', configuration.id) &&
          configuration.runtimeUnchanged === true,
      ),
    )
    proof.brokerConfigurations = brokerConfigurations
    assert.ok(
      (await fixture.log())
        .filter((entry) => entry.kind === 'title-metadata')
        .every((entry) => entry.cwd.startsWith(join(fixture.root, '.life/metadata') + '/')),
    )
    await page.screenshot({ path: join(artifacts, 'local-native-1080p.png') })
    await closeNative()
    proof.inputsAfter = await inputGraphs()
    assert.deepEqual(
      proof.inputsAfter,
      proof.inputsBefore,
      'The exact source/build/native-helper/fixture graphs remain immutable throughout native verification',
    )
    proof.passed = true
    await writeFile(join(artifacts, 'proof.json'), JSON.stringify(proof, null, 2))
    console.log(`Local native smoke passed ${proof.checks.length} groups with 0 renderer errors.`)
  } catch (error) {
    proof.passed = false
    proof.inputsAfter ||= await inputGraphs().catch((graphError) => ({ error: String(graphError) }))
    proof.failedPhase = phase
    proof.error = error.stack || String(error)
    await writeFile(join(artifacts, 'proof.json'), JSON.stringify(proof, null, 2))
    if (page && !page.isClosed())
      await page.screenshot({ path: join(artifacts, 'failure.png') }).catch(() => {})
    throw error
  } finally {
    clearInterval(ticker)
    if (application) await closeNative().catch(() => {})
    await fixture.close()
    await rm(configurationRoot, { recursive: true, force: true })
  }
}
run().catch((error) => {
  console.error(error)
  process.exitCode = 1
})
