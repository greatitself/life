import { afterEach, describe, expect, it, vi } from 'vitest'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { ExtensionStore } from '../src/main/extensions'
import {
  parseExtensionManifest,
  parseExtensionPayload,
  type LifeExtensionManifest,
} from '../src/shared/extensions'

const stores: ExtensionStore[] = []
const directories: string[] = []

afterEach(async () => {
  await Promise.all(stores.splice(0).map((store) => store.close()))
  await Promise.all(directories.splice(0).map((path) => rm(path, { recursive: true, force: true })))
})

function manifest(main?: string, version = '1.0.0'): LifeExtensionManifest {
  return {
    id: 'laboratory',
    name: 'Laboratory',
    description: 'A test research extension',
    version,
    renderer: {
      html: '<h1>Laboratory</h1>',
      css: 'h1 { color: inherit; }',
      js: '',
      placement: 'panel',
    },
    ...(main === undefined ? {} : { main }),
    enabled: true,
  }
}

async function createStore(
  callbacks: {
    onInvoke?: (id: string, method: string, args: unknown) => Promise<unknown>
    onEvent?: (id: string, event: string, data: unknown) => void
  } = {},
  options: { startTimeoutMs?: number; callTimeoutMs?: number; watchDebounceMs?: number } = {},
) {
  const directory = await mkdtemp(join(tmpdir(), 'life-extensions-test-'))
  directories.push(directory)
  const onUpdate = vi.fn()
  const store = new ExtensionStore(
    directory,
    onUpdate,
    callbacks.onInvoke,
    callbacks.onEvent,
    options,
  )
  stores.push(store)
  await store.init()
  return { store, directory, onUpdate }
}

describe('executable Life extension boundaries', () => {
  it('validates manifests and rejects executable values or prototype pollution in messages', () => {
    expect(parseExtensionManifest(manifest()).renderer.placement).toBe('panel')
    expect(() => parseExtensionManifest({ ...manifest(), id: '../outside' })).toThrow()
    expect(() => parseExtensionManifest({ ...manifest(), unsafe: true })).toThrow()
    expect(() => parseExtensionManifest({ ...manifest(), renderer: { html: '' } })).toThrow()
    expect(() => parseExtensionPayload({ callback: () => true })).toThrow()
    expect(() => parseExtensionPayload({ value: Number.POSITIVE_INFINITY })).toThrow()
    expect(() => parseExtensionPayload(JSON.parse('{"__proto__":{"polluted":true}}'))).toThrow()
    const getter = vi.fn(() => 'executable')
    expect(() =>
      parseExtensionPayload(Object.defineProperty({}, 'value', { enumerable: true, get: getter })),
    ).toThrow()
    expect(getter).not.toHaveBeenCalled()
    const circular: Record<string, unknown> = {}
    circular.value = circular
    expect(() => parseExtensionPayload(circular)).toThrow()
    expect(() => parseExtensionPayload('x'.repeat(1024 * 1024))).toThrow()
    expect(parseExtensionPayload({ values: [null, 'research', 42, true] })).toEqual({
      values: [null, 'research', 42, true],
    })
  })

  it('starts real workers, executes Node filesystem code, and sends validated messages over the bridge', async () => {
    const onInvoke = vi.fn(async (id: string, method: string, args: unknown) => ({
      id,
      method,
      args,
      accepted: true,
    }))
    const onEvent = vi.fn()
    const { store, directory } = await createStore({ onInvoke, onEvent })
    const output = join(directory, 'experiment result.txt')
    await store.apply(
      manifest(`
        const fs = await import('node:fs/promises');
        life.handle('experiment', async (args) => {
          await fs.writeFile(${JSON.stringify(output)}, args.note, 'utf8');
          const result = await life.invoke('research.record', { note: args.note });
          life.emit('experiment.saved', { note: args.note });
          return { result, stored: await fs.readFile(${JSON.stringify(output)}, 'utf8') };
        });
      `),
    )
    expect(await store.call('laboratory', 'experiment', { note: 'Measured λ = 0.5' })).toEqual({
      result: {
        id: 'laboratory',
        method: 'research.record',
        args: { note: 'Measured λ = 0.5' },
        accepted: true,
      },
      stored: 'Measured λ = 0.5',
    })
    expect(await readFile(output, 'utf8')).toBe('Measured λ = 0.5')
    expect(onInvoke).toHaveBeenCalledWith('laboratory', 'research.record', {
      note: 'Measured λ = 0.5',
    })
    await vi.waitFor(() =>
      expect(onEvent).toHaveBeenCalledWith('laboratory', 'experiment.saved', {
        note: 'Measured λ = 0.5',
      }),
    )
  })

  it('resolves relative CommonJS helper modules from the extension directory', async () => {
    const { store, directory } = await createStore()
    await writeFile(
      join(directory, 'helper.cjs'),
      "module.exports = { message: 'local extension helper' }",
      'utf8',
    )
    await store.apply(
      manifest(
        "const helper = require('./helper.cjs'); life.handle('helper', async () => helper.message);",
      ),
    )
    expect(await store.call('laboratory', 'helper', null)).toBe('local extension helper')
  })

  it('hot replaces running workers and restores the prior executable version with rollback', async () => {
    const { store } = await createStore()
    await store.apply(manifest("life.handle('version', async () => 'first');"))
    expect(await store.call('laboratory', 'version', null)).toBe('first')
    const replaced = await store.apply(
      manifest("life.handle('version', async () => 'second');", '2.0.0'),
    )
    expect(replaced.canRollback).toContain('laboratory')
    expect(await store.call('laboratory', 'version', null)).toBe('second')
    const restored = await store.rollback('laboratory')
    expect(restored.extensions[0].version).toBe('1.0.0')
    expect(await store.call('laboratory', 'version', null)).toBe('first')
  })

  it('disables, re-enables, and removes extensions without exposing inactive workers', async () => {
    const { store } = await createStore()
    await store.apply(manifest("life.handle('echo', async (args) => args);"))
    const disabled = await store.enable('laboratory', false)
    expect(disabled.extensions[0].enabled).toBe(false)
    await expect(store.call('laboratory', 'echo', { value: 1 })).rejects.toThrow()
    expect((await store.enable('laboratory', true)).extensions[0].enabled).toBe(true)
    expect(await store.call('laboratory', 'echo', { value: 2 })).toEqual({ value: 2 })
    expect((await store.remove('laboratory')).extensions).toEqual([])
    await expect(store.call('laboratory', 'echo', null)).rejects.toThrow()
  })

  it('keeps a valid worker when a replacement fails schema validation', async () => {
    const { store } = await createStore()
    await store.apply(manifest("life.handle('echo', async (args) => args);"))
    await expect(store.apply({ ...manifest(), id: '../escape' })).rejects.toThrow()
    expect(store.get().extensions.map((extension) => extension.id)).toEqual(['laboratory'])
    expect(await store.call('laboratory', 'echo', 'still running')).toBe('still running')
    const snapshot = store.get()
    snapshot.extensions[0].name = 'Mutated snapshot'
    expect(store.get().extensions[0].name).toBe('Laboratory')
  })

  it('records a startup failure, disables the failing extension, and can roll back to working code', async () => {
    const { store } = await createStore()
    await store.apply(manifest("life.handle('echo', async (args) => args);"))
    const failed = await store.apply(manifest("throw new Error('startup failed');", '2.0.0'))
    expect(failed.errors.laboratory).toContain('startup failed')
    expect(failed.extensions[0].enabled).toBe(false)
    await expect(store.call('laboratory', 'echo', null)).rejects.toThrow()
    await store.rollback('laboratory')
    expect(await store.call('laboratory', 'echo', 'recovered')).toBe('recovered')
    expect(store.get().errors.laboratory).toBeUndefined()
  })

  it('terminates unresponsive extension calls within the configured timeout', async () => {
    const { store } = await createStore({}, { callTimeoutMs: 150, startTimeoutMs: 2000 })
    await store.apply(manifest("life.handle('hang', async () => { while (true) {} });"))
    await expect(store.call('laboratory', 'hang', null)).rejects.toThrow(/timed out|timeout/i)
    await vi.waitFor(() => expect(store.get().extensions[0].enabled).toBe(false))
    expect(store.get().errors.laboratory).toBeTruthy()
  })

  it('times out CPU-bound startup code without freezing the desktop process', async () => {
    const { store } = await createStore({}, { startTimeoutMs: 200 })
    const failed = await store.apply(manifest('while (true) {}'))
    expect(failed.extensions[0].enabled).toBe(false)
    expect(failed.errors.laboratory).toMatch(/timed out|timeout/i)
  })

  it('propagates handler errors without crashing the worker or losing unrelated methods', async () => {
    const { store } = await createStore()
    await store.apply(
      manifest(`
        life.handle('fail', async () => { throw new Error('experiment invalid'); });
        life.handle('echo', async (args) => args);
      `),
    )
    await expect(store.call('laboratory', 'fail', null)).rejects.toThrow('experiment invalid')
    expect(await store.call('laboratory', 'echo', { alive: true })).toEqual({ alive: true })
    await expect(store.call('laboratory', 'unknown', null)).rejects.toThrow()
    expect(store.get().extensions[0].enabled).toBe(true)
  })

  it('rejects a non-JSON result and disables its worker without leaving the call pending', async () => {
    const { store } = await createStore({}, { callTimeoutMs: 1000 })
    await store.apply(manifest("life.handle('invalid', async () => BigInt(1));"))
    await expect(store.call('laboratory', 'invalid', null)).rejects.toThrow(/JSON/)
    await vi.waitFor(() => expect(store.get().extensions[0].enabled).toBe(false))
  })

  it('makes handlers registered after startup callable through the live bridge', async () => {
    const { store } = await createStore()
    await store.apply(
      manifest(`
        life.handle('register', async () => {
          life.handle('later', async () => 'registered live');
          return true;
        });
      `),
    )
    await store.call('laboratory', 'register', null)
    expect(await store.call('laboratory', 'later', null)).toBe('registered live')
  })

  it('runs registered cleanup before disabling a cooperative worker', async () => {
    const { store, directory } = await createStore()
    const output = join(directory, 'cleanup.txt')
    await store.apply(
      manifest(`
        const fs = require('node:fs/promises');
        life.onDispose(async () => { await fs.writeFile(${JSON.stringify(output)}, 'cleaned'); });
        life.handle('alive', async () => true);
      `),
    )
    await store.enable('laboratory', false)
    expect(await readFile(output, 'utf8')).toBe('cleaned')
  })

  it('persists extension code and disabled state across clean desktop restarts', async () => {
    const { store, directory } = await createStore()
    await store.apply(manifest("life.handle('echo', async (args) => args);"))
    await store.close()
    const restarted = new ExtensionStore(directory)
    stores.push(restarted)
    const initial = await restarted.init()
    expect(initial.extensions).toEqual([manifest("life.handle('echo', async (args) => args);")])
    expect(initial.recovered).toBe(false)
    expect(await restarted.call('laboratory', 'echo', 'after restart')).toBe('after restart')
    await restarted.enable('laboratory', false)
    await restarted.close()
    const disabledRestart = new ExtensionStore(directory)
    stores.push(disabledRestart)
    expect((await disabledRestart.init()).extensions[0].enabled).toBe(false)
    await expect(disabledRestart.call('laboratory', 'echo', null)).rejects.toThrow()
  })

  it('recovers an interrupted prior run with installed code preserved and extension execution disabled', async () => {
    const { store, directory } = await createStore()
    const installed = manifest("life.handle('echo', async (args) => args);")
    await store.apply(installed)
    const extensionDirectory = store.get().path
    await store.close()
    await writeFile(
      join(extensionDirectory, '.runtime-active.json'),
      JSON.stringify({ ids: ['laboratory'] }),
      'utf8',
    )
    const recoveredStore = new ExtensionStore(directory)
    stores.push(recoveredStore)
    const recovered = await recoveredStore.init()
    expect(recovered.recovered).toBe(true)
    expect(recovered.extensions).toEqual([{ ...installed, enabled: false }])
    await expect(recoveredStore.call('laboratory', 'echo', null)).rejects.toThrow()
    await recoveredStore.enable('laboratory', true)
    expect(await recoveredStore.call('laboratory', 'echo', 'explicitly enabled')).toBe(
      'explicitly enabled',
    )
  })

  it('hot reloads valid manifest edits and preserves the last working code after a malformed edit', async () => {
    const { store, onUpdate } = await createStore({}, { watchDebounceMs: 30 })
    await store.apply(manifest("life.handle('version', async () => 'first');"))
    const file = join(store.get().path, 'laboratory.json')
    const edited = manifest("life.handle('version', async () => 'external edit');", '2.0.0')
    await writeFile(file, JSON.stringify(edited), 'utf8')
    await vi.waitFor(() => expect(store.get().extensions[0].version).toBe('2.0.0'), {
      timeout: 3000,
    })
    await vi.waitFor(
      async () => expect(await store.call('laboratory', 'version', null)).toBe('external edit'),
      { timeout: 3000 },
    )
    expect(onUpdate).toHaveBeenCalled()
    await writeFile(file, '{broken JSON', 'utf8')
    await vi.waitFor(() => expect(store.get().errors.laboratory).toBeTruthy(), { timeout: 3000 })
    expect(await store.call('laboratory', 'version', null)).toBe('external edit')
    await store.rollback('laboratory')
    expect(await store.call('laboratory', 'version', null)).toBe('first')
    expect(store.get().errors.laboratory).toBeUndefined()
  })
})
