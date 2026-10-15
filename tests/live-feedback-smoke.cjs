#!/usr/bin/env node
/*
 * Real Vite CSS/React HMR in Electron with native IPC and the loopback SSH fixture.
 * Run after npm run build, while renderer files are not being edited elsewhere.
 * No provider account or paid inference is used. Source mutations are temporary:
 * original bytes are backed up and restored even when verification fails.
 */
const assert = require('node:assert/strict')
const { createHash } = require('node:crypto')
const { existsSync } = require('node:fs')
const { mkdir, mkdtemp, readFile, rename, rm, writeFile } = require('node:fs/promises')
const { tmpdir } = require('node:os')
const { join, resolve } = require('node:path')
const { spawnSync } = require('node:child_process')
const { createServer: createTCPServer } = require('node:net')
const { performance } = require('node:perf_hooks')
const { build } = require('esbuild')
const { _electron: electron } = require('playwright')
const { readSavedThreads } = require('./helpers/desktop-history.cjs')

const repository = resolve(__dirname, '..')
const artifacts = resolve(
  repository,
  process.env.LIFE_TEST_ARTIFACTS_DIR || 'output/playwright/live-feedback',
)
const hash = (bytes) => createHash('sha256').update(bytes).digest('hex')
let signalFailure

// The existing SSH fixture executes Bash; Linux also isolates the native profile
// using XDG_CONFIG_HOME without replacing the production main entry.
assert.equal(
  process.platform,
  'linux',
  'This fixture currently supports Linux, where the existing SSH fixture executes Bash.',
)
if (process.platform === 'linux' && !process.env.DISPLAY) {
  assert.equal(
    spawnSync('xvfb-run', ['--help'], { stdio: 'ignore' }).status,
    0,
    'Live-feedback smoke requires DISPLAY or xvfb-run on Linux.',
  )
  const child = spawnSync(
    'xvfb-run',
    ['-a', '-s', '-screen 0 1440x960x24', process.execPath, __filename],
    { cwd: repository, env: process.env, stdio: 'inherit' },
  )
  process.exit(child.status ?? 1)
}

// Leave the test alive long enough to restore source and close owned resources.
// Polling waits and the next mutation boundary turn these signals into failures.
for (const signal of ['SIGINT', 'SIGTERM'])
  process.once(signal, () => {
    signalFailure ||= new Error(`Live feedback smoke interrupted by ${signal}`)
  })

async function waitUntil(predicate, description, timeout = 20000) {
  const deadline = Date.now() + timeout
  while (Date.now() < deadline) {
    if (signalFailure) throw signalFailure
    if (await predicate()) return
    await new Promise((done) => setTimeout(done, 30))
  }
  throw new Error(`Timed out waiting for ${description}`)
}

async function run() {
  assert.ok(existsSync(join(repository, 'out/main/index.js')), 'Run npm run build first.')
  assert.ok(existsSync(join(repository, 'out/preload/index.js')), 'Run npm run build first.')
  await mkdir(artifacts, { recursive: true })
  const directory = await mkdtemp(join(tmpdir(), 'life-live-feedback-'))
  const configurationRoot = join(directory, 'configuration')
  await mkdir(configurationRoot)
  const files = [
    { path: join(repository, 'src/renderer/styles.css'), name: 'styles.css' },
    { path: join(repository, 'src/renderer/components/TitleBar.tsx'), name: 'TitleBar.tsx' },
  ]
  for (const file of files) {
    file.original = await readFile(file.path)
    file.expected = file.original
    await writeFile(join(artifacts, `${file.name}.original`), file.original)
  }
  const proof = {
    ok: false,
    fixtureOnly: true,
    source: files.map((file) => ({ path: file.path, beforeSha256: hash(file.original) })),
    errors: [],
    consoleErrors: [],
    timings: {},
  }
  let fixture
  let server
  let application
  let page
  let failure
  let phase = 'prepare actual Vite configuration'
  const progress = setInterval(() => console.log(`Live feedback smoke: ${phase}`), 30000)
  const replace = async (file, bytes) => {
    const temporary = `${file.path}.life-feedback-${process.pid}.tmp`
    try {
      await writeFile(temporary, bytes)
      assert.ok(
        (await readFile(file.path)).equals(file.expected),
        `${file.name} changed while preparing the fixture edit; refusing to overwrite it`,
      )
      await rename(temporary, file.path)
      file.expected = bytes
      file.mutated = !bytes.equals(file.original)
    } finally {
      await rm(temporary, { force: true })
    }
  }
  const mutate = async (file, bytes) => {
    if (signalFailure) throw signalFailure
    assert.ok(
      (await readFile(file.path)).equals(file.expected),
      `${file.name} changed outside this test; refusing to overwrite it`,
    )
    if (signalFailure) throw signalFailure
    await replace(file, bytes)
  }
  const restore = async () => {
    const errors = []
    for (const file of files) {
      try {
        if (file.mutated) {
          assert.ok(
            (await readFile(file.path)).equals(file.expected),
            `${file.name} changed outside this test; original backup is in ${artifacts}`,
          )
          await replace(file, file.original)
        }
        assert.ok(
          (await readFile(file.path)).equals(file.original),
          `${file.name} restored exactly`,
        )
      } catch (error) {
        errors.push(error)
      }
    }
    if (errors.length)
      throw new AggregateError(errors, 'Could not restore all fixture source files')
  }
  try {
    const { resolveConfig } = await import('electron-vite')
    const { createServer } = await import('vite')
    const configured = await resolveConfig({ root: repository }, 'serve', 'development')
    assert.ok(configured.config?.renderer, 'Repository defines the actual renderer Vite config')
    // Vite treats a zero port as its default, so obtain a private ephemeral port
    // before requesting a strict bind. Do not reuse the user's preview at 5173.
    const listener = createTCPServer()
    await new Promise((done, reject) => {
      listener.once('error', reject)
      listener.listen(0, '127.0.0.1', done)
    })
    const port = listener.address().port
    await new Promise((done) => listener.close(done))
    server = await createServer({
      ...configured.config.renderer,
      root: resolve(repository, configured.config.renderer.root || 'src/renderer'),
      cacheDir: join(directory, 'vite-cache'),
      server: {
        ...configured.config.renderer.server,
        host: '127.0.0.1',
        port,
        strictPort: true,
        open: false,
      },
    })
    await server.listen()
    const address = server.httpServer.address()
    assert.ok(address && typeof address !== 'string')
    proof.rendererURL = `http://127.0.0.1:${address.port}`
    const bundledFixture = join(artifacts, 'live-feedback-ssh-fixture.cjs')
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
    fixture = new SSHFixture(join(repository, 'tests/fixtures/fake-provider.cjs'))
    await fixture.start()
    // The fixture must never forward unrelated services from this test machine.
    fixture.discoveryPorts = []
    phase = 'launch real Electron against Vite'
    application = await electron.launch({
      executablePath: require('electron'),
      args: [
        repository,
        ...(process.platform === 'linux' ? ['--no-sandbox'] : []),
        '--disable-dev-shm-usage',
      ],
      cwd: repository,
      env: {
        ...process.env,
        ELECTRON_RENDERER_URL: proof.rendererURL,
        XDG_CONFIG_HOME: configurationRoot,
      },
      timeout: 30000,
    })
    page = await application.firstWindow()
    page.setDefaultTimeout(20000)
    page.on('pageerror', (error) => proof.errors.push(error.message))
    page.on('console', (message) => {
      if (message.type() === 'error') proof.consoleErrors.push(message.text())
    })
    await application.evaluate(({ app, BrowserWindow }) => {
      const window = BrowserWindow.getAllWindows()[0]
      window.setBounds({ width: 1440, height: 960 })
      globalThis.__lifeFeedbackSmoke = {
        pid: process.pid,
        windowId: window.id,
        rendererPid: window.webContents.getOSProcessId(),
        navigations: [],
        windows: [],
      }
      window.webContents.on('did-start-navigation', (_event, url, inPlace, mainFrame) => {
        if (mainFrame && !inPlace) globalThis.__lifeFeedbackSmoke.navigations.push(url)
      })
      app.on('browser-window-created', (_event, created) => {
        globalThis.__lifeFeedbackSmoke.windows.push(created.id)
      })
    })
    const userData = await application.evaluate(({ app }) => app.getPath('userData'))
    assert.ok(
      userData.startsWith(configurationRoot),
      `Application profile is isolated: ${userData}`,
    )
    await page.locator('.app-shell').waitFor()
    assert.equal(new URL(page.url()).origin, proof.rendererURL)
    const preferences = await application.evaluate(({ BrowserWindow }) =>
      BrowserWindow.getAllWindows()[0].webContents.getLastWebPreferences(),
    )
    assert.equal(preferences.contextIsolation, true)
    assert.equal(preferences.nodeIntegration, false)
    assert.equal(preferences.sandbox, true)
    phase = 'connect fixture and save exact native conversation'
    const input = fixture.input()
    await page.getByRole('button', { name: 'Connections', exact: true }).click()
    const connection = page.getByRole('dialog', { name: 'Connect a machine', exact: true })
    await connection.waitFor()
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
    const composer = () =>
      page.getByRole('textbox', { name: 'Message your coding agent', exact: true })
    const prompt = '  Live feedback fixture\n\tKeep café e\u0301 漢字 🧪 exactly.  '
    const draft = '  Unsent feedback draft\n\tKeep café e\u0301 漢字 🧪 exactly.  '
    await composer().fill(prompt)
    await page.getByRole('button', { name: 'Send message', exact: true }).click()
    await page.getByRole('button', { name: 'Send message', exact: true }).waitFor()
    let history
    await waitUntil(async () => {
      history = await readSavedThreads(page)
      return history.some(
        (thread) =>
          thread.remoteId &&
          !thread.busy &&
          thread.title === 'Provider-generated workspace title' &&
          thread.messages.some((message) => message.role === 'user' && message.text === prompt) &&
          thread.messages.some((message) => message.role === 'assistant'),
      )
    }, 'native conversation with provider session and exact prompt persists')
    const thread = history.find((value) =>
      value.messages.some((message) => message.text === prompt),
    )
    assert.equal(thread.workspace, input.workspace)
    assert.ok(thread.profileId)
    const turns = (await fixture.log()).filter(
      (entry) => entry.kind !== 'title-metadata' && entry.message?.method === 'turn/start',
    )
    assert.equal(turns.length, 1)
    assert.equal(turns[0].message.params.input.find((item) => item.type === 'text').text, prompt)
    await composer().fill(draft)
    await waitUntil(
      () =>
        page.evaluate(
          (expected) =>
            Object.values(
              JSON.parse(localStorage.getItem('life.conversation-drafts.v1') || '{}'),
            ).some((value) => value?.draft === expected || value === expected),
          draft,
        ),
      'exact unsent draft persists before HMR',
    )
    const draftStorage = await page.evaluate(() =>
      localStorage.getItem('life.conversation-drafts.v1'),
    )
    const diskPath = join(userData, 'conversations.json')
    const nativeBefore = JSON.parse(await readFile(diskPath, 'utf8'))
    const nativeState = () =>
      application.evaluate(({ BrowserWindow }) => ({
        ...globalThis.__lifeFeedbackSmoke,
        currentPid: process.pid,
        currentWindowId: BrowserWindow.getAllWindows()[0].id,
        currentRendererPid: BrowserWindow.getAllWindows()[0].webContents.getOSProcessId(),
      }))
    const baseline = await nativeState()
    proof.baseline = baseline
    proof.conversation = {
      threadId: thread.id,
      provider: thread.provider,
      providerSessionId: thread.remoteId,
      profileId: thread.profileId,
      workspace: thread.workspace,
      prompt,
      draft,
    }
    const sample = () =>
      page.evaluate(async () => {
        const samples = []
        for (let index = 0; index < 12; index++) {
          const start = performance.now()
          await window.relay.connection.state()
          samples.push(performance.now() - start)
        }
        return {
          ipcRoundTripMs: samples,
          medianMs: [...samples].sort((left, right) => left - right)[
            Math.floor(samples.length / 2)
          ],
        }
      })
    proof.timings.before = await sample()
    const preserved = async (label) => {
      const current = await nativeState()
      assert.equal(current.currentPid, baseline.pid, `${label}: native PID remains stable`)
      assert.equal(
        current.currentWindowId,
        baseline.windowId,
        `${label}: native window remains stable`,
      )
      assert.equal(
        current.currentRendererPid,
        baseline.currentRendererPid,
        `${label}: renderer process remains stable`,
      )
      assert.deepEqual(
        current.navigations,
        baseline.navigations,
        `${label}: no document navigation`,
      )
      assert.deepEqual(current.windows, baseline.windows, `${label}: no replacement native window`)
      assert.equal(await composer().inputValue(), draft, `${label}: exact draft remains visible`)
      assert.equal(
        await page.evaluate(() => localStorage.getItem('life.conversation-drafts.v1')),
        draftStorage,
        `${label}: exact saved draft remains intact`,
      )
      assert.deepEqual(
        await readSavedThreads(page),
        history,
        `${label}: native history remains intact`,
      )
      assert.deepEqual(
        JSON.parse(await readFile(diskPath, 'utf8')),
        nativeBefore,
        `${label}: exact native checkpoint remains intact`,
      )
      assert.equal((await page.evaluate(() => window.relay.connection.state())).status, 'connected')
      proof[label] = current
    }
    phase = 'temporary CSS edit updates without navigating'
    const css = Buffer.concat([
      files[0].original,
      Buffer.from(
        '\n/* Temporary live-feedback fixture; original bytes restored in finally. */\n' +
          '.titlebar-brand { --life-feedback-smoke: css-updated; outline: 2px solid rgb(65, 135, 220); }\n',
      ),
    ])
    const cssStarted = performance.now()
    await mutate(files[0], css)
    await waitUntil(
      () =>
        page
          .locator('.titlebar-brand')
          .first()
          .evaluate(
            (element) =>
              getComputedStyle(element).getPropertyValue('--life-feedback-smoke').trim() ===
              'css-updated',
          ),
      'actual CSS HMR update in Electron',
    )
    proof.timings.cssUpdateMs = performance.now() - cssStarted
    await preserved('afterCss')
    await page.screenshot({ path: join(artifacts, 'css-hmr.png') })
    phase = 'temporary React component edit updates without navigating'
    const originalComponent = files[1].original.toString('utf8')
    const needle = '        life\n'
    assert.equal(originalComponent.split(needle).length, 2, 'One LifeBrand text target exists')
    const componentStarted = performance.now()
    await mutate(
      files[1],
      Buffer.from(originalComponent.replace(needle, '        life HMR fixture\n')),
    )
    await waitUntil(
      async () =>
        (await page.locator('.titlebar-brand strong').first().textContent()).includes(
          'HMR fixture',
        ),
      'actual React component HMR update in Electron',
    )
    proof.timings.componentUpdateMs = performance.now() - componentStarted
    await preserved('afterComponent')
    proof.timings.after = await sample()
    await page.screenshot({ path: join(artifacts, 'react-hmr.png') })
    phase = 'restore exact source bytes through HMR'
    await restore()
    await waitUntil(
      async () =>
        !(await page.locator('.titlebar-brand strong').first().textContent()).includes(
          'HMR fixture',
        ) &&
        (await page
          .locator('.titlebar-brand')
          .first()
          .evaluate((element) =>
            getComputedStyle(element).getPropertyValue('--life-feedback-smoke').trim(),
          )) === '',
      'restored source is visible in the same window',
    )
    await preserved('afterRestore')
    assert.deepEqual(proof.errors, [], 'No renderer exceptions during fixture')
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
    phase = 'restore source and close owned resources'
    clearInterval(progress)
    try {
      await restore()
      for (let index = 0; index < files.length; index++)
        proof.source[index].afterSha256 = hash(await readFile(files[index].path))
    } catch (error) {
      failure ||= error
      proof.ok = false
      proof.restoreFailure = String(error)
    }
    for (const [label, close] of [
      ['electron', () => application?.close()],
      ['vite', () => server?.close()],
      ['ssh', () => fixture?.close()],
      ['temporary profile', () => rm(directory, { recursive: true, force: true })],
    ]) {
      try {
        await close()
      } catch (error) {
        failure ||= error
        proof.ok = false
        proof.errors.push(`${label} cleanup: ${String(error)}`)
      }
    }
    await writeFile(join(artifacts, 'proof.json'), JSON.stringify(proof, null, 2) + '\n')
  }
  if (failure) throw failure
  console.log(
    JSON.stringify({
      ok: proof.ok,
      proof: join(artifacts, 'proof.json'),
      cssUpdateMs: proof.timings.cssUpdateMs,
      componentUpdateMs: proof.timings.componentUpdateMs,
      ipcMedianBeforeMs: proof.timings.before?.medianMs,
      ipcMedianAfterMs: proof.timings.after?.medianMs,
    }),
  )
}

run().catch((error) => {
  console.error(error)
  process.exitCode = 1
})
