import { readFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { dirname, resolve } from 'node:path'
import { describe, expect, it, vi } from 'vitest'
import {
  adaptViteRendererClient,
  guardRendererUpdatePayload,
  lifeRendererReloadPlugin,
  RendererOwnershipReloads,
} from '../scripts/vite-renderer-reload'

const require = createRequire(import.meta.url)
const clientEntry = resolve(dirname(require.resolve('vite/package.json')), 'dist/client/client.mjs')
const installed = readFileSync(clientEntry, 'utf8')
const attemptedUnload =
  'if (typeof window !== "undefined") window.addEventListener?.("beforeunload", () => {\n\twillUnload = true;\n});'
const actualUnload = attemptedUnload.replace('"beforeunload"', '"pagehide"')

describe('Electron development client actual-unload guard', () => {
  it('keeps native retirement local to the served client and retains its real-unload guard', () => {
    const adapted = adaptViteRendererClient(installed, clientEntry, clientEntry)
    expect(adapted).not.toBeNull()
    expect(adapted).toContain(actualUnload)
    expect(adapted).toContain('let lifeRendererReloadPending = false;')
    expect(adapted).toContain('update.lifeRendererStyleUpdate === true')
    expect(adapted).toContain('if (hasDocument && !willUnload)')
    expect(adapted).toContain('await waitForSuccessfulPing(url.href)')
    expect(adapted).toContain('location.reload()')
    expect(readFileSync(clientEntry, 'utf8')).toBe(installed)
  })

  it('also recognizes the same exact served module with a cache query', () => {
    expect(adaptViteRendererClient(installed, `${clientEntry}?t=123`, clientEntry)).toContain(
      actualUnload,
    )
  })

  it.each([
    'App.tsx',
    '/@vite/client',
    '/src/renderer/App.tsx',
    '/src/renderer/client.mjs',
    `${clientEntry}.backup`,
    `${clientEntry}/nested`,
  ])('never rewrites an unrelated module, even with the same source: %s', (moduleId) => {
    expect(adaptViteRendererClient(installed, moduleId, clientEntry)).toBeNull()
    expect(adaptViteRendererClient('', moduleId, clientEntry)).toBeNull()
    expect(adaptViteRendererClient(attemptedUnload.repeat(2), moduleId, clientEntry)).toBeNull()
  })

  it('fails explicitly when a changed installed client is missing the expected latch', () => {
    const changed = installed.replace(attemptedUnload, actualUnload)
    expect(() => adaptViteRendererClient(changed, clientEntry, clientEntry)).toThrow('found 0')
  })

  it('fails explicitly when a changed installed client duplicates the expected latch', () => {
    expect(() =>
      adaptViteRendererClient(`${installed}\n${attemptedUnload}`, clientEntry, clientEntry),
    ).toThrow('found 2')
  })

  it.each([
    ['document state', 'let willUnload = false;'],
    ['scheduled reload', 'const pageReload = debounceReload(20);'],
    ['overlay reload', 'if (isFirstUpdate && hasErrorOverlay()) {\n\t\t\t\tlocation.reload();'],
    ['reconnect reload', 'await waitForSuccessfulPing(url.href);\n\t\t\t\t\tlocation.reload();'],
    [
      'update dispatch',
      'case "update":\n\t\t\tawait hmrClient.notifyListeners("vite:beforeUpdate", payload);',
    ],
    [
      'prune dispatch',
      'case "prune":\n\t\t\tawait hmrClient.notifyListeners("vite:beforePrune", payload);',
    ],
  ])('refuses a missing or ambiguous installed %s boundary', (name, site) => {
    expect(() =>
      adaptViteRendererClient(installed.replace(site, ''), clientEntry, clientEntry),
    ).toThrow(`expected one installed ${name}; found 0`)
    expect(() =>
      adaptViteRendererClient(`${installed}\n${site}`, clientEntry, clientEntry),
    ).toThrow(`expected one installed ${name}; found 2`)
  })

  it('does not touch another beforeunload listener in the matched client', () => {
    const independent = '\nwindow.addEventListener("beforeunload", keepDraft);'
    const adapted = adaptViteRendererClient(`${installed}${independent}`, clientEntry, clientEntry)
    expect(adapted?.endsWith(independent)).toBe(true)
  })

  it('is restricted to development serving, before other client transformations', () => {
    const plugin = lifeRendererReloadPlugin()
    expect(plugin.apply).toBe('serve')
    expect(plugin.enforce).toBe('pre')
  })
})

type OwnedModule = Parameters<RendererOwnershipReloads['shouldReload']>[1][number]
const rendererRoot = '/private/life/src/renderer'
const module = (file: string, type = 'js', isSelfAccepting = true): OwnedModule => ({
  file,
  type,
  isSelfAccepting,
  importers: new Set(),
})
const ownershipUpdate = (plugin: ReturnType<typeof lifeRendererReloadPlugin>) => {
  const hook = plugin.hotUpdate
  if (!hook) throw new Error('Missing development ownership hook')
  return typeof hook === 'function' ? hook : hook.handler
}

describe('development recovery module ownership', () => {
  it.each([
    'App.tsx',
    'conversation-source.ts',
    'conversation-persistence.ts',
    'conversation-checkpoint-client.ts',
    'conversation-load-protocol.ts',
    'conversation-drafts.ts',
    'conversation-draft-store.ts',
    'conversation-message-appends.ts',
    'state.ts',
    'studio-history.ts',
    'studio-source.ts',
    'studio-drafts.ts',
    'useCustomizationStudio.ts',
  ])('requests a native coordinated reload for the exact ownership module: %s', (file) => {
    const ownership = new RendererOwnershipReloads(rendererRoot)
    expect(ownership.shouldReload(`${rendererRoot}/${file}`, [])).toBe(true)
  })

  it.each([
    '/another/life/src/renderer/conversation-source.ts',
    `${rendererRoot}/components/conversation-source.ts`,
    `${rendererRoot}/conversation-source.ts.backup`,
    `${rendererRoot}/conversation-scroll.ts`,
    `${rendererRoot}/components/TitleBar.tsx`,
  ])('retains normal HMR for an unrelated exact file: %s', (file) => {
    expect(new RendererOwnershipReloads(rendererRoot).shouldReload(file, [module(file)])).toBe(
      false,
    )
  })

  it('also defers an indirect ownership importer, including cyclic graphs', () => {
    const dependency = module(`${rendererRoot}/attachments.ts`, 'js', false)
    const intermediate = module(`${rendererRoot}/studio-instructions.ts`, 'js', false)
    const owner = module(`${rendererRoot}/studio-history.ts`)
    dependency.importers.add(intermediate)
    intermediate.importers.add(owner)
    owner.importers.add(intermediate)
    expect(
      new RendererOwnershipReloads(rendererRoot).shouldReload(dependency.file!, [dependency]),
    ).toBe(true)
  })

  it('keeps normal component HMR when its protected App importer stays alive', () => {
    const component = module(`${rendererRoot}/components/TitleBar.tsx`)
    const app = module(`${rendererRoot}/App.tsx`)
    component.importers.add(app)
    expect(
      new RendererOwnershipReloads(rendererRoot).shouldReload(component.file!, [component]),
    ).toBe(false)
    component.isSelfAccepting = false
    app.acceptedHmrDeps = new Set([component])
    expect(
      new RendererOwnershipReloads(rendererRoot).shouldReload(component.file!, [component]),
    ).toBe(false)
    app.acceptedHmrDeps = new Set()
    expect(
      new RendererOwnershipReloads(rendererRoot).shouldReload(component.file!, [component]),
    ).toBe(true)
  })

  it('guards runtime React invalidation before a protected parent update reaches the browser', () => {
    const ownership = new RendererOwnershipReloads(rendererRoot)
    const component = module(`${rendererRoot}/components/TitleBar.tsx`)
    const app = module(`${rendererRoot}/App.tsx`)
    component.importers.add(app)
    const modules = new Map([
      ['/components/TitleBar.tsx', component],
      ['/App.tsx', app],
    ])
    const update = (path: string) => ({
      type: 'update' as const,
      updates: [{ type: 'js-update' as const, path, acceptedPath: path, timestamp: 123 }],
    })
    const ordinary = update('/components/TitleBar.tsx')
    expect(guardRendererUpdatePayload(ownership, ordinary, (url) => modules.get(url))).toBe(
      ordinary,
    )
    expect(
      guardRendererUpdatePayload(ownership, update('/App.tsx'), (url) => modules.get(url)),
    ).toEqual({ type: 'full-reload', path: '*', triggeredBy: app.file })
    expect(guardRendererUpdatePayload(ownership, ordinary, (url) => modules.get(url))).toBe(
      ordinary,
    )
    const css = module(`${rendererRoot}/components/thread-output.css`)
    modules.set('/components/thread-output.css', css)
    const style = update('/components/thread-output.css')
    expect(guardRendererUpdatePayload(ownership, style, (url) => modules.get(url))).toEqual({
      ...style,
      updates: [{ ...style.updates[0], lifeRendererStyleUpdate: true }],
    })
    const custom = { type: 'custom' as const, event: 'life-observation', data: { exact: true } }
    expect(guardRendererUpdatePayload(ownership, custom, () => undefined)).toBe(custom)
  })

  it('proves only exact ordinary style updates while document-local clients defer JS', () => {
    const ownership = new RendererOwnershipReloads(rendererRoot)
    ownership.shouldReload(`${rendererRoot}/conversation-source.ts`, [])
    const component = module(`${rendererRoot}/components/TitleBar.tsx`)
    expect(ownership.shouldReload(component.file!, [component])).toBe(false)
    // Imported Vite styles are self-accepting JS wrappers, rather than ?direct CSS nodes.
    const css = module(`${rendererRoot}/components/thread-output.css`, 'js')
    expect(ownership.shouldReload(css.file!, [css])).toBe(false)
    const directCSS = module(`${rendererRoot}/components/thread-output.css`, 'css')
    expect(ownership.shouldReload(directCSS.file!, [directCSS])).toBe(false)
    const cssModule = module(`${rendererRoot}/components/style.module.css`, 'js')
    const update = (module: OwnedModule) => {
      const url = `/styles.css`
      return guardRendererUpdatePayload(
        ownership,
        {
          type: 'update',
          updates: [{ type: 'js-update', path: url, acceptedPath: url, timestamp: 123 }],
        },
        () => module,
      )
    }
    for (const node of [
      cssModule,
      { ...css, id: `${css.file}?inline-foo` },
      { ...css, isSelfAccepting: false },
    ]) {
      expect(update(node)).not.toHaveProperty('updates.0.lifeRendererStyleUpdate')
    }
  })

  it('uses the modern client hook for create, update and delete without HMR timestamps', () => {
    const plugin = lifeRendererReloadPlugin()
    if (typeof plugin.configResolved !== 'function')
      throw new Error('Missing development ownership hooks')
    plugin.configResolved.call({} as never, { root: rendererRoot } as never)
    const hotUpdate = ownershipUpdate(plugin)
    expect(plugin.hotUpdate).toMatchObject({ order: 'post' })
    const send = vi.fn()
    const invalidateModule = vi.fn()
    const environment = { name: 'client', hot: { send }, moduleGraph: { invalidateModule } }
    const owner = module(`${rendererRoot}/conversation-message-appends.ts`)
    for (const type of ['create', 'update', 'delete'] as const) {
      expect(
        hotUpdate.call(
          { environment } as never,
          {
            file: owner.file,
            modules: [owner],
            type,
          } as never,
        ),
      ).toEqual([])
    }
    expect(send).toHaveBeenCalledTimes(3)
    expect(send).toHaveBeenCalledWith({ type: 'full-reload', path: '*', triggeredBy: owner.file })
    expect(invalidateModule).toHaveBeenCalledTimes(2)
    for (const call of invalidateModule.mock.calls) expect(call[3]).toBe(false)
    expect(
      hotUpdate.call(
        { environment: { ...environment, name: 'ssr' } } as never,
        {
          file: owner.file,
          modules: [owner],
          type: 'update',
        } as never,
      ),
    ).toBeUndefined()
    expect(send).toHaveBeenCalledTimes(3)
  })

  it('retains the client unload adapter when ownership guarding is disabled for baseline proof', () => {
    const plugin = lifeRendererReloadPlugin({ guardOwnershipModules: false })
    if (typeof plugin.configResolved !== 'function')
      throw new Error('Missing development ownership hooks')
    plugin.configResolved.call({} as never, { root: rendererRoot } as never)
    const hotUpdate = ownershipUpdate(plugin)
    expect(
      hotUpdate.call(
        { environment: { name: 'client' } } as never,
        {
          file: `${rendererRoot}/conversation-source.ts`,
          modules: [],
          type: 'update',
        } as never,
      ),
    ).toBeUndefined()
    expect(plugin.transform).toBeTypeOf('function')
  })

  it('never admits an old document through another tab HTML request', () => {
    const plugin = lifeRendererReloadPlugin()
    if (typeof plugin.configResolved !== 'function' || typeof plugin.configureServer !== 'function')
      throw new Error('Missing development ownership hooks')
    plugin.configResolved.call({} as never, { root: rendererRoot } as never)
    const installMiddleware = vi.fn()
    plugin.configureServer.call(
      {} as never,
      {
        config: { base: '/' },
        environments: {
          client: { hot: { send: vi.fn() }, moduleGraph: { urlToModuleMap: new Map() } },
        },
        middlewares: { use: installMiddleware },
      } as never,
    )
    expect(installMiddleware).not.toHaveBeenCalled()
  })
})
