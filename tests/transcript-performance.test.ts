import { describe, expect, it } from 'vitest'
import { MarkdownRenderCache } from '../src/renderer/markdown-render-cache'
import { createActivityRowsProjector } from '../src/renderer/thread-activity-rows'
import { createTurnGroupProjector, groupThreadTurns } from '../src/renderer/thread-presentation'
import { splitSourceMessage } from '../src/renderer/source-presentation'
import type { Message } from '../src/renderer/state'

const message = (
  id: string,
  role: Message['role'],
  turn = 1,
  extra: Partial<Message> = {},
): Message => ({
  id,
  role,
  turn,
  text: id,
  ...extra,
})

describe('bounded settled Markdown render reuse', () => {
  it('reuses immutable descriptions by exact text and refreshes their LRU position', () => {
    const cache = new MarkdownRenderCache<object>(20, 2, 20)
    const first = cache.render('first', () => ({ value: 1 }))
    cache.render('second', () => ({ value: 2 }))
    expect(
      cache.render('first', () => {
        throw new Error('Reparsed cached text')
      }),
    ).toBe(first)
    cache.render('third', () => ({ value: 3 }))
    let replaced = false
    cache.render('second', () => {
      replaced = true
      return {}
    })
    expect(replaced).toBe(true)
  })

  it('evicts by retained source characters independently of entry count', () => {
    const cache = new MarkdownRenderCache<object>(8, 100, 20)
    const first = cache.render('aaaa', () => ({}))
    cache.render('bbbbb', () => ({}))
    expect(cache.render('aaaa', () => ({}))).not.toBe(first)
  })

  it('does not retain oversized bodies or descriptions when caching is disabled', () => {
    const cache = new MarkdownRenderCache<object>(100, 2, 4)
    expect(cache.render('large', () => ({}))).not.toBe(cache.render('large', () => ({})))
    const disabled = new MarkdownRenderCache<object>(100, 0, 100)
    expect(disabled.render('small', () => ({}))).not.toBe(disabled.render('small', () => ({})))
  })
})

describe('ordinary Markdown source scanning fast path', () => {
  it('preserves complete ordinary text and empty messages', () => {
    const text = '  Exact prose.\r\n\n```ts\nconst value = "<tag>";\n```\n'
    expect(splitSourceMessage(text)).toEqual([{ kind: 'text', text }])
    expect(splitSourceMessage('')).toEqual([])
  })

  it('retains fenced literals and native source payload parsing when an opening tag exists', () => {
    const literal = '```xml\n<life-source>{}</life-source>\n```\n'
    expect(splitSourceMessage(literal)).toEqual([{ kind: 'text', text: literal }])
    const payload = JSON.stringify({
      summary: 'An exact patch',
      files: [{ path: 'src/a.ts', content: '</life-source>' }],
    })
    expect(splitSourceMessage('<life-source>' + payload + '</life-source>')).toMatchObject([
      { kind: 'source', raw: payload, complete: true, malformed: false },
    ])
  })
})

describe('stable active-turn activity rows', () => {
  it('retains a completed batch and its cards while a later response streams', () => {
    const project = createActivityRowsProjector()
    const tool = message('tool', 'tool', 1, { title: 'Bash', status: 'completed' })
    const response = message('response', 'assistant')
    const first = project([tool, response])
    const streamed = project([tool, { ...response, text: 'More response' }])
    expect(streamed[0]).toBe(first[0])
    expect(streamed[1]).not.toBe(first[1])
    expect('messages' in streamed[0] && streamed[0].messages).toBe(
      'messages' in first[0] && first[0].messages,
    )
  })

  it('refreshes child changes, batch boundaries, failures and context while preserving message order', () => {
    const project = createActivityRowsProjector()
    const tool = message('tool', 'tool', 1, { title: 'Bash' })
    const child = message('child', 'tool', 1, {
      kind: 'subagent',
      agentId: 'child',
      status: 'running',
    })
    const status = message('status', 'tool', 1, { kind: 'status' })
    const initial = project([tool, child, status])
    expect(initial.map((row) => row.kind)).toEqual(['tools', 'agents', 'context'])
    const changed = project([tool, { ...child, status: 'failed' }, status])
    expect(changed[0]).toBe(initial[0])
    expect(changed[1]).not.toBe(initial[1])
    expect(changed[2]).toBe(initial[2])
    const inserted = message('inserted', 'assistant')
    const reordered = project([child, inserted, tool, status])
    expect(
      reordered
        .flatMap((row) => ('messages' in row ? row.messages : [row.message]))
        .map((item) => item.id),
    ).toEqual(['child', 'inserted', 'tool', 'status'])
  })
})

describe('incremental turn projection preserves complete history', () => {
  it('reuses all unchanged turns, including appended late child activity and new turns', () => {
    const project = createTurnGroupProjector()
    const first = message('first', 'user', 1)
    const second = message('second', 'user', 2)
    const original = project([first, second])
    expect(project([first, second])).toBe(original)
    const child = message('child', 'tool', 1, { agentId: 'child' })
    const late = project([first, second, child])
    expect(late[0]).not.toBe(original[0])
    expect(late[1]).toBe(original[1])
    const third = message('third', 'user', 3)
    const extended = project([first, second, child, third])
    expect(extended.slice(0, 2)).toEqual(late)
    expect(extended[2].user).toBe(third)
  })

  it('matches fresh projection after histories are replaced, reordered, shortened, or assigned new turns', () => {
    const project = createTurnGroupProjector()
    const first = message('first', 'user', 1)
    const response = message('response', 'assistant', 1)
    const second = message('second', 'user', 2)
    for (const messages of [
      [first, response, second],
      [second, first, response],
      [first, response],
      [first, { ...response, turn: 4 }],
      [],
      [second],
    ])
      expect(project(messages)).toEqual(groupThreadTurns(messages))
  })
})
