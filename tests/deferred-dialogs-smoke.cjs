#!/usr/bin/env node
const assert = require('node:assert/strict')
const { createServer } = require('node:http')
const { mkdtemp, readFile, rm } = require('node:fs/promises')
const { tmpdir } = require('node:os')
const { join, resolve } = require('node:path')
const { build } = require('esbuild')
const { chromium } = require('playwright')

async function run() {
  const directory = await mkdtemp(join(tmpdir(), 'life-deferred-dialogs-'))
  let server
  let browser
  try {
    await build({
      stdin: {
        resolveDir: resolve(__dirname, '..'),
        loader: 'tsx',
        contents: `
          import React,{useEffect,useState}from'react'
          import{createRoot}from'react-dom/client'
          import{deferredDialog}from'./src/renderer/components/DeferredDialogs'
          import{Modal}from'./src/renderer/components/Modal'
          import'./src/renderer/styles.css'
          const probe=window.dialogProbe={loads:0,opened:0,subscriptions:0,mounts:0,failLoads:0}
          function Loaded({open,onOpenChange}){
            const[draft,setDraft]=useState('')
            useEffect(()=>{probe.mounts++;probe.subscriptions++;return()=>{probe.subscriptions--}},[])
            useEffect(()=>{if(open)probe.opened++},[open])
            return <Modal open={open} onOpenChange={onOpenChange} title="Deferred fixture" description="Test draft"><textarea aria-label="Retained draft" value={draft} onChange={event=>setDraft(event.target.value)}/></Modal>
          }
          const Deferred=deferredDialog(()=>{
            probe.loads++
            return new Promise(resolve=>{probe.resolve=()=>resolve({default:Loaded})})
          },'Deferred fixture')
          const Failure=deferredDialog(()=>{
            probe.failLoads++
            if(probe.failLoads===1)return Promise.reject(Error('Deliberate chunk failure'))
            return Promise.resolve({default:Loaded})
          },'Failure fixture')
          function Shell(){
            const[open,setOpen]=useState(false),[failOpen,setFailOpen]=useState(false)
            return <><button id="open" onClick={()=>setOpen(true)}>Open deferred</button><button id="fail" onClick={()=>setFailOpen(true)}>Open failure</button><Deferred open={open} onOpenChange={setOpen}/><Failure open={failOpen} onOpenChange={setFailOpen}/></>
          }
          createRoot(document.getElementById('root')).render(<React.StrictMode><Shell/></React.StrictMode>)
        `,
      },
      outfile: join(directory, 'fixture.js'),
      bundle: true,
      jsx: 'automatic',
      define: { 'process.env.NODE_ENV': '"development"' },
      loader: { '.woff2': 'file', '.woff': 'file' },
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
          : '<link rel="stylesheet" href="/fixture.css"><div id="root"></div><script src="/fixture.js"></script>',
      )
    })
    await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
    browser = await chromium.launch({ headless: true })
    const page = await browser.newPage()
    await page.goto(`http://127.0.0.1:${server.address().port}`, { waitUntil: 'networkidle' })
    assert.equal(await page.evaluate(() => window.dialogProbe.loads), 0)
    const opener = page.getByRole('button', { name: 'Open deferred', exact: true })
    await opener.click()
    let dialog = page.getByRole('dialog', { name: 'Deferred fixture', exact: true })
    await dialog.getByRole('status').waitFor()
    await page.keyboard.press('Escape')
    await dialog.waitFor({ state: 'hidden' })
    await page.waitForFunction(() => document.activeElement?.id === 'open')
    await page.evaluate(() => window.dialogProbe.resolve())
    await page.waitForFunction(() => window.dialogProbe.subscriptions === 1)
    assert.equal(await page.getByRole('dialog').count(), 0)
    assert.equal(await page.evaluate(() => window.dialogProbe.opened), 0)
    await opener.click()
    const draft = dialog.getByRole('textbox', { name: 'Retained draft', exact: true })
    await draft.fill('Preserve this draft across closes')
    await dialog.getByRole('button', { name: 'Close dialog', exact: true }).click()
    await page.waitForFunction(() => document.activeElement?.id === 'open')
    const mountCount = await page.evaluate(() => window.dialogProbe.mounts)
    await opener.click()
    assert.equal(await draft.inputValue(), 'Preserve this draft across closes')
    assert.equal(await page.evaluate(() => window.dialogProbe.loads), 1)
    assert.equal(await page.evaluate(() => window.dialogProbe.mounts), mountCount)
    assert.equal(await page.evaluate(() => window.dialogProbe.opened), 2)
    await dialog.getByRole('button', { name: 'Close dialog', exact: true }).click()
    await page.getByRole('button', { name: 'Open failure', exact: true }).click()
    dialog = page.getByRole('dialog', { name: 'Failure fixture', exact: true })
    await dialog.getByRole('alert').waitFor()
    await dialog.getByRole('button', { name: 'Close dialog', exact: true }).click()
    await page.waitForFunction(() => document.activeElement?.id === 'fail')
    await page.getByRole('button', { name: 'Open failure', exact: true }).click()
    await dialog.getByRole('button', { name: 'Try again', exact: true }).click()
    await page
      .getByRole('dialog', { name: 'Deferred fixture', exact: true })
      .getByRole('textbox', { name: 'Retained draft', exact: true })
      .waitFor()
    assert.equal(await page.evaluate(() => window.dialogProbe.failLoads), 2)
    assert.equal(await page.evaluate(() => window.dialogProbe.opened), 3)
    console.log(
      JSON.stringify(
        {
          ok: true,
          checks: [
            'Closed dialogs request no modules',
            'Escape closes a pending load and restores focus; late resolution stays hidden',
            'Drafts and subscriptions survive repeated closes without native read duplication',
            'Chunk failure remains local, closable and retryable',
          ],
        },
        null,
        2,
      ),
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
