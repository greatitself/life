import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { mkdtemp, readFile, readdir, rename, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { ConversationCheckpointEngine } from '../src/main/conversation-checkpoint-engine'
import { runEffect } from '../src/main/effect-runtime'

vi.mock('node:fs/promises', async (original) => {
  const actual = await original<typeof import('node:fs/promises')>()
  return { ...actual, rename: vi.fn(actual.rename) }
})
const actualFs = await vi.importActual<typeof import('node:fs/promises')>('node:fs/promises')

let directory: string
let engine: ConversationCheckpointEngine

interface InvalidAppendCase {
  name: string
  append: Record<string, unknown>
  operation: 'base' | 'validate'
  set?: Record<string, unknown>
  remove?: string[]
}

function thread() {
  return {
    id: 'thread',
    profileId: 'workspace',
    provider: 'codex',
    sessionId: 'native-session',
    title: 'Original title',
    futureThreadField: { retained: true },
    messages: [
      {
        id: 'first',
        role: 'assistant',
        text: '  Exact prefix\r\n\tUnicode café e\u0301 漢字 🧪  ',
        output: '  Exact output\r',
        removeMe: { retained: true },
        numeric: 42,
        futureMessageField: { retained: true },
      },
      { id: 'second', role: 'user', text: '  Untouched prompt\r\n🧪  ' },
    ],
  }
}

function checkpoint(
  fields: unknown[],
  options: { baseSavedAt?: number; savedAt?: number; metadata?: Record<string, unknown> } = {},
) {
  const { messages: _, ...metadata } = thread()
  return {
    version: 1,
    baseSavedAt: options.baseSavedAt ?? 100,
    savedAt: options.savedAt ?? 200,
    order: ['thread'],
    upserts: [
      {
        thread: { ...metadata, ...options.metadata },
        messages: { mode: 'patch', upserts: [], fields },
      },
    ],
  }
}

async function seed(value: unknown = thread()) {
  await runEffect(engine.saveEffect([value], 100))
}

async function reload() {
  return runEffect(new ConversationCheckpointEngine(directory).loadEffect())
}

async function encoded() {
  return new TextDecoder().decode((await runEffect(engine.loadEncodedEffect()))!)
}

beforeEach(async () => {
  vi.mocked(rename).mockReset().mockImplementation(actualFs.rename)
  directory = await mkdtemp(join(tmpdir(), 'life-checkpoint-appends-'))
  engine = new ConversationCheckpointEngine(directory)
})

afterEach(async () => {
  await rm(directory, { recursive: true, force: true })
})

describe('conversation message string appends', () => {
  it('round-trips exact UTF-16 suffixes together with field edits and thread metadata', async () => {
    const original = thread()
    await seed(original)
    const suffix = '\r\n\tMore café e\u0301 漢字 🧪  '
    const outputSuffix = '\n  Exact continuation\r\n'
    await expect(
      runEffect(
        engine.checkpointEffect(
          checkpoint(
            [
              {
                id: 'first',
                set: { status: 'completed', nullable: null },
                remove: ['removeMe'],
                append: {
                  text: { baseLength: original.messages[0].text.length, value: suffix },
                  output: { baseLength: original.messages[0].output!.length, value: outputSuffix },
                },
              },
            ],
            { metadata: { title: 'Updated title', updatedAt: 200 } },
          ),
        ),
      ),
    ).resolves.toEqual({ savedAt: 200 })
    const { removeMe: _, ...first } = original.messages[0]
    const expected = {
      version: 1,
      savedAt: 200,
      threads: [
        {
          ...original,
          title: 'Updated title',
          updatedAt: 200,
          messages: [
            {
              ...first,
              text: first.text + suffix,
              output: first.output! + outputSuffix,
              status: 'completed',
              nullable: null,
            },
            original.messages[1],
          ],
        },
      ],
    }
    expect(await runEffect(engine.loadEffect())).toEqual(expected)
    expect(await reload()).toEqual(expected)
    expect(JSON.parse(await readFile(join(directory, 'conversations.json'), 'utf8'))).toEqual(
      expected,
    )
    expect(JSON.parse(await encoded())).toEqual(expected)
    expect(original.messages[0].text).toBe(thread().messages[0].text)
    expect(original.messages[0].removeMe).toEqual({ retained: true })
  })

  it.each([
    { name: 'split surrogate pair', prefix: 'Exact\r\n\ud83e', suffix: '\uddea  \r\n' },
    { name: 'split CRLF', prefix: 'Exact café e\u0301 🧪\r', suffix: '\n\t漢字  ' },
    { name: 'empty own string', prefix: '', suffix: '\t\r\n🧪  ' },
  ])(
    'uses UTF-16 length and preserves a $name across durable reloads',
    async ({ prefix, suffix }) => {
      const original = thread()
      original.messages[0].text = prefix
      await seed(original)
      await runEffect(
        engine.checkpointEffect(
          checkpoint([
            {
              id: 'first',
              set: {},
              remove: [],
              append: { text: { baseLength: prefix.length, value: suffix } },
            },
          ]),
        ),
      )
      const durable = (await reload())!.threads[0] as { messages: { text: string }[] }
      expect(durable.messages[0].text).toBe(prefix + suffix)
      expect(durable.messages[0].text.length).toBe(prefix.length + suffix.length)
      expect(JSON.parse(await encoded()).threads[0].messages[0].text).toBe(prefix + suffix)
    },
  )

  it('appends prototype-like own JSON properties without consulting or changing prototypes', async () => {
    const original = thread()
    const own = JSON.parse(
      '{"__proto__":"  proto\\r\\n","constructor":"  constructor 🧪","prototype":"  prototype\\r"}',
    ) as Record<string, string>
    const first = { ...original.messages[0], ...own }
    await seed({ ...original, messages: [first, original.messages[1]] })
    const append = JSON.parse(
      '{"__proto__":{"baseLength":9,"value":"🧪  "},"constructor":{"baseLength":16,"value":"\\r\\n"},"prototype":{"baseLength":12,"value":"\\n  "}}',
    ) as Record<string, { baseLength: number; value: string }>
    for (const key of Object.keys(append)) append[key].baseLength = own[key].length
    await runEffect(
      engine.checkpointEffect(checkpoint([{ id: 'first', set: {}, remove: [], append }])),
    )
    const saved = (await reload())!.threads[0] as { messages: Record<string, unknown>[] }
    for (const key of Object.keys(append)) {
      expect(Object.hasOwn(saved.messages[0], key)).toBe(true)
      expect(Object.getOwnPropertyDescriptor(saved.messages[0], key)?.value).toBe(
        own[key] + append[key].value,
      )
    }
    expect(Object.getPrototypeOf(saved.messages[0])).toBe(Object.prototype)
    expect(Object.hasOwn(Object.prototype, 'checkpointAppendPollution')).toBe(false)
  })

  const invalidAppends: InvalidAppendCase[] = [
    {
      name: 'stale base length',
      append: { text: { baseLength: thread().messages[0].text.length - 1, value: 'suffix' } },
      operation: 'base',
    },
    {
      name: 'missing own field',
      append: { missing: { baseLength: 0, value: 'suffix' } },
      operation: 'base',
    },
    {
      name: 'inherited field',
      append: { constructor: { baseLength: 0, value: 'suffix' } },
      operation: 'base',
    },
    {
      name: 'non-string durable field',
      append: { numeric: { baseLength: 2, value: 'suffix' } },
      operation: 'base',
    },
    {
      name: 'empty suffix',
      append: { text: { baseLength: thread().messages[0].text.length, value: '' } },
      operation: 'validate',
    },
    {
      name: 'non-string suffix',
      append: { text: { baseLength: thread().messages[0].text.length, value: 42 } },
      operation: 'validate',
    },
    {
      name: 'negative base length',
      append: { text: { baseLength: -1, value: 'suffix' } },
      operation: 'validate',
    },
    {
      name: 'fractional base length',
      append: { text: { baseLength: 1.5, value: 'suffix' } },
      operation: 'validate',
    },
    {
      name: 'unsafe base length',
      append: { text: { baseLength: Number.MAX_SAFE_INTEGER + 1, value: 'suffix' } },
      operation: 'validate',
    },
    {
      name: 'missing base length',
      append: { text: { value: 'suffix' } },
      operation: 'validate',
    },
    {
      name: 'appended message identifier',
      append: { id: { baseLength: 'first'.length, value: 'suffix' } },
      operation: 'validate',
    },
    {
      name: 'overlapping set and append',
      set: { text: 'replacement' },
      append: { text: { baseLength: thread().messages[0].text.length, value: 'suffix' } },
      operation: 'validate',
    },
    {
      name: 'overlapping removal and append',
      remove: ['text'],
      append: { text: { baseLength: thread().messages[0].text.length, value: 'suffix' } },
      operation: 'validate',
    },
  ]
  it.each(invalidAppends)(
    'rejects $name atomically and keeps the accepted base reusable',
    async (invalid) => {
      const original = thread()
      await seed(original)
      const path = join(directory, 'conversations.json')
      const serialized = await readFile(path, 'utf8')
      const cached = await encoded()
      const acknowledged = await runEffect(engine.loadEffect())
      const { name: _, operation, ...fields } = invalid
      await expect(
        runEffect(
          engine.checkpointEffect(
            checkpoint([
              {
                id: 'second',
                set: {},
                remove: [],
                append: { text: { baseLength: original.messages[1].text.length, value: 'valid' } },
              },
              { id: 'first', set: {}, remove: [], ...fields },
            ]),
          ),
        ),
      ).rejects.toMatchObject({ operation })
      expect(await readFile(path, 'utf8')).toBe(serialized)
      expect(await encoded()).toBe(cached)
      expect(await runEffect(engine.loadEffect())).toEqual({
        version: 1,
        savedAt: 100,
        threads: [original],
      })
      expect(acknowledged).toEqual({ version: 1, savedAt: 100, threads: [original] })
      expect(await reload()).toEqual(acknowledged)
      await expect(
        runEffect(
          engine.checkpointEffect(
            checkpoint([
              {
                id: 'first',
                set: {},
                remove: [],
                append: { text: { baseLength: original.messages[0].text.length, value: 'retry' } },
              },
            ]),
          ),
        ),
      ).resolves.toEqual({ savedAt: 200 })
      expect((await reload())!.savedAt).toBe(200)
    },
  )

  it.each([
    { name: 'missing target message', id: 'missing', order: ['first', 'second', 'missing'] },
    { name: 'repeated field target', id: 'second', order: ['first', 'second'] },
  ])(
    'rejects a $name after an earlier valid append without advancing state',
    async ({ id, order }) => {
      const original = thread()
      await seed(original)
      const before = await encoded()
      const input = checkpoint([
        {
          id: 'second',
          set: {},
          remove: [],
          append: { text: { baseLength: original.messages[1].text.length, value: 'valid' } },
        },
        { id, set: {}, remove: [], append: { text: { baseLength: 0, value: 'invalid' } } },
      ])
      input.upserts[0].messages = {
        ...input.upserts[0].messages,
        order,
      } as (typeof input.upserts)[0]['messages']
      await expect(runEffect(engine.checkpointEffect(input))).rejects.toMatchObject({
        operation: id === 'missing' ? 'base' : 'validate',
      })
      expect(await readFile(join(directory, 'conversations.json'), 'utf8')).toBe(before)
      expect(await encoded()).toBe(before)
      expect(await reload()).toEqual({ version: 1, savedAt: 100, threads: [original] })
    },
  )

  it('preserves disk, native state and encoded cache when atomic rename fails, then retries the append', async () => {
    const original = thread()
    await seed(original)
    const before = await encoded()
    const acknowledged = await runEffect(engine.loadEffect())
    const input = checkpoint([
      {
        id: 'first',
        set: { status: 'completed' },
        remove: ['removeMe'],
        append: { text: { baseLength: original.messages[0].text.length, value: '\r\n🧪  ' } },
      },
    ])
    vi.mocked(rename).mockRejectedValueOnce(
      Object.assign(new Error('injected disk full'), { code: 'ENOSPC' }),
    )
    await expect(runEffect(engine.checkpointEffect(input))).rejects.toMatchObject({
      operation: 'rename',
      cause: { code: 'ENOSPC' },
    })
    expect(await readFile(join(directory, 'conversations.json'), 'utf8')).toBe(before)
    expect(await encoded()).toBe(before)
    expect(await runEffect(engine.loadEffect())).toEqual(acknowledged)
    expect(await reload()).toEqual(acknowledged)
    expect(await readdir(directory)).toEqual(['conversations.json'])
    expect(acknowledged).toEqual({ version: 1, savedAt: 100, threads: [original] })
    await expect(runEffect(engine.checkpointEffect(input))).resolves.toEqual({ savedAt: 200 })
    const saved = (await reload())!.threads[0] as { messages: Record<string, unknown>[] }
    expect(saved.messages[0].text).toBe(original.messages[0].text + '\r\n🧪  ')
    expect(Object.hasOwn(saved.messages[0], 'removeMe')).toBe(false)
  })
})
