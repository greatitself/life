#!/usr/bin/env node
const assert = require('node:assert/strict')
const { createServer } = require('node:http')
const { mkdtemp, readFile, rm, writeFile } = require('node:fs/promises')
const { join, resolve } = require('node:path')
const { tmpdir } = require('node:os')
const { build } = require('esbuild')
const { chromium } = require('playwright')

async function run() {
  const directory = await mkdtemp(join(tmpdir(), 'life-provider-updates-ui-'))
  const checks = []
  const errors = []
  let browser
  let server
  let page
  const record = (name) => {
    checks.push(name)
    console.log('PASS ' + name)
  }
  try {
    await build({
      stdin: {
        resolveDir: resolve(__dirname, '..'),
        sourcefile: 'provider-updates-fixture.tsx',
        loader: 'tsx',
        contents: `
          import React,{useRef,useState} from 'react'
          import {createRoot} from 'react-dom/client'
          import {ProviderUpdatesButton,ProviderUpdatesDialog} from './src/renderer/components/ProviderUpdatesDialog'
          import './src/renderer/styles.css'
          const initial={machineId:'machine-a',machineLabel:'Research · researcher@machine-a:2222',connected:true,checking:false,providers:[{provider:'codex',status:'update-available',installedVersion:'0.162.0',latestVersion:'0.162.1',checkedAt:'2026-10-10T10:00:00Z',stale:false},{provider:'claude',status:'not-installed',latestVersion:'2.1.296',checkedAt:'2026-10-10T10:00:00Z',stale:false}]}
          let calls=0,pending
          function Fixture(){
            const [state,setState]=useState(initial)
            const [open,setOpen]=useState(false)
            const current=useRef(state);current.current=state
            window.providerUpdatesTest={calls:()=>calls,state:()=>current.current,setState,open:()=>setOpen(true),finish:(next,error)=>{if(next)setState(next);const action=pending;pending=undefined;if(error)action.reject(new Error(error));else action.resolve()}}
            return <main><h1>Provider update fixture</h1>
              <ProviderUpdatesButton state={state} onClick={()=>setOpen(true)}/>
              <ProviderUpdatesDialog open={open} onOpenChange={setOpen} state={state} onCheck={()=>{calls++;setState(value=>({...value,checking:true}));return new Promise((resolve,reject)=>{pending={resolve,reject}}).finally(()=>setState(value=>({...value,checking:false})))}}/>
            </main>
          }
          createRoot(document.getElementById('root')).render(<React.StrictMode><Fixture/></React.StrictMode>)
        `,
      },
      bundle: true,
      jsx: 'automatic',
      outfile: join(directory, 'fixture.js'),
      define: { 'process.env.NODE_ENV': '"development"' },
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
          : '<!doctype html><meta name="viewport" content="width=device-width,initial-scale=1"><link rel="stylesheet" href="/fixture.css"><div id="root"></div><script src="/fixture.js"></script>',
      )
    })
    await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
    browser = await chromium.launch({ headless: true })
    page = await browser.newPage({ viewport: { width: 1280, height: 900 } })
    page.on('pageerror', (error) => errors.push(error.message))
    await page.goto(`http://127.0.0.1:${server.address().port}`)
    await page.waitForLoadState('networkidle')
    const settle = () =>
      page.evaluate(
        () => new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve))),
      )
    const button = page.getByRole('button', {
      name: 'Provider updates: 1 newer releases available',
      exact: true,
    })
    await button.click()
    const dialog = page.getByRole('dialog', { name: 'Provider updates', exact: true })
    await dialog.waitFor()
    assert.match(await dialog.innerText(), /researcher@machine-a:2222/)
    assert.match(
      await dialog.locator('.provider-update-card').nth(0).innerText(),
      /Newer release published/,
    )
    assert.match(
      await dialog.locator('.provider-update-card').nth(1).innerText(),
      /Not installed on this machine/,
    )
    record('Version badge counts installed outdated providers and identifies the connected machine')
    assert.equal(
      await dialog
        .getByRole('link', { name: 'Update instructions', exact: true })
        .getAttribute('href'),
      'https://developers.openai.com/codex/cli/',
    )
    assert.equal(
      await dialog
        .getByRole('link', { name: 'Install instructions', exact: true })
        .getAttribute('href'),
      'https://code.claude.com/docs/en/setup#update-claude-code',
    )
    assert.match(await dialog.innerText(), /stable channel and package managers/)
    record(
      'Official instructions and release channel guidance are visible without installation side effects',
    )

    await dialog.getByRole('button', { name: 'Check for updates', exact: true }).click()
    await settle()
    assert.equal(
      await dialog.getByRole('button', { name: 'Checking…', exact: true }).isDisabled(),
      true,
    )
    await page.evaluate(() => document.querySelector('.modal-actions button').click())
    assert.equal(await page.evaluate(() => window.providerUpdatesTest.calls()), 1)
    await page.evaluate(() => {
      const state = window.providerUpdatesTest.state()
      window.providerUpdatesTest.finish({
        ...state,
        checking: false,
        providers: state.providers.map((provider) =>
          provider.provider === 'codex'
            ? { ...provider, status: 'current', installedVersion: '0.162.1' }
            : provider,
        ),
      })
    })
    await settle()
    assert.match(
      await dialog.locator('.provider-update-card').first().innerText(),
      /Latest release installed/,
    )
    assert.equal(await page.locator('.provider-updates-count').count(), 0)
    record(
      'Manual refresh disables duplicate checks and clears the notification after a verified upgrade',
    )

    await dialog.getByRole('button', { name: 'Check for updates', exact: true }).click()
    await page.evaluate(() =>
      window.providerUpdatesTest.finish(undefined, 'Version command timed out'),
    )
    await settle()
    assert.equal(await dialog.getByRole('alert').innerText(), 'Version command timed out')
    await page.evaluate(() => {
      const state = window.providerUpdatesTest.state()
      window.providerUpdatesTest.setState({
        ...state,
        machineId: 'machine-b',
        machineLabel: 'Research B · researcher@machine-b',
      })
    })
    await settle()
    assert.equal(await dialog.getByRole('alert').count(), 0)
    record('Failed installed-version checks are visible and errors clear when switching machines')

    await dialog.getByRole('button', { name: 'Check for updates', exact: true }).click()
    await page.evaluate(() => {
      const state = window.providerUpdatesTest.state()
      window.providerUpdatesTest.setState({
        ...state,
        machineId: 'machine-c',
        machineLabel: 'Research C · researcher@machine-c',
      })
    })
    await settle()
    await page.evaluate(() =>
      window.providerUpdatesTest.finish(undefined, 'Previous machine disconnected'),
    )
    await settle()
    assert.equal(await dialog.getByRole('alert').count(), 0)
    record('Late failures from a previous machine cannot replace the current machine’s status')

    await page.evaluate(() => {
      const state = window.providerUpdatesTest.state()
      window.providerUpdatesTest.setState({
        ...state,
        providers: state.providers.map((provider) => ({
          ...provider,
          stale: true,
          error: 'Offline',
        })),
      })
    })
    await settle()
    assert.match(await dialog.innerText(), /Showing the last verified release/)
    assert.match(await dialog.innerText(), /0.162.1/)
    record('Offline checks retain and label the last verified release')
    if (process.env.LIFE_PROVIDER_UPDATES_SCREENSHOT)
      await page.screenshot({ path: process.env.LIFE_PROVIDER_UPDATES_SCREENSHOT, fullPage: true })
    await page.setViewportSize({ width: 390, height: 844 })
    await settle()
    assert.equal(
      await page.evaluate(() => document.documentElement.scrollWidth > innerWidth),
      false,
    )
    record('The version panel fits a narrow window without horizontal overflow')

    await page.evaluate(() => {
      const state = window.providerUpdatesTest.state()
      window.providerUpdatesTest.setState({
        ...state,
        connected: false,
        machineId: undefined,
        machineLabel: undefined,
        providers: state.providers.map((provider) => ({
          ...provider,
          status: 'disconnected',
          installedVersion: undefined,
        })),
      })
    })
    await settle()
    assert.match(await dialog.innerText(), /No machine connected/)
    assert.equal(
      await dialog.getByRole('button', { name: 'Check for updates', exact: true }).isDisabled(),
      true,
    )
    assert.equal(await page.locator('.provider-updates-count').count(), 0)
    await page.keyboard.press('Escape')
    await dialog.waitFor({ state: 'hidden' })
    record('Disconnect removes installed identity and keyboard dismissal closes the panel')
    assert.deepEqual(errors, [])
    const proof = { ok: true, checks, browserErrors: errors }
    if (process.env.LIFE_PROVIDER_UPDATES_PROOF)
      await writeFile(process.env.LIFE_PROVIDER_UPDATES_PROOF, JSON.stringify(proof, null, 2))
    console.log(JSON.stringify(proof, null, 2))
  } catch (error) {
    console.error(
      JSON.stringify(
        {
          checks,
          browserErrors: errors,
          text: page ? (await page.locator('body').innerText()).slice(0, 4000) : '',
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
