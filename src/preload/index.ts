import { contextBridge, ipcRenderer } from 'electron'
import type { RelayAPI } from '../shared/types'
import { extensionCapabilities } from '../shared/extension-core'

const subscribe = <T>(channel: string, callback: (data: T) => void) => {
  const listener = (_: Electron.IpcRendererEvent, data: T) => callback(data)
  ipcRenderer.on(channel, listener)
  return () => ipcRenderer.removeListener(channel, listener)
}
const api: RelayAPI = {
  platform: process.platform,
  conversations: {
    load: () => ipcRenderer.invoke('conversations:load'),
    save: (threads, savedAt) => ipcRenderer.invoke('conversations:save', threads, savedAt),
  },
  hostHistory: {
    list: (input) => ipcRenderer.invoke('agent-history:list', input),
    read: (input) => ipcRenderer.invoke('agent-history:read', input),
    cancel: (id) => ipcRenderer.invoke('agent-history:cancel', id),
  },
  researchDocuments: {
    register: (html) => ipcRenderer.invoke('research-documents:register', html),
    revoke: (id) => ipcRenderer.invoke('research-documents:revoke', id),
  },
  forwarding: {
    get: () => ipcRenderer.invoke('forwarding:get'),
    onState: (callback) => subscribe('forwarding:state', callback),
  },
  extensions: {
    capabilities: extensionCapabilities,
    get: () => ipcRenderer.invoke('extensions:get'),
    apply: (manifest) => ipcRenderer.invoke('extensions:apply', manifest),
    enable: (id, enabled) => ipcRenderer.invoke('extensions:enable', id, enabled),
    remove: (id) => ipcRenderer.invoke('extensions:remove', id),
    rollback: (id) => ipcRenderer.invoke('extensions:rollback', id),
    call: (id, method, args) => ipcRenderer.invoke('extensions:call', id, method, args),
    invoke: (method, args) => ipcRenderer.invoke('extensions:invoke', method, args),
    openFolder: () => ipcRenderer.invoke('extensions:open-folder'),
    recover: () => ipcRenderer.invoke('extensions:recover'),
    onState: (callback) => subscribe('extensions:state', callback),
    onEvent: (callback) => subscribe('extensions:event', callback),
    onRecovery: (callback) => subscribe('extensions:recover', callback),
  },
  updates: {
    get: () => ipcRenderer.invoke('updates:get'),
    check: () => ipcRenderer.invoke('updates:check'),
    download: () => ipcRenderer.invoke('updates:download'),
    install: () => ipcRenderer.invoke('updates:install'),
    onState: (callback) => subscribe('updates:state', callback),
  },
  providerUpdates: {
    get: () => ipcRenderer.invoke('provider-updates:get'),
    check: () => ipcRenderer.invoke('provider-updates:check'),
    onState: (callback) => subscribe('provider-updates:state', callback),
  },
  sourceCode: {
    get: () => ipcRenderer.invoke('source-code:get'),
    getContext: (request) => ipcRenderer.invoke('source-code:context', request),
    apply: (patch) => ipcRenderer.invoke('source-code:apply', patch),
    setExtensionEnabled: (id, enabled) =>
      ipcRenderer.invoke('source-code:set-extension-enabled', id, enabled),
    removeExtension: (id) => ipcRenderer.invoke('source-code:remove-extension', id),
    exportExtension: (id) => ipcRenderer.invoke('source-code:export-extension', id),
    importExtension: (bundle) => ipcRenderer.invoke('source-code:import-extension', bundle),
    updateExtension: (bundle) => ipcRenderer.invoke('source-code:update-extension', bundle),
    rollback: () => ipcRenderer.invoke('source-code:rollback'),
    disable: () => ipcRenderer.invoke('source-code:disable'),
    reload: () => ipcRenderer.invoke('source-code:reload'),
    openFolder: () => ipcRenderer.invoke('source-code:open-folder'),
    ready: (revision) => ipcRenderer.invoke('source-code:ready', revision),
    reportError: (revision, message) => ipcRenderer.invoke('source-code:error', revision, message),
    onState: (callback) => subscribe('source-code:state', callback),
  },
  extensionSharing: {
    publish: (input) => ipcRenderer.invoke('extension-sharing:publish', input),
    inspectPublic: (link) => ipcRenderer.invoke('extension-sharing:inspect-public', link),
    openPublic: (link) => ipcRenderer.invoke('extension-sharing:open-public', link),
  },
  customization: {
    get: () => ipcRenderer.invoke('customization:get'),
    apply: (patch) => ipcRenderer.invoke('customization:apply', patch),
    undo: () => ipcRenderer.invoke('customization:undo'),
    reset: () => ipcRenderer.invoke('customization:reset'),
    reload: () => ipcRenderer.invoke('customization:reload'),
    onChange: (callback) => subscribe('customization:state', callback),
  },
  sshConfig: {
    list: (path) => ipcRenderer.invoke('ssh-config:list', path),
    resolve: (alias, path) => ipcRenderer.invoke('ssh-config:resolve', alias, path),
  },
  profiles: {
    list: () => ipcRenderer.invoke('profiles:list'),
    save: (profile) => ipcRenderer.invoke('profiles:save', profile),
    remove: (id) => ipcRenderer.invoke('profiles:remove', id),
  },
  connection: {
    connect: (input) => ipcRenderer.invoke('connection:connect', input),
    selectWorkspace: (path) => ipcRenderer.invoke('connection:select-workspace', path),
    listDirectories: (path) => ipcRenderer.invoke('connection:list-directories', path),
    disconnect: () => ipcRenderer.invoke('connection:disconnect'),
    state: () => ipcRenderer.invoke('connection:state'),
    execute: (input) => ipcRenderer.invoke('connection:execute', input),
    trust: (id, accepted) => ipcRenderer.invoke('connection:trust', id, accepted),
  },
  agent: {
    start: (input) => ipcRenderer.invoke('agent:start', input),
    steer: (input) => ipcRenderer.invoke('agent:steer', input),
    configure: (input) => ipcRenderer.invoke('agent:configure', input),
    stop: (id) => ipcRenderer.invoke('agent:stop', id),
    dispose: (id) => ipcRenderer.invoke('agent:dispose', id),
    respond: (id, requestId, accepted, answers) =>
      ipcRenderer.invoke('agent:respond', id, requestId, accepted, answers),
    models: (provider) => ipcRenderer.invoke('agent:models', provider),
    usage: (provider) => ipcRenderer.invoke('agent:usage', provider),
  },
  files: {
    list: (path) => ipcRenderer.invoke('files:list', path),
    read: (path) => ipcRenderer.invoke('files:read', path),
    git: () => ipcRenderer.invoke('files:git'),
  },
  terminal: {
    open: () => ipcRenderer.invoke('terminal:open'),
    close: () => ipcRenderer.invoke('terminal:close'),
    write: (data) => ipcRenderer.send('terminal:write', data),
    resize: (cols, rows) => ipcRenderer.send('terminal:resize', cols, rows),
  },
  chooseKey: () => ipcRenderer.invoke('choose-key'),
  window: {
    initialRecovery: () => ipcRenderer.invoke('window:initial-recovery'),
    minimize: () => ipcRenderer.send('window:action', 'minimize'),
    maximize: () => ipcRenderer.send('window:action', 'maximize'),
    close: () => ipcRenderer.send('window:action', 'close'),
    restart: () => ipcRenderer.invoke('window:restart'),
    state: () => ipcRenderer.invoke('window:state'),
    onState: (callback) => subscribe('window:state', callback),
  },
  onConnection: (callback) => subscribe('connection:state', callback),
  onAgent: (callback) => subscribe('agent:event', callback),
  onHostKey: (callback) => subscribe('connection:host-key', callback),
  onTerminal: (callback) => subscribe('terminal:data', callback),
}
contextBridge.exposeInMainWorld('relay', api)
