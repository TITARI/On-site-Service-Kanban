$ErrorActionPreference = "Stop"

Write-Host "=== Docker prerequisite check ===" -ForegroundColor Cyan
$hv = Get-ComputerInfo -Property HyperVRequirementVirtualizationFirmwareEnabled
Write-Host ("Virtualization Enabled In Firmware: {0}" -f $hv.HyperVRequirementVirtualizationFirmwareEnabled)

if (-not $hv.HyperVRequirementVirtualizationFirmwareEnabled) {
  Write-Host ""
  Write-Host "Enable BIOS/UEFI virtualization first (Intel VT-x or AMD SVM), then rerun this script." -ForegroundColor Yellow
  exit 1
}

Write-Host ""
Write-Host "=== Enable WSL and VirtualMachinePlatform ===" -ForegroundColor Cyan
dism.exe /online /enable-feature /featurename:Microsoft-Windows-Subsystem-Linux /all /norestart
dism.exe /online /enable-feature /featurename:VirtualMachinePlatform /all /norestart

Write-Host ""
Write-Host "=== Install/Update WSL components ===" -ForegroundColor Cyan
wsl --install --no-distribution
wsl --update
wsl --set-default-version 2

Write-Host ""
Write-Host "Done. Reboot Windows, then start Docker Desktop." -ForegroundColor Green
