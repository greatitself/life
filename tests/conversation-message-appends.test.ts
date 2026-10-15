import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  acknowledgeConversationMessageAppends,
  appendConversationMessageText,
  bindConversationMessageAppendSource,
  createConversationMessageAppendAcknowledgement,
  discardConversationMessageAppendAcknowledgements,
  getConversationMessageAppend,
  projectConversationMessageAppendSource,
} from '../src/renderer/conversation-message-appends'
import {
  ConversationCheckpointClient,
  createConversationCheckpointProjector,
  createHistorySnapshotProjector,
} from '../src/renderer/conversation-checkpoint-client'
import type { ConversationCheckpointInput } from '../src/shared/conversations'
import { projectConversationSource } from '../src/renderer/conversation-source'
import { applyEvent, readThreads, type Message, type Thread } from '../src/renderer/state'

const exact = '  café e\u0301 漢字 🧪\r\n\t'.repeat(128)
const capabilities = { supportsMessageFields: true, supportsMessageAppends: true }

function message(text = exact, fields: Partial<Message> = {}): Message {
  return { id: '1:answer', role: 'assistant', text, turn: 1, ...fields }
}

function append(previous: Message, suffix: string, fields: Partial<Message> = {}): Message {
  const { text: _text, ...metadata } = previous
  return appendConversationMessageText(previous, { ...metadata, ...fields }, suffix)
}

function thread(messages: Message[] = [message()]): Thread {
  return {
    id: 'thread',
    profileId: 'machine',
    provider: 'codex',
    workspace: '/srv/exact-project',
    remoteId: 'native-conversation-Ω',
    title: 'Exact history',
    messages,
    model: '',
    mode: 'review',
    busy: true,
    pending: [],
    turn: 1,
    updatedAt: 1,
  }
}

function rejectLargePrefixScans() {
  const startsWith = String.prototype.startsWith
  return vi.spyOn(String.prototype, 'startsWith').mockImplementation(function (
    this: string,
    search: string,
    position?: number,
  ) {
    if (typeof search === 'string' && search.length >= 1024)
      throw new Error('An owned append must not scan its settled prefix.')
    return startsWith.call(this, search, position)
  })
}

afterEach(() => vi.restoreAllMocks())

describe('private exact message append ownership', () => {
  it.each([
    ['ordinary text', '  exact continuation  '],
    ['combining marks', 'e\u0301 café\t'],
    ['split surrogate', '\uddea  \r\n'],
    ['split CRLF', '\n\t漢字  '],
  ])('retains every UTF-16 unit in %s without scanning the prefix', (_name, suffix) => {
    const before = message(exact + '\r\ud83e')
    const after = append(before, suffix, { status: 'running' })
    rejectLargePrefixScans()
    expect(getConversationMessageAppend(before, after)).toEqual({
      baseLength: before.text.length,
      value: suffix,
    })
    expect(after.text).toBe(before.text + suffix)
    expect(after.id).toBe(before.id)
    expect(after.status).toBe('running')
  })

  it('concatenates a chain from its actual ancestor and rejects sibling ownership', () => {
    const before = message()
    const first = append(before, '\r')
    const second = append(first, '\n\ud83e')
    const latest = append(second, '\uddea  ')
    const sibling = append(before, 'a different branch')
    rejectLargePrefixScans()
    expect(getConversationMessageAppend(before, latest)).toEqual({
      baseLength: before.text.length,
      value: '\r\n🧪  ',
    })
    expect(getConversationMessageAppend(first, latest)).toEqual({
      baseLength: first.text.length,
      value: '\n🧪  ',
    })
    expect(getConversationMessageAppend(sibling, latest)).toBeUndefined()
    expect(getConversationMessageAppend(latest, first)).toBeUndefined()
    expect(getConversationMessageAppend(latest, latest)).toBeUndefined()
  })

  it('does not treat a same-id same-text foreign object as the registered ancestor', () => {
    const before = message()
    const after = append(before, 'owned tail')
    expect(getConversationMessageAppend({ ...before }, after)).toBeUndefined()
    expect(getConversationMessageAppend(before, { ...after })).toBeUndefined()
    expect(getConversationMessageAppend(JSON.parse(JSON.stringify(before)), after)).toBeUndefined()
    expect(getConversationMessageAppend(before, JSON.parse(JSON.stringify(after)))).toBeUndefined()
  })

  it('stores no public string, symbol, or JSON proof hints', () => {
    const before = message()
    const after = append(before, 'owned tail')
    expect(Reflect.ownKeys(after).sort()).toEqual(Reflect.ownKeys(before).sort())
    const copied = { ...JSON.parse(JSON.stringify(after)) }
    Object.defineProperty(copied, Symbol.for('Life conversation message append'), {
      value: { before, baseLength: before.text.length, suffix: 'owned tail' },
    })
    copied.conversationMessageAppend = {
      before,
      baseLength: before.text.length,
      value: 'owned tail',
    }
    expect(getConversationMessageAppend(before, copied)).toBeUndefined()
    expect(getConversationMessageAppend(before, after)).toEqual({
      baseLength: before.text.length,
      value: 'owned tail',
    })
  })

  it.each(['before', 'after'] as const)(
    'rejects a same-length text mutation of the registered %s message',
    (side) => {
      const before = message()
      const after = append(before, 'owned tail')
      const target = side === 'before' ? before : after
      target.text = '!' + target.text.slice(1)
      expect(getConversationMessageAppend(before, after)).toBeUndefined()
    },
  )

  it('does not restore append eligibility when a mutated endpoint is assigned its old text', () => {
    const before = message()
    const accepted = append(before, 'accepted suffix')
    const latest = append(accepted, 'a queued suffix')
    const original = accepted.text
    accepted.text = '!' + original.slice(1)
    expect(getConversationMessageAppend(before, accepted)).toBeUndefined()
    accepted.text = original
    rejectLargePrefixScans()
    expect(getConversationMessageAppend(accepted, latest)).toBeUndefined()
    const projected = createConversationCheckpointProjector()(
      [thread([accepted])],
      [thread([latest])],
      10,
      20,
      capabilities,
    )!
    const delta = projected.upserts[0].messages
    expect(delta.mode).toBe('patch')
    if (delta.mode !== 'patch') throw new Error('Expected a message patch')
    expect(delta.fields).toEqual([{ id: accepted.id, set: { text: latest.text }, remove: [] }])
  })

  it.each(['before', 'after'] as const)('rejects a native identity mutation of %s', (side) => {
    const before = message()
    const after = append(before, 'owned tail')
    ;(side === 'before' ? before : after).id = 'another-native-item'
    expect(getConversationMessageAppend(before, after)).toBeUndefined()
  })

  it.each(['id', 'text'] as const)(
    'rejects registered %s accessors without invoking user code',
    (key) => {
      const before = message()
      const after = append(before, 'owned tail')
      const read = vi.fn(() => {
        throw new Error('Accessors are not trusted ownership evidence.')
      })
      Object.defineProperty(after, key, { get: read, enumerable: true, configurable: true })
      expect(getConversationMessageAppend(before, after)).toBeUndefined()
      expect(createConversationMessageAppendAcknowledgement(after)).toBeUndefined()
      expect(read).not.toHaveBeenCalled()
    },
  )

  it.each(['id', 'text'] as const)('rejects registered %s moved to the prototype', (key) => {
    const before = message()
    const after = append(before, 'owned tail')
    const value = after[key]
    delete (after as unknown as Record<string, unknown>)[key]
    Object.setPrototypeOf(after, { [key]: value })
    expect(getConversationMessageAppend(before, after)).toBeUndefined()
  })

  it('rejects boxed strings, missing values, and foreign inherited records', () => {
    const before = message()
    const after = append(before, 'owned tail')
    ;(after as unknown as Record<string, unknown>).text = new String(after.text)
    expect(getConversationMessageAppend(before, after)).toBeUndefined()
    expect(getConversationMessageAppend(Object.create(before), before)).toBeUndefined()
    expect(getConversationMessageAppend(before, {})).toBeUndefined()
    expect(getConversationMessageAppend({}, after)).toBeUndefined()
  })

  it('does not certify a newly constructed item against an unrelated native identity', () => {
    const before = message()
    const after = append(before, 'owned tail', { id: 'new-native-item' })
    expect(after.text).toBe(before.text + 'owned tail')
    expect(after.id).toBe('new-native-item')
    expect(getConversationMessageAppend(before, after)).toBeUndefined()
  })

  it('keeps mutable boxed suffix coercion outside ownership and persists the computed body', () => {
    const before = append(message(), 'established private prefix')
    let value = '\r\nactual first suffix 🧪  '
    const convert = vi.fn(() => value)
    const boxed = new String('unused boxed value')
    Object.defineProperty(boxed, Symbol.toPrimitive, { value: convert })
    const after = append(before, boxed as unknown as string)
    const computed = after.text
    value = 'a later forged suffix'
    expect(convert).toHaveBeenCalledTimes(1)
    expect(computed).toBe(before.text + '\r\nactual first suffix 🧪  ')
    expect(getConversationMessageAppend(before, after)).toBeUndefined()
    const projected = createConversationCheckpointProjector()(
      [thread([before])],
      [thread([after])],
      10,
      20,
      capabilities,
    )!
    const delta = projected.upserts[0].messages
    expect(delta.mode).toBe('patch')
    if (delta.mode !== 'patch') throw new Error('Expected a message patch')
    expect(delta.fields?.[0].append?.text).toEqual({
      baseLength: before.text.length,
      value: '\r\nactual first suffix 🧪  ',
    })
    expect(after.text).toBe(computed)
    expect(convert).toHaveBeenCalledTimes(1)
  })

  it('does not retain extra lineage for repeated exact empty provider deltas', () => {
    const before = message()
    let current = before
    for (let index = 0; index < 600; index++) current = append(current, '')
    const latest = append(current, '\r\nactual suffix 🧪  ')
    expect(getConversationMessageAppend(before, latest)).toEqual({
      baseLength: before.text.length,
      value: '\r\nactual suffix 🧪  ',
    })
    expect(getConversationMessageAppend(before, current)).toBeUndefined()
  })

  it.each(['before', 'after'] as const)(
    'persists a complete text set after a known %s endpoint mutates',
    (side) => {
      const before = message()
      let after = append(before, 'first private suffix')
      if (side === 'before') {
        before.text = '!' + before.text.slice(1)
        after = append(before, 'different suffix')
      } else after.text = before.text + 'a changed suffix'
      rejectLargePrefixScans()
      const projected = createConversationCheckpointProjector()(
        [thread([before])],
        [thread([after])],
        10,
        20,
        capabilities,
      )!
      const delta = projected.upserts[0].messages
      expect(delta.mode).toBe('patch')
      if (delta.mode !== 'patch') throw new Error('Expected a message patch')
      expect(delta.fields).toEqual([{ id: before.id, set: { text: after.text }, remove: [] }])
    },
  )

  it('builds the first item exactly while requiring an actual base for an append packet', () => {
    const first = appendConversationMessageText(
      undefined,
      { id: 'new', role: 'assistant', turn: 3 },
      '  exact\r\n🧪  ',
    )
    expect(first).toEqual({ id: 'new', role: 'assistant', turn: 3, text: '  exact\r\n🧪  ' })
    expect(getConversationMessageAppend(message(''), first)).toBeUndefined()
    const second = append(first, '\tmore')
    expect(getConversationMessageAppend(first, second)).toEqual({
      baseLength: first.text.length,
      value: '\tmore',
    })
  })

  it('retains full prefix fallback when a module is replaced during hot reload', async () => {
    const before = message()
    const after = append(before, 'pre-reload tail')
    vi.resetModules()
    const fresh = await import('../src/renderer/conversation-message-appends')
    expect(fresh.getConversationMessageAppend(before, after)).toBeUndefined()
    const { text: _text, ...fields } = after
    const latest = fresh.appendConversationMessageText(after, fields, 'post-reload tail')
    expect(fresh.getConversationMessageAppend(after, latest)).toEqual({
      baseLength: after.text.length,
      value: 'post-reload tail',
    })
    const projected = createConversationCheckpointProjector()(
      [thread([before])],
      [thread([latest])],
      10,
      20,
      capabilities,
    )!
    const delta = projected.upserts[0].messages
    expect(delta.mode).toBe('patch')
    if (delta.mode !== 'patch') throw new Error('Expected a message patch')
    expect(delta.fields?.[0].append?.text).toEqual({
      baseLength: before.text.length,
      value: 'pre-reload tailpost-reload tail',
    })
  })
})

describe('owned append source aliases', () => {
  it('forwards a genuine view append into an exact raw projection with opaque fields', () => {
    const before = message()
    const rawBefore = { ...before, turn: 'future-turn', futureField: { exact } }
    bindConversationMessageAppendSource(before, rawBefore)
    const after = append(before, '\r\n🧪  ')
    const rawAfter = { ...rawBefore, text: after.text }
    projectConversationMessageAppendSource(before, rawBefore, after, rawAfter)
    rejectLargePrefixScans()
    expect(getConversationMessageAppend(rawBefore, rawAfter)).toEqual({
      baseLength: rawBefore.text.length,
      value: '\r\n🧪  ',
    })
    expect(rawAfter.futureField).toBe(rawBefore.futureField)
    expect(rawAfter.turn).toBe('future-turn')
  })

  it('rejects a foreign raw base even when its ID and text match', () => {
    const before = message()
    const rawBefore = { ...before, futureField: true }
    bindConversationMessageAppendSource(before, rawBefore)
    const after = append(before, 'tail')
    const foreign = { ...rawBefore }
    const rawAfter = { ...foreign, text: after.text }
    projectConversationMessageAppendSource(before, foreign, after, rawAfter)
    expect(getConversationMessageAppend(foreign, rawAfter)).toBeUndefined()
    expect(getConversationMessageAppend(rawBefore, rawAfter)).toBeUndefined()
  })

  it('invalidates a previous raw alias when the view is rebound to another source', () => {
    const before = append(message(), 'established-owned tail')
    const original = { ...before, source: 'first' }
    bindConversationMessageAppendSource(before, original)
    const replacement = { ...before, source: 'second' }
    bindConversationMessageAppendSource(before, replacement)
    const after = append(before, 'tail')
    const staleAfter = { ...original, text: after.text }
    projectConversationMessageAppendSource(before, original, after, staleAfter)
    expect(getConversationMessageAppend(original, staleAfter)).toBeUndefined()
    const currentAfter = { ...replacement, text: after.text }
    projectConversationMessageAppendSource(before, replacement, after, currentAfter)
    expect(getConversationMessageAppend(replacement, currentAfter)).toEqual({
      baseLength: replacement.text.length,
      value: 'tail',
    })
  })

  it.each(['before', 'after'] as const)('rejects altered %s raw text', (side) => {
    const before = message()
    const rawBefore = { ...before }
    bindConversationMessageAppendSource(before, rawBefore)
    const after = append(before, 'tail')
    const rawAfter = { ...rawBefore, text: after.text }
    const target = side === 'before' ? rawBefore : rawAfter
    target.text = '!' + target.text.slice(1)
    projectConversationMessageAppendSource(before, rawBefore, after, rawAfter)
    expect(getConversationMessageAppend(rawBefore, rawAfter)).toBeUndefined()
  })

  it('does not give an ordinary cloned edit privately owned append status', () => {
    const before = message()
    const rawBefore = { ...before }
    bindConversationMessageAppendSource(before, rawBefore)
    const after = { ...before, text: before.text + 'tail' }
    const rawAfter = { ...rawBefore, text: after.text }
    projectConversationMessageAppendSource(before, rawBefore, after, rawAfter)
    expect(getConversationMessageAppend(rawBefore, rawAfter)).toBeUndefined()
  })

  it.each(['id', 'text'] as const)(
    'does not invoke %s accessors while binding or forwarding a raw source',
    (key) => {
      const before = message()
      const rawBefore = { ...before }
      const read = vi.fn(() => {
        throw new Error('Raw source accessors are not proof data.')
      })
      Object.defineProperty(rawBefore, key, { get: read, enumerable: true })
      bindConversationMessageAppendSource(before, rawBefore)
      const after = append(before, 'tail')
      const rawAfter = { ...before, text: after.text }
      projectConversationMessageAppendSource(before, rawBefore, after, rawAfter)
      expect(getConversationMessageAppend(before, rawAfter)).toBeUndefined()
      expect(read).not.toHaveBeenCalled()
    },
  )

  it('restores and streams losslessly through the actual state/source projection', () => {
    const opaque = { id: 'opaque', role: 'future-native-role', nativePayload: exact }
    const rawReply = { ...message(), turn: 'native-turn', nativePayload: { exact } }
    const raw = {
      ...thread([]),
      messages: [opaque, rawReply],
      futureThread: { nativeSession: 'unchanged' },
    }
    const before = readThreads([raw])[0]
    const rawBefore = projectConversationSource(before)
    const suffix = '\r\n  provider continuation 🧪  '
    const after = applyEvent(before, {
      sessionId: before.id,
      type: 'text',
      itemId: 'answer',
      text: suffix,
    })
    const rawAfter = projectConversationSource(after)
    expect(rawAfter.messages).toHaveLength(2)
    expect(rawAfter.messages[0]).toBe(opaque)
    expect(rawAfter.messages[1]).toMatchObject({
      id: rawReply.id,
      text: rawReply.text + suffix,
      nativePayload: rawReply.nativePayload,
    })
    expect(rawAfter.workspace).toBe(raw.workspace)
    expect(rawAfter.remoteId).toBe(raw.remoteId)
    rejectLargePrefixScans()
    const projected = createConversationCheckpointProjector()(
      [rawBefore],
      [rawAfter],
      10,
      20,
      capabilities,
    )!
    const delta = projected.upserts[0].messages
    expect(delta.mode).toBe('patch')
    if (delta.mode !== 'patch') throw new Error('Expected a message patch')
    expect(delta.fields?.find((field) => field.id === rawReply.id)?.append?.text).toEqual({
      baseLength: rawReply.text.length,
      value: suffix,
    })
    expect(JSON.stringify(projected)).not.toContain(exact)
  })

  it('retains exact raw alias ownership across an acknowledged empty provider delta', async () => {
    const raw = thread([message(exact, { createdAt: 10 })])
    const before = readThreads([raw])[0]
    const snapshot = createHistorySnapshotProjector()
    const client = new ConversationCheckpointClient()
    const save = vi.fn(async () => {})
    const checkpoint = vi.fn(async (input: ConversationCheckpointInput) => ({
      savedAt: input.savedAt,
    }))
    expect(client.adoptDurableBaseline([raw], 10, save, checkpoint, capabilities)).toBe(true)
    const empty = applyEvent(before, {
      sessionId: before.id,
      type: 'text',
      itemId: 'answer',
      text: '',
    })
    await client.submit(snapshot([empty]), 20, save, checkpoint)
    expect(checkpoint.mock.calls[0][0].upserts).toEqual([])
    const suffix = '\r\nactual resumed suffix 🧪  '
    const after = applyEvent(empty, {
      sessionId: before.id,
      type: 'text',
      itemId: 'answer',
      text: suffix,
    })
    const history = snapshot([after])
    rejectLargePrefixScans()
    await client.submit(history, 30, save, checkpoint)
    const input = checkpoint.mock.calls[1][0]
    const delta = input.upserts[0].messages
    expect(delta.mode).toBe('patch')
    if (delta.mode !== 'patch') throw new Error('Expected a message patch')
    expect(delta.fields?.find((field) => field.id === raw.messages[0].id)?.append?.text).toEqual({
      baseLength: raw.messages[0].text.length,
      value: suffix,
    })
    expect(save).not.toHaveBeenCalled()
  })

  it('persists an in-place text mutation after acknowledgement even when the view keeps its array identity', async () => {
    const rawMessage = { ...message(exact, { createdAt: 10 }), futureMessage: { retained: true } }
    const raw = thread([rawMessage])
    const before = readThreads([raw])[0]
    const snapshot = createHistorySnapshotProjector()
    const client = new ConversationCheckpointClient()
    const save = vi.fn(async (_history: unknown[], _savedAt?: number) => {})
    const checkpoint = vi.fn(async (input: ConversationCheckpointInput) => ({
      savedAt: input.savedAt,
    }))
    expect(client.adoptDurableBaseline([raw], 10, save, checkpoint, capabilities)).toBe(true)
    const after = applyEvent(before, {
      sessionId: before.id,
      type: 'text',
      itemId: 'answer',
      text: ' acknowledged suffix',
    })
    const acknowledged = snapshot([after])
    await client.submit(acknowledged, 20, save, checkpoint)
    const array = after.messages
    const recorded = acknowledged[0].messages[0].text
    after.messages[0].text = recorded + '\r\n actual in-place edit 🧪  '
    expect(getConversationMessageAppend(before.messages[0], after.messages[0])).toBeUndefined()
    const changedHistory = snapshot([after])
    expect(after.messages).toBe(array)
    expect(changedHistory[0].messages[0].text).toBe(after.messages[0].text)
    expect(acknowledged[0].messages[0].text).toBe(recorded)
    expect((changedHistory[0].messages[0] as Message & Record<string, unknown>).futureMessage).toBe(
      rawMessage.futureMessage,
    )
    rejectLargePrefixScans()
    await client.submit(changedHistory, 30, save, checkpoint)
    expect(save).toHaveBeenCalledExactlyOnceWith(changedHistory, 30)
    expect(checkpoint).toHaveBeenCalledTimes(1)
    expect(save.mock.calls[0][0][0]).toMatchObject({
      workspace: raw.workspace,
      remoteId: raw.remoteId,
      messages: [{ text: after.messages[0].text, futureMessage: rawMessage.futureMessage }],
    })
  })

  it('retains mutation safety for an earlier current message after many other endpoints acknowledge', async () => {
    const raw = thread(
      Array.from({ length: 129 }, (_, index) =>
        message(exact, { id: `reply-${index}`, createdAt: 10 }),
      ),
    )
    const restored = readThreads([raw])[0]
    let current = restored
    const snapshot = createHistorySnapshotProjector()
    const client = new ConversationCheckpointClient()
    const save = vi.fn(async () => {})
    const checkpoint = vi.fn(async (input: ConversationCheckpointInput) => ({
      savedAt: input.savedAt,
    }))
    expect(client.adoptDurableBaseline([raw], 10, save, checkpoint, capabilities)).toBe(true)
    for (let index = 0; index < current.messages.length; index++) {
      const changed = append(current.messages[index], ` acknowledged-${index}`)
      current = {
        ...current,
        messages: current.messages.map((value, position) => (position === index ? changed : value)),
      }
      await client.submit(snapshot([current]), 20 + index, save, checkpoint)
    }
    const previous = current.messages[0].text
    current.messages[0].text = previous + '\r\n actual earlier message edit 🧪  '
    expect(getConversationMessageAppend(restored.messages[0], current.messages[0])).toBeUndefined()
    const history = snapshot([current])
    expect(history[0].messages[0].text).toBe(current.messages[0].text)
    rejectLargePrefixScans()
    await client.submit(history, 200, save, checkpoint)
    expect(save).toHaveBeenCalledExactlyOnceWith(history, 200)
    expect(checkpoint).toHaveBeenCalledTimes(129)
  })

  it('keeps a quarantined endpoint visible to a fresh thread wrapper after its first edited body acknowledges', async () => {
    const raw = thread([message(exact, { createdAt: 10 })])
    const before = readThreads([raw])[0]
    const snapshot = createHistorySnapshotProjector()
    const client = new ConversationCheckpointClient()
    const save = vi.fn(async () => {})
    const checkpoint = vi.fn(async (input: ConversationCheckpointInput) => ({
      savedAt: input.savedAt,
    }))
    expect(client.adoptDurableBaseline([raw], 10, save, checkpoint, capabilities)).toBe(true)
    const after = applyEvent(before, {
      sessionId: before.id,
      type: 'text',
      itemId: 'answer',
      text: ' first private suffix',
    })
    after.messages[0].text = raw.messages[0].text + ' first actual in-place body'
    expect(getConversationMessageAppend(before.messages[0], after.messages[0])).toBeUndefined()
    const first = snapshot([after])
    expect(first[0].messages[0].text).toBe(after.messages[0].text)
    await client.submit(first, 20, save, checkpoint)
    const fresh = { ...after }
    const firstBody = first[0].messages[0].text
    fresh.messages[0].text = firstBody + '\r\nsecond actual body 🧪  '
    expect(getConversationMessageAppend(before.messages[0], fresh.messages[0])).toBeUndefined()
    const second = snapshot([fresh])
    expect(second[0].messages[0].text).toBe(fresh.messages[0].text)
    expect(first[0].messages[0].text).toBe(firstBody)
    rejectLargePrefixScans()
    await client.submit(second, 30, save, checkpoint)
    expect(save).toHaveBeenCalledTimes(2)
    expect(save).toHaveBeenNthCalledWith(1, first, 20)
    expect(save).toHaveBeenNthCalledWith(2, second, 30)
    expect(checkpoint).not.toHaveBeenCalled()
  })

  it('persists an exact in-place edit of a shared native baseline without a recovery source', async () => {
    const before = thread()
    const client = new ConversationCheckpointClient()
    const save = vi.fn(async (_history: unknown[], _savedAt?: number) => {})
    const checkpoint = vi.fn(async (input: ConversationCheckpointInput) => ({
      savedAt: input.savedAt,
    }))
    expect(client.adoptDurableBaseline([before], 10, save, checkpoint, capabilities)).toBe(true)
    const accepted = { ...before, messages: [append(before.messages[0], ' accepted suffix')] }
    await client.submit([accepted], 20, save, checkpoint)
    const durableBody = accepted.messages[0].text
    const unchangedArray = accepted.messages
    accepted.messages[0].text = durableBody + '\r\n exact in-place native edit 🧪  '
    expect(getConversationMessageAppend(before.messages[0], accepted.messages[0])).toBeUndefined()
    rejectLargePrefixScans()
    await client.submit([accepted], 30, save, checkpoint)
    expect(accepted.messages).toBe(unchangedArray)
    expect(save).toHaveBeenCalledExactlyOnceWith([accepted], 30)
    expect(checkpoint).toHaveBeenCalledTimes(1)
    expect(save.mock.calls[0][0]).toEqual([
      {
        ...accepted,
        messages: [
          {
            ...accepted.messages[0],
            text: durableBody + '\r\n exact in-place native edit 🧪  ',
          },
        ],
      },
    ])
  })

  it('retains an exact captured view edit made while a source checkpoint acknowledgement is pending', async () => {
    const rawMessage = {
      ...message(exact, { createdAt: 10 }),
      futureMessage: { exact: '\r\n preserved native metadata 🧪  ' },
    }
    const raw = { ...thread([rawMessage]), futureThread: { retained: true } }
    const before = readThreads([raw])[0]
    const snapshot = createHistorySnapshotProjector()
    const client = new ConversationCheckpointClient()
    const save = vi.fn(async (_history: unknown[], _savedAt?: number) => {})
    let release!: () => void
    const pending = new Promise<void>((resolve) => {
      release = resolve
    })
    const checkpoint = vi.fn(async (input: ConversationCheckpointInput) => {
      if (input.savedAt === 20) await pending
      return { savedAt: input.savedAt }
    })
    expect(client.adoptDurableBaseline([raw], 10, save, checkpoint, capabilities)).toBe(true)
    const after = applyEvent(before, {
      sessionId: before.id,
      type: 'text',
      itemId: 'answer',
      text: ' submitted exact suffix',
    })
    const submitted = snapshot([after])
    const submittedBody = submitted[0].messages[0].text
    const first = client.submit(submitted, 20, save, checkpoint)
    expect(checkpoint).toHaveBeenCalledTimes(1)
    after.messages[0].text = submittedBody + '\r\n changed while native ACK waits 🧪  '
    release()
    expect(await first).toBe(20)
    const fresh = { ...after }
    const latest = snapshot([fresh])
    expect(latest[0].messages[0].text).toBe(after.messages[0].text)
    expect(submitted[0].messages[0].text).toBe(submittedBody)
    expect((latest[0].messages[0] as Message & Record<string, unknown>).futureMessage).toEqual(
      rawMessage.futureMessage,
    )
    expect((latest[0] as Thread & Record<string, unknown>).futureThread).toEqual(raw.futureThread)
    rejectLargePrefixScans()
    await client.submit(latest, 30, save, checkpoint)
    expect(save).toHaveBeenCalledExactlyOnceWith(latest, 30)
    expect(checkpoint).toHaveBeenCalledTimes(1)
    expect(save.mock.calls[0][0][0]).toMatchObject({
      workspace: raw.workspace,
      remoteId: raw.remoteId,
      futureThread: raw.futureThread,
      messages: [{ text: after.messages[0].text, futureMessage: rawMessage.futureMessage }],
    })
  })

  it('detects an owned native message changed while its initial complete save is awaiting acknowledgement', async () => {
    const initial = thread([append(message(), ' initial owned suffix')])
    const client = new ConversationCheckpointClient()
    const committed: { savedAt?: number; history: Thread[] }[] = []
    let release!: () => void
    const pending = new Promise<void>((resolve) => {
      release = resolve
    })
    const save = vi.fn(async (history: unknown[], savedAt?: number) => {
      const written = JSON.parse(JSON.stringify(history)) as Thread[]
      if (savedAt === 20) await pending
      committed.push({ savedAt, history: written })
    })
    const checkpoint = vi.fn(async (input: ConversationCheckpointInput) => ({
      savedAt: input.savedAt,
    }))
    const submittedBody = initial.messages[0].text
    const first = client.submit([initial], 20, save, checkpoint, capabilities)
    expect(save).toHaveBeenCalledTimes(1)
    // The native adapter captured the submitted value before this integration-edge mutation.
    // No registry read occurs here; completing the submitted write must detect the changed owner.
    initial.messages[0].text = submittedBody + '\r\n exact edit while full save waits 🧪  '
    release()
    expect(await first).toBe(20)
    expect(committed[0].history[0].messages[0].text).toBe(submittedBody)
    const fresh = { ...initial, messages: [...initial.messages] }
    rejectLargePrefixScans()
    expect(await client.submit([fresh], 30, save, checkpoint)).toBe(30)
    expect(save).toHaveBeenCalledTimes(2)
    expect(save).toHaveBeenNthCalledWith(2, [fresh], 30)
    expect(checkpoint).not.toHaveBeenCalled()
    expect(committed[1]).toEqual({ savedAt: 30, history: [fresh] })
    expect(committed[1].history[0].messages[0].text).toBe(initial.messages[0].text)
    expect(committed[1].history[0].workspace).toBe(initial.workspace)
    expect(committed[1].history[0].remoteId).toBe(initial.remoteId)
  })

  it('collects initial complete-save receipts without reading any unregistered settled text', async () => {
    const settled = message('', { id: 'settled' })
    const read = vi.fn(() => {
      throw new Error('Unregistered settled history bodies are not receipt evidence.')
    })
    Object.defineProperty(settled, 'text', { get: read, enumerable: true, configurable: true })
    const before = message()
    const active = append(before, ' active owned suffix')
    const history = [thread([settled, active])]
    const client = new ConversationCheckpointClient()
    const save = vi.fn(async (_history: unknown[], _savedAt?: number) => {})
    const checkpoint = vi.fn(async (input: ConversationCheckpointInput) => ({
      savedAt: input.savedAt,
    }))
    expect(await client.submit(history, 20, save, checkpoint, capabilities)).toBe(20)
    expect(save).toHaveBeenCalledTimes(1)
    expect(save.mock.calls[0][0]).toBe(history)
    expect(checkpoint).not.toHaveBeenCalled()
    expect(getConversationMessageAppend(before, active)).toBeUndefined()
    expect(read).not.toHaveBeenCalled()
  })

  it('persists repeated known text edits when a newly appended message is its own recovery alias', async () => {
    const raw = { ...thread([]), futureThread: { exact: '\r\n retained native metadata 🧪  ' } }
    const restored = readThreads([raw])[0]
    const snapshot = createHistorySnapshotProjector()
    const client = new ConversationCheckpointClient()
    const written: { savedAt?: number; history: Thread[] }[] = []
    const save = vi.fn(async (history: unknown[], savedAt?: number) => {
      written.push({ savedAt, history: JSON.parse(JSON.stringify(history)) as Thread[] })
    })
    const accepted: ConversationCheckpointInput[] = []
    const checkpoint = vi.fn(async (input: ConversationCheckpointInput) => {
      accepted.push(JSON.parse(JSON.stringify(input)) as ConversationCheckpointInput)
      return { savedAt: input.savedAt }
    })
    expect(client.adoptDurableBaseline([raw], 10, save, checkpoint, capabilities)).toBe(true)
    const added = applyEvent(restored, {
      sessionId: restored.id,
      type: 'text',
      itemId: 'answer',
      text: exact,
    })
    const initial = snapshot([added])
    expect(initial[0].messages).toHaveLength(1)
    expect(initial[0].messages[0]).toBe(added.messages[0])
    await client.submit(initial, 20, save, checkpoint)
    expect(checkpoint).toHaveBeenCalledTimes(1)
    const initialDelta = accepted[0].upserts[0].messages
    expect(initialDelta.mode).toBe('patch')
    if (initialDelta.mode !== 'patch') throw new Error('Expected a newly appended message patch')
    expect(initialDelta.upserts).toHaveLength(1)
    expect(initialDelta.upserts[0]).toMatchObject({ id: '1:answer', text: exact })

    added.messages[0].text = exact + '\r\n first known self-alias edit 🧪  '
    expect(getConversationMessageAppend(added.messages[0], added.messages[0])).toBeUndefined()
    const first = snapshot([added])
    expect(first[0].messages).toHaveLength(1)
    expect(first[0].messages[0].text).toBe(added.messages[0].text)
    rejectLargePrefixScans()
    await client.submit(first, 30, save, checkpoint)
    expect(save).toHaveBeenCalledExactlyOnceWith(first, 30)
    expect(written[0].history[0].messages[0].text).toBe(added.messages[0].text)
    const firstBody = written[0].history[0].messages[0].text

    const fresh = { ...added }
    expect(fresh.messages).toBe(added.messages)
    fresh.messages[0].text = firstBody + '\r\n second known self-alias edit 漢字  '
    expect(getConversationMessageAppend(fresh.messages[0], fresh.messages[0])).toBeUndefined()
    const second = snapshot([fresh])
    expect(second[0].messages).toHaveLength(1)
    expect(second[0].messages[0].text).toBe(fresh.messages[0].text)
    await client.submit(second, 40, save, checkpoint)
    expect(save).toHaveBeenCalledTimes(2)
    expect(save).toHaveBeenNthCalledWith(2, second, 40)
    expect(checkpoint).toHaveBeenCalledTimes(1)
    expect(written.map(({ savedAt }) => savedAt)).toEqual([30, 40])
    expect(written[0].history[0].messages[0].text).toBe(firstBody)
    expect(written[1].history[0]).toMatchObject({
      workspace: raw.workspace,
      remoteId: raw.remoteId,
      futureThread: raw.futureThread,
      messages: [{ id: '1:answer', text: fresh.messages[0].text }],
    })
    expect(initialDelta.upserts[0]).toMatchObject({ id: '1:answer', text: exact })
  })

  it.each([
    { key: 'text', name: 'null text', value: null, remove: false },
    { key: 'text', name: 'numeric text', value: 47, remove: false },
    { key: 'text', name: 'removed text', value: undefined, remove: true },
    { key: 'id', name: 'null identity', value: null, remove: false },
    { key: 'id', name: 'numeric identity', value: 47, remove: false },
    { key: 'id', name: 'removed identity', value: undefined, remove: true },
  ])('recovers the actual own value of a known mutated $name', async ({ key, value, remove }) => {
    const rawMessage = {
      ...message(exact, { createdAt: 10 }),
      futureMessage: { exact: '\r\n native future metadata 🧪  ' },
    }
    const raw = { ...thread([rawMessage]), futureThread: { retained: true } }
    const restored = readThreads([raw])[0]
    const snapshot = createHistorySnapshotProjector()
    const client = new ConversationCheckpointClient()
    const written: { savedAt?: number; history: Thread[] }[] = []
    const save = vi.fn(async (history: unknown[], savedAt?: number) => {
      written.push({ savedAt, history: JSON.parse(JSON.stringify(history)) as Thread[] })
    })
    const checkpoint = vi.fn(async (input: ConversationCheckpointInput) => ({
      savedAt: input.savedAt,
    }))
    expect(client.adoptDurableBaseline([raw], 10, save, checkpoint, capabilities)).toBe(true)
    const added = applyEvent(restored, {
      sessionId: restored.id,
      type: 'text',
      itemId: 'answer',
      text: ' actual accepted suffix',
    })
    const initial = snapshot([added])
    const originalJSON = JSON.stringify(initial)
    const original = JSON.parse(originalJSON) as Thread[]
    await client.submit(initial, 20, save, checkpoint)
    const mutated = added.messages[0] as unknown as Record<string, unknown>
    if (remove) delete mutated[key]
    else mutated[key] = value
    expect(getConversationMessageAppend(restored.messages[0], added.messages[0])).toBeUndefined()
    rejectLargePrefixScans()
    const recovered = snapshot([added])
    expect(recovered[0].messages).toHaveLength(1)
    const recoveredRow = recovered[0].messages[0] as unknown as Record<string, unknown>
    expect(Object.hasOwn(recoveredRow, key)).toBe(!remove)
    if (!remove) expect(Object.getOwnPropertyDescriptor(recoveredRow, key)?.value).toBe(value)
    expect(recoveredRow.futureMessage).toEqual(rawMessage.futureMessage)
    expect(JSON.stringify(initial)).toBe(originalJSON)
    expect(await client.submit(recovered, 30, save, checkpoint)).toBe(30)
    expect(save).toHaveBeenCalledExactlyOnceWith(recovered, 30)
    expect(checkpoint).toHaveBeenCalledTimes(1)
    const expectedRow = { ...original[0].messages[0] } as unknown as Record<string, unknown>
    if (remove) delete expectedRow[key]
    else expectedRow[key] = value
    expect(written).toEqual([
      {
        savedAt: 30,
        history: [{ ...original[0], messages: [expectedRow] }],
      },
    ])
  })

  it.each(['id', 'text'] as const)(
    'rejects a known %s accessor before executing its getter or attempting another native write',
    async (key) => {
      const rawMessage = {
        ...message(exact, { createdAt: 10 }),
        futureMessage: { retained: true },
      }
      const raw = thread([rawMessage])
      const restored = readThreads([raw])[0]
      const snapshot = createHistorySnapshotProjector()
      const client = new ConversationCheckpointClient()
      const save = vi.fn(async (_history: unknown[], _savedAt?: number) => {})
      const checkpoint = vi.fn(async (input: ConversationCheckpointInput) => ({
        savedAt: input.savedAt,
      }))
      expect(client.adoptDurableBaseline([raw], 10, save, checkpoint, capabilities)).toBe(true)
      const added = applyEvent(restored, {
        sessionId: restored.id,
        type: 'text',
        itemId: 'answer',
        text: ' actual accepted suffix',
      })
      const initial = snapshot([added])
      const originalJSON = JSON.stringify(initial)
      await client.submit(initial, 20, save, checkpoint)
      const getter = vi.fn(() => {
        throw new Error('User getter must remain unexecuted.')
      })
      Object.defineProperty(added.messages[0], key, {
        get: getter,
        enumerable: true,
        configurable: true,
      })
      expect(getConversationMessageAppend(restored.messages[0], added.messages[0])).toBeUndefined()
      rejectLargePrefixScans()
      expect(() => snapshot([added])).toThrow()
      expect(getter).not.toHaveBeenCalled()
      expect(save).not.toHaveBeenCalled()
      expect(checkpoint).toHaveBeenCalledTimes(1)
      expect(JSON.stringify(initial)).toBe(originalJSON)
    },
  )
})

describe('provider event append registration', () => {
  it.each(['text', 'reasoning', 'plan'] as const)(
    'registers genuine %s deltas without changing event identity or exact text',
    (type) => {
      const before = thread()
      const suffix = '\r\n\tExact provider delta 🧪  '
      const after = applyEvent(before, {
        sessionId: before.id,
        type,
        itemId: 'answer',
        text: suffix,
      })
      expect(after.messages[0].id).toBe(before.messages[0].id)
      expect(after.messages[0].text).toBe(before.messages[0].text + suffix)
      rejectLargePrefixScans()
      expect(getConversationMessageAppend(before.messages[0], after.messages[0])).toEqual({
        baseLength: before.messages[0].text.length,
        value: suffix,
      })
    },
  )

  it('keeps a provider replacement outside the owned append path even when it shares a prefix', () => {
    const before = thread()
    const after = applyEvent(before, {
      sessionId: before.id,
      type: 'text',
      itemId: 'answer',
      status: 'replace',
      text: before.messages[0].text + 'full replacement snapshot',
    })
    expect(getConversationMessageAppend(before.messages[0], after.messages[0])).toBeUndefined()
    const startsWith = vi.spyOn(String.prototype, 'startsWith')
    const projected = createConversationCheckpointProjector()(
      [before],
      [after],
      10,
      20,
      capabilities,
    )!
    const delta = projected.upserts[0].messages
    expect(delta.mode).toBe('patch')
    if (delta.mode !== 'patch') throw new Error('Expected a message patch')
    expect(delta.fields?.[0].append?.text?.value).toBe('full replacement snapshot')
    expect(startsWith.mock.calls.some(([prefix]) => prefix === before.messages[0].text)).toBe(true)
  })

  it('registers exact tool output concatenation while keeping command-to-output replacement untrusted', () => {
    const streamed = message(exact, { role: 'tool', input: 'original command' })
    const before = thread([streamed])
    const suffix = '\r\noutput\tΩ  '
    const after = applyEvent(before, {
      sessionId: before.id,
      type: 'tool-output',
      itemId: 'answer',
      text: suffix,
    })
    expect(getConversationMessageAppend(streamed, after.messages[0])).toEqual({
      baseLength: streamed.text.length,
      value: suffix,
    })
    const command = message(exact, { role: 'tool', input: exact })
    const replaced = applyEvent(thread([command]), {
      sessionId: before.id,
      type: 'tool-output',
      itemId: 'answer',
      text: suffix,
    })
    expect(replaced.messages[0].text).toBe(suffix)
    expect(getConversationMessageAppend(command, replaced.messages[0])).toBeUndefined()
  })

  it('ignores a different native session before registering any append', () => {
    const before = thread()
    const after = applyEvent(before, {
      sessionId: 'a-different-thread',
      type: 'text',
      itemId: 'answer',
      text: 'foreign tail',
    })
    expect(after).toBe(before)
    expect(createConversationMessageAppendAcknowledgement(before.messages[0])).toBeUndefined()
  })
})

describe('bounded acknowledgements for private append nodes', () => {
  it('prunes only the exact accepted node and keeps descendants available', () => {
    const before = message()
    const accepted = append(before, 'first')
    const queued = append(accepted, '\r\nqueued 🧪  ')
    const receipt = createConversationMessageAppendAcknowledgement(accepted)!
    expect(receipt).toBeDefined()
    acknowledgeConversationMessageAppends([receipt])
    expect(getConversationMessageAppend(before, accepted)).toBeUndefined()
    expect(getConversationMessageAppend(accepted, queued)).toEqual({
      baseLength: accepted.text.length,
      value: '\r\nqueued 🧪  ',
    })
    expect(getConversationMessageAppend(before, queued)).toBeUndefined()
  })

  it('does not acknowledge a fork, a forged receipt, or its JSON copy', () => {
    const before = message()
    const accepted = append(before, 'accepted')
    const fork = append(before, 'fork')
    const receipt = createConversationMessageAppendAcknowledgement(accepted)!
    const forged = JSON.parse(JSON.stringify(receipt)) as object
    acknowledgeConversationMessageAppends([{ message: accepted }, forged])
    expect(getConversationMessageAppend(before, accepted)?.value).toBe('accepted')
    acknowledgeConversationMessageAppends([receipt])
    expect(getConversationMessageAppend(before, accepted)).toBeUndefined()
    expect(getConversationMessageAppend(before, fork)?.value).toBe('fork')
  })

  it('consumes a receipt once so a replay cannot prune later descendants', () => {
    const before = message()
    const accepted = append(before, 'first')
    const receipt = createConversationMessageAppendAcknowledgement(accepted)!
    acknowledgeConversationMessageAppends([receipt])
    const next = append(accepted, 'next')
    acknowledgeConversationMessageAppends([receipt])
    expect(getConversationMessageAppend(accepted, next)?.value).toBe('next')
  })

  it('discards a failed write receipt without losing the retry proof', () => {
    const before = message()
    const latest = append(before, 'not yet durable')
    const receipt = createConversationMessageAppendAcknowledgement(latest)!
    discardConversationMessageAppendAcknowledgements([receipt])
    acknowledgeConversationMessageAppends([receipt])
    expect(getConversationMessageAppend(before, latest)).toEqual({
      baseLength: before.text.length,
      value: 'not yet durable',
    })
    const retry = createConversationMessageAppendAcknowledgement(latest)!
    acknowledgeConversationMessageAppends([retry])
    expect(getConversationMessageAppend(before, latest)).toBeUndefined()
  })

  it('does not consume a receipt whose registered message changed while the write was pending', () => {
    const before = message()
    const accepted = append(before, 'pending')
    const next = append(accepted, 'next')
    const receipt = createConversationMessageAppendAcknowledgement(accepted)!
    const original = accepted.text
    accepted.text = '!' + original.slice(1)
    acknowledgeConversationMessageAppends([receipt])
    accepted.text = original
    expect(getConversationMessageAppend(before, accepted)).toBeUndefined()
    expect(getConversationMessageAppend(before, next)?.value).toBe('pendingnext')
  })

  it('does not read any body for an unregistered settled record', () => {
    const read = vi.fn(() => {
      throw new Error('Settled history bodies must remain untouched.')
    })
    const settled = { id: 'settled' }
    Object.defineProperty(settled, 'text', { get: read, enumerable: true })
    expect(createConversationMessageAppendAcknowledgement(settled)).toBeUndefined()
    expect(read).not.toHaveBeenCalled()
  })

  it('drops an overlong unacknowledged node chain and begins an independent bounded root', () => {
    const before = message('short base')
    let current = before
    for (let index = 0; index < 520; index++) current = append(current, 'x')
    expect(getConversationMessageAppend(before, current)).toBeUndefined()
    const next = append(current, '\r\n🧪  ')
    expect(getConversationMessageAppend(current, next)).toEqual({
      baseLength: current.text.length,
      value: '\r\n🧪  ',
    })
    const receipt = createConversationMessageAppendAcknowledgement(current)!
    acknowledgeConversationMessageAppends([receipt])
    expect(getConversationMessageAppend(current, next)?.value).toBe('\r\n🧪  ')
  })

  it('bounds unacknowledged UTF-16 suffix units independently from existing settled text', () => {
    const before = message('base')
    const oversized = append(before, 'x'.repeat(1024 * 1024 + 1))
    expect(getConversationMessageAppend(before, oversized)).toBeUndefined()
    const next = append(oversized, '\r\n🧪  ')
    expect(getConversationMessageAppend(oversized, next)).toEqual({
      baseLength: oversized.text.length,
      value: '\r\n🧪  ',
    })
    const settled = message('🧪'.repeat(1024 * 1024 + 1))
    const after = append(settled, 'tiny tail')
    expect(getConversationMessageAppend(settled, after)).toEqual({
      baseLength: settled.text.length,
      value: 'tiny tail',
    })
  })

  it('drops a chain whose combined small suffixes exceed the UTF-16 retention bound', () => {
    const before = message('base')
    const suffix = '🧪'.repeat(262_145)
    let current = before
    for (let index = 0; index < 2; index++) current = append(current, suffix)
    expect(getConversationMessageAppend(before, current)).toBeUndefined()
    const next = append(current, 'small next tail')
    expect(getConversationMessageAppend(current, next)?.value).toBe('small next tail')
  })
})
