import { afterEach, describe, expect, it, vi } from 'vitest'
import type { AgentEvent } from '../src/shared/types'
import { AgentEventBatch } from '../src/renderer/agent-event-batch'

afterEach(() => vi.useRealTimers())

const event = (type: AgentEvent['type'], text = ''): AgentEvent => ({
  sessionId: 'thread',
  type,
  text,
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
