import { Schema } from 'effect'
import type { ConversationHistorySnapshot } from '../shared/conversations'
import type { Thread } from './state'
import type { ConversationStringPlan } from './conversation-load-values'

export type ConversationLoadPacket =
  | {
      type: 'start'
      savedAt: number
      threadCount: number
      checkpointEligible?: boolean
      hash?: string
    }
  | {
      type: 'thread'
      index: number
      thread: Record<string, unknown>
      messageCount: number
      strings?: ConversationStringPlan[]
    }
  | { type: 'messages'; index: number; messages: unknown[]; strings?: ConversationStringPlan[] }
  | { type: 'string'; id: number; part: number; value: string }
  | { type: 'done' }
  | { type: 'error'; message: string }

export const conversationLoadHashSchema = Schema.String.check(Schema.isPattern(/^[0-9a-f]{64}$/))

// Only completed loads from the owned parser are admitted here. A marker on
// persisted or IPC data cannot bypass the established normalization policy.
const normalized = new WeakSet<ConversationHistorySnapshot>()
const nativeSources = new WeakMap<ConversationHistorySnapshot, Thread[]>()
export function markNormalizedConversationHistory(
  snapshot: ConversationHistorySnapshot,
  rawNativeSource?: Thread[],
): void {
  normalized.add(snapshot)
  if (rawNativeSource) nativeSources.set(snapshot, rawNativeSource)
}
export function normalizedConversationThreads(
  snapshot: ConversationHistorySnapshot,
): Thread[] | undefined {
  return normalized.has(snapshot) ? (snapshot.threads as Thread[]) : undefined
}

/** Only the complete owned native source can seed a durable checkpoint baseline. */
export function nativeCheckpointConversationThreads(
  snapshot: ConversationHistorySnapshot,
): Thread[] | undefined {
  return nativeSources.get(snapshot)
}
