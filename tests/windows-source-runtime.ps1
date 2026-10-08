param(
  [string]$Executable = "release/win-unpacked/Life.exe",
  [string]$ProofPath = "output/source-runtime-proof.json"
)

$ErrorActionPreference = "Stop"
$appExecutable = (Resolve-Path $Executable).Path
$resourcesDirectory = Join-Path (Split-Path $appExecutable -Parent) "resources"
$scriptPath = Join-Path $resourcesDirectory "life-source-runtime.cjs"
if (!(Test-Path $scriptPath)) { throw "Packaged source runtime verification script is missing: $scriptPath" }
$outputPath = [System.IO.Path]::GetFullPath($ProofPath)
$startInfo = [System.Diagnostics.ProcessStartInfo]::new()
$startInfo.FileName = $appExecutable
$startInfo.UseShellExecute = $false
$startInfo.RedirectStandardOutput = $true
$startInfo.RedirectStandardError = $true
$startInfo.Environment["ELECTRON_RUN_AS_NODE"] = "1"
$startInfo.ArgumentList.Add($scriptPath)
$startInfo.ArgumentList.Add($resourcesDirectory)
$startInfo.ArgumentList.Add($outputPath)
$runtimeProcess = [System.Diagnostics.Process]::new()
$runtimeProcess.StartInfo = $startInfo
try {
  if (!$runtimeProcess.Start()) { throw "Could not start the packaged source runtime verification" }
  $stdout = $runtimeProcess.StandardOutput.ReadToEndAsync()
  $stderr = $runtimeProcess.StandardError.ReadToEndAsync()
  if (!$runtimeProcess.WaitForExit(300000)) {
    $runtimeProcess.Kill($true)
    $runtimeProcess.WaitForExit()
    throw "Packaged source runtime verification exceeded five minutes"
  }
  Write-Output $stdout.GetAwaiter().GetResult()
  $errorOutput = $stderr.GetAwaiter().GetResult()
  if ($errorOutput) { Write-Output $errorOutput }
  if ($runtimeProcess.ExitCode -ne 0) { throw "Packaged source runtime verification failed (exit $($runtimeProcess.ExitCode))" }
  if (!(Test-Path $outputPath)) { throw "Source runtime verification did not produce its proof JSON" }
  $proof = Get-Content -Raw $outputPath | ConvertFrom-Json
  if (!$proof.ok -or $proof.platform -ne "win32") { throw "Source runtime verification returned an invalid Windows proof" }
} finally {
  $runtimeProcess.Dispose()
}
