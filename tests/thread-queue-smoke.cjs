#!/usr/bin/env node
// Exercise the real React queue hook and provider event reducer in Chromium.
const assert = require('node:assert/strict')
const { createServer } = require('node:http')
const { mkdir, mkdtemp, readFile, rm, writeFile } = require('node:fs/promises')
const { dirname, join, resolve } = require('node:path')
const { tmpdir } = require('node:os')
const { build } = require('esbuild')
const { chromium } = require('playwright')

const fixture = `
import React, { useRef, useState } from 'react'
import { createRoot } from 'react-dom/client'
import { useThreadQueue, normalizeQueuedMessages } from './src/renderer/thread-queue'
import { applyEvent, readThreads } from './src/renderer/state'
import { saveAttachmentFiles } from './src/renderer/attachments'
const profile = { id:'machine', name:'Research server', host:'example', port:22,
  username:'researcher', auth:'agent', privateKeyPath:'', workspace:'/srv/project' }
const connected = { status:'connected', profile, workspace:'/srv/project', home:'/srv/root' }
const exactText = '  Inspect exactly this text.\\n\\nNo additional words.\\n'
const message = (id='first', text=exactText) => ({ id, text, createdAt:10, attachments:[] })
const seedThread = (overrides={}) => ({ id:'thread', profileId:'machine', workspace:'/srv/project',
  provider:'codex', title:'Provider title', remoteId:'provider-conversation',
  messages:[{id:'initial',role:'user',text:'Original request',turn:1}], queue:[message()],
  busy:true, turnStatus:'running', model:'', mode:'review', updatedAt:10, turn:1,
  pending:[], ...overrides })
const records = { sends:[], steering:[], stops:0, errors:[], attachmentReads:0, attachmentWrites:0 }
let modes = { send:'accept', steer:'accept' }
const pending = new Map()
const held = new Map()
let heldSave
const originalTransaction = IDBDatabase.prototype.transaction
IDBDatabase.prototype.transaction = function(...arguments_) {
  const transaction = originalTransaction.apply(this,arguments_)
  if (arguments_[1] !== 'readwrite' || !heldSave || heldSave.claimed) return transaction
  const entry = heldSave
  entry.claimed = true
  records.attachmentWrites++
  let complete
  transaction.addEventListener('complete', event => {
    entry.ready = true
    entry.release = () => complete?.call(transaction,event)
    if (entry.released) entry.release()
  })
  return new Proxy(transaction, {
    set(target,key,value) {
      if (key === 'oncomplete') { complete = value; return true }
      return Reflect.set(target,key,value,target)
    },
    get(target,key) {
      const value = Reflect.get(target,key,target)
      return typeof value === 'function' ? value.bind(target) : value
    }
  })
}
const originalGet = IDBObjectStore.prototype.get
IDBObjectStore.prototype.get = function(key) {
  const request = originalGet.call(this,key)
  const entry = held.get(String(key))
  if (!entry) return request
  records.attachmentReads++
  let success
  request.addEventListener('success', event => {
    entry.ready = true
    entry.release = () => success?.call(request,event)
    if (entry.released) entry.release()
  })
  return new Proxy(request, {
    set(target,key,value) {
      if (key === 'onsuccess') { success = value; return true }
      return Reflect.set(target,key,value,target)
    },
    get(target,key) {
      const value = Reflect.get(target,key,target)
      return typeof value === 'function' ? value.bind(target) : value
    }
  })
}
function Harness() {
  const [threads,setThreads] = useState([seedThread()])
  const [connection,setConnection] = useState(connected)
  const [blocked,setBlocked] = useState(false)
  const [selectedOperation,setSelectedOperation] = useState('ground')
  const current = useRef({threads,connection,blocked})
  current.current = {threads,connection,blocked}
  const dispatch = async (kind, submission) => {
    const target = current.current.threads.find(item => item.id === submission.threadId)
    const selected = target?.queue?.find(item => item.id === submission.messageId)
    if (!selected) throw new Error('The dispatch must retain its exact original queued message')
    records[kind==='send'?'sends':'steering'].push({ ...submission, files:submission.files.map(
      item=>({id:item.id,name:item.name,size:item.file.size})), text:selected.text,
      workspace:target.workspace, turn:target.turn,
      ...(selected.researchOperation===undefined?{}:{researchOperation:selected.researchOperation}) })
    let mode = modes[kind]
    if (mode === 'pending') mode = await new Promise(resolve => pending.set(kind,resolve))
    if (mode === 'throw') throw new Error('Provider rejected this exact message')
    if (mode === 'false') return false
    if (kind === 'send') setThreads(previous => previous.map(item => item.id === target.id ? {
      ...item, busy:true, turnStatus:'running', turn:item.turn+1,
      messages:[...item.messages, {id:'sent:'+selected.id,role:'user',text:selected.text,
        turn:item.turn+1, submission:'message'}],
      queue:(item.queue||[]).filter(entry=>entry.id!==selected.id)
    } : item))
    return true
  }
  const queue = useThreadQueue({ threads, connection, onThreads:setThreads,
    onError:error=>records.errors.push(error), send:input=>dispatch('send',input),
    steer:modes.steer==='missing'?undefined:input=>dispatch('steer',input), stop:async()=>{records.stops++},
    isBlocked:()=>current.current.blocked })
  window.queueTest = {
    exactText,
    state:()=>structuredClone({threads,connection,blocked,records,selectedOperation,
      actionId:queue.actionId,preparing:queue.preparing}),
    reset:(overrides={},config={})=>{
      records.sends.length=records.steering.length=records.errors.length=0
      records.stops=records.attachmentReads=records.attachmentWrites=0
      modes={send:'accept',steer:'accept',...config}
      held.clear(); heldSave=undefined; pending.clear();setBlocked(false);setConnection(connected)
      setSelectedOperation('ground')
      setThreads([seedThread(overrides)])
    },
    event:event=>setThreads(previous=>previous.map(item=>applyEvent(item,{sessionId:item.id,...event}))),
    patch:patch=>setThreads(previous=>previous.map(item=>({...item,...patch}))),
    connection:value=>setConnection({...connected,...value}), blocked:setBlocked,
    enqueue:(text,operation,files=[])=>queue.enqueue(threads[0],text,files,operation),
    enqueueSelected:(text,files=[])=>queue.enqueue(threads[0],text,files,selectedOperation),
    selectOperation:setSelectedOperation,
    sendNow:id=>queue.sendNow('thread',id), remove:id=>queue.remove('thread',id),
    resolve:(kind,result='accept')=>{const finish=pending.get(kind);pending.delete(kind);finish?.(result)},
    holdAttachment:async id=>{
      const file=new File(['real IndexedDB attachment'],'sample.txt',{type:'text/plain'})
      await saveAttachmentFiles([{id,name:file.name,mime:file.type,size:file.size,file}])
      held.set(id,{ready:false,released:false})
      return {id,name:file.name,mime:file.type,size:file.size}
    },
    attachmentReady:id=>held.get(id)?.ready,
    releaseAttachment:id=>{const entry=held.get(id);if(entry){entry.released=true;entry.release?.()}},
    enqueueWithHeldSavingAttachment:(text,id)=>{
      const file=new File(['Actual research enqueue attachment'],'research.txt',{type:'text/plain'})
      heldSave={ready:false,released:false,claimed:false}
      void queue.enqueue(threads[0],text,[{id,name:file.name,mime:file.type,size:file.size,file}],selectedOperation)
    },
    savingReady:()=>heldSave?.ready,
    releaseSaving:()=>{if(heldSave){heldSave.released=true;heldSave.release?.()}},
    restore:()=>{
      localStorage.setItem('relay.threads.v1',JSON.stringify(threads))
      setThreads(readThreads())
    },
    normalize:()=>setThreads(previous=>previous.map(item=>({...item,queue:normalizeQueuedMessages(item.queue)})))
  }
  return <main><h1>Real Life thread queue</h1><p data-testid="status">{threads[0].turnStatus}</p>
    <label>Research operation<select aria-label="Research operation" value={selectedOperation}
      onChange={event=>setSelectedOperation(event.target.value)}><option value="ground">Ground</option>
      <option value="counterfactual">Counterfactual</option></select></label>
    {threads[0].queue?.map(item=><section key={item.id} data-queue-id={item.id}>
      <pre>{item.text}</pre><button onClick={()=>queue.sendNow('thread',item.id)}>Send now {item.id}</button>
      <button onClick={()=>queue.remove('thread',item.id)}>Remove {item.id}</button>
      {item.paused && <span>Paused</span>}{item.error&&<p role="alert">{item.error}</p>}
    </section>)}<ol>{threads[0].messages.map(item=><li key={item.id} data-message-id={item.id}
      data-turn={item.turn} data-submission={item.submission}><pre>{item.text}</pre></li>)}</ol>
  </main>
}
createRoot(document.getElementById('root')).render(<React.StrictMode><Harness/></React.StrictMode>)
`

async function run() {
  const directory = await mkdtemp(join(tmpdir(), 'life-thread-queue-'))
  const checks = []
  const errors = []
  let browser
  let server
  try {
    await build({
      stdin: {
        contents: fixture,
        loader: 'tsx',
        resolveDir: resolve(__dirname, '..'),
        sourcefile: 'thread-queue-fixture.tsx',
      },
      bundle: true,
      jsx: 'automatic',
      outfile: join(directory, 'fixture.js'),
      define: { 'process.env.NODE_ENV': '"development"' },
      logLevel: 'silent',
    })
    server = createServer(async (request, response) => {
      response.setHeader(
        'Content-Type',
        request.url === '/fixture.js' ? 'text/javascript' : 'text/html',
      )
      response.end(
        request.url === '/fixture.js'
          ? await readFile(join(directory, 'fixture.js'))
          : '<!doctype html><div id="root"></div><script src="/fixture.js"></script>',
      )
    })
    await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
    browser = await chromium.launch({ headless: true })
    const page = await browser.newPage()
    page.on('pageerror', (error) => errors.push(error.message))
    await page.goto(`http://127.0.0.1:${server.address().port}`)
    await page.getByRole('heading', { name: 'Real Life thread queue' }).waitFor()
    const settle = async () => {
      await page.evaluate(
        () => new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve))),
      )
    }
    const state = () => page.evaluate(() => window.queueTest.state())
    const reset = async (overrides = {}, config = {}) => {
      await page.evaluate(({ overrides, config }) => window.queueTest.reset(overrides, config), {
        overrides,
        config,
      })
      await settle()
    }
    const event = async (value) => {
      await page.evaluate((value) => window.queueTest.event(value), value)
      await settle()
    }
    const record = (name) => {
      checks.push(name)
      console.log(`PASS ${name}`)
    }
    const exact = await page.evaluate(() => window.queueTest.exactText)
    const queued = (id, text = exact) => ({ id, text, createdAt: 10, attachments: [] })

    await reset({ queue: [queued('first'), queued('second', ' Next after completion.\n ')] })
    await page.getByRole('button', { name: 'Send now first', exact: true }).click()
    await settle()
    let current = await state()
    assert.equal(current.records.steering.length, 1)
    assert.equal(current.records.steering[0].text, exact)
    assert.equal(current.records.sends.length, 0)
    assert.equal(current.records.stops, 0)
    assert.equal(current.threads[0].turn, 1)
    assert.deepEqual(
      current.threads[0].queue.map((item) => item.id),
      ['second'],
    )
    assert.equal(
      current.threads[0].messages.filter((item) => item.submission === 'steering').length,
      1,
    )
    assert.equal(
      current.threads[0].messages.find((item) => item.submission === 'steering').text,
      exact,
    )
    record(
      'Busy Send now steers exact whitespace once in the same turn without stop or synthetic text',
    )

    for (const output of [
      {
        type: 'text',
        itemId: 'final',
        phase: 'final_answer',
        text: 'Final answer before completion',
        status: 'replace',
      },
      { type: 'tool', itemId: 'tool', text: 'Tool has finished', status: 'completed' },
      { type: 'status', status: 'idle' },
      { type: 'status', status: 'resumed' },
    ]) {
      await event(output)
      assert.equal((await state()).records.sends.length, 0)
    }
    await event({ type: 'complete', status: 'completed' })
    current = await state()
    assert.equal(current.records.sends.length, 1)
    assert.equal(current.records.sends[0].text, ' Next after completion.\n ')
    assert.equal(current.records.steering.length, 1)
    assert.equal(current.threads[0].turn, 2)
    assert.equal(current.threads[0].queue.length, 0)
    await settle()
    assert.equal((await state()).records.sends.length, 1)
    record('Follow-up waits for genuine provider completion, then sends exactly once')

    await reset({}, { steer: 'pending' })
    await page.getByRole('button', { name: 'Send now first', exact: true }).click()
    await settle()
    current = await state()
    assert.equal(current.records.steering.length, 1)
    assert.equal(
      current.threads[0].messages.filter((item) => item.submission === 'steering').length,
      0,
    )
    assert.equal(current.threads[0].queue.length, 1)
    await page.evaluate(() => {
      window.queueTest.sendNow('first')
      window.queueTest.sendNow('first')
    })
    await event({
      type: 'text',
      itemId: 'during-ack',
      text: 'Output arrived during steering acknowledgement',
    })
    assert.equal((await state()).records.steering.length, 1)
    await page.evaluate(() => window.queueTest.resolve('steer'))
    await settle()
    current = await state()
    assert.equal(current.threads[0].messages[1].submission, 'steering')
    assert.equal(
      current.threads[0].messages[2].text,
      'Output arrived during steering acknowledgement',
    )
    assert.equal(
      current.threads[0].messages.filter((item) => item.submission === 'steering').length,
      1,
    )
    record(
      'Steering row appears only after acceptance and precedes output received during acknowledgement',
    )

    await reset({}, { steer: 'pending' })
    await page.getByRole('button', { name: 'Send now first', exact: true }).click()
    await settle()
    await event({ type: 'complete', status: 'completed' })
    await page.evaluate(() => window.queueTest.resolve('steer'))
    await settle()
    current = await state()
    const acceptedLate = current.threads[0].messages.find((item) => item.submission === 'steering')
    assert.equal(acceptedLate.turn, 1)
    assert.equal(acceptedLate.finishStatus, 'completed')
    assert.ok(acceptedLate.finishedAt)
    assert.equal(current.records.sends.length, 0)
    record('Late accepted steering remains attached to its original completed turn')

    for (const kind of ['steer', 'send']) {
      for (const mode of ['false', 'throw']) {
        await reset(
          { busy: kind === 'steer', turnStatus: kind === 'steer' ? 'running' : 'unknown' },
          { [kind]: mode },
        )
        await page.getByRole('button', { name: 'Send now first', exact: true }).click()
        await settle()
        current = await state()
        assert.equal(current.records[kind === 'steer' ? 'steering' : 'sends'].length, 1)
        assert.equal(current.threads[0].queue.length, 1)
        assert.equal(current.threads[0].queue[0].paused, true)
        assert.ok(current.threads[0].queue[0].error)
        assert.equal(current.threads[0].queue[0].text, exact)
        assert.equal(current.threads[0].messages.length, 1)
        await settle()
        assert.equal(current.records.stops, 0)
        record(`${kind} ${mode} preserves the exact paused message without automatic replay`)
      }
    }

    await reset({}, { steer: 'missing' })
    await page.getByRole('button', { name: 'Send now first', exact: true }).click()
    await settle()
    current = await state()
    assert.equal(current.records.steering.length + current.records.sends.length, 0)
    assert.equal(current.records.stops, 0)
    assert.equal(current.threads[0].queue[0].paused, true)
    assert.match(current.threads[0].queue[0].error, /cannot accept steering/)
    record(
      'A provider without steering support keeps the message paused without replacing its turn',
    )

    await reset({ queue: [] })
    await page.evaluate(() => {
      window.queueTest.enqueue(window.queueTest.exactText)
      window.queueTest.enqueue('Concurrent duplicate that must not enter the queue')
    })
    await settle()
    current = await state()
    assert.equal(current.threads[0].queue.length, 1)
    assert.equal(current.threads[0].queue[0].text, exact)
    assert.equal(Object.hasOwn(current.threads[0].queue[0], 'researchOperation'), false)
    assert.equal(current.records.sends.length + current.records.steering.length, 0)
    await page
      .getByRole('button', { name: 'Send now ' + current.threads[0].queue[0].id, exact: true })
      .click()
    await settle()
    assert.equal((await state()).records.steering[0].text, exact)
    record(
      'Concurrent enqueue preserves exact input and admits one message while attachment storage settles',
    )

    await reset({ purpose: 'research', workspace: '/srv/root/.life/research', queue: [] })
    await page.evaluate(() =>
      window.queueTest.enqueueWithHeldSavingAttachment(
        window.queueTest.exactText,
        'research-operation-file',
      ),
    )
    await page.waitForFunction(() => window.queueTest.savingReady())
    current = await state()
    assert.equal(current.threads[0].queue.length, 0)
    assert.equal(current.preparing, true)
    assert.equal(current.records.attachmentWrites, 1)
    await page.getByLabel('Research operation', { exact: true }).selectOption('counterfactual')
    await settle()
    assert.equal((await state()).selectedOperation, 'counterfactual')
    await page.evaluate(() => window.queueTest.releaseSaving())
    await page.waitForFunction(() => window.queueTest.state().threads[0].queue.length === 1)
    await settle()
    current = await state()
    const researchSnapshot = current.threads[0].queue[0]
    assert.equal(researchSnapshot.researchOperation, 'ground')
    assert.equal(researchSnapshot.text, exact)
    assert.equal(researchSnapshot.attachments[0].id, 'research-operation-file')
    assert.equal(current.records.sends.length + current.records.steering.length, 0)
    record(
      'Research enqueue snapshots its selected operation before actual IndexedDB saving completes',
    )

    await page.evaluate(() => window.queueTest.restore())
    await settle()
    current = await state()
    assert.equal(current.threads[0].queue[0].researchOperation, 'ground')
    assert.equal(current.threads[0].queue[0].paused, true)
    assert.equal(current.threads[0].queue[0].text, exact)
    assert.equal(current.records.sends.length + current.records.steering.length, 0)
    record(
      'Persisted queued research operations survive actual readThreads restore and remain paused',
    )

    await reset({
      purpose: 'research',
      workspace: '/srv/root/.life/research',
      queue: [{ ...researchSnapshot, paused: false }],
    })
    await page.getByLabel('Research operation', { exact: true }).selectOption('counterfactual')
    await event({
      type: 'text',
      itemId: 'research-final',
      phase: 'final_answer',
      status: 'replace',
      text: 'Research output before completion',
    })
    assert.equal((await state()).records.sends.length, 0)
    await event({ type: 'complete', status: 'completed' })
    current = await state()
    assert.equal(current.records.sends.length, 1)
    assert.equal(current.records.sends[0].researchOperation, 'ground')
    assert.equal(current.records.sends[0].text, exact)
    assert.equal(current.records.sends[0].files[0].id, 'research-operation-file')
    assert.equal(current.selectedOperation, 'counterfactual')
    assert.equal(current.records.stops, 0)
    record(
      'Changing the live research operation cannot alter a queued operation released after genuine completion',
    )

    await reset({ purpose: 'research', workspace: '/srv/root/.life/research', queue: [] })
    const invalidResult = await page.evaluate(() =>
      window.queueTest.enqueue(window.queueTest.exactText, 'invented-operation'),
    )
    await settle()
    current = await state()
    assert.equal(invalidResult, undefined)
    assert.equal(current.threads[0].queue.length, 0)
    assert.equal(current.records.errors.length, 1)
    assert.match(current.records.errors[0], /research operation/i)
    assert.equal(current.records.sends.length + current.records.steering.length, 0)
    assert.equal(current.preparing, false)
    record(
      'Unknown runtime research operations report an error without queueing or sending extra text',
    )

    await reset({
      queue: [{ ...queued('legacy-operation'), researchOperation: 'invented-operation' }],
    })
    await page.evaluate(() => window.queueTest.restore())
    await settle()
    current = await state()
    assert.equal(Object.hasOwn(current.threads[0].queue[0], 'researchOperation'), false)
    assert.equal(current.threads[0].queue[0].paused, true)
    assert.equal(current.threads[0].queue[0].text, exact)
    assert.equal(current.records.sends.length + current.records.steering.length, 0)
    record(
      'Unknown stored research operations are omitted while original queued text remains paused',
    )

    for (const turnStatus of ['running', 'reconnecting', 'unknown', 'failed', 'interrupted']) {
      await reset({ busy: false, turnStatus })
      assert.equal((await state()).records.sends.length, 0)
      await settle()
      assert.equal((await state()).records.sends.length, 0)
      record(`${turnStatus} transport state cannot release an automatic follow-up`)
    }
    for (const pending of [
      [{ sessionId: 'thread', type: 'approval', requestId: 'approval' }],
      [{ sessionId: 'thread', type: 'question', requestId: 'question' }],
    ]) {
      await reset({ busy: false, turnStatus: 'completed', pending })
      assert.equal((await state()).records.sends.length, 0)
      await page.evaluate(() => window.queueTest.patch({ pending: [] }))
      await settle()
      assert.equal((await state()).records.sends.length, 1)
      record(`${pending[0].type} blocks pumping until it is resolved`)
    }

    for (const automatic of [false, true]) {
      await reset({
        busy: !automatic,
        turnStatus: automatic ? 'completed' : 'running',
        queue: [{ ...queued('first'), paused: true }],
      })
      const attachment = await page.evaluate(() => window.queueTest.holdAttachment('held-file'))
      await page.evaluate(
        ({ attachment, automatic }) =>
          window.queueTest.patch({
            queue: [
              {
                id: 'first',
                text: window.queueTest.exactText,
                createdAt: 10,
                attachments: [attachment],
                paused: !automatic,
              },
            ],
          }),
        { attachment, automatic },
      )
      await settle()
      if (!automatic)
        await page.getByRole('button', { name: 'Send now first', exact: true }).click()
      await page.waitForFunction(() => window.queueTest.attachmentReady('held-file'))
      await page.evaluate(() => window.queueTest.connection({ workspace: '/srv/other-project' }))
      await settle()
      await page.evaluate(() => window.queueTest.releaseAttachment('held-file'))
      await settle()
      current = await state()
      assert.equal(current.records.steering.length + current.records.sends.length, 0)
      assert.equal(current.threads[0].queue[0].paused, true)
      assert.ok(current.threads[0].queue[0].error)
      assert.equal(current.threads[0].queue[0].text, exact)
      record(
        `${automatic ? 'Automatic' : 'Explicit'} dispatch rechecks the environment after actual IndexedDB attachment loading`,
      )
    }

    for (const cancellation of ['remove', 'block', 'pending']) {
      const messageId = 'attachment-race-' + cancellation
      await reset({
        busy: false,
        turnStatus: 'completed',
        queue: [{ ...queued(messageId), paused: true }],
      })
      const attachment = await page.evaluate(() => window.queueTest.holdAttachment('held-file'))
      await page.evaluate(
        ({ attachment, messageId }) =>
          window.queueTest.patch({
            queue: [
              {
                id: messageId,
                text: window.queueTest.exactText,
                createdAt: 10,
                attachments: [attachment],
              },
            ],
          }),
        { attachment, messageId },
      )
      await page.waitForFunction(() => window.queueTest.attachmentReady('held-file'))
      await page.evaluate(
        ({ cancellation, messageId }) => {
          if (cancellation === 'remove') window.queueTest.remove(messageId)
          if (cancellation === 'block') window.queueTest.blocked(true)
          if (cancellation === 'pending')
            window.queueTest.patch({
              pending: [{ sessionId: 'thread', type: 'approval', requestId: 'approval' }],
            })
        },
        { cancellation, messageId },
      )
      await settle()
      await page.evaluate(() => window.queueTest.releaseAttachment('held-file'))
      await settle()
      current = await state()
      assert.equal(current.records.sends.length + current.records.steering.length, 0)
      if (cancellation === 'remove') assert.equal(current.threads[0].queue.length, 0)
      else assert.equal(current.threads[0].queue[0].paused, true)
      record(`${cancellation} during attachment loading prevents the automatic provider dispatch`)
    }

    await reset({
      queue: [
        {
          ...queued('first'),
          attachments: [{ id: 'missing', name: 'missing.txt', mime: 'text/plain', size: 1 }],
        },
      ],
    })
    await page.getByRole('button', { name: 'Send now first', exact: true }).click()
    await settle()
    current = await state()
    assert.equal(current.records.steering.length + current.records.sends.length, 0)
    assert.equal(current.threads[0].queue[0].paused, true)
    assert.match(current.threads[0].queue[0].error, /unavailable/)
    record('A missing IndexedDB attachment pauses the original message without losing its text')

    await reset({
      busy: false,
      turnStatus: 'completed',
      queue: [{ ...queued('first'), paused: true }],
    })
    await page.evaluate(() => window.queueTest.restore())
    await settle()
    current = await state()
    assert.equal(current.threads[0].queue[0].paused, true)
    assert.equal(current.threads[0].queue[0].text, exact)
    assert.equal(current.records.sends.length, 0)
    record('Real saved history restore keeps queued user messages paused and never replays them')

    await reset(
      { busy: false, turnStatus: 'completed', queue: [{ ...queued('first'), paused: true }] },
      { send: 'pending' },
    )
    await page.evaluate(() =>
      window.queueTest.patch({
        queue: [{ id: 'first', text: window.queueTest.exactText, createdAt: 10, attachments: [] }],
      }),
    )
    await settle()
    await page.evaluate(() => {
      window.queueTest.sendNow('first')
      window.queueTest.sendNow('first')
    })
    await event({ type: 'settings', status: 'accepted', details: { model: 'changed' } })
    assert.equal((await state()).records.sends.length, 1)
    await page.evaluate(() => window.queueTest.resolve('send'))
    await settle()
    current = await state()
    assert.equal(current.records.sends.length, 1)
    assert.equal(current.threads[0].messages.filter((item) => item.id === 'sent:first').length, 1)
    record('Concurrent explicit clicks and provider updates do not duplicate an automatic dispatch')

    await reset({}, { steer: 'pending' })
    await page.getByRole('button', { name: 'Send now first', exact: true }).click()
    await settle()
    await page.evaluate(() => window.queueTest.connection({ status: 'disconnected' }))
    await event({ type: 'status', status: 'reconnecting', text: 'Waiting for connection' })
    await page.evaluate(() => window.queueTest.resolve('steer', 'throw'))
    await settle()
    current = await state()
    assert.equal(current.records.steering.length, 1)
    assert.equal(current.threads[0].turnStatus, 'reconnecting')
    assert.equal(current.threads[0].queue[0].paused, true)
    assert.equal(current.threads[0].queue[0].text, exact)
    await page.evaluate(() => window.queueTest.connection({ status: 'connected' }))
    await event({ type: 'status', status: 'resumed' })
    assert.equal((await state()).records.sends.length, 0)
    assert.equal((await state()).records.steering.length, 1)
    record('A failed in-flight steering request across disconnect remains paused after resume')

    await reset({ busy: false, turnStatus: 'unknown' })
    await page.evaluate(() => {
      window.queueTest.remove('first')
      window.queueTest.sendNow('first')
    })
    await settle()
    assert.equal((await state()).records.sends.length, 0)
    assert.equal((await state()).threads[0].queue.length, 0)
    record('Removed queued messages cannot dispatch through stale controls')

    assert.deepEqual(errors, [], 'The real hook must not produce browser errors')
    const proof = {
      ok: true,
      browser: 'Chromium',
      realReactStrictMode: true,
      realIndexedDB: true,
      checks,
      browserErrors: errors,
      finishedAt: new Date().toISOString(),
    }
    const path =
      process.env.LIFE_QUEUE_PROOF ||
      resolve(__dirname, '../output/playwright/thread-queue/proof.json')
    await mkdir(dirname(path), { recursive: true })
    await writeFile(path, JSON.stringify(proof, null, 2) + '\n')
    console.log(JSON.stringify({ ok: true, checks: checks.length, proof: path }))
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
