import { afterAll, describe, expect, it, vi } from 'vitest'
import { createHash } from 'node:crypto'
import { EventEmitter } from 'node:events'
import { readFileSync } from 'node:fs'
import { mkdir, writeFile } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { dirname, resolve } from 'node:path'
import { createContext, Script } from 'node:vm'
import ts from 'typescript'
import type { HotPayload } from 'vite'
import { adaptViteRendererClient, lifeRendererReloadPlugin } from '../scripts/vite-renderer-reload'

const require = createRequire(import.meta.url)
const clientEntry = resolve(dirname(require.resolve('vite/package.json')), 'dist/client/client.mjs')
const installed = readFileSync(clientEntry, 'utf8')
const adapted = adaptViteRendererClient(installed, clientEntry, clientEntry)!
const helperPath = resolve(import.meta.dirname, '../scripts/vite-renderer-reload.ts')
const helperSource = readFileSync(helperPath, 'utf8')
const rendererRoot = '/private/life/src/renderer'
const componentPath = '/components/TitleBar.tsx'
const wrapperPath = '/components/thread-output.css'
const directPath = `${wrapperPath}?direct`
const hash = (value: string) => createHash('sha256').update(value).digest('hex')

/** Execute installed code, including its actual transport and hot-module queues. */
function clientDeclarations(code: string): string {
  const source = ts.createSourceFile(
    clientEntry,
    code,
    ts.ScriptTarget.Latest,
    true,
    ts.ScriptKind.JS,
  )
  const name = (statement: ts.Statement): string[] => {
    if (ts.isFunctionDeclaration(statement)) return statement.name ? [statement.name.text] : []
    if (ts.isVariableStatement(statement))
      return statement.declarationList.declarations.flatMap((declaration) =>
        ts.isIdentifier(declaration.name) ? [declaration.name.text] : [],
      )
    return []
  }
  const statementFor = (identifier: string) => {
    const statements = source.statements.filter((statement) => name(statement).includes(identifier))
    expect(statements, `Installed client declaration ${identifier}`).toHaveLength(1)
    return statements[0]
  }
  const exact = (statement: ts.Statement) => code.slice(statement.getStart(source), statement.end)
  const dependencies = [
    '_typeof',
    'toPrimitive',
    'toPropertyKey',
    '_defineProperty',
    'HMRContext',
    'HMRClient',
    'Queue',
    'createHMRHandler',
    'base',
  ].map((identifier) => exact(statementFor(identifier)))
  const first = statementFor('willUnload')
  const pending = source.statements.find((statement) =>
    name(statement).includes('lifeRendererReloadPending'),
  )
  const start = pending
    ? Math.min(pending.getStart(source), first.getStart(source))
    : first.getStart(source)
  const end = statementFor('hasDocument').end
  expect(code.slice(start, end)).toContain('async function handleMessage(payload)')
  expect(code.slice(start, end)).toContain('transport.connect(createHMRHandler(handleMessage))')
  return [...dependencies, code.slice(start, end)].join('\n')
}

const exactClient = clientDeclarations(adapted)
interface Observation {
  kind: string
  value?: unknown
}
interface ClientRecord {
  label: string
  test: string
  observations: Observation[]
  snapshot: () => unknown
}
const clients: ClientRecord[] = []
const serverRecords: { test: string; sent: HotPayload[]; documents: number }[] = []

function client(label: string, pathname = '/index.html') {
  const observations: Observation[] = []
  const listeners = new Map<string, (() => void)[]>()
  const timers = new Map<number, () => void>()
  let nextTimer = 0
  let socketHandler: ((payload: HotPayload) => Promise<void>) | undefined
  let overlay = false
  const observe = (kind: string, value?: unknown) => {
    observations.push({
      kind,
      ...(value === undefined ? {} : { value: JSON.parse(JSON.stringify(value)) }),
    })
  }
  const links: Link[] = []
  class Link {
    private readonly events = new Map<string, (() => void)[]>()
    constructor(public href: string) {}
    cloneNode() {
      return new Link(this.href)
    }
    addEventListener(event: string, listener: () => void) {
      this.events.set(event, [...(this.events.get(event) || []), listener])
    }
    remove() {
      links.splice(links.indexOf(this), 1)
      observe('link-removed', this.href)
    }
    after(link: Link) {
      links.push(link)
      observe('link-inserted', link.href)
      queueMicrotask(() => link.events.get('load')?.forEach((listener) => listener()))
    }
  }
  links.push(new Link(`http://life.test${directPath}`))
  const context = createContext({
    URL,
    __BASE__: '/',
    __HMR_ENABLE_OVERLAY__: false,
    __observe: observe,
    console: {
      debug: () => {},
      log: () => {},
      info: () => {},
      error: (value: unknown) => observe('error', String(value)),
    },
    window: {
      addEventListener: (event: string, listener: () => void) =>
        listeners.set(event, [...(listeners.get(event) || []), listener]),
    },
    document: { querySelectorAll: (selector: string) => (selector === 'link' ? links : []) },
    location: {
      pathname,
      reload: () => {
        observe('reload-prevented')
        listeners.get('beforeunload')?.forEach((listener) => listener())
      },
    },
    transport: {
      connect: (handler: typeof socketHandler) => {
        socketHandler = handler
        return Promise.resolve()
      },
      send: async () => {},
    },
    setTimeout: (callback: () => void) => {
      const id = ++nextTimer
      timers.set(id, callback)
      return id
    },
    clearTimeout: (id: number) => timers.delete(id),
    hasErrorOverlay: () => overlay,
    clearErrorOverlay: () => observe('overlay-cleared'),
    createErrorOverlay: () => observe('overlay-created'),
    waitForSuccessfulPing: async (url: string) => observe('ping', url),
  })
  new Script(exactClient, { filename: clientEntry }).runInContext(context)
  new Script(`
    hmrClient.importUpdatedModule = async update => {
      __observe('import', update);
      return { fixture: true, path: update.acceptedPath };
    };
    const originalQueueUpdate = hmrClient.queueUpdate.bind(hmrClient);
    hmrClient.queueUpdate = update => {
      __observe('queue', update);
      return originalQueueUpdate(update);
    };
    for (const name of ['vite:beforeUpdate', 'vite:afterUpdate', 'vite:beforeFullReload',
      'vite:beforePrune', 'vite:ws:disconnect'])
      hmrClient.customListenersMap.set(name, [payload => __observe(name, payload)]);
    globalThis.__fixtureRegister = path => {
      const hot = new HMRContext(hmrClient, path);
      hot.dispose(() => __observe('dispose', path));
      hot.prune(() => __observe('prune', path));
      hot.accept(module => __observe('accept', { path, module }));
    };
  `).runInContext(context)
  for (const path of [componentPath, wrapperPath, directPath]) {
    context.__fixturePath = path
    new Script('__fixtureRegister(__fixturePath)').runInContext(context)
  }
  const snapshot = () =>
    JSON.parse(
      JSON.stringify(
        new Script(`({ willUnload,
      pending: typeof lifeRendererReloadPending === 'undefined' ? null : lifeRendererReloadPending })`).runInContext(
          context,
        ),
      ),
    )
  clients.push({
    label,
    test: expect.getState().currentTestName || 'unknown',
    observations,
    snapshot,
  })
  const count = (kind: string) => observations.filter((item) => item.kind === kind).length
  return {
    observations,
    count,
    snapshot,
    deliver: async (payload: HotPayload) => {
      expect(socketHandler).toBeTypeOf('function')
      // Each websocket document receives separately decoded JSON, without shared mutable payloads.
      await socketHandler!(JSON.parse(JSON.stringify(payload)))
    },
    drain: async () => {
      for (const [id, callback] of [...timers]) {
        timers.delete(id)
        callback()
      }
      await Promise.resolve()
    },
    event: (event: string) => listeners.get(event)?.forEach((listener) => listener()),
    overlay: (value: boolean) => (overlay = value),
  }
}

type GraphModule = {
  id: string
  file: string
  type: string
  isSelfAccepting: boolean
  importers: Set<GraphModule>
}
const graphModule = (file: string, id = file, type = 'js'): GraphModule => ({
  id,
  file,
  type,
  isSelfAccepting: true,
  importers: new Set(),
})
type UpdatePayload = Extract<HotPayload, { type: 'update' }>
const update = (
  path = componentPath,
  type: 'js-update' | 'css-update' = 'js-update',
): UpdatePayload => ({
  type: 'update',
  updates: [{ type, path, acceptedPath: path, timestamp: 123 }],
})

function server() {
  const plugin = lifeRendererReloadPlugin()
  const records = {
    test: expect.getState().currentTestName || 'unknown',
    sent: [] as HotPayload[],
    documents: 0,
  }
  serverRecords.push(records)
  const modules = new Map<string, GraphModule>([
    ['/App.tsx', graphModule(`${rendererRoot}/App.tsx`)],
    [componentPath, graphModule(`${rendererRoot}${componentPath}`)],
    [wrapperPath, graphModule(`${rendererRoot}${wrapperPath}`)],
    [
      directPath,
      graphModule(`${rendererRoot}${wrapperPath}`, `${rendererRoot}${directPath}`, 'css'),
    ],
  ])
  const middlewares: ((request: unknown, response: unknown, next: () => void) => void)[] = []
  const environment = {
    name: 'client',
    hot: { send: (payload: HotPayload) => records.sent.push(JSON.parse(JSON.stringify(payload))) },
    moduleGraph: { urlToModuleMap: modules, invalidateModule: vi.fn() },
  }
  if (typeof plugin.configResolved !== 'function' || typeof plugin.configureServer !== 'function')
    throw new Error('Actual configured plugin hooks are required')
  plugin.configResolved.call({} as never, { root: rendererRoot } as never)
  plugin.configureServer.call(
    {} as never,
    {
      config: { base: '/' },
      environments: { client: environment },
      middlewares: {
        use: (middleware: (typeof middlewares)[number]) => middlewares.push(middleware),
      },
    } as never,
  )
  return {
    modules,
    send: (payload: HotPayload) => {
      environment.hot.send(payload)
      return records.sent.at(-1)!
    },
    ownershipChange: () => {
      const hook =
        typeof plugin.hotUpdate === 'function' ? plugin.hotUpdate : plugin.hotUpdate?.handler
      if (!hook) throw new Error('Actual modern Vite ownership hook is required')
      const owner = modules.get('/App.tsx')!
      hook.call(
        { environment } as never,
        { type: 'update', file: owner.file, modules: [owner] } as never,
      )
      expect(records.sent.at(-1)?.type).toBe('full-reload')
      return records.sent.at(-1)!
    },
    document: (statusCode = 200) => {
      const response = Object.assign(new EventEmitter(), { statusCode })
      for (const middleware of middlewares)
        middleware(
          {
            url: '/index.html',
            headers: { 'sec-fetch-dest': 'document', 'sec-fetch-mode': 'navigate' },
          },
          response,
          () => {},
        )
      response.emit('finish')
      records.documents++
    },
  }
}

function noJavaScriptWork(document: ReturnType<typeof client>) {
  expect(document.count('queue')).toBe(0)
  expect(document.count('dispose')).toBe(0)
  expect(document.count('import')).toBe(0)
  expect(document.count('accept')).toBe(0)
  expect(document.count('vite:beforeUpdate')).toBe(0)
  expect(document.count('vite:afterUpdate')).toBe(0)
}

afterAll(async () => {
  const directory = process.env.LIFE_TEST_GATE_ARTIFACTS_DIR
  if (!directory) return
  await mkdir(directory, { recursive: true })
  await writeFile(resolve(directory, 'served-client-exact-slice.mjs'), exactClient)
  await writeFile(resolve(directory, 'helper-source.ts'), helperSource)
  await writeFile(
    resolve(directory, 'observations.json'),
    JSON.stringify(
      {
        installedClient: { path: clientEntry, sha256: hash(installed) },
        fixture: {
          path: import.meta.filename,
          sha256: hash(readFileSync(import.meta.filename, 'utf8')),
        },
        servedAdapterSha256: hash(adapted),
        extractedExactClientSha256: hash(exactClient),
        helper: { path: helperPath, sha256: hash(helperSource) },
        boundaries: [
          'transport',
          'dynamic import',
          'DOM link and overlay',
          'reload prevented by native owner',
          'deterministic timers',
          'ping',
        ],
        realCode: [
          'HMRContext',
          'HMRClient queue/fetch/dispose/accept',
          'Queue/createHMRHandler',
          'served handleMessage',
          'cleanUrl/debounceReload/pageReload',
          'pagehide latch',
          'configured plugin module graph and HTML middleware',
        ],
        nativeBrowserOrProviderUsed: false,
        servers: serverRecords,
        clients: clients.map(({ snapshot, ...entry }) => ({
          ...entry,
          finalDocumentState: snapshot(),
        })),
      },
      null,
      2,
    ) + '\n',
  )
})

describe('Vite renderer document ownership gate', () => {
  it.each([200, 304])(
    'a second HTML document (%s) cannot reactivate the retired native document',
    async (status) => {
      const source = server()
      const old = client('old native document')
      await old.deliver(source.ownershipChange())
      await old.drain()
      expect(old.count('reload-prevented')).toBe(1)
      source.document(status)
      const fresh = client('independent fresh document')
      const component = source.send(update())
      expect(component.type).toBe('update')
      await old.deliver(component)
      await fresh.deliver(component)
      expect(fresh.count('queue')).toBe(1)
      expect(fresh.count('dispose')).toBe(1)
      expect(fresh.count('import')).toBe(1)
      expect(fresh.count('accept')).toBe(1)
      noJavaScriptWork(old)
    },
  )

  it('retires synchronously before the actual debounced reload timer runs', async () => {
    const old = client('before debounced reload')
    await old.deliver({ type: 'full-reload', path: '*' })
    expect(old.count('reload-prevented')).toBe(0)
    await old.deliver(update())
    noJavaScriptWork(old)
    await old.drain()
    expect(old.count('reload-prevented')).toBe(1)
  })

  it('admits graph-proven ordinary CSS wrappers and links while removing JS from a mixed batch', async () => {
    const source = server()
    const old = client('retired CSS-compatible document')
    await old.deliver(source.ownershipChange())
    await old.drain()
    source.document()
    const fresh = client('fresh mixed-update document')
    const mixed = source.send({
      type: 'update',
      updates: [
        ...update().updates,
        ...update(wrapperPath).updates,
        ...update(directPath, 'css-update').updates,
      ],
    })
    expect(mixed.type).toBe('update')
    if (mixed.type !== 'update') throw new Error('Expected real style payload annotation')
    expect(
      (mixed.updates[0] as unknown as Record<string, unknown>).lifeRendererStyleUpdate,
    ).not.toBe(true)
    expect((mixed.updates[1] as unknown as Record<string, unknown>).lifeRendererStyleUpdate).toBe(
      true,
    )
    expect((mixed.updates[2] as unknown as Record<string, unknown>).lifeRendererStyleUpdate).toBe(
      true,
    )
    await old.deliver(mixed)
    await fresh.deliver(mixed)
    expect(
      old.observations.filter((item) => item.kind === 'dispose').map((item) => item.value),
    ).toEqual([wrapperPath])
    expect(
      old.observations
        .filter((item) => item.kind === 'import')
        .map((item) => (item.value as { acceptedPath: string }).acceptedPath),
    ).toEqual([wrapperPath])
    expect(old.count('link-inserted')).toBe(1)
    expect(old.count('link-removed')).toBe(1)
    for (const event of ['vite:beforeUpdate', 'vite:afterUpdate']) {
      const notification = old.observations.find((item) => item.kind === event)!
        .value as UpdatePayload
      expect(notification.updates.map((item) => item.path)).toEqual([wrapperPath, directPath])
    }
    expect(fresh.count('dispose')).toBe(2)
    expect(fresh.count('import')).toBe(2)
  })

  it.each([
    '/components/thread-output.module.css',
    `${wrapperPath}?inline`,
    `${wrapperPath}?inline-foo`,
    `${wrapperPath}?inline=0`,
    `${wrapperPath}?raw`,
    `${wrapperPath}?url`,
    `${wrapperPath}?html-proxy`,
    `${wrapperPath}?inline-css`,
    `${wrapperPath}?style-attr`,
    `${wrapperPath}?transform-only`,
    '/index.html?html-proxy&inline-css&index=0.css',
    '/components/Component.tsx?theme=styles.css',
  ])(
    'does not classify CSS-looking executable or transformed modules as ordinary styles: %s',
    async (path) => {
      const source = server()
      const old = client('retired transformed-style document')
      await old.deliver(source.ownershipChange())
      await old.drain()
      source.document()
      const file = path.split('?')[0]
      source.modules.set(path, graphModule(`${rendererRoot}${file}`, `${rendererRoot}${path}`))
      const payload = source.send(update(path))
      expect(payload.type).toBe('update')
      if (payload.type !== 'update') throw new Error('Expected normal post-document server update')
      expect(
        (payload.updates[0] as unknown as Record<string, unknown>).lifeRendererStyleUpdate,
      ).not.toBe(true)
      await old.deliver(payload)
      noJavaScriptWork(old)
    },
  )

  it.each([true, false])(
    'requires both path and acceptedPath to be proven styles (CSS path=%s)',
    async (cssPath) => {
      const source = server()
      const old = client('retired mismatched-acceptance document')
      await old.deliver(source.ownershipChange())
      await old.drain()
      source.document()
      const payload = update(cssPath ? wrapperPath : componentPath)
      payload.updates[0].acceptedPath = cssPath ? componentPath : wrapperPath
      const delivered = source.send(payload)
      expect(delivered.type).toBe('update')
      if (delivered.type !== 'update') throw new Error('Expected a post-document component payload')
      expect(
        (delivered.updates[0] as unknown as Record<string, unknown>).lifeRendererStyleUpdate,
      ).not.toBe(true)
      await old.deliver(delivered)
      noJavaScriptWork(old)
    },
  )

  it('does not retire for an unrelated HTML full reload', async () => {
    const document = client('unrelated HTML remains active')
    await document.deliver({ type: 'full-reload', path: '/another/document.html' })
    await document.drain()
    expect(document.count('reload-prevented')).toBe(0)
    await document.deliver(update())
    expect(document.count('dispose')).toBe(1)
    expect(document.count('import')).toBe(1)
    expect(document.count('accept')).toBe(1)
  })

  it('prevents real prune disposal in a retired document while the fresh document can prune', async () => {
    const source = server()
    const old = client('retired document receiving prune')
    await old.deliver(source.ownershipChange())
    await old.drain()
    source.document()
    const fresh = client('fresh document receiving prune')
    const payload = source.send({ type: 'prune', paths: [componentPath, wrapperPath] })
    await old.deliver(payload)
    await fresh.deliver(payload)
    expect(old.count('vite:beforePrune')).toBe(0)
    expect(old.count('dispose')).toBe(0)
    expect(old.count('prune')).toBe(0)
    expect(fresh.count('vite:beforePrune')).toBe(1)
    expect(fresh.count('dispose')).toBe(2)
    expect(fresh.count('prune')).toBe(2)
  })

  it('removes an unproved style marker from an actual outgoing component payload', async () => {
    const source = server()
    const old = client('retired document rejects unproved metadata')
    await old.deliver(source.ownershipChange())
    await old.drain()
    source.document()
    const payload = update()
    Object.assign(payload.updates[0], { lifeRendererStyleUpdate: true })
    const delivered = source.send(payload)
    expect(delivered.type).toBe('update')
    if (delivered.type !== 'update') throw new Error('Expected an ordinary server component update')
    expect(
      (delivered.updates[0] as unknown as Record<string, unknown>).lifeRendererStyleUpdate,
    ).not.toBe(true)
    await old.deliver(delivered)
    noJavaScriptWork(old)
  })

  it('requires path and acceptedPath to resolve to the same exact ordinary style module', async () => {
    const source = server()
    const old = client('retired document rejects distinct CSS module nodes')
    await old.deliver(source.ownershipChange())
    await old.drain()
    source.document()
    const payload = update(wrapperPath)
    payload.updates[0].acceptedPath = directPath
    const delivered = source.send(payload)
    expect(delivered.type).toBe('update')
    if (delivered.type !== 'update') throw new Error('Expected a normal server style update')
    expect(
      (delivered.updates[0] as unknown as Record<string, unknown>).lifeRendererStyleUpdate,
    ).not.toBe(true)
    await old.deliver(delivered)
    noJavaScriptWork(old)
  })

  it.each(['missing', 'not-self-accepting'] as const)(
    'does not grant the ordinary style exemption to a %s graph node',
    async (kind) => {
      const source = server()
      const old = client('retired document rejects unproved CSS graph')
      await old.deliver(source.ownershipChange())
      await old.drain()
      source.document()
      if (kind === 'missing') source.modules.delete(wrapperPath)
      else source.modules.get(wrapperPath)!.isSelfAccepting = false
      const delivered = source.send(update(wrapperPath))
      expect(delivered.type).toBe('update')
      if (delivered.type !== 'update') throw new Error('Expected a normal server style update')
      expect(
        (delivered.updates[0] as unknown as Record<string, unknown>).lifeRendererStyleUpdate,
      ).not.toBe(true)
      await old.deliver(delivered)
      noJavaScriptWork(old)
    },
  )

  it('retains suppression after same-document websocket reconnect while a fresh module instance updates', async () => {
    const old = client('old reconnected websocket')
    await old.deliver({ type: 'full-reload', path: '*' })
    await old.drain()
    await old.deliver({ type: 'connected' })
    await old.deliver({ type: 'ping' })
    await old.deliver(update())
    const fresh = client('fresh client after reconnect')
    await fresh.deliver({ type: 'connected' })
    await fresh.deliver(update())
    expect(fresh.count('dispose')).toBe(1)
    noJavaScriptWork(old)
  })

  it('keeps the actual pagehide reconnect guard without mistaking prevented beforeunload for retirement', async () => {
    const document = client('native reload prevented, then actual pagehide')
    document.event('beforeunload')
    await document.deliver({
      type: 'custom',
      event: 'vite:ws:disconnect',
      data: { webSocket: { url: 'ws://life.test:5173/?token=fixture' } },
    })
    expect(document.count('ping')).toBe(1)
    expect(document.count('reload-prevented')).toBe(1)
    await document.deliver(update())
    noJavaScriptWork(document)
    document.event('pagehide')
    await document.deliver({
      type: 'custom',
      event: 'vite:ws:disconnect',
      data: { webSocket: { url: 'ws://life.test:5173/?token=fixture' } },
    })
    expect(document.count('ping')).toBe(1)
    expect(document.count('reload-prevented')).toBe(1)
    expect(document.snapshot()).toMatchObject({ willUnload: true })
  })

  it('retires on the installed error-overlay direct reload path', async () => {
    const old = client('error-overlay native reload prevented')
    old.overlay(true)
    await old.deliver(update())
    expect(old.count('reload-prevented')).toBe(1)
    old.overlay(false)
    const before = old.count('vite:beforeUpdate')
    await old.deliver(update())
    expect(old.count('vite:beforeUpdate')).toBe(before)
    expect(old.count('dispose')).toBe(0)
    expect(old.count('import')).toBe(0)
  })
})
