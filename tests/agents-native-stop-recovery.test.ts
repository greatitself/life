import { EventEmitter } from 'node:events'
import { createHash } from 'node:crypto'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Deferred, Effect } from 'effect'
import type { ClientChannel } from 'ssh2'
import { afterEach, describe, expect, it, vi, type MockInstance } from 'vitest'
import { Agents } from '../src/main/agents'
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
import { NativeRecoveryError } from '../src/main/native-recovery-types'
import type { SSHConnection } from '../src/main/ssh'
import type {
  AgentEvent,
  ConnectionState,
  NativeRecoveryConsumer,
  Provider,
  StartInput,
} from '../src/shared/types'

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
    phase: 'running',
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
  readonly stderr = new EventEmitter()
  readonly transportState = 'connected' as const
  readonly nativeWrites: {
    message: Record<string, unknown>
    semantic: NativeRecoveryInputSemantic
    sequence: number
    wire: string
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
  readonly replayedInputs: NativeRecoveryNumberedInput[] = []
  brokerHighWater?: number
  readonly activateRecoveryInputs = vi.fn(async () => {
    const before = await run(this.store.readTransport(this.recoveryId))
    const pending = await run(
      this.store.reconcileInputHighWater(
        this.recoveryId,
        this.brokerHighWater ?? before.acknowledgedInputSequence,
      ),
    )
    for (const original of pending) {
      this.replayedInputs.push(original)
      await run(this.store.acknowledgeInput(this.recoveryId, original.sequence))
      if (original.frame.type === 'write') {
        const message = JSON.parse(Buffer.from(original.frame.data, 'base64').toString('utf8'))
        this.nativeWrites.push({
          message,
          semantic: original.semantic,
          sequence: original.sequence,
          wire: original.wire,
        })
        await this.inputReceipt(original.sequence)
        if (this.autoReply) queueMicrotask(() => void this.answer(message))
      }
    }
  })
  readonly terminalWrites: NativeRecoveryNumberedInput[] = []
  hasUnconfirmedRecoveryInputs = false
  confirmNativeInputProcessed?: (sequence: number) => void
  autoExitOnClose = false
  holdSignal?: Promise<void>
  holdPermissionAdmission?: Promise<void>
  readonly permissionAdmissionAttempts: Record<string, unknown>[] = []
  readonly signalNativeAndWait = vi.fn(
    async (signal: string, semantic: NativeRecoveryInputSemantic) => {
      const input = await run(
        this.store.reserveInput(this.recoveryId, { type: 'signal', signal }, semantic),
      )
      this.terminalWrites.push(input)
      await this.holdSignal
      await run(this.store.acknowledgeInput(this.recoveryId, input.sequence))
      await this.inputReceipt(input.sequence)
    },
  )
  readonly closeNativeAndWait = vi.fn(async (semantic: NativeRecoveryInputSemantic) => {
    this.isClosing = true
    const before = await run(this.store.readTransport(this.recoveryId))
    if (before.closeInputSequence === undefined) {
      const input = await run(this.store.reserveInput(this.recoveryId, { type: 'close' }, semantic))
      this.terminalWrites.push(input)
      await run(this.store.acknowledgeInput(this.recoveryId, input.sequence))
    }
    if (this.autoExitOnClose) await this.nativeExit()
    const closing = await run(this.store.readTransport(this.recoveryId))
    const closeInput = closing.inputs.find((input) => input.sequence === closing.closeInputSequence)
    if (closeInput && !closeInput.deliveryReceipt)
      await this.inputReceipt(closeInput.sequence, this.autoExitOnClose ? 'written' : 'uncertain')
    return (await run(this.store.readTransport(this.recoveryId))).outputs.some(
      (frame) => frame.type === 'exit',
    )
  })
  async inputReceipt(sequence: number, status: 'written' | 'cancelled' | 'uncertain' = 'written') {
    this.outputTail = this.outputTail.then(async () => {
      await appendInputReceipt(this.store, this.recoveryId, sequence, status)
      const latest = await run(this.store.readTransport(this.recoveryId))
      this.outputCursor = latest.outputCursor
      this.emit('input-receipt', {
        type: 'inputReceipt',
        cursor: latest.outputCursor,
        sequence,
        status,
      })
    })
    return this.outputTail
  }

  async deliverAcceptedInput(input: NativeRecoveryNumberedInput) {
    if (input.frame.type !== 'write') throw new Error('Expected an original native write')
    const message = JSON.parse(Buffer.from(input.frame.data, 'base64').toString('utf8'))
    this.nativeWrites.push({
      message,
      semantic: input.semantic,
      sequence: input.sequence,
      wire: input.wire,
    })
    await this.inputReceipt(input.sequence)
  }
  readonly recordOwner = vi.fn(async () => undefined)
  readonly nativeRecoveryTracked = true
  readonly nativeInputReceipts = true
  outputCursor = 0
  autoReply = true
  initializationPayload: Record<string, unknown> = {}
  initializationPermissions: unknown[] = []
  heldMethods = new Set<string>()
  inputTail: Promise<void> = Promise.resolve()
  outputTail: Promise<void> = Promise.resolve()
  isClosing = false
  closeAndWaitEffect?: () => Effect.Effect<boolean>
  destroyed = false

  constructor(
    readonly recoveryId: string,
    readonly store: NativeRecoveryStoreHandle,
  ) {
    super()
  }

  write(value: string) {
    this.rawWrites.push(value)
    return true
  }

  writeNativeAndWait(message: Record<string, unknown>, semantic: NativeRecoveryInputSemantic) {
    return this.enqueueInput(message, semantic)
  }

  writeNative(message: Record<string, unknown>, semantic: NativeRecoveryInputSemantic) {
    void this.enqueueInput(message, semantic)
    return true
  }

  private enqueueInput(message: Record<string, unknown>, semantic: NativeRecoveryInputSemantic) {
    const data = encoded(message)
    const capturedSemantic = JSON.parse(JSON.stringify(semantic)) as NativeRecoveryInputSemantic
    this.inputTail = this.inputTail.then(async () => {
      if (capturedSemantic.kind === 'permission-response') {
        this.permissionAdmissionAttempts.push(message)
        await this.holdPermissionAdmission
      }
      const admitted = await run(
        this.store.reserveInput(this.recoveryId, { type: 'write', data }, capturedSemantic),
      )
      if (admitted.frame.type !== 'write') throw new Error('Expected an admitted native write')
      const captured = JSON.parse(Buffer.from(admitted.frame.data, 'base64').toString('utf8'))
      this.nativeWrites.push({
        message: captured,
        semantic: admitted.semantic,
        sequence: admitted.sequence,
        wire: admitted.wire,
      })
      await run(this.store.acknowledgeInput(this.recoveryId, admitted.sequence))
      await this.inputReceipt(admitted.sequence)
      // This fixture commits a real WAL and simulated broker acceptance. Native
      // CLI authentication and broker delivery require the separate runtime fixtures.
      if (this.autoReply) queueMicrotask(() => void this.answer(captured))
    })
    return this.inputTail
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
    this.outputTail = this.outputTail.then(async () => {
      const snapshot = await run(this.store.readTransport(this.recoveryId))
      this.outputCursor = snapshot.outputCursor + 1
      await run(
        this.store.appendOutputs(this.recoveryId, [
          { type: 'exit', cursor: this.outputCursor, code: 0, nativeExitConfirmed: true },
        ]),
      )
      this.destroyed = true
      this.emit('exit', 0)
      this.emit('close')
    })
    return this.outputTail
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

const scopedFixture = Effect.fn('tests.agentsNativeStopRecovery.fixture')(function* (
  provider: Provider,
  seeded: boolean,
  body: (fixture: Fixture) => Promise<void>,
  configure?: (channel: ReattachedChannel) => void,
  ownerPatch: Partial<NativeRecoveryOwner> = {},
) {
  const directory = yield* Effect.acquireRelease(
    Effect.promise(() => mkdtemp(join(tmpdir(), 'life-agents-native-stop-recovery-'))),
    (directory) => Effect.promise(() => rm(directory, { recursive: true, force: true })),
  )
  const store = yield* NativeRecoveryStore.make({ directory, outputBatchDelayMs: 1 })
  const original = descriptor(provider)
  const transport = {
    ...original,
    owners: original.owners.map((owner) => JSON.parse(JSON.stringify({ ...owner, ...ownerPatch }))),
  }
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
    .mockImplementation(async (_host, _command, options) => {
      if (!options || !('snapshot' in options) || !options.snapshot)
        throw new Error('Recovery requires the original durable transport snapshot')
      const channel = new ReattachedChannel(options.snapshot.transport.id, store)
      configure?.(channel)
      attachments.push(channel)
      return channel as unknown as DurableRemoteChannel
    })
  const events: AgentEvent[] = []
  const agents = new Agents(ssh, (event) => events.push(event), store)
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
  configure?: (channel: ReattachedChannel) => void,
  ownerPatch?: Partial<NativeRecoveryOwner>,
) => Effect.runPromise(Effect.scoped(scopedFixture(provider, true, body, configure, ownerPatch)))

async function appendInputReceipt(
  store: NativeRecoveryStoreHandle,
  transportId: string,
  sequence: number,
  status: 'written' | 'cancelled' | 'uncertain' = 'written',
) {
  const before = await run(store.readTransport(transportId))
  await run(
    store.appendOutputs(transportId, [
      {
        type: 'inputReceipt',
        cursor: before.outputCursor + 1,
        sequence,
        status,
      },
    ]),
  )
}

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

async function admitOriginalPrompt(fixture: Fixture, written = true) {
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
  await appendInputReceipt(fixture.store, fixture.transport.id, initialization.sequence)
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
    await appendInputReceipt(fixture.store, fixture.transport.id, initialized.sequence)
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
  if (written) {
    await run(fixture.store.acknowledgeInput(fixture.transport.id, input.sequence))
    await appendInputReceipt(fixture.store, fixture.transport.id, input.sequence)
  }
  if (written && provider === 'codex')
    await appendMessages(fixture, [{ id: 12, result: { turn: { id: nativeTurn } } }])
  return input
}

async function persistStop(fixture: Fixture, patch: Partial<NativeRecoveryOwner> = {}) {
  const snapshot = await run(fixture.store.readTransport(fixture.transport.id))
  const original = snapshot.transport.owners.find((owner) => owner.kind === 'root')!
  await run(
    fixture.store.updateTransport(fixture.transport.id, {
      owners: snapshot.transport.owners.map((owner) =>
        owner === original
          ? JSON.parse(JSON.stringify({ ...owner, ...patch, stopRequested: true }))
          : owner,
      ),
    }),
  )
}

const interrupted = (threadId = nativeThread, turnId = nativeTurn) => ({
  method: 'turn/completed',
  params: { threadId, turn: { id: turnId, status: 'interrupted' } },
})

const stopDeliveries = (fixture: Fixture) =>
  fixture.events.filter(
    (event) =>
      event.type === 'complete' &&
      event.status === 'interrupted' &&
      event.sessionId === 'life-session',
  )
// Ledger replay is intentionally at least once; event identity makes its native
// completion idempotent for the renderer. Distinct completion identities remain errors.
const stopEvents = (fixture: Fixture) => [
  ...new Map(
    stopDeliveries(fixture).map((event, index) => [
      event.nativeRecovery?.eventId ?? `missing-private-identity-${index}`,
      event,
    ]),
  ).values(),
]
const interrupts = (channel: ReattachedChannel) =>
  channel.nativeWrites.filter(
    (input) =>
      input.message.method === 'turn/interrupt' ||
      (input.message.request as { subtype?: string } | undefined)?.subtype === 'interrupt',
  )

async function recovered(fixture: Fixture) {
  await fixture.agents.recover({ consumers: [consumer()] })
  await fixture.agents.flushRecovery()
  return fixture.attachments.at(-1)!
}

function nextInput(provider: Provider, localTurn = 8): StartInput {
  return {
    sessionId: 'life-session',
    provider,
    prompt: ` Explicit next turn ${localTurn}\r\n🌍\ud800 `,
    remoteId: nativeThread,
    mode: provider === 'codex' ? 'read-only' : 'review',
    model: 'test-model',
    workspace: '/project',
    localTurn,
  }
}

function installLaunch(fixture: Fixture) {
  const launched: ReattachedChannel[] = []
  fixture.ssh.durableChannel = vi.fn(async (command, onOpening, provider = 'codex') => {
    const id = `${fixture.transport.id}-next-${launched.length + 1}`
    await run(
      fixture.store.createTransport({
        ...descriptor(provider),
        id,
        brokerId: `${id}-broker`,
        brokerRoot: `/registered/home/.life/agent-sessions/${id}`,
        launchCommand: command,
        initialization: { status: 'not-started' },
        owners: [],
      }),
    )
    const channel = new ReattachedChannel(id, fixture.store)
    launched.push(channel)
    onOpening?.(channel as unknown as ClientChannel)
    return channel as unknown as ClientChannel
  })
  return launched
}

describe('Agents native Stop recovery boundaries', () => {
  for (const kind of ['user-prompt', 'settings', 'permission-response'] as const) {
    it(`accepted but unwritten ${kind} cannot continue Stop until its exact native delivery is observed`, () =>
      withFixture(
        'codex',
        async (fixture) => {
          let original: NativeRecoveryNumberedInput
          if (kind === 'user-prompt') {
            original = await admitOriginalPrompt(fixture, false)
          } else {
            await admitOriginalPrompt(fixture)
            const pending = {
              id: 'pending-native-permission',
              method: 'item/commandExecution/requestApproval',
              params: {
                threadId: nativeThread,
                turnId: nativeTurn,
                itemId: 'pending-command',
                command: 'printf exact',
                cwd: '/project',
              },
            }
            if (kind === 'permission-response') await appendMessages(fixture, [pending])
            const localId = `${fixture.transport.id}:request:string:pending-native-permission`
            original = await run(
              fixture.store.reserveInput(
                fixture.transport.id,
                {
                  type: 'write',
                  data: encoded(
                    kind === 'settings'
                      ? {
                          id: 91,
                          method: 'turn/settings/update',
                          params: {
                            threadId: nativeThread,
                            turnId: nativeTurn,
                            model: 'pending-next-model',
                          },
                        }
                      : { id: pending.id, result: { decision: 'accept' } },
                  ),
                },
                {
                  kind,
                  sessionId: 'life-session',
                  ownerGeneration: 3,
                  nativeThreadId: nativeThread,
                  nativeTurnId: nativeTurn,
                  ...(kind === 'settings'
                    ? {
                        method: 'turn/settings/update',
                        requestId: 91,
                        details: { settings: { model: 'pending-next-model' } },
                      }
                    : {
                        permissionRequestId: pending.id,
                        requestType: pending.method,
                        responseBinding: {
                          requestId: localId,
                          params: pending.params,
                          status: 'approved',
                        },
                      }),
                },
              ),
            )
          }
          await run(fixture.store.acknowledgeInput(fixture.transport.id, original.sequence))
          await persistStop(fixture)
          const channel = await recovered(fixture)
          const before = await run(fixture.store.readTransport(fixture.transport.id))
          expect(before.inputs.find((input) => input.sequence === original.sequence)).toMatchObject(
            { acknowledged: true, written: false },
          )
          expect(channel.nativeWrites).toEqual([])
          expect(channel.replayedInputs).toEqual([])
          expect(channel.terminalWrites).toEqual([])
          expect(stopEvents(fixture)).toEqual([])
          if (kind === 'permission-response') {
            expect(fixture.events.some((event) => event.type === 'request-resolved')).toBe(false)
            await expect(
              fixture.agents.respond(
                'life-session',
                `${fixture.transport.id}:request:string:pending-native-permission`,
                true,
              ),
            ).rejects.toThrow(/Stop|native|pending|delivery/i)
          }
          await channel.deliverAcceptedInput(original)
          expect(
            (await run(fixture.store.readTransport(fixture.transport.id))).inputs.find(
              (input) => input.sequence === original.sequence,
            ),
          ).toMatchObject({
            written: true,
            deliveryReceipt: { status: 'written' },
          })
          if (kind === 'user-prompt') {
            expect(interrupts(channel)).toEqual([])
            await channel.reply({ id: 12, result: { turn: { id: 'pipe-and-sdk-confirmed-turn' } } })
          }
          if (kind === 'settings') {
            expect(
              (await run(fixture.store.readTransport(fixture.transport.id))).transport.owners.find(
                (owner) => owner.kind === 'root',
              )?.input.model,
            ).toBe('original-model')
          }
          await vi.waitFor(() => expect(interrupts(channel)).toHaveLength(1))
          expect(
            channel.nativeWrites.filter((input) => input.sequence === original.sequence),
          ).toHaveLength(1)
          expect(
            channel.nativeWrites.find((input) => input.sequence === original.sequence)?.wire,
          ).toBe(original.wire)
          const turnId = kind === 'user-prompt' ? 'pipe-and-sdk-confirmed-turn' : nativeTurn
          expect(interrupts(channel)[0].message.params).toEqual({ threadId: nativeThread, turnId })
          expect(stopEvents(fixture)).toEqual([])
          await channel.reply(interrupted(nativeThread, turnId))
          await vi.waitFor(async () => {
            await fixture.agents.flushRecovery()
            expect(stopEvents(fixture)).toHaveLength(1)
          })
          const after = await run(fixture.store.readTransport(fixture.transport.id))
          expect(after.inputs.filter((input) => input.semantic.kind === kind)).toHaveLength(1)
          expect(after.inputs.filter((input) => input.semantic.kind === 'interrupt')).toHaveLength(
            1,
          )
        },
        undefined,
        kind === 'user-prompt'
          ? { phase: 'startingTurn', state: 'starting', nativeTurnId: undefined }
          : {},
      ))
  }

  it('an exact settings SDK reply releases recovered Stop without inventing an original pipe receipt', () =>
    withFixture(
      'codex',
      async (fixture) => {
        await admitOriginalPrompt(fixture)
        const admitted = await run(
          fixture.store.reserveInput(
            fixture.transport.id,
            {
              type: 'write',
              data: encoded({
                id: 91,
                method: 'thread/settings/update',
                params: { threadId: nativeThread, model: 'sdk-confirmed-model' },
              }),
            },
            {
              kind: 'settings',
              sessionId: 'life-session',
              ownerGeneration: 3,
              nativeThreadId: nativeThread,
              method: 'thread/settings/update',
              requestId: 91,
              details: {
                requestedSettings: { model: 'sdk-confirmed-model' },
                nativeSettings: { model: 'sdk-confirmed-model' },
                permissionBoundaryChanged: false,
              },
            },
          ),
        )
        await run(fixture.store.acknowledgeInput(fixture.transport.id, admitted.sequence))
        await persistStop(fixture)
        const before = await run(fixture.store.readTransport(fixture.transport.id))
        const original = before.inputs.find((input) => input.sequence === admitted.sequence)!
        const channel = await recovered(fixture)
        const confirmProcessed = vi.fn((sequence: number) => {
          expect(sequence).toBe(original.sequence)
          expect(decodeInput(original)).toMatchObject({ id: original.semantic.requestId })
          channel.hasUnconfirmedRecoveryInputs = false
        })
        channel.confirmNativeInputProcessed = confirmProcessed
        expect(channel.hasUnconfirmedRecoveryInputs).toBe(true)
        expect(channel.nativeWrites).toEqual([])
        await channel.reply({ id: 999, result: {} })
        await channel.reply({ id: 91 })
        await fixture.agents.flushRecovery()
        expect(confirmProcessed).not.toHaveBeenCalled()
        expect(channel.hasUnconfirmedRecoveryInputs).toBe(true)
        expect(channel.nativeWrites).toEqual([])
        await channel.reply({ id: 91, result: {} })
        await vi.waitFor(() => expect(interrupts(channel)).toHaveLength(1))
        expect(confirmProcessed).toHaveBeenCalledExactlyOnceWith(original.sequence)
        expect(channel.hasUnconfirmedRecoveryInputs).toBe(false)
        const processed = await run(fixture.store.readTransport(fixture.transport.id))
        expect(processed.inputs.find((input) => input.sequence === original.sequence)).toEqual(
          original,
        )
        expect(original).toMatchObject({ acknowledged: true, written: false, consumed: false })
        expect(original.deliveryReceipt).toBeUndefined()
        expect(channel.nativeWrites.filter((input) => input.semantic.kind === 'settings')).toEqual(
          [],
        )
        expect(interrupts(channel)[0].message.params).toEqual({
          threadId: nativeThread,
          turnId: nativeTurn,
        })
        const stopping = fixture.agents.stop('life-session')
        expect(stopEvents(fixture)).toEqual([])
        await channel.reply(interrupted())
        await stopping
        await fixture.agents.flushRecovery()
        const final = await run(fixture.store.readTransport(fixture.transport.id))
        expect(final.inputs.find((input) => input.sequence === original.sequence)).toEqual(original)
        expect(final.inputs.filter((input) => input.semantic.kind === 'settings')).toHaveLength(1)
        expect(final.inputs.filter((input) => input.semantic.kind === 'interrupt')).toHaveLength(1)
        expect(final.inputs.filter((input) => input.semantic.kind === 'user-prompt')).toHaveLength(
          1,
        )
        expect(stopEvents(fixture)).toHaveLength(1)
      },
      (channel) => {
        channel.hasUnconfirmedRecoveryInputs = true
      },
    ))

  it.each(['codex', 'claude'] as const)(
    'Stop denies only the newer %s permission occurrence when its native wire ID is reused in the same generation',
    async (provider) => {
      await withFixture(
        provider,
        async (fixture) => {
          await admitOriginalPrompt(fixture)
          const wireId = provider === 'codex' ? 19 : 'same-opaque-native-permission'
          const permission = (occurrence: string) =>
            provider === 'codex'
              ? {
                  id: wireId,
                  method: 'item/commandExecution/requestApproval',
                  params: {
                    threadId: nativeThread,
                    turnId: nativeTurn,
                    itemId: `native-command-${occurrence}`,
                    command: `printf "${occurrence} exact 雪"`,
                    cwd: '/project',
                  },
                }
              : {
                  type: 'control_request',
                  request_id: wireId,
                  session_id: nativeThread,
                  request: {
                    subtype: 'can_use_tool',
                    tool_name: 'Bash',
                    tool_use_id: `native-command-${occurrence}`,
                    input: { command: `printf "${occurrence} exact 雪"`, exact: '\ud800' },
                  },
                }
          await appendMessages(fixture, [permission('first')])
          const channel = await recovered(fixture)
          const firstRequestId = fixture.events.find(
            (event) => event.type === 'approval',
          )!.requestId!
          await fixture.agents.respond('life-session', firstRequestId, true)
          const before = await run(fixture.store.readTransport(fixture.transport.id))
          const original = before.inputs.find(
            (input) => input.semantic.kind === 'permission-response',
          )!
          expect(original).toMatchObject({ acknowledged: true, written: true })
          expect(original.semantic.responseBinding).toMatchObject({
            requestId: firstRequestId,
            status: 'approved',
          })
          const liveStart = fixture.events.length
          await channel.reply(permission('second'))
          await fixture.agents.flushRecovery()
          const nextApproval = fixture.events
            .slice(liveStart)
            .find((event) => event.type === 'approval')!
          const nextRequestId = nextApproval.requestId!
          expect(nextRequestId).not.toBe(firstRequestId)
          expect(nextApproval.nativeRecovery?.ownerGeneration).toBe(3)
          expect(nextApproval.details).toMatchObject(
            provider === 'codex'
              ? { itemId: 'native-command-second' }
              : { tool_use_id: 'native-command-second' },
          )
          const stopping = fixture.agents.stop('life-session')
          await vi.waitFor(() => expect(interrupts(channel)).toHaveLength(1))
          const admitted = await run(fixture.store.readTransport(fixture.transport.id))
          const responses = admitted.inputs.filter(
            (input) => input.semantic.kind === 'permission-response',
          )
          expect(responses).toHaveLength(2)
          expect(responses[0]).toEqual(original)
          expect(responses.map((input) => input.semantic.permissionRequestId)).toEqual([
            wireId,
            wireId,
          ])
          expect(responses[1].semantic.responseBinding).toMatchObject({
            requestId: nextRequestId,
            status: 'declined',
            params:
              provider === 'codex'
                ? { itemId: 'native-command-second' }
                : { tool_use_id: 'native-command-second' },
          })
          expect(decodeInput(responses[1])).toEqual(
            provider === 'codex'
              ? { id: wireId, result: { decision: 'decline' } }
              : {
                  type: 'control_response',
                  response: {
                    subtype: 'success',
                    request_id: wireId,
                    response: { behavior: 'deny', message: 'The user declined this action' },
                  },
                },
          )
          expect(
            channel.nativeWrites.filter((input) => input.semantic.kind === 'permission-response'),
          ).toHaveLength(2)
          if (provider === 'codex') {
            expect(interrupts(channel)[0].message.params).toEqual({
              threadId: nativeThread,
              turnId: nativeTurn,
            })
            expect(stopEvents(fixture)).toEqual([])
            await channel.reply(interrupted())
          }
          await stopping
          await fixture.agents.flushRecovery()
          const final = await run(fixture.store.readTransport(fixture.transport.id))
          const resolutions = final.events
            .filter((entry) => entry.event.type === 'request-resolved')
            .map((entry) => ({ requestId: entry.event.requestId, status: entry.event.status }))
          expect(resolutions).toEqual([
            { requestId: firstRequestId, status: 'approved' },
            { requestId: nextRequestId, status: 'declined' },
          ])
          expect(final.inputs.filter((input) => input.semantic.kind === 'interrupt')).toHaveLength(
            1,
          )
          expect(
            final.inputs.filter((input) => input.semantic.kind === 'user-prompt'),
          ).toHaveLength(1)
          expect(stopEvents(fixture)).toHaveLength(1)
          expect(fixture.ssh.channel).not.toHaveBeenCalled()
          expect(fixture.ssh.exec).not.toHaveBeenCalled()
          expect(generateTitle).not.toHaveBeenCalled()
        },
        (channel) => {
          channel.autoExitOnClose = provider === 'claude'
        },
      )
    },
  )

  it('a failed Stop owner commit rejects repeated Stop without changing pending native work', () =>
    withFixture('codex', async (fixture) => {
      await admitOriginalPrompt(fixture)
      await appendMessages(fixture, [
        {
          id: 'quiet-native-permission',
          method: 'item/commandExecution/requestApproval',
          params: {
            threadId: nativeThread,
            turnId: nativeTurn,
            itemId: 'quiet-native-command',
            command: 'printf exact',
            cwd: '/project',
          },
        },
      ])
      const channel = await recovered(fixture)
      const before = await run(fixture.store.readTransport(fixture.transport.id))
      expect(before.events.some((event) => event.event.type === 'approval')).toBe(true)
      expect(before.inputs.some((input) => input.semantic.kind === 'permission-response')).toBe(
        false,
      )
      const failure = new NativeRecoveryError({
        operation: 'update-owner',
        path: fixture.transport.id,
        reason: 'io',
        message: 'Injected Stop owner write-ahead failure before commit',
      })
      const writing = vi
        .spyOn(fixture.store, 'updateTransport')
        .mockImplementationOnce(() => Effect.fail(failure))
      await expect(fixture.agents.stop('life-session')).rejects.toBe(failure)
      expect(writing).toHaveBeenCalledTimes(1)
      expect(
        writing.mock.calls[0][1].owners?.find((owner) => owner.kind === 'root')?.stopRequested,
      ).toBe(true)
      let secondOutcome: unknown
      const second = fixture.agents.stop('life-session').then(
        () => {
          secondOutcome = 'accepted'
        },
        (error) => {
          secondOutcome = error
        },
      )
      await vi.waitFor(() => expect(secondOutcome).toBeInstanceOf(NativeRecoveryError), {
        timeout: 500,
      })
      await second
      expect(secondOutcome).toMatchObject({
        operation: 'stop',
        reason: 'uncertain',
        cause: failure,
      })
      let thirdOutcome: unknown
      const third = fixture.agents.stop('life-session').then(
        () => {
          thirdOutcome = 'accepted'
        },
        (error) => {
          thirdOutcome = error
        },
      )
      await vi.waitFor(() => expect(thirdOutcome).toBe(secondOutcome), { timeout: 500 })
      await third
      expect(writing).toHaveBeenCalledTimes(1)
      await fixture.agents.flushRecovery()
      const after = await run(fixture.store.readTransport(fixture.transport.id))
      expect(after).toEqual(before)
      expect(after.transport.owners[0]).toMatchObject({
        state: 'active',
        nativeThreadId: nativeThread,
        nativeTurnId: nativeTurn,
      })
      expect(after.transport.owners[0].stopRequested).not.toBe(true)
      expect(channel.nativeWrites).toEqual([])
      expect(channel.permissionAdmissionAttempts).toEqual([])
      expect(channel.rawWrites).toEqual([])
      expect(channel.terminalWrites).toEqual([])
      expect(channel.signalNativeAndWait).not.toHaveBeenCalled()
      expect(channel.closeNativeAndWait).not.toHaveBeenCalled()
      expect(channel.signal).not.toHaveBeenCalled()
      expect(channel.close).not.toHaveBeenCalled()
      expect(channel.destroyed).toBe(false)
      expect(stopEvents(fixture)).toEqual([])
      expect(fixture.events.some((event) => event.type === 'request-resolved')).toBe(false)
      expect(fixture.ssh.channel).not.toHaveBeenCalled()
      expect(fixture.ssh.exec).not.toHaveBeenCalled()
      expect(generateTitle).not.toHaveBeenCalled()
    }))

  for (const provider of ['codex', 'claude'] as const) {
    it(`${provider}: continues a committed Stop before its first wire action exactly once`, () =>
      withFixture(
        provider,
        async (fixture) => {
          await admitOriginalPrompt(fixture)
          await persistStop(fixture)
          const before = await run(fixture.store.readTransport(fixture.transport.id))
          expect(before.inputs.some((input) => input.semantic.kind === 'interrupt')).toBe(false)
          const channel = await recovered(fixture)
          expect(interrupts(channel)).toHaveLength(1)
          const native = interrupts(channel)[0]
          expect(native.semantic.sessionId).toBe('life-session')
          expect(native.semantic.ownerGeneration).toBe(3)
          expect(channel.rawWrites).toEqual([])
          expect(fixture.ssh.channel).not.toHaveBeenCalled()
          expect(fixture.ssh.exec).not.toHaveBeenCalled()
          expect(generateTitle).not.toHaveBeenCalled()
          if (provider === 'codex') {
            expect(native.message.params).toEqual({ threadId: nativeThread, turnId: nativeTurn })
            expect(stopEvents(fixture)).toEqual([])
            await channel.reply(interrupted())
          }
          await vi.waitFor(async () => {
            await fixture.agents.flushRecovery()
            expect(stopEvents(fixture).map((event) => event.nativeRecovery?.eventId)).toEqual([
              expect.any(String),
            ])
            expect(
              (await run(fixture.store.readTransport(fixture.transport.id))).transport.owners.find(
                (owner) => owner.kind === 'root',
              )?.state,
            ).toBe('idle')
          })
          const after = await run(fixture.store.readTransport(fixture.transport.id))
          expect(
            after.inputs.filter((input) => input.semantic.kind === 'user-prompt'),
          ).toHaveLength(1)
          expect(after.inputs.filter((input) => input.semantic.kind === 'interrupt')).toHaveLength(
            1,
          )
          expect(
            after.events.filter(
              (event) => event.event.type === 'complete' && event.event.status === 'interrupted',
            ),
          ).toHaveLength(1)
          expect(
            new Set(stopDeliveries(fixture).map((event) => event.nativeRecovery?.eventId)),
          ).toEqual(new Set([stopEvents(fixture)[0].nativeRecovery!.eventId]))
          expect(after.transport.owners.find((owner) => owner.kind === 'root')?.state).toBe('idle')
          expect(
            provider === 'claude' ? after.outputs.some((output) => output.type === 'exit') : true,
          ).toBe(true)
          await fixture.agents.recover({ consumers: [consumer()] })
          expect(interrupts(channel)).toHaveLength(1)
        },
        (channel) => {
          channel.autoExitOnClose = provider === 'claude'
        },
      ))

    it(`${provider}: retries only the original numbered interrupt after a lost delivery acknowledgment`, () =>
      withFixture(
        provider,
        async (fixture) => {
          await admitOriginalPrompt(fixture)
          await persistStop(fixture)
          const message =
            provider === 'codex'
              ? {
                  id: 91,
                  method: 'turn/interrupt',
                  params: { threadId: nativeThread, turnId: nativeTurn },
                }
              : {
                  type: 'control_request',
                  request_id: 'original-stop-control',
                  request: { subtype: 'interrupt' },
                }
          const original = await run(
            fixture.store.reserveInput(
              fixture.transport.id,
              { type: 'write', data: encoded(message) },
              {
                kind: 'interrupt',
                sessionId: 'life-session',
                ownerGeneration: 3,
                nativeThreadId: nativeThread,
                ...(provider === 'codex'
                  ? { method: 'turn/interrupt', requestId: 91, nativeTurnId: nativeTurn }
                  : {
                      requestType: 'interrupt',
                      requestId: 'original-stop-control',
                      details: { request: { subtype: 'interrupt' } },
                    }),
              },
            ),
          )
          const channel = await recovered(fixture)
          expect(
            channel.replayedInputs.map((input) => ({ sequence: input.sequence, wire: input.wire })),
          ).toEqual([{ sequence: original.sequence, wire: original.wire }])
          expect(interrupts(channel)).toHaveLength(1)
          expect(interrupts(channel)[0].sequence).toBe(original.sequence)
          expect(interrupts(channel)[0].wire).toBe(original.wire)
          if (provider === 'codex') await channel.reply(interrupted())
          await vi.waitFor(async () => {
            await fixture.agents.flushRecovery()
            expect(stopEvents(fixture)).toHaveLength(1)
          })
          const after = await run(fixture.store.readTransport(fixture.transport.id))
          expect(after.inputs.filter((input) => input.semantic.kind === 'interrupt')).toHaveLength(
            1,
          )
          expect(after.inputs.find((input) => input.sequence === original.sequence)?.written).toBe(
            true,
          )
        },
        (channel) => {
          channel.autoExitOnClose = provider === 'claude'
        },
      ))
  }

  it('Codex native interrupt acceptance alone keeps the Stop and writer active', () =>
    withFixture('codex', async (fixture) => {
      await admitOriginalPrompt(fixture)
      await persistStop(fixture)
      const channel = await recovered(fixture)
      await vi.waitFor(() => expect(interrupts(channel)).toHaveLength(1))
      await fixture.agents.flushRecovery()
      expect(stopEvents(fixture)).toEqual([])
      const pending = await run(fixture.store.readTransport(fixture.transport.id))
      expect(pending.inputs.filter((input) => input.semantic.kind === 'interrupt')[0].written).toBe(
        true,
      )
      expect(pending.transport.owners.find((owner) => owner.kind === 'root')?.state).toBe('active')
      await expect(fixture.agents.start(nextInput('codex'))).rejects.toThrow(
        /running|Stop|closing/i,
      )
      expect(interrupts(channel)).toHaveLength(1)
      await channel.reply(interrupted())
      await vi.waitFor(async () => {
        await fixture.agents.flushRecovery()
        expect(stopEvents(fixture)).toHaveLength(1)
      })
    }))

  it('Codex scopes root and historical-generation child interrupts to their exact IDs', () =>
    withFixture('codex', async (fixture) => {
      await admitOriginalPrompt(fixture)
      await appendMessages(fixture, [
        {
          method: 'thread/started',
          params: {
            thread: {
              id: 'native-child',
              parentThreadId: nativeThread,
              status: { type: 'active' },
            },
          },
        },
        {
          method: 'turn/started',
          params: {
            threadId: 'native-child',
            turn: { id: 'native-child-turn', status: 'inProgress' },
          },
        },
      ])
      const before = await run(fixture.store.readTransport(fixture.transport.id))
      const current = before.transport.owners.find((owner) => owner.kind === 'root')!
      await run(
        fixture.store.updateTransport(fixture.transport.id, {
          owners: [
            {
              ...current,
              generation: 4,
              localTurn: 8,
              snapshotToken: 'private-next-root-generation',
              nativeTurnId: 'native-next-turn',
            },
          ],
        }),
      )
      const next = await run(
        fixture.store.reserveInput(
          fixture.transport.id,
          {
            type: 'write',
            data: encoded({
              id: 13,
              method: 'turn/start',
              params: {
                threadId: nativeThread,
                input: [{ type: 'text', text: 'exact next-root prompt' }],
              },
            }),
          },
          {
            kind: 'user-prompt',
            sessionId: 'life-session',
            ownerGeneration: 4,
            method: 'turn/start',
            requestId: 13,
            nativeThreadId: nativeThread,
          },
        ),
      )
      await run(fixture.store.acknowledgeInput(fixture.transport.id, next.sequence))
      await appendInputReceipt(fixture.store, fixture.transport.id, next.sequence)
      await appendMessages(fixture, [{ id: 13, result: { turn: { id: 'native-next-turn' } } }])
      await persistStop(fixture)
      const channel = await recovered(fixture)
      expect(
        interrupts(channel).map((input) => ({
          params: input.message.params,
          generation: input.semantic.ownerGeneration,
        })),
      ).toEqual([
        { params: { threadId: nativeThread, turnId: 'native-next-turn' }, generation: 4 },
        { params: { threadId: 'native-child', turnId: 'native-child-turn' }, generation: 3 },
      ])
      expect(stopEvents(fixture)).toEqual([])
      await channel.reply(interrupted(nativeThread, 'native-next-turn'))
      await fixture.agents.flushRecovery()
      expect(stopEvents(fixture)).toEqual([])
      await channel.reply(interrupted('native-child', 'native-child-turn'))
      await vi.waitFor(async () => {
        await fixture.agents.flushRecovery()
        expect(stopEvents(fixture)).toHaveLength(1)
      })
      expect(channel.close).not.toHaveBeenCalled()
      expect(channel.signal).not.toHaveBeenCalled()
    }))

  it('Claude close acceptance and timeout block replacement until actual native exit', () =>
    withFixture('claude', async (fixture) => {
      await admitOriginalPrompt(fixture)
      await persistStop(fixture)
      const launched = installLaunch(fixture)
      const channel = await recovered(fixture)
      expect(interrupts(channel)).toHaveLength(1)
      expect(
        channel.terminalWrites.map((input) => ({
          frame: input.frame.type,
          method: input.semantic.method,
          generation: input.semantic.ownerGeneration,
        })),
      ).toEqual([
        { frame: 'signal', method: 'life/stop-signal', generation: 3 },
        { frame: 'close', method: 'life/stop-close', generation: 3 },
      ])
      const waiting = await run(fixture.store.readTransport(fixture.transport.id))
      expect(waiting.closeInputSequence).toBeDefined()
      expect(
        waiting.inputs.find((input) => input.sequence === waiting.closeInputSequence)?.written,
      ).toBe(false)
      expect(waiting.outputs.some((output) => output.type === 'exit')).toBe(false)
      expect(stopEvents(fixture)).toEqual([])
      await expect(fixture.agents.start(nextInput('claude'))).rejects.toThrow(
        /closing|Stop|native owner|process/i,
      )
      expect(launched).toEqual([])
      await channel.nativeExit()
      await vi.waitFor(async () => {
        await fixture.agents.flushRecovery()
        expect(stopEvents(fixture)).toHaveLength(1)
      })
      await fixture.agents.start(nextInput('claude'))
      expect(launched).toHaveLength(1)
      const replacement = await run(fixture.store.readTransport(launched[0].recoveryId))
      expect(
        replacement.inputs.filter((input) => input.semantic.kind === 'user-prompt'),
      ).toHaveLength(1)
      expect(stopEvents(fixture)).toHaveLength(1)
    }))

  it('Claude terminal turn output cannot admit another Start while Stop signal is unresolved', () =>
    withFixture('claude', async (fixture) => {
      await admitOriginalPrompt(fixture)
      await persistStop(fixture)
      const launched = installLaunch(fixture)
      let releaseSignal!: () => void
      const held = new Promise<void>((resolve) => {
        releaseSignal = resolve
      })
      fixture.open.mockImplementationOnce(async (_host, _command, options) => {
        if (!options || !('snapshot' in options) || !options.snapshot)
          throw new Error('Missing recovery snapshot')
        const channel = new ReattachedChannel(options.snapshot.transport.id, fixture.store)
        channel.holdSignal = held
        fixture.attachments.push(channel)
        return channel as unknown as DurableRemoteChannel
      })
      const restoring = fixture.agents.recover({ consumers: [consumer()] })
      try {
        await vi.waitFor(() =>
          expect(fixture.attachments[0]?.signalNativeAndWait).toHaveBeenCalledTimes(1),
        )
        const channel = fixture.attachments[0]
        await channel.reply({
          type: 'result',
          subtype: 'success',
          session_id: nativeThread,
          is_error: false,
          result: '',
        })
        await fixture.agents.flushRecovery()
        expect(channel.isClosing).toBe(false)
        let startOutcome: unknown
        const starting = fixture.agents.start(nextInput('claude')).then(
          () => {
            startOutcome = 'accepted'
          },
          (error) => {
            startOutcome = error
          },
        )
        await vi.waitFor(() => expect(startOutcome).toBeInstanceOf(Error), { timeout: 500 })
        expect((startOutcome as Error).message).toMatch(/Stop|closing|native|retir/i)
        await starting
        expect(launched).toEqual([])
      } finally {
        releaseSignal()
        await restoring
      }
    }))

  it('Stop during the pre-send owner checkpoint cannot dispatch a prompt after being acknowledged', () =>
    withFixture('codex', async (fixture) => {
      await admitOriginalPrompt(fixture)
      const channel = await recovered(fixture)
      const first = fixture.agents.stop('life-session')
      await vi.waitFor(() => expect(interrupts(channel)).toHaveLength(1))
      await channel.reply(interrupted())
      await first
      const input = nextInput('codex')
      const gate = Deferred.makeUnsafe<void>()
      let held = false
      const target = fixture.agents as unknown as {
        recordRecoveryOwner: (
          session: { input: StartInput; phase: string; stopRequested: boolean },
          channel: ClientChannel,
        ) => Promise<void>
      }
      const original = target.recordRecoveryOwner.bind(fixture.agents)
      vi.spyOn(target, 'recordRecoveryOwner').mockImplementation(async (session, attachment) => {
        await original(session, attachment)
        if (
          !held &&
          session.input === input &&
          session.phase === 'startingTurn' &&
          !session.stopRequested
        ) {
          held = true
          await run(Deferred.await(gate))
        }
      })
      const starting = fixture.agents.start(input)
      try {
        await vi.waitFor(() => expect(held).toBe(true))
        await fixture.agents.stop('life-session')
        expect(
          channel.nativeWrites.filter((entry) => entry.message.method === 'turn/start'),
        ).toEqual([])
      } finally {
        Deferred.doneUnsafe(gate, Effect.void)
        await starting
      }
      expect(channel.nativeWrites.filter((entry) => entry.message.method === 'turn/start')).toEqual(
        [],
      )
      expect(interrupts(channel)).toHaveLength(1)
      expect(stopEvents(fixture)).toHaveLength(2)
      expect(fixture.agents.hasRunningSessions()).toBe(false)
    }))

  it('a subsequent explicit Send and Stop get a fresh completion boundary', () =>
    withFixture('codex', async (fixture) => {
      await admitOriginalPrompt(fixture)
      const channel = await recovered(fixture)
      let firstSettled = false
      const first = fixture.agents.stop('life-session').then(() => {
        firstSettled = true
      })
      await vi.waitFor(() => expect(interrupts(channel)).toHaveLength(1))
      expect(firstSettled).toBe(false)
      await channel.reply(interrupted())
      await first
      expect(firstSettled).toBe(true)
      await fixture.agents.start(nextInput('codex'))
      const nextPrompt = channel.nativeWrites.findLast(
        (input) => input.message.method === 'turn/start',
      )!
      const nextTurn = `turn-next-${nextPrompt.message.id}`
      let secondSettled = false
      const second = fixture.agents.stop('life-session').then(() => {
        secondSettled = true
      })
      await vi.waitFor(() => expect(interrupts(channel)).toHaveLength(2))
      expect(secondSettled).toBe(false)
      expect(interrupts(channel)[1].message.params).toEqual({
        threadId: nativeThread,
        turnId: nextTurn,
      })
      await channel.reply(interrupted(nativeThread, nextTurn))
      await second
      expect(secondSettled).toBe(true)
      await fixture.agents.flushRecovery()
      expect(stopEvents(fixture)).toHaveLength(2)
    }))

  it('an unresolved original user prompt obtains its own native identity before one Stop', () =>
    withFixture(
      'codex',
      async (fixture) => {
        const original = await admitOriginalPrompt(fixture, false)
        await persistStop(fixture, {
          phase: 'startingTurn',
          state: 'starting',
          nativeTurnId: undefined,
        })
        const channel = await recovered(fixture)
        await vi.waitFor(() => expect(interrupts(channel)).toHaveLength(1))
        const prompts = channel.nativeWrites.filter(
          (input) => input.message.method === 'turn/start',
        )
        expect(prompts).toHaveLength(1)
        expect(prompts[0].sequence).toBe(original.sequence)
        expect(prompts[0].wire).toBe(original.wire)
        expect(prompts[0].message.params).toEqual({
          threadId: nativeThread,
          input: [{ type: 'text', text: exactPrompt }],
        })
        expect(interrupts(channel)[0].message.params).toEqual({
          threadId: nativeThread,
          turnId: 'turn-next-12',
        })
        expect(stopEvents(fixture)).toEqual([])
        await channel.reply(interrupted(nativeThread, 'turn-next-12'))
        await vi.waitFor(async () => {
          await fixture.agents.flushRecovery()
          expect(stopEvents(fixture)).toHaveLength(1)
        })
        const after = await run(fixture.store.readTransport(fixture.transport.id))
        expect(after.inputs.filter((input) => input.semantic.kind === 'user-prompt')).toHaveLength(
          1,
        )
        expect(after.inputs.filter((input) => input.semantic.kind === 'interrupt')).toHaveLength(1)
        expect(generateTitle).not.toHaveBeenCalled()
      },
      undefined,
      { phase: 'startingTurn', state: 'starting', nativeTurnId: undefined },
    ))

  for (const provider of ['codex', 'claude'] as const) {
    it(`${provider}: Stop joins an exact permission response already waiting for outbox admission`, () =>
      withFixture(
        provider,
        async (fixture) => {
          await admitOriginalPrompt(fixture)
          await appendMessages(fixture, [
            provider === 'codex'
              ? {
                  id: 'native-permission',
                  method: 'item/commandExecution/requestApproval',
                  params: {
                    threadId: nativeThread,
                    turnId: nativeTurn,
                    itemId: 'native-command',
                    command: 'printf exact',
                    cwd: '/project',
                  },
                }
              : {
                  type: 'control_request',
                  request_id: 'native-permission',
                  session_id: nativeThread,
                  request: {
                    subtype: 'can_use_tool',
                    tool_name: 'Bash',
                    input: { command: 'printf exact' },
                  },
                },
          ])
          const channel = await recovered(fixture)
          let releasePermission!: () => void
          channel.holdPermissionAdmission = new Promise<void>((resolve) => {
            releasePermission = resolve
          })
          const localId =
            provider === 'codex'
              ? `${fixture.transport.id}:request:string:native-permission`
              : 'native-permission'
          const responding = fixture.agents.respond('life-session', localId, true)
          const responseSettled = responding.catch(() => undefined)
          await vi.waitFor(() => expect(channel.permissionAdmissionAttempts).toHaveLength(1))
          const stopping = fixture.agents.stop('life-session')
          const stopSettled = stopping.catch(() => undefined)
          try {
            await vi.waitFor(async () => {
              const current = await run(fixture.store.readTransport(fixture.transport.id))
              expect(
                current.transport.owners.find((owner) => owner.kind === 'root')?.stopRequested,
              ).toBe(true)
            })
            expect(
              (await run(fixture.store.readTransport(fixture.transport.id))).inputs.filter(
                (input) => input.semantic.kind === 'permission-response',
              ),
            ).toEqual([])
          } finally {
            releasePermission()
          }
          await responding
          await responseSettled
          await vi.waitFor(() => expect(interrupts(channel)).toHaveLength(1))
          if (provider === 'codex') await channel.reply(interrupted())
          await stopping
          await stopSettled
          await fixture.agents.flushRecovery()
          const final = await run(fixture.store.readTransport(fixture.transport.id))
          const admitted = final.inputs.filter(
            (input) => input.semantic.kind === 'permission-response',
          )
          expect(admitted).toHaveLength(1)
          expect(admitted[0].semantic.responseBinding).toMatchObject({
            requestId: localId,
            status: 'approved',
          })
          expect(channel.permissionAdmissionAttempts).toHaveLength(1)
        },
        (channel) => {
          channel.autoExitOnClose = provider === 'claude'
        },
      ))
  }

  it('native Claude exit resolves Stop even when its interrupt response never arrives', () =>
    withFixture('claude', async (fixture) => {
      await admitOriginalPrompt(fixture)
      const channel = await recovered(fixture)
      channel.heldMethods.add('interrupt')
      let outcome: 'pending' | 'resolved' | Error = 'pending'
      const stopping = fixture.agents.stop('life-session').then(
        () => {
          outcome = 'resolved'
        },
        (error) => {
          outcome = error
        },
      )
      await vi.waitFor(() => expect(interrupts(channel)).toHaveLength(1))
      expect(outcome).toBe('pending')
      await channel.nativeExit()
      await vi.waitFor(() => expect(outcome).toBe('resolved'))
      await stopping
      await fixture.agents.flushRecovery()
      expect(stopEvents(fixture)).toHaveLength(1)
      expect(channel.terminalWrites).toEqual([])
    }))

  it('a second explicit Claude Send and Stop have a new completion and native process', () =>
    withFixture('claude', async (fixture) => {
      await admitOriginalPrompt(fixture)
      const firstChannel = await recovered(fixture)
      firstChannel.autoExitOnClose = true
      const launched = installLaunch(fixture)
      await fixture.agents.stop('life-session')
      await fixture.agents.flushRecovery()
      expect(stopEvents(fixture)).toHaveLength(1)
      await fixture.agents.start(nextInput('claude'))
      expect(launched).toHaveLength(1)
      const secondChannel = launched[0]
      secondChannel.autoExitOnClose = true
      secondChannel.heldMethods.add('interrupt')
      let settled = false
      const stopping = fixture.agents.stop('life-session').then(() => {
        settled = true
      })
      const observed = stopping.catch(() => undefined)
      await vi.waitFor(() => expect(interrupts(secondChannel)).toHaveLength(1))
      expect(settled).toBe(false)
      const original = interrupts(secondChannel)[0].message
      await secondChannel.reply({
        type: 'control_response',
        response: {
          subtype: 'success',
          request_id: original.request_id,
          response: {},
        },
      })
      await stopping
      await observed
      await fixture.agents.flushRecovery()
      expect(settled).toBe(true)
      expect(stopEvents(fixture)).toHaveLength(2)
      expect(
        new Set(stopEvents(fixture).map((event) => event.nativeRecovery?.transportId)).size,
      ).toBe(2)
      const second = await run(fixture.store.readTransport(secondChannel.recoveryId))
      expect(second.inputs.filter((input) => input.semantic.kind === 'user-prompt')).toHaveLength(1)
      expect(second.inputs.filter((input) => input.semantic.kind === 'interrupt')).toHaveLength(1)
      expect(second.outputs.some((output) => output.type === 'exit')).toBe(true)
    }))

  it('an explicitly registered historical child retains its own generation during root Stop', () =>
    withFixture('codex', async (fixture) => {
      await admitOriginalPrompt(fixture)
      const before = await run(fixture.store.readTransport(fixture.transport.id))
      const child: NativeRecoveryOwner = {
        ...before.transport.owners[0],
        ownerId: 'registered-native-child',
        sessionId: 'life-child-session',
        kind: 'child',
        parentSessionId: 'life-session',
        generation: 2,
        snapshotToken: 'private-child-generation-two',
        nativeThreadId: 'registered-child-thread',
        nativeTurnId: 'registered-child-turn',
        input: {
          ...before.transport.owners[0].input,
          sessionId: 'life-child-session',
          remoteId: 'registered-child-thread',
        },
      }
      await run(
        fixture.store.updateTransport(fixture.transport.id, {
          owners: [...before.transport.owners, child],
        }),
      )
      await persistStop(fixture)
      const channel = await recovered(fixture)
      expect(
        interrupts(channel).map((input) => ({
          params: input.message.params,
          generation: input.semantic.ownerGeneration,
        })),
      ).toEqual([
        { params: { threadId: nativeThread, turnId: nativeTurn }, generation: 3 },
        {
          params: { threadId: 'registered-child-thread', turnId: 'registered-child-turn' },
          generation: 2,
        },
      ])
      await channel.reply(interrupted())
      await fixture.agents.flushRecovery()
      expect(stopEvents(fixture)).toEqual([])
      await channel.reply(interrupted('registered-child-thread', 'registered-child-turn'))
      await vi.waitFor(async () => {
        await fixture.agents.flushRecovery()
        expect(stopEvents(fixture)).toHaveLength(1)
      })
    }))

  it('Stop leaves an unrelated active root on the shared Codex transport running', () =>
    withFixture('codex', async (fixture) => {
      await admitOriginalPrompt(fixture)
      const before = await run(fixture.store.readTransport(fixture.transport.id))
      const sibling: NativeRecoveryOwner = {
        ...before.transport.owners[0],
        ownerId: 'shared-other-session',
        sessionId: 'shared-other-session',
        generation: 11,
        snapshotToken: 'private-shared-other-token',
        nativeThreadId: 'shared-other-thread',
        nativeTurnId: 'shared-other-turn',
        input: {
          ...before.transport.owners[0].input,
          sessionId: 'shared-other-session',
          remoteId: 'shared-other-thread',
          prompt: 'Exact other root prompt',
        },
      }
      await run(
        fixture.store.updateTransport(fixture.transport.id, {
          owners: [...before.transport.owners, sibling],
        }),
      )
      const prompt = await run(
        fixture.store.reserveInput(
          fixture.transport.id,
          {
            type: 'write',
            data: encoded({
              id: 14,
              method: 'turn/start',
              params: {
                threadId: 'shared-other-thread',
                input: [{ type: 'text', text: 'Exact other root prompt' }],
              },
            }),
          },
          {
            kind: 'user-prompt',
            sessionId: sibling.sessionId,
            ownerGeneration: 11,
            method: 'turn/start',
            requestId: 14,
            nativeThreadId: sibling.nativeThreadId,
          },
        ),
      )
      await run(fixture.store.acknowledgeInput(fixture.transport.id, prompt.sequence))
      await appendInputReceipt(fixture.store, fixture.transport.id, prompt.sequence)
      await appendMessages(fixture, [{ id: 14, result: { turn: { id: 'shared-other-turn' } } }])
      await persistStop(fixture)
      const channel = await recovered(fixture)
      expect(interrupts(channel)).toHaveLength(1)
      expect(interrupts(channel)[0].message.params).toEqual({
        threadId: nativeThread,
        turnId: nativeTurn,
      })
      await channel.reply(interrupted())
      await vi.waitFor(async () => {
        await fixture.agents.flushRecovery()
        expect(stopEvents(fixture)).toHaveLength(1)
      })
      expect(fixture.agents.runningSessionEvents()).toContainEqual(
        expect.objectContaining({
          sessionId: sibling.sessionId,
          type: 'status',
          status: 'running',
        }),
      )
      expect(channel.signal).not.toHaveBeenCalled()
      expect(channel.close).not.toHaveBeenCalled()
      expect(channel.terminalWrites).toEqual([])
      const final = await run(fixture.store.readTransport(fixture.transport.id))
      expect(
        final.transport.owners.find((owner) => owner.sessionId === sibling.sessionId),
      ).toMatchObject({ state: 'active', stopRequested: false })
      expect(
        final.inputs.some(
          (input) =>
            input.semantic.kind === 'interrupt' && input.semantic.sessionId === sibling.sessionId,
        ),
      ).toBe(false)
    }))

  it('ignored prior completion and bare idle cannot finish a pipe-written start awaiting its turn ID', () =>
    withFixture(
      'codex',
      async (fixture) => {
        const original = await admitOriginalPrompt(fixture, false)
        await persistStop(fixture, { ignoredTurns: ['prior-turn'] })
        const channel = await recovered(fixture)
        expect(channel.replayedInputs[0].sequence).toBe(original.sequence)
        expect(interrupts(channel)).toEqual([])
        await channel.reply(interrupted(nativeThread, 'prior-turn'))
        await channel.reply({
          method: 'thread/status/changed',
          params: { threadId: nativeThread, status: { type: 'idle' } },
        })
        await fixture.agents.flushRecovery()
        expect(stopEvents(fixture)).toEqual([])
        expect(interrupts(channel)).toEqual([])
        await channel.reply({ id: 12, result: { turn: { id: 'actual-current-turn' } } })
        await vi.waitFor(() => expect(interrupts(channel)).toHaveLength(1))
        expect(interrupts(channel)[0].message.params).toEqual({
          threadId: nativeThread,
          turnId: 'actual-current-turn',
        })
        await channel.reply(interrupted(nativeThread, 'actual-current-turn'))
        await vi.waitFor(async () => {
          await fixture.agents.flushRecovery()
          expect(stopEvents(fixture)).toHaveLength(1)
        })
      },
      (channel) => {
        channel.heldMethods.add('turn/start')
      },
      { phase: 'startingTurn', state: 'starting', nativeTurnId: undefined },
    ))
})
