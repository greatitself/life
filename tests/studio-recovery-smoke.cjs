#!/usr/bin/env node
// Exercise the shipped App and real Studio hook, using a deterministic native bridge stand-in.
// This verifies local recovery workflows; it does not authenticate or run upstream providers.
const assert = require('node:assert/strict')
const { createHash } = require('node:crypto')
const { createServer } = require('node:http')
const { mkdir, mkdtemp, readFile, readdir, rm, writeFile } = require('node:fs/promises')
const { join, resolve } = require('node:path')
const { tmpdir } = require('node:os')
const { build } = require('./helpers/browser-build.cjs')
const { chromium } = require('playwright')
const { appMockSource } = require('./helpers/app-workflow-fixture.cjs')
const { studioDraftRecoveryChecks } = require('./helpers/studio-draft-recovery-steps.cjs')

const exact = '  Exact Studio request Ω 😀\r\n\tSecond line \ud800  \n'
const exactInput = 'Exact original input\r\n  retain spaces \udfff  \n'
const clone = (value) => JSON.parse(JSON.stringify(value))

async function sourceManifest(repository) {
  const files = ['package.json', 'package-lock.json']
  const pending = ['src']
  while (pending.length) {
    const directory = pending.pop()
    for (const entry of await readdir(join(repository, directory), { withFileTypes: true })) {
      const path = directory + '/' + entry.name
      if (entry.isDirectory()) pending.push(path)
      else if (entry.isFile()) files.push(path)
    }
  }
  const entries = []
  for (const file of files.sort()) {
    const bytes = await readFile(join(repository, file))
    entries.push({
      path: file,
      bytes: bytes.length,
      sha256: createHash('sha256').update(bytes).digest('hex'),
    })
  }
  return entries
}

function session(id, title, provider = 'codex', updatedAt = 10) {
  return {
    id,
    stage: 'draft',
    request: exact,
    futureSessionField: { exact, version: 7 },
    createdAt: 1,
    updatedAt,
    thread: {
      id,
      purpose: 'customization',
      profileId: '',
      provider,
      title,
      remoteId: 'native-' + id,
      workspace: '/srv/Studio Ω',
      futureThreadField: { exact: exactInput, sessionOwner: id },
      messages: [
        null,
        'Opaque output Ω\r\n',
        { id: 'future-role', role: 'future-provider-role', text: exact, futureMessage: true },
        { id: 'invalid-role', role: { toString: { future: true } }, text: exact },
        {
          id: 'user-' + id,
          role: 'user',
          text: exact,
          input: exactInput,
          turn: 1,
          futureMessageField: { exact: exactInput },
        },
        {
          id: 'answer-' + id,
          role: 'assistant',
          text: 'Saved Studio answer Ω.',
          turn: 1,
          futureMessageField: { exact },
        },
        { role: 'assistant', text: 'Opaque message without an identity\r\n' },
      ],
      busy: false,
      model: '',
      mode: 'plan',
      updatedAt,
      turn: 1,
      pending: [],
    },
  }
}

function initialize({
  raw,
  activeId,
  readFailure = false,
  drafts,
  draftsRaw,
  draftReadFailure = false,
  draftWriteFailure = false,
}) {
  const key = 'life.studio.sessions.v1'
  const draftKey = 'life.studio.drafts.v1'
  const marker = 'life.studio-recovery-fixture.seeded'
  const originalGet = Storage.prototype.getItem
  const originalSet = Storage.prototype.setItem
  if (!originalGet.call(localStorage, marker)) {
    originalSet.call(localStorage, key, raw)
    originalSet.call(localStorage, marker, 'true')
    if (activeId) originalSet.call(localStorage, 'life.studio.active.v1', activeId)
    if (draftsRaw !== undefined) originalSet.call(localStorage, draftKey, draftsRaw)
    else if (drafts) originalSet.call(localStorage, draftKey, JSON.stringify(drafts))
  }
  const records = {
    primaryReads: 0,
    primaryWriteAttempts: [],
    primaryWrites: [],
    starts: [],
    stops: [],
    disposals: [],
    responses: [],
    settings: [],
    extensions: [],
    sources: [],
    reloads: [],
    contextCalls: [],
    draftReads: 0,
    draftWriteAttempts: [],
    draftWrites: [],
    resolvedStarts: 0,
  }
  let failReads = readFailure
  let failWrites = false
  let failDraftReads = draftReadFailure
  let failDraftWrites = draftWriteFailure
  let holdContext = false
  let holdStart = false
  const contexts = []
  const starts = []
  let sourceSuccess = false
  Storage.prototype.getItem = function (name) {
    if (name === key) {
      records.primaryReads++
      if (failReads) throw new Error('Fixture Studio storage read failed')
    }
    if (name === draftKey) {
      records.draftReads++
      if (failDraftReads) throw new Error('Fixture Studio draft read failed')
    }
    return originalGet.call(this, name)
  }
  Storage.prototype.setItem = function (name, value) {
    if (name === key) {
      records.primaryWriteAttempts.push(value)
      if (failWrites) throw new Error('Fixture Studio storage is full')
      records.primaryWrites.push(value)
    }
    if (name === draftKey) {
      records.draftWriteAttempts.push(value)
      if (failDraftWrites) throw new Error('Fixture Studio draft storage is full')
      records.draftWrites.push(value)
    }
    return originalSet.call(this, name, value)
  }
  const listeners = new Set()
  const emptySource = {
    revision: 0,
    extensions: [],
    enabled: false,
    canRollback: false,
    path: '',
    recovered: false,
  }
  window.relay ||= {
    onAgent: (listener) => {
      listeners.add(listener)
      return () => listeners.delete(listener)
    },
    agent: { models: async () => [], configure: async () => ({ applied: 'next-turn' }) },
    extensions: { capabilities: [] },
    sourceCode: { get: async () => emptySource },
  }
  const relay = window.relay
  const onAgent = relay.onAgent
  relay.onAgent = (listener) => {
    listeners.add(listener)
    const off = onAgent.call(relay, listener)
    return () => {
      listeners.delete(listener)
      off?.()
    }
  }
  relay.agent.start = async (input) => {
    records.starts.push(structuredClone(input))
    if (holdStart) await new Promise((resolveStart) => starts.push(resolveStart))
    records.resolvedStarts++
  }
  relay.agent.stop = async (id) => records.stops.push(id)
  relay.agent.dispose = async (id) => records.disposals.push(id)
  relay.agent.respond = async (...arguments_) => records.responses.push(structuredClone(arguments_))
  relay.extensions.apply = async (manifest) => {
    records.extensions.push(structuredClone(manifest))
    return { extensions: [], errors: {}, revision: 0, path: '', canRollback: [], recovered: false }
  }
  relay.sourceCode.apply = async (patch) => {
    records.sources.push(structuredClone(patch))
    return sourceSuccess
      ? {
          ...emptySource,
          enabled: true,
          active: { revision: 1, js: 'life-code://fixture/source.js' },
        }
      : emptySource
  }
  relay.sourceCode.getContext = async (...arguments_) => {
    records.contextCalls.push(structuredClone(arguments_))
    if (holdContext) await new Promise((resolveContext) => contexts.push(resolveContext))
    return {
      revision: 0,
      paths: [],
      files: [],
      dependencies: {},
      extensions: [],
      snapshot: emptySource,
    }
  }
  relay.sourceCode.reload = async () => records.reloads.push(originalGet.call(localStorage, key))
  window.studioRecoveryTest = {
    records,
    bytes: () => originalGet.call(localStorage, key),
    stored: () => JSON.parse(originalGet.call(localStorage, key)),
    draftBytes: () => originalGet.call(localStorage, draftKey),
    draftStored: () => JSON.parse(originalGet.call(localStorage, draftKey) || '{}'),
    failReads: (value) => {
      failReads = value
    },
    failWrites: (value) => {
      failWrites = value
    },
    failDraftReads: (value) => {
      failDraftReads = value
    },
    failDraftWrites: (value) => {
      failDraftWrites = value
    },
    holdContext: (value) => {
      holdContext = value
    },
    holdStart: (value) => {
      holdStart = value
    },
    releaseContext: () => {
      holdContext = false
      for (const resolve of contexts.splice(0)) resolve()
    },
    releaseStart: () => {
      holdStart = false
      for (const resolve of starts.splice(0)) resolve()
    },
    sourceSuccess: (value) => {
      sourceSuccess = value
    },
    emit: (event) => listeners.forEach((listener) => listener(event)),
    applySettings: async (patch) => records.settings.push(structuredClone(patch)),
  }
}

const appEntry = `
  import React from 'react'
  import {createRoot} from 'react-dom/client'
  import {App} from './src/renderer/App'
  import {defaultLifeConfig} from './src/shared/customization'
  import './src/renderer/styles.css'
  window.testConfig = {...defaultLifeConfig,workspacePanel:false}
  createRoot(document.getElementById('root')).render(<React.StrictMode><App/></React.StrictMode>)
`

const hookEntry = `
  import React from 'react'
  import {createRoot} from 'react-dom/client'
  import {useCustomizationStudio} from './src/renderer/useCustomizationStudio'
  import {defaultLifeConfig} from './src/shared/customization'
  const options = {
    connection:{status:'connected',home:'/home/tester',profile:{id:'fixture-machine',
      name:'Studio recovery fixture',host:'test.invalid',port:22,username:'tester',
      auth:'agent',privateKeyPath:'',workspace:''}},
    config:defaultLifeConfig,
    extensions:{extensions:[],errors:{},revision:0,path:'',canRollback:[],recovered:false},
    source:{revision:0,extensions:[],enabled:false,canRollback:false,path:'',recovered:false},
    applySettings:(patch) => window.studioRecoveryTest.applySettings(patch),
  }
  function Fixture() {
    const studio=useCustomizationStudio(options)
    window.studio=studio
    return <main aria-label="Studio recovery hook fixture">
      <h1>{studio.active?.thread.title}</h1><p>{studio.active?.stage}</p>
      <p role="status">{studio.feedback}</p>
      <button onClick={() => studio.newSession()}>New customization</button>
      <button onClick={() => studio.remove(studio.active.id)}>Remove conversation</button>
    </main>
  }
  const root=createRoot(document.getElementById('root'))
  window.studioRecoveryUnmount=() => root.unmount()
  root.render(<React.StrictMode><Fixture/></React.StrictMode>)
`

async function main() {
  const repository = resolve(__dirname, '..')
  const directory = await mkdtemp(join(tmpdir(), 'life-studio-recovery-'))
  const output = resolve(
    repository,
    'output/playwright',
    process.env.LIFE_STUDIO_RECOVERY_LABEL || 'studio-recovery',
  )
  const proof = {
    ok: false,
    providerUse: 'Deterministic bridge stand-in; no authenticated upstream runs',
    checks: [],
    browserErrors: [],
    sourceHashes: {},
  }
  let server
  let browser
  let currentPage
  const pass = (name) => {
    proof.checks.push(name)
    console.log('PASS: ' + name)
  }
  try {
    await mkdir(output, { recursive: true })
    await rm(join(output, 'failure.png'), { force: true })
    const inputs = await sourceManifest(repository)
    const inputBytes = JSON.stringify(inputs, null, 2) + '\n'
    await writeFile(join(output, 'source-inputs.json'), inputBytes)
    proof.productionInputs = {
      manifest: 'source-inputs.json',
      files: inputs.length,
      sha256: createHash('sha256').update(inputBytes).digest('hex'),
    }
    for (const file of [
      'src/renderer/studio-history.ts',
      'src/renderer/studio-source.ts',
      'src/renderer/useCustomizationStudio.ts',
      'src/renderer/components/CustomizationStudio.tsx',
    ])
      proof.sourceHashes[file] = createHash('sha256')
        .update(await readFile(join(repository, file)))
        .digest('hex')
    for (const [entry, contents] of [
      ['app', appEntry],
      ['hook', hookEntry],
    ])
      await build({
        stdin: {
          resolveDir: repository,
          sourcefile: 'studio-recovery-' + entry + '.tsx',
          loader: 'tsx',
          contents,
        },
        bundle: true,
        jsx: 'automatic',
        outfile: join(directory, entry + '.js'),
        define: { 'process.env.NODE_ENV': '"development"' },
        loader: { '.woff2': 'dataurl', '.woff': 'dataurl', '.ttf': 'dataurl' },
        logLevel: 'silent',
      })
    assert.deepEqual(
      await sourceManifest(repository),
      inputs,
      'Production source must remain unchanged while fixture bundles are built',
    )
    proof.bundleHashes = {}
    for (const entry of ['app', 'hook'])
      proof.bundleHashes[entry] = createHash('sha256')
        .update(await readFile(join(directory, entry + '.js')))
        .digest('hex')
    server = createServer(async (request, response) => {
      const name = ['app.js', 'app.css', 'hook.js'].find((name) => request.url === '/' + name)
      response.setHeader(
        'Content-Type',
        name?.endsWith('.js') ? 'text/javascript' : name ? 'text/css' : 'text/html',
      )
      response.end(
        name
          ? await readFile(join(directory, name))
          : '<!doctype html><html lang="en"><meta charset="utf-8"><link rel="stylesheet" href="/app.css"><div id="root"></div><script src="/' +
              (request.url?.startsWith('/hook') ? 'hook' : 'app') +
              '.js"></script></html>',
      )
    })
    await new Promise((resolveListening) => server.listen(0, '127.0.0.1', resolveListening))
    browser = await chromium.launch({ headless: true })
    const mock = await appMockSource()
    const open = async (name, mode, seed, activeId, readFailure = false, drafts, controls = {}) => {
      const context = await browser.newContext({
        viewport: { width: 1440, height: 1000 },
        acceptDownloads: true,
      })
      const page = await context.newPage()
      currentPage = page
      page.setDefaultTimeout(10000)
      page.on('pageerror', (error) =>
        proof.browserErrors.push({ scenario: name, message: error.message }),
      )
      const config = {
        raw: typeof seed === 'string' ? seed : JSON.stringify(seed),
        activeId,
        readFailure,
        // Seed through JSON bytes, because a __proto__ object-literal key is special.
        draftsRaw: drafts === undefined ? undefined : JSON.stringify(drafts),
        ...controls,
      }
      await page.addInitScript({
        content:
          (mode === 'app'
            ? '(' + mock + ')({historyHydration:false,providerUtilities:false,fluidity:false});\n'
            : '') +
          '(' +
          initialize.toString() +
          ')(' +
          JSON.stringify(config) +
          ');',
      })
      await page.goto('http://127.0.0.1:' + server.address().port + '/' + mode)
      if (mode === 'hook') await page.waitForFunction(() => Boolean(window.studio?.active))
      else await page.getByRole('button', { name: 'Customize', exact: true }).waitFor()
      return { context, page }
    }
    const stored = (page) => page.evaluate(() => window.studioRecoveryTest.stored())
    const bytes = (page) => page.evaluate(() => window.studioRecoveryTest.bytes())
    const records = (page) => page.evaluate(() => window.studioRecoveryTest.records)
    const draftBytes = (page) => page.evaluate(() => window.studioRecoveryTest.draftBytes())
    // Returning objects through the browser protocol can treat __proto__ as a setter.
    // The JSON bytes are the authoritative store and preserve every own data key.
    const draftStored = async (page) => JSON.parse((await draftBytes(page)) || '{}')
    const flush = (page) => page.evaluate(() => window.dispatchEvent(new Event('pagehide')))
    const settle = (page) =>
      page.evaluate(
        () =>
          new Promise((resolveSettled) =>
            requestAnimationFrame(() => requestAnimationFrame(resolveSettled)),
          ),
      )
    const assertNoExecution = async (page) => {
      const activity = await records(page)
      for (const key of ['starts', 'responses', 'settings', 'extensions', 'sources', 'reloads'])
        assert.deepEqual(activity[key], [], 'Recovery must not replay ' + key)
    }
    const openStudio = async (page) => {
      await page.getByRole('button', { name: 'Customize', exact: true }).click()
      const dialog = page.getByRole('dialog', { name: 'Customize Life', exact: true })
      await dialog.getByRole('textbox', { name: 'Customization title', exact: true }).waitFor()
      return dialog
    }
    const exportSession = async (page, dialog, id) => {
      const downloadPromise = page.waitForEvent('download')
      await dialog.getByRole('button', { name: 'Export conversation', exact: true }).click()
      const download = await downloadPromise
      assert.equal(download.suggestedFilename(), 'life-studio-' + id + '.json')
      return JSON.parse(await readFile(await download.path(), 'utf8'))
    }
    const exportRecovery = async (page, dialog, id) => {
      const downloadPromise = page.waitForEvent('download')
      await dialog.getByRole('button', { name: 'Export recovery', exact: true }).click()
      const download = await downloadPromise
      assert.equal(download.suggestedFilename(), 'life-studio-recovery-' + id + '.json')
      return JSON.parse(await readFile(await download.path(), 'utf8'))
    }

    const older = session('older', 'Older recovery survivor', 'codex', 10)
    const newer = session('newer', 'Newer Claude neighbor', 'claude', 30)
    const duplicate = session('older', 'Rejected duplicate occurrence', 'claude', 40)
    duplicate.futureSessionField = { occurrence: 'second', exact }
    const rejected = { id: 'future-session', futureShape: { exact } }
    const invalidProvider = session('invalid-provider', 'Invalid provider row')
    invalidProvider.thread.provider = { toString: 'codex' }
    const mixed = [
      'opaque head',
      older,
      null,
      rejected,
      duplicate,
      newer,
      invalidProvider,
      17,
      'opaque tail',
    ]
    {
      const { context, page } = await open('mixed-app', 'app', mixed, older.id)
      let dialog = await openStudio(page)
      assert.equal(await dialog.locator('.studio-session').count(), 2)
      assert.equal(
        await dialog.getByRole('textbox', { name: 'Customization title' }).inputValue(),
        older.thread.title,
      )
      assert.equal(await bytes(page), JSON.stringify(mixed))
      await assertNoExecution(page)
      pass(
        'Actual App isolates rejected metadata and duplicate sessions while showing both valid providers',
      )

      await dialog
        .getByRole('textbox', { name: 'Customization title' })
        .fill('Renamed exact recovery survivor')
      await flush(page)
      const renamed = clone(older)
      renamed.thread.title = 'Renamed exact recovery survivor'
      const renamedRows = clone(mixed)
      renamedRows[1] = renamed
      assert.deepEqual(await stored(page), renamedRows)
      assert.deepEqual(await exportSession(page, dialog, older.id), renamed)
      pass(
        'Actual title edit and downloaded JSON retain exact prompts, raw messages, provider identity and original store slots',
      )

      await dialog.getByRole('button', { name: 'New customization', exact: true }).click()
      await dialog
        .getByRole('textbox', { name: 'Customization title' })
        .fill('New independent customization')
      await flush(page)
      const afterNew = await stored(page)
      assert.deepEqual(afterNew.slice(0, mixed.length), renamedRows)
      assert.equal(afterNew.length, mixed.length + 1)
      assert.equal(afterNew.at(-1).thread.title, 'New independent customization')
      await dialog.getByRole('button', { name: /Renamed exact recovery survivor/ }).click()
      await dialog.getByRole('button', { name: 'Remove conversation', exact: true }).click()
      const afterDelete = await stored(page)
      assert.deepEqual(afterDelete, [
        ...renamedRows.slice(0, 1),
        ...renamedRows.slice(2),
        afterNew.at(-1),
      ])
      assert.deepEqual(
        afterDelete.find((row) => row?.thread?.title === duplicate.thread.title),
        duplicate,
      )
      await assertNoExecution(page)
      pass(
        'New and remove actions preserve opaque neighbors and delete only the selected duplicate occurrence',
      )
      await page.reload()
      dialog = await openStudio(page)
      await dialog.getByRole('button', { name: /Rejected duplicate occurrence/ }).click()
      assert.deepEqual(await exportSession(page, dialog, duplicate.id), duplicate)
      assert.deepEqual(await stored(page), afterDelete)
      await page.screenshot({ path: join(output, 'mixed-recovered.png') })
      pass('Reload can recover the retained duplicate occurrence without rewriting its archive')
      await context.close()
    }

    const opaque = [null, 17, 'Opaque-only store Ω\r\n', { id: 'future', payload: { exact } }]
    {
      const { context, page } = await open('opaque-app', 'app', opaque)
      const dialog = await openStudio(page)
      assert.equal(await dialog.locator('.studio-session').count(), 1)
      assert.equal(await bytes(page), JSON.stringify(opaque))
      await dialog
        .getByRole('textbox', { name: 'Customization title' })
        .fill('Draft beside opaque archive')
      await flush(page)
      const firstSave = await stored(page)
      assert.deepEqual(firstSave.slice(0, opaque.length), opaque)
      assert.equal(firstSave.length, opaque.length + 1)
      await dialog.getByRole('button', { name: 'New customization', exact: true }).click()
      const secondSave = await stored(page)
      assert.deepEqual(secondSave.slice(0, firstSave.length), firstSave)
      assert.equal(secondSave.length, firstSave.length + 1)
      await dialog.getByRole('button', { name: 'Remove conversation', exact: true }).click()
      await dialog.getByRole('button', { name: 'Remove conversation', exact: true }).click()
      const finalSave = await stored(page)
      assert.deepEqual(finalSave.slice(0, opaque.length), opaque)
      assert.equal(finalSave.length, opaque.length + 1)
      await assertNoExecution(page)
      await page.screenshot({ path: join(output, 'opaque-retained.png') })
      pass(
        'An all-opaque store survives fresh-draft edits, new sessions and removal of the last visible conversation',
      )
      await context.close()
    }

    const unsent = '  Exact unsent Studio draft Ω 😀\n\tKeep these spaces  \n'
    for (const [name, seed] of [
      ['empty', []],
      ['opaque', opaque],
    ]) {
      const { context, page } = await open('draft-only-' + name, 'app', seed)
      let dialog = await openStudio(page)
      const composer = () => dialog.getByRole('textbox', { name: 'Describe a Life customization' })
      assert.equal(await composer().inputValue(), '')
      assert.equal(await bytes(page), JSON.stringify(seed))
      const id = await page.evaluate(() => localStorage.getItem('life.studio.active.v1'))
      await composer().fill(unsent)
      assert.equal(await composer().inputValue(), unsent)
      const saved = await stored(page)
      assert.deepEqual(saved.slice(0, seed.length), seed)
      assert.equal(saved.length, seed.length + 1)
      assert.equal(saved.at(-1).id, id)
      assert.equal((await records(page)).primaryWrites.length, 1)
      const lastDraft = unsent + 'Another exact unsent line.  '
      await composer().fill(lastDraft)
      assert.equal(
        (await records(page)).primaryWrites.length,
        1,
        'Typing more draft text must not rewrite an already registered primary session',
      )
      await page.reload()
      dialog = await openStudio(page)
      assert.equal(await page.evaluate(() => localStorage.getItem('life.studio.active.v1')), id)
      assert.equal(await composer().inputValue(), lastDraft)
      assert.deepEqual(await stored(page), saved)
      await assertNoExecution(page)
      pass(
        name +
          ': an exact unsent draft registers its session once and reloads under the same ID without changing opaque history',
      )
      await context.close()
    }

    for (const id of [
      'Studio Ω 😀',
      'Studio saved spaces',
      's'.repeat(101),
      'constructor',
      '__proto__',
    ]) {
      const initial = session(id, 'Restored identifier fixture')
      const seed = [null, initial, rejected]
      const { context, page } = await open('restored-draft-' + id, 'app', seed, id)
      let dialog = await openStudio(page)
      const composer = () => dialog.getByRole('textbox', { name: 'Describe a Life customization' })
      assert.equal(
        await composer().inputValue(),
        '',
        'Inherited object properties must never appear as a draft',
      )
      const draft = unsent + '\nIdentifier: ' + id + '  '
      await composer().fill(draft)
      assert.equal(await composer().inputValue(), draft)
      assert.deepEqual(
        (await records(page)).primaryWriteAttempts,
        [],
        'Drafts for restored sessions do not need a new history registration',
      )
      assert.equal(await bytes(page), JSON.stringify(seed))
      await page.reload()
      dialog = await openStudio(page)
      assert.equal(await page.evaluate(() => localStorage.getItem('life.studio.active.v1')), id)
      assert.equal(await composer().inputValue(), draft)
      assert.equal(await bytes(page), JSON.stringify(seed))
      await assertNoExecution(page)
      await context.close()
    }
    pass(
      'Restored Unicode, space-containing, 101-character and prototype-like session IDs keep their exact drafts after reload',
    )

    {
      const unreadable = '{Unreadable primary Studio bytes Ω\r\n'
      const { context, page } = await open('unreadable-draft-app', 'app', unreadable)
      let dialog = await openStudio(page)
      const composer = () => dialog.getByRole('textbox', { name: 'Describe a Life customization' })
      await composer().fill(unsent)
      assert.equal(await composer().inputValue(), unsent)
      assert.equal(await bytes(page), unreadable)
      assert.deepEqual((await records(page)).primaryWriteAttempts, [])
      await dialog.getByRole('button', { name: 'Close dialog', exact: true }).click()
      dialog = await openStudio(page)
      assert.equal(
        await composer().inputValue(),
        unsent,
        'The blocked draft remains available in this running interface',
      )
      assert.equal(await bytes(page), unreadable)
      await assertNoExecution(page)
      pass(
        'Typing an unsent draft beside unreadable primary bytes preserves the original archive and keeps the draft in the current interface',
      )
      await context.close()
    }

    await studioDraftRecoveryChecks({
      open,
      openStudio,
      records,
      stored,
      bytes,
      draftBytes,
      draftStored,
      flush,
      settle,
      exportSession,
      exportRecovery,
      assertNoExecution,
      pass,
      proof,
      session,
      rejected,
      exact,
      exactInput,
      unsent,
    })

    for (const unreadable of ['{malformed Studio bytes Ω\r\n', '{"futureRoot":true}', 'null']) {
      const { context, page } = await open(
        'unreadable-' + unreadable.slice(0, 8),
        'hook',
        unreadable,
      )
      await page.evaluate(() => {
        window.studio.rename(window.studio.active.id, 'Attempted rename')
        window.dispatchEvent(new Event('pagehide'))
        window.studio.newSession()
        window.studio.remove(window.studio.active.id)
      })
      assert.equal(await bytes(page), unreadable)
      assert.deepEqual((await records(page)).primaryWriteAttempts, [])
      await assertNoExecution(page)
      await context.close()
    }
    pass(
      'Malformed and non-array primary stores remain byte-for-byte unchanged through rename, new and remove actions',
    )

    {
      const seed = [session('read-failed', 'Recoverable bytes behind failed read')]
      const { context, page } = await open('read-failure', 'hook', seed, undefined, true)
      await page.evaluate(() => {
        window.studio.rename(window.studio.active.id, 'Unsaved edit')
        window.studio.newSession()
        window.dispatchEvent(new Event('pagehide'))
      })
      assert.equal(await bytes(page), JSON.stringify(seed))
      assert.deepEqual((await records(page)).primaryWriteAttempts, [])
      await assertNoExecution(page)
      await context.close()
      pass('A failed primary read never grants permission to overwrite the unavailable archive')
    }

    {
      const initial = session('write-failed', 'Title before quota failure')
      const seed = [null, initial, rejected, 'tail']
      const { context, page } = await open('write-failure', 'hook', seed, initial.id)
      await page.evaluate(() => {
        window.studioRecoveryTest.failWrites(true)
        window.studio.rename(window.studio.active.id, 'Title from failed write')
        window.dispatchEvent(new Event('pagehide'))
      })
      assert.equal(await bytes(page), JSON.stringify(seed))
      assert.ok((await records(page)).primaryWriteAttempts.length >= 1)
      await page.evaluate(() => {
        window.studioRecoveryTest.failWrites(false)
        window.dispatchEvent(new Event('pagehide'))
      })
      const retried = clone(seed)
      retried[1].thread.title = 'Title from failed write'
      assert.deepEqual(
        await stored(page),
        retried,
        'A second lifecycle flush retries the dirty edit without another mutation',
      )
      await page.evaluate(() => {
        window.studio.rename(window.studio.active.id, 'Durable retry title')
        window.dispatchEvent(new Event('pagehide'))
      })
      const expected = clone(seed)
      expected[1].thread.title = 'Durable retry title'
      assert.deepEqual(await stored(page), expected)
      await page.reload()
      await page.waitForFunction(
        () => window.studio?.active?.thread.title === 'Durable retry title',
      )
      assert.deepEqual(await stored(page), expected)
      await assertNoExecution(page)
      await page.evaluate((title) => {
        window.studio.rename(window.studio.active.id, title)
        window.dispatchEvent(new Event('pagehide'))
      }, initial.thread.title)
      assert.deepEqual(
        await stored(page),
        seed,
        'A later title reversion is compared against the successful checkpoint',
      )
      pass(
        'Quota failures stay dirty for retry; successful retries, reload and reversion retain every opaque neighbor',
      )
      await context.close()
    }

    {
      const interrupted = session('interrupted', 'Saved interrupted customization')
      interrupted.stage = 'applying'
      interrupted.thread.busy = true
      interrupted.thread.turnStatus = 'running'
      interrupted.thread.pending = [
        { type: 'approval', sessionId: interrupted.id, requestId: 'old-permission' },
      ]
      interrupted.thread.queue = [
        { id: 'saved-queue', text: exact, createdAt: 3, futureQueueField: { exact } },
      ]
      interrupted.thread.messages.push({
        id: 'running-tool',
        role: 'tool',
        title: 'Saved inspection',
        text: exactInput,
        status: 'running',
        turn: 1,
        futureMessageField: { exact },
      })
      interrupted.proposal = {
        kind: 'source',
        message: 'Rejected executable proposal',
        patch: { files: [] },
        futureProposalField: { exact },
      }
      const invalidReview = session('invalid-review', 'Invalid saved review', 'claude', 20)
      invalidReview.stage = 'review'
      invalidReview.proposal = {
        kind: 'settings',
        message: exact,
        patch: { theme: 'future-theme' },
      }
      const seed = [interrupted, null, invalidReview]
      const { context, page } = await open('inert-recovery', 'hook', seed, interrupted.id)
      const recovered = await page.evaluate(() => window.studio.active)
      assert.equal(recovered.stage, 'interrupted')
      assert.equal(recovered.thread.busy, false)
      assert.deepEqual(recovered.thread.pending, [])
      assert.equal(recovered.thread.turnStatus, 'interrupted')
      assert.equal(recovered.thread.queue[0].paused, true)
      assert.equal(
        recovered.thread.messages.find((row) => row.id === 'running-tool').status,
        'interrupted',
      )
      assert.equal(recovered.proposal, undefined)
      await page.evaluate(() => window.studio.applyProposal())
      await page.evaluate(() => window.studio.setActiveId('invalid-review'))
      await page.waitForFunction(() => window.studio.active.id === 'invalid-review')
      assert.equal(await page.evaluate(() => window.studio.active.stage), 'failed')
      assert.equal(await page.evaluate(() => window.studio.active.proposal), undefined)
      await page.evaluate(() => window.studio.applyProposal())
      await assertNoExecution(page)
      assert.equal(await bytes(page), JSON.stringify(seed))
      await page.evaluate(() => {
        window.studio.rename(window.studio.active.id, 'Reviewed inert archive')
        window.dispatchEvent(new Event('pagehide'))
      })
      const expected = clone(seed)
      expected[2].thread.title = 'Reviewed inert archive'
      assert.deepEqual(await stored(page), expected)
      await page.reload()
      await page.waitForFunction(() => window.studio?.active?.id === 'invalid-review')
      await page.evaluate(() => window.studio.applyProposal())
      await assertNoExecution(page)
      assert.deepEqual(await stored(page), expected)
      pass(
        'Interrupted work is paused with no pending permissions, and invalid proposals remain archival rather than executable',
      )
      await context.close()
    }

    for (const flushKind of ['pagehide', 'unmount']) {
      const initial = session('last-edit', 'Before lifecycle flush')
      const seed = [null, initial, rejected]
      const { context, page } = await open('flush-' + flushKind, 'hook', seed, initial.id)
      const result = await page.evaluate((flushKind) => {
        window.studio.rename(window.studio.active.id, 'Final edit before ' + flushKind)
        const attemptsBefore = window.studioRecoveryTest.records.primaryWriteAttempts.length
        if (flushKind === 'pagehide') window.dispatchEvent(new Event('pagehide'))
        else window.studioRecoveryUnmount()
        return {
          attemptsBefore,
          attemptsAfter: window.studioRecoveryTest.records.primaryWriteAttempts.length,
          rows: window.studioRecoveryTest.stored(),
        }
      }, flushKind)
      assert.equal(result.attemptsBefore, 0, 'The edit has not reached the 300ms debounce')
      assert.equal(
        result.attemptsAfter,
        1,
        'Lifecycle cleanup performs the pending synchronous save',
      )
      const expected = clone(seed)
      expected[1].thread.title = 'Final edit before ' + flushKind
      assert.deepEqual(result.rows, expected)
      await context.close()
      pass(
        'The last debounced edit is saved synchronously on ' +
          flushKind +
          ' with exact archival neighbors',
      )
    }

    for (const provider of ['codex', 'claude']) {
      const initial = session(
        'first-submit-' + provider,
        'Existing unbound Studio archive',
        provider,
      )
      delete initial.thread.remoteId
      const seed = [null, initial, rejected]
      const { context, page } = await open('profile-binding-' + provider, 'hook', seed, initial.id)
      const request = exact + '\r\nExplain the implementation without changing settings.  '
      await page.evaluate((request) => window.studio.submit(request), request)
      await page.waitForFunction(() => window.studioRecoveryTest.records.starts.length === 1)
      const start = (await records(page)).starts[0]
      assert.equal(start.prompt, request)
      assert.equal(start.provider, provider)
      assert.equal(start.remoteId, undefined)
      assert.equal(start.sessionId, initial.id)
      assert.equal(start.mode, 'plan')
      assert.equal(start.scope, 'life-customization')
      const providerSession = 'new-native-session-' + provider + '-Ω'
      await page.evaluate(
        ({ id, remoteId }) =>
          window.studioRecoveryTest.emit({
            sessionId: id,
            type: 'session',
            remoteId,
          }),
        { id: initial.id, remoteId: providerSession },
      )
      await flush(page)
      const current = (await stored(page))[1]
      assert.deepEqual(current.futureSessionField, initial.futureSessionField)
      assert.deepEqual(current.thread.futureThreadField, initial.thread.futureThreadField)
      assert.deepEqual(
        current.thread.messages.slice(0, initial.thread.messages.length),
        initial.thread.messages,
      )
      assert.equal(current.thread.profileId, 'fixture-machine')
      assert.equal(current.thread.remoteId, providerSession)
      assert.equal(current.thread.workspace, initial.thread.workspace)
      assert.equal(current.thread.messages.at(-1).text, request)
      assert.deepEqual((await stored(page))[2], rejected)
      await page.evaluate(() => window.studio.stop())
      await flush(page)
      const stopped = (await stored(page))[1]
      assert.equal(stopped.thread.busy, false)
      assert.deepEqual(stopped.thread.pending, [])
      assert.deepEqual(stopped.futureSessionField, initial.futureSessionField)
      pass(
        provider +
          ': actual first submission binds the profile while preserving the exact prompt, native session and raw prior history',
      )
      await context.close()
    }

    {
      const initial = session('duplicate-submit', 'Same-render submission guard')
      delete initial.thread.remoteId
      const seed = [null, initial, rejected]
      const { context, page } = await open('duplicate-submit', 'hook', seed, initial.id)
      const request = exact + 'One accepted same-render request.'
      await page.evaluate((request) => {
        window.studioRecoveryTest.holdContext(true)
        const first = window.studio.submit(request)
        const second = window.studio.submit(request)
        window.sameRenderSubmissionResults = Promise.all([first, second])
      }, request)
      await page.waitForFunction(() => window.studioRecoveryTest.records.contextCalls.length === 1)
      assert.equal((await records(page)).starts.length, 0)
      await page.evaluate(() => window.studioRecoveryTest.releaseContext())
      assert.deepEqual(await page.evaluate(() => window.sameRenderSubmissionResults), [true, false])
      const activity = await records(page)
      assert.equal(activity.contextCalls.length, 1)
      assert.equal(activity.starts.length, 1)
      assert.equal(activity.starts[0].prompt, request)
      assert.equal(
        await page.evaluate(() => window.studio.active.thread.turn),
        initial.thread.turn + 1,
      )
      assert.equal(
        await page.evaluate(
          (request) =>
            window.studio.active.thread.messages.filter(
              (message) => message.role === 'user' && message.text === request,
            ).length,
          request,
        ),
        1,
      )
      await page.evaluate(() => window.studio.stop())
      await flush(page)
      pass(
        'Two submissions from one render accept one request, create one user turn and start the native provider once',
      )
      await context.close()
    }

    for (const provider of ['codex', 'claude']) {
      const initial = session('owned-resume-' + provider, 'Owned native Studio session', provider)
      initial.thread.profileId = 'fixture-machine'
      const seed = [null, initial, rejected]
      const { context, page } = await open('owned-resume-' + provider, 'hook', seed, initial.id)
      await page.evaluate((request) => window.studio.submit(request), exact)
      const activity = await records(page)
      assert.equal(activity.starts.length, 1)
      assert.equal(activity.starts[0].remoteId, initial.thread.remoteId)
      assert.equal(activity.starts[0].provider, provider)
      assert.equal(activity.starts[0].prompt, exact)
      await flush(page)
      const saved = (await stored(page))[1]
      assert.equal(saved.thread.profileId, initial.thread.profileId)
      assert.equal(saved.thread.remoteId, initial.thread.remoteId)
      assert.deepEqual(saved.futureSessionField, initial.futureSessionField)
      assert.deepEqual(
        saved.thread.messages.slice(0, initial.thread.messages.length),
        initial.thread.messages,
      )
      await page.evaluate(() => window.studio.stop())
      await flush(page)
      pass(
        provider +
          ': an owned native session resumes with its exact provider identity and prior archival history',
      )
      await context.close()
    }

    {
      const initial = session('ownerless-native', 'Native session with unknown machine ownership')
      const seed = [null, initial, rejected]
      const { context, page } = await open('ownerless-native', 'hook', seed, initial.id)
      const result = await page.evaluate((request) => window.studio.submit(request), exact)
      assert.equal(result, false)
      assert.match(await page.evaluate(() => window.studio.feedback), /new customization/i)
      assert.equal(await bytes(page), JSON.stringify(seed))
      const activity = await records(page)
      assert.deepEqual(activity.contextCalls, [])
      assert.deepEqual(activity.primaryWriteAttempts, [])
      await assertNoExecution(page)
      pass(
        'An ownerless native session refuses continuation before source lookup, provider start or history mutation',
      )
      await context.close()
    }

    {
      const initial = session('foreign-machine', 'Foreign-machine customization')
      initial.thread.profileId = 'another-machine'
      const seed = [null, initial, rejected]
      const { context, page } = await open('foreign-machine', 'hook', seed, initial.id)
      const result = await page.evaluate((request) => window.studio.submit(request), exact)
      assert.equal(result, false)
      assert.match(await page.evaluate(() => window.studio.feedback), /different machine/)
      assert.equal(await bytes(page), JSON.stringify(seed))
      assert.deepEqual((await records(page)).contextCalls, [])
      assert.deepEqual((await records(page)).primaryWriteAttempts, [])
      await assertNoExecution(page)
      pass(
        'A native session owned by another machine refuses continuation without changing saved history',
      )
      await context.close()
    }

    for (const completion of ['remote', 'local-before-first-save']) {
      const initial = session('pending-reset-' + completion, 'Archived permission request')
      initial.thread.profileId = 'fixture-machine'
      initial.stage = 'planning'
      initial.thread.busy = true
      initial.thread.turnStatus = 'running'
      initial.thread.pending = [
        {
          type: 'approval',
          sessionId: initial.id,
          requestId: 'old-native-approval',
          futureRequestField: { exact },
        },
      ]
      const seed = [null, initial, rejected]
      const { context, page } = await open('pending-reset-' + completion, 'hook', seed, initial.id)
      assert.deepEqual(await page.evaluate(() => window.studio.active.thread.pending), [])
      await page.evaluate(() => {
        window.studio.rename(
          window.studio.active.id,
          'Passive recovery keeps the archived approval',
        )
        window.dispatchEvent(new Event('pagehide'))
      })
      assert.deepEqual((await stored(page))[1].thread.pending, initial.thread.pending)
      const passiveExport = clone(initial)
      passiveExport.thread.title = 'Passive recovery keeps the archived approval'
      assert.deepEqual(await page.evaluate(() => window.studio.exportSession()), passiveExport)
      const request = completion === 'remote' ? exact : 'use light theme'
      const completedBeforeSave = await page.evaluate(
        async ({ request, completion }) => {
          const writesBefore = window.studioRecoveryTest.records.primaryWrites.length
          const accepted = await window.studio.submit(request)
          if (completion === 'remote') await window.studio.stop()
          return {
            accepted,
            writesBefore,
            writesAfter: window.studioRecoveryTest.records.primaryWrites.length,
          }
        },
        { request, completion },
      )
      assert.equal(completedBeforeSave.accepted, true)
      assert.equal(
        completedBeforeSave.writesAfter,
        completedBeforeSave.writesBefore,
        'The new run completes before any intermediate history ACK',
      )
      if (completion === 'remote') {
        assert.equal((await records(page)).starts.length, 1)
      } else {
        assert.equal((await records(page)).starts.length, 0)
        assert.deepEqual((await records(page)).settings, [{ theme: 'light' }])
        assert.equal(await page.evaluate(() => window.studio.active.stage), 'complete')
      }
      await flush(page)
      const saved = (await stored(page))[1]
      assert.deepEqual(
        saved.thread.pending,
        [],
        'An explicit accepted new turn retires archived permissions',
      )
      assert.equal(saved.stage, completion === 'remote' ? 'interrupted' : 'complete')
      assert.equal(saved.thread.busy, false)
      assert.notEqual(
        saved.thread.turnStatus,
        'running',
        'A finished new turn retires the archived running status',
      )
      assert.deepEqual(saved.futureSessionField, initial.futureSessionField)
      assert.deepEqual(
        saved.thread.messages.slice(0, initial.thread.messages.length),
        initial.thread.messages,
      )
      await page.reload()
      await page.waitForFunction((id) => window.studio?.active?.id === id, initial.id)
      assert.deepEqual(await page.evaluate(() => window.studio.active.thread.pending), [])
      assert.equal(await page.evaluate(() => window.studio.active.stage), saved.stage)
      assert.equal(await page.evaluate(() => window.studio.active.thread.busy), false)
      assert.deepEqual((await stored(page))[1].thread.pending, [])
      await assertNoExecution(page)
      pass(
        completion +
          ': passive recovery retains raw approvals and an explicit new turn clears them durably',
      )
      await context.close()
    }

    {
      const initial = session('bound-provider', 'Native Codex conversation')
      const seed = [null, initial, rejected]
      const { context, page } = await open('bound-provider-switch', 'hook', seed, initial.id)
      await page.evaluate(() => window.studio.updateThread({ provider: 'claude' }))
      assert.equal(await page.evaluate(() => window.studio.active.thread.provider), 'codex')
      assert.equal(
        await page.evaluate(() => window.studio.active.thread.remoteId),
        initial.thread.remoteId,
      )
      assert.match(await page.evaluate(() => window.studio.feedback), /original agent/)
      await flush(page)
      assert.equal(await bytes(page), JSON.stringify(seed))
      await assertNoExecution(page)
      pass(
        'A bound native session refuses switching to another provider without altering its identity or archive',
      )
      await context.close()
    }

    {
      const initial = session('unbound-provider', 'Unbound provider draft')
      delete initial.thread.remoteId
      const seed = [null, initial, rejected]
      const { context, page } = await open('unbound-provider-switch', 'hook', seed, initial.id)
      await page.evaluate(() => window.studio.updateThread({ provider: 'claude' }))
      await flush(page)
      const selected = clone(seed)
      selected[1].thread.provider = 'claude'
      assert.deepEqual(await stored(page), selected)
      await page.evaluate((request) => window.studio.submit(request), exact)
      await page.waitForFunction(() => window.studioRecoveryTest.records.starts.length === 1)
      const start = (await records(page)).starts[0]
      assert.equal(start.provider, 'claude')
      assert.equal(start.prompt, exact)
      assert.equal(start.remoteId, undefined)
      await page.evaluate(() => window.studio.updateThread({ provider: 'codex' }))
      assert.equal(await page.evaluate(() => window.studio.active.thread.provider), 'claude')
      assert.match(await page.evaluate(() => window.studio.feedback), /original agent/)
      assert.equal((await records(page)).starts.length, 1)
      await page.evaluate(() => window.studio.stop())
      await flush(page)
      const saved = (await stored(page))[1]
      assert.equal(saved.thread.provider, 'claude')
      assert.deepEqual(saved.futureSessionField, initial.futureSessionField)
      assert.deepEqual(saved.thread.futureThreadField, initial.thread.futureThreadField)
      assert.deepEqual(
        saved.thread.messages.slice(0, initial.thread.messages.length),
        initial.thread.messages,
      )
      pass(
        'An unbound draft can select another provider; an in-flight run keeps that provider and preserves its archival metadata',
      )
      await context.close()
    }

    for (const writeFailure of [false, true]) {
      const initial = session('source-review', 'Saved source review')
      initial.stage = 'review'
      for (const message of initial.thread.messages)
        if (message?.role === 'user' || message?.role === 'assistant') {
          message.finishStatus = 'completed'
          message.finishedAt = 5
        }
      initial.proposal = {
        kind: 'source',
        message: 'A manually reviewed source change',
        patch: {
          summary: 'Recovery fixture source change',
          baseRevision: 0,
          files: [
            { path: 'src/renderer/fixture-feature.ts', content: 'export const fixture = true\n' },
          ],
        },
      }
      const seed = [null, initial, rejected]
      const { context, page } = await open('source-write-' + writeFailure, 'hook', seed, initial.id)
      assert.equal(await page.evaluate(() => window.studio.active.stage), 'review')
      await assertNoExecution(page)
      await page.evaluate((writeFailure) => {
        window.studioRecoveryTest.sourceSuccess(true)
        window.studioRecoveryTest.failWrites(writeFailure)
        return window.studio.applyProposal()
      }, writeFailure)
      const activity = await records(page)
      assert.equal(activity.sources.length, 1)
      if (writeFailure) {
        assert.deepEqual(activity.reloads, [])
        assert.equal(await bytes(page), JSON.stringify(seed))
        assert.ok(activity.primaryWriteAttempts.length >= 1)
        pass('A source activation never reloads the document when the history commit fails')
      } else {
        assert.equal(activity.reloads.length, 1)
        assert.equal(activity.reloads[0], await bytes(page))
        const saved = JSON.parse(activity.reloads[0])
        assert.equal(saved[1].stage, 'complete')
        assert.deepEqual(saved[1].futureSessionField, initial.futureSessionField)
        assert.deepEqual(saved[1].thread.futureThreadField, initial.thread.futureThreadField)
        assert.deepEqual(
          saved[1].thread.messages.slice(0, initial.thread.messages.length),
          initial.thread.messages,
        )
        assert.deepEqual(saved[2], rejected)
        pass(
          'A manually approved source change commits exact Studio history before requesting the native renderer reload',
        )
      }
      await context.close()
    }

    assert.deepEqual(proof.browserErrors, [])
    assert.deepEqual(
      await sourceManifest(repository),
      inputs,
      'Recovery proof must identify the unchanged production sources throughout execution',
    )
    proof.ok = true
    console.log(JSON.stringify(proof, null, 2))
  } catch (error) {
    proof.failure = error.stack || String(error)
    if (currentPage && !currentPage.isClosed())
      await currentPage.screenshot({ path: join(output, 'failure.png') }).catch(() => {})
    throw error
  } finally {
    await mkdir(output, { recursive: true })
    await writeFile(join(output, 'proof.json'), JSON.stringify(proof, null, 2) + '\n')
    await browser?.close()
    if (server) await new Promise((resolveClose) => server.close(resolveClose))
    await rm(directory, { recursive: true, force: true })
  }
}

main().catch((error) => {
  console.error(error)
  process.exitCode = 1
})
