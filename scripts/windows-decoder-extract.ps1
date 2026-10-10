#Requires -Version 7.0
[CmdletBinding()]
param(
    [Parameter(Mandatory)][ValidateSet('modern', 'nsis19')][string]$Decoder,
    [Parameter(Mandatory)][string]$ExtractorPath,
    [Parameter(Mandatory)][string]$ArchivePath,
    [Parameter(Mandatory)][string]$ManifestPath,
    [Parameter(Mandatory)][string]$OutputDirectory,
    [Parameter(Mandatory)][string]$ReportPath,
    [Parameter(Mandatory)][string]$FixtureMetadataPath,
    [Parameter(Mandatory)][switch]$InstallerTrialCompleted,
    [string]$InstallerProofPath
)

$ErrorActionPreference = 'Stop'
Set-StrictMode -Version Latest

function Get-Sha256([string]$Path) {
    return (Get-FileHash -LiteralPath $Path -Algorithm SHA256).Hash.ToLowerInvariant()
}

function Read-Manifest([string]$Path) {
    $value = Get-Content -LiteralPath $Path -Raw | ConvertFrom-Json -AsHashtable
    if ($value.ContainsKey('format')) {
        foreach ($key in @('format', 'arch', 'archiveSha256', 'archiveSize', 'entries')) {
            if (-not $value.ContainsKey($key)) { throw "Candidate snapshot is missing $key." }
        }
        if ($value.format -ne 1 -or $value.arch -cne '64') { throw 'Unsupported candidate snapshot format or architecture.' }
        $files = [Collections.Generic.List[object]]::new()
        $directories = [Collections.Generic.List[string]]::new()
        foreach ($entry in @($value.entries)) {
            foreach ($key in @('path', 'directory', 'size')) {
                if (-not $entry.ContainsKey($key)) { throw "Candidate snapshot entry is missing $key." }
            }
            if ($entry.directory -isnot [bool]) { throw 'Candidate snapshot entry directory flag must be Boolean.' }
            if ($entry.directory) {
                if ($entry.size -ne 0) { throw "Candidate snapshot directory has a nonzero size: $($entry.path)." }
                $directories.Add($entry.path)
            } else {
                if (-not $entry.ContainsKey('sha256')) { throw "Candidate snapshot file is missing sha256: $($entry.path)." }
                $files.Add(@{ path = $entry.path; size = $entry.size; sha256 = $entry.sha256 })
            }
        }
        $value = @{
            schemaVersion = 1; archiveSha256 = $value.archiveSha256; archiveBytes = $value.archiveSize
            files = $files.ToArray(); directories = $directories.ToArray()
        }
    }
    foreach ($key in @('schemaVersion', 'archiveSha256', 'archiveBytes', 'files', 'directories')) {
        if (-not $value.ContainsKey($key)) { throw "Manifest is missing $key." }
    }
    if ($value.schemaVersion -ne 1) { throw 'Unsupported manifest schema.' }
    if ($value.archiveSha256 -notmatch '^[a-fA-F0-9]{64}$') { throw 'Invalid archive SHA-256.' }
    if ([double]$value.archiveBytes -lt 0 -or [double]$value.archiveBytes -ne [math]::Truncate([double]$value.archiveBytes)) {
        throw 'Invalid archive size.'
    }
    $names = [Collections.Generic.HashSet[string]]::new([StringComparer]::OrdinalIgnoreCase)
    foreach ($file in @($value.files)) {
        foreach ($key in @('path', 'size', 'sha256')) {
            if (-not $file.ContainsKey($key)) { throw "Manifest file is missing $key." }
        }
        Assert-RelativePath $file.path
        if (-not $names.Add($file.path)) { throw "Duplicate manifest path: $($file.path)." }
        if ($file.sha256 -notmatch '^[a-fA-F0-9]{64}$') { throw "Invalid file SHA-256: $($file.path)." }
        if ([double]$file.size -lt 0 -or [double]$file.size -ne [math]::Truncate([double]$file.size)) {
            throw "Invalid file size: $($file.path)."
        }
    }
    foreach ($directory in @($value.directories)) {
        Assert-RelativePath $directory
        if (-not $names.Add($directory)) { throw "Duplicate manifest path: $directory." }
    }
    if (@($value.files).Count -eq 0) { throw 'Manifest has no files.' }
    return $value
}

function Assert-RelativePath([string]$Path) {
    if ([string]::IsNullOrWhiteSpace($Path) -or $Path -match '[\\<>:"|?*\x00-\x1f]' -or
        $Path.StartsWith('/') -or $Path.EndsWith('/') -or $Path.Split('/') -contains '' -or
        $Path.Split('/') -contains '.' -or $Path.Split('/') -contains '..') {
        throw "Unsafe or noncanonical manifest path: $Path."
    }
}

function Get-PeInfo([string]$Path) {
    $bytes = [IO.File]::ReadAllBytes($Path)
    if ($bytes.Length -lt 64 -or $bytes[0] -ne 0x4d -or $bytes[1] -ne 0x5a) { throw 'Extractor has no MZ header.' }
    $offset = [BitConverter]::ToUInt32($bytes, 0x3c)
    if ([long]$offset + 26 -gt $bytes.Length -or [BitConverter]::ToUInt32($bytes, $offset) -ne 0x4550) {
        throw 'Extractor has no valid PE header.'
    }
    $machine = [BitConverter]::ToUInt16($bytes, $offset + 4)
    $architecture = switch ($machine) { 0x014c { 'x86' }; 0x8664 { 'x64' }; 0xaa64 { 'arm64' }; default { 'unknown' } }
    return [ordered]@{
        machine = ('0x{0:x4}' -f $machine); architecture = $architecture
        optionalHeaderMagic = ('0x{0:x4}' -f [BitConverter]::ToUInt16($bytes, $offset + 24))
        bytes = $bytes.Length; sha256 = Get-Sha256 $Path
    }
}

function Assert-AbsentOutputDirectory([string]$Path) {
    # Both decoder processes create their output leaf inside the timed interval.
    # The runner owns the unique GUID parent; never reuse an existing output leaf.
    if (-not ('LifeDecoderProof.NativeDirectory' -as [type])) {
        Add-Type -TypeDefinition @'
using System;
using System.Runtime.InteropServices;
namespace LifeDecoderProof {
    public static class NativeDirectory {
        [DllImport("kernel32.dll", EntryPoint="GetFileAttributesW", CharSet=CharSet.Unicode, SetLastError=true)]
        public static extern uint Attributes(string path);
    }
}
'@
    }
    $parent = [IO.Path]::GetDirectoryName($Path)
    if ([string]::IsNullOrEmpty($parent)) { throw 'The output directory requires a parent directory.' }
    [void][IO.Directory]::CreateDirectory($parent)
    $attributes = [LifeDecoderProof.NativeDirectory]::Attributes($Path)
    if ($attributes -ne [uint32]::MaxValue) {
        throw "Refusing to reuse an existing output file, directory, or reparse point: $Path."
    }
    $code = [Runtime.InteropServices.Marshal]::GetLastWin32Error()
    if ($code -notin @(2, 3)) {
        throw "Cannot establish output path absence (Win32 $code): $Path."
    }
}

function Test-PayloadInventory([string]$Directory, [hashtable]$Manifest) {
    $outputRoot = Get-Item -LiteralPath $Directory -Force
    if (-not $outputRoot.PSIsContainer -or ($outputRoot.Attributes -band [IO.FileAttributes]::ReparsePoint) -ne 0) {
        throw 'The extracted output root must be an ordinary directory, not a reparse point.'
    }
    $root = [IO.Path]::GetFullPath($Directory).TrimEnd([IO.Path]::DirectorySeparatorChar) + [IO.Path]::DirectorySeparatorChar
    $actualFiles = [Collections.Generic.Dictionary[string, object]]::new([StringComparer]::Ordinal)
    $actualDirectories = [Collections.Generic.HashSet[string]]::new([StringComparer]::Ordinal)
    $pending = [Collections.Generic.Stack[string]]::new()
    $pending.Push($Directory)
    while ($pending.Count -gt 0) {
        foreach ($item in Get-ChildItem -LiteralPath $pending.Pop() -Force) {
            if (($item.Attributes -band [IO.FileAttributes]::ReparsePoint) -ne 0) {
                throw "Extracted reparse point is not allowed: $($item.FullName)."
            }
            if (-not $item.FullName.StartsWith($root, [StringComparison]::OrdinalIgnoreCase)) {
                throw 'Extracted item is outside the output directory.'
            }
            $relative = $item.FullName.Substring($root.Length).Replace('\', '/')
            if ($item.PSIsContainer) {
                if (-not $actualDirectories.Add($relative)) { throw "Duplicate directory: $relative." }
                $pending.Push($item.FullName)
            } else {
                $actualFiles.Add($relative, $item)
            }
        }
    }
    $expectedDirectories = [Collections.Generic.HashSet[string]]::new([StringComparer]::Ordinal)
    foreach ($directory in @($Manifest.directories)) { [void]$expectedDirectories.Add($directory) }
    if (-not $expectedDirectories.SetEquals($actualDirectories)) {
        throw 'Extracted directory inventory differs from the manifest.'
    }
    if ($actualFiles.Count -ne @($Manifest.files).Count) { throw 'Extracted file count differs from the manifest.' }
    [long]$totalBytes = 0
    foreach ($file in @($Manifest.files)) {
        if (-not $actualFiles.ContainsKey($file.path)) { throw "Missing extracted file: $($file.path)." }
        $actual = $actualFiles[$file.path]
        if ($actual.Length -ne [long]$file.size) { throw "Extracted file size differs: $($file.path)." }
        if ((Get-Sha256 $actual.FullName) -cne $file.sha256.ToLowerInvariant()) {
            throw "Extracted SHA-256 differs: $($file.path)."
        }
        $totalBytes += $actual.Length
    }
    return [ordered]@{ ok = $true; passed = $true; fileCount = $actualFiles.Count; directoryCount = $actualDirectories.Count; fileBytes = $totalBytes }
}

function Run-TimedExtractor([string]$Path, [string[]]$Arguments, [string]$StdoutPath, [string]$StderrPath) {
    $parameters = @{ FilePath = $Path; PassThru = $true; NoNewWindow = $true
        RedirectStandardOutput = $StdoutPath; RedirectStandardError = $StderrPath }
    if ($Arguments.Count -gt 0) { $parameters.ArgumentList = $Arguments }
    $startedAt = [DateTime]::UtcNow.ToString('o')
    $watch = [Diagnostics.Stopwatch]::StartNew()
    $process = $null
    $exitCode = $null
    $launchError = $null
    try {
        $process = Start-Process @parameters
        # Keep the process handle while waiting, including very short executions.
        $null = $process.Handle
        $process.WaitForExit() # Deliberately no timeout or cancellation.
        $exitCode = $process.ExitCode
    } catch {
        $launchError = $_.Exception.Message
    } finally {
        $watch.Stop()
        $finishedAt = [DateTime]::UtcNow.ToString('o')
    }
    $pidValue = if ($null -ne $process) { $process.Id } else { $null }
    $result = [ordered]@{
        kind = 'decoder'; startedAt = $startedAt; finishedAt = $finishedAt
        elapsedMilliseconds = $watch.Elapsed.TotalMilliseconds
        stopwatchTicks = $watch.ElapsedTicks; stopwatchFrequency = [Diagnostics.Stopwatch]::Frequency
        processId = $pidValue; exitCode = $exitCode; launchError = $launchError
        arguments = @($Arguments); stdoutPath = $StdoutPath; stderrPath = $StderrPath
        scope = 'Start-Process invocation through completed WaitForExit; no timeout; verification is outside the timer.'
    }
    if ($null -ne $process) { $process.Dispose() }
    return $result
}

$report = [ordered]@{
    schemaVersion = 1; decoder = $Decoder; ok = $false
    installerTrialCompleted = [bool]$InstallerTrialCompleted
    installerProof = $null; archive = $null; extractor = $null; timing = $null
    elapsedMilliseconds = $null; fixtureMetadata = $null
    validation = $null; nativeCompletion = $null; error = $null
    runner = [ordered]@{ os = [Runtime.InteropServices.RuntimeInformation]::OSDescription
        osArchitecture = [Runtime.InteropServices.RuntimeInformation]::OSArchitecture.ToString()
        processArchitecture = [Runtime.InteropServices.RuntimeInformation]::ProcessArchitecture.ToString()
        powerShellVersion = $PSVersionTable.PSVersion.ToString(); logicalProcessors = [Environment]::ProcessorCount }
}
$reportFullPath = [IO.Path]::GetFullPath($ReportPath)
try {
    if (-not $InstallerTrialCompleted) { throw 'Decoder fixture requires the already completed authoritative installer trial.' }
    if (-not $IsWindows) { throw 'This fixture requires Windows.' }
    $extractorFullPath = (Get-Item -LiteralPath $ExtractorPath).FullName
    $archiveFullPath = (Get-Item -LiteralPath $ArchivePath).FullName
    $manifestFullPath = (Get-Item -LiteralPath $ManifestPath).FullName
    $metadataFullPath = (Get-Item -LiteralPath $FixtureMetadataPath).FullName
    $outputFullPath = [IO.Path]::GetFullPath($OutputDirectory).TrimEnd([IO.Path]::DirectorySeparatorChar)
    foreach ($path in @($extractorFullPath, $archiveFullPath, $manifestFullPath, $outputFullPath, $reportFullPath)) {
        if ($path -match '["\x00-\x1f]') { throw 'Fixture paths cannot contain quotes or control characters.' }
    }
    if ($reportFullPath.StartsWith($outputFullPath + '\', [StringComparison]::OrdinalIgnoreCase)) {
        throw 'The report and logs must be outside the extracted payload.'
    }
    if (-not [IO.Directory]::Exists([IO.Path]::GetDirectoryName($reportFullPath))) {
        throw 'The report parent directory must already exist.'
    }
    foreach ($path in @($reportFullPath, "$reportFullPath.stdout.log", "$reportFullPath.stderr.log", "$reportFullPath.native.json")) {
        if (Test-Path -LiteralPath $path) { throw "Refusing to overwrite prior fixture evidence: $path." }
    }
    if ($InstallerProofPath) {
        $proof = Get-Item -LiteralPath $InstallerProofPath
        $report.installerProof = [ordered]@{ path = $proof.FullName; bytes = $proof.Length; sha256 = Get-Sha256 $proof.FullName }
    }
    $manifest = Read-Manifest $manifestFullPath
    $metadata = Get-Content -LiteralPath $metadataFullPath -Raw | ConvertFrom-Json -AsHashtable
    if ($metadata.schemaVersion -ne 1 -or -not $metadata.diagnosticOnly) { throw 'Invalid decoder fixture metadata.' }
    $manifestHash = Get-Sha256 $manifestFullPath
    # Metadata pins decoder executables only. The trusted candidate snapshot is
    # generated by the authoritative installer build and independently pins its archive.
    $report.fixtureMetadata = [ordered]@{ path = $metadataFullPath; sha256 = Get-Sha256 $metadataFullPath }
    $archive = Get-Item -LiteralPath $archiveFullPath
    $archiveHash = Get-Sha256 $archiveFullPath
    $report.archive = [ordered]@{ path = $archiveFullPath; bytes = $archive.Length; sha256 = $archiveHash
        manifestPath = $manifestFullPath; manifestSha256 = $manifestHash }
    if ($archive.Length -ne [long]$manifest.archiveBytes -or $archiveHash -cne $manifest.archiveSha256.ToLowerInvariant()) {
        throw 'Archive identity differs from the expected manifest.'
    }
    $report.extractor = Get-PeInfo $extractorFullPath
    $report.extractor.path = $extractorFullPath
    $expectedExtractor = if ($Decoder -eq 'modern') { $metadata.modern } else { $metadata.fixture }
    if ($report.extractor.sha256 -cne $expectedExtractor.sha256 -or $report.extractor.bytes -ne $expectedExtractor.bytes -or
        $report.extractor.machine -cne $expectedExtractor.machine) {
        throw 'Extractor identity differs from the pinned fixture metadata.'
    }
    if ($Decoder -eq 'modern') {
        if ($report.extractor.architecture -cne 'x64' -or $report.runner.osArchitecture -cne 'X64' -or
            $report.extractor.sha256 -cne '15d4c788c148e3677e2fc1c4a01f191fb6669eba4f6acf8a465f0f1a6f1e1260') {
            throw 'Modern trial requires the pinned official 26.04 native x64 executable on x64 Windows.'
        }
    }
    Assert-AbsentOutputDirectory $outputFullPath
    $report.outputDirectory = $outputFullPath
    $savedEnvironment = @{}
    foreach ($name in @('LIFE_DECODER_ARCHIVE', 'LIFE_DECODER_OUTPUT', 'LIFE_DECODER_NATIVE_REPORT')) {
        $savedEnvironment[$name] = [Environment]::GetEnvironmentVariable($name, 'Process')
    }
    try {
        if ($Decoder -eq 'nsis19') {
            [Environment]::SetEnvironmentVariable('LIFE_DECODER_ARCHIVE', $archiveFullPath, 'Process')
            [Environment]::SetEnvironmentVariable('LIFE_DECODER_OUTPUT', $outputFullPath, 'Process')
            [Environment]::SetEnvironmentVariable('LIFE_DECODER_NATIVE_REPORT', "$reportFullPath.native.json", 'Process')
            $arguments = @('/S')
        } else {
            $arguments = @('x', '-t7z', '-y', '-aoa', '-bd', '-bb0', ('"-o{0}"' -f $outputFullPath), '--', ('"{0}"' -f $archiveFullPath))
        }
        $report.timing = Run-TimedExtractor $extractorFullPath $arguments "$reportFullPath.stdout.log" "$reportFullPath.stderr.log"
        $report.elapsedMilliseconds = $report.timing.elapsedMilliseconds
    } finally {
        foreach ($name in $savedEnvironment.Keys) { [Environment]::SetEnvironmentVariable($name, $savedEnvironment[$name], 'Process') }
    }
    if ($report.timing.launchError -or $null -eq $report.timing.exitCode -or $report.timing.exitCode -ne 0) {
        throw "Decoder process failed (exit $($report.timing.exitCode)): $($report.timing.launchError)."
    }
    if ($Decoder -eq 'nsis19') {
        if (-not (Test-Path -LiteralPath "$reportFullPath.native.json" -PathType Leaf)) {
            throw 'NSIS decoder did not retain its native completion report.'
        }
        $report.nativeCompletion = Get-Content -LiteralPath "$reportFullPath.native.json" -Raw | ConvertFrom-Json -AsHashtable
        $native = $report.nativeCompletion
        if (-not $native.ContainsKey('completed') -or $native.completed -isnot [bool] -or -not $native.completed -or
            -not $native.ContainsKey('pluginHasExitContract') -or $native.pluginHasExitContract -isnot [bool] -or
            $native.pluginHasExitContract -or $native.decoder -cne 'Nsis7z::Extract 19.00') {
            throw 'Invalid or incomplete NSIS native completion evidence.'
        }
    }
    $report.validation = Test-PayloadInventory $outputFullPath $manifest
    $report.ok = $true
} catch {
    $report.error = $_.Exception.Message
} finally {
    # Reports preserve raw timing even when exit/inventory verification fails.
    $json = $report | ConvertTo-Json -Depth 12
    if (-not (Test-Path -LiteralPath $reportFullPath)) {
        [IO.File]::WriteAllText($reportFullPath, $json, [Text.UTF8Encoding]::new($false))
    }
}
if (-not $report.ok) { throw "Decoder comparison failed: $($report.error) Report: $reportFullPath" }
Write-Output $report
