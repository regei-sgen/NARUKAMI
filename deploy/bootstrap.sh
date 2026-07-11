#!/usr/bin/env bash
#
# NARUKAMI bootstrap — macOS / Linux
#
# One command to make a fresh clone runnable:
#   install deps -> create local env -> migrate the SQLite DB -> generate the
#   auth token -> build. Optionally install the Claude Code assets and/or start
#   the dev app.
#
# Usage (from anywhere):
#   ./deploy/bootstrap.sh
#   ./deploy/bootstrap.sh --run
#   ./deploy/bootstrap.sh --claude-assets
#
# Flags:
#   --run            after setup, start the dev app (npm run dev)
#   --claude-assets  install the NARUKAMI Claude Code skills/commands into ~/.claude
#   --skip-install   skip `npm install` (deps already present)
#
# NOTE: the packaged desktop installer is Windows-only (electron-builder --win
# nsis). On macOS/Linux this script sets up + runs the dev app; use a Windows
# machine (or `--win` cross-build tooling) to produce the .exe installer.
#
# No secrets are created except a local, gitignored .runner-token (random,
# per-machine). Nothing is uploaded anywhere.

set -euo pipefail

RUN=0
CLAUDE_ASSETS=0
SKIP_INSTALL=0
for arg in "$@"; do
  case "$arg" in
    --run) RUN=1 ;;
    --claude-assets) CLAUDE_ASSETS=1 ;;
    --skip-install) SKIP_INSTALL=1 ;;
    *) echo "unknown flag: $arg" >&2; exit 2 ;;
  esac
done

# Repo root = parent of this deploy/ folder, resolved regardless of CWD.
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
cd "$ROOT"

cyan() { printf '\n==> %s\n' "$1"; }
ok()   { printf '    %s\n' "$1"; }

cyan "NARUKAMI bootstrap  (repo: $ROOT)"

# 1. Toolchain check
if ! command -v node >/dev/null 2>&1; then
  echo "Node.js not found on PATH. Install Node 18+ (https://nodejs.org) and re-run." >&2
  exit 1
fi
ok "node $(node --version)"
command -v npm >/dev/null 2>&1 || { echo "npm not found on PATH." >&2; exit 1; }

# 2. Install workspaces
if [ "$SKIP_INSTALL" -eq 0 ]; then
  cyan "npm install (all workspaces)"
  npm install
fi

# 3. Local env files (copied from tracked .env.example; never committed)
cyan "Local env files"
if [ ! -f packages/backend/.env ]; then
  cp packages/backend/.env.example packages/backend/.env
  ok "created packages/backend/.env (from .env.example)"
else
  ok "packages/backend/.env already present"
fi

# 4. SQLite schema (no Docker)
cyan "Create SQLite schema (prisma migrate deploy)"
( cd packages/backend && npx prisma migrate deploy )
ok "database ready (packages/backend/prisma/dev.db)"

# 5. Auth token + frontend wiring
cyan "Generate runner token"
npm run token

# 6. Build backend + frontend
cyan "Build (backend + frontend)"
npm run build
ok "build complete"

# 7. Optional: install Claude Code assets into ~/.claude
if [ "$CLAUDE_ASSETS" -eq 1 ]; then
  cyan "Install NARUKAMI Claude Code assets into ~/.claude"
  bash "$SCRIPT_DIR/claude/install-claude-assets.sh"
fi

cyan "Done."
echo "  Dev app:  npm run dev  -> http://localhost:5173"

# 8. Optional: run now
if [ "$RUN" -eq 1 ]; then
  cyan "Starting dev app (npm run dev)"
  npm run dev
fi
