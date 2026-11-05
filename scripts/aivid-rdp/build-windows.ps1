param([Parameter(Mandatory=$true)][string]$Target)
$ErrorActionPreference = 'Stop'
New-Item -ItemType Directory -Path $Target -Force | Out-Null
$compiler = Join-Path $env:WINDIR 'Microsoft.NET/Framework64/v4.0.30319/csc.exe'
if (!(Test-Path $compiler)) { throw 'Build requires the Windows .NET Framework compiler.' }
& $compiler /nologo /target:exe /platform:x64 /optimize+ /warnaserror+ /reference:System.Security.dll "/out:$(Join-Path $Target 'AIVID-Protect.exe')" (Join-Path $PSScriptRoot 'Protect.cs')
if ($LASTEXITCODE -ne 0) { throw 'Credential helper compilation failed.' }
foreach ($name in @('AIVID-Login.exe','AIVID-Agent.exe')) {
  & $compiler /nologo /target:exe /platform:x64 /optimize+ /warnaserror+ "/out:$(Join-Path $Target $name)" (Join-Path $PSScriptRoot 'Launcher.cs')
  if ($LASTEXITCODE -ne 0) { throw "Compilation failed: $name" }
  & (Join-Path $Target $name) --check
  if ($LASTEXITCODE -ne 0) { throw "Runtime check failed: $name" }
}
# Exercise DPAPI without contacting CMMTools or using real credentials.
$env:AIVID_PACKAGE_ROOT=$Target
node -e "const a=require(process.env.AIVID_PACKAGE_ROOT+'/agent.cjs');(async()=>{const s='package-test-secret';const e=await a.protect('protect',s);if(e===s||await a.protect('unprotect',e)!==s)throw Error('DPAPI failed');console.log('DPAPI check passed')})().catch(()=>process.exit(1))"
if ($LASTEXITCODE -ne 0) { throw 'DPAPI runtime check failed.' }
Remove-Item Env:AIVID_PACKAGE_ROOT
Get-ChildItem $Target -Filter '*.exe' | Get-FileHash -Algorithm SHA256 | ForEach-Object { "$($_.Hash.ToLower())  $([IO.Path]::GetFileName($_.Path))" } | Set-Content (Join-Path $Target 'SHA256SUMS.txt')
