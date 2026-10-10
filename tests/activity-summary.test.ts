import { describe, expect, it } from 'vitest'
import type { Message } from '../src/renderer/state'
import { activitySummary } from '../src/renderer/thread-presentation'

function message(text: string, patch: Partial<Message> = {}): Message {
  return { id: 'activity', role: 'assistant', turn: 1, kind: 'reasoning', text, ...patch }
}

describe('activity summaries', () => {
  it.each([
    ['**Inspecting the renderer**\nDetails.', 'Inspecting the renderer'],
    ['\n \r\n\t\n## **Read** `provider` output\r\nDetails.', 'Read provider output'],
    [' \t- **Keep** exact input\nDetails.', 'Keep exact input'],
    ['* **Keep** exact output\nDetails.', 'Keep exact output'],
    ['####### Seven heading markers\nDetails.', '####### Seven heading markers'],
    ['\n***\n`\n###\nLater text.', '###'],
    ['1. Keep numbered text\nDetails.', '1. Keep numbered text'],
    ['Line one\rLine two\nDetails.', 'Line one\rLine two'],
    ['', 'Agent activity'],
    ['\n \r\n\t\n**\n`\n', 'Agent activity'],
  ])('preserves the first meaningful cleaned line for %j', (text, expected) => {
    expect(activitySummary(message(text))).toBe(expected)
  })

  it('uses exact provider titles while suppressing reasoning labels and preferring plans', () => {
    const text = '**Inspecting** the renderer\nDetails.'
    expect(activitySummary(message(text, { title: '  Read **exact** provider title  ' }))).toBe(
      'Read **exact** provider title',
    )
    for (const title of ['Reasoning', '  REASONING SUMMARY  ', '   ']) {
      expect(activitySummary(message(text, { title }))).toBe('Inspecting the renderer')
    }
    expect(activitySummary(message(text, { title: 'Reasoning summaries' }))).toBe(
      'Reasoning summaries',
    )
    expect(activitySummary(message(text, { kind: 'plan', title: 'Provider title' }))).toBe(
      'Updated the plan',
    )
  })

  it('retains the exact 120-character boundary after cleaning', () => {
    const exact = 'x'.repeat(120)
    expect(activitySummary(message(`**${exact}**\nDetails.`))).toBe(exact)
    expect(activitySummary(message(`**${exact}y**\nDetails.`))).toBe(`${exact}…`)
    const unicode = '😀'.repeat(61)
    expect(activitySummary(message(unicode))).toBe(`${unicode.slice(0, 120)}…`)
  })

  it('keeps a short summary for a large body and refreshes immutable streamed replacements', () => {
    const original = message('**Inspecting the renderer**\n' + 'Settled body.\n'.repeat(120_000))
    expect(activitySummary(original)).toBe('Inspecting the renderer')
    expect(activitySummary(original)).toBe('Inspecting the renderer')
    expect(activitySummary({ ...original, text: '**Running the checks**\n' + original.text })).toBe(
      'Running the checks',
    )
    expect(activitySummary({ ...original, title: 'Updated provider operation' })).toBe(
      'Updated provider operation',
    )
  })
})
