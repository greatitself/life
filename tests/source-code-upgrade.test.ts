import { createHash } from 'node:crypto'
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { runInNewContext } from 'node:vm'
import { MessageChannel } from 'node:worker_threads'
import { createTwoFilesPatch } from 'diff'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { SourceCodeStore, type SourceCodeStoreOptions } from '../src/main/source-code'
import type { LifeSourcePatch } from '../src/shared/source-code'
import type { SourceExtensionBundle } from '../src/shared/source-extensions'

const directories: string[] = []
const stores: SourceCodeStore[] = []
const workspacePath = 'src/shared/workspace.ts'
const workspace = "export const label = 'Baseline'\nexport const accent = 'blue'\n"
const entry = `import React from 'react'
import './styles.css'
import { version } from '../../package.json'
import { label, accent } from '../shared/workspace'
;(globalThis as any).__life_upgrade_control = React.createElement('output', { id: 'upgrade-control' }, version + ':' + label + ':' + accent)
`
const oldUpgradeWarnings = [
  'Life was updated after this customization was built. Your source edits are preserved. Open Life Studio to update your customization for the current Life version; unchanged files are refreshed automatically when rebuilding.',
  'Life now includes the recognized UI improvements. Your additional source extensions are preserved with execution disabled. Open Life Studio to adapt those extensions to the current Life version.',
] as const

interface DiskState {
  format: 1
  revision: number
  current: number | null
  history: Array<number | null>
  enabled: boolean
  error?: string
  failed?: number[]
}

interface DiskMetadata {
  summary: string
  dependencies: Record<string, string>
  baseFingerprint: string
  baseHashes?: Record<string, string>
  extensions?: Array<{ bundle: SourceExtensionBundle; enabled: boolean }>
  legacyBaseUnavailable?: true
}

type CompilerHooks = {
  compile: (...arguments_: unknown[]) => Promise<void>
  writeState: (state: DiskState) => Promise<void>
}

async function put(root: string, path: string, content: string) {
  await mkdir(dirname(join(root, path)), { recursive: true })
  await writeFile(join(root, path), content)
}

function open(options: SourceCodeStoreOptions) {
  const store = new SourceCodeStore(options)
  stores.push(store)
  return store
}

async function fixture(extraFiles: Record<string, string> = {}) {
  const directory = await mkdtemp(join(tmpdir(), 'life-source-upgrade-'))
  directories.push(directory)
  const options: SourceCodeStoreOptions = {
    sourceDir: join(directory, 'installed'),
    nodeModulesDir: resolve('node_modules'),
    directory: join(directory, 'customizations'),
    compilerTimeoutMs: 10_000,
    installTimeoutMs: 10_000,
    incorporatedExtensions: [],
  }
  const files = {
    'src/renderer/main.tsx': entry,
    'src/renderer/styles.css': 'output { color: #123456; }\n',
    [workspacePath]: workspace,
    'package.json': JSON.stringify({
      name: 'life-upgrade-fixture',
      version: '1.0.0',
      private: true,
      dependencies: { react: '^19.1.0' },
    }),
    ...extraFiles,
  }
  await Promise.all(
    Object.entries(files).map(([path, content]) => put(options.sourceDir, path, content)),
  )
  const store = open(options)
  await store.init()
  return { store, options }
}

async function apply(
  store: SourceCodeStore,
  summary: string,
  files: LifeSourcePatch['files'],
  dependencies?: Record<string, string>,
) {
  return store.apply({
    summary,
    baseRevision: store.get().revision,
    files,
    ...(dependencies ? { dependencies } : {}),
  })
}

async function personalize(store: SourceCodeStore) {
  await apply(store, 'Personal workspace label', [
    { path: workspacePath, content: workspace.replace('Baseline', 'Personal') },
  ])
}

async function readState(options: SourceCodeStoreOptions): Promise<DiskState> {
  return JSON.parse(await readFile(join(options.directory, 'state.json'), 'utf8'))
}

async function changeState(options: SourceCodeStoreOptions, update: Partial<DiskState>) {
  await writeFile(
    join(options.directory, 'state.json'),
    JSON.stringify({ ...(await readState(options)), ...update }),
  )
}

async function readMetadata(options: SourceCodeStoreOptions, revision: number) {
  return JSON.parse(
    await readFile(join(options.directory, 'revisions', String(revision), 'metadata.json'), 'utf8'),
  ) as DiskMetadata
}

async function changeMetadata(
  options: SourceCodeStoreOptions,
  revision: number,
  update: (metadata: DiskMetadata) => void,
) {
  const metadata = await readMetadata(options, revision)
  update(metadata)
  await writeFile(
    join(options.directory, 'revisions', String(revision), 'metadata.json'),
    JSON.stringify(metadata),
  )
}

async function updateVersion(options: SourceCodeStoreOptions) {
  const path = join(options.sourceDir, 'package.json')
  const manifest = JSON.parse(await readFile(path, 'utf8'))
  await writeFile(path, JSON.stringify({ ...manifest, version: '2.0.0' }))
}

async function generationBytes(options: SourceCodeStoreOptions, revision: number) {
  const root = join(options.directory, 'revisions', String(revision))
  const files = (await readdir(root, { recursive: true, withFileTypes: true })).filter((file) =>
    file.isFile(),
  )
  return Object.fromEntries(
    await Promise.all(
      files.map(async (file) => {
        const path = join(file.parentPath, file.name)
        return [path.slice(root.length + 1), (await readFile(path)).toString('base64')]
      }),
    ),
  )
}

async function execute(store: SourceCodeStore) {
  const asset = store.assetPath(store.get().active!.js)
  expect(asset).toBeTruthy()
  const scope: Record<string, unknown> = {}
  const channels: MessageChannel[] = []
  class TestMessageChannel extends MessageChannel {
    constructor() {
      super()
      channels.push(this)
    }
  }
  try {
    runInNewContext(await readFile(asset!, 'utf8'), {
      globalThis: scope,
      console,
      TextEncoder,
      TextDecoder,
      MessageChannel: TestMessageChannel,
      setTimeout,
      clearTimeout,
      queueMicrotask,
      performance,
    })
  } finally {
    for (const channel of channels) {
      channel.port1.close()
      channel.port2.close()
    }
  }
  return scope.__life_upgrade_control as { type: string; props: { children: string } }
}

async function seedPackage(options: SourceCodeStoreOptions, version: string) {
  const dependencies = { 'life-upgrade-cached-package': version }
  const key = createHash('sha256').update(JSON.stringify(dependencies)).digest('hex').slice(0, 24)
  const root = join(options.directory, 'packages', key)
  await put(
    root,
    'node_modules/life-upgrade-cached-package/package.json',
    JSON.stringify({ name: 'life-upgrade-cached-package', version, main: 'index.js' }),
  )
  await put(
    root,
    'node_modules/life-upgrade-cached-package/index.js',
    `exports.marker = 'cached-${version}'\n`,
  )
  await put(root, '.complete', 'fixture package cache')
  return dependencies
}

afterEach(async () => {
  vi.restoreAllMocks()
  await Promise.all(stores.splice(0).map((store) => store.close()))
  await Promise.all(
    directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })),
  )
})

describe('automatic installed-source upgrades', () => {
  it.each([undefined, ...oldUpgradeWarnings])(
    'refreshes a version-only upgrade and historical disabled state %s exactly once',
    async (warning) => {
      const { store, options } = await fixture()
      await personalize(store)
      const originalId = store.get().extensions[0].id
      const originalBundle = await store.exportExtension(originalId)
      expect((await execute(store)).props.children).toBe('1.0.0:Personal:blue')
      const originalState = await readState(options)
      await store.close()
      if (warning) await changeState(options, { enabled: false, error: warning })
      await updateVersion(options)
      const updated = open(options)
      const compile = vi.spyOn(updated as unknown as CompilerHooks, 'compile')
      await updated.init()
      expect(compile).toHaveBeenCalledTimes(1)
      expect(updated.get()).toMatchObject({
        enabled: true,
        active: { revision: originalState.revision + 1 },
      })
      expect(updated.get().baseChanged).toBeUndefined()
      expect(updated.get().error).toBeUndefined()
      expect((await execute(updated)).props.children).toBe('2.0.0:Personal:blue')
      expect(await updated.exportExtension(originalId)).toEqual(originalBundle)
      const refreshed = updated.get()
      await updated.init()
      expect(updated.get()).toEqual(refreshed)
      expect(compile).toHaveBeenCalledTimes(1)
      await updated.close()
      const cold = open(options)
      const coldCompile = vi.spyOn(cold as unknown as CompilerHooks, 'compile')
      await cold.init()
      expect(coldCompile).not.toHaveBeenCalled()
      expect(cold.get()).toEqual(refreshed)
      expect((await execute(cold)).props.children).toBe('2.0.0:Personal:blue')
    },
  )

  it('rebases ordered enabled layers, leaves disabled layers intact, and reuses their package cache', async () => {
    const deletedPath = 'src/shared/removed-by-user.ts'
    const { store, options } = await fixture({ [deletedPath]: 'export const obsolete = true\n' })
    const dependencies1 = await seedPackage(options, '1.0.0')
    const dependencies2 = await seedPackage(options, '2.0.0')
    const dependencies3 = await seedPackage(options, '3.0.0')
    await apply(
      store,
      'First personal layer',
      [
        { path: workspacePath, content: workspace.replace('Baseline', 'Personal') },
        { path: 'src/shared/user-note.ts', content: "export const note = 'Alpha'\n" },
        { path: deletedPath, content: null },
      ],
      dependencies1,
    )
    await apply(
      store,
      'Disabled color layer',
      [
        {
          path: workspacePath,
          content: workspace.replace('Baseline', 'Personal').replace('blue', 'orange'),
        },
      ],
      dependencies3,
    )
    const disabledId = store.get().extensions[1].id
    await store.setExtensionEnabled(disabledId, false)
    const customizedEntry = entry
      .replace(
        "import { label, accent } from '../shared/workspace'",
        "import { label, accent } from '../shared/workspace'\nimport { note } from '../shared/user-note'\nimport { marker } from 'life-upgrade-cached-package'",
      )
      .replace('accent)', "accent + ':' + note + ':' + marker)")
    await apply(
      store,
      'Second ordered personal layer',
      [
        { path: workspacePath, content: workspace.replace('Baseline', 'Stacked') },
        { path: 'src/shared/user-note.ts', content: "export const note = 'Beta'\n" },
        { path: 'src/renderer/main.tsx', content: customizedEntry },
      ],
      dependencies2,
    )
    const originalLayers = store.get().extensions
    const disabledBundle = await store.exportExtension(disabledId)
    const before = await readState(options)
    const originalGeneration = await generationBytes(options, before.current!)
    expect((await execute(store)).props.children).toBe('1.0.0:Stacked:blue:Beta:cached-2.0.0')
    await store.close()
    await updateVersion(options)
    await put(options.sourceDir, workspacePath, workspace.replace('blue', 'green'))
    await put(
      options.sourceDir,
      'src/shared/new-in-update.ts',
      'export const installedFeature = true\n',
    )
    await put(options.sourceDir, 'src/renderer/styles.css', 'output { color: #654321; }\n')
    const updated = open(options)
    await updated.init()
    expect(updated.get().enabled).toBe(true)
    expect(updated.get().baseChanged).toBeUndefined()
    expect(updated.get().extensions.map(({ id, enabled }) => ({ id, enabled }))).toEqual(
      originalLayers.map(({ id, enabled }) => ({ id, enabled })),
    )
    const context = await updated.getContext({
      paths: [workspacePath, 'src/shared/user-note.ts', 'src/shared/new-in-update.ts'],
    })
    expect(context.files).toEqual([
      {
        path: workspacePath,
        content: workspace.replace('Baseline', 'Stacked').replace('blue', 'green'),
      },
      { path: 'src/shared/user-note.ts', content: "export const note = 'Beta'\n" },
      { path: 'src/shared/new-in-update.ts', content: 'export const installedFeature = true\n' },
    ])
    expect(context.paths).not.toContain(deletedPath)
    expect(await updated.exportExtension(disabledId)).toEqual(disabledBundle)
    const secondLayer = await updated.exportExtension(originalLayers[2].id)
    expect(secondLayer.files.find((file) => file.path === workspacePath)).toMatchObject({
      kind: 'patch',
      preimage: workspace.replace('Baseline', 'Personal').replace('blue', 'green'),
      content: workspace.replace('Baseline', 'Stacked').replace('blue', 'green'),
    })
    const after = await readState(options)
    expect((await readMetadata(options, after.current!)).dependencies).toEqual(dependencies2)
    expect(await generationBytes(options, before.current!)).toEqual(originalGeneration)
    expect((await execute(updated)).props.children).toBe('2.0.0:Stacked:green:Beta:cached-2.0.0')
    expect(await readFile(updated.assetPath(updated.get().active!.css!)!, 'utf8')).toContain(
      '#654321',
    )
    await updated.close()
    const cold = open(options)
    const coldCompile = vi.spyOn(cold as unknown as CompilerHooks, 'compile')
    await cold.init()
    expect(coldCompile).not.toHaveBeenCalled()
    expect(await readState(options)).toEqual(after)
    expect((await execute(cold)).props.children).toBe('2.0.0:Stacked:green:Beta:cached-2.0.0')
  })

  it('keeps an unrecognized exact already-shipped patch portable and enabled', async () => {
    const { store, options } = await fixture()
    await personalize(store)
    const id = store.get().extensions[0].id
    const originalBundle = await store.exportExtension(id)
    await store.close()
    await updateVersion(options)
    await put(options.sourceDir, workspacePath, workspace.replace('Baseline', 'Personal'))
    const updated = open(options)
    await updated.init()
    expect(updated.get()).toMatchObject({ enabled: true, extensions: [{ id, enabled: true }] })
    expect(updated.get().baseChanged).toBeUndefined()
    expect(await updated.exportExtension(id)).toEqual(originalBundle)
    expect((await execute(updated)).props.children).toBe('2.0.0:Personal:blue')
    await updated.setExtensionEnabled(id, false)
    await updated.setExtensionEnabled(id, true)
    expect(await updated.exportExtension(id)).toEqual(originalBundle)
    expect((await execute(updated)).props.children).toBe('2.0.0:Personal:blue')
  })

  it.each(['conflict', 'build failure', 'state commit failure'] as const)(
    'preserves the original generation and stops retrying after an upgrade %s',
    async (failure) => {
      const { store, options } = await fixture()
      await personalize(store)
      const originalState = await readState(options)
      const originalGeneration = await generationBytes(options, originalState.current!)
      const id = store.get().extensions[0].id
      const originalBundle = await store.exportExtension(id)
      await store.close()
      await updateVersion(options)
      if (failure === 'conflict')
        await put(options.sourceDir, workspacePath, workspace.replace('Baseline', 'Installed'))
      if (failure === 'build failure')
        await put(
          options.sourceDir,
          'src/renderer/main.tsx',
          entry + "\nimport './missing-installed-module'\n",
        )
      const updated = open(options)
      const compile = vi.spyOn(updated as unknown as CompilerHooks, 'compile')
      if (failure === 'state commit failure') {
        const hooks = updated as unknown as CompilerHooks
        const originalWriteState = hooks.writeState.bind(updated)
        vi.spyOn(hooks, 'writeState').mockImplementation(async (state) => {
          if (state.current !== originalState.current)
            throw new Error('Fixture state commit failed')
          await originalWriteState(state)
        })
      }
      await updated.init()
      expect(compile).toHaveBeenCalledTimes(failure === 'conflict' ? 0 : 1)
      expect(updated.get()).toMatchObject({ enabled: false, baseChanged: true })
      expect(updated.get().active).toBeUndefined()
      expect(updated.get().error).toContain('original source edits are preserved')
      if (failure === 'conflict')
        expect(updated.get().error).toMatch(/conflicts.*src\/shared\/workspace\.ts/)
      if (failure === 'build failure')
        expect(updated.get().error).toMatch(/build failed[\s\S]*missing-installed-module/)
      if (failure === 'state commit failure')
        expect(updated.get().error).toContain('Fixture state commit failed')
      expect(await generationBytes(options, originalState.current!)).toEqual(originalGeneration)
      expect(await updated.exportExtension(id)).toEqual(originalBundle)
      const failedState = await readState(options)
      expect(failedState.current).toBe(originalState.current)
      expect(failedState.history).toEqual(originalState.history)
      expect(await readdir(join(options.directory, 'revisions'))).toEqual([
        String(originalState.current),
      ])
      await updated.close()
      const cold = open(options)
      const coldCompile = vi.spyOn(cold as unknown as CompilerHooks, 'compile')
      await cold.init()
      expect(coldCompile).not.toHaveBeenCalled()
      expect(cold.get()).toMatchObject({
        enabled: false,
        baseChanged: true,
        error: updated.get().error,
      })
      expect(await readState(options)).toEqual(failedState)
      expect(await generationBytes(options, originalState.current!)).toEqual(originalGeneration)
    },
  )

  it.each([
    'manual disable',
    'failed current',
    'failed old warning',
    'contradictory failed enabled',
    'near-match warning',
    'running enabled',
    'running old warning',
  ] as const)('does not compile or reactivate on either restart after %s', async (reason) => {
    const { store, options } = await fixture()
    await personalize(store)
    if (reason === 'manual disable') await store.disable()
    if (
      reason === 'failed current' ||
      reason === 'failed old warning' ||
      reason === 'contradictory failed enabled'
    )
      await store.disable('Fixture renderer startup failed')
    const originalState = await readState(options)
    const originalGeneration = await generationBytes(options, originalState.current!)
    await store.close()
    if (reason === 'contradictory failed enabled') await changeState(options, { enabled: true })
    if (reason === 'failed old warning')
      await changeState(options, { enabled: false, error: oldUpgradeWarnings[0] })
    if (reason === 'near-match warning')
      await changeState(options, {
        enabled: false,
        error: oldUpgradeWarnings[0] + ' Manually disabled.',
      })
    if (reason === 'running old warning')
      await changeState(options, { enabled: false, error: oldUpgradeWarnings[0] })
    if (reason.startsWith('running'))
      await put(options.directory, '.running', 'interrupted process')
    await updateVersion(options)
    const updated = open(options)
    const compile = vi.spyOn(updated as unknown as CompilerHooks, 'compile')
    await updated.init()
    expect(compile).not.toHaveBeenCalled()
    expect(updated.get()).toMatchObject({ enabled: false, baseChanged: true })
    expect(updated.get().active).toBeUndefined()
    if (reason.startsWith('running')) {
      expect(updated.get().recovered).toBe(true)
      expect(updated.get().error).toMatch(/Recovery|close cleanly/)
    }
    expect((await readState(options)).current).toBe(originalState.current)
    expect(await generationBytes(options, originalState.current!)).toEqual(originalGeneration)
    await updated.close()
    const cold = open(options)
    const coldCompile = vi.spyOn(cold as unknown as CompilerHooks, 'compile')
    await cold.init()
    expect(coldCompile).not.toHaveBeenCalled()
    expect(cold.get()).toMatchObject({ enabled: false, baseChanged: true })
    expect(cold.get().active).toBeUndefined()
    expect(await generationBytes(options, originalState.current!)).toEqual(originalGeneration)
  })

  it('keeps a known failed generation disabled even when its installed fingerprint still matches', async () => {
    const { store, options } = await fixture()
    await personalize(store)
    await store.disable('Fixture renderer startup failed')
    const failed = await readState(options)
    const originalGeneration = await generationBytes(options, failed.current!)
    await store.close()
    await changeState(options, { enabled: true })
    const restarted = open(options)
    const compile = vi.spyOn(restarted as unknown as CompilerHooks, 'compile')
    await restarted.init()
    expect(compile).not.toHaveBeenCalled()
    expect(restarted.get().enabled).toBe(false)
    expect(restarted.get().active).toBeUndefined()
    expect(restarted.get().baseChanged).toBeUndefined()
    expect(restarted.get().error).toBe('Fixture renderer startup failed')
    expect(await generationBytes(options, failed.current!)).toEqual(originalGeneration)
    await restarted.close()
    const cold = open(options)
    await cold.init()
    expect(cold.get().enabled).toBe(false)
    expect(cold.get().active).toBeUndefined()
    expect((await readState(options)).current).toBe(failed.current)
  })

  it('migrates a legacy version-only customization when its original file hashes are intact', async () => {
    const deletedPath = 'src/shared/legacy-deletion.ts'
    const userPath = 'src/shared/legacy-created.ts'
    const { store, options } = await fixture({ [deletedPath]: 'export const obsolete = true\n' })
    await apply(store, 'Legacy personal files', [
      { path: workspacePath, content: workspace.replace('Baseline', 'Personal') },
      { path: userPath, content: 'export const personal = true\n' },
      { path: deletedPath, content: null },
    ])
    const originalState = await readState(options)
    await store.close()
    await changeMetadata(options, originalState.current!, (metadata) => {
      delete metadata.extensions
    })
    await updateVersion(options)
    const updated = open(options)
    await updated.init()
    expect(updated.get().enabled).toBe(true)
    expect(updated.get().baseChanged).toBeUndefined()
    expect(updated.get().extensions).toMatchObject([
      { name: 'Legacy customization', enabled: true },
    ])
    expect((await execute(updated)).props.children).toBe('2.0.0:Personal:blue')
    const context = await updated.getContext({ paths: [userPath] })
    expect(context.files[0].content).toBe('export const personal = true\n')
    expect(context.paths).not.toContain(deletedPath)
    const accepted = await readState(options)
    await updated.close()
    const cold = open(options)
    const compile = vi.spyOn(cold as unknown as CompilerHooks, 'compile')
    await cold.init()
    expect(compile).not.toHaveBeenCalled()
    expect(await readState(options)).toEqual(accepted)
    expect((await execute(cold)).props.children).toBe('2.0.0:Personal:blue')
    expect((await cold.getContext()).paths).not.toContain(deletedPath)
  })

  it.each(['unlayered', 'previously synthesized'] as const)(
    'preserves ambiguous legacy edits when their old preimages are unavailable: %s',
    async (kind) => {
      const { store, options } = await fixture()
      await personalize(store)
      const originalState = await readState(options)
      const customizedWorkspace = workspace.replace('Baseline', 'Personal')
      await store.close()
      const installedWorkspace = workspace.replace('blue', 'green')
      await put(options.sourceDir, workspacePath, installedWorkspace)
      await updateVersion(options)
      await changeMetadata(options, originalState.current!, (metadata) => {
        if (kind === 'unlayered') delete metadata.extensions
        else {
          const layer = metadata.extensions![0]
          layer.bundle.name = layer.bundle.description = 'Legacy customization'
          layer.bundle.files = [
            {
              path: workspacePath,
              kind: 'patch',
              preimage: installedWorkspace,
              content: customizedWorkspace,
              baseHash: createHash('sha256').update(installedWorkspace).digest('hex'),
              patch: createTwoFilesPatch(
                workspacePath,
                workspacePath,
                installedWorkspace,
                customizedWorkspace,
              ),
            },
          ]
        }
      })
      const updated = open(options)
      const compile = vi.spyOn(updated as unknown as CompilerHooks, 'compile')
      await updated.init()
      expect(compile).not.toHaveBeenCalled()
      expect(updated.get()).toMatchObject({ enabled: false, baseChanged: true })
      expect(updated.get().error).toMatch(/older customization.*original source needed to merge/)
      expect((await readState(options)).current).toBe(originalState.current)
      expect((await updated.getContext({ paths: [workspacePath] })).files).toEqual([
        { path: workspacePath, content: customizedWorkspace },
      ])
      expect(await readFile(join(options.sourceDir, workspacePath), 'utf8')).toBe(
        installedWorkspace,
      )
      if (kind === 'unlayered')
        expect((await readMetadata(options, originalState.current!)).legacyBaseUnavailable).toBe(
          true,
        )
      await updated.close()
      const cold = open(options)
      const coldCompile = vi.spyOn(cold as unknown as CompilerHooks, 'compile')
      await cold.init()
      expect(coldCompile).not.toHaveBeenCalled()
      expect(cold.get()).toMatchObject({ enabled: false, baseChanged: true })
      expect((await cold.getContext({ paths: [workspacePath] })).files[0].content).toBe(
        customizedWorkspace,
      )
    },
  )

  it('preserves legacy deletions without hashes instead of treating old files as newly shipped', async () => {
    const deletedPath = 'src/shared/deleted-by-user.ts'
    const { store, options } = await fixture({ [deletedPath]: 'export const removeMe = true\n' })
    await apply(store, 'Remove an obsolete installed module', [
      { path: deletedPath, content: null },
    ])
    const originalState = await readState(options)
    await store.close()
    await changeMetadata(options, originalState.current!, (metadata) => {
      delete metadata.extensions
      delete metadata.baseHashes
    })
    await updateVersion(options)
    const updated = open(options)
    const compile = vi.spyOn(updated as unknown as CompilerHooks, 'compile')
    await updated.init()
    expect(compile).not.toHaveBeenCalled()
    expect(updated.get()).toMatchObject({ enabled: false, baseChanged: true })
    expect(updated.get().error).toMatch(/older customization|original source|baseline|hash/i)
    expect((await readState(options)).current).toBe(originalState.current)
    expect((await updated.getContext()).paths).not.toContain(deletedPath)
    await updated.close()
    const cold = open(options)
    const coldCompile = vi.spyOn(cold as unknown as CompilerHooks, 'compile')
    await cold.init()
    expect(coldCompile).not.toHaveBeenCalled()
    expect(cold.get().enabled).toBe(false)
    expect((await cold.getContext()).paths).not.toContain(deletedPath)
  })

  it('preserves a legacy deletion whose baseline hash is absent during an upgrade', async () => {
    const deletedPath = 'src/shared/partially-hashed-deletion.ts'
    const { store, options } = await fixture({ [deletedPath]: 'export const obsolete = true\n' })
    await apply(store, 'Delete a legacy module', [{ path: deletedPath, content: null }])
    const originalState = await readState(options)
    await store.close()
    await changeMetadata(options, originalState.current!, (metadata) => {
      delete metadata.extensions
      delete metadata.baseHashes![deletedPath]
    })
    await updateVersion(options)
    const updated = open(options)
    const compile = vi.spyOn(updated as unknown as CompilerHooks, 'compile')
    await updated.init()
    expect(compile).not.toHaveBeenCalled()
    expect(updated.get()).toMatchObject({ enabled: false, baseChanged: true })
    expect(updated.get().error).toMatch(/older customization|original source|baseline|hash/i)
    expect((await readState(options)).current).toBe(originalState.current)
    expect((await updated.getContext()).paths).not.toContain(deletedPath)
    await updated.close()
    const cold = open(options)
    const coldCompile = vi.spyOn(cold as unknown as CompilerHooks, 'compile')
    await cold.init()
    expect(coldCompile).not.toHaveBeenCalled()
    expect(cold.get().enabled).toBe(false)
    expect((await cold.getContext()).paths).not.toContain(deletedPath)
  })

  it.each(['missing', 'partial'] as const)(
    'recovers legacy deletions from a matching installed fingerprint before a later update: %s hashes',
    async (hashes) => {
      const deletedPath = 'src/shared/same-version-deletion.ts'
      const { store, options } = await fixture({ [deletedPath]: 'export const obsolete = true\n' })
      await apply(store, 'Keep a legacy deletion', [{ path: deletedPath, content: null }])
      const originalState = await readState(options)
      await store.close()
      await changeMetadata(options, originalState.current!, (metadata) => {
        delete metadata.extensions
        if (hashes === 'missing') delete metadata.baseHashes
        else delete metadata.baseHashes![deletedPath]
      })
      const migrated = open(options)
      const migrationCompile = vi.spyOn(migrated as unknown as CompilerHooks, 'compile')
      await migrated.init()
      expect(migrationCompile).not.toHaveBeenCalled()
      expect(migrated.get().enabled).toBe(true)
      expect((await migrated.getContext()).paths).not.toContain(deletedPath)
      expect(migrated.get().extensions[0].files).toContain(deletedPath)
      const portable = await migrated.exportExtension(migrated.get().extensions[0].id)
      expect(portable.files.find((file) => file.path === deletedPath)).toMatchObject({
        kind: 'delete',
        preimage: 'export const obsolete = true\n',
      })
      await migrated.close()
      await updateVersion(options)
      const updated = open(options)
      await updated.init()
      expect(updated.get().enabled).toBe(true)
      expect(updated.get().baseChanged).toBeUndefined()
      expect((await updated.getContext()).paths).not.toContain(deletedPath)
      expect((await execute(updated)).props.children).toBe('2.0.0:Baseline:blue')
    },
  )
})
