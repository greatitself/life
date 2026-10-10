'use strict'

// Build-time only. The Windows installer carries the unmodified decoder,
// its complete notices and the exact corresponding source in the same payload.
const assert = require('node:assert/strict')
const { createHash } = require('node:crypto')
const { createReadStream } = require('node:fs')
const fs = require('node:fs/promises')
const os = require('node:os')
const path = require('node:path')
const { promisify } = require('node:util')
const execFile = promisify(require('node:child_process').execFile)

const binaryName = '7za-26.04-x64.exe'
const sourceName = '7z2604-src.tar.xz'
const binaryNames = [binaryName]
const noticeNames = ['7zip-License.txt', 'LGPL-2.1.txt', sourceName, 'PROVENANCE.json']
const pins = Object.freeze({
  extra: Object.freeze({
    url: 'https://github.com/ip7z/7zip/releases/download/26.04/7z2604-extra.7z',
    bytes: 1764616,
    sha256: 'dc4b11d3399db18b063630137145f5585d8f7ac847bf3639bd1185d7d1f7cee0',
  }),
  source: Object.freeze({
    url: 'https://github.com/ip7z/7zip/releases/download/26.04/7z2604-src.tar.xz',
    bytes: 1560440,
    sha256: '9691944c0fe0d01bb49373a704fb983fd33bc98b1738695179dfbf99ac1734f6',
  }),
  binary: Object.freeze({
    bytes: 1335808,
    sha256: '15d4c788c148e3677e2fc1c4a01f191fb6669eba4f6acf8a465f0f1a6f1e1260',
  }),
  license: Object.freeze({
    bytes: 5188,
    sha256: '39d2187b942cc88818dd959e53c6b7dddd152097a42061467c4d56050168d646',
  }),
  lgpl: Object.freeze({
    bytes: 27032,
    sha256: '1e7e6bae5a5bde32f1ae5a7c37a082d1ab03cf89354f7f936ac40be9e39a6531',
  }),
})

async function hashFile(filename) {
  const hash = createHash('sha256')
  for await (const chunk of createReadStream(filename)) hash.update(chunk)
  return hash.digest('hex')
}

async function validatePinnedFile(filename, pin) {
  const stat = await fs.lstat(filename)
  assert(stat.isFile() && !stat.isSymbolicLink(), `Expected an ordinary file: ${filename}`)
  assert.equal(stat.size, pin.bytes, `Pinned decoder file size mismatch: ${filename}`)
  assert.equal(await hashFile(filename), pin.sha256, `Pinned decoder SHA256 mismatch: ${filename}`)
}

function validateX64Executable(buffer) {
  assert(buffer.length >= 64, 'Truncated decoder PE header')
  assert.equal(buffer.readUInt16LE(0), 0x5a4d, 'Decoder is not a PE executable')
  const pe = buffer.readUInt32LE(0x3c)
  assert(pe >= 64 && pe <= buffer.length - 26, 'Invalid decoder PE header bounds')
  assert.equal(buffer.readUInt32LE(pe), 0x00004550, 'Invalid decoder PE signature')
  assert.equal(buffer.readUInt16LE(pe + 4), 0x8664, 'Decoder must be native Windows x64')
  assert.equal(buffer.readUInt16LE(pe + 24), 0x20b, 'Decoder must use a PE32+ optional header')
}

async function validateDecoderBundle(directory) {
  assert.deepEqual(
    (await fs.readdir(directory)).sort(),
    [...binaryNames, ...noticeNames].sort(),
    'Unexpected decoder bundle inventory',
  )
  await validatePinnedFile(path.join(directory, binaryName), pins.binary)
  validateX64Executable(await fs.readFile(path.join(directory, binaryName)))
  await validatePinnedFile(path.join(directory, sourceName), pins.source)
  await validatePinnedFile(path.join(directory, '7zip-License.txt'), pins.license)
  await validatePinnedFile(path.join(directory, 'LGPL-2.1.txt'), pins.lgpl)
  const provenance = JSON.parse(await fs.readFile(path.join(directory, 'PROVENANCE.json'), 'utf8'))
  assert.equal(provenance.format, 1, 'Invalid decoder provenance format')
  assert.equal(provenance.version, '26.04', 'Invalid decoder provenance version')
  assert.equal(provenance.unmodifiedBinary, true, 'Decoder must remain unmodified')
  assert.equal(provenance.binary.sha256, pins.binary.sha256, 'Invalid decoder binary provenance')
  assert.equal(
    provenance.correspondingSource.sha256,
    pins.source.sha256,
    'Invalid decoder source provenance',
  )
}

async function downloadPinned(url, filename, pin, fetcher = fetch) {
  const response = await fetcher(url, { signal: AbortSignal.timeout(60000) })
  assert(response.ok, `Official decoder download failed (${response.status}): ${url}`)
  assert(response.body, 'Official decoder download has no response body')
  const chunks = []
  let bytes = 0
  for await (const chunk of response.body) {
    bytes += chunk.length
    assert(bytes <= pin.bytes, `Official decoder download exceeds its pinned size: ${url}`)
    chunks.push(Buffer.from(chunk))
  }
  assert.equal(bytes, pin.bytes, `Official decoder download is truncated: ${url}`)
  const buffer = Buffer.concat(chunks, bytes)
  assert.equal(
    createHash('sha256').update(buffer).digest('hex'),
    pin.sha256,
    `Official decoder archive SHA256 mismatch: ${url}`,
  )
  await fs.writeFile(filename, buffer, { flag: 'wx' })
}

// Each rename is atomic. Keep previous directories until all replacements succeed,
// and restore them if a later promotion fails. Never remove an unowned temporary path.
async function promoteDirectories(replacements) {
  const transactions = []
  let committed = false
  let primaryError = null
  try {
    for (const { source, destination } of replacements) {
      await fs.mkdir(path.dirname(destination), { recursive: true })
      const transaction = {
        source,
        destination,
        backup: null,
        backupDirectory: null,
        promoted: false,
      }
      transactions.push(transaction)
      const existing = await fs.lstat(destination).catch((error) => {
        if (error.code === 'ENOENT') return null
        throw error
      })
      if (existing) {
        assert(
          existing.isDirectory() && !existing.isSymbolicLink(),
          `Decoder output must be an ordinary directory: ${destination}`,
        )
        const backup = await fs.mkdtemp(path.join(path.dirname(destination), '.life-decoder-old-'))
        transaction.backupDirectory = backup
        const previous = path.join(backup, 'previous')
        await fs.rename(destination, previous)
        transaction.backup = previous
      }
      await fs.rename(source, destination)
      transaction.promoted = true
    }
    committed = true
  } catch (error) {
    const rollbackErrors = []
    for (const transaction of transactions.reverse()) {
      try {
        if (transaction.promoted) await fs.rm(transaction.destination, { recursive: true })
        if (transaction.backup) await fs.rename(transaction.backup, transaction.destination)
      } catch (rollbackError) {
        rollbackErrors.push(rollbackError)
      }
    }
    if (rollbackErrors.length) {
      primaryError = new AggregateError(
        [error, ...rollbackErrors],
        'Decoder promotion and restoration failed',
        {
          cause: error,
        },
      )
      throw primaryError
    }
    primaryError = error
    throw error
  } finally {
    const cleanupErrors = []
    for (const transaction of transactions) {
      if (transaction.backupDirectory) {
        try {
          // A failed restoration retains its previous directory for diagnosis/recovery.
          const remaining = await fs.readdir(transaction.backupDirectory)
          if (!remaining.length || committed) {
            await fs.rm(transaction.backupDirectory, { recursive: true })
          }
        } catch (error) {
          cleanupErrors.push(error)
        }
      }
    }
    if (cleanupErrors.length) {
      throw new AggregateError(
        primaryError ? [primaryError, ...cleanupErrors] : cleanupErrors,
        'Decoder backup cleanup failed',
        primaryError ? { cause: primaryError } : undefined,
      )
    }
  }
}

async function cleanupOwnedPaths(paths, primaryError, description) {
  const errors = []
  for (const filename of paths) {
    try {
      await fs.rm(filename, { recursive: true, force: true })
    } catch (error) {
      errors.push(error)
    }
  }
  if (errors.length) {
    throw new AggregateError(
      primaryError ? [primaryError, ...errors] : errors,
      description,
      primaryError ? { cause: primaryError } : undefined,
    )
  }
}

async function prepareWindowsDecoderBundle({ root, output }) {
  root = path.resolve(root || process.cwd())
  output = path.resolve(output)
  const scratch = await fs.mkdtemp(path.join(os.tmpdir(), 'life-decoder-package-'))
  let staged = null
  let primaryError = null
  try {
    const { getPath7za } = require(
      path.join(root, 'node_modules/app-builder-lib/out/toolsets/7zip.js'),
    )
    const sevenZip = await getPath7za()
    const extra = path.join(scratch, 'official-extra.7z')
    const source = path.join(scratch, sourceName)
    await downloadPinned(pins.extra.url, extra, pins.extra)
    await downloadPinned(pins.source.url, source, pins.source)
    const extracted = path.join(scratch, 'extra')
    await execFile(
      sevenZip,
      [
        'x',
        '-t7z',
        '-y',
        '-aoa',
        '-bd',
        '-bb0',
        `-o${extracted}`,
        '--',
        extra,
        'x64/7za.exe',
        'License.txt',
      ],
      { maxBuffer: 1024 * 1024 },
    )
    const binary = path.join(extracted, 'x64/7za.exe')
    const license = path.join(extracted, 'License.txt')
    const lgpl = path.join(root, 'scripts/decoder-diagnostic-notices/7zip-LGPL-2.1.txt')
    await validatePinnedFile(binary, pins.binary)
    validateX64Executable(await fs.readFile(binary))
    await validatePinnedFile(license, pins.license)
    await validatePinnedFile(lgpl, pins.lgpl)
    await validatePinnedFile(source, pins.source)
    // Stage on the destination filesystem only after all vendor bytes are verified.
    await fs.mkdir(path.dirname(output), { recursive: true })
    staged = await fs.mkdtemp(path.join(path.dirname(output), '.life-decoder-stage-'))
    await fs.copyFile(binary, path.join(staged, binaryName))
    await fs.copyFile(license, path.join(staged, '7zip-License.txt'))
    await fs.copyFile(lgpl, path.join(staged, 'LGPL-2.1.txt'))
    await fs.copyFile(source, path.join(staged, sourceName))
    await fs.writeFile(
      path.join(staged, 'PROVENANCE.json'),
      JSON.stringify(
        {
          format: 1,
          software: '7-Zip Extra',
          version: '26.04',
          unmodifiedBinary: true,
          binary: { filename: binaryName, ...pins.binary, machine: '0x8664' },
          officialExtra: pins.extra,
          correspondingSource: { filename: sourceName, ...pins.source },
          notices: [
            {
              filename: '7zip-License.txt',
              ...pins.license,
              origin: 'Official Extra/License.txt',
            },
            { filename: 'LGPL-2.1.txt', ...pins.lgpl, origin: 'Official source DOC/copying.txt' },
          ],
          distribution:
            'The binary, complete notices and corresponding source are included in the same Life Windows installer payload.',
        },
        null,
        2,
      ) + '\n',
    )
    await validateDecoderBundle(staged)
    await promoteDirectories([{ source: staged, destination: output }])
    return output
  } catch (error) {
    primaryError = error
    throw error
  } finally {
    await cleanupOwnedPaths(
      [staged, scratch].filter(Boolean),
      primaryError,
      'Decoder bundle cleanup failed',
    )
  }
}

async function buildModernExtractor(root) {
  const output = path.join(root, 'output/installer-tools/nsis-plugins/x86-unicode')
  const result = await execFile(
    process.execPath,
    [path.join(root, 'scripts/build-modern-extractor.cjs'), '--output-directory', output],
    { cwd: root, maxBuffer: 1024 * 1024 },
  )
  if (result.stdout) process.stdout.write(result.stdout)
  if (result.stderr) process.stderr.write(result.stderr)
}

async function packageWindowsDecoderResources(context, services = {}) {
  // Arch.x64 is 1 in builder-util; gate on the target, including cross-packaging.
  if (context.electronPlatformName !== 'win32' || context.arch !== 1) return false
  const root = context.packager.projectDir
  const scratch = await fs.mkdtemp(path.join(os.tmpdir(), 'life-decoder-resources-'))
  const stagedDirectories = []
  let primaryError = null
  try {
    const bundle = path.join(scratch, 'bundle')
    await (services.prepareBundle || prepareWindowsDecoderBundle)({ root, output: bundle })
    await validateDecoderBundle(bundle)
    await (services.buildPlugin || buildModernExtractor)(root)
    const resources = context.packager.getResourcesDir(context.appOutDir)
    const destinations = [
      { destination: path.join(resources, 'life-installer-tools'), names: binaryNames },
      { destination: path.join(resources, 'licenses/7zip-26.04'), names: noticeNames },
      {
        destination: path.join(root, 'output/installer-tools/windows-x64'),
        names: [...binaryNames, ...noticeNames],
      },
    ]
    for (const { destination, names } of destinations) {
      await fs.mkdir(path.dirname(destination), { recursive: true })
      const staged = await fs.mkdtemp(path.join(path.dirname(destination), '.life-decoder-stage-'))
      stagedDirectories.push({ source: staged, destination })
      const filePins = {
        [binaryName]: pins.binary,
        [sourceName]: pins.source,
        '7zip-License.txt': pins.license,
        'LGPL-2.1.txt': pins.lgpl,
      }
      for (const name of names) {
        const source = path.join(bundle, name)
        const target = path.join(staged, name)
        const pin = filePins[name] || {
          bytes: (await fs.stat(source)).size,
          sha256: await hashFile(source),
        }
        await fs.copyFile(source, target)
        await validatePinnedFile(target, pin)
      }
    }
    await promoteDirectories(stagedDirectories)
    console.log(
      '  • Windows x64 installer decoder: pinned 7-Zip 26.04, complete notices and corresponding source',
    )
    return true
  } catch (error) {
    primaryError = error
    throw error
  } finally {
    await cleanupOwnedPaths(
      [...stagedDirectories.map(({ source }) => source), scratch],
      primaryError,
      'Decoder resource cleanup failed',
    )
  }
}

module.exports = {
  binaryName,
  sourceName,
  noticeNames,
  pins,
  validatePinnedFile,
  validateX64Executable,
  validateDecoderBundle,
  downloadPinned,
  promoteDirectories,
  prepareWindowsDecoderBundle,
  packageWindowsDecoderResources,
}

if (require.main === module) {
  const args = process.argv.slice(2)
  const outputIndex = args.indexOf('--output')
  const rootIndex = args.indexOf('--root')
  if (outputIndex < 0 || !args[outputIndex + 1]) {
    console.error(
      'Usage: node scripts/package-windows-decoder.cjs --output DIRECTORY [--root ROOT]',
    )
    process.exitCode = 1
  } else {
    prepareWindowsDecoderBundle({
      output: args[outputIndex + 1],
      root: rootIndex < 0 ? process.cwd() : args[rootIndex + 1],
    }).catch((error) => {
      console.error(error)
      process.exitCode = 1
    })
  }
}
