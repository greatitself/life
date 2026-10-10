#!/usr/bin/env node
// Exercise the shipped native approval form against both providers' response semantics.
const assert = require('node:assert/strict')
const { createServer } = require('node:http')
const { mkdtemp, mkdir, readFile, writeFile, rm } = require('node:fs/promises')
const { join, resolve } = require('node:path')
const { tmpdir } = require('node:os')
const { build } = require('esbuild')
const { chromium } = require('playwright')

async function run() {
  const directory = await mkdtemp(join(tmpdir(), 'life-provider-requests-'))
  const output = resolve(__dirname, '../output/playwright/provider-requests')
  await mkdir(output, { recursive: true })
  const checks = []
  const errors = []
  let browser
  let server
  try {
    await build({
      stdin: {
        resolveDir: resolve(__dirname, '..'),
        sourcefile: 'provider-requests-fixture.tsx',
        loader: 'tsx',
        contents: `
          import React, { useState } from 'react'
          import { createRoot } from 'react-dom/client'
          import { ApprovalCard } from './src/renderer/components/MessageView'
          import './src/renderer/styles.css'
          let requestNumber = 0
          window.responseCalls = []
          window.rejectResponse = false
          window.holdResponse = false
          function Fixture() {
            const [event, setEvent] = useState({ sessionId: 'fixture', requestId: 'initial', type: 'question', questions: [{ id: 'approach', question: 'Which approach?', options: [{ label: 'Inspect', description: 'Read the source first.' }, { label: 'Run', description: 'Execute the current tests.' }] }] })
            window.setRequest = (request) => { window.responseCalls = []; setEvent({ sessionId: 'fixture', requestId: 'request-' + ++requestNumber, ...request }) }
            return <main className="request-fixture" style={{ maxWidth: 800, margin: '0 auto', padding: 28 }}>
              <h1>Provider requests</h1>
              <ApprovalCard event={event} onRespond={async (accepted, answers) => {
                window.responseCalls.push({ accepted, answers: answers === undefined ? null : structuredClone(answers) })
                if (window.holdResponse) await new Promise(resolve => window.releaseResponse = resolve)
                if (window.rejectResponse) throw new Error('The response was not delivered. Reconnect and retry.')
              }} />
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
        const file = ['fixture.js', 'fixture.css'].find((name) => request.url === '/' + name)
        response.setHeader(
          'Content-Type',
          file?.endsWith('.js') ? 'text/javascript' : file ? 'text/css' : 'text/html',
        )
        response.end(
          file
            ? await readFile(join(directory, file))
            : '<!doctype html><html lang="en"><head><meta charset="utf-8"><title>Life provider requests</title><link rel="stylesheet" href="/fixture.css"><style>html,body,#root{height:auto;min-height:100%;overflow:visible}body{background:#101112}.request-fixture{color:var(--text)}</style></head><body><div id="root"></div><script src="/fixture.js"></script></body></html>',
        )
      } catch (error) {
        response.statusCode = 500
        response.end(String(error))
      }
    })
    await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
    const origin = 'http://127.0.0.1:' + server.address().port
    browser = await chromium.launch({ headless: true })
    const context = await browser.newContext({ viewport: { width: 1100, height: 1000 } })
    const page = await context.newPage()
    page.on('pageerror', (error) => errors.push(error.message))
    page.on('console', (event) => {
      if (event.type() === 'error') errors.push(event.text())
    })
    await page.goto(origin)
    await page.waitForLoadState('networkidle')
    const send = () => page.getByRole('button', { name: 'Send answers', exact: true })
    const responses = () => page.evaluate(() => window.responseCalls)
    const request = async (event) => {
      await page.evaluate((event) => window.setRequest(event), event)
      await page.waitForFunction(
        () => document.querySelector('.approval-card .badge').textContent === 'Waiting for you',
      )
    }

    assert.equal(await send().isDisabled(), true)
    const approach = page.getByRole('combobox', { name: /Which approach/ })
    await approach.selectOption({ label: 'Other answer' })
    const exactAnswer = '  Keep my custom approach unchanged.\n'
    await page.getByRole('textbox', { name: /Your answer · Which approach/ }).fill(exactAnswer)
    await send().click()
    await page.getByRole('button', { name: 'Response sent', exact: true }).waitFor()
    assert.deepEqual(await responses(), [{ accepted: true, answers: { approach: [exactAnswer] } }])
    checks.push('Codex native questions offer an exact custom response alongside suggested choices')

    await request({
      type: 'question',
      questions: [
        {
          id: 'checks',
          header: 'Checks',
          question: 'Which checks should run?',
          multiple: true,
          options: [
            { label: 'Typecheck', description: 'Validate TypeScript.' },
            { label: 'Desktop', description: 'Run Electron.' },
          ],
        },
      ],
    })
    await page.getByRole('checkbox', { name: /Typecheck/ }).check()
    await page.getByRole('checkbox', { name: /Desktop/ }).check()
    await page.getByRole('checkbox', { name: 'Other answer', exact: true }).check()
    await page.getByRole('textbox', { name: /Additional answer/ }).fill('Also verify reconnects')
    await page.screenshot({ path: join(output, 'multiple-choice-request.png'), fullPage: true })
    await send().click()
    await page.getByRole('button', { name: 'Response sent', exact: true }).waitFor()
    assert.deepEqual(await responses(), [
      { accepted: true, answers: { checks: ['Typecheck', 'Desktop', 'Also verify reconnects'] } },
    ])
    checks.push(
      'Claude multiple-choice questions retain every selected value and the additional custom answer',
    )

    await request({
      type: 'question',
      questions: [
        { id: 'attempts', question: 'Attempt count?', inputType: 'integer', isOther: false },
        { id: 'ratio', question: 'Ratio?', inputType: 'number', isOther: false },
        { id: 'enabled', question: 'Enable logging?', inputType: 'boolean', isOther: false },
        {
          id: 'region',
          question: 'Deployment region?',
          isOther: false,
          options: [
            { label: 'Europe', value: 'eu-west-1' },
            { label: 'No region', value: '' },
          ],
        },
        { id: 'token', question: 'Private token?', isSecret: true },
        { id: 'notes', question: 'Optional notes?', required: false },
      ],
    })
    const attempts = page.getByRole('spinbutton', { name: /Attempt count/ })
    await attempts.fill('3.5')
    assert.equal(await send().isDisabled(), true)
    await page.getByRole('alert').filter({ hasText: 'Enter a whole number' }).waitFor()
    await attempts.fill('4')
    await page.getByRole('spinbutton', { name: /Ratio/ }).fill('-0.125')
    await page.getByRole('combobox', { name: /Enable logging/ }).selectOption('false')
    await page.getByRole('combobox', { name: /Deployment region/ }).selectOption('eu-west-1')
    const token = page.getByLabel('Private token?', { exact: true })
    assert.equal(await token.getAttribute('type'), 'password')
    await token.fill('exact-secret-value')
    assert.equal(await page.getByRole('option', { name: 'Other answer', exact: true }).count(), 0)
    assert.equal(await send().isEnabled(), true)
    await page.screenshot({ path: join(output, 'typed-form-request.png'), fullPage: true })
    checks.push(
      'MCP integer, number, boolean, enum and secret fields validate without inventing defaults or unsupported Other answers',
    )

    await page.evaluate(() => {
      window.holdResponse = true
      window.rejectResponse = true
    })
    await send().evaluate((button) => {
      button.click()
      button.click()
    })
    await page.getByRole('button', { name: 'Sending…', exact: true }).waitFor()
    assert.equal((await responses()).length, 1)
    assert.equal(await attempts.isDisabled(), true)
    assert.equal(
      await page.getByRole('button', { name: 'Decline', exact: true }).isDisabled(),
      true,
    )
    await page.evaluate(() => window.releaseResponse())
    await page.getByRole('alert').filter({ hasText: 'The response was not delivered.' }).waitFor()
    assert.equal(await attempts.inputValue(), '4')
    assert.equal(await token.inputValue(), 'exact-secret-value')
    assert.equal(await send().isEnabled(), true)
    await page.evaluate(() => {
      window.holdResponse = false
      window.rejectResponse = false
    })
    await send().click()
    await page.getByRole('button', { name: 'Response sent', exact: true }).waitFor()
    assert.deepEqual((await responses())[1], {
      accepted: true,
      answers: {
        attempts: ['4'],
        ratio: ['-0.125'],
        enabled: ['false'],
        region: ['eu-west-1'],
        token: ['exact-secret-value'],
      },
    })
    assert.equal(await page.getByRole('alert').count(), 0)
    checks.push(
      'Responses cannot be submitted twice while pending; failed delivery preserves fields and supports exact retry with optional values omitted',
    )

    await request({
      type: 'question',
      questions: [
        {
          id: 'region',
          question: 'Choose an empty enum value?',
          isOther: false,
          options: [
            { label: 'None', value: '' },
            { label: 'Native placeholder-like value', value: '__life_empty__' },
          ],
        },
      ],
    })
    assert.equal(await send().isDisabled(), true)
    await page
      .getByRole('combobox', { name: /Choose an empty enum value/ })
      .selectOption({ label: 'None' })
    await send().click()
    await page.getByRole('button', { name: 'Response sent', exact: true }).waitFor()
    assert.deepEqual(await responses(), [{ accepted: true, answers: { region: [''] } }])
    checks.push(
      'An explicitly chosen empty enum value is distinct from an unanswered required question',
    )

    await request({
      type: 'question',
      questions: [
        { id: 'text', question: 'Required empty string?', allowEmpty: true },
        {
          id: 'list',
          question: 'Required empty list?',
          multiple: true,
          allowEmpty: true,
          isOther: false,
          options: [{ label: 'Check' }],
        },
      ],
    })
    assert.equal(await send().isDisabled(), true)
    await page.getByRole('checkbox', { name: /Use an empty answer/ }).check()
    assert.equal(await send().isDisabled(), true)
    await page.getByRole('checkbox', { name: /Select none/ }).check()
    await send().click()
    await page.getByRole('button', { name: 'Response sent', exact: true }).waitFor()
    assert.deepEqual(await responses(), [{ accepted: true, answers: { text: [''], list: [] } }])
    checks.push(
      'Required MCP fields that permit empty strings or lists require an explicit empty answer, rather than an invented default',
    )

    await request({
      type: 'question',
      questions: [{ id: 'optional', question: 'Optional response?', required: false }],
    })
    assert.equal(await send().isEnabled(), true)
    await send().click()
    await page.getByRole('button', { name: 'Response sent', exact: true }).waitFor()
    assert.deepEqual(await responses(), [{ accepted: true, answers: {} }])
    await request({
      type: 'question',
      questions: [{ id: 'required', question: 'Required response?' }],
    })
    await page.getByRole('button', { name: 'Decline', exact: true }).click()
    await page.getByRole('button', { name: 'Response sent', exact: true }).waitFor()
    assert.deepEqual(await responses(), [{ accepted: false, answers: null }])
    checks.push(
      'Optional-only forms can submit no values and required questions can be declined without fabricated answers',
    )

    await request({
      type: 'approval',
      title: 'Complete provider authentication',
      details: {
        method: 'url',
        url: origin + '/provider-auth',
        message: 'Authorize the requested service.',
      },
    })
    const confirm = page.getByRole('button', { name: 'Confirm completed', exact: true })
    assert.equal(await confirm.isDisabled(), true)
    const link = page.getByRole('link', { name: /Open requested link/ })
    assert.equal(await link.getAttribute('href'), origin + '/provider-auth')
    assert.equal(await link.getAttribute('rel'), 'noopener noreferrer')
    const popup = page.waitForEvent('popup')
    await link.click()
    const opened = await popup
    await opened.waitForLoadState('domcontentloaded')
    await opened.close()
    assert.deepEqual(await responses(), [])
    assert.equal(await confirm.isDisabled(), true)
    await page
      .getByRole('checkbox', { name: 'I completed this request in the browser', exact: true })
      .check()
    await page.screenshot({ path: join(output, 'external-request.png'), fullPage: true })
    await confirm.click()
    await page.getByRole('button', { name: 'Response sent', exact: true }).waitFor()
    assert.deepEqual(await responses(), [{ accepted: true, answers: null }])
    checks.push(
      'URL elicitation opens a safe external link without approving; completion requires a separate explicit confirmation',
    )

    await request({ type: 'approval', details: { method: 'url', url: 'javascript:alert(1)' } })
    assert.equal(await page.getByRole('link', { name: /Open requested link/ }).count(), 0)
    assert.equal(
      await page.getByRole('button', { name: 'Confirm completed', exact: true }).isDisabled(),
      true,
    )
    assert.equal(await page.getByRole('button', { name: 'Decline', exact: true }).isEnabled(), true)
    await page.getByRole('alert').filter({ hasText: 'valid HTTP or HTTPS link' }).waitFor()
    checks.push('Unsupported provider URL schemes cannot launch or be confirmed')

    await request({
      type: 'approval',
      title: 'Allow requested access?',
      details: {
        method: 'item/permissions/requestApproval',
        reason: 'Build the report',
        cwd: '/workspace/research',
        command: 'npm run build',
        permissions: {
          fileSystem: { read: ['/workspace/source'], write: ['/workspace/output'] },
          network: { enabled: true },
        },
      },
    })
    for (const text of [
      'Reason',
      'Build the report',
      'Working directory',
      '/workspace/research',
      'Command',
      'npm run build',
      'Requested permissions',
    ])
      assert.equal(await page.getByText(text, { exact: true }).isVisible(), true)
    const permissionText = await page.locator('.thread-approval-details').textContent()
    assert.match(permissionText, /Read: \/workspace\/source/)
    assert.match(permissionText, /Write: \/workspace\/output/)
    assert.match(permissionText, /Network: Enabled: true/)
    await page.screenshot({ path: join(output, 'permission-request.png'), fullPage: true })
    await page.getByRole('button', { name: 'Allow for this turn', exact: true }).click()
    await page.getByRole('button', { name: 'Response sent', exact: true }).waitFor()
    assert.deepEqual(await responses(), [{ accepted: true, answers: null }])
    checks.push(
      'Permission requests accurately display reason, cwd, command, read/write paths and network access with the actual turn grant scope',
    )

    assert.deepEqual(errors, [])
    await writeFile(join(output, 'checks.json'), JSON.stringify({ checks, errors }, null, 2) + '\n')
    console.log(JSON.stringify({ passed: checks.length, checks, errors }, null, 2))
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
