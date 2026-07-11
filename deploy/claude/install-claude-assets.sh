#!/usr/bin/env bash
#
# Install the NARUKAMI Claude Code assets into this machine's ~/.claude.
#
# Copies:
#   deploy/claude/commands/narukami.md          -> ~/.claude/commands/narukami.md
#   deploy/claude/skills/narukami-update/        -> ~/.claude/skills/narukami-update/
#
# ...and substitutes the __NARUKAMI_REPO__ placeholder with THIS clone's repo
# root, so "/narukami" (launch) and "Narukami God" (update) point at the right
# folder on any device.
#
# Only these two NARUKAMI-specific assets are touched. Nothing else in ~/.claude
# is read, modified, or uploaded. No credentials are involved.
#
# (The "Narukami God" desktop update flow itself is Windows-only — the launch
# command works everywhere.)

set -euo pipefail

CLAUDE_SRC="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT="$(cd "$CLAUDE_SRC/../.." && pwd)"
DEST="${HOME}/.claude"

echo "==> Installing NARUKAMI Claude assets"
echo "    repo:  $ROOT"
echo "    into:  $DEST"

if [ ! -d "$DEST" ]; then
  echo "    (~/.claude not found — creating it. If Claude Code isn't installed, install it first.)"
  mkdir -p "$DEST"
fi

install_file() {
  local src_rel="$1" dst_rel="$2"
  local src="$CLAUDE_SRC/$src_rel" dst="$DEST/$dst_rel"
  mkdir -p "$(dirname "$dst")"
  # substitute the placeholder with the repo root (| delimiter avoids clashing
  # with the path's slashes)
  sed "s|__NARUKAMI_REPO__|$ROOT|g" "$src" > "$dst"
  echo "    + $dst_rel"
}

install_file 'commands/narukami.md' 'commands/narukami.md'
install_file 'skills/narukami-update/SKILL.md' 'skills/narukami-update/SKILL.md'

echo "==> Done. Restart Claude Code (or /reload) to pick up the new skill + command."
echo "    /narukami       launch the dev app"
echo "    Narukami God    build + install the desktop app (Windows only)"
