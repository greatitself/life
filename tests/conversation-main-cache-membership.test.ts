import { afterEach, describe, expect, it, vi } from 'vitest'
import { createHash } from 'node:crypto'
import type {
  ConversationHistorySnapshot,
  ConversationProjectionAdmission,
} from '../src/shared/conversations'
import type { AgentEvent } from '../src/shared/types'
import {
  ConversationHistoryPersistence,
  reconcileConversationHistory,
  type NativePrepareRecoveryCache,
} from '../src/renderer/conversation-persistence'
import { markNormalizedConversationHistory } from '../src/renderer/conversation-load-protocol'
import { getConversationSourceRaw } from '../src/renderer/conversation-source'
import {
  CONVERSATION_HISTORY_KEY,
  conversationCheckpointKey,
  attestCachedConversationHistoryRecovery,
  getCachedConversationHistoryRecovery,
  getEffectiveCachedConversationHistorySavedAt,
  readCachedConversationHistory,
} from '../src/renderer/main-cache-recovery'
import {
  nativeProjectionAdmissions,
  nativeProjectionMembershipAdmissions,
  registerNativeProjectionCacheMembership,
  registerNativeProjectionDelivery,
  registerNativeProjectionMembershipTransition,
} from '../src/renderer/native-projection-admissions'
import { readThreads, type Thread } from '../src/renderer/state'

const hashCalls = vi.hoisted(() => ({ serialized: [] as string[] }))
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
        hashCalls.serialized.push(input.serialized)
        const bytes = new TextEncoder().encode(input.serialized)
        queueMicrotask(() =>
          this.onmessage?.({
            data: { type: 'hash', hash: createHash('sha256').update(bytes).digest('hex') },
          } as MessageEvent),
        )
      }
    },
  }
})
afterEach(() => {
  hashCalls.serialized = []
  vi.restoreAllMocks()
})

type Preparation = Parameters<NativePrepareRecoveryCache>[0]
const admission: ConversationProjectionAdmission = {
  sessionId: 'owned-session',
  transportId: 'owned-transport',
  appliedRevision: 4,
  snapshotToken: 'owned-snapshot',
  ownerGeneration: 2,
  deliveryToken: 'native-delivery-token',
}
function owned(projection = admission): Thread[] {
  const result = readThreads([
    {
      id: projection.sessionId,
      profileId: 'owned-profile',
      provider: 'codex',
      workspace: '/owned/workspace',
      remoteId: `original-native-thread:${projection.sessionId}`,
      title: 'Owned native conversation',
      updatedAt: 10,
      model: '',
      mode: 'review',
      turn: 1,
      busy: false,
      pending: [],
      messages: [
        { id: 'reply', role: 'assistant', text: '  Native café 漢字 🧪\r\n  ', turn: 1 },
        null,
        { role: 'future-role', opaque: [false, 17, null] },
      ],
      nativeRecovery: {
        [projection.transportId]: {
          appliedRevision: projection.appliedRevision,
          snapshotToken: projection.snapshotToken,
          ownerGeneration: projection.ownerGeneration,
        },
      },
    },
  ])
  registerNativeProjectionDelivery(result[0], {
    type: 'text',
    sessionId: projection.sessionId,
    text: '',
    nativeRecovery: {
      transportId: projection.transportId,
      revision: projection.appliedRevision,
      eventId: `actual-native-event:${projection.sessionId}`,
      ownerGeneration: projection.ownerGeneration,
      localTurn: 1,
      snapshotToken: projection.snapshotToken,
      emittedAt: 10,
      deliveryToken: projection.deliveryToken,
    },
  } as AgentEvent)
  return result
}
function archive(): Thread {
  return readThreads([
    {
      id: 'unowned-archive',
      profileId: 'archive-profile',
      provider: 'claude',
      title: 'Exact unowned archive',
      updatedAt: 11,
      messages: [null, 23, { role: 'future-role', exact: '  Ω\r\n🙂  ' }],
      opaque: { nested: [null, false, { exact: '  Ω\r\n🙂  ' }] },
    },
  ])[0]
}
function storage() {
  const values = new Map<string, string>()
  return {
    values,
    getItem: vi.fn((key: string) => values.get(key) ?? null),
    setItem: vi.fn((key: string, value: string) => {
      values.set(key, value)
    }),
  }
}
function context(initial: Thread[], prepare?: NativePrepareRecoveryCache) {
  let current = initial
  const cache = storage()
  const save = vi.fn(async (): Promise<void> => {
    throw new Error('Primary disk checkpoint failed')
  })
  const persistence = new ConversationHistoryPersistence({
    getThreads: () => current,
    getNativeSave: () => save,
    getPrepareRecoveryCache: () => prepare,
    getStorage: () => cache,
    onError: vi.fn(),
    enabled: () => true,
  })
  return { cache, save, persistence, change: (next: Thread[]) => (current = next) }
}
function olderNative(threads: Thread[]): ConversationHistorySnapshot {
  for (const thread of threads) thread.updatedAt = 9_999_999_999_999
  const snapshot: ConversationHistorySnapshot = { version: 1, savedAt: 500, threads }
  markNormalizedConversationHistory(snapshot)
  return snapshot
}
function envelope(input: Preparation) {
  return {
    projectionAdmissions: input.projectionAdmissions,
    ...(input.membershipAdmissions ? { membershipAdmissions: input.membershipAdmissions } : {}),
    savedAt: input.savedAt,
  }
}
function markerCrash(cache: ReturnType<typeof storage>, order?: string[]) {
  cache.setItem.mockImplementation((key, value) => {
    order?.push(key)
    if (key !== CONVERSATION_HISTORY_KEY) throw new Error('Renderer exited before marker write')
    cache.values.set(key, value)
  })
}

describe('native-owned main cache deletion membership', () => {
  it.each(['empty', 'unowned-only'] as const)(
    'recovers %s membership after deleting the final native owner and exiting before the marker',
    async (remaining) => {
      const survivor = archive()
      const before = remaining === 'empty' ? owned() : [...owned(), survivor]
      const after = registerNativeProjectionMembershipTransition(
        before,
        remaining === 'empty' ? [] : [survivor],
      )
      expect(nativeProjectionAdmissions(after)).toBeUndefined()
      expect(nativeProjectionMembershipAdmissions(after)).toEqual([admission])
      const prepared = new Map<string, Preparation>()
      const order: string[] = []
      const prepare = vi.fn<NativePrepareRecoveryCache>(async (input) => {
        order.push('prepare')
        expect(c.cache.values.has(CONVERSATION_HISTORY_KEY)).toBe(false)
        prepared.set(input.hash, input)
      })
      const c = context(after, prepare)
      markerCrash(c.cache, order)

      expect(await c.persistence.flush()).toBe(false)
      expect(c.save).toHaveBeenCalledOnce()
      const serialized = c.cache.values.get(CONVERSATION_HISTORY_KEY)!
      const hash = createHash('sha256').update(new TextEncoder().encode(serialized)).digest('hex')
      expect(prepare).toHaveBeenCalledExactlyOnceWith({
        snapshotId: expect.stringMatching(/^main-cache:\d+:/),
        hash,
        savedAt: expect.any(Number),
        projectionAdmissions: [],
        membershipAdmissions: [admission],
      })
      expect(order).toEqual(['prepare', CONVERSATION_HISTORY_KEY, conversationCheckpointKey])
      expect(hashCalls.serialized).toEqual([serialized])
      expect(c.cache.values.has(conversationCheckpointKey)).toBe(false)
      expect(serialized).not.toContain('deliveryToken')
      expect(serialized).not.toContain('membershipAdmissions')
      expect(serialized).not.toContain(admission.sessionId)

      const cold = readCachedConversationHistory(c.cache)
      expect(cold.savedAt).toBeUndefined()
      const native = olderNative(before)
      expect(reconcileConversationHistory(native, cold).map((row) => row.id)).toContain(
        admission.sessionId,
      )
      const attest = vi.fn(async ({ hash: actualHash }: { hash: string }) =>
        envelope(prepared.get(actualHash)!),
      )
      const actual = await attestCachedConversationHistoryRecovery(cold, attest)
      expect(attest).toHaveBeenCalledExactlyOnceWith({ hash })
      expect(actual?.projectionAdmissions).toEqual([])
      expect(actual?.membershipAdmissions).toEqual([admission])
      expect(actual?.rows).toEqual(cold.threads)
      expect(nativeProjectionAdmissions(cold.threads)).toBeUndefined()
      expect(nativeProjectionMembershipAdmissions(cold.threads)).toBeUndefined()
      await registerNativeProjectionCacheMembership(
        cold.threads,
        actual!.membershipAdmissions,
        cold,
      )
      expect(nativeProjectionMembershipAdmissions(cold.threads)).toEqual([admission])
      expect(getEffectiveCachedConversationHistorySavedAt(cold)).toBe(prepared.get(hash)!.savedAt)
      const recovered = reconcileConversationHistory(native, cold)
      expect(recovered).not.toBe(cold.threads)
      expect(nativeProjectionMembershipAdmissions(recovered)).toEqual([admission])
      expect(recovered.map((row) => row.id)).toEqual(
        remaining === 'empty' ? [] : ['unowned-archive'],
      )
      if (remaining === 'unowned-only')
        expect(getConversationSourceRaw(recovered[0])).toEqual(getConversationSourceRaw(survivor))
      expect(cold.savedAt).toBeUndefined()
      expect(getEffectiveCachedConversationHistorySavedAt({ ...cold })).toBeUndefined()
      expect(
        getEffectiveCachedConversationHistorySavedAt(JSON.parse(JSON.stringify(cold))),
      ).toBeUndefined()

      native.savedAt = prepared.get(hash)!.savedAt + 1
      const newerNative = reconcileConversationHistory(native, cold)
      expect(newerNative.map((row) => row.id).sort()).toEqual(before.map((row) => row.id).sort())
      expect(nativeProjectionMembershipAdmissions(newerNative)).toBeUndefined()
      expect(nativeProjectionMembershipAdmissions(cold.threads)).toEqual([admission])
    },
  )

  it('selects older actual payload bytes when a newer deletion was prepared but never written', async () => {
    const before = owned()
    const preparations = new Map<string, Preparation>()
    const prepare = vi.fn<NativePrepareRecoveryCache>(async (input) => {
      preparations.set(input.hash, input)
    })
    const c = context(before, prepare)
    expect(await c.persistence.flush()).toBe(true)
    const olderBytes = c.cache.values.get(CONVERSATION_HISTORY_KEY)!
    const olderHash = createHash('sha256').update(olderBytes).digest('hex')
    c.change(registerNativeProjectionMembershipTransition(before, []))
    c.cache.setItem.mockImplementationOnce(() => {
      throw new Error('Renderer exited after preparation and before payload write')
    })
    expect(await c.persistence.flush()).toBe(false)
    expect(prepare).toHaveBeenCalledTimes(2)
    expect(prepare.mock.calls[1][0].membershipAdmissions).toEqual([admission])
    expect(prepare.mock.calls[1][0].hash).not.toBe(olderHash)
    expect(c.cache.values.get(CONVERSATION_HISTORY_KEY)).toBe(olderBytes)
    c.cache.values.delete(conversationCheckpointKey)

    const cold = readCachedConversationHistory(c.cache)
    expect((await getCachedConversationHistoryRecovery(cold))?.hash).toBe(olderHash)
    const actual = await attestCachedConversationHistoryRecovery(cold, async ({ hash }) =>
      envelope(preparations.get(hash)!),
    )
    expect(actual?.projectionAdmissions).toEqual([admission])
    expect(actual?.membershipAdmissions).toBeUndefined()
    expect(actual?.savedAt).toBe(preparations.get(olderHash)!.savedAt)
    expect(getEffectiveCachedConversationHistorySavedAt(cold)).toBe(
      preparations.get(olderHash)!.savedAt,
    )
    const nativeRows = owned()
    nativeRows[0].messages[0].text = 'Different stale native payload'
    const native = olderNative(nativeRows)
    const recovered = reconcileConversationHistory(native, cold)
    expect(recovered).toEqual(cold.threads)
    expect(recovered[0]).toBe(cold.threads[0])
    expect(recovered[0].messages[0].text).toBe('  Native café 漢字 🧪\r\n  ')
    expect(getConversationSourceRaw(recovered[0])).toEqual(JSON.parse(olderBytes)[0])
  })

  it.each(['same-row', 'reconstructed-row'] as const)(
    'does not claim a %s owner that remains in the next membership was deleted',
    (kind) => {
      const before = owned()
      const retained =
        kind === 'same-row' ? [...before] : readThreads(JSON.parse(JSON.stringify(before)))
      const after = registerNativeProjectionMembershipTransition(before, retained)
      expect(after.map((row) => row.id)).toEqual([admission.sessionId])
      expect(nativeProjectionMembershipAdmissions(after)).toBeUndefined()
    },
  )

  it('prepares surviving projections and deleted ownership separately for the exact mixed membership', async () => {
    const survivingAdmission = {
      ...admission,
      sessionId: 'surviving-session',
      transportId: 'surviving-transport',
      deliveryToken: 'surviving-native-delivery',
    }
    const before = [...owned(), ...owned(survivingAdmission)]
    const after = registerNativeProjectionMembershipTransition(before, [before[1]])
    expect(nativeProjectionAdmissions(after)).toEqual([survivingAdmission])
    expect(nativeProjectionMembershipAdmissions(after)).toEqual([admission])
    let prepared!: Preparation
    const c = context(after, async (input) => {
      prepared = input
    })
    markerCrash(c.cache)
    expect(await c.persistence.flush()).toBe(false)
    expect(prepared.projectionAdmissions).toEqual([survivingAdmission])
    expect(prepared.membershipAdmissions).toEqual([admission])
    const cold = readCachedConversationHistory(c.cache)
    const native = olderNative([...owned(), ...owned(survivingAdmission)])
    expect(reconcileConversationHistory(native, cold)).toHaveLength(2)
    const actual = await attestCachedConversationHistoryRecovery(cold, async () =>
      envelope(prepared),
    )
    expect(actual?.projectionAdmissions).toEqual([survivingAdmission])
    expect(actual?.membershipAdmissions).toEqual([admission])
    expect(getEffectiveCachedConversationHistorySavedAt(cold)).toBe(prepared.savedAt)
    const recovered = reconcileConversationHistory(native, cold)
    expect(recovered.map((row) => row.id)).toEqual([survivingAdmission.sessionId])
    expect(recovered[0]).toBe(cold.threads[0])
  })

  it.each(['fresh', 'copied-array', 'json-copy'] as const)(
    'does not prepare native deletion authority for an %s empty array',
    async (kind) => {
      const authored = registerNativeProjectionMembershipTransition(owned(), [])
      const imported: Thread[] =
        kind === 'fresh'
          ? []
          : kind === 'copied-array'
            ? [...authored]
            : JSON.parse(JSON.stringify(authored))
      expect(nativeProjectionMembershipAdmissions(imported)).toBeUndefined()
      const prepare = vi.fn<NativePrepareRecoveryCache>().mockResolvedValue(undefined)
      const c = context(imported, prepare)
      markerCrash(c.cache)
      expect(await c.persistence.flush()).toBe(false)
      expect(prepare).not.toHaveBeenCalled()
      expect(hashCalls.serialized).toEqual([])
      const cold = readCachedConversationHistory(c.cache)
      const attest = vi.fn(async () => ({ projectionAdmissions: [], savedAt: 10_000 }))
      const actual = await attestCachedConversationHistoryRecovery(cold, attest)
      expect(actual?.savedAt).toBeUndefined()
      expect(getEffectiveCachedConversationHistorySavedAt(cold)).toBeUndefined()
      expect(reconcileConversationHistory(olderNative(owned()), cold).map((row) => row.id)).toEqual(
        [admission.sessionId],
      )
    },
  )

  it('does not derive deletion authority from imported native-looking cursors', async () => {
    const imported = readThreads(JSON.parse(JSON.stringify(owned())))
    const removed = registerNativeProjectionMembershipTransition(imported, [])
    expect(nativeProjectionMembershipAdmissions(removed)).toBeUndefined()
    const prepare = vi.fn<NativePrepareRecoveryCache>().mockResolvedValue(undefined)
    const c = context(removed, prepare)
    expect(await c.persistence.flush()).toBe(true)
    expect(prepare).not.toHaveBeenCalled()
  })

  it('denies a deletion clock when the purported deleted owner remains in actual cache bytes', async () => {
    const c = context(owned(), vi.fn<NativePrepareRecoveryCache>().mockResolvedValue(undefined))
    markerCrash(c.cache)
    expect(await c.persistence.flush()).toBe(false)
    const cold = readCachedConversationHistory(c.cache)
    const actual = await attestCachedConversationHistoryRecovery(cold, async () => ({
      projectionAdmissions: [],
      membershipAdmissions: [admission],
      savedAt: 10_000,
    }))
    expect(actual?.savedAt).toBeUndefined()
    expect(getEffectiveCachedConversationHistorySavedAt(cold)).toBeUndefined()
    const nativeRows = owned()
    nativeRows[0].messages[0].text = 'Still authoritative native row'
    const recovered = reconcileConversationHistory(olderNative(nativeRows), cold)
    expect(recovered[0]).toBe(nativeRows[0])
  })

  it('cannot apply a prepared deletion envelope to a copied cache wrapper', async () => {
    const removed = registerNativeProjectionMembershipTransition(owned(), [])
    let prepared!: Preparation
    const c = context(removed, async (input) => {
      prepared = input
    })
    markerCrash(c.cache)
    await c.persistence.flush()
    const actual = readCachedConversationHistory(c.cache)
    for (const copied of [{ ...actual }, JSON.parse(JSON.stringify(actual))]) {
      const attest = vi.fn(async () => envelope(prepared))
      expect(await attestCachedConversationHistoryRecovery(copied, attest)).toBeUndefined()
      expect(attest).not.toHaveBeenCalled()
      expect(getEffectiveCachedConversationHistorySavedAt(copied)).toBeUndefined()
      expect(
        reconcileConversationHistory(olderNative(owned()), copied).map((row) => row.id),
      ).toEqual([admission.sessionId])
    }
  })

  it('invalidates a deletion clock when the actual unowned cache graph changes after attestation', async () => {
    const survivor = archive()
    const removed = registerNativeProjectionMembershipTransition([...owned(), survivor], [survivor])
    let prepared!: Preparation
    const c = context(removed, async (input) => {
      prepared = input
    })
    markerCrash(c.cache)
    await c.persistence.flush()
    const cold = readCachedConversationHistory(c.cache)
    await attestCachedConversationHistoryRecovery(cold, async () => envelope(prepared))
    expect(getEffectiveCachedConversationHistorySavedAt(cold)).toBe(prepared.savedAt)
    const raw = getConversationSourceRaw(cold.threads[0]) as unknown as {
      opaque: { nested: unknown[] }
    }
    raw.opaque.nested.push('Changed exact cached archive')
    expect(getEffectiveCachedConversationHistorySavedAt(cold)).toBeUndefined()
    expect(await getCachedConversationHistoryRecovery(cold)).toBeUndefined()
    expect(reconcileConversationHistory(olderNative(owned()), cold).map((row) => row.id)).toContain(
      admission.sessionId,
    )
  })

  it('invalidates empty-cache deletion authority when a row is inserted after attestation', async () => {
    const removed = registerNativeProjectionMembershipTransition(owned(), [])
    let prepared!: Preparation
    const c = context(removed, async (input) => {
      prepared = input
    })
    markerCrash(c.cache)
    await c.persistence.flush()
    const cold = readCachedConversationHistory(c.cache)
    await attestCachedConversationHistoryRecovery(cold, async () => envelope(prepared))
    expect(getEffectiveCachedConversationHistorySavedAt(cold)).toBe(prepared.savedAt)
    cold.threads.push(archive())
    expect(getEffectiveCachedConversationHistorySavedAt(cold)).toBeUndefined()
    expect(await getCachedConversationHistoryRecovery(cold)).toBeUndefined()
    expect(reconcileConversationHistory(olderNative(owned()), cold).map((row) => row.id)).toContain(
      admission.sessionId,
    )
  })

  it('cannot admit deletion authority when cache membership changes while native attestation is pending', async () => {
    const removed = registerNativeProjectionMembershipTransition(owned(), [])
    let prepared!: Preparation
    const c = context(removed, async (input) => {
      prepared = input
    })
    markerCrash(c.cache)
    await c.persistence.flush()
    const cold = readCachedConversationHistory(c.cache)
    let entered!: () => void
    const requested = new Promise<void>((resolve) => {
      entered = resolve
    })
    let complete!: (value: ReturnType<typeof envelope>) => void
    const response = new Promise<ReturnType<typeof envelope>>((resolve) => {
      complete = resolve
    })
    const attestation = attestCachedConversationHistoryRecovery(cold, async () => {
      entered()
      return response
    })
    await requested
    cold.threads.push(archive())
    complete(envelope(prepared))
    expect(await attestation).toBeUndefined()
    expect(getEffectiveCachedConversationHistorySavedAt(cold)).toBeUndefined()
    expect(reconcileConversationHistory(olderNative(owned()), cold).map((row) => row.id)).toContain(
      admission.sessionId,
    )
  })
})
