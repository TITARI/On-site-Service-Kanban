param(
  [string]$PackageName = "",
  [switch]$SkipBuild
)

$ErrorActionPreference = "Stop"
$Root = Split-Path -Parent $PSScriptRoot
$ReleaseRoot = Join-Path $Root "release"
$Timestamp = Get-Date -Format "yyyyMMdd-HHmmss"
if (-not $PackageName) {
  $PackageName = "internal-collaboration-board-windows-$Timestamp"
}

$PackageDir = Join-Path $ReleaseRoot $PackageName
$ZipPath = "$PackageDir.zip"
$ResolvedRoot = [System.IO.Path]::GetFullPath($Root)
$ResolvedRelease = [System.IO.Path]::GetFullPath($ReleaseRoot)
$ResolvedPackage = [System.IO.Path]::GetFullPath($PackageDir)

if (-not $ResolvedRelease.StartsWith($ResolvedRoot, [System.StringComparison]::OrdinalIgnoreCase)) {
  throw "Release directory is outside the workspace."
}
if (-not $ResolvedPackage.StartsWith($ResolvedRelease, [System.StringComparison]::OrdinalIgnoreCase)) {
  throw "Package directory is outside the release directory."
}

if (-not $SkipBuild) {
  Push-Location $Root
  try {
    npm run build
  } finally {
    Pop-Location
  }
}

$StandaloneDir = Join-Path $Root ".next\standalone"
$StaticDir = Join-Path $Root ".next\static"
if (-not (Test-Path -LiteralPath $StandaloneDir)) {
  throw "Standalone build output was not found. Ensure next.config.ts has output: 'standalone' and run npm run build."
}
if (-not (Test-Path -LiteralPath $StaticDir)) {
  throw "Next static output was not found."
}

New-Item -ItemType Directory -Force -Path $ReleaseRoot | Out-Null
if (Test-Path -LiteralPath $PackageDir) {
  Remove-Item -LiteralPath $PackageDir -Recurse -Force
}
if (Test-Path -LiteralPath $ZipPath) {
  Remove-Item -LiteralPath $ZipPath -Force
}
New-Item -ItemType Directory -Force -Path $PackageDir | Out-Null

Copy-Item -Path (Join-Path $StandaloneDir "*") -Destination $PackageDir -Recurse -Force

$PackageNextDir = Join-Path $PackageDir ".next"
New-Item -ItemType Directory -Force -Path $PackageNextDir | Out-Null
Copy-Item -LiteralPath $StaticDir -Destination (Join-Path $PackageNextDir "static") -Recurse -Force

$DataDir = Join-Path $Root "data"
$PackageDataDir = Join-Path $PackageDir "data"
if (Test-Path -LiteralPath $DataDir) {
  Copy-Item -LiteralPath $DataDir -Destination $PackageDataDir -Recurse -Force
} else {
  New-Item -ItemType Directory -Force -Path $PackageDataDir | Out-Null
}

$PackageUpdateDir = Join-Path $PackageDataDir "wxauto-updates"
$ResolvedPackageData = [System.IO.Path]::GetFullPath($PackageDataDir)
$ResolvedPackageUpdates = [System.IO.Path]::GetFullPath($PackageUpdateDir)
if (-not $ResolvedPackageUpdates.StartsWith($ResolvedPackageData, [System.StringComparison]::OrdinalIgnoreCase)) {
  throw "wxauto update directory resolved outside package data directory."
}
if (Test-Path -LiteralPath $PackageUpdateDir) {
  Remove-Item -LiteralPath $PackageUpdateDir -Recurse -Force
}

$BridgeScript = Join-Path $Root "scripts\wxauto-rest-bridge.mjs"
if (Test-Path -LiteralPath $BridgeScript) {
  New-Item -ItemType Directory -Force -Path (Join-Path $PackageDir "tools") | Out-Null
  Copy-Item -LiteralPath $BridgeScript -Destination (Join-Path $PackageDir "tools\wxauto-rest-bridge.mjs") -Force
}

$MigrationsDir = Join-Path $Root "db\migrations"
$WxautoMigration = Join-Path $MigrationsDir "003_wxauto_mcp.sql"
if (-not (Test-Path -LiteralPath $WxautoMigration)) {
  throw "Required wxauto MCP migration was not found: $WxautoMigration"
}
$PackageDbDir = Join-Path $PackageDir "db"
New-Item -ItemType Directory -Force -Path $PackageDbDir | Out-Null
Copy-Item -LiteralPath $MigrationsDir -Destination (Join-Path $PackageDbDir "migrations") -Recurse -Force

$DeployWindowsDir = Join-Path $Root "deploy\windows"
if (Test-Path -LiteralPath $DeployWindowsDir) {
  $DeployWindowsItems = Get-ChildItem -LiteralPath $DeployWindowsDir -Force
  if ($DeployWindowsItems.Count -gt 0) {
    Copy-Item -LiteralPath $DeployWindowsItems.FullName -Destination $PackageDir -Recurse -Force
  }
}

if (Test-Path -LiteralPath (Join-Path $Root "README.md")) {
  Copy-Item -LiteralPath (Join-Path $Root "README.md") -Destination (Join-Path $PackageDir "README-PROJECT.md") -Force
}

Compress-Archive -LiteralPath $PackageDir -DestinationPath $ZipPath -Force

Write-Host "Package directory: $PackageDir"
Write-Host "Zip package: $ZipPath"
