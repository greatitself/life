import { createRequire } from 'node:module'
import { dirname, resolve } from 'node:path'
import {
  isCSSRequest,
  normalizePath,
  type EnvironmentModuleNode,
  type HotPayload,
  type Plugin,
} from 'vite'

const attemptedUnload =
  'if (typeof window !== "undefined") window.addEventListener?.("beforeunload", () => {\n\twillUnload = true;\n});'
const actualUnload = attemptedUnload.replace('"beforeunload"', '"pagehide"')

const ownershipModules = [
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
] as const

interface OwnedModule {
  id?: string | null
  file: string | null
  type: string
  isSelfAccepting?: boolean
  importers: Set<OwnedModule>
  acceptedHmrDeps?: ReadonlySet<OwnedModule>
}

/** Module instances own recovery provenance and outstanding native work. */
export class RendererOwnershipReloads {
  private readonly files: Set<string>

  constructor(rendererRoot: string) {
    this.files = new Set(ownershipModules.map((file) => normalizePath(resolve(rendererRoot, file))))
  }

  shouldReload(file: string, modules: readonly OwnedModule[]): boolean {
    const seen = new Set<OwnedModule>()
    const reachesOwner = (module: OwnedModule): boolean => {
      if (seen.has(module)) return false
      seen.add(module)
      if (module.file !== null && this.files.has(normalizePath(module.file))) return true
      // React components and explicitly accepted dependencies do not replace
      // their importers. Follow the same propagation boundaries as Vite.
      if (module.isSelfAccepting) return false
      return [...module.importers].some(
        (importer) => !importer.acceptedHmrDeps?.has(module) && reachesOwner(importer),
      )
    }
    return this.files.has(normalizePath(file)) || modules.some(reachesOwner)
  }
}

function isPlainRendererStyle(module: OwnedModule): boolean {
  return Boolean(
    module.file !== null &&
    isCSSRequest(module.file) &&
    !module.file.includes('.module.') &&
    !/[?&](?:inline|raw|url|html-proxy|inline-css|style-attr|transform-only)\b/.test(
      module.id || '',
    ) &&
    module.isSelfAccepting === true,
  )
}

/** React export invalidation can emit parent updates without a hotUpdate hook. */
export function guardRendererUpdatePayload(
  ownership: RendererOwnershipReloads,
  payload: HotPayload,
  moduleForURL: (url: string) => OwnedModule | undefined,
): HotPayload {
  if (payload.type !== 'update') return payload
  const modules = new Set<OwnedModule>()
  for (const update of payload.updates) {
    for (const url of new Set([update.path, update.acceptedPath])) {
      modules.add(
        moduleForURL(url) || {
          file: null,
          type: update.type === 'css-update' ? 'css' : 'js',
          importers: new Set(),
        },
      )
    }
  }
  if (ownership.shouldReload('', [...modules])) {
    return {
      type: 'full-reload',
      path: '*',
      triggeredBy: [...modules].find((module) => module.file)?.file || undefined,
    }
  }
  let changed = false
  const updates = payload.updates.map((update) => {
    const style = moduleForURL(update.path)
    const accepted = moduleForURL(update.acceptedPath)
    const provenStyle = style && style === accepted && isPlainRendererStyle(style)
    const previous = update as typeof update & { lifeRendererStyleUpdate?: boolean }
    if (provenStyle) {
      changed = true
      return { ...update, lifeRendererStyleUpdate: true }
    }
    if (Object.hasOwn(previous, 'lifeRendererStyleUpdate')) {
      changed = true
      const { lifeRendererStyleUpdate: _unproven, ...plain } = previous
      return plain
    }
    return update
  })
  return changed ? { ...payload, updates } : payload
}

/** Electron may prevent navigation after beforeunload has already fired. */
export function adaptViteRendererClient(
  code: string,
  moduleId: string,
  clientEntry: string,
): string | null {
  if (normalizePath(moduleId.split('?')[0]) !== normalizePath(clientEntry)) return null
  const replaceSite = (from: string, to: string, site: string) => {
    const matches = code.split(from).length - 1
    if (matches !== 1)
      throw new Error(
        `Life's Vite renderer reload adapter expected one installed ${site}; found ${matches}. Review the Vite client before updating this adapter.`,
      )
    code = code.replace(from, to)
  }
  replaceSite(attemptedUnload, actualUnload, 'unload latch')
  replaceSite(
    'let willUnload = false;',
    'let lifeRendererReloadPending = false;\nlet willUnload = false;',
    'document state',
  )
  replaceSite(
    'const pageReload = debounceReload(20);',
    'const lifePageReload = debounceReload(20);\nconst pageReload = () => {\n\tlifeRendererReloadPending = true;\n\tlifePageReload();\n};',
    'scheduled reload',
  )
  replaceSite(
    'if (isFirstUpdate && hasErrorOverlay()) {\n\t\t\t\tlocation.reload();',
    'if (isFirstUpdate && hasErrorOverlay()) {\n\t\t\t\tlifeRendererReloadPending = true;\n\t\t\t\tlocation.reload();',
    'overlay reload',
  )
  replaceSite(
    'await waitForSuccessfulPing(url.href);\n\t\t\t\t\tlocation.reload();',
    'await waitForSuccessfulPing(url.href);\n\t\t\t\t\tlifeRendererReloadPending = true;\n\t\t\t\t\tlocation.reload();',
    'reconnect reload',
  )
  replaceSite(
    'case "update":\n\t\t\tawait hmrClient.notifyListeners("vite:beforeUpdate", payload);',
    'case "update":\n\t\t\tif (lifeRendererReloadPending) {\n\t\t\t\tpayload = { ...payload, updates: payload.updates.filter((update) => update.lifeRendererStyleUpdate === true) };\n\t\t\t\tif (!payload.updates.length) break;\n\t\t\t}\n\t\t\tawait hmrClient.notifyListeners("vite:beforeUpdate", payload);',
    'update dispatch',
  )
  replaceSite(
    'case "prune":\n\t\t\tawait hmrClient.notifyListeners("vite:beforePrune", payload);',
    'case "prune":\n\t\t\tif (lifeRendererReloadPending) break;\n\t\t\tawait hmrClient.notifyListeners("vite:beforePrune", payload);',
    'prune dispatch',
  )
  return code
}

/** Only the served development client changes; package builds use normal Vite. */
export function lifeRendererReloadPlugin(
  options: { guardOwnershipModules?: boolean } = {},
): Plugin {
  const require = createRequire(import.meta.url)
  const clientEntry = resolve(
    dirname(require.resolve('vite/package.json')),
    'dist/client/client.mjs',
  )
  let ownership: RendererOwnershipReloads | undefined
  return {
    name: 'life-renderer-reload',
    apply: 'serve',
    enforce: 'pre',
    configResolved(config) {
      if (options.guardOwnershipModules !== false)
        ownership = new RendererOwnershipReloads(config.root)
    },
    configureServer(server) {
      if (ownership) {
        const environment = server.environments.client
        const send = environment.hot.send.bind(environment.hot)
        environment.hot.send = (payload: HotPayload | string, data?: unknown) => {
          if (typeof payload === 'string') {
            send(payload, data)
            return
          }
          send(
            guardRendererUpdatePayload(ownership!, payload, (url) =>
              environment.moduleGraph.urlToModuleMap.get(url),
            ),
          )
        }
      }
    },
    hotUpdate: {
      order: 'post',
      handler({ file, modules, type }) {
        if (this.environment.name !== 'client' || !ownership?.shouldReload(file, modules)) return
        // Vite has already invalidated update events. Creation/deletion also need
        // fresh server transforms, without assigning HMR timestamps to old owners.
        if (type !== 'update') {
          const seen = new Set<EnvironmentModuleNode>()
          for (const module of modules)
            this.environment.moduleGraph.invalidateModule(module, seen, undefined, false)
        }
        this.environment.hot.send({ type: 'full-reload', path: '*', triggeredBy: file })
        return []
      },
    },
    transform(code, moduleId) {
      return adaptViteRendererClient(code, moduleId, clientEntry)
    },
  }
}
