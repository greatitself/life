import { afterEach, describe, expect, it, vi } from 'vitest'
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { runInNewContext } from 'node:vm'
import { SourceCodeStore } from '../src/main/source-code'
import {
  incorporatedBundleHash,
  incorporatedSourceExtensions,
  isIncorporatedSourceExtension,
} from '../src/main/incorporated-source-extensions'
import type { SourceExtensionBundle } from '../src/shared/source-extensions'

const directories: string[] = []
const stores: SourceCodeStore[] = []
const originalEntry = `import './styles.css'
import { greeting } from '../shared/greeting'
const heading = 'Workspace'
const density = 'comfortable'
;(globalThis as any).__life_baked_test = { heading, density, greeting }
`
const entryPath = 'src/renderer/main.tsx'
const helperPath = 'src/renderer/components/baked-helper.ts'
const baselineFiles = {
  [entryPath]: originalEntry,
  'src/renderer/styles.css': '.workspace { color: #151515; }\n',
  'src/shared/greeting.ts': "export const greeting = 'Research workspace'\n",
}

async function writeSource(sourceDir: string, files: Record<string, string>) {
  for (const [path, content] of Object.entries(files)) {
    await mkdir(dirname(join(sourceDir, path)), { recursive: true })
    await writeFile(join(sourceDir, path), content)
  }
}

async function fixture() {
  const directory = await mkdtemp(join(tmpdir(), 'life-built-in-migration-'))
  directories.push(directory)
  const sourceDir = join(directory, 'installed-source')
  await writeSource(sourceDir, baselineFiles)
  await writeFile(join(sourceDir, 'package.json'), JSON.stringify({ dependencies: {} }))
  const options = {
    sourceDir,
    nodeModulesDir: resolve('node_modules'),
    directory: join(directory, 'source-customizations'),
    compilerTimeoutMs: 10_000,
  }
  const store = new SourceCodeStore(options)
  stores.push(store)
  await store.init()
  return { store, options, sourceDir }
}

async function bakeHeading(store: SourceCodeStore) {
  const snapshot = await store.apply({
    summary: 'Research heading and helper',
    baseRevision: store.get().revision,
    files: [
      { path: entryPath, edits: [{ find: "'Workspace'", replace: "'Research'" }] },
      { path: helperPath, content: 'export const helper = "Old extension helper"\n' },
    ],
  })
  return store.exportExtension(snapshot.extensions[0].id)
}

function identity(bundle: SourceExtensionBundle) {
  return { id: bundle.id, sha256: incorporatedBundleHash(bundle) }
}

async function updateBuiltIn(sourceDir: string) {
  const entry = originalEntry
    .replace("'Workspace'", "'Research'")
    .replace("'comfortable'", "'compact'")
  await writeSource(sourceDir, {
    [entryPath]: entry,
    // The built-in version has additional fixes. Replaying the old 'create' conflicts.
    [helperPath]: 'export const helper = "Fixed built-in helper"\n',
  })
  return entry
}

async function restart(options: ConstructorParameters<typeof SourceCodeStore>[0]) {
  const store = new SourceCodeStore(options)
  stores.push(store)
  await store.init()
  return store
}

async function execute(store: SourceCodeStore) {
  const asset = store.assetPath(store.get().active!.js)
  const scope: Record<string, unknown> = {}
  runInNewContext(await readFile(asset!, 'utf8'), { globalThis: scope })
  return scope.__life_baked_test
}

afterEach(async () => {
  vi.restoreAllMocks()
  await Promise.all(stores.splice(0).map((store) => store.close()))
  await Promise.all(
    directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })),
  )
})

describe('exact built-in source extension migration', () => {
  it('retains all 37 historical bundle identities without source or backup data', () => {
    expect(incorporatedSourceExtensions).toHaveLength(37)
    expect(new Set(incorporatedSourceExtensions.map(({ id }) => id)).size).toBe(37)
    for (const entry of incorporatedSourceExtensions) {
      expect(Object.keys(entry).sort()).toEqual(['id', 'sha256'])
      expect(entry.id).toMatch(/^source-[a-f0-9]{12}$/)
      expect(entry.sha256).toMatch(/^[a-f0-9]{64}$/)
    }
    // The October 9 export no longer included the older export-all archive.
    // Earlier installations must still recognize it without replaying old code.
    expect(incorporatedSourceExtensions.some(({ id }) => id === 'source-9bb3ffbcce4d')).toBe(true)
    expect(incorporatedSourceExtensions.map(({ id }) => id)).toEqual(
      expect.arrayContaining([
        'source-291e3f4359ea',
        'source-265a22e310cd',
        'source-ee937ac6bc82',
        'source-12cfab44e306',
        'source-2b3a5bff463a',
        'source-2f6848a57686',
        'source-deac6139f1b6',
        'source-9d9f38a237da',
        'source-60cf7584c344',
        'source-3ed4505f113d',
      ]),
    )
  })

  it('matches every bundle field independently of object key order and rejects edited identities', async () => {
    const { store } = await fixture()
    const bundle = await bakeHeading(store)
    const manifest = [identity(bundle)]
    const reordered = Object.fromEntries(Object.entries(bundle).reverse()) as SourceExtensionBundle
    expect(incorporatedBundleHash(reordered)).toBe(incorporatedBundleHash(bundle))
    expect(isIncorporatedSourceExtension(reordered, manifest)).toBe(true)
    for (const changed of [
      { ...bundle, name: 'Edited name' },
      { ...bundle, updatedAt: '2030-01-01T00:00:00.000Z' },
      { ...bundle, dependencies: { diff: '8.0.2' } },
      { ...bundle, files: [...bundle.files].reverse() },
      { ...bundle, files: bundle.files.map((file) => ({ ...file, content: 'Different code' })) },
    ]) {
      expect(isIncorporatedSourceExtension(changed as SourceExtensionBundle, manifest)).toBe(false)
    }
  })

  it('archives exact layers without compiling and starts from fixed built-ins, preserving export, history and later changes', async () => {
    const { store, options, sourceDir } = await fixture()
    const bundle = await bakeHeading(store)
    const beforeState = JSON.parse(await readFile(join(store.path, 'state.json'), 'utf8'))
    const oldGeneration = join(store.path, 'revisions', String(beforeState.current))
    const oldMetadata = await readFile(join(oldGeneration, 'metadata.json'), 'utf8')
    await store.close()
    const upgradedEntry = await updateBuiltIn(sourceDir)
    const updatedOptions = { ...options, incorporatedExtensions: [identity(bundle)] }
    const updated = new SourceCodeStore(updatedOptions)
    stores.push(updated)
    const compiler = vi.spyOn(updated as any, 'compile')
    const installer = vi.spyOn(updated as any, 'installDependencies')
    const migrated = await updated.init()
    expect(compiler).not.toHaveBeenCalled()
    expect(installer).not.toHaveBeenCalled()
    expect(migrated).toMatchObject({
      enabled: false,
      extensions: [{ id: bundle.id, enabled: false, incorporated: true }],
    })
    expect(migrated.active).toBeUndefined()
    expect(migrated.error).toBeUndefined()
    expect(migrated.baseChanged).toBeUndefined()
    expect(await updated.exportExtension(bundle.id)).toEqual(bundle)
    expect(await readFile(join(oldGeneration, 'metadata.json'), 'utf8')).toBe(oldMetadata)
    expect(await readFile(join(oldGeneration, helperPath), 'utf8')).toContain(
      'Old extension helper',
    )
    const migrationState = JSON.parse(await readFile(join(store.path, 'state.json'), 'utf8'))
    expect(migrationState.history).toContain(beforeState.current)
    const recovery = JSON.parse(
      await readFile(
        join(
          store.path,
          'revisions',
          String(migrationState.current),
          'incorporation-recovery.json',
        ),
        'utf8',
      ),
    )
    expect(recovery.originalState).toEqual(beforeState)
    expect(recovery.originalGeneration).toBe(beforeState.current)
    expect((await updated.getContext({ paths: [entryPath] })).files[0].content).toBe(upgradedEntry)
    expect((await updated.getContext({ paths: [helperPath] })).files[0].content).toContain(
      'Fixed built-in helper',
    )
    await expect(updated.setExtensionEnabled(bundle.id, true)).rejects.toThrow('built into Life')
    await expect(updated.updateExtension(bundle)).rejects.toThrow('built into Life')

    await updated.close()
    const idempotent = await restart(updatedOptions)
    expect(idempotent.get().revision).toBe(migrated.revision)
    expect(idempotent.get().error).toBeUndefined()
    const changed = await idempotent.apply({
      summary: 'Condensed workspace',
      baseRevision: idempotent.get().revision,
      files: [{ path: entryPath, edits: [{ find: "'compact'", replace: "'condensed'" }] }],
    })
    expect(changed.extensions).toHaveLength(2)
    expect(changed.extensions[0].incorporated).toBe(true)
    expect(await execute(idempotent)).toMatchObject({ heading: 'Research', density: 'condensed' })
    expect((await idempotent.getContext({ paths: [helperPath] })).files[0].content).toContain(
      'Fixed built-in helper',
    )
    await idempotent.close()
    const persisted = await restart(updatedOptions)
    expect(persisted.get().enabled).toBe(true)
    expect(persisted.get().error).toBeUndefined()
    expect(await execute(persisted)).toMatchObject({ heading: 'Research', density: 'condensed' })
    await persisted.removeExtension(bundle.id)
    expect(persisted.get().extensions).toHaveLength(1)
    expect(await execute(persisted)).toMatchObject({ heading: 'Research', density: 'condensed' })
    expect(await readFile(join(oldGeneration, 'metadata.json'), 'utf8')).toBe(oldMetadata)
  })

  it('preserves modified bundles with the same ID rather than trusting an ID or forged archive flag', async () => {
    const { store, options, sourceDir } = await fixture()
    const bundle = await bakeHeading(store)
    const renamed = { ...bundle, name: 'My edited source extension' }
    await store.updateExtension(renamed)
    const modified = await store.exportExtension(bundle.id)
    const saved = JSON.parse(await readFile(join(store.path, 'state.json'), 'utf8'))
    const metadataPath = join(store.path, 'revisions', String(saved.current), 'metadata.json')
    const metadata = JSON.parse(await readFile(metadataPath, 'utf8'))
    metadata.extensions[0].incorporated = true
    await writeFile(metadataPath, JSON.stringify(metadata))
    await store.close()
    await updateBuiltIn(sourceDir)
    const updated = await restart({ ...options, incorporatedExtensions: [identity(bundle)] })
    expect(updated.get().enabled).toBe(false)
    expect(updated.get().baseChanged).toBe(true)
    expect(updated.get().error).toContain('preserved')
    expect(updated.get().extensions[0].incorporated).toBeUndefined()
    expect(await updated.exportExtension(bundle.id)).toEqual(modified)
  })

  it('keeps unknown extensions disabled and readable, then explicitly adapts them without duplicating baked creates', async () => {
    const { store, options, sourceDir } = await fixture()
    const bundle = await bakeHeading(store)
    const extra = await store.apply({
      summary: 'Additional lab terminology',
      baseRevision: store.get().revision,
      files: [{ path: 'src/shared/greeting.ts', edits: [{ find: 'workspace', replace: 'lab' }] }],
    })
    const unknownId = extra.extensions[1].id
    const unknownBundle = await store.exportExtension(unknownId)
    await store.close()
    await updateBuiltIn(sourceDir)
    const updated = await restart({ ...options, incorporatedExtensions: [identity(bundle)] })
    expect(updated.get()).toMatchObject({ enabled: false, baseChanged: true })
    expect(updated.get().error).toContain('additional source extensions')
    expect(updated.get().active).toBeUndefined()
    expect(updated.get().extensions.map(({ id }) => id)).toEqual([bundle.id, unknownId])
    expect(await updated.exportExtension(unknownId)).toEqual(unknownBundle)
    expect(
      (await updated.getContext({ paths: ['src/shared/greeting.ts'] })).files[0].content,
    ).toContain('Research lab')
    const savedBeforeRestart = await readFile(join(updated.path, 'state.json'), 'utf8')
    await updated.close()
    const stable = await restart({ ...options, incorporatedExtensions: [identity(bundle)] })
    expect(await readFile(join(updated.path, 'state.json'), 'utf8')).toBe(savedBeforeRestart)
    expect(stable.get().error).toContain('additional source extensions')
    await stable.apply({
      summary: 'Adapt additional terminology',
      baseRevision: stable.get().revision,
      files: [
        {
          path: 'src/shared/greeting.ts',
          content: "export const greeting = 'Research laboratory'\n",
        },
      ],
    })
    expect(stable.get().baseChanged).toBeUndefined()
    expect(await execute(stable)).toMatchObject({
      heading: 'Research',
      density: 'compact',
      greeting: 'Research laboratory',
    })
    expect(await stable.exportExtension(bundle.id)).toEqual(bundle)
  })

  it('does not silently activate a conflicting unknown layer and leaves all originals intact on a failed adaptation', async () => {
    const { store, options, sourceDir } = await fixture()
    const bundle = await bakeHeading(store)
    const extra = await store.apply({
      summary: 'Private workspace density',
      baseRevision: store.get().revision,
      files: [{ path: entryPath, edits: [{ find: "'comfortable'", replace: "'spacious'" }] }],
    })
    const unknownBundle = await store.exportExtension(extra.extensions[1].id)
    await store.close()
    await updateBuiltIn(sourceDir)
    const updated = await restart({ ...options, incorporatedExtensions: [identity(bundle)] })
    const before = updated.get()
    await expect(
      updated.apply({
        summary: 'Unrelated helper',
        baseRevision: before.revision,
        files: [{ path: 'src/shared/new.ts', content: 'export const value = true\n' }],
      }),
    ).rejects.toThrow('conflicts')
    expect(updated.get().revision).toBe(before.revision)
    expect(updated.get().active).toBeUndefined()
    expect(await updated.exportExtension(unknownBundle.id)).toEqual(unknownBundle)
    expect(await updated.exportExtension(bundle.id)).toEqual(bundle)
  })

  it('retains rollback generations and never executes an older baked renderer on rollback or after a recovery marker', async () => {
    const { store, options, sourceDir } = await fixture()
    const bundle = await bakeHeading(store)
    // Simulate an unclean old custom renderer exit. Upgrading must still use built-ins.
    await writeFile(join(store.path, '.running'), '999999')
    await updateBuiltIn(sourceDir)
    const updated = await restart({ ...options, incorporatedExtensions: [identity(bundle)] })
    expect(updated.get().enabled).toBe(false)
    expect(updated.get().error).toBeUndefined()
    const rolledBack = await updated.rollback()
    expect(rolledBack.enabled).toBe(false)
    expect(rolledBack.active).toBeUndefined()
    expect(rolledBack.error).toBeUndefined()
    expect(rolledBack.extensions[0].incorporated).toBe(true)
    expect(await updated.exportExtension(bundle.id)).toEqual(bundle)
    expect((await updated.getContext({ paths: [entryPath] })).files[0].content).toContain(
      "'compact'",
    )
    expect(await readFile(join(store.path, 'revisions', '1', helperPath), 'utf8')).toContain(
      'Old extension helper',
    )
  })

  it('keeps the previous generation and saved history if migration state persistence fails', async () => {
    const { store, options, sourceDir } = await fixture()
    const bundle = await bakeHeading(store)
    const previous = JSON.parse(await readFile(join(store.path, 'state.json'), 'utf8'))
    const oldMetadata = await readFile(
      join(store.path, 'revisions', String(previous.current), 'metadata.json'),
      'utf8',
    )
    await store.close()
    await updateBuiltIn(sourceDir)
    const updated = new SourceCodeStore({ ...options, incorporatedExtensions: [identity(bundle)] })
    stores.push(updated)
    vi.spyOn(updated as any, 'writeState').mockRejectedValueOnce(
      new Error('Simulated disk failure'),
    )
    await updated.init()
    const saved = JSON.parse(await readFile(join(store.path, 'state.json'), 'utf8'))
    expect(saved.current).toBe(previous.current)
    expect(saved.history).toEqual(previous.history)
    expect(saved.enabled).toBe(false)
    expect(await updated.exportExtension(bundle.id)).toEqual(bundle)
    expect(
      await readFile(
        join(store.path, 'revisions', String(previous.current), 'metadata.json'),
        'utf8',
      ),
    ).toBe(oldMetadata)
    await expect(
      readFile(join(store.path, 'revisions', String(previous.revision + 1), 'metadata.json')),
    ).rejects.toMatchObject({ code: 'ENOENT' })
  })

  it('does not expose an executable archive after corrupted enabled state or a rollback with enabled unknown metadata', async () => {
    const { store, options, sourceDir } = await fixture()
    const bundle = await bakeHeading(store)
    await store.close()
    await updateBuiltIn(sourceDir)
    const updatedOptions = { ...options, incorporatedExtensions: [identity(bundle)] }
    const archived = await restart(updatedOptions)
    await archived.close()
    const statePath = join(archived.path, 'state.json')
    const state = JSON.parse(await readFile(statePath, 'utf8'))
    const metadataPath = join(archived.path, 'revisions', String(state.current), 'metadata.json')
    const metadata = JSON.parse(await readFile(metadataPath, 'utf8'))
    metadata.extensions.push({
      bundle: { ...bundle, id: 'source-ffffffffffff', name: 'Preserved unknown layer' },
      enabled: true,
    })
    await writeFile(metadataPath, JSON.stringify(metadata))
    await writeFile(
      statePath,
      JSON.stringify({ ...state, enabled: true, history: [state.current] }),
    )
    const restored = await restart(updatedOptions)
    expect(restored.get().enabled).toBe(false)
    expect(restored.get().active).toBeUndefined()
    const rolledBack = await restored.rollback()
    expect(rolledBack.enabled).toBe(false)
    expect(rolledBack.active).toBeUndefined()
    expect(rolledBack.extensions.map(({ id }) => id)).toContain('source-ffffffffffff')
    expect(await restored.exportExtension(bundle.id)).toEqual(bundle)
  })
})
