import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import * as fs from 'node:fs/promises'
import { createHash } from 'node:crypto'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Effect } from 'effect'
import { ConversationCheckpointEngine } from '../src/main/conversation-checkpoint-engine'
import type { ConversationRecoveryProof } from '../src/main/conversation-recovery-sidecar'
import { runEffect } from '../src/main/effect-runtime'

vi.mock('node:fs/promises', async (original) => {
  const actual = await original<typeof import('node:fs/promises')>()
  return {
    ...actual,
    rename: vi.fn(actual.rename),
    open: vi.fn(actual.open),
    rm: vi.fn(actual.rm),
    readFile: vi.fn(actual.readFile),
  }
})
const actualFs = await vi.importActual<typeof import('node:fs/promises')>('node:fs/promises')
let directory: string

function thread(revision = 1) {
  return {
    id: 'local-session',
    provider: 'codex',
    profileId: 'machine',
    workspace: '/exact workspace',
    remoteId: 'native-thread',
    nativeRecovery: {
      transport: { appliedRevision: revision, snapshotToken: 'issued-token', ownerGeneration: 3 },
    },
    messages: [{ id: 'message', role: 'assistant', text: 'Exact\r\n漢字 🧪  ' }],
    futureMetadata: { retained: [null, 'opaque'] },
  }
}

beforeEach(async () => {
  directory = await actualFs.mkdtemp(join(tmpdir(), 'life-history-writeahead-'))
  vi.mocked(fs.rename).mockReset().mockImplementation(actualFs.rename)
  vi.mocked(fs.open).mockReset().mockImplementation(actualFs.open)
  vi.mocked(fs.rm).mockReset().mockImplementation(actualFs.rm)
  vi.mocked(fs.readFile).mockReset().mockImplementation(actualFs.readFile)
})
afterEach(async () => {
  await actualFs.rm(directory, { recursive: true, force: true })
})

describe('private history recovery write-ahead authority', () => {
  it('recovers a native-prepared exact-byte proof without depending on a subsequent native ACK', async () => {
    const nativePrepared: ConversationRecoveryProof[] = []
    const engine = new ConversationCheckpointEngine(directory, {
      authorizeRecoveryReceipt: (proof) =>
        Effect.sync(() => {
          nativePrepared.push(proof)
          return proof
        }),
    })
    const ack = await runEffect(engine.saveEffect([thread()], 100))
    const bytes = await actualFs.readFile(join(directory, 'conversations.json'))
    const hash = createHash('sha256').update(bytes).digest('hex')
    expect(ack.nativeRecoveryHash).toBe(hash)
    expect(nativePrepared).toEqual([{ hash, savedAt: 100, receipt: ack.nativeRecovery }])
    const reopened = new ConversationCheckpointEngine(directory)
    await expect(runEffect(reopened.loadRecoveryReceiptEffect())).resolves.toEqual(
      nativePrepared[0],
    )
    expect((await runEffect(reopened.loadEffect()))?.threads).toEqual([thread()])
  })

  it('stages both current and next exact proofs before history replacement, preserving the previous crash boundary', async () => {
    const engine = new ConversationCheckpointEngine(directory, {
      authorizeRecoveryReceipt: Effect.succeed,
    })
    const old = await runEffect(engine.saveEffect([thread()], 100))
    const originalBytes = await actualFs.readFile(join(directory, 'conversations.json'))
    vi.mocked(fs.rename)
      .mockImplementationOnce(actualFs.rename)
      .mockRejectedValueOnce(new Error('history rename interrupted'))
    await expect(runEffect(engine.saveEffect([thread(2)], 200))).rejects.toMatchObject({
      operation: 'rename',
    })
    expect(await actualFs.readFile(join(directory, 'conversations.json'))).toEqual(originalBytes)
    const sidecar = JSON.parse(
      await actualFs.readFile(join(directory, 'conversations.recovery-receipts.json'), 'utf8'),
    )
    expect(sidecar.receipts.map((proof: ConversationRecoveryProof) => proof.savedAt)).toEqual([
      100, 200,
    ])
    const cold = new ConversationCheckpointEngine(directory)
    expect((await runEffect(cold.loadRecoveryReceiptEffect()))?.receipt).toEqual(old.nativeRecovery)
    expect((await runEffect(cold.loadEffect()))?.savedAt).toBe(100)
  })

  it.each(['history bytes', 'history cursor', 'timestamp'] as const)(
    'does not elevate a private receipt after changing %s',
    async (tamper) => {
      const engine = new ConversationCheckpointEngine(directory, {
        authorizeRecoveryReceipt: Effect.succeed,
      })
      await runEffect(engine.saveEffect([thread()], 100))
      const path = join(directory, 'conversations.json')
      const raw = JSON.parse(await actualFs.readFile(path, 'utf8'))
      if (tamper === 'history bytes') raw.threads[0].messages[0].text += 'external import'
      if (tamper === 'history cursor') raw.threads[0].nativeRecovery.transport.appliedRevision = 999
      if (tamper === 'timestamp') raw.savedAt = 200
      await actualFs.writeFile(path, JSON.stringify(raw))
      const preserved = await actualFs.readFile(path)
      const cold = new ConversationCheckpointEngine(directory)
      await expect(runEffect(cold.loadRecoveryReceiptEffect())).resolves.toBeNull()
      await expect(runEffect(cold.loadEffect())).resolves.toEqual(raw)
      expect(await actualFs.readFile(path)).toEqual(preserved)
    },
  )

  it('rejects cached private proof after an external file replacement', async () => {
    const engine = new ConversationCheckpointEngine(directory, {
      authorizeRecoveryReceipt: Effect.succeed,
    })
    await runEffect(engine.saveEffect([thread()], 100))
    await actualFs.writeFile(
      join(directory, 'conversations.json'),
      JSON.stringify({ version: 1, savedAt: 100, threads: [thread(999)] }),
    )
    await expect(runEffect(engine.loadRecoveryReceiptEffect())).resolves.toBeNull()
    expect((await runEffect(engine.loadEffect()))?.threads).toEqual([thread(999)])
  })

  it('preserves unowned imported cursor claims without generating any authoritative receipt on resave', async () => {
    const engine = new ConversationCheckpointEngine(directory, {
      authorizeRecoveryReceipt: Effect.succeed,
    })
    await runEffect(engine.saveEffect([thread()], 100))
    const imported = thread(999)
    const unowned = new ConversationCheckpointEngine(directory, {
      authorizeRecoveryReceipt: () => Effect.succeed(null),
    })
    await expect(runEffect(unowned.saveEffect([imported], 200))).resolves.toEqual({ savedAt: 200 })
    const cold = new ConversationCheckpointEngine(directory)
    await expect(runEffect(cold.loadRecoveryReceiptEffect())).resolves.toBeNull()
    expect((await runEffect(cold.loadEffect()))?.threads).toEqual([imported])
  })

  it('cannot manufacture authority without the private native admission adapter', async () => {
    const engine = new ConversationCheckpointEngine(directory)
    await expect(runEffect(engine.saveEffect([thread(999)], 100))).resolves.toEqual({
      savedAt: 100,
    })
    await expect(
      runEffect(new ConversationCheckpointEngine(directory).loadRecoveryReceiptEffect()),
    ).resolves.toBeNull()
    await expect(
      actualFs.readFile(join(directory, 'conversations.recovery-receipts.json')),
    ).rejects.toMatchObject({ code: 'ENOENT' })
  })

  it('keeps ordinary unowned history writable when directory fsync is unsupported, while native proof commits fail closed', async () => {
    vi.mocked(fs.open).mockImplementation(async (...args) => {
      if (args[0] === directory && args[1] === 'r')
        throw Object.assign(new Error('directory sync unsupported'), { code: 'EPERM' })
      return actualFs.open(...args)
    })
    const ordinary = new ConversationCheckpointEngine(directory)
    await expect(runEffect(ordinary.saveEffect([thread(999)], 100))).resolves.toEqual({
      savedAt: 100,
    })
    const path = join(directory, 'conversations.json')
    const exact = await actualFs.readFile(path)
    const native = new ConversationCheckpointEngine(directory, {
      authorizeRecoveryReceipt: Effect.succeed,
    })
    await expect(runEffect(native.saveEffect([thread()], 200))).rejects.toMatchObject({
      operation: 'open-directory',
    })
    expect(await actualFs.readFile(path)).toEqual(exact)
    await expect(
      actualFs.readFile(join(directory, 'conversations.recovery-receipts.json')),
    ).rejects.toMatchObject({ code: 'ENOENT' })
  })

  it.each(['hash', 'snapshotId', 'revision', 'owner'] as const)(
    'refuses native admission with changed %s before history or sidecar mutation',
    async (change) => {
      const engine = new ConversationCheckpointEngine(directory, {
        authorizeRecoveryReceipt: (candidate) =>
          Effect.sync(() => {
            const proof = structuredClone(candidate)
            if (change === 'hash') return { ...proof, hash: 'f'.repeat(64) }
            if (change === 'snapshotId') proof.receipt.snapshotId += '-other'
            if (change === 'revision')
              proof.receipt.owners[0].nativeRecovery.transport.appliedRevision++
            if (change === 'owner') proof.receipt.owners[0].remoteId += '-other'
            return proof
          }),
      })
      await expect(runEffect(engine.saveEffect([thread()], 100))).rejects.toMatchObject({
        operation: 'recovery-prepare',
      })
      await expect(actualFs.readFile(join(directory, 'conversations.json'))).rejects.toMatchObject({
        code: 'ENOENT',
      })
      await expect(
        actualFs.readFile(join(directory, 'conversations.recovery-receipts.json')),
      ).rejects.toMatchObject({ code: 'ENOENT' })
    },
  )

  it('preserves both the corrupt sidecar and raw history while refusing a receipt-bearing rewrite', async () => {
    const engine = new ConversationCheckpointEngine(directory, {
      authorizeRecoveryReceipt: Effect.succeed,
    })
    await runEffect(engine.saveEffect([thread()], 100))
    const sidecarPath = join(directory, 'conversations.recovery-receipts.json')
    const historyPath = join(directory, 'conversations.json')
    const history = await actualFs.readFile(historyPath)
    await actualFs.writeFile(sidecarPath, '{ damaged private proof')
    const cold = new ConversationCheckpointEngine(directory, {
      authorizeRecoveryReceipt: Effect.succeed,
    })
    await expect(runEffect(cold.loadRecoveryReceiptEffect())).resolves.toBeNull()
    expect((await runEffect(cold.loadEffect()))?.threads).toEqual([thread()])
    await expect(runEffect(cold.saveEffect([thread(2)], 200))).rejects.toMatchObject({
      operation: 'validate',
    })
    expect(await actualFs.readFile(historyPath)).toEqual(history)
    expect(await actualFs.readFile(sidecarPath, 'utf8')).toBe('{ damaged private proof')
  })

  it('recovers the same worker after a preserved sidecar is explicitly repaired', async () => {
    const seed = new ConversationCheckpointEngine(directory, {
      authorizeRecoveryReceipt: Effect.succeed,
    })
    const ack = await runEffect(seed.saveEffect([thread()], 100))
    const path = join(directory, 'conversations.recovery-receipts.json')
    const original = await actualFs.readFile(path)
    await actualFs.writeFile(path, '{ damaged private proof')
    const engine = new ConversationCheckpointEngine(directory, {
      authorizeRecoveryReceipt: Effect.succeed,
    })
    await expect(runEffect(engine.loadRecoveryReceiptEffect())).resolves.toBeNull()
    await actualFs.writeFile(path, original)
    expect((await runEffect(engine.loadRecoveryReceiptEffect()))?.receipt).toEqual(
      ack.nativeRecovery,
    )
    await expect(runEffect(engine.saveEffect([thread(2)], 200))).resolves.toMatchObject({
      savedAt: 200,
    })
  })

  it('adopts the actual renamed base after directory fsync failure, fails the ACK, then retries exact proof durability', async () => {
    const engine = new ConversationCheckpointEngine(directory, {
      authorizeRecoveryReceipt: Effect.succeed,
    })
    await runEffect(engine.saveEffect([thread()], 100))
    let directorySyncs = 0
    vi.mocked(fs.open).mockImplementation(async (...args) => {
      const file = await actualFs.open(...args)
      if (args[0] !== directory || args[1] !== 'r') return file
      return new Proxy(file, {
        get(target, key) {
          if (key === 'sync')
            return async () => {
              directorySyncs++
              if (directorySyncs === 2) throw new Error('history directory sync interrupted')
              return target.sync()
            }
          const value = Reflect.get(target, key, target)
          return typeof value === 'function' ? value.bind(target) : value
        },
      })
    })
    await expect(runEffect(engine.saveEffect([thread(2)], 200))).rejects.toMatchObject({
      operation: 'sync-directory',
    })
    expect((await runEffect(engine.loadEffect()))?.savedAt).toBe(200)
    const disk = JSON.parse(await actualFs.readFile(join(directory, 'conversations.json'), 'utf8'))
    expect(disk.savedAt).toBe(200)
    const proof = await runEffect(engine.loadRecoveryReceiptEffect())
    expect(proof?.savedAt).toBe(200)
    expect(directorySyncs).toBe(3)
    const cold = new ConversationCheckpointEngine(directory)
    await expect(runEffect(cold.loadRecoveryReceiptEffect())).resolves.toEqual(proof)
    expect((await runEffect(cold.loadEffect()))?.threads).toEqual([thread(2)])
    await runEffect(engine.saveEffect([thread(3)], 300))
    const sidecar = JSON.parse(
      await actualFs.readFile(join(directory, 'conversations.recovery-receipts.json'), 'utf8'),
    )
    expect(sidecar.receipts.map((value: ConversationRecoveryProof) => value.savedAt)).toEqual([
      200, 300,
    ])
  })

  it('keeps the older durable proof until a previously failed history directory sync succeeds before the next staging', async () => {
    const engine = new ConversationCheckpointEngine(directory, {
      authorizeRecoveryReceipt: Effect.succeed,
    })
    await runEffect(engine.saveEffect([thread()], 100))
    let directorySyncs = 0
    let refuseResync = true
    vi.mocked(fs.open).mockImplementation(async (...args) => {
      const file = await actualFs.open(...args)
      if (args[0] !== directory || args[1] !== 'r') return file
      return new Proxy(file, {
        get(target, key) {
          if (key === 'sync')
            return async () => {
              directorySyncs++
              if (directorySyncs === 2 || (directorySyncs > 2 && refuseResync))
                throw new Error('directory sync uncertain')
              return target.sync()
            }
          const value = Reflect.get(target, key, target)
          return typeof value === 'function' ? value.bind(target) : value
        },
      })
    })
    await expect(runEffect(engine.saveEffect([thread(2)], 200))).rejects.toMatchObject({
      operation: 'sync-directory',
    })
    const sidecarPath = join(directory, 'conversations.recovery-receipts.json')
    const beforeRetry = await actualFs.readFile(sidecarPath)
    await expect(runEffect(engine.saveEffect([thread(3)], 300))).rejects.toMatchObject({
      operation: 'sync-directory',
    })
    expect(await actualFs.readFile(sidecarPath)).toEqual(beforeRetry)
    expect(
      JSON.parse(beforeRetry.toString()).receipts.map(
        (proof: ConversationRecoveryProof) => proof.savedAt,
      ),
    ).toEqual([100, 200])
    refuseResync = false
    await runEffect(engine.saveEffect([thread(3)], 300))
    const final = JSON.parse(await actualFs.readFile(sidecarPath, 'utf8'))
    expect(final.receipts.map((proof: ConversationRecoveryProof) => proof.savedAt)).toEqual([
      200, 300,
    ])
  })

  it('reloads actual bytes before further writes when cleanup after rename fails and its readback is unavailable', async () => {
    const engine = new ConversationCheckpointEngine(directory, {
      authorizeRecoveryReceipt: Effect.succeed,
    })
    await runEffect(engine.saveEffect([thread()], 100))
    const historyPath = join(directory, 'conversations.json')
    let failedCleanup = false
    let refuseRead = false
    vi.mocked(fs.rm).mockImplementation(async (...args) => {
      if (!failedCleanup && typeof args[0] === 'string' && args[0].startsWith(historyPath + '.')) {
        failedCleanup = true
        refuseRead = true
        throw new Error('cleanup interrupted after rename')
      }
      return actualFs.rm(...args)
    })
    vi.mocked(fs.readFile).mockImplementation(async (...args) => {
      if (args[0] === historyPath && refuseRead)
        throw Object.assign(new Error('readback unavailable'), { code: 'EACCES' })
      return actualFs.readFile(...args)
    })
    await expect(runEffect(engine.saveEffect([thread(2)], 200))).rejects.toMatchObject({
      operation: 'cleanup',
    })
    expect(JSON.parse(await actualFs.readFile(historyPath, 'utf8')).savedAt).toBe(200)
    const sidecarPath = join(directory, 'conversations.recovery-receipts.json')
    const proofBeforeRetry = await actualFs.readFile(sidecarPath)
    await expect(runEffect(engine.saveEffect([thread(3)], 300))).rejects.toMatchObject({
      operation: 'read',
    })
    expect(await actualFs.readFile(sidecarPath)).toEqual(proofBeforeRetry)
    refuseRead = false
    expect((await runEffect(engine.loadEffect()))?.savedAt).toBe(200)
    await runEffect(engine.saveEffect([thread(3)], 300))
    const sidecar = JSON.parse(await actualFs.readFile(sidecarPath, 'utf8'))
    expect(sidecar.receipts.map((proof: ConversationRecoveryProof) => proof.savedAt)).toEqual([
      200, 300,
    ])
  })

  it('adopts a published rename that reports an uncertain error, retaining its exact prepared proof without an ACK', async () => {
    const engine = new ConversationCheckpointEngine(directory, {
      authorizeRecoveryReceipt: Effect.succeed,
    })
    await runEffect(engine.saveEffect([thread()], 100))
    const historyPath = join(directory, 'conversations.json')
    let uncertainRename = true
    vi.mocked(fs.rename).mockImplementation(async (...args) => {
      await actualFs.rename(...args)
      if (args[1] === historyPath && uncertainRename) {
        uncertainRename = false
        throw Object.assign(new Error('rename result unavailable'), { code: 'EIO' })
      }
    })
    await expect(runEffect(engine.saveEffect([thread(2)], 200))).rejects.toMatchObject({
      operation: 'rename',
    })
    expect((await runEffect(engine.loadEffect()))?.savedAt).toBe(200)
    const proof = await runEffect(engine.loadRecoveryReceiptEffect())
    expect(proof?.savedAt).toBe(200)
    const cold = new ConversationCheckpointEngine(directory)
    await expect(runEffect(cold.loadRecoveryReceiptEffect())).resolves.toEqual(proof)
    await runEffect(engine.saveEffect([thread(3)], 300))
    const sidecar = JSON.parse(
      await actualFs.readFile(join(directory, 'conversations.recovery-receipts.json'), 'utf8'),
    )
    expect(sidecar.receipts.map((value: ConversationRecoveryProof) => value.savedAt)).toEqual([
      200, 300,
    ])
  })
})
