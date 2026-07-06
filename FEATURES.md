# NARUKAMI — Feature Reference

A local, single-user web app for **registering software projects and running each one in its own live, in-browser terminal** — with a built-in code editor, AI-assisted run-command detection, per-project end-of-day logs, and (new) Claude-to-Claude terminal orchestration.

It is an intentional local RCE tool: it spawns real processes on your machine. It is therefore bound to loopback only and gated by a bearer token by design.

---

## 1. What it is

- **Register** any project by absolute path.
- **Analyze** it with `claude -p` to auto-detect how to install/run it (dev/build/test commands).
- **Run** those commands — or an interactive shell, or an interactive Claude Code session — each in its own live terminal tab (real PTY streamed to the browser).
- **Edit** files in a built-in Monaco editor with a bounded, safe file tree.
- **Review** what happened per project per day (End-of-Day view, optional AI narrative).
- **Orchestrate**: a Claude session running inside NARUKAMI can read and drive the *other* terminals via MCP tools.

---

## 2. Architecture

npm-workspaces monorepo, three packages:

| Package | Stack | Role |
|---|---|---|
| `packages/backend` | Fastify + node-pty + `ws` + Prisma (**SQLite**) | HTTP API, WebSocket terminal streams, process manager, `claude -p` calls |
| `packages/frontend` | React + Vite + xterm.js + Monaco | SPA: sidebar, project panel, terminal tabs, editor, EOD view, toasts |
| `packages/desktop` | Electron | Native shell; serves the SPA same-origin from the backend with the token injected |

- **DB:** embedded SQLite via Prisma (`schema.prisma` provider = `sqlite`). No Docker.
- **Bind:** `127.0.0.1` only. Dev backend on `:4000`, Vite dev server on `:5173`. Desktop app binds a **random loopback port**.
- **Run modes:**
  - `npm run dev` — web (backend on 4000 + Vite on 5173)
  - `npm run desktop` — native Electron
  - `npm run desktop:dist` — build `packages/desktop/release/NARUKAMI-Setup-*.exe`

---

## 3. Security model

- **Loopback only.** Server binds `127.0.0.1`; must never be reachable from another machine.
- **Bearer token.** Every `/api/*` route is gated by a 64-char hex token (`.runner-token`, `mode 0600`). Constant-time comparison. Token is never logged (Fastify redacts `authorization`).
- **WebSocket auth.** Terminal sockets (`/ws/runs/:id`) require: allowed loopback **Origin** + allowed loopback **Host** + a valid **token** query param. Blocks a malicious web page from opening your terminal socket.
- **CORS.** Only loopback origins accepted (any port — the desktop app uses a random one).
- **File-editor sandbox.** All file reads/writes are confined to the project root: lexical `..`/absolute-escape blocking **plus** `realpath` symlink-escape checks on both the target and its parent. Symlinks are skipped entirely when building the tree.
- **Orchestration guardrails** (see §4.13): token-gated, no send-to-self, per-target rate limit, size cap. Kill switch: `NARUKAMI_ORCHESTRATION=0`.

---

## 4. Features

### 4.1 Project registry
- `POST /api/projects` with a path. Validates existence + directory-ness.
- **Path canonicalization**: the path is resolved with `fs.realpathSync.native` before the uniqueness check, so 8.3 short names (`STEPHA~1`), symlinks, and case differences that point at the **same physical directory** can't register twice.
- Duplicate → `409`. Project name defaults to the directory basename.
- `DELETE /api/projects/:id` cascades to its commands, runs, logs, analyses, and EOD entries.

### 4.2 AI project analysis (`claude -p`)
- `POST /api/projects/:id/analyze` runs `claude -p <prompt> --output-format json` in the project dir and persists the detected project type, package manager, and run commands.
- **Atomic replacement**: analysis + command-set swap happen in one Prisma `$transaction`; a failure leaves the previous command set intact. User-added custom commands are preserved (only `source:'detected'` rows are replaced).
- **Per-project serialization**: an in-memory lock (`analyzing` set) prevents two overlapping analyses from interleaving the delete/create; concurrent request → `409`.
- **Robust output parsing**:
  - Unwraps the `--output-format json` envelope (`.result`).
  - Strips ``` ```json ``` ``` fences.
  - `extractJsonObject` scans balanced `{...}` groups and **JSON.parse-checks each one**, skipping non-JSON noise (e.g. `{build, test}` prose, or braces injected by a hook) until it finds the real object.
  - Normalizes: coerces `"null"`/empty install command to `null`, forces exactly one default command, drops command entries with no runnable string.
- **Timeout**: hard 120 s ceiling with `SIGKILL`. Without it, a blocking hook or an unanswerable permission/folder-trust gate in the target project would hang the request forever and never release the analyze lock. The timeout error names the likely cause (hook / trust gate) and how to clear it.

### 4.3 Run commands
- **Detected** commands come from analyze (`source:'detected'`).
- **Custom** commands: `POST /api/projects/:id/commands` (label + command + optional cwd + isDefault). At most one default per project (enforced in a transaction).
- **AI-suggested** commands: `POST /api/projects/:id/commands/suggest` — describe what you want in natural language; `claude -p` returns a single `{label, command}` for that project.
- `DELETE /api/commands/:commandId` removes either kind.

### 4.4 Live terminals (the core)
Three kinds of run, each a real PTY streamed to xterm.js over WebSocket:
- **command** — `POST /api/projects/:id/run` with a `commandId`.
- **shell** — `POST /api/projects/:id/shell`, a bare interactive shell rooted at the project dir.
- **claude** — `POST /api/projects/:id/claude`, an interactive Claude Code session.

PTY details:
- Windows uses `powershell.exe` (ConPTY-compatible) for commands/shell; POSIX uses `$SHELL -lc` / `-i`.
- node-pty spawns don't PATH-resolve bare names on Windows, so `claude` is resolved to a full `…\claude.exe` via PATH + PATHEXT before spawn.

### 4.5 Interactive terminals over WebSocket
- Connect to `/ws/runs/:runId?token=…`.
- **Gap-free attach**: `attach()` atomically snapshots the full in-memory transcript **and** subscribes to future output in one synchronous step — no byte is dropped or duplicated between "history" and "live".
- Client → server messages: `{type:'input', data}` (keystrokes) and `{type:'resize', cols, rows}`.
- Server → client messages: `{type:'data', chunk}`, `{type:'exit', status, exitCode}`, `{type:'error', message}`.
- **Reconnect to a finished run**: replays persisted logs from the DB, then reports the final status (preferring the in-memory final state if the exit DB-write is still in flight).

### 4.6 Stop / close / rename
- `POST /api/runs/:runId/stop` — kill the PTY (marked killed-by-user).
- `POST /api/runs/:runId/close` — stop the PTY and drop the tab from the dock (history kept).
- `POST /api/runs/:runId/name` — persist a custom tab label (≤80 chars, blank clears).

### 4.7 Restart & Continue
- `POST /api/runs/:runId/restart` — spawn a **fresh** process of the same kind with clean logs and a new runId, carrying over the custom name; closes the old row.
- **Claude "Continue"**: `continue:true` on `/claude` or `/restart` launches `claude --continue`, reopening the most recent conversation in that directory, and skips the `/effort` injection so the restored session is untouched.
- Non-resume Claude launches inject an initial slash command (default `/effort ultracode`) — but **only after** the TUI settles and **never** while a folder-trust prompt is showing (the trust gate is detected and never auto-answered).

### 4.8 Log persistence & replay
- Live output is streamed immediately and buffered, flushed to `RunLog` every ~300 ms.
- An in-memory rolling transcript (capped at ~2 MB) backs gap-free reconnects; the DB keeps the full history for post-mortem.
- On boot, runs the DB still marks `running` (dead PTYs from a previous process) are reconciled to `exited` and remain restorable.

### 4.9 Built-in code editor (Monaco)
- `GET /api/projects/:id/tree` — bounded, ignore-filtered file tree (skips `node_modules`, `.git`, `dist`, `venv`, caches, etc.; caps at 4000 entries / depth 12; reports `truncated`).
- `GET /api/projects/:id/file?path=…` — read a file (≤1 MiB; binary sniff rejects files with NUL in the first 8 KB).
- `POST /api/projects/:id/file` — create-or-overwrite (≤5 MiB) inside the project root, with the symlink/escape guards described in §3.

### 4.10 Diagnose a failed run
- `POST /api/runs/:runId/diagnose` — feed a failed run's captured output (tail) to `claude -p`, get a plain-text explanation + fix steps.

### 4.11 End-of-Day (EOD) view
- Third main view alongside Runner and Editor.
- `POST /api/projects/:id/eod/compile` — snapshot every run that **finished today** (status exited/killed/error) into one `EodEntry` per project per day (`@@unique([projectId, day])`), with an optional free-text note.
- `POST /api/eod/:eodId/note` — edit an entry's note without recompiling.
- `POST /api/eod/:eodId/summarize` — generate an AI narrative (`claude -p`) of the day from the run items + note.
- `GET /api/projects/:id/eod` — list entries, newest day first.
- `DELETE /api/eod/:eodId`.
- **Retention**: keep the newest 10 days **per project**; older entries pruned on each compile.

### 4.12 Finish notifications
- When a session-started shell/claude run ends, an in-app toast (bottom-right; click routes to that run's project+tab) plus a best-effort **native OS notification** when the window is backgrounded.
- Gating (`lib/notify.ts`): session-scoped, deduped, terminal-only, shell/claude-only.

### 4.13 Claude ↔ Claude terminal orchestration (new)
Lets a Claude session **running inside NARUKAMI** read and drive the *other* live terminals.

**How:** each NARUKAMI-launched `claude` session is handed an MCP bridge (`packages/backend/mcp-bridge.mjs`, a hand-rolled stdio JSON-RPC MCP server) via a generated per-run `--mcp-config`. The bridge exposes three tools that call back into token-gated REST endpoints:

| MCP tool | REST endpoint | Effect |
|---|---|---|
| `list_terminals` | `GET /api/terminals` | List every live terminal (id, project, kind, label) across all projects; marks which one is *you*. |
| `read_terminal(terminal_id, lines?)` | `GET /api/terminals/:id/read` | Read another terminal's recent output (ANSI-stripped, last N lines; live transcript or persisted history). |
| `send_terminal(terminal_id, text, submit?)` | `POST /api/terminals/:id/send` | Type into another terminal's stdin; `submit` (default true) presses Enter. |

**Wiring:** `services/serverInfo.ts` captures the bound base URL after `app.listen`; `services/mcpConfig.ts` writes the per-run config (`command` = this process's own binary + `ELECTRON_RUN_AS_NODE=1`, env carries base URL / token / self-run-id) and returns the `--mcp-config` args; `startClaude` appends them. The config is **not** strict — the user's own MCP servers still load alongside.

**Security scope: any live terminal, any project** — gated only by loopback + bearer token. Guardrails:
- **No send-to-self** (blocks the trivial feedback loop), enforced both in the bridge and server-side.
- **Rate limit**: 20 sends / 5 s per target terminal (429 over the limit).
- **Size cap**: 10 000 chars per send.
- **Liveness**: send to a non-live terminal → 409.
- **Kill switch**: env `NARUKAMI_ORCHESTRATION=0` launches Claude sessions without the tools.

**Desktop packaging**: the bridge ships as an `extraResource` (`resources/mcp-bridge.mjs`, outside asar, since the `claude` CLI spawns it as its own process).

**Usage**: open a Claude tab plus another tab, then tell the Claude e.g. *"list_terminals, then send `npm test` to the shell tab and read the result."* First use shows a one-time "approve MCP server?" prompt in the orchestrator tab.

### 4.14 Workspace persistence
- `GET /api/workspace` — restore all open terminal tabs (with live/exited status) + persisted UI settings.
- `POST /api/settings` — bulk-upsert UI state (dock size, selected project, active view, last-open editor file, …) as one row per key.

---

## 5. API surface

All under `/api`, bearer-token gated.

**Projects**
- `GET /api/projects`
- `POST /api/projects`
- `DELETE /api/projects/:id`
- `POST /api/projects/:id/analyze`

**Commands**
- `POST /api/projects/:id/commands`
- `POST /api/projects/:id/commands/suggest`
- `DELETE /api/commands/:commandId`

**Runs / terminals**
- `POST /api/projects/:id/run`
- `POST /api/projects/:id/shell`
- `POST /api/projects/:id/claude`
- `POST /api/runs/:runId/stop`
- `POST /api/runs/:runId/close`
- `POST /api/runs/:runId/name`
- `POST /api/runs/:runId/restart`
- `GET  /api/runs/:runId`
- `POST /api/runs/:runId/diagnose`

**Orchestration**
- `GET  /api/terminals`
- `GET  /api/terminals/:id/read`
- `POST /api/terminals/:id/send`

**Files**
- `GET  /api/projects/:id/tree`
- `GET  /api/projects/:id/file`
- `POST /api/projects/:id/file`

**End-of-Day**
- `GET    /api/projects/:id/eod`
- `POST   /api/projects/:id/eod/compile`
- `POST   /api/eod/:eodId/note`
- `POST   /api/eod/:eodId/summarize`
- `DELETE /api/eod/:eodId`

**Workspace**
- `GET  /api/workspace`
- `POST /api/settings`

**WebSocket**
- `GET /ws/runs/:runId?token=…` — live terminal stream (see §4.5).

---

## 6. Data model (Prisma / SQLite)

- **Project** — `id, name, path (unique), type?, packageMgr?, status, createdAt, updatedAt`.
- **RunCommand** — `id, projectId, label, command, cwd?, isDefault, source(detected|custom)`.
- **Run** — `id, projectId, commandId?, kind(shell|claude|command), name?, dockOpen, pid?, status(running|exited|killed|error), exitCode?, startedAt, endedAt?`.
- **RunLog** — `id, runId, chunk, ts` (append-only output history).
- **AppSetting** — `key, value(JSON string), updatedAt` (UI state).
- **Analysis** — `id, projectId, rawResult(JSON), createdAt` (audit of each `claude -p` analyze).
- **EodEntry** — `id, projectId, day, items(JSON), note?, summary?` — unique `[projectId, day]`.

---

## 7. Configuration / environment

| Var | Purpose |
|---|---|
| `PORT` | Backend port (default 4000; desktop overrides with a random port) |
| `DATABASE_URL` | SQLite file URL |
| `RUNNER_TOKEN_FILE` | Where the bearer token is stored (default `<repo>/.runner-token`) |
| `NARUKAMI_EMBEDDED` | `1` in the Electron shell; makes `index.ts` skip standalone `main()` and let Electron call `start()` |
| `NARUKAMI_ORCHESTRATION` | `0` disables the Claude↔Claude MCP bridge |

**Dev-launch note (this machine):** the interactive shell profile bakes in `NARUKAMI_EMBEDDED=1` and a mismatched `RUNNER_TOKEN_FILE`, which silently break `npm run dev` (backend never binds 4000 → 401s). Launch with both unset: `env -u NARUKAMI_EMBEDDED -u RUNNER_TOKEN_FILE npm run dev`.

---

## 8. Windows / packaging notes

- **node-pty 1.1.0** installs from its prebuild on Node 22 / win32-x64 — no Visual Studio Build Tools required.
- **Empty-body POSTs** (`/stop`, `/analyze`) send `Content-Type: application/json` with no body; a custom content-type parser maps empty → `undefined` so Fastify doesn't 400.
- **Electron + Prisma**: electron-builder strips `node_modules/.prisma`, so the client is generated to a non-dot path (`backend/src/generated/prisma`) and the native engine + node-pty are `asarUnpack`'d.
- **Same-origin desktop**: the packaged app serves the SPA from the backend with the token injected into `index.html`; only `/api` is token-gated; loopback origins allowed in CORS + WS.
- **MCP bridge** must stay **outside asar** (shipped as an `extraResource`) because the `claude` CLI launches it as a separate process.
- Installer is unsigned → SmartScreen "unknown publisher".

---

## 9. Build & test

```bash
# dev (web)
env -u NARUKAMI_EMBEDDED -u RUNNER_TOKEN_FILE npm run dev

# native
npm run desktop

# packaged installer
npm run desktop:dist   # -> packages/desktop/release/NARUKAMI-Setup-*.exe

# backend checks
cd packages/backend && npx tsc --noEmit && npx vitest run
```

Backend test suite covers auth (token/origin/host), the analyzer's parsing helpers (fence-strip, parse-aware JSON extraction, normalization, envelope unwrap), the runner (transcript cap, shell selection, tail-lines), the WS message handling, EOD date/item logic, and the orchestration route guards + rate limiter.
