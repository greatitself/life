import { createHash } from 'node:crypto'
import * as fs from 'node:fs/promises'
import type { FileHandle } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { Effect } from 'effect'
import {
  ConversationRecoverySidecarStore,
  selectConversationRecoveryProof,
  type ConversationRecoveryProof,
} from '../src/main/conversation-recovery-sidecar'
import { runEffect } from '../src/main/effect-runtime'

vi.mock('node:fs/promises', async (original) => {
  const actual = await original<typeof import('node:fs/promises')>()
  return {
    ...actual,
    open: vi.fn(actual.open),
    readFile: vi.fn(actual.readFile),
    rename: vi.fn(actual.rename),
    rm: vi.fn(actual.rm),
  }
})
const actualFs = await vi.importActual<typeof import('node:fs/promises')>('node:fs/promises')

let directory: string
let path: string
let store: ConversationRecoverySidecarStore

function hash(bytes: string) {
  return createHash('sha256').update(bytes).digest('hex')
}

function proof(savedAt = 100, bytes = `snapshot:${savedAt}`): ConversationRecoveryProof {
  return {
    hash: hash(bytes),
    savedAt,
    receipt: {
      snapshotId: `native-admitted:${savedAt}`,
      owners: [
        {
          sessionId: 'local-session',
          provider: 'codex',
          profileId: 'machine',
          workspace: '/exact workspace/漢字',
          remoteId: 'native-session',
          nativeRecovery: {
            transport: {
              appliedRevision: savedAt,
              snapshotToken: 'native-issued-token',
              ownerGeneration: 4,
            },
          },
        },
      ],
    },
  }
}

function document(receipts: ConversationRecoveryProof[]) {
  return { format: 'life-conversation-recovery', version: 1, receipts }
}

function wrapFile(
  file: FileHandle,
  overrides: Partial<
    Record<'writeFile' | 'sync' | 'close', (...args: unknown[]) => Promise<unknown>>
  >,
): FileHandle {
  return new Proxy(file, {
    get(target, key) {
      if (Object.hasOwn(overrides, key)) return overrides[key as keyof typeof overrides]
      const value = Reflect.get(target, key, target)
      return typeof value === 'function' ? value.bind(target) : value
    },
  })
}

beforeEach(async () => {
  vi.mocked(fs.open).mockReset().mockImplementation(actualFs.open)
  vi.mocked(fs.readFile).mockReset().mockImplementation(actualFs.readFile)
  vi.mocked(fs.rename).mockReset().mockImplementation(actualFs.rename)
  vi.mocked(fs.rm).mockReset().mockImplementation(actualFs.rm)
  directory = await fs.mkdtemp(join(tmpdir(), 'life-conversation-recovery-sidecar-'))
  path = join(directory, 'conversation-recovery.json')
  store = new ConversationRecoverySidecarStore(path)
})

afterEach(async () => {
  await actualFs.rm(directory, { recursive: true, force: true })
})

describe('private prepared conversation recovery sidecar', () => {
  it('distinguishes missing data, publishes exact receipts privately, and reads them after restart', async () => {
    expect(await runEffect(store.loadEffect())).toBeNull()
    const current = proof()
    expect(await runEffect(store.stageEffect(current))).toEqual(document([current]))
    expect(await runEffect(new ConversationRecoverySidecarStore(path).loadEffect())).toEqual(
      document([current]),
    )
    expect(JSON.parse(await fs.readFile(path, 'utf8'))).toEqual(document([current]))
    expect((await fs.stat(path)).mode & 0o777).toBe(0o600)
    expect(await fs.readdir(directory)).toEqual(['conversation-recovery.json'])
  })

  it('flushes the staged file before publishing it, then flushes the containing directory before success', async () => {
    const operations: string[] = []
    vi.mocked(fs.open).mockImplementation(async (name, flags, mode) => {
      const file = await actualFs.open(name, flags, mode)
      const kind = flags === 'r' ? 'directory' : 'file'
      operations.push(`open:${kind}`)
      return wrapFile(file, {
        sync: async () => {
          operations.push(`sync:${kind}`)
          await file.sync()
        },
        close: async () => {
          operations.push(`close:${kind}`)
          await file.close()
        },
      })
    })
    vi.mocked(fs.rename).mockImplementation(async (...args) => {
      operations.push('rename')
      await actualFs.rename(...args)
    })
    await runEffect(store.stageEffect(proof()))
    expect(operations).toEqual([
      'open:file',
      'sync:file',
      'close:file',
      'rename',
      'open:directory',
      'sync:directory',
      'close:directory',
    ])
  })

  it('retains the old exact-byte proof across the write-ahead crash window and selects the candidate only after history publication', async () => {
    const historyPath = join(directory, 'conversations.json')
    const oldBytes = '{"version":1,"savedAt":100,"threads":[{"text":"Exact\\r\\n漢字 🧪  "}]}'
    const newBytes =
      '{"version":1,"savedAt":200,"threads":[{"text":"Exact\\r\\n漢字 🧪  continued"}]}'
    const old = proof(100, oldBytes)
    const candidate = proof(200, newBytes)
    await fs.writeFile(historyPath, oldBytes)
    await runEffect(store.stageEffect(old))
    await runEffect(store.stageEffect(candidate, old))
    const reopened = await runEffect(new ConversationRecoverySidecarStore(path).loadEffect())
    const beforeHistoryPublication = await fs.readFile(historyPath, 'utf8')
    expect(selectConversationRecoveryProof(reopened, hash(beforeHistoryPublication), 100)).toEqual(
      old,
    )
    expect(
      selectConversationRecoveryProof(reopened, hash(beforeHistoryPublication), 200),
    ).toBeUndefined()
    await fs.writeFile(historyPath, newBytes)
    expect(
      selectConversationRecoveryProof(reopened, hash(await fs.readFile(historyPath, 'utf8')), 200),
    ).toEqual(candidate)
    expect(selectConversationRecoveryProof(reopened, hash(newBytes + '\n'), 200)).toBeUndefined()
    expect(selectConversationRecoveryProof(null, hash(newBytes), 200)).toBeUndefined()
  })

  it('retains only the explicitly hash-validated old proof and newest candidate, discarding a failed older candidate', async () => {
    const old = proof(100)
    const abandoned = proof(200)
    const next = proof(300)
    await runEffect(store.stageEffect(old))
    await runEffect(store.stageEffect(abandoned, old))
    expect(await runEffect(store.stageEffect(next, old))).toEqual(document([old, next]))
    expect(await runEffect(store.loadEffect())).toEqual(document([old, next]))
    expect(await runEffect(store.stageEffect(proof(400)))).toEqual(document([proof(400)]))
  })

  it('deduplicates identical history hashes to the new admitted proof without accumulating entries', async () => {
    const old = proof()
    const candidate = { ...old, receipt: { ...old.receipt, snapshotId: 'new-native-admission' } }
    await runEffect(store.stageEffect(old))
    expect(await runEffect(store.stageEffect(candidate, old))).toEqual(document([candidate]))
    expect(await runEffect(store.loadEffect())).toEqual(document([candidate]))
    const before = await fs.readFile(path, 'utf8')
    await expect(
      runEffect(store.stageEffect({ ...candidate, savedAt: 200 }, old)),
    ).rejects.toMatchObject({ operation: 'validate' })
    expect(await fs.readFile(path, 'utf8')).toBe(before)
  })

  it('accepts an admitted empty-owner receipt without preserving authority for the old bytes', async () => {
    const old = proof()
    const candidate = proof(200)
    candidate.receipt.owners = []
    await runEffect(store.stageEffect(old))
    const result = await runEffect(store.stageEffect(candidate, old))
    expect(selectConversationRecoveryProof(result, candidate.hash, 200)?.receipt.owners).toEqual([])
    expect(selectConversationRecoveryProof(result, candidate.hash, 100)).toBeUndefined()
  })

  it('preserves ordinary prototype-named transport identities as own JSON properties', async () => {
    const current = proof()
    const cursor = current.receipt.owners[0].nativeRecovery.transport
    current.receipt.owners[0].nativeRecovery = Object.fromEntries([
      ['__proto__', cursor],
      ['constructor', { ...cursor, appliedRevision: 200 }],
    ])
    await runEffect(store.stageEffect(current))
    const recovered = (await runEffect(store.loadEffect()))!.receipts[0].receipt.owners[0]
      .nativeRecovery
    expect(Object.keys(recovered)).toEqual(['__proto__', 'constructor'])
    expect(Object.hasOwn(recovered, '__proto__')).toBe(true)
    expect(recovered.__proto__).toEqual(cursor)
    expect(Object.getPrototypeOf(recovered)).toBe(Object.prototype)
  })

  const malformedDocuments: [string, () => unknown][] = [
    ['unknown version', () => ({ ...document([proof()]), version: 2 })],
    ['unknown format', () => ({ ...document([proof()]), format: 'imported-history' })],
    ['extra top-level data', () => ({ ...document([proof()]), imported: true })],
    ['more than two records', () => document([proof(100), proof(200), proof(300)])],
    ['duplicate hashes', () => document([proof(), proof()])],
    ['invalid hash', () => document([{ ...proof(), hash: 'not-a-hash' }])],
    ['unsafe timestamp', () => document([{ ...proof(), savedAt: 2 ** 53 }])],
    ['fractional timestamp', () => document([{ ...proof(), savedAt: 0.5 }])],
    ['negative timestamp', () => document([{ ...proof(), savedAt: -1 }])],
    [
      'relative workspace',
      () => {
        const value = proof()
        value.receipt.owners[0].workspace = 'workspace'
        return document([value])
      },
    ],
    [
      'unsupported provider',
      () => {
        const value = proof() as unknown as { receipt: { owners: { provider: string }[] } }
        value.receipt.owners[0].provider = 'future-provider'
        return { ...document([]), receipts: [value] }
      },
    ],
    [
      'duplicate local owners',
      () => {
        const value = proof()
        value.receipt.owners.push(structuredClone(value.receipt.owners[0]))
        return document([value])
      },
    ],
    [
      'empty transport key beside valid key',
      () => {
        const value = proof()
        value.receipt.owners[0].nativeRecovery[''] =
          value.receipt.owners[0].nativeRecovery.transport
        return document([value])
      },
    ],
    [
      'empty transport map',
      () => {
        const value = proof()
        value.receipt.owners[0].nativeRecovery = {}
        return document([value])
      },
    ],
    [
      'unsafe native revision',
      () => {
        const value = proof()
        value.receipt.owners[0].nativeRecovery.transport.appliedRevision = 2 ** 53
        return document([value])
      },
    ],
    [
      'extra cursor fields',
      () => {
        const value = proof()
        Object.assign(value.receipt.owners[0].nativeRecovery.transport, { imported: true })
        return document([value])
      },
    ],
  ]
  it.each(malformedDocuments)(
    'preserves a sidecar with %s and refuses to stage over it',
    async (_name, value) => {
      const original = JSON.stringify(value())
      await fs.writeFile(path, original)
      await expect(runEffect(store.loadEffect())).rejects.toMatchObject({
        operation: 'validate',
        path,
      })
      await expect(runEffect(store.stageEffect(proof(400)))).rejects.toMatchObject({
        operation: 'validate',
        path,
      })
      expect(await fs.readFile(path, 'utf8')).toBe(original)
      expect(fs.rename).not.toHaveBeenCalled()
    },
  )

  it('preserves malformed JSON bytes and distinguishes a read failure from a missing file', async () => {
    const corrupt = '{"format":"life-conversation-recovery","receipts":['
    await fs.writeFile(path, corrupt)
    await expect(runEffect(store.stageEffect(proof()))).rejects.toMatchObject({
      operation: 'validate',
    })
    expect(await fs.readFile(path, 'utf8')).toBe(corrupt)
    vi.mocked(fs.readFile).mockRejectedValueOnce(
      Object.assign(new Error('read denied'), { code: 'EACCES' }),
    )
    await expect(runEffect(store.stageEffect(proof()))).rejects.toMatchObject({
      operation: 'read',
      cause: { code: 'EACCES' },
    })
    expect(await fs.readFile(path, 'utf8')).toBe(corrupt)
    expect(fs.rename).not.toHaveBeenCalled()
  })

  it('refuses accessors, inherited metadata, symbols, cycles and callable serialization without reading them', async () => {
    const old = proof()
    await runEffect(store.stageEffect(old))
    const before = await fs.readFile(path, 'utf8')
    const getter = vi.fn(() => 'forged')
    const toJSON = vi.fn(() => proof(200))
    const accessor = proof(200)
    Object.defineProperty(accessor.receipt, 'snapshotId', { get: getter, enumerable: true })
    const inherited = Object.assign(Object.create({ hash: proof(200).hash }), proof(200))
    delete inherited.hash
    const symbolic = Object.assign(proof(200), { [Symbol('source')]: true })
    const cyclic = proof(200)
    Object.assign(cyclic.receipt, { cycle: cyclic })
    const serializer = Object.assign(proof(200), { toJSON })
    const customArray = proof(200)
    Object.setPrototypeOf(customArray.receipt.owners, { toJSON })
    for (const invalid of [accessor, inherited, symbolic, cyclic, serializer, customArray]) {
      await expect(runEffect(store.stageEffect(invalid, old))).rejects.toMatchObject({
        operation: 'validate',
      })
      expect(await fs.readFile(path, 'utf8')).toBe(before)
    }
    expect(getter).not.toHaveBeenCalled()
    expect(toJSON).not.toHaveBeenCalled()
  })

  it.each(['open', 'write', 'sync', 'close', 'rename'] as const)(
    'preserves old bytes and cleans staged resources after a %s failure',
    async (failure) => {
      const old = proof()
      await runEffect(store.stageEffect(old))
      const before = await fs.readFile(path, 'utf8')
      const diskError = Object.assign(new Error(`injected ${failure} failure`), { code: 'ENOSPC' })
      if (failure === 'rename') vi.mocked(fs.rename).mockRejectedValueOnce(diskError)
      else if (failure === 'open') vi.mocked(fs.open).mockRejectedValueOnce(diskError)
      else {
        vi.mocked(fs.open).mockImplementationOnce(async (name, flags, mode) => {
          const file = await actualFs.open(name, flags, mode)
          const key = failure === 'write' ? 'writeFile' : failure
          return wrapFile(file, {
            [key]: async () => {
              if (failure === 'close') await file.close()
              throw diskError
            },
          })
        })
      }
      await expect(runEffect(store.stageEffect(proof(200), old))).rejects.toMatchObject({
        _tag: 'PersistenceError',
        operation: failure,
        cause: { code: 'ENOSPC' },
      })
      expect(await fs.readFile(path, 'utf8')).toBe(before)
      expect(await fs.readdir(directory)).toEqual(['conversation-recovery.json'])
      expect(
        selectConversationRecoveryProof(await runEffect(store.loadEffect()), old.hash, 100),
      ).toEqual(old)
      expect(await runEffect(store.stageEffect(proof(200), old))).toEqual(
        document([old, proof(200)]),
      )
    },
  )

  it.each(['sync-directory', 'close-directory'] as const)(
    'returns a typed %s failure and leaves the old proof selectable after sidecar publication',
    async (failure) => {
      const old = proof()
      await runEffect(store.stageEffect(old))
      vi.mocked(fs.open).mockImplementation(async (name, flags, mode) => {
        const file = await actualFs.open(name, flags, mode)
        if (flags !== 'r') return file
        return wrapFile(file, {
          [failure === 'sync-directory' ? 'sync' : 'close']: async () => {
            if (failure === 'close-directory') await file.close()
            throw new Error(`injected ${failure} failure`)
          },
        })
      })
      await expect(runEffect(store.stageEffect(proof(200), old))).rejects.toMatchObject({
        _tag: 'PersistenceError',
        operation: failure,
      })
      expect(
        selectConversationRecoveryProof(await runEffect(store.loadEffect()), old.hash, 100),
      ).toEqual(old)
      expect(await fs.readdir(directory)).toEqual(['conversation-recovery.json'])
    },
  )

  it('reports cleanup finalizer failures through the typed error channel', async () => {
    vi.mocked(fs.rm).mockImplementationOnce(async (...args) => {
      await actualFs.rm(...args)
      throw new Error('injected cleanup failure')
    })
    const failure = await runEffect(Effect.flip(store.stageEffect(proof())))
    expect(failure).toMatchObject({ _tag: 'PersistenceError', operation: 'cleanup' })
    expect(await fs.readdir(directory)).toEqual(['conversation-recovery.json'])
  })
})
