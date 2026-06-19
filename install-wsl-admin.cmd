@echo off
set SCRIPT=%~dp0install-wsl-admin.ps1
powershell -NoProfile -ExecutionPolicy Bypass -Command "Start-Process powershell -Verb RunAs -ArgumentList '-NoProfile -ExecutionPolicy Bypass -File ""%SCRIPT%""'"
exit /b %errorlevel%
