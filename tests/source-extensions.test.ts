import { afterEach, describe, expect, it } from 'vitest'
import { createHash } from 'node:crypto'
import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { runInNewContext } from 'node:vm'
import { createTwoFilesPatch } from 'diff'
import { SourceCodeStore } from '../src/main/source-code'
import { parseSourceExtensionBundle } from '../src/shared/source-extensions'

const directories: string[] = []
const stores: SourceCodeStore[] = []
const originalEntry = `import './styles.css'
import { greeting } from '../shared/greeting'
const heading = 'Workspace'
const researchScope = 'project'
const resultOrder = 'newest'
const showEvidence = true
const showHypotheses = true
const retainDrafts = true
const allowAnnotations = true
const mapLayout = 'graph'
const studyMode = 'focused'
const navigationStyle = 'sidebar'
const density = 'comfortable'
;(globalThis as any).__life_extension_test = { heading, density, greeting }
`
const baselineFiles = {
  'src/renderer/main.tsx': originalEntry,
  'src/renderer/styles.css': '.workspace { color: #151515; }\n',
  'src/shared/greeting.ts': "export const greeting = 'Original research workspace'\n",
  'src/shared/orphan.ts': "export const orphan = 'Preserve this base file'\n",
  'src/main/native.ts': "export const nativeIdentity = 'Life'\n",
}

async function createStore(extraFiles: Record<string, string | Buffer> = {}) {
  const directory = await mkdtemp(join(tmpdir(), 'life-source-extensions-'))
  directories.push(directory)
  const sourceDir = join(directory, 'installed-source')
  for (const [path, content] of Object.entries({ ...baselineFiles, ...extraFiles })) {
    await mkdir(dirname(join(sourceDir, path)), { recursive: true })
    await writeFile(join(sourceDir, path), content)
  }
  await writeFile(
    join(sourceDir, 'package.json'),
    JSON.stringify({ name: 'life-extension-test', version: '1.0.0', dependencies: {} }),
  )
  const options = {
    sourceDir,
    nodeModulesDir: resolve('node_modules'),
    directory: join(directory, 'customizations'),
    compilerTimeoutMs: 10_000,
    installTimeoutMs: 10_000,
  }
  const store = new SourceCodeStore(options)
  stores.push(store)
  await store.init()
  return { store, options, sourceDir }
}

async function edit(store: SourceCodeStore, summary: string, find: string, replace: string) {
  const context = await store.getContext({ paths: ['src/renderer/main.tsx'] })
  return store.apply({
    summary,
    baseRevision: context.revision,
    files: [{ path: 'src/renderer/main.tsx', edits: [{ find, replace }] }],
  })
}

async function execute(store: SourceCodeStore) {
  const asset = store.assetPath(store.get().active!.js)
  expect(asset).toBeTruthy()
  const scope: Record<string, unknown> = {}
  runInNewContext(await readFile(asset!, 'utf8'), { globalThis: scope })
  return scope.__life_extension_test
}

// These dependency fixtures exercise the existing real compiler and package-cache resolution
// without making this composition test depend on registry connectivity.
async function cacheDependencies(store: SourceCodeStore, dependencies: Record<string, string>) {
  const sorted = Object.fromEntries(
    Object.entries(dependencies).sort(([left], [right]) => left.localeCompare(right)),
  )
  const key = createHash('sha256').update(JSON.stringify(sorted)).digest('hex').slice(0, 24)
  const directory = join(store.path, 'packages', key)
  await mkdir(directory, { recursive: true })
  await symlink(
    resolve('node_modules'),
    join(directory, 'node_modules'),
    process.platform === 'win32' ? 'junction' : 'dir',
  )
  await writeFile(join(directory, '.complete'), 'installed')
}

afterEach(async () => {
  await Promise.all(stores.splice(0).map((store) => store.close()))
  await Promise.all(
    directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })),
  )
})

describe('composable Life source extensions', () => {
  it('records each code proposal as its own extension and preserves a later independent edit in the same file', async () => {
    const { store, sourceDir } = await createStore()
    const first = await edit(store, 'Research workspace heading', "'Workspace'", "'Research'")
    const second = await edit(store, 'Compact workspace layout', "'comfortable'", "'compact'")
    expect(first.extensions).toHaveLength(1)
    expect(second.extensions).toHaveLength(2)
    expect(second.extensions[0]).toMatchObject({
      enabled: true,
      files: ['src/renderer/main.tsx'],
    })
    expect(second.extensions[0].id).not.toBe(second.extensions[1].id)
    expect(await execute(store)).toMatchObject({ heading: 'Research', density: 'compact' })

    const disabled = await store.setExtensionEnabled(second.extensions[0].id, false)
    expect(disabled.extensions.map((extension) => extension.enabled)).toEqual([false, true])
    expect(await execute(store)).toMatchObject({ heading: 'Workspace', density: 'compact' })
    expect(await readFile(join(sourceDir, 'src/renderer/main.tsx'), 'utf8')).toBe(originalEntry)

    await store.setExtensionEnabled(second.extensions[0].id, true)
    expect(await execute(store)).toMatchObject({ heading: 'Research', density: 'compact' })
  })

  it('preserves independent edits within the same source line when an earlier extension is disabled', async () => {
    const { store } = await createStore()
    const first = await store.apply({
      summary: 'Advanced research label',
      baseRevision: store.get().revision,
      files: [
        { path: 'src/shared/greeting.ts', edits: [{ find: 'Original', replace: 'Advanced' }] },
      ],
    })
    const second = await store.apply({
      summary: 'Lab terminology',
      baseRevision: first.revision,
      files: [{ path: 'src/shared/greeting.ts', edits: [{ find: 'workspace', replace: 'lab' }] }],
    })
    expect(await execute(store)).toMatchObject({ greeting: 'Advanced research lab' })
    await store.setExtensionEnabled(second.extensions[0].id, false)
    expect(await execute(store)).toMatchObject({ greeting: 'Original research lab' })
    await store.setExtensionEnabled(second.extensions[0].id, true)
    expect(await execute(store)).toMatchObject({ greeting: 'Advanced research lab' })
  })

  it('persists extension enablement and removes a layer without discarding later independent changes', async () => {
    const { store, options } = await createStore()
    await edit(store, 'Research heading', "'Workspace'", "'Research'")
    const snapshot = await edit(store, 'Compact density', "'comfortable'", "'compact'")
    const [first, second] = snapshot.extensions
    await store.setExtensionEnabled(first.id, false)
    await store.close()

    const restarted = new SourceCodeStore(options)
    stores.push(restarted)
    const restored = await restarted.init()
    expect(restored.extensions.map(({ id, enabled }) => ({ id, enabled }))).toEqual([
      { id: first.id, enabled: false },
      { id: second.id, enabled: true },
    ])
    expect(await execute(restarted)).toMatchObject({ heading: 'Workspace', density: 'compact' })
    const removed = await restarted.removeExtension(first.id)
    expect(removed.extensions.map((extension) => extension.id)).toEqual([second.id])
    expect(await execute(restarted)).toMatchObject({ heading: 'Workspace', density: 'compact' })
  })

  it('exports a portable patch bundle and imports it into a separate clean installation', async () => {
    const { store } = await createStore()
    const snapshot = await edit(store, 'Public research heading', "'Workspace'", "'Research'")
    const bundle = await store.exportExtension(snapshot.extensions[0].id)
    expect(bundle).toMatchObject({
      format: 'life-source-extension',
      formatVersion: 1,
      id: snapshot.extensions[0].id,
      files: [{ path: 'src/renderer/main.tsx', kind: 'patch' }],
    })
    expect(bundle.files[0]).toHaveProperty('patch', expect.stringContaining('Research'))
    expect(JSON.stringify(bundle)).not.toContain(store.path)
    expect(JSON.stringify(bundle)).not.toContain('dist/entry.js')

    const { store: recipient, sourceDir } = await createStore()
    const imported = await recipient.importExtension(JSON.parse(JSON.stringify(bundle)))
    expect(imported.extensions).toHaveLength(1)
    expect(imported.extensions[0].name).toBe(bundle.name)
    expect(await execute(recipient)).toMatchObject({ heading: 'Research' })
    expect(await readFile(join(sourceDir, 'src/renderer/main.tsx'), 'utf8')).toBe(originalEntry)
  })

  it('shares a later independent extension without exporting the earlier customization as a dependency', async () => {
    const { store } = await createStore()
    await edit(store, 'Private research heading', "'Workspace'", "'Private research'")
    const snapshot = await edit(store, 'Shareable compact density', "'comfortable'", "'compact'")
    const bundle = await store.exportExtension(snapshot.extensions[1].id)
    const { store: recipient } = await createStore()
    await recipient.importExtension(bundle)
    expect(await execute(recipient)).toMatchObject({ heading: 'Workspace', density: 'compact' })
    expect(recipient.get().extensions).toHaveLength(1)
  })

  it('updates a source extension in place while preserving later edits, its creation date, and enablement', async () => {
    const { store } = await createStore()
    const first = await edit(store, 'Research heading', "'Workspace'", "'Research'")
    const second = await edit(store, 'Compact density', "'comfortable'", "'compact'")
    const bundle = await store.exportExtension(first.extensions[0].id)
    const file = bundle.files[0]
    if (file.kind !== 'patch') throw new Error('Expected an editable patch fixture')
    const content = file.content.replace("'Research'", "'Shared research'")
    const updatedBundle = {
      ...bundle,
      createdAt: '2000-01-01T00:00:00.000Z',
      version: '1.1.0',
      files: [
        {
          ...file,
          content,
          patch: createTwoFilesPatch(
            file.path,
            file.path,
            file.preimage,
            content,
            undefined,
            undefined,
            { context: 3 },
          ),
        },
      ],
    }
    const updated = await store.updateExtension(updatedBundle)
    expect(updated.extensions.map((extension) => extension.id)).toEqual(
      second.extensions.map((extension) => extension.id),
    )
    expect(updated.extensions[0]).toMatchObject({
      createdAt: bundle.createdAt,
      enabled: true,
      version: '1.1.0',
    })
    expect(await execute(store)).toMatchObject({ heading: 'Shared research', density: 'compact' })

    await store.setExtensionEnabled(bundle.id, false)
    const disabledUpdate = await store.updateExtension(updatedBundle)
    expect(disabledUpdate.extensions[0]).toMatchObject({
      createdAt: bundle.createdAt,
      enabled: false,
    })
    expect(await execute(store)).toMatchObject({ heading: 'Workspace', density: 'compact' })
  })

  it('normalizes edited JSON updates, keeps imports strict, and preserves the working version after compiler errors', async () => {
    const { store } = await createStore()
    const first = await edit(store, 'Research heading', "'Workspace'", "'Research'")
    const second = await edit(store, 'Compact density', "'comfortable'", "'compact'")
    const bundle = await store.exportExtension(first.extensions[0].id)
    const file = bundle.files[0]
    if (file.kind !== 'patch') throw new Error('Expected an editable patch fixture')
    const editedContent = file.content + '\n// changed through the source manager\n'
    const editedBundle = { ...bundle, files: [{ ...file, content: editedContent }] }
    const { store: recipient } = await createStore()
    await expect(recipient.importExtension(editedBundle)).rejects.toThrow('declared content')
    expect(recipient.get().extensions).toHaveLength(0)

    const normalized = await store.updateExtension(editedBundle)
    expect(normalized.revision).toBeGreaterThan(second.revision)
    expect(normalized.extensions.map((extension) => extension.id)).toEqual(
      second.extensions.map((extension) => extension.id),
    )
    const workingBundle = await store.exportExtension(bundle.id)
    const workingFile = workingBundle.files[0]
    if (workingFile.kind !== 'patch') throw new Error('Expected an editable patch fixture')
    expect(workingFile.content).toBe(editedContent)
    expect(workingFile.baseHash).toBe(
      createHash('sha256').update(workingFile.preimage).digest('hex'),
    )
    expect(workingFile.patch).toContain('changed through the source manager')
    expect(await execute(store)).toMatchObject({ heading: 'Research', density: 'compact' })
    const before = await store.getContext({ paths: ['src/renderer/main.tsx'] })
    const content = workingFile.content + '\nexport const = invalid syntax\n'
    await expect(
      store.updateExtension({
        ...workingBundle,
        files: [
          {
            ...workingFile,
            content,
            patch: createTwoFilesPatch(
              workingFile.path,
              workingFile.path,
              workingFile.preimage,
              content,
              undefined,
              undefined,
              { context: 3 },
            ),
          },
        ],
      }),
    ).rejects.toThrow('Life source build failed')
    expect(store.get().revision).toBe(normalized.revision)
    expect(store.get().active?.js).toBe(normalized.active!.js)
    expect(await store.exportExtension(bundle.id)).toEqual(workingBundle)
    expect((await store.getContext({ paths: ['src/renderer/main.tsx'] })).files).toEqual(
      before.files,
    )
    expect(await execute(store)).toMatchObject({ heading: 'Research', density: 'compact' })
  })

  it('rejects a conflicting layer toggle atomically and leaves the last compiled interface usable', async () => {
    const { store } = await createStore()
    await edit(store, 'Research heading', "'Workspace'", "'Research'")
    const snapshot = await edit(store, 'Detailed research heading', "'Research'", "'Deep research'")
    const previousAsset = snapshot.active!.js
    const previousRevision = snapshot.revision

    await expect(store.setExtensionEnabled(snapshot.extensions[0].id, false)).rejects.toThrow()
    const after = store.get()
    expect(after.revision).toBe(previousRevision)
    expect(after.active?.js).toBe(previousAsset)
    expect(after.extensions.map((extension) => extension.enabled)).toEqual([true, true])
    expect(await execute(store)).toMatchObject({ heading: 'Deep research' })
    expect(
      (await store.getContext({ paths: ['src/renderer/main.tsx'] })).files[0].content,
    ).toContain("'Deep research'")
  })

  it('keeps a failed code proposal out of the installed extensions list', async () => {
    const { store } = await createStore()
    const good = await edit(store, 'Working research heading', "'Workspace'", "'Research'")
    await expect(
      store.apply({
        summary: 'Broken component',
        baseRevision: good.revision,
        files: [{ path: 'src/renderer/main.tsx', content: 'export const = invalid syntax' }],
      }),
    ).rejects.toThrow()
    expect(store.get().extensions.map((extension) => extension.id)).toEqual(
      good.extensions.map((extension) => extension.id),
    )
    expect(store.get().active?.js).toBe(good.active!.js)
    expect(await execute(store)).toMatchObject({ heading: 'Research' })
  })

  it('repairs the failed latest extension in place while retaining earlier working extensions', async () => {
    const { store } = await createStore()
    await edit(store, 'Research heading', "'Workspace'", "'Research'")
    const broken = await edit(store, 'Compact density', "'comfortable'", "'compact'")
    const ids = broken.extensions.map((extension) => extension.id)
    await store.disable('Customized renderer failed during startup')
    const repaired = await edit(store, 'Repair density behavior', "'compact'", "'balanced'")
    expect(repaired.extensions.map((extension) => extension.id)).toEqual(ids)
    expect(repaired.extensions.every((extension) => extension.enabled)).toBe(true)
    expect(await execute(store)).toMatchObject({ heading: 'Research', density: 'balanced' })
    await store.setExtensionEnabled(ids[1], false)
    expect(await execute(store)).toMatchObject({ heading: 'Research', density: 'comfortable' })
  })

  it('reverses created and deleted files when their extension is disabled and preserves installed source', async () => {
    const { store, sourceDir } = await createStore()
    const snapshot = await store.apply({
      summary: 'Research notes module and archive cleanup',
      baseRevision: store.get().revision,
      files: [
        { path: 'src/shared/notes.ts', content: "export const notes = 'Research notes'\n" },
        { path: 'src/shared/orphan.ts', content: null },
      ],
    })
    const extension = snapshot.extensions[0]
    expect(extension.files.sort()).toEqual(['src/shared/notes.ts', 'src/shared/orphan.ts'])
    const enabled = await store.getContext()
    expect(enabled.paths).toContain('src/shared/notes.ts')
    expect(enabled.paths).not.toContain('src/shared/orphan.ts')
    const bundle = await store.exportExtension(extension.id)
    expect(bundle.files).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ path: 'src/shared/notes.ts', kind: 'create' }),
        expect.objectContaining({ path: 'src/shared/orphan.ts', kind: 'delete' }),
      ]),
    )

    await store.setExtensionEnabled(extension.id, false)
    const disabled = await store.getContext()
    expect(disabled.paths).not.toContain('src/shared/notes.ts')
    expect(disabled.paths).toContain('src/shared/orphan.ts')
    expect(await readFile(join(sourceDir, 'src/shared/orphan.ts'), 'utf8')).toBe(
      baselineFiles['src/shared/orphan.ts'],
    )
    await store.setExtensionEnabled(extension.id, true)
    expect((await store.getContext()).paths).toContain('src/shared/notes.ts')
  })

  it('composes dependencies from enabled extensions and excludes disabled extension dependencies', async () => {
    const { store } = await createStore()
    const reactVersion = JSON.parse(
      await readFile(resolve('node_modules/react/package.json'), 'utf8'),
    ).version as string
    const zodVersion = JSON.parse(await readFile(resolve('node_modules/zod/package.json'), 'utf8'))
      .version as string
    const react = { react: reactVersion }
    const zod = { zod: zodVersion }
    for (const dependencies of [react, zod, { ...react, ...zod }]) {
      await cacheDependencies(store, dependencies)
    }
    const first = await store.apply({
      summary: 'React component support',
      baseRevision: store.get().revision,
      files: [],
      dependencies: react,
    })
    const second = await store.apply({
      summary: 'Runtime validation support',
      baseRevision: first.revision,
      files: [],
      dependencies: zod,
    })
    expect((await store.getContext()).dependencies).toEqual({ ...react, ...zod })
    expect((await store.exportExtension(second.extensions[0].id)).dependencies).toEqual(react)
    expect((await store.exportExtension(second.extensions[1].id)).dependencies).toEqual(zod)

    await store.setExtensionEnabled(second.extensions[0].id, false)
    expect((await store.getContext()).dependencies).toEqual(zod)
    expect(await execute(store)).toMatchObject({ heading: 'Workspace' })
  })

  it('recomputes the active dependency version when an overriding extension is disabled', async () => {
    const { store } = await createStore()
    const version = JSON.parse(await readFile(resolve('node_modules/react/package.json'), 'utf8'))
      .version as string
    const pinned = { react: version }
    const compatible = { react: `~${version}` }
    await cacheDependencies(store, pinned)
    await cacheDependencies(store, compatible)
    const first = await store.apply({
      summary: 'Pinned React version',
      baseRevision: store.get().revision,
      files: [],
      dependencies: pinned,
    })
    const second = await store.apply({
      summary: 'Compatible React updates',
      baseRevision: first.revision,
      files: [],
      dependencies: compatible,
    })
    expect((await store.getContext()).dependencies).toEqual(compatible)
    await store.setExtensionEnabled(second.extensions[1].id, false)
    expect((await store.getContext()).dependencies).toEqual(pinned)
    await store.setExtensionEnabled(second.extensions[1].id, true)
    await store.setExtensionEnabled(second.extensions[0].id, false)
    expect((await store.getContext()).dependencies).toEqual(compatible)
  })

  it('migrates a Life 0.4 saved customization into a portable extension without losing its compiled UI', async () => {
    const { store, options, sourceDir } = await createStore()
    const snapshot = await edit(store, 'Saved research heading', "'Workspace'", "'Legacy research'")
    const metadataPath = join(
      store.path,
      'revisions',
      String(snapshot.active!.revision),
      'metadata.json',
    )
    await store.close()
    const metadata = JSON.parse(await readFile(metadataPath, 'utf8'))
    delete metadata.extensions
    await writeFile(metadataPath, JSON.stringify(metadata))

    const restarted = new SourceCodeStore(options)
    stores.push(restarted)
    const migrated = await restarted.init()
    expect(migrated.extensions).toHaveLength(1)
    expect(migrated.extensions[0].enabled).toBe(true)
    expect(migrated.extensions[0].files).toEqual(['src/renderer/main.tsx'])
    expect(await execute(restarted)).toMatchObject({ heading: 'Legacy research' })
    const bundle = await restarted.exportExtension(migrated.extensions[0].id)
    expect(bundle.format).toBe('life-source-extension')
    expect(bundle.files[0]).toHaveProperty('patch', expect.stringContaining('Legacy research'))

    await restarted.setExtensionEnabled(migrated.extensions[0].id, false)
    expect(
      (await restarted.getContext({ paths: ['src/renderer/main.tsx'] })).files[0].content,
    ).toBe(originalEntry)
    expect(await readFile(join(sourceDir, 'src/renderer/main.tsx'), 'utf8')).toBe(originalEntry)
  })

  it('migrates legacy current and history generations with a stable restored ID across rollback and restart', async () => {
    const { store, options } = await createStore()
    const first = await edit(store, 'Saved legacy heading', "'Workspace'", "'Legacy research'")
    const second = await edit(store, 'Saved legacy density', "'comfortable'", "'compact'")
    await store.close()
    for (const revision of [first.active!.revision, second.active!.revision]) {
      const metadataPath = join(store.path, 'revisions', String(revision), 'metadata.json')
      const metadata = JSON.parse(await readFile(metadataPath, 'utf8'))
      delete metadata.extensions
      await writeFile(metadataPath, JSON.stringify(metadata))
    }

    const restarted = new SourceCodeStore(options)
    stores.push(restarted)
    const current = await restarted.init()
    expect(current.extensions).toHaveLength(1)
    expect(await execute(restarted)).toMatchObject({
      heading: 'Legacy research',
      density: 'compact',
    })
    const restored = await restarted.rollback()
    expect(restored.extensions).toHaveLength(1)
    const legacyId = restored.extensions[0].id
    expect(await execute(restarted)).toMatchObject({
      heading: 'Legacy research',
      density: 'comfortable',
    })
    await restarted.close()

    const afterRestart = new SourceCodeStore(options)
    stores.push(afterRestart)
    const persisted = await afterRestart.init()
    expect(persisted.enabled).toBe(true)
    expect(persisted.extensions[0].id).toBe(legacyId)
    const extended = await afterRestart.apply({
      summary: 'Add a helper alongside saved legacy data',
      baseRevision: persisted.revision,
      files: [{ path: 'src/shared/new-helper.ts', content: 'export const helper = true\n' }],
    })
    expect(extended.extensions[0].id).toBe(legacyId)
    expect(await execute(afterRestart)).toMatchObject({
      heading: 'Legacy research',
      density: 'comfortable',
    })
  })

  it('requires an explicit adaptation for a file changed by both an extension and an app upgrade', async () => {
    const { store, options, sourceDir } = await createStore()
    await edit(store, 'Custom workspace greeting', "'Workspace'", "'Custom workspace'")
    await store.close()
    const upgradedEntry = originalEntry
      .replace("'Workspace'", "'New workspace'")
      .replace("'comfortable'", "'compact'")
    await writeFile(join(sourceDir, 'src/renderer/main.tsx'), upgradedEntry)

    const restarted = new SourceCodeStore(options)
    stores.push(restarted)
    const upgraded = await restarted.init()
    expect(upgraded.enabled).toBe(false)
    expect(upgraded.baseChanged).toBe(true)
    const before = await restarted.getContext({ paths: ['src/renderer/main.tsx'] })
    expect(before.baselineFiles).toEqual([
      { path: 'src/renderer/main.tsx', content: upgradedEntry },
    ])
    await expect(
      restarted.apply({
        summary: 'Unrelated new helper after update',
        baseRevision: before.revision,
        files: [{ path: 'src/shared/new-helper.ts', content: 'export const helper = true\n' }],
      }),
    ).rejects.toThrow()
    expect(restarted.get().revision).toBe(upgraded.revision)
    expect(restarted.get().enabled).toBe(false)
    expect(restarted.get().extensions).toEqual(upgraded.extensions)
    expect((await restarted.getContext()).paths).not.toContain('src/shared/new-helper.ts')
    expect(await readFile(join(sourceDir, 'src/renderer/main.tsx'), 'utf8')).toBe(upgradedEntry)

    const adaptedEntry = upgradedEntry.replace("'New workspace'", "'Custom workspace'")
    const adapted = await restarted.apply({
      summary: 'Adapt custom greeting to the updated compact workspace',
      baseRevision: restarted.get().revision,
      files: [{ path: 'src/renderer/main.tsx', content: adaptedEntry }],
    })
    expect(adapted.enabled).toBe(true)
    expect(adapted.baseChanged).not.toBe(true)
    expect(await execute(restarted)).toMatchObject({
      heading: 'Custom workspace',
      density: 'compact',
    })
    expect(
      (await restarted.getContext({ paths: ['src/renderer/main.tsx'] })).files[0].content,
    ).toBe(adaptedEntry)
    const adaptedIds = adapted.extensions.map((extension) => extension.id)
    await restarted.close()
    const afterRestart = new SourceCodeStore(options)
    stores.push(afterRestart)
    const persisted = await afterRestart.init()
    expect(persisted.enabled).toBe(true)
    expect(persisted.baseChanged).not.toBe(true)
    expect(persisted.extensions.map((extension) => extension.id)).toEqual(adaptedIds)
    expect(
      (await afterRestart.getContext({ paths: ['src/renderer/main.tsx'] })).files[0].content,
    ).toBe(adaptedEntry)
    expect(await execute(afterRestart)).toMatchObject({
      heading: 'Custom workspace',
      density: 'compact',
    })
  })

  it('preserves binary source assets byte for byte in the generation and compiler output', async () => {
    const png = Buffer.from(
      'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+a6XcAAAAASUVORK5CYII=',
      'base64',
    )
    const { store, sourceDir } = await createStore({
      'src/renderer/research-badge.png': png,
      'src/renderer/main.tsx': `import researchBadge from './research-badge.png'\n${originalEntry}\n;(globalThis as any).__life_extension_test.badge = researchBadge\n`,
    })
    const snapshot = await store.apply({
      summary: 'Add a research helper without touching image assets',
      baseRevision: store.get().revision,
      files: [{ path: 'src/shared/new-helper.ts', content: 'export const helper = true\n' }],
    })
    const generation = join(store.path, 'revisions', String(snapshot.active!.revision))
    expect(await readFile(join(generation, 'src/renderer/research-badge.png'))).toEqual(png)
    expect(await readFile(join(sourceDir, 'src/renderer/research-badge.png'))).toEqual(png)
    const result = (await execute(store)) as { badge: string }
    const emitted = store.assetPath(new URL(result.badge, snapshot.active!.js).toString())
    expect(emitted).toBeTruthy()
    expect(await readFile(emitted!)).toEqual(png)
  })

  it('rolls back to a disabled extension composition without activating an all-off build', async () => {
    const { store } = await createStore()
    const first = await edit(store, 'Custom research heading', "'Workspace'", "'Research'")
    const allOff = await store.setExtensionEnabled(first.extensions[0].id, false)
    expect(allOff.enabled).toBe(false)
    expect(allOff.active).toBeUndefined()
    const next = await edit(store, 'Compact density', "'comfortable'", "'compact'")
    expect(next.enabled).toBe(true)
    expect(await execute(store)).toMatchObject({ heading: 'Workspace', density: 'compact' })

    const restored = await store.rollback()
    expect(restored.enabled).toBe(false)
    expect(restored.active).toBeUndefined()
    expect(restored.extensions.map(({ id, enabled }) => ({ id, enabled }))).toEqual([
      { id: first.extensions[0].id, enabled: false },
    ])
    expect((await store.getContext({ paths: ['src/renderer/main.tsx'] })).files[0].content).toBe(
      originalEntry,
    )
  })

  it('removes disabled CSS rules from the active compiled stylesheet while preserving an independent code layer', async () => {
    const { store } = await createStore()
    const rule = '.source-hypothesis-backlog { outline: 3px solid rgb(17, 34, 51); }\n'
    const outlined = await store.apply({
      summary: 'Outline the hypothesis backlog',
      baseRevision: store.get().revision,
      files: [
        {
          path: 'src/renderer/styles.css',
          content: baselineFiles['src/renderer/styles.css'] + rule,
        },
      ],
    })
    const outlineId = outlined.extensions[0].id
    const layered = await edit(store, 'Compact density', "'comfortable'", "'compact'")
    const enabledAsset = layered.active!.css!
    const readActiveCSS = async () => {
      const asset = store.assetPath(store.get().active!.css!)
      expect(asset).toBeTruthy()
      return readFile(asset!, 'utf8')
    }
    expect(await readActiveCSS()).toContain('.source-hypothesis-backlog')
    expect(await readActiveCSS()).toMatch(/outline:3px solid/)

    const disabled = await store.setExtensionEnabled(outlineId, false)
    expect(disabled.active!.css).not.toBe(enabledAsset)
    expect((await store.getContext({ paths: ['src/renderer/styles.css'] })).files[0].content).toBe(
      baselineFiles['src/renderer/styles.css'],
    )
    expect(await readActiveCSS()).not.toContain('.source-hypothesis-backlog')
    expect(await readActiveCSS()).not.toContain('outline:')
    expect(await execute(store)).toMatchObject({ density: 'compact' })

    const enabledAgain = await store.setExtensionEnabled(outlineId, true)
    expect(await readActiveCSS()).toContain('.source-hypothesis-backlog')
    const removed = await store.removeExtension(outlineId)
    expect(removed.active!.css).not.toBe(enabledAgain.active!.css)
    expect(removed.extensions.map((extension) => extension.id)).toEqual([layered.extensions[1].id])
    expect((await store.getContext({ paths: ['src/renderer/styles.css'] })).files[0].content).toBe(
      baselineFiles['src/renderer/styles.css'],
    )
    expect(await readActiveCSS()).not.toContain('.source-hypothesis-backlog')
    expect(await readActiveCSS()).not.toContain('outline:')
    expect(await execute(store)).toMatchObject({ density: 'compact' })
  })

  it('rejects excessive dependency declarations and counts UTF-8 bytes toward the portable bundle limit', () => {
    const base = {
      format: 'life-source-extension',
      formatVersion: 1,
      id: 'source-limit-test',
      name: 'Bundle limits',
      description: '',
      version: '1.0.0',
      createdAt: '2026-10-08T00:00:00.000Z',
      updatedAt: '2026-10-08T00:00:00.000Z',
      files: [
        { path: 'src/shared/helper.ts', kind: 'create', content: 'export const helper = true\n' },
      ],
      dependencies: {},
    }
    const dependencies = Object.fromEntries(
      Array.from({ length: 201 }, (_, index) => [`package-${index}`, '1.0.0']),
    )
    expect(() => parseSourceExtensionBundle({ ...base, dependencies })).toThrow('100 dependencies')
    const files = Array.from({ length: 9 }, (_, index) => ({
      path: `src/shared/helper-${index}.ts`,
      kind: 'create',
      content: 'é'.repeat(500_000),
    }))
    expect(() => parseSourceExtensionBundle({ ...base, files })).toThrow('8 MB')
  })

  it('rejects native-host edits and imported path traversal without mutating the installed extension state', async () => {
    const { store, sourceDir } = await createStore()
    const good = await edit(store, 'Research heading', "'Workspace'", "'Research'")
    await expect(
      store.apply({
        summary: 'Rewrite native host',
        baseRevision: good.revision,
        files: [{ path: 'src/main/native.ts', content: 'export const nativeIdentity = false' }],
      }),
    ).rejects.toThrow()
    const bundle = await store.exportExtension(good.extensions[0].id)
    const malformed = {
      ...bundle,
      id: 'malformed-bundle',
      files: [{ path: '../outside.ts', kind: 'create', content: 'export const outside = true' }],
    }
    await expect(store.importExtension(malformed)).rejects.toThrow()
    expect(store.get().extensions.map((extension) => extension.id)).toEqual([good.extensions[0].id])
    expect(await readFile(join(sourceDir, 'src/main/native.ts'), 'utf8')).toBe(
      baselineFiles['src/main/native.ts'],
    )
    expect(await execute(store)).toMatchObject({ heading: 'Research' })
  })
})
