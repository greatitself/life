const assert = require('node:assert/strict')
const { createHash } = require('node:crypto')
const { existsSync, readFileSync } = require('node:fs')
const { mkdir, mkdtemp, readFile, readdir, rename, rm, writeFile } = require('node:fs/promises')
const { tmpdir } = require('node:os')
const { join } = require('node:path')
const { performance } = require('node:perf_hooks')
const { Transform } = require('node:stream')
const { StringDecoder } = require('node:string_decoder')
const { readSavedThreads } = require('./desktop-history.cjs')

const INITIAL = 'Recovery initial 🧪\n'
const FINAL = INITIAL + 'Recovery final café 漢字 🧪\n'
const CHILD_FINAL = 'Recovered child café 漢字 🧪'
const STUDIO_INITIAL = '<life-'
const MIDDLE = 'Recovery middle Ω 🧪\n'
const sha256 = (value) => createHash('sha256').update(value).digest('hex')
const alive = (pid) => {
  try {
    process.kill(pid, 0)
    return true
  } catch {
    return false
  }
}
const pause = (milliseconds) => new Promise((done) => setTimeout(done, milliseconds))

async function waitUntil(predicate, description, timeout = 20000) {
  const deadline = Date.now() + timeout
  while (Date.now() < deadline) {
    if (await predicate()) return
    await pause(40)
  }
  throw new Error(`Timed out waiting for ${description}`)
}

function providerLog(fixture) {
  return readFileSync(join(fixture.root, 'provider-messages.jsonl'), 'utf8')
    .split('\n')
    .filter(Boolean)
    .map((line) => JSON.parse(line))
}

function permissionEnvelope(frame, selector = 'permission') {
  if (frame.type !== 'write' || typeof frame.data !== 'string') return undefined
  const text = Buffer.from(frame.data, 'base64').toString('utf8')
  const lines = text.split('\n').filter(Boolean)
  for (const line of lines) {
    let native
    try {
      native = JSON.parse(line)
    } catch {
      continue
    }
    if (
      selector === 'interrupt'
        ? native.method === 'turn/interrupt' ||
          (native.type === 'control_request' && native.request?.subtype === 'interrupt')
        : (native.id !== undefined && native.result !== undefined && native.method === undefined) ||
          (native.type === 'control_response' && native.response?.subtype === 'success')
    )
      return { native, bytes: text, sha256: sha256(Buffer.from(frame.data, 'base64')) }
  }
  return undefined
}

function brokerIdentity(command) {
  for (const match of command.matchAll(/'([a-zA-Z0-9+/]{20,}={0,2})'/g)) {
    try {
      const configuration = JSON.parse(Buffer.from(match[1], 'base64').toString('utf8'))
      if (typeof configuration.id === 'string' && typeof configuration.command === 'string')
        return { id: configuration.id, root: configuration.root, launch: configuration.launch }
    } catch {}
  }
  throw new Error('The disposable SSH broker command has no identifiable session configuration')
}

/**
 * Only the disposable SSH server is instrumented. Life and its remote broker
 * execute their unmodified native transport code. The gate withholds an exact
 * input frame before broker acceptance, or its real ACK after acceptance.
 * Killing Life closes the old channel; withheld bytes never leak to a new one.
 */
function installBrokerGate(fixture) {
  const proof = []
  let armed
  const attach = (client) => {
    client.on('ready', () => {
      for (const originalSession of client.listeners('session')) {
        client.removeListener('session', originalSession)
        client.on('session', function (acceptSession, ...sessionArguments) {
          return originalSession.call(
            this,
            (...acceptArguments) => {
              const session = acceptSession(...acceptArguments)
              const originalOn = session.on
              session.on = function (event, listener) {
                if (event !== 'exec') return originalOn.call(this, event, listener)
                return originalOn.call(this, event, function (acceptExec, reject, info) {
                  return listener.call(
                    this,
                    (...argumentsForAccept) => {
                      const channel = acceptExec(...argumentsForAccept)
                      if (!info.command.includes('life_broker_runtime')) return channel
                      const broker = brokerIdentity(info.command)
                      const originalPipe = channel.pipe
                      const originalWrite = channel.write
                      let incoming = ''
                      let outgoing = ''
                      let nativeOutput = ''
                      let outputBlocked = false
                      const inputDecoder = new StringDecoder('utf8')
                      const outputDecoder = new StringDecoder('utf8')
                      const nativeDecoder = new StringDecoder('utf8')
                      const input = new Transform({
                        transform(chunk, encoding, callback) {
                          incoming += typeof chunk === 'string' ? chunk : inputDecoder.write(chunk)
                          for (;;) {
                            const index = incoming.indexOf('\n')
                            if (index < 0) break
                            const line = incoming.slice(0, index)
                            incoming = incoming.slice(index + 1)
                            let frame
                            try {
                              frame = JSON.parse(line)
                            } catch {
                              this.push(line + '\n')
                              continue
                            }
                            proof.push({
                              kind: 'broker-input-observed',
                              brokerId: broker.id,
                              sequence: frame.sequence,
                              type: frame.type,
                              ...(frame.type === 'write'
                                ? { wireSha256: sha256(Buffer.from(frame.data, 'base64')) }
                                : {}),
                              at: Date.now(),
                            })
                            if (armed?.mode === 'native-reply' && frame.type === 'write') {
                              for (const nativeLine of Buffer.from(frame.data, 'base64')
                                .toString('utf8')
                                .split('\n')
                                .filter(Boolean)) {
                                let native
                                try {
                                  native = JSON.parse(nativeLine)
                                } catch {
                                  continue
                                }
                                if (native.method === armed.method) {
                                  armed.requestId = native.id
                                  proof.push({
                                    kind: 'native-request-observed',
                                    method: native.method,
                                    requestId: native.id,
                                    sequence: frame.sequence,
                                    at: Date.now(),
                                  })
                                }
                              }
                            }
                            const envelope =
                              armed &&
                              armed.mode !== 'native-reply' &&
                              permissionEnvelope(frame, armed.selector)
                            if (envelope) {
                              const gate = armed
                              gate.brokerId = broker.id
                              gate.sequence = frame.sequence
                              gate.native = envelope.native
                              gate.wireSha256 = envelope.sha256
                              proof.push({
                                kind:
                                  gate.selector === 'interrupt'
                                    ? 'native-interrupt-envelope-observed'
                                    : 'native-permission-envelope-observed',
                                mode: gate.mode,
                                brokerId: broker.id,
                                sequence: frame.sequence,
                                native: envelope.native,
                                wireSha256: envelope.sha256,
                                at: Date.now(),
                              })
                              if (gate.mode === 'before-accept') {
                                gate.blocked = true
                                proof.push({
                                  kind: 'broker-input-withheld',
                                  brokerId: broker.id,
                                  sequence: frame.sequence,
                                  at: Date.now(),
                                })
                                continue
                              }
                            }
                            this.push(line + '\n')
                          }
                          callback()
                        },
                      })
                      // The fixture's channel.pipe(child.stdin) uses this input
                      // transform. A replacement connection gets its own pipe.
                      channel.pipe = function (destination, options) {
                        originalPipe.call(this, input)
                        input.pipe(destination, options)
                        return destination
                      }
                      channel.write = function (chunk, encoding, callback) {
                        if (typeof encoding === 'function') {
                          callback = encoding
                          encoding = undefined
                        }
                        outgoing += typeof chunk === 'string' ? chunk : outputDecoder.write(chunk)
                        let result = true
                        for (;;) {
                          const index = outgoing.indexOf('\n')
                          if (index < 0) break
                          const line = outgoing.slice(0, index)
                          outgoing = outgoing.slice(index + 1)
                          let frame
                          try {
                            frame = JSON.parse(line)
                          } catch {
                            result = originalWrite.call(this, line + '\n') && result
                            continue
                          }
                          if (frame.type === 'ready')
                            proof.push({
                              kind: 'broker-ready-observed',
                              brokerId: broker.id,
                              launch: broker.launch,
                              pid: frame.pid,
                              lastInputSequence: frame.lastInputSequence,
                              cursor: frame.cursor,
                              at: Date.now(),
                            })
                          if (
                            armed?.blockOutput &&
                            armed.native &&
                            typeof frame.cursor === 'number'
                          )
                            outputBlocked = true
                          if (armed?.mode === 'native-reply' && frame.type === 'stdout') {
                            nativeOutput += nativeDecoder.write(Buffer.from(frame.data, 'base64'))
                            for (;;) {
                              const nativeIndex = nativeOutput.indexOf('\n')
                              if (nativeIndex < 0) break
                              const nativeLine = nativeOutput.slice(0, nativeIndex)
                              nativeOutput = nativeOutput.slice(nativeIndex + 1)
                              let native
                              try {
                                native = JSON.parse(nativeLine)
                              } catch {
                                continue
                              }
                              if (
                                armed.requestId !== undefined &&
                                native.id === armed.requestId &&
                                native.result !== undefined
                              ) {
                                armed.blocked = true
                                outputBlocked = true
                                proof.push({
                                  kind: 'native-reply-withheld',
                                  method: armed.method,
                                  requestId: armed.requestId,
                                  native,
                                  cursor: frame.cursor,
                                  at: Date.now(),
                                })
                              }
                            }
                          }
                          if (outputBlocked && typeof frame.cursor === 'number') {
                            proof.push({
                              kind: 'following-output-withheld',
                              cursor: frame.cursor,
                              at: Date.now(),
                            })
                            continue
                          }
                          if (
                            armed?.mode === 'before-ack' &&
                            frame.type === 'ack' &&
                            frame.sequence === armed.sequence
                          ) {
                            armed.blocked = true
                            proof.push({
                              kind: 'broker-ack-withheld',
                              brokerId: broker.id,
                              sequence: frame.sequence,
                              at: Date.now(),
                            })
                          } else result = originalWrite.call(this, line + '\n') && result
                        }
                        callback?.()
                        return result
                      }
                      channel.once('close', () => {
                        input.destroy()
                        outgoing = ''
                        incoming = ''
                        proof.push({ kind: 'gated-channel-closed', at: Date.now() })
                      })
                      return channel
                    },
                    reject,
                    info,
                  )
                })
              }
              return session
            },
            ...sessionArguments,
          )
        })
      }
    })
  }
  fixture.server.on('connection', attach)
  return {
    proof,
    arm(mode, options = {}) {
      assert.ok(['before-accept', 'before-ack', 'native-reply'].includes(mode))
      assert.equal(armed, undefined)
      armed = { mode, blocked: false, ...options }
      return armed
    },
    disarm() {
      const previous = armed
      armed = undefined
      return previous
    },
  }
}

const opaqueArchive = [
  {
    id: 'restart-opaque-archive',
    profileId: '',
    provider: 'codex',
    title: 'Opaque recovery archive',
    createdAt: 7,
    messages: [
      null,
      37,
      'opaque scalar record',
      { id: 'future-envelope', role: 'future-native-role', payload: ['🧪', null, { x: 1 }] },
    ],
    futureThreadField: { untouched: ['é', { nested: true }] },
    pending: [{ nativeFutureField: { original: true } }],
  },
]

const opaqueStudioArchive = [
  null,
  {
    id: 'restart-opaque-studio',
    request: 'Original archived Studio request 🧪\r\n',
    stage: 'draft',
    createdAt: 1,
    updatedAt: 2,
    futureSessionField: { archived: ['漢字', null] },
    thread: {
      id: 'restart-opaque-studio',
      purpose: 'customization',
      profileId: '',
      provider: 'codex',
      title: 'Archived Studio recovery',
      messages: [
        null,
        { id: 'future-studio-message', role: 'future-native-role', payload: { exact: '\ud800' } },
      ],
      busy: false,
      mode: 'plan',
      model: '',
      turn: 0,
      pending: [],
      updatedAt: 2,
      futureThreadField: { preserved: true },
    },
  },
]

class RecoveryHarness {
  constructor({ repository, appPath, artifacts, electron, SSHFixture, proof }) {
    Object.assign(this, { repository, appPath, artifacts, electron, SSHFixture, proof })
    this.nativeLogs = []
    this.shutdowns = []
    this.launches = []
  }

  async setup(name, { studio = false } = {}) {
    this.name = name
    this.hasStudioArchive = studio
    this.configurationRoot = await mkdtemp(join(tmpdir(), 'life-active-recovery-profile-'))
    this.fixture = await new this.SSHFixture(
      join(this.repository, 'tests/helpers/active-session-recovery-provider.cjs'),
    ).start()
    this.gate = installBrokerGate(this.fixture)
    await mkdir(join(this.fixture.root, '.life'), { recursive: true })
    // Matched baseline/candidate setup: avoid an unrelated title inference.
    await writeFile(join(this.fixture.root, '.life/metadata'), 'Optional title staging unavailable')
    const nativeProfile = join(this.configurationRoot, 'Life')
    await mkdir(nativeProfile, { recursive: true })
    await writeFile(
      join(nativeProfile, 'conversations.json'),
      JSON.stringify({
        version: 1,
        savedAt: Date.now(),
        threads: opaqueArchive,
      }),
    )
    await this.launch()
    await waitUntil(
      async () =>
        (await readSavedThreads(this.page)).some(
          (thread) => thread?.id === 'restart-opaque-archive',
        ),
      'the renderer loads the archive seeded before the native process starts',
    )
    if (studio)
      await this.page.addInitScript((sessions) => {
        if (window.top !== window) return
        const marker = 'life.fixture.opaque-studio-seeded.v1'
        if (localStorage.getItem(marker) === '1') return
        // Seed only the replacement document, after the old document's real
        // unload flush. The marker forbids reseeding after any later loss.
        localStorage.setItem('life.studio.sessions.v1', JSON.stringify(sessions))
        localStorage.removeItem('life.studio.active.v1')
        localStorage.setItem(marker, '1')
      }, opaqueStudioArchive)
    await this.page.reload()
    await this.page.locator('.app-shell').waitFor()
    if (studio) await this.assertStudioOpaque()
    await this.observeEvents()
    await this.connect()
    await this.openAgents()
  }

  async launch() {
    const environment = { ...process.env, XDG_CONFIG_HOME: this.configurationRoot }
    delete environment.ELECTRON_RENDERER_URL
    this.application = await this.electron.launch({
      executablePath: process.env.LIFE_ELECTRON_BINARY || require('electron'),
      args: [
        ...(process.env.LIFE_ELECTRON_BINARY ? [] : [this.appPath]),
        ...(process.platform === 'linux' ? ['--no-sandbox'] : []),
        '--disable-dev-shm-usage',
      ],
      cwd: this.appPath,
      env: environment,
      timeout: 30000,
    })
    const log = []
    this.nativeLogs.push(log)
    this.application.process().stderr?.on('data', (chunk) => {
      log.push(String(chunk).slice(-16000))
      while (log.join('').length > 64000) log.shift()
    })
    this.page = await this.application.firstWindow()
    this.page.setDefaultTimeout(15000)
    this.page.on('pageerror', (error) =>
      this.proof.rendererErrors.push({ scenario: this.name, message: error.message }),
    )
    await this.page.locator('.app-shell').waitFor()
    await this.application.evaluate(({ BrowserWindow }) =>
      BrowserWindow.getAllWindows()[0].setBounds({ width: 1440, height: 960 }),
    )
    const userData = await this.application.evaluate(({ app }) => app.getPath('userData'))
    assert.ok(userData.startsWith(this.configurationRoot), 'Only a disposable profile is used')
    const nativeEnvironment = await this.application.evaluate(() => ({
      display: process.env.DISPLAY,
      pid: process.pid,
    }))
    this.launches.push({
      pid: this.application.process().pid,
      userData,
      nativeEnvironment,
      at: Date.now(),
    })
    await this.observeEvents()
  }

  async observeEvents() {
    await this.page.evaluate(() => {
      window.__activeRecoveryUnsubscribe?.()
      window.__activeRecoveryEvents = []
      window.__activeRecoveryUnsubscribe = window.relay.onAgent((event) =>
        window.__activeRecoveryEvents.push(event),
      )
    })
  }

  async connect() {
    const input = this.fixture.input()
    const dialog = this.page.getByRole('dialog', {
      name: /^(Connect a machine|Choose an environment)$/,
      exact: true,
    })
    const openedAutomatically = await dialog.waitFor({ state: 'visible', timeout: 5000 }).then(
      () => true,
      () => false,
    )
    if (!openedAutomatically)
      await this.page.getByRole('button', { name: 'Connections', exact: true }).click()
    await dialog.waitFor()
    const profiles = await this.page.evaluate(() => window.relay.profiles.list())
    const profile = profiles.find((entry) => entry.host === input.host && entry.port === input.port)
    if (profile) {
      await dialog
        .locator('.saved-profile')
        .filter({ hasText: profile.name })
        .getByRole('button')
        .first()
        .click()
    } else {
      const addSSH = dialog.getByRole('button', { name: 'Add SSH machine', exact: true })
      if (await addSSH.count()) await addSSH.click()
      await dialog.getByPlaceholder('My development server').fill(input.name)
      await dialog.getByPlaceholder('dev.example.com').fill(input.host)
      await dialog.getByLabel('Port', { exact: true }).fill(String(input.port))
      await dialog.getByPlaceholder('developer').fill(input.username)
      await dialog.getByLabel('Authentication').selectOption('password')
    }
    await dialog.getByPlaceholder('Your SSH password').fill(input.password)
    await dialog.getByRole('button', { name: 'Connect machine', exact: true }).click()
    const trust = this.page.getByRole('dialog', { name: 'Trust this machine?', exact: true })
    await waitUntil(
      async () =>
        (await trust.isVisible()) ||
        (await this.page.evaluate(() => window.relay.connection.state())).status === 'connected',
      'the real SSH host-key prompt or trusted connection',
    )
    if (await trust.isVisible())
      await trust.getByRole('button', { name: 'Trust and connect', exact: true }).click()
    await dialog.waitFor({ state: 'hidden' })
    const picker = this.page.getByRole('dialog', { name: 'Select a project', exact: true })
    await waitUntil(
      async () =>
        (await picker.isVisible()) ||
        (await this.page.evaluate(() => window.relay.connection.state())).workspace ===
          this.fixture.workspace,
      'the saved workspace or native project picker',
    )
    if (
      (await this.page.evaluate(() => window.relay.connection.state())).workspace !==
      this.fixture.workspace
    ) {
      await picker
        .getByRole('textbox', { name: 'Project directory', exact: true })
        .fill(this.fixture.workspace)
      await picker.getByRole('button', { name: 'Open project', exact: true }).click()
    }
    if (await picker.isVisible()) await picker.waitFor({ state: 'hidden' })
    await waitUntil(
      async () =>
        (await this.page.evaluate(() => window.relay.connection.state())).workspace ===
        this.fixture.workspace,
      'the exact original SSH workspace',
    )
  }

  async openAgents() {
    await this.page
      .getByRole('navigation', { name: 'Workspace views' })
      .getByRole('button', { name: /^(Agents|Agent workspace)$/ })
      .click()
  }

  async newThread(provider) {
    await this.openAgents()
    await this.page.getByRole('button', { name: 'New thread', exact: true }).click()
    await this.page.getByRole('combobox', { name: /^Model:/ }).click()
    await this.page
      .locator('.reference-select-content')
      .getByRole('option', {
        name: provider === 'codex' ? 'Codex default' : 'Claude default',
        exact: true,
      })
      .click()
  }

  async begin(provider, prompt) {
    await this.newThread(provider)
    const composer = this.page.getByRole('textbox', {
      name: /^(?:Message your coding agent|Message (?:Codex|Claude Code) about )/,
    })
    await composer.fill(prompt)
    assert.equal(await composer.inputValue(), prompt)
    await this.page.getByRole('button', { name: 'Send message', exact: true }).click()
    let thread
    await waitUntil(async () => {
      thread = await this.thread(prompt)
      return Boolean(thread)
    }, 'the submitted exact user prompt is durably saved')
    return thread
  }

  async send(provider, prompt) {
    await this.begin(provider, prompt)
    await waitUntil(
      () => this.log().some((entry) => entry.kind === 'turn-started' && entry.prompt === prompt),
      'the actual native provider receives the exact prompt once',
    )
    let thread
    await waitUntil(async () => {
      thread = await this.thread(prompt)
      return thread?.remoteId && thread.workspace === this.fixture.workspace
    }, 'native identity, owner and exact prompt are durably saved')
    const started = this.log().find(
      (entry) => entry.kind === 'turn-started' && entry.prompt === prompt,
    )
    assert.equal(started.threadId, thread.remoteId)
    assert.equal(started.cwd, thread.workspace)
    assert.ok(thread.profileId, 'The saved thread owns its exact machine profile')
    return { prompt, thread, started }
  }

  log() {
    return providerLog(this.fixture)
  }

  async thread(prompt) {
    return (await readSavedThreads(this.page)).find(
      (thread) =>
        thread &&
        typeof thread === 'object' &&
        Array.isArray(thread.messages) &&
        thread.messages.some((message) => message?.role === 'user' && message.text === prompt),
    )
  }

  async release(threadId, phase) {
    const directory = join(this.fixture.root, 'active-recovery-control')
    await mkdir(directory, { recursive: true })
    await writeFile(join(directory, `release-${encodeURIComponent(threadId)}-${phase}`), 'release')
  }

  async approval(prompt) {
    await this.page.locator('.approval-card').waitFor()
    const thread = await this.thread(prompt)
    const events = await this.page.evaluate(() => window.__activeRecoveryEvents)
    const event = events.findLast(
      (entry) => entry.type === 'approval' && entry.sessionId === thread.id,
    )
    assert.ok(
      event?.requestId,
      'The actual native approval carries its original actionable identity',
    )
    return event
  }

  async approve() {
    await this.page
      .locator('.approval-card')
      .getByRole('button', { name: 'Allow once', exact: true })
      .click()
  }

  async openStudio() {
    const dialog = this.page.getByRole('dialog', { name: 'Customize Life', exact: true })
    if (!(await dialog.isVisible()))
      await this.page.getByRole('button', { name: 'Customize', exact: true }).click()
    await this.page
      .getByRole('region', { name: 'Life Customization Studio', exact: true })
      .waitFor()
    return dialog
  }

  async sendStudio(provider, prompt) {
    const dialog = await this.openStudio()
    await dialog.getByRole('button', { name: 'New customization', exact: true }).click()
    await dialog.getByRole('combobox', { name: /^Model:/ }).click()
    await this.page
      .locator('.reference-select-content')
      .getByRole('option', {
        name: provider === 'codex' ? 'Codex default' : 'Claude default',
        exact: true,
      })
      .click()
    const composer = dialog.getByRole('textbox', {
      name: 'Describe a Life customization',
      exact: true,
    })
    await composer.fill(prompt)
    assert.equal(await composer.inputValue(), prompt)
    await dialog.getByRole('button', { name: 'Send customization request', exact: true }).click()
    await waitUntil(
      () => this.log().some((entry) => entry.kind === 'turn-started' && entry.prompt === prompt),
      'the real Studio native provider receives the exact original user request',
    )
    let session
    await waitUntil(async () => {
      session = await this.studioSession(prompt)
      return session?.thread?.remoteId && session.thread.profileId
    }, 'the Studio native identity and machine owner are durably saved')
    const started = this.log().find(
      (entry) => entry.kind === 'turn-started' && entry.prompt === prompt,
    )
    assert.equal(started.threadId, session.thread.remoteId)
    const nativeWorkspace = join(this.fixture.root, '.life', 'customization', sha256(session.id))
    assert.equal(started.cwd, nativeWorkspace)
    if (session.thread.workspace !== undefined) assert.equal(started.cwd, session.thread.workspace)
    return { prompt, session, started }
  }

  async studioSession(prompt) {
    return this.page.evaluate((request) => {
      const sessions = JSON.parse(localStorage.getItem('life.studio.sessions.v1') || '[]')
      return sessions.find((session) => session && session.request === request)
    }, prompt)
  }

  async assertStudioOpaque() {
    const raw = await this.page.evaluate(() =>
      JSON.parse(localStorage.getItem('life.studio.sessions.v1') || '[]'),
    )
    const original = raw.filter((entry) => entry === null || entry?.id === 'restart-opaque-studio')
    assert.deepEqual(original, opaqueStudioArchive)
    return sha256(JSON.stringify(original))
  }

  async studioActionReceipts(sessionId) {
    const directory = join(this.launches.at(-1).userData, 'native-recovery-actions')
    const paths = await readdir(directory)
    const records = []
    for (const file of paths.filter((path) => /^[a-f0-9]{64}\.json$/.test(path))) {
      const { record } = JSON.parse(await readFile(join(directory, file), 'utf8'))
      if (record?.request?.sessionId !== sessionId) continue
      records.push({
        actionId: record.request.actionId,
        transportId: record.request.transportId,
        ownerGeneration: record.request.ownerGeneration,
        kind: record.request.kind,
        intent: record.request.intent,
        status: record.status,
        intentHash: record.intentHash,
        native: record.receipt?.native,
        sourceRevision: record.receipt?.snapshot?.revision,
        error: record.error,
      })
    }
    return records
  }

  async flush() {
    await this.page.evaluate(async () => {
      await window.__lifeFlushConversationHistory?.()
    })
  }

  async shutdown(mode, expectedPids, { active = true } = {}) {
    if (mode === 'crash' && this.hasStudioArchive) await this.assertStudioOpaque()
    const application = this.application
    const native = application.process()
    const started = performance.now()
    const exited = new Promise((done) =>
      native.once('exit', (code, signal) => done({ code, signal, at: Date.now() })),
    )
    if (mode === 'crash') native.kill('SIGKILL')
    else
      await application.evaluate(({ app }) => {
        setTimeout(() => app.quit(), 0)
      })
    const result = await Promise.race([
      exited,
      new Promise((_, reject) =>
        setTimeout(
          () => reject(new Error('The isolated native process did not exit')),
          15000,
        ).unref(),
      ),
    ])
    this.application = undefined
    this.page = undefined
    if (mode === 'crash') assert.equal(result.signal, 'SIGKILL')
    else {
      assert.equal(result.code, 0)
      assert.equal(result.signal, null)
    }
    await waitUntil(() => this.fixture.clients.size === 0, 'native SSH connections fully close')
    const observation = {
      mode,
      elapsedMs: performance.now() - started,
      ...result,
      providers: expectedPids.map((pid) => ({ pid, alive: alive(pid) })),
    }
    this.shutdowns.push(observation)
    assert.ok(
      observation.providers.every((entry) => entry.alive === active),
      active
        ? 'Active root, child or pending approval keeps its original native provider alive'
        : 'Verified idle native ownership is released before application shutdown completes',
    )
    return observation
  }

  async reopen() {
    await this.launch()
    await this.connect()
    await this.openAgents()
  }

  async select(record) {
    await this.page.locator(`[data-thread-row="${record.thread.id}"]`).click()
  }

  async assertOwnership(record) {
    const current = await this.thread(record.prompt)
    assert.ok(current, 'The original saved conversation remains available')
    assert.equal(current.id, record.thread.id)
    assert.equal(current.remoteId, record.thread.remoteId)
    assert.equal(current.profileId, record.thread.profileId)
    assert.equal(current.workspace, record.thread.workspace)
    assert.equal(
      current.messages.filter(
        (message) => message?.role === 'user' && message.text === record.prompt,
      ).length,
      1,
      'Recovery retains one exact original user message',
    )
    const submissions = this.log().filter(
      (entry) => entry.kind === 'turn-started' && entry.prompt === record.prompt,
    )
    assert.equal(submissions.length, 1, 'Cold recovery never resubmits the user prompt')
    assert.equal(submissions[0].pid, record.started.pid)
    assert.equal(submissions[0].turnId, record.started.turnId)
    assert.equal(
      this.log().filter(
        (entry) => entry.kind === 'provider-started' && entry.pid === record.started.pid,
      ).length,
      1,
    )
    assert.equal(
      this.log().filter((entry) => entry.kind === 'writer-conflict').length,
      0,
      'Recovery never launches a competing writer for the original native session',
    )
    return current
  }

  async assertOpaque() {
    await this.flush()
    const raw = await readSavedThreads(this.page)
    const original = raw.filter((entry) => entry?.id === 'restart-opaque-archive')
    assert.deepEqual(original, opaqueArchive)
    return sha256(JSON.stringify(original))
  }

  async saveEvidence(filename, value) {
    await mkdir(this.artifacts, { recursive: true })
    await writeFile(join(this.artifacts, filename), JSON.stringify(value, null, 2))
  }

  async blockHistoryWrites() {
    const path = join(this.launches.at(-1).userData, 'conversations.json')
    const original = await readFile(path)
    const backup = path + '.active-recovery-fixture-backup'
    assert.equal(existsSync(backup), false)
    await rename(path, backup)
    await mkdir(path)
    this.historyWriteBlock = { path, backup, originalSha256: sha256(original) }
    await this.page.evaluate(() => {
      const originalSet = Storage.prototype.setItem
      window.__historyCacheFailures = []
      Storage.prototype.setItem = function (key, value) {
        if (key === 'relay.threads.v1' || key === 'life.conversation-checkpoint.v1') {
          window.__historyCacheFailures.push(key)
          throw new DOMException('Fixture conversation cache is full', 'QuotaExceededError')
        }
        return originalSet.call(this, key, value)
      }
    })
    return this.historyWriteBlock
  }

  async restoreHistoryWrites() {
    if (!this.historyWriteBlock) return
    const { path, backup, originalSha256 } = this.historyWriteBlock
    assert.equal(sha256(await readFile(backup)), originalSha256)
    await rm(path, { recursive: true, force: true })
    await rename(backup, path)
    assert.equal(sha256(await readFile(path)), originalSha256)
    this.historyWriteBlock = undefined
  }

  async blockStartedSourceAction(sessionId) {
    const directory = join(this.launches.at(-1).userData, 'native-recovery-actions')
    const knownKinds = new Map()
    const deadline = Date.now() + 30000
    while (Date.now() < deadline) {
      for (const file of (await readdir(directory)).filter((path) =>
        /^[a-f0-9]{64}\.json$/.test(path),
      )) {
        if (knownKinds.has(file) && knownKinds.get(file) !== 'source-apply') continue
        const path = join(directory, file)
        const original = await readFile(path)
        const { record } = JSON.parse(original)
        knownKinds.set(file, record.request.kind)
        if (record.request.sessionId !== sessionId || record.request.kind !== 'source-apply')
          continue
        if (record.status === 'intended') continue
        assert.equal(
          record.status,
          'started',
          'The terminal gate must capture the actual started apply record',
        )
        const backup = path + '.fixture-started-backup'
        assert.equal(existsSync(backup), false)
        await rename(path, backup)
        if (sha256(await readFile(backup)) !== sha256(original)) {
          await rename(backup, path)
          throw new Error(
            'Source apply progressed before the started record could be gated; no stale record was restored',
          )
        }
        await mkdir(path)
        this.actionTerminalBlock = {
          path,
          backup,
          originalSha256: sha256(original),
          actionId: record.request.actionId,
          intentHash: record.intentHash,
        }
        return this.actionTerminalBlock
      }
      await pause(4)
    }
    throw new Error('The native Source apply did not reach its observable started-record boundary')
  }

  async restoreActionTerminal() {
    if (!this.actionTerminalBlock) return
    const { path, backup, originalSha256 } = this.actionTerminalBlock
    assert.equal(sha256(await readFile(backup)), originalSha256)
    await rm(path, { recursive: true, force: true })
    await rename(backup, path)
    assert.equal(sha256(await readFile(path)), originalSha256)
    this.actionTerminalBlock = undefined
  }

  async close() {
    await this.restoreHistoryWrites()
    await this.restoreActionTerminal()
    let forced = false
    if (this.application) {
      const application = this.application
      const native = application.process()
      let timer
      try {
        await Promise.race([
          application.close().catch(() => {}),
          new Promise((resolve) => {
            timer = setTimeout(() => {
              forced = true
              if (native.exitCode === null && native.signalCode === null) native.kill('SIGKILL')
              resolve()
            }, 8000)
          }),
        ])
      } finally {
        clearTimeout(timer)
      }
    }
    this.application = undefined
    if (this.fixture) await this.fixture.close()
    assert.equal(forced, false, 'The owned fixture application must close without forced teardown')
  }
}

module.exports = {
  RecoveryHarness,
  waitUntil,
  providerLog,
  INITIAL,
  FINAL,
  CHILD_FINAL,
  STUDIO_INITIAL,
  MIDDLE,
  alive,
  sha256,
}
