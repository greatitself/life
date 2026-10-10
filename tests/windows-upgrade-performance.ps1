param([string]$SourcePath = (Join-Path $PSScriptRoot 'windows-upgrade.ps1'))

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'
$tokens = $null
$errors = $null
$syntax = [Management.Automation.Language.Parser]::ParseFile((Resolve-Path $SourcePath).Path, [ref]$tokens, [ref]$errors)
if ($errors.Count -ne 0) { throw "Windows upgrade script has syntax errors: $errors" }
# Parse and import only pure validation functions; never invoke an installer or cleanup.
foreach ($name in @('Get-ValidatedBaselineVersions', 'Get-UpgradePerformance')) {
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
Write-Host 'Windows latest-baseline and strict full-installer performance gate checks passed.'
