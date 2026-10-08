param(
    [Parameter(Mandatory = $true)]
    [string]$Installer,
    [string]$ExpectedVersion
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
if ($ExpectedVersion -eq '0.1.0') { throw 'The upgrade must target a version newer than 0.1.0.' }

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
                if ((Read-RegistryValue $record 'DisplayName') -ne 'Life') { continue }
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
    if ($registration.Hive -ne 'HKCU' -or $registration.Version -ne $Version) {
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

function Install-Life([string]$Path) {
    Write-Host "Installing $([IO.Path]::GetFileName($Path)) with the default per-user NSIS installation."
    # The NSIS stub waits for installation/uninstallation. /S suppresses app startup.
    $process = Start-Process -FilePath $Path -ArgumentList '/S' -PassThru
    try {
        if (-not $process.WaitForExit(300000)) {
            # Terminate only the installer started by this test if a prompt or failure hangs it.
            $process.Kill()
            $null = $process.WaitForExit(10000)
            throw 'NSIS installer did not finish within five minutes.'
        }
        $process.Refresh()
        if ($process.ExitCode -ne 0) { throw "NSIS installer failed with exit code $($process.ExitCode)." }
    } finally {
        $process.Dispose()
    }
}

if (@(Get-LifeRegistrations).Count -ne 0) {
    throw 'The disposable CI runner already has Life installed; refusing to modify an existing installation.'
}

$downloadDirectory = Join-Path ([IO.Path]::GetTempPath()) ('life-upgrade-' + [Guid]::NewGuid().ToString('N'))
$null = New-Item -ItemType Directory -Path $downloadDirectory
$baselineInstaller = Join-Path $downloadDirectory 'Life-0.1.0-win-x64.exe'
$baselineUrl = 'https://github.com/greatitself/life/releases/download/v0.1.0/Life-0.1.0-win-x64.exe'
try {
    $downloaded = $false
    for ($attempt = 1; $attempt -le 4; $attempt++) {
        try {
            Invoke-WebRequest -Uri $baselineUrl -OutFile $baselineInstaller -TimeoutSec 120
            if ((Get-Item -LiteralPath $baselineInstaller).Length -lt 1MB) {
                throw 'The baseline installer download is unexpectedly small.'
            }
            $downloaded = $true
            break
        } catch {
            if ($attempt -eq 4) { throw "Could not download required v0.1.0 baseline after four attempts: $_" }
            Write-Warning "Baseline download attempt $attempt failed; retrying."
            Start-Sleep -Seconds (3 * $attempt)
        }
    }
    if (-not $downloaded) { throw 'The required baseline installer was not downloaded.' }

    Install-Life $baselineInstaller
    $before = Assert-SingleLifeInstallation '0.1.0'
    Stop-InstalledLife $before.Executable
    $binaryHashBefore = (Get-FileHash -LiteralPath $before.Executable -Algorithm SHA256).Hash

    $userData = Join-Path $env:APPDATA 'Life'
    $null = New-Item -ItemType Directory -Path $userData -Force
    $marker = Join-Path $userData 'upgrade-smoke.txt'
    if (Test-Path -LiteralPath $marker) { throw 'Unexpected upgrade marker already exists on this runner.' }
    Set-Content -LiteralPath $marker -Value ([Guid]::NewGuid().ToString()) -Encoding utf8NoBOM
    $connections = Join-Path $userData 'connections.json'
    if (-not (Test-Path -LiteralPath $connections)) {
        # A genuine valid profile and trust entry prove that saved app data survives the upgrade.
        $sentinel = @{
            profiles = @(@{
                id = 'upgrade-smoke'; name = 'Preserved research machine'; host = 'research.example.invalid'
                port = 22; username = 'researcher'; auth = 'key'; privateKeyPath = ''; workspace = '~/research'
            })
            knownHosts = @{ 'research.example.invalid:22' = 'SHA256:upgrade-smoke' }
        }
        $sentinel | ConvertTo-Json -Depth 6 | Set-Content -LiteralPath $connections -Encoding utf8NoBOM
    }
    $null = Get-Content -Raw -LiteralPath $connections | ConvertFrom-Json
    $markerHash = (Get-FileHash -LiteralPath $marker -Algorithm SHA256).Hash
    $connectionsHash = (Get-FileHash -LiteralPath $connections -Algorithm SHA256).Hash

    Install-Life $Installer
    $after = Assert-SingleLifeInstallation $ExpectedVersion
    Stop-InstalledLife $after.Executable
    if ((Get-FileHash -LiteralPath $after.Executable -Algorithm SHA256).Hash -eq $binaryHashBefore) {
        throw 'The upgrade did not replace the installed Life executable.'
    }
    foreach ($property in @('Key', 'Location', 'Executable')) {
        if (-not [string]::Equals($before.$property, $after.$property, [StringComparison]::OrdinalIgnoreCase)) {
            throw "Upgrade changed $property from '$($before.$property)' to '$($after.$property)'."
        }
    }
    if (-not (Test-Path -LiteralPath $marker) -or -not (Test-Path -LiteralPath $connections)) {
        throw 'Upgrade removed existing Life user data.'
    }
    if ((Get-FileHash -LiteralPath $marker -Algorithm SHA256).Hash -ne $markerHash -or
        (Get-FileHash -LiteralPath $connections -Algorithm SHA256).Hash -ne $connectionsHash) {
        throw 'Upgrade changed existing Life user data.'
    }
    Write-Host "Verified Life 0.1.0 -> ${ExpectedVersion}: same installation, one registration, saved user data preserved."
} finally {
    # Only remove the temporary installer we downloaded, never installed application/user data.
    Remove-Item -LiteralPath $downloadDirectory -Recurse -Force
}
