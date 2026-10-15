import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { createHash } from 'node:crypto'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { Deferred, Effect, Exit, Scope } from 'effect'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { SourceCodeStore, type SourceCodeStoreOptions } from '../src/main/source-code'
import { CustomizationStore } from '../src/main/customization'
import { ExtensionStore } from '../src/main/extensions'
import {
  NativeRecoveryActions,
  makeStudioRecoveryActionDrivers,
  type NativeRecoveryActionRequest,
} from '../src/main/native-recovery-actions'
import { builtinExtensionCatalog } from '../src/shared/builtin-extensions'
import { NativeDocumentReadiness } from '../src/main/native-document-readiness'

const snapshotPublication = vi.hoisted(() => ({
  beforeLink: undefined as ((path: string) => Promise<void>) | undefined,
}))
vi.mock('node:fs/promises', async (importOriginal) => {
  const original = await importOriginal<typeof import('node:fs/promises')>()
  return {
    ...original,
    link: async (
      from: Parameters<typeof original.link>[0],
      to: Parameters<typeof original.link>[1],
    ) => {
      await snapshotPublication.beforeLink?.(String(to))
      return original.link(from, to)
    },
  }
})

const directories: string[] = []
const stores: SourceCodeStore[] = []
const customizationStores: CustomizationStore[] = []
const extensionStores: ExtensionStore[] = []
const scopes: Scope.Closeable[] = []
const documents: NativeDocumentReadiness[] = []
const run = <A>(effect: Effect.Effect<A, unknown>) => Effect.runPromise(effect)
afterEach(async () => {
  vi.restoreAllMocks()
  snapshotPublication.beforeLink = undefined
  for (const document of documents.splice(0)) document.close()
  for (const scope of scopes.splice(0)) await run(Scope.close(scope, Exit.void))
  for (const store of customizationStores.splice(0)) store.close()
  for (const store of extensionStores.splice(0)) await store.close()
  for (const store of stores.splice(0)) await store.close()
  for (const directory of directories.splice(0))
    await rm(directory, { recursive: true, force: true })
})
const identity = { actionId: 'source-action', intentHash: 'a'.repeat(64) }
async function fixture(extraOptions: Partial<SourceCodeStoreOptions> = {}) {
  const directory = await mkdtemp(join(tmpdir(), 'life-source-receipts-'))
  directories.push(directory)
  const sourceDir = join(directory, 'source')
  await mkdir(join(sourceDir, 'src/renderer'), { recursive: true })
  await writeFile(
    join(sourceDir, 'src/renderer/main.tsx'),
    "import { label } from './label'; (globalThis as any).__life_label = label\n",
  )
  await writeFile(join(sourceDir, 'src/renderer/label.ts'), "export const label = 'Original'\n")
  await writeFile(
    join(sourceDir, 'package.json'),
    JSON.stringify({
      name: 'life-source-receipt-fixture',
      version: '1.0.0',
      private: true,
      dependencies: {},
    }),
  )
  const options = {
    directory: join(directory, 'customizations'),
    sourceDir,
    nodeModulesDir: resolve('node_modules'),
    onUpdate: () => {},
    ...extraOptions,
  }
  const store = new SourceCodeStore(options)
  stores.push(store)
  await store.init()
  const patch = {
    summary: 'Preserve this exact source build',
    baseRevision: 0,
    files: [
      {
        path: 'src/renderer/label.ts',
        content: 'export const label = ' + JSON.stringify('Exact\r\n🌍\ud800') + '\n',
      },
    ],
  }
  return { store, directory, options, patch }
}

async function nativeActions(
  sourceCode: SourceCodeStore,
  directory: string,
  options: {
    reload?: () => Promise<void>
    customizationUpdate?: () => void
    autoReady?: boolean
  } = {},
) {
  const customization = new CustomizationStore(
    join(directory, 'config'),
    options.customizationUpdate,
  )
  customizationStores.push(customization)
  await customization.init()
  const extensions = new ExtensionStore(join(directory, 'runtime-extensions'))
  extensionStores.push(extensions)
  await extensions.init()
  const document = new NativeDocumentReadiness()
  documents.push(document)
  const documentOwner = {}
  document.commit(documentOwner)
  document.ready(documentOwner, 0)
  const drivers = makeStudioRecoveryActionDrivers({
    sourceCode,
    customization,
    extensions,
    captureReloadDocument: () => document.capture(),
    reload: async (request, prepared, signal) => {
      await options.reload?.()
      if (options.autoReady !== false) {
        document.commit(documentOwner)
        document.ready(documentOwner, Number(request.intent.revision))
      }
      await document.wait(prepared.originalDocumentId, Number(request.intent.revision), signal)
    },
    reconcileReload: async (request, prepared) =>
      document.matches(prepared.originalDocumentId, Number(request.intent.revision)),
  })
  const scope = await run(Scope.make())
  scopes.push(scope)
  const actions = await run(
    NativeRecoveryActions.make({ directory: join(directory, 'native-actions'), drivers }).pipe(
      Scope.provide(scope),
    ),
  )
  return { actions, customization, extensions, drivers, document, documentOwner }
}
function action(
  kind: NativeRecoveryActionRequest['kind'],
  intent: NativeRecoveryActionRequest['intent'],
  actionId = 'native-source-action',
): NativeRecoveryActionRequest {
  return {
    actionId,
    transportId: 'native-transport',
    sessionId: 'studio-session',
    ownerGeneration: 1,
    kind,
    intent,
  }
}

describe('source action commit identity', () => {
  it('writes the original snapshot with its generation and returns it after close/reopen without a second build', async () => {
    const { store, options, patch } = await fixture()
    const snapshot = await store.apply(patch, identity)
    const state = JSON.parse(await readFile(join(store.path, 'state.json'), 'utf8'))
    expect(state.current).toBe(snapshot.active?.revision)
    expect(state.recoveryActions).toEqual([
      {
        ...identity,
        payloadHash: expect.stringMatching(/^[a-f0-9]{64}$/),
        revision: snapshot.revision,
        snapshotHash: expect.stringMatching(/^[a-f0-9]{64}$/),
      },
    ])
    const frozen = JSON.parse(
      await readFile(
        join(store.path, 'revisions', String(snapshot.revision), 'recovery-action.json'),
        'utf8',
      ),
    )
    expect(frozen.snapshot).toEqual(snapshot)
    expect(frozen.checksum).toBe(state.recoveryActions[0].snapshotHash)
    expect(await store.readRecoveryAction(identity.actionId, identity.intentHash)).toEqual(snapshot)
    await store.close()
    const recovered = new SourceCodeStore(options)
    stores.push(recovered)
    await recovered.init()
    expect(await recovered.apply(patch, identity)).toEqual(snapshot)
    expect(recovered.get().revision).toBe(snapshot.revision)
    expect(recovered.get().extensions).toHaveLength(1)
    expect(
      (await recovered.getContext({ paths: ['src/renderer/label.ts'] })).files[0].content,
    ).toBe(patch.files[0].content)
  })

  it('rejects action ID collisions even when a caller reuses the same intent hash', async () => {
    const { store, patch } = await fixture()
    const original = await store.apply(patch, identity)
    const state = await readFile(join(store.path, 'state.json'), 'utf8')
    await expect(
      store.apply(
        { ...patch, files: [{ ...patch.files[0], content: "export const label = 'Different'\n" }] },
        identity,
      ),
    ).rejects.toThrow('different exact proposal')
    await expect(store.apply(patch, { ...identity, intentHash: 'b'.repeat(64) })).rejects.toThrow(
      'different exact proposal',
    )
    await expect(store.readRecoveryAction(identity.actionId, 'b'.repeat(64))).rejects.toThrow(
      'different exact proposal',
    )
    expect(await readFile(join(store.path, 'state.json'), 'utf8')).toBe(state)
    expect(await store.readRecoveryAction(identity.actionId, identity.intentHash)).toEqual(original)
  })

  it('retains historical receipts through another apply, rollback and disable without returning the new snapshot', async () => {
    const { store, patch } = await fixture()
    const original = await store.apply(patch, identity)
    await store.apply({
      ...patch,
      summary: 'Unrelated later change',
      baseRevision: original.revision,
      files: [{ ...patch.files[0], content: "export const label = 'Later'\n" }],
    })
    expect(await store.readRecoveryAction(identity.actionId, identity.intentHash)).toEqual(original)
    await store.rollback()
    await store.disable('Disable current renderer for recovery')
    expect(store.get().enabled).toBe(false)
    expect(store.get().revision).toBeGreaterThan(original.revision)
    expect(await store.readRecoveryAction(identity.actionId, identity.intentHash)).toEqual(original)
    expect(await store.apply(patch, identity)).toEqual(original)
    expect(store.get().enabled).toBe(false)
  })

  it('does not manufacture a receipt or rebuild an orphan generation left before state publication', async () => {
    const { store, patch } = await fixture()
    await mkdir(join(store.path, 'revisions/1'), { recursive: true })
    expect(await store.readRecoveryAction(identity.actionId, identity.intentHash)).toBeUndefined()
    await expect(store.apply(patch, identity)).rejects.toThrow('source generation already exists')
    expect(await store.readRecoveryAction(identity.actionId, identity.intentHash)).toBeUndefined()
    expect(store.get().revision).toBe(0)
  })

  it('preserves receipt bytes and original generation when saved receipt metadata cannot be decoded', async () => {
    const prepareCompiler = vi.fn(async () => resolve('node_modules'))
    const { store, options, patch } = await fixture({ prepareNodeModules: prepareCompiler })
    const original = await store.apply(patch, identity)
    await store.close()
    const path = join(store.path, 'state.json')
    const state = JSON.parse(await readFile(path, 'utf8'))
    state.recoveryActions[0].revision = 'corrupted'
    const corrupt = JSON.stringify(state)
    await writeFile(path, corrupt)
    const recovered = new SourceCodeStore(options)
    stores.push(recovered)
    await recovered.init()
    prepareCompiler.mockClear()
    expect(recovered.get().enabled).toBe(false)
    await expect(recovered.apply(patch, identity)).rejects.toThrow(
      'preserved the unreadable source state',
    )
    await expect(
      recovered.readRecoveryAction(identity.actionId, identity.intentHash),
    ).rejects.toThrow()
    expect(prepareCompiler).not.toHaveBeenCalled()
    expect(await readFile(path, 'utf8')).toBe(corrupt)
    expect(
      await readFile(
        join(store.path, 'revisions', String(original.revision), 'src/renderer/label.ts'),
        'utf8',
      ),
    ).toBe(patch.files[0].content)
  })

  it('keeps the original successful action receipt when an unclean shutdown disables its renderer', async () => {
    const { store, options, patch } = await fixture()
    const original = await store.apply(patch, identity)
    await store.close()
    await writeFile(join(store.path, '.running'), 'interrupted process')
    const recovered = new SourceCodeStore(options)
    stores.push(recovered)
    await recovered.init()
    expect(recovered.get()).toMatchObject({ enabled: false, recovered: true })
    expect(await recovered.readRecoveryAction(identity.actionId, identity.intentHash)).toEqual(
      original,
    )
    expect(await recovered.apply(patch, identity)).toEqual(original)
    expect(recovered.get().enabled).toBe(false)
  })

  it('compacts legacy inline receipts into immutable checksummed snapshots without changing their outcomes', async () => {
    const { store, options, patch } = await fixture()
    const original = await store.apply(patch, identity)
    await store.close()
    const statePath = join(store.path, 'state.json')
    const state = JSON.parse(await readFile(statePath, 'utf8'))
    const marker = state.recoveryActions[0]
    state.recoveryActions = [
      {
        actionId: marker.actionId,
        intentHash: marker.intentHash,
        payloadHash: marker.payloadHash,
        snapshot: original,
      },
    ]
    await writeFile(statePath, JSON.stringify(state))
    await rm(join(store.path, 'revisions/1/recovery-action.json'))
    const recovered = new SourceCodeStore(options)
    stores.push(recovered)
    await recovered.init()
    expect(await recovered.readRecoveryAction(identity.actionId, identity.intentHash)).toEqual(
      original,
    )
    await recovered.disable()
    const compacted = JSON.parse(await readFile(statePath, 'utf8')).recoveryActions[0]
    expect(compacted).not.toHaveProperty('snapshot')
    expect(compacted).toMatchObject({ ...identity, revision: 1 })
    const frame = JSON.parse(
      await readFile(join(store.path, 'revisions/1/recovery-action.json'), 'utf8'),
    )
    const { checksum, ...payload } = frame
    expect(checksum).toBe(createHash('sha256').update(JSON.stringify(payload)).digest('hex'))
    expect(compacted.snapshotHash).toBe(checksum)
    expect(await recovered.readRecoveryAction(identity.actionId, identity.intentHash)).toEqual(
      original,
    )
  })

  it('keeps historical snapshots out of later state rewrites and detects altered immutable snapshot bytes', async () => {
    const { store, patch } = await fixture()
    const original = await store.apply(patch, identity)
    const path = join(store.path, 'revisions/1/recovery-action.json')
    const originalBytes = await readFile(path, 'utf8')
    await store.apply(
      {
        ...patch,
        summary: 'Another exact action',
        baseRevision: 1,
        files: [{ ...patch.files[0], content: "export const label = 'Second'\n" }],
      },
      { actionId: 'second-action', intentHash: 'b'.repeat(64) },
    )
    const state = JSON.parse(await readFile(join(store.path, 'state.json'), 'utf8'))
    expect(state.recoveryActions).toHaveLength(2)
    expect(
      state.recoveryActions.every((receipt: object) => !Object.hasOwn(receipt, 'snapshot')),
    ).toBe(true)
    expect(await readFile(path, 'utf8')).toBe(originalBytes)
    expect(await store.readRecoveryAction(identity.actionId, identity.intentHash)).toEqual(original)
    const corrupted = JSON.parse(originalBytes)
    corrupted.snapshot.summary = 'Unknown altered history'
    const altered = JSON.stringify(corrupted)
    await writeFile(path, altered)
    await expect(store.readRecoveryAction(identity.actionId, identity.intentHash)).rejects.toThrow(
      'checksum',
    )
    await expect(store.apply(patch, identity)).rejects.toThrow('checksum')
    expect(await readFile(path, 'utf8')).toBe(altered)
    expect(store.get().revision).toBe(2)
  })

  it('preserves unrelated snapshot bytes created at the exclusive publication boundary', async () => {
    const { store, options, patch } = await fixture()
    const original = await store.apply(patch, identity)
    await store.close()
    const statePath = join(store.path, 'state.json')
    const state = JSON.parse(await readFile(statePath, 'utf8'))
    const marker = state.recoveryActions[0]
    state.recoveryActions = [
      {
        actionId: marker.actionId,
        intentHash: marker.intentHash,
        payloadHash: marker.payloadHash,
        snapshot: original,
      },
    ]
    const originalState = JSON.stringify(state)
    await writeFile(statePath, originalState)
    const path = join(store.path, 'revisions/1/recovery-action.json')
    await rm(path)
    const recovered = new SourceCodeStore(options)
    stores.push(recovered)
    await recovered.init()
    const unknown = 'Unknown pre-existing snapshot bytes; preserve exactly.'
    snapshotPublication.beforeLink = async (target) => {
      if (target !== path) return
      snapshotPublication.beforeLink = undefined
      await writeFile(path, unknown)
    }
    await expect(recovered.disable()).rejects.toThrow()
    expect(await readFile(path, 'utf8')).toBe(unknown)
    expect(await readFile(statePath, 'utf8')).toBe(originalState)
    expect(await recovered.readRecoveryAction(identity.actionId, identity.intentHash)).toEqual(
      original,
    )
  })

  it('preserves built-in ownership, deleted choices and readonly feature metadata in a frozen receipt', async () => {
    const { store, options, patch } = await fixture({
      builtinExtensions: builtinExtensionCatalog.slice(0, 1),
    })
    const builtIn = builtinExtensionCatalog[0]
    await store.removeExtension(builtIn.id)
    const original = await store.apply(patch, identity)
    expect(original.extensions.find((entry) => entry.id === builtIn.id)).toMatchObject({
      builtIn: true,
      deleted: true,
      originalId: builtIn.originalId,
      features: [...builtIn.features],
      effect: builtIn.effect,
    })
    await store.setExtensionEnabled(builtIn.id, true)
    expect(await store.readRecoveryAction(identity.actionId, identity.intentHash)).toEqual(original)
    await store.close()
    const recovered = new SourceCodeStore(options)
    stores.push(recovered)
    await recovered.init()
    expect(await recovered.readRecoveryAction(identity.actionId, identity.intentHash)).toEqual(
      original,
    )
  })

  it('uses real source commit receipts and permits exactly one linked reload of the current revision', async () => {
    const { store, directory, patch } = await fixture()
    let reloads = 0
    const { actions } = await nativeActions(store, directory, {
      reload: async () => {
        reloads++
      },
    })
    const applied = await run(actions.perform(action('source-apply', { patch })))
    expect(applied.status).toBe('succeeded')
    const revision = store.get().revision
    const reload = action(
      'reload',
      { appliedActionId: 'native-source-action', revision },
      'native-reload-action',
    )
    expect((await run(actions.perform(reload))).status).toBe('succeeded')
    expect((await run(actions.perform(reload))).status).toBe('succeeded')
    expect(reloads).toBe(1)
  })

  it('refuses reloads with another owner, missing commit or wrong revision without invoking reload', async () => {
    const { store, directory, patch } = await fixture()
    let reloads = 0
    const { actions } = await nativeActions(store, directory, {
      reload: async () => {
        reloads++
      },
    })
    await run(actions.perform(action('source-apply', { patch })))
    const intent = { appliedActionId: 'native-source-action', revision: store.get().revision }
    for (const [index, changed] of [
      { transportId: 'foreign' },
      { sessionId: 'foreign' },
      { ownerGeneration: 2 },
      { intent: { ...intent, revision: intent.revision + 1 } },
      { intent: { ...intent, appliedActionId: 'missing' } },
    ].entries())
      await expect(
        run(actions.perform({ ...action('reload', intent, 'bad-reload-' + index), ...changed })),
      ).rejects.toThrow()
    await store.disable()
    expect((await run(actions.perform(action('reload', intent, 'inactive-reload')))).status).toBe(
      'failed',
    )
    expect(reloads).toBe(0)
  })

  it('keeps scheduled reloads started until a different trusted document mounts the exact target revision', async () => {
    const { store, directory, patch } = await fixture()
    let announce!: () => void
    const scheduled = new Promise<void>((resolve) => {
      announce = resolve
    })
    const { actions, document, documentOwner } = await nativeActions(store, directory, {
      autoReady: false,
      reload: async () => {
        announce()
      },
    })
    await run(actions.perform(action('source-apply', { patch })))
    const reload = action(
      'reload',
      { appliedActionId: 'native-source-action', revision: 1 },
      'wait-reload',
    )
    let completed = false
    const pending = run(actions.perform(reload)).then((result) => {
      completed = true
      return result
    })
    await scheduled
    document.ready(documentOwner, 1)
    await run(Effect.sleep(1))
    expect(completed).toBe(false)
    document.commit(documentOwner)
    document.ready(documentOwner, 2)
    await run(Effect.sleep(1))
    expect(completed).toBe(false)
    document.ready(documentOwner, 1)
    expect((await pending).status).toBe('succeeded')
  })

  it('cancels a reload waiter and proves later cold document readiness without scheduling another reload', async () => {
    const { store, directory, patch } = await fixture()
    let announce!: () => void
    const scheduled = new Promise<void>((resolve) => {
      announce = resolve
    })
    let reloads = 0
    const { actions, document } = await nativeActions(store, directory, {
      autoReady: false,
      reload: async () => {
        reloads++
        announce()
      },
    })
    await run(actions.perform(action('source-apply', { patch })))
    const reload = action(
      'reload',
      { appliedActionId: 'native-source-action', revision: 1 },
      'cancel-reload',
    )
    const controller = new AbortController()
    const pending = Effect.runPromiseExit(actions.perform(reload), { signal: controller.signal })
    await scheduled
    controller.abort()
    expect(Exit.isFailure(await pending)).toBe(true)
    expect((await run(actions.read(reload)))?.status).toBe('started')
    expect((await run(actions.reconcileOnly(reload))).status).toBe('unknown')
    const newOwner = {}
    document.commit(newOwner)
    document.ready(newOwner, 1)
    expect((await run(actions.reconcileOnly(reload))).status).toBe('succeeded')
    expect((await run(actions.read(reload)))?.status).toBe('started')
    expect((await run(actions.perform(reload))).status).toBe('succeeded')
    expect(reloads).toBe(1)
  })

  it('records real compiler rejection once and preserves source-read contexts with native ownership', async () => {
    const { store, directory, patch } = await fixture()
    const { actions } = await nativeActions(store, directory)
    const read = action(
      'source-read',
      { purpose: 'source-read', read: { paths: ['src/renderer/label.ts'] } },
      'read-action',
    )
    const source = await run(actions.perform(read))
    expect(source.status).toBe('succeeded')
    expect(source.receipt?.native).toEqual(source.native)
    expect(source.receipt?.source).toMatchObject({
      files: [{ path: 'src/renderer/label.ts', content: "export const label = 'Original'\n" }],
    })
    const bad = action('source-apply', {
      patch: { ...patch, files: [{ ...patch.files[0], content: 'not valid javascript <<<<' }] },
    })
    const first = await run(actions.perform(bad))
    expect(first.status).toBe('failed')
    expect(await run(actions.perform(bad))).toEqual(first)
    expect(await run(actions.perform(read))).toEqual(source)
    expect(store.get().revision).toBe(0)
  })

  it('reconciles settings committed before an observer rejection without applying a second time', async () => {
    const { store, directory } = await fixture()
    let updates = 0
    let rejectObserver = false
    const { actions, customization } = await nativeActions(store, directory, {
      customizationUpdate: () => {
        updates++
        if (rejectObserver) throw new Error('Observer vanished after settings write')
      },
    })
    rejectObserver = true
    const request = action('settings-apply', { patch: { fontSize: 18 } }, 'settings-action')
    expect((await run(actions.perform(request))).status).toBe('succeeded')
    expect(customization.get().config.fontSize).toBe(18)
    const after = updates
    expect((await run(actions.perform(request))).status).toBe('succeeded')
    expect(updates).toBe(after)
  })

  it('reconciles the exact settings patch while preserving unrelated settings changed after preparation', async () => {
    const { store, directory } = await fixture()
    let rejectObserver = false
    const { actions, customization } = await nativeActions(store, directory, {
      customizationUpdate: () => {
        if (rejectObserver) throw new Error('Observer vanished')
      },
    })
    const request = action(
      'settings-apply',
      { patch: { fontSize: 18, labels: { welcomeTitle: 'Exact new title' } } },
      'settings-drift-action',
    )
    await run(actions.prepare(request))
    await customization.apply({
      sidebarWidth: 350,
      labels: { workspaceTitle: 'Independent workspace title' },
    })
    rejectObserver = true
    expect((await run(actions.perform(request))).status).toBe('succeeded')
    expect(customization.get().config).toMatchObject({
      fontSize: 18,
      sidebarWidth: 350,
      labels: { welcomeTitle: 'Exact new title', workspaceTitle: 'Independent workspace title' },
    })
  })

  it('retains a committed generation and reconciles its original snapshot when publication is followed by an error', async () => {
    const { store, directory, patch } = await fixture()
    const boundary = store as unknown as { writeState(state: unknown): Promise<void> }
    const originalWrite = boundary.writeState.bind(boundary)
    let publications = 0
    vi.spyOn(boundary, 'writeState').mockImplementation(async (state) => {
      await originalWrite(state)
      publications++
      throw new Error('Injected failure after authoritative state publication')
    })
    const { actions } = await nativeActions(store, directory)
    const request = action('source-apply', { patch })
    const result = await run(actions.perform(request))
    expect(result.status).toBe('succeeded')
    expect(result.receipt?.snapshot).toMatchObject({
      revision: 1,
      enabled: true,
      active: { revision: 1 },
    })
    expect(await readFile(join(store.path, 'revisions/1/src/renderer/label.ts'), 'utf8')).toBe(
      patch.files[0].content,
    )
    expect(store.get().error).toContain('Injected failure')
    expect(await run(actions.perform(request))).toEqual(result)
    expect(publications).toBe(1)
  })

  it('reports real extension worker startup failure as failed and never reinstalls it', async () => {
    const { store, directory } = await fixture()
    const { actions, extensions } = await nativeActions(store, directory)
    const request = action(
      'extension-apply',
      {
        manifest: {
          id: 'broken-worker',
          name: 'Broken worker',
          description: '',
          version: '1.0.0',
          renderer: { html: '', css: '', js: '', placement: 'panel' },
          main: 'throw new Error("WORKER_STARTUP_FAILURE")',
          enabled: true,
        },
      },
      'extension-action',
    )
    const first = await run(actions.perform(request))
    expect(first.status).toBe('failed')
    expect(first.error).toContain('WORKER_STARTUP_FAILURE')
    expect(extensions.get().extensions[0].enabled).toBe(false)
    const revision = extensions.get().revision
    expect(await run(actions.perform(request))).toEqual(first)
    expect(extensions.get().revision).toBe(revision)
  })

  it('recovers a real source commit that finishes after the Promise caller is interrupted', async () => {
    const { store, directory, patch } = await fixture()
    const originalApply = store.apply.bind(store)
    let release!: () => void
    let announced!: () => void
    let committed!: () => void
    const invoked = new Promise<void>((resolve) => {
      announced = resolve
    })
    const gate = new Promise<void>((resolve) => {
      release = resolve
    })
    const finished = new Promise<void>((resolve) => {
      committed = resolve
    })
    let executions = 0
    vi.spyOn(store, 'apply').mockImplementation(async (value, recovery) => {
      executions++
      announced()
      await gate
      return originalApply(value, recovery).finally(committed)
    })
    const { actions, drivers } = await nativeActions(store, directory)
    const request = action('source-apply', { patch })
    const controller = new AbortController()
    const first = Effect.runPromiseExit(actions.perform(request), { signal: controller.signal })
    await invoked
    controller.abort()
    expect(Exit.isFailure(await first)).toBe(true)
    expect((await run(actions.read(request)))?.status).toBe('started')
    await run(actions.closeEffect())
    release()
    await finished
    const scope = await run(Scope.make())
    scopes.push(scope)
    const reopened = await run(
      NativeRecoveryActions.make({ directory: join(directory, 'native-actions'), drivers }).pipe(
        Scope.provide(scope),
      ),
    )
    const recovered = await run(reopened.perform(request))
    expect(recovered.status).toBe('succeeded')
    expect(recovered.receipt?.snapshot).toMatchObject({ revision: 1 })
    expect(executions).toBe(1)
    const count = executions
    expect(await run(reopened.perform(request))).toEqual(recovered)
    expect(executions).toBe(count)
    expect(store.get().extensions).toHaveLength(1)
  })
})
