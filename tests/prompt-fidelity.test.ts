import { describe, expect, it } from 'vitest'
import { agentSteerSchema, startSchema } from '../src/shared/validation'

const base = { sessionId: 'thread', provider: 'codex', mode: 'review' } as const
describe('literal user input at the native bridge', () => {
  it.each([
    '  leading and trailing  ',
    '\tUnicode 🌿\n\nline two\r\n',
    '/life change the model',
    '/project keep these exact words',
  ])('preserves the submitted bytes: %j', (prompt) => {
    expect(startSchema.parse({ ...base, prompt }).prompt).toBe(prompt)
    expect(agentSteerSchema.parse({ sessionId: base.sessionId, prompt }).prompt).toBe(prompt)
  })
  it('allows a selected attachment with no invented filler message', () => {
    const input = {
      prompt: '',
      attachments: [{ remotePath: '/home/me/image.png', name: 'image.png', mimeType: 'image/png' }],
    }
    expect(startSchema.parse({ ...base, ...input }).prompt).toBe('')
    expect(agentSteerSchema.parse({ sessionId: base.sessionId, ...input }).prompt).toBe('')
    expect(startSchema.safeParse({ ...base, prompt: ' \n' }).success).toBe(false)
  })
  it.each(['baseInstructions', 'developerInstructions', 'instructions'])(
    'rejects hidden instruction override %s in normal provider configuration',
    (key) => {
      expect(
        startSchema.safeParse({
          ...base,
          prompt: 'my words',
          providerOptions: { thread: { [key]: 'hidden words' } },
        }).success,
      ).toBe(false)
    },
  )
  it('admits app instruction files only in the dedicated Studio scope', () => {
    const studioContext = {
      instructions: '# Life Studio\nRead .life/context.json.',
      files: [{ path: '.life/context.json', content: '{}' }],
      revision: 0,
      phase: 'request',
    }
    expect(startSchema.safeParse({ ...base, prompt: 'my words', studioContext }).success).toBe(
      false,
    )
    expect(
      startSchema.parse({ ...base, prompt: 'my words', scope: 'life-customization', studioContext })
        .prompt,
    ).toBe('my words')
  })
})
