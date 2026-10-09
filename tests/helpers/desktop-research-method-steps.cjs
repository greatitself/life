/* Real SSH coverage for Research records and operator instruction-file context. */
const assert = require('node:assert/strict')
const { readFile, readdir, writeFile } = require('node:fs/promises')
const { join, resolve } = require('node:path')

const threads = (page) =>
  page.evaluate(() => JSON.parse(localStorage.getItem('relay.threads.v1') || '[]'))

function promptFrom(entry) {
  if (entry.kind === 'title-metadata') return undefined
  if (entry.provider === 'codex' && entry.message?.method === 'turn/start')
    return entry.message.params.input
      .filter((part) => part.type === 'text')
      .map((part) => part.text)
      .join('')
  if (entry.provider === 'claude' && entry.message?.type === 'user') {
    const content = entry.message.message.content
    return typeof content === 'string'
      ? content
      : content
          .filter((part) => part.type === 'text')
          .map((part) => part.text)
          .join('')
  }
  return undefined
}

async function runResearchMethodChecks(context) {
  const page = context.getPage()
  const root = join(context.fixture.root, '.life', 'research')
  const title = 'Native method: explicit evidence and immutable operations'
  const problemTitle = 'Keep this operation attached to its selected problem'
  await page
    .getByRole('navigation', { name: 'Workspace views' })
    .getByRole('button', { name: 'Research', exact: true })
    .click()
  await page
    .getByRole('complementary', { name: 'Research goals and problems', exact: true })
    .waitFor()
  const expand = page.getByRole('button', { name: 'Expand research agent sidebar', exact: true })
  if (await expand.isVisible()) await expand.click()
  await page.getByRole('button', { name: 'New goal', exact: true }).click()
  let dialog = page.getByRole('dialog', { name: 'New goal', exact: true })
  await dialog.getByLabel('Title', { exact: true }).fill(title)
  await dialog
    .getByLabel('Goal', { exact: true })
    .fill(
      'Record explicit requirements, candidates, evidence and verification while keeping exact user input.',
    )
  await dialog.getByRole('button', { name: 'Create goal', exact: true }).click()
  await dialog.waitFor({ state: 'hidden' })
  let goalDirectory
  const findGoal = async () => {
    for (const entry of await readdir(root, { withFileTypes: true })) {
      if (!entry.isDirectory() || entry.name.startsWith('.')) continue
      try {
        const goal = JSON.parse(await readFile(join(root, entry.name, 'goal.json'), 'utf8'))
        if (goal.title === title) {
          goalDirectory = join(root, entry.name)
          return goal
        }
      } catch {}
    }
  }
  await context.waitUntil(
    async () => Boolean(await findGoal()),
    'New method research goal is saved through real SSH',
  )
  const readGoal = () => readFile(join(goalDirectory, 'goal.json'), 'utf8').then(JSON.parse)
  const waitMethod = async (predicate, description) =>
    context.waitUntil(async () => {
      try {
        return predicate((await readGoal()).method)
      } catch {
        return false
      }
    }, description)
  const tab = async (name) => {
    await page
      .getByRole('navigation', { name: 'Research tools', exact: true })
      .getByRole('button', { name: new RegExp(`^${name}`) })
      .click()
  }
  const add = async (singular) => {
    await page
      .getByRole('button', { name: `Add ${singular}`, exact: true })
      .first()
      .click()
    const editor = page.getByRole('dialog', { name: `Add ${singular}`, exact: true })
    await editor.waitFor()
    return editor
  }
  const save = async (editor, singular) => {
    await editor.getByRole('button', { name: `Save ${singular}`, exact: true }).click()
    await editor.waitFor({ state: 'hidden' })
  }
  const fields = async (editor, entries) => {
    for (const [label, value] of entries)
      await editor.getByRole('textbox', { name: new RegExp(`^${label}`) }).fill(value)
  }
  const link = async (editor, group, label) => {
    await editor
      .getByRole('group', { name: group, exact: true })
      .getByRole('checkbox', { name: label, exact: true })
      .check()
  }
  const visibleDetails = async (collection, id, values) => {
    const article = page.locator(`article[data-collection="${collection}"][data-record-id="${id}"]`)
    await article.waitFor()
    assert.equal(await article.isVisible(), true)
    const text = await article.textContent()
    for (const value of values)
      assert.ok(
        text.includes(value),
        `Visible ${collection} record includes the full detail: ${value}`,
      )
  }

  // Keep this helper focused on the native persistence boundary. Browser QA
  // exercises the wider graph, interference, and record-editor combinations.
  const requirement = {
    statement: 'Preserve each exact research request and its selected operation',
    acceptance:
      'The provider receives the literal request; native context retains the submitted operator.',
    rationale: 'An operation must not silently change while a request is already executing.',
  }
  await tab('Requirements')
  dialog = await add('requirement')
  await fields(dialog, [
    ['Statement', requirement.statement],
    ['Acceptance criterion', requirement.acceptance],
    ['Why this is necessary', requirement.rationale],
  ])
  await dialog.getByRole('checkbox', { name: /^Atomic requirement/ }).check()
  await save(dialog, 'requirement')
  await waitMethod(
    (method) => method?.requirements.some((row) => row.statement === requirement.statement),
    'Requirement persists atomically in goal.json',
  )
  let method = (await readGoal()).method
  const requirementId = method.requirements.find(
    (row) => row.statement === requirement.statement,
  ).id
  await visibleDetails('requirements', requirementId, Object.values(requirement))
  await page
    .getByRole('button', { name: `Edit requirement: ${requirement.statement}`, exact: true })
    .click()
  dialog = page.getByRole('dialog', { name: 'Edit requirement', exact: true })
  requirement.rationale +=
    ' The selection is metadata in instruction files, never extra prompt text.'
  await fields(dialog, [['Why this is necessary', requirement.rationale]])
  await save(dialog, 'requirement')
  await waitMethod(
    (value) =>
      value.requirements.find((row) => row.id === requirementId)?.rationale ===
      requirement.rationale,
    'Requirement update keeps its stable ID and full rationale',
  )

  const disposable = 'Disposable native research requirement'
  dialog = await add('requirement')
  await fields(dialog, [['Statement', disposable]])
  await save(dialog, 'requirement')
  await waitMethod(
    (value) => value.requirements.some((row) => row.statement === disposable),
    'Temporary requirement is recorded before deletion',
  )
  await page.getByRole('button', { name: `Delete requirement: ${disposable}`, exact: true }).click()
  dialog = page.getByRole('dialog', { name: 'Delete requirement?', exact: true })
  await dialog.getByRole('button', { name: 'Delete requirement', exact: true }).click()
  await dialog.waitFor({ state: 'hidden' })
  await waitMethod(
    (value) => !value.requirements.some((row) => row.statement === disposable),
    'Explicit deletion persists without removing the unrelated requirement',
  )
  await visibleDetails('requirements', requirementId, Object.values(requirement))

  const evidence = {
    content:
      'Native harness observation: user text and selected context round-trip without modification.',
    source:
      'Disposable loopback SSH fixture; provider JSONL transport and instruction-file assertions.',
  }
  await tab('Grounding')
  dialog = await add('evidence')
  await fields(dialog, [
    ['Evidence or observation', evidence.content],
    ['Source or provenance', evidence.source],
  ])
  await dialog.getByLabel(/^Evidence type/).selectOption('experiment')
  await dialog.getByLabel(/^Verification state/).selectOption('reproduced')
  await save(dialog, 'evidence')
  await waitMethod(
    (value) => value.evidence.some((row) => row.content === evidence.content),
    'Evidence and explicit provenance persist in goal.json',
  )
  method = (await readGoal()).method
  const evidenceId = method.evidence.find((row) => row.content === evidence.content).id
  await visibleDetails('evidence', evidenceId, Object.values(evidence))

  const candidate = {
    title: 'Immutable file context with literal provider input',
    mechanism:
      'Write the selected goal, problem, and operation to managed instruction files before submitting the unchanged user request.',
    risks: 'Queued requests must retain their own operation when the UI selection changes.',
  }
  await tab('Solutions')
  dialog = await add('candidate')
  await fields(dialog, [
    ['Candidate title', candidate.title],
    ['Mechanism', candidate.mechanism],
    ['Risks and trade-offs', candidate.risks],
  ])
  await link(dialog, 'Requirements covered', requirement.statement)
  await link(dialog, 'Evidence', evidence.content)
  await save(dialog, 'candidate')
  await waitMethod(
    (value) => value.candidates.some((row) => row.title === candidate.title),
    'Candidate mechanism and relationships persist in goal.json',
  )
  method = (await readGoal()).method
  const candidateId = method.candidates.find((row) => row.title === candidate.title).id
  assert.deepEqual(method.candidates.find((row) => row.id === candidateId).requirementIds, [
    requirementId,
  ])
  assert.deepEqual(method.candidates.find((row) => row.id === candidateId).evidenceIds, [
    evidenceId,
  ])
  await visibleDetails('candidates', candidateId, Object.values(candidate))

  const verification = {
    title: 'Literal request and operator snapshot verification',
    procedure:
      'Read the real provider transport log and both native invocation snapshots; compare exact text and IDs.',
    expected:
      'Only the user request is sent; current and queued operators retain their submitted identities.',
    actual: 'This disposable check remains pending until the native assertions complete.',
  }
  await tab('Verification')
  dialog = await add('verification')
  await fields(dialog, [
    ['Verification title', verification.title],
    ['Procedure', verification.procedure],
    ['Expected result', verification.expected],
    ['Actual result', verification.actual],
  ])
  await dialog.getByLabel(/^Outcome/).selectOption('pending')
  await link(dialog, 'Requirements checked', requirement.statement)
  await link(dialog, 'Candidates checked', candidate.title)
  await link(dialog, 'Results and evidence', evidence.content)
  await save(dialog, 'verification')
  await waitMethod(
    (value) => value.validations.some((row) => row.title === verification.title),
    'Verification procedure, expected and actual result persist without inventing a pass',
  )
  method = (await readGoal()).method
  const validationId = method.validations.find((row) => row.title === verification.title).id
  assert.equal(method.validations.find((row) => row.id === validationId).outcome, 'pending')
  await visibleDetails('validations', validationId, Object.values(verification))

  await page
    .locator('.research-sidebar .research-problem-list')
    .getByRole('button', { name: 'Add problem', exact: true })
    .click()
  dialog = page.getByRole('dialog', { name: 'New problem', exact: true })
  await dialog.getByLabel('Title', { exact: true }).fill(problemTitle)
  await dialog
    .getByLabel('Problem', { exact: true })
    .fill('Keep native invocation metadata stable during operation changes and queued follow-ups.')
  await dialog.getByRole('button', { name: 'Add problem', exact: true }).click()
  await dialog.waitFor({ state: 'hidden' })
  await context.waitUntil(
    async () => (await readGoal()).problems.some((row) => row.title === problemTitle),
    'Selected method problem is saved before its provider conversation starts',
  )
  let goal = await readGoal()
  const problemId = goal.problems.find((row) => row.title === problemTitle).id
  const conversationDirectory = join(goalDirectory, 'problems', problemId)
  await page
    .locator('[aria-label="Research provider"]')
    .getByRole('button', { name: 'Codex', exact: true })
    .click()
  const operation = page.getByRole('combobox', { name: 'Research operation', exact: true })
  const baseline = (await context.fixture.log()).length
  await operation.selectOption('anti-abstraction')
  await waitMethod(
    (value) => value.activeOperation === 'anti-abstraction',
    'Anti-abstraction is selected and persisted',
  )
  const firstRequest = 'native-research-operator-delay'
  await context.send(firstRequest)
  await context.waitUntil(
    async () =>
      (await context.fixture.log())
        .slice(baseline)
        .some((entry) => promptFrom(entry) === firstRequest),
    'The first operator request reaches the real provider channel',
  )
  await page.getByRole('button', { name: 'Steer current response', exact: true }).waitFor()
  const first = JSON.parse(
    await readFile(join(conversationDirectory, '.life-context.json'), 'utf8'),
  )
  assert.equal(first.goalId, goal.id)
  assert.equal(first.problemId, problemId)
  assert.equal(first.operation.id, 'anti-abstraction')
  assert.equal(first.executionId, first.invocationId)
  assert.match(first.executionId, /^[a-f0-9-]{36}$/)
  assert.equal(first.goalFile, '../../goal.json')
  const firstInvocationPath = resolve(conversationDirectory, first.invocationFile)
  assert.ok(firstInvocationPath.startsWith(conversationDirectory + '/.life-invocations/'))
  const firstImmutableBytes = await readFile(firstInvocationPath, 'utf8')
  const firstImmutable = JSON.parse(firstImmutableBytes)
  assert.equal(firstImmutable.executionId, first.executionId)
  assert.equal(firstImmutable.operation.id, 'anti-abstraction')
  assert.equal(firstImmutable.goalId, goal.id)
  assert.equal(firstImmutable.problemId, problemId)
  const agentInstructions = await readFile(join(conversationDirectory, 'AGENTS.md'), 'utf8')
  assert.equal(await readFile(join(conversationDirectory, 'CLAUDE.md'), 'utf8'), agentInstructions)
  assert.match(agentInstructions, /Read \.life-context\.json/)
  assert.match(agentInstructions, /methodGuideFile and methodSchemaFile/)
  const methodGuide = await readFile(resolve(conversationDirectory, first.methodGuideFile), 'utf8')
  const methodSchema = JSON.parse(
    await readFile(resolve(conversationDirectory, first.methodSchemaFile), 'utf8'),
  )
  assert.match(methodGuide, /anti-abstraction breaks a whole into basic constituents/)
  assert.match(methodGuide, /immutable operator selected for this submitted request/)
  assert.equal(methodSchema.title, 'Life research method')
  const availableOperations = await operation
    .locator('option')
    .evaluateAll((options) => options.map((option) => option.value))
  assert.deepEqual(
    availableOperations,
    methodSchema.properties.activeOperation.enum,
    'Every visible operation has a matching provider-neutral file schema.',
  )
  assert.equal(availableOperations.length, 12)

  await operation.selectOption('ground')
  const queuedRequest =
    '  Compare the recorded evidence exactly as stated.\nKeep this request unchanged.  '
  await context.composer().fill(queuedRequest)
  await context.composer().press('Tab')
  await context.waitUntil(
    async () =>
      (await threads(page)).some((thread) =>
        thread.queue?.some(
          (item) => item.text === queuedRequest && item.researchOperation === 'ground',
        ),
      ),
    'The queued request snapshots the Grounding operator at submission',
  )
  await operation.selectOption('abstraction')
  await waitMethod(
    (value) => value.activeOperation === 'abstraction',
    'Later UI operation changes persist independently of queued input',
  )
  const stillActive = JSON.parse(
    await readFile(join(conversationDirectory, '.life-context.json'), 'utf8'),
  )
  assert.equal(stillActive.executionId, first.executionId)
  assert.equal(
    stillActive.operation.id,
    'anti-abstraction',
    'UI changes never rewrite the running request context.',
  )
  assert.equal(await readFile(firstInvocationPath, 'utf8'), firstImmutableBytes)
  await context.waitUntil(
    async () =>
      (await context.fixture.log())
        .slice(baseline)
        .some((entry) => promptFrom(entry) === queuedRequest),
    'The queued literal request starts only after the current turn finishes',
    20000,
  )
  await context.waitUntil(
    async () =>
      (await threads(page)).some(
        (thread) =>
          !thread.busy &&
          thread.messages.some(
            (message) => message.role === 'user' && message.text === queuedRequest,
          ),
      ),
    'The queued Research request completes without interruption or replay',
  )
  const second = JSON.parse(
    await readFile(join(conversationDirectory, '.life-context.json'), 'utf8'),
  )
  assert.equal(second.goalId, first.goalId)
  assert.equal(second.problemId, first.problemId)
  assert.equal(
    second.operation.id,
    'ground',
    'Queued work uses its captured operation, not the current UI selection.',
  )
  assert.notEqual(second.executionId, first.executionId)
  assert.equal(second.executionId, second.invocationId)
  const secondInvocationPath = resolve(conversationDirectory, second.invocationFile)
  const secondImmutable = JSON.parse(await readFile(secondInvocationPath, 'utf8'))
  assert.equal(secondImmutable.operation.id, 'ground')
  assert.equal(
    await readFile(firstInvocationPath, 'utf8'),
    firstImmutableBytes,
    'The earlier invocation remains immutable after a later turn.',
  )
  const entries = (await context.fixture.log()).slice(baseline)
  assert.deepEqual(
    entries.map(promptFrom).filter((value) => value !== undefined),
    [firstRequest, queuedRequest],
    'Research operators and instruction metadata add no words to provider user input.',
  )
  const firstCompletion = entries.findIndex(
    (entry) => entry.kind === 'turn-completed' && entry.completionEvidence?.prompt === firstRequest,
  )
  const queuedStart = entries.findIndex((entry) => promptFrom(entry) === queuedRequest)
  assert.ok(
    firstCompletion >= 0 && queuedStart > firstCompletion,
    'The real provider completes the current output before receiving queued input.',
  )
  for (const entry of entries.filter(
    (item) =>
      item.provider === 'codex' &&
      item.message?.method === 'turn/start' &&
      item.kind !== 'title-metadata',
  )) {
    assert.equal(entry.message.params.cwd, conversationDirectory)
    assert.equal(entry.message.params.input.length, 1)
    assert.equal(entry.message.params.input[0].type, 'text')
  }
  const linked = (await threads(page)).find(
    (thread) =>
      thread.researchContext?.goalId === goal.id && thread.researchContext.problemId === problemId,
  )
  assert.ok(linked)
  assert.equal(linked.purpose, 'research')
  assert.equal(linked.workspace, conversationDirectory)
  goal = await readGoal()
  assert.equal(goal.method.activeOperation, 'abstraction')
  assert.equal(goal.problems.find((row) => row.id === problemId).threadId, linked.id)
  assert.ok(goal.method.requirements.some((row) => row.id === requirementId))
  assert.ok(goal.method.evidence.some((row) => row.id === evidenceId))
  assert.ok(goal.method.candidates.some((row) => row.id === candidateId))
  assert.ok(
    goal.method.validations.some((row) => row.id === validationId && row.outcome === 'pending'),
  )
  await writeFile(
    join(context.artifacts, 'desktop-research-method-proof.json'),
    JSON.stringify(
      {
        ok: true,
        goalId: goal.id,
        problemId,
        conversationDirectory,
        records: { requirementId, evidenceId, candidateId, validationId },
        goal,
        requests: [firstRequest, queuedRequest],
        currentUiOperation: goal.method.activeOperation,
        firstInvocation: firstImmutable,
        secondInvocation: secondImmutable,
        previousInvocationBytesPreserved: true,
        methodGuidePresent: true,
        methodSchemaPresent: true,
        availableOperations,
        checks: [
          'Real SSH record CRUD',
          'Full visible method details',
          'Provider input byte preservation',
          'Selected goal/problem instruction metadata',
          'Immutable execution identity',
          'Queue operator snapshots',
        ],
      },
      null,
      2,
    ),
  )
  context.checks.push(
    'Research method records and immutable operator contexts persist through real SSH; queued work preserves its selected operation and exact input',
  )
  if (context.screenshot) await context.screenshot('life-research.png')
  await context.workspace()
}

module.exports = { runResearchMethodChecks }
