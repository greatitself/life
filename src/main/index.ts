import { app, BrowserWindow, ipcMain, dialog, shell, nativeTheme, protocol } from 'electron'
import { join } from 'node:path'
import { readFile } from 'node:fs/promises'
import { Store } from './store'
import { SSHConnection } from './ssh'
import { Agents } from './agents'
import {
  connectSchema,
  profileSchema,
  remoteDirectorySchema,
  startSchema,
  connectionExecutionSchema,
} from '../shared/validation'
import { z } from 'zod'
import { CustomizationStore } from './customization'
import { listSSHConfig, resolveSSHConfig } from './ssh-config'
import { UpdatesService } from './updater'
import { ExtensionStore } from './extensions'
import {
  extensionIdSchema,
  extensionMethodSchema,
  parseExtensionPayload,
} from '../shared/extensions'
import { extensionCoreArguments } from '../shared/extension-core'
import { buildExtensionDocument, extensionDocumentCSP } from '../shared/extension-document'
import { SourceCodeStore } from './source-code'
import { executeConnectionCommand } from './connection-execution'
import { parseLifeSourcePatch, parseLifeSourceRead } from '../shared/source-code'

app.setName('Life')
protocol.registerSchemesAsPrivileged([
  { scheme: 'life-extension', privileges: { standard: true, secure: true, supportFetchAPI: true } },
  {
    scheme: 'life-code',
    privileges: { standard: true, secure: true, supportFetchAPI: true, corsEnabled: true },
  },
])

let window: BrowserWindow | null = null
let ssh: SSHConnection
let customization: CustomizationStore
let updates: UpdatesService
let extensions: ExtensionStore
let sourceCode: SourceCodeStore
let sourceStartupTimer: ReturnType<typeof setTimeout> | undefined
let sourceReloadTimer: ReturnType<typeof setTimeout> | undefined
let quitting = false
let recovering = false
const ownsInstance = app.requestSingleInstanceLock()
if (!ownsInstance) app.quit()
app.on('second-instance', () => {
  if (window?.isMinimized()) window.restore()
  window?.show()
  window?.focus()
})
async function recoverExtensions() {
  if (recovering || !extensions) return
  recovering = true
  try {
    const owner = window
    if (owner && !owner.isDestroyed()) {
      const mainFrame = owner.webContents.mainFrame
      const frameProcesses = new Set<number>()
      for (const frame of mainFrame.framesInSubtree) {
        try {
          if (
            frame !== mainFrame &&
            frame.url.startsWith('life-extension:') &&
            frame.osProcessId > 0 &&
            frame.osProcessId !== process.pid
          )
            frameProcesses.add(frame.osProcessId)
        } catch {
          /* A frame can disappear during emergency recovery. */
        }
      }
      // Cross-process iframe loops survive a parent renderer crash. Terminate only
      // the renderer processes belonging to this window's extension frames.
      for (const pid of frameProcesses) {
        try {
          process.kill(pid, 'SIGKILL')
        } catch {
          /* Already exited. */
        }
      }
    }
    ssh?.disconnect()
    clearTimeout(sourceStartupTimer)
    await sourceCode?.disable()
    await Promise.all(
      extensions
        .list()
        .filter((extension) => extension.enabled)
        .map((extension) => extensions.enable(extension.id, false)),
    )
    // Main-process recovery remains usable even when generated UI is stuck in a CPU loop.
    if (owner && !owner.isDestroyed()) {
      createWindow()
      window!.webContents.once('did-finish-load', () =>
        setTimeout(() => send('extensions:recover', true), 100),
      )
      owner.destroy()
    }
  } finally {
    recovering = false
  }
}
const send = (channel: string, data: unknown) => {
  if (window && !window.isDestroyed()) window.webContents.send(channel, data)
}
async function init() {
  const store = new Store(app.getPath('userData'))
  await store.init()
  customization = new CustomizationStore(app.getPath('userData'), (state) => {
    nativeTheme.themeSource = state.config.theme
    ssh?.forwarding.setEnabled(state.config.autoPortForward)
    window?.setBackgroundColor(state.config.theme === 'dark' ? '#161616' : '#ffffff')
    send('customization:state', state)
  })
  await customization.init()
  updates = new UpdatesService((state) => send('updates:state', state))
  ssh = new SSHConnection(store)
  ssh.forwarding.setEnabled(customization.get().config.autoPortForward)
  const agents = new Agents(ssh, (event) => send('agent:event', event))
  ssh.on('state', (state) => send('connection:state', state))
  ssh.on('host-key', (request) => send('connection:host-key', request))
  ssh.on('terminal', (data) => send('terminal:data', data))
  ssh.on('forwarding-state', (state) => send('forwarding:state', state))
  const operations = new Map<string, (...args: unknown[]) => unknown>()
  let localApplies = 0
  const applyLocal = async <T>(operation: () => Promise<T>): Promise<T> => {
    localApplies++
    try {
      return await operation()
    } finally {
      localApplies--
    }
  }
  const handle = (name: string, fn: (...args: unknown[]) => unknown) => {
    operations.set(name, fn)
    ipcMain.handle(name, (event, ...args: unknown[]) => {
      if (
        !window ||
        event.sender !== window.webContents ||
        event.senderFrame !== window.webContents.mainFrame
      )
        throw new Error('Untrusted IPC sender')
      return fn(...args)
    })
  }
  const invokeCore = async (method: string, payload: unknown) => {
    const args = extensionCoreArguments(method, parseExtensionPayload(payload))
    if (method === 'window.minimize') {
      window?.minimize()
      return null
    }
    if (method === 'window.maximize') {
      window?.isMaximized() ? window.unmaximize() : window?.maximize()
      return null
    }
    if (method === 'window.close') {
      window?.close()
      return null
    }
    if (method === 'terminal.write') {
      ssh.writeTerminal(z.string().max(100000).parse(args[0]))
      return null
    }
    if (method === 'terminal.resize') {
      ssh.resizeTerminal(
        z.number().int().min(1).max(999).parse(args[0]),
        z.number().int().min(1).max(999).parse(args[1]),
      )
      return null
    }
    const channel =
      method === 'app.chooseKey'
        ? 'choose-key'
        : method === 'connection.selectWorkspace'
          ? 'connection:select-workspace'
          : method === 'connection.listDirectories'
            ? 'connection:list-directories'
            : method.startsWith('sshConfig.')
              ? method.replace('sshConfig.', 'ssh-config:')
              : method.startsWith('sourceCode.')
                ? (
                    {
                      'sourceCode.getContext': 'source-code:context',
                      'sourceCode.openFolder': 'source-code:open-folder',
                    } as Record<string, string>
                  )[method] || method.replace('sourceCode.', 'source-code:')
                : method.replace('.', ':')
    const operation = operations.get(channel)
    if (!operation) throw new Error(`This Life method is unavailable: ${method}`)
    const value = await operation(...args)
    // Built-in snapshots may include optional undefined fields; worker RPC is strict JSON.
    return JSON.parse(JSON.stringify(value === undefined ? null : value))
  }
  extensions = new ExtensionStore(
    join(app.getPath('userData'), 'extensions'),
    (state) => send('extensions:state', state),
    (_id, method, args) => invokeCore(method, args),
    (id, event, data) => send('extensions:event', { id, type: 'event', event, data }),
  )
  sourceCode = new SourceCodeStore({
    sourceDir: app.isPackaged ? join(process.resourcesPath, 'life-source') : app.getAppPath(),
    nodeModulesDir: app.isPackaged
      ? join(process.resourcesPath, 'app.asar.unpacked/node_modules')
      : join(app.getAppPath(), 'node_modules'),
    directory: join(app.getPath('userData'), 'source-code'),
    onUpdate: (state) => send('source-code:state', state),
  })
  await sourceCode.init()
  let sourceReload: Promise<void> | undefined
  const reloadSource = () => {
    if (sourceReload) return sourceReload
    const owner = window
    sourceReload = new Promise<void>((resolve) => {
      const reloadWhenIdle = () => {
        if (!owner || owner !== window || owner.isDestroyed() || quitting) {
          sourceReload = undefined
          resolve()
          return
        }
        // Keep the current renderer receiving other threads' streaming events.
        // Reloading once their sessions settle preserves those conversations.
        if (agents.hasRunningSessions() || localApplies) {
          sourceReloadTimer = setTimeout(reloadWhenIdle, 200)
          return
        }
        sourceReload = undefined
        resolve()
        setTimeout(() => {
          if (owner !== window || owner.isDestroyed() || quitting) return
          if (agents.hasRunningSessions() || localApplies) void reloadSource()
          else owner.webContents.reload()
        }, 100)
      }
      sourceReloadTimer = setTimeout(reloadWhenIdle, 100)
    })
    return sourceReload
  }
  const sourceFailure = async (revision: number, reason: string) => {
    if (!sourceCode.get().enabled || sourceCode.get().active?.revision !== revision) return
    clearTimeout(sourceStartupTimer)
    await sourceCode.disable(reason)
    const owner = window
    if (owner && !owner.isDestroyed()) {
      createWindow()
      owner.destroy()
    }
  }
  handle('source-code:get', () => sourceCode.get())
  handle('source-code:context', (request) =>
    sourceCode.getContext(request === undefined ? undefined : parseLifeSourceRead(request)),
  )
  handle('source-code:apply', (patch) =>
    applyLocal(() => sourceCode.apply(parseLifeSourcePatch(patch))),
  )
  handle('source-code:rollback', () => applyLocal(() => sourceCode.rollback()))
  handle('source-code:disable', () => sourceCode.disable())
  handle('source-code:reload', reloadSource)
  handle('source-code:ready', (value) => {
    const revision = z.number().int().min(0).parse(value)
    if (sourceCode.get().active?.revision === revision) clearTimeout(sourceStartupTimer)
  })
  handle('source-code:error', (value, reason) =>
    sourceFailure(z.number().int().min(0).parse(value), z.string().max(10000).parse(reason)),
  )
  handle('source-code:open-folder', async () => {
    const error = await shell.openPath(sourceCode.get().path)
    if (error) throw new Error(error)
  })
  handle('extensions:get', () => extensions.get())
  handle('extensions:apply', (manifest) => applyLocal(() => extensions.apply(manifest)))
  handle('extensions:enable', (id, enabled) =>
    extensions.enable(extensionIdSchema.parse(id), z.boolean().parse(enabled)),
  )
  handle('extensions:remove', (id) => extensions.remove(extensionIdSchema.parse(id)))
  handle('extensions:rollback', (id) => extensions.rollback(extensionIdSchema.parse(id)))
  handle('extensions:call', (id, method, args) =>
    extensions.call(
      extensionIdSchema.parse(id),
      extensionMethodSchema.parse(method),
      parseExtensionPayload(args),
    ),
  )
  handle('extensions:invoke', (method, args) =>
    invokeCore(extensionMethodSchema.parse(method), args),
  )
  handle('extensions:open-folder', async () => {
    const error = await shell.openPath(extensions.path)
    if (error) throw new Error(error)
  })
  handle('extensions:recover', () => {
    void recoverExtensions().catch((error) =>
      dialog.showErrorBox('Life recovery failed', String(error)),
    )
  })
  handle('profiles:list', () => store.list())
  handle('app:info', () => ({
    name: 'Life',
    version: app.getVersion(),
    platform: process.platform,
    dataDirectory: app.getPath('userData'),
  }))
  handle('app:openExternal', async (url) => {
    const destination = z.url().max(4096).parse(url)
    if (!['https:', 'http:'].includes(new URL(destination).protocol))
      throw new Error('Use an HTTP or HTTPS link')
    await shell.openExternal(destination)
  })
  handle('window:configure', (value) => {
    const options = z
      .object({
        title: z.string().max(200).optional(),
        width: z.number().int().min(760).max(8000).optional(),
        height: z.number().int().min(580).max(8000).optional(),
        alwaysOnTop: z.boolean().optional(),
        fullscreen: z.boolean().optional(),
        opacity: z.number().min(0.2).max(1).optional(),
      })
      .strict()
      .parse(value)
    if (!window) throw new Error('Life window is unavailable')
    if (options.title !== undefined) window.setTitle(options.title)
    if (options.width !== undefined || options.height !== undefined) {
      const [width, height] = window.getSize()
      window.setSize(options.width ?? width, options.height ?? height)
    }
    if (options.alwaysOnTop !== undefined) window.setAlwaysOnTop(options.alwaysOnTop)
    if (options.fullscreen !== undefined) window.setFullScreen(options.fullscreen)
    if (options.opacity !== undefined) window.setOpacity(options.opacity)
    return null
  })
  handle('updates:get', () => updates.getState())
  handle('updates:check', () => updates.check())
  handle('updates:download', () => updates.download())
  handle('updates:install', () => updates.install())
  handle('customization:get', () => customization.get())
  handle('customization:apply', (patch) => customization.apply(patch))
  handle('customization:undo', () => customization.undo())
  handle('customization:reset', () => customization.reset())
  handle('customization:reload', () => customization.reload())
  handle('ssh-config:list', (path) => listSSHConfig(z.string().max(4096).optional().parse(path)))
  handle('ssh-config:resolve', (alias, path) =>
    resolveSSHConfig(z.string().max(255).parse(alias), z.string().max(4096).optional().parse(path)),
  )
  handle('window:state', () => window?.isMaximized() || false)
  handle('profiles:save', (p) => store.save(profileSchema.parse(p)))
  handle('profiles:remove', (id) => store.remove(z.string().parse(id)))
  handle('connection:connect', (input) => ssh.connect(connectSchema.parse(input)))
  handle('connection:select-workspace', (path) =>
    ssh.selectWorkspace(remoteDirectorySchema.parse(path)),
  )
  handle('connection:list-directories', (path) =>
    ssh.listDirectories(remoteDirectorySchema.optional().parse(path)),
  )
  handle('connection:disconnect', () => ssh.disconnect())
  handle('connection:state', () => ssh.state)
  handle('connection:execute', (input) =>
    executeConnectionCommand(ssh, connectionExecutionSchema.parse(input)),
  )
  handle('forwarding:get', () => ssh.forwarding.getState())
  handle('connection:trust', (id, accepted) =>
    ssh.trust(z.string().parse(id), z.boolean().parse(accepted)),
  )
  handle('agent:start', (input) => agents.start(startSchema.parse(input)))
  handle('agent:stop', (id) => agents.stop(z.string().parse(id)))
  handle('agent:dispose', (id) => agents.dispose(z.string().parse(id)))
  handle('agent:respond', (id, requestId, accepted, answers) =>
    agents.respond(
      z.string().parse(id),
      z.string().parse(requestId),
      z.boolean().parse(accepted),
      z.record(z.string(), z.array(z.string())).optional().parse(answers),
    ),
  )
  handle('agent:models', (provider) => agents.models(z.enum(['codex', 'claude']).parse(provider)))
  handle('files:list', (path) => ssh.list(z.string().optional().parse(path)))
  handle('files:read', (path) => ssh.read(z.string().parse(path)))
  handle('files:git', () => ssh.git())
  handle('terminal:open', () => ssh.openTerminal())
  handle('terminal:close', () => ssh.closeTerminal())
  handle('choose-key', async () => {
    const result = await dialog.showOpenDialog(window!, {
      title: 'Choose an SSH private key',
      properties: ['openFile'],
    })
    return result.canceled ? null : result.filePaths[0]
  })
  ipcMain.on('terminal:write', (e, data: unknown) => {
    if (e.sender === window?.webContents && typeof data === 'string' && data.length <= 100000)
      ssh.writeTerminal(data)
  })
  ipcMain.on('terminal:resize', (e, cols: unknown, rows: unknown) => {
    if (
      e.sender === window?.webContents &&
      typeof cols === 'number' &&
      typeof rows === 'number' &&
      Number.isInteger(cols) &&
      Number.isInteger(rows) &&
      cols > 0 &&
      cols < 1000 &&
      rows > 0 &&
      rows < 1000
    )
      ssh.resizeTerminal(cols, rows)
  })
  ipcMain.on('window:action', (e, action) => {
    if (e.sender !== window?.webContents) return
    if (action === 'minimize') window?.minimize()
    if (action === 'maximize') window?.isMaximized() ? window.unmaximize() : window?.maximize()
    if (action === 'close') window?.close()
  })
  await extensions.init()
  protocol.handle('life-code', async (request) => {
    try {
      const path = sourceCode.assetPath(request.url)
      if (!path) return new Response('Source build asset unavailable', { status: 404 })
      const extension = path.slice(path.lastIndexOf('.')).toLowerCase()
      const type =
        (
          {
            '.js': 'text/javascript',
            '.mjs': 'text/javascript',
            '.css': 'text/css',
            '.json': 'application/json',
            '.svg': 'image/svg+xml',
            '.png': 'image/png',
            '.woff': 'font/woff',
            '.woff2': 'font/woff2',
            '.ttf': 'font/ttf',
          } as Record<string, string>
        )[extension] || 'application/octet-stream'
      return new Response(await readFile(path), {
        headers: {
          'Content-Type': type,
          'Access-Control-Allow-Origin': '*',
          'Cache-Control': 'no-cache',
        },
      })
    } catch {
      return new Response('Source build asset unavailable', { status: 404 })
    }
  })
  protocol.handle('life-extension', (request) => {
    try {
      const url = new URL(request.url)
      if (url.hostname !== 'runtime' || !url.pathname.startsWith('/view/'))
        return new Response('Not found', { status: 404 })
      const id = extensionIdSchema.parse(decodeURIComponent(url.pathname.slice('/view/'.length)))
      const manifest = extensions
        .list()
        .find((extension) => extension.id === id && extension.enabled)
      if (!manifest) return new Response('Extension disabled or missing', { status: 404 })
      const theme = z.enum(['dark', 'light']).parse(url.searchParams.get('theme'))
      const token = z
        .string()
        .regex(/^[a-zA-Z0-9_-]{8,100}$/)
        .parse(url.searchParams.get('token'))
      return new Response(buildExtensionDocument(manifest, theme, token), {
        headers: {
          'Content-Type': 'text/html; charset=utf-8',
          'Content-Security-Policy': extensionDocumentCSP(token),
          'Cache-Control': 'no-store',
        },
      })
    } catch {
      return new Response('Invalid extension request', { status: 400 })
    }
  })
  createWindow()
  updates.start()
}
function createWindow() {
  window = new BrowserWindow({
    width: 1440,
    height: 960,
    minWidth: 760,
    minHeight: 580,
    show: false,
    backgroundColor: customization.get().config.theme === 'dark' ? '#161616' : '#ffffff',
    title: 'Life',
    icon: app.isPackaged
      ? join(process.resourcesPath, 'icon.png')
      : join(app.getAppPath(), 'build/icon.png'),
    frame: process.platform === 'darwin',
    ...(process.platform === 'darwin'
      ? { titleBarStyle: 'hidden' as const, trafficLightPosition: { x: 14, y: 12 } }
      : {}),
    webPreferences: {
      preload: join(__dirname, '../preload/index.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  })
  const owner = window
  const startSourceWatchdog = () => {
    clearTimeout(sourceStartupTimer)
    const state = sourceCode?.get()
    if (!state?.enabled || !state.active) return
    const revision = state.active.revision
    sourceStartupTimer = setTimeout(() => {
      if (
        owner !== window ||
        owner.isDestroyed() ||
        !sourceCode.get().enabled ||
        sourceCode.get().active?.revision !== revision
      )
        return
      void sourceCode
        .disable(
          'The customized interface did not finish starting. Life restored its built-in interface.',
        )
        .then(() => {
          if (owner !== window || owner.isDestroyed()) return
          createWindow()
          owner.destroy()
        })
    }, 25000)
    sourceStartupTimer.unref()
  }
  owner.webContents.on('did-start-navigation', (_event, _url, _inPlace, mainFrame) => {
    if (mainFrame) startSourceWatchdog()
  })
  owner.webContents.on('render-process-gone', () => {
    if (owner !== window || recovering || quitting || !sourceCode?.get().enabled) return
    void sourceCode
      .disable(
        'The customized interface stopped unexpectedly. Life restored its built-in interface.',
      )
      .then(() => {
        if (owner !== window || owner.isDestroyed()) return
        createWindow()
        owner.destroy()
      })
  })
  window.once('ready-to-show', () => owner.show())
  window.on('maximize', () => send('window:state', true))
  window.on('unmaximize', () => send('window:state', false))
  window.webContents.setWindowOpenHandler(({ url }) => {
    try {
      if (['https:', 'http:'].includes(new URL(url).protocol))
        void shell.openExternal(url).catch(() => {})
    } catch {
      /* Ignore invalid external URLs. */
    }
    return { action: 'deny' }
  })
  window.webContents.on('will-navigate', (event) => event.preventDefault())
  window.webContents.on('before-input-event', (event, input) => {
    if (
      input.type === 'keyDown' &&
      (input.control || input.meta) &&
      input.shift &&
      input.key.toLowerCase() === 'l'
    ) {
      event.preventDefault()
      void recoverExtensions().catch((error) =>
        dialog.showErrorBox('Life recovery failed', String(error)),
      )
    }
  })
  if (process.env.ELECTRON_RENDERER_URL) void window.loadURL(process.env.ELECTRON_RENDERER_URL)
  else void window.loadFile(join(__dirname, '../renderer/index.html'))
  window.on('closed', () => {
    if (window === owner) {
      ssh?.disconnect()
      window = null
    }
  })
}
if (ownsInstance)
  app
    .whenReady()
    .then(init)
    .catch((error) => {
      dialog.showErrorBox('Life could not start', error.message)
      app.quit()
    })
app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit()
})
app.on('activate', () => {
  if (!window) createWindow()
})
app.on('before-quit', (event) => {
  if (quitting) return
  ssh?.disconnect()
  customization?.close()
  updates?.dispose()
  clearTimeout(sourceStartupTimer)
  clearTimeout(sourceReloadTimer)
  if (extensions) {
    event.preventDefault()
    quitting = true
    void Promise.allSettled([extensions.close(), sourceCode?.close()]).finally(() => app.quit())
  }
})
