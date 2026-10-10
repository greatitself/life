/** A committed history checkpoint. A missing store is distinct from an intentionally empty one. */
export interface ConversationHistorySnapshot {
  version: 1
  savedAt: number
  threads: unknown[]
}
