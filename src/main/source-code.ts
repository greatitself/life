import { spawn } from 'node:child_process'
import { createHash, randomUUID } from 'node:crypto'
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
import { applyPatch, createTwoFilesPatch, diffChars } from 'diff'
import { BuiltinExtensionStore } from './builtin-extension-store'
import type { BuiltinExtensionDefinition } from '../shared/builtin-extensions'
import {
  isIncorporatedSourceExtension,
  type IncorporatedSourceExtension,
} from './incorporated-source-extensions'
import {
  parseSourceExtensionBundle,
  sourceExtensionBundleSchema,
  type SourceExtensionBundle,
  type SourceExtensionFile,
  type SourceExtensionSummary,
} from '../shared/source-extensions'
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
  /** Native, trusted migration identities; omitted in production to use the shipped manifest. */
  incorporatedExtensions?: readonly IncorporatedSourceExtension[]
  /** Trusted optional features shipped with the installed release. */
  builtinExtensions?: readonly BuiltinExtensionDefinition[]
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
    extensions: z
      .array(
        z
          .object({
            bundle: sourceExtensionBundleSchema,
            enabled: z.boolean(),
            incorporated: z.literal(true).optional(),
          })
          .strict(),
      )
      .max(200)
      .optional(),
    /** Migration records use the installed UI and do not have an executable custom bundle. */
    baselineOnly: z.literal(true).optional(),
  })
  .strict()
type Metadata = z.infer<typeof metadataSchema>
type SourceLayer = NonNullable<Metadata['extensions']>[number]
interface TextEdit {
  start: number
  end: number
  replacement: string
}

function textEdits(before: string, after: string): TextEdit[] {
  const changes = diffChars(before, after, { timeout: 2000 })
  if (!changes)
    throw new Error(
      'This source change is too large to merge safely. Split it into smaller extensions.',
    )
  const edits: TextEdit[] = []
  let position = 0
  let current: TextEdit | undefined
  for (const change of changes) {
    if (change.added || change.removed) {
      current ||= { start: position, end: position, replacement: '' }
      if (change.removed) {
        position += change.value.length
        current.end = position
      } else current.replacement += change.value
    } else {
      if (current) {
        edits.push(current)
        current = undefined
      }
      position += change.value.length
    }
  }
  if (current) edits.push(current)
  return edits
}

/** Merge both edits against their shared preimage, rather than replacing the whole file. */
function mergeSource(
  before: string,
  after: string,
  current: string,
  path: string,
  name: string,
): string {
  if (current === before || current === after) return after
  const existing = textEdits(before, current)
  const proposed = textEdits(before, after)
  const combined = [...existing]
  for (const edit of proposed) {
    let duplicate = false
    for (const other of existing) {
      if (
        edit.start === other.start &&
        edit.end === other.end &&
        edit.replacement === other.replacement
      ) {
        duplicate = true
        break
      }
      const inserted = edit.start === edit.end
      const otherInserted = other.start === other.end
      const overlap =
        inserted && otherInserted
          ? edit.start === other.start
          : inserted
            ? edit.start > other.start && edit.start < other.end
            : otherInserted
              ? other.start > edit.start && other.start < edit.end
              : Math.max(edit.start, other.start) < Math.min(edit.end, other.end)
      if (overlap)
        throw new Error(
          `Source extension “${name}” conflicts in ${path}. Another extension or the installed app changed the same code. Keep the working interface, then open Life Studio to adapt this extension.`,
        )
    }
    if (!duplicate) combined.push(edit)
  }
  combined.sort((left, right) => left.start - right.start || left.end - right.end)
  let result = ''
  let position = 0
  for (const edit of combined) {
    result += before.slice(position, edit.start) + edit.replacement
    position = edit.end
  }
  return result + before.slice(position)
}

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

// Native CSS packages run in a separate process, never in an Electron worker.
// Oxide 4.3.3 can execute unloaded native code when a Windows worker exits
// (tailwindlabs/tailwindcss#20470). Process isolation also keeps native crashes
// and runaway package code outside the application and its recovery host.
const tailwindProcess = String.raw`
const { createRequire } = require('node:module')
const { join } = require('node:path')
;(async () => {
  try {
    const chunks = []
    let bytes = 0
    for await (const chunk of process.stdin) {
      bytes += chunk.length
      if (bytes > 8 * 1024 * 1024) throw new Error('Tailwind compiler input exceeds 8 MB.')
      chunks.push(chunk)
    }
    const input = JSON.parse(Buffer.concat(chunks).toString('utf8'))
    const load = createRequire(join(input.modules, '@tailwindcss/postcss/package.json'))
    const postcssModule = load('postcss')
    const tailwindModule = load('@tailwindcss/postcss')
    const postcss = postcssModule.default || postcssModule
    const tailwind = tailwindModule.default || tailwindModule
    const result = await postcss([tailwind({ base: input.base, optimize: false })])
      .process(input.css, { from: input.filename, map: false })
    if (typeof result.css !== 'string') throw new Error('Tailwind returned no compiled stylesheet.')
    process.stdout.write(JSON.stringify({ css: result.css }) + '\n')
  } catch (error) {
    process.stdout.write(JSON.stringify({ error: error instanceof Error ? error.message : String(error) }) + '\n')
    process.exitCode = 1
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
  private builtinExtensions: BuiltinExtensionStore

  constructor(private options: SourceCodeStoreOptions) {
    this.path = resolve(options.directory)
    this.builtinExtensions = new BuiltinExtensionStore(this.path, options.builtinExtensions || [])
  }

  async init(): Promise<LifeSourceSnapshot> {
    if (this.initialized) return this.get()
    this.initialized = true
    await mkdir(join(this.path, 'revisions'), { recursive: true })
    await mkdir(join(this.path, 'packages'), { recursive: true })
    await this.builtinExtensions.init()
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
        if (!this.metadata.extensions) {
          this.metadata = await this.migrateLegacy(this.state.current, this.metadata)
          await writeFile(
            join(this.generation(this.state.current), 'metadata.json'),
            JSON.stringify(this.metadata),
            'utf8',
          )
        }
        if (this.metadata.baseFingerprint !== this.baselineFingerprint) {
          const incorporated = await this.retireIncorporatedLayers(
            this.state.current,
            this.metadata,
            [...this.state.history, this.state.current].slice(-5),
          )
          if (!incorporated) {
            const error =
              this.metadata.baselineOnly &&
              this.metadata.extensions?.some((layer) => this.isIncorporated(layer))
                ? 'Life now includes the recognized UI improvements. Your additional source extensions are preserved with execution disabled. Open Life Studio to adapt those extensions to the current Life version.'
                : 'Life was updated after this customization was built. Your source edits are preserved. Open Life Studio to update your customization for the current Life version; unchanged files are refreshed automatically when rebuilding.'
            if (this.state.enabled || this.state.error !== error) {
              this.state = {
                ...this.state,
                revision: this.state.revision + 1,
                enabled: false,
                error,
              }
              await this.writeState(this.state)
            }
          }
        }
        if (!this.metadata.baselineOnly)
          await stat(join(this.generation(this.state.current!), 'dist', 'entry.js'))
        else if (this.state.enabled) {
          // A baseline-only archive has no executable custom entry, even if a saved
          // state was corrupted or came from a downgrade with a matching fingerprint.
          this.state = { ...this.state, revision: this.state.revision + 1, enabled: false }
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
      extensions: this.extensionSummaries(),
      revision: this.state.revision,
      ...(this.options.builtinExtensions?.length
        ? {
            builtInRevision: this.builtinExtensions.revision,
            ...(this.builtinExtensions.error ? { builtInError: this.builtinExtensions.error } : {}),
          }
        : {}),
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
      extensions: snapshot.extensions,
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
      this.checkEpoch(epoch)
      if (patch.baseRevision !== this.state.revision)
        throw new Error(
          `Life source changed since the proposal was written (proposal revision ${patch.baseRevision}, current revision ${this.state.revision}). Read the current source and regenerate the patch.`,
        )
      const layers = this.cloneLayers()
      const current = await this.readEditable(
        this.state.current === null ? this.options.sourceDir : this.generation(this.state.current),
      )
      const desired = new Map(current)
      const adaptations = new Map<string, string | undefined>()
      for (const change of patch.files) {
        this.assertExactPath(desired, change.path)
        const content = this.proposedContent(desired.get(change.path), change)
        if (content === undefined) desired.delete(change.path)
        else desired.set(change.path, content)
        if (change.content !== undefined) adaptations.set(change.path, content)
      }
      // Startup repair updates the failed layer in place. It never leaves an additional
      // broken layer underneath the repaired extension.
      const failedIndex =
        this.state.current !== null && this.state.failed.includes(this.state.current)
          ? layers.findLastIndex((layer) => layer.enabled)
          : -1
      let bundle: SourceExtensionBundle | undefined
      if (failedIndex !== -1) {
        const prefix = await this.composeLayers(
          layers.slice(0, failedIndex),
          Boolean(this.get().baseChanged),
          adaptations,
        )
        const previous = layers[failedIndex].bundle
        const affected = new Set([
          ...previous.files.map((file) => file.path),
          ...patch.files.map((file) => file.path),
        ])
        const files = this.extensionFiles(prefix.files, desired, affected)
        const dependencies = { ...previous.dependencies, ...patch.dependencies }
        if (files.length || Object.keys(dependencies).length) {
          bundle = {
            ...previous,
            name: patch.summary.slice(0, 120),
            description: patch.summary,
            updatedAt: new Date().toISOString(),
            files,
            dependencies,
          }
          layers[failedIndex] = { bundle, enabled: true }
        } else layers.splice(failedIndex, 1)
      } else {
        const files = this.extensionFiles(
          current,
          desired,
          new Set(patch.files.map((file) => file.path)),
        )
        if (files.length || Object.keys(patch.dependencies || {}).length) {
          bundle = this.newBundle(patch.summary, files, patch.dependencies || {})
          layers.push({ bundle, enabled: true })
        }
      }
      if (layers.length > 200)
        throw new Error(
          'Life supports up to 200 source extensions. Remove unused extensions before adding more.',
        )
      return this.commitLayers(
        layers,
        patch.summary,
        epoch,
        Boolean(this.get().baseChanged),
        adaptations,
      )
    })
  }

  async setExtensionEnabled(id: string, enabled: boolean): Promise<LifeSourceSnapshot> {
    const epoch = this.operationEpoch
    return this.queue(async () => {
      this.checkEpoch(epoch)
      if (this.builtinExtensions.has(id)) {
        await this.builtinExtensions.setEnabled(id, enabled)
        this.emit()
        return this.get()
      }
      const layers = this.cloneLayers()
      const layer = this.routeLayers(layers).find((entry) => entry.id === id)?.layer
      if (!layer) throw new Error(`Source extension does not exist: ${id}`)
      if (this.isIncorporated(layer)) {
        if (enabled)
          throw new Error(
            'These changes are built into Life. Create a new extension to customize them; the original bundle is archived for export and recovery.',
          )
        return this.get()
      }
      if (layer.enabled === enabled && this.state.enabled === layers.some((entry) => entry.enabled))
        return this.get()
      layer.enabled = enabled
      return this.commitLayers(
        layers,
        `${enabled ? 'Enable' : 'Disable'} ${layer.bundle.name}`,
        epoch,
      )
    })
  }

  async removeExtension(id: string): Promise<LifeSourceSnapshot> {
    const epoch = this.operationEpoch
    return this.queue(async () => {
      this.checkEpoch(epoch)
      if (this.builtinExtensions.has(id)) {
        await this.builtinExtensions.remove(id)
        this.emit()
        return this.get()
      }
      const layers = this.cloneLayers()
      const selected = this.routeLayers(layers).find((entry) => entry.id === id)?.layer
      const index = selected ? layers.indexOf(selected) : -1
      if (index === -1) throw new Error(`Source extension does not exist: ${id}`)
      const [removed] = layers.splice(index, 1)
      return this.commitLayers(layers, `Remove ${removed.bundle.name}`, epoch)
    })
  }

  async exportExtension(id: string): Promise<SourceExtensionBundle> {
    await this.operations
    if (this.builtinExtensions.has(id))
      throw new Error(
        'Built-in feature choices are included in Export all extensions. Export its original source archive when one is available.',
      )
    const layer = this.routeLayers(this.metadata?.extensions || []).find(
      (entry) => entry.id === id,
    )?.layer
    if (!layer) throw new Error(`Source extension does not exist: ${id}`)
    // Export only portable code and dependency declarations, never paths, build caches,
    // machine profiles, SSH keys, messages, or account credentials.
    return parseSourceExtensionBundle(JSON.parse(JSON.stringify(layer.bundle)))
  }

  async importExtension(value: unknown): Promise<LifeSourceSnapshot> {
    const bundle = parseSourceExtensionBundle(value)
    if (this.builtinExtensions.has(bundle.id))
      throw new Error(
        'This ID belongs to a built-in Life feature. Choose a different extension ID.',
      )
    this.verifyBundle(bundle)
    const epoch = this.operationEpoch
    return this.queue(async () => {
      this.checkEpoch(epoch)
      const layers = this.cloneLayers()
      if (
        layers.some((entry) => entry.bundle.id === bundle.id) ||
        this.routeLayers(layers).some((entry) => entry.id === bundle.id)
      )
        throw new Error(
          `Source extension “${bundle.name}” is already installed. Remove it before importing another copy.`,
        )
      if (layers.length >= 200)
        throw new Error(
          'Life supports up to 200 source extensions. Remove unused extensions before adding more.',
        )
      layers.push({ bundle, enabled: true })
      return this.commitLayers(layers, `Install ${bundle.name}`, epoch)
    })
  }

  async updateExtension(value: unknown): Promise<LifeSourceSnapshot> {
    const bundle = parseSourceExtensionBundle(value)
    if (this.builtinExtensions.has(bundle.id))
      throw new Error(
        'This ID belongs to a built-in Life feature. Create a source extension with a different ID to customize it.',
      )
    bundle.files = bundle.files.map((file) => {
      if (file.kind === 'create') return file
      if (file.kind === 'delete') return { ...file, baseHash: this.hash(file.preimage) }
      return {
        ...file,
        baseHash: this.hash(file.preimage),
        patch: createTwoFilesPatch(
          file.path,
          file.path,
          file.preimage,
          file.content,
          undefined,
          undefined,
          { context: 3 },
        ),
      }
    })
    parseSourceExtensionBundle(bundle)
    this.verifyBundle(bundle)
    const epoch = this.operationEpoch
    return this.queue(async () => {
      this.checkEpoch(epoch)
      const layers = this.cloneLayers()
      const layer = this.routeLayers(layers).find((entry) => entry.id === bundle.id)?.layer
      if (!layer) throw new Error(`Source extension does not exist: ${bundle.id}`)
      if (this.isIncorporated(layer))
        throw new Error(
          'These changes are built into Life. Create a new extension to customize them; the original bundle is archived for export and recovery.',
        )
      layer.bundle = {
        ...bundle,
        createdAt: layer.bundle.createdAt,
        updatedAt: new Date().toISOString(),
      }
      return this.commitLayers(layers, `Update ${bundle.name}`, epoch)
    })
  }

  private checkEpoch(epoch: number) {
    if (epoch !== this.operationEpoch)
      throw new Error('Life source application was cancelled by recovery.')
  }

  private cloneLayers(): SourceLayer[] {
    return JSON.parse(JSON.stringify(this.metadata?.extensions || [])) as SourceLayer[]
  }

  private isIncorporated(layer: SourceLayer): boolean {
    return Boolean(
      layer.incorporated &&
      isIncorporatedSourceExtension(layer.bundle, this.options.incorporatedExtensions),
    )
  }

  private extensionSummaries(): SourceExtensionSummary[] {
    const layers = this.metadata?.extensions || []
    const failedIndex =
      this.state.current !== null && this.state.failed.includes(this.state.current)
        ? layers.findLastIndex((layer) => layer.enabled)
        : -1
    return [
      ...this.builtinExtensions.list(),
      ...this.routeLayers(layers).map(({ layer, id }, index) => ({
        id,
        ...(id !== layer.bundle.id ? { originalId: layer.bundle.id } : {}),
        name: layer.bundle.name,
        description: layer.bundle.description,
        version: layer.bundle.version,
        enabled: layer.enabled,
        ...(this.isIncorporated(layer) ? { incorporated: true as const } : {}),
        files: layer.bundle.files.map((file) => file.path),
        dependencies: { ...layer.bundle.dependencies },
        createdAt: layer.bundle.createdAt,
        updatedAt: layer.bundle.updatedAt,
        ...(index === failedIndex && this.state.error ? { error: this.state.error } : {}),
      })),
    ]
  }

  /** Old Life versions accepted arbitrary IDs, including IDs now used by native features.
   * Route those saved layers through a stable alias without rewriting their portable bundle
   * or compiling during startup. The original identity remains exportable for recovery. */
  private routeLayers(layers: SourceLayer[]): Array<{ layer: SourceLayer; id: string }> {
    const occupied = new Set([
      ...this.builtinExtensions.list().map((extension) => extension.id),
      ...layers.map((layer) => layer.bundle.id),
    ])
    return layers.map((layer) => {
      if (!this.builtinExtensions.has(layer.bundle.id)) return { layer, id: layer.bundle.id }
      let attempt = 0
      let id: string
      do {
        id = `source-recovery-${this.hash(`${layer.bundle.id}:${attempt++}`).slice(0, 16)}`
      } while (occupied.has(id))
      occupied.add(id)
      return { layer, id }
    })
  }

  private async readEditable(root: string): Promise<Map<string, string>> {
    const files = new Map<string, string>()
    for (const path of await this.listSource(root)) {
      if (!path.startsWith('src/renderer/') && !path.startsWith('src/shared/')) continue
      files.set(path, await readFile(join(root, path), 'utf8'))
    }
    return files
  }

  private assertExactPath(files: Map<string, string>, path: string) {
    const existing = [...files.keys()].find((entry) => entry.toLowerCase() === path.toLowerCase())
    if (existing && existing !== path)
      throw new Error(
        `Source path ${path} aliases the existing ${existing} on Windows. Use the exact path from Life’s source index.`,
      )
  }

  private proposedContent(
    current: string | undefined,
    change: LifeSourcePatch['files'][number],
  ): string | undefined {
    if (change.content === null) return undefined
    if (change.content !== undefined) return change.content
    if (current === undefined)
      throw new Error(
        `Cannot edit ${change.path}: the file does not exist. Read the current file or provide content to create it.`,
      )
    let content = current
    for (const edit of change.edits || []) {
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
    return content
  }

  private extensionFiles(
    before: Map<string, string>,
    after: Map<string, string>,
    paths: Set<string>,
  ): SourceExtensionFile[] {
    const changes: SourceExtensionFile[] = []
    for (const path of [...paths].sort()) {
      const original = before.get(path)
      const content = after.get(path)
      if (original === content) continue
      if (original === undefined && content !== undefined)
        changes.push({ path, kind: 'create', content })
      else if (content === undefined && original !== undefined)
        changes.push({ path, kind: 'delete', preimage: original, baseHash: this.hash(original) })
      else
        changes.push({
          path,
          kind: 'patch',
          preimage: original!,
          content: content!,
          baseHash: this.hash(original!),
          patch: createTwoFilesPatch(path, path, original!, content!, undefined, undefined, {
            context: 3,
          }),
        })
    }
    return changes
  }

  private newBundle(
    summary: string,
    files: SourceExtensionFile[],
    dependencies: Record<string, string>,
  ): SourceExtensionBundle {
    const date = new Date().toISOString()
    return parseSourceExtensionBundle({
      format: 'life-source-extension',
      formatVersion: 1,
      id: `source-${randomUUID().replaceAll('-', '').slice(0, 12)}`,
      name: summary.slice(0, 120),
      description: summary,
      version: '1.0.0',
      createdAt: date,
      updatedAt: date,
      files,
      dependencies,
    })
  }

  private verifyBundle(bundle: SourceExtensionBundle) {
    for (const file of bundle.files) {
      if (file.kind === 'create') continue
      if (this.hash(file.preimage) !== file.baseHash)
        throw new Error(`Source extension preimage checksum does not match ${file.path}.`)
      if (file.kind === 'patch' && applyPatch(file.preimage, file.patch) !== file.content)
        throw new Error(
          `Source extension patch does not match its declared content in ${file.path}.`,
        )
    }
  }

  private async composeLayers(
    layers: SourceLayer[],
    rebase = false,
    adaptations = new Map<string, string | undefined>(),
  ): Promise<{
    files: Map<string, string>
    baselineFiles: Map<string, string>
    dependencies: Record<string, string>
    layers: SourceLayer[]
  }> {
    const baselineFiles = await this.readEditable(this.options.sourceDir)
    const files = new Map(baselineFiles)
    const dependencies: Record<string, string> = {}
    const nextLayers = JSON.parse(JSON.stringify(layers)) as SourceLayer[]
    for (const layer of nextLayers) {
      layer.bundle = parseSourceExtensionBundle(layer.bundle)
      if (this.isIncorporated(layer)) {
        layer.enabled = false
        continue
      }
      delete layer.incorporated
      if (!layer.enabled) continue
      this.verifyBundle(layer.bundle)
      const adjusted: SourceExtensionFile[] = []
      for (const change of layer.bundle.files) {
        this.assertExactPath(files, change.path)
        const current = files.get(change.path)
        let content: string | undefined
        if (change.kind === 'create') {
          if (current !== undefined && current !== change.content)
            throw new Error(
              `Source extension “${layer.bundle.name}” conflicts in ${change.path}: this file already exists with different content.`,
            )
          content = change.content
        } else if (change.kind === 'delete') {
          if (
            current !== undefined &&
            current !== change.preimage &&
            !(rebase && adaptations.has(change.path) && adaptations.get(change.path) === undefined)
          )
            throw new Error(
              `Source extension “${layer.bundle.name}” conflicts in ${change.path}: another extension changed the file being removed.`,
            )
          content = undefined
        } else {
          if (current === undefined)
            throw new Error(
              `Source extension “${layer.bundle.name}” conflicts in ${change.path}: its required source file is missing. Enable its prerequisite extension or adapt this extension in Life Studio.`,
            )
          try {
            content = mergeSource(
              change.preimage,
              change.content,
              current,
              change.path,
              layer.bundle.name,
            )
          } catch (error) {
            if (!rebase || !adaptations.has(change.path)) throw error
            content = adaptations.get(change.path)
          }
        }
        if (rebase) {
          const before = new Map<string, string>()
          const after = new Map<string, string>()
          if (current !== undefined) before.set(change.path, current)
          if (content !== undefined) after.set(change.path, content)
          adjusted.push(...this.extensionFiles(before, after, new Set([change.path])))
        }
        if (content === undefined) files.delete(change.path)
        else files.set(change.path, content)
      }
      if (rebase) layer.bundle.files = adjusted
      if (layer.bundle.files.length || Object.keys(layer.bundle.dependencies).length)
        layer.bundle = parseSourceExtensionBundle(layer.bundle)
      Object.assign(dependencies, layer.bundle.dependencies)
    }
    return {
      files,
      baselineFiles,
      dependencies,
      // Rebased code already included by another adapted layer does not create an
      // invalid empty portable bundle. The composed source still contains its result.
      layers: nextLayers.filter(
        (layer) => layer.bundle.files.length || Object.keys(layer.bundle.dependencies).length,
      ),
    }
  }

  private async migrateLegacy(revision: number, metadata: Metadata): Promise<Metadata> {
    const baseline = await this.readEditable(this.options.sourceDir)
    const current = await this.readEditable(this.generation(revision))
    const affected = new Set<string>()
    for (const [path, content] of current) {
      // Untouched files from the old app do not become private overrides after an upgrade.
      if (metadata.baseHashes[path] && this.hash(content) === metadata.baseHashes[path]) continue
      if (baseline.get(path) !== content) affected.add(path)
    }
    for (const path of Object.keys(metadata.baseHashes))
      if (!current.has(path) && baseline.has(path)) affected.add(path)
    const files = this.extensionFiles(baseline, current, affected)
    const extensions: SourceLayer[] =
      files.length || Object.keys(metadata.dependencies).length
        ? [
            {
              bundle: this.newBundle('Legacy customization', files, metadata.dependencies),
              enabled: true,
            },
          ]
        : []
    return { ...metadata, extensions }
  }

  /**
   * A shipped UI improvement must not replay its old patches over the new app. Archive
   * only the exact published bundle identities and leave every original generation intact.
   * This transaction never installs dependencies, compiles, or executes an old renderer.
   */
  private async retireIncorporatedLayers(
    previous: number,
    metadata: Metadata,
    history: SavedState['history'],
  ): Promise<boolean> {
    const layers = JSON.parse(JSON.stringify(metadata.extensions || [])) as SourceLayer[]
    let matched = 0
    let newlyMatched = 0
    for (const layer of layers) {
      if (isIncorporatedSourceExtension(layer.bundle, this.options.incorporatedExtensions)) {
        if (!this.isIncorporated(layer)) newlyMatched++
        layer.incorporated = true
        layer.enabled = false
        matched++
      } else delete layer.incorporated
    }
    if (!matched) return false

    // Unknown enabled layers still need the user's explicit adaptation. Keep their old
    // source as readable context, with execution disabled, instead of silently rebasing it.
    const needsAdaptation = layers.some((layer) => layer.enabled)
    if (needsAdaptation && !newlyMatched) return false
    const source = needsAdaptation ? this.generation(previous) : this.options.sourceDir
    const nextRevision = this.state.revision + 1
    const staging = join(
      this.path,
      'revisions',
      `.incorporated-${nextRevision}-${randomUUID().slice(0, 12)}`,
    )
    const destination = this.generation(nextRevision)
    const dependencies: Record<string, string> = {}
    for (const layer of layers)
      if (layer.enabled) Object.assign(dependencies, layer.bundle.dependencies)
    const nextMetadata: Metadata = metadataSchema.parse({
      summary: needsAdaptation
        ? 'Built-in improvements are archived; additional source extensions are preserved for adaptation.'
        : 'These improvements are now built into Life. Original extension bundles are archived for export and recovery.',
      dependencies,
      baseFingerprint: needsAdaptation ? metadata.baseFingerprint : this.baselineFingerprint,
      baseHashes: needsAdaptation ? metadata.baseHashes : { ...this.baselineHashes },
      extensions: layers,
      baselineOnly: true,
    })
    let moved = false
    try {
      if (existsSync(destination))
        throw new Error(`A source generation already exists for revision ${nextRevision}.`)
      await mkdir(staging, { recursive: true })
      for (const path of await this.listSource(source)) {
        if (
          !path.startsWith('src/renderer/') &&
          !path.startsWith('src/shared/') &&
          path !== 'package.json'
        )
          continue
        const target = join(staging, path)
        await mkdir(dirname(target), { recursive: true })
        await copyFile(join(source, path), target)
      }
      await writeFile(join(staging, 'metadata.json'), JSON.stringify(nextMetadata), 'utf8')
      await writeFile(
        join(staging, 'incorporation-recovery.json'),
        JSON.stringify({ format: 1, originalState: this.state, originalGeneration: previous }),
        'utf8',
      )
      await rename(staging, destination)
      moved = true
      const next: SavedState = {
        ...this.state,
        revision: nextRevision,
        current: nextRevision,
        history,
        enabled: false,
        error: needsAdaptation
          ? 'Life now includes the recognized UI improvements. Your additional source extensions are preserved with execution disabled. Open Life Studio to adapt those extensions to the current Life version.'
          : undefined,
      }
      await this.writeState(next)
      this.state = next
      this.metadata = nextMetadata
      return true
    } catch (error) {
      await rm(moved ? destination : staging, { recursive: true, force: true }).catch(() => {})
      throw error
    }
  }

  private async commitLayers(
    layers: SourceLayer[],
    summary: string,
    epoch: number,
    rebase = false,
    adaptations = new Map<string, string | undefined>(),
  ): Promise<LifeSourceSnapshot> {
    this.checkEpoch(epoch)
    const nextRevision = this.state.revision + 1
    const controller = new AbortController()
    this.activeController = controller
    const signal = controller.signal
    const staging = join(
      this.path,
      'revisions',
      `.staging-${nextRevision}-${randomUUID().slice(0, 12)}`,
    )
    try {
      const composed = await this.composeLayers(layers, rebase, adaptations)
      signal.throwIfAborted()
      await mkdir(staging, { recursive: true })
      for (const [path, content] of composed.files) {
        signal.throwIfAborted()
        const target = join(staging, path)
        await mkdir(dirname(target), { recursive: true })
        if (composed.baselineFiles.get(path) === content)
          await copyFile(join(this.options.sourceDir, path), target)
        else await writeFile(target, content, 'utf8')
      }
      if (existsSync(join(this.options.sourceDir, 'package.json')))
        await copyFile(join(this.options.sourceDir, 'package.json'), join(staging, 'package.json'))
      const packageModules = await this.installDependencies(composed.dependencies, signal)
      signal.throwIfAborted()
      await this.compile(staging, packageModules, composed.dependencies, signal)
      signal.throwIfAborted()
      const metadata: Metadata = metadataSchema.parse({
        summary,
        dependencies: composed.dependencies,
        baseFingerprint: this.baselineFingerprint,
        baseHashes: { ...this.baselineHashes },
        extensions: composed.layers,
      })
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
        enabled: composed.layers.some((layer) => layer.enabled),
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
      let metadata = previous === null ? undefined : await this.readMetadata(previous)
      if (metadata && !metadata.extensions) {
        metadata = await this.migrateLegacy(previous!, metadata)
        await writeFile(
          join(this.generation(previous!), 'metadata.json'),
          JSON.stringify(metadata),
          'utf8',
        )
      }
      const baseChanged = Boolean(metadata && metadata.baseFingerprint !== this.baselineFingerprint)
      if (
        baseChanged &&
        metadata &&
        previous !== null &&
        (await this.retireIncorporatedLayers(previous, metadata, history))
      ) {
        this.recovered = false
        this.emit()
        return this.get()
      }
      const next: SavedState = {
        format: 1,
        revision: this.state.revision + 1,
        current: previous,
        history,
        enabled:
          !baseChanged &&
          !metadata?.baselineOnly &&
          Boolean(metadata?.extensions?.some((layer) => layer.enabled)),
        failed: [...this.state.failed],
        ...(baseChanged
          ? {
              error:
                'This previous customization belongs to an older Life installation. Its extensions are preserved; open Life Studio to adapt them to the current source before enabling them.',
            }
          : {}),
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
      define: {
        'process.env.NODE_ENV': '"production"',
        __LIFE_SOURCE_BUILD__: 'true',
      },
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
    const input = JSON.stringify({ css, filename, base: join(base, 'src'), modules })
    if (Buffer.byteLength(input) > 8 * 1024 * 1024)
      throw new Error(
        'Tailwind compiler input exceeds 8 MB. Split the stylesheet into smaller files.',
      )
    return new Promise<string>((done, failed) => {
      // process.execPath is Life.exe in the installed Windows application. The
      // same executable provides its bundled Node runtime without a system install.
      const child = spawn(process.execPath, ['-e', tailwindProcess], {
        cwd: base,
        windowsHide: true,
        env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' },
        stdio: ['pipe', 'pipe', 'pipe'],
        // A separate POSIX group lets cancellation stop compiler descendants
        // that inherited the output pipes, even after their parent has exited.
        detached: process.platform !== 'win32',
      })
      const output: Buffer[] = []
      let outputBytes = 0
      let errorOutput = ''
      let stopped: Error | undefined
      let settled = false
      let exited = false
      let forceStop: ReturnType<typeof setTimeout> | undefined
      let hardStop: ReturnType<typeof setTimeout> | undefined
      let exitDrain: ReturnType<typeof setTimeout> | undefined
      let windowsTreeKillStarted = false
      const finish = (value?: string, error?: Error) => {
        if (settled) return
        settled = true
        // Releasing inherited pipes can cause close before the TERM escalation
        // timer runs. Stop the remaining group before clearing that timer.
        if (error || process.platform !== 'win32') killTree('SIGKILL')
        clearTimeout(timeout)
        clearTimeout(forceStop)
        clearTimeout(hardStop)
        clearTimeout(exitDrain)
        signal.removeEventListener('abort', abort)
        error ? failed(error) : done(value!)
      }
      const destroyPipes = () => {
        child.stdin.destroy()
        child.stdout.destroy()
        child.stderr.destroy()
      }
      const killTree = (killSignal: NodeJS.Signals) => {
        if (child.pid === undefined) return
        if (process.platform !== 'win32') {
          try {
            process.kill(-child.pid, killSignal)
          } catch {
            if (!exited) child.kill(killSignal)
          }
          return
        }
        if (windowsTreeKillStarted) {
          if (!exited) child.kill(killSignal)
          return
        }
        windowsTreeKillStarted = true
        // taskkill is part of Windows, so tree cancellation needs no separately
        // installed runtime. Run it before killing the parent directly; once the
        // parent has exited, Windows may no longer find all of its descendants.
        const taskkill = spawn(
          join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'taskkill.exe'),
          ['/PID', String(child.pid), '/T', '/F'],
          { windowsHide: true, stdio: 'ignore' },
        )
        const killParent = () => {
          if (!exited) child.kill('SIGKILL')
        }
        taskkill.once('error', killParent)
        taskkill.once('close', killParent)
        taskkill.unref()
      }
      const stop = (error: Error) => {
        if (stopped || settled) return
        stopped = error
        killTree('SIGTERM')
        forceStop = setTimeout(() => killTree('SIGKILL'), 1500)
        // A descendant can keep inherited pipes open after the direct child is
        // gone. Never allow that to extend a timeout or recovery indefinitely.
        hardStop = setTimeout(() => {
          killTree('SIGKILL')
          destroyPipes()
          finish(undefined, stopped)
        }, 2000)
      }
      const abort = () =>
        stop(
          signal.reason instanceof Error
            ? signal.reason
            : new Error('Life Tailwind compilation was cancelled.'),
        )
      const timeout = setTimeout(
        () =>
          stop(
            new Error(
              'Life Tailwind compilation timed out. Simplify the stylesheet or source scan.',
            ),
          ),
        Math.min(this.options.compilerTimeoutMs ?? 60_000, 30_000),
      )
      signal.addEventListener('abort', abort, { once: true })
      child.stdout.on('data', (chunk: Buffer) => {
        outputBytes += chunk.length
        if (outputBytes > 16 * 1024 * 1024) {
          stop(
            new Error(
              'Tailwind compiler output exceeds 16 MB. Reduce generated utilities or source scanning.',
            ),
          )
          return
        }
        if (!stopped) output.push(chunk)
      })
      child.stderr.on('data', (chunk: Buffer) => {
        errorOutput = (errorOutput + chunk.toString('utf8')).slice(-30_000)
      })
      child.stdin.on('error', (error) => {
        if (!stopped && (error as NodeJS.ErrnoException).code !== 'EPIPE')
          stop(new Error(`Life Tailwind compiler input failed: ${explain(error)}`))
      })
      child.once('error', (error) => {
        const failure = new Error(`Life Tailwind compiler process failed: ${explain(error)}`)
        // A failed spawn never held the staging directory. Once a child exists,
        // wait for its close event before the caller removes its build inputs.
        if (child.pid === undefined) finish(undefined, failure)
        else stop(failure)
      })
      child.once('exit', () => {
        exited = true
        // Usually close follows exit immediately after buffered output drains.
        // An inherited pipe held by another process must not block settlement.
        exitDrain = setTimeout(() => {
          if (settled) return
          if (!stopped)
            stop(
              new Error(
                'Tailwind/PostCSS compiler exited but its output pipes remained open. Its dependency may have left a helper process running.',
              ),
            )
          killTree('SIGKILL')
          destroyPipes()
          finish(undefined, stopped)
        }, 500)
      })
      child.once('close', (code, exitSignal) => {
        if (stopped) return finish(undefined, stopped)
        let result: unknown
        try {
          // Dependency diagnostics may use stdout. The compiler protocol is the
          // final JSON line, after any incidental package messages.
          const lines = Buffer.concat(output).toString('utf8').trim().split(/\r?\n/)
          result = JSON.parse(lines.at(-1) || '')
        } catch {
          return finish(
            undefined,
            new Error(
              `Tailwind/PostCSS failed in ${filename}: compiler exited without a valid result (exit ${code}, signal ${exitSignal || 'none'}).${errorOutput ? `\n${errorOutput}` : ''}`,
            ),
          )
        }
        const response = result as { css?: unknown; error?: unknown } | null
        if (typeof response?.error === 'string')
          return finish(
            undefined,
            new Error(`Tailwind/PostCSS failed in ${filename}: ${response.error.slice(0, 30_000)}`),
          )
        if (code !== 0 || exitSignal)
          return finish(
            undefined,
            new Error(
              `Tailwind/PostCSS failed in ${filename}: compiler process crashed or failed (exit ${code}, signal ${exitSignal || 'none'}).${errorOutput ? `\n${errorOutput}` : ''}`,
            ),
          )
        if (typeof response?.css !== 'string')
          return finish(
            undefined,
            new Error(`Tailwind/PostCSS failed in ${filename}: compiler returned no stylesheet.`),
          )
        finish(response.css)
      })
      // A cancellation that arrived immediately after spawn must still terminate
      // the child before any expensive native work can begin.
      if (signal.aborted) abort()
      if (!stopped) child.stdin.end(input)
    })
  }
}
