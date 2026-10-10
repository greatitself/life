'use strict'

// Builds the launcher only. Native NSIS invocation and containment are separate
// Windows fixtures; PE inspection is not execution evidence.
const assert = require('node:assert/strict')
const fs = require('node:fs/promises')
const { createReadStream } = require('node:fs')
const { createHash } = require('node:crypto')
const path = require('node:path')
const { promisify } = require('node:util')
const execFile = promisify(require('node:child_process').execFile)

const root = path.resolve(__dirname, '..')
const sourceDirectory = path.join(root, 'build', 'modern-extractor')
const dllName = 'LifeInstallerLauncher.dll'
const metadataName = 'launcher-metadata.json'

function parseArguments(argv) {
  const options = { fixture: false, help: false }
  const seen = new Set()
  for (let index = 0; index < argv.length; index++) {
    const argument = argv[index]
    assert(!seen.has(argument), `Duplicate argument: ${argument}`)
    seen.add(argument)
    if (argument === '--fixture') options.fixture = true
    else if (argument === '--help') options.help = true
    else if (argument === '--output-directory') {
      const value = argv[++index]
      assert(value && !value.startsWith('--'), '--output-directory requires a directory')
      assert(!/[\0\r\n]/u.test(value), 'Invalid output directory')
      options.outputDirectory = path.resolve(value)
    } else throw new Error(`Unknown argument: ${argument}`)
  }
  assert(options.help || options.outputDirectory, 'Expected --output-directory DIRECTORY')
  return options
}

async function hashFile(filename) {
  const hash = createHash('sha256')
  for await (const chunk of createReadStream(filename)) hash.update(chunk)
  return hash.digest('hex')
}

function normalizedEnvironment(environment) {
  const result = {}
  for (const [name, value] of Object.entries(environment)) {
    if (typeof value === 'string') result[name.toUpperCase()] = value
  }
  return result
}

function compilerEnvironment(environment) {
  const result = normalizedEnvironment(environment)
  for (const name of ['CL', '_CL_', 'LINK', '_LINK_']) delete result[name]
  return result
}

async function findOnPath(filename, environment) {
  for (let directory of (environment.PATH || '').split(path.delimiter)) {
    directory = directory.replace(/^"|"$/gu, '')
    if (!directory) continue
    const candidate = path.resolve(directory, filename)
    try {
      if ((await fs.stat(candidate)).isFile()) return candidate
    } catch (error) {
      if (error.code !== 'ENOENT' && error.code !== 'ENOTDIR') throw error
    }
  }
  return undefined
}

async function captureCompilerVersion(compiler, environment) {
  try {
    const result = await execFile(compiler, ['/Bv'], { env: environment, maxBuffer: 1024 * 1024 })
    return result.stdout + result.stderr
  } catch (error) {
    // /Bv with no source also reports D8003. Preserve the banner, not an
    // execution claim, and let the real compile establish tool suitability.
    if (typeof error.stdout !== 'string' || typeof error.stderr !== 'string') throw error
    const report = error.stdout + error.stderr
    assert(/Microsoft[\s\S]*Compiler Version/iu.test(report), 'Unable to identify MSVC compiler')
    return report
  }
}

async function discoverCompiler() {
  let environment = compilerEnvironment(process.env)
  const current = await findOnPath('cl.exe', environment)
  const target = (environment.VSCMD_ARG_TGT_ARCH || '').toLowerCase()
  if (current && target === 'x86' && environment.INCLUDE && environment.LIB) {
    return {
      compiler: current,
      environment,
      discovery: 'Current initialized MSVC x86 developer environment',
      version: await captureCompilerVersion(current, environment),
    }
  }

  const candidates = [environment['PROGRAMFILES(X86)'], environment.PROGRAMFILES]
    .filter(Boolean)
    .map((directory) => path.join(directory, 'Microsoft Visual Studio', 'Installer', 'vswhere.exe'))
  let vswhere
  for (const candidate of candidates) {
    try {
      if ((await fs.stat(candidate)).isFile()) {
        vswhere = candidate
        break
      }
    } catch (error) {
      if (error.code !== 'ENOENT' && error.code !== 'ENOTDIR') throw error
    }
  }
  assert(vswhere, 'MSVC x86 developer environment or Visual Studio vswhere.exe is required')
  const discovery = await execFile(
    vswhere,
    [
      '-latest',
      '-products',
      '*',
      '-requires',
      'Microsoft.VisualStudio.Component.VC.Tools.x86.x64',
      '-format',
      'json',
      '-utf8',
    ],
    { env: environment, maxBuffer: 1024 * 1024 },
  )
  const installations = JSON.parse(discovery.stdout.replace(/^\uFEFF/u, ''))
  assert(
    Array.isArray(installations) && installations.length === 1,
    'Expected one latest Visual Studio installation with C++ x86/x64 tools',
  )
  const installation = installations[0].installationPath
  assert(
    typeof installation === 'string' && path.isAbsolute(installation),
    'Invalid Visual Studio path',
  )
  const vcvars = path.join(installation, 'VC', 'Auxiliary', 'Build', 'vcvarsall.bat')
  await fs.access(vcvars)
  // Only this known bootstrap path enters cmd. Arbitrary build/source/output
  // paths are passed directly to cl.exe afterward. CALL expands percent/caret
  // syntax a second time, so reject those characters rather than reinterpret it.
  assert(!/[\0\r\n"%^!]/u.test(vcvars), 'Unsupported characters in Visual Studio bootstrap path')
  const architecture = process.arch === 'x64' ? 'x64_x86' : 'x86'
  const command = `call "${vcvars}" ${architecture} >nul && set`
  const commandProcessor =
    environment.COMSPEC || path.join(environment.SYSTEMROOT || 'C:\\Windows', 'System32', 'cmd.exe')
  const captured = await execFile(commandProcessor, ['/d', '/s', '/u', '/v:off', '/c', command], {
    env: environment,
    encoding: 'buffer',
    windowsVerbatimArguments: true,
    maxBuffer: 4 * 1024 * 1024,
  })
  // Never print or persist the environment; it may contain credentials.
  const initialized = {}
  for (const line of captured.stdout.toString('utf16le').split(/\r?\n/u)) {
    const equal = line.indexOf('=')
    if (equal > 0) initialized[line.slice(0, equal)] = line.slice(equal + 1)
  }
  environment = compilerEnvironment(initialized)
  assert(
    (environment.VSCMD_ARG_TGT_ARCH || '').toLowerCase() === 'x86',
    'Visual Studio did not initialize an x86 target environment',
  )
  assert(environment.INCLUDE && environment.LIB, 'MSVC SDK include/library environment is missing')
  const compiler = await findOnPath('cl.exe', environment)
  assert(compiler, 'Initialized Visual Studio environment did not provide cl.exe')
  return {
    compiler,
    environment,
    discovery: `Visual Studio vcvarsall ${architecture}`,
    installationPath: installation,
    version: await captureCompilerVersion(compiler, environment),
  }
}

function inspectPe(buffer, expectedExports) {
  function span(offset, bytes, label) {
    assert(
      Number.isSafeInteger(offset) &&
        Number.isSafeInteger(bytes) &&
        offset >= 0 &&
        bytes >= 0 &&
        offset <= buffer.length &&
        bytes <= buffer.length - offset,
      `Truncated PE ${label}`,
    )
  }
  span(0, 64, 'DOS header')
  assert.equal(buffer.readUInt16LE(0), 0x5a4d, 'Expected MZ executable')
  const nt = buffer.readUInt32LE(60)
  span(nt, 24, 'COFF header')
  assert.equal(buffer.readUInt32LE(nt), 0x4550, 'Expected PE signature')
  assert.equal(buffer.readUInt16LE(nt + 4), 0x14c, 'Launcher must target x86 I386')
  const count = buffer.readUInt16LE(nt + 6)
  assert(count > 0 && count <= 96, 'Invalid PE section count')
  const characteristics = buffer.readUInt16LE(nt + 22)
  assert((characteristics & 0x2002) === 0x2002, 'Expected executable DLL')
  assert(!(characteristics & 1), 'ASLR relocations must not be stripped')
  const optionalBytes = buffer.readUInt16LE(nt + 20)
  assert(optionalBytes >= 224, 'Missing PE32 optional header')
  const optional = nt + 24
  span(optional, optionalBytes, 'optional header')
  assert.equal(buffer.readUInt16LE(optional), 0x10b, 'Expected PE32, not PE32+')
  const imageBase = buffer.readUInt32LE(optional + 28)
  const imageBytes = buffer.readUInt32LE(optional + 56)
  const headerBytes = buffer.readUInt32LE(optional + 60)
  assert(imageBytes > 0 && headerBytes > 0 && headerBytes <= imageBytes, 'Invalid PE image size')
  const dllCharacteristics = buffer.readUInt16LE(optional + 70)
  assert((dllCharacteristics & 0x4140) === 0x4140, 'DLL must enable NX, ASLR, and CFG')
  const directories = buffer.readUInt32LE(optional + 92)
  assert(directories >= 14 && 96 + directories * 8 <= optionalBytes, 'Invalid PE directory count')
  span(0, headerBytes, 'headers')
  const sections = []
  const sectionTable = optional + optionalBytes
  span(sectionTable, count * 40, 'section table')
  assert(sectionTable + count * 40 <= headerBytes, 'Section table exceeds PE headers')
  for (let index = 0; index < count; index++) {
    const entry = sectionTable + index * 40
    const section = {
      rva: buffer.readUInt32LE(entry + 12),
      virtualBytes: buffer.readUInt32LE(entry + 8),
      bytes: buffer.readUInt32LE(entry + 16),
      offset: buffer.readUInt32LE(entry + 20),
      flags: buffer.readUInt32LE(entry + 36),
    }
    if (section.bytes) {
      assert(section.offset >= headerBytes, 'PE raw section overlaps headers')
      span(section.offset, section.bytes, 'section data')
    }
    assert(section.rva >= headerBytes, 'Section overlaps PE headers')
    const extent = Math.max(section.bytes, section.virtualBytes)
    assert(section.rva + extent <= imageBytes, 'PE section exceeds image size')
    for (const previous of sections) {
      assert(
        section.rva + extent <= previous.rva ||
          previous.rva + Math.max(previous.bytes, previous.virtualBytes) <= section.rva,
        'Overlapping PE RVA sections',
      )
      if (section.bytes && previous.bytes)
        assert(
          section.offset + section.bytes <= previous.offset ||
            previous.offset + previous.bytes <= section.offset,
          'Overlapping PE raw sections',
        )
    }
    sections.push(section)
  }
  function mapped(rva, bytes = 1) {
    assert(Number.isSafeInteger(rva) && rva > 0 && rva + bytes <= 0x100000000, 'Invalid PE RVA')
    if (rva < headerBytes && bytes <= headerBytes - rva)
      return { offset: rva, end: headerBytes, flags: 0 }
    const section = sections.find(
      (item) =>
        rva >= item.rva && rva - item.rva <= item.bytes && bytes <= item.bytes - (rva - item.rva),
    )
    assert(section, 'PE RVA does not have complete raw-backed data')
    return {
      offset: section.offset + rva - section.rva,
      end: section.offset + section.bytes,
      flags: section.flags,
    }
  }
  function textAt(rva) {
    const location = mapped(rva)
    let end = location.offset
    while (end < location.end && buffer[end] !== 0) {
      assert(buffer[end] >= 0x20 && buffer[end] < 0x7f, 'Non-ASCII PE symbol/module name')
      end++
    }
    assert(end < location.end && end > location.offset, 'Unterminated/empty PE name')
    return buffer.toString('ascii', location.offset, end)
  }
  function directory(index) {
    const rva = buffer.readUInt32LE(optional + 96 + index * 8)
    const bytes = buffer.readUInt32LE(optional + 100 + index * 8)
    assert((rva === 0) === (bytes === 0), 'Incomplete PE directory')
    return { rva, bytes }
  }
  const exportDirectory = directory(0)
  assert(exportDirectory.bytes >= 40, 'Missing PE export directory')
  const exportsOffset = mapped(exportDirectory.rva, exportDirectory.bytes).offset
  const functions = buffer.readUInt32LE(exportsOffset + 20)
  const names = buffer.readUInt32LE(exportsOffset + 24)
  assert.equal(names, expectedExports.length, 'Unexpected named plugin exports')
  assert(functions >= names && functions <= 64, 'Unexpected plugin export ordinal table')
  const functionTable = mapped(buffer.readUInt32LE(exportsOffset + 28), functions * 4).offset
  const nameTable = mapped(buffer.readUInt32LE(exportsOffset + 32), names * 4).offset
  const ordinalTable = mapped(buffer.readUInt32LE(exportsOffset + 36), names * 2).offset
  const exports = []
  const namedOrdinals = new Set()
  for (let index = 0; index < names; index++) {
    const name = textAt(buffer.readUInt32LE(nameTable + index * 4))
    assert(
      index === 0 || exports[index - 1] < name,
      'PE export names must be strictly sorted ASCII',
    )
    const ordinal = buffer.readUInt16LE(ordinalTable + index * 2)
    assert(
      ordinal < functions && !namedOrdinals.has(ordinal),
      'Invalid/duplicate plugin export ordinal',
    )
    namedOrdinals.add(ordinal)
    const address = buffer.readUInt32LE(functionTable + ordinal * 4)
    assert(
      address &&
        !(address >= exportDirectory.rva && address < exportDirectory.rva + exportDirectory.bytes),
      'Missing/forwarded plugin export',
    )
    assert(mapped(address).flags & 0x20000000, 'Plugin export must point into executable code')
    exports.push(name)
  }
  for (let index = 0; index < functions; index++)
    assert(
      namedOrdinals.has(index) || buffer.readUInt32LE(functionTable + index * 4) === 0,
      'Unexpected ordinal-only plugin export',
    )
  assert.deepEqual(
    exports.slice().sort(),
    expectedExports.slice().sort(),
    'Plugin export names differ from approved ABI',
  )

  const delayImports = directory(13)
  assert.equal(delayImports.rva, 0, 'Launcher must not use delay-loaded imports')
  const importDirectory = directory(1)
  assert(importDirectory.bytes >= 20, 'Missing Windows API imports')
  const importOffset = mapped(importDirectory.rva, importDirectory.bytes).offset
  const imports = []
  let terminated = false
  for (let offset = 0; offset + 20 <= importDirectory.bytes; offset += 20) {
    const fields = Array.from({ length: 5 }, (_, index) =>
      buffer.readUInt32LE(importOffset + offset + index * 4),
    )
    if (fields.every((value) => value === 0)) {
      terminated = true
      break
    }
    const name = textAt(fields[3])
    assert(!/[\\/:]/u.test(name), 'PE import module must be a basename')
    assert(
      !/^(?:(?:api|ext)-ms-win-crt-|ucrt|vcruntime|vccorlib|msvcp|msvcr|concrt|vcomp)/iu.test(name),
      `Static /MT launcher unexpectedly imports a dynamic CRT: ${name}`,
    )
    assert(
      !imports.some((previous) => previous.toLowerCase() === name.toLowerCase()),
      'Duplicate PE import module',
    )
    imports.push(name)
  }
  assert(terminated, 'Unterminated PE import descriptors')
  const relocations = directory(5)
  assert(relocations.bytes >= 8, 'Missing ASLR base relocations')
  mapped(relocations.rva, relocations.bytes)
  const loadConfig = directory(10)
  const reportedConfigurationBytes = loadConfig.rva
    ? buffer.readUInt32LE(mapped(loadConfig.rva, 4).offset)
    : 0
  assert(
    loadConfig.bytes === 64 || loadConfig.bytes >= 92,
    `Missing CFG load configuration (directory RVA 0x${loadConfig.rva.toString(16)}, directory bytes ${loadConfig.bytes}, structure bytes ${reportedConfigurationBytes})`,
  )
  const configurationBytes = reportedConfigurationBytes
  assert(configurationBytes >= 92, 'Invalid CFG load configuration size')
  assert(
    loadConfig.bytes === 64 || configurationBytes <= loadConfig.bytes,
    'CFG load configuration exceeds its advertised directory',
  )
  // The x86 directory size can remain the legacy 64-byte version marker even
  // when the internal Size covers the modern CFG fields. Validate all actual
  // bytes instead of treating the version marker as the structure boundary.
  // https://learn.microsoft.com/en-us/windows/win32/debug/pe-format#load-configuration-directory
  const configuration = mapped(
    loadConfig.rva,
    Math.max(loadConfig.bytes, configurationBytes),
  ).offset
  const guardFlags = buffer.readUInt32LE(configuration + 88)
  assert(
    (guardFlags & 0x500) === 0x500,
    'Compiler did not emit CFG instrumentation and a function table',
  )
  const guardTable = buffer.readUInt32LE(configuration + 80)
  const guardCount = buffer.readUInt32LE(configuration + 84)
  // This module exports callable launcher functions; require a real target
  // table before reporting its complete CFG build gate as satisfied.
  assert(guardCount > 0 && guardTable >= imageBase, 'Missing CFG function targets')
  const stride = 4 + (guardFlags >>> 28)
  const table = mapped(guardTable - imageBase, guardCount * stride).offset
  let previousTarget = -1
  for (let index = 0; index < guardCount; index++) {
    const target = buffer.readUInt32LE(table + index * stride)
    assert(target > previousTarget, 'CFG targets must be strictly sorted and unique')
    assert(mapped(target).flags & 0x20000000, 'CFG target must point into executable code')
    previousTarget = target
  }
  return {
    machine: '0x014c',
    format: 'PE32',
    dll: true,
    exports: exports.sort(),
    imports: imports.sort(),
    delayImports: [],
    nxCompatible: true,
    dynamicBase: true,
    relocations: true,
    controlFlowGuard: true,
    guardFlags: `0x${guardFlags.toString(16)}`,
    guardFunctionCount: guardCount,
  }
}

async function sourceIdentities() {
  const names = (await fs.readdir(sourceDirectory))
    .filter((name) => /\.(?:cpp|h|hpp|def)$/iu.test(name))
    .sort()
  for (const required of ['launcher.cpp', 'nsis-plugin-api.h', 'launcher.def']) {
    assert(names.includes(required), `Missing required launcher input: ${required}`)
  }
  const records = []
  for (const name of names) {
    const filename = path.join(sourceDirectory, name)
    const stat = await fs.lstat(filename)
    assert(stat.isFile() && !stat.isSymbolicLink(), `Expected regular launcher input: ${name}`)
    records.push({
      path: path.relative(root, filename).split(path.sep).join('/'),
      bytes: stat.size,
      sha256: await hashFile(filename),
    })
  }
  records.push({
    path: 'scripts/build-modern-extractor.cjs',
    bytes: (await fs.stat(__filename)).size,
    sha256: await hashFile(__filename),
  })
  const verifier = path.join(root, 'scripts', 'verify-modern-extractor-source.cjs')
  try {
    const stat = await fs.lstat(verifier)
    assert(stat.isFile() && !stat.isSymbolicLink(), 'Expected regular launcher source verifier')
    records.push({
      path: 'scripts/verify-modern-extractor-source.cjs',
      bytes: stat.size,
      sha256: await hashFile(verifier),
    })
  } catch (error) {
    if (error.code !== 'ENOENT') throw error
  }
  return records
}

async function main(argv = process.argv.slice(2)) {
  const options = parseArguments(argv)
  if (options.help) {
    console.log(
      'Usage: node scripts/build-modern-extractor.cjs --output-directory DIRECTORY [--fixture]',
    )
    console.log(
      'Requires Windows and MSVC C++ x86 tools. Builds and checks PE metadata; does not run native fixtures.',
    )
    return
  }
  assert.equal(
    process.platform,
    'win32',
    'Build requires real Windows MSVC; no Windows execution is claimed on other hosts',
  )
  const sources = await sourceIdentities()
  const toolchain = await discoverCompiler()
  await fs.mkdir(options.outputDirectory, { recursive: true })
  const stage = await fs.mkdtemp(path.join(options.outputDirectory, '.launcher-build-'))
  const binary = path.join(stage, dllName)
  let definition = path.join(sourceDirectory, 'launcher.def')
  if (options.fixture) {
    definition = path.join(stage, 'fixture.def')
    await fs.writeFile(
      definition,
      'LIBRARY LifeInstallerLauncher\nEXPORTS\n  Launch=_Launch\n  LaunchFixture=_LaunchFixture\n',
    )
  }
  const compilerFlags = [
    '/nologo',
    '/W4',
    '/WX',
    '/O2',
    '/std:c++17',
    '/MT',
    '/EHsc',
    '/utf-8',
    '/guard:cf',
    '/DUNICODE',
    '/D_UNICODE',
    '/D_WIN32_WINNT=0x0A00',
    '/DWINVER=0x0A00',
    '/DWIN32_LEAN_AND_MEAN',
    '/DNOMINMAX',
  ]
  if (options.fixture) compilerFlags.push('/DLIFE_LAUNCHER_FIXTURE_ONLY=1')
  const linkerFlags = [
    '/MACHINE:X86',
    '/NXCOMPAT',
    '/DYNAMICBASE',
    '/GUARD:CF',
    '/WX',
    `/DEF:${definition}`,
    `/OUT:${binary}`,
    `/IMPLIB:${path.join(stage, 'LifeInstallerLauncher.lib')}`,
  ]
  const argumentsToCompiler = [
    ...compilerFlags,
    '/LD',
    `/Fo${path.join(stage, 'launcher.obj')}`,
    path.join(sourceDirectory, 'launcher.cpp'),
    '/link',
    ...linkerFlags,
  ]
  console.log(
    `Building ${options.fixture ? 'fixture-only' : 'production'} Unicode x86 launcher using ${toolchain.compiler}`,
  )
  let compilation
  try {
    compilation = await execFile(toolchain.compiler, argumentsToCompiler, {
      cwd: stage,
      env: toolchain.environment,
      maxBuffer: 16 * 1024 * 1024,
    })
  } catch (error) {
    const output = (error.stdout || '') + (error.stderr || '')
    await fs.writeFile(path.join(stage, 'compile-output.txt'), output)
    if (output) process.stdout.write(output)
    throw new Error(`MSVC launcher build failed; diagnostics retained in ${stage}`, {
      cause: error,
    })
  }
  const buildLog = compilation.stdout + compilation.stderr
  await fs.writeFile(path.join(stage, 'compile-output.txt'), buildLog)
  if (buildLog) process.stdout.write(buildLog)
  const buffer = await fs.readFile(binary)
  const expectedExports = options.fixture ? ['Launch', 'LaunchFixture'] : ['Launch']
  let pe
  try {
    pe = inspectPe(buffer, expectedExports)
  } catch (error) {
    // A failed DLL is not published as an approved plugin. Keep compiler and
    // actual PE evidence together so a Windows failure can be diagnosed before
    // changing build flags or verifier requirements.
    let diagnostics = `\nPE verification failed: ${error.message}\n`
    const dumpbin = await findOnPath('dumpbin.exe', toolchain.environment)
    if (dumpbin) {
      try {
        const report = await execFile(dumpbin, ['/headers', '/loadconfig', binary], {
          cwd: stage,
          env: toolchain.environment,
          maxBuffer: 16 * 1024 * 1024,
        })
        diagnostics += report.stdout + report.stderr
      } catch (diagnosticError) {
        diagnostics += `dumpbin diagnostics failed: ${diagnosticError.message}\n`
      }
    } else diagnostics += 'dumpbin.exe was not found in the initialized MSVC environment.\n'
    await fs.appendFile(path.join(stage, 'compile-output.txt'), diagnostics)
    process.stdout.write(diagnostics)
    throw error
  }
  assert.deepEqual(
    await sourceIdentities(),
    sources,
    'Launcher source inputs changed during the build',
  )
  const metadata = {
    schemaVersion: 1,
    generatedAt: new Date().toISOString(),
    fixtureOnly: options.fixture,
    nativeExecutionVerified: false,
    toolchain: {
      platform: process.platform,
      compiler: toolchain.compiler,
      compilerSha256: await hashFile(toolchain.compiler),
      discovery: toolchain.discovery,
      installationPath: toolchain.installationPath,
      version: toolchain.version.trim(),
      sdkVersion: toolchain.environment.WINDOWSSDKVERSION,
      compilerFlags,
      linkerFlags,
    },
    sources,
    definition: {
      source: options.fixture ? 'generated fixture.def' : 'build/modern-extractor/launcher.def',
      sha256: await hashFile(definition),
    },
    binary: {
      filename: dllName,
      bytes: buffer.length,
      sha256: createHash('sha256').update(buffer).digest('hex'),
      ...pe,
    },
    validation:
      'PE and build identity only; native NSIS ABI and child containment require the separate Windows fixtures.',
  }
  const stagedMetadata = path.join(stage, metadataName)
  await fs.writeFile(stagedMetadata, JSON.stringify(metadata, null, 2) + '\n')
  await fs.rename(binary, path.join(options.outputDirectory, dllName))
  await fs.rename(stagedMetadata, path.join(options.outputDirectory, metadataName))
  await fs.copyFile(
    path.join(stage, 'compile-output.txt'),
    path.join(options.outputDirectory, 'launcher-compile-output.txt'),
  )
  await fs.rm(stage, { recursive: true, force: true })
  console.log(`Verified x86 PE launcher: ${path.join(options.outputDirectory, dllName)}`)
  console.log('Native Windows NSIS execution and containment checks remain separate.')
}

module.exports = { parseArguments, inspectPe, normalizedEnvironment, compilerEnvironment }
if (require.main === module)
  main().catch((error) => {
    console.error(error.message)
    process.exitCode = 1
  })
