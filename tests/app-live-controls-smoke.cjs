#!/usr/bin/env node
// Exercise Life's actual App, UI handlers and IndexedDB in Chromium.
const assert = require('node:assert/strict')
const { createServer } = require('node:http')
const { mkdtemp, readFile, rm, writeFile } = require('node:fs/promises')
const { join, resolve } = require('node:path')
const { tmpdir } = require('node:os')
const { build } = require('esbuild')
const { chromium } = require('playwright')

async function run() {
  const directory = await mkdtemp(join(tmpdir(), 'life-app-live-controls-'))
  const checks = []
  const errors = []
  let browser
  let server
  let page
  try {
    await build({
      stdin: {
        resolveDir: resolve(__dirname, '..'),
        sourcefile: 'app-live-controls-fixture.tsx',
        loader: 'tsx',
        contents: `
          import React from 'react'
          import {createRoot} from 'react-dom/client'
          import {App} from './src/renderer/App'
          import {defaultLifeConfig} from './src/shared/customization'
          window.testConfig = {...defaultLifeConfig, workspacePanel:false}
          createRoot(document.getElementById('root')).render(<React.StrictMode><App/></React.StrictMode>)
        `,
      },
      bundle: true,
      jsx: 'automatic',
      outfile: join(directory, 'fixture.js'),
      define: { 'process.env.NODE_ENV': '"development"' },
      logLevel: 'silent',
      loader: { '.woff2': 'file', '.woff': 'file', '.ttf': 'file' },
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
    await page.addInitScript(() => {
      const profile = {
        id: 'machine-test',
        name: 'Test machine',
        host: 'test.example',
        port: 22,
        username: 'tester',
        auth: 'agent',
        privateKeyPath: '',
        workspace: '/srv/project',
      }
      const connection = {
        status: 'connected',
        profile,
        home: '/home/tester',
        workspace: profile.workspace,
        codex: '0.161.0',
        claude: '2.1.0',
      }
      const listeners = new Set()
      const records = {
        steering: [],
        configure: [],
        starts: [],
        stateReads: 0,
        heldStateReads: 0,
        heldWrites: 0,
      }
      let holdState = false
      let holdWrites = false
      const states = []
      const writes = []
      const configurations = []
      const off = () => () => {}
      const emptySource = {
        revision: 0,
        enabled: false,
        canRollback: false,
        path: '',
        recovered: false,
        extensions: [],
        builtInRevision: 0,
      }
      const emptyExtensions = {
        extensions: [],
        revision: 0,
        path: '',
        errors: {},
        canRollback: [],
        recovered: false,
      }
      const thread = (id, title) => ({
        id,
        profileId: profile.id,
        workspace: profile.workspace,
        provider: 'codex',
        title,
        remoteId: 'remote-' + id,
        messages: [
          {
            id: id + '-request',
            role: 'user',
            text: 'Original request',
            turn: 1,
            createdAt: Date.now(),
          },
        ],
        busy: false,
        model: 'test-model',
        reasoningEffort: 'medium',
        serviceTier: 'default',
        mode: 'review',
        updatedAt: Date.now(),
        turn: 1,
        pending: [],
      })
      const reservedCases = ['research', 'customization', 'metadata'].flatMap((purpose) =>
        ['marker', 'directory'].map((classification) => ({
          purpose,
          classification,
          id: `legacy-${purpose}-${classification}`,
        })),
      )
      const savedThreads = [
        thread('thread-a', 'Thread Alpha'),
        thread('thread-b', 'Thread Beta'),
        ...reservedCases.map((item) =>
          thread(item.id, `Legacy ${item.purpose} ${item.classification}`),
        ),
        { ...thread('verified-studio', 'Saved Studio conversation'), purpose: 'customization' },
      ]
      localStorage.setItem('relay.threads.v1', JSON.stringify(savedThreads))
      const historyPages = reservedCases.map((item) => ({
        session: {
          id: 'codex:remote-' + item.id,
          provider: 'codex',
          remoteId: 'remote-' + item.id,
          title: `Native ${item.purpose} ${item.classification}`,
          workspace:
            item.classification === 'directory'
              ? connection.home + '/.life/' + item.purpose + '/reserved'
              : profile.workspace,
          ...(item.classification === 'marker' ? { lifePurpose: item.purpose } : {}),
          createdAt: 1,
          updatedAt: 2,
          source: 'cli',
        },
        messages: [
          {
            id: 'native:' + item.id,
            role: 'user',
            text: 'Native reserved transcript must never enter Agents.',
            turn: 1,
          },
        ],
        subagents: [],
        warnings: [],
      }))
      historyPages.push({
        session: {
          id: 'codex:remote-thread-b',
          provider: 'codex',
          remoteId: 'remote-thread-b',
          title: 'Native Beta newer transcript',
          workspace: profile.workspace,
          createdAt: 1,
          updatedAt: 2,
          source: 'cli',
        },
        messages: [
          {
            id: 'native:later-beta',
            role: 'user',
            text: 'New external content must not overwrite the saved Life transcript.',
            turn: 1,
          },
        ],
        subagents: [],
        warnings: [],
      })
      historyPages.push({
        session: {
          id: 'codex:remote-verified-studio',
          provider: 'codex',
          remoteId: 'remote-verified-studio',
          title: 'Native verified Studio',
          workspace: connection.home + '/.life/customization/saved',
          lifePurpose: 'customization',
          createdAt: 1,
          updatedAt: 2,
          source: 'cli',
        },
        messages: [],
        subagents: [],
        warnings: [],
      })
      localStorage.setItem('life.active-thread.v1', 'thread-a')
      const originalTransaction = IDBDatabase.prototype.transaction
      IDBDatabase.prototype.transaction = function (...args) {
        const transaction = originalTransaction.apply(this, args)
        if (!holdWrites || args[1] !== 'readwrite') return transaction
        let complete
        transaction.addEventListener('complete', (event) => {
          records.heldWrites++
          writes.push(() => complete?.call(transaction, event))
        })
        return new Proxy(transaction, {
          set(target, key, value) {
            if (key === 'oncomplete') {
              complete = value
              return true
            }
            return Reflect.set(target, key, value, target)
          },
          get(target, key) {
            const value = Reflect.get(target, key, target)
            return typeof value === 'function' ? value.bind(target) : value
          },
        })
      }
      window.relay = {
        platform: 'win32',
        onAgent: (callback) => {
          listeners.add(callback)
          return () => listeners.delete(callback)
        },
        onConnection: off,
        onHostKey: off,
        profiles: { list: async () => [profile] },
        connection: {
          state: async () => {
            records.stateReads++
            if (holdState) {
              records.heldStateReads++
              await new Promise((resolve) => states.push(resolve))
            }
            return structuredClone(connection)
          },
          execute: async (input) =>
            input.command.includes('LIFE_ATTACHMENT_DIR=')
              ? 'LIFE_BASE64=-d\nLIFE_ATTACHMENT_DIR=/tmp/life-thread-attachments.ABCDEF\n'
              : input.command.includes('LIFE_ATTACHMENT_OK')
                ? 'LIFE_ATTACHMENT_OK'
                : 'LIFE_BRANCH=main\nLIFE_PR=',
          selectWorkspace: async () => structuredClone(connection),
          cancel: async () => {},
        },
        agent: {
          models: async () => [
            {
              id: 'test-model',
              name: 'Test model',
              defaultReasoningEffort: 'medium',
              supportedReasoningEfforts: [
                { reasoningEffort: 'medium', description: 'Medium' },
                { reasoningEffort: 'high', description: 'High' },
              ],
              serviceTiers: [
                { id: 'default', name: 'Default' },
                { id: 'fast', name: 'Fast' },
              ],
            },
          ],
          steer: async (input) => {
            records.steering.push(structuredClone(input))
          },
          configure: (input) => {
            records.configure.push(structuredClone(input))
            return new Promise((resolve, reject) => configurations.push({ resolve, reject }))
          },
          start: async (input) => {
            records.starts.push(structuredClone(input))
          },
          stop: async () => {},
          dispose: async () => {},
        },
        customization: {
          get: async () => ({ config: window.testConfig, revision: 0, canUndo: false, path: '' }),
          onChange: off,
        },
        extensions: {
          get: async () => emptyExtensions,
          onState: off,
          onRecovery: off,
          capabilities: [],
        },
        sourceCode: { get: async () => emptySource, onState: off },
        updates: {
          get: async () => ({ status: 'unsupported', currentVersion: '0.7.0' }),
          onState: off,
        },
        window: { state: async () => false, onState: off },
        forwarding: {
          get: async () => ({ enabled: false, active: false, ports: [] }),
          onState: off,
        },
        hostHistory: {
          list: async () => ({
            sessions: historyPages.map((page) => structuredClone(page.session)),
            warnings: [],
          }),
          read: async (input) =>
            structuredClone(historyPages.find((page) => page.session.id === input.id)),
          cancel: async () => {},
        },
      }
      window.controlsTest = {
        records,
        emit: (id, type = 'status', extra = {}) =>
          listeners.forEach((fn) => fn({ sessionId: id, type, status: 'running', ...extra })),
        holdState: (value) => {
          holdState = value
        },
        releaseStates: () => {
          holdState = false
          for (const resolve of states.splice(0)) resolve()
        },
        holdWrites: (value) => {
          holdWrites = value
        },
        releaseWrites: () => {
          holdWrites = false
          for (const resolve of writes.splice(0)) resolve()
        },
        resolveConfiguration: (index, note) =>
          configurations[index].resolve({ applied: 'live', note }),
        rejectConfiguration: (index, message) => configurations[index].reject(new Error(message)),
        stored: () => JSON.parse(localStorage.getItem('relay.threads.v1')),
      }
    })
    await page.goto(`http://127.0.0.1:${server.address().port}`)
    const settle = async () =>
      page.evaluate(
        () => new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve))),
      )
    await page.getByRole('textbox', { name: 'Message your coding agent' }).waitFor()
    await page.waitForFunction(() => window.controlsTest.records.stateReads >= 2)
    await settle()
    await page.evaluate(() => window.controlsTest.emit('thread-a'))
    await page.getByRole('button', { name: 'Steer current response', exact: true }).waitFor()
    const literal = '  Exact steering text.\n\nNo extra words.  '
    await page.getByRole('textbox', { name: 'Message your coding agent' }).fill(literal)
    await page.evaluate(() => {
      window.controlsTest.holdState(true)
      const button = document.querySelector('.composer-steer')
      button.click()
      button.click()
    })
    await page.waitForFunction(() => window.controlsTest.records.heldStateReads >= 1)
    await settle()
    assert.equal(
      await page.evaluate(() => window.controlsTest.records.heldStateReads),
      1,
      'Two rapid clicks acquire only one connection-state request',
    )
    await page.evaluate(() => window.controlsTest.releaseStates())
    await page.waitForFunction(() => window.controlsTest.records.steering.length === 1)
    await settle()
    assert.equal(await page.evaluate(() => window.controlsTest.records.steering[0].prompt), literal)
    assert.equal(await page.evaluate(() => window.controlsTest.records.starts.length), 0)
    checks.push(
      'Rapid double steering during a delayed connection read sends the literal draft exactly once',
    )

    await page.locator('input[type="file"]').setInputFiles({
      name: 'held-attachment.txt',
      mimeType: 'text/plain',
      buffer: Buffer.from('Real IndexedDB payload'),
    })
    await page.getByText('Uploaded · ready to send', { exact: true }).waitFor()
    await page
      .getByRole('textbox', { name: 'Message your coding agent' })
      .fill('  Steer with the real attachment.\n')
    await page.evaluate(() => {
      window.controlsTest.holdWrites(true)
      const button = document.querySelector('.composer-steer')
      button.click()
      button.click()
    })
    await page.waitForFunction(() => window.controlsTest.records.heldWrites >= 1)
    await settle()
    assert.equal(
      await page.evaluate(() => window.controlsTest.records.heldWrites),
      1,
      'The steering mutex is held before saving attachments',
    )
    assert.equal(
      await page.evaluate(() => window.controlsTest.records.steering.length),
      1,
      'Steering waits for durable IndexedDB attachment storage',
    )
    await page.evaluate(() => window.controlsTest.releaseWrites())
    await page.waitForFunction(() => window.controlsTest.records.steering.length === 2)
    assert.equal(
      await page.evaluate(() => window.controlsTest.records.steering[1].attachments.length),
      1,
    )
    checks.push(
      'Rapid double steering during delayed real IndexedDB storage sends one attachment request',
    )

    const chooseEffort = async (name) => {
      await page.getByRole('button', { name: /^Reasoning:.*speed:/ }).click()
      await page.getByRole('menuitemradio', { name, exact: true }).click()
    }
    await chooseEffort('High')
    await page.waitForFunction(() => window.controlsTest.records.configure.length === 1)
    await page.getByRole('button', { name: /^Thread Beta, OpenAI/ }).click()
    await settle()
    await page.evaluate(() => window.controlsTest.resolveConfiguration(0, 'OLD ALPHA NOTICE'))
    await settle()
    assert.equal(await page.getByText('OLD ALPHA NOTICE', { exact: true }).count(), 0)
    checks.push(
      'An acknowledged configuration for thread A does not appear after selecting thread B',
    )

    await page.evaluate(() => window.controlsTest.emit('thread-b'))
    await chooseEffort('High')
    await page.waitForFunction(() => window.controlsTest.records.configure.length === 2)
    await page.getByRole('button', { name: /^Thread Alpha, OpenAI/ }).click()
    await settle()
    await page.evaluate(() => window.controlsTest.rejectConfiguration(1, 'OLD BETA FAILURE'))
    await settle()
    assert.equal(await page.getByText('OLD BETA FAILURE', { exact: true }).count(), 0)
    checks.push('A rejected configuration for thread B does not appear after selecting thread A')

    await chooseEffort('Medium')
    await page.waitForFunction(() => window.controlsTest.records.configure.length === 3)
    await chooseEffort('High')
    await page.waitForFunction(() => window.controlsTest.records.configure.length === 4)
    await page.evaluate(() => window.controlsTest.resolveConfiguration(3, 'LATEST ALPHA NOTICE'))
    await page.getByText('LATEST ALPHA NOTICE', { exact: true }).waitFor()
    await page.evaluate(() =>
      window.controlsTest.resolveConfiguration(2, 'SUPERSEDED ALPHA NOTICE'),
    )
    await settle()
    assert.equal(await page.getByText('SUPERSEDED ALPHA NOTICE', { exact: true }).count(), 0)
    assert.equal(await page.getByText('LATEST ALPHA NOTICE', { exact: true }).count(), 1)
    checks.push(
      'Out-of-order acknowledgements preserve the latest settings notice in the same thread',
    )

    const openNativeHistory = async (title) => {
      await page.getByRole('button', { name: 'Host chat history', exact: true }).click()
      const dialog = page.getByRole('dialog', { name: 'Host chat history', exact: true })
      await dialog.locator('.host-history-session').filter({ hasText: title }).click()
      await dialog
        .locator('.host-history-preview-header')
        .getByRole('button', { name: /^(Open in (Life|Research)|Resume in Life)$/ })
        .click()
      await dialog.waitFor({ state: 'hidden' })
      await settle()
    }
    for (const purpose of ['research', 'customization', 'metadata']) {
      for (const classification of ['marker', 'directory']) {
        await openNativeHistory(`Native ${purpose} ${classification}`)
        assert.match(
          await page.locator('.thread-row.active').getAttribute('aria-label'),
          /^Thread Alpha,/,
        )
        assert.equal(await page.locator('.app-shell').getAttribute('data-view'), 'workspace')
        assert.equal(
          await page.evaluate(() => localStorage.getItem('life.active-thread.v1')),
          'thread-a',
        )
        assert.equal(
          await page.locator('.toast').count(),
          1,
          'Reserved native session reports its owning domain',
        )
        const expected =
          purpose === 'research'
            ? 'Research'
            : purpose === 'customization'
              ? 'Life Studio'
              : 'internal conversation-title task'
        assert.ok((await page.locator('.toast').innerText()).includes(expected))
      }
      checks.push(
        `Legacy ${purpose} native history cannot bypass its reserved domain using a matching unclassified Life thread`,
      )
    }
    await openNativeHistory('Native Beta newer transcript')
    assert.match(
      await page.locator('.thread-row.active').getAttribute('aria-label'),
      /^Thread Beta,/,
    )
    assert.equal(
      await page.evaluate(() => localStorage.getItem('life.active-thread.v1')),
      'thread-b',
    )
    assert.equal(await page.locator('[data-message-id="thread-b-request"]').count(), 1)
    assert.equal(
      await page
        .getByText('New external content must not overwrite the saved Life transcript.', {
          exact: true,
        })
        .count(),
      0,
    )
    assert.equal(await page.evaluate(() => window.controlsTest.records.starts.length), 0)
    checks.push(
      'Opening ordinary existing host history reuses its saved Life thread and preserves its transcript',
    )
    await openNativeHistory('Native verified Studio')
    assert.equal(await page.locator('.app-shell').getAttribute('data-view'), 'customization')
    assert.equal(
      await page.evaluate(() => localStorage.getItem('life.active-thread.v1')),
      'thread-b',
    )
    assert.equal(
      await page.getByRole('button', { name: /^Saved Studio conversation, OpenAI/ }).count(),
      0,
    )
    assert.equal(await page.evaluate(() => window.controlsTest.records.starts.length), 0)
    checks.push(
      'Verified Studio history keeps its dedicated route without creating or selecting an Agents thread',
    )
    assert.deepEqual(errors, [])
    const proof = {
      ok: true,
      checks,
      browserErrors: errors,
      records: await page.evaluate(() => window.controlsTest.records),
    }
    if (process.env.LIFE_APP_CONTROLS_PROOF)
      await writeFile(process.env.LIFE_APP_CONTROLS_PROOF, JSON.stringify(proof, null, 2))
    console.log(JSON.stringify(proof, null, 2))
  } catch (error) {
    console.error(
      JSON.stringify(
        {
          browserErrors: errors,
          checks,
          text: page ? (await page.locator('body').innerText()).slice(0, 10000) : '',
        },
        null,
        2,
      ),
    )
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
