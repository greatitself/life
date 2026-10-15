import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { ConversationCheckpointEngine } from '../src/main/conversation-checkpoint-engine'
import { runEffect } from '../src/main/effect-runtime'
import { ConversationCheckpointClient } from '../src/renderer/conversation-checkpoint-client'
import { decodeConversationHistory } from '../src/renderer/conversation-load'
import {
  nativeCheckpointConversationThreads,
  normalizedConversationThreads,
  type ConversationLoadPacket,
} from '../src/renderer/conversation-load-protocol'
import { projectConversationSourceHistory } from '../src/renderer/conversation-source'
import { readThreads, type Thread } from '../src/renderer/state'
import type { ConversationCheckpointInput } from '../src/shared/conversations'

const exact = '  Exact prompt\r\n\tUnicode café e\u0301 漢字 🧪  '
type RawThread = {
  id: string
  profileId: string
  provider: 'codex' | 'claude'
  messages: unknown[]
  [key: string]: unknown
}
const rawThread = (messages: unknown[], id = 'thread'): RawThread => ({
  id,
  profileId: 'owned-workspace',
  provider: 'codex',
  workspace: '/exact/owned-workspace',
  remoteId: 'native-provider-session',
  title: 'Preserve raw records',
  busy: true,
  futureThreadField: { exact, values: [null, false, 17] },
  messages,
})
const rawHistory = (threads: RawThread[]): Thread[] => threads as unknown as Thread[]
const json = (value: unknown) => JSON.parse(JSON.stringify(value))

let directory: string
let engine: ConversationCheckpointEngine

beforeEach(async () => {
  directory = await mkdtemp(join(tmpdir(), 'life-opaque-baseline-'))
  engine = new ConversationCheckpointEngine(directory)
})
afterEach(async () => {
  await rm(directory, { recursive: true, force: true })
})

async function seed(threads: RawThread[]) {
  const original = {
    version: 1,
    savedAt: 100,
    futureEnvelope: { exact, nested: [null, { retained: true }] },
    threads,
  }
  await writeFile(join(directory, 'conversations.json'), JSON.stringify(original), 'utf8')
  const loaded = await runEffect(engine.loadEffect())
  expect(loaded).toEqual(original)
  return { original, baseline: loaded!.threads as Thread[] }
}

function nativeBridge() {
  const save = vi.fn(async (threads: unknown[], savedAt?: number) => {
    await runEffect(engine.saveEffect(threads, savedAt!))
  })
  const checkpoint = vi.fn(async (input: ConversationCheckpointInput) =>
    runEffect(engine.checkpointEffect(input)),
  )
  return { save, checkpoint }
}

async function reloaded() {
  const disk = JSON.parse(await readFile(join(directory, 'conversations.json'), 'utf8'))
  expect(await runEffect(new ConversationCheckpointEngine(directory).loadEffect())).toEqual(disk)
  return disk
}

describe('opaque raw native baseline admission', () => {
  it.each([
    ['null', [null]],
    ['scalar', [42, false, exact]],
    ['array', [[null, exact]]],
    ['missing identity', [{ role: 'user', text: exact }, { futureOpaque: exact }]],
    ['empty identity', [{ id: '', role: 'user', text: exact }]],
    ['nonstring identity', [{ id: 7, role: 'user', text: exact }]],
    [
      'duplicate identity',
      [
        { id: 'same', role: 'user', text: exact },
        { id: 'same', role: 'future-role', futureOpaque: exact },
      ],
    ],
  ])('saves an unchanged %s history using only thread order', async (_, messages) => {
    const raw = rawThread(messages as unknown[])
    const { original, baseline } = await seed([raw])
    const bridge = nativeBridge()
    const client = new ConversationCheckpointClient()
    expect(client.adoptDurableBaseline(baseline, 100, bridge.save, bridge.checkpoint)).toBe(true)
    const projected = projectConversationSourceHistory(readThreads(baseline))
    await expect(client.submit(projected, 200, bridge.save, bridge.checkpoint)).resolves.toBe(200)
    expect(bridge.save).not.toHaveBeenCalled()
    expect(bridge.checkpoint).toHaveBeenCalledExactlyOnceWith({
      version: 1,
      baseSavedAt: 100,
      savedAt: 200,
      order: ['thread'],
      upserts: [],
    })
    expect(await reloaded()).toEqual({ ...original, savedAt: 200 })
  })

  it('does not transport an unchanged eight MiB opaque body in the first checkpoint', async () => {
    const large = exact + 'x'.repeat(8 * 1024 * 1024)
    const { original, baseline } = await seed([rawThread([null, large, { futureOpaque: large }])])
    const bridge = nativeBridge()
    const client = new ConversationCheckpointClient()
    expect(client.adoptDurableBaseline(baseline, 100, bridge.save, bridge.checkpoint)).toBe(true)
    await client.submit(
      projectConversationSourceHistory(readThreads(baseline)),
      200,
      bridge.save,
      bridge.checkpoint,
    )
    expect(bridge.save).not.toHaveBeenCalled()
    expect(JSON.stringify(bridge.checkpoint.mock.calls[0][0]).length).toBeLessThan(256)
    expect(await reloaded()).toEqual({ ...original, savedAt: 200 })
  })

  it('replaces an edited ambiguous message array exactly while preserving its untouched sibling', async () => {
    const messages = [
      null,
      exact,
      { role: 'future-role', futureOpaque: { exact } },
      { id: 'same', role: 'user', text: exact, futureMessageField: 1 },
      { id: 'same', role: 'user', text: 'Second exact\r\n', futureMessageField: 2 },
      { id: '', role: 'user', text: 'Empty exact\r\n' },
      { role: 'user', text: 'Missing identity exact\r\n' },
      [null, exact],
    ]
    const sibling = {
      ...rawThread([{ futureOpaque: exact }], 'sibling'),
      provider: 'claude' as const,
    }
    const { original, baseline } = await seed([rawThread(messages), sibling])
    const views = readThreads(baseline)
    const bridge = nativeBridge()
    const client = new ConversationCheckpointClient()
    expect(
      client.adoptDurableBaseline(baseline, 100, bridge.save, bridge.checkpoint, {
        supportsMessageFields: true,
      }),
    ).toBe(true)
    await client.submit(
      projectConversationSourceHistory(views),
      200,
      bridge.save,
      bridge.checkpoint,
    )
    expect(bridge.checkpoint.mock.calls[0][0].upserts).toEqual([])
    const editedText = '  Edited second occurrence\r\n\tΩ 🧪  '
    const thread = views.find((value) => value.id === 'thread')!
    const edited = {
      ...thread,
      title: 'Actual title edit',
      messages: thread.messages.map((message, index) =>
        index === 1 ? { ...message, text: editedText } : message,
      ),
    }
    await client.submit(
      projectConversationSourceHistory(views.map((view) => (view === thread ? edited : view))),
      300,
      bridge.save,
      bridge.checkpoint,
    )
    const expectedMessages = messages.map((message, index) =>
      index === 4 ? { ...(message as Record<string, unknown>), text: editedText } : message,
    )
    const packet = bridge.checkpoint.mock.calls[1][0]
    expect(packet.upserts).toHaveLength(1)
    expect(packet.upserts[0].messages).toEqual({ mode: 'replace', values: expectedMessages })
    expect(await reloaded()).toEqual({
      ...original,
      savedAt: 300,
      threads: [
        { ...original.threads[0], title: 'Actual title edit', messages: expectedMessages },
        sibling,
      ],
    })
    expect(bridge.save).not.toHaveBeenCalled()
  })

  it('deletes one thread without replacing or losing opaque rows in a surviving thread', async () => {
    const deleted = rawThread([null, { id: 'same' }, { id: 'same' }], 'deleted')
    const survivor = rawThread([null, exact, { futureOpaque: exact }], 'survivor')
    const { original, baseline } = await seed([deleted, survivor])
    const bridge = nativeBridge()
    const client = new ConversationCheckpointClient()
    expect(client.adoptDurableBaseline(baseline, 100, bridge.save, bridge.checkpoint)).toBe(true)
    const views = readThreads(baseline)
    await client.submit(
      projectConversationSourceHistory(views.filter((thread) => thread.id === 'survivor')),
      200,
      bridge.save,
      bridge.checkpoint,
    )
    expect(bridge.checkpoint).toHaveBeenCalledExactlyOnceWith({
      version: 1,
      baseSavedAt: 100,
      savedAt: 200,
      order: ['survivor'],
      upserts: [],
    })
    expect(await reloaded()).toEqual({ ...original, savedAt: 200, threads: [survivor] })
    expect(bridge.save).not.toHaveBeenCalled()
  })

  it('publishes the raw baseline only after the owned decoder receives every opaque row', async () => {
    const raw = rawThread([null, exact, { id: 'same' }, { id: 'same' }, { futureOpaque: exact }])
    const worker = {
      onmessage: null as Worker['onmessage'],
      onerror: null as Worker['onerror'],
      onmessageerror: null as Worker['onmessageerror'],
      postMessage: vi.fn(),
      terminate: vi.fn(),
    }
    const emit = (data: ConversationLoadPacket) =>
      worker.onmessage?.call(worker as unknown as Worker, { data } as MessageEvent)
    const loading = decodeConversationHistory(new ArrayBuffer(0), () => worker as unknown as Worker)
    const published = vi.fn()
    void loading.then(published)
    const { messages, ...thread } = raw
    emit({ type: 'start', savedAt: 100, threadCount: 1, checkpointEligible: true })
    emit({ type: 'thread', index: 0, thread, messageCount: messages.length })
    emit({ type: 'messages', index: 0, messages: messages.slice(0, 2) })
    await Promise.resolve()
    expect(published).not.toHaveBeenCalled()
    emit({ type: 'messages', index: 0, messages: messages.slice(2) })
    emit({ type: 'done' })
    const snapshot = await loading
    expect(nativeCheckpointConversationThreads(snapshot)).toEqual([raw])
    expect(normalizedConversationThreads(snapshot)![0].messages).toEqual([])
    expect(nativeCheckpointConversationThreads(json(snapshot))).toBeUndefined()
    expect(worker.terminate).toHaveBeenCalledExactlyOnceWith()
  })

  it.each([
    null,
    7,
    {},
    [null],
    [7],
    [[]],
    [{ ...rawThread([]), id: '' }],
    [rawThread([], 'same'), rawThread([], 'same')],
    [{ ...rawThread([]), id: null }],
    [{ ...rawThread([]), profileId: null }],
    [{ ...rawThread([]), provider: 'future-provider' }],
    [{ ...rawThread([]), messages: null }],
    [{ ...rawThread([]), messages: {} }],
  ])('refuses malformed or ambiguous thread ownership without throwing: %j', (history) => {
    const client = new ConversationCheckpointClient()
    const bridge = nativeBridge()
    expect(() =>
      client.adoptDurableBaseline(history as Thread[], 100, bridge.save, bridge.checkpoint),
    ).not.toThrow()
    expect(
      client.adoptDurableBaseline(history as Thread[], 100, bridge.save, bridge.checkpoint),
    ).toBe(false)
    expect(bridge.save).not.toHaveBeenCalled()
    expect(bridge.checkpoint).not.toHaveBeenCalled()
  })
})
