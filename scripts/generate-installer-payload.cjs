'use strict'

// Compile trusted hashes from the exact final archive, including builder-injected
// helpers. Runtime verification never trusts a manifest extracted with the app.
const { createHash } = require('node:crypto')
const fs = require('node:fs/promises')
const { createReadStream } = require('node:fs')
const { tmpdir } = require('node:os')
const path = require('node:path')
const { promisify } = require('node:util')
const execFile = promisify(require('node:child_process').execFile)

function safeArchivePath(value) {
  const normalized = value.replaceAll('\\', '/')
  if (!normalized || /[\x00-\x1f\x7f<>:"|?*]/.test(normalized))
    throw new Error(`Unsupported Windows payload path: ${JSON.stringify(value)}`)
  for (const component of normalized.split('/')) {
    if (
      !component ||
      component === '.' ||
      component === '..' ||
      /[ .]$/.test(component) ||
      /^(?:CON|PRN|AUX|NUL|COM[1-9]|LPT[1-9])(?:\.|$)/i.test(component)
    )
      throw new Error(`Unsupported Windows payload path: ${JSON.stringify(value)}`)
  }
  if (normalized.length > 700) throw new Error('Payload path exceeds the NSIS verifier limit.')
  return normalized
}

function parseArchiveListing(listing) {
  const entries = []
  const seen = new Set()
  for (const record of listing.replaceAll('\r\n', '\n').split(/\n\s*\n/)) {
    if (!record.trim()) continue
    const fields = new Map()
    for (const line of record.split('\n').filter((line) => line !== '')) {
      const separator = line.indexOf(' = ')
      if (separator < 0) throw new Error('Invalid 7z payload listing.')
      const key = line.slice(0, separator)
      if (fields.has(key)) throw new Error('Ambiguous 7z payload listing.')
      fields.set(key, line.slice(separator + 3))
    }
    if (!fields.has('Path') || !fields.has('Attributes') || !fields.has('Size'))
      throw new Error('Incomplete 7z payload listing.')
    if (fields.get('Encrypted') === '+' || fields.has('Symbolic Link') || fields.has('Hard Link'))
      throw new Error('Encrypted or linked payload entries are unsupported.')
    const name = safeArchivePath(fields.get('Path'))
    const identity = name.toLowerCase()
    if (seen.has(identity)) throw new Error('Duplicate Windows payload path.')
    seen.add(identity)
    const size = Number(fields.get('Size'))
    if (!Number.isSafeInteger(size) || size < 0) throw new Error('Invalid payload entry size.')
    const directory = fields.get('Attributes').includes('D')
    entries.push({ path: name, directory, size })
  }
  if (!entries.some((entry) => !entry.directory)) throw new Error('The payload has no files.')
  for (const entry of entries) {
    let parent = path.posix.dirname(entry.path)
    while (parent !== '.') {
      const matching = entries.find(
        (candidate) => candidate.path.toLowerCase() === parent.toLowerCase(),
      )
      if (!matching?.directory)
        throw new Error('A payload parent directory is missing or ambiguous.')
      parent = path.posix.dirname(parent)
    }
  }
  return entries.sort((a, b) => a.path.localeCompare(b.path, 'en'))
}

async function hashFile(filename) {
  const hash = createHash('sha256')
  for await (const chunk of createReadStream(filename)) hash.update(chunk)
  return hash.digest('hex')
}

async function collectTree(root) {
  const entries = []
  async function visit(directory, relative) {
    for (const name of (await fs.readdir(directory)).sort()) {
      const portable = safeArchivePath(relative ? `${relative}/${name}` : name)
      const filename = path.join(directory, name)
      const stat = await fs.lstat(filename)
      if (stat.isSymbolicLink() || (!stat.isDirectory() && !stat.isFile()))
        throw new Error('The extracted payload contains a linked or nonregular entry.')
      if (stat.isDirectory()) {
        entries.push({ path: portable, directory: true, size: 0 })
        await visit(filename, portable)
      } else {
        entries.push({
          path: portable,
          directory: false,
          size: stat.size,
          sha256: await hashFile(filename),
        })
      }
    }
  }
  await visit(root, '')
  return entries.sort((a, b) => a.path.localeCompare(b.path, 'en'))
}

function assertExactTree(listed, extracted) {
  const inventory = (entries) =>
    entries.map(({ path: name, directory, size }) => ({ path: name, directory, size }))
  if (JSON.stringify(inventory(listed)) !== JSON.stringify(inventory(extracted)))
    throw new Error('Extracted payload differs from the exact archive inventory.')
}

function nsisLiteral(value) {
  return value.replaceAll('$', () => '$$').replaceAll('/', '\\')
}

function renderPreflight(entries, arch) {
  const prefix = `LifePreflightPayload${arch}`
  const lines = [
    `!macro ${prefix} DIRECTORY RESULT`,
    '  Push "${DIRECTORY}"',
    `  Call ${prefix}`,
    '  Pop ${RESULT}',
    '!macroend',
    `Function ${prefix}`,
    '  Exch $0',
    '  Push $1',
    '  Push $2',
    '  Push $3',
    '  Push $8',
    '  Push $R1',
    '  Push $R2',
    `  IfErrors ${prefix}_had_error ${prefix}_no_error`,
    `  ${prefix}_had_error:`,
    '    StrCpy $8 1',
    `    Goto ${prefix}_begin`,
    `  ${prefix}_no_error:`,
    '    StrCpy $8 0',
    `  ${prefix}_begin:`,
    '    StrCpy $1 0',
    '    ClearErrors',
  ]
  const paths = [{ path: '', directory: true }, ...entries]
  paths.forEach((entry, index) => {
    const suffix = entry.path ? `\\${nsisLiteral(entry.path)}` : ''
    lines.push(
      `    StrCpy $2 "$0${suffix}"`,
      "    System::Call 'kernel32::GetFileAttributesW(w r2) i.r3 ?re'",
      '    Pop $R1',
      '    Pop $R2',
      `    StrCmp $R2 "ok" 0 ${prefix}_failed`,
      `    StrCmp $3 -1 ${prefix}_missing_${index}`,
      '    IntOp $3 $3 & 0x410',
      `    IntCmp $3 ${entry.directory ? '0x10' : '0'} ${prefix}_next_${index} ${prefix}_failed ${prefix}_failed`,
      `  ${prefix}_missing_${index}:`,
      ...(index === 0
        ? [`    Goto ${prefix}_failed`]
        : [`    StrCmp $R1 2 ${prefix}_next_${index}`, `    StrCmp $R1 3 0 ${prefix}_failed`]),
      `  ${prefix}_next_${index}:`,
    )
  })
  lines.push(
    '    StrCpy $1 1',
    `  ${prefix}_failed:`,
    '    StrCpy $0 $1',
    `    StrCmp $8 1 ${prefix}_restore_error`,
    '    ClearErrors',
    `    Goto ${prefix}_restore_registers`,
    `  ${prefix}_restore_error:`,
    '    SetErrors',
    `  ${prefix}_restore_registers:`,
    '    Pop $R2',
    '    Pop $R1',
    '    Pop $8',
    '    Pop $3',
    '    Pop $2',
    '    Pop $1',
    '    Exch $0',
    'FunctionEnd',
    '',
  )
  return lines.join('\n')
}

function renderVerifier(entries, arch, archiveSha256) {
  if (!['64', '32', 'ARM64'].includes(arch)) throw new Error('Unsupported payload architecture.')
  if (!/^[a-f0-9]{64}$/.test(archiveSha256)) throw new Error('Invalid archive digest.')
  const checked = parseArchiveListing(
    entries
      .map(
        (entry) =>
          `Path = ${entry.path}\nSize = ${entry.size}\nAttributes = ${entry.directory ? 'D' : 'A'}\n`,
      )
      .join('\n'),
  )
  assertExactTree(checked, entries)
  const prefix = `LifeVerifyPayload${arch}`
  const failure = `${prefix}_failed`
  const directories = ['', ...entries.filter((entry) => entry.directory).map((entry) => entry.path)]
  const lines = [
    '; Generated from the exact final application archive. Do not edit.',
    `; Archive SHA256: ${archiveSha256}`,
    `!macro ${prefix} DIRECTORY RESULT`,
    '  Push "${DIRECTORY}"',
    '  Push 0',
    `  Call ${prefix}`,
    '  Pop ${RESULT}',
    '!macroend',
    `!macro LifeVerifyStagedPayload${arch} DIRECTORY RESULT`,
    '  Push "${DIRECTORY}"',
    '  Push 1',
    `  Call ${prefix}`,
    '  Pop ${RESULT}',
    '!macroend',
    `Function ${prefix}`,
    '  Exch $9',
    '  Exch',
    '  Exch $0',
    ...Array.from({ length: 8 }, (_, i) => `  Push $${i + 1}`),
    '  Push $R0',
    '  Push $R1',
    '  Push $R2',
    `  IfErrors ${prefix}_had_error ${prefix}_no_error`,
    `  ${prefix}_had_error:`,
    '    StrCpy $8 1',
    `    Goto ${prefix}_begin`,
    `  ${prefix}_no_error:`,
    '    StrCpy $8 0',
    `  ${prefix}_begin:`,
    '    StrCpy $1 0',
    '    StrCpy $R0 0',
    '    StrCpy $5 -1',
    '    ClearErrors',
    '    StrLen $7 $0',
    `    IntCmp $7 250 0 0 ${failure}`,
    `    StrCmp $9 1 0 ${prefix}_allocated`,
    '    System::Alloc 592',
    '    Pop $R0',
    `    StrCmp $R0 0 ${failure}`,
    `  ${prefix}_allocated:`,
  ]
  directories.forEach((directory, index) => {
    const suffix = directory ? `\\${nsisLiteral(directory)}` : ''
    const count = entries.filter(
      (entry) => path.posix.dirname(entry.path) === (directory || '.'),
    ).length
    const loop = `${prefix}_dir_${index}`
    lines.push(
      `    StrCpy $2 "$0${suffix}"`,
      "    System::Call 'kernel32::GetFileAttributesW(w r2) i.r3 ?re'",
      '    Pop $R1',
      '    Pop $R2',
      `    StrCmp $R2 "ok" 0 ${failure}`,
      `    IntCmp $3 -1 ${failure}`,
      '    IntOp $3 $3 & 0x410',
      `    IntCmp $3 0x10 0 ${failure} ${failure}`,
      `    StrCmp $9 1 0 ${loop}_done`,
      '    StrCpy $4 0',
      `    StrCpy $2 "$0${suffix}\\*"`,
      "    System::Call 'kernel32::FindFirstFileW(w r2, p R0) p.r5 ?re'",
      '    Pop $R1',
      '    Pop $R2',
      `    StrCmp $R2 "ok" 0 ${failure}`,
      `    StrCmp $5 -1 ${loop}_empty`,
      `    ${loop}:`,
      '      IntOp $7 $R0 + 44',
      "      System::Call '*$7(&w260 .r6)'",
      `      StrCmp $6 "." ${loop}_next`,
      `      StrCmp $6 ".." ${loop}_next`,
      '      IntOp $4 $4 + 1',
      `      IntCmp $4 ${count} 0 0 ${failure}`,
      `    ${loop}_next:`,
      "      System::Call 'kernel32::FindNextFileW(p r5, p R0) i.r3 ?re'",
      '      Pop $R1',
      '      Pop $R2',
      `      StrCmp $R2 "ok" 0 ${failure}`,
      `      StrCmp $3 0 ${loop}_end ${loop}`,
      `    ${loop}_end:`,
      `      StrCmp $R1 18 0 ${failure}`,
      "      System::Call 'kernel32::FindClose(p r5) i.r3 ?re'",
      '      Pop $R1',
      '      Pop $R2',
      `      StrCmp $R2 "ok" 0 ${failure}`,
      `      StrCmp $3 0 ${failure}`,
      '      StrCpy $5 -1',
      `      Goto ${loop}_count`,
      `    ${loop}_empty:`,
      `      StrCmp $R1 2 0 ${failure}`,
      `    ${loop}_count:`,
      `      IntCmp $4 ${count} 0 ${failure} ${failure}`,
      `    ${loop}_done:`,
    )
  })
  for (const entry of entries.filter((entry) => !entry.directory)) {
    if (!/^[a-f0-9]{64}$/.test(entry.sha256)) throw new Error('Invalid payload file digest.')
    const relative = nsisLiteral(entry.path)
    lines.push(
      `    StrCpy $2 "$0\\${relative}"`,
      "    System::Call 'kernel32::GetFileAttributesW(w r2) i.r3 ?re'",
      '    Pop $R1',
      '    Pop $R2',
      `    StrCmp $R2 "ok" 0 ${failure}`,
      `    IntCmp $3 -1 ${failure}`,
      '    IntOp $3 $3 & 0x410',
      `    IntCmp $3 0 0 ${failure} ${failure}`,
      '    Push "SHA2-256"',
      `    Push "$0\\${relative}"`,
      '    StdUtils::HashFile /NOUNLOAD',
      '    Pop $3',
      `    StrCmp $3 "${entry.sha256}" 0 ${failure}`,
    )
  }
  lines.push(
    '    StrCpy $1 1',
    `  ${failure}:`,
    `    StrCmp $5 -1 ${prefix}_free`,
    "    System::Call 'kernel32::FindClose(p r5) i.r3 ?re'",
    '    Pop $R1',
    '    Pop $R2',
    '    StrCpy $1 0',
    `  ${prefix}_free:`,
    `    StrCmp $R0 0 ${prefix}_result`,
    '    System::Free $R0',
    `  ${prefix}_result:`,
    '    StrCpy $0 $1',
    `    StrCmp $8 1 ${prefix}_restore_error`,
    '    ClearErrors',
    `    Goto ${prefix}_restore_registers`,
    `  ${prefix}_restore_error:`,
    '    SetErrors',
    `  ${prefix}_restore_registers:`,
    '    Pop $R2',
    '    Pop $R1',
    '    Pop $R0',
    ...Array.from({ length: 8 }, (_, i) => `    Pop $${8 - i}`),
    '    Exch $0',
    '    Exch',
    '    Pop $9',
    'FunctionEnd',
    '',
  )
  return lines.join('\n') + renderPreflight(entries, arch)
}

async function writeSnapshot(archive, arch, archiveSha256, entries, directory) {
  await fs.mkdir(directory, { recursive: true })
  const filename = `app-${arch}.7z`
  const destination = path.join(directory, filename)
  if (path.resolve(archive) === path.resolve(destination))
    throw new Error('Diagnostic snapshot must not replace its input archive.')
  const temporaryArchive = `${destination}.${process.pid}.tmp`
  const metadataFile = path.join(directory, `app-${arch}.json`)
  const temporaryMetadata = `${metadataFile}.${process.pid}.tmp`
  try {
    await fs.copyFile(archive, temporaryArchive)
    if ((await hashFile(temporaryArchive)) !== archiveSha256)
      throw new Error('Diagnostic snapshot differs from the trusted archive.')
    const metadata = {
      format: 1,
      arch,
      archiveSha256,
      archiveSize: (await fs.stat(temporaryArchive)).size,
      entries,
    }
    await fs.writeFile(temporaryMetadata, JSON.stringify(metadata), 'utf8')
    await fs.rename(temporaryArchive, destination)
    await fs.rename(temporaryMetadata, metadataFile)
  } finally {
    await fs.rm(temporaryArchive, { force: true })
    await fs.rm(temporaryMetadata, { force: true })
  }
}

async function generate({ archive, arch, output }) {
  if (!['64', '32', 'ARM64'].includes(arch)) throw new Error('Unsupported payload architecture.')
  if (path.resolve(archive) === path.resolve(output))
    throw new Error('Output must not replace the archive.')
  const { getPath7za } = require('app-builder-lib/out/toolsets/7zip.js')
  const sevenZip = await getPath7za()
  const archiveSha256 = await hashFile(archive)
  const listing = await execFile(sevenZip, ['l', '-slt', '-ba', '-sccUTF-8', archive], {
    maxBuffer: 16 * 1024 * 1024,
  })
  const entries = parseArchiveListing(listing.stdout)
  const stage = await fs.mkdtemp(path.join(tmpdir(), 'life-installer-manifest-'))
  try {
    await execFile(sevenZip, ['x', '-y', '-sccUTF-8', `-o${stage}`, archive], {
      maxBuffer: 1024 * 1024,
    })
    const payload = await collectTree(stage)
    assertExactTree(entries, payload)
    if ((await hashFile(archive)) !== archiveSha256)
      throw new Error('Archive changed while building its manifest.')
    if (process.env.LIFE_NSIS_PAYLOAD_SNAPSHOT_DIR) {
      await writeSnapshot(
        archive,
        arch,
        archiveSha256,
        payload,
        process.env.LIFE_NSIS_PAYLOAD_SNAPSHOT_DIR,
      )
    }
    const temporaryOutput = `${output}.${process.pid}.tmp`
    await fs.writeFile(temporaryOutput, renderVerifier(payload, arch, archiveSha256), {
      encoding: 'utf8',
      flag: 'wx',
    })
    try {
      await fs.rename(temporaryOutput, output)
    } finally {
      await fs.rm(temporaryOutput, { force: true })
    }
    return { archiveSha256, arch, files: payload.filter((entry) => !entry.directory).length }
  } finally {
    await fs.rm(stage, { recursive: true, force: true })
  }
}

module.exports = {
  safeArchivePath,
  parseArchiveListing,
  collectTree,
  assertExactTree,
  renderVerifier,
  writeSnapshot,
  generate,
}
if (require.main === module) {
  const options = {}
  for (let i = 2; i < process.argv.length; i += 2) {
    const flag = process.argv[i]
    if (!['--archive', '--arch', '--output'].includes(flag) || !process.argv[i + 1])
      throw new Error('Expected --archive FILE --arch 64|32|ARM64 --output FILE.')
    const key = flag.slice(2)
    if (options[key]) throw new Error('Duplicate manifest option.')
    options[key] = process.argv[i + 1]
  }
  if (!options.archive || !options.arch || !options.output)
    throw new Error('Expected --archive FILE --arch 64|32|ARM64 --output FILE.')
  generate(options)
    .then((result) => console.log(JSON.stringify(result)))
    .catch((error) => {
      console.error(error.message)
      process.exitCode = 1
    })
}
