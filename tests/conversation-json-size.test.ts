import { describe, expect, it } from 'vitest'
import { jsonCharacterSize } from '../src/renderer/conversation-json-size'

function expectExactSize(value: unknown): void {
  expect(jsonCharacterSize(value)).toBe(JSON.stringify(value).length)
}

describe('conversation JSON character sizing', () => {
  it('matches JSON serialization for escaped strings, keys, scalar values and nested metadata', () => {
    const controls = Array.from({ length: 32 }, (_, index) => String.fromCharCode(index)).join('')
    const strings = [
      '',
      '  Exact\r\n\tΩ café é 漢字 🧪  ',
      '"\\' + controls,
      '\u2028\u2029',
      '\ud800',
      '\udfff',
      '\ud800🧪\udc00',
      '\ud800\ud800\udc00\udc00',
      'x'.repeat(64 * 1024 - 1) + '🧪\r\n',
    ]
    for (const value of [
      null,
      true,
      false,
      0,
      -0,
      1.5,
      1e20,
      1e21,
      1e-7,
      Number.MAX_VALUE,
      Number.MIN_VALUE,
      NaN,
      Infinity,
      -Infinity,
      [],
      {},
      ...strings,
    ])
      expectExactSize(value)
    for (const text of strings)
      expectExactSize({
        [text]: text,
        messages: [
          {
            id: 'message',
            role: 'user',
            text,
            input: text,
            futureMessageMetadata: { nested: ['exact', 1, null], details: { [text]: text } },
          },
        ],
        queue: [{ text, attachments: [] }],
      })
    expectExactSize(Object.fromEntries([['__proto__', { text: 'preserved own property' }]]))
    const nullPrototype = Object.assign(Object.create(null), { text: 'exact' })
    expectExactSize(nullPrototype)
    expectExactSize(JSON.parse('{"number":1e400}'))
  })

  it('omits undefined object fields and counts undefined or missing array entries as null', () => {
    expectExactSize({ missing: undefined, nested: { missing: undefined }, present: true })
    const sparse = new Array(4)
    sparse[1] = undefined
    sparse[2] = { omitted: undefined, present: 'text' }
    sparse[3] = [undefined]
    expectExactSize(sparse)
  })

  it('matches a deterministic corpus of arbitrary UTF-16 strings and nested JSON values', () => {
    let seed = 0x0badf00d
    const random = () => {
      seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0
      return seed
    }
    for (let index = 0; index < 2_048; index++) {
      let text = ''
      for (let character = 0; character < 32; character++)
        text += String.fromCharCode(random() % 65_536)
      expectExactSize({
        [text]: [text, random() / 17, null, true, false, { input: text, text: 'plain' }],
        metadata: { unknown: [{ [text]: text }], empty: {} },
      })
    }
  })

  it('sizes an 8 MiB scalar without changing surrogate or exact prompt content', () => {
    const text = 'x'.repeat(8 * 1024 * 1024 - 1) + '🧪\r\n\ud800'
    const value = { id: 'large-message', role: 'user', text, input: '  Exact provider input\r\n  ' }
    expectExactSize(value)
    expect(value.text).toBe(text)
  })

  it('rejects values outside plain JSON data instead of estimating their serialization', () => {
    for (const value of [undefined, () => 1, Symbol('value'), 1n, new Date(), new Map()])
      expect(() => jsonCharacterSize(value)).toThrow(TypeError)
    expect(() => jsonCharacterSize({ toJSON: () => ({ text: 'different' }) })).toThrow(TypeError)
    expect(() => jsonCharacterSize([Symbol('value')])).toThrow(TypeError)
  })
})
