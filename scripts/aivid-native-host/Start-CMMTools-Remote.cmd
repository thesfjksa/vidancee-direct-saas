@echo off
title CMMTools Windows Native Interactive Browser
cd /d "%~dp0"
powershell.exe -NoProfile -ExecutionPolicy Bypass -File "%~dp0CMMTools-Remote.ps1"
exit /b %errorlevel%
