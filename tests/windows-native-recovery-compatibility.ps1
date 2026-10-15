param(
  [string]$Executable = "release/win-unpacked/Life.exe",
  [string]$ProofDirectory = "output/windows-native-recovery-compatibility",
  [string]$BuildProvenance = $env:LIFE_RECOVERY_BUILD_PROVENANCE,
  [int]$TimeoutSeconds = 900
)

$ErrorActionPreference = "Stop"
if ([System.Environment]::OSVersion.Platform -ne [System.PlatformID]::Win32NT) {
  throw "The native recovery compatibility gate requires a real Windows host."
}
$appExecutable = (Resolve-Path $Executable).Path
if (!$BuildProvenance) { throw "Pass Root's exact frozen build/package manifest with -BuildProvenance or LIFE_RECOVERY_BUILD_PROVENANCE." }
$buildManifest = (Resolve-Path $BuildProvenance).Path
if ([System.IO.Path]::GetFileName($appExecutable) -ine "Life.exe") {
  throw "Pass the actual packaged Life.exe executable."
}
$testScript = Join-Path $PSScriptRoot "windows-native-recovery-compatibility.cjs"
$proofPath = [System.IO.Path]::GetFullPath($ProofDirectory)
$nodeExecutable = (Get-Command node -ErrorAction Stop).Source
$startInfo = [System.Diagnostics.ProcessStartInfo]::new()
$startInfo.FileName = $nodeExecutable
$startInfo.WorkingDirectory = Split-Path $PSScriptRoot -Parent
$startInfo.UseShellExecute = $false
$startInfo.RedirectStandardOutput = $true
$startInfo.RedirectStandardError = $true
$startInfo.ArgumentList.Add($testScript)
$startInfo.Environment["LIFE_WINDOWS_EXECUTABLE"] = $appExecutable
$startInfo.Environment["LIFE_WINDOWS_PROOF_DIR"] = $proofPath
$startInfo.Environment["LIFE_RECOVERY_BUILD_PROVENANCE"] = $buildManifest
$startInfo.Environment.Remove("ELECTRON_RUN_AS_NODE") | Out-Null
$gateProcess = [System.Diagnostics.Process]::new()
$gateProcess.StartInfo = $startInfo
try {
  if (!$gateProcess.Start()) { throw "Could not start the actual Windows compatibility gate." }
  $stdout = $gateProcess.StandardOutput.ReadToEndAsync()
  $stderr = $gateProcess.StandardError.ReadToEndAsync()
  if (!$gateProcess.WaitForExit($TimeoutSeconds * 1000)) {
    $gateProcess.Kill($true)
    $gateProcess.WaitForExit()
    throw "Windows packaged compatibility gate exceeded $TimeoutSeconds seconds."
  }
  Write-Output $stdout.GetAwaiter().GetResult()
  $errorOutput = $stderr.GetAwaiter().GetResult()
  if ($errorOutput) { Write-Output $errorOutput }
  if ($gateProcess.ExitCode -ne 0) { throw "Windows compatibility gate failed (exit $($gateProcess.ExitCode))." }
  $resultPath = Join-Path $proofPath "proof.json"
  if (!(Test-Path $resultPath)) { throw "The gate did not produce packaged Windows proof." }
  $proof = Get-Content -Raw $resultPath | ConvertFrom-Json
  if (!$proof.ok -or $proof.orchestrator.platform -ne "win32" -or $proof.policy.platform -ne "win32") {
    throw "The gate returned an invalid Windows proof."
  }
  if (!$proof.policy.versions.electron -or !$proof.policy.versions.node -or !$proof.policy.versions.uv) {
    throw "The proof is missing the actual packaged Electron, Node or libuv version."
  }
} finally {
  $gateProcess.Dispose()
}
