#!/usr/bin/env node
// Exercise request-owned question drafts and native response semantics without providers.
const assert = require('node:assert/strict')
const { createServer } = require('node:http')
const { mkdtemp, mkdir, readFile, writeFile, rm } = require('node:fs/promises')
const { join, resolve } = require('node:path')
const { tmpdir } = require('node:os')
const { build } = require('./helpers/browser-build.cjs')
const { chromium } = require('playwright')

async function run() {
  const directory = await mkdtemp(join(tmpdir(), 'life-pending-questions-'))
  const output = resolve(__dirname, '../output/playwright/pending-questions')
  await mkdir(output, { recursive: true })
  const checks = []
  const errors = []
  const measurements = []
  let browser
  let server
  let page
  try {
    await build({
      stdin: {
        resolveDir: resolve(__dirname, '..'),
        sourcefile: 'pending-question-fixture.tsx',
        loader: 'tsx',
        contents: `
          import React, { useState } from 'react'
          import { createRoot } from 'react-dom/client'
          import { flushSync } from 'react-dom'
          import { PendingQuestionPanel } from './src/renderer/components/PendingQuestionPanel'
          import './src/renderer/styles.css'
          window.responseCalls = []
          window.rejectResponse = false
          window.holdResponse = false
          function Fixture() {
            const [event, setEvent] = useState({ sessionId: 'fixture', requestId: 'initial', type: 'question', questions: [{ id: 'initial', question: 'Initial question?' }] })
            const [mounted, setMounted] = useState(true)
            const [active, setActive] = useState(true)
            const [draft, setDraft] = useState('Ordinary draft stays here.')
            window.setQuestionRequest = request => flushSync(() => setEvent(request))
            window.setPanelMounted = mounted => flushSync(() => setMounted(mounted))
            window.setPanelActive = active => flushSync(() => setActive(active))
            return <main className="question-fixture" style={{ maxWidth: 800, margin: '0 auto', padding: 28 }}>
              <h1>Native question fixture</h1>
              {mounted && <PendingQuestionPanel event={event} active={active} pendingCount={2} onRespond={async (request, accepted, answers, decisionId) => {
                window.responseCalls.push({ requestId: request.requestId, accepted, answers: answers === undefined ? null : structuredClone(answers), ...(decisionId === undefined ? {} : { decisionId }) })
                const reject = window.rejectResponse
                if (window.holdResponse) await new Promise(resolve => window.releaseResponse = resolve)
                if (reject) throw new Error('The response was not delivered. Reconnect and retry.')
              }} />}
              <label style={{ display: 'block', marginTop: 24 }}>Ordinary message draft
                <textarea aria-label="Ordinary message draft" value={draft} onChange={event => setDraft(event.target.value)} />
              </label>
            </main>
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
        if (request.url === '/favicon.ico') {
          response.statusCode = 204
          response.end()
          return
        }
        const file = ['fixture.js', 'fixture.css'].find((name) => request.url === '/' + name)
        if (request.url !== '/' && !file) {
          response.statusCode = 404
          response.end('Not found')
          return
        }
        response.setHeader(
          'Content-Type',
          file?.endsWith('.js') ? 'text/javascript' : file ? 'text/css' : 'text/html',
        )
        response.end(
          file
            ? await readFile(join(directory, file))
            : '<!doctype html><html lang="en"><head><meta charset="utf-8"><title>Life native questions</title><link rel="stylesheet" href="/fixture.css"><style>html,body,#root{height:auto;min-height:100%;overflow:visible}body{background:#101112}.question-fixture{color:var(--text)}</style></head><body><div id="root"></div><script src="/fixture.js"></script></body></html>',
        )
      } catch (error) {
        response.statusCode = 500
        response.end(String(error))
      }
    })
    await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
    browser = await chromium.launch({ headless: true })
    const context = await browser.newContext({ viewport: { width: 1100, height: 1000 } })
    page = await context.newPage()
    page.on('pageerror', (error) => errors.push(error.message))
    page.on('console', (event) => {
      if (event.type() === 'error') errors.push(event.text())
    })
    await page.goto('http://127.0.0.1:' + server.address().port)
    const panel = () => page.getByRole('region', { name: 'Agent questions', exact: true })
    const send = () => panel().getByRole('button', { name: 'Send answers', exact: true })
    const next = () => panel().getByRole('button', { name: 'Next question', exact: true })
    const previous = () => panel().getByRole('button', { name: 'Previous question', exact: true })
    const responses = () => page.evaluate(() => window.responseCalls)
    let sequence = 0
    const request = async (event) => {
      const requestId = event.requestId || 'question-' + ++sequence
      await page.evaluate(
        (event) => {
          window.responseCalls = []
          window.rejectResponse = false
          window.holdResponse = false
          window.setPanelMounted(true)
          window.setPanelActive(true)
          window.setQuestionRequest(event)
        },
        { sessionId: 'fixture', type: 'question', ...event, requestId },
      )
      await panel().waitFor()
      return requestId
    }
    const complete = async () => {
      await page.waitForFunction(() =>
        document.querySelector('.pending-question-panel')?.textContent.includes('Response sent'),
      )
    }
    await panel().waitFor()

    const navigationId = await request({
      questions: [
        {
          id: 'approach',
          header: 'Approach',
          question: 'What should I inspect?',
          options: [
            { label: 'Inspect source', description: 'Read the current implementation.' },
            { label: 'Run tests', description: 'Check the existing behavior.' },
          ],
        },
        { id: 'notes', header: 'Notes', question: 'What should I preserve?' },
      ],
    })
    await page.clock.install({ time: new Date('2026-10-16T12:00:00Z') })
    await page.clock.pauseAt(new Date('2026-10-16T12:00:10Z'))
    const inspect = () => panel().getByRole('radio', { name: /Inspect source/ })
    assert.equal(await inspect().isChecked(), false)
    await inspect().check()
    await page.clock.runFor(199)
    assert.equal(await inspect().isVisible(), true)
    await page.clock.runFor(1)
    const preserve = () =>
      panel().getByRole('textbox', { name: 'What should I preserve?', exact: true })
    await preserve().waitFor()
    assert.equal(await send().isDisabled(), true)
    await previous().click()
    assert.equal(await inspect().isChecked(), true)
    await next().click()
    const exactNotes = '  Keep prompts unchanged.\nKeep the trailing newline.\n'
    await preserve().fill(exactNotes)
    const ordinary = page.getByRole('textbox', { name: 'Ordinary message draft', exact: true })
    assert.equal(await ordinary.inputValue(), 'Ordinary draft stays here.')
    await send().click()
    await complete()
    assert.deepEqual(await responses(), [
      {
        requestId: navigationId,
        accepted: true,
        answers: { approach: ['Inspect source'], notes: [exactNotes] },
      },
    ])
    checks.push(
      'One question at a time advances after 200ms; Back preserves choices and free text keeps exact whitespace without consuming the ordinary draft',
    )

    const keyboardId = await request({
      questions: [
        {
          id: 'choice',
          question: 'Which keyboard choice?',
          options: [{ label: 'First keyboard choice' }, { label: 'Second keyboard choice' }],
          isOther: false,
        },
      ],
    })
    const first = () => panel().getByRole('radio', { name: /First keyboard choice/ })
    const second = () => panel().getByRole('radio', { name: /Second keyboard choice/ })
    await ordinary.fill('A draft with ')
    await ordinary.press('1')
    assert.equal(await ordinary.inputValue(), 'A draft with 1')
    assert.equal(await first().isChecked(), false)
    await panel().focus()
    await page.keyboard.press('Control+1')
    assert.equal(await first().isChecked(), false)
    await panel().evaluate((element) =>
      element.dispatchEvent(
        new KeyboardEvent('keydown', {
          key: '1',
          code: 'Digit1',
          bubbles: true,
          isComposing: true,
        }),
      ),
    )
    assert.equal(await first().isChecked(), false)
    await panel().evaluate((element) =>
      element.dispatchEvent(
        new KeyboardEvent('keydown', { key: '1', code: 'Digit1', bubbles: true, shiftKey: true }),
      ),
    )
    assert.equal(await first().isChecked(), false)
    await page.evaluate(() => window.setPanelActive(false))
    await page.keyboard.press('1')
    assert.equal(await first().isChecked(), false)
    await page.evaluate(() => window.setPanelActive(true))
    await page.keyboard.press('2')
    assert.equal(await second().isChecked(), true)
    await page.clock.runFor(199)
    assert.deepEqual(await responses(), [])
    await page.clock.runFor(1)
    await complete()
    assert.deepEqual(await responses(), [
      { requestId: keyboardId, accepted: true, answers: { choice: ['Second keyboard choice'] } },
    ])
    checks.push(
      'Digit shortcuts respect editable fields, modifiers, IME composition and inactive panels; a deliberate final single choice submits once after 200ms',
    )

    await request({
      questions: [
        {
          id: 'first',
          question: 'Which step first?',
          options: [{ label: 'Keep this draft' }, { label: 'Choose a new draft' }],
          isOther: false,
        },
        { id: 'second', question: 'What comes next?' },
      ],
    })
    await panel().getByRole('radio', { name: 'Keep this draft', exact: true }).check()
    await page.clock.runFor(100)
    await page.evaluate(() => window.setPanelMounted(false))
    await panel().waitFor({ state: 'detached' })
    await page.clock.runFor(250)
    await page.evaluate(() => window.setPanelMounted(true))
    assert.equal(
      await panel().getByRole('radio', { name: 'Keep this draft', exact: true }).isChecked(),
      true,
    )
    await page.clock.runFor(250)
    assert.equal(
      await panel().getByRole('radio', { name: 'Keep this draft', exact: true }).isVisible(),
      true,
    )
    assert.deepEqual(await responses(), [])
    checks.push(
      'Unmounting cancels an owned auto-advance timer; restoring the selected draft does not silently advance or submit it',
    )

    const multipleId = await request({
      questions: [
        {
          id: 'checks',
          question: 'Which checks should run?',
          multiple: true,
          options: [
            { label: 'Typecheck', description: 'Validate TypeScript.' },
            { label: 'Desktop', description: 'Exercise Electron.' },
          ],
        },
      ],
    })
    await panel()
      .getByRole('checkbox', { name: /Typecheck/ })
      .check()
    await panel()
      .getByRole('checkbox', { name: /Desktop/ })
      .check()
    await panel()
      .getByRole('checkbox', { name: /^Other answer/ })
      .check()
    const exactAdditional = '  Also verify reconnects.\n'
    const additional = panel().getByRole('textbox', {
      name: 'Additional answer · Which checks should run?',
      exact: true,
    })
    await additional.fill(exactAdditional)
    await additional.press('1')
    assert.equal(await additional.inputValue(), exactAdditional + '1')
    assert.equal(
      await panel()
        .getByRole('checkbox', { name: /Typecheck/ })
        .isChecked(),
      true,
    )
    await additional.press('Backspace')
    await page.clock.runFor(250)
    assert.deepEqual(await responses(), [])
    await page.screenshot({ path: join(output, 'multiple-choice.png'), fullPage: true })
    await send().click()
    await complete()
    assert.deepEqual(await responses(), [
      {
        requestId: multipleId,
        accepted: true,
        answers: { checks: ['Typecheck', 'Desktop', exactAdditional] },
      },
    ])
    checks.push(
      'Multiple selections and an additional exact custom answer are combined only after explicit submission',
    )

    const retainedRequest = {
      sessionId: 'fixture-a',
      type: 'question',
      requestId: 'retained-draft',
      nativeRecovery: {
        transportId: 'transport-a',
        ownerGeneration: 1,
        localTurn: 2,
        eventId: 'request-a',
        revision: 1,
      },
      questions: [{ id: 'answer', question: 'Thread A answer?' }],
    }
    await request(retainedRequest)
    await panel()
      .getByRole('textbox', { name: 'Thread A answer?', exact: true })
      .fill('  Thread A draft\n')
    await page.evaluate((event) => window.setQuestionRequest(event), {
      sessionId: 'fixture-b',
      type: 'question',
      requestId: 'thread-b',
      questions: [{ id: 'answer', question: 'Thread B answer?' }],
    })
    await panel()
      .getByRole('textbox', { name: 'Thread B answer?', exact: true })
      .fill('Thread B draft')
    await page.evaluate((event) => window.setQuestionRequest(event), retainedRequest)
    assert.equal(
      await panel().getByRole('textbox', { name: 'Thread A answer?', exact: true }).inputValue(),
      '  Thread A draft\n',
    )
    await page.evaluate(() => window.setPanelMounted(false))
    await panel().waitFor({ state: 'detached' })
    await page.evaluate(() => window.setPanelMounted(true))
    assert.equal(
      await panel().getByRole('textbox', { name: 'Thread A answer?', exact: true }).inputValue(),
      '  Thread A draft\n',
    )
    await page.evaluate((event) => window.setQuestionRequest(event), {
      ...retainedRequest,
      nativeRecovery: {
        ...retainedRequest.nativeRecovery,
        revision: 2,
        eventId: 'request-a-replayed',
      },
    })
    assert.equal(
      await panel().getByRole('textbox', { name: 'Thread A answer?', exact: true }).inputValue(),
      '  Thread A draft\n',
    )
    await page.evaluate((event) => window.setQuestionRequest(event), {
      ...retainedRequest,
      nativeRecovery: { ...retainedRequest.nativeRecovery, ownerGeneration: 2 },
    })
    assert.equal(
      await panel().getByRole('textbox', { name: 'Thread A answer?', exact: true }).inputValue(),
      '',
    )
    assert.equal(await send().isDisabled(), true)
    assert.equal(await ordinary.inputValue(), 'A draft with 1')
    checks.push(
      'Drafts survive thread switches, component remounts and replayed delivery revisions; a replacement native owner starts with no inherited answer',
    )

    const ownerRace = {
      sessionId: 'owner-race',
      type: 'question',
      requestId: 'same-native-id',
      nativeRecovery: {
        transportId: 'owner-transport',
        ownerGeneration: 1,
        localTurn: 1,
        revision: 1,
        eventId: 'owner-request',
      },
      questions: [{ id: 'answer', question: 'Owner-specific answer?' }],
    }
    await request(ownerRace)
    const ownerAnswer = () =>
      panel().getByRole('textbox', { name: 'Owner-specific answer?', exact: true })
    await ownerAnswer().fill('Old owner answer')
    await page.evaluate(() => {
      window.holdResponse = true
    })
    await send().click()
    await page.waitForFunction(() => window.responseCalls.length === 1)
    await page.evaluate((event) => window.setQuestionRequest(event), {
      ...ownerRace,
      nativeRecovery: { ...ownerRace.nativeRecovery, ownerGeneration: 2 },
    })
    assert.equal(await ownerAnswer().inputValue(), '')
    assert.equal(await ownerAnswer().isEnabled(), true)
    await ownerAnswer().fill('New owner draft')
    await page.evaluate(() => {
      window.holdResponse = false
      window.releaseResponse()
    })
    await page.clock.runFor(1)
    assert.equal(await ownerAnswer().inputValue(), 'New owner draft')
    assert.equal(await send().isEnabled(), true)
    checks.push(
      'Completing an old in-flight response cannot erase or lock a replacement owner with the same request id',
    )

    const retryId = await request({
      questions: [{ id: 'token', question: 'Private token?', isSecret: true }],
    })
    const token = () => panel().locator('input[type="password"][aria-label="Private token?"]')
    assert.equal(await token().getAttribute('type'), 'password')
    assert.equal(await token().getAttribute('aria-label'), 'Private token?')
    await token().fill('  exact-secret-value  ')
    await page.evaluate(() => {
      window.holdResponse = true
      window.rejectResponse = true
    })
    await send().evaluate((button) => {
      button.click()
      button.click()
    })
    await page.waitForFunction(() => window.responseCalls.length === 1)
    await page.evaluate(() => window.setPanelMounted(false))
    await panel().waitFor({ state: 'detached' })
    await page.evaluate(() => window.setPanelMounted(true))
    assert.equal(await token().isDisabled(), true)
    assert.equal(
      await panel().getByRole('button', { name: 'Decline', exact: true }).isDisabled(),
      true,
    )
    await page.clock.runFor(250)
    assert.equal((await responses()).length, 1)
    await page.evaluate(() => window.releaseResponse())
    await panel()
      .getByRole('alert')
      .filter({ hasText: 'The response was not delivered.' })
      .waitFor()
    assert.equal(await token().inputValue(), '  exact-secret-value  ')
    assert.equal(await send().isEnabled(), true)
    assert.equal(
      await page.evaluate(() =>
        JSON.stringify([localStorage, sessionStorage]).includes('exact-secret-value'),
      ),
      false,
    )
    await page.evaluate(() => {
      window.holdResponse = false
      window.rejectResponse = false
    })
    await send().click()
    await complete()
    assert.deepEqual(await responses(), [
      { requestId: retryId, accepted: true, answers: { token: ['  exact-secret-value  '] } },
      { requestId: retryId, accepted: true, answers: { token: ['  exact-secret-value  '] } },
    ])
    checks.push(
      'In-flight ownership survives unmounting and prevents duplicate responses; a failed native delivery retains private fields in memory for an exact retry',
    )

    const typedId = await request({
      questions: [
        { id: 'attempts', question: 'Attempt count?', inputType: 'integer', isOther: false },
        { id: 'ratio', question: 'Ratio?', inputType: 'number', isOther: false },
        { id: 'enabled', question: 'Enable logging?', inputType: 'boolean', isOther: false },
        { id: 'notes', question: 'Optional notes?', required: false },
      ],
    })
    const attempts = panel().getByRole('spinbutton', { name: 'Attempt count?', exact: true })
    assert.equal(await attempts.inputValue(), '')
    await attempts.fill('3.5')
    assert.equal(await next().isDisabled(), true)
    await panel().getByRole('alert').filter({ hasText: 'Enter a whole number' }).waitFor()
    await attempts.fill('4')
    await next().click()
    await panel().getByRole('spinbutton', { name: 'Ratio?', exact: true }).fill('-0.125')
    await next().click()
    const yes = panel().getByRole('radio', { name: 'Yes', exact: true })
    const no = panel().getByRole('radio', { name: 'No', exact: true })
    assert.equal(await yes.isChecked(), false)
    assert.equal(await no.isChecked(), false)
    assert.equal(await next().isDisabled(), true)
    await no.check()
    await next().click()
    assert.equal(
      await panel().getByRole('textbox', { name: 'Optional notes?', exact: true }).inputValue(),
      '',
    )
    assert.equal(await send().isEnabled(), true)
    await send().click()
    await complete()
    assert.deepEqual(await responses(), [
      {
        requestId: typedId,
        accepted: true,
        answers: { attempts: ['4'], ratio: ['-0.125'], enabled: ['false'] },
      },
    ])
    checks.push(
      'Typed questions enforce integer, number and boolean values without selecting defaults; untouched optional questions are omitted',
    )

    const emptyId = await request({
      questions: [
        { id: 'text', question: 'Required empty string?', allowEmpty: true },
        {
          id: 'list',
          question: 'Required empty list?',
          multiple: true,
          allowEmpty: true,
          isOther: false,
          options: [{ label: 'Run check' }],
        },
      ],
    })
    assert.equal(await next().isDisabled(), true)
    await panel()
      .getByRole('checkbox', { name: /Use an empty answer/ })
      .check()
    await next().click()
    assert.equal(await send().isDisabled(), true)
    await panel()
      .getByRole('checkbox', { name: /Select none/ })
      .check()
    await send().click()
    await complete()
    assert.deepEqual(await responses(), [
      { requestId: emptyId, accepted: true, answers: { text: [''], list: [] } },
    ])
    checks.push(
      'Empty strings and empty lists require an explicit choice and retain their distinct native values',
    )

    const asyncId = await request({
      responseMode: 'message',
      canDismiss: true,
      questions: [{ id: 'later', question: 'Answer this later?' }],
    })
    assert.equal(await panel().getByRole('button', { name: 'Decline', exact: true }).count(), 0)
    await panel().getByRole('button', { name: 'Dismiss', exact: true }).click()
    await complete()
    assert.deepEqual(await responses(), [{ requestId: asyncId, accepted: false, answers: null }])
    const nativeId = await request({
      responseMode: 'native',
      canDismiss: true,
      questions: [{ id: 'required', question: 'Native callback question?' }],
    })
    assert.equal(await panel().getByRole('button', { name: 'Dismiss', exact: true }).count(), 0)
    await panel().getByRole('button', { name: 'Decline', exact: true }).click()
    await complete()
    assert.deepEqual(await responses(), [{ requestId: nativeId, accepted: false, answers: null }])
    checks.push(
      'Only dismissible message questions offer Dismiss; blocking callbacks offer Decline and send the explicit negative native response',
    )

    const uncertainRequest = {
      sessionId: 'uncertain-async',
      requestId: 'uncertain-async-reply',
      type: 'question',
      responseMode: 'message',
      canDismiss: true,
      questions: [
        {
          id: 'followup',
          question: 'Which uncertain follow-up?',
          options: [{ label: 'Suggested follow-up' }],
        },
      ],
    }
    await request(uncertainRequest)
    await panel()
      .getByRole('radio', { name: /^Other answer/ })
      .check()
    const uncertainAnswer = () =>
      panel().getByRole('textbox', {
        name: 'Your answer · Which uncertain follow-up?',
        exact: true,
      })
    const exactUncertainAnswer = '  Preserve this failed answer.\n'
    await uncertainAnswer().fill(exactUncertainAnswer)
    await page.evaluate(() => {
      window.rejectResponse = true
    })
    await send().click()
    await panel()
      .getByRole('alert')
      .filter({ hasText: 'The response was not delivered.' })
      .waitFor()
    await page.evaluate((event) => window.setQuestionRequest(event), {
      ...uncertainRequest,
      status: 'responding',
    })
    assert.equal(await uncertainAnswer().inputValue(), exactUncertainAnswer)
    assert.equal(await uncertainAnswer().isDisabled(), true)
    assert.equal(
      await panel().getByRole('radio', { name: 'Suggested follow-up', exact: true }).isDisabled(),
      true,
    )
    assert.equal(
      await panel().getByRole('button', { name: 'Sending…', exact: true }).isDisabled(),
      true,
    )
    const uncertainDismiss = () => panel().getByRole('button', { name: 'Dismiss', exact: true })
    assert.equal(await uncertainDismiss().isEnabled(), true)
    await page.evaluate(() => {
      window.rejectResponse = false
      window.holdResponse = true
    })
    await uncertainDismiss().evaluate((button) => {
      button.click()
      button.click()
    })
    await page.waitForFunction(() => window.responseCalls.length === 2)
    assert.equal(await uncertainDismiss().isDisabled(), true)
    assert.equal(await uncertainAnswer().inputValue(), exactUncertainAnswer)
    assert.deepEqual(await responses(), [
      {
        requestId: uncertainRequest.requestId,
        accepted: true,
        answers: { followup: [exactUncertainAnswer] },
      },
      { requestId: uncertainRequest.requestId, accepted: false, answers: null },
    ])
    await page.evaluate(() => {
      window.holdResponse = false
      window.releaseResponse()
    })
    await complete()
    assert.equal(await uncertainAnswer().count(), 0)
    assert.equal(
      await panel()
        .getByRole('radio', { name: /^Other answer/ })
        .isChecked(),
      false,
    )
    assert.equal((await responses()).length, 2)
    await request({
      responseMode: 'native',
      canDismiss: true,
      status: 'responding',
      questions: [{ id: 'native-uncertain', question: 'Uncertain native callback?' }],
    })
    assert.equal(await panel().getByRole('button', { name: 'Dismiss', exact: true }).count(), 0)
    const uncertainDecline = panel().getByRole('button', { name: 'Decline', exact: true })
    assert.equal(await uncertainDecline.isDisabled(), true)
    assert.equal(
      await panel().getByRole('button', { name: 'Sending…', exact: true }).isDisabled(),
      true,
    )
    await uncertainDecline.evaluate((button) => button.click())
    assert.deepEqual(await responses(), [])
    checks.push(
      'An uncertain async answer keeps its exact draft and duplicate fence while allowing one acknowledged Dismiss; responding native callbacks never gain a local dismissal',
    )

    await request({
      questions: [
        {
          id: 'layout',
          question: 'Which layout?',
          options: [
            { label: 'Current layout', description: 'Keep the existing project structure.' },
            { label: 'New layout', description: 'Create a separate implementation.' },
          ],
          isOther: false,
        },
      ],
    })
    await page.setViewportSize({ width: 390, height: 844 })
    await page.screenshot({ path: join(output, 'narrow-question-panel.png'), fullPage: true })
    assert.equal(
      await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth),
      true,
    )
    await panel().getByRole('button', { name: 'Collapse questions', exact: true }).click()
    await panel().getByRole('button', { name: 'Expand questions', exact: true }).click()
    assert.equal(
      await panel()
        .getByRole('radio', { name: /Current layout/ })
        .isVisible(),
      true,
    )
    checks.push(
      'The question panel remains usable at a narrow width and can be collapsed and expanded',
    )

    measurements.push({
      fixture: 'isolated PendingQuestionPanel',
      checks: checks.length,
      providerCalls: 0,
      note: 'Functional fixture only; no authenticated upstream run or before/after performance claim.',
    })
    assert.deepEqual(errors, [])
    await writeFile(
      join(output, 'checks.json'),
      JSON.stringify({ checks, errors, measurements }, null, 2) + '\n',
    )
    console.log(JSON.stringify({ passed: checks.length, checks, errors, measurements }, null, 2))
  } catch (error) {
    if (page)
      await page.screenshot({ path: join(output, 'failure.png'), fullPage: true }).catch(() => {})
    await writeFile(
      join(output, 'failure.json'),
      JSON.stringify({ message: String(error), checks, errors }, null, 2) + '\n',
    ).catch(() => {})
    throw error
  } finally {
    if (browser) await browser.close()
    if (server) await new Promise((resolve) => server.close(resolve))
    await rm(directory, { recursive: true, force: true })
  }
}

run().catch((error) => {
  console.error(error)
  process.exitCode = 1
})
