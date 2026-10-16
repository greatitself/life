import { Effect, Option } from 'effect'
import { describe, expect, it } from 'vitest'
import {
  AsyncQuestionError,
  asyncQuestionRequestId,
  codexAsyncQuestions,
  collectAsyncQuestions,
  decodeCodexAsyncMessage,
  validAsyncQuestionFollowup,
  validateAsyncQuestionReplyEffect,
  type AsyncQuestionBinding,
  type AsyncQuestionOrigin,
} from '../src/main/agent-async-questions'
import type {
  NativeRecoveryOwner,
  NativeRecoverySnapshot,
  NativeRecoveryStoredEvent,
  NativeRecoveryStoredInput,
  NativeRecoveryTransport,
} from '../src/main/native-recovery-types'
import type { AgentEvent } from '../src/shared/types'
import { formatAsyncQuestionReply } from '../src/shared/async-questions'

const originalSource = (overrides: Partial<AsyncQuestionOrigin> = {}): AsyncQuestionOrigin => ({
  transportId: 'source-transport',
  eventId: 'source-transport:wire:4:0',
  sessionId: 'ui-session',
  nativeThreadId: 'native-root',
  rootNativeThreadId: 'native-root',
  nativeTurnId: 'original-native-turn',
  itemId: 'native-item',
  ownerGeneration: 3,
  snapshotToken: 'original-snapshot',
  localTurn: 5,
  machine: JSON.stringify(['fixture-host', 22, 'fixture-user']),
  profileId: 'fixture-profile',
  workspace: '/private/workspace',
  ...overrides,
})

function owner(
  source: AsyncQuestionOrigin,
  overrides: Partial<NativeRecoveryOwner> = {},
): NativeRecoveryOwner {
  return {
    ownerId: 'root',
    sessionId: source.sessionId,
    generation: source.ownerGeneration,
    localTurn: source.localTurn,
    snapshotToken: source.snapshotToken,
    kind: 'root',
    workspace: source.workspace,
    nativeThreadId: source.rootNativeThreadId,
    nativeTurnId: source.nativeTurnId,
    state: 'active',
    input: {
      sessionId: source.sessionId,
      provider: 'codex',
      prompt: 'original prompt',
      mode: 'review',
      workspace: source.workspace,
    },
    ...overrides,
  }
}

function snapshot(
  source: AsyncQuestionOrigin,
  id = source.transportId,
  owners: readonly NativeRecoveryOwner[] = [owner(source)],
  events: readonly NativeRecoveryStoredEvent[] = [],
  inputs: readonly NativeRecoveryStoredInput[] = [],
): NativeRecoverySnapshot {
  const transport: NativeRecoveryTransport = {
    id,
    brokerId: id,
    brokerRoot: `/private/brokers/${id}`,
    launchCommand: 'exec codex app-server',
    provider: 'codex',
    providerVersion: '0.162.1',
    nativeProtocol: 'codex-app-server-jsonrpc',
    brokerProtocolVersion: 2,
    inputReceipts: 1,
    machine: {
      profileId: source.profileId,
      host: 'fixture-host',
      port: 22,
      username: 'fixture-user',
    },
    controller: { id: 'current-controller', epoch: 4 },
    initialization: { status: 'complete' },
    owners,
  }
  return {
    transport,
    allocatedInputSequence: inputs.length,
    acknowledgedInputSequence: inputs.filter((input) => input.acknowledged).length,
    outputCursor: 4,
    eventRevision: events.at(-1)?.revision || 0,
    inputs,
    outputs: [],
    events,
    historyAcks: [],
    historyPrepares: [],
    records: [
      { kind: 'create', revision: 1, transport },
      ...events.map((event) => ({ kind: 'event' as const, revision: event.revision, event })),
    ],
  }
}

function questionEvent(source: AsyncQuestionOrigin): NativeRecoveryStoredEvent {
  return {
    revision: 2,
    eventId: source.eventId,
    outputCursor: 4,
    emittedAtMs: 100,
    event: {
      sessionId: source.sessionId,
      provider: 'codex',
      type: 'question',
      responseMode: 'message',
      canDismiss: true,
      requestId: asyncQuestionRequestId(source),
      itemId: source.itemId,
      ...(source.nativeThreadId !== source.rootNativeThreadId
        ? { agentId: source.nativeThreadId }
        : {}),
      questions: [
        {
          id: 'question-1',
          question: '  Which path?\r\n🌍  ',
          options: [{ label: '  Inspect  ' }, { label: 'Run' }],
          isOther: true,
        },
        { id: 'question-2', question: 'Any notes?\n', isOther: true },
      ],
      details: {
        asyncQuestion: {
          nativeThreadId: source.nativeThreadId,
          rootNativeThreadId: source.rootNativeThreadId,
          ...(source.nativeTurnId !== undefined ? { nativeTurnId: source.nativeTurnId } : {}),
        },
      },
      nativeRecovery: {
        transportId: source.transportId,
        eventId: source.eventId,
        ownerGeneration: source.ownerGeneration,
        snapshotToken: source.snapshotToken,
        ...(source.localTurn !== undefined ? { localTurn: source.localTurn } : {}),
      },
    },
  }
}

const sourceSnapshot = (source = originalSource()) =>
  snapshot(source, source.transportId, [owner(source)], [questionEvent(source)])
const answers = () => ({ 'question-1': ['  Inspect  '], 'question-2': ['\n  exact notes\r\n🌍  '] })
const publicQuestion = (source: AsyncQuestionOrigin): AgentEvent =>
  questionEvent(source).event as unknown as AgentEvent
const promptFor = (source: AsyncQuestionOrigin) =>
  formatAsyncQuestionReply(publicQuestion(source).questions!, answers())

function replyBinding(source: AsyncQuestionOrigin): AsyncQuestionBinding {
  return {
    mode: 'async-question',
    requestId: asyncQuestionRequestId(source),
    source: structuredClone(source),
    prompt: promptFor(source),
    answers: answers(),
  }
}

function replyInput(
  source: AsyncQuestionOrigin,
  {
    written = false,
    sequence = 1,
    method = 'turn/steer',
    binding = replyBinding(source),
  }: {
    written?: boolean
    sequence?: number
    method?: 'turn/start' | 'turn/steer'
    binding?: AsyncQuestionBinding
  } = {},
): NativeRecoveryStoredInput {
  const native = {
    id: 40 + sequence,
    method,
    params: {
      threadId: source.nativeThreadId,
      ...(method === 'turn/steer' ? { expectedTurnId: 'destination-native-turn' } : {}),
      input: [{ type: 'text', text: binding.prompt }],
    },
  }
  const frame = {
    type: 'write' as const,
    sequence,
    data: Buffer.from(JSON.stringify(native) + '\n').toString('base64'),
  }
  return {
    sequence,
    frame,
    wire: JSON.stringify(frame) + '\n',
    semantic: {
      kind: method === 'turn/start' ? 'user-prompt' : 'steer',
      method,
      requestId: native.id,
      sessionId: source.sessionId,
      nativeThreadId: source.nativeThreadId,
      nativeTurnId: 'destination-native-turn',
      ownerGeneration: 9,
      responseBinding: binding,
    },
    acknowledged: written,
    written,
    consumed: written,
    ...(written ? { deliveryReceipt: { cursor: 5, status: 'written' as const } } : {}),
  }
}

function destinationSnapshot(
  source: AsyncQuestionOrigin,
  inputs: readonly NativeRecoveryStoredInput[],
  id = 'destination-transport',
): NativeRecoverySnapshot {
  return snapshot(
    source,
    id,
    [
      owner(source, {
        generation: 9,
        localTurn: 8,
        snapshotToken: 'destination-snapshot',
        nativeThreadId: source.nativeThreadId,
        nativeTurnId: 'destination-native-turn',
        ...(source.nativeThreadId !== source.rootNativeThreadId
          ? { kind: 'child', parentSessionId: source.sessionId }
          : {}),
      }),
    ],
    [],
    inputs,
  )
}

function resolution(
  source: AsyncQuestionOrigin,
  status: 'answered' | 'dismissed',
): NativeRecoveryStoredEvent {
  const eventId = `${source.transportId}:local:${status}`
  return {
    revision: 3,
    eventId,
    outputCursor: 4,
    event: {
      sessionId: source.sessionId,
      type: 'request-resolved',
      requestId: asyncQuestionRequestId(source),
      status,
      details: { asyncQuestionSource: structuredClone(source) },
      nativeRecovery: {
        transportId: source.transportId,
        eventId,
        ownerGeneration: source.ownerGeneration,
        snapshotToken: source.snapshotToken,
        ...(source.localTurn !== undefined ? { localTurn: source.localTurn } : {}),
      },
    },
  }
}

function withResolution(
  source: AsyncQuestionOrigin,
  status: 'answered' | 'dismissed',
): NativeRecoverySnapshot {
  return snapshot(
    source,
    source.transportId,
    [owner(source)],
    [questionEvent(source), resolution(source, status)],
  )
}

describe('canonical asynchronous native questions', () => {
  it('preserves native titles, choices, null/absent options and freeform capability without trimming', () => {
    const result = decodeCodexAsyncMessage({
      type: 'agentMessage',
      id: 'item',
      delivery: 'async',
      questions: [
        { title: '  exact\r\n🌍  ', options: [' First ', 'Second'] },
        { title: 'Freeform', options: null },
        { title: 'More notes' },
      ],
    })
    expect(Option.isSome(result)).toBe(true)
    if (Option.isNone(result)) throw new Error('Expected valid native async metadata')
    expect(codexAsyncQuestions(result.value)).toEqual([
      {
        id: 'question-1',
        header: 'Question 1',
        question: '  exact\r\n🌍  ',
        options: [{ label: ' First ' }, { label: 'Second' }],
        isOther: true,
      },
      { id: 'question-2', header: 'Question 2', question: 'Freeform', isOther: true },
      { id: 'question-3', header: 'Question 3', question: 'More notes', isOther: true },
    ])
  })

  it.each([
    { type: 'agentMessage', id: 'item', questions: [{ title: 'Question' }] },
    { type: 'agentMessage', id: 'item', delivery: 'sync', questions: [{ title: 'Question' }] },
    { type: 'agentMessage', id: 'item', delivery: 'async', questions: [] },
    { type: 'agentMessage', id: 'item', delivery: 'async', questions: [{ title: '' }] },
    {
      type: 'agentMessage',
      id: 'item',
      delivery: 'async',
      questions: [{ title: 'Question', options: [42] }],
    },
  ])('does not interpret unsupported or malformed metadata as a native question: %j', (value) => {
    expect(Option.isNone(decodeCodexAsyncMessage(value))).toBe(true)
  })

  it('keeps separate identities for a repeated item on a later native turn', () => {
    const source = originalSource()
    expect(asyncQuestionRequestId(source)).toBe(asyncQuestionRequestId(structuredClone(source)))
    expect(asyncQuestionRequestId({ ...source, nativeTurnId: 'later-native-turn' })).not.toBe(
      asyncQuestionRequestId(source),
    )
    expect(asyncQuestionRequestId({ ...source, nativeThreadId: 'native-child' })).not.toBe(
      asyncQuestionRequestId(source),
    )
  })

  it('retains the original private owner after completion and a later generation replaces it', () => {
    const source = originalSource()
    const original = sourceSnapshot(source)
    const completed = owner(source, { state: 'complete' })
    const next = owner(source, {
      generation: 4,
      localTurn: 6,
      snapshotToken: 'next-snapshot',
      state: 'active',
      nativeTurnId: 'next-native-turn',
    })
    const historical = {
      ...original,
      transport: { ...original.transport, owners: [next] },
      records: [
        ...original.records,
        { kind: 'transport' as const, revision: 3, patch: { owners: [completed] } },
        { kind: 'transport' as const, revision: 4, patch: { owners: [next] } },
      ],
    }
    const before = structuredClone(historical)
    const record = collectAsyncQuestions([historical]).get(asyncQuestionRequestId(source))!
    expect(record.state).toBe('open')
    expect(record.source).toEqual(source)
    expect(record.event.questions).toEqual(publicQuestion(source).questions)
    expect(historical).toEqual(before)
  })

  it('does not grant an imported event ownership without its matching historical private owner', () => {
    const source = originalSource()
    const imported = sourceSnapshot(source)
    expect(collectAsyncQuestions([{ ...imported, records: [] }]).size).toBe(0)
  })

  it.each(['turn/start', 'turn/steer'] as const)(
    'a reserved %s in a different transport/generation fences another answer before ACK',
    (method) => {
      const source = originalSource()
      const input = replyInput(source, { method })
      const record = collectAsyncQuestions([
        destinationSnapshot(source, [input]),
        sourceSnapshot(source),
      ]).get(asyncQuestionRequestId(source))!
      expect(record.state).toBe('responding')
      expect(record.source).toEqual(source)
      expect(record.reply?.transportId).toBe('destination-transport')
      expect(record.reply?.input.sequence).toBe(1)
      expect(record.reply?.input.acknowledged).toBe(false)
      expect(record.reply?.input.written).toBe(false)
      expect(record.reply?.binding.prompt).toBe(promptFor(source))
    },
  )

  it('keeps a written reply responding until the canonical successful RPC resolution exists', () => {
    const source = originalSource()
    const record = collectAsyncQuestions([
      sourceSnapshot(source),
      destinationSnapshot(source, [replyInput(source, { written: true })]),
    ]).get(asyncQuestionRequestId(source))!
    expect(record.reply?.input.written).toBe(true)
    expect(record.state).toBe('responding')
  })

  it.each([false, true])(
    'restores an answered question independently of journal traversal order (reverse=%s)',
    (reverse) => {
      const source = originalSource()
      const snapshots = [
        withResolution(source, 'answered'),
        destinationSnapshot(source, [replyInput(source, { written: true })]),
      ]
      const record = collectAsyncQuestions(reverse ? snapshots.reverse() : snapshots).get(
        asyncQuestionRequestId(source),
      )!
      expect(record.state).toBe('answered')
      expect(record.reply?.binding.source).toEqual(source)
    },
  )

  it('requires a written input before accepting an answered resolution', () => {
    const source = originalSource()
    expect(() => collectAsyncQuestions([withResolution(source, 'answered')])).toThrow(
      AsyncQuestionError,
    )
    expect(() =>
      collectAsyncQuestions([
        withResolution(source, 'answered'),
        destinationSnapshot(source, [replyInput(source)]),
      ]),
    ).toThrow(AsyncQuestionError)
  })

  it.each(['session', 'transport', 'generation', 'snapshot'] as const)(
    'does not accept an answered resolution from a different original %s',
    (field) => {
      const source = originalSource()
      const canonical = resolution(source, 'answered')
      const foreign = {
        ...canonical,
        event: {
          ...canonical.event,
          sessionId: field === 'session' ? 'foreign-session' : source.sessionId,
          nativeRecovery: {
            transportId: field === 'transport' ? 'foreign-transport' : source.transportId,
            ownerGeneration: field === 'generation' ? 4 : source.ownerGeneration,
            snapshotToken: field === 'snapshot' ? 'foreign-snapshot' : source.snapshotToken,
          },
        },
      }
      const original = snapshot(
        source,
        source.transportId,
        [owner(source)],
        [questionEvent(source), foreign],
      )
      const record = collectAsyncQuestions([
        original,
        destinationSnapshot(source, [replyInput(source, { written: true })]),
      ]).get(asyncQuestionRequestId(source))!
      expect(record.state).toBe('responding')
      expect(record.source).toEqual(source)
    },
  )

  it('restores local dismissal without allocating any native input', () => {
    const source = originalSource()
    const local = withResolution(source, 'dismissed')
    const record = collectAsyncQuestions([local]).get(asyncQuestionRequestId(source))!
    expect(record.state).toBe('dismissed')
    expect(record.reply).toBeUndefined()
    expect(local.inputs).toEqual([])
    expect(local.allocatedInputSequence).toBe(0)
  })

  it.each([false, true])(
    'fails closed on dismissal plus any reserved reply in either journal order (reverse=%s)',
    (reverse) => {
      const source = originalSource()
      const snapshots = [
        withResolution(source, 'dismissed'),
        destinationSnapshot(source, [replyInput(source)]),
      ]
      expect(() => collectAsyncQuestions(reverse ? snapshots.reverse() : snapshots)).toThrow(
        AsyncQuestionError,
      )
    },
  )

  it('fails closed when two transports each reserve a reply to the same original question', () => {
    const source = originalSource()
    expect(() =>
      collectAsyncQuestions([
        sourceSnapshot(source),
        destinationSnapshot(source, [replyInput(source)], 'first-destination'),
        destinationSnapshot(source, [replyInput(source)], 'second-destination'),
      ]),
    ).toThrow(AsyncQuestionError)
  })

  it.each(['machine', 'profile', 'workspace', 'native-thread'] as const)(
    'rejects a bound destination with a changed %s',
    (field) => {
      const source = originalSource()
      let destination = destinationSnapshot(source, [replyInput(source)])
      if (field === 'machine')
        destination = {
          ...destination,
          transport: {
            ...destination.transport,
            machine: { ...destination.transport.machine, host: 'foreign-host' },
          },
        }
      if (field === 'profile')
        destination = {
          ...destination,
          transport: {
            ...destination.transport,
            machine: { ...destination.transport.machine, profileId: 'foreign-profile' },
          },
        }
      if (field === 'workspace' || field === 'native-thread') {
        const changed = destination.transport.owners.map((value) => ({
          ...value,
          ...(field === 'workspace'
            ? { workspace: '/foreign/workspace' }
            : { nativeThreadId: 'foreign-thread' }),
        }))
        destination = {
          ...destination,
          transport: { ...destination.transport, owners: changed },
          records: [
            {
              kind: 'create',
              revision: 1,
              transport: { ...destination.transport, owners: changed },
            },
          ],
        }
      }
      expect(() => collectAsyncQuestions([sourceSnapshot(source), destination])).toThrow(
        AsyncQuestionError,
      )
    },
  )

  it('fails closed when a claim changes the immutable origin behind an existing request ID', () => {
    const source = originalSource()
    const binding = { ...replyBinding(source), source: { ...source, eventId: 'forged-event' } }
    expect(() =>
      collectAsyncQuestions([
        sourceSnapshot(source),
        destinationSnapshot(source, [replyInput(source, { binding })]),
      ]),
    ).toThrow(AsyncQuestionError)
  })

  it('retains the child target and rejects sending its answer to the parent native thread', () => {
    const source = originalSource({ nativeThreadId: 'native-child' })
    const valid = collectAsyncQuestions([
      sourceSnapshot(source),
      destinationSnapshot(source, [replyInput(source)]),
    ]).get(asyncQuestionRequestId(source))!
    expect(valid.source.nativeThreadId).toBe('native-child')
    expect(valid.source.rootNativeThreadId).toBe('native-root')
    const input = replyInput(source)
    const wire = JSON.parse(
      Buffer.from(input.frame.type === 'write' ? input.frame.data : '', 'base64').toString('utf8'),
    )
    wire.params.threadId = source.rootNativeThreadId
    const parentFrame = {
      ...input.frame,
      type: 'write' as const,
      data: Buffer.from(JSON.stringify(wire) + '\n').toString('base64'),
    }
    const misdirected = {
      ...input,
      frame: parentFrame,
      wire: JSON.stringify(parentFrame) + '\n',
      semantic: { ...input.semantic, nativeThreadId: source.rootNativeThreadId },
    }
    expect(() =>
      collectAsyncQuestions([sourceSnapshot(source), destinationSnapshot(source, [misdirected])]),
    ).toThrow(AsyncQuestionError)
  })

  it('does not accept a changed wire prompt even when its private-looking binding is unchanged', () => {
    const source = originalSource()
    const input = replyInput(source)
    const native = {
      method: 'turn/steer',
      params: {
        threadId: source.nativeThreadId,
        input: [{ type: 'text', text: promptFor(source).trim() }],
      },
    }
    const frame = {
      type: 'write' as const,
      sequence: input.sequence,
      data: Buffer.from(JSON.stringify(native) + '\n').toString('base64'),
    }
    expect(() =>
      collectAsyncQuestions([
        sourceSnapshot(source),
        destinationSnapshot(source, [{ ...input, frame, wire: JSON.stringify(frame) + '\n' }]),
      ]),
    ).toThrow(AsyncQuestionError)
  })
})

describe('exact asynchronous question replies', () => {
  it('accepts the canonical full answer without trimming or normalizing whitespace', () => {
    const source = originalSource()
    const reply = { requestId: asyncQuestionRequestId(source), answers: answers() }
    const prompt = promptFor(source)
    expect(prompt).toBe(
      'Question:   Which path?\r\n🌍  \nAnswer:   Inspect  \n\nQuestion: Any notes?\n\nAnswer: \n  exact notes\r\n🌍  ',
    )
    expect(
      Effect.runSync(validateAsyncQuestionReplyEffect(publicQuestion(source), reply, prompt)),
    ).toEqual(reply)
  })

  it.each([
    ['missing answer', { 'question-1': ['Inspect'] }],
    ['extra answer', { ...answers(), extra: ['unexpected'] }],
    ['empty list', { ...answers(), 'question-1': [] }],
    ['empty string', { ...answers(), 'question-1': [''] }],
    ['multiple answers for one question', { ...answers(), 'question-1': ['Inspect', 'Run'] }],
    ['invalid answer scalar', { ...answers(), 'question-1': 'Inspect' }],
    ['invalid map', null],
  ])('rejects %s', (_label, invalid) => {
    const source = originalSource()
    const error = Effect.runSync(
      Effect.flip(
        validateAsyncQuestionReplyEffect(
          publicQuestion(source),
          { requestId: asyncQuestionRequestId(source), answers: invalid },
          promptFor(source),
        ),
      ),
    )
    expect(error).toBeInstanceOf(AsyncQuestionError)
  })

  it('rejects a different request ID or a prompt changed after formatting', () => {
    const source = originalSource()
    const event = publicQuestion(source)
    for (const [requestId, prompt] of [
      ['foreign-question', promptFor(source)],
      [asyncQuestionRequestId(source), promptFor(source).trim()],
    ]) {
      const error = Effect.runSync(
        Effect.flip(
          validateAsyncQuestionReplyEffect(event, { requestId, answers: answers() }, prompt),
        ),
      )
      expect(error).toBeInstanceOf(AsyncQuestionError)
    }
  })

  it('validates the exact authored main followup against destination turn and original context', () => {
    const source = originalSource()
    const prompt = promptFor(source)
    const main = {
      kind: 'main',
      userMessage: {
        id: 'stable-user-message',
        role: 'user',
        text: prompt,
        turn: 8,
        createdAt: 200,
      },
      threadSeed: {
        id: source.sessionId,
        profileId: source.profileId,
        provider: 'codex',
        workspace: source.workspace,
        turn: 8,
      },
    }
    expect(validAsyncQuestionFollowup(main, source, prompt, 8)).toBe(true)
    expect(validAsyncQuestionFollowup(main, source, prompt, 9)).toBe(false)
    expect(
      validAsyncQuestionFollowup(
        { ...main, userMessage: { ...main.userMessage, text: prompt.trim() } },
        source,
        prompt,
        8,
      ),
    ).toBe(false)
    expect(
      validAsyncQuestionFollowup(
        { ...main, threadSeed: { ...main.threadSeed, profileId: 'foreign-profile' } },
        source,
        prompt,
        8,
      ),
    ).toBe(false)
    expect(
      validAsyncQuestionFollowup(
        { ...main, threadSeed: { ...main.threadSeed, workspace: '/foreign/workspace' } },
        source,
        prompt,
        8,
      ),
    ).toBe(false)
    const binding = { ...replyBinding(source), clientRecovery: main }
    const record = collectAsyncQuestions([
      sourceSnapshot(source),
      destinationSnapshot(source, [replyInput(source, { written: true, binding })]),
    ]).get(asyncQuestionRequestId(source))!
    expect(record.reply?.binding.clientRecovery).toEqual(main)
    expect(record.state).toBe('responding')
  })

  it('binds a Studio followup to the exact native child rather than its parent', () => {
    const source = originalSource({ nativeThreadId: 'native-child' })
    const prompt = promptFor(source)
    const studio = {
      kind: 'studio-question-followup',
      sessionId: source.sessionId,
      profileId: source.profileId,
      provider: 'codex',
      workspace: source.workspace,
      remoteId: source.nativeThreadId,
      userMessage: { id: 'studio-answer', role: 'user', text: prompt, turn: 8, createdAt: 200 },
    }
    expect(validAsyncQuestionFollowup(studio, source, prompt, 8)).toBe(true)
    expect(
      validAsyncQuestionFollowup(
        { ...studio, remoteId: source.rootNativeThreadId },
        source,
        prompt,
        8,
      ),
    ).toBe(false)
  })
})
