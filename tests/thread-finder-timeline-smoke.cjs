#!/usr/bin/env node
// Exercise the finder with real lazy timeline activity, rather than mounted fake details.
const assert = require('node:assert/strict')
const { createServer } = require('node:http')
const { mkdtemp, mkdir, readFile, writeFile, rm } = require('node:fs/promises')
const { join, resolve } = require('node:path')
const { tmpdir } = require('node:os')
const { build } = require('esbuild')
const { chromium } = require('playwright')

async function run() {
  const directory = await mkdtemp(join(tmpdir(), 'life-finder-timeline-'))
  const output = resolve(__dirname, '../output/playwright')
  await mkdir(output, { recursive: true })
  const checks = []
  const errors = []
  const mountedAnchors = {}
  let browser
  let server
  try {
    await build({
      stdin: {
        resolveDir: resolve(__dirname, '..'),
        sourcefile: 'thread-finder-timeline-fixture.tsx',
        loader: 'tsx',
        contents: `
          import React, { useState } from 'react'
          import { createRoot } from 'react-dom/client'
          import { ThreadTimeline } from './src/renderer/components/ThreadTimeline'
          import { ThreadMessageNavigator } from './src/renderer/components/ThreadMessageNavigator'
          import { previewNavigableMessages } from './src/renderer/thread-presentation'
          import { useConversationScroll } from './src/renderer/conversation-scroll'
          import './src/renderer/styles.css'
          const base = { turn: 1, createdAt: Date.now() - 10000 }
          const reasoningId = '1:reasoning"]\\\\unsafe'
          const exactOutput = 'Exact settled output\\r\\n<original>line</original>\\n'
          const messages = [
            { ...base, id: '1:user', role: 'user', text: 'Inspect every original provider output.', finishStatus: 'completed', finishedAt: Date.now() },
            { ...base, id: reasoningId, role: 'assistant', kind: 'reasoning', text: 'Hidden completed reasoning needle' },
            { ...base, id: '1:progress', role: 'assistant', phase: 'commentary', text: 'Hidden completed progress needle' },
            { ...base, id: '1:tool', role: 'tool', title: 'exec_command', status: 'completed', text: exactOutput },
            { ...base, id: '1:final', role: 'assistant', phase: 'final_answer', text: 'Visible final response' },
            { ...base, id: '1:later-reasoning', role: 'assistant', kind: 'reasoning', text: 'Hidden later reasoning needle' },
          ]
          window.timelineFixture = { reasoningId, exactOutput }
          function Fixture() {
            const [mode, setMode] = useState('completed')
            const [jumps, setJumps] = useState(0)
            const thread = { id: mode, profileId: 'fixture-machine', workspace: '/research/life', provider: 'codex', title: 'Finder timeline', messages, busy: mode === 'live', model: 'model', mode: 'review', updatedAt: base.createdAt, turn: 1, pending: [], turnStatus: mode === 'live' ? 'running' : 'completed' }
            const scroll = useConversationScroll(mode, { messages })
            return <main className="app-shell life-refined-layout" style={{ display: 'block', padding: 30 }}>
              <button onClick={() => setMode('live')}>Show live timeline</button>
              <button onClick={() => setMode('completed')}>Show completed timeline</button>
              <p data-jumps={jumps} data-following={String(scroll.stickToBottom)}>Timeline finder verification</p>
              <div style={{ position: 'relative', height: 500 }}>
                <ThreadMessageNavigator key={mode} messages={previewNavigableMessages(thread)} searchMessages={thread.messages} conversation={scroll.conversation} onJump={() => { setJumps(jumps + 1); scroll.setStickToBottom(false) }} />
                <div data-viewport ref={scroll.viewportRef} style={{ position: 'absolute', left: 50, width: 720, height: 430, overflow: 'auto' }}>
                  <ThreadTimeline thread={thread} />
                  <div style={{ height: 650 }} aria-hidden="true" />
                </div>
              </div>
            </main>
          }
          createRoot(document.getElementById('root')).render(<React.StrictMode><Fixture /></React.StrictMode>)
        `,
      },
      bundle: true,
      jsx: 'automatic',
      outfile: join(directory, 'fixture.js'),
      define: { 'process.env.NODE_ENV': '"development"' },
      loader: { '.woff2': 'dataurl', '.woff': 'dataurl' },
      logLevel: 'silent',
    })
    server = createServer(async (request, response) => {
      const file =
        request.url === '/fixture.js'
          ? 'fixture.js'
          : request.url === '/fixture.css'
            ? 'fixture.css'
            : undefined
      response.setHeader(
        'Content-Type',
        file?.endsWith('.js') ? 'text/javascript' : file ? 'text/css' : 'text/html',
      )
      response.end(
        file
          ? await readFile(join(directory, file))
          : '<!doctype html><html lang="en"><head><title>Life lazy timeline finder</title><link rel="stylesheet" href="/fixture.css"></head><body><div id="root"></div><script src="/fixture.js"></script></body></html>',
      )
    })
    await new Promise((ready) => server.listen(0, '127.0.0.1', ready))
    browser = await chromium.launch({ headless: true })
    const page = await browser.newPage({
      viewport: { width: 1100, height: 800 },
      permissions: ['clipboard-read', 'clipboard-write'],
    })
    page.on('pageerror', (error) => errors.push(error.message))
    await page.addInitScript(() => {
      window.jumpObserverProbe = { active: 0 }
      const NativeMutationObserver = window.MutationObserver
      window.MutationObserver = class extends NativeMutationObserver {
        tracked = false
        observe(target, options) {
          if (
            !this.tracked &&
            target instanceof HTMLElement &&
            target.hasAttribute('data-viewport') &&
            options.childList &&
            options.subtree &&
            !options.attributes
          ) {
            this.tracked = true
            window.jumpObserverProbe.active++
          }
          return super.observe(target, options)
        }
        disconnect() {
          if (this.tracked) {
            this.tracked = false
            window.jumpObserverProbe.active--
          }
          return super.disconnect()
        }
      }
    })
    await page.goto('http://127.0.0.1:' + server.address().port)
    await page.waitForLoadState('networkidle')
    const viewport = page.locator('[data-viewport]')
    const fixture = await page.evaluate(() => window.timelineFixture)
    const mounted = (id) =>
      viewport
        .locator('[data-message-id]')
        .evaluateAll((nodes, id) => nodes.some((node) => node.dataset.messageId === id), id)
    const finder = page.getByRole('dialog', { name: 'Find in this thread', exact: true })
    const search = finder.getByRole('textbox', {
      name: 'Search messages in this thread',
      exact: true,
    })
    const settle = () =>
      page.evaluate(
        () =>
          new Promise((resolve) =>
            requestAnimationFrame(() =>
              requestAnimationFrame(() => requestAnimationFrame(resolve)),
            ),
          ),
      )
    const findAndJump = async (text, id, jumps) => {
      await page.keyboard.press('Control+f')
      await finder.waitFor()
      await search.fill(text)
      await page.waitForFunction(
        () => document.querySelector('.thread-finder-count')?.textContent === '1 message',
        undefined,
        { timeout: 5000 },
      )
      await finder.getByRole('button', { name: 'Agent reply ' + text, exact: true }).click()
      await finder.waitFor({ state: 'hidden', timeout: 5000 })
      await page.locator('[data-jumps="' + jumps + '"]').waitFor()
      await settle()
      assert.equal(
        await page.evaluate(() => document.activeElement?.getAttribute('data-message-id')),
        id,
      )
      const location = await viewport.evaluate((root, id) => {
        const target = Array.from(root.querySelectorAll('[data-message-id]')).find(
          (element) => element.dataset.messageId === id,
        )
        const bounds = root.getBoundingClientRect()
        const rect = target.getBoundingClientRect()
        return {
          offset: rect.top - bounds.top,
          visible: rect.bottom > bounds.top && rect.top < bounds.bottom,
        }
      }, id)
      assert.equal(location.visible, true)
      assert.ok(
        Math.abs(location.offset - 20) <= 1,
        'Jump aligns the exact lazy anchor after mount: ' + JSON.stringify(location),
      )
      assert.equal(await page.locator('[data-following]').getAttribute('data-following'), 'false')
      assert.equal(await page.evaluate(() => window.jumpObserverProbe.active), 0)
    }

    await viewport.locator('[data-message-id="1:final"]').waitFor()
    assert.equal(await viewport.locator('.thread-turn-disclosure').count(), 2)
    assert.equal(await viewport.locator('.thread-turn-disclosure[open]').count(), 0)
    mountedAnchors.completedClosed = await viewport.locator('[data-message-id]').count()
    assert.equal(mountedAnchors.completedClosed, 2)
    assert.equal(await mounted(fixture.reasoningId), false)
    await findAndJump('Hidden completed reasoning needle', fixture.reasoningId, 1)
    assert.equal(await viewport.locator('.thread-turn-disclosure[open]').count(), 1)
    mountedAnchors.completedMatchingOpen = await viewport.locator('[data-message-id]').count()
    assert.equal(mountedAnchors.completedMatchingOpen, 5)
    assert.equal(await mounted('1:later-reasoning'), false)
    checks.push(
      'Searching the full completed history opens only the matching lazy disclosure, then focuses and scrolls its exact unsafe-ID reasoning anchor',
    )

    await page.keyboard.press('Control+f')
    await finder.waitFor()
    assert.equal(await search.inputValue(), '')
    await page.keyboard.press('Escape')
    await finder.waitFor({ state: 'hidden' })
    await page.waitForFunction(
      (id) => document.activeElement?.getAttribute('data-message-id') === id,
      fixture.reasoningId,
    )
    assert.equal(
      await page.evaluate(() => document.activeElement?.getAttribute('data-message-id')),
      fixture.reasoningId,
    )
    const selected = await viewport.evaluate((root, id) => {
      const target = Array.from(root.querySelectorAll('[data-message-id]')).find(
        (element) => element.dataset.messageId === id,
      )
      const range = document.createRange()
      range.selectNodeContents(target.querySelector('.markdown'))
      const selection = window.getSelection()
      selection.removeAllRanges()
      selection.addRange(range)
      return selection.toString()
    }, fixture.reasoningId)
    assert.equal(selected, 'Hidden completed reasoning needle')
    assert.equal(
      await page.evaluate(() =>
        window.find('Hidden completed reasoning needle', false, false, true),
      ),
      true,
    )
    await viewport
      .locator('[data-message-id="1:tool"]')
      .getByRole('button', { name: 'Copy output', exact: true })
      .click()
    assert.equal(await page.evaluate(() => navigator.clipboard.readText()), fixture.exactOutput)
    checks.push(
      'Reopening clears the query, closing restores exact focus, and revealed content keeps native selection, native Find and exact output copying',
    )

    await viewport.locator('.thread-turn-disclosure[open] > summary').click()
    await page.waitForFunction(
      () =>
        !Array.from(document.querySelectorAll('[data-message-id]')).some(
          (element) => element.dataset.messageId === window.timelineFixture.reasoningId,
        ),
    )
    await findAndJump('Hidden completed progress needle', '1:progress', 2)
    await findAndJump('Hidden later reasoning needle', '1:later-reasoning', 3)
    assert.equal(await viewport.locator('.thread-turn-disclosure[open]').count(), 2)
    mountedAnchors.completedAllOpen = await viewport.locator('[data-message-id]').count()
    assert.equal(mountedAnchors.completedAllOpen, 6)
    assert.equal(await viewport.locator('[data-message-id="1:final"]').count(), 1)
    checks.push(
      'A manually collapsed disclosure can be revealed again, later activity remains searchable, and repeated jumps use the latest inline callback without duplicating the final reply',
    )

    await page.getByRole('button', { name: 'Show live timeline', exact: true }).click()
    await viewport.locator('.thread-action-disclosure').first().waitFor()
    assert.equal(await mounted(fixture.reasoningId), false)
    mountedAnchors.liveClosed = await viewport.locator('[data-message-id]').count()
    assert.equal(mountedAnchors.liveClosed, 2)
    await findAndJump('Hidden completed reasoning needle', fixture.reasoningId, 4)
    assert.equal(await viewport.locator('.thread-action-disclosure[open]').count(), 1)
    mountedAnchors.liveMatchingOpen = await viewport.locator('[data-message-id]').count()
    assert.equal(mountedAnchors.liveMatchingOpen, 3)
    checks.push('The same finder reveals a lazy Agent activity disclosure in a live timeline')

    await page.getByRole('button', { name: 'Show completed timeline', exact: true }).click()
    await viewport.locator('.thread-turn-disclosure').first().waitFor()
    const preparePendingJump = async () => {
      await page.getByRole('button', { name: 'Show completed timeline', exact: true }).focus()
      await page.keyboard.press('Control+f')
      await finder.waitFor()
      await search.fill('Hidden completed reasoning needle')
      await page.waitForFunction(
        () => document.querySelector('.thread-finder-count')?.textContent === '1 message',
      )
    }
    const cancelPendingJump = async (action) => {
      const trace = await page.evaluate((action) => {
        document.querySelector('.thread-finder-results > button').click()
        const waiting = window.jumpObserverProbe.active
        if (action === 'close')
          document.querySelector('[aria-label="Close message finder"]').click()
        else if (action === 'query') {
          const input = document.querySelector('[aria-label="Search messages in this thread"]')
          Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set.call(
            input,
            'Visible final response',
          )
          input.dispatchEvent(new Event('input', { bubbles: true }))
        } else
          Array.from(document.querySelectorAll('button'))
            .find((button) => button.textContent === 'Show live timeline')
            .click()
        return { waiting, afterCancel: window.jumpObserverProbe.active }
      }, action)
      assert.equal(trace.waiting, 1)
      if (action !== 'unmount') assert.equal(trace.afterCancel, 0)
      await settle()
      assert.equal(await page.evaluate(() => window.jumpObserverProbe.active), 0)
    }
    await preparePendingJump()
    await cancelPendingJump('close')
    await finder.waitFor({ state: 'hidden' })
    await page.waitForFunction(
      () => document.activeElement?.textContent === 'Show completed timeline',
    )
    assert.equal(await mounted(fixture.reasoningId), true)
    await viewport.locator('.thread-turn-disclosure[open] > summary').click()
    await page.waitForFunction(
      () =>
        !Array.from(document.querySelectorAll('[data-message-id]')).some(
          (element) => element.dataset.messageId === window.timelineFixture.reasoningId,
        ),
    )

    await preparePendingJump()
    await cancelPendingJump('query')
    await finder
      .getByRole('button', { name: 'Agent reply Visible final response', exact: true })
      .waitFor()
    assert.equal(await search.evaluate((input) => input === document.activeElement), true)
    await page.keyboard.press('Escape')
    await finder.waitFor({ state: 'hidden' })
    await viewport.locator('.thread-turn-disclosure[open] > summary').click()
    await page.waitForFunction(
      () =>
        !Array.from(document.querySelectorAll('[data-message-id]')).some(
          (element) => element.dataset.messageId === window.timelineFixture.reasoningId,
        ),
    )

    await preparePendingJump()
    await cancelPendingJump('unmount')
    await finder.waitFor({ state: 'hidden' })
    assert.equal(await mounted(fixture.reasoningId), false)
    await findAndJump('Hidden completed reasoning needle', fixture.reasoningId, 5)
    checks.push(
      'Pending lazy jumps cancel on close, query change and navigator unmount without observer leaks or stale focus, and a subsequent jump still succeeds',
    )

    assert.deepEqual(errors, [])
    const proof = {
      ok: true,
      mountedAnchors,
      checks,
      errors,
      completedAt: new Date().toISOString(),
    }
    await writeFile(
      join(output, 'thread-finder-timeline-proof.json'),
      JSON.stringify(proof, null, 2) + '\n',
    )
    await page.screenshot({ path: join(output, 'thread-finder-timeline.png') })
    console.log(JSON.stringify(proof, null, 2))
  } finally {
    await browser?.close()
    if (server) await new Promise((ready) => server.close(ready))
    await rm(directory, { recursive: true, force: true })
  }
}
run().catch((error) => {
  console.error(error)
  process.exitCode = 1
})
