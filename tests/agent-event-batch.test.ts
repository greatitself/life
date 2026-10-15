import { afterEach, describe, expect, it, vi } from 'vitest'
import type { AgentEvent } from '../src/shared/types'
import { AgentEventBatch, coalesceAgentEvents } from '../src/renderer/agent-event-batch'
import { applyEvent, type Thread } from '../src/renderer/state'

afterEach(() => vi.useRealTimers())

const event = (type: AgentEvent['type'], text = ''): AgentEvent => ({
  sessionId: 'thread',
  type,
  text,
})

function thread(overrides: Partial<Thread> = {}): Thread {
  return {
    id: 'thread',
    profileId: 'machine',
    workspace: '/srv/project',
    provider: 'codex',
    title: 'Untitled thread',
    remoteId: 'native-provider-session',
    messages: [
      { id: 'user-1', role: 'user', text: '  Exact prompt.\r\n\n', turn: 1, createdAt: 10 },
    ],
    busy: true,
    turnStatus: 'running',
    model: 'model-a',
    mode: 'review',
    updatedAt: 10,
    turn: 1,
    pending: [],
    ...overrides,
  }
}

describe('adjacent streaming delta compaction', () => {
  it('joins only adjacent text and reasoning fragments once without mutating raw events', () => {
    const details = Object.freeze({ nativeTurnId: 'turn-a', source: 'native' })
    const tokens = Object.freeze([
      Object.freeze({ ...event('text', '  A\r'), itemId: 'answer', details }),
      Object.freeze({ ...event('text', '\n\ud83d'), itemId: 'answer', details }),
      Object.freeze({ ...event('text', '\ude42\n'), itemId: 'answer', details }),
      Object.freeze({ ...event('reasoning', 'Check '), itemId: 'analysis' }),
      Object.freeze({ ...event('reasoning', 'invariants.\n'), itemId: 'analysis' }),
    ])
    const compacted = coalesceAgentEvents(tokens)
    expect(compacted).toEqual([
      { ...tokens[0], text: '  A\r\n🙂\n' },
      { ...tokens[3], text: 'Check invariants.\n' },
    ])
    expect(compacted[0].details).toBe(details)
    expect(tokens.map((token) => token.text)).toEqual([
      '  A\r',
      '\n\ud83d',
      '\ude42\n',
      'Check ',
      'invariants.\n',
    ])
  })

  it('returns the original array and events when there is no contiguous append run', () => {
    const tokens = [event('text', 'A'), event('reasoning', 'B'), event('text', 'C')]
    expect(coalesceAgentEvents(tokens)).toBe(tokens)
    const empty: AgentEvent[] = []
    expect(coalesceAgentEvents(empty)).toBe(empty)
  })

  it.each([
    ['sessionId', 'another-thread'],
    ['type', 'reasoning'],
    ['itemId', 'another-item'],
    ['title', 'Changed title'],
    ['requestId', 'another-request'],
    ['remoteId', 'another-native-session'],
    ['questions', [{ id: 'scope', question: 'Another question?' }]],
    ['status', 'running'],
    ['phase', 'final_answer'],
    ['input', 'Another input'],
    ['agentId', 'another-agent'],
    ['agentName', 'Another agent name'],
    ['parentItemId', 'another-parent'],
    ['provider', 'claude'],
    ['details', { nativeTurnId: 'another-turn' }],
  ] as const)('preserves a distinct %s metadata boundary', (key, value) => {
    const first: AgentEvent = {
      ...event('text', 'A'),
      itemId: 'answer',
      title: 'Title',
      requestId: 'request',
      remoteId: 'native-session',
      questions: [{ id: 'scope', question: 'Question?' }],
      phase: 'commentary',
      input: 'Input',
      agentId: 'agent',
      agentName: 'Agent name',
      parentItemId: 'parent',
      provider: 'codex',
      details: { nativeTurnId: 'turn' },
    }
    const next = { ...first, text: 'B', [key]: value } as AgentEvent
    const tokens = [first, next]
    expect(coalesceAgentEvents(tokens)).toBe(tokens)
  })

  it('keeps separate structured payloads, explicit absent keys, and future metadata keys', () => {
    for (const tokens of [
      [
        { ...event('text', 'A'), details: { source: 'native' } },
        { ...event('text', 'B'), details: { source: 'native' } },
      ],
      [event('text', 'A'), { ...event('text', 'B'), agentId: undefined }],
      [
        { ...event('text', 'A'), nativeSequence: 1 },
        { ...event('text', 'B'), nativeSequence: 2 },
      ],
    ])
      expect(coalesceAgentEvents(tokens)).toBe(tokens)
  })

  it('does not combine replacement snapshots, empty payload metadata, or tool output', () => {
    const tokens: AgentEvent[] = [
      { ...event('text', 'A'), status: 'replace' },
      { ...event('text', 'B'), status: 'replace' },
      { sessionId: 'thread', type: 'text' },
      { sessionId: 'thread', type: 'text' },
      event('tool-output', 'ab'),
      event('tool-output', 'c'),
    ]
    expect(coalesceAgentEvents(tokens)).toBe(tokens)
  })

  it('retains untouched events around a compacted run in exact wire order', () => {
    const before = event('status', 'Running')
    const after = event('approval', 'Allow command?')
    const tokens = [before, event('text', 'A'), event('text', 'B'), after]
    const compacted = coalesceAgentEvents(tokens)
    expect(compacted).toEqual([before, event('text', 'AB'), after])
    expect(compacted[0]).toBe(before)
    expect(compacted[2]).toBe(after)
  })

  it('matches the complete real thread projection across metadata, phase, and actionable boundaries', () => {
    vi.useFakeTimers()
    vi.setSystemTime(1000)
    const details = { nativeTurnId: 'native-turn', source: 'native', nested: { exact: true } }
    const child = { agentId: 'child', agentName: 'Reviewer', parentItemId: 'delegation' }
    const tokens: AgentEvent[] = [
      { ...event('session'), remoteId: 'native-provider-session', title: 'Native title' },
      { ...event('text', '  Inspect '), itemId: 'answer', phase: 'commentary', details },
      { ...event('text', 'the code.\r\n'), itemId: 'answer', phase: 'commentary', details },
      { ...event('reasoning', 'Check '), itemId: 'analysis', ...child, details },
      { ...event('reasoning', 'edge cases.\n'), itemId: 'analysis', ...child, details },
      { ...event('text', 'First '), itemId: 'answer', phase: 'final_answer' },
      { ...event('text', 'answer.'), itemId: 'answer', phase: 'final_answer' },
      {
        ...event('text', 'Exact final\n'),
        itemId: 'answer',
        phase: 'final_answer',
        status: 'replace',
      },
      { ...event('text', 'Append '), itemId: 'answer', phase: 'final_answer' },
      { ...event('text', 'after snapshot.\n'), itemId: 'answer', phase: 'final_answer' },
      { ...event('tool', 'ab'), itemId: 'shell', input: 'ab', status: 'running' },
      { ...event('tool-output', 'ab'), itemId: 'shell' },
      { ...event('tool-output', 'c'), itemId: 'shell' },
      { ...event('approval', 'Allow validation?'), requestId: 'permission', details },
      { ...event('text', 'Still '), itemId: 'answer', phase: 'final_answer' },
      { ...event('text', 'ordered.\n'), itemId: 'answer', phase: 'final_answer' },
      { ...event('request-resolved'), requestId: 'permission', status: 'completed' },
      { ...event('complete'), status: 'completed' },
    ]
    const original = thread()
    const expected = tokens.reduce(applyEvent, original)
    const compacted = coalesceAgentEvents(tokens)
    expect(compacted.length).toBeLessThan(tokens.length)
    const projected = compacted.reduce(applyEvent, original)
    expect(projected).toEqual(expected)
    expect(projected.remoteId).toBe('native-provider-session')
    expect(projected.messages[0].text).toBe(original.messages[0].text)
    expect(projected.messages.find((message) => message.id === '1:shell')?.text).toBe('c')
    expect(projected.messages.find((message) => message.agentId === 'child')).toMatchObject({
      text: 'Check edge cases.\n',
      details,
      ...child,
    })
  })

  it('matches append projection when a restored uncertain message resumes', () => {
    vi.useFakeTimers()
    vi.setSystemTime(1000)
    const original = thread({
      messages: [
        {
          id: '1:answer',
          role: 'assistant',
          text: 'Retained history.\n',
          turn: 1,
          status: 'unknown',
          createdAt: 10,
          finishedAt: 20,
          finishStatus: 'unknown',
          details: { retained: true },
        },
      ],
    })
    const tokens = [
      { ...event('text', 'Resumed '), itemId: 'answer', status: 'running' },
      { ...event('text', 'output.\n'), itemId: 'answer', status: 'running' },
    ]
    const compacted = coalesceAgentEvents(tokens)
    expect(compacted).toHaveLength(1)
    expect(compacted.reduce(applyEvent, original)).toEqual(tokens.reduce(applyEvent, original))
  })
})

describe('agent streaming render batches', () => {
  it('renders a token burst once without changing content or wire order', () => {
    vi.useFakeTimers()
    const deliver = vi.fn()
    const batch = new AgentEventBatch(deliver)
    const tokens = Array.from({ length: 100 }, (_, index) => event('text', `${index}🙂`))
    tokens.forEach((token) => batch.push(token))
    expect(deliver).not.toHaveBeenCalled()
    vi.advanceTimersByTime(16)
    expect(deliver).toHaveBeenCalledExactlyOnceWith(tokens)
    batch.dispose()
  })

  it.each(['approval', 'question', 'request-resolved', 'complete', 'error'] as const)(
    'delivers queued deltas before an immediate %s event',
    (type) => {
      vi.useFakeTimers()
      const deliver = vi.fn()
      const batch = new AgentEventBatch(deliver)
      const tokens = [event('text', 'A'), event('reasoning', 'B'), event(type)]
      tokens.forEach((token) => batch.push(token))
      expect(deliver).toHaveBeenCalledExactlyOnceWith(tokens)
      vi.runAllTimers()
      expect(deliver).toHaveBeenCalledTimes(1)
      batch.dispose()
    },
  )

  it('flushes the last received tokens on reload and ignores callbacks after disposal', () => {
    vi.useFakeTimers()
    const deliver = vi.fn()
    const batch = new AgentEventBatch(deliver)
    batch.push(event('tool-output', 'last bytes'))
    batch.dispose()
    expect(deliver).toHaveBeenCalledExactlyOnceWith([event('tool-output', 'last bytes')])
    batch.push(event('text', 'late'))
    vi.runAllTimers()
    expect(deliver).toHaveBeenCalledTimes(1)
  })

  it('bounds an incoming burst even before its render timer runs', () => {
    vi.useFakeTimers()
    const deliver = vi.fn()
    const batch = new AgentEventBatch(deliver)
    for (let index = 0; index < 501; index++) batch.push(event('text', String(index)))
    expect(deliver).toHaveBeenCalledTimes(1)
    expect(deliver.mock.calls[0][0]).toHaveLength(500)
    vi.advanceTimersByTime(16)
    expect(deliver.mock.calls[1][0]).toEqual([event('text', '500')])
    batch.dispose()
  })
})
