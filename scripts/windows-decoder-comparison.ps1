[CmdletBinding()]
param(
  [Parameter(Mandatory = $true)][string]$ArchivePath,
  [Parameter(Mandatory = $true)][string]$ManifestPath,
  [Parameter(Mandatory = $true)][switch]$InstallerTrialCompleted,
  [string]$InstallerProofPath,
  [string]$BundleDirectory = $PSScriptRoot,
  [string]$WorkDirectory,
  [string]$ReportDirectory
)

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'
if (-not $IsWindows) { throw 'This diagnostic must run on Windows PowerShell 7 after the installer trial.' }
if (-not $InstallerTrialCompleted) { throw 'Run the authoritative installer trial to completion before this diagnostic.' }

$bundle = [System.IO.Path]::GetFullPath($BundleDirectory)
$archive = [System.IO.Path]::GetFullPath($ArchivePath)
$metadataPath = Join-Path $bundle 'fixture-metadata.json'
$manifestPath = [System.IO.Path]::GetFullPath($ManifestPath)
$runner = Join-Path $bundle 'windows-decoder-extract.ps1'
$metadata = Get-Content -LiteralPath $metadataPath -Raw | ConvertFrom-Json
$manifest = Get-Content -LiteralPath $manifestPath -Raw | ConvertFrom-Json -AsHashtable
$startedAt = [DateTimeOffset]::UtcNow.ToString('O')
if ($manifest.format -ne 1 -or $manifest.arch -cne '64' -or -not $manifest.ContainsKey('entries')) { throw 'Requires the exact build-generated app-64.json snapshot.' }
$expectedFiles = @($manifest.entries | Where-Object { -not $_.directory })
$expectedDirectories = @($manifest.entries | Where-Object { $_.directory })

if ([string]::IsNullOrWhiteSpace($WorkDirectory)) {
  $programs = Join-Path $env:LOCALAPPDATA 'Programs'
  $WorkDirectory = Join-Path $programs ('Life-decoder-diagnostic-' + [Guid]::NewGuid().ToString('N'))
}
$work = [System.IO.Path]::GetFullPath($WorkDirectory)
if (Test-Path -LiteralPath $work) { throw 'Comparison WorkDirectory must be absent; use a fresh path.' }
[void][System.IO.Directory]::CreateDirectory($work)
if ([string]::IsNullOrWhiteSpace($ReportDirectory)) { $ReportDirectory = Join-Path $work 'reports' }
$reports = [System.IO.Path]::GetFullPath($ReportDirectory)
[void][System.IO.Directory]::CreateDirectory($reports)

$environment = [ordered]@{
  os = [Environment]::OSVersion.VersionString
  logicalProcessors = [Environment]::ProcessorCount
  powershell = $PSVersionTable.PSVersion.ToString()
  processArchitecture = [System.Runtime.InteropServices.RuntimeInformation]::ProcessArchitecture.ToString()
  osArchitecture = [System.Runtime.InteropServices.RuntimeInformation]::OSArchitecture.ToString()
  localProgramsParent = (Split-Path -Parent $work)
}
try {
  $defender = Get-MpComputerStatus
  $environment['defender'] = [ordered]@{
    antivirusEnabled = $defender.AntivirusEnabled
    realTimeProtectionEnabled = $defender.RealTimeProtectionEnabled
    antivirusSignatureVersion = $defender.AntivirusSignatureVersion
  }
} catch { $environment['defenderReadFailure'] = $_.Exception.Message }

$trials = [System.Collections.Generic.List[object]]::new()
$failures = [System.Collections.Generic.List[string]]::new()
foreach ($decoder in @('nsis19', 'modern')) {
  $name = if ($decoder -eq 'nsis19') { 'nsis7z19-fixture.exe' } else { '7za-26.04-x64.exe' }
  $extractor = Join-Path $bundle $name
  $expectedHash = if ($decoder -eq 'nsis19') { $metadata.fixture.sha256 } else { $metadata.modern.sha256 }
  $actualHash = (Get-FileHash -LiteralPath $extractor -Algorithm SHA256).Hash.ToLowerInvariant()
  if ($actualHash -ne $expectedHash) { throw "Pinned $decoder executable hash mismatch." }
  $reportPath = Join-Path $reports ($decoder + '.json')
  $arguments = @{
    Decoder = $decoder
    ExtractorPath = $extractor
    ArchivePath = $archive
    ManifestPath = $manifestPath
    FixtureMetadataPath = $metadataPath
    OutputDirectory = (Join-Path $work ($decoder + '-payload'))
    ReportPath = $reportPath
    InstallerTrialCompleted = $true
  }
  if (-not [string]::IsNullOrWhiteSpace($InstallerProofPath)) { $arguments['InstallerProofPath'] = $InstallerProofPath }
  $failed = $false
  try { & $runner @arguments } catch {
    $failed = $true
    $failures.Add($decoder + ': ' + $_.Exception.Message)
  }
  if (Test-Path -LiteralPath $reportPath) {
    $trial = Get-Content -LiteralPath $reportPath -Raw | ConvertFrom-Json
    $trials.Add($trial)
    if (-not $failed -and -not $trial.ok) { $failures.Add($decoder + ': raw report validation failed.') }
  } else {
    $trials.Add([ordered]@{ decoder = $decoder; ok = $false; failure = 'No raw report was produced.' })
    if (-not $failed) { $failures.Add($decoder + ': no raw report was produced.') }
  }
}

$summary = [ordered]@{
  schemaVersion = 1
  diagnosticOnly = $true
  ok = ($failures.Count -eq 0 -and $trials.Count -eq 2)
  startedAt = $startedAt
  completedAt = [DateTimeOffset]::UtcNow.ToString('O')
  archiveSha256 = $manifest.archiveSha256
  archiveBytes = $manifest.archiveSize
  snapshotPath = $manifestPath
  snapshotSha256 = (Get-FileHash -LiteralPath $manifestPath -Algorithm SHA256).Hash.ToLowerInvariant()
  expectedFiles = $expectedFiles.Count
  expectedDirectories = $expectedDirectories.Count
  expectedFileBytes = ($expectedFiles | Measure-Object -Property size -Sum).Sum
  environment = $environment
  order = @('nsis19', 'modern')
  repetitions = 1
  timingScope = 'Each process launch through completed exit; exact output inventory/size/SHA256 validation afterward.'
  cachePolicy = 'No cache flush or Defender change. Both archive hashes are checked before each launch. Fixed order, one sample each; no claim of cold-cache or statistical installer performance.'
  installerTrialCompleted = $true
  installerProofPath = $InstallerProofPath
  fixtureMetadata = $metadata
  trials = $trials.ToArray()
  failures = $failures.ToArray()
  workDirectory = $work
}
$summaryPath = Join-Path $reports 'decoder-comparison.json'
$summary | ConvertTo-Json -Depth 30 | Set-Content -LiteralPath $summaryPath -Encoding utf8
Write-Host ('Decoder comparison report: ' + $summaryPath)
if (-not $summary.ok) { throw ('Decoder comparison failed: ' + ($failures -join '; ')) }
