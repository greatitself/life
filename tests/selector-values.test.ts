import { describe, expect, it } from 'vitest'
import { parseModelSelection, parsePrefixedSelection } from '../src/renderer/selector-values'

describe('parseModelSelection', () => {
  it.each(['', ' ', '[', '["codex",]', 'undefined'])(
    'ignores a transient empty or malformed form value: %j',
    (value) => {
      expect(parseModelSelection(value)).toBeUndefined()
    },
  )

  it.each([
    null,
    false,
    12,
    'codex',
    { provider: 'codex', model: 'gpt-5.4' },
    [],
    ['codex'],
    ['codex', 'gpt-5.4', 'unexpected'],
    ['other', 'gpt-5.4'],
    ['Codex', 'gpt-5.4'],
    [null, 'gpt-5.4'],
    ['claude', null],
    ['codex', 12],
    ['codex', ['gpt-5.4']],
    ['claude', { model: 'claude-sonnet' }],
  ])('rejects values outside the provider/model tuple: %j', (value) => {
    expect(parseModelSelection(JSON.stringify(value))).toBeUndefined()
  })

  it('accepts the explicit default model and both supported providers', () => {
    expect(parseModelSelection('["codex",""]')).toEqual(['codex', ''])
    expect(parseModelSelection('["claude",""]')).toEqual(['claude', ''])
    expect(parseModelSelection('["codex","gpt-5.4"]')).toEqual(['codex', 'gpt-5.4'])
    expect(parseModelSelection('["claude","claude-sonnet"]')).toEqual(['claude', 'claude-sonnet'])
  })

  it('preserves the model value without trimming or rewriting it', () => {
    const model = '  custom-model\t\n'
    expect(parseModelSelection(JSON.stringify(['claude', model]))).toEqual(['claude', model])
  })

  it('accepts the model length limit and rejects the next character', () => {
    const model = 'm'.repeat(500)
    expect(parseModelSelection(JSON.stringify(['codex', model]))).toEqual(['codex', model])
    expect(parseModelSelection(JSON.stringify(['codex', model + 'm']))).toBeUndefined()
  })

  it('bounds the entire encoded form value, including JSON whitespace', () => {
    const tuple = '["codex","m"]'
    const atLimit = ' '.repeat(1000 - tuple.length) + tuple
    expect(parseModelSelection(atLimit)).toEqual(['codex', 'm'])
    expect(parseModelSelection(' ' + atLimit)).toBeUndefined()
  })
})

describe('parsePrefixedSelection', () => {
  it.each(['', 'choice', 'Choice:high', 'high', ' choice:high'])(
    'ignores transient or unprefixed values: %j',
    (value) => {
      expect(parsePrefixedSelection(value)).toBeUndefined()
    },
  )

  it('distinguishes an explicit clear selection from the transient empty value', () => {
    expect(parsePrefixedSelection('')).toBeUndefined()
    expect(parsePrefixedSelection('choice:')).toBe('')
  })

  it('returns the exact explicit choice, including whitespace and additional colons', () => {
    expect(parsePrefixedSelection('choice:high')).toBe('high')
    expect(parsePrefixedSelection('choice:  custom:tier  ')).toBe('  custom:tier  ')
  })
})
