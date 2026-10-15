import { createHash } from 'node:crypto'
import { EventEmitter } from 'node:events'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Effect } from 'effect'
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
  NativeRecoveryInputReceipt,
  NativeRecoveryOwner,
  NativeRecoverySnapshot,
  NativeRecoveryStoredInput,
  NativeRecoveryTransport,
} from '../src/main/native-recovery-types'
import type { SSHConnection } from '../src/main/ssh'
import type {
  AgentEvent,
  ConnectionState,
  NativeRecoveryConsumer,
  Provider,
} from '../src/shared/types'

const generateTitle = vi.hoisted(() => vi.fn(async () => undefined))
vi.mock('../src/main/provider-titles', () => ({ generateProviderTitle: generateTitle }))

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
  }[] = []
  readonly rawWrites: string[] = []
  readonly signal = vi.fn()
  readonly close = vi.fn()
  readonly detach = vi.fn(async () => {
    for (const waiter of this.pendingWriteReceipts.values())
      waiter.reject(new Error('Fixture attachment detached before its native write receipt'))
    this.pendingWriteReceipts.clear()
  })
  readonly resumeRecoveryOutput = vi.fn(() => {
    for (const receipt of this.bufferedWriteReceipts.splice(0)) {
      this.outputCursor = receipt.cursor
      this.emit('input-receipt', receipt)
    }
  })
  readonly waitForReplay = vi.fn(async () => undefined)
  readonly activateRecoveryInputs = vi.fn(async () => undefined)
  readonly recordOwner = vi.fn(async () => undefined)
  destroyed = false
  withholdWriteReceipts = false
  private readonly bufferedWriteReceipts: NativeRecoveryInputReceipt[] = []
  private readonly pendingWriteReceipts = new Map<
    number,
    { resolve: () => void; reject: (cause: Error) => void }
  >()

  constructor(
    readonly recoveryId: string,
    private readonly store: NativeRecoveryStoreHandle,
    public outputCursor = 0,
  ) {
    super()
  }

  write(value: string) {
    this.rawWrites.push(value)
    return true
  }

  bufferWriteReceipt(receipt: NativeRecoveryInputReceipt) {
    this.bufferedWriteReceipts.push(receipt)
  }

  async writeNativeAndWait(
    message: Record<string, unknown>,
    semantic: NativeRecoveryInputSemantic,
  ) {
    const input = await run(
      this.store.reserveInput(this.recoveryId, { type: 'write', data: encoded(message) }, semantic),
    )
    this.nativeWrites.push({ message, semantic })
    if (this.withholdWriteReceipts)
      return new Promise<void>((resolve, reject) => {
        this.pendingWriteReceipts.set(input.sequence, { resolve: () => resolve(), reject })
        this.emit('write-admitted', input)
      })
    this.emit('write-admitted', input)
    const receipt = await appendTransportInputReceipt(
      this.store,
      this.recoveryId,
      input.sequence,
      'written',
    )
    this.outputCursor = receipt.cursor
    // The actual channel fsyncs the receipt and publishes it before resolving
    // the native write waiter. An acceptance ACK never settles this boundary.
    this.emit('input-receipt', receipt)
  }
}

interface Fixture {
  store: NativeRecoveryStoreHandle
  transport: NativeRecoveryTransport
  agents: Agents
  ssh: SSHConnection
  events: AgentEvent[]
  attachments: ReattachedChannel[]
  open: MockInstance<typeof DurableRemoteChannel.open>
}

const scopedFixture = Effect.fn('tests.agentsNativeRecovery.fixture')(function* (
  provider: Provider,
  body: (fixture: Fixture) => Promise<void>,
  studio = false,
) {
  const directory = yield* Effect.acquireRelease(
    Effect.promise(() => mkdtemp(join(tmpdir(), 'life-agents-native-recovery-'))),
    (directory) => Effect.promise(() => rm(directory, { recursive: true, force: true })),
  )
  const store = yield* NativeRecoveryStore.make({ directory, outputBatchDelayMs: 1 })
  const original = descriptor(provider)
  const transport = studio
    ? {
        ...original,
        owners: original.owners.map((owner) => ({
          ...owner,
          input: { ...owner.input, scope: 'life-customization' },
        })),
      }
    : original
  yield* store.createTransport(transport)
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
      const channel = new ReattachedChannel(
        options.snapshot.transport.id,
        store,
        options.snapshot.outputCursor,
      )
      attachments.push(channel)
      return channel as unknown as DurableRemoteChannel
    })
  const events: AgentEvent[] = []
  const agents = new Agents(ssh, (event) => events.push(event), store)
  yield* Effect.tryPromise({
    try: async () => {
      try {
        await body({ store, transport, ssh, agents, events, attachments, open })
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
  studio = false,
) => Effect.runPromise(Effect.scoped(scopedFixture(provider, body, studio)))

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

async function appendTransportInputReceipt(
  store: NativeRecoveryStoreHandle,
  transportId: string,
  sequence: number,
  status: NativeRecoveryInputReceipt['status'],
) {
  const snapshot = await run(store.readTransport(transportId))
  const receipt: NativeRecoveryInputReceipt = {
    type: 'inputReceipt',
    cursor: snapshot.outputCursor + 1,
    sequence,
    status,
  }
  await run(store.appendOutputs(transportId, [receipt]))
  return receipt
}

async function appendInputReceipt(
  fixture: Fixture,
  sequence: number,
  status: NativeRecoveryInputReceipt['status'],
) {
  return appendTransportInputReceipt(fixture.store, fixture.transport.id, sequence, status)
}

async function admitOriginalPrompt(fixture: Fixture) {
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
  await appendInputReceipt(fixture, initialization.sequence, 'written')
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
    await appendInputReceipt(fixture, initialized.sequence, 'written')
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
  await appendInputReceipt(fixture, input.sequence, 'written')
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
          input: { command: 'printf "exact 🌍"' },
          futureNativeField: { exact: '\ud800', flags: [false, null] },
        },
      }
}

function permissionParams(provider: Provider) {
  const request = permission(provider)
  const params = request.params ?? request.request
  if (!params) throw new Error('The original native permission has no request parameters')
  return params
}

const localRequestId = (provider: Provider, id: string | number = 'native-permission-original') =>
  provider === 'codex'
    ? `${descriptor(provider).id}:request:${typeof id}:${String(id)}`
    : String(id)

async function completeCodexRun(fixture: Fixture) {
  await admitOriginalPrompt(fixture)
  await appendMessages(fixture, [
    {
      method: 'item/agentMessage/delta',
      params: {
        threadId: nativeThread,
        turnId: nativeTurn,
        itemId: 'native-answer',
        delta: exactReply,
      },
    },
    {
      method: 'turn/completed',
      params: {
        threadId: nativeThread,
        turn: { id: nativeTurn, status: 'completed' },
      },
    },
  ])
  const output = await run(fixture.store.readTransport(fixture.transport.id))
  await run(
    fixture.store.appendOutputs(fixture.transport.id, [
      { type: 'exit', cursor: output.outputCursor + 1, code: 0 },
    ]),
  )
}

describe('Agents native journal recovery', () => {
  it('preserves the exact cache clock through the Agents preparation and attestation boundaries', async () => {
    await withFixture('codex', async (fixture) => {
      await completeCodexRun(fixture)
      const recovered = await fixture.agents.recover({
        consumers: [{ ...consumer(), kind: 'main' }],
      })
      expect(recovered.owners[0].status).toBe('idle')
      expect(fixture.events.filter((event) => event.type === 'text')).toMatchObject([
        { text: exactReply },
      ])
      const before = await run(fixture.store.readTransport(fixture.transport.id))
      const delivered = fixture.events.at(-1)!.nativeRecovery!
      if (!delivered.deliveryToken)
        throw new Error('Main cache preparation requires an actual native delivery capability')
      const bytes = JSON.stringify([
        {
          id: 'life-session',
          provider: 'codex',
          profileId: 'machine-original',
          workspace: '/project',
          remoteId: nativeThread,
          messages: [
            { id: 'original-user', role: 'user', text: exactPrompt },
            { id: 'native-answer', role: 'assistant', text: exactReply },
          ],
          nativeRecovery: {
            [fixture.transport.id]: {
              appliedRevision: before.eventRevision,
              ownerGeneration: 3,
              snapshotToken: 'snapshot-owned-by-native',
            },
          },
          future: { exact: '\ud800', enabled: false },
        },
      ])
      const fileHash = createHash('sha256').update(bytes).digest('hex')
      const request = {
        snapshotId: 'main-cache-wrapper-checkpoint',
        hash: fileHash,
        projectionAdmissions: [
          {
            sessionId: 'life-session',
            transportId: fixture.transport.id,
            appliedRevision: before.eventRevision,
            ownerGeneration: 3,
            snapshotToken: 'snapshot-owned-by-native',
            deliveryToken: delivered.deliveryToken,
          },
        ],
      }
      for (const savedAt of [-1, 100.25, Number.MAX_SAFE_INTEGER + 1]) {
        await expect(fixture.agents.prepareRecoveryCache({ ...request, savedAt })).rejects.toThrow()
        expect((await run(fixture.store.readTransport(fixture.transport.id))).records).toEqual(
          before.records,
        )
      }
      const savedAt = 1_234_567
      await fixture.agents.prepareRecoveryCache({ ...request, savedAt })
      const prepared = await run(fixture.store.readTransport(fixture.transport.id))
      expect(prepared.historyPrepares).toEqual([
        {
          location: 'main-cache',
          snapshotId: request.snapshotId,
          fileHash,
          savedAt,
          owners: [
            {
              consumerId: 'main-cache:life-session',
              sessionId: 'life-session',
              snapshotToken: 'snapshot-owned-by-native',
              ownerGeneration: 3,
              throughEventRevision: before.eventRevision,
              authority: 'native-delivery',
            },
          ],
        },
      ])
      const fresh = new Agents(fixture.ssh, vi.fn(), fixture.store)
      try {
        expect(await fresh.attestRecoveryCache({ hash: fileHash })).toMatchObject({
          savedAt,
          projectionAdmissions: [
            {
              sessionId: 'life-session',
              transportId: fixture.transport.id,
              appliedRevision: before.eventRevision,
              snapshotToken: 'snapshot-owned-by-native',
              ownerGeneration: 3,
              deliveryToken: expect.any(String),
            },
          ],
        })
      } finally {
        await fresh.detach()
      }
      expect(prepared.historyAcks).toEqual([])
      expect((await run(fixture.store.readTransport(fixture.transport.id))).records).toEqual(
        prepared.records,
      )
      expect(bytes).not.toContain('savedAt')
      expect(fixture.open).not.toHaveBeenCalled()
      expect(fixture.ssh.channel).not.toHaveBeenCalled()
      expect(fixture.ssh.exec).not.toHaveBeenCalled()
    })
  })

  it('preserves an empty cache clock and suppresses only its genuinely absent completed native owner', async () => {
    await withFixture('codex', async (fixture) => {
      await completeCodexRun(fixture)
      await fixture.agents.recover({ consumers: [{ ...consumer(), kind: 'main' }] })
      const delivered = fixture.events.at(-1)!.nativeRecovery!
      if (!delivered.deliveryToken)
        throw new Error('Native deletion membership requires an actual delivered capability')
      await fixture.agents.dispose('life-session')
      const completed = await run(fixture.store.readTransport(fixture.transport.id))
      expect(completed.transport.owners[0]).toMatchObject({
        state: 'complete',
        generation: 3,
        snapshotToken: 'snapshot-owned-by-native',
        input: { prompt: exactPrompt, remoteId: nativeThread, workspace: '/project' },
      })
      const hash = createHash('sha256').update('[]').digest('hex')
      const savedAt = 2_345_678
      await fixture.agents.prepareRecoveryCache({
        snapshotId: 'main-cache-last-native-thread-deleted',
        hash,
        savedAt,
        projectionAdmissions: [],
        membershipAdmissions: [
          {
            sessionId: 'life-session',
            transportId: fixture.transport.id,
            appliedRevision: completed.eventRevision,
            ownerGeneration: 3,
            snapshotToken: 'snapshot-owned-by-native',
            deliveryToken: delivered.deliveryToken,
          },
        ],
      })
      const prepared = await run(fixture.store.readTransport(fixture.transport.id))
      expect(prepared.historyAcks).toEqual([])
      expect(prepared.inputs).toEqual(completed.inputs)
      expect(prepared.outputs).toEqual(completed.outputs)
      expect(prepared.historyPrepares).toHaveLength(1)
      expect(prepared.historyPrepares[0]).toMatchObject({
        location: 'main-cache',
        fileHash: hash,
        savedAt,
        owners: [
          {
            consumerId: 'main-cache:life-session',
            sessionId: 'life-session',
            snapshotToken: 'snapshot-owned-by-native',
            ownerGeneration: 3,
            throughEventRevision: completed.eventRevision,
            absent: true,
          },
        ],
      })
      const events: AgentEvent[] = []
      const fresh = new Agents(fixture.ssh, (event) => events.push(event), fixture.store)
      try {
        const attested = await fresh.attestRecoveryCache({ hash })
        expect(attested).toMatchObject({
          savedAt,
          projectionAdmissions: [],
          membershipAdmissions: [
            {
              sessionId: 'life-session',
              transportId: fixture.transport.id,
              appliedRevision: completed.eventRevision,
              snapshotToken: 'snapshot-owned-by-native',
              ownerGeneration: 3,
              deliveryToken: expect.any(String),
            },
          ],
        })
        const hidden = await fresh.recover({
          consumers: [],
          membershipAdmissions: attested.membershipAdmissions,
        })
        expect(hidden.owners).toEqual([])
        expect(events).toEqual([])
        const anotherSurface = await fresh.recover({ consumers: [] })
        expect(anotherSurface.owners).toEqual([])
        expect(events).toEqual([])
        expect(fixture.open).not.toHaveBeenCalled()
        expect(fixture.attachments).toEqual([])
        expect((await run(fixture.store.readTransport(fixture.transport.id))).inputs).toEqual(
          prepared.inputs,
        )
        const stale = await fresh.recover({
          consumers: [],
          membershipAdmissions: attested.membershipAdmissions!.map((admission) => ({
            ...admission,
            ownerGeneration: admission.ownerGeneration + 1,
          })),
        })
        expect(stale.owners).toMatchObject([
          {
            sessionId: 'life-session',
            remoteId: nativeThread,
            snapshotToken: 'snapshot-owned-by-native',
            ownerGeneration: 3,
            originalInput: { prompt: exactPrompt, workspace: '/project' },
          },
        ])
        expect(events).toEqual([])
        const renewed = await fresh.attestRecoveryCache({ hash })
        expect(renewed).toEqual(attested)
        const restored = await fresh.recover({
          consumers: [],
          membershipAdmissions: renewed.membershipAdmissions,
        })
        expect(restored.owners).toEqual([])
        expect(events).toEqual([])
        expect((await run(fixture.store.readTransport(fixture.transport.id))).records).toEqual(
          prepared.records,
        )
        expect((await run(fixture.store.readTransport(fixture.transport.id))).inputs).toEqual(
          prepared.inputs,
        )
      } finally {
        await fresh.detach()
      }
      expect(fixture.open).not.toHaveBeenCalled()
      expect(fixture.ssh.channel).not.toHaveBeenCalled()
      expect(fixture.ssh.exec).not.toHaveBeenCalled()
      expect(generateTitle).not.toHaveBeenCalled()
    })
  })

  it('replaces the retained Main source for an explicit empty Main document while preserving it for an empty Studio call', async () => {
    await withFixture('codex', async (fixture) => {
      await run(
        fixture.store.updateTransport(fixture.transport.id, {
          owners: fixture.transport.owners.map((original) => ({
            ...original,
            clientRecovery: {
              planner: 'original',
              pendingStep: 4,
              exact: exactPrompt,
              kind: 'main',
            },
          })),
        }),
      )
      await completeCodexRun(fixture)
      await fixture.agents.recover({ consumers: [{ ...consumer(), kind: 'main' }] })
      const saved = await run(fixture.store.readTransport(fixture.transport.id))
      const delivered = fixture.events.at(-1)!.nativeRecovery!
      if (!delivered.deliveryToken)
        throw new Error('The retained Main document requires an actual delivered capability')
      const cursor = {
        appliedRevision: saved.eventRevision,
        ownerGeneration: 3,
        snapshotToken: 'snapshot-owned-by-native',
      }
      const bytes = JSON.stringify([
        {
          id: 'life-session',
          provider: 'codex',
          profileId: 'machine-original',
          workspace: '/project',
          remoteId: nativeThread,
          messages: [
            { id: 'original-user', role: 'user', text: exactPrompt },
            { id: 'native-answer', role: 'assistant', text: exactReply },
          ],
          nativeRecovery: { [fixture.transport.id]: cursor },
        },
      ])
      const hash = createHash('sha256').update(bytes).digest('hex')
      await fixture.agents.prepareRecoveryCache({
        snapshotId: 'retained-main-before-empty-document',
        hash,
        savedAt: 100,
        projectionAdmissions: [
          {
            sessionId: 'life-session',
            transportId: fixture.transport.id,
            ...cursor,
            deliveryToken: delivered.deliveryToken,
          },
        ],
      })
      const prepared = await run(fixture.store.readTransport(fixture.transport.id))
      const events: AgentEvent[] = []
      const fresh = new Agents(fixture.ssh, (event) => events.push(event), fixture.store)
      try {
        const attested = await fresh.attestRecoveryCache({ hash })
        const retained = await fresh.recover({
          consumers: [
            {
              ...consumer(),
              kind: 'main',
              cacheHash: hash,
              applied: { [fixture.transport.id]: cursor },
              projectionAdmissions: attested.projectionAdmissions,
            },
          ],
          membershipAdmissions: [],
        })
        expect(retained.owners[0].acceptedAppliedRevision).toBe(saved.eventRevision)
        expect(events).toEqual([])
        const studio = await fresh.recover({ consumers: [] })
        expect(studio.owners[0].acceptedAppliedRevision).toBe(saved.eventRevision)
        expect(events).toEqual([])
        const emptyMain = await fresh.recover({ consumers: [], membershipAdmissions: [] })
        expect(emptyMain.owners[0]).toMatchObject({
          sessionId: 'life-session',
          acceptedAppliedRevision: 0,
          originalInput: { prompt: exactPrompt, remoteId: nativeThread, workspace: '/project' },
        })
        expect(events.filter((event) => event.type === 'text')).toMatchObject([
          { text: exactReply },
        ])
        expect(events.filter((event) => event.type === 'complete')).toHaveLength(1)
        expect((await run(fixture.store.readTransport(fixture.transport.id))).records).toEqual(
          prepared.records,
        )
        expect((await run(fixture.store.readTransport(fixture.transport.id))).inputs).toEqual(
          prepared.inputs,
        )
      } finally {
        await fresh.detach()
      }
      expect(fixture.open).not.toHaveBeenCalled()
      expect(fixture.attachments).toEqual([])
      expect(fixture.ssh.channel).not.toHaveBeenCalled()
      expect(fixture.ssh.exec).not.toHaveBeenCalled()
    })
  })

  it.each(['codex', 'claude'] as const)(
    'reduces a completed %s journal with exact bytes and ownership without opening a transport',
    async (provider) => {
      await withFixture(
        provider,
        async (fixture) => {
          const originalInput = await admitOriginalPrompt(fixture)
          const messages =
            provider === 'codex'
              ? [
                  {
                    method: 'item/agentMessage/delta',
                    params: {
                      threadId: nativeThread,
                      turnId: nativeTurn,
                      itemId: 'native-answer',
                      delta: exactReply,
                    },
                  },
                  {
                    method: 'turn/completed',
                    params: {
                      threadId: nativeThread,
                      turn: { id: nativeTurn, status: 'completed' },
                    },
                  },
                ]
              : [
                  {
                    type: 'stream_event',
                    session_id: nativeThread,
                    event: { type: 'message_start', message: { id: 'native-answer' } },
                  },
                  {
                    type: 'stream_event',
                    session_id: nativeThread,
                    event: {
                      type: 'content_block_delta',
                      index: 0,
                      delta: { type: 'text_delta', text: exactReply },
                    },
                  },
                  {
                    type: 'result',
                    session_id: nativeThread,
                    subtype: 'success',
                    is_error: false,
                    result: exactReply,
                  },
                ]
          const bytes = Buffer.from(
            messages.map((message) => JSON.stringify(message) + '\n').join(''),
          )
          const split = bytes.indexOf(Buffer.from('🌍')) + 2
          expect(split).toBeGreaterThan(1)
          await appendBytes(fixture, [bytes.subarray(0, split), bytes.subarray(split)])
          const before = await run(fixture.store.readTransport(fixture.transport.id))
          await run(
            fixture.store.appendOutputs(fixture.transport.id, [
              { type: 'exit', cursor: before.outputCursor + 1, code: 0 },
            ]),
          )
          const completed = await run(fixture.store.readTransport(fixture.transport.id))

          const recovered = await fixture.agents.recover({ consumers: [consumer()] })
          expect(fixture.open).not.toHaveBeenCalled()
          expect(fixture.ssh.channel).not.toHaveBeenCalled()
          expect(fixture.ssh.exec).not.toHaveBeenCalled()
          expect(generateTitle).not.toHaveBeenCalled()
          expect(recovered.owners).toHaveLength(1)
          expect(recovered.owners[0]).toMatchObject({
            status: 'idle',
            provider,
            remoteId: nativeThread,
            localTurn: 7,
            ownerGeneration: 3,
            snapshotToken: 'snapshot-owned-by-native',
            clientRecovery: owner(provider).clientRecovery,
            originalInput: {
              prompt: exactPrompt,
              remoteId: nativeThread,
              workspace: '/project',
              attachments: owner(provider).input.attachments,
            },
          })
          expect(
            fixture.events.filter((event) => event.type === 'text').map((event) => event.text),
          ).toEqual([exactReply])
          expect(fixture.events.filter((event) => event.type === 'complete')).toHaveLength(1)
          expect(fixture.events.filter((event) => event.type === 'error')).toEqual([])
          for (const event of fixture.events)
            expect(event.nativeRecovery).toMatchObject({
              transportId: fixture.transport.id,
              ownerGeneration: 3,
              localTurn: 7,
              snapshotToken: 'snapshot-owned-by-native',
            })
          const after = await run(fixture.store.readTransport(fixture.transport.id))
          expect(after.inputs).toEqual(completed.inputs)
          const savedPrompt = after.inputs.find(
            (input) => input.sequence === originalInput.sequence,
          )!
          expect(savedPrompt).toMatchObject({
            ...originalInput,
            acknowledged: true,
            written: true,
            consumed: true,
            deliveryReceipt: { status: 'written', cursor: expect.any(Number) },
          })
          expect(decodeInput(savedPrompt)).toMatchObject(
            provider === 'codex'
              ? { params: { threadId: nativeThread, input: [{ type: 'text', text: exactPrompt }] } }
              : { session_id: nativeThread, message: { content: exactPrompt } },
          )
          expect(after.outputs).toEqual(completed.outputs)
          const count = fixture.events.length
          const rawClaims = {
            consumers: [
              {
                ...consumer(),
                applied: {
                  [fixture.transport.id]: {
                    appliedRevision: after.eventRevision,
                    ownerGeneration: 3,
                    snapshotToken: 'snapshot-owned-by-native',
                  },
                },
              },
            ],
          }
          const unproven = await fixture.agents.recover(rawClaims)
          expect(unproven.owners[0]).toMatchObject({
            status: 'unknown',
            acceptedAppliedRevision: 0,
          })
          expect(fixture.events).toHaveLength(count)
          const fresh = await fixture.agents.recover({ consumers: [consumer()] })
          expect(fresh.owners[0].status).toBe('idle')
          const deliveredCount = fixture.events.length
          const cacheRow = {
            id: 'life-session',
            provider,
            profileId: 'machine-original',
            workspace: '/project',
            remoteId: nativeThread,
            messages: [
              { id: 'original-user', role: 'user', text: exactPrompt },
              { id: 'original-answer', role: 'assistant', text: exactReply },
            ],
            nativeRecovery: {
              [fixture.transport.id]: {
                appliedRevision: after.eventRevision,
                ownerGeneration: 3,
                snapshotToken: 'snapshot-owned-by-native',
              },
            },
            future: { exact: '\ud800', enabled: false },
          }
          const cacheHash = createHash('sha256').update(JSON.stringify(cacheRow)).digest('hex')
          const delivered = fixture.events.at(-1)!.nativeRecovery!
          if (!delivered.deliveryToken)
            throw new Error('Recovered Studio projection has no native delivery capability')
          await fixture.agents.updateRecoveryOwner({
            sessionId: 'life-session',
            transportId: fixture.transport.id,
            ownerGeneration: 3,
            clientRecovery: {
              planner: 'original',
              pendingStep: 4,
              exact: exactPrompt,
              preparedCache: {
                transportId: fixture.transport.id,
                snapshotId: 'renderer-durable-snapshot',
                hash: cacheHash,
                snapshotToken: 'snapshot-owned-by-native',
                ownerGeneration: 3,
                throughEventRevision: after.eventRevision,
              },
            },
            projectionAdmissions: [
              {
                sessionId: 'life-session',
                transportId: fixture.transport.id,
                appliedRevision: after.eventRevision,
                ownerGeneration: 3,
                snapshotToken: 'snapshot-owned-by-native',
                deliveryToken: delivered.deliveryToken,
              },
            ],
          })
          const claims = {
            consumers: [
              {
                ...consumer(),
                cacheHash,
                applied: {
                  [fixture.transport.id]: {
                    appliedRevision: after.eventRevision,
                    ownerGeneration: 3,
                    snapshotToken: 'snapshot-owned-by-native',
                  },
                },
              },
            ],
          }
          const unacknowledged = await fixture.agents.recover(claims)
          expect(unacknowledged.owners[0].acceptedAppliedRevision).toBe(after.eventRevision)
          expect(fixture.events).toHaveLength(deliveredCount)
          await fixture.agents.acknowledgeRecoveryHistory({
            kind: 'studio',
            sessionId: 'life-session',
            transportId: fixture.transport.id,
            snapshotToken: 'snapshot-owned-by-native',
            snapshotId: 'renderer-durable-snapshot',
            throughEventRevision: after.eventRevision,
            durability: 'admitted-cache',
            fileHash: cacheHash,
          })
          const acknowledged = await fixture.agents.recover(claims)
          expect(acknowledged.owners[0].acceptedAppliedRevision).toBe(after.eventRevision)
          expect(fixture.events).toHaveLength(deliveredCount)
          expect(fixture.open).not.toHaveBeenCalled()
        },
        true,
      )
    },
  )

  it.each(['codex', 'claude'] as const)(
    'restores an actionable %s approval with its original request ID and no original prompt resend',
    async (provider) => {
      await withFixture(provider, async (fixture) => {
        await admitOriginalPrompt(fixture)
        const request = permission(provider)
        await appendMessages(fixture, [request])
        const before = await run(fixture.store.readTransport(fixture.transport.id))
        const recovered = await fixture.agents.recover({ consumers: [consumer()] })
        expect(recovered.owners[0]).toMatchObject({ status: 'running', remoteId: nativeThread })
        expect(fixture.open).toHaveBeenCalledOnce()
        expect(fixture.open).toHaveBeenCalledWith(
          fixture.ssh,
          fixture.transport.launchCommand,
          expect.objectContaining({
            store: fixture.store,
            provider,
            snapshot: expect.objectContaining({ transport: before.transport }),
            deferRecoveryInputs: true,
          }),
        )
        const channel = fixture.attachments[0]
        expect(channel.nativeWrites).toEqual([])
        expect(channel.rawWrites).toEqual([])
        expect(channel.activateRecoveryInputs).toHaveBeenCalledOnce()
        expect(fixture.events.filter((event) => event.type === 'approval')).toMatchObject([
          { requestId: localRequestId(provider) },
        ])
        expect((await run(fixture.store.readTransport(fixture.transport.id))).inputs).toEqual(
          before.inputs,
        )

        await fixture.agents.respond('life-session', localRequestId(provider), true)
        expect(channel.nativeWrites).toHaveLength(1)
        expect(channel.nativeWrites[0].semantic).toMatchObject({
          kind: 'permission-response',
          sessionId: 'life-session',
          ownerGeneration: 3,
          permissionRequestId: 'native-permission-original',
          responseBinding: {
            requestId: localRequestId(provider),
            status: 'approved',
            params: permissionParams(provider),
          },
        })
        expect(channel.nativeWrites[0].message).toMatchObject(
          provider === 'codex'
            ? { id: 'native-permission-original', result: { decision: 'accept' } }
            : {
                type: 'control_response',
                response: {
                  request_id: 'native-permission-original',
                  response: { behavior: 'allow', updatedInput: request.request?.input },
                },
              },
        )
        const after = await run(fixture.store.readTransport(fixture.transport.id))
        expect(after.inputs).toHaveLength(before.inputs.length + 1)
        expect(after.inputs.slice(0, before.inputs.length)).toEqual(before.inputs)
        expect(decodeInput(after.inputs.at(-1)!)).toEqual(channel.nativeWrites[0].message)
        expect(fixture.events.filter((event) => event.type === 'request-resolved')).toMatchObject([
          { requestId: localRequestId(provider), status: 'approved' },
        ])
        expect(fixture.ssh.channel).not.toHaveBeenCalled()
        expect(generateTitle).not.toHaveBeenCalled()
      })
    },
  )

  it('preserves distinct numeric and string Codex approval IDs through replay and response', async () => {
    await withFixture('codex', async (fixture) => {
      await admitOriginalPrompt(fixture)
      await appendMessages(fixture, [permission('codex', 19), permission('codex', '19')])
      await fixture.agents.recover({ consumers: [consumer()] })
      expect(
        fixture.events.filter((event) => event.type === 'approval').map((event) => event.requestId),
      ).toEqual([localRequestId('codex', 19), localRequestId('codex', '19')])
      await fixture.agents.respond('life-session', localRequestId('codex', 19), true)
      await fixture.agents.respond('life-session', localRequestId('codex', '19'), false)
      expect(fixture.attachments[0].nativeWrites.map((write) => write.message.id)).toEqual([
        19,
        '19',
      ])
      expect(
        fixture.attachments[0].nativeWrites.map((write) => write.semantic.permissionRequestId),
      ).toEqual([19, '19'])
    })
  })

  it.each(['codex', 'claude'] as const)(
    'retains the unwritten %s permission envelope created by actual Agents.respond without generating another decision',
    async (provider) => {
      await withFixture(provider, async (fixture) => {
        await admitOriginalPrompt(fixture)
        await appendMessages(fixture, [permission(provider)])
        await fixture.agents.recover({ consumers: [consumer()] })
        const channel = fixture.attachments[0]
        channel.withholdWriteReceipts = true
        let admissionListener: ((input: NativeRecoveryStoredInput) => void) | undefined
        const writeAdmission = new Promise<NativeRecoveryStoredInput>((resolve) => {
          admissionListener = resolve
          channel.once('write-admitted', resolve)
        })
        const responseAttempt = fixture.agents.respond(
          'life-session',
          localRequestId(provider),
          true,
        )
        const responseOutcome = responseAttempt.then(
          () => ({ succeeded: true }),
          (error: unknown) => ({ succeeded: false, error }),
        )
        try {
          await Promise.race([
            writeAdmission,
            responseOutcome.then((outcome) => {
              if ('error' in outcome) throw outcome.error
              throw new Error('The native response resolved before its WAL admission')
            }),
          ])
        } finally {
          if (admissionListener) channel.off('write-admitted', admissionListener)
        }
        const admitted = await run(fixture.store.readTransport(fixture.transport.id))
        const response = admitted.inputs.at(-1)!
        expect(response).toMatchObject({
          acknowledged: false,
          written: false,
          consumed: false,
          semantic: {
            kind: 'permission-response',
            permissionRequestId: 'native-permission-original',
          },
        })
        expect(response.deliveryReceipt).toBeUndefined()
        expect(fixture.attachments[0].nativeWrites).toHaveLength(1)
        expect(decodeInput(response)).toEqual(fixture.attachments[0].nativeWrites[0].message)
        expect(fixture.events.filter((event) => event.type === 'request-resolved')).toEqual([])
        await fixture.agents.detach()
        expect(await responseOutcome).toMatchObject({
          succeeded: false,
          error: expect.any(Error),
        })
        expect(fixture.events.filter((event) => event.type === 'request-resolved')).toEqual([])

        const events: AgentEvent[] = []
        const reopened = new Agents(fixture.ssh, (event) => events.push(event), fixture.store)
        try {
          const recovered = await reopened.recover({ consumers: [consumer()] })
          expect(recovered.owners[0]).toMatchObject({
            status: 'recovering',
            remoteId: nativeThread,
            pending: [{ requestId: localRequestId(provider) }],
          })
          expect(fixture.open).toHaveBeenCalledTimes(2)
          expect(fixture.attachments[1].nativeWrites).toEqual([])
          expect(fixture.attachments[1].rawWrites).toEqual([])
          expect(events.filter((event) => event.type === 'request-resolved')).toEqual([])
          await expect(
            reopened.respond('life-session', localRequestId(provider), false),
          ).rejects.toThrow(/awaiting actual delivery/)
          expect((await run(fixture.store.readTransport(fixture.transport.id))).inputs).toEqual(
            admitted.inputs,
          )
          expect(fixture.ssh.channel).not.toHaveBeenCalled()
          expect(generateTitle).not.toHaveBeenCalled()
        } finally {
          await reopened.detach()
        }
      })
    },
  )

  it.each(['codex', 'claude'] as const)(
    'folds a written but unacknowledged original %s permission decision without resending it or resurrecting the request',
    async (provider) => {
      await withFixture(provider, async (fixture) => {
        await admitOriginalPrompt(fixture)
        await appendMessages(fixture, [permission(provider)])
        const response =
          provider === 'codex'
            ? { id: 'native-permission-original', result: { decision: 'decline' } }
            : {
                type: 'control_response',
                response: {
                  subtype: 'success',
                  request_id: 'native-permission-original',
                  response: { behavior: 'deny', message: 'Exact original decision' },
                },
              }
        const original = await run(
          fixture.store.reserveInput(
            fixture.transport.id,
            { type: 'write', data: encoded(response) },
            {
              kind: 'permission-response',
              sessionId: 'life-session',
              ownerGeneration: 3,
              permissionRequestId: 'native-permission-original',
              responseBinding: {
                requestId: localRequestId(provider),
                status: 'declined',
                params: permissionParams(provider),
                details: { exact: exactPrompt },
              },
            },
          ),
        )
        const writtenReceipt = await appendInputReceipt(fixture, original.sequence, 'written')
        await appendMessages(fixture, [permission(provider)])
        const before = await run(fixture.store.readTransport(fixture.transport.id))
        await fixture.agents.recover({ consumers: [consumer()] })
        expect(fixture.attachments[0].nativeWrites).toEqual([])
        expect(fixture.attachments[0].rawWrites).toEqual([])
        expect((await run(fixture.store.readTransport(fixture.transport.id))).inputs).toEqual(
          before.inputs,
        )
        expect(before.inputs.at(-1)).toMatchObject({
          ...original,
          acknowledged: false,
          written: true,
          consumed: true,
          deliveryReceipt: { cursor: writtenReceipt.cursor, status: 'written' },
        })
        const resolved = fixture.events.filter((event) => event.type === 'request-resolved')
        expect(resolved).toHaveLength(1)
        expect(resolved[0]).toMatchObject({
          requestId: localRequestId(provider),
          status: 'declined',
          details: { exact: exactPrompt },
          nativeRecovery: {
            eventId: `${fixture.transport.id}:input:${original.sequence}:request-resolved`,
          },
        })
        expect(fixture.events.filter((event) => event.type === 'approval')).toHaveLength(1)
        await expect(
          fixture.agents.respond('life-session', localRequestId(provider), true),
        ).rejects.toThrow(/no longer pending/)
        expect(fixture.attachments[0].nativeWrites).toEqual([])
        expect(fixture.attachments[0].rawWrites).toEqual([])
        expect((await run(fixture.store.readTransport(fixture.transport.id))).inputs).toEqual(
          before.inputs,
        )
        expect(fixture.events.filter((event) => event.type === 'request-resolved')).toHaveLength(1)
      })
    },
  )

  it.each(['codex', 'claude'] as const)(
    'does not turn an ACKed canceled %s permission WAL without a write receipt into a resolved request',
    async (provider) => {
      await withFixture(provider, async (fixture) => {
        await admitOriginalPrompt(fixture)
        await appendMessages(fixture, [permission(provider)])
        const response =
          provider === 'codex'
            ? { id: 'native-permission-original', result: { decision: 'accept' } }
            : {
                type: 'control_response',
                response: {
                  subtype: 'success',
                  request_id: 'native-permission-original',
                  response: { behavior: 'allow', updatedInput: { command: 'printf "exact 🌍"' } },
                },
              }
        const original = await run(
          fixture.store.reserveInput(
            fixture.transport.id,
            { type: 'write', data: encoded(response) },
            {
              kind: 'permission-response',
              sessionId: 'life-session',
              ownerGeneration: 3,
              permissionRequestId: 'native-permission-original',
              responseBinding: {
                requestId: localRequestId(provider),
                status: 'approved',
                params: permissionParams(provider),
              },
            },
          ),
        )
        await run(
          fixture.store.cancelInput(
            fixture.transport.id,
            original.sequence,
            'Delivery was canceled before its native write could be reconciled',
          ),
        )
        await appendMessages(fixture, [permission(provider)])
        const originalOpen = fixture.open.getMockImplementation()!
        fixture.open.mockImplementationOnce(async (...args) => {
          const channel = await originalOpen(...args)
          await run(fixture.store.acknowledgeInput(fixture.transport.id, original.sequence))
          return channel
        })
        const recovered = await fixture.agents.recover({ consumers: [consumer()] })
        expect(fixture.events.filter((event) => event.type === 'request-resolved')).toEqual([])
        expect(
          fixture.events.some(
            (event) => event.type === 'approval' && event.requestId === localRequestId(provider),
          ),
        ).toBe(true)
        expect(fixture.attachments[0].nativeWrites).toEqual([])
        expect(fixture.attachments[0].rawWrites).toEqual([])
        // ACK and local cancellation do not establish native pipe delivery. Keep
        // uncertainty rather than inventing a successful original decision.
        expect(['recovering', 'unknown']).toContain(recovered.owners[0].status)
        const retainedInputs = (await run(fixture.store.readTransport(fixture.transport.id))).inputs
        await expect(
          fixture.agents.respond('life-session', localRequestId(provider), false),
        ).rejects.toThrow(/awaiting actual delivery/)
        const after = await run(fixture.store.readTransport(fixture.transport.id))
        expect(after.inputs).toEqual(retainedInputs)
        expect(after.inputs.at(-1)).toMatchObject({
          sequence: original.sequence,
          acknowledged: true,
          written: false,
          consumed: false,
          cancellation: 'Delivery was canceled before its native write could be reconciled',
        })
        expect(after.inputs.at(-1)!.deliveryReceipt).toBeUndefined()
        expect(decodeInput(after.inputs.at(-1)!)).toEqual(response)
        expect(after.inputs).toHaveLength(original.sequence)
        expect(fixture.attachments[0].nativeWrites).toEqual([])
        expect(fixture.attachments[0].rawWrites).toEqual([])
      })
    },
  )

  it.each(['codex', 'claude'] as const)(
    'uses a reconciled %s write receipt to retain the original canceled permission decision without an ACK',
    async (provider) => {
      await withFixture(provider, async (fixture) => {
        await admitOriginalPrompt(fixture)
        await appendMessages(fixture, [permission(provider)])
        const response =
          provider === 'codex'
            ? { id: 'native-permission-original', result: { decision: 'decline' } }
            : {
                type: 'control_response',
                response: {
                  subtype: 'success',
                  request_id: 'native-permission-original',
                  response: { behavior: 'deny', message: 'Exact original decision' },
                },
              }
        const original = await run(
          fixture.store.reserveInput(
            fixture.transport.id,
            { type: 'write', data: encoded(response) },
            {
              kind: 'permission-response',
              sessionId: 'life-session',
              ownerGeneration: 3,
              permissionRequestId: 'native-permission-original',
              responseBinding: {
                requestId: localRequestId(provider),
                status: 'declined',
                params: permissionParams(provider),
              },
            },
          ),
        )
        await run(
          fixture.store.cancelInput(
            fixture.transport.id,
            original.sequence,
            'Transport disappeared before its native write receipt arrived',
          ),
        )
        await appendMessages(fixture, [permission(provider)])
        const originalOpen = fixture.open.getMockImplementation()!
        let writtenReceipt: NativeRecoveryInputReceipt | undefined
        fixture.open.mockImplementationOnce(async (...args) => {
          const channel = await originalOpen(...args)
          // Receipt replay can prove the original native write independently of
          // whether this local WAL has received its separate acceptance ACK.
          writtenReceipt = await appendInputReceipt(fixture, original.sequence, 'written')
          fixture.attachments.at(-1)!.bufferWriteReceipt(writtenReceipt)
          return channel
        })
        await fixture.agents.recover({ consumers: [consumer()] })
        expect(fixture.attachments[0].nativeWrites).toEqual([])
        const resolved = fixture.events.filter((event) => event.type === 'request-resolved')
        expect(resolved).toHaveLength(1)
        expect(resolved[0]).toMatchObject({
          requestId: localRequestId(provider),
          status: 'declined',
          nativeRecovery: {
            eventId: `${fixture.transport.id}:input:${original.sequence}:request-resolved`,
          },
        })
        expect(fixture.events.filter((event) => event.type === 'approval')).toHaveLength(1)
        await expect(
          fixture.agents.respond('life-session', localRequestId(provider), true),
        ).rejects.toThrow(/no longer pending/)
        expect(fixture.attachments[0].nativeWrites).toEqual([])
        expect(fixture.attachments[0].rawWrites).toEqual([])
        const after = await run(fixture.store.readTransport(fixture.transport.id))
        expect(after.inputs.at(-1)).toMatchObject({
          sequence: original.sequence,
          acknowledged: false,
          written: true,
          consumed: true,
          deliveryReceipt: { cursor: writtenReceipt!.cursor, status: 'written' },
          cancellation: 'Transport disappeared before its native write receipt arrived',
        })
        expect(after.inputs).toHaveLength(original.sequence)
        expect(decodeInput(after.inputs.at(-1)!)).toEqual(response)
        expect(fixture.events.filter((event) => event.type === 'request-resolved')).toHaveLength(1)
      })
    },
  )

  it.each(['codex', 'claude'] as const)(
    'does not reinterpret an ACKed terminal %s close as a write receipt for a canceled permission decision',
    async (provider) => {
      await withFixture(provider, async (fixture) => {
        await admitOriginalPrompt(fixture)
        await appendMessages(fixture, [permission(provider)])
        const response =
          provider === 'codex'
            ? { id: 'native-permission-original', result: { decision: 'accept' } }
            : {
                type: 'control_response',
                response: {
                  subtype: 'success',
                  request_id: 'native-permission-original',
                  response: { behavior: 'allow', updatedInput: { command: 'printf "exact 🌍"' } },
                },
              }
        const original = await run(
          fixture.store.reserveInput(
            fixture.transport.id,
            { type: 'write', data: encoded(response) },
            {
              kind: 'permission-response',
              sessionId: 'life-session',
              ownerGeneration: 3,
              permissionRequestId: 'native-permission-original',
              responseBinding: {
                requestId: localRequestId(provider),
                status: 'approved',
                params: permissionParams(provider),
              },
            },
          ),
        )
        const close = await run(
          fixture.store.reserveInput(fixture.transport.id, { type: 'close' }, { kind: 'close' }),
        )
        expect(close.sequence).toBe(original.sequence + 1)
        // A broker can accept close without writing the preceding canceled
        // permission envelope. Its ACK high-water still covers both numbers.
        await run(fixture.store.acknowledgeInput(fixture.transport.id, close.sequence))
        const closing = await run(fixture.store.readTransport(fixture.transport.id))
        await run(
          fixture.store.appendOutputs(fixture.transport.id, [
            { type: 'exit', cursor: closing.outputCursor + 1, code: 0 },
          ]),
        )
        const before = await run(fixture.store.readTransport(fixture.transport.id))
        expect(before.inputs.find((input) => input.sequence === original.sequence)).toMatchObject({
          sequence: original.sequence,
          acknowledged: true,
          written: false,
          consumed: false,
          cancellation: 'Superseded by explicit transport close.',
        })
        expect(
          before.inputs.find((input) => input.sequence === original.sequence)!.deliveryReceipt,
        ).toBeUndefined()
        expect(before.acknowledgedInputSequence).toBe(close.sequence)
        await fixture.agents.recover({ consumers: [consumer()] })
        expect(fixture.open).not.toHaveBeenCalled()
        expect(
          fixture.events.filter(
            (event) =>
              event.type === 'request-resolved' &&
              ['approved', 'declined', 'answered'].includes(event.status || ''),
          ),
        ).toEqual([])
        expect((await run(fixture.store.readTransport(fixture.transport.id))).inputs).toEqual(
          before.inputs,
        )
        expect(fixture.ssh.channel).not.toHaveBeenCalled()
      })
    },
  )

  it.each([
    { provider: 'codex', status: 'uncertain' },
    { provider: 'codex', status: 'cancelled' },
    { provider: 'claude', status: 'uncertain' },
    { provider: 'claude', status: 'cancelled' },
  ] as const)(
    'keeps the original $provider permission and owner unknown after an ACK and $status receipt',
    async ({ provider, status }) => {
      await withFixture(provider, async (fixture) => {
        await admitOriginalPrompt(fixture)
        await appendMessages(fixture, [permission(provider)])
        const response =
          provider === 'codex'
            ? { id: 'native-permission-original', result: { decision: 'decline' } }
            : {
                type: 'control_response',
                response: {
                  subtype: 'success',
                  request_id: 'native-permission-original',
                  response: { behavior: 'deny', message: 'Exact original decision' },
                },
              }
        const original = await run(
          fixture.store.reserveInput(
            fixture.transport.id,
            { type: 'write', data: encoded(response) },
            {
              kind: 'permission-response',
              sessionId: 'life-session',
              ownerGeneration: 3,
              permissionRequestId: 'native-permission-original',
              responseBinding: {
                requestId: localRequestId(provider),
                status: 'declined',
                params: permissionParams(provider),
              },
            },
          ),
        )
        await run(fixture.store.acknowledgeInput(fixture.transport.id, original.sequence))
        const receipt = await appendInputReceipt(fixture, original.sequence, status)
        const before = await run(fixture.store.readTransport(fixture.transport.id))
        const recovered = await fixture.agents.recover({ consumers: [consumer()] })
        expect(recovered.owners[0]).toMatchObject({
          status: 'unknown',
          remoteId: nativeThread,
          ownerGeneration: 3,
          snapshotToken: 'snapshot-owned-by-native',
          originalInput: { prompt: exactPrompt, workspace: '/project' },
        })
        expect(fixture.events.filter((event) => event.type === 'request-resolved')).toEqual([])
        expect(fixture.events.filter((event) => event.type === 'complete')).toEqual([])
        expect(fixture.events.filter((event) => event.type === 'approval')).toMatchObject([
          { requestId: localRequestId(provider) },
        ])
        await expect(
          fixture.agents.respond('life-session', localRequestId(provider), true),
        ).rejects.toThrow()
        const after = await run(fixture.store.readTransport(fixture.transport.id))
        expect(after.inputs).toEqual(before.inputs)
        expect(after.outputs).toEqual(before.outputs)
        expect(after.records.slice(0, before.records.length)).toEqual(before.records)
        expect(after.inputs.at(-1)).toMatchObject({
          sequence: original.sequence,
          acknowledged: true,
          written: false,
          consumed: false,
          deliveryReceipt: { cursor: receipt.cursor, status },
        })
        expect(decodeInput(after.inputs.at(-1)!)).toEqual(response)
        expect(after.events.some((event) => event.event.type === 'approval')).toBe(true)
        expect(after.outputs.some((frame) => frame.type === 'exit')).toBe(false)
        expect(fixture.attachments[0].nativeWrites).toEqual([])
        expect(fixture.attachments[0].rawWrites).toEqual([])
        expect(fixture.attachments[0].signal).not.toHaveBeenCalled()
        expect(fixture.attachments[0].close).not.toHaveBeenCalled()
        expect(fixture.ssh.channel).not.toHaveBeenCalled()
        expect(fixture.ssh.exec).not.toHaveBeenCalled()
      })
    },
  )

  it.each(['codex', 'claude'] as const)(
    'retains uncertain %s ownership and all original records when its broker cannot be reattached',
    async (provider) => {
      await withFixture(provider, async (fixture) => {
        await admitOriginalPrompt(fixture)
        await appendMessages(fixture, [permission(provider)])
        const before = await run(fixture.store.readTransport(fixture.transport.id))
        fixture.open.mockRejectedValueOnce(new Error('Original broker is unavailable'))
        const recovered = await fixture.agents.recover({ consumers: [consumer()] })
        expect(recovered.owners[0]).toMatchObject({
          status: 'unknown',
          remoteId: nativeThread,
          originalInput: { prompt: exactPrompt, workspace: '/project' },
        })
        expect(fixture.ssh.channel).not.toHaveBeenCalled()
        expect(fixture.ssh.exec).not.toHaveBeenCalled()
        expect(generateTitle).not.toHaveBeenCalled()
        expect(fixture.events.filter((event) => event.type === 'request-resolved')).toEqual([])
        await expect(
          fixture.agents.respond('life-session', localRequestId(provider), true),
        ).rejects.toThrow(/recovery failed|replacement provider|unknown/i)
        const after = await run(fixture.store.readTransport(fixture.transport.id))
        expect(after.inputs).toEqual(before.inputs)
        expect(after.outputs).toEqual(before.outputs)
        expect(after.transport.owners).toEqual(before.transport.owners)
      })
    },
  )
})
