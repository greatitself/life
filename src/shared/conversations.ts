/** A committed history checkpoint. A missing store is distinct from an intentionally empty one. */
export interface ConversationHistorySnapshot {
  version: 1
  savedAt: number
  threads: unknown[]
}

export const CONVERSATION_CHECKPOINT_BASE_CHANGED = 'CONVERSATION_CHECKPOINT_BASE_CHANGED'

export interface ConversationCheckpointThread extends Record<string, unknown> {
  id: string
  profileId: string
  provider: 'codex' | 'claude'
}

/** Exact own-property edits for an existing message, preserving omitted body fields. */
export interface ConversationMessageFieldCheckpoint {
  id: string
  set: Record<string, unknown>
  remove: string[]
  /** Exact UTF-16 suffixes, admitted only by bridges advertising append support. */
  append?: Record<string, { baseLength: number; value: string }>
}

export type ConversationMessageCheckpoint =
  | { mode: 'replace'; values: unknown[] }
  | {
      mode: 'patch'
      order?: string[]
      upserts: unknown[]
      fields?: ConversationMessageFieldCheckpoint[]
    }

/** An exact change from an acknowledged native checkpoint, including deletion and ordering. */
export interface ConversationCheckpointInput {
  version: 1
  baseSavedAt: number | null
  savedAt: number
  order: string[]
  upserts: { thread: ConversationCheckpointThread; messages: ConversationMessageCheckpoint }[]
  /** Ephemeral projection authority; never part of stored or exported history. */
  projectionAdmissions?: readonly ConversationProjectionAdmission[]
}

export interface ConversationProjectionAdmission {
  sessionId: string
  transportId: string
  appliedRevision: number
  snapshotToken: string
  ownerGeneration: number
  deliveryToken: string
}

export interface ConversationCheckpointAck {
  savedAt: number
  /** Worker-issued proof of the recovery cursors in the exact committed history. */
  nativeRecovery?: ConversationNativeRecoveryReceipt
  /** SHA-256 of the actual committed file, bound to private native preparation. */
  nativeRecoveryHash?: string
}

export interface ConversationNativeRecoveryReceipt {
  snapshotId: string
  owners: {
    sessionId: string
    provider: 'codex' | 'claude'
    profileId: string
    workspace: string
    remoteId: string
    nativeRecovery: Record<
      string,
      { appliedRevision: number; snapshotToken: string; ownerGeneration: number }
    >
  }[]
}
