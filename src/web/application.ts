import { randomBytes } from 'node:crypto'
import { readFile, writeFile, rename } from 'node:fs/promises'
import { join } from 'node:path'
import type { IncomingMessage, ServerResponse } from 'node:http'
import { z } from 'zod'
import { Agents } from '../main/agents'
import { AgentHistory } from '../main/agent-history'
import { CustomizationStore } from '../main/customization'
import { ExtensionStore } from '../main/extensions'
import { ExtensionSharing } from '../main/extension-sharing'
import { SourceCodeStore } from '../main/source-code'
import { Store } from '../main/store'
import { ResearchDocuments } from '../main/research-documents'
import { executeConnectionCommand } from '../main/connection-execution'
import { listSSHConfig, resolveSSHConfig } from '../main/ssh-config'
import { builtinExtensionCatalog } from '../shared/builtin-extensions'
import { buildExtensionDocument, extensionDocumentCSP } from '../shared/extension-document'
import { extensionCoreArguments } from '../shared/extension-core'
import {
  extensionIdSchema,
  extensionMethodSchema,
  parseExtensionPayload,
} from '../shared/extensions'
import {
  agentSettingsSchema,
  agentSteerSchema,
  connectSchema,
  profileSchema,
  remoteDirectorySchema,
  startSchema,
} from '../shared/validation'
import { LIFE_VERSION } from '../shared/version'
import type { AgentEvent } from '../shared/types'
import { LOCAL_PROFILE_ID, WebConnection } from './local-connection'

type Operation = (...args: unknown[]) => unknown
export interface WebApplication {
  handle(request: IncomingMessage, response: ServerResponse): Promise<boolean>
  close(): Promise<void>
}

export async function createWebApplication(root: string, base = '/life/'): Promise<WebApplication> {
  const prefix = `${base.replace(/\/$/, '')}/api/`
  const directory = join(root, '.life', 'web-app')
  const store = new Store(directory)
  await store.init()
  const connection = new WebConnection(store, root)
  const clients = new Set<ServerResponse>()
  const events: { id: number; frame: string; bytes: number }[] = []
  let sequence = 0
  let eventBytes = 0
  let closing = false
  const secret = randomBytes(32).toString('hex')
  const cookieName = 'life_web_session'
  const emit = (channel: string, data: unknown) => {
    if (closing) return
    const id = ++sequence
    const frame = `id: ${id}\ndata: ${JSON.stringify({ channel, data })}\n\n`
    const bytes = Buffer.byteLength(frame)
    events.push({ id, frame, bytes })
    eventBytes += bytes
    while (eventBytes > 8_000_000 && events.length > 1) eventBytes -= events.shift()!.bytes
    for (const client of clients) {
      if (client.destroyed || client.writableEnded) clients.delete(client)
      else if (client.writableLength > 8_000_000) client.destroy()
      else client.write(frame)
    }
  }
  const pendingRequests = new Map<string, AgentEvent>()
  const agents = new Agents(connection, (event) => {
    if ((event.type === 'approval' || event.type === 'question') && event.requestId)
      pendingRequests.set(`${event.sessionId}:${event.requestId}`, event)
    if (event.type === 'complete' || event.type === 'error')
      for (const [key, request] of pendingRequests)
        if (request.sessionId === event.sessionId) pendingRequests.delete(key)
    emit('agent', event)
  })
  const history = new AgentHistory(connection)
  const customization = new CustomizationStore(directory, (state) => emit('customization', state))
  const source = new SourceCodeStore({
    sourceDir: root,
    nodeModulesDir: join(root, 'node_modules'),
    directory: join(directory, 'source'),
    builtinExtensions: builtinExtensionCatalog,
    rendererDefines: {
      'import.meta.env.VITE_LIFE_WEB_APP': JSON.stringify('true'),
      'import.meta.env.VITE_LIFE_WEB_PREVIEW': JSON.stringify('false'),
      'import.meta.env.BASE_URL': JSON.stringify(base),
    },
    onUpdate: (state) => emit('source', sourceState(state)),
  })
  const sourceState = (state = source.get()) => ({
    ...state,
    ...(state.active
      ? {
          active: {
            ...state.active,
            js: state.active.js.replace('life-code://runtime/', prefix + 'source/'),
            ...(state.active.css
              ? { css: state.active.css.replace('life-code://runtime/', prefix + 'source/') }
              : {}),
          },
        }
      : {}),
  })
  const methods = new Map<string, Operation>()
  const invoke = async (method: string, args: unknown[]) => {
    const operation = methods.get(method)
    if (!operation) throw new Error(`Unknown Life operation: ${method}`)
    return operation(...args)
  }
  const extensions = new ExtensionStore(
    join(directory, 'extensions'),
    (state) => emit('extensions', state),
    async (_id, method, payload) =>
      invoke(method, extensionCoreArguments(method, parseExtensionPayload(payload))),
    (id, event, data) => emit('extension-event', { id, type: 'event', event, data }),
  )
  const sharing = new ExtensionSharing()
  const documents = new ResearchDocuments()
  const id = z.string().min(1).max(250)
  const text = z.string().max(4096)
  const provider = z.enum(['codex', 'claude'])
  const bool = z.boolean()
  const register = (name: string, operation: Operation) => methods.set(name, operation)
  const sourceChange = async (operation: () => Promise<unknown>) => {
    await operation()
    return sourceState()
  }
  const updates = () => ({
    status: 'unsupported',
    currentVersion: LIFE_VERSION,
    message: 'This web app updates when its server is updated and the page is refreshed.',
  })
  register('app.info', () => ({
    name: 'Life',
    version: LIFE_VERSION,
    platform: 'web',
    dataDirectory: directory,
  }))
  register('profiles.list', () => [
    connection.localProfile,
    ...store.list().filter((entry) => entry.id !== LOCAL_PROFILE_ID),
  ])
  register('profiles.save', (value) => store.save(profileSchema.parse(value)))
  register('profiles.remove', (value) => {
    if (value === LOCAL_PROFILE_ID)
      throw new Error('The local machine connection is always available.')
    return store.remove(id.parse(value))
  })
  register('connection.state', () => connection.state)
  register('connection.connect', (value) => connection.connect(connectSchema.parse(value)))
  register('connection.selectWorkspace', (value) =>
    connection.selectWorkspace(remoteDirectorySchema.parse(value)),
  )
  register('connection.listDirectories', (value) =>
    connection.listDirectories(remoteDirectorySchema.optional().parse(value)),
  )
  register('connection.execute', (value) =>
    executeConnectionCommand(connection, value as Parameters<typeof executeConnectionCommand>[1]),
  )
  register('connection.disconnect', () => connection.disconnect())
  register('connection.trust', (value, accepted) =>
    connection.trust(id.parse(value), bool.parse(accepted)),
  )
  register('sshConfig.list', (value) => listSSHConfig(text.optional().parse(value)))
  register('sshConfig.resolve', (alias, path) =>
    resolveSSHConfig(text.parse(alias), text.optional().parse(path)),
  )
  register('forwarding.get', () => connection.forwarding.getState())
  register('agent.start', async (value) => {
    const input = startSchema.parse(value)
    if (connection.state.profile?.id === LOCAL_PROFILE_ID && input.provider === 'claude') {
      const status = await connection
        .exec('claude auth status', { timeoutMs: 10000 })
        .catch(() => '')
      if (!status || !JSON.parse(status).loggedIn)
        throw new Error(
          'Claude Code is not signed in on this machine. Open Terminal and run claude auth login, then send your message again.',
        )
    }
    return agents.start(input)
  })
  register('agent.steer', (value) => agents.steer(agentSteerSchema.parse(value)))
  register('agent.configure', (value) => agents.configure(agentSettingsSchema.parse(value)))
  register('agent.stop', (value) => agents.stop(id.parse(value)))
  register('agent.dispose', (value) => agents.dispose(id.parse(value)))
  register('agent.respond', async (session, request, accepted, answers) => {
    await agents.respond(
      id.parse(session),
      id.parse(request),
      bool.parse(accepted),
      z.record(z.string(), z.array(z.string())).optional().parse(answers),
    )
    pendingRequests.delete(`${session}:${request}`)
  })
  register('agent.models', (value) => agents.models(provider.parse(value)))
  register('hostHistory.list', (value) => history.list(value))
  register('hostHistory.read', (value) => history.read(value))
  register('hostHistory.cancel', (value) => history.cancel(id.parse(value)))
  register('files.list', (value) => connection.list(text.optional().parse(value)))
  register('files.read', (value) => connection.read(text.parse(value)))
  register('files.git', () => connection.git())
  register('terminal.open', () => connection.openTerminal())
  register('terminal.close', () => connection.closeTerminal())
  register('terminal.write', (value) =>
    connection.writeTerminal(z.string().max(100000).parse(value)),
  )
  register('terminal.resize', (cols, rows) =>
    connection.resizeTerminal(
      z.number().int().min(1).max(999).parse(cols),
      z.number().int().min(1).max(999).parse(rows),
    ),
  )
  register('customization.get', () => customization.get())
  register('customization.apply', (value) => customization.apply(value))
  register('customization.undo', () => customization.undo())
  register('customization.reset', () => customization.reset())
  register('customization.reload', () => customization.reload())
  register('sourceCode.get', () => sourceState())
  register('sourceCode.getContext', (value) =>
    source.getContext(value as Parameters<typeof source.getContext>[0]),
  )
  register('sourceCode.apply', (value) => sourceChange(() => source.apply(value)))
  register('sourceCode.setExtensionEnabled', (value, enabled) =>
    sourceChange(() =>
      source.setExtensionEnabled(extensionIdSchema.parse(value), bool.parse(enabled)),
    ),
  )
  register('sourceCode.removeExtension', (value) =>
    sourceChange(() => source.removeExtension(extensionIdSchema.parse(value))),
  )
  register('sourceCode.exportExtension', (value) =>
    source.exportExtension(extensionIdSchema.parse(value)),
  )
  register('sourceCode.importExtension', (value) =>
    sourceChange(() => source.importExtension(value)),
  )
  register('sourceCode.updateExtension', (value) =>
    sourceChange(() => source.updateExtension(value)),
  )
  register('sourceCode.rollback', () => sourceChange(() => source.rollback()))
  register('sourceCode.disable', () => sourceChange(() => source.disable()))
  register('sourceCode.ready', () => undefined)
  register('sourceCode.reportError', async (revision, message) => {
    if (source.get().active?.revision === z.number().int().parse(revision))
      await source.disable(z.string().max(10000).parse(message))
  })
  register('extensions.get', () => extensions.get())
  register('extensions.apply', (value) => extensions.apply(value))
  register('extensions.enable', (value, enabled) =>
    extensions.enable(extensionIdSchema.parse(value), bool.parse(enabled)),
  )
  register('extensions.remove', (value) => extensions.remove(extensionIdSchema.parse(value)))
  register('extensions.rollback', (value) => extensions.rollback(extensionIdSchema.parse(value)))
  register('extensions.call', (value, method, args) =>
    extensions.call(
      extensionIdSchema.parse(value),
      extensionMethodSchema.parse(method),
      parseExtensionPayload(args === undefined ? null : args),
    ),
  )
  register('extensions.invoke', (method, args) =>
    invoke(
      extensionMethodSchema.parse(method),
      extensionCoreArguments(
        String(method),
        parseExtensionPayload(args === undefined ? null : args),
      ),
    ),
  )
  register('extensions.recover', async () => {
    await source.disable()
    await Promise.all(
      extensions
        .list()
        .filter((entry) => entry.enabled)
        .map((entry) => extensions.enable(entry.id, false)),
    )
    emit('extension-recovery', null)
  })
  register('extensionSharing.publish', (value) => sharing.publish(value))
  register('extensionSharing.inspectPublic', (value) => sharing.inspectPublic(text.parse(value)))
  register('updates.get', updates)
  register('updates.check', updates)
  register('researchDocuments.register', (value) => {
    const document = documents.register(value)
    return { ...document, url: prefix + 'research/' + document.id }
  })
  register('researchDocuments.revoke', (value) => documents.revoke(value))
  const threadsPath = join(directory, 'threads.json')
  let threadWrites: Promise<unknown> = Promise.resolve()
  const loadConversations = async () => {
    try {
      const saved = JSON.parse(await readFile(threadsPath, 'utf8'))
      return Array.isArray(saved)
        ? { threads: saved, cursor: 0 }
        : { threads: saved.threads, cursor: Math.min(saved.cursor, sequence) }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
      return { threads: [], cursor: sequence }
    }
  }
  register('conversations.load', async () => (await loadConversations()).threads)
  register('conversations.snapshot', loadConversations)
  register('conversations.save', (value, cursor) => {
    const threads = z
      .array(
        z.object({ id: z.string().min(1).max(250), messages: z.array(z.unknown()) }).passthrough(),
      )
      .max(2000)
      .parse(value)
    const serialized = JSON.stringify({
      threads,
      cursor: Math.min(z.number().int().min(0).optional().parse(cursor) ?? sequence, sequence),
    })
    if (Buffer.byteLength(serialized) > 8_000_000)
      throw new Error('Conversation history exceeds 8 MB.')
    const write = threadWrites
      .catch(() => {})
      .then(async () => {
        await writeFile(threadsPath + '.tmp', serialized, { mode: 0o600 })
        await rename(threadsPath + '.tmp', threadsPath)
      })
    threadWrites = write
    return write
  })
  connection.on('state', (state) => emit('connection', state))
  connection.on('host-key', (request) => emit('host-key', request))
  connection.on('terminal', (data) => emit('terminal', data))
  connection.on('forwarding-state', (state) => emit('forwarding', state))
  await customization.init()
  await source.init()
  await extensions.init()
  await connection.connect(connection.localProfile)
  const heartbeat = setInterval(() => {
    for (const client of clients) client.write(': keepalive\n\n')
  }, 15000)
  heartbeat.unref()
  const json = (response: ServerResponse, status: number, body: unknown) => {
    response.writeHead(status, {
      'Content-Type': 'application/json',
      'Cache-Control': 'no-store',
      'X-Content-Type-Options': 'nosniff',
    })
    response.end(JSON.stringify(body))
  }
  return {
    async handle(request, response) {
      const url = new URL(request.url || '/', 'http://localhost')
      if (!url.pathname.startsWith(prefix)) return false
      const host = request.headers.host || ''
      const hostname = new URL('http://' + host).hostname
      if (
        !['localhost', '127.0.0.1', '[::1]'].includes(hostname) ||
        (request.headers.origin && request.headers.origin !== 'http://' + host) ||
        request.headers['sec-fetch-site'] === 'cross-site'
      ) {
        json(response, 403, { error: 'Open Life from its localhost address.' })
        return true
      }
      const route = url.pathname.slice(prefix.length)
      if (route === 'session' && request.method === 'GET') {
        response.setHeader(
          'Set-Cookie',
          `${cookieName}=${secret}; HttpOnly; SameSite=Strict; Path=${base}`,
        )
        json(response, 200, { token: secret, cursor: sequence })
        return true
      }
      const authenticated = request.headers.cookie
        ?.split(';')
        .some((cookie) => cookie.trim() === `${cookieName}=${secret}`)
      if (!authenticated) {
        json(response, 401, { error: 'Reconnect to the Life web server.' })
        return true
      }
      if (route === 'events' && request.method === 'GET') {
        response.writeHead(200, {
          'Content-Type': 'text/event-stream',
          'Cache-Control': 'no-store',
          Connection: 'keep-alive',
          'X-Accel-Buffering': 'no',
        })
        const cursor = Number(
          request.headers['last-event-id'] || url.searchParams.get('after') || sequence,
        )
        for (const event of events) if (event.id > cursor) response.write(event.frame)
        for (const event of [...agents.runningSessionEvents(), ...pendingRequests.values()])
          response.write(
            `id: ${sequence}\ndata: ${JSON.stringify({ channel: 'agent', data: event })}\n\n`,
          )
        response.write(': connected\n\n')
        clients.add(response)
        response.on('close', () => clients.delete(response))
        response.on('error', () => clients.delete(response))
        return true
      }
      if (route.startsWith('research/') && request.method === 'GET') {
        const document = documents.respond({
          url: 'life-extension://research/' + route.slice('research/'.length),
          method: 'GET',
        })
        response.writeHead(document.status, Object.fromEntries(document.headers))
        response.end(await document.text())
        return true
      }
      if (route.startsWith('extension/') && request.method === 'GET') {
        const manifest = extensions
          .list()
          .find((entry) => entry.id === route.slice('extension/'.length) && entry.enabled)
        if (!manifest) {
          response.writeHead(404)
          response.end()
          return true
        }
        const token = z
          .string()
          .regex(/^[a-zA-Z0-9_-]{8,100}$/)
          .parse(url.searchParams.get('token'))
        const theme = url.searchParams.get('theme') === 'light' ? 'light' : 'dark'
        response.writeHead(200, {
          'Content-Type': 'text/html; charset=utf-8',
          'Content-Security-Policy': extensionDocumentCSP(token),
          'Cache-Control': 'no-store',
        })
        response.end(buildExtensionDocument(manifest, theme, token))
        return true
      }
      if (route.startsWith('source/') && request.method === 'GET') {
        const path = source.assetPath(route.slice('source/'.length))
        if (!path) {
          response.writeHead(404)
          response.end()
          return true
        }
        response.writeHead(200, {
          'Content-Type': path.endsWith('.css')
            ? 'text/css'
            : path.endsWith('.js')
              ? 'text/javascript'
              : 'application/octet-stream',
          'Cache-Control': 'no-store',
        })
        response.end(await readFile(path))
        return true
      }
      if (
        route !== 'rpc' ||
        request.method !== 'POST' ||
        request.headers['x-life-session'] !== secret ||
        !request.headers['content-type']?.startsWith('application/json')
      ) {
        json(response, 403, { error: 'Invalid Life request.' })
        return true
      }
      try {
        let length = 0
        const chunks: Buffer[] = []
        for await (const chunk of request) {
          length += chunk.length
          if (length > 10_000_000) throw new Error('Life request exceeds 10 MB.')
          chunks.push(chunk)
        }
        const input = z
          .object({ method: z.string().min(1).max(120), args: z.array(z.unknown()).max(8) })
          .strict()
          .parse(JSON.parse(Buffer.concat(chunks).toString()))
        json(response, 200, { value: (await invoke(input.method, input.args)) ?? null })
      } catch (error) {
        json(response, 400, { error: error instanceof Error ? error.message : String(error) })
      }
      return true
    },
    async close() {
      if (closing) return
      closing = true
      clearInterval(heartbeat)
      for (const client of clients) client.end()
      clients.clear()
      history.cancelAll()
      agents.close()
      connection.closeLocalProcesses()
      customization.close()
      documents.clear()
      await Promise.all([extensions.close(), source.close(), threadWrites.catch(() => {})])
    },
  }
}
