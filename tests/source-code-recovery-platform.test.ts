import { mkdtemp, mkdir, readFile, readdir, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { Effect } from 'effect'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { SourceCodeStore } from '../src/main/source-code'
import { builtinExtensionCatalog } from '../src/shared/builtin-extensions'
import {
  assessNativeRecoveryPlatformEffect,
  blockedNativeRecoveryPlatformPolicy,
} from '../src/main/native-recovery-platform'

const pausedRead = vi.hoisted(() => ({
  path: '',
  entered: undefined as (() => void) | undefined,
  resume: undefined as Promise<void> | undefined,
}))
vi.mock('node:fs/promises', async (importOriginal) => {
  const native = await importOriginal<typeof import('node:fs/promises')>()
  return {
    ...native,
    async readFile(
      path: Parameters<typeof native.readFile>[0],
      options?: Parameters<typeof native.readFile>[1],
    ) {
      if (String(path) === pausedRead.path) {
        pausedRead.entered?.()
        await pausedRead.resume
      }
      return native.readFile(path, options)
    },
  }
})

const directories: string[] = []
async function temporary() {
  const directory = await mkdtemp(join(tmpdir(), 'life source policy fixture '))
  directories.push(directory)
  return directory
}
afterEach(async () => {
  pausedRead.path = ''
  pausedRead.entered = undefined
  pausedRead.resume = undefined
  for (const directory of directories.splice(0))
    await rm(directory, { recursive: true, force: true })
})
const state = { format: 1, revision: 0, current: null, history: [], enabled: false, failed: [] }
const options = (directory: string) => ({
  directory: join(directory, 'source-code'),
  sourceDir: process.cwd(),
  nodeModulesDir: join(process.cwd(), 'node_modules'),
})

describe('Source platform persistence', () => {
  it('reads protected source with no initialization, migration, marker or close mutation', async () => {
    const directory = await temporary()
    const source = join(directory, 'source-code')
    await mkdir(source)
    const serialized = JSON.stringify({
      ...state,
      recoveryActions: [
        {
          actionId: 'original',
          intentHash: 'a'.repeat(64),
          payloadHash: 'b'.repeat(64),
          revision: 1,
          snapshotHash: 'c'.repeat(64),
        },
      ],
    })
    await writeFile(join(source, 'state.json'), serialized)
    await writeFile(join(source, '.running'), 'original-owner-marker')
    const store = new SourceCodeStore({
      ...options(directory),
      persistenceMode: 'read-only',
      recoveryPlatform: blockedNativeRecoveryPlatformPolicy(
        directory,
        new Error('unsupported protected state'),
      ),
    })
    expect((await store.init()).enabled).toBe(false)
    await expect(store.disable()).rejects.toMatchObject({ operation: 'source-recovery-platform' })
    await store.close()
    expect(await readdir(source)).toEqual(expect.arrayContaining(['state.json', '.running']))
    expect((await readdir(source)).sort()).toEqual(['.running', 'state.json'])
    expect(await readFile(join(source, 'state.json'), 'utf8')).toBe(serialized)
    expect(await readFile(join(source, '.running'), 'utf8')).toBe('original-owner-marker')
  })

  it('rejects ordinary mode with a forged policy before creating any source namespace', async () => {
    const directory = await temporary()
    const store = new SourceCodeStore({
      ...options(directory),
      persistenceMode: 'ordinary',
      recoveryPlatform: { mode: 'unsupported-clean' } as never,
    })
    await expect(store.init()).rejects.toMatchObject({ operation: 'source-recovery-platform' })
    expect(await readdir(directory)).toEqual([])
  })

  it('preserves a foreign running marker when admission fails or close precedes initialization', async () => {
    const directory = await temporary()
    const source = join(directory, 'source-code')
    await mkdir(source)
    await writeFile(join(source, '.running'), 'foreign-owner')
    for (const initialize of [false, true]) {
      const store = new SourceCodeStore({
        ...options(directory),
        persistenceMode: 'ordinary',
        recoveryPlatform: { mode: 'unsupported-clean' } as never,
      })
      if (initialize)
        await expect(store.init()).rejects.toMatchObject({ operation: 'source-recovery-platform' })
      await store.close()
      await expect(store.init()).rejects.toThrow('closed')
      expect(await readFile(join(source, '.running'), 'utf8')).toBe('foreign-owner')
      expect(await readdir(source)).toEqual(['.running'])
    }
  })

  it('rejects changes before loading the saved source state', async () => {
    const directory = await temporary()
    const source = join(directory, 'source-code')
    await mkdir(source)
    const serialized = JSON.stringify({ ...state, revision: 17, current: 12, history: [11] })
    await writeFile(join(source, 'state.json'), serialized)
    const store = new SourceCodeStore(options(directory))
    await expect(store.disable()).rejects.toMatchObject({ operation: 'source-recovery-platform' })
    await store.close()
    expect(await readFile(join(source, 'state.json'), 'utf8')).toBe(serialized)
  })

  it('retains disabled and deleted built-in choices during read-only rescue', async () => {
    const directory = await temporary()
    const source = join(directory, 'source-code')
    await mkdir(source)
    const catalog = builtinExtensionCatalog.slice(0, 2)
    const serialized = JSON.stringify({
      format: 1,
      revision: 9,
      choices: {
        [catalog[0].id]: { enabled: false, deleted: false },
        [catalog[1].id]: { enabled: false, deleted: true },
      },
    })
    await writeFile(join(source, 'built-in-extensions.json'), serialized)
    const store = new SourceCodeStore({
      ...options(directory),
      persistenceMode: 'read-only',
      builtinExtensions: catalog,
    })
    const snapshot = await store.init()
    expect(snapshot.builtInRevision).toBe(9)
    expect(snapshot.extensions).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ id: catalog[0].id, enabled: false }),
        expect.objectContaining({ id: catalog[1].id, enabled: false, deleted: true }),
      ]),
    )
    await store.close()
    expect(await readFile(join(source, 'built-in-extensions.json'), 'utf8')).toBe(serialized)
    expect(await readdir(source)).toEqual(['built-in-extensions.json'])
  })

  it('binds issued native source policy to its original userData directory', async () => {
    const owner = await temporary()
    const foreign = await temporary()
    const policy = await Effect.runPromise(
      assessNativeRecoveryPlatformEffect({ userData: owner, exclusiveRuntime: true }),
    )
    const store = new SourceCodeStore({
      ...options(foreign),
      persistenceMode: 'native-protected',
      recoveryPlatform: policy,
    })
    await expect(store.init()).rejects.toMatchObject({ operation: 'source-recovery-platform' })
    await store.close()
    expect(await readdir(foreign)).toEqual([])
  })

  it('returns current state on repeated initialization and preserves a replaced running marker', async () => {
    const directory = await temporary()
    const baseline = await temporary()
    await mkdir(join(baseline, 'src', 'renderer'), { recursive: true })
    await writeFile(join(baseline, 'src', 'renderer', 'main.tsx'), '// fixture baseline\n')
    await writeFile(join(baseline, 'package.json'), '{"dependencies":{}}')
    const policy = await Effect.runPromise(
      assessNativeRecoveryPlatformEffect({ userData: directory, exclusiveRuntime: true }),
    )
    const store = new SourceCodeStore({
      ...options(directory),
      sourceDir: baseline,
      persistenceMode: policy.sourcePersistenceMode,
      recoveryPlatform: policy,
    })
    await store.init()
    const changed = await store.disable('saved current source state')
    expect(await store.init()).toEqual(changed)
    await writeFile(join(directory, 'source-code', '.running'), 'replacement-owner')
    await store.close()
    expect(await readFile(join(directory, 'source-code', '.running'), 'utf8')).toBe(
      'replacement-owner',
    )
  })

  it('denies public changes while saved generation metadata is still loading', async () => {
    const directory = await temporary()
    const baseline = await temporary()
    await mkdir(join(baseline, 'src', 'renderer'), { recursive: true })
    await writeFile(join(baseline, 'src', 'renderer', 'main.tsx'), '// fixture baseline\n')
    await writeFile(join(baseline, 'package.json'), '{"dependencies":{}}')
    const generation = join(directory, 'source-code', 'revisions', '1')
    await mkdir(generation, { recursive: true })
    const serialized = JSON.stringify({ ...state, revision: 1, current: 1 })
    await writeFile(join(directory, 'source-code', 'state.json'), serialized)
    await writeFile(
      join(generation, 'metadata.json'),
      JSON.stringify({
        summary: 'Saved generation',
        dependencies: {},
        baseFingerprint: 'previous-installed-source',
        extensions: [],
        baselineOnly: true,
      }),
    )
    const policy = await Effect.runPromise(
      assessNativeRecoveryPlatformEffect({ userData: directory, exclusiveRuntime: true }),
    )
    const store = new SourceCodeStore({
      ...options(directory),
      sourceDir: baseline,
      persistenceMode: policy.sourcePersistenceMode,
      recoveryPlatform: policy,
    })
    let resume!: () => void
    const entered = new Promise<void>((resolve) => {
      pausedRead.entered = resolve
    })
    pausedRead.path = join(generation, 'metadata.json')
    pausedRead.resume = new Promise<void>((resolve) => {
      resume = resolve
    })
    const initializing = store.init()
    try {
      await entered
      await expect(store.disable()).rejects.toMatchObject({
        operation: 'source-recovery-platform',
      })
      expect(await readFile(join(directory, 'source-code', 'state.json'), 'utf8')).toBe(serialized)
    } finally {
      pausedRead.path = ''
      resume()
      await initializing
      await store.close()
    }
  })

  it('rejects a native source action in ordinary mode before parsing or compiling the proposal', async () => {
    const directory = await temporary()
    const store = new SourceCodeStore({ ...options(directory), persistenceMode: 'ordinary' })
    await expect(
      store.apply({}, { actionId: 'native-action', intentHash: 'a'.repeat(64) }),
    ).rejects.toMatchObject({ operation: 'source-recovery-platform' })
    expect(await readdir(directory)).toEqual([])
  })

  it.runIf(process.platform === 'win32')(
    'on actual Windows ordinary source saves state without minting native receipts',
    async () => {
      const directory = await temporary()
      const policy = await Effect.runPromise(
        assessNativeRecoveryPlatformEffect({ userData: directory, exclusiveRuntime: true }),
      )
      expect(policy.mode).toBe('unsupported-clean')
      const store = new SourceCodeStore({
        ...options(directory),
        persistenceMode: policy.sourcePersistenceMode,
        recoveryPlatform: policy,
      })
      await store.init()
      await store.disable('ordinary explicit disable')
      const saved = JSON.parse(await readFile(join(directory, 'source-code', 'state.json'), 'utf8'))
      expect(saved.recoveryActions).toBeUndefined()
      await mkdir(join(directory, 'native-recovery'))
      await writeFile(join(directory, 'native-recovery', 'foreign-record'), 'preserved')
      const before = await readFile(join(directory, 'source-code', 'state.json'))
      await expect(store.disable()).rejects.toMatchObject({ operation: 'source-recovery-platform' })
      expect(await readFile(join(directory, 'source-code', 'state.json'))).toEqual(before)
      await expect(store.close()).rejects.toMatchObject({ operation: 'source-recovery-platform' })
    },
  )

  it.runIf(process.platform === 'win32')(
    'on actual Windows denies default native source persistence without a platform policy',
    async () => {
      const directory = await temporary()
      const store = new SourceCodeStore(options(directory))
      await expect(store.init()).rejects.toMatchObject({ operation: 'source-recovery-platform' })
      await store.close()
      expect(await readdir(directory)).toEqual([])
    },
  )
})
