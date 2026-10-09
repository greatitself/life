import type { RelayAPI, ConnectionProfile, ConnectionState } from '../shared/types'
import {
  defaultLifeConfig,
  mergeLifeConfig,
  parseLifeConfig,
  type LifeConfig,
  type LifeConfigState,
} from '../shared/customization'
import type { LifeSourceSnapshot } from '../shared/source-code'
import { builtinExtensionCatalog } from '../shared/builtin-extensions'
import { LIFE_VERSION } from '../shared/version'
import { fallbackModelCatalog } from './model-catalog'
import { WEB_PREVIEW_HOME, WEB_PREVIEW_PROFILE_ID } from './web-research'
import { webResearchDocuments } from './web-research-documents'

const desktopRequired =
  'This is the Life browser preview. Use the desktop app for SSH connections, Codex/Claude runs, local source builds, and public extension publishing.'
const unavailable = async (): Promise<never> => {
  throw new Error(desktopRequired)
}
const noSubscription = () => () => {}
function eventBus<T>() {
  const subscribers = new Set<(value: T) => void>()
  return {
    subscribe: (callback: (value: T) => void) => {
      subscribers.add(callback)
      return () => {
        subscribers.delete(callback)
      }
    },
    emit: (value: T) => {
      for (const callback of subscribers) callback(structuredClone(value))
    },
  }
}
const profile: ConnectionProfile = {
  id: WEB_PREVIEW_PROFILE_ID,
  name: 'Browser preview · local data',
  host: 'browser.local',
  port: 22,
  username: 'browser',
  auth: 'agent',
  privateKeyPath: '',
  workspace: WEB_PREVIEW_HOME + '/projects/life-example',
}
function readStored<T>(key: string, fallback: T): T {
  try {
    return JSON.parse(localStorage.getItem(key) || 'null') || fallback
  } catch {
    return fallback
  }
}

/** Browser-only capability adapter. Supported local actions are real; native actions never simulate agent output. */
export function createWebPreviewAPI(): RelayAPI {
  let connection: ConnectionState = {
    status: 'connected',
    profile,
    home: WEB_PREVIEW_HOME,
    workspace: profile.workspace,
  }
  const connectionEvents = eventBus<ConnectionState>()
  const configEvents = eventBus<LifeConfigState>()
  const sourceEvents = eventBus<LifeSourceSnapshot>()
  let config: LifeConfig
  try {
    config = parseLifeConfig(readStored('life.config.v1', defaultLifeConfig))
  } catch {
    config = structuredClone(defaultLifeConfig)
  }
  let configRevision = 0
  const configHistory: LifeConfig[] = []
  const configState = (): LifeConfigState => ({
    config: structuredClone(config),
    revision: configRevision,
    canUndo: configHistory.length > 0,
    path: 'Browser local storage',
  })
  const acceptConfig = (next: LifeConfig) => {
    config = next
    configRevision++
    localStorage.setItem('life.config.v1', JSON.stringify(config))
    const state = configState()
    configEvents.emit(state)
    return state
  }
  const builtinChoices = readStored<Record<string, { enabled: boolean; deleted?: boolean }>>(
    'life.web.builtin-choices.v1',
    {},
  )
  let builtInRevision = 0
  const sourceState = (): LifeSourceSnapshot => ({
    revision: 0,
    builtInRevision,
    enabled: false,
    canRollback: false,
    recovered: false,
    path: 'Browser preview · native source compilation requires desktop',
    extensions: builtinExtensionCatalog.map((entry) => ({
      id: entry.id,
      name: entry.name,
      description: entry.description,
      version: entry.version,
      files: entry.files,
      dependencies: {},
      createdAt: entry.createdAt,
      updatedAt: entry.updatedAt,
      enabled: builtinChoices[entry.id]?.enabled !== false && !builtinChoices[entry.id]?.deleted,
      builtIn: true as const,
      originalId: entry.originalId,
      features: entry.features,
      effect: entry.effect,
      ...(builtinChoices[entry.id]?.deleted ? { deleted: true as const } : {}),
    })),
  })
  const changeBuiltin = (id: string, enabled: boolean, deleted = false) => {
    if (!builtinExtensionCatalog.some((entry) => entry.id === id))
      throw new Error(
        'This preview only supports its built-in feature controls. Custom source extensions require the desktop app.',
      )
    builtinChoices[id] = { enabled: enabled && !deleted, ...(deleted ? { deleted: true } : {}) }
    localStorage.setItem('life.web.builtin-choices.v1', JSON.stringify(builtinChoices))
    builtInRevision++
    const state = sourceState()
    sourceEvents.emit(state)
    return state
  }
  const extensionState = {
    extensions: [],
    revision: 0,
    path: 'Browser preview',
    errors: {},
    canRollback: [],
    recovered: false,
  }
  const updateState = {
    status: 'unsupported' as const,
    currentVersion: LIFE_VERSION,
    message:
      'Web previews update when this page is refreshed. Install Life desktop for native automatic updates.',
  }
  const browserAPI: RelayAPI = {
    platform: 'web',
    forwarding: {
      get: async () => ({ enabled: config.autoPortForward, active: false, ports: [] }),
      onState: noSubscription,
    },
    updates: {
      get: async () => updateState,
      check: async () => updateState,
      download: unavailable,
      install: unavailable,
      onState: noSubscription,
    },
    sourceCode: {
      get: async () => sourceState(),
      getContext: async () => ({
        extensions: sourceState().extensions,
        revision: 0,
        paths: [],
        files: [],
        dependencies: {},
        snapshot: sourceState(),
      }),
      apply: unavailable,
      setExtensionEnabled: async (id, enabled) => changeBuiltin(id, enabled),
      removeExtension: async (id) => changeBuiltin(id, false, true),
      exportExtension: unavailable,
      importExtension: unavailable,
      updateExtension: unavailable,
      rollback: unavailable,
      disable: async () => sourceState(),
      reload: async () => {
        window.location.reload()
      },
      openFolder: unavailable,
      ready: async () => {},
      reportError: async () => {},
      onState: sourceEvents.subscribe,
    },
    extensionSharing: { publish: unavailable, inspectPublic: unavailable, openPublic: unavailable },
    extensions: {
      capabilities: [],
      get: async () => extensionState,
      apply: unavailable,
      enable: unavailable,
      remove: unavailable,
      rollback: unavailable,
      call: unavailable,
      invoke: unavailable,
      openFolder: unavailable,
      recover: async () => {},
      onState: noSubscription,
      onEvent: noSubscription,
      onRecovery: noSubscription,
    },
    customization: {
      get: async () => configState(),
      apply: async (patch) => {
        configHistory.push(structuredClone(config))
        return acceptConfig(mergeLifeConfig(config, patch))
      },
      undo: async () => {
        const previous = configHistory.pop()
        return previous ? acceptConfig(previous) : configState()
      },
      reset: async () => {
        configHistory.push(structuredClone(config))
        return acceptConfig(structuredClone(defaultLifeConfig))
      },
      reload: async () => configState(),
      onChange: configEvents.subscribe,
    },
    sshConfig: {
      list: async () => ({ path: 'Desktop SSH config is unavailable in a browser', hosts: [] }),
      resolve: unavailable,
    },
    profiles: {
      list: async () => [structuredClone(profile)],
      save: unavailable,
      remove: unavailable,
    },
    connection: {
      state: async () => structuredClone(connection),
      connect: unavailable,
      execute: unavailable,
      selectWorkspace: async (workspace) => {
        if (
          !workspace.startsWith(WEB_PREVIEW_HOME + '/projects/') ||
          /(?:^|\/)\.\.(?:\/|$)|\0/.test(workspace)
        )
          throw new Error('The browser preview can select its local example projects only.')
        connection = { ...connection, workspace }
        connectionEvents.emit(connection)
        return structuredClone(connection)
      },
      listDirectories: async (path) => ({
        path: path || WEB_PREVIEW_HOME + '/projects',
        parent: WEB_PREVIEW_HOME,
        entries: [
          { name: 'life-example', path: profile.workspace },
          { name: 'another-example', path: WEB_PREVIEW_HOME + '/projects/another-example' },
        ],
      }),
      disconnect: async () => {
        connection = { ...connection, status: 'disconnected' }
        connectionEvents.emit(connection)
      },
      trust: unavailable,
    },
    agent: {
      start: unavailable,
      steer: unavailable,
      configure: unavailable,
      stop: async () => {},
      dispose: async () => {},
      respond: unavailable,
      models: async (provider) => fallbackModelCatalog(provider),
    },
    files: {
      list: async () => [],
      read: unavailable,
      git: async () => ({ branch: '', diff: '', status: '' }),
    },
    terminal: { open: unavailable, write: () => {}, resize: () => {}, close: async () => {} },
    chooseKey: unavailable,
    window: {
      initialRecovery: async () => false,
      minimize: () => {},
      maximize: () => {},
      close: () => {},
      restart: async () => {
        window.location.reload()
      },
      state: async () => false,
      onState: noSubscription,
    },
    researchDocuments: webResearchDocuments,
    onConnection: connectionEvents.subscribe,
    onAgent: noSubscription,
    onHostKey: noSubscription,
    onTerminal: noSubscription,
  }
  return browserAPI
}
