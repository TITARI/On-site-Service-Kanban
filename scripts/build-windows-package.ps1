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
if (Test-Path -LiteralPath $DataDir) {
  Copy-Item -LiteralPath $DataDir -Destination (Join-Path $PackageDir "data") -Recurse -Force
} else {
  New-Item -ItemType Directory -Force -Path (Join-Path $PackageDir "data") | Out-Null
}

$BridgeScript = Join-Path $Root "scripts\wxauto-rest-bridge.mjs"
if (Test-Path -LiteralPath $BridgeScript) {
  New-Item -ItemType Directory -Force -Path (Join-Path $PackageDir "tools") | Out-Null
  Copy-Item -LiteralPath $BridgeScript -Destination (Join-Path $PackageDir "tools\wxauto-rest-bridge.mjs") -Force
}

Copy-Item -Path (Join-Path $Root "deploy\windows\*") -Destination $PackageDir -Recurse -Force

if (Test-Path -LiteralPath (Join-Path $Root "README.md")) {
  Copy-Item -LiteralPath (Join-Path $Root "README.md") -Destination (Join-Path $PackageDir "README-PROJECT.md") -Force
}

Compress-Archive -LiteralPath $PackageDir -DestinationPath $ZipPath -Force

Write-Host "Package directory: $PackageDir"
Write-Host "Zip package: $ZipPath"
