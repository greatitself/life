import { afterEach, describe, expect, it, vi } from 'vitest'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { CustomizationStore } from '../src/main/customization'
import {
  defaultLifeConfig,
  mergeLifeConfig,
  parseLifeConfig,
  parseLifeConfigPatch,
} from '../src/shared/customization'

const stores: CustomizationStore[] = []
const directories: string[] = []
afterEach(async () => {
  stores.splice(0).forEach((store) => store.close())
  await Promise.all(directories.splice(0).map((path) => rm(path, { recursive: true, force: true })))
})

async function createStore(onUpdate = vi.fn()) {
  const directory = await mkdtemp(join(tmpdir(), 'life-customization-test-'))
  directories.push(directory)
  const store = new CustomizationStore(directory, onUpdate)
  stores.push(store)
  await store.init()
  return { store, directory, onUpdate }
}

describe('Life customization boundaries', () => {
  it('rejects unsupported palettes, unsafe extensions, duplicate IDs and out-of-range layout settings', () => {
    expect(() => parseLifeConfigPatch({ theme: 'purple' })).toThrow()
    expect(() => parseLifeConfigPatch({ fontSize: 100 })).toThrow()
    expect(() => parseLifeConfigPatch({ customJavascript: 'require("node:fs")' })).toThrow()
    expect(() => parseLifeConfigPatch({})).toThrow('at least one')
    expect(() =>
      parseLifeConfigPatch({
        commands: [
          { id: 'review', name: 'Review', prompt: 'Review the diff' },
          { id: 'review', name: 'Other review', prompt: 'Review the repository' },
        ],
      }),
    ).toThrow('unique')
    expect(() =>
      parseLifeConfigPatch({
        widgets: [
          {
            id: 'chart',
            title: 'Chart',
            kind: 'javascript',
            content: 'alert(1)',
            placement: 'research',
          },
        ],
      }),
    ).toThrow()
  })

  it('rejects prototype pollution, executable getters and circular objects before serialization', () => {
    expect(() => parseLifeConfigPatch(JSON.parse('{"__proto__":{"polluted":true}}'))).toThrow(
      'unsupported key',
    )
    expect(() =>
      parseLifeConfigPatch(JSON.parse('{"labels":{"constructor":{"prototype":{"x":1}}}}')),
    ).toThrow('unsupported key')
    const getter = vi.fn(() => 'dark')
    const executable = Object.defineProperty({}, 'theme', { enumerable: true, get: getter })
    expect(() => parseLifeConfigPatch(executable)).toThrow('getters or setters')
    expect(getter).not.toHaveBeenCalled()
    const circular: Record<string, unknown> = {}
    circular.labels = circular
    expect(() => parseLifeConfigPatch(circular)).toThrow('circular')
    expect(({} as Record<string, unknown>).polluted).toBeUndefined()
  })

  it('merges partial labels and replaces declarative extension lists without losing unrelated settings', () => {
    const customized = mergeLifeConfig(defaultLifeConfig, {
      labels: { researchTitle: 'Lab notebook' },
      commands: [{ id: 'literature', name: 'Literature review', prompt: 'Review relevant papers' }],
      widgets: [
        {
          id: 'hypothesis',
          title: 'Hypothesis',
          kind: 'markdown',
          content: '## Next experiment\nMeasure performance.',
          placement: 'both',
        },
      ],
    })
    expect(customized.labels.workspaceTitle).toBe(defaultLifeConfig.labels.workspaceTitle)
    expect(customized.labels.researchTitle).toBe('Lab notebook')
    expect(customized.commands[0].id).toBe('literature')
    const replaced = mergeLifeConfig(customized, { commands: [] })
    expect(replaced.commands).toEqual([])
    expect(replaced.widgets).toEqual(customized.widgets)
    expect(defaultLifeConfig.commands).toEqual([])
  })
})

describe('installed Life live configuration', () => {
  it('persists concurrent prompt changes atomically and reloads the combined config at startup', async () => {
    const { store, directory } = await createStore()
    await Promise.all([
      store.apply({ theme: 'light' }),
      store.apply({ fontSize: 17 }),
      store.apply({ density: 'compact', labels: { welcomeTitle: 'Welcome to the lab' } }),
      store.apply({ defaultProvider: 'claude', workspacePanel: false }),
    ])
    const saved = parseLifeConfig(JSON.parse(await readFile(store.path, 'utf8')))
    expect(saved).toMatchObject({
      theme: 'light',
      fontSize: 17,
      density: 'compact',
      defaultProvider: 'claude',
      workspacePanel: false,
      labels: { welcomeTitle: 'Welcome to the lab' },
    })
    const reloaded = new CustomizationStore(directory)
    stores.push(reloaded)
    expect((await reloaded.init()).config).toEqual(saved)
    const detachedSnapshot = reloaded.get()
    detachedSnapshot.config.theme = 'dark'
    expect(reloaded.get().config.theme).toBe('light')
  })

  it('preserves live settings after an invalid proposal and supports undo and reset', async () => {
    const { store } = await createStore()
    expect(store.get().canUndo).toBe(false)
    await store.apply({ theme: 'light' })
    await expect(store.apply({ theme: 'purple' })).rejects.toThrow()
    expect(store.get().config.theme).toBe('light')
    const undone = await store.undo()
    expect(undone.config.theme).toBe('dark')
    expect(undone.canUndo).toBe(false)
    await store.apply({ density: 'compact' })
    await store.reset()
    expect(store.get().config).toEqual(defaultLifeConfig)
    expect((await store.undo()).config.density).toBe('compact')
  })

  it('hot reloads hand-edited extensions, ignores malformed edits and can undo an external change', async () => {
    const { store, onUpdate } = await createStore()
    const config = mergeLifeConfig(defaultLifeConfig, {
      theme: 'light',
      widgets: [
        {
          id: 'experiment-map',
          title: 'Experiment map',
          kind: 'mermaid',
          content: 'flowchart LR\n  Hypothesis --> Experiment --> Result',
          placement: 'research',
        },
      ],
    })
    await writeFile(store.path, JSON.stringify(config), 'utf8')
    await vi.waitFor(() => expect(store.get().config).toEqual(config), { timeout: 2500 })
    expect(store.get().canUndo).toBe(true)
    await writeFile(store.path, '{not json', 'utf8')
    await vi.waitFor(() => expect(store.get().error).toContain('Cannot reload'), { timeout: 2500 })
    expect(store.get().config).toEqual(config)
    expect(onUpdate.mock.calls.at(-1)?.[0].error).toContain('Cannot reload')
    const restored = await store.undo()
    expect(restored.config).toEqual(defaultLifeConfig)
    expect(restored.error).toBeUndefined()
    expect(JSON.parse(await readFile(store.path, 'utf8'))).toEqual(defaultLifeConfig)
  })

  it('starts with defaults when an existing file is malformed and repairs it only when asked', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'life-customization-corrupt-'))
    directories.push(directory)
    const path = join(directory, 'life.config.json')
    await writeFile(path, '{broken', 'utf8')
    const store = new CustomizationStore(directory)
    stores.push(store)
    const initial = await store.init()
    expect(initial.config).toEqual(defaultLifeConfig)
    expect(initial.error).toContain('Cannot load')
    expect(await readFile(path, 'utf8')).toBe('{broken')
    await store.reset()
    expect(store.get().error).toBeUndefined()
    expect(JSON.parse(await readFile(path, 'utf8'))).toEqual(defaultLifeConfig)
  })

  it('retains the last valid config when reload sees a deleted file', async () => {
    const { store } = await createStore()
    await store.apply({ theme: 'light' })
    await rm(store.path)
    const snapshot = await store.reload()
    expect(snapshot.config.theme).toBe('light')
    expect(snapshot.error).toContain('Cannot reload')
    await store.apply({ fontSize: 16 })
    expect(store.get().error).toBeUndefined()
    expect(JSON.parse(await readFile(store.path, 'utf8')).theme).toBe('light')
  })
})
