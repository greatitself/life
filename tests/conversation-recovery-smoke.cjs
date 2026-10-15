#!/usr/bin/env node
// Exercise lossless recovery through the shipped App, its downloads and IndexedDB.
const assert = require('node:assert/strict')
const { createServer } = require('node:http')
const { mkdir, mkdtemp, readFile, rm, writeFile } = require('node:fs/promises')
const { join, resolve } = require('node:path')
const { tmpdir } = require('node:os')
const { build } = require('./helpers/browser-build.cjs')
const { chromium } = require('playwright')
const { appMockSource } = require('./helpers/app-workflow-fixture.cjs')

const initialize = `
  const persisted = Object.fromEntries(Object.keys(localStorage).map(key => [key, localStorage.getItem(key)]));
  MOCK_BRIDGE({historyHydration:false, providerUtilities:false, fluidity:false});
  const base = window.controlsTest.stored().find(thread => thread.id === 'thread-a');
  const now = Date.now() - 10000;
  const text = '  Exact recoverable request Ω 😀\\r\\n\\tSecond line  \\n';
  const input = 'Exact input\\r\\n  retain spaces  \\n';
  const attachment = id => ({id, name:id+'.txt', mime:'text/plain', size:5});
  const survivor = {
    ...base, id:'thread-a', title:'Recovery survivor', remoteId:'native-survivor',
    createdAt:now, updatedAt:now, busy:true, turnStatus:'running',
    turn:'future-turn', mode:'future-mode', pending:[{futurePermission:'retain'}],
    futureThreadField:{exact:text, nested:[null,17,true]},
    queue:[{id:'opaque-queue',text:17,futureQueueField:true,attachments:[attachment('queue-only')]}],
    messages:[
      null, 'opaque scalar Ω\\r\\n', 47,
      {id:'future-role',role:'system',text:'Hidden future role text',attachments:[attachment('shared')],futureMessageField:{input}},
      {role:'user',text:'Unreadable message without identity',futureMissingIdentity:true},
      {id:'future-shape',futureMessageField:{exact:text}},
      {id:'readable',role:'user',text,input,futureMessageField:{exact:input,retained:true}},
      ['future',{exact:text}],
    ],
  };
  const victim = {...base,id:SCENARIO === 'duplicate' ? 'thread-a' : 'thread-b',
    title:'Delete selected occurrence',remoteId:'native-victim',createdAt:now+1,updatedAt:now+1,
    messages:[{id:'victim-message',role:'user',text:'Only this conversation is deleted.',turn:1,
      attachments:[attachment('shared'),attachment('victim-only')]}],
    queue:[],pending:[],busy:false,turnStatus:'completed'};
  const seedKey = 'life.recovery-fixture.seed';
  const nativeKey = 'life.recovery-fixture.native';
  localStorage.clear();
  if (persisted[seedKey]) {
    for (const [key,value] of Object.entries(persisted)) localStorage.setItem(key,value);
  } else {
    const snapshot = {version:1,savedAt:now+2,threads:[survivor,victim]};
    localStorage.setItem(seedKey,JSON.stringify(snapshot));
    localStorage.setItem(nativeKey,JSON.stringify(snapshot));
    if (SCENARIO === 'browser') localStorage.setItem('relay.threads.v1',JSON.stringify(snapshot.threads));
    localStorage.setItem('life.active-thread.v1','thread-a');
  }
  let failWrites = false;
  const originalSetItem = Storage.prototype.setItem;
  Storage.prototype.setItem = function(key,value) {
    if (failWrites && key === 'relay.threads.v1') throw new Error('Fixture cache is full');
    return originalSetItem.call(this,key,value);
  };
  window.recoveryTest = {
    seed:() => JSON.parse(localStorage.getItem(seedKey)),
    stored:() => SCENARIO === 'browser'
      ? JSON.parse(localStorage.getItem('relay.threads.v1'))
      : JSON.parse(localStorage.getItem(nativeKey)).threads,
    failWrites:value => {failWrites=value;},
    text,input,
  };
  if (SCENARIO !== 'browser') window.relay.conversations = {
    load:async () => {
      window.controlsTest.records.historyLoads++;
      return JSON.parse(localStorage.getItem(nativeKey));
    },
    save:async (threads,savedAt) => {
      window.controlsTest.records.historySaveAttempts++;
      if (failWrites) throw new Error('Fixture native write failed');
      window.controlsTest.records.historySaves.push({threads:structuredClone(threads),savedAt});
      localStorage.setItem(nativeKey,JSON.stringify({version:1,savedAt,threads}));
    },
  };
`

async function run() {
  const directory = await mkdtemp(join(tmpdir(), 'life-conversation-recovery-'))
  const output = resolve(__dirname, '../output/playwright/conversation-recovery')
  const checks = []
  const errors = []
  let server
  let browser
  try {
    await mkdir(output, { recursive: true })
    await build({
      stdin: {
        resolveDir: resolve(__dirname, '..'),
        sourcefile: 'conversation-recovery-fixture.tsx',
        loader: 'tsx',
        contents: `
          import React from 'react'
          import {createRoot} from 'react-dom/client'
          import {App} from './src/renderer/App'
          import {defaultLifeConfig} from './src/shared/customization'
          import './src/renderer/styles.css'
          window.testConfig = {...defaultLifeConfig,workspacePanel:false}
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
        file?.endsWith('.js') ? 'text/javascript' : file ? 'text/css' : 'text/html',
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
    for (const scenario of ['browser', 'native', 'duplicate']) {
      const context = await browser.newContext({
        viewport: { width: 1440, height: 1000 },
        acceptDownloads: true,
      })
      const page = await context.newPage()
      page.on('pageerror', (error) => errors.push({ scenario, message: error.message }))
      await page.addInitScript({
        content: initialize
          .replace('MOCK_BRIDGE', '(' + mock + ')')
          .replaceAll('SCENARIO', JSON.stringify(scenario)),
      })
      await page.goto(`http://127.0.0.1:${server.address().port}`)
      await page.waitForLoadState('networkidle')
      const row = (title) => page.locator('[data-thread-row]').filter({ hasText: title })
      const survivorRow = () =>
        row(scenario === 'duplicate' ? 'Recovery survivor' : 'Renamed recovery survivor')
      const stored = () => page.evaluate(() => window.recoveryTest.stored())
      const flush = () => page.evaluate(() => window.__lifeFlushConversationHistory())
      const action = async (title, name) => {
        await row(title).click({ button: 'right' })
        await page.getByRole('menuitem', { name, exact: true }).click()
      }
      const reload = async () => {
        await page.reload()
        await page.waitForLoadState('networkidle')
        await survivorRow().waitFor()
        await flush()
      }
      const preserve = async (title) => {
        const initial = (await page.evaluate(() => window.recoveryTest.seed())).threads[0]
        const current = (await stored()).find((thread) => thread.remoteId === 'native-survivor')
        assert.ok(current, scenario + ': surviving native session exists')
        assert.equal(current.title, title)
        for (const field of [
          'messages',
          'futureThreadField',
          'pending',
          'queue',
          'busy',
          'turnStatus',
          'turn',
          'mode',
          'remoteId',
          'workspace',
        ])
          assert.deepEqual(current[field], initial[field], scenario + ': exact raw ' + field)
        assert.equal(current.messages.length, 8)
        return current
      }
      await row('Recovery survivor').waitFor()
      await flush()
      await preserve('Recovery survivor')
      assert.equal(await page.getByText('Hidden future role text', { exact: true }).count(), 0)
      checks.push(
        scenario +
          ': startup exposes a readable view while preserving eight raw records and future metadata',
      )
      console.log('PASS: ' + checks.at(-1))

      if (scenario !== 'duplicate') {
        await action('Recovery survivor', 'Rename thread')
        const rename = page.getByRole('dialog', { name: 'Rename thread', exact: true })
        await rename
          .getByRole('textbox', { name: 'Thread title', exact: true })
          .fill('Renamed recovery survivor')
        await rename.getByRole('button', { name: 'Save title', exact: true }).click()
        await flush()
        await preserve('Renamed recovery survivor')
        await reload()
        await preserve('Renamed recovery survivor')
        checks.push(
          scenario +
            ': a manual rename and reload retain every opaque record, exact prompt and provider identity',
        )
        console.log('PASS: ' + checks.at(-1))
      }
      const title = scenario === 'duplicate' ? 'Recovery survivor' : 'Renamed recovery survivor'
      const beforeExport = await preserve(title)
      const recoveryDownload = page.waitForEvent('download')
      await action(title, 'Export recovery JSON')
      const recovery = await recoveryDownload
      assert.equal(recovery.suggestedFilename(), 'life-thread-recovery.json')
      const exported = JSON.parse(await readFile(await recovery.path(), 'utf8'))
      assert.equal(exported.version, 1)
      assert.ok(Number.isSafeInteger(exported.savedAt))
      assert.deepEqual(exported.threads, [beforeExport])
      const markdownDownload = page.waitForEvent('download')
      await action(title, 'Export thread')
      const markdown = await markdownDownload
      assert.equal(markdown.suggestedFilename(), 'life-thread.md')
      const exact = await page.evaluate(() => ({
        text: window.recoveryTest.text,
        input: window.recoveryTest.input,
      }))
      assert.equal(
        await readFile(await markdown.path(), 'utf8'),
        `## You\n\nInput:\n\n${exact.input}\n\n${exact.text}`,
      )
      checks.push(
        scenario +
          ': recovery JSON contains the exact raw thread while Markdown exports only the readable prompt and input',
      )
      console.log('PASS: ' + checks.at(-1))

      await page.evaluate(async () => {
        const db = await new Promise((resolve, reject) => {
          const request = indexedDB.open('life-thread-attachments', 1)
          request.onupgradeneeded = () =>
            request.result.createObjectStore('files', { keyPath: 'id' })
          request.onsuccess = () => resolve(request.result)
          request.onerror = () => reject(request.error)
        })
        await new Promise((resolve, reject) => {
          const tx = db.transaction('files', 'readwrite')
          for (const id of ['shared', 'victim-only', 'queue-only'])
            tx.objectStore('files').put({ id, blob: new Blob(['bytes:' + id]) })
          tx.oncomplete = resolve
          tx.onerror = () => reject(tx.error)
        })
        db.close()
      })
      const confirmDelete = async () => {
        await action('Delete selected occurrence', 'Delete thread')
        await page
          .getByRole('dialog', { name: 'Delete thread', exact: true })
          .getByRole('button', { name: 'Delete saved thread', exact: true })
          .click()
      }
      if (scenario === 'duplicate') {
        await page.evaluate(() => window.recoveryTest.failWrites(true))
        await confirmDelete()
        await page
          .getByText('The thread could not be deleted from saved history. It has been restored.', {
            exact: true,
          })
          .waitFor()
        await row('Delete selected occurrence').waitFor()
        await row('Recovery survivor').waitFor()
        await page.evaluate(() => window.recoveryTest.failWrites(false))
        await flush()
        assert.equal((await stored()).length, 2)
        await preserve(title)
        checks.push(
          'duplicate: failed disk and cache writes restore the selected occurrence alongside its same-ID survivor',
        )
        console.log('PASS: ' + checks.at(-1))
      }
      await confirmDelete()
      await page.getByText('Thread deleted.', { exact: true }).waitFor()
      await flush()
      assert.equal((await stored()).length, 1)
      await preserve(title)
      const blobs = await page.evaluate(async () => {
        const db = await new Promise((resolve, reject) => {
          const request = indexedDB.open('life-thread-attachments', 1)
          request.onsuccess = () => resolve(request.result)
          request.onerror = () => reject(request.error)
        })
        const result = {}
        for (const id of ['shared', 'victim-only', 'queue-only']) {
          const value = await new Promise((resolve, reject) => {
            const request = db.transaction('files', 'readonly').objectStore('files').get(id)
            request.onsuccess = () => resolve(request.result)
            request.onerror = () => reject(request.error)
          })
          result[id] = value ? await value.blob.text() : null
        }
        db.close()
        return result
      })
      assert.deepEqual(blobs, {
        shared: 'bytes:shared',
        'victim-only': null,
        'queue-only': 'bytes:queue-only',
      })
      await reload()
      await preserve(title)
      assert.equal((await stored()).length, 1)
      assert.equal(await page.evaluate(() => window.controlsTest.records.starts.length), 0)
      checks.push(
        scenario +
          ': deleting the selected thread removes its private blob, keeps opaque survivor references, and survives reload without provider runs',
      )
      console.log('PASS: ' + checks.at(-1))
      await page.screenshot({ path: join(output, scenario + '.png'), fullPage: true })
      await context.close()
    }
    assert.deepEqual(errors, [], 'Actual App workflows must not produce renderer errors')
    await writeFile(join(output, 'report.json'), JSON.stringify({ checks, errors }, null, 2))
    console.log(JSON.stringify({ checks, errors }, null, 2))
  } finally {
    await browser?.close()
    await new Promise((resolve) => (server ? server.close(resolve) : resolve()))
    await rm(directory, { recursive: true, force: true })
  }
}

run().catch((error) => {
  console.error(error)
  process.exitCode = 1
})
