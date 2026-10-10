import { createHash } from 'node:crypto'
import { mkdtemp, mkdir, readFile, rm, symlink, writeFile } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'

const require = createRequire(import.meta.url)
const {
  safeArchivePath,
  parseArchiveListing,
  collectTree,
  assertExactTree,
  renderVerifier,
  writeSnapshot,
} = require('../scripts/generate-installer-payload.cjs')
const roots: string[] = []
const digest = (value: string) => createHash('sha256').update(value).digest('hex')

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), 'life-payload-test-'))
  roots.push(root)
  await mkdir(join(root, 'resources'))
  await writeFile(join(root, 'Life.exe'), 'original executable')
  await writeFile(join(root, 'resources', 'app.asar'), 'original archive')
  return root
}

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })))
})

describe('trusted Windows installer payload manifest', () => {
  it('binds diagnostic snapshot bytes and complete inventory to the trusted archive digest', async () => {
    const root = await fixture()
    const entries = await collectTree(root)
    const archive = join(root, 'test.7z')
    await writeFile(archive, 'exact diagnostic archive')
    const directory = join(root, 'snapshot')
    await writeSnapshot(archive, '64', digest('exact diagnostic archive'), entries, directory)
    expect(await readFile(join(directory, 'app-64.7z'), 'utf8')).toBe('exact diagnostic archive')
    expect(JSON.parse(await readFile(join(directory, 'app-64.json'), 'utf8'))).toEqual({
      format: 1,
      arch: '64',
      archiveSha256: digest('exact diagnostic archive'),
      archiveSize: 24,
      entries,
    })
    await writeFile(archive, 'wrong diagnostic archive')
    await expect(
      writeSnapshot(archive, '64', digest('exact diagnostic archive'), entries, directory),
    ).rejects.toThrow('differs')
    expect(await readFile(join(directory, 'app-64.7z'), 'utf8')).toBe('exact diagnostic archive')
  })

  it('hashes the complete tree deterministically and detects same-length changed bytes', async () => {
    const root = await fixture()
    const original = await collectTree(root)
    expect(original).toEqual([
      { path: 'Life.exe', directory: false, size: 19, sha256: digest('original executable') },
      { path: 'resources', directory: true, size: 0 },
      {
        path: 'resources/app.asar',
        directory: false,
        size: 16,
        sha256: digest('original archive'),
      },
    ])
    expect(await collectTree(root)).toEqual(original)
    await writeFile(join(root, 'resources', 'app.asar'), 'modified archive')
    const changed = await collectTree(root)
    expect(() => assertExactTree(original, changed)).not.toThrow()
    expect(changed[2].sha256).not.toBe(original[2].sha256)
    expect(renderVerifier(changed, '64', digest('package'))).not.toBe(
      renderVerifier(original, '64', digest('package')),
    )
  })

  it('rejects extra, missing, truncated and substituted-directory inventory', async () => {
    const root = await fixture()
    const expected = await collectTree(root)
    await writeFile(join(root, 'unexpected.bin'), 'unexpected')
    expect(() =>
      assertExactTree(expected, [
        ...expected,
        { path: 'unexpected.bin', directory: false, size: 10 },
      ]),
    ).toThrow('differs')
    expect(() => assertExactTree(expected, expected.slice(1))).toThrow('differs')
    expect(() =>
      assertExactTree(
        expected,
        expected.map((entry: { path: string }) =>
          entry.path === 'Life.exe' ? { ...entry, size: 1 } : entry,
        ),
      ),
    ).toThrow('differs')
    expect(() =>
      assertExactTree(
        expected,
        expected.map((entry: { path: string }) =>
          entry.path === 'resources' ? { ...entry, directory: false } : entry,
        ),
      ),
    ).toThrow('differs')
  })

  it('rejects a linked tree instead of reading outside its extraction root', async () => {
    const root = await fixture()
    await symlink(join(root, 'Life.exe'), join(root, 'linked.exe'))
    await expect(collectTree(root)).rejects.toThrow('linked')
  })

  it.each([
    '../outside',
    '/absolute',
    'C:\\outside',
    '\\\\server\\share',
    'dir//file',
    'dir/./file',
    'dir/file:stream',
    'dir/file.',
    'dir/file ',
    'NUL.bin',
    'com1.exe',
    'dir\nfile',
  ])('rejects Windows traversal or ambiguous path %s', (value) => {
    expect(() => safeArchivePath(value)).toThrow('Unsupported')
  })

  it('retains literal dollars, apostrophes and backticks without NSIS command injection', () => {
    const entry = { path: "a$0'`file.exe", directory: false, size: 1, sha256: digest('x') }
    const source = renderVerifier([entry], '64', digest('archive'))
    expect(source).toContain('StrCpy $2 "$0\\a$$0\'`file.exe"')
    expect(source).toContain('GetFileAttributesW(w r2)')
    expect(source).not.toContain('GetFileAttributesW(w "')
  })

  it('parses actual 7z-style empty fields and complete directory hierarchy', () => {
    const listing =
      'Path = resources\r\nSize = 0\r\nAttributes = D\r\nCRC = \r\n\r\n' +
      'Path = resources/app.asar\r\nSize = 12\r\nAttributes = A\r\nEncrypted = -\r\n\r\n'
    expect(parseArchiveListing(listing)).toEqual([
      { path: 'resources', size: 0, directory: true },
      { path: 'resources/app.asar', size: 12, directory: false },
    ])
  })

  it.each([
    'Path = Life.exe\nSize = 1\nAttributes = A\n\nPath = life.EXE\nSize = 1\nAttributes = A\n',
    'Path = dir/file\nSize = 1\nAttributes = A\n',
    'Path = Life.exe\nSize = 1\nAttributes = A\nEncrypted = +\n',
    'Path = Life.exe\nSize = 1\nAttributes = A\nSymbolic Link = target\n',
    'Path = Life.exe\nSize = 1\nSize = 2\nAttributes = A\n',
  ])('rejects incomplete, duplicated or unsupported archive records', (listing) => {
    expect(() => parseArchiveListing(listing)).toThrow()
  })

  it.each(['64', '32', 'ARM64'])(
    'separates %s architecture functions and verifies complete hashes',
    async (arch) => {
      const entries = await collectTree(await fixture())
      const source = renderVerifier(entries, arch, digest('archive'))
      expect(source).toContain(`!macro LifeVerifyPayload${arch} DIRECTORY RESULT`)
      expect(source).toContain(`Function LifeVerifyPayload${arch}`)
      expect(source.match(/SHA2-256/g)).toHaveLength(2)
      expect(source).toContain(digest('original executable'))
      expect(source).toContain(digest('original archive'))
      expect(source).toContain('StrCmp $R1 18')
      expect(source).toContain('FindNextFileW(p r5, p R0) i.r3 ?re')
      expect(source).toContain(`!macro LifeVerifyStagedPayload${arch} DIRECTORY RESULT`)
      expect(source).toContain('IntOp $3 $3 & 0x410')
    },
  )

  it('rejects incomplete file hashes and invalid architecture or archive digests', async () => {
    const entries = await collectTree(await fixture())
    expect(() => renderVerifier(entries, 'unknown', digest('archive'))).toThrow('architecture')
    expect(() => renderVerifier(entries, '64', 'bad')).toThrow('digest')
    expect(() =>
      renderVerifier(
        entries.map((entry: object) => ({ ...entry, sha256: 'bad' })),
        '64',
        digest('archive'),
      ),
    ).toThrow('file digest')
  })
})
