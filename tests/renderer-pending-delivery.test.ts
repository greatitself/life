import { EventEmitter } from 'node:events'
import { Duplex, PassThrough } from 'node:stream'
import type { ClientChannel } from 'ssh2'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { Agents } from '../src/main/agents'
import { DurableRemoteChannel, type DurableChannelHost } from '../src/main/durable-remote-channel'
import type { RemoteAgentBrokerConfig } from '../src/main/remote-agent-broker'
import type { SSHConnection } from '../src/main/ssh'
import type { AgentEvent, ConnectionState, Provider } from '../src/shared/types'

vi.mock('../src/main/provider-titles', () => ({
  generateProviderTitle: vi.fn(async () => undefined),
}))

type Wire = Record<string, any>
type InputFrame = {
  type: string
  sequence: number
  data?: string
  signal?: string
  writerLease?: { epoch: number; token: string }
}
const prompt = '  Exact original prompt\r\n🧪 e\u0301 中  '
const answer = '  Native answer\r\n🧪 e\u0301 中 \ud800  '
const localId = 'local-document-thread'
const childId = 'native-background-child'
const wireId = 'native-response-42'
const decision = {
  acceptWithExecpolicyAmendment: { execpolicy_amendment: ['printf', '🧪 exact words'] },
}

class Attachment extends Duplex {
  readonly stderr = new PassThrough()
  readonly inputs: InputFrame[] = []
  closes = 0

  constructor(readonly broker: Broker) {
    super({ autoDestroy: false })
  }

  override _read() {}

  override _write(chunk: Buffer, _encoding: BufferEncoding, callback: () => void) {
    for (const line of chunk.toString().trim().split('\n')) {
      const frame = JSON.parse(line) as InputFrame
      this.inputs.push(frame)
      queueMicrotask(() => this.broker.receive(this, frame))
    }
    callback()
  }

  frame(value: Wire) {
    this.push(JSON.stringify(value) + '\n')
  }

  close() {
    this.closes++
    if (this.broker.attachment === this) this.broker.attachment = undefined
    this.emit('close')
  }
}

/** The stand-in models broker numbering and native framing, without starting a process. */
class Broker {
  attachment?: Attachment
  readonly received = new Set<number>()
  readonly messages: Wire[] = []
  readonly journal: Wire[] = []
  readonly held = new Set<number>()
  cursor = 0
  holdNativeResponse = false
  readonly remoteId = 'exact-native-thread'
  readonly turnId = 'exact-native-turn'

  acknowledgedSequence() {
    let sequence = 0
    while (this.received.has(sequence + 1) && !this.held.has(sequence + 1)) sequence++
    return sequence
  }

  receive(attachment: Attachment, frame: InputFrame) {
    const message =
      frame.type === 'write'
        ? (JSON.parse(Buffer.from(frame.data!, 'base64').toString()) as Wire)
        : undefined
    const nativeResponse = message?.id === wireId || message?.response?.request_id === wireId
    if (nativeResponse && this.holdNativeResponse) this.held.add(frame.sequence)
    const duplicate = this.received.has(frame.sequence)
    this.received.add(frame.sequence)
    const acknowledged = this.acknowledgedSequence()
    if (acknowledged > 0) attachment.frame({ type: 'ack', sequence: acknowledged })
    if (duplicate) return
    if (!message) return
    this.messages.push(message)
    if (message.type === 'control_request') {
      this.reply({
        type: 'control_response',
        response: {
          subtype: 'success',
          request_id: message.request_id,
          response:
            message.request.subtype === 'initialize'
              ? { session_state: 'idle', models: [{ value: 'test-model', displayName: 'Test' }] }
              : {},
        },
      })
    } else if (typeof message.id === 'number' && message.method) {
      const results: Record<string, Wire> = {
        initialize: {},
        'config/read': { config: { model: 'test-model' } },
        'model/list': { data: [{ model: 'test-model', isDefault: true }] },
        'thread/start': { thread: { id: this.remoteId } },
        'thread/resume': { thread: { id: message.params.threadId } },
        'turn/start': { turn: { id: this.turnId } },
        'thread/read': { thread: { id: message.params.threadId } },
      }
      this.reply({ id: message.id, result: results[message.method] || {} })
    }
  }

  reply(message: Wire) {
    const frame = {
      type: 'stdout',
      cursor: ++this.cursor,
      data: Buffer.from(JSON.stringify(message) + '\n').toString('base64'),
    }
    this.journal.push(frame)
    this.attachment?.frame(frame)
  }

  ack(sequence: number) {
    this.held.delete(sequence)
    this.attachment!.frame({ type: 'ack', sequence: this.acknowledgedSequence() })
  }

  exit() {
    this.attachment!.frame({ type: 'exit', cursor: ++this.cursor, code: 0, signal: null })
  }
}

const connected: ConnectionState = {
  status: 'connected',
  home: '/home/fixture',
  workspace: '/project',
  codex: 'codex-cli 0.162.1',
  claude: '2.1.296 (Claude Code)',
  profile: {
    id: 'pending-delivery-fixture',
    name: 'Pending delivery fixture',
    host: 'in-memory-fixture',
    port: 22,
    username: 'fixture',
    auth: 'agent',
    privateKeyPath: '',
    workspace: '/project',
  },
}

class Host extends EventEmitter implements DurableChannelHost {
  state: ConnectionState = structuredClone(connected)
  readonly attachments: Attachment[] = []
  readonly configurations: RemoteAgentBrokerConfig[] = []
  readonly channels: DurableRemoteChannel[] = []
  readonly brokers = new Map<string, Broker>()

  agentBrokerCommand(config: RemoteAgentBrokerConfig) {
    this.configurations.push(config)
    return JSON.stringify(config)
  }

  async channel(command: string) {
    const config = JSON.parse(command) as RemoteAgentBrokerConfig
    let broker = this.brokers.get(config.id)
    if (!broker) {
      broker = new Broker()
      this.brokers.set(config.id, broker)
    }
    const attachment = new Attachment(broker)
    broker.attachment = attachment
    this.attachments.push(attachment)
    setImmediate(() => {
      attachment.frame({
        type: 'ready',
        protocol: 2,
        cursor: broker.cursor,
        lastInputSequence: broker.acknowledgedSequence(),
        writerLease: {
          epoch: this.attachments.length,
          token: `fixture-writer-${this.attachments.length}`,
        },
      })
      for (const frame of broker.journal)
        if (frame.cursor > (config.cursor ?? 0)) attachment.frame(frame)
    })
    return attachment as unknown as ClientChannel
  }

  async durableChannel(command: string, onOpening?: (channel: ClientChannel) => void) {
    return DurableRemoteChannel.open(this, command, (channel) => {
      this.channels.push(channel)
      onOpening?.(channel as unknown as ClientChannel)
    }) as unknown as Promise<ClientChannel>
  }

  async exec(): Promise<string> {
    throw new Error('Pending-delivery fixtures must not execute a shell or call inference')
  }

  disconnect() {
    this.state = { ...this.state, status: 'disconnected' }
    this.emit('state', this.state)
    this.emit('disconnected')
  }

  reconnect() {
    this.state = { ...this.state, status: 'connected' }
    this.emit('state', this.state)
  }
}

// Queue inspection checks actual retained bytes. The retirement decision below uses public Agents APIs.
const pendingFrames = (channel: DurableRemoteChannel) => [
  ...(channel as unknown as { pending: Map<number, InputFrame> }).pending.values(),
]
const turn = () => new Promise<void>((resolve) => setImmediate(resolve))
const active: { agents: Agents; host: Host }[] = []

afterEach(async () => {
  for (const { agents, host } of active.splice(0)) {
    agents.close()
    for (const channel of host.channels) channel.destroy()
    for (const attachment of host.attachments) {
      attachment.destroy()
      attachment.stderr.destroy()
    }
    await turn()
    // Agents keeps its host-level listeners; every durable attachment must retire its own.
    expect(host.listenerCount('state')).toBe(1)
    expect(host.listenerCount('disconnected')).toBe(1)
    host.removeAllListeners()
  }
})

async function fixture(provider: Provider) {
  const host = new Host()
  const events: AgentEvent[] = []
  const agents = new Agents(host as unknown as SSHConnection, (event) => events.push(event))
  active.push({ agents, host })
  await agents.start({ sessionId: localId, provider, prompt, model: 'test-model', mode: 'review' })
  const channel = host.channels[0]
  const broker = host.brokers.get(channel.sessionId)!
  await vi.waitFor(() => expect(pendingFrames(channel)).toEqual([]))
  const complete = () => {
    if (provider === 'codex') {
      broker.reply({
        method: 'turn/completed',
        params: { threadId: broker.remoteId, turn: { id: broker.turnId, status: 'completed' } },
      })
    } else {
      broker.reply({ type: 'system', subtype: 'init', session_id: broker.remoteId })
      broker.reply({
        type: 'result',
        session_id: broker.remoteId,
        subtype: 'success',
        is_error: false,
        result: '',
      })
    }
  }
  const release = () =>
    provider === 'codex' ? agents.releaseIdleProviders() : agents.releaseIdleClaudeProviders()
  return { agents, host, events, channel, broker, complete, release }
}

type Fixture = Awaited<ReturnType<typeof fixture>>

async function provePendingDelivery(context: Fixture, expected: Wire) {
  const { agents, host, channel, broker, release, events } = context
  const encoded = Buffer.from(JSON.stringify(expected) + '\n').toString('base64')
  await vi.waitFor(() =>
    expect(pendingFrames(channel).filter((frame) => frame.data === encoded)).toHaveLength(1),
  )
  const pending = pendingFrames(channel)
  const queued = pending.find((frame) => frame.data === encoded)!
  expect(queued).toEqual({ type: 'write', data: encoded, sequence: queued.sequence })
  expect(agents.hasRunningSessions()).toBe(false)
  const guard = agents.hasPendingRendererWork()
  let settled = false
  let firstResult: boolean[] | undefined
  const firstRelease = release().then((result) => {
    settled = true
    firstResult = result
    return result
  })
  // Observe the real close/drop or refusal before making any failure assertion.
  await vi.waitFor(() => expect(settled || channel.isClosing).toBe(true))
  const observed = {
    guard,
    settled,
    result: firstResult,
    closing: channel.isClosing,
    pending: pendingFrames(channel),
  }
  expect.soft(observed).toEqual({
    guard: true,
    settled: true,
    result: [false],
    closing: false,
    pending,
  })

  if (host.state.status === 'connected') host.disconnect()
  host.reconnect()
  await vi.waitFor(() => expect(host.attachments).toHaveLength(2))
  const second = host.attachments[1]
  await vi.waitFor(() => expect(channel.transportState).toBe('connected'))
  await turn()
  expect.soft(second.inputs).toEqual([
    ...pending.map((frame) => ({
      ...frame,
      writerLease: { epoch: 2, token: 'fixture-writer-2' },
    })),
  ])
  expect.soft(agents.hasPendingRendererWork()).toBe(true)

  // Another lost ACK must retry the original sequence, never a second native response.
  host.disconnect()
  host.reconnect()
  await vi.waitFor(() => expect(host.attachments).toHaveLength(3))
  const third = host.attachments[2]
  await vi.waitFor(() => expect(channel.transportState).toBe('connected'))
  await turn()
  expect.soft(third.inputs).toEqual([
    ...pending.map((frame) => ({
      ...frame,
      writerLease: { epoch: 3, token: 'fixture-writer-3' },
    })),
  ])
  expect(host.configurations.map((config) => ({ id: config.id, launch: config.launch }))).toEqual([
    { id: channel.sessionId, launch: true },
    { id: channel.sessionId, launch: false },
    { id: channel.sessionId, launch: false },
  ])
  expect
    .soft(
      broker.messages.filter(
        (message) => message.id === wireId || message.response?.request_id === wireId,
      ),
    )
    .toEqual([expected])
  // A broker ACK confirms delivery ownership, not whether the provider applied its result.
  broker.ack(queued.sequence)
  await turn()
  expect.soft(agents.hasPendingRendererWork()).toBe(false)

  let terminalSettled = false
  const terminalRelease = (channel.isClosing ? firstRelease : release()).then((result) => {
    terminalSettled = true
    return result
  })
  await vi.waitFor(() =>
    expect(
      host.attachments.some((attachment) =>
        attachment.inputs.some((frame) => frame.type === 'close'),
      ),
    ).toBe(true),
  )
  const closing = host.attachments
    .flatMap((attachment) => attachment.inputs)
    .find((frame) => frame.type === 'close')!
  broker.ack(closing.sequence)
  await turn()
  expect(terminalSettled).toBe(false)
  broker.exit()
  await expect(terminalRelease).resolves.toEqual([true])
  expect(channel.transportState).toBe('closed')
  expect(broker.messages.filter((message) => message.method === 'turn/interrupt')).toEqual([])
  expect(broker.messages.filter((message) => message.request?.subtype === 'interrupt')).toEqual([])
  const users = broker.messages.filter(
    (message) => message.method === 'turn/start' || message.type === 'user',
  )
  expect(users).toHaveLength(1)
  expect(
    users[0].method === 'turn/start' ? users[0].params.input : users[0].message.content,
  ).toEqual([{ type: 'text', text: prompt }])
  expect(events.filter((event) => event.type === 'session').map((event) => event.remoteId)).toEqual(
    [broker.remoteId],
  )
  expect(events.filter((event) => event.type === 'request-resolved')).toHaveLength(1)
}

describe('native response delivery owns renderer retirement until the broker ACK', () => {
  it('retains an exact Codex root decision after its native turn becomes idle', async () => {
    const context = await fixture('codex')
    const { agents, broker, events, complete } = context
    broker.reply({
      id: wireId,
      method: 'item/commandExecution/requestApproval',
      params: {
        threadId: broker.remoteId,
        turnId: broker.turnId,
        itemId: 'native-command',
        command: 'printf exact',
        availableDecisions: [decision, 'decline'],
      },
    })
    await vi.waitFor(() => expect(events.some((event) => event.type === 'approval')).toBe(true))
    const request = events.findLast((event) => event.type === 'approval')!
    broker.holdNativeResponse = true
    await agents.respond(localId, request.requestId!, true, undefined, 'codex-approval:0')
    complete()
    await vi.waitFor(() => expect(agents.hasRunningSessions()).toBe(false))
    await provePendingDelivery(context, { id: wireId, result: { decision } })
  })

  it('preserves an offline Codex child decision after both native root and child become idle', async () => {
    const context = await fixture('codex')
    const { agents, host, broker, events, complete, channel } = context
    complete()
    await vi.waitFor(() => expect(agents.hasRunningSessions()).toBe(false))
    broker.reply({
      method: 'thread/started',
      params: {
        thread: { id: childId, parentThreadId: broker.remoteId, status: { type: 'active' } },
      },
    })
    broker.reply({
      id: wireId,
      method: 'item/commandExecution/requestApproval',
      params: {
        threadId: childId,
        itemId: 'native-child-command',
        command: 'printf child',
        availableDecisions: ['accept', 'decline'],
      },
    })
    broker.reply({
      method: 'thread/status/changed',
      params: { threadId: childId, status: { type: 'idle' } },
    })
    await vi.waitFor(() => expect(events.some((event) => event.type === 'approval')).toBe(true))
    await vi.waitFor(() => expect(pendingFrames(channel)).toEqual([]))
    expect(agents.hasRunningSessions()).toBe(false)
    expect(agents.hasPendingRendererWork()).toBe(true)
    const request = events.findLast((event) => event.type === 'approval')!
    broker.holdNativeResponse = true
    host.disconnect()
    await agents.respond(localId, request.requestId!, false, undefined, 'codex-approval:1')
    await provePendingDelivery(context, { id: wireId, result: { decision: 'decline' } })
  })

  it('keeps exact Unicode Codex user-input answers after completion with an unacknowledged response', async () => {
    const context = await fixture('codex')
    const { agents, broker, events, complete } = context
    broker.reply({
      id: wireId,
      method: 'item/tool/requestUserInput',
      params: {
        threadId: broker.remoteId,
        turnId: broker.turnId,
        itemId: 'native-question',
        questions: [{ id: 'exact-answer', header: 'Input', question: 'What should remain exact?' }],
      },
    })
    await vi.waitFor(() => expect(events.some((event) => event.type === 'question')).toBe(true))
    const request = events.findLast((event) => event.type === 'question')!
    broker.holdNativeResponse = true
    await agents.respond(localId, request.requestId!, true, {
      'exact-answer': [answer, 'Second  answer'],
    })
    complete()
    await vi.waitFor(() => expect(agents.hasRunningSessions()).toBe(false))
    await provePendingDelivery(context, {
      id: wireId,
      result: { answers: { 'exact-answer': { answers: [answer, 'Second  answer'] } } },
    })
  })

  it('retains a Claude native child permission after root and child finish before its delivery ACK', async () => {
    const context = await fixture('claude')
    const { agents, host, broker, events, complete, channel } = context
    complete()
    await vi.waitFor(() => expect(agents.hasRunningSessions()).toBe(false))
    const input = { file_path: '/project/🧪 notes.txt', exact: answer, future: { preserve: true } }
    broker.reply({
      type: 'control_request',
      request_id: wireId,
      request: { subtype: 'can_use_tool', agent_id: childId, tool_name: 'Read', input },
    })
    await vi.waitFor(() => expect(events.some((event) => event.type === 'approval')).toBe(true))
    expect(agents.hasRunningSessions()).toBe(true)
    broker.holdNativeResponse = true
    await agents.respond(localId, wireId, true)
    broker.reply({
      type: 'result',
      session_id: 'native-claude-child',
      parent_tool_use_id: childId,
      subtype: 'success',
      is_error: false,
      result: '',
    })
    await vi.waitFor(() => expect(agents.hasRunningSessions()).toBe(false))
    await vi.waitFor(() => expect(pendingFrames(channel)).toHaveLength(1))
    const connectedGuard = agents.hasPendingRendererWork()
    host.disconnect()
    await provePendingDelivery(context, {
      type: 'control_response',
      response: {
        subtype: 'success',
        request_id: wireId,
        response: { behavior: 'allow', updatedInput: input },
      },
    })
    expect(connectedGuard).toBe(true)
  })
})
