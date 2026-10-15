#!/usr/bin/env node
// Browser preview of the checkout's renderer. Native IPC requires Electron.
import { resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { resolveConfig } from 'electron-vite'
import { createServer } from 'vite'

const repository = resolve(fileURLToPath(new URL('..', import.meta.url)))
const port = Number(process.env.LIFE_PREVIEW_PORT || 5173)
if (!Number.isInteger(port) || port < 1 || port > 65535)
  throw new Error('LIFE_PREVIEW_PORT must be an integer from 1 to 65535.')

const configured = await resolveConfig({ root: repository }, 'serve', 'development')
if (!configured.config?.renderer) throw new Error('Life renderer configuration is missing.')
const server = await createServer({
  ...configured.config.renderer,
  root: resolve(repository, configured.config.renderer.root || 'src/renderer'),
  server: {
    ...configured.config.renderer.server,
    host: '127.0.0.1',
    port,
    strictPort: true,
    open: false,
  },
})
await server.listen()
console.log('Life browser preview: renderer feedback only; native SSH and providers need Electron.')
server.printUrls()

let closing = false
async function close() {
  if (closing) return
  closing = true
  await server.close()
}
for (const signal of ['SIGINT', 'SIGTERM'])
  process.once(signal, () => {
    void close().then(() => process.exit(0))
  })
