import { watch, type FSWatcher } from 'node:fs'
import { mkdir, readFile, rename, stat, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import {
  defaultLifeConfig,
  mergeLifeConfig,
  parseLifeConfig,
  type LifeConfig,
  type LifeConfigSnapshot,
} from '../shared/customization'

const clone = <T>(value: T): T => structuredClone(value)
const errorText = (error: unknown) => (error instanceof Error ? error.message : String(error))

/** Validated, live-reloaded settings and declarative extensions for the installed app. */
export class CustomizationStore {
  readonly path: string
  private config = clone(defaultLifeConfig)
  private revision = 0
  private history: LifeConfig[] = []
  private error?: string
  private watcher?: FSWatcher
  private debounce?: ReturnType<typeof setTimeout>
  private operations: Promise<unknown> = Promise.resolve()
  private closed = false

  constructor(
    private directory: string,
    private onUpdate: (state: LifeConfigSnapshot) => void = () => {},
  ) {
    this.path = join(directory, 'life.config.json')
  }

  async init(): Promise<LifeConfigSnapshot> {
    await mkdir(this.directory, { recursive: true })
    try {
      this.config = await this.read()
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') await this.write(this.config)
      else this.error = `Cannot load Life configuration: ${errorText(error)}`
    }
    this.revision = 1
    this.watcher = watch(this.directory, (_event, filename) => {
      if (filename && filename.toString() !== 'life.config.json') return
      clearTimeout(this.debounce)
      this.debounce = setTimeout(() => {
        this.queue(() => this.readUpdates()).catch(() => {})
      }, 100)
      this.debounce.unref()
    })
    this.watcher.on('error', (error) => {
      this.error = `Life configuration watcher stopped: ${errorText(error)}`
      this.emit()
    })
    this.watcher.unref()
    this.emit()
    return this.get()
  }

  get(): LifeConfigSnapshot {
    return {
      config: clone(this.config),
      revision: this.revision,
      canUndo: this.history.length > 0,
      path: this.path,
      ...(this.error ? { error: this.error } : {}),
    }
  }

  apply(patch: unknown): Promise<LifeConfigSnapshot> {
    return this.queue(async () => this.commit(mergeLifeConfig(this.config, patch)))
  }

  undo(): Promise<LifeConfigSnapshot> {
    return this.queue(async () => {
      const previous = this.history.at(-1)
      if (!previous) return this.get()
      await this.write(previous)
      this.history.pop()
      this.config = clone(previous)
      this.error = undefined
      this.revision += 1
      this.emit()
      return this.get()
    })
  }

  reset(): Promise<LifeConfigSnapshot> {
    return this.queue(async () => this.commit(clone(defaultLifeConfig)))
  }

  reload(): Promise<LifeConfigSnapshot> {
    return this.queue(() => this.readUpdates())
  }

  close() {
    this.closed = true
    clearTimeout(this.debounce)
    this.watcher?.close()
  }

  private queue<T>(operation: () => Promise<T>): Promise<T> {
    if (this.closed) return Promise.reject(new Error('Life customization store is closed'))
    const current = this.operations.catch(() => {}).then(operation)
    this.operations = current
    return current
  }

  private async read(): Promise<LifeConfig> {
    if ((await stat(this.path)).size > 1024 * 1024)
      throw new Error('Life configuration file must be smaller than 1 MB')
    const raw = await readFile(this.path, 'utf8')
    if (Buffer.byteLength(raw, 'utf8') > 1024 * 1024)
      throw new Error('Life configuration file must be smaller than 1 MB')
    return parseLifeConfig(JSON.parse(raw))
  }

  private async write(config: LifeConfig) {
    const temporary = `${this.path}.${process.pid}.tmp`
    await writeFile(temporary, JSON.stringify(config, null, 2) + '\n', { mode: 0o600 })
    await rename(temporary, this.path)
  }

  private remember() {
    this.history.push(clone(this.config))
    if (this.history.length > 20) this.history.shift()
  }

  private async commit(config: LifeConfig): Promise<LifeConfigSnapshot> {
    if (JSON.stringify(config) === JSON.stringify(this.config) && !this.error) return this.get()
    await this.write(config)
    this.remember()
    this.config = clone(config)
    this.error = undefined
    this.revision += 1
    this.emit()
    return this.get()
  }

  private async readUpdates(): Promise<LifeConfigSnapshot> {
    try {
      const config = await this.read()
      const changed = JSON.stringify(config) !== JSON.stringify(this.config)
      const hadError = Boolean(this.error)
      if (changed) {
        this.remember()
        this.config = config
        this.revision += 1
      }
      this.error = undefined
      if (changed || hadError) this.emit()
    } catch (error) {
      const message = `Cannot reload Life configuration: ${errorText(error)}`
      if (message !== this.error) {
        this.error = message
        this.emit()
      }
    }
    return this.get()
  }

  private emit() {
    if (!this.closed) this.onUpdate(this.get())
  }
}
