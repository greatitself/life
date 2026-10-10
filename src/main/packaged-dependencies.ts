import { createHash, randomUUID } from 'node:crypto'
import { mkdir, readFile, rename, rm, stat, writeFile } from 'node:fs/promises'
import { dirname, join, resolve } from 'node:path'

const pendingCaches = new Map<string, Promise<string>>()

export interface PackagedDependencyFile {
  path: string
  size: number
  sha256: string
  executable?: true
}

export interface PackagedDependencyManifest {
  format: 1
  key: string
  files: PackagedDependencyFile[]
}

/** The key follows the shipped dependency bytes, so unchanged tools survive Life upgrades. */
export function dependencyManifestKey(files: readonly PackagedDependencyFile[]): string {
  const canonical = [...files]
    .sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0))
    .map(({ path, size, sha256, executable }) => ({
      path,
      size,
      sha256,
      ...(executable ? { executable: true } : {}),
    }))
  return createHash('sha256').update(JSON.stringify(canonical)).digest('hex')
}

function parseManifest(value: unknown): PackagedDependencyManifest {
  const manifest = value as Partial<PackagedDependencyManifest> | null
  if (
    !manifest ||
    manifest.format !== 1 ||
    typeof manifest.key !== 'string' ||
    !/^[a-f0-9]{64}$/.test(manifest.key) ||
    !Array.isArray(manifest.files) ||
    !manifest.files.length
  )
    throw new Error('Life’s packaged compiler dependency manifest is invalid.')
  const paths = new Set<string>()
  for (const file of manifest.files) {
    if (
      !file ||
      typeof file.path !== 'string' ||
      !file.path ||
      file.path.includes('\\') ||
      file.path.includes(':') ||
      file.path.includes('\0') ||
      file.path.split('/').some((part) => !part || part === '.' || part === '..') ||
      paths.has(file.path) ||
      !Number.isSafeInteger(file.size) ||
      file.size < 0 ||
      typeof file.sha256 !== 'string' ||
      !/^[a-f0-9]{64}$/.test(file.sha256) ||
      (file.executable !== undefined && file.executable !== true)
    )
      throw new Error('Life’s packaged compiler dependency manifest contains an invalid file.')
    paths.add(file.path)
  }
  if (dependencyManifestKey(manifest.files) !== manifest.key)
    throw new Error('Life’s packaged compiler dependency manifest does not match its content.')
  return manifest as PackagedDependencyManifest
}

async function visitFiles(
  files: readonly PackagedDependencyFile[],
  visit: (file: PackagedDependencyFile) => Promise<void>,
): Promise<void> {
  let next = 0
  const results = await Promise.allSettled(
    Array.from({ length: Math.min(16, files.length) }, async () => {
      while (next < files.length) await visit(files[next++])
    }),
  )
  const failure = results.find((result) => result.status === 'rejected')
  if (failure?.status === 'rejected') throw failure.reason
}

function matches(file: PackagedDependencyFile, bytes: Buffer): boolean {
  return (
    bytes.byteLength === file.size &&
    createHash('sha256').update(bytes).digest('hex') === file.sha256
  )
}

/**
 * Ordinary Life sessions read dependencies directly from ASAR. Only Studio's external
 * compiler/npm need real files; materialize those on demand, outside the installation.
 */
export class PackagedDependencies {
  private prepared?: Promise<string>

  constructor(
    private readonly options: {
      sourceDirectory: string
      manifestPath: string
      cacheDirectory: string
    },
  ) {}

  ensure(signal?: AbortSignal): Promise<string> {
    if (signal?.aborted) return Promise.reject(signal.reason)
    if (!this.prepared) {
      this.prepared = this.prepare().catch((error) => {
        this.prepared = undefined
        throw error
      })
    }
    if (!signal) return this.prepared
    // Cancelling one Studio operation must not cancel another caller's shared cache work.
    return new Promise((resolve, reject) => {
      const abort = () => reject(signal.reason)
      signal.addEventListener('abort', abort, { once: true })
      this.prepared!.then(resolve, reject).finally(() => {
        signal.removeEventListener('abort', abort)
      })
    })
  }

  private async valid(directory: string, manifest: PackagedDependencyManifest): Promise<boolean> {
    try {
      const marker = JSON.parse(await readFile(join(directory, '.complete'), 'utf8'))
      if (marker.format !== 1 || marker.key !== manifest.key) return false
      await visitFiles(manifest.files, async (file) => {
        const target = join(directory, 'node_modules', file.path)
        if (
          !matches(file, await readFile(target)) ||
          (file.executable && process.platform !== 'win32' && !((await stat(target)).mode & 0o111))
        )
          throw new Error('Incomplete compiler dependency cache')
      })
      return true
    } catch {
      return false
    }
  }

  private async prepare(): Promise<string> {
    const manifest = parseManifest(JSON.parse(await readFile(this.options.manifestPath, 'utf8')))
    const directory = resolve(this.options.cacheDirectory, manifest.key)
    const shared = pendingCaches.get(directory)
    if (shared) return shared
    const operation = this.materialize(directory, manifest)
    pendingCaches.set(directory, operation)
    try {
      return await operation
    } finally {
      if (pendingCaches.get(directory) === operation) pendingCaches.delete(directory)
    }
  }

  private async materialize(
    directory: string,
    manifest: PackagedDependencyManifest,
  ): Promise<string> {
    if (await this.valid(directory, manifest)) return join(directory, 'node_modules')
    await mkdir(this.options.cacheDirectory, { recursive: true })
    // Life owns a native single-instance lock. Remove an incomplete prior attempt
    // before doing any work, never after another process could publish its cache.
    await rm(directory, { recursive: true, force: true })
    const staging = join(this.options.cacheDirectory, `.${manifest.key}-${randomUUID()}.tmp`)
    await mkdir(staging)
    try {
      await visitFiles(manifest.files, async (file) => {
        // Electron's readFile supports ASAR and transparently follows unpacked native binaries.
        // copyFile does not consistently support archive sources on all packaged platforms.
        const bytes = await readFile(join(this.options.sourceDirectory, file.path))
        if (!matches(file, bytes))
          throw new Error(`Life’s packaged compiler dependency is damaged: ${file.path}`)
        const target = join(staging, 'node_modules', file.path)
        await mkdir(dirname(target), { recursive: true })
        await writeFile(target, bytes, { mode: file.executable ? 0o755 : 0o644 })
      })
      await writeFile(
        join(staging, '.complete'),
        JSON.stringify({ format: 1, key: manifest.key }),
        'utf8',
      )
      // A second native process may already have published the same immutable payload.
      if (await this.valid(directory, manifest)) return join(directory, 'node_modules')
      try {
        await rename(staging, directory)
      } catch (error) {
        if (!(await this.valid(directory, manifest))) throw error
      }
      return join(directory, 'node_modules')
    } finally {
      await rm(staging, { recursive: true, force: true })
    }
  }
}
