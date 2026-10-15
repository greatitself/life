import { describe, expect, it, vi } from 'vitest'
import type { ConversationCheckpointInput } from '../src/shared/conversations'
import {
  ConversationCheckpointClient,
  createConversationCheckpointProjector,
  type ConversationCheckpointOptions,
} from '../src/renderer/conversation-checkpoint-client'
import type { Message, Thread } from '../src/renderer/state'

const capabilities = { supportsMessageFields: true, supportsMessageAppends: true }
const longPrefix = '  Exact café e\u0301 漢字 🧪\r\n'.repeat(64)

function thread(text = longPrefix): Thread {
  return {
    id: 'thread',
    profileId: 'workspace',
    provider: 'codex',
    remoteId: 'native-session',
    title: 'Thread',
    messages: [{ id: 'reply', role: 'assistant', text, turn: 1 }],
    pending: [],
    busy: true,
    turn: 1,
    updatedAt: 1,
    mode: 'review',
    model: '',
  }
}

function changed(before: Thread, text: string): Thread {
  return { ...before, messages: [{ ...before.messages[0], text }] }
}

function patch(input: ConversationCheckpointInput) {
  const messages = input.upserts[0].messages
  expect(messages.mode).toBe('patch')
  if (messages.mode !== 'patch') throw new Error('Expected incremental message fields')
  return messages
}

function deferred() {
  let resolve!: () => void
  const promise = new Promise<void>((done) => {
    resolve = done
  })
  return { promise, resolve }
}

describe('renderer string append checkpoint projection', () => {
  it('sends exact suffixes and changed metadata without resending the acknowledged string prefix', () => {
    const before = thread()
    const suffix = '\r\n\tExact continuation café e\u0301 漢字 🧪  '
    const previousMessage = before.messages[0] as Message & Record<string, unknown>
    previousMessage.output = longPrefix + '\r'
    previousMessage.removeMe = 'remove'
    const nextMessage = {
      ...previousMessage,
      text: previousMessage.text + suffix,
      output: (previousMessage.output as string) + '\n  Exact output  ',
      status: 'completed',
      removeMe: undefined,
    }
    const next = { ...before, title: 'Updated thread', messages: [nextMessage] }
    const projected = createConversationCheckpointProjector()(
      [before],
      [next],
      100,
      200,
      capabilities,
    )!
    expect(projected.upserts[0].thread).toMatchObject({
      title: 'Updated thread',
      remoteId: 'native-session',
      profileId: 'workspace',
      provider: 'codex',
    })
    expect(patch(projected)).toEqual({
      mode: 'patch',
      upserts: [],
      fields: [
        {
          id: 'reply',
          set: { status: 'completed' },
          remove: ['removeMe'],
          append: {
            text: { baseLength: previousMessage.text.length, value: suffix },
            output: {
              baseLength: (previousMessage.output as string).length,
              value: '\n  Exact output  ',
            },
          },
        },
      ],
    })
    const serialized = JSON.stringify(projected)
    expect(serialized).not.toContain(longPrefix)
    expect(serialized.length).toBeLessThan(1024)
  })

  it.each([
    { name: 'non-prefix replacement', before: longPrefix, after: 'Replacement ' + longPrefix },
    { name: 'shortened string', before: longPrefix, after: longPrefix.slice(0, -1) },
    { name: 'short prefix', before: 'x'.repeat(1023), after: 'x'.repeat(1023) + 'suffix' },
    { name: 'empty prefix', before: '', after: 'new value' },
    { name: 'non-string prior value', before: 42, after: longPrefix + 'suffix' },
    { name: 'non-string replacement', before: longPrefix, after: null },
  ])('uses an exact set for a $name', ({ before: initial, after: value }) => {
    const before = thread()
    const oldMessage = { ...before.messages[0], text: initial } as unknown as Message
    before.messages = [oldMessage]
    const nextMessage = { ...oldMessage, text: value } as unknown as Message
    const next = { ...before, messages: [nextMessage] }
    const input = createConversationCheckpointProjector()([before], [next], 100, 200, capabilities)!
    expect(patch(input)).toEqual({
      mode: 'patch',
      upserts: [],
      fields: [{ id: 'reply', set: { text: value }, remove: [] }],
    })
  })

  it.each([
    { name: 'threshold prefix', prefix: 'x'.repeat(1024), suffix: '\r\n🧪  ' },
    { name: 'split surrogate pair', prefix: 'x'.repeat(1024) + '\ud83e', suffix: '\uddea  \r\n' },
    { name: 'split CRLF', prefix: longPrefix + '\r', suffix: '\n\t漢字  ' },
  ])(
    'counts UTF-16 units and sends the complete exact suffix for a $name',
    ({ prefix, suffix }) => {
      const before = thread(prefix)
      const next = changed(before, prefix + suffix)
      const input = createConversationCheckpointProjector()(
        [before],
        [next],
        100,
        200,
        capabilities,
      )!
      expect(patch(input).fields).toEqual([
        {
          id: 'reply',
          set: {},
          remove: [],
          append: { text: { baseLength: prefix.length, value: suffix } },
        },
      ])
    },
  )

  it('does not emit an append when a distinct message object has an unchanged string', () => {
    const before = thread()
    const next = changed(before, before.messages[0].text)
    const input = createConversationCheckpointProjector()([before], [next], 100, 200, capabilities)!
    expect(patch(input)).toEqual({ mode: 'patch', upserts: [] })
  })

  it('appends own prototype-like fields as JSON properties and preserves native message identity', () => {
    const before = thread()
    const own = Object.fromEntries(
      ['__proto__', 'constructor', 'prototype'].map((key) => [key, longPrefix]),
    )
    before.messages = [{ ...before.messages[0], ...own }]
    const suffix = '\r\n🧪  '
    const nextProperties = Object.fromEntries(
      Object.keys(own).map((key) => [key, longPrefix + suffix]),
    )
    const next = { ...before, messages: [{ ...before.messages[0], ...nextProperties }] }
    const fields = patch(
      createConversationCheckpointProjector()([before], [next], 100, 200, capabilities)!,
    ).fields![0]
    expect(fields.id).toBe('reply')
    expect(fields.set).toEqual({})
    expect(fields.remove).toEqual([])
    for (const key of ['__proto__', 'constructor', 'prototype']) {
      expect(Object.hasOwn(fields.append!, key)).toBe(true)
      expect(Object.getOwnPropertyDescriptor(fields.append!, key)?.value).toEqual({
        baseLength: longPrefix.length,
        value: suffix,
      })
    }
    expect(Object.getPrototypeOf(fields.append)).toBe(Object.prototype)
    expect(Object.hasOwn(Object.prototype, 'checkpointAppendPollution')).toBe(false)
  })

  it.each([
    { name: 'absent options', options: undefined, fields: false },
    { name: 'default options', options: {}, fields: false },
    {
      name: 'append capability without fields',
      options: { supportsMessageAppends: true },
      fields: false,
    },
    {
      name: 'explicitly disabled fields',
      options: { supportsMessageFields: false, supportsMessageAppends: true },
      fields: false,
    },
    { name: 'field capability alone', options: { supportsMessageFields: true }, fields: true },
    {
      name: 'explicitly disabled appends',
      options: { supportsMessageFields: true, supportsMessageAppends: false },
      fields: true,
    },
  ])('requires both native capabilities for $name', ({ options, fields }) => {
    const before = thread()
    const next = changed(before, longPrefix + 'suffix')
    const input = createConversationCheckpointProjector()(
      [before],
      [next],
      100,
      200,
      options as ConversationCheckpointOptions | undefined,
    )!
    expect(patch(input)).toEqual(
      fields
        ? {
            mode: 'patch',
            upserts: [],
            fields: [{ id: 'reply', set: { text: next.messages[0].text }, remove: [] }],
          }
        : { mode: 'patch', upserts: next.messages },
    )
  })

  it.each([
    { name: 'null collection', history: null },
    { name: 'scalar collection', history: 42 },
    { name: 'object collection', history: {} },
    { name: 'null thread', history: [null] },
    { name: 'scalar thread', history: [42] },
    { name: 'array thread', history: [[]] },
    { name: 'missing messages', history: [{ id: 'thread' }] },
    { name: 'null messages', history: [{ ...thread(), messages: null }] },
    { name: 'scalar messages', history: [{ ...thread(), messages: 42 }] },
    { name: 'object messages', history: [{ ...thread(), messages: {} }] },
  ])('declines incremental projection for a $name without throwing', ({ history }) => {
    const project = createConversationCheckpointProjector()
    const malformed = history as unknown as Thread[]
    expect(project(malformed, [thread()], 100, 200, capabilities)).toBeUndefined()
    expect(project([thread()], malformed, 100, 200, capabilities)).toBeUndefined()
  })
})

describe('acknowledged native string append coordination', () => {
  it('defaults to complete upserts unless a bridge explicitly advertises both capabilities', async () => {
    const client = new ConversationCheckpointClient()
    const save = vi.fn(async () => {})
    const checkpoint = vi.fn(async (input: ConversationCheckpointInput) => ({
      savedAt: input.savedAt,
    }))
    const before = thread()
    expect(client.adoptDurableBaseline([before], 100, save, checkpoint)).toBe(true)
    const next = changed(before, longPrefix + 'suffix')
    await client.submit([next], 200, save, checkpoint)
    expect(patch(checkpoint.mock.calls[0][0])).toEqual({ mode: 'patch', upserts: next.messages })
    expect(save).not.toHaveBeenCalled()
  })

  it('retains capability flags only for the same bridge and honors explicit disabling without losing the base', async () => {
    const client = new ConversationCheckpointClient()
    const save = vi.fn(async () => {})
    const checkpoint = vi.fn(async (input: ConversationCheckpointInput) => ({
      savedAt: input.savedAt,
    }))
    let current = thread()
    expect(client.adoptDurableBaseline([current], 100, save, checkpoint, capabilities)).toBe(true)
    let previous = current
    current = changed(previous, previous.messages[0].text + 'first')
    await client.submit([current], 200, save, checkpoint)
    expect(patch(checkpoint.mock.calls[0][0]).fields![0].append).toEqual({
      text: { baseLength: previous.messages[0].text.length, value: 'first' },
    })

    previous = current
    current = changed(previous, previous.messages[0].text + 'second')
    await client.submit([current], 300, save, checkpoint, { supportsMessageAppends: false })
    expect(checkpoint.mock.calls[1][0].baseSavedAt).toBe(200)
    expect(patch(checkpoint.mock.calls[1][0]).fields).toEqual([
      { id: 'reply', set: { text: current.messages[0].text }, remove: [] },
    ])

    previous = current
    current = changed(previous, previous.messages[0].text + 'third')
    await client.submit([current], 400, save, checkpoint)
    expect(patch(checkpoint.mock.calls[2][0]).fields).toEqual([
      { id: 'reply', set: { text: current.messages[0].text }, remove: [] },
    ])

    previous = current
    current = changed(previous, previous.messages[0].text + 'fourth')
    await client.submit([current], 500, save, checkpoint, { supportsMessageAppends: true })
    expect(patch(checkpoint.mock.calls[3][0]).fields![0].append).toEqual({
      text: { baseLength: previous.messages[0].text.length, value: 'fourth' },
    })

    previous = current
    current = changed(previous, previous.messages[0].text + 'fifth')
    await client.submit([current], 600, save, checkpoint, { supportsMessageFields: false })
    expect(patch(checkpoint.mock.calls[4][0])).toEqual({ mode: 'patch', upserts: current.messages })
    expect(save).not.toHaveBeenCalled()
  })

  it.each(['save', 'checkpoint'] as const)(
    'clears capability flags when the native %s function changes',
    async (kind) => {
      const client = new ConversationCheckpointClient()
      const save = vi.fn(async () => {})
      const checkpoint = vi.fn(async (input: ConversationCheckpointInput) => ({
        savedAt: input.savedAt,
      }))
      const before = thread()
      expect(client.adoptDurableBaseline([before], 100, save, checkpoint, capabilities)).toBe(true)
      const newSave = kind === 'save' ? vi.fn(async () => {}) : save
      const newCheckpoint =
        kind === 'checkpoint'
          ? vi.fn(async (input: ConversationCheckpointInput) => ({ savedAt: input.savedAt }))
          : checkpoint
      const first = changed(before, longPrefix + 'first')
      await client.submit([first], 200, newSave, newCheckpoint)
      expect(newSave).toHaveBeenCalledExactlyOnceWith([first], 200)
      const second = changed(first, first.messages[0].text + 'second')
      await client.submit([second], 300, newSave, newCheckpoint)
      expect(newCheckpoint).toHaveBeenCalledTimes(1)
      expect(patch(newCheckpoint.mock.calls[0][0])).toEqual({
        mode: 'patch',
        upserts: second.messages,
      })
    },
  )

  it('coalesces pending snapshots and derives the next suffix from the acknowledged checkpoint', async () => {
    const release = deferred()
    const client = new ConversationCheckpointClient()
    const save = vi.fn(async () => {})
    const checkpoint = vi.fn(async (input: ConversationCheckpointInput) => {
      if (input.savedAt === 200) await release.promise
      return { savedAt: input.savedAt }
    })
    const before = thread()
    expect(client.adoptDurableBaseline([before], 100, save, checkpoint, capabilities)).toBe(true)
    const first = changed(before, longPrefix + ' first')
    const middle = changed(first, first.messages[0].text + ' intermediate')
    const latest = changed(first, first.messages[0].text + '\r\n\tFinal 🧪  ')
    const firstSubmission = client.submit([first], 200, save, checkpoint)
    const middleSubmission = client.submit([middle], 300, save, checkpoint)
    const lastSubmission = client.submit([latest], 400, save, checkpoint)
    expect(checkpoint).toHaveBeenCalledTimes(1)
    expect(patch(checkpoint.mock.calls[0][0]).fields![0].append).toEqual({
      text: { baseLength: longPrefix.length, value: ' first' },
    })
    release.resolve()
    expect(await Promise.all([firstSubmission, middleSubmission, lastSubmission])).toEqual([
      200, 400, 400,
    ])
    expect(checkpoint).toHaveBeenCalledTimes(2)
    expect(checkpoint.mock.calls[1][0]).toMatchObject({ baseSavedAt: 200, savedAt: 400 })
    expect(patch(checkpoint.mock.calls[1][0]).fields![0].append).toEqual({
      text: { baseLength: first.messages[0].text.length, value: '\r\n\tFinal 🧪  ' },
    })
    expect(JSON.stringify(checkpoint.mock.calls)).not.toContain('intermediate')
    expect(save).not.toHaveBeenCalled()
  })

  it.each(['supportsMessageAppends', 'supportsMessageFields'] as const)(
    'retains an explicit %s disable when an omitted-options submission replaces pending work',
    async (capability) => {
      const release = deferred()
      const client = new ConversationCheckpointClient()
      const save = vi.fn(async () => {})
      const checkpoint = vi.fn(async (input: ConversationCheckpointInput) => {
        if (input.savedAt === 200) await release.promise
        return { savedAt: input.savedAt }
      })
      const before = thread()
      expect(client.adoptDurableBaseline([before], 100, save, checkpoint, capabilities)).toBe(true)
      const first = changed(before, longPrefix + ' first')
      const middle = changed(first, first.messages[0].text + ' intermediate')
      const latest = changed(first, first.messages[0].text + ' latest')
      const firstSubmission = client.submit([first], 200, save, checkpoint)
      const middleSubmission = client.submit([middle], 300, save, checkpoint, {
        [capability]: false,
      })
      const lastSubmission = client.submit([latest], 400, save, checkpoint)
      release.resolve()
      expect(await Promise.all([firstSubmission, middleSubmission, lastSubmission])).toEqual([
        200, 400, 400,
      ])
      expect(checkpoint).toHaveBeenCalledTimes(2)
      expect(checkpoint.mock.calls[1][0]).toMatchObject({ baseSavedAt: 200, savedAt: 400 })
      expect(patch(checkpoint.mock.calls[1][0])).toEqual(
        capability === 'supportsMessageFields'
          ? { mode: 'patch', upserts: latest.messages }
          : {
              mode: 'patch',
              upserts: [],
              fields: [{ id: 'reply', set: { text: latest.messages[0].text }, remove: [] }],
            },
      )
      expect(save).not.toHaveBeenCalled()
    },
  )

  it('does not inherit capabilities from replaced pending work owned by a different bridge', async () => {
    const release = deferred()
    const client = new ConversationCheckpointClient()
    const save = vi.fn(async () => {})
    const nextSave = vi.fn(async () => {})
    const checkpoint = vi.fn(async (input: ConversationCheckpointInput) => {
      if (input.savedAt === 200) await release.promise
      return { savedAt: input.savedAt }
    })
    const before = thread()
    expect(client.adoptDurableBaseline([before], 100, save, checkpoint, capabilities)).toBe(true)
    const first = changed(before, longPrefix + ' first')
    const middle = changed(first, first.messages[0].text + ' intermediate')
    const latest = changed(first, first.messages[0].text + ' latest')
    const firstSubmission = client.submit([first], 200, save, checkpoint)
    const middleSubmission = client.submit([middle], 300, save, checkpoint, capabilities)
    const lastSubmission = client.submit([latest], 400, nextSave, checkpoint)
    release.resolve()
    expect(await Promise.all([firstSubmission, middleSubmission, lastSubmission])).toEqual([
      200, 400, 400,
    ])
    expect(nextSave).toHaveBeenCalledExactlyOnceWith([latest], 400)
    const final = changed(latest, latest.messages[0].text + ' final')
    await client.submit([final], 500, nextSave, checkpoint)
    expect(patch(checkpoint.mock.calls[1][0])).toEqual({ mode: 'patch', upserts: final.messages })
  })
})
