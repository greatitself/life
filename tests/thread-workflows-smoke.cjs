#!/usr/bin/env node
// Exercise durable thread organization and draft recovery in the shipped App.
const assert = require('node:assert/strict')
const { createServer } = require('node:http')
const { mkdir, mkdtemp, readFile, rm, writeFile } = require('node:fs/promises')
const { join, resolve } = require('node:path')
const { tmpdir } = require('node:os')
const { build } = require('esbuild')
const { chromium } = require('playwright')
const { appMockSource } = require('./helpers/app-workflow-fixture.cjs')

const initialize = `
  const persisted = Object.fromEntries(Object.keys(localStorage).map(key => [key, localStorage.getItem(key)]));
  const hadSeed = persisted['life.workflow-fixture.seeded'] === 'true';
  MOCK_BRIDGE({historyHydration:false, providerUtilities:false, fluidity:false});
  if (hadSeed) {
    localStorage.clear();
    for (const [key, value] of Object.entries(persisted)) localStorage.setItem(key, value);
  } else {
    const base = window.controlsTest.stored().find(thread => thread.id === 'thread-a');
    const now = Date.now() - 10000;
    const thread = (id, title, index, extra = {}) => ({...base, id, title,
      remoteId:'remote-' + id, createdAt:now + index, updatedAt:now + index,
      messages:[{id:id+'-request',role:'user',text:'Original request for '+title,turn:1,createdAt:now}],
      ...extra});
    localStorage.setItem('relay.threads.v1', JSON.stringify([
      thread('thread-a','Thread Alpha',1), thread('thread-b','Thread Beta',2),
      thread('thread-c','Thread Gamma',3),
      thread('settled-thread','Previously settled',0,{settled:true,settledAt:now}),
    ]));
    localStorage.setItem('life.workflow-fixture.seeded','true');
    localStorage.removeItem('life.sidebar.arrangement.v1');
  }
  let heldStart;
  let holdStart = false;
  const originalStart = window.relay.agent.start;
  const originalState = window.relay.connection.state;
  window.relay.connection.connect = async () => {
    if (localStorage.getItem('life.workflow-fixture.offline') === 'true') throw new Error('Fixture machine is offline');
    window.controlsTest.emitConnection('primary', true);
    return originalState();
  };
  window.relay.agent.start = async input => {
    await originalStart(input);
    if (holdStart) await new Promise((resolve,reject) => {heldStart = {resolve,reject};});
  };
  window.workflowTest = {
    holdStart: value => {holdStart = value;},
    startReady: () => Boolean(heldStart),
    resolveStart: () => {const entry=heldStart;heldStart=undefined;holdStart=false;entry?.resolve();},
    rejectStart: () => {const entry=heldStart;heldStart=undefined;holdStart=false;entry?.reject(new Error('Provider rejected the submitted message'));},
  };
  if (persisted['life.workflow-fixture.offline'] === 'true') window.controlsTest.emitConnection('primary', false);
`

async function run() {
  const directory = await mkdtemp(join(tmpdir(), 'life-thread-workflows-'))
  const output = resolve(__dirname, '../output/playwright')
  await mkdir(output, { recursive: true })
  const checks = []
  checks.push = (...items) => {
    for (const item of items) console.log('PASS: ' + item)
    return Array.prototype.push.apply(checks, items)
  }
  const errors = []
  let server
  let browser
  let page
  try {
    await build({
      stdin: {
        resolveDir: resolve(__dirname, '..'),
        sourcefile: 'thread-workflows-fixture.tsx',
        loader: 'tsx',
        contents: `
          import React from 'react'
          import {createRoot} from 'react-dom/client'
          import {App} from './src/renderer/App'
          import {defaultLifeConfig} from './src/shared/customization'
          import './src/renderer/styles.css'
          window.testConfig = {...defaultLifeConfig, workspacePanel:false}
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
    page = await browser.newPage({ viewport: { width: 1440, height: 1000 } })
    page.on('pageerror', (error) => errors.push(error.message))
    const mock = await appMockSource()
    await page.addInitScript({ content: initialize.replace('MOCK_BRIDGE', '(' + mock + ')') })
    await page.goto(`http://127.0.0.1:${server.address().port}`)
    await page.waitForLoadState('networkidle')
    const row = (id) => page.locator(`[data-thread-row="${id}"]`)
    const shell = (id) => row(id).locator('..')
    const stored = () => page.evaluate(() => window.controlsTest.stored())
    const composer = page.getByRole('textbox', { name: 'Message your coding agent' })
    const waitStored = (id, field, value) =>
      page.waitForFunction(
        ({ id, field, value }) =>
          window.controlsTest.stored().find((thread) => thread.id === id)?.[field] === value,
        { id, field, value },
      )
    const menu = async (id) => {
      await row(id).click({ button: 'right' })
      await page.getByRole('menuitem', { name: 'Rename thread', exact: true }).waitFor()
    }
    const action = async (id, name) => {
      await menu(id)
      await page.getByRole('menuitem', { name, exact: true }).click()
    }
    const reload = async () => {
      await page.reload()
      await page.waitForLoadState('networkidle')
      if (
        await page.evaluate(() => localStorage.getItem('life.workflow-fixture.offline') === 'true')
      )
        await page
          .getByRole('dialog', { name: 'Connect a machine', exact: true })
          .getByRole('button', { name: 'Close dialog', exact: true })
          .click()
      await composer.waitFor()
    }
    const ids = () =>
      page
        .locator('[data-thread-row]')
        .evaluateAll((nodes) => nodes.map((node) => node.dataset.threadRow))
    await row('thread-a').waitFor()
    // Save rendered accessibility and DOM before choosing workflow selectors.
    await writeFile(join(output, 'v0.12.0-thread-workflows-initial.html'), await page.content())
    if (process.argv.includes('--inspect')) {
      console.log(
        JSON.stringify(
          {
            buttons: await page.getByRole('button').evaluateAll((nodes) =>
              nodes.map((node) => ({
                label: node.getAttribute('aria-label'),
                text: node.textContent,
              })),
            ),
            rows: await ids(),
          },
          null,
          2,
        ),
      )
      return
    }

    const arrangementSnapshot = async () => {
      await page.evaluate(() => window.__lifeFlushConversationHistory())
      return (await stored()).map((thread) => ({
        id: thread.id,
        title: thread.title,
        titleSource: thread.titleSource,
        pinnedAt: thread.pinnedAt,
        pinOrder: thread.pinOrder,
        activeOrder: thread.activeOrder,
        settled: thread.settled,
        settledAt: thread.settledAt,
        snoozedAt: thread.snoozedAt,
        snoozedUntil: thread.snoozedUntil,
        archivedAt: thread.archivedAt,
        turn: thread.turn,
      }))
    }
    const beforeContextMenu = await arrangementSnapshot()
    const selectedBeforeContextMenu = await page.evaluate(() =>
      localStorage.getItem('life.active-thread.v1'),
    )
    await menu('thread-b')
    assert.deepEqual(await arrangementSnapshot(), beforeContextMenu)
    assert.equal(
      await page.evaluate(() => localStorage.getItem('life.active-thread.v1')),
      selectedBeforeContextMenu,
    )
    await page.keyboard.press('Escape')
    assert.deepEqual(await arrangementSnapshot(), beforeContextMenu)
    assert.equal(await page.evaluate(() => window.controlsTest.records.starts.length), 0)
    checks.push(
      'Opening and dismissing a right-click menu leaves every saved thread, arrangement and selection unchanged',
    )

    await action('thread-b', 'Rename thread')
    const rename = page.getByRole('dialog', { name: 'Rename thread', exact: true })
    await rename
      .getByRole('textbox', { name: 'Thread title', exact: true })
      .fill('Manual project title')
    await rename.getByRole('button', { name: 'Save title', exact: true }).click()
    await waitStored('thread-b', 'title', 'Manual project title')
    await page.evaluate(() => {
      window.controlsTest.emit('thread-b', 'title', { title: 'Provider generated replacement' })
      window.controlsTest.emit('thread-b', 'session', {
        title: 'Provider resumed title',
        remoteId: 'resumed-beta',
      })
    })
    await waitStored('thread-b', 'remoteId', 'resumed-beta')
    assert.equal(
      (await stored()).find((thread) => thread.id === 'thread-b').title,
      'Manual project title',
    )
    await reload()
    assert.match(await row('thread-b').getAttribute('aria-label'), /^Manual project title,/)
    assert.equal((await stored()).find((thread) => thread.id === 'thread-b').titleSource, 'manual')
    checks.push(
      'A manual rename persists across reload and survives provider session and title notifications',
    )

    await action('thread-b', 'Pin thread')
    await page.waitForFunction(() =>
      Boolean(window.controlsTest.stored().find((thread) => thread.id === 'thread-b').pinnedAt),
    )
    await action('thread-c', 'Pin thread')
    await page.waitForFunction(() =>
      Boolean(window.controlsTest.stored().find((thread) => thread.id === 'thread-c').pinnedAt),
    )
    await action('thread-b', 'Move up')
    await page.waitForFunction(
      () => window.controlsTest.stored().find((thread) => thread.id === 'thread-b').pinOrder === 1,
    )
    assert.deepEqual((await ids()).slice(0, 2), ['thread-b', 'thread-c'])
    await reload()
    assert.deepEqual((await ids()).slice(0, 2), ['thread-b', 'thread-c'])
    const beforeUnpin = (await stored()).find((thread) => thread.id === 'thread-b')
    await action('thread-b', 'Unpin thread')
    await page.waitForFunction(
      () => !window.controlsTest.stored().find((thread) => thread.id === 'thread-b').pinnedAt,
    )
    await page.getByRole('button', { name: 'Undo', exact: true }).click()
    await waitStored('thread-b', 'pinnedAt', beforeUnpin.pinnedAt)
    await waitStored('thread-b', 'pinOrder', beforeUnpin.pinOrder)
    assert.deepEqual((await ids()).slice(0, 2), ['thread-b', 'thread-c'])
    assert.deepEqual(
      (await stored()).find((thread) => thread.id === 'thread-b').messages,
      beforeUnpin.messages,
    )
    checks.push(
      'Pinning and manual order survive reload; unpin Undo restores exact rank without changing the transcript',
    )

    await action('thread-c', 'Unpin thread')
    await row('thread-a').click()
    await page
      .getByRole('button', { name: 'Filters, sorting and arrangement', exact: true })
      .click()
    const arrangement = page.getByRole('dialog', {
      name: 'Filters, sorting and arrangement',
      exact: true,
    })
    await arrangement
      .getByRole('combobox', { name: 'Arrange by', exact: true })
      .selectOption('project')
    await arrangement.getByRole('button', { name: 'Done', exact: true }).click()
    const collapse = page.getByRole('button', { name: 'Collapse project threads', exact: true })
    await collapse.click()
    assert.equal(await row('thread-a').isVisible(), true)
    assert.equal(await row('thread-c').count(), 0)
    await row('thread-a').focus()
    await row('thread-a').press('Home')
    assert.equal(await row('thread-b').evaluate((node) => node === document.activeElement), true)
    await row('thread-b').press('ArrowDown')
    assert.equal(await row('thread-a').evaluate((node) => node === document.activeElement), true)
    await row('thread-a').press('Shift+F10')
    await page.getByRole('menuitem', { name: 'Rename thread', exact: true }).waitFor()
    await page.keyboard.press('Escape')
    await page.waitForFunction(
      () => document.activeElement?.getAttribute('data-thread-row') === 'thread-a',
    )
    await reload()
    assert.equal(await row('thread-a').isVisible(), true)
    assert.equal(await row('thread-c').count(), 0)
    await page.getByRole('button', { name: 'Expand project threads', exact: true }).click()
    await row('thread-c').waitFor()
    checks.push(
      'Collapsed projects persist while retaining the selected row; visible-row keyboard navigation and context-menu focus work',
    )

    await action('thread-a', 'Settle thread')
    await waitStored('thread-a', 'settled', true)
    assert.equal(await row('thread-a').isVisible(), true)
    assert.equal(await row('thread-a').getAttribute('aria-current'), 'page')
    assert.equal(
      await shell('thread-a').evaluate((node) => node.classList.contains('thread-card-compact')),
      true,
    )
    await page.getByRole('button', { name: 'New thread', exact: true }).click()
    await page.waitForFunction(
      () => document.querySelector('[data-thread-row="thread-a"]') === null,
    )
    await page.getByRole('button', { name: 'Settled (2)', exact: true }).click()
    await row('thread-a').click()
    await action('thread-a', 'Restore thread')
    await waitStored('thread-a', 'settled', false)
    checks.push(
      'Settled work has a compact selected row even on a closed shelf, and can be reopened and restored',
    )

    await page.evaluate(() => window.controlsTest.emit('thread-b'))
    await waitStored('thread-b', 'busy', true)
    await menu('thread-b')
    assert.equal(
      await page
        .getByRole('menuitem', { name: 'Archive thread', exact: true })
        .getAttribute('aria-disabled'),
      'true',
    )
    assert.notEqual(
      await page
        .getByRole('menuitem', { name: 'Snooze thread', exact: true })
        .getAttribute('aria-disabled'),
      'true',
    )
    await page.keyboard.press('Escape')
    await page.evaluate(() =>
      window.controlsTest.emit('thread-b', 'approval', {
        requestId: 'approve-files',
        title: 'Approve file access',
        text: 'Allow reading the project?',
      }),
    )
    await page.waitForFunction(
      () =>
        document.querySelector('[data-thread-row="thread-b"]').closest('.thread-card-shell').dataset
          .needsInput === 'true',
    )
    await menu('thread-b')
    for (const name of ['Settle thread', 'Snooze thread', 'Archive thread'])
      assert.equal(
        await page.getByRole('menuitem', { name, exact: true }).getAttribute('aria-disabled'),
        'true',
      )
    await page.keyboard.press('Escape')
    await page.evaluate(() => {
      window.controlsTest.emit('thread-b', 'request-resolved', {
        requestId: 'approve-files',
        status: 'accepted',
      })
      window.controlsTest.emit('thread-b', 'complete', { status: 'completed' })
    })
    await waitStored('thread-b', 'busy', false)
    checks.push(
      'Live runs cannot be archived; pending provider requests disable settling, snoozing and archiving',
    )

    assert.equal(await shell('thread-b').getAttribute('data-unread'), 'true')
    assert.equal(await shell('thread-a').getAttribute('data-unread'), null)
    await row('thread-b').click()
    await page.waitForFunction(
      () =>
        !document
          .querySelector('[data-thread-row="thread-b"]')
          .closest('.thread-card-shell')
          .hasAttribute('data-unread'),
    )
    await page.evaluate(() =>
      window.controlsTest.emit('thread-b', 'complete', { status: 'completed' }),
    )
    assert.equal(await shell('thread-b').getAttribute('data-unread'), null)
    await row('thread-a').click()
    await page.evaluate(() => window.controlsTest.emit('thread-c'))
    await waitStored('thread-c', 'busy', true)
    await menu('thread-c')
    await page.getByRole('menuitem', { name: 'Snooze thread', exact: true }).hover()
    await page.getByRole('menuitem', { name: '30 minutes', exact: true }).click()
    await page.waitForFunction(() =>
      Boolean(window.controlsTest.stored().find((thread) => thread.id === 'thread-c').snoozedUntil),
    )
    assert.equal((await stored()).find((thread) => thread.id === 'thread-c').busy, true)
    await page.evaluate(() =>
      window.controlsTest.emit('thread-c', 'complete', { status: 'completed' }),
    )
    await page.waitForFunction(
      () => !window.controlsTest.stored().find((thread) => thread.id === 'thread-c').snoozedUntil,
    )
    await row('thread-c').waitFor()
    assert.equal(await shell('thread-c').getAttribute('data-unread'), 'true')
    checks.push(
      'Only inactive completed turns become unread; selecting clears them, duplicate completion stays read, and fresh completion wakes snoozed work',
    )

    const original = (await stored()).find((thread) => thread.id === 'thread-a')
    await action('thread-a', 'Archive thread')
    await page.waitForFunction(() =>
      Boolean(window.controlsTest.stored().find((thread) => thread.id === 'thread-a').archivedAt),
    )
    await page.waitForFunction(() => !localStorage.getItem('life.active-thread.v1'))
    await page.getByRole('button', { name: 'Undo', exact: true }).click()
    await page.waitForFunction(() => localStorage.getItem('life.active-thread.v1') === 'thread-a')
    await waitStored('thread-a', 'archivedAt', undefined)
    const restored = (await stored()).find((thread) => thread.id === 'thread-a')
    assert.equal(restored.archivedAt, undefined)
    for (const field of ['messages', 'turn', 'remoteId', 'model', 'workspace', 'busy'])
      assert.deepEqual(restored[field], original[field])
    assert.equal(await page.evaluate(() => window.controlsTest.records.starts.length), 0)
    assert.deepEqual(await page.evaluate(() => window.controlsTest.records.stops), [])
    checks.push(
      'Archiving the active conversation opens a fresh draft; Undo reopens the exact conversation without starting or stopping any run',
    )

    await composer.fill('Original Alpha draft remains with its thread.')
    await page.getByRole('button', { name: 'New thread', exact: true }).click()
    assert.equal(await composer.inputValue(), '')
    await composer.fill('Invested new-thread text with a local attachment.')
    await page.getByLabel('Choose images or files', { exact: true }).setInputFiles({
      name: 'draft-evidence.txt',
      mimeType: 'text/plain',
      buffer: Buffer.from('Exact local attachment bytes\n'),
    })
    await page.getByRole('button', { name: 'Remove draft-evidence.txt', exact: true }).waitFor()
    await page.waitForFunction(() =>
      Boolean(
        JSON.parse(localStorage.getItem('life.conversation-drafts.v1') || '{}')['agents:new']
          ?.attachments?.length,
      ),
    )
    await page.getByRole('button', { name: 'New thread', exact: true }).click()
    await page.waitForFunction(() =>
      window.controlsTest.stored().some((thread) => thread.title === 'Draft thread'),
    )
    const retained = (await stored()).find((thread) => thread.title === 'Draft thread')
    assert.equal(await composer.inputValue(), '')
    assert.equal(retained.model, original.model)
    assert.equal(retained.provider, original.provider)
    await row(retained.id).click()
    assert.equal(await composer.inputValue(), 'Invested new-thread text with a local attachment.')
    await page.getByRole('button', { name: 'Remove draft-evidence.txt', exact: true }).waitFor()
    await page.evaluate(() => {
      localStorage.setItem('life.workflow-fixture.offline', 'true')
      window.controlsTest.emitConnection('primary', false)
    })
    await reload()
    await page.getByRole('button', { name: 'Remove draft-evidence.txt', exact: true }).waitFor()
    assert.equal(await composer.inputValue(), 'Invested new-thread text with a local attachment.')
    assert.equal(await page.locator('.draft-unavailable-attachments').count(), 0)
    const downloaded = page.waitForEvent('download')
    await page
      .locator('.composer-container')
      .getByRole('button', { name: 'Download draft-evidence.txt', exact: true })
      .click()
    const download = await downloaded
    assert.equal(await readFile(await download.path(), 'utf8'), 'Exact local attachment bytes\n')
    await page.evaluate(() => {
      localStorage.removeItem('life.workflow-fixture.offline')
      window.controlsTest.emitConnection('primary', true)
    })
    await row('thread-a').click()
    assert.equal(await composer.inputValue(), 'Original Alpha draft remains with its thread.')
    checks.push(
      'Starting another new thread retains invested text and files as a named draft, inherits model/provider, and restores exact IndexedDB bytes after offline reload',
    )

    await page.evaluate(() => {
      window.controlsTest.emitConnection('other')
      window.controlsTest.holdState(true)
    })
    await composer.fill('Exact asynchronous submission.')
    await page.getByRole('button', { name: 'Send message', exact: true }).click()
    await page.waitForFunction(() => window.controlsTest.records.heldStateReads >= 1)
    await composer.fill('New text typed while connection verification was pending.')
    await action('thread-a', 'Rename thread')
    const asynchronousRename = page.getByRole('dialog', { name: 'Rename thread', exact: true })
    await asynchronousRename
      .getByRole('textbox', { name: 'Thread title', exact: true })
      .fill('Title chosen during context restoration')
    await asynchronousRename.getByRole('button', { name: 'Save title', exact: true }).click()
    await waitStored('thread-a', 'title', 'Title chosen during context restoration')
    await action('thread-a', 'Pin thread')
    await page.waitForFunction(() =>
      Boolean(window.controlsTest.stored().find((thread) => thread.id === 'thread-a').pinnedAt),
    )
    await action('thread-a', 'Mark read')
    const duringRestoration = (await stored()).find((thread) => thread.id === 'thread-a')
    await page.evaluate(() => window.controlsTest.releaseStates())
    await page.waitForFunction(() => window.controlsTest.records.starts.length === 1)
    assert.equal(
      (await page.evaluate(() => window.controlsTest.records.starts[0])).prompt,
      'Exact asynchronous submission.',
    )
    assert.equal(
      await composer.inputValue(),
      'New text typed while connection verification was pending.',
    )
    await waitStored('thread-a', 'turn', original.turn + 1)
    const afterRestoration = (await stored()).find((thread) => thread.id === 'thread-a')
    for (const field of ['title', 'titleSource', 'pinnedAt', 'pinOrder'])
      assert.deepEqual(
        afterRestoration[field],
        duringRestoration[field],
        field + ' survives context restoration',
      )
    assert.ok(
      afterRestoration.lastReadAt >= duringRestoration.lastReadAt,
      'The read clock must not rewind while the active conversation is being restored',
    )
    assert.equal(afterRestoration.titleSource, 'manual')
    await page.evaluate(() =>
      window.controlsTest.emit('thread-a', 'complete', { status: 'completed' }),
    )
    await waitStored('thread-a', 'busy', false)
    checks.push(
      'Delayed machine restoration sends the captured prompt exactly while preserving new typed text, manual title, pin and read metadata',
    )

    await page.evaluate(() => window.workflowTest.holdStart(true))
    await composer.fill('Rejected submission is recovered.')
    await page.getByLabel('Choose images or files', { exact: true }).setInputFiles({
      name: 'rejected.txt',
      mimeType: 'text/plain',
      buffer: Buffer.from('Keep rejected attachment\n'),
    })
    await page.getByRole('button', { name: 'Remove rejected.txt', exact: true }).waitFor()
    await page.getByRole('button', { name: 'Send message', exact: true }).click()
    await page.waitForFunction(() => window.workflowTest.startReady())
    await composer.fill('Keep text typed after the submission.')
    await composer.evaluate((node) => {
      const transfer = new DataTransfer()
      transfer.items.add(
        new File(
          ['Attachment added while the provider response was pending\n'],
          'typed-later.txt',
          { type: 'text/plain' },
        ),
      )
      node.dispatchEvent(
        new ClipboardEvent('paste', { clipboardData: transfer, bubbles: true, cancelable: true }),
      )
    })
    await page.evaluate(() => window.workflowTest.rejectStart())
    await waitStored('thread-a', 'turnStatus', 'failed')
    await page.waitForFunction(
      () =>
        document.querySelector('[aria-label="Message your coding agent"]').value ===
        'Rejected submission is recovered.\n\nKeep text typed after the submission.',
    )
    await page.getByRole('button', { name: 'Remove rejected.txt', exact: true }).waitFor()
    await page.getByRole('button', { name: 'Remove typed-later.txt', exact: true }).waitFor()
    assert.equal(await page.evaluate(() => window.controlsTest.records.starts.length), 2)
    checks.push(
      'A failed provider send recovers its prompt and attachment while retaining text and another file added during the request',
    )

    await action('thread-a', 'Settle thread')
    await waitStored('thread-a', 'settled', true)
    await action('thread-a', 'Restore thread')
    await waitStored('thread-a', 'settled', false)
    await page.getByRole('button', { name: 'Remove rejected.txt', exact: true }).click()
    await page.getByRole('button', { name: 'Remove typed-later.txt', exact: true }).click()
    await composer.fill('A new turn owns its lifecycle after Restore.')
    await page.evaluate(() => window.workflowTest.holdStart(true))
    await page.getByRole('button', { name: 'Send message', exact: true }).click()
    await page.waitForFunction(() => window.workflowTest.startReady())
    await page.getByRole('button', { name: 'Undo', exact: true }).click()
    await waitStored('thread-a', 'turn', original.turn + 3)
    const afterNewTurnUndo = (await stored()).find((thread) => thread.id === 'thread-a')
    assert.equal(afterNewTurnUndo.busy, true)
    assert.equal(afterNewTurnUndo.settled, false)
    assert.equal(afterNewTurnUndo.archivedAt, undefined)
    assert.equal(
      afterNewTurnUndo.messages.at(-1).text,
      'A new turn owns its lifecycle after Restore.',
    )
    await page.evaluate(() => window.workflowTest.resolveStart())
    await page.evaluate(() =>
      window.controlsTest.emit('thread-a', 'complete', { status: 'completed' }),
    )
    await waitStored('thread-a', 'busy', false)
    checks.push(
      'Undo from an older Restore action cannot settle or archive a newly started turn or overwrite its message',
    )
    const beforeLateRequest = (await stored()).find((thread) => thread.id === 'thread-a')
    const heldBeforeLateRequest = await page.evaluate(
      () => window.controlsTest.records.heldStateReads,
    )
    await page.evaluate(() => {
      window.controlsTest.emitConnection('other')
      window.controlsTest.holdState(true)
    })
    await composer.fill('Do not send before the saved machine has been restored.')
    await page.getByRole('button', { name: 'Send message', exact: true }).click()
    await page.waitForFunction(
      (previous) => window.controlsTest.records.heldStateReads > previous,
      heldBeforeLateRequest,
    )
    await action('thread-a', 'Archive thread')
    await page
      .getByText(
        'This message is being prepared. Wait for it to finish before organizing the thread.',
        { exact: true },
      )
      .waitFor()
    assert.equal((await stored()).find((thread) => thread.id === 'thread-a').archivedAt, undefined)
    await action('thread-a', 'Delete thread')
    assert.equal(await page.getByRole('dialog', { name: 'Delete thread', exact: true }).count(), 0)
    await composer.fill('Keep this later draft while an approval arrives.')
    await page.evaluate(() =>
      window.controlsTest.emit('thread-a', 'approval', {
        requestId: 'arrived-during-restore',
        title: 'Approve before continuing',
        text: 'A native request arrived during restoration.',
      }),
    )
    await page.evaluate(() => window.controlsTest.releaseStates())
    await page
      .getByText(
        'The thread changed while its project was opening. Your draft is kept; send it again when the thread is ready.',
        { exact: true },
      )
      .waitFor()
    assert.equal(await composer.inputValue(), 'Keep this later draft while an approval arrives.')
    assert.equal(await page.evaluate(() => window.controlsTest.records.starts.length), 3)
    assert.equal(
      (await stored()).find((thread) => thread.id === 'thread-a').turn,
      beforeLateRequest.turn,
    )
    assert.equal(await shell('thread-a').getAttribute('data-needs-input'), 'true')
    await page.evaluate(() =>
      window.controlsTest.emit('thread-a', 'request-resolved', {
        requestId: 'arrived-during-restore',
        status: 'approved',
      }),
    )
    checks.push(
      'Preparing a message blocks archive and delete; a fresh native request during restoration prevents dispatch and preserves the newer draft',
    )
    await page.screenshot({ path: join(output, 'v0.12.0-thread-workflows.png') })
    assert.deepEqual(errors, [])
    const proof = {
      checks,
      count: checks.length,
      browserErrors: errors,
      records: await page.evaluate(() => window.controlsTest.records),
    }
    await writeFile(
      join(output, 'v0.12.0-thread-workflows-proof.json'),
      JSON.stringify(proof, null, 2),
    )
    console.log(JSON.stringify(proof, null, 2))
  } catch (error) {
    if (page) {
      await page
        .screenshot({ path: join(output, 'v0.12.0-thread-workflows-failure.png') })
        .catch(() => {})
      await writeFile(
        join(output, 'v0.12.0-thread-workflows-failure.html'),
        await page.content(),
      ).catch(() => {})
    }
    throw error
  } finally {
    await browser?.close()
    if (server) await new Promise((resolve) => server.close(resolve))
    await rm(directory, { recursive: true, force: true })
  }
}

run().catch((error) => {
  console.error(error)
  process.exitCode = 1
})
