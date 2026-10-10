/* Native desktop checks shared by the built-source and packaged smoke runs. */
const assert = require('node:assert/strict')
const { mkdir, readFile, rm, writeFile } = require('node:fs/promises')
const { join } = require('node:path')

const savedThreads = (page) =>
  page.evaluate(() => JSON.parse(localStorage.getItem('relay.threads.v1') || '[]'))

function promptFrom(entry) {
  if (entry.kind === 'title-metadata') return undefined
  const message = entry.message
  if (entry.provider === 'codex' && message?.method === 'turn/start')
    return message.params.input
      .filter((item) => item.type === 'text')
      .map((item) => item.text)
      .join('')
  if (entry.provider === 'claude' && message?.type === 'user') {
    const content = message.message.content
    return typeof content === 'string'
      ? content
      : content
          .filter((item) => item.type === 'text')
          .map((item) => item.text)
          .join('')
  }
  return undefined
}

async function saveProof(context, filename, proof) {
  await writeFile(join(context.artifacts, filename), JSON.stringify(proof, null, 2))
}

async function research(context) {
  await context
    .getPage()
    .getByRole('navigation', { name: 'Workspace views' })
    .getByRole('button', { name: 'Research', exact: true })
    .click()
  await context
    .getPage()
    .getByRole('complementary', { name: 'Research goals and problems' })
    .waitFor()
  const expand = context
    .getPage()
    .getByRole('button', { name: 'Expand research agent sidebar', exact: true })
  if (await expand.isVisible()) await expand.click()
}

async function sendAndSettle(context, text, provider) {
  const baseline = (await context.fixture.log()).length
  await context.send(text)
  await context.waitUntil(
    async () =>
      (await context.fixture.log())
        .slice(baseline)
        .some((entry) => entry.provider === provider && promptFrom(entry) === text),
    `exact ${provider} research/history request reaches the provider`,
  )
  await context.waitUntil(
    async () =>
      (await savedThreads(context.getPage())).some(
        (thread) =>
          thread.provider === provider &&
          !thread.busy &&
          thread.messages.some((message) => message.role === 'user' && message.text === text) &&
          thread.messages.some((message) => message.role === 'assistant' && message.text),
      ),
    `${provider} research/history turn settles and persists`,
  )
  const entries = (await context.fixture.log()).slice(baseline)
  const prompts = entries.map(promptFrom).filter((prompt) => prompt !== undefined)
  assert.deepEqual(prompts, [text], 'Conversation inference receives only the exact user request.')
  return { entries, prompts }
}

async function runResearchChecks(context) {
  await context.workspace()
  let page = context.getPage()
  const connection = await page.evaluate(() => window.relay.connection.state())
  assert.equal(connection.status, 'connected')
  assert.equal(connection.home, context.fixture.root)
  await page.getByRole('complementary', { name: 'Projects and threads', exact: true }).waitFor()
  const baselineAgentCount = await page
    .locator('#life-sidebar .sidebar-project-thread-list .thread-row')
    .count()
  const baselineAgentGroups = await page
    .locator('#life-sidebar .sidebar-project-thread-group')
    .evaluateAll((groups) => groups.map((group) => group.getAttribute('aria-label')).sort())
  const baselineThreads = await savedThreads(page)
  const baselineThreadIds = new Set(baselineThreads.map((thread) => thread.id))
  const baselineOrdinaryIds = baselineThreads
    .filter((thread) => !thread.purpose)
    .map((thread) => thread.id)
    .sort()
  const title = 'Native research: exact requests and independent environments'
  const brief = 'Compare literal prompts while keeping the Agents project unchanged.'
  const problemTitle = 'Verify the Claude research problem'
  const problemBrief = 'Keep this problem, its artifacts, and its conversation in Research.'

  await research(context)
  await page.getByRole('button', { name: 'New goal', exact: true }).click()
  let editor = page.getByRole('dialog', { name: 'New goal', exact: true })
  await editor.getByLabel('Title', { exact: true }).fill(title)
  await editor.getByLabel('Goal', { exact: true }).fill(brief)
  await editor.getByRole('button', { name: 'Create goal', exact: true }).click()
  await editor.waitFor({ state: 'hidden' })
  await page
    .getByRole('button', { name: `Open goal conversation: ${title}`, exact: true })
    .waitFor()
  await page.getByRole('button', { name: `Open goal conversation: ${title}`, exact: true }).click()
  await page.getByRole('button', { name: 'Research goal: ' + title, exact: true }).waitFor()
  const researchChat = page.getByRole('complementary', { name: 'Research conversation' })
  for (const selector of [
    '.research-sidebar .research-goals-heading',
    '.research-sidebar .research-goal-picker',
    '.research-sidebar .research-overview-button',
    '.research-method-goal',
    '.research-method-operation',
    '.research-problem-start',
    '.composer-caption',
    '.thread-message-navigator',
  ]) {
    assert.equal(
      await page.locator(selector).count(),
      0,
      selector + ' is absent from the updated Research panel',
    )
  }
  assert.equal(
    await researchChat.getByRole('button', { name: 'Attach images or files', exact: true }).count(),
    0,
  )
  for (const width of [1440, 1100]) {
    await page.setViewportSize({ width, height: 1000 })
    const layout = await researchChat.locator('.composer').evaluate((element) => {
      const style = getComputedStyle(element)
      const box = element.getBoundingClientRect()
      const sidebar = element.closest('.research-agent-sidebar').getBoundingClientRect()
      const actions = element.querySelector('.composer-send-actions').getBoundingClientRect()
      const controls = element.querySelector('.reference-run-controls').getBoundingClientRect()
      return {
        radius: style.borderRadius,
        borders: [style.borderLeftWidth, style.borderRightWidth, style.borderBottomWidth],
        gaps: [box.left - sidebar.left, sidebar.right - box.right, sidebar.bottom - box.bottom],
        actionsCenter: (actions.top + actions.bottom) / 2,
        controlsCenter: (controls.top + controls.bottom) / 2,
      }
    })
    assert.equal(layout.radius, '0px')
    assert.deepEqual(layout.borders, ['0px', '0px', '0px'])
    assert.ok(
      layout.gaps.every((gap) => Math.abs(gap) <= 1),
      JSON.stringify(layout),
    )
    assert.ok(Math.abs(layout.actionsCenter - layout.controlsCenter) <= 2, JSON.stringify(layout))
  }
  await page.setViewportSize({ width: 1440, height: 1000 })
  await context.selectModel('codex', '')
  await researchChat.getByRole('combobox', { name: /^Agent permission mode:/ }).click()
  assert.deepEqual(await page.locator('.reference-permission-title').allTextContents(), [
    'Ask for approval',
    'Read-only',
    'Approve for me',
    'Full access',
  ])
  await page.getByRole('option', { name: 'Ask for approval', exact: true }).click()
  context.checks.push(
    'Desktop Research includes the latest shared layout, one goal menu, a border-aligned composer, and native provider permissions',
  )
  const codexRequest = '  Compare these exact research hypotheses.\nKeep my whitespace and words.  '
  const codex = await sendAndSettle(context, codexRequest, 'codex')
  const goalThread = (await savedThreads(page)).find(
    (thread) =>
      !baselineThreadIds.has(thread.id) &&
      thread.messages.some((message) => message.text === codexRequest),
  )
  assert.ok(goalThread)
  assert.equal(goalThread.purpose, 'research')
  assert.equal(goalThread.profileId, connection.profile.id)
  assert.equal(
    goalThread.researchContext.scopeKey,
    JSON.stringify(['research', connection.profile.id, context.fixture.root]),
  )
  const researchRoot = join(context.fixture.root, '.life', 'research')
  const goalDirectory = join(researchRoot, goalThread.researchContext.goalId)
  assert.equal(goalThread.workspace, goalDirectory)
  assert.equal(
    (await page.evaluate(() => window.relay.connection.state())).workspace,
    connection.workspace,
    'A research turn never changes the active Agents project.',
  )
  await context.waitUntil(async () => {
    try {
      return (
        JSON.parse(await readFile(join(goalDirectory, 'goal.json'), 'utf8')).threadId ===
        goalThread.id
      )
    } catch {
      return false
    }
  }, 'Research goal conversation is written under machine home/.life/research')
  const instructions = await readFile(join(researchRoot, 'AGENTS.md'), 'utf8')
  const readme = await readFile(join(researchRoot, 'README.md'), 'utf8')
  assert.match(instructions, /Research workspace/)
  assert.match(instructions, /Read the current goal\.json/)
  assert.match(instructions, /Research requests do not authorize changing Life/)
  assert.match(readme, /~\/\.life\/research independently of Agents projects/)

  await page
    .locator('.life-research-overview')
    .getByRole('button', { name: 'Add problem', exact: true })
    .first()
    .click()
  editor = page.getByRole('dialog', { name: 'New problem', exact: true })
  await editor.getByLabel('Title', { exact: true }).fill(problemTitle)
  await editor.getByLabel('Problem', { exact: true }).fill(problemBrief)
  await editor.getByRole('button', { name: 'Add problem', exact: true }).click()
  await editor.waitFor({ state: 'hidden' })
  await context.selectModel('claude', '')
  const claudeRequest = '\nCheck the problem against the evidence.\nDo not rewrite this request.  '
  const claude = await sendAndSettle(context, claudeRequest, 'claude')
  const problemThread = (await savedThreads(page)).find(
    (thread) =>
      !baselineThreadIds.has(thread.id) &&
      thread.messages.some((message) => message.text === claudeRequest),
  )
  assert.ok(problemThread)
  assert.equal(problemThread.purpose, 'research')
  const problemDirectory = join(goalDirectory, 'problems', problemThread.researchContext.problemId)
  assert.equal(problemThread.workspace, problemDirectory)
  const problemContext = JSON.parse(
    await readFile(join(problemDirectory, '.life-context.json'), 'utf8'),
  )
  assert.equal(problemContext.problemId, problemThread.researchContext.problemId)
  assert.equal(problemContext.goalFile, '../../goal.json')
  const problemInstructions = await readFile(join(problemDirectory, 'AGENTS.md'), 'utf8')
  assert.match(problemInstructions, /Read \.life-context\.json/)
  assert.match(problemInstructions, /goalId and problemId/)
  assert.equal(await readFile(join(problemDirectory, 'CLAUDE.md'), 'utf8'), problemInstructions)
  assert.equal(problemThread.researchContext.goalId, goalThread.researchContext.goalId)
  assert.ok(problemThread.researchContext.problemId)
  await context.waitUntil(async () => {
    const goal = JSON.parse(await readFile(join(goalDirectory, 'goal.json'), 'utf8'))
    return goal.problems.some(
      (problem) =>
        problem.id === problemThread.researchContext.problemId &&
        problem.threadId === problemThread.id,
    )
  }, 'Research problem conversation is atomically saved beside its goal')

  // These are the real editable-map files that providers use. Rendering them
  // previously crashed React through a local `document` shadowing bug.
  const mapJson = join(goalDirectory, 'map.json')
  const mapMermaid = join(goalDirectory, 'map.mmd')
  const mapHtml = join(goalDirectory, 'map.html')
  const mapFormats = []
  try {
    await writeFile(
      mapJson,
      JSON.stringify({
        nodes: [
          { id: 'goal', label: 'Native JSON goal map', action: 'overview', x: 0, y: 0 },
          {
            id: 'problem',
            label: 'Native JSON problem map',
            problemId: problemThread.researchContext.problemId,
            x: 320,
            y: 0,
          },
        ],
        edges: [{ from: 'goal', to: 'problem', label: 'Evidence', arrow: true }],
      }),
    )
    await page
      .getByRole('button', { name: 'Native JSON goal map', exact: true })
      .waitFor({ timeout: 20000 })
    await page.getByRole('button', { name: 'Native JSON problem map', exact: true }).click()
    await page
      .locator('.research-problem-context')
      .getByText(problemTitle, { exact: true })
      .waitFor()
    mapFormats.push('map.json renders and selects its existing problem')
    await writeFile(
      mapMermaid,
      'flowchart LR\n  evidence[Native Mermaid evidence] --> conclusion[Native Mermaid conclusion]\n',
    )
    await page.locator('.research-mermaid-svg svg').waitFor({ timeout: 20000 })
    const evidenceNode = page.locator('.research-mermaid-svg g.node[id*="-flowchart-evidence-"]')
    const conclusionNode = page.locator(
      '.research-mermaid-svg g.node[id*="-flowchart-conclusion-"]',
    )
    await evidenceNode.waitFor()
    await conclusionNode.waitFor()
    assert.equal((await evidenceNode.textContent()).replace(/\s/g, ''), 'NativeMermaidevidence')
    assert.equal((await conclusionNode.textContent()).replace(/\s/g, ''), 'NativeMermaidconclusion')
    assert.equal(await page.locator('.research-mermaid-svg .edgePaths path').count(), 1)
    assert.equal(await page.locator('.renderer-recovery').count(), 0)
    mapFormats.push('map.mmd renders a real Mermaid SVG without a React crash')
    const parentCsp = await page
      .locator('meta[http-equiv="Content-Security-Policy"]')
      .getAttribute('content')
    await writeFile(
      mapHtml,
      `<h1>Native HTML research map</h1><button id="problem">Inspect research problem</button><button id="invalid">Select unknown problem</button><button id="overview">Select research overview</button><script>window.__inlineScriptExecuted=true;document.getElementById('problem').onclick=()=>parent.postMessage({type:'life-research-select',problemId:${JSON.stringify(problemThread.researchContext.problemId)}},'*');document.getElementById('invalid').onclick=()=>parent.postMessage({type:'life-research-select',problemId:'unknown-native-qa-problem'},'*');document.getElementById('overview').onclick=()=>parent.postMessage({type:'life-research-select',overview:true},'*')</script>`,
    )
    const frameLocator = page.frameLocator('iframe.research-html-map')
    await frameLocator
      .getByRole('heading', { name: 'Native HTML research map', exact: true })
      .waitFor({ timeout: 20000 })
    assert.equal(
      await page.locator('iframe.research-html-map').getAttribute('sandbox'),
      'allow-scripts',
    )
    if (
      process.env.LIFE_TEST_PHASE === 'features' &&
      process.env.LIFE_TEST_SKIP_HTML_ACTION === '1'
    ) {
      console.log(
        'Feature debug: HTML map action pending isolated protocol; excluded from this debug proof.',
      )
    } else {
      await page.evaluate(() => {
        window.__lifeMapMessages = []
        window.addEventListener('message', (event) => {
          if (event.data?.type === 'life-research-select')
            window.__lifeMapMessages.push({
              data: event.data,
              matchingFrame:
                event.source === document.querySelector('iframe.research-html-map')?.contentWindow,
            })
        })
      })
      const isolation = await frameLocator.locator('body').evaluate(() => {
        let parentRelayAccess = 'unexpected access'
        try {
          void parent.relay
        } catch (error) {
          parentRelayAccess = error.name
        }
        return {
          inlineScriptExecuted: window.__inlineScriptExecuted,
          relay: typeof window.relay,
          Life: typeof window.Life,
          require: typeof window.require,
          electron: typeof window.electron,
          parentRelayAccess,
        }
      })
      assert.deepEqual(isolation, {
        inlineScriptExecuted: true,
        relay: 'undefined',
        Life: 'undefined',
        require: 'undefined',
        electron: 'undefined',
        parentRelayAccess: 'SecurityError',
      })
      assert.match(
        await page.locator('iframe.research-html-map').getAttribute('src'),
        /^life-extension:\/\/research\//,
      )
      await page.getByRole('button', { name: 'Back to research overview', exact: true }).click()
      await page.locator('.research-problem-context').waitFor({ state: 'hidden' })
      await frameLocator
        .getByRole('heading', { name: 'Native HTML research map', exact: true })
        .waitFor()
      await frameLocator
        .getByRole('button', { name: 'Select unknown problem', exact: true })
        .click()
      await context.waitUntil(
        async () =>
          (await page.evaluate(() => window.__lifeMapMessages)).some(
            (message) =>
              message.matchingFrame && message.data.problemId === 'unknown-native-qa-problem',
          ),
        'sandbox map posts its unknown problem request',
      )
      await page.evaluate(
        () => new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve))),
      )
      assert.equal(
        await page.locator('.research-problem-context').count(),
        0,
        'Unknown HTML-map IDs cannot select or create conversations.',
      )
      await frameLocator
        .getByRole('button', { name: 'Inspect research problem', exact: true })
        .click()
      await context.waitUntil(async () => {
        const messages = await page.evaluate(() => window.__lifeMapMessages)
        await writeFile(
          join(context.artifacts, 'research-html-map-message-proof.json'),
          JSON.stringify(messages, null, 2),
        )
        return messages.some(
          (message) =>
            message.matchingFrame &&
            message.data.problemId === problemThread.researchContext.problemId,
        )
      }, 'sandbox map posts a valid existing problem to its parent frame')
      await page
        .locator('.research-problem-context')
        .getByText(problemTitle, { exact: true })
        .waitFor()
      assert.equal(
        await frameLocator.locator('body').evaluate(() => typeof window.relay),
        'undefined',
      )
      await frameLocator
        .getByRole('button', { name: 'Select research overview', exact: true })
        .click()
      await page.locator('.research-problem-context').waitFor({ state: 'hidden' })
      await page.evaluate(
        (problemId) => window.postMessage({ type: 'life-research-select', problemId }, '*'),
        problemThread.researchContext.problemId,
      )
      await page.evaluate(
        () => new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve))),
      )
      assert.equal(
        await page.locator('.research-problem-context').count(),
        0,
        'Only the linked opaque iframe can control Research selection.',
      )
      assert.equal(
        await page.locator('meta[http-equiv="Content-Security-Policy"]').getAttribute('content'),
        parentCsp,
      )
      assert.ok(
        !/script-src[^;]*'unsafe-inline'/.test(parentCsp),
        'Research HTML cannot weaken the host script policy.',
      )
      await writeFile(
        join(context.artifacts, 'research-html-map-isolation-proof.json'),
        JSON.stringify(
          {
            isolation,
            hostCspUnchanged: true,
            unknownProblemIgnored: true,
            forgedParentMessageIgnored: true,
          },
          null,
          2,
        ),
      )
      mapFormats.push('map.html remains sandboxed and selects only a linked research problem')
    }
  } finally {
    await Promise.all([mapJson, mapMermaid, mapHtml].map((path) => rm(path, { force: true })))
  }

  await page.getByRole('button', { name: 'Research filters and sorting', exact: true }).click()
  const filters = page.getByRole('dialog', { name: 'Research filters and sorting', exact: true })
  await filters.getByRole('combobox', { name: /^Agent/ }).selectOption('claude')
  await filters.getByRole('combobox', { name: /^Sort by/ }).selectOption('title')
  await filters.getByRole('button', { name: 'Done', exact: true }).click()
  await context.waitUntil(
    async () => (await page.locator('.research-problem-card').count()) === 1,
    'Research filters retain the selected provider problem',
  )
  await page.reload()
  await page.locator('.app-shell').waitFor()
  await research(context)
  await context.waitUntil(
    async () => (await page.locator('.research-problem-card').count()) === 1,
    'Research goals, linked conversations and filters survive renderer reload',
  )
  const savedFilters = await page.evaluate(() =>
    JSON.parse(localStorage.getItem('life.research.sidebar-filters.v1') || 'null'),
  )
  assert.equal(savedFilters.provider, 'claude')
  assert.equal(savedFilters.sort, 'title')
  await page.getByRole('button', { name: 'Research filters and sorting', exact: true }).click()
  await filters.getByRole('button', { name: 'Reset', exact: true }).click()
  await filters.getByRole('button', { name: 'Done', exact: true }).click()
  const persisted = await savedThreads(page)
  assert.equal(
    persisted.find((thread) => thread.id === goalThread.id)?.remoteId,
    goalThread.remoteId,
  )
  assert.equal(
    persisted.find((thread) => thread.id === problemThread.id)?.remoteId,
    problemThread.remoteId,
  )
  await context.workspace()
  await page.getByRole('complementary', { name: 'Projects and threads', exact: true }).waitFor()
  await context.waitUntil(
    async () =>
      (await page.locator('#life-sidebar .sidebar-project-thread-list .thread-row').count()) ===
      baselineAgentCount,
    'Research conversations do not add rows to the Agents project list',
  )
  const afterAgentGroups = await page
    .locator('#life-sidebar .sidebar-project-thread-group')
    .evaluateAll((groups) => groups.map((group) => group.getAttribute('aria-label')).sort())
  assert.deepEqual(
    afterAgentGroups,
    baselineAgentGroups,
    'Research does not appear as an Agents project.',
  )
  assert.deepEqual(
    (await savedThreads(page))
      .filter((thread) => !thread.purpose)
      .map((thread) => thread.id)
      .sort(),
    baselineOrdinaryIds,
  )
  assert.equal(
    (await page.evaluate(() => window.relay.connection.state())).workspace,
    connection.workspace,
  )
  await saveProof(context, 'desktop-research-isolation-proof.json', {
    ok: true,
    researchRoot,
    activeAgentsProject: connection.workspace,
    goalDirectory,
    goalThread: {
      id: goalThread.id,
      remoteId: goalThread.remoteId,
      purpose: goalThread.purpose,
      context: goalThread.researchContext,
    },
    problemThread: {
      id: problemThread.id,
      remoteId: problemThread.remoteId,
      purpose: problemThread.purpose,
      context: problemThread.researchContext,
    },
    literalPrompts: [...codex.prompts, ...claude.prompts],
    instructions,
    readme,
    persistedFilters: savedFilters,
    mapFormats,
    checks: [
      'Independent Research scope',
      'Machine-home research files',
      'Literal requests for both providers',
      'AGENTS.md instruction context',
      'Goal/problem conversation links',
      'Agents list isolation',
      'Filter and history persistence',
    ],
  })
  context.checks.push(
    'Research goal/problem conversations stay independent of Agents and persist under machine home/.life/research',
  )
}

async function openHistory(context) {
  const page = context.getPage()
  await page.getByRole('button', { name: 'Host chat history', exact: true }).click()
  const dialog = page.getByRole('dialog', { name: 'Host chat history', exact: true })
  await dialog.waitFor()
  return dialog
}

async function runHostHistoryChecks(context) {
  const page = context.getPage()
  await context.workspace()
  const root = context.fixture.root
  const claudeDirectory = join(root, '.claude', 'projects', '-life-native-workspace')
  const claudeRemoteId = 'native-claude-history-session'
  const codexRemoteId = 'native-codex-history-session'
  const stamp = new Date().toISOString()
  const claudeTitle = 'Native generated Claude history title'
  const codexTitle = 'Native generated Codex history title'
  const originalRequest = '  Original external conversation request.\nKeep every word.  '
  const originalAnswer =
    'External provider answer with **all details**.\n\n- Evidence one\n- Evidence two'
  await mkdir(claudeDirectory, { recursive: true })
  const claudeRecords = [
    { type: 'ai-title', aiTitle: claudeTitle, sessionId: claudeRemoteId },
    {
      type: 'user',
      uuid: 'native-user-1',
      cwd: context.fixture.workspace,
      timestamp: stamp,
      sessionId: claudeRemoteId,
      message: { role: 'user', content: originalRequest },
    },
    {
      type: 'assistant',
      uuid: 'native-assistant-1',
      cwd: context.fixture.workspace,
      timestamp: stamp,
      sessionId: claudeRemoteId,
      message: {
        role: 'assistant',
        model: 'claude-sonnet-4-6',
        content: [
          { type: 'thinking', thinking: 'Saved provider reasoning about the external evidence.' },
          { type: 'text', text: originalAnswer },
          {
            type: 'tool_use',
            id: 'native-tool-1',
            name: 'Read',
            input: { file_path: 'evidence.txt' },
          },
        ],
      },
    },
    {
      type: 'user',
      uuid: 'native-tool-output',
      cwd: context.fixture.workspace,
      timestamp: stamp,
      sessionId: claudeRemoteId,
      message: {
        role: 'user',
        content: [
          {
            type: 'tool_result',
            tool_use_id: 'native-tool-1',
            content: 'Full external tool output.\nNo summary was substituted.',
          },
        ],
      },
    },
  ]
  const claudePath = join(claudeDirectory, `${claudeRemoteId}.jsonl`)
  await writeFile(
    claudePath,
    claudeRecords.map((record) => JSON.stringify(record)).join('\n') + '\n',
  )
  const codexSession = {
    id: codexRemoteId,
    name: codexTitle,
    cwd: context.fixture.workspace,
    model: 'fixture-model',
    reasoningEffort: 'high',
    createdAt: Date.now() / 1000,
    updatedAt: Date.now() / 1000,
    source: 'cli',
  }
  const codexItems = [
    {
      turnId: 'external-native-turn',
      item: {
        type: 'userMessage',
        id: 'native-user-1',
        content: [{ type: 'text', text: originalRequest }],
      },
    },
    {
      turnId: 'external-native-turn',
      item: {
        type: 'reasoning',
        id: 'native-reasoning-1',
        summary: [
          { type: 'summary_text', text: 'Saved provider reasoning about the external evidence.' },
        ],
        content: [],
      },
    },
    {
      turnId: 'external-native-turn',
      item: { type: 'agentMessage', id: 'native-answer-1', text: originalAnswer },
    },
    {
      turnId: 'external-native-turn',
      item: {
        type: 'commandExecution',
        id: 'native-tool-1',
        command: 'cat evidence.txt',
        aggregatedOutput: 'Full external tool output.\nNo summary was substituted.',
        status: 'completed',
      },
    },
  ]
  const codexDirectory = join(root, '.codex')
  await mkdir(codexDirectory, { recursive: true })
  // The deterministic app-server reads this file; history remains provider-owned.
  const codexPath = join(codexDirectory, 'life-native-qa-history.json')
  await writeFile(
    codexPath,
    JSON.stringify({ sessions: [codexSession], items: { [codexRemoteId]: codexItems } }),
  )
  const providerFiles = new Map([
    [claudePath, await readFile(claudePath, 'utf8')],
    [codexPath, await readFile(codexPath, 'utf8')],
  ])
  const baseline = (await context.fixture.log()).length
  const imports = []
  for (const [provider, title, remoteId] of [
    ['codex', codexTitle, codexRemoteId],
    ['claude', claudeTitle, claudeRemoteId],
  ]) {
    const dialog = await openHistory(context)
    await dialog.getByRole('button', { name: 'Refresh host chat history', exact: true }).click()
    await dialog
      .locator('[aria-label="History provider"]')
      .getByRole('button', { name: provider === 'codex' ? 'Codex' : 'Claude Code', exact: true })
      .click()
    const session = dialog
      .locator('.host-history-session')
      .filter({ has: page.getByText(title, { exact: true }) })
    await session.waitFor()
    await session.click()
    await dialog.locator('.host-history-preview-header').getByText(title, { exact: true }).waitFor()
    const preview = dialog.locator('.host-history-messages')
    await preview
      .getByText('External provider answer with all details.', { exact: false })
      .waitFor()
    const hostPage = await page.evaluate(
      (id) => window.relay.hostHistory.read({ id }),
      `${provider}:${remoteId}`,
    )
    assert.equal(hostPage.session.title, title)
    assert.ok(
      hostPage.messages.some(
        (message) => message.role === 'user' && message.text === originalRequest,
      ),
    )
    assert.ok(
      hostPage.messages.some(
        (message) => message.role === 'assistant' && message.text === originalAnswer,
      ),
    )
    assert.ok(
      hostPage.messages.some(
        (message) =>
          message.kind === 'reasoning' && message.text.includes('Saved provider reasoning'),
      ),
    )
    assert.ok(
      hostPage.messages.some(
        (message) =>
          message.role === 'tool' && message.text.includes('No summary was substituted.'),
      ),
    )
    await dialog.getByRole('button', { name: 'Bring to Life', exact: true }).click()
    await dialog.waitFor({ state: 'hidden' })
    await context.waitUntil(
      async () =>
        (await savedThreads(page)).some(
          (thread) =>
            thread.provider === provider && thread.remoteId === remoteId && thread.title === title,
        ),
      `${provider} provider-owned history imports without changing its generated title`,
    )
    const imported = (await savedThreads(page)).find(
      (thread) => thread.provider === provider && thread.remoteId === remoteId,
    )
    assert.equal(imported.workspace, context.fixture.workspace)
    assert.ok(imported.importedHistory)
    assert.equal(
      imported.messages.find((message) => message.role === 'user')?.text,
      originalRequest,
    )
    imports.push({ provider, title, remoteId, threadId: imported.id, messages: imported.messages })
  }
  const readonlyEntries = (await context.fixture.log()).slice(baseline)
  assert.deepEqual(
    readonlyEntries.map(promptFrom).filter((prompt) => prompt !== undefined),
    [],
    'Browsing and importing native provider history must not start an inference turn.',
  )
  for (const [path, content] of providerFiles) assert.equal(await readFile(path, 'utf8'), content)

  const resumed = []
  for (const imported of imports) {
    await page
      .locator('#life-sidebar .thread-row')
      .filter({ has: page.getByText(imported.title, { exact: true }) })
      .click()
    const request = `  Continue the external ${imported.provider} conversation exactly here.\n  `
    const evidence = await sendAndSettle(context, request, imported.provider)
    const thread = (await savedThreads(page)).find(
      (candidate) => candidate.id === imported.threadId,
    )
    assert.equal(thread.remoteId, imported.remoteId)
    if (imported.provider === 'codex')
      assert.ok(
        evidence.entries.some(
          (entry) =>
            entry.message?.method === 'thread/resume' &&
            entry.message.params.threadId === imported.remoteId,
        ),
      )
    else
      assert.ok(
        evidence.entries.some((entry) =>
          entry.argv?.some(
            (arg, index, args) =>
              arg === `--resume=${imported.remoteId}` ||
              (arg === '--resume' && args[index + 1] === imported.remoteId),
          ),
        ),
      )
    resumed.push({ provider: imported.provider, remoteId: thread.remoteId, literalPrompt: request })
  }
  await saveProof(context, 'desktop-host-history-proof.json', {
    ok: true,
    imports,
    resumed,
    inferenceOnBrowseAndImport: 0,
    providerFilesUnchangedOnImport: true,
  })
  context.checks.push(
    'Codex and Claude host history preserve generated titles, full outputs and session IDs without inference until explicit continuation',
  )
}

async function runBuiltinChecks(context) {
  await context.workspace()
  let page = context.getPage()
  const original = await context.sourceCode()
  const extension = original.extensions.find(
    (item) => item.builtIn && item.id === 'builtin-source-e143e0e038ea',
  )
  assert.ok(extension, 'Release includes controllable original built-in surface extension.')
  assert.equal(extension.enabled, true)
  const initialThreads = await savedThreads(page)
  const initialSourceRevision = original.revision
  const initialSurfaces = await page.locator('.surface-tabs').count()
  const initialResizeHandles = await page.locator('.sidebar-resize-handle').count()
  assert.ok(initialResizeHandles > 0)
  const openManager = async () => {
    const customization = page.getByRole('dialog', { name: 'Customize Life', exact: true })
    if (!(await customization.isVisible()))
      await page.getByRole('button', { name: 'Customize', exact: true }).click()
    await customization.getByRole('button', { name: 'Details', exact: true }).click()
    await customization
      .getByRole('button', { name: 'Manage and share extensions', exact: true })
      .click()
    const dialog = page.getByRole('dialog', { name: 'Manage extensions', exact: true })
    await dialog.waitFor()
    return dialog
  }
  let manager = await openManager()
  let card = manager.locator(`.extension-card[data-extension-id="${extension.id}"]`)
  const disableToggle = card.getByRole('checkbox', {
    name: `Enable ${extension.name}`,
    exact: true,
  })
  assert.equal(await disableToggle.isChecked(), true)
  await disableToggle.click()
  await context.waitUntil(
    async () =>
      !(await context.sourceCode()).extensions.find((item) => item.id === extension.id).enabled,
    'A built-in feature disables without compiling source',
  )
  await context.waitUntil(
    async () => !(await disableToggle.isChecked()),
    'Built-in checkbox reflects disabled native state',
  )
  await page.keyboard.press('Escape')
  await context.waitUntil(
    async () =>
      (await page.locator('.surface-tabs').count()) === 0 &&
      (await page.locator('.sidebar-resize-handle').count()) === 0 &&
      (await page.locator('.thread-message-navigator').count()) === 0,
    'Disabled built-in components complete their React unmount',
  )
  assert.equal(await page.locator('.surface-tabs').count(), 0, 'Disabled surfaces unmount.')
  assert.equal(
    await page.locator('.sidebar-resize-handle').count(),
    0,
    'Disabled resize handlers unmount.',
  )
  assert.equal(
    await page.locator('.thread-message-navigator').count(),
    0,
    'Disabled message navigation unmounts.',
  )
  assert.equal((await context.sourceCode()).revision, initialSourceRevision)
  const choicesPath = join(original.path, 'built-in-extensions.json')
  const disabledChoices = JSON.parse(await readFile(choicesPath, 'utf8'))
  assert.deepEqual(disabledChoices.choices[extension.id], { enabled: false, deleted: false })
  await page.reload()
  await page.locator('.app-shell').waitFor()
  await context.workspace()
  await context.waitUntil(
    async () =>
      !(await context.sourceCode()).extensions.find((item) => item.id === extension.id).enabled,
    'Disabled built-in choice survives a renderer reload',
  )
  assert.equal(await page.locator('.surface-tabs').count(), 0)
  assert.equal(await page.locator('.sidebar-resize-handle').count(), 0)
  manager = await openManager()
  card = manager.locator(`.extension-card[data-extension-id="${extension.id}"]`)
  const enableToggle = card.getByRole('checkbox', { name: `Enable ${extension.name}`, exact: true })
  assert.equal(await enableToggle.isChecked(), false)
  await enableToggle.click()
  await context.waitUntil(
    async () =>
      (await context.sourceCode()).extensions.find((item) => item.id === extension.id).enabled,
    'Built-in surfaces re-enable live',
  )
  await context.waitUntil(
    async () => await enableToggle.isChecked(),
    'Built-in checkbox reflects enabled native state',
  )
  await page.keyboard.press('Escape')
  await context.waitUntil(
    async () => (await page.locator('.sidebar-resize-handle').count()) === initialResizeHandles,
    'Re-enabling remounts resize controls',
  )
  if (initialSurfaces) {
    await page.getByRole('complementary', { name: 'Workspace surfaces', exact: true }).waitFor()
    await context.surface('Files')
    await context.waitUntil(
      async () => (await page.locator('.surface-tabs').count()) === initialSurfaces,
      'Re-enabling remounts workspace surfaces',
    )
    await page.getByRole('button', { name: 'README.md', exact: true }).click()
    await page.locator('.file-preview').getByText('# Fixture workspace', { exact: true }).waitFor()
  }
  manager = await openManager()
  card = manager.locator(`.extension-card[data-extension-id="${extension.id}"]`)
  await card.getByRole('button', { name: `Delete ${extension.name}`, exact: true }).click()
  await card.getByRole('button', { name: 'Delete', exact: true }).click()
  await card.waitFor({ state: 'hidden' })
  const deleted = (await context.sourceCode()).extensions.find((item) => item.id === extension.id)
  assert.equal(deleted.deleted, true)
  assert.equal(deleted.enabled, false)
  assert.equal(deleted.originalId, extension.originalId)
  const recoveryPath = join(original.path, 'built-in-extension-recovery.json')
  const recovery = JSON.parse(await readFile(recoveryPath, 'utf8'))
  assert.equal(recovery.extensionId, extension.id)
  assert.equal(recovery.format, 1)
  assert.equal(recovery.choices.choices[extension.id].enabled, true)
  await page.keyboard.press('Escape')
  await page.reload()
  await page.locator('.app-shell').waitFor()
  await context.workspace()
  assert.equal(
    (await context.sourceCode()).extensions.find((item) => item.id === extension.id).deleted,
    true,
  )
  assert.equal(await page.locator('.sidebar-resize-handle').count(), 0)
  manager = await openManager()
  const deletedList = manager
    .locator('details.extension-card')
    .filter({ hasText: 'Deleted built-ins' })
  await deletedList.locator('summary').click()
  const deletedRow = deletedList
    .locator('.extension-card-actions')
    .filter({ has: page.getByText(extension.name, { exact: true }) })
  await deletedRow.getByRole('button', { name: 'Restore', exact: true }).click()
  await context.waitUntil(async () => {
    const state = (await context.sourceCode()).extensions.find((item) => item.id === extension.id)
    return state.enabled && !state.deleted
  }, 'Deleted built-in restores from its recovery entry')
  await page.keyboard.press('Escape')
  await context.waitUntil(
    async () => (await page.locator('.sidebar-resize-handle').count()) === initialResizeHandles,
    'Restored built-in remounts its controls',
  )
  const final = await context.sourceCode()
  assert.equal(
    final.revision,
    initialSourceRevision,
    'Feature choices do not invoke a compile or create source layers.',
  )
  assert.equal(
    final.builtInRevision,
    (original.builtInRevision || 0) + 4,
    'All four feature choices persist as native feature revisions.',
  )
  const finalThreads = await savedThreads(page)
  for (const thread of initialThreads) {
    const current = finalThreads.find((candidate) => candidate.id === thread.id)
    assert.ok(current)
    assert.equal(current.remoteId, thread.remoteId)
    assert.deepEqual(
      current.messages.map((message) => ({
        ...message,
        attachments: message.attachments || [],
        fileChanges: message.fileChanges || [],
      })),
      thread.messages.map((message) => ({
        ...message,
        attachments: message.attachments || [],
        fileChanges: message.fileChanges || [],
      })),
      'Built-in deletion preserves every conversation output.',
    )
  }
  await saveProof(context, 'desktop-builtin-extension-proof.json', {
    ok: true,
    id: extension.id,
    originalId: extension.originalId,
    installedBuiltins: original.extensions.filter((item) => item.builtIn && !item.deleted).length,
    disabledChoices,
    recovery,
    finalChoice: final.extensions.find((item) => item.id === extension.id),
    sourceRevisionUnchanged: initialSourceRevision === final.revision,
    preservedConversationIds: initialThreads.map((thread) => ({
      id: thread.id,
      remoteId: thread.remoteId,
    })),
    functionalUnmount: { surfaces: true, resizeHandles: true, messageNavigation: true },
  })
  context.checks.push(
    'Built-in extension disable, enable, delete and recovery restore persist without rebuilding or losing conversations',
  )
}

module.exports = { runResearchChecks, runHostHistoryChecks, runBuiltinChecks }
