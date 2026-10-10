#!/usr/bin/env node
const assert = require('node:assert/strict')
const { createServer } = require('node:http')
const { mkdtemp, readFile, rm, writeFile } = require('node:fs/promises')
const { join, resolve } = require('node:path')
const { tmpdir } = require('node:os')
const { build } = require('esbuild')
const { chromium } = require('playwright')

async function run() {
  const directory = await mkdtemp(join(tmpdir(), 'life-updates-ui-'))
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
        sourcefile: 'updates-fixture.tsx',
        loader: 'tsx',
        contents: `
          import React,{useRef,useState} from 'react'
          import {createRoot} from 'react-dom/client'
          import {UpdateDialog} from './src/renderer/components/UpdateDialog'
          import './src/renderer/styles.css'
          const initial={status:'idle',currentVersion:'0.10.0'}
          const calls={check:0,download:0,install:0,autoDownload:[]}
          const pending=new Map()
          function Fixture(){
            const [state,setState]=useState(initial)
            const [open,setOpen]=useState(true)
            const [busy,setBusy]=useState(false)
            const [preferenceSupported,setPreferenceSupported]=useState(true)
            const current=useRef(state);current.current=state
            const action=(name,value)=>{
              if(name==='autoDownload')calls.autoDownload.push(value);else calls[name]++
              if(name==='check')setState(value=>({...value,status:'checking',error:undefined}))
              if(name==='download')setState(value=>({...value,status:'downloading',progress:undefined,error:undefined}))
              return new Promise((resolve,reject)=>pending.set(name,{resolve,reject,value}))
            }
            window.updatesTest={
              calls:()=>({...calls,autoDownload:[...calls.autoDownload]}),
              state:()=>current.current,
              patch:(patch)=>setState(value=>({...value,...patch})),
              setBusy,setPreferenceSupported,open:()=>setOpen(true),
              finish:(name,error,patch)=>{
                const operation=pending.get(name)
                if(!operation)throw new Error('No pending '+name+' operation')
                pending.delete(name)
                if(patch)setState(value=>({...value,...patch}))
                if(error)operation.reject(new Error(error))
                else {
                  if(name==='autoDownload')setState(value=>({...value,autoDownload:operation.value}))
                  operation.resolve()
                }
              }
            }
            return <main><h1>Life update fixture</h1>
              <UpdateDialog open={open} onOpenChange={setOpen} state={state} busy={busy}
                onCheck={()=>action('check')} onDownload={()=>action('download')}
                onInstall={()=>action('install')}
                onAutoDownload={preferenceSupported?enabled=>action('autoDownload',enabled):undefined}/>
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
    const patch = async (value) => {
      await page.evaluate((next) => window.updatesTest.patch(next), value)
      await settle()
    }
    const finish = async (name, error, next) => {
      await page.evaluate(({ name, error, next }) => window.updatesTest.finish(name, error, next), {
        name,
        error,
        next,
      })
      await settle()
    }
    const calls = () => page.evaluate(() => window.updatesTest.calls())
    const dialog = page.getByRole('dialog', { name: 'Life updates', exact: true })
    const preference = dialog.getByRole('checkbox', { name: /Download updates automatically/ })
    const check = () => dialog.getByRole('button', { name: 'Check for updates', exact: true })
    const restart = () => dialog.getByRole('button', { name: 'Restart and install', exact: true })
    await dialog.waitFor()
    assert.equal(await preference.isChecked(), true)
    assert.match(await dialog.innerText(), /Installed version 0\.10\.0/)
    assert.match(await dialog.innerText(), /You choose when to restart/)
    assert.deepEqual(await calls(), { check: 0, download: 0, install: 0, autoDownload: [] })
    assert.equal(
      await dialog.getByRole('link', { name: 'View releases' }).getAttribute('href'),
      'https://github.com/greatitself/life/releases/latest',
    )
    record('Background preparation defaults on without downloading or restarting from dialog mount')

    await preference.click()
    await settle()
    assert.equal(await preference.isDisabled(), true)
    assert.equal(await check().isEnabled(), true)
    assert.deepEqual((await calls()).autoDownload, [false])
    await finish('autoDownload', 'Could not save update preference')
    assert.equal(await preference.isChecked(), true)
    assert.equal(await preference.isEnabled(), true)
    assert.equal(await dialog.getByRole('alert').innerText(), 'Could not save update preference')
    await preference.click()
    await finish('autoDownload')
    assert.equal(await preference.isChecked(), false)
    assert.equal(await dialog.getByRole('alert').count(), 0)
    await page.keyboard.press('Escape')
    await dialog.waitFor({ state: 'hidden' })
    await page.evaluate(() => window.updatesTest.open())
    await dialog.waitFor()
    assert.equal(await preference.isChecked(), false)
    record(
      'Saving disables only the preference; failures are visible and acknowledged changes survive reopen',
    )

    await check().click()
    await settle()
    assert.equal(
      await dialog.getByRole('button', { name: 'Checking…', exact: true }).isDisabled(),
      true,
    )
    assert.equal(await preference.isEnabled(), true)
    await preference.click()
    assert.equal(await preference.isDisabled(), true)
    await finish('autoDownload')
    assert.equal(await preference.isChecked(), true)
    assert.equal(
      await dialog.getByRole('button', { name: 'Checking…', exact: true }).isDisabled(),
      true,
    )
    await finish('check', undefined, {
      status: 'available',
      version: '0.11.0',
      autoDownload: false,
    })
    assert.equal((await calls()).check, 1)
    record('The background preference remains adjustable while the update check is active')

    const download = dialog.getByRole('button', { name: 'Download update', exact: true })
    assert.equal(await download.isEnabled(), true)
    assert.match(await dialog.innerText(), /Download now, then restart Life whenever you’re ready/)
    await download.click()
    await settle()
    assert.match(await dialog.innerText(), /Preparing download…/)
    assert.equal(await preference.isEnabled(), true)
    assert.equal(await check().isDisabled(), true)
    await preference.click()
    await finish('autoDownload')
    assert.equal(await preference.isChecked(), true)
    assert.equal((await calls()).download, 1)
    record(
      'Manual download remains available with automatic preparation off and preferences can change during download',
    )

    await patch({
      progress: {
        percent: 25,
        transferred: 8 * 1024 * 1024,
        total: 32 * 1024 * 1024,
        bytesPerSecond: 2 * 1024 * 1024,
      },
    })
    assert.equal(await dialog.getByRole('progressbar').getAttribute('value'), '25')
    assert.match(await dialog.innerText(), /8\.0 MB \/ 32\.0 MB/)
    assert.match(await dialog.innerText(), /2\.0 MB\/s/)
    assert.match(await dialog.innerText(), /12s remaining/)
    await patch({
      progress: {
        percent: 25,
        transferred: 8 * 1024 * 1024,
        total: 32 * 1024 * 1024,
        bytesPerSecond: 0,
      },
    })
    assert.doesNotMatch(await dialog.innerText(), /remaining|MB\/s/)
    await patch({
      progress: {
        percent: 100,
        transferred: 32 * 1024 * 1024,
        total: 32 * 1024 * 1024,
        bytesPerSecond: 2 * 1024 * 1024,
      },
    })
    assert.match(await dialog.innerText(), /Verifying update…/)
    assert.doesNotMatch(await dialog.innerText(), /remaining|MB\/s/)
    assert.equal(await restart().count(), 0)
    record(
      'Progress uses transferred download bytes for speed and ETA, then waits for verification at 100%',
    )

    await finish('download', undefined, { status: 'downloaded', progress: undefined })
    assert.match(await dialog.innerText(), /The update is verified and ready/)
    assert.equal((await calls()).install, 0)
    assert.equal(await restart().isEnabled(), true)
    await page.evaluate(() => window.updatesTest.setBusy(true))
    await settle()
    assert.equal(await restart().isDisabled(), true)
    assert.match(await dialog.getByRole('status').innerText(), /An agent turn is running/)
    assert.equal(await preference.isEnabled(), true)
    await page.evaluate(() => {
      document.querySelector('.updates-actions button').click()
    })
    assert.equal((await calls()).install, 0)
    record(
      'Verified updates wait for an explicit restart, and an active agent prevents installation',
    )

    await page.evaluate(() => window.updatesTest.setBusy(false))
    await settle()
    await restart().click()
    await settle()
    assert.equal(await restart().isDisabled(), true)
    assert.equal(await preference.isEnabled(), true)
    assert.equal((await calls()).install, 1)
    await page.evaluate(() => document.querySelector('.updates-actions button').click())
    assert.equal((await calls()).install, 1)
    await finish('install', 'Save the active workspace before restarting')
    assert.equal(
      await dialog.getByRole('alert').innerText(),
      'Save the active workspace before restarting',
    )
    assert.equal(await restart().isEnabled(), true)
    await restart().click()
    await finish('install')
    assert.equal((await calls()).install, 2)
    assert.equal(await dialog.getByRole('alert').count(), 0)
    record(
      'Explicit restart suppresses duplicate actions and offers a visible retry after native failure',
    )

    await patch({ status: 'error', error: 'Connection closed during download' })
    const retry = dialog.getByRole('button', { name: 'Retry download', exact: true })
    assert.equal(await retry.isEnabled(), true)
    assert.equal(await dialog.getByRole('alert').innerText(), 'Connection closed during download')
    await retry.click()
    await finish('download', undefined, { status: 'downloaded', error: undefined })
    assert.equal((await calls()).download, 2)
    assert.equal(await dialog.getByRole('alert').count(), 0)
    record(
      'A failed prepared download retains the available version and supports an explicit retry',
    )

    await patch({
      status: 'unsupported',
      message: 'Use the official installer for this development build.',
      version: undefined,
    })
    assert.equal(await preference.count(), 0)
    assert.equal(await dialog.locator('.updates-actions button').count(), 0)
    assert.equal(await dialog.getByRole('link', { name: 'View releases' }).isVisible(), true)
    assert.match(await dialog.innerText(), /Use the official installer/)
    record(
      'Unsupported installations offer the official release link without unusable download controls',
    )

    await page.evaluate(() => {
      window.updatesTest.setPreferenceSupported(false)
      window.updatesTest.patch({ status: 'not-available', message: undefined })
    })
    await settle()
    assert.equal(await preference.count(), 0)
    assert.match(await dialog.innerText(), /You’re up to date/)
    assert.equal(await check().isEnabled(), true)
    record(
      'Older saved renderer customizations without the optional preference callback remain usable',
    )

    await page.evaluate(() => {
      window.updatesTest.setPreferenceSupported(true)
      window.updatesTest.patch({ status: 'downloaded', version: '0.11.0' })
    })
    await page.setViewportSize({ width: 390, height: 844 })
    await settle()
    assert.equal(
      await page.evaluate(() => document.documentElement.scrollWidth > innerWidth),
      false,
    )
    assert.equal(await preference.isVisible(), true)
    assert.equal(await restart().isVisible(), true)
    await page.keyboard.press('Escape')
    await dialog.waitFor({ state: 'hidden' })
    record(
      'Prepared update controls fit a narrow window and the dialog supports keyboard dismissal',
    )

    assert.deepEqual(errors, [])
    const proof = { ok: true, checks, browserErrors: errors }
    if (process.env.LIFE_UPDATES_UI_PROOF)
      await writeFile(process.env.LIFE_UPDATES_UI_PROOF, JSON.stringify(proof, null, 2))
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
