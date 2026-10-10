import { createHash } from 'node:crypto'
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import { dirname, join, posix, win32 } from 'node:path'
import { pathToFileURL } from 'node:url'
import { afterEach, describe, expect, it, vi } from 'vitest'

type Entry = {
  files?: Record<string, unknown>
  size?: number
  integrity?: { algorithm: string; hash: string }
  unpacked?: boolean
  executable?: boolean
}
type Asar = {
  listPackage: (archive: string) => string[]
  statFile: (archive: string, name: string, followLinks: boolean) => Entry
  extractFile: (archive: string, name: string) => Buffer
}
type Manifest = {
  format: 1
  key: string
  files: { path: string; size: number; sha256: string; executable?: true }[]
}

const require = createRequire(import.meta.url)
const { collectDependencyManifest } = require('../scripts/package-dependencies.cjs') as {
  collectDependencyManifest: (
    archive: string,
    asar: Asar,
    filesystem?: {
      stat?: (filename: string) => Promise<{ mode: number }>
      join?: (...parts: string[]) => string
    },
  ) => Promise<Manifest>
}

const directories: string[] = []
afterEach(async () => {
  await Promise.all(
    directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })),
  )
})

function hash(bytes: Buffer) {
  return createHash('sha256').update(bytes).digest('hex')
}

/** ASAR lookups accept the packaging host's native paths, even though the manifest is portable. */
function fixture(windows: boolean, unpackedMode = 0o666) {
  const native = windows ? win32 : posix
  const archive = windows ? 'C:\\Life\\resources\\app.asar' : '/Life/resources/app.asar'
  const separator = windows ? '\\' : '/'
  const nativeName = (name: string) => name.replaceAll('/', separator)
  const payloads: Record<string, Buffer> = {
    'node_modules/npm/bin/npm-cli.js': Buffer.from(
      '#!/usr/bin/env node\nrequire("../lib/cli.js")\n',
    ),
    'node_modules/esbuild/lib/main.js': Buffer.from('exports.build = function build() {}\n'),
    'node_modules/@esbuild/win32-x64/esbuild.exe': Buffer.from([0x4d, 0x5a, 0, 255, 13, 10]),
    'node_modules/@antfu/install-pkg/dist/index.js': Buffer.from(
      'export const installPackage = () => {}\n',
    ),
  }
  const entries = new Map<string, Entry>([
    [nativeName('node_modules'), { files: {} }],
    [nativeName('node_modules/@antfu'), { files: {} }],
    [nativeName('node_modules/@antfu/install-pkg'), { files: {} }],
    [nativeName('node_modules/@antfu/install-pkg/dist'), { files: {} }],
  ])
  for (const [name, bytes] of Object.entries(payloads)) {
    entries.set(nativeName(name), {
      size: bytes.length,
      ...(name.includes('@antfu/')
        ? {}
        : { integrity: { algorithm: 'SHA256', hash: hash(bytes) } }),
      ...(name.endsWith('.exe') ? { unpacked: true } : {}),
    })
  }
  const asar: Asar = {
    listPackage: vi.fn((filename) => {
      expect(filename).toBe(archive)
      return [...entries.keys()]
        .reverse()
        .map((name) => `${separator}${name}`)
        .concat(`${separator}out${separator}main${separator}index.js`)
    }),
    statFile: vi.fn((filename, name, followLinks) => {
      expect(filename).toBe(archive)
      expect(followLinks).toBe(true)
      const entry = entries.get(name)
      if (!entry) throw new Error(`Invalid native ASAR lookup: ${name}`)
      return entry
    }),
    extractFile: vi.fn((filename, name) => {
      expect(filename).toBe(archive)
      if (!entries.has(name)) throw new Error(`Invalid native ASAR extraction: ${name}`)
      const canonicalName = name.replaceAll('\\', '/')
      const bytes = payloads[canonicalName]
      if (!bytes) throw new Error(`Cannot extract directory: ${name}`)
      return bytes
    }),
  }
  const stat = vi.fn(async (filename: string) => {
    expect(filename).toBe(
      native.join(`${archive}.unpacked`, nativeName('node_modules/@esbuild/win32-x64/esbuild.exe')),
    )
    return { mode: unpackedMode }
  })
  return { archive, asar, filesystem: { stat, join: native.join }, entries, payloads, nativeName }
}

describe('target-platform dependency manifest', () => {
  it('keeps native Windows ASAR lookups for scoped directories, extraction, and unpacked files', async () => {
    const data = fixture(true)
    const manifest = await collectDependencyManifest(data.archive, data.asar, data.filesystem)
    expect(manifest.files.map((file) => file.path)).toEqual([
      '@antfu/install-pkg/dist/index.js',
      '@esbuild/win32-x64/esbuild.exe',
      'esbuild/lib/main.js',
      'npm/bin/npm-cli.js',
    ])
    expect(data.asar.statFile).toHaveBeenCalledWith(
      data.archive,
      'node_modules\\@antfu\\install-pkg',
      true,
    )
    expect(data.asar.extractFile).toHaveBeenCalledExactlyOnceWith(
      data.archive,
      'node_modules\\@antfu\\install-pkg\\dist\\index.js',
    )
    expect(data.filesystem.stat).toHaveBeenCalledExactlyOnceWith(
      'C:\\Life\\resources\\app.asar.unpacked\\node_modules\\@esbuild\\win32-x64\\esbuild.exe',
    )
    for (const file of manifest.files) {
      expect(file.path).not.toContain('\\')
      expect(file.sha256).toBe(hash(data.payloads[`node_modules/${file.path}`]))
      expect(file.size).toBe(data.payloads[`node_modules/${file.path}`].length)
    }
    expect(manifest.files.find((file) => file.path.endsWith('.exe'))).not.toHaveProperty(
      'executable',
    )
    expect(manifest.format).toBe(1)
    expect(manifest.key).toBe(
      createHash('sha256').update(JSON.stringify(manifest.files)).digest('hex'),
    )
  })

  it('produces identical portable file identities and cache keys from equivalent Windows and POSIX payloads', async () => {
    const windows = fixture(true)
    const unix = fixture(false)
    const [windowsManifest, unixManifest] = await Promise.all([
      collectDependencyManifest(windows.archive, windows.asar, windows.filesystem),
      collectDependencyManifest(unix.archive, unix.asar, unix.filesystem),
    ])
    expect(windowsManifest).toEqual(unixManifest)
    expect(unix.asar.extractFile).toHaveBeenCalledExactlyOnceWith(
      unix.archive,
      'node_modules/@antfu/install-pkg/dist/index.js',
    )
  })

  it('preserves packed and unpacked executable modes on Unix without depending on manifest path separators', async () => {
    const data = fixture(false, 0o755)
    const binary = data.entries.get('node_modules/@esbuild/win32-x64/esbuild.exe')!
    data.entries.delete('node_modules/@esbuild/win32-x64/esbuild.exe')
    data.entries.set('node_modules/@esbuild/linux-x64/bin/esbuild', binary)
    data.entries.get('node_modules/npm/bin/npm-cli.js')!.executable = true
    data.filesystem.stat.mockImplementation(async (filename) => {
      expect(filename).toBe(
        '/Life/resources/app.asar.unpacked/node_modules/@esbuild/linux-x64/bin/esbuild',
      )
      return { mode: 0o755 }
    })
    const manifest = await collectDependencyManifest(data.archive, data.asar, data.filesystem)
    expect(
      manifest.files.find((file) => file.path === '@esbuild/linux-x64/bin/esbuild')?.executable,
    ).toBe(true)
    expect(manifest.files.find((file) => file.path === 'npm/bin/npm-cli.js')?.executable).toBe(true)
    expect(manifest.files.find((file) => file.path === 'esbuild/lib/main.js')).not.toHaveProperty(
      'executable',
    )
  })

  it('extracts bytes when ASAR integrity uses another algorithm', async () => {
    const data = fixture(true)
    data.entries.get('node_modules\\esbuild\\lib\\main.js')!.integrity = {
      algorithm: 'SHA512',
      hash: 'not-a-sha256',
    }
    const manifest = await collectDependencyManifest(data.archive, data.asar, data.filesystem)
    expect(data.asar.extractFile).toHaveBeenCalledWith(
      data.archive,
      'node_modules\\esbuild\\lib\\main.js',
    )
    expect(manifest.files.find((file) => file.path === 'esbuild/lib/main.js')?.sha256).toBe(
      hash(data.payloads['node_modules/esbuild/lib/main.js']),
    )
  })

  it.each([
    ['node_modules/npm/bin/npm-cli.js', 'Packaged npm is missing'],
    ['node_modules/esbuild/lib/main.js', 'Packaged esbuild is missing'],
    [
      'node_modules/@esbuild/win32-x64/esbuild.exe',
      'target-platform esbuild executable is missing',
    ],
  ])('rejects a payload missing required tool %s', async (missing, message) => {
    const data = fixture(true)
    data.entries.delete(data.nativeName(missing))
    await expect(
      collectDependencyManifest(data.archive, data.asar, data.filesystem),
    ).rejects.toThrow(message)
  })

  it('reads a real ASAR archive with a nested scoped package and the required tool payload', async () => {
    const root = await mkdtemp(join(tmpdir(), 'life-dependency-manifest-'))
    directories.push(root)
    const source = join(root, 'source')
    const archive = join(root, 'app.asar')
    const files = {
      'node_modules/npm/bin/npm-cli.js': 'console.log("npm")\n',
      'node_modules/esbuild/lib/main.js': 'exports.build = () => {}\n',
      'node_modules/@esbuild/win32-x64/esbuild.exe': 'target binary fixture\n',
      'node_modules/@antfu/install-pkg/dist/index.js': 'export const scoped = true\n',
      'out/main/index.js': 'non-dependency ignored\n',
    }
    for (const [name, contents] of Object.entries(files)) {
      const filename = join(source, name)
      await mkdir(dirname(filename), { recursive: true })
      await writeFile(filename, contents)
    }
    const builderRequire = createRequire(require.resolve('app-builder-lib'))
    const asar = await import(pathToFileURL(builderRequire.resolve('@electron/asar')).href)
    await asar.createPackage(source, archive)
    const manifest = await collectDependencyManifest(archive, asar)
    expect(manifest.files).toHaveLength(4)
    expect(manifest.files.find((file) => file.path === '@antfu/install-pkg/dist/index.js')).toEqual(
      {
        path: '@antfu/install-pkg/dist/index.js',
        size: Buffer.byteLength(files['node_modules/@antfu/install-pkg/dist/index.js']),
        sha256: hash(Buffer.from(files['node_modules/@antfu/install-pkg/dist/index.js'])),
      },
    )
  })
})
