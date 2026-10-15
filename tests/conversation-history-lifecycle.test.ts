import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { runInNewContext } from 'node:vm'
import ts from 'typescript'
import { Worker } from 'node:worker_threads'
import { Effect, Layer } from 'effect'
import { ApplicationRuntime, NativeOperations } from '../src/main/application-runtime'
import {
  ConversationHistoryLifecycle,
  finishNativeShutdownEffect,
  historyUncertaintyMessage,
  type CapturedHistoryDocument,
} from '../src/main/conversation-history-lifecycle'
import { NativeDocumentReadiness } from '../src/main/native-document-readiness'
import { ConversationStore } from '../src/main/conversation-store'
import type {
  CheckpointRequest,
  CheckpointResponse,
} from '../src/main/conversation-checkpoint-transport'
import { PersistenceError } from '../src/main/persistence-effects'
import { RendererDocumentAdmission, RendererReloadFlights } from '../src/main/renderer-recovery'
import { runEffect } from '../src/main/effect-runtime'

let fixtureDirectory: string
let workerPath: string
let directory: string
let stores: ConversationStore[]
let runtimes: ApplicationRuntime[]
let ownedWorkers: Set<Worker>
let releases: (() => void)[]

function thread(text: string, id = 'ordinary') {
  return {
    id,
    profileId: 'exact-profile',
    provider: 'codex',
    sessionId: 'exact-provider-session',
    scope: id === 'studio' ? 'life-customization' : 'research',
    futureThreadField: { retained: true },
    messages: [{ id: 'exact-message', role: 'user', text }],
  }
}
const original = { version: 1, savedAt: 100, threads: [thread('  Original\r\n🧪  ')] }

function deferred() {
  let resolve!: () => void
  const promise = new Promise<void>((done) => (resolve = done))
  releases.push(resolve)
  return { promise, resolve }
}

function observeOwnedWorkers() {
  const accepted: { worker: Worker; request: CheckpointRequest }[] = []
  const posted: { worker: Worker; request: CheckpointRequest }[] = []
  const callbacks = new Map<Worker, (response: CheckpointResponse) => void>()
  const originalOn = Worker.prototype.on
  vi.spyOn(Worker.prototype, 'on').mockImplementation(function (this: Worker, event, listener) {
    if (event === 'message') callbacks.set(this, listener)
    return Reflect.apply(originalOn, this, [event, listener])
  })
  const originalPost = Worker.prototype.postMessage
  vi.spyOn(Worker.prototype, 'postMessage').mockImplementation(function (
    this: Worker,
    message,
    ...args
  ) {
    if (message?.command) {
      posted.push({ worker: this, request: message })
      if (!ownedWorkers.has(this)) {
        ownedWorkers.add(this)
        Reflect.apply(originalOn, this, [
          'message',
          (response: {
            id: number
            result?: { fixtureAccepted?: boolean; request: CheckpointRequest }
          }) => {
            if (response.result?.fixtureAccepted)
              accepted.push({ worker: this, request: response.result.request })
          },
        ])
      }
    }
    return Reflect.apply(originalPost, this, [message, ...args])
  })
  return {
    accepted,
    posted,
    callbacks,
    async admission(index = 0) {
      await vi.waitFor(() => expect(accepted).toHaveLength(index + 1))
      expect(accepted[index].worker.threadId).toBeGreaterThan(0)
      return accepted[index]
    },
  }
}

async function storeFor(mode: 'healthy' | 'silent' | 'committed-without-ack', grace = 50) {
  const path = join(directory, mode)
  await mkdir(path)
  await writeFile(join(path, 'conversations.json'), JSON.stringify(original))
  const store = new ConversationStore(path, { workerPath, shutdownGraceMs: grace })
  stores.push(store)
  await expect(store.load()).resolves.toEqual(original)
  return { store, path }
}

async function disk(path: string) {
  return JSON.parse(await readFile(join(path, 'conversations.json'), 'utf8'))
}

beforeAll(async () => {
  fixtureDirectory = await mkdtemp(join(tmpdir(), 'life-history-lifecycle-worker-'))
  workerPath = join(fixtureDirectory, 'owned-writer.cjs')
  await writeFile(
    workerPath,
    `
const {parentPort,workerData}=require('node:worker_threads')
const fs=require('node:fs'),path=require('node:path')
const file=path.join(workerData.directory,'conversations.json')
const mode=path.basename(workerData.directory)
let held
function commit(request) {
  const snapshot={version:1,savedAt:request.command.savedAt,threads:request.command.threads}
  const temporary=file+'.owned.tmp'
  const fd=fs.openSync(temporary,'wx',0o600)
  try {fs.writeFileSync(fd,JSON.stringify(snapshot));fs.fsyncSync(fd)} finally {fs.closeSync(fd)}
  fs.renameSync(temporary,file)
  const directory=fs.openSync(workerData.directory,'r')
  try {fs.fsyncSync(directory)} finally {fs.closeSync(directory)}
}
parentPort.on('message',message=>{
  if(message.release && held) {
    const request=held;held=undefined
    if(mode!=='committed-without-ack')commit(request)
    parentPort.postMessage({id:request.id,result:{savedAt:request.command.savedAt}})
  } else if(message.command?.type==='load') {
    parentPort.postMessage({id:message.id,result:JSON.parse(fs.readFileSync(file,'utf8'))})
  } else if(message.command?.type==='loadEncoded') {
    const encoded=new TextEncoder().encode(fs.readFileSync(file,'utf8'))
    parentPort.postMessage({id:message.id,result:encoded.buffer},[encoded.buffer])
  } else if(message.command?.type==='save') {
    held=message
    if(mode==='committed-without-ack')commit(message)
    parentPort.postMessage({id:-message.id,result:{fixtureAccepted:true,request:message}})
  }
})
`,
  )
})
afterAll(async () => rm(fixtureDirectory, { recursive: true, force: true }))
beforeEach(async () => {
  directory = await mkdtemp(join(tmpdir(), 'life-history-lifecycle-'))
  stores = []
  runtimes = []
  ownedWorkers = new Set()
  releases = []
})
afterEach(async () => {
  for (const release of releases) release()
  // Terminate only exact Worker objects observed from this test's Store. This
  // also lets teardown finish when a regression strands a history barrier.
  await Promise.all(
    [...ownedWorkers].map((worker) => (worker.threadId === -1 ? undefined : worker.terminate())),
  )
  await Promise.allSettled([
    ...stores.map((store) => store.close()),
    ...runtimes.map((runtime) => runtime.dispose()),
  ])
  vi.restoreAllMocks()
  await rm(directory, { recursive: true, force: true })
})

describe('native conversation history lifecycle', () => {
  it('waits for accepted ordinary and Studio drafts to receive a genuine ACK while healthy restarts remain usable', async () => {
    const probe = observeOwnedWorkers()
    const { store, path } = await storeFor('healthy', 1000)
    const lifecycle = new ConversationHistoryLifecycle()
    const admission = new RendererDocumentAdmission()
    lifecycle.commitDocument(admission)
    const owner = {}
    const flight = {}
    const flights = new RendererReloadFlights<object, object>()
    flights.replace(owner, admission.documentRevision, flight)
    const captured = lifecycle.capture(admission)
    const drafts = [
      thread('  Ordinary draft\r\n  漢字 🧪  '),
      thread('  Studio draft\n\t  ', 'studio'),
    ]
    let saving!: Promise<void>
    let handedOff = false
    const settling = runEffect(
      lifecycle.handoffEffect(
        store,
        captured,
        Effect.sync(() => {
          saving = store.save(drafts, 200)
        }),
      ),
    ).then(() => {
      handedOff = true
      flights.clear(flight)
    })
    const accepted = await probe.admission()
    await new Promise((resolve) => setImmediate(resolve))
    expect(handedOff).toBe(false)
    expect(flights.get(owner, admission.documentRevision)).toBe(flight)
    expect(await disk(path)).toEqual(original)
    lifecycle.commitDocument(admission)
    const committedRevision = admission.documentRevision
    expect(committedRevision).toBeGreaterThan(captured.revision)
    expect(() => lifecycle.admit(admission, 'agent:start')).toThrow('restarting')
    expect(() => lifecycle.admit(admission, 'source-code:apply')).toThrow('restarting')
    expect(() => lifecycle.assertCanCreateDocument()).toThrow('still saving history')
    const committedFresh = new RendererDocumentAdmission()
    lifecycle.commitDocument(committedFresh)
    expect(() => lifecycle.admit(committedFresh, 'agent:start')).toThrow('restarting')
    accepted.worker.postMessage({ release: true })
    await Promise.all([saving, settling])
    expect(handedOff).toBe(true)
    expect(await disk(path)).toEqual({ version: 1, savedAt: 200, threads: drafts })
    expect(lifecycle.failure).toBeUndefined()
    expect(accepted.worker.threadId).toBeGreaterThan(0)
    expect(admission.documentRevision).toBe(committedRevision)
    expect(() => lifecycle.admit(admission, 'agent:start')).not.toThrow()
    expect(() => lifecycle.admit(committedFresh, 'agent:start')).not.toThrow()
    expect(() => lifecycle.assertCanCreateDocument()).not.toThrow()
    expect(flights.get(owner, admission.documentRevision)).toBeUndefined()
    lifecycle.commitDocument(admission)
    const fresh = new RendererDocumentAdmission()
    lifecycle.commitDocument(fresh)
    expect(() => lifecycle.admit(admission, 'agent:start')).not.toThrow()
    expect(() => lifecycle.admit(fresh, 'source-code:apply')).not.toThrow()
    expect(captured.ownsDocument()).toBe(false)
    const next = store.save([thread('Exact prompt after healthy restart')], 300)
    const second = await probe.admission(1)
    second.worker.postMessage({ release: true })
    await next
    await expect(store.load()).resolves.toEqual({
      version: 1,
      savedAt: 300,
      threads: [thread('Exact prompt after healthy restart')],
    })
  })

  it('keeps timeout uncertainty sticky after flight clearing and both same-window and fresh-document commits', async () => {
    const probe = observeOwnedWorkers()
    const { store, path } = await storeFor('silent')
    const lifecycle = new ConversationHistoryLifecycle()
    const admission = new RendererDocumentAdmission()
    lifecycle.commitDocument(admission)
    const owner = {}
    const flight = {}
    const flights = new RendererReloadFlights<object, object>()
    flights.replace(owner, admission.documentRevision, flight)
    const saving = store.save([thread('accepted active')], 200)
    const rejected = expect(saving).rejects.toMatchObject({ operation: 'shutdown-uncertain' })
    const accepted = await probe.admission()
    const queued = store.save([thread('accepted newest draft', 'studio')], 300)
    const queuedRejected = expect(queued).rejects.toMatchObject({ operation: 'shutdown-uncertain' })
    await expect(
      runEffect(lifecycle.settledEffect(store, lifecycle.capture(admission))),
    ).rejects.toBeInstanceOf(PersistenceError)
    await Promise.all([rejected, queuedRejected])
    const failure = lifecycle.failure!
    expect(failure.operation).toBe('shutdown-uncertain')
    expect(failure.message).toBe(historyUncertaintyMessage)
    expect(failure.cause).toMatchObject({ operation: 'shutdown-uncertain', path: failure.path })
    expect(() => lifecycle.assertCanCreateDocument()).toThrow(failure)
    expect(accepted.worker.threadId).toBe(-1)
    flights.clear(flight)
    lifecycle.commitDocument(admission)
    const fresh = new RendererDocumentAdmission()
    lifecycle.commitDocument(fresh)
    for (const target of [admission, fresh]) {
      for (const channel of [
        'agent:start',
        'connection:connect',
        'profiles:save',
        'source-code:apply',
        'terminal:write',
        'conversations:save',
        'conversations:checkpoint',
      ])
        expect(() => lifecycle.admit(target, channel)).toThrow(failure)
      expect(() => lifecycle.admit(target, 'app:info')).not.toThrow()
      expect(() => lifecycle.admit(target, 'profiles:list')).not.toThrow()
    }
    await expect(runEffect(lifecycle.settledEffect(store))).rejects.toBe(failure)
    await expect(runEffect(lifecycle.closeEffect(store))).rejects.toBe(failure)
    await expect(store.save([thread('must not reopen writer')], 400)).rejects.toBe(failure.cause)
    expect(ownedWorkers.size).toBe(1)
    expect(probe.posted.map(({ request }) => request.command.type)).toEqual(['load', 'save'])
    expect(await disk(path)).toEqual(original)
  })

  it('retains a stale captured-document failure globally without erasing a successor reload flight', async () => {
    const probe = observeOwnedWorkers()
    const { store } = await storeFor('silent')
    const lifecycle = new ConversationHistoryLifecycle()
    const admission = new RendererDocumentAdmission()
    lifecycle.commitDocument(admission)
    let ownsWindow = true
    const captured = lifecycle.capture(admission, () => ownsWindow)
    const oldRevision = captured.revision
    const owner = {}
    const oldFlight = {}
    const nextFlight = {}
    const flights = new RendererReloadFlights<object, object>()
    flights.replace(owner, oldRevision, oldFlight)
    const rejected = expect(
      store.save([thread('accepted old document')], 200),
    ).rejects.toMatchObject({ operation: 'shutdown-uncertain' })
    await probe.admission()
    const settling = runEffect(lifecycle.handoffEffect(store, captured, Effect.void))
    const failed = expect(settling).rejects.toMatchObject({ operation: 'shutdown-uncertain' })
    lifecycle.commitDocument(admission)
    const freshRevision = admission.documentRevision
    flights.replace(owner, freshRevision, nextFlight)
    ownsWindow = false
    expect(captured.ownsDocument()).toBe(false)
    await Promise.all([rejected, failed])
    flights.clear(oldFlight)
    expect(flights.get(owner, freshRevision)).toBe(nextFlight)
    expect(admission.documentRevision).toBe(freshRevision)
    expect(lifecycle.failure?.operation).toBe('shutdown-uncertain')
    expect(() => lifecycle.admit(admission, 'agent:start')).toThrow(lifecycle.failure)
    const newWindowAdmission = new RendererDocumentAdmission()
    lifecycle.commitDocument(newWindowAdmission)
    expect(() => lifecycle.admit(newWindowAdmission, 'connection:connect')).toThrow(
      lifecycle.failure,
    )
  })

  it('keeps fresh document admission paused until every overlapping healthy handoff finishes', async () => {
    const probe = observeOwnedWorkers()
    const { store } = await storeFor('healthy', 1000)
    const lifecycle = new ConversationHistoryLifecycle()
    const admission = new RendererDocumentAdmission()
    lifecycle.commitDocument(admission)
    const captured = lifecycle.capture(admission)
    const saving = store.save([thread('exact shared healthy ACK')], 200)
    const accepted = await probe.admission()
    const releaseSecond = deferred()
    const secondStarted = deferred()
    const first = runEffect(lifecycle.handoffEffect(store, captured, Effect.void))
    const second = runEffect(
      lifecycle.handoffEffect(
        store,
        captured,
        Effect.sync(secondStarted.resolve).pipe(
          Effect.andThen(Effect.promise(() => releaseSecond.promise)),
        ),
      ),
    )
    await secondStarted.promise
    const fresh = new RendererDocumentAdmission()
    lifecycle.commitDocument(fresh)
    expect(() => lifecycle.admit(fresh, 'agent:start')).toThrow('restarting')
    accepted.worker.postMessage({ release: true })
    await Promise.all([saving, first])
    expect(() => lifecycle.admit(fresh, 'agent:start')).toThrow('restarting')
    expect(() => lifecycle.assertCanCreateDocument()).toThrow('still saving history')
    releaseSecond.resolve()
    await second
    expect(() => lifecycle.admit(fresh, 'agent:start')).not.toThrow()
    expect(() => lifecycle.assertCanCreateDocument()).not.toThrow()
    expect(lifecycle.failure).toBeUndefined()
    expect(accepted.worker.threadId).toBeGreaterThan(0)
  })

  it('blocks replacement documents while the old window is gone and owned worker termination is still pending', async () => {
    const probe = observeOwnedWorkers()
    const { store } = await storeFor('silent')
    const lifecycle = new ConversationHistoryLifecycle()
    const admission = new RendererDocumentAdmission()
    lifecycle.commitDocument(admission)
    let ownsWindow = true
    const captured = lifecycle.capture(admission, () => ownsWindow)
    const saving = expect(
      store.save([thread('accepted before the old window disappears')], 200),
    ).rejects.toMatchObject({ operation: 'shutdown-uncertain' })
    const accepted = await probe.admission()
    const reachedTermination = deferred()
    const allowTermination = deferred()
    const actualTerminate = Worker.prototype.terminate
    vi.spyOn(Worker.prototype, 'terminate').mockImplementationOnce(function (this: Worker) {
      expect(this).toBe(accepted.worker)
      reachedTermination.resolve()
      return allowTermination.promise.then(() => Reflect.apply(actualTerminate, this, []))
    })
    const settling = runEffect(lifecycle.handoffEffect(store, captured, Effect.void))
    const failed = expect(settling).rejects.toMatchObject({ operation: 'shutdown-uncertain' })
    await reachedTermination.promise
    ownsWindow = false
    expect(captured.ownsDocument()).toBe(false)
    expect(lifecycle.failure).toBeUndefined()
    expect(accepted.worker.threadId).toBeGreaterThan(0)
    const fresh = new RendererDocumentAdmission()
    lifecycle.commitDocument(fresh)
    expect(() => lifecycle.admit(fresh, 'agent:start')).toThrow('restarting')
    expect(() => lifecycle.assertCanCreateDocument()).toThrow('still saving history')
    allowTermination.resolve()
    await Promise.all([saving, failed])
    expect(accepted.worker.threadId).toBe(-1)
    expect(lifecycle.failure?.operation).toBe('shutdown-uncertain')
    expect(() => lifecycle.admit(fresh, 'agent:start')).toThrow(lifecycle.failure)
    expect(() => lifecycle.assertCanCreateDocument()).toThrow(lifecycle.failure)
    expect(ownedWorkers.size).toBe(1)
  })

  it('never treats committed-before-ACK loss or a late callback as a successful handoff', async () => {
    const probe = observeOwnedWorkers()
    const { store, path } = await storeFor('committed-without-ack')
    const lifecycle = new ConversationHistoryLifecycle()
    const admission = new RendererDocumentAdmission()
    lifecycle.commitDocument(admission)
    let acknowledged = false
    const saving = store.save([thread('  Exact committed draft\r\n🧪  ')], 200).then(() => {
      acknowledged = true
    })
    const rejected = expect(saving).rejects.toMatchObject({ operation: 'shutdown-uncertain' })
    const accepted = await probe.admission()
    expect((await disk(path)).savedAt).toBe(200)
    const handoff = vi.fn()
    const settling = runEffect(
      lifecycle.handoffEffect(store, lifecycle.capture(admission), Effect.void),
    ).then(handoff)
    await expect(settling).rejects.toMatchObject({ operation: 'shutdown-uncertain' })
    await rejected
    expect(accepted.worker.threadId).toBe(-1)
    probe.callbacks.get(accepted.worker)!({ id: accepted.request.id, result: { savedAt: 200 } })
    expect(acknowledged).toBe(false)
    expect(handoff).not.toHaveBeenCalled()
    expect((await disk(path)).savedAt).toBe(200)
    expect(() => lifecycle.assertHealthy()).toThrow(lifecycle.failure)
  })

  it('preserves accepted work and future document admission when a lifecycle caller cancels', async () => {
    const probe = observeOwnedWorkers()
    const { store } = await storeFor('healthy', 1000)
    const lifecycle = new ConversationHistoryLifecycle()
    const admission = new RendererDocumentAdmission()
    lifecycle.commitDocument(admission)
    const saving = store.save([thread('accepted prompt survives canceled barrier')], 200)
    const accepted = await probe.admission()
    const controller = new AbortController()
    const barrier = runEffect(lifecycle.settledEffect(store, lifecycle.capture(admission)), {
      signal: controller.signal,
    })
    const rejected = expect(barrier).rejects.toBeInstanceOf(Error)
    controller.abort()
    await rejected
    expect(lifecycle.failure).toBeUndefined()
    expect(accepted.worker.threadId).toBeGreaterThan(0)
    accepted.worker.postMessage({ release: true })
    await saving
    await runEffect(lifecycle.settledEffect(store))
    lifecycle.commitDocument(admission)
    expect(() => lifecycle.admit(admission, 'agent:start')).not.toThrow()
    expect(ownedWorkers.size).toBe(1)
  })

  it('rejects queued native work at the real ApplicationRuntime dispatch edge after uncertainty', async () => {
    const probe = observeOwnedWorkers()
    const { store } = await storeFor('silent')
    const lifecycle = new ConversationHistoryLifecycle()
    const admission = new RendererDocumentAdmission()
    lifecycle.commitDocument(admission)
    const captured = lifecycle.capture(admission)
    const initialize = deferred()
    const actualLayer = NativeOperations.layer
    vi.spyOn(NativeOperations, 'layer').mockImplementationOnce((handlers, admit) =>
      Layer.unwrap(
        Effect.promise(() => initialize.promise).pipe(Effect.as(actualLayer(handlers, admit))),
      ),
    )
    const runtime = new ApplicationRuntime((channel) => lifecycle.admit(admission, channel))
    runtimes.push(runtime)
    const work = vi.fn(() => Effect.succeed('must not start'))
    runtime.register('agent:start', work)
    runtime.register('app:info', () => Effect.succeed('rescue diagnostics'))
    const queued = runtime.invoke('agent:start', ['exact queued prompt'])
    const rejected = expect(queued).rejects.toMatchObject({
      _tag: 'NativeOperationError',
      operation: 'agent:start',
      cause: { _tag: 'PersistenceError', operation: 'shutdown-uncertain' },
    })
    const saving = expect(
      store.save([thread('accepted before dispatch')], 200),
    ).rejects.toMatchObject({ operation: 'shutdown-uncertain' })
    await probe.admission()
    await expect(runEffect(lifecycle.settledEffect(store, captured))).rejects.toMatchObject({
      operation: 'shutdown-uncertain',
    })
    lifecycle.commitDocument(admission)
    initialize.resolve()
    await Promise.all([saving, rejected])
    expect(work).not.toHaveBeenCalled()
    await expect(runtime.invoke('app:info', [])).resolves.toBe('rescue diagnostics')
    expect(lifecycle.failure?.operation).toBe('shutdown-uncertain')
  })

  it('closes the native actor only after its healthy accepted write is acknowledged', async () => {
    const probe = observeOwnedWorkers()
    const { store, path } = await storeFor('healthy', 1000)
    const lifecycle = new ConversationHistoryLifecycle()
    const admission = new RendererDocumentAdmission()
    lifecycle.commitDocument(admission)
    const saving = store.save([thread('  Exact quit prompt\r\n  ')], 200)
    const accepted = await probe.admission()
    let closed = false
    const closing = runEffect(lifecycle.closeEffect(store, lifecycle.capture(admission))).then(
      () => {
        closed = true
      },
    )
    await new Promise((resolve) => setImmediate(resolve))
    expect(closed).toBe(false)
    expect(accepted.worker.threadId).toBeGreaterThan(0)
    accepted.worker.postMessage({ release: true })
    await Promise.all([saving, closing])
    expect(accepted.worker.threadId).toBe(-1)
    expect(await disk(path)).toEqual({
      version: 1,
      savedAt: 200,
      threads: [thread('  Exact quit prompt\r\n  ')],
    })
    expect(lifecycle.failure).toBeUndefined()
  })

  it('runs all shutdown phases after earlier failures and joins owned history and independent resources before runtime disposal', async () => {
    const probe = observeOwnedWorkers()
    const { store } = await storeFor('silent')
    const lifecycle = new ConversationHistoryLifecycle()
    const saving = expect(
      store.save([thread('accepted before shutdown failure')], 200),
    ).rejects.toMatchObject({ operation: 'shutdown-uncertain' })
    const accepted = await probe.admission()
    const workerExited = new Promise<void>((resolve) =>
      accepted.worker.once('exit', () => resolve()),
    )
    const resourceRelease = deferred()
    const events: string[] = []
    const flushFailure = new Error('renderer flush failed')
    const releaseFailure = new Error('provider release failed')
    const disconnectFailure = new Error('disconnect acknowledgement timed out')
    const reports: unknown[] = []
    const report = (error: unknown) => {
      reports.push(error)
    }
    const failPhase = (name: string, error: Error) =>
      Effect.sync(() => {
        events.push(name)
      }).pipe(Effect.andThen(Effect.fail(error)))
    const dispose = vi.fn(() => {
      expect(accepted.worker.threadId).toBe(-1)
      expect(events).toContain('resource-closed')
      events.push('runtime-disposed')
    })
    const closing = runEffect(
      finishNativeShutdownEffect(
        [
          failPhase('flush', flushFailure),
          failPhase('providers', releaseFailure),
          failPhase('disconnect', disconnectFailure),
          Effect.all(
            [
              finishNativeShutdownEffect(
                [
                  Effect.sync(() => {
                    events.push('history-close')
                  }).pipe(Effect.andThen(lifecycle.closeEffect(store))),
                ],
                report,
              ),
              finishNativeShutdownEffect(
                [
                  Effect.sync(() => {
                    events.push('resource-close')
                  }).pipe(
                    Effect.andThen(Effect.promise(() => resourceRelease.promise)),
                    Effect.andThen(
                      Effect.sync(() => {
                        events.push('resource-closed')
                      }),
                    ),
                  ),
                ],
                report,
              ),
            ],
            { concurrency: 'unbounded' },
          ),
          Effect.sync(dispose),
          Effect.sync(() => {
            events.push('app-quit')
          }),
        ],
        report,
      ),
    )
    await workerExited
    expect(dispose).not.toHaveBeenCalled()
    expect(events.slice(0, 3)).toEqual(['flush', 'providers', 'disconnect'])
    expect(events).toContain('resource-close')
    resourceRelease.resolve()
    await Promise.all([saving, closing])
    expect(dispose).toHaveBeenCalledTimes(1)
    expect(events.slice(-2)).toEqual(['runtime-disposed', 'app-quit'])
    expect(reports).toEqual([flushFailure, releaseFailure, disconnectFailure, lifecycle.failure])
    expect(lifecycle.failure?.operation).toBe('shutdown-uncertain')
    expect(ownedWorkers.size).toBe(1)
  })

  it('continues independent cleanup and final quit when cleanup defects and native error reporting both fail', async () => {
    const events: string[] = []
    const failure = new Error('cleanup defect')
    const report = vi.fn((error: unknown) => {
      expect(error).toBe(failure)
      events.push('reported')
      throw new Error('native diagnostics unavailable')
    })
    await runEffect(
      finishNativeShutdownEffect(
        [
          Effect.die(failure),
          Effect.sync(() => {
            events.push('resource-closed')
          }),
          Effect.sync(() => {
            events.push('runtime-disposed')
          }),
          Effect.sync(() => {
            events.push('app-quit')
          }),
        ],
        report,
      ),
    )
    expect(report).toHaveBeenCalledTimes(1)
    expect(events).toEqual(['reported', 'resource-closed', 'runtime-disposed', 'app-quit'])
  })
})

describe('actual Main history document ownership after native shutdown', () => {
  it('retains typed history uncertainty when native readiness closes before the final store phase', async () => {
    const path = resolve(import.meta.dirname, '../src/main/index.ts')
    const source = ts.createSourceFile(
      path,
      readFileSync(path, 'utf8'),
      ts.ScriptTarget.ES2022,
      true,
    )
    const declaration = source.statements.find(
      (node): node is ts.FunctionDeclaration =>
        ts.isFunctionDeclaration(node) && node.name?.text === 'captureHistoryDocument',
    )
    if (!declaration) throw new Error('Actual Main history document capture is unavailable')
    const executable = ts.transpileModule(declaration.getText(source), {
      compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.None },
    }).outputText
    const frame = {}
    const owner = {
      isDestroyed: () => false,
      webContents: { isDestroyed: () => false, mainFrame: frame },
    }
    const admission = new RendererDocumentAdmission()
    admission.commitMainDocument()
    const rendererAdmissions = new WeakMap([[owner, admission]])
    const nativeDocuments = new NativeDocumentReadiness()
    nativeDocuments.commit(owner)
    const historyLifecycle = new ConversationHistoryLifecycle()
    const capture = runInNewContext(executable + '\ncaptureHistoryDocument', {
      window: owner,
      rendererAdmissions,
      nativeDocuments,
      historyLifecycle,
    }) as (value: typeof owner) => CapturedHistoryDocument
    const original = capture(owner)
    expect(original.ownsDocument()).toBe(true)
    // Electron can reuse the frame wrapper while the native document advances.
    nativeDocuments.commit(owner)
    expect(owner.webContents.mainFrame).toBe(frame)
    expect(original.ownsDocument()).toBe(false)
    const finalDocument = capture(owner)
    expect(finalDocument.ownsDocument()).toBe(true)
    nativeDocuments.close()
    expect(() => finalDocument.ownsDocument()).not.toThrow()
    expect(finalDocument.ownsDocument()).toBe(false)
    const failure = new PersistenceError({
      operation: 'shutdown-uncertain',
      path: join(directory, 'conversations.json'),
      message: 'Real history worker acknowledgement is unknown.',
      cause: new Error('actual writer deadline expired'),
    })
    await expect(
      runEffect(
        historyLifecycle.closeEffect(
          { settledWithinEffect: () => Effect.void, closeEffect: () => Effect.fail(failure) },
          finalDocument,
        ),
      ),
    ).rejects.toMatchObject({
      _tag: 'PersistenceError',
      operation: 'shutdown-uncertain',
      message: historyUncertaintyMessage,
      cause: failure,
    })
    expect(historyLifecycle.failure?.cause).toBe(failure)
  })
})
