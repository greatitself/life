import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { build } from 'esbuild'
import { createHash } from 'node:crypto'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { Worker } from 'node:worker_threads'
import { Effect } from 'effect'
import { ConversationStore } from '../src/main/conversation-store'
import type { ConversationRecoveryProof } from '../src/main/conversation-recovery-sidecar'
import type { ConversationProjectionAdmission } from '../src/shared/conversations'

let workerDirectory: string
let workerPath: string
let heldWorkerPath: string
let directory: string
let stores: ConversationStore[]

function thread(revision = 1) {
  return {
    id: 'local-session',
    provider: 'codex',
    profileId: 'machine',
    workspace: '/exact workspace',
    remoteId: 'native-thread',
    nativeRecovery: {
      transport: { appliedRevision: revision, snapshotToken: 'issued-token', ownerGeneration: 3 },
    },
    messages: [{ id: 'message', role: 'assistant', text: 'Exact\r\n漢字 🧪  ' }],
    futureField: { opaque: [null, 'retained'] },
  }
}

function store(
  worker = workerPath,
  options: ConstructorParameters<typeof ConversationStore>[1] = {},
) {
  const value = new ConversationStore(directory, { workerPath: worker, ...options })
  stores.push(value)
  return value
}

beforeAll(async () => {
  workerDirectory = await mkdtemp(join(tmpdir(), 'life-writeahead-worker-build-'))
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
  heldWorkerPath = join(workerDirectory, 'history-commit-held-worker.cjs')
  await writeFile(
    heldWorkerPath,
    `
const { parentPort } = require('node:worker_threads')
const original = parentPort.postMessage.bind(parentPort)
parentPort.postMessage = (message, ...args) => {
  if (message.result?.nativeRecovery) {
    original({ type: 'historyCommittedBeforeAck' })
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0)
    return
  }
  original(message, ...args)
}
require(${JSON.stringify(workerPath)})
`,
  )
})
afterAll(async () => {
  await rm(workerDirectory, { recursive: true, force: true })
})
beforeEach(async () => {
  stores = []
  directory = await mkdtemp(join(tmpdir(), 'life-writeahead-worker-'))
})
afterEach(async () => {
  await Promise.all(stores.map((value) => value.close()))
  vi.restoreAllMocks()
  await rm(directory, { recursive: true, force: true })
})

describe('cold actual worker private history proof', () => {
  it('recovers the exact native-prepared tail after killing the worker between history fsync and its ACK', async () => {
    let resolveCommit!: (worker: Worker) => void
    const committed = new Promise<Worker>((resolve) => {
      resolveCommit = resolve
    })
    const originalOn = Worker.prototype.on
    const observed = new WeakSet<Worker>()
    vi.spyOn(Worker.prototype, 'on').mockImplementation(function (this: Worker, event, listener) {
      if (!observed.has(this)) {
        observed.add(this)
        Reflect.apply(originalOn, this, [
          'message',
          (message: { type?: string }) => {
            if (message.type === 'historyCommittedBeforeAck') resolveCommit(this)
          },
        ])
      }
      return Reflect.apply(originalOn, this, [event, listener])
    })
    const prepared: ConversationRecoveryProof[] = []
    const onCommitted = vi.fn(() => Effect.void)
    const active = store(heldWorkerPath, {
      authorizeRecoveryReceipt: (proof) =>
        Effect.sync(() => {
          prepared.push(proof)
          return proof
        }),
      onCommitted,
    })
    const writing = active.save([thread()], 100)
    const failedWrite = expect(writing).rejects.toMatchObject({ operation: 'worker' })
    const worker = await committed
    const bytes = await readFile(join(directory, 'conversations.json'))
    expect(prepared).toHaveLength(1)
    expect(prepared[0].hash).toBe(createHash('sha256').update(bytes).digest('hex'))
    await worker.terminate()
    await failedWrite
    expect(onCommitted).not.toHaveBeenCalled()
    await active.close()
    const reopened = store()
    await expect(Effect.runPromise(reopened.loadRecoveryReceiptEffect())).resolves.toEqual(
      prepared[0],
    )
    expect((await reopened.load())?.threads).toEqual([thread()])
  })

  it('never mints private proof from imported future claims when the native ledger denies admission', async () => {
    const active = store(workerPath, { authorizeRecoveryReceipt: Effect.succeed })
    await active.save([thread()], 100)
    await active.close()
    const denied = store(workerPath, { authorizeRecoveryReceipt: () => Effect.succeed(null) })
    await denied.save([thread(999)], 200)
    await denied.close()
    const reopened = store()
    await expect(Effect.runPromise(reopened.loadRecoveryReceiptEffect())).resolves.toBeNull()
    expect((await reopened.load())?.threads).toEqual([thread(999)])
  })

  it('hashes the actual file after reopen and rejects a sidecar attached to externally altered archive bytes', async () => {
    const active = store(workerPath, { authorizeRecoveryReceipt: Effect.succeed })
    await active.save([thread()], 100)
    await active.close()
    const path = join(directory, 'conversations.json')
    const altered = {
      version: 1,
      savedAt: 100,
      threads: [{ ...thread(), messages: [null, 'external opaque import'] }],
    }
    await writeFile(path, JSON.stringify(altered))
    const reopened = store()
    await expect(Effect.runPromise(reopened.loadRecoveryReceiptEffect())).resolves.toBeNull()
    await expect(reopened.load()).resolves.toEqual(altered)
    expect(JSON.parse(await readFile(path, 'utf8'))).toEqual(altered)
  })

  it('keeps the encoded load contract unchanged and exposes only the current proof after a write races an earlier native byte load', async () => {
    const active = store(workerPath, { authorizeRecoveryReceipt: Effect.succeed })
    await active.save([thread()], 100)
    const olderBytes = await active.loadEncoded()
    expect(olderBytes).toBeInstanceOf(ArrayBuffer)
    const olderHash = createHash('sha256').update(new Uint8Array(olderBytes!)).digest('hex')
    const olderProof = await Effect.runPromise(active.loadRecoveryReceiptEffect())
    expect(olderProof?.hash).toBe(olderHash)
    await active.save([thread(2)], 200)
    const currentProof = await Effect.runPromise(active.loadRecoveryReceiptEffect())
    expect(currentProof?.hash).not.toBe(olderHash)
    expect(currentProof?.receipt.owners[0].nativeRecovery.transport.appliedRevision).toBe(2)
    const currentBytes = await active.loadEncoded()
    expect(currentBytes).toBeInstanceOf(ArrayBuffer)
    expect(createHash('sha256').update(new Uint8Array(currentBytes!)).digest('hex')).toBe(
      currentProof?.hash,
    )
    expect(JSON.parse(new TextDecoder().decode(olderBytes!)).savedAt).toBe(100)
    expect(JSON.parse(new TextDecoder().decode(currentBytes!)).savedAt).toBe(200)
  })

  it('fails preparation before mutating history when the private native ledger write fails', async () => {
    const onCommitted = vi.fn(() => Effect.void)
    const active = store(workerPath, {
      authorizeRecoveryReceipt: () => Effect.fail(new Error('native WAL unavailable')),
      onCommitted,
    })
    await expect(active.save([thread()], 100)).rejects.toMatchObject({
      operation: 'recovery-prepare',
    })
    expect(onCommitted).not.toHaveBeenCalled()
    await expect(readFile(join(directory, 'conversations.json'))).rejects.toMatchObject({
      code: 'ENOENT',
    })
    await expect(
      readFile(join(directory, 'conversations.recovery-receipts.json')),
    ).rejects.toMatchObject({ code: 'ENOENT' })
  })

  it('forwards private full-save and checkpoint projection admissions without persisting them in raw history or proof', async () => {
    const accepted: ConversationRecoveryProof[] = []
    const observed: (readonly ConversationProjectionAdmission[])[] = []
    const token = 'ephemeral-document-delivery-capability'
    const admission = (revision: number): ConversationProjectionAdmission => ({
      sessionId: thread().id,
      transportId: 'transport',
      appliedRevision: revision,
      snapshotToken: 'issued-token',
      ownerGeneration: 3,
      deliveryToken: token,
    })
    const active = store(workerPath, {
      authorizeRecoveryReceipt: (proof, metadata) =>
        Effect.sync(() => {
          observed.push(metadata)
          const claimed = proof.receipt.owners[0].nativeRecovery.transport
          if (
            metadata.length !== 1 ||
            JSON.stringify(metadata[0]) !== JSON.stringify(admission(claimed.appliedRevision))
          )
            return null
          accepted.push(proof)
          return proof
        }),
    })
    await active.save([thread()], 100, [admission(1)])
    const { messages, ...metadata } = thread(2)
    const ack = await active.saveCheckpoint({
      version: 1,
      baseSavedAt: 100,
      savedAt: 200,
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
                append: {
                  text: { baseLength: messages[0].text.length, value: 'native second delta' },
                },
              },
            ],
          },
        },
      ],
      projectionAdmissions: [admission(2)],
    })
    expect(observed).toEqual([[admission(1)], [admission(2)]])
    expect(accepted).toHaveLength(2)
    expect(ack.nativeRecoveryHash).toBe(accepted[1].hash)
    const raw = await readFile(join(directory, 'conversations.json'), 'utf8')
    const sidecar = await readFile(join(directory, 'conversations.recovery-receipts.json'), 'utf8')
    expect(raw).not.toContain(token)
    expect(sidecar).not.toContain(token)
    expect(raw).not.toContain('projectionAdmissions')
    expect(sidecar).not.toContain('projectionAdmissions')
    await active.close()
    await expect(Effect.runPromise(store().loadRecoveryReceiptEffect())).resolves.toEqual(
      accepted[1],
    )
  })

  it.each(['absent', 'wrong capability', 'wrong revision', 'beyond delivered revision'] as const)(
    'does not mint a private proof from copied raw owner claims with %s projection admission',
    async (failure) => {
      const active = store(workerPath, {
        authorizeRecoveryReceipt: (proof, metadata) =>
          Effect.sync(() => {
            const cursor = proof.receipt.owners[0].nativeRecovery.transport
            const admitted = metadata.find(
              (value) => value.sessionId === thread().id && value.transportId === 'transport',
            )
            return admitted?.deliveryToken === 'current-native-document-token' &&
              admitted.appliedRevision <= 1 &&
              admitted.appliedRevision === cursor.appliedRevision &&
              admitted.snapshotToken === cursor.snapshotToken &&
              admitted.ownerGeneration === cursor.ownerGeneration
              ? proof
              : null
          }),
      })
      const metadata: ConversationProjectionAdmission[] =
        failure === 'absent'
          ? []
          : [
              {
                sessionId: thread().id,
                transportId: 'transport',
                appliedRevision:
                  failure === 'beyond delivered revision'
                    ? 999
                    : failure === 'wrong revision'
                      ? 99
                      : 1,
                snapshotToken: 'issued-token',
                ownerGeneration: 3,
                deliveryToken:
                  failure === 'wrong capability'
                    ? 'exported-stale-token'
                    : 'current-native-document-token',
              },
            ]
      const raw = thread(failure === 'beyond delivered revision' ? 999 : 1)
      await active.save([raw], 100, metadata)
      await active.close()
      const cold = store()
      await expect(Effect.runPromise(cold.loadRecoveryReceiptEffect())).resolves.toBeNull()
      expect((await cold.load())?.threads).toEqual([raw])
    },
  )

  it('validates the small private admission envelope in the worker before preparation or history mutation', async () => {
    const authorizeRecoveryReceipt = vi.fn((proof: ConversationRecoveryProof) =>
      Effect.succeed(proof),
    )
    const active = store(workerPath, { authorizeRecoveryReceipt })
    await expect(
      Effect.runPromise(
        active.saveEffect([thread()], 100, [
          {
            sessionId: thread().id,
            transportId: 'transport',
            appliedRevision: 1.5,
            snapshotToken: 'issued-token',
            ownerGeneration: 3,
            deliveryToken: 'current-native-document-token',
          },
        ]),
      ),
    ).rejects.toMatchObject({ operation: 'recovery-admission' })
    expect(authorizeRecoveryReceipt).not.toHaveBeenCalled()
    await expect(readFile(join(directory, 'conversations.json'))).rejects.toMatchObject({
      code: 'ENOENT',
    })
  })
})
