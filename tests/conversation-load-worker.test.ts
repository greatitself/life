import { afterEach, describe, expect, it, vi } from 'vitest'
import type { ConversationLoadPacket } from '../src/renderer/conversation-load-protocol'
import {
  conversationStringChunkSize,
  conversationStringSlot,
} from '../src/renderer/conversation-load-values'

afterEach(() => vi.unstubAllGlobals())

async function produce(threads: unknown[]) {
  vi.resetModules()
  const packets: ConversationLoadPacket[] = []
  const port = {
    postMessage: (packet: ConversationLoadPacket) => {
      packets.push(packet)
      if (packet.type !== 'done')
        queueMicrotask(() => port.onmessage!({ data: { type: 'ack' } } as MessageEvent))
    },
    onmessage: undefined as ((event: MessageEvent) => void) | undefined,
  }
  vi.stubGlobal('self', port)
  await import('../src/renderer/conversation-load-worker')
  const buffer = new TextEncoder().encode(
    JSON.stringify({ version: 1, savedAt: 10, threads }),
  ).buffer
  port.onmessage!({ data: { type: 'load', buffer } } as MessageEvent)
  await vi.waitFor(() => expect(['done', 'error']).toContain(packets.at(-1)?.type))
  return packets
}

const rawThread = (messages: unknown[] = []) => ({
  id: 'thread',
  profileId: 'machine',
  provider: 'codex',
  messages,
})

describe('bounded browser history producer', () => {
  it.each([
    null,
    7,
    [],
    { ...rawThread(), id: null },
    { ...rawThread(), profileId: null },
    { ...rawThread(), provider: 'future-provider' },
    { ...rawThread(), messages: null },
    { ...rawThread(), messages: {} },
  ])('rejects a malformed thread without publishing a baseline: %j', async (thread) => {
    const packets = await produce([thread])
    expect(packets).toEqual([
      {
        type: 'error',
        message:
          'The disk history could not be normalized completely. Its original file is preserved.',
      },
    ])
  })

  it.each([
    ['canonical durable history', true],
    ['restoration metadata', true],
    ['unknown durable metadata', true],
    ['valid opaque role identity', true],
    ['opaque role object', true],
    ['duplicate thread identities', false],
    ['empty thread identity', false],
    ['duplicate message identities', true],
    ['empty message identity', true],
    ['missing message identity', true],
    ['opaque message records', true],
    ['null message row', true],
    ['scalar message row', true],
  ] as const)('checks baseline provenance for %s', async (scenario, eligible) => {
    const threads: (ReturnType<typeof rawThread> & Record<string, unknown>)[] = [
      rawThread([{ id: 'message', role: 'assistant', text: 'Exact\r\nΩ🧪', turn: 0 }]),
    ]
    if (scenario === 'restoration metadata') threads[0].busy = true
    if (scenario === 'unknown durable metadata') threads[0].futureMetadata = true
    if (scenario === 'valid opaque role identity')
      threads[0].messages.push({ id: 'future', role: 'future-role', text: 'Exact opaque\r\n' })
    if (scenario === 'opaque role object')
      threads[0].messages.push({ id: 'future', role: { toString: null }, text: 'Exact opaque\r\n' })
    if (scenario === 'duplicate thread identities') threads.push({ ...threads[0] })
    if (scenario === 'empty thread identity') threads[0].id = ''
    if (scenario === 'duplicate message identities')
      threads[0].messages.push({ ...(threads[0].messages[0] as Record<string, unknown>) })
    if (scenario === 'empty message identity')
      (threads[0].messages[0] as Record<string, unknown>).id = ''
    if (scenario === 'missing message identity')
      delete (threads[0].messages[0] as Record<string, unknown>).id
    if (scenario === 'opaque message records') threads[0].messages.push({ futureRecord: true })
    if (scenario === 'null message row') threads[0].messages.push(null)
    if (scenario === 'scalar message row') threads[0].messages.push('Exact opaque scalar\r\n')
    const packets = await produce(threads)
    expect(packets.at(-1)?.type).toBe('done')
    expect(packets[0]).toMatchObject({ type: 'start', checkpointEligible: eligible })
    expect(
      packets.filter((packet) => packet.type === 'messages').flatMap((packet) => packet.messages),
    ).toEqual(threads.flatMap((thread) => thread.messages))
  })

  it('emits raw thread metadata and message rows in the original disk order', async () => {
    const older = {
      ...rawThread([
        null,
        7,
        'Opaque exact\r\nΩ',
        { futureRecord: true },
        { id: 'future', role: { toString: null }, text: 'Opaque exact\r\nΩ' },
        { id: 'known', role: 'user', text: '  Exact input\r\nΩ  ', input: '  Exact input\r\nΩ  ' },
      ]),
      id: 'older',
      updatedAt: 2,
      busy: true,
      futureMetadata: { retained: ['Ω', null] },
    }
    const newer = { ...rawThread([]), id: 'newer', updatedAt: 20 }
    const packets = await produce([older, newer])
    const headers = packets.filter((packet) => packet.type === 'thread')
    expect(headers.map((packet) => packet.thread.id)).toEqual(['older', 'newer'])
    const { messages, ...metadata } = older
    expect(headers[0]).toMatchObject({
      type: 'thread',
      index: 0,
      thread: metadata,
      messageCount: 6,
    })
    expect(
      packets.filter((packet) => packet.type === 'messages').flatMap((packet) => packet.messages),
    ).toEqual(messages)
  })

  it('fragments large opaque scalar rows and nested future fields without losing exact values', async () => {
    const exact = 'x'.repeat(conversationStringChunkSize - 1) + '🧪\r\n' + '  Ω'.repeat(30_000)
    const raw = {
      ...rawThread([
        exact,
        { id: 'opaque', role: { toString: null }, text: exact, futurePayload: { exact } },
        { id: 'known', role: 'user', text: exact, input: exact },
      ]),
      futureMetadata: { exact },
    }
    const packets = await produce([raw])
    const headers: Record<string, unknown>[] = []
    let active: Extract<ConversationLoadPacket, { type: 'thread' | 'messages' }> | undefined
    let chunks = ''
    for (const packet of packets) {
      if (packet.type === 'thread' || packet.type === 'messages') {
        active = packet
        if (packet.type === 'thread') headers.push(packet.thread)
      } else if (packet.type === 'string') {
        const plan = active!.strings![packet.id]
        chunks += packet.value
        expect(packet.value.length).toBeLessThanOrEqual(conversationStringChunkSize)
        if (packet.part === plan.parts - 1) {
          const root = active!.type === 'thread' ? active!.thread : active!.messages
          const { parent, key } = conversationStringSlot(root, plan.path)
          Object.defineProperty(parent, key, {
            value: chunks,
            enumerable: true,
            writable: true,
            configurable: true,
          })
          chunks = ''
        }
      }
    }
    // Scalar array elements are copied after their fragment destinations are restored.
    const assembledMessages = packets
      .filter((packet) => packet.type === 'messages')
      .flatMap((packet) => packet.messages)
    const { messages: expectedMessages, ...expectedHeader } = raw
    expect(headers).toEqual([expectedHeader])
    expect(assembledMessages).toEqual(expectedMessages)
    expect(packets[0]).toMatchObject({ checkpointEligible: true })
  })

  it('holds at most four unacknowledged packets and completes only after every packet is acknowledged', async () => {
    vi.resetModules()
    const packets: ConversationLoadPacket[] = []
    const port = {
      postMessage: (packet: ConversationLoadPacket) => {
        packets.push(packet)
      },
      onmessage: undefined as ((event: MessageEvent) => void) | undefined,
    }
    vi.stubGlobal('self', port)
    await import('../src/renderer/conversation-load-worker')
    const snapshot = {
      version: 1,
      savedAt: 10,
      threads: [
        {
          id: 'thread',
          profileId: 'machine',
          provider: 'codex',
          messages: Array.from({ length: 2_000 }, (_, index) => ({
            id: String(index),
            role: 'assistant',
            text: 'Exact\r\nΩ🧪' + 'x'.repeat(1024),
          })),
        },
      ],
    }
    const buffer = new TextEncoder().encode(JSON.stringify(snapshot)).buffer
    port.onmessage!({ data: { type: 'load', buffer } } as MessageEvent)
    await vi.waitFor(() => expect(packets).toHaveLength(4))
    await new Promise((resolve) => setTimeout(resolve, 10))
    expect(packets).toHaveLength(4)
    expect(packets.some((packet) => packet.type === 'done')).toBe(false)
    let acknowledged = 0
    let maximumOutstanding = packets.length
    for (
      let iteration = 0;
      iteration < 100 && !packets.some((packet) => packet.type === 'done');
      iteration++
    ) {
      const delivered = packets.length
      while (acknowledged < delivered) {
        port.onmessage!({ data: { type: 'ack' } } as MessageEvent)
        acknowledged++
      }
      await new Promise((resolve) => setTimeout(resolve, 0))
      const pending = packets.filter((packet) => packet.type !== 'done').length - acknowledged
      maximumOutstanding = Math.max(maximumOutstanding, pending)
      expect(pending).toBeLessThanOrEqual(4)
    }
    expect(packets.at(-1)?.type).toBe('done')
    expect(acknowledged).toBe(packets.length - 1)
    expect(maximumOutstanding).toBe(4)
    const batches = packets.filter((packet) => packet.type === 'messages')
    expect(batches.flatMap((packet) => packet.messages)).toHaveLength(2_000)
    expect(
      batches.every(
        (packet) => packet.messages.length <= 256 && JSON.stringify(packet).length <= 256 * 1024,
      ),
    ).toBe(true)
  })
})
