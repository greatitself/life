#!/usr/bin/env node
// Verify native navigator behavior and history work with 3,000 mounted messages.
const assert = require('node:assert/strict')
const { createServer } = require('node:http')
const { mkdtemp, mkdir, readFile, writeFile, rm } = require('node:fs/promises')
const { join, resolve } = require('node:path')
const { tmpdir } = require('node:os')
const { build } = require('esbuild')
const { chromium } = require('playwright')

async function run() {
  const withoutTickMemo = process.argv.includes('--without-tick-memo')
  const directory = await mkdtemp(join(tmpdir(), 'life-message-navigator-'))
  const output = resolve(__dirname, '../output/playwright')
  await mkdir(output, { recursive: true })
  const checks = []
  const errors = []
  const renderedTicks = {}
  let browser
  let server
  try {
    await build({
      stdin: {
        resolveDir: resolve(__dirname, '..'),
        sourcefile: 'thread-message-navigator-fixture.tsx',
        loader: 'tsx',
        contents: `
          import React, { useRef, useState } from 'react'
          import { createRoot } from 'react-dom/client'
          import { ThreadMessageNavigator } from './src/renderer/components/ThreadMessageNavigator'
          const unsafeId = 'user"]\\\\last'
          const counts = { role: 0, text: 0, assistantText: 0 }
          function tracked(id, role, text) {
            return { id, turn: 1, get role() { counts.role++; return role },
              get text() { counts.text++; if (role === 'assistant') counts.assistantText++; return text } }
          }
          const initial = Array.from({ length: 1500 }, (_, index) => [
            tracked(index === 1499 ? unsafeId : 'u-' + index, 'user', 'Question ' + (index + 1)),
            tracked('a-' + index, 'assistant', index === 1498 ? 'Rare assistant reply' : index === 1499 ? 'Streaming reply before update' : 'Reply ' + (index + 1)),
          ]).flat()
          function Fixture() {
            const [messages, setMessages] = useState(initial)
            const anchors = messages.map(message => message.id)
            const [renders, setRenders] = useState(0)
            const [jumps, setJumps] = useState(0)
            const conversation = useRef(null)
            window.navigatorTest = {
              unsafeId,
              reset() { counts.role = counts.text = counts.assistantText = 0 },
              counts() { return { ...counts } },
              stream(text) { setMessages(current => current.map(message => message.id === 'a-1499' ? tracked(message.id, 'assistant', text) : message)) },
              updatePrompt() { setMessages(current => current.map(message => message.id === unsafeId ? tracked(message.id, 'user', 'Updated final prompt') : message)) },
              reorder() { setMessages(current => [current[2], current[3], current[0], current[1], ...current.slice(4)]) },
            }
            return <main>
              <button onClick={() => setRenders(value => value + 1)}>Unrelated render</button>
              <p data-renders={renders} data-jumps={jumps}>Navigator fixture</p>
              <div style={{ position: 'relative', height: 550 }}>
                <ThreadMessageNavigator messages={messages} conversation={conversation} onJump={() => setJumps(jumps + 1)} />
                <div data-viewport ref={conversation} style={{ position: 'absolute', left: 50, width: 640, height: 400, overflow: 'auto' }}>
                  {anchors.map((id, index) => id === 'a-1498' ?
                    <details key={id}><summary>Earlier work</summary><article tabIndex={-1} data-message-id={id} style={{ height: 36 }}>Hidden matching reply</article></details> :
                    <article key={id} tabIndex={-1} data-message-id={id} style={{ height: 36 }}>Mounted message {index + 1}</article>)}
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
      plugins: withoutTickMemo
        ? [
            {
              name: 'navigator-tick-baseline',
              setup(builder) {
                builder.onLoad(
                  { filter: /[\\/]ThreadMessageNavigator\.tsx$/ },
                  async ({ path }) => ({
                    contents: (await readFile(path, 'utf8')).replace(
                      'const ThreadMessageTick = memo(',
                      'const ThreadMessageTick = (',
                    ),
                    loader: 'tsx',
                  }),
                )
              },
            },
          ]
        : [],
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
          : '<!doctype html><html lang="en"><head><title>Life navigator verification</title><link rel="stylesheet" href="/fixture.css"></head><body><div id="root"></div><script src="/fixture.js"></script></body></html>',
      )
    })
    await new Promise((ready) => server.listen(0, '127.0.0.1', ready))
    browser = await chromium.launch({ headless: true })
    const page = await browser.newPage({ viewport: { width: 1100, height: 750 } })
    page.on('pageerror', (error) => errors.push(error.message))
    // Observe actual React commits without adding profiling branches to shipped components.
    await page.addInitScript(() => {
      window.tickProbe = { renders: 0, ids: [] }
      window.__REACT_DEVTOOLS_GLOBAL_HOOK__ = {
        supportsFiber: true,
        inject() {
          return 1
        },
        onCommitFiberRoot(_renderer, root) {
          const visit = (fiber) => {
            if (!fiber) return
            if (fiber.type?.name?.startsWith('ThreadMessageTick') && fiber.flags & 1) {
              window.tickProbe.renders++
              window.tickProbe.ids.push(fiber.memoizedProps.id)
            }
            visit(fiber.child)
            visit(fiber.sibling)
          }
          visit(root.current)
        },
        onCommitFiberUnmount() {},
      }
    })
    await page.goto('http://127.0.0.1:' + server.address().port)
    await page.waitForLoadState('networkidle')
    const viewport = page.locator('[data-viewport]')
    const reset = () => page.evaluate(() => window.navigatorTest.reset())
    const counts = () => page.evaluate(() => window.navigatorTest.counts())
    const resetTicks = () =>
      page.evaluate(() => {
        window.tickProbe.renders = 0
        window.tickProbe.ids = []
      })
    const tickRenders = () => page.evaluate(() => ({ ...window.tickProbe }))
    const current = () =>
      page.locator('.thread-message-tick[aria-current="location"]').getAttribute('aria-label')
    const first = page.getByRole('button', { name: 'Jump to message 1: Question 1', exact: true })
    await first.waitFor()
    assert.equal(await page.locator('[data-message-id]').count(), 3000)
    assert.ok((await tickRenders()).renders >= 1500, 'Render probe observes every mounted tick')
    await reset()
    await resetTicks()
    await page.getByRole('button', { name: 'Unrelated render', exact: true }).click()
    await page.locator('[data-renders="1"]').waitFor()
    assert.deepEqual(await counts(), { role: 0, text: 0, assistantText: 0 })
    renderedTicks.unrelated = (await tickRenders()).renders
    if (withoutTickMemo) {
      assert.equal(renderedTicks.unrelated, 1500, 'Baseline renders every tick without memoization')
      const proof = { baseline: true, mountedMessages: 3000, renderedTicks, errors }
      await writeFile(
        join(output, 'thread-message-navigator-baseline.json'),
        JSON.stringify(proof, null, 2) + '\n',
      )
      console.log(JSON.stringify(proof, null, 2))
      return
    }
    assert.equal(
      (await tickRenders()).renders,
      0,
      'Unrelated parent render preserves settled ticks',
    )
    await first.hover()
    await page.getByRole('tooltip').waitFor()
    assert.equal((await counts()).role, 0)
    assert.ok(
      (await counts()).text <= 2,
      'Preview reads only the visible reply, including StrictMode',
    )
    assert.ok((await tickRenders()).renders < 30, 'Hover renders only nearby wave ticks')
    renderedTicks.hover = (await tickRenders()).renders
    checks.push('Closed finder and navigation previews do not rescan 3,000 message roles or bodies')

    await page.mouse.move(1000, 700)
    await resetTicks()
    await viewport.evaluate((root) => {
      root.scrollTop = 36
    })
    await page.waitForFunction(
      () =>
        document
          .querySelector('.thread-message-tick[aria-current="location"]')
          ?.getAttribute('aria-label') === 'Jump to message 2: Question 2',
    )
    checks.push(
      'Current message updates when the previous anchor exits but another remains intersecting',
    )
    assert.equal(
      (await tickRenders()).renders,
      2,
      'Scroll renders only the old and new current ticks',
    )
    renderedTicks.scroll = (await tickRenders()).renders

    await page.keyboard.press('Control+f')
    const finder = page.getByRole('dialog', { name: 'Find in this thread', exact: true })
    await finder.waitFor()
    assert.match(await finder.getByRole('status').textContent(), /^3000 messages/)
    assert.equal(await finder.locator('.thread-finder-results > button').count(), 200)
    const search = finder.getByRole('textbox', {
      name: 'Search messages in this thread',
      exact: true,
    })
    await search.fill('rArE aSsIsTaNt')
    await page.waitForFunction(
      () => document.querySelector('.thread-finder-count')?.textContent === '1 message',
    )
    await reset()
    await resetTicks()
    const previousCurrent = await current()
    await viewport.evaluate((root) => {
      root.scrollTop = 108
    })
    await page.waitForFunction(
      (previous) =>
        document
          .querySelector('.thread-message-tick[aria-current="location"]')
          ?.getAttribute('aria-label') !== previous,
      previousCurrent,
    )
    assert.deepEqual(await counts(), { role: 0, text: 0, assistantText: 0 })
    checks.push(
      'Case-insensitive finder searches all history, caps rendered results, and retains cached matches during navigation',
    )

    await finder
      .getByRole('button', { name: 'Agent reply Rare assistant reply', exact: true })
      .click()
    await finder.waitFor({ state: 'hidden' })
    await page.locator('[data-jumps="1"]').waitFor()
    assert.equal(await viewport.locator('details').evaluate((element) => element.open), true)
    assert.equal(
      await page.evaluate(() => document.activeElement?.getAttribute('data-message-id')),
      'a-1498',
    )
    await page.keyboard.press('Control+f')
    await finder.waitFor()
    await page.waitForFunction(() =>
      document.querySelector('.thread-finder-count')?.textContent?.startsWith('3000 messages'),
    )
    assert.equal(await search.inputValue(), '')
    await page.keyboard.press('Escape')
    await finder.waitFor({ state: 'hidden' })
    assert.equal(
      await page.evaluate(() => document.activeElement?.getAttribute('data-message-id')),
      'a-1498',
    )
    checks.push(
      'Finder jumps expand earlier work, focus the exact message, reset the query, and restore focus on close',
    )

    const last = page.getByRole('button', {
      name: 'Jump to message 1500: Question 1500',
      exact: true,
    })
    await last.hover()
    await page
      .getByRole('tooltip')
      .getByText('Streaming reply before update', { exact: true })
      .waitFor()
    await reset()
    await resetTicks()
    await page.evaluate(() => window.navigatorTest.stream('Streaming reply after update'))
    await page
      .getByRole('tooltip')
      .getByText('Streaming reply after update', { exact: true })
      .waitFor()
    assert.ok(
      (await counts()).assistantText <= 2,
      'Closed streaming reads only the currently previewed reply, including StrictMode',
    )
    assert.equal(
      (await tickRenders()).renders,
      0,
      'Streaming replies preserve every unchanged tick',
    )
    renderedTicks.streaming = (await tickRenders()).renders
    await last.click()
    await page.locator('[data-jumps="2"]').waitFor()
    assert.equal(
      await page.evaluate(() => document.activeElement?.getAttribute('data-message-id')),
      await page.evaluate(() => window.navigatorTest.unsafeId),
    )
    checks.push(
      'An open preview follows the latest streamed reply and unusual message IDs remain safe to jump to',
    )

    await page.mouse.move(1000, 700)
    await resetTicks()
    await page.evaluate(() => window.navigatorTest.updatePrompt())
    await page
      .getByRole('button', { name: 'Jump to message 1500: Updated final prompt', exact: true })
      .waitFor()
    assert.deepEqual((await tickRenders()).ids, [
      await page.evaluate(() => window.navigatorTest.unsafeId),
    ])
    renderedTicks.prompt = (await tickRenders()).renders
    await viewport.evaluate((root) => {
      root.scrollTop = 0
    })
    await page.waitForFunction(
      () =>
        document
          .querySelector('.thread-message-tick[aria-current="location"]')
          ?.getAttribute('aria-label') === 'Jump to message 1: Question 1',
    )
    await resetTicks()
    await page.evaluate(() => window.navigatorTest.reorder())
    await page.getByRole('button', { name: 'Jump to message 1: Question 2', exact: true }).waitFor()
    await page.getByRole('button', { name: 'Jump to message 2: Question 1', exact: true }).waitFor()
    assert.deepEqual([...new Set((await tickRenders()).ids)].sort(), ['u-0', 'u-1'])
    assert.ok(
      (await tickRenders()).renders <= 4,
      'Reordering touches only moved ticks and their current state',
    )
    renderedTicks.reorder = (await tickRenders()).renders
    checks.push(
      'Only changed navigation ticks render during hover, scroll, streaming, prompt updates and reordering',
    )

    assert.deepEqual(errors, [])
    const proof = {
      ok: true,
      mountedMessages: 3000,
      renderedTicks,
      checks,
      errors,
      completedAt: new Date().toISOString(),
    }
    await writeFile(
      join(output, 'thread-message-navigator-proof.json'),
      JSON.stringify(proof, null, 2) + '\n',
    )
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
