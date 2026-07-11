# 🚀 NARUKAMI — Portable Deploy Guide

Take a fresh clone of this repo and make it run — **the same way it runs on the
original machine** — on your device or any other. One command sets up the app;
one flag reproduces the Claude Code layer (`/narukami`, "Narukami God").

> **Reminder:** NARUKAMI executes shell commands on the host. It binds to
> `127.0.0.1` only and requires a per-machine bearer token. Treat it as local
> remote-code-execution. Never expose it to a network.

---

## TL;DR

```bash
git clone https://github.com/regei-sgen/NARUKAMI.git
cd NARUKAMI
```

**Windows (PowerShell):**
```powershell
powershell -ExecutionPolicy Bypass -File deploy\bootstrap.ps1
npm run dev            # http://localhost:5173
```

**macOS / Linux:**
```bash
./deploy/bootstrap.sh
npm run dev            # http://localhost:5173
```

That's it — installed, migrated, tokened, built.

---

## Prerequisites

| Need | Why | Notes |
| ---- | --- | ----- |
| **Node.js 18+** (22 tested) + npm | build + run | https://nodejs.org |
| **git** | clone | — |
| **`claude` CLI** (optional) | the Analyze/Diagnose features + the Claude Code skills | install Claude Code, then `claude login` on the new device |
| **Windows** | only to build the packaged `.exe` installer | the dev app + web UI run on macOS/Linux too |
| C++ build tools (rare) | only if `node-pty` triggers a native rebuild | VS Build Tools on Windows; a C++ toolchain elsewhere. Prebuilt binaries ship by default. |

No Docker. No Postgres. The database is an embedded SQLite file.

---

## What `bootstrap` does

Both `bootstrap.ps1` and `bootstrap.sh` run the same steps, resolving the repo
root automatically (run them from anywhere):

1. **Toolchain check** — Node + npm present.
2. **`npm install`** — all three workspaces (`backend`, `frontend`, `desktop`).
3. **Local env** — copies `packages/backend/.env.example` → `.env` if missing
   (gitignored; holds only `DATABASE_URL="file:./dev.db"`).
4. **`prisma migrate deploy`** — creates the SQLite schema at
   `packages/backend/prisma/dev.db` (non-interactive).
5. **`npm run token`** — generates a random 32-byte `.runner-token` (gitignored,
   per-machine) and writes `packages/frontend/.env` with `VITE_RUNNER_TOKEN`.
6. **`npm run build`** — builds backend + frontend.

### Flags

| Flag (ps1 / sh) | Effect |
| --------------- | ------ |
| `-Run` / `--run` | start the dev app after setup (`npm run dev`) |
| `-Desktop` (Windows) | build the desktop installer (`npm run desktop:dist`) → `packages/desktop/release/NARUKAMI-Setup-*.exe` |
| `-ClaudeAssets` / `--claude-assets` | install the NARUKAMI Claude Code skill + command into `~/.claude` (see below) |
| `-SkipInstall` / `--skip-install` | skip `npm install` |

---

## Run targets

| Target | Command | URL / output |
| ------ | ------- | ------------ |
| **Dev app** (hot reload) | `npm run dev` | http://localhost:5173 |
| **Desktop dev** (Electron) | `npm run desktop` | native window, embedded SQLite |
| **Desktop installer** (Windows) | `npm run desktop:dist` | `packages/desktop/release/NARUKAMI-Setup-*.exe` |

The packaged app seeds its database on first launch from the bundled template and
then stores everything in your OS user-data dir — it does **not** touch the repo.

---

## The Claude Code layer (optional but part of "how it runs here")

NARUKAMI is driven with two Claude Code triggers:

- **`/narukami`** — launch the dev app.
- **"Narukami God"** (any casing) — build + install the desktop app (Windows).

These live in `~/.claude` (per-user Claude Code config), not in the app itself.
This repo ships **portable, sanitized copies** under `deploy/claude/`:

```
deploy/claude/
├── commands/narukami.md                 # /narukami launch command
├── skills/narukami-update/SKILL.md       # "Narukami God" desktop-update skill
├── install-claude-assets.ps1            # installer (Windows)
└── install-claude-assets.sh             # installer (macOS/Linux)
```

Install them into `~/.claude` on the new device:

```powershell
# Windows
powershell -ExecutionPolicy Bypass -File deploy\claude\install-claude-assets.ps1
# ...or as part of setup:
powershell -ExecutionPolicy Bypass -File deploy\bootstrap.ps1 -ClaudeAssets
```
```bash
# macOS / Linux
./deploy/claude/install-claude-assets.sh
# ...or:  ./deploy/bootstrap.sh --claude-assets
```

The installer substitutes the `__NARUKAMI_REPO__` placeholder in those files with
**this clone's absolute path**, so the triggers point at the right folder on any
machine. Restart Claude Code (or `/reload`) afterward.

---

## What is intentionally **NOT** in this repo (and why)

This repo is **public**. The following are deliberately excluded — they are
secrets, personal history, or unrelated to NARUKAMI, and must never be published:

| Excluded | Where it lives | How you get it back on a new device |
| -------- | -------------- | ----------------------------------- |
| Claude login / OAuth tokens | `~/.claude/.credentials.json` | run `claude login` |
| Runner bearer token | `.runner-token` (gitignored) | auto-generated by `npm run token` |
| Local env files | `packages/*/.env` (gitignored) | copied from `.env.example` by bootstrap |
| Claude Code history, sessions, hook logs | `~/.claude/history.jsonl`, `sessions/`, … | not needed to run NARUKAMI |
| Unrelated Claude skills/hooks (SGEN, design systems, etc.) | `~/.claude/skills`, `~/.claude/hooks` | out of scope; project-specific IP |

Only the two NARUKAMI-specific Claude assets above are bundled. Everything else
that "makes it run" is regenerated locally (token, env, DB) or re-authenticated
(`claude login`) — no secret ever leaves a machine.

---

## Security model (unchanged on any device)

- HTTP + WebSocket bind to **`127.0.0.1` only**.
- Every request needs `Authorization: Bearer <token>`; the WS upgrade needs
  `?token=…` and a validated `Origin`/`Host`.
- The token is 32 random bytes in `.runner-token` (gitignored, never logged).
- CORS allows only the local Vite origin.

---

## Troubleshooting

- **`prisma migrate` fails** — ensure `packages/backend/.env` exists (bootstrap
  creates it). It only needs `DATABASE_URL="file:./dev.db"`.
- **`claude` not found** — Analyze/Diagnose return a clear error but the server
  keeps running. Install Claude Code and `claude login`.
- **`node-pty` build error** — install the platform's C++ build tools, delete
  `node_modules`, re-run bootstrap.
- **Desktop installer is unsigned** — SmartScreen shows "unknown publisher" →
  *More info → Run anyway*. (It's a local build, not code-signed.)
- **Port already in use** — something is already on 4000/5173; stop it or let the
  `/narukami` command detect and report the running instance.
