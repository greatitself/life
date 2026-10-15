import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { mkdtemp, readFile, readdir, rename, rm, writeFile } from 'node:fs/promises'
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

function thread() {
  return {
    id: 'thread',
    profileId: 'workspace',
    provider: 'codex',
    sessionId: 'native-session',
    futureThreadField: { retained: true },
    messages: [
      {
        id: 'first',
        role: 'user',
        text: '  Exact prompt\r\n\tUnicode café e\u0301 漢字 🧪  ',
        removeMe: { before: true },
        nullable: 'before',
        futureMessageField: { retained: true },
      },
      {
        id: 'second',
        role: 'assistant',
        text: '  Exact untouched\n  response  ',
        futureMessageField: { values: [null, 42, true] },
      },
    ],
  }
}

function checkpoint(messages: Record<string, unknown>, baseSavedAt = 100, savedAt = 200) {
  const { messages: _, ...metadata } = thread()
  return {
    version: 1,
    baseSavedAt,
    savedAt,
    order: ['thread'],
    upserts: [{ thread: metadata, messages: { mode: 'patch', upserts: [], ...messages } }],
  }
}

async function seed(value: unknown = thread()) {
  await runEffect(engine.saveEffect([value], 100))
}

async function reload() {
  return runEffect(new ConversationCheckpointEngine(directory).loadEffect())
}

beforeEach(async () => {
  vi.mocked(rename).mockReset().mockImplementation(actualFs.rename)
  directory = await mkdtemp(join(tmpdir(), 'life-checkpoint-fields-'))
  engine = new ConversationCheckpointEngine(directory)
})

afterEach(async () => {
  await rm(directory, { recursive: true, force: true })
})

describe('conversation message field checkpoints', () => {
  it('round-trips exact field changes while distinguishing removal from null', async () => {
    const original = thread()
    await seed(original)
    const exact = '  Changed prompt\r\n\tUnicode café e\u0301 漢字 🧪  '
    await expect(
      runEffect(
        engine.checkpointEffect(
          checkpoint({
            fields: [{ id: 'first', set: { text: exact, nullable: null }, remove: ['removeMe'] }],
          }),
        ),
      ),
    ).resolves.toEqual({ savedAt: 200 })
    const expected = {
      version: 1,
      savedAt: 200,
      threads: [
        {
          ...original,
          messages: [
            {
              id: 'first',
              role: 'user',
              text: exact,
              nullable: null,
              futureMessageField: { retained: true },
            },
            original.messages[1],
          ],
        },
      ],
    }
    expect(await runEffect(engine.loadEffect())).toEqual(expected)
    const committed = await reload()
    expect(committed).toEqual(expected)
    expect(JSON.parse(await readFile(join(directory, 'conversations.json'), 'utf8'))).toEqual(
      expected,
    )
    const saved = (committed!.threads[0] as { messages: Record<string, unknown>[] }).messages[0]
    expect(Object.hasOwn(saved, 'removeMe')).toBe(false)
    expect(Object.hasOwn(saved, 'nullable')).toBe(true)
    expect(original.messages[0].removeMe).toEqual({ before: true })
    expect(original.messages[0].nullable).toBe('before')
  })

  it('combines field patches with disjoint message upserts and complete ordering', async () => {
    const original = thread()
    await seed(original)
    const replacement = { id: 'first', role: 'user', text: '  Exact replacement\r\n  ' }
    const added = { id: 'added', futureMessageField: { exact: '\t🧪\r\n' } }
    await runEffect(
      engine.checkpointEffect(
        checkpoint({
          order: ['added', 'second', 'first'],
          upserts: [replacement, added],
          fields: [{ id: 'second', set: { streaming: false }, remove: [] }],
        }),
      ),
    )
    expect((await reload())?.threads).toEqual([
      {
        ...original,
        messages: [added, { ...original.messages[1], streaming: false }, replacement],
      },
    ])
  })

  it('retains unknown fields and gives newly set nested values canonical JSON semantics', async () => {
    const original = thread()
    await seed(original)
    const futureValue = {
      exact: '\r\n\tUnicode café e\u0301 漢字 🧪  ',
      omitted: undefined,
      nonfinite: Number.POSITIVE_INFINITY,
      nested: [{ omitted: undefined, retained: null }, undefined, Number.NaN],
      timestamp: new Date('2026-10-14T00:00:00.000Z'),
    }
    await runEffect(
      engine.checkpointEffect(
        checkpoint({
          fields: [{ id: 'first', set: { futureOpaqueValue: futureValue }, remove: [] }],
        }),
      ),
    )
    expect((await reload())?.threads).toEqual([
      {
        ...original,
        messages: [
          {
            ...original.messages[0],
            futureOpaqueValue: {
              exact: futureValue.exact,
              nonfinite: null,
              nested: [{ retained: null }, null, null],
              timestamp: '2026-10-14T00:00:00.000Z',
            },
          },
          original.messages[1],
        ],
      },
    ])
  })

  it('sets and removes prototype-like names as safe own JSON properties', async () => {
    const original = thread()
    await seed(original)
    const set = JSON.parse(
      '{"__proto__":{"checkpointFieldPollution":true},"constructor":{"exact":"\\r\\n🧪"},"prototype":[null,{"__proto__":"nested own value","constructor":"nested constructor","prototype":"nested prototype"}]}',
    ) as Record<string, unknown>
    await runEffect(
      engine.checkpointEffect(checkpoint({ fields: [{ id: 'first', set, remove: [] }] })),
    )
    const saved = (await reload())!.threads[0] as { messages: Record<string, unknown>[] }
    const message = saved.messages[0]
    for (const key of ['__proto__', 'constructor', 'prototype']) {
      expect(Object.hasOwn(message, key)).toBe(true)
      expect(Object.getOwnPropertyDescriptor(message, key)?.value).toEqual(set[key])
    }
    expect(Object.getPrototypeOf(message)).toBe(Object.prototype)
    expect(Object.hasOwn(Object.prototype, 'checkpointFieldPollution')).toBe(false)
    expect(message).toEqual({ ...original.messages[0], ...set })
    await runEffect(
      engine.checkpointEffect(
        checkpoint(
          {
            fields: [{ id: 'first', set: {}, remove: ['__proto__', 'constructor', 'prototype'] }],
          },
          200,
          300,
        ),
      ),
    )
    const removed = (await reload())!.threads[0] as { messages: Record<string, unknown>[] }
    expect(removed.messages).toEqual(original.messages)
    for (const key of ['__proto__', 'constructor', 'prototype'])
      expect(Object.hasOwn(removed.messages[0], key)).toBe(false)
    expect(Object.hasOwn(Object.prototype, 'checkpointFieldPollution')).toBe(false)
  })

  it.each([
    {
      name: 'missing patch identifier',
      fields: [{ set: { text: 'invalid' }, remove: [] }],
      operation: 'validate',
    },
    {
      name: 'empty patch identifier',
      fields: [{ id: '', set: { text: 'invalid' }, remove: [] }],
      operation: 'validate',
    },
    {
      name: 'message absent from the durable base',
      fields: [{ id: 'missing', set: { text: 'invalid' }, remove: [] }],
      order: ['first', 'second', 'missing'],
      operation: 'base',
    },
    {
      name: 'message absent from checkpoint order',
      fields: [{ id: 'second', set: { text: 'invalid' }, remove: [] }],
      order: ['first'],
      operation: 'validate',
    },
    {
      name: 'duplicate field-patch identifiers',
      fields: [
        { id: 'second', set: { text: 'first change' }, remove: [] },
        { id: 'second', set: { text: 'invalid' }, remove: [] },
      ],
      operation: 'validate',
    },
    {
      name: 'overlapping upsert and field-patch identifiers',
      fields: [{ id: 'second', set: { text: 'invalid' }, remove: [] }],
      upserts: [{ id: 'second', text: 'replacement before invalid field patch' }],
      operation: 'validate',
    },
    {
      name: 'setting the message identifier',
      fields: [{ id: 'second', set: { id: 'second' }, remove: [] }],
      operation: 'validate',
    },
    {
      name: 'removing the message identifier',
      fields: [{ id: 'second', set: {}, remove: ['id'] }],
      operation: 'validate',
    },
    {
      name: 'duplicate field removals',
      fields: [{ id: 'second', set: {}, remove: ['text', 'text'] }],
      operation: 'validate',
    },
    {
      name: 'overlapping set and remove fields',
      fields: [{ id: 'second', set: { text: null }, remove: ['text'] }],
      operation: 'validate',
    },
  ])('rejects $name atomically', async ({ name: _name, fields, operation, ...messages }) => {
    const original = thread()
    await seed(original)
    const path = join(directory, 'conversations.json')
    const serialized = await readFile(path, 'utf8')
    const acknowledged = await runEffect(engine.loadEffect())
    await expect(
      runEffect(
        engine.checkpointEffect(
          checkpoint({
            ...messages,
            fields: [
              { id: 'first', set: { text: 'valid change before rejection' }, remove: ['removeMe'] },
              ...fields,
            ],
          }),
        ),
      ),
    ).rejects.toMatchObject({ operation })
    expect(await readFile(path, 'utf8')).toBe(serialized)
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
          checkpoint({ fields: [{ id: 'first', set: { nullable: null }, remove: [] }] }),
        ),
      ),
    ).resolves.toEqual({ savedAt: 200 })
  })

  it('rejects ambiguous durable message identifiers without changing the original snapshot', async () => {
    const original = thread()
    original.messages[1].id = 'first'
    await seed(original)
    const path = join(directory, 'conversations.json')
    const serialized = await readFile(path, 'utf8')
    await expect(
      runEffect(
        engine.checkpointEffect(
          checkpoint({ fields: [{ id: 'first', set: { nullable: null }, remove: [] }] }),
        ),
      ),
    ).rejects.toMatchObject({ operation: 'identity' })
    expect(await readFile(path, 'utf8')).toBe(serialized)
    expect(await reload()).toEqual({ version: 1, savedAt: 100, threads: [original] })
  })
})

describe('conversation snapshot envelope preservation', () => {
  async function seedEnvelope() {
    const original = {
      ...JSON.parse(
        '{"__proto__":{"checkpointEnvelopePollution":true},"constructor":{"exact":"\\r\\n🧪"},"prototype":[null,{"future":true}]}',
      ),
      version: 1,
      savedAt: 100,
      threads: [thread()],
      futureEnvelope: {
        exact: '  Future envelope\r\n\tUnicode café e\u0301 漢字 🧪  ',
        nested: { values: [null, true, 42, { retained: '  exact  ' }] },
      },
    }
    const serialized = JSON.stringify(original, null, 2) + '\n'
    await writeFile(join(directory, 'conversations.json'), serialized)
    expect(await runEffect(engine.loadEffect())).toEqual(original)
    return { original, serialized }
  }

  it('preserves unknown root fields and safe own properties through an empty checkpoint', async () => {
    const { original } = await seedEnvelope()
    await expect(
      runEffect(
        engine.checkpointEffect({
          version: 1,
          baseSavedAt: 100,
          savedAt: 200,
          order: ['thread'],
          upserts: [],
        }),
      ),
    ).resolves.toEqual({ savedAt: 200 })
    const expected = { ...original, version: 1, savedAt: 200, threads: original.threads }
    expect(await runEffect(engine.loadEffect())).toEqual(expected)
    const durable = await reload()
    expect(durable).toEqual(expected)
    expect(JSON.parse(await readFile(join(directory, 'conversations.json'), 'utf8'))).toEqual(
      expected,
    )
    for (const key of ['__proto__', 'constructor', 'prototype']) {
      expect(Object.hasOwn(durable!, key)).toBe(true)
      expect(Object.getOwnPropertyDescriptor(durable!, key)?.value).toEqual(original[key])
    }
    expect(Object.getPrototypeOf(durable)).toBe(Object.prototype)
    expect(Object.hasOwn(Object.prototype, 'checkpointEnvelopePollution')).toBe(false)
  })

  it('preserves the envelope across full saves while keeping new timestamps and empty membership', async () => {
    const { original } = await seedEnvelope()
    await expect(runEffect(engine.saveEffect([], 200))).resolves.toEqual({ savedAt: 200 })
    const empty = { ...original, version: 1, savedAt: 200, threads: [] }
    expect(await runEffect(engine.loadEffect())).toEqual(empty)
    expect(await reload()).toEqual(empty)
    expect(JSON.parse(await readFile(join(directory, 'conversations.json'), 'utf8'))).toEqual(empty)
    await runEffect(
      engine.checkpointEffect({
        version: 1,
        baseSavedAt: 200,
        savedAt: 300,
        order: [],
        upserts: [],
      }),
    )
    expect(await reload()).toEqual({ ...empty, savedAt: 300 })
    const replacement = { ...thread(), id: 'replacement', sessionId: 'replacement-session' }
    await runEffect(engine.saveEffect([replacement], 400))
    expect(await reload()).toEqual({
      ...original,
      version: 1,
      savedAt: 400,
      threads: [replacement],
    })
  })

  it.each(['checkpoint', 'full save'] as const)(
    'retains the exact envelope and acknowledged base after a failed %s and retries successfully',
    async (operation) => {
      const { original, serialized } = await seedEnvelope()
      const acknowledged = await runEffect(engine.loadEffect())
      const input = checkpoint({
        fields: [
          { id: 'first', set: { text: '  Exact after retry\r\n🧪  ' }, remove: ['removeMe'] },
        ],
      })
      vi.mocked(rename).mockRejectedValueOnce(
        Object.assign(new Error('injected disk full'), { code: 'ENOSPC' }),
      )
      await expect(
        runEffect(
          operation === 'checkpoint' ? engine.checkpointEffect(input) : engine.saveEffect([], 200),
        ),
      ).rejects.toMatchObject({ operation: 'rename', cause: { code: 'ENOSPC' } })
      expect(vi.mocked(rename)).toHaveBeenCalledTimes(1)
      expect(await readFile(join(directory, 'conversations.json'), 'utf8')).toBe(serialized)
      expect(await readdir(directory)).toEqual(['conversations.json'])
      expect(await runEffect(engine.loadEffect())).toEqual(original)
      expect(acknowledged).toEqual(original)
      expect(await reload()).toEqual(original)
      expect(new TextDecoder().decode((await runEffect(engine.loadEncodedEffect()))!)).toBe(
        serialized,
      )
      await expect(
        runEffect(
          operation === 'checkpoint' ? engine.checkpointEffect(input) : engine.saveEffect([], 200),
        ),
      ).resolves.toEqual({ savedAt: 200 })
      const { removeMe: _, ...first } = original.threads[0].messages[0]
      const threads =
        operation === 'checkpoint'
          ? [
              {
                ...original.threads[0],
                messages: [
                  { ...first, text: '  Exact after retry\r\n🧪  ' },
                  original.threads[0].messages[1],
                ],
              },
            ]
          : []
      const expected = { ...original, version: 1, savedAt: 200, threads }
      expect(await runEffect(engine.loadEffect())).toEqual(expected)
      expect(await reload()).toEqual(expected)
      expect(JSON.parse(await readFile(join(directory, 'conversations.json'), 'utf8'))).toEqual(
        expected,
      )
    },
  )
})
