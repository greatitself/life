#!/usr/bin/env node
// Exercise the production workspace surfaces with immutable native thread snapshots.
// Before: node tests/workspace-surfaces-performance.cjs baseline --baseline-ref=a1b3facb8bc3c07b1521ed21965f4f8b88acd268
// After: node tests/workspace-surfaces-performance.cjs current
const assert = require('node:assert/strict')
const { createServer } = require('node:http')
const { mkdtemp, mkdir, readFile, writeFile, rm } = require('node:fs/promises')
const { basename, join, resolve } = require('node:path')
const { tmpdir } = require('node:os')
const { execFileSync } = require('node:child_process')
const { build } = require('esbuild')
const { chromium } = require('playwright')

async function run() {
  const label = process.argv[2] || 'current'
  assert.match(label, /^[a-z0-9-]+$/)
  const optimized = !label.includes('baseline')
  const sourceArgument = process.argv[3]
  const usesBaselineRef = sourceArgument?.startsWith('--baseline-ref=')
  const baselineRef = usesBaselineRef ? sourceArgument.slice('--baseline-ref='.length) : undefined
  if (usesBaselineRef) assert.match(baselineRef, /^[a-f0-9]{40}$/)
  const sourceDirectory = sourceArgument && !usesBaselineRef ? resolve(sourceArgument) : undefined
  const directory = await mkdtemp(join(tmpdir(), 'life-workspace-surfaces-'))
  const output = resolve(__dirname, '../output/playwright/workspace-surfaces-performance')
  await mkdir(output, { recursive: true })
  const errors = []
  let server
  let browser
  try {
    await build({
      stdin: {
        resolveDir: resolve(__dirname, '..'),
        sourcefile: 'workspace-surfaces-fixture.tsx',
        loader: 'tsx',
        contents: `
          import React, { useCallback, useEffect, useState } from 'react'
          import { createRoot } from 'react-dom/client'
          import { flushSync } from 'react-dom'
          import { WorkspaceSurfaces } from './src/renderer/components/WorkspaceSurfaces'
          import './src/renderer/styles.css'
          const probes = {roleReads:0,textReads:0,settledTextReads:0,streamTextReads:0,profileReads:0}
          const firstPull='https://github.com/openai/codex/pull/123'
          const secondPull='https://github.com/anthropics/claude-code/pull/456'
          const thirdPull='https://github.com/greatitself/life/pull/789'
          const otherPull='https://github.com/openai/codex/pull/321'
          const message=(id,role,text,stream=false,title=undefined)=>({
            id,turn:1,title,status:title?'completed':undefined,
            get role(){probes.roleReads++;return role},
            get text(){probes.textReads++;probes[stream?'streamTextReads':'settledTextReads']++;return text}
          })
          const history=Array.from({length:1200},(_,index)=>message('settled:'+index,
            index===0?'tool':'assistant',index===0?'Native agent call output':
            index===10?'Review '+firstPull:index===15?'Repeated '+firstPull:
            index===20?'Follow-up '+secondPull:'Native settled output '+index+' '+('Provider output. '.repeat(20)),
            false,index===0?'spawn_agent':undefined))
          const initial=Array.from({length:50},(_,index)=>({
            id:'thread-'+index,title:'Conversation '+index,
            get profileId(){probes.profileReads++;return 'machine'},
            workspace:index<25?'/project':'/elsewhere',provider:index%2?'claude':'codex',model:'Native model',
            messages:index===0?history:index===1?[message('other-call','tool',
              'Native second-thread agent output '+otherPull,false,'collab_agent')]:[],
            pending:[],busy:false,turn:1,updatedAt:index+1,mode:'review'
          }))
          // Preserve getters so preparing a snapshot does not itself count as a surface read.
          const replace=(thread,changes)=>Object.defineProperties({},
            {...Object.getOwnPropertyDescriptors(thread),...Object.getOwnPropertyDescriptors(changes)})
          const frames=()=>new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve)))
          const noop=()=>{}
          const resize={side:'right',value:540,min:260,max:900,reset:540,onChange:noop,onCommit:noop}
          const connection={status:'connected',workspace:'/project',profile:{id:'machine',name:'Fixture host'}}
          let streamRun=0
          function Fixture(){
            const [threads,setThreads]=useState(initial)
            const [activeId,setActiveId]=useState('thread-0')
            const [terminalOpen,setTerminalOpen]=useState(false)
            const onSelectThread=useCallback(thread=>setActiveId(thread.id),[])
            useEffect(()=>{window.fixture={
              ready:true,probes,reset(){for(const key of Object.keys(probes))probes[key]=0},
              async stream(count=8,includePull=false){const samples=[];const run=++streamRun;
                for(let index=0;index<count;index++){
                  const text='Native streamed output '+run+':'+index+
                    (includePull&&index===count-1?' '+firstPull+' '+thirdPull:'')
                  const next=message('live-stream','assistant',text,true)
                  const started=performance.now()
                  flushSync(()=>setThreads(current=>current.map(thread=>thread.id==='thread-0'?
                    replace(thread,{messages:[...history,next],updatedAt:Date.now()}):thread)))
                  samples.push(performance.now()-started);await frames()
                }return samples},
              async status(busy,pending=false){flushSync(()=>setThreads(current=>current.map(thread=>
                thread.id==='thread-0'?replace(thread,{busy,pending:pending?[{id:'native-permission',kind:'permission'}]:[]}):thread)))
                await frames()},
              async select(id){flushSync(()=>setActiveId(id));await frames()},
              async feature(enabled){flushSync(()=>window.bridgeFixture.setEnabled(enabled));await frames()}
            }},[])
            return <main style={{height:'100vh',display:'flex',justifyContent:'flex-end',
              '--life-panel-width':'540px','--life-sidebar-width':'540px'}}>
              <WorkspaceSurfaces connection={connection} headerTarget={null} theme="dark"
                terminalOpen={terminalOpen} onTerminalChange={setTerminalOpen} threads={threads}
                activeThread={threads.find(thread=>thread.id===activeId)} onSelectThread={onSelectThread}
                resize={resize} onConnect={noop} onClose={noop} refreshKey={0} onAttach={noop} onTerminal={noop}/>
            </main>
          }
          createRoot(document.getElementById('root')).render(<Fixture/>);
        `,
      },
      bundle: true,
      jsx: 'automatic',
      outfile: join(directory, 'fixture.js'),
      loader: { '.woff2': 'dataurl', '.woff': 'dataurl', '.svg': 'dataurl' },
      define: { 'process.env.NODE_ENV': '"production"' },
      minify: true,
      logLevel: 'silent',
      plugins:
        sourceDirectory || baselineRef
          ? [
              {
                name: 'workspace-surfaces-source-override',
                setup(plugin) {
                  plugin.onLoad(
                    {
                      filter:
                        /\/src\/renderer\/components\/(WorkspaceSurfaces|PullRequestSurface)\.tsx$/,
                    },
                    async ({ path }) => ({
                      contents: baselineRef
                        ? execFileSync(
                            'git',
                            ['show', baselineRef + ':src/renderer/components/' + basename(path)],
                            { cwd: resolve(__dirname, '..'), encoding: 'utf8' },
                          )
                        : await readFile(join(sourceDirectory, basename(path)), 'utf8'),
                      loader: 'tsx',
                    }),
                  )
                },
              },
            ]
          : [],
    })
    const html = `<!doctype html><html lang="en" data-theme="dark"><head><meta charset="utf-8">
      <title>Life workspace surface fixture</title><link rel="stylesheet" href="/fixture.css"></head>
      <body><div id="root"></div><script>
        const listeners=new Set();let revision=1
        let snapshot={builtInRevision:revision,extensions:[]}
        window.bridgeFixture={executeCalls:[],setEnabled(enabled){
          snapshot={builtInRevision:++revision,extensions:[{id:'builtin-source-e143e0e038ea',builtIn:true,enabled,deleted:false}]}
          for(const listener of listeners)listener(snapshot)
        }}
        window.relay={sourceCode:{get:async()=>snapshot,onState(listener){listeners.add(listener);return()=>listeners.delete(listener)}},
          connection:{execute:async input=>{
            window.bridgeFixture.executeCalls.push(input)
            const match=input.command.match(/gh pr view (\\d+) --repo ([^ ]+)/)
            const number=match?Number(match[1]):999
            const repository=match?match[2]:'greatitself/life'
            return JSON.stringify({number,title:'Mock pull request '+number,url:'https://github.com/'+repository+'/pull/'+number,
              state:'OPEN',isDraft:false,headRefName:'feature',baseRefName:'main',author:{login:'fixture'},body:'Native gh fixture output'})
          }}}
      </script><script src="/fixture.js"></script></body></html>`
    server = createServer(async (request, response) => {
      const name = ['fixture.js', 'fixture.css'].find((name) => request.url === '/' + name)
      response.setHeader(
        'Content-Type',
        name?.endsWith('.js') ? 'text/javascript' : name ? 'text/css' : 'text/html',
      )
      response.end(name ? await readFile(join(directory, name)) : html)
    })
    await new Promise((ready) => server.listen(0, '127.0.0.1', ready))
    browser = await chromium.launch({ headless: true })
    const page = await browser.newPage({ viewport: { width: 1100, height: 850 } })
    page.on('pageerror', (error) => errors.push(error.message))
    await page.goto('http://127.0.0.1:' + server.address().port)
    await page.waitForFunction(() => window.fixture?.ready)
    await page.locator('.surface-picker').waitFor()
    const readProbes = () => page.evaluate(() => ({ ...window.fixture.probes }))
    const reset = () => page.evaluate(() => window.fixture.reset())
    const openPicker = () =>
      page.getByRole('button', { name: 'Open a surface', exact: true }).click()
    const pick = (name) => page.locator('.surface-picker').getByText(name, { exact: true }).click()
    const linkedPanel = page.locator('#surface-panel-linked-pull-requests')
    const agentsPanel = page.locator('#surface-panel-agents')
    const linkNames = () =>
      linkedPanel
        .locator('.surface-linked-list button span')
        .evaluateAll((spans) => spans.map((span) => span.textContent))
    const firstPull = 'openai/codex/pull/123'
    const secondPull = 'anthropics/claude-code/pull/456'
    const thirdPull = 'greatitself/life/pull/789'
    const otherPull = 'openai/codex/pull/321'
    const hidden = async (includePull = false) => {
      await reset()
      const samples = await page.evaluate(
        (includePull) => window.fixture.stream(8, includePull),
        includePull,
      )
      const reads = await readProbes()
      if (optimized)
        for (const [key, count] of Object.entries(reads))
          assert.equal(count, 0, `Hidden surfaces read ${key} during streamed output`)
      return { samples, reads }
    }

    const initialPicker = await hidden()
    await pick('Agents')
    await agentsPanel.waitFor({ state: 'visible' })
    assert.equal(await agentsPanel.locator('.surface-agent-row').count(), 25)
    const activeRow = agentsPanel
      .locator('.surface-agent-row')
      .filter({ hasText: 'Conversation 0' })
    assert.equal(await activeRow.getAttribute('aria-current'), 'true')
    assert.equal(await activeRow.locator('.surface-status').textContent(), 'Idle')
    const detail = agentsPanel.locator('.surface-agent-call').filter({ hasText: 'spawn_agent' })
    await detail.locator('summary').click()
    assert.equal(await detail.locator('pre').textContent(), 'Native agent call output')
    assert.equal(await detail.evaluate((element) => element.open), true)
    await page.evaluate(() => window.fixture.status(true, true))
    assert.equal(await activeRow.locator('.surface-status').textContent(), 'Waiting for you')
    assert.ok(
      (await agentsPanel.locator('.surface-section-heading').first().textContent()).includes(
        '1 running',
      ),
    )
    await page.evaluate(() => window.fixture.status(true))
    assert.equal(await activeRow.locator('.surface-status').textContent(), 'Running')
    await page.evaluate(() => window.fixture.status(false))
    assert.equal(await activeRow.locator('.surface-status').textContent(), 'Idle')
    assert.ok(
      (await agentsPanel.locator('.surface-section-heading').first().textContent()).includes(
        '0 running',
      ),
    )

    await openPicker()
    const hiddenPicker = await hidden()
    await pick('Pull request')
    await page
      .locator('#surface-panel-pull-request')
      .getByRole('heading', { name: 'Mock pull request 999' })
      .waitFor()
    const ordinaryPullRequest = await hidden()

    await openPicker()
    await reset()
    await pick('Linked pull requests')
    await linkedPanel.locator('.surface-linked-list').waitFor()
    assert.deepEqual(await linkNames(), [firstPull, secondPull])
    const initialLinkedReads = await readProbes()
    if (optimized) {
      assert.equal(initialLinkedReads.settledTextReads, 1200)
      assert.equal(initialLinkedReads.streamTextReads, 1)
      assert.equal(initialLinkedReads.roleReads, 0)
      assert.equal(initialLinkedReads.profileReads, 0)
    }
    await reset()
    const linkedSamples = await page.evaluate(() => window.fixture.stream(12, true))
    const linkedReads = await readProbes()
    if (optimized) {
      assert.equal(linkedReads.settledTextReads, 0, 'Settled linked-PR text was rescanned')
      assert.equal(linkedReads.streamTextReads, 12)
      assert.equal(linkedReads.textReads, 12)
      assert.equal(linkedReads.roleReads, 0)
      assert.equal(linkedReads.profileReads, 0)
    }
    assert.deepEqual(await linkNames(), [firstPull, secondPull, thirdPull])
    await openPicker()
    const hiddenMountedPicker = await hidden(true)
    await page.getByRole('tab', { name: 'Pull request', exact: true }).click()
    await page
      .locator('#surface-panel-pull-request')
      .getByRole('heading', { name: 'Mock pull request 999' })
      .waitFor()
    const hiddenMountedOrdinaryPullRequest = await hidden(true)
    await page.getByRole('tab', { name: 'Linked pull requests', exact: true }).click()
    assert.deepEqual(await linkNames(), [firstPull, secondPull, thirdPull])
    await linkedPanel.getByRole('button', { name: firstPull, exact: true }).click()
    await linkedPanel.getByRole('heading', { name: 'Mock pull request 123' }).waitFor()
    assert.equal(
      await linkedPanel.getByRole('link', { name: 'Open on GitHub' }).getAttribute('href'),
      'https://github.com/' + firstPull,
    )
    assert.equal(
      await linkedPanel.locator('.surface-pull-detail pre').textContent(),
      'Native gh fixture output',
    )
    const execution = await page.evaluate(() => window.bridgeFixture.executeCalls.at(-1))
    assert.equal(execution.workspace, '/project')
    assert.equal(execution.timeoutMs, 30000)
    assert.match(execution.command, /^gh pr view 123 --repo openai\/codex --json /)
    await linkedPanel.getByRole('button', { name: 'Back to linked pull requests' }).click()
    assert.deepEqual(await linkNames(), [firstPull, secondPull, thirdPull])

    await page.evaluate(() => window.fixture.status(true, true))
    await page.getByRole('tab', { name: 'Agents', exact: true }).click()
    await agentsPanel.waitFor({ state: 'visible' })
    assert.equal(await activeRow.locator('.surface-status').textContent(), 'Waiting for you')
    assert.equal(
      await detail.evaluate((element) => element.open),
      true,
      'Expanded agent call was lost when the pane was hidden',
    )
    await page.evaluate(() => window.fixture.status(false))
    await page.getByRole('tab', { name: 'Linked pull requests', exact: true }).click()
    await linkedPanel.getByRole('button', { name: secondPull, exact: true }).click()
    await linkedPanel.getByRole('heading', { name: 'Mock pull request 456' }).waitFor()
    await page.evaluate(() => window.fixture.select('thread-1'))
    await linkedPanel.locator('.surface-linked-list').waitFor()
    assert.deepEqual(
      await linkNames(),
      [otherPull],
      'Thread selection retained links from the previous thread',
    )
    await page.getByRole('tab', { name: 'Agents', exact: true }).click()
    const otherRow = agentsPanel.locator('.surface-agent-row').filter({
      has: page.getByText('Conversation 1', { exact: true }),
    })
    assert.equal(
      await otherRow.getAttribute('aria-current'),
      'true',
      'Reopened Agents used a stale hidden selection',
    )
    assert.equal(await agentsPanel.locator('.surface-agent-call summary').count(), 1)
    assert.ok(
      (await agentsPanel.locator('.surface-agent-call summary').textContent()).includes(
        'collab_agent',
      ),
    )
    assert.ok(
      (await agentsPanel.locator('.surface-agent-call pre').textContent()).includes(otherPull),
    )
    await activeRow.click()
    assert.equal(await activeRow.getAttribute('aria-current'), 'true')
    await page.getByRole('tab', { name: 'Linked pull requests', exact: true }).click()
    assert.deepEqual(await linkNames(), [firstPull, secondPull, thirdPull])

    // Re-enabling the native feature remounts existing panes while the picker is visible.
    await openPicker()
    await page.evaluate(() => window.fixture.feature(false))
    assert.equal(await page.locator('#life-workspace-surfaces').count(), 0)
    await reset()
    await page.evaluate(() => window.fixture.feature(true))
    await page.locator('.surface-picker').waitFor()
    const inactiveMountReads = await readProbes()
    if (optimized)
      for (const [key, count] of Object.entries(inactiveMountReads))
        assert.equal(count, 0, `Initially hidden mounted panes read ${key}`)
    await page.getByRole('tab', { name: 'Linked pull requests', exact: true }).click()
    assert.deepEqual(await linkNames(), [firstPull, secondPull, thirdPull])
    assert.deepEqual(errors, [])
    await page.screenshot({ path: join(output, label + '.png'), fullPage: true })
    await writeFile(join(output, label + '.aria.txt'), await page.locator('#root').ariaSnapshot())
    const stats = (samples) => {
      const sorted = [...samples].sort((a, b) => a - b)
      return {
        samples: samples.length,
        medianMs: +sorted[Math.floor(sorted.length / 2)].toFixed(2),
        p95Ms: +sorted[Math.floor(sorted.length * 0.95)].toFixed(2),
      }
    }
    const measurement = ({ samples, reads }) => ({ ...stats(samples), ...reads })
    const proof = {
      label,
      baselineRef,
      sourceDirectory,
      fixture: {
        threads: 50,
        activeMessages: 1200,
        streamingMessages: 1,
        scopedThreads: 25,
        productionReact: true,
        cpuThrottle: 1,
        upstream: 'Native-shaped bridge fixture; no authenticated upstream provider session',
        timing: 'Synchronous React updates; getter counts are the performance invariant',
      },
      initialPicker: measurement(initialPicker),
      hiddenAgentsPicker: measurement(hiddenPicker),
      ordinaryPullRequest: measurement(ordinaryPullRequest),
      hiddenMountedPicker: measurement(hiddenMountedPicker),
      hiddenMountedOrdinaryPullRequest: measurement(hiddenMountedOrdinaryPullRequest),
      linkedPullRequestsInitial: initialLinkedReads,
      linkedPullRequestsStreaming: { ...stats(linkedSamples), ...linkedReads },
      inactiveMount: inactiveMountReads,
      checks: [
        'Project ownership scopes Agents to the connected workspace',
        'Native busy and pending status changes remain visible',
        'Native status changed while hidden appears when Agents reopens',
        'Expanded agent detail remains open after hiding and reopening',
        'Unique pull request links retain first occurrence order',
        'Linked pull request click and back use the native gh command',
        'Thread switching resets pull request detail and displays the new thread links',
        'Hidden selection changes become current when Agents reopens',
        'Selecting an Agents row updates the active thread',
        'Native feature re-enables the retained surface tabs',
      ],
      performanceAssertions: optimized
        ? [
            'Hidden picker and ordinary pull request do not scan thread fields',
            'Linked pull request scans settled text once and only new immutable streamed text afterward',
            'Re-enabled hidden panes defer scanning until visible',
          ]
        : [],
      errors,
    }
    await writeFile(join(output, label + '.json'), JSON.stringify(proof, null, 2) + '\n')
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
