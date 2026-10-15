import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { build } from 'esbuild'
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { Worker } from 'node:worker_threads'
import { Effect, Exit, Scope } from 'effect'
import { ConversationStore } from '../src/main/conversation-store'
import {
  workerCheckpointTransport,
  type CheckpointRequest,
} from '../src/main/conversation-checkpoint-transport'
import { runEffect } from '../src/main/effect-runtime'
import { CONVERSATION_CHECKPOINT_BASE_CHANGED } from '../src/shared/conversations'

let workerDirectory: string
let workerPath: string
let stalledWorkerPath: string
let directory: string
let stores: ConversationStore[]

function thread(text = 'Exact  prompt\n  preserved\n') {
  return {
    id: 'thread',
    profileId: 'workspace',
    provider: 'codex',
    sessionId: 'native-session',
    futureThreadField: { kept: true },
    messages: [{ id: 'message', role: 'user', text, futureMessageField: { kept: true } }],
  }
}

function createStore(path = workerPath) {
  const store = new ConversationStore(directory, { workerPath: path })
  stores.push(store)
  return store
}

function observeWorkerRequests() {
  const posted: { worker: Worker; request: CheckpointRequest }[] = []
  const online = new Set<Worker>()
  const observed = new Set<Worker>()
  const originalOn = Worker.prototype.on
  vi.spyOn(Worker.prototype, 'on').mockImplementation(function (this: Worker, event, listener) {
    if (!observed.has(this)) {
      observed.add(this)
      Reflect.apply(originalOn, this, ['online', () => online.add(this)])
    }
    return Reflect.apply(originalOn, this, [event, listener])
  })
  const originalPost = Worker.prototype.postMessage
  vi.spyOn(Worker.prototype, 'postMessage').mockImplementation(function (
    this: Worker,
    message,
    ...args
  ) {
    if (message?.command) posted.push({ worker: this, request: message })
    return Reflect.apply(originalPost, this, [message, ...args])
  })
  return { posted, online }
}

beforeAll(async () => {
  workerDirectory = await mkdtemp(join(tmpdir(), 'life-checkpoint-worker-build-'))
  workerPath = join(workerDirectory, 'conversation-checkpoint-worker.cjs')
  await build({
    entryPoints: [resolve('src/main/conversation-checkpoint-worker.ts')],
    outfile: workerPath,
    bundle: true,
    platform: 'node',
    format: 'cjs',
    target: 'node22',
    logLevel: 'silent',
  })
  stalledWorkerPath = join(workerDirectory, 'conversation-checkpoint-stalled-worker.cjs')
  await writeFile(
    stalledWorkerPath,
    `const { parentPort } = require('node:worker_threads')
let released = false
const held = []
parentPort.on('message', (message) => {
  if (message.release) {
    released = true
    for (const request of held.splice(0)) parentPort.postMessage({ id: request.id, result: null })
  } else if (message.command) {
    if (released) parentPort.postMessage({ id: message.id, result: null })
    else {
      held.push(message)
      parentPort.postMessage({ id: -message.id, result: null })
    }
  }
})
`,
  )
})
afterAll(async () => {
  await rm(workerDirectory, { recursive: true, force: true })
})
beforeEach(async () => {
  stores = []
  directory = await mkdtemp(join(tmpdir(), 'life-checkpoint-worker-'))
})
afterEach(async () => {
  await Promise.all(stores.map((store) => store.close()))
  vi.restoreAllMocks()
  await rm(directory, { recursive: true, force: true })
})

describe('scoped native conversation writer worker', () => {
  it('loads transferable v1 bytes with exact opaque fields and retains its healthy cached tree', async () => {
    const path = join(directory, 'conversations.json')
    const store = createStore()
    await expect(store.loadEncoded()).resolves.toBeNull()
    await store.close()
    const exact = thread('  Exact prompt\r\n\tUnicode café e\u0301 漢字 🧪\r\n  ')
    const original = {
      version: 1,
      savedAt: 100,
      futureSnapshotField: { exact: '  Unicode café e\u0301 漢字 🧪\r\n\t  ' },
      threads: [
        {
          ...exact,
          messages: [
            ...exact.messages,
            null,
            'opaque future message\r\n🧪',
            { futureMessageField: { values: [true, 42, null], exact: '\r\n\t🧪' } },
          ],
        },
      ],
    }
    await writeFile(path, JSON.stringify(original))
    const healthy = createStore()
    const encoded = await runEffect(healthy.loadEncodedEffect())
    expect(encoded).toBeInstanceOf(ArrayBuffer)
    expect(new TextDecoder().decode(encoded!)).toBe(JSON.stringify(original))
    const transferred = structuredClone(encoded!, { transfer: [encoded!] })
    expect(encoded!.byteLength).toBe(0)
    expect(JSON.parse(new TextDecoder().decode(transferred))).toEqual(original)
    // External changes do not replace an already acknowledged healthy base.
    await writeFile(path, '{ corrupt external replacement')
    const repeated = await healthy.loadEncoded()
    expect(repeated).toBeInstanceOf(ArrayBuffer)
    expect(JSON.parse(new TextDecoder().decode(repeated!))).toEqual(original)
    await expect(healthy.load()).resolves.toEqual(original)
    await healthy.saveCheckpoint({
      version: 1,
      baseSavedAt: 100,
      savedAt: 200,
      order: ['thread'],
      upserts: [],
    })
    const committed = await healthy.load()
    expect(committed?.savedAt).toBe(200)
    expect(committed?.threads).toEqual(original.threads)
    expect(JSON.parse(new TextDecoder().decode((await healthy.loadEncoded())!))).toEqual(committed)
  })

  it('encodes legacy array-only snapshots as v1 without changing their durable file', async () => {
    const path = join(directory, 'conversations.json')
    const legacy = [{ ...thread('Exact\r\nlegacy 漢字 🧪'), id: '' }]
    const serialized = JSON.stringify(legacy)
    await writeFile(path, serialized)
    const store = createStore()
    const expected = { version: 1, savedAt: 0, threads: legacy }
    expect(JSON.parse(new TextDecoder().decode((await store.loadEncoded())!))).toEqual(expected)
    await expect(store.load()).resolves.toEqual(expected)
    expect(await readFile(path, 'utf8')).toBe(serialized)
  })

  it('reuses validated v1 JSON bytes while retaining the exact ordinary load interpretation', async () => {
    const path = join(directory, 'conversations.json')
    const serialized = `{
  "version": 1,
  "savedAt": 1e2,
  "futureEnvelope": { "literal": "Unicode 漢字 🧪" },
  "threads": ${JSON.stringify([thread('  Exact\r\n🧪  ')])}
}\n`
    await writeFile(path, serialized)
    const store = createStore()
    const encoded = (await store.loadEncoded())!
    expect(new TextDecoder().decode(encoded)).toBe(serialized)
    const ordinary = await store.load()
    expect(JSON.parse(new TextDecoder().decode(encoded))).toEqual(ordinary)
    await store.save([], 200)
    expect(JSON.parse(new TextDecoder().decode((await store.loadEncoded())!))).toEqual({
      version: 1,
      savedAt: 200,
      futureEnvelope: { literal: 'Unicode 漢字 🧪' },
      threads: [],
    })
    expect(ordinary?.threads).toEqual([thread('  Exact\r\n🧪  ')])
  })

  it.each([
    { original: '{ exact corrupt original\r\n🧪', operation: 'decode' },
    {
      original: JSON.stringify({
        version: 1,
        savedAt: 100,
        threads: [{ ...thread(), provider: 'unknown' }],
      }),
      operation: 'validate',
    },
  ])(
    'preserves $operation failures until an encoded reload validates an external repair',
    async ({ original, operation }) => {
      const path = join(directory, 'conversations.json')
      await writeFile(path, original)
      const store = createStore()
      await expect(store.loadEncoded()).rejects.toMatchObject({ operation })
      await expect(store.save([], 100)).rejects.toMatchObject({ operation })
      expect(await readFile(path, 'utf8')).toBe(original)
      const repaired = { version: 1, savedAt: 200, threads: [thread('Exact\r\nrepair 🧪')] }
      await writeFile(path, JSON.stringify(repaired))
      await expect(store.save([], 300)).rejects.toMatchObject({ operation })
      expect(JSON.parse(new TextDecoder().decode((await store.loadEncoded())!))).toEqual(repaired)
      await expect(store.load()).resolves.toEqual(repaired)
      await store.saveCheckpoint({
        version: 1,
        baseSavedAt: 200,
        savedAt: 300,
        order: ['thread'],
        upserts: [],
      })
      expect((await createStore().load())?.threads).toEqual(repaired.threads)
    },
  )

  it('retains serialization after aborting its first request before the bundled worker is online', async () => {
    const original = { version: 1, savedAt: 100, threads: [thread('Exact\r\nscoped 🧪')] }
    await writeFile(join(directory, 'conversations.json'), JSON.stringify(original))
    const scope = Scope.makeUnsafe()
    const probe = observeWorkerRequests()
    const transport = await runEffect(
      workerCheckpointTransport(directory, workerPath).pipe(
        Effect.provideService(Scope.Scope, scope),
      ),
    )
    try {
      const controller = new AbortController()
      const interrupted = runEffect(transport.execute({ type: 'loadEncoded' }), {
        signal: controller.signal,
      })
      expect(probe.posted).toHaveLength(1)
      expect(probe.online.has(probe.posted[0].worker)).toBe(false)
      controller.abort()
      const loadingEncoded = runEffect(transport.execute({ type: 'loadEncoded' }))
      const loadingLegacy = runEffect(transport.execute({ type: 'load' }))
      expect(probe.posted).toHaveLength(1)
      await expect(interrupted).rejects.toBeInstanceOf(Error)
      const encoded = (await loadingEncoded) as ArrayBuffer
      expect(JSON.parse(new TextDecoder().decode(encoded))).toEqual(original)
      await expect(loadingLegacy).resolves.toEqual(original)
      expect(probe.posted.map(({ request }) => request.command.type)).toEqual([
        'loadEncoded',
        'loadEncoded',
        'load',
      ])
    } finally {
      await runEffect(Scope.close(scope, Exit.void))
    }
    await expect(runEffect(transport.execute({ type: 'loadEncoded' }))).rejects.toMatchObject({
      operation: 'worker',
      message: 'Conversation writer closed.',
    })
  })

  it('cancels queued readers without posting or retaining them while a detached request awaits its ACK', async () => {
    const scope = Scope.makeUnsafe()
    const probe = observeWorkerRequests()
    const transport = await runEffect(
      workerCheckpointTransport(directory, stalledWorkerPath).pipe(
        Effect.provideService(Scope.Scope, scope),
      ),
    )
    try {
      const controller = new AbortController()
      const active = runEffect(transport.execute({ type: 'loadEncoded' }), {
        signal: controller.signal,
      })
      const rejected = expect(active).rejects.toBeInstanceOf(Error)
      const worker = probe.posted[0].worker
      await new Promise<void>((resolve) => worker.once('message', () => resolve()))
      controller.abort()
      await rejected
      const abandoned = Array.from({ length: 6 }, () => {
        const queuedController = new AbortController()
        const queued = runEffect(transport.execute({ type: 'loadEncoded' }), {
          signal: queuedController.signal,
        })
        queuedController.abort()
        return expect(queued).rejects.toBeInstanceOf(Error)
      })
      await Promise.all(abandoned)
      expect(probe.posted).toHaveLength(1)
      const healthy = runEffect(transport.execute({ type: 'load' }))
      expect(probe.posted).toHaveLength(1)
      worker.postMessage({ release: true })
      await expect(healthy).resolves.toBeNull()
      await expect(runEffect(transport.execute({ type: 'loadEncoded' }))).resolves.toBeNull()
      expect(probe.posted.map(({ request }) => request.command.type)).toEqual([
        'loadEncoded',
        'load',
        'loadEncoded',
      ])
    } finally {
      await runEffect(Scope.close(scope, Exit.void))
    }
  })

  it.each(['active', 'detached'] as const)(
    'interrupts a stalled %s read and queued readers when its scope closes without an ACK',
    async (state) => {
      const scope = Scope.makeUnsafe()
      const probe = observeWorkerRequests()
      const transport = await runEffect(
        workerCheckpointTransport(directory, stalledWorkerPath).pipe(
          Effect.provideService(Scope.Scope, scope),
        ),
      )
      try {
        const controller = new AbortController()
        const active = runEffect(transport.execute({ type: 'loadEncoded' }), {
          signal: controller.signal,
        })
        const rejected = expect(active).rejects.toBeInstanceOf(Error)
        const worker = probe.posted[0].worker
        await new Promise<void>((resolve) => worker.once('message', () => resolve()))
        if (state === 'detached') {
          controller.abort()
          await rejected
        }
        const queued = runEffect(transport.execute({ type: 'load' }))
        const queuedRejected = expect(queued).rejects.toBeInstanceOf(Error)
        await runEffect(Scope.close(scope, Exit.void))
        await Promise.all([rejected, queuedRejected])
        expect(probe.posted).toHaveLength(1)
        expect(worker.threadId).toBe(-1)
        await expect(runEffect(transport.execute({ type: 'loadEncoded' }))).rejects.toMatchObject({
          operation: 'worker',
          message: 'Conversation writer closed.',
        })
      } finally {
        await runEffect(Scope.close(scope, Exit.void))
      }
    },
  )

  it('retries transient filesystem initialization errors without poisoning its existing worker', async () => {
    const path = join(directory, 'conversations.json')
    await mkdir(path)
    const store = createStore()
    await expect(store.load()).rejects.toMatchObject({
      operation: 'read',
      cause: { code: 'EISDIR' },
    })
    await expect(store.save([], 100)).rejects.toMatchObject({ operation: 'read' })
    await rm(path, { recursive: true })
    const original = { version: 1, savedAt: 100, threads: [thread()] }
    await writeFile(path, JSON.stringify(original))
    await expect(store.load()).resolves.toEqual(original)
  })

  it('retains the acknowledged base after a real atomic replacement failure and retries successfully', async () => {
    const store = createStore()
    await store.save([thread()], 100)
    const path = join(directory, 'conversations.json')
    await rm(path)
    await mkdir(path)
    await expect(
      store.saveCheckpoint({ version: 1, baseSavedAt: 100, savedAt: 200, order: [], upserts: [] }),
    ).rejects.toMatchObject({ operation: 'rename', cause: { code: 'EISDIR' } })
    expect((await store.load())?.threads).toEqual([thread()])
    expect(await readdir(directory)).toEqual(['conversations.json'])
    await rm(path, { recursive: true })
    await store.saveCheckpoint({
      version: 1,
      baseSavedAt: 100,
      savedAt: 300,
      order: ['thread'],
      upserts: [],
    })
    expect((await createStore().load())?.threads).toEqual([thread()])
  })

  it('preserves exact content and session identity through real worker checkpoints and restart', async () => {
    const store = createStore()
    await expect(store.load()).resolves.toBeNull()
    await store.save([thread()], 100)
    const { messages, ...metadata } = thread()
    const updatedMessage = { ...messages[0], text: 'Exact  streamed text\n  whitespace\n' }
    await expect(
      store.saveCheckpoint({
        version: 1,
        baseSavedAt: 100,
        savedAt: 200,
        order: ['thread'],
        upserts: [{ thread: metadata, messages: { mode: 'patch', upserts: [updatedMessage] } }],
      }),
    ).resolves.toEqual({ savedAt: 200 })
    const saved = await store.load()
    expect(saved).toEqual({
      version: 1,
      savedAt: 200,
      threads: [{ ...metadata, messages: [updatedMessage] }],
    })
    saved!.threads.length = 0
    expect((await store.load())?.threads).toHaveLength(1)
    await store.close()
    expect(await createStore().load()).toEqual({
      version: 1,
      savedAt: 200,
      threads: [{ ...metadata, messages: [updatedMessage] }],
    })
    const onDisk = JSON.parse(await readFile(join(directory, 'conversations.json'), 'utf8'))
    expect(onDisk.threads[0].sessionId).toBe('native-session')
  })

  it('preserves a damaged original until an explicit reload validates its external repair', async () => {
    const original = '{ exact corrupt original'
    await writeFile(join(directory, 'conversations.json'), original)
    const store = createStore()
    await expect(store.load()).rejects.toMatchObject({
      _tag: 'PersistenceError',
      operation: 'decode',
    })
    await expect(store.save([], 100)).rejects.toMatchObject({
      _tag: 'PersistenceError',
      operation: 'decode',
    })
    expect(await readFile(join(directory, 'conversations.json'), 'utf8')).toBe(original)
    const repaired = { version: 1, savedAt: 200, threads: [thread('Exact  repaired history\n')] }
    await writeFile(join(directory, 'conversations.json'), JSON.stringify(repaired))
    await expect(store.save([], 300)).rejects.toMatchObject({ operation: 'decode' })
    await expect(store.load()).resolves.toEqual(repaired)
    await expect(
      store.saveCheckpoint({
        version: 1,
        baseSavedAt: 200,
        savedAt: 300,
        order: ['thread'],
        upserts: [],
      }),
    ).resolves.toEqual({ savedAt: 300 })
    await expect(createStore().load()).resolves.toEqual({ ...repaired, savedAt: 300 })
  })

  it('validates unknown IPC inputs in the worker and rejects stale bases without modifying history', async () => {
    const store = createStore()
    await store.save([thread()], 100)
    await expect(store.saveCheckpoint(null)).rejects.toMatchObject({ operation: 'validate' })
    await expect(
      store.saveCheckpoint({
        version: 1,
        baseSavedAt: 99,
        savedAt: 200,
        order: ['thread'],
        upserts: [],
      }),
    ).rejects.toMatchObject({ operation: 'base', message: CONVERSATION_CHECKPOINT_BASE_CHANGED })
    expect((await store.load())?.threads).toEqual([thread()])
  })

  it('waits for an accepted initial write before terminating its scoped worker', async () => {
    const store = createStore()
    const accepted = store.save([thread('accepted before close')], 100)
    const closing = store.close()
    await Promise.all([accepted, closing, store.close()])
    expect((await createStore().load())?.threads).toEqual([thread('accepted before close')])
    await expect(store.save([thread('too late')], 200)).rejects.toMatchObject({
      operation: 'closed',
    })
  })

  it('retries failed worker initialization with a fresh child scope and retains durable history', async () => {
    const failedPath = join(workerDirectory, 'temporarily-unavailable-worker.cjs')
    await writeFile(failedPath, 'throw new Error("Worker temporarily unavailable")')
    const store = createStore(failedPath)
    await expect(store.save([thread('failed startup')], 100)).rejects.toMatchObject({
      operation: 'worker',
      message: 'Worker temporarily unavailable',
    })
    await writeFile(failedPath, await readFile(workerPath))
    await store.save([thread('retry recovered')], 200)
    expect((await store.load())?.threads).toEqual([thread('retry recovered')])
  })
})
