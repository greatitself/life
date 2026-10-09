param(
    [Parameter(Mandatory = $true)]
    [string]$Installer,
    [string]$ExpectedVersion,
    [Alias('BaselineVersion')]
    [string[]]$BaselineVersions = @('0.1.0'),
    [string]$ProofPath = 'output/windows-upgrade-proof.json'
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
    if (-not $Versions -or $Versions.Count -eq 0) { throw 'Specify at least one baseline release.' }
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

$BaselineVersions = @(Get-ValidatedBaselineVersions $BaselineVersions $ExpectedVersion)

# electron-builder UUID v5 for appId dev.life.desktop, namespace
# 50e065bc-3134-11e6-9bab-38c9862bdaf3. This must stay stable after the first release.
$script:LifeInstallGuid = 'c341d2d7-15bb-5180-bedb-0a3c99a55fe4'

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

function Invoke-Nsis([string]$Path, [string]$Arguments, [string]$Description) {
    $process = Start-Process -FilePath $Path -ArgumentList $Arguments -WorkingDirectory ([IO.Path]::GetTempPath()) -PassThru
    try {
        if (-not $process.WaitForExit(300000)) {
            # Terminate only the installer started by this test if a prompt or failure hangs it.
            $process.Kill()
            $null = $process.WaitForExit(10000)
            throw "$Description did not finish within five minutes."
        }
        $process.Refresh()
        if ($process.ExitCode -ne 0) { throw "$Description failed with exit code $($process.ExitCode)." }
    } finally {
        $process.Dispose()
    }
}

function Install-Life([string]$Path) {
    Write-Host "Installing $([IO.Path]::GetFileName($Path)) with the default per-user NSIS installation."
    # The NSIS stub waits for installation/uninstallation. /S suppresses app startup.
    Invoke-Nsis $Path '/S' 'NSIS installer'
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
    Invoke-Nsis $copy "/S /KEEP_APP_DATA /currentuser --updated _?=$($Registration.Location)" 'CI-only NSIS cleanup'
    if (@(Get-LifeRegistrations).Count -ne 0 -or @(Get-LifeAppKeys).Count -ne 0 -or
        (Test-Path -LiteralPath $Registration.Location)) {
        throw 'CI-only NSIS cleanup left installation files or registration; refusing another baseline.'
    }
    Assert-TestOwnedData $OwnershipToken
    Remove-Item -LiteralPath $script:LifeUserData -Recurse -Force
    Assert-CleanLifeRunner
    Write-Host 'Removed only the successful test-created installation and owned data before the next baseline.'
}

function Test-LifeUpgradePair([string]$BaselineVersion, [string]$Directory, [string]$OwnershipToken) {
    Assert-CleanLifeRunner
    $startedAt = [DateTime]::UtcNow.ToString('o')
    $baselineInstaller = Download-BaselineInstaller $BaselineVersion $Directory
    Install-Life $baselineInstaller
    $before = Assert-SingleLifeInstallation $BaselineVersion
    Assert-PathEqual $before.Location $script:DefaultInstallPath 'Default per-user installation'
    Assert-PathEqual $before.Executable (Join-Path $script:DefaultInstallPath 'Life.exe') 'Default per-user executable'
    Write-Host ("Verified baseline registration: " + ($before | ConvertTo-Json -Compress))
    Stop-InstalledLife $before.Executable
    $binaryHashBefore = (Get-FileHash -LiteralPath $before.Executable -Algorithm SHA256).Hash
    $binaryVersionBefore = (Get-Item -LiteralPath $before.Executable).VersionInfo.ProductVersion

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
    $markerHash = (Get-FileHash -LiteralPath $marker -Algorithm SHA256).Hash
    $connectionsHash = (Get-FileHash -LiteralPath $connections -Algorithm SHA256).Hash

    Install-Life $Installer
    $after = Assert-SingleLifeInstallation $ExpectedVersion
    Write-Host ("Verified upgraded registration: " + ($after | ConvertTo-Json -Compress))
    Stop-InstalledLife $after.Executable
    $binaryHashAfter = (Get-FileHash -LiteralPath $after.Executable -Algorithm SHA256).Hash
    if ($binaryHashAfter -eq $binaryHashBefore) {
        throw 'The upgrade did not replace the installed Life executable.'
    }
    foreach ($property in @('Key', 'Location', 'Executable')) {
        if (-not [string]::Equals($before.$property, $after.$property, [StringComparison]::OrdinalIgnoreCase)) {
            throw "Upgrade changed $property from '$($before.$property)' to '$($after.$property)'."
        }
    }
    foreach ($name in $dataFiles.Keys) {
        $file = $dataFiles[$name]
        if (-not (Test-Path -LiteralPath $file -PathType Leaf)) {
            throw "Upgrade removed existing $name data."
        }
        $hash = (Get-FileHash -LiteralPath $file -Algorithm SHA256).Hash
        if ($hash -ne $savedData[$name].beforeSHA256) { throw "Upgrade changed existing $name data." }
        $savedData[$name]['afterSHA256'] = $hash
    }
    Write-Host "Preserved connections.json SHA256=$connectionsHash and upgrade marker SHA256=$markerHash."
    Write-Host ("Preserved history storage/source extension sentinels: " + ($savedData | ConvertTo-Json -Depth 4 -Compress))
    Write-Host "Verified Life $BaselineVersion -> ${ExpectedVersion}: same installation, one registration, saved user data preserved."
    return [pscustomobject]@{
        ok = $true; baselineVersion = $BaselineVersion; targetVersion = $ExpectedVersion
        startedAt = $startedAt; finishedAt = [DateTime]::UtcNow.ToString('o')
        baseline = $before; upgraded = $after; oneRegistration = $true
        baselineProductVersion = $binaryVersionBefore
        upgradedProductVersion = (Get-Item -LiteralPath $after.Executable).VersionInfo.ProductVersion
        installedBinaryBeforeSHA256 = $binaryHashBefore; installedBinaryAfterSHA256 = $binaryHashAfter
        baselineInstallerSHA256 = (Get-FileHash -LiteralPath $baselineInstaller -Algorithm SHA256).Hash
        preservedData = $savedData
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
    $proof = [pscustomobject]@{
        ok = $true; targetVersion = $ExpectedVersion; baselineVersions = $BaselineVersions
        installerSHA256 = (Get-FileHash -LiteralPath $Installer -Algorithm SHA256).Hash
        completedAt = [DateTime]::UtcNow.ToString('o'); pairs = $pairs.ToArray()
    }
    $outputPath = [IO.Path]::GetFullPath($ProofPath)
    $null = New-Item -ItemType Directory -Path (Split-Path -Parent $outputPath) -Force
    $proof | ConvertTo-Json -Depth 10 | Set-Content -LiteralPath $outputPath -Encoding utf8NoBOM
    Write-Host "Saved $($pairs.Count) successful baseline upgrade proofs to $outputPath."
} finally {
    # Keep the final pair's installation/data for CI evidence. Between pairs, only
    # verified test-created data was removed by Clear-TestCreatedLife above.
    Remove-Item -LiteralPath $downloadDirectory -Recurse -Force
}
