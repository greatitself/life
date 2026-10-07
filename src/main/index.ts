import { app, BrowserWindow, ipcMain, dialog, shell } from 'electron'
import { join } from 'node:path'
import { Store } from './store'
import { SSHConnection } from './ssh'
import { Agents } from './agents'
import { connectSchema, profileSchema, startSchema } from '../shared/validation'
import { z } from 'zod'

app.setName('Life')

let window: BrowserWindow | null = null
let ssh: SSHConnection
const send = (channel: string, data: unknown) => {
  if (window && !window.isDestroyed()) window.webContents.send(channel, data)
}
async function init() {
  const store = new Store(app.getPath('userData'))
  await store.init()
  ssh = new SSHConnection(store)
  const agents = new Agents(ssh, (event) => send('agent:event', event))
  ssh.on('state', (state) => send('connection:state', state))
  ssh.on('host-key', (request) => send('connection:host-key', request))
  ssh.on('terminal', (data) => send('terminal:data', data))
  const handle = (name: string, fn: (...args: unknown[]) => unknown) =>
    ipcMain.handle(name, (event, ...args: unknown[]) => {
      if (
        !window ||
        event.sender !== window.webContents ||
        event.senderFrame !== window.webContents.mainFrame
      )
        throw new Error('Untrusted IPC sender')
      return fn(...args)
    })
  handle('profiles:list', () => store.list())
  handle('profiles:save', (p) => store.save(profileSchema.parse(p)))
  handle('profiles:remove', (id) => store.remove(z.string().parse(id)))
  handle('connection:connect', (input) => ssh.connect(connectSchema.parse(input)))
  handle('connection:disconnect', () => ssh.disconnect())
  handle('connection:state', () => ssh.state)
  handle('connection:trust', (id, accepted) =>
    ssh.trust(z.string().parse(id), z.boolean().parse(accepted)),
  )
  handle('agent:start', (input) => agents.start(startSchema.parse(input)))
  handle('agent:stop', (id) => agents.stop(z.string().parse(id)))
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
  createWindow()
}
function createWindow() {
  window = new BrowserWindow({
    width: 1440,
    height: 960,
    minWidth: 760,
    minHeight: 580,
    show: false,
    backgroundColor: '#17181b',
    title: 'Life',
    icon: app.isPackaged
      ? join(process.resourcesPath, 'icon.png')
      : join(app.getAppPath(), 'build/icon.png'),
    frame: false,
    webPreferences: {
      preload: join(__dirname, '../preload/index.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  })
  window.once('ready-to-show', () => window?.show())
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
  if (process.env.ELECTRON_RENDERER_URL) void window.loadURL(process.env.ELECTRON_RENDERER_URL)
  else void window.loadFile(join(__dirname, '../renderer/index.html'))
  window.on('closed', () => {
    ssh?.disconnect()
    window = null
  })
}
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
app.on('before-quit', () => ssh?.disconnect())
