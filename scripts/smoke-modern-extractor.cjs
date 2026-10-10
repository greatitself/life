'use strict'

// Compiler-preflight smoke only: no npm modules, app payloads, upgrade timing,
// cancellation proof, or real NSIS register/state claim. Retain all owned evidence.
const assert = require('node:assert/strict')
const { createHash } = require('node:crypto')
const fs = require('node:fs/promises')
const path = require('node:path')
const { spawn } = require('node:child_process')
const {
  binaryName,
  sourceName,
  pins,
  downloadPinned,
  validatePinnedFile,
  validateX64Executable,
} = require('./package-windows-decoder.cjs')
const { inspectPe } = require('./build-modern-extractor.cjs')

const root = path.resolve(__dirname, '..')
const digest = (buffer) => createHash('sha256').update(buffer).digest('hex')

function nativePowerShellEnvironment(environment, config) {
  // A PS7 module path poisons WinPS5 autoloading. Remove it from this copy only.
  const result = Object.fromEntries(
    Object.entries(environment).filter(([name]) => name.toLowerCase() !== 'psmodulepath'),
  )
  result.LIFE_MODERN_SMOKE_CONFIG = config
  return result
}

function parseDiagnosticMarker(buffer) {
  assert(buffer.length > 0 && buffer.length % 2 === 0, 'Invalid UTF16 diagnostic size')
  assert.notEqual(buffer.readUInt16LE(0), 0xfeff, 'Diagnostic marker must not have a BOM')
  const fields = {}
  for (const line of buffer.toString('utf16le').split(/\r?\n/u).filter(Boolean)) {
    const match = /^([a-z0-9-]+)=(.*)$/u.exec(line)
    assert(match && !Object.hasOwn(fields, match[1]), 'Malformed or duplicate diagnostic field')
    assert(match[2] || match[1] === 'close-results', 'Empty diagnostic field')
    fields[match[1]] = match[2]
  }
  assert.deepEqual(
    Object.keys(fields).sort(),
    [
      'stage',
      'role',
      'component',
      'win32-error',
      'native-status',
      'io-status',
      'io-information',
      'decoder-exit',
      'result',
      'accounting-first-active',
      'accounting-last-active',
      'accounting-samples',
      'accounting-elapsed-ms',
      'accounting-termination-requested',
      'close-count',
      'close-overflow',
      'close-results',
    ].sort(),
    'Unexpected diagnostic field inventory',
  )
  for (const name of [
    'component',
    'win32-error',
    'io-information',
    'decoder-exit',
    'accounting-first-active',
    'accounting-last-active',
    'accounting-samples',
    'accounting-elapsed-ms',
    'accounting-termination-requested',
    'close-count',
    'close-overflow',
  ])
    assert(/^\d+$/u.test(fields[name]), `Invalid diagnostic ${name}`)
  for (const name of ['native-status', 'io-status'])
    assert(/^0x[0-9a-f]{8}$/iu.test(fields[name]), `Invalid diagnostic ${name}`)
  const closeCount = BigInt(fields['close-count'])
  const closes = fields['close-results'] ? fields['close-results'].split(';') : []
  assert.equal(
    closes.length,
    Number(closeCount < 64n ? closeCount : 64n),
    'Diagnostic close count mismatch',
  )
  assert.equal(
    fields['close-overflow'],
    closeCount > 64n ? '1' : '0',
    'Diagnostic close overflow mismatch',
  )
  const closeKinds = new Set([
    'close-guard',
    'close-guard-probe',
    'close-thread',
    'close-process',
    'close-job',
    'close-nul',
    'close-output',
    'close-archive',
    'close-exe',
    'close-ancestor',
  ])
  for (const close of closes) {
    const match = /^([a-z-]+):(\d+):([01]):(\d+)$/u.exec(close)
    assert(match && closeKinds.has(match[1]), 'Malformed diagnostic close result')
  }
  return fields
}

function parseArguments(argv) {
  const options = {}
  const names = new Map([
    ['--production-directory', 'productionDirectory'],
    ['--fixture-directory', 'fixtureDirectory'],
    ['--output-directory', 'outputDirectory'],
  ])
  for (let index = 0; index < argv.length; index++) {
    if (argv[index] === '--help') {
      options.help = true
      continue
    }
    const name = names.get(argv[index])
    assert(name && !options[name], `Unknown or duplicate argument: ${argv[index]}`)
    const value = argv[++index]
    assert(value && !value.startsWith('--') && !/[\0\r\n]/u.test(value), 'Expected a directory')
    options[name] = path.resolve(value)
  }
  assert(
    options.help || [...names.values()].every((name) => options[name]),
    'Expected production, fixture and output directories',
  )
  return options
}

async function atomicJson(filename, value) {
  const temporary = `${filename}.pending`
  await fs.writeFile(temporary, `${JSON.stringify(value, null, 2)}\n`, { flag: 'wx' })
  await fs.rename(temporary, filename)
}

// A timeout kills only this exact owned PID. The launcher owns its private kill
// job. We retain every input/output path and make no tree-drain claim on timeout.
function boundedProcess(executable, args, options = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(executable, args, {
      ...options,
      windowsHide: true,
      shell: false,
      stdio: ['ignore', 'pipe', 'pipe'],
    })
    const output = { stdout: [], stderr: [], bytes: 0, timedOut: false, killRequested: false }
    let ended = false
    let grace
    const timer = setTimeout(() => {
      output.timedOut = true
      output.killRequested = child.kill()
      grace = setTimeout(
        () =>
          finish(
            new Error('Owned child did not report exit after timeout; all evidence paths retained'),
          ),
        10000,
      )
    }, 60000)
    const finish = (error, code, signal) => {
      if (ended) return
      ended = true
      clearTimeout(timer)
      clearTimeout(grace)
      child.stdout?.destroy()
      child.stderr?.destroy()
      const result = {
        pid: child.pid || null,
        code,
        signal,
        timedOut: output.timedOut,
        killRequested: output.killRequested,
        stdout: Buffer.concat(output.stdout).toString('utf8'),
        stderr: Buffer.concat(output.stderr).toString('utf8'),
      }
      if (error) {
        // Do not let an unproved still-live owned PID keep Node alive forever.
        // Its paths remain retained; this is not a process-tree drain claim.
        child.unref()
        error.processResult = result
        reject(error)
      } else resolve(result)
    }
    for (const name of ['stdout', 'stderr'])
      child[name]?.on('data', (chunk) => {
        output.bytes += chunk.length
        if (output.bytes <= 1024 * 1024) output[name].push(chunk)
        else {
          output.timedOut = true
          output.killRequested = child.kill()
        }
      })
    child.once('error', (error) => finish(error))
    child.once('close', (code, signal) => finish(null, code, signal))
  })
}

async function checkedProcess(executable, args, options) {
  const result = await boundedProcess(executable, args, options)
  assert(
    !result.timedOut && result.code === 0,
    `Owned build tool failed: ${JSON.stringify(result)}`,
  )
  return result
}

async function launcherIdentity(directory, fixtureOnly) {
  const filename = path.join(directory, 'LifeInstallerLauncher.dll')
  const stat = await fs.lstat(filename)
  assert(stat.isFile() && !stat.isSymbolicLink(), 'Launcher must be an ordinary file')
  const buffer = await fs.readFile(filename)
  const pe = inspectPe(buffer, fixtureOnly ? ['Launch', 'LaunchFixture'] : ['Launch'])
  const metadata = JSON.parse(
    await fs.readFile(path.join(directory, 'launcher-metadata.json'), 'utf8'),
  )
  assert.equal(metadata.fixtureOnly, fixtureOnly, 'Wrong launcher build variant')
  assert.equal(metadata.binary.sha256, digest(buffer), 'Launcher metadata identity mismatch')
  assert.equal(metadata.binary.bytes, buffer.length, 'Launcher metadata size mismatch')
  return { filename, sha256: digest(buffer), bytes: buffer.length, pe }
}

async function main(argv = process.argv.slice(2)) {
  const options = parseArguments(argv)
  if (options.help) {
    console.log(
      'Usage: node scripts/smoke-modern-extractor.cjs --production-directory DIR --fixture-directory DIR --output-directory DIR',
    )
    return
  }
  assert.equal(process.platform, 'win32', 'This smoke test executes only on Windows')
  assert.notEqual(
    options.productionDirectory,
    options.fixtureDirectory,
    'Use separate launcher variants',
  )
  await fs.mkdir(path.dirname(options.outputDirectory), { recursive: true })
  await fs.mkdir(options.outputDirectory) // Fresh owned directory; never replace or delete evidence.
  const output = options.outputDirectory
  const failures = []
  try {
    const production = await launcherIdentity(options.productionDirectory, false)
    const fixture = await launcherIdentity(options.fixtureDirectory, true)
    const vendor = path.join(output, 'vendor')
    await fs.mkdir(vendor)
    const extra = path.join(vendor, '7z2604-extra.7z')
    const source = path.join(vendor, sourceName)
    await downloadPinned(pins.extra.url, extra, pins.extra)
    await downloadPinned(pins.source.url, source, pins.source)
    const programFiles = process.env.ProgramW6432 || process.env.ProgramFiles
    assert(programFiles, 'Program Files path is unavailable')
    const bootstrap = path.join(programFiles, '7-Zip', '7z.exe')
    assert((await fs.stat(bootstrap)).isFile(), 'Installed 7-Zip bootstrap is required')
    const extracted = path.join(vendor, 'extra')
    const bootstrapResult = await checkedProcess(bootstrap, [
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
    ])
    await atomicJson(path.join(output, 'bootstrap-process.json'), bootstrapResult)
    const decoder = path.join(vendor, binaryName)
    await fs.copyFile(path.join(extracted, 'x64', '7za.exe'), decoder)
    await fs.copyFile(path.join(extracted, 'License.txt'), path.join(vendor, '7zip-License.txt'))
    await fs.copyFile(
      path.join(root, 'scripts', 'decoder-diagnostic-notices', '7zip-LGPL-2.1.txt'),
      path.join(vendor, 'LGPL-2.1.txt'),
    )
    await validatePinnedFile(decoder, pins.binary)
    validateX64Executable(await fs.readFile(decoder))
    await validatePinnedFile(source, pins.source)
    await validatePinnedFile(path.join(vendor, '7zip-License.txt'), pins.license)
    await validatePinnedFile(path.join(vendor, 'LGPL-2.1.txt'), pins.lgpl)
    await atomicJson(path.join(vendor, 'PROVENANCE.json'), {
      format: 1,
      version: '26.04',
      unmodifiedBinary: true,
      binary: pins.binary,
      officialExtra: pins.extra,
      correspondingSource: pins.source,
      notices: { license: pins.license, lgpl: pins.lgpl },
    })
    const input = path.join(output, 'synthetic-input')
    await fs.mkdir(input)
    const content = Buffer.from('Life contained extractor compiler smoke.\n', 'utf8')
    await fs.writeFile(path.join(input, 'smoke.txt'), content, { flag: 'wx' })
    const archive = path.join(output, 'synthetic.7z')
    const archiveResult = await checkedProcess(
      decoder,
      ['a', '-t7z', '-y', '-bd', '-bb0', archive, '--', 'smoke.txt'],
      { cwd: input },
    )
    await atomicJson(path.join(output, 'archive-process.json'), archiveResult)
    await atomicJson(path.join(output, 'inputs.json'), {
      format: 1,
      purpose: 'Compiler smoke; synthetic payload only',
      production,
      fixture,
      decoder: pins.binary,
      expectedPayloadSha256: digest(content),
      archiveSha256: digest(await fs.readFile(archive)),
      vendorPins: pins,
    })
    const powershell = path.join(
      process.env.SystemRoot || 'C:\\Windows',
      'SysWOW64',
      'WindowsPowerShell',
      'v1.0',
      'powershell.exe',
    )
    assert((await fs.stat(powershell)).isFile(), 'x86 Windows PowerShell is required')
    const host = path.join(output, 'windows-modern-extractor-smoke.ps1')
    await fs.copyFile(path.join(__dirname, 'windows-modern-extractor-smoke.ps1'), host)
    for (const kind of ['production', 'diagnostic']) {
      const target = path.join(output, `${kind}-output`)
      await fs.mkdir(target)
      const marker = path.join(output, 'diagnostic-marker.txt')
      const report = path.join(output, `${kind}-host-result.json`)
      const config = path.join(output, `${kind}-config.json`)
      const inputs = [decoder, archive, target]
      if (kind === 'diagnostic') inputs.push(marker, 'diagnostic')
      await atomicJson(config, {
        dll: kind === 'production' ? production.filename : fixture.filename,
        export: kind === 'production' ? 'Launch' : 'LaunchFixture',
        inputs,
        report,
      })
      let processResult
      try {
        processResult = await boundedProcess(
          powershell,
          ['-NoLogo', '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', host],
          { env: nativePowerShellEnvironment(process.env, config) },
        )
      } catch (error) {
        processResult = { ...error.processResult, error: error.message }
        failures.push(error)
      }
      // Preserve process and raw native evidence before interpreting any result.
      await atomicJson(path.join(output, `${kind}-process.json`), processResult)
      let hostResult = null
      let markerText = null
      let markerFields = null
      try {
        hostResult = JSON.parse(await fs.readFile(report, 'utf8'))
      } catch (error) {
        failures.push(new Error(`${kind} host report unavailable: ${error.message}`))
      }
      if (kind === 'diagnostic') {
        try {
          const markerBuffer = await fs.readFile(marker)
          markerText = markerBuffer.toString('utf16le')
          markerFields = parseDiagnosticMarker(markerBuffer)
        } catch (error) {
          failures.push(new Error(`Diagnostic marker unavailable: ${error.message}`))
        }
      }
      const evidence = {
        kind,
        process: processResult,
        host: hostResult,
        markerText,
        markerFields,
        expectedPayloadSha256: digest(content),
      }
      try {
        evidence.outputNames = (await fs.readdir(target)).sort()
        evidence.payloadSha256 = digest(await fs.readFile(path.join(target, 'smoke.txt')))
      } catch (error) {
        evidence.outputReadError = error.message
      }
      await atomicJson(path.join(output, `${kind}-evidence.json`), evidence)
      console.log(`${kind} launcher raw result: ${JSON.stringify(evidence)}`)
    }
    // Both separate calls have completed and evidence is durable before strict assertions.
    for (const kind of ['production', 'diagnostic']) {
      try {
        const evidence = JSON.parse(
          await fs.readFile(path.join(output, `${kind}-evidence.json`), 'utf8'),
        )
        assert.equal(evidence.process.code, 0, `${kind} host exit`)
        assert.equal(evidence.process.timedOut, false, `${kind} host timeout`)
        assert(evidence.host && !evidence.host.error, `${kind} managed host error`)
        assert.equal(evidence.host.token, 'ok', `${kind} launcher token`)
        for (const field of [
          'stackContract',
          'variablesUnchanged',
          'flagsUnchanged',
          'checkedCleanup',
        ])
          assert.equal(evidence.host[field], true, `${kind} synthetic host ${field}`)
        assert.deepEqual(evidence.outputNames, ['smoke.txt'], `${kind} output inventory`)
        assert.equal(evidence.payloadSha256, digest(content), `${kind} payload SHA256`)
        if (kind === 'diagnostic')
          assert(
            evidence.markerFields &&
              evidence.markerFields.result === 'ok' &&
              evidence.markerFields['decoder-exit'] === '0',
            'Diagnostic trace must report successful result',
          )
      } catch (error) {
        failures.push(error)
      }
    }
  } catch (error) {
    failures.push(error)
  }
  await atomicJson(path.join(output, 'smoke-summary.json'), {
    format: 1,
    passed: failures.length === 0,
    scope:
      'Synthetic compiler smoke only; real NSIS state, containment, mutation and upgrade timing require separate fixtures',
    failures: failures.map((error) => ({
      name: error.name,
      message: error.message,
      stack: error.stack,
    })),
  })
  if (failures.length)
    throw new AggregateError(
      failures,
      'Modern extractor smoke failed; all owned evidence is retained',
    )
  console.log(
    'Production and diagnostic launcher smoke passed with synthetic payload SHA256 and stack checks.',
  )
}

module.exports = {
  parseArguments,
  nativePowerShellEnvironment,
  parseDiagnosticMarker,
  boundedProcess,
  main,
}
if (require.main === module)
  main().catch((error) => {
    console.error(error)
    process.exitCode = 1
  })
