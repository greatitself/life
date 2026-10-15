#!/usr/bin/env node
// Exercise production App handlers; the native boundary is mocked and makes no
// SSH, provider, authentication, or inference requests.
const assert = require('node:assert/strict')
const { createHash } = require('node:crypto')
const { createServer } = require('node:http')
const { mkdir, mkdtemp, readFile, rm, writeFile } = require('node:fs/promises')
const { join, resolve } = require('node:path')
const { tmpdir } = require('node:os')
const { chromium } = require('playwright')
const { build } = require('./helpers/browser-build.cjs')
const { appMockSource } = require('./helpers/app-workflow-fixture.cjs')

const bootstrap = String.raw`
  const saved = Object.fromEntries(Object.keys(localStorage).map(key => [key,localStorage.getItem(key)]));
  MOCK_BRIDGE({historyHydration:false,providerUtilities:false,fluidity:false});
  const local = {id:'local:90d3e8ec-894d-42db-9b04-a9ae7be06146',transport:'local',name:'Local',host:'localhost',port:22,username:'fixture',auth:'agent',privateKeyPath:'',workspace:'/tmp/local intent project  '};
  const ssh = {id:'explicit-ssh',name:'Explicit SSH',host:'research.example',port:2222,username:'researcher',auth:'agent',privateKeyPath:'',workspace:'/srv/explicit-project'};
  const threadId = 'retained-local-thread';
  const exactDraft = '  Keep my unsent Local draft.\nUnicode: 🧭 e\u0301\r\nTrailing spaces  ';
  if (saved['life.intent-fixture.seeded'] === 'true') {
    localStorage.clear();
    for (const [key,value] of Object.entries(saved)) localStorage.setItem(key,value);
  } else {
    const original = window.controlsTest.stored().find(thread => thread.id === 'thread-a');
    const attachment = {id:'retained-history-file',name:'history evidence.txt',mime:'text/plain',size:17,remotePath:'/tmp/previous-owned-upload',futureAttachment:{schema:4,keep:['all','fields']}};
    const rawThread = {...original,id:threadId,title:'Retained Local history',profileId:local.id,workspace:local.workspace,remoteId:'native-local-session-identity',futureThread:{version:9,opaque:['keep',null,{native:true}]},messages:[{id:'literal-user',role:'user',text:'  Exact stored request\r\n🧭  ',turn:1,createdAt:10,attachments:[attachment],futureMessage:{native:['preserve',7]}},{id:'future-message',role:'future-provider-role',text:'Opaque future provider record',futureOpaque:{complete:true}}],queue:[{id:'retained-queue',prompt:'  Exact queued text\n  ',paused:true,attachments:[attachment],futureQueue:{keep:true}}]};
    localStorage.setItem('relay.threads.v1',JSON.stringify([rawThread,{id:'opaque-archive',provider:'future-provider',raw:{keep:true}}]));
    localStorage.setItem('life.active-thread.v1',threadId);
    localStorage.setItem('life.conversation-drafts.v1',JSON.stringify({['agents:'+threadId]:{draft:exactDraft,attachments:[]},'agents:other-draft':{draft:'Do not disturb another saved draft.',attachments:[]}}));
    localStorage.setItem('life.intent-fixture.seeded','true');
    localStorage.setItem('life.intent-fixture.original-history',localStorage.getItem('relay.threads.v1'));
    localStorage.setItem('life.intent-fixture.original-drafts',localStorage.getItem('life.conversation-drafts.v1'));
  }
  const listeners = new Set();
  const calls = {state:0,connect:[],selected:[],directories:[],profileSaves:[]};
  const selected = localStorage.getItem('life.intent-fixture.selected');
  let current = selected === 'ssh'
    ? {status:'disconnected',profile:{...ssh},home:'/home/researcher'}
    : {status:'connected',profile:{...local},workspace:local.workspace,home:'/tmp/local-home',codex:'0.162.1',claude:'missing'};
  let failSSH = false;
  const emit = state => {current=state;for(const listener of listeners)listener(structuredClone(state));return structuredClone(state)};
  window.relay.profiles.list = async () => structuredClone([local,ssh]);
  window.relay.profiles.save = async input => {calls.profileSaves.push(structuredClone(input))};
  window.relay.onConnection = listener => {listeners.add(listener);return () => listeners.delete(listener)};
  window.relay.connection.state = async () => {calls.state++;return structuredClone(current)};
  window.relay.connection.connect = async input => {
    calls.connect.push(structuredClone(input));
    emit({status:'connecting',profile:{...input}});
    if(input.id===ssh.id&&failSSH){
      failSSH=false;
      emit({status:'disconnected',profile:{...ssh},error:'Explicit SSH fixture refusal'});
      throw new Error('Explicit SSH fixture refusal');
    }
    if(input.id!==local.id&&input.id!==ssh.id)throw new Error('Unknown fixture profile');
    localStorage.setItem('life.intent-fixture.selected',input.id===ssh.id?'ssh':'local');
    return emit({status:'connected',profile:{...(input.id===ssh.id?ssh:local)},home:input.id===ssh.id?'/home/researcher':'/tmp/local-home',...(input.id===local.id?{workspace:local.workspace}:{}),codex:'0.162.1',claude:'missing'});
  };
  window.relay.connection.listDirectories = async path => {calls.directories.push(path||null);return {path:path||'/home/researcher',parent:'/',entries:[]}};
  window.relay.connection.selectWorkspace = async path => {calls.selected.push(path);return emit({...current,workspace:path})};
  window.localIntentTest = {local,ssh,threadId,exactDraft,calls,failNextSSH:()=>{failSSH=true},state:()=>structuredClone(current),snapshot:()=>({active:localStorage.getItem('life.active-thread.v1'),history:JSON.parse(localStorage.getItem('relay.threads.v1')),drafts:JSON.parse(localStorage.getItem('life.conversation-drafts.v1')),originalHistory:JSON.parse(localStorage.getItem('life.intent-fixture.original-history')),originalDrafts:JSON.parse(localStorage.getItem('life.intent-fixture.original-drafts')),calls:structuredClone(calls),state:structuredClone(current),providerStarts:window.controlsTest.records.starts.length,providerStops:window.controlsTest.records.stops.length})};
`

async function run() {
  const directory = await mkdtemp(join(tmpdir(), 'life-local-startup-intent-'))
  const outputFlag = process.argv.indexOf('--output')
  const output = resolve(
    outputFlag >= 0
      ? process.argv[outputFlag + 1]
      : join(__dirname, '../output/playwright/local-startup-intent'),
  )
  await mkdir(output, { recursive: true })
  const errors = []
  const checks = []
  const snapshots = {}
  const proof = {
    fixture: 'Production App with a mock native bridge',
    upstreamInference: false,
    checks,
    browserErrors: errors,
    snapshots,
    source: {
      app: createHash('sha256')
        .update(await readFile(resolve(__dirname, '../src/renderer/App.tsx')))
        .digest('hex'),
    },
  }
  const record = (name) => {
    checks.push(name)
    console.log('PASS ' + name)
  }
  let server
  let browser
  let page
  try {
    await build({
      stdin: {
        resolveDir: resolve(__dirname, '..'),
        sourcefile: 'local-startup-intent-fixture.tsx',
        loader: 'tsx',
        contents: `
          import React from 'react'
          import {createRoot} from 'react-dom/client'
          import {App} from './src/renderer/App'
          import {defaultLifeConfig} from './src/shared/customization'
          import './src/renderer/styles.css'
          window.testConfig={...defaultLifeConfig,workspacePanel:false}
          createRoot(document.getElementById('root')).render(<React.StrictMode><App/></React.StrictMode>)
        `,
      },
      bundle: true,
      jsx: 'automatic',
      outfile: join(directory, 'fixture.js'),
      define: { 'process.env.NODE_ENV': '"development"' },
      loader: { '.woff2': 'file', '.woff': 'file', '.ttf': 'file' },
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
        file?.endsWith('.js')
          ? 'text/javascript'
          : file?.endsWith('.css')
            ? 'text/css'
            : 'text/html',
      )
      response.end(
        file
          ? await readFile(join(directory, file))
          : '<!doctype html><link rel="stylesheet" href="/fixture.css"><div id="root"></div><script src="/fixture.js"></script>',
      )
    })
    await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
    browser = await chromium.launch({ headless: true })
    const mock = await appMockSource()
    const url = `http://127.0.0.1:${server.address().port}`
    const settle = () =>
      page.evaluate(
        () => new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve))),
      )
    const snapshot = async () => {
      await page.evaluate(() => window.__lifeFlushConversationHistory())
      await settle()
      return page.evaluate(() => window.localIntentTest.snapshot())
    }
    const retained = (state) => {
      assert.deepEqual(
        state.history,
        state.originalHistory,
        'The complete raw history must survive',
      )
      assert.deepEqual(state.drafts, state.originalDrafts, 'Every unsent draft must survive')
      assert.equal(state.providerStarts, 0, 'Environment selection must not start inference')
      assert.equal(state.providerStops, 0, 'Environment selection must not stop a provider')
    }
    const startScenario = async (name) => {
      const context = await browser.newContext({ viewport: { width: 1440, height: 1000 } })
      page = await context.newPage()
      page.setDefaultTimeout(10000)
      page.on('pageerror', (error) => errors.push({ scenario: name, message: error.message }))
      await page.addInitScript({ content: bootstrap.replace('MOCK_BRIDGE', '(' + mock + ')') })
      await page.goto(url, { waitUntil: 'networkidle' })
      await page.locator('[data-thread-row="retained-local-thread"]').waitFor()
      const composer = page.getByRole('textbox', { name: 'Message your coding agent', exact: true })
      await composer.waitFor()
      await settle()
      // Browsers expose textarea line endings as LF. The persisted draft below
      // is checked byte for byte, including its original CRLF.
      assert.equal(
        await composer.inputValue(),
        await page.evaluate(() => window.localIntentTest.exactDraft.replace(/\r\n/g, '\n')),
      )
      const initial = await snapshot()
      retained(initial)
      assert.equal(initial.active, 'retained-local-thread')
      assert.equal(initial.state.profile.transport, 'local')
      assert.equal(initial.calls.connect.length, 0)
      snapshots[name + '-initial'] = initial
      await writeFile(join(output, name + '-initial.html'), await page.content())
      await page.screenshot({ path: join(output, name + '-initial.png'), fullPage: true })
      return context
    }
    const openEnvironment = async () => {
      await page.getByRole('button', { name: 'Current Active Environment', exact: true }).click()
      await page
        .getByRole('dialog', { name: 'Current Active Environment', exact: true })
        .getByRole('button', { name: 'Switch environment', exact: true })
        .click()
      const dialog = page.getByRole('dialog', { name: 'Choose an environment', exact: true })
      await dialog.waitFor()
      return dialog
    }
    const chooseSSH = async () => {
      const dialog = await openEnvironment()
      await dialog
        .locator('.saved-profile')
        .filter({ has: page.getByText('Explicit SSH', { exact: true }) })
        .getByRole('button')
        .first()
        .click()
      await dialog.getByLabel('Hostname or IP', { exact: true }).waitFor()
      await dialog.getByRole('button', { name: 'Connect machine', exact: true }).click()
      return dialog
    }

    const sameProfile = await startScenario('same-local')
    const localDialog = await openEnvironment()
    await localDialog.getByRole('button', { name: 'Use Local', exact: true }).click()
    const localPicker = page.getByRole('dialog', { name: 'Select a project', exact: true })
    await localPicker.waitFor()
    await localPicker.getByRole('button', { name: 'Close dialog', exact: true }).click()
    await localPicker.waitFor({ state: 'hidden' })
    const localState = await snapshot()
    snapshots['same-local-after-reconnect'] = localState
    retained(localState)
    assert.equal(localState.active, 'retained-local-thread')
    assert.equal(localState.calls.connect.length, 1)
    assert.equal(localState.calls.connect[0].id, localState.state.profile.id)
    assert.equal(localState.state.profile.transport, 'local')
    assert.equal(localState.calls.selected.length, 0)
    await page.screenshot({ path: join(output, 'same-local-retained.png'), fullPage: true })
    record(
      'An explicit reconnect to the same Local profile retains the selected thread and its exact saved draft without changing history',
    )
    await sameProfile.close()

    const failed = await startScenario('failed-ssh')
    await page.evaluate(() => window.localIntentTest.failNextSSH())
    const failedDialog = await chooseSSH()
    await failedDialog
      .getByRole('alert')
      .filter({ hasText: 'Explicit SSH fixture refusal' })
      .waitFor()
    const failedState = await snapshot()
    snapshots['failed-ssh-after-switch'] = failedState
    retained(failedState)
    assert.equal(failedState.active, 'retained-local-thread')
    assert.equal(failedState.calls.connect.length, 1)
    assert.equal(failedState.calls.connect[0].id, 'explicit-ssh')
    assert.equal(failedState.calls.selected.length, 0)
    await page.screenshot({ path: join(output, 'failed-ssh-retained.png'), fullPage: true })
    record(
      'A rejected explicit SSH switch retains the Local active key, exact raw history, queued attachments, and every unsent draft',
    )
    await failed.close()

    const successful = await startScenario('successful-ssh')
    await chooseSSH()
    const picker = page.getByRole('dialog', { name: 'Select a project', exact: true })
    await picker.waitFor()
    await picker.getByRole('button', { name: 'Close dialog', exact: true }).click()
    await picker.waitFor({ state: 'hidden' })
    snapshots['successful-ssh-after-switch'] = await snapshot()
    retained(snapshots['successful-ssh-after-switch'])
    assert.equal(snapshots['successful-ssh-after-switch'].state.profile.id, 'explicit-ssh')
    assert.equal(snapshots['successful-ssh-after-switch'].calls.selected.length, 0)
    await page.screenshot({
      path: join(output, 'successful-ssh-picker-closed.png'),
      fullPage: true,
    })

    await page.reload({ waitUntil: 'networkidle' })
    await page.locator('.app-shell').waitFor()
    await page.waitForFunction(() => window.localIntentTest.calls.state >= 2)
    await settle()
    // Flush settled App work so the assertion observes startup restoration,
    // rather than an earlier frame before profile hydration has completed.
    await page.evaluate(() => window.__lifeFlushConversationHistory())
    await settle()
    const reloaded = await snapshot()
    snapshots['successful-ssh-after-reload'] = reloaded
    await page.screenshot({ path: join(output, 'successful-ssh-reloaded.png'), fullPage: true })
    await writeFile(join(output, 'successful-ssh-reloaded.html'), await page.content())
    retained(reloaded)
    assert.equal(
      snapshots['successful-ssh-after-switch'].active,
      null,
      'A successful explicit environment switch must release the old persisted Local active key before project selection',
    )
    assert.equal(reloaded.active, null, 'Cold reload must not revive the released Local active key')
    assert.deepEqual(
      reloaded.calls.connect,
      [],
      'Cold reload after selecting SSH must not automatically connect Local',
    )
    assert.equal(reloaded.state.profile.id, 'explicit-ssh')
    assert.equal(reloaded.state.status, 'disconnected')
    assert.equal(reloaded.calls.selected.length, 0)
    record(
      'Successful explicit SSH selection releases the Local active key even when the project picker is dismissed',
    )
    record(
      'Cold reload keeps the explicitly selected disconnected SSH environment without reconnecting Local or selecting a project',
    )
    record(
      'Raw future thread/message metadata, provider identity, exact prompts, paused queue, attachment ownership, and unsent drafts survive both switches and reload',
    )
    assert.deepEqual(errors, [])
    record('No browser errors or provider start/stop calls occur')
    await successful.close()
    proof.passed = true
  } catch (error) {
    proof.passed = false
    proof.failure = { message: error.message, stack: error.stack }
    if (page && !page.isClosed()) {
      try {
        await page.screenshot({ path: join(output, 'failure.png'), fullPage: true })
        await writeFile(join(output, 'failure.html'), await page.content())
      } catch {}
    }
    throw error
  } finally {
    await writeFile(join(output, 'proof.json'), JSON.stringify(proof, null, 2))
    await browser?.close()
    if (server) await new Promise((resolve) => server.close(resolve))
    await rm(directory, { recursive: true, force: true })
  }
}

run().catch((error) => {
  console.error(error)
  process.exitCode = 1
})
