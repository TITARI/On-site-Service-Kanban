param(
  [string]$TaskName = "InternalCollaborationBoard",
  [int]$Port = 0
)

$ErrorActionPreference = "Stop"
$AppDir = (Resolve-Path -LiteralPath (Split-Path -Parent $MyInvocation.MyCommand.Path)).Path
$EnvFile = Join-Path $AppDir "app.env.ps1"

if ($Port -le 0 -and (Test-Path -LiteralPath $EnvFile)) {
  $envContent = Get-Content -LiteralPath $EnvFile -Raw
  if ($envContent -match '\$env:PORT\s*=\s*"(?<port>\d+)"') {
    $Port = [int]$Matches.port
  }
}
if ($Port -le 0) {
  $Port = 3000
}

try {
  $task = Get-ScheduledTask -TaskName $TaskName -ErrorAction Stop
  if ($task.State -eq "Running") {
    Stop-ScheduledTask -TaskName $TaskName
  }
} catch {
  # The scheduled task may not exist when the app was started manually.
}

try {
  $listeners = netstat -ano |
    Select-String "LISTENING" |
    Where-Object { $_.Line -match "[:.]$Port\s" }
  foreach ($listener in $listeners) {
    $parts = $listener.Line -split "\s+"
    $processId = [int]$parts[-1]
    Stop-Process -Id $processId -Force -ErrorAction SilentlyContinue
  }
} catch {
  # Fall back to command-line matching below.
}

Get-CimInstance Win32_Process |
  Where-Object {
    (
      $_.CommandLine -like "*$AppDir*server.js*" -or
      $_.CommandLine -like "* .\server.js*"
    ) -and
    $_.CommandLine -notlike "*start-server.js*"
  } |
  ForEach-Object {
    Stop-Process -Id $_.ProcessId -Force
  }

Write-Host "Stopped Internal Collaboration Board processes for $AppDir on port $Port"
