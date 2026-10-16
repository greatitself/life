import { describe, expect, it } from 'vitest'
import type { AgentEvent, NativeRecoveryOwnerState } from '../src/shared/types'
import {
  applyEvent,
  applyNativeRecoveryOwner,
  finishThreadTurn,
  isMessageQuestionRequest,
  readThreads,
  resolveAgentRequest,
  type Thread,
} from '../src/renderer/state'
import { copyConversationSourceJson } from '../src/renderer/conversation-source'

const exactQuestion = '  Which café?\r\n漢字 🧪\ud800'
function thread(overrides: Partial<Thread> = {}): Thread {
  return {
    id: 'thread',
    profileId: 'machine',
    workspace: '/srv/project',
    provider: 'codex',
    title: 'Native questions',
    remoteId: 'native-thread',
    messages: [
      { id: 'user-1', role: 'user', text: '  exact prompt\r\n🧪', turn: 1, createdAt: 10 },
    ],
    busy: true,
    turnStatus: 'running',
    model: '',
    mode: 'review',
    updatedAt: 10,
    turn: 1,
    pending: [],
    ...overrides,
  }
}
function question(overrides: Partial<AgentEvent> = {}): AgentEvent {
  return {
    sessionId: 'thread',
    type: 'question',
    requestId: 'native-async-question',
    responseMode: 'message',
    canDismiss: true,
    questions: [
      { id: 'question-1', question: exactQuestion, options: [{ label: '  Option A\r\n' }] },
    ],
    nativeRecovery: {
      transportId: 'source',
      revision: 1,
      eventId: 'question-event',
      ownerGeneration: 1,
      localTurn: 1,
      emittedAt: 100,
      snapshotToken: 'source-token',
    },
    ...overrides,
  }
}
function owner(overrides: Partial<NativeRecoveryOwnerState> = {}): NativeRecoveryOwnerState {
  return {
    sessionId: 'thread',
    transportId: 'destination',
    ownerGeneration: 9,
    snapshotToken: 'destination-token',
    status: 'idle',
    acceptedAppliedRevision: 0,
    pending: [],
    ...overrides,
  }
}
function resolution(request: AgentEvent, overrides: Partial<AgentEvent> = {}): AgentEvent {
  return {
    sessionId: 'thread',
    type: 'request-resolved',
    requestId: request.requestId,
    status: 'answered',
    nativeRecovery: {
      ...request.nativeRecovery!,
      revision: 2,
      eventId: 'resolved-event',
      emittedAt: 200,
    },
    ...overrides,
  }
}

function requestRow(value: Thread) {
  return value.messages.find((message) => message.details?.requestId === 'native-async-question')
}

describe('native asynchronous question state', () => {
  it.each(['completed', 'interrupted', 'failed'] as const)(
    'retains message questions across root %s while cancelling callback questions',
    (status) => {
      const async = question()
      const callback = question({
        requestId: 'native-callback',
        responseMode: undefined,
        canDismiss: undefined,
        nativeRecovery: { ...async.nativeRecovery!, revision: 2, eventId: 'callback-event' },
      })
      const requested = applyEvent(applyEvent(thread(), async), callback)
      const finished = applyEvent(requested, { sessionId: 'thread', type: 'complete', status })
      expect(finished.pending).toEqual([async])
      expect(requestRow(finished)).toMatchObject({
        status: 'waiting',
        details: { responseMode: 'message', canDismiss: true, questions: async.questions },
      })
      expect(requestRow(finished)?.finishedAt).toBeUndefined()
      expect(
        finished.messages.find((message) => message.details?.requestId === 'native-callback'),
      ).toMatchObject({ status: 'cancelled' })
      expect(finished.busy).toBe(false)
      expect(finished.turnStatus).toBe(status)
    },
  )

  it('preserves questions across errors and ordinary later turns', () => {
    const async = question()
    const requested = applyEvent(thread(), async)
    const failed = applyEvent(requested, {
      sessionId: 'thread',
      type: 'error',
      text: 'Connection failed',
    })
    expect(failed.pending).toEqual([async])
    expect(requestRow(failed)?.status).toBe('waiting')
    const next = {
      ...finishThreadTurn(failed, 'completed', 300),
      turn: 2,
      busy: true,
      turnStatus: 'running' as const,
    }
    const finished = applyEvent(next, { sessionId: 'thread', type: 'complete' })
    expect(finished.pending.filter(isMessageQuestionRequest)).toEqual([async])
    expect(requestRow(finished)).toMatchObject({ turn: 1, status: 'waiting', text: exactQuestion })
    expect(finished.messages[0].text).toBe(requested.messages[0].text)
  })

  it('keeps completed child async questions available for native dismissal', () => {
    const async = question({ agentId: 'child' })
    const requested = applyEvent(thread(), async)
    const completed = applyEvent(requested, {
      sessionId: 'thread',
      type: 'subagent',
      agentId: 'child',
      status: 'completed',
      details: { lifecycle: 'turn' },
    })
    expect(completed.pending).toEqual([async])
    expect(requestRow(completed)?.status).toBe('waiting')
  })

  it('does not trust saved pending requests or replayed historical requests to restore controls', () => {
    const async = question()
    const requested = applyEvent(thread(), async)
    const saved = readThreads([{ ...requested, turn: 4, busy: false }])[0]
    expect(saved.pending).toEqual([])
    expect(requestRow(saved)?.status).toBe('interrupted')
    const replay = question({
      nativeRecovery: { ...async.nativeRecovery!, revision: 2, eventId: 'historical-question' },
    })
    const historical = applyEvent(saved, replay)
    expect(historical.pending).toEqual([])
    expect(historical.turn).toBe(4)
    const callback = {
      ...replay,
      responseMode: undefined,
      canDismiss: undefined,
      requestId: 'historical-callback',
      nativeRecovery: { ...replay.nativeRecovery!, revision: 3 },
    }
    expect(applyEvent(historical, callback).pending).toEqual([])
  })

  it.each(['running', 'idle'] as const)(
    'restores older-origin message questions only from a native %s snapshot',
    (status) => {
      const async = question({ status: 'responding' })
      const requested = applyEvent(thread(), question())
      const saved = readThreads([
        { ...requested, turn: 4, busy: false, snoozedAt: 150, snoozedUntil: 900 },
      ])[0]
      const recovered = applyNativeRecoveryOwner(saved, owner({ status, pending: [async] }))
      expect(recovered.pending).toEqual([async])
      expect(recovered.turn).toBe(4)
      expect(recovered.snoozedUntil).toBeUndefined()
      expect(requestRow(recovered)).toMatchObject({
        turn: 1,
        status: 'waiting',
        text: exactQuestion,
        nativeRecovery: { transportId: 'source', ownerGeneration: 1 },
        details: { responseMode: 'message', canDismiss: true, questions: async.questions },
      })
      expect(requestRow(recovered)?.finishedAt).toBeUndefined()
      expect(recovered.nativeRecoveryOwner?.transportId).toBe('destination')
      expect(
        recovered.messages.filter((message) => message.details?.requestId === async.requestId),
      ).toHaveLength(1)
    },
  )

  it.each(['recovering', 'unknown'] as const)(
    'does not restore controls from a native %s snapshot',
    (status) => {
      const saved = readThreads([
        { ...applyEvent(thread(), question()), snoozedAt: 150, snoozedUntil: 900 },
      ])[0]
      const recovered = applyNativeRecoveryOwner(saved, owner({ status, pending: [question()] }))
      expect(recovered.pending).toEqual([])
      expect(requestRow(recovered)?.status).toBe('interrupted')
      expect(recovered.snoozedUntil).toBe(900)
    },
  )

  it('rejects wrong-session and invalid native pending entries', () => {
    const saved = readThreads([thread()])[0]
    const async = question()
    const recovered = applyNativeRecoveryOwner(
      saved,
      owner({
        pending: [
          question({ sessionId: 'other' }),
          question({ requestId: 'missing-stamp', nativeRecovery: undefined }),
          question({
            requestId: 'invalid-stamp',
            nativeRecovery: { ...async.nativeRecovery!, revision: 0 },
          }),
        ],
      }),
    )
    expect(recovered.pending).toEqual([])
    expect(recovered.messages).toEqual(saved.messages)
  })

  it.each(['answered', 'dismissed'] as const)(
    'settles an admitted old-origin %s without changing current turn lifecycle',
    (status) => {
      const async = question()
      const saved = readThreads([{ ...applyEvent(thread(), async), turn: 4 }])[0]
      const recovered = applyNativeRecoveryOwner(saved, owner({ pending: [async] }))
      const parked = {
        ...recovered,
        settled: true,
        settledAt: 150,
        attentionAt: 100,
        completedAt: 120,
      }
      const resolved = applyEvent(parked, resolution(async, { status }))
      expect(resolved.pending).toEqual([])
      expect(requestRow(resolved)).toMatchObject({
        status: status === 'answered' ? 'answered' : 'completed',
        finishedAt: 200,
      })
      expect(resolved).toMatchObject({
        turn: 4,
        busy: false,
        settled: true,
        settledAt: 150,
        attentionAt: 100,
        completedAt: 120,
      })
      expect(resolved.nativeRecoveryOwner).toEqual(recovered.nativeRecoveryOwner)
      expect(resolved.messages[0]).toEqual(saved.messages[0])
      const replay = question({
        nativeRecovery: { ...async.nativeRecovery!, revision: 3, eventId: 'replayed-question' },
      })
      expect(applyEvent(resolved, replay).pending).toEqual([])
      expect(requestRow(applyEvent(resolved, replay))?.status).not.toBe('waiting')
    },
  )

  it.each(['running', 'idle'] as const)(
    'keeps current %s control when an older source resolves a question in the same local turn',
    (status) => {
      const async = question()
      const saved = readThreads([applyEvent(thread(), async)])[0]
      const recovered = applyNativeRecoveryOwner(saved, owner({ status, pending: [async] }))
      const resolved = applyEvent(recovered, resolution(async))
      expect(resolved.pending).toEqual([])
      expect(requestRow(resolved)?.status).toBe('answered')
      expect(resolved.nativeRecoveryOwner).toEqual(recovered.nativeRecoveryOwner)
      expect(resolved.nativeRecoveryStatus).toBe(status)
      expect(resolved.busy).toBe(recovered.busy)
      expect(resolved.turnStatus).toBe(recovered.turnStatus)
      expect(resolved.nativeRecovery?.source.appliedRevision).toBe(2)
      expect(resolved.nativeRecovery?.destination).toBe(recovered.nativeRecovery?.destination)
    },
  )

  it('keeps the current control after an equal-generation foreign transport delivery', () => {
    const async = question()
    const saved = readThreads([applyEvent(thread(), async)])[0]
    const recovered = applyNativeRecoveryOwner(
      saved,
      owner({ status: 'running', pending: [async] }),
    )
    const event = resolution(async, {
      nativeRecovery: {
        ...async.nativeRecovery!,
        transportId: 'unrelated',
        ownerGeneration: 9,
        revision: 1,
        eventId: 'foreign-same-generation',
      },
    })
    const projected = applyEvent(recovered, event)
    expect(projected.nativeRecoveryOwner).toEqual(recovered.nativeRecoveryOwner)
    expect(projected.nativeRecoveryStatus).toBe('running')
    expect(projected.busy).toBe(true)
    expect(projected.turnStatus).toBe('running')
    expect(projected.pending).toEqual([async])
    expect(projected.nativeRecovery?.unrelated.appliedRevision).toBe(1)
  })

  it.each([
    { ownerGeneration: 8, snapshotToken: 'older-destination-token' },
    { ownerGeneration: 9, snapshotToken: 'mismatched-destination-token' },
    { transportId: 'retired-source', ownerGeneration: 8, snapshotToken: 'retired-token' },
    { transportId: 'retired-source', ownerGeneration: 9, snapshotToken: 'retired-token' },
  ])(
    'does not resurrect answered questions from a stale enclosing owner snapshot %j',
    (staleStamp) => {
      const async = question()
      const saved = readThreads([{ ...applyEvent(thread(), async), turn: 4 }])[0]
      const recovered = applyNativeRecoveryOwner(saved, owner({ pending: [async] }))
      const answered = applyEvent(recovered, resolution(async))
      const staleOwner = owner({ ...staleStamp, pending: [async] })
      const stale = applyNativeRecoveryOwner(answered, staleOwner)
      const repeated = applyNativeRecoveryOwner(stale, staleOwner)
      for (const value of [stale, repeated]) {
        expect(value.pending).toEqual([])
        expect(requestRow(value)?.status).toBe('answered')
        expect(value.nativeRecoveryOwner).toEqual(answered.nativeRecoveryOwner)
      }
    },
  )

  it('admits a newer native transport handoff while keeping the immutable question source', () => {
    const async = question()
    const saved = readThreads([{ ...applyEvent(thread(), async), turn: 4 }])[0]
    const current = applyNativeRecoveryOwner(saved, owner())
    const next = applyNativeRecoveryOwner(
      current,
      owner({
        transportId: 'new-destination',
        ownerGeneration: 10,
        snapshotToken: 'new-destination-token',
        pending: [async],
      }),
    )
    expect(next.pending).toEqual([async])
    expect(next.nativeRecoveryOwner).toEqual({
      transportId: 'new-destination',
      ownerGeneration: 10,
      snapshotToken: 'new-destination-token',
    })
    expect(requestRow(next)).toMatchObject({
      nativeRecovery: { transportId: 'source', ownerGeneration: 1 },
    })
  })

  it('retains current message controls when a stale enclosing snapshot omits them', () => {
    const async = question()
    const saved = readThreads([{ ...applyEvent(thread(), async), turn: 4 }])[0]
    const recovered = applyNativeRecoveryOwner(saved, owner({ pending: [async] }))
    const stale = applyNativeRecoveryOwner(recovered, owner({ ownerGeneration: 8, pending: [] }))
    expect(stale.pending).toEqual([async])
    expect(requestRow(stale)?.status).toBe('waiting')
  })

  it('reopens optimistic answered history only when a current native owner still owns the question', () => {
    const async = question()
    const answered = resolveAgentRequest(
      applyEvent(thread(), async),
      async.requestId!,
      true,
      { 'question-1': ['Not durably written'] },
      300,
    )
    const saved = readThreads([answered])[0]
    const recovered = applyNativeRecoveryOwner(saved, owner({ pending: [async] }))
    expect(recovered.pending).toEqual([async])
    expect(requestRow(recovered)?.status).toBe('waiting')
    expect(requestRow(recovered)?.finishedAt).toBeUndefined()
    expect(requestRow(recovered)?.details?.response).toBeUndefined()
  })

  it('keeps a pending message question when a historical resolution comes from another journal', () => {
    const async = question()
    const saved = readThreads([{ ...applyEvent(thread(), async), turn: 4 }])[0]
    const recovered = applyNativeRecoveryOwner(saved, owner({ pending: [async] }))
    const resolved = applyEvent(
      recovered,
      resolution(async, {
        nativeRecovery: {
          ...async.nativeRecovery!,
          transportId: 'unrelated',
          revision: 1,
          eventId: 'unrelated-resolution',
        },
      }),
    )
    expect(resolved.pending).toEqual([async])
    expect(requestRow(resolved)?.status).toBe('waiting')
  })

  it('retains historical callback protections when admitting an older resolution', () => {
    const callback = question({ responseMode: undefined, canDismiss: undefined })
    const saved = readThreads([{ ...applyEvent(thread(), callback), turn: 4 }])[0]
    const recovered = applyNativeRecoveryOwner(saved, owner({ pending: [callback] }))
    expect(applyEvent(recovered, resolution(callback)).pending).toEqual([callback])
  })

  it('redacts secret answers after native recovery while retaining exact public answers', () => {
    const async = question({
      questions: [
        { id: 'secret', question: 'Secret?', isSecret: true },
        { id: 'public', question: exactQuestion },
      ],
    })
    const saved = readThreads([applyEvent(thread(), async)])[0]
    const recovered = applyNativeRecoveryOwner(saved, owner({ pending: [async] }))
    const publicAnswer = '  Exact public answer\r\n漢字 🧪\ud800'
    const answered = resolveAgentRequest(
      recovered,
      async.requestId!,
      true,
      {
        secret: ['private-native-secret'],
        public: [publicAnswer],
      },
      300,
    )
    expect(answered.pending).toEqual([])
    expect(requestRow(answered)?.details?.response).toEqual({
      accepted: true,
      answers: {
        secret: ['[redacted]'],
        public: [publicAnswer],
      },
    })
    expect(JSON.stringify(copyConversationSourceJson(answered))).not.toContain(
      'private-native-secret',
    )
  })
})

function followup(overrides: Record<string, unknown> = {}) {
  const userMessage = {
    id: 'written-answer',
    role: 'user',
    submission: 'steering',
    text: '  Exact submitted answer\r\ncafé 漢字 🧪\ud800',
    turn: 1,
    createdAt: 150,
  }
  return {
    kind: 'main',
    prompt: userMessage.text,
    userMessage,
    threadSeed: {
      id: 'thread',
      profileId: 'machine',
      provider: 'codex',
      workspace: '/srv/project',
      turn: 1,
    },
    ...overrides,
  }
}

describe('native-written asynchronous answer recovery', () => {
  it('repairs the stable exact user message between its source turn records and deduplicates rereads', () => {
    const raw = thread({
      turn: 4,
      busy: false,
      messages: [
        { id: 'user-1', role: 'user', text: 'Original', turn: 1, createdAt: 10 },
        { id: 'question', role: 'tool', text: exactQuestion, turn: 1, createdAt: 100 },
        { id: 'undated', role: 'assistant', text: 'Keep undated history in place', turn: 1 },
        {
          id: 'after-answer',
          role: 'assistant',
          text: 'Following answer',
          turn: 1,
          createdAt: 160,
        },
        { id: 'user-4', role: 'user', text: 'Later turn', turn: 4, createdAt: 400 },
      ],
    })
    const saved = readThreads([raw])[0]
    const written = followup()
    const nativeOwner = owner({ admittedFollowups: [written] })
    const recovered = applyNativeRecoveryOwner(saved, nativeOwner)
    expect(recovered.messages.map((message) => message.id)).toEqual([
      'user-1',
      'question',
      'undated',
      'written-answer',
      'after-answer',
      'user-4',
    ])
    expect(recovered.messages[3]).toEqual(written.userMessage)
    expect(recovered.turn).toBe(4)
    expect(recovered.pending).toEqual([])
    expect(recovered.messages[4]).toEqual(saved.messages[3])
    expect(copyConversationSourceJson(recovered).messages[3]).toEqual(written.userMessage)
    const again = applyNativeRecoveryOwner(recovered, nativeOwner)
    expect(again.messages).toBe(recovered.messages)
    expect(again.messages.filter((message) => message.id === 'written-answer')).toHaveLength(1)
  })

  it('inserts an older answer before later turns even when source-turn timestamps are missing', () => {
    const saved = readThreads([
      thread({
        turn: 4,
        messages: [
          { id: 'undated', role: 'assistant', text: 'Older output', turn: 1 },
          { id: 'newer', role: 'user', text: 'Newer prompt', turn: 4 },
        ],
      }),
    ])[0]
    const recovered = applyNativeRecoveryOwner(saved, owner({ admittedFollowups: [followup()] }))
    expect(recovered.messages.map((message) => message.id)).toEqual([
      'undated',
      'written-answer',
      'newer',
    ])
  })

  it('never derives written followups from ordinary saved history', () => {
    const raw = { ...thread(), admittedFollowups: [followup()] }
    const saved = readThreads([raw])[0]
    expect(saved.messages.some((message) => message.id === 'written-answer')).toBe(false)
    const recovered = applyNativeRecoveryOwner(saved, owner())
    expect(recovered.messages).toBe(saved.messages)
  })

  it.each([
    'kind',
    'thread',
    'profile',
    'provider',
    'workspace',
    'turn',
    'prompt',
    'attachments',
  ] as const)(
    'rejects a written-followup %s mismatch without changing existing history',
    (mismatch) => {
      const written = followup()
      const invalid = {
        ...written,
        userMessage: { ...written.userMessage },
        threadSeed: { ...written.threadSeed },
      }
      if (mismatch === 'kind') invalid.kind = 'studio'
      if (mismatch === 'thread') invalid.threadSeed.id = 'another-thread'
      if (mismatch === 'profile') invalid.threadSeed.profileId = 'another-machine'
      if (mismatch === 'provider') invalid.threadSeed.provider = 'claude'
      if (mismatch === 'workspace') invalid.threadSeed.workspace = '/different/project'
      if (mismatch === 'turn') invalid.userMessage.turn = -1
      if (mismatch === 'prompt') invalid.prompt = 'Different accepted native input'
      const input =
        mismatch === 'attachments'
          ? {
              ...invalid,
              userMessage: { ...invalid.userMessage, attachments: [{ invalid: true }] },
            }
          : invalid
      const saved = readThreads([thread()])[0]
      const recovered = applyNativeRecoveryOwner(saved, owner({ admittedFollowups: [input] }))
      expect(recovered.messages).toBe(saved.messages)
      expect(recovered.turn).toBe(saved.turn)
    },
  )

  it('preserves an existing conflicting message identity instead of replacing or duplicating it', () => {
    const original = thread({
      messages: [{ id: 'written-answer', role: 'user', text: 'Existing exact text', turn: 1 }],
    })
    const recovered = applyNativeRecoveryOwner(original, owner({ admittedFollowups: [followup()] }))
    expect(recovered.messages).toBe(original.messages)
    expect(recovered.messages[0].text).toBe('Existing exact text')
  })
})
