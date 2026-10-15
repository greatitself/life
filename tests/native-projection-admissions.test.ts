import { afterEach, describe, expect, it, vi } from 'vitest'
import { createHash } from 'node:crypto'
import type { AgentEvent } from '../src/shared/types'
import {
  CONVERSATION_CHECKPOINT_BASE_CHANGED,
  type ConversationCheckpointInput,
  type ConversationProjectionAdmission,
} from '../src/shared/conversations'
import type { Thread } from '../src/renderer/state'
import {
  admitAgentEvents,
  applyEvent,
  applyNativeRecoveryOwner,
  finishThreadTurn,
  readThreads,
  resolveAgentRequest,
} from '../src/renderer/state'
import {
  carryNativeProjectionAdmissions,
  carryNativeProjectionAuthoredTransition,
  carryNativeProjectionOwnerSnapshot,
  carryNativeProjectionMembership,
  hasNativeProjectionCursor,
  nativeProjectionAdmissions,
  nativeProjectionMembershipAdmissions,
  nativeProjectionRecoveryCacheHash,
  registerNativeProjectionBaseline,
  registerNativeProjectionCacheBaseline,
  registerNativeProjectionCacheMembership,
  registerNativeProjectionDelivery,
  registerNativeProjectionLoadedBaseline,
  registerNativeProjectionMainCacheBaseline,
} from '../src/renderer/native-projection-admissions'
import {
  ConversationCheckpointClient,
  createHistorySnapshotProjector,
} from '../src/renderer/conversation-checkpoint-client'
import {
  acknowledgeConversationSources,
  clearConversationSourceMessages,
  projectConversationSource,
  refreshConversationSources,
} from '../src/renderer/conversation-source'
import {
  CONVERSATION_HISTORY_KEY,
  ConversationHistoryPersistence,
  reconcileConversationHistory,
} from '../src/renderer/conversation-persistence'
import {
  decodeConversationHistory,
  loadConversationHistory,
} from '../src/renderer/conversation-load'
import FixtureHistoryWorker from '../src/renderer/conversation-load-worker?worker&inline'
import type { ConversationLoadPacket } from '../src/renderer/conversation-load-protocol'
import {
  createStudioSession,
  readStudioHistory,
  studioRecoveryCacheRow,
} from '../src/renderer/studio-history'
import {
  getCachedConversationHistoryRecovery,
  attestCachedConversationHistoryRecovery,
  readCachedConversationHistory,
} from '../src/renderer/main-cache-recovery'

afterEach(() => vi.restoreAllMocks())

vi.mock('../src/renderer/conversation-load-worker?worker&inline', async () => {
  const { createHash } = await import('node:crypto')
  return {
    default: class {
      onmessage: ((event: MessageEvent<ConversationLoadPacket>) => void) | null = null
      onerror = null
      onmessageerror = null
      terminate() {}
      postMessage(input: { type: string; buffer?: ArrayBuffer }) {
        if (input.type !== 'load' || !input.buffer) return
        const bytes = new Uint8Array(input.buffer)
        const snapshot = JSON.parse(new TextDecoder().decode(bytes))
        const hash = createHash('sha256').update(bytes).digest('hex')
        queueMicrotask(() => {
          const emit = (data: ConversationLoadPacket) =>
            this.onmessage?.({ data } as MessageEvent<ConversationLoadPacket>)
          emit({
            type: 'start',
            savedAt: snapshot.savedAt,
            threadCount: snapshot.threads.length,
            checkpointEligible: true,
            hash,
          } as ConversationLoadPacket)
          for (let index = 0; index < snapshot.threads.length; index++) {
            const { messages, ...header } = snapshot.threads[index]
            emit({ type: 'thread', index, thread: header, messageCount: messages.length })
            if (messages.length) emit({ type: 'messages', index, messages })
          }
          emit({ type: 'done' })
        })
      }
    },
  }
})
vi.mock('../src/renderer/conversation-cache-hash-worker?worker&inline', async () => {
  const { createHash } = await import('node:crypto')
  return {
    default: class {
      onmessage: ((event: MessageEvent) => void) | null = null
      onerror = null
      onmessageerror = null
      terminate() {}
      postMessage(input: { type: string; serialized: string }) {
        if (input.type !== 'hash') return
        queueMicrotask(() =>
          this.onmessage?.({
            data: {
              type: 'hash',
              hash: createHash('sha256').update(input.serialized).digest('hex'),
            },
          } as MessageEvent),
        )
      }
    },
  }
})

const admission: ConversationProjectionAdmission = {
  sessionId: 'thread',
  transportId: 'transport',
  appliedRevision: 4,
  snapshotToken: 'snapshot-private',
  ownerGeneration: 2,
  deliveryToken: 'ephemeral-native-delivery',
}
function thread(): Thread {
  return {
    id: admission.sessionId,
    profileId: 'machine',
    provider: 'codex',
    workspace: '/owned/project',
    remoteId: 'native-thread',
    title: 'Thread',
    messages: [{ id: 'reply', role: 'assistant', text: '  Exact\r\n🙂  ', turn: 1 }],
    pending: [],
    busy: false,
    turn: 1,
    updatedAt: 10,
    mode: 'review',
    model: '',
    nativeRecovery: {
      [admission.transportId]: {
        appliedRevision: admission.appliedRevision,
        snapshotToken: admission.snapshotToken,
        ownerGeneration: admission.ownerGeneration,
      },
    },
  }
}
function delivery(overrides: Partial<ConversationProjectionAdmission> = {}): AgentEvent {
  const proof = { ...admission, ...overrides }
  return {
    sessionId: proof.sessionId,
    type: 'text',
    text: '  Exact\r\n🙂  ',
    nativeRecovery: {
      transportId: proof.transportId,
      revision: proof.appliedRevision,
      eventId: `event-${proof.appliedRevision}`,
      snapshotToken: proof.snapshotToken,
      ownerGeneration: proof.ownerGeneration,
      deliveryToken: proof.deliveryToken,
    },
  }
}
function live(value = thread(), overrides: Partial<ConversationProjectionAdmission> = {}): Thread {
  return registerNativeProjectionDelivery(value, delivery(overrides))
}
function deferred() {
  let resolve!: () => void
  const promise = new Promise<void>((done) => {
    resolve = done
  })
  return { promise, resolve }
}
function checkpoint() {
  return vi.fn(async (input: ConversationCheckpointInput) => ({ savedAt: input.savedAt }))
}
function encodedHistory(value = thread()): ArrayBuffer {
  return new TextEncoder().encode(JSON.stringify({ version: 1, savedAt: 10, threads: [value] }))
    .buffer
}
async function nativeLoadedThread(): Promise<Thread> {
  const snapshot = await loadConversationHistory({
    loadEncoded: vi.fn(async () => encodedHistory()),
    load: vi.fn(async () => null),
    save: vi.fn(async () => {}),
  })
  return snapshot!.threads[0] as Thread
}
function studioCache() {
  const encoded = JSON.stringify([
    {
      id: admission.sessionId,
      thread: thread(),
      stage: 'interrupted',
      request: '  Exact Studio request\r\n🙂  ',
      updatedAt: 10,
      pending: [],
    },
  ])
  const history = readStudioHistory({ getItem: () => encoded })
  const session = history.sessions[0]
  const row = history.recoveryRow(session)!
  const proof = studioRecoveryCacheRow(session.thread)!
  return { history, session, row, proof, hash: createHash('sha256').update(row).digest('hex') }
}

describe('private native projection admissions', () => {
  it.each([undefined, ''])(
    'admits actual isolated Studio output without a project workspace (%s)',
    (workspace) => {
      const initial = {
        ...createStudioSession('codex', 1, admission.sessionId).thread,
        profileId: 'machine',
        workspace,
        turn: 1,
        messages: [
          {
            id: 'request',
            role: 'user' as const,
            text: '  Exact isolated Studio request\r\n🙂  ',
            turn: 1,
          },
        ],
      }
      const applied = applyEvent(initial, {
        ...delivery(),
        type: 'session',
        remoteId: 'native-thread',
      })
      expect(applied.purpose).toBe('customization')
      expect(applied.workspace).toBe(workspace)
      const prepared = {
        sessionId: applied.id,
        projectionAdmissions: nativeProjectionAdmissions([applied]),
      }
      expect(prepared.projectionAdmissions).toEqual([admission])
      expect(nativeProjectionAdmissions(createHistorySnapshotProjector()([applied]))).toEqual([
        admission,
      ])
      expect(JSON.stringify(applied)).not.toContain(admission.deliveryToken)
      const imported = JSON.parse(JSON.stringify(applied)) as Thread
      registerNativeProjectionBaseline(imported, admission)
      registerNativeProjectionLoadedBaseline(imported, admission)
      expect(nativeProjectionAdmissions([imported])).toBeUndefined()
    },
  )

  it('keeps main, unknown and malformed workspace claims ineligible for empty-scope native admission', () => {
    for (const change of [
      { workspace: undefined },
      { workspace: '' },
      { workspaceUnknown: true },
      { workspace: undefined, purpose: 'customization' as const, workspaceUnknown: true },
      { workspace: undefined, purpose: 'customization' as const, workspaceUnknown: 'false' },
    ]) {
      const initial = { ...thread(), ...change } as Thread
      initial.nativeRecovery = undefined
      expect(nativeProjectionAdmissions([applyEvent(initial, delivery())])).toBeUndefined()
    }
  })

  it('binds the private isolated Studio scope and rejects scope changes or accessor claims', () => {
    const initial = { ...thread(), purpose: 'customization' as const, workspace: undefined }
    const current = live(initial)
    expect(nativeProjectionAdmissions([current])).toEqual([admission])
    for (const change of [
      { purpose: undefined },
      { purpose: 'research' as const },
      { workspace: '/selected/project' },
      { workspaceUnknown: true },
    ])
      expect(nativeProjectionAdmissions([{ ...current, ...change }])).toBeUndefined()
    for (const key of ['workspace', 'workspaceUnknown', 'purpose']) {
      const changed = { ...current }
      Object.defineProperty(changed, key, {
        get: () => {
          throw new Error('Invoked untrusted Studio workspace accessor')
        },
      })
      expect(nativeProjectionAdmissions([changed])).toBeUndefined()
    }
  })

  it('registers only actual accepted event application and strips its capability from pending requests', () => {
    const initial = thread()
    initial.nativeRecovery = undefined
    const event: AgentEvent = { ...delivery(), type: 'approval', requestId: 'native-permission' }
    expect(admitAgentEvents(initial, [event])).toEqual([event])
    expect(nativeProjectionAdmissions([initial])).toBeUndefined()
    const applied = applyEvent(initial, event)
    expect(nativeProjectionAdmissions([applied])).toEqual([admission])
    expect(applied.pending).toHaveLength(1)
    expect(JSON.stringify(applied.pending)).not.toContain(admission.deliveryToken)
    expect(JSON.stringify(createHistorySnapshotProjector()([applied]))).not.toContain(
      admission.deliveryToken,
    )
    const unowned = thread()
    expect(applyEvent(unowned, event)).toBe(unowned)
    expect(nativeProjectionAdmissions([unowned])).toBeUndefined()
  })

  it('admits actual applied delivery cursors and preserves their immutable metadata clones', () => {
    const current = live()
    expect(nativeProjectionAdmissions([current])).toEqual([admission])
    const renamed = { ...current, title: 'Renamed', busy: true }
    expect(nativeProjectionAdmissions([renamed])).toEqual([admission])
    expect(JSON.stringify(current)).not.toContain(admission.deliveryToken)
    const snapshot = createHistorySnapshotProjector()([renamed])
    expect(nativeProjectionAdmissions(snapshot)).toEqual([admission])
    expect(JSON.stringify(snapshot)).not.toContain(admission.deliveryToken)
    const exposed = nativeProjectionAdmissions(snapshot)!
    exposed[0].deliveryToken = 'caller mutation'
    expect(nativeProjectionAdmissions(snapshot)).toEqual([admission])
  })

  it('does not admit JSON copies, parsed imports, copied cursors, or thread ownership changes', () => {
    const current = live()
    const copied = JSON.parse(JSON.stringify(current)) as Thread
    expect(nativeProjectionAdmissions([copied])).toBeUndefined()
    expect(nativeProjectionAdmissions(readThreads([copied]))).toBeUndefined()
    expect(
      nativeProjectionAdmissions([
        { ...current, nativeRecovery: { transport: { ...current.nativeRecovery!.transport } } },
      ]),
    ).toBeUndefined()
    for (const change of [
      { id: 'other' },
      { profileId: 'other' },
      { provider: 'claude' as const },
      { workspace: '/other/project' },
      { remoteId: 'other-native-thread' },
    ])
      expect(nativeProjectionAdmissions([{ ...current, ...change }])).toBeUndefined()
    expect(nativeProjectionAdmissions([current, { ...current }])).toBeUndefined()
  })

  it('binds the actual transcript collection and refuses clearing or replacing it', () => {
    const current = live()
    expect(nativeProjectionAdmissions([{ ...current, messages: [] }])).toBeUndefined()
    expect(
      nativeProjectionAdmissions([{ ...current, messages: [...current.messages] }]),
    ).toBeUndefined()
    const sourceOwned = live(readThreads([thread()])[0])
    const cleared = clearConversationSourceMessages(sourceOwned)
    expect(nativeProjectionAdmissions(createHistorySnapshotProjector()([cleared]))).toBeUndefined()
  })

  it('revokes reused raw projection bindings when an equal cursor copy has no private lineage', () => {
    const snapshot = createHistorySnapshotProjector()
    const current = live(readThreads([thread()])[0])
    const first = snapshot([current])
    expect(nativeProjectionAdmissions(first)).toEqual([admission])
    const copiedCursor = {
      ...current,
      nativeRecovery: { transport: { ...current.nativeRecovery!.transport } },
    }
    const copiedProjection = snapshot([copiedCursor])
    expect(copiedProjection[0]).toBe(first[0])
    expect(nativeProjectionAdmissions(copiedProjection)).toBeUndefined()
  })

  it('does not grant a freshly re-read view the capability of its identical raw source object', () => {
    const snapshot = createHistorySnapshotProjector()
    const first = snapshot([live(readThreads([thread()])[0])])
    expect(nativeProjectionAdmissions(first)).toEqual([admission])
    const reread = readThreads(first)
    expect(nativeProjectionAdmissions(reread)).toBeUndefined()
    const next = snapshot(reread)
    expect(next[0]).toBe(first[0])
    expect(nativeProjectionAdmissions(next)).toBeUndefined()
  })

  it('denies a re-read raw projection even when its raw cursor reference was originally live', () => {
    const snapshot = createHistorySnapshotProjector()
    const first = snapshot([live()])
    expect(nativeProjectionAdmissions(first)).toEqual([admission])
    const reread = snapshot(readThreads(first))
    expect(reread[0]).toBe(first[0])
    expect(nativeProjectionAdmissions(reread)).toBeUndefined()
  })

  it('requires the final cursor tuple to match the exact delivery and does not promote historical tuples', () => {
    for (const change of [
      { sessionId: 'other' },
      { transportId: 'other' },
      { appliedRevision: 3 },
      { snapshotToken: 'current-owner-token' },
      { ownerGeneration: 3 },
      { deliveryToken: '' },
    ])
      expect(nativeProjectionAdmissions([live(thread(), change)])).toBeUndefined()
    const current = live()
    current.nativeRecovery!.transport.appliedRevision = 5
    expect(nativeProjectionAdmissions([current])).toBeUndefined()
    current.nativeRecovery!.transport.appliedRevision = 4
    current.nativeRecovery!.transport.snapshotToken = 'another-owner'
    expect(nativeProjectionAdmissions([current])).toBeUndefined()
  })

  it('does not read cursor or owner accessors while checking private authority', () => {
    const current = live()
    for (const key of ['id', 'workspace', 'remoteId']) {
      const changed = { ...current }
      Object.defineProperty(changed, key, {
        get: () => {
          throw new Error('Read an untrusted owner getter')
        },
      })
      expect(nativeProjectionAdmissions([changed])).toBeUndefined()
    }
    const changed = { ...current, nativeRecovery: {} }
    Object.defineProperty(changed.nativeRecovery, 'transport', {
      enumerable: true,
      get: () => {
        throw new Error('Read an untrusted cursor getter')
      },
    })
    expect(nativeProjectionAdmissions([changed])).toBeUndefined()
  })

  it('admits only actual native-loaded baselines and never lets an owner reply mint imported authority', async () => {
    const restored = readThreads([thread()])[0]
    expect(nativeProjectionAdmissions([restored])).toBeUndefined()
    registerNativeProjectionBaseline(restored, { ...admission, ownerGeneration: 3 })
    expect(nativeProjectionAdmissions([restored])).toBeUndefined()
    registerNativeProjectionBaseline(restored, admission)
    expect(nativeProjectionAdmissions([restored])).toBeUndefined()
    registerNativeProjectionLoadedBaseline(restored, admission)
    expect(nativeProjectionAdmissions([restored])).toBeUndefined()
    const loaded = await nativeLoadedThread()
    registerNativeProjectionLoadedBaseline(loaded, { ...admission, ownerGeneration: 3 })
    expect(nativeProjectionAdmissions([loaded])).toBeUndefined()
    registerNativeProjectionLoadedBaseline(loaded, admission)
    expect(nativeProjectionAdmissions([loaded])).toEqual([admission])
    expect(hasNativeProjectionCursor(loaded, admission.transportId)).toBe(true)
    expect(hasNativeProjectionCursor(restored, admission.transportId)).toBe(false)
    expect(loaded.nativeRecovery!.transport).toEqual({
      appliedRevision: 4,
      snapshotToken: 'snapshot-private',
      ownerGeneration: 2,
    })
  })

  it('uses one current capability per transport when a native baseline refreshes the same cursor', () => {
    const current = live()
    const history = createHistorySnapshotProjector()([current])
    const refreshedAdmission = { ...admission, deliveryToken: 'refreshed-native-delivery' }
    registerNativeProjectionBaseline(current, refreshedAdmission)
    expect(nativeProjectionAdmissions(history)).toEqual([refreshedAdmission])
  })

  it('does not let re-read raw JSON renew an old raw cursor capability from an owner reply', () => {
    const snapshot = createHistorySnapshotProjector()
    const first = snapshot([live()])
    const reread = readThreads(first)
    const currentAdmission = { ...admission, deliveryToken: 'current-document-baseline' }
    registerNativeProjectionBaseline(reread[0], currentAdmission)
    const refreshed = snapshot(reread)
    expect(refreshed[0]).toBe(first[0])
    expect(nativeProjectionAdmissions(refreshed)).toBeUndefined()
  })

  it('uses an accepted loaded historical baseline separately from the newest native owner controls', async () => {
    const restored = await nativeLoadedThread()
    registerNativeProjectionLoadedBaseline(restored, admission)
    const recovered = applyNativeRecoveryOwner(restored, {
      sessionId: admission.sessionId,
      transportId: admission.transportId,
      status: 'idle',
      ownerGeneration: 3,
      snapshotToken: 'current-owner-token',
      deliveryToken: 'current-owner-delivery',
      acceptedAppliedCursor: restored.nativeRecovery!.transport,
      acceptedProjectionAdmission: admission,
    })
    expect(recovered.nativeRecovery!.transport).toEqual(restored.nativeRecovery!.transport)
    expect(recovered.nativeRecoveryOwner).toEqual({
      transportId: admission.transportId,
      ownerGeneration: 3,
      snapshotToken: 'current-owner-token',
    })
    expect(nativeProjectionAdmissions(createHistorySnapshotProjector()([recovered]))).toEqual([
      admission,
    ])
    expect(JSON.stringify(recovered)).not.toContain('current-owner-delivery')
    expect(JSON.stringify(recovered)).not.toContain(admission.deliveryToken)
  })

  it('denies generic decoding, JSON clones and legacy loads even when their cursor matches native attestation', async () => {
    const generic = await decodeConversationHistory(
      encodedHistory(),
      () => new FixtureHistoryWorker(),
    )
    const genericRow = generic.threads[0] as Thread
    registerNativeProjectionLoadedBaseline(genericRow, admission)
    expect(nativeProjectionAdmissions([genericRow])).toBeUndefined()
    const actual = await nativeLoadedThread()
    const cloned = JSON.parse(JSON.stringify(actual)) as Thread
    registerNativeProjectionLoadedBaseline(cloned, admission)
    expect(nativeProjectionAdmissions([cloned])).toBeUndefined()
    const legacy = await loadConversationHistory({
      load: vi.fn(async () => ({ version: 1 as const, savedAt: 10, threads: [thread()] })),
      save: vi.fn(async () => {}),
    })
    registerNativeProjectionLoadedBaseline(legacy!.threads[0] as Thread, admission)
    expect(nativeProjectionAdmissions(legacy!.threads as Thread[])).toBeUndefined()
  })

  it('rejects scope, message membership or cursor mutation after actual native decoding', async () => {
    for (const mutate of [
      (loaded: Thread) => {
        loaded.profileId = 'foreign'
      },
      (loaded: Thread) => {
        loaded.messages = [...loaded.messages]
      },
      (loaded: Thread) => {
        loaded.nativeRecovery!.transport.snapshotToken = 'foreign'
      },
    ]) {
      const loaded = await nativeLoadedThread()
      mutate(loaded)
      registerNativeProjectionLoadedBaseline(loaded, admission)
      expect(nativeProjectionAdmissions([loaded])).toBeUndefined()
    }
  })

  it('admits an exact owned Studio cache row only after its native-accepted byte hash matches', async () => {
    const cache = studioCache()
    expect(cache.proof).toBeDefined()
    expect(
      await registerNativeProjectionCacheBaseline(
        cache.session.thread,
        admission,
        cache.proof,
        cache.hash,
      ),
    ).toBe(cache.session.thread)
    expect(nativeProjectionAdmissions([cache.session.thread])).toEqual([admission])
    expect(hasNativeProjectionCursor(cache.session.thread, admission.transportId)).toBe(true)
    expect(cache.history.encode(cache.history.sessions)).not.toContain(admission.deliveryToken)
  })

  it('denies copied Studio proofs, unowned threads, wrong hashes and an edited row with matching cursor claims', async () => {
    const copied = studioCache()
    await registerNativeProjectionCacheBaseline(
      copied.session.thread,
      admission,
      { ...copied.proof },
      copied.hash,
    )
    expect(nativeProjectionAdmissions([copied.session.thread])).toBeUndefined()
    const badHash = studioCache()
    await registerNativeProjectionCacheBaseline(
      badHash.session.thread,
      admission,
      badHash.proof,
      '0'.repeat(64),
    )
    expect(nativeProjectionAdmissions([badHash.session.thread])).toBeUndefined()
    const unowned = thread()
    await registerNativeProjectionCacheBaseline(unowned, admission, badHash.proof, badHash.hash)
    expect(nativeProjectionAdmissions([unowned])).toBeUndefined()
    const edited = studioCache()
    const rows = JSON.parse(edited.row)
    rows.thread.messages[0].text = 'Imported replacement transcript'
    const foreign = readStudioHistory({ getItem: () => JSON.stringify([rows]) })
    const session = foreign.sessions[0]
    foreign.recoveryRow(session)
    await registerNativeProjectionCacheBaseline(
      session.thread,
      admission,
      studioRecoveryCacheRow(session.thread),
      edited.hash,
    )
    expect(nativeProjectionAdmissions([session.thread])).toBeUndefined()
  })

  it('rechecks actual Studio row provenance after asynchronous hashing before admitting it', async () => {
    const cache = studioCache()
    const gate = deferred()
    const digest = crypto.subtle.digest.bind(crypto.subtle)
    vi.spyOn(crypto.subtle, 'digest').mockImplementationOnce(async (algorithm, bytes) => {
      await gate.promise
      return digest(algorithm, bytes)
    })
    const registering = registerNativeProjectionCacheBaseline(
      cache.session.thread,
      admission,
      cache.proof,
      cache.hash,
    )
    cache.session.thread.messages[0].text = 'Changed while hashing'
    gate.resolve()
    await registering
    expect(nativeProjectionAdmissions([cache.session.thread])).toBeUndefined()
  })

  it('admits actual MAIN fallback cache rows only after their byte hash completes', async () => {
    const serialized = JSON.stringify([thread()])
    const cache = readCachedConversationHistory({
      getItem: (key) => (key === CONVERSATION_HISTORY_KEY ? serialized : null),
      setItem: vi.fn(),
    })
    registerNativeProjectionMainCacheBaseline(cache.threads[0], admission)
    expect(nativeProjectionAdmissions(cache.threads)).toBeUndefined()
    const origin = await getCachedConversationHistoryRecovery(cache)
    expect(origin?.hash).toBe(createHash('sha256').update(serialized).digest('hex'))
    registerNativeProjectionMainCacheBaseline(cache.threads[0], admission)
    expect(nativeProjectionAdmissions(cache.threads)).toEqual([admission])
    expect(hasNativeProjectionCursor(cache.threads[0], admission.transportId)).toBe(true)
    const imported = readThreads(JSON.parse(serialized))
    registerNativeProjectionMainCacheBaseline(imported[0], admission)
    expect(nativeProjectionAdmissions(imported)).toBeUndefined()
  })

  it('denies edited or copied MAIN cache rows despite matching archived cursor values', async () => {
    const cache = readCachedConversationHistory({
      getItem: (key) => (key === CONVERSATION_HISTORY_KEY ? JSON.stringify([thread()]) : null),
      setItem: vi.fn(),
    })
    await getCachedConversationHistoryRecovery(cache)
    const copy = { ...cache.threads[0] }
    registerNativeProjectionMainCacheBaseline(copy, admission)
    expect(nativeProjectionAdmissions([copy])).toBeUndefined()
    cache.threads[0].messages = [...cache.threads[0].messages]
    registerNativeProjectionMainCacheBaseline(cache.threads[0], admission)
    expect(nativeProjectionAdmissions(cache.threads)).toBeUndefined()
  })

  it('keeps the chosen MAIN cache byte hash through genuine owner and authored lineage', async () => {
    const serialized = JSON.stringify([thread()])
    const cache = readCachedConversationHistory({
      getItem: (key) => (key === CONVERSATION_HISTORY_KEY ? serialized : null),
      setItem: vi.fn(),
    })
    const hash = (await getCachedConversationHistoryRecovery(cache))!.hash
    const current = registerNativeProjectionMainCacheBaseline(cache.threads[0], admission)
    expect(nativeProjectionRecoveryCacheHash(current)).toBe(hash)
    const owned = applyNativeRecoveryOwner(current, {
      sessionId: admission.sessionId,
      transportId: admission.transportId,
      status: 'idle',
      ownerGeneration: 3,
      acceptedAppliedCursor: current.nativeRecovery!.transport,
      acceptedProjectionAdmission: { ...admission, deliveryToken: 'renewed-private-baseline' },
    })
    expect(nativeProjectionRecoveryCacheHash(owned)).toBe(hash)
    const authored = carryNativeProjectionAuthoredTransition(owned, {
      ...owned,
      messages: [
        ...owned.messages,
        { id: 'new-local-prompt', role: 'user', text: '  Exact new prompt\r\n🙂  ', turn: 2 },
      ],
      turn: 2,
    })
    expect(nativeProjectionRecoveryCacheHash(authored)).toBe(hash)
    const projected = createHistorySnapshotProjector()([authored])
    expect(nativeProjectionRecoveryCacheHash(projected[0])).toBe(hash)
    const imported = readThreads(JSON.parse(JSON.stringify(authored)))[0]
    expect(nativeProjectionRecoveryCacheHash(imported)).toBeUndefined()
  })

  it('clears the chosen cache hash on a new actual delivery without rebasing the old watermark', async () => {
    const cache = readCachedConversationHistory({
      getItem: (key) => (key === CONVERSATION_HISTORY_KEY ? JSON.stringify([thread()]) : null),
      setItem: vi.fn(),
    })
    await getCachedConversationHistoryRecovery(cache)
    const current = registerNativeProjectionMainCacheBaseline(cache.threads[0], admission)
    const next = applyEvent(current, delivery({ appliedRevision: 5 }))
    expect(nativeProjectionAdmissions([next])).toEqual([{ ...admission, appliedRevision: 5 }])
    expect(nativeProjectionRecoveryCacheHash(next)).toBeUndefined()
  })

  it('does not report an old cache hash alongside a separately delivered uncached native cursor', async () => {
    const value = thread()
    value.nativeRecovery!.second = { ...value.nativeRecovery!.transport }
    const cache = readCachedConversationHistory({
      getItem: (key) => (key === CONVERSATION_HISTORY_KEY ? JSON.stringify([value]) : null),
      setItem: vi.fn(),
    })
    await getCachedConversationHistoryRecovery(cache)
    const current = registerNativeProjectionMainCacheBaseline(cache.threads[0], admission)
    live(current, { transportId: 'second' })
    expect(nativeProjectionAdmissions([current])).toHaveLength(2)
    expect(nativeProjectionRecoveryCacheHash(current)).toBeUndefined()
  })

  it.each([
    { rows: [] as Thread[] },
    { rows: [{ ...thread(), id: 'unowned', nativeRecovery: undefined }] },
  ])(
    'keeps cold cache absence through the actual selected cache reconciliation and projection',
    async ({ rows }) => {
      const serialized = JSON.stringify(rows)
      const cache = readCachedConversationHistory({
        getItem: (key) => (key === CONVERSATION_HISTORY_KEY ? serialized : null),
        setItem: vi.fn(),
      })
      const attested = await attestCachedConversationHistoryRecovery(cache, async () => ({
        projectionAdmissions: [],
        membershipAdmissions: [admission],
        savedAt: 30,
      }))
      await registerNativeProjectionCacheMembership(
        cache.threads,
        attested!.membershipAdmissions,
        cache,
      )
      const reconciled = reconcileConversationHistory(
        { version: 1, savedAt: 10, threads: [thread()] },
        cache,
      )
      expect(reconciled.map((row) => row.id)).toEqual(rows.map((row) => row.id))
      expect(nativeProjectionMembershipAdmissions(reconciled)).toEqual([admission])
      const authored = carryNativeProjectionMembership(reconciled, [...reconciled])
      const projected = createHistorySnapshotProjector()(authored)
      expect(nativeProjectionMembershipAdmissions(projected)).toEqual([admission])
      expect(nativeProjectionAdmissions(projected)).toBeUndefined()
      expect(JSON.stringify(projected)).not.toContain(admission.deliveryToken)
    },
  )

  it('does not transfer cold cache absence when the native history is the chosen membership', async () => {
    const cache = readCachedConversationHistory({ getItem: () => '[]', setItem: vi.fn() })
    await attestCachedConversationHistoryRecovery(cache, async () => ({
      projectionAdmissions: [],
      membershipAdmissions: [admission],
      savedAt: 10,
    }))
    await registerNativeProjectionCacheMembership(cache.threads, [admission], cache)
    const native = reconcileConversationHistory(
      { version: 1, savedAt: 30, threads: [thread()] },
      cache,
    )
    expect(native.map((row) => row.id)).toEqual([admission.sessionId])
    expect(nativeProjectionMembershipAdmissions(native)).toBeUndefined()
  })

  it('denies imported cache envelopes and copied arrays even with canonical native absence headers', async () => {
    const cache = readCachedConversationHistory({ getItem: () => '[]', setItem: vi.fn() })
    await getCachedConversationHistoryRecovery(cache)
    const copied: Thread[] = []
    await registerNativeProjectionCacheMembership(copied, [admission], cache)
    expect(nativeProjectionMembershipAdmissions(copied)).toBeUndefined()
    const imported = { threads: [] as Thread[] }
    await registerNativeProjectionCacheMembership(imported.threads, [admission], imported)
    expect(nativeProjectionMembershipAdmissions(imported.threads)).toBeUndefined()
  })

  it('denies present-owner and duplicate cold membership claims', async () => {
    for (const [rows, admissions] of [
      [[thread()], [admission]],
      [[], [admission, admission]],
    ] as [Thread[], ConversationProjectionAdmission[]][]) {
      const serialized = JSON.stringify(rows)
      const cache = readCachedConversationHistory({
        getItem: (key) => (key === CONVERSATION_HISTORY_KEY ? serialized : null),
        setItem: vi.fn(),
      })
      await registerNativeProjectionCacheMembership(cache.threads, admissions, cache)
      expect(nativeProjectionMembershipAdmissions(cache.threads)).toBeUndefined()
    }
  })

  it('denies cache-array replacement or mutation while its actual byte provenance is pending', async () => {
    for (const replace of [true, false]) {
      const cache = readCachedConversationHistory({ getItem: () => '[]', setItem: vi.fn() })
      const actual = cache.threads
      const registering = registerNativeProjectionCacheMembership(actual, [admission], cache)
      if (replace) cache.threads = []
      else actual.push(thread())
      await registering
      expect(nativeProjectionMembershipAdmissions(actual)).toBeUndefined()
      expect(nativeProjectionMembershipAdmissions(cache.threads)).toBeUndefined()
    }
  })

  it('keeps the final actual delivery proof when an idle owner update reports an older accepted baseline', () => {
    const initial = thread()
    initial.nativeRecovery = undefined
    const currentAdmission = { ...admission, appliedRevision: 5 }
    const applied = applyEvent(initial, delivery(currentAdmission))
    const recovered = applyNativeRecoveryOwner(applied, {
      sessionId: admission.sessionId,
      transportId: admission.transportId,
      status: 'idle',
      acceptedAppliedCursor: thread().nativeRecovery!.transport,
      acceptedProjectionAdmission: admission,
    })
    expect(recovered.nativeRecovery!.transport).toBe(applied.nativeRecovery!.transport)
    expect(nativeProjectionAdmissions(createHistorySnapshotProjector()([recovered]))).toEqual([
      currentAdmission,
    ])
  })

  it('retains genuine delivery authority through native owner child snapshots that preserve covered output', () => {
    const initial = thread()
    initial.nativeRecovery = undefined
    const currentAdmission = { ...admission, appliedRevision: 5 }
    const applied = applyEvent(initial, delivery(currentAdmission))
    const recovered = applyNativeRecoveryOwner(applied, {
      sessionId: admission.sessionId,
      transportId: admission.transportId,
      status: 'idle',
      acceptedAppliedCursor: thread().nativeRecovery!.transport,
      acceptedProjectionAdmission: admission,
      currentChildren: [
        {
          sessionId: admission.sessionId,
          type: 'subagent',
          agentId: 'native-child',
          itemId: 'native-child-item',
          title: 'Native child',
          status: 'running',
        },
      ],
    })
    expect(recovered.messages.length).toBe(applied.messages.length + 1)
    expect(recovered.messages.slice(0, applied.messages.length)).toEqual(applied.messages)
    expect(nativeProjectionAdmissions(createHistorySnapshotProjector()([recovered]))).toEqual([
      currentAdmission,
    ])
  })

  it('carries private owner snapshot proof through lifecycle changes without rebasing the historical tuple', () => {
    const current = live()
    const changed = {
      ...current,
      messages: [
        { ...current.messages[0], status: 'completed', finishedAt: 20, title: 'Native status' },
        { id: 'native-child', role: 'tool' as const, text: '', turn: 1, status: 'running' },
      ],
      nativeRecoveryOwner: {
        transportId: admission.transportId,
        ownerGeneration: 3,
        snapshotToken: 'current-controls-only',
      },
    }
    carryNativeProjectionOwnerSnapshot(current, changed)
    expect(nativeProjectionAdmissions([changed])).toEqual([admission])
    expect(changed.nativeRecovery!.transport).toEqual(current.nativeRecovery!.transport)
  })

  it('refuses owner snapshot transfer after covered text, input, ownership, membership or native identity changes', () => {
    for (const change of [
      (current: Thread) => ({ ...current, messages: [] }),
      (current: Thread) => ({
        ...current,
        messages: [{ ...current.messages[0], text: 'Replacement output' }],
      }),
      (current: Thread) => ({
        ...current,
        messages: [{ ...current.messages[0], input: 'Replacement prompt' }],
      }),
      (current: Thread) => ({
        ...current,
        messages: [{ ...current.messages[0], nativeRecovery: { transportId: 'foreign' } }],
      }),
      (current: Thread) => ({
        ...current,
        messages: [
          { id: 'reordered', role: 'tool' as const, text: '', turn: 1 },
          current.messages[0],
        ],
      }),
      (current: Thread) => ({ ...current, profileId: 'foreign', messages: [...current.messages] }),
      (current: Thread) => ({
        ...current,
        messages: [...current.messages],
        nativeRecovery: {
          transport: { ...current.nativeRecovery!.transport },
        },
      }),
    ]) {
      const current = live()
      const changed = change(current)
      carryNativeProjectionOwnerSnapshot(current, changed)
      expect(nativeProjectionAdmissions([changed])).toBeUndefined()
    }
    const unowned = thread()
    const changed = { ...unowned, messages: [...unowned.messages] }
    carryNativeProjectionOwnerSnapshot(unowned, changed)
    expect(nativeProjectionAdmissions([changed])).toBeUndefined()
  })

  it('preserves covered attachment identity through owner lifecycle updates', () => {
    const initial = thread()
    initial.messages[0].attachments = [
      {
        id: 'attachment',
        name: 'Exact file',
        mime: 'text/plain',
        size: 12,
        remotePath: '/owned/project/file.txt',
      },
    ]
    const current = live(initial)
    const changed = {
      ...current,
      messages: [
        {
          ...current.messages[0],
          attachments: [...current.messages[0].attachments!],
          status: 'completed',
        },
      ],
    }
    carryNativeProjectionOwnerSnapshot(current, changed)
    expect(nativeProjectionAdmissions([changed])).toBeUndefined()
    const retained = { ...current, messages: [{ ...current.messages[0], status: 'completed' }] }
    carryNativeProjectionOwnerSnapshot(current, retained)
    expect(nativeProjectionAdmissions([retained])).toEqual([admission])
  })

  it('preserves historical capability when the UI appends an exact unsent turn and attachment', () => {
    const current = live()
    const next = {
      ...current,
      turn: 2,
      busy: true,
      messages: [
        ...current.messages,
        {
          id: 'authored-user',
          role: 'user' as const,
          text: '  Exact unsent prompt\r\n\t🙂  ',
          input: '  Exact unsent prompt\r\n\t🙂  ',
          turn: 2,
          attachments: [
            {
              id: 'upload',
              name: 'Exact attachment',
              mime: 'text/plain',
              size: 12,
              remotePath: '/owned/project/attachment.txt',
            },
          ],
        },
      ],
    }
    carryNativeProjectionAuthoredTransition(current, next)
    expect(nativeProjectionAdmissions(createHistorySnapshotProjector()([next]))).toEqual([
      admission,
    ])
    expect(next.messages.at(-1)?.text).toBe('  Exact unsent prompt\r\n\t🙂  ')
    expect(next.nativeRecovery!.transport.appliedRevision).toBe(4)
    expect(JSON.stringify(next)).not.toContain(admission.deliveryToken)
  })

  it('preserves capability through synthetic completion and a late local finish without new native output', () => {
    const current = live()
    const completed = applyEvent(current, {
      sessionId: current.id,
      type: 'complete',
      status: 'completed',
    })
    carryNativeProjectionAuthoredTransition(current, completed)
    expect(nativeProjectionAdmissions([completed])).toEqual([admission])
    const finished = finishThreadTurn(completed, 'interrupted', 50)
    carryNativeProjectionAuthoredTransition(completed, finished)
    expect(nativeProjectionAdmissions(createHistorySnapshotProjector()([finished]))).toEqual([
      admission,
    ])
    expect(finished.nativeRecovery!.transport).toBe(current.nativeRecovery!.transport)
  })

  it('preserves capability when an already native-owned permission is resolved locally', () => {
    const initial = thread()
    initial.nativeRecovery = undefined
    const current = applyEvent(initial, {
      ...delivery(),
      type: 'approval',
      requestId: 'permission',
    })
    const resolved = resolveAgentRequest(current, 'permission', true, undefined, 50)
    carryNativeProjectionAuthoredTransition(current, resolved)
    expect(resolved.pending).toEqual([])
    expect(nativeProjectionAdmissions(createHistorySnapshotProjector()([resolved]))).toEqual([
      admission,
    ])
    expect(JSON.stringify(resolved)).not.toContain(admission.deliveryToken)
  })

  it('rejects imported, cleared, reordered or rewritten output at the authored UI boundary', () => {
    for (const change of [
      (current: Thread) => JSON.parse(JSON.stringify(current)) as Thread,
      (current: Thread) => ({ ...current, messages: [] }),
      (current: Thread) => ({
        ...current,
        messages: [{ ...current.messages[0], text: 'rewritten' }],
      }),
      (current: Thread) => ({ ...current, messages: [{ ...current.messages[0], turn: 9 }] }),
      (current: Thread) => ({
        ...current,
        messages: [{ ...current.messages[0], attachments: [] }],
      }),
      (current: Thread) => ({
        ...current,
        messages: [
          {
            ...current.messages[0],
            nativeRecovery: { transportId: 'foreign', ownerGeneration: 9 },
          },
        ],
      }),
      (current: Thread) => ({
        ...current,
        messages: [
          { id: 'inserted', role: 'tool' as const, text: '', turn: 1 },
          ...current.messages,
        ],
      }),
    ]) {
      const current = live()
      const changed = change(current)
      carryNativeProjectionAuthoredTransition(current, changed)
      expect(nativeProjectionAdmissions([changed])).toBeUndefined()
    }
  })

  it('carries actual source projection authority across source ACK refresh without changing opaque JSON', () => {
    const raw = {
      ...thread(),
      futureField: { exact: '  archive\r\n🙂  ' },
      messages: [
        thread().messages[0],
        { id: 'opaque', role: 'future-role', payload: { exact: '  unchanged  ' } },
        null,
      ],
    }
    const current = live(readThreads([raw])[0])
    const history = createHistorySnapshotProjector()([current])
    expect(history[0]).toEqual(raw)
    expect(nativeProjectionAdmissions(history)).toEqual([admission])
    acknowledgeConversationSources(history, 20)
    const refreshed = carryNativeProjectionAdmissions(history, refreshConversationSources(history))
    expect(refreshed[0]).toEqual(raw)
    expect(nativeProjectionAdmissions(refreshed)).toEqual([admission])
    const copied = [JSON.parse(JSON.stringify(refreshed[0])) as Thread]
    expect(nativeProjectionAdmissions(copied)).toBeUndefined()
    const projected = projectConversationSource(current)
    expect(JSON.stringify(projected)).not.toContain(admission.deliveryToken)
  })
})

describe('projection admissions accompany the exact submitted native write', () => {
  it('sends checkpoint metadata outside raw upserts and retains it on base-change legacy fallback', async () => {
    const client = new ConversationCheckpointClient()
    const save = vi.fn(
      async (
        _history: unknown[],
        _savedAt?: number,
        _admissions?: readonly ConversationProjectionAdmission[],
      ) => {},
    )
    const write = checkpoint()
    const initial = [thread()]
    expect(client.adoptDurableBaseline(initial, 10, save, write)).toBe(true)
    const current = createHistorySnapshotProjector()([live()])
    await client.submit(current, 11, save, write)
    const packet = write.mock.calls[0][0]
    expect(packet.projectionAdmissions).toEqual([admission])
    expect(JSON.stringify(packet.upserts)).not.toContain(admission.deliveryToken)
    write.mockRejectedValueOnce(new Error(CONVERSATION_CHECKPOINT_BASE_CHANGED))
    await client.submit(current, 12, save, write)
    expect(save).toHaveBeenCalledExactlyOnceWith(current, 12, [admission])
  })

  it('uses the latest coalesced history and does not union superseded or imported admissions', async () => {
    const client = new ConversationCheckpointClient()
    const gate = deferred()
    const save = vi.fn(
      async (
        _history: unknown[],
        _savedAt?: number,
        _admissions?: readonly ConversationProjectionAdmission[],
      ) => {},
    )
    const write = vi.fn(async (input: ConversationCheckpointInput) => {
      if (input.savedAt === 11) await gate.promise
      return { savedAt: input.savedAt }
    })
    const snapshot = createHistorySnapshotProjector()
    expect(client.adoptDurableBaseline([thread()], 10, save, write)).toBe(true)
    const first = client.submit(snapshot([live()]), 11, save, write)
    const superseded = client.submit(snapshot([live()]), 12, save, write)
    const imported = JSON.parse(JSON.stringify(thread())) as Thread
    const last = client.submit(snapshot([imported]), 13, save, write)
    gate.resolve()
    expect(await Promise.all([first, superseded, last])).toEqual([11, 13, 13])
    expect(write.mock.calls.map(([input]) => input.savedAt)).toEqual([11, 13])
    expect(write.mock.calls[0][0].projectionAdmissions).toEqual([admission])
    expect(write.mock.calls[1][0].projectionAdmissions).toBeUndefined()
  })

  it('retains source-owned admissions when a queued write refreshes after an earlier ACK', async () => {
    const snapshot = createHistorySnapshotProjector()
    const current = live(readThreads([thread()])[0])
    const client = new ConversationCheckpointClient()
    const gate = deferred()
    const save = vi.fn(
      async (
        _history: unknown[],
        _savedAt?: number,
        _admissions?: readonly ConversationProjectionAdmission[],
      ) => {},
    )
    const write = vi.fn(async (input: ConversationCheckpointInput) => {
      if (input.savedAt === 11) await gate.promise
      return { savedAt: input.savedAt }
    })
    expect(client.adoptDurableBaseline(snapshot([current]), 10, save, write)).toBe(true)
    const first = client.submit(snapshot([current]), 11, save, write)
    const renamed = { ...current, title: 'Renamed while saving' }
    const next = client.submit(snapshot([renamed]), 12, save, write)
    gate.resolve()
    expect(await Promise.all([first, next])).toEqual([11, 12])
    expect(write.mock.calls[1][0].projectionAdmissions).toEqual([admission])
    expect(write.mock.calls[1][0].upserts[0].thread.title).toBe('Renamed while saving')
  })

  it('sends admissions with direct legacy persistence and leaves fallback cache free of capabilities', async () => {
    const current = live()
    const values = new Map<string, string>()
    const save = vi.fn(
      async (
        _history: unknown[],
        _savedAt?: number,
        _admissions?: readonly ConversationProjectionAdmission[],
      ) => {},
    )
    const persistence = new ConversationHistoryPersistence({
      getThreads: () => [current],
      getNativeSave: () => save,
      getStorage: () => ({
        getItem: (key) => values.get(key) ?? null,
        setItem: (key, value) => void values.set(key, value),
      }),
      onError: vi.fn(),
      enabled: () => true,
    })
    expect(await persistence.flush()).toBe(true)
    expect(save.mock.calls[0]).toEqual([
      createHistorySnapshotProjector()([current]),
      expect.any(Number),
      [admission],
    ])
    save.mockRejectedValueOnce(new Error('Disk unavailable'))
    expect(await persistence.flush([{ ...current, title: 'Cache fallback' }])).toBe(true)
    expect(values.get(CONVERSATION_HISTORY_KEY)).not.toContain(admission.deliveryToken)
    const cached = JSON.parse(values.get(CONVERSATION_HISTORY_KEY)!) as Thread[]
    expect(nativeProjectionAdmissions(cached)).toBeUndefined()
  })
})
