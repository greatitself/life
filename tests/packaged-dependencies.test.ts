import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import * as fs from 'node:fs/promises'
import { createHash } from 'node:crypto'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import {
  dependencyManifestKey,
  PackagedDependencies,
  type PackagedDependencyFile,
  type PackagedDependencyManifest,
} from '../src/main/packaged-dependencies'

vi.mock('node:fs/promises', async (original) => {
  const actual = await original<typeof import('node:fs/promises')>()
  return {
    ...actual,
    readFile: vi.fn(actual.readFile),
    writeFile: vi.fn(actual.writeFile),
    rename: vi.fn(actual.rename),
  }
})

const original = await vi.importActual<typeof import('node:fs/promises')>('node:fs/promises')
const directories: string[] = []

function deferred() {
  let resolve!: () => void
  const promise = new Promise<void>((done) => (resolve = done))
  return { promise, resolve }
}

function digest(bytes: Uint8Array) {
  return createHash('sha256').update(bytes).digest('hex')
}

async function fixture() {
  const directory = await original.mkdtemp(join(tmpdir(), 'life-packaged-dependencies-'))
  directories.push(directory)
  // Ordinary Node cannot read Electron's virtual ASAR filesystem. A package-shaped
  // directory exercises the same byte reads without mocking extraction itself.
  const sourceDirectory = join(directory, 'app.asar', 'node_modules')
  const manifestPath = join(directory, 'app.asar', 'life-dependencies.json')
  const cacheDirectory = join(directory, 'dependency-cache')
  const contents: Record<string, Buffer> = {
    '@life/renderer/package.json': Buffer.from('{"name":"@life/renderer","version":"1.0.0"}'),
    '@life/renderer/index.js': Buffer.from('export const answer = 42;\n'),
    '@life/renderer/styles/base.css': Buffer.from('.life { color: #123456; }\n'),
    'esbuild/bin/esbuild': Buffer.from([0, 255, 13, 10, 128, 1, 2, 3]),
    'react/package.json': Buffer.from('{"name":"react","version":"19.1.0"}'),
  }
  const files: PackagedDependencyFile[] = []
  for (const [path, bytes] of Object.entries(contents)) {
    const filename = join(sourceDirectory, path)
    await original.mkdir(dirname(filename), { recursive: true })
    await original.writeFile(filename, bytes)
    files.push({
      path,
      size: bytes.length,
      sha256: digest(bytes),
      ...(path === 'esbuild/bin/esbuild' ? { executable: true as const } : {}),
    })
  }
  const manifest: PackagedDependencyManifest = {
    format: 1,
    key: dependencyManifestKey(files),
    files,
  }
  await original.writeFile(manifestPath, JSON.stringify(manifest))
  const options = { sourceDirectory, manifestPath, cacheDirectory }
  return {
    directory,
    sourceDirectory,
    manifestPath,
    cacheDirectory,
    contents,
    manifest,
    options,
    cacheRoot: join(cacheDirectory, manifest.key),
    modules: join(cacheDirectory, manifest.key, 'node_modules'),
    create: () => new PackagedDependencies(options),
  }
}

beforeEach(() => {
  vi.mocked(fs.readFile).mockImplementation(original.readFile)
  vi.mocked(fs.writeFile).mockImplementation(original.writeFile)
  vi.mocked(fs.rename).mockImplementation(original.rename)
  vi.clearAllMocks()
})

afterEach(async () => {
  await Promise.all(
    directories
      .splice(0)
      .map((directory) => original.rm(directory, { recursive: true, force: true })),
  )
})

describe('lazy packaged compiler dependencies', () => {
  it('keys identical dependency bytes consistently regardless of manifest order', () => {
    const files: PackagedDependencyFile[] = [
      { path: 'z/package.json', size: 1, sha256: digest(Buffer.from('z')) },
      { path: '@scope/a/index.js', size: 1, sha256: digest(Buffer.from('a')) },
    ]
    const key = dependencyManifestKey(files)
    expect(key).toMatch(/^[a-f0-9]{64}$/)
    expect(dependencyManifestKey([...files].reverse())).toBe(key)
    expect(
      dependencyManifestKey([{ ...files[0], sha256: digest(Buffer.from('b')) }, files[1]]),
    ).not.toBe(key)
    expect(dependencyManifestKey([{ ...files[0], executable: true }, files[1]])).not.toBe(key)
  })

  it('does not read the archive or create a cache while constructing the startup service', async () => {
    const value = await fixture()
    value.create()
    expect(fs.readFile).not.toHaveBeenCalled()
    expect(fs.writeFile).not.toHaveBeenCalled()
    expect(fs.rename).not.toHaveBeenCalled()
    await expect(original.stat(value.cacheDirectory)).rejects.toMatchObject({ code: 'ENOENT' })
  })

  it('extracts nested packages and binary files byte for byte, with an atomic completion marker', async () => {
    const value = await fixture()
    expect(await value.create().ensure()).toBe(value.modules)
    for (const [path, bytes] of Object.entries(value.contents)) {
      expect(await original.readFile(join(value.modules, path))).toEqual(bytes)
    }
    expect(JSON.parse(await original.readFile(join(value.cacheRoot, '.complete'), 'utf8'))).toEqual(
      {
        format: 1,
        key: value.manifest.key,
      },
    )
    expect(await original.readdir(value.cacheDirectory)).toEqual([value.manifest.key])
    if (process.platform !== 'win32')
      expect((await original.stat(join(value.modules, 'esbuild/bin/esbuild'))).mode & 0o111).toBe(
        0o111,
      )
  })

  it('keeps the final cache invisible until every dependency has been committed', async () => {
    const value = await fixture()
    const publishing = deferred()
    const release = deferred()
    vi.mocked(fs.rename).mockImplementationOnce(async (...args) => {
      publishing.resolve()
      await release.promise
      return original.rename(...args)
    })
    const pending = value.create().ensure()
    await publishing.promise
    try {
      await expect(original.stat(value.cacheRoot)).rejects.toMatchObject({ code: 'ENOENT' })
      expect(await original.readdir(value.cacheDirectory)).toHaveLength(1)
    } finally {
      release.resolve()
    }
    expect(await pending).toBe(value.modules)
    expect(await original.readdir(value.cacheDirectory)).toEqual([value.manifest.key])
  })

  it('coalesces concurrent customization requests into one archive extraction', async () => {
    const value = await fixture()
    const store = value.create()
    const reading = deferred()
    const release = deferred()
    const heldFile = join(value.sourceDirectory, '@life/renderer/index.js')
    vi.mocked(fs.readFile).mockImplementation(async (...args) => {
      if (String(args[0]) === heldFile) {
        reading.resolve()
        await release.promise
      }
      return original.readFile(...args)
    })
    const first = store.ensure()
    await reading.promise
    const pending = Array.from({ length: 20 }, () => store.ensure())
    release.resolve()
    expect(await Promise.all([first, ...pending])).toEqual(Array(21).fill(value.modules))
    for (const path of Object.keys(value.contents)) {
      expect(
        vi
          .mocked(fs.readFile)
          .mock.calls.filter(
            ([filename]) => String(filename) === join(value.sourceDirectory, path),
          ),
      ).toHaveLength(1)
    }
    expect(fs.rename).toHaveBeenCalledTimes(1)
  })

  it('reuses an intact cache after a restart without rereading archived package files', async () => {
    const value = await fixture()
    await value.create().ensure()
    vi.clearAllMocks()
    const restarted = value.create()
    expect(await restarted.ensure()).toBe(value.modules)
    expect(
      vi
        .mocked(fs.readFile)
        .mock.calls.filter(([filename]) => String(filename).startsWith(value.sourceDirectory)),
    ).toEqual([])
    expect(fs.writeFile).not.toHaveBeenCalled()
    expect(fs.rename).not.toHaveBeenCalled()
    const reads = vi.mocked(fs.readFile).mock.calls.length
    expect(await restarted.ensure()).toBe(value.modules)
    expect(fs.readFile).toHaveBeenCalledTimes(reads)
  })

  it('coalesces separate helper instances and preserves the cache after the first atomic publish', async () => {
    const value = await fixture()
    const published = deferred()
    const release = deferred()
    vi.mocked(fs.rename).mockImplementationOnce(async (...args) => {
      await original.rename(...args)
      published.resolve()
      await release.promise
    })
    const first = value.create().ensure()
    await published.promise
    const otherInstances = Array.from({ length: 8 }, () => value.create().ensure())
    try {
      for (const [path, bytes] of Object.entries(value.contents))
        expect(await original.readFile(join(value.modules, path))).toEqual(bytes)
    } finally {
      release.resolve()
    }
    expect(await Promise.all([first, ...otherInstances])).toEqual(Array(9).fill(value.modules))
    for (const path of Object.keys(value.contents))
      expect(
        vi
          .mocked(fs.readFile)
          .mock.calls.filter(
            ([filename]) => String(filename) === join(value.sourceDirectory, path),
          ),
      ).toHaveLength(1)
    expect(fs.rename).toHaveBeenCalledTimes(1)
    expect(await original.readdir(value.cacheDirectory)).toEqual([value.manifest.key])
    for (const [path, bytes] of Object.entries(value.contents))
      expect(await original.readFile(join(value.modules, path))).toEqual(bytes)
  })

  it('shares an existing cache across different installation paths for the same package bytes', async () => {
    const installed = await fixture()
    const moved = await fixture()
    await installed.create().ensure()
    vi.clearAllMocks()
    const cache = new PackagedDependencies({
      ...moved.options,
      cacheDirectory: installed.cacheDirectory,
    })
    expect(await cache.ensure()).toBe(installed.modules)
    expect(
      vi
        .mocked(fs.readFile)
        .mock.calls.filter(([filename]) => String(filename).startsWith(moved.sourceDirectory)),
    ).toEqual([])
    expect(fs.rename).not.toHaveBeenCalled()
  })

  it.each(['missing file', 'same-size corruption', 'invalid marker'])(
    'repairs a cache with %s before exposing it to the compiler',
    async (damage) => {
      const value = await fixture()
      await value.create().ensure()
      const path = '@life/renderer/index.js'
      if (damage === 'missing file') await original.rm(join(value.modules, path))
      if (damage === 'same-size corruption')
        await original.writeFile(
          join(value.modules, path),
          Buffer.alloc(value.contents[path].length, 120),
        )
      if (damage === 'invalid marker')
        await original.writeFile(
          join(value.cacheRoot, '.complete'),
          '{"format":1,"key":"obsolete"}',
        )
      vi.clearAllMocks()
      expect(await value.create().ensure()).toBe(value.modules)
      expect(await original.readFile(join(value.modules, path))).toEqual(value.contents[path])
      expect(fs.rename).toHaveBeenCalledTimes(1)
      expect(await original.readdir(value.cacheDirectory)).toEqual([value.manifest.key])
    },
  )

  it.skipIf(process.platform === 'win32')(
    'repairs a cached compiler binary whose executable permissions were lost',
    async () => {
      const value = await fixture()
      await value.create().ensure()
      const binary = join(value.modules, 'esbuild/bin/esbuild')
      await original.chmod(binary, 0o644)
      vi.clearAllMocks()
      expect(await value.create().ensure()).toBe(value.modules)
      expect(await original.readFile(binary)).toEqual(value.contents['esbuild/bin/esbuild'])
      expect((await original.stat(binary)).mode & 0o777).toBe(0o755)
      expect(fs.rename).toHaveBeenCalledTimes(1)
      expect(await original.readdir(value.cacheDirectory)).toEqual([value.manifest.key])
    },
  )

  it('keeps the previous release cache while extracting a different dependency version', async () => {
    const value = await fixture()
    await value.create().ensure()
    const previousKey = value.manifest.key
    const previousBytes = value.contents['@life/renderer/index.js']
    const bytes = Buffer.from('export const answer = 43;\n')
    await original.writeFile(join(value.sourceDirectory, '@life/renderer/index.js'), bytes)
    value.manifest.files = value.manifest.files.map((file) =>
      file.path === '@life/renderer/index.js'
        ? { ...file, size: bytes.length, sha256: digest(bytes) }
        : file,
    )
    value.manifest.key = dependencyManifestKey(value.manifest.files)
    await original.writeFile(value.manifestPath, JSON.stringify(value.manifest))
    const nextModules = await value.create().ensure()
    expect(nextModules).toBe(join(value.cacheDirectory, value.manifest.key, 'node_modules'))
    expect(await original.readFile(join(nextModules, '@life/renderer/index.js'))).toEqual(bytes)
    expect(await original.readFile(join(value.modules, '@life/renderer/index.js'))).toEqual(
      previousBytes,
    )
    expect((await original.readdir(value.cacheDirectory)).sort()).toEqual(
      [previousKey, value.manifest.key].sort(),
    )
  })

  it('rejects changed archived bytes, cleans the incomplete cache and permits a later retry', async () => {
    const value = await fixture()
    const store = value.create()
    const path = '@life/renderer/index.js'
    await original.writeFile(
      join(value.sourceDirectory, path),
      Buffer.alloc(value.contents[path].length, 120),
    )
    await expect(store.ensure()).rejects.toThrow()
    expect(await original.readdir(value.cacheDirectory)).toEqual([])
    await original.writeFile(join(value.sourceDirectory, path), value.contents[path])
    expect(await store.ensure()).toBe(value.modules)
    expect(await original.readFile(join(value.modules, path))).toEqual(value.contents[path])
  })

  it('reports an atomic publish failure without leaving a partial cache, then retries successfully', async () => {
    const value = await fixture()
    const store = value.create()
    vi.mocked(fs.rename).mockRejectedValueOnce(
      Object.assign(new Error('disk full'), { code: 'ENOSPC' }),
    )
    await expect(store.ensure()).rejects.toThrow('disk full')
    expect(await original.readdir(value.cacheDirectory)).toEqual([])
    expect(await store.ensure()).toBe(value.modules)
  })

  it('finishes outstanding file writes before cleaning up a failed parallel extraction', async () => {
    const value = await fixture()
    const writing = deferred()
    const release = deferred()
    const damaged = '@life/renderer/index.js'
    await original.writeFile(join(value.sourceDirectory, damaged), Buffer.from('damaged'))
    vi.mocked(fs.writeFile).mockImplementation(async (...args) => {
      if (
        String(args[0]).startsWith(value.cacheDirectory) &&
        String(args[0]).endsWith(join('react', 'package.json'))
      ) {
        writing.resolve()
        await release.promise
      }
      return original.writeFile(...args)
    })
    let settled = false
    const pending = value
      .create()
      .ensure()
      .catch((error: unknown) => {
        settled = true
        return error
      })
    await writing.promise
    try {
      expect(settled).toBe(false)
      await expect(original.stat(value.cacheRoot)).rejects.toMatchObject({ code: 'ENOENT' })
    } finally {
      release.resolve()
    }
    expect(await pending).toBeInstanceOf(Error)
    expect(await original.readdir(value.cacheDirectory)).toEqual([])
  })

  it('rejects a pre-aborted customization without starting dependency extraction', async () => {
    const value = await fixture()
    const controller = new AbortController()
    controller.abort(new Error('Customization cancelled'))
    await expect(value.create().ensure(controller.signal)).rejects.toThrow(
      'Customization cancelled',
    )
    expect(fs.readFile).not.toHaveBeenCalled()
    expect(fs.writeFile).not.toHaveBeenCalled()
    await expect(original.stat(value.cacheDirectory)).rejects.toMatchObject({ code: 'ENOENT' })
  })

  it('cancels one customization waiter while preserving extraction for another request', async () => {
    const value = await fixture()
    const store = value.create()
    const reading = deferred()
    const release = deferred()
    const heldFile = join(value.sourceDirectory, '@life/renderer/index.js')
    vi.mocked(fs.readFile).mockImplementation(async (...args) => {
      if (String(args[0]) === heldFile) {
        reading.resolve()
        await release.promise
      }
      return original.readFile(...args)
    })
    const controller = new AbortController()
    const cancelled = store.ensure(controller.signal)
    const expectedCancellation = expect(cancelled).rejects.toThrow('Customization cancelled')
    await reading.promise
    const continuing = store.ensure()
    controller.abort(new Error('Customization cancelled'))
    await expectedCancellation
    await expect(original.stat(value.cacheRoot)).rejects.toMatchObject({ code: 'ENOENT' })
    release.resolve()
    expect(await continuing).toBe(value.modules)
    expect(await store.ensure()).toBe(value.modules)
    expect(await original.readdir(value.cacheDirectory)).toEqual([value.manifest.key])
  })

  it.each(['/outside.js', '../outside.js', 'package/../../outside.js', 'nul\u0000.js'])(
    'rejects an unsafe manifest path %j before any cache write',
    async (path) => {
      const value = await fixture()
      value.manifest.files[0].path = path
      value.manifest.key = dependencyManifestKey(value.manifest.files)
      await original.writeFile(value.manifestPath, JSON.stringify(value.manifest))
      await expect(value.create().ensure()).rejects.toThrow()
      expect(fs.writeFile).not.toHaveBeenCalled()
      expect(fs.rename).not.toHaveBeenCalled()
    },
  )

  it('rejects duplicate manifest entries and mismatched manifest keys', async () => {
    const value = await fixture()
    const duplicate = {
      ...value.manifest,
      files: [...value.manifest.files, value.manifest.files[0]],
    }
    duplicate.key = dependencyManifestKey(duplicate.files)
    await original.writeFile(value.manifestPath, JSON.stringify(duplicate))
    await expect(value.create().ensure()).rejects.toThrow()
    await original.writeFile(
      value.manifestPath,
      JSON.stringify({ ...value.manifest, key: '0'.repeat(64) }),
    )
    await expect(value.create().ensure()).rejects.toThrow()
    expect(fs.writeFile).not.toHaveBeenCalled()
    expect(fs.rename).not.toHaveBeenCalled()
  })
})
