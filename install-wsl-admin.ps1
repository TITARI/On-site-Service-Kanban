$ErrorActionPreference = "Stop"

Write-Host "Step 1/4: Enable Microsoft-Windows-Subsystem-Linux" -ForegroundColor Cyan
dism.exe /online /enable-feature /featurename:Microsoft-Windows-Subsystem-Linux /all /norestart

Write-Host "Step 2/4: Enable VirtualMachinePlatform" -ForegroundColor Cyan
dism.exe /online /enable-feature /featurename:VirtualMachinePlatform /all /norestart

Write-Host "Step 3/4: Install WSL runtime components" -ForegroundColor Cyan
wsl.exe --install --no-distribution
wsl.exe --update
wsl.exe --set-default-version 2

Write-Host "Step 4/4: Verify" -ForegroundColor Cyan
wsl.exe --status

Write-Host ""
Write-Host "Done. Reboot Windows, then install a distro from Microsoft Store (e.g. Ubuntu)." -ForegroundColor Green
