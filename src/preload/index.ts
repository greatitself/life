import { contextBridge, ipcRenderer } from 'electron'
import type { RelayAPI } from '../shared/types'

const subscribe = <T>(channel: string, callback: (data: T) => void) => {
  const listener = (_: Electron.IpcRendererEvent, data: T) => callback(data)
  ipcRenderer.on(channel, listener)
  return () => ipcRenderer.removeListener(channel, listener)
}
const api: RelayAPI = {
  profiles: {
    list: () => ipcRenderer.invoke('profiles:list'),
    save: (profile) => ipcRenderer.invoke('profiles:save', profile),
    remove: (id) => ipcRenderer.invoke('profiles:remove', id),
  },
  connection: {
    connect: (input) => ipcRenderer.invoke('connection:connect', input),
    disconnect: () => ipcRenderer.invoke('connection:disconnect'),
    state: () => ipcRenderer.invoke('connection:state'),
    trust: (id, accepted) => ipcRenderer.invoke('connection:trust', id, accepted),
  },
  agent: {
    start: (input) => ipcRenderer.invoke('agent:start', input),
    stop: (id) => ipcRenderer.invoke('agent:stop', id),
    respond: (id, requestId, accepted, answers) =>
      ipcRenderer.invoke('agent:respond', id, requestId, accepted, answers),
    models: (provider) => ipcRenderer.invoke('agent:models', provider),
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
    minimize: () => ipcRenderer.send('window:action', 'minimize'),
    maximize: () => ipcRenderer.send('window:action', 'maximize'),
    close: () => ipcRenderer.send('window:action', 'close'),
  },
  onConnection: (callback) => subscribe('connection:state', callback),
  onAgent: (callback) => subscribe('agent:event', callback),
  onHostKey: (callback) => subscribe('connection:host-key', callback),
  onTerminal: (callback) => subscribe('terminal:data', callback),
}
contextBridge.exposeInMainWorld('relay', api)
