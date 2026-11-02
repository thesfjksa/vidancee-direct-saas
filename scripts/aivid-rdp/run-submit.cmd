@echo off
setlocal
cd /d "%~dp0"
if not exist "node.exe" (
  echo This folder needs the Windows ZIP artifact from the GitHub AIVID RDP runner workflow.
  pause
  exit /b 1
)
if not exist "trial.job.json" (
  echo Run run-preflight.cmd first and review trial.job.json.
  pause
  exit /b 1
)
"%~dp0node.exe" "%~dp0runner.mjs" "%~dp0trial.job.json" --submit
pause
