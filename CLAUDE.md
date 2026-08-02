# CLAUDE.md — NARUKAMI

An index, not a manual. It points at the real sources; read those for detail.
Everything here was verified against the repo on 2026-08-02 — if you change a
fact below, change it here too.

NARUKAMI registers software projects by path, has Claude Code analyze how each
one runs, and runs each command in its own live browser terminal. It ships both
as a local web runner and as a packaged Electron desktop app.

## Where to read more

| Source | What it holds |
| --- | --- |
| `README.md` | setup, the full API-route index, security model, platform notes |
| `FEATURES.md` | what each UI surface actually does (§4 per-feature) |
| `AUDIT-2026-08-01.md` | the deep audit and its 28-item remediation roadmap |
| `docs/windows-app-spec.md`, `docs/superpowers/` | desktop spec, deeper notes |
| `.github/workflows/ci.yml` | the gate; its header comments explain each job |
| `eslint.config.mjs` | every lint rule, why it is on, and its measured count |

## Layout

npm workspaces monorepo. `packages/backend`, `packages/frontend`,
`packages/desktop` — nothing else is a workspace.

- **backend** — Fastify + Prisma/SQLite + `node-pty` + `ws`. CommonJS. Loopback
  `127.0.0.1:4000` (`src/config.ts`). Routes in `src/routes/`, logic in
  `src/services/`, tests colocated as `*.test.ts`.
- **frontend** — React 18 + Vite on `:5173`, xterm.js terminals, Monaco editor.
  ESM. Components in `src/components/`.
- **desktop** — Electron 33.4.11 shell (`src/main.ts`, `src/preload.ts`,
  `src/lhm.ts`), packaged by electron-builder to an NSIS installer.

## Commands

```
npm run dev              # token + backend & frontend together
npm run typecheck        # all THREE workspaces
npm run test:unit        # scripts/run-unit-tests.mjs — backend + frontend only
npm run test:integration # backend *.integration.test.ts — shells real git/CLIs
npm run lint:strict      # eslint . --max-warnings 0   (blocking in CI)
npm run test:hooks       # the vendored GODCLAUDE hook suite
npm run vendor:check     # VENDOR.json content hash is current
npm run verify           # typecheck + lint:strict + coverage + hooks + vendor
npm run desktop          # build, then run the Electron shell
```

## Things you will get wrong if nobody tells you

- **Base branch is `dan-dev`, not `main`.** Branch from it and target diffs/PRs
  at it. CI triggers on both (`ci.yml`).
- **Never `npm ci --ignore-scripts`.** The backend's `postinstall` runs
  `prisma generate`, which writes `packages/backend/src/generated/` — gitignored
  (`.gitignore:10`), so without the postinstall the generated Prisma types do
  not exist and every backend typecheck and test fails.
- **This is a Windows-first repo.** All three CI jobs are `windows-latest`; the
  suite has only ever been proven green on Windows. Commands run through
  `powershell.exe -NoLogo -NoProfile -Command "<cmd>"` inside a **ConPTY**
  (`$SHELL -lc` elsewhere). `node-pty` ships prebuilts — a rebuild needs VS Build
  Tools. CPU die temperature comes only from **LibreHardwareMonitor**
  (`packages/desktop/src/lhm.ts` + `backend/src/services/pcstats.ts`,
  `NARUKAMI_LHM_PORT`); the WMI/ACPI paths do not work.
- **The shell here is PowerShell**, not bash — `&&`/`||` chaining and here-strings
  behave differently. Repo scripts are `.mjs` run by node, so they are portable.
- **`npm run test:unit` does NOT cover the desktop workspace.** `run-unit-tests.mjs`
  iterates backend + frontend only. `packages/desktop/src/main.ts` has no test
  coverage at all — typecheck is the only automated check on it.
- **Coverage floors are enforced** and are a ratchet, never lowered: backend
  63/78/75/63, frontend 44/76/44/44 (statements/branches/functions/lines), set in
  each package's `vitest.config.ts` with the measurement they came from.
- **The LAN-skip audit is real.** `scripts/check-skips.mjs` fails a run that went
  green by *skipping*. Six tests are LAN-gated via `scripts/lan-gated-tests.mjs`;
  CI sets `NARUKAMI_REQUIRE_LAN=1` so a loopback-only runner goes red instead of
  quietly skipping them.
- **Lint is blocking and the tree is at ZERO errors and ZERO warnings.** Because
  `lint:strict` is `--max-warnings 0`, downgrading a rule to `warn` does not make
  anything green — a rule that cannot be satisfied is scoped off in
  `eslint.config.mjs` with its measured count. Do not add `eslint-disable`
  comments and do not loosen a rule to pass.
- **`any` is lint-blocked in backend and frontend** (`no-explicit-any` plus the
  `no-unsafe-*` family). Widening a type to `any` to silence `tsc` will fail CI.
  It is deliberately off for `packages/desktop/**` (untyped CDP payloads) and the
  `no-unsafe-*` half is off in `*.test.ts(x)` — see the header of
  `eslint.config.mjs` for the counts behind each decision.

## The vendored GODCLAUDE payload

`packages/backend/godclaude-assets/` is a third-party runtime snapshot copied in
by `scripts/vendor-godclaude.mjs`, shipped inside the installer
(`desktop/package.json` → `extraResources`) and provisioned onto a user's machine
by `backend/src/services/godclaude.ts`.

- It is **eslint-ignored on purpose** (upstream's code, re-vendored wholesale) but
  it is **not untested**: its own suite runs via `npm run test:hooks` in CI.
- `VENDOR.json` carries `version` *and* `contentHash`. `refreshIfProvisioned()`
  uses both as the cache key, so editing a vendored file re-provisions users even
  when the hand-typed version string does not move. After touching anything in
  that directory run `npm run vendor:hash`; `npm run vendor:check` enforces it.
- The hash is line-ending-normalised deliberately — `.gitattributes` is
  `* text=auto eol=lf`, so a raw-byte hash differs between a CRLF working tree
  and a fresh LF checkout. See the header of `scripts/hash-vendor-assets.mjs`.

## Conventions

- Comments in this repo explain **why**, and cite measurements and dates. Match
  that; a comment asserting something you did not measure is worse than none.
- Tests sit next to their source. `*.integration.test.ts` shell real binaries and
  are excluded from the unit run.
- Auth is a bearer token in `.runner-token` (`npm run token`); everything binds to
  loopback except the opt-in phone stats server. Do not widen a bind address.
