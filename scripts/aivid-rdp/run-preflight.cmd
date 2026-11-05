@echo off
setlocal
cd /d "%~dp0"
if not exist "node.exe" (
  echo This folder needs the Windows ZIP artifact from the GitHub AIVID RDP runner workflow.
  pause
  exit /b 1
)
if not exist "trial.job.json" copy /y "trial.example.json" "trial.job.json" >nul
"%~dp0node.exe" "%~dp0runner.mjs" "%~dp0trial.job.json"
pause
