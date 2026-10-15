import { EventEmitter } from 'node:events'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { Duplex, PassThrough } from 'node:stream'
import { runInNewContext } from 'node:vm'
import { Cause, Effect, Exit } from 'effect'
import type { ClientChannel } from 'ssh2'
import ts from 'typescript'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { Agents } from '../src/main/agents'
import { ConversationHistoryLifecycle } from '../src/main/conversation-history-lifecycle'
import { NativeDocumentReadiness } from '../src/main/native-document-readiness'
import { DurableRemoteChannel } from '../src/main/durable-remote-channel'
import { RendererDocumentAdmission } from '../src/main/renderer-recovery'
import type { RemoteAgentBrokerConfig } from '../src/main/remote-agent-broker'
import { SSHConnection } from '../src/main/ssh'
import type {
  AgentEvent,
  ConnectInput,
  ConnectionProfile,
  ConnectionState,
} from '../src/shared/types'
import { connectSchema } from '../src/shared/validation'

vi.mock('../src/main/provider-titles', () => ({
  generateProviderTitle: vi.fn(async () => undefined),
}))

type Wire = Record<string, any>
type Handler = (...args: any[]) => unknown
const productionPath = resolve(import.meta.dirname, '../src/main/index.ts')
const productionSource = readFileSync(productionPath, 'utf8')
const sourceFile = ts.createSourceFile(
  productionPath,
  productionSource,
  ts.ScriptTarget.ES2022,
  true,
)
const registrations: string[] = []
const visit = (node: ts.Node) => {
  if (
    ts.isExpressionStatement(node) &&
    ts.isCallExpression(node.expression) &&
    ts.isIdentifier(node.expression.expression) &&
    node.expression.expression.text === 'handle' &&
    ts.isStringLiteral(node.expression.arguments[0]) &&
    ['connection:connect', 'connection:disconnect'].includes(node.expression.arguments[0].text)
  )
    registrations.push(node.getText(sourceFile))
  ts.forEachChild(node, visit)
}
visit(sourceFile)
if (registrations.length !== 2) throw new Error('Expected both actual connection IPC registrations')
const executable = ts.transpileModule(registrations.join('\n'), {
  compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.None },
}).outputText

const localProfile: ConnectionProfile = {
  id: 'local:12345678-1234-1234-1234-123456789abc',
  transport: 'local',
  name: 'Local',
  host: 'localhost',
  port: 22,
  username: 'fixture',
  auth: 'agent',
  privateKeyPath: '',
  workspace: '/fixture/project',
}
const sshProfile: ConnectionProfile = {
  ...localProfile,
  id: 'ssh-fixture',
  transport: 'ssh',
  name: 'SSH fixture',
  host: 'fixture.invalid',
}

class Attachment extends Duplex {
  readonly stderr = new PassThrough()
  readySent = false
  readonly replayCursor: number
  readonly writerLease: { epoch: number; token: string }
  constructor(
    readonly broker: Broker,
    cursor = 0,
  ) {
    super({ autoDestroy: false })
    this.replayCursor = cursor
    const epoch = broker.attachments.length + 1
    this.writerLease = { epoch, token: `fixture-${broker.machine}-${epoch}` }
  }
  override _read() {}
  override _write(chunk: Buffer, _encoding: BufferEncoding, callback: () => void) {
    for (const line of chunk.toString().trim().split('\n'))
      this.broker.input(JSON.parse(line), this)
    callback()
  }
  frame(frame: Wire) {
    if (!this.destroyed) this.push(JSON.stringify(frame) + '\n')
  }
  close() {
    this.destroy()
  }
  signal() {}
}

class Broker {
  readonly attachments: Attachment[] = []
  readonly frames: Wire[] = []
  readonly messages: Wire[] = []
  readonly heldMethods = new Set<string>()
  readonly admittedInputs = new Map<number, string>()
  writer?: Attachment
  cursor = 0
  lastInputSequence = 0
  live = true
  readyHeld = false
  holdAcknowledgements = false
  autoExit = false
  readonly remoteId = 'native-session-stays-owned'
  readonly turnId = 'native-turn-stays-owned'

  constructor(readonly machine: string) {}

  attach(cursor = 0) {
    const attachment = new Attachment(this, cursor)
    this.attachments.push(attachment)
    setImmediate(() => {
      if (!this.readyHeld) this.ready(attachment)
    })
    return attachment
  }
  ready(attachment = this.attachments.at(-1)!) {
    this.readyHeld = false
    if (attachment.readySent || attachment.destroyed) return
    attachment.readySent = true
    if (!this.writer || this.writer.destroyed) this.writer = attachment
    attachment.frame({
      type: 'ready',
      protocol: 2,
      inputReceipts: 1,
      cursor: this.cursor,
      lastInputSequence: this.lastInputSequence,
      ...(this.writer === attachment
        ? { writerLease: attachment.writerLease }
        : { writerUnavailable: true }),
    })
    for (const frame of this.frames)
      if (typeof frame.cursor === 'number' && frame.cursor > attachment.replayCursor)
        attachment.frame(frame)
    attachment.frame({ type: 'replayComplete', replayCursor: this.cursor })
  }
  publish(message: Wire) {
    this.publishFrame({
      type: 'stdout',
      data: Buffer.from(JSON.stringify(message) + '\n').toString('base64'),
    })
  }
  publishFrame(frame: Wire) {
    const value = { ...frame, cursor: ++this.cursor }
    this.frames.push(value)
    for (const attachment of this.attachments) attachment.frame(value)
  }
  input(frame: Wire, attachment: Attachment) {
    if (
      this.writer !== attachment ||
      frame.writerLease?.epoch !== attachment.writerLease.epoch ||
      frame.writerLease?.token !== attachment.writerLease.token
    ) {
      attachment.frame({ type: 'error', message: 'The fixture attachment has no writer lease.' })
      return
    }
    const { writerLease: _lease, ...original } = frame
    const wire = JSON.stringify(original)
    const admitted = this.admittedInputs.get(frame.sequence)
    if (admitted !== undefined) {
      if (admitted !== wire)
        attachment.frame({ type: 'error', message: 'The fixture input identity changed.' })
      else if (!this.holdAcknowledgements)
        attachment.frame({ type: 'ack', sequence: frame.sequence })
      return
    }
    this.admittedInputs.set(frame.sequence, wire)
    this.frames.push({ input: frame })
    this.lastInputSequence = Math.max(this.lastInputSequence, frame.sequence)
    if (!this.holdAcknowledgements) attachment.frame({ type: 'ack', sequence: frame.sequence })
    this.publishFrame({ type: 'inputReceipt', sequence: frame.sequence, status: 'written' })
    if (frame.type === 'close') {
      if (this.autoExit) this.exit()
      return
    }
    if (frame.type !== 'write') return
    const message = JSON.parse(Buffer.from(frame.data, 'base64').toString()) as Wire
    this.messages.push(message)
    if (message.type === 'control_request') {
      queueMicrotask(() =>
        this.publish({
          type: 'control_response',
          response: { subtype: 'success', request_id: message.request_id, response: {} },
        }),
      )
      return
    }
    if (message.type === 'user') {
      queueMicrotask(() =>
        this.publish({
          type: 'result',
          subtype: 'success',
          session_id: this.remoteId,
          is_error: false,
          result: 'Fixture completed',
        }),
      )
      return
    }
    if (typeof message.id !== 'number' || !message.method || this.heldMethods.has(message.method))
      return
    this.answer(message)
  }
  answer(message: Wire) {
    const results: Record<string, Wire> = {
      initialize: {},
      'config/read': { config: { model: 'fixture-model' } },
      'model/list': { data: [{ model: 'fixture-model', displayName: 'Fixture', isDefault: true }] },
      'thread/start': { thread: { id: this.remoteId } },
      'thread/resume': { thread: { id: message.params.threadId } },
      'thread/read': { thread: { id: this.remoteId } },
      'turn/start': { turn: { id: this.turnId } },
    }
    queueMicrotask(() => this.publish({ id: message.id, result: results[message.method] || {} }))
  }
  exit(confirmed = true) {
    if (!this.live) return
    this.live = false
    this.publishFrame({ type: 'exit', code: 0, nativeExitConfirmed: confirmed })
  }
  complete() {
    this.publish({
      method: 'turn/completed',
      params: { threadId: this.remoteId, turn: { id: this.turnId, status: 'completed' } },
    })
  }
  get closes() {
    return this.frames.filter((frame) => frame.input?.type === 'close')
  }
  get prompts() {
    return this.messages
      .filter((message) => message.method === 'turn/start' || message.type === 'user')
      .map((message) =>
        message.type === 'user' ? message.message.content[0].text : message.params.input[0].text,
      )
  }
}

class Connection extends EventEmitter {
  state: ConnectionState = {
    status: 'connected',
    profile: localProfile,
    home: '/fixture/home',
    workspace: localProfile.workspace,
    codex: 'codex-cli 0.162.1',
    claude: '2.1.0',
    providerVersionsStatus: 'ready',
  }
  readonly brokers = new Map<string, Broker>()
  readonly channels: DurableRemoteChannel[] = []
  readonly selections: string[] = []
  disconnects = 0
  holdNextReady = false
  client: object | undefined = {}
  connectionGeneration = 0
  rendererGeneration = 0
  readonly store = { localProfile: () => localProfile }

  validateConnectInput(input: ConnectInput) {
    return SSHConnection.prototype.validateConnectInput.call(
      this as unknown as SSHConnection,
      input,
    )
  }
  captureEnvironmentOwnership() {
    return SSHConnection.prototype.captureEnvironmentOwnership.call(
      this as unknown as SSHConnection,
    )
  }

  async channel(command: string) {
    const config = JSON.parse(command) as RemoteAgentBrokerConfig
    let broker = this.brokers.get(config.id)
    if (!broker) {
      if (config.launch === false) throw new Error('An owned broker cannot be relaunched')
      broker = new Broker(this.state.profile!.id)
      broker.readyHeld = this.holdNextReady
      this.holdNextReady = false
      this.brokers.set(config.id, broker)
    }
    return broker.attach(config.cursor) as unknown as ClientChannel
  }
  agentBrokerCommand(config: RemoteAgentBrokerConfig) {
    return JSON.stringify(config)
  }
  durableChannel(command: string, onOpening?: (channel: ClientChannel) => void) {
    return DurableRemoteChannel.open(this, command, (channel) => {
      this.channels.push(channel)
      onOpening?.(channel as unknown as ClientChannel)
    }) as unknown as Promise<ClientChannel>
  }
  disconnect() {
    this.disconnects++
    this.connectionGeneration++
    this.client = undefined
    this.state = { status: 'disconnected' }
    this.emit('state', this.state)
    this.emit('disconnected')
  }
  async connect(input: ConnectInput) {
    this.disconnect()
    this.client = {}
    this.state = {
      status: 'connected',
      profile: { ...input, workspace: input.workspace || '~' },
      home: '/ssh/home',
      workspace: input.workspace,
      codex: 'codex-cli 0.162.1',
      claude: '2.1.0',
    }
    this.emit('state', this.state)
    return this.state
  }
  async exec() {
    throw new Error('This protocol fixture never executes a shell or inference')
  }
  async whenProviderVersionsReady() {
    return this.state
  }
}

type Fixture = {
  connection: Connection
  agents: Agents
  handlers: Map<string, Handler>
  events: AgentEvent[]
  selected: string[]
  operations: Promise<unknown>[]
  invoke: (name: string, ...args: unknown[]) => Promise<unknown>
  context: {
    window: { isDestroyed: () => boolean }
    nativeDocuments: NativeDocumentReadiness
  }
  admission: RendererDocumentAdmission
}
const fixtures: Fixture[] = []
afterEach(async () => {
  for (const fixture of fixtures.splice(0)) {
    for (const broker of fixture.connection.brokers.values()) {
      broker.autoExit = true
      broker.ready()
      broker.exit()
    }
    fixture.agents.close()
    await Promise.all(
      fixture.connection.channels.map((channel) =>
        Effect.runPromise(channel.closeAndWaitEffect(25)),
      ),
    )
    await Promise.allSettled(fixture.operations)
    for (const broker of fixture.connection.brokers.values())
      for (const attachment of broker.attachments) attachment.destroy()
  }
})

function setup(): Fixture {
  const connection = new Connection()
  const events: AgentEvent[] = []
  const agents = new Agents(connection as unknown as SSHConnection, (event) => events.push(event))
  const handlers = new Map<string, Handler>()
  const selected: string[] = []
  const store = {
    localProfile: () => localProfile,
    selectionEffect: (id: string) => Effect.sync(() => selected.push(id)),
  }
  const window = { isDestroyed: () => false }
  const nativeDocuments = new NativeDocumentReadiness()
  nativeDocuments.commit(window)
  const admission = new RendererDocumentAdmission()
  admission.commitMainDocument()
  const rendererAdmissions = new WeakMap([[window, admission]])
  const context = {
    agents,
    ssh: connection,
    store,
    Effect,
    connectSchema,
    handle: (name: string, handler: Handler) => handlers.set(name, handler),
    window,
    nativeDocuments,
    rendererAdmissions,
    historyLifecycle: new ConversationHistoryLifecycle(),
  }
  runInNewContext(executable, context)
  const operations: Promise<unknown>[] = []
  const invoke = (name: string, ...args: unknown[]) => {
    let result: unknown
    try {
      result = handlers.get(name)!(...args)
    } catch (error) {
      result = Promise.reject(error)
    }
    const operation = Effect.isEffect(result)
      ? Effect.runPromise(result as Effect.Effect<unknown, unknown>)
      : Promise.resolve(result)
    void operation.catch(() => {})
    operations.push(operation)
    return operation
  }
  const fixture = {
    connection,
    agents,
    handlers,
    events,
    selected,
    operations,
    invoke,
    context,
    admission,
  }
  fixtures.push(fixture)
  return fixture
}

const until = (predicate: () => boolean) =>
  vi.waitFor(() => expect(predicate()).toBe(true), { timeout: 1000, interval: 10 })
const tick = () => new Promise<void>((resolve) => setImmediate(resolve))

describe('Local provider ownership before an explicit environment change', () => {
  it.each(['connection:disconnect', 'connection:connect'])(
    '%s retires a held-ready catalog opening before losing its Local host',
    async (method) => {
      const fixture = setup()
      fixture.connection.holdNextReady = true
      const catalog = fixture.agents.models('codex').catch((error: unknown) => ({ error }))
      fixture.operations.push(catalog)
      await until(() => fixture.connection.brokers.size === 1)
      const broker = [...fixture.connection.brokers.values()][0]
      expect(broker.messages).toEqual([])
      expect(broker.lastInputSequence).toBe(0)
      const operation = fixture.invoke(
        method,
        ...(method === 'connection:connect' ? [sshProfile] : []),
      )
      await until(() => fixture.connection.channels[0].isClosing)
      expect(fixture.connection.state.profile?.id).toBe(localProfile.id)
      expect(fixture.connection.disconnects).toBe(0)
      broker.ready()
      await until(() => broker.closes.length === 1)
      await tick()
      expect(broker.live).toBe(true)
      expect(fixture.connection.disconnects).toBe(0)
      expect(broker.messages).toEqual([])
      expect(broker.prompts).toEqual([])
      broker.exit()
      await operation
      expect(broker.live).toBe(false)
      expect(fixture.connection.disconnects).toBe(1)
      expect(fixture.selected).toEqual(method === 'connection:connect' ? [sshProfile.id] : [])
      expect(await catalog).toHaveProperty('error')
      expect(fixture.agents.hasProviderRetirementTargets()).toBe(false)
    },
  )

  it.each(['connection:disconnect', 'connection:connect'])(
    '%s waits for an initialized idle provider terminal exit, not its close ACK',
    async (method) => {
      const fixture = setup()
      await fixture.agents.models('codex')
      const broker = [...fixture.connection.brokers.values()][0]
      const operation = fixture.invoke(
        method,
        ...(method === 'connection:connect' ? [sshProfile] : []),
      )
      await until(() => broker.closes.length === 1)
      await tick()
      expect(fixture.connection.disconnects).toBe(0)
      expect(fixture.connection.state.profile?.id).toBe(localProfile.id)
      expect(broker.live).toBe(true)
      expect(broker.prompts).toEqual([])
      broker.exit()
      await operation
      expect(fixture.connection.disconnects).toBe(1)
      expect(fixture.agents.hasProviderRetirementTargets()).toBe(false)
    },
  )

  it('refuses a switch with an explicitly unconfirmed idle native exit and retains Local selection', async () => {
    const fixture = setup()
    await fixture.agents.models('codex')
    const broker = [...fixture.connection.brokers.values()][0]
    const operation = fixture.invoke('connection:connect', sshProfile)
    await until(() => broker.closes.length === 1)
    broker.exit(false)
    await expect(operation).rejects.toThrow(/exit|provider|confirm/i)
    expect(fixture.connection.disconnects).toBe(0)
    expect(fixture.connection.state.profile?.id).toBe(localProfile.id)
    expect(fixture.selected).toEqual([])
    expect(fixture.agents.hasProviderRetirementTargets()).toBe(true)
  })

  it('retains an earlier unknown exit veto even when a new native startup owns the discovery gap', async () => {
    const fixture = setup()
    await fixture.agents.models('codex')
    const broker = [...fixture.connection.brokers.values()][0]
    const first = fixture.invoke('connection:connect', sshProfile)
    await until(() => broker.closes.length === 1)
    broker.exit(false)
    await expect(first).rejects.toThrow(/exit|provider|confirm/i)
    expect(fixture.agents.hasProviderRetirementTargets()).toBe(true)
    fixture.connection.state = { ...fixture.connection.state, providerVersionsStatus: 'checking' }
    let cancelDiscovery!: () => void
    const ready = new Promise<ConnectionState>((_resolve, reject) => {
      cancelDiscovery = () => reject(new Error('End only this fixture-owned pending discovery'))
    })
    vi.spyOn(fixture.connection, 'whenProviderVersionsReady').mockReturnValue(ready)
    const starting = fixture.agents
      .start({
        sessionId: 'pending-after-unknown',
        provider: 'codex',
        prompt: 'Do not bypass the earlier unknown Local owner',
        mode: 'review',
      })
      .catch((error: unknown) => ({ error }))
    fixture.operations.push(starting)
    try {
      await until(() => fixture.agents.hasPendingRendererWork())
      expect(fixture.agents.hasRunningSessions()).toBe(false)
      await expect(fixture.invoke('connection:connect', sshProfile)).rejects.toThrow(
        /exit|provider|confirm/i,
      )
      expect(fixture.connection.disconnects).toBe(0)
      expect(fixture.connection.state.profile?.id).toBe(localProfile.id)
      expect(fixture.selected).toEqual([])
      expect(broker.prompts).toEqual([])
      expect(fixture.agents.hasProviderRetirementTargets()).toBe(true)
    } finally {
      cancelDiscovery()
    }
    expect(await starting).toHaveProperty('error')
  })

  it('keeps an active native turn detached with its exact prompt and identity when choosing SSH', async () => {
    const fixture = setup()
    const prompt = '/life  exact local prompt\n\tcafé 🧪 $literal  \n'
    await fixture.agents.start({
      sessionId: 'owned-root',
      provider: 'codex',
      prompt,
      mode: 'review',
    })
    const broker = [...fixture.connection.brokers.values()][0]
    await fixture.invoke('connection:connect', sshProfile)
    expect(broker.closes).toEqual([])
    expect(broker.prompts).toEqual([prompt])
    expect(broker.live).toBe(true)
    expect(fixture.agents.hasRunningSessions()).toBe(true)
    expect(fixture.connection.channels[0].transportState).toBe('suspended')
    expect(
      fixture.events
        .filter((event) => event.remoteId)
        .every((event) => event.remoteId === broker.remoteId),
    ).toBe(true)
  })

  it('keeps a real root startup while provider readiness is still pending', async () => {
    const fixture = setup()
    fixture.connection.holdNextReady = true
    const starting = fixture.agents
      .start({
        sessionId: 'owned-root',
        provider: 'codex',
        prompt: 'Never replay pending startup',
        mode: 'review',
      })
      .catch((error: unknown) => ({ error }))
    fixture.operations.push(starting)
    await until(() => fixture.connection.brokers.size === 1)
    const broker = [...fixture.connection.brokers.values()][0]
    await fixture.invoke('connection:disconnect')
    expect(broker.closes).toEqual([])
    expect(broker.messages).toEqual([])
    expect(broker.live).toBe(true)
    expect(fixture.agents.hasPendingRendererWork()).toBe(true)
  })

  it('preserves the idle RPC owned by a start admitted before provider discovery publishes a session', async () => {
    const fixture = setup()
    await fixture.agents.models('codex')
    const broker = [...fixture.connection.brokers.values()][0]
    fixture.connection.state = { ...fixture.connection.state, providerVersionsStatus: 'checking' }
    let releaseDiscovery!: () => void
    const ready = new Promise<ConnectionState>((resolve) => {
      releaseDiscovery = () => resolve(fixture.connection.state)
    })
    vi.spyOn(fixture.connection, 'whenProviderVersionsReady').mockReturnValue(ready)
    const starting = fixture.agents
      .start({
        sessionId: 'not-yet-published',
        provider: 'codex',
        prompt: 'Never send this old Local request to SSH café 🧪',
        mode: 'review',
      })
      .then(
        () => ({ error: undefined }),
        (error: unknown) => ({ error }),
      )
    fixture.operations.push(starting)
    try {
      await until(() => fixture.agents.hasPendingRendererWork())
      expect(fixture.agents.hasRunningSessions()).toBe(false)
      expect(fixture.events).toEqual([])
      await fixture.invoke('connection:connect', sshProfile)
      expect(broker.closes).toEqual([])
      expect(broker.live).toBe(true)
      expect(broker.prompts).toEqual([])
      expect(fixture.connection.state.profile?.id).toBe(sshProfile.id)
      expect(fixture.connection.brokers.size).toBe(1)
    } finally {
      releaseDiscovery()
    }
    expect((await starting).error).toBeInstanceOf(Error)
    expect(broker.prompts).toEqual([])
    expect(fixture.events).toEqual([])
    expect(fixture.connection.brokers.size).toBe(1)
    expect(fixture.selected).toEqual([sshProfile.id])
  })

  it('keeps an idle RPC with unacknowledged delivery owned instead of dropping or replaying input', async () => {
    const fixture = setup()
    await fixture.agents.models('codex')
    const broker = [...fixture.connection.brokers.values()][0]
    broker.holdAcknowledgements = true
    fixture.connection.channels[0].write(
      JSON.stringify({ method: 'read-only-fixture-notification', params: { exact: 'café 🧪' } }) +
        '\n',
    )
    await until(() => fixture.connection.channels[0].hasPendingDelivery)
    const before = broker.messages.slice()
    await fixture.invoke('connection:disconnect')
    expect(broker.closes).toEqual([])
    expect(broker.messages).toEqual(before)
    expect(fixture.connection.channels[0].hasPendingDelivery).toBe(true)
    expect(broker.live).toBe(true)
  })

  it('keeps an idle native child permission and sends no fabricated response while choosing SSH', async () => {
    const fixture = setup()
    await fixture.agents.start({
      sessionId: 'owned-root',
      provider: 'codex',
      prompt: 'Exact first prompt',
      mode: 'review',
    })
    const broker = [...fixture.connection.brokers.values()][0]
    broker.publish({
      method: 'thread/started',
      params: {
        thread: {
          id: 'permission-child',
          parentThreadId: broker.remoteId,
          status: { type: 'active' },
        },
      },
    })
    broker.publish({
      id: 'native-permission-42',
      method: 'item/commandExecution/requestApproval',
      params: {
        threadId: 'permission-child',
        itemId: 'command-42',
        command: 'printf exact',
        availableDecisions: ['accept', 'decline'],
      },
    })
    await until(() => fixture.events.some((event) => event.type === 'approval'))
    broker.publish({
      method: 'thread/status/changed',
      params: { threadId: 'permission-child', status: { type: 'idle' } },
    })
    broker.complete()
    await until(() => !fixture.agents.hasRunningSessions())
    expect(fixture.agents.hasPendingRendererWork()).toBe(true)
    await fixture.invoke('connection:connect', sshProfile)
    expect(broker.closes).toEqual([])
    expect(broker.live).toBe(true)
    expect(broker.messages.filter((message) => message.id === 'native-permission-42')).toEqual([])
    expect(fixture.agents.hasPendingRendererWork()).toBe(true)
    expect(fixture.events.filter((event) => event.type === 'request-resolved')).toEqual([])
  })

  it('keeps a completed turn while its native settings update awaits acknowledgement', async () => {
    const fixture = setup()
    await fixture.agents.start({
      sessionId: 'owned-root',
      provider: 'codex',
      prompt: 'Configure only after this request',
      mode: 'review',
    })
    const broker = [...fixture.connection.brokers.values()][0]
    broker.complete()
    await until(() => !fixture.agents.hasRunningSessions())
    broker.heldMethods.add('thread/settings/update')
    const configuration = fixture.agents
      .configure({ sessionId: 'owned-root', model: 'next-fixture-model' })
      .catch((error: unknown) => ({ error }))
    fixture.operations.push(configuration)
    await until(() =>
      broker.messages.some((message) => message.method === 'thread/settings/update'),
    )
    await fixture.invoke('connection:disconnect')
    expect(broker.closes).toEqual([])
    expect(broker.live).toBe(true)
    expect(broker.prompts).toEqual(['Configure only after this request'])
    expect(fixture.agents.hasPendingRendererWork()).toBe(true)
  })

  it('refuses fresh models and provider startup during held Local retirement, then admits them after commit', async () => {
    const fixture = setup()
    await fixture.agents.models('codex')
    const broker = [...fixture.connection.brokers.values()][0]
    const switching = fixture.invoke('connection:connect', sshProfile)
    await until(() => broker.closes.length === 1)
    await expect(fixture.agents.models('codex')).rejects.toThrow(/environment|switch|change/i)
    await expect(
      fixture.agents.start({
        sessionId: 'late-root',
        provider: 'codex',
        prompt: 'This cannot be admitted to the retiring Local host',
        mode: 'review',
      }),
    ).rejects.toThrow(/environment|switch|change/i)
    expect(fixture.connection.brokers.size).toBe(1)
    expect(broker.prompts).toEqual([])
    expect(
      broker.messages.some((message) => ['thread/start', 'turn/start'].includes(message.method)),
    ).toBe(false)
    broker.exit()
    await switching
    await fixture.agents.models('codex')
    expect(fixture.connection.brokers.size).toBe(2)
    expect([...fixture.connection.brokers.values()][1].machine).toBe(sshProfile.id)
  })

  it.each([
    'document',
    'native-document',
    'window',
    'client-generation',
    'renderer-generation',
    'machine',
  ])(
    'rejects a stale %s owner after idle exit without committing the obsolete environment choice',
    async (owner) => {
      const fixture = setup()
      await fixture.agents.models('codex')
      const broker = [...fixture.connection.brokers.values()][0]
      const switching = fixture.invoke('connection:connect', sshProfile)
      await until(() => broker.closes.length === 1)
      if (owner === 'document') fixture.admission.commitMainDocument()
      else if (owner === 'native-document')
        fixture.context.nativeDocuments.commit(fixture.context.window)
      else if (owner === 'window') fixture.context.window = { isDestroyed: () => false }
      else if (owner === 'client-generation') fixture.connection.connectionGeneration++
      else if (owner === 'renderer-generation') fixture.connection.rendererGeneration++
      else fixture.connection.state = { ...fixture.connection.state, profile: sshProfile }
      broker.exit()
      await expect(switching).rejects.toThrow(/environment|interface|request|changed/i)
      expect(fixture.connection.disconnects).toBe(0)
      expect(fixture.selected).toEqual([])
      expect(broker.prompts).toEqual([])
    },
  )

  it('rejects a forged Local target before touching its valid native idle provider', async () => {
    const fixture = setup()
    await fixture.agents.models('codex')
    const broker = [...fixture.connection.brokers.values()][0]
    await expect(
      fixture.invoke('connection:connect', { ...localProfile, host: 'another.invalid' }),
    ).rejects.toThrow(/Local|built-in/i)
    expect(broker.closes).toEqual([])
    expect(broker.live).toBe(true)
    expect(fixture.connection.disconnects).toBe(0)
    expect(fixture.connection.state.profile?.id).toBe(localProfile.id)
    expect(fixture.selected).toEqual([])
  })

  it.each(['connection:disconnect', 'connection:connect'])(
    '%s waits for a completed Local Claude daemon before releasing the host',
    async (method) => {
      const fixture = setup()
      const prompt = '  Exact Claude prompt café 漢字 🧪\n'
      await fixture.agents.start({
        sessionId: 'owned-claude',
        provider: 'claude',
        prompt,
        remoteId: 'native-session-stays-owned',
        mode: 'review',
      })
      await until(() => fixture.events.some((event) => event.type === 'complete'))
      const broker = [...fixture.connection.brokers.values()][0]
      const operation = fixture.invoke(
        method,
        ...(method === 'connection:connect' ? [sshProfile] : []),
      )
      await until(() => broker.closes.length === 1)
      await tick()
      expect(fixture.connection.disconnects).toBe(0)
      expect(fixture.connection.state.profile?.id).toBe(localProfile.id)
      expect(broker.prompts).toEqual([prompt])
      expect(broker.live).toBe(true)
      broker.exit()
      await operation
      expect(fixture.connection.disconnects).toBe(1)
      expect(
        fixture.events.some(
          (event) =>
            event.type === 'error' || (event.type === 'complete' && event.status === 'interrupted'),
        ),
      ).toBe(false)
      expect(fixture.agents.hasProviderRetirementTargets()).toBe(false)
    },
  )

  it('keeps unrelated SSH and detached Local providers untouched when the selected host is SSH', async () => {
    const fixture = setup()
    await fixture.agents.models('codex')
    const localBroker = [...fixture.connection.brokers.values()][0]
    await fixture.connection.connect(sshProfile)
    await fixture.agents.models('codex')
    const sshBroker = [...fixture.connection.brokers.values()][1]
    await fixture.invoke('connection:disconnect')
    expect(localBroker.closes).toEqual([])
    expect(sshBroker.closes).toEqual([])
    expect(localBroker.live).toBe(true)
    expect(sshBroker.live).toBe(true)
    expect(fixture.connection.disconnects).toBe(2)
    expect(fixture.selected).toEqual([])
  })

  it('rejects a competing environment intent while Local exit is still owned by the first change', async () => {
    const fixture = setup()
    await fixture.agents.models('codex')
    const broker = [...fixture.connection.brokers.values()][0]
    const first = fixture.invoke('connection:connect', sshProfile)
    await until(() => broker.closes.length === 1)
    await expect(fixture.invoke('connection:disconnect')).rejects.toThrow(
      /environment|change|progress/i,
    )
    expect(fixture.connection.disconnects).toBe(0)
    expect(broker.closes).toHaveLength(1)
    broker.exit()
    await first
    expect(fixture.connection.disconnects).toBe(1)
    expect(fixture.selected).toEqual([sshProfile.id])
  })

  it('releases the temporary admission fence after scoped cancellation without committing the switch', async () => {
    const fixture = setup()
    await fixture.agents.models('codex')
    const broker = [...fixture.connection.brokers.values()][0]
    const controller = new AbortController()
    const effect = fixture.handlers.get('connection:connect')!(sshProfile)
    expect(Effect.isEffect(effect)).toBe(true)
    let cancellationSettled = false
    const cancelled = Effect.runPromiseExit(effect as Effect.Effect<unknown, unknown>, {
      signal: controller.signal,
    }).then((exit) => {
      cancellationSettled = true
      return exit
    })
    fixture.operations.push(cancelled)
    await until(() => broker.closes.length === 1)
    controller.abort()
    await new Promise((resolve) => setImmediate(resolve))
    expect(cancellationSettled).toBe(false)
    expect(fixture.connection.disconnects).toBe(0)
    expect(fixture.connection.state.profile?.id).toBe(localProfile.id)
    expect(fixture.selected).toEqual([])
    expect(broker.live).toBe(true)
    expect(fixture.connection.brokers.size).toBe(1)
    expect(broker.prompts).toEqual([])
    // Cancelling environment intent cannot certify native retirement. Only
    // this controlled provider exit permits the original close to settle.
    broker.exit()
    const exit = await cancelled
    expect(Exit.isFailure(exit)).toBe(true)
    if (Exit.isFailure(exit)) expect(Cause.hasInterrupts(exit.cause)).toBe(true)
    expect(fixture.connection.disconnects).toBe(0)
    expect(fixture.connection.state.profile?.id).toBe(localProfile.id)
    expect(fixture.selected).toEqual([])
    expect(broker.prompts).toEqual([])
    expect(broker.live).toBe(false)
    await fixture.agents.models('codex')
    expect(fixture.connection.brokers.size).toBe(2)
    expect([...fixture.connection.brokers.values()][1].machine).toBe(localProfile.id)
    expect([...fixture.connection.brokers.values()].flatMap((owner) => owner.prompts)).toEqual([])
  })
})
