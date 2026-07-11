---
description: Launch the NARUKAMI local project runner (SQLite + backend + frontend)
---
Launch the NARUKAMI dev app. Repo root: `__NARUKAMI_REPO__`.

The database is **embedded SQLite** (a local file — no Docker, no Postgres).

Steps:
1. If a process is already listening on port 4000 or 5173, do NOT start a
   duplicate — just report that NARUKAMI is already running and give the URL +
   token.
2. First run only: ensure the local env + DB exist:
   - `packages/backend/.env` (copy from `packages/backend/.env.example` if missing)
   - run `npm run migrate` once to create the SQLite schema (`prisma/dev.db`).
   (Running `deploy/bootstrap.ps1` / `deploy/bootstrap.sh` does all of this.)
3. From the repo root, start everything in the background: `npm run dev` (this
   runs `npm run token` first, then launches the backend on 127.0.0.1:4000 and
   the Vite frontend on localhost:5173 via `concurrently`).
4. Poll until both port 4000 and port 5173 have a listener (backend + frontend
   ready).
5. Report:
   - URL: http://localhost:5173
   - Bearer token: read it from `<root>/.runner-token` (already wired into
     `packages/frontend/.env` as `VITE_RUNNER_TOKEN`).
6. Only open the browser if the user asks.

Notes:
- Bound to 127.0.0.1 + bearer token by design (local RCE tool) — never expose to
  a network.
- On Windows the app runs project commands via `powershell.exe`; on POSIX via
  `$SHELL -lc`.
- If the `claude` CLI is missing/logged out, Analyze returns a clear error (the
  server keeps running).
