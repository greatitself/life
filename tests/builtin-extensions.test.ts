import { afterEach, describe, expect, it } from 'vitest'
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { BuiltinExtensionStore } from '../src/main/builtin-extension-store'
import { SourceCodeStore } from '../src/main/source-code'
import { createHash } from 'node:crypto'
import { createTwoFilesPatch } from 'diff'
import {
  builtinExtensionCatalog,
  builtinFeatureEnabled,
  builtinFeatureKeys,
  relatedBuiltinExtensions,
} from '../src/shared/builtin-extensions'

const directories: string[] = []
const sourceStores: SourceCodeStore[] = []
async function directory() {
  const path = await mkdtemp(join(tmpdir(), 'life-built-in-controls-'))
  directories.push(path)
  return path
}
afterEach(async () => {
  await Promise.all(sourceStores.splice(0).map((store) => store.close()))
  await Promise.all(directories.splice(0).map((path) => rm(path, { recursive: true, force: true })))
})

describe('trusted built-in extension feature choices', () => {
  it('retains all 37 original public identities without shipping source snapshots', () => {
    expect(builtinExtensionCatalog).toHaveLength(37)
    expect(new Set(builtinExtensionCatalog.map((extension) => extension.originalId)).size).toBe(37)
    expect(builtinExtensionCatalog.every((extension) => extension.features.length > 0)).toBe(true)
    expect(new Set(builtinExtensionCatalog.flatMap((extension) => extension.features))).toEqual(
      new Set(builtinFeatureKeys),
    )
    const serialized = JSON.stringify(builtinExtensionCatalog)
    expect(serialized).not.toMatch(
      /preimage|baseHash|"content"|\/Users\/|C:\\\\Users\\\\|\.codex\/|\.ssh\//,
    )
  })

  it('disables shared functional gates and persists choices after a cold restart', async () => {
    const path = await directory()
    const store = new BuiltinExtensionStore(path, builtinExtensionCatalog)
    await store.init()
    expect(builtinFeatureEnabled(store.list(), 'research-workbench')).toBe(true)
    await store.setEnabled('builtin-source-ee937ac6bc82', false)
    expect(builtinFeatureEnabled(store.list(), 'research-workbench')).toBe(false)
    expect(builtinFeatureEnabled(store.list(), 'project-map')).toBe(false)
    expect(builtinFeatureEnabled(store.list(), 'thread-attachments')).toBe(true)
    const restarted = new BuiltinExtensionStore(path, builtinExtensionCatalog)
    await restarted.init()
    expect(
      restarted.list().find((extension) => extension.id === 'builtin-source-ee937ac6bc82')?.enabled,
    ).toBe(false)
    await restarted.setEnabled('builtin-source-2f6848a57686', false)
    await restarted.setEnabled('builtin-source-ee937ac6bc82', true)
    expect(builtinFeatureEnabled(restarted.list(), 'research-workbench')).toBe(false)
    expect(builtinFeatureEnabled(restarted.list(), 'project-map')).toBe(true)
    expect(
      relatedBuiltinExtensions('builtin-source-ee937ac6bc82').map((extension) => extension.id),
    ).toContain('builtin-source-2f6848a57686')
    await restarted.setEnabled('builtin-source-2f6848a57686', true)
    expect(builtinFeatureEnabled(restarted.list(), 'research-workbench')).toBe(true)
  })

  it('deletes only the installed feature choice, saves recovery first, and supports restoration', async () => {
    const path = await directory()
    const projectData = join(path, 'saved-conversations.json')
    const original = '{"remoteThread":"preserve-this","attachments":["saved.png"]}'
    await writeFile(projectData, original)
    const store = new BuiltinExtensionStore(path, builtinExtensionCatalog)
    await store.init()
    const id = 'builtin-source-e143e0e038ea'
    await store.remove(id)
    expect(store.list().find((extension) => extension.id === id)).toMatchObject({
      deleted: true,
      enabled: false,
    })
    expect(builtinFeatureEnabled(store.list(), 'workspace-surfaces')).toBe(false)
    const recovery = JSON.parse(
      await readFile(join(path, 'built-in-extension-recovery.json'), 'utf8'),
    )
    expect(recovery.extensionId).toBe(id)
    expect(recovery.choices.choices[id]).toBeUndefined()
    expect(await readFile(projectData, 'utf8')).toBe(original)
    const restart = new BuiltinExtensionStore(path, builtinExtensionCatalog)
    await restart.init()
    expect(restart.list().find((extension) => extension.id === id)).toMatchObject({
      deleted: true,
      enabled: false,
    })
    await restart.setEnabled(id, true)
    expect(restart.list().find((extension) => extension.id === id)?.deleted).toBeUndefined()
    expect(builtinFeatureEnabled(restart.list(), 'workspace-surfaces')).toBe(true)
    expect(await readFile(projectData, 'utf8')).toBe(original)
  })

  it('serializes concurrent choices without losing an unrelated setting', async () => {
    const path = await directory()
    const store = new BuiltinExtensionStore(path, builtinExtensionCatalog)
    await store.init()
    await Promise.all([
      store.setEnabled('builtin-source-2c5d2001c41c', false),
      store.setEnabled('builtin-source-7ae6e7db5cdd', false),
      store.remove('builtin-source-031b0e38170a'),
    ])
    const saved = JSON.parse(await readFile(join(path, 'built-in-extensions.json'), 'utf8'))
    expect(Object.keys(saved.choices)).toHaveLength(3)
    expect(saved.revision).toBe(3)
    expect(builtinFeatureEnabled(store.list(), 'thread-attachments')).toBe(false)
    expect(builtinFeatureEnabled(store.list(), 'message-queue')).toBe(false)
    expect(builtinFeatureEnabled(store.list(), 'composer-compact')).toBe(false)
    expect((await readdir(path)).filter((file) => file.endsWith('.tmp'))).toEqual([])
  })

  it('does not publish a partial feature change if the durable write fails', async () => {
    const path = await directory()
    const store = new BuiltinExtensionStore(path, builtinExtensionCatalog)
    await store.init()
    await mkdir(join(path, 'built-in-extensions.json'))
    await expect(store.setEnabled('builtin-source-2c5d2001c41c', false)).rejects.toThrow()
    expect(builtinFeatureEnabled(store.list(), 'thread-attachments')).toBe(true)
    expect(store.revision).toBe(0)
    expect((await readdir(path)).filter((file) => file.endsWith('.tmp'))).toEqual([])
  })

  it('preserves unreadable saved choices and pauses optional execution instead of silently reenabling', async () => {
    const path = await directory()
    const raw = '{"format":99,"privateChoices":"preserve"}'
    await writeFile(join(path, 'built-in-extensions.json'), raw)
    const store = new BuiltinExtensionStore(path, builtinExtensionCatalog)
    await store.init()
    expect(store.error).toMatch(/could not be read/)
    expect(builtinFeatureEnabled(store.list(), 'research-workbench')).toBe(false)
    expect(await readFile(join(path, 'built-in-extensions.json'), 'utf8')).toBe(raw)
    await store.setEnabled('builtin-source-031b0e38170a', true)
    expect(store.error).toBeUndefined()
    expect(
      JSON.parse(await readFile(join(path, 'built-in-extension-recovery.json'), 'utf8'))
        .originalFile,
    ).toBe(raw)
    expect(builtinFeatureEnabled(store.list(), 'research-workbench')).toBe(false)
    expect(builtinFeatureEnabled(store.list(), 'composer-compact')).toBe(true)
  })

  it('changes built-ins through the native source bridge without compiling or changing source revisions', async () => {
    const path = await directory()
    const sourceDir = join(path, 'source')
    await mkdir(join(sourceDir, 'src/renderer'), { recursive: true })
    await mkdir(join(sourceDir, 'src/shared'), { recursive: true })
    await writeFile(join(sourceDir, 'package.json'), JSON.stringify({ dependencies: {} }))
    await writeFile(
      join(sourceDir, 'src/renderer/main.tsx'),
      'invalid source that deliberately cannot compile',
    )
    const opts = {
      directory: join(path, 'custom-source'),
      sourceDir,
      nodeModulesDir: resolve('node_modules'),
      builtinExtensions: builtinExtensionCatalog,
    }
    const store = new SourceCodeStore(opts)
    sourceStores.push(store)
    await store.init()
    const originalRevision = store.get().revision
    const disabled = await store.setExtensionEnabled('builtin-source-2c5d2001c41c', false)
    expect(disabled.revision).toBe(originalRevision)
    expect(disabled.builtInRevision).toBe(1)
    expect(disabled.enabled).toBe(false)
    expect(disabled.active).toBeUndefined()
    expect(builtinFeatureEnabled(disabled.extensions, 'thread-attachments')).toBe(false)
    expect(await readdir(join(opts.directory, 'revisions'))).toEqual([])
    await store.removeExtension('builtin-source-2c5d2001c41c')
    await store.close()
    const restart = new SourceCodeStore(opts)
    sourceStores.push(restart)
    const snapshot = await restart.init()
    expect(
      snapshot.extensions.find((extension) => extension.id === 'builtin-source-2c5d2001c41c'),
    ).toMatchObject({ deleted: true, enabled: false, builtIn: true })
    expect(await readdir(join(opts.directory, 'revisions'))).toEqual([])
  })

  it('keeps an old custom extension with a newly reserved ID independently exportable and manageable', async () => {
    const path = await directory()
    const sourceDir = join(path, 'source')
    await mkdir(join(sourceDir, 'src/renderer'), { recursive: true })
    await mkdir(join(sourceDir, 'src/shared'), { recursive: true })
    await writeFile(join(sourceDir, 'package.json'), JSON.stringify({ dependencies: {} }))
    const preimage = ";(globalThis as any).__collision = 'baseline'\n"
    const content = preimage.replace('baseline', 'custom')
    await writeFile(join(sourceDir, 'src/renderer/main.tsx'), preimage)
    const options = {
      directory: join(path, 'custom-source'),
      sourceDir,
      nodeModulesDir: resolve('node_modules'),
    }
    const previous = new SourceCodeStore(options)
    sourceStores.push(previous)
    await previous.init()
    const id = 'builtin-source-2c5d2001c41c'
    const bundle = {
      format: 'life-source-extension',
      formatVersion: 1,
      id,
      name: 'Existing custom extension',
      description: 'Preserve its portable original identity',
      version: '1.0.0',
      createdAt: '2026-10-08T12:00:00.000Z',
      updatedAt: '2026-10-08T12:00:00.000Z',
      dependencies: {},
      files: [
        {
          path: 'src/renderer/main.tsx',
          kind: 'patch',
          preimage,
          content,
          baseHash: createHash('sha256').update(preimage).digest('hex'),
          patch: createTwoFilesPatch(
            'src/renderer/main.tsx',
            'src/renderer/main.tsx',
            preimage,
            content,
          ),
        },
      ],
    }
    await previous.importExtension(bundle)
    await previous.close()
    const upgraded = new SourceCodeStore({ ...options, builtinExtensions: builtinExtensionCatalog })
    sourceStores.push(upgraded)
    const installed = await upgraded.init()
    const custom = installed.extensions.find((extension) => !extension.builtIn)
    expect(custom).toMatchObject({
      originalId: id,
      enabled: true,
      name: 'Existing custom extension',
    })
    expect(custom?.id).toMatch(/^source-recovery-/)
    expect(new Set(installed.extensions.map((extension) => extension.id)).size).toBe(
      installed.extensions.length,
    )
    expect(await upgraded.exportExtension(custom!.id)).toEqual(bundle)
    const nativeDisabled = await upgraded.setExtensionEnabled(id, false)
    expect(
      nativeDisabled.extensions.find((extension) => extension.id === custom?.id)?.enabled,
    ).toBe(true)
    const customDisabled = await upgraded.setExtensionEnabled(custom!.id, false)
    expect(
      customDisabled.extensions.find((extension) => extension.id === custom?.id)?.enabled,
    ).toBe(false)
    expect(await upgraded.exportExtension(custom!.id)).toEqual(bundle)
    await upgraded.removeExtension(custom!.id)
    expect(
      upgraded
        .get()
        .extensions.some((extension) => extension.originalId === id && !extension.builtIn),
    ).toBe(false)
    expect(upgraded.get().extensions.find((extension) => extension.id === id)?.enabled).toBe(false)
  })
})
