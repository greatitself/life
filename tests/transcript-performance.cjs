#!/usr/bin/env node
// Reproducible production-renderer benchmark; comparisons use the same fixture and CPU throttle.
const assert = require('node:assert/strict')
const { createServer } = require('node:http')
const { mkdtemp, mkdir, readFile, writeFile, rm } = require('node:fs/promises')
const { join, resolve } = require('node:path')
const { tmpdir } = require('node:os')
const { build } = require('esbuild')
const { chromium } = require('playwright')
const { execFileSync } = require('node:child_process')

async function run() {
  const label = process.argv[2] || 'current'
  assert.match(label, /^[a-z0-9-]+$/)
  const directory = await mkdtemp(join(tmpdir(), 'life-transcript-performance-'))
  const output = resolve(__dirname, '../output/playwright/transcript-performance-v011')
  await mkdir(output, { recursive: true })
  let browser
  let server
  const errors = []
  const baselineRevision = label.startsWith('before') ? '475a014' : undefined
  try {
    await build({
      stdin: {
        resolveDir: resolve(__dirname, '..'),
        sourcefile: 'transcript-performance-fixture.tsx',
        loader: 'tsx',
        contents: `
          import React, { useEffect, useState } from 'react'
          import { createRoot } from 'react-dom/client'
          import { flushSync } from 'react-dom'
          import { ThreadTimeline } from './src/renderer/components/ThreadTimeline'
          import { useConversationScroll } from './src/renderer/conversation-scroll'
          import { applyEvent } from './src/renderer/state'
          import './src/renderer/styles.css'
          import './src/renderer/workspace-presentation.css'
          const markdown = '## Verified result\\n\\n| Check | Outcome |\\n| --- | --- |\\n| Context | Preserved |\\n| Output | Complete |\\n\\n' + ('A detailed finding with **emphasis**, a [source](https://example.com), and useful context.\\n\\n').repeat(12) + '\\x60\\x60\\x60ts\\nconst result = 42;\\n\\x60\\x60\\x60\\n'
          const raw = 'FULL-OUTPUT-BEGIN\\n' + 'Exact tool output with <angle> and line endings.\\r\\n'.repeat(7000) + 'FULL-OUTPUT-END\\n'
          function history(id) {
            const messages = []
            for (let turn = 1; turn <= 250; turn++) {
              messages.push({ id:id+':'+turn+':user', role:'user', text:'Inspect turn '+turn, turn, createdAt:1, finishedAt:1000, finishStatus:'completed' })
              messages.push({ id:id+':'+turn+':final', role:'assistant', phase:'final_answer', text:markdown.replace('Verified result','Verified result '+id+' '+turn), turn })
            }
            const turn = 251
            messages.push({ id:id+':active-user', role:'user', text:'Continue with the active tools and summaries.', turn, createdAt:Date.now() })
            for (let item=0; item<80; item++) messages.push({ id:id+':tool-'+item, role:'tool', title:'Bash', text:raw, input:'cat output-'+item+'.log', status:'completed', turn })
            for (let item=0; item<20; item++) messages.push({ id:id+':summary-'+item, role:'assistant', kind:'reasoning', text:'Verified summary '+item+'\\n'+raw, turn })
            messages.push({ id:'251:live', role:'assistant', phase:'commentary', text:'Live response.\\n\\n', turn })
            return {id,profileId:'machine',provider:'codex',workspace:'/project',title:'Benchmark',messages,pending:[],busy:true,turnStatus:'running',turn,updatedAt:1,model:'test',mode:'review'}
          }
          const initialA=history('a'), initialB=history('b')
          const frames=()=>new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve)))
          function Fixture() {
            const [thread,setThread]=useState(initialA)
            const [view,setView]=useState('agents')
            const [draft,setDraft]=useState('')
            const scroll=useConversationScroll(view+':'+thread.id,{messages:thread.messages})
            useEffect(()=>{
              window.fixture={
                ready:true,
                rawCharacters:raw.length,
                async switchThread(id){ const start=performance.now(); flushSync(()=>setThread(id==='a'?initialA:initialB)); await frames(); return performance.now()-start },
                async switchView(value){ const start=performance.now(); flushSync(()=>setView(value)); await frames(); return performance.now()-start },
                async stream(count=30){
                  const samples=[]
                  const commits=[]
                  for(let index=0;index<count;index++) { const start=performance.now(); flushSync(()=>setThread(current=>applyEvent(current,{sessionId:current.id,type:'text',itemId:'live',phase:'commentary',text:'Streamed update '+index+' with **formatted text**.\\n\\n'}))); commits.push(performance.now()-start); await frames(); samples.push(performance.now()-start) }
                  window.fixture.lastCommits=commits
                  return samples
                },
                latest(){scroll.setStickToBottom(true)},
                verifyCache(){flushSync(()=>setThread({...initialA,busy:false,turnStatus:'completed',turn:2,messages:[
                  {id:'copy:user-1',role:'user',text:'First copy control',turn:1,finishedAt:1,finishStatus:'completed'},
                  {id:'copy:answer-1',role:'assistant',text:markdown,phase:'final_answer',turn:1,finishedAt:1,finishStatus:'completed'},
                  {id:'copy:user-2',role:'user',text:'Second copy control',turn:2,finishedAt:1,finishStatus:'completed'},
                  {id:'copy:answer-2',role:'assistant',text:markdown,phase:'final_answer',turn:2,finishedAt:1,finishStatus:'completed'},
                ]}))},
              }
            },[scroll.setStickToBottom])
            return <div className="app-shell life-refined-layout" data-theme="dark">
              <main className="main-workspace" style={{width:900,margin:'0 auto'}}>
                <header><h1>Transcript fluidity</h1><input aria-label="Draft" placeholder="Keep typing while streaming" value={draft} onChange={event=>setDraft(event.target.value)}/><p data-surface>{view}:{thread.id}</p><p data-following={String(scroll.stickToBottom)}>Following: {String(scroll.stickToBottom)}</p></header>
                <div ref={scroll.viewportRef} data-viewport style={{height:560,overflow:'auto'}}><ThreadTimeline thread={thread}/></div>
              </main>
            </div>
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
      plugins: baselineRevision
        ? [
            {
              name: 'pinned-life-010-renderer',
              setup(plugin) {
                plugin.onLoad({ filter: /\/src\/renderer\/.*\.(tsx?|css)$/ }, ({ path }) => ({
                  contents: execFileSync(
                    'git',
                    [
                      'show',
                      baselineRevision + ':' + path.slice(resolve(__dirname, '..').length + 1),
                    ],
                    { cwd: resolve(__dirname, '..'), encoding: 'utf8' },
                  ),
                  loader: path.endsWith('.tsx') ? 'tsx' : path.endsWith('.css') ? 'css' : 'ts',
                }))
              },
            },
          ]
        : [],
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
          : '<!doctype html><html lang="en"><head><meta charset="utf-8"><link rel="stylesheet" href="/fixture.css"><style>html,body,#root{height:100%;margin:0}.app-shell{display:block;height:100vh}.main-workspace{display:block}header{padding:12px}h1{font-size:18px}input{width:500px}</style></head><body><div id="root"></div><script src="/fixture.js"></script></body></html>',
      )
    })
    await new Promise((ready) => server.listen(0, '127.0.0.1', ready))
    browser = await chromium.launch({ headless: true })
    const page = await browser.newPage({
      viewport: { width: 1100, height: 800 },
      permissions: ['clipboard-read', 'clipboard-write'],
    })
    page.on('pageerror', (error) => errors.push(error.message))
    const cdp = await page.context().newCDPSession(page)
    await cdp.send('Emulation.setCPUThrottlingRate', { rate: 2 })
    await cdp.send('Performance.enable')
    const metrics = async () =>
      Object.fromEntries(
        (await cdp.send('Performance.getMetrics')).metrics.map(({ name, value }) => [name, value]),
      )
    const difference = (before, after) =>
      Object.fromEntries(
        [
          'TaskDuration',
          'ScriptDuration',
          'LayoutDuration',
          'RecalcStyleDuration',
          'LayoutCount',
          'RecalcStyleCount',
        ].map((name) => [name, +(after[name] - before[name]).toFixed(6)]),
      )
    const beforeLoad = await metrics()
    const started = Date.now()
    await page.goto('http://127.0.0.1:' + server.address().port)
    await page.waitForFunction(() => window.fixture?.ready)
    await page.waitForLoadState('networkidle')
    const initial = { elapsedMs: Date.now() - started, ...difference(beforeLoad, await metrics()) }
    const turns = await page.locator('.thread-timeline-turn').count()
    assert.equal(turns, 251)
    const mounted = await page.locator('[data-message-id]').count()
    assert.equal(mounted, 502)
    const stats = (samples) => {
      const sorted = [...samples].sort((a, b) => a - b)
      return {
        medianMs: +sorted[Math.floor(sorted.length / 2)].toFixed(2),
        p95Ms: +sorted[Math.floor(sorted.length * 0.95)].toFixed(2),
        maxMs: +sorted.at(-1).toFixed(2),
      }
    }
    await page.evaluate(() => window.fixture.stream(3))
    const beforeStream = await metrics()
    const samples = await page.evaluate(() => window.fixture.stream(30))
    const streaming = {
      ...stats(samples),
      commit: stats(await page.evaluate(() => window.fixture.lastCommits)),
      ...difference(beforeStream, await metrics()),
    }
    const viewport = page.locator('[data-viewport]')
    await viewport.evaluate((root) => {
      root.scrollTop = 500
    })
    await page.locator('[data-following="false"]').waitFor()
    const anchor = () =>
      viewport.evaluate((root) => {
        const top = root.getBoundingClientRect().top
        const element = Array.from(root.querySelectorAll('[data-message-id]')).find((element) => {
          const rect = element.getBoundingClientRect()
          return rect.height > 0 && rect.bottom > top
        })
        return { id: element.dataset.messageId, offset: element.getBoundingClientRect().top - top }
      })
    const readingAnchor = await anchor()
    const beforeReading = await metrics()
    const readingSamples = await page.evaluate(() => window.fixture.stream(15))
    assert.deepEqual(await anchor(), readingAnchor)
    const reading = {
      ...stats(readingSamples),
      commit: stats(await page.evaluate(() => window.fixture.lastCommits)),
      ...difference(beforeReading, await metrics()),
    }
    await page.evaluate(() => window.fixture.latest())
    await page.waitForFunction(() => {
      const root = document.querySelector('[data-viewport]')
      return root.scrollHeight - root.scrollTop - root.clientHeight < 2
    })
    // Closed full-output bodies must stay lazy; explicitly opening a batch verifies unchanged bytes.
    assert.equal(await page.locator('.thread-full-output > pre').count(), 0)
    await page.locator('.thread-action-disclosure > summary').first().click()
    await page.locator('.thread-tool-card').first().waitFor()
    const tools = await page.locator('.thread-tool-card').count()
    assert.equal(tools, 80)
    const beforeExpanded = await metrics()
    const expandedSamples = await page.evaluate(() => window.fixture.stream(15))
    const expanded = {
      ...stats(expandedSamples),
      commit: stats(await page.evaluate(() => window.fixture.lastCommits)),
      ...difference(beforeExpanded, await metrics()),
    }
    const switchSamples = []
    const beforeSwitch = await metrics()
    for (let index = 0; index < 6; index++)
      switchSamples.push(
        await page.evaluate((id) => window.fixture.switchThread(id), index % 2 ? 'a' : 'b'),
      )
    const switches = {
      ...stats(switchSamples),
      firstUnseenThreadMs: +switchSamples[0].toFixed(2),
      warm: stats(switchSamples.slice(1)),
      ...difference(beforeSwitch, await metrics()),
    }
    const viewSamples = []
    for (let index = 0; index < 6; index++)
      viewSamples.push(
        await page.evaluate(
          (view) => window.fixture.switchView(view),
          index % 2 ? 'agents' : 'research',
        ),
      )
    const views = stats(viewSamples)
    await page.evaluate(() =>
      document.querySelector('[data-message-id="a:190:final"]').scrollIntoView({ block: 'center' }),
    )
    await page.locator('[data-following="false"]').waitFor()
    await page.waitForTimeout(100)
    const deepAnchor = await anchor()
    await page.evaluate(() => window.fixture.switchThread('b'))
    await page.evaluate(() => window.fixture.switchThread('a'))
    await page.waitForTimeout(100)
    assert.deepEqual(await anchor(), deepAnchor)
    await page.evaluate(() => window.fixture.switchView('research'))
    await page.evaluate(() => window.fixture.switchView('agents'))
    await page.waitForTimeout(100)
    assert.deepEqual(await anchor(), deepAnchor)
    const selectedText = await page.evaluate(() => {
      const message = document.querySelector('[data-message-id="a:190:final"] .markdown')
      const range = document.createRange()
      range.selectNodeContents(message)
      const selection = window.getSelection()
      selection.removeAllRanges()
      selection.addRange(range)
      return selection.toString()
    })
    assert.ok(selectedText.includes('Verified result a 190'))
    assert.ok(selectedText.includes('const result = 42;'))
    await page.evaluate(() => {
      window.getSelection().removeAllRanges()
      const message = document.querySelector('[data-message-id="a:230:final"]')
      message.scrollIntoView({ block: 'center' })
      message.focus()
    })
    assert.equal(await page.evaluate(() => document.activeElement.dataset.messageId), 'a:230:final')
    await page.evaluate(() => {
      window.getSelection().removeAllRanges()
      window.find('Verified result a 7')
    })
    assert.ok(
      (await page.evaluate(() => window.getSelection().toString())).includes('Verified result a 7'),
    )
    assert.equal(await page.locator('.thread-timeline-turn').count(), 251)
    await page
      .getByRole('textbox', { name: 'Draft' })
      .fill('Exact draft remains responsive and intact.')
    assert.equal(
      await page.getByRole('textbox', { name: 'Draft' }).inputValue(),
      'Exact draft remains responsive and intact.',
    )
    await page.evaluate(() => {
      window.getSelection().removeAllRanges()
      window.fixture.verifyCache()
    })
    const firstCode = page.locator('[data-message-id="copy:answer-1"] .thread-code-block')
    const secondCode = page.locator('[data-message-id="copy:answer-2"] .thread-code-block')
    await firstCode.getByRole('button', { name: 'Copy code' }).click()
    assert.equal(await page.evaluate(() => navigator.clipboard.readText()), 'const result = 42;\n')
    assert.equal(await firstCode.locator('svg.lucide-check').count(), 1)
    assert.equal(await secondCode.locator('svg.lucide-copy').count(), 1)
    assert.deepEqual(errors, [])
    const proof = {
      label,
      baselineRevision,
      fixture: {
        completedTurns: 250,
        activeToolOutputs: 80,
        largeOutputCharacters: await page.evaluate(() => window.fixture.rawCharacters),
        largeReasoningSummaries: 20,
        cpuThrottle: 2,
        productionReact: true,
      },
      initial,
      streaming,
      reading,
      expanded,
      switches,
      views,
      mountedMessages: mounted,
      expandedTools: tools,
      checks: [
        'All turn and message anchors retained',
        'History anchor unchanged during stream',
        'Large output remains lazy',
        'Expanded tool cards retained',
        'Thread and view switches complete',
        'Deep history anchor restored across thread and view switches',
        'Settled Markdown stays selectable, findable and focusable through native message jumps',
        'Exact draft preserved',
        'Identical cached Markdown descriptions mount independent code-copy controls with exact bytes',
      ],
      errors,
      completedAt: new Date().toISOString(),
    }
    await writeFile(join(output, label + '.json'), JSON.stringify(proof, null, 2) + '\n')
    await page.screenshot({ path: join(output, label + '.png') })
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
