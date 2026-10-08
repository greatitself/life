import { spawn } from 'node:child_process'
import { createHash } from 'node:crypto'
import { existsSync, realpathSync, statSync } from 'node:fs'
import {
  copyFile,
  mkdir,
  readdir,
  readFile,
  rename,
  rm,
  stat,
  symlink,
  unlink,
  writeFile,
} from 'node:fs/promises'
import { createRequire } from 'node:module'
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path'
import { z } from 'zod'
import { Worker } from 'node:worker_threads'
import {
  lifeSourcePathSchema,
  parseLifeSourcePatch,
  parseLifeSourceRead,
  type LifeSourceAsset,
  type LifeSourceContext,
  type LifeSourcePatch,
  type LifeSourceRead,
  type LifeSourceSnapshot,
} from '../shared/source-code'

export interface SourceCodeStoreOptions {
  /** Package-root shape: src/renderer, src/shared, and read-only src/main, src/preload. */
  sourceDir: string
  /** Real filesystem directory, outside app.asar, for esbuild and the bundled dependencies. */
  nodeModulesDir: string
  directory: string
  onUpdate?: (state: LifeSourceSnapshot) => void
  compilerTimeoutMs?: number
  installTimeoutMs?: number
}

const stateSchema = z
  .object({
    format: z.literal(1),
    revision: z.number().int().min(0),
    current: z.number().int().min(1).nullable(),
    history: z.array(z.number().int().min(1).nullable()).max(5),
    enabled: z.boolean(),
    error: z.string().optional(),
    failed: z.array(z.number().int().min(1)).max(100).default([]),
  })
  .strict()
type SavedState = z.infer<typeof stateSchema>

const metadataSchema = z
  .object({
    summary: z.string(),
    dependencies: z.record(z.string(), z.string()),
    baseFingerprint: z.string(),
    baseHashes: z.record(z.string(), z.string()).default({}),
  })
  .strict()
type Metadata = z.infer<typeof metadataSchema>

const explain = (error: unknown) => (error instanceof Error ? error.message : String(error))
const contained = (root: string, file: string) => {
  const path = relative(root, file)
  return !isAbsolute(path) && path !== '..' && !path.startsWith(`..${sep}`)
}
const defaultState = (): SavedState => ({
  format: 1,
  revision: 0,
  current: null,
  history: [],
  enabled: false,
  failed: [],
})

const tailwindWorker = String.raw`
const { parentPort, workerData } = require('node:worker_threads')
const { createRequire } = require('node:module')
const { join } = require('node:path')
;(async () => {
  try {
    const load = createRequire(join(workerData.modules, '@tailwindcss/postcss/package.json'))
    const postcssModule = load('postcss')
    const tailwindModule = load('@tailwindcss/postcss')
    const postcss = postcssModule.default || postcssModule
    const tailwind = tailwindModule.default || tailwindModule
    const result = await postcss([tailwind({ base: workerData.base, optimize: false })])
      .process(workerData.css, { from: workerData.filename, map: false })
    parentPort.postMessage({ css: result.css })
  } catch (error) {
    parentPort.postMessage({ error: error instanceof Error ? error.message : String(error) })
  }
})()
`

const hasTailwindDirectives = (css: string) =>
  /@import\s+(?:url\(\s*)?["']tailwindcss(?:["'/]|\s)/i.test(css) ||
  /@(?:tailwind|theme|apply|source|utility|variant|custom-variant|reference)\b/i.test(css)

/**
 * Life's editable React application lives outside the installed executable. New source is
 * compiled in an immutable staging generation. Only a successful build can become active;
 * the native host, preload, and renderer bootstrap always remain the installed rescue copy.
 */
export class SourceCodeStore {
  readonly path: string
  private state = defaultState()
  private metadata?: Metadata
  private recovered = false
  private initialized = false
  private closed = false
  private operations: Promise<unknown> = Promise.resolve()
  private baselineDependencies: Record<string, string> = {}
  private baselineFingerprint = ''
  private baselineHashes: Record<string, string> = {}
  private operationEpoch = 0
  private activeController?: AbortController

  constructor(private options: SourceCodeStoreOptions) {
    this.path = resolve(options.directory)
  }

  async init(): Promise<LifeSourceSnapshot> {
    if (this.initialized) return this.get()
    this.initialized = true
    await mkdir(join(this.path, 'revisions'), { recursive: true })
    await mkdir(join(this.path, 'packages'), { recursive: true })
    try {
      const packageFile = JSON.parse(
        await readFile(join(this.options.sourceDir, 'package.json'), 'utf8'),
      )
      this.baselineDependencies = packageFile.dependencies || {}
    } catch {
      this.baselineDependencies = {}
    }
    const baseline = await this.listSource(this.options.sourceDir)
    const fingerprint = createHash('sha256')
    if (existsSync(join(this.options.sourceDir, 'package.json')))
      fingerprint
        .update('package.json')
        .update(await readFile(join(this.options.sourceDir, 'package.json')))
    for (const path of baseline.filter(
      (path) => path.startsWith('src/renderer/') || path.startsWith('src/shared/'),
    )) {
      const content = await readFile(join(this.options.sourceDir, path))
      fingerprint.update(path).update(content)
      this.baselineHashes[path] = this.hash(content)
    }
    this.baselineFingerprint = fingerprint.digest('hex')
    try {
      this.state = stateSchema.parse(JSON.parse(await readFile(this.statePath, 'utf8')))
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT')
        this.state = {
          ...defaultState(),
          error: `Life restored its built-in interface because the saved source could not load: ${explain(error)}`,
        }
    }
    if (this.state.current !== null) {
      try {
        this.metadata = await this.readMetadata(this.state.current)
        await stat(join(this.generation(this.state.current), 'dist', 'entry.js'))
        if (this.metadata.baseFingerprint !== this.baselineFingerprint) {
          this.state = {
            ...this.state,
            revision: this.state.revision + 1,
            enabled: false,
            error:
              'Life was updated after this customization was built. Your source edits are preserved. Ask /life to update your customization for the current Life version; unchanged files are refreshed automatically when rebuilding.',
          }
          await this.writeState(this.state)
        }
      } catch (error) {
        this.state = {
          ...this.state,
          revision: this.state.revision + 1,
          enabled: false,
          error: `Life restored its built-in interface because a saved build could not load. Your source edits are preserved: ${explain(error)}`,
        }
        await this.writeState(this.state)
      }
    }
    if (existsSync(this.markerPath) && this.state.enabled) {
      this.recovered = true
      this.state = {
        ...this.state,
        revision: this.state.revision + 1,
        enabled: false,
        error:
          'Recovery restored Life’s built-in interface after the customized application did not close cleanly. Your source changes are preserved.',
      }
      await this.writeState(this.state)
    }
    await writeFile(this.markerPath, String(process.pid), 'utf8')
    this.emit()
    return this.get()
  }

  get(): LifeSourceSnapshot {
    return {
      revision: this.state.revision,
      enabled: this.state.enabled,
      ...(this.state.enabled && this.state.current !== null
        ? { active: this.assets(this.state.current) }
        : {}),
      canRollback: this.state.history.length > 0,
      path: this.path,
      ...(this.state.error ? { error: this.state.error } : {}),
      recovered: this.recovered,
      ...(this.metadata ? { summary: this.metadata.summary } : {}),
      ...(this.metadata && this.metadata.baseFingerprint !== this.baselineFingerprint
        ? { baseChanged: true }
        : {}),
    }
  }

  async getContext(request?: LifeSourceRead): Promise<LifeSourceContext> {
    if (request !== undefined) request = parseLifeSourceRead(request)
    await this.operations
    const source =
      this.state.current === null ? this.options.sourceDir : this.generation(this.state.current)
    const revision = this.state.revision
    const snapshot = this.get()
    const dependencies = { ...this.baselineDependencies, ...this.metadata?.dependencies }
    const writable = await this.listSource(source)
    const native = await this.listSource(this.options.sourceDir)
    const paths = [
      ...new Set([
        ...writable.filter(
          (path) => path.startsWith('src/renderer/') || path.startsWith('src/shared/'),
        ),
        ...native.filter(
          (path) =>
            path.startsWith('src/main/') ||
            path.startsWith('src/preload/') ||
            path === 'package.json',
        ),
      ]),
    ].sort()
    const selected =
      request?.paths ||
      ['src/shared/types.ts', 'src/shared/source-code.ts'].filter((path) => paths.includes(path))
    const files: Array<{ path: string; content: string }> = []
    const baselineFiles: Array<{ path: string; content: string }> = []
    let bytes = 0
    for (const path of selected) {
      if (!paths.includes(path))
        throw new Error(
          `Life source file does not exist: ${path}. Choose a path from the source index.`,
        )
      const root =
        path.startsWith('src/main/') || path.startsWith('src/preload/') || path === 'package.json'
          ? this.options.sourceDir
          : source
      const content = await readFile(join(root, path), 'utf8')
      bytes += Buffer.byteLength(content)
      if (bytes > 1_500_000)
        throw new Error(
          'The requested source context exceeds 1.5 MB. Read fewer files in each step.',
        )
      files.push({ path, content })
      if (snapshot.baseChanged && this.baselineHashes[path] && root !== this.options.sourceDir) {
        const baseline = await readFile(join(this.options.sourceDir, path), 'utf8')
        if (baseline !== content) baselineFiles.push({ path, content: baseline })
      }
    }
    return {
      revision,
      paths,
      files,
      dependencies,
      snapshot,
      ...(baselineFiles.length ? { baselineFiles } : {}),
    }
  }

  async apply(value: unknown): Promise<LifeSourceSnapshot> {
    const patch = parseLifeSourcePatch(value)
    const epoch = this.operationEpoch
    return this.queue(async () => {
      if (epoch !== this.operationEpoch)
        throw new Error('Life source application was cancelled by recovery.')
      if (patch.baseRevision !== this.state.revision)
        throw new Error(
          `Life source changed since the proposal was written (proposal revision ${patch.baseRevision}, current revision ${this.state.revision}). Read the current source and regenerate the patch.`,
        )
      const nextRevision = this.state.revision + 1
      const controller = new AbortController()
      this.activeController = controller
      const signal = controller.signal
      const staging = join(
        this.path,
        'revisions',
        `.staging-${nextRevision}-${createHash('sha256')
          .update(String(Date.now()) + String(Math.random()))
          .digest('hex')
          .slice(0, 12)}`,
      )
      try {
        const currentSource =
          this.state.current === null ? this.options.sourceDir : this.generation(this.state.current)
        await mkdir(staging, { recursive: true })
        const currentPaths = (await this.listSource(currentSource)).filter(
          (path) => path.startsWith('src/renderer/') || path.startsWith('src/shared/'),
        )
        for (const path of currentPaths) {
          signal.throwIfAborted()
          if (!path.startsWith('src/renderer/') && !path.startsWith('src/shared/')) continue
          const target = join(staging, path)
          let original = join(currentSource, path)
          if (
            this.metadata?.baseFingerprint !== this.baselineFingerprint &&
            this.metadata?.baseHashes[path]
          ) {
            const currentHash = this.hash(await readFile(original))
            if (currentHash === this.metadata.baseHashes[path]) {
              if (!this.baselineHashes[path]) continue
              original = join(this.options.sourceDir, path)
            }
          }
          await mkdir(dirname(target), { recursive: true })
          await copyFile(original, target)
        }
        if (this.metadata && this.metadata.baseFingerprint !== this.baselineFingerprint) {
          for (const path of Object.keys(this.baselineHashes)) {
            if (currentPaths.includes(path) || this.metadata.baseHashes[path]) continue
            const target = join(staging, path)
            await mkdir(dirname(target), { recursive: true })
            await copyFile(join(this.options.sourceDir, path), target)
          }
        }
        // Shared version metadata imports ../../package.json. The installed manifest is
        // copied as read-only build input, so an override cannot rewrite app identity.
        if (existsSync(join(this.options.sourceDir, 'package.json')))
          await copyFile(
            join(this.options.sourceDir, 'package.json'),
            join(staging, 'package.json'),
          )
        const stagedPaths = new Map(
          (await this.listSource(staging)).map((path) => [path.toLowerCase(), path]),
        )
        for (const change of patch.files) {
          const existing = stagedPaths.get(change.path.toLowerCase())
          if (existing && existing !== change.path)
            throw new Error(
              `Source path ${change.path} aliases the existing ${existing} on Windows. Use the exact path from Life’s source index.`,
            )
          await this.changeFile(staging, change)
        }
        signal.throwIfAborted()
        const dependencies = { ...this.metadata?.dependencies, ...patch.dependencies }
        const packageModules = await this.installDependencies(dependencies, signal)
        signal.throwIfAborted()
        await this.compile(staging, packageModules, dependencies, signal)
        signal.throwIfAborted()
        const metadata: Metadata = {
          summary: patch.summary,
          dependencies,
          baseFingerprint: this.baselineFingerprint,
          baseHashes: { ...this.baselineHashes },
        }
        await writeFile(join(staging, 'metadata.json'), JSON.stringify(metadata), 'utf8')
        signal.throwIfAborted()
        const destination = this.generation(nextRevision)
        if (existsSync(destination))
          throw new Error(
            `A source generation already exists for revision ${nextRevision}; recover Life’s source state before applying again.`,
          )
        await rename(staging, destination)
        const next: SavedState = {
          format: 1,
          revision: nextRevision,
          current: nextRevision,
          history:
            this.state.current !== null && this.state.failed.includes(this.state.current)
              ? [...this.state.history]
              : [...this.state.history, this.state.current].slice(-5),
          enabled: true,
          failed: [...this.state.failed],
        }
        try {
          signal.throwIfAborted()
          await this.writeState(next)
        } catch (error) {
          await rm(destination, { recursive: true, force: true })
          throw error
        }
        this.state = next
        this.metadata = metadata
        this.recovered = false
        this.emit()
        return this.get()
      } catch (error) {
        await rm(staging, { recursive: true, force: true }).catch(() => {})
        this.state.error = explain(error)
        this.emit()
        throw new Error(explain(error))
      } finally {
        if (this.activeController === controller) this.activeController = undefined
      }
    })
  }

  async rollback(): Promise<LifeSourceSnapshot> {
    this.cancelActive('Life source application was cancelled to restore a previous version.')
    return this.queue(async () => {
      if (!this.state.history.length)
        throw new Error('There is no previous Life source version to restore.')
      const history = [...this.state.history]
      let previous = history.pop()!
      while (previous !== null && this.state.failed.includes(previous)) {
        if (!history.length)
          throw new Error(
            'There is no working previous Life source version to restore. Disable source changes to use Life’s built-in interface.',
          )
        previous = history.pop()!
      }
      const metadata = previous === null ? undefined : await this.readMetadata(previous)
      const next: SavedState = {
        format: 1,
        revision: this.state.revision + 1,
        current: previous,
        history,
        enabled: previous !== null,
        failed: [...this.state.failed],
      }
      await this.writeState(next)
      this.state = next
      this.metadata = metadata
      this.recovered = false
      this.emit()
      return this.get()
    })
  }

  async disable(reason?: string): Promise<LifeSourceSnapshot> {
    this.cancelActive('Life source application was cancelled by recovery.')
    return this.queue(async () => {
      const next: SavedState = {
        ...this.state,
        revision: this.state.revision + 1,
        enabled: false,
        error: reason ? reason.slice(0, 5000) : undefined,
        ...(reason && this.state.enabled && this.state.current !== null
          ? { failed: [...new Set([...this.state.failed, this.state.current])].slice(-100) }
          : {}),
      }
      await this.writeState(next)
      this.state = next
      this.emit()
      return this.get()
    })
  }

  /** Resolve only assets belonging to a committed source generation, never source or staging files. */
  assetPath(value: string): string | null {
    let pathname = value
    try {
      if (value.includes('://')) {
        if (/(?:\/|%2f)(?:\.{1,2}|%2e(?:%2e)?|\.%2e|%2e\.)(?:\/|%2f|$)/i.test(value)) return null
        const url = new URL(value)
        if (url.protocol !== 'life-code:' || url.hostname !== 'runtime') return null
        pathname = url.pathname
      }
      pathname = decodeURIComponent(pathname)
    } catch {
      return null
    }
    if (pathname.includes('\\') || pathname.includes('\0')) return null
    const parts = pathname.replace(/^\//, '').split('/')
    const revision = Number(parts.shift())
    if (
      !Number.isInteger(revision) ||
      revision < 1 ||
      !parts.length ||
      parts.some((part) => !part || part === '.' || part === '..')
    )
      return null
    if (this.state.current !== revision && !this.state.history.includes(revision)) return null
    const root = join(this.generation(revision), 'dist')
    const file = join(root, ...parts)
    try {
      const actualRoot = realpathSync(root)
      const actualFile = realpathSync(file)
      if (!contained(actualRoot, actualFile) || !statSync(actualFile).isFile()) return null
      return actualFile
    } catch {
      return null
    }
  }

  async close(): Promise<void> {
    if (this.closed) return
    this.closed = true
    this.cancelActive('Life source application was cancelled because Life is closing.')
    await this.operations.catch(() => {})
    await unlink(this.markerPath).catch((error: NodeJS.ErrnoException) => {
      if (error.code !== 'ENOENT') throw error
    })
  }

  private get statePath() {
    return join(this.path, 'state.json')
  }
  private get markerPath() {
    return join(this.path, '.running')
  }
  private generation(revision: number) {
    return join(this.path, 'revisions', String(revision))
  }
  private hash(content: Buffer | string) {
    return createHash('sha256').update(content).digest('hex')
  }
  private cancelActive(reason: string) {
    this.operationEpoch++
    this.activeController?.abort(new Error(reason))
  }

  private queue<T>(operation: () => Promise<T>): Promise<T> {
    if (this.closed) return Promise.reject(new Error('Life source runtime is closed'))
    const next = this.operations.then(operation, operation)
    this.operations = next.catch(() => {})
    return next
  }

  private emit() {
    try {
      this.options.onUpdate?.(this.get())
    } catch {
      /* Observers cannot invalidate a committed build. */
    }
  }

  private assets(revision: number): LifeSourceAsset {
    return {
      revision,
      js: `life-code://runtime/${revision}/entry.js`,
      ...(existsSync(join(this.generation(revision), 'dist', 'entry.css'))
        ? { css: `life-code://runtime/${revision}/entry.css` }
        : {}),
    }
  }

  private async writeState(state: SavedState) {
    const temporary = `${this.statePath}.tmp`
    await writeFile(temporary, JSON.stringify(state), 'utf8')
    await rename(temporary, this.statePath)
  }

  private async readMetadata(revision: number): Promise<Metadata> {
    return metadataSchema.parse(
      JSON.parse(await readFile(join(this.generation(revision), 'metadata.json'), 'utf8')),
    )
  }

  private async listSource(root: string): Promise<string[]> {
    const paths: string[] = []
    const visit = async (directory: string) => {
      let entries
      try {
        entries = await readdir(directory, { withFileTypes: true })
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === 'ENOENT') return
        throw error
      }
      for (const entry of entries) {
        const absolute = join(directory, entry.name)
        if (entry.isDirectory()) await visit(absolute)
        else if (entry.isFile()) {
          const path = relative(root, absolute).split(sep).join('/')
          if (lifeSourcePathSchema.safeParse(path).success) paths.push(path)
        }
      }
    }
    for (const directory of ['renderer', 'shared', 'main', 'preload'])
      await visit(join(root, 'src', directory))
    if (existsSync(join(root, 'package.json'))) paths.push('package.json')
    return paths.sort()
  }

  private async changeFile(root: string, change: LifeSourcePatch['files'][number]) {
    const file = join(root, change.path)
    if (change.content === null) {
      await unlink(file).catch((error: NodeJS.ErrnoException) => {
        if (error.code !== 'ENOENT') throw error
      })
      return
    }
    let content = change.content
    if (change.edits) {
      try {
        content = await readFile(file, 'utf8')
      } catch (error) {
        throw new Error(
          `Cannot edit ${change.path}: ${explain(error)}. Read the current file or provide content to create it.`,
        )
      }
      for (const edit of change.edits) {
        const first = content.indexOf(edit.find)
        if (first === -1)
          throw new Error(
            `Source edit did not match ${change.path}. Read its current content and use an exact find string.`,
          )
        if (content.indexOf(edit.find, first + 1) !== -1)
          throw new Error(
            `Source edit is ambiguous in ${change.path}. The find string must match exactly once.`,
          )
        content = content.slice(0, first) + edit.replace + content.slice(first + edit.find.length)
      }
    }
    await mkdir(dirname(file), { recursive: true })
    await writeFile(file, content!, 'utf8')
  }

  private async installDependencies(
    dependencies: Record<string, string>,
    signal: AbortSignal,
  ): Promise<string | undefined> {
    if (!Object.keys(dependencies).length) return undefined
    const sorted = Object.fromEntries(
      Object.entries(dependencies).sort(([left], [right]) => left.localeCompare(right)),
    )
    const key = createHash('sha256').update(JSON.stringify(sorted)).digest('hex').slice(0, 24)
    const directory = join(this.path, 'packages', key)
    const marker = join(directory, '.complete')
    if (existsSync(marker)) return join(directory, 'node_modules')
    await mkdir(directory, { recursive: true })
    await writeFile(
      join(directory, 'package.json'),
      JSON.stringify({
        name: 'life-local-customization',
        private: true,
        version: '1.0.0',
        dependencies: sorted,
      }),
      'utf8',
    )
    const npm = join(this.options.nodeModulesDir, 'npm', 'bin', 'npm-cli.js')
    if (!existsSync(npm))
      throw new Error(
        'Life’s bundled npm installer is missing. Install the latest Life release before adding packages.',
      )
    await new Promise<void>((done, failed) => {
      signal.throwIfAborted()
      const child = spawn(
        process.execPath,
        [
          npm,
          'install',
          '--ignore-scripts',
          '--no-audit',
          '--no-fund',
          '--package-lock=false',
          '--registry=https://registry.npmjs.org',
        ],
        {
          cwd: directory,
          windowsHide: true,
          env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' },
          stdio: ['ignore', 'pipe', 'pipe'],
        },
      )
      let output = ''
      let stopped: Error | undefined
      let forceStop: ReturnType<typeof setTimeout> | undefined
      const stop = (error: Error) => {
        stopped = error
        child.kill()
        forceStop = setTimeout(() => {
          child.kill('SIGKILL')
        }, 1500)
      }
      const abort = () =>
        stop(
          signal.reason instanceof Error
            ? signal.reason
            : new Error('Life package installation was cancelled.'),
        )
      signal.addEventListener('abort', abort, { once: true })
      const append = (chunk: Buffer) => {
        output = (output + chunk.toString()).slice(-30_000)
      }
      child.stdout.on('data', append)
      child.stderr.on('data', append)
      const timeout = setTimeout(
        () =>
          stop(
            new Error(
              'Life package installation timed out. Try a smaller dependency change or check the network.',
            ),
          ),
        this.options.installTimeoutMs ?? 120_000,
      )
      child.once('error', (error) => {
        clearTimeout(timeout)
        clearTimeout(forceStop)
        signal.removeEventListener('abort', abort)
        failed(new Error(`Life package installation could not start: ${explain(error)}`))
      })
      child.once('close', (code) => {
        clearTimeout(timeout)
        clearTimeout(forceStop)
        signal.removeEventListener('abort', abort)
        if (stopped) failed(stopped)
        else
          code === 0
            ? done()
            : failed(new Error(`Life package installation failed (${code}):\n${output}`))
      })
    })
    await writeFile(marker, 'installed', 'utf8')
    return join(directory, 'node_modules')
  }

  private async compile(
    directory: string,
    packageModules: string | undefined,
    dependencies: Record<string, string>,
    signal: AbortSignal,
  ) {
    // Loading the JS library from the real unpacked path also gives esbuild a real native
    // executable path. A binary outside Electron cannot resolve packages inside app.asar.
    const requireCompiler = createRequire(
      join(this.options.nodeModulesDir, 'esbuild', 'package.json'),
    )
    const compiler = requireCompiler(
      join(this.options.nodeModulesDir, 'esbuild', 'lib', 'main.js'),
    ) as typeof import('esbuild')
    const tailwindInstalled = Boolean(
      packageModules &&
      dependencies['@tailwindcss/postcss'] &&
      dependencies.postcss &&
      dependencies.tailwindcss,
    )
    if (tailwindInstalled) {
      // Tailwind's official PostCSS loader resolves CSS imports using the source
      // filesystem. A junction on Windows does not require administrator privileges.
      await symlink(
        packageModules!,
        join(directory, 'node_modules'),
        process.platform === 'win32' ? 'junction' : 'dir',
      )
    }
    const transformTailwind = (css: string, filename: string) =>
      this.transformTailwindCSS(css, filename, directory, packageModules!, signal)
    const context = await compiler.context({
      absWorkingDir: directory,
      entryPoints: { entry: join(directory, 'src', 'renderer', 'main.tsx') },
      outdir: join(directory, 'dist'),
      bundle: true,
      format: 'esm',
      platform: 'browser',
      target: ['es2022'],
      jsx: 'automatic',
      minify: true,
      legalComments: 'none',
      nodePaths: [...(packageModules ? [packageModules] : []), this.options.nodeModulesDir],
      define: { 'process.env.NODE_ENV': '"production"', __LIFE_SOURCE_BUILD__: 'true' },
      loader: {
        '.svg': 'file',
        '.png': 'file',
        '.jpg': 'file',
        '.jpeg': 'file',
        '.gif': 'file',
        '.webp': 'file',
        '.ico': 'file',
        '.woff': 'file',
        '.woff2': 'file',
        '.ttf': 'file',
        '.eot': 'file',
      },
      assetNames: 'assets/[name]-[hash]',
      logLevel: 'silent',
      plugins: [
        {
          name: 'life-tailwind-postcss',
          setup(build) {
            build.onLoad({ filter: /\.css$/ }, async (args) => {
              const css = await readFile(args.path, 'utf8')
              if (!hasTailwindDirectives(css)) return undefined
              if (!tailwindInstalled)
                throw new Error(
                  'This stylesheet uses Tailwind directives. Add tailwindcss, @tailwindcss/postcss, and postcss dependencies to the Life source proposal so their utilities are compiled.',
                )
              const contents = await transformTailwind(css, args.path)
              return { contents, loader: 'css', resolveDir: dirname(args.path) }
            })
          },
        },
        {
          name: 'life-single-react-runtime',
          setup(build) {
            build.onResolve({ filter: /^(?:react|react-dom)(?:\/.*)?$/ }, (args) => {
              const name = args.path.startsWith('react-dom') ? 'react-dom' : 'react'
              const modules =
                packageModules && dependencies[name]
                  ? packageModules
                  : build.initialOptions.nodePaths!.at(-1)!
              const requirePackage = createRequire(join(modules, name, 'package.json'))
              return { path: requirePackage.resolve(args.path) }
            })
          },
        },
      ],
    })
    const abort = () => {
      void context.cancel()
    }
    signal.addEventListener('abort', abort, { once: true })
    let timeout: ReturnType<typeof setTimeout> | undefined
    try {
      signal.throwIfAborted()
      await Promise.race([
        context.rebuild(),
        new Promise<never>((_done, failed) => {
          timeout = setTimeout(
            () =>
              failed(
                new Error('Life source compilation timed out. Simplify the change and try again.'),
              ),
            this.options.compilerTimeoutMs ?? 60_000,
          )
        }),
      ])
    } catch (error) {
      await context.cancel()
      const messages = (error as { errors?: import('esbuild').Message[] }).errors
      const diagnostics = messages?.length
        ? (await compiler.formatMessages(messages, { kind: 'error', color: false })).join('\n')
        : explain(error)
      throw new Error(
        `Life source build failed. The previous application is still active.\n${diagnostics}`,
      )
    } finally {
      clearTimeout(timeout)
      signal.removeEventListener('abort', abort)
      await context.dispose()
    }
  }

  private async transformTailwindCSS(
    css: string,
    filename: string,
    base: string,
    modules: string,
    signal: AbortSignal,
  ): Promise<string> {
    signal.throwIfAborted()
    return new Promise<string>((done, failed) => {
      const worker = new Worker(tailwindWorker, {
        eval: true,
        workerData: { css, filename, base: join(base, 'src'), modules },
      })
      let settled = false
      const finish = (value?: string, error?: Error) => {
        if (settled) return
        settled = true
        clearTimeout(timeout)
        signal.removeEventListener('abort', abort)
        void worker.terminate()
        error ? failed(error) : done(value!)
      }
      const abort = () =>
        finish(
          undefined,
          signal.reason instanceof Error
            ? signal.reason
            : new Error('Life Tailwind compilation was cancelled.'),
        )
      const timeout = setTimeout(
        () =>
          finish(
            undefined,
            new Error(
              'Life Tailwind compilation timed out. Simplify the stylesheet or source scan.',
            ),
          ),
        Math.min(this.options.compilerTimeoutMs ?? 60_000, 30_000),
      )
      signal.addEventListener('abort', abort, { once: true })
      worker.once('message', (result: { css?: string; error?: string }) => {
        if (result.error)
          finish(undefined, new Error(`Tailwind/PostCSS failed in ${filename}: ${result.error}`))
        else if (typeof result.css === 'string') finish(result.css)
        else finish(undefined, new Error('Tailwind/PostCSS returned no compiled stylesheet.'))
      })
      worker.once('error', (error) => finish(undefined, error))
      worker.once('exit', (code) => {
        if (!settled)
          finish(
            undefined,
            new Error(`Tailwind/PostCSS stopped before compiling the stylesheet (exit ${code}).`),
          )
      })
      if (signal.aborted) abort()
    })
  }
}
