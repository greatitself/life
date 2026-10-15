import { describe, expect, it, vi } from 'vitest'
import {
  decodeConversationHistory,
  loadConversationHistory,
} from '../src/renderer/conversation-load'
import {
  normalizedConversationThreads,
  nativeCheckpointConversationThreads,
  type ConversationLoadPacket,
} from '../src/renderer/conversation-load-protocol'
import {
  conversationStringChunkSize,
  prepareConversationValue,
  conversationStringSlot,
  samePersistedConversationValue,
} from '../src/renderer/conversation-load-values'
import { readThreads } from '../src/renderer/state'
import { reconcileConversationHistory } from '../src/renderer/conversation-persistence'
import {
  getConversationSourceRaw,
  projectConversationSourceHistory,
} from '../src/renderer/conversation-source'

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
const buffer = () => new TextEncoder().encode('{}').buffer
const json = (value: unknown) => JSON.parse(JSON.stringify(value))
const rawThread = (
  overrides: Record<string, unknown> = {},
): Record<string, unknown> & { messages: unknown[] } => ({
  id: 'thread',
  profileId: 'machine',
  provider: 'claude',
  workspace: '/project',
  remoteId: 'native-session',
  createdAt: 1,
  updatedAt: 2,
  messages: [
    { id: 'message', role: 'user', text: '  Exact\r\n\tΩ 🧪\n', input: 'Untrimmed  \r\n' },
  ] as unknown[],
  ...overrides,
})
const restored = () => readThreads([rawThread()])[0]

function emitValue(
  f: ReturnType<typeof fakeWorker>,
  packet: Extract<ConversationLoadPacket, { type: 'thread' | 'messages' }>,
) {
  const prepared = prepareConversationValue(
    packet.type === 'thread' ? packet.thread : packet.messages,
  )
  f.emit({
    ...packet,
    ...(packet.type === 'thread' ? { thread: prepared.value } : { messages: prepared.value }),
    strings: prepared.plans,
  } as ConversationLoadPacket)
  for (const [id, { value }] of prepared.strings.entries())
    for (let offset = 0; offset < value.length; offset += conversationStringChunkSize)
      f.emit({
        type: 'string',
        id,
        part: offset / conversationStringChunkSize,
        value: value.slice(offset, offset + conversationStringChunkSize),
      })
}

describe('owned incremental history decoding', () => {
  it.each([true, false])('seeds only complete eligible native sources (%s)', async (eligible) => {
    const f = fakeWorker()
    const loading = decodeConversationHistory(buffer(), f.create)
    const { messages, ...thread } = rawThread()
    f.emit({ type: 'start', savedAt: 10, threadCount: 1, checkpointEligible: eligible })
    f.emit({ type: 'thread', index: 0, thread, messageCount: 1 })
    f.emit({ type: 'messages', index: 0, messages })
    f.emit({ type: 'done' })
    const snapshot = await loading
    const native = nativeCheckpointConversationThreads(snapshot)
    if (eligible) {
      expect(native).not.toBe(snapshot.threads)
      expect(native).toEqual([{ ...thread, messages }])
      expect(native?.[0]).toBe(
        getConversationSourceRaw(normalizedConversationThreads(snapshot)![0]),
      )
    } else expect(native).toBeUndefined()
  })

  it('seeds the original native baseline while displaying interrupted restored activity', async () => {
    const f = fakeWorker()
    const loading = decodeConversationHistory(buffer(), f.create)
    const { messages, ...thread } = rawThread({
      busy: true,
      futureMetadata: { retained: true },
      messages: [{ id: 'tool', role: 'tool', text: 'Unfinished', status: 'running' }],
    })
    f.emit({ type: 'start', savedAt: 10, threadCount: 1, checkpointEligible: true })
    f.emit({ type: 'thread', index: 0, thread, messageCount: 1 })
    f.emit({ type: 'messages', index: 0, messages })
    f.emit({ type: 'done' })
    const snapshot = await loading
    const view = normalizedConversationThreads(snapshot)!
    expect(view[0].messages[0].status).toBe('interrupted')
    expect(view[0].busy).toBe(false)
    expect(nativeCheckpointConversationThreads(snapshot)).toEqual([{ ...thread, messages }])
    expect(json(projectConversationSourceHistory(view))).toEqual([{ ...thread, messages }])
  })

  it('keeps raw native order separate from the sorted UI and preserves valid opaque records', async () => {
    const older = rawThread({
      id: 'older',
      updatedAt: 2,
      futureMetadata: { exact: '  Ω\r\n' },
      messages: [
        { id: 'future', role: 'future-role', text: 'Opaque exact\r\n', futureValue: 3 },
        { id: 'role-object', role: { toString: null }, text: 'Never stringify this role' },
        { id: 'known', role: 'user', text: '  Exact input\r\n', input: '  Exact input\r\n' },
      ],
    })
    const newer = rawThread({ id: 'newer', updatedAt: 20, messages: [] })
    const f = fakeWorker()
    const loading = decodeConversationHistory(buffer(), f.create)
    f.emit({ type: 'start', savedAt: 10, threadCount: 2, checkpointEligible: true })
    for (const [index, { messages, ...thread }] of [older, newer].entries()) {
      f.emit({ type: 'thread', index, thread, messageCount: messages.length })
      if (messages.length) f.emit({ type: 'messages', index, messages })
    }
    f.emit({ type: 'done' })
    const snapshot = await loading
    const view = normalizedConversationThreads(snapshot)!
    expect(view.map((thread) => thread.id)).toEqual(['newer', 'older'])
    expect(view[1].messages.map((message) => message.id)).toEqual(['known'])
    expect(nativeCheckpointConversationThreads(snapshot)).toEqual([older, newer])
    expect(json(projectConversationSourceHistory(view))).toEqual([older, newer])
  })

  it('seeds the exact raw baseline across batches with missing and duplicate message IDs', async () => {
    const raw = rawThread({
      futureMetadata: { nested: [null, '  Ω\r\n'] },
      messages: [
        null,
        7,
        'opaque scalar',
        { futureRecord: true },
        { id: 'future', role: 'future-role', text: 'Opaque body' },
        { role: 'user', text: 'Missing identity' },
        { id: 'duplicate', role: 'user', text: 'First exact\r\n' },
        { id: 'duplicate', role: 'user', text: 'Second exact\r\n' },
      ],
    })
    const f = fakeWorker()
    const loading = decodeConversationHistory(buffer(), f.create)
    const { messages, ...thread } = raw
    f.emit({ type: 'start', savedAt: 10, threadCount: 1, checkpointEligible: true })
    f.emit({ type: 'thread', index: 0, thread, messageCount: messages.length })
    f.emit({ type: 'messages', index: 0, messages: messages.slice(0, 7) })
    f.emit({ type: 'messages', index: 0, messages: messages.slice(7) })
    f.emit({ type: 'done' })
    const snapshot = await loading
    const view = normalizedConversationThreads(snapshot)!
    expect(view[0].messages.map((message) => message.text)).toEqual([
      'First exact\r\n',
      'Second exact\r\n',
    ])
    expect(nativeCheckpointConversationThreads(snapshot)).toEqual([raw])
    expect(json(projectConversationSourceHistory(view))).toEqual([raw])
    const changed = {
      ...view[0],
      messages: [view[0].messages[0], { ...view[0].messages[1], text: '  Second edited\r\nΩ  ' }],
    }
    expect(json(projectConversationSourceHistory([changed]))[0].messages).toEqual([
      ...messages.slice(0, 7),
      { ...(messages[7] as Record<string, unknown>), text: '  Second edited\r\nΩ  ' },
    ])
  })

  it('compares durable JSON semantics without losing meaningful scalar or metadata changes', () => {
    expect(
      samePersistedConversationValue(
        { text: '  Ω🧪\r\n', unused: undefined },
        { text: '  Ω🧪\r\n' },
      ),
    ).toBe(true)
    expect(samePersistedConversationValue({ pending: [] }, { pending: [null] })).toBe(false)
    expect(samePersistedConversationValue({ text: 'prompt  ' }, { text: 'prompt' })).toBe(false)
    expect(samePersistedConversationValue({ unknown: true }, {})).toBe(false)
    expect(
      samePersistedConversationValue({ queue: [{ paused: false }] }, { queue: [{ paused: true }] }),
    ).toBe(false)
    expect(samePersistedConversationValue({ input: null }, { input: undefined })).toBe(false)
  })

  it('preserves unknown child activity across repeated disk restoration', () => {
    const first = readThreads([
      {
        ...restored(),
        messages: [
          {
            id: 'child',
            role: 'tool',
            text: 'Unfinished',
            kind: 'subagent',
            agentId: 'child-agent',
            status: 'running',
          },
        ],
      },
    ])
    const second = readThreads(JSON.parse(JSON.stringify(first)))
    const third = readThreads(JSON.parse(JSON.stringify(second)))
    expect(first[0].messages[0].activityStateUnknown).toBe(true)
    expect(second[0].messages[0].activityStateUnknown).toBe(true)
    expect(third[0].messages[0].activityStateUnknown).toBe(true)
    expect(json(third)).toEqual(json(second))
  })
  it('admits only complete normalized history and avoids a second normalization', async () => {
    const f = fakeWorker()
    const loading = decodeConversationHistory(buffer(), f.create)
    let admitted = false
    void loading.then(() => {
      admitted = true
    })
    const { messages, ...thread } = restored()
    f.emit({ type: 'start', savedAt: 10, threadCount: 1 })
    f.emit({ type: 'thread', index: 0, thread, messageCount: 1 })
    await Promise.resolve()
    expect(admitted).toBe(false)
    f.emit({ type: 'messages', index: 0, messages })
    f.emit({ type: 'done' })
    const snapshot = await loading
    expect(json(snapshot.threads)).toEqual(json([restored()]))
    expect(normalizedConversationThreads(snapshot)).toBe(snapshot.threads)
    expect(reconcileConversationHistory(snapshot, { threads: [] })[0]).toBe(snapshot.threads[0])
    expect(f.worker.terminate).toHaveBeenCalledTimes(1)
    expect(f.worker.onmessage).toBeNull()
  })

  it.each(['incomplete messages', 'wrong thread index', 'decoder error', 'message error'])(
    'rejects %s without admitting a partial snapshot',
    async (failure) => {
      const f = fakeWorker()
      const loading = decodeConversationHistory(buffer(), f.create)
      const failed = expect(loading).rejects.toBeInstanceOf(Error)
      const { messages, ...thread } = restored()
      f.emit({ type: 'start', savedAt: 10, threadCount: 1 })
      if (failure === 'wrong thread index')
        f.emit({ type: 'thread', index: 1, thread, messageCount: 1 })
      else if (failure === 'decoder error')
        f.emit({ type: 'error', message: 'Unreadable original' })
      else if (failure === 'message error')
        f.worker.onmessageerror?.call(f.worker as unknown as Worker, {} as MessageEvent)
      else {
        f.emit({ type: 'thread', index: 0, thread, messageCount: messages.length })
        f.emit({ type: 'done' })
      }
      await failed
      expect(f.worker.terminate).toHaveBeenCalledTimes(1)
    },
  )

  it('cancels its parser and detaches listeners without publishing staged history', async () => {
    const f = fakeWorker()
    const controller = new AbortController()
    const loading = decodeConversationHistory(buffer(), f.create, controller.signal)
    const rejected = expect(loading).rejects.toMatchObject({ name: 'AbortError' })
    f.emit({ type: 'start', savedAt: 10, threadCount: 0 })
    controller.abort()
    await rejected
    f.emit({ type: 'done' })
    expect(f.worker.terminate).toHaveBeenCalledTimes(1)
    expect(f.worker.onmessage).toBeNull()
  })

  it('does not publish partial raw provenance when cancelled between message batches', async () => {
    const raw = rawThread({ messages: [null, { id: 'known', role: 'user', text: 'Exact\r\n' }] })
    const f = fakeWorker()
    const controller = new AbortController()
    const loading = decodeConversationHistory(buffer(), f.create, controller.signal)
    const rejected = expect(loading).rejects.toMatchObject({ name: 'AbortError' })
    const published = vi.fn()
    void loading.then(published, () => undefined)
    const { messages, ...thread } = raw
    f.emit({ type: 'start', savedAt: 10, threadCount: 1, checkpointEligible: true })
    f.emit({ type: 'thread', index: 0, thread, messageCount: messages.length })
    f.emit({ type: 'messages', index: 0, messages: messages.slice(0, 1) })
    controller.abort()
    await rejected
    f.emit({ type: 'messages', index: 0, messages: messages.slice(1) })
    f.emit({ type: 'done' })
    expect(published).not.toHaveBeenCalled()
    expect(f.worker.terminate).toHaveBeenCalledTimes(1)
    expect(f.worker.onmessage).toBeNull()
  })

  it('retains compatibility with native bridges that only implement object loading', async () => {
    const snapshot = { version: 1 as const, savedAt: 20, threads: [] }
    const load = vi.fn(async () => snapshot)
    expect(await loadConversationHistory({ load, save: vi.fn() })).toBe(snapshot)
    expect(load).toHaveBeenCalledTimes(1)
    expect(normalizedConversationThreads(snapshot)).toBeUndefined()
  })

  it('does not admit a cancelled legacy native read when its bridge eventually replies', async () => {
    const controller = new AbortController()
    let complete!: (value: null) => void
    const load = vi.fn(
      () =>
        new Promise<null>((resolve) => {
          complete = resolve
        }),
    )
    const loading = loadConversationHistory({ load, save: vi.fn() }, controller.signal)
    const rejected = expect(loading).rejects.toMatchObject({ name: 'AbortError' })
    controller.abort()
    complete(null)
    await rejected
    expect(load).toHaveBeenCalledTimes(1)
  })

  it('restores scalar fragments across surrogate/CRLF boundaries without mutating the producer', async () => {
    const source = restored()
    const text = 'x'.repeat(conversationStringChunkSize - 1) + '🧪\r\n' + '  Ω'.repeat(30_000)
    source.messages[0].text = text
    source.messages[0].input = text
    const prepared = prepareConversationValue(source.messages)
    expect(source.messages[0].text).toBe(text)
    expect(prepared.value[0].text).toBe('')
    const f = fakeWorker()
    const loading = decodeConversationHistory(buffer(), f.create)
    const { messages: _messages, ...thread } = source
    f.emit({ type: 'start', savedAt: 10, threadCount: 1 })
    f.emit({ type: 'thread', index: 0, thread, messageCount: 1 })
    f.emit({ type: 'messages', index: 0, messages: prepared.value, strings: prepared.plans })
    for (const [id, { value }] of prepared.strings.entries())
      for (let offset = 0; offset < value.length; offset += conversationStringChunkSize)
        f.emit({
          type: 'string',
          id,
          part: offset / conversationStringChunkSize,
          value: value.slice(offset, offset + conversationStringChunkSize),
        })
    f.emit({ type: 'done' })
    const snapshot = await loading
    expect(json(snapshot.threads)).toEqual(json([source]))
    expect(source.messages[0].input).toBe(text)
  })

  it('restores fragmented raw metadata, opaque bodies and scalar rows before capturing their source', async () => {
    const exact = 'x'.repeat(conversationStringChunkSize - 1) + '🧪\r\n' + '  Ω'.repeat(30_000)
    const raw = rawThread({
      futureMetadata: { exact },
      messages: [
        exact,
        { id: 'opaque', role: { toString: null }, text: exact, futurePayload: { exact } },
        { id: 'known', role: 'user', text: exact, input: exact },
      ],
    })
    const f = fakeWorker()
    const loading = decodeConversationHistory(buffer(), f.create)
    const { messages, ...thread } = raw
    f.emit({ type: 'start', savedAt: 10, threadCount: 1, checkpointEligible: false })
    emitValue(f, { type: 'thread', index: 0, thread, messageCount: messages.length })
    emitValue(f, { type: 'messages', index: 0, messages })
    f.emit({ type: 'done' })
    const snapshot = await loading
    const view = normalizedConversationThreads(snapshot)!
    expect(view[0].messages).toHaveLength(1)
    expect(view[0].messages[0].text).toBe(exact)
    expect(view[0].messages[0].input).toBe(exact)
    expect(json(projectConversationSourceHistory(view))).toEqual([raw])
    expect(raw.messages[0]).toBe(exact)
    expect(raw.futureMetadata).toEqual({ exact })
    expect(nativeCheckpointConversationThreads(snapshot)).toBeUndefined()
  })

  it('rejects completion during a fragmented opaque row without publishing staged history', async () => {
    const f = fakeWorker()
    const loading = decodeConversationHistory(buffer(), f.create)
    const failed = expect(loading).rejects.toThrow('incomplete string')
    const { messages: _messages, ...thread } = rawThread()
    f.emit({ type: 'start', savedAt: 10, threadCount: 1, checkpointEligible: false })
    f.emit({ type: 'thread', index: 0, thread, messageCount: 1 })
    f.emit({
      type: 'messages',
      index: 0,
      messages: [''],
      strings: [{ path: ['0'], length: conversationStringChunkSize + 1, parts: 2 }],
    })
    f.emit({ type: 'string', id: 0, part: 0, value: 'x'.repeat(conversationStringChunkSize) })
    f.emit({ type: 'done' })
    await failed
    expect(f.worker.terminate).toHaveBeenCalledTimes(1)
  })

  it('rejects truncated scalar fragments and inherited property destinations', async () => {
    expect(() => conversationStringSlot({}, ['__proto__', 'polluted'])).toThrow()
    const f = fakeWorker()
    const loading = decodeConversationHistory(buffer(), f.create)
    const failed = expect(loading).rejects.toThrow('invalid string fragment')
    const { messages, ...thread } = restored()
    messages[0].text = ''
    f.emit({ type: 'start', savedAt: 10, threadCount: 1 })
    f.emit({ type: 'thread', index: 0, thread, messageCount: 1 })
    f.emit({
      type: 'messages',
      index: 0,
      messages,
      strings: [{ path: ['0', 'text'], length: conversationStringChunkSize + 1, parts: 2 }],
    })
    f.emit({ type: 'string', id: 0, part: 0, value: 'truncated' })
    await failed
    expect(f.worker.terminate).toHaveBeenCalledTimes(1)
  })
})
