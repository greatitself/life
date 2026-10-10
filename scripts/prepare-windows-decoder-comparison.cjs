'use strict'

// Diagnostic only. Build decoder fixtures without reading the application payload.
const assert = require('node:assert/strict')
const fs = require('node:fs/promises')
const { createReadStream } = require('node:fs')
const { createHash } = require('node:crypto')
const path = require('node:path')
const { promisify } = require('node:util')
const execFile = promisify(require('node:child_process').execFile)

const args = Object.fromEntries(
  process.argv.slice(2).reduce((items, value, index, all) => {
    if (index % 2 === 0) items.push([value.replace(/^--/, ''), all[index + 1]])
    return items
  }, []),
)
const root = path.resolve(args.root || process.cwd())
if (!args.output) throw new Error('Expected --output DIRECTORY for the diagnostic artifact bundle.')
const output = path.resolve(args.output)
const modernOverride = args.modern ? path.resolve(args.modern) : undefined
const expectedModernSha256 = '15d4c788c148e3677e2fc1c4a01f191fb6669eba4f6acf8a465f0f1a6f1e1260'
const expectedPluginSha256 = 'b393f05e8ff919ef071181050e1873c9a776e1a0ae8329aefff7007d0cadf592'
const expectedExtraSha256 = 'dc4b11d3399db18b063630137145f5585d8f7ac847bf3639bd1185d7d1f7cee0'
const extraUrl = 'https://github.com/ip7z/7zip/releases/download/26.04/7z2604-extra.7z'
const sourceUrl = 'https://github.com/ip7z/7zip/releases/tag/26.04'
const sourceArchiveName = '7z2604-src.tar.xz'
const sourceDownloadUrl = 'https://github.com/ip7z/7zip/releases/download/26.04/7z2604-src.tar.xz'
const expectedSourceSha256 = '9691944c0fe0d01bb49373a704fb983fd33bc98b1738695179dfbf99ac1734f6'

async function hashFile(filename) {
  const hash = createHash('sha256')
  for await (const chunk of createReadStream(filename)) hash.update(chunk)
  return hash.digest('hex')
}

function nsisString(value) {
  return String(value)
    .replaceAll('$', () => '$$')
    .replaceAll('"', '$\\"')
}

function peMachine(buffer) {
  assert.equal(buffer.readUInt16LE(0), 0x5a4d, 'Expected PE executable')
  const pe = buffer.readUInt32LE(0x3c)
  assert.equal(buffer.readUInt32LE(pe), 0x00004550)
  return `0x${buffer
    .readUInt16LE(pe + 4)
    .toString(16)
    .padStart(4, '0')}`
}

async function downloadPinned(url, filename, expectedSha256) {
  const response = await fetch(url)
  if (!response.ok) throw new Error(`Diagnostic download failed (${response.status}): ${url}`)
  await fs.writeFile(filename, Buffer.from(await response.arrayBuffer()))
  assert.equal(
    await hashFile(filename),
    expectedSha256,
    'Official diagnostic archive SHA256 mismatch',
  )
}

async function main() {
  await fs.mkdir(output, { recursive: true })
  const packageJson = JSON.parse(await fs.readFile(path.join(root, 'package.json'), 'utf8'))
  const appBuilderRoot = path.join(root, 'node_modules/app-builder-lib')
  const { getPath7za } = require(path.join(appBuilderRoot, 'out/toolsets/7zip.js'))
  const { getMakeNsisPath, getNsisPluginsPath } = require(
    path.join(appBuilderRoot, 'out/toolsets/windows.js'),
  )
  const toolset = packageJson.build?.toolsets?.nsis
  const nsis = packageJson.build?.nsis || {}
  let maker = await getMakeNsisPath(toolset, nsis.customNsisBinary)
  if (process.platform === 'win32' && maker.path.toLowerCase().endsWith('.cmd')) {
    // Run the unified toolset's real compiler directly instead of invoking a shell.
    const nsisDirectory = path.join(path.dirname(maker.path), 'windows')
    const compiler = path.join(nsisDirectory, 'makensis.exe')
    await fs.access(compiler)
    maker = { path: compiler, env: { ...maker.env, NSISDIR: nsisDirectory } }
  }
  const plugins = await getNsisPluginsPath(toolset, nsis.customNsisResources)
  const plugin = path.join(plugins, 'x86-unicode/nsis7z.dll')
  const sevenZip = await getPath7za()
  const sourceArchive = path.join(output, sourceArchiveName)
  // Supply corresponding source from the same artifact as the unmodified binary.
  await downloadPinned(sourceDownloadUrl, sourceArchive, expectedSourceSha256)
  let modernExe = modernOverride
  if (!modernExe) {
    const extra = path.join(output, 'official-extra.7z')
    await downloadPinned(extraUrl, extra, expectedExtraSha256)
    const extractedExtra = path.join(output, 'official-extra')
    await execFile(
      sevenZip,
      ['x', '-t7z', '-y', '-aoa', '-bd', '-bb0', `-o${extractedExtra}`, '--', extra],
      { maxBuffer: 1024 * 1024 },
    )
    modernExe = path.join(extractedExtra, 'x64/7za.exe')
  }
  const modernSha256 = await hashFile(modernExe)
  const pluginSha256 = await hashFile(plugin)
  assert.equal(modernSha256, expectedModernSha256, 'Official native extractor hash mismatch')
  assert.equal(
    pluginSha256,
    expectedPluginSha256,
    'Resolved Nsis7z plugin differs from audited 19.00 binary',
  )
  const modernBuffer = await fs.readFile(modernExe)
  const pluginBuffer = await fs.readFile(plugin)
  assert.equal(peMachine(modernBuffer), '0x8664', 'Modern fixture must be native x64')
  assert.equal(peMachine(pluginBuffer), '0x014c', 'Stock NSIS plugin must be x86')
  const pluginDir = path.join(output, 'resolved-plugin')
  await fs.mkdir(pluginDir, { recursive: true })
  await fs.copyFile(plugin, path.join(pluginDir, 'nsis7z.dll'))
  await fs.copyFile(modernExe, path.join(output, '7za-26.04-x64.exe'))
  await fs.copyFile(
    path.join(path.dirname(modernExe), '..', 'License.txt'),
    path.join(output, '7zip-License.txt'),
  )
  const fixture = path.join(output, 'nsis7z19-fixture.exe')
  const source = path.join(output, 'nsis7z19-fixture.nsi')
  await fs.writeFile(
    source,
    String.raw`Unicode true
Name "Life decoder diagnostic only"
OutFile "${nsisString(fixture)}"
RequestExecutionLevel user
SilentInstall silent
AutoCloseWindow true
SetCompress off
!addplugindir /x86-unicode "${nsisString(pluginDir)}"
Var archivePath
Var outputPath
Var reportPath
Var reportHandle

Section
  ReadEnvStr $archivePath "LIFE_DECODER_ARCHIVE"
  ReadEnvStr $outputPath "LIFE_DECODER_OUTPUT"
  ReadEnvStr $reportPath "LIFE_DECODER_NATIVE_REPORT"
  StrCmp $archivePath "" setup_failed
  StrCmp $outputPath "" setup_failed
  StrCmp $reportPath "" setup_failed
  System::Call 'kernel32::GetFileAttributesW(w "$outputPath") i.r0'
  IntCmp $0 -1 output_absent setup_failed setup_failed
  output_absent:
    ClearErrors
    SetOutPath "$outputPath"
    IfErrors setup_failed
    ; This is the exact stock caller. The plugin does not return a status.
    Nsis7z::Extract "$archivePath"
    FileOpen $reportHandle "$reportPath" w
    IfErrors report_failed
    FileWrite $reportHandle '{$\"completed$\":true,$\"decoder$\":$\"Nsis7z::Extract 19.00$\",$\"pluginHasExitContract$\":false}$\r$\n'
    FileClose $reportHandle
    SetErrorLevel 0
    Goto completed
  setup_failed:
    SetErrorLevel 7
    Quit
  report_failed:
    SetErrorLevel 8
    Quit
  completed:
SectionEnd
`,
  )
  const compile = await execFile(maker.path, ['-WX', '-V2', source], {
    cwd: root,
    env: { ...process.env, ...maker.env },
    maxBuffer: 1024 * 1024,
  })
  await fs.writeFile(path.join(output, 'compile-output.txt'), compile.stdout + compile.stderr)
  const metadata = {
    schemaVersion: 1,
    diagnosticOnly: true,
    generatedAt: new Date().toISOString(),
    appBuilderVersion: JSON.parse(
      await fs.readFile(path.join(appBuilderRoot, 'package.json'), 'utf8'),
    ).version,
    nsisCompiler: maker.path,
    resolvedPluginPath: plugin,
    resolvedPlugin: {
      sha256: pluginSha256,
      bytes: pluginBuffer.length,
      machine: peMachine(pluginBuffer),
      version: '19.00',
    },
    fixture: {
      sha256: await hashFile(fixture),
      bytes: (await fs.stat(fixture)).size,
      machine: peMachine(await fs.readFile(fixture)),
    },
    modern: {
      sha256: modernSha256,
      bytes: modernBuffer.length,
      machine: peMachine(modernBuffer),
      version: '26.04',
      officialArchiveSha256: expectedExtraSha256,
      binaryDownload: extraUrl,
      source: sourceUrl,
      correspondingSource: {
        filename: sourceArchiveName,
        download: sourceDownloadUrl,
        sha256: expectedSourceSha256,
        bytes: (await fs.stat(sourceArchive)).size,
      },
    },
    timingScope:
      'Outer Windows process launch through completed child process exit; payload hashes and inventory verification run afterward.',
    ordering: 'Must be invoked only after the authoritative installer trial completes.',
    archiveEmbeddedInFixture: false,
    stockPluginExitStatusReliable: false,
    snapshotSource:
      'Trusted build-only snapshot from LIFE_NSIS_PAYLOAD_SNAPSHOT_DIR; consumed only after authoritative installer trial.',
  }
  await fs.writeFile(
    path.join(output, 'fixture-metadata.json'),
    JSON.stringify(metadata, null, 2) + '\n',
  )
  for (const filename of ['windows-decoder-comparison.ps1', 'windows-decoder-extract.ps1']) {
    await fs.copyFile(path.join(root, 'scripts', filename), path.join(output, filename))
  }
  for (const filename of ['7zip-LGPL-2.1.txt', 'Nsis7z-License.txt']) {
    await fs.copyFile(
      path.join(root, 'scripts/decoder-diagnostic-notices', filename),
      path.join(output, filename),
    )
  }
  await fs.writeFile(
    path.join(output, 'PROVENANCE.txt'),
    [
      'Diagnostic only; neither executable changes the Life installer.',
      `Official 7-Zip 26.04 binary/source: ${sourceUrl}`,
      `Official Extra download: ${extraUrl}`,
      `Official Extra SHA256: ${expectedExtraSha256}`,
      `Native x64 standalone 7za SHA256: ${expectedModernSha256}`,
      `Corresponding source included in this artifact: ${sourceArchiveName}`,
      `Official source download: ${sourceDownloadUrl}`,
      `Official source SHA256: ${expectedSourceSha256}`,
      'Bundled stock Nsis7z 19.00 source: https://nsis.sourceforge.io/Nsis7z_plug-in',
      'Exact matching binary/source provenance: https://github.com/electron-userland/electron-builder-binaries/blob/7b45dff2a0d8114342f4c448760ac27c556822bd/scripts/nsis-plugins.sh',
      `Resolved stock plugin SHA256: ${expectedPluginSha256}`,
      'App archive is supplied separately with its exact trusted build-generated app-64.json snapshot.',
      'Run only after the full authoritative installer trial. Do not replace its performance gate.',
    ].join('\n') + '\n',
  )
  if (!modernOverride) {
    await fs.rm(path.join(output, 'official-extra'), { recursive: true, force: true })
    await fs.rm(path.join(output, 'official-extra.7z'), { force: true })
  }
  console.log(JSON.stringify(metadata, null, 2))
}

main().catch((error) => {
  console.error(error.stack || error)
  process.exitCode = 1
})
