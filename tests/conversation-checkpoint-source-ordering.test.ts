import { afterEach, describe, expect, it, vi } from 'vitest'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import type { ConversationCheckpointInput } from '../src/shared/conversations'
import { ConversationCheckpointEngine } from '../src/main/conversation-checkpoint-engine'
import { runEffect } from '../src/main/effect-runtime'
import {
  ConversationCheckpointClient,
  createHistorySnapshotProjector,
} from '../src/renderer/conversation-checkpoint-client'
import { readThreads, type Thread } from '../src/renderer/state'
import { acknowledgeConversationSources } from '../src/renderer/conversation-source'

type Bridge = 'checkpoint' | 'legacy full save'
type RawThread = Record<string, unknown> & {
  id: string
  profileId: string
  provider: 'codex' | 'claude'
  messages: Record<string, unknown>[]
  queue?: Record<string, unknown>[]
}
const directories: string[] = []

afterEach(async () => {
  await Promise.all(
    directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })),
  )
})

function deferred() {
  let resolve!: () => void
  let reject!: (error: unknown) => void
  const promise = new Promise<void>((done, fail) => {
    resolve = done
    reject = fail
  })
  return { promise, resolve, reject }
}

function rawThread(): RawThread {
  return {
    id: 'thread',
    profileId: 'workspace',
    provider: 'codex',
    workspace: '/exact/project',
    remoteId: 'native-session-Ω',
    title: 'Source ordering',
    mode: 'future-mode',
    model: '',
    turn: 1,
    updatedAt: 100,
    busy: false,
    pending: [],
    futureThreadField: {
      exact: '  Opaque\r\n\tUnicode café e\u0301 漢字 🧪  ',
      values: [null, true],
    },
    messages: [
      {
        id: 'message',
        role: 'user',
        text: '  Exact prompt\r\n\tUnicode café e\u0301 漢字 🧪  ',
        turn: 1,
        futureMessageField: { retained: true },
      },
    ],
  }
}

async function fixture(bridge: Bridge, initial = rawThread(), holdSecond = false) {
  const directory = await mkdtemp(join(tmpdir(), 'life-checkpoint-source-order-'))
  directories.push(directory)
  const engine = new ConversationCheckpointEngine(directory)
  await runEffect(engine.saveEffect([initial], 100))
  const loaded = (await runEffect(engine.loadEffect()))!
  const raw = loaded.threads[0] as RawThread
  const restored = readThreads(loaded.threads)[0]
  const snapshot = createHistorySnapshotProjector()
  const client = new ConversationCheckpointClient()
  const first = deferred()
  const firstStarted = deferred()
  const second = deferred()
  const secondStarted = deferred()
  const save = vi.fn(async (history: unknown[], savedAt?: number) => {
    if (savedAt === 200) {
      firstStarted.resolve()
      await first.promise
    }
    if (savedAt === 300 && holdSecond) {
      secondStarted.resolve()
      await second.promise
    }
    await runEffect(engine.saveEffect(history, savedAt!))
  })
  const checkpoint = vi.fn(async (input: ConversationCheckpointInput) => {
    if (input.savedAt === 200) {
      firstStarted.resolve()
      await first.promise
    }
    return runEffect(engine.checkpointEffect(input))
  })
  if (bridge === 'checkpoint')
    expect(
      client.adoptDurableBaseline(snapshot([restored]), 100, save, checkpoint, {
        supportsMessageFields: true,
      }),
    ).toBe(true)
  const submit = (history: Thread[], savedAt: number) =>
    client.submit(history, savedAt, save, bridge === 'checkpoint' ? checkpoint : undefined, {
      supportsMessageFields: true,
    })
  const reload = () => runEffect(new ConversationCheckpointEngine(directory).loadEffect())
  return {
    directory,
    engine,
    raw,
    restored,
    snapshot,
    submit,
    first,
    firstStarted,
    second,
    secondStarted,
    save,
    checkpoint,
    reload,
  }
}

describe('source acknowledgements follow native write ordering', () => {
  it.each(['checkpoint', 'legacy full save'] as const)(
    'refreshes an already queued explicit mode reversion after the preceding %s succeeds',
    async (bridge) => {
      const test = await fixture(bridge)
      expect(test.restored.mode).toBe('review')
      const firstView: Thread = { ...test.restored, mode: 'full-access' }
      const secondView: Thread = { ...firstView, mode: 'review' }
      const firstHistory = test.snapshot([firstView])
      const first = test.submit(firstHistory, 200)
      await test.firstStarted.promise
      const queuedHistory = test.snapshot([secondView])
      expect(queuedHistory[0].mode).toBe('future-mode')
      const second = test.submit(queuedHistory, 300)
      expect((await runEffect(test.engine.loadEffect()))?.savedAt).toBe(100)
      expect(test.snapshot([secondView])[0].mode).toBe('future-mode')
      if (bridge === 'checkpoint') {
        expect(test.save).not.toHaveBeenCalled()
        expect(test.checkpoint).toHaveBeenCalledTimes(1)
        expect(test.checkpoint.mock.calls[0][0].upserts[0].thread.mode).toBe('full-access')
      } else {
        expect(test.save).toHaveBeenCalledTimes(1)
        expect((test.save.mock.calls[0][0][0] as RawThread).mode).toBe('full-access')
      }
      test.first.resolve()
      expect(await Promise.all([first, second])).toEqual([200, 300])
      if (bridge === 'checkpoint') {
        expect(test.save).not.toHaveBeenCalled()
        expect(test.checkpoint).toHaveBeenCalledTimes(2)
        expect(test.checkpoint.mock.calls[1][0]).toMatchObject({
          baseSavedAt: 200,
          savedAt: 300,
          upserts: [{ thread: { mode: 'review' } }],
        })
      } else {
        expect(test.checkpoint).not.toHaveBeenCalled()
        expect(test.save).toHaveBeenCalledTimes(2)
        expect((test.save.mock.calls[1][0][0] as RawThread).mode).toBe('review')
      }
      const expected = { version: 1, savedAt: 300, threads: [{ ...test.raw, mode: 'review' }] }
      expect(await test.reload()).toEqual(expected)
      expect(
        JSON.parse(await readFile(join(test.directory, 'conversations.json'), 'utf8')),
      ).toEqual(expected)
      expect(test.snapshot([secondView])).toEqual(expected.threads)
      expect(queuedHistory[0].mode).toBe('future-mode')
      expect(test.raw.mode).toBe('future-mode')
    },
  )

  it.each(['checkpoint', 'legacy full save'] as const)(
    'retains the original source when a %s fails before the queued mode reversion',
    async (bridge) => {
      const test = await fixture(bridge, rawThread(), true)
      const originalBytes = await readFile(join(test.directory, 'conversations.json'), 'utf8')
      const firstView: Thread = { ...test.restored, mode: 'full-access' }
      const secondView: Thread = { ...firstView, mode: 'review' }
      const first = test.submit(test.snapshot([firstView]), 200)
      await test.firstStarted.promise
      const queuedHistory = test.snapshot([secondView])
      expect(queuedHistory[0].mode).toBe('future-mode')
      const second = test.submit(queuedHistory, 300)
      const failure = new Error('Native disk write failed')
      const rejected = expect(first).rejects.toBe(failure)
      test.first.reject(failure)
      await rejected
      await test.secondStarted.promise
      expect(await readFile(join(test.directory, 'conversations.json'), 'utf8')).toBe(originalBytes)
      expect(await runEffect(test.engine.loadEffect())).toEqual({
        version: 1,
        savedAt: 100,
        threads: [test.raw],
      })
      expect(test.snapshot([test.restored])).toEqual([test.raw])
      expect(test.snapshot([secondView])[0].mode).toBe('future-mode')
      const latestSave = test.save.mock.calls.at(-1)!
      expect(latestSave[1]).toBe(300)
      expect(latestSave[0]).toEqual([test.raw])
      test.second.resolve()
      expect(await second).toBe(300)
      expect(await test.reload()).toEqual({ version: 1, savedAt: 300, threads: [test.raw] })
      expect(test.snapshot([secondView])[0].mode).toBe('future-mode')
      if (bridge === 'checkpoint') expect(test.checkpoint).toHaveBeenCalledTimes(1)
    },
  )

  it.each(['checkpoint', 'legacy full save'] as const)(
    'refreshes a queued mode reversion after a failed %s reaches synchronous caller recovery',
    async (bridge) => {
      const test = await fixture(bridge, rawThread(), true)
      const firstView: Thread = { ...test.restored, mode: 'full-access' }
      const secondView: Thread = { ...firstView, mode: 'review' }
      const firstHistory = test.snapshot([firstView])
      const first = test.submit(firstHistory, 200)
      await test.firstStarted.promise
      const queuedHistory = test.snapshot([secondView])
      expect(queuedHistory[0].mode).toBe('future-mode')
      const second = test.submit(queuedHistory, 300)
      let recoveryCache: string | undefined
      const recovered = first.catch(() => {
        recoveryCache = JSON.stringify(firstHistory)
        acknowledgeConversationSources(firstHistory, 200)
      })
      test.first.reject(new Error('Native write failed before synchronous recovery'))
      await recovered
      await test.secondStarted.promise
      expect(JSON.parse(recoveryCache!)[0].mode).toBe('full-access')
      const latestSave = test.save.mock.calls.at(-1)!
      expect(latestSave[1]).toBe(300)
      expect((latestSave[0][0] as RawThread).mode).toBe('review')
      test.second.resolve()
      expect(await second).toBe(300)
      expect(await test.reload()).toEqual({
        version: 1,
        savedAt: 300,
        threads: [{ ...test.raw, mode: 'review' }],
      })
      expect(test.snapshot([secondView])[0].mode).toBe('review')
      expect(queuedHistory[0].mode).toBe('future-mode')
    },
  )

  it.each(['checkpoint', 'legacy full save'] as const)(
    'keeps distinct request views when a %s shares the same projected raw record',
    async (bridge) => {
      const raw = rawThread()
      raw.queue = [
        {
          id: 'queued',
          text: '  Exact queued prompt\r\n🧪  ',
          createdAt: 100,
          attachments: [],
          paused: false,
          futureQueuedField: { retained: true },
        },
      ]
      const test = await fixture(bridge, raw)
      expect(test.restored.queue![0].paused).toBe(true)
      const firstView: Thread = {
        ...test.restored,
        queue: [{ ...test.restored.queue![0], paused: false }],
      }
      const secondView: Thread = {
        ...firstView,
        queue: [{ ...firstView.queue![0], paused: true }],
      }
      const firstHistory = test.snapshot([firstView])
      const first = test.submit(firstHistory, 200)
      await test.firstStarted.promise
      const queuedHistory = test.snapshot([secondView])
      expect(queuedHistory).not.toBe(firstHistory)
      expect(queuedHistory[0]).toBe(firstHistory[0])
      expect(queuedHistory[0].queue![0].paused).toBe(false)
      const second = test.submit(queuedHistory, 300)
      test.first.resolve()
      expect(await Promise.all([first, second])).toEqual([200, 300])
      const expected = {
        version: 1,
        savedAt: 300,
        threads: [{ ...test.raw, queue: [{ ...test.raw.queue![0], paused: true }] }],
      }
      expect(await test.reload()).toEqual(expected)
      expect(test.snapshot([secondView])).toEqual(expected.threads)
      expect(queuedHistory[0].queue![0].paused).toBe(false)
      expect(test.raw.queue![0].paused).toBe(false)
      if (bridge === 'checkpoint') {
        expect(test.save).not.toHaveBeenCalled()
        expect(test.checkpoint.mock.calls[0][0].upserts).toEqual([])
        expect(test.checkpoint.mock.calls[1][0].upserts[0].thread.queue).toEqual(
          expected.threads[0].queue,
        )
      } else {
        expect(test.save).toHaveBeenCalledTimes(2)
        expect((test.save.mock.calls[1][0][0] as RawThread).queue).toEqual(
          expected.threads[0].queue,
        )
      }
    },
  )
})
