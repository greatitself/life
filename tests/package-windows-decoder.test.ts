import { createHash } from 'node:crypto'
import { createServer, type Server, type ServerResponse } from 'node:http'
import { createRequire } from 'node:module'
import { mkdir, mkdtemp, readFile, readdir, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { basename, dirname, join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'

type Pin = { bytes: number; sha256: string }
type Replacement = { source: string; destination: string }
type Context = {
  electronPlatformName: string
  arch: number
  appOutDir: string
  packager: { projectDir: string; getResourcesDir: (output: string) => string }
}

const require = createRequire(import.meta.url)
const filesystem = require('node:fs/promises') as typeof import('node:fs/promises')
const {
  downloadPinned,
  validatePinnedFile,
  validateX64Executable,
  promoteDirectories,
  packageWindowsDecoderResources,
} = require('../scripts/package-windows-decoder.cjs') as {
  downloadPinned: (url: string, filename: string, pin: Pin, fetcher?: typeof fetch) => Promise<void>
  validatePinnedFile: (filename: string, pin: Pin) => Promise<void>
  validateX64Executable: (buffer: Buffer) => void
  promoteDirectories: (replacements: Replacement[]) => Promise<void>
  packageWindowsDecoderResources: (
    context: Context,
    services?: {
      prepareBundle: (options: { root: string; output: string }) => Promise<unknown>
      buildPlugin?: (root: string) => Promise<void>
    },
  ) => Promise<boolean>
}

const roots: string[] = []
const servers: Server[] = []
afterEach(async () => {
  vi.restoreAllMocks()
  await Promise.all(
    servers.splice(0).map(
      (server) =>
        new Promise<void>((resolve, reject) => {
          server.closeAllConnections()
          server.close((error) => (error ? reject(error) : resolve()))
        }),
    ),
  )
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })))
})

async function fixtureRoot() {
  const root = await mkdtemp(join(tmpdir(), 'life-package-decoder-test-'))
  roots.push(root)
  return root
}

function pin(bytes: Buffer): Pin {
  return { bytes: bytes.length, sha256: createHash('sha256').update(bytes).digest('hex') }
}

async function httpEndpoint(handler: (response: ServerResponse) => void) {
  const server = createServer((_request, response) => handler(response))
  servers.push(server)
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject)
    server.listen(0, '127.0.0.1', resolve)
  })
  const address = server.address()
  if (!address || typeof address === 'string') throw new Error('Expected a local TCP endpoint')
  return `http://127.0.0.1:${address.port}/pinned-archive`
}

async function directoryWithFile(root: string, name: string, contents: string) {
  const directory = join(root, name)
  await mkdir(directory, { recursive: true })
  await writeFile(join(directory, 'payload.txt'), contents)
  return directory
}

async function inventory(root: string, prefix = ''): Promise<Record<string, string>> {
  const result: Record<string, string> = {}
  for (const entry of await readdir(root, { withFileTypes: true })) {
    const name = `${prefix}${entry.name}`
    if (entry.isDirectory()) {
      result[`${name}/`] = 'directory'
      Object.assign(result, await inventory(join(root, entry.name), `${name}/`))
    } else {
      result[name] = (await readFile(join(root, entry.name))).toString('hex')
    }
  }
  return result
}

async function rejection(operation: Promise<unknown>): Promise<Error> {
  try {
    await operation
  } catch (error) {
    expect(error).toBeInstanceOf(Error)
    return error as Error
  }
  throw new Error('Expected the operation to fail')
}

function errorTree(error: Error): unknown[] {
  return [
    error,
    ...(error.cause instanceof Error ? errorTree(error.cause) : []),
    ...(error instanceof AggregateError
      ? error.errors.flatMap((entry) => (entry instanceof Error ? errorTree(entry) : [entry]))
      : []),
  ]
}

describe('pinned Windows decoder downloads', () => {
  const bytes = Buffer.from('official archive bytes\0\xff', 'latin1')

  it('checks the complete streamed HTTP body before writing exact bytes', async () => {
    const root = await fixtureRoot()
    const filename = join(root, 'archive.7z')
    const url = await httpEndpoint((response) => {
      response.write(bytes.subarray(0, 3))
      setImmediate(() => response.end(bytes.subarray(3)))
    })
    const fetcher = vi.fn(async (...args: Parameters<typeof fetch>) => {
      expect(args[1]?.signal).toBeInstanceOf(AbortSignal)
      expect(args[1]?.signal?.aborted).toBe(false)
      return fetch(...args)
    })
    await downloadPinned(url, filename, pin(bytes), fetcher)
    expect(await readFile(filename)).toEqual(bytes)
    expect(await readdir(root)).toEqual(['archive.7z'])
    expect(fetcher).toHaveBeenCalledTimes(1)
  })

  it.each([
    [
      'HTTP failure',
      'download failed',
      (response: ServerResponse) => response.writeHead(503).end(bytes),
    ],
    ['truncated body', 'truncated', (response: ServerResponse) => response.end(bytes.subarray(1))],
    [
      'oversized body',
      'exceeds its pinned size',
      (response: ServerResponse) => response.end(Buffer.concat([bytes, Buffer.from('extra')])),
    ],
    [
      'changed bytes',
      'SHA256 mismatch',
      (response: ServerResponse) => {
        const changed = Buffer.from(bytes)
        changed[0] ^= 1
        response.end(changed)
      },
    ],
  ])('rejects %s without publishing a file', async (_name, message, handler) => {
    const root = await fixtureRoot()
    await writeFile(join(root, 'unrelated.txt'), 'preserve me')
    const before = await inventory(root)
    const url = await httpEndpoint(handler)
    await expect(downloadPinned(url, join(root, 'archive.7z'), pin(bytes))).rejects.toThrow(message)
    expect(await inventory(root)).toEqual(before)
  })

  it('preserves a body transport failure and publishes no partial download', async () => {
    const root = await fixtureRoot()
    const url = await httpEndpoint((response) => {
      response.flushHeaders()
      response.write(bytes.subarray(0, 3))
      setImmediate(() => response.destroy())
    })
    await rejection(downloadPinned(url, join(root, 'archive.7z'), pin(bytes)))
    expect(await readdir(root)).toEqual([])
  })

  it('stops consuming an oversized stream and closes its iterator', async () => {
    const root = await fixtureRoot()
    let consumed = 0
    let closed = false
    const body = (async function* () {
      try {
        consumed++
        yield bytes
        consumed++
        yield Buffer.from('one byte too many')
        consumed++
        yield Buffer.alloc(1024)
      } finally {
        closed = true
      }
    })()
    const fetcher = vi.fn(async () => ({ ok: true, status: 200, body }) as unknown as Response)
    await expect(
      downloadPinned('https://fixture.invalid', join(root, 'archive.7z'), pin(bytes), fetcher),
    ).rejects.toThrow('exceeds its pinned size')
    expect(consumed).toBe(2)
    expect(closed).toBe(true)
    expect(await readdir(root)).toEqual([])
  })

  it('rejects a successful HTTP response without a body', async () => {
    const root = await fixtureRoot()
    const fetcher = vi.fn(async () => new Response(null, { status: 200 }))
    await expect(
      downloadPinned('https://fixture.invalid', join(root, 'archive.7z'), pin(bytes), fetcher),
    ).rejects.toThrow('no response body')
    expect(await readdir(root)).toEqual([])
  })

  it('never replaces an existing output, including a symlink to another file', async () => {
    const root = await fixtureRoot()
    const target = join(root, 'previous.7z')
    const filename = join(root, 'archive.7z')
    await writeFile(target, 'previous verified bytes')
    await symlink(target, filename, 'file')
    const fetcher = vi.fn(async () => new Response(bytes))
    await expect(
      downloadPinned('https://fixture.invalid', filename, pin(bytes), fetcher),
    ).rejects.toMatchObject({ code: 'EEXIST' })
    expect(await readFile(target, 'utf8')).toBe('previous verified bytes')
  })
})

describe('decoder file and executable validation', () => {
  it('accepts exact ordinary bytes and rejects same-size tampering', async () => {
    const root = await fixtureRoot()
    const filename = join(root, 'payload')
    const bytes = Buffer.from('pinned executable bytes')
    await writeFile(filename, bytes)
    await expect(validatePinnedFile(filename, pin(bytes))).resolves.toBeUndefined()
    const changed = Buffer.from(bytes)
    changed[0] ^= 1
    await writeFile(filename, changed)
    await expect(validatePinnedFile(filename, pin(bytes))).rejects.toThrow('SHA256 mismatch')
  })

  it('rejects size mismatches, directories and symlinks even when linked bytes match', async () => {
    const root = await fixtureRoot()
    const bytes = Buffer.from('pinned bytes')
    const file = join(root, 'ordinary')
    await writeFile(file, bytes)
    await expect(
      validatePinnedFile(file, { ...pin(bytes), bytes: bytes.length + 1 }),
    ).rejects.toThrow('size mismatch')
    await expect(validatePinnedFile(root, pin(bytes))).rejects.toThrow('ordinary file')
    const link = join(root, 'linked')
    await symlink(file, link, 'file')
    await expect(validatePinnedFile(link, pin(bytes))).rejects.toThrow('ordinary file')
  })

  function executable() {
    const bytes = Buffer.alloc(128)
    bytes.writeUInt16LE(0x5a4d, 0)
    bytes.writeUInt32LE(64, 0x3c)
    bytes.writeUInt32LE(0x4550, 64)
    bytes.writeUInt16LE(0x8664, 68)
    bytes.writeUInt16LE(0x20b, 88)
    return bytes
  }

  it('accepts a bounded native x64 PE32+ header', () => {
    expect(() => validateX64Executable(executable())).not.toThrow()
  })

  it.each([
    ['truncated', () => Buffer.alloc(63), 'Truncated'],
    [
      'wrong DOS signature',
      () => {
        const bytes = executable()
        bytes.writeUInt16LE(0, 0)
        return bytes
      },
      'not a PE',
    ],
    [
      'PE before DOS header',
      () => {
        const bytes = executable()
        bytes.writeUInt32LE(32, 0x3c)
        return bytes
      },
      'header bounds',
    ],
    [
      'PE outside file',
      () => {
        const bytes = executable()
        bytes.writeUInt32LE(0xffffffff, 0x3c)
        return bytes
      },
      'header bounds',
    ],
    [
      'truncated optional header',
      () => {
        const bytes = executable()
        bytes.writeUInt32LE(bytes.length - 25, 0x3c)
        return bytes
      },
      'header bounds',
    ],
    [
      'wrong PE signature',
      () => {
        const bytes = executable()
        bytes.writeUInt32LE(0, 64)
        return bytes
      },
      'PE signature',
    ],
    [
      'ia32 machine',
      () => {
        const bytes = executable()
        bytes.writeUInt16LE(0x14c, 68)
        return bytes
      },
      'native Windows x64',
    ],
    [
      'arm64 machine',
      () => {
        const bytes = executable()
        bytes.writeUInt16LE(0xaa64, 68)
        return bytes
      },
      'native Windows x64',
    ],
    [
      'PE32 optional header',
      () => {
        const bytes = executable()
        bytes.writeUInt16LE(0x10b, 88)
        return bytes
      },
      'PE32+',
    ],
  ])('rejects %s without reading beyond the buffer', (_name, bytes, message) => {
    expect(() => validateX64Executable(bytes())).toThrow(message)
  })
})

describe('decoder directory publication and recovery', () => {
  it('publishes all replacements together and removes owned backups after success', async () => {
    const root = await fixtureRoot()
    const destinations = []
    for (const name of ['tools', 'licenses', 'stable-bootstrap']) {
      const destination = await directoryWithFile(root, name, `previous ${name}`)
      const source = await directoryWithFile(root, `staged-${name}`, `next ${name}`)
      destinations.push({ source, destination })
    }
    await writeFile(join(root, 'unrelated.txt'), 'keep this')
    await promoteDirectories(destinations)
    for (const { destination } of destinations) {
      expect(await readFile(join(destination, 'payload.txt'), 'utf8')).toBe(
        `next ${basename(destination)}`,
      )
    }
    expect((await readdir(root)).sort()).toEqual([
      'licenses',
      'stable-bootstrap',
      'tools',
      'unrelated.txt',
    ])
    expect(await readFile(join(root, 'unrelated.txt'), 'utf8')).toBe('keep this')
  })

  it('restores an earlier replacement when a later destination is an ordinary file', async () => {
    const root = await fixtureRoot()
    const first = await directoryWithFile(root, 'tools', 'previous tools')
    const firstSource = await directoryWithFile(root, 'tools-stage', 'new tools')
    const secondSource = await directoryWithFile(root, 'license-stage', 'new license')
    const invalid = join(root, 'licenses')
    await writeFile(invalid, 'preserve invalid destination')
    await expect(
      promoteDirectories([
        { source: firstSource, destination: first },
        { source: secondSource, destination: invalid },
      ]),
    ).rejects.toThrow('ordinary directory')
    expect(await readFile(join(first, 'payload.txt'), 'utf8')).toBe('previous tools')
    expect(await readFile(invalid, 'utf8')).toBe('preserve invalid destination')
    expect(await readFile(join(secondSource, 'payload.txt'), 'utf8')).toBe('new license')
    expect((await readdir(root)).filter((name) => name.startsWith('.life-decoder-old-'))).toEqual(
      [],
    )
  })

  it('rejects a later destination symlink and preserves its external directory', async () => {
    const root = await fixtureRoot()
    const first = await directoryWithFile(root, 'tools', 'previous tools')
    const firstSource = await directoryWithFile(root, 'tools-stage', 'new tools')
    const outside = await directoryWithFile(root, 'outside', 'outside sentinel')
    const secondSource = await directoryWithFile(root, 'license-stage', 'new license')
    const linked = join(root, 'linked-license')
    await symlink(outside, linked, 'junction')
    await expect(
      promoteDirectories([
        { source: firstSource, destination: first },
        { source: secondSource, destination: linked },
      ]),
    ).rejects.toThrow('ordinary directory')
    expect(await readFile(join(first, 'payload.txt'), 'utf8')).toBe('previous tools')
    expect(await readFile(join(outside, 'payload.txt'), 'utf8')).toBe('outside sentinel')
    expect((await readdir(root)).filter((name) => name.startsWith('.life-decoder-old-'))).toEqual(
      [],
    )
  })

  it('keeps the previous output backup if later setup and rollback both fail', async () => {
    const root = await fixtureRoot()
    const destination = await directoryWithFile(root, 'tools', 'previous verified tools')
    const source = await directoryWithFile(root, 'tools-stage', 'new tools')
    const blocked = join(root, 'blocked-parent')
    await writeFile(blocked, 'parent is a file')
    const rollbackFailure = new Error('Injected inability to remove promoted directory')
    const actualRemove = filesystem.rm
    vi.spyOn(filesystem, 'rm').mockImplementation(async (filename, options) => {
      if (filename === destination) throw rollbackFailure
      return actualRemove(filename, options)
    })
    const failure = await rejection(
      promoteDirectories([
        { source, destination },
        { source: join(root, 'unused-stage'), destination: join(blocked, 'licenses') },
      ]),
    )
    expect(errorTree(failure)).toContain(rollbackFailure)
    const backups = (await readdir(root)).filter((name) => name.startsWith('.life-decoder-old-'))
    expect(backups).toHaveLength(1)
    expect(await readFile(join(root, backups[0], 'previous/payload.txt'), 'utf8')).toBe(
      'previous verified tools',
    )
    expect(await readFile(blocked, 'utf8')).toBe('parent is a file')
  })

  it('retains the primary promotion error when owned backup cleanup also fails', async () => {
    const root = await fixtureRoot()
    const destination = await directoryWithFile(root, 'tools', 'previous tools')
    const cleanupFailure = new Error('Injected owned-backup cleanup failure')
    const actualReadDirectory = filesystem.readdir
    vi.spyOn(filesystem, 'readdir').mockImplementation(((filename: string, options: unknown) => {
      if (String(filename).includes('.life-decoder-old-')) return Promise.reject(cleanupFailure)
      return actualReadDirectory(filename, options as never)
    }) as typeof filesystem.readdir)
    const failure = await rejection(
      promoteDirectories([{ source: join(root, 'missing-stage'), destination }]),
    )
    expect(errorTree(failure)).toContain(cleanupFailure)
    expect(
      errorTree(failure).some((error) => (error as NodeJS.ErrnoException)?.code === 'ENOENT'),
    ).toBe(true)
    expect(await readFile(join(destination, 'payload.txt'), 'utf8')).toBe('previous tools')
  })

  it('preserves an old destination when creating its backup fails without inventing restoration errors', async () => {
    const root = await fixtureRoot()
    const destination = await directoryWithFile(root, 'tools', 'previous tools')
    const source = await directoryWithFile(root, 'tools-stage', 'new tools')
    const before = await inventory(root)
    const backupFailure = new Error('Cannot rename the previous output')
    const actualRename = filesystem.rename
    vi.spyOn(filesystem, 'rename').mockImplementation(async (from, to) => {
      if (from === destination) throw backupFailure
      return actualRename(from, to)
    })
    await expect(promoteDirectories([{ source, destination }])).rejects.toBe(backupFailure)
    expect(await inventory(root)).toEqual(before)
  })
})

describe('Windows decoder afterPack platform gating and failures', () => {
  it.each([
    ['linux', 1],
    ['darwin', 1],
    ['darwin', 3],
    ['win32', 0],
    ['win32', 3],
  ])('skips target %s/%s before preparation or resources access', async (platform, arch) => {
    const prepareBundle = vi.fn(async () => {
      throw new Error('Must not prepare another target')
    })
    const getResourcesDir = vi.fn(() => {
      throw new Error('Must not access another target')
    })
    const buildPlugin = vi.fn(async () => {
      throw new Error('Must not compile a native plugin for another target')
    })
    const context: Context = {
      electronPlatformName: platform,
      arch,
      appOutDir: '/unused/target',
      packager: {
        get projectDir(): string {
          throw new Error('Must not resolve another target project')
        },
        getResourcesDir,
      },
    }
    await expect(
      packageWindowsDecoderResources(context, { prepareBundle, buildPlugin }),
    ).resolves.toBe(false)
    expect(prepareBundle).not.toHaveBeenCalled()
    expect(getResourcesDir).not.toHaveBeenCalled()
    expect(buildPlugin).not.toHaveBeenCalled()
  })

  async function resourcesFixture() {
    const root = await fixtureRoot()
    const resources = join(root, 'app/resources')
    await directoryWithFile(resources, 'life-installer-tools', 'previous decoder')
    await directoryWithFile(resources, 'licenses/7zip-26.04', 'previous notices')
    await directoryWithFile(root, 'output/installer-tools/windows-x64', 'previous bootstrap')
    await directoryWithFile(
      root,
      'output/installer-tools/.life-decoder-stage-unowned',
      'unowned staging sentinel',
    )
    return {
      root,
      context: {
        electronPlatformName: 'win32',
        arch: 1,
        appOutDir: join(root, 'app'),
        packager: { projectDir: root, getResourcesDir: vi.fn(() => resources) },
      } satisfies Context,
    }
  }

  it('preserves all prior installed and bootstrap resources when vendor preparation fails', async () => {
    const { root, context } = await resourcesFixture()
    const before = await inventory(root)
    const vendorFailure = new Error('Pinned vendor archive failed verification')
    let scratch = ''
    const prepareBundle = vi.fn(
      async ({ root: project, output }: { root: string; output: string }) => {
        expect(project).toBe(root)
        scratch = dirname(output)
        await mkdir(output)
        await writeFile(join(output, 'partial-download'), 'unverified vendor bytes')
        throw vendorFailure
      },
    )
    await expect(packageWindowsDecoderResources(context, { prepareBundle })).rejects.toBe(
      vendorFailure,
    )
    expect(context.packager.getResourcesDir).not.toHaveBeenCalled()
    expect(await inventory(root)).toEqual(before)
    await expect(readdir(scratch)).rejects.toMatchObject({ code: 'ENOENT' })
  })

  it('keeps a vendor failure visible when owned scratch cleanup also fails', async () => {
    const { root, context } = await resourcesFixture()
    const before = await inventory(root)
    const vendorFailure = new Error('Vendor preparation failed')
    const cleanupFailure = new Error('Owned scratch cleanup failed')
    let scratch = ''
    const actualRemove = filesystem.rm
    vi.spyOn(filesystem, 'rm').mockImplementation(async (filename, options) => {
      if (filename === scratch) throw cleanupFailure
      return actualRemove(filename, options)
    })
    const prepareBundle = async ({ output }: { root: string; output: string }) => {
      scratch = dirname(output)
      roots.push(scratch)
      throw vendorFailure
    }
    const failure = await rejection(packageWindowsDecoderResources(context, { prepareBundle }))
    expect(errorTree(failure)).toContain(vendorFailure)
    expect(errorTree(failure)).toContain(cleanupFailure)
    expect(context.packager.getResourcesDir).not.toHaveBeenCalled()
    expect(await inventory(root)).toEqual(before)
  })
})
