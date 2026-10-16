import { EventEmitter } from 'node:events'
import type { ClientChannel } from 'ssh2'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { Agents } from '../src/main/agents'
import type { NativeRecoveryInputSemantic } from '../src/main/native-recovery-types'
import type { SSHConnection } from '../src/main/ssh'
import type { AgentEvent, AgentSteerInput, StartInput } from '../src/shared/types'

vi.mock('../src/main/provider-titles', () => ({
  generateProviderTitle: vi.fn(async () => undefined),
}))

type Wire = Record<string, any>
const nativeThread = 'original-native-thread'
const nativeTurn = 'original-native-turn'
const originalText = '  Original provider text\r\nwith an exact 🌍 and \ud800  '
const firstAnswer = '  Keep this exact\r\nanswer 🌍\ud800  '
const secondAnswer = 'A custom answer outside the options'
const replyPrompt =
  `Question: Which target?  \nAnswer: ${firstAnswer}` +
  `\n\nQuestion: Any other details?\nAnswer: ${secondAnswer}`

class Channel extends EventEmitter {
  readonly stderr = new EventEmitter()
  readonly sent: Wire[] = []
  readonly nativeWrites: { message: Wire; semantic?: NativeRecoveryInputSemantic }[] = []
  readonly heldMethods = new Set<string>()
  destroyed = false

  write(raw: string) {
    return this.writeNative(JSON.parse(raw))
  }

  writeNative(message: Wire, semantic?: NativeRecoveryInputSemantic) {
    this.sent.push(message)
    this.nativeWrites.push({ message, semantic })
    if (message.id != null && message.method && !this.heldMethods.has(message.method))
      queueMicrotask(() => this.succeed(message))
    return true
  }

  async writeNativeAndWait(message: Wire, semantic?: NativeRecoveryInputSemantic) {
    this.writeNative(message, semantic)
  }

  succeed(message: Wire) {
    const result =
      message.method === 'thread/start' || message.method === 'thread/resume'
        ? { thread: { id: nativeThread } }
        : message.method === 'turn/start'
          ? { turn: { id: nativeTurn } }
          : message.method === 'model/list'
            ? { data: [{ model: 'test-model', displayName: 'Test model', isDefault: true }] }
            : {}
    this.reply({ id: message.id, result })
  }

  reply(message: Wire) {
    this.emit('data', Buffer.from(JSON.stringify(message) + '\n'))
  }

  signal() {}
  close() {
    this.destroyed = true
    this.emit('close')
  }
}

const active: Agents[] = []
afterEach(() => {
  for (const agents of active.splice(0)) agents.close()
})

async function fixture() {
  const channel = new Channel()
  const ssh = new EventEmitter() as SSHConnection
  ssh.state = {
    status: 'connected',
    home: '/home/researcher',
    workspace: '/project',
    codex: 'codex-cli 0.162.1',
    profile: {
      id: 'original-profile',
      name: 'Original machine',
      host: 'original.example',
      port: 22,
      username: 'researcher',
      auth: 'agent',
      privateKeyPath: '',
      workspace: '/project',
    },
  }
  ssh.channel = vi.fn(async () => channel as unknown as ClientChannel)
  const events: AgentEvent[] = []
  const agents = new Agents(ssh, (event) => events.push(event))
  active.push(agents)
  await agents.start({
    sessionId: 'local',
    localTurn: 1,
    provider: 'codex',
    model: 'test-model',
    prompt: '  Original user prompt\r\n  ',
    mode: 'ask-for-approval',
  })
  const item = {
    id: 'async-message',
    type: 'agentMessage',
    phase: 'final_answer',
    text: originalText,
    delivery: 'async',
    questions: [
      { title: 'Which target?  ', options: ['First target', 'Second target'] },
      { title: 'Any other details?', options: null },
    ],
  }
  const message = (method = 'item/completed', threadId = nativeThread, turnId = nativeTurn) =>
    channel.reply({ method, params: { threadId, turnId, item } })
  const question = () => {
    const event = events.findLast(
      (event) => event.type === 'question' && event.responseMode === 'message',
    )
    if (!event?.requestId) throw new Error('The native asynchronous question was not published')
    return event as AgentEvent & { requestId: string }
  }
  const reply = () => ({
    requestId: question().requestId,
    answers: { 'question-1': [firstAnswer], 'question-2': [secondAnswer] },
  })
  const complete = () =>
    channel.reply({
      method: 'turn/completed',
      params: { threadId: nativeThread, turn: { id: nativeTurn, status: 'completed' } },
    })
  return { agents, channel, ssh, events, item, message, question, reply, complete }
}

describe('Agents asynchronous native Codex message questions', () => {
  it('publishes completed questions separately while preserving the original text lifecycle', async () => {
    const { channel, events, message, question, item } = await fixture()
    const before = channel.sent.length
    message('item/started')
    expect(events.filter((event) => event.type === 'question')).toEqual([])
    const originalEvent = {
      sessionId: 'local',
      provider: 'codex',
      type: 'text',
      itemId: item.id,
      text: originalText,
      status: 'replace',
      phase: 'final_answer',
    }
    expect(events.findLast((event) => event.type === 'text')).toEqual(originalEvent)

    message()
    expect(events.filter((event) => event.type === 'text')).toEqual([originalEvent, originalEvent])
    expect(events.filter((event) => event.type === 'question')).toHaveLength(1)
    expect(question()).toMatchObject({
      sessionId: 'local',
      provider: 'codex',
      itemId: item.id,
      requestId: expect.stringMatching(/^codex-async:/),
      responseMode: 'message',
      canDismiss: true,
      questions: [
        {
          id: 'question-1',
          question: 'Which target?  ',
          isOther: true,
          options: [{ label: 'First target' }, { label: 'Second target' }],
        },
        { id: 'question-2', question: 'Any other details?', isOther: true },
      ],
      details: {
        asyncQuestion: {
          nativeThreadId: nativeThread,
          rootNativeThreadId: nativeThread,
          nativeTurnId: nativeTurn,
        },
      },
    })
    expect(question().questions![1]).not.toHaveProperty('options')
    expect(channel.sent).toHaveLength(before)
    expect(events.indexOf(question())).toBeGreaterThan(
      events.findLastIndex((event) => event.type === 'text'),
    )
  })

  it('keeps native callback questions on their original response protocol', async () => {
    const { agents, channel, events } = await fixture()
    const questions = [{ id: 'native-question', question: 'Native blocking question?' }]
    channel.reply({
      id: 'callback-request',
      method: 'item/tool/requestUserInput',
      params: { threadId: nativeThread, turnId: nativeTurn, itemId: 'tool', questions },
    })
    const pending = events.findLast((event) => event.type === 'question')!
    expect(pending.questions).toEqual(questions)
    expect(pending).not.toHaveProperty('responseMode')
    const inputsBefore = channel.sent.filter((message) =>
      ['turn/start', 'turn/steer'].includes(message.method),
    ).length
    const exactAnswer = '  Native answer\r\n🌍  '
    await agents.respond('local', pending.requestId!, true, { 'native-question': [exactAnswer] })
    expect(channel.sent.findLast((message) => message.id === 'callback-request')).toEqual({
      id: 'callback-request',
      result: { answers: { 'native-question': { answers: [exactAnswer] } } },
    })
    expect(
      channel.sent.filter((message) => ['turn/start', 'turn/steer'].includes(message.method)),
    ).toHaveLength(inputsBefore)
    expect(events.findLast((event) => event.type === 'request-resolved')).toMatchObject({
      requestId: pending.requestId,
      status: 'answered',
    })
  })

  it('answers an opaque prefixed native callback ID through its existing approval entry', async () => {
    const { agents, channel, events } = await fixture()
    const localId = 'codex-async:opaque-existing-native-approval'
    const wireId = 'codex-async:opaque-provider-callback'
    const allocateId = vi
      .spyOn(
        agents as unknown as { permissionLocalId: (...args: unknown[]) => string },
        'permissionLocalId',
      )
      .mockReturnValueOnce(localId)
    try {
      channel.reply({
        id: wireId,
        method: 'item/tool/requestUserInput',
        params: {
          threadId: nativeThread,
          turnId: nativeTurn,
          itemId: 'native-tool',
          questions: [{ id: 'native-question', question: 'Keep the native callback?' }],
        },
      })
    } finally {
      allocateId.mockRestore()
    }
    const pending = events.findLast((event) => event.type === 'question')!
    expect(pending.requestId).toBe(localId)
    expect(pending).not.toHaveProperty('responseMode')
    const before = channel.sent.length
    const exactAnswer = '  Keep this callback\r\n🌍  '
    await agents.respond('local', localId, true, { 'native-question': [exactAnswer] })
    expect(channel.sent.slice(before)).toEqual([
      { id: wireId, result: { answers: { 'native-question': { answers: [exactAnswer] } } } },
    ])
    expect(
      channel.nativeWrites.findLast((write) => write.message.id === wireId)?.semantic,
    ).toMatchObject({ kind: 'permission-response', permissionRequestId: wireId })
    expect(events.findLast((event) => event.type === 'request-resolved')).toMatchObject({
      requestId: localId,
      status: 'answered',
    })
  })

  it.each(['start', 'steer'] as const)(
    'answers through normal %s on the exact native thread with a bound native outbox semantic',
    async (mode) => {
      const { agents, channel, events, message, question, reply, complete } = await fixture()
      message()
      const pending = question()
      const questionReply = reply()
      if (mode === 'start') complete()
      expect(events.some((event) => event.type === 'request-resolved')).toBe(false)
      const method = mode === 'start' ? 'turn/start' : 'turn/steer'
      channel.heldMethods.add(method)
      const inputsBefore = channel.sent.filter((message) => message.method === method).length
      const submit = () =>
        mode === 'start'
          ? agents.start({
              sessionId: 'local',
              localTurn: 2,
              provider: 'codex',
              remoteId: nativeThread,
              workspace: '/project',
              model: 'test-model',
              mode: 'ask-for-approval',
              prompt: replyPrompt,
              questionReply,
            })
          : agents.steer({ sessionId: 'local', prompt: replyPrompt, questionReply })
      const submitting = submit()
      await vi.waitFor(() =>
        expect(channel.sent.filter((message) => message.method === method)).toHaveLength(
          inputsBefore + 1,
        ),
      )
      const write = channel.nativeWrites.findLast((entry) => entry.message.method === method)!
      expect(write.message.params).toMatchObject({
        threadId: nativeThread,
        input: [{ type: 'text', text: replyPrompt }],
        ...(mode === 'steer' ? { expectedTurnId: nativeTurn } : {}),
      })
      expect(write.message.params).not.toHaveProperty('questionReply')
      expect(write.semantic).toMatchObject({
        kind: mode === 'start' ? 'user-prompt' : 'steer',
        method,
        sessionId: 'local',
        nativeThreadId: nativeThread,
        responseBinding: {
          mode: 'async-question',
          requestId: pending.requestId,
          prompt: replyPrompt,
          answers: questionReply.answers,
          source: {
            sessionId: 'local',
            nativeThreadId: nativeThread,
            rootNativeThreadId: nativeThread,
            nativeTurnId: nativeTurn,
            itemId: 'async-message',
            localTurn: 1,
            profileId: 'original-profile',
            workspace: '/project',
          },
        },
      })
      expect(events.some((event) => event.type === 'request-resolved')).toBe(false)
      expect(channel.sent.filter((message) => message.method === 'thread/start')).toHaveLength(1)
      expect(channel.sent.filter((message) => message.method === 'thread/resume')).toHaveLength(0)

      channel.succeed(write.message)
      await submitting
      expect(events.filter((event) => event.type === 'request-resolved')).toEqual([
        expect.objectContaining({ requestId: pending.requestId, status: 'answered' }),
      ])
      const writesAfter = channel.sent.length
      await expect(submit()).rejects.toThrow(/no longer open|awaiting delivery/)
      expect(channel.sent).toHaveLength(writesAfter)
    },
  )

  it('rejects changed answer text and native destinations before sending any provider input', async () => {
    const { agents, channel, events, message, reply, complete } = await fixture()
    message()
    const questionReply = reply()
    const before = channel.sent.length
    await expect(
      agents.steer({ sessionId: 'local', prompt: replyPrompt + '\n', questionReply }),
    ).rejects.toThrow(/exact question or answer text/)
    expect(channel.sent).toHaveLength(before)
    complete()
    const afterCompletion = channel.sent.length
    const input: StartInput = {
      sessionId: 'local',
      localTurn: 2,
      provider: 'codex',
      model: 'test-model',
      mode: 'ask-for-approval',
      prompt: replyPrompt,
      questionReply,
    }
    for (const changed of [{ remoteId: 'another-thread' }, { workspace: '/another-project' }])
      await expect(agents.start({ ...input, ...changed })).rejects.toThrow(
        /original native conversation or workspace/,
      )
    expect(channel.sent).toHaveLength(afterCompletion)
    expect(events.some((event) => event.type === 'request-resolved')).toBe(false)
    await agents.start(input)
    expect(events.findLast((event) => event.type === 'request-resolved')).toMatchObject({
      requestId: questionReply.requestId,
      status: 'answered',
    })
  })

  it('dismisses locally without a callback response or another provider turn', async () => {
    const { agents, channel, events, message, question } = await fixture()
    message()
    const requestId = question().requestId
    const before = channel.sent.length
    await expect(agents.respond('local', requestId, true)).rejects.toThrow(/normal message input/)
    expect(channel.sent).toHaveLength(before)
    await agents.respond('local', requestId, false)
    expect(channel.sent).toHaveLength(before)
    expect(events.findLast((event) => event.type === 'request-resolved')).toMatchObject({
      sessionId: 'local',
      requestId,
      status: 'dismissed',
    })
    await expect(agents.respond('local', requestId, false)).rejects.toThrow(/no longer open/)
    expect(channel.sent).toHaveLength(before)
  })

  it('retains a child question identity and refuses to answer through the parent conversation', async () => {
    const { agents, channel, events, message, question, reply } = await fixture()
    channel.reply({
      method: 'thread/started',
      params: {
        thread: { id: 'native-child', parentThreadId: nativeThread, agentNickname: 'Researcher' },
      },
    })
    message('item/completed', 'native-child', 'child-turn')
    const pending = question()
    expect(pending).toMatchObject({
      agentId: 'native-child',
      agentName: 'Researcher',
      details: {
        asyncQuestion: {
          nativeThreadId: 'native-child',
          rootNativeThreadId: nativeThread,
          nativeTurnId: 'child-turn',
        },
      },
    })
    const before = channel.sent.length
    const input: AgentSteerInput = {
      sessionId: 'local',
      prompt: replyPrompt,
      questionReply: reply(),
    }
    await expect(agents.steer(input)).rejects.toThrow(/child agent|parent conversation/)
    expect(channel.sent).toHaveLength(before)
    expect(events.some((event) => event.type === 'request-resolved')).toBe(false)
    await agents.respond('local', pending.requestId, false)
    expect(channel.sent).toHaveLength(before)
    expect(events.findLast((event) => event.type === 'request-resolved')).toMatchObject({
      requestId: pending.requestId,
      status: 'dismissed',
    })
  })
})
