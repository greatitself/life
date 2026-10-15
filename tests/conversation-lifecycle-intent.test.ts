import { afterEach, describe, expect, it, vi } from 'vitest'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { ConversationCheckpointEngine } from '../src/main/conversation-checkpoint-engine'
import { runEffect } from '../src/main/effect-runtime'
import {
  acknowledgeConversationSources,
  attachConversationSource,
  clearConversationSourceMessages,
  copyConversationSourceJson,
  projectConversationSource,
  projectConversationSourceHistory,
  reconcileConversationLifecycle,
} from '../src/renderer/conversation-source'
import {
  CONVERSATION_HISTORY_KEY,
  ConversationHistoryPersistence,
  readCachedConversationHistory,
} from '../src/renderer/conversation-persistence'
import { applyEvent, readThreads, type Thread } from '../src/renderer/state'
import type { ConversationCheckpointInput } from '../src/shared/conversations'
import type { AgentEvent, Provider } from '../src/shared/types'

type Bridge = 'checkpoint' | 'legacy' | 'cache'
type Outcome = 'completed' | 'interrupted' | 'failed' | 'unknown'
type RawThread = Record<string, unknown> & {
  id: string
  profileId: string
  provider: Provider
  messages: unknown[]
}
const exact = '  Exact follow-up\r\n\tUnicode café e\u0301 漢字 🧪 👩🏽‍💻  \ud83e\r\n\uddea'
const reply = '  Exact response\r\n\tUnicode café e\u0301 漢字 🧪  '
const directories: string[] = []

afterEach(async () => {
  vi.restoreAllMocks()
  await Promise.all(directories.splice(0).map((path) => rm(path, { recursive: true, force: true })))
})

function rawThread(provider: Provider = 'codex'): RawThread {
  return {
    id: 'owned-thread',
    profileId: 'owned-machine',
    provider,
    remoteId: 'exact-native-session-Ω',
    workspace: '/owned/exact project Ω',
    title: 'Recovered native run',
    model: '',
    mode: 'review',
    turn: 2,
    busy: true,
    turnStatus: 'running',
    agentStatus: 'running',
    updatedAt: 100,
    pending: [
      { type: 'approval', sessionId: 'owned-thread', requestId: 'archived-native-request', exact },
    ],
    futureThreadField: { exact, values: [null, true, 17] },
    messages: [
      null,
      { id: 'opaque', role: 'future-native-role', text: exact, futureMessageField: { exact } },
      { id: 'old-user', role: 'user', text: exact, input: exact, turn: 2, futureField: { exact } },
      { id: 'duplicate', role: 'tool', text: 'First', turn: 2, status: 'running' },
      { id: 'duplicate', role: 'tool', text: 'Second', turn: 2, status: 'running' },
      ['future-native-record', { exact }],
    ],
  }
}

function json<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T
}

function begin(restored: Thread): Thread {
  const turn = restored.turn + 1
  return {
    ...restored,
    turn,
    busy: true,
    turnStatus: 'running',
    messages: [
      ...restored.messages,
      { id: 'exact-new-user', role: 'user', text: exact, turn, createdAt: 200 },
    ],
  }
}

function terminal(running: Thread, outcome: Outcome): Thread {
  const streamed = applyEvent(running, {
    type: 'text',
    sessionId: running.id,
    itemId: 'exact-native-reply',
    text: reply,
  })
  return applyEvent(
    streamed,
    outcome === 'failed'
      ? { type: 'error', sessionId: running.id, text: 'Native start failed\r\nΩ' }
      : {
          type: 'complete',
          sessionId: running.id,
          status: outcome === 'unknown' ? 'future-native-terminal-status' : outcome,
        },
  )
}

function deferred() {
  let resolve!: () => void
  let reject!: (error: Error) => void
  const promise = new Promise<void>((done, fail) => {
    resolve = done
    reject = fail
  })
  return { promise, resolve, reject }
}

async function fixture(bridge: Bridge, provider: Provider = 'codex') {
  const directory = await mkdtemp(join(tmpdir(), 'life-lifecycle-intent-'))
  directories.push(directory)
  const raw = rawThread(provider)
  const original = {
    version: 1,
    savedAt: 500,
    futureEnvelopeField: { exact },
    threads: [raw],
  }
  await writeFile(join(directory, 'conversations.json'), JSON.stringify(original))
  const engine = new ConversationCheckpointEngine(directory)
  await runEffect(engine.loadEffect())
  const restored = readThreads([raw])[0]
  let threads = [restored]
  let nativeFailure = false
  let cacheFailure = false
  let nextGate: (ReturnType<typeof deferred> & { started: ReturnType<typeof deferred> }) | undefined
  const values = new Map<string, string>()
  const cache = {
    getItem: (key: string) => values.get(key) ?? null,
    setItem: vi.fn((key: string, value: string) => {
      if (cacheFailure) throw new Error('Recovery storage unavailable')
      values.set(key, value)
    }),
  }
  const beforeNative = async () => {
    const gate = nextGate
    nextGate = undefined
    if (gate) {
      gate.started.resolve()
      await gate.promise
    }
    if (nativeFailure) throw new Error('Native storage unavailable')
  }
  const save = vi.fn(async (history: unknown[], savedAt?: number) => {
    await beforeNative()
    await runEffect(engine.saveEffect(history, savedAt!))
  })
  const checkpoint = vi.fn(async (input: ConversationCheckpointInput) => {
    await beforeNative()
    return runEffect(engine.checkpointEffect(input))
  })
  const onError = vi.fn()
  const persistence = new ConversationHistoryPersistence({
    getThreads: () => threads,
    getNativeSave: () => (bridge === 'cache' ? undefined : save),
    getNativeCheckpoint: () => (bridge === 'checkpoint' ? checkpoint : undefined),
    supportsMessageFields: () => true,
    supportsMessageAppends: () => true,
    getStorage: () => cache,
    onError,
    enabled: () => true,
  })
  if (bridge === 'checkpoint')
    expect(persistence.adoptNativeCheckpoint([raw] as unknown as Thread[], 500, true)).toBe(true)
  const cold = async () => {
    if (bridge === 'cache') return JSON.parse(values.get(CONVERSATION_HISTORY_KEY)!)[0] as RawThread
    const snapshot = await runEffect(new ConversationCheckpointEngine(directory).loadEffect())
    const disk = JSON.parse(await readFile(join(directory, 'conversations.json'), 'utf8'))
    expect(snapshot).toEqual(disk)
    expect(disk.futureEnvelopeField).toEqual(original.futureEnvelopeField)
    return snapshot!.threads[0] as RawThread
  }
  return {
    raw,
    restored,
    engine,
    save,
    checkpoint,
    cache,
    values,
    onError,
    persistence,
    cold,
    change: (next: Thread) => (threads = [next]),
    fail: (native: boolean, storage = false) => {
      nativeFailure = native
      cacheFailure = storage
    },
    holdNext: () => {
      const gate = { ...deferred(), started: deferred() }
      nextGate = gate
      return gate
    },
  }
}

function assertOwnedTerminal(saved: RawThread, original: RawThread, outcome: Outcome) {
  expect(saved).toMatchObject({
    id: original.id,
    provider: original.provider,
    remoteId: original.remoteId,
    profileId: original.profileId,
    workspace: original.workspace,
    busy: false,
    turnStatus: outcome,
    agentStatus: outcome,
    turn: 3,
  })
  expect(saved.futureThreadField).toEqual(original.futureThreadField)
  expect(saved.pending).toEqual(original.pending)
  expect(saved.messages.slice(0, original.messages.length)).toEqual(original.messages)
  const messages = saved.messages as Record<string, unknown>[]
  expect(messages.filter((message) => message?.id === 'exact-new-user')).toEqual([
    expect.objectContaining({ role: 'user', text: exact, turn: 3, finishStatus: outcome }),
  ])
  expect(messages.filter((message) => message?.id === '3:exact-native-reply')).toEqual([
    expect.objectContaining({ role: 'assistant', text: reply, turn: 3, finishStatus: outcome }),
  ])
  expect(readThreads([saved])[0].pending).toEqual([])
}

describe('owned conversation lifecycle projection', () => {
  it('retains opaque unauthored statuses through a later mask mutation and an explicit history clear', () => {
    const raw: RawThread = {
      ...rawThread(),
      turnStatus: { futureTurnState: '  exact\r\n\ud800' },
      agentStatus: { futureAgentState: ['🧪', null, 7] },
    }
    const restored = readThreads([raw])[0]
    const fields: ('busy' | 'turnStatus' | 'agentStatus')[] = ['busy']
    const verifiedIdle = reconcileConversationLifecycle(restored, fields)
    fields.push('turnStatus', 'agentStatus')
    const cleared = clearConversationSourceMessages(verifiedIdle)
    expect(copyConversationSourceJson(cleared)).toMatchObject({
      busy: false,
      turnStatus: raw.turnStatus,
      agentStatus: raw.agentStatus,
      pending: raw.pending,
      messages: [],
    })
    expect(json(projectConversationSource(restored))).toEqual(raw)
  })

  it('copies genuine lifecycle intent through the guarded serializer and rejects a fake token', () => {
    const restored = readThreads([rawThread()])[0]
    const completed = terminal(begin(restored), 'completed')
    expect(copyConversationSourceJson(completed)).toMatchObject({
      busy: false,
      turnStatus: 'completed',
      agentStatus: 'completed',
    })
    const token = Object.getOwnPropertySymbols(completed).find(
      (key) => key.description === 'Life conversation lifecycle intent',
    )!
    expect(token).toBeDefined()
    expect(() => copyConversationSourceJson({ ...completed, [token]: {} })).toThrow(
      'unsupported key',
    )
    expect(() =>
      copyConversationSourceJson({
        ...completed,
        [Symbol('Life conversation lifecycle intent')]: {},
      }),
    ).toThrow('unsupported key')
  })

  it.each(['codex', 'claude'] as const)(
    'keeps passive %s recovery and an unrelated title edit exactly lossless',
    (provider) => {
      const raw = rawThread(provider)
      const recovered = readThreads([raw])[0]
      expect(recovered.busy).toBe(false)
      expect(recovered.turnStatus).toBe('unknown')
      expect(recovered.pending).toEqual([])
      expect(json(projectConversationSource(recovered))).toEqual(raw)
      expect(json(projectConversationSource({ ...recovered, title: 'Only renamed' }))).toEqual({
        ...raw,
        title: 'Only renamed',
      })
    },
  )

  for (const bridge of ['checkpoint', 'legacy', 'cache'] as const)
    for (const provider of ['codex', 'claude'] as const)
      it.each(['completed', 'interrupted', 'failed', 'unknown'] as const)(
        `persists a fast ${provider} %s through ${bridge} before any running acknowledgement`,
        async (outcome) => {
          const test = await fixture(bridge, provider)
          const finished = terminal(begin(test.restored), outcome)
          const renamed = { ...finished, title: 'Owned terminal metadata spread' }
          expect(renamed.busy).toBe(false)
          test.change(renamed)
          expect(await test.persistence.flush()).toBe(true)
          assertOwnedTerminal(await test.cold(), test.raw, outcome)
          expect(bridge === 'checkpoint' ? test.checkpoint : test.save).toHaveBeenCalledTimes(
            bridge === 'cache' ? 0 : 1,
          )
          expect(json(projectConversationSource(renamed)).busy).toBe(false)
          expect(await test.persistence.flush()).toBe(true)
          assertOwnedTerminal(await test.cold(), test.raw, outcome)
        },
      )

  for (const bridge of ['checkpoint', 'legacy', 'cache'] as const)
    it.each(['failed', 'interrupted'] as const)(
      `persists a %s start before any assistant output through ${bridge}`,
      async (outcome) => {
        const test = await fixture(bridge)
        const running = begin(test.restored)
        const failed = applyEvent(
          running,
          outcome === 'failed'
            ? { type: 'error', sessionId: running.id, text: 'Exact start failure\r\nΩ' }
            : { type: 'complete', sessionId: running.id, status: 'interrupted' },
        )
        test.change(failed)
        expect(await test.persistence.flush()).toBe(true)
        const saved = await test.cold()
        expect(saved).toMatchObject({
          busy: false,
          turnStatus: outcome,
          agentStatus: outcome,
          remoteId: test.raw.remoteId,
          workspace: test.raw.workspace,
          profileId: test.raw.profileId,
        })
        expect(saved.messages.slice(0, test.raw.messages.length)).toEqual(test.raw.messages)
        expect(saved.messages).toContainEqual(
          expect.objectContaining({ id: 'exact-new-user', text: exact, finishStatus: outcome }),
        )
        expect(
          saved.messages.some(
            (message) =>
              message &&
              typeof message === 'object' &&
              (message as Record<string, unknown>).role === 'assistant' &&
              (message as Record<string, unknown>).turn === 3,
          ),
        ).toBe(false)
        expect(saved.pending).toEqual(test.raw.pending)
        expect(saved.futureThreadField).toEqual(test.raw.futureThreadField)
      },
    )

  it.each(['checkpoint', 'legacy'] as const)(
    'keeps a newer terminal intent when an older %s running write acknowledges later',
    async (bridge) => {
      const test = await fixture(bridge)
      const running = begin(test.restored)
      const olderHistory = projectConversationSourceHistory([running])
      const gate = test.holdNext()
      test.change(running)
      const runningWrite = test.persistence.flush()
      await gate.started.promise
      const finished = terminal(running, 'completed')
      test.change(finished)
      const finalWrite = test.persistence.flush()
      expect(projectConversationSource(finished).busy).toBe(false)
      gate.resolve()
      expect(await Promise.all([runningWrite, finalWrite])).toEqual([true, true])
      assertOwnedTerminal(await test.cold(), test.raw, 'completed')
      acknowledgeConversationSources(olderHistory, 501)
      expect(projectConversationSource(finished).busy).toBe(false)
      expect(projectConversationSource(finished).turnStatus).toBe('completed')
    },
  )

  it.each(['checkpoint', 'legacy'] as const)(
    'preserves terminal intent after a failed %s running write reaches recovery-cache acknowledgement',
    async (bridge) => {
      const test = await fixture(bridge)
      const running = begin(test.restored)
      const gate = test.holdNext()
      test.change(running)
      const runningWrite = test.persistence.flush()
      await gate.started.promise
      const finished = terminal(running, 'completed')
      test.change(finished)
      const finalWrite = test.persistence.flush()
      gate.reject(new Error('Delayed running disk write failed'))
      expect(await Promise.all([runningWrite, finalWrite])).toEqual([true, true])
      const cached = JSON.parse(test.values.get(CONVERSATION_HISTORY_KEY)!)
      expect(cached[0].busy).toBe(true)
      assertOwnedTerminal(await test.cold(), test.raw, 'completed')
      expect(test.onError).toHaveBeenCalled()
    },
  )

  it('retains exact terminal work through native failure, cache acknowledgement, and a later native retry', async () => {
    const test = await fixture('checkpoint')
    const finished = terminal(begin(test.restored), 'interrupted')
    test.fail(true)
    test.change(finished)
    expect(await test.persistence.flush()).toBe(true)
    const cached = JSON.parse(test.values.get(CONVERSATION_HISTORY_KEY)!)[0]
    assertOwnedTerminal(cached, test.raw, 'interrupted')
    expect(readCachedConversationHistory(test.cache).threads[0].busy).toBe(false)
    expect((await runEffect(test.engine.loadEffect()))!.threads[0]).toEqual(test.raw)
    test.fail(false)
    expect(await test.persistence.flush()).toBe(true)
    assertOwnedTerminal(await test.cold(), test.raw, 'interrupted')
    expect(test.save).toHaveBeenCalledTimes(1)
  })

  it('does not acknowledge either failed destination and retries the same failed-start view', async () => {
    const test = await fixture('checkpoint')
    const failed = terminal(begin(test.restored), 'failed')
    test.fail(true, true)
    test.change(failed)
    expect(await test.persistence.flush()).toBe(false)
    expect(test.values.has(CONVERSATION_HISTORY_KEY)).toBe(false)
    expect((await runEffect(test.engine.loadEffect()))!.threads[0]).toEqual(test.raw)
    expect(projectConversationSource(test.restored)).toEqual(test.raw)
    test.fail(false)
    expect(await test.persistence.flush()).toBe(true)
    assertOwnedTerminal(await test.cold(), test.raw, 'failed')
  })

  it.each([
    { type: 'complete', status: 'completed', agentId: 'child' },
    { type: 'error', text: 'Child failed', agentId: 'child' },
    { type: 'error', text: 'Retrying transport', details: { recoverable: true } },
  ] as const)('does not grant parent terminal intent for $type $agentId', (event) => {
    const raw = rawThread()
    const restored = readThreads([raw])[0]
    const updated = applyEvent(restored, {
      ...event,
      sessionId: restored.id,
    } as AgentEvent)
    const saved = projectConversationSource(updated)
    expect(saved.busy).toBe(true)
    expect(saved.turnStatus).toBe('running')
    expect(saved.pending).toEqual(raw.pending)
    const running = begin(restored)
    expect(applyEvent(running, { ...event, sessionId: running.id } as AgentEvent).busy).toBe(true)
  })

  it.each(['running', 'resumed'] as const)(
    'ignores inherited terminal intent when the same native turn becomes %s',
    (status) => {
      const raw = rawThread()
      const recovered = readThreads([raw])[0]
      const finished = terminal(begin(recovered), 'completed')
      const resumed = applyEvent(finished, { type: 'status', sessionId: finished.id, status })
      const saved = projectConversationSource(resumed)
      expect(saved.busy).toBe(true)
      expect(saved.turnStatus).toBe('running')
      const completedAgain = applyEvent(resumed, { type: 'complete', sessionId: resumed.id })
      expect(projectConversationSource(completedAgain).busy).toBe(false)
    },
  )

  it('does not apply the previous turn token to a later turn or a foreign native owner', () => {
    const restored = readThreads([rawThread()])[0]
    const finished = terminal(begin(restored), 'completed')
    const next = begin(finished)
    expect(projectConversationSource(next).busy).toBe(true)
    expect(projectConversationSource(next).turnStatus).toBe('running')
    const foreign = { ...finished, profileId: 'different-machine', remoteId: 'foreign-session' }
    expect(projectConversationSource(foreign).profileId).toBe('different-machine')
    expect(projectConversationSource(foreign).pending).toEqual([])
    const later = terminal(next, 'interrupted')
    expect(projectConversationSource(later)).toMatchObject({
      busy: false,
      turnStatus: 'interrupted',
    })
  })

  it('cannot admit serialized hints, a forged symbol value, or a real token from another decoded source', () => {
    const raw = rawThread()
    const hint = { source: 'owned-thread', turn: 2, busy: false, turnStatus: 'completed' }
    const archive = { ...raw, lifecycleIntent: hint, __lifeLifecycleIntent: hint }
    const restored = readThreads([json(archive)])[0]
    const fakeSymbol = Symbol('Life conversation lifecycle intent')
    const forged = { ...restored, [fakeSymbol]: hint }
    expect(json(projectConversationSource(forged))).toEqual(archive)
    const valid = reconcileConversationLifecycle({
      ...restored,
      busy: false,
      turnStatus: 'unknown',
      agentStatus: 'running',
    })
    const symbol = Object.getOwnPropertySymbols(valid).find(
      (key) => key.description === 'Life conversation lifecycle intent',
    )!
    const forgedValue = { ...valid, [symbol]: hint }
    expect(json(projectConversationSource(forgedValue))).toEqual(archive)
    const separatelyDecoded = readThreads([json(archive)])[0]
    const transplanted = {
      ...separatelyDecoded,
      [symbol]: (valid as unknown as Record<symbol, unknown>)[symbol],
    }
    expect(json(projectConversationSource(transplanted))).toEqual(archive)
    expect(json(projectConversationSource(readThreads([json(valid)])[0])).busy).toBe(false)
    expect(Object.getOwnPropertySymbols(projectConversationSource(valid))).toEqual([])
  })

  it('requires a fresh lifecycle event after explicitly attaching replacement raw history', () => {
    const raw = rawThread()
    const restored = readThreads([raw])[0]
    const finished = terminal(begin(restored), 'completed')
    expect(projectConversationSource(finished).busy).toBe(false)
    const replacement = { ...raw, turn: finished.turn, messages: json(finished.messages) }
    attachConversationSource(finished, replacement)
    expect(json(projectConversationSource(finished))).toEqual(replacement)
    const admitted = applyEvent(finished, { type: 'complete', sessionId: finished.id })
    expect(projectConversationSource(admitted).busy).toBe(false)
  })

  it('invalidates every cached view when attachment replaces admission with the same raw object', () => {
    const raw = rawThread()
    const restored = readThreads([raw])[0]
    const finished = reconcileConversationLifecycle(restored)
    const descendant = { ...finished, title: 'Cached immutable descendant' }
    expect(projectConversationSource(finished).busy).toBe(false)
    expect(projectConversationSource(descendant).busy).toBe(false)
    attachConversationSource({ ...finished }, raw)
    expect(json(projectConversationSource(finished))).toEqual(raw)
    expect(json(projectConversationSource(descendant))).toEqual({
      ...raw,
      title: descendant.title,
    })
  })

  it.each(['checkpoint', 'legacy', 'cache'] as const)(
    'retains authored terminal fields through a later root status-only observation via %s',
    async (bridge) => {
      const test = await fixture(bridge)
      const finished = terminal(begin(test.restored), 'completed')
      const idle = applyEvent(finished, {
        type: 'status',
        sessionId: finished.id,
        status: 'idle',
      })
      expect(projectConversationSource(idle)).toMatchObject({
        busy: false,
        turnStatus: 'completed',
        agentStatus: 'idle',
      })
      const cleared = clearConversationSourceMessages(idle)
      expect(projectConversationSource(cleared)).toMatchObject({
        busy: false,
        turnStatus: 'completed',
        agentStatus: 'idle',
        messages: [],
      })
      test.change(idle)
      expect(await test.persistence.flush()).toBe(true)
      const saved = await test.cold()
      expect(saved).toMatchObject({ busy: false, turnStatus: 'completed', agentStatus: 'idle' })
      expect(saved.pending).toEqual(test.raw.pending)
      expect(saved.messages.slice(0, test.raw.messages.length)).toEqual(test.raw.messages)
    },
  )

  it.each(['checkpoint', 'legacy'] as const)(
    'keeps terminal intent through an explicit source clear before any %s acknowledgement',
    async (bridge) => {
      const test = await fixture(bridge)
      const finished = terminal(begin(test.restored), 'completed')
      const cleared = clearConversationSourceMessages(finished)
      const renamed = { ...cleared, title: 'Cleared after actual completion' }
      expect(projectConversationSource(renamed)).toMatchObject({
        busy: false,
        turnStatus: 'completed',
        agentStatus: 'completed',
        messages: [],
      })
      test.change(renamed)
      expect(await test.persistence.flush()).toBe(true)
      const saved = await test.cold()
      expect(saved.messages).toEqual([])
      expect(saved.busy).toBe(false)
      expect(saved.pending).toEqual(test.raw.pending)
      expect(saved.futureThreadField).toEqual(test.raw.futureThreadField)
      expect(json(projectConversationSource(test.restored))).toEqual(test.raw)
    },
  )
})
