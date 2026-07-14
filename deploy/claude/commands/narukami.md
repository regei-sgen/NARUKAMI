---
description: Launch the NARUKAMI local project runner (Ace-compatible prod serve on 127.0.0.1:4000)
---
Launch NARUKAMI in its default (production, Ace-compatible) mode: the compiled
backend serves the built SPA + API same-origin on **127.0.0.1:4000**. This is
the mode the Ace OS stack embeds — ace-desktop adopts the listener and the OS
dashboard's WORKSTATION face iframes it. Repo root: the directory this repo is
cloned into.

The database is **embedded SQLite** (a local file — no Docker, no Postgres).

Steps:
1. If a process is already listening on port 4000, do NOT start a duplicate —
   just report that NARUKAMI (or another workstation) is already running there
   and give the URL + token.
2. First run only: ensure the local env + DB exist:
   - `packages/backend/.env` (copy from `packages/backend/.env.example` if missing)
   - run `npm run migrate` once to create the SQLite schema (`prisma/dev.db`).
3. Ensure the build is present and current: if `packages/backend/dist/index.js`
   or `packages/frontend/dist/index.html` is missing (or the user asked for a
   rebuild), run `npm run build` from the repo root.
4. From the repo root, start in the background: `npm start` (runs
   `scripts/start-prod.js` — sets `NARUKAMI_EMBEDDED=1`,
   `NARUKAMI_ACE_FINGERPRINT=1`, an absolute `DATABASE_URL`, then boots the
   backend on 127.0.0.1:4000 serving the built SPA).
5. Poll until port 4000 has a listener.
6. Report:
   - URL: http://127.0.0.1:4000
   - Bearer token: read it from `<root>/.runner-token` (the served page has it
     self-injected as `window.__NARUKAMI__` for loopback requesters).
7. Only open the browser if the user asks.

Notes:
- Bound to 127.0.0.1 + bearer token by design (local RCE tool) — never expose to
  a network.
- Ace OS embedding: boot NARUKAMI BEFORE launching Ace OS so ace-desktop finds
  and ADOPTS the :4000 listener (the served page carries the
  `window.__WORKSTATION__` fingerprint its identify() checks). The dashboard's
  WORKSTATION face then shows NARUKAMI.
- Dev mode (`npm run dev`, Vite on localhost:5173 + tsx backend on :4000) is for
  hacking on NARUKAMI itself only — it can't run at the same time as the prod
  instance (same port 4000) and is not Ace-adoptable.
- On Windows the app runs project commands via `powershell.exe`; on POSIX via
  `$SHELL -lc`.
- If the `claude` CLI is missing/logged out, Analyze returns a clear error (the
  server keeps running).
