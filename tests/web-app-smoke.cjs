#!/usr/bin/env node
const assert = require('node:assert/strict')
const { mkdir } = require('node:fs/promises')
const { resolve } = require('node:path')
const { chromium } = require('playwright')

async function main() {
  const url =
    process.argv.find((argument) => argument.startsWith('--url='))?.slice(6) ||
    process.env.LIFE_WEB_URL ||
    'http://localhost:5173/life/'
  const artifacts = resolve('output/playwright/web-app')
  await mkdir(artifacts, { recursive: true })
  const browser = await chromium.launch({ headless: true, args: ['--no-sandbox'] })
  const context = await browser.newContext({ viewport: { width: 1440, height: 1000 } })
  await context.addInitScript(() => {
    if (!localStorage.getItem('life.research.selected-scope.v2')) {
      const key = JSON.stringify(['research', 'life-browser-preview', '/browser'])
      localStorage.setItem('life.research.selected-scope.v2', key)
      localStorage.setItem(
        'life.research.files.v2:' + key,
        JSON.stringify({
          scope: {
            profileId: 'life-browser-preview',
            workspace: '/browser',
            host: 'browser.local',
          },
          record: { goals: [] },
          pending: [],
        }),
      )
    }
    if (!localStorage.getItem('relay.threads.v1')) {
      localStorage.setItem(
        'relay.threads.v1',
        JSON.stringify([
          { id: 'old-preview-thread', profileId: 'life-browser-preview', messages: [] },
        ]),
      )
      localStorage.setItem('life.active-thread.v1', 'old-preview-thread')
      sessionStorage.setItem('life.web.events.cursor', '900000000')
    }
  })
  let page = await context.newPage()
  const errors = []
  const checks = []
  page.on('pageerror', (error) => errors.push(error.message))
  page.on('requestfailed', (request) =>
    console.error('Request failed:', request.url(), request.failure()?.errorText),
  )
  try {
    await page.goto(url)
    await page.getByRole('textbox', { name: 'Message your coding agent', exact: true }).waitFor()
    const state = await page.evaluate(() => window.relay.connection.state())
    assert.equal(state.status, 'connected')
    assert.equal(state.profile.id, 'life-web-local')
    assert.notEqual(state.codex, 'missing')
    assert.equal(await page.locator('.life-browser-banner').count(), 0)
    assert.equal((await page.locator('.app-shell').boundingBox()).y, 0)
    assert.ok(await page.evaluate(() => localStorage.getItem('life.web.preview.threads.v1')))
    assert.ok(
      await page.evaluate(
        () => !localStorage.getItem('relay.threads.v1')?.includes('old-preview-thread'),
      ),
    )
    checks.push('Web app opens connected to the real local workspace without a preview header')
    await page.getByRole('button', { name: 'Research', exact: true }).click()
    await page.waitForFunction(
      (expected) => localStorage.getItem('life.research.selected-scope.v2') === expected,
      JSON.stringify(['research', state.profile.id, state.home.replace(/\/+$/, '') || '/']),
    )
    assert.ok(
      await page.evaluate(() =>
        localStorage.getItem(
          'life.research.files.v2:' +
            JSON.stringify(['research', 'life-browser-preview', '/browser']),
        ),
      ),
    )
    await page.getByRole('button', { name: 'Agents', exact: true }).click()
    checks.push(
      'Research switches from a stale preview scope to the connected machine while preserving the old cache',
    )
    await page.evaluate(async () => {
      const threads = await window.relay.conversations.load()
      await window.relay.conversations.save(threads)
    })
    checks.push('History saves successfully when the browser starts with an obsolete event cursor')
    const files = await page.evaluate(() => window.relay.files.list())
    assert.ok(files.some((entry) => entry.name === 'package.json'))
    const contents = await page.evaluate(() => window.relay.files.read('package.json'))
    assert.equal(JSON.parse(contents).name, 'life-desktop')
    const git = await page.evaluate(() => window.relay.files.git())
    assert.ok(git.branch)
    checks.push('Project files and Git are read from the real server filesystem')
    await page.evaluate(async () => {
      window.webAppTerminalOutput = ''
      window.webAppTerminalOff = window.relay.onTerminal((data) => {
        window.webAppTerminalOutput += data
      })
      await window.relay.terminal.open()
      window.relay.terminal.write("printf '__LIFE_WEB_%s__\\n' 'TERMINAL_OK'\r")
    })
    await page
      .waitForFunction(() => window.webAppTerminalOutput.includes('__LIFE_WEB_TERMINAL_OK__'))
      .catch(async (error) => {
        console.error(
          'Terminal output length:',
          await page.evaluate(() => window.webAppTerminalOutput.length),
        )
        console.error(
          'Event cursor:',
          await page.evaluate(() => sessionStorage.getItem('life.web.events.cursor')),
        )
        throw error
      })
    await page.evaluate(async () => {
      await window.relay.terminal.close()
      window.webAppTerminalOff()
    })
    checks.push('Browser terminal runs a real interactive shell')
    const models = await page.evaluate(() => window.relay.agent.models('codex'))
    assert.ok(models.length > 1)
    checks.push('Codex model choices come from the installed provider')
    if (process.env.LIFE_WEB_REAL_AGENTS === 'true' || process.argv.includes('--real-agents')) {
      await page.getByRole('combobox', { name: /^Agent permission mode:/ }).click()
      await page.getByRole('option', { name: 'Read-only', exact: true }).click()
      const composer = page.getByRole('textbox', { name: 'Message your coding agent', exact: true })
      const marker = `LIFE_WEB_CODEX_OK_${Date.now()}`
      const followupMarker = marker.replace('CODEX', 'FOLLOWUP')
      const prompt = `Reply with exactly ${marker}. Do not call tools or change any files.`
      await composer.fill(prompt)
      await composer.press('Enter')
      await page.waitForFunction(
        (marker) => {
          const threads = JSON.parse(localStorage.getItem('relay.threads.v1') || '[]')
          return threads.some(
            (thread) =>
              !thread.busy &&
              thread.messages.some(
                (message) => message.role === 'assistant' && message.text.includes(marker),
              ),
          )
        },
        marker,
        { timeout: 180000 },
      )
      const thread = await page.evaluate(
        (prompt) =>
          JSON.parse(localStorage.getItem('relay.threads.v1')).find((thread) =>
            thread.messages.some((message) => message.role === 'user' && message.text === prompt),
          ),
        prompt,
      )
      assert.ok(thread.remoteId)
      assert.equal(thread.mode, 'read-only')
      const followup = `Reply with exactly ${followupMarker}. Do not call tools or change any files.`
      await composer.fill(followup)
      await composer.press('Enter')
      await page.waitForFunction(
        ({ id, marker }) => {
          const thread = JSON.parse(localStorage.getItem('relay.threads.v1') || '[]').find(
            (item) => item.id === id,
          )
          return (
            thread?.busy &&
            thread.messages.some(
              (message) => message.role === 'user' && message.text.includes(marker),
            )
          )
        },
        { id: thread.id, marker: followupMarker },
      )
      await page.reload()
      await page.getByRole('textbox', { name: 'Message your coding agent', exact: true }).waitFor()
      await context.close()
      const freshContext = await browser.newContext({ viewport: { width: 1440, height: 1000 } })
      page = await freshContext.newPage()
      page.on('pageerror', (error) => errors.push(error.message))
      await page.goto(url)
      await page.getByRole('textbox', { name: 'Message your coding agent', exact: true }).waitFor()
      await page.waitForFunction(
        ({ id, marker }) => {
          const thread = JSON.parse(localStorage.getItem('relay.threads.v1') || '[]').find(
            (item) => item.id === id,
          )
          return (
            thread &&
            !thread.busy &&
            thread.messages.some(
              (message) => message.role === 'assistant' && message.text.includes(marker),
            )
          )
        },
        { id: thread.id, marker: followupMarker },
        { timeout: 180000 },
      )
      checks.push(
        'Real Codex message and follow-up complete in the same conversation across a reload and a fresh browser',
      )
      await page.reload()
      await page.getByRole('textbox', { name: 'Message your coding agent', exact: true }).waitFor()
      const history = await page.evaluate(() => window.relay.conversations.load())
      assert.ok(history.some((item) => item.id === thread.id && item.remoteId === thread.remoteId))
      checks.push('Completed conversations persist on the server and survive a browser reload')
    }
    await page.screenshot({ path: resolve(artifacts, 'workspace.png') })
    await page.setViewportSize({ width: 390, height: 844 })
    assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1))
    checks.push('Mobile layout stays inside the viewport')
    assert.deepEqual(errors, [])
    console.log(JSON.stringify({ url, passed: checks.length, checks, errors, artifacts }, null, 2))
  } catch (error) {
    await page.screenshot({ path: resolve(artifacts, 'failure.png') }).catch(() => {})
    console.error(
      await page
        .locator('body')
        .innerText()
        .catch(() => ''),
    )
    throw error
  } finally {
    await browser.close()
  }
}
main().catch((error) => {
  console.error(error)
  process.exitCode = 1
})
