import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { build } from 'esbuild'
import * as fs from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { Worker } from 'node:worker_threads'
import { Effect } from 'effect'
import type { ConversationCheckpointAck } from '../src/shared/conversations'
import {
  ConversationCheckpointEngine,
  type ConversationHistoryPersistenceMode,
} from '../src/main/conversation-checkpoint-engine'
import type {
  CheckpointCommand,
  CheckpointResponse,
} from '../src/main/conversation-checkpoint-transport'
import { runEffect } from '../src/main/effect-runtime'
import { ConversationStore, type ConversationStoreOptions } from '../src/main/conversation-store'

const workerObservations = vi.hoisted(() => ({
  launches: [] as {
    worker: import('node:worker_threads').Worker
    options?: import('node:worker_threads').WorkerOptions
    initialThreadId: number
    exitCode?: number
  }[],
}))

vi.mock('node:worker_threads', async (original) => {
  const actual = await original<typeof import('node:worker_threads')>()
  return {
    ...actual,
    Worker: class extends actual.Worker {
      constructor(...args: ConstructorParameters<typeof actual.Worker>) {
        super(...args)
        const observation: (typeof workerObservations.launches)[number] = {
          worker: this,
          options: args[1],
          initialThreadId: this.threadId,
        }
        workerObservations.launches.push(observation)
        this.once('exit', (exitCode) => {
          observation.exitCode = exitCode
        })
      }
    },
  }
})

vi.mock('node:fs/promises', async (original) => {
  const actual = await original<typeof import('node:fs/promises')>()
  return { ...actual, mkdir: vi.fn(actual.mkdir), open: vi.fn(actual.open) }
})
const actualFs = await vi.importActual<typeof import('node:fs/promises')>('node:fs/promises')
let directory: string
let workerDirectory: string
let workerPath: string
let stores: ConversationStore[]
let cleanupUncertain = false

function thread() {
  return {
    id: 'local-session',
    provider: 'codex' as const,
    profileId: 'exact-machine',
    workspace: '/exact workspace/漢字',
    remoteId: 'native-root',
    nativeRecovery: {
      'opaque-transport': {
        appliedRevision: 27,
        snapshotToken: 'raw-imported-token',
        ownerGeneration: 4,
      },
    },
    futureThread: { retained: ['opaque', null] },
    messages: [
      {
        id: 'message',
        role: 'assistant',
        text: '  Exact\r\n漢字 🧪\t  ',
        futureMessage: { retained: true },
      },
    ],
  }
}

async function seedRawHistory() {
  const snapshot = { version: 1, savedAt: 100, threads: [thread()], futureSnapshot: ['retained'] }
  const serialized = JSON.stringify(snapshot)
  await actualFs.writeFile(join(directory, 'conversations.json'), serialized)
  return { snapshot, serialized }
}

function createWorker(persistenceMode: ConversationHistoryPersistenceMode, userData = directory) {
  const worker = new Worker(workerPath, {
    workerData: { directory: userData, persistenceMode },
  })
  let nextId = 0
  const preparations: unknown[] = []
  const pending = new Map<
    number,
    { resolve: (response: CheckpointResponse) => void; reject: (error: Error) => void }
  >()
  worker.on('message', (response: CheckpointResponse | { type: string }) => {
    if ('type' in response) {
      preparations.push(response)
      return
    }
    const request = pending.get(response.id)
    if (!request) return
    pending.delete(response.id)
    request.resolve(response)
  })
  worker.on('error', (error) => {
    for (const request of pending.values()) request.reject(error)
    pending.clear()
  })
  worker.on('exit', (code) => {
    for (const request of pending.values())
      request.reject(new Error(`Private history policy worker exited with code ${code}.`))
    pending.clear()
  })
  return {
    preparations,
    request(command: CheckpointCommand) {
      const id = ++nextId
      return new Promise<CheckpointResponse>((resolve, reject) => {
        const deadline = setTimeout(() => {
          pending.delete(id)
          reject(new Error('Private history policy worker did not answer.'))
        }, 10_000)
        pending.set(id, {
          resolve: (response) => {
            clearTimeout(deadline)
            resolve(response)
          },
          reject: (error) => {
            clearTimeout(deadline)
            reject(error)
          },
        })
        worker.postMessage({ id, command })
      })
    },
  }
}

function createStore(options: ConversationStoreOptions, userData = directory) {
  const store = new ConversationStore(userData, { workerPath, ...options })
  stores.push(store)
  return store
}

beforeAll(async () => {
  workerDirectory = await actualFs.mkdtemp(join(tmpdir(), 'life-history-policy-worker-build-'))
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
})
afterAll(async () => {
  if (!cleanupUncertain) await actualFs.rm(workerDirectory, { recursive: true, force: true })
})
beforeEach(async () => {
  directory = await actualFs.mkdtemp(join(tmpdir(), 'life-history-platform-policy-'))
  stores = []
  workerObservations.launches.length = 0
  vi.mocked(fs.mkdir).mockReset().mockImplementation(actualFs.mkdir)
  vi.mocked(fs.open).mockReset().mockImplementation(actualFs.open)
})
afterEach(async () => {
  const closeOutcomes = await Promise.allSettled(stores.map((store) => store.close()))
  const terminationOutcomes = await Promise.allSettled(
    workerObservations.launches.map(({ worker }) => worker.terminate()),
  )
  const failures: unknown[] = []
  for (const outcome of [...closeOutcomes, ...terminationOutcomes])
    if (outcome.status === 'rejected') failures.push(outcome.reason)
  try {
    if (failures.length)
      throw new AggregateError(
        failures,
        `Private history policy cleanup remains uncertain: ${directory}`,
      )
    for (const observation of workerObservations.launches) {
      expect(observation.initialThreadId).toBeGreaterThan(0)
      expect(observation.worker.threadId).toBe(-1)
      expect(observation.exitCode).toEqual(expect.any(Number))
    }
  } catch (cause) {
    cleanupUncertain = true
    throw cause
  }
  await actualFs.rm(directory, { recursive: true, force: true })
})

describe('conversation history persistence policy', () => {
  it.each(['ordinary', 'read-only'] as const)(
    'loads an absent archive in %s mode without creating its directory',
    async (persistenceMode) => {
      const missing = join(directory, 'absent')
      const engine = new ConversationCheckpointEngine(missing, { persistenceMode })
      await expect(runEffect(engine.loadEffect())).resolves.toBeNull()
      await expect(runEffect(engine.loadEncodedEffect())).resolves.toBeNull()
      await expect(runEffect(engine.loadRecoveryReceiptEffect())).resolves.toBeNull()
      expect(fs.mkdir).not.toHaveBeenCalled()
      await expect(actualFs.lstat(missing)).rejects.toMatchObject({ code: 'ENOENT' })
    },
  )

  it('rejects read-only save and checkpoint before initialization or directory creation', async () => {
    const missing = join(directory, 'absent')
    const engine = new ConversationCheckpointEngine(missing, { persistenceMode: 'read-only' })
    await expect(runEffect(engine.saveEffect([thread()], 100))).rejects.toMatchObject({
      operation: 'recovery-platform',
    })
    await expect(runEffect(engine.checkpointEffect(null))).rejects.toMatchObject({
      operation: 'recovery-platform',
    })
    expect(fs.mkdir).not.toHaveBeenCalled()
    await expect(actualFs.lstat(missing)).rejects.toMatchObject({ code: 'ENOENT' })
  })

  it.each(['full save', 'compact checkpoint'] as const)(
    'migrates a valid ordinary legacy array through its first %s without native authority',
    async (operation) => {
      await actualFs.writeFile(join(directory, 'conversations.json'), JSON.stringify([thread()]))
      const engine = new ConversationCheckpointEngine(directory, { persistenceMode: 'ordinary' })
      await expect(runEffect(engine.loadEffect())).resolves.toEqual({
        version: 1,
        savedAt: 0,
        threads: [thread()],
      })
      const write =
        operation === 'full save'
          ? engine.saveEffect([thread()], 100)
          : engine.checkpointEffect({
              version: 1,
              baseSavedAt: 0,
              savedAt: 100,
              order: [thread().id],
              upserts: [],
            })
      await expect(runEffect(write)).resolves.toEqual({ savedAt: 100 })
      expect(
        JSON.parse(await actualFs.readFile(join(directory, 'conversations.json'), 'utf8')),
      ).toEqual({ version: 1, savedAt: 100, threads: [thread()] })
      await expect(runEffect(engine.loadRecoveryReceiptEffect())).resolves.toBeNull()
      await expect(
        actualFs.lstat(join(directory, 'conversations.recovery-receipts.json')),
      ).rejects.toMatchObject({ code: 'ENOENT' })
    },
  )

  it('keeps raw imported cursors opaque during an ordinary save and compact append', async () => {
    const { snapshot } = await seedRawHistory()
    const authorizeRecoveryReceipt = vi.fn(() => Effect.die(new Error('No native admission.')))
    vi.mocked(fs.open).mockImplementation(async (...args) => {
      if (args[0] === directory && args[1] === 'r')
        throw Object.assign(new Error('Directory sync unsupported.'), { code: 'EPERM' })
      return actualFs.open(...args)
    })
    const engine = new ConversationCheckpointEngine(directory, {
      persistenceMode: 'ordinary',
      authorizeRecoveryReceipt,
    })
    await expect(runEffect(engine.loadEffect())).resolves.toEqual(snapshot)
    await expect(runEffect(engine.saveEffect([thread()], 200))).resolves.toEqual({ savedAt: 200 })
    const { messages, ...metadata } = thread()
    const suffix = '\r\n  Exact continuation Ω 🧪  '
    await expect(
      runEffect(
        engine.checkpointEffect({
          version: 1,
          baseSavedAt: 200,
          savedAt: 300,
          order: [metadata.id],
          upserts: [
            {
              thread: metadata,
              messages: {
                mode: 'patch',
                upserts: [],
                fields: [
                  {
                    id: messages[0].id,
                    set: {},
                    remove: [],
                    append: { text: { baseLength: messages[0].text.length, value: suffix } },
                  },
                ],
              },
            },
          ],
        }),
      ),
    ).resolves.toEqual({ savedAt: 300 })
    expect(authorizeRecoveryReceipt).not.toHaveBeenCalled()
    await expect(runEffect(engine.loadRecoveryReceiptEffect())).resolves.toBeNull()
    const written = JSON.parse(
      await actualFs.readFile(join(directory, 'conversations.json'), 'utf8'),
    )
    expect(written).toEqual({
      ...snapshot,
      savedAt: 300,
      threads: [{ ...thread(), messages: [{ ...messages[0], text: messages[0].text + suffix }] }],
    })
    await expect(
      actualFs.lstat(join(directory, 'conversations.recovery-receipts.json')),
    ).rejects.toMatchObject({ code: 'ENOENT' })
  })

  it('loads a genuine protected archive without deriving sidecar authority in ordinary or read-only mode', async () => {
    const native = new ConversationCheckpointEngine(directory, {
      authorizeRecoveryReceipt: Effect.succeed,
    })
    const nativeAck = await runEffect(native.saveEffect([thread()], 100))
    expect(nativeAck.nativeRecoveryHash).toMatch(/^[a-f0-9]{64}$/)
    const history = await actualFs.readFile(join(directory, 'conversations.json'))
    const sidecar = await actualFs.readFile(join(directory, 'conversations.recovery-receipts.json'))
    vi.mocked(fs.mkdir).mockClear()
    vi.mocked(fs.open).mockClear()
    for (const persistenceMode of ['ordinary', 'read-only'] as const) {
      const engine = new ConversationCheckpointEngine(directory, { persistenceMode })
      await expect(runEffect(engine.loadEffect())).resolves.toEqual(JSON.parse(history.toString()))
      await expect(runEffect(engine.loadRecoveryReceiptEffect())).resolves.toBeNull()
      await expect(runEffect(engine.saveEffect([thread()], 200))).rejects.toMatchObject({
        operation: 'recovery-platform',
      })
      expect(await actualFs.readFile(join(directory, 'conversations.json'))).toEqual(history)
      expect(
        await actualFs.readFile(join(directory, 'conversations.recovery-receipts.json')),
      ).toEqual(sidecar)
    }
    expect(fs.mkdir).not.toHaveBeenCalled()
    expect(fs.open).not.toHaveBeenCalled()
  })

  it.each([
    'conversations.recovery-receipts.json',
    'conversations.recovery-receipts.json.uncertain.tmp',
    'conversations.json.uncertain.tmp',
  ])('preserves protected or uncertain %s before an ordinary replacement', async (name) => {
    const { serialized } = await seedRawHistory()
    const engine = new ConversationCheckpointEngine(directory, { persistenceMode: 'ordinary' })
    await runEffect(engine.loadEffect())
    const opaque = '  unreadable recovery format\r\n漢字 🧪  '
    await actualFs.writeFile(join(directory, name), opaque)
    await expect(runEffect(engine.saveEffect([], 200))).rejects.toMatchObject({
      operation: 'recovery-platform',
    })
    expect(await actualFs.readFile(join(directory, 'conversations.json'), 'utf8')).toBe(serialized)
    expect(await actualFs.readFile(join(directory, name), 'utf8')).toBe(opaque)
  })

  it('allows read-only export when a sidecar is corrupt without altering either original', async () => {
    const { serialized } = await seedRawHistory()
    const sidecar = '{ incomplete protected receipt'
    await actualFs.writeFile(join(directory, 'conversations.recovery-receipts.json'), sidecar)
    const engine = new ConversationCheckpointEngine(directory, { persistenceMode: 'read-only' })
    const bytes = await runEffect(engine.loadEncodedEffect())
    expect(bytes && Buffer.from(bytes).toString('utf8')).toBe(serialized)
    await expect(runEffect(engine.loadRecoveryReceiptEffect())).resolves.toBeNull()
    await expect(runEffect(engine.saveEffect([], 200))).rejects.toMatchObject({
      operation: 'recovery-platform',
    })
    expect(await actualFs.readFile(join(directory, 'conversations.json'), 'utf8')).toBe(serialized)
    expect(
      await actualFs.readFile(join(directory, 'conversations.recovery-receipts.json'), 'utf8'),
    ).toBe(sidecar)
  })
})

describe('actual history worker persistence policy', () => {
  it('validates ordinary worker mode while raw cursor metadata stays inert across structured cloning', async () => {
    const worker = createWorker('ordinary')
    const save = await worker.request({ type: 'save', threads: [thread()], savedAt: 100 })
    expect(save).toMatchObject({ result: { savedAt: 100 } })
    expect('error' in save).toBe(false)
    const proof = await worker.request({ type: 'loadRecoveryReceipt' })
    expect(proof).toMatchObject({ result: null })
    expect(worker.preparations).toEqual([])
    expect(
      JSON.parse(await actualFs.readFile(join(directory, 'conversations.json'), 'utf8')),
    ).toEqual({
      version: 1,
      savedAt: 100,
      threads: [thread()],
    })
    await expect(
      actualFs.lstat(join(directory, 'conversations.recovery-receipts.json')),
    ).rejects.toMatchObject({ code: 'ENOENT' })
  })

  it('rejects a read-only worker write without creating an absent archive directory', async () => {
    const absent = join(directory, 'absent')
    const worker = createWorker('read-only', absent)
    const save = await worker.request({ type: 'save', threads: [thread()], savedAt: 100 })
    expect(save).toMatchObject({ error: { operation: 'recovery-platform' } })
    expect(await worker.request({ type: 'loadEncoded' })).toMatchObject({ result: null })
    expect(worker.preparations).toEqual([])
    await expect(actualFs.lstat(absent)).rejects.toMatchObject({ code: 'ENOENT' })
  })

  it('rechecks protected files after hydration before an ordinary worker replacement', async () => {
    const { serialized } = await seedRawHistory()
    const worker = createWorker('ordinary')
    expect(await worker.request({ type: 'load' })).toMatchObject({
      result: JSON.parse(serialized),
    })
    const protectedPath = join(directory, 'conversations.recovery-receipts.json')
    const original = '{ original protected sidecar'
    await actualFs.writeFile(protectedPath, original)
    const save = await worker.request({ type: 'save', threads: [], savedAt: 200 })
    expect(save).toMatchObject({ error: { operation: 'recovery-platform' } })
    expect(worker.preparations).toEqual([])
    expect(await actualFs.readFile(join(directory, 'conversations.json'), 'utf8')).toBe(serialized)
    expect(await actualFs.readFile(protectedPath, 'utf8')).toBe(original)
  })
})

describe('conversation Store persistence policy admission', () => {
  it('rejects read-only writes before the first actual Worker can launch', async () => {
    const absent = join(directory, 'absent')
    const authorizeRecoveryReceipt = vi.fn(() => Effect.succeed(null))
    const onCommitted = vi.fn(() => Effect.void)
    const store = createStore(
      { persistenceMode: 'read-only', authorizeRecoveryReceipt, onCommitted },
      absent,
    )
    await expect(store.save([thread()], 100)).rejects.toMatchObject({
      operation: 'recovery-platform',
    })
    await expect(store.saveCheckpoint(null)).rejects.toMatchObject({
      operation: 'recovery-platform',
    })
    await expect(store.settledWithin()).resolves.toBeUndefined()
    expect(workerObservations.launches).toEqual([])
    expect(authorizeRecoveryReceipt).not.toHaveBeenCalled()
    expect(onCommitted).not.toHaveBeenCalled()
    await expect(actualFs.lstat(absent)).rejects.toMatchObject({ code: 'ENOENT' })
  })

  it('preserves an existing private sidecar before the first ordinary Worker can launch', async () => {
    const { serialized } = await seedRawHistory()
    const protectedPath = join(directory, 'conversations.recovery-receipts.json')
    const sidecar = '{ original protected proof'
    await actualFs.writeFile(protectedPath, sidecar)
    const authorizeRecoveryReceipt = vi.fn(() => Effect.succeed(null))
    const onCommitted = vi.fn(() => Effect.void)
    const store = createStore({
      persistenceMode: 'ordinary',
      authorizeRecoveryReceipt,
      onCommitted,
    })
    await expect(store.save([], 200)).rejects.toMatchObject({ operation: 'recovery-platform' })
    await expect(store.saveCheckpoint(null)).rejects.toMatchObject({
      operation: 'recovery-platform',
    })
    expect(workerObservations.launches).toEqual([])
    expect(authorizeRecoveryReceipt).not.toHaveBeenCalled()
    expect(onCommitted).not.toHaveBeenCalled()
    expect(await actualFs.readFile(join(directory, 'conversations.json'), 'utf8')).toBe(serialized)
    expect(await actualFs.readFile(protectedPath, 'utf8')).toBe(sidecar)
  })

  it('does not replace a retired ordinary Worker when protected state appears before retry', async () => {
    const { snapshot, serialized } = await seedRawHistory()
    const store = createStore({ persistenceMode: 'ordinary' })
    await expect(store.load()).resolves.toEqual(snapshot)
    expect(workerObservations.launches).toHaveLength(1)
    const originalWorker = workerObservations.launches[0]
    await originalWorker.worker.terminate()
    expect(originalWorker.worker.threadId).toBe(-1)
    expect(originalWorker.exitCode).toEqual(expect.any(Number))
    await expect(store.load()).rejects.toMatchObject({ operation: 'worker' })
    const protectedPath = join(directory, 'conversations.recovery-receipts.json')
    const sidecar = '{ retained proof after actual writer exit'
    await actualFs.writeFile(protectedPath, sidecar)
    for (const savedAt of [200, 300])
      await expect(store.save([], savedAt)).rejects.toMatchObject({
        operation: 'recovery-platform',
      })
    expect(workerObservations.launches).toHaveLength(1)
    expect(await actualFs.readFile(join(directory, 'conversations.json'), 'utf8')).toBe(serialized)
    expect(await actualFs.readFile(protectedPath, 'utf8')).toBe(sidecar)
  })

  it('forwards ordinary mode to its actual Worker while committed raw cursors carry no native proof', async () => {
    const { snapshot } = await seedRawHistory()
    const acknowledgements: ConversationCheckpointAck[] = []
    const authorizeRecoveryReceipt = vi.fn(() => Effect.succeed(null))
    const onCommitted = vi.fn((ack: ConversationCheckpointAck) =>
      Effect.sync(() => {
        acknowledgements.push(ack)
      }),
    )
    const store = createStore({
      persistenceMode: 'ordinary',
      authorizeRecoveryReceipt,
      onCommitted,
    })
    const ack = await store.saveCheckpoint({
      version: 1,
      baseSavedAt: 100,
      savedAt: 200,
      order: [thread().id],
      upserts: [],
    })
    expect(ack).toEqual({ savedAt: 200 })
    expect(acknowledgements).toEqual([{ savedAt: 200 }])
    expect(onCommitted).toHaveBeenCalledTimes(1)
    expect(authorizeRecoveryReceipt).not.toHaveBeenCalled()
    expect(workerObservations.launches).toHaveLength(1)
    const observation = workerObservations.launches[0]
    expect(observation.options?.workerData).toEqual({ directory, persistenceMode: 'ordinary' })
    await expect(runEffect(store.loadRecoveryReceiptEffect())).resolves.toBeNull()
    await expect(store.load()).resolves.toEqual({ ...snapshot, savedAt: 200 })
    expect(
      JSON.parse(await actualFs.readFile(join(directory, 'conversations.json'), 'utf8')),
    ).toEqual({
      ...snapshot,
      savedAt: 200,
    })
    await expect(
      actualFs.lstat(join(directory, 'conversations.recovery-receipts.json')),
    ).rejects.toMatchObject({ code: 'ENOENT' })
    await store.close()
    expect(observation.worker.threadId).toBe(-1)
    expect(observation.exitCode).toEqual(expect.any(Number))
  })
})
