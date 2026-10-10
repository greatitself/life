#!/usr/bin/env node
// Exercise the exact desktop scroll hook with native mounted message anchors.
const assert = require('node:assert/strict')
const { createServer } = require('node:http')
const { mkdtemp, readFile, writeFile, mkdir, rm } = require('node:fs/promises')
const { join, resolve } = require('node:path')
const { tmpdir } = require('node:os')
const { build } = require('esbuild')
const { chromium } = require('playwright')

async function run() {
  const directory = await mkdtemp(join(tmpdir(), 'life-conversation-scroll-'))
  const proofDirectory = resolve(__dirname, '../output/playwright/conversation-scroll-v010')
  await mkdir(proofDirectory, { recursive: true })
  const checks = []
  const errors = []
  let browser
  let server
  try {
    await build({
      stdin: {
        resolveDir: resolve(__dirname, '..'),
        sourcefile: 'conversation-scroll-fixture.tsx',
        loader: 'tsx',
        contents: `
          import React, { useMemo, useState } from 'react'
          import { createRoot } from 'react-dom/client'
          import { useConversationScroll } from './src/renderer/conversation-scroll'
          function Fixture() {
            const [thread, setThread] = useState('a')
            const [view, setView] = useState('agents')
            const [count, setCount] = useState(60)
            const messages = useMemo(() => Array.from({ length: count }, (_, index) => ({ id: thread + ':' + index, text: 'Mounted message ' + index })), [count, thread])
            const scroll = useConversationScroll(JSON.stringify([view, thread]), { messages })
            return <main>
              <nav>
                <button onClick={() => setThread('a')}>Thread A</button>
                <button onClick={() => setThread('b')}>Thread B</button>
                <button onClick={() => setView('agents')}>Agents</button>
                <button onClick={() => setView('research')}>Research</button>
                <button onClick={() => setCount(value => value + 1)}>Stream message</button>
                <button onClick={() => { setCount(value => value + 1); scroll.setStickToBottom(true) }}>Send message</button>
                <button onClick={() => scroll.setStickToBottom(true)}>Latest message</button>
              </nav>
              <p data-following={String(scroll.stickToBottom)}>{view}:{thread}</p>
              <div data-viewport ref={scroll.viewportRef} tabIndex={0} style={{ height: 240, width: 640, overflow: 'auto', border: '1px solid black' }}>
                <div data-content>
                  {messages.map(message => <article data-message-id={message.id} key={message.id} style={{ minHeight: 60, borderBottom: '1px solid #ddd', padding: 6 }}>{message.text}</article>)}
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
      logLevel: 'silent',
    })
    server = createServer(async (request, response) => {
      if (request.url === '/fixture.js') {
        response.setHeader('Content-Type', 'text/javascript')
        response.end(await readFile(join(directory, 'fixture.js')))
      } else {
        response.setHeader('Content-Type', 'text/html')
        response.end(
          '<!doctype html><html><head><title>Life scroll verification</title></head><body><div id="root"></div><script src="/fixture.js"></script></body></html>',
        )
      }
    })
    await new Promise((ready) => server.listen(0, '127.0.0.1', ready))
    browser = await chromium.launch({ headless: true })
    const page = await browser.newPage({ viewport: { width: 1100, height: 700 } })
    page.on('pageerror', (error) => errors.push(error.message))
    await page.goto('http://127.0.0.1:' + server.address().port)
    await page.waitForLoadState('networkidle')
    const viewport = page.locator('[data-viewport]')
    const position = () =>
      viewport.evaluate((root) => ({
        top: root.scrollTop,
        gap: root.scrollHeight - root.scrollTop - root.clientHeight,
      }))
    const waitAtEnd = () =>
      page.waitForFunction(() => {
        const root = document.querySelector('[data-viewport]')
        return root.scrollHeight - root.scrollTop - root.clientHeight <= 1
      })
    const readAt = async (top) => {
      await viewport.evaluate((root, top) => {
        root.scrollTop = top
      }, top)
      await page.locator('[data-following="false"]').waitFor()
    }
    const anchor = () =>
      viewport.evaluate((root) => {
        const top = root.getBoundingClientRect().top
        const message = Array.from(root.querySelectorAll('[data-message-id]')).find(
          (element) => element.getBoundingClientRect().bottom > top,
        )
        return { id: message.dataset.messageId, offset: message.getBoundingClientRect().top - top }
      })
    await waitAtEnd()
    await page.getByRole('button', { name: 'Stream message', exact: true }).click()
    await waitAtEnd()
    checks.push('New conversations and streaming output follow the live edge')

    await readAt(700)
    const savedA = await position()
    const savedAnchor = await anchor()
    await page.getByRole('button', { name: 'Stream message', exact: true }).click()
    await page.waitForTimeout(100)
    assert.equal((await position()).top, savedA.top)
    checks.push('Streaming does not move the reader away from history')

    await page.getByRole('button', { name: 'Thread B', exact: true }).click()
    await waitAtEnd()
    await readAt(1300)
    const savedB = await position()
    await page.getByRole('button', { name: 'Thread A', exact: true }).click()
    await page.waitForTimeout(100)
    assert.equal((await position()).top, savedA.top)
    assert.deepEqual(await anchor(), savedAnchor)
    await page.getByRole('button', { name: 'Thread B', exact: true }).click()
    await page.waitForTimeout(100)
    assert.equal((await position()).top, savedB.top)
    checks.push('Thread switches restore their own native message anchor and scroll position')

    await page.getByRole('button', { name: 'Thread A', exact: true }).click()
    await page.getByRole('button', { name: 'Research', exact: true }).click()
    await waitAtEnd()
    await readAt(1900)
    const savedResearch = await position()
    await page.getByRole('button', { name: 'Agents', exact: true }).click()
    await page.waitForTimeout(100)
    assert.equal((await position()).top, savedA.top)
    await page.getByRole('button', { name: 'Research', exact: true }).click()
    await page.waitForTimeout(100)
    assert.equal((await position()).top, savedResearch.top)
    checks.push('The same thread retains separate Agents and Research reading positions')

    const beforeGrowth = await anchor()
    await viewport.evaluate((root) => {
      const panel = document.createElement('div')
      panel.style.height = '220px'
      panel.textContent = 'Older history and late expanded content'
      root.querySelector('[data-content]').prepend(panel)
    })
    await page.waitForTimeout(100)
    assert.deepEqual(await anchor(), beforeGrowth)
    checks.push('History and late layout above the viewport preserve the visible message offset')

    await page.getByRole('button', { name: 'Latest message', exact: true }).click()
    await waitAtEnd()
    await viewport.evaluate((root) => {
      const image = document.createElement('img')
      image.alt = 'Late attachment image'
      image.style.cssText = 'display:block;width:400px'
      root.querySelector('[data-content]').append(image)
      image.src =
        'data:image/svg+xml,' +
        encodeURIComponent(
          '<svg xmlns="http://www.w3.org/2000/svg" width="400" height="500"><rect width="400" height="500" fill="blue"/></svg>',
        )
    })
    await page.locator('img[alt="Late attachment image"]').waitFor()
    await page.waitForFunction(() => document.querySelector('img').naturalHeight === 500)
    await waitAtEnd()
    checks.push('ResizeObserver follows an attachment image that gains height after render')

    await readAt(850)
    await page.getByRole('button', { name: 'Send message', exact: true }).click()
    await waitAtEnd()
    assert.equal(await viewport.locator('[data-message-id]').count(), 63)
    checks.push('An explicit new send returns to the live edge and every message stays mounted')
    assert.deepEqual(errors, [])
    await page.screenshot({ path: join(proofDirectory, 'conversation-scroll.png') })
    const proof = { ok: true, checks, errors, completedAt: new Date().toISOString() }
    await writeFile(join(proofDirectory, 'proof.json'), JSON.stringify(proof, null, 2) + '\n')
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
