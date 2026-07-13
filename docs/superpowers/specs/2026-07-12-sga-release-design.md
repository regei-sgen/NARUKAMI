# SGA Release tab — design (2026-07-12)

One-click release flow for the SG Claude Assistant repo, as a NARUKAMI tab: bump the three
version files, build the upload-ready zip, and have Claude write the patch-note summary +
description — both copyable from the browser.

## Decisions (confirmed with the owner)

- **Notes engine:** `claude -p` over CHANGELOG `[Unreleased]` + the release's git-log range —
  same quality bar as the `release-zip` skill's Step 4 (plain-language ≤50-word summary, no
  jargon; grouped past-tense description lines). JSON contract `{summary, description}`.
- **Bump policy:** bump `VERSION.md` + `bridge/package.json` + `extension/manifest.json` in the
  working tree, **never commit** — the user commits when ready.
- **Dirty tree:** warn-and-confirm. Uncommitted changes (beyond the three version files) ship in
  the zip only after an explicit "include uncommitted changes" checkbox; server enforces with 409.
- **Architecture:** two-step API — POST `/release` (deterministic: preflight guards → bump →
  `git add` → `git stash create` → `git restore --staged` → `git archive --format=zip` →
  `~/sgen-claude-chat-v<version>.zip`, Release row recorded) returns in seconds; POST
  `/releases/:id/notes` (claude -p, 300s budget, idempotent/retryable) fills the notes in after.
  History persists in SQLite so notes stay re-copyable.

## Backend

- `services/release.ts` — pure editors (`bumpJsonVersion`, `bumpVersionMd`, `extractUnreleased`,
  `suggestNextVersion`), SGA fingerprint (the 3 files exist → `isSga`), preflight (reuses
  `gitStatus`), `buildReleaseZip` (restores the 3 files on failure; archives `git stash create`
  output or HEAD), `collectNotesMaterial` (boundary: previous release's recorded `headCommit` →
  last commit touching VERSION.md → newest 150; caps keep the prompt under the Windows argv limit).
- `services/analyzer.ts` — `runClaude` gains an optional timeout; new `generateReleaseNotes`
  (JSON out, `AnalyzerError` on parse/timeout).
- `routes/release.ts` — preflight / create / notes / list / zip-download / delete; `/api/*` auth
  inherited from the global hook; per-project in-process release lock (409 on double-click);
  errors follow the `{ error, detail? }` house shape (400/404/409/502/500).
- `schema.prisma` `Release` model + matching `CREATE TABLE IF NOT EXISTS` in `db.ts`
  `ADDITIVE_TABLES` (packaged installs never migrate).

## Frontend

- `components/SgaRelease.tsx` — EodView-patterned cards: 01 version + repo state (editable next
  version, dirty list + confirm checkbox, Release button), 02 zip artifact (path copy + authed
  blob download), 03 patch notes (summary/description copy buttons, regenerate), plus past
  releases (open/delete). `'release'` view wired into `App.tsx` (union, boot whitelist, nav strip,
  render ladder) + `types.ts`; api methods + `downloadReleaseZip` in `api.ts`; `.rel-*` styles
  appended to `styles.css`.

## Testing / verification (all run 2026-07-12)

- Backend: 17 pure unit tests (fixtures mirror the real SGA files), 7 real-git integration tests
  (temp SGA-shaped repo: bump→archive→uncommitted proof, dirty-include, failure-restore), 16
  route tests (Fastify inject, mocked prisma/service). 40/40 green; typecheck clean.
- Frontend: 7 component tests (preflight seed, non-SGA state, dirty confirm gating, one-click
  flow, clipboard, history delete). 155/155 suite green; typecheck clean.
- Live: dev stack booted; `ensureSchema` created the Release table; preflight against the real
  SGEN repo returned `isSga:true, 2.7.0 → 2.7.1` over HTTP with the runner token.
- Known-unrelated: `godclaude.test.ts` / `godclaude.integration.test.ts` each have 1 pre-existing
  failure (vendored CLI arm behavior on this machine) — untouched by this feature.
