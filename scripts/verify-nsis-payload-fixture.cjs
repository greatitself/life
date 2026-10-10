'use strict'

const assert = require('node:assert/strict')
const { createHash } = require('node:crypto')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const { spawn, spawnSync } = require('node:child_process')
const { performance } = require('node:perf_hooks')
const { getPath7za } = require('app-builder-lib/out/toolsets/7zip.js')
const { getMakeNsisPath, getNsisPluginsPath } = require('app-builder-lib/out/toolsets/windows.js')

const root = path.resolve(__dirname, '..')

const metadataScript = String.raw`$ErrorActionPreference = 'Stop'
Set-StrictMode -Version Latest
$metadataRoot = [Environment]::GetEnvironmentVariable('LIFE_NSIS_METADATA_ROOT')
$metadataOutput = [Environment]::GetEnvironmentVariable('LIFE_NSIS_METADATA_OUTPUT')
$metadataAction = [Environment]::GetEnvironmentVariable('LIFE_NSIS_METADATA_ACTION')
if ([String]::IsNullOrEmpty($metadataRoot) -or [String]::IsNullOrEmpty($metadataOutput)) { throw 'Missing metadata fixture environment.' }
$metadataRoot = [IO.Path]::GetFullPath($metadataRoot).TrimEnd([char]'\')
if ($metadataRoot.Length -le 3) { throw 'Fixture must not customize or snapshot a volume root.' }
$rootItem = Get-Item -LiteralPath $metadataRoot -Force
if (-not $rootItem.PSIsContainer -or ([Int64]$rootItem.Attributes -band 0x400) -ne 0) { throw 'Metadata fixture root must be an ordinary directory.' }

if ($metadataAction -eq 'customize') {
  if (@(Get-ChildItem -LiteralPath $metadataRoot -Force).Count -ne 0) { throw 'Custom metadata must be prepared on an empty fixture target.' }
  $currentSid = [Security.Principal.WindowsIdentity]::GetCurrent().User
  $customAcl = Get-Acl -LiteralPath $metadataRoot
  $customAcl.SetAccessRuleProtection($true, $false)
  foreach ($rule in @($customAcl.GetAccessRules($true, $false, [Security.Principal.SecurityIdentifier]))) {
    [void]$customAcl.RemoveAccessRuleSpecific($rule)
  }
  $inheritance = [Security.AccessControl.InheritanceFlags]::ContainerInherit -bor [Security.AccessControl.InheritanceFlags]::ObjectInherit
  $customAcl.AddAccessRule([Security.AccessControl.FileSystemAccessRule]::new($currentSid, [Security.AccessControl.FileSystemRights]::FullControl, $inheritance, [Security.AccessControl.PropagationFlags]::None, [Security.AccessControl.AccessControlType]::Allow))
  $customAcl.AddAccessRule([Security.AccessControl.FileSystemAccessRule]::new([Security.Principal.SecurityIdentifier]::new('S-1-5-32-545'), [Security.AccessControl.FileSystemRights]::ReadAndExecute, $inheritance, [Security.AccessControl.PropagationFlags]::InheritOnly, [Security.AccessControl.AccessControlType]::Allow))
  Set-Acl -LiteralPath $metadataRoot -AclObject $customAcl
  [IO.File]::WriteAllText(($metadataRoot + ':life-fixture-root'), 'Life root stream sentinel', [Text.UTF8Encoding]::new($false))
} elseif ($metadataAction -ne 'snapshot') { throw 'Unsupported metadata fixture action.' }

function Get-FixtureHash([String]$filename) {
  $hash = [Security.Cryptography.SHA256]::Create()
  $handle = $null
  try {
    $handle = [IO.File]::Open($filename, [IO.FileMode]::Open, [IO.FileAccess]::Read, [IO.FileShare]::Read)
    if ($handle.Length -gt 16MB) { throw 'Fixture stream or file exceeds the hashing limit.' }
    return ([BitConverter]::ToString($hash.ComputeHash($handle))).Replace('-', '').ToLowerInvariant()
  } finally {
    if ($null -ne $handle) { $handle.Dispose() }
    $hash.Dispose()
  }
}

# Windows PowerShell 5 cannot reliably enumerate directory ADS through -Stream.
# Read the native enumeration with immediate last-error capture instead.
Add-Type -TypeDefinition @'
using System;
using System.Collections.Generic;
using System.ComponentModel;
using System.Runtime.InteropServices;
public static class LifeFixtureStreams {
  [StructLayout(LayoutKind.Sequential, CharSet=CharSet.Unicode)]
  private struct StreamData {
    public long Size;
    [MarshalAs(UnmanagedType.ByValTStr, SizeConst=296)]
    public string Name;
  }
  public sealed class Entry { public string Name; public long Size; }
  [DllImport("kernel32.dll", CharSet=CharSet.Unicode, ExactSpelling=true, SetLastError=true)]
  private static extern IntPtr FindFirstStreamW(string path, int level, out StreamData data, uint flags);
  [DllImport("kernel32.dll", CharSet=CharSet.Unicode, ExactSpelling=true, SetLastError=true)]
  [return: MarshalAs(UnmanagedType.Bool)]
  private static extern bool FindNextStreamW(IntPtr handle, out StreamData data);
  [DllImport("kernel32.dll", SetLastError=true)]
  [return: MarshalAs(UnmanagedType.Bool)]
  private static extern bool FindClose(IntPtr handle);
  public static Entry[] Read(string path) {
    StreamData data;
    IntPtr handle = FindFirstStreamW(path, 0, out data, 0);
    int firstError = Marshal.GetLastWin32Error();
    if (handle == new IntPtr(-1)) {
      if (firstError == 38) return new Entry[0];
      throw new Win32Exception(firstError, "FindFirstStreamW failed");
    }
    List<Entry> result = new List<Entry>();
    int count = 0;
    try {
      while (true) {
        if (++count > 17 || data.Size < 0) throw new InvalidOperationException("Fixture streams exceed bounds");
        if (data.Name != "::$DATA") {
          if (!data.Name.StartsWith(":", StringComparison.Ordinal) || !data.Name.EndsWith(":$DATA", StringComparison.Ordinal)) throw new InvalidOperationException("Unexpected stream type");
          result.Add(new Entry { Name = data.Name.Substring(1, data.Name.Length - 7), Size = data.Size });
        }
        if (!FindNextStreamW(handle, out data)) {
          int nextError = Marshal.GetLastWin32Error();
          if (nextError != 38) throw new Win32Exception(nextError, "FindNextStreamW failed");
          break;
        }
      }
    } finally {
      if (!FindClose(handle)) throw new Win32Exception(Marshal.GetLastWin32Error(), "FindClose stream failed");
    }
    return result.ToArray();
  }
}
'@

$pending = [Collections.Generic.Stack[Object]]::new()
$pending.Push([PSCustomObject]@{ Item = (Get-Item -LiteralPath $metadataRoot -Force); Relative = ''; Depth = 0 })
$records = [Collections.Generic.List[Object]]::new()
$streamTotal = [Int64]0
while ($pending.Count -gt 0) {
  $pendingItem = $pending.Pop()
  $item = $pendingItem.Item
  if ($pendingItem.Depth -gt 16 -or $records.Count -ge 128) { throw 'Fixture inventory exceeds bounds.' }
  if (([Int64]$item.Attributes -band 0x400) -ne 0) { throw 'Metadata snapshot refuses reparse points.' }
  $acl = Get-Acl -LiteralPath $item.FullName
  $aceRecords = @($acl.GetAccessRules($true, $true, [Security.Principal.SecurityIdentifier]) | ForEach-Object {
    [PSCustomObject][ordered]@{
      Sid = $_.IdentityReference.Value
      Type = [Int32]$_.AccessControlType
      Rights = [Int64]$_.FileSystemRights
      Inheritance = [Int32]$_.InheritanceFlags
      Propagation = [Int32]$_.PropagationFlags
      IsInherited = $_.IsInherited
    }
  } | Sort-Object Sid, Type, Rights, Inheritance, Propagation, IsInherited)
  $streams = @()
  foreach ($stream in @([LifeFixtureStreams]::Read($item.FullName))) {
    $streamTotal += $stream.Size
    if ($streamTotal -gt 8MB -or $streams.Count -ge 16) { throw 'Fixture ADS inventory exceeds bounds.' }
    $streams += [PSCustomObject][ordered]@{ Name = $stream.Name; Size = [Int64]$stream.Size; Sha256 = Get-FixtureHash ($item.FullName + ':' + $stream.Name) }
  }
  $record = [PSCustomObject][ordered]@{
    Relative = $pendingItem.Relative
    Directory = [Bool]$item.PSIsContainer
    Attributes = [Int64]$item.Attributes
    FileSha256 = $(if ($item.PSIsContainer) { $null } else { Get-FixtureHash $item.FullName })
    FileLastWriteUtcTicks = $(if ($item.PSIsContainer) { $null } else { $item.LastWriteTimeUtc.Ticks.ToString([Globalization.CultureInfo]::InvariantCulture) })
    DirectoryLastWriteUtcTicksInformational = $(if ($item.PSIsContainer) { $item.LastWriteTimeUtc.Ticks.ToString([Globalization.CultureInfo]::InvariantCulture) } else { $null })
    OwnerSid = $acl.GetOwner([Security.Principal.SecurityIdentifier]).Value
    GroupSid = $acl.GetGroup([Security.Principal.SecurityIdentifier]).Value
    DaclProtected = $acl.AreAccessRulesProtected
    DaclCanonical = $acl.AreAccessRulesCanonical
    Aces = $aceRecords
    Streams = @($streams | Sort-Object Name)
  }
  $records.Add($record)
  if ($item.PSIsContainer) {
    foreach ($child in @(Get-ChildItem -LiteralPath $item.FullName -Force)) {
      $relative = $(if ($pendingItem.Relative -eq '') { $child.Name } else { $pendingItem.Relative + '/' + $child.Name })
      $pending.Push([PSCustomObject]@{ Item = $child; Relative = $relative; Depth = $pendingItem.Depth + 1 })
    }
  }
}
$json = ConvertTo-Json -InputObject @($records | Sort-Object Relative) -Depth 12 -Compress
[IO.File]::WriteAllText($metadataOutput, $json, [Text.UTF8Encoding]::new($false))`

const immediate = () => new Promise((resolve) => setImmediate(resolve))

async function bounded(promise, timeoutMs, message) {
  let timer
  try {
    return await Promise.race([
      promise,
      new Promise((_, reject) => {
        timer = setTimeout(() => reject(new Error(message)), timeoutMs)
      }),
    ])
  } finally {
    clearTimeout(timer)
  }
}

function maybeRead(filename, encoding) {
  try {
    return fs.readFileSync(filename, encoding)
  } catch (error) {
    if (['ENOENT', 'EACCES', 'EPERM', 'EBUSY'].includes(error.code)) return undefined
    throw error
  }
}

function phases(text) {
  return (text ?? '')
    .split(/\r?\n/)
    .filter(Boolean)
    .map((line) => line.split('\t')[0])
}

// Caller builds a separate good Copy-method archive and compiles the actual
// normal wrapper against its manifest. It writes its own process ID into
// `${report}.pid` immediately before calling extractUsing7za.
async function interruptActualExtraction({
  executable,
  env,
  target,
  report,
  trace,
  expectedSize,
  expectedPrefix,
  expectedTail,
  expectedSha256,
  filename = 'large.bin',
}) {
  assert.equal(process.platform, 'win32')
  assert.ok(expectedPrefix.length > 0 && expectedTail.length > 0)
  assert.ok(expectedSize > expectedPrefix.length + expectedTail.length)
  assert.ok(expectedPrefix.some((byte) => byte !== 0))
  assert.ok(expectedTail.some((byte) => byte !== 0))
  for (const item of [
    trace,
    report,
    `${report}.pid`,
    `${report}.registered`,
    `${report}.launched`,
  ]) {
    assert.equal(
      fs.existsSync(item),
      false,
      `Interruption trial must use fresh evidence files: ${item}`,
    )
  }
  assert.deepEqual(fs.readdirSync(target), [], 'Interrupted direct extraction must start empty')
  const output = path.join(target, filename)
  const child = spawn(executable, ['/S'], {
    cwd: path.dirname(executable),
    env,
    windowsHide: true,
    shell: false,
    detached: false,
    stdio: 'ignore',
  })
  let exited = false
  let spawnError
  child.once('error', (error) => {
    spawnError = error
  })
  const completion = new Promise((resolve) => {
    child.once('close', (code, signal) => {
      exited = true
      resolve({ code, signal, error: spawnError })
    })
  })
  let fd
  let started = false
  let pidConfirmed = false
  let observed
  const prefix = Buffer.alloc(expectedPrefix.length)
  const tail = Buffer.alloc(expectedTail.length)
  try {
    await bounded(
      new Promise((resolve, reject) => {
        child.once('spawn', resolve)
        child.once('error', reject)
      }),
      10000,
      'Native fixture did not launch',
    )
    const deadline = performance.now() + 30000
    while (performance.now() < deadline) {
      if (exited)
        throw new Error('Native extraction completed before an incomplete write was observed')
      if (!pidConfirmed) {
        const nativePid = maybeRead(`${report}.pid`, 'ascii')
        if (nativePid !== undefined && /^\d+\r?\n$/.test(nativePid)) {
          assert.equal(
            Number(nativePid.trim()),
            child.pid,
            'Kill handle must identify the actual extractor process',
          )
          pidConfirmed = true
        }
      }
      if (!started) {
        const logged = phases(maybeRead(trace, 'ascii'))
        if (logged.includes('extract-complete')) {
          throw new Error('Extractor returned before incomplete content was observed')
        }
        started = logged.includes('payload-direct-start') && logged.includes('extract-start')
      }
      if (started && pidConfirmed) {
        if (fd === undefined) {
          try {
            // libuv uses FILE_SHARE_READ|WRITE|DELETE; this is compatible with
            // Nsis7z's GENERIC_WRITE + FILE_SHARE_READ output handle.
            fd = fs.openSync(output, 'r')
          } catch (error) {
            if (!['ENOENT', 'EACCES', 'EPERM', 'EBUSY'].includes(error.code)) throw error
          }
        }
        if (fd !== undefined) {
          const prefixRead = fs.readSync(fd, prefix, 0, prefix.length, 0)
          const tailRead = fs.readSync(fd, tail, 0, tail.length, expectedSize - tail.length)
          if (
            prefixRead === prefix.length &&
            prefix.equals(expectedPrefix) &&
            tailRead === tail.length &&
            tail.every((byte) => byte === 0)
          ) {
            observed = {
              pid: child.pid,
              size: fs.fstatSync(fd).size,
              elapsedMs: 30000 - (deadline - performance.now()),
            }
            assert.equal(
              child.kill('SIGKILL'),
              true,
              'Native extractor must receive the termination request',
            )
            break
          }
        }
      }
      // Yield without the Windows timer quantum so a fast actual writer cannot
      // finish between startup polling intervals. No installer delay is added.
      await immediate()
    }
    assert.ok(observed, 'No actual incomplete extraction was observed before the deadline')
    const exit = await bounded(completion, 10000, 'Killed native extractor did not exit')
    if (exit.error) throw exit.error
    assert.ok(exit.code !== 0 || exit.signal, 'Interrupted fixture cannot report successful exit')
    // Close our read handle before retrying the unchanged normal wrapper.
    fs.closeSync(fd)
    fd = undefined
    const after = fs.readFileSync(output)
    assert.equal(
      after.length,
      expectedSize,
      'Preallocated file length must survive the interruption',
    )
    assert.ok(
      after.subarray(0, expectedPrefix.length).equals(expectedPrefix),
      'Written prefix must survive interruption',
    )
    assert.ok(
      after.subarray(expectedSize - expectedTail.length).every((byte) => byte === 0),
      'Post-exit tail must remain unwritten; a kill that lost its race is not interruption evidence',
    )
    assert.notEqual(
      createHash('sha256').update(after).digest('hex'),
      expectedSha256,
      'Interrupted file must fail the trusted full manifest hash',
    )
    const logged = phases(fs.readFileSync(trace, 'ascii'))
    assert.deepEqual(
      logged,
      ['payload-direct-start', 'extract-start'],
      'Interrupted extraction cannot reach verification, completion, registration or launch',
    )
    for (const item of [report, `${report}.registered`, `${report}.launched`]) {
      assert.equal(
        fs.existsSync(item),
        false,
        'Interrupted extraction cannot produce successful action sentinels',
      )
    }
    return { ...observed, exit, finalSize: after.length, phases: logged }
  } finally {
    if (fd !== undefined) fs.closeSync(fd)
    if (!exited) {
      child.kill('SIGKILL')
      await bounded(completion, 10000, 'Failed interrupted trial left a live fixture process')
    }
  }
}

function nsisString(value) {
  return String(value)
    .replaceAll('$', () => '$$')
    .replaceAll('"', '$\\"')
}

function run(command, args, options = {}) {
  const result = spawnSync(command, args, {
    cwd: root,
    encoding: 'utf8',
    timeout: 60000,
    windowsHide: true,
    ...options,
  })
  if (result.error) throw result.error
  return result
}

function requireSuccess(command, args, options) {
  const result = run(command, args, options)
  assert.equal(result.status, 0, `${command} failed:\n${result.stdout}\n${result.stderr}`)
  return result
}

function windowsPowerShellEnvironment(environment) {
  // pwsh -> Node -> Windows PowerShell otherwise inherits incompatible PS7
  // module paths. Let this child reconstruct its native defaults at startup.
  return Object.fromEntries(
    Object.entries(environment).filter(([key]) => key.toUpperCase() !== 'PSMODULEPATH'),
  )
}

function sha256(filename) {
  return createHash('sha256').update(fs.readFileSync(filename)).digest('hex')
}

function inventory(directory) {
  const entries = []
  function visit(current, relative) {
    for (const entry of fs.readdirSync(current, { withFileTypes: true })) {
      const name = relative ? `${relative}/${entry.name}` : entry.name
      const filename = path.join(current, entry.name)
      assert.equal(entry.isSymbolicLink(), false, `Unexpected linked fixture entry: ${name}`)
      if (entry.isDirectory()) {
        entries.push({ name, directory: true })
        visit(filename, name)
      } else {
        assert.ok(entry.isFile(), `Unexpected nonregular fixture entry: ${name}`)
        entries.push({ name, directory: false, sha256: sha256(filename) })
      }
    }
  }
  visit(directory, '')
  return entries.sort((a, b) => a.name.localeCompare(b.name, 'en'))
}

async function main() {
  const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'life-nsis-payload-fixture-'))
  try {
    const [sevenZip, binary, plugins] = await Promise.all([
      getPath7za(),
      getMakeNsisPath(),
      getNsisPluginsPath(),
    ])
    const payload = path.join(scratch, 'trusted-payload')
    fs.mkdirSync(path.join(payload, 'nested', '研究$'), { recursive: true })
    fs.mkdirSync(path.join(payload, 'empty'))
    const bytes = Buffer.alloc(65571)
    let state = 0x6c696665
    for (let i = 0; i < bytes.length; i++) {
      state ^= state << 13
      state ^= state >>> 17
      state ^= state << 5
      bytes[i] = state & 0xff
    }
    fs.writeFileSync(path.join(payload, 'payload.bin'), bytes)
    fs.writeFileSync(
      path.join(payload, 'nested', '研究$', "entry-$value-'quote-`tick.txt"),
      'Life payload fixture\n',
    )
    const fixedTime = new Date('2020-01-02T03:04:05Z')
    function fixPayloadTimes(directory) {
      for (const item of fs.readdirSync(directory, { withFileTypes: true })) {
        const filename = path.join(directory, item.name)
        if (item.isDirectory()) fixPayloadTimes(filename)
        fs.utimesSync(filename, fixedTime, fixedTime)
      }
    }
    fixPayloadTimes(payload)

    function archive(source, name) {
      const filename = path.join(scratch, name)
      requireSuccess(
        sevenZip,
        ['a', '-t7z', '-m0=Copy', '-ms=off', '-mhc=off', '-y', filename, '.'],
        { cwd: source },
      )
      requireSuccess(sevenZip, ['t', filename])
      return filename
    }

    const good = archive(payload, 'good.7z')
    const goodBytes = fs.readFileSync(good)
    const payloadOffset = goodBytes.indexOf(bytes)
    assert.ok(
      payloadOffset >= 32,
      'The Copy-method archive must contain the complete fixture bytes',
    )
    assert.equal(goodBytes.indexOf(bytes, payloadOffset + 1), -1, 'Fixture bytes must occur once')
    const corrupt = path.join(scratch, 'crc-corrupt.7z')
    const corruptBytes = Buffer.from(goodBytes)
    corruptBytes[payloadOffset + Math.floor(bytes.length / 2)] ^= 0x80
    fs.writeFileSync(corrupt, corruptBytes)
    const corruptOutput = path.join(scratch, 'crc-output')
    const corruptResult = run(sevenZip, ['x', '-y', `-o${corruptOutput}`, corrupt])
    assert.equal(
      corruptResult.status,
      2,
      'The negative archive must have an actual payload CRC error',
    )
    assert.equal(fs.statSync(path.join(corruptOutput, 'payload.bin')).size, bytes.length)
    assert.notEqual(
      sha256(path.join(corruptOutput, 'payload.bin')),
      sha256(path.join(payload, 'payload.bin')),
    )

    const truncated = path.join(scratch, 'truncated.7z')
    fs.writeFileSync(truncated, goodBytes.subarray(0, 24))
    assert.notEqual(run(sevenZip, ['t', truncated]).status, 0, 'Truncated header must be invalid')
    const shortPayload = path.join(scratch, 'short-payload')
    fs.cpSync(payload, shortPayload, { recursive: true })
    fs.writeFileSync(path.join(shortPayload, 'payload.bin'), bytes.subarray(0, bytes.length - 1))
    const short = archive(shortPayload, 'short-valid-crc.7z')

    for (const [name, filename] of [
      ['crc', corrupt],
      ['truncated', truncated],
    ]) {
      const output = path.join(scratch, `${name}-must-not-generate.nsh`)
      const result = run(process.execPath, [
        path.join(root, 'scripts', 'generate-installer-payload.cjs'),
        '--archive',
        filename,
        '--arch',
        '64',
        '--output',
        output,
      ])
      assert.notEqual(result.status, 0, `The manifest generator must reject ${name} corruption`)
      assert.equal(
        fs.existsSync(output),
        false,
        'Invalid archives must not produce trusted manifests',
      )
    }

    const includes = path.join(
      path.dirname(require.resolve('app-builder-lib/package.json')),
      'templates',
      'nsis',
      'include',
    )
    const source = path.join(scratch, 'fixture.nsi')
    const executable = path.join(scratch, 'fixture.exe')
    const registers = Array.from({ length: 10 }, (_, index) => [`$${index}`, `$R${index}`]).flat()
    const initialize = registers
      .map((register, i) => `StrCpy ${register} "register-${i}"`)
      .join('\n')
    const check = registers
      .map((register, i) => `StrCmp ${register} "register-${i}" 0 fixture_failed`)
      .join('\n')
    fs.writeFileSync(
      source,
      '\ufeff' +
        String.raw`Unicode true
Name "Life installer payload fixture"
OutFile "${nsisString(executable)}"
RequestExecutionLevel user
SilentInstall silent
!define PROJECT_DIR "${nsisString(root)}"
!define APP_64 "${nsisString(good)}"
!define PRODUCT_NAME "Life fixture"
!addincludedir "${nsisString(includes)}"
!addincludedir "${nsisString(path.join(root, 'build'))}"
!addplugindir /x86-unicode "${nsisString(path.join(plugins, 'x86-unicode'))}"
!include "LogicLib.nsh"
!include "StdUtils.nsh"
LoadLanguageFile "${'${NSISDIR}'}\Contrib\Language files\English.nlf"
LangString appCannotBeClosed 1033 "The fixture payload is locked."
!include "${nsisString(path.join(root, 'build', 'installer.nsh'))}"
!insertmacro customHeader
!include "${nsisString(path.join(root, 'build', 'installer-extract-profile.nsh'))}"
Var packageArch
Var fixtureMode
Var fixtureExpected
Var fixtureResult
Var fixtureScratch
Var fixtureReport
Var fixtureArchive
Var fixtureHandle
Var fixtureHandleCount
Var fixtureLock

!macro FixtureBegin
  ${initialize}
  Push "stack-bottom"
  Push "stack-top"
!macroend

!macro FixtureCheck
  StrCmp $fixtureResult $fixtureExpected 0 fixture_failed
  Pop $fixtureScratch
  StrCmp $fixtureScratch "stack-top" 0 fixture_failed
  Pop $fixtureScratch
  StrCmp $fixtureScratch "stack-bottom" 0 fixture_failed
  ${check}
!macroend

!macro FixtureGuard
  !insertmacro FixtureBegin
  Push "$INSTDIR"
  Call LifeEmptyPayloadDirectory
  Pop $fixtureResult
  !insertmacro FixtureCheck
!macroend

!macro FixtureRequired
  !insertmacro FixtureBegin
  !insertmacro LifeVerifyPayload64 "$INSTDIR" $fixtureResult
  !insertmacro FixtureCheck
!macroend

!macro FixtureExact
  !insertmacro FixtureBegin
  !insertmacro LifeVerifyStagedPayload64 "$INSTDIR" $fixtureResult
  !insertmacro FixtureCheck
!macroend

!macro FixturePreflight
  !insertmacro FixtureBegin
  !insertmacro LifePreflightPayload64 "$INSTDIR" $fixtureResult
  !insertmacro FixtureCheck
!macroend

Section
  InitPluginsDir
  ReadEnvStr $fixtureMode "LIFE_NSIS_PAYLOAD_FIXTURE_MODE"
  ReadEnvStr $INSTDIR "LIFE_NSIS_PAYLOAD_FIXTURE_TARGET"
  ReadEnvStr $fixtureExpected "LIFE_NSIS_PAYLOAD_FIXTURE_EXPECTED"
  ReadEnvStr $fixtureReport "LIFE_NSIS_PAYLOAD_FIXTURE_RESULT"
  ReadEnvStr $fixtureArchive "LIFE_NSIS_PAYLOAD_FIXTURE_ARCHIVE"
  StrCpy $packageArch "64"
  ; Warm persistent plug-in loads before checking for enumeration/hash handle leaks.
  ${'${GetProcessInfo}'} 0 $pid $1 $2 $3 $4
  ${'${StdUtils.HashFile}'} $fixtureScratch "SHA2-256" "$fixtureArchive"
  System::Call 'kernel32::GetCurrentProcess() p .r0'
  System::Call 'kernel32::GetProcessHandleCount(p r0, *i .r1) i .r2'
  StrCmp $2 "0" fixture_failed
  StrCpy $fixtureHandleCount $1

  StrCmp $fixtureMode "guard" fixture_guard
  StrCmp $fixtureMode "required" fixture_required
  StrCmp $fixtureMode "exact" fixture_exact
  StrCmp $fixtureMode "preflight" fixture_preflight
  StrCmp $fixtureMode "extract" fixture_extract
  StrCmp $fixtureMode "extract-locked" fixture_extract_locked fixture_failed

  fixture_guard:
    ClearErrors
    !insertmacro FixtureGuard
    IfErrors fixture_failed
    SetErrors
    !insertmacro FixtureGuard
    IfErrors +2 0
    Goto fixture_failed
    Goto fixture_check_handles

  fixture_required:
    ClearErrors
    !insertmacro FixtureRequired
    IfErrors fixture_failed
    SetErrors
    !insertmacro FixtureRequired
    IfErrors +2 0
    Goto fixture_failed
    Goto fixture_check_handles

  fixture_exact:
    ClearErrors
    !insertmacro FixtureExact
    IfErrors fixture_failed
    SetErrors
    !insertmacro FixtureExact
    IfErrors +2 0
    Goto fixture_failed
    Goto fixture_check_handles

  fixture_preflight:
    ClearErrors
    !insertmacro FixturePreflight
    IfErrors fixture_failed
    SetErrors
    !insertmacro FixturePreflight
    IfErrors +2 0
    Goto fixture_failed
    Goto fixture_check_handles

  fixture_extract_locked:
    System::Call 'kernel32::CreateFileW(w "$INSTDIR\payload.bin", i 0x80000000, i 0, p 0, i 3, i 0, p 0) p .r0'
    StrCmp $0 "-1" fixture_failed
    StrCpy $fixtureLock $0
  fixture_extract:
    SetOutPath "$INSTDIR"
    System::Call 'kernel32::GetCurrentProcessId() i .r0'
    FileOpen $fixtureHandle "$fixtureReport.pid" w
    IfErrors fixture_failed
    FileWrite $fixtureHandle "$0$\r$\n"
    FileClose $fixtureHandle
    !insertmacro extractUsing7za "$fixtureArchive"
    ; These represent registration and launch. Neither may run after a bad payload.
    FileOpen $fixtureHandle "$fixtureReport.registered" w
    IfErrors fixture_failed
    FileClose $fixtureHandle
    FileOpen $fixtureHandle "$fixtureReport.launched" w
    IfErrors fixture_failed
    FileClose $fixtureHandle
    Goto fixture_success

  fixture_check_handles:
    System::Call 'kernel32::GetCurrentProcess() p .r0'
    System::Call 'kernel32::GetProcessHandleCount(p r0, *i .r1) i .r2'
    StrCmp $2 "0" fixture_failed
    StrCmp $1 $fixtureHandleCount 0 fixture_failed
  fixture_success:
    ClearErrors
    FileOpen $fixtureHandle "$fixtureReport" w
    IfErrors fixture_failed
    FileWrite $fixtureHandle "ok$\r$\n"
    FileClose $fixtureHandle
    SetErrorLevel 0
    Goto fixture_complete
  fixture_failed:
    SetErrorLevel 7
    Quit
  fixture_complete:
SectionEnd
`,
    )
    requireSuccess(binary.path, ['-WX', '-V2', '-INPUTCHARSET', 'UTF8', source], {
      env: { ...process.env, ...binary.env },
    })
    const controlSource = path.join(scratch, 'stock-control.nsi')
    const controlExecutable = path.join(scratch, 'stock-control.exe')
    fs.writeFileSync(
      controlSource,
      '\ufeff' +
        String.raw`Unicode true
Name "Life stock installer payload control"
OutFile "${nsisString(controlExecutable)}"
RequestExecutionLevel user
SilentInstall silent
!define PRODUCT_NAME "Life stock fixture"
!addincludedir "${nsisString(includes)}"
!addplugindir /x86-unicode "${nsisString(path.join(plugins, 'x86-unicode'))}"
!include "LogicLib.nsh"
LoadLanguageFile "${'${NSISDIR}'}\Contrib\Language files\English.nlf"
LangString appCannotBeClosed 1033 "The fixture payload is locked."
!include "${nsisString(path.join(includes, 'extractAppPackage.nsh'))}"
Var fixtureArchive
Var fixtureReport
Var fixtureHandle
Section
  InitPluginsDir
  ReadEnvStr $INSTDIR "LIFE_NSIS_PAYLOAD_FIXTURE_TARGET"
  ReadEnvStr $fixtureArchive "LIFE_NSIS_PAYLOAD_FIXTURE_ARCHIVE"
  ReadEnvStr $fixtureReport "LIFE_NSIS_PAYLOAD_FIXTURE_RESULT"
  SetOutPath "$INSTDIR"
  !insertmacro extractUsing7za "$fixtureArchive"
  FileOpen $fixtureHandle "$fixtureReport.registered" w
  IfErrors fixture_failed
  FileClose $fixtureHandle
  FileOpen $fixtureHandle "$fixtureReport.launched" w
  IfErrors fixture_failed
  FileClose $fixtureHandle
  FileOpen $fixtureHandle "$fixtureReport" w
  IfErrors fixture_failed
  FileWrite $fixtureHandle "ok$\r$\n"
  FileClose $fixtureHandle
  SetErrorLevel 0
  Goto fixture_complete
  fixture_failed:
    SetErrorLevel 7
    Quit
  fixture_complete:
SectionEnd
`,
    )
    requireSuccess(binary.path, ['-WX', '-V2', '-INPUTCHARSET', 'UTF8', controlSource], {
      env: { ...process.env, ...binary.env },
    })
    const largePayload = path.join(scratch, 'large-trusted-payload')
    fs.cpSync(payload, largePayload, { recursive: true })
    const largeBytes = Buffer.alloc(64 * 1024 * 1024)
    for (let i = 0; i < largeBytes.length; i++) {
      state ^= state << 13
      state ^= state >>> 17
      state ^= state << 5
      largeBytes[i] = state & 0xff
    }
    fs.writeFileSync(path.join(largePayload, 'large.bin'), largeBytes)
    fixPayloadTimes(largePayload)
    const largeArchive = archive(largePayload, 'large-good.7z')
    const largeExecutable = path.join(scratch, 'large-fixture.exe')
    const largeSource = path.join(scratch, 'large-fixture.nsi')
    fs.writeFileSync(
      largeSource,
      fs
        .readFileSync(source, 'utf8')
        .replace(
          `OutFile "${nsisString(executable)}"`,
          () => `OutFile "${nsisString(largeExecutable)}"`,
        )
        .replace(
          `!define APP_64 "${nsisString(good)}"`,
          () => `!define APP_64 "${nsisString(largeArchive)}"`,
        ),
    )
    requireSuccess(binary.path, ['-WX', '-V2', '-INPUTCHARSET', 'UTF8', largeSource], {
      env: { ...process.env, ...binary.env },
    })
    if (process.platform !== 'win32') {
      console.log(
        'Real NSIS payload, unchanged stock-control and large-interruption fixtures compiled; CRC and truncated archives rejected. Native runtime assertions require Windows.',
      )
      return
    }

    let trials = 0
    const nativeTemp = path.join(scratch, 'native-temp')
    fs.mkdirSync(nativeTemp)
    function execute(
      name,
      mode,
      target,
      expected,
      filename = good,
      succeeds = true,
      nativeExecutable = executable,
      fixtureEnvironment = {},
    ) {
      trials++
      const report = path.join(scratch, `${name}.result`)
      const trace = path.join(scratch, `${name}.trace.tsv`)
      const result = run(nativeExecutable, ['/S'], {
        env: {
          ...process.env,
          TEMP: nativeTemp,
          TMP: nativeTemp,
          LIFE_NSIS_PAYLOAD_FIXTURE_MODE: mode,
          LIFE_NSIS_PAYLOAD_FIXTURE_TARGET: target,
          LIFE_NSIS_PAYLOAD_FIXTURE_EXPECTED: String(expected),
          LIFE_NSIS_PAYLOAD_FIXTURE_RESULT: report,
          LIFE_NSIS_PAYLOAD_FIXTURE_ARCHIVE: filename,
          LIFE_NSIS_TRACE_FILE: trace,
          ...fixtureEnvironment,
        },
      })
      if (succeeds) {
        assert.equal(
          result.status,
          0,
          `${name}: native assertions failed (${result.status})\n${result.stdout}\n${result.stderr}`,
        )
        assert.equal(
          fs.readFileSync(report, 'utf8'),
          'ok\r\n',
          `${name}: assertions did not complete`,
        )
      } else {
        assert.equal(
          result.status,
          2,
          `${name}: invalid payload must exit with the verification failure code`,
        )
        assert.equal(
          fs.existsSync(report),
          false,
          `${name}: invalid payload reached successful completion`,
        )
      }
      for (const action of ['registered', 'launched']) {
        assert.equal(
          fs.existsSync(`${report}.${action}`),
          mode.startsWith('extract') && succeeds,
          `${name}: ${action} sentinel has the wrong fail-closed state`,
        )
      }
      if (!fs.existsSync(trace)) return []
      let previous = 0
      return fs
        .readFileSync(trace, 'ascii')
        .trim()
        .split(/\r?\n/)
        .map((line) => {
          assert.match(line, /^[a-z-]+\t\d+$/, `${name}: malformed native trace marker`)
          const [phase, value] = line.split('\t')
          const uptime = Number(value)
          assert.ok(
            Number.isSafeInteger(uptime) && uptime > 0 && uptime >= previous,
            `${name}: native trace uptime must be positive and monotonic`,
          )
          previous = uptime
          return phase
        })
    }

    function directory(name, copyPayload = false) {
      const target = path.join(scratch, name)
      if (copyPayload) fs.cpSync(payload, target, { recursive: true })
      else fs.mkdirSync(target)
      return target
    }

    const metadataSource = path.join(scratch, 'metadata.ps1')
    fs.writeFileSync(metadataSource, '\ufeff' + metadataScript)
    const startupSource = path.join(scratch, 'powershell-startup.ps1')
    const startupOutput = path.join(scratch, 'powershell-startup.json')
    const poisonModules = directory('poisoned-powershell-modules')
    const poisonSecurity = path.join(poisonModules, 'Microsoft.PowerShell.Security')
    fs.mkdirSync(poisonSecurity)
    const poisonSentinel = 'LIFE_PS_MODULE_PATH_POISON_v1'
    fs.writeFileSync(path.join(poisonSecurity, 'poison.psm1'), `throw '${poisonSentinel}'\n`)
    fs.writeFileSync(
      path.join(poisonSecurity, 'Microsoft.PowerShell.Security.psd1'),
      String.raw`@{
  RootModule = 'poison.psm1'
  ModuleVersion = '99.0.0'
  GUID = '2e1cde56-39f2-43b1-b61c-d059cb469e10'
  FunctionsToExport = @('Get-Acl')
}
`,
    )
    fs.writeFileSync(
      startupSource,
      '\ufeff' +
        String.raw`$ErrorActionPreference = 'Stop'
Set-StrictMode -Version Latest
try {
  if ($PSVersionTable.PSVersion.Major -ne 5 -or $PSVersionTable.PSEdition -ne 'Desktop') { throw 'The fixture requires native Windows PowerShell 5.' }
  Import-Module Microsoft.PowerShell.Security -ErrorAction Stop
  Import-Module Microsoft.PowerShell.Utility -ErrorAction Stop
  $acl = Get-Acl -LiteralPath $env:LIFE_PS_STARTUP_DIRECTORY
  if ($acl -isnot [Security.AccessControl.DirectorySecurity]) { throw 'Get-Acl did not return the native .NET directory security object.' }
  $hash = Get-FileHash -LiteralPath $env:LIFE_PS_STARTUP_FILE -Algorithm SHA256
  $records = @()
  foreach ($name in @('Get-Acl', 'Get-FileHash', 'ConvertTo-Json')) {
    $command = Get-Command $name -ErrorAction Stop
    $expected = $(if ($name -eq 'Get-Acl') { 'Microsoft.PowerShell.Security' } else { 'Microsoft.PowerShell.Utility' })
    if ($command.ModuleName -cne $expected) { throw ('Unexpected native module for ' + $name) }
    $expectedBase = [IO.Path]::GetFullPath([IO.Path]::Combine($PSHOME, 'Modules', $expected))
    $nativeHome = [IO.Path]::GetFullPath($PSHOME)
    $actualBase = [IO.Path]::GetFullPath($command.Module.ModuleBase)
    if (-not $actualBase.Equals($expectedBase, [StringComparison]::OrdinalIgnoreCase) -and -not $actualBase.Equals($nativeHome, [StringComparison]::OrdinalIgnoreCase)) { throw ('Unexpected native module base for ' + $name + ': ' + $actualBase) }
    $actualPath = [IO.Path]::GetFullPath($command.Module.Path)
    if (-not $actualPath.StartsWith(($nativeHome + '\'), [StringComparison]::OrdinalIgnoreCase)) { throw ('Unexpected native module path for ' + $name + ': ' + $actualPath) }
    $records += [PSCustomObject]@{ Command = $name; Module = $expected; ModuleBase = $actualBase; ModulePath = $actualPath }
  }
  $json = ConvertTo-Json -InputObject ([PSCustomObject]@{ Major = $PSVersionTable.PSVersion.Major; Edition = $PSVersionTable.PSEdition; Sha256 = $hash.Hash.ToLowerInvariant(); Modules = $records }) -Depth 4 -Compress
  [IO.File]::WriteAllText($env:LIFE_PS_STARTUP_OUTPUT, $json, [Text.UTF8Encoding]::new($false))
} catch {
  [Console]::Error.WriteLine($_.Exception.ToString())
  exit 9
}
`,
    )
    const beforeProcessEnvironment = { ...process.env }
    const poisonedCallerEnvironment = {
      ...windowsPowerShellEnvironment(process.env),
      TEMP: nativeTemp,
      TMP: nativeTemp,
      LIFE_PS_STARTUP_DIRECTORY: payload,
      LIFE_PS_STARTUP_FILE: path.join(payload, 'payload.bin'),
      LIFE_PS_STARTUP_OUTPUT: startupOutput,
      PSModulePath: poisonModules,
    }
    const beforeCallerEnvironment = { ...poisonedCallerEnvironment }
    const startupArgs = [
      '-NoProfile',
      '-NonInteractive',
      '-ExecutionPolicy',
      'Bypass',
      '-File',
      startupSource,
    ]
    const poisonedStartup = run('powershell.exe', startupArgs, { env: poisonedCallerEnvironment })
    assert.equal(
      poisonedStartup.status,
      9,
      'Unsanitized child must resolve and reject the fixture-owned poisoned module',
    )
    assert.ok(
      (poisonedStartup.stdout + poisonedStartup.stderr).includes(poisonSentinel),
      'Negative child must fail through the actual poisoned module import',
    )
    assert.equal(
      fs.existsSync(startupOutput),
      false,
      'Poisoned child must not produce a successful startup result',
    )
    const mixedCaseCallerEnvironment = {
      ...poisonedCallerEnvironment,
      psmodulepath: poisonModules,
      PsMoDuLePaTh: poisonModules,
    }
    const beforeMixedCaseEnvironment = { ...mixedCaseCallerEnvironment }
    const startupEnvironment = windowsPowerShellEnvironment(mixedCaseCallerEnvironment)
    assert.equal(
      Object.keys(startupEnvironment).some((key) => key.toUpperCase() === 'PSMODULEPATH'),
      false,
      'Child environment must remove every casing of PSModulePath',
    )
    requireSuccess('powershell.exe', startupArgs, { env: startupEnvironment })
    const startup = JSON.parse(fs.readFileSync(startupOutput, 'utf8'))
    assert.equal(startup.Major, 5)
    assert.equal(startup.Edition, 'Desktop')
    assert.equal(startup.Sha256, sha256(path.join(payload, 'payload.bin')))
    assert.deepEqual(
      startup.Modules.map((entry) => entry.Command),
      ['Get-Acl', 'Get-FileHash', 'ConvertTo-Json'],
    )
    assert.deepEqual(
      poisonedCallerEnvironment,
      beforeCallerEnvironment,
      'Startup probe must preserve its caller environment object',
    )
    assert.deepEqual(
      mixedCaseCallerEnvironment,
      beforeMixedCaseEnvironment,
      'Sanitization must preserve every original environment key/value',
    )
    assert.deepEqual(
      { ...process.env },
      beforeProcessEnvironment,
      'Startup probe must preserve the process environment',
    )
    console.log(
      'Native Windows PowerShell startup probe passed: poisoned inherited module rejected, sanitized child loaded native Security/Utility cmdlets, and caller environment remained unchanged.',
    )
    function metadata(name, target, action = 'snapshot') {
      const output = path.join(scratch, `${name}.metadata.json`)
      requireSuccess(
        'powershell.exe',
        ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', metadataSource],
        {
          env: windowsPowerShellEnvironment({
            ...process.env,
            TEMP: nativeTemp,
            TMP: nativeTemp,
            LIFE_NSIS_METADATA_ROOT: target,
            LIFE_NSIS_METADATA_OUTPUT: output,
            LIFE_NSIS_METADATA_ACTION: action,
          }),
        },
      )
      const records = JSON.parse(fs.readFileSync(output, 'utf8'))
      assert.ok(
        Array.isArray(records) && records.length > 0,
        'Native metadata snapshot must contain the target root',
      )
      return records.map((record) => {
        if (record.Relative === '') delete record.DirectoryLastWriteUtcTicksInformational
        return record
      })
    }

    for (const custom of [false, true]) {
      const label = custom ? 'custom-acl' : 'default-acl'
      const directTarget = directory(`metadata-direct-${label}`)
      const controlTarget = directory(`metadata-control-${label}`)
      const beforeDirect = metadata(
        `metadata-direct-${label}-before`,
        directTarget,
        custom ? 'customize' : 'snapshot',
      )
      const beforeControl = metadata(
        `metadata-control-${label}-before`,
        controlTarget,
        custom ? 'customize' : 'snapshot',
      )
      const directMetadataPhases = execute(`metadata-direct-${label}`, 'extract', directTarget, 1)
      assert.ok(
        directMetadataPhases.includes('payload-direct-start'),
        `${label}: metadata comparison must exercise direct extraction`,
      )
      execute(
        `metadata-control-${label}`,
        'extract',
        controlTarget,
        1,
        good,
        true,
        controlExecutable,
      )
      const afterDirect = metadata(`metadata-direct-${label}-after`, directTarget)
      const afterControl = metadata(`metadata-control-${label}-after`, controlTarget)
      assert.deepEqual(
        afterDirect,
        afterControl,
        `${label}: direct extraction must preserve stock hashes, SID ACLs, inheritance, owner/group, ordinary attributes, archived mtimes and ADS`,
      )
      assert.deepEqual(
        afterDirect.find((entry) => entry.Relative === ''),
        beforeDirect[0],
        `${label}: direct extraction must preserve the existing target root ACL, owner, attributes and ADS`,
      )
      assert.deepEqual(
        afterControl.find((entry) => entry.Relative === ''),
        beforeControl[0],
        `${label}: stock control must preserve the existing target root metadata`,
      )
      assert.deepEqual(
        inventory(directTarget),
        inventory(payload),
        `${label}: direct payload must remain exact`,
      )
      assert.deepEqual(
        inventory(controlTarget),
        inventory(payload),
        `${label}: stock payload control must remain exact`,
      )
      if (custom) {
        assert.equal(
          beforeDirect[0].DaclProtected,
          true,
          'Custom target ACL must be protected before extraction',
        )
        assert.ok(
          beforeDirect[0].Streams.some((stream) => stream.Name === 'life-fixture-root'),
          'Custom empty target must contain the root ADS preservation sentinel',
        )
      }
    }

    const ordinary = directory('guard-ordinary-empty')
    execute('guard-empty', 'guard', ordinary, 1)
    execute('guard-missing', 'guard', path.join(scratch, 'guard-missing'), 2)
    execute('guard-regular-file', 'guard', path.join(payload, 'payload.bin'), 2)
    const nonemptyFile = directory('guard-nonempty-file')
    fs.writeFileSync(path.join(nonemptyFile, 'keep.txt'), 'Keep this file\n')
    execute('guard-nonempty-file', 'guard', nonemptyFile, 0)
    const nonemptyDirectory = directory('guard-nonempty-directory')
    fs.mkdirSync(path.join(nonemptyDirectory, 'child'))
    execute('guard-nonempty-directory', 'guard', nonemptyDirectory, 0)
    const junction = path.join(scratch, 'guard-junction')
    fs.symlinkSync(ordinary, junction, 'junction')
    execute('guard-junction', 'guard', junction, 2)
    const ancestorTarget = directory('guard-ancestor-target')
    fs.mkdirSync(path.join(ancestorTarget, 'child'))
    const ancestorJunction = path.join(scratch, 'guard-ancestor-junction')
    fs.symlinkSync(ancestorTarget, ancestorJunction, 'junction')
    execute('guard-junction-ancestor', 'guard', path.join(ancestorJunction, 'child'), 2)
    const compressed = directory('guard-compressed')
    requireSuccess('compact.exe', ['/c', '/i', '/q', compressed])
    execute('guard-compressed', 'guard', compressed, 0)

    const verificationCases = []
    function verificationCase(name, mutate, required, exact, preflight = 1) {
      const target = directory(`verify-${name}`, true)
      mutate?.(target)
      verificationCases.push({ name, target, required, exact, preflight })
    }
    verificationCase('good', undefined, 1, 1)
    verificationCase(
      'same-size-tamper',
      (target) => {
        const tampered = Buffer.from(bytes)
        tampered[Math.floor(bytes.length / 2)] ^= 0x80
        fs.writeFileSync(path.join(target, 'payload.bin'), tampered)
      },
      0,
      0,
    )
    verificationCase('missing', (target) => fs.rmSync(path.join(target, 'payload.bin')), 0, 0)
    verificationCase(
      'missing-empty-directory',
      (target) => fs.rmdirSync(path.join(target, 'empty')),
      0,
      0,
    )
    verificationCase(
      'short',
      (target) => fs.writeFileSync(path.join(target, 'payload.bin'), bytes.subarray(0, -1)),
      0,
      0,
    )
    verificationCase(
      'extra-file',
      (target) => fs.writeFileSync(path.join(target, 'extra.txt'), 'retained\n'),
      1,
      0,
    )
    verificationCase(
      'hidden-extra-file',
      (target) => {
        const filename = path.join(target, 'hidden-extra.txt')
        fs.writeFileSync(filename, 'Hidden unrelated data\n')
        requireSuccess('attrib.exe', ['+h', filename])
      },
      1,
      0,
    )
    verificationCase(
      'extra-subdirectory',
      (target) => fs.mkdirSync(path.join(target, 'extra-directory')),
      1,
      0,
    )
    verificationCase(
      'nested-extra-file',
      (target) => fs.writeFileSync(path.join(target, 'nested', 'extra.txt'), 'retained\n'),
      1,
      0,
    )
    verificationCase(
      'file-is-directory',
      (target) => {
        fs.rmSync(path.join(target, 'payload.bin'))
        fs.mkdirSync(path.join(target, 'payload.bin'))
      },
      0,
      0,
      0,
    )
    verificationCase(
      'nested-junction',
      (target) => {
        fs.rmSync(path.join(target, 'nested'), { recursive: true })
        fs.symlinkSync(path.join(payload, 'nested'), path.join(target, 'nested'), 'junction')
      },
      0,
      0,
      0,
    )
    const rootJunction = path.join(scratch, 'verify-root-junction')
    fs.symlinkSync(payload, rootJunction, 'junction')
    verificationCases.push({
      name: 'root-junction',
      target: rootJunction,
      required: 0,
      exact: 0,
      preflight: 0,
    })
    verificationCases.push({
      name: 'missing-directory',
      target: path.join(scratch, 'verify-missing-directory'),
      required: 0,
      exact: 0,
      preflight: 0,
    })
    for (const item of verificationCases) {
      execute(`required-${item.name}`, 'required', item.target, item.required)
      execute(`exact-${item.name}`, 'exact', item.target, item.exact)
      execute(`preflight-${item.name}`, 'preflight', item.target, item.preflight)
    }
    execute('preflight-empty', 'preflight', ordinary, 1)

    const direct = directory('extract-direct')
    const directPhases = execute('extract-direct', 'extract', direct, 1)
    assert.deepEqual(
      directPhases,
      [
        'payload-direct-start',
        'extract-start',
        'extract-complete',
        'payload-verification-start',
        'payload-verification-complete',
        'payload-direct-complete',
        'payload-complete',
        'installer-success',
      ],
      'Direct extraction must verify before successful completion in the real installer',
    )
    assert.ok(
      directPhases.includes('payload-direct-start') &&
        directPhases.includes('payload-direct-complete'),
    )
    assert.equal(
      directPhases.includes('payload-copy-start'),
      false,
      'Empty targets must bypass payload copying',
    )
    assert.deepEqual(
      inventory(direct),
      inventory(payload),
      'Direct extraction must install the exact trusted tree',
    )
    const staged = directory('extract-staged')
    fs.writeFileSync(path.join(staged, 'payload.bin'), 'Old payload\n')
    const stagedPhases = execute('extract-staged', 'extract', staged, 1)
    assert.deepEqual(
      stagedPhases,
      [
        'extract-start',
        'payload-verification-start',
        'payload-verification-complete',
        'extract-complete',
        'payload-copy-start',
        'payload-copy-complete',
        'payload-verification-start',
        'payload-verification-complete',
        'payload-complete',
        'installer-success',
      ],
      'Stock extraction must verify both its exact stage and final required files',
    )
    assert.equal(
      stagedPhases.includes('payload-direct-start'),
      false,
      'Nonempty targets must retain stock extraction',
    )
    assert.ok(
      stagedPhases.includes('payload-copy-start') && stagedPhases.includes('payload-copy-complete'),
    )
    assert.deepEqual(
      inventory(staged),
      inventory(payload),
      'Stock extraction must replace required payload files',
    )
    const retained = directory('extract-retained-extras')
    fs.writeFileSync(path.join(retained, 'unrelated.txt'), 'Retain unrelated data\n')
    fs.mkdirSync(path.join(retained, 'unrelated-directory'))
    const unrelatedOutside = directory('unrelated-junction-destination')
    fs.writeFileSync(
      path.join(unrelatedOutside, 'sentinel.txt'),
      'Outside unrelated link remains intact\n',
    )
    const unrelatedBefore = inventory(unrelatedOutside)
    fs.symlinkSync(unrelatedOutside, path.join(retained, 'unrelated-junction'), 'junction')
    execute('extract-retained-extras', 'extract', retained, 1)
    assert.equal(
      fs.readFileSync(path.join(retained, 'unrelated.txt'), 'utf8'),
      'Retain unrelated data\n',
    )
    assert.ok(fs.statSync(path.join(retained, 'unrelated-directory')).isDirectory())
    assert.ok(fs.lstatSync(path.join(retained, 'unrelated-junction')).isSymbolicLink())
    assert.deepEqual(
      inventory(unrelatedOutside),
      unrelatedBefore,
      'Stock copy must not traverse unrelated links',
    )
    execute('required-retained-extras', 'required', retained, 1)
    execute('exact-retained-extras', 'exact', retained, 0)
    const outsidePayload = directory('extract-outside-payload', true)
    const outsideBefore = inventory(outsidePayload)
    const extractRootJunction = path.join(scratch, 'extract-root-junction')
    fs.symlinkSync(outsidePayload, extractRootJunction, 'junction')
    assert.deepEqual(
      execute('extract-root-junction', 'extract', extractRootJunction, 0, good, false),
      [],
      'Root junction must be rejected before extraction or copying',
    )
    assert.deepEqual(
      inventory(outsidePayload),
      outsideBefore,
      'Rejected root junction must not change its destination',
    )
    const outsideAncestor = directory('extract-outside-ancestor')
    fs.mkdirSync(path.join(outsideAncestor, 'child'))
    fs.writeFileSync(
      path.join(outsideAncestor, 'sentinel.txt'),
      'Outside ancestor remains intact\n',
    )
    const outsideAncestorBefore = inventory(outsideAncestor)
    const extractAncestorJunction = path.join(scratch, 'extract-ancestor-junction')
    fs.symlinkSync(outsideAncestor, extractAncestorJunction, 'junction')
    assert.deepEqual(
      execute(
        'extract-ancestor-junction',
        'extract',
        path.join(extractAncestorJunction, 'child'),
        0,
        good,
        false,
      ),
      [],
      'Junction ancestor must be rejected before extraction or copying',
    )
    assert.deepEqual(
      inventory(outsideAncestor),
      outsideAncestorBefore,
      'Rejected junction ancestor must not change its destination',
    )
    const extractNested = directory('extract-nested-junction')
    fs.symlinkSync(
      path.join(outsidePayload, 'nested'),
      path.join(extractNested, 'nested'),
      'junction',
    )
    assert.deepEqual(
      execute('extract-nested-junction', 'extract', extractNested, 0, good, false),
      [],
      'Expected-directory junction must be rejected before extraction or copying',
    )
    assert.deepEqual(
      inventory(outsidePayload),
      outsideBefore,
      'Rejected expected-directory junction must not change its destination',
    )
    for (const [name, filename] of [
      ['crc', corrupt],
      ['truncated', truncated],
      ['short-valid-crc', short],
    ]) {
      const target = directory(`extract-invalid-${name}`)
      const phases = execute(`extract-invalid-${name}`, 'extract', target, 0, filename, false)
      assert.ok(
        phases.includes('payload-direct-fallback'),
        `${name}: direct failure must enter the verified stock fallback`,
      )
      assert.equal(
        phases.includes('payload-complete'),
        false,
        `${name}: unverified payload must never complete`,
      )
    }
    const locked = directory('extract-locked')
    fs.writeFileSync(path.join(locked, 'payload.bin'), 'Locked old payload\n')
    const lockedPhases = execute('extract-locked', 'extract-locked', locked, 0, good, false)
    assert.equal(fs.readFileSync(path.join(locked, 'payload.bin'), 'utf8'), 'Locked old payload\n')
    assert.ok(
      lockedPhases.includes('extract-fallback-start'),
      'Busy output must retain the stock retry/fallback path',
    )
    assert.equal(
      lockedPhases.includes('payload-complete'),
      false,
      'Busy output must not bypass installed-payload verification',
    )

    const interrupted = directory('extract-interrupted')
    const appData = directory('interruption-appdata')
    const roamingAppData = path.join(appData, 'Roaming')
    const localAppData = path.join(appData, 'Local')
    fs.mkdirSync(roamingAppData)
    fs.mkdirSync(localAppData)
    fs.writeFileSync(path.join(roamingAppData, 'preferences.json'), '{"retained":true}\n')
    fs.writeFileSync(path.join(roamingAppData, 'sessions.json'), '["retained-session"]\n')
    fs.writeFileSync(path.join(localAppData, 'notes.txt'), 'Retain AppData through interruption\n')
    const appDataBefore = inventory(appData)
    const interruptionOutsideBefore = inventory(outsidePayload)
    const interruptionReport = path.join(scratch, 'interruption.result')
    const interruptionTrace = path.join(scratch, 'interruption.trace.tsv')
    const interruption = await interruptActualExtraction({
      executable: largeExecutable,
      env: {
        ...process.env,
        TEMP: nativeTemp,
        TMP: nativeTemp,
        APPDATA: roamingAppData,
        LOCALAPPDATA: localAppData,
        LIFE_NSIS_PAYLOAD_FIXTURE_MODE: 'extract',
        LIFE_NSIS_PAYLOAD_FIXTURE_TARGET: interrupted,
        LIFE_NSIS_PAYLOAD_FIXTURE_EXPECTED: '1',
        LIFE_NSIS_PAYLOAD_FIXTURE_RESULT: interruptionReport,
        LIFE_NSIS_PAYLOAD_FIXTURE_ARCHIVE: largeArchive,
        LIFE_NSIS_TRACE_FILE: interruptionTrace,
      },
      target: interrupted,
      report: interruptionReport,
      trace: interruptionTrace,
      expectedSize: largeBytes.length,
      expectedPrefix: largeBytes.subarray(0, 4096),
      expectedTail: largeBytes.subarray(largeBytes.length - 4096),
      expectedSha256: sha256(path.join(largePayload, 'large.bin')),
    })
    execute('guard-interrupted', 'guard', interrupted, 0)
    const recoveredPhases = execute(
      'extract-interrupted-retry',
      'extract',
      interrupted,
      1,
      largeArchive,
      true,
      largeExecutable,
      { APPDATA: roamingAppData, LOCALAPPDATA: localAppData },
    )
    assert.equal(
      recoveredPhases.includes('payload-direct-start'),
      false,
      'A genuinely partial target must retain stock staging and copying on retry',
    )
    assert.deepEqual(
      recoveredPhases,
      stagedPhases,
      'Interrupted reinstall must verify the stock stage and final required payload',
    )
    assert.deepEqual(
      inventory(interrupted),
      inventory(largePayload),
      'Reinstall must completely repair the interrupted payload',
    )
    assert.deepEqual(
      inventory(appData),
      appDataBefore,
      'Interruption and reinstall must preserve AppData fixture hashes',
    )
    assert.deepEqual(
      inventory(outsidePayload),
      interruptionOutsideBefore,
      'Interruption and reinstall must preserve outside fixture hashes',
    )
    console.log(
      `Native interruption proof: actual extractor PID ${interruption.pid}, preallocated ${interruption.finalSize} bytes, written prefix and unwritten tail observed before kill and retained after process exit; stock reinstall restored every trusted hash.`,
    )
    console.log(
      `Real Windows NSIS payload fixture passed ${trials} trials plus actual in-progress interruption: full hashes and exact inventory, all 20 registers, stack, set/clear errors, handle preservation, reparse/compressed guard, unchanged stock metadata parity, custom ACL/ADS preservation, direct and stock extraction, CRC/truncated/short archives, retained extras, busy-file fail-closed behavior and verified interruption recovery.`,
    )
  } finally {
    fs.rmSync(scratch, { recursive: true, force: true })
  }
}

main().catch((error) => {
  console.error(error)
  process.exitCode = 1
})
