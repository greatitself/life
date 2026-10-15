import type { Message } from './state'

// Transcript updates replace message arrays. Weak keys let removed histories and
// old streamed snapshots be collected without retaining copies of message text.
const conversationCounts = new WeakMap<readonly Message[], number>()
const historyMatches = new WeakMap<readonly Message[], { query: string; matches: boolean }>()

export function conversationTurnCount(messages: readonly Message[]): number {
  const cached = conversationCounts.get(messages)
  if (cached !== undefined) return cached
  let count = 0
  for (const message of messages) if (message.role === 'user') count++
  conversationCounts.set(messages, count)
  return count
}

/** Remember only the latest query for each immutable history, including misses. */
export function sidebarHistoryMatches(messages: readonly Message[], query: string): boolean {
  if (!query) return true
  const cached = historyMatches.get(messages)
  if (cached?.query === query) return cached.matches
  const matches = messages.some((message) => message.text.toLowerCase().includes(query))
  historyMatches.set(messages, { query, matches })
  return matches
}
