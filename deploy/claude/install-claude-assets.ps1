<#
  Install the NARUKAMI Claude Code assets into this machine's ~/.claude.

  Copies:
    deploy/claude/commands/narukami.md          -> ~/.claude/commands/narukami.md
    deploy/claude/skills/narukami-update/        -> ~/.claude/skills/narukami-update/

  ...and substitutes the __NARUKAMI_REPO__ placeholder with THIS clone's repo
  root, so "/narukami" (launch) and "Narukami God" (update) point at the right
  folder on any device.

  Only these two NARUKAMI-specific assets are touched. Nothing else in ~/.claude
  is read, modified, or uploaded. No credentials are involved.
#>
[CmdletBinding()]
param()
$ErrorActionPreference = 'Stop'

# repo root = deploy/claude -> deploy -> <root>
$ClaudeSrc = $PSScriptRoot
$Root = Split-Path -Parent (Split-Path -Parent $ClaudeSrc)
$Dest = Join-Path $env:USERPROFILE '.claude'

Write-Host "==> Installing NARUKAMI Claude assets" -ForegroundColor Cyan
Write-Host "    repo:  $Root"
Write-Host "    into:  $Dest"

if (-not (Test-Path $Dest)) {
  Write-Host "    (~/.claude not found - creating it. If Claude Code isn't installed, install it first.)" -ForegroundColor Yellow
  New-Item -ItemType Directory -Path $Dest | Out-Null
}

# repo root, substituted literally into the copied asset files
$RootLiteral = $Root

function Install-File($srcRel, $destRel) {
  $src = Join-Path $ClaudeSrc $srcRel
  $dst = Join-Path $Dest $destRel
  $dstDir = Split-Path -Parent $dst
  if (-not (Test-Path $dstDir)) { New-Item -ItemType Directory -Path $dstDir -Force | Out-Null }
  # plain string replace (no regex) so Windows backslash paths substitute literally
  $content = (Get-Content -Raw -LiteralPath $src).Replace('__NARUKAMI_REPO__', $RootLiteral)
  Set-Content -LiteralPath $dst -Value $content -Encoding UTF8
  Write-Host "    + $destRel" -ForegroundColor Green
}

Install-File 'commands\narukami.md' 'commands\narukami.md'
Install-File 'skills\narukami-update\SKILL.md' 'skills\narukami-update\SKILL.md'

Write-Host "==> Done. Restart Claude Code (or /reload) to pick up the new skill + command." -ForegroundColor Cyan
Write-Host "    /narukami       launch the dev app" -ForegroundColor Yellow
Write-Host "    Narukami God    build + install the desktop app (Windows)" -ForegroundColor Yellow
