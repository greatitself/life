import { EventEmitter, once } from 'node:events'
import { createHash } from 'node:crypto'
import { cp, mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { PassThrough } from 'node:stream'
import { Deferred, Effect, Schema } from 'effect'
import type { ClientChannel } from 'ssh2'
import { afterEach, describe, expect, it, vi, type MockInstance } from 'vitest'
import { Agents } from '../src/main/agents'
import { NativeRecoveryError } from '../src/main/native-recovery-types'
import { DurableRemoteChannel } from '../src/main/durable-remote-channel'
import {
  NativeRecoveryStore,
  type NativeRecoveryStoreHandle,
} from '../src/main/native-recovery-store'
import type {
  NativeRecoveryInputSemantic,
  NativeRecoveryNumberedInput,
  NativeRecoveryOwner,
  NativeRecoverySnapshot,
  NativeRecoveryTransport,
} from '../src/main/native-recovery-types'
import type { SSHConnection } from '../src/main/ssh'
import type {
  AgentEvent,
  ConnectionState,
  NativeRecoveryConsumer,
  Provider,
  StartInput,
  NativeRecoveryActionRequest,
} from '../src/shared/types'

const originalDurableOpen = DurableRemoteChannel.open

const generateTitle = vi.hoisted(() => vi.fn(async () => undefined))
vi.mock('../src/main/provider-titles', () => ({ generateProviderTitle: generateTitle }))
vi.mock('../src/main/studio-context', async (original) => {
  const actual = await original<typeof import('../src/main/studio-context')>()
  return {
    ...actual,
    stageStudioContext: vi.fn(
      async (_ssh, sessionId: string) =>
        `/home/fixture/.life/customization/${createHash('sha256').update(sessionId).digest('hex')}`,
    ),
  }
})

afterEach(() => {
  vi.restoreAllMocks()
  generateTitle.mockClear()
})

const exactPrompt = '  Recover this exact\r\nprompt 🌍\ud800\udc00\ud800  '
const exactReply = '  Provider output\r\n🌍\ud800\udc00\ud800  '
const nativeThread = 'native-conversation-original'
const nativeTurn = 'native-turn-original'
const connected: ConnectionState = {
  status: 'connected',
  home: '/home/fixture',
  workspace: '/project',
  codex: 'codex-cli 0.162.1',
  claude: 'claude 2.1.278',
  profile: {
    id: 'machine-original',
    name: 'Original machine',
    host: 'original-host',
    username: 'original-user',
    port: 22,
    auth: 'agent',
    privateKeyPath: '',
    workspace: '/project',
  },
}

const run = <A>(effect: Effect.Effect<A, unknown>) => Effect.runPromise(effect)
const encoded = (value: unknown) => Buffer.from(JSON.stringify(value) + '\n').toString('base64')
const decodeInput = (input: NativeRecoverySnapshot['inputs'][number]) => {
  if (input.frame.type !== 'write') throw new Error('Expected a native write')
  return JSON.parse(Buffer.from(input.frame.data, 'base64').toString('utf8'))
}

async function deliverWrittenInput(store: NativeRecoveryStoreHandle, id: string, sequence: number) {
  const before = await run(store.readTransport(id))
  const original = before.inputs.find((input) => input.sequence === sequence)
  if (!original) throw new Error('Cannot deliver an unallocated native input')
  if (original.written) {
    if (original.deliveryReceipt?.status !== 'written')
      throw new Error('A written input is missing its native delivery receipt')
    return original.deliveryReceipt
  }
  await run(store.acknowledgeInput(id, sequence))
  const accepted = await run(store.readTransport(id))
  if (accepted.inputs.find((input) => input.sequence === sequence)?.written)
    throw new Error('Broker acceptance incorrectly manufactured native write proof')
  const receipt = {
    type: 'inputReceipt' as const,
    cursor: accepted.outputCursor + 1,
    sequence,
    status: 'written' as const,
  }
  await run(store.appendOutputs(id, [receipt]))
  const committed = (await run(store.readTransport(id))).inputs.find(
    (input) => input.sequence === sequence,
  )!
  if (
    !committed.written ||
    committed.deliveryReceipt?.status !== 'written' ||
    committed.deliveryReceipt.cursor !== receipt.cursor
  )
    throw new Error('A native write requires its exact ordered broker receipt')
  return committed.deliveryReceipt
}

function owner(provider: Provider): NativeRecoveryOwner {
  return {
    ownerId: 'life-session',
    sessionId: 'life-session',
    generation: 3,
    localTurn: 7,
    snapshotToken: 'snapshot-owned-by-native',
    kind: 'root',
    workspace: '/project',
    writableRoot: '/project/worktree',
    ...(provider === 'codex'
      ? { nativeThreadId: nativeThread, nativeTurnId: nativeTurn }
      : { nativeSessionId: nativeThread }),
    state: 'active',
    input: {
      sessionId: 'life-session',
      provider,
      remoteId: nativeThread,
      localTurn: 7,
      prompt: exactPrompt,
      mode: 'read-only',
      model: 'original-model',
      workspace: '/project',
      attachments: [
        {
          remotePath: '/project/exact attachment.txt',
          name: 'exact attachment.txt',
          mimeType: 'text/plain',
        },
      ],
      providerOptions: { futureNativeOption: { exact: '\ud800', enabled: false } },
    },
    clientRecovery: { planner: 'original', pendingStep: 4, exact: exactPrompt },
  }
}

function descriptor(provider: Provider): NativeRecoveryTransport {
  return {
    id: `original-${provider}-transport`,
    brokerId: `original-${provider}-broker`,
    brokerRoot: `/registered/home/.life/agent-sessions/original-${provider}-broker`,
    launchCommand:
      provider === 'codex' ? 'exec codex app-server' : 'exec claude --output-format stream-json',
    provider,
    providerVersion: provider === 'codex' ? '0.162.1' : '2.1.278',
    nativeProtocol: provider === 'codex' ? 'codex-app-server-jsonrpc' : 'claude-stream-json',
    brokerProtocolVersion: 2,
    inputReceipts: 1,
    machine: {
      profileId: 'machine-original',
      host: 'original-host',
      username: 'original-user',
      port: 22,
    },
    controller: { id: 'original-controller', epoch: 4 },
    initialization: { status: 'complete' },
    owners: [owner(provider)],
  }
}

function consumer(): NativeRecoveryConsumer {
  return {
    kind: 'studio',
    sessionId: 'life-session',
    profileId: 'machine-original',
    workspace: '/project',
    remoteId: nativeThread,
  }
}

class ReattachedChannel extends EventEmitter {
  readonly sessionId: string
  readonly stderr = new EventEmitter()
  readonly transportState = 'connected' as const
  readonly nativeWrites: {
    message: Record<string, unknown>
    semantic: NativeRecoveryInputSemantic
  }[] = []
  readonly rawWrites: string[] = []
  readonly signal = vi.fn()
  readonly close = vi.fn()
  readonly detach = vi.fn(async () => {
    if (this.destroyed) return
    this.destroyed = true
    await this.inputTail
    await this.outputTail
    this.emit('close')
  })
  readonly resumeRecoveryOutput = vi.fn()
  readonly waitForReplay = vi.fn(async (): Promise<void> => {})
  readonly activateRecoveryInputs = vi.fn(async () => undefined)
  readonly recordOwner = vi.fn(async () => undefined)
  readonly nativeRecoveryTracked = true
  readonly nativeInputReceipts = true
  outputCursor = 0
  autoReply = false
  initializationPayload: Record<string, unknown> = {}
  initializationPermissions: unknown[] = []
  heldMethods = new Set<string>()
  heldInputReceipts = new Set<NativeRecoveryInputSemantic['kind']>()
  private writtenReceipts = new Map<number, Deferred.Deferred<void>>()
  private deliveredReceipts = new Set<number>()
  private nativeInputAdmissions = new Map<number, NativeRecoveryNumberedInput>()
  private unconfirmedRecoveryInputs = new Set<number>()
  readonly confirmNativeInputProcessed = vi.fn((sequence: number) => {
    const input = this.nativeInputAdmissions.get(sequence)
    if (
      !input ||
      input.frame.type !== 'write' ||
      input.semantic.requestId === undefined ||
      input.semantic.method === 'initialized'
    )
      throw new Error('SDK processing proof requires its exact original response-bearing request')
    const message = JSON.parse(Buffer.from(input.frame.data, 'base64').toString('utf8'))
    if ((message.id ?? message.request_id) !== input.semantic.requestId)
      throw new Error('SDK processing proof does not match its original native request')
    this.unconfirmedRecoveryInputs.delete(sequence)
  })
  get hasUnconfirmedRecoveryInputs() {
    return this.unconfirmedRecoveryInputs.size > 0
  }
  inputTail: Promise<void> = Promise.resolve()
  outputTail: Promise<void> = Promise.resolve()
  registration: Promise<void> = Promise.resolve()
  flushRecovery?: () => Promise<void>
  isClosing = false
  closeAndWaitEffect?: () => Effect.Effect<boolean, NativeRecoveryError>
  destroyed = false

  constructor(
    readonly recoveryId: string,
    readonly store: NativeRecoveryStoreHandle,
    snapshot?: NativeRecoverySnapshot,
  ) {
    super()
    this.sessionId = recoveryId
    for (const input of snapshot?.inputs || []) {
      this.nativeInputAdmissions.set(input.sequence, input)
      if (input.acknowledged && !input.written && input.deliveryReceipt?.status !== 'cancelled')
        this.unconfirmedRecoveryInputs.add(input.sequence)
    }
  }

  write(value: string) {
    this.rawWrites.push(value)
    return true
  }

  async writeNativeAndWait(
    message: Record<string, unknown>,
    semantic: NativeRecoveryInputSemantic,
  ) {
    const sequence = await this.enqueueInput(message, semantic)
    await run(Deferred.await(this.writtenReceipts.get(sequence)!))
    const input = (await run(this.store.readTransport(this.recoveryId))).inputs.find(
      (input) => input.sequence === sequence,
    )!
    if (!input.written || input.deliveryReceipt?.status !== 'written')
      throw new Error('Native adapter completion requires an actual stored write receipt')
  }

  writeNative(message: Record<string, unknown>, semantic: NativeRecoveryInputSemantic) {
    void this.enqueueInput(message, semantic)
    return true
  }

  private enqueueInput(message: Record<string, unknown>, semantic: NativeRecoveryInputSemantic) {
    const data = encoded(message)
    const capturedSemantic = JSON.parse(JSON.stringify(semantic)) as NativeRecoveryInputSemantic
    const admittedInput = this.inputTail.then(async () => {
      const admitted = await run(
        this.store.reserveInput(this.recoveryId, { type: 'write', data }, capturedSemantic),
      )
      if (admitted.frame.type !== 'write') throw new Error('Expected an admitted native write')
      const captured = JSON.parse(Buffer.from(admitted.frame.data, 'base64').toString('utf8'))
      this.nativeInputAdmissions.set(admitted.sequence, admitted)
      this.writtenReceipts.set(admitted.sequence, Deferred.makeUnsafe<void>())
      this.nativeWrites.push({ message: captured, semantic: admitted.semantic })
      // The stand-in commits an explicit simulated broker write receipt. The
      // later native protocol response is separate application evidence.
      if (!this.heldInputReceipts.has(capturedSemantic.kind))
        await this.confirmWritten(admitted.sequence)
      if (this.autoReply) queueMicrotask(() => void this.answer(captured))
      return admitted.sequence
    })
    this.inputTail = admittedInput.then(() => undefined)
    return admittedInput
  }

  confirmWritten(sequence: number) {
    this.outputTail = this.outputTail.then(async () => {
      const receipt = await deliverWrittenInput(this.store, this.recoveryId, sequence)
      this.outputCursor = Math.max(this.outputCursor, receipt.cursor)
      this.unconfirmedRecoveryInputs.delete(sequence)
      if (!this.deliveredReceipts.has(sequence)) {
        this.deliveredReceipts.add(sequence)
        this.emit('input-receipt', { type: 'inputReceipt', sequence, ...receipt })
      }
      const pending = this.writtenReceipts.get(sequence)
      if (pending) Deferred.doneUnsafe(pending, Effect.void)
    })
    return this.outputTail
  }

  async answer(message: Record<string, unknown>) {
    const method = String(
      message.method || (message.request as { subtype?: string })?.subtype || '',
    )
    if (this.heldMethods.has(method) || this.destroyed) return
    if (message.type === 'control_request') {
      await this.reply({
        type: 'control_response',
        response: {
          subtype: 'success',
          request_id: message.request_id,
          response: method === 'initialize' ? this.initializationPayload : {},
          ...(method === 'initialize'
            ? { pending_permission_requests: this.initializationPermissions }
            : {}),
        },
      })
    } else if (typeof message.id === 'number' && message.method) {
      const params = message.params as Record<string, unknown> | undefined
      const results: Record<string, unknown> = {
        initialize: {},
        'config/read': { config: { model: 'test-model' } },
        'model/list': { data: [{ model: 'test-model', displayName: 'Test', isDefault: true }] },
        'thread/start': { thread: { id: nativeThread } },
        'thread/resume': { thread: { id: params?.threadId } },
        'thread/read': { thread: { id: params?.threadId } },
        'turn/start': { turn: { id: `turn-next-${message.id}` } },
      }
      await this.reply({ id: message.id, result: results[method] || {} })
    }
  }

  reply(message: unknown) {
    const bytes = Buffer.from(JSON.stringify(message) + '\n')
    this.outputTail = this.outputTail.then(async () => {
      const snapshot = await run(this.store.readTransport(this.recoveryId))
      this.outputCursor = snapshot.outputCursor + 1
      await run(
        this.store.appendOutputs(this.recoveryId, [
          {
            type: 'stdout',
            cursor: this.outputCursor,
            data: bytes.toString('base64'),
          },
        ]),
      )
      this.emit('data', bytes)
    })
    return this.outputTail
  }

  async nativeExit() {
    const snapshot = await run(this.store.readTransport(this.recoveryId))
    await run(
      this.store.appendOutputs(this.recoveryId, [
        {
          type: 'exit',
          cursor: snapshot.outputCursor + 1,
          code: 0,
          nativeExitConfirmed: true,
        },
      ]),
    )
    this.destroyed = true
    this.unconfirmedRecoveryInputs.clear()
    this.emit('exit', 0)
    this.emit('close')
  }
}

interface Fixture {
  directory: string
  store: NativeRecoveryStoreHandle
  transport: NativeRecoveryTransport
  agents: Agents
  ssh: SSHConnection
  events: AgentEvent[]
  attachments: ReattachedChannel[]
  open: MockInstance<typeof DurableRemoteChannel.open>
}

const scopedFixture = Effect.fn('tests.agentsNativeRecoveryBoundaries.fixture')(function* (
  provider: Provider,
  seeded: boolean,
  body: (fixture: Fixture) => Promise<void>,
) {
  const directory = yield* Effect.acquireRelease(
    Effect.promise(() => mkdtemp(join(tmpdir(), 'life-agents-native-recovery-boundaries-'))),
    (directory) => Effect.promise(() => rm(directory, { recursive: true, force: true })),
  )
  const store = yield* NativeRecoveryStore.make({ directory, outputBatchDelayMs: 1 })
  const transport = descriptor(provider)
  if (seeded) yield* store.createTransport(transport)
  const ssh = new EventEmitter() as SSHConnection
  ssh.state = { ...connected, profile: { ...connected.profile! } }
  ssh.channel = vi.fn(async () => {
    throw new Error('Recovery must never launch a new provider channel')
  })
  ssh.exec = vi.fn(async () => {
    throw new Error('Recovery must not stage another prompt or title inference')
  })
  const attachments: ReattachedChannel[] = []
  const open = vi
    .spyOn(DurableRemoteChannel, 'open')
    .mockImplementation(async (_host, _command, onOpeningOrOptions, recoveryOptions) => {
      const options =
        typeof onOpeningOrOptions === 'function' ? recoveryOptions : onOpeningOrOptions
      if (!options || !('snapshot' in options) || !options.snapshot)
        throw new Error('Recovery requires the original durable transport snapshot')
      const channel = new ReattachedChannel(options.snapshot.transport.id, store, options.snapshot)
      attachments.push(channel)
      if (typeof onOpeningOrOptions === 'function')
        onOpeningOrOptions(channel as unknown as DurableRemoteChannel)
      return channel as unknown as DurableRemoteChannel
    })
  const events: AgentEvent[] = []
  const agents = new Agents(
    ssh,
    (event) => {
      events.push(event)
    },
    store,
  )
  yield* Effect.tryPromise({
    try: async () => {
      try {
        await body({ directory, store, transport, ssh, agents, events, attachments, open })
      } finally {
        await agents.detach()
      }
    },
    catch: (cause) => cause,
  })
})

const withFixture = (
  provider: Provider,
  body: (fixture: Fixture) => Promise<void>,
  seeded = true,
) => Effect.runPromise(Effect.scoped(scopedFixture(provider, seeded, body)))

async function appendBytes(fixture: Fixture, chunks: readonly Buffer[]) {
  const snapshot = await run(fixture.store.readTransport(fixture.transport.id))
  await run(
    fixture.store.appendOutputs(
      fixture.transport.id,
      chunks.map((chunk, index) => ({
        type: 'stdout' as const,
        cursor: snapshot.outputCursor + index + 1,
        data: chunk.toString('base64'),
      })),
    ),
  )
}

async function appendMessages(fixture: Fixture, messages: readonly unknown[]) {
  await appendBytes(fixture, [
    Buffer.from(messages.map((message) => JSON.stringify(message) + '\n').join('')),
  ])
}

async function admitOriginalPrompt(fixture: Fixture, initializedWritten = true) {
  const provider = fixture.transport.provider
  const initialize =
    provider === 'codex'
      ? {
          id: 1,
          method: 'initialize',
          params: { clientInfo: { name: 'life', version: 'original' } },
        }
      : {
          type: 'control_request',
          request_id: 'original-initialize',
          request: { subtype: 'initialize' },
        }
  const initialization = await run(
    fixture.store.reserveInput(
      fixture.transport.id,
      { type: 'write', data: encoded(initialize) },
      {
        kind: 'initialize',
        sessionId: 'life-session',
        ownerGeneration: 3,
        ...(provider === 'codex'
          ? { method: 'initialize', requestId: 1 }
          : { requestType: 'initialize', requestId: 'original-initialize' }),
      },
    ),
  )
  await run(fixture.store.acknowledgeInput(fixture.transport.id, initialization.sequence))
  await deliverWrittenInput(fixture.store, fixture.transport.id, initialization.sequence)
  await appendMessages(fixture, [
    provider === 'codex'
      ? { id: 1, result: {} }
      : {
          type: 'control_response',
          response: { subtype: 'success', request_id: 'original-initialize', response: {} },
        },
  ])
  if (provider === 'codex') {
    const initialized = await run(
      fixture.store.reserveInput(
        fixture.transport.id,
        { type: 'write', data: encoded({ method: 'initialized' }) },
        { kind: 'initialize', method: 'initialized' },
      ),
    )
    await run(fixture.store.acknowledgeInput(fixture.transport.id, initialized.sequence))
    if (initializedWritten)
      await deliverWrittenInput(fixture.store, fixture.transport.id, initialized.sequence)
  }
  const message =
    provider === 'codex'
      ? {
          id: 12,
          method: 'turn/start',
          params: { threadId: nativeThread, input: [{ type: 'text', text: exactPrompt }] },
        }
      : { type: 'user', session_id: nativeThread, message: { role: 'user', content: exactPrompt } }
  const input = await run(
    fixture.store.reserveInput(
      fixture.transport.id,
      { type: 'write', data: encoded(message) },
      {
        kind: 'user-prompt',
        sessionId: 'life-session',
        ownerGeneration: 3,
        nativeThreadId: nativeThread,
        ...(provider === 'codex' ? { method: 'turn/start', requestId: 12 } : {}),
      },
    ),
  )
  await run(fixture.store.acknowledgeInput(fixture.transport.id, input.sequence))
  await deliverWrittenInput(fixture.store, fixture.transport.id, input.sequence)
  if (provider === 'codex')
    await appendMessages(fixture, [{ id: 12, result: { turn: { id: nativeTurn } } }])
  return input
}

function permission(provider: Provider, id: string | number = 'native-permission-original') {
  return provider === 'codex'
    ? {
        id,
        method: 'item/commandExecution/requestApproval',
        params: {
          threadId: nativeThread,
          turnId: nativeTurn,
          itemId: 'native-command',
          command: 'printf "exact 🌍"',
          cwd: '/project',
          futureNativeField: { exact: '\ud800', flags: [false, null] },
        },
      }
    : {
        type: 'control_request',
        request_id: id,
        session_id: nativeThread,
        request: {
          subtype: 'can_use_tool',
          tool_name: 'Bash',
          tool_use_id: `tool-${String(id)}`,
          input: { command: 'printf "exact 🌍"' },
          futureNativeField: { exact: '\ud800', flags: [false, null] },
        },
      }
}

const localRequestId = (provider: Provider, id: string | number = 'native-permission-original') =>
  provider === 'codex'
    ? `${descriptor(provider).id}:request:${typeof id}:${String(id)}`
    : String(id)

function nextInput(provider: Provider, extra: Partial<StartInput> = {}): StartInput {
  return {
    sessionId: 'life-session',
    provider,
    prompt: '  Explicit next turn\r\n🌍\ud800  ',
    remoteId: nativeThread,
    mode: provider === 'claude' ? 'review' : 'read-only',
    model: 'test-model',
    workspace: '/project',
    localTurn: 8,
    ...extra,
  }
}

async function completeOriginal(fixture: Fixture, exited: boolean) {
  await admitOriginalPrompt(fixture)
  await appendMessages(
    fixture,
    fixture.transport.provider === 'codex'
      ? [
          {
            method: 'turn/completed',
            params: { threadId: nativeThread, turn: { id: nativeTurn, status: 'completed' } },
          },
        ]
      : [
          {
            type: 'result',
            session_id: nativeThread,
            subtype: 'success',
            is_error: false,
            result: exactReply,
          },
        ],
  )
  if (exited) {
    const before = await run(fixture.store.readTransport(fixture.transport.id))
    await run(
      fixture.store.appendOutputs(fixture.transport.id, [
        {
          type: 'exit',
          cursor: before.outputCursor + 1,
          code: 0,
        },
      ]),
    )
  }
}

async function seedActiveGraph(fixture: Fixture) {
  await admitOriginalPrompt(fixture)
  const provider = fixture.transport.provider
  const childPermission = permission(provider, 'native-child-permission-original')
  await appendMessages(
    fixture,
    provider === 'codex'
      ? [
          {
            method: 'thread/started',
            params: {
              thread: {
                id: 'native-child-original',
                parentThreadId: nativeThread,
                status: { type: 'active', activeFlags: [] },
              },
            },
          },
          {
            method: 'turn/started',
            params: {
              threadId: 'native-child-original',
              turn: { id: 'native-child-turn-original', status: 'inProgress' },
            },
          },
          permission(provider),
          {
            ...childPermission,
            params: {
              ...childPermission.params,
              threadId: 'native-child-original',
              turnId: 'native-child-turn-original',
            },
          },
        ]
      : [
          {
            type: 'system',
            subtype: 'task_started',
            session_id: nativeThread,
            task_id: 'native-child-original',
            tool_use_id: 'native-delegate-original',
            description: 'Original background work 🧭',
            is_backgrounded: true,
          },
          permission(provider),
          {
            ...childPermission,
            parent_tool_use_id: 'native-delegate-original',
            request: { ...childPermission.request, agent_id: 'native-child-original' },
          },
        ],
  )
  return run(fixture.store.readTransport(fixture.transport.id))
}

async function seedUnconfirmedTerminal(fixture: Fixture, closeAllocated: boolean) {
  await seedActiveGraph(fixture)
  if (closeAllocated) {
    const close = await run(
      fixture.store.reserveInput(fixture.transport.id, { type: 'close' }, { kind: 'close' }),
    )
    await run(fixture.store.acknowledgeInput(fixture.transport.id, close.sequence))
  }
  const before = await run(fixture.store.readTransport(fixture.transport.id))
  await run(
    fixture.store.appendOutputs(fixture.transport.id, [
      {
        type: 'exit',
        cursor: before.outputCursor + 1,
        code: 0,
        nativeExitConfirmed: false,
      },
    ]),
  )
  return run(fixture.store.readTransport(fixture.transport.id))
}

function installLaunch(
  fixture: Fixture,
  configure?: (channel: ReattachedChannel) => void,
  beforeCreate?: () => Promise<void>,
  afterCreate?: (channel: ReattachedChannel) => Promise<void>,
) {
  const launched: ReattachedChannel[] = []
  const commands: string[] = []
  fixture.ssh.durableChannel = vi.fn(async (command, onOpening, provider = 'codex') => {
    commands.push(command)
    await beforeCreate?.()
    const snapshots = await run(fixture.store.listTransports())
    const id = snapshots.some((snapshot) => snapshot.transport.id === fixture.transport.id)
      ? `${fixture.transport.id}-new-${launched.length + 1}`
      : fixture.transport.id
    const transport = {
      ...descriptor(provider),
      id,
      brokerId: id,
      brokerRoot: `/registered/home/.life/agent-sessions/${id}`,
      launchCommand: command,
      initialization: { status: 'not-started' as const },
      owners: [],
    }
    const channel = new ReattachedChannel(id, fixture.store)
    let registered = false
    let registrationCommitted!: () => void
    channel.registration = new Promise<void>((resolve) => {
      registrationCommitted = resolve
    })
    Object.defineProperty(channel, 'recoveryId', {
      get: () => (registered ? id : undefined),
    })
    channel.autoReply = true
    configure?.(channel)
    launched.push(channel)
    onOpening?.(channel as unknown as ClientChannel)
    await run(fixture.store.createTransport(transport))
    registered = true
    registrationCommitted()
    await afterCreate?.(channel)
    return channel as unknown as ClientChannel
  })
  return { launched, commands }
}

function studioReservation(provider: Provider) {
  const input = nextInput(provider, {
    prompt: exactPrompt,
    mode: 'plan',
    scope: 'life-customization',
    remoteId: undefined,
    studioContext: {
      instructions: 'Private Studio context',
      files: [],
      revision: 0,
      phase: 'request',
    },
  })
  delete input.remoteId
  delete input.workspace
  const clientRecovery = {
    sessionId: input.sessionId,
    profileId: connected.profile!.id,
    provider,
    phase: 'preparing',
    nativeIteration: 0,
    request: exactPrompt,
    turn: input.localTurn!,
  }
  return { input, clientRecovery }
}

function studioStartInput(reservation: ReturnType<typeof studioReservation>): StartInput {
  return {
    ...reservation.input,
    clientRecovery: {
      ...reservation.clientRecovery,
      phase: 'planning',
      nativeIteration: 1,
    },
  }
}

const withFrozenStore = Effect.fn('tests.nativeRecoveryBoundary.frozenStore')(function* (
  fixture: Fixture,
  body: (store: NativeRecoveryStoreHandle) => Promise<void>,
) {
  const directory = yield* Effect.acquireRelease(
    Effect.promise(() => mkdtemp(join(tmpdir(), 'life-native-crash-boundary-'))),
    (directory) => Effect.promise(() => rm(directory, { recursive: true, force: true })),
  )
  yield* Effect.promise(() => fixture.agents.flushRecovery())
  yield* Effect.promise(() =>
    cp(fixture.directory, directory, {
      recursive: true,
      filter: (path) => !path.endsWith('.writer.lock'),
    }),
  )
  const store = yield* NativeRecoveryStore.make({ directory, outputBatchDelayMs: 1 })
  yield* Effect.tryPromise({ try: () => body(store), catch: (cause) => cause })
})

function installClaudeMetadata(fixture: Fixture) {
  fixture.ssh.channel = vi.fn(async () => {
    const channel = Object.assign(new EventEmitter(), {
      stderr: new EventEmitter(),
      destroyed: false,
      signal: vi.fn(),
      close: vi.fn(),
      write(raw: string) {
        const request = JSON.parse(raw)
        expect(request.request?.subtype).toBe('initialize')
        queueMicrotask(() =>
          channel.emit(
            'data',
            Buffer.from(
              JSON.stringify({
                type: 'control_response',
                response: {
                  subtype: 'success',
                  request_id: request.request_id,
                  response: { models: [{ value: 'test-model', display_name: 'Test' }] },
                },
              }) + '\n',
            ),
          ),
        )
        return true
      },
    })
    return channel as unknown as ClientChannel
  })
}

describe('Agents native recovery boundaries', () => {
  it.each(['codex', 'claude'] as const)(
    'replays exact committed %s history before reconnect without attaching or admitting input',
    async (provider) => {
      await withFixture(provider, async (fixture) => {
        const original = owner(provider)
        const [stored] = await run(
          fixture.store.appendEvents(fixture.transport.id, [
            {
              eventId: `${fixture.transport.id}:local:original:1`,
              outputCursor: 0,
              event: {
                sessionId: original.sessionId,
                type: 'text',
                text: exactReply,
                nativeRecovery: {
                  snapshotToken: original.snapshotToken!,
                  ownerGeneration: original.generation!,
                  localTurn: original.localTurn!,
                },
              },
            },
          ]),
        )
        const before = await run(fixture.store.readTransport(fixture.transport.id))
        fixture.ssh.state = { ...fixture.ssh.state, status: 'disconnected' }
        const recovered = await fixture.agents.recover({ consumers: [consumer()] })
        expect(recovered.owners).toMatchObject([
          { status: 'unknown', transportId: fixture.transport.id },
        ])
        expect(fixture.events).toHaveLength(1)
        expect(fixture.events[0]).toMatchObject({
          sessionId: original.sessionId,
          type: 'text',
          text: exactReply,
          nativeRecovery: {
            eventId: stored.eventId,
            revision: stored.revision,
            snapshotToken: original.snapshotToken,
            ownerGeneration: original.generation,
            localTurn: original.localTurn,
          },
        })
        expect((await run(fixture.store.readTransport(fixture.transport.id))).inputs).toEqual(
          before.inputs,
        )
        expect(fixture.attachments).toEqual([])
        expect(fixture.open).not.toHaveBeenCalled()
        expect(fixture.ssh.channel).not.toHaveBeenCalled()
        expect(fixture.ssh.exec).not.toHaveBeenCalled()
      })
    },
  )

  it.each([true, false])(
    'preserves an observed Codex completion across stale sibling checkpoints before native exit: completed=%s',
    async (completed) => {
      await withFixture('codex', async (fixture) => {
        await admitOriginalPrompt(fixture)
        if (completed)
          await appendMessages(fixture, [
            {
              method: 'turn/completed',
              params: { threadId: nativeThread, turn: { id: nativeTurn, status: 'completed' } },
            },
          ])
        const before = await run(fixture.store.readTransport(fixture.transport.id))
        // A sibling update republishes its older active owner list after the native output.
        await run(
          fixture.store.updateTransport(fixture.transport.id, {
            owners: before.transport.owners,
          }),
        )
        const stale = await run(fixture.store.readTransport(fixture.transport.id))
        await run(
          fixture.store.appendOutputs(fixture.transport.id, [
            {
              type: 'exit',
              cursor: stale.outputCursor + 1,
              code: 0,
              nativeExitConfirmed: true,
            },
          ]),
        )
        const result = await fixture.agents.recover({ consumers: [consumer()] })
        expect(result.owners[0]).toMatchObject({ status: 'idle', remoteId: nativeThread })
        expect(fixture.events.filter((event) => event.type === 'complete')).toHaveLength(
          completed ? 1 : 0,
        )
        expect(fixture.events.filter((event) => event.type === 'error')).toHaveLength(
          completed ? 0 : 1,
        )
        expect((await run(fixture.store.readTransport(fixture.transport.id))).inputs).toEqual(
          stale.inputs,
        )
        expect(fixture.open).not.toHaveBeenCalled()
        expect(fixture.ssh.channel).not.toHaveBeenCalled()
        expect(fixture.ssh.exec).not.toHaveBeenCalled()
      })
    },
  )

  it('keeps Claude cumulative usage on its original process identity across recovered turn generations', async () => {
    await withFixture('claude', async (fixture) => {
      await admitOriginalPrompt(fixture)
      await appendMessages(fixture, [
        {
          type: 'result',
          session_id: nativeThread,
          subtype: 'success',
          is_error: false,
          usage: { input_tokens: 1, output_tokens: 1 },
          total_cost_usd: 0.01,
        },
      ])
      const original = fixture.transport.owners[0]
      const prompt = '  Second exact Claude request\r\n'
      await run(
        fixture.store.updateTransport(fixture.transport.id, {
          owners: [
            {
              ...original,
              generation: 4,
              localTurn: 8,
              snapshotToken: 'next-native-snapshot',
              input: { ...original.input, prompt, localTurn: 8 },
            },
          ],
        }),
      )
      const second = await run(
        fixture.store.reserveInput(
          fixture.transport.id,
          {
            type: 'write',
            data: encoded({
              type: 'user',
              session_id: nativeThread,
              message: { role: 'user', content: [{ type: 'text', text: prompt }] },
            }),
          },
          {
            kind: 'user-prompt',
            sessionId: 'life-session',
            ownerGeneration: 4,
            nativeThreadId: nativeThread,
          },
        ),
      )
      await deliverWrittenInput(fixture.store, fixture.transport.id, second.sequence)
      await appendMessages(fixture, [
        {
          type: 'result',
          session_id: nativeThread,
          subtype: 'success',
          is_error: false,
          usage: { input_tokens: 2, output_tokens: 2 },
          total_cost_usd: 0.02,
        },
      ])
      const restored = await fixture.agents.recover({ consumers: [consumer()] })
      await fixture.agents.flushRecovery()
      expect(restored.owners.find((owner) => owner.sessionId === 'life-session')?.status).toBe(
        'idle',
      )
      const usage = fixture.events.filter(
        (event): event is AgentEvent & { details: Record<string, unknown> } =>
          typeof event.details === 'object' &&
          event.details !== null &&
          !Array.isArray(event.details) &&
          'usageScope' in event.details &&
          event.details.usageScope === 'session',
      )
      expect(usage).toHaveLength(2)
      expect(usage.map((event) => event.details?.usageCallId)).toEqual([
        fixture.transport.id + ':generation:3',
        fixture.transport.id + ':generation:3',
      ])
      expect(usage.map((event) => event.nativeRecovery?.ownerGeneration)).toEqual([3, 4])
      const journal = await run(fixture.store.readTransport(fixture.transport.id))
      expect(journal.inputs.filter((input) => input.semantic.kind === 'user-prompt')).toHaveLength(
        2,
      )
      expect(
        decodeInput(journal.inputs.find((input) => input.sequence === second.sequence)!).message
          .content[0].text,
      ).toBe(prompt)
      expect(fixture.attachments).toHaveLength(1)
      expect(fixture.attachments[0].nativeWrites).toEqual([])
      expect(fixture.ssh.channel).not.toHaveBeenCalled()
      expect(fixture.ssh.exec).not.toHaveBeenCalled()
    })
  })

  it('flushes the exact accepted fresh native write admission without waiting for its receipt or SDK response and preserves typed WAL failure', async () => {
    await withFixture(
      'codex',
      async (fixture) => {
        const admission = Deferred.makeUnsafe<void>()
        const entered = vi.fn()
        const reserve = fixture.store.reserveInput.bind(fixture.store)
        const reserving = vi
          .spyOn(fixture.store, 'reserveInput')
          .mockImplementationOnce((id, frame, semantic) =>
            Effect.gen(function* () {
              entered()
              yield* Deferred.await(admission)
              return yield* reserve(id, frame, semantic)
            }),
          )
        const channelFlush = vi.fn()
        const { launched } = installLaunch(fixture, (channel) => {
          channel.heldMethods.add('initialize')
          channel.heldInputReceipts.add('initialize')
          channel.flushRecovery = async () => {
            channelFlush()
            // This is the stand-in's actual accepted input/WAL queue, not
            // an independent fake completion gate or native SDK promise.
            await channel.inputTail
            await run(fixture.store.flushEffect())
          }
        })
        let sdkSettled = false
        const catalog = fixture.agents.models('codex').then((models) => {
          sdkSettled = true
          return models
        })
        void catalog.catch(() => {})
        let flushing: Promise<void> | undefined
        try {
          await vi.waitFor(() => expect(entered).toHaveBeenCalledOnce())
          expect(launched).toHaveLength(1)
          const channel = launched[0]
          expect((await run(fixture.store.readTransport(channel.recoveryId))).inputs).toEqual([])
          let flushed = false
          flushing = fixture.agents.flushRecovery().then(() => {
            flushed = true
          })
          await vi.waitFor(() => expect(channelFlush).toHaveBeenCalledOnce())
          expect(flushed).toBe(false)
          expect(sdkSettled).toBe(false)
          expect(channel.nativeWrites).toEqual([])
          Deferred.doneUnsafe(admission, Effect.void)
          await flushing
          expect(flushed).toBe(true)
          expect(sdkSettled).toBe(false)
          const stored = await run(fixture.store.readTransport(channel.recoveryId))
          expect(stored.transport.owners).toEqual([])
          expect(stored.transport.initialization?.status).toBe('pending')
          expect(stored.inputs).toHaveLength(1)
          expect(stored.inputs[0]).toMatchObject({
            sequence: 1,
            acknowledged: false,
            written: false,
            semantic: { kind: 'initialize', method: 'initialize', requestId: 1 },
          })
          const [originalId, originalFrame, originalSemantic] = reserving.mock.calls[0]
          expect(originalId).toBe(channel.recoveryId)
          if (originalFrame.type !== 'write') throw new Error('Expected the original native write')
          expect(stored.inputs[0].frame).toMatchObject(originalFrame)
          expect(stored.inputs[0].semantic).toEqual(originalSemantic)
          expect(decodeInput(stored.inputs[0])).toEqual(channel.nativeWrites[0].message)
          expect(channel.nativeWrites).toHaveLength(1)
          await fixture.agents.flushRecovery()
          expect(channelFlush).toHaveBeenCalledTimes(2)
          expect(sdkSettled).toBe(false)
          expect((await run(fixture.store.readTransport(channel.recoveryId))).inputs).toEqual(
            stored.inputs,
          )
          const ioFailure = new NativeRecoveryError({
            operation: 'flush',
            path: fixture.directory,
            reason: 'io',
            message: 'Fixture WAL flush failed after the original write admission',
          })
          const failingFlush = vi
            .spyOn(fixture.store, 'flushEffect')
            .mockImplementationOnce(() => Effect.fail(ioFailure))
          try {
            await expect(fixture.agents.flushRecovery()).rejects.toMatchObject({
              operation: 'flush',
              reason: 'io',
              message: ioFailure.message,
            })
          } finally {
            failingFlush.mockRestore()
          }
          expect(channelFlush).toHaveBeenCalledTimes(3)
          expect(sdkSettled).toBe(false)
          expect(reserving).toHaveBeenCalledOnce()
          expect(channel.nativeWrites).toHaveLength(1)
          expect(channel.rawWrites).toEqual([])
          expect(channel.signal).not.toHaveBeenCalled()
          expect(channel.close).not.toHaveBeenCalled()
          expect(fixture.ssh.durableChannel).toHaveBeenCalledOnce()
          expect(fixture.open).not.toHaveBeenCalled()
          expect(fixture.ssh.exec).not.toHaveBeenCalled()
        } finally {
          Deferred.doneUnsafe(admission, Effect.void)
          await flushing?.catch(() => {})
          reserving.mockRestore()
          const channel = launched[0]
          if (channel) {
            await channel.inputTail
            channel.heldInputReceipts.delete('initialize')
            channel.heldMethods.delete('initialize')
            const initialize = channel.nativeWrites.find(
              ({ message }) => message.method === 'initialize',
            )
            if (initialize) {
              await channel.confirmWritten(1)
              await channel.answer(initialize.message)
            }
          }
          await catalog.catch(() => {})
        }
      },
      false,
    )
  })

  it.each(['codex', 'claude'] as const)(
    'waits for the installed %s version before admitting model discovery or its exact first native prompt',
    async (provider) => {
      await withFixture(
        provider,
        async (fixture) => {
          const ready = Deferred.makeUnsafe<ConnectionState>()
          fixture.ssh.state = { ...fixture.ssh.state, providerVersionsStatus: 'checking' }
          fixture.ssh.whenProviderVersionsReady = vi.fn(() => run(Deferred.await(ready)))
          const { launched } = installLaunch(fixture)
          if (provider === 'claude') installClaudeMetadata(fixture)
          const input = nextInput(provider, { prompt: exactPrompt, localTurn: 0 })
          const starting = fixture.agents.start(input)
          const catalog = fixture.agents.models(provider)
          void starting.catch(() => {})
          void catalog.catch(() => {})
          try {
            await vi.waitFor(() => expect(fixture.ssh.whenProviderVersionsReady).toHaveBeenCalled())
            expect(fixture.agents.hasRunningSessions()).toBe(false)
            expect(fixture.agents.hasPendingRendererWork()).toBe(true)
            expect(launched).toEqual([])
            expect(fixture.ssh.channel).not.toHaveBeenCalled()
            expect(fixture.ssh.durableChannel).not.toHaveBeenCalled()
            expect(fixture.open).not.toHaveBeenCalled()
            expect(await run(fixture.store.listTransports())).toEqual([])
            fixture.ssh.state = { ...fixture.ssh.state, providerVersionsStatus: 'ready' }
            Deferred.doneUnsafe(ready, Effect.succeed(fixture.ssh.state))
            await starting
            await expect(catalog).resolves.toEqual(
              expect.arrayContaining([expect.objectContaining({ id: 'test-model' })]),
            )
            await launched[0].inputTail
            await fixture.agents.flushRecovery()
            expect(launched).toHaveLength(1)
            expect(fixture.ssh.durableChannel).toHaveBeenCalledOnce()
            const native = await run(fixture.store.readTransport(launched[0].recoveryId))
            expect(native.transport.owners).toMatchObject([
              { sessionId: input.sessionId, input: { prompt: exactPrompt, provider } },
            ])
            const prompts = native.inputs.filter(
              (admitted) => admitted.semantic.kind === 'user-prompt',
            )
            expect(prompts).toHaveLength(1)
            expect(decodeInput(prompts[0])).toMatchObject(
              provider === 'codex'
                ? {
                    params: {
                      threadId: nativeThread,
                      input: [{ type: 'text', text: exactPrompt }],
                    },
                  }
                : {
                    session_id: nativeThread,
                    message: { content: [{ type: 'text', text: exactPrompt }] },
                  },
            )
            expect(fixture.open).not.toHaveBeenCalled()
            expect(fixture.ssh.exec).not.toHaveBeenCalled()
          } finally {
            Deferred.doneUnsafe(ready, Effect.succeed(fixture.ssh.state))
            await Promise.allSettled([starting, catalog])
          }
        },
        false,
      )
    },
  )

  it.each(['codex', 'claude'] as const)(
    'keeps the original Local %s native owner distinct from SSH localhost across the cold discovery barrier',
    async (provider) => {
      await withFixture(
        provider,
        async (fixture) => {
          const local = {
            ...connected.profile!,
            id: 'original-local-installation',
            transport: 'local' as const,
            host: 'localhost',
          }
          const loopbackSSH = { ...local, id: 'ssh-loopback-profile', transport: 'ssh' as const }
          fixture.transport = {
            ...fixture.transport,
            machine: {
              ...fixture.transport.machine,
              transport: 'local',
              profileId: local.id,
              host: local.host,
            },
          }
          fixture.ssh.state = {
            ...fixture.ssh.state,
            profile: local,
            providerVersionsStatus: 'checking',
          }
          await run(fixture.store.createTransport(fixture.transport))
          await admitOriginalPrompt(fixture)
          await appendMessages(fixture, [permission(provider)])
          const original = await run(fixture.store.readTransport(fixture.transport.id))
          const ready = Deferred.makeUnsafe<ConnectionState>()
          fixture.ssh.whenProviderVersionsReady = vi.fn(() => run(Deferred.await(ready)))
          const localConsumer = { ...consumer(), profileId: local.id }
          const pendingRecovery = fixture.agents.recover({ consumers: [localConsumer] })
          void pendingRecovery.catch(() => {})
          try {
            await vi.waitFor(() => expect(fixture.ssh.whenProviderVersionsReady).toHaveBeenCalled())
            expect(fixture.open).not.toHaveBeenCalled()
            expect(fixture.attachments).toEqual([])
            fixture.ssh.state = {
              ...fixture.ssh.state,
              profile: loopbackSSH,
              providerVersionsStatus: 'ready',
            }
            Deferred.doneUnsafe(ready, Effect.succeed(fixture.ssh.state))
            await expect(pendingRecovery).rejects.toMatchObject({
              operation: 'recover',
              message: 'Native recovery could not be admitted.',
              cause: { reason: 'changed' },
            })
            const foreign = await fixture.agents.recover({ consumers: [localConsumer] })
            expect(foreign.owners).toMatchObject([
              { sessionId: 'life-session', status: 'unknown', remoteId: nativeThread },
            ])
            expect(fixture.open).not.toHaveBeenCalled()
            expect(fixture.attachments).toEqual([])
            fixture.ssh.state = { ...fixture.ssh.state, profile: local }
            const recovered = await fixture.agents.recover({ consumers: [localConsumer] })
            expect(recovered.owners).toMatchObject([
              {
                transportId: fixture.transport.id,
                sessionId: 'life-session',
                status: 'running',
                remoteId: nativeThread,
                ownerGeneration: 3,
                pending: [{ requestId: localRequestId(provider) }],
              },
            ])
            expect(fixture.open).toHaveBeenCalledOnce()
            expect(fixture.open.mock.lastCall?.at(-1)).toMatchObject({
              snapshot: {
                transport: { id: fixture.transport.id, machine: fixture.transport.machine },
              },
              deferRecoveryInputs: true,
            })
            expect(fixture.attachments[0].nativeWrites).toEqual([])
            expect(fixture.attachments[0].rawWrites).toEqual([])
            expect(fixture.attachments[0].signal).not.toHaveBeenCalled()
            expect(fixture.attachments[0].close).not.toHaveBeenCalled()
            const after = await run(fixture.store.readTransport(fixture.transport.id))
            expect(after.inputs).toEqual(original.inputs)
            expect(after.outputs).toEqual(original.outputs)
            expect(fixture.ssh.channel).not.toHaveBeenCalled()
            expect(fixture.ssh.exec).not.toHaveBeenCalled()
          } finally {
            Deferred.doneUnsafe(ready, Effect.succeed(fixture.ssh.state))
            await pendingRecovery.catch(() => {})
          }
        },
        false,
      )
    },
  )

  it.each(
    (['codex', 'claude'] as const).flatMap((provider) =>
      (['start', 'recover'] as const).map((operation) => [provider, operation] as const),
    ),
  )(
    'retains the original Local %s runtime and permission when %s resumes a held recovery list under SSH localhost',
    async (provider, operation) => {
      await withFixture(
        provider,
        async (fixture) => {
          const local = {
            ...connected.profile!,
            id: 'local-owner-before-store-yield',
            transport: 'local' as const,
            host: 'localhost',
          }
          const loopbackSSH = {
            ...local,
            id: 'ssh-owner-after-store-yield',
            transport: 'ssh' as const,
          }
          fixture.transport = {
            ...fixture.transport,
            machine: {
              ...fixture.transport.machine,
              transport: 'local',
              profileId: local.id,
              host: local.host,
            },
          }
          fixture.ssh.state = {
            ...fixture.ssh.state,
            profile: local,
            providerVersionsStatus: 'ready',
          }
          await run(fixture.store.createTransport(fixture.transport))
          await admitOriginalPrompt(fixture)
          await appendMessages(fixture, [permission(provider)])
          const localConsumer = { ...consumer(), profileId: local.id }
          const restored = await fixture.agents.recover({ consumers: [localConsumer] })
          expect(restored.owners[0]).toMatchObject({
            status: 'running',
            remoteId: nativeThread,
            pending: [{ requestId: localRequestId(provider) }],
          })
          const original = await run(fixture.store.readTransport(fixture.transport.id))
          const originalChannel = fixture.attachments[0]
          const { launched } = installLaunch(fixture)
          const releaseRead = Deferred.makeUnsafe<void>()
          const reading = vi.fn()
          const list = fixture.store.listTransports.bind(fixture.store)
          const held = vi.spyOn(fixture.store, 'listTransports').mockImplementationOnce(() =>
            list().pipe(
              Effect.flatMap((snapshots) =>
                Effect.promise(async () => {
                  reading()
                  await run(Deferred.await(releaseRead))
                  return snapshots
                }),
              ),
            ),
          )
          const input = nextInput(provider, {
            sessionId: 'new-session-must-not-cross-store-yield',
            prompt: exactPrompt,
            localTurn: 0,
          })
          const pending =
            operation === 'start'
              ? fixture.agents.start(input)
              : fixture.agents.recover({ consumers: [localConsumer] })
          void pending.catch(() => {})
          try {
            await vi.waitFor(() => expect(reading).toHaveBeenCalledOnce())
            expect(launched).toEqual([])
            fixture.ssh.state = { ...fixture.ssh.state, profile: loopbackSSH }
            Deferred.doneUnsafe(releaseRead, Effect.void)
            if (operation === 'recover')
              await expect(pending).rejects.toMatchObject({
                operation: 'recover',
                message: 'Native recovery could not be admitted.',
                cause: { reason: 'changed' },
              })
            else await expect(pending).rejects.toThrow(/environment|machine|changed|cancelled/i)
            expect(launched).toEqual([])
            expect(fixture.ssh.durableChannel).not.toHaveBeenCalled()
            expect(fixture.ssh.channel).not.toHaveBeenCalled()
            expect(fixture.open).toHaveBeenCalledOnce()
            expect(originalChannel.nativeWrites).toEqual([])
            expect(originalChannel.rawWrites).toEqual([])
            expect(originalChannel.signal).not.toHaveBeenCalled()
            expect(originalChannel.close).not.toHaveBeenCalled()
            expect(await run(fixture.store.listTransports())).toHaveLength(1)
            const afterSwitch = await run(fixture.store.readTransport(fixture.transport.id))
            expect(afterSwitch.transport.machine).toEqual(original.transport.machine)
            expect(afterSwitch.transport.owners).toEqual(original.transport.owners)
            expect(afterSwitch.inputs).toEqual(original.inputs)
            expect(afterSwitch.outputs).toEqual(original.outputs)
            expect(fixture.events.some((event) => event.sessionId === input.sessionId)).toBe(false)
            fixture.ssh.state = { ...fixture.ssh.state, profile: local }
            const retained = await fixture.agents.recover({ consumers: [localConsumer] })
            expect(retained.owners).toMatchObject([
              {
                sessionId: 'life-session',
                status: 'running',
                transportId: fixture.transport.id,
                remoteId: nativeThread,
                ownerGeneration: 3,
                pending: [{ requestId: localRequestId(provider) }],
              },
            ])
            expect(fixture.attachments).toEqual([originalChannel])
            expect(originalChannel.nativeWrites).toEqual([])
            expect(originalChannel.rawWrites).toEqual([])
          } finally {
            Deferred.doneUnsafe(releaseRead, Effect.void)
            await pending.catch(() => {})
            held.mockRestore()
          }
        },
        false,
      )
    },
  )

  it('keeps accepted cold Codex inputs read-only until their own write receipt or exact response-bearing SDK correlation', async () => {
    for (const [kind, proof] of [
      ['initialized', 'receipt'],
      ['settings', 'receipt'],
      ['settings', 'sdk'],
      ['settings', 'sdk-error'],
      ['steer', 'receipt'],
      ['steer', 'sdk'],
      ['steer', 'sdk-error'],
    ] as const) {
      await withFixture('codex', async (fixture) => {
        await admitOriginalPrompt(fixture, kind !== 'initialized')
        let pending =
          kind === 'initialized'
            ? (await run(fixture.store.readTransport(fixture.transport.id))).inputs.find(
                (input) => input.semantic.method === 'initialized',
              )!
            : await run(
                fixture.store.reserveInput(
                  fixture.transport.id,
                  {
                    type: 'write',
                    data: encoded(
                      kind === 'settings'
                        ? {
                            id: 41,
                            method: 'thread/settings/update',
                            params: { threadId: nativeThread, model: 'test-model' },
                          }
                        : {
                            id: 42,
                            method: 'turn/steer',
                            params: {
                              threadId: nativeThread,
                              expectedTurnId: nativeTurn,
                              input: [
                                { type: 'text', text: '  Exact accepted steering\r\n雪\ud800  ' },
                              ],
                            },
                          },
                    ),
                  },
                  {
                    kind,
                    sessionId: 'life-session',
                    ownerGeneration: 3,
                    method: kind === 'settings' ? 'thread/settings/update' : 'turn/steer',
                    requestId: kind === 'settings' ? 41 : 42,
                    nativeThreadId: nativeThread,
                    nativeTurnId: nativeTurn,
                    details:
                      kind === 'settings'
                        ? {
                            requestedSettings: { model: 'test-model' },
                            nativeSettings: { model: 'test-model' },
                            permissionBoundaryChanged: false,
                          }
                        : { prompt: '  Exact accepted steering\r\n雪\ud800  ' },
                  },
                ),
              )
        await run(fixture.store.acknowledgeInput(fixture.transport.id, pending.sequence))
        await appendMessages(fixture, [permission('codex')])
        const before = await run(fixture.store.readTransport(fixture.transport.id))
        pending = before.inputs.find((input) => input.sequence === pending.sequence)!
        expect(pending).toMatchObject({ acknowledged: true, written: false, consumed: false })
        const recovered = await fixture.agents.recover({ consumers: [consumer()] })
        expect(['recovering', 'unknown']).toContain(recovered.owners[0].status)
        expect(recovered.owners[0]).toMatchObject({ remoteId: nativeThread, ownerGeneration: 3 })
        expect(recovered.owners[0].pending?.map((event) => event.requestId)).toEqual([
          localRequestId('codex'),
        ])
        const channel = fixture.attachments[0]
        expect(channel.hasUnconfirmedRecoveryInputs).toBe(true)
        expect(fixture.agents.hasRunningSessions()).toBe(true)
        await expect(
          fixture.agents.configure({ sessionId: 'life-session', mode: 'edit' }),
        ).rejects.toThrow(/recover|native|unconfirmed|disabled|delivery|proof|read.only/i)
        await expect(
          fixture.agents.respond('life-session', localRequestId('codex'), true),
        ).rejects.toThrow(/recover|native|unconfirmed|disabled|delivery|proof|read.only/i)
        expect(channel.nativeWrites).toEqual([])
        expect((await run(fixture.store.readTransport(fixture.transport.id))).inputs).toEqual(
          before.inputs,
        )
        await channel.reply({ id: 999, result: {} })
        await fixture.agents.flushRecovery()
        expect(channel.hasUnconfirmedRecoveryInputs).toBe(true)
        expect(channel.confirmNativeInputProcessed).not.toHaveBeenCalledWith(pending.sequence)
        if (kind !== 'initialized') {
          await channel.reply({ id: pending.semantic.requestId })
          await fixture.agents.flushRecovery()
          expect(channel.hasUnconfirmedRecoveryInputs).toBe(true)
          expect(channel.confirmNativeInputProcessed).not.toHaveBeenCalledWith(pending.sequence)
        }
        if (kind === 'settings' && proof === 'sdk')
          await expect(fixture.agents.rendererHandoffAdmitted()).resolves.toBe(false)
        if (proof === 'receipt') await channel.confirmWritten(pending.sequence)
        else
          await channel.reply(
            proof === 'sdk-error'
              ? {
                  id: pending.semantic.requestId,
                  error: { code: -32603, message: 'Fixture exact native request was rejected' },
                }
              : {
                  id: pending.semantic.requestId,
                  result: kind === 'steer' ? { turnId: nativeTurn } : {},
                },
          )
        await fixture.agents.flushRecovery()
        expect(channel.hasUnconfirmedRecoveryInputs).toBe(false)
        const proven = (await run(fixture.store.readTransport(fixture.transport.id))).inputs.find(
          (input) => input.sequence === pending.sequence,
        )!
        if (proof !== 'receipt') {
          expect(channel.confirmNativeInputProcessed).toHaveBeenCalledWith(pending.sequence)
          expect(proven).toMatchObject({ acknowledged: true, written: false, consumed: false })
          expect(proven.deliveryReceipt).toBeUndefined()
        } else {
          expect(proven).toMatchObject({
            written: true,
            consumed: true,
            deliveryReceipt: { status: 'written' },
          })
          if (kind === 'initialized')
            expect(channel.confirmNativeInputProcessed).not.toHaveBeenCalledWith(pending.sequence)
        }
        const current = await fixture.agents.recover({ consumers: [consumer()] })
        expect(current.owners[0]).toMatchObject({
          status: 'running',
          remoteId: nativeThread,
          ownerGeneration: 3,
        })
        if (kind === 'settings' && proof === 'sdk')
          await expect(fixture.agents.rendererHandoffAdmitted()).resolves.toBe(true)
        expect(current.owners[0].originalInput?.prompt).toBe(exactPrompt)
        if (kind === 'settings')
          expect(current.owners[0].originalInput?.model).toBe(
            proof === 'sdk' ? 'test-model' : 'original-model',
          )
        expect(current.owners[0].pending?.map((event) => event.requestId)).toEqual([
          localRequestId('codex'),
        ])
        for (const attachment of fixture.attachments) expect(attachment.nativeWrites).toEqual([])
        await fixture.agents.respond('life-session', localRequestId('codex'), true)
        expect(fixture.attachments.at(-1)!.nativeWrites).toMatchObject([
          {
            semantic: {
              kind: 'permission-response',
              permissionRequestId: 'native-permission-original',
            },
          },
        ])
        expect(
          (await run(fixture.store.readTransport(fixture.transport.id))).inputs.filter(
            (input) => input.semantic.kind === 'user-prompt',
          ),
        ).toHaveLength(1)
        expect(fixture.ssh.channel).not.toHaveBeenCalled()
        expect(fixture.ssh.exec).not.toHaveBeenCalled()
      })
    }
  })

  it.each(['codex', 'claude'] as const)(
    'retains the exact fresh %s opening while recovery observes its committed ownerless descriptor before ready',
    async (provider) => {
      await withFixture(
        provider,
        async (fixture) => {
          const ready = Deferred.makeUnsafe<void>()
          const afterCreate = vi.fn(async () => {
            await run(Deferred.await(ready))
          })
          const { launched } = installLaunch(fixture, undefined, undefined, afterCreate)
          const input = nextInput(provider, { prompt: exactPrompt, localTurn: 0 })
          const callers: Promise<unknown>[] = []
          const observe = (promise: Promise<unknown>) => {
            callers.push(promise)
            void promise.catch(() => {})
            return promise
          }
          observe(
            provider === 'codex' ? fixture.agents.models('codex') : fixture.agents.start(input),
          )
          try {
            await vi.waitFor(() => expect(afterCreate).toHaveBeenCalledOnce())
            expect(launched).toHaveLength(1)
            const opening = await run(fixture.store.readTransport(launched[0].recoveryId))
            expect(opening.transport).toMatchObject({
              id: launched[0].sessionId,
              brokerId: launched[0].sessionId,
              owners: [],
              initialization: { status: 'not-started' },
            })
            expect(opening.inputs).toEqual([])
            await observe(fixture.agents.recover({ consumers: [] }))
            expect(fixture.open).not.toHaveBeenCalled()
            expect(fixture.attachments).toEqual([])
            if (provider === 'codex') {
              observe(fixture.agents.models('codex'))
              observe(fixture.agents.start(input))
            }
            await new Promise<void>((resolve) => setImmediate(resolve))
            expect(fixture.open).not.toHaveBeenCalled()
            expect(
              (await run(fixture.store.readTransport(opening.transport.id))).transport,
            ).toEqual(opening.transport)
            expect((await run(fixture.store.readTransport(opening.transport.id))).inputs).toEqual(
              [],
            )
            Deferred.doneUnsafe(ready, Effect.void)
            await Promise.all(callers)
            await launched[0].inputTail
            await fixture.agents.flushRecovery()
            const settled = await run(fixture.store.readTransport(opening.transport.id))
            expect(settled.transport.brokerId).toBe(opening.transport.brokerId)
            expect(settled.transport.controller).toEqual(opening.transport.controller)
            expect(settled.transport.owners).toMatchObject([
              { sessionId: input.sessionId, input: { prompt: exactPrompt } },
            ])
            expect(
              launched[0].nativeWrites.filter(
                ({ message }) =>
                  message.method === 'initialize' ||
                  (message.request as { subtype?: string })?.subtype === 'initialize',
              ),
            ).toHaveLength(1)
            const prompts = settled.inputs.filter(
              (native) => native.semantic.kind === 'user-prompt',
            )
            expect(prompts).toHaveLength(1)
            expect(decodeInput(prompts[0])).toMatchObject(
              provider === 'codex'
                ? { params: { input: [{ type: 'text', text: exactPrompt }] } }
                : { message: { content: [{ type: 'text', text: exactPrompt }] } },
            )
            expect(fixture.open).not.toHaveBeenCalled()
            expect(fixture.ssh.durableChannel).toHaveBeenCalledOnce()
            expect(fixture.ssh.channel).not.toHaveBeenCalled()
            expect(fixture.ssh.exec).not.toHaveBeenCalled()
          } finally {
            Deferred.doneUnsafe(ready, Effect.void)
            await Promise.allSettled(callers)
          }
        },
        false,
      )
    },
  )

  it.each(['codex', 'claude'] as const)(
    'recovers the original ownerless %s descriptor after its fresh opening fails, including in a cold runtime',
    async (provider) => {
      await withFixture(
        provider,
        async (fixture) => {
          let failedRead: MockInstance<NativeRecoveryStoreHandle['readTransport']> | undefined
          const afterCreate = vi.fn(async () => {
            failedRead = vi.spyOn(fixture.store, 'readTransport').mockImplementationOnce(() =>
              Effect.fail(
                new NativeRecoveryError({
                  operation: 'readTransport',
                  path: fixture.directory,
                  reason: 'io',
                  message: 'Fixture cannot read the already registered original descriptor',
                }),
              ),
            )
            throw new Error('Fixture failed after durable registration before first ready')
          })
          const { launched } = installLaunch(fixture, undefined, undefined, afterCreate)
          await expect(
            provider === 'codex'
              ? fixture.agents.models('codex')
              : fixture.agents.start(nextInput(provider, { prompt: exactPrompt, localTurn: 0 })),
          ).rejects.toThrow(/after durable registration before first ready/)
          expect(failedRead).toHaveBeenCalledOnce()
          failedRead!.mockRestore()
          const before = await run(fixture.store.readTransport(launched[0].recoveryId))
          expect(before.transport.owners).toEqual([])
          expect(before.inputs).toEqual([])
          await fixture.agents.recover({ consumers: [] })
          expect(fixture.open).toHaveBeenCalledOnce()
          expect(fixture.open.mock.lastCall?.slice(0, 2)).toEqual([
            fixture.ssh,
            before.transport.launchCommand,
          ])
          expect(fixture.open.mock.lastCall?.at(-1)).toMatchObject({
            snapshot: { transport: before.transport },
            deferRecoveryInputs: true,
          })
          if (provider === 'claude')
            expect(fixture.attachments[0].activateRecoveryInputs).not.toHaveBeenCalled()
          await fixture.agents.detach()
          expect(fixture.attachments[0].detach).toHaveBeenCalledOnce()
          const retained = await run(fixture.store.readTransport(before.transport.id))
          await run(
            fixture.store.appendOutputs(before.transport.id, [
              {
                type: 'exit',
                cursor: retained.outputCursor + 1,
                code: 0,
                nativeExitConfirmed: false,
              },
            ]),
          )
          const cold = new Agents(fixture.ssh, () => {}, fixture.store)
          try {
            await cold.recover({ consumers: [] })
            expect(fixture.open).toHaveBeenCalledTimes(2)
            expect(fixture.open.mock.lastCall?.slice(0, 2)).toEqual([
              fixture.ssh,
              before.transport.launchCommand,
            ])
            expect(fixture.open.mock.lastCall?.at(-1)).toMatchObject({
              snapshot: { transport: before.transport },
              deferRecoveryInputs: true,
            })
            const after = await run(fixture.store.readTransport(before.transport.id))
            expect(after.transport).toEqual(before.transport)
            expect(after.inputs).toEqual([])
            expect(await run(fixture.store.listTransports())).toHaveLength(1)
            for (const attachment of fixture.attachments) {
              expect(attachment.nativeWrites).toEqual([])
              expect(attachment.signal).not.toHaveBeenCalled()
              expect(attachment.close).not.toHaveBeenCalled()
            }
            if (provider === 'claude')
              expect(fixture.attachments[1].activateRecoveryInputs).not.toHaveBeenCalled()
            await expect(
              cold.start(
                nextInput(provider, {
                  sessionId: 'life-denied-before-observed-exit',
                  localTurn: 0,
                }),
              ),
            ).rejects.toThrow(/original|initialization|opening|unknown|read.only/i)
            expect((await run(fixture.store.readTransport(before.transport.id))).inputs).toEqual([])
            expect(fixture.ssh.durableChannel).toHaveBeenCalledOnce()
            expect(fixture.ssh.channel).not.toHaveBeenCalled()
            expect(fixture.ssh.exec).not.toHaveBeenCalled()
            await fixture.attachments[1].nativeExit()
            await cold.flushRecovery()
            expect(fixture.ssh.durableChannel).toHaveBeenCalledOnce()
            expect(await run(fixture.store.listTransports())).toHaveLength(1)
            expect((await run(fixture.store.readTransport(before.transport.id))).inputs).toEqual([])
            const nextLaunch = installLaunch(fixture)
            await cold.start(
              nextInput(provider, {
                sessionId: 'life-explicit-after-observed-exit',
                localTurn: 0,
                prompt: exactPrompt,
              }),
            )
            await nextLaunch.launched[0].inputTail
            await cold.flushRecovery()
            expect(nextLaunch.launched).toHaveLength(1)
            expect(nextLaunch.launched[0].recoveryId).not.toBe(before.transport.id)
            const explicitPrompts = nextLaunch.launched[0].nativeWrites.filter(
              ({ semantic }) => semantic.kind === 'user-prompt',
            )
            expect(explicitPrompts).toHaveLength(1)
            expect(explicitPrompts[0].message).toMatchObject(
              provider === 'codex'
                ? { params: { input: [{ type: 'text', text: exactPrompt }] } }
                : { message: { content: [{ type: 'text', text: exactPrompt }] } },
            )
            expect((await run(fixture.store.readTransport(before.transport.id))).inputs).toEqual([])
          } finally {
            await cold.detach()
          }
        },
        false,
      )
    },
  )

  it('releases the exact failed fresh Codex guard only after its original initialized notification receives its own written receipt', async () => {
    await withFixture(
      'codex',
      async (fixture) => {
        const { launched } = installLaunch(fixture, (channel) => {
          vi.spyOn(channel, 'writeNativeAndWait').mockImplementationOnce(
            async (message, semantic) => {
              expect(message.method).toBe('initialized')
              channel.heldInputReceipts.add('initialize')
              channel.writeNative(message, semantic)
              await channel.inputTail
              const snapshot = await run(fixture.store.readTransport(channel.recoveryId))
              const original = snapshot.inputs.find(
                (input) => input.semantic.method === 'initialized',
              )!
              await run(fixture.store.acknowledgeInput(channel.recoveryId, original.sequence))
              throw new Error('Fixture lost attachment after initialized was accepted unwritten')
            },
          )
        })
        await expect(fixture.agents.models('codex')).rejects.toThrow(
          /owned Codex delivery failed.*native outcome must be recovered/,
        )
        const before = await run(fixture.store.readTransport(launched[0].recoveryId))
        const initialized = before.inputs.find((input) => input.semantic.method === 'initialized')!
        const initialize = before.inputs.find((input) => input.semantic.method === 'initialize')!
        expect(before.transport.owners).toEqual([])
        expect(before.transport.initialization?.status).toBe('pending')
        expect(initialized).toMatchObject({ acknowledged: true, written: false })
        expect(initialize.written).toBe(true)
        await fixture.agents.recover({ consumers: [] })
        const attached = fixture.attachments[0]
        expect(attached.activateRecoveryInputs).not.toHaveBeenCalled()
        expect(attached.nativeWrites).toEqual([])
        await expect(fixture.agents.models('codex')).rejects.toThrow(/original|initialization/i)
        await attached.reply({ id: initialize.semantic.requestId, result: {} })
        await fixture.agents.flushRecovery()
        await expect(fixture.agents.models('codex')).rejects.toThrow(/original|initialization/i)
        expect(
          (await run(fixture.store.readTransport(before.transport.id))).inputs.find(
            (input) => input.sequence === initialized.sequence,
          ),
        ).toMatchObject({ acknowledged: true, written: false })
        expect(attached.nativeWrites).toEqual([])
        await attached.confirmWritten(initialized.sequence)
        await fixture.agents.flushRecovery()
        expect(attached.activateRecoveryInputs).toHaveBeenCalledOnce()
        attached.autoReply = true
        await fixture.agents.start(nextInput('codex', { prompt: exactPrompt, localTurn: 0 }))
        await attached.inputTail
        await fixture.agents.flushRecovery()
        const after = await run(fixture.store.readTransport(before.transport.id))
        expect(after.transport.initialization?.status).toBe('complete')
        expect(after.transport.brokerId).toBe(before.transport.brokerId)
        expect(after.inputs.filter((input) => input.semantic.kind === 'user-prompt')).toHaveLength(
          1,
        )
        expect(after.inputs.filter((input) => input.semantic.method === 'initialize')).toHaveLength(
          1,
        )
        expect(
          after.inputs.filter((input) => input.semantic.method === 'initialized'),
        ).toHaveLength(1)
        expect(fixture.ssh.durableChannel).toHaveBeenCalledOnce()
        expect(fixture.open).toHaveBeenCalledOnce()
        expect(fixture.ssh.channel).not.toHaveBeenCalled()
        expect(fixture.ssh.exec).not.toHaveBeenCalled()
      },
      false,
    )
  })

  it('drains real ownerless Claude streams before ready while retaining readonly proof, exact guards and owned observer cleanup', async () => {
    for (const outcome of ['shutdown', 'confirmed-exit'] as const) {
      await withFixture(
        'claude',
        async (fixture) => {
          await run(
            fixture.store.createTransport({
              ...fixture.transport,
              owners: [],
              initialization: { status: 'pending', requestId: 'ownerless-initialize' },
            }),
          )
          const original = await run(
            fixture.store.reserveInput(
              fixture.transport.id,
              {
                type: 'write',
                data: encoded({
                  type: 'control_request',
                  request_id: 'ownerless-initialize',
                  request: { subtype: 'initialize' },
                }),
              },
              { kind: 'initialize', requestType: 'initialize', requestId: 'ownerless-initialize' },
            ),
          )
          await run(fixture.store.acknowledgeInput(fixture.transport.id, original.sequence))
          let unconfirmed = true
          const stdout = new PassThrough({ highWaterMark: 512 })
          const stderr = new PassThrough({ highWaterMark: 512 })
          const channel = Object.assign(stdout, {
            stderr,
            sessionId: fixture.transport.brokerId,
            recoveryId: fixture.transport.id,
            recoveryDescriptor: fixture.transport,
            nativeRecoveryTracked: true,
            nativeInputReceipts: true,
            transportState: 'connected' as const,
            isClosing: false,
            outputCursor: 0,
            signal: vi.fn(),
            close: vi.fn(),
            writeNative: vi.fn(),
            writeNativeAndWait: vi.fn(async () => undefined),
            resumeRecoveryOutput: vi.fn(),
            waitForReplay: vi.fn(async () => undefined),
            activateRecoveryInputs: vi.fn(async () => undefined),
            detach: vi.fn(async () => {
              stdout.destroy()
              stderr.destroy()
            }),
          })
          Object.defineProperty(channel, 'hasUnconfirmedRecoveryInputs', {
            get: () => unconfirmed,
          })
          const earlyReady = vi.fn()
          let ownedStdout: Function[] = []
          let ownedStderr: Function[] = []
          let ownedErrors: Function[] = []
          const pump = async (stream: PassThrough, type: 'stdout' | 'stderr') => {
            for (let index = 0; index < 8; index++) {
              const bytes = Buffer.from(
                type === 'stdout'
                  ? JSON.stringify({
                      type: 'system',
                      subtype: 'diagnostic',
                      diagnostic: 'stream-before-ready'.repeat(256),
                    }) + '\n'
                  : 'stderr-before-ready'.repeat(256) + '\n',
              )
              expect(bytes.byteLength).toBeGreaterThan(stream.readableHighWaterMark)
              const snapshot = await run(fixture.store.readTransport(fixture.transport.id))
              channel.outputCursor = snapshot.outputCursor + 1
              await run(
                fixture.store.appendOutputs(fixture.transport.id, [
                  { type, cursor: channel.outputCursor, data: bytes.toString('base64') },
                ]),
              )
              if (!stream.write(bytes)) await once(stream, 'drain')
            }
          }
          fixture.open.mockImplementationOnce(
            async (_host, _command, onOpeningOrOptions, recoveryOptions) => {
              expect(typeof onOpeningOrOptions).toBe('function')
              if (typeof onOpeningOrOptions !== 'function')
                throw new Error('Ownerless observation must be owned before first ready')
              expect(recoveryOptions).toMatchObject({
                snapshot: { transport: { id: fixture.transport.id, owners: [] } },
                deferRecoveryInputs: true,
              })
              onOpeningOrOptions(channel as unknown as DurableRemoteChannel)
              ownedStdout = channel.listeners('data')
              ownedStderr = stderr.listeners('data')
              ownedErrors = channel.listeners('error')
              expect(ownedErrors.length).toBeGreaterThan(0)
              await pump(stdout, 'stdout')
              await pump(stderr, 'stderr')
              earlyReady()
              return channel as unknown as DurableRemoteChannel
            },
          )
          const externalStdout = vi.fn()
          const externalStderr = vi.fn()
          const externalError = vi.fn()
          const { launched } = installLaunch(fixture)
          try {
            await fixture.agents.recover({ consumers: [] })
            expect(earlyReady).toHaveBeenCalledOnce()
            expect(stdout.readableLength).toBe(0)
            expect(stderr.readableLength).toBe(0)
            expect(channel.waitForReplay).toHaveBeenCalledOnce()
            expect(channel.activateRecoveryInputs).not.toHaveBeenCalled()
            expect(channel.writeNative).not.toHaveBeenCalled()
            expect(channel.writeNativeAndWait).not.toHaveBeenCalled()
            expect(launched).toEqual([])
            channel.on('data', externalStdout)
            stderr.on('data', externalStderr)
            channel.on('error', externalError)
            const receipt = await deliverWrittenInput(
              fixture.store,
              fixture.transport.id,
              original.sequence,
            )
            unconfirmed = false
            channel.outputCursor = receipt.cursor
            channel.emit('input-receipt', {
              type: 'inputReceipt',
              sequence: original.sequence,
              ...receipt,
            })
            await fixture.agents.flushRecovery()
            expect(channel.activateRecoveryInputs).not.toHaveBeenCalled()
            const beforeFalse = await run(fixture.store.readTransport(fixture.transport.id))
            await run(
              fixture.store.appendOutputs(fixture.transport.id, [
                {
                  type: 'exit',
                  cursor: beforeFalse.outputCursor + 1,
                  code: 0,
                  nativeExitConfirmed: false,
                },
              ]),
            )
            channel.emit(
              'error',
              new NativeRecoveryError({
                operation: 'remote-exit',
                path: fixture.transport.brokerRoot,
                reason: 'uncertain',
                message: 'Native termination has not been observed for this original broker',
              }),
            )
            await fixture.agents.flushRecovery()
            await expect(
              fixture.agents.start(
                nextInput('claude', {
                  sessionId: 'life-denied-with-ownerless-stream',
                  localTurn: 0,
                }),
              ),
            ).rejects.toThrow(/original|owner|unknown|read.only|termination/i)
            expect(channel.activateRecoveryInputs).not.toHaveBeenCalled()
            expect(channel.writeNative).not.toHaveBeenCalled()
            expect(channel.writeNativeAndWait).not.toHaveBeenCalled()
            expect(channel.signal).not.toHaveBeenCalled()
            expect(channel.close).not.toHaveBeenCalled()
            expect(launched).toEqual([])
            expect(fixture.events.filter((event) => event.type === 'text')).toEqual([])
            const originalProof = await run(fixture.store.readTransport(fixture.transport.id))
            expect(originalProof.inputs).toHaveLength(1)
            expect(originalProof.inputs[0]).toMatchObject({
              sequence: original.sequence,
              acknowledged: true,
              written: true,
              deliveryReceipt: { status: 'written', cursor: receipt.cursor },
            })
            expect(originalProof.outputs.filter((output) => output.type === 'stdout')).toHaveLength(
              8,
            )
            expect(originalProof.outputs.filter((output) => output.type === 'stderr')).toHaveLength(
              8,
            )
            expect(
              originalProof.outputs.some(
                (output) => output.type === 'exit' && output.nativeExitConfirmed !== false,
              ),
            ).toBe(false)
            if (outcome === 'confirmed-exit') {
              channel.outputCursor = originalProof.outputCursor + 1
              await run(
                fixture.store.appendOutputs(fixture.transport.id, [
                  {
                    type: 'exit',
                    cursor: channel.outputCursor,
                    code: 0,
                    nativeExitConfirmed: true,
                  },
                ]),
              )
              channel.emit('exit', 0)
              // DurableRemoteChannel publishes local close after its proven
              // terminal frame and replay barrier have both completed.
              channel.end()
              stderr.end()
              channel.emit('close')
              await fixture.agents.flushRecovery()
              expect(launched).toEqual([])
              expect(await run(fixture.store.listTransports())).toHaveLength(1)
              await fixture.agents.start(
                nextInput('claude', {
                  sessionId: 'life-explicit-after-ownerless-stream-exit',
                  localTurn: 0,
                  prompt: exactPrompt,
                }),
              )
              await launched[0].inputTail
              expect(launched).toHaveLength(1)
              expect(
                launched[0].nativeWrites.filter(({ semantic }) => semantic.kind === 'user-prompt'),
              ).toMatchObject([
                { message: { message: { content: [{ type: 'text', text: exactPrompt }] } } },
              ])
            }
            await fixture.agents.detach()
            await new Promise<void>((resolve) => setImmediate(resolve))
            if (outcome === 'shutdown') expect(channel.detach).toHaveBeenCalledOnce()
            for (const listener of ownedStdout)
              expect(channel.listeners('data'), outcome).not.toContain(listener)
            for (const listener of ownedStderr)
              expect(stderr.listeners('data'), outcome).not.toContain(listener)
            for (const listener of ownedErrors)
              expect(channel.listeners('error'), outcome).not.toContain(listener)
            expect(channel.listeners('data')).toContain(externalStdout)
            expect(stderr.listeners('data')).toContain(externalStderr)
            expect(channel.listeners('error')).toContain(externalError)
          } finally {
            stdout.resume()
            stderr.resume()
            stdout.destroy()
            stderr.destroy()
          }
        },
        false,
      )
    }
  })

  it('releases a failed fresh Codex opening after local close races its held cleanup read without inventing native exit proof', async () => {
    await withFixture(
      'codex',
      async (fixture) => {
        const cleanup = Deferred.makeUnsafe<void>()
        const cleanupRead = vi.fn()
        const read = fixture.store.readTransport.bind(fixture.store)
        const afterCreate = vi.fn(async (channel: ReattachedChannel) => {
          const close = await run(
            fixture.store.reserveInput(channel.recoveryId, { type: 'close' }, { kind: 'close' }),
          )
          await deliverWrittenInput(fixture.store, channel.recoveryId, close.sequence)
          vi.spyOn(fixture.store, 'readTransport').mockImplementationOnce((id) =>
            read(id).pipe(
              Effect.flatMap((snapshot) =>
                Effect.promise(async () => {
                  cleanupRead()
                  await run(Deferred.await(cleanup))
                  return snapshot
                }),
              ),
            ),
          )
          throw new Error('Fixture failed after the original close was allocated')
        })
        const { launched } = installLaunch(fixture, undefined, undefined, afterCreate)
        const opening = fixture.agents.models('codex')
        void opening.catch(() => {})
        try {
          await vi.waitFor(() => expect(cleanupRead).toHaveBeenCalledOnce())
          launched[0].isClosing = true
          launched[0].destroyed = true
          launched[0].emit('close')
          Deferred.doneUnsafe(cleanup, Effect.void)
          await expect(opening).rejects.toThrow(/after the original close was allocated/)
          const before = await run(fixture.store.readTransport(launched[0].recoveryId))
          expect(before.closeInputSequence).toBe(1)
          expect(before.outputs.some((output) => output.type === 'exit')).toBe(false)
          await fixture.agents.recover({ consumers: [] })
          expect(fixture.open).toHaveBeenCalledOnce()
          expect(fixture.open.mock.lastCall?.at(-1)).toMatchObject({
            snapshot: { transport: { id: before.transport.id }, closeInputSequence: 1 },
            deferRecoveryInputs: true,
          })
          const after = await run(fixture.store.readTransport(before.transport.id))
          expect(after.inputs).toEqual(before.inputs)
          expect(after.outputs).toEqual(before.outputs)
          expect(fixture.attachments[0].nativeWrites).toEqual([])
          expect(fixture.ssh.durableChannel).toHaveBeenCalledOnce()
          expect(fixture.ssh.channel).not.toHaveBeenCalled()
          expect(fixture.ssh.exec).not.toHaveBeenCalled()
        } finally {
          Deferred.doneUnsafe(cleanup, Effect.void)
          await opening.catch(() => {})
        }
      },
      false,
    )
  })

  it('joins an admitted metadata-only Codex acquisition before its opening callback and closes its original ownerless process once during suspension', async () => {
    await withFixture(
      'codex',
      async (fixture) => {
        const acquisition = Deferred.makeUnsafe<void>()
        const entered = vi.fn(async () => {
          await run(Deferred.await(acquisition))
        })
        const closing = vi.fn()
        const { launched, commands } = installLaunch(
          fixture,
          (channel) => {
            channel.closeAndWaitEffect = Effect.fn('tests.nativeRecoveryBoundary.catalogClose')(
              function* () {
                closing()
                channel.isClosing = true
                yield* Effect.promise(() => channel.registration)
                yield* Effect.promise(() => channel.inputTail)
                const close = yield* fixture.store.reserveInput(
                  channel.recoveryId,
                  { type: 'close' },
                  { kind: 'close' },
                )
                yield* Effect.promise(() => channel.confirmWritten(close.sequence))
                yield* Effect.promise(() => channel.nativeExit())
                return true
              },
            )
          },
          entered,
        )
        const catalog = fixture.agents.models('codex')
        const catalogSettled = catalog.then(
          () => undefined,
          () => undefined,
        )
        await vi.waitFor(() => expect(entered).toHaveBeenCalledOnce())
        expect(launched).toEqual([])
        fixture.agents.suspendRendererConsumers()
        let flushed = false
        let released = false
        const flushing = fixture.agents.flushRecovery().then(() => {
          flushed = true
        })
        const releasing = fixture.agents.releaseIdleProviders().then((value) => {
          released = true
          return value
        })
        try {
          await new Promise<void>((resolve) => setImmediate(resolve))
          expect(flushed).toBe(false)
          expect(released).toBe(false)
          expect(launched).toEqual([])
          expect(await run(fixture.store.listTransports())).toEqual([])
          Deferred.doneUnsafe(acquisition, Effect.void)
          await flushing
          await expect(releasing).resolves.toContain(true)
          await catalogSettled
          expect(flushed).toBe(true)
          expect(released).toBe(true)
          expect(closing).toHaveBeenCalledOnce()
          expect(launched).toHaveLength(1)
          const snapshots = await run(fixture.store.listTransports())
          expect(snapshots).toHaveLength(1)
          expect(snapshots[0].transport.owners).toEqual([])
          expect(snapshots[0].inputs.filter((input) => input.frame.type === 'close')).toHaveLength(
            1,
          )
          expect(snapshots[0].outputs.filter((output) => output.type === 'exit')).toEqual([
            expect.objectContaining({ nativeExitConfirmed: true }),
          ])
          expect(
            snapshots[0].inputs.some((input) =>
              ['user-prompt', 'steer', 'settings', 'permission-response'].includes(
                input.semantic.kind,
              ),
            ),
          ).toBe(false)
          expect(
            launched[0].nativeWrites.some(({ message }) =>
              ['thread/start', 'thread/resume', 'turn/start'].includes(String(message.method)),
            ),
          ).toBe(false)
          const settled = snapshots[0].inputs
          await expect(fixture.agents.models('codex')).rejects.toThrow(
            /recover|suspension|disabled/i,
          )
          await fixture.agents.flushRecovery()
          await fixture.agents.releaseIdleProviders()
          expect(closing).toHaveBeenCalledOnce()
          expect(
            (await run(fixture.store.listTransports())).map((snapshot) => snapshot.inputs),
          ).toEqual([settled])
          expect(commands).toHaveLength(1)
          expect(entered).toHaveBeenCalledOnce()
          expect(fixture.ssh.channel).not.toHaveBeenCalled()
          expect(fixture.ssh.exec).not.toHaveBeenCalled()
        } finally {
          Deferred.doneUnsafe(acquisition, Effect.void)
          await catalogSettled
          await flushing
          await releasing
        }
      },
      false,
    )
  })

  it.each([
    ['codex', 19],
    ['codex', '19'],
    ['claude', 'opaque\\permission:\r\n雪\ud800'],
  ] as const)(
    'binds a reused %s native permission ID %j to its new prompt occurrence after answered cold replay',
    async (provider, wireId) => {
      await withFixture(
        provider,
        async (fixture) => {
          // Stand-in protocol input deliberately reuses an opaque ID; this is
          // reducer/WAL coverage, not a claim about authenticated CLI behavior.
          const originalOwner = owner(provider)
          if (!originalOwner.input) throw new Error('Expected original input')
          const cleanInput = { ...originalOwner.input }
          delete cleanInput.providerOptions
          const root = { ...originalOwner, input: cleanInput }
          await run(fixture.store.createTransport({ ...fixture.transport, owners: [root] }))
          await admitOriginalPrompt(fixture)
          await appendMessages(fixture, [permission(provider, wireId)])
          const first = await fixture.agents.recover({ consumers: [consumer()] })
          const requestId = localRequestId(provider, wireId)
          expect(first.owners[0].pending?.map((event) => event.requestId)).toEqual([requestId])
          await fixture.agents.respond('life-session', requestId, true)
          const answered = await run(fixture.store.readTransport(fixture.transport.id))
          const originalResponse = answered.inputs.find(
            (input) => input.semantic.kind === 'permission-response',
          )!
          expect(originalResponse.semantic).toMatchObject({
            ownerGeneration: 3,
            permissionRequestId: wireId,
          })
          await run(fixture.store.acknowledgeInput(fixture.transport.id, originalResponse.sequence))
          await fixture.attachments[0].reply(
            provider === 'codex'
              ? {
                  method: 'turn/completed',
                  params: { threadId: nativeThread, turn: { id: nativeTurn, status: 'completed' } },
                }
              : {
                  type: 'result',
                  session_id: nativeThread,
                  subtype: 'success',
                  is_error: false,
                  result: exactReply,
                },
          )
          await fixture.agents.flushRecovery()
          await fixture.agents.detach()
          const nextEvents: AgentEvent[] = []
          const nextAgents = new Agents(
            fixture.ssh,
            (event) => {
              nextEvents.push(event)
            },
            fixture.store,
          )
          try {
            const cold = await nextAgents.recover({ consumers: [consumer()] })
            expect(cold.owners[0]).toMatchObject({ status: 'idle', remoteId: nativeThread })
            expect(cold.owners[0].pending || []).toEqual([])
            await expect(nextAgents.respond('life-session', requestId, true)).rejects.toThrow(
              /no longer pending/,
            )
            const channel = fixture.attachments[1]
            channel.autoReply = true
            if (provider === 'claude') installClaudeMetadata(fixture)
            const input = nextInput(provider)
            await nextAgents.start(input)
            await channel.inputTail
            await channel.outputTail
            const nextAllocated = await run(fixture.store.readTransport(fixture.transport.id))
            await run(
              fixture.store.acknowledgeInput(
                fixture.transport.id,
                nextAllocated.allocatedInputSequence,
              ),
            )
            const newPrompt = channel.nativeWrites.filter(
              ({ semantic }) => semantic.kind === 'user-prompt',
            )
            expect(newPrompt).toHaveLength(1)
            expect(newPrompt[0].semantic).toMatchObject({
              sessionId: 'life-session',
              ownerGeneration: 4,
              nativeThreadId: nativeThread,
            })
            const nextTurn =
              provider === 'codex' ? `turn-next-${newPrompt[0].message.id}` : undefined
            const newPermission = permission(provider, wireId)
            const newParams: Record<string, unknown> =
              provider === 'codex'
                ? {
                    ...newPermission.params,
                    turnId: nextTurn,
                    itemId: 'native-command-next-occurrence',
                    command: 'printf "new occurrence 雪"',
                  }
                : {
                    ...newPermission.request,
                    tool_use_id: 'native-command-next-occurrence',
                    input: {
                      command: 'printf "new occurrence 雪"',
                      exact: '\ud800',
                      values: [false, null],
                    },
                  }
            const liveStart = nextEvents.length
            await channel.reply({
              ...newPermission,
              ...(provider === 'codex' ? { params: newParams } : { request: newParams }),
            })
            await nextAgents.flushRecovery()
            const liveApproval = nextEvents
              .slice(liveStart)
              .filter((event) => event.type === 'approval')
            expect(liveApproval).toHaveLength(1)
            const nextRequestId = liveApproval[0].requestId!
            expect(nextRequestId).toBeTruthy()
            expect(nextRequestId).not.toBe(requestId)
            expect(liveApproval[0]).toMatchObject({
              requestId: nextRequestId,
              details: newParams,
              nativeRecovery: { ownerGeneration: 4 },
            })
            await nextAgents.detach()
            const replayed: AgentEvent[] = []
            const coldAgents = new Agents(
              fixture.ssh,
              (event) => {
                replayed.push(event)
              },
              fixture.store,
            )
            try {
              const recovered = await coldAgents.recover({ consumers: [consumer()] })
              expect(recovered.owners[0].message).toBeUndefined()
              expect(recovered.owners[0]).toMatchObject({
                status: 'running',
                remoteId: nativeThread,
              })
              expect(recovered.owners[0].pending).toEqual([
                expect.objectContaining({
                  requestId: nextRequestId,
                  details: expect.objectContaining(newParams),
                }),
              ])
              expect(
                replayed.filter(
                  (event) =>
                    event.type === 'approval' && event.nativeRecovery?.ownerGeneration === 4,
                ),
              ).toEqual([
                expect.objectContaining({
                  requestId: nextRequestId,
                  details: expect.objectContaining(newParams),
                }),
              ])
              const replyChannel = fixture.attachments[2]
              expect(replyChannel.nativeWrites).toEqual([])
              await expect(coldAgents.respond('life-session', requestId, true)).rejects.toThrow(
                /no longer pending/,
              )
              expect(replyChannel.nativeWrites).toEqual([])
              await coldAgents.respond('life-session', nextRequestId, true)
              expect(replyChannel.nativeWrites).toHaveLength(1)
              const nativeResponse = replyChannel.nativeWrites[0]
              expect(nativeResponse.semantic).toMatchObject({
                kind: 'permission-response',
                permissionRequestId: wireId,
                ownerGeneration: 4,
                nativeThreadId: nativeThread,
                responseBinding: {
                  requestId: nextRequestId,
                  params: newParams,
                  status: 'approved',
                },
              })
              const nativeId =
                provider === 'codex'
                  ? nativeResponse.message.id
                  : (nativeResponse.message.response as Record<string, unknown>).request_id
              expect(nativeId).toBe(wireId)
              expect(typeof nativeId).toBe(typeof wireId)
              expect(nativeResponse.message).toEqual(
                provider === 'codex'
                  ? { id: wireId, result: { decision: 'accept' } }
                  : {
                      type: 'control_response',
                      response: {
                        subtype: 'success',
                        request_id: wireId,
                        response: { behavior: 'allow', updatedInput: newParams.input },
                      },
                    },
              )
              await expect(coldAgents.respond('life-session', nextRequestId, true)).rejects.toThrow(
                /no longer pending/,
              )
              expect(replyChannel.nativeWrites).toHaveLength(1)
              const settled = await run(fixture.store.readTransport(fixture.transport.id))
              expect(
                settled.inputs.find((value) => value.sequence === originalResponse.sequence),
              ).toEqual({ ...originalResponse, acknowledged: true, consumed: true })
              expect(
                settled.inputs
                  .filter((value) => value.semantic.kind === 'permission-response')
                  .map((value) => value.semantic.ownerGeneration),
              ).toEqual([3, 4])
              expect(
                settled.inputs
                  .filter((value) => value.semantic.kind === 'user-prompt')
                  .map(decodeInput),
              ).toMatchObject(
                provider === 'codex'
                  ? [
                      { params: { input: [{ text: exactPrompt }] } },
                      { params: { input: [{ text: input.prompt }] } },
                    ]
                  : [
                      { message: { content: exactPrompt } },
                      { message: { content: [{ text: input.prompt }] } },
                    ],
              )
              expect(
                settled.transport.owners.find((value) => value.generation === 4),
              ).toMatchObject(
                provider === 'codex'
                  ? { nativeThreadId: nativeThread, nativeTurnId: nextTurn }
                  : { nativeSessionId: nativeThread },
              )
              expect(fixture.ssh.durableChannel).toBeUndefined()
              expect(fixture.ssh.exec).not.toHaveBeenCalled()
              expect(generateTitle).not.toHaveBeenCalled()
            } finally {
              await coldAgents.detach()
            }
          } finally {
            await nextAgents.detach()
          }
        },
        false,
      )
    },
  )

  it.each(['codex', 'claude'] as const)(
    'retains a newer %s permission occurrence while the accepted original same-wire-ID response waits for its native write receipt',
    async (provider) => {
      await withFixture(provider, async (fixture) => {
        const wireId = provider === 'codex' ? 19 : 'same-opaque-claude-permission'
        await admitOriginalPrompt(fixture)
        const firstPermission = permission(provider, wireId)
        await appendMessages(fixture, [firstPermission])
        await fixture.agents.recover({ consumers: [consumer()] })
        const originalRequestId = localRequestId(provider, wireId)
        const channel = fixture.attachments[0]
        channel.heldInputReceipts.add('permission-response')
        let responseSettled = false
        let originalSequence: number | undefined
        const responding = fixture.agents
          .respond('life-session', originalRequestId, true)
          .finally(() => {
            responseSettled = true
          })
        try {
          await vi.waitFor(() => expect(channel.nativeWrites).toHaveLength(1))
          const admission = await run(fixture.store.readTransport(fixture.transport.id))
          originalSequence = admission.inputs.find(
            (input) => input.semantic.kind === 'permission-response',
          )!.sequence
          await run(fixture.store.acknowledgeInput(fixture.transport.id, originalSequence))
          const allocated = await run(fixture.store.readTransport(fixture.transport.id))
          const original = allocated.inputs.find(
            (input) => input.semantic.kind === 'permission-response',
          )!
          expect(original.acknowledged).toBe(true)
          expect(original.written).toBe(false)
          expect(original.consumed).toBe(false)
          expect(responseSettled).toBe(false)
          expect(
            fixture.events.filter(
              (event) => event.type === 'request-resolved' && event.requestId === originalRequestId,
            ),
          ).toEqual([])
          const newParams: Record<string, unknown> =
            provider === 'codex'
              ? {
                  ...firstPermission.params,
                  itemId: 'native-command-after-delayed-response',
                  command: 'printf "new while ACK is held 雪"',
                }
              : {
                  ...firstPermission.request,
                  tool_use_id: 'native-command-after-delayed-response',
                  input: { command: 'printf "new while ACK is held 雪"', exact: '\ud800' },
                }
          const liveStart = fixture.events.length
          await channel.reply({
            ...firstPermission,
            ...(provider === 'codex' ? { params: newParams } : { request: newParams }),
          })
          await fixture.agents.flushRecovery()
          const newApproval = fixture.events
            .slice(liveStart)
            .filter((event) => event.type === 'approval')
          expect(newApproval).toHaveLength(1)
          const nextRequestId = newApproval[0].requestId!
          expect(nextRequestId).toBeTruthy()
          expect(nextRequestId).not.toBe(originalRequestId)
          expect(newApproval[0]).toMatchObject({
            details: newParams,
            nativeRecovery: { ownerGeneration: 3 },
          })
          expect(channel.nativeWrites).toHaveLength(1)
          channel.heldInputReceipts.delete('permission-response')
          await channel.confirmWritten(original.sequence)
          await responding
          const resolvedOld = fixture.events.filter(
            (event) => event.type === 'request-resolved' && event.requestId === originalRequestId,
          )
          expect(resolvedOld).toHaveLength(1)
          expect(resolvedOld[0]).toMatchObject({ status: 'approved' })
          expect(
            fixture.events.filter(
              (event) => event.type === 'request-resolved' && event.requestId === nextRequestId,
            ),
          ).toEqual([])
          const recovered = await fixture.agents.recover({ consumers: [consumer()] })
          expect(recovered.owners[0].pending).toEqual([
            expect.objectContaining({
              requestId: nextRequestId,
              details: expect.objectContaining(newParams),
            }),
          ])
          await expect(
            fixture.agents.respond('life-session', originalRequestId, false),
          ).rejects.toThrow(/no longer pending/)
          expect(channel.nativeWrites).toHaveLength(1)
          await fixture.agents.respond('life-session', nextRequestId, true)
          await expect(fixture.agents.respond('life-session', nextRequestId, true)).rejects.toThrow(
            /no longer pending/,
          )
          const settled = await run(fixture.store.readTransport(fixture.transport.id))
          const responses = settled.inputs.filter(
            (input) => input.semantic.kind === 'permission-response',
          )
          expect(responses).toHaveLength(2)
          expect(responses[0]).toMatchObject({
            ...original,
            acknowledged: true,
            written: true,
            consumed: true,
            deliveryReceipt: { status: 'written' },
          })
          expect(responses[0].semantic.responseBinding).toMatchObject({
            requestId: originalRequestId,
            params: provider === 'codex' ? firstPermission.params : firstPermission.request,
          })
          expect(responses[1].semantic.responseBinding).toMatchObject({
            requestId: nextRequestId,
            params: newParams,
          })
          expect(responses.map((input) => input.semantic.permissionRequestId)).toEqual([
            wireId,
            wireId,
          ])
          expect(responses.map(decodeInput)).toEqual(
            provider === 'codex'
              ? [
                  { id: wireId, result: { decision: 'accept' } },
                  { id: wireId, result: { decision: 'accept' } },
                ]
              : [
                  {
                    type: 'control_response',
                    response: {
                      subtype: 'success',
                      request_id: wireId,
                      response: { behavior: 'allow', updatedInput: firstPermission.request!.input },
                    },
                  },
                  {
                    type: 'control_response',
                    response: {
                      subtype: 'success',
                      request_id: wireId,
                      response: { behavior: 'allow', updatedInput: newParams.input },
                    },
                  },
                ],
          )
          expect(
            fixture.events.filter(
              (event) => event.type === 'request-resolved' && event.requestId === nextRequestId,
            ),
          ).toHaveLength(1)
          expect(
            settled.inputs.filter((input) => input.semantic.kind === 'user-prompt'),
          ).toHaveLength(1)
          expect(fixture.ssh.channel).not.toHaveBeenCalled()
          expect(fixture.ssh.exec).not.toHaveBeenCalled()
        } finally {
          channel.heldInputReceipts.delete('permission-response')
          if (originalSequence) await channel.confirmWritten(originalSequence)
          await responding
        }
      })
    },
  )

  it('routes a defensive top-level Claude agent_id envelope without changing the root native identity or message block', async () => {
    await withFixture('claude', async (fixture) => {
      // Top-level-only agent_id is a synthetic compatibility boundary. The
      // installed native permission ABI carries agent_id inside request.
      await admitOriginalPrompt(fixture)
      const rootBefore = '  Root before child 🌍\r\n'
      const rootAfter = '  Root after child 雪\ud800  '
      const childText = '  Direct child output 🧭\r\n\ud800  '
      const rootStream = (event: unknown) => ({
        type: 'stream_event',
        session_id: nativeThread,
        event,
      })
      await appendMessages(fixture, [
        rootStream({ type: 'message_start', message: { id: 'native-root-owned' } }),
        rootStream({
          type: 'content_block_start',
          index: 0,
          content_block: { type: 'text', text: '' },
        }),
        rootStream({
          type: 'content_block_delta',
          index: 0,
          delta: { type: 'text_delta', text: rootBefore },
        }),
        permission('claude'),
      ])
      await fixture.agents.recover({ consumers: [consumer()] })
      const rootBlock = fixture.events.find(
        (event) => event.type === 'text' && event.text === rootBefore,
      )!
      expect(rootBlock).toMatchObject({ type: 'text' })
      expect(rootBlock.itemId).toBeTruthy()
      expect(rootBlock.agentId).toBeUndefined()
      const childId = 'direct-child-original'
      const childEnvelope = { session_id: 'foreign-child-session', agent_id: childId }
      const childStream = (event: unknown) => ({ type: 'stream_event', ...childEnvelope, event })
      const channel = fixture.attachments[0]
      await channel.reply(
        childStream({ type: 'message_start', message: { id: 'native-root-owned' } }),
      )
      await channel.reply(
        childStream({
          type: 'content_block_start',
          index: 0,
          content_block: { type: 'text', text: '' },
        }),
      )
      await channel.reply(
        childStream({
          type: 'content_block_delta',
          index: 0,
          delta: { type: 'text_delta', text: childText },
        }),
      )
      const control = {
        type: 'control_request',
        ...childEnvelope,
        request_id: 'direct-child-permission',
        request: {
          subtype: 'can_use_tool',
          tool_name: 'Bash',
          tool_use_id: 'direct-child-command',
          input: { command: 'printf "direct child 雪"', exact: '\ud800' },
        },
      }
      await channel.reply({ ...control, request_id: 'direct-child-completed-permission' })
      await channel.reply({
        type: 'result',
        ...childEnvelope,
        subtype: 'success',
        is_error: false,
        result: childText,
      })
      await channel.reply(control)
      await channel.reply(
        rootStream({
          type: 'content_block_delta',
          index: 0,
          delta: { type: 'text_delta', text: rootAfter },
        }),
      )
      await fixture.agents.flushRecovery()
      expect(
        fixture.events.filter((event) => event.type === 'text' && event.agentId === childId),
      ).toEqual([
        expect.objectContaining({ text: childText, agentId: childId, itemId: expect.any(String) }),
      ])
      const childBlock = fixture.events.find(
        (event) => event.type === 'text' && event.agentId === childId,
      )!
      expect(childBlock.itemId).toBe(rootBlock.itemId)
      expect(
        fixture.events.find((event) => event.type === 'text' && event.text === rootAfter),
      ).toMatchObject({ itemId: rootBlock.itemId })
      expect(
        fixture.events.find((event) => event.type === 'text' && event.text === rootAfter)?.agentId,
      ).toBeUndefined()
      expect(
        fixture.events.filter((event) => event.type === 'subagent' && event.agentId === childId),
      ).toContainEqual(expect.objectContaining({ status: 'completed', text: childText }))
      expect(
        fixture.events.filter(
          (event) => ['complete', 'error'].includes(event.type) && !event.agentId,
        ),
      ).toEqual([])
      const recovered = await fixture.agents.recover({ consumers: [consumer()] })
      expect(recovered.owners[0]).toMatchObject({ status: 'running', remoteId: nativeThread })
      expect(recovered.owners[0].pending).toEqual([
        expect.objectContaining({
          requestId: localRequestId('claude'),
          details: permission('claude').request,
        }),
        expect.objectContaining({
          requestId: control.request_id,
          agentId: childId,
          details: control.request,
        }),
      ])
      const childResolved = fixture.events.filter(
        (event) =>
          event.type === 'request-resolved' &&
          event.requestId === 'direct-child-completed-permission',
      )
      expect([
        ...new Map(childResolved.map((event) => [event.nativeRecovery?.eventId, event])).values(),
      ]).toEqual([expect.objectContaining({ status: 'provider-resolved', agentId: childId })])
      expect(
        fixture.events.filter(
          (event) =>
            event.type === 'request-resolved' && event.requestId === localRequestId('claude'),
        ),
      ).toEqual([])
      expect(fixture.agents.hasRunningSessions()).toBe(true)
      await fixture.agents.respond('life-session', control.request_id, true)
      expect(channel.nativeWrites).toEqual([
        expect.objectContaining({
          message: {
            type: 'control_response',
            response: {
              subtype: 'success',
              request_id: control.request_id,
              response: { behavior: 'allow', updatedInput: control.request.input },
            },
          },
          semantic: expect.objectContaining({
            kind: 'permission-response',
            nativeThreadId: nativeThread,
            responseBinding: expect.objectContaining({
              params: { ...control.request, agent_id: childId },
            }),
          }),
        }),
      ])
      await expect(
        fixture.agents.respond('life-session', control.request_id, true),
      ).rejects.toThrow(/no longer pending/)
      const stillRunning = await fixture.agents.recover({ consumers: [consumer()] })
      expect(stillRunning.owners[0].pending?.map((event) => event.requestId)).toEqual([
        localRequestId('claude'),
      ])
      const rootText = fixture.events.filter((event) => event.type === 'text' && !event.agentId)
      await channel.reply({
        type: 'result',
        session_id: nativeThread,
        subtype: 'success',
        is_error: false,
        result: rootBefore + rootAfter,
      })
      await fixture.agents.flushRecovery()
      expect(fixture.events.filter((event) => event.type === 'text' && !event.agentId)).toEqual(
        rootText,
      )
      expect(fixture.events.filter((event) => event.type === 'complete' && !event.agentId)).toEqual(
        [expect.objectContaining({ status: 'completed' })],
      )
      const settled = await run(fixture.store.readTransport(fixture.transport.id))
      expect(settled.transport.owners.find((value) => value.kind === 'root')).toMatchObject({
        nativeSessionId: nativeThread,
      })
      expect(settled.inputs.filter((value) => value.semantic.kind === 'user-prompt')).toHaveLength(
        1,
      )
      expect(
        fixture.events.filter((event) => event.type === 'session').map((event) => event.remoteId),
      ).not.toContain('foreign-child-session')
      expect(fixture.ssh.channel).not.toHaveBeenCalled()
      expect(fixture.ssh.exec).not.toHaveBeenCalled()
    })
  })
  it.each(['codex', 'claude'] as const)(
    'admits a healthy %s renderer handoff with durably owned root, child and pending permissions, while refusing a closing writer',
    async (provider) => {
      await withFixture(provider, async (fixture) => {
        await seedActiveGraph(fixture)
        const recovered = await fixture.agents.recover({ consumers: [consumer()] })
        expect(recovered.owners[0]).toMatchObject({ status: 'running', remoteId: nativeThread })
        expect(recovered.owners[0].currentChildren).toEqual([
          expect.objectContaining({
            type: 'subagent',
            agentId: 'native-child-original',
            status: 'running',
          }),
        ])
        expect(recovered.owners[0].pending?.map((event) => event.requestId)).toEqual([
          localRequestId(provider),
          localRequestId(provider, 'native-child-permission-original'),
        ])
        const before = await run(fixture.store.readTransport(fixture.transport.id))
        expect(fixture.agents.hasRunningSessions()).toBe(true)
        expect(fixture.agents.hasUntrackedRunningSessions()).toBe(false)
        await expect(fixture.agents.rendererHandoffAdmitted()).resolves.toBe(true)
        const channel = fixture.attachments[0]
        channel.isClosing = true
        expect(fixture.agents.hasUntrackedRunningSessions()).toBe(true)
        await expect(fixture.agents.rendererHandoffAdmitted()).resolves.toBe(false)
        channel.isClosing = false
        await expect(fixture.agents.rendererHandoffAdmitted()).resolves.toBe(true)
        const after = await run(fixture.store.readTransport(fixture.transport.id))
        expect(after.inputs).toEqual(before.inputs)
        expect(after.outputs).toEqual(before.outputs)
        expect(channel.nativeWrites).toEqual([])
        expect(channel.rawWrites).toEqual([])
        expect(channel.signal).not.toHaveBeenCalled()
        expect(channel.close).not.toHaveBeenCalled()
        expect(fixture.open).toHaveBeenCalledOnce()
        expect(fixture.ssh.channel).not.toHaveBeenCalled()
        expect(fixture.ssh.exec).not.toHaveBeenCalled()
      })
    },
  )

  it.each(['codex', 'claude'] as const)(
    'refuses a %s renderer handoff when an unconfirmed cleanup notice is durable before the live adapter observes it',
    async (provider) => {
      await withFixture(provider, async (fixture) => {
        await seedActiveGraph(fixture)
        await fixture.agents.recover({ consumers: [consumer()] })
        await expect(fixture.agents.rendererHandoffAdmitted()).resolves.toBe(true)
        const before = await run(fixture.store.readTransport(fixture.transport.id))
        await run(
          fixture.store.appendOutputs(fixture.transport.id, [
            {
              type: 'exit',
              cursor: before.outputCursor + 1,
              code: 0,
              nativeExitConfirmed: false,
            },
          ]),
        )
        expect(fixture.agents.hasUntrackedRunningSessions()).toBe(false)
        await expect(fixture.agents.rendererHandoffAdmitted()).resolves.toBe(false)
        expect(fixture.agents.hasRunningSessions()).toBe(true)
        expect((await run(fixture.store.readTransport(fixture.transport.id))).inputs).toEqual(
          before.inputs,
        )
        expect(fixture.attachments[0].nativeWrites).toEqual([])
        expect(fixture.attachments[0].rawWrites).toEqual([])
        expect(fixture.attachments[0].signal).not.toHaveBeenCalled()
        expect(fixture.attachments[0].close).not.toHaveBeenCalled()
      })
    },
  )

  it.each(['codex', 'claude'] as const)(
    'refuses a renderer handoff for an active legacy %s session without a private recovery registry',
    async (provider) => {
      await withFixture(
        provider,
        async (fixture) => {
          const writes: Record<string, any>[] = []
          const channel = Object.assign(new EventEmitter(), {
            stderr: new EventEmitter(),
            destroyed: false,
            signal: vi.fn(),
            close: vi.fn(),
            end: vi.fn(),
            write(raw: string) {
              const message = JSON.parse(raw)
              writes.push(message)
              queueMicrotask(() => {
                if (message.type === 'control_request')
                  channel.emit(
                    'data',
                    Buffer.from(
                      JSON.stringify({
                        type: 'control_response',
                        response: {
                          subtype: 'success',
                          request_id: message.request_id,
                          response: {},
                        },
                      }) + '\n',
                    ),
                  )
                else if (typeof message.id === 'number' && message.method) {
                  const results: Record<string, unknown> = {
                    initialize: {},
                    'thread/resume': { thread: { id: nativeThread } },
                    'turn/start': { turn: { id: nativeTurn } },
                  }
                  channel.emit(
                    'data',
                    Buffer.from(
                      JSON.stringify({ id: message.id, result: results[message.method] || {} }) +
                        '\n',
                    ),
                  )
                }
              })
              return true
            },
          })
          fixture.ssh.channel = vi.fn(async () => channel as unknown as ClientChannel)
          const legacy = new Agents(fixture.ssh, () => {})
          try {
            await legacy.start(nextInput(provider))
            const count = writes.length
            expect(legacy.hasRunningSessions()).toBe(true)
            expect(legacy.hasUntrackedRunningSessions()).toBe(true)
            await expect(legacy.rendererHandoffAdmitted()).resolves.toBe(false)
            expect(writes).toHaveLength(count)
            expect(channel.signal).not.toHaveBeenCalled()
            expect(channel.close).not.toHaveBeenCalled()
            expect(fixture.open).not.toHaveBeenCalled()
            expect(fixture.ssh.exec).not.toHaveBeenCalled()
          } finally {
            legacy.close('Fixture cleanup after verifying the rejected handoff')
          }
        },
        false,
      )
    },
  )

  it.each([
    ['codex', false],
    ['codex', true],
    ['claude', false],
    ['claude', true],
  ] as const)(
    'preserves a busy %s root, children and permissions after an unconfirmed cleanup exit (close allocated: %s)',
    async (provider, closeAllocated) => {
      await withFixture(provider, async (fixture) => {
        const before = await seedUnconfirmedTerminal(fixture, closeAllocated)
        const { launched } = installLaunch(fixture)
        const recovered = await fixture.agents.recover({ consumers: [consumer()] })
        expect(recovered.owners[0]).toMatchObject({
          status: 'unknown',
          provider,
          remoteId: nativeThread,
          originalInput: { prompt: exactPrompt, workspace: '/project' },
        })
        expect(fixture.agents.hasRunningSessions()).toBe(true)
        expect(fixture.agents.hasUntrackedRunningSessions()).toBe(true)
        await expect(fixture.agents.rendererHandoffAdmitted()).resolves.toBe(false)
        expect(fixture.agents.runningSessionEvents()).toContainEqual(
          expect.objectContaining({ sessionId: 'life-session', type: 'status', status: 'running' }),
        )
        if (provider === 'codex')
          expect(fixture.agents.runningSessionEvents()).toContainEqual(
            expect.objectContaining({
              type: 'subagent',
              agentId: 'native-child-original',
              status: 'running',
            }),
          )
        expect(fixture.events).toContainEqual(
          expect.objectContaining({ type: 'subagent', status: 'running' }),
        )
        expect(
          fixture.events
            .filter((event) => event.type === 'approval')
            .map((event) => event.requestId),
        ).toEqual([
          localRequestId(provider),
          localRequestId(provider, 'native-child-permission-original'),
        ])
        expect(
          fixture.events.filter(
            (event) =>
              ['complete', 'error', 'request-resolved'].includes(event.type) ||
              (event.type === 'subagent' &&
                ['completed', 'failed', 'interrupted'].includes(event.status || '')),
          ),
        ).toEqual([])
        await expect(fixture.agents.start(nextInput(provider))).rejects.toThrow(
          /native.*termination|unknown|recover|reconstruct|closing|exact delivery|processing proof|read.only/i,
        )
        await expect(fixture.agents.stop('life-session')).rejects.toThrow(
          /native.*termination|unknown|recover|reconstruct|closing|exact delivery|processing proof|read.only/i,
        )
        await expect(
          fixture.agents.respond('life-session', localRequestId(provider), true),
        ).rejects.toThrow(
          /native.*termination|unknown|recover|reconstruct|closing|exact delivery|processing proof|read.only/i,
        )
        await fixture.agents.releaseIdleProviders()
        expect(launched).toEqual([])
        expect(fixture.ssh.channel).not.toHaveBeenCalled()
        expect(fixture.ssh.exec).not.toHaveBeenCalled()
        for (const channel of fixture.attachments) {
          expect(channel.nativeWrites).toEqual([])
          expect(channel.rawWrites).toEqual([])
          expect(channel.signal).not.toHaveBeenCalled()
          expect(channel.close).not.toHaveBeenCalled()
          expect(channel.activateRecoveryInputs).not.toHaveBeenCalled()
        }
        const after = await run(fixture.store.readTransport(fixture.transport.id))
        expect(after.inputs).toEqual(before.inputs)
        expect(after.outputs).toEqual(before.outputs)
        expect(after.outputs.at(-1)).toMatchObject({
          type: 'exit',
          code: 0,
          nativeExitConfirmed: false,
        })
        expect(
          after.events
            .filter((event) => event.event.type === 'approval')
            .map((event) => event.event.requestId),
        ).toEqual([
          localRequestId(provider),
          localRequestId(provider, 'native-child-permission-original'),
        ])
        expect(generateTitle).not.toHaveBeenCalled()
      })
    },
  )

  it.each([
    ['codex', 'explicit true'],
    ['codex', 'legacy compatibility assumption'],
    ['claude', 'explicit true'],
    ['claude', 'legacy compatibility assumption'],
  ] as const)(
    'reduces the later %s terminal record under %s after an earlier unconfirmed cleanup notice',
    async (provider, confirmation) => {
      await withFixture(provider, async (fixture) => {
        const before = await seedUnconfirmedTerminal(fixture, true)
        const unknown = await fixture.agents.recover({ consumers: [consumer()] })
        expect(unknown.owners[0].status).toBe('unknown')
        expect(fixture.agents.hasRunningSessions()).toBe(true)
        await fixture.agents.detach()
        const count = fixture.open.mock.calls.length
        await run(
          fixture.store.appendOutputs(fixture.transport.id, [
            {
              type: 'exit',
              cursor: before.outputCursor + 1,
              code: 0,
              ...(confirmation === 'explicit true' ? { nativeExitConfirmed: true } : {}),
            },
          ]),
        )
        const events: AgentEvent[] = []
        const reopened = new Agents(
          fixture.ssh,
          (event) => {
            events.push(event)
          },
          fixture.store,
        )
        try {
          const recovered = await reopened.recover({ consumers: [consumer()] })
          expect(recovered.owners[0]).toMatchObject({
            status: 'idle',
            remoteId: nativeThread,
            pending: [],
          })
          expect(reopened.hasRunningSessions()).toBe(false)
          expect(reopened.runningSessionEvents()).toEqual([])
          expect(fixture.open).toHaveBeenCalledTimes(count)
          const after = await run(fixture.store.readTransport(fixture.transport.id))
          expect(after.inputs).toEqual(before.inputs)
          expect(after.outputs.slice(0, before.outputs.length)).toEqual(before.outputs)
          if (confirmation === 'explicit true')
            expect(after.outputs.at(-1)).toMatchObject({ type: 'exit', nativeExitConfirmed: true })
          else
            // Missing fields are admitted under the recorded legacy contract.
            // This fixture makes no PID-observation claim about those old bytes.
            expect(after.outputs.at(-1)).not.toHaveProperty('nativeExitConfirmed')
          expect(
            events
              .filter((event) => event.type === 'request-resolved')
              .map((event) => ({
                requestId: event.requestId,
                status: event.status,
              })),
          ).toEqual([
            {
              requestId: localRequestId(provider),
              status: provider === 'codex' ? 'cancelled' : 'provider-resolved',
            },
            {
              requestId: localRequestId(provider, 'native-child-permission-original'),
              status: provider === 'codex' ? 'cancelled' : 'provider-resolved',
            },
          ])
          expect(events).toContainEqual(
            expect.objectContaining({
              type: 'subagent',
              agentId: 'native-child-original',
              status: 'failed',
            }),
          )
          expect(
            events.filter((event) => event.type === 'approval').map((event) => event.requestId),
          ).toEqual([
            localRequestId(provider),
            localRequestId(provider, 'native-child-permission-original'),
          ])
          for (const channel of fixture.attachments) {
            expect(channel.nativeWrites).toEqual([])
            expect(channel.rawWrites).toEqual([])
            expect(channel.signal).not.toHaveBeenCalled()
            expect(channel.close).not.toHaveBeenCalled()
          }
          expect(fixture.ssh.channel).not.toHaveBeenCalled()
          expect(fixture.ssh.exec).not.toHaveBeenCalled()
          expect(generateTitle).not.toHaveBeenCalled()
        } finally {
          await reopened.detach()
        }
      })
    },
  )

  it.each(['codex', 'claude'] as const)(
    'keeps an already confirmed %s terminal state when a later cleanup notice has nativeExitConfirmed:false',
    async (provider) => {
      await withFixture(provider, async (fixture) => {
        const unconfirmed = await seedUnconfirmedTerminal(fixture, true)
        await run(
          fixture.store.appendOutputs(fixture.transport.id, [
            {
              type: 'exit',
              cursor: unconfirmed.outputCursor + 1,
              code: 0,
              nativeExitConfirmed: true,
            },
            {
              type: 'exit',
              cursor: unconfirmed.outputCursor + 2,
              code: 0,
              nativeExitConfirmed: false,
            },
          ]),
        )
        const before = await run(fixture.store.readTransport(fixture.transport.id))
        const { launched } = installLaunch(fixture)
        const recovered = await fixture.agents.recover({ consumers: [consumer()] })
        expect(recovered.owners[0]).toMatchObject({
          status: 'idle',
          remoteId: nativeThread,
          pending: [],
        })
        expect(fixture.agents.hasRunningSessions()).toBe(false)
        expect(fixture.agents.runningSessionEvents()).toEqual([])
        expect(fixture.events.filter((event) => event.type === 'error')).toHaveLength(1)
        expect(fixture.events.filter((event) => event.type === 'request-resolved')).toHaveLength(2)
        expect(fixture.open).not.toHaveBeenCalled()
        expect(launched).toEqual([])
        const after = await run(fixture.store.readTransport(fixture.transport.id))
        expect(after.inputs).toEqual(before.inputs)
        expect(after.outputs).toEqual(before.outputs)
        expect(after.outputs.at(-1)).toMatchObject({ type: 'exit', nativeExitConfirmed: false })
        expect(fixture.ssh.channel).not.toHaveBeenCalled()
        expect(fixture.ssh.exec).not.toHaveBeenCalled()
        expect(generateTitle).not.toHaveBeenCalled()
      })
    },
  )

  it.each(['codex', 'claude'] as const)(
    'replays the missed %s snapshot event before a later live event and serializes concurrent recover admissions',
    async (provider) => {
      await withFixture(provider, async (fixture) => {
        await admitOriginalPrompt(fixture)
        await fixture.agents.recover({ consumers: [consumer()] })
        const channel = fixture.attachments[0]
        const delta = (text: string) =>
          provider === 'codex'
            ? {
                method: 'item/agentMessage/delta',
                params: {
                  threadId: nativeThread,
                  turnId: nativeTurn,
                  itemId: 'native-answer',
                  delta: text,
                },
              }
            : {
                type: 'stream_event',
                session_id: nativeThread,
                event: {
                  type: 'content_block_delta',
                  index: 0,
                  delta: { type: 'text_delta', text },
                },
              }
        if (provider === 'codex') await channel.reply(delta('Previously visible'))
        else
          await channel.reply({
            type: 'stream_event',
            session_id: nativeThread,
            event: { type: 'message_start', message: { id: 'native-answer' } },
          })
        await fixture.agents.flushRecovery()
        expect((await run(fixture.store.readTransport(fixture.transport.id))).eventRevision).toBe(1)
        fixture.agents.pauseRendererRecovery()
        fixture.events.length = 0
        const missedText = '  Missed snapshot\r\n🌍\ud800  '
        const lateText = '  Later live tail\r\n🌍\ud800  '
        await channel.reply(delta(missedText))
        await fixture.agents.flushRecovery()
        const missed = await run(fixture.store.readTransport(fixture.transport.id))
        expect(missed.eventRevision).toBe(2)
        const missedEvent = missed.events.find((event) => event.event.text === missedText)!
        expect(missedEvent.revision).toBe(2)
        expect(fixture.events).toEqual([])

        const entered = Deferred.makeUnsafe<void>()
        const release = Deferred.makeUnsafe<void>()
        const secondReplayRelease = Deferred.makeUnsafe<void>()
        const list = fixture.store.listTransports.bind(fixture.store)
        let listCalls = 0
        let captured: readonly NativeRecoverySnapshot[] | undefined
        const held = vi.spyOn(fixture.store, 'listTransports').mockImplementation(() =>
          Effect.gen(function* () {
            const snapshots = yield* list()
            listCalls++
            if (listCalls === 2) {
              // The production store has already returned its immutable JSON copies.
              // Hold that exact cutoff, rather than delaying the disk read itself.
              captured = snapshots
              Deferred.doneUnsafe(entered, Effect.void)
              yield* Deferred.await(release)
            }
            if (listCalls === 3) yield* Deferred.await(secondReplayRelease)
            return snapshots
          }),
        )
        const first = fixture.agents.recover({ consumers: [consumer()] })
        let second: ReturnType<Agents['recover']> | undefined
        try {
          await Effect.runPromise(Deferred.await(entered))
          expect(
            captured?.find((snapshot) => snapshot.transport.id === fixture.transport.id)
              ?.eventRevision,
          ).toBe(2)
          await channel.reply(delta(lateText))
          await fixture.agents.flushRecovery()
          const live = await run(fixture.store.readTransport(fixture.transport.id))
          expect(live.eventRevision).toBe(3)
          const lateEvent = live.events.find((event) => event.event.text === lateText)!
          expect(lateEvent.revision).toBe(3)
          expect(
            captured?.find((snapshot) => snapshot.transport.id === fixture.transport.id)
              ?.eventRevision,
          ).toBe(2)
          expect(fixture.events).toEqual([])
          second = fixture.agents.recover({ consumers: [consumer()] })
          await new Promise<void>((resolve) => setImmediate(resolve))
          expect(listCalls).toBe(2)
          expect(fixture.events).toEqual([])
          Deferred.doneUnsafe(release, Effect.void)
          const firstResult = await first
          expect(firstResult.owners[0].throughEventRevision).toBe(2)
          const beforeReply = fixture.events.filter(
            (event) => event.text === missedText || event.text === lateText,
          )
          expect(
            [
              ...new Map(
                beforeReply.map((event) => [event.nativeRecovery!.eventId, event]),
              ).values(),
            ].map((event) => ({ text: event.text, revision: event.nativeRecovery!.revision })),
          ).toEqual([
            { text: missedText, revision: 2 },
            { text: lateText, revision: 3 },
          ])
          Deferred.doneUnsafe(secondReplayRelease, Effect.void)
          await second
          const delivered = fixture.events.filter(
            (event) => event.text === missedText || event.text === lateText,
          )
          const unique = [
            ...new Map(delivered.map((event) => [event.nativeRecovery!.eventId, event])).values(),
          ]
          expect(
            unique.map((event) => ({
              text: event.text,
              revision: event.nativeRecovery!.revision,
              eventId: event.nativeRecovery!.eventId,
            })),
          ).toEqual([
            { text: missedText, revision: 2, eventId: missedEvent.eventId },
            { text: lateText, revision: 3, eventId: lateEvent.eventId },
          ])
          expect(
            delivered.every(
              (event) =>
                event.nativeRecovery!.eventId ===
                (event.text === missedText ? missedEvent.eventId : lateEvent.eventId),
            ),
          ).toBe(true)
          const final = await run(fixture.store.readTransport(fixture.transport.id))
          expect(final.events.find((event) => event.eventId === lateEvent.eventId)).toEqual(
            lateEvent,
          )
          expect(final.inputs).toEqual(missed.inputs)
          expect(fixture.open).toHaveBeenCalledOnce()
          expect(channel.nativeWrites).toEqual([])
          expect(channel.rawWrites).toEqual([])
        } finally {
          Deferred.doneUnsafe(release, Effect.void)
          Deferred.doneUnsafe(secondReplayRelease, Effect.void)
          await first
          await second
          held.mockRestore()
        }
      })
    },
  )

  it.each(['codex', 'claude'] as const)(
    'refreshes one stale %s attachment cutoff while preserving the original permission and transport',
    async (provider) => {
      await withFixture(provider, async (fixture) => {
        await admitOriginalPrompt(fixture)
        await appendMessages(fixture, [permission(provider)])
        const before = await run(fixture.store.readTransport(fixture.transport.id))
        fixture.open.mockImplementationOnce(async (...args) => {
          await run(
            fixture.store.appendOutputs(fixture.transport.id, [
              { type: 'stderr', cursor: before.outputCursor + 1, data: encoded('checkpoint race') },
            ]),
          )
          return originalDurableOpen(...args)
        })
        const recovered = await fixture.agents.recover({ consumers: [consumer()] })
        expect(recovered.owners[0]).toMatchObject({
          status: 'running',
          remoteId: nativeThread,
          pending: [{ requestId: localRequestId(provider) }],
        })
        expect(fixture.open).toHaveBeenCalledTimes(2)
        expect(fixture.attachments).toHaveLength(1)
        expect(fixture.attachments[0].nativeWrites).toEqual([])
        expect(fixture.attachments[0].rawWrites).toEqual([])
        const after = await run(fixture.store.readTransport(fixture.transport.id))
        const retry = fixture.open.mock.calls[1]
        const retryOptions = typeof retry[2] === 'function' ? retry[3] : retry[2]
        expect(retryOptions?.snapshot?.transport).toEqual(before.transport)
        expect(after.transport).toMatchObject(before.transport)
        expect(after.inputs).toEqual(before.inputs)
        expect(after.records.slice(0, before.records.length)).toEqual(before.records)
        expect(fixture.ssh.channel).not.toHaveBeenCalled()
        expect(fixture.ssh.exec).not.toHaveBeenCalled()
      })
    },
  )

  it.each(['repeated-change', 'changed-controller', 'ownership-error'] as const)(
    'keeps native recovery unknown after %s instead of admitting a replacement',
    async (outcome) => {
      await withFixture('claude', async (fixture) => {
        await admitOriginalPrompt(fixture)
        await appendMessages(fixture, [permission('claude')])
        fixture.open.mockImplementation(async (...args) => {
          if (outcome === 'ownership-error')
            throw new NativeRecoveryError({
              operation: 'restore',
              path: fixture.transport.id,
              reason: 'ownership',
              message: 'The original transport ownership changed.',
            })
          const before = await run(fixture.store.readTransport(fixture.transport.id))
          if (outcome === 'changed-controller')
            await run(
              fixture.store.updateTransport(fixture.transport.id, {
                controller: {
                  id: 'another-controller',
                  epoch: before.transport.controller.epoch + 1,
                },
              }),
            )
          else
            await run(
              fixture.store.appendOutputs(fixture.transport.id, [
                { type: 'stderr', cursor: before.outputCursor + 1, data: encoded('another race') },
              ]),
            )
          return originalDurableOpen(...args)
        })
        const recovered = await fixture.agents.recover({ consumers: [consumer()] })
        expect(recovered.owners[0]).toMatchObject({ status: 'unknown', pending: [] })
        expect(fixture.open).toHaveBeenCalledTimes(outcome === 'repeated-change' ? 2 : 1)
        expect(fixture.attachments).toEqual([])
        expect(fixture.ssh.channel).not.toHaveBeenCalled()
        expect(fixture.ssh.exec).not.toHaveBeenCalled()
      })
    },
  )

  it.each([
    ['codex', '0.162.1'],
    ['codex', 'codex-cli 0.162.1'],
    ['codex', 'codex 0.162.1'],
    ['claude', '2.1.278'],
    ['claude', 'claude 2.1.278'],
    ['claude', 'claude code 2.1.278'],
    ['claude', '2.1.278 (Claude Code)'],
  ] as const)(
    'admits the explicitly supported %s recorded version %s without new native writes',
    async (provider, providerVersion) => {
      await withFixture(
        provider,
        async (fixture) => {
          await run(fixture.store.createTransport({ ...fixture.transport, providerVersion }))
          await admitOriginalPrompt(fixture)
          const before = await run(fixture.store.readTransport(fixture.transport.id))
          const recovered = await fixture.agents.recover({ consumers: [consumer()] })
          expect(recovered.owners[0]).toMatchObject({
            status: 'running',
            provider,
            remoteId: nativeThread,
          })
          expect(fixture.open).toHaveBeenCalledOnce()
          expect(fixture.attachments[0].activateRecoveryInputs).toHaveBeenCalledOnce()
          expect(fixture.attachments[0].nativeWrites).toEqual([])
          expect(fixture.attachments[0].rawWrites).toEqual([])
          expect((await run(fixture.store.readTransport(fixture.transport.id))).inputs).toEqual(
            before.inputs,
          )
        },
        false,
      )
    },
  )

  it.each([
    ['codex', 'codex-cli 0.162.2', 'codex-app-server-jsonrpc'],
    ['codex', 'claude 0.162.1', 'codex-app-server-jsonrpc'],
    ['codex', 'codex-cli 0.162.1-preview', 'codex-app-server-jsonrpc'],
    ['claude', '2.1.279 (Claude Code)', 'claude-stream-json'],
    ['claude', 'codex 2.1.278', 'claude-stream-json'],
    ['claude', 'claude 2.1.278-preview', 'claude-stream-json'],
    ['codex', '0.162.1', 'claude-stream-json'],
    ['claude', '2.1.278', 'codex-app-server-jsonrpc'],
  ] as const)(
    'preserves unsupported %s version %s / protocol %s without attaching, mutating or killing a process',
    async (provider, providerVersion, nativeProtocol) => {
      await withFixture(
        provider,
        async (fixture) => {
          await run(
            fixture.store.createTransport({
              ...fixture.transport,
              providerVersion,
              nativeProtocol,
            }),
          )
          await admitOriginalPrompt(fixture)
          await appendMessages(fixture, [permission(provider)])
          const before = await run(fixture.store.readTransport(fixture.transport.id))
          const { launched } = installLaunch(fixture)
          const recovered = await fixture.agents.recover({ consumers: [consumer()] })
          expect(recovered.owners[0]).toMatchObject({ status: 'unknown', remoteId: nativeThread })
          expect(recovered.owners[0].message).toMatch(/unsupported|protocol/i)
          await expect(fixture.agents.start(nextInput(provider))).rejects.toThrow(
            /unsupported|protocol|unknown/i,
          )
          await expect(
            fixture.agents.respond('life-session', localRequestId(provider), false),
          ).rejects.toThrow(/unsupported|protocol|unknown/i)
          expect(fixture.open).not.toHaveBeenCalled()
          expect(launched).toEqual([])
          expect(fixture.ssh.channel).not.toHaveBeenCalled()
          expect(fixture.ssh.exec).not.toHaveBeenCalled()
          expect(
            fixture.events.filter(
              (event) => event.type === 'approval' || event.type === 'request-resolved',
            ),
          ).toEqual([])
          expect(await run(fixture.store.readTransport(fixture.transport.id))).toEqual(before)
          expect(generateTitle).not.toHaveBeenCalled()
        },
        false,
      )
    },
  )

  it('drains an admitted old renderer checkpoint before final suspension and a new recovery context', async () => {
    await withFixture('codex', async (fixture) => {
      await completeOriginal(fixture, false)
      const prior = await fixture.agents.recover({ consumers: [consumer()] })
      const ownerState = prior.owners[0]
      expect(ownerState.deliveryToken).toEqual(expect.any(String))
      const entered = Deferred.makeUnsafe<void>()
      const commit = Deferred.makeUnsafe<void>()
      const originalUpdate = fixture.store.updateTransport.bind(fixture.store)
      const oldContext = {
        ...(owner('codex').clientRecovery as object),
        checkpoint: 'old-document-final',
        exact: exactPrompt,
      }
      const update = vi.spyOn(fixture.store, 'updateTransport').mockImplementation((id, patch) => {
        const client = patch.owners?.find(
          (owner) => owner.sessionId === 'life-session',
        )?.clientRecovery
        if (client && (client as { checkpoint?: unknown }).checkpoint === 'old-document-final')
          return Effect.gen(function* () {
            Deferred.doneUnsafe(entered, Effect.void)
            yield* Deferred.await(commit)
            yield* originalUpdate(id, patch)
          })
        return originalUpdate(id, patch)
      })
      const writing = fixture.agents.updateRecoveryOwner({
        sessionId: 'life-session',
        transportId: fixture.transport.id,
        ownerGeneration: ownerState.ownerGeneration,
        clientRecovery: oldContext,
      })
      await Effect.runPromise(Deferred.await(entered))
      fixture.agents.pauseRendererRecovery()
      await expect(
        fixture.agents.updateRecoveryOwner({
          sessionId: 'life-session',
          clientRecovery: { checkpoint: 'rejected-after-suspension' },
        }),
      ).rejects.toThrow(/suspension|suspended|recover/i)
      let drained = false
      const draining = fixture.agents.flushRecovery().then(() => {
        drained = true
      })
      try {
        await new Promise<void>((resolve) => setImmediate(resolve))
        expect(drained).toBe(false)
        const before = await run(fixture.store.readTransport(fixture.transport.id))
        expect(drained).toBe(false)
        expect(before.transport.owners[0].clientRecovery).toEqual(owner('codex').clientRecovery)
        Deferred.doneUnsafe(commit, Effect.void)
        await writing
        await draining
        fixture.agents.finalizeRendererSuspension()
        update.mockRestore()
        const recovered = await fixture.agents.recover({ consumers: [consumer()] })
        expect(recovered.owners[0].clientRecovery).toEqual(oldContext)
        expect(recovered.owners[0].deliveryToken).toEqual(expect.any(String))
        expect(recovered.owners[0].deliveryToken).not.toBe(ownerState.deliveryToken)
        const newContext = { checkpoint: 'new-document', exact: '\r\n🌍\ud800' }
        await fixture.agents.updateRecoveryOwner({
          sessionId: 'life-session',
          transportId: fixture.transport.id,
          ownerGeneration: recovered.owners[0].ownerGeneration,
          clientRecovery: newContext,
        })
        await fixture.agents.flushRecovery()
        const settled = await run(fixture.store.readTransport(fixture.transport.id))
        expect(settled.transport.owners[0].clientRecovery).toEqual(newContext)
        const checkpoints = settled.records.flatMap((record) =>
          record.kind === 'transport'
            ? (record.patch.owners || []).flatMap((owner) => {
                const client = owner.clientRecovery as { checkpoint?: string } | undefined
                return client?.checkpoint ? [client.checkpoint] : []
              })
            : [],
        )
        expect(checkpoints).toContain('old-document-final')
        expect(checkpoints.indexOf('old-document-final')).toBeLessThan(
          checkpoints.indexOf('new-document'),
        )
        expect(checkpoints).not.toContain('rejected-after-suspension')
        expect(settled.inputs).toEqual(before.inputs)
        expect(fixture.attachments[0].nativeWrites).toEqual([])
        expect(fixture.ssh.channel).not.toHaveBeenCalled()
      } finally {
        Deferred.doneUnsafe(commit, Effect.void)
        await writing
        await draining
        update.mockRestore()
      }
    })
  })

  it.each(['codex', 'claude'] as const)(
    'rejects a new %s configuration during catch-up without native writes and permits an explicit retry after recovery',
    async (provider) => {
      await withFixture(provider, async (fixture) => {
        await admitOriginalPrompt(fixture)
        const replay = Deferred.makeUnsafe<void>()
        const open = fixture.open.getMockImplementation()!
        fixture.open.mockImplementationOnce(async (...args) => {
          const channel = await open(...args)
          ;(channel as unknown as ReattachedChannel).waitForReplay.mockImplementationOnce(() =>
            Effect.runPromise(Deferred.await(replay)),
          )
          return channel
        })
        const recovering = fixture.agents.recover({ consumers: [consumer()] })
        try {
          await vi.waitFor(() =>
            expect(fixture.attachments[0]?.waitForReplay).toHaveBeenCalledOnce(),
          )
          const input = { sessionId: 'life-session', mode: 'edit' as const }
          await expect(fixture.agents.configure(input)).rejects.toThrow(/recover|replay|unknown/i)
          expect(fixture.attachments[0].nativeWrites).toEqual([])
          expect(fixture.attachments[0].rawWrites).toEqual([])
          expect(fixture.ssh.channel).not.toHaveBeenCalled()
          expect(fixture.attachments[0].activateRecoveryInputs).not.toHaveBeenCalled()
          Deferred.doneUnsafe(replay, Effect.void)
          await recovering
          fixture.attachments[0].autoReply = true
          if (provider === 'claude') {
            // The ordinary public settings path may independently read its model
            // catalog after ownership is verified. This metadata channel has no
            // native user-message or inference implementation.
            fixture.ssh.channel = vi.fn(async () => {
              const channel = Object.assign(new EventEmitter(), {
                stderr: new EventEmitter(),
                destroyed: false,
                signal: vi.fn(),
                close: vi.fn(),
                write(raw: string) {
                  const request = JSON.parse(raw)
                  expect(request.request?.subtype).toBe('initialize')
                  queueMicrotask(() =>
                    channel.emit(
                      'data',
                      Buffer.from(
                        JSON.stringify({
                          type: 'control_response',
                          response: {
                            subtype: 'success',
                            request_id: request.request_id,
                            response: { models: [{ value: 'test-model', display_name: 'Test' }] },
                          },
                        }) + '\n',
                      ),
                    ),
                  )
                  return true
                },
              })
              return channel as unknown as ClientChannel
            })
          }
          await expect(fixture.agents.configure(input)).resolves.toMatchObject({ mode: 'edit' })
          expect(
            fixture.attachments[0].nativeWrites.filter(({ message }) =>
              provider === 'codex'
                ? message.method === 'thread/settings/update'
                : (message.request as { subtype?: string } | undefined)?.subtype ===
                  'set_permission_mode',
            ),
          ).toHaveLength(1)
          expect(
            fixture.attachments[0].nativeWrites.some(
              ({ semantic }) => semantic.kind === 'user-prompt',
            ),
          ).toBe(false)
        } finally {
          Deferred.doneUnsafe(replay, Effect.void)
          await recovering
        }
      })
    },
  )

  it.each(['applied', 'targetUnavailable'] as const)(
    'restores exact Codex default choices and permission alias from native settings ACKs when the final owner write fails and the turn is %s',
    async (turnOutcome) => {
      await withFixture('codex', async (fixture) => {
        await admitOriginalPrompt(fixture)
        await fixture.agents.recover({ consumers: [consumer()] })
        const channel = fixture.attachments[0]
        channel.autoReply = true
        const answer = channel.answer.bind(channel)
        vi.spyOn(channel, 'answer').mockImplementation(async (message) => {
          if (message.method === 'model/list')
            await channel.reply({
              id: message.id,
              result: {
                data: [
                  {
                    model: 'test-model',
                    displayName: 'Test',
                    isDefault: true,
                    defaultReasoningEffort: 'medium',
                    supportedReasoningEfforts: [{ reasoningEffort: 'medium' }],
                    serviceTiers: [{ id: 'default' }, { id: 'fast' }],
                  },
                ],
              },
            })
          else if (message.method === 'turn/settings/update')
            await channel.reply({ id: message.id, result: { status: turnOutcome } })
          else await answer(message)
        })
        const choices = {
          model: '',
          reasoningEffort: '',
          serviceTier: '',
          mode: 'ask-for-approval' as const,
        }
        const update = fixture.store.updateTransport.bind(fixture.store)
        const denied = vi.spyOn(fixture.store, 'updateTransport').mockImplementation((id, patch) =>
          patch.owners?.some((owner) => owner.kind === 'root' && owner.input.model === '')
            ? Effect.fail(
                new NativeRecoveryError({
                  operation: 'fixture-final-owner',
                  path: id,
                  reason: 'io',
                  message: 'Fixture denied only the final settings owner write',
                }),
              )
            : update(id, patch),
        )
        try {
          await expect(
            fixture.agents.configure({ sessionId: 'life-session', ...choices }),
          ).rejects.toThrow(/denied only the final settings owner write/)
          await channel.inputTail
          await channel.outputTail
          await fixture.agents.flushRecovery()
          const before = await run(fixture.store.readTransport(fixture.transport.id))
          expect(before.transport.owners[0].input.model).toBe('original-model')
          expect(before.transport.owners[0].input.mode).toBe('read-only')
          const settings = before.inputs.filter((input) => input.semantic.kind === 'settings')
          expect(settings.map((input) => input.semantic.method)).toEqual([
            'thread/settings/update',
            'turn/settings/update',
          ])
          for (const input of settings) {
            expect(input.semantic).toMatchObject({
              sessionId: 'life-session',
              ownerGeneration: 3,
              nativeThreadId: nativeThread,
              nativeTurnId: nativeTurn,
              details: { requestedSettings: choices, permissionBoundaryChanged: true },
            })
            expect(typeof input.semantic.requestId).toBe('number')
            expect(decodeInput(input).id).toBe(input.semantic.requestId)
          }
          expect(decodeInput(settings[0]).params).toMatchObject({
            threadId: nativeThread,
            model: 'test-model',
            effort: 'medium',
            serviceTier: null,
          })
          expect(decodeInput(settings[1]).params).toMatchObject({
            threadId: nativeThread,
            turnId: nativeTurn,
            model: 'test-model',
            effort: 'medium',
            serviceTier: null,
          })
          const live = fixture.events.filter(
            (event) =>
              event.type === 'settings' && event.nativeRecovery?.eventId.includes(':wire:'),
          )
          expect(live).toHaveLength(2)
          expect(live[0]).toMatchObject({
            status: 'next-request',
            details: { ...choices, applied: 'next-request' },
          })
          expect(live[1]).toMatchObject({
            status: 'next-request',
            details: { applied: 'next-request' },
          })
          await run(
            fixture.store.acknowledgeInput(fixture.transport.id, before.allocatedInputSequence),
          )
          denied.mockRestore()
          await fixture.agents.detach()
          const replayed: AgentEvent[] = []
          const reopened = new Agents(
            fixture.ssh,
            (event) => {
              replayed.push(event)
            },
            fixture.store,
          )
          try {
            const recovered = await reopened.recover({ consumers: [consumer()] })
            expect(recovered.owners[0]).toMatchObject({
              status: 'running',
              remoteId: nativeThread,
              originalInput: { ...choices, prompt: exactPrompt },
            })
            const stable = (events: AgentEvent[]) =>
              events
                .filter(
                  (event) =>
                    event.type === 'settings' && event.nativeRecovery?.eventId.includes(':wire:'),
                )
                .map((event) => ({
                  eventId: event.nativeRecovery?.eventId,
                  ownerGeneration: event.nativeRecovery?.ownerGeneration,
                  localTurn: event.nativeRecovery?.localTurn,
                  status: event.status,
                  details: event.details,
                }))
            expect(stable(replayed)).toEqual(stable(live))
            const restored = await run(fixture.store.readTransport(fixture.transport.id))
            expect(restored.transport.owners[0].input).toMatchObject({
              ...choices,
              prompt: exactPrompt,
            })
            expect(
              restored.inputs.map(({ sequence, frame, wire, semantic }) => ({
                sequence,
                frame,
                wire,
                semantic,
              })),
            ).toEqual(
              before.inputs.map(({ sequence, frame, wire, semantic }) => ({
                sequence,
                frame,
                wire,
                semantic,
              })),
            )
            expect(fixture.attachments[1].nativeWrites).toEqual([])
            expect(fixture.attachments[1].rawWrites).toEqual([])
            expect(fixture.attachments[1].signal).not.toHaveBeenCalled()
            expect(fixture.attachments[1].close).not.toHaveBeenCalled()
            expect(fixture.ssh.channel).not.toHaveBeenCalled()
            expect(fixture.ssh.exec).not.toHaveBeenCalled()
          } finally {
            await reopened.detach()
          }
        } finally {
          denied.mockRestore()
        }
      })
    },
  )

  it('gives live Claude initialization and full raw replay identical settings, pending permission order and event IDs', async () => {
    await withFixture(
      'claude',
      async (fixture) => {
        const { launched } = installLaunch(fixture, (channel) => {
          channel.initializationPayload = {
            claude_code_version: '2.1.278',
            session_state: 'requires_action',
            fast_mode_state: 'off',
            fast_mode_disabled_reason: 'sdk_opt_in_required',
            current_permission_mode: 'plan',
            applied: { model: 'test-model', effort: 'high' },
            futureNativeInitialization: { exact: '\ud800', values: [false, null] },
          }
          channel.initializationPermissions = [permission('claude', 'pending-from-initialize')]
        })
        await fixture.agents.start(nextInput('claude', { localTurn: 0 }))
        await launched[0].inputTail
        await fixture.agents.flushRecovery()
        const before = await run(fixture.store.readTransport(fixture.transport.id))
        const live = fixture.events.filter((event) => ['settings', 'approval'].includes(event.type))
        expect(live.map((event) => event.type)).toEqual(['settings', 'approval'])
        expect(live[0]).toMatchObject({
          details: {
            fastModeState: 'off',
            fastModeDisabledReason: 'sdk_opt_in_required',
            currentPermissionMode: 'plan',
          },
        })
        expect(live[1]).toMatchObject({ requestId: 'pending-from-initialize' })
        expect(live.every((event) => Boolean(event.nativeRecovery?.eventId))).toBe(true)
        expect(
          launched[0].nativeWrites.filter(({ semantic }) => semantic.kind === 'user-prompt'),
        ).toHaveLength(1)
        await fixture.agents.detach()
        const replayed: AgentEvent[] = []
        const reopened = new Agents(
          fixture.ssh,
          (event) => {
            replayed.push(event)
          },
          fixture.store,
        )
        try {
          const recovered = await reopened.recover({ consumers: [consumer()] })
          expect(recovered.owners[0]).toMatchObject({ status: 'running', remoteId: nativeThread })
          const replay = replayed.filter((event) => ['settings', 'approval'].includes(event.type))
          expect(
            replay.map((event) => ({
              type: event.type,
              requestId: event.requestId,
              details: event.details,
              eventId: event.nativeRecovery?.eventId,
            })),
          ).toEqual(
            live.map((event) => ({
              type: event.type,
              requestId: event.requestId,
              details: event.details,
              eventId: event.nativeRecovery?.eventId,
            })),
          )
          expect(recovered.owners[0].pending?.map((event) => event.requestId)).toEqual([
            'pending-from-initialize',
          ])
          expect(fixture.attachments[0].nativeWrites).toEqual([])
          expect(fixture.attachments[0].rawWrites).toEqual([])
          expect((await run(fixture.store.readTransport(fixture.transport.id))).inputs).toEqual(
            before.inputs,
          )
          expect(fixture.ssh.durableChannel).toHaveBeenCalledOnce()
        } finally {
          await reopened.detach()
        }
      },
      false,
    )
  })

  it.each(['codex', 'claude'] as const)(
    'resumes the original completed %s conversation only on an explicit next Send using a real new channel',
    async (provider) => {
      await withFixture(provider, async (fixture) => {
        await completeOriginal(fixture, true)
        const initial = await run(fixture.store.readTransport(fixture.transport.id))
        const recovery = await fixture.agents.recover({ consumers: [consumer()] })
        expect(recovery.owners[0]).toMatchObject({ status: 'idle', remoteId: nativeThread })
        expect(fixture.open).not.toHaveBeenCalled()
        const { launched, commands } = installLaunch(fixture)
        const input = nextInput(provider)
        await fixture.agents.start(input)
        await launched[0].inputTail
        await fixture.agents.flushRecovery()
        expect(launched).toHaveLength(1)
        expect(launched[0].rawWrites).toEqual([])
        const prompts = launched[0].nativeWrites.filter(
          ({ semantic }) => semantic.kind === 'user-prompt',
        )
        expect(prompts).toHaveLength(1)
        expect(prompts[0].message).toMatchObject(
          provider === 'codex'
            ? {
                method: 'turn/start',
                params: { threadId: nativeThread, input: [{ type: 'text', text: input.prompt }] },
              }
            : {
                type: 'user',
                session_id: nativeThread,
                message: { content: [{ type: 'text', text: input.prompt }] },
              },
        )
        if (provider === 'codex') {
          expect(
            launched[0].nativeWrites.filter(({ message }) => message.method === 'thread/resume'),
          ).toMatchObject([{ message: { params: { threadId: nativeThread, excludeTurns: true } } }])
          expect(
            launched[0].nativeWrites.some(({ message }) => message.method === 'thread/start'),
          ).toBe(false)
        } else expect(commands[0]).toContain(`--resume=${nativeThread}`)
        const after = await run(fixture.store.readTransport(fixture.transport.id))
        expect(after.inputs).toEqual(initial.inputs)
        expect(after.outputs).toEqual(initial.outputs)
        expect(fixture.ssh.channel).not.toHaveBeenCalled()
        expect(generateTitle).not.toHaveBeenCalled()
      })
    },
  )

  it.each(['codex', 'claude'] as const)(
    'reattaches the original %s broker after an ACKed close without a native exit and refuses a replacement turn',
    async (provider) => {
      await withFixture(provider, async (fixture) => {
        await completeOriginal(fixture, false)
        const closing = await run(
          fixture.store.reserveInput(fixture.transport.id, { type: 'close' }, { kind: 'close' }),
        )
        await run(fixture.store.acknowledgeInput(fixture.transport.id, closing.sequence))
        const original = await run(fixture.store.readTransport(fixture.transport.id))
        const open = fixture.open.getMockImplementation()!
        fixture.open.mockImplementationOnce(async (...args) => {
          const channel = await open(...args)
          ;(channel as unknown as ReattachedChannel).isClosing = true
          return channel
        })
        await fixture.agents.recover({ consumers: [consumer()] })
        expect(fixture.open).toHaveBeenCalledOnce()
        expect(fixture.open).toHaveBeenCalledWith(
          fixture.ssh,
          fixture.transport.launchCommand,
          expect.objectContaining({
            snapshot: expect.objectContaining({ transport: original.transport }),
            deferRecoveryInputs: true,
          }),
        )
        await expect(fixture.agents.start(nextInput(provider))).rejects.toThrow(
          /closing|terminal receipt/i,
        )
        expect(fixture.attachments[0].nativeWrites).toEqual([])
        expect(fixture.attachments[0].rawWrites).toEqual([])
        expect(fixture.ssh.channel).not.toHaveBeenCalled()
        expect(fixture.ssh.exec).not.toHaveBeenCalled()
        expect((await run(fixture.store.readTransport(fixture.transport.id))).inputs).toEqual(
          original.inputs,
        )
      })
    },
  )

  it.each([true, false])(
    'keeps a recovered idle Codex owner known after intentional retirement (close before terminal proof: %s)',
    async (closeBeforeExit) => {
      await withFixture('codex', async (fixture) => {
        await completeOriginal(fixture, false)
        const recovered = await fixture.agents.recover({ consumers: [consumer()] })
        expect(recovered.owners[0].status).toBe('idle')
        const channel = fixture.attachments[0]
        channel.closeAndWaitEffect = () =>
          Effect.promise(async () => {
            channel.isClosing = true
            if (closeBeforeExit) channel.emit('close')
            await channel.nativeExit()
            return true
          })
        const inputs = (await run(fixture.store.readTransport(fixture.transport.id))).inputs
        await expect(fixture.agents.releaseIdleProviders()).resolves.toEqual([true])
        await fixture.agents.settleRendererHandoff()
        expect(fixture.agents.hasPendingRendererWork()).toBe(false)
        await expect(fixture.agents.rendererHandoffAdmitted()).resolves.toBe(true)
        const retired = await run(fixture.store.readTransport(fixture.transport.id))
        expect(retired.inputs).toEqual(inputs)
        expect(retired.outputs).toContainEqual(
          expect.objectContaining({
            type: 'exit',
            nativeExitConfirmed: true,
          }),
        )
        expect(fixture.open).toHaveBeenCalledOnce()
        expect(fixture.ssh.channel).not.toHaveBeenCalled()
      })
    },
  )

  it('keeps an unexpectedly disconnected recovered Codex owner unknown without native exit proof', async () => {
    await withFixture('codex', async (fixture) => {
      await completeOriginal(fixture, false)
      await fixture.agents.recover({ consumers: [consumer()] })
      fixture.attachments[0].emit('close')
      expect(fixture.agents.hasPendingRendererWork()).toBe(true)
      await expect(fixture.agents.rendererHandoffAdmitted()).resolves.toBe(false)
      const retained = await run(fixture.store.readTransport(fixture.transport.id))
      expect(retained.outputs.some((output) => output.type === 'exit')).toBe(false)
      expect(fixture.open).toHaveBeenCalledOnce()
      expect(fixture.ssh.channel).not.toHaveBeenCalled()
    })
  })

  it('holds a next Codex connection behind slow idle release and still requires a durable native exit after the wait times out', async () => {
    await withFixture('codex', async (fixture) => {
      await completeOriginal(fixture, false)
      await fixture.agents.recover({ consumers: [consumer()] })
      const channel = fixture.attachments[0]
      const terminal = Deferred.makeUnsafe<boolean>()
      const releaseEntered = vi.fn()
      channel.closeAndWaitEffect = Effect.fn('tests.nativeRecoveryBoundary.closeAndWait')(
        function* () {
          releaseEntered()
          channel.isClosing = true
          return yield* Deferred.await(terminal)
        },
      )
      const { launched } = installLaunch(fixture)
      const releasing = fixture.agents.releaseIdleProviders()
      await vi.waitFor(() => expect(releaseEntered).toHaveBeenCalledOnce())
      const input = nextInput('codex', { sessionId: 'another-thread' })
      let settled = false
      const sending = fixture.agents.start(input).finally(() => {
        settled = true
      })
      const rejection = expect(sending).rejects.toThrow(/terminal receipt|replacement writer/i)
      await Promise.resolve()
      expect(settled).toBe(false)
      expect(launched).toEqual([])
      Deferred.doneUnsafe(terminal, Effect.succeed(false))
      await expect(releasing).resolves.toEqual([false])
      await rejection
      expect(launched).toEqual([])
      await channel.nativeExit()
      await fixture.agents.start(input)
      expect(launched).toHaveLength(1)
      expect(
        launched[0].nativeWrites.filter(({ semantic }) => semantic.kind === 'user-prompt'),
      ).toHaveLength(1)
      expect(fixture.ssh.channel).not.toHaveBeenCalled()
    })
  })

  it.each(['codex', 'claude'] as const)(
    'allocates a newer private Studio preparation after a completed %s owner and admits its exact source action before the first provider start',
    async (provider) => {
      await withFixture(provider, async (fixture) => {
        await completeOriginal(fixture, true)
        await fixture.agents.recover({ consumers: [consumer()] })
        const { launched } = installLaunch(fixture)
        const reservation = studioReservation(provider)
        const reserved = await fixture.agents.reserveRecoveryOwner(reservation)
        expect(reserved.ownerGeneration).toBe(4)
        expect(reserved.transportId).not.toBe(fixture.transport.id)
        const intent = {
          revision: 13,
          files: ['src/App.tsx'],
          exact: '\r\n\ud800',
          future: [false, null],
        }
        const action = {
          id: 'source-before-native',
          kind: 'read-source',
          status: 'intended',
          intent,
        }
        await fixture.agents.updateRecoveryOwner({
          sessionId: 'life-session',
          transportId: reserved.transportId,
          ownerGeneration: reserved.ownerGeneration,
          clientRecovery: { ...reservation.clientRecovery, action },
        })
        const request: NativeRecoveryActionRequest = {
          sessionId: 'life-session',
          transportId: reserved.transportId,
          ownerGeneration: reserved.ownerGeneration,
          actionId: action.id,
          kind: 'source-read',
          intent,
        }
        await expect(fixture.agents.assertRecoveryActionOwner(request)).resolves.toBe('perform')
        await expect(
          fixture.agents.assertRecoveryActionOwner({
            ...request,
            ownerGeneration: reserved.ownerGeneration - 1,
          }),
        ).rejects.toThrow(/owner|registry/i)
        await expect(
          fixture.agents.assertRecoveryActionOwner({
            ...request,
            intent: { ...intent, revision: 14 },
          }),
        ).rejects.toThrow(/exact recorded intent/i)
        expect(launched).toEqual([])
        expect(fixture.open).not.toHaveBeenCalled()
        expect(fixture.ssh.exec).not.toHaveBeenCalled()
        const snapshot = await run(fixture.store.readTransport(reserved.transportId))
        expect(snapshot.transport).toMatchObject({
          nativeProtocol: 'life-studio-planner-v1',
          initialization: { status: 'not-started' },
          owners: [
            {
              generation: 4,
              localTurn: 8,
              clientRecovery: { action },
              input: { prompt: exactPrompt, scope: 'life-customization' },
            },
          ],
        })
        expect(snapshot.inputs).toEqual([])
        const next = await fixture.agents.reserveRecoveryOwner(reservation)
        expect(next.ownerGeneration).toBe(5)
        expect(next.transportId).not.toBe(reserved.transportId)
        await fixture.agents.detach()
        const reopened = new Agents(fixture.ssh, () => {}, fixture.store)
        const list = fixture.store.listTransports.bind(fixture.store)
        const ordered = vi
          .spyOn(fixture.store, 'listTransports')
          .mockImplementation(() =>
            list().pipe(
              Effect.map((snapshots) =>
                [...snapshots].sort(
                  (a, b) =>
                    Math.max(...b.transport.owners.map((owner) => owner.generation ?? 0)) -
                    Math.max(...a.transport.owners.map((owner) => owner.generation ?? 0)),
                ),
              ),
            ),
          )
        try {
          const recovered = await reopened.recover({
            consumers: [
              {
                kind: 'studio',
                sessionId: 'life-session',
                profileId: connected.profile!.id,
                workspace: next.originalInput.workspace,
              },
            ],
          })
          expect(recovered.owners[0].status, recovered.owners[0].message).toBe('idle')
          expect(recovered.owners).toMatchObject([
            {
              transportId: next.transportId,
              ownerGeneration: 5,
              status: 'idle',
              clientRecovery: reservation.clientRecovery,
            },
          ])
          expect(launched).toEqual([])
        } finally {
          await reopened.detach()
          ordered.mockRestore()
        }
      })
    },
  )

  it('durably claims the first Studio start before provider creation and preserves that claim when creation fails', async () => {
    await withFixture(
      'codex',
      async (fixture) => {
        const reservation = studioReservation('codex')
        const reserved = await fixture.agents.reserveRecoveryOwner(reservation)
        const beforeCreate = vi.fn(async () => {
          const snapshot = await run(fixture.store.readTransport(reserved.transportId))
          expect(snapshot.transport.owners[0]).toMatchObject({
            nativeStartClaimed: true,
            nativeStartIntentId: expect.any(String),
          })
          expect(snapshot.inputs).toEqual([])
          expect(snapshot.transport.owners[0].linkedTransportId).toBeUndefined()
          throw new Error('Fixture stopped before creating any native process')
        })
        const { launched } = installLaunch(fixture, undefined, beforeCreate)
        await expect(fixture.agents.start(studioStartInput(reservation))).rejects.toThrow(
          /before creating any native process/,
        )
        expect(beforeCreate).toHaveBeenCalledOnce()
        expect(launched).toEqual([])
        const snapshots = await run(fixture.store.listTransports())
        expect(snapshots).toHaveLength(1)
        expect(snapshots[0].transport.owners[0]).toMatchObject({
          nativeStartClaimed: true,
          nativeStartIntentId: expect.any(String),
        })
        expect(snapshots[0].inputs).toEqual([])
        expect(generateTitle).not.toHaveBeenCalled()
        expect(fixture.ssh.channel).not.toHaveBeenCalled()
        const capturedIntent = snapshots[0].transport.owners[0].nativeStartIntentId
        const nextLaunch = installLaunch(fixture)
        await fixture.agents.start(studioStartInput(reservation))
        await nextLaunch.launched[0].inputTail
        const actual = await run(fixture.store.readTransport(nextLaunch.launched[0].recoveryId))
        expect(actual.transport.owners[0].nativeStartIntentId).toBe(capturedIntent)
        expect(actual.inputs.filter((input) => input.semantic.kind === 'user-prompt')).toHaveLength(
          1,
        )
        expect(nextLaunch.launched).toHaveLength(1)
      },
      false,
    )
  })

  it.each(['before-control-allocation', 'after-control-allocation'] as const)(
    'continues exact reused Claude Studio settings and user intent after a private crash %s on the same broker',
    async (boundary) => {
      await withFixture(
        'claude',
        async (fixture) => {
          const privateWorkspace = `/home/fixture/.life/customization/${createHash('sha256').update('life-session').digest('hex')}`
          const prior = owner('claude')
          const priorInput = {
            ...studioStartInput(studioReservation('claude')),
            prompt: exactPrompt,
            remoteId: nativeThread,
            localTurn: 7,
            workspace: privateWorkspace,
            model: 'original-model',
          }
          priorInput.clientRecovery = {
            ...(priorInput.clientRecovery as Record<string, unknown>),
            turn: 7,
          }
          await run(
            fixture.store.createTransport({
              ...fixture.transport,
              owners: [
                {
                  ...prior,
                  workspace: privateWorkspace,
                  writableRoot: privateWorkspace,
                  input: Schema.decodeUnknownSync(Schema.JsonObject)(
                    JSON.parse(JSON.stringify(priorInput)),
                  ),
                  clientRecovery: Schema.decodeUnknownSync(Schema.Json)(
                    JSON.parse(JSON.stringify(priorInput.clientRecovery)),
                  ),
                },
              ],
            }),
          )
          await completeOriginal(fixture, false)
          const claims = {
            consumers: [{ ...consumer(), workspace: privateWorkspace }],
          }
          const idle = await fixture.agents.recover(claims)
          expect(idle.owners[0]).toMatchObject({
            status: 'idle',
            ownerGeneration: 3,
            remoteId: nativeThread,
          })
          const reservation = studioReservation('claude')
          const newPrompt = '  Private Studio follow-up\r\n雪🌍\ud800  '
          reservation.input.prompt = newPrompt
          reservation.clientRecovery.request = newPrompt
          const reserved = await fixture.agents.reserveRecoveryOwner(reservation)
          expect(reserved.ownerGeneration).toBe(4)
          const input = studioStartInput(reservation)
          const originalChannel = fixture.attachments[0]
          originalChannel.autoReply = true
          installClaudeMetadata(fixture)
          fixture.ssh.durableChannel = vi.fn(async () => {
            throw new Error('Must reuse the registered Claude broker')
          })
          const write = originalChannel.writeNative.bind(originalChannel)
          const intercepted = vi
            .spyOn(originalChannel, 'writeNative')
            .mockImplementation((message, semantic) => {
              if (
                (message.request as { subtype?: string } | undefined)?.subtype ===
                  'set_permission_mode' &&
                boundary === 'before-control-allocation'
              )
                throw new Error(
                  'Fixture crashed after owner registration before first settings allocation',
                )
              return write(message, semantic)
            })
          if (boundary === 'after-control-allocation') {
            originalChannel.heldMethods.add('set_permission_mode')
            originalChannel.heldInputReceipts.add('settings')
          }
          const starting = fixture.agents.start(input)
          const settledStartup = starting.catch(() => undefined)
          await vi.waitFor(() => expect(intercepted).toHaveBeenCalledOnce())
          if (boundary === 'before-control-allocation')
            await expect(starting).rejects.toThrow(
              /after owner registration before first settings allocation/,
            )
          else await originalChannel.inputTail
          await fixture.agents.flushRecovery()
          const reservationSnapshot = await run(fixture.store.readTransport(reserved.transportId))
          let original = await run(fixture.store.readTransport(fixture.transport.id))
          const nativeOwner = original.transport.owners.find((value) => value.kind === 'root')!
          expect(nativeOwner).toMatchObject({
            generation: 5,
            localTurn: 8,
            state: 'starting',
            phase: 'initializing',
            nativeSessionId: nativeThread,
            workspace: privateWorkspace,
            nativeStartIntentId: reservationSnapshot.transport.owners[0].nativeStartIntentId,
            nativeStartPlan: {
              provider: 'claude',
              user: {
                type: 'user',
                session_id: nativeThread,
                message: { content: [{ type: 'text', text: newPrompt }] },
                parent_tool_use_id: null,
              },
            },
          })
          expect(reservationSnapshot.transport.owners[0]).toMatchObject({
            nativeStartClaimed: true,
            linkedTransportId: fixture.transport.id,
            nativeStartIntentId: expect.any(String),
          })
          const plannedControls = (
            nativeOwner.nativeStartPlan as { controls?: { request: Record<string, unknown> }[] }
          )?.controls
          expect(plannedControls?.map((control) => control.request)).toEqual([
            { subtype: 'set_permission_mode', mode: 'plan' },
            { subtype: 'set_model', model: 'test-model' },
          ])
          const originalMode = original.inputs.find(
            (value) =>
              value.semantic.ownerGeneration === 5 &&
              value.semantic.requestType === 'set_permission_mode',
          )
          expect(originalMode === undefined).toBe(boundary === 'before-control-allocation')
          if (originalMode) {
            await run(fixture.store.acknowledgeInput(fixture.transport.id, originalMode.sequence))
            original = await run(fixture.store.readTransport(fixture.transport.id))
            expect(
              original.inputs.find((value) => value.sequence === originalMode.sequence),
            ).toMatchObject({ acknowledged: true, written: false, consumed: false })
          }
          expect(
            original.inputs.filter((value) => value.semantic.kind === 'user-prompt'),
          ).toHaveLength(1)
          await Effect.runPromise(
            Effect.scoped(
              withFrozenStore(fixture, async (store) => {
                // Dispose only the obsolete stand-in controller after copying its WAL.
                // This isolated snapshot test does not establish real process survival.
                fixture.agents.close(
                  'Fixture discarded its controller after the private startup crash snapshot',
                )
                await settledStartup
                intercepted.mockRestore()
                const channel = new ReattachedChannel(fixture.transport.id, store, original)
                channel.autoReply = true
                const retried: {
                  sequence: number
                  frame: NativeRecoverySnapshot['inputs'][number]['frame']
                }[] = []
                if (originalMode)
                  channel.waitForReplay.mockImplementationOnce(async () => {
                    retried.push({ sequence: originalMode.sequence, frame: originalMode.frame })
                    await channel.confirmWritten(originalMode.sequence)
                    await channel.reply({
                      type: 'control_response',
                      response: {
                        subtype: 'success',
                        request_id: decodeInput(originalMode).request_id,
                        response: {},
                      },
                    })
                    return undefined
                  })
                fixture.open.mockImplementationOnce(async (_ssh, _command, options) => {
                  expect(options).toMatchObject({
                    snapshot: { transport: { id: fixture.transport.id } },
                    deferRecoveryInputs: true,
                  })
                  return channel as unknown as DurableRemoteChannel
                })
                const recoveredEvents: AgentEvent[] = []
                const listTransports = store.listTransports.bind(store)
                const ordered = vi
                  .spyOn(store, 'listTransports')
                  .mockImplementation(() =>
                    listTransports().pipe(
                      Effect.map((snapshots) => [
                        ...snapshots.filter(
                          (value) => value.transport.nativeProtocol === 'life-studio-planner-v1',
                        ),
                        ...snapshots.filter(
                          (value) => value.transport.nativeProtocol !== 'life-studio-planner-v1',
                        ),
                      ]),
                    ),
                  )
                const reopened = new Agents(
                  fixture.ssh,
                  (event) => {
                    recoveredEvents.push(event)
                  },
                  store,
                )
                try {
                  const recovered = await reopened.recover(claims)
                  await channel.inputTail
                  await channel.outputTail
                  await reopened.flushRecovery()
                  expect(recoveredEvents).toEqual(
                    expect.arrayContaining([
                      expect.objectContaining({
                        type: 'settings',
                        details: expect.objectContaining({ applied: 'live', mode: 'plan' }),
                        nativeRecovery: expect.objectContaining({ ownerGeneration: 5 }),
                      }),
                      expect.objectContaining({
                        type: 'settings',
                        details: expect.objectContaining({ applied: 'live', model: 'test-model' }),
                        nativeRecovery: expect.objectContaining({ ownerGeneration: 5 }),
                      }),
                    ]),
                  )
                  expect(
                    recovered.owners.find((value) => value.transportId === fixture.transport.id),
                  ).toMatchObject({
                    status: 'running',
                    remoteId: nativeThread,
                    ownerGeneration: 5,
                    localTurn: 8,
                    clientRecovery: input.clientRecovery,
                  })
                  const current = await run(store.readTransport(fixture.transport.id))
                  const newInputs = current.inputs.filter(
                    (value) => value.sequence > original.allocatedInputSequence,
                  )
                  expect(
                    newInputs.map((value) => value.semantic.requestType || value.semantic.kind),
                  ).toEqual(
                    boundary === 'before-control-allocation'
                      ? ['set_permission_mode', 'set_model', 'user-prompt']
                      : ['set_model', 'user-prompt'],
                  )
                  const controls = current.inputs.filter(
                    (value) =>
                      value.semantic.ownerGeneration === 5 && value.semantic.kind === 'settings',
                  )
                  expect(controls.map((value) => decodeInput(value).request)).toEqual(
                    plannedControls?.map((control) => control.request),
                  )
                  expect(
                    current.inputs.filter((value) => value.semantic.kind === 'initialize'),
                  ).toHaveLength(1)
                  expect(
                    current.inputs
                      .filter((value) => value.semantic.kind === 'user-prompt')
                      .map(decodeInput),
                  ).toMatchObject([
                    { message: { content: exactPrompt } },
                    {
                      type: 'user',
                      session_id: nativeThread,
                      message: { content: [{ type: 'text', text: newPrompt }] },
                      parent_tool_use_id: null,
                    },
                  ])
                  expect(
                    current.inputs
                      .filter((value) => value.sequence <= original.allocatedInputSequence)
                      .map(({ sequence, frame, wire, semantic }) => ({
                        sequence,
                        frame,
                        wire,
                        semantic,
                      })),
                  ).toEqual(
                    original.inputs.map(({ sequence, frame, wire, semantic }) => ({
                      sequence,
                      frame,
                      wire,
                      semantic,
                    })),
                  )
                  expect(retried).toEqual(
                    originalMode
                      ? [{ sequence: originalMode.sequence, frame: originalMode.frame }]
                      : [],
                  )
                  if (originalMode) {
                    const preserved = current.inputs.find(
                      (value) => value.sequence === originalMode.sequence,
                    )!
                    expect(preserved.frame).toEqual(originalMode.frame)
                    expect(decodeInput(preserved).request_id).toBe(
                      decodeInput(originalMode).request_id,
                    )
                    expect(
                      channel.nativeWrites.some(
                        ({ message }) =>
                          message.request_id === decodeInput(originalMode).request_id,
                      ),
                    ).toBe(false)
                  }
                  expect(
                    channel.nativeWrites.filter(({ semantic }) => semantic.kind === 'user-prompt'),
                  ).toHaveLength(1)
                  expect(
                    channel.nativeWrites.some(({ semantic }) =>
                      ['initialize', 'interrupt', 'end', 'close'].includes(semantic.kind),
                    ),
                  ).toBe(false)
                  expect(channel.signal).not.toHaveBeenCalled()
                  expect(channel.close).not.toHaveBeenCalled()
                  expect(channel.rawWrites).toEqual([])
                  const settledInputs = current.inputs
                  await reopened.recover(claims)
                  await channel.inputTail
                  expect((await run(store.readTransport(fixture.transport.id))).inputs).toEqual(
                    settledInputs,
                  )
                  expect(fixture.ssh.durableChannel).not.toHaveBeenCalled()
                  expect(fixture.ssh.exec).not.toHaveBeenCalled()
                  expect(generateTitle).not.toHaveBeenCalled()
                } finally {
                  ordered.mockRestore()
                  await reopened.detach()
                }
              }),
            ),
          )
        },
        false,
      )
    },
  )

  it.each(['codex', 'claude'] as const)(
    'continues a privately linked real %s Studio startup on the same broker after a cold crash before prompt admission, exactly once',
    async (provider) => {
      await withFixture(
        provider,
        async (fixture) => {
          const reservation = studioReservation(provider)
          const reserved = await fixture.agents.reserveRecoveryOwner(reservation)
          const { launched } = installLaunch(fixture, (channel) => {
            channel.heldMethods.add(provider === 'codex' ? 'thread/start' : 'initialize')
          })
          const input = studioStartInput(reservation)
          const starting = fixture.agents.start(input)
          const startupSettled = starting.catch(() => undefined)
          await vi.waitFor(async () => {
            const snapshot = await run(fixture.store.readTransport(reserved.transportId))
            expect(snapshot.transport.owners[0].linkedTransportId).toBeTruthy()
            expect(
              launched[0].nativeWrites.some(({ message }) =>
                provider === 'codex'
                  ? message.method === 'thread/start'
                  : (message.request as { subtype?: string } | undefined)?.subtype === 'initialize',
              ),
            ).toBe(true)
          })
          expect(launched).toHaveLength(1)
          expect(
            launched[0].nativeWrites.some(({ semantic }) => semantic.kind === 'user-prompt'),
          ).toBe(false)
          expect(fixture.agents.hasUntrackedRunningSessions()).toBe(true)
          await expect(fixture.agents.rendererHandoffAdmitted()).resolves.toBe(false)
          const linked = await run(fixture.store.readTransport(reserved.transportId))
          const realId = linked.transport.owners[0].linkedTransportId!
          const real = await run(fixture.store.readTransport(realId))
          expect(real.transport.owners[0]).toMatchObject({
            state: 'starting',
            phase: 'initializing',
            nativeStartIntentId: linked.transport.owners[0].nativeStartIntentId,
          })
          await Effect.runPromise(
            Effect.scoped(
              withFrozenStore(fixture, async (store) => {
                // Freeze the durable journal before cleaning up the obsolete controller.
                // Its local Stop/error events are written only to the original fixture store.
                fixture.agents.close(
                  'Fixture discarded its old in-memory controller after the cold-crash snapshot',
                )
                await startupSettled
                const channel = new ReattachedChannel(realId, store, real)
                channel.autoReply = true
                fixture.open.mockImplementationOnce(async (_ssh, _command, options) => {
                  expect(options).toMatchObject({
                    snapshot: { transport: { id: realId } },
                    deferRecoveryInputs: true,
                  })
                  channel.waitForReplay.mockImplementationOnce(async () => {
                    const original = real.inputs.find(
                      (input) =>
                        input.semantic.requestType === 'initialize' ||
                        input.semantic.method === 'thread/start',
                    )!
                    const message = decodeInput(original)
                    if (provider === 'codex')
                      await channel.reply({
                        id: message.id,
                        result: { thread: { id: nativeThread } },
                      })
                    else
                      await channel.reply({
                        type: 'control_response',
                        response: {
                          subtype: 'success',
                          request_id: message.request_id,
                          response: { claude_code_version: '2.1.278', session_state: 'idle' },
                        },
                      })
                  })
                  return channel as unknown as DurableRemoteChannel
                })
                const reopened = new Agents(fixture.ssh, () => {}, store)
                try {
                  const claims = {
                    consumers: [
                      {
                        kind: 'studio' as const,
                        sessionId: 'life-session',
                        profileId: connected.profile!.id,
                        workspace: real.transport.owners[0].workspace,
                      },
                    ],
                  }
                  const recovered = await reopened.recover(claims)
                  await channel.inputTail
                  await reopened.flushRecovery()
                  expect(recovered.owners).toMatchObject([
                    {
                      transportId: realId,
                      status: 'running',
                      clientRecovery: input.clientRecovery,
                    },
                  ])
                  const current = await run(store.readTransport(realId))
                  const prompts = current.inputs.filter(
                    (input) => input.semantic.kind === 'user-prompt',
                  )
                  expect(prompts).toHaveLength(1)
                  const originalInputSequence = real.inputs.at(-1)?.sequence || 0
                  expect(
                    current.inputs
                      .filter((input) => input.sequence <= originalInputSequence)
                      .map(({ sequence, frame, wire, semantic }) => ({
                        sequence,
                        frame,
                        wire,
                        semantic,
                      })),
                  ).toEqual(
                    real.inputs.map(({ sequence, frame, wire, semantic }) => ({
                      sequence,
                      frame,
                      wire,
                      semantic,
                    })),
                  )
                  expect(
                    current.inputs.filter((input) => input.sequence > originalInputSequence),
                  ).toMatchObject([{ semantic: { kind: 'user-prompt' } }])
                  expect(
                    channel.nativeWrites.filter(({ message }) =>
                      provider === 'codex'
                        ? ['initialize', 'initialized', 'thread/start', 'thread/resume'].includes(
                            String(message.method),
                          )
                        : (message.request as { subtype?: string } | undefined)?.subtype ===
                          'initialize',
                    ),
                  ).toEqual([])
                  expect(channel.rawWrites).toEqual([])
                  expect(decodeInput(prompts[0])).toMatchObject(
                    provider === 'codex'
                      ? {
                          params: {
                            threadId: nativeThread,
                            input: [{ type: 'text', text: exactPrompt }],
                          },
                        }
                      : {
                          type: 'user',
                          session_id: real.transport.owners[0].nativeSessionId || '',
                          message: { content: [{ type: 'text', text: exactPrompt }] },
                        },
                  )
                  expect(
                    current.inputs.filter((input) => input.semantic.kind === 'initialize'),
                  ).toHaveLength(
                    real.inputs.filter((input) => input.semantic.kind === 'initialize').length,
                  )
                  expect(launched).toHaveLength(1)
                  const inputsBeforeRepeat = current.inputs
                  await reopened.recover(claims)
                  await channel.inputTail
                  expect((await run(store.readTransport(realId))).inputs).toEqual(
                    inputsBeforeRepeat,
                  )
                  expect(generateTitle).not.toHaveBeenCalled()
                  expect(fixture.ssh.channel).not.toHaveBeenCalled()
                } finally {
                  await reopened.detach()
                }
              }),
            ),
          )
        },
        false,
      )
    },
  )

  it.each(['before', 'after'] as const)(
    'finishes an ownerless original Codex initialization after a private first-start crash %s initialized allocation, without duplicating initialization or opening a broker',
    async (boundary) => {
      await withFixture(
        'codex',
        async (fixture) => {
          const reservation = studioReservation('codex')
          const reserved = await fixture.agents.reserveRecoveryOwner(reservation)
          const entered = Deferred.makeUnsafe<void>()
          const release = Deferred.makeUnsafe<void>()
          const { launched } = installLaunch(fixture, (channel) => {
            const write = channel.writeNativeAndWait.bind(channel)
            vi.spyOn(channel, 'writeNativeAndWait').mockImplementation(
              async (message, semantic) => {
                if (message.method !== 'initialized') return write(message, semantic)
                if (boundary === 'after') await write(message, semantic)
                Deferred.doneUnsafe(entered, Effect.void)
                await Effect.runPromise(Deferred.await(release))
                if (boundary === 'before') await write(message, semantic)
              },
            )
          })
          const starting = fixture.agents.start(studioStartInput(reservation))
          const startupSettled = starting.catch(() => undefined)
          await Effect.runPromise(Deferred.await(entered))
          expect(launched).toHaveLength(1)
          const realId = launched[0].recoveryId
          const original = await run(fixture.store.readTransport(realId))
          expect(original.transport.owners).toEqual([])
          expect(
            original.inputs.filter((input) => input.semantic.method === 'initialize'),
          ).toHaveLength(1)
          expect(
            original.inputs.filter((input) => input.semantic.method === 'initialized'),
          ).toHaveLength(boundary === 'after' ? 1 : 0)
          expect(original.inputs.some((input) => input.semantic.kind === 'user-prompt')).toBe(false)
          const privateOwner = await run(fixture.store.readTransport(reserved.transportId))
          expect(privateOwner.transport.owners[0]).toMatchObject({
            nativeStartClaimed: true,
            nativeStartIntentId: expect.any(String),
          })
          expect(privateOwner.transport.owners[0].linkedTransportId).toBeUndefined()
          await Effect.runPromise(
            Effect.scoped(
              withFrozenStore(fixture, async (store) => {
                fixture.agents.close(
                  'Fixture disposed the obsolete controller after copying the cold-crash journal',
                )
                Deferred.doneUnsafe(release, Effect.void)
                await startupSettled
                const channel = new ReattachedChannel(realId, store, original)
                channel.autoReply = true
                fixture.open.mockImplementationOnce(async (_ssh, _command, options) => {
                  expect(options).toMatchObject({
                    snapshot: { transport: { id: realId } },
                    deferRecoveryInputs: true,
                  })
                  return channel as unknown as DurableRemoteChannel
                })
                const reopened = new Agents(fixture.ssh, () => {}, store)
                try {
                  const claims = {
                    consumers: [
                      {
                        kind: 'studio' as const,
                        sessionId: 'life-session',
                        profileId: connected.profile!.id,
                        workspace: reserved.originalInput.workspace,
                      },
                    ],
                  }
                  const recovered = await reopened.recover(claims)
                  await channel.inputTail
                  expect(recovered.owners).toMatchObject([
                    { transportId: reserved.transportId, status: 'idle' },
                  ])
                  const initialized = await run(store.readTransport(realId))
                  expect(
                    initialized.inputs.filter((input) => input.semantic.method === 'initialize'),
                  ).toHaveLength(1)
                  expect(
                    initialized.inputs.filter((input) => input.semantic.method === 'initialized'),
                  ).toHaveLength(1)
                  expect(
                    initialized.inputs.some((input) => input.semantic.kind === 'user-prompt'),
                  ).toBe(false)
                  expect(
                    initialized.inputs.some((input) => input.semantic.method === 'thread/start'),
                  ).toBe(false)
                  expect(generateTitle).not.toHaveBeenCalled()
                  await reopened.start(studioStartInput(reservation))
                  await channel.inputTail
                  await reopened.flushRecovery()
                  const final = await run(store.readTransport(realId))
                  expect(
                    final.inputs.filter((input) => input.semantic.method === 'initialize'),
                  ).toHaveLength(1)
                  expect(
                    final.inputs.filter((input) => input.semantic.method === 'initialized'),
                  ).toHaveLength(1)
                  expect(
                    final.inputs.filter((input) => input.semantic.method === 'thread/start'),
                  ).toHaveLength(1)
                  const prompts = final.inputs.filter(
                    (input) => input.semantic.kind === 'user-prompt',
                  )
                  expect(prompts).toHaveLength(1)
                  expect(decodeInput(prompts[0])).toMatchObject({
                    params: {
                      threadId: nativeThread,
                      input: [{ type: 'text', text: exactPrompt }],
                    },
                  })
                  expect(final.transport.owners[0].nativeStartIntentId).toBe(
                    privateOwner.transport.owners[0].nativeStartIntentId,
                  )
                  expect(final.transport.owners[0]).toMatchObject({
                    sessionId: 'life-session',
                    generation: reserved.ownerGeneration + 1,
                    localTurn: 8,
                    workspace: reserved.originalInput.workspace,
                    writableRoot: reserved.originalInput.workspace,
                    nativeThreadId: nativeThread,
                    input: { prompt: exactPrompt, scope: 'life-customization' },
                  })
                  expect(
                    final.inputs
                      .slice(0, original.inputs.length)
                      .map(({ sequence, frame, wire, semantic }) => ({
                        sequence,
                        frame,
                        wire,
                        semantic,
                      })),
                  ).toEqual(
                    original.inputs.map(({ sequence, frame, wire, semantic }) => ({
                      sequence,
                      frame,
                      wire,
                      semantic,
                    })),
                  )
                  expect(launched).toHaveLength(1)
                  expect(fixture.open).toHaveBeenCalledOnce()
                  expect(channel.rawWrites).toEqual([])
                  const allocated = final.inputs
                  await reopened.recover(claims)
                  expect((await run(store.readTransport(realId))).inputs).toEqual(allocated)
                } finally {
                  await reopened.detach()
                }
              }),
            ),
          )
        },
        false,
      )
    },
  )

  it('does not finish an ownerless Codex handshake without a privately claimed Studio first-start intent', async () => {
    await withFixture(
      'codex',
      async (fixture) => {
        const { launched } = installLaunch(fixture)
        await fixture.ssh.durableChannel!(fixture.transport.launchCommand, undefined, 'codex')
        const original = launched[0]
        await run(
          fixture.store.updateTransport(original.recoveryId, {
            initialization: { status: 'pending', requestId: 7 },
          }),
        )
        await original.writeNativeAndWait(
          {
            id: 7,
            method: 'initialize',
            params: {
              clientInfo: { name: 'life_desktop', version: 'original' },
              capabilities: { experimentalApi: true },
            },
          },
          { kind: 'initialize', method: 'initialize', requestId: 7 },
        )
        await vi.waitFor(async () => {
          expect(
            (await run(fixture.store.readTransport(original.recoveryId))).outputs.filter(
              (output) => output.type === 'stdout',
            ),
          ).toHaveLength(1)
        })
        const before = await run(fixture.store.readTransport(original.recoveryId))
        expect(before.outputs.filter((output) => output.type === 'inputReceipt')).toMatchObject([
          { sequence: before.inputs[0].sequence, status: 'written' },
        ])
        expect(before.inputs[0]).toMatchObject({
          written: true,
          consumed: true,
          deliveryReceipt: { status: 'written' },
        })
        expect(before.transport.owners).toEqual([])
        const recovered = await fixture.agents.recover({ consumers: [] })
        expect(recovered.owners).toEqual([])
        await expect(fixture.agents.models('codex')).rejects.toThrow(
          /initialization|proven complete|private.*start/i,
        )
        expect(fixture.attachments[0].nativeWrites).toEqual([])
        expect(fixture.attachments[0].rawWrites).toEqual([])
        expect((await run(fixture.store.readTransport(original.recoveryId))).inputs).toEqual(
          before.inputs,
        )
        expect(launched).toHaveLength(1)
        expect(fixture.open).toHaveBeenCalledOnce()
        expect(generateTitle).not.toHaveBeenCalled()
      },
      false,
    )
  })

  it.each(['codex', 'claude'] as const)(
    'keeps an unlinked %s startup unknown even when imported-looking planner fields claim a private Studio intent',
    async (provider) => {
      await withFixture(provider, async (fixture) => {
        await completeOriginal(fixture, false)
        const reservation = studioReservation(provider)
        const workspace = `/home/fixture/.life/customization/${createHash('sha256').update('life-session').digest('hex')}`
        await run(
          fixture.store.updateTransport(fixture.transport.id, {
            owners: [
              {
                ...owner(provider),
                generation: 4,
                localTurn: 8,
                state: 'starting',
                phase: 'initializing',
                workspace,
                writableRoot: workspace,
                nativeStartIntentId: 'claimed-only-by-an-unlinked-owner',
                input: Schema.decodeUnknownSync(Schema.JsonObject)(
                  JSON.parse(JSON.stringify({ ...reservation.input, workspace })),
                ),
                clientRecovery: reservation.clientRecovery,
              },
            ],
          }),
        )
        const before = await run(fixture.store.readTransport(fixture.transport.id))
        const { launched } = installLaunch(fixture)
        const recovered = await fixture.agents.recover({
          consumers: [{ ...consumer(), workspace }],
        })
        expect(recovered.owners[0]).toMatchObject({ status: 'unknown', ownerGeneration: 4 })
        await expect(fixture.agents.start(reservation.input)).rejects.toThrow(
          /unknown|native user turn|recover/i,
        )
        expect(fixture.attachments[0].nativeWrites).toEqual([])
        expect(fixture.attachments[0].rawWrites).toEqual([])
        expect(launched).toEqual([])
        expect((await run(fixture.store.readTransport(fixture.transport.id))).inputs).toEqual(
          before.inputs,
        )
        expect(generateTitle).not.toHaveBeenCalled()
      })
    },
  )

  it.each(['codex', 'claude'] as const)(
    'retries transient %s catch-up with a fresh decoder and stable wire ordinals in the same Agents runtime',
    async (provider) => {
      await withFixture(provider, async (fixture) => {
        await admitOriginalPrompt(fixture)
        const text =
          provider === 'codex'
            ? {
                method: 'item/agentMessage/delta',
                params: {
                  threadId: nativeThread,
                  turnId: nativeTurn,
                  itemId: 'owned-answer',
                  delta: exactReply,
                },
              }
            : {
                type: 'stream_event',
                session_id: nativeThread,
                event: {
                  type: 'content_block_delta',
                  index: 0,
                  delta: { type: 'text_delta', text: exactReply },
                },
              }
        if (provider === 'claude')
          await appendMessages(fixture, [
            {
              type: 'stream_event',
              session_id: nativeThread,
              event: { type: 'message_start', message: { id: 'owned-answer' } },
            },
          ])
        const bytes = Buffer.from(JSON.stringify(text) + '\n')
        const split = bytes.indexOf(Buffer.from('🌍')) + 2
        await appendBytes(fixture, [bytes.subarray(0, split)])
        const open = fixture.open.getMockImplementation()!
        fixture.open.mockImplementationOnce(async (...args) => {
          const channel = await open(...args)
          ;(channel as unknown as ReattachedChannel).waitForReplay.mockRejectedValueOnce(
            new Error('Transient fixture catch-up loss'),
          )
          return channel
        })
        const failed = await fixture.agents.recover({ consumers: [consumer()] })
        expect(failed.owners[0]).toMatchObject({ status: 'unknown' })
        expect(fixture.attachments[0].activateRecoveryInputs).not.toHaveBeenCalled()
        expect(fixture.attachments[0].detach).toHaveBeenCalled()
        expect(fixture.attachments[0].destroyed).toBe(true)
        const incomplete = fixture.events.filter(
          (event) => event.type === 'text' || event.type === 'approval',
        )
        expect(incomplete).toEqual([])
        await appendBytes(fixture, [bytes.subarray(split)])
        await appendMessages(fixture, [permission(provider)])
        fixture.events.length = 0
        const recovered = await fixture.agents.recover({ consumers: [consumer()] })
        expect(recovered.owners[0]).toMatchObject({ status: 'running', remoteId: nativeThread })
        expect(fixture.open).toHaveBeenCalledTimes(2)
        const second = fixture.events.filter(
          (event) => event.type === 'text' || event.type === 'approval',
        )
        expect(second.filter((event) => event.type === 'text').map((event) => event.text)).toEqual([
          exactReply,
        ])
        expect(
          second.filter((event) => event.type === 'approval').map((event) => event.requestId),
        ).toEqual([localRequestId(provider)])
        expect(fixture.attachments[1].activateRecoveryInputs).toHaveBeenCalledOnce()
        expect(fixture.attachments[1].nativeWrites).toEqual([])
        expect(fixture.ssh.channel).not.toHaveBeenCalled()
        expect(generateTitle).not.toHaveBeenCalled()
        await fixture.agents.detach()
        const freshEvents: AgentEvent[] = []
        const reopened = new Agents(
          fixture.ssh,
          (event) => {
            freshEvents.push(event)
          },
          fixture.store,
        )
        try {
          await reopened.recover({ consumers: [consumer()] })
          const fresh = freshEvents.filter(
            (event) => event.type === 'text' || event.type === 'approval',
          )
          const stable = (events: AgentEvent[]) =>
            events.map((event) => ({
              type: event.type,
              text: event.text,
              itemId: event.itemId,
              requestId: event.requestId,
              eventId: event.nativeRecovery?.eventId,
            }))
          expect(stable(second)).toEqual(stable(fresh))
          expect(fixture.attachments[2].nativeWrites).toEqual([])
        } finally {
          await reopened.detach()
        }
      })
    },
  )
})
