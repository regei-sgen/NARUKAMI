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
> remote-code-execution.** Everything binds to `127.0.0.1` and every request /
> WebSocket upgrade requires a bearer token. Do not expose it to a network.

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

---

## Security model

- HTTP and WebSocket servers bind to **`127.0.0.1` only** (never `0.0.0.0`).
- Every HTTP request needs `Authorization: Bearer <token>`; the WS upgrade needs
  `?token=…`.
- The token is 32 random bytes, generated on first boot, stored in
  `.runner-token` (gitignored), and **never logged**.
- CORS allows only the Vite dev origin (`http://localhost:5173` /
  `http://127.0.0.1:5173`).
- The WS upgrade also validates the `Origin` and `Host` headers and rejects
  anything that isn't our localhost origin — so another website open in your
  browser cannot connect to the terminal socket.

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

## API reference (all require the bearer token)

| Method | Route | Body | Purpose |
| ------ | ----- | ---- | ------- |
| `GET` | `/api/projects` | — | list projects + commands + latest run |
| `POST` | `/api/projects` | `{ path }` | register a project |
| `DELETE` | `/api/projects/:id` | — | delete (cascades) |
| `POST` | `/api/projects/:id/analyze` | — | run the analyzer, persist detected commands |
| `POST` | `/api/projects/:id/commands` | `{ label, command, isDefault? }` | add a custom run command |
| `POST` | `/api/projects/:id/commands/suggest` | `{ request }` | Claude Code turns a description into a command |
| `DELETE` | `/api/commands/:commandId` | — | delete a run command (detected or custom) |
| `POST` | `/api/projects/:id/run` | `{ commandId }` | spawn a run → `{ runId, pid }` |
| `POST` | `/api/projects/:id/shell` | — | open an interactive shell in the project dir → `{ runId, pid }` |
| `POST` | `/api/runs/:runId/stop` | — | kill the process |
| `GET` | `/api/runs/:runId` | — | run details + stored logs |
| `POST` | `/api/runs/:runId/diagnose` | — | explain a failed run via `claude -p` |
| `WS` | `/ws/runs/:runId?token=…` | — | live terminal I/O |

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
│   ├── backend/
│   │   ├── prisma/schema.prisma  # provider = sqlite (file DB, no Docker)
│   │   └── src/
│   │       ├── index.ts          # Fastify bootstrap, token, 127.0.0.1 bind
│   │       ├── auth.ts           # bearer middleware + WS origin/host checks
│   │       ├── config.ts         # ports, origins, token file location
│   │       ├── db.ts             # Prisma client
│   │       ├── types.ts
│   │       ├── ws.ts             # ws server + per-run streaming
│   │       ├── routes/{projects,runs}.ts
│   │       └── services/{runner,analyzer}.ts
│   └── frontend/
│       └── src/
│           ├── App.tsx
│           ├── api.ts            # fetch wrapper injecting the token
│           └── components/{ProjectSidebar,ProjectPanel,TerminalTab}.tsx
```
