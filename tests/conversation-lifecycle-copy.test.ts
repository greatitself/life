import { describe, expect, it } from 'vitest'
import {
  attachConversationSource,
  clearConversationSourceMessages,
  copyConversationSourceJson,
} from '../src/renderer/conversation-source'
import { applyEvent, readThreads, type Thread } from '../src/renderer/state'
import type { Provider } from '../src/shared/types'

const exact = '  Native completion\r\n\tUnicode café e\u0301 漢字 🧪  '

function fixture(provider: Provider = 'codex') {
  const raw = {
    id: 'native-owner',
    profileId: 'machine-owner',
    provider,
    remoteId: 'original-native-conversation',
    workspace: '/owned/project Ω',
    title: 'Recovered conversation',
    model: '',
    mode: 'review',
    turn: 2,
    busy: true,
    turnStatus: 'running',
    agentStatus: 'running',
    pending: [{ requestId: 'archived-permission', exact }],
    futureThreadMetadata: { exact, values: [null, 17] },
    messages: [
      null,
      { id: 'duplicate', role: 'future-role', exact },
      { id: 'duplicate', role: 'future-role', second: true },
      ['opaque-record', { exact }],
      { id: 'earlier-user', role: 'user', text: exact, turn: 2 },
    ],
  }
  const restored = readThreads([raw])[0]
  const running: Thread = {
    ...restored,
    turn: 3,
    busy: true,
    turnStatus: 'running',
    messages: [...restored.messages, { id: 'new-user', role: 'user', text: exact, turn: 3 }],
  }
  const finished = applyEvent(running, {
    sessionId: running.id,
    type: 'complete',
    status: 'completed',
  })
  return { raw, restored, finished }
}

function marker(thread: Thread) {
  const value = Object.getOwnPropertySymbols(thread).find(
    (key) => key.description === 'Life conversation lifecycle intent',
  )
  expect(value).toBeDefined()
  return value!
}

describe('lossless JSON copy with native lifecycle intent', () => {
  it.each(['codex', 'claude'] as const)(
    'copies a completed recovered %s conversation without leaking private tokens',
    (provider) => {
      const { raw, finished } = fixture(provider)
      const copy = copyConversationSourceJson({ ...finished, title: 'Renamed after completion' })

      expect(copy).toMatchObject({
        title: 'Renamed after completion',
        provider,
        profileId: raw.profileId,
        remoteId: raw.remoteId,
        workspace: raw.workspace,
        busy: false,
        turnStatus: 'completed',
        agentStatus: 'completed',
        futureThreadMetadata: raw.futureThreadMetadata,
        pending: raw.pending,
      })
      expect(copy.messages.slice(0, raw.messages.length)).toEqual(raw.messages)
      expect(copy.messages).toContainEqual(
        expect.objectContaining({ id: 'new-user', text: exact, finishStatus: 'completed' }),
      )
      expect(Object.getOwnPropertySymbols(copy)).toEqual([])
      expect(JSON.stringify(copy)).not.toContain('lifecycleIntent')
    },
  )

  it('keeps passive recovery byte-equivalent without authoring terminal state', () => {
    const { raw, restored } = fixture()
    expect(copyConversationSourceJson(restored)).toEqual(raw)
  })

  it('copies an explicit clear while retaining authored completion and unknown metadata', () => {
    const { raw, finished } = fixture()
    const copy = copyConversationSourceJson(clearConversationSourceMessages(finished))
    expect(copy).toMatchObject({
      busy: false,
      turnStatus: 'completed',
      agentStatus: 'completed',
      messages: [],
      futureThreadMetadata: raw.futureThreadMetadata,
      pending: raw.pending,
    })
  })

  it('rejects an unregistered token under the genuine private lifecycle symbol', () => {
    const { finished } = fixture()
    const forged = { ...finished, [marker(finished)]: {} }
    expect(() => copyConversationSourceJson(forged)).toThrow('unsupported key')
  })

  it('strips an expired private token without reviving its old authority', () => {
    const { raw, finished } = fixture()
    const replacement = { ...raw, turn: finished.turn }
    attachConversationSource(finished, replacement)
    expect(copyConversationSourceJson(finished)).toEqual(replacement)
  })
})
