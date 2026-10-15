#!/usr/bin/env node
/* Separate bounded Electron metadata-startup quit regression. No user prompt. */
const assert = require('node:assert/strict')
const { createHash } = require('node:crypto')
const { existsSync } = require('node:fs')
const {
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  readlink,
  rename,
  rm,
  stat,
  writeFile,
} = require('node:fs/promises')
const { tmpdir } = require('node:os')
const { dirname, join, relative, resolve } = require('node:path')
const { build } = require('esbuild')
const { _electron: electron } = require('playwright')

const repository = resolve(process.env.LIFE_FIXTURE_REPOSITORY || join(__dirname, '../..'))
const appPath = resolve(process.env.LIFE_TEST_APP_PATH || '')
const artifacts = resolve(process.env.LIFE_METADATA_QUIT_ARTIFACTS || join(__dirname, 'run'))
const runId = process.env.LIFE_METADATA_QUIT_RUN_ID
const caseName = process.env.LIFE_METADATA_QUIT_CASE || 'ssh-allocated'
const [transport, phase] = caseName.split('-')
const caseDefinition = { name: caseName, transport, phase }
const expectedMain = process.env.LIFE_METADATA_QUIT_EXPECT_MAIN_SHA256
const marker = 'controlled-metadata-startup'
const digest = (bytes) => createHash('sha256').update(bytes).digest('hex')
const delay = (milliseconds) => new Promise((done) => setTimeout(done, milliseconds))
function bounded(promise, label, timeout = 15000) {
  let timer
  return Promise.race([
    promise,
    new Promise((_, reject) => {
      timer = setTimeout(() => reject(new Error(`Deadline: ${label}`)), timeout)
    }),
  ]).finally(() => clearTimeout(timer))
}
async function waitUntil(predicate, label, timeout = 15000) {
  const deadline = Date.now() + timeout
  while (Date.now() < deadline) {
    if (
      await bounded(Promise.resolve().then(predicate), label, Math.min(3000, deadline - Date.now()))
    )
      return
    await delay(15)
  }
  throw new Error(`Deadline: ${label}`)
}
async function graph(directory) {
  const files = []
  async function visit(current) {
    for (const item of await readdir(current, { withFileTypes: true })) {
      const path = join(current, item.name)
      if (item.isDirectory()) await visit(path)
      else if (item.isFile())
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
async function lease(pid, kind, sessionId) {
  if (!Number.isSafeInteger(pid) || pid < 2) return undefined
  try {
    const value = await readFile(`/proc/${pid}/stat`, 'utf8')
    const fields = value.slice(value.lastIndexOf(')') + 2).split(' ')
    return {
      pid,
      startTicks: fields[19],
      kind,
      sessionId,
      present: true,
      osState: fields[0],
      alive: fields[0] !== 'Z',
    }
  } catch (error) {
    if (['ENOENT', 'ESRCH'].includes(error.code))
      return { pid, kind, sessionId, present: false, alive: false }
    throw error
  }
}
async function alive(value) {
  if (!value) return false
  const current = await lease(value.pid, value.kind, value.sessionId)
  return current.alive && current.startTicks === value.startTicks
}
async function observeLease(value) {
  const current = await lease(value.pid, value.kind, value.sessionId)
  return {
    ...value,
    present: current.present,
    osState: current.osState,
    observedStartTicks: current.startTicks,
    alive: current.alive && current.startTicks === value.startTicks,
    terminationMeaning: !current.present
      ? 'OS entry absent'
      : current.osState === 'Z'
        ? 'terminated zombie; OS entry present'
        : current.startTicks !== value.startTicks
          ? 'original process lease ended; PID reused'
          : 'original process running',
  }
}
async function inputs() {
  const fixtureFiles = [
    __filename,
    join(__dirname, 'owned-runner.cjs'),
    ...['local-fixture.ts', 'ssh-fixture.ts', 'local-command-rewrite.cjs'].map((name) =>
      join(repository, 'tests/helpers', name),
    ),
    join(repository, 'tests/fixtures/fake-provider.cjs'),
  ]
  const executable = process.env.LIFE_ELECTRON_BINARY || require('electron')
  return {
    src: await graph(join(appPath, 'src')),
    out: await graph(join(appPath, 'out')),
    packageSha256: digest(await readFile(join(appPath, 'package.json'))),
    executable: { path: executable, sha256: digest(await readFile(executable)) },
    nativePty: await graph(dirname(require.resolve('node-pty/package.json'))),
    fixtures: await Promise.all(
      fixtureFiles.map(async (path) => ({ path, sha256: digest(await readFile(path)) })),
    ),
  }
}

function nativeObservers({ app, BrowserWindow, ipcMain }, options) {
  const fs = process.getBuiltinModule('fs')
  const promises = process.getBuiltinModule('fs/promises')
  const path = process.getBuiltinModule('path')
  const record = (phase, details = {}) => {
    try {
      fs.appendFileSync(
        options.phaseFile,
        JSON.stringify({
          phase,
          at: Date.now(),
          stage: options.stage,
          sourceRevision: options.revision,
          ...details,
        }) + '\n',
      )
    } catch (error) {
      try {
        process.stderr.write('[metadata observer unavailable] ' + error.message + '\n')
      } catch {}
    }
  }
  const state = { sequence: 0, targetModel: undefined, heldRead: false }
  const release = (file) =>
    new Promise((resolve, reject) => {
      const polling = setInterval(() => {
        if (fs.existsSync(file)) {
          clearInterval(polling)
          clearTimeout(deadline)
          resolve()
        }
      }, 10)
      const deadline = setTimeout(() => {
        clearInterval(polling)
        reject(new Error('Owned readiness boundary deadline'))
      }, 45000)
    })
  const directory = path.join(app.getPath('userData'), 'native-recovery')
  if (app.getPath('userData') !== options.userData) throw new Error('Private profile mismatch')
  app.prependListener('before-quit', () => record('normal-quit-entered'))
  if (options.stage === 'target' && options.phase === 'preallocation') {
    const original = promises.readdir
    promises.readdir = function (input, ...args) {
      if (path.resolve(String(input)) !== directory || !state.targetModel || state.heldRead)
        return original.call(this, input, ...args)
      state.heldRead = true
      record('native-recovery-read-entered', {
        directory,
        modelObservationId: state.targetModel,
        stack: new Error('Exact native recovery directory read').stack,
        readOwner: 'UNKNOWN',
        allocatorRegistration: 'UNKNOWN',
      })
      return Promise.resolve(original.call(this, input, ...args)).then(
        async (value) => {
          record('native-recovery-read-result-held', {
            directory,
            modelObservationId: state.targetModel,
            entries: value.map((entry) => (typeof entry === 'string' ? entry : entry.name)),
          })
          await release(options.readRelease)
          record('native-recovery-read-released', { modelObservationId: state.targetModel })
          return value
        },
        (error) => {
          record('native-recovery-read-failed', { message: error.message })
          throw error
        },
      )
    }
  }
  for (const channel of ['agent:models', 'source-code:ready']) {
    const original = ipcMain._invokeHandlers.get(channel)
    if (!original) throw new Error('Missing genuine native IPC handler: ' + channel)
    ipcMain.removeHandler(channel)
    ipcMain.handle(channel, async (event, ...args) => {
      const observationId = ++state.sequence
      const sender = {
        webContentsId: event.sender.id,
        frameRoutingId: event.senderFrame?.routingId,
        frameProcessId: event.senderFrame?.processId,
        frameURL: event.senderFrame?.url,
      }
      record('ipc-entered', {
        channel,
        observationId,
        ...sender,
        rawArgumentsBase64: Buffer.from(JSON.stringify(args)).toString('base64'),
      })
      if (
        options.stage === 'target' &&
        channel === 'source-code:ready' &&
        args[0] === options.revision
      ) {
        record('source-ready-delegation-held', { observationId, requestedRevision: args[0] })
        await release(options.readyRelease)
      }
      let result
      try {
        if (options.stage === 'target' && channel === 'agent:models' && args[0] === 'codex')
          state.targetModel ||= observationId
        record('original-handler-call-starting', { channel, observationId })
        result = original(event, ...args)
        record('original-handler-returned', {
          channel,
          observationId,
          provider: channel === 'agent:models' ? args[0] : undefined,
          allocatorAccepted: 'UNKNOWN: Promise return is not allocator acceptance',
        })
      } catch (error) {
        record('ipc-synchronous-rejection', { channel, observationId, message: error.message })
        throw error
      }
      if (channel === 'agent:models') {
        // Observe the actual sender frame without delaying or filtering delegation.
        try {
          event.senderFrame
            ?.executeJavaScript(
              `({ mounted: Boolean(document.querySelector('[data-life-metadata-startup="${options.marker}"]')), timeOrigin: performance.timeOrigin })`,
            )
            .then(
              (document) =>
                record('model-document-observed', { channel, observationId, ...sender, document }),
              (error) =>
                record('model-document-observation-failed', {
                  observationId,
                  message: error.message,
                }),
            )
            .catch((error) =>
              record('model-document-observation-failed', {
                observationId,
                message: error.message,
              }),
            )
        } catch (error) {
          record('model-document-observation-failed', { observationId, message: error.message })
        }
      }
      try {
        const value = await result
        record('ipc-settled-success', {
          channel,
          observationId,
          ...(channel === 'source-code:ready'
            ? { actualReadyAcknowledged: true, requestedRevision: args[0] }
            : {}),
        })
        return value
      } catch (error) {
        record('ipc-settled-error', { channel, observationId, message: error.message })
        throw error
      }
    })
  }
  const window = BrowserWindow.getAllWindows()[0]
  if (window) window.setBounds({ width: 1920, height: 1080 })
  record('private-observers-installed', { directory })
}
async function run() {
  assert.equal(process.platform, 'linux')
  assert.ok(process.env.DISPLAY && process.env.LIFE_TEST_APP_PATH && runId)
  assert.match(expectedMain || '', /^[a-f0-9]{64}$/)
  assert.ok(
    ['local-allocated', 'ssh-allocated', 'local-preallocation', 'ssh-preallocation'].includes(
      caseName,
    ),
  )
  assert.equal(digest(await readFile(join(appPath, 'out/main/index.js'))), expectedMain)
  await mkdir(artifacts, { recursive: true })
  const proof = {
    runId,
    case: caseDefinition,
    startedAt: new Date().toISOString(),
    authenticatedProviderUse: false,
    inferenceRequests: 0,
    passed: false,
    rendererErrors: [],
    nativeLogs: [],
    phases: [],
    snapshots: [],
    inputsBefore: await inputs(),
    unknown: {
      allocatorRegistration: 'UNKNOWN: no private Agents map observed',
      recoveryReadOwner: 'UNKNOWN: models may join concurrent background recovery',
    },
  }
  const owned = new Map()
  let local,
    ssh,
    configurationRoot,
    application,
    nativeProcess,
    page,
    server,
    polling,
    pollInFlight,
    failure
  let cutoffRequested = false,
    cutoffFlight,
    ledgerFlight = Promise.resolve(),
    targetStage = false
  const acquisitions = new Set()
  const phaseFile = join(artifacts, 'native-phases.jsonl')
  const allocatedGate = join(artifacts, 'allocated-model.entered.json')
  const allocatorArm = join(artifacts, 'allocated-model.arm.json')
  let readyRelease, readRelease, htmlRelease
  const save = () => writeFile(join(artifacts, 'proof.json'), JSON.stringify(proof, null, 2))
  const admit = () => {
    if (cutoffRequested) throw new Error('Owned fixture allocation cut off')
  }
  const remember = (value) => {
    if (!value?.alive) return
    const key = `${value.pid}:${value.startTicks}`
    const prior = owned.get(key)
    if (!prior || (prior.kind === 'owned-fixture-environment' && value.kind !== prior.kind))
      owned.set(key, value)
  }
  const ledger = () => {
    const target = join(artifacts, 'ownership-ledger.json')
    const value = JSON.stringify(
      {
        runId,
        case: caseDefinition,
        appPath,
        configurationRoot,
        localRoot: local?.root,
        sshRoot: ssh?.root,
        leases: [...owned.values()],
      },
      null,
      2,
    )
    ledgerFlight = ledgerFlight.then(async () => {
      await writeFile(target + '.tmp', value)
      await rename(target + '.tmp', target)
    })
    return ledgerFlight
  }
  const phases = async () =>
    existsSync(phaseFile)
      ? (await readFile(phaseFile, 'utf8'))
          .split('\n')
          .filter(Boolean)
          .map((line) => JSON.parse(line))
      : []
  const bind = async (pid, kind, sessionId, root) => {
    const prior = [...owned.values()].find(
      (value) => value.pid === pid && value.kind === kind && value.sessionId === sessionId,
    )
    if (prior) return observeLease(prior)
    const before = await lease(pid, kind, sessionId)
    if (!before?.alive) return before
    try {
      const environment = (await readFile(`/proc/${pid}/environ`)).toString().split('\0')
      const after = await lease(pid, kind, sessionId)
      if (
        !after.alive ||
        before.startTicks !== after.startTicks ||
        !environment.includes(`RELAY_TEST_HOME=${root}`)
      )
        return undefined
      remember(after)
      return after
    } catch (error) {
      if (['ENOENT', 'ESRCH'].includes(error.code)) return undefined
      throw error
    }
  }
  const collect = async (label) => {
    const snapshot = {
      label,
      at: Date.now(),
      stage: targetStage ? 'target' : 'setup',
      roots: [],
      brokerSessions: [],
    }
    for (const [environment, fixture] of [
      ['local', local],
      ['ssh', ssh],
    ]) {
      if (!fixture?.root) continue
      snapshot.roots.push({ transport: environment, root: fixture.root })
      const sessions = join(fixture.root, '.life/agent-sessions')
      if (!existsSync(sessions)) continue
      for (const id of await readdir(sessions)) {
        const root = join(sessions, id)
        if (!existsSync(join(root, 'state.json'))) continue
        const stateBytes = await readFile(join(root, 'state.json'))
        const state = JSON.parse(stateBytes.toString())
        const journal = await readFile(join(root, 'journal.jsonl'))
        const leases = []
        for (const [kind, pid] of [
          ['provider', state.pid],
          ['broker', state.brokerPid],
        ]) {
          const value = await bind(pid, `${environment}-${kind}`, id, fixture.root)
          if (value) leases.push(value)
        }
        snapshot.brokerSessions.push({
          transport: environment,
          id,
          root,
          state,
          stateBytesBase64: stateBytes.toString('base64'),
          journalBytesBase64: journal.toString('base64'),
          leases,
        })
      }
    }
    proof.snapshots.push(snapshot)
    if (proof.snapshots.length > 120) proof.snapshots.splice(1, proof.snapshots.length - 120)
    proof.phases = await phases()
    await ledger()
    return snapshot
  }
  const collectEnvironment = async () => {
    const roots = [local?.root, ssh?.root].filter(Boolean)
    const inaccessible = []
    for (const name of await readdir('/proc')) {
      if (!/^\d+$/.test(name)) continue
      const before = await lease(Number(name), 'owned-fixture-environment')
      if (!before?.alive) continue
      try {
        const environment = (await readFile(`/proc/${name}/environ`)).toString().split('\0')
        const after = await lease(Number(name), 'owned-fixture-environment')
        if (
          after.alive &&
          before.startTicks === after.startTicks &&
          roots.some((root) => environment.includes(`RELAY_TEST_HOME=${root}`))
        ) {
          const executable = await readlink(`/proc/${name}/exe`).catch(() => undefined)
          const argv = (await readFile(`/proc/${name}/cmdline`)).toString().split('\0')
          const final = await lease(Number(name), 'owned-fixture-environment')
          if (!final.alive || final.startTicks !== before.startTicks) continue
          if (
            executable === (process.env.LIFE_ELECTRON_BINARY || require('electron')) &&
            !environment.includes('ELECTRON_RUN_AS_NODE=1') &&
            !argv.some((value) => value.startsWith('--type='))
          ) {
            final.kind = 'electron-main'
            final.sessionId = targetStage ? 'target' : 'setup'
          }
          remember(final)
        }
      } catch (error) {
        if (error.code === 'EACCES')
          inaccessible.push({
            pid: Number(name),
            interpretation: 'UNKNOWN environment provenance, never owned or signalled',
          })
        else if (!['ENOENT', 'ESRCH'].includes(error.code)) throw error
      }
    }
    proof.inaccessibleEnvironmentInspections = inaccessible
    await ledger()
  }
  const acquire = async (promise, label, adoption, timeout = 15000) => {
    const flight = Promise.resolve(promise).then(async (value) => {
      await adoption(value)
      if (cutoffRequested) throw new Error('Late acquisition after cutoff: ' + label)
      return value
    })
    acquisitions.add(flight)
    flight.finally(() => acquisitions.delete(flight)).catch(() => {})
    const value = await bounded(flight, label, timeout)
    admit()
    return value
  }
  const cutoff = (reason) => {
    cutoffRequested = true
    if (cutoffFlight) return cutoffFlight
    cutoffFlight = (async () => {
      proof.passed = false
      await collect('failure evidence before allocator cutoff').catch((error) => {
        proof.cleanupError ||= error.message
      })
      const signalled = []
      for (const value of [...owned.values()].filter((value) => value.kind === 'electron-main'))
        if (await alive(value)) {
          process.kill(value.pid, 'SIGKILL')
          signalled.push(value)
        }
      await waitUntil(
        async () =>
          !(
            await Promise.all(
              [...owned.values()].filter((value) => value.kind === 'electron-main').map(alive),
            )
          ).some(Boolean),
        'known main allocator termination',
        3000,
      )
      await collectEnvironment().catch((error) => {
        proof.cleanupError ||= error.message
      })
      for (const value of [...owned.values()].filter((value) => value.kind === 'electron-main'))
        if (await alive(value)) {
          process.kill(value.pid, 'SIGKILL')
          signalled.push(value)
        }
      await bounded(
        Promise.allSettled([...acquisitions]),
        'late acquisition ownership settles after cutoff',
        5000,
      )
      for (const value of [...owned.values()].filter((value) => value.kind === 'electron-main'))
        if (await alive(value)) {
          process.kill(value.pid, 'SIGKILL')
          signalled.push(value)
        }
      await waitUntil(
        async () =>
          !(
            await Promise.all(
              [...owned.values()].filter((value) => value.kind === 'electron-main').map(alive),
            )
          ).some(Boolean),
        'late main allocator termination',
        3000,
      )
      for (const value of [...owned.values()].filter((value) => value.kind.endsWith('-broker')))
        if (await alive(value)) {
          process.kill(value.pid, 'SIGKILL')
          signalled.push(value)
        }
      for (const value of [...owned.values()])
        if (await alive(value)) {
          process.kill(value.pid, 'SIGKILL')
          signalled.push(value)
        }
      // A late Electron acquisition can become observable only after the first scan.
      await collectEnvironment()
      for (const value of [...owned.values()])
        if (await alive(value)) {
          process.kill(value.pid, 'SIGKILL')
          signalled.push(value)
        }
      await waitUntil(
        async () => !(await Promise.all([...owned.values()].map(alive))).some(Boolean),
        'failure leases terminate',
        3000,
      )
      await collectEnvironment()
      for (const value of [...owned.values()])
        if (await alive(value)) {
          process.kill(value.pid, 'SIGKILL')
          signalled.push(value)
        }
      await waitUntil(
        async () => !(await Promise.all([...owned.values()].map(alive))).some(Boolean),
        'final failure observer drain is terminal',
        3000,
      )
      await collectEnvironment()
      assert.ok(
        !(await Promise.all([...owned.values()].map(alive))).some(Boolean),
        'Final cutoff scan cannot certify newly discovered live descendants',
      )
      proof.failureCleanup = {
        reason,
        mainAllocationCutOffFirst: true,
        onlyMatchingOwnedPidStartLeases: true,
        signalled,
        normalShutdownPassed: false,
      }
      await save()
      await ledger()
    })()
    return cutoffFlight
  }
  const cutoffMessage = (message) => {
    if (message?.type !== 'metadata-fixture-cutoff' || message.runId !== runId) return
    failure ||= new Error('Owned runner requested bounded failure cutoff')
    cutoff(message.reason || 'runner cutoff').then(
      () => process.send?.({ type: 'metadata-fixture-cutoff-complete', runId }),
      (error) =>
        process.send?.({ type: 'metadata-fixture-cutoff-failed', runId, message: error.message }),
    )
  }
  process.on('message', cutoffMessage)
  const launch = async (rendererURL) => {
    admit()
    const environment = { ...local.env, XDG_CONFIG_HOME: configurationRoot }
    if (rendererURL) environment.ELECTRON_RENDERER_URL = rendererURL
    else delete environment.ELECTRON_RENDERER_URL
    assert.equal(environment.HOME, process.env.HOME)
    assert.equal(environment.CODEX_HOME, process.env.CODEX_HOME)
    const originalLaunch = electron.launch({
      executablePath: process.env.LIFE_ELECTRON_BINARY || require('electron'),
      args: [
        ...(process.env.LIFE_ELECTRON_BINARY ? [] : [appPath]),
        '--no-sandbox',
        '--disable-dev-shm-usage',
      ],
      cwd: appPath,
      env: environment,
      timeout: 30000,
    })
    await acquire(
      originalLaunch,
      'actual Electron acquisition',
      async (value) => {
        application = value
        nativeProcess = value.process()
        const valueLease = await bind(
          nativeProcess.pid,
          'electron-main',
          targetStage ? 'target' : 'setup',
          local.root,
        )
        assert.ok(valueLease?.alive)
        await ledger()
        nativeProcess.stderr?.on('data', (bytes) => {
          proof.nativeLogs.push(String(bytes))
          while (proof.nativeLogs.join('').length > 64000) proof.nativeLogs.shift()
        })
        if (cutoffRequested && (await alive(valueLease))) process.kill(valueLease.pid, 'SIGKILL')
      },
      32000,
    )
  }
  const watchPage = async () => {
    page = await bounded(application.firstWindow(), 'native first window')
    page.setDefaultTimeout(10000)
    page.on('pageerror', (error) =>
      proof.rendererErrors.push({
        message: error.message,
        at: Date.now(),
        stage: proof.quitRequested
          ? 'after-quit-request'
          : targetStage
            ? 'target-before-quit'
            : 'setup',
      }),
    )
    await bounded(page.locator('.app-shell').waitFor(), 'actual App mount')
    await bounded(
      page.evaluate(() =>
        window.relay.onHostKey((request) =>
          window.relay.connection.trust(request.id, true).catch(() => {}),
        ),
      ),
      'observe owned host trust',
    )
  }
  const connectSSH = async () => {
    admit()
    await bounded(
      page.evaluate((input) => window.relay.connection.connect(input), ssh.input()),
      'real SSH connect',
      25000,
    )
    admit()
    await bounded(
      page.evaluate(
        (workspace) => window.relay.connection.selectWorkspace(workspace),
        ssh.workspace,
      ),
      'real SSH project selection',
    )
  }
  const closeNormally = async (label) => {
    const processHandle = nativeProcess
    const closing = application.close()
    closing.catch(() => {})
    await bounded(closing, label, 30000)
    await waitUntil(
      () => processHandle.exitCode !== null || processHandle.signalCode !== null,
      'main actually reaped',
      3000,
    )
    application = undefined
    await collect(label + ' main terminal')
    await collectEnvironment()
    await waitUntil(
      async () => !(await Promise.all([...owned.values()].map(alive))).some(Boolean),
      label + ' all recorded processes terminated',
      3000,
    )
    assert.equal(processHandle.exitCode, 0)
    return {
      mainExitCode: processHandle.exitCode,
      mainSignalCode: processHandle.signalCode,
      mainActuallyReaped: true,
      manualProcessCleanup: false,
      allOwnedLeasesReleased: true,
    }
  }
  try {
    await writeFile(phaseFile, '')
    for (const [name, entry] of [
      ['local', 'local-fixture.ts'],
      ['ssh', 'ssh-fixture.ts'],
    ])
      await bounded(
        build({
          entryPoints: [join(repository, 'tests/helpers', entry)],
          outfile: join(artifacts, name + '-fixture.cjs'),
          bundle: true,
          platform: 'node',
          format: 'cjs',
          packages: 'external',
        }),
        'bundle private fixture',
      )
    const { LocalFixture } = require(join(artifacts, 'local-fixture.cjs'))
    const { SSHFixture } = require(join(artifacts, 'ssh-fixture.cjs'))
    const privateProvider = join(artifacts, 'metadata-provider.cjs')
    const provider = await readFile(join(repository, 'tests/fixtures/fake-provider.cjs'), 'utf8')
    const needle = "      if (message.method === 'model/list')\n"
    assert.equal(provider.split(needle).length, 2)
    const hold =
      `      if (message.method === 'model/list' && require('node:fs').existsSync(${JSON.stringify(allocatorArm)})) {\n` +
      `        const metadataFs = require('node:fs'); const metadataArm = JSON.parse(metadataFs.readFileSync(${JSON.stringify(allocatorArm)}, 'utf8'));\n` +
      `        if (process.env.RELAY_TEST_HOME === metadataArm.root) {\n` +
      `          let claimed = false; try { metadataFs.writeFileSync(${JSON.stringify(allocatedGate + '.claim')}, String(process.pid), { flag: 'wx' }); claimed = true } catch (error) { if (error.code !== 'EEXIST') throw error }\n` +
      `          if (claimed) { const observed = { at: Date.now(), providerPid: process.pid, root: process.env.RELAY_TEST_HOME, sourceRevision: metadataArm.sourceRevision, transport: metadataArm.transport, message, receivedLineBytesBase64: Buffer.from(line).toString('base64'), framing: 'readline stripped delimiter; delimiter bytes UNKNOWN' }; metadataFs.writeFileSync(${JSON.stringify(allocatedGate)}, JSON.stringify(observed)); record({ kind: 'metadata-model-list-held', ...observed }); return }\n        }\n      }\n`
    await writeFile(privateProvider, provider.replace(needle, hold + needle))
    proof.privateProviderSha256 = digest(await readFile(privateProvider))
    local = new LocalFixture()
    admit()
    await acquire(local.start(privateProvider), 'private Local start', async () => {
      await ledger()
    })
    ssh = new SSHFixture(privateProvider)
    admit()
    await acquire(ssh.start(), 'private SSH start', async () => {
      await ledger()
    })
    configurationRoot = await mkdtemp(join(tmpdir(), 'life-metadata-quit-profile-'))
    const userData = join(configurationRoot, 'Life')
    readyRelease = join(configurationRoot, 'target-ready.release')
    readRelease = join(configurationRoot, 'target-read.release')
    await mkdir(userData)
    await writeFile(
      join(userData, 'connections.json'),
      JSON.stringify({ profiles: [], knownHosts: {}, localWorkspace: local.workspace }),
      { flag: 'wx' },
    )
    await ledger()
    await launch()
    await watchPage()
    await bounded(
      page.evaluate(() => window.relay.agent.models('codex')),
      'healthy Local metadata',
      25000,
    )
    if (transport === 'ssh') await connectSSH()
    await bounded(
      page.evaluate(() => window.relay.agent.models('codex')),
      'healthy selected metadata',
      25000,
    )
    const context = await bounded(
      page.evaluate(() => window.relay.sourceCode.getContext({ paths: ['src/renderer/main.tsx'] })),
      'installed source context',
    )
    const content = context.files.find((value) => value.path === 'src/renderer/main.tsx').content
    assert.equal(content.split('<App />').length, 2)
    const patch = {
      summary: 'Controlled metadata startup quit probe',
      baseRevision: context.revision,
      files: [
        {
          path: 'src/renderer/main.tsx',
          content: content.replace(
            '<App />',
            `<App />\n      <span hidden data-life-metadata-startup="${marker}" />`,
          ),
        },
      ],
    }
    const compiled = await bounded(
      page.evaluate((value) => window.relay.sourceCode.apply(value), patch),
      'real private source compile',
      60000,
    )
    admit()
    proof.sourceRevision = compiled.active.revision
    await bounded(
      application.evaluate(nativeObservers, {
        stage: 'setup',
        phase,
        phaseFile,
        userData,
        revision: proof.sourceRevision,
        marker,
      }),
      'setup readiness observer',
    )
    await bounded(
      page.evaluate(() => window.relay.sourceCode.reload()),
      'setup source reload',
    )
    await waitUntil(
      async () =>
        (await phases()).some(
          (value) =>
            value.stage === 'setup' &&
            value.actualReadyAcknowledged &&
            value.requestedRevision === proof.sourceRevision,
        ),
      'real setup source-ready ACK',
    )
    await bounded(
      page.evaluate(() => window.relay.agent.models('codex')),
      'complete setup models',
      25000,
    )
    proof.setupShutdown = await closeNormally('normal setup quit')
    admit()
    targetStage = true
    const rendererDirectory = join(appPath, 'out/renderer')
    let releaseHTML
    const initialHTML = new Promise((resolve) => {
      releaseHTML = resolve
    })
    htmlRelease = releaseHTML
    const served = []
    const sockets = new Set()
    const { createServer } = require('node:http')
    admit()
    proof.staticServer = { host: '127.0.0.1', port: undefined, served }
    server = createServer((request, response) => {
      ;(async () => {
        const pathname = decodeURIComponent(new URL(request.url, 'http://fixture.invalid').pathname)
        const asset = resolve(
          rendererDirectory,
          '.' + (pathname === '/' ? '/index.html' : pathname),
        )
        if (!asset.startsWith(rendererDirectory + '/')) {
          response.writeHead(404).end()
          return
        }
        if (pathname === '/') await initialHTML
        const bytes = await readFile(asset)
        served.push({ path: relative(appPath, asset), sha256: digest(bytes), bytes: bytes.length })
        const type = asset.endsWith('.html')
          ? 'text/html'
          : asset.endsWith('.js')
            ? 'text/javascript'
            : asset.endsWith('.css')
              ? 'text/css'
              : asset.endsWith('.woff2')
                ? 'font/woff2'
                : 'application/octet-stream'
        response.writeHead(200, { 'Content-Type': type })
        response.end(bytes)
      })().catch((error) => {
        proof.staticServerError ||= error.message
        response.writeHead(500).end()
      })
    })
    server.on('connection', (socket) => {
      sockets.add(socket)
      socket.on('close', () => sockets.delete(socket))
    })
    server.__ownedSockets = sockets
    admit()
    await acquire(
      new Promise((resolve, reject) => {
        server.once('error', reject)
        server.listen(0, '127.0.0.1', resolve)
      }),
      'owned static listener',
      async () => {
        if (cutoffRequested) await new Promise((resolve) => server.close(resolve))
      },
    )
    const address = server.address()
    assert.ok(address && typeof address !== 'string')
    proof.staticServer.port = address.port
    if (phase === 'allocated')
      await writeFile(
        allocatorArm,
        JSON.stringify({
          root: transport === 'local' ? local.root : ssh.root,
          transport,
          sourceRevision: proof.sourceRevision,
        }),
      )
    await launch(`http://127.0.0.1:${address.port}/`)
    await waitUntil(
      async () =>
        bounded(
          application.evaluate(
            ({ BrowserWindow, ipcMain }) =>
              BrowserWindow.getAllWindows().length > 0 &&
              ipcMain._invokeHandlers.has('agent:models') &&
              ipcMain._invokeHandlers.has('source-code:ready'),
          ),
          'native target host initialization',
        ),
      'native window and real IPC handlers exist before HTML delivery',
    )
    await bounded(
      application.evaluate(nativeObservers, {
        stage: 'target',
        phase,
        phaseFile,
        userData,
        revision: proof.sourceRevision,
        marker,
        readyRelease,
        readRelease,
      }),
      'target delegate-only native observers before HTML',
    )
    releaseHTML()
    await watchPage()
    await waitUntil(
      async () => (await page.locator(`[data-life-metadata-startup="${marker}"]`).count()) === 1,
      'cold compiled DOM commitment',
    )
    if (transport === 'ssh') await connectSSH()
    const state = await bounded(
      page.evaluate(() => window.relay.connection.state()),
      'selected target environment',
    )
    assert.equal(state.status, 'connected')
    assert.equal(state.profile.transport === 'local' ? 'local' : 'ssh', transport)
    proof.selectedEnvironment = {
      transport,
      profileId: state.profile.id,
      workspace: state.workspace,
      root: transport === 'local' ? local.root : ssh.root,
    }
    if (phase === 'allocated')
      await waitUntil(
        () => existsSync(allocatedGate),
        'actual native model/list received by stand-in and held',
      )
    else
      await waitUntil(
        async () =>
          (await phases()).some(
            (value) =>
              value.stage === 'target' && value.phase === 'native-recovery-read-result-held',
          ),
        'actual native recovery read held before allocation',
      )
    await waitUntil(
      async () =>
        (await phases()).some(
          (value) =>
            value.stage === 'target' &&
            value.phase === 'source-ready-delegation-held' &&
            value.requestedRevision === proof.sourceRevision,
        ),
      'target source-ready delegation is explicitly held',
    )
    await waitUntil(
      async () =>
        (await phases()).some(
          (value) =>
            value.stage === 'target' &&
            value.phase === 'model-document-observed' &&
            value.document.mounted,
        ),
      'actual model sender frame observes compiled DOM',
    )
    const beforeQuit = await collect('controlled target gate before normal quit')
    const timeline = await phases()
    const readGate = timeline.find(
      (value) => value.stage === 'target' && value.phase === 'native-recovery-read-result-held',
    )
    const observation =
      phase === 'preallocation'
        ? readGate.modelObservationId
        : timeline.find(
            (value) =>
              value.stage === 'target' &&
              value.phase === 'original-handler-returned' &&
              value.channel === 'agent:models' &&
              value.provider === 'codex',
          ).observationId
    const modelEntry = timeline.find(
      (value) =>
        value.stage === 'target' &&
        value.phase === 'original-handler-returned' &&
        value.channel === 'agent:models' &&
        value.observationId === observation,
    )
    const document = timeline.find(
      (value) =>
        value.stage === 'target' &&
        value.phase === 'model-document-observed' &&
        value.observationId === observation,
    )
    assert.ok(modelEntry && document?.document.mounted)
    const isSettlement = (value) =>
      value.stage === 'target' &&
      value.channel === 'agent:models' &&
      value.observationId === observation &&
      ['ipc-settled-success', 'ipc-settled-error', 'ipc-synchronous-rejection'].includes(
        value.phase,
      )
    assert.ok(!timeline.some(isSettlement), 'Target genuine models request remains pending')
    assert.ok(
      !timeline.some(
        (value) =>
          value.stage === 'target' &&
          value.actualReadyAcknowledged &&
          value.requestedRevision === proof.sourceRevision,
      ),
    )
    const allocation =
      phase === 'allocated' ? JSON.parse(await readFile(allocatedGate, 'utf8')) : undefined
    let allocatedLeases = []
    if (allocation) {
      assert.equal(allocation.message.method, 'model/list')
      assert.equal(allocation.sourceRevision, proof.sourceRevision)
      const session = beforeQuit.brokerSessions.find(
        (value) => value.transport === transport && value.state.pid === allocation.providerPid,
      )
      assert.ok(session, 'Actual received model request binds to recorded broker state')
      allocatedLeases = session.leases.filter((value) => value.alive)
      assert.ok(
        allocatedLeases.some((value) => value.kind === transport + '-provider') &&
          allocatedLeases.some((value) => value.kind === transport + '-broker'),
      )
    }
    proof.controlledGate = {
      observedModel: { ...modelEntry, document: document.document },
      observedDirectoryRead: readGate,
      actualReceivedModel: allocation,
      allocatedProviderAndBrokerLeases: allocatedLeases,
      beforeQuitSnapshot: beforeQuit,
      modelPending: true,
      sourceReadyAcknowledged: false,
      sourceRevision: proof.sourceRevision,
      nativeAllocatorRegistration: 'UNKNOWN',
    }
    await collectEnvironment()
    await save()
    polling = setInterval(() => {
      if (!pollInFlight)
        pollInFlight = collect('target shutdown resource observation')
          .catch((error) => {
            proof.collectionError ||= error.message
          })
          .finally(() => {
            pollInFlight = undefined
          })
    }, 25)
    proof.quitRequested = { at: Date.now(), sourceRevision: proof.sourceRevision }
    const closing = application.close()
    closing.catch(() => {})
    await waitUntil(
      async () =>
        (await phases()).some(
          (value) => value.stage === 'target' && value.phase === 'normal-quit-entered',
        ),
      'normal target quit entered while gate pending',
      10000,
    )
    await collect('native quit entered before gate release')
    if (phase === 'preallocation')
      await writeFile(
        readRelease,
        'Release actual directory-read result only after normal quit entered\n',
      )
    await bounded(closing, 'normal target native quit acknowledgement', 30000)
    await waitUntil(
      () => nativeProcess.exitCode !== null || nativeProcess.signalCode !== null,
      'target main actually reaped',
      3000,
    )
    application = undefined
    await collect('target main terminal before any cleanup')
    await collectEnvironment()
    await waitUntil(
      async () => !(await Promise.all([...owned.values()].map(alive))).some(Boolean),
      'all owned target processes terminate through native quit',
      3000,
    )
    proof.shutdown = {
      mainExitCode: nativeProcess.exitCode,
      mainSignalCode: nativeProcess.signalCode,
      mainActuallyReaped: true,
      manualProcessCleanup: false,
      allOwnedLeasesReleased: true,
    }
    assert.equal(nativeProcess.exitCode, 0)
    const messages = [...(await local.log()), ...(await ssh.log())]
    proof.providerMessagesBase64 = Buffer.from(
      messages.map((value) => JSON.stringify(value)).join('\n'),
    ).toString('base64')
    assert.ok(
      !messages.some(
        (value) => value.message?.method === 'turn/start' || value.message?.type === 'user',
      ),
    )
    assert.ok(!proof.rendererErrors.some((value) => value.stage !== 'after-quit-request'))
    proof.passed = true
  } catch (error) {
    failure ||= error
    proof.error = error.stack || String(error)
  } finally {
    clearInterval(polling)
    if (pollInFlight)
      await bounded(pollInFlight, 'settle observer snapshot').catch((error) => {
        proof.cleanupError ||= error.message
      })
    await collect('before any fixture cleanup').catch((error) => {
      proof.cleanupError ||= error.message
    })
    await collectEnvironment().catch((error) => {
      proof.cleanupError ||= error.message
    })
    proof.ownedLeases = [...owned.values()]
    proof.remainingBeforeCleanup = await Promise.all([...owned.values()].map(observeLease))
    await save()
    if (failure || application)
      await bounded(cutoff('fixture failure'), 'bounded owned failure cutoff', 10000).catch(
        (error) => {
          proof.cleanupError ||= error.message
        },
      )
    if (htmlRelease) htmlRelease()
    if (readRelease) await writeFile(readRelease, 'Failure-only gate release\n').catch(() => {})
    if (readyRelease) await writeFile(readyRelease, 'Failure-only gate release\n').catch(() => {})
    if (server) {
      for (const socket of server.__ownedSockets || []) socket.destroy()
      await bounded(
        new Promise((resolve) => server.close(resolve)),
        'owned static listener close',
        3000,
      ).catch((error) => {
        proof.cleanupError ||= error.message
      })
      proof.staticServer.closed = !server.listening
    }
    await collectEnvironment().catch((error) => {
      proof.cleanupError ||= error.message
    })
    for (const fixture of [local, ssh])
      if (fixture?.root)
        await rm(join(fixture.root, '.life/agent-sessions'), { recursive: true, force: true })
    await bounded(Promise.all([local?.close(), ssh?.close()]), 'owned fixture closure', 5000).catch(
      (error) => {
        proof.cleanupError ||= error.message
      },
    )
    if (configurationRoot)
      await rm(configurationRoot, {
        recursive: true,
        force: true,
        maxRetries: 10,
        retryDelay: 100,
      }).catch((error) => {
        proof.cleanupError ||= error.message
      })
    proof.remainingAfterCleanup = await Promise.all([...owned.values()].map(observeLease))
    proof.phases = await phases()
    proof.inputsAfter = await inputs()
    proof.inputsUnchanged = JSON.stringify(proof.inputsBefore) === JSON.stringify(proof.inputsAfter)
    proof.completedAt = new Date().toISOString()
    if (
      failure ||
      proof.cleanupError ||
      proof.collectionError ||
      proof.staticServerError ||
      !proof.inputsUnchanged ||
      proof.remainingAfterCleanup.some((value) => value.alive)
    ) {
      proof.passed = false
      failure ||= new Error(
        proof.cleanupError ||
          proof.collectionError ||
          proof.staticServerError ||
          'Input/resource verification failed',
      )
    }
    await save()
    await ledger()
    process.off('message', cutoffMessage)
    if (process.connected) process.disconnect()
  }
  if (failure) throw failure
  console.log(
    `Metadata startup quit ${caseName} PASS; actual native gate, normal exit; no manual native cleanup/auth/inference`,
  )
}
run().catch((error) => {
  console.error(error)
  process.exitCode = 1
})
