#!/usr/bin/env node
// Exercise the shipped canvas in Chromium, including dense scene interaction and
// React commit cost. LIFE_GRAPH_CANVAS_SOURCE can point to an older component for
// an apples-to-apples local benchmark; production checks always use current code.
const assert = require('node:assert/strict')
const { createServer } = require('node:http')
const { mkdtemp, readFile, writeFile, mkdir, rm } = require('node:fs/promises')
const { join, resolve } = require('node:path')
const { tmpdir } = require('node:os')
const { build } = require('esbuild')
const { chromium } = require('playwright')

const repository = resolve(__dirname, '..')
const source =
  process.env.LIFE_GRAPH_CANVAS_SOURCE ||
  join(repository, 'src/renderer/components/GraphCanvas.tsx')
const profiling = process.argv.includes('--profile')
const strictMode = process.argv.includes('--strict')
const artifactName =
  process.env.LIFE_GRAPH_CANVAS_ARTIFACT || (profiling ? 'graph-canvas-profile' : 'graph-canvas')

async function main() {
  const directory = await mkdtemp(join(tmpdir(), 'life-graph-canvas-'))
  const artifacts = join(repository, 'output/playwright', artifactName)
  const errors = []
  const checks = []
  let server
  let browser
  let page
  try {
    await mkdir(artifacts, { recursive: true })
    await build({
      stdin: {
        sourcefile: 'graph-canvas-fixture.tsx',
        resolveDir: repository,
        loader: 'tsx',
        contents: `
          import React, { Profiler, useState } from 'react'
          import { createRoot } from 'react-dom/client'
          import { GraphCanvas } from ${JSON.stringify(source)}
          import './src/renderer/styles.css'
          import './src/renderer/components/life-workbench.css'
          window.canvasCommits = []
          window.canvasEdits = []
          window.canvasGeometryReads = 0
          const nativeFrame = window.requestAnimationFrame.bind(window)
          const nativeCancel = window.cancelAnimationFrame.bind(window)
          window.pendingCanvasFrames = new Set()
          window.requestAnimationFrame = callback => {
            const id = nativeFrame(time => { window.pendingCanvasFrames.delete(id); callback(time) })
            window.pendingCanvasFrames.add(id)
            return id
          }
          window.cancelAnimationFrame = id => { window.pendingCanvasFrames.delete(id); nativeCancel(id) }
          document.addEventListener('pointerdown', event => { window.canvasPointerId = event.pointerId })
          const initialNodes = Array.from({ length: 400 }, (_, index) => ({
            id: 'node-' + index,
            get x() { window.canvasGeometryReads++; return (index % 20) * 280 },
            y: Math.floor(index / 20) * 120,
            width: 240, height: 90,
            content: <button aria-label={'Inspect record ' + index} onClick={() => window.canvasEdits.push(index)}>
              <strong>Research record {index}</strong><span>Complete evidence and relationships</span>
            </button>,
          }))
          const initialEdges = Array.from({ length: 1500 }, (_, index) => ({
            from: 'node-' + (index % 400), to: 'node-' + ((index * 37 + 19) % 400),
            label: 'depends on ' + index, arrow: true, dashed: index % 3 === 0,
          }))
          function Fixture() {
            const [nodes, setNodes] = useState(initialNodes)
            const [edges, setEdges] = useState(initialEdges)
            const [fitKey, setFitKey] = useState('initial')
            window.updateCanvasScene = () => {
              setNodes(previous => previous.map((node, index) => index === 0 ? {
                ...node, x: node.x + 125, content: <button aria-label="Inspect updated record" onClick={() => window.canvasEdits.push('updated')}>Updated record</button>,
              } : node))
              setEdges(previous => [{ from: 'node-0', to: 'node-1', label: 'changed relationship', arrow: true }, ...previous.slice(1)])
            }
            window.resetCanvas = () => { setNodes(initialNodes); setEdges(initialEdges); setFitKey(String(Date.now())) }
            return <Profiler id="canvas" onRender={(_id, phase, actualDuration) => window.canvasCommits.push({ phase, actualDuration })}>
              <GraphCanvas nodes={nodes} edges={edges} fitKey={fitKey} label="Dense Research graph">
                <div className="life-canvas-overlay"><button onClick={() => window.canvasEdits.push('overlay')}>Canvas overlay action</button></div>
              </GraphCanvas>
            </Profiler>
          }
          const root = createRoot(document.getElementById('root'))
          window.unmountCanvas = () => root.unmount()
          root.render(${strictMode ? '<React.StrictMode><Fixture /></React.StrictMode>' : '<Fixture />'})
        `,
      },
      outfile: join(directory, 'fixture.js'),
      nodePaths: [join(repository, 'node_modules')],
      bundle: true,
      jsx: 'automatic',
      minify: !profiling,
      loader: { '.woff2': 'dataurl', '.woff': 'dataurl' },
      define: { 'process.env.NODE_ENV': JSON.stringify(profiling ? 'development' : 'production') },
      logLevel: 'silent',
    })
    server = createServer(async (request, response) => {
      const name =
        request.url === '/fixture.js'
          ? 'fixture.js'
          : request.url === '/fixture.css'
            ? 'fixture.css'
            : undefined
      response.setHeader(
        'Content-Type',
        name?.endsWith('.js') ? 'text/javascript' : name ? 'text/css' : 'text/html',
      )
      response.end(
        name
          ? await readFile(join(directory, name))
          : '<!doctype html><html lang="en"><head><meta charset="utf-8"><link rel="stylesheet" href="/fixture.css"><style>html,body,#root{height:100%;margin:0}#root{display:flex}.life-canvas{height:100%;width:100%}.life-canvas-node button{display:flex;flex-direction:column;background:var(--panel);color:var(--text);border:1px solid var(--border)}.life-canvas-overlay{top:12px;right:12px;left:auto}</style></head><body><div id="root"></div><script src="/fixture.js"></script></body></html>',
      )
    })
    await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
    browser = await chromium.launch({ headless: true })
    page = await browser.newPage({ viewport: { width: 1200, height: 800 } })
    page.on('pageerror', (error) => errors.push(error.message))
    await page.goto('http://127.0.0.1:' + server.address().port)
    const canvas = page.getByRole('region', { name: 'Dense Research graph' })
    await canvas.waitFor()
    const settle = () =>
      page.evaluate(
        () =>
          new Promise((resolve) =>
            requestAnimationFrame(() => requestAnimationFrame(() => setTimeout(resolve, 0))),
          ),
      )
    const camera = () =>
      page.evaluate(() => {
        const matrix = new DOMMatrixReadOnly(
          getComputedStyle(document.querySelector('.life-canvas-world')).transform,
        )
        return { x: matrix.e, y: matrix.f, zoom: matrix.a }
      })
    // Computed transform matrices round to six significant digits in Chromium.
    const near = (actual, expected, message) =>
      assert(Math.abs(actual - expected) < 0.01, message + ': ' + actual + ' != ' + expected)
    await settle()
    assert.equal(await canvas.locator('.life-canvas-node').count(), 400)
    assert.equal(await canvas.locator('.life-canvas-edges > g').count(), 1500)
    checks.push('All 400 nodes and 1,500 labeled relationships remain rendered in a dense scene')

    const initial = await camera()
    await page.evaluate(() => {
      const element = document.querySelector('.life-canvas')
      for (let index = 0; index < 12; index++)
        element.dispatchEvent(
          new WheelEvent('wheel', { deltaX: 3, deltaY: 7, bubbles: true, cancelable: true }),
        )
    })
    await settle()
    const panned = await camera()
    near(panned.x, initial.x - 36, 'Every horizontal delta in a wheel burst is preserved')
    near(panned.y, initial.y - 84, 'Every vertical delta in a wheel burst is preserved')
    await page.evaluate(() =>
      document.querySelector('.life-canvas').dispatchEvent(
        new WheelEvent('wheel', {
          deltaX: 2,
          deltaY: 3,
          deltaMode: 1,
          shiftKey: true,
          bubbles: true,
          cancelable: true,
        }),
      ),
    )
    await settle()
    const shifted = await camera()
    near(shifted.x, panned.x - 54, 'Shift-wheel swaps axes and preserves line units')
    near(shifted.y, panned.y - 36, 'Shift-wheel preserves both axes')
    checks.push('Wheel bursts, shifted axes and line units accumulate exactly')

    await page.evaluate(() => {
      const element = document.querySelector('.life-canvas')
      for (let index = 0; index < 4; index++)
        element.dispatchEvent(
          new WheelEvent('wheel', {
            deltaY: -30,
            ctrlKey: true,
            clientX: 391,
            clientY: 257,
            bubbles: true,
            cancelable: true,
          }),
        )
    })
    await settle()
    const zoomed = await camera()
    const ratio = zoomed.zoom / shifted.zoom
    near(
      zoomed.x,
      391 - (391 - shifted.x) * ratio,
      'Repeated zoom preserves the pointer world position on x',
    )
    near(
      zoomed.y,
      257 - (257 - shifted.y) * ratio,
      'Repeated zoom preserves the pointer world position on y',
    )
    near(
      zoomed.zoom,
      shifted.zoom * Math.exp(4 * 30 * 0.006),
      'Every zoom delta in a burst is applied',
    )
    assert.equal(
      await canvas.locator('.life-canvas-tools > span').textContent(),
      Math.round(zoomed.zoom * 100) + '%',
    )
    checks.push(
      'Repeated pointer-centered pinch zoom preserves its world point and updates the percentage',
    )

    await canvas.focus()
    await page.keyboard.press('ArrowRight')
    await settle()
    near((await camera()).x, zoomed.x - 40, 'Keyboard pan remains accessible')
    await page.keyboard.press('Shift+ArrowDown')
    await settle()
    near((await camera()).y, zoomed.y - 120, 'Accelerated keyboard pan remains accessible')
    await page.keyboard.press('0')
    await settle()
    const fitted = await camera()
    near(fitted.x, initial.x, 'Fit restores initial horizontal framing')
    near(fitted.y, initial.y, 'Fit restores initial vertical framing')
    checks.push('Keyboard arrows, accelerated movement and fit retain their behavior')

    await canvas.getByRole('button', { name: 'Zoom in', exact: true }).click()
    await settle()
    near((await camera()).zoom, fitted.zoom * 1.2, 'Zoom in tool works')
    await canvas.getByRole('button', { name: 'Zoom out', exact: true }).click()
    await settle()
    near((await camera()).zoom, fitted.zoom, 'Zoom out tool works')
    await canvas.getByRole('button', { name: 'Fit map', exact: true }).click()
    await settle()
    const beforeOverlay = await camera()
    await canvas.getByRole('button', { name: 'Canvas overlay action' }).click()
    await page.evaluate(() =>
      document
        .querySelector('.life-canvas-overlay button')
        .dispatchEvent(new WheelEvent('wheel', { deltaY: 150, bubbles: true, cancelable: true })),
    )
    await settle()
    assert.deepEqual(await camera(), beforeOverlay)
    checks.push(
      'Zoom/fit controls and overlay buttons remain interactive without triggering canvas pan',
    )

    await page.evaluate(() =>
      document.querySelector('.life-canvas').dispatchEvent(
        new WheelEvent('wheel', {
          deltaY: -1000,
          metaKey: true,
          clientX: 391,
          clientY: 257,
          bubbles: true,
          cancelable: true,
        }),
      ),
    )
    await settle()
    near((await camera()).zoom, 1.75, 'Pinch zoom respects the upper limit')
    assert.equal(
      await canvas.getByRole('button', { name: 'Zoom in', exact: true }).isDisabled(),
      true,
    )
    await page.evaluate(() =>
      document.querySelector('.life-canvas').dispatchEvent(
        new WheelEvent('wheel', {
          deltaY: 1000,
          ctrlKey: true,
          clientX: 391,
          clientY: 257,
          bubbles: true,
          cancelable: true,
        }),
      ),
    )
    await settle()
    near((await camera()).zoom, 0.25, 'Pinch zoom respects the lower limit')
    assert.equal(
      await canvas.getByRole('button', { name: 'Zoom out', exact: true }).isDisabled(),
      true,
    )
    await canvas.focus()
    await page.keyboard.press('+')
    await settle()
    near((await camera()).zoom, 0.3, 'Keyboard zoom in works')
    await page.keyboard.press('-')
    await settle()
    near((await camera()).zoom, 0.25, 'Keyboard zoom out works')
    await page.evaluate(() => {
      const element = document.querySelector('.life-canvas')
      element.dispatchEvent(
        new WheelEvent('wheel', { deltaY: -100, ctrlKey: true, bubbles: true, cancelable: true }),
      )
      element.dispatchEvent(
        new KeyboardEvent('keydown', { key: '0', bubbles: true, cancelable: true }),
      )
    })
    await settle()
    assert.deepEqual(await camera(), fitted)
    checks.push(
      'Zoom limits and keyboard controls remain accurate, and fitting supersedes a queued camera frame',
    )

    await page.evaluate(() => {
      document
        .querySelector('.life-canvas')
        .dispatchEvent(
          new WheelEvent('wheel', { deltaX: 10, deltaY: 15, bubbles: true, cancelable: true }),
        )
      document.querySelector('[aria-label="Inspect record 399"]').focus()
    })
    await settle()
    const focused = await camera()
    near(
      focused.x,
      600 - (19 * 280 + 120) * focused.zoom,
      'Focusing an offscreen node centers it on x',
    )
    near(
      focused.y,
      400 - (19 * 120 + 45) * focused.zoom,
      'Focusing an offscreen node centers it on y',
    )
    await page.keyboard.press('Enter')
    assert.equal(await page.evaluate(() => window.canvasEdits.at(-1)), 399)
    checks.push(
      'Offscreen focus supersedes a queued pan and keyboard activation still opens its complete record',
    )

    await page.evaluate(() => window.resetCanvas())
    await settle()
    const beforeDrag = await camera()
    // The bottom-right corner is empty canvas after fit, away from nodes/tools.
    await page.mouse.move(1160, 760)
    await page.mouse.down()
    await page.mouse.move(1090, 725, { steps: 10 })
    await page.mouse.up()
    await settle()
    const dragged = await camera()
    near(dragged.x, beforeDrag.x - 70, 'Pointer capture preserves drag x')
    near(dragged.y, beforeDrag.y - 35, 'Pointer capture preserves drag y')
    assert.equal(
      await canvas.evaluate((element) => element.classList.contains('is-panning')),
      false,
    )
    checks.push(
      'Captured pointer dragging preserves its entire movement and clears the panning state',
    )

    for (const type of ['pointercancel', 'lostpointercapture']) {
      await page.mouse.move(1160, 760)
      await page.mouse.down()
      await page.evaluate(
        (type) =>
          document
            .querySelector('.life-canvas')
            .dispatchEvent(
              new PointerEvent(type, { pointerId: window.canvasPointerId, bubbles: true }),
            ),
        type,
      )
      await settle()
      assert.equal(
        await canvas.evaluate((element) => element.classList.contains('is-panning')),
        false,
      )
      const cancelled = await camera()
      await page.mouse.move(1140, 740)
      await page.mouse.up()
      await settle()
      assert.deepEqual(await camera(), cancelled)
    }
    checks.push(
      'Pointer cancellation and lost capture end the drag without applying subsequent movements',
    )

    const originalPath = await canvas
      .locator('.life-canvas-edges > g > path')
      .first()
      .getAttribute('d')
    await page.evaluate(() => window.updateCanvasScene())
    await settle()
    assert.notEqual(
      await canvas.locator('.life-canvas-edges > g > path').first().getAttribute('d'),
      originalPath,
    )
    assert.equal(
      await canvas.locator('.life-canvas-edges > g > text').first().textContent(),
      'changed relationship',
    )
    assert.equal(
      await canvas
        .locator('.life-canvas-node')
        .first()
        .evaluate((element) => element.style.left),
      '125px',
    )
    await page.evaluate(() =>
      document.querySelector('[aria-label="Inspect updated record"]').focus(),
    )
    await page.keyboard.press('Enter')
    assert.equal(await page.evaluate(() => window.canvasEdits.at(-1)), 'updated')
    checks.push(
      'Editing graph data refreshes geometry, labels, position and the active record handler',
    )

    await page.setViewportSize({ width: 1000, height: 650 })
    await settle()
    await canvas.getByRole('button', { name: 'Fit map', exact: true }).click()
    await settle()
    const resized = await camera()
    near(resized.x, 500 - 2780 * resized.zoom, 'Resize refits to the actual viewport width')
    near(resized.y, 325 - 1185 * resized.zoom, 'Resize refits to the actual viewport height')
    checks.push('Resize and fit recompute framing from current graph geometry')

    await page.evaluate(() => window.resetCanvas())
    await settle()
    const benchmark = await page.evaluate(async () => {
      const element = document.querySelector('.life-canvas')
      const frames = []
      const commitStart = window.canvasCommits.length
      window.canvasGeometryReads = 0
      let previous = performance.now()
      for (let frame = 0; frame < 120; frame++) {
        await new Promise((resolve) => requestAnimationFrame(resolve))
        const now = performance.now()
        frames.push(now - previous)
        previous = now
        for (let burst = 0; burst < 8; burst++) {
          element.dispatchEvent(
            new WheelEvent('wheel', {
              deltaX: frame % 2 ? 2 : -2,
              deltaY: frame % 2 ? -1 : 1,
              bubbles: true,
              cancelable: true,
            }),
          )
        }
      }
      await new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)))
      const commits = window.canvasCommits
        .slice(commitStart)
        .filter((commit) => commit.phase !== 'mount')
      const durations = commits.map((commit) => commit.actualDuration).sort((a, b) => a - b)
      const sortedFrames = frames.slice(1).sort((a, b) => a - b)
      return {
        scene: { nodes: 400, edges: 1500 },
        geometryReads: window.canvasGeometryReads,
        frames: 120,
        wheelEvents: 960,
        reactCommits: commits.length,
        totalReactMs: durations.reduce((sum, value) => sum + value, 0),
        reactP50Ms: durations[Math.floor(durations.length * 0.5)] || 0,
        reactP95Ms: durations[Math.floor(durations.length * 0.95)] || 0,
        frameP50Ms: sortedFrames[Math.floor(sortedFrames.length * 0.5)],
        frameP95Ms: sortedFrames[Math.floor(sortedFrames.length * 0.95)],
        framesOver25Ms: frames.filter((value) => value > 25).length,
      }
    })
    if (!process.env.LIFE_GRAPH_CANVAS_SOURCE)
      assert.equal(
        benchmark.geometryReads,
        0,
        'Camera frames must not rebuild or traverse unchanged graph geometry',
      )
    checks.push('A 120-frame dense scene wheel benchmark completes with 960 input events')
    assert.deepEqual(errors, [])
    await page.screenshot({ path: join(artifacts, 'dense-map.png') })
    const pendingFrames = await page.evaluate(() => {
      const element = document.querySelector('.life-canvas')
      element.dispatchEvent(
        new WheelEvent('wheel', { deltaX: 10, deltaY: 15, bubbles: true, cancelable: true }),
      )
      window.unmountCanvas()
      return window.pendingCanvasFrames.size
    })
    assert.equal(pendingFrames, 0, 'Unmount must cancel its queued animation frame')
    await settle()
    assert.equal(await page.locator('.life-canvas').count(), 0)
    checks.push('Unmount cancels a queued camera frame and leaves no detached canvas')
    const proof = { ok: true, profiling, strictMode, source, checks, errors, benchmark }
    await writeFile(join(artifacts, 'proof.json'), JSON.stringify(proof, null, 2) + '\n')
    process.stdout.write(JSON.stringify(proof, null, 2) + '\n')
  } catch (error) {
    if (page) await page.screenshot({ path: join(artifacts, 'failure.png') }).catch(() => {})
    throw error
  } finally {
    await browser?.close()
    await new Promise((resolve) => (server ? server.close(resolve) : resolve()))
    await rm(directory, { recursive: true, force: true })
  }
}

main().catch((error) => {
  console.error(error)
  process.exitCode = 1
})
