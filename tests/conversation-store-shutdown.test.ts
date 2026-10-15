import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { build } from 'esbuild'
import { createHash } from 'node:crypto'
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { Worker } from 'node:worker_threads'
import { Deferred, Effect, Exit, Scheduler } from 'effect'
import { ConversationStore } from '../src/main/conversation-store'
import { PersistenceError } from '../src/main/persistence-effects'
import { runEffect } from '../src/main/effect-runtime'
import type { ConversationRecoveryProof } from '../src/main/conversation-recovery-sidecar'
import type { ConversationCheckpointAck } from '../src/shared/conversations'
import type {
  CheckpointRequest,
  CheckpointResponse,
  CheckpointRecoveryPreparation,
} from '../src/main/conversation-checkpoint-transport'

let fixtureDirectory: string
let workerPath: string
let nativeWorkerPath: string
let heldNativeWorkerPath: string
let directory: string
let stores: ConversationStore[]
let ownedWorkers: Set<Worker>

const thread = (text: string) => ({
  id: 'owned-thread',
  profileId: 'owned-profile',
  provider: 'codex',
  sessionId: 'exact-session',
  messages: [{ id: 'exact-message', role: 'user', text }],
})
const original = { version: 1, savedAt: 100, threads: [thread('  Exact prompt\r\n🧪  ')] }

const nativeThread = () => ({
  ...thread('  Exact native history\r\n🧪  '),
  remoteId: 'exact-provider-session',
  workspace: '/exact workspace/漢字',
  nativeRecovery: {
    transport: { appliedRevision: 1, snapshotToken: 'native-snapshot', ownerGeneration: 3 },
  },
})

interface Admission {
  worker: Worker
  request: CheckpointRequest
  threadId: number
}

function observeOwnedWorkers() {
  const admissions: Admission[] = []
  const posted: { worker: Worker; request: CheckpointRequest }[] = []
  const messageListeners = new Map<
    Worker,
    (response: CheckpointResponse | CheckpointRecoveryPreparation) => void
  >()
  const originalOn = Worker.prototype.on
  vi.spyOn(Worker.prototype, 'on').mockImplementation(function (this: Worker, event, listener) {
    if (event === 'message') messageListeners.set(this, listener)
    return Reflect.apply(originalOn, this, [event, listener])
  })
  const originalPost = Worker.prototype.postMessage
  vi.spyOn(Worker.prototype, 'postMessage').mockImplementation(function (
    this: Worker,
    request,
    ...args
  ) {
    if (request?.command) posted.push({ worker: this, request })
    if (request?.command && !ownedWorkers.has(this)) {
      ownedWorkers.add(this)
      Reflect.apply(originalOn, this, [
        'message',
        (response: {
          id: number
          result?: { fixtureAcceptedWrite?: boolean; threadId: number; request: CheckpointRequest }
        }) => {
          if (response.result?.fixtureAcceptedWrite)
            admissions.push({
              worker: this,
              request: response.result.request,
              threadId: response.result.threadId,
            })
        },
      ])
    }
    return Reflect.apply(originalPost, this, [request, ...args])
  })
  return {
    admissions,
    posted,
    messageListeners,
    async accepted(index = 0): Promise<Admission> {
      await vi.waitFor(() => expect(admissions).toHaveLength(index + 1))
      const admission = admissions[index]
      expect(admission.worker.threadId).toBe(admission.threadId)
      return admission
    },
  }
}

async function storeFor(
  mode: string,
  grace = 50,
  options: ConstructorParameters<typeof ConversationStore>[1] = {},
) {
  const path = join(directory, mode)
  await mkdir(path)
  await writeFile(join(path, 'conversations.json'), JSON.stringify(original))
  const store = new ConversationStore(path, { workerPath, shutdownGraceMs: grace, ...options })
  stores.push(store)
  await expect(store.load()).resolves.toEqual(original)
  return { store, path }
}

beforeAll(async () => {
  fixtureDirectory = await mkdtemp(join(tmpdir(), 'life-owned-shutdown-worker-'))
  workerPath = join(fixtureDirectory, 'fault-worker.cjs')
  nativeWorkerPath = join(fixtureDirectory, 'conversation-checkpoint-worker.cjs')
  await build({
    entryPoints: [resolve('src/main/conversation-checkpoint-worker.ts')],
    outfile: nativeWorkerPath,
    bundle: true,
    platform: 'node',
    format: 'cjs',
    target: 'node22',
    logLevel: 'silent',
  })
  heldNativeWorkerPath = join(fixtureDirectory, 'native-commit-withheld-worker.cjs')
  await writeFile(
    heldNativeWorkerPath,
    `
const {parentPort,threadId}=require('node:worker_threads')
let request
parentPort.on('message', message=>{if(message.command)request=message})
const original=parentPort.postMessage.bind(parentPort)
parentPort.postMessage=(message,...args)=>{
  if(message.result?.nativeRecovery) {
    original({id:-message.id,result:{fixtureAcceptedWrite:true,threadId,request}})
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)),0,0)
    return
  }
  original(message,...args)
}
require(${JSON.stringify(nativeWorkerPath)})
`,
  )
  await writeFile(
    workerPath,
    `
const {parentPort,workerData,threadId}=require('node:worker_threads')
const fs=require('node:fs'), path=require('node:path')
const file=path.join(workerData.directory,'conversations.json')
const mode=path.basename(workerData.directory)
let held
let loads=0
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
    if(mode==='late-read-silent' && ++loads>1) {
      parentPort.postMessage({id:-message.id,result:{fixtureAcceptedWrite:true,threadId,request:message}})
    } else parentPort.postMessage({id:message.id,result:JSON.parse(fs.readFileSync(file,'utf8'))})
  } else if(message.command) {
    held=message
    if(mode==='committed-without-ack')commit(message)
    if(mode==='auto-ack') {
      commit(message);held=undefined
      parentPort.postMessage({id:message.id,result:{savedAt:message.command.savedAt}})
    } else parentPort.postMessage({id:-message.id,result:{fixtureAcceptedWrite:true,threadId,request:message}})
  }
})
`,
  )
})
afterAll(async () => rm(fixtureDirectory, { recursive: true, force: true }))
beforeEach(async () => {
  directory = await mkdtemp(join(tmpdir(), 'life-owned-shutdown-history-'))
  stores = []
  ownedWorkers = new Set()
})
afterEach(async () => {
  // These are exact Worker objects captured from this test's Store requests.
  // This guard also cleans up a regression where the Store shutdown hangs.
  await Promise.all(
    [...ownedWorkers].map((worker) => (worker.threadId === -1 ? undefined : worker.terminate())),
  )
  await Promise.allSettled(stores.map((store) => store.close()))
  vi.restoreAllMocks()
  await rm(directory, { recursive: true, force: true })
})

describe('conversation writer bounded shutdown', () => {
  it.each([0, -1, Number.NaN, Number.POSITIVE_INFINITY, 2_147_483_648])(
    'rejects invalid constructor shutdown policy %s before owning resources',
    (shutdownGraceMs) => {
      expect(() => new ConversationStore(directory, { workerPath, shutdownGraceMs })).toThrow(
        PersistenceError,
      )
      expect(ownedWorkers.size).toBe(0)
    },
  )

  it('fails active and queued writes with uncertainty and waits for actual owned worker exit', async () => {
    const probe = observeOwnedWorkers()
    const { store, path } = await storeFor('silent')
    const saving = store.save([thread('accepted active')], 200)
    const rejected = expect(saving).rejects.toMatchObject({
      _tag: 'PersistenceError',
      operation: 'shutdown-uncertain',
    })
    const admission = await probe.accepted()
    const queued = store.save([thread('accepted pending')], 300)
    const queuedRejected = expect(queued).rejects.toMatchObject({ operation: 'shutdown-uncertain' })
    const exited = new Promise<void>((resolve) => admission.worker.once('exit', () => resolve()))
    await expect(store.close()).rejects.toBeInstanceOf(PersistenceError)
    await Promise.all([rejected, queuedRejected, exited])
    expect(admission.worker.threadId).toBe(-1)
    for (const key of ['active', 'pending', 'draining', 'drainOwner'])
      expect(Reflect.get(store, key)).toBeUndefined()
    expect(probe.admissions).toHaveLength(1)
    expect(JSON.parse(await readFile(join(path, 'conversations.json'), 'utf8'))).toEqual(original)
    await expect(store.close()).rejects.toMatchObject({ operation: 'shutdown-uncertain' })
    await expect(store.settled()).rejects.toMatchObject({ operation: 'shutdown-uncertain' })
    await expect(store.load()).rejects.toMatchObject({ operation: 'shutdown-uncertain' })
    await expect(runEffect(store.loadRecoveryReceiptEffect())).rejects.toMatchObject({
      operation: 'shutdown-uncertain',
    })
    await expect(store.save([thread('must not create another writer')], 400)).rejects.toMatchObject(
      { operation: 'shutdown-uncertain' },
    )
    expect(ownedWorkers.size).toBe(1)
  })

  it('keeps committed-before-ACK loss uncertain and ignores a late acknowledgement', async () => {
    const probe = observeOwnedWorkers()
    const { store, path } = await storeFor('committed-without-ack')
    let acknowledged = false
    const saving = store.save([thread('exact committed but not acknowledged')], 200).then(() => {
      acknowledged = true
    })
    const rejected = expect(saving).rejects.toMatchObject({ operation: 'shutdown-uncertain' })
    const admission = await probe.accepted()
    expect(JSON.parse(await readFile(join(path, 'conversations.json'), 'utf8')).savedAt).toBe(200)
    await expect(store.close()).rejects.toMatchObject({ operation: 'shutdown-uncertain' })
    await rejected
    expect(admission.worker.threadId).toBe(-1)
    probe.messageListeners.get(admission.worker)!({
      id: admission.request.id,
      result: { savedAt: 200 },
    })
    expect(acknowledged).toBe(false)
    await expect(store.settled()).rejects.toMatchObject({ operation: 'shutdown-uncertain' })
    expect(JSON.parse(await readFile(join(path, 'conversations.json'), 'utf8')).savedAt).toBe(200)
  })

  it('waits for the real healthy write ACK before closing its worker', async () => {
    const probe = observeOwnedWorkers()
    const { store, path } = await storeFor('healthy', 1000)
    const saving = store.save([thread('  Healthy exact prompt\r\n🧪  ')], 200)
    const admission = await probe.accepted()
    let closed = false
    const closing = store.close().then(() => {
      closed = true
    })
    await new Promise((resolve) => setImmediate(resolve))
    expect(closed).toBe(false)
    expect(admission.worker.threadId).toBe(admission.threadId)
    admission.worker.postMessage({ release: true })
    await Promise.all([saving, closing])
    expect(closed).toBe(true)
    expect(admission.worker.threadId).toBe(-1)
    expect(JSON.parse(await readFile(join(path, 'conversations.json'), 'utf8'))).toEqual({
      version: 1,
      savedAt: 200,
      threads: [thread('  Healthy exact prompt\r\n🧪  ')],
    })
  })

  it('bounds lifecycle settlement, retires its silent worker and prevents reuse', async () => {
    const probe = observeOwnedWorkers()
    const { store } = await storeFor('silent')
    const rejected = expect(
      store.save([thread('unconfirmed lifecycle write')], 200),
    ).rejects.toMatchObject({ operation: 'shutdown-uncertain' })
    const admission = await probe.accepted()
    await expect(store.settledWithin()).rejects.toMatchObject({ operation: 'shutdown-uncertain' })
    await rejected
    expect(admission.worker.threadId).toBe(-1)
    await expect(store.settledWithin()).rejects.toMatchObject({ operation: 'shutdown-uncertain' })
  })

  it('detaches a cancelled bounded barrier without discarding healthy accepted work', async () => {
    const probe = observeOwnedWorkers()
    const { store, path } = await storeFor('healthy', 1000)
    const saving = store.save([thread('accepted write survives caller cancellation')], 200)
    const admission = await probe.accepted()
    const controller = new AbortController()
    const barrier = runEffect(store.settledWithinEffect(), { signal: controller.signal })
    const rejected = expect(barrier).rejects.toBeInstanceOf(Error)
    controller.abort()
    await rejected
    expect(admission.worker.threadId).toBe(admission.threadId)
    admission.worker.postMessage({ release: true })
    await saving
    await expect(store.settledWithin()).resolves.toBeUndefined()
    await expect(store.load()).resolves.toEqual({
      version: 1,
      savedAt: 200,
      threads: [thread('accepted write survives caller cancellation')],
    })
    expect(JSON.parse(await readFile(join(path, 'conversations.json'), 'utf8')).savedAt).toBe(200)
  })

  it('keeps healthy accepted writes alive after their save caller is interrupted', async () => {
    const probe = observeOwnedWorkers()
    const { store } = await storeFor('healthy', 1000)
    const controller = new AbortController()
    const saving = runEffect(store.saveEffect([thread('exact interrupted caller')], 200), {
      signal: controller.signal,
    })
    const rejected = expect(saving).rejects.toBeInstanceOf(Error)
    const admission = await probe.accepted()
    controller.abort()
    await rejected
    const closing = store.close()
    admission.worker.postMessage({ release: true })
    await expect(closing).resolves.toBeUndefined()
    expect(admission.worker.threadId).toBe(-1)
  })

  it('does not post a previously admitted reader after healthy close begins', async () => {
    const probe = observeOwnedWorkers()
    const { store } = await storeFor('late-read-silent', 1000)
    const saving = store.save([thread('confirmed before close')], 200)
    const admission = await probe.accepted()
    const loading = store.load()
    const rejected = expect(loading).rejects.toMatchObject({ operation: 'closed' })
    const privateLoading = runEffect(store.loadRecoveryReceiptEffect())
    const privateRejected = expect(privateLoading).rejects.toMatchObject({ operation: 'closed' })
    const closing = store.close()
    admission.worker.postMessage({ release: true })
    await Promise.all([saving, closing, rejected, privateRejected])
    expect(probe.posted.map(({ request }) => request.command.type)).toEqual(['load', 'save'])
    expect(admission.worker.threadId).toBe(-1)
  })

  it('retires an active silent read and prevents a queued reader from opening a replacement worker', async () => {
    const probe = observeOwnedWorkers()
    const { store } = await storeFor('late-read-silent')
    const active = store.load()
    const activeRejected = expect(active).rejects.toBeInstanceOf(PersistenceError)
    const admission = await probe.accepted()
    const queued = store.loadEncoded()
    const queuedRejected = expect(queued).rejects.toMatchObject({ operation: 'shutdown-uncertain' })
    await expect(store.close()).rejects.toMatchObject({ operation: 'shutdown-uncertain' })
    await Promise.all([activeRejected, queuedRejected])
    expect(admission.worker.threadId).toBe(-1)
    expect(ownedWorkers.size).toBe(1)
    expect(probe.posted.map(({ request }) => request.command.type)).toEqual(['load', 'load'])
  })

  it('rejects an invalid explicit settlement budget without retiring a healthy store', async () => {
    const probe = observeOwnedWorkers()
    const { store } = await storeFor('healthy', 1000)
    await expect(store.settledWithin(0)).rejects.toMatchObject({ operation: 'shutdown-budget' })
    const saving = store.save([thread('healthy after invalid caller budget')], 200)
    const admission = await probe.accepted()
    admission.worker.postMessage({ release: true })
    await saving
    await expect(store.close()).resolves.toBeUndefined()
  })

  it('continues accepted saves across drain-finalizer scheduling yields', async () => {
    observeOwnedWorkers()
    const { store } = await storeFor('auto-ack', 3000)
    await runEffect(
      Effect.gen(function* () {
        for (let revision = 101; revision <= 132; revision++)
          yield* store.saveEffect([thread(`exact revision ${revision}`)], revision)
        yield* store.settledWithinEffect()
        return yield* store.loadEffect()
      }).pipe(Effect.provideService(Scheduler.MaxOpsBeforeYield, 8)),
    ).then((snapshot) =>
      expect(snapshot).toEqual({
        version: 1,
        savedAt: 132,
        threads: [thread('exact revision 132')],
      }),
    )
  })

  it('settles every admission racing close under frequent scheduler yields', async () => {
    observeOwnedWorkers()
    const { store } = await storeFor('auto-ack', 3000)
    const [writes, closing] = await runEffect(
      Effect.all(
        [
          Effect.all(
            Array.from({ length: 32 }, (_, index) =>
              Effect.exit(store.saveEffect([thread(`exact concurrent ${index}`)], 200 + index)),
            ),
            { concurrency: 'unbounded' },
          ),
          Effect.exit(store.closeEffect()),
        ],
        { concurrency: 'unbounded' },
      ).pipe(Effect.provideService(Scheduler.MaxOpsBeforeYield, 8)),
    )
    expect(Exit.isSuccess(closing)).toBe(true)
    expect(writes).toHaveLength(32)
    for (const result of writes)
      if (Exit.isFailure(result))
        expect(result.cause.reasons).toEqual(
          expect.arrayContaining([
            expect.objectContaining({
              _tag: 'Fail',
              error: expect.objectContaining({ operation: 'closed' }),
            }),
          ]),
        )
    expect(ownedWorkers.size).toBe(1)
    expect([...ownedWorkers][0].threadId).toBe(-1)
  })
  it('retains accepted work when its caller aborts before drain launch', async () => {
    const probe = observeOwnedWorkers()
    const { store, path } = await storeFor('auto-ack', 3000)
    const controller = new AbortController()
    let abortedBeforeLaunch = false
    class BeforeLaunchScheduler extends Scheduler.MixedScheduler {
      override shouldYield(fiber: Parameters<Scheduler.MixedScheduler['shouldYield']>[0]) {
        if (
          !abortedBeforeLaunch &&
          Reflect.get(store, 'drainOwner') &&
          !Reflect.get(store, 'draining')
        ) {
          abortedBeforeLaunch = true
          expect(probe.posted.map(({ request }) => request.command.type)).toEqual(['load'])
          controller.abort()
          // Force the exact scheduler yield before forkIn evaluates. Without
          // this boundary, delayed interruption could arrive after launch.
          return true
        }
        return super.shouldYield(fiber)
      }
    }
    const saving = runEffect(
      store
        .saveEffect([thread('exact accepted pre-launch cancellation')], 200)
        .pipe(
          Effect.provideService(Scheduler.Scheduler, new BeforeLaunchScheduler()),
          Effect.provideService(Scheduler.MaxOpsBeforeYield, 8),
        ),
      { signal: controller.signal },
    )
    await expect(saving).rejects.toBeInstanceOf(Error)
    expect(abortedBeforeLaunch).toBe(true)
    await expect(store.settledWithin()).resolves.toBeUndefined()
    expect(JSON.parse(await readFile(join(path, 'conversations.json'), 'utf8'))).toEqual({
      version: 1,
      savedAt: 200,
      threads: [thread('exact accepted pre-launch cancellation')],
    })
    await expect(store.close()).resolves.toBeUndefined()
  })
})

describe('bounded shutdown with native history receipts', () => {
  it('retains the cold prepared proof after a real commit-before-ACK timeout without acknowledging native retention', async () => {
    const probe = observeOwnedWorkers()
    const prepared: ConversationRecoveryProof[] = []
    const onCommitted = vi.fn(() => Effect.void)
    const { store, path } = await storeFor('native-commit', 50, {
      workerPath: heldNativeWorkerPath,
      authorizeRecoveryReceipt: (proof) =>
        Effect.sync(() => {
          prepared.push(proof)
          return proof
        }),
      onCommitted,
    })
    const writing = store.save([nativeThread()], 200)
    const rejected = expect(writing).rejects.toMatchObject({ operation: 'shutdown-uncertain' })
    const admission = await probe.accepted()
    const bytes = await readFile(join(path, 'conversations.json'))
    expect(prepared).toHaveLength(1)
    expect(prepared[0].hash).toBe(createHash('sha256').update(bytes).digest('hex'))
    expect(JSON.parse(bytes.toString()).threads).toEqual([nativeThread()])
    await expect(store.close()).rejects.toMatchObject({ operation: 'shutdown-uncertain' })
    await rejected
    expect(admission.worker.threadId).toBe(-1)
    expect(onCommitted).not.toHaveBeenCalled()
    // Invoke the removed adapter listener with the exact late ACK to prove it
    // cannot resurrect success after scope retirement.
    probe.messageListeners.get(admission.worker)!({
      id: admission.request.id,
      result: {
        savedAt: 200,
        nativeRecovery: prepared[0].receipt,
        nativeRecoveryHash: prepared[0].hash,
      },
    })
    expect(onCommitted).not.toHaveBeenCalled()
    probe.messageListeners.get(admission.worker)!({
      type: 'recoveryPrepare',
      admissionId: 999,
      proof: prepared[0],
      projectionAdmissions: [],
    })
    await new Promise((resolve) => setImmediate(resolve))
    expect(prepared).toHaveLength(1)
    expect(onCommitted).not.toHaveBeenCalled()
    expect(probe.posted.map(({ request }) => request.command.type)).toEqual(['load', 'save'])
    expect(ownedWorkers.size).toBe(1)
    await expect(runEffect(store.loadRecoveryReceiptEffect())).rejects.toMatchObject({
      operation: 'shutdown-uncertain',
    })
    // This fresh store represents an explicit cold reopen after the previous
    // worker's observed exit, never an automatic same-store replacement.
    const reopened = new ConversationStore(path, { workerPath: nativeWorkerPath })
    stores.push(reopened)
    await expect(runEffect(reopened.loadRecoveryReceiptEffect())).resolves.toEqual(prepared[0])
    await expect(reopened.load()).resolves.toEqual({
      version: 1,
      savedAt: 200,
      threads: [nativeThread()],
    })
  })

  it('cancels an outstanding native preparation before retiring its actual worker and grants no commit ACK', async () => {
    observeOwnedWorkers()
    const preparation = Deferred.makeUnsafe<ConversationRecoveryProof>()
    const release = Deferred.makeUnsafe<void>()
    let preparationCancelled = false
    const onCommitted = vi.fn(() => Effect.void)
    const { store, path } = await storeFor('native-preparation', 50, {
      workerPath: nativeWorkerPath,
      authorizeRecoveryReceipt: (proof) =>
        Effect.gen(function* () {
          yield* Deferred.succeed(preparation, proof)
          yield* Deferred.await(release)
          return proof
        }).pipe(
          Effect.onInterrupt(() =>
            Effect.sync(() => {
              preparationCancelled = true
            }),
          ),
        ),
      onCommitted,
    })
    const writing = store.save([nativeThread()], 200)
    const rejected = expect(writing).rejects.toMatchObject({ operation: 'shutdown-uncertain' })
    await runEffect(Deferred.await(preparation))
    const worker = [...ownedWorkers][0]
    expect(worker.threadId).toBeGreaterThan(0)
    await expect(store.settledWithin()).rejects.toMatchObject({ operation: 'shutdown-uncertain' })
    await rejected
    expect(worker.threadId).toBe(-1)
    expect(preparationCancelled).toBe(true)
    await runEffect(Deferred.succeed(release, undefined))
    expect(onCommitted).not.toHaveBeenCalled()
    expect(JSON.parse(await readFile(join(path, 'conversations.json'), 'utf8'))).toEqual(original)
    await expect(
      readFile(join(path, 'conversations.recovery-receipts.json')),
    ).rejects.toMatchObject({
      code: 'ENOENT',
    })
    await expect(store.save([nativeThread()], 300)).rejects.toMatchObject({
      operation: 'shutdown-uncertain',
    })
    expect(ownedWorkers.size).toBe(1)
  })

  it('waits for a genuine post-commit native hook before a healthy bounded barrier and leaves the store usable', async () => {
    observeOwnedWorkers()
    const entered = Deferred.makeUnsafe<ConversationCheckpointAck>()
    const release = Deferred.makeUnsafe<void>()
    const acknowledged: ConversationCheckpointAck[] = []
    const { store, path } = await storeFor('native-healthy', 1000, {
      workerPath: nativeWorkerPath,
      authorizeRecoveryReceipt: Effect.succeed,
      onCommitted: (ack) =>
        Effect.gen(function* () {
          if (ack.savedAt === 200) {
            yield* Deferred.succeed(entered, ack)
            yield* Deferred.await(release)
          }
          acknowledged.push(ack)
        }),
    })
    let saved = false
    const writing = store.save([nativeThread()], 200).then(() => {
      saved = true
    })
    const ack = await runEffect(Deferred.await(entered))
    const proof = {
      hash: ack.nativeRecoveryHash!,
      savedAt: ack.savedAt,
      receipt: ack.nativeRecovery!,
    }
    expect(proof.hash).toBe(
      createHash('sha256')
        .update(await readFile(join(path, 'conversations.json')))
        .digest('hex'),
    )
    let settled = false
    const barrier = store.settledWithin().then(() => {
      settled = true
    })
    await new Promise((resolve) => setImmediate(resolve))
    expect(saved).toBe(false)
    expect(settled).toBe(false)
    expect(acknowledged).toEqual([])
    await runEffect(Deferred.succeed(release, undefined))
    await Promise.all([writing, barrier])
    expect(acknowledged).toEqual([ack])
    expect([...ownedWorkers][0].threadId).toBeGreaterThan(0)
    await expect(runEffect(store.loadRecoveryReceiptEffect())).resolves.toEqual(proof)
    await store.save([], 300)
    expect(acknowledged.map((value) => value.savedAt)).toEqual([200, 300])
    await expect(store.close()).resolves.toBeUndefined()
  })

  it('retires a native acknowledgement hook that stalls after the genuine worker ACK without later subscriber success', async () => {
    observeOwnedWorkers()
    const entered = Deferred.makeUnsafe<ConversationCheckpointAck>()
    const release = Deferred.makeUnsafe<void>()
    let promoted = false
    let hookInterrupted = false
    const onCommitted = vi.fn((ack: ConversationCheckpointAck) =>
      Effect.gen(function* () {
        yield* Deferred.succeed(entered, ack)
        yield* Deferred.await(release)
        promoted = true
      }).pipe(
        Effect.onInterrupt(() =>
          Effect.sync(() => {
            hookInterrupted = true
          }),
        ),
      ),
    )
    const { store, path } = await storeFor('native-hook-silent', 50, {
      workerPath: nativeWorkerPath,
      authorizeRecoveryReceipt: Effect.succeed,
      onCommitted,
    })
    let saved = false
    const writing = store.save([nativeThread()], 200).then(() => {
      saved = true
    })
    const rejected = expect(writing).rejects.toMatchObject({ operation: 'shutdown-uncertain' })
    const ack = await runEffect(Deferred.await(entered))
    expect(ack.nativeRecoveryHash).toBe(
      createHash('sha256')
        .update(await readFile(join(path, 'conversations.json')))
        .digest('hex'),
    )
    const worker = [...ownedWorkers][0]
    await expect(store.close()).rejects.toMatchObject({ operation: 'shutdown-uncertain' })
    await rejected
    await runEffect(Deferred.succeed(release, undefined))
    expect(worker.threadId).toBe(-1)
    expect(hookInterrupted).toBe(true)
    expect(promoted).toBe(false)
    expect(saved).toBe(false)
    expect(onCommitted).toHaveBeenCalledOnce()
    await expect(store.save([nativeThread()], 300)).rejects.toMatchObject({
      operation: 'shutdown-uncertain',
    })
  })
})
