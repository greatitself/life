import { Effect } from 'effect'
import type { ConversationLoadPacket } from './conversation-load-protocol'
import { hashConversationLoadBuffer } from './conversation-load-hash'
import { jsonCharacterSize } from './conversation-json-size'
import { prepareConversationValue, conversationStringChunkSize } from './conversation-load-values'

const port = self as unknown as {
  postMessage(value: ConversationLoadPacket): void
  onmessage: ((event: MessageEvent) => void) | null
}
let outstanding = 0
let credit: (() => void) | undefined
let flushed: (() => void) | undefined
let started = false
// A small credit window overlaps worker cloning with renderer assembly without
// retaining an unbounded event backlog or a roundtrip for every message batch.
async function send(packet: ConversationLoadPacket) {
  if (outstanding >= 4)
    await new Promise<void>((resolve) => {
      credit = resolve
    })
  outstanding++
  port.postMessage(packet)
}

async function sendValue(packet: Extract<ConversationLoadPacket, { type: 'thread' | 'messages' }>) {
  const value = packet.type === 'thread' ? packet.thread : packet.messages
  const prepared = prepareConversationValue(value)
  await send({
    ...packet,
    ...(packet.type === 'thread' ? { thread: prepared.value } : { messages: prepared.value }),
    strings: prepared.plans,
  } as ConversationLoadPacket)
  for (let id = 0; id < prepared.strings.length; id++) {
    const text = prepared.strings[id].value
    for (let offset = 0; offset < text.length; offset += conversationStringChunkSize)
      await send({
        type: 'string',
        id,
        part: offset / conversationStringChunkSize,
        value: text.slice(offset, offset + conversationStringChunkSize),
      })
  }
}

async function decode(buffer: ArrayBuffer) {
  try {
    const hash = await Effect.runPromise(hashConversationLoadBuffer(buffer))
    const snapshot = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(buffer))
    if (
      snapshot?.version !== 1 ||
      !Number.isSafeInteger(snapshot.savedAt) ||
      snapshot.savedAt < 0 ||
      !Array.isArray(snapshot.threads)
    )
      throw new Error('The disk history load returned an invalid snapshot.')
    let checkpointEligible = true
    const identities = new Set<string>()
    const threads = snapshot.threads.map((source: Record<string, unknown>) => {
      if (
        !source ||
        Array.isArray(source) ||
        typeof source.id !== 'string' ||
        typeof source.profileId !== 'string' ||
        typeof source.provider !== 'string' ||
        !['codex', 'claude'].includes(source.provider) ||
        !Array.isArray(source.messages)
      )
        throw new Error(
          'The disk history could not be normalized completely. Its original file is preserved.',
        )
      if (!source.id || identities.has(source.id)) checkpointEligible = false
      identities.add(source.id)
      return source as Record<string, unknown> & { messages: unknown[] }
    })
    await send({
      type: 'start',
      savedAt: snapshot.savedAt,
      threadCount: threads.length,
      checkpointEligible,
      hash,
    })
    for (let index = 0; index < threads.length; index++) {
      const { messages, ...thread } = threads[index]
      await sendValue({ type: 'thread', index, thread, messageCount: messages.length })
      let batch: typeof messages = []
      let characters = 0
      for (const message of messages) {
        const size = jsonCharacterSize(message)
        // Reserve space for packet fields, array commas and fragment plans.
        if (batch.length && (batch.length >= 256 || characters + size > 254 * 1024)) {
          await sendValue({ type: 'messages', index, messages: batch })
          batch = []
          characters = 0
        }
        batch.push(message)
        characters += size
      }
      if (batch.length) await sendValue({ type: 'messages', index, messages: batch })
    }
    if (outstanding)
      await new Promise<void>((resolve) => {
        flushed = resolve
      })
    port.postMessage({ type: 'done' })
  } catch (error) {
    port.postMessage({
      type: 'error',
      message: error instanceof Error ? error.message : 'Could not decode the disk history.',
    })
  }
}

port.onmessage = (event) => {
  if (event.data?.type === 'ack') {
    if (!outstanding) return
    outstanding--
    const resume = credit
    credit = undefined
    resume?.()
    if (!outstanding) {
      const done = flushed
      flushed = undefined
      done?.()
    }
  } else if (!started && event.data?.type === 'load') {
    started = true
    void decode(event.data.buffer)
  }
}
