param(
  [int]$Port = 3000,
  [string]$TaskName = "InternalCollaborationBoard",
  [switch]$NoScheduledTask,
  [switch]$SkipFirewall
)

$ErrorActionPreference = "Stop"
$AppDir = (Resolve-Path -LiteralPath (Split-Path -Parent $MyInvocation.MyCommand.Path)).Path
$EnvFile = Join-Path $AppDir "app.env.ps1"
$SampleEnvFile = Join-Path $AppDir "app.env.sample.ps1"

function Test-IsAdmin {
  $identity = [Security.Principal.WindowsIdentity]::GetCurrent()
  $principal = [Security.Principal.WindowsPrincipal]::new($identity)
  return $principal.IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)
}

function Get-LocalUrls {
  $urls = @("http://localhost:$Port")
  try {
    $ips = Get-NetIPAddress -AddressFamily IPv4 |
      Where-Object { $_.IPAddress -notlike "127.*" -and $_.IPAddress -notlike "169.254.*" } |
      Select-Object -ExpandProperty IPAddress -Unique
    foreach ($ip in $ips) {
      $urls += "http://$ip`:$Port"
    }
  } catch {
    # Some older Windows Server images may not expose Get-NetIPAddress.
  }
  return $urls
}

if (-not (Get-Command node -ErrorAction SilentlyContinue)) {
  throw "Node.js is not installed. Install Node.js 20 LTS or newer first, then run this script again."
}

if (-not (Test-Path -LiteralPath (Join-Path $AppDir "server.js"))) {
  throw "server.js was not found. Please run this script from the extracted deployment package root."
}

if (-not (Test-Path -LiteralPath $EnvFile)) {
  if (Test-Path -LiteralPath $SampleEnvFile) {
    Copy-Item -LiteralPath $SampleEnvFile -Destination $EnvFile
  } else {
    @"
`$env:PORT = "$Port"
`$env:HOSTNAME = "0.0.0.0"
"@ | Set-Content -LiteralPath $EnvFile -Encoding utf8
  }
}

$envContent = Get-Content -LiteralPath $EnvFile -Raw
if ($envContent -match '\$env:PORT\s*=') {
  $envContent = $envContent -replace '\$env:PORT\s*=\s*"[^"]*"', "`$env:PORT = `"$Port`""
} else {
  $envContent += "`r`n`$env:PORT = `"$Port`"`r`n"
}
Set-Content -LiteralPath $EnvFile -Value $envContent -Encoding utf8

New-Item -ItemType Directory -Force -Path (Join-Path $AppDir "logs") | Out-Null

& (Join-Path $AppDir "stop-server.ps1") -TaskName $TaskName -Port $Port

$isAdmin = Test-IsAdmin
if ($isAdmin -and -not $SkipFirewall) {
  $ruleName = "Internal Collaboration Board $Port"
  $existingRule = Get-NetFirewallRule -DisplayName $ruleName -ErrorAction SilentlyContinue
  if (-not $existingRule) {
    New-NetFirewallRule -DisplayName $ruleName -Direction Inbound -Protocol TCP -LocalPort $Port -Action Allow | Out-Null
  }
}

if ($isAdmin -and -not $NoScheduledTask) {
  $startScript = Join-Path $AppDir "start-server.ps1"
  $argument = "-NoProfile -ExecutionPolicy Bypass -File `"$startScript`" -Port $Port"
  $action = New-ScheduledTaskAction -Execute "powershell.exe" -Argument $argument -WorkingDirectory $AppDir
  $trigger = New-ScheduledTaskTrigger -AtStartup
  $principal = New-ScheduledTaskPrincipal -UserId "SYSTEM" -RunLevel Highest
  $settings = New-ScheduledTaskSettingsSet -MultipleInstances IgnoreNew -RestartCount 3 -RestartInterval (New-TimeSpan -Minutes 1)

  Register-ScheduledTask -TaskName $TaskName -Action $action -Trigger $trigger -Principal $principal -Settings $settings -Force | Out-Null
  Start-ScheduledTask -TaskName $TaskName
} else {
  Start-Process -FilePath "powershell.exe" -ArgumentList @("-NoProfile", "-ExecutionPolicy", "Bypass", "-File", (Join-Path $AppDir "start-server.ps1"), "-Port", [string]$Port) -WorkingDirectory $AppDir -WindowStyle Hidden
}

$ready = $false
for ($i = 0; $i -lt 30; $i++) {
  Start-Sleep -Seconds 2
  try {
    $response = Invoke-WebRequest -Uri "http://127.0.0.1:$Port/" -UseBasicParsing -TimeoutSec 5
    if ($response.StatusCode -eq 200) {
      $ready = $true
      break
    }
  } catch {
    # Wait until the app finishes warming up.
  }
}

if (-not $ready) {
  throw "The app did not respond on http://127.0.0.1:$Port. Check logs\web.log for details."
}

Write-Host ""
Write-Host "Deployment completed."
$taskMode = if ($isAdmin -and -not $NoScheduledTask) { "scheduled startup task" } else { "manual background process" }
Write-Host "Task mode: $taskMode"
Write-Host "Open one of these URLs:"
Get-LocalUrls | ForEach-Object { Write-Host "  $_" }
