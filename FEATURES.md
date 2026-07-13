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
- Non-resume Claude launches inject an initial slash command (default `/effort ultracode` — note its parallel subagent fan-out is the dominant CPU cost of a busy Claude tab, all grouped under NARUKAMI's process tree in Task Manager) — but **only after** the TUI settles and **never** while a folder-trust prompt is showing (the trust gate is detected and never auto-answered).

### 4.8 Log persistence & replay
- Live output is streamed immediately and buffered, flushed to `RunLog` every ~300 ms.
- An in-memory rolling transcript (capped at ~2 MB) backs gap-free reconnects; the DB keeps the full history for post-mortem.
- On boot, runs the DB still marks `running` (dead PTYs from a previous process) are reconciled to `exited` and remain restorable.

### 4.9 Built-in code editor (Monaco)
- `GET /api/projects/:id/tree` — bounded, ignore-filtered file tree (skips `node_modules`, `.git`, `dist`, `venv`, caches, etc.; caps at 4000 entries / depth 12; reports `truncated`).
- `GET /api/projects/:id/file?path=…` — read a file (≤1 MiB; binary sniff rejects files with NUL in the first 8 KB).
- `POST /api/projects/:id/file` — create-or-overwrite (≤5 MiB) inside the project root, with the symlink/escape guards described in §3.
- **Search** — the tree sidebar has a **Name / Code** toggle + search box:
  - *Name* filters the file tree client-side by path (quick-open); click a result to open it.
  - *Code* calls `GET /api/projects/:id/search?q=…` (debounced), a case-insensitive content grep across the project. Bounded for safety: ignore-dirs, per-file ≤512 KB, binaries skipped, ≤500 total matches (`truncated` flagged). Each hit shows file · line · text; clicking opens the file and **reveals + focuses the matched line** in Monaco.

### 4.10 Diagnose a failed run
- `POST /api/runs/:runId/diagnose` — feed a failed run's captured output (tail) to `claude -p`, get a plain-text explanation + fix steps.

### 4.11 End-of-Day (EOD) view
- Third main view alongside Runner and Editor.
- **Features added (git commits)** — each EOD entry leads with a detailed list of the day's git commits for the project: subject, full body/details, short hash, and files-changed count. Recomputed from git **on read** (`services/gitLog.ts`; `gitCommitsForDay` filters `git log` by the local day) so nothing extra is stored and history stays accurate — no schema change (safe for already-installed DBs). Bounded (≤200 commits, ≤4 KB body, 10 s git timeout); returns `[]` if the project isn't a git repo. The AI day summary now leads with these commits too.
- `POST /api/projects/:id/eod/compile` — snapshot every run that **finished today** (status exited/killed/error) into one `EodEntry` per project per day (`@@unique([projectId, day])`), with an optional free-text note.
- `POST /api/eod/:eodId/note` — edit an entry's note without recompiling.
- `POST /api/eod/:eodId/summarize` — generate an AI narrative (`claude -p`) of the day from the run items + note.
- `GET /api/projects/:id/eod` — list entries, newest day first.
- `DELETE /api/eod/:eodId`.
- **Retention**: keep the newest 10 days **per project**; older entries pruned on each compile.

### 4.12 Finish notifications
- **Finish toast** — when a session-started shell/claude run ends, an in-app toast (bottom-right; click routes to that run's project+tab) plus a best-effort **native OS notification** when the window is backgrounded. Gating (`lib/notify.ts`): session-scoped, deduped, terminal-only, shell/claude-only.
- **Task-done toast** — a Claude session that finishes responding and goes idle raises a "task done" toast. To avoid false fires it is armed only on a **submit** (Enter), waits out a **5 s** idle window (spans mid-response pauses), and is scoped to **Claude tabs only** (shell/command output pauses are indistinguishable from "done" on a timer and are covered instead by the finish-on-exit toast).

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

### 4.14 Elevated (Administrator) shells — broker (Windows)
A **"🛡 Shell (Admin)"** button opens a real elevated PowerShell **streamed in-app**, without elevating the rest of NARUKAMI.

**Why it needs a broker:** node-pty's ConPTY is owned by the backend at Medium integrity; a Medium process cannot attach a console to a High-integrity (elevated) child. But a loopback socket crosses integrity levels. So:

1. `POST /api/projects/:id/shell` with `{admin:true}` creates the Run and calls `startAdminShell` (`services/brokerServer.ts`).
2. The backend mints a one-time token, writes a `0600` config to temp, and launches `broker-agent.mjs` **elevated** via `Start-Process -Verb RunAs` (the UAC prompt). The token travels in the temp file, not argv.
3. The elevated agent (High integrity) spawns an elevated PowerShell PTY and connects back to the backend's loopback listener, authenticating with the token (consumed once; expires after 90 s).
4. The backend wraps that socket as a `RunTransport` and `registerRun`s it — from here it streams to xterm exactly like a local run (`runner.ts` is transport-agnostic: local PTY or broker socket).

**Frontend UX:** the tab shows *"⏳ Waiting for Administrator elevation — approve the UAC prompt…"* and polls `GET /api/runs/:id` until `live:true`, then opens the WebSocket. If UAC is cancelled or times out, the run is marked errored with an explanatory line. Elevated tabs carry a 🛡 badge.

**Wire protocol** (agent ↔ backend, newline-delimited JSON, terminal bytes base64): `hello{token,runId,pid}` → `data` / `exit`; backend → `input` / `resize` / `kill`.

**Security:** listener binds 127.0.0.1; only a connection presenting the pending run's one-time token is accepted; token is a 32-byte secret in a `0600` file, consumed on first use, expired on timeout. Elevation is per-tab — the backend and all other runs stay non-elevated. Env `NARUKAMI_BROKER_NO_ELEVATE=1` runs the agent **without** UAC (plumbing tests only; the shell is then not actually elevated). Packaged via `extraResource` (`resources/broker-agent.mjs`, outside asar — it's spawned as its own process).

**Limitation:** Restarting an admin tab spawns a plain (non-elevated) shell — elevation isn't persisted across restart in v1.

### 4.15 Workspace persistence
- `GET /api/workspace` — restore all open terminal tabs (with live/exited status) + persisted UI settings.
- `POST /api/settings` — bulk-upsert UI state (dock size, selected project, active view, last-open editor file, …) as one row per key.

### 4.16 Mobile share via QR (same-LAN)
A **"⚌ Share"** button on any live terminal turns it into a QR code your phone scans to open that terminal in a mobile browser — both devices on the same network. The master token never leaves the machine.

**How it works:**
1. `POST /api/runs/:runId/share {canInput?, ttlMs?}` mints a **per-terminal share token** (scoped to exactly that runId, TTL default 4h, clamped 1min–24h) and starts an **on-demand LAN relay** — a raw `net` TCP proxy bound to the machine's LAN IP that pipes to the loopback backend (HTTP + WS pass through untouched). Returns the QR URL `http://<lan-ip>:<relay-port>/?m=<token>&run=<runId>`.
2. The phone loads that URL. The backend serves the SPA **without** the master token (injected only for loopback Hosts — `isLoopbackHost` in `auth.ts`); the mobile view (`MobileTerminal.tsx`, routed on `?m=` in `main.tsx`) authenticates with the scoped share token instead.
3. The phone opens `ws /ws/runs/:runId?token=<shareToken>`; `ws.ts` accepts the master token OR a share token scoped to that runId, and drops input for a read-only (`canInput:false`) share.

**Security model** (all verified end-to-end through a real relay):
- **LAN reachability is opt-in + refcounted.** The relay runs only while a share is active; the last revoke/expiry stops it (`mobileShare.reconcileRelay`), which also revokes shares whose run has ended. `stopRelay` force-drops live sockets (hard kill).
- **The master token is never handed to the LAN** — a phone gets a tokenless page; only loopback gets the injected token.
- **Host/Origin guards accept the LAN IP ONLY while sharing** (`auth.ts`, gated on `activeLanAddress()`), and only the exact bound IP — a DNS-rebinding page sends its domain, not the raw IP, so it stays rejected. CORS uses the same `isAllowedOrigin` (Vite marks assets `crossorigin`, so the browser sends an Origin header even same-origin).
- **Share tokens are scoped** — a token for run A can't open run B; `/api/mobile/*` is the only LAN-reachable API surface (every other `/api` route stays master-gated).
- **Read-only mode** (`canInput:false`) drops all input server-side (a mirror can watch but not type).
- **Secrets are masked in logs** — the token rides in the URL query, so the request-log serializer masks `m=`/`token=`.

**Mobile UX** (`MobileTerminal.tsx`): full-screen xterm sized with `100dvh` + safe-area insets, a touch key bar for the keys a soft keyboard lacks (Esc / Tab / Ctrl-C / arrows), auto-reconnect on screen-lock (reuses `nextReconnectAction`), and a "view-only" badge for read-only shares. Requires the backend to serve the SPA (desktop app / built frontend) — the relay forwards the phone to it.

**Limitation:** `detectLanIp()` picks the first private IPv4; on a machine with VPN / VirtualBox / WSL adapters it may choose a non-reachable interface. Plain HTTP on the LAN (no TLS) — the scoped, short-TTL, revocable token bounds the exposure.

### 4.17 Idle/hidden efficiency
NARUKAMI's own runtime stays ~1% CPU even while a Claude tab streams (the visible load in Task Manager is the Claude workload itself plus everything terminals spawn, all grouped under NARUKAMI.exe). The app-side waste that DID exist is engineered out:

- **Real visibility signal**: the shell needs `backgroundThrottling:false` (live terminals must never stall), but that pins the Page Visibility API to `visible`. The Electron main now forwards true minimize/restore over IPC (`narukami:visibility`); `lib/visibility.ts` fans it out (with a `visibilitychange` fallback in plain browsers).
- **Polls pause while hidden** (and refresh instantly on restore): header vitals (5s), editor git status/diff (3s, spawns git), editor branch (3.5s, spawns git), Code Map changes (2.5s, spawns git), GODCLAUDE status/memory-graph (5s/30s, can spawn Electron-as-node). CSS pulse animations pause via a `win-hidden` root class; xterm cursor blink stops.
- **Graph loops park**: GraphGlobe got GraphFlat's idle-stop (full rate only while settling/interacting, ~12fps when only the glow pulses, 0 when static), and both park entirely while the window is hidden.
- **Fewer git spawns**: repo-prefix / repo-ness / tracked-ness are TTL-cached (15s) in `gitStatus.ts`, cutting the editor's steady-state poll from ~5 spawns per tick to 2.
- **Preview CDP capture is lifecycle-scoped**: the Browser view's debugger enables Runtime/Network only while a preview is watched (+ a grace window preserving the unwatch→rewatch replay race) and buffers only replayable methods — previously every terminal WS frame was serialized cross-process forever after the first Browser-view open.
- **Monaco is code-split**: the entry chunk dropped ~3.9MB → ~0.7MB; pop-out terminal windows and the phone share page never parse the editor bundle.
- **Fan-out serializes once**: one pty batch is JSON.stringify'd once no matter how many sockets mirror the terminal; the orchestration read endpoint joins only the tail window it returns instead of the full ≤2MB transcript.

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
- `GET  /api/projects/:id/search`

**End-of-Day**
- `GET    /api/projects/:id/eod` (each entry includes the day's git `commits`)
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
| `NARUKAMI_BROKER_NO_ELEVATE` | `1` runs the admin-shell broker agent WITHOUT UAC (plumbing tests only — the shell is then not actually elevated) |

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
