import { createHash, randomUUID } from 'node:crypto'
import { EventEmitter } from 'node:events'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Duplex, PassThrough } from 'node:stream'
import { Deferred, Effect } from 'effect'
import type { ClientChannel } from 'ssh2'
import { describe, expect, it, vi } from 'vitest'
import { DurableRemoteChannel, type DurableChannelHost } from '../src/main/durable-remote-channel'
import {
  NativeRecoveryStore,
  type NativeRecoveryStoreHandle,
} from '../src/main/native-recovery-store'
import {
  NativeRecoveryError,
  type NativeRecoveryInputSemantic,
  type NativeRecoveryOwner,
  type NativeRecoverySnapshot,
  type NativeRecoveryTransport,
} from '../src/main/native-recovery-types'
import type { ConnectionState } from '../src/shared/types'
import { CodexRPC, type Wire } from '../src/main/codex-rpc'
import type { RemoteAgentBrokerConfig } from '../src/main/remote-agent-broker'
import { planNativeStopRecovery } from '../src/main/agent-native-stop-recovery'

type Frame = Record<string, unknown>

const connected: ConnectionState = {
  status: 'connected',
  home: '/home/fixture',
  workspace: '/project',
  profile: {
    id: 'fixture-profile',
    name: 'Fixture',
    host: 'fixture-host',
    port: 22,
    username: 'fixture-user',
    auth: 'agent',
    privateKeyPath: '',
    workspace: '/project',
  },
}

class Attachment extends Duplex {
  readonly stderr = new PassThrough()
  readonly inputs: Frame[] = []
  readonly inputLines: string[] = []
  closeCount = 0

  constructor(
    private readonly onInput?: (attachment: Attachment, frame: Frame) => void,
    private readonly onFrame?: (frame: Frame) => void,
  ) {
    super({ autoDestroy: false })
  }

  override _read() {}

  override _write(chunk: Buffer, _encoding: BufferEncoding, callback: () => void) {
    for (const line of chunk.toString('utf8').split('\n')) {
      if (!line) continue
      this.inputLines.push(line + '\n')
      const input = JSON.parse(line) as Frame
      this.inputs.push(input)
      this.onInput?.(this, input)
    }
    callback()
  }

  frame(frame: Frame) {
    this.onFrame?.(frame)
    this.push(JSON.stringify(frame) + '\n')
  }

  close() {
    this.closeCount++
    this.emit('close')
  }
}

class Host extends EventEmitter implements DurableChannelHost {
  state: ConnectionState = {
    ...connected,
    profile: { ...connected.profile! },
  }
  readonly attachments: Attachment[] = []
  readonly commands: string[] = []
  readonly readyFrames: Frame[] = []
  automaticMarker = true
  automaticReceipts = true
  readyOverrides: Frame = {}
  afterReady?: (attachment: Attachment) => void
  private outputHighWater = 0
  private inputHighWater = 0
  private readonly journal = new Map<number, Frame>()

  get nextOutputCursor() {
    return this.outputHighWater + 1
  }

  receipt(attachment: Attachment, sequence: number, status = 'written', extra: Frame = {}) {
    const frame = {
      type: 'inputReceipt',
      cursor: this.nextOutputCursor,
      sequence,
      status,
      ...extra,
    }
    attachment.frame(frame)
    return frame
  }

  private recordFrame(frame: Frame) {
    if (
      ['stdout', 'stderr', 'exit', 'inputReceipt'].includes(frame.type as string) &&
      typeof frame.cursor === 'number' &&
      Number.isSafeInteger(frame.cursor) &&
      frame.cursor > 0
    ) {
      this.outputHighWater = Math.max(this.outputHighWater, frame.cursor)
      this.journal.set(frame.cursor, frame)
    }
    const accepted =
      frame.type === 'ack' || frame.type === 'inputReceipt'
        ? frame.sequence
        : frame.type === 'ready'
          ? frame.lastInputSequence
          : undefined
    if (typeof accepted === 'number' && Number.isSafeInteger(accepted) && accepted >= 0)
      this.inputHighWater = Math.max(this.inputHighWater, accepted)
    if (frame.type === 'ready' && typeof frame.cursor === 'number')
      this.outputHighWater = Math.max(this.outputHighWater, frame.cursor)
  }

  async channel(command: string): Promise<ClientChannel> {
    const attachment = new Attachment(
      (attachment, input) => {
        if (!this.automaticReceipts) return
        setImmediate(() => {
          if (attachment.closeCount || attachment.destroyed) return
          if (
            [...this.journal.values()].some(
              (frame) => frame.type === 'inputReceipt' && frame.sequence === input.sequence,
            )
          )
            return
          this.receipt(attachment, input.sequence as number)
        })
      },
      (frame) => this.recordFrame(frame),
    )
    const index = this.attachments.length
    this.commands.push(command)
    this.attachments.push(attachment)
    setImmediate(() => {
      const ready = {
        type: 'ready',
        protocol: 2,
        inputReceipts: 1,
        cursor: this.outputHighWater,
        lastInputSequence: this.inputHighWater,
        writerLease: { epoch: index + 1, token: `fixture-lease-${index + 1}` },
        ...this.readyOverrides,
      }
      this.readyFrames.push(ready)
      attachment.frame(ready)
      const encodedConfiguration =
        command.match(/'(eyJ[A-Za-z0-9+/=]+)'/)?.[1] ?? command.match(/:(eyJ[A-Za-z0-9+/=]+)$/)?.[1]
      const requested = encodedConfiguration
        ? ((JSON.parse(Buffer.from(encodedConfiguration, 'base64').toString('utf8')) as Frame)
            .cursor as number)
        : 0
      for (const frame of this.journal.values())
        if (
          (frame.cursor as number) > requested &&
          (frame.cursor as number) <= (ready.cursor as number)
        )
          attachment.frame(frame)
      this.afterReady?.(attachment)
      if (this.automaticMarker)
        attachment.frame({ type: 'replayComplete', replayCursor: ready.cursor })
    })
    return attachment as unknown as ClientChannel
  }

  disconnect() {
    this.state = { ...this.state, status: 'disconnected' }
    this.emit('state', this.state)
    this.emit('disconnected')
  }

  reconnect(state: ConnectionState = connected) {
    this.state = { ...state, profile: { ...state.profile! } }
    this.emit('state', this.state)
  }
}

interface Fixture {
  directory: string
  store: NativeRecoveryStoreHandle
  channels: Set<DurableRemoteChannel>
}

const scopedFixture = Effect.fn('tests.durableChannelRecovery.fixture')(function* (
  body: (fixture: Fixture) => Promise<void>,
) {
  const directory = yield* Effect.acquireRelease(
    Effect.promise(() => mkdtemp(join(tmpdir(), 'life-channel-recovery-'))),
    (directory) => Effect.promise(() => rm(directory, { recursive: true, force: true })),
  )
  const store = yield* NativeRecoveryStore.make({ directory, outputBatchDelayMs: 1 })
  const channels = new Set<DurableRemoteChannel>()
  yield* Effect.tryPromise({
    try: async () => {
      try {
        await body({ directory, store, channels })
      } finally {
        for (const channel of channels) channel.destroy()
      }
    },
    catch: (cause) => cause,
  })
})

const withStore = (body: (fixture: Fixture) => Promise<void>) =>
  Effect.runPromise(Effect.scoped(scopedFixture(body)))

function descriptor(): NativeRecoveryTransport {
  const id = randomUUID()
  return {
    id,
    brokerId: id,
    brokerRoot: `/registered/home/.life/agent-sessions/${id}`,
    launchCommand: 'exec codex app-server',
    provider: 'codex',
    providerVersion: 'fixture-native-version',
    nativeProtocol: 'codex-app-server-jsonrpc',
    brokerProtocolVersion: 2,
    machine: {
      profileId: connected.profile!.id,
      host: connected.profile!.host,
      port: connected.profile!.port,
      username: connected.profile!.username,
    },
    controller: { id: 'previous-controller', epoch: 1 },
    initialization: { status: 'complete' },
    owners: [],
  }
}

function brokerConfiguration(command: string): Frame {
  const encoded = command.match(/'(eyJ[A-Za-z0-9+/=]+)'/)
  expect(encoded).not.toBeNull()
  return JSON.parse(Buffer.from(encoded![1], 'base64').toString('utf8')) as Frame
}

async function createSnapshot(
  store: NativeRecoveryStoreHandle,
  patch: Partial<NativeRecoveryTransport> = {},
) {
  return Effect.runPromise(store.createTransport({ ...descriptor(), ...patch }))
}

async function restored(
  fixture: Fixture,
  host: Host,
  snapshot: NativeRecoverySnapshot,
  deferRecoveryInputs = false,
  store = fixture.store,
) {
  const channel = await DurableRemoteChannel.open(host, snapshot.transport.launchCommand, {
    store,
    provider: snapshot.transport.provider,
    snapshot,
    deferRecoveryInputs,
  })
  fixture.channels.add(channel)
  return channel
}

const write = (channel: DurableRemoteChannel, bytes: Buffer | string) =>
  new Promise<void>((resolve, reject) => {
    channel.write(bytes, (error?: Error | null) => (error ? reject(error) : resolve()))
  })

const nextTurn = () => new Promise<void>((resolve) => setImmediate(resolve))

describe('durable provider channel cold recovery', () => {
  it('waits for the original tracked broker handshake before admitting an idle close', () =>
    withStore(async (fixture) => {
      let attachment!: Attachment
      class DelayedHost extends Host {
        override async channel(command: string): Promise<ClientChannel> {
          this.commands.push(command)
          attachment = new Attachment()
          this.attachments.push(attachment)
          return attachment as unknown as ClientChannel
        }
      }
      const host = new DelayedHost()
      let candidate!: DurableRemoteChannel
      const opening = DurableRemoteChannel.open(
        host,
        'exec codex app-server',
        (channel) => {
          candidate = channel
          fixture.channels.add(channel)
        },
        { store: fixture.store, provider: 'codex' },
      )
      await vi.waitFor(() => expect(host.attachments).toHaveLength(1))
      let settled = false
      const released = Effect.runPromise(candidate.closeAndWaitEffect()).then((result) => {
        settled = true
        return result
      })
      await vi.waitFor(() => expect(candidate.isClosing).toBe(true))
      expect(attachment.inputs).toEqual([])
      expect(settled).toBe(false)
      attachment.frame({
        type: 'ready',
        protocol: 2,
        inputReceipts: 1,
        cursor: 0,
        lastInputSequence: 0,
        writerLease: { epoch: 1, token: 'original-opening-writer' },
      })
      attachment.frame({ type: 'replayComplete', replayCursor: 0 })
      expect(await opening).toBe(candidate)
      await vi.waitFor(() => expect(attachment.inputs).toHaveLength(1))
      const close = attachment.inputs[0]
      expect(close.type).toBe('close')
      attachment.frame({ type: 'ack', sequence: close.sequence })
      attachment.frame({
        type: 'inputReceipt',
        cursor: 1,
        sequence: close.sequence,
        status: 'written',
      })
      await nextTurn()
      expect(settled).toBe(false)
      attachment.frame({ type: 'exit', cursor: 2, code: 0, signal: null })
      expect(await released).toBe(true)
      expect(host.commands).toHaveLength(1)
      expect(attachment.inputs.map((input) => input.type)).toEqual(['close'])
      const stored = await Effect.runPromise(fixture.store.readTransport(candidate.recoveryId!))
      expect(stored.inputs).toHaveLength(1)
      expect(stored.inputs[0].deliveryReceipt?.status).toBe('written')
    }))

  it('attaches to the registered absolute broker root despite a changed remote home', () =>
    withStore(async (fixture) => {
      const snapshot = await createSnapshot(fixture.store)
      const host = new Host()
      host.state = { ...host.state, home: '/new/home', workspace: '/another/project' }
      const channel = await restored(fixture, host, snapshot)
      expect(channel.nativeRecoveryTracked).toBe(true)
      expect(channel.recoveryId).toBe(snapshot.transport.id)
      expect(channel.recoveryStore).toBe(fixture.store)
      expect(channel.recoveryDescriptor?.brokerRoot).toBe(snapshot.transport.brokerRoot)
      expect(brokerConfiguration(host.commands[0])).toMatchObject({
        id: snapshot.transport.brokerId,
        root: snapshot.transport.brokerRoot,
        command: snapshot.transport.launchCommand,
        launch: false,
        expectedProtocol: 2,
      })
      channel.resumeRecoveryOutput()
      await channel.waitForReplay()
      expect(host.attachments[0].inputs).toEqual([])
    }))

  it('records the Local root hook before launching through the full fenced command hook', () =>
    withStore(async (fixture) => {
      const order: string[] = []
      const registered: NativeRecoverySnapshot[] = []
      const configured: RemoteAgentBrokerConfig[] = []
      const store: NativeRecoveryStoreHandle = {
        ...fixture.store,
        createTransport: (transport) =>
          Effect.gen(function* () {
            order.push('registry')
            return yield* fixture.store.createTransport(transport)
          }),
      }
      class LocalHost extends Host {
        override state = {
          ...connected,
          profile: { ...connected.profile!, transport: 'local' as const },
        }
        agentBrokerRoot(id: string) {
          order.push('root')
          return '/private/local-brokers/' + id
        }
        agentBrokerCommand(config: RemoteAgentBrokerConfig) {
          order.push('command')
          configured.push({ ...config })
          return 'owned-local-runtime:' + Buffer.from(JSON.stringify(config)).toString('base64')
        }
        override async channel(command: string) {
          order.push('channel')
          registered.push(
            await Effect.runPromise(fixture.store.readTransport(configured.at(-1)!.id)),
          )
          return super.channel(command)
        }
      }
      const host = new LocalHost()
      const channel = await DurableRemoteChannel.open(host, 'exec codex app-server', {
        store,
        provider: 'codex',
      })
      fixture.channels.add(channel)
      expect(order).toEqual(['root', 'registry', 'command', 'channel'])
      expect(registered[0].transport).toMatchObject({
        brokerId: channel.sessionId,
        brokerRoot: '/private/local-brokers/' + channel.sessionId,
        machine: { transport: 'local', profileId: connected.profile!.id },
      })
      expect(configured[0]).toEqual({
        id: channel.sessionId,
        command: 'exec codex app-server',
        root: registered[0].transport.brokerRoot,
        cursor: 0,
        launch: true,
        controllerId: channel.controllerId,
        expectedProtocol: 2,
      })
      expect(host.commands[0]).toBe(
        'owned-local-runtime:' + Buffer.from(JSON.stringify(configured[0])).toString('base64'),
      )
      expect(channel.recoveryDescriptor?.brokerRoot).toBe(configured[0].root)
    }))

  it('restores the recorded Local root and cursor through the hook without recalculating ownership', () =>
    withStore(async (fixture) => {
      const recorded = descriptor()
      const initial = await Effect.runPromise(
        fixture.store.createTransport({
          ...recorded,
          machine: { ...recorded.machine, transport: 'local' },
        }),
      )
      await Effect.runPromise(
        fixture.store.appendOutputs(initial.transport.id, [
          {
            type: 'stdout',
            cursor: 1,
            data: Buffer.from('original local WAL\n').toString('base64'),
          },
        ]),
      )
      const snapshot = await Effect.runPromise(fixture.store.readTransport(initial.transport.id))
      const configured: RemoteAgentBrokerConfig[] = []
      let rootCalls = 0
      class LocalHost extends Host {
        override state = {
          ...connected,
          home: '/changed/home',
          profile: { ...connected.profile!, transport: 'local' as const },
        }
        agentBrokerRoot() {
          rootCalls++
          return '/different/local/options/root'
        }
        agentBrokerCommand(config: RemoteAgentBrokerConfig) {
          configured.push({ ...config })
          return 'restored-local-runtime'
        }
      }
      const host = new LocalHost()
      host.readyOverrides = { cursor: snapshot.outputCursor }
      const channel = await restored(fixture, host, snapshot, true)
      expect(rootCalls).toBe(0)
      expect(configured).toEqual([
        {
          id: snapshot.transport.brokerId,
          command: snapshot.transport.launchCommand,
          root: snapshot.transport.brokerRoot,
          cursor: 1,
          launch: false,
          controllerId: channel.controllerId,
          expectedProtocol: 2,
        },
      ])
      expect(host.commands).toEqual(['restored-local-runtime'])
      expect(
        (await Effect.runPromise(fixture.store.readTransport(snapshot.transport.id))).transport
          .brokerRoot,
      ).toBe(snapshot.transport.brokerRoot)
      channel.resumeRecoveryOutput()
      await channel.waitForReplay()
      expect(host.attachments[0].inputs).toEqual([])
    }))

  it('keeps the resolved Local root on reattachment after host options and home change', () =>
    withStore(async (fixture) => {
      const configured: RemoteAgentBrokerConfig[] = []
      let rootCalls = 0
      class LocalHost extends Host {
        override state = {
          ...connected,
          profile: { ...connected.profile!, transport: 'local' as const },
        }
        rootDirectory = '/original/local/brokers'
        agentBrokerRoot(id: string) {
          rootCalls++
          return this.rootDirectory + '/' + id
        }
        agentBrokerCommand(config: RemoteAgentBrokerConfig) {
          configured.push({ ...config })
          return 'local-runtime-' + configured.length
        }
      }
      const host = new LocalHost()
      const channel = await DurableRemoteChannel.open(host, 'exec codex app-server', {
        store: fixture.store,
        provider: 'codex',
      })
      fixture.channels.add(channel)
      await channel.waitForReplay()
      const profile = { ...host.state.profile! }
      host.disconnect()
      host.rootDirectory = '/changed/local/options'
      host.reconnect({ ...host.state, status: 'connected', home: '/changed/home', profile })
      await vi.waitFor(() => expect(host.attachments).toHaveLength(2))
      await vi.waitFor(() => expect(channel.transportState).toBe('connected'))
      await channel.waitForReplay()
      expect(rootCalls).toBe(1)
      expect(configured[1]).toEqual({ ...configured[0], launch: false })
      expect(configured[1].root).toBe('/original/local/brokers/' + channel.sessionId)
      expect(
        (await Effect.runPromise(fixture.store.readTransport(channel.recoveryId!))).transport
          .brokerRoot,
      ).toBe(configured[1].root)
    }))

  it('retains the default SSH root when the optional resolver has no override', () =>
    withStore(async (fixture) => {
      let rootCalls = 0
      class SSHHost extends Host {
        agentBrokerRoot() {
          rootCalls++
          return undefined
        }
      }
      const host = new SSHHost()
      const channel = await DurableRemoteChannel.open(host, 'exec codex app-server', {
        store: fixture.store,
        provider: 'codex',
      })
      fixture.channels.add(channel)
      expect(rootCalls).toBe(1)
      const expected = '/home/fixture/.life/agent-sessions/' + channel.sessionId
      expect(channel.recoveryDescriptor?.brokerRoot).toBe(expected)
      expect(brokerConfiguration(host.commands[0]).root).toBe(expected)
    }))

  it.each(['relative/local/root', ''])(
    'refuses invalid resolved root %j before registry or provider launch',
    (root) =>
      withStore(async (fixture) => {
        class InvalidHost extends Host {
          agentBrokerRoot() {
            return root
          }
        }
        const host = new InvalidHost()
        await expect(
          DurableRemoteChannel.open(host, 'exec codex app-server', {
            store: fixture.store,
            provider: 'codex',
          }),
        ).rejects.toMatchObject({ reason: 'ownership' })
        expect(host.commands).toEqual([])
        expect(await Effect.runPromise(fixture.store.listTransports())).toEqual([])
      }),
  )

  it.each([
    ['profile', { id: 'foreign-profile' }],
    ['host', { host: 'foreign-host' }],
    ['port', { port: 2222 }],
    ['username', { username: 'foreign-user' }],
  ])('refuses a foreign %s before requesting an SSH attachment', (_field, patch) =>
    withStore(async (fixture) => {
      const snapshot = await createSnapshot(fixture.store)
      const host = new Host()
      host.state = { ...host.state, profile: { ...host.state.profile!, ...patch } }
      await expect(restored(fixture, host, snapshot)).rejects.toThrow()
      expect(host.commands).toEqual([])
      expect(
        (await Effect.runPromise(fixture.store.readTransport(snapshot.transport.id))).inputs,
      ).toEqual([])
    }),
  )

  it('refuses a missing durable journal without launching a replacement provider', () =>
    withStore(async (fixture) => {
      const missing: NativeRecoverySnapshot = {
        transport: descriptor(),
        allocatedInputSequence: 0,
        acknowledgedInputSequence: 0,
        outputCursor: 0,
        eventRevision: 0,
        inputs: [],
        outputs: [],
        events: [],
        historyAcks: [],
        historyPrepares: [],
        records: [],
      }
      const host = new Host()
      await expect(restored(fixture, host, missing)).rejects.toThrow()
      expect(host.commands).toEqual([])
      expect(await Effect.runPromise(fixture.store.listTransports())).toEqual([])
    }))

  it.each([
    ['old protocol', { protocol: 1 }],
    ['missing lease', { writerLease: undefined }],
    ['unavailable writer', { writerLease: undefined, writerUnavailable: true }],
    ['unknown input high-water', { lastInputSequence: 1 }],
  ])('fails %s locally without writing, closing or replacing the provider', (_label, ready) =>
    withStore(async (fixture) => {
      const snapshot = await createSnapshot(fixture.store)
      const host = new Host()
      host.readyOverrides = ready
      await expect(restored(fixture, host, snapshot)).rejects.toThrow()
      expect(host.commands).toHaveLength(1)
      expect(brokerConfiguration(host.commands[0]).launch).toBe(false)
      expect(host.attachments[0].inputs).toEqual([])
      expect(host.attachments[0].closeCount).toBeGreaterThan(0)
      const retained = await Effect.runPromise(fixture.store.readTransport(snapshot.transport.id))
      expect(retained.inputs).toEqual([])
      expect(retained.transport.brokerId).toBe(snapshot.transport.brokerId)
    }),
  )

  it('retries original numbered bytes with a renewed lease rather than creating a new prompt', () =>
    withStore(async (fixture) => {
      const initial = await createSnapshot(fixture.store)
      const message = {
        id: 'exact-user-request',
        method: 'turn/start',
        params: {
          threadId: 'native-thread',
          input: [{ type: 'text', text: '  exact\r\n😀\u0000\n' }],
        },
      }
      const bytes = Buffer.from(JSON.stringify(message) + '\n')
      const original = await Effect.runPromise(
        fixture.store.reserveInput(
          initial.transport.id,
          { type: 'write', data: bytes.toString('base64') },
          {
            kind: 'user-prompt',
            sessionId: 'life-session',
            requestId: message.id,
            method: message.method,
          },
        ),
      )
      const snapshot = await Effect.runPromise(fixture.store.readTransport(initial.transport.id))
      const host = new Host()
      host.automaticReceipts = false
      const channel = await restored(fixture, host, snapshot, true)
      channel.resumeRecoveryOutput()
      await channel.activateRecoveryInputs()
      await vi.waitFor(() => expect(host.attachments[0].inputs).toHaveLength(1))
      const first = host.attachments[0].inputs[0]
      expect(first).toMatchObject(original.frame)
      expect(first.writerLease).toEqual({ epoch: 1, token: 'fixture-lease-1' })
      host.disconnect()
      host.reconnect()
      await vi.waitFor(() => expect(host.attachments[1]?.inputs).toHaveLength(1))
      const second = host.attachments[1].inputs[0]
      expect(second).toMatchObject(original.frame)
      expect(second.writerLease).toEqual({ epoch: 2, token: 'fixture-lease-2' })
      expect(Buffer.from(second.data as string, 'base64').equals(bytes)).toBe(true)
      const stored = await Effect.runPromise(fixture.store.readTransport(initial.transport.id))
      expect(stored.allocatedInputSequence).toBe(1)
      expect(stored.inputs[0].wire).toBe(original.wire)
      expect(stored.inputs[0].semantic).toEqual(original.semantic)
      expect(stored.inputs[0].frame).not.toHaveProperty('writerLease')
      expect(stored.inputs[0].wire).not.toContain('fixture-lease')
    }))

  it('uses ready high-water and final receipts to acknowledge accepted inputs without resending them', () =>
    withStore(async (fixture) => {
      const initial = await createSnapshot(fixture.store)
      for (const requestId of [1, 2]) {
        const message = {
          id: requestId,
          method: 'turn/start',
          params: { prompt: `exact request ${requestId}` },
        }
        await Effect.runPromise(
          fixture.store.reserveInput(
            initial.transport.id,
            { type: 'write', data: Buffer.from(JSON.stringify(message) + '\n').toString('base64') },
            { kind: 'user-prompt', requestId, method: message.method },
          ),
        )
      }
      const snapshot = await Effect.runPromise(fixture.store.readTransport(initial.transport.id))
      const host = new Host()
      host.readyOverrides = { lastInputSequence: 2, cursor: 2 }
      host.afterReady = (attachment) => {
        attachment.frame({ type: 'inputReceipt', cursor: 1, sequence: 1, status: 'written' })
        attachment.frame({ type: 'inputReceipt', cursor: 2, sequence: 2, status: 'written' })
      }
      const channel = await restored(fixture, host, snapshot, true)
      channel.resumeRecoveryOutput()
      await channel.activateRecoveryInputs()
      expect(host.attachments[0].inputs).toEqual([])
      const reconciled = await Effect.runPromise(fixture.store.readTransport(initial.transport.id))
      expect(reconciled.acknowledgedInputSequence).toBe(2)
      expect(reconciled.inputs.every((input) => input.acknowledged)).toBe(true)
      await write(channel, 'new exact request\n')
      await vi.waitFor(() => expect(host.attachments[0].inputs).toHaveLength(1))
      expect(host.attachments[0].inputs[0]).toMatchObject({
        type: 'write',
        sequence: 3,
        data: Buffer.from('new exact request\n').toString('base64'),
      })
    }))

  it('holds unresolved inputs until explicit activation and the replay marker', () =>
    withStore(async (fixture) => {
      const initial = await createSnapshot(fixture.store)
      await Effect.runPromise(
        fixture.store.reserveInput(
          initial.transport.id,
          { type: 'write', data: Buffer.from('pending prompt\n').toString('base64') },
          { kind: 'user-prompt', sessionId: 'life-session' },
        ),
      )
      const snapshot = await Effect.runPromise(fixture.store.readTransport(initial.transport.id))
      const host = new Host()
      host.automaticMarker = false
      const channel = await restored(fixture, host, snapshot, true)
      channel.resumeRecoveryOutput()
      let activated = false
      const activation = channel.activateRecoveryInputs().then(() => {
        activated = true
      })
      await nextTurn()
      expect(activated).toBe(false)
      expect(host.attachments[0].inputs).toEqual([])
      host.attachments[0].frame({ type: 'replayComplete', replayCursor: 0 })
      await activation
      expect(host.attachments[0].inputs).toHaveLength(1)
      expect(host.attachments[0].inputs[0].sequence).toBe(1)
    }))

  it('creates a new replay barrier for each renewed attachment', () =>
    withStore(async (fixture) => {
      const snapshot = await createSnapshot(fixture.store)
      const host = new Host()
      const channel = await restored(fixture, host, snapshot, true)
      const errors: Error[] = []
      channel.on('error', (error: Error) => errors.push(error))
      channel.resumeRecoveryOutput()
      await channel.activateRecoveryInputs()
      host.automaticMarker = false
      host.disconnect()
      host.reconnect()
      await vi.waitFor(() => expect(host.attachments).toHaveLength(2))
      await vi.waitFor(() => expect(channel.transportState).toBe('connected'))
      let replayed = false
      const replay = channel.waitForReplay().then(() => {
        replayed = true
      })
      await nextTurn()
      expect(replayed).toBe(false)
      host.attachments[1].frame({ type: 'replayComplete', replayCursor: 0 })
      await replay
      expect(errors).toEqual([])
      expect(host.attachments[1].inputs).toEqual([])
    }))

  it('keeps tracked ownership suspended when reconnect selects a different profile for the same host', () =>
    withStore(async (fixture) => {
      const snapshot = await createSnapshot(fixture.store)
      const host = new Host()
      const channel = await restored(fixture, host, snapshot)
      host.disconnect()
      host.reconnect({
        ...connected,
        profile: { ...connected.profile!, id: 'another-profile-for-same-host' },
      })
      await nextTurn()
      expect(host.attachments).toHaveLength(1)
      expect(channel.transportState).toBe('suspended')
      host.reconnect()
      await vi.waitFor(() => expect(host.attachments).toHaveLength(2))
      expect(brokerConfiguration(host.commands[1])).toMatchObject({
        root: snapshot.transport.brokerRoot,
        launch: false,
      })
    }))

  it('does not acknowledge or transmit a write before its write-ahead admission completes', () =>
    withStore(async (fixture) => {
      const gate = Deferred.makeUnsafe<void>()
      let admitting = false
      const delayed: NativeRecoveryStoreHandle = {
        ...fixture.store,
        reserveInput: (id, frame, semantic) =>
          Effect.gen(function* () {
            admitting = true
            yield* Deferred.await(gate)
            return yield* fixture.store.reserveInput(id, frame, semantic)
          }),
      }
      const snapshot = await createSnapshot(fixture.store)
      const host = new Host()
      const channel = await restored(fixture, host, snapshot, false, delayed)
      channel.resumeRecoveryOutput()
      await channel.activateRecoveryInputs()
      let acknowledged = false
      const delivery = write(channel, 'exact admitted bytes\n').then(() => {
        acknowledged = true
      })
      await vi.waitFor(() => expect(admitting).toBe(true))
      expect(acknowledged).toBe(false)
      expect(host.attachments[0].inputs).toEqual([])
      expect(
        (await Effect.runPromise(fixture.store.readTransport(snapshot.transport.id))).inputs,
      ).toEqual([])
      Deferred.doneUnsafe(gate, Effect.void)
      await delivery
      await vi.waitFor(() => expect(host.attachments[0].inputs).toHaveLength(1))
      const retained = await Effect.runPromise(fixture.store.readTransport(snapshot.transport.id))
      expect(host.attachments[0].inputs[0]).toMatchObject(retained.inputs[0].frame)
    }))

  it('rejects a failed write-ahead commit and fences subsequent mutations without native close', () =>
    withStore(async (fixture) => {
      const snapshot = await createSnapshot(fixture.store)
      const failure = new NativeRecoveryError({
        operation: 'injected-input-write',
        path: fixture.directory,
        reason: 'io',
        message: 'Injected durable input write failure',
      })
      const failing: NativeRecoveryStoreHandle = {
        ...fixture.store,
        reserveInput: () => Effect.fail(failure),
      }
      const host = new Host()
      const channel = await restored(fixture, host, snapshot, false, failing)
      const errors: Error[] = []
      channel.on('error', (error: Error) => errors.push(error))
      channel.resumeRecoveryOutput()
      await channel.activateRecoveryInputs()
      await expect(write(channel, 'must not reach native stdin\n')).rejects.toThrow()
      await vi.waitFor(() => expect(errors.length).toBeGreaterThan(0))
      expect(() => channel.writeNative({ id: 'late', method: 'turn/start', params: {} })).toThrow(
        NativeRecoveryError,
      )
      expect(host.attachments[0].inputs).toEqual([])
      const retained = await Effect.runPromise(fixture.store.readTransport(snapshot.transport.id))
      expect(retained.allocatedInputSequence).toBe(0)
      expect(retained.transport.brokerId).toBe(snapshot.transport.brokerId)
    }))

  it('keeps an offline native envelope pending after WAL admission until its own written receipt', () =>
    withStore(async (fixture) => {
      const snapshot = await createSnapshot(fixture.store)
      const gate = Deferred.makeUnsafe<void>()
      let admitting = false
      const delayed: NativeRecoveryStoreHandle = {
        ...fixture.store,
        reserveInput: (id, frame, semantic) =>
          Effect.gen(function* () {
            admitting = true
            yield* Deferred.await(gate)
            return yield* fixture.store.reserveInput(id, frame, semantic)
          }),
      }
      const host = new Host()
      const channel = await restored(fixture, host, snapshot, false, delayed)
      channel.resumeRecoveryOutput()
      await channel.activateRecoveryInputs()
      host.disconnect()
      const message = {
        id: 'native-input-id',
        method: 'turn/start',
        params: { threadId: 'native-thread', prompt: '  exact offline\r\n😀\u0000\n' },
      }
      const semantic = {
        kind: 'user-prompt' as const,
        sessionId: 'life-session',
        requestId: message.id,
        method: message.method,
        nativeThreadId: 'native-thread',
      }
      let admitted = false
      const admission = channel.writeNativeAndWait(message, semantic).then(() => {
        admitted = true
      })
      try {
        await vi.waitFor(() => expect(admitting).toBe(true))
        expect(admitted).toBe(false)
        expect(host.attachments[0].inputs).toEqual([])
        expect(
          (await Effect.runPromise(fixture.store.readTransport(snapshot.transport.id))).inputs,
        ).toEqual([])
        Deferred.doneUnsafe(gate, Effect.void)
        await channel.flushRecovery()
        expect(admitted).toBe(false)
        const retained = await Effect.runPromise(fixture.store.readTransport(snapshot.transport.id))
        expect(retained.inputs).toHaveLength(1)
        expect(retained.inputs[0].semantic).toEqual(semantic)
        expect(
          Buffer.from((retained.inputs[0].frame as { data: string }).data, 'base64').toString(),
        ).toBe(JSON.stringify(message) + '\n')
        expect(retained.inputs[0].acknowledged).toBe(false)
        expect(host.attachments[0].inputs).toEqual([])
        host.reconnect()
        await admission
        const written = await Effect.runPromise(fixture.store.readTransport(snapshot.transport.id))
        expect(written.inputs[0].written).toBe(true)
        expect(written.inputs[0].deliveryReceipt?.status).toBe('written')
        expect(host.attachments[1].inputs).toHaveLength(1)
      } finally {
        Deferred.doneUnsafe(gate, Effect.void)
      }
    }))

  it('flushes and detaches only after both accepted Writable buffers retain their exact semantics', () =>
    withStore(async (fixture) => {
      const snapshot = await createSnapshot(fixture.store)
      const firstGate = Deferred.makeUnsafe<void>()
      const secondGate = Deferred.makeUnsafe<void>()
      let reservations = 0
      const delayed: NativeRecoveryStoreHandle = {
        ...fixture.store,
        reserveInput: (id, frame, semantic) =>
          Effect.gen(function* () {
            const current = ++reservations
            yield* Deferred.await(current === 1 ? firstGate : secondGate)
            return yield* fixture.store.reserveInput(id, frame, semantic)
          }),
      }
      const host = new Host()
      const channel = await restored(fixture, host, snapshot, false, delayed)
      channel.resumeRecoveryOutput()
      await channel.activateRecoveryInputs()
      host.disconnect()
      const first = { id: 'first-native-id', method: 'initialize', params: { exact: ' first\r\n' } }
      const second = {
        id: 'second-native-id',
        result: { decision: 'accept', exact: ['second', null, '😀\u0000'] },
      }
      const firstSemantic = {
        kind: 'initialize' as const,
        requestId: first.id,
        method: first.method,
      }
      const secondSemantic = {
        kind: 'permission-response' as const,
        sessionId: 'life-session',
        permissionRequestId: second.id,
        requestType: 'item/commandExecution/requestApproval',
        responseBinding: { exactNativePayload: second.result },
      }
      channel.writeNative(first, firstSemantic)
      channel.writeNative(second, secondSemantic)
      await vi.waitFor(() => expect(reservations).toBe(1))
      let flushed = false
      let detached = false
      const flush = channel.flushRecovery().then(() => {
        flushed = true
      })
      const detach = channel.detach().then(() => {
        detached = true
      })
      try {
        await expect(
          channel.writeNativeAndWait({ id: 'late', method: 'turn/start', params: {} }),
        ).rejects.toBeInstanceOf(NativeRecoveryError)
        expect(() =>
          channel.writeNative({ id: 'later', method: 'turn/start', params: {} }),
        ).toThrow(NativeRecoveryError)
        expect(flushed).toBe(false)
        expect(detached).toBe(false)
        Deferred.doneUnsafe(firstGate, Effect.void)
        await vi.waitFor(() => expect(reservations).toBe(2))
        const intermediate = await Effect.runPromise(
          fixture.store.readTransport(snapshot.transport.id),
        )
        expect(intermediate.inputs).toHaveLength(1)
        expect(intermediate.inputs[0].semantic).toEqual(firstSemantic)
        expect(flushed).toBe(false)
        expect(detached).toBe(false)
        expect(channel.transportState).toBe('suspended')
        Deferred.doneUnsafe(secondGate, Effect.void)
        await Promise.all([flush, detach])
        const retained = await Effect.runPromise(fixture.store.readTransport(snapshot.transport.id))
        expect(retained.inputs).toHaveLength(2)
        expect(retained.inputs.map((input) => input.semantic)).toEqual([
          firstSemantic,
          secondSemantic,
        ])
        expect(
          retained.inputs.map((input) =>
            Buffer.from((input.frame as { data: string }).data, 'base64').toString(),
          ),
        ).toEqual([JSON.stringify(first) + '\n', JSON.stringify(second) + '\n'])
        expect(retained.allocatedInputSequence).toBe(2)
        expect(retained.inputs.every((input) => !input.acknowledged)).toBe(true)
        expect(host.attachments[0].inputs).toEqual([])
        expect(channel.transportState).toBe('closed')
        expect(host.listenerCount('state')).toBe(0)
      } finally {
        Deferred.doneUnsafe(firstGate, Effect.void)
        Deferred.doneUnsafe(secondGate, Effect.void)
      }
    }))

  it('durably stores output before exposing it to the native parser', () =>
    withStore(async (fixture) => {
      const snapshot = await createSnapshot(fixture.store)
      const gate = Deferred.makeUnsafe<void>()
      let admitting = false
      const delayed: NativeRecoveryStoreHandle = {
        ...fixture.store,
        appendOutputs: (id, frames) =>
          Effect.gen(function* () {
            admitting = true
            yield* Deferred.await(gate)
            return yield* fixture.store.appendOutputs(id, frames)
          }),
      }
      const host = new Host()
      const channel = await restored(fixture, host, snapshot, false, delayed)
      const received: Buffer[] = []
      channel.on('data', (bytes: Buffer) => received.push(bytes))
      channel.resumeRecoveryOutput()
      const frame = {
        type: 'stdout',
        cursor: 1,
        data: Buffer.from('{"text":"exact native output"}\n').toString('base64'),
      }
      host.attachments[0].frame(frame)
      await vi.waitFor(() => expect(admitting).toBe(true))
      expect(received).toEqual([])
      expect(
        (await Effect.runPromise(fixture.store.readTransport(snapshot.transport.id))).outputCursor,
      ).toBe(0)
      Deferred.doneUnsafe(gate, Effect.void)
      await vi.waitFor(() => expect(received).toHaveLength(1))
      const retained = await Effect.runPromise(fixture.store.readTransport(snapshot.transport.id))
      expect(retained.outputs).toEqual([frame])
      expect(Buffer.concat(received).toString()).toBe('{"text":"exact native output"}\n')
    }))

  it('keeps failed output commits invisible and leaves the provider detached rather than stopped', () =>
    withStore(async (fixture) => {
      const snapshot = await createSnapshot(fixture.store)
      const failing: NativeRecoveryStoreHandle = {
        ...fixture.store,
        appendOutputs: () =>
          Effect.fail(
            new NativeRecoveryError({
              operation: 'injected-output-write',
              path: fixture.directory,
              reason: 'io',
              message: 'Injected durable output write failure',
            }),
          ),
      }
      const host = new Host()
      const channel = await restored(fixture, host, snapshot, false, failing)
      const errors: Error[] = []
      const received: Buffer[] = []
      channel.on('error', (error: Error) => errors.push(error))
      channel.on('data', (bytes: Buffer) => received.push(bytes))
      channel.resumeRecoveryOutput()
      host.attachments[0].frame({
        type: 'stdout',
        cursor: 1,
        data: Buffer.from('uncommitted output').toString('base64'),
      })
      await vi.waitFor(() => expect(errors.length).toBeGreaterThan(0))
      expect(received).toEqual([])
      expect(host.attachments[0].inputs).toEqual([])
      const retained = await Effect.runPromise(fixture.store.readTransport(snapshot.transport.id))
      expect(retained.outputCursor).toBe(0)
      expect(retained.outputs).toEqual([])
    }))

  it('waits for replay output durability before releasing recovered input', () =>
    withStore(async (fixture) => {
      const initial = await createSnapshot(fixture.store)
      await Effect.runPromise(
        fixture.store.reserveInput(
          initial.transport.id,
          { type: 'write', data: Buffer.from('exact pending response\n').toString('base64') },
          { kind: 'permission-response', permissionRequestId: 'native-approval-id' },
        ),
      )
      const snapshot = await Effect.runPromise(fixture.store.readTransport(initial.transport.id))
      const gate = Deferred.makeUnsafe<void>()
      let admitting = false
      const delayed: NativeRecoveryStoreHandle = {
        ...fixture.store,
        appendOutputs: (id, frames) =>
          Effect.gen(function* () {
            admitting = true
            yield* Deferred.await(gate)
            return yield* fixture.store.appendOutputs(id, frames)
          }),
      }
      const host = new Host()
      host.readyOverrides = { cursor: 1 }
      host.afterReady = (attachment) =>
        attachment.frame({
          type: 'stdout',
          cursor: 1,
          data: Buffer.from('replay').toString('base64'),
        })
      const channel = await restored(fixture, host, snapshot, true, delayed)
      channel.resumeRecoveryOutput()
      let activated = false
      const activation = channel.activateRecoveryInputs().then(() => {
        activated = true
      })
      await vi.waitFor(() => expect(admitting).toBe(true))
      expect(activated).toBe(false)
      expect(host.attachments[0].inputs).toEqual([])
      Deferred.doneUnsafe(gate, Effect.void)
      await activation
      expect(host.attachments[0].inputs).toHaveLength(1)
      expect(
        (await Effect.runPromise(fixture.store.readTransport(snapshot.transport.id))).outputCursor,
      ).toBe(1)
    }))

  it('keeps recovered input fenced while committed replay is blocked behind its output consumer', () =>
    withStore(async (fixture) => {
      const initial = await createSnapshot(fixture.store)
      await Effect.runPromise(
        fixture.store.reserveInput(
          initial.transport.id,
          { type: 'write', data: Buffer.from('exact permission response\n').toString('base64') },
          { kind: 'permission-response', permissionRequestId: 'native-approval-id' },
        ),
      )
      const snapshot = await Effect.runPromise(fixture.store.readTransport(initial.transport.id))
      const host = new Host()
      const first = Buffer.alloc(65536, 'x')
      const second = Buffer.from('last replay bytes\n')
      host.readyOverrides = { cursor: 2 }
      host.afterReady = (attachment) => {
        attachment.frame({ type: 'stdout', cursor: 1, data: first.toString('base64') })
        attachment.frame({ type: 'stdout', cursor: 2, data: second.toString('base64') })
      }
      const channel = await restored(fixture, host, snapshot, true)
      channel.resumeRecoveryOutput()
      let activated = false
      const activation = channel.activateRecoveryInputs().then(() => {
        activated = true
      })
      await vi.waitFor(async () => {
        expect(
          (await Effect.runPromise(fixture.store.readTransport(snapshot.transport.id)))
            .outputCursor,
        ).toBe(2)
      })
      await nextTurn()
      expect(activated).toBe(false)
      expect(host.attachments[0].inputs).toEqual([])
      const received: Buffer[] = []
      channel.on('data', (bytes: Buffer) => received.push(bytes))
      await activation
      expect(Buffer.concat(received).equals(Buffer.concat([first, second]))).toBe(true)
      expect(host.attachments[0].inputs).toHaveLength(1)
    }))

  it('retains byte-exact split UTF-8, stdout and stderr before replaying a terminal exit', () =>
    withStore(async (fixture) => {
      const snapshot = await createSnapshot(fixture.store)
      const host = new Host()
      host.automaticMarker = false
      host.readyOverrides = { cursor: 5, terminal: true, writerLease: undefined }
      const channel = await restored(fixture, host, snapshot, true)
      const stdout: Buffer[] = []
      const stderr: Buffer[] = []
      const exits: unknown[][] = []
      channel.on('data', (bytes: Buffer) => stdout.push(bytes))
      channel.stderr.on('data', (bytes: Buffer) => stderr.push(bytes))
      channel.on('exit', (...values: unknown[]) => exits.push(values))
      channel.resumeRecoveryOutput()
      const bytes = Buffer.from('{"text":"😀 exact\r\nend"}\n')
      const emoji = bytes.indexOf(Buffer.from('😀'))
      const chunks = [
        bytes.subarray(0, emoji + 1),
        bytes.subarray(emoji + 1, emoji + 3),
        bytes.subarray(emoji + 3),
      ]
      const frames = [
        { type: 'stdout', cursor: 1, data: chunks[0].toString('base64') },
        { type: 'stderr', cursor: 2, data: Buffer.from('exact stderr\u0000\n').toString('base64') },
        { type: 'stdout', cursor: 3, data: chunks[1].toString('base64') },
        { type: 'stdout', cursor: 4, data: chunks[2].toString('base64') },
        { type: 'exit', cursor: 5, code: 0, signal: null },
      ]
      for (const frame of frames) host.attachments[0].frame(frame)
      host.attachments[0].frame({ type: 'replayComplete', replayCursor: 5 })
      await channel.waitForReplay()
      await vi.waitFor(() => expect(exits).toHaveLength(1))
      expect(Buffer.concat(stdout).equals(bytes)).toBe(true)
      expect(Buffer.concat(stderr).equals(Buffer.from('exact stderr\u0000\n'))).toBe(true)
      const retained = await Effect.runPromise(fixture.store.readTransport(snapshot.transport.id))
      expect(retained.outputs).toEqual(frames)
      expect(retained.outputCursor).toBe(5)
      expect(host.attachments[0].inputs).toEqual([])
    }))

  it('keeps restored output held until consumers are ready, without losing its committed bytes', () =>
    withStore(async (fixture) => {
      const snapshot = await createSnapshot(fixture.store)
      const host = new Host()
      host.readyOverrides = { cursor: 1 }
      host.afterReady = (attachment) =>
        attachment.frame({
          type: 'stdout',
          cursor: 1,
          data: Buffer.from('held replay').toString('base64'),
        })
      const channel = await restored(fixture, host, snapshot, true)
      await nextTurn()
      expect(channel.readableLength).toBe(0)
      const received: Buffer[] = []
      channel.on('data', (bytes: Buffer) => received.push(bytes))
      channel.resume()
      await nextTurn()
      await nextTurn()
      expect(received).toEqual([])
      expect(
        (await Effect.runPromise(fixture.store.readTransport(snapshot.transport.id))).outputCursor,
      ).toBe(0)
      channel.resumeRecoveryOutput()
      await channel.waitForReplay()
      expect(Buffer.concat(received).toString()).toBe('held replay')
      const retained = await Effect.runPromise(fixture.store.readTransport(snapshot.transport.id))
      expect(retained.outputs[0]).toMatchObject({ type: 'stdout', cursor: 1 })
    }))

  it('keeps the remote suffix held while CodexRPC auto-resumes and folds its local WAL', () =>
    withStore(async (fixture) => {
      const initial = await createSnapshot(fixture.store)
      const recorded = { method: 'thread/started', params: { thread: { id: 'native-recorded' } } }
      const suffix = {
        method: 'turn/started',
        params: { threadId: 'native-recorded', turn: { id: 'native-active' } },
      }
      await Effect.runPromise(
        fixture.store.appendOutputs(initial.transport.id, [
          {
            type: 'stdout',
            cursor: 1,
            data: Buffer.from(JSON.stringify(recorded) + '\n').toString('base64'),
          },
        ]),
      )
      const snapshot = await Effect.runPromise(fixture.store.readTransport(initial.transport.id))
      const host = new Host()
      host.readyOverrides = { cursor: 2 }
      host.afterReady = (attachment) =>
        attachment.frame({
          type: 'stdout',
          cursor: 2,
          data: Buffer.from(JSON.stringify(suffix) + '\n').toString('base64'),
        })
      const channel = await restored(fixture, host, snapshot, true)
      const received: Wire[] = []
      const failures: Error[] = []
      const rpc = new CodexRPC(
        channel as unknown as ClientChannel,
        (message) => received.push(message),
        (error) => failures.push(error),
      )
      let replayed = false
      const replay = channel.waitForReplay().then(() => {
        replayed = true
      })
      channel.resume()
      await nextTurn()
      await nextTurn()
      expect(received).toEqual([])
      expect(replayed).toBe(false)
      expect(
        (await Effect.runPromise(fixture.store.readTransport(initial.transport.id))).outputCursor,
      ).toBe(1)
      for (const output of snapshot.outputs)
        if (output.type === 'stdout') rpc.replayOutput(Buffer.from(output.data, 'base64'))
      expect(received).toEqual([recorded])
      await nextTurn()
      expect(received).toEqual([recorded])
      channel.resumeRecoveryOutput()
      await replay
      expect(received).toEqual([recorded, suffix])
      expect(failures).toEqual([])
      expect(host.attachments[0].inputs).toEqual([])
      expect(
        (await Effect.runPromise(fixture.store.readTransport(initial.transport.id))).outputCursor,
      ).toBe(2)
    }))

  it('does not retire terminal replay before its marker flush has committed', () =>
    withStore(async (fixture) => {
      const snapshot = await createSnapshot(fixture.store)
      const gate = Deferred.makeUnsafe<void>()
      let flushing = false
      const delayed: NativeRecoveryStoreHandle = {
        ...fixture.store,
        flushEffect: () =>
          Effect.gen(function* () {
            flushing = true
            yield* Deferred.await(gate)
            yield* fixture.store.flushEffect()
          }),
      }
      const host = new Host()
      host.automaticMarker = false
      host.readyOverrides = { terminal: true, writerLease: undefined, cursor: 1 }
      const channel = await restored(fixture, host, snapshot, true, delayed)
      const exits: unknown[][] = []
      channel.on('exit', (...values: unknown[]) => exits.push(values))
      channel.resumeRecoveryOutput()
      let completed = false
      let failed: unknown
      const replay = channel.waitForReplay().then(
        () => {
          completed = true
        },
        (error) => {
          failed = error
        },
      )
      try {
        host.attachments[0].frame({ type: 'exit', cursor: 1, code: 0, signal: null })
        host.attachments[0].frame({ type: 'replayComplete', replayCursor: 1 })
        await vi.waitFor(() => expect(flushing).toBe(true))
        await vi.waitFor(() => expect(exits).toHaveLength(1))
        await nextTurn()
        expect(completed).toBe(false)
        expect(failed).toBeUndefined()
        expect(channel.transportState).toBe('connected')
        Deferred.doneUnsafe(gate, Effect.void)
        await replay
        expect(failed).toBeUndefined()
        expect(completed).toBe(true)
        await vi.waitFor(() => expect(channel.transportState).toBe('closed'))
      } finally {
        Deferred.doneUnsafe(gate, Effect.void)
      }
    }))

  it('rejects missing output frames and unsolicited acknowledgments without native mutation', () =>
    withStore(async (fixture) => {
      for (const frame of [
        { type: 'stdout', cursor: 2, data: Buffer.from('gap').toString('base64') },
        { type: 'ack', sequence: 1 },
      ]) {
        const snapshot = await createSnapshot(fixture.store)
        const host = new Host()
        const channel = await restored(fixture, host, snapshot)
        const errors: Error[] = []
        channel.on('error', (error: Error) => errors.push(error))
        channel.resumeRecoveryOutput()
        host.attachments[0].frame(frame)
        await vi.waitFor(() => expect(errors.length).toBeGreaterThan(0))
        expect(host.attachments[0].inputs).toEqual([])
        const retained = await Effect.runPromise(fixture.store.readTransport(snapshot.transport.id))
        expect(retained.outputCursor).toBe(0)
        expect(retained.acknowledgedInputSequence).toBe(0)
      }
    }))

  it.each([
    ['invalid base64 length', { type: 'stdout', cursor: 1, data: 'Zg=' }],
    ['noncanonical base64 bytes', { type: 'stdout', cursor: 1, data: 'Zh==' }],
    ['fractional cursor', { type: 'stdout', cursor: 1.5, data: 'Zg==' }],
    ['unsafe cursor', { type: 'stdout', cursor: Number.MAX_SAFE_INTEGER + 1, data: 'Zg==' }],
  ])('does not admit %s to durable output or downstream consumers', (_label, frame) =>
    withStore(async (fixture) => {
      const snapshot = await createSnapshot(fixture.store)
      const host = new Host()
      const channel = await restored(fixture, host, snapshot)
      const errors: Error[] = []
      const received: Buffer[] = []
      channel.on('error', (error: Error) => errors.push(error))
      channel.on('data', (bytes: Buffer) => received.push(bytes))
      channel.resumeRecoveryOutput()
      host.attachments[0].frame(frame)
      await vi.waitFor(() => expect(errors.length).toBeGreaterThan(0))
      expect(received).toEqual([])
      expect(host.attachments[0].inputs).toEqual([])
      const retained = await Effect.runPromise(fixture.store.readTransport(snapshot.transport.id))
      expect(retained.outputs).toEqual([])
      expect(retained.outputCursor).toBe(0)
    }),
  )

  it('records exact owner input and native identity without manufacturing another launch', () =>
    withStore(async (fixture) => {
      const snapshot = await createSnapshot(fixture.store)
      const host = new Host()
      const channel = await restored(fixture, host, snapshot)
      const owner: NativeRecoveryOwner = {
        ownerId: 'life-session:7',
        sessionId: 'life-session',
        generation: 7,
        kind: 'root',
        workspace: '/project',
        writableRoot: '/project',
        nativeThreadId: 'native-thread',
        nativeTurnId: 'native-turn',
        state: 'active',
        input: {
          sessionId: 'life-session',
          provider: 'codex',
          prompt: '  preserved\r\n😀\u0000\n',
          mode: 'read-only',
          workspace: '/project',
          futureNativeMetadata: { exact: ['opaque', null] },
        },
      }
      await channel.recordOwner(owner)
      const retained = await Effect.runPromise(fixture.store.readTransport(snapshot.transport.id))
      expect(retained.transport.owners).toEqual([owner])
      expect(channel.recoveryDescriptor?.owners).toEqual([owner])
      expect(host.commands).toHaveLength(1)
      expect(host.attachments[0].inputs).toEqual([])
    }))

  it('atomically cancels offline inputs with close and recovers only that terminal delivery', () =>
    withStore(async (fixture) => {
      const host = new Host()
      const channel = await DurableRemoteChannel.open(host, 'exec codex app-server', {
        store: fixture.store,
        provider: 'codex',
      })
      fixture.channels.add(channel)
      host.disconnect()
      await write(channel, 'first prompt that Stop discards\n')
      await write(channel, 'second prompt that Stop discards\n')
      channel.close()
      let snapshot!: NativeRecoverySnapshot
      await vi.waitFor(async () => {
        snapshot = await Effect.runPromise(fixture.store.readTransport(channel.recoveryId!))
        expect(snapshot.inputs.at(-1)?.frame.type).toBe('close')
      })
      expect(snapshot.inputs.map((input) => input.frame.type)).toEqual(['write', 'write', 'close'])
      expect(snapshot.inputs.slice(0, 2).every((input) => Boolean(input.cancellation))).toBe(true)
      const journal = join(
        fixture.directory,
        createHash('sha256').update(snapshot.transport.id).digest('hex') + '.jsonl',
      )
      const batches = (await readFile(journal, 'utf8'))
        .trimEnd()
        .split('\n')
        .map((line) => JSON.parse(line) as { records: Frame[] })
      const terminalBatch = batches.find((batch) =>
        batch.records.some((record) => {
          const input = record.input as { frame?: Frame } | undefined
          return record.kind === 'input' && input?.frame?.type === 'close'
        }),
      )
      expect(
        terminalBatch?.records.filter((record) => record.kind === 'input-cancel'),
      ).toHaveLength(2)
      await channel.detach()
      const nextHost = new Host()
      const recovered = await restored(fixture, nextHost, snapshot, true)
      recovered.resumeRecoveryOutput()
      await recovered.activateRecoveryInputs()
      await vi.waitFor(() => expect(nextHost.attachments[0].inputs).toHaveLength(1))
      expect(nextHost.attachments[0].inputs[0]).toMatchObject({ type: 'close', sequence: 3 })
      expect(nextHost.attachments[0].inputs.some((input) => input.type === 'write')).toBe(false)
    }))

  it('retains explicit Stop admission when close-listener cleanup races an outstanding write', () =>
    withStore(async (fixture) => {
      const gate = Deferred.makeUnsafe<void>()
      let admitting = false
      const delayed: NativeRecoveryStoreHandle = {
        ...fixture.store,
        reserveInput: (id, frame, semantic) =>
          Effect.gen(function* () {
            if (frame.type === 'write') {
              admitting = true
              yield* Deferred.await(gate)
            }
            return yield* fixture.store.reserveInput(id, frame, semantic)
          }),
      }
      const host = new Host()
      const channel = await DurableRemoteChannel.open(host, 'exec codex app-server', {
        store: delayed,
        provider: 'codex',
      })
      fixture.channels.add(channel)
      channel.on('error', () => {})
      host.disconnect()
      const delivery = write(channel, 'prompt discarded during Stop\n').catch(() => {})
      await vi.waitFor(() => expect(admitting).toBe(true))
      channel.once('close', () => channel.destroy())
      channel.close()
      Deferred.doneUnsafe(gate, Effect.void)
      await delivery
      let retained!: NativeRecoverySnapshot
      await vi.waitFor(async () => {
        retained = await Effect.runPromise(fixture.store.readTransport(channel.recoveryId!))
        expect(retained.inputs.at(-1)?.frame.type).toBe('close')
      })
      expect(retained.inputs[0].cancellation).toBeTruthy()
      expect(retained.inputs.at(-1)?.frame).toMatchObject({ type: 'close', sequence: 2 })
      expect(host.attachments[0].inputs).toEqual([])
    }))

  it('discards unnumbered buffered native envelopes during Stop and cancels only admitted deliveries', () =>
    withStore(async (fixture) => {
      const snapshot = await createSnapshot(fixture.store)
      const gate = Deferred.makeUnsafe<void>()
      let reservations = 0
      const delayed: NativeRecoveryStoreHandle = {
        ...fixture.store,
        reserveInput: (id, frame, semantic) =>
          Effect.gen(function* () {
            if (frame.type === 'write') {
              reservations++
              yield* Deferred.await(gate)
            }
            return yield* fixture.store.reserveInput(id, frame, semantic)
          }),
      }
      const host = new Host()
      const channel = await restored(fixture, host, snapshot, false, delayed)
      channel.resumeRecoveryOutput()
      await channel.activateRecoveryInputs()
      const first = {
        id: 'first-request',
        method: 'turn/start',
        params: { prompt: 'numbered intent' },
      }
      const second = {
        id: 'second-request',
        method: 'turn/start',
        params: { prompt: 'buffered intent' },
      }
      channel.writeNative(first, { kind: 'user-prompt', requestId: first.id })
      channel.writeNative(second, { kind: 'user-prompt', requestId: second.id })
      await vi.waitFor(() => expect(reservations).toBe(1))
      try {
        channel.close()
        expect(host.attachments[0].inputs).toEqual([])
        Deferred.doneUnsafe(gate, Effect.void)
        await channel.flushRecovery()
        const retained = await Effect.runPromise(fixture.store.readTransport(snapshot.transport.id))
        expect(reservations).toBe(1)
        expect(retained.inputs.map((input) => input.frame.type)).toEqual(['write', 'close'])
        expect(retained.inputs[0].semantic.requestId).toBe(first.id)
        expect(retained.inputs[0].cancellation).toBeTruthy()
        expect(retained.inputs.at(-1)?.frame).toMatchObject({ type: 'close', sequence: 2 })
        expect(retained.inputs.some((input) => input.semantic.requestId === second.id)).toBe(false)
        await vi.waitFor(() => expect(host.attachments[0].inputs).toHaveLength(1))
        expect(host.attachments[0].inputs[0]).toMatchObject({ type: 'close', sequence: 2 })
      } finally {
        Deferred.doneUnsafe(gate, Effect.void)
      }
    }))

  it('retains an offline native signal with its copied owner until cold recovery obtains a written receipt', () =>
    withStore(async (fixture) => {
      const gate = Deferred.makeUnsafe<void>()
      let reserving = false
      const delayed: NativeRecoveryStoreHandle = {
        ...fixture.store,
        reserveInput: (id, frame, semantic) =>
          Effect.gen(function* () {
            if (frame.type === 'signal') {
              reserving = true
              yield* Deferred.await(gate)
            }
            return yield* fixture.store.reserveInput(id, frame, semantic)
          }),
      }
      const host = new Host()
      const channel = await DurableRemoteChannel.open(
        host,
        'exec claude --input-format stream-json',
        { store: delayed, provider: 'claude' },
      )
      fixture.channels.add(channel)
      host.disconnect()
      const details = { originalScope: 'root' }
      const semantic: NativeRecoveryInputSemantic = {
        kind: 'interrupt',
        sessionId: 'claude-root',
        ownerGeneration: 7,
        requestType: 'stop',
        details,
      }
      let admitted = false
      const signal = channel.signalNativeAndWait('TERM', semantic).then(
        () => {
          admitted = true
          return undefined
        },
        (error: unknown) => error,
      )
      await vi.waitFor(() => expect(reserving).toBe(true))
      details.originalScope = 'mutated-after-admission'
      expect(admitted).toBe(false)
      expect(host.attachments[0].inputs).toEqual([])
      Deferred.doneUnsafe(gate, Effect.void)
      await channel.flushRecovery()
      expect(admitted).toBe(false)
      const retained = await Effect.runPromise(fixture.store.readTransport(channel.recoveryId!))
      expect(retained.inputs).toHaveLength(1)
      expect(retained.inputs[0].frame).toEqual({ type: 'signal', signal: 'SIGTERM', sequence: 1 })
      expect(retained.inputs[0].semantic).toEqual({
        kind: 'interrupt',
        sessionId: 'claude-root',
        ownerGeneration: 7,
        requestType: 'stop',
        details: { originalScope: 'root' },
      })
      await channel.detach()
      expect(await signal).toBeInstanceOf(NativeRecoveryError)
      const recoveredHost = new Host()
      recoveredHost.readyOverrides = { writerLease: { epoch: 8, token: 'renewed-signal-lease' } }
      const restoredChannel = await restored(fixture, recoveredHost, retained, true)
      restoredChannel.resumeRecoveryOutput()
      await restoredChannel.activateRecoveryInputs()
      expect(recoveredHost.attachments[0].inputs).toEqual([
        {
          type: 'signal',
          signal: 'SIGTERM',
          sequence: 1,
          writerLease: { epoch: 8, token: 'renewed-signal-lease' },
        },
      ])
      expect(
        (await Effect.runPromise(fixture.store.readTransport(channel.recoveryId!)))
          .allocatedInputSequence,
      ).toBe(1)
      await vi.waitFor(async () => {
        expect(
          (await Effect.runPromise(fixture.store.readTransport(channel.recoveryId!))).inputs[0]
            .written,
        ).toBe(true)
      })
    }))

  it.each([undefined, true])(
    'awaits actual native exit with confirmation %j after close admission and ACK',
    (nativeExitConfirmed) =>
      withStore(async (fixture) => {
        const host = new Host()
        const channel = await DurableRemoteChannel.open(
          host,
          'exec claude --input-format stream-json',
          { store: fixture.store, provider: 'claude' },
        )
        fixture.channels.add(channel)
        const details = { scope: 'root-and-children' }
        const semantic: NativeRecoveryInputSemantic = {
          kind: 'close',
          sessionId: 'claude-root',
          ownerGeneration: 3,
          requestType: 'stop',
          details,
        }
        let exited = false
        const stopping = channel.closeNativeAndWait(semantic, 1000).then((result) => {
          exited = result
          return result
        })
        details.scope = 'mutated'
        await vi.waitFor(() => expect(host.attachments[0].inputs).toHaveLength(1))
        expect(host.attachments[0].inputs[0]).toMatchObject({ type: 'close', sequence: 1 })
        host.attachments[0].frame({ type: 'ack', sequence: 1 })
        await nextTurn()
        expect(exited).toBe(false)
        expect(channel.transportState).toBe('connected')
        const admitted = await Effect.runPromise(fixture.store.readTransport(channel.recoveryId!))
        expect(admitted.inputs[0].semantic).toEqual({
          kind: 'close',
          sessionId: 'claude-root',
          ownerGeneration: 3,
          requestType: 'stop',
          details: { scope: 'root-and-children' },
        })
        await vi.waitFor(async () => {
          expect(
            (await Effect.runPromise(fixture.store.readTransport(channel.recoveryId!))).inputs[0]
              .written,
          ).toBe(true)
        })
        host.attachments[0].frame({
          type: 'exit',
          cursor: host.nextOutputCursor,
          code: 0,
          signal: 'SIGTERM',
          ...(nativeExitConfirmed === undefined ? {} : { nativeExitConfirmed }),
        })
        expect(await stopping).toBe(true)
        expect(channel.transportState).toBe('closed')
      }),
  )

  it('finishes a recovered original close without allocating replacement terminal input', () =>
    withStore(async (fixture) => {
      const initial = await createSnapshot(fixture.store)
      const original = await Effect.runPromise(
        fixture.store.reserveInput(
          initial.transport.id,
          { type: 'close' },
          { kind: 'close', sessionId: 'original-root', ownerGeneration: 4, requestType: 'stop' },
        ),
      )
      const snapshot = await Effect.runPromise(fixture.store.readTransport(initial.transport.id))
      const host = new Host()
      const channel = await restored(fixture, host, snapshot, true)
      channel.resumeRecoveryOutput()
      await channel.waitForReplay()
      const stopping = channel.closeNativeAndWait(
        { kind: 'close', sessionId: 'must-not-replace', ownerGeneration: 99 },
        1000,
      )
      await channel.activateRecoveryInputs()
      expect(host.attachments[0].inputs).toHaveLength(1)
      expect(host.attachments[0].inputs[0]).toMatchObject(original.frame)
      host.attachments[0].frame({ type: 'ack', sequence: original.sequence })
      await vi.waitFor(async () => {
        expect(
          (await Effect.runPromise(fixture.store.readTransport(channel.recoveryId!))).inputs[0]
            .written,
        ).toBe(true)
      })
      host.attachments[0].frame({
        type: 'exit',
        cursor: host.nextOutputCursor,
        code: 0,
        signal: null,
      })
      expect(await stopping).toBe(true)
      const retained = await Effect.runPromise(fixture.store.readTransport(initial.transport.id))
      expect(retained.allocatedInputSequence).toBe(original.sequence)
      expect(retained.inputs).toHaveLength(1)
      expect(retained.inputs[0].semantic).toEqual(original.semantic)
    }))

  it('keeps an active child and unanswered native permission owned after unobserved cleanup', () =>
    withStore(async (fixture) => {
      const host = new Host()
      const channel = await DurableRemoteChannel.open(host, 'exec codex app-server', {
        store: fixture.store,
        provider: 'codex',
      })
      fixture.channels.add(channel)
      const root: NativeRecoveryOwner = {
        ownerId: 'root-owner',
        sessionId: 'root-session',
        generation: 1,
        kind: 'root',
        workspace: '/project',
        nativeThreadId: 'root-native',
        nativeTurnId: 'root-turn',
        state: 'active',
        stopRequested: true,
        input: {
          sessionId: 'root-session',
          provider: 'codex',
          prompt: ' exact root\r\n',
          mode: 'read-only',
          workspace: '/project',
        },
      }
      const child: NativeRecoveryOwner = {
        ownerId: 'child-owner',
        sessionId: 'child-session',
        generation: 1,
        kind: 'child',
        parentSessionId: root.sessionId,
        workspace: '/project',
        nativeThreadId: 'child-native',
        nativeTurnId: 'child-turn',
        state: 'active',
        input: {
          sessionId: 'child-session',
          provider: 'codex',
          prompt: ' exact child\n',
          mode: 'read-only',
          workspace: '/project',
        },
      }
      await channel.recordOwner(root)
      await channel.recordOwner(child)
      const approval = {
        id: 'native-child-approval',
        method: 'item/commandExecution/requestApproval',
        params: {
          threadId: child.nativeThreadId,
          turnId: child.nativeTurnId,
          command: 'exact child command',
        },
      }
      const pending = new Map<string, Wire>()
      const errors: Error[] = []
      let exits = 0
      new CodexRPC(channel as unknown as ClientChannel, (message) => {
        if (message.method === approval.method) pending.set(String(message.id), message)
      })
      channel.on('error', (error: Error) => errors.push(error))
      channel.on('exit', () => {
        exits++
        pending.clear()
      })
      host.attachments[0].frame({
        type: 'stdout',
        cursor: 1,
        data: Buffer.from(JSON.stringify(approval) + '\n').toString('base64'),
      })
      await vi.waitFor(() => expect(pending.get(approval.id)).toEqual(approval))
      await channel.signalNativeAndWait('TERM', {
        kind: 'interrupt',
        sessionId: root.sessionId,
        ownerGeneration: 1,
        requestType: 'stop',
      })
      const stopping = channel.closeNativeAndWait(
        { kind: 'close', sessionId: root.sessionId, ownerGeneration: 1, requestType: 'stop' },
        1000,
      )
      await vi.waitFor(() => expect(host.attachments[0].inputs).toHaveLength(2))
      host.attachments[0].frame({ type: 'ack', sequence: 2 })
      await vi.waitFor(async () => {
        expect(
          (await Effect.runPromise(fixture.store.readTransport(channel.recoveryId!))).inputs[1]
            .written,
        ).toBe(true)
      })
      const notice = {
        type: 'exit',
        cursor: host.nextOutputCursor,
        code: null,
        signal: 'SIGKILL',
        nativeExitConfirmed: false,
      }
      host.attachments[0].frame(notice)
      expect(await stopping).toBe(false)
      await vi.waitFor(() =>
        expect(
          errors.some(
            (error) => error instanceof NativeRecoveryError && error.reason === 'uncertain',
          ),
        ).toBe(true),
      )
      expect(exits).toBe(0)
      expect(pending.get(approval.id)).toEqual(approval)
      const retained = await Effect.runPromise(fixture.store.readTransport(channel.recoveryId!))
      expect(retained.outputs.at(-1)).toEqual(notice)
      expect(retained.outputCursor).toBe(notice.cursor)
      expect(retained.transport.owners).toEqual([root, child])
      expect(retained.inputs.map((input) => input.frame.type)).toEqual(['signal', 'close'])
      expect(host.commands).toHaveLength(1)
      await expect(
        channel.signalNativeAndWait('TERM', {
          kind: 'interrupt',
          sessionId: root.sessionId,
          ownerGeneration: 1,
        }),
      ).rejects.toMatchObject({ reason: 'uncertain' })
      expect(host.attachments[0].inputs).toHaveLength(2)
      const plan = planNativeStopRecovery({
        snapshot: retained,
        owner: root,
        root: {
          state: 'active',
          ownershipProven: true,
          nativeThreadId: root.nativeThreadId,
          nativeTurnId: root.nativeTurnId,
        },
        children: [
          {
            owner: child,
            state: 'active',
            ownershipProven: true,
            nativeThreadId: child.nativeThreadId,
            nativeTurnId: child.nativeTurnId,
          },
        ],
        approvals: [
          {
            requestId: 'local-child-request',
            nativeRequestId: approval.id,
            requestType: approval.method,
            owner: child,
            nativeThreadId: child.nativeThreadId,
            canDeny: true,
          },
        ],
        graphComplete: true,
      })
      expect(plan.status).toBe('unknown')
      expect(plan.actions).toEqual([])
    }))

  it('quarantines an unobserved terminal notice replayed after cold WAL reconstruction', () =>
    withStore(async (fixture) => {
      const initial = await createSnapshot(fixture.store)
      const root: NativeRecoveryOwner = {
        ownerId: 'cold-root-owner',
        sessionId: 'cold-root',
        generation: 3,
        kind: 'root',
        workspace: '/project',
        nativeThreadId: 'cold-root-native',
        nativeTurnId: 'cold-root-turn',
        state: 'active',
        stopRequested: true,
        input: {
          sessionId: 'cold-root',
          provider: 'codex',
          prompt: 'exact cold root',
          mode: 'read-only',
          workspace: '/project',
        },
      }
      const child: NativeRecoveryOwner = {
        ownerId: 'cold-child-owner',
        sessionId: 'cold-child',
        generation: 3,
        kind: 'child',
        parentSessionId: root.sessionId,
        workspace: '/project',
        nativeThreadId: 'cold-child-native',
        nativeTurnId: 'cold-child-turn',
        state: 'active',
        input: {
          sessionId: 'cold-child',
          provider: 'codex',
          prompt: 'exact cold child',
          mode: 'read-only',
          workspace: '/project',
        },
      }
      await Effect.runPromise(
        fixture.store.updateTransport(initial.transport.id, { owners: [root, child] }),
      )
      const approval = {
        id: 71,
        method: 'item/commandExecution/requestApproval',
        params: {
          threadId: child.nativeThreadId,
          turnId: child.nativeTurnId,
          command: 'unanswered command',
        },
      }
      await Effect.runPromise(
        fixture.store.appendOutputs(initial.transport.id, [
          {
            type: 'stdout',
            cursor: 1,
            data: Buffer.from(JSON.stringify(approval) + '\n').toString('base64'),
          },
        ]),
      )
      await Effect.runPromise(
        fixture.store.reserveInput(
          initial.transport.id,
          { type: 'close' },
          { kind: 'close', sessionId: root.sessionId, ownerGeneration: 3, requestType: 'stop' },
        ),
      )
      const snapshot = await Effect.runPromise(fixture.store.readTransport(initial.transport.id))
      const notice = {
        type: 'exit',
        cursor: 2,
        code: null,
        signal: 'SIGTERM',
        nativeExitConfirmed: false,
      }
      const host = new Host()
      host.readyOverrides = {
        cursor: 2,
        lastInputSequence: 1,
        terminal: true,
        writerLease: undefined,
      }
      host.afterReady = (attachment) => attachment.frame(notice)
      const channel = await restored(fixture, host, snapshot, true)
      const pending: Wire[] = []
      const errors: Error[] = []
      let exits = 0
      const rpc = new CodexRPC(channel as unknown as ClientChannel, (message) =>
        pending.push(message),
      )
      channel.on('error', (error: Error) => errors.push(error))
      channel.on('exit', () => {
        exits++
        pending.length = 0
      })
      for (const output of snapshot.outputs)
        if (output.type === 'stdout') rpc.replayOutput(Buffer.from(output.data, 'base64'))
      expect(pending).toEqual([approval])
      const stopping = channel.closeNativeAndWait(
        { kind: 'close', sessionId: root.sessionId, ownerGeneration: 3, requestType: 'stop' },
        1000,
      )
      const replay = expect(channel.waitForReplay()).rejects.toMatchObject({ reason: 'uncertain' })
      channel.resumeRecoveryOutput()
      expect(await stopping).toBe(false)
      await replay
      expect(exits).toBe(0)
      expect(pending).toEqual([approval])
      expect(
        errors.some(
          (error) => error instanceof NativeRecoveryError && error.reason === 'uncertain',
        ),
      ).toBe(true)
      const retained = await Effect.runPromise(fixture.store.readTransport(initial.transport.id))
      expect(retained.outputs.at(-1)).toEqual(notice)
      expect(retained.transport.owners).toEqual([root, child])
      expect(retained.allocatedInputSequence).toBe(1)
      expect(retained.inputs[0].acknowledged).toBe(true)
      expect(host.attachments[0].inputs).toEqual([])
      expect(brokerConfiguration(host.commands[0])).toMatchObject({
        id: snapshot.transport.brokerId,
        launch: false,
        cursor: 1,
        expectedProtocol: 2,
      })
      const plan = planNativeStopRecovery({
        snapshot: retained,
        owner: root,
        root: {
          state: 'active',
          ownershipProven: true,
          nativeThreadId: root.nativeThreadId,
          nativeTurnId: root.nativeTurnId,
        },
        children: [
          {
            owner: child,
            state: 'active',
            ownershipProven: true,
            nativeThreadId: child.nativeThreadId,
            nativeTurnId: child.nativeTurnId,
          },
        ],
        approvals: [],
        graphComplete: true,
      })
      expect(plan.status).toBe('unknown')
      expect(plan.actions).toEqual([])
    }))

  it.each(['false', 0, null])(
    'rejects malformed exit confirmation %j before terminal admission',
    (nativeExitConfirmed) =>
      withStore(async (fixture) => {
        const host = new Host()
        const channel = await DurableRemoteChannel.open(host, 'exec codex app-server', {
          store: fixture.store,
          provider: 'codex',
        })
        fixture.channels.add(channel)
        const errors: Error[] = []
        let exits = 0
        channel.on('error', (error: Error) => errors.push(error))
        channel.on('exit', () => {
          exits++
        })
        host.attachments[0].frame({
          type: 'exit',
          cursor: 1,
          code: 0,
          signal: null,
          nativeExitConfirmed,
        })
        await vi.waitFor(() => expect(errors).toHaveLength(1))
        expect(errors[0]).toMatchObject({ reason: 'invalid' })
        expect(exits).toBe(0)
        const retained = await Effect.runPromise(fixture.store.readTransport(channel.recoveryId!))
        expect(retained.outputs).toEqual([])
        expect(retained.transport.owners).toEqual([])
      }),
  )

  it('reports an unconfirmed close as false while retaining the owned terminal intent', () =>
    withStore(async (fixture) => {
      const host = new Host()
      const channel = await DurableRemoteChannel.open(host, 'exec codex app-server', {
        store: fixture.store,
        provider: 'codex',
      })
      fixture.channels.add(channel)
      const stopping = channel.closeNativeAndWait(
        { kind: 'close', sessionId: 'owned-root', ownerGeneration: 8 },
        1_000,
      )
      await vi.waitFor(() => expect(host.attachments[0].inputs).toHaveLength(1))
      host.attachments[0].frame({ type: 'ack', sequence: 1 })
      expect(await stopping).toBe(false)
      const retained = await Effect.runPromise(fixture.store.readTransport(channel.recoveryId!))
      expect(retained.closeInputSequence).toBe(1)
      expect(retained.inputs[0].semantic).toMatchObject({
        sessionId: 'owned-root',
        ownerGeneration: 8,
      })
      expect(retained.outputs).toEqual([
        { type: 'inputReceipt', cursor: 1, sequence: 1, status: 'written' },
      ])
      expect(host.attachments[0].inputs).toHaveLength(1)
    }))

  it.each(['signal', 'close'] as const)(
    'detaches a failed semantic %s admission without native termination',
    (control) =>
      withStore(async (fixture) => {
        const failure = new NativeRecoveryError({
          operation: 'control-wal',
          path: fixture.directory,
          reason: 'io',
          message: 'Injected control admission failure',
        })
        const failing: NativeRecoveryStoreHandle = {
          ...fixture.store,
          reserveInput: () => Effect.fail(failure),
        }
        const host = new Host()
        const channel = await DurableRemoteChannel.open(host, 'exec codex app-server', {
          store: failing,
          provider: 'codex',
        })
        fixture.channels.add(channel)
        const errors: Error[] = []
        channel.on('error', (error: Error) => errors.push(error))
        const stopping =
          control === 'signal'
            ? channel.signalNativeAndWait('TERM', {
                kind: 'interrupt',
                sessionId: 'owned-root',
                ownerGeneration: 2,
              })
            : channel.closeNativeAndWait(
                { kind: 'close', sessionId: 'owned-root', ownerGeneration: 2 },
                1000,
              )
        await expect(stopping).rejects.toBe(failure)
        expect(host.attachments[0].inputs).toEqual([])
        expect(channel.transportState).toBe('closed')
        expect(errors).toContain(failure)
        expect(
          (await Effect.runPromise(fixture.store.readTransport(channel.recoveryId!))).inputs,
        ).toEqual([])
      }),
  )

  it('detaches an active transport without generating end, signal or close input', () =>
    withStore(async (fixture) => {
      const snapshot = await createSnapshot(fixture.store)
      const host = new Host()
      const channel = await restored(fixture, host, snapshot)
      await channel.detach()
      expect(host.attachments[0].inputs).toEqual([])
      expect(host.attachments[0].closeCount).toBeGreaterThan(0)
      expect(host.listenerCount('state')).toBe(0)
      expect(host.listenerCount('disconnected')).toBe(0)
      const retained = await Effect.runPromise(fixture.store.readTransport(snapshot.transport.id))
      expect(retained.inputs).toEqual([])
      expect(retained.transport.id).toBe(snapshot.transport.id)
    }))
})

describe('broker native delivery receipts', () => {
  it('settles its own committed receipt behind unread stdout while public receipt publication remains ordered', () =>
    withStore(async (fixture) => {
      const gate = Deferred.makeUnsafe<void>()
      let admissions = 0
      const delayed: NativeRecoveryStoreHandle = {
        ...fixture.store,
        appendOutputs: (id, frames) =>
          Effect.gen(function* () {
            admissions += frames.length
            yield* Deferred.await(gate)
            return yield* fixture.store.appendOutputs(id, frames)
          }),
      }
      const host = new Host()
      host.automaticReceipts = false
      const channel = await DurableRemoteChannel.open(host, 'exec codex app-server', {
        store: delayed,
        provider: 'codex',
      })
      fixture.channels.add(channel)
      await channel.waitForReplay()
      const order: string[] = []
      const receipts: Frame[] = []
      channel.on('input-receipt', (receipt: Frame) => {
        receipts.push(receipt)
        order.push('receipt')
      })
      let delivered = false
      const delivery = channel
        .writeNativeAndWait(
          { id: 1, method: 'turn/start', params: { prompt: 'exact original' } },
          { kind: 'user-prompt', requestId: 1, method: 'turn/start' },
        )
        .then(() => {
          delivered = true
        })
      const bytes = Buffer.alloc(65536, 'x')
      const stdout = { type: 'stdout', cursor: 1, data: bytes.toString('base64') }
      const receipt = { type: 'inputReceipt', cursor: 2, sequence: 1, status: 'written' }
      try {
        await vi.waitFor(() => expect(host.attachments[0].inputs).toHaveLength(1))
        host.attachments[0].push(JSON.stringify(stdout) + '\n' + JSON.stringify(receipt) + '\n')
        await vi.waitFor(() => expect(admissions).toBe(2))
        expect(delivered).toBe(false)
        expect(order).toEqual([])
        expect(channel.readableLength).toBe(0)
        Deferred.doneUnsafe(gate, Effect.void)
        await delivery
        expect(delivered).toBe(true)
        expect(channel.readableLength).toBe(65536)
        expect(receipts).toEqual([])
        const committed = await Effect.runPromise(fixture.store.readTransport(channel.recoveryId!))
        expect(committed.inputs[0].written).toBe(true)
        expect(committed.inputs[0].deliveryReceipt).toEqual({ cursor: 2, status: 'written' })
        expect(committed.outputs).toEqual([stdout, receipt])
        const received: Buffer[] = []
        channel.on('data', (chunk: Buffer) => {
          received.push(chunk)
          order.push('stdout')
        })
        await vi.waitFor(() => expect(receipts).toEqual([receipt]))
        expect(Buffer.concat(received).equals(bytes)).toBe(true)
        expect(order).toEqual(['stdout', 'receipt'])
        expect(host.attachments[0].inputs).toHaveLength(1)
      } finally {
        Deferred.doneUnsafe(gate, Effect.void)
      }
    }))

  it('observes an orphan SDK reply before input activation so Core can release the exact accepted request', () =>
    withStore(async (fixture) => {
      const initial = await createSnapshot(fixture.store, { inputReceipts: 1 })
      const message = {
        id: 1,
        method: 'turn/start',
        params: { threadId: 'native-thread', prompt: 'exact original' },
      }
      const original = await Effect.runPromise(
        fixture.store.reserveInput(
          initial.transport.id,
          { type: 'write', data: Buffer.from(JSON.stringify(message) + '\n').toString('base64') },
          {
            kind: 'user-prompt',
            requestId: message.id,
            method: message.method,
            nativeThreadId: 'native-thread',
          },
        ),
      )
      await Effect.runPromise(
        fixture.store.acknowledgeInput(initial.transport.id, original.sequence),
      )
      const snapshot = await Effect.runPromise(fixture.store.readTransport(initial.transport.id))
      const host = new Host()
      host.automaticReceipts = false
      host.readyOverrides = { lastInputSequence: original.sequence }
      const channel = await restored(fixture, host, snapshot, true)
      let activated = false
      const orphaned: Wire[] = []
      const observations: boolean[] = []
      const failures: Error[] = []
      const rpc = new CodexRPC(
        channel as unknown as ClientChannel,
        () => {},
        (error) => failures.push(error),
        {
          nextRequestId: 2,
          onOrphanResponse: (response) => {
            orphaned.push(response)
            observations.push(!activated)
            if (response.id === message.id && !response.method && Object.hasOwn(response, 'result'))
              channel.confirmNativeInputProcessed(original.sequence)
          },
        },
      )
      channel.resumeRecoveryOutput()
      await channel.waitForReplay()
      expect(channel.hasUnconfirmedRecoveryInputs).toBe(true)
      expect(host.attachments[0].inputs).toEqual([])
      const response = { id: 1, result: { turn: { id: 'native-turn', status: 'inProgress' } } }
      const output = {
        type: 'stdout',
        cursor: 1,
        data: Buffer.from(JSON.stringify(response) + '\n').toString('base64'),
      }
      host.attachments[0].frame(output)
      await vi.waitFor(() => expect(orphaned).toEqual([response]))
      expect(observations).toEqual([true])
      expect(rpc.isReplaying).toBe(false)
      expect(rpc.receivedMessageSequence).toBe(1)
      expect(channel.hasUnconfirmedRecoveryInputs).toBe(false)
      expect(host.attachments[0].inputs).toEqual([])
      await channel.activateRecoveryInputs()
      activated = true
      const next = {
        id: 2,
        method: 'turn/start',
        params: { threadId: 'native-thread', prompt: 'exact next' },
      }
      channel.writeNative(next, {
        kind: 'user-prompt',
        requestId: next.id,
        method: next.method,
        nativeThreadId: 'native-thread',
      })
      await channel.flushRecovery()
      await vi.waitFor(() => expect(host.attachments[0].inputs).toHaveLength(1))
      expect(host.attachments[0].inputs[0]).toMatchObject({
        type: 'write',
        sequence: original.sequence + 1,
      })
      expect(Buffer.from(host.attachments[0].inputs[0].data as string, 'base64').toString()).toBe(
        JSON.stringify(next) + '\n',
      )
      const retained = await Effect.runPromise(fixture.store.readTransport(initial.transport.id))
      expect(retained.inputs[0].frame).toEqual(original.frame)
      expect(retained.inputs[0].acknowledged).toBe(true)
      expect(retained.inputs[0].written).toBe(false)
      expect(retained.inputs[0].deliveryReceipt).toBeUndefined()
      expect(retained.outputs).toEqual([output])
      expect(retained.allocatedInputSequence).toBe(original.sequence + 1)
      expect(failures).toEqual([])
    }))

  it.each([undefined, true])(
    'recovers a durably completed original close with exit confirmation %j without new input or duplicate exit callbacks',
    (nativeExitConfirmed) =>
      withStore(async (fixture) => {
        const initial = await createSnapshot(fixture.store, { inputReceipts: 1 })
        const original = await Effect.runPromise(
          fixture.store.reserveInput(
            initial.transport.id,
            { type: 'close' },
            { kind: 'close', sessionId: 'original-root', ownerGeneration: 5, requestType: 'stop' },
          ),
        )
        const receipt = {
          type: 'inputReceipt' as const,
          cursor: 1,
          sequence: original.sequence,
          status: 'written' as const,
        }
        const exit = {
          type: 'exit' as const,
          cursor: 2,
          code: 0,
          signal: 'SIGTERM',
          ...(nativeExitConfirmed === undefined ? {} : { nativeExitConfirmed }),
        }
        await Effect.runPromise(fixture.store.appendOutputs(initial.transport.id, [receipt, exit]))
        await Effect.runPromise(
          fixture.store.acknowledgeInput(initial.transport.id, original.sequence),
        )
        const snapshot = await Effect.runPromise(fixture.store.readTransport(initial.transport.id))
        const host = new Host()
        host.automaticReceipts = false
        host.readyOverrides = {
          terminal: true,
          writerLease: undefined,
          cursor: 2,
          lastInputSequence: original.sequence,
        }
        host.afterReady = (attachment) => attachment.frame(exit)
        const channel = await restored(fixture, host, snapshot, true)
        const exits: unknown[][] = []
        channel.on('exit', (...values: unknown[]) => exits.push(values))
        const stopping = channel.closeNativeAndWait(
          { kind: 'close', sessionId: 'must-not-replace-original', ownerGeneration: 99 },
          1000,
        )
        channel.resumeRecoveryOutput()
        expect(await stopping).toBe(true)
        await nextTurn()
        expect(exits).toEqual([])
        expect(host.attachments[0].inputs).toEqual([])
        expect(host.commands).toHaveLength(1)
        expect(brokerConfiguration(host.commands[0])).toMatchObject({ launch: false, cursor: 2 })
        const retained = await Effect.runPromise(fixture.store.readTransport(initial.transport.id))
        expect(retained.allocatedInputSequence).toBe(original.sequence)
        expect(retained.closeInputSequence).toBe(original.sequence)
        expect(retained.inputs).toHaveLength(1)
        expect(retained.inputs[0].frame).toEqual(original.frame)
        expect(retained.inputs[0].semantic).toEqual(original.semantic)
        expect(retained.inputs[0].written).toBe(true)
        expect(retained.outputs).toEqual([receipt, exit])
      }),
  )

  it('keeps a native envelope pending after ACK until its own written receipt is durable', () =>
    withStore(async (fixture) => {
      const snapshot = await createSnapshot(fixture.store)
      const host = new Host()
      host.automaticReceipts = false
      const channel = await restored(fixture, host, snapshot)
      channel.resumeRecoveryOutput()
      await channel.waitForReplay()
      const receipts: Frame[] = []
      const stdout: Buffer[] = []
      channel.on('input-receipt', (receipt: Frame) => receipts.push(receipt))
      channel.on('data', (bytes: Buffer) => stdout.push(bytes))
      let delivered = false
      const delivery = channel
        .writeNativeAndWait(
          {
            id: 'exact-turn-request',
            method: 'turn/start',
            params: { prompt: '  exact\r\n😀\u0000\n' },
          },
          { kind: 'user-prompt', sessionId: 'root', requestId: 'exact-turn-request' },
        )
        .then(() => {
          delivered = true
        })
      await vi.waitFor(() => expect(host.attachments[0].inputs).toHaveLength(1))
      host.attachments[0].frame({ type: 'ack', sequence: 1 })
      await vi.waitFor(async () => {
        expect(
          (await Effect.runPromise(fixture.store.readTransport(snapshot.transport.id))).inputs[0]
            .acknowledged,
        ).toBe(true)
      })
      await nextTurn()
      expect(delivered).toBe(false)
      expect(receipts).toEqual([])
      const accepted = await Effect.runPromise(fixture.store.readTransport(snapshot.transport.id))
      expect(accepted.inputs[0].written).toBe(false)
      expect(accepted.inputs[0].consumed).toBe(false)
      expect(accepted.inputs[0].deliveryReceipt).toBeUndefined()
      const receipt = host.receipt(host.attachments[0], 1)
      await delivery
      const written = await Effect.runPromise(fixture.store.readTransport(snapshot.transport.id))
      expect(written.transport.inputReceipts).toBe(1)
      expect(written.inputs[0].deliveryReceipt).toEqual({
        cursor: receipt.cursor,
        status: 'written',
      })
      expect(written.inputs[0].written).toBe(true)
      expect(receipts).toEqual([receipt])
      expect(stdout).toEqual([])
      expect(written.outputs).toEqual([receipt])
    }))

  it('accepts a written receipt before ACK without conflating the two durable facts', () =>
    withStore(async (fixture) => {
      const snapshot = await createSnapshot(fixture.store)
      const host = new Host()
      host.automaticReceipts = false
      const channel = await restored(fixture, host, snapshot)
      channel.resumeRecoveryOutput()
      await channel.waitForReplay()
      const delivery = channel.writeNativeAndWait(
        { id: 9, result: { decision: 'accept', exact: ['native', null] } },
        {
          kind: 'permission-response',
          permissionRequestId: 9,
          requestType: 'item/commandExecution/requestApproval',
        },
      )
      await vi.waitFor(() => expect(host.attachments[0].inputs).toHaveLength(1))
      const receipt = host.receipt(host.attachments[0], 1)
      await delivery
      const beforeAck = await Effect.runPromise(fixture.store.readTransport(snapshot.transport.id))
      expect(beforeAck.inputs[0].written).toBe(true)
      expect(beforeAck.inputs[0].acknowledged).toBe(false)
      expect(beforeAck.acknowledgedInputSequence).toBe(0)
      host.attachments[0].frame({ type: 'ack', sequence: 1 })
      await vi.waitFor(async () => {
        expect(
          (await Effect.runPromise(fixture.store.readTransport(snapshot.transport.id))).inputs[0]
            .acknowledged,
        ).toBe(true)
      })
      const afterAck = await Effect.runPromise(fixture.store.readTransport(snapshot.transport.id))
      expect(afterAck.outputs).toEqual([receipt])
      expect(afterAck.inputs[0].written).toBe(true)
      expect(host.attachments[0].inputs).toHaveLength(1)
    }))

  it('does not resolve or publish a receipt while its WAL commit is delayed', () =>
    withStore(async (fixture) => {
      const snapshot = await createSnapshot(fixture.store)
      const gate = Deferred.makeUnsafe<void>()
      let committing = false
      const delayed: NativeRecoveryStoreHandle = {
        ...fixture.store,
        appendOutputs: (id, frames) =>
          Effect.gen(function* () {
            if (frames.some((frame) => frame.type === 'inputReceipt')) {
              committing = true
              yield* Deferred.await(gate)
            }
            return yield* fixture.store.appendOutputs(id, frames)
          }),
      }
      const host = new Host()
      host.automaticReceipts = false
      const channel = await restored(fixture, host, snapshot, false, delayed)
      channel.resumeRecoveryOutput()
      await channel.waitForReplay()
      const receipts: Frame[] = []
      channel.on('input-receipt', (receipt: Frame) => receipts.push(receipt))
      let delivered = false
      const delivery = channel
        .writeNativeAndWait(
          { id: 'receipt-gate', method: 'turn/start', params: {} },
          { kind: 'user-prompt', requestId: 'receipt-gate' },
        )
        .then(() => {
          delivered = true
        })
      try {
        await vi.waitFor(() => expect(host.attachments[0].inputs).toHaveLength(1))
        const receipt = host.receipt(host.attachments[0], 1)
        await vi.waitFor(() => expect(committing).toBe(true))
        expect(delivered).toBe(false)
        expect(receipts).toEqual([])
        const pending = await Effect.runPromise(fixture.store.readTransport(snapshot.transport.id))
        expect(pending.outputs).toEqual([])
        expect(pending.inputs[0].written).toBe(false)
        Deferred.doneUnsafe(gate, Effect.void)
        await delivery
        expect(receipts).toEqual([receipt])
        expect(
          (await Effect.runPromise(fixture.store.readTransport(snapshot.transport.id))).outputs,
        ).toEqual([receipt])
      } finally {
        Deferred.doneUnsafe(gate, Effect.void)
      }
    }))

  it.each(['cancelled', 'uncertain'] as const)(
    'rejects its own %s receipt with a typed error and no automatic native termination',
    (status) =>
      withStore(async (fixture) => {
        const snapshot = await createSnapshot(fixture.store)
        const host = new Host()
        host.automaticReceipts = false
        const channel = await restored(fixture, host, snapshot)
        channel.resumeRecoveryOutput()
        await channel.waitForReplay()
        const errors: Error[] = []
        channel.on('error', (error: Error) => errors.push(error))
        const delivery = channel.writeNativeAndWait(
          { id: 'original-prompt', method: 'turn/start', params: { prompt: 'exact original' } },
          { kind: 'user-prompt', requestId: 'original-prompt' },
        )
        const rejected = expect(delivery).rejects.toMatchObject({
          _tag: 'NativeRecoveryError',
          operation: 'input-delivery',
          reason: 'uncertain',
        })
        await vi.waitFor(() => expect(host.attachments[0].inputs).toHaveLength(1))
        const receipt = host.receipt(host.attachments[0], 1, status)
        await rejected
        const retained = await Effect.runPromise(fixture.store.readTransport(snapshot.transport.id))
        expect(retained.outputs).toEqual([receipt])
        expect(retained.inputs[0].written).toBe(false)
        expect(retained.inputs[0].deliveryReceipt?.status).toBe(status)
        if (status === 'uncertain') {
          expect(channel.transportState).toBe('closed')
          expect(errors).toHaveLength(1)
        } else await channel.detach()
        expect(host.attachments[0].inputs.map((input) => input.type)).toEqual(['write'])
        expect(host.commands).toHaveLength(1)
      }),
  )

  it('detaches a failed receipt commit without treating ACK as native delivery', () =>
    withStore(async (fixture) => {
      const snapshot = await createSnapshot(fixture.store)
      const failure = new NativeRecoveryError({
        operation: 'receipt-wal',
        path: fixture.directory,
        reason: 'io',
        message: 'Injected receipt durability failure',
      })
      const failing: NativeRecoveryStoreHandle = {
        ...fixture.store,
        appendOutputs: (id, frames) =>
          frames.some((frame) => frame.type === 'inputReceipt')
            ? Effect.fail(failure)
            : fixture.store.appendOutputs(id, frames),
      }
      const host = new Host()
      host.automaticReceipts = false
      const channel = await restored(fixture, host, snapshot, false, failing)
      channel.resumeRecoveryOutput()
      await channel.waitForReplay()
      const errors: Error[] = []
      const receipts: Frame[] = []
      channel.on('error', (error: Error) => errors.push(error))
      channel.on('input-receipt', (receipt: Frame) => receipts.push(receipt))
      const delivery = channel.writeNativeAndWait({
        id: 'unchanged',
        method: 'turn/start',
        params: {},
      })
      const rejected = expect(delivery).rejects.toBe(failure)
      await vi.waitFor(() => expect(host.attachments[0].inputs).toHaveLength(1))
      host.attachments[0].frame({ type: 'ack', sequence: 1 })
      await vi.waitFor(async () => {
        expect(
          (await Effect.runPromise(fixture.store.readTransport(snapshot.transport.id))).inputs[0]
            .acknowledged,
        ).toBe(true)
      })
      host.receipt(host.attachments[0], 1)
      await rejected
      expect(receipts).toEqual([])
      expect(errors).toContain(failure)
      expect(channel.transportState).toBe('closed')
      const retained = await Effect.runPromise(fixture.store.readTransport(snapshot.transport.id))
      expect(retained.outputs).toEqual([])
      expect(retained.inputs[0].written).toBe(false)
      expect(host.attachments[0].inputs.map((input) => input.type)).toEqual(['write'])
    }))

  it('waits for the exact original signal receipt and retains its copied ownership metadata', () =>
    withStore(async (fixture) => {
      const snapshot = await createSnapshot(fixture.store)
      const host = new Host()
      host.automaticReceipts = false
      const channel = await restored(fixture, host, snapshot)
      channel.resumeRecoveryOutput()
      await channel.waitForReplay()
      const details = { target: 'original-root' }
      let delivered = false
      const delivery = channel
        .signalNativeAndWait('INT', {
          kind: 'interrupt',
          sessionId: 'root',
          ownerGeneration: 4,
          requestType: 'stop',
          details,
        })
        .then(() => {
          delivered = true
        })
      details.target = 'mutated'
      await vi.waitFor(() => expect(host.attachments[0].inputs).toHaveLength(1))
      expect(host.attachments[0].inputs[0]).toMatchObject({
        type: 'signal',
        signal: 'SIGINT',
        sequence: 1,
      })
      host.attachments[0].frame({ type: 'ack', sequence: 1 })
      await nextTurn()
      expect(delivered).toBe(false)
      host.receipt(host.attachments[0], 1)
      await delivery
      const retained = await Effect.runPromise(fixture.store.readTransport(snapshot.transport.id))
      expect(retained.inputs[0].frame).toEqual({ type: 'signal', signal: 'SIGINT', sequence: 1 })
      expect(retained.inputs[0].semantic).toEqual({
        kind: 'interrupt',
        sessionId: 'root',
        ownerGeneration: 4,
        requestType: 'stop',
        details: { target: 'original-root' },
      })
      expect(retained.inputs[0].written).toBe(true)
      expect(retained.allocatedInputSequence).toBe(1)
    }))

  it.each(['receipt-first', 'exit-first'] as const)(
    'requires both original close receipt and observed native exit with %s ordering',
    (order) =>
      withStore(async (fixture) => {
        const snapshot = await createSnapshot(fixture.store)
        const host = new Host()
        host.automaticReceipts = false
        const channel = await restored(fixture, host, snapshot)
        channel.resumeRecoveryOutput()
        await channel.waitForReplay()
        let stopped = false
        let failed: unknown
        const stopping = channel
          .closeNativeAndWait({ kind: 'close', sessionId: 'root', ownerGeneration: 2 }, 1000)
          .then(
            (result) => {
              stopped = result
              return result
            },
            (error: unknown) => {
              failed = error
              return false
            },
          )
        await vi.waitFor(() => expect(host.attachments[0].inputs).toHaveLength(1))
        host.attachments[0].frame({ type: 'ack', sequence: 1 })
        await nextTurn()
        expect(stopped).toBe(false)
        expect(failed).toBeUndefined()
        const exit = () =>
          host.attachments[0].frame({
            type: 'exit',
            cursor: host.nextOutputCursor,
            code: 0,
            signal: 'SIGTERM',
            nativeExitConfirmed: true,
          })
        if (order === 'receipt-first') {
          host.receipt(host.attachments[0], 1)
          await vi.waitFor(async () => {
            expect(
              (await Effect.runPromise(fixture.store.readTransport(snapshot.transport.id)))
                .inputs[0].written,
            ).toBe(true)
          })
        } else {
          exit()
          await vi.waitFor(async () => {
            expect(
              (
                await Effect.runPromise(fixture.store.readTransport(snapshot.transport.id))
              ).outputs.some((frame) => frame.type === 'exit'),
            ).toBe(true)
          })
        }
        await nextTurn()
        expect(stopped).toBe(false)
        expect(failed).toBeUndefined()
        expect(channel.transportState).toBe('connected')
        if (order === 'receipt-first') exit()
        else host.receipt(host.attachments[0], 1)
        expect(await stopping).toBe(true)
        expect(failed).toBeUndefined()
        const retained = await Effect.runPromise(fixture.store.readTransport(snapshot.transport.id))
        expect(retained.inputs).toHaveLength(1)
        expect(retained.inputs[0].frame).toEqual({ type: 'close', sequence: 1 })
        expect(retained.inputs[0].written).toBe(true)
        expect(retained.outputs.map((frame) => frame.type)).toEqual(
          order === 'receipt-first' ? ['inputReceipt', 'exit'] : ['exit', 'inputReceipt'],
        )
        expect(host.attachments[0].inputs).toHaveLength(1)
      }),
  )

  it('holds replay completion until a reconstructed receipt is durable and published', () =>
    withStore(async (fixture) => {
      const initial = await createSnapshot(fixture.store, { inputReceipts: 1 })
      await Effect.runPromise(
        fixture.store.reserveInput(
          initial.transport.id,
          { type: 'write', data: Buffer.from('original\n').toString('base64') },
          { kind: 'user-prompt' },
        ),
      )
      await Effect.runPromise(fixture.store.acknowledgeInput(initial.transport.id, 1))
      const snapshot = await Effect.runPromise(fixture.store.readTransport(initial.transport.id))
      const gate = Deferred.makeUnsafe<void>()
      let committing = false
      const delayed: NativeRecoveryStoreHandle = {
        ...fixture.store,
        appendOutputs: (id, frames) =>
          Effect.gen(function* () {
            committing = true
            yield* Deferred.await(gate)
            return yield* fixture.store.appendOutputs(id, frames)
          }),
      }
      const host = new Host()
      host.automaticReceipts = false
      host.readyOverrides = { cursor: 1, lastInputSequence: 1 }
      host.afterReady = (attachment) =>
        attachment.frame({ type: 'inputReceipt', cursor: 1, sequence: 1, status: 'written' })
      const channel = await restored(fixture, host, snapshot, true, delayed)
      const order: string[] = []
      channel.on('input-receipt', () => order.push('receipt'))
      channel.resumeRecoveryOutput()
      let replayed = false
      const replay = channel.waitForReplay().then(() => {
        replayed = true
        order.push('replayed')
      })
      try {
        await vi.waitFor(() => expect(committing).toBe(true))
        expect(replayed).toBe(false)
        expect(order).toEqual([])
        expect(host.attachments[0].inputs).toEqual([])
        Deferred.doneUnsafe(gate, Effect.void)
        await replay
        expect(order).toEqual(['receipt', 'replayed'])
        expect(
          (await Effect.runPromise(fixture.store.readTransport(snapshot.transport.id))).inputs[0]
            .written,
        ).toBe(true)
        await channel.activateRecoveryInputs()
        expect(host.attachments[0].inputs).toEqual([])
      } finally {
        Deferred.doneUnsafe(gate, Effect.void)
      }
    }))

  it('syncs negotiated capability before admitting its remote receipt suffix', () =>
    withStore(async (fixture) => {
      const initial = await createSnapshot(fixture.store)
      await Effect.runPromise(
        fixture.store.reserveInput(
          initial.transport.id,
          { type: 'write', data: 'Zg==' },
          { kind: 'transport' },
        ),
      )
      const snapshot = await Effect.runPromise(fixture.store.readTransport(initial.transport.id))
      const gate = Deferred.makeUnsafe<void>()
      let negotiating = false
      const delayed: NativeRecoveryStoreHandle = {
        ...fixture.store,
        updateTransport: (id, patch) =>
          Effect.gen(function* () {
            if (patch.inputReceipts === 1) {
              negotiating = true
              yield* Deferred.await(gate)
            }
            yield* fixture.store.updateTransport(id, patch)
          }),
      }
      const host = new Host()
      host.automaticReceipts = false
      host.readyOverrides = { cursor: 1, lastInputSequence: 1 }
      host.afterReady = (attachment) =>
        attachment.frame({ type: 'inputReceipt', cursor: 1, sequence: 1, status: 'written' })
      let candidate!: DurableRemoteChannel
      const receipts: Frame[] = []
      const opening = DurableRemoteChannel.open(
        host,
        snapshot.transport.launchCommand,
        (channel) => {
          candidate = channel
          fixture.channels.add(channel)
          channel.on('input-receipt', (receipt: Frame) => receipts.push(receipt))
        },
        { store: delayed, provider: 'codex', snapshot, deferRecoveryInputs: true },
      )
      try {
        await vi.waitFor(() => expect(negotiating).toBe(true))
        expect(candidate.nativeInputReceipts).toBe(false)
        const before = await Effect.runPromise(fixture.store.readTransport(snapshot.transport.id))
        expect(before.transport.inputReceipts).toBeUndefined()
        expect(before.outputs).toEqual([])
        expect(receipts).toEqual([])
        Deferred.doneUnsafe(gate, Effect.void)
        const channel = await opening
        expect(channel.nativeInputReceipts).toBe(true)
        channel.resumeRecoveryOutput()
        await channel.waitForReplay()
        expect(receipts).toHaveLength(1)
        const after = await Effect.runPromise(fixture.store.readTransport(snapshot.transport.id))
        expect(after.transport.inputReceipts).toBe(1)
        expect(after.inputs[0].written).toBe(true)
      } finally {
        Deferred.doneUnsafe(gate, Effect.void)
      }
    }))

  it('replays an old broker read-only without resending or allocating native mutations', () =>
    withStore(async (fixture) => {
      const initial = await createSnapshot(fixture.store)
      await Effect.runPromise(
        fixture.store.reserveInput(
          initial.transport.id,
          { type: 'write', data: Buffer.from('unresolved exact prompt\n').toString('base64') },
          { kind: 'user-prompt' },
        ),
      )
      const snapshot = await Effect.runPromise(fixture.store.readTransport(initial.transport.id))
      const host = new Host()
      host.automaticReceipts = false
      host.readyOverrides = { inputReceipts: undefined, cursor: 1 }
      host.afterReady = (attachment) =>
        attachment.frame({
          type: 'stdout',
          cursor: 1,
          data: Buffer.from('archival native output\n').toString('base64'),
        })
      const channel = await restored(fixture, host, snapshot, true)
      const received: Buffer[] = []
      channel.on('data', (bytes: Buffer) => received.push(bytes))
      channel.resumeRecoveryOutput()
      await channel.waitForReplay()
      expect(channel.nativeInputReceipts).toBe(false)
      expect(Buffer.concat(received).toString()).toBe('archival native output\n')
      await expect(channel.activateRecoveryInputs()).rejects.toMatchObject({
        reason: 'unsupported',
      })
      expect(() => channel.writeNative({ id: 'new', method: 'turn/start', params: {} })).toThrow(
        NativeRecoveryError,
      )
      await expect(
        channel.signalNativeAndWait('TERM', { kind: 'interrupt' }),
      ).rejects.toMatchObject({ reason: 'unsupported' })
      await expect(channel.closeNativeAndWait({ kind: 'close' }, 20)).rejects.toMatchObject({
        reason: 'unsupported',
      })
      const retained = await Effect.runPromise(fixture.store.readTransport(snapshot.transport.id))
      expect(retained.allocatedInputSequence).toBe(1)
      expect(retained.inputs[0].frame).toEqual(snapshot.inputs[0].frame)
      expect(retained.inputs[0].written).toBe(false)
      expect(host.attachments[0].inputs).toEqual([])
    }))

  it('rejects a downgrade from recorded receipt capability without replaying input', () =>
    withStore(async (fixture) => {
      const snapshot = await createSnapshot(fixture.store, { inputReceipts: 1 })
      const host = new Host()
      host.readyOverrides = { inputReceipts: undefined }
      await expect(restored(fixture, host, snapshot)).rejects.toMatchObject({
        reason: 'unsupported',
      })
      expect(host.attachments[0].inputs).toEqual([])
      expect(host.commands).toHaveLength(1)
      expect(
        (await Effect.runPromise(fixture.store.readTransport(snapshot.transport.id))).transport
          .inputReceipts,
      ).toBe(1)
    }))

  it.each([
    ['byte extras', { data: 'Zg==' }],
    ['boolean written alias', { written: true }],
    ['unsupported status', { status: 'accepted' }],
    ['unknown sequence', { sequence: 2 }],
  ])('rejects receipt %s before durable promotion or native parser publication', (_label, extra) =>
    withStore(async (fixture) => {
      const snapshot = await createSnapshot(fixture.store)
      const host = new Host()
      host.automaticReceipts = false
      const channel = await restored(fixture, host, snapshot)
      channel.resumeRecoveryOutput()
      await channel.waitForReplay()
      const errors: Error[] = []
      const receipts: Frame[] = []
      channel.on('error', (error: Error) => errors.push(error))
      channel.on('input-receipt', (receipt: Frame) => receipts.push(receipt))
      const delivery = channel.writeNativeAndWait({
        id: 'original',
        method: 'turn/start',
        params: {},
      })
      const rejected = expect(delivery).rejects.toBeInstanceOf(NativeRecoveryError)
      await vi.waitFor(() => expect(host.attachments[0].inputs).toHaveLength(1))
      host.receipt(host.attachments[0], 1, 'written', extra)
      await rejected
      expect(receipts).toEqual([])
      expect(errors).toHaveLength(1)
      const retained = await Effect.runPromise(fixture.store.readTransport(snapshot.transport.id))
      expect(retained.inputs[0].written).toBe(false)
      expect(retained.outputs).toEqual([])
      expect(host.attachments[0].inputs.map((input) => input.type)).toEqual(['write'])
    }),
  )

  it('rejects a waiter retired during reserve while retaining the exact newly committed WAL input', () =>
    withStore(async (fixture) => {
      const snapshot = await createSnapshot(fixture.store)
      const gate = Deferred.makeUnsafe<void>()
      let reserving = false
      const delayed: NativeRecoveryStoreHandle = {
        ...fixture.store,
        reserveInput: (id, frame, semantic) =>
          Effect.gen(function* () {
            reserving = true
            yield* Deferred.await(gate)
            return yield* fixture.store.reserveInput(id, frame, semantic)
          }),
      }
      const host = new Host()
      host.automaticReceipts = false
      const channel = await restored(fixture, host, snapshot, false, delayed)
      channel.resumeRecoveryOutput()
      await channel.waitForReplay()
      const errors: Error[] = []
      channel.on('error', (error: Error) => errors.push(error))
      const message = {
        id: 'exact-retired-input',
        method: 'turn/start',
        params: { prompt: ' exact\r\n' },
      }
      const semantic = { kind: 'user-prompt' as const, requestId: message.id, sessionId: 'root' }
      const delivery = channel.writeNativeAndWait(message, semantic)
      const rejected = expect(delivery).rejects.toMatchObject({
        _tag: 'NativeRecoveryError',
        reason: 'uncertain',
      })
      try {
        await vi.waitFor(() => expect(reserving).toBe(true))
        const notice = {
          type: 'exit',
          cursor: 1,
          code: null,
          signal: 'SIGKILL',
          nativeExitConfirmed: false,
        }
        host.attachments[0].frame(notice)
        await vi.waitFor(() => expect(errors).toHaveLength(1))
        expect(channel.transportState).toBe('closed')
        Deferred.doneUnsafe(gate, Effect.void)
        await rejected
        const retained = await Effect.runPromise(fixture.store.readTransport(snapshot.transport.id))
        expect(retained.inputs).toHaveLength(1)
        expect(retained.inputs[0].semantic).toEqual(semantic)
        expect(
          Buffer.from((retained.inputs[0].frame as { data: string }).data, 'base64').toString(),
        ).toBe(JSON.stringify(message) + '\n')
        expect(retained.inputs[0].written).toBe(false)
        expect(retained.outputs).toEqual([notice])
        expect(host.attachments[0].inputs).toEqual([])
        expect(host.commands).toHaveLength(1)
      } finally {
        Deferred.doneUnsafe(gate, Effect.void)
      }
    }))

  it('keeps a cold uncertain receipt immutable and quarantines contradictory written replay', () =>
    withStore(async (fixture) => {
      const initial = await createSnapshot(fixture.store, { inputReceipts: 1 })
      await Effect.runPromise(
        fixture.store.reserveInput(
          initial.transport.id,
          { type: 'write', data: 'Zg==' },
          { kind: 'user-prompt', requestId: 'original' },
        ),
      )
      const uncertain = {
        type: 'inputReceipt' as const,
        cursor: 1,
        sequence: 1,
        status: 'uncertain' as const,
      }
      await Effect.runPromise(fixture.store.appendOutputs(initial.transport.id, [uncertain]))
      const snapshot = await Effect.runPromise(fixture.store.readTransport(initial.transport.id))
      const host = new Host()
      host.automaticReceipts = false
      host.readyOverrides = { cursor: 2, lastInputSequence: 1 }
      host.afterReady = (attachment) =>
        attachment.frame({ type: 'inputReceipt', cursor: 2, sequence: 1, status: 'written' })
      const channel = await restored(fixture, host, snapshot, true)
      const errors: Error[] = []
      channel.on('error', (error: Error) => errors.push(error))
      expect(() =>
        channel.writeNative({ id: 'must-not-send', method: 'turn/start', params: {} }),
      ).toThrow(NativeRecoveryError)
      const rejected = expect(channel.waitForReplay()).rejects.toMatchObject({
        reason: 'uncertain',
      })
      channel.resumeRecoveryOutput()
      await rejected
      expect(errors).toHaveLength(1)
      const retained = await Effect.runPromise(fixture.store.readTransport(initial.transport.id))
      expect(retained.outputs).toEqual([uncertain])
      expect(retained.inputs[0].deliveryReceipt).toEqual({ cursor: 1, status: 'uncertain' })
      expect(retained.inputs[0].written).toBe(false)
      expect(retained.allocatedInputSequence).toBe(1)
      expect(host.attachments[0].inputs).toEqual([])
    }))

  it('keeps accepted input without a final receipt read-only until its exact original written receipt arrives', () =>
    withStore(async (fixture) => {
      const initial = await createSnapshot(fixture.store, { inputReceipts: 1 })
      const originalMessage = {
        id: 'accepted-original',
        method: 'turn/start',
        params: { prompt: '  exact original\r\n😀\u0000\n' },
      }
      const original = await Effect.runPromise(
        fixture.store.reserveInput(
          initial.transport.id,
          {
            type: 'write',
            data: Buffer.from(JSON.stringify(originalMessage) + '\n').toString('base64'),
          },
          { kind: 'user-prompt', requestId: originalMessage.id, sessionId: 'original-root' },
        ),
      )
      await Effect.runPromise(
        fixture.store.acknowledgeInput(initial.transport.id, original.sequence),
      )
      const snapshot = await Effect.runPromise(fixture.store.readTransport(initial.transport.id))
      const host = new Host()
      host.automaticReceipts = false
      host.readyOverrides = { cursor: 0, lastInputSequence: original.sequence }
      const channel = await restored(fixture, host, snapshot, true)
      channel.resumeRecoveryOutput()
      await channel.waitForReplay()
      expect(channel.nativeInputReceipts).toBe(true)
      await expect(channel.activateRecoveryInputs()).rejects.toMatchObject({ reason: 'uncertain' })
      expect(() =>
        channel.writeNative({ id: 'denied-new-prompt', method: 'turn/start', params: {} }),
      ).toThrow(NativeRecoveryError)
      await expect(
        channel.writeNativeAndWait({
          id: 'denied-waiting-prompt',
          method: 'turn/start',
          params: {},
        }),
      ).rejects.toMatchObject({ reason: 'uncertain' })
      await expect(
        channel.signalNativeAndWait('TERM', { kind: 'interrupt', sessionId: 'original-root' }),
      ).rejects.toMatchObject({ reason: 'uncertain' })
      await expect(
        channel.closeNativeAndWait({ kind: 'close', sessionId: 'original-root' }, 20),
      ).rejects.toMatchObject({ reason: 'uncertain' })
      expect(channel.transportState).toBe('connected')
      expect(host.attachments[0].inputs).toEqual([])
      const fenced = await Effect.runPromise(fixture.store.readTransport(initial.transport.id))
      expect(fenced.allocatedInputSequence).toBe(original.sequence)
      expect(fenced.inputs[0].acknowledged).toBe(true)
      expect(fenced.inputs[0].written).toBe(false)
      expect(fenced.inputs[0].deliveryReceipt).toBeUndefined()
      const receipt = host.receipt(host.attachments[0], original.sequence)
      await vi.waitFor(async () => {
        expect(
          (await Effect.runPromise(fixture.store.readTransport(initial.transport.id))).inputs[0]
            .written,
        ).toBe(true)
      })
      await channel.activateRecoveryInputs()
      const nextMessage = {
        id: 'new-after-receipt',
        method: 'turn/start',
        params: { prompt: 'exact next' },
      }
      channel.writeNative(nextMessage, {
        kind: 'user-prompt',
        requestId: nextMessage.id,
        sessionId: 'original-root',
      })
      await channel.flushRecovery()
      await vi.waitFor(() => expect(host.attachments[0].inputs).toHaveLength(1))
      const resumed = await Effect.runPromise(fixture.store.readTransport(initial.transport.id))
      expect(resumed.allocatedInputSequence).toBe(original.sequence + 1)
      expect(resumed.inputs).toHaveLength(2)
      expect(resumed.inputs[0].frame).toEqual(original.frame)
      expect(resumed.inputs[0].wire).toBe(original.wire)
      expect(resumed.inputs[0].semantic).toEqual(original.semantic)
      expect(resumed.inputs[0].deliveryReceipt).toEqual({
        cursor: receipt.cursor,
        status: 'written',
      })
      expect(host.attachments[0].inputs[0]).toMatchObject({
        type: 'write',
        sequence: original.sequence + 1,
      })
      expect(Buffer.from(host.attachments[0].inputs[0].data as string, 'base64').toString()).toBe(
        JSON.stringify(nextMessage) + '\n',
      )
      expect(host.commands).toHaveLength(1)
    }))

  it('does not retransmit either live native input when Core proves one before ACK or receipt', () =>
    withStore(async (fixture) => {
      const host = new Host()
      host.automaticReceipts = false
      const channel = await DurableRemoteChannel.open(host, 'exec codex app-server', {
        store: fixture.store,
        provider: 'codex',
      })
      fixture.channels.add(channel)
      await channel.waitForReplay()
      const first = { id: 1, method: 'turn/start', params: { prompt: 'exact first native input' } }
      const second = {
        id: 2,
        method: 'turn/start',
        params: { prompt: 'exact second native input' },
      }
      for (const message of [first, second])
        channel.writeNative(message, {
          kind: 'user-prompt',
          requestId: message.id,
          method: message.method,
        })
      await channel.flushRecovery()
      await vi.waitFor(() => expect(host.attachments[0].inputs).toHaveLength(2))
      expect(host.attachments[0].inputs.map((input) => input.sequence)).toEqual([1, 2])
      expect(
        host.attachments[0].inputs.map((input) =>
          Buffer.from(input.data as string, 'base64').toString(),
        ),
      ).toEqual([JSON.stringify(first) + '\n', JSON.stringify(second) + '\n'])
      channel.confirmNativeInputProcessed(1)
      await nextTurn()
      expect(host.attachments[0].inputs).toHaveLength(2)
      const proved = await Effect.runPromise(fixture.store.readTransport(channel.recoveryId!))
      expect(proved.allocatedInputSequence).toBe(2)
      expect(proved.acknowledgedInputSequence).toBe(0)
      for (const input of proved.inputs) {
        expect(input.acknowledged).toBe(false)
        expect(input.written).toBe(false)
        expect(input.deliveryReceipt).toBeUndefined()
      }
      expect(proved.outputs).toEqual([])
      host.attachments[0].frame({ type: 'ack', sequence: 2 })
      await vi.waitFor(async () => {
        expect(
          (await Effect.runPromise(fixture.store.readTransport(channel.recoveryId!)))
            .acknowledgedInputSequence,
        ).toBe(2)
      })
      host.disconnect()
      host.reconnect()
      await vi.waitFor(() => expect(host.attachments).toHaveLength(2))
      await vi.waitFor(() => expect(channel.transportState).toBe('connected'))
      await channel.waitForReplay()
      expect(channel.hasUnconfirmedRecoveryInputs).toBe(true)
      await expect(channel.activateRecoveryInputs()).rejects.toMatchObject({ reason: 'uncertain' })
      expect(host.attachments[1].inputs).toEqual([])
      channel.confirmNativeInputProcessed(2)
      expect(channel.hasUnconfirmedRecoveryInputs).toBe(false)
      await channel.activateRecoveryInputs()
      expect(host.attachments[0].inputs).toHaveLength(2)
      expect(host.attachments[1].inputs).toEqual([])
      const retained = await Effect.runPromise(fixture.store.readTransport(channel.recoveryId!))
      expect(retained.allocatedInputSequence).toBe(2)
      expect(retained.inputs.every((input) => input.acknowledged)).toBe(true)
      expect(
        retained.inputs.every((input) => !input.written && input.deliveryReceipt === undefined),
      ).toBe(true)
      expect(retained.outputs).toEqual([])
    }))

  it('releases one accepted original input only through exact Core processing proof without inventing broker evidence', () =>
    withStore(async (fixture) => {
      const initial = await createSnapshot(fixture.store, { inputReceipts: 1 })
      const message = { id: 1, method: 'turn/start', params: { prompt: 'exact original\r\n' } }
      const original = await Effect.runPromise(
        fixture.store.reserveInput(
          initial.transport.id,
          { type: 'write', data: Buffer.from(JSON.stringify(message) + '\n').toString('base64') },
          { kind: 'user-prompt', requestId: message.id, method: message.method },
        ),
      )
      await Effect.runPromise(
        fixture.store.acknowledgeInput(initial.transport.id, original.sequence),
      )
      const snapshot = await Effect.runPromise(fixture.store.readTransport(initial.transport.id))
      const host = new Host()
      host.automaticReceipts = false
      host.readyOverrides = { lastInputSequence: original.sequence }
      const channel = await restored(fixture, host, snapshot, true)
      channel.resumeRecoveryOutput()
      await channel.waitForReplay()
      expect(channel.hasUnconfirmedRecoveryInputs).toBe(true)
      expect(() => channel.confirmNativeInputProcessed(original.sequence + 1)).toThrow(
        NativeRecoveryError,
      )
      expect(channel.hasUnconfirmedRecoveryInputs).toBe(true)
      channel.confirmNativeInputProcessed(original.sequence)
      expect(channel.hasUnconfirmedRecoveryInputs).toBe(false)
      await channel.activateRecoveryInputs()
      const next = { id: 2, method: 'turn/start', params: { prompt: 'exact next' } }
      channel.writeNative(next, { kind: 'user-prompt', requestId: next.id, method: next.method })
      await channel.flushRecovery()
      await vi.waitFor(() => expect(host.attachments[0].inputs).toHaveLength(1))
      expect(host.attachments[0].inputs[0]).toMatchObject({
        type: 'write',
        sequence: original.sequence + 1,
      })
      const retained = await Effect.runPromise(fixture.store.readTransport(initial.transport.id))
      expect(retained.inputs).toHaveLength(2)
      expect(retained.inputs[0].frame).toEqual(original.frame)
      expect(retained.inputs[0].semantic).toEqual(original.semantic)
      expect(retained.inputs[0].acknowledged).toBe(true)
      expect(retained.inputs[0].written).toBe(false)
      expect(retained.inputs[0].consumed).toBe(false)
      expect(retained.inputs[0].deliveryReceipt).toBeUndefined()
      expect(retained.outputs).toEqual([])
    }))

  it('retains the recovery fence until Core proves both exact original accepted requests', () =>
    withStore(async (fixture) => {
      const initial = await createSnapshot(fixture.store, { inputReceipts: 1 })
      for (const requestId of [1, 2]) {
        const message = {
          id: requestId,
          method: 'turn/start',
          params: { prompt: `exact original ${requestId}` },
        }
        await Effect.runPromise(
          fixture.store.reserveInput(
            initial.transport.id,
            { type: 'write', data: Buffer.from(JSON.stringify(message) + '\n').toString('base64') },
            { kind: 'user-prompt', requestId, method: message.method },
          ),
        )
      }
      await Effect.runPromise(fixture.store.acknowledgeInput(initial.transport.id, 2))
      const snapshot = await Effect.runPromise(fixture.store.readTransport(initial.transport.id))
      const host = new Host()
      host.automaticReceipts = false
      host.readyOverrides = { lastInputSequence: 2 }
      const channel = await restored(fixture, host, snapshot, true)
      channel.resumeRecoveryOutput()
      await channel.waitForReplay()
      expect(channel.hasUnconfirmedRecoveryInputs).toBe(true)
      channel.confirmNativeInputProcessed(1)
      expect(channel.hasUnconfirmedRecoveryInputs).toBe(true)
      await expect(channel.activateRecoveryInputs()).rejects.toMatchObject({ reason: 'uncertain' })
      expect(host.attachments[0].inputs).toEqual([])
      channel.confirmNativeInputProcessed(2)
      expect(channel.hasUnconfirmedRecoveryInputs).toBe(false)
      await channel.activateRecoveryInputs()
      const next = { id: 3, method: 'turn/start', params: { prompt: 'third request' } }
      channel.writeNative(next, { kind: 'user-prompt', requestId: next.id, method: next.method })
      await channel.flushRecovery()
      await vi.waitFor(() => expect(host.attachments[0].inputs).toHaveLength(1))
      expect(host.attachments[0].inputs[0]).toMatchObject({ type: 'write', sequence: 3 })
      const retained = await Effect.runPromise(fixture.store.readTransport(initial.transport.id))
      expect(retained.allocatedInputSequence).toBe(3)
      for (const original of retained.inputs.slice(0, 2)) {
        expect(original.acknowledged).toBe(true)
        expect(original.written).toBe(false)
        expect(original.deliveryReceipt).toBeUndefined()
      }
      expect(retained.outputs).toEqual([])
    }))

  it('refuses Core processing proof for an initialized notification without a response-bearing request', () =>
    withStore(async (fixture) => {
      const initial = await createSnapshot(fixture.store, { inputReceipts: 1 })
      const original = await Effect.runPromise(
        fixture.store.reserveInput(
          initial.transport.id,
          {
            type: 'write',
            data: Buffer.from(JSON.stringify({ method: 'initialized' }) + '\n').toString('base64'),
          },
          { kind: 'initialize', method: 'initialized', requestType: 'initialized' },
        ),
      )
      await Effect.runPromise(
        fixture.store.acknowledgeInput(initial.transport.id, original.sequence),
      )
      const snapshot = await Effect.runPromise(fixture.store.readTransport(initial.transport.id))
      const host = new Host()
      host.automaticReceipts = false
      host.readyOverrides = { lastInputSequence: original.sequence }
      const channel = await restored(fixture, host, snapshot, true)
      channel.resumeRecoveryOutput()
      await channel.waitForReplay()
      expect(channel.hasUnconfirmedRecoveryInputs).toBe(true)
      expect(() => channel.confirmNativeInputProcessed(original.sequence)).toThrow(
        NativeRecoveryError,
      )
      expect(channel.hasUnconfirmedRecoveryInputs).toBe(true)
      await expect(channel.activateRecoveryInputs()).rejects.toMatchObject({ reason: 'uncertain' })
      const retained = await Effect.runPromise(fixture.store.readTransport(initial.transport.id))
      expect(retained.allocatedInputSequence).toBe(original.sequence)
      expect(retained.inputs[0].frame).toEqual(original.frame)
      expect(retained.inputs[0].written).toBe(false)
      expect(retained.inputs[0].deliveryReceipt).toBeUndefined()
      expect(host.attachments[0].inputs).toEqual([])
    }))

  it.each([
    [
      'mismatched semantic ID',
      { id: 1, method: 'turn/start', params: {} },
      { kind: 'user-prompt', requestId: 2, method: 'turn/start' },
    ],
    [
      'missing native ID',
      { method: 'turn/start', params: {} },
      { kind: 'user-prompt', requestId: 1, method: 'turn/start' },
    ],
    [
      'initialized wire with synthetic ID',
      { id: 1, method: 'initialized' },
      { kind: 'initialize', requestId: 1, method: 'initialize' },
    ],
    [
      'initialized metadata with synthetic ID',
      { id: 1, method: 'initialize', params: {} },
      { kind: 'initialize', requestId: 1, method: 'initialize', requestType: 'initialized' },
    ],
  ] as const)('keeps native processing proof for %s fenced', (_label, message, semantic) =>
    withStore(async (fixture) => {
      const initial = await createSnapshot(fixture.store, { inputReceipts: 1 })
      const original = await Effect.runPromise(
        fixture.store.reserveInput(
          initial.transport.id,
          { type: 'write', data: Buffer.from(JSON.stringify(message) + '\n').toString('base64') },
          semantic,
        ),
      )
      await Effect.runPromise(
        fixture.store.acknowledgeInput(initial.transport.id, original.sequence),
      )
      const snapshot = await Effect.runPromise(fixture.store.readTransport(initial.transport.id))
      const host = new Host()
      host.automaticReceipts = false
      host.readyOverrides = { lastInputSequence: original.sequence }
      const channel = await restored(fixture, host, snapshot, true)
      channel.resumeRecoveryOutput()
      await channel.waitForReplay()
      expect(() => channel.confirmNativeInputProcessed(original.sequence)).toThrow(
        NativeRecoveryError,
      )
      expect(channel.hasUnconfirmedRecoveryInputs).toBe(true)
      await expect(channel.activateRecoveryInputs()).rejects.toMatchObject({ reason: 'uncertain' })
      const retained = await Effect.runPromise(fixture.store.readTransport(initial.transport.id))
      expect(retained.inputs).toHaveLength(1)
      expect(retained.inputs[0].frame).toEqual(original.frame)
      expect(retained.inputs[0].semantic).toEqual(original.semantic)
      expect(retained.inputs[0].written).toBe(false)
      expect(retained.inputs[0].deliveryReceipt).toBeUndefined()
      expect(host.attachments[0].inputs).toEqual([])
    }),
  )

  it('rejects a second same-status receipt at a different cursor without replacing the original final receipt', () =>
    withStore(async (fixture) => {
      const initial = await createSnapshot(fixture.store, { inputReceipts: 1 })
      const original = await Effect.runPromise(
        fixture.store.reserveInput(
          initial.transport.id,
          { type: 'write', data: 'Zg==' },
          { kind: 'user-prompt', requestId: 'original' },
        ),
      )
      const receipt = {
        type: 'inputReceipt' as const,
        cursor: 1,
        sequence: original.sequence,
        status: 'written' as const,
      }
      await Effect.runPromise(fixture.store.appendOutputs(initial.transport.id, [receipt]))
      await Effect.runPromise(
        fixture.store.acknowledgeInput(initial.transport.id, original.sequence),
      )
      const snapshot = await Effect.runPromise(fixture.store.readTransport(initial.transport.id))
      const host = new Host()
      host.automaticReceipts = false
      host.readyOverrides = { cursor: 2, lastInputSequence: original.sequence }
      host.afterReady = (attachment) => attachment.frame({ ...receipt, cursor: 2 })
      const channel = await restored(fixture, host, snapshot, true)
      const errors: Error[] = []
      const promoted: Frame[] = []
      const stdout: Buffer[] = []
      channel.on('error', (error: Error) => errors.push(error))
      channel.on('input-receipt', (frame: Frame) => promoted.push(frame))
      const rejected = expect(channel.waitForReplay()).rejects.toMatchObject({
        reason: 'uncertain',
      })
      channel.on('data', (bytes: Buffer) => stdout.push(bytes))
      channel.resumeRecoveryOutput()
      await rejected
      expect(errors).toHaveLength(1)
      expect(promoted).toEqual([])
      expect(stdout).toEqual([])
      const retained = await Effect.runPromise(fixture.store.readTransport(initial.transport.id))
      expect(retained.outputs).toEqual([receipt])
      expect(retained.inputs[0].deliveryReceipt).toEqual({ cursor: 1, status: 'written' })
      expect(retained.inputs[0].written).toBe(true)
      expect(retained.allocatedInputSequence).toBe(original.sequence)
      expect(host.attachments[0].inputs).toEqual([])
    }))

  it('detaches blocked replay after durable flush without requiring the native parser to drain', () =>
    withStore(async (fixture) => {
      const snapshot = await createSnapshot(fixture.store)
      const host = new Host()
      const first = { type: 'stdout', cursor: 1, data: Buffer.alloc(65536, 'x').toString('base64') }
      const second = {
        type: 'stdout',
        cursor: 2,
        data: Buffer.from('held native suffix\n').toString('base64'),
      }
      host.readyOverrides = { cursor: 2 }
      host.afterReady = (attachment) => {
        attachment.frame(first)
        attachment.frame(second)
      }
      const channel = await restored(fixture, host, snapshot, true)
      channel.resumeRecoveryOutput()
      const replay = expect(channel.waitForReplay()).rejects.toBeInstanceOf(NativeRecoveryError)
      await vi.waitFor(async () => {
        expect(
          (await Effect.runPromise(fixture.store.readTransport(snapshot.transport.id)))
            .outputCursor,
        ).toBe(2)
      })
      expect(channel.readableLength).toBe(65536)
      await channel.detach()
      await replay
      expect(channel.transportState).toBe('closed')
      const retained = await Effect.runPromise(fixture.store.readTransport(snapshot.transport.id))
      expect(retained.outputs).toEqual([first, second])
      expect(host.attachments[0].inputs).toEqual([])
      expect(host.listenerCount('state')).toBe(0)
    }))
})
