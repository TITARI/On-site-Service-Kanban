param(
  [int]$Port = 3000
)

$ErrorActionPreference = "Stop"
$AppDir = (Resolve-Path -LiteralPath (Split-Path -Parent $MyInvocation.MyCommand.Path)).Path
$LogDir = Join-Path $AppDir "logs"
$EnvFile = Join-Path $AppDir "app.env.ps1"

New-Item -ItemType Directory -Force -Path $LogDir | Out-Null
Set-Location $AppDir

$env:NODE_ENV = "production"
$env:PORT = [string]$Port
$env:HOSTNAME = "0.0.0.0"

if (Test-Path -LiteralPath $EnvFile) {
  . $EnvFile
}

$logFile = Join-Path $LogDir "web.log"
$stamp = Get-Date -Format "yyyy-MM-dd HH:mm:ss"
"[$stamp] Starting app on $($env:HOSTNAME):$($env:PORT)" | Out-File -FilePath $logFile -Append -Encoding utf8

try {
  & node "$AppDir\server.js" *>> $logFile
  $exitCode = if ($null -eq $LASTEXITCODE) { 0 } else { $LASTEXITCODE }
  $exitStamp = Get-Date -Format "yyyy-MM-dd HH:mm:ss"
  "[$exitStamp] App process exited with code $exitCode" | Out-File -FilePath $logFile -Append -Encoding utf8
  exit $exitCode
} catch {
  $errorStamp = Get-Date -Format "yyyy-MM-dd HH:mm:ss"
  "[$errorStamp] Failed to start app: $($_.Exception.Message)" | Out-File -FilePath $logFile -Append -Encoding utf8
  throw
}
