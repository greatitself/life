import { mkdtemp, mkdir, readFile, readdir, rm, symlink, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { Effect } from 'effect'
import { afterEach, describe, expect, it } from 'vitest'
import {
  assessNativeRecoveryPlatformEffect,
  assertOrdinaryRecoveryStateEffect,
  blockedNativeRecoveryPlatformPolicy,
  validateNativeRecoveryPlatformPolicyEffect,
} from '../src/main/native-recovery-platform'

const directories: string[] = []
async function temporary() {
  const directory = await mkdtemp(join(tmpdir(), 'life platform fixture '))
  directories.push(directory)
  return directory
}
afterEach(async () => {
  for (const directory of directories.splice(0))
    await rm(directory, { recursive: true, force: true })
})
const run = Effect.runPromise
const sourceState = {
  format: 1,
  revision: 0,
  current: null,
  history: [],
  enabled: false,
  failed: [],
}

describe('actual protected-state admission', () => {
  it('accepts missing/empty private namespaces and supported opaque ordinary history', async () => {
    const directory = await temporary()
    await run(assertOrdinaryRecoveryStateEffect(directory))
    await mkdir(join(directory, 'native-recovery'))
    await mkdir(join(directory, 'native-recovery-actions'))
    for (const value of [
      [{ id: 'ordinary', nativeRecovery: { opaque: true } }],
      {
        version: 1,
        savedAt: 42,
        threads: [{ nativeRecovery: { imported: true } }],
        future: 'retained',
      },
    ]) {
      const serialized = JSON.stringify(value)
      await writeFile(join(directory, 'conversations.json'), serialized)
      await run(assertOrdinaryRecoveryStateEffect(directory))
      expect(await readFile(join(directory, 'conversations.json'), 'utf8')).toBe(serialized)
    }
  })

  it.each([
    'native-recovery/unknown',
    'native-recovery/.writer.lock/owner.json',
    'native-recovery-actions/partial.tmp',
    'conversations.recovery-receipts.json',
    'conversations.recovery-receipts.json.unknown.tmp',
    'conversations.json.unknown.tmp',
    'source-code/state.json.unknown.tmp',
    'source-code/revisions/.staging-1/recovery-action.json',
    'source-code/revisions/.incorporated-1/recovery-action.json.unknown.tmp',
  ])('preserves every uncertain protected entry %s', async (entry) => {
    const directory = await temporary()
    const path = join(directory, ...entry.split('/'))
    await mkdir(join(path, '..'), { recursive: true })
    await writeFile(path, 'exact protected bytes\r\n🌍')
    await expect(run(assertOrdinaryRecoveryStateEffect(directory))).rejects.toMatchObject({
      operation: 'platform-protected-state',
    })
    expect(await readFile(path, 'utf8')).toBe('exact protected bytes\r\n🌍')
  })

  it('fences native source receipts in state and orphan incorporation archives', async () => {
    const directory = await temporary()
    const source = join(directory, 'source-code')
    await mkdir(join(source, 'revisions', '.incorporated-orphan'), { recursive: true })
    await writeFile(join(source, 'state.json'), JSON.stringify(sourceState))
    const archive = join(source, 'revisions', '.incorporated-orphan', 'incorporation-recovery.json')
    const serialized = JSON.stringify({
      format: 1,
      originalGeneration: 1,
      originalState: { ...sourceState, recoveryActions: [{ opaque: true }] },
    })
    await writeFile(archive, serialized)
    await expect(run(assertOrdinaryRecoveryStateEffect(directory))).rejects.toMatchObject({
      operation: 'platform-protected-state',
    })
    expect(await readFile(archive, 'utf8')).toBe(serialized)
    await rm(archive)
    await writeFile(
      join(source, 'state.json'),
      JSON.stringify({ ...sourceState, recoveryActions: [{ opaque: true }] }),
    )
    await expect(run(assertOrdinaryRecoveryStateEffect(directory))).rejects.toMatchObject({
      operation: 'platform-protected-state',
    })
  })

  it('refuses malformed history, unsupported source state and foreign directory types', async () => {
    const directory = await temporary()
    await writeFile(
      join(directory, 'conversations.json'),
      '{"version":99,"savedAt":0,"threads":[]}',
    )
    await expect(run(assertOrdinaryRecoveryStateEffect(directory))).rejects.toMatchObject({
      operation: 'decode-platform-state',
    })
    await rm(join(directory, 'conversations.json'))
    await writeFile(join(directory, 'native-recovery'), 'foreign directory replacement')
    await expect(run(assertOrdinaryRecoveryStateEffect(directory))).rejects.toMatchObject({
      operation: 'platform-directory',
    })
    expect(await readFile(join(directory, 'native-recovery'), 'utf8')).toBe(
      'foreign directory replacement',
    )
  })

  it('rejects a protected junction or symlink without inspecting or replacing its target', async () => {
    const directory = await temporary()
    const target = await temporary()
    await writeFile(join(target, 'original'), 'target remains owned elsewhere')
    await symlink(
      target,
      join(directory, 'native-recovery'),
      process.platform === 'win32' ? 'junction' : 'dir',
    )
    await expect(run(assertOrdinaryRecoveryStateEffect(directory))).rejects.toMatchObject({
      operation: 'platform-directory',
    })
    expect(await readFile(join(target, 'original'), 'utf8')).toBe('target remains owned elsewhere')
  })

  it('issues frozen canonical policies and rejects cloned or forged mode handles', async () => {
    const directory = await temporary()
    const policy = await run(
      assessNativeRecoveryPlatformEffect({ userData: directory, exclusiveRuntime: true }),
    )
    expect(await run(validateNativeRecoveryPlatformPolicyEffect(policy))).toBe(policy)
    expect(Object.isFrozen(policy)).toBe(true)
    expect(Object.isFrozen(policy.status)).toBe(true)
    for (const invalid of [
      { ...policy },
      { mode: 'unsupported-clean', assertFreshSshStartEffect: () => Effect.void },
    ])
      await expect(run(validateNativeRecoveryPlatformPolicyEffect(invalid))).rejects.toMatchObject({
        operation: 'platform-policy',
      })
    const blocked = blockedNativeRecoveryPlatformPolicy(directory, new Error('storage failure'))
    expect(blocked.mode).toBe('blocked')
    await expect(run(blocked.assertFreshSshStartEffect())).rejects.toMatchObject({
      operation: 'platform-initialize',
    })
  })

  it.runIf(process.platform === 'win32')(
    'on actual Windows admits fresh SSH only while protected state stays clean',
    async () => {
      const directory = await temporary()
      const options = { userData: directory, exclusiveRuntime: true }
      const policy = await run(assessNativeRecoveryPlatformEffect(options))
      expect(policy.mode).toBe('unsupported-clean')
      await run(policy.assertFreshSshStartEffect('ssh'))
      await expect(run(policy.assertFreshSshStartEffect('local'))).rejects.toMatchObject({
        operation: 'platform-local',
      })
      options.userData = await temporary()
      await mkdir(join(directory, 'native-recovery'))
      await writeFile(join(directory, 'native-recovery', 'appeared-later'), 'preserved')
      await expect(run(policy.assertFreshSshStartEffect())).rejects.toMatchObject({
        operation: 'platform-protected-state',
      })
      expect(
        (
          await run(
            assessNativeRecoveryPlatformEffect({ userData: directory, exclusiveRuntime: true }),
          )
        ).mode,
      ).toBe('blocked')
      expect(await readdir(join(directory, 'native-recovery'))).toEqual(['appeared-later'])
    },
  )

  it
    .runIf(process.platform === 'win32')
    .each([
      'Conversations.Recovery-Receipts.Json',
      'Conversations.Json.fixture.TMP',
      'source-code/STATE.JSON.fixture.TMP',
      'source-code/revisions/.staging-1/Recovery-Action.JSON',
      'source-code/revisions/.incorporated-1/INCORPORATION-RECOVERY.JSON.fixture.TMP',
    ])('on actual Windows fences case-insensitive protected artifact %s', async (entry) => {
    const directory = await temporary()
    const path = join(directory, ...entry.split('/'))
    await mkdir(join(path, '..'), { recursive: true })
    await writeFile(path, 'case-insensitive protected bytes')
    await expect(run(assertOrdinaryRecoveryStateEffect(directory))).rejects.toMatchObject({
      operation: 'platform-protected-state',
    })
    expect(await readFile(path, 'utf8')).toBe('case-insensitive protected bytes')
  })
})
