import { createHash } from 'node:crypto'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Effect, Exit, Scope } from 'effect'
import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  NativeAgentRecovery,
  acceptedRecoveryCursor,
  replayRecoveryEvents,
  stampRecoveryEvent,
} from '../src/main/agent-native-recovery'
import { ConversationCheckpointEngine } from '../src/main/conversation-checkpoint-engine'
import {
  ConversationRecoverySidecarStore,
  type ConversationRecoveryProof,
} from '../src/main/conversation-recovery-sidecar'
import {
  NativeRecoveryStore,
  type NativeRecoveryStoreHandle,
} from '../src/main/native-recovery-store'
import type {
  NativeRecoveryOwner,
  NativeRecoveryTransport,
} from '../src/main/native-recovery-types'
import type {
  ConversationCheckpointAck,
  ConversationNativeRecoveryReceipt,
  ConversationProjectionAdmission,
} from '../src/shared/conversations'
import type { AgentEvent, NativeRecoveryConsumer } from '../src/shared/types'

const directories: string[] = []
const scopes: Scope.Closeable[] = []
afterEach(async () => {
  for (const scope of scopes.splice(0)) await Effect.runPromise(Scope.close(scope, Exit.void))
  for (const directory of directories.splice(0))
    await rm(directory, { recursive: true, force: true })
})

const run = <A>(effect: Effect.Effect<A, unknown>) => Effect.runPromise(effect)
const hash = (bytes: string | Buffer) => createHash('sha256').update(bytes).digest('hex')
const copy = <A>(value: A): A => JSON.parse(JSON.stringify(value)) as A
const transportId = 'original-native-transport'
const exact = '  Exact\r\nprovider output 🌍\ud800  '

function owner(sessionId = 'session-a'): NativeRecoveryOwner {
  return {
    ownerId: sessionId,
    sessionId,
    generation: 4,
    localTurn: 8,
    snapshotToken: `native-token-${sessionId}`,
    kind: 'root',
    workspace: '/project',
    writableRoot: '/project',
    nativeThreadId: `native-${sessionId}`,
    state: 'active',
    input: {
      sessionId,
      provider: 'codex',
      remoteId: `native-${sessionId}`,
      prompt: exact,
      mode: 'read-only',
      workspace: '/project',
    },
  }
}

function descriptor(): NativeRecoveryTransport {
  return {
    id: transportId,
    brokerId: 'original-broker',
    brokerRoot: '/home/fixture/.life/agent-sessions/original-broker',
    launchCommand: 'exec codex app-server',
    provider: 'codex',
    providerVersion: '0.162.1',
    nativeProtocol: 'codex-app-server-jsonrpc',
    brokerProtocolVersion: 2,
    machine: { profileId: 'profile', host: 'host', username: 'user', port: 22 },
    controller: { id: 'original-controller', epoch: 1 },
    initialization: { status: 'complete' },
    owners: [owner(), owner('session-b')],
  }
}

async function startStore(directory: string): Promise<NativeRecoveryStoreHandle> {
  const scope = await run(Scope.make())
  scopes.push(scope)
  return run(
    NativeRecoveryStore.make({ directory, outputBatchDelayMs: 1 }).pipe(Scope.provide(scope)),
  )
}

interface Fixture {
  directory: string
  ledgerDirectory: string
  historyDirectory: string
  store: NativeRecoveryStoreHandle
  coordinator: NativeAgentRecovery
  published: AgentEvent[]
  nextWire: number
}

async function fixture(publish?: (event: AgentEvent) => void): Promise<Fixture> {
  const directory = await mkdtemp(join(tmpdir(), 'life-native-history-proof-'))
  directories.push(directory)
  const ledgerDirectory = join(directory, 'ledger')
  const historyDirectory = join(directory, 'history')
  const store = await startStore(ledgerDirectory)
  const snapshot = await run(store.createTransport(descriptor()))
  const published: AgentEvent[] = []
  const coordinator = new NativeAgentRecovery(store, (event) => {
    publish?.(event)
    published.push(event)
  })
  coordinator.seed(snapshot)
  return {
    directory,
    ledgerDirectory,
    historyDirectory,
    store,
    coordinator,
    published,
    nextWire: 0,
  }
}

async function emit(fixture: Fixture, sessionId = 'session-a', replay = false) {
  const sequence = ++fixture.nextWire
  fixture.coordinator.beginWire(transportId, sequence, 0, replay)
  try {
    fixture.coordinator.event(
      transportId,
      { sessionId, type: 'text', itemId: `message-${sequence}`, text: `${exact}${sequence}` },
      owner(sessionId),
    )
  } finally {
    fixture.coordinator.endWire(transportId)
  }
  await run(fixture.coordinator.flushEffect())
  return (await run(fixture.store.readTransport(transportId))).events.at(-1)!
}

function claim(
  sessionId = 'session-a',
  appliedRevision = 1,
): ConversationNativeRecoveryReceipt['owners'][number] {
  return {
    sessionId,
    provider: 'codex',
    profileId: 'profile',
    workspace: '/project',
    remoteId: `native-${sessionId}`,
    nativeRecovery: {
      [transportId]: {
        appliedRevision,
        snapshotToken: `native-token-${sessionId}`,
        ownerGeneration: 4,
      },
    },
  }
}

function proof(
  owners = [claim()],
  savedAt = 100,
  snapshotId = 'writer-snapshot-100',
): ConversationRecoveryProof {
  return { hash: hash(`exact-history-${savedAt}`), savedAt, receipt: { snapshotId, owners } }
}

function checkpointAck(proof: ConversationRecoveryProof): ConversationCheckpointAck {
  return {
    savedAt: proof.savedAt,
    nativeRecovery: copy(proof.receipt),
    nativeRecoveryHash: proof.hash,
  }
}

function admissionFromEvent(
  event: AgentEvent,
  appliedRevision = event.nativeRecovery?.revision,
): ConversationProjectionAdmission {
  const native = event.nativeRecovery
  const deliveryToken: unknown =
    native && Object.getOwnPropertyDescriptor(native, 'deliveryToken')?.value
  if (!native?.snapshotToken || appliedRevision === undefined || typeof deliveryToken !== 'string')
    throw new Error('Projection admission requires an actual native-delivered event token')
  return {
    sessionId: event.sessionId,
    transportId: native.transportId,
    appliedRevision,
    snapshotToken: native.snapshotToken,
    ownerGeneration: native.ownerGeneration ?? 0,
    deliveryToken,
  }
}

function admission(fixture: Fixture, sessionId = 'session-a', appliedRevision = 1) {
  const event = fixture.published
    .slice()
    .reverse()
    .find((event) => event.sessionId === sessionId)
  if (!event) throw new Error('No event was delivered to this owner')
  return admissionFromEvent(event, appliedRevision)
}

function ownerAdmission(
  coordinator: NativeAgentRecovery,
  original = owner(),
  appliedRevision = 1,
): ConversationProjectionAdmission {
  const deliveryToken = coordinator.getDeliveryToken(transportId, original)
  if (!deliveryToken || !original.snapshotToken) throw new Error('Native owner reply has no token')
  return {
    sessionId: original.sessionId,
    transportId,
    appliedRevision,
    snapshotToken: original.snapshotToken,
    ownerGeneration: original.generation ?? 0,
    deliveryToken,
  }
}

function consumer(appliedRevision = 1, sessionId = 'session-a'): NativeRecoveryConsumer {
  return {
    kind: 'main',
    sessionId,
    profileId: 'profile',
    workspace: '/project',
    remoteId: `native-${sessionId}`,
    applied: {
      [transportId]: {
        appliedRevision,
        snapshotToken: `native-token-${sessionId}`,
        ownerGeneration: 4,
      },
    },
  }
}

function historyRow(appliedRevision = 1, sessionId = 'session-a') {
  const receipt = claim(sessionId, appliedRevision)
  return {
    id: sessionId,
    provider: receipt.provider,
    profileId: receipt.profileId,
    workspace: receipt.workspace,
    workspaceUnknown: false,
    remoteId: receipt.remoteId,
    nativeRecovery: receipt.nativeRecovery,
    messages: [
      { id: `user-${sessionId}`, role: 'user', text: exact },
      { id: `native-message-${sessionId}`, role: 'assistant', text: `${exact}1` },
    ],
    future: { opaque: [null, false, exact], duplicateNativeId: receipt.remoteId },
  }
}

async function reopen(fixture: Fixture) {
  await run(fixture.store.closeEffect())
  const store = await startStore(fixture.ledgerDirectory)
  const coordinator = new NativeAgentRecovery(store, vi.fn())
  coordinator.seed(await run(store.readTransport(transportId)))
  return { store, coordinator }
}

async function commitMainHistory(fixture: Fixture) {
  const engine = new ConversationCheckpointEngine(fixture.historyDirectory, {
    authorizeRecoveryReceipt: (candidate, admissions) =>
      fixture.coordinator.authorizeRecoveryReceiptEffect(candidate, admissions),
  })
  const ack = await run(engine.saveEffect([historyRow()], 100, [admission(fixture)]))
  await run(fixture.coordinator.acknowledgeMainHistoryEffect(ack))
  return (await run(engine.loadRecoveryReceiptEffect()))!
}

describe('private native history proof authority', () => {
  it('does not grant imported cursor claims authority from seed or transport eventRevision', async () => {
    const f = await fixture()
    await emit(f, 'session-a', true)
    const state = await run(f.store.readTransport(transportId))
    expect(state.eventRevision).toBe(1)
    const cold = new NativeAgentRecovery(f.store, vi.fn())
    cold.seed(state)
    await expect(run(cold.authorizeRecoveryReceiptEffect(proof()))).resolves.toBeNull()
    await expect(
      run(cold.authorizeRecoveryReceiptEffect(proof(), [ownerAdmission(cold)])),
    ).resolves.toBeNull()
    const after = await run(f.store.readTransport(transportId))
    expect(after.historyPrepares).toEqual([])
    expect(after.historyAcks).toEqual([])
    expect(replayRecoveryEvents(after, [consumer()])).toHaveLength(1)
    expect(acceptedRecoveryCursor(after, consumer())?.appliedRevision).toBe(0)
  })

  it('does not authorize copied cursor metadata after publication without a separate projection admission', async () => {
    const f = await fixture()
    await emit(f)
    const delivered = admission(f)
    expect(delivered.deliveryToken).toEqual(expect.any(String))
    await expect(run(f.coordinator.authorizeRecoveryReceiptEffect(proof()))).resolves.toBeNull()
    const state = await run(f.store.readTransport(transportId))
    expect(state.historyPrepares).toEqual([])
    expect(state.historyAcks).toEqual([])
    expect(replayRecoveryEvents(state, [consumer()])).toHaveLength(1)
  })

  it.each([
    {
      name: 'delivery token',
      mutate: (entry: ConversationProjectionAdmission) => {
        entry.deliveryToken = 'imported-stale-token'
      },
    },
    {
      name: 'native token',
      mutate: (entry: ConversationProjectionAdmission) => {
        entry.snapshotToken = 'copied-native-token'
      },
    },
    {
      name: 'generation',
      mutate: (entry: ConversationProjectionAdmission) => {
        entry.ownerGeneration = 5
      },
    },
    {
      name: 'revision',
      mutate: (entry: ConversationProjectionAdmission) => {
        entry.appliedRevision = 0
      },
    },
    {
      name: 'local owner',
      mutate: (entry: ConversationProjectionAdmission) => {
        entry.sessionId = 'session-b'
      },
    },
    {
      name: 'transport',
      mutate: (entry: ConversationProjectionAdmission) => {
        entry.transportId = 'copied-transport'
      },
    },
  ])('refuses a separate admission with mismatched $name', async ({ mutate }) => {
    const f = await fixture()
    await emit(f)
    const forged = copy(admission(f))
    mutate(forged)
    await expect(
      run(f.coordinator.authorizeRecoveryReceiptEffect(proof(), [forged])),
    ).resolves.toBeNull()
    expect((await run(f.store.readTransport(transportId))).historyPrepares).toEqual([])
  })

  it('revokes old delivery capabilities and progress until an original event is explicitly delivered again', async () => {
    const f = await fixture()
    const original = await emit(f)
    const previous = admission(f)
    f.coordinator.revokeDeliveryTokens()
    await expect(
      run(f.coordinator.authorizeRecoveryReceiptEffect(proof(), [previous])),
    ).resolves.toBeNull()
    const ownerReply = ownerAdmission(f.coordinator)
    expect(ownerReply.deliveryToken).not.toBe(previous.deliveryToken)
    await expect(
      run(f.coordinator.authorizeRecoveryReceiptEffect(proof(), [ownerReply])),
    ).resolves.toBeNull()
    const replay = stampRecoveryEvent(original, transportId)
    f.coordinator.noteReplayDelivery(replay)
    await expect(
      run(f.coordinator.authorizeRecoveryReceiptEffect(proof(), [previous])),
    ).resolves.toBeNull()
    await expect(
      run(f.coordinator.authorizeRecoveryReceiptEffect(proof(), [admissionFromEvent(replay)])),
    ).resolves.toEqual(proof())
    const state = await run(f.store.readTransport(transportId))
    expect(state.historyPrepares).toHaveLength(1)
    expect(state.events[0].event.nativeRecovery).not.toHaveProperty('deliveryToken')
  })

  it('admits only exact delivered owner claims and does not widen to an undelivered transport watermark', async () => {
    const f = await fixture()
    await emit(f)
    await emit(f, 'session-b', true)
    await emit(f, 'session-a', true)
    const candidate = proof([claim('session-a', 1), claim('session-b', 2)])
    const authorized = await run(
      f.coordinator.authorizeRecoveryReceiptEffect(candidate, [admission(f)]),
    )
    expect(authorized).toEqual({
      ...candidate,
      receipt: { ...candidate.receipt, owners: [claim('session-a', 1)] },
    })
    expect((await run(f.store.readTransport(transportId))).historyPrepares).toEqual([
      {
        snapshotId: candidate.receipt.snapshotId,
        fileHash: candidate.hash,
        location: 'native-file',
        owners: [
          {
            consumerId: 'main:session-a',
            sessionId: 'session-a',
            snapshotToken: 'native-token-session-a',
            ownerGeneration: 4,
            throughEventRevision: 1,
            authority: 'native-delivery',
          },
        ],
      },
    ])
    await expect(
      run(
        f.coordinator.authorizeRecoveryReceiptEffect(
          proof([claim('session-a', 3)], 200, 'undelivered-claim'),
          [admission(f, 'session-a', 3)],
        ),
      ),
    ).resolves.toBeNull()
    expect((await run(f.store.readTransport(transportId))).historyAcks).toEqual([])
  })

  it('admits explicit replay delivery only after the committed event reaches its consumer', async () => {
    const f = await fixture()
    const stored = await emit(f, 'session-a', true)
    expect(f.published).toEqual([])
    await expect(run(f.coordinator.authorizeRecoveryReceiptEffect(proof()))).resolves.toBeNull()
    const event = stampRecoveryEvent(stored, transportId)
    expect(event.nativeRecovery).not.toHaveProperty('deliveryToken')
    f.published.push(event)
    f.coordinator.noteReplayDelivery(event)
    expect(event.nativeRecovery).toHaveProperty('deliveryToken', expect.any(String))
    expect(stored.event.nativeRecovery).not.toHaveProperty('deliveryToken')
    const authorized = await run(
      f.coordinator.authorizeRecoveryReceiptEffect(proof(), [admissionFromEvent(event)]),
    )
    expect(authorized).toEqual(proof())
    expect((await run(f.store.readTransport(transportId))).historyPrepares).toHaveLength(1)
  })

  it('retains a delivered original transport claim while dropping a copied unowned transport from the same owner', async () => {
    const f = await fixture()
    await emit(f)
    const candidate = proof()
    candidate.receipt.owners[0].nativeRecovery['unowned-imported-transport'] = copy(
      candidate.receipt.owners[0].nativeRecovery[transportId],
    )
    const authorized = await run(
      f.coordinator.authorizeRecoveryReceiptEffect(candidate, [admission(f)]),
    )
    expect(authorized).toEqual(proof())
    const state = await run(f.store.readTransport(transportId))
    expect(state.historyPrepares).toHaveLength(1)
    expect(state.historyPrepares[0].owners).toMatchObject([
      { consumerId: 'main:session-a', throughEventRevision: 1, authority: 'native-delivery' },
    ])
    expect(state.historyAcks).toEqual([])
    expect(candidate.receipt.owners[0].nativeRecovery).toHaveProperty('unowned-imported-transport')
  })

  it('does not let a late delivered older-generation event authorize an unpublished newer owner cursor', async () => {
    const f = await fixture()
    const previous = owner()
    const current: NativeRecoveryOwner = {
      ...owner(),
      generation: 5,
      localTurn: 9,
      snapshotToken: 'native-newer-token',
    }
    await run(f.store.updateTransport(transportId, { owners: [current, owner('session-b')] }))
    f.coordinator.seed(await run(f.store.readTransport(transportId)))
    f.coordinator.beginWire(transportId, ++f.nextWire, 0, true)
    f.coordinator.event(
      transportId,
      { sessionId: 'session-a', type: 'text', text: 'Unpublished newer turn' },
      current,
    )
    f.coordinator.endWire(transportId)
    await run(f.coordinator.flushEffect())
    f.coordinator.beginWire(transportId, ++f.nextWire, 0)
    f.coordinator.event(
      transportId,
      { sessionId: 'session-a', type: 'text', text: 'Late original turn output' },
      previous,
    )
    f.coordinator.endWire(transportId)
    await run(f.coordinator.flushEffect())
    expect(f.published).toMatchObject([
      {
        text: 'Late original turn output',
        nativeRecovery: {
          ownerGeneration: 4,
          snapshotToken: 'native-token-session-a',
          revision: 2,
        },
      },
    ])
    const unpublished = proof()
    unpublished.receipt.owners[0].nativeRecovery[transportId] = {
      appliedRevision: 1,
      ownerGeneration: 5,
      snapshotToken: 'native-newer-token',
    }
    await expect(
      run(
        f.coordinator.authorizeRecoveryReceiptEffect(unpublished, [
          ownerAdmission(f.coordinator, current),
        ]),
      ),
    ).resolves.toBeNull()
    expect((await run(f.store.readTransport(transportId))).historyPrepares).toEqual([])
    const original = proof([claim('session-a', 2)], 200, 'late-original-generation')
    await expect(
      run(f.coordinator.authorizeRecoveryReceiptEffect(original, [admission(f, 'session-a', 2)])),
    ).resolves.toEqual(original)
  })

  it.each([
    {
      name: 'provider',
      mutate: (value: ConversationRecoveryProof) => {
        value.receipt.owners[0].provider = 'claude'
      },
    },
    {
      name: 'machine',
      mutate: (value: ConversationRecoveryProof) => {
        value.receipt.owners[0].profileId = 'other-profile'
      },
    },
    {
      name: 'workspace',
      mutate: (value: ConversationRecoveryProof) => {
        value.receipt.owners[0].workspace = '/other-project'
      },
    },
    {
      name: 'native conversation',
      mutate: (value: ConversationRecoveryProof) => {
        value.receipt.owners[0].remoteId = 'other-native-thread'
      },
    },
    {
      name: 'local owner',
      mutate: (value: ConversationRecoveryProof) => {
        value.receipt.owners[0].sessionId = 'other-session'
      },
    },
    {
      name: 'token',
      mutate: (value: ConversationRecoveryProof) => {
        value.receipt.owners[0].nativeRecovery[transportId].snapshotToken = 'copied-token'
      },
    },
    {
      name: 'generation',
      mutate: (value: ConversationRecoveryProof) => {
        value.receipt.owners[0].nativeRecovery[transportId].ownerGeneration = 5
      },
    },
    {
      name: 'uncommitted revision',
      mutate: (value: ConversationRecoveryProof) => {
        value.receipt.owners[0].nativeRecovery[transportId].appliedRevision = 2
      },
    },
  ])(
    'keeps an imported $name claim inert despite a genuine delivered event',
    async ({ mutate }) => {
      const f = await fixture()
      await emit(f)
      const forged = proof()
      mutate(forged)
      await expect(
        run(f.coordinator.authorizeRecoveryReceiptEffect(forged, [admission(f)])),
      ).resolves.toBeNull()
      expect((await run(f.store.readTransport(transportId))).historyPrepares).toEqual([])
    },
  )

  it('does not authorize a native ACK without a prepared exact file/owner claim', async () => {
    const f = await fixture()
    await emit(f)
    await expect(
      run(f.coordinator.acknowledgeMainHistoryEffect(checkpointAck(proof()))),
    ).rejects.toThrow()
    const state = await run(f.store.readTransport(transportId))
    expect(state.historyAcks).toEqual([])
    expect(replayRecoveryEvents(state, [consumer()])).toHaveLength(1)
  })

  it('treats repeated identical prepare and native ACK as idempotent journal operations', async () => {
    const f = await fixture()
    await emit(f)
    const candidate = proof()
    await run(f.coordinator.authorizeRecoveryReceiptEffect(candidate, [admission(f)]))
    const prepared = await run(f.store.readTransport(transportId))
    await run(f.coordinator.authorizeRecoveryReceiptEffect(candidate, [admission(f)]))
    expect((await run(f.store.readTransport(transportId))).records).toEqual(prepared.records)
    const ack = checkpointAck(candidate)
    await run(f.coordinator.acknowledgeMainHistoryEffect(ack))
    const committed = await run(f.store.readTransport(transportId))
    expect(committed.historyPrepares).toHaveLength(1)
    expect(committed.historyAcks).toEqual([
      expect.objectContaining({
        consumerId: 'main:session-a',
        snapshotId: candidate.receipt.snapshotId,
        fileHash: candidate.hash,
        snapshotToken: 'native-token-session-a',
        ownerGeneration: 4,
        throughEventRevision: 1,
        durability: 'native',
      }),
    ])
    await run(f.coordinator.acknowledgeMainHistoryEffect(ack))
    expect((await run(f.store.readTransport(transportId))).records).toEqual(committed.records)
  })

  it('admits the identical cold baseline without a token only after reconciling its actual hash-proven file', async () => {
    const f = await fixture()
    await emit(f)
    const engine = new ConversationCheckpointEngine(f.historyDirectory, {
      authorizeRecoveryReceipt: (candidate, admissions) =>
        f.coordinator.authorizeRecoveryReceiptEffect(candidate, admissions),
    })
    const ack = await run(engine.saveEffect([historyRow()], 100, [admission(f)]))
    await run(f.coordinator.acknowledgeMainHistoryEffect(ack))
    const cold = await reopen(f)
    const reader = new ConversationCheckpointEngine(f.historyDirectory)
    const loaded = (await run(reader.loadRecoveryReceiptEffect()))!
    const candidate = {
      ...loaded,
      receipt: { ...loaded.receipt, snapshotId: 'cold-reverified-worker-snapshot' },
    }
    const unreconciled = await run(cold.store.readTransport(transportId))
    const accepted = acceptedRecoveryCursor(unreconciled, consumer())
    expect(
      cold.coordinator.getAcceptedProjectionAdmission(unreconciled, consumer(), accepted),
    ).toBeUndefined()
    await expect(
      run(cold.coordinator.authorizeRecoveryReceiptEffect(candidate)),
    ).resolves.toBeNull()
    await expect(
      run(
        cold.coordinator.authorizeRecoveryReceiptEffect(candidate, [
          ownerAdmission(cold.coordinator),
        ]),
      ),
    ).resolves.toBeNull()
    await run(cold.coordinator.acknowledgeRecoveredHistoryProofEffect(loaded))
    const loadedAdmissions = await run(cold.coordinator.admitLoadedHistoryProofEffect(loaded))
    const reconciled = await run(cold.store.readTransport(transportId))
    expect(
      cold.coordinator.getAcceptedProjectionAdmission(
        reconciled,
        { ...consumer(), projectionAdmissions: loadedAdmissions },
        accepted,
      ),
    ).toMatchObject(ownerAdmission(cold.coordinator))
    await expect(run(cold.coordinator.authorizeRecoveryReceiptEffect(candidate))).resolves.toEqual(
      candidate,
    )
    const state = await run(cold.store.readTransport(transportId))
    expect(state.historyPrepares.at(-1)).toMatchObject({
      snapshotId: candidate.receipt.snapshotId,
      fileHash: candidate.hash,
      owners: [{ consumerId: 'main:session-a', throughEventRevision: 1, authority: 'private-ack' }],
    })
    expect(replayRecoveryEvents(state, [consumer()])).toEqual([])
    expect(state.historyAcks).toHaveLength(1)
    await expect(
      run(cold.coordinator.authorizeRecoveryReceiptEffect({ ...candidate, savedAt: 101 })),
    ).resolves.toBeNull()
    await expect(
      run(
        cold.coordinator.authorizeRecoveryReceiptEffect(
          proof([claim('session-a', 2)], 300, 'unearned-progress'),
        ),
      ),
    ).resolves.toBeNull()
    expect((await run(cold.store.readTransport(transportId))).historyAcks).toHaveLength(1)
  })

  it('requires a current separate admission and a loaded private baseline for a changed file hash after cold reopen', async () => {
    const f = await fixture()
    await emit(f)
    const engine = new ConversationCheckpointEngine(f.historyDirectory, {
      authorizeRecoveryReceipt: (candidate, admissions) =>
        f.coordinator.authorizeRecoveryReceiptEffect(candidate, admissions),
    })
    const originalRow = historyRow()
    const ack = await run(engine.saveEffect([originalRow], 100, [admission(f)]))
    await run(f.coordinator.acknowledgeMainHistoryEffect(ack))
    const cold = await reopen(f)
    const reader = new ConversationCheckpointEngine(f.historyDirectory)
    const loaded = (await run(reader.loadRecoveryReceiptEffect()))!
    const candidate = proof([claim()], 200, 'changed-file-after-reopen')
    const currentAdmission = ownerAdmission(cold.coordinator)
    await expect(
      run(cold.coordinator.authorizeRecoveryReceiptEffect(candidate, [currentAdmission])),
    ).resolves.toBeNull()
    await run(cold.coordinator.acknowledgeRecoveredHistoryProofEffect(loaded))
    await expect(
      run(cold.coordinator.authorizeRecoveryReceiptEffect(candidate)),
    ).resolves.toBeNull()
    cold.coordinator.revokeDeliveryTokens()
    await expect(
      run(cold.coordinator.authorizeRecoveryReceiptEffect(candidate, [currentAdmission])),
    ).resolves.toBeNull()
    const loadedAdmissions = await run(cold.coordinator.admitLoadedHistoryProofEffect(loaded))
    const reconciled = await run(cold.store.readTransport(transportId))
    const fresh = cold.coordinator.getAcceptedProjectionAdmission(
      reconciled,
      { ...consumer(), projectionAdmissions: loadedAdmissions },
      acceptedRecoveryCursor(reconciled, consumer()),
    )!
    expect(fresh.deliveryToken).not.toBe(currentAdmission.deliveryToken)
    const writer = new ConversationCheckpointEngine(f.historyDirectory, {
      authorizeRecoveryReceipt: (proposed, admissions) =>
        cold.coordinator.authorizeRecoveryReceiptEffect(proposed, admissions),
    })
    const changedRow = {
      ...originalRow,
      future: { ...originalRow.future, userEditedTitle: 'Local metadata edit' },
    }
    const changed = await run(writer.saveEffect([changedRow], 200, [fresh]))
    const bytes = await readFile(join(f.historyDirectory, 'conversations.json'))
    expect(changed.nativeRecoveryHash).toBe(hash(bytes))
    expect(changed.nativeRecoveryHash).not.toBe(loaded.hash)
    expect(JSON.parse(bytes.toString()).threads).toEqual([changedRow])
    const state = await run(cold.store.readTransport(transportId))
    expect(state.historyPrepares.at(-1)).toMatchObject({
      fileHash: hash(bytes),
      owners: [{ authority: 'private-ack', throughEventRevision: 1 }],
    })
    expect(state.historyAcks).toHaveLength(1)
    expect(bytes.toString()).not.toContain(fresh.deliveryToken)
  })

  it('does not combine a genuinely ACKed newer generation with a different loaded baseline hash and timestamp', async () => {
    const f = await fixture()
    await emit(f)
    const engine = new ConversationCheckpointEngine(f.historyDirectory, {
      authorizeRecoveryReceipt: (candidate, admissions) =>
        f.coordinator.authorizeRecoveryReceiptEffect(candidate, admissions),
    })
    const originalRow = historyRow()
    const original = await run(engine.saveEffect([originalRow], 100, [admission(f)]))
    const originalProof = (await run(engine.loadRecoveryReceiptEffect()))!
    await run(f.coordinator.acknowledgeMainHistoryEffect(original))
    const current: NativeRecoveryOwner = {
      ...owner(),
      generation: 5,
      localTurn: 9,
      snapshotToken: 'new-generation-token',
      input: { ...owner().input, localTurn: 9 },
    }
    await run(f.store.updateTransport(transportId, { owners: [current, owner('session-b')] }))
    f.coordinator.seed(await run(f.store.readTransport(transportId)))
    f.coordinator.beginWire(transportId, ++f.nextWire, 0)
    f.coordinator.event(
      transportId,
      { sessionId: 'session-a', type: 'text', itemId: 'new-message', text: `${exact}2` },
      current,
    )
    f.coordinator.endWire(transportId)
    await run(f.coordinator.flushEffect())
    const currentRow = {
      ...originalRow,
      messages: [
        ...originalRow.messages,
        { id: 'new-user-message', role: 'user', text: exact },
        { id: 'new-native-message', role: 'assistant', text: `${exact}2` },
      ],
      nativeRecovery: {
        [transportId]: {
          appliedRevision: 2,
          snapshotToken: 'new-generation-token',
          ownerGeneration: 5,
        },
      },
    }
    const changed = await run(engine.saveEffect([currentRow], 200, [admission(f, 'session-a', 2)]))
    const currentProof = (await run(engine.loadRecoveryReceiptEffect()))!
    await run(f.coordinator.acknowledgeMainHistoryEffect(changed))
    expect(currentProof.hash).not.toBe(originalProof.hash)
    const forged = {
      ...originalProof,
      receipt: { snapshotId: 'mixed-loaded-baselines', owners: copy(currentProof.receipt.owners) },
    }
    await expect(run(f.coordinator.authorizeRecoveryReceiptEffect(forged))).resolves.toBeNull()
    await expect(
      run(
        f.coordinator.authorizeRecoveryReceiptEffect({
          ...originalProof,
          receipt: { ...originalProof.receipt, snapshotId: 'exact-original-baseline' },
        }),
      ),
    ).resolves.toEqual({
      ...originalProof,
      receipt: { ...originalProof.receipt, snapshotId: 'exact-original-baseline' },
    })
    await expect(
      run(
        f.coordinator.authorizeRecoveryReceiptEffect({
          ...currentProof,
          receipt: { ...currentProof.receipt, snapshotId: 'exact-current-baseline' },
        }),
      ),
    ).resolves.toEqual({
      ...currentProof,
      receipt: { ...currentProof.receipt, snapshotId: 'exact-current-baseline' },
    })
  })
})

describe('committed conversation file proof recovery', () => {
  it('loads an exact legacy preparation without a location as native-file authority', async () => {
    const f = await fixture()
    await emit(f)
    const writer = new ConversationCheckpointEngine(f.historyDirectory)
    const row = historyRow()
    await run(writer.saveEffect([row], 100))
    const bytes = await readFile(join(f.historyDirectory, 'conversations.json'))
    const candidate = { ...proof(), hash: hash(bytes) }
    await run(
      f.store.prepareHistory(transportId, {
        snapshotId: candidate.receipt.snapshotId,
        fileHash: candidate.hash,
        owners: [
          {
            consumerId: 'main:session-a',
            sessionId: 'session-a',
            snapshotToken: 'native-token-session-a',
            ownerGeneration: 4,
            throughEventRevision: 1,
            authority: 'native-delivery',
          },
        ],
      }),
    )
    await run(
      new ConversationRecoverySidecarStore(
        join(f.historyDirectory, 'conversations.recovery-receipts.json'),
      ).stageEffect(candidate),
    )
    const cold = await reopen(f)
    const reader = new ConversationCheckpointEngine(f.historyDirectory)
    const loaded = (await run(reader.loadRecoveryReceiptEffect()))!
    const admissions = await run(cold.coordinator.admitLoadedHistoryProofEffect(loaded))
    const state = await run(cold.store.readTransport(transportId))
    expect(state.historyPrepares[0].location ?? 'native-file').toBe('native-file')
    expect(state.historyAcks).toEqual([
      expect.objectContaining({
        consumerId: 'main:session-a',
        fileHash: hash(bytes),
        durability: 'native',
      }),
    ])
    expect(
      cold.coordinator.acceptedCursor(state, { ...consumer(), projectionAdmissions: admissions })
        ?.appliedRevision,
    ).toBe(1)
    expect(
      cold.coordinator.replayEvents(state, [{ ...consumer(), projectionAdmissions: admissions }]),
    ).toEqual([])
    expect(await readFile(join(f.historyDirectory, 'conversations.json'))).toEqual(bytes)
  })

  it.each(['studio-cache', 'main-cache'] as const)(
    'does not promote an otherwise exact %s preparation into a native file proof with a valid actual hash',
    async (location) => {
      const f = await fixture()
      await emit(f)
      const writer = new ConversationCheckpointEngine(f.historyDirectory)
      const row = historyRow()
      await run(writer.saveEffect([row], 100))
      const bytes = await readFile(join(f.historyDirectory, 'conversations.json'))
      const candidate = { ...proof(), hash: hash(bytes) }
      await run(
        f.store.prepareHistory(transportId, {
          location,
          snapshotId: candidate.receipt.snapshotId,
          fileHash: candidate.hash,
          // Keep the native consumer tuple exact so only its storage location
          // distinguishes this cache preparation from a file preparation.
          owners: [
            {
              consumerId: 'main:session-a',
              sessionId: 'session-a',
              snapshotToken: 'native-token-session-a',
              ownerGeneration: 4,
              throughEventRevision: 1,
              authority: 'native-delivery',
            },
          ],
        }),
      )
      const sidecar = new ConversationRecoverySidecarStore(
        join(f.historyDirectory, 'conversations.recovery-receipts.json'),
      )
      await run(sidecar.stageEffect(candidate))
      const reader = new ConversationCheckpointEngine(f.historyDirectory)
      const loaded = (await run(reader.loadRecoveryReceiptEffect()))!
      expect(loaded).toEqual(candidate)
      expect(loaded.hash).toBe(hash(bytes))
      const before = await run(f.store.readTransport(transportId))
      expect(before.historyPrepares[0]).toMatchObject({ location, fileHash: loaded.hash })
      await expect(
        run(f.coordinator.acknowledgeMainHistoryEffect(checkpointAck(loaded))),
      ).rejects.toThrow()
      await expect(run(f.coordinator.admitLoadedHistoryProofEffect(loaded))).rejects.toThrow()
      await expect(
        run(f.coordinator.authorizeRecoveryReceiptEffect(loaded, [admission(f)])),
      ).rejects.toThrow()
      const after = await run(f.store.readTransport(transportId))
      expect(after.records).toEqual(before.records)
      expect(after.historyAcks).toEqual([])
      expect(await readFile(join(f.historyDirectory, 'conversations.json'))).toEqual(bytes)
      expect((await run(reader.loadEffect()))?.threads[0]).toEqual(row)
    },
  )

  it('keeps projection capabilities out of compact checkpoint history, sidecar, ledger, and ACK', async () => {
    const f = await fixture()
    await emit(f)
    const projection = admission(f)
    const authorize = vi.fn(
      (
        candidate: ConversationRecoveryProof,
        admissions: readonly ConversationProjectionAdmission[],
      ) => f.coordinator.authorizeRecoveryReceiptEffect(candidate, admissions),
    )
    const engine = new ConversationCheckpointEngine(f.historyDirectory, {
      authorizeRecoveryReceipt: authorize,
    })
    const row = historyRow()
    await run(engine.saveEffect([row], 100, [projection]))
    const ack = await run(
      engine.checkpointEffect({
        version: 1,
        baseSavedAt: 100,
        savedAt: 200,
        order: ['session-a'],
        upserts: [],
        projectionAdmissions: [projection],
      }),
    )
    expect(authorize.mock.calls.at(-1)?.[1]).toEqual([projection])
    await run(f.coordinator.acknowledgeMainHistoryEffect(ack))
    const history = await readFile(join(f.historyDirectory, 'conversations.json'), 'utf8')
    expect(JSON.parse(history)).toEqual({ version: 1, savedAt: 200, threads: [row] })
    expect(history).not.toContain(projection.deliveryToken)
    expect(
      await readFile(join(f.historyDirectory, 'conversations.recovery-receipts.json'), 'utf8'),
    ).not.toContain(projection.deliveryToken)
    expect(
      await readFile(join(f.ledgerDirectory, hash(transportId) + '.jsonl'), 'utf8'),
    ).not.toContain(projection.deliveryToken)
    expect(JSON.stringify(ack)).not.toContain(projection.deliveryToken)
    expect(ack.nativeRecoveryHash).toBe(hash(history))
  })

  it('recovers a write-before-ACK crash from the actual history hash and its prepared native ownership', async () => {
    const f = await fixture()
    await emit(f)
    const engine = new ConversationCheckpointEngine(f.historyDirectory, {
      authorizeRecoveryReceipt: (candidate, admissions) =>
        f.coordinator.authorizeRecoveryReceiptEffect(candidate, admissions),
    })
    const row = historyRow()
    const archived = {
      id: 'archived-session',
      profileId: 'profile',
      provider: 'codex',
      messages: [null, { opaque: [false, exact] }, 13],
      future: { exact, unavailableProviderState: null },
    }
    const ack = await run(engine.saveEffect([row, archived], 100, [admission(f)]))
    const bytes = await readFile(join(f.historyDirectory, 'conversations.json'))
    const token = admission(f).deliveryToken
    expect(bytes.toString()).not.toContain(token)
    expect(
      await readFile(join(f.historyDirectory, 'conversations.recovery-receipts.json'), 'utf8'),
    ).not.toContain(token)
    expect(
      await readFile(join(f.ledgerDirectory, hash(transportId) + '.jsonl'), 'utf8'),
    ).not.toContain(token)
    expect(JSON.parse(bytes.toString()).threads).toEqual([row, archived])
    expect(ack.nativeRecoveryHash).toBe(hash(bytes))
    expect((await run(f.store.readTransport(transportId))).historyAcks).toEqual([])
    const cold = await reopen(f)
    const reader = new ConversationCheckpointEngine(f.historyDirectory)
    const committed = await run(reader.loadRecoveryReceiptEffect())
    expect(committed).toEqual({ hash: hash(bytes), savedAt: 100, receipt: ack.nativeRecovery })
    const restored = await run(reader.loadEffect())
    expect(restored?.threads[0]).toEqual(row)
    expect(row.messages[1].text).toBe(f.published[0].text)
    await run(cold.coordinator.acknowledgeRecoveredHistoryProofEffect(committed!))
    const state = await run(cold.store.readTransport(transportId))
    expect(state.historyAcks).toEqual([
      expect.objectContaining({
        fileHash: hash(bytes),
        snapshotToken: 'native-token-session-a',
        ownerGeneration: 4,
        throughEventRevision: 1,
        durability: 'native',
      }),
    ])
    expect(replayRecoveryEvents(state, [consumer()])).toEqual([])
    expect(acceptedRecoveryCursor(state, consumer())?.appliedRevision).toBe(1)
  })

  it('refuses a stale sidecar after history bytes change and preserves the native replay tail', async () => {
    const f = await fixture()
    await emit(f)
    const engine = new ConversationCheckpointEngine(f.historyDirectory, {
      authorizeRecoveryReceipt: (candidate, admissions) =>
        f.coordinator.authorizeRecoveryReceiptEffect(candidate, admissions),
    })
    await run(engine.saveEffect([historyRow()], 100, [admission(f)]))
    const original = await run(engine.loadRecoveryReceiptEffect())
    const path = join(f.historyDirectory, 'conversations.json')
    const bytes = await readFile(path, 'utf8')
    await writeFile(path, bytes.replace('provider output', 'modified output'))
    const cold = await reopen(f)
    const reader = new ConversationCheckpointEngine(f.historyDirectory)
    await expect(run(reader.loadRecoveryReceiptEffect())).resolves.toBeNull()
    const forged = { ...original!, hash: hash(await readFile(path)) }
    await expect(
      run(cold.coordinator.acknowledgeRecoveredHistoryProofEffect(forged)),
    ).rejects.toThrow()
    const state = await run(cold.store.readTransport(transportId))
    expect(state.historyAcks).toEqual([])
    expect(replayRecoveryEvents(state, [consumer()])).toHaveLength(1)
  })

  it.each([
    {
      name: 'file hash',
      mutate: (value: ConversationRecoveryProof) => ({
        ...value,
        hash: hash('different-file-bytes'),
      }),
    },
    {
      name: 'snapshot ID',
      mutate: (value: ConversationRecoveryProof) => ({
        ...value,
        receipt: { ...value.receipt, snapshotId: 'different-worker-snapshot' },
      }),
    },
    {
      name: 'provider',
      mutate: (value: ConversationRecoveryProof) => {
        value.receipt.owners[0].provider = 'claude'
        return value
      },
    },
    {
      name: 'native conversation',
      mutate: (value: ConversationRecoveryProof) => {
        value.receipt.owners[0].remoteId = 'different-native-id'
        return value
      },
    },
    {
      name: 'local owner',
      mutate: (value: ConversationRecoveryProof) => {
        value.receipt.owners[0].sessionId = 'session-b'
        return value
      },
    },
    {
      name: 'native token',
      mutate: (value: ConversationRecoveryProof) => {
        value.receipt.owners[0].nativeRecovery[transportId].snapshotToken = 'copied-token'
        return value
      },
    },
    {
      name: 'generation',
      mutate: (value: ConversationRecoveryProof) => {
        value.receipt.owners[0].nativeRecovery[transportId].ownerGeneration = 3
        return value
      },
    },
    {
      name: 'prepared revision',
      mutate: (value: ConversationRecoveryProof) => {
        value.receipt.owners[0].nativeRecovery[transportId].appliedRevision = 0
        return value
      },
    },
  ])(
    'rejects a recovered proof with modified $name before committing any native ACK',
    async ({ mutate }) => {
      const f = await fixture()
      await emit(f)
      const candidate = proof()
      await run(f.coordinator.authorizeRecoveryReceiptEffect(candidate, [admission(f)]))
      const cold = await reopen(f)
      const before = await run(cold.store.readTransport(transportId))
      await expect(
        run(cold.coordinator.acknowledgeRecoveredHistoryProofEffect(mutate(copy(candidate)))),
      ).rejects.toThrow()
      const after = await run(cold.store.readTransport(transportId))
      expect(after.records).toEqual(before.records)
      expect(after.historyAcks).toEqual([])
      expect(replayRecoveryEvents(after, [consumer()])).toHaveLength(1)
    },
  )

  it('validates every recovered owner before committing an ACK for an earlier valid owner', async () => {
    const f = await fixture()
    await emit(f)
    await emit(f, 'session-b')
    const candidate = proof([claim('session-a', 1), claim('session-b', 2)])
    await run(
      f.coordinator.authorizeRecoveryReceiptEffect(candidate, [
        admission(f),
        admission(f, 'session-b', 2),
      ]),
    )
    const cold = await reopen(f)
    const before = await run(cold.store.readTransport(transportId))
    const forged = copy(candidate)
    forged.receipt.owners[1].nativeRecovery[transportId].snapshotToken = 'tampered-second-owner'
    await expect(
      run(cold.coordinator.acknowledgeRecoveredHistoryProofEffect(forged)),
    ).rejects.toThrow()
    const after = await run(cold.store.readTransport(transportId))
    expect(after.records).toEqual(before.records)
    expect(after.historyAcks).toEqual([])
    expect(replayRecoveryEvents(after, [consumer(1), consumer(2, 'session-b')])).toHaveLength(2)
  })

  it('does not grant receipt authority when publication fails after event commitment', async () => {
    const f = await fixture(() => {
      throw new Error('Renderer publication failed')
    })
    f.coordinator.beginWire(transportId, ++f.nextWire, 0)
    f.coordinator.event(transportId, { sessionId: 'session-a', type: 'text', text: exact }, owner())
    f.coordinator.endWire(transportId)
    await expect(run(f.coordinator.flushEffect())).rejects.toThrow(/could not be delivered/)
    const state = await run(f.store.readTransport(transportId))
    expect(state.events).toHaveLength(1)
    expect(f.published).toEqual([])
    expect(state.historyPrepares).toEqual([])
    const cold = await reopen(f)
    await expect(run(cold.coordinator.authorizeRecoveryReceiptEffect(proof()))).resolves.toBeNull()
    expect(
      replayRecoveryEvents(await run(cold.store.readTransport(transportId)), [consumer()]),
    ).toHaveLength(1)
  })

  it('refuses reentrant receipt authorization from a publication that subsequently throws', async () => {
    let coordinator: NativeAgentRecovery | undefined
    let authorization: Promise<ConversationRecoveryProof | null> | undefined
    const f = await fixture((event) => {
      authorization = run(
        coordinator!.authorizeRecoveryReceiptEffect(proof(), [admissionFromEvent(event)]),
      )
      // Observe rejection immediately while preserving the original Promise for
      // the assertion after publication unwinds.
      void authorization.catch(() => undefined)
      throw new Error('Publication failed after attempting its checkpoint')
    })
    coordinator = f.coordinator
    f.coordinator.beginWire(transportId, ++f.nextWire, 0)
    f.coordinator.event(transportId, { sessionId: 'session-a', type: 'text', text: exact }, owner())
    f.coordinator.endWire(transportId)
    await expect(run(f.coordinator.flushEffect())).rejects.toThrow(/could not be delivered/)
    expect(authorization).toBeDefined()
    await expect(authorization!).rejects.toThrow()
    const state = await run(f.store.readTransport(transportId))
    expect(state.events).toHaveLength(1)
    expect(state.historyPrepares).toEqual([])
    expect(state.historyAcks).toEqual([])
  })
})

describe('main recovery source admission', () => {
  it('does not use a copied positive private-ACK cursor as authority for retained main text without a header capability', async () => {
    const f = await fixture()
    await emit(f)
    await commitMainHistory(f)
    const cold = await reopen(f)
    const state = await run(cold.store.readTransport(transportId))
    const imported = copy(consumer())
    expect(acceptedRecoveryCursor(state, imported)?.appliedRevision).toBe(1)
    expect(cold.coordinator.acceptedCursor(state, imported)).toBeUndefined()
    expect(cold.coordinator.replayEvents(state, [imported])).toEqual([])
    expect(state.events).toHaveLength(1)
    const missingHistory = { ...consumer(), applied: undefined }
    expect(cold.coordinator.acceptedCursor(state, missingHistory)).toBeUndefined()
    expect(cold.coordinator.replayEvents(state, [missingHistory])).toMatchObject([
      { text: `${exact}1` },
    ])
  })

  it('admits the exact main source header returned for an actual loaded hash-proven history file', async () => {
    const f = await fixture()
    await emit(f)
    await commitMainHistory(f)
    const cold = await reopen(f)
    const reader = new ConversationCheckpointEngine(f.historyDirectory)
    const loaded = (await run(reader.loadRecoveryReceiptEffect()))!
    const headers = await run(cold.coordinator.admitLoadedHistoryProofEffect(loaded))
    expect(headers).toMatchObject([
      {
        sessionId: 'session-a',
        transportId,
        appliedRevision: 1,
        snapshotToken: 'native-token-session-a',
        ownerGeneration: 4,
        deliveryToken: expect.any(String),
      },
    ])
    const admitted = { ...consumer(), projectionAdmissions: headers }
    let state = await run(cold.store.readTransport(transportId))
    expect(cold.coordinator.acceptedCursor(state, admitted)).toEqual({
      appliedRevision: 1,
      snapshotToken: 'native-token-session-a',
      ownerGeneration: 4,
    })
    expect(cold.coordinator.replayEvents(state, [admitted])).toEqual([])
    cold.coordinator.beginWire(transportId, 2, 0, true)
    cold.coordinator.event(
      transportId,
      { sessionId: 'session-a', type: 'text', itemId: 'message-2', text: `${exact}2` },
      owner(),
    )
    cold.coordinator.endWire(transportId)
    await run(cold.coordinator.flushEffect())
    state = await run(cold.store.readTransport(transportId))
    expect(cold.coordinator.replayEvents(state, [admitted])).toMatchObject([{ text: `${exact}2` }])
    expect(state.events).toHaveLength(2)
  })

  it('keeps a truncated old main body unknown even when it retains a genuine previously ACKed native cursor', async () => {
    const f = await fixture()
    await emit(f)
    const original = await commitMainHistory(f)
    const path = join(f.historyDirectory, 'conversations.json')
    const snapshot = JSON.parse(await readFile(path, 'utf8'))
    snapshot.threads[0].messages[1].text = 'Truncated saved answer'
    await writeFile(path, JSON.stringify(snapshot))
    expect(hash(await readFile(path))).not.toBe(original.hash)
    const cold = await reopen(f)
    const reader = new ConversationCheckpointEngine(f.historyDirectory)
    await expect(run(reader.loadRecoveryReceiptEffect())).resolves.toBeNull()
    const state = await run(cold.store.readTransport(transportId))
    const retained = consumer()
    expect(acceptedRecoveryCursor(state, retained)?.appliedRevision).toBe(1)
    expect(cold.coordinator.acceptedCursor(state, retained)).toBeUndefined()
    expect(cold.coordinator.replayEvents(state, [retained])).toEqual([])
    expect((await run(reader.loadEffect()))?.threads[0]).toEqual(snapshot.threads[0])
    expect(state.events[0].event.text).toBe(`${exact}1`)
  })

  it.each(['wrong', 'revoked'] as const)(
    'refuses a %s main source capability despite a genuine loaded baseline and private ACK',
    async (kind) => {
      const f = await fixture()
      await emit(f)
      await commitMainHistory(f)
      const cold = await reopen(f)
      const reader = new ConversationCheckpointEngine(f.historyDirectory)
      const loaded = (await run(reader.loadRecoveryReceiptEffect()))!
      const headers = copy(await run(cold.coordinator.admitLoadedHistoryProofEffect(loaded)))
      if (kind === 'wrong') headers[0].deliveryToken = 'copied-other-runtime-token'
      else cold.coordinator.revokeDeliveryTokens()
      const state = await run(cold.store.readTransport(transportId))
      const stale = { ...consumer(), projectionAdmissions: headers }
      expect(cold.coordinator.acceptedCursor(state, stale)).toBeUndefined()
      expect(cold.coordinator.replayEvents(state, [stale])).toEqual([])
      const fresh = await run(cold.coordinator.admitLoadedHistoryProofEffect(loaded))
      const admitted = { ...consumer(), projectionAdmissions: fresh }
      expect(cold.coordinator.acceptedCursor(state, admitted)?.appliedRevision).toBe(1)
      expect(cold.coordinator.replayEvents(state, [admitted])).toEqual([])
    },
  )

  it('accepts an exact live native-delivery header without fabricating a durable history ACK', async () => {
    const f = await fixture()
    await emit(f)
    await emit(f, 'session-a', true)
    const state = await run(f.store.readTransport(transportId))
    expect(state.historyAcks).toEqual([])
    const live = { ...consumer(), projectionAdmissions: [admission(f)] }
    expect(f.coordinator.acceptedCursor(state, live)).toEqual({
      appliedRevision: 1,
      snapshotToken: 'native-token-session-a',
      ownerGeneration: 4,
    })
    expect(f.coordinator.replayEvents(state, [live])).toMatchObject([{ text: `${exact}2` }])
    expect(f.coordinator.acceptedCursor(state, consumer())).toBeUndefined()
    expect(f.coordinator.replayEvents(state, [consumer()])).toEqual([])
    expect(f.coordinator.replayEvents(state, [{ ...consumer(), applied: undefined }])).toHaveLength(
      2,
    )
  })
})
