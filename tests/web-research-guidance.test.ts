import { afterEach, describe, expect, it, vi } from 'vitest'
import { researchOperations } from '../src/shared/research-method'

afterEach(() => {
  vi.unstubAllEnvs()
  vi.resetModules()
})

describe('web Research queue migration', () => {
  it.each(['VITE_LIFE_WEB_APP', 'VITE_LIFE_WEB_PREVIEW'])(
    'drops stored approach selections in %s while preserving prompts and files',
    async (flag) => {
      vi.stubEnv('VITE_LIFE_WEB_APP', 'false')
      vi.stubEnv('VITE_LIFE_WEB_PREVIEW', 'false')
      vi.stubEnv(flag, 'true')
      vi.resetModules()
      const { normalizeQueuedMessages } = await import('../src/renderer/thread-queue')
      const messages = researchOperations.map((researchOperation, index) => ({
        id: 'queued-' + index,
        text: '  Use the approach I describe here.\n  ',
        createdAt: 10,
        attachments: [{ id: 'file-one', name: 'notes.txt', size: 12, mime: 'text/plain' }],
        researchOperation,
      }))
      const restored = normalizeQueuedMessages(messages)
      expect(restored).toHaveLength(messages.length)
      for (const [index, message] of restored.entries()) {
        expect(message).not.toHaveProperty('researchOperation')
        expect(message.text).toBe(messages[index].text)
        expect(message.paused).toBe(true)
        expect(message.attachments).toEqual(messages[index].attachments)
      }
    },
  )
})
