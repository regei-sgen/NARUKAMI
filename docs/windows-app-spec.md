# NARUKAMI — Windows Desktop App Spec

Status: **DRAFT for approval** · Target: package NARUKAMI as a standalone Windows
app with an embedded database, launched by double-clicking an `.exe` — **no
`npm run dev`, no Docker**.

---

## 1. Goal

Turn the current web app (Fastify backend + Vite/React frontend + Postgres in
Docker) into a single installable Windows desktop application:

- One `.exe` to install/run. No terminal, no `npm`, no Docker.
- Database lives **inside the app's data folder** (created on first launch).
- Everything already built stays working: per-project terminals (node-pty),
  Monaco editor, red/black theme, session restore, sidebar collapse.

## 2. Chosen architecture — Electron

**Why Electron (not Tauri):** the backend is Node (Fastify + **node-pty** + `ws`
+ Prisma). Electron runs Node in its main process → the backend is reused almost
verbatim. Tauri's backend is Rust → node-pty and Fastify would have to be
rewritten in Rust. Not worth it.

```
┌─ Electron main process (Node) ─────────────────────────┐
│  • boots the Fastify backend in-process on 127.0.0.1   │
│    (random free port)                                  │
│  • owns node-pty terminals + the embedded DB           │
│  • creates the BrowserWindow                           │
└────────────────────────────────────────────────────────┘
                     │ loads
                     ▼
┌─ Renderer (Chromium) ──────────────────────────────────┐
│  • the built Vite/React frontend (dist/), NOT dev server│
│  • xterm + Monaco + WS to 127.0.0.1:<port>             │
└────────────────────────────────────────────────────────┘
```

New workspace package: **`packages/desktop`** (Electron main + preload +
electron-builder config). Backend and frontend packages stay as-is (with the DB
change below).

## 3. Embedded database — replace Postgres/Docker

Docker exists **only** to run Postgres. Dropping Docker means swapping the
datasource to a file-based DB stored under
`app.getPath('userData')` (e.g. `%APPDATA%\NARUKAMI\narukami.db`).

**Open decision — the one thing to pick before building.** There are 50 Prisma
call-sites across 7 backend files, so the DB engine choice is a real fork:

| | Option A — **Prisma + SQLite** (recommended) | Option B — **better-sqlite3** |
|---|---|---|
| Query code changes | ~0 (keep all 50 call-sites + existing migrations) | Rewrite all ~50 call-sites to SQL |
| Schema/migrations | reuse `prisma/migrations` (SQLite provider) | hand-write `schema.sql` |
| Packaging effort | bundle Prisma query-engine (`asarUnpack` + runtime env) — fiddly but solved | trivial (single native `.node`, rebuilt for Electron) |
| Runtime | async (unchanged) | synchronous (fits Electron main well) |
| Binary size | +~15 MB (engine) | +~5 MB |
| Net verdict | **least total work now** (keeps 50 queries + migration history) | cleanest packaging, but a full data-layer rewrite |

> Recommendation flipped to **Option A (Prisma + SQLite)** after counting the 50
> call-sites: keeping the queries + the migration history I already wrote is less
> total risk than a full rewrite. Earlier I leaned better-sqlite3 before knowing
> the surface area. Final call is yours.

Both are **DB-agnostic to the features** — session restore, workspace, logs all
carry over. Migrations run automatically on first launch (`prisma migrate
deploy` programmatically, or `db push` fallback).

## 4. Process & security model

- Backend boots **in-process** inside Electron main (import `main()` from the
  backend package) on `127.0.0.1` + a **random free port** (not hard-coded 4000).
- Renderer learns the port + token via Electron **preload** (`contextBridge`),
  not via a `.env` file. Keeps `contextIsolation: true`, `nodeIntegration:
  false`.
- Bearer token: keep the existing scheme (generated, stored in userData). Or drop
  it since renderer↔main is same-origin local — **keep it** (cheap, defensive).
- Loopback binding + token stay. No network exposure. Same threat model as today
  (a local RCE tool the user runs on their own machine).
- CSP on the renderer; disable remote content; `will-navigate` guard.

## 5. Native modules (the real packaging work)

Native `.node` addons must be rebuilt for **Electron's** Node ABI and unpacked
from the asar archive:

- **node-pty** — terminals. `electron-rebuild` + `asarUnpack`.
- **Prisma query engine** (Option A) or **better-sqlite3** (Option B) — same
  treatment.

`electron-builder` config:
```jsonc
"asarUnpack": ["**/node_modules/node-pty/**", "**/node_modules/@prisma/**", "**/*.node"],
"win": { "target": ["nsis"] },   // NSIS Setup.exe (recommended) — see §7
"files": ["dist-main/**", "packages/frontend/dist/**", "packages/backend/dist/**"]
```
Add a `postinstall`/`rebuild` step: `electron-rebuild -f -w node-pty`.

## 6. Data & file locations (userData)

`app.getPath('userData')` → `%APPDATA%\NARUKAMI\`:
- `narukami.db` — the SQLite database (schema + projects + runs + logs + settings).
- `.runner-token` — bearer token.
- `logs/` — optional app logs.

Nothing is written next to the `.exe` (Program Files is read-only). First launch
creates the folder + DB + runs migrations.

## 7. Packaging format

- **NSIS installer (`NARUKAMI-Setup.exe`)** — recommended. Installs to Program
  Files, Start-Menu shortcut, uninstaller, per-user or per-machine.
- Alternative: **portable `.exe`** — single double-click, no install, runs from
  anywhere. (Pick one; NSIS unless you want portable.)
- Code signing: optional; unsigned triggers SmartScreen "unknown publisher"
  (user clicks "Run anyway"). A cert removes that but costs $ — out of scope for v1.

## 8. Build pipeline

`npm run build:desktop` orchestrates:
1. `tsc` backend → `packages/backend/dist`
2. `vite build` frontend → `packages/frontend/dist`
3. `tsc` desktop main/preload → `packages/desktop/dist-main`
4. `electron-rebuild` native modules
5. `electron-builder --win nsis` → `release/NARUKAMI-Setup.exe`

Dev loop for the desktop shell: `electron` pointed at the built frontend (or Vite
dev URL in dev mode) — but the **shipped** app always loads the built frontend.

## 9. What changes vs. what stays

**Changes**
- `packages/backend/prisma/schema.prisma`: provider `postgresql` → `sqlite`,
  `DATABASE_URL` → `file:<userData>/narukami.db` (Option A). Or rewrite `db.ts` +
  50 call-sites (Option B).
- `backend/src/index.ts`: export a `start()` the Electron main can call
  in-process on a chosen port (instead of only `listen`-on-4000 + `main()`).
- `frontend/src/api.ts`: base URL/token come from preload-injected values, not
  `import.meta.env`.
- Remove Docker/`db:up`/`db:down` from the shipped app (keep for dev if wanted).

**Stays (no logic change)**
- node-pty terminals, ws reconnect/replay, session restore, workspace/settings,
  Monaco editor, red/black theme, sidebar collapse, rename/persist.

## 10. Risks / open questions

1. **DB engine** (§3) — needs your pick (A recommended).
2. **Prisma-in-Electron packaging** (if A) — engine path + `migrate deploy` at
   runtime is the fiddly bit; well-documented, but the main risk area.
3. **`claude` CLI dependency** — the Analyze/Claude features shell out to a
   globally-installed `claude`. The desktop app can't bundle it; behavior is
   unchanged (clear error if missing). Note in onboarding.
4. **First-launch antivirus/SmartScreen** on an unsigned exe (§7).
5. **Auto-update** — out of scope for v1 (could add `electron-updater` later).

## 11. Effort & phases

- **Phase 1 — DB swap:** schema→SQLite (A) or data-layer rewrite (B); migrations
  run on boot; verify all features against the file DB with the current web app.
- **Phase 2 — Electron shell:** `packages/desktop` main+preload; boot backend
  in-process on random port; load built frontend; token/port via preload.
- **Phase 3 — Packaging:** electron-rebuild native mods; asarUnpack; NSIS build;
  install + smoke-test the `.exe` on a clean path.

Rough size: a focused multi-session build. **Highest risk = native-module
packaging (Phase 3) and Prisma engine bundling (if A).**

## 12. Acceptance criteria

- Double-click `NARUKAMI-Setup.exe` → installs → launches with no terminal/Docker.
- DB auto-created under `%APPDATA%\NARUKAMI\`; projects/terminals/settings persist
  across full app close+reopen (session restore intact).
- Open shell/claude/command terminals work (node-pty) inside the packaged app.
- Monaco editor reads/writes project files.
- Uninstaller removes the app (offers to keep or delete userData).

---

### Decision needed to start
1. **DB engine:** A = Prisma + SQLite (recommended, least work) · B = better-sqlite3 (clean packaging, full rewrite).
2. **Installer:** NSIS `Setup.exe` (recommended) · portable `.exe`.

Say the choices (or "use your defaults") and I'll build Phase 1 → 3.
