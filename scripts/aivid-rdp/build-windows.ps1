param([Parameter(Mandatory=$true)][string]$Target)
$ErrorActionPreference = 'Stop'
$Target = [IO.Path]::GetFullPath($Target)
$compiler = Join-Path $env:WINDIR 'Microsoft.NET/Framework64/v4.0.30319/csc.exe'
if (!(Test-Path $compiler)) { throw 'Windows .NET Framework C# compiler is required to build launchers.' }
foreach ($name in @('AIVID-Preflight.exe', 'AIVID-Submit.exe')) {
  & $compiler /nologo /target:exe /platform:x64 /optimize+ /warnaserror+ "/out:$(Join-Path $Target $name)" (Join-Path $PSScriptRoot 'Launcher.cs')
  if ($LASTEXITCODE -ne 0) { throw "Compilation failed: $name" }
  & (Join-Path $Target $name) --check
  if ($LASTEXITCODE -ne 0) { throw "Runtime/dependency check failed: $name" }
}

# Exercise the real Windows executables with a local stub; never contact AIVID.
$smoke = Join-Path $env:RUNNER_TEMP 'AIVID runner space 测试'
New-Item -ItemType Directory -Path $smoke -Force | Out-Null
foreach ($name in @('node.exe','AIVID-Preflight.exe','AIVID-Submit.exe','trial.example.json','preflight.mjs')) {
  Copy-Item (Join-Path $Target $name) (Join-Path $smoke $name) -Force
}
New-Item -ItemType Directory -Path (Join-Path $smoke 'node_modules/playwright') -Force | Out-Null
'{}' | Set-Content (Join-Path $smoke 'node_modules/playwright/package.json') -Encoding utf8
@'
import { writeFileSync } from 'node:fs';
writeFileSync('smoke-result.json',JSON.stringify({args:process.argv.slice(2),cwd:process.cwd()}));
process.exit(Number(process.env.AIVID_LAUNCHER_TEST_EXIT || 0));
'@ | Set-Content (Join-Path $smoke 'runner.mjs') -Encoding utf8
function Invoke-Launcher([string]$Name, [int]$Expected) {
  $start = New-Object Diagnostics.ProcessStartInfo
  $start.FileName = Join-Path $smoke $Name
  $start.WorkingDirectory = $env:RUNNER_TEMP
  $start.UseShellExecute = $false
  $start.RedirectStandardInput = $true
  $start.RedirectStandardOutput = $true
  $start.RedirectStandardError = $true
  $process = [Diagnostics.Process]::Start($start)
  $process.StandardInput.Close()
  if (!$process.WaitForExit(20000)) { $process.Kill(); throw "Launcher timed out: $Name" }
  $output = $process.StandardOutput.ReadToEnd() + $process.StandardError.ReadToEnd()
  if ($process.ExitCode -ne $Expected) { throw "$Name exit $($process.ExitCode), expected $Expected. $output" }
  Write-Host "$Name smoke check passed (exit $Expected)"
}
Invoke-Launcher 'AIVID-Submit.exe' 1
if (Test-Path (Join-Path $smoke 'smoke-result.json')) { throw 'Submit launched without a reviewed job.' }
Invoke-Launcher 'AIVID-Preflight.exe' 0
$result = Get-Content (Join-Path $smoke 'smoke-result.json') -Raw | ConvertFrom-Json
if ($result.args.Count -ne 1 -or $result.args[0] -ne (Join-Path $smoke 'trial.job.json') -or $result.cwd -ne $smoke) { throw 'Preflight path/argument handling failed.' }
Invoke-Launcher 'AIVID-Submit.exe' 0
$result = Get-Content (Join-Path $smoke 'smoke-result.json') -Raw | ConvertFrom-Json
if ($result.args.Count -ne 2 -or $result.args[1] -ne '--submit') { throw 'Submit mode flag missing.' }
$env:AIVID_LAUNCHER_TEST_EXIT = '42'
try { Invoke-Launcher 'AIVID-Preflight.exe' 42 } finally { Remove-Item Env:AIVID_LAUNCHER_TEST_EXIT }
Remove-Item (Join-Path $smoke 'node.exe')
Invoke-Launcher 'AIVID-Preflight.exe' 1
Remove-Item $smoke -Recurse -Force

@'
AIVID Windows EXE runner

1. Extract the ENTIRE ZIP to a writable folder on your Windows 10/11 x64 RDP.
2. Install Google Chrome if it is not already installed.
3. Double-click AIVID-Preflight.exe. Sign in yourself in the Chrome window it opens.
4. Review trial.job.json, the model, duration, aspect ratio and displayed price.
5. For one intended paid submission, open AIVID-Submit.exe and type SUBMIT when asked.

Keep the EXEs with node.exe, runner.mjs, preflight.mjs and node_modules.
Portable Node.js and Playwright are bundled. No separate Node installation is needed.
The launchers require Windows .NET Framework 4.x. The executables are unsigned.
Run --check from a terminal to check the packaged runtime without opening Chrome.

This build supports local, text-only Seedance 2.0 Mini form preparation and one submission.
It does not yet connect to the CMMTools queue, retrieve completed MP4s, upload outputs,
settle/refund CMMTools credits, or operate unattended. See README.md for details.
If a receipt exists for a job ID, reconcile it in AIVID history before any new submission.
Keep the browser profile and receipts private on the RDP.
'@ | Set-Content (Join-Path $Target 'START-HERE.txt') -Encoding utf8
Copy-Item (Join-Path $PSScriptRoot 'Launcher.cs') (Join-Path $Target 'Launcher.cs')
Get-ChildItem $Target -Filter '*.exe' | Get-FileHash -Algorithm SHA256 | ForEach-Object { "$($_.Hash.ToLower())  $([IO.Path]::GetFileName($_.Path))" } | Set-Content (Join-Path $Target 'SHA256SUMS.txt')
