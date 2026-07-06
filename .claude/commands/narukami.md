---
description: Launch the NARUKAMI local project runner (Postgres + backend + frontend)
---
Launch the NARUKAMI app. Repo root: `C:\Users\Stephanie Piape\Documents\NARUKAMI`.

Steps:
1. If a process is already listening on port 4000 or 5173, do NOT start a duplicate — just report that NARUKAMI is already running and give the URL + token.
2. Ensure Postgres is up: `docker compose up -d` and wait until container `narukami-db-1` reports health `healthy`.
3. From the repo root, start everything in the background: `npm run dev` (this runs `npm run token` then launches backend on 127.0.0.1:4000 and the Vite frontend on localhost:5173 via concurrently).
4. Poll until both port 4000 and port 5173 have a listener (backend + frontend ready).
5. Report:
   - URL: http://localhost:5173
   - Bearer token: read it from `<root>\.runner-token` (already wired into `packages/frontend/.env` as `VITE_RUNNER_TOKEN`).
6. Only open the browser if the user asks.

Notes:
- Bound to 127.0.0.1 + bearer token by design (local RCE tool) — never expose to a network.
- On Windows the app runs project commands via `powershell.exe`; on POSIX via `$SHELL -lc`.
- If the `claude` CLI is missing/logged out, Analyze returns a clear error (server keeps running).
