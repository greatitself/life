import { watch, type FSWatcher } from 'node:fs'
import { mkdir, readFile, readdir, rename, stat, unlink, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { Worker } from 'node:worker_threads'
import {
  extensionIdSchema,
  extensionMethodSchema,
  parseExtensionManifest,
  parseExtensionPayload,
  type LifeExtensionManifest,
  type LifeExtensionsSnapshot,
} from '../shared/extensions'

interface RuntimeCall {
  resolve: (value: unknown) => void
  reject: (error: Error) => void
  timeout: ReturnType<typeof setTimeout>
}

interface Runtime {
  worker: Worker
  ready: boolean
  intentional: boolean
  methods: Set<string>
  calls: Map<number, RuntimeCall>
  nextCall: number
  startResolve: () => void
  startReject: (error: Error) => void
  startTimeout?: ReturnType<typeof setTimeout>
}

interface ExtensionStoreOptions {
  startTimeoutMs?: number
  callTimeoutMs?: number
  watchDebounceMs?: number
}

const clone = <T>(value: T): T => structuredClone(value)
const message = (error: unknown) => (error instanceof Error ? error.message : String(error))

// This is a separate Node worker, intentionally permitted to use Node APIs. Renderer
// extensions run in an Electron iframe instead; neither runs in Life's main event loop.
const workerBootstrap = String.raw`
const { parentPort, workerData } = require('node:worker_threads')
const { createRequire } = require('node:module')
const extensionRequire = createRequire(workerData.filename)
const handlers = new Map()
const invokes = new Map()
const disposers = new Set()
let nextInvoke = 0
let activated = false
const validMethod = /^[a-zA-Z][a-zA-Z0-9_.:-]{0,119}$/
const text = error => error instanceof Error ? error.message : String(error)
const life = Object.freeze({
  handle(name, handler) {
    if (!validMethod.test(name) || typeof handler !== 'function') throw new Error('Invalid extension handler')
    if (handlers.has(name)) throw new Error('An extension handler is already registered: ' + name)
    handlers.set(name, handler)
    if (activated) parentPort.postMessage({ type: 'registered', method: name })
  },
  invoke(method, args = null) {
    if (!validMethod.test(method)) return Promise.reject(new Error('Invalid Life method'))
    const requestId = ++nextInvoke
    return new Promise((resolve, reject) => {
      invokes.set(requestId, { resolve, reject })
      parentPort.postMessage({ type: 'invoke', requestId, method, args })
    })
  },
  emit(event, data = null) {
    if (!validMethod.test(event)) throw new Error('Invalid extension event')
    parentPort.postMessage({ type: 'event', event, data })
  },
  onDispose(handler) {
    if (typeof handler !== 'function') throw new Error('An extension disposer must be a function')
    disposers.add(handler)
    return () => disposers.delete(handler)
  },
})
parentPort.on('message', async request => {
  if (request.type === 'dispose') {
    await Promise.allSettled([...disposers].map(handler => Promise.resolve().then(handler)))
    parentPort.postMessage({ type: 'disposed' })
    return
  }
  if (request.type === 'invoke-result') {
    const pending = invokes.get(request.requestId)
    if (!pending) return
    invokes.delete(request.requestId)
    request.error ? pending.reject(new Error(request.error)) : pending.resolve(request.result)
    return
  }
  if (request.type !== 'call') return
  try {
    const handler = handlers.get(request.method)
    if (!handler) throw new Error('Unknown extension method: ' + request.method)
    const result = await handler(request.args)
    parentPort.postMessage({ type: 'result', requestId: request.requestId, result: result === undefined ? null : result })
  } catch (error) {
    parentPort.postMessage({ type: 'result', requestId: request.requestId, error: text(error) })
  }
})
;(async () => {
  try {
    const AsyncFunction = Object.getPrototypeOf(async function () {}).constructor
    const run = new AsyncFunction('life', 'require', '__dirname', '__filename', workerData.code)
    await run(life, extensionRequire, workerData.directory, workerData.filename)
    activated = true
    parentPort.postMessage({ type: 'ready', methods: [...handlers.keys()] })
  } catch (error) {
    parentPort.postMessage({ type: 'startup-error', error: text(error) })
  }
})()
`

/** Executable extensions survive upgrades outside app.asar and reload without restarting Life. */
export class ExtensionStore {
  readonly path: string
  private manifests = new Map<string, LifeExtensionManifest>()
  private history = new Map<string, LifeExtensionManifest[]>()
  private runtimes = new Map<string, Runtime>()
  private errors: Record<string, string> = {}
  private revision = 0
  private recovered = false
  private closed = false
  private initialized = false
  private operations: Promise<unknown> = Promise.resolve()
  private watcher?: FSWatcher
  private debounce?: ReturnType<typeof setTimeout>

  constructor(
    directory: string,
    private onUpdate: (state: LifeExtensionsSnapshot) => void = () => {},
    private onInvoke: (
      extensionId: string,
      method: string,
      args: unknown,
    ) => Promise<unknown> = async () => {
      throw new Error('This Life method is unavailable')
    },
    private onEvent: (extensionId: string, event: string, data: unknown) => void = () => {},
    private options: ExtensionStoreOptions = {},
  ) {
    this.path = directory
  }

  async init(): Promise<LifeExtensionsSnapshot> {
    if (this.initialized) return this.get()
    this.initialized = true
    await mkdir(join(this.path, '.history'), { recursive: true })
    try {
      await stat(this.markerPath)
      this.recovered = true
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
    }
    for (const filename of await readdir(this.path)) {
      const id = this.fileId(filename)
      if (!id) continue
      try {
        const manifest = await this.readManifest(id)
        if (this.recovered && manifest.enabled) {
          manifest.enabled = false
          await this.writeManifest(manifest)
          this.errors[id] =
            'Recovery mode disabled this extension after Life did not close cleanly. Enable it to try again.'
        }
        this.manifests.set(id, manifest)
        await this.readHistory(id)
      } catch (error) {
        this.errors[id] = `Cannot load extension: ${message(error)}`
      }
    }
    await this.writeMarker()
    for (const manifest of this.manifests.values()) await this.activate(manifest)
    this.revision = 1
    this.watcher = watch(this.path, (_event, filename) => {
      if (filename && !this.fileId(filename.toString())) return
      clearTimeout(this.debounce)
      this.debounce = setTimeout(() => {
        this.queue(() => this.readUpdates()).catch(() => {})
      }, this.options.watchDebounceMs ?? 100)
      this.debounce.unref()
    })
    this.watcher.on('error', (error) => {
      this.errors.runtime = `Extension watcher stopped: ${message(error)}`
      this.emit()
    })
    this.watcher.unref()
    this.emit()
    return this.get()
  }

  get(): LifeExtensionsSnapshot {
    return {
      extensions: this.list(),
      revision: this.revision,
      path: this.path,
      errors: { ...this.errors },
      canRollback: [...this.history].filter(([, versions]) => versions.length).map(([id]) => id),
      recovered: this.recovered,
    }
  }

  list(): LifeExtensionManifest[] {
    return clone([...this.manifests.values()])
  }

  async apply(value: unknown): Promise<LifeExtensionsSnapshot> {
    const manifest = parseExtensionManifest(value)
    return this.queue(() => this.commit(manifest, true))
  }

  async enable(id: string, enabled: boolean): Promise<LifeExtensionsSnapshot> {
    extensionIdSchema.parse(id)
    if (typeof enabled !== 'boolean') throw new Error('Extension enabled state must be a boolean')
    return this.queue(async () => {
      const existing = this.requireManifest(id)
      return this.commit({ ...existing, enabled }, false)
    })
  }

  async remove(id: string): Promise<LifeExtensionsSnapshot> {
    extensionIdSchema.parse(id)
    return this.queue(async () => {
      await this.stopWorker(id)
      await this.deleteFile(this.manifestPath(id))
      await this.deleteFile(this.historyPath(id))
      this.manifests.delete(id)
      this.history.delete(id)
      delete this.errors[id]
      await this.writeMarker()
      this.revision += 1
      this.emit()
      return this.get()
    })
  }

  async rollback(id: string): Promise<LifeExtensionsSnapshot> {
    extensionIdSchema.parse(id)
    return this.queue(async () => {
      this.requireManifest(id)
      const versions = this.history.get(id) ?? []
      const previous = versions.at(-1)
      if (!previous) throw new Error('This extension has no earlier version')
      const nextHistory = versions.slice(0, -1)
      await this.writeHistory(id, nextHistory)
      this.history.set(id, nextHistory)
      return this.commit(previous, false)
    })
  }

  async call(id: string, method: string, args: unknown = null): Promise<unknown> {
    extensionIdSchema.parse(id)
    extensionMethodSchema.parse(method)
    parseExtensionPayload(args)
    if (this.closed) throw new Error('Life extension runtime is closed')
    const manifest = this.requireManifest(id)
    if (!manifest.enabled) throw new Error('This extension is disabled')
    const runtime = this.runtimes.get(id)
    if (!runtime?.ready) throw new Error('This extension has no active main worker')
    if (!runtime.methods.has(method)) throw new Error(`Unknown extension method: ${method}`)
    const requestId = ++runtime.nextCall
    return new Promise((resolve, reject) => {
      const timeout = setTimeout(() => {
        this.failWorker(id, runtime, new Error(`Extension method timed out: ${method}`))
      }, this.options.callTimeoutMs ?? 30000)
      runtime.calls.set(requestId, { resolve, reject, timeout })
      runtime.worker.postMessage({ type: 'call', requestId, method, args })
    })
  }

  async close(): Promise<void> {
    if (this.closed) return
    this.closed = true
    clearTimeout(this.debounce)
    this.watcher?.close()
    await this.operations.catch(() => {})
    await Promise.all([...this.runtimes.keys()].map((id) => this.stopWorker(id)))
    await this.deleteFile(this.markerPath)
  }

  private get markerPath() {
    return join(this.path, '.runtime-active.json')
  }

  private manifestPath(id: string) {
    return join(this.path, `${id}.json`)
  }

  private historyPath(id: string) {
    return join(this.path, '.history', `${id}.json`)
  }

  private fileId(filename: string): string | undefined {
    if (!filename.endsWith('.json')) return undefined
    const id = filename.slice(0, -5)
    return extensionIdSchema.safeParse(id).success ? id : undefined
  }

  private queue<T>(operation: () => Promise<T>): Promise<T> {
    if (this.closed) return Promise.reject(new Error('Life extension runtime is closed'))
    const current = this.operations.catch(() => {}).then(operation)
    this.operations = current
    return current
  }

  private requireManifest(id: string) {
    const existing = this.manifests.get(id)
    if (!existing) throw new Error('This extension is not installed')
    return existing
  }

  private async readManifest(id: string): Promise<LifeExtensionManifest> {
    const path = this.manifestPath(id)
    if ((await stat(path)).size > 500 * 1024)
      throw new Error('An extension must be smaller than 500 KB')
    const manifest = parseExtensionManifest(JSON.parse(await readFile(path, 'utf8')))
    if (manifest.id !== id) throw new Error('An extension ID must match its filename')
    return manifest
  }

  private async readHistory(id: string) {
    try {
      const path = this.historyPath(id)
      if ((await stat(path)).size > 11 * 1024 * 1024)
        throw new Error('Extension history is too large')
      const versions: unknown = JSON.parse(await readFile(path, 'utf8'))
      if (!Array.isArray(versions) || versions.length > 20)
        throw new Error('Invalid extension history')
      const history = versions.map(parseExtensionManifest)
      if (history.some((manifest) => manifest.id !== id))
        throw new Error('Invalid extension history ID')
      this.history.set(id, history)
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT')
        this.errors[id] = `Cannot load extension history: ${message(error)}`
    }
  }

  private async writeJson(path: string, value: unknown) {
    const temporary = `${path}.${process.pid}.tmp`
    await writeFile(temporary, JSON.stringify(value) + '\n', { mode: 0o600 })
    await rename(temporary, path)
  }

  private writeManifest(manifest: LifeExtensionManifest) {
    return this.writeJson(this.manifestPath(manifest.id), manifest)
  }

  private writeHistory(id: string, versions: LifeExtensionManifest[]) {
    return this.writeJson(this.historyPath(id), versions)
  }

  private async deleteFile(path: string) {
    try {
      await unlink(path)
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
    }
  }

  private async writeMarker() {
    const ids = this.list()
      .filter((manifest) => manifest.enabled)
      .map((manifest) => manifest.id)
    if (ids.length) await this.writeJson(this.markerPath, { ids })
    else await this.deleteFile(this.markerPath)
  }

  private async commit(
    manifest: LifeExtensionManifest,
    remember: boolean,
  ): Promise<LifeExtensionsSnapshot> {
    const previous = this.manifests.get(manifest.id)
    if (JSON.stringify(previous) === JSON.stringify(manifest) && !this.errors[manifest.id])
      return this.get()
    if (remember && previous) {
      const versions = [...(this.history.get(manifest.id) ?? []), clone(previous)].slice(-20)
      await this.writeHistory(manifest.id, versions)
      this.history.set(manifest.id, versions)
    }
    await this.writeManifest(manifest)
    await this.stopWorker(manifest.id)
    this.manifests.set(manifest.id, clone(manifest))
    delete this.errors[manifest.id]
    await this.writeMarker()
    await this.activate(manifest)
    this.revision += 1
    this.emit()
    return this.get()
  }

  private async activate(manifest: LifeExtensionManifest) {
    if (!manifest.enabled || !manifest.main?.trim()) return
    try {
      await this.startWorker(manifest)
    } catch (error) {
      await this.stopWorker(manifest.id)
      const disabled = { ...manifest, enabled: false }
      this.manifests.set(manifest.id, disabled)
      this.errors[manifest.id] = `Extension disabled: ${message(error)}`
      await this.writeManifest(disabled)
      await this.writeMarker()
    }
  }

  private async startWorker(manifest: LifeExtensionManifest) {
    let resolve!: () => void
    let reject!: (error: Error) => void
    const ready = new Promise<void>((res, rej) => {
      resolve = res
      reject = rej
    })
    const worker = new Worker(workerBootstrap, {
      eval: true,
      workerData: {
        id: manifest.id,
        code: manifest.main,
        directory: this.path,
        filename: this.manifestPath(manifest.id),
      },
      resourceLimits: { maxOldGenerationSizeMb: 96, stackSizeMb: 4 },
    })
    const runtime: Runtime = {
      worker,
      ready: false,
      intentional: false,
      methods: new Set(),
      calls: new Map(),
      nextCall: 0,
      startResolve: resolve,
      startReject: reject,
    }
    this.runtimes.set(manifest.id, runtime)
    runtime.startTimeout = setTimeout(() => {
      this.failWorker(manifest.id, runtime, new Error('Extension startup timed out'))
    }, this.options.startTimeoutMs ?? 5000)
    worker.on('message', (data: unknown) => {
      this.handleWorkerMessage(manifest.id, runtime, data)
    })
    worker.on('error', (error) => this.failWorker(manifest.id, runtime, error))
    worker.on('exit', (code) => {
      if (!runtime.intentional)
        this.failWorker(manifest.id, runtime, new Error(`Extension worker exited (${code})`))
    })
    await ready
  }

  private handleWorkerMessage(id: string, runtime: Runtime, value: unknown) {
    if (runtime.intentional || this.runtimes.get(id) !== runtime || this.closed) return
    try {
      parseExtensionPayload(value)
      if (!value || typeof value !== 'object' || Array.isArray(value))
        throw new Error('Invalid extension worker message')
      const data = value as Record<string, unknown>
      if (data.type === 'ready') {
        if (!Array.isArray(data.methods)) throw new Error('Invalid extension handler list')
        runtime.methods = new Set(data.methods.map((method) => extensionMethodSchema.parse(method)))
        runtime.ready = true
        clearTimeout(runtime.startTimeout)
        runtime.startResolve()
      } else if (data.type === 'registered') {
        runtime.methods.add(extensionMethodSchema.parse(data.method))
      } else if (data.type === 'startup-error') {
        throw new Error(typeof data.error === 'string' ? data.error : 'Extension startup failed')
      } else if (data.type === 'result') {
        if (typeof data.requestId !== 'number') throw new Error('Invalid extension request ID')
        const call = runtime.calls.get(data.requestId)
        if (!call) return
        const result =
          typeof data.error === 'string' ? undefined : parseExtensionPayload(data.result)
        runtime.calls.delete(data.requestId)
        clearTimeout(call.timeout)
        if (typeof data.error === 'string') call.reject(new Error(data.error))
        else call.resolve(result)
      } else if (data.type === 'invoke') {
        const method = extensionMethodSchema.parse(data.method)
        if (typeof data.requestId !== 'number') throw new Error('Invalid extension request ID')
        const args = parseExtensionPayload(data.args)
        const requestId = data.requestId
        Promise.resolve()
          .then(() => this.onInvoke(id, method, args))
          .then(
            (result) => {
              if (runtime.intentional || this.runtimes.get(id) !== runtime) return
              runtime.worker.postMessage({
                type: 'invoke-result',
                requestId,
                result: parseExtensionPayload(result === undefined ? null : result),
              })
            },
            (error) => {
              if (!runtime.intentional && this.runtimes.get(id) === runtime)
                runtime.worker.postMessage({
                  type: 'invoke-result',
                  requestId,
                  error: message(error),
                })
            },
          )
          .catch((error) => {
            if (!runtime.intentional && this.runtimes.get(id) === runtime)
              runtime.worker.postMessage({
                type: 'invoke-result',
                requestId,
                error: message(error),
              })
          })
      } else if (data.type === 'event') {
        this.onEvent(id, extensionMethodSchema.parse(data.event), parseExtensionPayload(data.data))
      } else throw new Error('Unknown extension worker message')
    } catch (error) {
      this.failWorker(id, runtime, new Error(message(error)))
    }
  }

  private failWorker(id: string, runtime: Runtime, error: Error) {
    if (runtime.intentional) return
    const wasReady = runtime.ready
    runtime.intentional = true
    clearTimeout(runtime.startTimeout)
    runtime.startReject(error)
    for (const call of runtime.calls.values()) {
      clearTimeout(call.timeout)
      call.reject(error)
    }
    runtime.calls.clear()
    if (this.runtimes.get(id) === runtime) this.runtimes.delete(id)
    runtime.worker.terminate().catch(() => {})
    if (!wasReady || this.closed) return
    this.queue(async () => {
      const existing = this.manifests.get(id)
      if (!existing || this.runtimes.has(id)) return
      const disabled = { ...existing, enabled: false }
      await this.writeManifest(disabled)
      this.manifests.set(id, disabled)
      this.errors[id] = `Extension disabled: ${error.message}`
      await this.writeMarker()
      this.revision += 1
      this.emit()
    }).catch(() => {})
  }

  private async stopWorker(id: string) {
    const runtime = this.runtimes.get(id)
    if (!runtime) return
    runtime.intentional = true
    this.runtimes.delete(id)
    clearTimeout(runtime.startTimeout)
    runtime.startReject(new Error('Extension reloaded or stopped'))
    for (const call of runtime.calls.values()) {
      clearTimeout(call.timeout)
      call.reject(new Error('Extension reloaded or stopped'))
    }
    runtime.calls.clear()
    // Give cooperative extensions a short opportunity to stop child processes or flush
    // files. Unresponsive workers still terminate, so teardown cannot strand the app.
    let timeout: ReturnType<typeof setTimeout> | undefined
    let onDisposed: (data: unknown) => void = () => {}
    const disposed = new Promise<void>((resolve) => {
      onDisposed = (data) => {
        if (
          data &&
          typeof data === 'object' &&
          !Array.isArray(data) &&
          (data as Record<string, unknown>).type === 'disposed'
        )
          resolve()
      }
      runtime.worker.on('message', onDisposed)
      timeout = setTimeout(resolve, 500)
    })
    runtime.worker.postMessage({ type: 'dispose' })
    await disposed
    clearTimeout(timeout)
    runtime.worker.off('message', onDisposed)
    await runtime.worker.terminate()
  }

  private async readUpdates(): Promise<LifeExtensionsSnapshot> {
    const ids = new Set<string>()
    for (const filename of await readdir(this.path)) {
      const id = this.fileId(filename)
      if (!id) continue
      ids.add(id)
      try {
        const manifest = await this.readManifest(id)
        if (JSON.stringify(manifest) !== JSON.stringify(this.manifests.get(id)))
          await this.commit(manifest, true)
        else if (this.errors[id]?.startsWith('Cannot reload extension:')) {
          delete this.errors[id]
          this.emit()
        }
      } catch (error) {
        this.errors[id] = `Cannot reload extension: ${message(error)}`
        this.emit()
      }
    }
    for (const id of this.manifests.keys()) {
      if (ids.has(id)) continue
      await this.stopWorker(id)
      this.manifests.delete(id)
      delete this.errors[id]
      this.revision += 1
      await this.writeMarker()
      this.emit()
    }
    return this.get()
  }

  private emit() {
    if (!this.closed) this.onUpdate(this.get())
  }
}
