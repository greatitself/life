import { describe, expect, it, vi } from 'vitest'
import type { AgentEvent } from '../src/shared/types'
import {
  createPendingQuestionDraftStore,
  pendingQuestionRequestKey,
  questionDraftAnswers,
} from '../src/renderer/pending-question-drafts'

function request(overrides: Partial<AgentEvent> = {}): AgentEvent {
  return {
    sessionId: 'native-session',
    requestId: 'question-request',
    type: 'question',
    questions: [{ id: 'approach', question: 'Which approach?' }],
    nativeRecovery: {
      transportId: 'native-transport',
      revision: 4,
      eventId: 'delivery-4',
      ownerGeneration: 2,
      localTurn: 3,
      snapshotToken: 'native-incarnation',
      deliveryToken: 'delivery-capability',
    },
    ...overrides,
  }
}

function deferred() {
  let resolve!: () => void
  let reject!: (error: Error) => void
  const promise = new Promise<void>((done, fail) => {
    resolve = done
    reject = fail
  })
  return { promise, resolve, reject }
}

describe('pending question request identity', () => {
  it('retains a native request across delivery revisions and ephemeral attestations', () => {
    const event = request()
    const replay = request({
      nativeRecovery: {
        ...event.nativeRecovery!,
        revision: 19,
        eventId: 'replayed-delivery-19',
        emittedAt: 123,
        deliveryToken: 'new-delivery-capability',
        ownerStatus: 'running',
      },
    })
    expect(pendingQuestionRequestKey(replay)).toBe(pendingQuestionRequestKey(event))
  })

  it('partitions answers by session, request, native owner, snapshot, turn, response mode, and question payload', () => {
    const event = request()
    const differentRequests: AgentEvent[] = [
      request({ sessionId: 'another-session' }),
      request({ requestId: 'another-request' }),
      request({
        nativeRecovery: { ...event.nativeRecovery!, transportId: 'another-transport' },
      }),
      request({
        nativeRecovery: { ...event.nativeRecovery!, ownerGeneration: 3 },
      }),
      request({
        nativeRecovery: { ...event.nativeRecovery!, snapshotToken: 'restarted-transport' },
      }),
      request({
        nativeRecovery: { ...event.nativeRecovery!, localTurn: 4 },
      }),
      request({ responseMode: 'message' }),
      request({ questions: [{ id: 'approach', question: 'A different question?' }] }),
      request({
        questions: [
          {
            id: 'approach',
            question: 'Which approach?',
            options: [{ label: 'Inspect', value: 'inspect-source' }],
          },
        ],
      }),
    ]
    for (const changed of differentRequests) {
      expect(pendingQuestionRequestKey(changed)).not.toBe(pendingQuestionRequestKey(event))
    }
  })
})

describe('pending question draft continuity', () => {
  it('keeps a stable snapshot across subscriber unmounts and equivalent native replays', () => {
    const store = createPendingQuestionDraftStore()
    const event = request()
    const firstListener = vi.fn()
    const unsubscribe = store.subscribe(event, firstListener)
    const initial = store.get(event)
    expect(store.get(event)).toBe(initial)

    store.update(event, {
      answers: { approach: ['  Preserve this response.\r\n'] },
      step: 1,
      collapsed: true,
    })
    const edited = store.get(event)
    expect(edited).not.toBe(initial)
    expect(store.get(event)).toBe(edited)
    expect(firstListener).toHaveBeenCalledTimes(1)
    unsubscribe()

    const replay = request({
      nativeRecovery: { ...event.nativeRecovery!, revision: 8, eventId: 'replay-8' },
    })
    expect(store.get(replay)).toBe(edited)
    const remountedListener = vi.fn()
    const stop = store.subscribe(replay, remountedListener)
    store.update(replay, (draft) => ({ step: draft.step + 1, collapsed: false }))
    expect(store.get(event)).toMatchObject({
      answers: { approach: ['  Preserve this response.\r\n'] },
      step: 2,
      collapsed: false,
    })
    expect(firstListener).toHaveBeenCalledTimes(1)
    expect(remountedListener).toHaveBeenCalledTimes(1)
    stop()
  })

  it('does not expose one request draft to a changed native generation or payload', () => {
    const store = createPendingQuestionDraftStore()
    const event = request()
    store.update(event, {
      answers: { approach: ['private original response'] },
      step: 1,
    })
    const nextGeneration = request({
      nativeRecovery: { ...event.nativeRecovery!, ownerGeneration: 3 },
    })
    const changedQuestion = request({
      questions: [{ id: 'approach', question: 'A replacement question?' }],
    })
    for (const changed of [nextGeneration, changedQuestion]) {
      expect(store.get(changed)).toMatchObject({ answers: {}, step: 0, status: 'idle' })
    }
    expect(store.get(event).answers).toEqual({
      approach: ['private original response'],
    })
  })

  it('forgets resolved drafts while pruning only requests absent from the current live set', () => {
    const store = createPendingQuestionDraftStore()
    const event = request()
    const retained = request({ requestId: 'still-pending' })
    store.update(event, { answers: { approach: ['resolved response'] } })
    store.update(retained, { answers: { approach: ['still editing'] }, step: 1 })
    const retainedDraft = store.get(retained)
    const replay = request({
      requestId: 'still-pending',
      nativeRecovery: { ...retained.nativeRecovery!, revision: 9, eventId: 'replay-9' },
    })

    store.prune([replay])
    expect(store.get(event).answers).toEqual({})
    expect(store.get(retained)).toBe(retainedDraft)
    store.forget(replay)
    expect(store.get(retained)).toMatchObject({ answers: {}, step: 0, status: 'idle' })
  })
  it('scopes authoritative cleanup to one session without clearing another window session', () => {
    const store = createPendingQuestionDraftStore()
    const retired = request()
    const mainPending = request({ requestId: 'main-still-pending' })
    const studioPending = request({ sessionId: 'studio-native-session' })
    store.update(retired, { answers: { approach: ['resolved main response'] } })
    store.update(mainPending, { answers: { approach: ['unfinished main response'] }, step: 1 })
    store.update(studioPending, {
      answers: { approach: ['unfinished studio response'] },
      step: 1,
    })
    const mainDraft = store.get(mainPending)
    const studioDraft = store.get(studioPending)

    store.pruneSession(retired.sessionId, [mainPending])
    expect(store.get(retired).answers).toEqual({})
    expect(store.get(mainPending)).toBe(mainDraft)
    expect(store.get(studioPending)).toBe(studioDraft)

    store.pruneSession(studioPending.sessionId, [])
    expect(store.get(studioPending).answers).toEqual({})
    expect(store.get(mainPending)).toBe(mainDraft)
  })

  it('preserves an authoritative sending request during scoped cleanup and native replay', async () => {
    const store = createPendingQuestionDraftStore()
    const event = request()
    const retired = request({ requestId: 'retired-main-question' })
    const anotherSession = request({ sessionId: 'studio-native-session' })
    const delivery = deferred()
    const respond = vi.fn(() => delivery.promise)
    store.update(event, { answers: { approach: ['  Native response in flight.\r\n'] }, step: 1 })
    store.update(retired, { answers: { approach: ['old main response'] } })
    store.update(anotherSession, { answers: { approach: ['studio response'] } })
    const studioDraft = store.get(anotherSession)
    expect(store.submit(event, respond)).toBe(true)
    const sendingDraft = store.get(event)
    await vi.waitFor(() => expect(respond).toHaveBeenCalledTimes(1))
    const replay = request({
      nativeRecovery: { ...event.nativeRecovery!, revision: 9, eventId: 'replayed-9' },
    })

    store.pruneSession(event.sessionId, [replay])
    expect(store.get(event)).toBe(sendingDraft)
    expect(store.get(event)).toMatchObject({
      status: 'sending',
      answers: { approach: ['  Native response in flight.\r\n'] },
      step: 1,
    })
    expect(store.get(retired).answers).toEqual({})
    expect(store.get(anotherSession)).toBe(studioDraft)
    expect(store.submit(replay, respond)).toBe(false)
    delivery.resolve()
    await vi.waitFor(() => expect(store.get(replay).status).toBe('submitted'))
    expect(respond).toHaveBeenCalledExactlyOnceWith(event, true, {
      approach: ['  Native response in flight.\r\n'],
    })
  })
})

describe('pending question exact answers', () => {
  it('adds enabled custom answers without changing option values or whitespace', () => {
    const store = createPendingQuestionDraftStore()
    const event = request({
      questions: [
        {
          id: 'checks',
          question: 'Which checks?',
          multiple: true,
          options: [{ label: 'Types', value: 'check-types' }],
        },
        {
          id: 'region',
          question: 'Which region?',
          options: [{ label: 'Europe', value: 'eu-west-1' }],
        },
      ],
    })
    store.update(event, {
      answers: { checks: ['check-types'], region: ['eu-west-1'] },
      customAnswers: {
        checks: '  Also verify reconnects.\r\n',
        region: 'An unselected custom region',
      },
      customQuestions: { checks: true, region: false },
    })
    expect(questionDraftAnswers(event, store.get(event))).toEqual({
      checks: ['check-types', '  Also verify reconnects.\r\n'],
      region: ['eu-west-1'],
    })
    expect(store.get(event).answers).toEqual({
      checks: ['check-types'],
      region: ['eu-west-1'],
    })
  })

  it('validates before delivery and omits untouched optional fields from exact native answers', async () => {
    const store = createPendingQuestionDraftStore()
    const event = request({
      questions: [
        { id: 'approach', question: 'Which approach?' },
        { id: 'notes', question: 'Optional notes?', required: false },
      ],
    })
    const respond = vi.fn(async () => {})
    expect(store.submit(event, respond)).toBe(false)
    expect(store.get(event).status).toBe('idle')
    expect(respond).not.toHaveBeenCalled()

    const exact = '  Keep this exact response.\r\n'
    store.update(event, { answers: { approach: [exact], notes: [''] } })
    expect(store.submit(event, respond)).toBe(true)
    expect(store.get(event).status).toBe('sending')
    await vi.waitFor(() => expect(store.get(event).status).toBe('submitted'))
    expect(respond).toHaveBeenCalledExactlyOnceWith(event, true, { approach: [exact] })
  })
})

describe('pending question native delivery ownership', () => {
  it('guards duplicate submissions synchronously and completes after every subscriber unmounts', async () => {
    const store = createPendingQuestionDraftStore()
    const event = request()
    const delivery = deferred()
    const respond = vi.fn(() => delivery.promise)
    const listener = vi.fn()
    const unsubscribe = store.subscribe(event, listener)
    store.update(event, { answers: { approach: ['exact answer'] }, step: 1 })

    expect(store.submit(event, respond)).toBe(true)
    expect(store.get(event).status).toBe('sending')
    expect(store.submit(event, respond)).toBe(false)
    store.update(event, {
      answers: { approach: ['replacement must not be sent'] },
      step: 0,
      collapsed: true,
    })
    expect(store.get(event)).toMatchObject({
      answers: { approach: ['exact answer'] },
      step: 1,
      collapsed: true,
      status: 'sending',
    })
    await vi.waitFor(() => expect(respond).toHaveBeenCalledTimes(1))
    unsubscribe()
    const notificationsBeforeCompletion = listener.mock.calls.length
    delivery.resolve()
    await vi.waitFor(() => expect(store.get(event).status).toBe('submitted'))
    expect(listener).toHaveBeenCalledTimes(notificationsBeforeCompletion)
    expect(store.submit(event, respond)).toBe(false)
    expect(respond).toHaveBeenCalledExactlyOnceWith(event, true, {
      approach: ['exact answer'],
    })
  })

  it('retains exact answers and progress after failed delivery and retries the same native response', async () => {
    const store = createPendingQuestionDraftStore()
    const event = request()
    const firstDelivery = deferred()
    const retryDelivery = deferred()
    const respond = vi
      .fn<
        (event: AgentEvent, accepted: boolean, answers?: Record<string, string[]>) => Promise<void>
      >()
      .mockImplementationOnce(() => firstDelivery.promise)
      .mockImplementationOnce(() => retryDelivery.promise)
    const answer = '  Exact retry response.\n'
    store.update(event, {
      answers: { approach: [answer] },
      customAnswers: { approach: 'unselected custom draft' },
      customQuestions: { approach: false },
      step: 1,
    })
    expect(store.submit(event, respond)).toBe(true)
    await vi.waitFor(() => expect(respond).toHaveBeenCalledTimes(1))
    firstDelivery.reject(new Error('Provider disconnected; reconnect and retry.'))
    await vi.waitFor(() => expect(store.get(event).status).toBe('idle'))
    expect(store.get(event)).toMatchObject({
      answers: { approach: [answer] },
      customAnswers: { approach: 'unselected custom draft' },
      customQuestions: { approach: false },
      step: 1,
    })
    expect(store.get(event).error).toContain('Provider disconnected')
    expect(store.submit(event, respond)).toBe(true)
    expect(store.get(event).error).toBe('')
    await vi.waitFor(() => expect(respond).toHaveBeenCalledTimes(2))
    retryDelivery.resolve()
    await vi.waitFor(() => expect(store.get(event).status).toBe('submitted'))
    expect(respond.mock.calls).toEqual([
      [event, true, { approach: [answer] }],
      [event, true, { approach: [answer] }],
    ])
  })

  it('erases secret and custom draft maps only after successful native delivery', async () => {
    const store = createPendingQuestionDraftStore()
    const event = request({
      questions: [
        { id: 'token', question: 'Private token?', isSecret: true },
        {
          id: 'approach',
          question: 'Which approach?',
          options: [{ label: 'Inspect' }],
        },
      ],
    })
    const delivery = deferred()
    const respond = vi.fn(() => delivery.promise)
    store.update(event, {
      answers: { token: ['  private-token\n'] },
      customAnswers: { approach: '  custom private response\r\n' },
      customQuestions: { approach: true },
      step: 1,
    })
    expect(store.submit(event, respond)).toBe(true)
    await vi.waitFor(() => expect(respond).toHaveBeenCalledTimes(1))
    expect(store.get(event).answers.token).toEqual(['  private-token\n'])
    delivery.resolve()
    await vi.waitFor(() => expect(store.get(event).status).toBe('submitted'))
    expect(store.get(event)).toMatchObject({
      answers: {},
      customAnswers: {},
      customQuestions: {},
      error: '',
    })
    expect(respond).toHaveBeenCalledExactlyOnceWith(event, true, {
      token: ['  private-token\n'],
      approach: ['  custom private response\r\n'],
    })
  })

  it.each([
    ['forget', 'succeeds'],
    ['forget', 'fails'],
    ['prune', 'succeeds'],
    ['prune', 'fails'],
    ['pruneSession', 'succeeds'],
    ['pruneSession', 'fails'],
  ] as const)(
    'keeps %s requests locked and replacement drafts unchanged when retired delivery %s',
    async (cleanup, outcome) => {
      const store = createPendingQuestionDraftStore()
      const event = request()
      const delivery = deferred()
      const respond = vi.fn(() => delivery.promise)
      const oldListener = vi.fn()
      const unsubscribeOld = store.subscribe(event, oldListener)
      store.update(event, {
        answers: { approach: ['retired response'] },
        customAnswers: { approach: 'retired custom draft' },
        customQuestions: { approach: false },
        step: 1,
      })
      expect(store.submit(event, respond)).toBe(true)
      await vi.waitFor(() => expect(respond).toHaveBeenCalledTimes(1))

      if (cleanup === 'forget') store.forget(event)
      else if (cleanup === 'prune') store.prune([])
      else store.pruneSession(event.sessionId, [])
      expect(store.get(event)).toMatchObject({
        answers: {},
        customAnswers: {},
        customQuestions: {},
        status: 'sending',
        error: '',
      })
      store.update(event, { answers: { approach: ['must remain locked'] }, step: 1 })
      expect(store.get(event).answers).toEqual({})
      expect(store.submit(event, respond, false)).toBe(false)

      const replacementEvent = request({
        nativeRecovery: { ...event.nativeRecovery!, snapshotToken: 'replacement-incarnation' },
      })
      store.update(replacementEvent, {
        answers: { approach: ['  Replacement owner draft.\r\n'] },
        step: 1,
        collapsed: true,
      })
      const replacement = store.get(replacementEvent)
      const replacementListener = vi.fn()
      const unsubscribeReplacement = store.subscribe(replacementEvent, replacementListener)

      if (outcome === 'succeeds') delivery.resolve()
      else delivery.reject(new Error('Retired response failed after cleanup.'))
      await vi.waitFor(() => expect(store.get(event).status).toBe('submitted'))
      expect(store.get(event)).toMatchObject({
        answers: {},
        customAnswers: {},
        customQuestions: {},
        error: '',
      })
      expect(store.get(replacementEvent)).toBe(replacement)
      expect(replacementListener).not.toHaveBeenCalled()
      expect(respond).toHaveBeenCalledExactlyOnceWith(event, true, {
        approach: ['retired response'],
      })

      unsubscribeOld()
      expect(store.get(event)).toMatchObject({ answers: {}, status: 'idle', error: '' })
      store.update(event, { answers: { approach: ['new same-key draft after settlement'] } })
      expect(store.get(event).answers).toEqual({
        approach: ['new same-key draft after settlement'],
      })
      expect(store.get(replacementEvent)).toBe(replacement)
      unsubscribeReplacement()
    },
  )

  it.each(['succeeds', 'fails'] as const)(
    'releases an unmounted retired tombstone only after native delivery %s',
    async (outcome) => {
      const store = createPendingQuestionDraftStore()
      const event = request()
      const delivery = deferred()
      const respond = vi.fn(() => delivery.promise)
      store.update(event, { answers: { approach: ['retired secret answer'] } })
      expect(store.submit(event, respond)).toBe(true)
      await vi.waitFor(() => expect(respond).toHaveBeenCalledTimes(1))
      store.forget(event)
      expect(store.get(event)).toMatchObject({ answers: {}, status: 'sending' })
      expect(store.submit(event, respond, false)).toBe(false)

      if (outcome === 'succeeds') delivery.resolve()
      else delivery.reject(new Error('The retired delivery failed.'))
      await vi.waitFor(() => expect(store.get(event).status).toBe('idle'))
      expect(store.get(event)).toMatchObject({
        answers: {},
        customAnswers: {},
        customQuestions: {},
        error: '',
      })
      store.update(event, { answers: { approach: ['fresh draft after settlement'] } })
      expect(store.get(event).answers).toEqual({
        approach: ['fresh draft after settlement'],
      })
      expect(respond).toHaveBeenCalledExactlyOnceWith(event, true, {
        approach: ['retired secret answer'],
      })
    },
  )

  it('can dismiss an unanswered native request without inventing answers', async () => {
    const store = createPendingQuestionDraftStore()
    const event = request({ canDismiss: true })
    const respond = vi.fn(async () => {})
    expect(store.submit(event, respond, false)).toBe(true)
    await vi.waitFor(() => expect(store.get(event).status).toBe('submitted'))
    expect(respond).toHaveBeenCalledExactlyOnceWith(event, false, undefined)
  })
})

describe('pending question native field names', () => {
  const nativeIds = ['constructor', 'toString', '__proto__'] as const

  it('does not invent answers or custom choices from inherited object properties', () => {
    const prototypeBefore = Object.getOwnPropertyDescriptors(Object.prototype)
    const store = createPendingQuestionDraftStore()
    const event = request({
      questions: nativeIds.map((id) => ({
        id,
        question: 'Answer the native ' + id + ' field?',
        options: [{ label: 'Inspect', value: 'inspect-source' }],
      })),
    })
    const respond = vi.fn(async () => {})
    const projected = questionDraftAnswers(event, store.get(event))
    expect(Object.keys(projected)).toEqual([])
    for (const id of nativeIds) expect(Object.hasOwn(projected, id)).toBe(false)
    expect(store.submit(event, respond)).toBe(false)
    expect(store.get(event).status).toBe('idle')
    expect(respond).not.toHaveBeenCalled()
    expect(Object.getOwnPropertyDescriptors(Object.prototype)).toEqual(prototypeBefore)
  })

  it('round trips exact native option values from Object.fromEntries maps with own output keys', async () => {
    const prototypeBefore = Object.getOwnPropertyDescriptors(Object.prototype)
    const store = createPendingQuestionDraftStore()
    const entries = nativeIds.map<[string, string[]]>((id) => [
      id,
      ['  native option ' + id + '\r\n'],
    ])
    const answers: Record<string, string[]> = Object.fromEntries(entries)
    const event = request({
      questions: nativeIds.map((id) => ({
        id,
        question: 'Choose a native option for ' + id + '?',
        isOther: false,
        options: [{ label: 'Inspect', value: answers[id][0] }],
      })),
    })
    const respond = vi.fn(
      async (_event: AgentEvent, _accepted: boolean, _answers?: Record<string, string[]>) => {},
    )
    store.update(event, { answers })
    const projected = questionDraftAnswers(event, store.get(event))
    for (const id of nativeIds) {
      expect(Object.hasOwn(store.get(event).answers, id)).toBe(true)
      expect(Object.hasOwn(projected, id)).toBe(true)
      expect(projected[id]).toEqual(answers[id])
    }
    expect(store.submit(event, respond)).toBe(true)
    await vi.waitFor(() => expect(store.get(event).status).toBe('submitted'))
    expect(respond).toHaveBeenCalledExactlyOnceWith(event, true, answers)
    const delivered = respond.mock.calls[0][2]!
    for (const id of nativeIds) {
      expect(Object.hasOwn(delivered, id)).toBe(true)
      expect(delivered[id]).toEqual(answers[id])
      expect(Object.hasOwn(store.get(event).answers, id)).toBe(false)
    }
    expect(Object.getOwnPropertyDescriptors(Object.prototype)).toEqual(prototypeBefore)
  })

  it('preserves computed native keys and exact multiple-choice custom values through delivery', async () => {
    const prototypeBefore = Object.getOwnPropertyDescriptors(Object.prototype)
    const store = createPendingQuestionDraftStore()
    const answers: Record<string, string[]> = {
      ['constructor']: ['native-constructor'],
      ['toString']: ['native-toString'],
      ['__proto__']: ['native-__proto__'],
    }
    const customAnswers: Record<string, string> = Object.fromEntries(
      nativeIds.map((id) => [id, '  Additional answer for ' + id + '.\r\n']),
    )
    const customQuestions: Record<string, boolean> = {
      ['constructor']: true,
      ['toString']: true,
      ['__proto__']: true,
    }
    const event = request({
      questions: nativeIds.map((id) => ({
        id,
        question: 'Select checks for ' + id + '?',
        multiple: true,
        options: [{ label: 'Native selection', value: answers[id][0] }],
      })),
    })
    const respond = vi.fn(
      async (_event: AgentEvent, _accepted: boolean, _answers?: Record<string, string[]>) => {},
    )
    store.update(event, { answers, customAnswers, customQuestions })
    const projected = questionDraftAnswers(event, store.get(event))
    for (const id of nativeIds) {
      expect(Object.hasOwn(projected, id)).toBe(true)
      expect(projected[id]).toEqual([answers[id][0], customAnswers[id]])
      expect(store.get(event).answers[id]).toEqual(answers[id])
      expect(Object.hasOwn(store.get(event).customAnswers, id)).toBe(true)
      expect(Object.hasOwn(store.get(event).customQuestions, id)).toBe(true)
    }
    expect(store.submit(event, respond)).toBe(true)
    await vi.waitFor(() => expect(store.get(event).status).toBe('submitted'))
    const delivered = respond.mock.calls[0][2]!
    for (const id of nativeIds) {
      expect(Object.hasOwn(delivered, id)).toBe(true)
      expect(delivered[id]).toEqual([answers[id][0], customAnswers[id]])
      expect(Object.hasOwn(store.get(event).customAnswers, id)).toBe(false)
      expect(Object.hasOwn(store.get(event).customQuestions, id)).toBe(false)
    }
    expect(respond).toHaveBeenCalledExactlyOnceWith(event, true, projected)
    expect(Object.getOwnPropertyDescriptors(Object.prototype)).toEqual(prototypeBefore)
  })

  it('keeps an enabled but unanswered custom field empty instead of reading inherited functions', () => {
    const prototypeBefore = Object.getOwnPropertyDescriptors(Object.prototype)
    const store = createPendingQuestionDraftStore()
    const event = request({
      questions: nativeIds.map((id) => ({
        id,
        question: 'Provide a custom answer for ' + id + '?',
        options: [{ label: 'Native selection', value: 'inspect-source' }],
      })),
    })
    store.update(event, {
      customQuestions: Object.fromEntries(nativeIds.map((id) => [id, true])),
      customAnswers: {},
    })
    const projected = questionDraftAnswers(event, store.get(event))
    for (const id of nativeIds) {
      expect(Object.hasOwn(projected, id)).toBe(true)
      expect(projected[id]).toEqual([''])
    }
    const respond = vi.fn(async () => {})
    expect(store.submit(event, respond)).toBe(false)
    expect(respond).not.toHaveBeenCalled()
    expect(store.get(event).status).toBe('idle')
    expect(Object.getOwnPropertyDescriptors(Object.prototype)).toEqual(prototypeBefore)
  })
})

describe('uncertain message question dismissal', () => {
  it('keeps answers locked while an explicit Dismiss retries and preserves drafts until its ACK', async () => {
    const store = createPendingQuestionDraftStore()
    const event = request({
      status: 'responding',
      responseMode: 'message',
      canDismiss: true,
    })
    const firstDelivery = deferred()
    const retryDelivery = deferred()
    const respond = vi
      .fn<
        (event: AgentEvent, accepted: boolean, answers?: Record<string, string[]>) => Promise<void>
      >()
      .mockImplementationOnce(() => firstDelivery.promise)
      .mockImplementationOnce(() => retryDelivery.promise)
    const answers = { approach: ['  Preserve this uncertain response.\r\n'] }
    const customAnswers = { approach: '  Unselected custom draft.\n' }
    const customQuestions = { approach: false }
    store.update(event, { answers, customAnswers, customQuestions, step: 1 })

    expect(store.submit(event, respond, true)).toBe(false)
    expect(respond).not.toHaveBeenCalled()
    expect(store.submit(event, respond, false)).toBe(true)
    expect(store.get(event)).toMatchObject({
      answers,
      customAnswers,
      customQuestions,
      step: 1,
      status: 'sending',
      error: '',
    })
    expect(store.submit(event, respond, false)).toBe(false)
    expect(store.submit(event, respond, true)).toBe(false)
    await vi.waitFor(() => expect(respond).toHaveBeenCalledTimes(1))
    firstDelivery.reject(new Error('Dismiss acknowledgement was not received.'))
    await vi.waitFor(() => expect(store.get(event).status).toBe('idle'))
    expect(store.get(event)).toMatchObject({
      answers,
      customAnswers,
      customQuestions,
      step: 1,
    })
    expect(store.get(event).error).toContain('Dismiss acknowledgement was not received')
    expect(store.submit(event, respond, true)).toBe(false)
    expect(store.submit(event, respond, false)).toBe(true)
    expect(store.get(event)).toMatchObject({
      answers,
      customAnswers,
      customQuestions,
      status: 'sending',
      error: '',
    })
    expect(store.submit(event, respond, false)).toBe(false)
    await vi.waitFor(() => expect(respond).toHaveBeenCalledTimes(2))
    retryDelivery.resolve()
    await vi.waitFor(() => expect(store.get(event).status).toBe('submitted'))
    expect(store.get(event)).toMatchObject({
      answers: {},
      customAnswers: {},
      customQuestions: {},
      error: '',
    })
    expect(respond.mock.calls).toEqual([
      [event, false, undefined],
      [event, false, undefined],
    ])
  })

  it.each([
    ['native responding request', { status: 'responding', canDismiss: true }],
    [
      'responding message without dismissal permission',
      { status: 'responding', responseMode: 'message', canDismiss: false },
    ],
  ] as const)('does not dismiss a %s', (_name, policy) => {
    const store = createPendingQuestionDraftStore()
    const event = request(policy)
    const answers = { approach: ['  Keep the pending draft.\n'] }
    store.update(event, { answers, step: 1 })
    const snapshot = store.get(event)
    const respond = vi.fn(async () => {})

    expect(store.submit(event, respond, false)).toBe(false)
    expect(store.submit(event, respond, true)).toBe(false)
    expect(store.get(event)).toBe(snapshot)
    expect(store.get(event)).toMatchObject({ answers, step: 1, status: 'idle' })
    expect(respond).not.toHaveBeenCalled()
  })
})
