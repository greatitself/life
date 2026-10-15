import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import * as fs from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Effect } from 'effect'
import { ConversationCheckpointEngine } from '../src/main/conversation-checkpoint-engine'
import { ConversationStore, type ConversationStoreOptions } from '../src/main/conversation-store'
import {
  ConversationCheckpointTransport,
  type CheckpointCommand,
  type CheckpointResult,
} from '../src/main/conversation-checkpoint-transport'
import { conversationRecoveryReceipt } from '../src/main/conversation-recovery-receipt'
import { runEffect } from '../src/main/effect-runtime'
import type { PersistenceError } from '../src/main/persistence-effects'
import type {
  ConversationCheckpointAck,
  ConversationCheckpointInput,
  ConversationHistorySnapshot,
} from '../src/shared/conversations'

vi.mock('node:fs/promises', async (original) => {
  const actual = await original<typeof import('node:fs/promises')>()
  return { ...actual, rename: vi.fn(actual.rename) }
})
const actualFs = await vi.importActual<typeof import('node:fs/promises')>('node:fs/promises')
let directory: string
let stores: ConversationStore[]

function cursor(appliedRevision = 1) {
  return { appliedRevision, snapshotToken: 'issued-token', ownerGeneration: 2 }
}

function thread(appliedRevision = 1) {
  return {
    id: 'local-session',
    profileId: 'machine',
    provider: 'codex' as const,
    workspace: '/exact workspace/漢字',
    remoteId: 'native-thread',
    nativeRecovery: { transport: cursor(appliedRevision) },
    messages: [{ id: 'message', role: 'assistant', text: 'Exact\r\n漢字 🧪  ' }],
    futureField: { opaque: true },
  }
}

function snapshot(threads: unknown[] = [thread()]): ConversationHistorySnapshot {
  return { version: 1, savedAt: 100, threads }
}

function checkpoint(savedAt: number, revision: number, suffix = ''): ConversationCheckpointInput {
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
              set: { nativeStatus: 'streaming' },
              remove: [],
              ...(suffix
                ? { append: { text: { baseLength: messages[0].text.length, value: suffix } } }
                : {}),
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

function createStore(options: Pick<ConversationStoreOptions, 'onCommitted'> = {}) {
  const engine = new ConversationCheckpointEngine(directory, {
    authorizeRecoveryReceipt: Effect.succeed,
  })
  const execute = Effect.fn('RecoveryReceiptTest.execute')((
    input: CheckpointCommand,
  ): Effect.Effect<CheckpointResult, PersistenceError> => {
    const command = structuredClone(input)
    switch (command.type) {
      case 'load':
        return engine.loadEffect()
      case 'loadEncoded':
        return engine.loadEncodedEffect()
      case 'loadRecoveryReceipt':
        return engine.loadRecoveryReceiptEffect()
      case 'save':
        return engine.saveEffect(command.threads, command.savedAt)
      case 'checkpoint':
        return engine.checkpointEffect(command.input)
    }
  })
  const store = new ConversationStore(directory, {
    ...options,
    transport: Effect.succeed(ConversationCheckpointTransport.of({ execute })),
  })
  stores.push(store)
  return store
}

beforeEach(async () => {
  stores = []
  vi.mocked(fs.rename).mockReset().mockImplementation(actualFs.rename)
  directory = await fs.mkdtemp(join(tmpdir(), 'life-recovery-receipt-'))
})
afterEach(async () => {
  await Promise.all(stores.map((store) => store.close()))
  await fs.rm(directory, { recursive: true, force: true })
})

describe('committed native history recovery receipts', () => {
  it('projects exact owner claims and unique commit identity without touching message data', () => {
    const record = thread()
    const messages = vi.fn(() => {
      throw new Error('receipt must not inspect messages')
    })
    const unrelated = vi.fn(() => {
      throw new Error('receipt must not inspect future fields')
    })
    Object.defineProperty(record, 'messages', { enumerable: true, get: messages })
    Object.defineProperty(record, 'futureField', { enumerable: true, get: unrelated })
    const first = conversationRecoveryReceipt(snapshot([record]))!
    const second = conversationRecoveryReceipt(snapshot([record]))!
    expect(first.owners).toEqual([
      {
        sessionId: record.id,
        provider: 'codex',
        profileId: record.profileId,
        workspace: record.workspace,
        remoteId: record.remoteId,
        nativeRecovery: record.nativeRecovery,
      },
    ])
    expect(first.snapshotId).toMatch(/^100:[0-9a-f-]{36}$/)
    expect(first.snapshotId).not.toBe(second.snapshotId)
    expect(messages).not.toHaveBeenCalled()
    expect(unrelated).not.toHaveBeenCalled()
  })

  it('suppresses every duplicate identity including an otherwise opaque conflicting row', () => {
    const unique = { ...thread(), id: 'unambiguous' }
    const result = conversationRecoveryReceipt(
      snapshot([thread(), { id: thread().id, future: 'opaque' }, unique, null, false, []]),
    )!
    expect(result.owners.map((owner) => owner.sessionId)).toEqual(['unambiguous'])
    expect(conversationRecoveryReceipt(snapshot([thread(), thread()]))).toBeUndefined()
  })

  it.each([
    ['empty id', { id: '' }],
    ['empty profile', { profileId: '' }],
    ['empty remote identity', { remoteId: '' }],
    ['relative workspace', { workspace: 'workspace' }],
    ['unknown workspace', { workspaceUnknown: true }],
    ['ambiguous workspace marker', { workspaceUnknown: 'false' }],
    ['unsupported provider', { provider: 'future-provider' }],
    [
      'missing token',
      { nativeRecovery: { transport: { appliedRevision: 1, ownerGeneration: 2 } } },
    ],
    [
      'missing generation',
      { nativeRecovery: { transport: { appliedRevision: 1, snapshotToken: 'x' } } },
    ],
    ['negative revision', { nativeRecovery: { transport: { ...cursor(), appliedRevision: -1 } } }],
    [
      'fractional revision',
      { nativeRecovery: { transport: { ...cursor(), appliedRevision: 1.2 } } },
    ],
    [
      'unsafe revision',
      { nativeRecovery: { transport: { ...cursor(), appliedRevision: 2 ** 53 } } },
    ],
    [
      'NaN revision',
      { nativeRecovery: { transport: { ...cursor(), appliedRevision: Number.NaN } } },
    ],
    [
      'infinite generation',
      { nativeRecovery: { transport: { ...cursor(), ownerGeneration: Infinity } } },
    ],
    ['array map', { nativeRecovery: [cursor()] }],
    ['empty transport identity', { nativeRecovery: { '': cursor() } }],
    ['partly invalid transport map', { nativeRecovery: { transport: cursor(), '': cursor() } }],
  ])('omits %s while preserving the raw record', (_name, change) => {
    const record = { ...thread(), ...change }
    const original = structuredClone(record)
    expect(conversationRecoveryReceipt(snapshot([record]))).toBeUndefined()
    expect(record).toEqual(original)
  })

  it('refuses inherited identity, accessors and accessor workspace markers without evaluating them', () => {
    const inherited = Object.assign(Object.create({ remoteId: 'native-thread' }), thread())
    delete inherited.remoteId
    const getter = vi.fn(() => 'native-thread')
    const accessor = thread()
    Object.defineProperty(accessor, 'remoteId', { get: getter, enumerable: true })
    const marker = thread()
    Object.defineProperty(marker, 'workspaceUnknown', { get: getter, enumerable: true })
    expect(conversationRecoveryReceipt(snapshot([inherited]))).toBeUndefined()
    expect(conversationRecoveryReceipt(snapshot([accessor]))).toBeUndefined()
    expect(conversationRecoveryReceipt(snapshot([marker]))).toBeUndefined()
    expect(getter).not.toHaveBeenCalled()
  })

  it('copies ordinary prototype-named transport keys without invoking toJSON', () => {
    const nativeRecovery = Object.fromEntries([
      ['__proto__', cursor(3)],
      ['constructor', cursor(4)],
    ])
    const toJSON = vi.fn(() => {
      throw new Error('receipt cannot serialize raw history')
    })
    const record = { ...thread(), nativeRecovery, toJSON }
    const receipt = conversationRecoveryReceipt(snapshot([record]))!
    expect(Object.keys(receipt.owners[0].nativeRecovery)).toEqual(['__proto__', 'constructor'])
    expect(Object.hasOwn(receipt.owners[0].nativeRecovery, '__proto__')).toBe(true)
    expect(receipt.owners[0].nativeRecovery.__proto__).toEqual(cursor(3))
    expect(toJSON).not.toHaveBeenCalled()
  })

  it('takes full-save receipts from actual serialized worker data and preserves opaque messages', async () => {
    const engine = new ConversationCheckpointEngine(directory, {
      authorizeRecoveryReceipt: Effect.succeed,
    })
    const record = {
      ...thread(999),
      messages: [null, 'future opaque record', { id: 'same' }, { id: 'same', unknown: true }],
      nativeRecovery: {
        transport: cursor(999),
        toJSON: () => ({ transport: cursor(7) }),
      },
    }
    const ack = await runEffect(engine.saveEffect([record], 100))
    expect(ack.nativeRecovery?.owners[0].nativeRecovery).toEqual({ transport: cursor(7) })
    const saved = JSON.parse(await fs.readFile(join(directory, 'conversations.json'), 'utf8'))
    expect(saved.threads[0]).toEqual({ ...record, nativeRecovery: { transport: cursor(7) } })
    expect((await runEffect(engine.loadEffect()))?.threads).toEqual(saved.threads)
  })

  it('reports all actual retained owners after a compact field/append checkpoint', async () => {
    const engine = new ConversationCheckpointEngine(directory, {
      authorizeRecoveryReceipt: Effect.succeed,
    })
    const untouched = { ...thread(4), id: 'untouched' }
    await runEffect(engine.saveEffect([thread(), untouched], 100))
    const input = checkpoint(200, 8, '\r\n  Exact suffix 🧪')
    input.order.push(untouched.id)
    const ack = await runEffect(engine.checkpointEffect(input))
    expect(
      ack.nativeRecovery?.owners.map((owner) => [owner.sessionId, owner.nativeRecovery]),
    ).toEqual([
      ['local-session', { transport: cursor(8) }],
      ['untouched', { transport: cursor(4) }],
    ])
    const saved = await runEffect(engine.loadEffect())
    expect(saved?.threads[0]).toEqual({
      ...thread(8),
      messages: [
        {
          ...thread().messages[0],
          text: thread().messages[0].text + '\r\n  Exact suffix 🧪',
          nativeStatus: 'streaming',
        },
      ],
    })
    expect(saved?.threads[1]).toEqual(untouched)
  })

  it('acknowledges only actual committed coalesced writes and gives queued callers the newest exact receipt', async () => {
    const acknowledgements: ConversationCheckpointAck[] = []
    const store = createStore({
      onCommitted: (ack) =>
        Effect.sync(() => {
          acknowledgements.push(ack)
        }),
    })
    const started = deferred()
    const release = deferred()
    vi.mocked(fs.rename).mockImplementationOnce(async (...args) => {
      started.resolve()
      await release.promise
      return actualFs.rename(...args)
    })
    const active = store.save([thread()], 100)
    await started.promise
    const superseded = store.saveCheckpoint(checkpoint(200, 2, 'superseded'))
    const newest = store.saveCheckpoint(checkpoint(300, 3, 'newest'))
    release.resolve()
    const [voidResult, olderAck, newestAck] = await Promise.all([active, superseded, newest])
    expect(voidResult).toBeUndefined()
    expect(olderAck).toEqual(newestAck)
    expect(olderAck.savedAt).toBe(300)
    expect(olderAck.nativeRecovery?.owners[0].nativeRecovery.transport).toEqual(cursor(3))
    expect(acknowledgements).toEqual([expect.objectContaining({ savedAt: 100 }), newestAck])
    expect(vi.mocked(fs.rename)).toHaveBeenCalledTimes(4)
    expect((await store.load())?.threads).toEqual([
      {
        ...thread(3),
        messages: [
          {
            ...thread().messages[0],
            text: thread().messages[0].text + 'newest',
            nativeStatus: 'streaming',
          },
        ],
      },
    ])
  })

  it('never invokes onCommitted after a rejected or failed worker write', async () => {
    const onCommitted = vi.fn(() => Effect.void)
    const store = createStore({ onCommitted })
    await store.save([thread()], 100)
    onCommitted.mockClear()
    const invalid = checkpoint(200, 2, 'not committed')
    invalid.upserts[0].messages = {
      mode: 'patch',
      upserts: [],
      fields: [
        { id: 'message', set: {}, remove: [], append: { text: { baseLength: 0, value: 'bad' } } },
      ],
    }
    await expect(store.saveCheckpoint(invalid)).rejects.toMatchObject({ operation: 'base' })
    vi.mocked(fs.rename).mockRejectedValueOnce(
      Object.assign(new Error('disk full'), { code: 'ENOSPC' }),
    )
    await expect(store.saveCheckpoint(checkpoint(200, 2))).rejects.toMatchObject({
      operation: 'rename',
    })
    expect(onCommitted).not.toHaveBeenCalled()
    expect((await store.load())?.savedAt).toBe(100)
    const recovered = await store.saveCheckpoint(checkpoint(300, 3))
    expect(onCommitted).toHaveBeenCalledExactlyOnceWith(recovered)
  })

  it.each(['typed failure', 'effect defect', 'callback throw'] as const)(
    'keeps durable history and its next base usable after onCommitted %s',
    async (failure) => {
      const attempts: number[] = []
      const store = createStore({
        onCommitted: (ack) => {
          attempts.push(ack.savedAt)
          if (attempts.length === 1) {
            if (failure === 'typed failure') return Effect.fail(new Error('ledger unavailable'))
            if (failure === 'effect defect') return Effect.die(new Error('ledger defect'))
            throw new Error('callback defect')
          }
          return Effect.void
        },
      })
      await expect(store.save([thread()], 100)).resolves.toBeUndefined()
      await expect(store.saveCheckpoint(checkpoint(200, 2))).resolves.toMatchObject({
        savedAt: 200,
      })
      expect(attempts).toEqual([100, 200])
      expect((await store.load())?.savedAt).toBe(200)
      expect(vi.mocked(fs.rename)).toHaveBeenCalledTimes(4)
    },
  )

  it('waits for the private native acknowledgment before resolving durable subscribers', async () => {
    const started = deferred()
    const release = deferred()
    const store = createStore({
      onCommitted: () =>
        Effect.promise(async () => {
          started.resolve()
          await release.promise
        }),
    })
    let resolved = false
    const saving = store.save([thread()], 100).then(() => {
      resolved = true
    })
    await started.promise
    expect(resolved).toBe(false)
    expect(
      JSON.parse(await fs.readFile(join(directory, 'conversations.json'), 'utf8')).savedAt,
    ).toBe(100)
    release.resolve()
    await saving
    expect(resolved).toBe(true)
  })
})
