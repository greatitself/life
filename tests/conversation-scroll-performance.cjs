#!/usr/bin/env node
// Compare the exact scroll module on identical native, fully mounted transcripts.
const assert = require('node:assert/strict')
const { createServer } = require('node:http')
const { execFileSync } = require('node:child_process')
const { mkdtemp, readFile, writeFile, mkdir, rm } = require('node:fs/promises')
const { join, resolve } = require('node:path')
const { tmpdir } = require('node:os')
const { build } = require('esbuild')
const { chromium } = require('playwright')

const baselineRevision = 'a1b3facb8bc3c07b1521ed21965f4f8b88acd268'
const baseline = process.argv.includes('--baseline')
const correctnessOnly = process.argv.includes('--correctness')
const directoryName = correctnessOnly ? 'correctness' : baseline ? 'baseline' : 'current'
const percentile = (values, fraction) =>
  [...values].sort((a, b) => a - b)[Math.floor((values.length - 1) * fraction)]

async function run() {
  const directory = await mkdtemp(join(tmpdir(), 'life-scroll-performance-'))
  const proofDirectory = resolve(__dirname, '../output/playwright/conversation-scroll-performance')
  await mkdir(proofDirectory, { recursive: true })
  let browser
  let server
  const errors = []
  const checks = []
  const regressions = []
  try {
    await build({
      stdin: {
        resolveDir: resolve(__dirname, '..'),
        sourcefile: 'conversation-scroll-performance-fixture.tsx',
        loader: 'tsx',
        contents: `
          import React, { useMemo, useState } from 'react'
          import { createRoot } from 'react-dom/client'
          import * as helpers from './src/renderer/conversation-scroll'
          const mode = new URLSearchParams(location.search).get('bench')
          const rows = (prefix, count) => Array.from({ length: count }, (_, index) =>
            <article key={index} data-message-id={prefix + ':' + index} className="message-row">
              Mounted transcript message {index}: {index === 42 ? 'NativeFindNeedle42' : 'exact provider text'}
              <button data-focus-message={index}>Focus message {index}</button>
            </article>)
          function Bench() {
            React.useLayoutEffect(() => {
              const root = document.querySelector('[data-viewport]')
              const Index = helpers['ConversationAnchorIndex']
              const index = Index ? new Index(root) : undefined
              window.measureCapture = () => helpers.captureConversationPosition(root, false, index)
              window.measureRestore = (position) => helpers.restoredConversationTop(root, position, index)
            }, [])
            return <div data-viewport className={'viewport bench-' + mode}>
              <div data-content>{mode === 'flat' ? rows('bench', 5000) : Array.from({ length: 250 }, (_, turn) =>
                <section className="thread-timeline-turn" data-settled key={turn}>{rows('turn-' + turn, 2)}</section>)}</div>
            </div>
          }
          function Fixture() {
            const [thread, setThread] = useState('a')
            const [count, setCount] = useState(5000)
            const messages = useMemo(() => rows(thread, count), [thread, count])
            const scroll = helpers.useConversationScroll(thread, { messages })
            window.setFollowing = scroll.setStickToBottom
            return <main>
              <nav>
                <button onClick={() => setThread('a')}>Thread A</button>
                <button onClick={() => setThread('b')}>Thread B</button>
                <button onClick={() => setCount(value => value + 1)}>Stream message</button>
                <button onClick={() => scroll.setStickToBottom(true)}>Latest message</button>
              </nav>
              <p data-following={String(scroll.stickToBottom)}>{thread}</p>
              <div data-viewport className="viewport" ref={scroll.viewportRef} tabIndex={0}>
                <div data-content>{Array.from({ length: Math.ceil(count / 20) }, (_, turn) =>
                  <section className="thread-timeline-turn" data-settled key={turn}>{messages.slice(turn * 20, turn * 20 + 20)}</section>)}</div>
              </div>
            </main>
          }
          const root = createRoot(document.getElementById('root'))
          window.unmount = () => root.unmount()
          root.render(mode ? <Bench /> : <React.StrictMode><Fixture /></React.StrictMode>)
        `,
      },
      plugins: baseline
        ? [
            {
              name: 'pinned-scroll-baseline',
              setup(plugin) {
                plugin.onLoad(
                  { filter: /\/src\/renderer\/conversation-scroll\.ts$/ },
                  ({ path }) => ({
                    contents: execFileSync(
                      'git',
                      ['show', baselineRevision + ':src/renderer/conversation-scroll.ts'],
                      { cwd: resolve(__dirname, '..'), encoding: 'utf8' },
                    ),
                    loader: 'ts',
                    resolveDir: resolve(__dirname, '../src/renderer'),
                  }),
                )
              },
            },
          ]
        : [],
      bundle: true,
      jsx: 'automatic',
      outfile: join(directory, 'fixture.js'),
      define: { 'process.env.NODE_ENV': '"production"' },
      logLevel: 'silent',
    })
    server = createServer(async (request, response) => {
      if (request.url === '/fixture.js') {
        response.setHeader('Content-Type', 'text/javascript')
        response.end(await readFile(join(directory, 'fixture.js')))
      } else {
        response.setHeader('Content-Type', 'text/html')
        response.end(`<!doctype html><html><head><style>
          .viewport{height:300px;width:760px;overflow:auto;border:1px solid black}
          .message-row{box-sizing:border-box;min-height:60px;padding:8px;border-bottom:1px solid #ddd}
          .thread-timeline-turn{content-visibility:auto;contain-intrinsic-size:auto 600px}
          .bench-grouped .message-row{height:400px}
        </style></head><body><div id="root"></div><script src="/fixture.js"></script></body></html>`)
      }
    })
    await new Promise((ready) => server.listen(0, '127.0.0.1', ready))
    browser = await chromium.launch({ headless: true })
    const page = await browser.newPage({ viewport: { width: 1100, height: 700 } })
    await page.addInitScript(() => {
      window.activeListeners = []
      const add = EventTarget.prototype.addEventListener
      const remove = EventTarget.prototype.removeEventListener
      EventTarget.prototype.addEventListener = function (type, listener, options) {
        if (
          ['scroll', 'wheel', 'touchmove', 'pointerdown', 'keydown', 'selectionchange'].includes(
            type,
          )
        ) {
          window.activeListeners.push({ target: this, type, listener })
        }
        return add.call(this, type, listener, options)
      }
      EventTarget.prototype.removeEventListener = function (type, listener, options) {
        window.activeListeners = window.activeListeners.filter(
          (entry) => entry.target !== this || entry.type !== type || entry.listener !== listener,
        )
        return remove.call(this, type, listener, options)
      }
    })
    page.on('pageerror', (error) => errors.push(error.message))
    const cdp = await page.context().newCDPSession(page)
    await cdp.send('Emulation.setCPUThrottlingRate', { rate: 2 })
    await cdp.send('Performance.enable')
    const metrics = async () =>
      Object.fromEntries(
        (await cdp.send('Performance.getMetrics')).metrics.map((entry) => [
          entry.name,
          entry.value,
        ]),
      )
    const baseUrl = 'http://127.0.0.1:' + server.address().port
    const measurements = {}
    for (const mode of correctnessOnly ? [] : ['flat', 'grouped']) {
      await page.goto(baseUrl + '/?bench=' + mode)
      await page.waitForLoadState('networkidle')
      await page.evaluate(async () => {
        const root = document.querySelector('[data-viewport]')
        root.scrollTop = (root.scrollHeight - root.clientHeight) * 0.9
        await new Promise((done) => requestAnimationFrame(() => requestAnimationFrame(done)))
        window.rectReads = 0
        const original = Element.prototype.getBoundingClientRect
        Element.prototype.getBoundingClientRect = function () {
          window.rectReads++
          return original.call(this)
        }
      })
      const before = await metrics()
      const cold = await page.evaluate(() => {
        window.rectReads = 0
        const started = performance.now()
        const position = window.measureCapture()
        return { elapsed: performance.now() - started, rectReads: window.rectReads, position }
      })
      const after = await metrics()
      const samples = await page.evaluate(() =>
        Array.from({ length: 45 }, () => {
          window.rectReads = 0
          const started = performance.now()
          let position
          for (let call = 0; call < 10; call++) position = window.measureCapture()
          const captureMs = (performance.now() - started) / 10
          const captureRects = window.rectReads / 10
          window.rectReads = 0
          const restoreStarted = performance.now()
          for (let call = 0; call < 10; call++) window.measureRestore(position)
          return {
            captureMs,
            captureRects,
            restoreMs: (performance.now() - restoreStarted) / 10,
            restoreRects: window.rectReads / 10,
          }
        }),
      )
      const afterWarm = await metrics()
      measurements[mode] = {
        anchors: mode === 'flat' ? 5000 : 500,
        cold,
        coldLayouts: after.LayoutCount - before.LayoutCount,
        coldStyles: after.RecalcStyleCount - before.RecalcStyleCount,
        coldLayoutMs: (after.LayoutDuration - before.LayoutDuration) * 1000,
        warmLayouts: afterWarm.LayoutCount - after.LayoutCount,
        warmStyles: afterWarm.RecalcStyleCount - after.RecalcStyleCount,
        warmLayoutMs: (afterWarm.LayoutDuration - after.LayoutDuration) * 1000,
        captureMedianMs: percentile(
          samples.map((sample) => sample.captureMs),
          0.5,
        ),
        captureP95Ms: percentile(
          samples.map((sample) => sample.captureMs),
          0.95,
        ),
        captureMaxRects: Math.max(...samples.map((sample) => sample.captureRects)),
        restoreMedianMs: percentile(
          samples.map((sample) => sample.restoreMs),
          0.5,
        ),
        restoreMaxRects: Math.max(...samples.map((sample) => sample.restoreRects)),
      }
      if (!baseline) {
        assert.ok(cold.rectReads <= 32, mode + ' capture reads only a bounded number of rectangles')
        assert.ok(measurements[mode].captureMaxRects <= 32)
        assert.ok(measurements[mode].restoreMaxRects <= 2)
        assert.ok(
          measurements[mode].coldLayouts <= 3,
          mode + ' does not materialize skipped history',
        )
      }
    }
    if (!correctnessOnly) {
      checks.push(
        '5000 mounted flat anchors and 250 settled content-visibility turns use bounded geometry reads',
      )
    }

    await page.goto(baseUrl)
    await page.waitForLoadState('networkidle')
    const root = page.locator('[data-viewport]')
    const waitAtEnd = () =>
      page.waitForFunction(() => {
        const root = document.querySelector('[data-viewport]')
        return root.scrollHeight - root.scrollTop - root.clientHeight <= 1
      })
    const anchor = () =>
      root.evaluate((element) => {
        const bounds = element.getBoundingClientRect()
        const message = document
          .elementFromPoint(bounds.left + 20, bounds.top + 4)
          ?.closest('[data-message-id]')
        return {
          id: message?.dataset.messageId,
          offset: message?.getBoundingClientRect().top - bounds.top,
        }
      })
    const readAt = async (top) => {
      await root.evaluate((element, top) => {
        element.scrollTop = top
      }, top)
      await page.locator('[data-following="false"]').waitFor()
      await page.waitForTimeout(100)
    }
    await waitAtEnd()
    await root.evaluate((element) => {
      const content = element.querySelector('[data-content]')
      for (const [height, placement] of [
        [220, 'prepend'],
        [400, 'append'],
      ]) {
        const panel = document.createElement('div')
        panel.style.height = height + 'px'
        panel.textContent = placement + ' asynchronous history and attachment'
        content[placement](panel)
      }
    })
    await page.waitForTimeout(150)
    const simultaneousGrowth = await root.evaluate((element) => ({
      following: document.querySelector('[data-following]').dataset.following === 'true',
      gap: element.scrollHeight - element.scrollTop - element.clientHeight,
    }))
    if (!baseline) {
      assert.equal(simultaneousGrowth.following, true)
      assert.ok(simultaneousGrowth.gap <= 1)
    } else if (!simultaneousGrowth.following || simultaneousGrowth.gap > 1) {
      regressions.push(
        'Simultaneous prepended history and appended output were classified as reader scrolling',
      )
    }
    checks.push(
      'Simultaneous prepended history and appended output preserve following through native scroll anchoring',
    )
    await readAt(120_040)
    const savedAnchor = await anchor()
    assert.ok(savedAnchor.id)
    await page.getByRole('button', { name: 'Stream message', exact: true }).click()
    await page.waitForTimeout(150)
    assert.deepEqual(await anchor(), savedAnchor)
    await root.evaluate((element) => {
      const history = document.createElement('section')
      history.style.height = '320px'
      history.textContent = 'Earlier history'
      element.querySelector('[data-content]').prepend(history)
    })
    await page.waitForTimeout(150)
    assert.deepEqual(await anchor(), savedAnchor)
    const originalTop = await root.evaluate((element) => element.scrollTop)
    await page.getByRole('button', { name: 'Thread B', exact: true }).click()
    await waitAtEnd()
    await readAt(40_040)
    await page.getByRole('button', { name: 'Thread A', exact: true }).click()
    await page.waitForTimeout(150)
    assert.deepEqual(await anchor(), savedAnchor)
    checks.push(
      'Deep history keeps the exact message offset during streaming, prepend, and thread switches',
    )

    await page.getByRole('button', { name: 'Latest message', exact: true }).click()
    await waitAtEnd()
    const found = await page.evaluate(() => window.find('NativeFindNeedle42'))
    assert.equal(found, true)
    await page.waitForTimeout(150)
    const nativeFind = await root.evaluate((element) => ({
      following: document.querySelector('[data-following]').dataset.following === 'true',
      top: element.scrollTop,
    }))
    if (!baseline) {
      assert.equal(nativeFind.following, false)
      assert.ok(nativeFind.top < originalTop)
    } else {
      if (nativeFind.following || nativeFind.top >= originalTop)
        regressions.push(
          'Native find selected offscreen text while following restored the live edge',
        )
    }
    assert.equal(await page.evaluate(() => window.getSelection().toString()), 'NativeFindNeedle42')
    const repeatedFound = await page.evaluate(() => window.find('Mounted transcript message 4200:'))
    assert.equal(repeatedFound, true)
    await page.waitForTimeout(150)
    const repeatedNativeFind = await root.evaluate((element) => {
      const bounds = element.getBoundingClientRect()
      const selection = getSelection()
      const rect = selection.getRangeAt(0).getBoundingClientRect()
      return {
        following: document.querySelector('[data-following]').dataset.following === 'true',
        selection: selection.toString(),
        visible: rect.bottom > bounds.top && rect.top < bounds.bottom,
        selectedTop: rect.top,
        focusId: selection.focusNode.parentElement.closest('[data-message-id]')?.dataset.messageId,
        focusTop: selection.focusNode.parentElement
          .closest('[data-message-id]')
          ?.getBoundingClientRect().top,
        anchorId:
          selection.anchorNode.parentElement.closest('[data-message-id]')?.dataset.messageId,
        selectedBottom: rect.bottom,
        viewportTop: bounds.top,
        viewportBottom: bounds.bottom,
        top: element.scrollTop,
      }
    })
    if (!baseline) {
      assert.equal(repeatedNativeFind.following, false)
      assert.equal(repeatedNativeFind.selection, 'Mounted transcript message 4200:')
      assert.equal(
        repeatedNativeFind.visible,
        true,
        'Repeated native Find must reveal its match while already paused',
      )
      assert.equal(
        await root.locator('.thread-timeline-turn[style*="content-visibility: visible"]').count(),
        0,
      )
    }
    await root.locator('[data-focus-message="12"]').focus()
    assert.equal(await page.evaluate(() => document.activeElement.dataset.focusMessage), '12')
    assert.equal(await root.locator('[data-message-id]').count(), 5001)
    assert.equal(await root.locator('.thread-timeline-turn').count(), 251)
    checks.push(
      'Initial and repeated native find, text selection, and focus reach offscreen history while every anchor stays mounted',
    )
    if (!baseline) {
      await root.evaluate((element) => {
        const disclosure = document.createElement('details')
        disclosure.innerHTML = '<summary>Expanded tool activity</summary>'
        disclosure.addEventListener('toggle', () => {
          if (!disclosure.open || disclosure.querySelector('[data-message-id]')) return
          const tool = document.createElement('article')
          tool.className = 'message-row'
          tool.dataset.messageId = 'expanded-tool'
          tool.textContent = 'Full expanded tool input and output'
          disclosure.append(tool)
        })
        element.querySelector('.thread-timeline-turn').append(disclosure)
        disclosure.open = true
      })
      const tool = root.locator('[data-message-id="expanded-tool"]')
      await tool.waitFor({ state: 'attached' })
      await tool.evaluate((element) => element.scrollIntoView({ block: 'start' }))
      await page.waitForTimeout(150)
      assert.equal((await anchor()).id, 'expanded-tool')
      await tool.evaluate((element) => {
        element.dataset.messageId = 'renamed-expanded-tool'
      })
      await root.evaluate((element) => {
        element.scrollTop += 1
      })
      await page.waitForTimeout(150)
      const renamedAnchor = await anchor()
      assert.equal(renamedAnchor.id, 'renamed-expanded-tool')
      await root.evaluate((element) => {
        const history = document.createElement('div')
        history.style.height = '180px'
        element.querySelector('[data-content]').prepend(history)
      })
      await page.waitForTimeout(150)
      assert.deepEqual(await anchor(), renamedAnchor)
      await root
        .locator('[data-message-id="renamed-expanded-tool"]')
        .evaluate((element) => element.remove())
      await page.getByRole('button', { name: 'Latest message', exact: true }).click()
      await waitAtEnd()
      await page.evaluate(() => {
        const outside = document.createElement('p')
        outside.textContent = 'Selection outside the conversation'
        document.body.append(outside)
        const range = document.createRange()
        range.selectNodeContents(outside)
        getSelection().removeAllRanges()
        getSelection().addRange(range)
      })
      await page.waitForTimeout(100)
      assert.equal(await page.locator('[data-following]').getAttribute('data-following'), 'true')
      const cleanup = await root.evaluate((element) => {
        const viewportBefore = window.activeListeners.filter(
          (entry) => entry.target === element,
        ).length
        const selectionBefore = window.activeListeners.filter(
          (entry) => entry.target === document && entry.type === 'selectionchange',
        ).length
        window.unmount()
        return {
          viewportBefore,
          viewportAfter: window.activeListeners.filter((entry) => entry.target === element).length,
          selectionRemoved:
            selectionBefore -
            window.activeListeners.filter(
              (entry) => entry.target === document && entry.type === 'selectionchange',
            ).length,
        }
      })
      assert.equal(cleanup.viewportBefore, 5)
      assert.equal(cleanup.viewportAfter, 0)
      assert.equal(cleanup.selectionRemoved, 1)
      checks.push(
        'Expanded tool anchors, changed message IDs, and removed anchors update the index; outside selections are ignored and all controller listeners detach',
      )
    }
    assert.deepEqual(errors, [])
    await page.screenshot({ path: join(proofDirectory, directoryName + '.png') })
    const proof = {
      ok: true,
      mode: directoryName,
      baselineRevision,
      cpuThrottle: 2,
      measurements,
      simultaneousGrowth,
      nativeFind,
      repeatedNativeFind,
      checks: baseline
        ? [
            'Identical flat and grouped benchmark phases collected',
            'Both known following regressions reproduced',
          ]
        : checks,
      regressions,
      errors,
      completedAt: new Date().toISOString(),
    }
    await writeFile(
      join(proofDirectory, directoryName + '.json'),
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
