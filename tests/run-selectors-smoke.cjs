#!/usr/bin/env node
// Real Radix hidden native selects must tolerate form reset and transient remount values.
const assert = require('node:assert/strict')
const { createServer } = require('node:http')
const { mkdtemp, readFile, rm, writeFile } = require('node:fs/promises')
const { join, resolve } = require('node:path')
const { tmpdir } = require('node:os')
const { build } = require('esbuild')
const { chromium } = require('playwright')

async function run() {
  const directory = await mkdtemp(join(tmpdir(), 'life-run-selectors-'))
  const checks = []
  const errors = []
  let browser
  let server
  let page
  try {
    await build({
      stdin: {
        resolveDir: resolve(__dirname, '..'),
        sourcefile: 'run-selectors-fixture.tsx',
        loader: 'tsx',
        contents: `
          import React,{useRef,useState} from 'react'
          import {createRoot} from 'react-dom/client'
          import {ReferenceComposerControls} from './src/renderer/components/ReferenceComposer'
          import {RunSelectors} from './src/renderer/components/RunSelectors'
          const models=[{id:'',name:'Agent default'},{id:'model-a',name:'Model A',defaultReasoningEffort:'medium',supportedReasoningEfforts:[{reasoningEffort:'medium',description:'Medium effort'},{reasoningEffort:'high',description:'High effort'}],serviceTiers:[{id:'default',name:'Standard'},{id:'fast',name:'Fast'}]},{id:'model-b',name:'Model B',supportedReasoningEfforts:[{reasoningEffort:'medium',description:'Medium effort'},{reasoningEffort:'high',description:'High effort'}],serviceTiers:[{id:'default',name:'Standard'},{id:'fast',name:'Fast'}]}]
          const initial={provider:'codex',model:'model-a',reasoningEffort:'high',serviceTier:'fast',mode:'edit'}
          const records={reference:[],run:[]}
          function Fixture(){
            const [reference,setReference]=useState(initial)
            const [run,setRun]=useState(initial)
            const [epoch,setEpoch]=useState(0)
            const current=useRef({reference,run,epoch});current.current={reference,run,epoch}
            window.selectorTest={state:()=>structuredClone({...current.current,records}),remount:()=>setEpoch(value=>value+1),resetState:()=>{setReference(initial);setRun(initial);records.reference.length=records.run.length=0},clearRecords:()=>{records.reference.length=records.run.length=0}}
            return <main><h1>Real Life run selectors</h1>
              <form id="reference-form" aria-label="Reference controls form" key={'reference:'+epoch}>
                <ReferenceComposerControls models={models} {...reference} modeDisabled={false} providerDisabled={false} onChange={patch=>{records.reference.push(patch);setReference(value=>({...value,...patch}))}} onProviderChange={(provider,model)=>{records.reference.push({provider,model});setReference(value=>({...value,provider,model}))}}/>
                <button type="reset">Reset reference form</button>
              </form>
              <form id="run-form" aria-label="Run selectors form" key={'run:'+epoch}>
                <RunSelectors models={models} {...run} onChange={patch=>{records.run.push(patch);setRun(value=>({...value,...patch}))}}/>
                <button type="reset">Reset run form</button>
              </form>
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
          : '<!doctype html><link rel="stylesheet" href="/fixture.css"><div id="root"></div><script src="/fixture.js"></script>',
      )
    })
    await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
    browser = await chromium.launch({ headless: true })
    page = await browser.newPage({ viewport: { width: 1280, height: 900 } })
    page.on('pageerror', (error) => errors.push(error.message))
    await page.goto(`http://127.0.0.1:${server.address().port}`)
    await page.getByRole('heading', { name: 'Real Life run selectors' }).waitFor()
    const settle = async () =>
      page.evaluate(
        () => new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve))),
      )
    const state = () => page.evaluate(() => window.selectorTest.state())
    const record = (name) => {
      checks.push(name)
      console.log('PASS ' + name)
    }
    const initial = {
      provider: 'codex',
      model: 'model-a',
      reasoningEffort: 'high',
      serviceTier: 'fast',
      mode: 'edit',
    }
    await settle()
    let current = await state()
    assert.deepEqual(current.reference, initial)
    assert.deepEqual(current.run, initial)
    assert.deepEqual(current.records, { reference: [], run: [] })
    record('StrictMode mount keeps both sets of run settings unchanged')

    for (let round = 0; round < 5; round++) {
      await page.evaluate(() => window.selectorTest.remount())
      await settle()
      await page.getByRole('button', { name: 'Reset reference form', exact: true }).click()
      await page.getByRole('button', { name: 'Reset run form', exact: true }).click()
      await settle()
    }
    current = await state()
    assert.deepEqual(current.reference, initial)
    assert.deepEqual(current.run, initial)
    assert.deepEqual(current.records, { reference: [], run: [] })
    record(
      'Repeated native form resets and full Radix remounts never clear a selected model or permission',
    )

    const dispatchNative = async (form, index, value) => {
      await page.evaluate(
        ({ form, index, value }) => {
          const select = document.querySelectorAll('#' + form + ' select')[index]
          if (!select) throw new Error('The real Radix hidden native select is missing')
          // A browser reset uses the native setter rather than React's value tracker.
          if (
            value !== '' &&
            !Array.from(select.options).some((option) => option.value === value)
          ) {
            const option = document.createElement('option')
            option.value = value
            option.textContent = 'Transient test value'
            select.append(option)
          }
          Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, 'value').set.call(
            select,
            value,
          )
          select.dispatchEvent(new Event('change', { bubbles: true }))
        },
        { form, index, value },
      )
      await settle()
    }
    for (const value of [
      '',
      '{broken',
      '[]',
      '["codex"]',
      '["other","model-b"]',
      '["codex",42]',
      '["codex","model-b","extra"]',
    ])
      await dispatchNative('reference-form', 0, value)
    for (const value of ['', 'bogus', 'choice:edit'])
      await dispatchNative('reference-form', 1, value)
    for (let index = 0; index < 3; index++)
      for (const value of ['', 'malformed', 'high', 'choice'])
        await dispatchNative('run-form', index, value)
    current = await state()
    assert.deepEqual(current.reference, initial)
    assert.deepEqual(current.run, initial)
    assert.deepEqual(current.records, { reference: [], run: [] })
    record(
      'Empty and malformed hidden native select changes produce no error and no settings request',
    )

    await dispatchNative('reference-form', 0, JSON.stringify(['codex', 'model-b']))
    current = await state()
    assert.equal(current.reference.model, 'model-b')
    assert.deepEqual(current.records.reference, [{ model: 'model-b' }])
    await dispatchNative('reference-form', 1, 'read-only')
    current = await state()
    assert.equal(current.reference.mode, 'read-only')
    assert.deepEqual(current.records.reference.at(-1), { mode: 'read-only' })
    record('Valid native model and permission changes still reach their controlled settings')

    await dispatchNative('run-form', 0, 'choice:model-b')
    await dispatchNative('run-form', 1, 'choice:medium')
    await dispatchNative('run-form', 2, 'choice:default')
    current = await state()
    assert.deepEqual(current.records.run, [
      { model: 'model-b' },
      { reasoningEffort: 'medium' },
      { serviceTier: 'default' },
    ])
    record('Valid prefixed model, reasoning and speed changes retain their exact values')

    await page.evaluate(() => window.selectorTest.resetState())
    await settle()
    const reference = page.getByRole('form', { name: 'Reference controls form' })
    await reference.getByRole('combobox', { name: 'Model: Model A', exact: true }).click()
    await page.getByRole('option', { name: 'Agent default', exact: true }).first().click()
    await settle()
    current = await state()
    assert.equal(current.reference.model, '')
    assert.equal(current.reference.provider, 'codex')
    assert.ok(current.records.reference.some((patch) => patch.model === ''))
    const runForm = page.getByRole('form', { name: 'Run selectors form' })
    await runForm.getByRole('combobox', { name: 'Model: Model A', exact: true }).click()
    await page.getByRole('option', { name: 'Agent default', exact: true }).click()
    await settle()
    current = await state()
    assert.equal(current.run.model, '')
    assert.ok(current.records.run.some((patch) => patch.model === ''))
    record('Explicit Agent default choices clear models normally through the real Radix menus')

    await page.evaluate(() => window.selectorTest.resetState())
    await settle()
    await runForm.getByRole('combobox', { name: /^Reasoning effort:/ }).click()
    await page.getByRole('option', { name: 'Default (Medium)', exact: true }).click()
    await runForm.getByRole('combobox', { name: /^Response speed:/ }).click()
    await page.getByRole('option', { name: 'Speed: default', exact: true }).click()
    await reference.getByRole('button', { name: /^Reasoning:.*speed:/ }).click()
    await page.getByRole('menuitemradio', { name: 'Default', exact: true }).first().click()
    await reference.getByRole('button', { name: /^Reasoning:.*speed:/ }).click()
    await page.getByRole('menuitemradio', { name: 'Default', exact: true }).last().click()
    await settle()
    current = await state()
    assert.equal(current.run.reasoningEffort, '')
    assert.equal(current.run.serviceTier, '')
    assert.equal(current.reference.reasoningEffort, '')
    assert.equal(current.reference.serviceTier, '')
    record('Explicit reasoning and speed defaults clear values in both menu implementations')
    assert.deepEqual(errors, [])
    const proof = { ok: true, checks, browserErrors: errors, final: current }
    if (process.env.LIFE_RUN_SELECTORS_PROOF)
      await writeFile(process.env.LIFE_RUN_SELECTORS_PROOF, JSON.stringify(proof, null, 2))
    console.log(JSON.stringify(proof, null, 2))
  } catch (error) {
    console.error(
      JSON.stringify(
        {
          checks,
          browserErrors: errors,
          state: page ? await page.evaluate(() => window.selectorTest?.state()) : undefined,
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
