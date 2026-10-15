import { describe, expect, it } from 'vitest'
import { projectConversationSource } from '../src/renderer/conversation-source'
import { readThreads, type Message } from '../src/renderer/state'
import { isSubagentActivity, isSubagentLaunch } from '../src/renderer/thread-activity'
import { normalizeMessageMetadata } from '../src/renderer/thread-metadata'

const exact = '  exact\r\nUnicode café e\u0301 漢字 🧪  \n'
const rawThread = (messages: unknown[]) => ({
  id: 'history',
  profileId: 'machine',
  provider: 'codex',
  workspace: '/project',
  remoteId: 'native-session-Ω',
  title: 'Recovered history',
  updatedAt: 1,
  messages,
})
const json = (value: unknown): unknown => JSON.parse(JSON.stringify(value))
const futureValues: Array<{ label: string; value: unknown }> = [
  { label: 'non-callable toString', value: { toString: 'future' } },
  { label: 'non-callable coercion methods', value: { toString: null, valueOf: 'future' } },
  { label: 'array', value: ['subagent'] },
  { label: 'number', value: 42 },
  { label: 'boolean', value: true },
]
const futureTitles = futureValues.map((item) =>
  item.label === 'array' ? { ...item, value: ['spawn_agent'] } : item,
)

describe('readable native history with future metadata shapes', () => {
  it.each(futureValues)(
    'ignores a non-string kind in the display view and retains its raw value: $label',
    ({ value: kind }) => {
      const raw = rawThread([
        { id: 'first', role: 'user', text: exact, input: exact, kind },
        { id: 'second', role: 'assistant', text: exact, kind: 'plan' },
      ])
      const restored = readThreads([raw])
      expect(restored).toHaveLength(1)
      expect(restored[0].messages.map((message) => message.id)).toEqual(['first', 'second'])
      expect(restored[0].messages[0]).toMatchObject({ text: exact, input: exact })
      expect(restored[0].messages[0].kind).toBeUndefined()
      expect(restored[0].messages[1].kind).toBe('plan')
      expect(json(projectConversationSource(restored[0]))).toEqual(raw)
      expect(normalizeMessageMetadata({ kind })).toEqual({})
    },
  )

  it.each(futureTitles)(
    'admits a readable tool without coercing a non-string title: $label',
    ({ value: title }) => {
      const raw = rawThread([
        { id: 'tool', role: 'tool', text: exact, input: exact, title },
        { id: 'later', role: 'assistant', text: exact },
      ])
      const restored = readThreads([raw])
      expect(restored).toHaveLength(1)
      expect(restored[0].messages.map((message) => message.id)).toEqual(['tool', 'later'])
      expect(restored[0].messages[0]).toMatchObject({ text: exact, input: exact })
      expect(restored[0].messages[0].title).toBeUndefined()
      expect(restored[0].messages[0].activityStateUnknown).toBeUndefined()
      expect(json(projectConversationSource(restored[0]))).toEqual(raw)
      const tool = raw.messages[0] as Message
      expect(isSubagentActivity(tool)).toBe(false)
      expect(isSubagentLaunch(tool)).toBe(false)
    },
  )

  it('still recognizes reported subagent titles and explicit subagent metadata', () => {
    const raw = rawThread([
      { id: 'launch', role: 'tool', text: exact, title: 'spawn_agent' },
      {
        id: 'activity',
        role: 'tool',
        text: exact,
        kind: 'subagent',
        title: { toString: 'future' },
      },
    ])
    const restored = readThreads([raw])[0]
    expect(restored.messages).toHaveLength(2)
    expect(restored.messages[0].activityStateUnknown).toBe(true)
    expect(restored.messages[1].activityStateUnknown).toBe(true)
    expect(isSubagentLaunch(restored.messages[0])).toBe(true)
    expect(isSubagentActivity(restored.messages[1])).toBe(true)
    expect(json(projectConversationSource(restored))).toEqual(raw)
  })
})
