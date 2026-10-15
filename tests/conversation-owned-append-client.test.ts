import { describe, expect, it, vi } from 'vitest'
import {
  CONVERSATION_CHECKPOINT_BASE_CHANGED,
  type ConversationCheckpointInput,
} from '../src/shared/conversations'
import {
  ConversationCheckpointClient,
  createConversationCheckpointProjector,
  createHistorySnapshotProjector,
} from '../src/renderer/conversation-checkpoint-client'
import {
  appendConversationMessageText,
  getConversationMessageAppend,
} from '../src/renderer/conversation-message-appends'
import * as messageAppends from '../src/renderer/conversation-message-appends'
import { readThreads, type Message, type Thread } from '../src/renderer/state'

const capabilities = { supportsMessageFields: true, supportsMessageAppends: true }
const prefix = '  Exact café e\u0301 漢字 🧪\r\n'.repeat(8192)

function thread(message?: Message): Thread {
  return {
    id: 'thread',
    profileId: 'workspace',
    workspace: '/exact/project',
    provider: 'codex',
    remoteId: 'native-session-Ω',
    title: 'Thread',
    messages: [message ?? { id: 'reply', role: 'assistant', text: prefix, turn: 1 }],
    pending: [],
    busy: true,
    turn: 1,
    updatedAt: 1,
    mode: 'review',
    model: '',
  }
}

function appended(before: Thread, suffix: string): Thread {
  const previous = before.messages[0]
  const { text: _text, ...fields } = previous
  return {
    ...before,
    messages: [appendConversationMessageText(previous, fields, suffix)],
  }
}

function patch(input: ConversationCheckpointInput) {
  expect(input.upserts).toHaveLength(1)
  const messages = input.upserts[0].messages
  if (messages.mode !== 'patch') throw new Error('Expected an incremental message packet')
  return messages
}

function expectAppend(input: ConversationCheckpointInput, before: Thread, suffix: string) {
  expect(patch(input)).toEqual({
    mode: 'patch',
    upserts: [],
    fields: [
      {
        id: 'reply',
        set: {},
        remove: [],
        append: { text: { baseLength: before.messages[0].text.length, value: suffix } },
      },
    ],
  })
  expect(JSON.stringify(input).length).toBeLessThan(1024)
}

function deferred() {
  let resolve!: () => void
  const promise = new Promise<void>((done) => {
    resolve = done
  })
  return { promise, resolve }
}

/** Fail only transcript-size prefix comparisons; Vitest's own short-string checks remain usable. */
async function withoutTranscriptPrefixScans(run: () => Promise<void>) {
  const startsWith = String.prototype.startsWith
  const spy = vi.spyOn(String.prototype, 'startsWith').mockImplementation(function (
    this: string,
    search: string,
    position?: number,
  ) {
    if (typeof search === 'string' && search.length >= 128 * 1024)
      throw new Error('Rescanned an owned transcript prefix')
    return startsWith.call(this, search, position)
  })
  try {
    await run()
  } finally {
    spy.mockRestore()
  }
}

describe('owned append receipts in the native checkpoint client', () => {
  it('collects receipts only for changed messages and never inspects a settled registered body', async () => {
    const before = thread()
    const changing = before.messages[0]
    const priorSettled = { ...changing, id: 'settled' }
    const { text: _text, ...settledFields } = priorSettled
    const settled = appendConversationMessageText(priorSettled, settledFields, '\r\n settled  ')
    const readSettledText = vi.fn(() => {
      throw new Error('Read settled registered transcript')
    })
    Object.defineProperty(settled, 'text', {
      get: readSettledText,
      enumerable: true,
      configurable: true,
    })
    before.messages = [settled, changing]
    const nextChanging = appended(thread(changing), '\r\n changed endpoint 🧪  ').messages[0]
    const next = { ...before, messages: [settled, nextChanging] }
    const client = new ConversationCheckpointClient()
    const save = vi.fn(async () => {})
    const checkpoint = vi.fn(async (input: ConversationCheckpointInput) => ({
      savedAt: input.savedAt,
    }))
    const collectReceipt = vi.spyOn(
      messageAppends,
      'createConversationMessageAppendAcknowledgement',
    )
    try {
      expect(client.adoptDurableBaseline([before], 100, save, checkpoint, capabilities)).toBe(true)
      await withoutTranscriptPrefixScans(async () => {
        expect(await client.submit([next], 200, save, checkpoint)).toBe(200)
        expectAppend(checkpoint.mock.calls[0][0], thread(changing), '\r\n changed endpoint 🧪  ')
      })
      expect(collectReceipt).toHaveBeenCalledExactlyOnceWith(nextChanging)
      expect(readSettledText).not.toHaveBeenCalled()
      expect(save).not.toHaveBeenCalled()
    } finally {
      collectReceipt.mockRestore()
    }
  })

  it('captures the submitted endpoint before awaiting and retains a newer coalesced suffix after its acknowledgement', async () => {
    const firstRelease = deferred()
    const lastRelease = deferred()
    const client = new ConversationCheckpointClient()
    const save = vi.fn(async () => {})
    const checkpoint = vi.fn(async (input: ConversationCheckpointInput) => {
      if (input.savedAt === 200) await firstRelease.promise
      if (input.savedAt === 400) await lastRelease.promise
      return { savedAt: input.savedAt }
    })
    const before = thread()
    const first = appended(before, '\r\n first 🧪  ')
    expect(client.adoptDurableBaseline([before], 100, save, checkpoint, capabilities)).toBe(true)

    await withoutTranscriptPrefixScans(async () => {
      const firstSubmission = client.submit([first], 200, save, checkpoint)
      const middle = appended(first, '\tintermediate e\u0301  ')
      const latest = appended(middle, '\r\n final 漢字  ')
      const middleSubmission = client.submit([middle], 300, save, checkpoint)
      const lastSubmission = client.submit([latest], 400, save, checkpoint)
      expectAppend(checkpoint.mock.calls[0][0], before, '\r\n first 🧪  ')
      expect(getConversationMessageAppend(before.messages[0], first.messages[0])).toEqual({
        baseLength: prefix.length,
        value: '\r\n first 🧪  ',
      })

      firstRelease.resolve()
      expect(await firstSubmission).toBe(200)
      expect(checkpoint).toHaveBeenCalledTimes(2)
      expect(getConversationMessageAppend(before.messages[0], first.messages[0])).toBeUndefined()
      expect(getConversationMessageAppend(first.messages[0], latest.messages[0])).toEqual({
        baseLength: first.messages[0].text.length,
        value: '\tintermediate e\u0301  \r\n final 漢字  ',
      })
      expect(checkpoint.mock.calls[1][0]).toMatchObject({ baseSavedAt: 200, savedAt: 400 })
      expectAppend(checkpoint.mock.calls[1][0], first, '\tintermediate e\u0301  \r\n final 漢字  ')
      lastRelease.resolve()
      expect(await Promise.all([middleSubmission, lastSubmission])).toEqual([400, 400])
      expect(getConversationMessageAppend(first.messages[0], latest.messages[0])).toBeUndefined()
      expect(save).not.toHaveBeenCalled()
    })
  })

  it.each(['rejected checkpoint', 'wrong acknowledgement stamp'] as const)(
    'does not consume a receipt for a %s and recovers with the complete latest history',
    async (failure) => {
      const release = deferred()
      const client = new ConversationCheckpointClient()
      const save = vi.fn(async () => {})
      const checkpoint = vi.fn(async (input: ConversationCheckpointInput) => {
        if (input.savedAt === 200) {
          await release.promise
          if (failure === 'rejected checkpoint') throw new Error('Disk commit failed')
          return { savedAt: input.savedAt + 1 }
        }
        return { savedAt: input.savedAt }
      })
      const before = thread()
      const first = appended(before, '\r\n first  ')
      const latest = appended(first, '\tlatest 🧪  ')
      expect(client.adoptDurableBaseline([before], 100, save, checkpoint, capabilities)).toBe(true)

      await withoutTranscriptPrefixScans(async () => {
        const firstSubmission = client.submit([first], 200, save, checkpoint)
        const rejection = expect(firstSubmission).rejects.toThrow(
          failure === 'rejected checkpoint' ? 'Disk commit failed' : 'acknowledgement changed',
        )
        expectAppend(checkpoint.mock.calls[0][0], before, '\r\n first  ')
        release.resolve()
        await rejection
        expect(getConversationMessageAppend(before.messages[0], first.messages[0])).toEqual({
          baseLength: prefix.length,
          value: '\r\n first  ',
        })
        expect(getConversationMessageAppend(first.messages[0], latest.messages[0])).toEqual({
          baseLength: first.messages[0].text.length,
          value: '\tlatest 🧪  ',
        })
        expect(await client.submit([latest], 300, save, checkpoint)).toBe(300)
        expect(save).toHaveBeenCalledExactlyOnceWith([latest], 300)
        expect(checkpoint).toHaveBeenCalledTimes(1)
        const final = appended(latest, '\r\n recovered 漢字  ')
        expect(await client.submit([final], 400, save, checkpoint)).toBe(400)
        expect(checkpoint.mock.calls[1][0]).toMatchObject({ baseSavedAt: 300, savedAt: 400 })
        expectAppend(checkpoint.mock.calls[1][0], latest, '\r\n recovered 漢字  ')
      })
    },
  )

  it('consumes a base-change receipt only after its complete-history recovery save succeeds', async () => {
    const release = deferred()
    const client = new ConversationCheckpointClient()
    const save = vi.fn(async () => {
      await release.promise
    })
    const checkpoint = vi.fn(async (input: ConversationCheckpointInput) => {
      if (input.savedAt === 200) throw new Error(CONVERSATION_CHECKPOINT_BASE_CHANGED)
      return { savedAt: input.savedAt }
    })
    const before = thread()
    const first = appended(before, '\r\n recovered first  ')
    expect(client.adoptDurableBaseline([before], 100, save, checkpoint, capabilities)).toBe(true)

    await withoutTranscriptPrefixScans(async () => {
      const firstSubmission = client.submit([first], 200, save, checkpoint)
      // Let the rejected delta enter its awaited full-save adapter.
      await Promise.resolve()
      await Promise.resolve()
      expect(save).toHaveBeenCalledExactlyOnceWith([first], 200)
      const latest = appended(first, '\tarrived during recovery 🧪  ')
      const latestSubmission = client.submit([latest], 300, save, checkpoint)
      expect(getConversationMessageAppend(before.messages[0], first.messages[0])).toEqual({
        baseLength: prefix.length,
        value: '\r\n recovered first  ',
      })
      release.resolve()
      expect(await Promise.all([firstSubmission, latestSubmission])).toEqual([200, 300])
      expect(getConversationMessageAppend(before.messages[0], first.messages[0])).toBeUndefined()
      expect(checkpoint.mock.calls[1][0]).toMatchObject({ baseSavedAt: 200, savedAt: 300 })
      expectAppend(checkpoint.mock.calls[1][0], first, '\tarrived during recovery 🧪  ')
    })
  })

  it('fully saves a fresh history wrapper when an unchanged registered message mutates during base-change recovery', async () => {
    const recoveryStarted = deferred()
    const releaseRecovery = deferred()
    const saved: { history: Thread[]; savedAt: number | undefined }[] = []
    const client = new ConversationCheckpointClient()
    const save = vi.fn(async (history: unknown[], savedAt?: number) => {
      // Electron captures the submitted values before the asynchronous native commit.
      const captured = JSON.parse(JSON.stringify(history)) as Thread[]
      if (savedAt === 200) {
        recoveryStarted.resolve()
        await releaseRecovery.promise
      }
      saved.push({ history: captured, savedAt })
    })
    const checkpoint = vi.fn(async (input: ConversationCheckpointInput) => {
      if (input.savedAt === 200) throw new Error(CONVERSATION_CHECKPOINT_BASE_CHANGED)
      return { savedAt: input.savedAt }
    })
    const before = thread()
    const priorSettled = { ...before.messages[0], id: 'settled' }
    const { text: _text, ...settledFields } = priorSettled
    const settled = appendConversationMessageText(
      priorSettled,
      settledFields,
      '\r\n captured settled body  ',
    )
    const capturedSettledText = settled.text
    before.messages.push(settled)
    const active = appended(thread(before.messages[0]), '\r\n active continuation 🧪  ').messages[0]
    const first = { ...before, messages: [active, settled] }
    expect(client.adoptDurableBaseline([before], 100, save, checkpoint, capabilities)).toBe(true)

    await withoutTranscriptPrefixScans(async () => {
      const firstSubmission = client.submit([first], 200, save, checkpoint)
      await recoveryStarted.promise
      expectAppend(checkpoint.mock.calls[0][0], before, '\r\n active continuation 🧪  ')
      const edited = '  Exact edit while recovery is pending\r\n\tΩ 漢字 🧪  '
      // Do not query the registry: the recovery receipt must discover this edit at ACK.
      settled.text = edited
      releaseRecovery.resolve()
      expect(await firstSubmission).toBe(200)
      expect(saved[0].history[0].messages[1].text).toBe(capturedSettledText)

      const latest = { ...first, messages: [...first.messages] }
      expect(await client.submit([latest], 300, save, checkpoint)).toBe(300)
      expect(checkpoint).toHaveBeenCalledTimes(1)
      expect(save).toHaveBeenCalledTimes(2)
      expect(save.mock.calls[1]).toEqual([[latest], 300])
      expect(saved[1]).toEqual({ history: JSON.parse(JSON.stringify([latest])), savedAt: 300 })
      expect(saved[1].history[0].messages[1].text).toBe(edited)
      expect(saved[1].history[0]).toMatchObject({
        profileId: 'workspace',
        workspace: '/exact/project',
        remoteId: 'native-session-Ω',
      })
    })
  })

  it('retains both the submitted and newer proofs when base-change recovery fails', async () => {
    const release = deferred()
    const client = new ConversationCheckpointClient()
    const save = vi.fn(async () => {
      await release.promise
      throw new Error('Full recovery save failed')
    })
    const checkpoint = vi.fn(async () => {
      throw new Error(CONVERSATION_CHECKPOINT_BASE_CHANGED)
    })
    const before = thread()
    const first = appended(before, '\r\n first  ')
    const latest = appended(first, '\tstill recoverable 🧪  ')
    expect(client.adoptDurableBaseline([before], 100, save, checkpoint, capabilities)).toBe(true)

    await withoutTranscriptPrefixScans(async () => {
      const submission = client.submit([first], 200, save, checkpoint)
      const rejection = expect(submission).rejects.toThrow('Full recovery save failed')
      await Promise.resolve()
      await Promise.resolve()
      expect(save).toHaveBeenCalledExactlyOnceWith([first], 200)
      release.resolve()
      await rejection
      expect(getConversationMessageAppend(before.messages[0], latest.messages[0])).toEqual({
        baseLength: prefix.length,
        value: '\r\n first  \tstill recoverable 🧪  ',
      })
    })
  })

  it.each(['supportsMessageAppends', 'supportsMessageFields'] as const)(
    'retains an explicit %s disable across coalescing while acknowledging the owned first endpoint',
    async (capability) => {
      const release = deferred()
      const client = new ConversationCheckpointClient()
      const save = vi.fn(async () => {})
      const checkpoint = vi.fn(async (input: ConversationCheckpointInput) => {
        if (input.savedAt === 200) await release.promise
        return { savedAt: input.savedAt }
      })
      const before = thread()
      const first = appended(before, '\r\n first  ')
      const middle = appended(first, '\tintermediate  ')
      const latest = appended(middle, '\r\n latest 🧪  ')
      expect(client.adoptDurableBaseline([before], 100, save, checkpoint, capabilities)).toBe(true)

      await withoutTranscriptPrefixScans(async () => {
        const firstSubmission = client.submit([first], 200, save, checkpoint)
        const middleSubmission = client.submit([middle], 300, save, checkpoint, {
          [capability]: false,
        })
        const lastSubmission = client.submit([latest], 400, save, checkpoint)
        release.resolve()
        expect(await Promise.all([firstSubmission, middleSubmission, lastSubmission])).toEqual([
          200, 400, 400,
        ])
        expect(getConversationMessageAppend(before.messages[0], first.messages[0])).toBeUndefined()
        expect(patch(checkpoint.mock.calls[1][0])).toEqual(
          capability === 'supportsMessageFields'
            ? { mode: 'patch', upserts: latest.messages }
            : {
                mode: 'patch',
                upserts: [],
                fields: [{ id: 'reply', set: { text: latest.messages[0].text }, remove: [] }],
              },
        )
        const final = appended(latest, '\treenabled 漢字  ')
        expect(await client.submit([final], 500, save, checkpoint, capabilities)).toBe(500)
        expectAppend(checkpoint.mock.calls[2][0], latest, '\treenabled 漢字  ')
        expect(save).not.toHaveBeenCalled()
      })
    },
  )

  it.each(['save', 'checkpoint'] as const)(
    'acknowledges only the old in-flight endpoint when the pending native %s bridge changes',
    async (kind) => {
      const release = deferred()
      const client = new ConversationCheckpointClient()
      const save = vi.fn(async () => {})
      const checkpoint = vi.fn(async (input: ConversationCheckpointInput) => {
        if (input.savedAt === 200) await release.promise
        return { savedAt: input.savedAt }
      })
      const newSave = kind === 'save' ? vi.fn(async () => {}) : save
      const newCheckpoint =
        kind === 'checkpoint'
          ? vi.fn(async (input: ConversationCheckpointInput) => ({ savedAt: input.savedAt }))
          : checkpoint
      const before = thread()
      const first = appended(before, '\r\n old bridge  ')
      const latest = appended(first, '\tnew bridge 🧪  ')
      expect(client.adoptDurableBaseline([before], 100, save, checkpoint, capabilities)).toBe(true)

      await withoutTranscriptPrefixScans(async () => {
        const firstSubmission = client.submit([first], 200, save, checkpoint)
        const lastSubmission = client.submit([latest], 300, newSave, newCheckpoint)
        release.resolve()
        expect(await Promise.all([firstSubmission, lastSubmission])).toEqual([200, 300])
        expect(getConversationMessageAppend(before.messages[0], first.messages[0])).toBeUndefined()
        expect(newSave).toHaveBeenCalledExactlyOnceWith([latest], 300)
        const disabled = appended(latest, '\tcapabilities reset  ')
        expect(await client.submit([disabled], 400, newSave, newCheckpoint)).toBe(400)
        const disabledPacket = newCheckpoint.mock.calls.at(-1)![0]
        expect(disabledPacket).toMatchObject({ baseSavedAt: 300, savedAt: 400 })
        expect(patch(disabledPacket)).toEqual({ mode: 'patch', upserts: disabled.messages })
        const final = appended(disabled, '\r\n explicit native capabilities  ')
        expect(await client.submit([final], 500, newSave, newCheckpoint, capabilities)).toBe(500)
        expectAppend(
          newCheckpoint.mock.calls.at(-1)![0],
          disabled,
          '\r\n explicit native capabilities  ',
        )
      })
    },
  )

  it('carries owned proofs through lossless source projection and rebasing without rescanning or changing opaque fields', async () => {
    const rawMessage: Message & Record<string, unknown> = {
      id: 'reply',
      role: 'assistant',
      text: prefix,
      turn: 1,
      futureMessageField: { exact: '  future value\r\n🧪  ', retained: true },
    }
    const raw = { ...thread(), messages: [rawMessage], futureThreadField: { retained: true } }
    const restored = readThreads([raw])[0]
    const snapshot = createHistorySnapshotProjector()
    const client = new ConversationCheckpointClient()
    const save = vi.fn(async () => {})
    const release = deferred()
    const checkpoint = vi.fn(async (input: ConversationCheckpointInput) => {
      if (input.savedAt === 200) await release.promise
      return { savedAt: input.savedAt }
    })
    expect(client.adoptDurableBaseline([raw], 100, save, checkpoint, capabilities)).toBe(true)
    const first = appended(restored, '\r\n exact restored append  ')

    await withoutTranscriptPrefixScans(async () => {
      const firstHistory = snapshot([first])
      expect(firstHistory[0].messages[0]).not.toBe(first.messages[0])
      const firstSubmission = client.submit(firstHistory, 200, save, checkpoint)
      const latest = appended(first, '\tarrived while restoring 🧪  ')
      const lastSubmission = client.submit(snapshot([latest]), 300, save, checkpoint)
      expectAppend(checkpoint.mock.calls[0][0], restored, '\r\n exact restored append  ')
      expect(checkpoint.mock.calls[0][0].upserts[0].thread).toMatchObject({
        profileId: 'workspace',
        workspace: '/exact/project',
        remoteId: 'native-session-Ω',
        futureThreadField: raw.futureThreadField,
      })
      release.resolve()
      expect(await Promise.all([firstSubmission, lastSubmission])).toEqual([200, 300])
      expectAppend(checkpoint.mock.calls[1][0], first, '\tarrived while restoring 🧪  ')
      const durable = snapshot([latest])[0] as Thread & Record<string, unknown>
      expect(durable.futureThreadField).toEqual(raw.futureThreadField)
      expect((durable.messages[0] as Message & Record<string, unknown>).futureMessageField).toEqual(
        rawMessage.futureMessageField,
      )
      expect(durable.messages[0].text).toBe(
        prefix + '\r\n exact restored append  \tarrived while restoring 🧪  ',
      )
      expect(save).not.toHaveBeenCalled()
    })
  })

  it('recovers a source-backed in-place edit with two exact full saves then resumes consecutive owned suffix checkpoints', async () => {
    const input = '  Exact user prompt\r\n\tΩ 🧪 e\u0301  '
    const futureMessageField = { exact: '  future message value\r\n🧪  ', retained: true }
    const futureThreadField = { exact: '  future thread value\r\nΩ  ', retained: true }
    const rawMessage: Message & Record<string, unknown> = {
      id: 'reply',
      role: 'assistant',
      text: prefix,
      input,
      turn: 1,
      futureMessageField,
    }
    const raw = { ...thread(), messages: [rawMessage], futureThreadField }
    const restored = readThreads([raw])[0]
    const snapshot = createHistorySnapshotProjector()
    const saved: { history: Thread[]; savedAt: number | undefined }[] = []
    const client = new ConversationCheckpointClient()
    const save = vi.fn(async (history: unknown[], savedAt?: number) => {
      saved.push({ history: JSON.parse(JSON.stringify(history)) as Thread[], savedAt })
    })
    const checkpoint = vi.fn(async (packet: ConversationCheckpointInput) => ({
      savedAt: packet.savedAt,
    }))
    expect(client.adoptDurableBaseline([raw], 100, save, checkpoint, capabilities)).toBe(true)
    const first = appended(restored, '\r\n original owned suffix  ')

    await withoutTranscriptPrefixScans(async () => {
      const acceptedFirstHistory = snapshot([first])
      const acceptedFirstData = JSON.parse(JSON.stringify(acceptedFirstHistory))
      expect(await client.submit(acceptedFirstHistory, 200, save, checkpoint)).toBe(200)
      expectAppend(checkpoint.mock.calls[0][0], restored, '\r\n original owned suffix  ')
      const edited = prefix + '\r\n exact replacement Ω e\u0301 🧪  '
      first.messages[0].text = edited
      expect(await client.submit(snapshot([first]), 300, save, checkpoint)).toBe(300)
      expect(checkpoint).toHaveBeenCalledTimes(1)
      expect(save).toHaveBeenCalledTimes(1)
      expect(saved[0].savedAt).toBe(300)
      expect(saved[0].history).toHaveLength(1)
      expect(saved[0].history[0].messages).toEqual([{ ...rawMessage, text: edited }])
      expect(saved[0].history[0]).toMatchObject({
        profileId: 'workspace',
        workspace: '/exact/project',
        remoteId: 'native-session-Ω',
        futureThreadField,
      })
      expect(JSON.parse(JSON.stringify(acceptedFirstHistory))).toEqual(acceptedFirstData)

      const freshSuffix = '\tfirst immutable continuation 漢字  '
      const fresh = appended(first, freshSuffix)
      expect(await client.submit(snapshot([fresh]), 400, save, checkpoint)).toBe(400)
      expect(save).toHaveBeenCalledTimes(2)
      expect(checkpoint).toHaveBeenCalledTimes(1)
      expect(saved[1].savedAt).toBe(400)
      expect(saved[1].history).toHaveLength(1)
      expect(saved[1].history[0].messages).toEqual([{ ...rawMessage, text: edited + freshSuffix }])
      expect(saved[1].history[0]).toMatchObject({
        profileId: 'workspace',
        workspace: '/exact/project',
        remoteId: 'native-session-Ω',
        futureThreadField,
      })

      const finalSuffix = '\r\n second immutable continuation 🧪  '
      const final = appended(fresh, finalSuffix)
      const saveCount = save.mock.calls.length
      const checkpointCount = checkpoint.mock.calls.length
      expect(await client.submit(snapshot([final]), 500, save, checkpoint)).toBe(500)
      expect(save).toHaveBeenCalledTimes(saveCount)
      expect(checkpoint).toHaveBeenCalledTimes(checkpointCount + 1)
      expect(checkpoint.mock.calls.at(-1)![0]).toMatchObject({ baseSavedAt: 400, savedAt: 500 })
      expectAppend(checkpoint.mock.calls.at(-1)![0], fresh, finalSuffix)
      const exactFinal = snapshot([final])[0] as Thread & Record<string, unknown>
      expect(exactFinal.messages).toEqual([
        { ...rawMessage, text: edited + freshSuffix + finalSuffix },
      ])
      expect(exactFinal.futureThreadField).toEqual(futureThreadField)

      const laterSuffix = '\tthird immutable continuation Ω  '
      const later = appended(final, laterSuffix)
      expect(await client.submit(snapshot([later]), 600, save, checkpoint)).toBe(600)
      expect(save).toHaveBeenCalledTimes(2)
      expect(checkpoint).toHaveBeenCalledTimes(3)
      expect(checkpoint.mock.calls.at(-1)![0]).toMatchObject({ baseSavedAt: 500, savedAt: 600 })
      expectAppend(checkpoint.mock.calls.at(-1)![0], final, laterSuffix)
      const exactLater = snapshot([later])[0] as Thread & Record<string, unknown>
      expect(exactLater.messages).toEqual([
        { ...rawMessage, text: edited + freshSuffix + finalSuffix + laterSuffix },
      ])
      expect(exactLater.futureThreadField).toEqual(futureThreadField)
      expect(JSON.parse(JSON.stringify(acceptedFirstHistory))).toEqual(acceptedFirstData)
    })
  })

  it('keeps exact fallback checks for an unowned message even when its text resembles an owned append', async () => {
    const before = thread()
    const owned = appended(before, '\r\n actual native suffix  ')
    const unowned = {
      ...owned,
      messages: [{ ...before.messages[0], text: before.messages[0].text + '\r\n forged suffix  ' }],
    }
    expect(getConversationMessageAppend(before.messages[0], unowned.messages[0])).toBeUndefined()
    await withoutTranscriptPrefixScans(async () => {
      expect(() =>
        createConversationCheckpointProjector()([before], [unowned], 100, 200, capabilities),
      ).toThrow('Rescanned an owned transcript prefix')
    })
    const projected = createConversationCheckpointProjector()(
      [before],
      [unowned],
      100,
      200,
      capabilities,
    )!
    expectAppend(projected, before, '\r\n forged suffix  ')
  })

  it.each(['id', 'text'] as const)(
    'rejects a registered %s accessor in the no-source full-save path without executing it or writing native state',
    async (key) => {
      const owned = appended(thread(), '\r\n registered native suffix  ').messages[0]
      const readAccessor = vi.fn(() => {
        throw new Error('Executed quarantined message accessor')
      })
      Object.defineProperty(owned, key, {
        get: readAccessor,
        enumerable: true,
        configurable: true,
      })
      const client = new ConversationCheckpointClient()
      const save = vi.fn(async () => {})
      const checkpoint = vi.fn(async (input: ConversationCheckpointInput) => ({
        savedAt: input.savedAt,
      }))

      await expect(
        client.submit([thread(owned)], 200, save, checkpoint, capabilities),
      ).rejects.toThrow('Cannot save a conversation message with an accessor field.')
      expect(readAccessor).not.toHaveBeenCalled()
      expect(save).not.toHaveBeenCalled()
      expect(checkpoint).not.toHaveBeenCalled()
    },
  )

  it.each(['id', 'text'] as const)(
    'rejects a known-mutated %s accessor during direct checkpoint projection before reading message fields',
    (key) => {
      const before = thread()
      const after = appended(before, '\r\n registered native suffix  ')
      const readAccessor = vi.fn(() => {
        throw new Error('Executed quarantined message accessor')
      })
      Object.defineProperty(after.messages[0], key, {
        get: readAccessor,
        enumerable: true,
        configurable: true,
      })
      expect(messageAppends.conversationMessageAppendWasMutated(after.messages[0])).toBe(true)
      expect(readAccessor).not.toHaveBeenCalled()

      expect(() =>
        createConversationCheckpointProjector()([before], [after], 100, 200, capabilities),
      ).toThrow('Cannot save a conversation message with an accessor field.')
      expect(readAccessor).not.toHaveBeenCalled()
    },
  )

  it.each(['id', 'text'] as const)(
    'invalidates a warmed message index before projecting a known-mutated %s accessor through a fresh metadata wrapper',
    (key) => {
      const before = thread()
      const after = appended(before, '\r\n registered native suffix  ')
      const project = createConversationCheckpointProjector()
      expectAppend(
        project([before], [after], 100, 200, capabilities)!,
        before,
        '\r\n registered native suffix  ',
      )
      const readAccessor = vi.fn(() => {
        throw new Error('Executed quarantined message accessor through a cached index')
      })
      Object.defineProperty(after.messages[0], key, {
        get: readAccessor,
        enumerable: true,
        configurable: true,
      })
      expect(messageAppends.conversationMessageAppendWasMutated(after.messages[0])).toBe(true)
      expect(readAccessor).not.toHaveBeenCalled()
      const latest = { ...after, updatedAt: 300 }
      expect(latest.messages).toBe(after.messages)

      expect(() => project([before], [latest], 100, 300, capabilities)).toThrow(
        'Cannot save a conversation message with an accessor field.',
      )
      expect(readAccessor).not.toHaveBeenCalled()
    },
  )
})
