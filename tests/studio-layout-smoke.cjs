#!/usr/bin/env node
// Saved Studio conversations must remain usable at supported desktop window sizes.
const assert = require('node:assert/strict')
const { createServer } = require('node:http')
const { mkdir, mkdtemp, readFile, rm, writeFile } = require('node:fs/promises')
const { join, resolve } = require('node:path')
const { tmpdir } = require('node:os')
const { build } = require('./helpers/browser-build.cjs')
const { chromium } = require('playwright')
const { appMockSource } = require('./helpers/app-workflow-fixture.cjs')

async function run() {
  const repository = resolve(__dirname, '..')
  const directory = await mkdtemp(join(tmpdir(), 'life-studio-layout-'))
  const output = resolve(repository, 'output/playwright/studio-layout')
  const proof = { ok: false, viewports: [], browserErrors: [] }
  let browser
  let server
  try {
    await mkdir(output, { recursive: true })
    await build({
      stdin: {
        resolveDir: repository,
        sourcefile: 'studio-layout-fixture.tsx',
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
      loader: { '.woff2': 'dataurl', '.woff': 'dataurl', '.ttf': 'dataurl' },
      logLevel: 'silent',
    })
    server = createServer(async (request, response) => {
      const file = ['fixture.js', 'fixture.css'].find((name) => request.url === '/' + name)
      response.setHeader(
        'Content-Type',
        file?.endsWith('.js') ? 'text/javascript' : file ? 'text/css' : 'text/html',
      )
      response.end(
        file
          ? await readFile(join(directory, file))
          : '<!doctype html><html lang="en"><meta charset="utf-8"><link rel="stylesheet" href="/fixture.css"><div id="root"></div><script src="/fixture.js"></script></html>',
      )
    })
    await new Promise((resolveListening) => server.listen(0, '127.0.0.1', resolveListening))
    browser = await chromium.launch({ headless: true })
    const mock = await appMockSource()
    for (const viewport of [
      { width: 760, height: 580 },
      { width: 1024, height: 700 },
      { width: 1440, height: 960 },
    ]) {
      const context = await browser.newContext({ viewport })
      const page = await context.newPage()
      page.on('pageerror', (error) => proof.browserErrors.push(error.message))
      page.setDefaultTimeout(10000)
      await page.addInitScript({
        content: `(${mock})({historyHydration:false,providerUtilities:false,fluidity:false})`,
      })
      await page.goto(`http://127.0.0.1:${server.address().port}`)
      await page.getByRole('button', { name: 'Customize', exact: true }).click()
      const studio = page.getByRole('dialog', { name: 'Customize Life', exact: true })
      const composer = studio.getByRole('textbox', { name: 'Describe a Life customization' })
      const title = studio.getByRole('textbox', { name: 'Customization title', exact: true })
      await composer.waitFor()
      const regions = await studio
        .locator('.studio-session-list, .studio-conversation-scroll')
        .evaluateAll((elements) =>
          Object.fromEntries(elements.map((element) => [element.className, element.clientHeight])),
        )
      assert.ok(regions['studio-session-list'] >= 50, 'A saved conversation has visible list space')
      assert.ok(
        regions['studio-conversation-scroll'] >= 140,
        'The conversation retains enough visible space to read responses',
      )
      await title.fill('Saved customization to reopen')
      const firstDraft = 'Keep this saved customization draft.'
      await composer.fill(firstDraft)
      await studio.getByRole('button', { name: 'New customization', exact: true }).click()
      await page.waitForFunction(
        () => document.querySelectorAll('[role="dialog"] .studio-session').length === 2,
      )
      await title.fill('Second customization')
      await composer.fill('A separate customization draft.')
      await studio.getByRole('button', { name: /Saved customization to reopen/ }).click()
      assert.equal(await title.inputValue(), 'Saved customization to reopen')
      assert.equal(await composer.inputValue(), firstDraft)
      await studio.getByRole('button', { name: 'Send customization request', exact: true }).click({
        trial: true,
      })
      for (const name of ['Changes', 'Build', 'Recovery', 'Details'])
        await studio.getByRole('button', { name, exact: true }).click()
      assert.equal(await title.inputValue(), 'Saved customization to reopen')
      await studio.locator('.studio-session-list').scrollIntoViewIfNeeded()
      await page.screenshot({ path: join(output, `${viewport.width}x${viewport.height}.png`) })
      await studio.getByRole('button', { name: 'Close dialog', exact: true }).click()
      assert.equal(
        await page
          .getByRole('button', { name: 'Customize', exact: true })
          .evaluate((button) => button === document.activeElement),
        true,
        'Closing Studio restores keyboard focus to its opener',
      )
      proof.viewports.push({
        viewport,
        regions,
        checks: [
          'Saved conversations can be reopened through pointer interaction',
          'Conversation switching restores its independent draft',
          'Composer send and every inspector view remain reachable',
          'Closing the dialog restores keyboard focus',
        ],
      })
      await context.close()
    }
    assert.deepEqual(proof.browserErrors, [])
    proof.ok = true
    console.log(JSON.stringify(proof, null, 2))
  } finally {
    await writeFile(join(output, 'proof.json'), JSON.stringify(proof, null, 2) + '\n')
    await browser?.close()
    if (server) await new Promise((resolveClose) => server.close(resolveClose))
    await rm(directory, { recursive: true, force: true })
  }
}

run().catch((error) => {
  console.error(error)
  process.exitCode = 1
})
