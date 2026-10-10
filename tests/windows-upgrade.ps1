param(
    [Parameter(Mandatory = $true)]
    [string]$Installer,
    [string]$ExpectedVersion,
    [Alias('BaselineVersion')]
    [string[]]$BaselineVersions = @(),
    [string]$ProofPath = 'output/windows-upgrade-proof.json',
    [double]$MaxUpgradeMilliseconds = 0,
    [switch]$CaptureInstallerTrace
)

# This destructive installer smoke test belongs only on a disposable Windows CI runner.
# NSIS /S is case-sensitive: https://nsis.sourceforge.io/Docs/Chapter3.html
# electron-builder derives the registration GUID from appId and keeps data on upgrades:
# https://www.electron.build/docs/nsis/
Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'
trap {
    [Console]::Error.WriteLine("Life installer upgrade test failed: $($_.Exception.Message)")
    [Console]::Error.WriteLine($_.ScriptStackTrace)
    throw $_
}
if (-not $IsWindows -or $env:GITHUB_ACTIONS -ne 'true') {
    throw 'Run this installer upgrade test only on a disposable GitHub Actions Windows runner.'
}
if (-not [double]::IsFinite($MaxUpgradeMilliseconds) -or $MaxUpgradeMilliseconds -lt 0) {
    throw 'The optional upgrade time limit must be finite and nonnegative; zero disables it.'
}

$Installer = (Resolve-Path -LiteralPath $Installer).Path
if ([IO.Path]::GetExtension($Installer) -ne '.exe') { throw 'Installer must be a Windows .exe.' }
if (-not $ExpectedVersion) {
    $package = Get-Content -Raw -LiteralPath (Join-Path $PSScriptRoot '../package.json') | ConvertFrom-Json
    $ExpectedVersion = [string]$package.version
}

function Get-ValidatedBaselineVersions([string[]]$Versions, [string]$TargetVersion) {
    if ($TargetVersion -notmatch '^\d+\.\d+\.\d+$') {
        throw 'The target must be a stable three-part Life release version.'
    }
    if (-not $Versions -or $Versions.Count -eq 0) {
        # The default matches release CI: test only the latest published predecessor.
        $latest = @('0.1.0', '0.5.1', '0.6.0', '0.7.0', '0.8.0', '0.9.0', '0.10.0', '0.11.0') |
            Where-Object { [version]$_ -lt [version]$TargetVersion } |
            Sort-Object { [version]$_ } -Descending |
            Select-Object -First 1
        if (-not $latest) { throw 'No preceding known release exists for this upgrade target.' }
        $Versions = @($latest)
    }
    $seen = [Collections.Generic.HashSet[string]]::new([StringComparer]::Ordinal)
    foreach ($version in $Versions) {
        if (-not $version -or $version -notmatch '^\d+\.\d+\.\d+$') {
            throw "Invalid baseline release '$version'. Use a stable three-part version."
        }
        if (-not $seen.Add($version)) { throw "Duplicate baseline release '$version'." }
        if ([version]$version -ge [version]$TargetVersion) {
            throw "Baseline $version must be older than target $TargetVersion."
        }
        $version
    }
}

function Get-UpgradePerformance([object[]]$Pairs, [double]$MaximumMilliseconds) {
    if (-not [double]::IsFinite($MaximumMilliseconds) -or $MaximumMilliseconds -lt 0) {
        throw 'Invalid upgrade performance limit.'
    }
    if ($MaximumMilliseconds -eq 0) { return $null }
    if (-not $Pairs -or $Pairs.Count -eq 0) { throw 'An upgrade performance gate requires a complete trial.' }
    $trials = [Collections.Generic.List[object]]::new()
    foreach ($pair in $Pairs) {
        $timing = $pair.timings.targetUpgrade
        if (-not $pair.ok -or -not $timing.ok -or $timing.kind -ne 'nsis' -or
            -not [double]::IsFinite($timing.elapsedMilliseconds) -or $timing.elapsedMilliseconds -lt 0) {
            throw 'An upgrade performance gate requires a successful complete installer timing.'
        }
        $trials.Add([pscustomobject]@{
            baselineVersion = $pair.baselineVersion; targetVersion = $pair.targetVersion
            elapsedMilliseconds = $timing.elapsedMilliseconds
            passed = $timing.elapsedMilliseconds -lt $MaximumMilliseconds
        })
    }
    return [pscustomobject]@{
        maximumMilliseconds = $MaximumMilliseconds; strictlyBelow = $true
        passed = @($trials | Where-Object { -not $_.passed }).Count -eq 0
        trials = $trials.ToArray()
        scope = 'Complete NSIS installer launch through exit, including synchronous previous-version cleanup; no elapsed time is subtracted.'
    }
}

function Get-InstallerProfilingValidation([object[]]$Pairs) {
    $trials = [Collections.Generic.List[object]]::new()
    $required = @('installer-init', 'process-check-start', 'process-check-complete',
        'extract-start', 'extract-complete', 'payload-copy-start', 'payload-copy-complete',
        'payload-complete', 'cache-registration-shortcuts-complete')
    foreach ($pair in $Pairs) {
        foreach ($operation in @('targetUpgrade', 'targetFreshInstall')) {
            $trace = $pair.timings.$operation.installerTrace
            $errors = [Collections.Generic.List[string]]::new()
            foreach ($errorMessage in $trace.errors) { $errors.Add($errorMessage) }
            $records = @($trace.records)
            $names = @($records | ForEach-Object { $_.phase })
            foreach ($phase in $required) {
                if ($phase -notin $names) { $errors.Add("Missing required marker: $phase") }
            }
            if ($operation -eq 'targetUpgrade' -and
                'old-uninstaller-complete' -notin $names -and 'old-user-uninstaller-complete' -notin $names) {
                $errors.Add('Missing previous-version uninstaller completion marker.')
            }
            if (-not $trace.emitted) { $errors.Add('The target installer emitted no trace file.') }
            if ($records.Count -gt 0 -and $records[0].phase -ne 'installer-init') {
                $errors.Add('The first retained marker must be installer-init.')
            }
            $previous = $trace.outerProcessUptime.beforeLaunchMilliseconds
            foreach ($record in $records) {
                if ($record.uptimeMilliseconds -lt $previous -or
                    $record.uptimeMilliseconds -gt $trace.outerProcessUptime.afterExitMilliseconds) {
                    $errors.Add("Marker outside monotonic outer uptime interval: $($record.phase)")
                }
                $previous = $record.uptimeMilliseconds
            }
            $trials.Add([pscustomobject]@{
                baselineVersion = $pair.baselineVersion; targetVersion = $pair.targetVersion
                operation = $operation; passed = $errors.Count -eq 0
                requiredMarkers = $required; errors = $errors.ToArray()
            })
        }
    }
    return [pscustomobject]@{
        passed = $trials.Count -gt 0 -and @($trials | Where-Object { -not $_.passed }).Count -eq 0
        trials = $trials.ToArray()
        scope = 'Target marker completeness and monotonic native uptime; full raw installer timing and functional checks are unchanged.'
    }
}

$BaselineVersions = @(Get-ValidatedBaselineVersions $BaselineVersions $ExpectedVersion)

# electron-builder UUID v5 for appId dev.life.desktop, namespace
# 50e065bc-3134-11e6-9bab-38c9862bdaf3. This must stay stable after the first release.
$script:LifeInstallGuid = 'c341d2d7-15bb-5180-bedb-0a3c99a55fe4'
$script:PhaseTimings = [Collections.Generic.List[object]]::new()

function Invoke-TimedPhase([string]$Name, [scriptblock]$Action) {
    $startedAt = [DateTime]::UtcNow.ToString('o')
    $watch = [Diagnostics.Stopwatch]::StartNew()
    $succeeded = $false
    try {
        & $Action
        $succeeded = $true
    } finally {
        $watch.Stop()
        $script:PhaseTimings.Add([pscustomobject]@{
            name = $Name; kind = 'verification'; ok = $succeeded
            startedAt = $startedAt; finishedAt = [DateTime]::UtcNow.ToString('o')
            elapsedMilliseconds = [Math]::Round($watch.Elapsed.TotalMilliseconds, 3)
        })
    }
}

function Read-RegistryValue($Record, [string]$Name) {
    # An empty registry key makes Get-ItemProperty return no object. Unrelated
    # uninstall keys can be empty; skip them before inspecting adapted members.
    if ($null -eq $Record) { return '' }
    $property = $Record.PSObject.Properties[$Name]
    if ($null -eq $property) { return '' }
    return [string]$property.Value
}

function Get-LifeRegistrations {
    # Check both user/machine scopes and native/32-bit keys to catch accidental parallel installs.
    foreach ($hive in @('HKCU', 'HKLM')) {
        foreach ($prefix in @('Software', 'Software\WOW6432Node')) {
            $root = "${hive}:\$prefix\Microsoft\Windows\CurrentVersion\Uninstall"
            if (-not (Test-Path -LiteralPath $root)) { continue }
            foreach ($key in Get-ChildItem -LiteralPath $root) {
                $record = Get-ItemProperty -LiteralPath $key.PSPath
                $guid = $key.PSChildName.Trim('{}')
                $name = Read-RegistryValue $record 'DisplayName'
                # NSIS defaults to a versioned name such as "Life 0.1.0". The
                # GUID is the installation identity; names also detect a parallel
                # Life install accidentally created with a different appId.
                $stableIdentity = $guid -eq $script:LifeInstallGuid
                $lifeName = $name -match '^Life(?:$|\s+\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]+)?$)'
                if (-not $stableIdentity -and -not $lifeName) { continue }
                $location = Read-RegistryValue $record 'InstallLocation'
                # electron-builder stores InstallLocation in Software\{app GUID}, separately
                # from the Programs and Features uninstall registration.
                if (-not $location) {
                    $appKey = "${hive}:\$prefix\$($key.PSChildName)"
                    if (Test-Path -LiteralPath $appKey) {
                        $location = Read-RegistryValue (Get-ItemProperty -LiteralPath $appKey) 'InstallLocation'
                    }
                }
                $icon = (Read-RegistryValue $record 'DisplayIcon').Trim()
                $icon = ($icon -replace ',\s*-?\d+$', '').Trim('"')
                $icon = [Environment]::ExpandEnvironmentVariables($icon)
                $executable = ''
                if ($icon -and [IO.Path]::GetExtension($icon) -eq '.exe') {
                    $executable = $icon
                    if (-not $location) { $location = Split-Path -Parent $icon }
                }
                if (-not $location) {
                    $uninstall = Read-RegistryValue $record 'UninstallString'
                    if ($uninstall -match '^"([^"]+\.exe)"') {
                        $location = Split-Path -Parent $Matches[1]
                    }
                }
                if (-not $executable -and $location) {
                    # An optional custom uninstaller icon can make DisplayIcon an .ico file.
                    $candidates = @(Get-ChildItem -LiteralPath $location -Filter '*.exe' -File |
                        Where-Object { $_.Name -notmatch '^Uninstall' })
                    if ($candidates.Count -eq 1) { $executable = $candidates[0].FullName }
                }
                [pscustomobject]@{
                    Key = "${hive}:\$prefix\Microsoft\Windows\CurrentVersion\Uninstall\$($key.PSChildName)"
                    Guid = $guid
                    Name = $name
                    Hive = $hive
                    Version = Read-RegistryValue $record 'DisplayVersion'
                    Location = $location
                    Executable = $executable
                }
            }
        }
    }
}

function Assert-SingleLifeInstallation([string]$Version) {
    $registrations = @(Get-LifeRegistrations)
    if ($registrations.Count -ne 1) {
        throw "Expected one Life installation; found $($registrations.Count): $($registrations | ConvertTo-Json -Compress)"
    }
    $registration = $registrations[0]
    if ($registration.Guid -ne $script:LifeInstallGuid -or
        $registration.Hive -ne 'HKCU' -or $registration.Version -ne $Version) {
        throw "Expected per-user Life $Version; found $($registration | ConvertTo-Json -Compress)"
    }
    if (-not $registration.Location -or -not $registration.Executable -or
        -not (Test-Path -LiteralPath $registration.Executable -PathType Leaf)) {
        throw "Installed Life executable or location could not be resolved: $($registration | ConvertTo-Json -Compress)"
    }
    $binaryVersion = (Get-Item -LiteralPath $registration.Executable).VersionInfo.ProductVersion
    # Life.exe uses Windows' four-part ProductVersion (e.g. 0.1.0.0), while
    # package.json and the uninstall registration use the three-part release version.
    # Compare the release components without mistaking the numeric build for a patch.
    $releaseVersion = $binaryVersion
    if ($binaryVersion -match '^(\d+\.\d+\.\d+)\.\d+$') {
        $releaseVersion = $Matches[1]
    }
    if ($releaseVersion -ne $Version) {
        throw "Registry says Life $Version, but the installed executable reports '$binaryVersion'."
    }
    return $registration
}

function Stop-InstalledLife([string]$Executable) {
    $expected = [IO.Path]::GetFullPath($Executable)
    foreach ($process in Get-Process) {
        try { $path = $process.Path } catch { continue }
        if ($path -and [string]::Equals([IO.Path]::GetFullPath($path), $expected,
                [StringComparison]::OrdinalIgnoreCase)) {
            # Kill only processes from the verified installation, including Electron children.
            Stop-Process -Id $process.Id -Force -ErrorAction SilentlyContinue
            $null = $process.WaitForExit(10000)
        }
    }
}

function Read-InstallerTrace([string]$Path) {
    $records = [Collections.Generic.List[object]]::new()
    $errors = [Collections.Generic.List[string]]::new()
    $raw = $null
    $emitted = $false
    try {
        $emitted = Test-Path -LiteralPath $Path -PathType Leaf
        if ($emitted) {
            $raw = [IO.File]::ReadAllText($Path)
            foreach ($line in ($raw -split '\r?\n')) {
                if (-not $line) { continue }
                if ($line -notmatch '^(?<phase>[A-Za-z0-9_.:-]+)\t(?<ticks>\d+)$') {
                    $errors.Add("Unrecognized trace row: $line")
                    continue
                }
                $uptime = [long]0
                if (-not [long]::TryParse($Matches['ticks'], [ref]$uptime) -or $uptime -lt 0) {
                    $errors.Add("Invalid uptime trace row: $line")
                    continue
                }
                $records.Add([pscustomobject]@{
                    phase = $Matches['phase']; uptimeMilliseconds = $uptime
                })
            }
        }
    } catch { $errors.Add($_.Exception.Message) }
    return [pscustomobject]@{
        clock = 'kernel32.GetTickCount64'; requested = $true; emitted = $emitted
        filename = [IO.Path]::GetFileName($Path); raw = $raw
        records = $records.ToArray(); errors = $errors.ToArray()
        scope = 'Optional installer markers only; authoritative NSIS launch-to-exit timing is unchanged.'
    }
}

function Invoke-Nsis([string]$Path, [string]$Arguments, [string]$Description, [string]$Phase) {
    $options = @{
        FilePath = $Path; ArgumentList = $Arguments
        WorkingDirectory = [IO.Path]::GetTempPath(); PassThru = $true
    }
    $tracePath = $null
    if ($CaptureInstallerTrace) {
        $tracePath = Join-Path $downloadDirectory ('nsis-trace-' + [Guid]::NewGuid().ToString('N') + '.tsv')
        # Supply only this child's test-owned trace path; parent/global settings stay unchanged.
        $options.Environment = @{ LIFE_NSIS_TRACE_FILE = $tracePath }
    }
    $startedAt = [DateTime]::UtcNow.ToString('o')
    $uptimeBeforeLaunch = [Environment]::TickCount64
    $watch = [Diagnostics.Stopwatch]::StartNew()
    $process = $null
    $processId = $null
    $exitCode = $null
    $succeeded = $false
    try {
        $process = Start-Process @options
        $processId = $process.Id
        if (-not $process.WaitForExit(300000)) {
            # Terminate only the installer started by this test if a prompt or failure hangs it.
            $process.Kill()
            $null = $process.WaitForExit(10000)
            throw "$Description did not finish within five minutes."
        }
        $process.Refresh()
        $exitCode = $process.ExitCode
        if ($process.ExitCode -ne 0) { throw "$Description failed with exit code $($process.ExitCode)." }
        $succeeded = $true
    } finally {
        $watch.Stop()
        $uptimeAfterExit = [Environment]::TickCount64
        if ($null -ne $process) { $process.Dispose() }
        $timing = [pscustomobject]@{
            name = $Phase; kind = 'nsis'; ok = $succeeded
            startedAt = $startedAt; finishedAt = [DateTime]::UtcNow.ToString('o')
            elapsedMilliseconds = [Math]::Round($watch.Elapsed.TotalMilliseconds, 3)
            processId = $processId; exitCode = $exitCode
            installer = [IO.Path]::GetFileName($Path)
        }
        if ($tracePath) {
            # Read telemetry after process completion; retain raw records before owned temp cleanup.
            $trace = Read-InstallerTrace $tracePath
            $trace | Add-Member -NotePropertyName outerProcessUptime -NotePropertyValue ([pscustomobject]@{
                clock = 'Environment.TickCount64 (Windows native system uptime)'
                beforeLaunchMilliseconds = $uptimeBeforeLaunch; afterExitMilliseconds = $uptimeAfterExit
                scope = 'Samples immediately bracket the authoritative Stopwatch interval. Comparison with GetTickCount64 markers includes sampling and native clock tick-resolution offsets; no time is subtracted.'
            })
            $timing | Add-Member -NotePropertyName installerTrace -NotePropertyValue $trace
        }
        $script:PhaseTimings.Add($timing)
        Write-Host "$Phase elapsed=$($timing.elapsedMilliseconds)ms success=$succeeded."
    }
    return $timing
}

function Install-Life([string]$Path, [string]$Phase) {
    Write-Host "Installing $([IO.Path]::GetFileName($Path)) with the default per-user NSIS installation."
    # The NSIS stub waits for installation/uninstallation. /S suppresses app startup.
    return Invoke-Nsis $Path '/S' 'NSIS installer' $Phase
}

function Get-LifeAppKeys {
    foreach ($hive in @('HKCU', 'HKLM')) {
        foreach ($prefix in @('Software', 'Software\WOW6432Node')) {
            foreach ($leaf in @($script:LifeInstallGuid, "{$script:LifeInstallGuid}")) {
                $key = "${hive}:\$prefix\$leaf"
                if (Test-Path -LiteralPath $key) { $key }
            }
        }
    }
}

function Assert-CleanLifeRunner {
    if (@(Get-LifeRegistrations).Count -ne 0 -or @(Get-LifeAppKeys).Count -ne 0) {
        throw 'The disposable CI runner already has Life installed; refusing to modify an existing installation.'
    }
    foreach ($path in @($script:DefaultInstallPath, $script:LifeUserData, $script:LegacyUserData)) {
        if (Test-Path -LiteralPath $path) {
            throw "The disposable CI runner already contains Life files at '$path'; refusing to modify them."
        }
    }
}

function Assert-PathEqual([string]$Actual, [string]$Expected, [string]$Description) {
    if (-not [string]::Equals([IO.Path]::GetFullPath($Actual).TrimEnd('\'),
            [IO.Path]::GetFullPath($Expected).TrimEnd('\'), [StringComparison]::OrdinalIgnoreCase)) {
        throw "$Description changed from '$Expected' to '$Actual'."
    }
}

function Measure-LifeInstalledFiles([string]$Location) {
    Assert-PathEqual $Location $script:DefaultInstallPath 'Measured per-user installation'
    $files = @(Get-ChildItem -LiteralPath $Location -File -Recurse -Force)
    if ($files.Count -eq 0) { throw 'The installed Life directory contains no files.' }
    return [pscustomobject]@{
        fileCount = $files.Count
        fileBytes = [long](($files | Measure-Object -Property Length -Sum).Sum)
        scope = 'Filesystem files in the installation directory only; excludes user data. Bytes sum file lengths, not allocated disk clusters.'
    }
}

function Download-BaselineInstaller([string]$Version, [string]$Directory) {
    $path = Join-Path $Directory "Life-$Version-win-x64.exe"
    $url = "https://github.com/greatitself/life/releases/download/v$Version/Life-$Version-win-x64.exe"
    $downloaded = $false
    for ($attempt = 1; $attempt -le 4; $attempt++) {
        try {
            Invoke-WebRequest -Uri $url -OutFile $path -TimeoutSec 120
            if ((Get-Item -LiteralPath $path).Length -lt 1MB) {
                throw 'The baseline installer download is unexpectedly small.'
            }
            $downloaded = $true
            break
        } catch {
            if ($attempt -eq 4) { throw "Could not download required v$Version baseline after four attempts: $_" }
            Write-Warning "Baseline download attempt $attempt failed; retrying."
            Start-Sleep -Seconds (3 * $attempt)
        }
    }
    if (-not $downloaded) { throw 'The required baseline installer was not downloaded.' }
    return $path
}

function Assert-TestOwnedData([string]$OwnershipToken) {
    if (-not (Test-Path -LiteralPath $script:OwnershipMarker -PathType Leaf) -or
        (Get-Content -Raw -LiteralPath $script:OwnershipMarker).Trim() -ne $OwnershipToken) {
        throw 'The CI ownership marker is missing or changed; refusing to clean Life data.'
    }
    $items = @(Get-Item -LiteralPath $script:LifeUserData -Force)
    $items += @(Get-ChildItem -LiteralPath $script:LifeUserData -Recurse -Force)
    if (@($items | Where-Object { $_.Attributes -band [IO.FileAttributes]::ReparsePoint }).Count -ne 0) {
        throw 'Test-created Life data contains a reparse point; refusing recursive cleanup.'
    }
}

function Clear-TestCreatedLife($Registration, [string]$OwnershipToken, [string]$Directory) {
    # Ownership begins only after the preflight found no Life installation or data,
    # and the baseline/target pair succeeded at these exact default paths.
    Assert-PathEqual $Registration.Location $script:DefaultInstallPath 'CI installation location'
    Assert-PathEqual $Registration.Executable (Join-Path $script:DefaultInstallPath 'Life.exe') 'CI executable path'
    Assert-TestOwnedData $OwnershipToken
    $current = Assert-SingleLifeInstallation $ExpectedVersion
    if (-not [string]::Equals($current.Key, $Registration.Key, [StringComparison]::OrdinalIgnoreCase)) {
        throw 'The CI installation registration changed before cleanup.'
    }
    foreach ($property in @('Location', 'Executable')) {
        Assert-PathEqual $current.$property $Registration.$property "CI installation $property"
    }
    Stop-InstalledLife $Registration.Executable
    $uninstall = Read-RegistryValue (Get-ItemProperty -LiteralPath $Registration.Key) 'UninstallString'
    if ($uninstall -notmatch '^"([^"\r\n]+\.exe)"(?:\s|$)') {
        throw 'The test installation has no quoted NSIS uninstaller path.'
    }
    $uninstaller = $Matches[1]
    Assert-PathEqual (Split-Path -Parent $uninstaller) $Registration.Location 'CI uninstaller location'
    if (-not (Test-Path -LiteralPath $uninstaller -PathType Leaf)) {
        throw 'The test-created NSIS uninstaller is missing.'
    }
    # Match electron-builder's synchronous uninstall flow. Copy the executable out
    # of the installation, keep app data, and leave _?= last and unquoted.
    $copy = Join-Path $Directory ('reset-' + [Guid]::NewGuid().ToString('N') + '.exe')
    Copy-Item -LiteralPath $uninstaller -Destination $copy
    $null = Invoke-Nsis $copy "/S /KEEP_APP_DATA /currentuser --updated _?=$($Registration.Location)" 'CI-only NSIS cleanup' 'cleanup-nsis'
    if (@(Get-LifeRegistrations).Count -ne 0 -or @(Get-LifeAppKeys).Count -ne 0 -or
        (Test-Path -LiteralPath $Registration.Location)) {
        throw 'CI-only NSIS cleanup left installation files or registration; refusing another baseline.'
    }
    Assert-TestOwnedData $OwnershipToken
    Remove-Item -LiteralPath $script:LifeUserData -Recurse -Force
    Assert-CleanLifeRunner
    Write-Host 'Removed only the successful test-created installation and owned data before the next baseline.'
}

function New-TestOwnedLifeData([string]$BaselineVersion, [string]$OwnershipToken) {
    $userData = $script:LifeUserData
    $null = New-Item -ItemType Directory -Path $userData -Force
    Set-Content -LiteralPath $script:OwnershipMarker -Value $OwnershipToken -Encoding utf8NoBOM
    $marker = Join-Path $userData 'upgrade-smoke.txt'
    if (Test-Path -LiteralPath $marker) { throw 'Unexpected upgrade marker already exists on this runner.' }
    Set-Content -LiteralPath $marker -Value ([Guid]::NewGuid().ToString()) -Encoding utf8NoBOM
    $connections = Join-Path $userData 'connections.json'
    # These files are all created by this CI pair. A real profile/trust entry, a
    # sentinel in Chromium's history storage directory, and a valid portable source
    # extension cover the data locations an installer must preserve.
    $sentinel = @{
        profiles = @(@{
            id = 'upgrade-smoke'; name = 'Preserved research machine'; host = 'research.example.invalid'
            port = 22; username = 'researcher'; auth = 'key'; privateKeyPath = ''; workspace = '~/research'
        })
        knownHosts = @{ 'research.example.invalid:22' = 'SHA256:upgrade-smoke' }
    }
    $sentinel | ConvertTo-Json -Depth 6 | Set-Content -LiteralPath $connections -Encoding utf8NoBOM
    $null = Get-Content -Raw -LiteralPath $connections | ConvertFrom-Json
    $historyDirectory = Join-Path $userData 'Local Storage/leveldb'
    $sourceDirectory = Join-Path $userData 'source-code'
    $null = New-Item -ItemType Directory -Path $historyDirectory, $sourceDirectory -Force
    $history = Join-Path $historyDirectory 'upgrade-smoke.sentinel'
    @{ thread = 'Preserved research conversation'; baseline = $BaselineVersion; token = $OwnershipToken } |
        ConvertTo-Json | Set-Content -LiteralPath $history -Encoding utf8NoBOM
    $source = Join-Path $sourceDirectory 'upgrade-smoke.life-extension.json'
    $createdAt = [DateTime]::UtcNow.ToString('o')
    @{
        format = 'life-extension'; formatVersion = 1; kind = 'source'
        extension = @{
            format = 'life-source-extension'; formatVersion = 1; id = 'upgrade-smoke'
            name = 'Preserved source extension'; description = 'CI-only exported source extension sentinel'
            version = '1.0.0'; createdAt = $createdAt; updatedAt = $createdAt; dependencies = @{}
            files = @(@{ path = 'src/renderer/UpgradeSmoke.css'; kind = 'create'; content = '.upgrade-smoke { color: inherit; }' })
        }
    } | ConvertTo-Json -Depth 8 | Set-Content -LiteralPath $source -Encoding utf8NoBOM
    $dataFiles = @{
        connections = $connections; marker = $marker; historyStorageSentinel = $history
        exportedSourceExtension = $source; ownership = $script:OwnershipMarker
    }
    $savedData = @{}
    foreach ($name in $dataFiles.Keys) {
        $savedData[$name] = @{
            path = $dataFiles[$name]
            beforeSHA256 = (Get-FileHash -LiteralPath $dataFiles[$name] -Algorithm SHA256).Hash
        }
    }
    return $savedData
}

function Test-LifeUpgradePair([string]$BaselineVersion, [string]$Directory, [string]$OwnershipToken) {
    Assert-CleanLifeRunner
    $startedAt = [DateTime]::UtcNow.ToString('o')
    $baselineInstaller = Invoke-TimedPhase "baseline-download:$BaselineVersion" { Download-BaselineInstaller $BaselineVersion $Directory }
    $baselineInstallerHash = Invoke-TimedPhase "baseline-installer-hash:$BaselineVersion" { (Get-FileHash -LiteralPath $baselineInstaller -Algorithm SHA256).Hash }
    $baselineFreshInstall = Install-Life $baselineInstaller "baseline-fresh-install:$BaselineVersion"
    $before = Invoke-TimedPhase "baseline-registration:$BaselineVersion" { Assert-SingleLifeInstallation $BaselineVersion }
    Assert-PathEqual $before.Location $script:DefaultInstallPath 'Default per-user installation'
    Assert-PathEqual $before.Executable (Join-Path $script:DefaultInstallPath 'Life.exe') 'Default per-user executable'
    Write-Host ("Verified baseline registration: " + ($before | ConvertTo-Json -Compress))
    Stop-InstalledLife $before.Executable
    $baselineLayout = Invoke-TimedPhase "baseline-installed-file-layout:$BaselineVersion" { Measure-LifeInstalledFiles $before.Location }
    $binaryHashBefore = (Get-FileHash -LiteralPath $before.Executable -Algorithm SHA256).Hash
    $binaryVersionBefore = (Get-Item -LiteralPath $before.Executable).VersionInfo.ProductVersion
    $savedData = Invoke-TimedPhase "test-data-preparation:$BaselineVersion" { New-TestOwnedLifeData $BaselineVersion $OwnershipToken }

    $targetUpgrade = Install-Life $Installer "target-upgrade:${BaselineVersion}->${ExpectedVersion}"
    $after = Invoke-TimedPhase "target-upgrade-registration:$ExpectedVersion" { Assert-SingleLifeInstallation $ExpectedVersion }
    Write-Host ("Verified upgraded registration: " + ($after | ConvertTo-Json -Compress))
    Stop-InstalledLife $after.Executable
    $upgradedLayout = Invoke-TimedPhase "target-upgrade-installed-file-layout:$ExpectedVersion" { Measure-LifeInstalledFiles $after.Location }
    $binaryHashAfter = (Get-FileHash -LiteralPath $after.Executable -Algorithm SHA256).Hash
    $binaryVersionAfter = (Get-Item -LiteralPath $after.Executable).VersionInfo.ProductVersion
    if ($binaryHashAfter -eq $binaryHashBefore) {
        throw 'The upgrade did not replace the installed Life executable.'
    }
    foreach ($property in @('Key', 'Location', 'Executable')) {
        if (-not [string]::Equals($before.$property, $after.$property, [StringComparison]::OrdinalIgnoreCase)) {
            throw "Upgrade changed $property from '$($before.$property)' to '$($after.$property)'."
        }
    }
    foreach ($name in $savedData.Keys) {
        $file = $savedData[$name].path
        if (-not (Test-Path -LiteralPath $file -PathType Leaf)) {
            throw "Upgrade removed existing $name data."
        }
        $hash = (Get-FileHash -LiteralPath $file -Algorithm SHA256).Hash
        if ($hash -ne $savedData[$name].beforeSHA256) { throw "Upgrade changed existing $name data." }
        $savedData[$name]['afterSHA256'] = $hash
    }
    Write-Host "Preserved connections.json SHA256=$($savedData.connections.beforeSHA256) and upgrade marker SHA256=$($savedData.marker.beforeSHA256)."
    Write-Host ("Preserved history storage/source extension sentinels: " + ($savedData | ConvertTo-Json -Depth 4 -Compress))
    Write-Host "Verified Life $BaselineVersion -> ${ExpectedVersion}: same installation, one registration, saved user data preserved."

    # Measure the target fresh install only after the upgrade and all preservation
    # checks succeed. Cleanup remains restricted to this test's owned installation
    # and data; no Defender exclusions, cache flushes, or global settings change.
    Invoke-TimedPhase "cleanup-before-target-fresh:$ExpectedVersion" { Clear-TestCreatedLife $after $OwnershipToken $Directory }
    $targetFreshInstall = Install-Life $Installer "target-fresh-install:$ExpectedVersion"
    $fresh = Invoke-TimedPhase "target-fresh-registration:$ExpectedVersion" { Assert-SingleLifeInstallation $ExpectedVersion }
    foreach ($property in @('Key', 'Location', 'Executable')) {
        if (-not [string]::Equals($after.$property, $fresh.$property, [StringComparison]::OrdinalIgnoreCase)) {
            throw "Fresh target installation changed $property from '$($after.$property)' to '$($fresh.$property)'."
        }
    }
    Stop-InstalledLife $fresh.Executable
    $freshLayout = Invoke-TimedPhase "target-fresh-installed-file-layout:$ExpectedVersion" { Measure-LifeInstalledFiles $fresh.Location }
    # Keep a fresh set of owned fixture data with the final installation so that
    # another explicit baseline can still be cleaned safely, and CI retains evidence.
    $freshData = Invoke-TimedPhase "target-fresh-data:$ExpectedVersion" { New-TestOwnedLifeData $BaselineVersion $OwnershipToken }
    Write-Host ("Verified fresh target registration: " + ($fresh | ConvertTo-Json -Compress))
    return [pscustomobject]@{
        ok = $true; baselineVersion = $BaselineVersion; targetVersion = $ExpectedVersion
        startedAt = $startedAt; finishedAt = [DateTime]::UtcNow.ToString('o')
        baseline = $before; upgraded = $after; oneRegistration = $true
        baselineProductVersion = $binaryVersionBefore
        upgradedProductVersion = $binaryVersionAfter
        installedBinaryBeforeSHA256 = $binaryHashBefore; installedBinaryAfterSHA256 = $binaryHashAfter
        baselineInstallerSHA256 = $baselineInstallerHash
        baselineInstallerBytes = (Get-Item -LiteralPath $baselineInstaller).Length
        targetInstallerBytes = (Get-Item -LiteralPath $Installer).Length
        installedFiles = @{ baseline = $baselineLayout; upgraded = $upgradedLayout; freshTarget = $freshLayout }
        preservedData = $savedData
        freshTarget = @{ registration = $fresh; oneRegistration = $true; ownedData = $freshData }
        timings = @{
            baselineFreshInstall = $baselineFreshInstall
            targetUpgrade = $targetUpgrade
            targetFreshInstall = $targetFreshInstall
        }
    }
}

$script:DefaultInstallPath = Join-Path $env:LOCALAPPDATA 'Programs/life-desktop'
$script:LifeUserData = Join-Path $env:APPDATA 'Life'
$script:LegacyUserData = Join-Path $env:APPDATA 'life-desktop'
$script:OwnershipMarker = Join-Path $script:LifeUserData '.life-ci-upgrade-owner'
Assert-CleanLifeRunner

$downloadDirectory = Join-Path ([IO.Path]::GetTempPath()) ('life-upgrade-' + [Guid]::NewGuid().ToString('N'))
$null = New-Item -ItemType Directory -Path $downloadDirectory
$pairs = [Collections.Generic.List[object]]::new()
$startedAt = [DateTime]::UtcNow.ToString('o')
$succeeded = $false
$functionalValidationPassed = $false
$performanceGate = $null
$profilingValidation = $null
$failure = $null
try {
    foreach ($baselineVersion in $BaselineVersions) {
        $token = [Guid]::NewGuid().ToString('N')
        $pair = Test-LifeUpgradePair $baselineVersion $downloadDirectory $token
        $pairs.Add($pair)
        if ($pairs.Count -lt $BaselineVersions.Count) {
            Clear-TestCreatedLife $pair.upgraded $token $downloadDirectory
        }
    }
    if ($pairs.Count -ne $BaselineVersions.Count) { throw 'Not every requested baseline produced an upgrade proof.' }
    $functionalValidationPassed = $true
    $performanceGate = Get-UpgradePerformance $pairs.ToArray() $MaxUpgradeMilliseconds
    if ($CaptureInstallerTrace) {
        $profilingValidation = Get-InstallerProfilingValidation $pairs.ToArray()
        if (-not $profilingValidation.passed) {
            $traceFailures = ($profilingValidation.trials | ForEach-Object { "$($_.operation): $($_.errors -join '; ')" }) -join ', '
            throw "NSIS profiling validation failed: $traceFailures. Complete raw installer timing and functional proof are retained."
        }
    }
    if ($null -ne $performanceGate -and -not $performanceGate.passed) {
        $rawDurations = ($performanceGate.trials | ForEach-Object { "$($_.baselineVersion)->$($_.targetVersion): $($_.elapsedMilliseconds)ms" }) -join ', '
        throw "Windows upgrade must finish strictly below ${MaxUpgradeMilliseconds}ms; raw trial: $rawDurations. All installation identity and saved-data checks passed."
    }
    $succeeded = $true
} catch {
    $failure = $_.Exception.Message
    throw
} finally {
    $proof = [pscustomobject]@{
        ok = $succeeded; failure = $failure
        functionalValidationPassed = $functionalValidationPassed; performanceGate = $performanceGate
        profilingValidation = $profilingValidation
        targetVersion = $ExpectedVersion; baselineVersions = $BaselineVersions
        installerSHA256 = (Get-FileHash -LiteralPath $Installer -Algorithm SHA256).Hash
        startedAt = $startedAt; completedAt = [DateTime]::UtcNow.ToString('o')
        pairs = $pairs.ToArray(); phases = $script:PhaseTimings.ToArray()
        measurement = @{
            clock = 'System.Diagnostics.Stopwatch'
            scope = 'NSIS process launch through exit, including synchronous previous-version cleanup; downloads, hashes, registration checks and owned test cleanup are separate phases.'
            sampleCountPerOperation = 1
            order = @('baseline fresh install', 'target upgrade', 'owned cleanup', 'target fresh install')
            cachePolicy = 'Same disposable runner; operating-system and filesystem caches are not flushed.'
            defenderPolicy = 'Unchanged; no exclusions or security settings modified.'
        }
        runner = @{
            name = $env:RUNNER_NAME; os = $env:RUNNER_OS; architecture = $env:RUNNER_ARCH
            imageOS = $env:ImageOS; imageVersion = $env:ImageVersion
            processor = $env:PROCESSOR_IDENTIFIER; logicalProcessors = [Environment]::ProcessorCount
            windowsVersion = [Environment]::OSVersion.VersionString
            powerShellVersion = $PSVersionTable.PSVersion.ToString()
            runId = $env:GITHUB_RUN_ID; runAttempt = $env:GITHUB_RUN_ATTEMPT
            sourceSHA = $env:LIFE_SOURCE_SHA
        }
    }
    $outputPath = [IO.Path]::GetFullPath($ProofPath)
    $null = New-Item -ItemType Directory -Path (Split-Path -Parent $outputPath) -Force
    $proof | ConvertTo-Json -Depth 10 | Set-Content -LiteralPath $outputPath -Encoding utf8NoBOM
    Write-Host "Saved $($pairs.Count) complete upgrade/installation benchmarks to $outputPath (success=$succeeded)."
    # Keep the final target fresh installation and its owned data for CI evidence.
    Remove-Item -LiteralPath $downloadDirectory -Recurse -Force
}
