#!/usr/bin/env node
const assert = require('node:assert/strict')
const { createServer } = require('node:http')
const { mkdtemp, mkdir, readFile, writeFile, rm } = require('node:fs/promises')
const { join, resolve } = require('node:path')
const { tmpdir } = require('node:os')
const { build } = require('esbuild')
const { chromium } = require('playwright')

async function run() {
  const directory = await mkdtemp(join(tmpdir(), 'life-settled-markdown-'))
  const output = resolve(__dirname, '../output/playwright')
  await mkdir(output, { recursive: true })
  let browser
  let server
  const errors = []
  try {
    await build({
      stdin: {
        resolveDir: resolve(__dirname, '..'),
        sourcefile: 'settled-markdown-fixture.tsx',
        loader: 'tsx',
        contents: `
          import React, { useEffect, useState } from 'react'
          import { createRoot } from 'react-dom/client'
          import { flushSync } from 'react-dom'
          import { MessageView } from './src/renderer/components/MessageView'
          import './src/renderer/styles.css'
          const code='const exact = "<tag>&\\\\\\\"";\\n\\n// Native selection ✓\\n'
          const markdown='## A complete settled result\\n\\n| Left | Right |\\n| :--- | ---: |\\n| **exact** | \\x60value\\x60 |\\n\\n[Source](https://example.com/a?q=1&v=2 "Provider title")\\n\\n\\x60\\x60\\x60ts\\n'+code+'\\x60\\x60\\x60\\n'
          const cases=[
            markdown,
            'Exact ordinary text.\\n',
            'First line\\r\\nsecond line\\r\\n',
            '\\x60\\x60\\x60ts\\r\\nExact CRLF code.\\r\\n\\x60\\x60\\x60\\r\\n',
            '> A quote\\n>\\n> - first\\n> - **second**\\n',
            '3. third\\n4. fourth\\n\\n- one\\n- two\\n',
            '[Later reference][source]\\n\\n[source]: /exact/path?q=1&v=2 "Title"\\n',
            '[Email](mailto:a@example.com), [IRC](irc://example.com), [blocked](javascript:alert%281%29)',
            '<div class="unsafe" onclick="window.injected=true">Literal HTML & text</div>\\n',
            '\\x60\\x60\\x60ts\\n</code></pre><script>window.injected=true</script>\\n\\x60\\x60\\x60',
            'Line with a hard break.  \\nNext line.\\n',
            '- [x] completed\\n- [ ] pending',
            'First reference[^note].\\n\\n[^note]: Exact footnote.',
            '![Existing image protocol](mailto:a@example.com)',
            '\\x60\\x60\\x60a&#32;b\\nhello <exact>\\n\\x60\\x60\\x60',
            '\\x60\\x60\\x60a&#9;b\\nhello <exact>\\n\\x60\\x60\\x60',
            '\\x60\\x60\\x60a&#10;b\\nhello <exact>\\n\\x60\\x60\\x60',
            '\\x60\\x60\\x60&#32;a\\nhello <exact>\\n\\x60\\x60\\x60',
            '\\x60\\x60\\x60a&#160;b\\nhello <exact>\\n\\x60\\x60\\x60',
            '\\x60\\x60\\x60a&ensp;b\\nhello <exact>\\n\\x60\\x60\\x60',
            '\\x60\\x60\\x60a&#13;b\\nhello <exact>\\n\\x60\\x60\\x60',
            'Encoded carriage return a&#13;b.',
            'Encoded carriage return a&#xD;b.',
            '\\x60\\x60\\x60ts\\n\\n\\x60\\x60\\x60',
            '~~~ts\\n\\n~~~',
            '\\x60\\x60\\x60ts\\n\\n',
            '\\x60\\x60\\x60\\n\\n\\x60\\x60\\x60',
            '\\x60\\x60\\x60ts\\n\\n\\n\\x60\\x60\\x60',
          ]
          function Fixture(){
            const [complete,setComplete]=useState(false)
            const [tick,setTick]=useState(0)
            useEffect(()=>{window.fixture={ready:true,code,markdown,complete(){flushSync(()=>setComplete(true))},rerender(){flushSync(()=>setTick(value=>value+1))}}},[])
            const message=(id,text)=>({id,role:'assistant',text,phase:'final_answer'})
            return <main className="main-workspace" data-tick={tick} style={{width:900,margin:'0 auto'}}>
              <section data-case="copy-a"><MessageView message={message('copy-a',markdown)} provider="codex" settled/></section>
              <section data-case="copy-b"><MessageView message={message('copy-b',markdown)} provider="claude" settled/></section>
              <section data-case="live"><MessageView message={message('live',markdown)} provider="codex" settled={complete}/></section>
              {cases.map((text,index)=><section key={index} data-differential={index}>
                <div data-previous><MessageView message={message('previous-'+index,text)} provider="codex"/></div>
                <div data-settled><MessageView message={message('settled-'+index,text)} provider="codex" settled/></div>
              </section>)}
            </main>
          }
          createRoot(document.getElementById('root')).render(<Fixture/>);
        `,
      },
      bundle: true,
      jsx: 'automatic',
      outfile: join(directory, 'fixture.js'),
      loader: { '.woff2': 'dataurl', '.woff': 'dataurl' },
      define: { 'process.env.NODE_ENV': '"production"' },
      minify: true,
      logLevel: 'silent',
    })
    server = createServer(async (request, response) => {
      const name = ['fixture.js', 'fixture.css'].find((name) => request.url === '/' + name)
      response.setHeader(
        'Content-Type',
        name?.endsWith('.js') ? 'text/javascript' : name ? 'text/css' : 'text/html',
      )
      response.end(
        name
          ? await readFile(join(directory, name))
          : '<!doctype html><html lang="en"><head><meta charset="utf-8"><link rel="stylesheet" href="/fixture.css"></head><body><div id="root"></div><script src="/fixture.js"></script></body></html>',
      )
    })
    await new Promise((ready) => server.listen(0, '127.0.0.1', ready))
    browser = await chromium.launch({ headless: true })
    const page = await browser.newPage({
      viewport: { width: 1100, height: 800 },
      permissions: ['clipboard-read', 'clipboard-write'],
    })
    page.on('pageerror', (error) => errors.push(error.message))
    await page.goto('http://127.0.0.1:' + server.address().port)
    await page.waitForFunction(() => window.fixture?.ready)
    const differential = await page.evaluate(() => {
      function canonical(node) {
        if (node.nodeType === Node.TEXT_NODE) return [node.textContent]
        if (!(node instanceof Element)) return []
        const children = () =>
          Array.from(node.childNodes)
            .flatMap(canonical)
            .reduce((merged, child) => {
              if (typeof child === 'string' && typeof merged.at(-1) === 'string')
                merged[merged.length - 1] += child
              else merged.push(child)
              return merged
            }, [])
        if (node.classList.contains('thread-settled-markdown')) return children()
        if (node.tagName === 'svg') return [{ tag: 'svg' }]
        const attributes = Array.from(node.attributes)
          .filter(({ name }) => name !== 'data-markdown-copy')
          .map(({ name, value }) => [name, name === 'style' ? node.style.cssText : value])
          .sort((a, b) => a[0].localeCompare(b[0]))
        return [{ tag: node.tagName, attributes, children: children() }]
      }
      return Array.from(document.querySelectorAll('[data-differential]')).map((item) => ({
        index: item.dataset.differential,
        previous: canonical(item.querySelector('[data-previous] .markdown')),
        settled: canonical(item.querySelector('[data-settled] .markdown')),
      }))
    })
    for (const example of differential)
      assert.deepEqual(
        example.settled,
        example.previous,
        'Exact DOM semantics for Markdown example ' + example.index,
      )
    for (const example of differential) {
      const pair = page.locator(`[data-differential="${example.index}"]`)
      const previous = pair.locator('[data-previous]')
      const settled = pair.locator('[data-settled]')
      if (!(await previous.locator('.thread-code-block').count())) continue
      const exactCode = await previous.locator('.thread-code-block > pre').textContent()
      await previous.getByRole('button', { name: 'Copy code', exact: true }).click()
      assert.equal(await page.evaluate(() => navigator.clipboard.readText()), exactCode)
      await settled.getByRole('button', { name: 'Copy code', exact: true }).click()
      assert.equal(await page.evaluate(() => navigator.clipboard.readText()), exactCode)
    }
    const encodedCR = await page.evaluate(() =>
      Array.from(document.querySelectorAll('[data-differential]'))
        .filter((item) =>
          item.querySelector('[data-previous] .markdown').textContent.includes('\r'),
        )
        .map((item) => item.dataset.differential),
    )
    assert.equal(encodedCR.length, 3)
    for (const index of encodedCR) {
      const select = async (side) =>
        page.evaluate(
          ({ index, side }) => {
            const body = document.querySelector(
              `[data-differential="${index}"] [data-${side}] .markdown`,
            )
            const range = document.createRange()
            range.selectNodeContents(body)
            const selection = window.getSelection()
            selection.removeAllRanges()
            selection.addRange(range)
            return { text: body.textContent, selected: selection.toString() }
          },
          { index, side },
        )
      const previous = await select('previous')
      await page.keyboard.press('Control+c')
      const previousCopy = await page.evaluate(() => navigator.clipboard.readText())
      assert.deepEqual(await select('settled'), previous)
      await page.keyboard.press('Control+c')
      assert.equal(await page.evaluate(() => navigator.clipboard.readText()), previousCopy)
    }
    const first = page.locator('[data-case="copy-a"]')
    const second = page.locator('[data-case="copy-b"]')
    assert.equal(await first.locator('.thread-settled-markdown').count(), 1)
    await first.getByRole('button', { name: 'Copy code', exact: true }).click()
    await first.locator('svg.lucide-check').waitFor()
    assert.equal(
      await page.evaluate(() => navigator.clipboard.readText()),
      await page.evaluate(() => window.fixture.code),
    )
    assert.equal(await second.locator('svg.lucide-copy').count(), 2)
    await second.getByRole('button', { name: 'Copy code', exact: true }).click()
    assert.equal(
      await page.evaluate(() => navigator.clipboard.readText()),
      await page.evaluate(() => window.fixture.code),
    )
    await first.getByRole('button', { name: 'Copy message', exact: true }).click()
    assert.equal(
      await page.evaluate(() => navigator.clipboard.readText()),
      await page.evaluate(() => window.fixture.markdown),
    )
    const liveState = await page.evaluate(() => {
      const message = document.querySelector('[data-case="live"] .markdown')
      const pre = message.querySelector('pre')
      pre.focus()
      const range = document.createRange()
      range.selectNodeContents(pre)
      const selection = window.getSelection()
      selection.removeAllRanges()
      selection.addRange(range)
      window.livePre = pre
      return { text: selection.toString(), focused: document.activeElement === pre }
    })
    assert.equal(liveState.text, await page.evaluate(() => window.fixture.code.slice(0, -1)))
    assert.equal(
      await page.evaluate(() => window.livePre.textContent),
      await page.evaluate(() => window.fixture.code),
    )
    assert.equal(liveState.focused, true)
    await page.evaluate(() => {
      window.fixture.complete()
      window.fixture.rerender()
    })
    assert.equal(await page.locator('[data-case="live"] .thread-settled-markdown').count(), 0)
    assert.deepEqual(
      await page.evaluate(() => ({
        text: window.getSelection().toString(),
        focused: document.activeElement === window.livePre,
        sameNode: document.querySelector('[data-case="live"] pre') === window.livePre,
      })),
      { text: liveState.text, focused: true, sameNode: true },
    )
    const settledState = await page.evaluate(() => {
      const pre = document.querySelector('[data-case="copy-a"] pre')
      pre.focus()
      const range = document.createRange()
      range.selectNodeContents(pre)
      const selection = window.getSelection()
      selection.removeAllRanges()
      selection.addRange(range)
      window.settledPre = pre
      window.fixture.rerender()
      return {
        text: selection.toString(),
        focused: document.activeElement === pre,
        sameNode: document.querySelector('[data-case="copy-a"] pre') === pre,
      }
    })
    assert.deepEqual(settledState, { text: liveState.text, focused: true, sameNode: true })
    assert.equal(
      await page.evaluate(() => {
        window.getSelection().removeAllRanges()
        return window.find('A complete settled result')
      }),
      true,
    )
    assert.equal(await page.evaluate(() => window.injected), undefined)
    assert.equal(await page.locator('.unsafe, .markdown script').count(), 0)
    assert.deepEqual(errors, [])
    const proof = {
      checks: [
        `${differential.length} differential DOM examples preserve exact text, attributes, structure and safe HTML behavior`,
        'Every differential code block preserves exact clipboard bytes, including decoded fence labels and blank-only fences',
        'Encoded carriage returns preserve established DOM bytes, native selection and native copy behavior',
        'Equal cached history bodies retain independent code-copy controls and exact clipboard bytes',
        'Copy message preserves exact source Markdown',
        'Live completion and unrelated rerenders retain the exact code DOM node, native selection and focus',
        'Settled rerenders retain exact code DOM node, native selection and focus',
        'Native Find reaches complete settled prose',
      ],
      errors,
      completedAt: new Date().toISOString(),
    }
    await writeFile(
      join(output, 'settled-markdown-proof.json'),
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
