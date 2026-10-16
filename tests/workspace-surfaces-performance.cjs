#!/usr/bin/env node
// Exercise the production workspace surfaces with immutable native thread snapshots.
// Run identical fixture bytes in complete reference and candidate worktrees.
// node tests/workspace-surfaces-performance.cjs t3-current-a --reference-ref=<reference SHA>
const assert = require('node:assert/strict')
const { createServer } = require('node:http')
const { mkdtemp, mkdir, readFile, writeFile, rm } = require('node:fs/promises')
const { join, resolve } = require('node:path')
const { tmpdir } = require('node:os')
const { build } = require('./helpers/browser-build.cjs')
const { chromium } = require('playwright')

async function run() {
  const label = process.argv[2] || 'current'
  assert.match(label, /^[a-z0-9-]+$/)
  const referenceArgument = process.argv[3]
  if (referenceArgument) assert.match(referenceArgument, /^--reference-ref=[a-f0-9]{40}$/)
  const referenceRef = referenceArgument?.slice('--reference-ref='.length)
  assert.equal(process.argv.length <= 4, true, 'Only a label and reference metadata are accepted')
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
          const message=(id,role,text,stream=false,title=undefined,metadata={})=>({
            id,turn:1,title,status:title?'completed':undefined,
            ...metadata,
            get role(){probes.roleReads++;return role},
            get text(){probes.textReads++;probes[stream?'streamTextReads':'settledTextReads']++;return text}
          })
          const childMetadata={
            1:{kind:'subagent',agentId:'child-alpha',agentName:'Alpha reviewer',status:'running',details:{lifecycle:'turn',agentRole:'reviewer'}},
            2:{agentId:'child-alpha',agentName:'Alpha reviewer',kind:'status',status:'running'},
            3:{kind:'subagent',agentId:'child-beta',agentName:'Beta researcher',parentAgentId:'child-alpha',status:'completed',details:{lifecycle:'turn',agentRole:'researcher'}},
            4:{kind:'subagent',agentId:'child-closed',agentName:'Closed helper',status:'stopped',details:{lifecycle:'turn'}},
            5:{kind:'subagent',agentId:'child-unknown',agentName:'Recovered helper',status:'running',activityStateUnknown:true,details:{lifecycle:'turn'}},
          }
          const history=Array.from({length:1200},(_,index)=>message('settled:'+index,
            index===0?'tool':'assistant',index===0?'Native agent call output':
            index===10?'Review '+firstPull:index===15?'Repeated '+firstPull:
            index===20?'Follow-up '+secondPull:'Native settled output '+index+' '+('Provider output. '.repeat(20)),
            false,index===0?'spawn_agent':undefined,childMetadata[index]))
          const initial=Array.from({length:50},(_,index)=>({
            id:'thread-'+index,title:'Conversation '+index,
            get profileId(){probes.profileReads++;return 'machine'},
            workspace:index<25?'/project':'/elsewhere',provider:index%2?'claude':'codex',model:'Native model',
            messages:index===0?history:index===1?[message('other-call','tool',
              'Native second-thread agent output '+otherPull,false,'collab_agent'),
              message('other-child','assistant','Native child from second thread',false,undefined,
                {kind:'subagent',agentId:'thread-b-child',agentName:'Thread B helper',status:'running',details:{lifecycle:'turn'}})]:[],
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
            const [sidebarOpen,setSidebarOpen]=useState(true)
            const [maximized,setMaximized]=useState(false)
            const [scope,setScope]=useState(connection)
            const onSelectThread=useCallback(thread=>setActiveId(thread.id),[])
            const onClose=useCallback(()=>setSidebarOpen(false),[])
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
              async sidebar(open){flushSync(()=>setSidebarOpen(open));await frames()},
              async scope(workspace,profileId='machine'){flushSync(()=>setScope({status:'connected',workspace,profile:{id:profileId,name:'Fixture host'}}));await frames()},
              async child(status,unknown=false){flushSync(()=>setThreads(current=>current.map(thread=>
                thread.id==='thread-0'?replace(thread,{messages:[...thread.messages,
                  message('child-lifecycle:'+status+':'+Date.now(),'assistant','Native lifecycle '+status,false,undefined,
                    {kind:'subagent',agentId:'child-alpha',agentName:'Alpha reviewer',status,
                      ...(unknown?{activityStateUnknown:true}:{}),details:{lifecycle:'turn',agentRole:'reviewer'}})]}):thread)));await frames()},
              async feature(enabled){flushSync(()=>window.bridgeFixture.setEnabled(enabled));await frames()}
            }},[])
            return <main style={{height:'100vh',display:'flex',justifyContent:'flex-end',
              '--life-panel-width':'540px','--life-sidebar-width':'540px'}}>
              <WorkspaceSurfaces connection={scope} headerTarget={null} theme="dark"
                terminalOpen={terminalOpen} onTerminalChange={setTerminalOpen} threads={threads}
                activeThread={threads.find(thread=>thread.id===activeId)} onSelectThread={onSelectThread}
                open={sidebarOpen} maximized={maximized} onMaximizedChange={setMaximized}
                threadScopeKey={JSON.stringify([scope.profile?.id,scope.workspace,activeId])}
                resize={resize} onConnect={noop} onClose={onClose} refreshKey={0} onAttach={noop} onTerminal={noop}/>
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
    const nativeShell =
      (await page.locator('#life-workspace-surfaces').getAttribute('data-panel-mode')) !== null
    const semanticVariant = nativeShell ? 'native-child-agents' : 'legacy-project-threads'
    const readProbes = () => page.evaluate(() => ({ ...window.fixture.probes }))
    const reset = () => page.evaluate(() => window.fixture.reset())
    const openPicker = async () => {
      if (nativeShell) {
        await page.evaluate(() => window.fixture.sidebar(false))
        await page.locator('#life-workspace-surfaces').waitFor({ state: 'hidden' })
      } else {
        await page.getByRole('button', { name: 'Open a surface', exact: true }).click()
        await page.locator('.surface-picker').waitFor({ state: 'visible' })
      }
    }
    const pick = async (name) => {
      if (nativeShell) await page.evaluate(() => window.fixture.sidebar(true))
      const tab = page.getByRole('tab', { name, exact: true })
      if (await tab.count()) {
        await tab.click()
      } else if (await page.locator('.surface-picker').isVisible()) {
        await page.locator('.surface-picker').getByText(name, { exact: true }).click()
      } else {
        await page.getByRole('button', { name: 'Add panel surface', exact: true }).click()
        await page.locator('.surface-menu').getByText(name, { exact: true }).click()
      }
    }
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
      for (const [key, count] of Object.entries(reads))
        assert.equal(count, 0, `Hidden surfaces read ${key} during streamed output`)
      return { samples, reads }
    }

    const initialPicker = await hidden()
    await pick('Agents')
    await agentsPanel.waitFor({ state: 'visible' })
    await agentsPanel.evaluate((element) => {
      window.retainedAgentsPane = element
    })

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
    assert.equal(initialLinkedReads.settledTextReads, 1200)
    assert.equal(initialLinkedReads.streamTextReads, 1)
    assert.equal(initialLinkedReads.roleReads, 0)
    assert.equal(initialLinkedReads.profileReads, 0)
    await reset()
    const linkedSamples = await page.evaluate(() => window.fixture.stream(12, true))
    const linkedReads = await readProbes()
    assert.equal(linkedReads.settledTextReads, 0, 'Settled linked-PR text was rescanned')
    assert.equal(linkedReads.streamTextReads, 12)
    assert.equal(linkedReads.textReads, 12)
    assert.equal(linkedReads.roleReads, 0)
    assert.equal(linkedReads.profileReads, 0)
    assert.deepEqual(await linkNames(), [firstPull, secondPull, thirdPull])
    await linkedPanel.evaluate((element) => {
      window.retainedLinkedPane = element
    })
    await openPicker()
    const hiddenMountedPicker = await hidden(true)
    await pick('Pull request')
    await page
      .locator('#surface-panel-pull-request')
      .getByRole('heading', { name: 'Mock pull request 999' })
      .waitFor()
    const hiddenMountedOrdinaryPullRequest = await hidden(true)
    await pick('Linked pull requests')
    assert.deepEqual(await linkNames(), [firstPull, secondPull, thirdPull])
    assert.equal(
      await linkedPanel.evaluate((element) => element === window.retainedLinkedPane),
      true,
      'Hiding a surface replaced its mounted pane',
    )
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

    await pick('Agents')
    await agentsPanel.waitFor({ state: 'visible' })
    assert.equal(
      await agentsPanel.evaluate((element) => element === window.retainedAgentsPane),
      true,
      'Hiding Agents replaced its mounted pane',
    )
    await pick('Linked pull requests')
    await linkedPanel.getByRole('button', { name: secondPull, exact: true }).click()
    await linkedPanel.getByRole('heading', { name: 'Mock pull request 456' }).waitFor()
    await page.evaluate(() => window.fixture.select('thread-1'))
    await pick('Linked pull requests')
    await linkedPanel.locator('.surface-linked-list').waitFor()
    assert.deepEqual(
      await linkNames(),
      [otherPull],
      'Thread selection retained links from the previous thread',
    )
    await page.evaluate(() => window.fixture.select('thread-0'))
    await pick('Linked pull requests')
    assert.deepEqual(await linkNames(), [firstPull, secondPull, thirdPull])

    // Both shells retain mounted panes while their live content is not visible.
    await openPicker()
    await page.evaluate(() => window.fixture.feature(false))
    assert.equal(await page.locator('#life-workspace-surfaces').count(), 0)
    await reset()
    await page.evaluate(() => window.fixture.feature(true))
    if (nativeShell) await page.locator('#life-workspace-surfaces').waitFor({ state: 'hidden' })
    else await page.locator('.surface-picker').waitFor()
    const inactiveMountReads = await readProbes()
    for (const [key, count] of Object.entries(inactiveMountReads))
      assert.equal(count, 0, `Initially hidden mounted panes read ${key}`)
    await pick('Linked pull requests')
    assert.deepEqual(await linkNames(), [firstPull, secondPull, thirdPull])

    // Semantic checks start after all common workload samples and read counts above.
    const variantChecks = []
    await pick('Agents')
    if (nativeShell) {
      const rows = agentsPanel.locator('.agents-panel-row')
      const row = (id) => agentsPanel.locator('.agents-panel-row[data-agent-id="' + id + '"]')
      assert.deepEqual(
        await rows.evaluateAll((elements) => elements.map((element) => element.dataset.agentId)),
        ['child-alpha', 'child-beta', 'child-closed', 'child-unknown'],
      )
      assert.equal(await agentsPanel.locator('.surface-agent-row, .surface-agent-call').count(), 0)
      assert.equal(await agentsPanel.locator('button, details').count(), 0)
      assert.equal(
        await row('child-alpha').locator('.agents-panel-name').textContent(),
        'Alpha reviewer',
      )
      assert.equal(await row('child-alpha').locator('.agents-panel-role').textContent(), 'reviewer')
      assert.equal(await row('child-alpha').getAttribute('data-status'), 'working')
      assert.equal(await row('child-beta').getAttribute('data-status'), 'completed')
      assert.equal(await row('child-closed').getAttribute('data-status'), 'stopped')
      assert.equal(await row('child-unknown').getAttribute('data-status'), 'unknown')
      const geometry = await rows.evaluateAll((elements) =>
        elements.map((element) => ({
          x: element.getBoundingClientRect().x,
          height: element.getBoundingClientRect().height,
          dot: element.querySelector('.agents-panel-dot').getBoundingClientRect().width,
        })),
      )
      for (const item of geometry) {
        assert.equal(item.x, geometry[0].x, 'Nested children became indented rows')
        assert.equal(item.height, 62)
        assert.equal(item.dot, 6)
      }
      await page.evaluate(() => window.fixture.status(false))
      assert.equal(
        await row('child-alpha').getAttribute('data-status'),
        'working',
        'Root completion settled a running native child',
      )
      for (const [nativeStatus, projectedStatus] of [
        ['idle', 'idle'],
        ['completed', 'completed'],
        ['failed', 'failed'],
        ['running', 'working'],
      ]) {
        await page.evaluate((status) => window.fixture.child(status), nativeStatus)
        assert.equal(await row('child-alpha').getAttribute('data-status'), projectedStatus)
        assert.equal(await rows.count(), 4, 'A native lifecycle update duplicated the child row')
      }
      await row('child-alpha').evaluate((element) => {
        window.retainedNativeAgentRow = element
      })
      await page.getByRole('button', { name: 'Collapse workspace sidebar', exact: true }).click()
      await reset()
      await page.evaluate(() => window.fixture.child('completed'))
      for (const [key, count] of Object.entries(await readProbes()))
        assert.equal(count, 0, 'Collapsed native Agents read ' + key)
      await page.evaluate(() => window.fixture.sidebar(true))
      assert.equal(await row('child-alpha').getAttribute('data-status'), 'completed')
      assert.equal(
        await row('child-alpha').evaluate((element) => element === window.retainedNativeAgentRow),
        true,
      )
      await page.getByRole('button', { name: 'Maximize panel', exact: true }).click()
      assert.equal(
        await page.locator('#life-workspace-surfaces').getAttribute('data-maximized'),
        'true',
      )
      await page.getByRole('button', { name: 'Restore panel size', exact: true }).click()
      assert.equal(
        await page.locator('#life-workspace-surfaces').getAttribute('data-maximized'),
        'false',
      )
      variantChecks.push(
        'Native child identities fold repeated lifecycle updates into flat noninteractive rows with live and recovered status',
      )
      variantChecks.push('Title-only tool calls and project conversations cannot create child rows')
      variantChecks.push(
        'Collapsed panes keep native rows and defer reads; reopening applies the latest child status and maximize preserves the pane',
      )

      await page.evaluate(() => window.fixture.select('thread-1'))
      await pick('Agents')
      assert.deepEqual(
        await rows.evaluateAll((elements) => elements.map((element) => element.dataset.agentId)),
        ['thread-b-child'],
      )
      await page.evaluate(() => window.fixture.select('thread-0'))
      await pick('Agents')
      assert.equal(await rows.count(), 4)
      for (const [workspace, profileId] of [
        ['/elsewhere', 'machine'],
        ['/project', 'different-machine'],
      ]) {
        await page.evaluate(
          ({ workspace, profileId }) => window.fixture.scope(workspace, profileId),
          { workspace, profileId },
        )
        await pick('Agents')
        assert.equal(await rows.count(), 0, 'Native child rows leaked across workspace ownership')
        assert.equal(
          await agentsPanel.getByText('No agents yet', { exact: true }).isVisible(),
          true,
        )
      }
      await page.evaluate(() => window.fixture.scope('/project'))
      await pick('Agents')
      assert.equal(await rows.count(), 4)
      await page.getByRole('button', { name: 'Close Pull request', exact: true }).click()
      assert.equal(
        await page.getByRole('tab', { name: 'Agents', exact: true }).getAttribute('aria-selected'),
        'true',
      )
      await pick('Linked pull requests')
      await page.getByRole('button', { name: 'Close Linked pull requests', exact: true }).click()
      assert.equal(
        await page.getByRole('tab', { name: 'Agents', exact: true }).getAttribute('aria-selected'),
        'true',
      )
      await page.getByRole('button', { name: 'Close Agents', exact: true }).click()
      await page.locator('#life-workspace-surfaces').waitFor({ state: 'hidden' })
      await page.evaluate(() => window.fixture.sidebar(true))
      await page.locator('.surface-picker').waitFor({ state: 'visible' })
      variantChecks.push(
        "Thread, profile and workspace changes cannot retain another owner's child roster",
      )
      variantChecks.push(
        'Closing a background tab preserves selection; closing the selected tab chooses its neighbor and closing the last tab collapses the panel',
      )
    } else {
      assert.equal(await agentsPanel.locator('.surface-agent-row').count(), 25)
      const activeRow = agentsPanel
        .locator('.surface-agent-row')
        .filter({ hasText: 'Conversation 0' })
      assert.equal(await activeRow.getAttribute('aria-current'), 'true')
      const detail = agentsPanel.locator('.surface-agent-call').filter({ hasText: 'spawn_agent' })
      await detail.locator('summary').click()
      assert.equal(await detail.locator('pre').textContent(), 'Native agent call output')
      await page.evaluate(() => window.fixture.status(true, true))
      assert.equal(await activeRow.locator('.surface-status').textContent(), 'Waiting for you')
      assert.match(
        await agentsPanel.locator('.surface-section-heading').first().textContent(),
        /1 running/,
      )
      await page.evaluate(() => window.fixture.status(true))
      assert.equal(await activeRow.locator('.surface-status').textContent(), 'Running')
      await page.evaluate(() => window.fixture.status(false))
      assert.equal(await activeRow.locator('.surface-status').textContent(), 'Idle')
      assert.match(
        await agentsPanel.locator('.surface-section-heading').first().textContent(),
        /0 running/,
      )
      await openPicker()
      await page.evaluate(() => window.fixture.status(true, true))
      await pick('Agents')
      assert.equal(await activeRow.locator('.surface-status').textContent(), 'Waiting for you')
      assert.equal(await detail.evaluate((element) => element.open), true)
      await openPicker()
      await page.evaluate(() => window.fixture.select('thread-1'))
      await pick('Agents')
      const otherRow = agentsPanel
        .locator('.surface-agent-row')
        .filter({ has: page.getByText('Conversation 1', { exact: true }) })
      assert.equal(await otherRow.getAttribute('aria-current'), 'true')
      assert.equal(await agentsPanel.locator('.surface-agent-call summary').count(), 1)
      assert.match(
        await agentsPanel.locator('.surface-agent-call summary').textContent(),
        /collab_agent/,
      )
      assert.ok(
        (await agentsPanel.locator('.surface-agent-call pre').textContent()).includes(otherPull),
      )
      await activeRow.click()
      assert.equal(await activeRow.getAttribute('aria-current'), 'true')
      await page.evaluate(() => window.fixture.status(false))
      variantChecks.push(
        'Reference project conversation buttons remain scoped to 25 owned threads and select the active conversation',
      )
      variantChecks.push(
        'Reference regex-reported tool disclosures preserve their expanded state and reflect native root busy/pending status when reopened',
      )
    }
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
      referenceRef,
      semanticVariant,
      fixture: {
        threads: 50,
        activeMessages: 1200,
        streamingMessages: 1,
        scopedThreads: 25,
        agentsVariant: semanticVariant,
        nativeChildIdentities: 4,
        hiddenShell: nativeShell ? 'collapsed-panel' : 'picker-overlay',
        comparison:
          'Identical immutable history updates and getter-count gates; different hidden shell controls and post-measurement Agents assertions are disclosed rather than compared as identical visible UI.',
        semanticChecksAfterCommonMeasurements: true,
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
        'Unique pull request links retain first occurrence order',
        'Linked pull request click and back use the native gh command',
        'Thread switching resets pull request detail and displays the new thread links',
        'Hidden panes retain their mounted DOM while the selected surface changes',
        'Native feature re-enables the retained surface tabs',
        ...variantChecks,
      ],
      performanceAssertions: [
        'Hidden surfaces and ordinary pull request do not scan thread fields',
        'Linked pull request scans settled text once and only new immutable streamed text afterward',
        'Re-enabled hidden panes defer scanning until visible',
      ],
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
