import { createHash } from 'node:crypto'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Effect, Exit, Scope } from 'effect'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { NativeAgentRecovery } from '../src/main/agent-native-recovery'
import { ConversationCheckpointEngine } from '../src/main/conversation-checkpoint-engine'
import type { ConversationRecoveryProof } from '../src/main/conversation-recovery-sidecar'
import {
  NativeRecoveryStore,
  type NativeRecoveryStoreHandle,
} from '../src/main/native-recovery-store'
import type {
  NativeRecoveryHistoryPrepare,
  NativeRecoveryOwner,
  NativeRecoveryTransport,
} from '../src/main/native-recovery-types'
import type {
  ConversationCheckpointAck,
  ConversationProjectionAdmission,
} from '../src/shared/conversations'
import type { AgentEvent, NativeRecoveryConsumer } from '../src/shared/types'

const directories: string[] = []
const scopes: Scope.Closeable[] = []
const run = <A>(effect: Effect.Effect<A, unknown>) => Effect.runPromise(effect)
const hash = (bytes: string | Buffer) => createHash('sha256').update(bytes).digest('hex')
const copy = <A>(value: A): A => JSON.parse(JSON.stringify(value)) as A
const transportId = 'original-main-cache-transport'
const sessionId = 'original-main-cache-session'
const secondTransportId = 'second-main-cache-transport'
const secondSessionId = 'second-main-cache-session'
const exact = '  Exact\r\nmain cache output 🌍\ud800  '

afterEach(async () => {
  for (const scope of scopes.splice(0)) await run(Scope.close(scope, Exit.void))
  for (const directory of directories.splice(0))
    await rm(directory, { recursive: true, force: true })
})

describe('durable main-cache absence membership authority', () => {
  it.each(['empty', 'opaque-only'] as const)(
    'recovers the exact last-owner deletion clock from actual %s bytes without granting transcript authority',
    async (remaining) => {
      const f = await fixture()
      await emit(f)
      const original = admission(f)
      const bytes = remaining === 'empty' ? '[]' : JSON.stringify([JSON.parse(cacheBytes())[1]])
      await prepareMembership(f, bytes, [original])
      await writeFile(f.cachePath, bytes)
      const cold = await reopen(f)
      const before = await run(cold.store.readTransport(transportId))
      const attested = await run(
        cold.coordinator.attestRecoveryCacheEffect({ hash: hash(await readFile(f.cachePath)) }),
      )
      expect(attested.savedAt).toBe(200)
      expect(attested.projectionAdmissions).toEqual([])
      expect(attested.membershipAdmissions).toEqual([
        { ...original, deliveryToken: expect.any(String) },
      ])
      const memberships = attested.membershipAdmissions!
      expect(memberships[0].deliveryToken).not.toBe(original.deliveryToken)
      expect(cold.coordinator.isAbsentMembership(before, owner(), memberships)).toBe(true)
      expect(
        cold.coordinator.acceptedCursor(before, consumer(1, hash(bytes), memberships)),
      ).toBeUndefined()
      expect(
        cold.coordinator.acceptedCursor(before, consumer(1, undefined, memberships)),
      ).toBeUndefined()
      expect(
        cold.coordinator.replayEvents(before, [consumer(1, hash(bytes), memberships)]),
      ).toEqual([])
      await expect(
        run(cold.coordinator.authorizeRecoveryReceiptEffect(proof(hash(bytes)), memberships)),
      ).resolves.toBeNull()
      await expect(
        run(cold.coordinator.acknowledgeMainHistoryEffect(checkpointAck(proof(hash(bytes))))),
      ).rejects.toThrow()
      expect((await run(cold.store.readTransport(transportId))).records).toEqual(before.records)
      expect(before.historyPrepares).toEqual([
        {
          location: 'main-cache',
          snapshotId: 'native-owner-absent-cache',
          fileHash: hash(bytes),
          savedAt: 200,
          owners: [
            {
              consumerId: `main-cache:${sessionId}`,
              sessionId,
              snapshotToken: 'original-main-cache-token',
              ownerGeneration: 4,
              throughEventRevision: 1,
              authority: 'native-delivery',
              absent: true,
            },
          ],
        },
      ])
      expect(before.historyAcks).toEqual([])
      expect(await readFile(f.cachePath, 'utf8')).toBe(bytes)
      expect(JSON.parse(bytes)).toEqual(remaining === 'empty' ? [] : [JSON.parse(cacheBytes())[1]])
      expect(bytes).not.toContain(memberships[0].deliveryToken)
      expect(
        await readFile(join(f.ledgerDirectory, `${hash(transportId)}.jsonl`), 'utf8'),
      ).not.toContain(memberships[0].deliveryToken)
      expect(cold.published).not.toHaveBeenCalled()
    },
  )

  it('keeps original P1 projection membership and clock when an empty deletion was prepared but never written', async () => {
    const f = await fixture()
    await emit(f)
    const original = admission(f)
    const p1 = cacheBytes()
    await prepare(f, p1)
    await writeFile(f.cachePath, p1)
    await emit(f)
    await prepareMembership(f, '[]', [original])
    const browserWrite = vi.fn(() => {
      throw new Error('Browser exited before empty history write')
    })
    expect(browserWrite).toThrow('Browser exited before empty history write')
    const cold = await reopen(f)
    const actualBytes = await readFile(f.cachePath, 'utf8')
    const attested = await run(
      cold.coordinator.attestRecoveryCacheEffect({ hash: hash(actualBytes) }),
    )
    expect(actualBytes).toBe(p1)
    expect(attested.savedAt).toBe(100)
    expect(attested.membershipAdmissions).toBeUndefined()
    expect(attested.projectionAdmissions).toEqual([
      { ...original, deliveryToken: expect.any(String) },
    ])
    const state = await run(cold.store.readTransport(transportId))
    expect(cold.coordinator.isAbsentMembership(state, owner(), attested.membershipAdmissions)).toBe(
      false,
    )
    const retained = consumer(1, hash(actualBytes), attested.projectionAdmissions)
    expect(cold.coordinator.acceptedCursor(state, retained)?.appliedRevision).toBe(1)
    expect(cold.coordinator.replayEvents(state, [retained])).toMatchObject([
      { sessionId, type: 'text', itemId: 'message-2', text: `${exact}2` },
    ])
    expect(
      state.historyPrepares.map((prepare) => [
        prepare.fileHash,
        prepare.savedAt,
        prepare.owners[0].absent,
      ]),
    ).toEqual([
      [hash(p1), 100, undefined],
      [hash('[]'), 200, true],
    ])
    expect(state.historyAcks).toEqual([])
    expect(cold.published).not.toHaveBeenCalled()
  })

  it('confines absence decisions and replay to the packet selected from actual cache bytes', async () => {
    const f = await fixture()
    await emit(f)
    const original = admission(f)
    const p1 = cacheBytes()
    await prepare(f, p1)
    await prepareMembership(f, '[]', [original])
    await emit(f)
    await writeFile(f.cachePath, '[]')
    const cold = await reopen(f)
    const state = await run(cold.store.readTransport(transportId))
    const absent = await run(
      cold.coordinator.attestRecoveryCacheEffect({ hash: hash(await readFile(f.cachePath)) }),
    )
    expect(cold.coordinator.isAbsentMembership(state, owner(), absent.membershipAdmissions)).toBe(
      true,
    )
    expect(
      cold.coordinator.acceptedCursor(state, consumer(1, hash('[]'), absent.membershipAdmissions)),
    ).toBeUndefined()
    await writeFile(f.cachePath, p1)
    const present = await run(
      cold.coordinator.attestRecoveryCacheEffect({ hash: hash(await readFile(f.cachePath)) }),
    )
    expect(present.membershipAdmissions).toBeUndefined()
    expect(cold.coordinator.isAbsentMembership(state, owner(), present.membershipAdmissions)).toBe(
      false,
    )
    expect(cold.coordinator.isAbsentMembership(state, owner(), present.projectionAdmissions)).toBe(
      false,
    )
    const retained = consumer(1, hash(p1), present.projectionAdmissions)
    expect(cold.coordinator.replayEvents(state, [retained])).toMatchObject([
      { itemId: 'message-2', text: `${exact}2` },
    ])
    expect(
      cold.coordinator.acceptedCursor(state, consumer(1, hash('[]'), present.projectionAdmissions)),
    ).toBeUndefined()
    expect((await run(cold.store.readTransport(transportId))).records).toEqual(state.records)
    expect(state.historyAcks).toEqual([])
  })

  it('admits an attested absence token only for another membership preparation and never for projection or native file authority', async () => {
    const f = await fixture()
    await emit(f)
    await prepareMembership(f, '[]', [admission(f)])
    await writeFile(f.cachePath, '[]')
    const cold = await reopen(f)
    const attested = await run(
      cold.coordinator.attestRecoveryCacheEffect({ hash: hash(await readFile(f.cachePath)) }),
    )
    const memberships = attested.membershipAdmissions!
    const before = await run(cold.store.readTransport(transportId))
    const nextBytes = JSON.stringify([JSON.parse(cacheBytes())[1]])
    await expect(
      run(
        cold.coordinator.prepareRecoveryCacheEffect({
          snapshotId: 'absence-cannot-project',
          hash: hash(nextBytes),
          savedAt: 300,
          projectionAdmissions: memberships,
        }),
      ),
    ).rejects.toThrow()
    await expect(
      run(cold.coordinator.authorizeRecoveryReceiptEffect(proof(hash(nextBytes)), memberships)),
    ).resolves.toBeNull()
    expect((await run(cold.store.readTransport(transportId))).records).toEqual(before.records)
    await run(
      cold.coordinator.prepareRecoveryCacheEffect({
        snapshotId: 'renewed-absence-cache',
        hash: hash(nextBytes),
        savedAt: 300,
        projectionAdmissions: [],
        membershipAdmissions: memberships,
      }),
    )
    await writeFile(f.cachePath, nextBytes)
    const nextCold = await reopen({ ...f, store: cold.store })
    const renewed = await run(
      nextCold.coordinator.attestRecoveryCacheEffect({ hash: hash(await readFile(f.cachePath)) }),
    )
    expect(renewed.savedAt).toBe(300)
    expect(renewed.projectionAdmissions).toEqual([])
    expect(renewed.membershipAdmissions).toMatchObject([
      { sessionId, transportId, appliedRevision: 1 },
    ])
    const state = await run(nextCold.store.readTransport(transportId))
    expect(
      nextCold.coordinator.isAbsentMembership(state, owner(), renewed.membershipAdmissions),
    ).toBe(true)
    expect(
      nextCold.coordinator.acceptedCursor(
        state,
        consumer(1, undefined, renewed.membershipAdmissions),
      ),
    ).toBeUndefined()
    expect(state.historyPrepares).toHaveLength(2)
    expect(state.historyPrepares.at(-1)?.owners[0].absent).toBe(true)
    expect(state.historyAcks).toEqual([])
  })

  it('preserves retained owner B projection while granting only deleted owner A absence membership', async () => {
    const f = await fixture()
    await emit(f)
    await addSecondTransport(f)
    const complete = JSON.parse(fullCacheBytes())
    const bytes = JSON.stringify(complete.filter((row: { id: string }) => row.id !== sessionId))
    await prepareMembership(f, bytes, [admission(f)], 200, [admission(f, secondSessionId)])
    await writeFile(f.cachePath, bytes)
    const cold = await reopen(f)
    const attested = await run(
      cold.coordinator.attestRecoveryCacheEffect({ hash: hash(await readFile(f.cachePath)) }),
    )
    expect(attested.savedAt).toBe(200)
    expect(attested.projectionAdmissions).toEqual([
      { ...admission(f, secondSessionId), deliveryToken: expect.any(String) },
    ])
    expect(attested.membershipAdmissions).toEqual([
      { ...admission(f), deliveryToken: expect.any(String) },
    ])
    const first = await run(cold.store.readTransport(transportId))
    const second = await run(cold.store.readTransport(secondTransportId))
    expect(cold.coordinator.isAbsentMembership(first, owner(), attested.membershipAdmissions)).toBe(
      true,
    )
    expect(
      cold.coordinator.isAbsentMembership(second, secondOwner(), attested.membershipAdmissions),
    ).toBe(false)
    expect(
      cold.coordinator.acceptedCursor(
        first,
        consumer(1, hash(bytes), attested.membershipAdmissions),
      ),
    ).toBeUndefined()
    expect(
      cold.coordinator.acceptedCursor(
        second,
        secondConsumer(hash(bytes), attested.projectionAdmissions),
      )?.appliedRevision,
    ).toBe(1)
    expect(
      cold.coordinator.replayEvents(second, [
        secondConsumer(hash(bytes), attested.projectionAdmissions),
      ]),
    ).toEqual([])
    expect(first.historyPrepares[0].owners[0].absent).toBe(true)
    expect(second.historyPrepares[0].owners[0].absent).toBeUndefined()
    expect(first.historyAcks).toEqual([])
    expect(second.historyAcks).toEqual([])
    expect(await readFile(f.cachePath, 'utf8')).toBe(bytes)
    expect(cold.published).not.toHaveBeenCalled()
  })

  it.each([
    {
      name: 'forged token',
      mutate: (value: ConversationProjectionAdmission) => ({
        ...value,
        deliveryToken: 'forged-membership-token',
      }),
    },
    {
      name: 'missing token',
      mutate: (value: ConversationProjectionAdmission) => ({
        ...value,
        deliveryToken: undefined as unknown as string,
      }),
    },
    {
      name: 'wrong generation',
      mutate: (value: ConversationProjectionAdmission) => ({ ...value, ownerGeneration: 5 }),
    },
    {
      name: 'wrong native owner token',
      mutate: (value: ConversationProjectionAdmission) => ({
        ...value,
        snapshotToken: 'other-native-owner',
      }),
    },
  ])('refuses $name membership before any durable preparation', async ({ mutate }) => {
    const f = await fixture()
    await emit(f)
    const before = await run(f.store.readTransport(transportId))
    await expect(prepareMembership(f, '[]', [mutate(admission(f))])).rejects.toThrow()
    expect((await run(f.store.readTransport(transportId))).records).toEqual(before.records)
    expect(before.historyPrepares).toEqual([])
    expect(before.historyAcks).toEqual([])
  })

  it('validates every membership and conflicting role before fsync of an earlier genuine claim', async () => {
    const f = await fixture()
    await emit(f)
    const actual = admission(f)
    const before = await run(f.store.readTransport(transportId))
    await expect(
      prepareMembership(f, '[]', [actual, { ...actual, deliveryToken: 'forged-later-token' }]),
    ).rejects.toThrow()
    await expect(prepareMembership(f, '[]', [actual], 200, [actual])).rejects.toThrow()
    expect((await run(f.store.readTransport(transportId))).records).toEqual(before.records)
    expect(before.historyPrepares).toEqual([])
    expect(before.historyAcks).toEqual([])
  })

  it('revokes an attested absence token without converting it to owner or transcript authority', async () => {
    const f = await fixture()
    await emit(f)
    await prepareMembership(f, '[]', [admission(f)])
    await writeFile(f.cachePath, '[]')
    const cold = await reopen(f)
    const attested = await run(cold.coordinator.attestRecoveryCacheEffect({ hash: hash('[]') }))
    const state = await run(cold.store.readTransport(transportId))
    expect(cold.coordinator.isAbsentMembership(state, owner(), attested.membershipAdmissions)).toBe(
      true,
    )
    cold.coordinator.revokeDeliveryTokens()
    expect(cold.coordinator.isAbsentMembership(state, owner(), attested.membershipAdmissions)).toBe(
      false,
    )
    await expect(
      run(
        cold.coordinator.prepareRecoveryCacheEffect({
          snapshotId: 'revoked-absence-cache',
          hash: hash('[]'),
          savedAt: 300,
          projectionAdmissions: [],
          membershipAdmissions: attested.membershipAdmissions,
        }),
      ),
    ).rejects.toThrow()
    expect((await run(cold.store.readTransport(transportId))).records).toEqual(state.records)
    const renewed = await run(cold.coordinator.attestRecoveryCacheEffect({ hash: hash('[]') }))
    expect(renewed.membershipAdmissions?.[0].deliveryToken).not.toBe(
      attested.membershipAdmissions?.[0].deliveryToken,
    )
    expect(cold.coordinator.isAbsentMembership(state, owner(), renewed.membershipAdmissions)).toBe(
      true,
    )
    expect(
      cold.coordinator.acceptedCursor(state, consumer(1, undefined, renewed.membershipAdmissions)),
    ).toBeUndefined()
    expect(state.historyAcks).toEqual([])
  })

  it('reuses exact same-hash absence capability without sharing mutable private authority or writing the ledger', async () => {
    const f = await fixture()
    await emit(f)
    await prepareMembership(f, '[]', [admission(f)])
    await writeFile(f.cachePath, '[]')
    const cold = await reopen(f)
    const before = await run(cold.store.readTransport(transportId))
    const first = await run(
      cold.coordinator.attestRecoveryCacheEffect({ hash: hash(await readFile(f.cachePath)) }),
    )
    const second = await run(
      cold.coordinator.attestRecoveryCacheEffect({ hash: hash(await readFile(f.cachePath)) }),
    )
    expect(first).not.toBe(second)
    expect(first.savedAt).toBe(200)
    expect(second.savedAt).toBe(200)
    expect(first.projectionAdmissions).toEqual([])
    expect(second.projectionAdmissions).toEqual([])
    const firstHeader = first.membershipAdmissions![0]
    const secondHeader = second.membershipAdmissions![0]
    const original = copy(firstHeader)
    expect(secondHeader).toEqual(original)
    expect(secondHeader.deliveryToken).toBe(firstHeader.deliveryToken)
    if (!Object.isFrozen(firstHeader)) expect(firstHeader).not.toBe(secondHeader)
    try {
      Object.assign(firstHeader, {
        ownerGeneration: 99,
        snapshotToken: 'caller-edited-token',
        appliedRevision: 2,
      })
    } catch (error) {
      expect(error).toBeInstanceOf(TypeError)
    }
    expect(secondHeader).toEqual(original)
    expect(cold.coordinator.isAbsentMembership(before, owner(), [original])).toBe(true)
    expect(cold.coordinator.isAbsentMembership(before, owner(), [secondHeader])).toBe(true)
    const third = await run(
      cold.coordinator.attestRecoveryCacheEffect({ hash: hash(await readFile(f.cachePath)) }),
    )
    expect(third.membershipAdmissions).toEqual([original])
    expect((await run(cold.store.readTransport(transportId))).records).toEqual(before.records)
    expect(before.historyAcks).toEqual([])
    expect(cold.published).not.toHaveBeenCalled()
    expect(await readFile(f.cachePath, 'utf8')).toBe('[]')
  })

  it.each(['assign', 'define-property'] as const)(
    'does not alias private membership authority when a returned header is mutated with %s',
    async (mutation) => {
      const f = await fixture()
      await emit(f)
      await prepareMembership(f, '[]', [admission(f)])
      await writeFile(f.cachePath, '[]')
      const cold = await reopen(f)
      const beforeAttestation = await run(cold.store.readTransport(transportId))
      const attested = await run(
        cold.coordinator.attestRecoveryCacheEffect({ hash: hash(await readFile(f.cachePath)) }),
      )
      const returned = attested.membershipAdmissions![0]
      const original = copy(returned)
      expect(cold.coordinator.isAbsentMembership(beforeAttestation, owner(), [original])).toBe(true)
      expect((await run(cold.store.readTransport(transportId))).records).toEqual(
        beforeAttestation.records,
      )
      const newer: NativeRecoveryOwner = {
        ...owner(),
        generation: 5,
        snapshotToken: 'genuine-new-generation-token',
        localTurn: 9,
      }
      await run(cold.store.updateTransport(transportId, { owners: [newer] }))
      cold.coordinator.seed(await run(cold.store.readTransport(transportId)))
      cold.coordinator.beginWire(transportId, 2, 0)
      try {
        cold.coordinator.event(
          transportId,
          { sessionId, type: 'text', itemId: 'genuine-new-generation-message', text: `${exact}2` },
          newer,
        )
      } finally {
        cold.coordinator.endWire(transportId)
      }
      await run(cold.coordinator.flushEffect())
      const state = await run(cold.store.readTransport(transportId))
      expect(state.eventRevision).toBe(2)
      expect(state.transport.owners[0].snapshotToken).toBe(newer.snapshotToken)
      const alteredFields = {
        snapshotToken: newer.snapshotToken!,
        ownerGeneration: 5,
        appliedRevision: 2,
      }
      let mutationBlocked = false
      try {
        if (mutation === 'assign') Object.assign(returned, alteredFields)
        else
          for (const [key, value] of Object.entries(alteredFields))
            Object.defineProperty(returned, key, {
              value,
              enumerable: true,
              configurable: true,
              writable: true,
            })
      } catch (error) {
        expect(error).toBeInstanceOf(TypeError)
        mutationBlocked = true
      }
      if (mutationBlocked) expect(returned).toEqual(original)
      const altered = { ...returned, ...alteredFields, deliveryToken: original.deliveryToken }
      expect(cold.coordinator.isAbsentMembership(state, newer, [altered])).toBe(false)
      expect(cold.coordinator.isAbsentMembership(state, owner(), [original])).toBe(true)
      await expect(
        run(
          cold.coordinator.prepareRecoveryCacheEffect({
            snapshotId: 'mutated-returned-membership',
            hash: hash('[]'),
            savedAt: 300,
            projectionAdmissions: [],
            membershipAdmissions: [altered],
          }),
        ),
      ).rejects.toThrow()
      expect((await run(cold.store.readTransport(transportId))).records).toEqual(state.records)
      expect(state.historyAcks).toEqual([])
      expect(await readFile(f.cachePath, 'utf8')).toBe('[]')
      expect(state.records.slice(0, beforeAttestation.records.length)).toEqual(
        beforeAttestation.records,
      )
    },
  )

  it('cannot suppress a newer native owner generation using an older deleted-owner membership', async () => {
    const f = await fixture()
    await emit(f)
    await prepareMembership(f, '[]', [admission(f)])
    const newer: NativeRecoveryOwner = {
      ...owner(),
      generation: 5,
      snapshotToken: 'new-generation-token',
      localTurn: 9,
    }
    await run(f.store.updateTransport(transportId, { owners: [newer] }))
    f.coordinator.seed(await run(f.store.readTransport(transportId)))
    await writeFile(f.cachePath, '[]')
    const cold = await reopen(f)
    const attested = await run(
      cold.coordinator.attestRecoveryCacheEffect({ hash: hash(await readFile(f.cachePath)) }),
    )
    const state = await run(cold.store.readTransport(transportId))
    expect(cold.coordinator.isAbsentMembership(state, owner(), attested.membershipAdmissions)).toBe(
      true,
    )
    expect(cold.coordinator.isAbsentMembership(state, newer, attested.membershipAdmissions)).toBe(
      false,
    )
    const forged = attested.membershipAdmissions!.map((entry) => ({
      ...entry,
      ownerGeneration: 5,
      snapshotToken: newer.snapshotToken!,
    }))
    expect(cold.coordinator.isAbsentMembership(state, newer, forged)).toBe(false)
    await expect(
      run(
        cold.coordinator.prepareRecoveryCacheEffect({
          snapshotId: 'wrong-generation-absence-cache',
          hash: hash('[]'),
          savedAt: 300,
          projectionAdmissions: [],
          membershipAdmissions: forged,
        }),
      ),
    ).rejects.toThrow()
    expect((await run(cold.store.readTransport(transportId))).records).toEqual(state.records)
    expect(state.historyAcks).toEqual([])
  })

  it.each([300, undefined])(
    'retains absence-only claims but no clock when same-hash clocks conflict with %s',
    async (secondClock) => {
      const f = await fixture()
      await emit(f)
      await prepareMembership(f, '[]', [admission(f)])
      await prepareStoredClock(f, hash('[]'), 'conflicting-absence-clock', secondClock, true)
      await writeFile(f.cachePath, '[]')
      const cold = await reopen(f)
      const attested = await run(
        cold.coordinator.attestRecoveryCacheEffect({ hash: hash(await readFile(f.cachePath)) }),
      )
      expect(attested.projectionAdmissions).toEqual([])
      expect(attested.membershipAdmissions).toMatchObject([
        { sessionId, transportId, appliedRevision: 1 },
      ])
      expect(Object.hasOwn(attested, 'savedAt')).toBe(false)
      const state = await run(cold.store.readTransport(transportId))
      expect(
        cold.coordinator.isAbsentMembership(state, owner(), attested.membershipAdmissions),
      ).toBe(true)
      expect(
        cold.coordinator.acceptedCursor(
          state,
          consumer(1, undefined, attested.membershipAdmissions),
        ),
      ).toBeUndefined()
      expect(state.historyAcks).toEqual([])
    },
  )
})

function owner(): NativeRecoveryOwner {
  return {
    ownerId: sessionId,
    sessionId,
    generation: 4,
    localTurn: 8,
    snapshotToken: 'original-main-cache-token',
    kind: 'root',
    workspace: '/project',
    writableRoot: '/project',
    nativeThreadId: 'original-main-cache-native-thread',
    state: 'active',
    input: {
      sessionId,
      provider: 'codex',
      remoteId: 'original-main-cache-native-thread',
      prompt: exact,
      mode: 'read-only',
      workspace: '/project',
    },
  }
}

function descriptor(): NativeRecoveryTransport {
  return {
    id: transportId,
    brokerId: 'original-main-cache-broker',
    brokerRoot: '/home/fixture/.life/agent-sessions/original-main-cache-broker',
    launchCommand: 'exec codex app-server',
    provider: 'codex',
    providerVersion: '0.162.1',
    nativeProtocol: 'codex-app-server-jsonrpc',
    brokerProtocolVersion: 2,
    machine: { profileId: 'profile', host: 'host', username: 'user', port: 22 },
    controller: { id: 'original-controller', epoch: 1 },
    initialization: { status: 'complete' },
    owners: [owner()],
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
  ledgerDirectory: string
  historyDirectory: string
  cachePath: string
  store: NativeRecoveryStoreHandle
  coordinator: NativeAgentRecovery
  published: AgentEvent[]
  nextWire: number
}

async function fixture(): Promise<Fixture> {
  const directory = await mkdtemp(join(tmpdir(), 'life-native-main-cache-'))
  directories.push(directory)
  const ledgerDirectory = join(directory, 'ledger')
  const store = await startStore(ledgerDirectory)
  const snapshot = await run(store.createTransport(descriptor()))
  const published: AgentEvent[] = []
  const coordinator = new NativeAgentRecovery(store, (event) => published.push(event))
  coordinator.seed(snapshot)
  return {
    ledgerDirectory,
    historyDirectory: join(directory, 'native-history'),
    cachePath: join(directory, 'browser-main-cache.json'),
    store,
    coordinator,
    published,
    nextWire: 0,
  }
}

async function emit(f: Fixture, replay = false) {
  const sequence = ++f.nextWire
  f.coordinator.beginWire(transportId, sequence, 0, replay)
  try {
    f.coordinator.event(
      transportId,
      { sessionId, type: 'text', itemId: `message-${sequence}`, text: `${exact}${sequence}` },
      owner(),
    )
  } finally {
    f.coordinator.endWire(transportId)
  }
  await run(f.coordinator.flushEffect())
}

function admission(f: Fixture, forSession = sessionId): ConversationProjectionAdmission {
  const event = f.published
    .slice()
    .reverse()
    .find((event) => event.sessionId === forSession)
  const native = event?.nativeRecovery
  const deliveryToken: unknown =
    native && Object.getOwnPropertyDescriptor(native, 'deliveryToken')?.value
  if (!native?.snapshotToken || typeof deliveryToken !== 'string')
    throw new Error('Cache preparation requires an actual delivered event capability')
  return {
    sessionId: event!.sessionId,
    transportId: native.transportId,
    appliedRevision: native.revision,
    snapshotToken: native.snapshotToken,
    ownerGeneration: native.ownerGeneration ?? 0,
    deliveryToken,
  }
}

function cacheBytes(appliedRevision = 1, title = 'Original cached title') {
  return JSON.stringify([
    {
      id: sessionId,
      provider: 'codex',
      profileId: 'profile',
      workspace: '/project',
      workspaceUnknown: false,
      remoteId: 'original-main-cache-native-thread',
      nativeRecovery: {
        [transportId]: {
          appliedRevision,
          snapshotToken: 'original-main-cache-token',
          ownerGeneration: 4,
        },
      },
      messages: [
        { id: 'original-user', role: 'user', text: exact },
        ...Array.from({ length: appliedRevision }, (_, index) => ({
          id: `message-${index + 1}`,
          role: 'assistant',
          text: `${exact}${index + 1}`,
        })),
      ],
      future: { original: [null, false, exact], unknownProviderState: null, title },
    },
    {
      id: 'archived',
      profileId: 'profile',
      provider: 'codex',
      messages: [null, 17, { opaque: exact }],
      future: [false, exact],
    },
  ])
}

function secondOwner(): NativeRecoveryOwner {
  const original = owner()
  return {
    ...original,
    ownerId: secondSessionId,
    sessionId: secondSessionId,
    snapshotToken: 'second-main-cache-token',
    nativeThreadId: 'second-main-cache-native-thread',
    input: {
      ...original.input,
      sessionId: secondSessionId,
      remoteId: 'second-main-cache-native-thread',
    },
  }
}

async function addSecondTransport(f: Fixture) {
  const snapshot = await run(
    f.store.createTransport({
      ...descriptor(),
      id: secondTransportId,
      brokerId: 'second-main-cache-broker',
      brokerRoot: '/home/fixture/.life/agent-sessions/second-main-cache-broker',
      owners: [secondOwner()],
    }),
  )
  f.coordinator.seed(snapshot)
  f.coordinator.beginWire(secondTransportId, 1, 0)
  try {
    f.coordinator.event(
      secondTransportId,
      {
        sessionId: secondSessionId,
        type: 'text',
        itemId: 'second-message-1',
        text: `${exact}second`,
      },
      secondOwner(),
    )
  } finally {
    f.coordinator.endWire(secondTransportId)
  }
  await run(f.coordinator.flushEffect())
}

function fullCacheBytes(title = 'Original cached title') {
  const history = JSON.parse(cacheBytes(1, title))
  return JSON.stringify([
    ...history,
    {
      ...history[0],
      id: secondSessionId,
      remoteId: 'second-main-cache-native-thread',
      nativeRecovery: {
        [secondTransportId]: {
          appliedRevision: 1,
          snapshotToken: 'second-main-cache-token',
          ownerGeneration: 4,
        },
      },
      messages: [
        { id: 'second-user', role: 'user', text: exact },
        { id: 'second-message-1', role: 'assistant', text: `${exact}second` },
      ],
    },
  ])
}

function consumer(
  appliedRevision = 1,
  cacheHash?: string,
  projectionAdmissions?: readonly ConversationProjectionAdmission[],
): NativeRecoveryConsumer {
  return {
    kind: 'main',
    sessionId,
    profileId: 'profile',
    workspace: '/project',
    remoteId: 'original-main-cache-native-thread',
    applied: {
      [transportId]: {
        appliedRevision,
        snapshotToken: 'original-main-cache-token',
        ownerGeneration: 4,
      },
    },
    ...(cacheHash ? { cacheHash } : {}),
    ...(projectionAdmissions ? { projectionAdmissions } : {}),
  }
}

function secondConsumer(
  fileHash: string,
  caps: readonly ConversationProjectionAdmission[],
): NativeRecoveryConsumer {
  return {
    ...consumer(1, fileHash, caps),
    sessionId: secondSessionId,
    remoteId: 'second-main-cache-native-thread',
    applied: {
      [secondTransportId]: {
        appliedRevision: 1,
        snapshotToken: 'second-main-cache-token',
        ownerGeneration: 4,
      },
    },
  }
}

function proof(
  fileHash: string,
  appliedRevision = 1,
  snapshotId = 'main-cache-p1',
  savedAt = 100,
): ConversationRecoveryProof {
  return {
    hash: fileHash,
    savedAt,
    receipt: {
      snapshotId,
      owners: [
        {
          sessionId,
          provider: 'codex',
          profileId: 'profile',
          workspace: '/project',
          remoteId: 'original-main-cache-native-thread',
          nativeRecovery: {
            [transportId]: {
              appliedRevision,
              snapshotToken: 'original-main-cache-token',
              ownerGeneration: 4,
            },
          },
        },
      ],
    },
  }
}

function checkpointAck(candidate: ConversationRecoveryProof): ConversationCheckpointAck {
  return {
    savedAt: candidate.savedAt,
    nativeRecovery: copy(candidate.receipt),
    nativeRecoveryHash: candidate.hash,
  }
}

async function prepare(f: Fixture, bytes: string, snapshotId = 'main-cache-p1', savedAt = 100) {
  await run(
    f.coordinator.prepareRecoveryCacheEffect({
      snapshotId,
      hash: hash(bytes),
      savedAt,
      projectionAdmissions: [admission(f)],
    }),
  )
}

async function prepareStoredClock(
  f: Fixture,
  fileHash: string,
  snapshotId: string,
  savedAt?: number,
  absent = false,
) {
  await run(
    f.store.prepareHistory(transportId, {
      location: 'main-cache',
      snapshotId,
      fileHash,
      ...(savedAt === undefined ? {} : { savedAt }),
      owners: [
        {
          consumerId: `main-cache:${sessionId}`,
          sessionId,
          snapshotToken: 'original-main-cache-token',
          ownerGeneration: 4,
          throughEventRevision: 1,
          authority: 'native-delivery',
          ...(absent ? { absent: true as const } : {}),
        },
      ],
    }),
  )
}

async function prepareSecondStoredClock(
  f: Fixture,
  fileHash: string,
  snapshotId: string,
  savedAt?: number,
  options?: { location?: NativeRecoveryHistoryPrepare['location']; consumerId?: string },
) {
  const location = options ? options.location : 'main-cache'
  await run(
    f.store.prepareHistory(secondTransportId, {
      ...(location === undefined ? {} : { location }),
      snapshotId,
      fileHash,
      ...(savedAt === undefined ? {} : { savedAt }),
      owners: [
        {
          consumerId: options?.consumerId ?? `main-cache:${secondSessionId}`,
          sessionId: secondSessionId,
          snapshotToken: 'second-main-cache-token',
          ownerGeneration: 4,
          throughEventRevision: 1,
          authority: 'native-delivery',
        },
      ],
    }),
  )
}

async function reopen(f: Fixture) {
  await run(f.store.closeEffect())
  const store = await startStore(f.ledgerDirectory)
  const published = vi.fn()
  const coordinator = new NativeAgentRecovery(store, published)
  coordinator.seed(await run(store.readTransport(transportId)))
  return { store, coordinator, published }
}

async function prepareMembership(
  f: Fixture,
  bytes: string,
  membershipAdmissions: readonly ConversationProjectionAdmission[],
  savedAt = 200,
  projectionAdmissions: readonly ConversationProjectionAdmission[] = [],
  snapshotId = 'native-owner-absent-cache',
) {
  await run(
    f.coordinator.prepareRecoveryCacheEffect({
      snapshotId,
      hash: hash(bytes),
      savedAt,
      projectionAdmissions,
      membershipAdmissions,
    }),
  )
}

describe('durable main-cache prewrite authority', () => {
  it('recovers the exact successful browser cache after a cold reopen without ever recording an ACK', async () => {
    const f = await fixture()
    await emit(f)
    const delivered = admission(f)
    const bytes = cacheBytes()
    await prepare(f, bytes)
    await writeFile(f.cachePath, bytes)
    const prepared = await run(f.store.readTransport(transportId))
    expect(prepared.historyPrepares).toEqual([
      {
        location: 'main-cache',
        snapshotId: 'main-cache-p1',
        fileHash: hash(bytes),
        savedAt: 100,
        owners: [
          {
            consumerId: `main-cache:${sessionId}`,
            sessionId,
            snapshotToken: 'original-main-cache-token',
            ownerGeneration: 4,
            throughEventRevision: 1,
            authority: 'native-delivery',
          },
        ],
      },
    ])
    expect(prepared.historyAcks).toEqual([])
    const cold = await reopen(f)
    const actualBytes = await readFile(f.cachePath, 'utf8')
    expect(actualBytes).toBe(bytes)
    const attested = await run(
      cold.coordinator.attestRecoveryCacheEffect({ hash: hash(actualBytes) }),
    )
    const caps = attested.projectionAdmissions
    expect(attested.savedAt).toBe(100)
    expect(caps).toEqual([{ ...delivered, deliveryToken: expect.any(String) }])
    expect(caps[0].deliveryToken).not.toBe(delivered.deliveryToken)
    const retained = consumer(1, hash(actualBytes), caps)
    const state = await run(cold.store.readTransport(transportId))
    expect(cold.coordinator.acceptedCursor(state, retained)).toEqual(retained.applied![transportId])
    expect(cold.coordinator.replayEvents(state, [retained])).toEqual([])
    expect(state.records).toEqual(prepared.records)
    expect(state.historyAcks).toEqual([])
    expect(cold.published).not.toHaveBeenCalled()
    expect(actualBytes).not.toContain(delivered.deliveryToken)
    expect(
      await readFile(join(f.ledgerDirectory, `${hash(transportId)}.jsonl`), 'utf8'),
    ).not.toContain(delivered.deliveryToken)
    expect(Array.isArray(JSON.parse(actualBytes))).toBe(true)
    expect(Object.hasOwn(JSON.parse(actualBytes), 'savedAt')).toBe(false)
    expect(JSON.parse(actualBytes)[1]).toEqual(JSON.parse(bytes)[1])
  })

  it('keeps actual P1 bytes and their replay boundary when P2 was prepared but repeated browser writes fail', async () => {
    const f = await fixture()
    await emit(f)
    const p1 = cacheBytes()
    await prepare(f, p1)
    await writeFile(f.cachePath, p1)
    await emit(f)
    const p2 = cacheBytes(2)
    await prepare(f, p2, 'main-cache-p2', 200)
    const browserWrite = vi.fn(() => {
      throw new Error('Browser storage quota exceeded')
    })
    for (let attempt = 0; attempt < 3; attempt++)
      expect(() => browserWrite()).toThrow('Browser storage quota exceeded')
    expect(browserWrite).toHaveBeenCalledTimes(3)
    expect(await readFile(f.cachePath, 'utf8')).toBe(p1)
    const cold = await reopen(f)
    const actualBytes = await readFile(f.cachePath, 'utf8')
    const attested = await run(
      cold.coordinator.attestRecoveryCacheEffect({ hash: hash(actualBytes) }),
    )
    const caps = attested.projectionAdmissions
    expect(attested.savedAt).toBe(100)
    expect(caps).toMatchObject([{ sessionId, transportId, appliedRevision: 1 }])
    const state = await run(cold.store.readTransport(transportId))
    const retained = consumer(1, hash(actualBytes), caps)
    expect(state.eventRevision).toBe(2)
    expect(
      state.historyPrepares.map((entry) => [entry.snapshotId, entry.fileHash, entry.savedAt]),
    ).toEqual([
      ['main-cache-p1', hash(p1), 100],
      ['main-cache-p2', hash(p2), 200],
    ])
    expect(cold.coordinator.acceptedCursor(state, retained)?.appliedRevision).toBe(1)
    expect(cold.coordinator.replayEvents(state, [retained])).toMatchObject([
      { sessionId, type: 'text', itemId: 'message-2', text: `${exact}2` },
    ])
    expect(state.historyAcks).toEqual([])
    expect(await readFile(f.cachePath, 'utf8')).toBe(p1)
    expect(cold.published).not.toHaveBeenCalled()
  })

  it('does not borrow a genuinely attested P2 cursor to suppress missing output in restored P1 cache bytes', async () => {
    const f = await fixture()
    await emit(f)
    const p1 = cacheBytes(1)
    await prepare(f, p1)
    await writeFile(f.cachePath, p1)
    await emit(f)
    const p2 = cacheBytes(2)
    await prepare(f, p2, 'main-cache-p2', 200)
    await writeFile(f.cachePath, p2)
    const cold = await reopen(f)
    const newer = await run(
      cold.coordinator.attestRecoveryCacheEffect({ hash: hash(await readFile(f.cachePath)) }),
    )
    expect(newer.savedAt).toBe(200)
    expect(newer.projectionAdmissions).toMatchObject([
      { sessionId, transportId, appliedRevision: 2 },
    ])
    const state = await run(cold.store.readTransport(transportId))
    expect(
      cold.coordinator.acceptedCursor(state, consumer(2, hash(p2), newer.projectionAdmissions))
        ?.appliedRevision,
    ).toBe(2)
    await writeFile(f.cachePath, p1)
    const actualBytes = await readFile(f.cachePath, 'utf8')
    const older = await run(cold.coordinator.attestRecoveryCacheEffect({ hash: hash(actualBytes) }))
    expect(actualBytes).toBe(p1)
    expect(older.savedAt).toBe(100)
    expect(older.projectionAdmissions).toMatchObject([
      { sessionId, transportId, appliedRevision: 1 },
    ])
    const mixed = consumer(2, hash(actualBytes), newer.projectionAdmissions)
    expect(cold.coordinator.acceptedCursor(state, mixed)).toBeUndefined()
    expect(cold.coordinator.validateConsumerBaseline(state, mixed)).toBe(false)
    expect(cold.coordinator.replayEvents(state, [mixed])).toEqual([])
    const actual = consumer(1, hash(actualBytes), older.projectionAdmissions)
    expect(cold.coordinator.acceptedCursor(state, actual)?.appliedRevision).toBe(1)
    expect(cold.coordinator.replayEvents(state, [actual])).toMatchObject([
      { sessionId, type: 'text', itemId: 'message-2', text: `${exact}2` },
    ])
    expect((await run(cold.store.readTransport(transportId))).records).toEqual(state.records)
    expect(state.events).toHaveLength(2)
    expect(state.historyAcks).toEqual([])
    expect(await readFile(f.cachePath, 'utf8')).toBe(p1)
    expect(cold.published).not.toHaveBeenCalled()
  })

  it('recovers the newer exact cache clock when body hashes change at the same native high-water mark', async () => {
    const f = await fixture()
    await emit(f)
    const p1 = cacheBytes(1)
    await prepare(f, p1)
    await writeFile(f.cachePath, p1)
    const p2 = cacheBytes(1, 'Changed locally saved title')
    await prepare(f, p2, 'main-cache-p2', 200)
    await writeFile(f.cachePath, p2)
    expect(hash(p2)).not.toBe(hash(p1))
    const cold = await reopen(f)
    const actualBytes = await readFile(f.cachePath, 'utf8')
    const newer = await run(cold.coordinator.attestRecoveryCacheEffect({ hash: hash(actualBytes) }))
    expect(newer.savedAt).toBe(200)
    expect(newer.projectionAdmissions).toMatchObject([
      { sessionId, transportId, appliedRevision: 1 },
    ])
    const older = await run(cold.coordinator.attestRecoveryCacheEffect({ hash: hash(p1) }))
    expect(older.savedAt).toBe(100)
    expect(older.projectionAdmissions).toMatchObject([
      {
        sessionId,
        transportId,
        appliedRevision: 1,
        snapshotToken: 'original-main-cache-token',
        ownerGeneration: 4,
        deliveryToken: expect.any(String),
      },
    ])
    const state = await run(cold.store.readTransport(transportId))
    expect(state.eventRevision).toBe(1)
    expect(state.historyPrepares.map((entry) => [entry.fileHash, entry.savedAt])).toEqual([
      [hash(p1), 100],
      [hash(p2), 200],
    ])
    expect(state.historyAcks).toEqual([])
    expect(actualBytes).toBe(p2)
    expect(cold.published).not.toHaveBeenCalled()
  })

  it.each([
    { name: 'missing', clock: undefined },
    { name: 'text', clock: '100' },
    { name: 'null', clock: null },
    { name: 'negative', clock: -1 },
    { name: 'fractional', clock: 100.25 },
    { name: 'unsafe', clock: Number.MAX_SAFE_INTEGER + 1 },
    { name: 'NaN', clock: Number.NaN },
    { name: 'infinite', clock: Number.POSITIVE_INFINITY },
  ])('rejects a $name cache clock before writing any private preparation', async ({ clock }) => {
    const f = await fixture()
    await emit(f)
    const before = await run(f.store.readTransport(transportId))
    await expect(
      run(
        f.coordinator.prepareRecoveryCacheEffect({
          snapshotId: 'invalid-clock-cache',
          hash: hash(cacheBytes()),
          savedAt: clock as unknown as number,
          projectionAdmissions: [admission(f)],
        }),
      ),
    ).rejects.toThrow()
    const after = await run(f.store.readTransport(transportId))
    expect(after.records).toEqual(before.records)
    expect(after.historyPrepares).toEqual([])
    expect(after.historyAcks).toEqual([])
    await expect(readFile(f.cachePath)).rejects.toMatchObject({ code: 'ENOENT' })
  })

  it.each([0, Number.MAX_SAFE_INTEGER])(
    'retains the exact safe canonical cache clock %s',
    async (savedAt) => {
      const f = await fixture()
      await emit(f)
      const bytes = cacheBytes(1)
      await prepare(f, bytes, 'safe-clock-cache', savedAt)
      await writeFile(f.cachePath, bytes)
      const cold = await reopen(f)
      const attested = await run(
        cold.coordinator.attestRecoveryCacheEffect({ hash: hash(await readFile(f.cachePath)) }),
      )
      expect(attested.savedAt).toBe(savedAt)
      expect(attested.projectionAdmissions).toMatchObject([
        { sessionId, transportId, appliedRevision: 1 },
      ])
      expect((await run(cold.store.readTransport(transportId))).historyAcks).toEqual([])
    },
  )

  it('retains exact projection claims without selecting a maximum conflicting clock for one hash', async () => {
    const f = await fixture()
    await emit(f)
    const bytes = cacheBytes()
    await prepareStoredClock(f, hash(bytes), 'clock-p1', 100)
    await prepareStoredClock(f, hash(bytes), 'clock-p2', 200)
    const validBytes = cacheBytes(1, 'Valid title after clock conflict')
    await prepareStoredClock(f, hash(validBytes), 'unambiguous-clock', 300)
    await writeFile(f.cachePath, bytes)
    const cold = await reopen(f)
    const before = await run(cold.store.readTransport(transportId))
    const attested = await run(
      cold.coordinator.attestRecoveryCacheEffect({ hash: hash(await readFile(f.cachePath)) }),
    )
    expect(attested.projectionAdmissions).toEqual([
      { ...admission(f), deliveryToken: expect.any(String) },
    ])
    expect(Object.hasOwn(attested, 'savedAt')).toBe(false)
    expect(
      cold.coordinator.acceptedCursor(
        before,
        consumer(1, hash(bytes), attested.projectionAdmissions),
      )?.appliedRevision,
    ).toBe(1)
    expect((await run(cold.store.readTransport(transportId))).records).toEqual(before.records)
    expect(
      before.historyPrepares
        .filter((entry) => entry.fileHash === hash(bytes))
        .map((entry) => entry.savedAt),
    ).toEqual([100, 200])
    expect(before.historyAcks).toEqual([])
    expect(cold.published).not.toHaveBeenCalled()
    expect(await readFile(f.cachePath, 'utf8')).toBe(bytes)
    await writeFile(f.cachePath, validBytes)
    const renewed = await run(
      cold.coordinator.attestRecoveryCacheEffect({ hash: hash(await readFile(f.cachePath)) }),
    )
    expect(renewed.savedAt).toBe(300)
    expect(renewed.projectionAdmissions).toMatchObject([
      { sessionId, transportId, appliedRevision: 1 },
    ])
    expect(
      cold.coordinator.acceptedCursor(
        before,
        consumer(1, hash(validBytes), renewed.projectionAdmissions),
      )?.appliedRevision,
    ).toBe(1)
    expect((await run(cold.store.readTransport(transportId))).records).toEqual(before.records)
  })

  it('admits matching legacy preparations with no cache clock while leaving savedAt unknown', async () => {
    const f = await fixture()
    await emit(f)
    const original = admission(f)
    const bytes = cacheBytes()
    await prepareStoredClock(f, hash(bytes), 'legacy-clock-p1')
    await prepareStoredClock(f, hash(bytes), 'legacy-clock-p2')
    await writeFile(f.cachePath, bytes)
    const cold = await reopen(f)
    const before = await run(cold.store.readTransport(transportId))
    const attested = await run(
      cold.coordinator.attestRecoveryCacheEffect({ hash: hash(await readFile(f.cachePath)) }),
    )
    expect(attested).toEqual({
      projectionAdmissions: [{ ...original, deliveryToken: expect.any(String) }],
    })
    expect(Object.hasOwn(attested, 'savedAt')).toBe(false)
    expect(
      cold.coordinator.acceptedCursor(
        before,
        consumer(1, hash(bytes), attested.projectionAdmissions),
      )?.appliedRevision,
    ).toBe(1)
    expect((await run(cold.store.readTransport(transportId))).records).toEqual(before.records)
    expect(before.historyPrepares.map((entry) => entry.savedAt)).toEqual([undefined, undefined])
    expect(before.historyAcks).toEqual([])
    expect(cold.published).not.toHaveBeenCalled()
  })

  it('retains exact projection claims without inventing a clock from mixed legacy and known preparations', async () => {
    const f = await fixture()
    await emit(f)
    const bytes = cacheBytes()
    await prepareStoredClock(f, hash(bytes), 'legacy-clock')
    await prepareStoredClock(f, hash(bytes), 'known-clock', 100)
    const validBytes = cacheBytes(1, 'Valid title after legacy clock conflict')
    await prepareStoredClock(f, hash(validBytes), 'unambiguous-clock', 200)
    await writeFile(f.cachePath, bytes)
    const cold = await reopen(f)
    const before = await run(cold.store.readTransport(transportId))
    const attested = await run(
      cold.coordinator.attestRecoveryCacheEffect({ hash: hash(await readFile(f.cachePath)) }),
    )
    expect(attested.projectionAdmissions).toEqual([
      { ...admission(f), deliveryToken: expect.any(String) },
    ])
    expect(Object.hasOwn(attested, 'savedAt')).toBe(false)
    expect(
      cold.coordinator.acceptedCursor(
        before,
        consumer(1, hash(bytes), attested.projectionAdmissions),
      )?.appliedRevision,
    ).toBe(1)
    expect((await run(cold.store.readTransport(transportId))).records).toEqual(before.records)
    expect(
      before.historyPrepares
        .filter((entry) => entry.fileHash === hash(bytes))
        .map((entry) => entry.savedAt),
    ).toEqual([undefined, 100])
    expect(before.historyAcks).toEqual([])
    expect(cold.published).not.toHaveBeenCalled()
    await writeFile(f.cachePath, validBytes)
    const renewed = await run(
      cold.coordinator.attestRecoveryCacheEffect({ hash: hash(await readFile(f.cachePath)) }),
    )
    expect(renewed.savedAt).toBe(200)
    expect(renewed.projectionAdmissions).toMatchObject([
      { sessionId, transportId, appliedRevision: 1 },
    ])
    expect(
      cold.coordinator.acceptedCursor(
        before,
        consumer(1, hash(validBytes), renewed.projectionAdmissions),
      )?.appliedRevision,
    ).toBe(1)
    expect((await run(cold.store.readTransport(transportId))).records).toEqual(before.records)
  })

  it('admits both exact transport owners for the same full-cache bytes and one shared checkpoint clock', async () => {
    const f = await fixture()
    await emit(f)
    await addSecondTransport(f)
    const bytes = fullCacheBytes()
    const originalAdmissions = [admission(f), admission(f, secondSessionId)]
    await run(
      f.coordinator.prepareRecoveryCacheEffect({
        snapshotId: 'shared-cache-clock',
        hash: hash(bytes),
        savedAt: 100,
        projectionAdmissions: originalAdmissions,
      }),
    )
    await writeFile(f.cachePath, bytes)
    const cold = await reopen(f)
    const firstState = await run(cold.store.readTransport(transportId))
    const secondState = await run(cold.store.readTransport(secondTransportId))
    const attested = await run(
      cold.coordinator.attestRecoveryCacheEffect({ hash: hash(await readFile(f.cachePath)) }),
    )
    expect(attested.savedAt).toBe(100)
    expect(attested.projectionAdmissions).toHaveLength(2)
    expect(attested.projectionAdmissions).toEqual(
      expect.arrayContaining(
        originalAdmissions.map((entry) => ({ ...entry, deliveryToken: expect.any(String) })),
      ),
    )
    expect(
      cold.coordinator.acceptedCursor(
        firstState,
        consumer(1, hash(bytes), attested.projectionAdmissions),
      )?.appliedRevision,
    ).toBe(1)
    expect(
      cold.coordinator.acceptedCursor(
        secondState,
        secondConsumer(hash(bytes), attested.projectionAdmissions),
      )?.appliedRevision,
    ).toBe(1)
    for (const [id, original, state] of [
      [transportId, owner(), firstState],
      [secondTransportId, secondOwner(), secondState],
    ] as const) {
      expect(state.historyPrepares).toEqual([
        {
          location: 'main-cache',
          snapshotId: 'shared-cache-clock',
          fileHash: hash(bytes),
          savedAt: 100,
          owners: [
            {
              consumerId: `main-cache:${original.sessionId}`,
              sessionId: original.sessionId,
              snapshotToken: original.snapshotToken,
              ownerGeneration: 4,
              throughEventRevision: 1,
              authority: 'native-delivery',
            },
          ],
        },
      ])
      expect((await run(cold.store.readTransport(id))).records).toEqual(state.records)
      expect(state.historyAcks).toEqual([])
    }
    expect(Array.isArray(JSON.parse(bytes))).toBe(true)
    expect(Object.hasOwn(JSON.parse(bytes), 'savedAt')).toBe(false)
    expect(cold.published).not.toHaveBeenCalled()
    expect(await readFile(f.cachePath, 'utf8')).toBe(bytes)
  })

  it.each([
    { name: 'conflicting known', secondClock: 200 },
    { name: 'known and legacy', secondClock: undefined },
  ])(
    'retains both exact owners while omitting $name clocks across eligible transports',
    async ({ secondClock }) => {
      const f = await fixture()
      await emit(f)
      await addSecondTransport(f)
      const bytes = fullCacheBytes()
      await prepareStoredClock(f, hash(bytes), 'first-transport-clock', 100)
      await prepareSecondStoredClock(f, hash(bytes), 'second-transport-clock', secondClock)
      const validBytes = fullCacheBytes('Unambiguous full cache metadata')
      await prepareStoredClock(f, hash(validBytes), 'renewed-shared-clock', 300)
      await prepareSecondStoredClock(f, hash(validBytes), 'renewed-shared-clock', 300)
      await writeFile(f.cachePath, bytes)
      const cold = await reopen(f)
      const firstState = await run(cold.store.readTransport(transportId))
      const secondState = await run(cold.store.readTransport(secondTransportId))
      const attested = await run(
        cold.coordinator.attestRecoveryCacheEffect({ hash: hash(await readFile(f.cachePath)) }),
      )
      expect(attested.projectionAdmissions).toHaveLength(2)
      expect(Object.hasOwn(attested, 'savedAt')).toBe(false)
      expect(
        cold.coordinator.acceptedCursor(
          firstState,
          consumer(1, hash(bytes), attested.projectionAdmissions),
        )?.appliedRevision,
      ).toBe(1)
      expect(
        cold.coordinator.acceptedCursor(
          secondState,
          secondConsumer(hash(bytes), attested.projectionAdmissions),
        )?.appliedRevision,
      ).toBe(1)
      expect((await run(cold.store.readTransport(transportId))).records).toEqual(firstState.records)
      expect((await run(cold.store.readTransport(secondTransportId))).records).toEqual(
        secondState.records,
      )
      expect(firstState.historyAcks).toEqual([])
      expect(secondState.historyAcks).toEqual([])
      await writeFile(f.cachePath, validBytes)
      const renewed = await run(
        cold.coordinator.attestRecoveryCacheEffect({ hash: hash(await readFile(f.cachePath)) }),
      )
      expect(renewed.savedAt).toBe(300)
      expect(renewed.projectionAdmissions).toHaveLength(2)
      expect(
        cold.coordinator.acceptedCursor(
          firstState,
          consumer(1, hash(validBytes), renewed.projectionAdmissions),
        )?.appliedRevision,
      ).toBe(1)
      expect(
        cold.coordinator.acceptedCursor(
          secondState,
          secondConsumer(hash(validBytes), renewed.projectionAdmissions),
        )?.appliedRevision,
      ).toBe(1)
      expect((await run(cold.store.readTransport(transportId))).records).toEqual(firstState.records)
      expect((await run(cold.store.readTransport(secondTransportId))).records).toEqual(
        secondState.records,
      )
      expect(cold.published).not.toHaveBeenCalled()
    },
  )

  it.each([
    {
      name: 'native-file location',
      location: 'native-file' as const,
      consumerId: `main-cache:${secondSessionId}`,
    },
    {
      name: 'studio-cache location',
      location: 'studio-cache' as const,
      consumerId: `main-cache:${secondSessionId}`,
    },
    {
      name: 'legacy native-file location',
      location: undefined,
      consumerId: `main-cache:${secondSessionId}`,
    },
    {
      name: 'main consumer namespace',
      location: 'main-cache' as const,
      consumerId: `main:${secondSessionId}`,
    },
    {
      name: 'wrong session consumer tuple',
      location: 'main-cache' as const,
      consumerId: 'main-cache:unrelated-session',
    },
  ])(
    'ignores a different clock under $name without poisoning an eligible main-cache owner',
    async ({ location, consumerId }) => {
      const f = await fixture()
      await emit(f)
      await addSecondTransport(f)
      const bytes = fullCacheBytes()
      await prepareStoredClock(f, hash(bytes), 'eligible-main-cache-clock', 100)
      await prepareSecondStoredClock(f, hash(bytes), 'ineligible-other-clock', 900, {
        location,
        consumerId,
      })
      await writeFile(f.cachePath, bytes)
      const cold = await reopen(f)
      const firstState = await run(cold.store.readTransport(transportId))
      const secondState = await run(cold.store.readTransport(secondTransportId))
      const attested = await run(
        cold.coordinator.attestRecoveryCacheEffect({ hash: hash(await readFile(f.cachePath)) }),
      )
      expect(attested.savedAt).toBe(100)
      expect(attested.projectionAdmissions).toEqual([
        { ...admission(f), deliveryToken: expect.any(String) },
      ])
      expect(
        cold.coordinator.acceptedCursor(
          firstState,
          consumer(1, hash(bytes), attested.projectionAdmissions),
        )?.appliedRevision,
      ).toBe(1)
      const secondReply = {
        ...admission(f, secondSessionId),
        deliveryToken: cold.coordinator.getDeliveryToken(secondTransportId, secondOwner())!,
      }
      expect(
        cold.coordinator.acceptedCursor(secondState, secondConsumer(hash(bytes), [secondReply])),
      ).toBeUndefined()
      expect((await run(cold.store.readTransport(transportId))).records).toEqual(firstState.records)
      expect((await run(cold.store.readTransport(secondTransportId))).records).toEqual(
        secondState.records,
      )
      expect(firstState.historyAcks).toEqual([])
      expect(secondState.historyAcks).toEqual([])
      expect(cold.published).not.toHaveBeenCalled()
      expect(await readFile(f.cachePath, 'utf8')).toBe(bytes)
    },
  )

  it('writes the exact cold cache-attested projection through the native history writer without a prior native ACK', async () => {
    const f = await fixture()
    await emit(f)
    const bytes = cacheBytes()
    await prepare(f, bytes)
    await writeFile(f.cachePath, bytes)
    const cold = await reopen(f)
    const attested = await run(
      cold.coordinator.attestRecoveryCacheEffect({ hash: hash(await readFile(f.cachePath)) }),
    )
    const caps = attested.projectionAdmissions
    expect(attested.savedAt).toBe(100)
    const authorize = vi.fn(
      (
        candidate: ConversationRecoveryProof,
        admissions: readonly ConversationProjectionAdmission[],
      ) => cold.coordinator.authorizeRecoveryReceiptEffect(candidate, admissions),
    )
    const engine = new ConversationCheckpointEngine(f.historyDirectory, {
      authorizeRecoveryReceipt: authorize,
    })
    const parsedCache = JSON.parse(await readFile(f.cachePath, 'utf8'))
    const saved = await run(engine.saveEffect(parsedCache, 200, caps))
    const nativeBytes = await readFile(join(f.historyDirectory, 'conversations.json'), 'utf8')
    expect(JSON.parse(nativeBytes)).toEqual({
      version: 1,
      savedAt: 200,
      threads: parsedCache,
    })
    expect(saved.nativeRecoveryHash).toBe(hash(nativeBytes))
    expect(saved.nativeRecoveryHash).not.toBe(hash(bytes))
    expect(saved.nativeRecovery?.owners).toEqual(proof(hash(nativeBytes)).receipt.owners)
    expect(authorize).toHaveBeenCalledTimes(1)
    expect(authorize.mock.calls[0][1]).toEqual(caps)
    const loaded = await run(engine.loadRecoveryReceiptEffect())
    expect(loaded).toEqual({
      hash: hash(nativeBytes),
      savedAt: 200,
      receipt: saved.nativeRecovery,
    })
    const state = await run(cold.store.readTransport(transportId))
    expect(state.historyPrepares).toHaveLength(2)
    expect(state.historyPrepares.at(-1)).toMatchObject({
      snapshotId: saved.nativeRecovery!.snapshotId,
      fileHash: hash(nativeBytes),
      owners: [{ consumerId: `main:${sessionId}`, throughEventRevision: 1 }],
    })
    expect(state.historyPrepares.at(-1)?.location ?? 'native-file').toBe('native-file')
    expect(state.historyAcks).toEqual([])
    expect(cold.published).not.toHaveBeenCalled()
    expect(await readFile(f.cachePath, 'utf8')).toBe(bytes)
    expect(nativeBytes).not.toContain(caps[0].deliveryToken)
    expect(
      await readFile(join(f.historyDirectory, 'conversations.recovery-receipts.json'), 'utf8'),
    ).not.toContain(caps[0].deliveryToken)
    expect(
      await readFile(join(f.ledgerDirectory, `${hash(transportId)}.jsonl`), 'utf8'),
    ).not.toContain(caps[0].deliveryToken)
  })

  it('cannot turn a cache preparation into an ordinary native-file ACK with the same hash and owner metadata', async () => {
    const f = await fixture()
    await emit(f)
    const bytes = cacheBytes()
    await prepare(f, bytes)
    await writeFile(f.cachePath, bytes)
    const cold = await reopen(f)
    await run(cold.coordinator.attestRecoveryCacheEffect({ hash: hash(bytes) }))
    const before = await run(cold.store.readTransport(transportId))
    await expect(
      run(cold.coordinator.acknowledgeMainHistoryEffect(checkpointAck(proof(hash(bytes))))),
    ).rejects.toThrow()
    await expect(
      run(cold.coordinator.acknowledgeRecoveredHistoryProofEffect(proof(hash(bytes)))),
    ).rejects.toThrow()
    const after = await run(cold.store.readTransport(transportId))
    expect(after.records).toEqual(before.records)
    expect(after.historyAcks).toEqual([])
    expect(await readFile(f.cachePath, 'utf8')).toBe(bytes)
    expect(cold.published).not.toHaveBeenCalled()
  })

  it('rejects a native ACK even when a main-cache preparation has an otherwise identical main consumer tuple', async () => {
    const f = await fixture()
    await emit(f)
    const fileHash = hash(cacheBytes())
    await run(
      f.store.prepareHistory(transportId, {
        location: 'main-cache',
        snapshotId: 'main-cache-p1',
        fileHash,
        owners: [
          {
            consumerId: `main:${sessionId}`,
            sessionId,
            snapshotToken: 'original-main-cache-token',
            ownerGeneration: 4,
            throughEventRevision: 1,
            authority: 'native-delivery',
          },
        ],
      }),
    )
    const cold = await reopen(f)
    const before = await run(cold.store.readTransport(transportId))
    await expect(
      run(
        cold.store.acknowledgeHistory(transportId, {
          consumerId: `main:${sessionId}`,
          sessionId,
          snapshotId: 'main-cache-p1',
          fileHash,
          snapshotToken: 'original-main-cache-token',
          ownerGeneration: 4,
          throughEventRevision: 1,
          durability: 'native',
        }),
      ),
    ).rejects.toThrow()
    await expect(
      run(cold.coordinator.acknowledgeMainHistoryEffect(checkpointAck(proof(fileHash)))),
    ).rejects.toThrow()
    const after = await run(cold.store.readTransport(transportId))
    expect(after.records).toEqual(before.records)
    expect(after.historyAcks).toEqual([])
  })

  it('returns no capability for unknown bytes without preparing, acknowledging, publishing, or rewriting cache', async () => {
    const f = await fixture()
    await emit(f)
    const bytes = cacheBytes()
    await prepare(f, bytes)
    await writeFile(f.cachePath, bytes)
    const cold = await reopen(f)
    const prepareHistory = vi.spyOn(cold.store, 'prepareHistory')
    const acknowledgeHistory = vi.spyOn(cold.store, 'acknowledgeHistory')
    const updateTransport = vi.spyOn(cold.store, 'updateTransport')
    const before = await run(cold.store.readTransport(transportId))
    await expect(
      run(cold.coordinator.attestRecoveryCacheEffect({ hash: hash('unprepared browser bytes') })),
    ).resolves.toEqual({ projectionAdmissions: [] })
    const after = await run(cold.store.readTransport(transportId))
    expect(after.records).toEqual(before.records)
    expect(after.historyAcks).toEqual([])
    expect(prepareHistory).not.toHaveBeenCalled()
    expect(acknowledgeHistory).not.toHaveBeenCalled()
    expect(updateTransport).not.toHaveBeenCalled()
    expect(cold.published).not.toHaveBeenCalled()
    expect(await readFile(f.cachePath, 'utf8')).toBe(bytes)
  })

  it('does not treat an ordinary native-file preparation as browser cache proof', async () => {
    const f = await fixture()
    await emit(f)
    const bytes = cacheBytes()
    await run(f.coordinator.authorizeRecoveryReceiptEffect(proof(hash(bytes)), [admission(f)]))
    const cold = await reopen(f)
    const before = await run(cold.store.readTransport(transportId))
    await expect(
      run(cold.coordinator.attestRecoveryCacheEffect({ hash: hash(bytes) })),
    ).resolves.toEqual({ projectionAdmissions: [] })
    expect((await run(cold.store.readTransport(transportId))).records).toEqual(before.records)
    expect(cold.published).not.toHaveBeenCalled()
  })

  it('refuses a cold owner-reply token until actual hash-selected cache attestation grants its baseline', async () => {
    const f = await fixture()
    await emit(f)
    const bytes = cacheBytes()
    await prepare(f, bytes)
    await writeFile(f.cachePath, bytes)
    const cold = await reopen(f)
    const imported = {
      ...admission(f),
      deliveryToken: cold.coordinator.getDeliveryToken(transportId, owner())!,
    }
    const before = await run(cold.store.readTransport(transportId))
    expect(
      cold.coordinator.acceptedCursor(before, consumer(1, hash(bytes), [imported])),
    ).toBeUndefined()
    await expect(
      run(
        cold.coordinator.prepareRecoveryCacheEffect({
          snapshotId: 'unproven-changed-cache',
          hash: hash(cacheBytes(1, 'Changed local cache metadata')),
          savedAt: 200,
          projectionAdmissions: [imported],
        }),
      ),
    ).rejects.toThrow()
    expect((await run(cold.store.readTransport(transportId))).records).toEqual(before.records)
    const attested = await run(
      cold.coordinator.attestRecoveryCacheEffect({ hash: hash(await readFile(f.cachePath)) }),
    )
    const caps = attested.projectionAdmissions
    expect(attested.savedAt).toBe(100)
    expect(
      cold.coordinator.acceptedCursor(before, consumer(1, hash(bytes), caps))?.appliedRevision,
    ).toBe(1)
    await expect(
      run(
        cold.coordinator.prepareRecoveryCacheEffect({
          snapshotId: 'attested-changed-cache',
          hash: hash(cacheBytes(1, 'Changed local cache metadata')),
          savedAt: 200,
          projectionAdmissions: caps,
        }),
      ),
    ).resolves.toBeUndefined()
    const after = await run(cold.store.readTransport(transportId))
    expect(after.historyPrepares).toHaveLength(2)
    expect(after.historyAcks).toEqual([])
    expect(await readFile(f.cachePath, 'utf8')).toBe(bytes)
  })

  it.each([
    {
      name: 'wrong delivery token',
      change: (value: ConversationProjectionAdmission) => [
        { ...value, deliveryToken: 'copied-token' },
      ],
    },
    {
      name: 'wrong owner token',
      change: (value: ConversationProjectionAdmission) => [
        { ...value, snapshotToken: 'copied-owner-token' },
      ],
    },
    {
      name: 'wrong owner generation',
      change: (value: ConversationProjectionAdmission) => [{ ...value, ownerGeneration: 5 }],
    },
    {
      name: 'wrong owner session',
      change: (value: ConversationProjectionAdmission) => [
        { ...value, sessionId: 'imported-session' },
      ],
    },
    {
      name: 'wrong transport',
      change: (value: ConversationProjectionAdmission) => [
        { ...value, transportId: 'imported-transport' },
      ],
    },
    {
      name: 'undelivered future cursor',
      change: (value: ConversationProjectionAdmission) => [{ ...value, appliedRevision: 2 }],
    },
  ])('aborts browser prewrite on $name without native journal changes', async ({ change }) => {
    const f = await fixture()
    await emit(f)
    const before = await run(f.store.readTransport(transportId))
    await expect(
      run(
        f.coordinator.prepareRecoveryCacheEffect({
          snapshotId: 'invalid-cache-prewrite',
          hash: hash(cacheBytes()),
          savedAt: 100,
          projectionAdmissions: change(admission(f)),
        }),
      ),
    ).rejects.toThrow()
    const after = await run(f.store.readTransport(transportId))
    expect(after.records).toEqual(before.records)
    expect(after.historyPrepares).toEqual([])
    expect(after.historyAcks).toEqual([])
    await expect(readFile(f.cachePath)).rejects.toMatchObject({ code: 'ENOENT' })
  })

  it('rejects a revoked previously delivered cache admission before granting any prewrite', async () => {
    const f = await fixture()
    await emit(f)
    const stale = admission(f)
    f.coordinator.revokeDeliveryTokens()
    const before = await run(f.store.readTransport(transportId))
    await expect(
      run(
        f.coordinator.prepareRecoveryCacheEffect({
          snapshotId: 'revoked-cache-prewrite',
          hash: hash(cacheBytes()),
          savedAt: 100,
          projectionAdmissions: [stale],
        }),
      ),
    ).rejects.toThrow()
    expect((await run(f.store.readTransport(transportId))).records).toEqual(before.records)
    await expect(readFile(f.cachePath)).rejects.toMatchObject({ code: 'ENOENT' })
  })

  it('validates an invalid later cache claim before preparing an earlier genuine claim', async () => {
    const f = await fixture()
    await emit(f)
    const genuine = admission(f)
    const before = await run(f.store.readTransport(transportId))
    await expect(
      run(
        f.coordinator.prepareRecoveryCacheEffect({
          snapshotId: 'mixed-valid-invalid-cache-prewrite',
          hash: hash(cacheBytes()),
          savedAt: 100,
          projectionAdmissions: [genuine, { ...genuine, appliedRevision: 2 }],
        }),
      ),
    ).rejects.toThrow()
    const after = await run(f.store.readTransport(transportId))
    expect(after.records).toEqual(before.records)
    expect(after.historyPrepares).toEqual([])
    expect(after.historyAcks).toEqual([])
  })

  it('does not accept copied, revoked, or outpaced cursor headers beside a genuinely attested cache', async () => {
    const f = await fixture()
    await emit(f)
    const bytes = cacheBytes()
    await prepare(f, bytes)
    await writeFile(f.cachePath, bytes)
    const cold = await reopen(f)
    const attested = await run(
      cold.coordinator.attestRecoveryCacheEffect({ hash: hash(await readFile(f.cachePath)) }),
    )
    const caps = attested.projectionAdmissions
    expect(attested.savedAt).toBe(100)
    const state = await run(cold.store.readTransport(transportId))
    expect(cold.coordinator.acceptedCursor(state, consumer(1, hash(bytes)))).toBeUndefined()
    const copied = [{ ...caps[0], deliveryToken: 'copied-cache-capability' }]
    expect(cold.coordinator.acceptedCursor(state, consumer(1, hash(bytes), copied))).toBeUndefined()
    expect(cold.coordinator.acceptedCursor(state, consumer(2, hash(bytes), caps))).toBeUndefined()
    await expect(
      run(cold.coordinator.authorizeRecoveryReceiptEffect(proof(hash(bytes), 2), caps)),
    ).resolves.toBeNull()
    cold.coordinator.revokeDeliveryTokens()
    expect(cold.coordinator.acceptedCursor(state, consumer(1, hash(bytes), caps))).toBeUndefined()
    await expect(
      run(cold.coordinator.authorizeRecoveryReceiptEffect(proof(hash(bytes)), caps)),
    ).resolves.toBeNull()
    expect((await run(cold.store.readTransport(transportId))).records).toEqual(state.records)
    const renewedAttestation = await run(
      cold.coordinator.attestRecoveryCacheEffect({ hash: hash(bytes) }),
    )
    const renewed = renewedAttestation.projectionAdmissions
    expect(renewedAttestation.savedAt).toBe(100)
    expect(renewed[0].deliveryToken).not.toBe(caps[0].deliveryToken)
    expect(
      cold.coordinator.acceptedCursor(state, consumer(1, hash(bytes), renewed))?.appliedRevision,
    ).toBe(1)
    expect((await run(cold.store.readTransport(transportId))).historyAcks).toEqual([])
  })

  it('permits an ordinary unowned browser cache write without granting recovery authority', async () => {
    const f = await fixture()
    await emit(f)
    const bytes = cacheBytes()
    const before = await run(f.store.readTransport(transportId))
    await expect(
      run(
        f.coordinator.prepareRecoveryCacheEffect({
          snapshotId: 'unowned-cache-prewrite',
          hash: hash(bytes),
          savedAt: 100,
          projectionAdmissions: [],
        }),
      ),
    ).resolves.toBeUndefined()
    await writeFile(f.cachePath, bytes)
    await expect(
      run(f.coordinator.attestRecoveryCacheEffect({ hash: hash(await readFile(f.cachePath)) })),
    ).resolves.toEqual({ projectionAdmissions: [] })
    const after = await run(f.store.readTransport(transportId))
    expect(after.records).toEqual(before.records)
    expect(after.historyPrepares).toEqual([])
    expect(after.historyAcks).toEqual([])
    expect(f.coordinator.acceptedCursor(after, consumer(1, hash(bytes), []))).toBeUndefined()
  })

  it('does not prepare committed-but-unpublished output using a freshly allocated owner header', async () => {
    const f = await fixture()
    await emit(f, true)
    expect(f.published).toEqual([])
    const original = owner()
    const ownerReply: ConversationProjectionAdmission = {
      sessionId,
      transportId,
      appliedRevision: 1,
      snapshotToken: original.snapshotToken!,
      ownerGeneration: original.generation ?? 0,
      deliveryToken: f.coordinator.getDeliveryToken(transportId, original)!,
    }
    const before = await run(f.store.readTransport(transportId))
    await expect(
      run(
        f.coordinator.prepareRecoveryCacheEffect({
          snapshotId: 'unpublished-cache-prewrite',
          hash: hash(cacheBytes()),
          savedAt: 100,
          projectionAdmissions: [ownerReply],
        }),
      ),
    ).rejects.toThrow()
    expect((await run(f.store.readTransport(transportId))).records).toEqual(before.records)
    expect(before.events).toHaveLength(1)
    expect(before.historyPrepares).toEqual([])
    expect(before.historyAcks).toEqual([])
  })
})
