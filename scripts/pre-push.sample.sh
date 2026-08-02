#!/bin/sh
#
# NARUKAMI pre-push hook — SAMPLE. Not installed, and deliberately so: enabling a
# git hook changes the owner's local workflow silently, which is not something a
# commit should do to you. Install it yourself, if you want it, with ONE line:
#
#     cp scripts/pre-push.sample.sh .git/hooks/pre-push
#
# (On Windows/Git-Bash that is enough — git does not check the exec bit there.
#  On macOS/Linux add: chmod +x .git/hooks/pre-push)
#
# Uninstall:  rm .git/hooks/pre-push
#
# Deliberately NOT `git config core.hooksPath …` — that would take over EVERY
# hook for this clone, not just pre-push.
#
# What it runs is exactly the blocking half of .github/workflows/ci.yml, so a
# push that passes here is the same push CI will accept:
#
#     npm run verify   ==   npm run typecheck && npm run test:coverage
#
# It does NOT run lint (22 known pre-existing errors — advisory in CI too) and it
# does NOT run the integration suite (shells real CLIs, one test is currently
# red). Adding either here would train you to push with --no-verify, which is
# worse than not having the hook.
#
# Escape hatch, for a WIP branch:  git push --no-verify

set -e

repo_root=$(git rev-parse --show-toplevel)
cd "$repo_root"

echo "[pre-push] npm run verify (typecheck x3 + unit tests + coverage floors + LAN-skip audit)"
echo "[pre-push] to skip: git push --no-verify"

if ! npm run verify; then
  echo ""
  echo "[pre-push] BLOCKED: verify failed. Nothing was pushed."
  echo "[pre-push] Fix it, or push with --no-verify if you know what you are doing."
  exit 1
fi

echo "[pre-push] verify OK — pushing."
