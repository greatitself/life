import { afterEach, describe, expect, it, vi } from 'vitest'
import type { AgentEvent } from '../src/shared/types'
import {
  CONVERSATION_CHECKPOINT_BASE_CHANGED,
  type ConversationCheckpointInput,
  type ConversationProjectionAdmission,
} from '../src/shared/conversations'
import {
  ConversationCheckpointClient,
  createHistorySnapshotProjector,
} from '../src/renderer/conversation-checkpoint-client'
import { getConversationMessageAppend } from '../src/renderer/conversation-message-appends'
import { copyConversationSourceJson } from '../src/renderer/conversation-source'
import { nativeProjectionAdmissions } from '../src/renderer/native-projection-admissions'
import {
  applyEvent,
  applyNativeRecoveryOwner,
  readThreads,
  type Thread,
} from '../src/renderer/state'

const capabilities = { supportsMessageFields: true, supportsMessageAppends: true }
const prefix = '  Exact café e\u0301 漢字 🧪\r\n\t'.repeat(4096)
const firstSuffix = '\r\n native first \ud83e'
const nextSuffix = '\uddea\t native follow-up  '

function event(revision: number, text = '', ownerGeneration = 2): AgentEvent {
  return {
    sessionId: 'thread',
    type: 'text',
    itemId: 'answer',
    text,
    nativeRecovery: {
      transportId: 'transport',
      revision,
      eventId: `event-${revision}`,
      localTurn: 1,
      emittedAt: 100 + revision,
      ownerGeneration,
      snapshotToken: 'native-snapshot',
      deliveryToken: `private-delivery-${revision}`,
    },
  }
}

function admittedThread(): Thread {
  const restored = readThreads([
    {
      id: 'thread',
      profileId: 'machine',
      workspace: '/exact/project',
      provider: 'codex',
      remoteId: 'native-session-Ω',
      title: 'Thread',
      messages: [
        {
          id: '1:answer',
          role: 'assistant',
          text: prefix,
          turn: 1,
          futureMessageField: { exact: '  future message\r\n\ud800' },
        },
      ],
      pending: [],
      busy: true,
      turn: 1,
      updatedAt: 1,
      mode: 'review',
      model: '',
      futureThreadField: { exact: '  future thread\r\nΩ' },
    },
  ])[0]
  return applyEvent(
    applyNativeRecoveryOwner(restored, {
      sessionId: restored.id,
      transportId: 'transport',
      ownerGeneration: 2,
      snapshotToken: 'native-snapshot',
      status: 'running',
      acceptedAppliedRevision: 0,
      pending: [],
    }),
    event(1),
  )
}

function deferred() {
  let resolve!: () => void
  const promise = new Promise<void>((done) => {
    resolve = done
  })
  return { promise, resolve }
}

function expectAppend(input: ConversationCheckpointInput, before: Thread, suffix: string) {
  const messages = input.upserts[0].messages
  if (messages.mode !== 'patch') throw new Error('Expected a message patch')
  expect(messages.fields?.find((field) => field.id === '1:answer')?.append).toEqual({
    text: { baseLength: before.messages[0].text.length, value: suffix },
  })
  expect(messages.upserts).toEqual([])
  expect(JSON.stringify(input).length).toBeLessThan(4096)
}

function rejectTranscriptPrefixScans() {
  const startsWith = String.prototype.startsWith
  vi.spyOn(String.prototype, 'startsWith').mockImplementation(function (
    this: string,
    search: string,
    position?: number,
  ) {
    if (typeof search === 'string' && search.length >= 64 * 1024)
      throw new Error('Rescanned a privately owned transcript prefix')
    return startsWith.call(this, search, position)
  })
}

afterEach(() => vi.restoreAllMocks())

describe('native recovery combined with private message appends', () => {
  it('keeps exact source-owned suffixes through native replay rejection and generation separation', () => {
    const before = admittedThread()
    const first = applyEvent(before, event(2, firstSuffix))
    const latest = applyEvent(first, event(3, nextSuffix))
    rejectTranscriptPrefixScans()
    expect(getConversationMessageAppend(before.messages[0], latest.messages[0])).toEqual({
      baseLength: prefix.length,
      value: firstSuffix + nextSuffix,
    })
    expect(applyEvent(latest, event(2, firstSuffix))).toBe(latest)
    const nextGeneration = applyEvent(latest, event(4, '  separate generation\r\n', 3))
    expect(nextGeneration.messages).toHaveLength(2)
    expect(nextGeneration.messages[0]).toBe(latest.messages[0])
    expect(nextGeneration.messages[1]).toMatchObject({
      id: '1:answer:native-generation:3',
      text: '  separate generation\r\n',
      nativeRecovery: { transportId: 'transport', ownerGeneration: 3 },
    })
    expect(
      getConversationMessageAppend(latest.messages[0], nextGeneration.messages[1]),
    ).toBeUndefined()
    const saved = copyConversationSourceJson(latest) as Thread & Record<string, unknown>
    expect(saved.messages[0].text).toBe(prefix + firstSuffix + nextSuffix)
    expect(saved.futureThreadField).toEqual({ exact: '  future thread\r\nΩ' })
    expect(saved.messages[0]).toHaveProperty('futureMessageField', {
      exact: '  future message\r\n\ud800',
    })
    expect(JSON.stringify(saved)).not.toContain('private-delivery')
  })

  it('settles the original append receipts after an admission-decorated IPC acknowledgement', async () => {
    const before = admittedThread()
    const first = applyEvent(before, event(2, firstSuffix))
    const latest = applyEvent(first, event(3, nextSuffix))
    const snapshot = createHistorySnapshotProjector()
    const client = new ConversationCheckpointClient()
    const save = vi.fn(async () => {})
    const firstRelease = deferred()
    const nextRelease = deferred()
    const checkpoint = vi.fn(async (input: ConversationCheckpointInput) => {
      await (input.savedAt === 200 ? firstRelease.promise : nextRelease.promise)
      return { savedAt: input.savedAt }
    })
    expect(
      client.adoptDurableBaseline(snapshot([before]), 100, save, checkpoint, capabilities),
    ).toBe(true)
    rejectTranscriptPrefixScans()
    const firstHistory = snapshot([first])
    const firstSubmission = client.submit(firstHistory, 200, save, checkpoint)
    const latestSubmission = client.submit(snapshot([latest]), 300, save, checkpoint)
    const submitted = checkpoint.mock.calls[0][0]
    expectAppend(submitted, before, firstSuffix)
    expect(submitted.projectionAdmissions).toEqual(nativeProjectionAdmissions(firstHistory))
    expect(submitted.projectionAdmissions?.[0]).toMatchObject({
      appliedRevision: 2,
      deliveryToken: 'private-delivery-2',
    })
    expect(JSON.stringify(firstHistory)).not.toContain('private-delivery')
    firstRelease.resolve()
    expect(await firstSubmission).toBe(200)
    expect(getConversationMessageAppend(before.messages[0], first.messages[0])).toBeUndefined()
    expect(getConversationMessageAppend(first.messages[0], latest.messages[0])).toEqual({
      baseLength: first.messages[0].text.length,
      value: nextSuffix,
    })
    expectAppend(checkpoint.mock.calls[1][0], first, nextSuffix)
    expect(checkpoint.mock.calls[1][0].projectionAdmissions?.[0]).toMatchObject({
      appliedRevision: 3,
      deliveryToken: 'private-delivery-3',
    })
    nextRelease.resolve()
    expect(await latestSubmission).toBe(300)
    expect(getConversationMessageAppend(first.messages[0], latest.messages[0])).toBeUndefined()
    expect(save).not.toHaveBeenCalled()
  })

  it('carries native admissions into base-change full saves and waits for their exact append ACK', async () => {
    const before = admittedThread()
    const first = applyEvent(before, event(2, firstSuffix))
    const snapshot = createHistorySnapshotProjector()
    const client = new ConversationCheckpointClient()
    const saveRelease = deferred()
    const saveEntered = deferred()
    const saved: { history: unknown[]; admissions?: readonly ConversationProjectionAdmission[] }[] =
      []
    const save = vi.fn(
      async (
        history: unknown[],
        _savedAt?: number,
        admissions?: readonly ConversationProjectionAdmission[],
      ) => {
        saved.push({ history, admissions })
        saveEntered.resolve()
        await saveRelease.promise
      },
    )
    const checkpoint = vi.fn(async (input: ConversationCheckpointInput) => {
      if (input.savedAt === 200) throw new Error(CONVERSATION_CHECKPOINT_BASE_CHANGED)
      return { savedAt: input.savedAt }
    })
    expect(
      client.adoptDurableBaseline(snapshot([before]), 100, save, checkpoint, capabilities),
    ).toBe(true)
    rejectTranscriptPrefixScans()
    const firstSubmission = client.submit(snapshot([first]), 200, save, checkpoint)
    await saveEntered.promise
    expect(saved[0].history).toEqual(snapshot([first]))
    expect(saved[0].admissions).toMatchObject([
      { appliedRevision: 2, deliveryToken: 'private-delivery-2' },
    ])
    expect(getConversationMessageAppend(before.messages[0], first.messages[0])).toEqual({
      baseLength: prefix.length,
      value: firstSuffix,
    })
    const latest = applyEvent(first, event(3, nextSuffix))
    const latestSubmission = client.submit(snapshot([latest]), 300, save, checkpoint)
    saveRelease.resolve()
    expect(await Promise.all([firstSubmission, latestSubmission])).toEqual([200, 300])
    expect(getConversationMessageAppend(before.messages[0], first.messages[0])).toBeUndefined()
    expectAppend(checkpoint.mock.calls[1][0], first, nextSuffix)
    expect(checkpoint.mock.calls[1][0].projectionAdmissions?.[0]).toMatchObject({
      appliedRevision: 3,
      deliveryToken: 'private-delivery-3',
    })
    expect(save).toHaveBeenCalledTimes(1)
  })
})
