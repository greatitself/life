import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { ConversationHistorySnapshot } from '../src/shared/conversations'
import type { ConversationLoadPacket } from '../src/renderer/conversation-load-protocol'

const nativeWorker = vi.hoisted(() => ({ create: undefined as (() => Worker) | undefined }))
vi.mock('../src/renderer/conversation-load-worker?worker&inline', () => ({
  default: class {
    constructor() {
      return nativeWorker.create!()
    }
  },
}))

import {
  decodeConversationHistory,
  loadConversationHistory,
} from '../src/renderer/conversation-load'
import {
  getNativeConversationLoad,
  getNativeConversationRowLoad,
} from '../src/renderer/conversation-load-provenance'
import { normalizedConversationThreads } from '../src/renderer/conversation-load-protocol'
import {
  getConversationSourceRaw,
  projectConversationSourceHistory,
} from '../src/renderer/conversation-source'
import { readThreads, type Thread } from '../src/renderer/state'

function fakeWorker() {
  const worker = {
    onmessage: null as Worker['onmessage'],
    onerror: null as Worker['onerror'],
    onmessageerror: null as Worker['onmessageerror'],
    postMessage: vi.fn(),
    terminate: vi.fn(),
  }
  return {
    worker,
    create: () => worker as unknown as Worker,
    emit: (data: ConversationLoadPacket) =>
      worker.onmessage?.call(worker as unknown as Worker, { data } as MessageEvent),
  }
}

const hash = '1a'.repeat(32)
const buffer = () => new TextEncoder().encode('{"version":1,"savedAt":10,"threads":[]}').buffer
const rawThread = (id: string, updatedAt: number) => ({
  id,
  profileId: 'machine',
  provider: 'claude',
  workspace: '/project',
  remoteId: `native-${id}`,
  createdAt: 1,
  updatedAt,
  nativeConversationLoad: { hash, copied: true },
  nativeRecovery: {
    transport: { appliedRevision: 3, snapshotToken: 'original-token', ownerGeneration: 2 },
  },
  messages: [{ id: 'prompt', role: 'user', text: '  Exact\r\nΩ🧪  ', input: '  Exact\r\nΩ🧪  ' }],
})
const raw = [rawThread('older', 2), rawThread('newer', 20)]
let f: ReturnType<typeof fakeWorker>

beforeEach(() => {
  f = fakeWorker()
  nativeWorker.create = f.create
})
afterEach(() => {
  nativeWorker.create = undefined
})

async function beginNative(signal?: AbortSignal) {
  const load = vi.fn(async () => null)
  const loadEncoded = vi.fn(async () => buffer())
  const loading = loadConversationHistory({ load, loadEncoded, save: vi.fn() }, signal)
  await vi.waitFor(() => expect(f.worker.postMessage).toHaveBeenCalledTimes(1))
  expect(load).not.toHaveBeenCalled()
  expect(loadEncoded).toHaveBeenCalledTimes(1)
  expect(f.worker.postMessage).toHaveBeenCalledTimes(1)
  return { loading }
}

function complete(hashValue?: string) {
  f.emit({ type: 'start', savedAt: 10, threadCount: raw.length, hash: hashValue })
  for (const [index, { messages, ...thread }] of raw.entries()) {
    f.emit({ type: 'thread', index, thread, messageCount: messages.length })
    f.emit({ type: 'messages', index, messages })
  }
  f.emit({ type: 'done' })
}

describe('private completed native history load provenance', () => {
  it('binds an actual encoded API load to its exact sorted normalized row identities', async () => {
    const { loading } = await beginNative()
    complete(hash)
    const snapshot = (await loading)!
    const origin = getNativeConversationLoad(snapshot)!
    expect(origin.hash).toBe(hash)
    expect(origin.rows.map((row) => row.id)).toEqual(['newer', 'older'])
    expect(origin.rows[0]).toBe(snapshot.threads[0])
    expect(origin.rows[1]).toBe(snapshot.threads[1])
    expect(Object.isFrozen(origin)).toBe(true)
    expect(Object.isFrozen(origin.rows)).toBe(true)
    for (const row of origin.rows) {
      expect(getNativeConversationRowLoad(row)).toEqual({ hash })
      expect(getNativeConversationRowLoad(getConversationSourceRaw(row))).toBeUndefined()
    }
    expect(JSON.parse(JSON.stringify(projectConversationSourceHistory([...origin.rows])))).toEqual(
      raw,
    )
    expect(Object.hasOwn(snapshot, 'hash')).toBe(false)
    expect(f.worker.terminate).toHaveBeenCalledTimes(1)
  })

  it('does not grant copied matching IDs, altered text, cache objects or raw JSON a load origin', async () => {
    const { loading } = await beginNative()
    complete(hash)
    const snapshot = (await loading)!
    const actual = getNativeConversationLoad(snapshot)!.rows[0]
    const copied = {
      ...actual,
      messages: actual.messages.map((message) => ({ ...message, text: 'Wrong text' })),
    }
    const imported = readThreads(JSON.parse(JSON.stringify(snapshot.threads)))
    expect(getNativeConversationRowLoad(copied)).toBeUndefined()
    expect(imported.every((row) => getNativeConversationRowLoad(row) === undefined)).toBe(true)
    expect(getNativeConversationLoad(JSON.parse(JSON.stringify(snapshot)))).toBeUndefined()
    expect(getNativeConversationRowLoad(raw[0] as unknown as Thread)).toBeUndefined()
    expect(getNativeConversationRowLoad(actual)).toEqual({ hash })
  })

  it('never marks a generic decoder result even when it receives a valid hash', async () => {
    const loading = decodeConversationHistory(buffer(), f.create)
    complete(hash)
    const snapshot = await loading
    expect(normalizedConversationThreads(snapshot)).toBe(snapshot.threads)
    expect(getNativeConversationLoad(snapshot)).toBeUndefined()
    expect(
      (snapshot.threads as Thread[]).every(
        (row) => getNativeConversationRowLoad(row) === undefined,
      ),
    ).toBe(true)
  })

  it.each(['scope', 'messages', 'map', 'cursor', 'transport', 'accessor'])(
    'denies a mutated loaded row (%s)',
    async (mutation) => {
      const { loading } = await beginNative()
      complete(hash)
      const snapshot = (await loading)!
      const row = getNativeConversationLoad(snapshot)!.rows[0]
      if (mutation === 'scope') row.remoteId = 'copied-scope'
      else if (mutation === 'messages') row.messages = [...row.messages]
      else if (mutation === 'map') row.nativeRecovery = { ...row.nativeRecovery }
      else if (mutation === 'cursor') row.nativeRecovery!.transport.appliedRevision++
      else if (mutation === 'transport')
        row.nativeRecovery!.copied = { ...row.nativeRecovery!.transport }
      else Object.defineProperty(row, 'remoteId', { get: () => 'copied-scope' })
      expect(getNativeConversationRowLoad(row)).toBeUndefined()
      expect(getNativeConversationLoad(snapshot)).toBeUndefined()
    },
  )

  it('does not bind replacement snapshot membership to previous loaded row identities', async () => {
    const { loading } = await beginNative()
    complete(hash)
    const snapshot = (await loading)!
    const actual = getNativeConversationLoad(snapshot)!.rows[0]
    snapshot.threads = [...snapshot.threads]
    expect(getNativeConversationLoad(snapshot)).toBeUndefined()
    expect(getNativeConversationRowLoad(actual)).toEqual({ hash })
  })

  it.each(['savedAt', 'threads', 'member'])(
    'denies snapshot accessors without invoking them (%s)',
    async (field) => {
      const { loading } = await beginNative()
      complete(hash)
      const snapshot = (await loading)!
      const read = vi.fn(() => {
        throw new Error('This accessor must not execute.')
      })
      if (field === 'member') Object.defineProperty(snapshot.threads, '0', { get: read })
      else Object.defineProperty(snapshot, field, { get: read })
      expect(getNativeConversationLoad(snapshot)).toBeUndefined()
      expect(read).not.toHaveBeenCalled()
    },
  )

  it('keeps old worker packets without a hash readable without recovery authority', async () => {
    const { loading } = await beginNative()
    complete()
    const snapshot = (await loading)!
    expect(normalizedConversationThreads(snapshot)).toBe(snapshot.threads)
    expect(getNativeConversationLoad(snapshot)).toBeUndefined()
    expect(
      (snapshot.threads as Thread[]).every(
        (row) => getNativeConversationRowLoad(row) === undefined,
      ),
    ).toBe(true)
  })

  it.each(['', 'A'.repeat(64), '0'.repeat(63), 'g'.repeat(64), `${hash}\n`, null, 17])(
    'rejects a malformed worker hash before granting provenance: %j',
    async (invalid) => {
      const { loading } = await beginNative()
      const rejected = expect(loading).rejects.toThrow('invalid checkpoint')
      f.emit({
        type: 'start',
        savedAt: 10,
        threadCount: 0,
        hash: invalid,
      } as ConversationLoadPacket)
      await rejected
      expect(f.worker.terminate).toHaveBeenCalledTimes(1)
      expect(f.worker.onmessage).toBeNull()
    },
  )

  it('does not mark staged rows or leak its worker when cancelled during a native load', async () => {
    const controller = new AbortController()
    const { loading } = await beginNative(controller.signal)
    const rejected = expect(loading).rejects.toMatchObject({ name: 'AbortError' })
    f.emit({ type: 'start', savedAt: 10, threadCount: 1, hash })
    const { messages, ...thread } = raw[0]
    f.emit({ type: 'thread', index: 0, thread, messageCount: messages.length })
    controller.abort()
    f.emit({ type: 'messages', index: 0, messages })
    f.emit({ type: 'done' })
    await rejected
    expect(getNativeConversationRowLoad(thread as unknown as Thread)).toBeUndefined()
    expect(f.worker.terminate).toHaveBeenCalledTimes(1)
    expect(f.worker.onmessage).toBeNull()
    expect(f.worker.onerror).toBeNull()
    expect(f.worker.onmessageerror).toBeNull()
  })

  it('checks cancellation after decode completion before recording native origin', async () => {
    const controller = new AbortController()
    const { loading } = await beginNative(controller.signal)
    const rejected = expect(loading).rejects.toMatchObject({ name: 'AbortError' })
    complete(hash)
    controller.abort()
    await rejected
    expect(f.worker.terminate).toHaveBeenCalledTimes(1)
  })

  it('keeps legacy object loading without privately endorsing metadata copied into it', async () => {
    const snapshot: ConversationHistorySnapshot = {
      version: 1,
      savedAt: 10,
      threads: raw as unknown as Thread[],
    }
    const result = await loadConversationHistory({
      load: vi.fn(async () => snapshot),
      save: vi.fn(),
    })
    expect(result).toBe(snapshot)
    expect(getNativeConversationLoad(snapshot)).toBeUndefined()
    expect(
      raw.every((row) => getNativeConversationRowLoad(row as unknown as Thread) === undefined),
    ).toBe(true)
  })
})
