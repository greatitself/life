#!/usr/bin/env node
// Run the shipped Research method UI and its actual file-sync hook in Chromium.
// Only the desktop transport is replaced; goal.json is saved by Life's real worker.
const assert = require('node:assert/strict')
const { execFile } = require('node:child_process')
const { createServer } = require('node:http')
const { mkdtemp, mkdir, readFile, writeFile, rm } = require('node:fs/promises')
const { join, resolve } = require('node:path')
const { tmpdir } = require('node:os')
const { promisify } = require('node:util')
const { build } = require('esbuild')
const { chromium } = require('playwright')

const execute = promisify(execFile)
const repository = resolve(__dirname, '..')

async function main() {
  const directory = await mkdtemp(join(tmpdir(), 'life-research-method-ui-'))
  const machineHome = join(directory, 'machine-home')
  const agentsWorkspace = join(machineHome, 'agents-project')
  const goalDirectory = join(machineHome, '.life/research/method-goal')
  const goalFile = join(goalDirectory, 'goal.json')
  const longGoalBrief =
    'Find a measured, low-cost way to make shared research work more reliable.\n' +
    Array.from({ length: 60 }, (_, index) => `Research premise ${index + 1}.`).join('\n')
  const artifacts = resolve(repository, 'output/playwright/research-method')
  const checks = []
  const errors = []
  const nativeCalls = []
  const themeBackgrounds = {}
  let browser
  let server
  let page
  try {
    await Promise.all([
      mkdir(agentsWorkspace, { recursive: true }),
      mkdir(goalDirectory, { recursive: true }),
      mkdir(artifacts, { recursive: true }),
    ])
    await writeFile(
      goalFile,
      JSON.stringify(
        {
          id: 'method-goal',
          title: 'A quieter research workspace',
          goal: longGoalBrief,
          problems: [
            {
              id: 'problem-one',
              title: 'Interrupted experiments',
              description: 'Experiments are interrupted before repeatable evidence is collected.',
              notes: '',
              status: 'open',
              updatedAt: 1,
            },
          ],
          createdAt: 1,
          updatedAt: 1,
          nativeMetadata: { retained: 'External research artifact metadata is preserved.' },
        },
        null,
        2,
      ) + '\n',
    )
    const connection = {
      status: 'connected',
      profile: {
        id: 'method-machine',
        name: 'Research test machine',
        host: 'research.test',
        port: 22,
        username: 'researcher',
        auth: 'agent',
        privateKeyPath: '',
        workspace: agentsWorkspace,
      },
      home: machineHome,
      workspace: agentsWorkspace,
      codex: '0.162.0',
      claude: '2.1.0',
    }
    await build({
      stdin: {
        resolveDir: repository,
        sourcefile: 'research-method-ui-fixture.tsx',
        loader: 'tsx',
        contents: `
          import React, { useEffect, useState } from 'react'
          import { createRoot } from 'react-dom/client'
          import { useResearchWorkbench, researchPrompt } from './src/renderer/workbench'
          import { ResearchMethodWorkbench } from './src/renderer/components/ResearchMethodWorkbench'
          import './src/renderer/styles.css'
          import './src/renderer/components/research.css'
          const connection = ${JSON.stringify(connection)}
          function Fixture() {
            const [theme, setTheme] = useState(localStorage.getItem('research-method-theme') || 'dark')
            useEffect(() => { document.documentElement.dataset.theme = theme }, [theme])
            const workbench = useResearchWorkbench(message => window.methodErrors.push(message), connection, true, true)
            window.methodWorkbench = workbench
            window.methodExactPrompt = request => researchPrompt(workbench.selection(), request)
            return <div className="app-shell life-refined-layout" data-theme={theme}>
              <main className="research-method-fixture">
                <header className="research-method-fixture-header">
                  <span>Life · Research</span>
                  <button type="button" className="button secondary" onClick={() => {
                    const next = theme === 'dark' ? 'light' : 'dark'
                    localStorage.setItem('research-method-theme', next)
                    setTheme(next)
                  }}>Switch theme</button>
                </header>
                <ResearchMethodWorkbench workbench={workbench} map={<section aria-label="Research map fixture"><h2>Research goal map</h2><p>Existing map content remains available alongside the method workbench.</p></section>} />
              </main>
            </div>
          }
          createRoot(document.getElementById('root')).render(<React.StrictMode><Fixture /></React.StrictMode>)
        `,
      },
      bundle: true,
      jsx: 'automatic',
      outfile: join(directory, 'fixture.js'),
      loader: { '.woff2': 'dataurl', '.woff': 'dataurl' },
      define: {
        'process.env.NODE_ENV': '"development"',
      },
      logLevel: 'silent',
    })
    server = createServer(async (request, response) => {
      try {
        const url = new URL(request.url, 'http://localhost')
        if (url.pathname === '/native-execute' && request.method === 'POST') {
          const chunks = []
          let length = 0
          for await (const chunk of request) {
            length += chunk.length
            if (length > 32_000_000) throw new Error('Fixture request exceeds 32 MB.')
            chunks.push(chunk)
          }
          const input = JSON.parse(Buffer.concat(chunks).toString('utf8'))
          assert.equal(input.scope, 'machine')
          assert.equal(input.workspace, machineHome)
          assert(
            input.command.startsWith('if command -v node') &&
              (input.command.includes('LIFE_RESEARCH_RESULT=') ||
                input.command.includes('const lifeResearchPayload=')),
            'Only Life Research file-worker commands are accepted by this fixture.',
          )
          nativeCalls.push(structuredClone(input))
          const result = await execute('bash', ['-c', input.command], {
            cwd: machineHome,
            maxBuffer: 8_000_000,
            timeout: 30_000,
          })
          response.setHeader('Content-Type', 'application/json')
          response.end(JSON.stringify({ output: result.stdout }))
          return
        }
        const file = ['fixture.js', 'fixture.css'].find((name) => url.pathname === '/' + name)
        response.setHeader(
          'Content-Type',
          file?.endsWith('.js') ? 'text/javascript' : file ? 'text/css' : 'text/html',
        )
        response.end(
          file
            ? await readFile(join(directory, file))
            : '<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Life Research method checks</title><link rel="stylesheet" href="/fixture.css"><style>html,body,#root{height:auto;min-height:100%;overflow:visible}body{background:var(--bg);color:var(--text)}.app-shell{display:block;height:auto;min-height:100vh;overflow:visible}.research-method-fixture{width:100%;min-width:0;min-height:100vh;padding:18px;box-sizing:border-box}.research-method-fixture-header{display:flex;align-items:center;justify-content:space-between;gap:12px;margin-bottom:18px}</style></head><body><div id="root"></div><script src="/fixture.js"></script></body></html>',
        )
      } catch (error) {
        response.statusCode = 500
        response.setHeader('Content-Type', 'application/json')
        response.end(JSON.stringify({ error: String(error) }))
      }
    })
    await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
    browser = await chromium.launch({ headless: true })
    page = await browser.newPage({ viewport: { width: 1440, height: 1080 } })
    page.on('pageerror', (error) => errors.push(error.message))
    page.on('console', (event) => {
      if (event.type() === 'error') errors.push(event.text())
    })
    await page.addInitScript((connection) => {
      window.methodErrors = []
      window.methodAgentStarts = []
      window.relay = {
        onAgent: () => () => {},
        connection: {
          state: async () => structuredClone(connection),
          execute: async (input) => {
            const response = await fetch('/native-execute', {
              method: 'POST',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify(input),
            })
            const result = await response.json()
            if (!response.ok) throw new Error(result.error)
            return result.output
          },
        },
        agent: {
          start: async (input) => window.methodAgentStarts.push(structuredClone(input)),
        },
      }
    }, connection)
    await page.goto('http://127.0.0.1:' + server.address().port)
    await page.waitForFunction(
      () =>
        window.methodWorkbench?.goal?.id === 'method-goal' &&
        window.methodWorkbench.storageStatus === 'saved',
    )

    const savedGoal = async () => {
      await page.evaluate(() => window.methodWorkbench.flush())
      return JSON.parse(await readFile(goalFile, 'utf8'))
    }
    const selectTab = async (name) => {
      const tab = page.getByRole('tab', { name, exact: true })
      if (await tab.count()) await tab.click()
      else
        await page
          .getByRole('navigation', { name: 'Research tools', exact: true })
          .getByRole('button', { name: new RegExp('^' + name + '(?:\\s+\\d+)?$') })
          .click()
    }
    const dialog = () => page.getByRole('dialog')
    const openForm = async (name) => {
      await page.getByRole('button', { name, exact: true }).first().click()
      await dialog().waitFor()
    }
    const submitForm = async () => {
      await dialog()
        .getByRole('button', { name: /^Save(?: |$)/ })
        .click()
      await dialog().waitFor({ state: 'hidden' })
      return savedGoal()
    }
    const chooseOption = async (label, value) => {
      const control = dialog().getByLabel(label, { exact: false })
      const tagName = await control.evaluate((element) => element.tagName)
      if (tagName === 'SELECT') await control.selectOption(value)
      else {
        await control.click()
        await page.getByRole('option', { name: value, exact: true }).click()
      }
    }
    const field = (label) => dialog().getByLabel(new RegExp('^' + label + '(?: \\*)?'))
    const link = (group, name) =>
      dialog()
        .getByRole('group', { name: group, exact: true })
        .getByRole('checkbox', { name, exact: true })
    const record = (name) =>
      page.locator('article.research-method-record').filter({
        has: page
          .locator('h3')
          .filter({ hasText: new RegExp('^' + name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '$') }),
      })
    const assertNoOverflow = async (width) => {
      await page.setViewportSize({ width, height: 1080 })
      const dimensions = await page.evaluate(() => ({
        client: document.documentElement.clientWidth,
        scroll: document.documentElement.scrollWidth,
        body: document.body.scrollWidth,
      }))
      assert(dimensions.scroll <= dimensions.client + 1, JSON.stringify(dimensions))
      assert(dimensions.body <= dimensions.client + 1, JSON.stringify(dimensions))
    }

    assert.equal(await page.locator('.research-method-goal').count(), 0)
    assert.equal(await page.getByLabel('Research operation', { exact: true }).count(), 0)
    assert.equal((await savedGoal()).goal, longGoalBrief)
    checks.push(
      'The file-backed goal keeps its complete brief without duplicate banners or an approach selector',
    )

    const parentStatement = 'Reduce interrupted research experiments'
    const leafStatement = 'Count interruptions in a repeatable one-week experiment'
    const leafAcceptance = 'At least 20 sessions are recorded with identical interruption criteria.'
    await selectTab('Requirements')
    await openForm('Add requirement')
    await field('Statement').fill(parentStatement)
    await field('Acceptance criterion').fill(
      'At least 85% of research sessions reach their planned stopping point.',
    )
    await field('Why this is necessary').fill(
      'Repeatable results require experiments to run to completion.',
    )
    let persisted = await submitForm()
    const parentId = persisted.method.requirements.find(
      (row) => row.statement === parentStatement,
    ).id
    assert.equal(persisted.method.requirements.length, 1)
    assert.equal(persisted.method.requirements[0].atomic, false)
    checks.push('A broad requirement is saved with its observable acceptance and rationale')

    await page
      .getByRole('button', { name: 'Decompose requirement: ' + parentStatement, exact: true })
      .click()
    await dialog().waitFor()
    assert.equal(
      await dialog().getByLabel('Parent requirement', { exact: false }).inputValue(),
      parentId,
    )
    await field('Statement').fill(leafStatement)
    await field('Acceptance criterion').fill(leafAcceptance)
    await field('Why this is necessary').fill(
      'One event count is a basic measurement at the chosen granularity.',
    )
    await dialog()
      .getByRole('checkbox', { name: /Atomic requirement/ })
      .check()
    persisted = await submitForm()
    const leafId = persisted.method.requirements.find((row) => row.statement === leafStatement).id
    assert.equal(persisted.method.requirements.length, 2)
    assert.equal(persisted.method.requirements.find((row) => row.id === leafId).parentId, parentId)
    assert.equal(persisted.method.requirements.find((row) => row.id === leafId).atomic, true)
    assert.match(
      await record(leafStatement).textContent(),
      /Part of: Reduce interrupted research experiments/,
    )
    checks.push(
      'Anti-abstraction creates a linked basic constituent while retaining the broad requirement',
    )

    await page
      .getByRole('button', { name: 'Edit requirement: ' + leafStatement, exact: true })
      .click()
    await dialog().waitFor()
    await field('Acceptance criterion').fill(
      leafAcceptance + ' Missing observations are explicitly marked.',
    )
    persisted = await submitForm()
    assert.equal(
      persisted.method.requirements.find((row) => row.id === leafId).acceptance,
      leafAcceptance + ' Missing observations are explicitly marked.',
    )
    assert.equal(persisted.method.requirements.find((row) => row.id === leafId).parentId, parentId)
    checks.push('Editing an existing constituent preserves its stable ID and decomposition link')

    await page
      .getByRole('button', { name: 'Edit requirement: ' + leafStatement, exact: true })
      .click()
    await dialog().waitFor()
    await chooseOption('Parent requirement', '')
    persisted = await submitForm()
    assert.equal(persisted.method.requirements.find((row) => row.id === leafId).parentId, undefined)
    await page
      .getByRole('button', { name: 'Edit requirement: ' + leafStatement, exact: true })
      .click()
    await dialog().waitFor()
    await chooseOption('Parent requirement', parentId)
    persisted = await submitForm()
    assert.equal(persisted.method.requirements.find((row) => row.id === leafId).parentId, parentId)
    checks.push(
      'Moving a constituent to the goal clears its parent; reattaching it saves the original parent without changing its ID',
    )

    const blocker = record('Interrupted experiments')
    await blocker.getByRole('checkbox', { name: leafStatement, exact: true }).check()
    persisted = await savedGoal()
    assert.deepEqual(persisted.problems[0].requirementIds, [leafId])
    await blocker.getByRole('button', { name: /^Investigate/ }).click()
    await page.waitForFunction(() => window.methodWorkbench.problem?.id === 'problem-one')
    assert.equal(await page.evaluate(() => window.methodWorkbench.problem.id), 'problem-one')
    checks.push(
      'A research blocker links to affected constituents and selects its own conversation context',
    )

    await selectTab('Grounding')
    const observation = 'In a controlled pilot, 17 of 20 sessions completed without interruption.'
    await openForm('Add evidence')
    await field('Evidence or observation').fill(observation)
    await field('Source or provenance').fill(
      'experiments/pilot-01.json · 20 observations · identical conditions',
    )
    await chooseOption('Evidence type', 'experiment')
    await chooseOption('Verification state', 'unverified')
    persisted = await submitForm()
    const evidenceId = persisted.method.evidence.find((row) => row.content === observation).id
    assert.equal(persisted.method.evidence[0].reliability, 'unverified')
    checks.push(
      'Evidence records retain provenance and distinguish unverified reports from reproduced observations',
    )

    const assumptionClaim =
      'A protected focus block decreases interruptions without reducing necessary collaboration.'
    await openForm('Add assumption')
    await field('Claim').fill(assumptionClaim)
    await field('Challenge or counterexample').fill(
      'Urgent coordination might fail during the focus block.',
    )
    await field('Consequence if false').fill(
      'The combined design would hide interruptions rather than resolve them.',
    )
    await chooseOption('Status', 'supported')
    await link('Affected requirements', leafStatement).check()
    await link('Supporting or challenging evidence', observation).check()
    persisted = await submitForm()
    const assumptionId = persisted.method.assumptions.find(
      (row) => row.claim === assumptionClaim,
    ).id
    assert.deepEqual(persisted.method.assumptions[0].requirementIds, [leafId])
    assert.deepEqual(persisted.method.assumptions[0].evidenceIds, [evidenceId])
    assert.match(await record(assumptionClaim).textContent(), /Urgent coordination might fail/)
    assert.match(
      await record(assumptionClaim).textContent(),
      /would hide interruptions rather than resolve them/,
    )
    assert(
      (
        await page.evaluate(() => window.methodWorkbench.methodAnalysis)
      ).unsupportedAssumptionIds.includes(assumptionId),
    )
    checks.push(
      'Linked assumptions show their challenge and consequence; an unverified source cannot ground a claimed supported assumption',
    )

    await page.getByRole('button', { name: 'Edit evidence: ' + observation, exact: true }).click()
    await dialog().waitFor()
    await chooseOption('Verification state', 'reproduced')
    persisted = await submitForm()
    assert.equal(persisted.method.evidence[0].reliability, 'reproduced')
    assert(
      !(
        await page.evaluate(() => window.methodWorkbench.methodAnalysis)
      ).unsupportedAssumptionIds.includes(assumptionId),
    )
    checks.push(
      'Recording reproduced evidence resolves the grounded-assumption gap through the real method analysis',
    )

    await selectTab('Requirements')
    await page
      .getByRole('button', { name: 'Edit requirement: ' + leafStatement, exact: true })
      .click()
    await dialog().waitFor()
    await link('Depends on assumptions', assumptionClaim).check()
    await link('Grounding evidence', observation).check()
    persisted = await submitForm()
    assert.deepEqual(persisted.method.requirements.find((row) => row.id === leafId).assumptionIds, [
      assumptionId,
    ])
    assert.deepEqual(persisted.method.requirements.find((row) => row.id === leafId).evidenceIds, [
      evidenceId,
    ])
    checks.push(
      'Constituent records retain explicit assumptions and grounding evidence instead of concealing dependencies',
    )

    await selectTab('Solutions')
    const candidateA = 'Protected focus blocks'
    const candidateB = 'Urgency-aware handoff queue'
    for (const [title, mechanism] of [
      [candidateA, 'Reserve a bounded uninterrupted period while collecting event timestamps.'],
      [
        candidateB,
        'Route urgent coordination to an acknowledged handoff rather than repeatedly interrupting researchers.',
      ],
    ]) {
      await openForm('Add candidate')
      await field('Candidate title').fill(title)
      await field('Mechanism').fill(mechanism)
      await field('Risks and trade-offs').fill('Coordination latency must remain measurable.')
      await link('Requirements covered', leafStatement).check()
      await link('Assumptions relied on', assumptionClaim).check()
      await link('Evidence', observation).check()
      persisted = await submitForm()
    }
    const candidateAId = persisted.method.candidates.find((row) => row.title === candidateA).id
    const candidateBId = persisted.method.candidates.find((row) => row.title === candidateB).id
    assert.deepEqual(
      persisted.method.candidates.map((row) => row.requirementIds),
      [[leafId], [leafId]],
    )
    assert(
      (
        await page.evaluate(() => window.methodWorkbench.methodAnalysis)
      ).coveredRequirementIds.includes(leafId),
    )
    assert(
      !(
        await page.evaluate(() => window.methodWorkbench.methodAnalysis)
      ).verifiedRequirementIds.includes(leafId),
    )
    assert.equal(
      await page
        .getByRole('table', { name: 'Constructive interference matrix', exact: true })
        .isVisible(),
      true,
    )
    checks.push(
      'Candidate mechanisms cover linked requirements; coverage remains distinct from verified success',
    )

    await page
      .getByRole('button', {
        name: 'Interaction: ' + candidateA + ' and ' + candidateB,
        exact: true,
      })
      .click()
    await dialog().waitFor()
    assert.equal(await link('Candidates in this interaction', candidateA).isChecked(), true)
    assert.equal(await link('Candidates in this interaction', candidateB).isChecked(), true)
    await chooseOption('Relationship', 'constructive')
    const interactionMechanism =
      'Protected focus reduces routine disruption while the handoff queue preserves urgent collaboration.'
    await field('Interaction mechanism').fill(interactionMechanism)
    await link('Evidence for this relationship', observation).check()
    persisted = await submitForm()
    assert.deepEqual(
      new Set(persisted.method.interactions[0].candidateIds),
      new Set([candidateAId, candidateBId]),
    )
    assert.equal(persisted.method.interactions[0].kind, 'constructive')
    assert.equal(
      await page
        .getByRole('button', {
          name: 'Interaction: ' + candidateA + ' and ' + candidateB,
          exact: true,
        })
        .textContent(),
      'constructive',
    )
    checks.push(
      'The interaction matrix records an explicit grounded constructive mechanism between independently tracked candidates',
    )

    await page.getByRole('button', { name: 'Combine solutions', exact: true }).first().click()
    await dialog().waitFor()
    assert.equal(await link('Component candidates', candidateA).isChecked(), true)
    assert.equal(await link('Component candidates', candidateB).isChecked(), true)
    const compositeTitle = 'Protected focus with acknowledged urgent handoffs'
    await field('Candidate title').fill(compositeTitle)
    await field('Mechanism').fill(
      'Assemble both mechanisms so protection and urgent coordination operate together.',
    )
    await field('Proposed emergent behavior').fill(
      'The assembled whole may maintain focus and timely coordination simultaneously; this remains a hypothesis.',
    )
    await link('Basic constituents', leafStatement).check()
    persisted = await submitForm()
    const compositeId = persisted.method.candidates.find((row) => row.title === compositeTitle).id
    const composite = persisted.method.candidates.find((row) => row.id === compositeId)
    assert.deepEqual(
      new Set(composite.componentCandidateIds),
      new Set([candidateAId, candidateBId]),
    )
    assert.deepEqual(composite.constituentIds, [leafId])
    assert.deepEqual(composite.requirementIds, [leafId])
    assert.match(composite.emergence, /remains a hypothesis/)
    assert(
      !(
        await page.evaluate(() => window.methodWorkbench.methodAnalysis)
      ).verifiedRequirementIds.includes(leafId),
    )
    checks.push(
      'Abstraction composes component candidates and basic constituents into a named whole, preserving emergent behavior as a hypothesis',
    )

    await selectTab('Approaches')
    assert.equal(await page.locator('.research-method-operator-catalog > article').count(), 12)
    const inquiryQuestion = 'What changes if urgent collaboration has no handoff queue?'
    await openForm('Create Counterfactual inquiry')
    assert.equal(
      await dialog().getByLabel('Research approach', { exact: false }).inputValue(),
      'counterfactual',
    )
    await field('Research question').fill(inquiryQuestion)
    await field('Premise').fill(
      'The baseline permits urgent coordination but frequently interrupts ongoing experiments.',
    )
    await field('Intervention or transformation').fill(
      'Keep protected focus blocks and remove the handoff queue in a matched trial.',
    )
    await field('Predicted result').fill(
      'Unacknowledged urgent handoffs will increase while focus remains protected.',
    )
    await link('Related requirements', leafStatement).check()
    await link('Related candidates', compositeTitle).check()
    await link('Supporting or refuting evidence', observation).check()
    persisted = await submitForm()
    const inquiryId = persisted.method.inquiries.find((row) => row.question === inquiryQuestion).id
    assert.equal(persisted.method.inquiries[0].operation, 'counterfactual')
    assert.equal(persisted.method.inquiries[0].result, '')
    assert.equal(persisted.method.inquiries[0].status, 'proposed')
    assert.match(await record(inquiryQuestion).textContent(), /Not tested yet/)
    checks.push(
      'All twelve research approaches have inspectable guidance; a counterfactual inquiry keeps prediction distinct from an unobserved result',
    )

    await page
      .getByRole('button', { name: 'Edit inquiry: ' + inquiryQuestion, exact: true })
      .click()
    await dialog().waitFor()
    await field('Observed result').fill(
      'Removing the queue delayed 2 of 6 urgent handoffs in the matched trial.',
    )
    await chooseOption('Status', 'tested')
    persisted = await submitForm()
    assert.equal(persisted.method.inquiries.find((row) => row.id === inquiryId).status, 'tested')
    assert.match(
      persisted.method.inquiries.find((row) => row.id === inquiryId).prediction,
      /will increase/,
    )
    assert.match(
      persisted.method.inquiries.find((row) => row.id === inquiryId).result,
      /delayed 2 of 6/,
    )
    checks.push(
      'Inquiry updates preserve the original prediction alongside the complete observed result',
    )

    await selectTab('Verification')
    const validationTitle = 'Repeat the combined focus and handoff pilot'
    await openForm('Add verification')
    await field('Verification title').fill(validationTitle)
    await field('Procedure').fill(
      'Repeat 20 sessions using the same interruption definition and record urgent handoff completion.',
    )
    await field('Expected result').fill(
      'At least 17 sessions complete and every urgent handoff is acknowledged.',
    )
    await field('Actual result').fill(
      '17 of 20 sessions completed and all 6 urgent handoffs were acknowledged.',
    )
    await chooseOption('Outcome', 'pass')
    await link('Requirements checked', leafStatement).check()
    await link('Candidates checked', candidateA).check()
    await link('Candidates checked', candidateB).check()
    await link('Results and evidence', observation).check()
    persisted = await submitForm()
    assert.equal(persisted.method.validations[0].outcome, 'pass')
    assert.deepEqual(persisted.method.validations[0].requirementIds, [leafId])
    assert(
      (
        await page.evaluate(() => window.methodWorkbench.methodAnalysis)
      ).verifiedRequirementIds.includes(leafId),
    )
    const validation = record(validationTitle)
    for (const expected of [
      'Repeat 20 sessions',
      'At least 17 sessions',
      '17 of 20 sessions',
      observation,
    ])
      assert((await validation.textContent()).includes(expected))
    checks.push(
      'Verification exposes the complete procedure, expected result, actual result and linked evidence before counting a leaf as verified',
    )

    await selectTab('Requirements')
    await page.setViewportSize({ width: 390, height: 1080 })
    await page
      .getByRole('button', { name: 'Inspect requirement: ' + leafStatement, exact: true })
      .click()
    await dialog().waitFor()
    const trace = dialog().locator('.research-method-inspector-trace')
    for (const expected of [
      candidateA,
      candidateB,
      compositeTitle,
      inquiryQuestion,
      'Interrupted experiments',
      validationTitle,
      '17 of 20 sessions',
    ])
      assert((await trace.textContent()).includes(expected))
    await assertNoOverflow(390)
    await dialog().getByRole('button', { name: 'Cancel', exact: true }).click()
    await dialog().waitFor({ state: 'hidden' })
    await page.setViewportSize({ width: 1440, height: 1080 })
    checks.push(
      'The requirement inspector traces assemblies, inquiries, blockers and complete verification results in a usable narrow-screen dialog',
    )

    const expectedOperations = [
      'explore',
      'anti-abstraction',
      'abstraction',
      'ground',
      'constructive-interference',
      'counterfactual',
      'analogy',
      'constraint-inversion',
      'reverse-design',
      'morphological-search',
      'causal-intervention',
      'verify',
    ]
    for (const operation of ['anti-abstraction', 'abstraction', 'counterfactual']) {
      await page.evaluate(
        (operation) => window.methodWorkbench.methodAction({ type: 'operation', operation }),
        operation,
      )
      persisted = await savedGoal()
      assert.equal(persisted.method.activeOperation, operation)
    }
    const conversationDirectory = await page.evaluate(() =>
      window.methodWorkbench.prepareConversation(window.methodWorkbench.selection()),
    )
    assert(conversationDirectory.startsWith(goalDirectory + '/problems/problem-one'))
    const context = JSON.parse(
      await readFile(join(conversationDirectory, '.life-context.json'), 'utf8'),
    )
    assert.equal(context.goalId, 'method-goal')
    assert.equal(context.problemId, 'problem-one')
    assert.equal(context.operation, undefined)
    assert.equal(typeof context.methodGuideFile, 'string')
    assert.equal(typeof context.methodSchemaFile, 'string')
    const guide = await readFile(resolve(conversationDirectory, context.methodGuideFile), 'utf8')
    const schema = JSON.parse(
      await readFile(resolve(conversationDirectory, context.methodSchemaFile), 'utf8'),
    )
    assert.match(guide, /anti-abstraction/i)
    assert.match(guide, /abstraction/i)
    assert.deepEqual(schema.properties.activeOperation.enum, expectedOperations)
    assert.match(guide, /The user's message determines the research approach/)
    assert.equal(context.executionId, context.invocationId)
    const immutableFile = resolve(conversationDirectory, context.invocationFile)
    const immutableBefore = await readFile(immutableFile, 'utf8')
    await page.evaluate(
      (operation) => window.methodWorkbench.methodAction({ type: 'operation', operation }),
      'abstraction',
    )
    await savedGoal()
    assert.equal(await readFile(immutableFile, 'utf8'), immutableBefore)
    assert.equal(
      JSON.parse(await readFile(join(conversationDirectory, '.life-context.json'), 'utf8'))
        .invocationId,
      context.invocationId,
    )
    await page.evaluate(() =>
      window.methodWorkbench.prepareConversation(window.methodWorkbench.selection()),
    )
    const nextContext = JSON.parse(
      await readFile(join(conversationDirectory, '.life-context.json'), 'utf8'),
    )
    assert.equal(nextContext.operation, undefined)
    assert.notEqual(nextContext.invocationId, context.invocationId)
    assert.equal(await readFile(immutableFile, 'utf8'), immutableBefore)
    await page.evaluate(
      (operation) => window.methodWorkbench.methodAction({ type: 'operation', operation }),
      'counterfactual',
    )
    persisted = await savedGoal()
    checks.push(
      'Historical operation changes preserve immutable context and do not select an approach for new messages',
    )
    const exactRequest =
      '  Inspect the same experiment.\n\n/life is literal text in this research message.\n  '
    assert.equal(
      await page.evaluate((request) => window.methodExactPrompt(request), exactRequest),
      exactRequest,
    )
    assert.deepEqual(await page.evaluate(() => window.methodAgentStarts), [])
    checks.push(
      'Prompt-driven method guidance stays in native files and preserves user text byte for byte',
    )

    const beforeReload = structuredClone(persisted.method)
    await page.reload()
    await page.waitForFunction(
      () =>
        window.methodWorkbench?.goal?.method?.activeOperation === 'counterfactual' &&
        window.methodWorkbench.storageStatus === 'saved',
    )
    persisted = await savedGoal()
    assert.deepEqual(persisted.method, beforeReload)
    assert.deepEqual(persisted.nativeMetadata, {
      retained: 'External research artifact metadata is preserved.',
    })
    assert.equal(persisted.problems[0].requirementIds[0], leafId)
    assert.equal(persisted.problems[0].status, 'open')
    assert.equal(await page.evaluate(() => window.methodWorkbench.problem.id), 'problem-one')
    checks.push(
      'Browser reload restores every method record, decomposition, assembly, evidence and blocker link from the actual machine goal.json',
    )

    for (const theme of ['dark', 'light']) {
      if ((await page.locator('.app-shell').getAttribute('data-theme')) !== theme)
        await page.getByRole('button', { name: 'Switch theme', exact: true }).click()
      await page.waitForFunction((theme) => document.documentElement.dataset.theme === theme, theme)
      const background = await page
        .locator('.research-method-workbench')
        .evaluate((element) => getComputedStyle(element).backgroundColor)
      themeBackgrounds[theme] = background
      const colorChannels =
        background
          .match(/[\d.]+/g)
          ?.slice(0, 3)
          .map(Number) || []
      assert.equal(colorChannels.length, 3, background)
      assert(
        colorChannels.every((channel) => (theme === 'light' ? channel >= 220 : channel <= 45)),
        background,
      )
      for (const width of [390, 900, 1440]) {
        for (const tab of [
          'Overview',
          'Requirements',
          'Grounding',
          'Solutions',
          'Approaches',
          'Verification',
          'Map',
        ]) {
          await selectTab(tab)
          await assertNoOverflow(width)
        }
        await selectTab('Overview')
        await page.screenshot({
          path: join(artifacts, theme + '-' + width + '.png'),
          fullPage: true,
        })
        checks.push(
          theme + ' research tools fit a ' + width + 'px viewport without document overflow',
        )
      }
    }
    await page.setViewportSize({ width: 1440, height: 1080 })
    await selectTab('Map')
    assert.equal(
      await page.getByRole('region', { name: 'Research map fixture', exact: true }).isVisible(),
      true,
    )
    for (const projection of ['requirements', 'grounding', 'construction', 'verification', 'all']) {
      await page.getByLabel('Graph projection', { exact: true }).selectOption(projection)
      await page
        .getByRole('region', { name: 'Research method relationships', exact: true })
        .waitFor()
      await assertNoOverflow(390)
    }
    await page.getByLabel('Graph projection', { exact: true }).selectOption('custom')
    assert.equal(
      await page.getByRole('region', { name: 'Research map fixture', exact: true }).isVisible(),
      true,
    )
    checks.push(
      'Five method graph projections show the same linked records and retain the independent custom research map',
    )

    await page.setViewportSize({ width: 1440, height: 1080 })
    await selectTab('Solutions')
    await openForm('Record interaction')
    await link('Candidates in this interaction', candidateA).check()
    await link('Candidates in this interaction', candidateB).check()
    await chooseOption('Relationship', 'conflicting')
    const conflictingMechanism =
      'An overloaded urgent handoff channel can interrupt protected focus and compete for the same researcher.'
    await field('Interaction mechanism').fill(conflictingMechanism)
    await link('Evidence for this relationship', observation).check()
    persisted = await submitForm()
    assert.equal(persisted.method.interactions.length, 2)
    const conflictId = persisted.method.interactions.find((row) => row.kind === 'conflicting').id
    assert(
      (
        await page.evaluate(() => window.methodWorkbench.methodAnalysis)
      ).conflictInteractionIds.includes(conflictId),
    )
    const matrixPair = page.getByRole('button', {
      name: 'Interaction: ' + candidateA + ' and ' + candidateB,
      exact: true,
    })
    assert.match(await matrixPair.textContent(), /conflicting.*2/)
    await matrixPair.click()
    await page.getByRole('dialog', { name: 'Interaction observations', exact: true }).waitFor()
    const pairObservations = dialog().locator('.research-method-pair-record')
    assert.equal(await pairObservations.count(), 2)
    assert((await dialog().textContent()).includes(interactionMechanism))
    assert((await dialog().textContent()).includes(conflictingMechanism))
    assert((await dialog().textContent()).includes(observation))
    await dialog().getByRole('button', { name: 'Close dialog', exact: true }).click()
    await dialog().waitFor({ state: 'hidden' })
    checks.push(
      'Two observations for the same candidate pair preserve both mechanisms and evidence while the matrix prominently exposes the recorded conflict',
    )

    await page.setViewportSize({ width: 1440, height: 1080 })
    await selectTab('Requirements')
    await page
      .getByRole('button', { name: 'Delete requirement: ' + parentStatement, exact: true })
      .click()
    await dialog().waitFor()
    await dialog().getByRole('button', { name: 'Delete requirement', exact: true }).click()
    await dialog().waitFor({ state: 'hidden' })
    persisted = await savedGoal()
    assert.equal(persisted.method.requirements.length, 1)
    assert.equal(persisted.method.requirements[0].id, leafId)
    assert.equal(persisted.method.requirements[0].parentId, undefined)
    assert.deepEqual(persisted.problems[0].requirementIds, [leafId])
    checks.push(
      'Deleting a broad requirement retains its basic constituent, evidence and blocker links while removing the missing parent',
    )

    await selectTab('Solutions')
    await page.getByRole('button', { name: 'Delete candidate: ' + candidateB, exact: true }).click()
    await dialog().waitFor()
    await dialog().getByRole('button', { name: 'Delete candidate', exact: true }).click()
    await dialog().waitFor({ state: 'hidden' })
    persisted = await savedGoal()
    assert(!persisted.method.candidates.some((row) => row.id === candidateBId))
    assert.deepEqual(
      persisted.method.candidates.find((row) => row.id === compositeId).componentCandidateIds,
      [candidateAId],
    )
    assert.equal(persisted.method.interactions.length, 0)
    assert.deepEqual(persisted.method.validations[0].candidateIds, [candidateAId])
    assert.deepEqual(persisted.method.inquiries[0].candidateIds, [compositeId])
    checks.push(
      'Deleting a component removes dangling assembly/test links and invalid two-candidate interactions while preserving the composite and inquiry',
    )

    await selectTab('Grounding')
    await page.getByRole('button', { name: 'Delete evidence: ' + observation, exact: true }).click()
    await dialog().waitFor()
    await dialog().getByRole('button', { name: 'Delete evidence', exact: true }).click()
    await dialog().waitFor({ state: 'hidden' })
    persisted = await savedGoal()
    assert.equal(persisted.method.evidence.length, 0)
    assert.deepEqual(persisted.method.validations[0].evidenceIds, [])
    assert.deepEqual(persisted.method.assumptions[0].evidenceIds, [])
    assert(
      (
        await page.evaluate(() => window.methodWorkbench.methodAnalysis)
      ).unsupportedAssumptionIds.includes(assumptionId),
    )
    assert(
      !(
        await page.evaluate(() => window.methodWorkbench.methodAnalysis)
      ).verifiedRequirementIds.includes(leafId),
    )
    await selectTab('Overview')
    assert.equal(
      await page
        .locator('.research-method-metrics button')
        .filter({ hasText: 'Leaves verified' })
        .locator('strong')
        .textContent(),
      '0/1',
    )
    checks.push(
      'Removing supporting evidence exposes unsupported assumptions and removes the verified count despite the retained historical passing result',
    )

    assert(nativeCalls.length > 20)

    const largeGoalDirectory = join(machineHome, '.life/research/large-method-goal')
    await mkdir(largeGoalDirectory)
    const largeRequirements = Array.from({ length: 30 }, (_, index) => ({
      id: 'large-requirement-' + index,
      statement: 'Basic constituent ' + (index + 1),
      acceptance: 'Record a bounded observable result for constituent ' + (index + 1),
      rationale: 'This is one independently testable measurement.',
      kind: 'component',
      priority: 'essential',
      atomic: true,
      status: 'proposed',
      assumptionIds: [],
      evidenceIds: [],
      updatedAt: 1,
    }))
    const largeRequirementIds = largeRequirements.map((row) => row.id)
    const denseEvidence = Array.from({ length: 60 }, (_, index) => ({
      id: 'large-evidence-' + index,
      kind: 'observation',
      content: 'Observed bounded result ' + (index + 1),
      source: 'dense-fixture/' + index,
      reliability: 'reported',
      updatedAt: 1,
    }))
    const denseEvidenceIds = denseEvidence.map((row) => row.id)
    const denseAssumptions = Array.from({ length: 60 }, (_, index) => ({
      id: 'large-assumption-' + index,
      claim: 'Inspect premise ' + (index + 1),
      challenge: 'Collect a counterexample.',
      consequence: 'Revisit the linked mechanism.',
      status: 'supported',
      requirementIds: largeRequirementIds,
      evidenceIds: denseEvidenceIds,
      updatedAt: 1,
    }))
    const denseAssumptionIds = denseAssumptions.map((row) => row.id)
    for (const requirement of largeRequirements) {
      requirement.assumptionIds = denseAssumptionIds
      requirement.evidenceIds = denseEvidenceIds
    }
    const denseCandidates = Array.from({ length: 40 }, (_, index) => ({
      id: 'large-candidate-' + index,
      title: 'Mechanism ' + (index + 1),
      mechanism: 'A proposed bounded mechanism.',
      risks: 'Requires verification.',
      status: 'proposed',
      componentCandidateIds: [],
      constituentIds: largeRequirementIds,
      emergence: '',
      requirementIds: largeRequirementIds,
      assumptionIds: denseAssumptionIds,
      evidenceIds: denseEvidenceIds,
      updatedAt: 1,
    }))
    const denseCandidateIds = denseCandidates.map((row) => row.id)
    await writeFile(
      join(largeGoalDirectory, 'goal.json'),
      JSON.stringify(
        {
          id: 'large-method-goal',
          title: 'Many constituents and research blockers',
          goal: 'Keep a large research workspace responsive while its records remain inspectable.',
          problems: Array.from({ length: 40 }, (_, index) => ({
            id: 'large-problem-' + index,
            title: 'Research blocker ' + (index + 1),
            description:
              'Investigate this blocker without allocating every possible link selector.',
            notes: '',
            status: 'open',
            requirementIds: ['large-requirement-0'],
            updatedAt: 1,
          })),
          method: {
            version: 1,
            activeOperation: 'anti-abstraction',
            requirements: largeRequirements,
            assumptions: denseAssumptions,
            evidence: denseEvidence,
            candidates: denseCandidates,
            interactions: [],
            validations: Array.from({ length: 50 }, (_, index) => ({
              id: 'large-validation-' + index,
              title: 'Bounded verification ' + (index + 1),
              procedure: 'Repeat a measured bounded check.',
              expected: 'A specified observable outcome.',
              actual: '',
              outcome: 'pending',
              requirementIds: largeRequirementIds,
              candidateIds: denseCandidateIds,
              evidenceIds: denseEvidenceIds,
              updatedAt: 1,
            })),
            inquiries: Array.from({ length: 40 }, (_, index) => ({
              id: 'large-inquiry-' + index,
              operation: 'causal-intervention',
              question: 'Which result changes in intervention ' + (index + 1) + '?',
              premise: 'Hold the baseline constant.',
              intervention: 'Change one bounded factor.',
              prediction: 'Record the proposed effect.',
              result: '',
              status: 'proposed',
              requirementIds: largeRequirementIds,
              candidateIds: denseCandidateIds,
              evidenceIds: denseEvidenceIds,
              updatedAt: 1,
            })),
            normalizationIssues: [],
          },
          createdAt: 1,
          updatedAt: 1,
        },
        null,
        2,
      ) + '\n',
    )
    await page.evaluate(() => window.methodWorkbench.refresh())
    await page.waitForFunction(() =>
      window.methodWorkbench.goals.some((goal) => goal.id === 'large-method-goal'),
    )
    await page.evaluate(() => window.methodWorkbench.selectGoal('large-method-goal'))
    await page.waitForFunction(() => window.methodWorkbench.goal?.id === 'large-method-goal')
    await selectTab('Requirements')
    assert.equal(await page.locator('.research-method-blocker-links input').count(), 0)
    const blockerChoices = page.getByRole('button', { name: /^Link affected requirements/ })
    assert.equal(await blockerChoices.count(), 40)
    await blockerChoices.nth(0).click()
    assert.equal(await page.locator('.research-method-blocker-links input').count(), 30)
    await blockerChoices.nth(1).click()
    assert.equal(await page.locator('.research-method-blocker-links input').count(), 30)
    assert.equal(await blockerChoices.nth(0).getAttribute('aria-expanded'), 'false')
    assert.equal(await blockerChoices.nth(1).getAttribute('aria-expanded'), 'true')
    await assertNoOverflow(390)
    checks.push(
      'A forty-blocker, thirty-constituent goal opens only one requested relationship selector instead of rendering twelve hundred hidden checkboxes',
    )
    await selectTab('Map')
    await page.getByLabel('Graph projection', { exact: true }).selectOption('all')
    const denseGraph = page.getByRole('region', {
      name: 'Research method relationships',
      exact: true,
    })
    await denseGraph.waitFor()
    assert.equal(await denseGraph.locator('.life-canvas-node').count(), 250)
    assert.equal(await denseGraph.locator('.life-canvas-edges > g').count(), 1500)
    const scopeNotice = await denseGraph.locator('.research-method-graph-limit').textContent()
    assert.match(scopeNotice, /Showing 250 of 280 records/)
    assert.match(scopeNotice, /1500 of \d+ relationships/)
    assert.match(scopeNotice, /all records remain available in the tools/)
    for (const kind of [
      'requirement',
      'assumption',
      'candidate',
      'inquiry',
      'verification',
      'evidence',
    ])
      assert(
        (await denseGraph
          .getByRole('button', { name: new RegExp('^Inspect ' + kind + ':') })
          .count()) > 0,
      )
    await assertNoOverflow(390)
    checks.push(
      'A dense two-hundred-eighty-record graph balances all record types, caps rendered relationships at fifteen hundred and explicitly reports its displayed scope',
    )

    assert.deepEqual(errors, [])
    assert.deepEqual(await page.evaluate(() => window.methodErrors), [])
    await writeFile(
      join(artifacts, 'proof.json'),
      JSON.stringify(
        {
          passed: checks.length,
          checks,
          errors,
          nativeCalls: nativeCalls.length,
          themeBackgrounds,
          denseGraphScope: scopeNotice,
        },
        null,
        2,
      ) + '\n',
    )
    await Promise.all(
      ['failure.png', 'failure.html', 'failure-state.json'].map((name) =>
        rm(join(artifacts, name), { force: true }),
      ),
    )
    process.stdout.write(JSON.stringify({ passed: checks.length, checks, errors }, null, 2) + '\n')
  } catch (error) {
    if (page) {
      await page
        .screenshot({ path: join(artifacts, 'failure.png'), fullPage: true })
        .catch(() => {})
      await writeFile(join(artifacts, 'failure.html'), await page.content()).catch(() => {})
      await writeFile(
        join(artifacts, 'failure-state.json'),
        JSON.stringify(
          {
            errors,
            state: await page
              .evaluate(() => ({
                goal: window.methodWorkbench?.goal,
                status: window.methodWorkbench?.storageStatus,
                error: window.methodWorkbench?.storageError,
                errors: window.methodErrors,
              }))
              .catch(() => undefined),
          },
          null,
          2,
        ) + '\n',
      ).catch(() => {})
    }
    throw error
  } finally {
    await browser?.close()
    if (server) await new Promise((resolve) => server.close(resolve))
    await rm(directory, { recursive: true, force: true })
  }
}

main().catch((error) => {
  console.error(error)
  process.exitCode = 1
})
