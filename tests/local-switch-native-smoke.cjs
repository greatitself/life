#!/usr/bin/env node
/*
 * Genuine Electron Local -> loopback SSH -> private source activation.
 * Native provider protocols use fixture CLIs. No account, auth or inference.
 * Run only against an explicitly selected, already built private application.
 * LIFE_SWITCH_EXPECT_BEFORE=1 records the old failure; it does not accept it.
 */
const assert = require('node:assert/strict')
const { createHash } = require('node:crypto')
const { existsSync } = require('node:fs')
const { mkdir, mkdtemp, readFile, readdir, rm, stat, writeFile } = require('node:fs/promises')
const { tmpdir } = require('node:os')
const { dirname, join, relative, resolve } = require('node:path')
const { performance } = require('node:perf_hooks')
const { build } = require('esbuild')
const { _electron: electron } = require('playwright')

const repository = resolve(__dirname, '..')
const appPath = resolve(process.env.LIFE_TEST_APP_PATH || repository)
const artifacts = resolve(
  repository,
  process.env.LIFE_TEST_ARTIFACTS_DIR || 'output/playwright/local-switch-native',
)
const before = process.env.LIFE_SWITCH_EXPECT_BEFORE === '1'
const routes = (process.env.LIFE_SWITCH_ROUTES || 'disconnect,connect').split(',')
assert.ok(routes.every((route) => ['disconnect', 'connect'].includes(route)))
assert.ok(
  process.env.DISPLAY,
  'Use an owned Xvfb -displayfd 3 launcher; no shared display fallback',
)

const digest = (bytes) => createHash('sha256').update(bytes).digest('hex')
const delay = (milliseconds) => new Promise((done) => setTimeout(done, milliseconds))
async function waitUntil(predicate, description, timeout = 15000) {
  const deadline = Date.now() + timeout
  while (Date.now() < deadline) {
    if (await predicate()) return
    await delay(25)
  }
  throw new Error(`Timed out waiting for ${description}`)
}
async function graph(directory, filter = () => true) {
  const files = []
  const visit = async (current) => {
    for (const entry of await readdir(current, { withFileTypes: true })) {
      const path = join(current, entry.name)
      if (entry.isDirectory()) await visit(path)
      else if (entry.isFile() && filter(path))
        files.push({
          path: relative(directory, path),
          sha256: digest(await readFile(path)),
          mode: (await stat(path)).mode & 0o777,
        })
    }
  }
  await visit(directory)
  files.sort((left, right) => left.path.localeCompare(right.path))
  return { files, sha256: digest(JSON.stringify(files)) }
}
async function processLease(pid, kind, sessionId) {
  if (!Number.isSafeInteger(pid) || pid < 2) return undefined
  try {
    const value = await readFile(`/proc/${pid}/stat`, 'utf8')
    const fields = value.slice(value.lastIndexOf(')') + 2).split(' ')
    return { pid, kind, sessionId, startTicks: fields[19], alive: fields[0] !== 'Z' }
  } catch (error) {
    if (['ENOENT', 'ESRCH'].includes(error.code)) return { pid, kind, sessionId, alive: false }
    throw error
  }
}
async function leaseAlive(lease) {
  if (!lease) return false
  const current = await processLease(lease.pid, lease.kind, lease.sessionId)
  return current.alive && current.startTicks === lease.startTicks
}
async function inputGraphs() {
  const fixturePaths = [
    __filename,
    join(repository, 'tests/helpers/local-fixture.ts'),
    join(repository, 'tests/helpers/local-command-rewrite.cjs'),
    join(repository, 'tests/helpers/ssh-fixture.ts'),
    join(repository, 'tests/fixtures/fake-provider.cjs'),
  ]
  const executable = process.env.LIFE_ELECTRON_BINARY || require('electron')
  const ptyDirectory = dirname(require.resolve('node-pty/package.json'))
  return {
    src: await graph(join(appPath, 'src')),
    out: await graph(join(appPath, 'out')),
    packageSha256: digest(await readFile(join(appPath, 'package.json'))),
    executable: { path: executable, sha256: digest(await readFile(executable)) },
    pty: await graph(ptyDirectory, (path) =>
      /(?:\.node|spawn-helper|package\.json|utils\.js|unixTerminal\.js)$/.test(path),
    ),
    fixtures: await Promise.all(
      fixturePaths.map(async (path) => ({
        path: relative(repository, path),
        sha256: digest(await readFile(path)),
      })),
    ),
  }
}

// Loaded only by the first owned Local broker attachment. Restore NODE_OPTIONS
// before any daemon/provider spawn so native provider environment stays intact.
const readyGateSource = String.raw`const fs = require('node:fs')
const path = require('node:path')
let cfg
try { cfg = JSON.parse(Buffer.from(process.argv.at(-1), 'base64').toString('utf8')) } catch {}
const original = process.env.LIFE_SWITCH_ORIGINAL_NODE_OPTIONS
if (process.env.LIFE_SWITCH_HAD_NODE_OPTIONS === '1') process.env.NODE_OPTIONS = original
else delete process.env.NODE_OPTIONS
delete process.env.LIFE_SWITCH_ORIGINAL_NODE_OPTIONS
delete process.env.LIFE_SWITCH_HAD_NODE_OPTIONS
if (cfg && cfg.mode !== 'daemon' && /(?:^|\s)codex\s+app-server(?:\s|$)/.test(cfg.command || '')) {
  const entered = path.join(process.env.RELAY_TEST_HOME, 'switch-ready.entered.json')
  const release = path.join(process.env.RELAY_TEST_HOME, 'switch-ready.release')
  let claimed = false
  try { fs.writeFileSync(entered + '.claim', String(process.pid), { flag: 'wx' }); claimed = true } catch (error) { if (error.code !== 'EEXIST') throw error }
  if (claimed) {
    const write = process.stdout.write.bind(process.stdout)
    let held = false
    process.stdout.write = function (chunk, encoding, callback) {
      const value = Buffer.isBuffer(chunk) ? chunk.toString('utf8') : String(chunk)
      const first = value.split('\n')[0]
      let frame
      try { frame = JSON.parse(first) } catch {}
      if (!held && frame && frame.type === 'ready') {
        held = true
        fs.writeFileSync(entered, JSON.stringify({ id: cfg.id, attachmentPid: process.pid, frame, at: Date.now() }))
        const timer = setInterval(() => {
          if (!fs.existsSync(release)) return
          clearInterval(timer)
          fs.writeFileSync(entered + '.released', String(Date.now()))
          write(chunk, encoding, callback)
        }, 10)
        return true
      }
      return write(chunk, encoding, callback)
    }
  }
}
`

async function prepareGate(fixture) {
  const preloader = join(fixture.root, 'switch-ready-gate.cjs')
  await writeFile(preloader, readyGateSource)
  const adapter = join(fixture.root, 'rewrite-command.cjs')
  const previous = await readFile(adapter, 'utf8')
  assert.equal(previous.split('process.stdout.write(command)').length, 2)
  // Scope the injection to the literal encoded Local broker command. Provider
  // command configuration and runtime bytes remain the established fixture's.
  const replacement = String.raw`if (process.argv[3] === '-lc' && command.includes('export ELECTRON_RUN_AS_NODE=1; exec ')) {
  const quote = (value) => "'" + String(value).replaceAll("'", "'\\''") + "'"
  const inherited = process.env.NODE_OPTIONS
  command = 'export LIFE_SWITCH_HAD_NODE_OPTIONS=' + quote(inherited === undefined ? '0' : '1') + '; ' +
    'export LIFE_SWITCH_ORIGINAL_NODE_OPTIONS=' + quote(inherited || '') + '; ' +
    'export NODE_OPTIONS=' + quote((inherited ? inherited + ' ' : '') + '--require ' + JSON.stringify(require('node:path').join(process.env.RELAY_TEST_HOME, 'switch-ready-gate.cjs'))) + '; ' + command
}
process.stdout.write(command)`
  await writeFile(adapter, previous.replace('process.stdout.write(command)', replacement))
  return {
    preloaderSha256: digest(await readFile(preloader)),
    temporaryAdapterSha256: digest(await readFile(adapter)),
    canonicalAdapterSha256: digest(previous),
    ready: join(fixture.root, 'switch-ready.entered.json'),
    release: join(fixture.root, 'switch-ready.release'),
  }
}

async function run() {
  assert.ok(
    existsSync(join(appPath, 'out/main/index.js')),
    'An already built selected application is required',
  )
  await mkdir(artifacts, { recursive: true })
  for (const [name, entry] of [
    ['local', 'local-fixture.ts'],
    ['ssh', 'ssh-fixture.ts'],
  ])
    await build({
      entryPoints: [join(repository, 'tests/helpers', entry)],
      outfile: join(artifacts, `${name}-fixture.cjs`),
      bundle: true,
      platform: 'node',
      format: 'cjs',
      packages: 'external',
    })
  const { LocalFixture } = require(join(artifacts, 'local-fixture.cjs'))
  const { SSHFixture } = require(join(artifacts, 'ssh-fixture.cjs'))
  const proof = {
    fixture:
      'genuine Electron Local broker startup -> owned loopback SSH -> private renderer source compile and reload',
    expectedBaselineFailure: before,
    authenticatedProviderUse: false,
    inferenceRequests: 0,
    inputsBefore: await inputGraphs(),
    routes: [],
    rendererErrors: [],
    nativeLogs: [],
  }
  const save = () => writeFile(join(artifacts, 'proof.json'), JSON.stringify(proof, null, 2))
  let failure
  for (const route of routes) {
    const routeProof = { route, timings: [], ownedLeases: [], checks: [] }
    proof.routes.push(routeProof)
    let application
    let page
    const local = new LocalFixture()
    const ssh = new SSHFixture(join(repository, 'tests/fixtures/fake-provider.cjs'))
    let configurationRoot
    let privateUserData
    let dialogEvidence
    let sourceReadyEvidence
    let gate
    const owned = new Map()
    const collectOwned = async (fixture, transport) => {
      if (!fixture.root) return []
      const sessions = join(fixture.root, '.life/agent-sessions')
      if (!existsSync(sessions)) return []
      const records = []
      for (const id of await readdir(sessions)) {
        const statePath = join(sessions, id, 'state.json')
        if (!existsSync(statePath)) continue
        const state = JSON.parse(await readFile(statePath, 'utf8'))
        const journal = await readFile(join(sessions, id, 'journal.jsonl'), 'utf8')
        for (const [kind, pid] of [
          ['provider', state.pid],
          ['broker', state.brokerPid],
        ]) {
          const lease = await processLease(pid, `${transport}-${kind}`, id)
          if (lease?.alive) owned.set(`${lease.pid}:${lease.startTicks}`, lease)
        }
        records.push({
          id,
          state,
          journalBytes: Buffer.byteLength(journal),
          terminalFrames: journal
            .split('\n')
            .filter(Boolean)
            .map((line) => JSON.parse(line))
            .filter((frame) => frame.type === 'exit'),
        })
      }
      return records
    }
    const measure = async (name, callback) => {
      const start = performance.now()
      try {
        return await callback()
      } finally {
        routeProof.timings.push({ name, elapsedMs: performance.now() - start })
      }
    }
    try {
      await local.start(join(repository, 'tests/fixtures/fake-provider.cjs'))
      await ssh.start()
      configurationRoot = await mkdtemp(join(tmpdir(), 'life-switch-native-profile-'))
      dialogEvidence = join(configurationRoot, 'native-error-dialog.json')
      sourceReadyEvidence = join(configurationRoot, 'native-source-ready.json')
      gate = await prepareGate(local)
      routeProof.gate = gate
      privateUserData = join(configurationRoot, 'Life')
      await mkdir(privateUserData)
      await writeFile(
        join(privateUserData, 'connections.json'),
        JSON.stringify({ profiles: [], knownHosts: {}, localWorkspace: local.workspace }),
        { flag: 'wx' },
      )
      const env = { ...local.env, XDG_CONFIG_HOME: configurationRoot }
      delete env.ELECTRON_RENDERER_URL
      assert.equal(env.HOME, process.env.HOME)
      assert.equal(env.CODEX_HOME, process.env.CODEX_HOME)
      application = await electron.launch({
        executablePath: process.env.LIFE_ELECTRON_BINARY || require('electron'),
        args: [
          ...(process.env.LIFE_ELECTRON_BINARY ? [] : [appPath]),
          '--no-sandbox',
          '--disable-dev-shm-usage',
        ],
        cwd: appPath,
        env,
        timeout: 30000,
      })
      const nativeProcess = application.process()
      const appLease = await processLease(nativeProcess.pid, 'electron-main', route)
      owned.set(`${appLease.pid}:${appLease.startTicks}`, appLease)
      application.process().stderr?.on('data', (chunk) => {
        proof.nativeLogs.push(String(chunk))
        while (proof.nativeLogs.join('').length > 32000) proof.nativeLogs.shift()
      })
      page = await application.firstWindow()
      page.setDefaultTimeout(15000)
      page.on('pageerror', (error) => proof.rendererErrors.push(error.message))
      await page.locator('.app-shell').waitFor()
      await application.evaluate(
        ({ BrowserWindow, dialog, ipcMain }, evidence) => {
          BrowserWindow.getAllWindows()[0].setBounds({ width: 1920, height: 1080 })
          const show = dialog.showErrorBox.bind(dialog)
          dialog.showErrorBox = (title, content) => {
            process
              .getBuiltinModule('fs')
              .writeFileSync(evidence.dialog, JSON.stringify({ title, content, at: Date.now() }))
            return show(title, content)
          }
          const ready = ipcMain._invokeHandlers.get('source-code:ready')
          if (!ready) throw new Error('The genuine source ready IPC handler must exist')
          ipcMain.removeHandler('source-code:ready')
          ipcMain.handle('source-code:ready', async (event, ...args) => {
            const result = await ready(event, ...args)
            process.getBuiltinModule('fs').writeFileSync(
              evidence.ready,
              JSON.stringify({
                revision: args[0],
                at: Date.now(),
                originalHandlerAcknowledged: true,
              }),
            )
            return result
          })
        },
        { dialog: dialogEvidence, ready: sourceReadyEvidence },
      )
      const userData = await application.evaluate(({ app }) => app.getPath('userData'))
      assert.equal(userData, privateUserData)
      await page.evaluate(() => {
        globalThis.__switchTrustEvents = []
        window.relay.onHostKey((request) => {
          globalThis.__switchTrustEvents.push(request)
          window.relay.connection.trust(request.id, true).catch(() => {})
        })
      })
      await waitUntil(
        () => existsSync(gate.ready),
        'automatic Local model broker reaches the held ready frame',
        12000,
      )
      const held = JSON.parse(await readFile(gate.ready, 'utf8'))
      const attachmentLease = await processLease(held.attachmentPid, 'local-attachment', held.id)
      assert.equal(attachmentLease.alive, true)
      owned.set(`${attachmentLease.pid}:${attachmentLease.startTicks}`, attachmentLease)
      const localRecords = await collectOwned(local, 'local')
      const heldRecord = localRecords.find((record) => record.id === held.id)
      assert.ok(heldRecord)
      assert.equal(heldRecord.state.exited, false)
      assert.equal(heldRecord.state.lastInputSequence, 0)
      assert.equal(heldRecord.state.cursor, 0)
      assert.equal(heldRecord.journalBytes, 0)
      assert.equal(held.frame.cursor, 0)
      assert.equal(held.frame.lastInputSequence, 0)
      const localState = await page.evaluate(() => window.relay.connection.state())
      assert.equal(localState.status, 'connected')
      assert.equal(localState.profile.transport, 'local')
      assert.equal(localState.workspace, local.workspace)
      routeProof.heldBroker = { ...heldRecord, attachmentLease, localId: localState.profile.id }
      routeProof.checks.push(
        'the automatic Local model lookup owns a live provider and broker, with no input or output admitted before readiness',
      )
      const input = ssh.input()
      await page.evaluate(
        ({ route, input }) => {
          globalThis.__switchOperation = { settled: false }
          const start =
            route === 'disconnect'
              ? window.relay.connection.disconnect()
              : window.relay.connection.connect(input)
          start.then(
            (result) => {
              globalThis.__switchOperation = { settled: true, result }
            },
            (error) => {
              globalThis.__switchOperation = { settled: true, error: error.message }
            },
          )
        },
        { route, input },
      )
      await delay(180)
      if (before)
        await waitUntil(
          async () => (await page.evaluate(() => globalThis.__switchOperation)).settled,
          'the old switch resolves while Local readiness is still held',
          5000,
        )
      const whileHeld = await page.evaluate(async () => ({
        operation: globalThis.__switchOperation,
        connection: await window.relay.connection.state(),
      }))
      routeProof.whileReadyHeld = whileHeld
      routeProof.localProcessesWhileReadyHeld = await collectOwned(local, 'local')
      if (!before) {
        assert.equal(
          whileHeld.operation.settled,
          false,
          'Environment switch waits for the startup retirement barrier',
        )
        assert.equal(whileHeld.connection.status, 'connected')
        assert.equal(
          whileHeld.connection.profile.id,
          localState.profile.id,
          'Local stays selected until its owned idle startup exits',
        )
      } else {
        assert.equal(
          whileHeld.operation.settled,
          true,
          'The old implementation reproduces the early environment switch',
        )
        assert.ok(routeProof.localProcessesWhileReadyHeld.some((record) => !record.state.exited))
      }
      await writeFile(gate.release, 'release only the owned Local ready frame\n')
      await measure('selected-environment-switch', async () => {
        await waitUntil(
          async () => (await page.evaluate(() => globalThis.__switchOperation)).settled,
          'the switch finishes after native retirement',
          12000,
        )
        const result = await page.evaluate(() => globalThis.__switchOperation)
        assert.equal(result.error, undefined)
      })
      if (route === 'disconnect')
        await page.evaluate((input) => window.relay.connection.connect(input), input)
      await page.evaluate(
        (workspace) => window.relay.connection.selectWorkspace(workspace),
        input.workspace,
      )
      const remote = await page.evaluate(() => window.relay.connection.state())
      assert.equal(remote.status, 'connected')
      assert.equal(remote.profile.id, input.id)
      assert.equal(remote.workspace, input.workspace)
      routeProof.sshConnected = {
        id: remote.profile.id,
        workspace: remote.workspace,
        trustEvents: (await page.evaluate(() => globalThis.__switchTrustEvents)).length,
      }
      await collectOwned(ssh, 'ssh')
      if (!before) {
        const localAfter = await collectOwned(local, 'local')
        routeProof.localAfterSwitch = localAfter
        assert.ok(
          localAfter.every(
            (record) =>
              record.state.exited &&
              record.terminalFrames.some((frame) => frame.nativeExitConfirmed !== false),
          ),
        )
        await waitUntil(
          async () =>
            !(
              await Promise.all(
                [...owned.values()]
                  .filter((lease) => lease.kind.startsWith('local-'))
                  .map(leaseAlive),
              )
            ).some(Boolean),
          'the retired Local provider, broker and attachment all leave the OS process table',
          3000,
        )
        routeProof.checks.push(
          `${route} retires the pending Local model lookup before selecting the SSH environment`,
        )
      }
      const context = await page.evaluate(() =>
        window.relay.sourceCode.getContext({ paths: ['src/renderer/main.tsx'] }),
      )
      const main = context.files.find((file) => file.path === 'src/renderer/main.tsx').content
      assert.equal(main.split('<App />').length, 2)
      const marker = `local-to-ssh-${route}`
      const patch = {
        summary: `Verify Local to SSH ${route} source activation`,
        baseRevision: context.revision,
        files: [
          {
            path: 'src/renderer/main.tsx',
            content: main.replace(
              '<App />',
              `<App />\n      <span hidden data-life-switch-proof="${marker}" />`,
            ),
          },
        ],
      }
      const applied = await measure('private-source-compile', () =>
        page.evaluate((patch) => window.relay.sourceCode.apply(patch), patch),
      )
      assert.equal(applied.enabled, true)
      routeProof.compiledSource = {
        revision: applied.revision,
        activeRevision: applied.active.revision,
        privateUserData,
        installedSourceUnchanged: true,
      }
      await page.evaluate(() => window.relay.sourceCode.reload())
      if (before) {
        await waitUntil(
          () => existsSync(dialogEvidence),
          'the actual native source reload error dialog',
          15000,
        )
        routeProof.nativeErrorDialog = JSON.parse(await readFile(dialogEvidence, 'utf8'))
        assert.match(
          routeProof.nativeErrorDialog.content,
          /idle provider has not confirmed its exit/,
        )
        routeProof.baselineFailureReproduced = true
        throw new Error(
          'Baseline reproduces Local startup ownership loss: SSH connects, but source activation cannot confirm the old Local provider exit',
        )
      }
      await waitUntil(
        async () => {
          try {
            return (await page.locator(`[data-life-switch-proof="${marker}"]`).count()) === 1
          } catch {
            return false
          }
        },
        'the compiled private renderer activates after an actual document reload',
        15000,
      )
      assert.equal(existsSync(dialogEvidence), false)
      await waitUntil(
        () => existsSync(sourceReadyEvidence),
        'the real compiled bootstrap receives native source readiness acknowledgement',
      )
      routeProof.sourceReady = JSON.parse(await readFile(sourceReadyEvidence, 'utf8'))
      assert.equal(routeProof.sourceReady.revision, applied.active.revision)
      const models = await page.evaluate(() => window.relay.agent.models('codex'))
      assert.ok(models.some((model) => model.id === 'fixture-model' && model.isDefault))
      routeProof.completedModels = {
        at: Date.now(),
        catalog: models.map(({ id, name, isDefault }) => ({ id, name, isDefault })),
      }
      const activated = await page.evaluate(() => window.relay.sourceCode.get())
      assert.equal(activated.active.revision, applied.active.revision)
      assert.equal(
        (await page.evaluate(() => window.relay.connection.state())).profile.id,
        input.id,
      )
      routeProof.checks.push(
        'a real private source build reloads successfully and keeps the selected SSH project',
      )
      await page.screenshot({ path: join(artifacts, `${route}-source-activated-1080p.png`) })
      await collectOwned(ssh, 'ssh')
      const closing = application.close()
      closing.catch(() => {})
      await waitUntil(
        () => nativeProcess.exitCode !== null || nativeProcess.signalCode !== null,
        'normal native quit completes',
        20000,
      )
      await closing
      application = undefined
      await waitUntil(
        async () => !(await Promise.all([...owned.values()].map(leaseAlive))).some(Boolean),
        'native quit releases every owned app/provider/broker/attachment',
        3000,
      )
      routeProof.shutdown = {
        nativeExitCode: nativeProcess.exitCode,
        nativeSignal: nativeProcess.signalCode,
        manualProcessCleanup: false,
        allOwnedProcessesReleased: true,
      }
      assert.equal(nativeProcess.exitCode, 0)
      const messages = [...(await local.log()), ...(await ssh.log())]
      assert.ok(
        !messages.some(
          (entry) => entry.message?.method === 'turn/start' || entry.message?.type === 'user',
        ),
      )
      routeProof.providerWire = { entries: messages.length, userPrompts: 0, inferenceRequests: 0 }
    } catch (error) {
      routeProof.error = error.stack || String(error)
      failure ||= error
    } finally {
      await collectOwned(local, 'local')
      await collectOwned(ssh, 'ssh')
      routeProof.ownedLeases = [...owned.values()]
      routeProof.remainingBeforeTeardown = await Promise.all(
        [...owned.values()].map(async (lease) => ({ ...lease, alive: await leaseAlive(lease) })),
      )
      await save()
      // A failing baseline may have the real GTK error dialog open. Never
      // acknowledge it. Release only captured fixture-owned PID/start leases.
      if (application || routeProof.error) {
        const processHandle = application?.process()
        const signalled = []
        for (const lease of [...owned.values()].filter((value) => value.kind !== 'electron-main'))
          if (await leaseAlive(lease))
            try {
              process.kill(lease.pid, 'SIGKILL')
              signalled.push(lease)
            } catch {}
        const appLease = [...owned.values()].find((lease) => lease.kind === 'electron-main')
        if (processHandle && (await leaseAlive(appLease))) {
          processHandle.kill('SIGTERM')
          await delay(200)
          if (await leaseAlive(appLease)) processHandle.kill('SIGKILL')
          signalled.push(appLease)
        }
        routeProof.failureCleanup = {
          onlyCapturedOwnedPidStartLeases: true,
          nativeDialogAcknowledged: false,
          signalled,
        }
      }
      await waitUntil(
        async () => !(await Promise.all([...owned.values()].map(leaseAlive))).some(Boolean),
        'all captured leases are released before private fixture teardown',
        3000,
      )
      // The shared fixtures' convenience teardown reads raw PID fields. This
      // harness already checked their start leases, so remove only our private
      // session directories before invoking those helpers to prevent PID reuse.
      await Promise.all([
        ...(local.root
          ? [rm(join(local.root, '.life/agent-sessions'), { recursive: true, force: true })]
          : []),
        ...(ssh.root
          ? [rm(join(ssh.root, '.life/agent-sessions'), { recursive: true, force: true })]
          : []),
      ])
      await Promise.all([local.close(), ssh.close()])
      routeProof.remainingAfterTeardown = await Promise.all(
        [...owned.values()].map(async (lease) => ({ ...lease, alive: await leaseAlive(lease) })),
      )
      assert.ok(routeProof.remainingAfterTeardown.every((lease) => !lease.alive))
      if (configurationRoot)
        await rm(configurationRoot, {
          recursive: true,
          force: true,
          maxRetries: 10,
          retryDelay: 100,
        })
      await save()
    }
    if (failure) break
  }
  proof.inputsAfter = await inputGraphs()
  proof.inputsUnchanged = JSON.stringify(proof.inputsBefore) === JSON.stringify(proof.inputsAfter)
  assert.equal(proof.inputsUnchanged, true)
  proof.elapsedChecks = proof.routes.reduce((count, route) => count + route.checks.length, 0)
  if (!failure && proof.rendererErrors.length)
    failure = new Error(`Renderer errors: ${proof.rendererErrors.join('; ')}`)
  proof.passed = !failure
  await save()
  if (failure) throw failure
  console.log(
    `Local switch native smoke passed: ${proof.routes.length} routes, ${proof.elapsedChecks} checks; no auth or inference`,
  )
}
run().catch((error) => {
  console.error(error)
  process.exitCode = 1
})
