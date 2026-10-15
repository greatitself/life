import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { build } from 'esbuild'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { Worker } from 'node:worker_threads'
import { Effect } from 'effect'
import { ConversationStore } from '../src/main/conversation-store'
import type { CheckpointRequest } from '../src/main/conversation-checkpoint-transport'
import type {
  ConversationCheckpointAck,
  ConversationCheckpointInput,
} from '../src/shared/conversations'

let workerDirectory: string
let workerPath: string
let directory: string
let stores: ConversationStore[]

function thread(revision = 1) {
  return {
    id: 'local-session',
    provider: 'claude' as const,
    profileId: 'machine',
    workspace: '/exact workspace/漢字',
    remoteId: 'native-session',
    nativeRecovery: {
      transport: { appliedRevision: revision, snapshotToken: 'issued-token', ownerGeneration: 4 },
    },
    futureThread: ['opaque', null],
    messages: [{ id: 'message', role: 'assistant', text: 'Exact\r\n🧪  ' }],
  }
}

function checkpoint(
  savedAt: number,
  revision: number,
  suffix: string,
): ConversationCheckpointInput {
  const { messages, ...metadata } = thread(revision)
  return {
    version: 1,
    baseSavedAt: 100,
    savedAt,
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
              set: { futureMessage: { exact: true } },
              remove: [],
              append: { text: { baseLength: messages[0].text.length, value: suffix } },
            },
          ],
        },
      },
    ],
  }
}

function deferred() {
  let resolve!: () => void
  const promise = new Promise<void>((done) => (resolve = done))
  return { promise, resolve }
}

beforeAll(async () => {
  workerDirectory = await mkdtemp(join(tmpdir(), 'life-recovery-receipt-worker-build-'))
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
  await rm(workerDirectory, { recursive: true, force: true })
})
beforeEach(async () => {
  stores = []
  directory = await mkdtemp(join(tmpdir(), 'life-recovery-receipt-worker-'))
})
afterEach(async () => {
  await Promise.all(stores.map((store) => store.close()))
  vi.restoreAllMocks()
  await rm(directory, { recursive: true, force: true })
})

describe('actual history worker native recovery receipts', () => {
  it('delivers one exact post-commit receipt per actual write across coalesced callers and structured cloning', async () => {
    const acknowledgements: ConversationCheckpointAck[] = []
    const posted: CheckpointRequest[] = []
    const originalPost = Worker.prototype.postMessage
    vi.spyOn(Worker.prototype, 'postMessage').mockImplementation(function (
      this: Worker,
      value,
      ...args
    ) {
      if (value?.command) posted.push(value)
      return Reflect.apply(originalPost, this, [value, ...args])
    })
    const firstCommitted = deferred()
    const release = deferred()
    const store = new ConversationStore(directory, {
      workerPath,
      authorizeRecoveryReceipt: Effect.succeed,
      onCommitted: (ack) =>
        Effect.gen(function* () {
          acknowledgements.push(ack)
          if (ack.savedAt === 100) {
            firstCommitted.resolve()
            yield* Effect.promise(() => release.promise)
          }
        }),
    })
    stores.push(store)
    const active = store.save([thread()], 100)
    await firstCommitted.promise
    const superseded = store.saveCheckpoint(checkpoint(200, 2, 'superseded'))
    const newest = store.saveCheckpoint(checkpoint(300, 3, '\r\nnewest 漢字'))
    release.resolve()
    const [, oldAck, latestAck] = await Promise.all([active, superseded, newest])
    expect(oldAck).toEqual(latestAck)
    expect(latestAck.nativeRecovery?.snapshotId).toMatch(/^300:[0-9a-f-]{36}$/)
    expect(latestAck.nativeRecovery?.owners).toEqual([
      {
        sessionId: thread().id,
        provider: 'claude',
        profileId: thread().profileId,
        workspace: thread().workspace,
        remoteId: thread().remoteId,
        nativeRecovery: thread(3).nativeRecovery,
      },
    ])
    expect(acknowledgements.map((ack) => ack.savedAt)).toEqual([100, 300])
    expect(posted.map(({ command }) => command.type)).toEqual(['save', 'checkpoint'])
    const saved = JSON.parse(await readFile(join(directory, 'conversations.json'), 'utf8'))
    expect(saved.threads).toEqual([
      {
        ...thread(3),
        messages: [
          {
            ...thread().messages[0],
            text: thread().messages[0].text + '\r\nnewest 漢字',
            futureMessage: { exact: true },
          },
        ],
      },
    ])
  })

  it('preserves opaque and ambiguous full history but grants no receipt to duplicate owners', async () => {
    const acknowledgements: ConversationCheckpointAck[] = []
    const store = new ConversationStore(directory, {
      workerPath,
      authorizeRecoveryReceipt: Effect.succeed,
      onCommitted: (ack) =>
        Effect.sync(() => {
          acknowledgements.push(ack)
        }),
    })
    stores.push(store)
    const record = {
      ...thread(),
      messages: [null, 'future message', { id: 'same' }, { id: 'same' }],
    }
    const duplicate = { ...record, futureThread: { exact: true } }
    await store.save([record, duplicate], 100)
    expect(acknowledgements).toEqual([{ savedAt: 100 }])
    expect((await store.load())?.threads).toEqual([record, duplicate])
  })

  it('does not acknowledge a worker-rejected append and permits retry against the unchanged committed base', async () => {
    const acknowledgements: ConversationCheckpointAck[] = []
    const store = new ConversationStore(directory, {
      workerPath,
      authorizeRecoveryReceipt: Effect.succeed,
      onCommitted: (ack) =>
        Effect.sync(() => {
          acknowledgements.push(ack)
        }),
    })
    stores.push(store)
    await store.save([thread()], 100)
    const invalid = checkpoint(200, 2, 'rejected')
    if (invalid.upserts[0].messages.mode === 'patch')
      invalid.upserts[0].messages.fields![0].append!.text.baseLength = 0
    await expect(store.saveCheckpoint(invalid)).rejects.toMatchObject({ operation: 'base' })
    expect(acknowledgements.map((ack) => ack.savedAt)).toEqual([100])
    expect((await store.load())?.threads).toEqual([thread()])
    const accepted = await store.saveCheckpoint(checkpoint(300, 3, 'accepted'))
    expect(acknowledgements).toEqual([expect.objectContaining({ savedAt: 100 }), accepted])
    expect(accepted.nativeRecovery?.owners[0].nativeRecovery.transport.appliedRevision).toBe(3)
  })
})
