import { describe, expect, it, vi } from 'vitest'
import type { ConversationCheckpointInput } from '../src/shared/conversations'
import {
  ConversationCheckpointClient,
  createConversationCheckpointProjector,
} from '../src/renderer/conversation-checkpoint-client'
import type { Thread } from '../src/renderer/state'

function history(messages: unknown[]): Thread[] {
  return [
    {
      id: 'thread',
      profileId: 'workspace',
      provider: 'codex',
      title: 'Exact raw history',
      messages,
      futureThreadField: { retained: true },
    },
  ] as unknown as Thread[]
}

describe('opaque native message checkpoint identities', () => {
  it.each([null, 42, true, 'opaque future message\r\n🧪', [], { future: 'unknown row' }])(
    'adopts the exact durable baseline for opaque message value %j without sending its body',
    async (opaque) => {
      const original = history([
        { id: 'readable', role: 'user', text: '  Exact prompt\r\n🧪  ' },
        opaque,
      ])
      const client = new ConversationCheckpointClient()
      const save = vi.fn(async () => {})
      const checkpoint = vi.fn(async (input: ConversationCheckpointInput) => ({
        savedAt: input.savedAt,
      }))
      expect(
        client.adoptDurableBaseline(original, 100, save, checkpoint, {
          supportsMessageFields: true,
        }),
      ).toBe(true)
      await expect(
        client.submit(original, 200, save, checkpoint, { supportsMessageFields: true }),
      ).resolves.toBe(200)
      expect(save).not.toHaveBeenCalled()
      expect(checkpoint).toHaveBeenCalledExactlyOnceWith({
        version: 1,
        baseSavedAt: 100,
        savedAt: 200,
        order: ['thread'],
        upserts: [],
      })
    },
  )

  it.each([null, 42, false, 'opaque future message', [], { future: 'unknown row' }])(
    'falls back to exact message replacement when an existing raw array contains %j',
    (opaque) => {
      const project = createConversationCheckpointProjector()
      const previous = history([{ id: 'readable', role: 'user', text: 'Exact prompt' }, opaque])
      const next = [{ ...previous[0], title: 'Actual title edit' }]
      const packet = project(previous, next, 100, 200, { supportsMessageFields: true })!
      expect(packet.upserts[0].messages).toEqual({
        mode: 'replace',
        values: previous[0].messages,
      })
      if (packet.upserts[0].messages.mode !== 'replace') throw new Error('Expected replacement')
      expect(packet.upserts[0].messages.values).toBe(previous[0].messages)
    },
  )

  it('never treats a message array with an attached id as a durable identified message', () => {
    const opaque: unknown[] & { id?: string } = []
    opaque.id = 'array-identity-is-not-serialized'
    const previous = history([opaque])
    const client = new ConversationCheckpointClient()
    const save = vi.fn(async () => {})
    const checkpoint = vi.fn(async (input: ConversationCheckpointInput) => ({
      savedAt: input.savedAt,
    }))
    expect(client.adoptDurableBaseline(previous, 100, save, checkpoint)).toBe(true)
    const next = [{ ...previous[0], title: 'Changed' }]
    expect(
      createConversationCheckpointProjector()(previous, next, 100, 200)!.upserts[0].messages,
    ).toEqual({ mode: 'replace', values: previous[0].messages })
  })
})
