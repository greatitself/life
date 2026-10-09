#!/usr/bin/env node
// Real-browser regression for a React crash after the workspace has already mounted.
const assert = require('node:assert/strict')
const { createServer } = require('node:http')
const { mkdtemp, readFile, rm } = require('node:fs/promises')
const { join, resolve } = require('node:path')
const { tmpdir } = require('node:os')
const { build } = require('esbuild')
const { chromium } = require('playwright')

async function run() {
  const directory = await mkdtemp(join(tmpdir(), 'life-renderer-recovery-'))
  let browser
  let server
  try {
    await build({
      stdin: {
        resolveDir: resolve(__dirname, '..'),
        sourcefile: 'renderer-recovery-fixture.tsx',
        loader: 'tsx',
        contents: `
          import React, { useState } from 'react'
          import { createRoot } from 'react-dom/client'
          import { RendererErrorBoundary } from './src/renderer/components/RendererErrorBoundary'
          window.recoveryCalls = 0
          window.restartCalls = 0
          window.restartMode = 'reject'
          window.documentInstance = crypto.randomUUID()
          window.windowCalls = []
          window.recoveryMode = 'reject'
          window.workspaceRenders = 0
          window.forcePersistentFailure = new URL(location.href).searchParams.has('initialFailure')
          window.rendererErrors = []
          window.addEventListener('life:renderer-error', event => window.rendererErrors.push(event.detail))
          function Workspace() {
            const [broken, setBroken] = useState(false)
            window.workspaceRenders++
            if (broken || window.forcePersistentFailure)
              throw new Error('<img src=x onerror=alert(1)> late render failure')
            return <main><h1>Healthy workspace</h1>
              <p>{JSON.parse(localStorage.getItem('life.saved-test-thread')).title}</p>
              <button onClick={() => setBroken(true)}>Add another project</button>
            </main>
          }
          const recoveryApi = {
            platform: new URL(location.href).searchParams.get('platform') || 'win32',
            extensions: {
              recover: async () => {
                window.recoveryCalls++
                if (window.recoveryMode === 'reject') throw new Error('Native recovery unavailable')
                await new Promise(resolve => { window.completeRecovery = resolve })
              },
            },
            window: {
              minimize: () => window.windowCalls.push('minimize'),
              maximize: () => window.windowCalls.push('maximize'),
              close: () => window.windowCalls.push('close'),
              restart: async () => {
                window.restartCalls++
                if (window.restartMode === 'reject') throw new Error('Native restart unavailable')
                if (window.restartMode === 'pending')
                  await new Promise(resolve => { window.completeRestart = resolve })
                location.reload()
              },
            },
          }
          if (new URL(location.href).searchParams.has('markerOnly')) {
            document.getElementById('root').innerHTML = '<div data-life-renderer-error="Marker-only customized render failure">Failed</div>'
          } else {
            createRoot(document.getElementById('root')).render(
              <React.StrictMode><RendererErrorBoundary recoveryApi={new URL(location.href).searchParams.has('browser') ? undefined : recoveryApi}>
                <Workspace />
              </RendererErrorBoundary></React.StrictMode>,
            )
          }
        `,
      },
      bundle: true,
      jsx: 'automatic',
      outfile: join(directory, 'fixture.js'),
      define: { 'process.env.NODE_ENV': '"development"' },
      logLevel: 'silent',
    })
    await build({
      entryPoints: [resolve(__dirname, '../src/renderer/bootstrap.ts')],
      bundle: true,
      format: 'esm',
      outfile: join(directory, 'bootstrap.js'),
      logLevel: 'silent',
      plugins: [
        {
          name: 'isolated-stock-main',
          setup(plugin) {
            plugin.onResolve({ filter: /^\.\/main$/ }, (args) =>
              args.importer.endsWith('/bootstrap.ts')
                ? { path: 'main', namespace: 'test-stock-main' }
                : undefined,
            )
            plugin.onLoad({ filter: /.*/, namespace: 'test-stock-main' }, () => ({
              contents:
                'document.getElementById("root").innerHTML = "<h1>Stock Life workspace</h1>"',
            }))
          },
        },
      ],
    })
    server = createServer(async (request, response) => {
      const path = request.url.split('?')[0]
      const file = ['fixture.js', 'fixture.css', 'bootstrap.js'].find((name) => path === `/${name}`)
      response.setHeader(
        'Content-Type',
        file?.endsWith('.js')
          ? 'text/javascript'
          : file === 'fixture.css'
            ? 'text/css'
            : 'text/html',
      )
      const entry = path === '/bootstrap' ? 'bootstrap' : 'fixture'
      const html = `<!doctype html><html><head><link rel="stylesheet" href="/fixture.css"></head><body><div id="root"></div><script type="module" src="/${entry}.js"></script></body></html>`
      response.end(file ? await readFile(join(directory, file)) : html)
    })
    await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
    browser = await chromium.launch({ headless: true })
    const page = await browser.newPage()
    const savedThread = JSON.stringify({
      id: 'existing-thread',
      title: 'Saved research',
      workspace: '/research/project',
    })
    await page.addInitScript((saved) => {
      localStorage.setItem('life.saved-test-thread', saved)
      if (location.pathname !== '/bootstrap') return
      window.sourceSnapshot = {
        enabled: true,
        active: { revision: 7, js: '/fixture.js', css: '/fixture.css' },
      }
      window.sourceReady = []
      window.sourceErrors = []
      window.relay = {
        sourceCode: {
          get: async () => structuredClone(window.sourceSnapshot),
          ready: async (revision) => {
            window.sourceReady.push(revision)
          },
          reportError: async (revision, message) => {
            window.sourceErrors.push({ revision, message })
          },
        },
      }
    }, savedThread)
    const url = `http://127.0.0.1:${server.address().port}`
    await page.goto(url)
    await page.getByRole('heading', { name: 'Healthy workspace' }).waitFor()
    await page.getByRole('button', { name: 'Add another project' }).click()
    const panel = page.getByRole('alert')
    await panel.waitFor()
    assert.equal(
      await panel.getByRole('heading').textContent(),
      'The workspace could not be displayed',
    )
    assert.match(
      await page.locator('[data-life-renderer-error]').getAttribute('data-life-renderer-error'),
      /late render failure/,
    )
    assert.ok(
      await page.evaluate(() =>
        window.rendererErrors.some((message) => message.includes('late render failure')),
      ),
      'Customized bootstrap receives handled React errors',
    )
    assert.equal(await panel.evaluate((element) => document.activeElement === element), true)
    assert.equal(
      await page.evaluate(() => localStorage.getItem('life.saved-test-thread')),
      savedThread,
    )
    assert.equal(await panel.locator('img').count(), 0, 'Error messages are rendered as text')
    const crashedDocument = await page.evaluate(() => window.documentInstance)
    const rendersBeforeNativeRetry = await page.evaluate(() => window.workspaceRenders)
    await page.getByRole('button', { name: 'Retry workspace' }).click()
    await page.getByText('Recovery failed: Native restart unavailable', { exact: true }).waitFor()
    assert.equal(await page.evaluate(() => window.restartCalls), 1)
    assert.equal(
      await page.evaluate(() => window.workspaceRenders),
      rendersBeforeNativeRetry,
      'Desktop retry delegates ownership to the native host instead of remounting App around active agents',
    )
    assert.equal(
      await page.evaluate(() => window.recoveryCalls),
      0,
      'Retry never disables unrelated extensions',
    )
    await page.evaluate(() => {
      window.restartMode = 'pending'
      const button = Array.from(document.querySelectorAll('button')).find(
        (element) => element.textContent === 'Retry workspace',
      )
      button.click()
      button.click()
    })
    await page.getByRole('button', { name: 'Restarting workspace…' }).waitFor()
    assert.equal(
      await page.evaluate(() => window.restartCalls),
      2,
      'Duplicate pending native restarts are ignored',
    )
    assert.equal(await page.getByRole('button', { name: 'Restore built-in UI' }).isDisabled(), true)
    assert.equal(await page.evaluate(() => window.workspaceRenders), rendersBeforeNativeRetry)
    const replacementDocument = page.waitForEvent('domcontentloaded')
    await page.evaluate(() => window.completeRestart())
    await replacementDocument
    await page.getByRole('heading', { name: 'Healthy workspace' }).waitFor()
    assert.notEqual(await page.evaluate(() => window.documentInstance), crashedDocument)
    assert.equal(
      await page.getByText('Saved research', { exact: true }).textContent(),
      'Saved research',
    )
    assert.equal(
      await page.evaluate(() => localStorage.getItem('life.saved-test-thread')),
      savedThread,
    )
    await page.goto(`${url}?browser=1`)
    await page.getByRole('button', { name: 'Add another project' }).click()
    await panel.waitFor()
    await page.getByRole('button', { name: 'Retry workspace' }).click()
    await page.getByRole('heading', { name: 'Healthy workspace' }).waitFor()
    assert.equal(
      await page.evaluate(() => window.restartCalls),
      0,
      'Browser-only previews can retry locally without a native API',
    )
    await page.evaluate(() => {
      window.forcePersistentFailure = true
    })
    await page.getByRole('button', { name: 'Add another project' }).click()
    await panel.waitFor()
    await page.getByRole('button', { name: 'Retry workspace' }).click()
    await panel.waitFor()
    const rendersAfterRetry = await page.evaluate(() => window.workspaceRenders)
    await page.waitForTimeout(150)
    assert.equal(
      await page.evaluate(() => window.workspaceRenders),
      rendersAfterRetry,
      'Persistent errors do not create an automatic render/reload loop',
    )
    await page.goto(url)
    await page.getByRole('button', { name: 'Add another project' }).click()
    await panel.waitFor()
    await page.getByRole('button', { name: 'Minimize window' }).click()
    assert.deepEqual(await page.evaluate(() => window.windowCalls), ['minimize'])
    await page.getByRole('button', { name: 'Restore built-in UI' }).click()
    await page.getByText('Recovery failed: Native recovery unavailable', { exact: true }).waitFor()
    assert.equal(await page.getByRole('button', { name: 'Restore built-in UI' }).isEnabled(), true)
    await page.evaluate(() => {
      window.recoveryMode = 'pending'
      const button = Array.from(document.querySelectorAll('button')).find(
        (element) => element.textContent === 'Restore built-in UI',
      )
      button.click()
      button.click()
    })
    await page.getByRole('button', { name: 'Restoring built-in UI…' }).waitFor()
    assert.equal(
      await page.evaluate(() => window.recoveryCalls),
      2,
      'One failed request and one pending request, with duplicate clicks ignored',
    )
    assert.equal(await page.getByRole('button', { name: 'Retry workspace' }).isDisabled(), true)
    assert.equal(
      await page.evaluate(() => localStorage.getItem('life.saved-test-thread')),
      savedThread,
    )
    await page.goto(`${url}?platform=darwin`)
    await page.getByRole('button', { name: 'Add another project' }).click()
    await panel.waitFor()
    await page
      .getByText('Native recovery is also available with ⌘+Shift+L.', { exact: true })
      .waitFor()
    assert.equal(
      await page.getByRole('group', { name: 'Window controls' }).count(),
      0,
      'macOS keeps its native controls',
    )
    await page.goto(`${url}?initialFailure=1`)
    await panel.waitFor()
    assert.equal(await page.getByRole('heading', { name: 'Healthy workspace' }).count(), 0)
    assert.match(
      await page.locator('[data-life-renderer-error]').getAttribute('data-life-renderer-error'),
      /late render failure/,
    )
    await page.goto(`${url}/bootstrap?initialFailure=1`)
    await panel.waitFor()
    await page.waitForFunction(() => window.sourceErrors.length === 1)
    assert.deepEqual(
      await page.evaluate(() => window.sourceReady),
      [],
      'Initial custom failure is never marked ready',
    )
    assert.equal(await page.evaluate(() => window.sourceErrors[0].revision), 7)
    await page.goto(`${url}/bootstrap?markerOnly=1`)
    await page.waitForFunction(() => window.sourceErrors.length === 1)
    assert.deepEqual(
      await page.evaluate(() => window.sourceReady),
      [],
      'A failure marker without an event still prevents readiness',
    )
    assert.match(await page.evaluate(() => window.sourceErrors[0].message), /Marker-only/)
    await page.goto(`${url}/bootstrap`)
    await page.getByRole('heading', { name: 'Healthy workspace' }).waitFor()
    await page.waitForFunction(() => window.sourceReady.length === 1)
    await page.evaluate(() => {
      void Promise.reject(new Error('Ordinary post-start network failure'))
    })
    await page.waitForTimeout(50)
    assert.deepEqual(
      await page.evaluate(() => window.sourceErrors),
      [],
      'An ordinary late promise rejection does not disable customization',
    )
    await page.getByRole('button', { name: 'Add another project' }).click()
    await page.waitForFunction(() => window.sourceErrors.length === 1)
    assert.deepEqual(await page.evaluate(() => window.sourceReady), [7])
    assert.match(await page.evaluate(() => window.sourceErrors[0].message), /late render failure/)
    await page.goto(`${url}/bootstrap`)
    await page.waitForFunction(() => window.sourceReady.length === 1)
    await page.evaluate(() => {
      window.sourceSnapshot.active.revision = 8
    })
    await page.getByRole('button', { name: 'Add another project' }).click()
    await panel.waitFor()
    await page.waitForTimeout(100)
    assert.deepEqual(
      await page.evaluate(() => window.sourceErrors),
      [],
      'An old window cannot roll back a newer source revision',
    )
    console.log(
      JSON.stringify({
        lateRenderCrashRecovered: true,
        savedThreadsPreserved: true,
        explicitRetry: true,
        nativeRecovery: true,
        noReloadLoop: true,
        platformControls: true,
        customStartupRepair: true,
        lateCustomRepair: true,
        currentRevisionGuard: true,
        desktopNativeRestart: true,
        browserOnlyLocalRetry: true,
      }),
    )
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
