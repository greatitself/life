import { afterEach, describe, expect, it, vi } from 'vitest'
import { createHash } from 'node:crypto'
import type { AgentEvent } from '../src/shared/types'
import type { ConversationProjectionAdmission } from '../src/shared/conversations'
import {
  ConversationHistoryPersistence,
  reconcileConversationHistory,
  type NativePrepareRecoveryCache,
} from '../src/renderer/conversation-persistence'
import {
  CONVERSATION_HISTORY_KEY,
  getCachedConversationHistoryRecovery,
  getCachedConversationRowRecovery,
  attestCachedConversationHistoryRecovery,
  getEffectiveCachedConversationHistorySavedAt,
  readCachedConversationHistory,
} from '../src/renderer/main-cache-recovery'
import {
  nativeProjectionAdmissions,
  registerNativeProjectionDelivery,
  registerNativeProjectionMainCacheBaseline,
  carryNativeProjectionAuthoredTransition,
} from '../src/renderer/native-projection-admissions'
import { readThreads, type Thread } from '../src/renderer/state'
import { getConversationSourceRaw } from '../src/renderer/conversation-source'
import { markNormalizedConversationHistory } from '../src/renderer/conversation-load-protocol'
import type { ConversationHistorySnapshot } from '../src/shared/conversations'

const hashCalls = vi.hoisted(() => ({ serialized: [] as string[], terminated: 0 }))
vi.mock('../src/renderer/conversation-cache-hash-worker?worker&inline', async () => {
  const { createHash } = await import('node:crypto')
  return {
    default: class {
      onmessage: ((event: MessageEvent) => void) | null = null
      onerror = null
      onmessageerror = null
      terminate() {
        hashCalls.terminated++
      }
      postMessage({ serialized }: { type: string; serialized: string }) {
        hashCalls.serialized.push(serialized)
        queueMicrotask(() =>
          this.onmessage?.({
            data: /[\uD800-\uDFFF]/u.test(serialized)
              ? { type: 'error', message: 'Unpaired surrogate.' }
              : {
                  type: 'hash',
                  hash: createHash('sha256').update(serialized, 'utf8').digest('hex'),
                },
          } as MessageEvent),
        )
      }
    },
  }
})
afterEach(() => {
  hashCalls.serialized = []
  hashCalls.terminated = 0
  vi.restoreAllMocks()
})

const transportId = 'native-transport'
function owned(revision = 4, text = 'Exact café 漢字 🧪\r\n  \ud800\udfff'): Thread[] {
  const threads = readThreads([
    {
      id: 'session',
      profileId: 'profile',
      provider: 'codex',
      remoteId: 'native-thread',
      workspace: '/workspace',
      title: 'Exact title',
      updatedAt: revision,
      model: '',
      mode: 'review',
      turn: 1,
      busy: true,
      pending: [],
      messages: [
        { id: 'message', role: 'assistant', text, turn: 1 },
        null,
        17,
        { role: 'future-role', opaque: { text, scalar: false } },
      ],
      futureThread: { values: [null, false, 81], text },
      nativeRecovery: {
        [transportId]: { appliedRevision: revision, snapshotToken: 'snapshot', ownerGeneration: 2 },
      },
    },
  ])
  registerNativeProjectionDelivery(threads[0], {
    type: 'text',
    sessionId: 'session',
    text: '',
    nativeRecovery: {
      transportId,
      revision,
      eventId: `event-${revision}`,
      ownerGeneration: 2,
      localTurn: 1,
      snapshotToken: 'snapshot',
      emittedAt: revision,
      deliveryToken: 'native-document-token',
    },
  } as AgentEvent)
  return threads
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
function context(initial = owned(), prepare?: NativePrepareRecoveryCache) {
  let threads = initial
  const cache = storage()
  const save = vi.fn(
    async (
      _threads: unknown[],
      _savedAt?: number,
      _admissions?: readonly ConversationProjectionAdmission[],
    ): Promise<void> => {
      throw new Error('Disk checkpoint unavailable')
    },
  )
  const onError = vi.fn()
  const persistence = new ConversationHistoryPersistence({
    getThreads: () => threads,
    getNativeSave: () => save,
    getPrepareRecoveryCache: () => prepare,
    getStorage: () => cache,
    onError,
    enabled: () => true,
  })
  return {
    cache,
    save,
    onError,
    persistence,
    change: (next: Thread[]) => {
      threads = next
    },
  }
}
function gate<T>() {
  let resolve!: (value: T) => void
  const promise = new Promise<T>((accept) => {
    resolve = accept
  })
  return { promise, resolve }
}

describe('native-owned main cache write-ahead recovery', () => {
  it('prepares the exact fallback bytes before Storage and keeps opaque history outside metadata', async () => {
    const prepared = new Map<string, readonly ConversationProjectionAdmission[]>()
    let cachedAtPrepare: string | null = 'not-called'
    const prepare = vi.fn<NativePrepareRecoveryCache>(async (input) => {
      cachedAtPrepare = c.cache.getItem(CONVERSATION_HISTORY_KEY)
      prepared.set(input.hash, input.projectionAdmissions)
    })
    const exact = '  Prompt\r\n café 漢字 👩🏽‍💻 \ud800 \udfff  '
    const c = context(owned(4, exact), prepare)
    expect(await c.persistence.flush()).toBe(true)
    expect(cachedAtPrepare).toBeNull()
    const serialized = c.cache.values.get(CONVERSATION_HISTORY_KEY)!
    const hash = createHash('sha256').update(serialized, 'utf8').digest('hex')
    expect(prepare).toHaveBeenCalledExactlyOnceWith({
      snapshotId: expect.stringMatching(/^main-cache:\d+:/),
      hash,
      savedAt: expect.any(Number),
      projectionAdmissions: nativeProjectionAdmissions(owned(4, exact)),
    })
    expect(hashCalls.serialized).toEqual([serialized])
    expect(JSON.parse(serialized)[0].futureThread).toEqual({
      values: [null, false, 81],
      text: exact,
    })
    expect(JSON.parse(serialized)[0].messages.slice(1)).toEqual([
      null,
      17,
      { role: 'future-role', opaque: { text: exact, scalar: false } },
    ])
    expect(serialized).not.toContain('deliveryToken')
    expect(serialized).not.toContain('projectionAdmissions')
    // A hard renderer exit here would lose an ACK, but the prepared exact
    // hash can still attest only the subsequent actual Storage read.
    const cold = readCachedConversationHistory(c.cache)
    expect(getCachedConversationRowRecovery(cold.threads[0])).toBeUndefined()
    const proof = await getCachedConversationHistoryRecovery(cold)
    expect(proof?.hash).toBe(hash)
    expect(proof?.rows[0]).toBe(cold.threads[0])
    for (const admission of prepared.get(proof!.hash)!)
      registerNativeProjectionMainCacheBaseline(cold.threads[0], admission)
    expect(nativeProjectionAdmissions(cold.threads)).toEqual(prepared.get(hash))
  })

  it('a prepared-but-unwritten newer cache selects the older actual bytes on cold read', async () => {
    const preparations = new Map<string, readonly ConversationProjectionAdmission[]>()
    const prepare = vi.fn<NativePrepareRecoveryCache>(async (input) => {
      preparations.set(input.hash, input.projectionAdmissions)
    })
    const c = context(owned(4, 'older exact bytes'), prepare)
    expect(await c.persistence.flush()).toBe(true)
    const older = c.cache.values.get(CONVERSATION_HISTORY_KEY)!
    c.change(owned(5, 'new prepared bytes'))
    c.cache.setItem.mockImplementationOnce(() => {
      throw new Error('Process exited before actual setItem')
    })
    expect(await c.persistence.flush()).toBe(false)
    expect(prepare).toHaveBeenCalledTimes(2)
    const cold = readCachedConversationHistory(c.cache)
    const proof = await getCachedConversationHistoryRecovery(cold)
    expect(proof?.hash).toBe(createHash('sha256').update(older).digest('hex'))
    expect(proof?.hash).not.toBe(prepare.mock.calls[1][0].hash)
    for (const admission of preparations.get(proof!.hash)!)
      registerNativeProjectionMainCacheBaseline(cold.threads[0], admission)
    expect(nativeProjectionAdmissions(cold.threads)?.[0].appliedRevision).toBe(4)
  })

  it('recovers a written cache after a crash before the marker despite future-dated native metadata', async () => {
    const preparations = new Map<
      string,
      {
        projectionAdmissions: readonly ConversationProjectionAdmission[]
        savedAt: number
      }
    >()
    const c = context(owned(5, 'latest exact fallback'), async (input) => {
      preparations.set(input.hash, {
        projectionAdmissions: input.projectionAdmissions,
        savedAt: input.savedAt,
      })
    })
    c.cache.setItem.mockImplementation((key, value) => {
      if (key !== CONVERSATION_HISTORY_KEY) throw new Error('Renderer exited before marker write')
      c.cache.values.set(key, value)
    })
    expect(await c.persistence.flush()).toBe(false)
    const cold = readCachedConversationHistory(c.cache)
    expect(cold.savedAt).toBeUndefined()
    const nativeRows = owned(4, 'older native history')
    nativeRows[0].updatedAt = 9_999_999_999_999
    const native: ConversationHistorySnapshot = { version: 1, savedAt: 500, threads: nativeRows }
    markNormalizedConversationHistory(native)
    expect(reconcileConversationHistory(native, cold)[0]).toBe(nativeRows[0])
    const actual = await attestCachedConversationHistoryRecovery(cold, async ({ hash }) =>
      preparations.get(hash)!,
    )
    for (const admission of actual!.projectionAdmissions)
      registerNativeProjectionMainCacheBaseline(cold.threads[0], admission)
    expect(cold.savedAt).toBeUndefined()
    expect(getEffectiveCachedConversationHistorySavedAt(cold)).toBe(actual!.savedAt)
    expect(await getCachedConversationHistoryRecovery(cold)).toBeDefined()
    const recovered = reconcileConversationHistory(native, cold)
    expect(recovered[0]).toBe(cold.threads[0])
    expect(recovered[0].messages[0].text).toBe('latest exact fallback')
    expect(getConversationSourceRaw(recovered[0]).messages.slice(1)).toEqual([
      null,
      17,
      { role: 'future-role', opaque: { text: 'latest exact fallback', scalar: false } },
    ])
  })

  it('cache attestation with mismatched native tuples cannot grant a checkpoint clock', async () => {
    const c = context(
      owned(5, 'cache projection'),
      vi.fn<NativePrepareRecoveryCache>().mockResolvedValue(undefined),
    )
    await c.persistence.flush()
    c.cache.values.delete('life.conversation-checkpoint.v1')
    const cold = readCachedConversationHistory(c.cache)
    for (const change of [
      (admission: ConversationProjectionAdmission) => {
        admission.sessionId = 'foreign'
      },
      (admission: ConversationProjectionAdmission) => {
        admission.transportId = 'foreign-transport'
      },
      (admission: ConversationProjectionAdmission) => {
        admission.ownerGeneration = 3
      },
      (admission: ConversationProjectionAdmission) => {
        admission.snapshotToken = 'different-snapshot'
      },
    ]) {
      const admission = nativeProjectionAdmissions(owned(5, 'cache projection'))![0]
      change(admission)
      const actual = await attestCachedConversationHistoryRecovery(cold, async () => ({
        projectionAdmissions: [admission],
        savedAt: 10_000,
      }))
      expect(actual?.savedAt).toBeUndefined()
      expect(getEffectiveCachedConversationHistorySavedAt(cold)).toBeUndefined()
      const nativeRows = owned(4, 'native remains authoritative')
      nativeRows[0].updatedAt = 9_999_999_999_999
      const native: ConversationHistorySnapshot = { version: 1, savedAt: 500, threads: nativeRows }
      markNormalizedConversationHistory(native)
      expect(reconcileConversationHistory(native, cold)[0]).toBe(nativeRows[0])
    }
  })

  it.each(['user', 'error'] as const)(
    'restores a newer authored %s row at the same native cursor after a marker-write crash',
    async (role) => {
      const before = owned(4, 'Covered native output')[0]
      const exact = '  Exact authored row\r\n\tΩ 🧪  '
      const after = {
        ...before,
        busy: false,
        messages: [...before.messages, { id: 'authored-row', role, text: exact, turn: 1 }],
      }
      carryNativeProjectionAuthoredTransition(
        before,
        after,
        role === 'user' ? 'authored-row' : undefined,
      )
      const preparations = new Map<
        string,
        {
          projectionAdmissions: readonly ConversationProjectionAdmission[]
          savedAt: number
        }
      >()
      const c = context([after], async (input) => {
        preparations.set(input.hash, {
          projectionAdmissions: input.projectionAdmissions,
          savedAt: input.savedAt,
        })
      })
      c.cache.setItem.mockImplementation((key, value) => {
        if (key !== CONVERSATION_HISTORY_KEY) throw new Error('Exited before marker commit')
        c.cache.values.set(key, value)
      })
      expect(await c.persistence.flush()).toBe(false)
      const cold = readCachedConversationHistory(c.cache)
      expect(cold.savedAt).toBeUndefined()
      const nativeRows = owned(4, 'Covered native output')
      nativeRows[0].updatedAt = 9_999_999_999_999
      const native: ConversationHistorySnapshot = { version: 1, savedAt: 500, threads: nativeRows }
      markNormalizedConversationHistory(native)
      expect(reconcileConversationHistory(native, cold)[0]).toBe(nativeRows[0])
      const actual = await attestCachedConversationHistoryRecovery(cold, async ({ hash }) =>
        preparations.get(hash)!,
      )
      expect(actual?.projectionAdmissions[0].appliedRevision).toBe(4)
      expect(nativeRows[0].nativeRecovery![transportId].appliedRevision).toBe(4)
      const recovered = reconcileConversationHistory(native, cold)
      expect(recovered[0]).toBe(cold.threads[0])
      expect(recovered[0].messages.at(-1)).toMatchObject({ id: 'authored-row', role, text: exact })
      expect(cold.savedAt).toBeUndefined()
      expect(getEffectiveCachedConversationHistorySavedAt({ ...cold })).toBeUndefined()
      const exported = JSON.parse(JSON.stringify(cold))
      expect(getEffectiveCachedConversationHistorySavedAt(exported)).toBeUndefined()
      expect(exported.savedAt).toBeUndefined()
    },
  )

  it('restores newer deletion membership at the same native cursor using only the native-bound clock', async () => {
    const preparations = new Map<
      string,
      {
        projectionAdmissions: readonly ConversationProjectionAdmission[]
        savedAt: number
      }
    >()
    const c = context(owned(4, 'Unchanged native output'), async (input) => {
      preparations.set(input.hash, {
        projectionAdmissions: input.projectionAdmissions,
        savedAt: input.savedAt,
      })
    })
    c.cache.setItem.mockImplementation((key, value) => {
      if (key !== CONVERSATION_HISTORY_KEY) throw new Error('Exited before marker commit')
      c.cache.values.set(key, value)
    })
    expect(await c.persistence.flush()).toBe(false)
    const cold = readCachedConversationHistory(c.cache)
    const nativeRows = owned(4, 'Unchanged native output')
    nativeRows[0].updatedAt = 9_999_999_999_999
    const deleted = readThreads([
      {
        id: 'deleted',
        profileId: 'profile',
        provider: 'claude',
        title: 'Explicitly removed archive',
        updatedAt: 100,
        messages: [],
        opaque: { retained: [null, true, 17] },
      },
    ])[0]
    const native: ConversationHistorySnapshot = {
      version: 1,
      savedAt: 500,
      threads: [...nativeRows, deleted],
    }
    markNormalizedConversationHistory(native)
    expect(reconcileConversationHistory(native, cold).map((row) => row.id)).toEqual([
      'session',
      'deleted',
    ])
    const actual = await attestCachedConversationHistoryRecovery(cold, async ({ hash }) =>
      preparations.get(hash)!,
    )
    expect(actual?.projectionAdmissions[0].appliedRevision).toBe(4)
    expect(reconcileConversationHistory(native, cold).map((row) => row.id)).toEqual(['session'])
    expect(reconcileConversationHistory(native, { ...cold }).map((row) => row.id)).toEqual([
      'session',
      'deleted',
    ])
  })

  it('native-bound clocks become unavailable after exact cached graph mutation', async () => {
    const c = context(owned(), vi.fn<NativePrepareRecoveryCache>().mockResolvedValue(undefined))
    await c.persistence.flush()
    c.cache.values.delete('life.conversation-checkpoint.v1')
    const cold = readCachedConversationHistory(c.cache)
    const actual = await attestCachedConversationHistoryRecovery(cold, async () => ({
      projectionAdmissions: nativeProjectionAdmissions(owned())!,
      savedAt: 10_000,
    }))
    expect(actual?.savedAt).toBe(10_000)
    expect(getEffectiveCachedConversationHistorySavedAt(cold)).toBe(10_000)
    cold.threads[0].messages[0].text = 'Changed after attestation'
    expect(getEffectiveCachedConversationHistorySavedAt(cold)).toBeUndefined()
    expect(getCachedConversationRowRecovery(cold.threads[0])).toBeUndefined()
  })

  it('retains matching projection authority when identical fallback bytes have ambiguous prepared clocks', async () => {
    const prepared: Parameters<NativePrepareRecoveryCache>[0][] = []
    const c = context(owned(), async (input) => {
      prepared.push(input)
    })
    expect(await c.persistence.flush()).toBe(true)
    expect(await c.persistence.flush()).toBe(true)
    expect(prepared).toHaveLength(2)
    expect(prepared[0].hash).toBe(prepared[1].hash)
    expect(prepared[0].savedAt).toBeLessThan(prepared[1].savedAt)
    const cold = readCachedConversationHistory(c.cache)
    const actual = await attestCachedConversationHistoryRecovery(cold, async () => ({
      projectionAdmissions: prepared[1].projectionAdmissions,
    }))
    expect(actual?.savedAt).toBeUndefined()
    expect(getEffectiveCachedConversationHistorySavedAt(cold)).toBe(prepared[1].savedAt)
    for (const admission of actual!.projectionAdmissions)
      registerNativeProjectionMainCacheBaseline(cold.threads[0], admission)
    expect(nativeProjectionAdmissions(cold.threads)).toEqual(prepared[1].projectionAdmissions)
    // Losing the optional marker does not manufacture a unique clock, and
    // exact native projection authority still remains available independently.
    c.cache.values.delete('life.conversation-checkpoint.v1')
    const unmarked = readCachedConversationHistory(c.cache)
    const noClock = await attestCachedConversationHistoryRecovery(unmarked, async () => ({
      projectionAdmissions: prepared[1].projectionAdmissions,
    }))
    expect(getEffectiveCachedConversationHistorySavedAt(unmarked)).toBeUndefined()
    for (const admission of noClock!.projectionAdmissions)
      registerNativeProjectionMainCacheBaseline(unmarked.threads[0], admission)
    expect(nativeProjectionAdmissions(unmarked.threads)).toEqual(prepared[1].projectionAdmissions)
  })

  it('preparation failure retains ordinary exact archives without granting native authority', async () => {
    const prepare = vi.fn<NativePrepareRecoveryCache>(async () => {
      throw new Error('Native ledger unavailable')
    })
    const c = context(owned(), prepare)
    expect(await c.persistence.flush()).toBe(true)
    expect(prepare).toHaveBeenCalledOnce()
    const cold = readCachedConversationHistory(c.cache)
    expect(cold.threads[0].messages[0].text).toBe(owned()[0].messages[0].text)
    expect(nativeProjectionAdmissions(cold.threads)).toBeUndefined()
    expect((await getCachedConversationHistoryRecovery(cold))?.hash).toHaveLength(64)
    // The getter is an origin, not an admission; native attestation must return
    // an actual matching preparation before the row binder can mint a cursor.
    registerNativeProjectionMainCacheBaseline(cold.threads[0], undefined)
    expect(nativeProjectionAdmissions(cold.threads)).toBeUndefined()
  })

  it('a held older preparation cannot overwrite a newer terminal cache intent', async () => {
    const entered = gate<void>()
    const release = gate<void>()
    const prepare = vi
      .fn<NativePrepareRecoveryCache>()
      .mockImplementationOnce(async () => {
        entered.resolve()
        await release.promise
      })
      .mockResolvedValue(undefined)
    const c = context(owned(4, 'old streaming prefix'), prepare)
    const older = c.persistence.flush()
    await entered.promise
    c.change(owned(5, 'complete latest text'))
    const newer = c.persistence.flush()
    expect(c.cache.setItem).not.toHaveBeenCalled()
    release.resolve()
    expect(await Promise.all([older, newer])).toEqual([true, true])
    const written = c.cache.setItem.mock.calls.filter(([key]) => key === CONVERSATION_HISTORY_KEY)
    expect(written).toHaveLength(1)
    expect(JSON.parse(written[0][1])[0].messages[0].text).toBe('complete latest text')
    expect(JSON.parse(written[0][1])[0].nativeRecovery[transportId].appliedRevision).toBe(5)
  })

  it('a newer native success fences an older asynchronous cache preparation', async () => {
    const entered = gate<void>()
    const release = gate<void>()
    const prepare = vi.fn<NativePrepareRecoveryCache>(async () => {
      entered.resolve()
      await release.promise
    })
    const c = context(owned(), prepare)
    const older = c.persistence.flush()
    await entered.promise
    c.save.mockResolvedValueOnce(undefined)
    c.change(owned(5, 'latest native success'))
    const newer = c.persistence.flush()
    release.resolve()
    expect(await Promise.all([older, newer])).toEqual([true, true])
    expect(c.cache.setItem).not.toHaveBeenCalled()
    expect(hashCalls.serialized).toHaveLength(1)
  })

  it('successful native primary persistence does not hash, prepare, read, or write a fallback', async () => {
    const prepare = vi.fn<NativePrepareRecoveryCache>()
    const c = context(owned(), prepare)
    c.save.mockResolvedValue(undefined)
    expect(await c.persistence.flush()).toBe(true)
    expect(c.cache.getItem).not.toHaveBeenCalled()
    expect(c.cache.setItem).not.toHaveBeenCalled()
    expect(hashCalls.serialized).toEqual([])
    expect(prepare).not.toHaveBeenCalled()
  })

  it('unowned archives keep their existing fallback behavior without hashing or native preparation', async () => {
    const imported = readThreads(JSON.parse(JSON.stringify(owned())))
    const prepare = vi.fn<NativePrepareRecoveryCache>()
    const c = context(imported, prepare)
    expect(await c.persistence.flush()).toBe(true)
    expect(c.cache.setItem).toHaveBeenCalledTimes(2)
    expect(hashCalls.serialized).toEqual([])
    expect(prepare).not.toHaveBeenCalled()
  })

  it('generic JSON imports, wrapper clones, row clones, and changed cursors cannot acquire cache provenance', async () => {
    const c = context(owned(), vi.fn<NativePrepareRecoveryCache>().mockResolvedValue(undefined))
    await c.persistence.flush()
    const cold = readCachedConversationHistory(c.cache)
    const row = cold.threads[0]
    expect(await getCachedConversationHistoryRecovery({ ...cold })).toBeUndefined()
    expect(
      await getCachedConversationHistoryRecovery({
        threads: readThreads(JSON.parse(c.cache.values.get(CONVERSATION_HISTORY_KEY)!)),
      }),
    ).toBeUndefined()
    expect(await getCachedConversationHistoryRecovery(cold)).toBeDefined()
    expect(getCachedConversationRowRecovery({ ...row })).toBeUndefined()
    row.nativeRecovery![transportId].appliedRevision++
    expect(getCachedConversationRowRecovery(row)).toBeUndefined()
    expect(await getCachedConversationHistoryRecovery(cold)).toBeUndefined()
  })

  it('a normalized message-array replacement or native owner edit invalidates actual cached row origin', async () => {
    const c = context(owned(), vi.fn<NativePrepareRecoveryCache>().mockResolvedValue(undefined))
    await c.persistence.flush()
    const cold = readCachedConversationHistory(c.cache)
    await getCachedConversationHistoryRecovery(cold)
    const row = cold.threads[0]
    row.messages = [...row.messages]
    expect(getCachedConversationRowRecovery(row)).toBeUndefined()
    const again = readCachedConversationHistory(c.cache)
    await getCachedConversationHistoryRecovery(again)
    again.threads[0].workspace = '/different'
    expect(getCachedConversationRowRecovery(again.threads[0])).toBeUndefined()
  })

  it.each([
    [
      'in-place rendered text',
      (row: Thread) => {
        row.messages[0].text = 'Changed projected prompt'
      },
    ],
    [
      'same-array push',
      (row: Thread) => {
        row.messages.push({ id: 'forged', role: 'assistant', text: 'Injected', turn: 1 })
      },
    ],
    [
      'same-array splice',
      (row: Thread) => {
        row.messages.splice(0, 1)
      },
    ],
    [
      'nested raw opaque field',
      (row: Thread) => {
        const raw = getConversationSourceRaw(row) as unknown as {
          messages: { opaque?: { scalar: boolean } }[]
        }
        raw.messages[3].opaque!.scalar = true
      },
    ],
    [
      'nested raw cursor',
      (row: Thread) => {
        getConversationSourceRaw(row).nativeRecovery![transportId].appliedRevision++
      },
    ],
    [
      'rendered field enumerability',
      (row: Thread) => {
        Object.defineProperty(row.messages[0], 'text', { enumerable: false })
      },
    ],
    [
      'raw opaque field enumerability',
      (row: Thread) => {
        const raw = getConversationSourceRaw(row) as unknown as {
          messages: { opaque?: { scalar: boolean } }[]
        }
        Object.defineProperty(raw.messages[3].opaque!, 'scalar', { enumerable: false })
      },
    ],
  ] as const)(
    'invalidates exact cached-byte authority after %s mutation',
    async (_label, mutate) => {
      const c = context(owned(), vi.fn<NativePrepareRecoveryCache>().mockResolvedValue(undefined))
      await c.persistence.flush()
      const cold = readCachedConversationHistory(c.cache)
      await getCachedConversationHistoryRecovery(cold)
      expect(getCachedConversationRowRecovery(cold.threads[0])).toBeDefined()
      mutate(cold.threads[0])
      expect(getCachedConversationRowRecovery(cold.threads[0])).toBeUndefined()
      expect(await getCachedConversationHistoryRecovery(cold)).toBeUndefined()
      const admission = nativeProjectionAdmissions(owned())![0]
      registerNativeProjectionMainCacheBaseline(cold.threads[0], admission)
      expect(nativeProjectionAdmissions(cold.threads)).toBeUndefined()
    },
  )

  it('keeps readable literal-surrogate text archival but refuses ambiguous UTF-8 hash authority', async () => {
    const c = storage()
    const encoded = JSON.stringify(owned(4, 'actual \ufffd content'))
    c.values.set(CONVERSATION_HISTORY_KEY, encoded.replace('\ufffd', '\ud800'))
    const cold = readCachedConversationHistory(c)
    expect(cold.threads[0].messages[0].text).toBe('actual \ud800 content')
    expect(await getCachedConversationHistoryRecovery(cold)).toBeUndefined()
    expect(getCachedConversationRowRecovery(cold.threads[0])).toBeUndefined()
  })
})
