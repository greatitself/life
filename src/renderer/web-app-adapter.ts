import type { RelayAPI } from '../shared/types'
import { extensionCapabilities } from '../shared/extension-core'

/** HTTP calls and replayable streaming events replace Electron IPC in the web app. */
export async function createWebApplicationAPI(): Promise<RelayAPI> {
  const base = `${import.meta.env.BASE_URL}api/`
  const response = await fetch(base + 'session', { credentials: 'same-origin' })
  if (!response.ok) throw new Error('The Life web server is unavailable. Start npm run dev:web.')
  const session: { token: string; cursor: number } = await response.json()
  const invoke = async <T>(method: string, ...args: unknown[]): Promise<T> => {
    while (args.length && args[args.length - 1] === undefined) args.pop()
    const response = await fetch(base + 'rpc', {
      method: 'POST',
      credentials: 'same-origin',
      headers: { 'Content-Type': 'application/json', 'X-Life-Session': session.token },
      body: JSON.stringify({ method, args }),
    })
    const result = await response.json()
    if (!response.ok || result.error) throw new Error(result.error || 'The Life request failed.')
    return result.value as T
  }
  const remote =
    <A extends unknown[], R>(method: string) =>
    (...args: A): Promise<R> =>
      invoke<R>(method, ...args)
  const subscribers = new Map<string, Set<(value: unknown) => void>>()
  const pending = new Map<string, unknown[]>()
  const subscribe = <T>(channel: string, callback: (value: T) => void) => {
    const listeners = subscribers.get(channel) || new Set<(value: unknown) => void>()
    subscribers.set(channel, listeners)
    const listener = callback as (value: unknown) => void
    listeners.add(listener)
    const backlog = pending.get(channel)
    if (backlog) {
      pending.delete(channel)
      queueMicrotask(() => {
        for (const value of backlog) if (listeners.has(listener)) listener(value)
      })
    }
    return () => {
      listeners.delete(listener)
    }
  }
  const cursorKey = 'life.web.events.cursor'
  const savedCursor = Number(sessionStorage.getItem(cursorKey))
  let cursor =
    Number.isSafeInteger(savedCursor) && savedCursor > 0 && savedCursor <= session.cursor
      ? savedCursor
      : session.cursor
  const receive = (event: MessageEvent<string>) => {
    const { channel, data } = JSON.parse(event.data)
    const receivedCursor = Number(event.lastEventId)
    if (Number.isSafeInteger(receivedCursor) && receivedCursor >= 0) {
      cursor = receivedCursor
      sessionStorage.setItem(cursorKey, String(cursor))
    }
    const listeners = subscribers.get(channel)
    if (listeners?.size) for (const callback of listeners) callback(data)
    else {
      const backlog = pending.get(channel) || []
      backlog.push(data)
      if (backlog.length > 5000) backlog.shift()
      pending.set(channel, backlog)
    }
  }
  const reload = async () => {
    window.location.reload()
  }
  const openFolder = async (path: string) => {
    await invoke('connection.selectWorkspace', path)
    window.dispatchEvent(
      new CustomEvent('life:extension-ui', {
        detail: { method: 'ui.navigate', args: 'workspace' },
      }),
    )
  }
  const noSubscription = () => () => {}
  const api: RelayAPI = {
    platform: 'web',
    conversations: {
      load: remote('conversations.load'),
      save: (threads) => invoke('conversations.save', threads, cursor),
    },
    hostHistory: {
      list: remote('hostHistory.list'),
      read: remote('hostHistory.read'),
      cancel: remote('hostHistory.cancel'),
    },
    forwarding: {
      get: remote('forwarding.get'),
      onState: (callback) => subscribe('forwarding', callback),
    },
    updates: {
      get: remote('updates.get'),
      check: remote('updates.check'),
      download: async () => {
        throw new Error('Update the Life web server, then refresh this page.')
      },
      install: reload,
      onState: noSubscription,
    },
    sourceCode: {
      get: remote('sourceCode.get'),
      getContext: remote('sourceCode.getContext'),
      apply: remote('sourceCode.apply'),
      setExtensionEnabled: remote('sourceCode.setExtensionEnabled'),
      removeExtension: remote('sourceCode.removeExtension'),
      exportExtension: remote('sourceCode.exportExtension'),
      importExtension: remote('sourceCode.importExtension'),
      updateExtension: remote('sourceCode.updateExtension'),
      rollback: remote('sourceCode.rollback'),
      disable: remote('sourceCode.disable'),
      reload,
      openFolder: async () => openFolder((await api.sourceCode.get()).path),
      ready: remote('sourceCode.ready'),
      reportError: remote('sourceCode.reportError'),
      onState: (callback) => subscribe('source', callback),
    },
    extensionSharing: {
      publish: remote('extensionSharing.publish'),
      inspectPublic: remote('extensionSharing.inspectPublic'),
      openPublic: async (link) => {
        window.open(link, '_blank', 'noopener,noreferrer')
      },
    },
    extensions: {
      capabilities: extensionCapabilities,
      get: remote('extensions.get'),
      apply: remote('extensions.apply'),
      enable: remote('extensions.enable'),
      remove: remote('extensions.remove'),
      rollback: remote('extensions.rollback'),
      call: remote('extensions.call'),
      invoke: remote('extensions.invoke'),
      openFolder: async () => openFolder((await api.extensions.get()).path),
      recover: remote('extensions.recover'),
      onState: (callback) => subscribe('extensions', callback),
      onEvent: (callback) => subscribe('extension-event', callback),
      onRecovery: (callback) => subscribe('extension-recovery', callback),
    },
    customization: {
      get: remote('customization.get'),
      apply: remote('customization.apply'),
      undo: remote('customization.undo'),
      reset: remote('customization.reset'),
      reload: remote('customization.reload'),
      onChange: (callback) => subscribe('customization', callback),
    },
    sshConfig: { list: remote('sshConfig.list'), resolve: remote('sshConfig.resolve') },
    profiles: {
      list: remote('profiles.list'),
      save: remote('profiles.save'),
      remove: remote('profiles.remove'),
    },
    connection: {
      state: remote('connection.state'),
      connect: remote('connection.connect'),
      execute: remote('connection.execute'),
      selectWorkspace: remote('connection.selectWorkspace'),
      listDirectories: remote('connection.listDirectories'),
      disconnect: remote('connection.disconnect'),
      trust: remote('connection.trust'),
    },
    agent: {
      start: remote('agent.start'),
      steer: remote('agent.steer'),
      configure: remote('agent.configure'),
      stop: remote('agent.stop'),
      dispose: remote('agent.dispose'),
      respond: remote('agent.respond'),
      models: remote('agent.models'),
    },
    files: { list: remote('files.list'), read: remote('files.read'), git: remote('files.git') },
    terminal: {
      open: remote('terminal.open'),
      close: remote('terminal.close'),
      write: (data) => {
        void invoke('terminal.write', data).catch(() => {})
      },
      resize: (cols, rows) => {
        void invoke('terminal.resize', cols, rows).catch(() => {})
      },
    },
    chooseKey: async () => window.prompt('Enter the private key path on the Life server:'),
    window: {
      initialRecovery: async () => false,
      minimize: () => {},
      maximize: () => {},
      close: () => {},
      restart: reload,
      state: async () => false,
      onState: noSubscription,
    },
    researchDocuments: {
      register: remote('researchDocuments.register'),
      revoke: remote('researchDocuments.revoke'),
    },
    onConnection: (callback) => subscribe('connection', callback),
    onAgent: (callback) => subscribe('agent', callback),
    onHostKey: (callback) => subscribe('host-key', callback),
    onTerminal: (callback) => subscribe('terminal', callback),
  }
  const cachedHistory = localStorage.getItem('relay.threads.v1')
  if (cachedHistory) {
    let threads: { id: string; profileId: string }[] = []
    try {
      const parsed = JSON.parse(cachedHistory)
      if (Array.isArray(parsed))
        threads = parsed.filter((thread) => thread && typeof thread === 'object')
    } catch {
      // The shared history reader also tolerates an invalid browser cache.
    }
    const preview = threads.filter((thread) => thread.profileId === 'life-browser-preview')
    if (preview.length) {
      localStorage.setItem('life.web.preview.threads.v1', JSON.stringify(preview))
      const real = threads.filter((thread) => thread.profileId !== 'life-browser-preview')
      if (real.length) localStorage.setItem('relay.threads.v1', JSON.stringify(real))
      else localStorage.removeItem('relay.threads.v1')
      if (preview.some((thread) => thread.id === localStorage.getItem('life.active-thread.v1')))
        localStorage.removeItem('life.active-thread.v1')
    }
  }
  if (!localStorage.getItem('relay.threads.v1')) {
    const saved = await invoke<{ threads: unknown[]; cursor: number }>('conversations.snapshot')
    cursor = saved.cursor
    if (saved.threads.length)
      localStorage.setItem('relay.threads.v1', JSON.stringify(saved.threads))
  }
  sessionStorage.setItem(cursorKey, String(cursor))
  const stream = new EventSource(base + 'events?after=' + cursor)
  stream.onmessage = receive
  return api
}
