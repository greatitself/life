import { mkdtemp, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { Readable, Writable } from 'node:stream'
import type { IncomingMessage, ServerResponse } from 'node:http'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { createWebApplication, type WebApplication } from '../src/web/application'

class Response extends Writable {
  status = 0
  headers: Record<string, string> = {}
  body = ''
  headersSent = false
  setHeader(key: string, value: string) {
    this.headers[key.toLowerCase()] = value
  }
  writeHead(status: number, headers: Record<string, string> = {}) {
    this.status = status
    this.headersSent = true
    for (const [key, value] of Object.entries(headers)) this.setHeader(key, value)
  }
  override _write(chunk: Buffer, _encoding: BufferEncoding, callback: () => void) {
    this.body += chunk.toString()
    callback()
  }
}

describe('Life web application transport', () => {
  let application: WebApplication
  let root: string
  let token: string
  let cookie: string
  async function request(
    path: string,
    options: { method?: string; headers?: Record<string, string>; body?: unknown } = {},
  ) {
    const request = Readable.from(
      options.body === undefined ? [] : [Buffer.from(JSON.stringify(options.body))],
    ) as unknown as IncomingMessage
    request.url = '/life/api/' + path
    request.method = options.method || 'GET'
    request.headers = { host: 'localhost:5173', ...options.headers }
    const response = new Response()
    await application.handle(request, response as unknown as ServerResponse)
    return response
  }
  async function rpc(method: string, ...args: unknown[]) {
    return request('rpc', {
      method: 'POST',
      headers: { cookie, 'content-type': 'application/json', 'x-life-session': token },
      body: { method, args },
    })
  }
  beforeAll(async () => {
    root = await mkdtemp(join(tmpdir(), 'life-web-app-'))
    application = await createWebApplication(root)
    const session = await request('session')
    token = JSON.parse(session.body).token
    cookie = session.headers['set-cookie'].split(';')[0]
  })
  afterAll(async () => {
    await application?.close()
    await rm(root, { recursive: true, force: true })
  })
  it('requires the localhost session and rejects cross-origin or foreign-host requests', async () => {
    expect(
      (await request('rpc', { method: 'POST', body: { method: 'connection.state', args: [] } }))
        .status,
    ).toBe(401)
    expect((await request('session', { headers: { origin: 'https://example.com' } })).status).toBe(
      403,
    )
    expect((await request('session', { headers: { host: 'example.com:5173' } })).status).toBe(403)
    expect(
      (
        await request('rpc', {
          method: 'POST',
          headers: { cookie, 'content-type': 'application/json' },
          body: { method: 'connection.state', args: [] },
        })
      ).status,
    ).toBe(403)
  })
  it('uses real host state and validated execution rather than the preview stubs', async () => {
    const state = JSON.parse((await rpc('connection.state')).body).value
    expect(state.profile.id).toBe('life-web-local')
    expect(state.workspace).toBe(root)
    expect(JSON.parse((await rpc('connection.execute', { command: 'pwd' })).body).value).toBe(
      root + '\n',
    )
    expect((await rpc('agent.start', { provider: 'unsupported' })).status).toBe(400)
  })
  it('persists conversations and settings on the server', async () => {
    const threads = [
      { id: 'test-thread', messages: [{ role: 'user', text: 'Exact test message' }] },
    ]
    expect((await rpc('conversations.save', threads, 0)).status).toBe(200)
    expect(JSON.parse((await rpc('conversations.load')).body).value).toEqual(threads)
    expect(JSON.parse((await rpc('conversations.snapshot')).body).value).toEqual({
      threads,
      cursor: 0,
    })
    await rpc('customization.apply', { theme: 'light' })
    expect(JSON.parse((await rpc('customization.get')).body).value.config.theme).toBe('light')
    await rpc('customization.undo')
    expect(JSON.parse((await rpc('customization.get')).body).value.config.theme).toBe('dark')
  })
  it('serves Research maps with the same opaque sandbox policy', async () => {
    const document = JSON.parse(
      (await rpc('researchDocuments.register', '<p>Research map</p>')).body,
    ).value
    const response = await request('research/' + document.id, { headers: { cookie } })
    expect(response.status).toBe(200)
    expect(response.headers['content-security-policy']).toContain('sandbox allow-scripts')
    expect(response.body).toBe('<p>Research map</p>')
    await rpc('researchDocuments.revoke', document.id)
    expect((await request('research/' + document.id, { headers: { cookie } })).status).toBe(404)
  })
  it('saves history from an older browser session whose cursor exceeds the restarted server', async () => {
    const threads = [{ id: 'recovered-thread', messages: [{ role: 'user', text: 'Keep this' }] }]
    const current = JSON.parse((await request('session')).body).cursor
    expect((await rpc('conversations.save', threads, current + 900)).status).toBe(200)
    expect(JSON.parse((await rpc('conversations.snapshot')).body).value).toEqual({
      threads,
      cursor: current,
    })
    expect((await rpc('conversations.save', threads, -1)).status).toBe(400)
  })
  it('streams events and tolerates a browser closing its stream before the next update', async () => {
    const stream = await request('events?after=0', { headers: { cookie } })
    expect(stream.headers['content-type']).toBe('text/event-stream')
    await rpc('customization.apply', { theme: 'light' })
    expect(stream.body).toContain('"channel":"customization"')
    stream.end()
    await rpc('customization.apply', { theme: 'dark' })
    await application.close()
  })
})
