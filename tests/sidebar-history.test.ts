import { describe, expect, it } from 'vitest'
import { conversationTurnCount, sidebarHistoryMatches } from '../src/renderer/sidebar-history'
import { compareSidebarThreads } from '../src/renderer/sidebar-ordering'
import type { Message, Thread } from '../src/renderer/state'

const message = (id: string, role: Message['role'], text = id): Message => ({
  id,
  role,
  text,
  turn: 1,
})
const thread = (id: string, messages: Message[], updatedAt = 1): Thread => ({
  id,
  profileId: 'machine',
  provider: 'codex',
  model: 'gpt-5',
  title: id,
  messages,
  pending: [],
  busy: false,
  turn: 1,
  mode: 'review',
  updatedAt,
})

describe('sidebar history work is shared across immutable snapshots', () => {
  it('scans each unchanged history once across sort comparisons and hover counts', () => {
    let reads = 0
    const histories = Array.from({ length: 40 }, (_, index) =>
      Array.from({ length: 400 + index }, (_, item) => ({
        ...message(`${index}:${item}`, item % 3 === 0 ? 'user' : 'assistant'),
        get role() {
          reads++
          return item % 3 === 0 ? ('user' as const) : ('assistant' as const)
        },
      })),
    )
    const threads = histories.map((messages, index) => thread(String(index), messages, index))
    const sorted = [...threads].sort((a, b) => compareSidebarThreads(a, b, 'messages'))
    expect(sorted.map((entry) => entry.id)).toEqual(
      [...threads]
        .sort(
          (a, b) =>
            Math.ceil(b.messages.length / 3) - Math.ceil(a.messages.length / 3) ||
            b.updatedAt - a.updatedAt,
        )
        .map((entry) => entry.id),
    )
    expect(reads).toBe(histories.reduce((sum, messages) => sum + messages.length, 0))
    reads = 0
    for (const entry of threads) conversationTurnCount(entry.messages)
    ;[...threads].sort((a, b) => compareSidebarThreads(a, b, 'messages'))
    expect(reads).toBe(0)
  })

  it('updates counts for appended prompts, steering, replacement, deletion and changed roles', () => {
    const first = message('first', 'user')
    const assistant = message('assistant', 'assistant')
    const messages = [first, assistant]
    expect(conversationTurnCount(messages)).toBe(1)
    expect(conversationTurnCount([...messages, message('steering', 'user')])).toBe(2)
    expect(conversationTurnCount([first, { ...assistant, role: 'user' }])).toBe(2)
    expect(conversationTurnCount([assistant])).toBe(0)
    expect(conversationTurnCount([])).toBe(0)
    expect(conversationTurnCount([message('replacement', 'user')])).toBe(1)
  })

  it('retains exact substring search hits and misses without rereading unrelated histories', () => {
    let reads = 0
    const messages = [
      {
        ...message('message', 'assistant'),
        get text() {
          reads++
          return 'Exact Native Result with ünicode'
        },
      },
    ]
    expect(sidebarHistoryMatches(messages, '')).toBe(true)
    expect(reads).toBe(0)
    expect(sidebarHistoryMatches(messages, 'native result')).toBe(true)
    expect(sidebarHistoryMatches(messages, 'native result')).toBe(true)
    expect(reads).toBe(1)
    expect(sidebarHistoryMatches(messages, 'missing')).toBe(false)
    expect(sidebarHistoryMatches(messages, 'missing')).toBe(false)
    expect(reads).toBe(2)
    expect(sidebarHistoryMatches(messages, 'ünicode')).toBe(true)
    expect(reads).toBe(3)
  })

  it('invalidates matching when native snapshots append, replace, or remove output', () => {
    const original = [message('message', 'assistant', 'first response')]
    expect(sidebarHistoryMatches(original, 'second')).toBe(false)
    expect(
      sidebarHistoryMatches([...original, message('new', 'assistant', 'second')], 'second'),
    ).toBe(true)
    expect(sidebarHistoryMatches([{ ...original[0], text: 'second response' }], 'second')).toBe(
      true,
    )
    expect(sidebarHistoryMatches([], 'second')).toBe(false)
    expect(sidebarHistoryMatches(original, 'second')).toBe(false)
  })
})
