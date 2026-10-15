import { Schema } from 'effect'
import HistoryWorker from './conversation-load-worker?worker&inline'
import type { ConversationHistorySnapshot } from '../shared/conversations'
import { readThreadMessages, readThreads, type Thread } from './state'
import {
  appendConversationSourceMessages,
  attachConversationSource,
  getConversationSourceRaw,
} from './conversation-source'
import {
  markNormalizedConversationHistory,
  conversationLoadHashSchema,
  type ConversationLoadPacket,
} from './conversation-load-protocol'
import {
  conversationStringSlot,
  conversationStringChunkSize,
  type ConversationStringPlan,
} from './conversation-load-values'
export {
  getNativeConversationLoad,
  getNativeConversationRowLoad,
  loadConversationHistory,
} from './conversation-load-provenance'

interface DecodedConversationHistory {
  snapshot: ConversationHistorySnapshot
  hash?: string
}

export function decodeConversationHistoryWithHash(
  buffer: ArrayBuffer,
  createWorker: () => Worker = () => new HistoryWorker(),
  signal?: AbortSignal,
): Promise<DecodedConversationHistory> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) return reject(signal.reason)
    let worker: Worker
    try {
      worker = createWorker()
    } catch (error) {
      reject(error)
      return
    }
    let savedAt: number | undefined
    let threadCount: number | undefined
    let checkpointEligible = false
    let hash: string | undefined
    const threads: Thread[] = []
    const rawHeaders: Record<string, unknown>[] = []
    const rawMessages: unknown[][] = []
    const sourceGroup = {}
    const counts: number[] = []
    const sourceFinalized: boolean[] = []
    const finalizeThread = (index: number) => {
      if (sourceFinalized[index] || rawMessages[index].length !== counts[index]) return
      attachConversationSource(
        threads[index],
        { ...rawHeaders[index], messages: rawMessages[index] },
        { group: sourceGroup, order: index },
      )
      sourceFinalized[index] = true
    }
    let stringRoot: unknown
    let stringPlans: ConversationStringPlan[] = []
    let stringId = 0
    let stringPart = 0
    let stringValue = ''
    let completeValue: (() => void) | undefined
    const prepareStrings = (root: unknown, plans: ConversationStringPlan[] = []) => {
      for (const plan of plans) {
        if (
          !Number.isSafeInteger(plan.parts) ||
          plan.parts <= 0 ||
          !Number.isSafeInteger(plan.length) ||
          plan.length <= conversationStringChunkSize ||
          plan.parts !== Math.ceil(plan.length / conversationStringChunkSize)
        )
          throw new Error('History decoder returned invalid string fragments.')
        conversationStringSlot(root, plan.path)
      }
      stringRoot = root
      stringPlans = plans
      stringId = 0
      stringPart = 0
      stringValue = ''
    }
    let completed = false
    const finish = (error?: unknown) => {
      if (completed) return
      let snapshot: ConversationHistorySnapshot | undefined
      if (error === undefined) {
        try {
          const rawNativeSource = checkpointEligible
            ? threads.map(getConversationSourceRaw)
            : undefined
          snapshot = {
            version: 1,
            savedAt: savedAt!,
            threads: threads.sort((left, right) => right.updatedAt - left.updatedAt),
          }
          markNormalizedConversationHistory(snapshot, rawNativeSource)
        } catch (failure) {
          error = failure
        }
      }
      completed = true
      signal?.removeEventListener('abort', abort)
      worker.onmessage = null
      worker.onerror = null
      worker.onmessageerror = null
      worker.terminate()
      if (error !== undefined) reject(error)
      else resolve({ snapshot: snapshot!, hash })
    }
    const abort = () => finish(signal?.reason ?? new DOMException('Cancelled.', 'AbortError'))
    worker.onerror = (event) => finish(new Error(event.message || 'History decoder failed.'))
    worker.onmessageerror = () => finish(new Error('History decoder returned unreadable data.'))
    worker.onmessage = ({ data }: MessageEvent<ConversationLoadPacket>) => {
      try {
        if (data.type !== 'string' && data.type !== 'error' && stringId < stringPlans.length)
          throw new Error('History decoder returned an incomplete string.')
        switch (data.type) {
          case 'start':
            if (
              savedAt !== undefined ||
              !Number.isSafeInteger(data.savedAt) ||
              data.savedAt < 0 ||
              !Number.isSafeInteger(data.threadCount) ||
              data.threadCount < 0 ||
              (data.hash !== undefined && !Schema.is(conversationLoadHashSchema)(data.hash))
            )
              throw new Error('History decoder returned an invalid checkpoint.')
            savedAt = data.savedAt
            threadCount = data.threadCount
            checkpointEligible = data.checkpointEligible === true
            hash = data.hash
            break
          case 'thread':
            if (
              savedAt === undefined ||
              data.index !== threads.length ||
              threads.length >= threadCount! ||
              !Number.isSafeInteger(data.messageCount) ||
              data.messageCount < 0
            )
              throw new Error('History decoder returned an invalid thread sequence.')
            rawHeaders.push(data.thread)
            rawMessages.push([])
            counts.push(data.messageCount)
            sourceFinalized.push(false)
            prepareStrings(data.thread, data.strings)
            {
              const normalizeHeader = () => {
                const thread = readThreads([{ ...data.thread, messages: [] }])[0]
                if (!thread) throw new Error('History decoder returned an unreadable thread.')
                threads.push(thread)
                finalizeThread(data.index)
              }
              if (stringPlans.length) completeValue = normalizeHeader
              else normalizeHeader()
            }
            break
          case 'messages': {
            const thread = threads[data.index]
            if (
              !thread ||
              data.index !== threads.length - 1 ||
              !Array.isArray(data.messages) ||
              rawMessages[data.index].length + data.messages.length > counts[data.index]
            )
              throw new Error('History decoder returned an invalid message sequence.')
            prepareStrings(data.messages, data.strings)
            const normalize = () => {
              const messages = readThreadMessages(data.messages)
              appendConversationSourceMessages(
                thread,
                rawMessages[data.index],
                messages,
                data.messages,
              )
              finalizeThread(data.index)
            }
            if (stringPlans.length) completeValue = normalize
            else normalize()
            break
          }
          case 'string': {
            const plan = stringPlans[stringId]
            if (
              !plan ||
              data.id !== stringId ||
              data.part !== stringPart ||
              typeof data.value !== 'string' ||
              data.value.length !==
                Math.min(
                  conversationStringChunkSize,
                  plan.length - stringPart * conversationStringChunkSize,
                )
            )
              throw new Error('History decoder returned an invalid string fragment.')
            stringValue += data.value
            stringPart++
            if (stringPart === plan.parts) {
              const { parent, key } = conversationStringSlot(stringRoot, plan.path)
              Object.defineProperty(parent, key, {
                value: stringValue,
                enumerable: true,
                configurable: true,
                writable: true,
              })
              stringId++
              stringPart = 0
              stringValue = ''
              if (stringId === stringPlans.length) {
                completeValue?.()
                completeValue = undefined
              }
            }
            break
          }
          case 'done':
            if (
              savedAt === undefined ||
              threads.length !== threadCount ||
              sourceFinalized.some((finalized) => !finalized) ||
              rawMessages.some((messages, index) => messages.length !== counts[index])
            )
              throw new Error('History decoder returned an incomplete snapshot.')
            finish()
            return
          case 'error':
            finish(new Error(data.message))
            return
          default:
            throw new Error('History decoder returned an unknown response.')
        }
        worker.postMessage({ type: 'ack' })
      } catch (error) {
        finish(error)
      }
    }
    signal?.addEventListener('abort', abort, { once: true })
    if (signal?.aborted) return abort()
    try {
      worker.postMessage({ type: 'load', buffer }, [buffer])
    } catch (error) {
      finish(error)
    }
  })
}

export function decodeConversationHistory(
  buffer: ArrayBuffer,
  createWorker: () => Worker = () => new HistoryWorker(),
  signal?: AbortSignal,
): Promise<ConversationHistorySnapshot> {
  return decodeConversationHistoryWithHash(buffer, createWorker, signal).then(
    ({ snapshot }) => snapshot,
  )
}
