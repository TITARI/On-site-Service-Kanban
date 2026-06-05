param(
  [int]$Port = 3000,
  [ValidateSet("dev", "prod")]
  [string]$Mode = "dev",
  [switch]$NoTunnel,
  [switch]$Restart
)

$ErrorActionPreference = "Stop"
$Root = (Resolve-Path -LiteralPath (Split-Path -Parent $MyInvocation.MyCommand.Path)).Path
$LogDir = Join-Path $Root "logs"
$DataDir = Join-Path $Root "data"
$AppOutLog = Join-Path $LogDir "external-web.out.log"
$AppErrLog = Join-Path $LogDir "external-web.err.log"
$TunnelOutLog = Join-Path $LogDir "external-cloudflared.out.log"
$TunnelErrLog = Join-Path $LogDir "external-cloudflared.err.log"
$PublicBaseUrlFile = Join-Path $DataDir "public-base-url.txt"

function Get-CommandPath {
  param([string[]]$Names)

  foreach ($name in $Names) {
    $command = Get-Command $name -ErrorAction SilentlyContinue
    if ($command) {
      return $command.Source
    }
  }

  return $null
}

function Test-LocalAppReady {
  param([int]$TargetPort)

  try {
    $response = Invoke-WebRequest -Uri "http://127.0.0.1:$TargetPort/" -UseBasicParsing -TimeoutSec 5
    return ($response.StatusCode -ge 200 -and $response.StatusCode -lt 500)
  } catch {
    return $false
  }
}

function Wait-LocalApp {
  param([int]$TargetPort)

  for ($i = 0; $i -lt 60; $i++) {
    if (Test-LocalAppReady -TargetPort $TargetPort) {
      return $true
    }
    Start-Sleep -Seconds 2
  }

  return $false
}

function Get-LocalUrls {
  param([int]$TargetPort)

  $urls = @("http://localhost:$TargetPort")
  try {
    $ips = Get-NetIPAddress -AddressFamily IPv4 |
      Where-Object { $_.IPAddress -notlike "127.*" -and $_.IPAddress -notlike "169.254.*" } |
      Select-Object -ExpandProperty IPAddress -Unique
    foreach ($ip in $ips) {
      $urls += "http://$ip`:$TargetPort"
    }
  } catch {
    # Older Windows images may not have Get-NetIPAddress available.
  }

  return $urls
}

function Get-TunnelUrl {
  foreach ($path in @($TunnelOutLog, $TunnelErrLog)) {
    if (Test-Path -LiteralPath $path) {
      $content = Get-Content -LiteralPath $path -Raw -ErrorAction SilentlyContinue
      if ([string]::IsNullOrEmpty($content)) {
        continue
      }
      $match = [regex]::Match($content, "https://[-a-zA-Z0-9]+\.trycloudflare\.com")
      if ($match.Success) {
        return $match.Value
      }
    }
  }

  return $null
}

function Wait-TunnelUrl {
  for ($i = 0; $i -lt 45; $i++) {
    $url = Get-TunnelUrl
    if ($url) {
      return $url
    }
    Start-Sleep -Seconds 2
  }

  return $null
}

function Stop-StartedProcess {
  param(
    [System.Diagnostics.Process]$Process,
    [string]$Name
  )

  if ($Process -and -not $Process.HasExited) {
    Write-Host "Stopping $Name..."
    Stop-Process -Id $Process.Id -Force -ErrorAction SilentlyContinue
  }
}

function Clear-LogFile {
  param([string]$Path)

  if (Test-Path -LiteralPath $Path) {
    try {
      Remove-Item -LiteralPath $Path -Force -ErrorAction Stop
    } catch {
      Write-Host "Keeping existing log because it is currently in use: $Path"
    }
  }
}

function Get-FullPath {
  param([string]$Path)

  return [System.IO.Path]::GetFullPath($Path)
}

function Add-TrailingDirectorySeparator {
  param([string]$Path)

  $fullPath = Get-FullPath -Path $Path
  $separator = [string][System.IO.Path]::DirectorySeparatorChar
  if (-not $fullPath.EndsWith($separator)) {
    $fullPath = "$fullPath$separator"
  }

  return $fullPath
}

function Assert-PathInside {
  param(
    [string]$Path,
    [string]$Parent,
    [string]$Purpose
  )

  $fullPath = Get-FullPath -Path $Path
  $parentPath = Add-TrailingDirectorySeparator -Path $Parent
  if (-not $fullPath.StartsWith($parentPath, [System.StringComparison]::OrdinalIgnoreCase)) {
    throw "$Purpose must stay inside $parentPath, but resolved to $fullPath."
  }
}

function Copy-DirectoryFresh {
  param(
    [string]$Source,
    [string]$Destination,
    [string]$GuardRoot,
    [string]$Name
  )

  if (-not (Test-Path -LiteralPath $Source -PathType Container)) {
    throw "$Name source directory was not found at $Source."
  }

  Assert-PathInside -Path $Destination -Parent $GuardRoot -Purpose "$Name destination"

  if (Test-Path -LiteralPath $Destination) {
    Remove-Item -LiteralPath $Destination -Recurse -Force
  }

  $destinationParent = Split-Path -Parent $Destination
  New-Item -ItemType Directory -Force -Path $destinationParent | Out-Null
  Copy-Item -LiteralPath $Source -Destination $Destination -Recurse -Force
}

function Sync-StandaloneAssets {
  $standaloneRoot = Join-Path $Root ".next\standalone"
  $sourceStatic = Join-Path $Root ".next\static"
  $targetStatic = Join-Path $standaloneRoot ".next\static"
  $sourcePublic = Join-Path $Root "public"
  $targetPublic = Join-Path $standaloneRoot "public"

  if (-not (Test-Path -LiteralPath $standaloneRoot -PathType Container)) {
    throw "Standalone output was not found at .next\standalone. Run npm run build first."
  }

  Write-Host "Syncing standalone static assets..."
  Copy-DirectoryFresh -Source $sourceStatic -Destination $targetStatic -GuardRoot $standaloneRoot -Name "Next static assets"

  if (Test-Path -LiteralPath $sourcePublic -PathType Container) {
    Copy-DirectoryFresh -Source $sourcePublic -Destination $targetPublic -GuardRoot $standaloneRoot -Name "public assets"
  }
}

function Get-ProcessInfoById {
  param([int]$ProcessId)

  return Get-CimInstance Win32_Process -Filter "ProcessId = $ProcessId" -ErrorAction SilentlyContinue
}

function Get-ListeningProcessIds {
  param([int]$TargetPort)

  try {
    return @(
      Get-NetTCPConnection -LocalPort $TargetPort -State Listen -ErrorAction SilentlyContinue |
        Select-Object -ExpandProperty OwningProcess -Unique
    )
  } catch {
    return @()
  }
}

function Stop-RestartProcesses {
  param([int]$TargetPort)

  Write-Host "Restart requested. Stopping existing app and tunnel processes for port $TargetPort..."

  foreach ($processId in Get-ListeningProcessIds -TargetPort $TargetPort) {
    $processInfo = Get-ProcessInfoById -ProcessId $processId
    if (-not $processInfo) {
      continue
    }

    $commandLine = [string]$processInfo.CommandLine
    $rootPattern = [regex]::Escape($Root)
    $isProjectNodeProcess = (
      ($processInfo.Name -in @("node.exe", "node", "npm.cmd", "npm")) -and
      ($commandLine -match $rootPattern -or $commandLine -match "\.next\\standalone\\server\.js" -or $commandLine -match "next")
    )

    if (-not $isProjectNodeProcess) {
      throw "Port $TargetPort is used by $($processInfo.Name) (PID $processId), which does not look like this app. Stop it manually or choose another port."
    }

    Write-Host "Stopping app process PID $processId..."
    Stop-Process -Id $processId -Force -ErrorAction SilentlyContinue
  }

  $cloudflaredProcesses = @(
    Get-CimInstance Win32_Process -ErrorAction SilentlyContinue |
      Where-Object {
        $commandLine = [string]$_.CommandLine
        ($_.Name -in @("cloudflared.exe", "cloudflared") -or $commandLine -match "cloudflared") -and
        $commandLine -match "tunnel" -and
        ($commandLine -match "127\.0\.0\.1:$TargetPort" -or $commandLine -match "localhost:$TargetPort" -or $commandLine -match ":$TargetPort")
      }
  )

  foreach ($processInfo in $cloudflaredProcesses) {
    Write-Host "Stopping Cloudflare tunnel PID $($processInfo.ProcessId)..."
    Stop-Process -Id $processInfo.ProcessId -Force -ErrorAction SilentlyContinue
  }

  Start-Sleep -Seconds 2
}

function Get-StaticAssetPaths {
  param([string]$Html)

  $paths = New-Object "System.Collections.Generic.HashSet[string]" ([System.StringComparer]::OrdinalIgnoreCase)
  $matches = [regex]::Matches($Html, '(?:src|href)="([^"]*/_next/static/[^"]+\.(?:js|css)(?:\?[^"]*)?)"')
  foreach ($match in $matches) {
    $decodedPath = [System.Net.WebUtility]::HtmlDecode($match.Groups[1].Value)
    $null = $paths.Add($decodedPath)
  }

  return @($paths)
}

function Test-StaticAssetsReady {
  param([int]$TargetPort)

  $baseUrl = "http://127.0.0.1:$TargetPort"
  $homeResponse = Invoke-WebRequest -Uri "$baseUrl/" -UseBasicParsing -TimeoutSec 15
  if ($homeResponse.StatusCode -ne 200) {
    throw "Home page returned HTTP $($homeResponse.StatusCode), expected 200."
  }

  $assetPaths = Get-StaticAssetPaths -Html $homeResponse.Content
  if ($assetPaths.Count -eq 0) {
    throw "No Next static assets were found in the home page HTML."
  }

  $failures = New-Object System.Collections.Generic.List[string]
  foreach ($assetPath in $assetPaths) {
    if ($assetPath -match "^https?://") {
      $assetUrl = $assetPath
    } elseif ($assetPath.StartsWith("/")) {
      $assetUrl = "$baseUrl$assetPath"
    } else {
      $assetUrl = "$baseUrl/$assetPath"
    }

    try {
      $assetResponse = Invoke-WebRequest -Uri $assetUrl -UseBasicParsing -TimeoutSec 15
      if ($assetResponse.StatusCode -ne 200) {
        $failures.Add("$assetPath -> HTTP $($assetResponse.StatusCode)")
      }
    } catch {
      $failures.Add("$assetPath -> $($_.Exception.Message)")
    }
  }

  if ($failures.Count -gt 0) {
    throw "Static asset validation failed:`n  - $($failures -join "`n  - ")"
  }

  Write-Host "Verified $($assetPaths.Count) Next static asset(s)."
}

New-Item -ItemType Directory -Force -Path $LogDir | Out-Null
New-Item -ItemType Directory -Force -Path $DataDir | Out-Null
Set-Location $Root

if ($Restart) {
  Stop-RestartProcesses -TargetPort $Port
}

foreach ($log in @($AppOutLog, $AppErrLog, $TunnelOutLog, $TunnelErrLog)) {
  Clear-LogFile -Path $log
}
Clear-LogFile -Path $PublicBaseUrlFile

$nodePath = Get-CommandPath -Names @("node.exe", "node")
if (-not $nodePath) {
  throw "Node.js was not found. Install Node.js 20 LTS or newer first."
}

if ($Mode -eq "prod") {
  Sync-StandaloneAssets
}

$appProcess = $null
$tunnelProcess = $null
$startedApp = $false

try {
  if (Test-LocalAppReady -TargetPort $Port) {
    Write-Host "Local app is already responding on http://127.0.0.1:$Port"
  } else {
    $env:PORT = [string]$Port
    $env:HOSTNAME = "0.0.0.0"

    if ($Mode -eq "prod") {
      $serverJs = Join-Path $Root ".next\standalone\server.js"
      if (-not (Test-Path -LiteralPath $serverJs)) {
        throw "Production server was not found at .next\standalone\server.js. Run npm run build first, or start with -Mode dev."
      }

      $env:NODE_ENV = "production"
      Write-Host "Starting production server on 0.0.0.0:$Port..."
      $appProcess = Start-Process -FilePath $nodePath -ArgumentList @($serverJs) -WorkingDirectory $Root -RedirectStandardOutput $AppOutLog -RedirectStandardError $AppErrLog -PassThru -WindowStyle Hidden
    } else {
      $npmPath = Get-CommandPath -Names @("npm.cmd", "npm")
      if (-not $npmPath) {
        throw "npm was not found. Install Node.js with npm first."
      }

      Write-Host "Starting development server on 0.0.0.0:$Port..."
      $appProcess = Start-Process -FilePath $npmPath -ArgumentList @("run", "dev", "--", "--hostname", "0.0.0.0", "-p", [string]$Port) -WorkingDirectory $Root -RedirectStandardOutput $AppOutLog -RedirectStandardError $AppErrLog -PassThru -WindowStyle Hidden
    }

    $startedApp = $true
    if (-not (Wait-LocalApp -TargetPort $Port)) {
      throw "The local app did not become ready on http://127.0.0.1:$Port. Check $AppOutLog and $AppErrLog."
    }
  }

  Test-StaticAssetsReady -TargetPort $Port

  Write-Host ""
  Write-Host "Local network URLs:"
  Get-LocalUrls -TargetPort $Port | ForEach-Object { Write-Host "  $_" }

  if ($NoTunnel) {
    Write-Host ""
    Write-Host "Tunnel skipped. Press Ctrl+C to stop the local server."
  } else {
    $cloudflaredPath = Get-CommandPath -Names @("cloudflared.exe", "cloudflared")
    if (-not $cloudflaredPath) {
      throw "cloudflared was not found. Install Cloudflare Tunnel first, or run with -NoTunnel for LAN-only access."
    }

    Write-Host ""
    Write-Host "Starting Cloudflare temporary tunnel..."
    $tunnelProcess = Start-Process -FilePath $cloudflaredPath -ArgumentList @("tunnel", "--url", "http://127.0.0.1:$Port") -WorkingDirectory $Root -RedirectStandardOutput $TunnelOutLog -RedirectStandardError $TunnelErrLog -PassThru -WindowStyle Hidden

    $publicUrl = Wait-TunnelUrl
    if (-not $publicUrl) {
      throw "Cloudflare tunnel started, but no public URL was found. Check $TunnelOutLog and $TunnelErrLog."
    }

    Write-Host ""
    Write-Host "Public URL:"
    Write-Host "  $publicUrl"
    Set-Content -LiteralPath $PublicBaseUrlFile -Value $publicUrl -Encoding UTF8
    Write-Host ""
    Write-Host "Keep this window open while using the public link. Press Ctrl+C to stop."
  }

  while ($true) {
    if ($startedApp -and $appProcess.HasExited) {
      throw "The local app process exited. Check $AppOutLog and $AppErrLog."
    }
    if ($tunnelProcess -and $tunnelProcess.HasExited) {
      throw "The Cloudflare tunnel process exited. Check $TunnelOutLog and $TunnelErrLog."
    }
    Start-Sleep -Seconds 2
  }
} finally {
  Stop-StartedProcess -Process $tunnelProcess -Name "Cloudflare tunnel"
  if ($startedApp) {
    Stop-StartedProcess -Process $appProcess -Name "local app"
  }
}
