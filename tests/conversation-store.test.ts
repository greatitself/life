import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import * as fs from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { ConversationStore } from '../src/main/conversation-store'
import { ConversationCheckpointEngine } from '../src/main/conversation-checkpoint-engine'
import {
  ConversationCheckpointTransport,
  type CheckpointCommand,
  type CheckpointResult,
} from '../src/main/conversation-checkpoint-transport'
import type { PersistenceError } from '../src/main/persistence-effects'
import { Effect } from 'effect'
import { runEffect } from '../src/main/effect-runtime'
import {
  CONVERSATION_CHECKPOINT_BASE_CHANGED,
  type ConversationCheckpointInput,
} from '../src/shared/conversations'

vi.mock('node:fs/promises', async (original) => {
  const actual = await original<typeof import('node:fs/promises')>()
  return { ...actual, readFile: vi.fn(actual.readFile), rename: vi.fn(actual.rename) }
})
const original = await vi.importActual<typeof import('node:fs/promises')>('node:fs/promises')
let directory: string
let stores: ConversationStore[]

function createStore() {
  const engine = new ConversationCheckpointEngine(directory)
  const execute = Effect.fn('TestCheckpointTransport.execute')((
    input: CheckpointCommand,
  ): Effect.Effect<CheckpointResult, PersistenceError> => {
    const command = structuredClone(input)
    switch (command.type) {
      case 'load':
        return engine.loadEffect().pipe(Effect.map((value) => structuredClone(value)))
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
    transport: Effect.succeed(ConversationCheckpointTransport.of({ execute })),
  })
  stores.push(store)
  return store
}

function thread(text = 'Exact transcript\n  preserved  \n') {
  return {
    id: 'thread',
    profileId: 'machine',
    provider: 'codex',
    messages: [{ id: 'message', role: 'assistant', text, turn: 1 }],
    customFutureField: { retained: true },
  }
}
function deferred() {
  let resolve!: () => void
  const promise = new Promise<void>((done) => (resolve = done))
  return { promise, resolve }
}

beforeEach(async () => {
  stores = []
  vi.mocked(fs.readFile).mockImplementation(original.readFile)
  vi.mocked(fs.rename).mockImplementation(original.rename)
  directory = await fs.mkdtemp(join(tmpdir(), 'life-conversation-store-'))
  vi.clearAllMocks()
})
afterEach(async () => {
  await Promise.all(stores.map((store) => store.close()))
  await fs.rm(directory, { recursive: true, force: true })
})

describe('durable conversation checkpoints', () => {
  function checkpoint(
    baseSavedAt: number | null,
    savedAt: number,
    text: string,
  ): ConversationCheckpointInput {
    const { messages: _, ...metadata } = thread()
    return {
      version: 1,
      baseSavedAt,
      savedAt,
      order: ['thread'],
      upserts: [
        {
          thread: { ...metadata, provider: 'codex' },
          messages: {
            mode: 'patch',
            upserts: [{ id: 'message', role: 'assistant', text, turn: 1 }],
          },
        },
      ],
    }
  }

  it('applies exact message patches and metadata field removal without transferring unchanged messages', async () => {
    const store = createStore()
    const first = thread()
    first.messages.push({ id: 'other', role: 'user', text: 'Exact  untouched\n  text', turn: 2 })
    await store.save([first], 100)
    const input = checkpoint(100, 200, 'Exact  changed\n  text')
    delete input.upserts[0].thread.customFutureField
    await expect(store.saveCheckpoint(input)).resolves.toEqual({ savedAt: 200 })
    const saved = (await store.load())!.threads[0] as ReturnType<typeof thread>
    expect(saved.messages).toEqual([
      { id: 'message', role: 'assistant', text: 'Exact  changed\n  text', turn: 1 },
      first.messages[1],
    ])
    expect(saved).not.toHaveProperty('customFutureField')
    expect((await createStore().load())?.threads).toEqual([saved])
  })

  it('uses complete membership and ordering for thread and message append, reorder and deletion', async () => {
    const store = createStore()
    const first = thread()
    first.messages.push({ id: 'other', role: 'user', text: 'Second', turn: 2 })
    await store.save([first, { ...thread('deleted'), id: 'deleted' }], 100)
    const input = checkpoint(100, 200, 'changed')
    input.order = ['new', 'thread']
    input.upserts[0].messages = {
      mode: 'patch',
      order: ['added', 'other'],
      upserts: [{ id: 'added', text: 'New  exact\n', futureMessageField: { present: true } }],
    }
    input.upserts.push({
      thread: {
        id: 'new',
        profileId: 'other-machine',
        provider: 'claude',
        sessionId: 'native-session',
      },
      messages: { mode: 'replace', values: [null, 'opaque future message'] },
    })
    await store.saveCheckpoint(input)
    const saved = await store.load()
    expect(saved?.threads).toEqual([
      {
        id: 'new',
        profileId: 'other-machine',
        provider: 'claude',
        sessionId: 'native-session',
        messages: [null, 'opaque future message'],
      },
      {
        ...thread(),
        messages: [
          { id: 'added', text: 'New  exact\n', futureMessageField: { present: true } },
          first.messages[1],
        ],
      },
    ])
    await store.saveCheckpoint({
      version: 1,
      baseSavedAt: 200,
      savedAt: 300,
      order: [],
      upserts: [],
    })
    expect((await createStore().load())?.threads).toEqual([])
  })

  it('never advances the accepted base after failed writes and reports stale bases with a stable marker', async () => {
    const store = createStore()
    await store.save([thread()], 100)
    await expect(store.saveCheckpoint(checkpoint(99, 200, 'stale'))).rejects.toMatchObject({
      operation: 'base',
      message: CONVERSATION_CHECKPOINT_BASE_CHANGED,
    })
    await expect(store.saveCheckpoint(checkpoint(100, 100, 'same revision'))).rejects.toMatchObject(
      { operation: 'revision' },
    )
    vi.mocked(fs.rename).mockRejectedValueOnce(
      Object.assign(new Error('disk full'), { code: 'ENOSPC' }),
    )
    await expect(store.saveCheckpoint(checkpoint(100, 200, 'failed'))).rejects.toMatchObject({
      operation: 'rename',
    })
    expect((await store.load())?.savedAt).toBe(100)
    await expect(
      store.saveCheckpoint(checkpoint(200, 300, 'unacknowledged base')),
    ).rejects.toMatchObject({ operation: 'base' })
    await expect(store.saveCheckpoint(checkpoint(100, 300, 'recovered'))).resolves.toEqual({
      savedAt: 300,
    })
    expect((await createStore().load())?.threads).toEqual([thread('recovered')])
  })

  it('requires full message replacement for provider or workspace identity changes', async () => {
    const store = createStore()
    await store.save([thread()], 100)
    const input = checkpoint(100, 200, 'moved')
    input.upserts[0].thread.profileId = 'new-machine'
    input.upserts[0].thread.provider = 'claude'
    await expect(store.saveCheckpoint(input)).rejects.toMatchObject({ operation: 'identity' })
    input.upserts[0].messages = {
      mode: 'replace',
      values: thread('native restored session').messages,
    }
    await store.saveCheckpoint(input)
    expect((await store.load())?.threads).toEqual([
      { ...thread('native restored session'), profileId: 'new-machine', provider: 'claude' },
    ])
  })

  it('rejects ambiguous patch identities and absent members while preserving legacy full snapshots', async () => {
    const store = createStore()
    const legacy = [
      { ...thread(), id: '' },
      { ...thread(), id: '' },
    ]
    await store.save(legacy, 100)
    expect((await store.load())?.threads).toEqual(legacy)
    await expect(
      store.saveCheckpoint({ version: 1, baseSavedAt: 100, savedAt: 200, order: [], upserts: [] }),
    ).rejects.toMatchObject({ operation: 'identity' })
    await store.save([{ ...thread(), messages: [{ id: 'same' }, { id: 'same' }] }], 200)
    await expect(store.saveCheckpoint(checkpoint(200, 300, 'duplicated'))).rejects.toMatchObject({
      operation: 'identity',
    })
    await store.save([{ ...thread(), messages: ['future opaque message'] }], 300)
    await expect(store.saveCheckpoint(checkpoint(300, 400, 'unsupported'))).rejects.toMatchObject({
      operation: 'identity',
    })
    await store.save([thread()], 400)
    const missing = checkpoint(400, 500, 'changed')
    missing.upserts[0].messages = { mode: 'patch', order: ['missing'], upserts: [] }
    await expect(store.saveCheckpoint(missing)).rejects.toMatchObject({ operation: 'base' })
    const invalid = checkpoint(400, 500, 'changed')
    invalid.order = ['thread', 'thread']
    await expect(store.saveCheckpoint(invalid)).rejects.toMatchObject({ operation: 'validate' })
    const duplicate = checkpoint(400, 500, 'changed')
    duplicate.upserts[0].messages = {
      mode: 'patch',
      upserts: [{ id: 'message' }, { id: 'message' }],
    }
    await expect(store.saveCheckpoint(duplicate)).rejects.toMatchObject({ operation: 'validate' })
    expect((await store.load())?.threads).toEqual([thread()])
  })

  it('coalesces complete same-base deltas and acknowledges the actual durable revision', async () => {
    const store = createStore()
    await store.save([thread()], 100)
    const started = deferred()
    const release = deferred()
    vi.mocked(fs.rename).mockImplementationOnce(async (...args) => {
      started.resolve()
      await release.promise
      return original.rename(...args)
    })
    const first = store.saveCheckpoint(checkpoint(100, 200, 'active'))
    await started.promise
    const middle = store.saveCheckpoint(checkpoint(200, 300, 'middle'))
    const newest = store.saveCheckpoint(checkpoint(200, 400, 'newest'))
    await expect(store.saveCheckpoint(checkpoint(300, 500, 'incompatible'))).rejects.toMatchObject({
      operation: 'queue',
    })
    release.resolve()
    await expect(first).resolves.toEqual({ savedAt: 200 })
    await expect(middle).resolves.toEqual({ savedAt: 400 })
    await expect(newest).resolves.toEqual({ savedAt: 400 })
    expect((await store.load())?.threads).toEqual([thread('newest')])
    expect(fs.rename).toHaveBeenCalledTimes(3)
  })

  it('drains a checkpoint accepted before close and rejects new work after close', async () => {
    const store = createStore()
    const save = store.save([thread('accepted before close')], 100)
    const close = store.close()
    await Promise.all([save, close, store.close()])
    expect((await createStore().load())?.threads).toEqual([thread('accepted before close')])
    await expect(store.save([thread('too late')], 200)).rejects.toMatchObject({
      operation: 'closed',
    })
    await expect(store.load()).rejects.toMatchObject({ operation: 'closed' })
    await expect(store.loadEncoded()).rejects.toMatchObject({ operation: 'closed' })
  })

  it('waits for accepted writes before encoded reads and detaches interrupted readers', async () => {
    const store = createStore()
    const started = deferred()
    const release = deferred()
    vi.mocked(fs.rename).mockImplementationOnce(async (...args) => {
      started.resolve()
      await release.promise
      return original.rename(...args)
    })
    const first = store.save([thread('first')], 100)
    await started.promise
    const newest = store.save([thread('Exact\r\nnewest 漢字 🧪')], 200)
    const controller = new AbortController()
    const interrupted = runEffect(store.loadEncodedEffect(), { signal: controller.signal })
    controller.abort()
    await expect(interrupted).rejects.toBeInstanceOf(Error)
    const loading = store.loadEncoded()
    release.resolve()
    await Promise.all([first, newest, store.settled()])
    const expected = { version: 1, savedAt: 200, threads: [thread('Exact\r\nnewest 漢字 🧪')] }
    expect(JSON.parse(new TextDecoder().decode((await loading)!))).toEqual(expected)
    await expect(store.load()).resolves.toEqual(expected)
  })

  it('keeps encoded bytes at the acknowledged revision after write failures and replaces them after successful commits', async () => {
    const store = createStore()
    const originalSnapshot = { version: 1, savedAt: 100, threads: [thread('Exact\r\nold 🧪')] }
    await store.save(originalSnapshot.threads, originalSnapshot.savedAt)
    const initial = (await store.loadEncoded())!
    const detached = structuredClone(initial, { transfer: [initial] })
    expect(initial.byteLength).toBe(0)
    vi.mocked(fs.rename).mockRejectedValueOnce(
      Object.assign(new Error('disk full'), { code: 'ENOSPC' }),
    )
    await expect(store.save([thread('unacknowledged')], 200)).rejects.toMatchObject({
      operation: 'rename',
    })
    expect(JSON.parse(new TextDecoder().decode((await store.loadEncoded())!))).toEqual(
      originalSnapshot,
    )
    await store.saveCheckpoint(checkpoint(100, 300, 'Exact\r\nnew 🧪'))
    const current = { version: 1, savedAt: 300, threads: [thread('Exact\r\nnew 🧪')] }
    expect(JSON.parse(new TextDecoder().decode((await store.loadEncoded())!))).toEqual(current)
    expect(JSON.parse(new TextDecoder().decode(detached))).toEqual(originalSnapshot)
    await store.save([], 400)
    expect(JSON.parse(new TextDecoder().decode((await store.loadEncoded())!))).toEqual({
      version: 1,
      savedAt: 400,
      threads: [],
    })
  })

  it('uses the native Effect API without removing optional fields or poisoning recovery after a write failure', async () => {
    const store = createStore()
    await runEffect(store.saveEffect([thread()], 100))
    expect(await runEffect(store.loadEffect())).toEqual({
      version: 1,
      savedAt: 100,
      threads: [thread()],
    })
    vi.mocked(fs.rename).mockRejectedValueOnce(
      Object.assign(new Error('disk full'), { code: 'ENOSPC' }),
    )
    await expect(runEffect(store.saveEffect([thread('failed')], 200))).rejects.toMatchObject({
      _tag: 'PersistenceError',
      operation: 'rename',
      message: 'disk full',
      cause: { code: 'ENOSPC' },
    })
    await runEffect(store.settledEffect())
    expect((await runEffect(store.loadEffect()))?.threads).toEqual([thread()])
    await runEffect(store.saveEffect([thread('recovered')], 300))
    expect((await createStore().load())?.threads).toEqual([thread('recovered')])
  })

  it('distinguishes a missing store from an intentional empty history', async () => {
    const store = createStore()
    await expect(store.load()).resolves.toBeNull()
    await store.save([], 100)
    await expect(createStore().load()).resolves.toEqual({
      version: 1,
      savedAt: 100,
      threads: [],
    })
  })

  it('retains exact content and optional fields across a restart with private file permissions', async () => {
    const store = createStore()
    const threads = [thread()]
    await store.save(threads, 200)
    threads[0].messages[0].text = 'mutated after request'
    const reloaded = await createStore().load()
    expect(reloaded).toEqual({ version: 1, savedAt: 200, threads: [thread()] })
    reloaded!.threads.length = 0
    expect((await store.load())?.threads).toEqual([thread()])
    if (process.platform !== 'win32')
      expect((await fs.stat(join(directory, 'conversations.json'))).mode & 0o777).toBe(0o600)
    expect(await fs.readdir(directory)).toEqual(['conversations.json'])
  })

  it('coalesces a hundred queued streaming snapshots while retaining ordering at the active commit', async () => {
    const store = createStore()
    const started = deferred()
    const release = deferred()
    vi.mocked(fs.rename).mockImplementationOnce(async (...args) => {
      started.resolve()
      await release.promise
      return original.rename(...args)
    })
    const first = store.save([thread('first')], 1)
    await started.promise
    const queued = Array.from({ length: 100 }, (_, index) =>
      store.save([thread(`snapshot-${index}`)], index + 2),
    )
    let settled = false
    const barrier = store.settled().then(() => (settled = true))
    const loading = store.load()
    expect(settled).toBe(false)
    release.resolve()
    await Promise.all([first, ...queued, barrier])
    expect(fs.rename).toHaveBeenCalledTimes(2)
    expect((await loading)?.threads).toEqual([thread('snapshot-99')])
    expect((await createStore().load())?.savedAt).toBe(101)
  })

  it('detaches interrupted native callers while committing accepted checkpoints and acknowledging coalesced saves', async () => {
    const store = createStore()
    const started = deferred()
    const release = deferred()
    const committed: unknown[] = []
    vi.mocked(fs.rename).mockImplementation(async (...args) => {
      if (committed.length === 0) {
        started.resolve()
        await release.promise
      }
      await original.rename(...args)
      committed.push(JSON.parse(await fs.readFile(join(directory, 'conversations.json'), 'utf8')))
    })
    const pending = () =>
      (
        store as unknown as {
          pending?: { subscribers: Set<unknown> }
        }
      ).pending!
    const activeController = new AbortController()
    const active = runEffect(store.saveEffect([thread('accepted')], 1), {
      signal: activeController.signal,
    })
    const activeCheckpoint = pending()
    await started.promise
    const queuedController = new AbortController()
    const queued = runEffect(store.saveEffect([thread('interrupted')], 2), {
      signal: queuedController.signal,
    })
    const queuedCheckpoint = pending()
    expect(activeCheckpoint.subscribers.size).toBe(1)
    expect(queuedCheckpoint.subscribers.size).toBe(1)
    activeController.abort()
    queuedController.abort()
    await Promise.all([
      expect(active).rejects.toBeInstanceOf(Error),
      expect(queued).rejects.toBeInstanceOf(Error),
    ])
    expect(activeCheckpoint.subscribers.size).toBe(0)
    expect(queuedCheckpoint.subscribers.size).toBe(0)
    const healthy = store.save([thread('healthy')], 3)
    const newest = runEffect(store.saveEffect([thread('newest')], 4))
    expect(queuedCheckpoint.subscribers.size).toBe(2)
    release.resolve()
    await Promise.all([healthy, newest, store.settled()])
    expect(committed).toEqual([
      { version: 1, savedAt: 1, threads: [thread('accepted')] },
      { version: 1, savedAt: 4, threads: [thread('newest')] },
    ])
    expect(queuedCheckpoint.subscribers.size).toBe(0)
    expect(pending()).toBeUndefined()
    expect((await createStore().load())?.threads).toEqual([thread('newest')])
  })

  it('reports a failed atomic replacement, retains the committed snapshot and permits a later save', async () => {
    const store = createStore()
    await store.save([thread('committed')], 100)
    vi.mocked(fs.rename).mockRejectedValueOnce(
      Object.assign(new Error('disk full'), { code: 'ENOSPC' }),
    )
    await expect(store.save([thread('failed')], 200)).rejects.toThrow('disk full')
    await expect(store.settled()).resolves.toBeUndefined()
    expect((await store.load())?.threads).toEqual([thread('committed')])
    expect((await createStore().load())?.threads).toEqual([thread('committed')])
    expect(await fs.readdir(directory)).toEqual(['conversations.json'])
    await store.save([thread('recovered')], 300)
    expect((await createStore().load())?.threads).toEqual([thread('recovered')])
  })

  it('retries a transient initialization failure without overwriting the existing history', async () => {
    const path = join(directory, 'conversations.json')
    await fs.writeFile(path, JSON.stringify({ version: 1, savedAt: 100, threads: [thread()] }))
    vi.mocked(fs.readFile).mockRejectedValueOnce(
      Object.assign(new Error('temporarily unavailable'), { code: 'EIO' }),
    )
    const store = createStore()
    await expect(store.load()).rejects.toThrow('temporarily unavailable')
    await expect(store.load()).resolves.toEqual({ version: 1, savedAt: 100, threads: [thread()] })
    await store.save([thread('recovered')], 200)
    expect((await createStore().load())?.threads).toEqual([thread('recovered')])
  })

  it('preserves a corrupt original instead of replacing it with an empty renderer cache', async () => {
    const path = join(directory, 'conversations.json')
    await fs.writeFile(path, '{ original damaged history')
    const store = createStore()
    await expect(store.load()).rejects.toThrow()
    await expect(store.save([], 100)).rejects.toThrow()
    expect(await fs.readFile(path, 'utf8')).toBe('{ original damaged history')
    expect(fs.rename).not.toHaveBeenCalled()
  })

  it('accepts prior array-only snapshots and rejects invalid history without modifying the original', async () => {
    const path = join(directory, 'conversations.json')
    await fs.writeFile(path, JSON.stringify([thread()]))
    const store = createStore()
    expect(await store.load()).toEqual({ version: 1, savedAt: 0, threads: [thread()] })
    await expect(store.save([{}], 100)).rejects.toThrow('invalid thread')
    await expect(store.save([], -1)).rejects.toThrow('invalid timestamp')
    expect(JSON.parse(await fs.readFile(path, 'utf8'))).toEqual([thread()])
  })
})
