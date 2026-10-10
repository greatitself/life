import { createServer } from 'node:http'
import { readFile, realpath, stat } from 'node:fs/promises'
import { extname, join, resolve, sep } from 'node:path'
import { createWebApplication } from './application'

async function main() {
  const root = resolve(process.env.LIFE_WEB_ROOT || process.cwd())
  const base = process.env.LIFE_WEB_BASE || '/life/'
  const port = Number(process.env.PORT || 5173)
  const application = await createWebApplication(root, base)
  const directory = await realpath(join(root, 'dist-web'))
  const types: Record<string, string> = {
    '.html': 'text/html; charset=utf-8',
    '.js': 'text/javascript',
    '.css': 'text/css',
    '.json': 'application/json',
    '.svg': 'image/svg+xml',
    '.png': 'image/png',
    '.woff2': 'font/woff2',
    '.woff': 'font/woff',
    '.ttf': 'font/ttf',
  }
  const server = createServer(async (request, response) => {
    try {
      if (await application.handle(request, response)) return
      if (!['GET', 'HEAD'].includes(request.method || '')) {
        response.writeHead(405)
        response.end()
        return
      }
      const url = new URL(request.url || '/', 'http://localhost')
      if (url.pathname === '/') {
        response.writeHead(302, { Location: base })
        response.end()
        return
      }
      if (!url.pathname.startsWith(base)) {
        response.writeHead(404)
        response.end()
        return
      }
      const relative = decodeURIComponent(url.pathname.slice(base.length)) || 'index.html'
      const path = await realpath(resolve(directory, relative))
      if (!path.startsWith(directory + sep) || !(await stat(path)).isFile()) {
        response.writeHead(404)
        response.end()
        return
      }
      response.writeHead(200, {
        'Content-Type': types[extname(path)] || 'application/octet-stream',
        'Cache-Control': 'no-cache',
      })
      response.end(request.method === 'HEAD' ? undefined : await readFile(path))
    } catch (error) {
      if (!response.headersSent)
        response.writeHead((error as NodeJS.ErrnoException).code === 'ENOENT' ? 404 : 500)
      response.end('The Life server could not complete this request.')
    }
  })
  server.listen(port, '127.0.0.1', () =>
    console.log(`Life web app: http://localhost:${port}${base}`),
  )
  let closing = false
  const close = async () => {
    if (closing) return
    closing = true
    await application.close()
    server.close(() => process.exit(0))
    server.closeAllConnections()
  }
  process.on('SIGINT', () => {
    void close()
  })
  process.on('SIGTERM', () => {
    void close()
  })
}

void main().catch((error) => {
  console.error(error)
  process.exitCode = 1
})
