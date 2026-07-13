<#
  NARUKAMI bootstrap - Windows (PowerShell)

  One command to make a fresh clone runnable on this machine:
    install deps -> create local env -> migrate the SQLite DB -> generate the
    auth token -> build. Optionally build the desktop installer, install the
    Claude Code assets, and/or start the dev app.

  Usage (from anywhere):
    powershell -ExecutionPolicy Bypass -File deploy\bootstrap.ps1
    powershell -ExecutionPolicy Bypass -File deploy\bootstrap.ps1 -Run
    powershell -ExecutionPolicy Bypass -File deploy\bootstrap.ps1 -Desktop
    powershell -ExecutionPolicy Bypass -File deploy\bootstrap.ps1 -ClaudeAssets

  Flags:
    -Run           after setup, start the dev app (npm run dev)
    -Desktop       after setup, build the desktop installer (npm run desktop:dist)
    -ClaudeAssets  install the NARUKAMI Claude Code skills/commands into ~/.claude
    -SkipInstall   skip `npm install` (deps already present)

  No secrets are created except a local, gitignored .runner-token (random,
  per-machine). Nothing is uploaded anywhere.
#>
[CmdletBinding()]
param(
  [switch]$Run,
  [switch]$Desktop,
  [switch]$ClaudeAssets,
  [switch]$SkipInstall
)

$ErrorActionPreference = 'Stop'

# Repo root = parent of this deploy\ folder, resolved regardless of CWD.
$Root = Split-Path -Parent $PSScriptRoot
Set-Location $Root

function Step($msg) { Write-Host "`n==> $msg" -ForegroundColor Cyan }
function Ok($msg)   { Write-Host "    $msg" -ForegroundColor Green }

Step "NARUKAMI bootstrap  (repo: $Root)"

# 1. Toolchain check ---------------------------------------------------------
$node = Get-Command node -ErrorAction SilentlyContinue
if (-not $node) { throw "Node.js not found on PATH. Install Node 18+ (https://nodejs.org) and re-run." }
$nodeVer = (& node --version)
Ok "node $nodeVer"
if (-not (Get-Command npm -ErrorAction SilentlyContinue)) { throw "npm not found on PATH." }

# 2. Install workspaces ------------------------------------------------------
if (-not $SkipInstall) {
  Step "npm install (all workspaces)"
  npm install
  if ($LASTEXITCODE -ne 0) { throw "npm install failed." }
}

# 3. Local env files (copied from tracked .env.example; never committed) ------
Step "Local env files"
$beEnv = Join-Path $Root 'packages\backend\.env'
$beExample = Join-Path $Root 'packages\backend\.env.example'
if (-not (Test-Path $beEnv)) {
  Copy-Item $beExample $beEnv
  Ok "created packages\backend\.env (from .env.example)"
} else {
  Ok "packages\backend\.env already present"
}

# 4. SQLite schema (no Docker) ----------------------------------------------
Step "Create SQLite schema (prisma migrate deploy)"
Push-Location (Join-Path $Root 'packages\backend')
try {
  npx prisma migrate deploy
  if ($LASTEXITCODE -ne 0) { throw "prisma migrate deploy failed." }
} finally { Pop-Location }
Ok "database ready (packages\backend\prisma\dev.db)"

# 5. Auth token + frontend wiring -------------------------------------------
Step "Generate runner token"
npm run token
if ($LASTEXITCODE -ne 0) { throw "token generation failed." }

# 6. Build backend + frontend ------------------------------------------------
Step "Build (backend + frontend)"
npm run build
if ($LASTEXITCODE -ne 0) { throw "build failed." }
Ok "build complete"

# 7. Optional: desktop installer --------------------------------------------
if ($Desktop) {
  Step "Build desktop installer (electron-builder)"
  npm run desktop:dist
  if ($LASTEXITCODE -ne 0) { throw "desktop:dist failed." }
  Ok "installer -> packages\desktop\release\NARUKAMI-Setup-*.exe"
}

# 8. Optional: install Claude Code assets into ~/.claude ---------------------
if ($ClaudeAssets) {
  Step "Install NARUKAMI Claude Code assets into ~/.claude"
  & (Join-Path $PSScriptRoot 'claude\install-claude-assets.ps1')
}

Step "Done."
Write-Host "  Dev app:      npm run dev        -> http://localhost:5173" -ForegroundColor Yellow
Write-Host "  Desktop dev:  npm run desktop" -ForegroundColor Yellow
Write-Host "  Installer:    npm run desktop:dist" -ForegroundColor Yellow

# 9. Optional: run now -------------------------------------------------------
if ($Run) {
  Step "Starting dev app (npm run dev)"
  npm run dev
}
