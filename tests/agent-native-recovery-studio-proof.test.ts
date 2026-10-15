import { createHash } from 'node:crypto'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Effect, Exit, Scope } from 'effect'
import { afterEach, describe, expect, it } from 'vitest'
import { NativeAgentRecovery } from '../src/main/agent-native-recovery'
import type { ConversationRecoveryProof } from '../src/main/conversation-recovery-sidecar'
import {
  NativeRecoveryStore,
  type NativeRecoveryStoreHandle,
} from '../src/main/native-recovery-store'
import type {
  NativeRecoveryOwner,
  NativeRecoveryTransport,
} from '../src/main/native-recovery-types'
import {
  STUDIO_HISTORY_KEY,
  StudioHistoryStore,
  createStudioSession,
  readStudioHistory,
  type PreparedStudioHistoryWrite,
  type StudioSession,
} from '../src/renderer/studio-history'
import { applyEvent } from '../src/renderer/state'
import type { ConversationProjectionAdmission } from '../src/shared/conversations'
import type {
  AgentEvent,
  NativeRecoveryConsumer,
  NativeRecoveryCursor,
  NativeRecoveryHistoryReceipt,
} from '../src/shared/types'

const directories: string[] = []
const scopes: Scope.Closeable[] = []
afterEach(async () => {
  for (const scope of scopes.splice(0)) await Effect.runPromise(Scope.close(scope, Exit.void))
  for (const directory of directories.splice(0))
    await rm(directory, { recursive: true, force: true })
})

const run = <A>(effect: Effect.Effect<A, unknown>) => Effect.runPromise(effect)
const hash = (value: string) => createHash('sha256').update(value).digest('hex')
const transportId = 'studio-native-transport'
const sessionId = 'studio-native-session'
const snapshotToken = 'original-native-studio-owner'
const exact = '  Preserve this prompt\r\n🌍\ud800  '
const opaque = { future: [null, false, { text: exact }], kind: 'unrecognized-studio-row' }

function owner(studio = true): NativeRecoveryOwner {
  return {
    ownerId: sessionId,
    sessionId,
    kind: 'root',
    generation: 4,
    localTurn: 1,
    snapshotToken,
    workspace: '/home/fixture/.life/studio',
    writableRoot: '/home/fixture/.life/studio',
    nativeThreadId: 'original-provider-thread',
    state: 'active',
    input: {
      sessionId,
      provider: 'codex',
      remoteId: 'original-provider-thread',
      prompt: exact,
      mode: 'plan',
      workspace: '/home/fixture/.life/studio',
      ...(studio ? { scope: 'life-customization' } : {}),
    },
  }
}

function descriptor(studio = true): NativeRecoveryTransport {
  return {
    id: transportId,
    brokerId: 'original-studio-broker',
    brokerRoot: '/home/fixture/.life/agent-sessions/original-studio-broker',
    launchCommand: 'exec codex app-server',
    provider: 'codex',
    providerVersion: '0.162.1',
    nativeProtocol: 'codex-app-server-jsonrpc',
    brokerProtocolVersion: 2,
    machine: { profileId: 'profile', host: 'host', username: 'user', port: 22 },
    controller: { id: 'studio-controller', epoch: 1 },
    initialization: { status: 'complete' },
    owners: [owner(studio)],
  }
}

function initialHistory(): StudioHistoryStore {
  const created = createStudioSession('codex', 1, sessionId)
  return new StudioHistoryStore([
    opaque,
    {
      ...created,
      request: exact,
      thread: {
        ...created.thread,
        profileId: 'profile',
        workspace: owner().workspace,
        workspaceUnknown: false,
        remoteId: owner().nativeThreadId,
        turn: 1,
        messages: [{ id: 'original-user-message', role: 'user', text: exact, turn: 1 }],
      },
      unknownMetadata: { exact, originalSlots: [null, false, 'future'] },
    },
  ])
}

class CacheStorage {
  private readonly values = new Map<string, string>()
  failWrites = false
  attemptedWrites = 0

  getItem(key: string): string | null {
    return this.values.get(key) ?? null
  }

  setItem(key: string, value: string): void {
    this.attemptedWrites++
    if (this.failWrites) throw new Error('Studio cache quota exceeded')
    this.values.set(key, value)
  }
}

interface Fixture {
  directory: string
  store: NativeRecoveryStoreHandle
  coordinator: NativeAgentRecovery
  published: AgentEvent[]
  history: StudioHistoryStore
  storage: CacheStorage
  session: StudioSession
  nextWire: number
}

async function startStore(directory: string): Promise<NativeRecoveryStoreHandle> {
  const scope = await run(Scope.make())
  scopes.push(scope)
  return run(
    NativeRecoveryStore.make({ directory, outputBatchDelayMs: 1 }).pipe(Scope.provide(scope)),
  )
}

async function fixture(studio = true): Promise<Fixture> {
  const directory = await mkdtemp(join(tmpdir(), 'life-studio-prewrite-proof-'))
  directories.push(directory)
  const store = await startStore(directory)
  const snapshot = await run(store.createTransport(descriptor(studio)))
  const published: AgentEvent[] = []
  const coordinator = new NativeAgentRecovery(store, (event) => {
    published.push(event)
  })
  coordinator.seed(snapshot)
  const history = initialHistory()
  return {
    directory,
    store,
    coordinator,
    published,
    history,
    storage: new CacheStorage(),
    session: history.sessions[0],
    nextWire: 0,
  }
}

async function reopen(f: Fixture): Promise<Fixture> {
  await run(f.coordinator.flushEffect())
  await run(f.store.closeEffect())
  const store = await startStore(f.directory)
  const published: AgentEvent[] = []
  const coordinator = new NativeAgentRecovery(store, (event) => {
    published.push(event)
  })
  coordinator.seed(await run(store.readTransport(transportId)))
  const history = readStudioHistory(f.storage)
  return { ...f, store, coordinator, published, history, session: history.sessions[0] }
}

function eventAdmission(event: AgentEvent): ConversationProjectionAdmission {
  const native = event.nativeRecovery
  if (!native?.snapshotToken || !native.deliveryToken || native.ownerGeneration === undefined)
    throw new Error('The fixture must use an actual native-delivered projection capability')
  return {
    sessionId: event.sessionId,
    transportId: native.transportId,
    appliedRevision: native.revision,
    snapshotToken: native.snapshotToken,
    ownerGeneration: native.ownerGeneration,
    deliveryToken: native.deliveryToken,
  }
}

async function emit(f: Fixture, text = exact): Promise<ConversationProjectionAdmission> {
  const wire = ++f.nextWire
  f.coordinator.beginWire(transportId, wire, 0)
  f.coordinator.event(
    transportId,
    { sessionId, type: 'text', itemId: 'native-assistant-message', text },
    owner(),
  )
  f.coordinator.endWire(transportId)
  await run(f.coordinator.flushEffect())
  const event = f.published.at(-1)!
  f.session = { ...f.session, thread: applyEvent(f.session.thread, event) }
  return eventAdmission(event)
}

interface CacheCandidate {
  prepared: PreparedStudioHistoryWrite
  nativeOwner: NativeRecoveryOwner
  snapshotId: string
  hash: string
  cursor: Required<NativeRecoveryCursor>
}

function candidate(f: Fixture, id: string): CacheCandidate {
  const prepared = f.history.prepare([f.session])
  const view = prepared.views.find((entry) => entry.session.id === sessionId)!
  const sourceCursor = f.session.thread.nativeRecovery![transportId]
  if (!sourceCursor.snapshotToken || sourceCursor.ownerGeneration === undefined)
    throw new Error('The fixture cache must retain the original native owner token and generation')
  const cursor = {
    appliedRevision: sourceCursor.appliedRevision,
    snapshotToken: sourceCursor.snapshotToken,
    ownerGeneration: sourceCursor.ownerGeneration,
  }
  const fileHash = hash(view.encodedRow)
  return {
    prepared,
    snapshotId: id,
    hash: fileHash,
    cursor,
    nativeOwner: {
      ...owner(),
      clientRecovery: {
        phase: 'planning',
        preparedCache: {
          snapshotId: id,
          hash: fileHash,
          transportId,
          snapshotToken: cursor.snapshotToken!,
          ownerGeneration: cursor.ownerGeneration!,
          throughEventRevision: cursor.appliedRevision,
        },
      },
    },
  }
}

async function prewrite(
  f: Fixture,
  value: CacheCandidate,
  admissions: readonly ConversationProjectionAdmission[],
): Promise<void> {
  await run(f.coordinator.updateOwnerEffect(transportId, value.nativeOwner, admissions))
}

function actualConsumer(f: Fixture): NativeRecoveryConsumer {
  const raw = f.history.recoveryRow(f.session)
  if (!raw) throw new Error('The fixture must read an actually acknowledged raw Studio occurrence')
  const row = JSON.parse(raw) as { thread: { nativeRecovery: NativeRecoveryConsumer['applied'] } }
  return {
    kind: 'studio',
    sessionId,
    profileId: 'profile',
    workspace: owner().workspace,
    remoteId: owner().nativeThreadId,
    applied: row.thread.nativeRecovery,
    cacheHash: hash(raw),
  }
}

function receipt(value: CacheCandidate): NativeRecoveryHistoryReceipt {
  return {
    kind: 'studio',
    sessionId,
    transportId,
    snapshotToken: value.cursor.snapshotToken!,
    snapshotId: value.snapshotId,
    throughEventRevision: value.cursor.appliedRevision,
    durability: 'admitted-cache',
    fileHash: value.hash,
  }
}

describe('Studio native cache prewrite authority across cold reopen', () => {
  it('admits actual exact P1 row bytes after a crash before the ordinary cache ACK', async () => {
    const f = await fixture()
    const delivered = await emit(f)
    const p1 = candidate(f, 'P1')
    await prewrite(f, p1, [delivered])
    const beforeCache = await run(f.store.readTransport(transportId))
    expect(beforeCache.records.map((record) => record.kind)).toEqual([
      'create',
      'event',
      'history-prepare',
      'transport',
    ])
    expect(f.storage.getItem(STUDIO_HISTORY_KEY)).toBeNull()
    f.history.commitPrepared(p1.prepared, f.storage)
    const exactBytes = f.storage.getItem(STUDIO_HISTORY_KEY)!
    expect(JSON.parse(exactBytes)[0]).toEqual(opaque)
    expect(JSON.parse(exactBytes)[1].unknownMetadata).toEqual({
      exact,
      originalSlots: [null, false, 'future'],
    })
    const cold = await reopen(f)
    const state = await run(cold.store.readTransport(transportId))
    const consumer = actualConsumer(cold)
    expect(consumer.cacheHash).toBe(p1.hash)
    expect(state.historyAcks).toEqual([])
    expect(cold.coordinator.acceptedCursor(state, consumer)).toEqual(p1.cursor)
    expect(cold.coordinator.replayEvents(state, [consumer])).toEqual([])
    expect(cold.coordinator.getAcceptedProjectionAdmission(state, consumer, p1.cursor)).toEqual({
      ...delivered,
      deliveryToken: expect.any(String),
    })
    expect(cold.storage.getItem(STUDIO_HISTORY_KEY)).toBe(exactBytes)
  })

  it('retains P1 authority when P2 and repeated durable prewrites fail their real setItem commit', async () => {
    const f = await fixture()
    const firstDelivery = await emit(f)
    const p1 = candidate(f, 'P1')
    await prewrite(f, p1, [firstDelivery])
    f.history.commitPrepared(p1.prepared, f.storage)
    const originalBytes = f.storage.getItem(STUDIO_HISTORY_KEY)
    const secondDelivery = await emit(f, '\nSecond exact native suffix\udfff')
    f.storage.failWrites = true
    const p2 = candidate(f, 'P2')
    expect(p2.hash).not.toBe(p1.hash)
    await prewrite(f, p2, [secondDelivery])
    expect(() => f.history.commitPrepared(p2.prepared, f.storage)).toThrow('quota exceeded')
    await prewrite(f, p2, [secondDelivery])
    expect(() => f.history.commitPrepared(p2.prepared, f.storage)).toThrow('quota exceeded')
    const retry = candidate(f, 'P2-retry')
    await prewrite(f, retry, [secondDelivery])
    expect(() => f.history.commitPrepared(retry.prepared, f.storage)).toThrow('quota exceeded')
    expect(f.storage.attemptedWrites).toBe(4)
    expect(f.storage.getItem(STUDIO_HISTORY_KEY)).toBe(originalBytes)
    const cold = await reopen(f)
    const state = await run(cold.store.readTransport(transportId))
    expect(state.historyPrepares.map((entry) => entry.snapshotId)).toEqual(['P1', 'P2', 'P2-retry'])
    expect(state.transport.owners[0].clientRecovery).toEqual(retry.nativeOwner.clientRecovery)
    expect(state.historyAcks).toEqual([])
    const actual = actualConsumer(cold)
    expect(actual.cacheHash).toBe(p1.hash)
    expect(cold.coordinator.acceptedCursor(state, actual)).toEqual(p1.cursor)
    expect(cold.coordinator.replayEvents(state, [actual])).toMatchObject([
      { text: '\nSecond exact native suffix\udfff' },
    ])
    expect(cold.coordinator.getAcceptedProjectionAdmission(state, actual, p1.cursor)).toBeDefined()
    expect(cold.storage.getItem(STUDIO_HISTORY_KEY)).toBe(originalBytes)
  })

  it('uses a cold hash-proven P1 capability to prepare offline P3 bytes through an exact private ACK', async () => {
    const f = await fixture()
    const delivered = await emit(f)
    const p1 = candidate(f, 'P1')
    await prewrite(f, p1, [delivered])
    f.history.commitPrepared(p1.prepared, f.storage)
    const cold = await reopen(f)
    let state = await run(cold.store.readTransport(transportId))
    const actual = actualConsumer(cold)
    const recovered = cold.coordinator.getAcceptedProjectionAdmission(state, actual, p1.cursor)!
    expect(cold.published).toEqual([])
    expect(state.historyAcks).toEqual([])
    cold.session = { ...cold.session, changes: ['Offline feedback\r\n🌍\ud800'] }
    const p3 = candidate(cold, 'P3')
    expect(p3.hash).not.toBe(p1.hash)
    await prewrite(cold, p3, [recovered])
    state = await run(cold.store.readTransport(transportId))
    expect(state.historyAcks).toMatchObject([
      {
        consumerId: `studio:${sessionId}`,
        snapshotId: 'P1',
        fileHash: p1.hash,
        snapshotToken,
        ownerGeneration: 4,
        throughEventRevision: 1,
      },
    ])
    expect(state.historyPrepares.at(-1)).toMatchObject({
      snapshotId: 'P3',
      fileHash: p3.hash,
      owners: [{ authority: 'private-ack', throughEventRevision: 1 }],
    })
    expect(state.records.slice(-3).map((record) => record.kind)).toEqual([
      'history-ack',
      'history-prepare',
      'transport',
    ])
    cold.history.commitPrepared(p3.prepared, cold.storage)
    const reopenedAgain = await reopen(cold)
    state = await run(reopenedAgain.store.readTransport(transportId))
    expect(actualConsumer(reopenedAgain).cacheHash).toBe(p3.hash)
    expect(reopenedAgain.coordinator.acceptedCursor(state, actualConsumer(reopenedAgain))).toEqual(
      p3.cursor,
    )
    expect(reopenedAgain.coordinator.replayEvents(state, [actualConsumer(reopenedAgain)])).toEqual(
      [],
    )
  })

  it('never treats raw seeded preparedCache metadata as a private preparation', async () => {
    const f = await fixture()
    const delivered = await emit(f)
    const fake = candidate(f, 'raw-metadata-only')
    await run(f.store.updateTransport(transportId, { owners: [fake.nativeOwner] }))
    f.history.commitPrepared(fake.prepared, f.storage)
    const cold = await reopen(f)
    const state = await run(cold.store.readTransport(transportId))
    const actual = actualConsumer(cold)
    expect(state.historyPrepares).toEqual([])
    expect(state.historyAcks).toEqual([])
    expect(cold.coordinator.acceptedCursor(state, actual)).toBeUndefined()
    expect(
      cold.coordinator.getAcceptedProjectionAdmission(state, actual, fake.cursor),
    ).toBeUndefined()
    await expect(prewrite(cold, candidate(cold, 'forged-followup'), [delivered])).rejects.toThrow(
      /privately admitted projection capability/,
    )
    expect((await run(cold.store.readTransport(transportId))).historyPrepares).toEqual([])
  })

  it('prepares an offline rewrite of exact older P1 bytes without moving a later private ACK backward', async () => {
    const f = await fixture()
    const first = await emit(f)
    const p1 = candidate(f, 'P1')
    await prewrite(f, p1, [first])
    f.history.commitPrepared(p1.prepared, f.storage)
    const p1Bytes = f.storage.getItem(STUDIO_HISTORY_KEY)!
    await emit(f, '\nNative suffix two')
    const third = await emit(f, '\nNative suffix three')
    const newer = candidate(f, 'later-cache-revision-three')
    await prewrite(f, newer, [third])
    f.history.commitPrepared(newer.prepared, f.storage)
    await run(f.coordinator.acknowledgeHistoryEffect(receipt(newer), [actualConsumer(f)]))
    f.storage.setItem(STUDIO_HISTORY_KEY, p1Bytes)
    const cold = await reopen(f)
    let state = await run(cold.store.readTransport(transportId))
    const actual = actualConsumer(cold)
    const recovered = cold.coordinator.getAcceptedProjectionAdmission(state, actual, p1.cursor)!
    expect(recovered.appliedRevision).toBe(1)
    expect(state.historyAcks).toMatchObject([{ throughEventRevision: 3, fileHash: newer.hash }])
    cold.session = { ...cold.session, changes: ['Recovered older cache with offline feedback'] }
    const p3 = candidate(cold, 'P3-older-cache-offline')
    await prewrite(cold, p3, [recovered])
    state = await run(cold.store.readTransport(transportId))
    expect(state.historyAcks).toMatchObject([
      {
        snapshotId: newer.snapshotId,
        fileHash: newer.hash,
        throughEventRevision: 3,
      },
    ])
    expect(state.historyPrepares.at(-1)).toMatchObject({
      snapshotId: p3.snapshotId,
      fileHash: p3.hash,
      owners: [{ throughEventRevision: 1, authority: 'private-ack' }],
    })
    cold.history.commitPrepared(p3.prepared, cold.storage)
    const reopenedAgain = await reopen(cold)
    state = await run(reopenedAgain.store.readTransport(transportId))
    expect(reopenedAgain.coordinator.acceptedCursor(state, actualConsumer(reopenedAgain))).toEqual(
      p1.cursor,
    )
    expect(
      reopenedAgain.coordinator.replayEvents(state, [actualConsumer(reopenedAgain)]),
    ).toMatchObject([{ text: '\nNative suffix two' }, { text: '\nNative suffix three' }])
  })

  it.each(['previous-runtime', 'revoked-current-runtime'] as const)(
    'refuses a %s capability when preparing new bytes over a genuine cold P1 baseline',
    async (kind) => {
      const f = await fixture()
      const delivered = await emit(f)
      const p1 = candidate(f, 'P1')
      await prewrite(f, p1, [delivered])
      f.history.commitPrepared(p1.prepared, f.storage)
      const cold = await reopen(f)
      const state = await run(cold.store.readTransport(transportId))
      const actual = actualConsumer(cold)
      const accepted = cold.coordinator.getAcceptedProjectionAdmission(state, actual, p1.cursor)!
      expect(accepted.deliveryToken).not.toBe(delivered.deliveryToken)
      const stale = kind === 'previous-runtime' ? delivered : accepted
      if (kind === 'revoked-current-runtime') cold.coordinator.revokeDeliveryTokens()
      cold.session = { ...cold.session, changes: ['Offline edit requires fresh native authority'] }
      const next = candidate(cold, 'P3')
      await expect(prewrite(cold, next, [stale])).rejects.toThrow(/projection capability/)
      let durable = await run(cold.store.readTransport(transportId))
      expect(durable.historyPrepares.map((entry) => entry.snapshotId)).toEqual(['P1'])
      expect(durable.historyAcks).toEqual([])
      const refreshed = cold.coordinator.getAcceptedProjectionAdmission(durable, actual, p1.cursor)!
      await prewrite(cold, next, [refreshed])
      durable = await run(cold.store.readTransport(transportId))
      expect(durable.historyPrepares.map((entry) => entry.snapshotId)).toEqual(['P1', 'P3'])
      expect(durable.historyPrepares.at(-1)!.owners[0].authority).toBe('private-ack')
      expect(durable.historyAcks).toMatchObject([{ snapshotId: 'P1', fileHash: p1.hash }])
    },
  )

  it.each(['missing', 'forged', 'wrong-revision', 'wrong-generation'] as const)(
    'refuses a %s separate projection header before creating a private prewrite',
    async (kind) => {
      const f = await fixture()
      const delivered = await emit(f)
      const p1 = candidate(f, 'P1')
      const supplied =
        kind === 'missing'
          ? []
          : [
              {
                ...delivered,
                ...(kind === 'forged' ? { deliveryToken: 'copied-archival-delivery-token' } : {}),
                ...(kind === 'wrong-revision' ? { appliedRevision: 0 } : {}),
                ...(kind === 'wrong-generation' ? { ownerGeneration: 5 } : {}),
              },
            ]
      await expect(prewrite(f, p1, supplied)).rejects.toThrow(/projection capability/)
      const state = await run(f.store.readTransport(transportId))
      expect(state.historyPrepares).toEqual([])
      expect(state.transport.owners[0].clientRecovery).toBeUndefined()
      expect(f.storage.getItem(STUDIO_HISTORY_KEY)).toBeNull()
    },
  )

  it.each(['token', 'transport', 'generation', 'revision'] as const)(
    'refuses prepared cache metadata with the wrong %s tuple',
    async (kind) => {
      const f = await fixture()
      const delivered = await emit(f)
      const p1 = candidate(f, 'P1')
      const metadata = p1.nativeOwner.clientRecovery as {
        preparedCache: Record<string, unknown>
      }
      const patches = {
        token: { snapshotToken: 'foreign-native-token' },
        transport: { transportId: 'foreign-transport' },
        generation: { ownerGeneration: 5 },
        revision: { throughEventRevision: 2 },
      }
      p1.nativeOwner = {
        ...p1.nativeOwner,
        clientRecovery: {
          preparedCache: { ...metadata.preparedCache, ...patches[kind] },
        },
      }
      await expect(prewrite(f, p1, [delivered])).rejects.toThrow(/exact registered native owner/)
      expect((await run(f.store.readTransport(transportId))).historyPrepares).toEqual([])
    },
  )

  it('denies Studio authority when the original native owner belongs to another scope', async () => {
    const f = await fixture(false)
    const delivered = await emit(f)
    const p1 = candidate(f, 'P1')
    // The proposed owner says Studio; the original native registration does not.
    expect(p1.nativeOwner.input.scope).toBe('life-customization')
    await expect(prewrite(f, p1, [delivered])).rejects.toMatchObject({
      operation: 'owner',
      reason: 'uncertain',
    })
    const state = await run(f.store.readTransport(transportId))
    expect(state.transport.owners[0].input.scope).toBeUndefined()
    expect(state.historyPrepares).toEqual([])
    expect(f.storage.getItem(STUDIO_HISTORY_KEY)).toBeNull()
  })

  it('refuses a plain scope change before it can manufacture historical Studio preparation authority', async () => {
    const f = await fixture(false)
    const delivered = await emit(f)
    const p1 = candidate(f, 'P1')
    await expect(
      run(
        f.coordinator.updateOwnerEffect(transportId, {
          ...p1.nativeOwner,
          clientRecovery: { phase: 'planning' },
        }),
      ),
    ).rejects.toThrow(/original scope/)
    await expect(prewrite(f, p1, [delivered])).rejects.toMatchObject({
      operation: 'owner',
      reason: 'uncertain',
    })
    const cold = await reopen(f)
    const state = await run(cold.store.readTransport(transportId))
    expect(state.records.map((record) => record.kind)).toEqual(['create', 'event'])
    expect(state.transport.owners[0].input.scope).toBeUndefined()
    expect(state.transport.owners[0].clientRecovery).toBeUndefined()
    expect(state.historyPrepares).toEqual([])
    expect(state.historyAcks).toEqual([])
  })

  it('binds cold admission and the ordinary ACK to the exact prepared cache hash and revision', async () => {
    const f = await fixture()
    const delivered = await emit(f)
    const p1 = candidate(f, 'P1')
    await prewrite(f, p1, [delivered])
    f.history.commitPrepared(p1.prepared, f.storage)
    const cold = await reopen(f)
    let state = await run(cold.store.readTransport(transportId))
    const actual = actualConsumer(cold)
    for (const invalid of [
      { ...actual, cacheHash: hash('truncated saved Studio body') },
      { ...actual, cacheHash: undefined },
      {
        ...actual,
        applied: { [transportId]: { ...p1.cursor, appliedRevision: 2 } },
      },
      {
        ...actual,
        applied: { [transportId]: { ...p1.cursor, snapshotToken: 'foreign-native-token' } },
      },
    ]) {
      expect(cold.coordinator.acceptedCursor(state, invalid)).toBeUndefined()
      expect(
        cold.coordinator.getAcceptedProjectionAdmission(state, invalid, p1.cursor),
      ).toBeUndefined()
    }
    for (const invalid of [
      { ...receipt(p1), fileHash: hash('different row') },
      { ...receipt(p1), fileHash: undefined },
      { ...receipt(p1), throughEventRevision: 0 },
      { ...receipt(p1), snapshotToken: 'foreign-native-token' },
      { ...receipt(p1), snapshotId: 'different-prewrite' },
    ])
      await expect(
        run(cold.coordinator.acknowledgeHistoryEffect(invalid, [actual])),
      ).rejects.toThrow(/exact committed native owner snapshot/)
    expect((await run(cold.store.readTransport(transportId))).historyAcks).toEqual([])
    await run(cold.coordinator.acknowledgeHistoryEffect(receipt(p1), [actual]))
    state = await run(cold.store.readTransport(transportId))
    expect(state.historyAcks).toMatchObject([
      { snapshotId: 'P1', fileHash: p1.hash, snapshotToken, ownerGeneration: 4 },
    ])
    expect(cold.coordinator.acceptedCursor(state, actual)).toEqual(p1.cursor)
  })

  it.each(['native-file', 'main-cache', 'legacy-native-file'] as const)(
    'does not admit Studio cache bytes using an exact hash prepared for %s',
    async (location) => {
      const f = await fixture()
      await emit(f)
      const p1 = candidate(f, 'P1-wrong-location')
      await run(
        f.store.prepareHistory(transportId, {
          snapshotId: p1.snapshotId,
          fileHash: p1.hash,
          ...(location === 'legacy-native-file' ? {} : { location }),
          owners: [
            {
              consumerId: `studio:${sessionId}`,
              sessionId,
              snapshotToken,
              ownerGeneration: 4,
              throughEventRevision: 1,
              authority: 'native-delivery',
            },
          ],
        }),
      )
      f.history.commitPrepared(p1.prepared, f.storage)
      const cold = await reopen(f)
      const state = await run(cold.store.readTransport(transportId))
      const actual = actualConsumer(cold)
      expect(actual.cacheHash).toBe(p1.hash)
      expect(state.historyPrepares).toHaveLength(1)
      expect(cold.coordinator.acceptedCursor(state, actual)).toBeUndefined()
      expect(
        cold.coordinator.getAcceptedProjectionAdmission(state, actual, p1.cursor),
      ).toBeUndefined()
      await expect(
        run(cold.coordinator.acknowledgeHistoryEffect(receipt(p1), [actual])),
      ).rejects.toThrow(/exact committed native owner snapshot/)
      expect((await run(cold.store.readTransport(transportId))).historyAcks).toEqual([])
    },
  )

  it.each(['studio-cache', 'main-cache'] as const)(
    'does not turn an exact %s preparation into a main native-file proof',
    async (location) => {
      const f = await fixture()
      await emit(f)
      const p1 = candidate(f, 'same-bytes-wrong-native-location')
      await run(
        f.store.prepareHistory(transportId, {
          snapshotId: p1.snapshotId,
          fileHash: p1.hash,
          location,
          owners: [
            {
              consumerId: `main:${sessionId}`,
              sessionId,
              snapshotToken,
              ownerGeneration: 4,
              throughEventRevision: 1,
              authority: 'native-delivery',
            },
          ],
        }),
      )
      const proof: ConversationRecoveryProof = {
        hash: p1.hash,
        savedAt: 1,
        receipt: {
          snapshotId: p1.snapshotId,
          owners: [
            {
              sessionId,
              provider: 'codex',
              profileId: 'profile',
              workspace: owner().workspace,
              remoteId: owner().nativeThreadId!,
              nativeRecovery: { [transportId]: p1.cursor },
            },
          ],
        },
      }
      const cold = await reopen(f)
      await expect(
        run(cold.coordinator.admitLoadedHistoryProofEffect(proof)),
      ).rejects.toMatchObject({
        operation: 'history-ack',
        reason: 'uncertain',
      })
      await expect(run(cold.coordinator.authorizeRecoveryReceiptEffect(proof))).resolves.toBeNull()
      await expect(
        run(
          cold.coordinator.acknowledgeMainHistoryEffect({
            savedAt: proof.savedAt,
            nativeRecovery: proof.receipt,
            nativeRecoveryHash: proof.hash,
          }),
        ),
      ).rejects.toThrow()
      const state = await run(cold.store.readTransport(transportId))
      expect(state.historyPrepares).toHaveLength(1)
      expect(state.historyPrepares[0].location).toBe(location)
      expect(state.historyAcks).toEqual([])
    },
  )
})
