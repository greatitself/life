param(
    [string]$OutputPath = 'output/windows-installer-process-proof.json',
    [string]$NsisPath
)

# Native fixtures run only in the disposable runner used to build the installer.
Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'
if (-not $IsWindows -or $env:GITHUB_ACTIONS -ne 'true') {
    throw 'Run the native installer process fixtures only on a disposable GitHub Actions Windows runner.'
}

$repository = [IO.Path]::GetFullPath((Join-Path $PSScriptRoot '..'))
$modulePath = Join-Path $repository 'build/installer-process.nsh'
$moduleSource = Get-Content -Raw -LiteralPath $modulePath
$proofPath = [IO.Path]::GetFullPath($OutputPath)
$fixtureRoot = Join-Path ([IO.Path]::GetTempPath()) ('life-process-fixture-' + [Guid]::NewGuid().ToString('N'))
$results = [Collections.Generic.List[object]]::new()
$ownedProcesses = [Collections.Generic.List[Diagnostics.Process]]::new()
$proof = [ordered]@{
    ok = $false
    platform = 'win32'
    moduleSha256 = (Get-FileHash -Algorithm SHA256 -LiteralPath $modulePath).Hash.ToLowerInvariant()
    cases = @()
}

function Invoke-Native([string]$Executable, [string[]]$Arguments, [hashtable]$Environment = @{}, [int]$TimeoutMilliseconds = 30000) {
    $start = [Diagnostics.ProcessStartInfo]::new()
    $start.FileName = $Executable
    $start.UseShellExecute = $false
    $start.RedirectStandardOutput = $true
    $start.RedirectStandardError = $true
    foreach ($argument in $Arguments) { $start.ArgumentList.Add($argument) }
    foreach ($entry in $Environment.GetEnumerator()) {
        if ($null -eq $entry.Value) { [void]$start.Environment.Remove($entry.Key) }
        else { $start.Environment[$entry.Key] = [string]$entry.Value }
    }
    $process = [Diagnostics.Process]::new()
    $process.StartInfo = $start
    try {
        if (-not $process.Start()) { throw "Could not start $Executable" }
        $stdout = $process.StandardOutput.ReadToEndAsync()
        $stderr = $process.StandardError.ReadToEndAsync()
        if (-not $process.WaitForExit($TimeoutMilliseconds)) {
            $process.Kill($true)
            $process.WaitForExit()
            throw "Native fixture exceeded its timeout: $Executable"
        }
        return [pscustomobject]@{
            exitCode = $process.ExitCode
            stdout = $stdout.GetAwaiter().GetResult()
            stderr = $stderr.GetAwaiter().GetResult()
        }
    } finally { $process.Dispose() }
}

function Assert-Fixture([bool]$Condition, [string]$Message) {
    if (-not $Condition) { throw $Message }
}

function Write-Utf8([string]$Path, [string]$Content) {
    [IO.File]::WriteAllText($Path, $Content, [Text.UTF8Encoding]::new($false))
}

function Get-Compiler {
    if ($NsisPath) {
        $resolved = (Resolve-Path -LiteralPath $NsisPath).Path
        if (Test-Path -LiteralPath $resolved -PathType Container) {
            foreach ($relative in @('Bin/makensis.exe', 'makensis.exe', 'windows/makensis.exe')) {
                $candidate = Join-Path $resolved $relative
                if (Test-Path -LiteralPath $candidate -PathType Leaf) {
                    return [pscustomobject]@{ path = $candidate; environment = (Get-NsisEnvironment $candidate) }
                }
            }
            throw "No native makensis.exe was found in $resolved"
        }
        return [pscustomobject]@{ path = $resolved; environment = (Get-NsisEnvironment $resolved) }
    }
    $resolver = Join-Path $fixtureRoot 'resolve-nsis.cjs'
    Write-Utf8 $resolver @'
const path = require('node:path');
const root = process.argv[2];
const pkg = require(path.join(root, 'package.json'));
require(path.join(root, 'node_modules/app-builder-lib/out/toolsets/windows.js'))
  .getMakeNsisPath(pkg.build?.toolsets?.nsis, pkg.build?.nsis?.customNsisBinary)
  .then(result => process.stdout.write(JSON.stringify(result)))
  .catch(error => { console.error(error); process.exitCode = 1; });
'@
    $resolved = Invoke-Native 'node' @($resolver, $repository) @{} 120000
    Assert-Fixture ($resolved.exitCode -eq 0) "Could not resolve the installer's NSIS compiler: $($resolved.stderr)"
    $compiler = $resolved.stdout | ConvertFrom-Json -AsHashtable
    $environment = @{}
    if ($compiler.ContainsKey('env')) {
        foreach ($entry in $compiler.env.GetEnumerator()) { $environment[$entry.Key] = $entry.Value }
    }
    Assert-Fixture ($compiler.path -like '*.exe') 'These fixtures require the same native legacy makensis.exe used by the installer.'
    return [pscustomobject]@{ path = [string]$compiler.path; environment = $environment }
}

function Get-NsisEnvironment([string]$Executable) {
    $directory = Split-Path $Executable -Parent
    foreach ($candidate in @($directory, (Split-Path $directory -Parent))) {
        if (Test-Path -LiteralPath (Join-Path $candidate 'Include') -PathType Container) {
            return @{ NSISDIR = $candidate }
        }
    }
    throw "Cannot locate the native NSIS Include directory beside $Executable"
}

function New-Harness([string]$Name, [bool]$ProtocolHost) {
    $directory = Join-Path $fixtureRoot $Name
    [void][IO.Directory]::CreateDirectory($directory)
    $sourcePath = Join-Path $directory 'fixture.nsi'
    $executable = Join-Path $directory 'fixture.exe'
    $override = if ($ProtocolHost) { '!define LIFE_PROCESS_PROBE_EXECUTABLE "$EXEDIR\probe-host.exe"' } else { '' }
    # All installation-path and protocol test data enters the native caller as
    # environment values; no fixture path is interpolated into PowerShell code.
    $source = @'
Unicode true
RequestExecutionLevel user
SilentInstall silent
AutoCloseWindow true
Name "Life process probe fixture"
OutFile "__OUTPUT__"
!addincludedir "__MODULE_DIRECTORY__"
__OVERRIDE__
!include "installer-process.nsh"
Var FallbackAvailability
Var FallbackRunning
Var ActualProof
Var StackActual
Var DirectRegisters
Var WrapperRegisters
Var DirectStack
Var WrapperStack
Var DirectError
Var WrapperError
Var ExpectedError
Var PriorEnvironment
Var AfterEnvironment
Var EnvironmentPreserved
Var PriorLength
Var AfterLength
Var PriorLastError
Var AfterLastError
Var ResultPath
Var ResultHandle

!macro IS_POWERSHELL_AVAILABLE
  IntOp $FallbackAvailability $FallbackAvailability + 1
!macroend
!macro _CHECK_APP_RUNNING
  IntOp $FallbackRunning $FallbackRunning + 1
!macroend
!insertmacro LifeDefineProcessCheck

!macro SeedRegisters
  StrCpy $0 "register-0"
  StrCpy $1 "register-1"
  StrCpy $2 "register-2"
  StrCpy $3 "register-3"
  StrCpy $4 "register-4"
  StrCpy $5 "register-5"
  StrCpy $6 "register-6"
  StrCpy $7 "register-7"
  StrCpy $8 "register-8"
  StrCpy $9 "register-9"
  StrCpy $R0 "register-R0"
  StrCpy $R1 "register-R1"
  StrCpy $R2 "register-R2"
  StrCpy $R3 "register-R3"
  StrCpy $R4 "register-R4"
  StrCpy $R5 "register-R5"
  StrCpy $R6 "register-R6"
  StrCpy $R7 "register-R7"
  StrCpy $R8 "register-R8"
  StrCpy $R9 "register-R9"
!macroend
!macro CheckRegisters RESULT
  StrCpy ${RESULT} "1"
  ${If} $0 != "register-0"
  ${OrIf} $1 != "register-1"
  ${OrIf} $2 != "register-2"
  ${OrIf} $3 != "register-3"
  ${OrIf} $4 != "register-4"
  ${OrIf} $5 != "register-5"
  ${OrIf} $6 != "register-6"
  ${OrIf} $7 != "register-7"
  ${OrIf} $8 != "register-8"
  ${OrIf} $9 != "register-9"
  ${OrIf} $R0 != "register-R0"
  ${OrIf} $R1 != "register-R1"
  ${OrIf} $R2 != "register-R2"
  ${OrIf} $R3 != "register-R3"
  ${OrIf} $R4 != "register-R4"
  ${OrIf} $R5 != "register-R5"
  ${OrIf} $R6 != "register-R6"
  ${OrIf} $R7 != "register-R7"
  ${OrIf} $R8 != "register-R8"
  ${OrIf} $R9 != "register-R9"
    StrCpy ${RESULT} "0"
  ${EndIf}
!macroend
!macro SeedError
  ${If} $ExpectedError == "1"
    SetErrors
  ${Else}
    ClearErrors
  ${EndIf}
!macroend
!macro CaptureError RESULT
  IfErrors +3 0
  StrCpy ${RESULT} "0"
  Goto +2
  StrCpy ${RESULT} "1"
!macroend

Section
  ReadEnvStr $INSTDIR "LIFE_FIXTURE_TARGET"
  ReadEnvStr $ResultPath "LIFE_FIXTURE_OUTPUT"
  ReadEnvStr $ExpectedError "LIFE_FIXTURE_ERROR"
  StrCpy $FallbackAvailability "0"
  StrCpy $FallbackRunning "0"
  StrCpy $EnvironmentPreserved "1"
  System::Alloc 65536
  Pop $PriorEnvironment
  System::Alloc 65536
  Pop $AfterEnvironment
  System::Call 'kernel32::lstrcpyW(p $PriorEnvironment, w "") p .r0'
  System::Call 'kernel32::lstrcpyW(p $AfterEnvironment, w "") p .r0'
  System::Call 'kernel32::SetLastError(i 0)'
  System::Call 'kernel32::GetEnvironmentVariableW(w "${LIFE_PROCESS_PROBE_ENV}", p $PriorEnvironment, i 32768) i .r0 ?e'
  Pop $PriorLastError
  StrCpy $PriorLength $0

  !insertmacro SeedRegisters
  Push "direct-stack-sentinel"
  !insertmacro SeedError
  Call LifeNoScopedProcess
  Pop $ActualProof
  !insertmacro CaptureError $DirectError
  Pop $StackActual
  StrCpy $DirectStack "0"
  ${If} $StackActual == "direct-stack-sentinel"
    StrCpy $DirectStack "1"
  ${EndIf}
  !insertmacro CheckRegisters $DirectRegisters

  System::Call 'kernel32::SetLastError(i 0)'
  System::Call 'kernel32::GetEnvironmentVariableW(w "${LIFE_PROCESS_PROBE_ENV}", p $AfterEnvironment, i 32768) i .r0 ?e'
  Pop $AfterLastError
  StrCpy $AfterLength $0
  IntOp $0 $PriorLength + 1
  IntOp $1 $AfterLength + 1
  System::Call 'kernel32::CompareStringOrdinal(p $PriorEnvironment, i r0, p $AfterEnvironment, i r1, i 0) i .r0'
  ${If} $0 != 2
  ${OrIf} $PriorLength != $AfterLength
  ${OrIf} $PriorLastError != $AfterLastError
    StrCpy $EnvironmentPreserved "0"
  ${EndIf}

  !insertmacro SeedRegisters
  Push "wrapper-stack-sentinel"
  !insertmacro SeedError
  !insertmacro LifeCheckAppRunning
  !insertmacro CaptureError $WrapperError
  Pop $StackActual
  StrCpy $WrapperStack "0"
  ${If} $StackActual == "wrapper-stack-sentinel"
    StrCpy $WrapperStack "1"
  ${EndIf}
  !insertmacro CheckRegisters $WrapperRegisters
  System::Call 'kernel32::SetLastError(i 0)'
  System::Call 'kernel32::GetEnvironmentVariableW(w "${LIFE_PROCESS_PROBE_ENV}", p $AfterEnvironment, i 32768) i .r0 ?e'
  Pop $AfterLastError
  StrCpy $AfterLength $0
  IntOp $0 $PriorLength + 1
  IntOp $1 $AfterLength + 1
  System::Call 'kernel32::CompareStringOrdinal(p $PriorEnvironment, i r0, p $AfterEnvironment, i r1, i 0) i .r0'
  ${If} $0 != 2
  ${OrIf} $PriorLength != $AfterLength
  ${OrIf} $PriorLastError != $AfterLastError
    StrCpy $EnvironmentPreserved "0"
  ${EndIf}
  System::Free $AfterEnvironment
  System::Free $PriorEnvironment
  FileOpen $ResultHandle $ResultPath w
  FileWrite $ResultHandle "proof=$ActualProof$\r$\n"
  FileWrite $ResultHandle "fallbackAvailability=$FallbackAvailability$\r$\n"
  FileWrite $ResultHandle "fallbackRunning=$FallbackRunning$\r$\n"
  FileWrite $ResultHandle "directRegisters=$DirectRegisters$\r$\n"
  FileWrite $ResultHandle "wrapperRegisters=$WrapperRegisters$\r$\n"
  FileWrite $ResultHandle "directStack=$DirectStack$\r$\n"
  FileWrite $ResultHandle "wrapperStack=$WrapperStack$\r$\n"
  FileWrite $ResultHandle "directError=$DirectError$\r$\n"
  FileWrite $ResultHandle "wrapperError=$WrapperError$\r$\n"
  FileWrite $ResultHandle "environmentPreserved=$EnvironmentPreserved$\r$\n"
  FileClose $ResultHandle
  SetErrorLevel 0
SectionEnd
'@
    $source = $source.Replace('__OUTPUT__', $executable.Replace('$', '$$')).Replace('__MODULE_DIRECTORY__', (Split-Path $modulePath -Parent).Replace('$', '$$')).Replace('__OVERRIDE__', $override)
    Write-Utf8 $sourcePath $source
    $compile = Invoke-Native $compiler.path @('/WX', '/INPUTCHARSET', 'UTF8', '/V2', $sourcePath) $compiler.environment 120000
    Assert-Fixture ($compile.exitCode -eq 0 -and (Test-Path -LiteralPath $executable)) "NSIS process fixture compilation failed: $($compile.stdout) $($compile.stderr)"
    if ($ProtocolHost) { Copy-Item -LiteralPath $protocolExecutable -Destination (Join-Path $directory 'probe-host.exe') }
    return $executable
}

function Invoke-Harness([string]$Name, [string]$Executable, [string]$Target, [bool]$ExpectedProof, [hashtable]$Environment = @{}, [bool]$PriorError = $false) {
    $output = Join-Path $fixtureRoot ($Name + '.txt')
    $childEnvironment = @{
        LIFE_FIXTURE_TARGET = $Target
        LIFE_FIXTURE_OUTPUT = $output
        LIFE_FIXTURE_ERROR = $(if ($PriorError) { '1' } else { '0' })
        LIFE_NSIS_PROCESS_PROBE_TARGET = $null
    }
    foreach ($entry in $Environment.GetEnumerator()) { $childEnvironment[$entry.Key] = $entry.Value }
    $run = Invoke-Native $Executable @('/S') $childEnvironment 15000
    Assert-Fixture ($run.exitCode -eq 0 -and (Test-Path -LiteralPath $output)) "${Name}: native caller failed: $($run.exitCode) $($run.stderr)"
    $values = @{}
    foreach ($line in (Get-Content -LiteralPath $output)) {
        if ($line -match '^([^=]+)=(.*)$') { $values[$Matches[1]] = $Matches[2] }
    }
    $expected = if ($ExpectedProof) { '1' } else { '0' }
    Assert-Fixture ($values.proof -eq $expected) "${Name}: expected proof $expected, received $($values.proof)"
    $fallback = if ($ExpectedProof) { '0' } else { '1' }
    Assert-Fixture ($values.fallbackAvailability -eq $fallback -and $values.fallbackRunning -eq $fallback) "${Name}: the complete stock fallback was not selected correctly"
    foreach ($field in @('directRegisters', 'wrapperRegisters', 'directStack', 'wrapperStack', 'environmentPreserved')) {
        Assert-Fixture ($values[$field] -eq '1') "${Name}: $field was not preserved"
    }
    $expectedError = if ($PriorError) { '1' } else { '0' }
    Assert-Fixture ($values.directError -eq $expectedError -and $values.wrapperError -eq $expectedError) "${Name}: the caller's error flag was changed"
    $results.Add([pscustomobject]@{ name = $Name; kind = 'native-nsis'; ok = $true; proof = $ExpectedProof; stockFallback = -not $ExpectedProof; priorError = $PriorError; preservation = $values })
}

try {
    [void][IO.Directory]::CreateDirectory($fixtureRoot)
    $compiler = Get-Compiler
    $proof.nsisExecutable = $compiler.path
    $proof.nsisExecutableSha256 = (Get-FileHash -Algorithm SHA256 -LiteralPath $compiler.path).Hash.ToLowerInvariant()
    $header = Invoke-Native $compiler.path @('/HDRINFO') $compiler.environment
    $stringLimit = [regex]::Match($header.stdout, '(?:^|,)NSIS_MAX_STRLEN=(\d+)')
    Assert-Fixture ($header.exitCode -eq 0 -and $stringLimit.Success) 'Could not determine the actual native NSIS string limit.'
    $proof.nsisMaximumStringLength = [int]$stringLimit.Groups[1].Value
    Assert-Fixture ($proof.nsisMaximumStringLength -gt 0 -and $proof.nsisMaximumStringLength -lt 16384) 'The oversized fixtures must exceed the actual NSIS string limit.'
    $csc = Join-Path $env:WINDIR 'Microsoft.NET/Framework64/v4.0.30319/csc.exe'
    if (-not (Test-Path -LiteralPath $csc)) { $csc = Join-Path $env:WINDIR 'Microsoft.NET/Framework/v4.0.30319/csc.exe' }
    Assert-Fixture (Test-Path -LiteralPath $csc) 'The native protocol fixtures need the runner Windows Framework C# compiler.'
    $protocolSource = Join-Path $fixtureRoot 'probe-host.cs'
    $protocolExecutable = Join-Path $fixtureRoot 'probe-host.exe'
    Write-Utf8 $protocolSource @'
using System;
using System.IO;
using System.Threading;
class ProbeHost {
    static int Main(string[] args) {
        if (args.Length == 1 && args[0] == "hold") { Thread.Sleep(60000); return 0; }
        string callLog = Environment.GetEnvironmentVariable("LIFE_FIXTURE_PROBE_CALL_LOG");
        if (!String.IsNullOrEmpty(callLog)) { File.AppendAllText(callLog, "called\n"); }
        string mode = Environment.GetEnvironmentVariable("LIFE_FIXTURE_PROBE_MODE");
        const string marker = "LIFE_NO_SCOPED_PROCESS_V1";
        switch (mode) {
            case "valid": Console.Write(marker); return 73;
            case "wrong-exit": Console.Write(marker); return 0;
            case "missing-marker": return 73;
            case "unexpected-output": Console.Write("unexpected:" + marker); return 73;
            case "stderr-output": Console.Write(marker); Console.Error.Write("unexpected stderr"); return 73;
            case "truncated-marker": Console.Write(marker.Substring(0, marker.Length - 1)); return 73;
            case "oversized-output": Console.Write(marker + new string('x', 16384)); return 73;
            case "newline-output": Console.WriteLine(marker); return 73;
            case "silent-timeout": Thread.Sleep(10000); return 73;
            case "marker-then-timeout": Console.Write(marker); Thread.Sleep(10000); return 73;
            default: return 74;
        }
    }
}
'@
    $compileHost = Invoke-Native $csc @('/nologo', '/target:exe', ('/out:' + $protocolExecutable), $protocolSource)
    Assert-Fixture ($compileHost.exitCode -eq 0 -and (Test-Path -LiteralPath $protocolExecutable)) "Protocol host compilation failed: $($compileHost.stdout) $($compileHost.stderr)"
    $nativeHarness = New-Harness 'native' $false
    $protocolHarness = New-Harness 'protocol' $true
    $specialTarget = Join-Path $fixtureRoot 'scoped '' $ ` & Ω'
    [void][IO.Directory]::CreateDirectory($specialTarget)
    $powershell = Join-Path $env:WINDIR 'System32/WindowsPowerShell/v1.0/powershell.exe'
    $compatibleModulePath = @(
        (Join-Path ([Environment]::GetFolderPath('MyDocuments')) 'WindowsPowerShell/Modules'),
        (Join-Path $env:ProgramFiles 'WindowsPowerShell/Modules'),
        (Join-Path $env:WINDIR 'System32/WindowsPowerShell/v1.0/Modules')
    ) -join ';'
    $compatibleEnvironment = @{ PSModulePath = $compatibleModulePath }
    # The default case inherits the runner's unmodified PowerShell 7 environment.
    # The second explicitly supplies a Windows PowerShell 5-compatible module path.
    Invoke-Harness 'native-parent-powershell7-environment' $nativeHarness $specialTarget $true
    Invoke-Harness 'native-compatible-powershell5-environment' $nativeHarness $specialTarget $true $compatibleEnvironment $true
    Invoke-Harness 'native-existing-environment' $nativeHarness $specialTarget $true @{ PSModulePath = $compatibleModulePath; LIFE_NSIS_PROCESS_PROBE_TARGET = 'previous "quoted" '' $ ` Ω value' }
    Invoke-Harness 'native-present-empty-environment' $nativeHarness $specialTarget $true @{ PSModulePath = $compatibleModulePath; LIFE_NSIS_PROCESS_PROBE_TARGET = '' } $true
    Invoke-Harness 'native-oversized-environment' $nativeHarness $specialTarget $false @{ PSModulePath = $compatibleModulePath; LIFE_NSIS_PROCESS_PROBE_TARGET = ('z' * 16384) } $true
    Invoke-Harness 'native-empty-target' $nativeHarness '' $false $compatibleEnvironment

    $sameName = 'arbitrary-scope-helper.exe'
    $outside = Join-Path $fixtureRoot 'outside'
    $nested = Join-Path $specialTarget 'nested'
    [void][IO.Directory]::CreateDirectory($outside)
    [void][IO.Directory]::CreateDirectory($nested)
    $outsideHelper = Join-Path $outside $sameName
    $insideHelper = Join-Path $nested $sameName
    Copy-Item -LiteralPath $protocolExecutable -Destination $outsideHelper
    Copy-Item -LiteralPath $protocolExecutable -Destination $insideHelper
    $outsideProcess = Start-Process -FilePath $outsideHelper -ArgumentList 'hold' -PassThru
    $ownedProcesses.Add($outsideProcess)
    Invoke-Harness 'native-same-filename-outside-target' $nativeHarness $specialTarget $true $compatibleEnvironment
    $insideProcess = Start-Process -FilePath $insideHelper -ArgumentList 'hold' -PassThru
    $ownedProcesses.Add($insideProcess)
    Invoke-Harness 'native-nested-arbitrary-filename-match' $nativeHarness $specialTarget $false $compatibleEnvironment $true
    Invoke-Harness 'native-mixed-case-path-match' $nativeHarness $specialTarget.ToUpperInvariant() $false $compatibleEnvironment
    foreach ($process in @($insideProcess, $outsideProcess)) {
        if (-not $process.HasExited) { $process.Kill(); $process.WaitForExit() }
    }

    Invoke-Harness 'protocol-valid-clear-error' $protocolHarness $specialTarget $true @{ LIFE_FIXTURE_PROBE_MODE = 'valid' }
    Invoke-Harness 'protocol-valid-set-error' $protocolHarness $specialTarget $true @{ LIFE_FIXTURE_PROBE_MODE = 'valid'; LIFE_NSIS_PROCESS_PROBE_TARGET = 'original value' } $true
    $oversizedProbeLog = Join-Path $fixtureRoot 'oversized-probe-invocation.txt'
    Invoke-Harness 'protocol-oversized-environment-no-spawn' $protocolHarness $specialTarget $false @{ LIFE_FIXTURE_PROBE_MODE = 'valid'; LIFE_NSIS_PROCESS_PROBE_TARGET = ('z' * 16384); LIFE_FIXTURE_PROBE_CALL_LOG = $oversizedProbeLog } $true
    Assert-Fixture (-not (Test-Path -LiteralPath $oversizedProbeLog)) 'An oversized original environment value must fall back before spawning a probe.'
    foreach ($mode in @('wrong-exit', 'missing-marker', 'unexpected-output', 'stderr-output', 'truncated-marker', 'oversized-output', 'newline-output', 'silent-timeout', 'marker-then-timeout')) {
        Invoke-Harness ('protocol-' + $mode) $protocolHarness $specialTarget $false @{ LIFE_FIXTURE_PROBE_MODE = $mode; LIFE_NSIS_PROCESS_PROBE_TARGET = 'original value' } $true
    }
    $missingHostDirectory = Join-Path $fixtureRoot 'missing-host'
    [void][IO.Directory]::CreateDirectory($missingHostDirectory)
    $missingHostHarness = Join-Path $missingHostDirectory 'fixture.exe'
    Copy-Item -LiteralPath $protocolHarness -Destination $missingHostHarness
    Invoke-Harness 'protocol-spawn-failure' $missingHostHarness $specialTarget $false

    # Exercise the actual embedded command, with controlled CIM and policy
    # functions, so a partial enumeration can never produce a false proof.
    $commandMatch = [regex]::Match($moduleSource, '(?m)nsExec::ExecToStack[^\r\n]*-Command "(?<command>.*)"`[^\r\n]*$')
    Assert-Fixture $commandMatch.Success 'Could not extract the actual embedded process-check command.'
    $command = $commandMatch.Groups['command'].Value.Replace('$$', '$')
    $protocolDefines = @{
        LIFE_PROCESS_PROBE_ENV = 'LIFE_NSIS_PROCESS_PROBE_TARGET'
        LIFE_PROCESS_PROBE_MARKER = 'LIFE_NO_SCOPED_PROCESS_V1'
        LIFE_PROCESS_PROBE_EXIT = '73'
    }
    foreach ($entry in $protocolDefines.GetEnumerator()) {
        $definition = [regex]::Match($moduleSource, ('(?m)^!define\s+' + [regex]::Escape($entry.Key) + '\s+"(?<value>[^"]+)"\s*$'))
        Assert-Fixture ($definition.Success -and $definition.Groups['value'].Value -ceq $entry.Value) "Unexpected process-probe protocol definition: $($entry.Key)"
        $command = $command.Replace(('${' + $entry.Key + '}'), $definition.Groups['value'].Value)
    }
    Assert-Fixture ($command -notmatch '\$\{[A-Z_]+\}') 'The semantic command contains an unresolved NSIS definition.'
    $semanticMocks = @'
$script:mode = [Environment]::GetEnvironmentVariable('LIFE_FIXTURE_SEMANTIC_MODE')
$script:target = [Environment]::GetEnvironmentVariable('LIFE_NSIS_PROCESS_PROBE_TARGET')
function Get-Command {
    [CmdletBinding()] param([string]$Name)
    if ($script:mode -eq 'missing-cim') { throw 'fixture missing CIM command' }
    [pscustomobject]@{ Name = $Name }
}
function Get-ExecutionPolicy {
    [CmdletBinding()] param([string]$Scope)
    if ($script:mode -eq 'policy-error') { throw 'fixture policy query failure' }
    if ($script:mode -eq 'restricted-policy') { return 'Restricted' }
    'RemoteSigned'
}
function Get-CimInstance {
    [CmdletBinding()] param([string]$ClassName)
    $outside = 'C:\outside\arbitrary-helper.exe'
    switch ($script:mode) {
        'zero-records' { return }
        'matching-arbitrary-filename' { [pscustomobject]@{ Path = $script:target + '\nested\anything.exe' }; return }
        'matching-mixed-case' { [pscustomobject]@{ Path = $script:target.ToUpperInvariant() + '\Nested\Anything.exe' }; return }
        'matching-sibling-prefix' { [pscustomobject]@{ Path = $script:target + '-sibling\anything.exe' }; return }
        'partial-throw' { [pscustomobject]@{ Path = $outside }; throw 'fixture partial enumeration' }
        'partial-write-error' { [pscustomobject]@{ Path = $outside }; Write-Error 'fixture partial enumeration'; return }
        default { [pscustomobject]@{ Path = $outside }; [pscustomobject]@{ Path = $null }; return }
    }
}
'@
    foreach ($mode in @('complete-nonmatch', 'matching-arbitrary-filename', 'matching-mixed-case', 'matching-sibling-prefix', 'zero-records', 'partial-throw', 'partial-write-error', 'missing-cim', 'restricted-policy', 'policy-error', 'empty-target')) {
        $script = $semanticMocks + "`r`n" + $command
        $encoded = [Convert]::ToBase64String([Text.Encoding]::Unicode.GetBytes($script))
        $target = if ($mode -eq 'empty-target') { '' } else { $specialTarget }
        $run = Invoke-Native $powershell @('-NoProfile', '-NonInteractive', '-EncodedCommand', $encoded) @{ LIFE_FIXTURE_SEMANTIC_MODE = $mode; LIFE_NSIS_PROCESS_PROBE_TARGET = $target; PSModulePath = $compatibleModulePath }
        $success = $mode -eq 'complete-nonmatch'
        $expectedExit = if ($success) { 73 } else { 74 }
        $expectedOutput = if ($success) { 'LIFE_NO_SCOPED_PROCESS_V1' } else { '' }
        Assert-Fixture ($run.exitCode -eq $expectedExit -and $run.stdout -ceq $expectedOutput) "Semantic fixture $mode returned $($run.exitCode), stdout '$($run.stdout)', stderr '$($run.stderr)'"
        $results.Add([pscustomobject]@{ name = ('semantic-' + $mode); kind = 'actual-command'; ok = $true; exitCode = $run.exitCode; exactOutput = $run.stdout })
    }
    $proof.ok = $true
} catch {
    $proof.error = $_.Exception.Message
    throw
} finally {
    foreach ($process in $ownedProcesses) {
        try { if (-not $process.HasExited) { $process.Kill(); $process.WaitForExit() } }
        finally { $process.Dispose() }
    }
    $proof.cases = $results.ToArray()
    [void][IO.Directory]::CreateDirectory((Split-Path $proofPath -Parent))
    Write-Utf8 $proofPath ($proof | ConvertTo-Json -Depth 10)
    if (Test-Path -LiteralPath $fixtureRoot) { Remove-Item -LiteralPath $fixtureRoot -Recurse -Force }
}
