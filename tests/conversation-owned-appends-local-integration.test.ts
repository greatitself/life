import { afterEach, describe, expect, it, vi } from 'vitest'
import type { ConversationCheckpointInput } from '../src/shared/conversations'
import type { Provider } from '../src/shared/types'
import {
  ConversationCheckpointClient,
  createConversationCheckpointProjector,
  createHistorySnapshotProjector,
} from '../src/renderer/conversation-checkpoint-client'
import { getConversationMessageAppend } from '../src/renderer/conversation-message-appends'
import {
  acknowledgeConversationSources,
  attachConversationSource,
  copyConversationSourceJson,
  hasConversationSource,
} from '../src/renderer/conversation-source'
import { applyEvent, readThreads, type Message, type Thread } from '../src/renderer/state'

type RawThread = Record<string, unknown> & {
  id: string
  profileId: string
  provider: Provider
  messages: unknown[]
}
const capabilities = { supportsMessageFields: true, supportsMessageAppends: true }
const exact = '  Exact native prompt\r\n\tUnicode café e\u0301 漢字 🧪  '
const prefix = '  Settled native response café e\u0301 漢字 🧪\r\n'.repeat(4096) + '\r\ud83e'
const replyId = '1:answer'

afterEach(() => vi.restoreAllMocks())

function rawThread(provider: Provider = 'codex'): RawThread {
  return {
    id: 'owned-local-thread',
    profileId: 'local-machine',
    provider,
    remoteId: 'native-session-Ω',
    workspace: '/owned/project Ω',
    title: 'Recovered native turn',
    gitBranch: 'main',
    mode: 'review',
    model: '',
    turn: 1,
    busy: true,
    turnStatus: 'running',
    agentStatus: 'running',
    updatedAt: 100,
    pending: [{ type: 'approval', sessionId: 'owned-local-thread', requestId: 'archived', exact }],
    futureThreadMetadata: { exact, values: [null, true, 17] },
    messages: [
      { id: 'opaque-native-row', role: 'future-role', text: exact, futureOpaque: { exact } },
      { id: '1:prompt', role: 'user', text: exact, input: exact, turn: 1, createdAt: 9 },
      {
        id: replyId,
        role: 'assistant',
        text: prefix,
        input: exact,
        turn: 1,
        createdAt: 10,
        title: 'Native reply',
        status: 'running',
        futureMessageMetadata: { exact, values: [null, 47] },
      },
    ],
  }
}

function json<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T
}

function reply(thread: Thread): Message {
  const message = thread.messages.find((message) => message.id === replyId)
  if (!message) throw new Error('Missing native response')
  return message
}

function stream(thread: Thread, text: string): Thread {
  return applyEvent(thread, { type: 'text', sessionId: thread.id, itemId: 'answer', text })
}

function patch(input: ConversationCheckpointInput) {
  expect(input.upserts).toHaveLength(1)
  const messages = input.upserts[0].messages
  if (messages.mode !== 'patch') throw new Error('Expected native incremental message fields')
  return messages
}

function marker(value: object, description: string): symbol {
  const key = Object.getOwnPropertySymbols(value).find((key) => key.description === description)
  if (!key) throw new Error(`Missing admitted ${description}`)
  return key
}

function rejectLargePrefixScans() {
  const startsWith = String.prototype.startsWith
  return vi.spyOn(String.prototype, 'startsWith').mockImplementation(function (
    this: string,
    search: string,
    position?: number,
  ) {
    if (typeof search === 'string' && search.length >= 1024)
      throw new Error('Rescanned an owned native transcript prefix')
    return startsWith.call(this, search, position)
  })
}

function assertNativeData(copy: Thread, raw: RawThread, text: string) {
  expect(copy).toMatchObject({
    id: raw.id,
    provider: raw.provider,
    profileId: raw.profileId,
    remoteId: raw.remoteId,
    workspace: raw.workspace,
    pending: raw.pending,
    futureThreadMetadata: raw.futureThreadMetadata,
  })
  expect(copy.messages).toHaveLength(raw.messages.length)
  expect(copy.messages[0]).toEqual(raw.messages[0])
  expect(reply(copy)).toMatchObject({
    text,
    input: exact,
    futureMessageMetadata: (raw.messages[2] as Record<string, unknown>).futureMessageMetadata,
  })
  expect(Object.getOwnPropertySymbols(copy)).toEqual([])
  expect(Object.getOwnPropertySymbols(reply(copy))).toEqual([])
}

function deferred() {
  let resolve!: () => void
  const promise = new Promise<void>((done) => {
    resolve = done
  })
  return { promise, resolve }
}

describe('owned native appends with current recovery and lifecycle contracts', () => {
  it.each(['codex', 'claude'] as const)(
    'copies streamed %s history as strict independent JSON while preserving passive raw lifecycle and append ownership',
    (provider) => {
      const raw = rawThread(provider)
      const restored = readThreads([raw])[0]
      expect(restored.busy).toBe(false)
      expect(restored.turnStatus).toBe('unknown')
      expect(copyConversationSourceJson(restored)).toEqual(raw)
      const first = stream(restored, '\uddea\r')
      rejectLargePrefixScans()
      const suffix = '\uddea\r\n\tExact owned continuation Ω  '
      const latest = stream(first, '\n\tExact owned continuation Ω  ')
      expect(getConversationMessageAppend(reply(restored), reply(latest))).toEqual({
        baseLength: prefix.length,
        value: suffix,
      })

      const copied = copyConversationSourceJson(latest)
      assertNativeData(copied, raw, prefix + suffix)
      expect(copied).toMatchObject({ busy: true, turnStatus: 'running', agentStatus: 'running' })
      expect(hasConversationSource(copied)).toBe(false)
      expect(copied.messages).not.toBe(raw.messages)
      expect(reply(copied)).not.toBe(reply(latest))
      expect(getConversationMessageAppend(reply(restored), reply(copied))).toBeUndefined()
      expect(getConversationMessageAppend(reply(restored), reply(latest))).toEqual({
        baseLength: prefix.length,
        value: suffix,
      })
      const snapshot = createHistorySnapshotProjector()
      const packet = createConversationCheckpointProjector()(
        [raw] as unknown as Thread[],
        snapshot([latest]),
        100,
        200,
        capabilities,
      )!
      expect(patch(packet).fields).toEqual([
        {
          id: replyId,
          set: {},
          remove: [],
          append: { text: { baseLength: prefix.length, value: suffix } },
        },
      ])
      expect(json(raw.messages[2])).toMatchObject({ text: prefix, input: exact })
    },
  )

  it.each(['codex', 'claude'] as const)(
    'keeps authored %s completion and strict recovery data when an older owned append acknowledges later',
    async (provider) => {
      vi.spyOn(Date, 'now').mockReturnValue(6000)
      const raw = rawThread(provider)
      const restored = readThreads([raw])[0]
      const running = stream(restored, '\uddea\r\n\tExact response before completion  ')
      const snapshot = createHistorySnapshotProjector()
      const olderHistory = snapshot([running])
      const olderData = json(olderHistory)
      const release = deferred()
      const started = deferred()
      const client = new ConversationCheckpointClient()
      const save = vi.fn(async () => {})
      const checkpoint = vi.fn(async (input: ConversationCheckpointInput) => {
        if (input.savedAt === 200) {
          started.resolve()
          await release.promise
        }
        return { savedAt: input.savedAt }
      })
      expect(
        client.adoptDurableBaseline(
          [raw] as unknown as Thread[],
          100,
          save,
          checkpoint,
          capabilities,
        ),
      ).toBe(true)
      rejectLargePrefixScans()
      const olderWrite = client.submit(olderHistory, 200, save, checkpoint)
      await started.promise
      const finished = applyEvent(running, {
        type: 'complete',
        sessionId: running.id,
        status: 'completed',
      })
      const beforeAck = copyConversationSourceJson(finished)
      assertNativeData(beforeAck, raw, reply(running).text)
      expect(beforeAck).toMatchObject({
        busy: false,
        turnStatus: 'completed',
        agentStatus: 'completed',
      })
      const finalWrite = client.submit(snapshot([finished]), 300, save, checkpoint)
      release.resolve()
      expect(await Promise.all([olderWrite, finalWrite])).toEqual([200, 300])
      expect(save).not.toHaveBeenCalled()
      expect(checkpoint).toHaveBeenCalledTimes(2)
      expect(checkpoint.mock.calls[1][0]).toMatchObject({ baseSavedAt: 200, savedAt: 300 })
      expect(checkpoint.mock.calls[1][0].upserts[0].thread).toMatchObject({
        busy: false,
        turnStatus: 'completed',
        agentStatus: 'completed',
        futureThreadMetadata: raw.futureThreadMetadata,
      })
      expect(
        patch(checkpoint.mock.calls[1][0]).fields?.find((field) => field.id === replyId)?.set.text,
      ).toBeUndefined()
      acknowledgeConversationSources(olderHistory, 101)
      const afterAck = copyConversationSourceJson({ ...finished, title: 'Renamed completed work' })
      assertNativeData(afterAck, raw, reply(running).text)
      expect(afterAck).toMatchObject({
        busy: false,
        turnStatus: 'completed',
        agentStatus: 'completed',
      })
      expect(reply(afterAck).finishStatus).toBe('completed')
      expect(json(olderHistory)).toEqual(olderData)
    },
  )

  it('keeps regular undefined removal markers JSON-safe after owned text and emits explicit native removals', () => {
    const raw = rawThread()
    const restored = readThreads([raw])[0]
    const streamed = stream(restored, '\uddea\r\n Exact owned response  ')
    const edited: Thread = {
      ...streamed,
      gitBranch: undefined,
      messages: streamed.messages.map((message) =>
        message.id === replyId
          ? { ...message, input: undefined, title: undefined, status: undefined }
          : message,
      ),
    }
    rejectLargePrefixScans()
    const copied = copyConversationSourceJson(edited)
    expect(Object.hasOwn(copied, 'gitBranch')).toBe(false)
    for (const key of ['input', 'title', 'status'])
      expect(Object.hasOwn(reply(copied), key)).toBe(false)
    expect(reply(copied)).toMatchObject({
      text: reply(streamed).text,
      futureMessageMetadata: (raw.messages[2] as Record<string, unknown>).futureMessageMetadata,
    })
    expect((copied as Thread & Record<string, unknown>).futureThreadMetadata).toEqual(
      raw.futureThreadMetadata,
    )
    const packet = createConversationCheckpointProjector()(
      [raw] as unknown as Thread[],
      createHistorySnapshotProjector()([edited]),
      100,
      200,
      { supportsMessageFields: true, supportsMessageAppends: false },
    )!
    const fields = patch(packet).fields!.find((field) => field.id === replyId)!
    expect(fields.set).toEqual({ text: reply(streamed).text })
    expect(fields.remove).toEqual(expect.arrayContaining(['input', 'title', 'status']))
    expect(fields.remove).toHaveLength(3)
    expect(fields.append).toBeUndefined()
    expect(json(raw.messages[2])).toMatchObject({
      input: exact,
      title: 'Native reply',
      status: 'running',
    })
    expect(raw.gitBranch).toBe('main')
  })

  it.each([
    {
      name: 'disabled native append capability',
      options: { supportsMessageFields: true, supportsMessageAppends: false },
    },
    {
      name: 'disabled native field capability',
      options: { supportsMessageFields: false, supportsMessageAppends: true },
    },
  ])(
    'uses exact fallback for $name and regains owned suffix packets after explicit re-enable',
    async ({ options }) => {
      const raw = rawThread()
      const restored = readThreads([raw])[0]
      const suffix = '\uddea\r\n Exact first response  '
      const first = stream(restored, suffix)
      const snapshot = createHistorySnapshotProjector()
      const client = new ConversationCheckpointClient()
      const save = vi.fn(async () => {})
      const checkpoint = vi.fn(async (input: ConversationCheckpointInput) => ({
        savedAt: input.savedAt,
      }))
      expect(
        client.adoptDurableBaseline([raw] as unknown as Thread[], 100, save, checkpoint, options),
      ).toBe(true)
      rejectLargePrefixScans()
      expect(await client.submit(snapshot([first]), 200, save, checkpoint)).toBe(200)
      const delta = patch(checkpoint.mock.calls[0][0])
      if (options.supportsMessageFields) {
        expect(delta.fields).toEqual([{ id: replyId, set: { text: prefix + suffix }, remove: [] }])
        expect(delta.upserts).toEqual([])
      } else {
        expect(delta.fields).toBeUndefined()
        expect(delta.upserts).toHaveLength(1)
        expect(delta.upserts[0]).toMatchObject({ id: replyId, text: prefix + suffix, input: exact })
      }
      const nextSuffix = '\tExact subsequent owned response 🧪  '
      const latest = stream(first, nextSuffix)
      expect(await client.submit(snapshot([latest]), 300, save, checkpoint, capabilities)).toBe(300)
      expect(patch(checkpoint.mock.calls[1][0]).fields).toEqual([
        {
          id: replyId,
          set: {},
          remove: [],
          append: { text: { baseLength: reply(first).text.length, value: nextSuffix } },
        },
      ])
      assertNativeData(copyConversationSourceJson(latest), raw, prefix + suffix + nextSuffix)
      expect(save).not.toHaveBeenCalled()
    },
  )

  it('rejects a forged value under the genuine lifecycle marker after an owned native append without executing it', () => {
    const restored = readThreads([rawThread()])[0]
    const finished = applyEvent(stream(restored, '\uddea Exact response'), {
      type: 'complete',
      sessionId: restored.id,
    })
    const invoked = vi.fn()
    const forgedToken = Object.defineProperty({}, 'values', { get: invoked, enumerable: true })
    const forged = {
      ...finished,
      [marker(finished, 'Life conversation lifecycle intent')]: forgedToken,
    }
    expect(() => copyConversationSourceJson(forged)).toThrow('unsupported key')
    expect(invoked).not.toHaveBeenCalled()
  })

  it('strips a genuine foreign lifecycle token without granting completion to another decoded native source', () => {
    const raw = rawThread()
    const firstOwner = readThreads([raw])[0]
    const finished = applyEvent(stream(firstOwner, '\uddea First owner response'), {
      type: 'complete',
      sessionId: firstOwner.id,
    })
    const key = marker(finished, 'Life conversation lifecycle intent')
    const token = Object.getOwnPropertyDescriptor(finished, key)!.value
    const foreign = stream(readThreads([json(raw)])[0], '\uddea Foreign owner response')
    const transplanted = { ...foreign, [key]: token }
    const copied = copyConversationSourceJson(transplanted)
    assertNativeData(copied, raw, reply(foreign).text)
    expect(copied).toMatchObject({ busy: true, turnStatus: 'running', agentStatus: 'running' })
    expect(Object.getOwnPropertySymbols(copied)).toEqual([])
  })

  it.each(['thread source', 'message occurrence'] as const)(
    'rejects a forged %s marker payload after an owned append without executing its getters',
    (target) => {
      const restored = readThreads([rawThread()])[0]
      const streamed = stream(restored, '\uddea Exact response')
      const invoked = vi.fn()
      const forgedValue = Object.defineProperty({}, 'baseline', { get: invoked, enumerable: true })
      const current = {
        ...streamed,
        messages: streamed.messages.map((message) => ({ ...message })),
      }
      const owner = target === 'thread source' ? current : reply(current)
      const description =
        target === 'thread source'
          ? 'Life conversation recovery source'
          : 'Life conversation recovery value'
      Object.defineProperty(owner, marker(owner, description), {
        value: forgedValue,
        enumerable: true,
        configurable: true,
      })
      expect(() => copyConversationSourceJson(current)).toThrow('unsupported key')
      expect(invoked).not.toHaveBeenCalled()
    },
  )

  it.each(['current owned body', 'hidden raw source'] as const)(
    'rejects a getter in the %s before safe copy invokes any executable history',
    (target) => {
      const raw = rawThread()
      const streamed = stream(readThreads([raw])[0], '\uddea Exact response')
      const invoked = vi.fn()
      if (target === 'current owned body')
        Object.defineProperty(reply(streamed), 'text', {
          get: invoked,
          enumerable: true,
          configurable: true,
        })
      else
        Object.defineProperty(raw, 'hiddenFutureGetter', {
          get: invoked,
          enumerable: true,
          configurable: true,
        })
      expect(() => copyConversationSourceJson(streamed)).toThrow('getters or setters')
      expect(invoked).not.toHaveBeenCalled()
    },
  )

  it('expires cached completion authority when admitted source history is replaced after an owned append', () => {
    const raw = rawThread()
    const restored = readThreads([raw])[0]
    const finished = applyEvent(stream(restored, '\uddea Exact response'), {
      type: 'complete',
      sessionId: restored.id,
    })
    expect(copyConversationSourceJson(finished).busy).toBe(false)
    const replacement = { ...raw, messages: copyConversationSourceJson(finished).messages }
    attachConversationSource(finished, replacement)
    expect(copyConversationSourceJson(finished)).toEqual(replacement)
    const newlyCompleted = applyEvent(finished, { type: 'complete', sessionId: finished.id })
    expect(copyConversationSourceJson(newlyCompleted)).toMatchObject({
      busy: false,
      turnStatus: 'completed',
      agentStatus: 'completed',
    })
  })
})
