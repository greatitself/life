const assert = require('node:assert/strict')
const { createHash } = require('node:crypto')
const { existsSync } = require('node:fs')
const { readFile, stat, writeFile } = require('node:fs/promises')
const { join, resolve } = require('node:path')

const historyKey = 'life.studio.sessions.v1'
const activeKey = 'life.studio.active.v1'
const repository = resolve(__dirname, '..', '..')
const featurePath = 'src/renderer/components/FixtureHypothesisBacklog.tsx'
const contextPaths = [
  '.life/configuration.json',
  '.life/source-context.json',
  '.life/extensions.json',
  '.life/bridge.json',
  '.life/settings-schema.json',
  '.life/source-schema.json',
  '.life/source-read-schema.json',
  '.life/extension-schema.json',
  '.life/diagnostics.json',
]

/**
 * The native harness supplies a real loopback SSH fixture and a disposable app
 * profile. Providers are deterministic CLIs; builds and extension workers are
 * real. This helper never invokes a public sharing service.
 */
async function runStudioChecks(context) {
  const page = () => context.getPage?.() || context.page
  const application = () => context.getApplication?.() || context.application
  const { fixture, artifacts, waitUntil } = context
  const studio = () =>
    page().getByRole('region', { name: 'Life Customization Studio', exact: true })
  const configuration = () => page().evaluate(() => window.relay.customization.get())
  const sourceCode = () => page().evaluate(() => window.relay.sourceCode.get())
  const extensions = () => page().evaluate(() => window.relay.extensions.get())
  const sessions = () =>
    page().evaluate((key) => JSON.parse(localStorage.getItem(key) || '[]'), historyKey)
  const activeSession = () =>
    page().evaluate(
      ({ history, active }) => {
        const records = JSON.parse(localStorage.getItem(history) || '[]')
        return records.find((record) => record.id === localStorage.getItem(active)) || records[0]
      },
      { history: historyKey, active: activeKey },
    )
  let lastRequestSessionId
  const sessionFor = async (request, sessionId = lastRequestSessionId) =>
    (await sessions()).find(
      (session) =>
        (!sessionId || session.id === sessionId) &&
        session.thread.messages.some(
          (message) => message.role === 'user' && message.text === request,
        ),
    )
  const openStudio = async () => {
    if (context.openStudio) await context.openStudio()
    else if (
      !(await page().getByRole('dialog', { name: 'Customize Life', exact: true }).isVisible())
    )
      await page().getByRole('button', { name: 'Customize', exact: true }).click()
    await studio().waitFor()
  }
  const sendStudio = async (request) => {
    await openStudio()
    lastRequestSessionId = (await activeSession()).id
    if (context.sendStudio) await context.sendStudio(request)
    else {
      await studio().getByRole('textbox', { name: 'Describe a Life customization' }).fill(request)
      await studio()
        .getByRole('button', { name: 'Send customization request', exact: true })
        .click()
    }
  }
  const waitSession = async (request, expected = 'complete') => {
    await waitUntil(
      async () => {
        const session = await sessionFor(request)
        return session?.stage === expected && !session.thread.busy
      },
      `Studio request settles as ${expected}: ${request.trim()}`,
      120000,
    )
    return sessionFor(request)
  }
  const chooseProvider = async (provider, model) => {
    const current = await activeSession()
    const choose = async (name) => {
      await studio()
        .getByRole('combobox', { name: /^Model:/ })
        .click()
      await page()
        .locator('.reference-select-content')
        .getByRole('option', { name, exact: true })
        .click()
    }
    if (current.thread.provider !== provider) {
      await choose(provider === 'codex' ? 'Codex default' : 'Claude default')
      await waitUntil(
        async () => (await activeSession()).thread.provider === provider,
        `Studio selects ${provider}`,
      )
    }
    // Opening the native model menu waits for discovery. The other provider's
    // fallback has just one default entry; no invented model ID is sent.
    if (model) await choose(provider === 'codex' ? 'Fixture Codex' : 'Opus')
  }
  const newSession = async (provider, model) => {
    await openStudio()
    const previous = (await activeSession()).id
    await studio().getByRole('button', { name: 'New customization', exact: true }).click()
    await waitUntil(async () => (await activeSession()).id !== previous, 'new Studio conversation')
    await chooseProvider(provider, model)
    return activeSession()
  }
  const chooseRun = async (kind, name) => {
    await studio()
      .getByRole('button', { name: /^Reasoning:/ })
      .click()
    await page()
      .locator('.reference-run-menu[role="menu"]')
      .getByRole('group')
      .nth(kind === 'effort' ? 0 : 1)
      .getByRole('menuitemradio', { name, exact: true })
      .click()
  }
  const openSettings = async () => {
    await openStudio()
    await studio().getByRole('button', { name: 'Details', exact: true }).click()
    await studio().getByRole('button', { name: 'Settings', exact: true }).click()
    const dialog = page().getByRole('dialog', { name: 'Settings', exact: true })
    await dialog.waitFor()
    return dialog
  }
  const openExtensions = async () => {
    await openStudio()
    await studio().getByRole('button', { name: 'Details', exact: true }).click()
    await studio().getByRole('button', { name: 'Manage and share extensions', exact: true }).click()
    const manager = page().getByRole('dialog', { name: 'Manage extensions', exact: true })
    await manager.waitFor()
    await manager.getByRole('tab', { name: /^Installed/ }).click()
    return manager
  }
  const openSource = async () => {
    await openStudio()
    await studio().getByRole('button', { name: 'Details', exact: true }).click()
    await studio().getByRole('button', { name: 'Inspect Life source', exact: true }).click()
    const manager = page().getByRole('dialog', { name: 'Life source', exact: true })
    await manager.waitFor()
    return manager
  }
  const closeDialog = () => page().keyboard.press('Escape')
  const workspace = async () => {
    assert.equal(typeof context.workspace, 'function', 'The harness supplies Agents navigation')
    await context.workspace()
  }
  const board = () => page().getByRole('region', { name: 'Source hypothesis backlog', exact: true })
  const waitForBoard = async (name) => {
    await waitUntil(
      async () => {
        try {
          await workspace()
          return await board().getByRole('heading', { name, exact: true }).isVisible()
        } catch {
          return false
        }
      },
      `real compiled source renders ${name}`,
      120000,
    )
    await waitUntil(
      async () =>
        !(await page().evaluate(() => localStorage.getItem('life.studio.pending-source.v1'))),
      'healthy Studio source clears its activation checkpoint',
    )
  }
  const waitForSourceReload = async (request, heading) => {
    const reloaded = page().waitForEvent('domcontentloaded', { timeout: 120000 })
    await sendStudio(request)
    await reloaded
    await waitForBoard(heading)
    return waitSession(request)
  }
  const ordinaryHistory = () =>
    page().evaluate(() => JSON.parse(localStorage.getItem('relay.threads.v1') || '[]'))
  const checks = []
  const proof = { checks, providers: [], source: {}, sharing: {} }
  const baselineWorkspace = (await page().evaluate(() => window.relay.connection.state())).workspace
  const baselineProjectThreads = (await ordinaryHistory()).map((thread) => thread.id)

  function userText(entry) {
    if (entry.message?.method === 'turn/start') return entry.message.params.input[0].text
    if (entry.message?.type === 'user')
      return entry.message.message?.content?.find((part) => part.type === 'text')?.text
  }

  async function assertInstructionFiles(entry, sessionId) {
    const directory = join(
      fixture.root,
      '.life',
      'customization',
      createHash('sha256').update(sessionId).digest('hex'),
    )
    assert.equal(entry.cwd, directory, 'Studio uses a private machine workspace, not the project')
    assert.equal((await stat(directory)).mode & 0o777, 0o700)
    const [agents, claude] = await Promise.all(
      ['AGENTS.md', 'CLAUDE.md'].map((file) => readFile(join(directory, file), 'utf8')),
    )
    assert.equal(agents, entry.instructions)
    assert.equal(claude, entry.instructions)
    assert.match(agents, /^# Life Customization Studio/m)
    assert.match(agents, /exact user message/)
    assert.deepEqual(
      entry.contextFiles.map((file) => file.path).sort(),
      contextPaths.slice().sort(),
    )
    for (const path of contextPaths) {
      const file = entry.contextFiles.find((candidate) => candidate.path === path)
      assert.equal(typeof file.content, 'string')
      assert.doesNotThrow(() => JSON.parse(file.content), `Structured context is JSON: ${path}`)
      assert.equal((await stat(join(directory, path))).mode & 0o777, 0o600)
    }
    assert.equal(entry.source.snapshot.path, '', 'Private native snapshot paths are not sent')
    return {
      directory,
      contextFiles: contextPaths,
      instructionsSha256: createHash('sha256').update(agents).digest('hex'),
    }
  }

  async function requestLog(start, provider, request, sessionId, phases = ['request']) {
    const log = (await fixture.log()).slice(start).filter((entry) => entry.provider === provider)
    const files = log.filter((entry) => entry.kind === 'studio-context')
    assert.deepEqual(
      files.map((entry) => entry.prompt),
      phases.map(() => request),
    )
    assert.deepEqual(
      files.map((entry) => entry.phase),
      phases,
    )
    const prompts = log.map(userText).filter((text) => text !== undefined)
    assert.ok(prompts.length >= phases.length, 'Provider receives each original request')
    assert.ok(
      prompts.every((text) => text === request),
      'No hidden words are added to provider user messages',
    )
    const fileProof = await assertInstructionFiles(files.at(-1), sessionId)
    if (provider === 'codex') {
      for (const entry of log.filter((candidate) => candidate.message?.method === 'turn/start')) {
        assert.equal(
          entry.message.params.input.length,
          1,
          'A Studio request has one exact user input',
        )
        assert.equal(
          entry.message.params.threadId,
          (await sessionFor(request, sessionId)).thread.remoteId,
        )
        assert.equal(entry.message.params.input[0].text, request)
      }
      const startThread = log.find((entry) => entry.message?.method === 'thread/start')
      if (startThread) assert.equal(startThread.message.params.cwd, fileProof.directory)
    } else {
      // Reloading source clears the model catalog. Its harmless discovery
      // process runs from the selected project, unlike a Studio conversation.
      const processes = log.filter((entry) => entry.argv?.includes('--include-partial-messages'))
      assert.ok(processes.every((entry) => entry.cwd === fileProof.directory))
      for (const entry of log.filter((candidate) => candidate.message?.type === 'user')) {
        assert.deepEqual(entry.message.message.content, [{ type: 'text', text: request }])
      }
    }
    const saved = await sessionFor(request, sessionId)
    assert.equal(saved.thread.purpose, 'customization')
    assert.equal(
      saved.thread.messages.filter((message) => message.role === 'user' && message.text === request)
        .length,
      1,
    )
    assert.equal(
      (await ordinaryHistory()).some((thread) => thread.id === saved.id),
      false,
    )
    await waitUntil(
      async () =>
        (await page().evaluate(() => window.relay.connection.state())).workspace ===
        baselineWorkspace,
      'Studio preserves the selected Agents project',
    )
    return { provider, request, sessionId, remoteId: saved.thread.remoteId, phases, ...fileProof }
  }

  // Simple settings remain fast and reversible without any provider turn.
  const originalConfig = await configuration()
  const localStart = (await fixture.log()).length
  await openStudio()
  const localRequest = `switch to ${originalConfig.config.theme === 'dark' ? 'light' : 'dark'} theme and set font size to 17 and use compact layout`
  await sendStudio(localRequest)
  await waitSession(localRequest)
  const locallyChanged = await configuration()
  assert.equal(
    locallyChanged.config.theme,
    originalConfig.config.theme === 'dark' ? 'light' : 'dark',
  )
  assert.equal(locallyChanged.config.fontSize, 17)
  assert.equal(locallyChanged.config.density, 'compact')
  assert.equal((await fixture.log()).slice(localStart).map(userText).filter(Boolean).length, 0)
  assert.equal(await page().locator('html').getAttribute('data-density'), 'compact')
  assert.equal(
    await page()
      .locator('html')
      .evaluate((element) => element.style.getPropertyValue('--life-font-size')),
    '17px',
  )
  assert.ok(
    (await sessionFor(localRequest)).thread.messages.some(
      (message) => message.role === 'tool' && message.title === 'Settings applied',
    ),
  )
  const settings = await openSettings()
  await settings.getByRole('button', { name: 'Undo', exact: true }).click()
  await waitUntil(
    async () =>
      JSON.stringify((await configuration()).config) === JSON.stringify(originalConfig.config),
    'Studio settings Undo restores all previous values',
  )
  await closeDialog()
  checks.push(
    'dedicated local settings, native presentation and complete Settings Undo without a provider prompt',
  )

  let extensionCounter = 0
  for (const provider of ['codex', 'claude']) {
    const session = await newSession(provider, true)
    await chooseRun('effort', provider === 'codex' ? 'High' : 'Max')
    await chooseRun('speed', 'Fast')
    const explanation = '  explain customization\n'
    const explanationStart = (await fixture.log()).length
    await sendStudio(explanation)
    await waitSession(explanation)
    await studio()
      .locator('.markdown')
      .getByText(
        'Life Customization Studio supports settings, executable extensions and renderer source.',
        { exact: true },
      )
      .waitFor()
    proof.providers.push(await requestLog(explanationStart, provider, explanation, session.id))
    const state = await configuration()
    const runtime = await extensions()
    const source = await sourceCode()
    for (const [request, answer] of [
      ['no change customization', 'Life already has this behavior.'],
      ['clarify customization', 'Which part of Life would you like me to change?'],
    ]) {
      const start = (await fixture.log()).length
      await sendStudio(request)
      await waitSession(request)
      await studio().locator('.markdown').getByText(answer).waitFor()
      await requestLog(start, provider, request, session.id)
      assert.deepEqual((await configuration()).config, state.config)
      assert.equal((await configuration()).revision, state.revision)
      assert.equal((await extensions()).revision, runtime.revision)
      assert.equal((await sourceCode()).revision, source.revision)
      assert.equal(await studio().locator('.chat-error').count(), 0)
    }
    const invalidStart = (await fixture.log()).length
    await sendStudio('invalid customization')
    const invalid = await waitSession('invalid customization', 'failed')
    assert.ok(invalid.thread.messages.some((message) => message.role === 'error'))
    assert.deepEqual((await configuration()).config, state.config)
    assert.equal((await configuration()).revision, state.revision)
    assert.equal((await extensions()).revision, runtime.revision)
    assert.equal((await sourceCode()).revision, source.revision)
    proof.providers.push(
      await requestLog(invalidStart, provider, 'invalid customization', session.id, [
        'request',
        'repair',
        'repair',
      ]),
    )
    checks.push(
      `${provider} uses instruction files and verbatim messages; answers/no-ops/clarification preserve settings; invalid replies fail visibly without mutation`,
    )

    // A valid proposal can be inspected before any mutation, then applied.
    const autoApply = studio().getByRole('checkbox', { name: 'Apply valid changes automatically' })
    await autoApply.uncheck()
    const reviewStart = (await fixture.log()).length
    await sendStudio('add research panels')
    await waitSession('add research panels', 'review')
    assert.equal((await configuration()).revision, state.revision)
    await studio().getByRole('region', { name: 'Customization proposal' }).waitFor()
    await studio().getByRole('button', { name: 'Inspect changes', exact: true }).click()
    await studio().getByRole('heading', { name: 'Proposed changes', exact: true }).waitFor()
    await studio().getByRole('button', { name: 'Apply changes', exact: true }).click()
    await waitSession('add research panels')
    assert.equal((await configuration()).config.labels.researchTitle, 'Research lab')
    proof.providers.push(await requestLog(reviewStart, provider, 'add research panels', session.id))
    const undoSettings = await openSettings()
    await undoSettings.getByRole('button', { name: 'Undo', exact: true }).click()
    await waitUntil(
      async () => JSON.stringify((await configuration()).config) === JSON.stringify(state.config),
      `${provider} reviewed settings undo`,
    )
    await closeDialog()
    await openStudio()
    await autoApply.check()
    checks.push(`${provider} separates proposal review from application and supports Undo`)

    const runtimeStart = (await fixture.log()).length
    const request = 'add executable extension counter'
    await sendStudio(request)
    await waitSession(request)
    proof.providers.push(await requestLog(runtimeStart, provider, request, session.id))
    const installed = await extensions()
    const manifest = installed.extensions.find((extension) => extension.id === 'research-tools')
    assert.equal(manifest?.enabled, true)
    assert.deepEqual(installed.errors, {})
    await workspace()
    await page().getByRole('button', { name: 'Research tools', exact: true }).click()
    const frame = page().frameLocator('iframe[title="Research tools"]')
    await frame.getByRole('heading', { name: 'Research counter', exact: true }).waitFor()
    await frame.getByText('SSH: connected', { exact: true }).waitFor()
    await frame.getByRole('button', { name: 'Increment', exact: true }).click()
    await frame.getByText(`Count: ${++extensionCounter}`, { exact: true }).waitFor()
    await frame.getByRole('button', { name: 'Increment', exact: true }).click()
    await frame.getByText(`Count: ${++extensionCounter}`, { exact: true }).waitFor()
    assert.deepEqual(
      await page().evaluate(() => window.relay.extensions.call('research-tools', 'inspect', null)),
      { hasRequire: true },
    )
    const workerConnection = await page().evaluate(() =>
      window.relay.extensions.call('research-tools', 'connection-inspect', null),
    )
    assert.equal(workerConnection.status, 'connected')
    assert.equal(workerConnection.workspace, baselineWorkspace)
    assert.deepEqual(
      await frame.locator('body').evaluate(() => {
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
      { require: 'undefined', process: 'undefined', relay: 'undefined', parentDocument: 'denied' },
    )
    checks.push(
      `${provider} installs a real executable extension with isolated iframe, working counter and native worker SSH bridge`,
    )
  }

  // Keep source customizations in a dedicated Studio session, never an Agents
  // conversation. The private source itself is compiled by the native host.
  const sourceSession = await newSession('codex', true)
  await chooseRun('effort', 'High')
  await chooseRun('speed', 'Fast')
  const baselineSource = await sourceCode()
  assert.equal(existsSync(join(repository, featurePath)), false)
  const sourceRequest = 'add a hypothesis backlog directly to the Life workspace'
  const sourceStart = (await fixture.log()).length
  const createdSession = await waitForSourceReload(sourceRequest, 'Hypothesis backlog')
  const created = await sourceCode()
  assert.equal(created.revision, baselineSource.revision + 1)
  assert.equal(created.active.revision, created.revision)
  assert.equal(new URL(created.active.js).protocol, 'life-code:')
  assert.equal(created.error, undefined)
  const creator = created.extensions.find((extension) => extension.files.includes(featurePath))
  assert.ok(creator?.enabled)
  assert.ok(creator.name)
  assert.ok(creator.files.includes('src/renderer/App.tsx'))
  assert.equal(creator.dependencies.clsx, '2.1.1')
  assert.equal(await page().locator('iframe').count(), 0)
  await board().getByRole('button', { name: 'Add hypothesis', exact: true }).click()
  await board().getByText('Hypotheses: 1', { exact: true }).waitFor()
  assert.equal(
    await board().evaluate((element) => element.classList.contains('has-hypotheses')),
    true,
  )
  const sourceFiles = await page().evaluate(
    (path) => window.relay.sourceCode.getContext({ paths: ['src/renderer/App.tsx', path] }),
    featurePath,
  )
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
  proof.source.creation = await requestLog(sourceStart, 'codex', sourceRequest, sourceSession.id, [
    'request',
    'source-read',
  ])
  const createLog = (await fixture.log())
    .slice(sourceStart)
    .filter((entry) => entry.kind === 'studio-context')
  assert.ok(
    createLog[1].source.files
      .find((file) => file.path === 'src/renderer/App.tsx')
      .content.includes('<main className="main-workspace" id="main-content">'),
  )
  assert.deepEqual(createLog[1].diagnostics.sourceRead.paths, ['src/renderer/App.tsx'])
  assert.equal(createdSession.thread.reasoningEffort, 'high')
  assert.equal(createdSession.thread.serviceTier, 'fast')
  checks.push(
    'Studio reads real source using instruction files and compiles a named React extension with an npm dependency; each continuation preserves exact user text',
  )

  // A failed compilation must leave the already mounted, interactive UI intact
  // while refreshed diagnostics let the same provider session repair the patch.
  await page().evaluate(() => {
    localStorage.setItem('life.native-studio-source-states', '[]')
    window.relay.sourceCode.onState((state) => {
      const records = JSON.parse(localStorage.getItem('life.native-studio-source-states') || '[]')
      records.push({
        revision: state.revision,
        active: state.active,
        enabled: state.enabled,
        error: state.error,
        studioTitle:
          document.querySelector('[aria-label="Life Customization Studio"] h1')?.textContent ||
          null,
      })
      localStorage.setItem('life.native-studio-source-states', JSON.stringify(records))
    })
  })
  const repairRequest = 'repair the hypothesis backlog after a deliberate compiler failure'
  const repairStart = (await fixture.log()).length
  await waitForSourceReload(repairRequest, 'Hypothesis backlog repaired')
  const repaired = await sourceCode()
  assert.equal(repaired.revision, created.revision + 1)
  assert.equal(repaired.error, undefined)
  const failed = (
    await page().evaluate(() =>
      JSON.parse(localStorage.getItem('life.native-studio-source-states') || '[]'),
    )
  ).find((state) => state.error?.includes('Life source build failed'))
  assert.ok(failed)
  assert.equal(failed.revision, created.revision)
  assert.equal(failed.active.revision, created.active.revision)
  assert.equal(failed.enabled, true)
  assert.match(failed.error, /FixtureHypothesisBacklog\.tsx/)
  assert.equal(failed.studioTitle, 'Make Life yours')
  await board().getByRole('button', { name: 'Add experiment', exact: true }).click()
  await board().getByText('Hypotheses: 1', { exact: true }).waitFor()
  proof.source.repair = await requestLog(repairStart, 'codex', repairRequest, sourceSession.id, [
    'request',
    'repair',
  ])
  const diagnostics = (await fixture.log())
    .slice(repairStart)
    .find((entry) => entry.kind === 'studio-context' && entry.phase === 'repair').diagnostics
  assert.match(diagnostics.repair.diagnostics, /Life source build failed/)
  assert.equal((await sessionFor(repairRequest)).thread.remoteId, createdSession.thread.remoteId)
  proof.source.failedCompile = {
    revision: failed.revision,
    activeRevision: failed.active.revision,
    visibleStudio: failed.studioTitle,
    repairedComponentInteractive: true,
  }
  checks.push(
    'failed source compilation preserves the live build and original remote conversation while real compiler diagnostics repair it',
  )

  const reviewSession = await newSession('claude', true)
  await chooseRun('effort', 'Max')
  await chooseRun('speed', 'Fast')
  const reviewRequest = 'retitle the hypothesis backlog from its source'
  const reviewStart = (await fixture.log()).length
  await waitForSourceReload(reviewRequest, 'Hypothesis backlog reviewed')
  const reviewed = await sourceCode()
  assert.equal(reviewed.revision, repaired.revision + 1)
  proof.source.review = await requestLog(reviewStart, 'claude', reviewRequest, reviewSession.id, [
    'request',
    'source-read',
  ])
  checks.push(
    'Claude reads complete current source and modifies the generated feature using the same exact request in its instruction-file continuation',
  )

  // Native source inspection distinguishes editable renderer code from the
  // read-only native host. The source extension remains individually visible.
  let manager = await openSource()
  const filter = manager.getByRole('textbox', { name: 'Filter Life source files', exact: true })
  await filter.fill('renderer/App.tsx')
  await manager.getByRole('button', { name: 'renderer/App.tsx', exact: true }).click()
  const rendererEditor = manager.getByRole('textbox', {
    name: 'Source of src/renderer/App.tsx',
    exact: true,
  })
  assert.equal(await rendererEditor.getAttribute('readonly'), null)
  assert.ok((await rendererEditor.inputValue()).includes('<FixtureHypothesisBacklog />'))
  if (context.screenshot) await context.screenshot('life-source-customization.png')
  await filter.fill('main/index.ts')
  await manager.getByRole('button', { name: 'main/index.ts', exact: true }).click()
  assert.equal(
    await manager
      .getByRole('textbox', { name: 'Source of src/main/index.ts', exact: true })
      .getAttribute('readonly'),
    '',
  )
  await closeDialog()
  manager = await openExtensions()
  const creatorCard = manager.locator(
    `article[data-extension-kind="source"][data-extension-id="${creator.id}"]`,
  )
  await creatorCard.waitFor()
  await creatorCard.scrollIntoViewIfNeeded()
  if (context.screenshot) await context.screenshot('life-extensions.png')
  assert.equal(
    await creatorCard
      .getByRole('checkbox', { name: `Enable ${creator.name}`, exact: true })
      .isChecked(),
    true,
  )
  assert.equal(
    await creatorCard
      .getByRole('checkbox', { name: `Enable ${creator.name}`, exact: true })
      .isDisabled(),
    false,
  )
  const bundle = await page().evaluate(
    (id) => window.relay.sourceCode.exportExtension(id),
    creator.id,
  )
  const portable = { format: 'life-extension', formatVersion: 1, kind: 'source', extension: bundle }
  assert.equal(JSON.stringify(portable).includes('fixture-password'), false)
  assert.equal(JSON.stringify(portable).includes(createdSession.thread.remoteId), false)

  // Only inspect the share dialog. Guard its IPC so an accidental publication
  // can never contact GitHub, even if this test environment contains a token.
  await application().evaluate(({ ipcMain }) => {
    globalThis.__lifeStudioSharing = { calls: [], handlers: new Map() }
    for (const channel of ['extension-sharing:publish', 'extension-sharing:inspect-public']) {
      globalThis.__lifeStudioSharing.handlers.set(channel, ipcMain._invokeHandlers.get(channel))
      ipcMain.removeHandler(channel)
      ipcMain.handle(channel, (_event, request) => {
        globalThis.__lifeStudioSharing.calls.push({ channel, request })
        throw new Error('The Studio preview smoke test does not publish or fetch public extensions')
      })
    }
  })
  try {
    await creatorCard
      .getByRole('button', { name: `Share ${creator.name} publicly`, exact: true })
      .click()
    const sharing = page().getByRole('dialog', { name: 'Share extension publicly', exact: true })
    await sharing.waitFor()
    await sharing.getByText('Review complete extension code', { exact: true }).click()
    assert.deepEqual(JSON.parse(await sharing.locator('pre').textContent()), portable)
    assert.equal(
      await sharing.getByRole('button', { name: 'Publish publicly', exact: true }).isDisabled(),
      true,
    )
    const token = `ghp_${'a'.repeat(24)}`
    await sharing.getByLabel('GitHub token', { exact: true }).fill(token)
    assert.equal(
      await sharing.getByRole('button', { name: 'Publish publicly', exact: true }).isDisabled(),
      false,
    )
    assert.deepEqual(await application().evaluate(() => globalThis.__lifeStudioSharing.calls), [])
    await sharing.getByRole('button', { name: 'Cancel', exact: true }).click()
    await creatorCard
      .getByRole('button', { name: `Share ${creator.name} publicly`, exact: true })
      .click()
    await sharing.waitFor()
    assert.equal(await sharing.getByLabel('GitHub token', { exact: true }).inputValue(), '')
    await sharing.getByRole('button', { name: 'Cancel', exact: true }).click()
    assert.equal((await page().evaluate(() => JSON.stringify(localStorage))).includes(token), false)
    proof.sharing = {
      extensionId: creator.id,
      exactCodePreview: true,
      publicCalls: 0,
      tokenPersisted: false,
    }
  } finally {
    await application().evaluate(({ ipcMain }) => {
      for (const [channel, handler] of globalThis.__lifeStudioSharing.handlers) {
        ipcMain.removeHandler(channel)
        if (handler) ipcMain.handle(channel, handler)
      }
      delete globalThis.__lifeStudioSharing
    })
  }
  await closeDialog()
  checks.push(
    'generated source is an independently managed extension; public sharing previews complete code and requires an explicit publish action, without storing tokens',
  )

  assert.equal(typeof context.launch, 'function', 'The harness supports a real native app restart')
  assert.equal(
    typeof context.reconnect,
    'function',
    'The harness supplies saved-password reconnection',
  )
  const savedStudio = await sessions()
  const savedRemoteIds = savedStudio.map((session) => ({
    id: session.id,
    remoteId: session.thread.remoteId,
  }))
  await application().close()
  await context.launch()
  await context.reconnect()
  await waitForBoard('Hypothesis backlog reviewed')
  await waitUntil(
    async () =>
      (await page().evaluate(() => window.relay.connection.state())).workspace ===
      baselineWorkspace,
    'the saved Agents thread restores its original project after app restart',
  )
  const restarted = await sourceCode()
  assert.equal(restarted.enabled, true)
  assert.equal(restarted.active.revision, reviewed.active.revision)
  assert.equal(restarted.recovered, false)
  for (const saved of savedRemoteIds)
    assert.equal(
      (await sessions()).find((session) => session.id === saved.id)?.thread.remoteId,
      saved.remoteId,
    )
  for (const id of baselineProjectThreads)
    assert.ok((await ordinaryHistory()).some((thread) => thread.id === id))
  proof.source.restart = {
    activeRevision: restarted.active.revision,
    preservedStudioSessions: savedRemoteIds.length,
    preservedProjectThreads: baselineProjectThreads.length,
  }
  checks.push(
    'compiled source and independent Studio histories survive an actual app exit/relaunch alongside all saved project threads',
  )

  await openStudio()
  await studio().getByRole('button', { name: 'Recovery', exact: true }).click()
  const rolledBack = page().waitForEvent('domcontentloaded', { timeout: 120000 })
  await studio().getByRole('button', { name: 'Restore previous source', exact: true }).click()
  await rolledBack
  await waitForBoard('Hypothesis backlog repaired')
  const rollback = await sourceCode()
  assert.equal(rollback.active.revision, repaired.active.revision)
  assert.equal(rollback.revision, reviewed.revision + 1)
  assert.equal(
    existsSync(join(repository, featurePath)),
    false,
    'Live customization does not overwrite the installed repository',
  )
  proof.source.rollback = {
    revision: rollback.revision,
    activeRevision: rollback.active.revision,
    installedSourceUnchanged: true,
  }
  checks.push(
    'Studio recovery restores the prior healthy compiled renderer without modifying installed source or deleting conversations',
  )

  // The same dedicated Studio must also recover when a valid build throws
  // during startup. This replaces the native window, rather than merely
  // reloading its document; the parent keeps the replacement page observed.
  assert.equal(typeof context.setPage, 'function', 'The harness observes a native fallback window')
  await openStudio()
  const runtimeRepairRequest = 'repair the hypothesis backlog after a deliberate runtime failure'
  const runtimeRepairStart = (await fixture.log()).length
  const previousWindowId = await application().evaluate(
    ({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].id,
  )
  const replacementWindow = application().waitForEvent('window', { timeout: 120000 })
  await sendStudio(runtimeRepairRequest)
  const replacementPage = await replacementWindow
  context.setPage(replacementPage)
  page().setDefaultTimeout(15000)
  await waitUntil(
    async () => {
      try {
        const state = await sourceCode()
        return (
          state.enabled && state.summary === 'Recover the hypothesis backlog after runtime feedback'
        )
      } catch {
        return false
      }
    },
    'native startup fallback repairs the dedicated Studio conversation',
    120000,
  )
  await waitForBoard('Hypothesis backlog recovered')
  const recoveredSource = await sourceCode()
  assert.equal(recoveredSource.error, undefined)
  assert.ok(recoveredSource.revision >= rollback.revision + 3)
  const replacementWindowId = await application().evaluate(
    ({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].id,
  )
  assert.notEqual(replacementWindowId, previousWindowId)
  const runtimeStudio = await waitSession(runtimeRepairRequest)
  assert.equal(runtimeStudio.id, reviewSession.id)
  assert.equal(runtimeStudio.thread.remoteId, proof.source.review.remoteId)
  assert.ok(
    runtimeStudio.thread.messages.some(
      (message) =>
        message.role === 'tool' &&
        message.title === 'Startup recovered' &&
        message.text.includes('Life runtime fixture'),
    ),
  )
  proof.source.runtimeRepair = await requestLog(
    runtimeRepairStart,
    'claude',
    runtimeRepairRequest,
    reviewSession.id,
    ['request', 'repair'],
  )
  const runtimeDiagnostics = (await fixture.log())
    .slice(runtimeRepairStart)
    .find((entry) => entry.kind === 'studio-context' && entry.phase === 'repair').diagnostics
  assert.match(runtimeDiagnostics.repair.diagnostics, /Life runtime fixture/)
  assert.equal(
    (await page().evaluate(() => window.relay.connection.state())).workspace,
    baselineWorkspace,
  )
  await openStudio()
  await studio().getByRole('button', { name: 'Recovery', exact: true }).click()
  const finalRollbackReload = page().waitForEvent('domcontentloaded', { timeout: 120000 })
  await studio().getByRole('button', { name: 'Restore previous source', exact: true }).click()
  await finalRollbackReload
  await waitForBoard('Hypothesis backlog repaired')
  const finalSource = await sourceCode()
  assert.equal(finalSource.active.revision, repaired.active.revision)
  for (const saved of savedRemoteIds)
    assert.equal(
      (await sessions()).find((session) => session.id === saved.id)?.thread.remoteId,
      saved.remoteId,
    )
  proof.source.runtimeRecovery = {
    previousWindowId,
    replacementWindowId,
    recoveredRevision: recoveredSource.revision,
    finalActiveRevision: finalSource.active.revision,
    preservedRemoteId: runtimeStudio.thread.remoteId,
  }
  checks.push(
    'a compiled startup failure triggers a new native window, repairs from actual diagnostics in the same Studio session, preserves SSH/history and rolls back to a healthy generation',
  )
  await openStudio()
  if (context.screenshot) await context.screenshot('life-studio.png')
  await writeFile(join(artifacts, 'desktop-studio-proof.json'), JSON.stringify(proof, null, 2))
  context.checks?.push(...checks)
  return proof
}

module.exports = { runStudioChecks }
