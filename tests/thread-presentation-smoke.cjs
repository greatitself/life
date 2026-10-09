#!/usr/bin/env node
// Exercise the shipped timeline components in Chromium, including exact raw-output actions.
const assert = require('node:assert/strict')
const { createServer } = require('node:http')
const { mkdtemp, mkdir, readFile, writeFile, rm } = require('node:fs/promises')
const { join, resolve } = require('node:path')
const { tmpdir } = require('node:os')
const { build } = require('esbuild')
const { chromium } = require('playwright')

async function run() {
  const directory = await mkdtemp(join(tmpdir(), 'life-thread-presentation-'))
  const output = resolve(__dirname, '../output/playwright')
  await mkdir(output, { recursive: true })
  const checks = []
  const errors = []
  let browser
  let server
  try {
    await build({
      stdin: {
        resolveDir: resolve(__dirname, '..'),
        sourcefile: 'thread-presentation-fixture.tsx',
        loader: 'tsx',
        contents: `
          import React, { useState } from 'react'
          import { createRoot } from 'react-dom/client'
          import { ThreadTimeline } from './src/renderer/components/ThreadTimeline'
          import { ApprovalCard, ToolStatus } from './src/renderer/components/MessageView'
          import { ThreadRunStatus } from './src/renderer/components/ThreadRunStatus'
          import './src/renderer/styles.css'
          import './src/renderer/components/thread-output.css'
          const original = 'Progress before the command.\\n\\n<artifact>exact original angle-bracket contents</artifact>\\n\\n- [x] Keep complete output\\n- [ ] Finish the checks\\n'
          const commandInput = 'printf "<done>\\\\n"\\ncat notes.txt\\n'
          const initialOutput = '<done>\\nFirst streamed command output.\\n'
          const fullOutput = 'FULL-OUTPUT-BEGIN\\r\\n' + 'Complete provider output with <angle> data.\\r\\n'.repeat(7000) + 'FULL-OUTPUT-END\\n'
          const code = 'console.log("<artifact>");\\nconst answer = 42;\\n'
          const planDetails = { plan: [{ step: 'Inspect the current renderer.', status: 'completed' }, { text: 'Validate exact output.', status: 'in_progress' }, { content: 'Report evidence.', status: 'pending' }] }
          const finalText = '## Result\\n\\nEvery event stays in order.\\n\\n| Check | Status |\\n| --- | --- |\\n| Input | Visible |\\n| Output | Complete |\\n\\n' + '\\x60\\x60\\x60js\\n' + code + '\\x60\\x60\\x60'
          const base = { turn: 1, createdAt: Date.now() - 5000 }
          const messages = [
            { ...base, id: '1:user', role: 'user', text: 'Inspect the output and use subagents.' },
            { ...base, id: '1:commentary', role: 'assistant', phase: 'commentary', text: original },
            { ...base, id: '1:command', role: 'tool', title: 'exec_command', status: 'running', input: commandInput, text: initialOutput },
            { ...base, id: '1:steering', role: 'user', text: 'Use the second approach while you work.', kind: 'steering' },
            { ...base, id: '1:reasoning', role: 'assistant', kind: 'reasoning', text: 'Provider-returned reasoning summary remains available.' },
            { ...base, id: '1:plan', role: 'assistant', kind: 'plan', text: 'The provider supplied this exact plan.', details: planDetails },
            { ...base, id: '1:parent', role: 'tool', kind: 'subagent', title: 'spawn_agent', status: 'completed', agentId: 'provider-parent-agent', agentName: 'Renderer review', input: JSON.stringify({ task_name: 'Renderer review', prompt: 'Inspect every visible provider field.' }), text: 'Started independent review.' },
            { ...base, id: '1:child', role: 'tool', kind: 'subagent', title: 'wait_agent', status: 'completed', agentId: 'provider-child-agent', agentName: 'Output audit', parentItemId: 'parent', input: JSON.stringify({ message: 'Report the complete result.' }), text: 'All fields were retained.', details: { agentsStates: { 'provider-child-agent': { agentName: 'Output audit', status: 'completed', message: 'Nested agent verified exact output.' }, 'provider-qa-agent': { name: 'QA checks', status: 'running', result: 'Checking download bytes.' } } } },
            { ...base, id: '1:final', role: 'assistant', phase: 'final_answer', text: finalText },
            { ...base, id: '1:later-tool', role: 'tool', title: 'cat full-output.log', status: 'completed', text: fullOutput },
            { ...base, id: '1:error', role: 'error', text: 'A later check failed after the response; preserve its position.' },
          ]
          window.threadFixture = { original, commandInput, initialOutput, fullOutput, code, finalText, planDetails }
          window.approvalCalls = []
          window.rejectApproval = true
          function Fixture() {
            const [thread, setThread] = useState({ id: 'fixture', profileId: 'fixture-machine', workspace: '/research/life', provider: 'codex', title: 'Review provider output', messages, busy: true, model: 'model', mode: 'review', updatedAt: Date.now(), turn: 1, pending: [] })
            const [approvalSent, setApprovalSent] = useState(false)
            return <div className="app-shell life-refined-layout" data-theme="dark">
              <main className="main-workspace" style={{ padding: '28px', maxWidth: 1080, margin: '0 auto', overflow: 'visible' }}>
                <header style={{ display: 'flex', justifyContent: 'space-between', gap: 20, marginBottom: 24 }}><div><h1 style={{ margin: 0, fontSize: 20 }}>life</h1><p style={{ margin: '4px 0', color: 'var(--muted)' }}>Thread output · /research/life</p></div>
                  <button className="button secondary" onClick={() => setThread(current => ({ ...current, messages: current.messages.map(message => message.id === '1:commentary' ? { ...message, text: message.text + '\\nStreaming update stays visible.' } : message.id === '1:command' ? { ...message, text: message.text + 'Second streamed command output.\\n' } : message) }))}>Stream another update</button>
                </header>
                <section aria-label="Run status checks" style={{ display: 'flex', gap: 24, paddingBottom: 20 }}>
                  <span data-run-state="reconnecting"><ThreadRunStatus thread={{ ...thread, turnStatus: 'reconnecting', statusText: 'Restoring the saved turn after SSH reconnects.' }} /></span>
                  <span data-run-state="waiting"><ThreadRunStatus thread={{ ...thread, pending: [{ sessionId: thread.id, type: 'question' }] }} /></span>
                  <span data-run-state="unknown"><ThreadRunStatus thread={{ ...thread, turnStatus: 'unknown' }} /></span>
                </section>
                <section aria-label="Lifecycle status checks" style={{ display: 'flex', gap: 24, paddingBottom: 20 }}><ToolStatus status="waiting" /><ToolStatus status="pending" /><ToolStatus status="spawning" /><ToolStatus status="errored" /><ToolStatus status="canceled" /></section>
                <ThreadTimeline thread={thread} />
                <section aria-label="Approval retry checks" style={{ marginTop: 24 }}>
                  <ApprovalCard event={{ sessionId: thread.id, type: 'question', requestId: 'qa-question', text: 'The provider asks for an exact instruction and execution preference.', questions: [{ id: 'answer', header: 'Instruction', question: 'Which exact instruction should be kept?' }, { id: 'choice', header: 'Execution preference', question: 'How should the next check run?', options: [{ label: 'Inspect', description: 'Read the current files before making a change.' }, { label: 'Execute', description: 'Run the already reviewed check and report its complete output.' }] }] }} onRespond={async (accepted, answers) => {
                    window.approvalCalls.push({ accepted, answers: structuredClone(answers) })
                    if (window.rejectApproval) throw new Error('Connection dropped while sending your answer.')
                    setApprovalSent(true)
                  }} />
                  {approvalSent ? <p data-approval="sent">Answer accepted</p> : null}
                </section>
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
      define: { 'process.env.NODE_ENV': '"development"' },
      logLevel: 'silent',
    })
    server = createServer(async (request, response) => {
      try {
        const path = request.url.split('?')[0]
        const file = ['fixture.js', 'fixture.css'].find((name) => path === '/' + name)
        response.setHeader(
          'Content-Type',
          file?.endsWith('.js') ? 'text/javascript' : file ? 'text/css' : 'text/html',
        )
        response.end(
          file
            ? await readFile(join(directory, file))
            : '<!doctype html><html lang="en"><head><meta charset="utf-8"><title>Life thread presentation</title><link rel="stylesheet" href="/fixture.css"><style>html,body,#root{height:auto;min-height:100%;overflow:visible}body{background:#101112}.app-shell{display:block;height:auto;min-height:100vh;overflow:visible}.main-workspace{display:block}.thread-original-message{max-width:100%}</style></head><body><div id="root"></div><script src="/fixture.js"></script></body></html>',
        )
      } catch (error) {
        response.statusCode = 500
        response.end(String(error))
      }
    })
    await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
    browser = await chromium.launch({ headless: true })
    const context = await browser.newContext({
      viewport: { width: 1440, height: 1100 },
      permissions: ['clipboard-read', 'clipboard-write'],
      acceptDownloads: true,
    })
    const page = await context.newPage()
    page.on('pageerror', (error) => errors.push(error.message))
    page.on('console', (event) => {
      if (event.type() === 'error') errors.push(event.text())
    })
    await page.goto('http://127.0.0.1:' + server.address().port)
    await page.locator('[data-message-id="1:error"]').waitFor()
    assert.deepEqual(
      await page
        .locator('[data-message-id]')
        .evaluateAll((nodes) => nodes.map((node) => node.dataset.messageId)),
      [
        '1:user',
        '1:commentary',
        '1:command',
        '1:steering',
        '1:reasoning',
        '1:plan',
        '1:parent',
        '1:child',
        '1:final',
        '1:later-tool',
        '1:error',
      ],
    )
    checks.push(
      'Every commentary, tool, steering, summary, plan, subagent, response and error remains in exact arrival order',
    )
    const command = page.locator('[data-message-id="1:command"]')
    const fixture = await page.evaluate(() => window.threadFixture)
    assert.equal(
      await command
        .getByRole('region', { name: 'Input', exact: true })
        .locator('pre')
        .textContent(),
      fixture.commandInput,
    )
    assert.equal(
      await command
        .getByRole('region', { name: 'Output', exact: true })
        .locator('pre')
        .textContent(),
      fixture.initialOutput,
    )
    assert.equal(await command.getByText('Running', { exact: true }).isVisible(), true)
    assert.equal(
      await command.getByRole('region', { name: 'Input', exact: true }).isVisible(),
      true,
    )
    assert.equal(
      await command.getByRole('region', { name: 'Output', exact: true }).isVisible(),
      true,
    )
    for (const label of ['Progress update', 'Reasoning summary', 'Plan', 'Response'])
      assert.equal(
        await page.locator('.thread-message-phase').getByText(label, { exact: true }).isVisible(),
        true,
      )
    assert.equal(await page.locator('[data-message-id="1:error"]').isVisible(), true)
    assert.match(
      await page.locator('[data-run-state="reconnecting"]').textContent(),
      /^Reconnecting /,
    )
    assert.match(
      await page.locator('[data-run-state="waiting"]').textContent(),
      /^Waiting for you /,
    )
    assert.match(await page.locator('[data-run-state="unknown"]').textContent(), /^Awaiting agent /)
    const statuses = page.getByRole('region', { name: 'Lifecycle status checks' })
    for (const [status, label] of [
      ['waiting', 'Waiting'],
      ['pending', 'Pending'],
      ['spawning', 'Running'],
      ['errored', 'Failed'],
      ['canceled', 'Interrupted'],
    ])
      assert.equal(await statuses.locator(`[data-status="${status}"]`).textContent(), label)
    checks.push(
      'Tool Input and Output, running status, provider phases and errors are initially visible',
    )
    checks.push(
      'Disconnected and waiting turns expose honest reconnecting, awaiting-agent and lifecycle status labels',
    )
    await page.getByRole('button', { name: 'Stream another update', exact: true }).click()
    await page.getByText('Streaming update stays visible.', { exact: true }).waitFor()
    assert.equal(
      await command
        .getByRole('region', { name: 'Output', exact: true })
        .locator('pre')
        .textContent(),
      fixture.initialOutput + 'Second streamed command output.\n',
    )
    assert.equal(
      await command.getByRole('region', { name: 'Output', exact: true }).isVisible(),
      true,
    )
    checks.push('Immutable streamed rerenders retain visible tool output and commentary')
    const commentary = page.locator('[data-message-id="1:commentary"]')
    await commentary.locator('.thread-original-message > summary').click()
    const exactOriginal = fixture.original + '\nStreaming update stays visible.'
    const original = commentary.getByRole('region', { name: 'Original message', exact: true })
    assert.equal(await original.locator('pre').textContent(), exactOriginal)
    await original.getByRole('button', { name: 'Copy original message', exact: true }).click()
    assert.equal(await page.evaluate(() => navigator.clipboard.readText()), exactOriginal)
    assert.equal(await commentary.locator('.markdown artifact').count(), 0)
    checks.push(
      'Original model output with angle-bracket content is inspectable and copies exactly as text',
    )
    const plan = page.locator('[data-message-id="1:plan"]')
    const planList = plan.getByRole('list', { name: 'Agent plan', exact: true })
    assert.deepEqual(
      await planList.locator('li').evaluateAll((nodes) =>
        nodes.map((node) => ({
          text: node.querySelector(':scope > span:not(.thread-plan-number)').textContent,
          status: node.dataset.status,
        })),
      ),
      [
        { text: 'Inspect the current renderer.', status: 'completed' },
        { text: 'Validate exact output.', status: 'in_progress' },
        { text: 'Report evidence.', status: 'pending' },
      ],
    )
    for (const label of ['completed', 'in progress', 'pending'])
      assert.equal(await planList.getByText(label, { exact: true }).isVisible(), true)
    await plan.locator('.thread-original-message > summary').click()
    const planMetadata = plan.getByRole('region', { name: 'Provider details', exact: true })
    assert.equal(
      await planMetadata.locator('pre').textContent(),
      JSON.stringify(fixture.planDetails, null, 2),
    )
    await planMetadata.getByRole('button', { name: 'Copy provider details', exact: true }).click()
    assert.equal(
      await page.evaluate(() => navigator.clipboard.readText()),
      JSON.stringify(fixture.planDetails, null, 2),
    )
    await plan.locator('.thread-original-message > summary').click()
    checks.push(
      'Actual provider plans render complete ordered steps and statuses with exact raw metadata still inspectable and copyable',
    )
    const final = page.locator('[data-message-id="1:final"]')
    assert.equal(await final.locator('.markdown table').isVisible(), true)
    await final.getByRole('button', { name: 'Copy code', exact: true }).click()
    assert.equal(await page.evaluate(() => navigator.clipboard.readText()), fixture.code)
    checks.push(
      'GFM tables render and fenced code copies without a markup wrapper or altered bytes',
    )
    const later = page.locator('[data-message-id="1:later-tool"]')
    const laterOutput = later.getByRole('region', { name: 'Output', exact: true })
    const preview = await laterOutput.locator(':scope > pre').textContent()
    assert.ok(preview.length < 6200)
    assert.ok(preview.startsWith('FULL-OUTPUT-BEGIN'))
    assert.ok(preview.endsWith('FULL-OUTPUT-END\n'))
    assert.ok(preview.includes('characters in the full output'))
    assert.equal(await laterOutput.locator('.thread-full-output > pre').count(), 0)
    await laterOutput.getByRole('button', { name: 'Copy output', exact: true }).click()
    assert.equal(await page.evaluate(() => navigator.clipboard.readText()), fixture.fullOutput)
    const downloadPromise = page.waitForEvent('download')
    await laterOutput.getByRole('button', { name: 'Download output', exact: true }).click()
    const download = await downloadPromise
    assert.equal(download.suggestedFilename(), 'output.txt')
    assert.equal(await readFile(await download.path(), 'utf8'), fixture.fullOutput)
    await laterOutput.locator('.thread-full-output > summary').click()
    await laterOutput.locator('.thread-full-output > pre').waitFor()
    assert.equal(
      await laterOutput.locator('.thread-full-output > pre').textContent(),
      fixture.fullOutput,
    )
    await laterOutput.locator('.thread-full-output > summary').click()
    await page.waitForFunction(
      () => !document.querySelector('[data-message-id="1:later-tool"] .thread-full-output > pre'),
    )
    checks.push(
      'Large output initially mounts a bounded preview; full copy, download and expanded inspection preserve complete bytes',
    )
    const child = page.locator('[data-message-id="1:child"]')
    assert.equal(await child.getAttribute('data-nested'), 'true')
    assert.equal(await child.getByText('provider-child-agent', { exact: true }).isVisible(), true)
    assert.equal(
      await child.getByText('Nested agent verified exact output.', { exact: true }).isVisible(),
      true,
    )
    assert.equal(
      await child.getByText('Checking download bytes.', { exact: true }).isVisible(),
      true,
    )
    assert.equal(
      await child
        .getByRole('list', { name: 'Subagent states' })
        .getByText('completed', { exact: true })
        .isVisible(),
      true,
    )
    await child.getByRole('link', { name: 'Parent activity', exact: true }).click()
    assert.equal(await page.evaluate(() => document.activeElement.dataset.messageId), '1:parent')
    checks.push(
      'Named subagents show provider IDs, tasks, participants and complete results; nested parent link focuses the actual parent',
    )
    const approval = page.getByRole('region', { name: 'Approval retry checks' })
    const answer = approval.getByRole('textbox', {
      name: /Which exact instruction should be kept\?/,
    })
    const exactAnswer = 'Never append hidden prompt text. Keep my exact answer.'
    assert.equal(
      await approval
        .getByText('The provider asks for an exact instruction and execution preference.', {
          exact: true,
        })
        .isVisible(),
      true,
    )
    assert.equal(await approval.getByText('Instruction', { exact: true }).isVisible(), true)
    assert.equal(
      await approval.getByText('Execution preference', { exact: true }).isVisible(),
      true,
    )
    const descriptions = approval.getByRole('list', { name: 'Answer descriptions', exact: true })
    assert.equal(
      await descriptions
        .getByText('Read the current files before making a change.', { exact: true })
        .isVisible(),
      true,
    )
    assert.equal(
      await descriptions
        .getByText('Run the already reviewed check and report its complete output.', {
          exact: true,
        })
        .isVisible(),
      true,
    )
    checks.push(
      'Provider question context, headers and every answer description remain visible outside the select menu',
    )
    assert.equal(
      await approval.getByRole('button', { name: 'Send answers', exact: true }).isDisabled(),
      true,
    )
    await answer.fill(exactAnswer)
    await approval
      .getByRole('combobox', { name: /How should the next check run\?/ })
      .selectOption('Inspect')
    await approval.getByRole('button', { name: 'Send answers', exact: true }).click()
    await approval.getByRole('alert').waitFor()
    assert.equal(
      await approval.getByRole('alert').textContent(),
      'Connection dropped while sending your answer.',
    )
    assert.equal(await answer.inputValue(), exactAnswer)
    assert.equal(
      await approval.getByRole('button', { name: 'Send answers', exact: true }).isEnabled(),
      true,
    )
    assert.equal(
      await approval.getByRole('button', { name: 'Decline', exact: true }).isEnabled(),
      true,
    )
    await page.evaluate(() => {
      window.rejectApproval = false
    })
    await approval.getByRole('button', { name: 'Send answers', exact: true }).click()
    await approval.getByText('Answer accepted', { exact: true }).waitFor()
    assert.equal(await approval.getByRole('alert').count(), 0)
    assert.deepEqual(await page.evaluate(() => window.approvalCalls), [
      { accepted: true, answers: { answer: [exactAnswer], choice: ['Inspect'] } },
      { accepted: true, answers: { answer: [exactAnswer], choice: ['Inspect'] } },
    ])
    checks.push(
      'Approval failure is visible, preserves exact answers and reenables controls for a successful retry without unhandled rejection',
    )
    await commentary.locator('.thread-original-message > summary').click()
    await page.evaluate(() => window.scrollTo(0, 0))
    await page.screenshot({ path: join(output, 'thread-presentation-v07.png') })
    await child.screenshot({ path: join(output, 'thread-presentation-v07-subagents.png') })
    await page.screenshot({
      path: join(output, 'thread-presentation-v07-full.png'),
      fullPage: true,
    })
    assert.deepEqual(errors, [])
    const proof = {
      ok: true,
      checks,
      errors,
      screenshot: 'output/playwright/thread-presentation-v07.png',
      fullOutputCharacters: fixture.fullOutput.length,
      previewCharacters: preview.length,
      completedAt: new Date().toISOString(),
    }
    await writeFile(
      join(output, 'thread-presentation-v07-proof.json'),
      JSON.stringify(proof, null, 2) + '\n',
    )
    process.stdout.write(JSON.stringify(proof, null, 2) + '\n')
  } catch (error) {
    const proof = {
      ok: false,
      checks,
      errors,
      error: error.stack || String(error),
      completedAt: new Date().toISOString(),
    }
    await writeFile(
      join(output, 'thread-presentation-v07-proof.json'),
      JSON.stringify(proof, null, 2) + '\n',
    )
    throw error
  } finally {
    await browser?.close()
    if (server) await new Promise((resolve) => server.close(resolve))
    await rm(directory, { recursive: true, force: true })
  }
}

run().catch((error) => {
  console.error(error)
  process.exitCode = 1
})
