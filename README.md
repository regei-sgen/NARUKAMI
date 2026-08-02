# ⚡ NARUKAMI — Local Project Runner (Desktop App)

Register software projects by file path, let **Claude Code** analyze how each one
runs, and run each command in its **own live terminal in the browser** — real
output, colors, prompts, Ctrl-C, and interactive input, streamed over a
WebSocket into [xterm.js](https://xtermjs.org/).

> **NARUKAMI is a cross-platform desktop application** (Electron). Run it as a
> native desktop window with **`npm run desktop`**, or package a self-contained
> **desktop installer** with **`npm run desktop:dist`** (Windows `.exe`, with the
> SQLite database embedded — no Docker, no server). It also runs as a local web
> app with **`npm run dev`** → http://localhost:5173.

> **⚠ This app executes shell commands on your machine. Treat it like local
> remote-code-execution.** The app binds to `127.0.0.1` and every request /
> WebSocket upgrade requires a bearer token. Do not expose it to a network.
> (The one thing that *can* leave loopback is the opt-in, read-only PC-stats
> listener on `:4311` — a separate server that can only report sensor readings.
> See [Security model](#security-model).)

---

## Architecture — two separate execution paths

| Path | Tool | Lifetime | Used for |
| ---- | ---- | -------- | -------- |
| **Analyze / diagnose** | `claude -p … --output-format json` | short-lived (returns then exits) | detecting run commands, explaining failures |
| **Run** | `node-pty` pseudo-terminal | long-lived (until you stop it) | `npm run dev`, `python app.py`, … |

Claude Code is the **brain** (analyze). node-pty is the **hands** (run).
`claude -p` is never used to run a dev server — Claude Code kills background
processes seconds after it returns, so the server would die immediately.

## Tech stack

- **Monorepo:** npm workspaces — `packages/backend`, `packages/frontend`, `packages/desktop`
- **Backend:** Node + TypeScript, Fastify, `node-pty`, `ws`, Prisma
- **Frontend:** React + Vite + TypeScript, `@xterm/xterm` + `@xterm/addon-fit`, Monaco editor
- **DB:** SQLite (embedded, file-based — **no Docker**)
- **Desktop:** Electron (`packages/desktop`) → self-contained `.exe` with the DB inside
- **Mobile:** `packages/mobile` — a native Android PC-stats readout (Gradle, not an npm workspace)
- **AI:** the `claude` binary on your `PATH` (no npm SDK dependency)

---

## Prerequisites

- Node.js 18+ (tested on 22) and npm
- The **`claude`** CLI installed and logged in (`claude login`) — verify with `claude --version`
  (only needed for the Analyze / Claude-Code features)

---

## Setup & run

**Fastest path — one command** (installs deps, creates the local env, migrates
the SQLite DB, generates the token, and builds). See
[`deploy/DEPLOY.md`](deploy/DEPLOY.md) for the full portable/deploy guide,
including how to reproduce the Claude Code layer (`/narukami`, "Narukami God") on
any device.

```powershell
# Windows
powershell -ExecutionPolicy Bypass -File deploy\bootstrap.ps1
```
```bash
# macOS / Linux
./deploy/bootstrap.sh
```

Or do it by hand, from the repo root:

```bash
# 1. Install all workspaces
npm install

# 2. Create the SQLite database schema (no Docker — DB is a local file)
npm run migrate            # → prisma migrate dev --name init

# 3. Generate the auth token + wire it into the frontend
npm run token              # writes .runner-token and packages/frontend/.env

# 4. Start backend + frontend together
npm run dev
```

Then open **http://localhost:5173**.

### Desktop app (native `.exe`, DB inside, no Docker/npm)

```bash
npm run desktop            # launch the Electron app in dev
npm run desktop:dist       # build packages/desktop/release/NARUKAMI-Setup-*.exe
```

- The backend prints its bearer token on boot and listens on `127.0.0.1:4000`.
- `npm run dev` runs `npm run token` first, so the frontend always has a matching
  `VITE_RUNNER_TOKEN`.

### PC Stats — on the desktop, and on your phone

A live readout of the machine itself: CPU load/clock, memory, GPU (load, VRAM,
temperature, power, fan via `nvidia-smi`), the temperature sensors the box
actually exposes, plus uptime / disk / battery. Readings are nullable by design —
where a sensor doesn't exist you get `—` and the reason, never a made-up number.
Probes are cached and spawned **on demand**, so a session that never opens the
readout never spawns one.

Open it from the header chip, from the tray, or as a pinnable detached window
(remembers where you parked it, as long as that display still exists).

**On your phone** — `packages/mobile` is a native Android app (no WebView),
landscape-first, with switchable design-system themes. It talks to a **separate,
read-only stats server on port 4311** — never the main backend:

```bash
# 1. Start the listener either way:  tray → "Phone server (Wi-Fi)"
#    (or POST /api/pcstats/lan/start)

# 2a. USB (default) — forward 4311; the app's default address already matches.
node packages/mobile/scripts/adb-reverse.mjs

# 2b. Wi-Fi — on the phone, ⋮ → Set server… with the address the tray shows.
```

Either way you paste the **token** from the tray (*Copy token*) into the app —
the stats server authenticates every request no matter how the bytes arrive, and
the token is regenerated on each restart.

Building it needs JDK 17+ and the Android SDK — copy
`packages/mobile/android/local.properties.example` → `local.properties`, point
`sdk.dir` at your SDK, then `gradle test assembleRelease` from
`packages/mobile/android`. See [`packages/mobile/android/README.md`](packages/mobile/android/README.md).

### Running the two apps separately

```bash
npm run token             # once, to create .runner-token + frontend/.env
npm run dev:backend       # http://127.0.0.1:4000  (prints the token)
npm run dev:frontend      # http://localhost:5173
```

---

## Using it

1. **Add a project** — paste an absolute path in the sidebar and click **Add**.
   Non-existent paths and files (non-directories) are rejected.
2. **Analyze** — click **Analyze**. This runs `claude -p` in the project dir,
   parses the JSON it returns, and fills in the run commands + type / package
   manager.
3. **Run** — click **Run** on a command. A live terminal tab opens; output
   streams in real time, your keystrokes reach the process, and it resizes with
   the window.
4. **Stop** — kills the process and records the exit code. Reopening a run
   replays its stored logs.

### The eight views

The tab bar above the main pane switches between them. Runner / Editor / Browser
/ EOD / Release are scoped to the selected project; GODCLAUDE / Arsenal /
Settings are global.

| View | What it is |
| ---- | ---------- |
| **Runner** | The live terminal dock — command, shell and Claude Code tabs. |
| **Editor** | Monaco over a bounded file tree, with git decorations, diff gutter marks and a stage/commit source-control panel. |
| **Browser** | Preview the project's (loopback) dev server at several device sizes at once. |
| **EOD** | Generate and read the day's cross-project AI report, built from Claude transcripts + NARUKAMI runs + git commits. |
| **Release** | Cut a versioned SGA release zip with AI patch notes, and browse the release history. |
| **GODCLAUDE** | Control plane for NARUKAMI's own embedded god home (arm / mode / autopilot) plus a read-only memory graph over the native `~/.claude`. |
| **Arsenal** | Read-only inventory of every skill, hook, memory pin, agent and command on the machine, global and per project. |
| **Settings** | AI provider (CLI login vs. API key), default `/effort`, notification prefs, About. |

Full detail for each: [`FEATURES.md`](FEATURES.md) §4.

---

## Security model

- HTTP and WebSocket servers bind to **`127.0.0.1` only** (never `0.0.0.0`).
- Every HTTP request needs `Authorization: Bearer <token>`; the WS upgrade needs
  `?token=…`.
- The token is 32 random bytes, generated on first boot, stored in
  `.runner-token` (gitignored), and **never logged**.
- CORS accepts **loopback origins only** — the Vite dev origins
  (`http://localhost:5173` / `http://127.0.0.1:5173`) plus any
  `127.0.0.1`/`localhost` port, because the packaged desktop app serves the SPA
  from the backend on a random port. The one widening: while a terminal is being
  shared to a phone, the relay's own LAN IP is accepted too — and only that exact
  IP, so a DNS-rebinding page (which sends its domain, not the raw IP) stays
  rejected.
- The WS upgrade also validates the `Origin` and `Host` headers and rejects
  anything that isn't our localhost origin — so another website open in your
  browser cannot connect to the terminal socket.

### The phone stats server (`:4311`) — the one thing not on loopback

The main backend **must never** be put on the Wi-Fi: it injects its bearer token
into the HTML it serves, so anything that can reach that port could lift the
token and drive `/api/runs`, which spawns shells. Rather than relax that, the
phone talks to a **separate listener** that is deliberately tiny:

- serves exactly `GET /api/pcstats` plus an unauthenticated `/health` liveness
  probe (no stats, no token, no hostname) — **everything else 404s**;
- has its **own** token, required on every request, compared in constant time,
  and regenerated on every restart;
- is **off unless you explicitly start it** (tray → *Phone server (Wi-Fi)*), and
  is read-only by construction — no terminals, no file access, no run APIs.

Worst case if that token leaks on your network: someone learns your CPU
temperature. That is the entire blast radius. If you only use USB
(`adb reverse`), the listener stays bound to loopback anyway.

---

## Platform notes

- **Windows:** run commands are executed with
  `powershell.exe -NoLogo -NoProfile -Command "<command>"` inside a ConPTY.
  On macOS/Linux the shell is `$SHELL -lc "<command>"`.
- **node-pty** ships prebuilt binaries; if a rebuild is triggered it needs the
  platform's native build tools (Visual Studio Build Tools on Windows, a C++
  toolchain elsewhere).
- If **`claude` isn't on your PATH**, the Analyze/Diagnose routes return a clear
  error (they don't crash the server). Install Claude Code and run `claude login`.
- If Analyze can't read your project's files, you can widen Claude Code's tool
  permissions in `packages/backend/src/services/analyzer.ts` (e.g. add
  `--allowedTools "Read Glob Grep LS"` to the `claude` invocation). Kept minimal
  in v1 by design.

---

## API reference

Enumerated from the route modules registered in
`packages/backend/src/index.ts`. **Every route below requires the bearer token**,
with one deliberate exception: `GET /api/mobile/run`, which the auth hook exempts
from master auth and which validates a per-terminal *share* token instead (see
[Mobile share](FEATURES.md#417-mobile-share-via-qr-same-lan)).

`FEATURES.md` §4 explains what each surface does; this table is the index.

### Projects & commands

| Method | Route | Body | Purpose |
| ------ | ----- | ---- | ------- |
| `GET` | `/api/projects` | — | list projects + commands + latest run |
| `POST` | `/api/projects` | `{ path }` | register a project |
| `DELETE` | `/api/projects/:id` | — | delete (cascades to commands/runs/logs/analyses/releases) |
| `POST` | `/api/projects/:id/analyze` | — | run the analyzer, persist detected commands |
| `POST` | `/api/projects/:id/commands` | `{ label, command, cwd?, isDefault? }` | add a custom run command |
| `POST` | `/api/projects/:id/commands/suggest` | `{ request }` | Claude Code turns a description into a command |
| `PATCH` | `/api/commands/:commandId` | `{ shell }` | change which Windows shell a command runs in |
| `DELETE` | `/api/commands/:commandId` | — | delete a run command (detected or custom) |

### Runs & terminals

| Method | Route | Body | Purpose |
| ------ | ----- | ---- | ------- |
| `POST` | `/api/projects/:id/run` | `{ commandId }` | spawn a run → `{ runId, pid }` |
| `POST` | `/api/projects/:id/shell` | `{ admin?, shell? }` | interactive shell in the project dir (`admin` → elevated via the UAC broker) |
| `POST` | `/api/projects/:id/claude` | `{ effort?, setEffort?, continue? }` | interactive Claude Code session |
| `POST` | `/api/runs/:runId/stop` | — | kill the process |
| `POST` | `/api/runs/:runId/close` | — | stop it and drop the tab from the dock (history kept) |
| `POST` | `/api/runs/:runId/name` | `{ name }` | persist a custom tab label |
| `POST` | `/api/runs/:runId/restart` | `{ continue? }` | fresh process of the same kind, new runId |
| `GET` | `/api/runs/:runId` | — | run details + stored logs |
| `POST` | `/api/runs/:runId/diagnose` | — | explain a failed run via `claude -p` |
| `GET` | `/api/terminals` | — | every live terminal across all projects (MCP orchestration) |
| `GET` | `/api/terminals/:id/read` | — | read another terminal's recent output |
| `POST` | `/api/terminals/:id/send` | `{ text, submit? }` | type into another terminal's stdin |
| `WS` | `/ws/runs/:runId?token=…` | — | live terminal I/O |

### Files, editor & git

| Method | Route | Body | Purpose |
| ------ | ----- | ---- | ------- |
| `GET` | `/api/projects/:id/tree` | — | bounded, ignore-filtered file tree |
| `GET` | `/api/projects/:id/dir` | — | one directory's children (lazy tree expansion) |
| `GET` | `/api/projects/:id/files?q=` | — | filename / path search |
| `GET` | `/api/projects/:id/search?q=` | — | bounded content grep |
| `GET` | `/api/projects/:id/file?path=` | — | read a file (≤1 MiB, binary-sniffed) |
| `POST` | `/api/projects/:id/file` | `{ path, content, baseMtimeMs? }` | create-or-overwrite inside the project root |
| `GET` | `/api/projects/:id/file-stat?path=` | — | mtime/size (stale-write detection) |
| `GET` | `/api/projects/:id/git/branch` | — | current branch |
| `GET` | `/api/projects/:id/git/status` | — | per-file add/modify/delete for tree decorations |
| `GET` | `/api/projects/:id/git/diff?path=` | — | changed line ranges (editor gutter marks) |
| `GET` | `/api/projects/:id/git/file-head?path=` | — | the file's content at HEAD |
| `GET` | `/api/projects/:id/git/changes` | — | full source-control snapshot |
| `POST` | `/api/projects/:id/git/stage` · `/unstage` · `/discard` | `{ path, untracked? }` | per-file staging actions |
| `POST` | `/api/projects/:id/git/stage-all` · `/unstage-all` | — | bulk staging |
| `POST` | `/api/projects/:id/git/commit` | `{ message }` | commit what is staged |

### End-of-Day reports

| Method | Route | Body | Purpose |
| ------ | ----- | ---- | ------- |
| `GET` | `/api/eod/active?from&to` | — | projects active in the range (Claude sessions + runs + commits) |
| `POST` | `/api/eod/report` | `{ from?, to?, day?, paths[], note? }` | generate + save the day's cross-project AI report |
| `GET` | `/api/eod/reports` | — | saved reports, newest first |
| `GET` | `/api/eod/reports/:id` | — | one report |
| `DELETE` | `/api/eod/reports/:id` | — | delete a report |

### Release (SGA)

| Method | Route | Body | Purpose |
| ------ | ----- | ---- | ------- |
| `GET` | `/api/projects/:id/release/preflight` | — | repo fingerprint, versions, working-tree dirt, history |
| `POST` | `/api/projects/:id/release` | `{ version, includeDirty? }` | bump version files → `git archive` zip |
| `POST` | `/api/projects/:id/release/commit` · `/push` | — | commit the bump / push the branch |
| `GET` | `/api/projects/:id/releases` | — | release history |
| `POST` | `/api/releases/:id/notes` | — | AI patch-note summary + description |
| `GET` | `/api/releases/:id/zip` | — | download the zip |
| `DELETE` | `/api/releases/:id` | — | delete a release row |
| `POST` | `/api/release/zip-dir` | `{ dir }` | set the permanent zip output folder |

### GODCLAUDE, Argus & Arsenal

| Method | Route | Body | Purpose |
| ------ | ----- | ---- | ------- |
| `GET` | `/api/godclaude/status` | — | embedded god home: install/armed/mode/autopilot, health, session fleet, usage |
| `POST` | `/api/godclaude/install` | — | provision / repair the embedded home from vendored assets |
| `POST` | `/api/godclaude/arm` | `{ on, sessionId? }` | arm globally or per session |
| `POST` | `/api/godclaude/mode` | `{ mode, sessionId? }` | set the god mode |
| `POST` | `/api/godclaude/autopilot` | `{ on }` | toggle autopilot |
| `GET` | `/api/godclaude/sessions/:sessionId/state` | — | one session's armed/mode state |
| `GET` | `/api/godclaude/logs?source&limit` | — | tail the god logs |
| `GET` | `/api/argus/memory-graph` | — | read-only memory-note graph over the native `~/.claude` |
| `GET` | `/api/argus/memory/note?project&slug` | — | one memory note |
| `GET` | `/api/argus/logs?source&limit` | — | tail a native-layer log source (read-only) |
| `GET` | `/api/armory` | — | inventory of skills / hooks / memory pins / agents / commands |

### Settings & workspace

| Method | Route | Body | Purpose |
| ------ | ----- | ---- | ------- |
| `GET` | `/api/settings/ai` | — | AI provider config (**API key never returned — masked preview only**) |
| `POST` | `/api/settings/ai` | `{ provider?, apiKey?, baseUrl?, defaultEffort? }` | choose `claude-code` (CLI login) or `api-key`; set the default `/effort` |
| `DELETE` | `/api/settings/ai/key` | — | forget the key and reset the provider to `claude-code` |
| `GET` | `/api/settings/about` | — | read-only diagnostics for the About block |
| `GET` | `/api/workspace` | — | open terminal tabs + persisted UI settings |
| `POST` | `/api/settings` | `{ …keys }` | generic key/value bulk-upsert (UI state) |
| `POST` | `/api/open-url` | `{ url }` | open a **loopback** dev-server URL in the system browser |

### Mobile share & machine stats

| Method | Route | Body | Purpose |
| ------ | ----- | ---- | ------- |
| `POST` | `/api/runs/:runId/share` | `{ canInput?, ttlMs? }` | mint a scoped share token + start the LAN relay → QR URL |
| `GET` | `/api/shares` | — | active shares |
| `POST` | `/api/runs/:runId/devices/:deviceId` | `{ action: 'allow' \| 'deny' }` | verdict on a knocking phone |
| `DELETE` | `/api/shares/:id` | — | revoke a share (stops the relay if it was the last) |
| `GET` | `/api/mobile/run?run&m&device` | — | **share-token gated**: metadata + liveness for the one shared terminal |
| `GET` | `/api/vitals` | — | header cluster: CPU/MEM history, machine totals, Claude usage windows |
| `GET` | `/api/pcstats` | — | machine vitals: CPU, memory, GPUs, temperatures, uptime/disk/battery |
| `GET` | `/api/pcstats/lan` | — | is the phone stats listener running, and at which addresses |
| `POST` | `/api/pcstats/lan/start` | `{ port?, frontendDir? }` | start it → `{ port, token, urls, phoneUrls }` |
| `POST` | `/api/pcstats/lan/stop` | — | stop it |

The `:4311` phone listener is **not** part of this API — it is a separate server
with its own token, serving only `GET /api/pcstats` and `/health`.

### WebSocket protocol

- **Server → client:** `{ type: "data", chunk }`, `{ type: "exit", status, exitCode }`, `{ type: "error", message }`
- **Client → server:** `{ type: "input", data }`, `{ type: "resize", cols, rows }`

---

## Project layout

```
NARUKAMI/
├── package.json                # npm workspaces root
├── scripts/gen-token.mjs       # token + frontend/.env wiring
├── packages/
│   ├── desktop/                # Electron shell → self-contained .exe (embedded SQLite)
│   │   ├── src/main.ts           # windows, tray, PC Stats window, phone-server toggle
│   │   ├── src/preload.ts        # the one contextBridge channel (pin-on-top)
│   │   └── scripts/stage.mjs     # stages main.js + preload.js + tray icon for packaging
│   ├── backend/
│   │   ├── prisma/schema.prisma  # provider = sqlite (file DB, no Docker)
│   │   └── src/
│   │       ├── index.ts          # Fastify bootstrap, token, 127.0.0.1 bind
│   │       ├── auth.ts           # bearer middleware + WS origin/host checks
│   │       ├── config.ts         # ports, origins, token file location
│   │       ├── db.ts             # Prisma client
│   │       ├── types.ts
│   │       ├── ws.ts             # ws server + per-run streaming
│   │       ├── routes/            # projects, runs, files, git, workspace, eod,
│   │       │                      # release, terminals, argus, godclaude,
│   │       │                      # vitals, pcstats, statsLan, armory,
│   │       │                      # settings, share  (registered in index.ts)
│   │       └── services/          # runner, analyzer, gitStatus/gitChanges/
│   │                              # gitLog, release, eodActivity/eodSessions,
│   │                              # argus, godclaude, armory, aiProvider,
│   │                              # pcstats, statsLan, mobileShare, …
│   ├── frontend/
│   │   └── src/
│   │       ├── App.tsx
│   │       ├── main.tsx          # renders PcStatsWindow when ?pcstats=1, else App
│   │       ├── api.ts            # fetch wrapper injecting the token
│   │       └── components/       # ProjectSidebar, ProjectPanel, TerminalTab,
│   │                             # CodeEditor, ChangesPanel, BrowserTab,
│   │                             # EodView, SgaRelease, argus/ArgusPanoptes,
│   │                             # Armory, Settings, ShareQrModal, Toasts,
│   │                             # HeaderCluster, PcStats{Panel,Popup,Window}
│   └── mobile/                 # native Android PC-stats app (Gradle, not an npm workspace)
│       ├── android/             # app/src/main/java/com/narukami/pcstats/{,theme/}
│       └── scripts/adb-reverse.mjs
```
