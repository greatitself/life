import { Effect, Deferred } from 'effect'
import { describe, expect, it, vi } from 'vitest'
import type {
  AgentEvent,
  NativeRecoveryConsumer,
  NativeRecoveryHistoryReceipt,
} from '../src/shared/types'
import type { ConversationCheckpointAck } from '../src/shared/conversations'
import {
  NativeAgentRecovery,
  acceptedRecoveryCursor,
  maxNativeRequestId,
  replayRecoveryEvents,
  stampRecoveryEvent,
} from '../src/main/agent-native-recovery'
import type { NativeRecoveryStoreHandle } from '../src/main/native-recovery-store'
import {
  NativeRecoveryError,
  type NativeRecoveryEvent,
  type NativeRecoveryHistoryAck,
  type NativeRecoveryNumberedInput,
  type NativeRecoveryOwner,
  type NativeRecoverySnapshot,
  type NativeRecoveryStoredEvent,
} from '../src/main/native-recovery-types'

const owner = (overrides: Partial<NativeRecoveryOwner> = {}): NativeRecoveryOwner => ({
  ownerId: 'root',
  sessionId: 'session',
  generation: 1,
  localTurn: 3,
  snapshotToken: 'snapshot-native-1',
  kind: 'root',
  workspace: '/project',
  nativeThreadId: 'codex-thread',
  state: 'active',
  input: {
    sessionId: 'session',
    provider: 'codex',
    mode: 'read-only',
    prompt: 'Exact\r\nprompt 🌍\ud800',
    workspace: '/project',
  },
  ...overrides,
})
const snapshot = (overrides: Partial<NativeRecoverySnapshot> = {}): NativeRecoverySnapshot => ({
  transport: {
    id: 'transport',
    brokerId: 'broker',
    brokerRoot: '/broker',
    launchCommand: 'codex app-server',
    provider: 'codex',
    providerVersion: '0.162.1',
    nativeProtocol: 'codex-stdio',
    brokerProtocolVersion: 2,
    machine: { profileId: 'profile', host: 'host', username: 'user', port: 22 },
    controller: { id: 'controller', epoch: 1 },
    initialization: { status: 'complete' },
    owners: [owner()],
  },
  allocatedInputSequence: 0,
  acknowledgedInputSequence: 0,
  outputCursor: 5,
  eventRevision: 0,
  inputs: [],
  outputs: [],
  events: [],
  historyAcks: [],
  historyPrepares: [],
  records: [],
  ...overrides,
})
const consumer = (overrides: Partial<NativeRecoveryConsumer> = {}): NativeRecoveryConsumer => ({
  kind: 'studio',
  sessionId: 'session',
  profileId: 'profile',
  workspace: '/project',
  remoteId: 'codex-thread',
  ...overrides,
})
const privateAck = (
  overrides: Partial<NativeRecoveryHistoryAck> = {},
): NativeRecoveryHistoryAck => ({
  consumerId: 'studio:session',
  sessionId: 'session',
  snapshotId: 'private-committed-snapshot',
  durability: 'admitted-cache',
  snapshotToken: 'snapshot-native-1',
  ownerGeneration: 1,
  throughEventRevision: 1,
  ...overrides,
})
const storedEvent = (
  revision: number,
  overrides: Partial<NativeRecoveryStoredEvent> = {},
): NativeRecoveryStoredEvent => ({
  revision,
  eventId: `transport:wire:${revision}:0`,
  outputCursor: revision,
  emittedAtMs: 1000 + revision,
  event: {
    sessionId: 'session',
    type: 'text',
    text: `Exact ${revision} 🌍\ud800`,
    nativeRecovery: {
      transportId: 'transport',
      eventId: `transport:wire:${revision}:0`,
      ownerGeneration: 1,
      snapshotToken: 'snapshot-native-1',
      localTurn: 3,
    },
  },
  ...overrides,
})
const numbered = (
  sequence: number,
  data: string,
  overrides: Partial<NativeRecoveryNumberedInput['semantic']> = {},
): NativeRecoveryNumberedInput => ({
  sequence,
  frame: { type: 'write', data: Buffer.from(data).toString('base64'), sequence },
  wire:
    JSON.stringify({ type: 'write', data: Buffer.from(data).toString('base64'), sequence }) + '\n',
  semantic: { kind: 'transport', ...overrides },
})

function memoryStore(initial = snapshot(), gate?: Deferred.Deferred<void>) {
  let current = initial
  const batches: readonly NativeRecoveryEvent[][] = []
  const appendEvents = vi.fn(
    (
      id: string,
      originals: readonly NativeRecoveryEvent[],
    ): Effect.Effect<readonly NativeRecoveryStoredEvent[], NativeRecoveryError> =>
      Effect.gen(function* () {
        if (gate) yield* Deferred.await(gate)
        const stored = originals.map((event, index) => ({
          ...event,
          revision: current.eventRevision + index + 1,
        }))
        ;(batches as NativeRecoveryEvent[][]).push([...originals])
        current = {
          ...current,
          eventRevision: current.eventRevision + stored.length,
          events: [...current.events, ...stored],
        }
        return stored
      }),
  )
  const updateTransport = vi.fn((id: string, patch: Partial<NativeRecoverySnapshot['transport']>) =>
    Effect.sync(() => {
      current = { ...current, transport: { ...current.transport, ...patch } }
    }),
  )
  const acknowledgeHistory = vi.fn(
    (id: string, ack: NativeRecoverySnapshot['historyAcks'][number]) =>
      Effect.sync(() => {
        current = { ...current, historyAcks: [...current.historyAcks, ack] }
      }),
  )
  const prepareHistory = vi.fn(
    (id: string, prepare: NativeRecoverySnapshot['historyPrepares'][number]) =>
      Effect.sync(() => {
        current = { ...current, historyPrepares: [...current.historyPrepares, prepare] }
      }),
  )
  const store = {
    appendEvents,
    prepareHistory,
    updateTransport,
    acknowledgeHistory,
    readTransport: vi.fn(() => Effect.succeed(current)),
  } as unknown as NativeRecoveryStoreHandle
  return {
    store,
    appendEvents,
    batches,
    acknowledgeHistory,
    updateTransport,
    current: () => current,
  }
}

const run = <A>(effect: Effect.Effect<A, unknown>) => Effect.runPromise(effect)
const receipt = (
  overrides: Partial<NativeRecoveryHistoryReceipt> = {},
): NativeRecoveryHistoryReceipt => ({
  kind: 'studio',
  sessionId: 'session',
  transportId: 'transport',
  snapshotToken: 'snapshot-native-1',
  snapshotId: 'durable-renderer-snapshot',
  throughEventRevision: 1,
  durability: 'admitted-cache',
  ...overrides,
})

describe('native request allocation recovery', () => {
  it('retains exact client allocations independently of ACK, write evidence, and cancellation', () => {
    const input = numbered(1, '{"id":19,"method":"thread/start","params":{}}\n', {
      method: 'thread/start',
      requestId: 19,
    })
    const canceled = numbered(2, '{"id":27,"method":"turn/start","params":{}}\n', {
      method: 'turn/start',
      requestId: 27,
    })
    const state = snapshot({
      inputs: [
        { ...input, acknowledged: true, written: false, consumed: false },
        {
          ...canceled,
          acknowledged: false,
          written: false,
          consumed: false,
          cancellation: 'startup canceled',
        },
      ],
    })
    expect(maxNativeRequestId(state)).toBe(27)
    expect(state.inputs[0]).toMatchObject({ acknowledged: true, written: false, consumed: false })
    expect(state.inputs[0].deliveryReceipt).toBeUndefined()
    expect(state.inputs[1].frame).toEqual(canceled.frame)
  })

  it('uses older exact outbound RPC lines when semantic annotations are incomplete', () => {
    const state = snapshot({
      inputs: [
        {
          ...numbered(1, '{"id":4,"method":"initialize"}\n{"id":72,"method":"thread/resume"}\n'),
          acknowledged: false,
          written: false,
          consumed: false,
        },
      ],
    })
    expect(maxNativeRequestId(state)).toBe(72)
  })

  it('reconstructs request IDs across base64 byte frames and coalesced lines', () => {
    const state = snapshot({
      inputs: [
        {
          ...numbered(1, '{"id":7,"method":"initialize"}\n{"i'),
          acknowledged: true,
          written: false,
          consumed: false,
        },
        {
          ...numbered(2, 'd":91,"method":"turn/start","params":{"input":"🌍"}}\n'),
          acknowledged: false,
          written: false,
          consumed: false,
        },
      ],
    })
    expect(maxNativeRequestId(state)).toBe(91)
  })

  it('does not mix server permission response IDs with client request allocation', () => {
    const state = snapshot({
      inputs: [
        {
          ...numbered(1, '{"id":6,"method":"turn/start"}\n', {
            method: 'turn/start',
            requestId: 6,
          }),
          acknowledged: true,
          written: false,
          consumed: false,
        },
        {
          ...numbered(2, `{"id":${Number.MAX_SAFE_INTEGER},"result":{"decision":"accept"}}\n`, {
            kind: 'permission-response',
            requestId: Number.MAX_SAFE_INTEGER,
            permissionRequestId: Number.MAX_SAFE_INTEGER,
          }),
          acknowledged: false,
          written: false,
          consumed: false,
        },
      ],
    })
    expect(maxNativeRequestId(state)).toBe(6)
  })

  it('ignores string, fractional, negative, and nonrequest IDs', () => {
    const state = snapshot({
      inputs: [
        {
          ...numbered(
            1,
            'banner\n{"id":"88","method":"turn/start"}\n{"id":1.5,"method":"x"}\n{"id":-4,"method":"x"}\n{"id":99,"result":{}}\n',
          ),
          acknowledged: false,
          written: false,
          consumed: false,
        },
      ],
    })
    expect(maxNativeRequestId(state)).toBe(0)
  })
})

describe('native ledger replay ownership', () => {
  it('preserves original event generation, local turn, request binding, timestamp, and exact text', () => {
    const event = storedEvent(1, {
      event: { ...storedEvent(1).event, requestId: 'native-permission-original' },
    })
    const state = snapshot({
      transport: {
        ...snapshot().transport,
        owners: [owner({ generation: 2, localTurn: 4, snapshotToken: 'snapshot-native-2' })],
      },
      eventRevision: 1,
      events: [event],
      records: [{ kind: 'create', revision: 1, transport: snapshot().transport }],
    })
    const replay = replayRecoveryEvents(state, [consumer()])
    expect(replay).toHaveLength(1)
    expect(replay[0].nativeRecovery).toMatchObject({
      revision: 1,
      ownerGeneration: 1,
      localTurn: 3,
      snapshotToken: 'snapshot-native-1',
      emittedAt: 1001,
    })
    expect(replay[0].text).toBe(event.event.text)
    expect(replay[0].requestId).toBe('native-permission-original')
  })

  it.each([
    { profileId: 'other-machine' },
    { sessionId: 'imported-session' },
    { workspace: '/other-project' },
    { workspace: undefined },
    { remoteId: 'different-native-thread' },
  ])('refuses consumer scope mismatch %j', (mismatch) => {
    expect(
      replayRecoveryEvents(snapshot({ eventRevision: 1, events: [storedEvent(1)] }), [
        consumer(mismatch),
      ]),
    ).toEqual([])
  })

  it('admits a just-created consumer without a saved native ID when registry scope is exact', () => {
    expect(
      replayRecoveryEvents(snapshot({ eventRevision: 1, events: [storedEvent(1)] }), [
        consumer({ remoteId: undefined }),
      ]),
    ).toHaveLength(1)
  })

  it('suppresses only committed event cursors for the original native snapshot', () => {
    const state = snapshot({
      eventRevision: 2,
      events: [storedEvent(1), storedEvent(2)],
      historyAcks: [privateAck()],
    })
    const applied = {
      transport: { appliedRevision: 1, snapshotToken: 'snapshot-native-1', ownerGeneration: 1 },
    }
    expect(
      replayRecoveryEvents(state, [consumer({ applied })]).map(
        (event) => event.nativeRecovery!.revision,
      ),
    ).toEqual([2])
  })

  it('caps an archive claim to zero until the private ledger has its matching ACK', () => {
    const state = snapshot({ eventRevision: 2, events: [storedEvent(1), storedEvent(2)] })
    const input = consumer({
      applied: {
        transport: { appliedRevision: 2, snapshotToken: 'snapshot-native-1', ownerGeneration: 1 },
      },
    })
    expect(acceptedRecoveryCursor(state, input)).toMatchObject({ appliedRevision: 0 })
    expect(replayRecoveryEvents(state, [input])).toHaveLength(2)
  })

  it('caps a forged future archive claim to the exact private committed watermark', () => {
    const state = snapshot({
      eventRevision: 2,
      events: [storedEvent(1), storedEvent(2)],
      historyAcks: [privateAck()],
    })
    const input = consumer({
      applied: {
        transport: { appliedRevision: 999, snapshotToken: 'snapshot-native-1', ownerGeneration: 1 },
      },
    })
    expect(acceptedRecoveryCursor(state, input)).toMatchObject({ appliedRevision: 1 })
    expect(
      replayRecoveryEvents(state, [input]).map((event) => event.nativeRecovery!.revision),
    ).toEqual([2])
  })

  it('preserves prior-generation private ACKs from the retained journal', () => {
    const original = snapshot().transport
    const latest = {
      ...original,
      owners: [owner({ generation: 2, snapshotToken: 'snapshot-native-2', localTurn: 4 })],
    }
    const state = snapshot({
      transport: latest,
      eventRevision: 2,
      events: [storedEvent(1), storedEvent(2)],
      historyAcks: [
        privateAck({
          snapshotToken: 'snapshot-native-2',
          ownerGeneration: 2,
          throughEventRevision: 2,
        }),
      ],
      records: [
        { kind: 'create', revision: 1, transport: original },
        { kind: 'history-ack', revision: 2, ack: privateAck() },
        { kind: 'transport', revision: 3, patch: { owners: latest.owners } },
      ],
    })
    const input = consumer({
      applied: {
        transport: { appliedRevision: 1, snapshotToken: 'snapshot-native-1', ownerGeneration: 1 },
      },
    })
    expect(acceptedRecoveryCursor(state, input)).toMatchObject({
      appliedRevision: 1,
      ownerGeneration: 1,
    })
  })

  it('does not resend an older generation covered by a privately committed later session watermark', () => {
    const previous = snapshot().transport
    const latest = {
      ...previous,
      owners: [owner({ generation: 2, snapshotToken: 'snapshot-native-2', localTurn: 4 })],
    }
    const second = storedEvent(2, {
      event: {
        ...storedEvent(2).event,
        nativeRecovery: {
          transportId: 'transport',
          eventId: 'transport:wire:2:0',
          ownerGeneration: 2,
          snapshotToken: 'snapshot-native-2',
          localTurn: 4,
        },
      },
    })
    const state = snapshot({
      transport: latest,
      eventRevision: 2,
      events: [storedEvent(1), second],
      historyAcks: [
        privateAck({
          snapshotToken: 'snapshot-native-2',
          ownerGeneration: 2,
          throughEventRevision: 2,
        }),
      ],
      records: [
        { kind: 'create', revision: 1, transport: previous },
        { kind: 'transport', revision: 2, patch: { owners: latest.owners } },
      ],
    })
    const input = consumer({
      applied: {
        transport: { appliedRevision: 2, snapshotToken: 'snapshot-native-2', ownerGeneration: 2 },
      },
    })
    expect(replayRecoveryEvents(state, [input])).toEqual([])
  })

  it('does not use another consumer kind or token as private ACK authority', () => {
    const state = snapshot({
      eventRevision: 1,
      events: [storedEvent(1)],
      historyAcks: [
        privateAck({ consumerId: 'main:session', durability: 'native' }),
        privateAck({ snapshotToken: 'other-token' }),
      ],
    })
    const input = consumer({
      applied: {
        transport: { appliedRevision: 1, snapshotToken: 'snapshot-native-1', ownerGeneration: 1 },
      },
    })
    expect(acceptedRecoveryCursor(state, input)?.appliedRevision).toBe(0)
  })

  it.each([
    { appliedRevision: 999, snapshotToken: 'snapshot-native-1', ownerGeneration: 1 },
    { appliedRevision: 1, snapshotToken: 'copied-stale-token', ownerGeneration: 1 },
    { appliedRevision: 1, snapshotToken: 'snapshot-native-1', ownerGeneration: 2 },
    { appliedRevision: 1 },
  ])('replays when cursor does not prove the exact owner snapshot %j', (cursor) => {
    expect(
      replayRecoveryEvents(snapshot({ eventRevision: 1, events: [storedEvent(1)] }), [
        consumer({ applied: { transport: cursor } }),
      ]),
    ).toHaveLength(1)
  })
})

describe('durable native event coordinator', () => {
  it('rebuilds a missing Studio cache only from the current document’s exact delivered projection', () => {
    const state = snapshot({ eventRevision: 1, events: [storedEvent(1)] })
    const memory = memoryStore(state)
    const coordinator = new NativeAgentRecovery(memory.store, vi.fn())
    coordinator.seed(state)
    const cursor = { appliedRevision: 1, snapshotToken: 'snapshot-native-1', ownerGeneration: 1 }
    const claim = consumer({ applied: { transport: cursor } })
    expect(coordinator.acceptedCursor(state, claim)).toBeUndefined()
    const event = stampRecoveryEvent(storedEvent(1), 'transport')
    const rollback = coordinator.noteReplayDelivery(event)
    const admission = {
      sessionId: 'session',
      transportId: 'transport',
      ...cursor,
      deliveryToken: event.nativeRecovery!.deliveryToken!,
    }
    expect(coordinator.acceptedCursor(state, claim)).toBeUndefined()
    expect(
      coordinator.acceptedCursor(state, { ...claim, projectionAdmissions: [admission] }),
    ).toEqual(cursor)
    expect(
      coordinator.acceptedCursor(state, {
        ...claim,
        projectionAdmissions: [{ ...admission, deliveryToken: 'stale-document-token' }],
      }),
    ).toBeUndefined()
    expect(
      coordinator.acceptedCursor(state, {
        ...claim,
        cacheHash: 'b'.repeat(64),
        projectionAdmissions: [admission],
      }),
    ).toBeUndefined()
    rollback()
    expect(
      coordinator.acceptedCursor(state, { ...claim, projectionAdmissions: [admission] }),
    ).toBeUndefined()
  })

  it('never emits an event before its storage admission resolves', async () => {
    const gate = Deferred.makeUnsafe<void>()
    const memory = memoryStore(snapshot(), gate)
    const publish = vi.fn()
    const coordinator = new NativeAgentRecovery(memory.store, publish)
    coordinator.seed(snapshot())
    coordinator.beginWire('transport', 1, 5)
    coordinator.event(
      'transport',
      { sessionId: 'session', type: 'text', text: 'Exact\r\n🌍\ud800', agentName: undefined },
      owner(),
    )
    coordinator.endWire('transport')
    await vi.waitFor(() => expect(memory.appendEvents).toHaveBeenCalledOnce())
    expect(publish).not.toHaveBeenCalled()
    await run(Deferred.succeed(gate, undefined))
    await run(coordinator.flushEffect())
    expect(publish).toHaveBeenCalledOnce()
    expect(publish.mock.calls[0][0]).toMatchObject({
      text: 'Exact\r\n🌍\ud800',
      nativeRecovery: {
        revision: 1,
        eventId: 'transport:wire:1:0',
        ownerGeneration: 1,
        localTurn: 3,
      },
    })
    expect(memory.current().events[0].event).not.toHaveProperty('agentName')
  })

  it('groups adjacent same-transport events while retaining wire ordinals and event indexes', async () => {
    const memory = memoryStore()
    const publish = vi.fn()
    const coordinator = new NativeAgentRecovery(memory.store, publish)
    coordinator.seed(snapshot())
    coordinator.beginWire('transport', 1, 1)
    coordinator.event('transport', { sessionId: 'session', type: 'text', text: 'a' }, owner())
    coordinator.event('transport', { sessionId: 'session', type: 'reasoning', text: 'b' }, owner())
    coordinator.endWire('transport')
    coordinator.beginWire('transport', 2, 1)
    coordinator.event('transport', { sessionId: 'session', type: 'text', text: 'c' }, owner())
    coordinator.endWire('transport')
    await run(coordinator.flushEffect())
    expect(memory.batches).toHaveLength(1)
    expect(publish.mock.calls.map(([event]) => event.nativeRecovery.eventId)).toEqual([
      'transport:wire:1:0',
      'transport:wire:1:1',
      'transport:wire:2:0',
    ])
  })

  it('reuses seeded canonical events and persists a missing replay event without publishing it', async () => {
    const state = snapshot({ events: [storedEvent(1)], eventRevision: 1 })
    const memory = memoryStore(state)
    const publish = vi.fn()
    const coordinator = new NativeAgentRecovery(memory.store, publish)
    coordinator.seed(state)
    coordinator.beginWire('transport', 1, 1, true)
    const original = coordinator.event(
      'transport',
      { sessionId: 'session', type: 'text', text: storedEvent(1).event.text as string },
      owner(),
    )
    expect(original?.text).toBe(storedEvent(1).event.text)
    coordinator.endWire('transport')
    coordinator.beginWire('transport', 2, 2, true)
    coordinator.event('transport', { sessionId: 'session', type: 'complete' }, owner())
    coordinator.endWire('transport')
    await run(coordinator.flushEffect())
    expect(publish).not.toHaveBeenCalled()
    expect(memory.current().events).toHaveLength(2)
    expect(coordinator.originalEvent('transport', 1)?.nativeRecovery?.ownerGeneration).toBe(1)
  })

  it.each([
    { sessionId: 'foreign-session' },
    { type: 'reasoning' as const },
    { text: 'changed text' },
    { itemId: 'changed-item' },
    { requestId: 'changed-request' },
    { agentId: 'changed-agent' },
  ])('refuses replay identity collisions for structural native content %j', (change) => {
    const state = snapshot({ events: [storedEvent(1)], eventRevision: 1 })
    const coordinator = new NativeAgentRecovery(memoryStore(state).store, vi.fn())
    coordinator.seed(state)
    coordinator.beginWire('transport', 1, 1, true)
    expect(() =>
      coordinator.event(
        'transport',
        {
          sessionId: 'session',
          type: 'text',
          text: storedEvent(1).event.text as string,
          ...change,
        },
        owner(),
      ),
    ).toThrow('different content or ownership')
  })

  it.each([{ generation: 2 }, { snapshotToken: 'different-token' }, { localTurn: 4 }])(
    'refuses replay identity collisions for original owner metadata %j',
    (change) => {
      const state = snapshot({ events: [storedEvent(1)], eventRevision: 1 })
      const coordinator = new NativeAgentRecovery(memoryStore(state).store, vi.fn())
      coordinator.seed(state)
      coordinator.beginWire('transport', 1, 1, true)
      expect(() =>
        coordinator.event(
          'transport',
          { sessionId: 'session', type: 'text', text: storedEvent(1).event.text as string },
          owner(change),
        ),
      ).toThrow('different content or ownership')
    },
  )

  it('ignores only the local usage observation clock while retaining original metric identity', () => {
    const event = {
      sessionId: 'session',
      type: 'status',
      itemId: 'usage-native',
      details: {
        usageScope: 'session',
        usageObservedAt: 1,
        usageCallId: 'original-call',
        tokenUsage: { total: 8 },
      },
    } satisfies AgentEvent
    const original = storedEvent(1, {
      event: { ...event, nativeRecovery: storedEvent(1).event.nativeRecovery },
    })
    const state = snapshot({ events: [original], eventRevision: 1 })
    const coordinator = new NativeAgentRecovery(memoryStore(state).store, vi.fn())
    coordinator.seed(state)
    coordinator.beginWire('transport', 1, 1, true)
    const accepted = coordinator.event(
      'transport',
      {
        ...event,
        details: {
          tokenUsage: { total: 8 },
          usageCallId: 'original-call',
          usageObservedAt: 500,
          usageScope: 'session',
        },
      },
      owner(),
    )
    expect(accepted?.details).toMatchObject({ usageObservedAt: 1 })
    coordinator.endWire('transport')
    coordinator.beginWire('transport', 1, 1, true)
    expect(() =>
      coordinator.event(
        'transport',
        {
          ...event,
          details: {
            usageScope: 'session',
            usageObservedAt: 500,
            usageCallId: 'different-call',
            tokenUsage: { total: 8 },
          },
        },
        owner(),
      ),
    ).toThrow('different content or ownership')
  })

  it('uses explicit input/exit identities for replay outside parsed JSON wires', async () => {
    const memory = memoryStore()
    const publish = vi.fn()
    const coordinator = new NativeAgentRecovery(memory.store, publish)
    coordinator.seed(snapshot())
    coordinator.event(
      'transport',
      { sessionId: 'session', type: 'request-resolved', requestId: 'native-request' },
      owner(),
      { eventId: 'transport:input:4:request-resolved', outputCursor: 3, replay: true },
    )
    coordinator.event(
      'transport',
      { sessionId: 'session', type: 'error', text: 'Exited' },
      owner(),
      { eventId: 'transport:output:5:exit', outputCursor: 5, replay: true },
    )
    await run(coordinator.flushEffect())
    expect(memory.current().events.map((event) => event.eventId)).toEqual([
      'transport:input:4:request-resolved',
      'transport:output:5:exit',
    ])
    expect(publish).not.toHaveBeenCalled()
  })

  it('never reuses local event identities after a renderer/runtime restart', async () => {
    const memory = memoryStore()
    const first = new NativeAgentRecovery(memory.store, vi.fn())
    first.event('transport', { sessionId: 'session', type: 'status', status: 'suspended' }, owner())
    await run(first.flushEffect())
    const second = new NativeAgentRecovery(memory.store, vi.fn())
    second.seed(memory.current())
    second.event('transport', { sessionId: 'session', type: 'status', status: 'resumed' }, owner())
    await run(second.flushEffect())
    expect(new Set(memory.current().events.map((event) => event.eventId)).size).toBe(2)
  })

  it('deduplicates a queued explicit identity but rejects different live content', async () => {
    const memory = memoryStore()
    const publish = vi.fn()
    const coordinator = new NativeAgentRecovery(memory.store, publish)
    const context = { eventId: 'transport:input:1:request-resolved', outputCursor: 1 }
    const event: AgentEvent = {
      sessionId: 'session',
      type: 'request-resolved',
      requestId: 'native-request',
    }
    coordinator.event('transport', event, owner(), context)
    coordinator.event('transport', event, owner(), context)
    expect(() =>
      coordinator.event('transport', { ...event, requestId: 'another-request' }, owner(), context),
    ).toThrow('different content or ownership')
    await run(coordinator.flushEffect())
    expect(memory.current().events).toHaveLength(1)
    expect(publish).toHaveBeenCalledOnce()
    coordinator.event('transport', event, owner(), context)
    expect(publish).toHaveBeenCalledOnce()
  })

  it('replaces forged native ownership metadata with the admitted owner only', async () => {
    const memory = memoryStore()
    const coordinator = new NativeAgentRecovery(memory.store, vi.fn())
    coordinator.event(
      'transport',
      {
        sessionId: 'session',
        type: 'text',
        nativeRecovery: {
          transportId: 'foreign',
          revision: 99,
          eventId: 'forged',
          ownerGeneration: 900,
          snapshotToken: 'forged',
        },
      },
      owner(),
    )
    await run(coordinator.flushEffect())
    expect(memory.current().events[0].event.nativeRecovery).toMatchObject({
      transportId: 'transport',
      snapshotToken: 'snapshot-native-1',
      ownerGeneration: 1,
    })
  })

  it('rejects accessors without running them or admitting an event', () => {
    const memory = memoryStore()
    const coordinator = new NativeAgentRecovery(memory.store, vi.fn())
    const getter = vi.fn(() => 'secret')
    const event = Object.defineProperty({ sessionId: 'session', type: 'text' }, 'text', {
      get: getter,
      enumerable: true,
    }) as AgentEvent
    expect(() => coordinator.event('transport', event, owner())).toThrow(NativeRecoveryError)
    expect(getter).not.toHaveBeenCalled()
    expect(memory.appendEvents).not.toHaveBeenCalled()
  })

  it('surfaces durable failure, retains queued originals, and emits none', async () => {
    const memory = memoryStore()
    const failure = new NativeRecoveryError({
      operation: 'write',
      path: 'fixture',
      reason: 'io',
      message: 'disk unavailable',
    })
    memory.appendEvents.mockImplementation(() => Effect.fail(failure))
    const publish = vi.fn()
    const onFailure = vi.fn()
    const coordinator = new NativeAgentRecovery(memory.store, publish, onFailure)
    coordinator.event(
      'transport',
      { sessionId: 'session', type: 'text', text: 'retain this exact tail' },
      owner(),
    )
    await expect(run(coordinator.flushEffect())).rejects.toThrow('disk unavailable')
    await vi.waitFor(() => expect(onFailure).toHaveBeenCalledOnce())
    expect(onFailure.mock.calls[0][0]).toMatchObject({
      path: 'transport',
      reason: 'io',
      cause: failure,
    })
    expect(publish).not.toHaveBeenCalled()
    expect(() =>
      coordinator.event('transport', { sessionId: 'session', type: 'text', text: 'next' }, owner()),
    ).toThrow('disk unavailable')
  })

  it('retains every committed batch entry if renderer delivery fails midway', async () => {
    const memory = memoryStore()
    const publish = vi.fn(() => {
      throw new Error('renderer unavailable')
    })
    const coordinator = new NativeAgentRecovery(memory.store, publish)
    coordinator.beginWire('transport', 1, 1)
    coordinator.event('transport', { sessionId: 'session', type: 'text', text: 'first' }, owner())
    coordinator.event('transport', { sessionId: 'session', type: 'text', text: 'second' }, owner())
    coordinator.endWire('transport')
    await expect(run(coordinator.flushEffect())).rejects.toThrow(
      'original ledger entry was retained',
    )
    expect(memory.current().events).toHaveLength(2)
    expect(coordinator.originalEvent('transport', 1, 1)?.text).toBe('second')
  })

  it('preserves legacy emission when no durable store is installed and suppresses replay', () => {
    const publish = vi.fn()
    const coordinator = new NativeAgentRecovery(undefined, publish)
    coordinator.event('transport', { sessionId: 'session', type: 'text', text: 'legacy' })
    coordinator.event(
      'transport',
      { sessionId: 'session', type: 'text', text: 'replay' },
      undefined,
      { replay: true },
    )
    expect(publish).toHaveBeenCalledOnce()
  })

  it('journals an intentionally dropped delivery without granting cache preparation progress', async () => {
    const memory = memoryStore()
    const publish = vi.fn((_event: AgentEvent) => false)
    const coordinator = new NativeAgentRecovery(memory.store, publish)
    coordinator.event('transport', { sessionId: 'session', type: 'text', text: 'paused' }, owner())
    await run(coordinator.flushEffect())
    const native = publish.mock.calls[0][0].nativeRecovery!
    expect(memory.current().events).toHaveLength(1)
    expect(coordinator.failure).toBeUndefined()
    await expect(
      run(
        coordinator.prepareRecoveryCacheEffect({
          snapshotId: 'paused-cache',
          hash: 'a'.repeat(64),
          savedAt: 100,
          projectionAdmissions: [
            {
              sessionId: 'session',
              transportId: 'transport',
              appliedRevision: 1,
              snapshotToken: native.snapshotToken!,
              ownerGeneration: native.ownerGeneration!,
              deliveryToken: native.deliveryToken!,
            },
          ],
        }),
      ),
    ).rejects.toThrow('exceeds the actual delivered or hash-proven projection')
    expect(memory.current().historyPrepares).toEqual([])
  })

  it('retains committed event identity when an earlier asynchronous snapshot arrives late', async () => {
    const earlier = snapshot()
    const memory = memoryStore(earlier)
    const coordinator = new NativeAgentRecovery(memory.store, vi.fn())
    coordinator.seed(earlier)
    coordinator.beginWire('transport', 1, 1)
    coordinator.event(
      'transport',
      { sessionId: 'session', type: 'text', text: 'original' },
      owner(),
    )
    coordinator.endWire('transport')
    await run(coordinator.flushEffect())
    coordinator.seed(earlier)
    expect(coordinator.originalEvent('transport', 1, 0)?.text).toBe('original')
    coordinator.beginWire('transport', 1, 1, true)
    expect(() =>
      coordinator.event(
        'transport',
        {
          sessionId: 'session',
          type: 'text',
          text: 'wrong replay payload',
        },
        owner(),
      ),
    ).toThrow('different content or ownership')
    expect(memory.current().events).toHaveLength(1)
  })

  it('preserves the old document capability when a paused event is intentionally dropped', async () => {
    const memory = memoryStore()
    const events: AgentEvent[] = []
    const coordinator = new NativeAgentRecovery(memory.store, (event) => {
      events.push(event)
      return events.length === 1
    })
    coordinator.event('transport', { sessionId: 'session', type: 'text', text: 'applied' }, owner())
    await run(coordinator.flushEffect())
    const oldToken = events[0].nativeRecovery!.deliveryToken!
    coordinator.event('transport', { sessionId: 'session', type: 'text', text: 'paused' }, owner())
    await run(coordinator.flushEffect())
    expect(coordinator.getDeliveryToken('transport', owner())).toBe(oldToken)
    const admission = {
      sessionId: 'session',
      transportId: 'transport',
      appliedRevision: 1,
      snapshotToken: 'snapshot-native-1',
      ownerGeneration: 1,
      deliveryToken: oldToken,
    }
    await run(
      coordinator.prepareRecoveryCacheEffect({
        snapshotId: 'last-applied-cache',
        hash: 'b'.repeat(64),
        savedAt: 100,
        projectionAdmissions: [admission],
      }),
    )
    expect(memory.current().historyPrepares[0]).toMatchObject({ location: 'main-cache' })
    await expect(
      run(
        coordinator.prepareRecoveryCacheEffect({
          snapshotId: 'unapplied-cache',
          hash: 'c'.repeat(64),
          savedAt: 200,
          projectionAdmissions: [{ ...admission, appliedRevision: 2 }],
        }),
      ),
    ).rejects.toThrow('exceeds the actual delivered or hash-proven projection')
    expect(memory.current().historyPrepares).toHaveLength(1)
    expect(memory.current().historyAcks).toEqual([])
  })

  it('serializes owner updates so independent client state changes are not erased', async () => {
    const state = snapshot({
      transport: {
        ...snapshot().transport,
        owners: [owner(), owner({ ownerId: 'other-root', sessionId: 'other-session' })],
      },
    })
    const memory = memoryStore(state)
    const coordinator = new NativeAgentRecovery(memory.store, vi.fn())
    await Promise.all([
      run(
        coordinator.updateOwnerEffect('transport', owner({ clientRecovery: { exact: 'first' } })),
      ),
      run(
        coordinator.updateOwnerEffect(
          'transport',
          owner({
            ownerId: 'other-root',
            sessionId: 'other-session',
            clientRecovery: { exact: 'second' },
          }),
        ),
      ),
    ])
    expect(memory.current().transport.owners.map((value) => value.clientRecovery)).toEqual([
      { exact: 'first' },
      { exact: 'second' },
    ])
  })

  it('refuses late generation updates and same-generation snapshot replacement', async () => {
    const state = snapshot({
      transport: {
        ...snapshot().transport,
        owners: [owner({ generation: 2, snapshotToken: 'snapshot-native-2' })],
      },
    })
    const memory = memoryStore(state)
    const coordinator = new NativeAgentRecovery(memory.store, vi.fn())
    await expect(run(coordinator.updateOwnerEffect('transport', owner()))).rejects.toThrow(
      'generation backward',
    )
    await expect(
      run(
        coordinator.updateOwnerEffect(
          'transport',
          owner({ generation: 2, snapshotToken: 'replacement-token' }),
        ),
      ),
    ).rejects.toThrow('generation backward')
    expect(memory.updateTransport).not.toHaveBeenCalled()
    expect(memory.current().transport.owners[0].snapshotToken).toBe('snapshot-native-2')
  })
})

describe('native history receipt admission', () => {
  it('accepts an exact Studio consumer and a shared transport watermark without suppressing other roots', async () => {
    const state = snapshot({
      eventRevision: 2,
      historyPrepares: [
        {
          location: 'studio-cache',
          snapshotId: 'durable-renderer-snapshot',
          fileHash: 'a'.repeat(64),
          owners: [
            {
              consumerId: 'studio:session',
              sessionId: 'session',
              snapshotToken: 'snapshot-native-1',
              ownerGeneration: 1,
              throughEventRevision: 2,
              authority: 'native-delivery',
            },
          ],
        },
      ],
      events: [
        storedEvent(1, { event: { ...storedEvent(1).event, sessionId: 'other-root' } }),
        storedEvent(2),
      ],
    })
    const memory = memoryStore(state)
    const coordinator = new NativeAgentRecovery(memory.store, vi.fn())
    coordinator.seed(state)
    coordinator.noteReplayDelivery(stampRecoveryEvent(storedEvent(2), 'transport'))
    await run(
      coordinator.acknowledgeHistoryEffect(
        receipt({ throughEventRevision: 2, fileHash: 'a'.repeat(64) }),
        [consumer()],
      ),
    )
    expect(memory.acknowledgeHistory).toHaveBeenCalledWith(
      'transport',
      expect.objectContaining({
        consumerId: 'studio:session',
        sessionId: 'session',
        throughEventRevision: 2,
      }),
    )
  })

  it.each([
    { snapshotToken: 'stale-native-token' },
    { throughEventRevision: 100 },
    { snapshotId: '' },
    { sessionId: 'foreign-session' },
    { throughEventRevision: -1 },
  ])('rejects receipts that do not prove committed owner data %j', async (overrides) => {
    const memory = memoryStore(snapshot({ eventRevision: 1, events: [storedEvent(1)] }))
    const coordinator = new NativeAgentRecovery(memory.store, vi.fn())
    await expect(run(coordinator.acknowledgeEffect(receipt(overrides)))).rejects.toThrow(
      'exact committed native owner snapshot',
    )
    expect(memory.acknowledgeHistory).not.toHaveBeenCalled()
  })

  it('rejects a copied receipt from a consumer on another project', async () => {
    const memory = memoryStore(snapshot({ eventRevision: 1, events: [storedEvent(1)] }))
    const coordinator = new NativeAgentRecovery(memory.store, vi.fn())
    await expect(
      run(
        coordinator.acknowledgeHistoryEffect(receipt(), [
          consumer({ workspace: '/other-project' }),
        ]),
      ),
    ).rejects.toThrow('exact admitted native consumer')
    expect(memory.acknowledgeHistory).not.toHaveBeenCalled()
  })

  it('acknowledges a worker-issued prior-generation main snapshot after owner rotation', async () => {
    const previous = snapshot().transport
    const current = {
      ...previous,
      owners: [owner({ generation: 2, snapshotToken: 'snapshot-native-2' })],
    }
    const state = snapshot({
      transport: current,
      eventRevision: 2,
      events: [storedEvent(1), storedEvent(2)],
      records: [
        { kind: 'create', revision: 1, transport: previous },
        { kind: 'transport', revision: 2, patch: { owners: current.owners } },
      ],
    })
    const memory = memoryStore(state)
    const coordinator = new NativeAgentRecovery(memory.store, vi.fn())
    const ack: ConversationCheckpointAck = {
      savedAt: 123,
      nativeRecoveryHash: 'a'.repeat(64),
      nativeRecovery: {
        snapshotId: 'worker-attested-snapshot',
        owners: [
          {
            sessionId: 'session',
            provider: 'codex',
            profileId: 'profile',
            workspace: '/project',
            remoteId: 'codex-thread',
            nativeRecovery: {
              transport: {
                appliedRevision: 1,
                snapshotToken: 'snapshot-native-1',
                ownerGeneration: 1,
              },
            },
          },
        ],
      },
    }
    coordinator.seed(state)
    coordinator.noteReplayDelivery(stampRecoveryEvent(storedEvent(1), 'transport'))
    const proof = await run(
      coordinator.authorizeRecoveryReceiptEffect(
        {
          hash: ack.nativeRecoveryHash!,
          savedAt: ack.savedAt,
          receipt: ack.nativeRecovery!,
        },
        [
          {
            sessionId: 'session',
            transportId: 'transport',
            appliedRevision: 1,
            snapshotToken: 'snapshot-native-1',
            ownerGeneration: 1,
            deliveryToken: coordinator.getDeliveryToken('transport', owner())!,
          },
        ],
      ),
    )
    expect(proof).not.toBeNull()
    await run(coordinator.acknowledgeMainHistoryEffect(ack))
    expect(memory.acknowledgeHistory).toHaveBeenCalledWith(
      'transport',
      expect.objectContaining({
        consumerId: 'main:session',
        snapshotToken: 'snapshot-native-1',
        ownerGeneration: 1,
        throughEventRevision: 1,
        durability: 'native',
      }),
    )
  })

  it.each([
    { provider: 'claude' as const },
    { profileId: 'other-machine' },
    { workspace: '/other-project' },
    { remoteId: 'other-native-thread' },
  ])('rejects a worker receipt with wrong native ownership %j', async (scope) => {
    const memory = memoryStore(snapshot({ eventRevision: 1, events: [storedEvent(1)] }))
    const coordinator = new NativeAgentRecovery(memory.store, vi.fn())
    const ack: ConversationCheckpointAck = {
      savedAt: 123,
      nativeRecoveryHash: 'a'.repeat(64),
      nativeRecovery: {
        snapshotId: 'worker-attested-snapshot',
        owners: [
          {
            sessionId: 'session',
            provider: 'codex',
            profileId: 'profile',
            workspace: '/project',
            remoteId: 'codex-thread',
            ...scope,
            nativeRecovery: {
              transport: {
                appliedRevision: 1,
                snapshotToken: 'snapshot-native-1',
                ownerGeneration: 1,
              },
            },
          },
        ],
      },
    }
    await expect(run(coordinator.acknowledgeMainHistoryEffect(ack))).rejects.toThrow(
      'historically registered native owner',
    )
    expect(memory.acknowledgeHistory).not.toHaveBeenCalled()
  })
})
