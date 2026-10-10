param([string]$SourcePath = (Join-Path $PSScriptRoot 'windows-upgrade.ps1'))

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'
$tokens = $null
$errors = $null
$syntax = [Management.Automation.Language.Parser]::ParseFile((Resolve-Path $SourcePath).Path, [ref]$tokens, [ref]$errors)
if ($errors.Count -ne 0) { throw "Windows upgrade script has syntax errors: $errors" }
# Parse and import only pure validation functions; never invoke an installer or cleanup.
foreach ($name in @('Get-ValidatedBaselineVersions', 'Get-UpgradePerformance', 'Get-InstallerPayloadRouteValidation', 'Get-InstallerProfilingValidation', 'Read-InstallerTrace')) {
    $definition = $syntax.FindAll({ param($node) $node -is [Management.Automation.Language.FunctionDefinitionAst] }, $true) |
        Where-Object { $_.Name -eq $name } | Select-Object -First 1
    if (-not $definition) { throw "Missing validation function $name." }
    Invoke-Expression $definition.Extent.Text
}
function Assert-Equal($Actual, $Expected, [string]$Context) {
    if ($Actual -cne $Expected) { throw "$Context expected '$Expected'; got '$Actual'." }
}
function Assert-Throws([scriptblock]$Action, [string]$Context) {
    $threw = $false
    try { $null = & $Action } catch { $threw = $true }
    if (-not $threw) { throw "$Context unexpectedly succeeded." }
}
function New-Trial([double]$Duration) {
    return [pscustomobject]@{
        ok = $true; baselineVersion = '0.11.0'; targetVersion = '0.11.1'
        timings = @{ targetUpgrade = [pscustomobject]@{ kind = 'nsis'; ok = $true; elapsedMilliseconds = $Duration } }
    }
}

Assert-Equal ((@(Get-ValidatedBaselineVersions @() '0.11.1')) -join ',') '0.11.0' 'Latest candidate baseline'
Assert-Equal ((@(Get-ValidatedBaselineVersions @() '0.11.0')) -join ',') '0.10.0' 'Historical rebuild baseline'
foreach ($duration in @(9999.999, 10000.0, 10000.001)) {
    $result = Get-UpgradePerformance @((New-Trial $duration)) 10000
    Assert-Equal $result.passed ($duration -lt 10000) "Strict limit at ${duration}ms"
    Assert-Equal $result.strictlyBelow $true 'Strict comparison evidence'
    Assert-Equal $result.trials.Count 1 'Raw trial retained'
    Assert-Equal $result.trials[0].elapsedMilliseconds $duration 'Unmodified raw duration'
}
$multiple = Get-UpgradePerformance @((New-Trial 9999), (New-Trial 10000)) 10000
Assert-Equal $multiple.passed $false 'Every trial must pass'
Assert-Equal $multiple.trials.Count 2 'No selection of favorable trials'
Assert-Equal (Get-UpgradePerformance @((New-Trial 10000)) 0) $null 'Historical disabled gate'
foreach ($invalid in @([double]::NaN, [double]::PositiveInfinity, -1)) {
    Assert-Throws { Get-UpgradePerformance @((New-Trial 1)) $invalid } 'Invalid time limit'
    Assert-Throws { Get-UpgradePerformance @((New-Trial $invalid)) 10000 } 'Invalid raw duration'
}
Assert-Throws { Get-UpgradePerformance @() 10000 } 'Missing complete trial'
$failed = New-Trial 1000
$failed.timings.targetUpgrade.ok = $false
Assert-Throws { Get-UpgradePerformance @($failed) 10000 } 'Failed installer cannot pass the time gate'
function New-ProfileTrial([string[]]$PayloadPhases = @(
    'extract-start', 'payload-verification-start', 'payload-verification-complete', 'extract-complete',
    'payload-copy-start', 'payload-copy-complete', 'payload-verification-start', 'payload-verification-complete', 'payload-complete'
)) {
    $pair = New-Trial 1000
    foreach ($operation in @('targetUpgrade', 'targetFreshInstall')) {
        $tick = 100
        $phases = @('installer-init', 'process-check-start', 'process-check-complete',
            'old-uninstaller-complete') + $PayloadPhases + @('cache-registration-shortcuts-complete')
        $records = @($phases | ForEach-Object { [pscustomobject]@{ phase = $_; uptimeMilliseconds = $tick++ } })
        $pair.timings[$operation] = [pscustomobject]@{
            kind = 'nsis'; ok = $true; elapsedMilliseconds = 1000
            installerTrace = [pscustomobject]@{
                emitted = $true; errors = @(); records = $records
                outerProcessUptime = @{ beforeLaunchMilliseconds = 99; afterExitMilliseconds = 200 }
            }
        }
    }
    return $pair
}
$profile = New-ProfileTrial
Assert-Equal (Get-InstallerProfilingValidation @($profile)).passed $true 'Complete native phase trace'
$profile.timings.targetUpgrade.installerTrace.records = @($profile.timings.targetUpgrade.installerTrace.records[-1])
Assert-Equal (Get-InstallerProfilingValidation @($profile)).passed $false 'Overwritten earlier rows fail profiling validation'
$profile = New-ProfileTrial
$profile.timings.targetFreshInstall.installerTrace.records[1].uptimeMilliseconds = 98
Assert-Equal (Get-InstallerProfilingValidation @($profile)).passed $false 'Nonmonotonic markers fail profiling validation'
$profile = New-ProfileTrial
$profile.timings.targetUpgrade.installerTrace.errors = @('Unrecognized raw marker')
Assert-Equal (Get-InstallerProfilingValidation @($profile)).passed $false 'Trace parser errors fail profiling validation'
$direct = @('payload-direct-start', 'extract-start', 'extract-complete',
    'payload-verification-start', 'payload-verification-complete', 'payload-direct-complete', 'payload-complete')
Assert-Equal (Get-InstallerProfilingValidation @((New-ProfileTrial $direct))).passed $true 'Complete verified direct route'
Assert-Equal (Get-InstallerPayloadRouteValidation $direct).route 'direct' 'Direct route retained in proof'
$stockStart = @('extract-start', 'payload-verification-start', 'payload-verification-complete', 'extract-complete')
$stockEnd = @('payload-verification-start', 'payload-verification-complete', 'payload-complete')
$copy = @('payload-copy-start', 'payload-copy-complete')
$retry = $stockStart + $copy + $copy + $stockEnd
Assert-Equal (Get-InstallerProfilingValidation @((New-ProfileTrial $retry))).passed $true 'Complete stock retry with intact verification'
$fallback = @('extract-fallback-cleanup-start', 'extract-fallback-cleanup-complete', 'extract-fallback-start', 'extract-fallback-complete')
$fiveCopies = @()
for ($attempt = 0; $attempt -lt 5; $attempt++) { $fiveCopies += $copy }
$stockFallback = $stockStart + $fiveCopies + $fallback + $stockEnd
Assert-Equal (Get-InstallerProfilingValidation @((New-ProfileTrial $stockFallback))).passed $true 'Five-copy stock fallback requires final verification'
$directFailed = $direct[0..4] + @('payload-direct-fallback')
$recovered = $directFailed + $stockStart + $copy + $stockEnd
Assert-Equal (Get-InstallerProfilingValidation @((New-ProfileTrial $recovered))).passed $true 'Failed direct verification followed by complete verified stock recovery'
Assert-Equal (Get-InstallerPayloadRouteValidation $recovered).route 'direct-fallback-stock' 'Fallback route retained in proof'
$invalidRoutes = @(
    @{ phases = @('payload-direct-start', 'extract-start', 'extract-complete', 'payload-direct-complete', 'payload-complete'); name = 'Direct route without payload verification' },
    @{ phases = @($direct | Where-Object { $_ -cne 'payload-verification-complete' }); name = 'Incomplete direct verification' },
    @{ phases = $direct[0..4] + $stockStart + $copy + $stockEnd; name = 'Direct recovery without fallback marker' },
    @{ phases = $stockStart + @('payload-copy-start') + $stockEnd; name = 'Incomplete stock copy attempt' },
    @{ phases = @('extract-start', 'extract-complete') + $copy + $stockEnd; name = 'Stock route without staged verification' },
    @{ phases = $stockStart + $copy + @('payload-complete'); name = 'Stock route without installed verification' },
    @{ phases = $stockStart + $copy + @('payload-verification-complete', 'payload-verification-start', 'payload-complete'); name = 'Reversed verification pair' },
    @{ phases = $stockStart + $copy + $fallback + $stockEnd; name = 'Fallback before all five copy attempts' },
    @{ phases = $stockStart + $fiveCopies + $copy + $stockEnd; name = 'More than five stock copy attempts' },
    @{ phases = $stockStart + $fiveCopies + $fallback[0..2] + $stockEnd; name = 'Incomplete stock extraction fallback' },
    @{ phases = $direct + $copy; name = 'Copy markers after a completed direct route' },
    @{ phases = @(); name = 'Missing payload route' }
)
foreach ($case in $invalidRoutes) {
    Assert-Equal (Get-InstallerProfilingValidation @((New-ProfileTrial $case.phases))).passed $false $case.name
}
$profile = New-ProfileTrial $direct
$profile.timings.targetUpgrade.installerTrace.records[3].phase = 'old-uninstaller-missing'
Assert-Equal (Get-InstallerProfilingValidation @($profile)).passed $false 'Upgrade must retain previous-version uninstaller completion'
$profile = New-ProfileTrial $direct
$records = $profile.timings.targetUpgrade.installerTrace.records
$old = $records[3]
$records = $records[0..2] + $records[4..10] + @($old) + $records[11..($records.Count - 1)]
$tick = 100
foreach ($record in $records) { $record.uptimeMilliseconds = $tick++ }
$profile.timings.targetUpgrade.installerTrace.records = $records
$validation = Get-InstallerProfilingValidation @($profile)
Assert-Equal $validation.passed $false 'Uninstaller completion must precede payload deployment'
Assert-Equal (@($validation.trials[0].errors | Where-Object { $_ -like 'Previous-version uninstaller marker outside*' }).Count -gt 0) $true 'Late uninstaller fails the lifecycle requirement'
$profile = New-ProfileTrial $direct
$profile.timings.targetFreshInstall.installerTrace.records = @()
Assert-Equal (Get-InstallerProfilingValidation @($profile)).passed $false 'An empty trace fails without discarding raw trial'
$traceDirectory = Join-Path ([IO.Path]::GetTempPath()) ('life-nsis-trace-parser-' + [Guid]::NewGuid().ToString('N'))
$null = New-Item -ItemType Directory -Path $traceDirectory
try {
    $tracePath = Join-Path $traceDirectory 'trial.tsv'
    $missing = Read-InstallerTrace $tracePath
    Assert-Equal $missing.emitted $false 'Published baseline without marker support'
    Assert-Equal $missing.errors.Count 0 'An absent optional marker is not an error'
    $raw = "init`t100`r`npayload-copied`t250`r`n"
    [IO.File]::WriteAllText($tracePath, $raw)
    $trace = Read-InstallerTrace $tracePath
    Assert-Equal $trace.raw $raw 'Unmodified raw trace retained'
    Assert-Equal $trace.records.Count 2 'Complete valid marker rows'
    Assert-Equal $trace.records[1].phase 'payload-copied' 'Marker phase'
    Assert-Equal $trace.records[1].uptimeMilliseconds 250 'Native clock reading'
    Assert-Equal $trace.errors.Count 0 'Valid markers have no parser errors'
    [IO.File]::WriteAllText($tracePath, "bad row`ninit`t999999999999999999999999999999`n")
    $invalid = Read-InstallerTrace $tracePath
    Assert-Equal $invalid.records.Count 0 'Invalid markers never invent clock values'
    Assert-Equal $invalid.errors.Count 2 'Malformed and overflowing raw markers are retained as errors'
} finally { Remove-Item -LiteralPath $traceDirectory -Recurse -Force }
Write-Host 'Windows latest-baseline and strict full-installer performance gate checks passed.'
