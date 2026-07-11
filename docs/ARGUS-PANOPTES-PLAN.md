# Argus Panoptes — Native Godmonitor Tab for NARUKAMI (Plan)

**Status:** v1 IMPLEMENTED (phases 0–3). Phase 4 (WS live-tail / OBSERVE / signature hero) deferred.
**Date:** 2026-07-06
**Branch:** `opus-audit-fixes` (all NARUKAMI work stays here per standing rule).

**Implemented (verified 2026-07-06):** backend `services/argus.ts` + `routes/argus.ts` (registered in
`index.ts`); frontend global `argus` tab (`App.tsx` header nav + render branch), `api.ts` client,
`types.ts`, and `components/argus/*` (ArgusPanoptes container + SessionFleet, HealthPanel, GatePanel,
LatencyPanel, UsageMeters panels, MemoryGraph canvas force-sim, NoteViewer, scoped `argus.css`).
Proof this turn: backend `tsc` exit 0; `argus.test.ts` 13/13 (backend 126 total); frontend `tsc` exit
0 + `vite build` exit 0 + suite 38/38; live `/api/argus/status` 200 (health/gate/perf/2 sessions/
usage), `/memory-graph` 200 (37 memories · 5 ghosts · 3 fuzzy edges), `/logs` 200, bad source 400,
no-auth 401; browser render of the tab with real data, clean console. Data reads are read-only.

---

## 0. What this is

A new top-level tab in NARUKAMI — **Argus Panoptes** — that natively re-homes the GODCLAUDE
"godmonitor" guardian into this Electron app, **redesigned from scratch** (it does not reuse the
existing web dashboard's visual design), with the **memory / Obsidian knowledge graph** as a
first-class panel.

**Positioning (important):** "Argus Panoptes" is *not* a new invention. It is already GODCLAUDE's
own pseudonym codename for the `godmonitor` subsystem — the "hundred-eyed watcher that never
sleeps" (shipped in godclaude v1.8.0). (The alias layer was originally the Greek Pantheon and has
since been renamed to the Shinto kami roster; the Argus Panoptes codename was kept.) There is already a standalone web dashboard for it:
`~/.claude/godmonitor-server.mjs` (a zero-dep Node HTTP server + SSE) serving `~/.claude/godmonitor-ui/`.
This tab is a **native re-home** of that concept inside NARUKAMI — same data, same vocabulary, new
UI, no browser, no separate daemon required. It should read as a continuation of that identity,
not a duplicate.

**What it watches:** the GODCLAUDE hook layer under `C:\Users\lloyd\.claude` — god modes, drift/
integrity/plumbing health, the proof-of-work gate, hook performance, live Claude sessions, usage/
rate-limits, and the auto-memory graph. This is a system **orthogonal to NARUKAMI's own Prisma run
data** — Argus does not (in v1) show NARUKAMI's own runs/terminals/EOD (see Non-goals).

---

## 1. Locked decisions

| # | Decision | Choice | Consequence |
|---|----------|--------|-------------|
| D1 | **Watch scope** | GODCLAUDE layer only (`~/.claude`) | Tab is **global**, renders independent of the selected NARUKAMI project. No Prisma coupling. |
| D2 | **Interactivity** | Read-only + OBSERVE | No spawn/drive control plane. **Never writes `~/.claude`.** Honors the standing "propose-only" rule. Avoids the unauthenticated control-API surface (godclaude audit A39). |
| D3 | **Design ambition** | Lean panels first; signature hero → phase 2 | v1 is an original, from-scratch panel grid (its own design, not the old web skin). The eye/neural-core hero and heavy animation are deferred. |
| D4 | **Where file reads live** | **Backend only** | The renderer has zero fs access (no `nodeIntegration`, no preload, no IPC — verified: no `ipcMain`/`contextBridge` anywhere). All `~/.claude` reads go in a new Fastify service/route. |
| D5 | **Data strategy** | **Re-parse files directly**, do **not** proxy the running `godmonitor-server` daemon | The daemon may be down (dynamic HOME-hashed port), proxying re-exposes A39, and renderer→god-server is cross-origin with no CORS. Argus stays self-contained + token-gated. |
| D6 | **Mode/health resolution** | Shell out to GODCLAUDE's own JSON CLIs (authoritative), fall back to raw-file parse | Avoids re-implementing (and diverging from) the mode-resolution/overlay/tri-state logic; avoids `require()`-ing internal CJS cores that may have load side-effects or be absent when packaged. |
| D7 | **Live-update model** | Snapshot **polling** (~1.5–2s) for v1; add `/ws/argus` only for the OBSERVE live-tail (phase 2) | Zero new backend infra for v1. NARUKAMI's live idiom is raw `ws`, not SSE — do **not** port the god-server's SSE model. |
| D8 | **Memory graph** | Synthesize from `projects/*/memory/*.md` frontmatter + `[[wikilinks]]`; render dependency-free canvas force sim | **No Obsidian vault exists on disk** (verified: zero `.obsidian` dirs). Default to **all** `~/.claude` projects (NARUKAMI's own store has 1 note; the value is the global view of ~50 notes / 14 stores). Do **not** add d3. |

---

## 2. Architecture overview

```
┌───────────────────────────── NARUKAMI (Electron) ─────────────────────────────┐
│                                                                                │
│  Renderer (React 18 + Vite)              Backend (Fastify 5, in-process)        │
│  ┌──────────────────────────┐            ┌─────────────────────────────────┐   │
│  │ App.tsx                   │  fetch     │ routes/argus.ts                 │   │
│  │  view: …|'argus' (global) │──Bearer──▶ │  GET /api/argus/status          │   │
│  │  header nav: ⊙ Argus      │            │  GET /api/argus/sessions        │   │
│  │                           │            │  GET /api/argus/memory-graph    │   │
│  │  components/argus/*       │            │  GET /api/argus/memory/note     │   │
│  │   ArgusPanoptes.tsx       │◀─JSON──────│  GET /api/argus/logs?source&lim │   │
│  │   panels/… (v1 grid)      │  poll ~2s  │  (phase 2) WS /ws/argus (observe)│  │
│  │  argus.css (scoped .argus)│            └───────────────┬─────────────────┘   │
│  └──────────────────────────┘                            │                     │
│                                             services/argus.ts (read-only)       │
│                                             ├─ shell: godmode-stats.mjs --json  │
│                                             ├─ shell: godmonitor.mjs --json     │
│                                             ├─ tail:  godmode-perf.log (NDJSON) │
│                                             ├─ tail:  hook-audit.log (text)     │
│                                             ├─ tail:  godmonitor.log (NDJSON)   │
│                                             ├─ glob:  sessions/*.json           │
│                                             ├─ read:  usage-live.json + flags   │
│                                             └─ graph: projects/*/memory/*.md    │
└────────────────────────────────────────────────────────────────────────────────┘
                                             reads ↓ (never writes)
                                   C:\Users\lloyd\.claude  (the GODCLAUDE layer)
```

Everything under `/api/*` inherits NARUKAMI's existing global `onRequest` hook (loopback-Host
check + bearer-token `requireAuth`), so a new route module is auth-gated for free. WebSocket
upgrades bypass Fastify hooks, so `/ws/argus` (phase 2) must re-run origin/host/token checks itself
(the exact pattern `ws.ts` already uses for `/ws/runs/:id`).

---

## 3. Backend design

### 3.1 New service — `packages/backend/src/services/argus.ts`

Modeled on `services/gitLog.ts`: **pure parser functions split from thin I/O wrappers, fail-soft
(return a documented empty/default on any error, never throw), bounded**. One root constant:

```ts
const CLAUDE_DIR = process.env.ARGUS_CLAUDE_DIR ?? path.join(os.homedir(), '.claude');
```

Readers (all read-only):

| Reader | Source | Method |
|--------|--------|--------|
| `readSnapshot()` | god health + modes + routing | `execFile('node', ['<CLAUDE_DIR>/godmonitor.mjs','--json'])` → `{health,modes,activity,heartbeats,routing}`; short timeout + cache. |
| `readStats()` | perf + gate aggregates | `execFile('node', ['<CLAUDE_DIR>/godmode-stats.mjs','--json'])` → `{perfSpan,hookStats,dispatch,gate,suggestions}`; cache ~30–60s. |
| `collectSessions()` | live Claude fleet | glob `sessions/*.json`, `JSON.parse` each in try/catch; join `godmode-sessions/<sid>/mode`; derive live/idle/recent from `updatedAt` staleness. |
| `collectMemoryGraph()` | auto-memory | walk `projects/*/memory/*.md` (port of the proven collector — see §6); 30s cache. |
| `tailLog(source, limit)` | log streams | **byte-offset tail** of an allowlisted file; per-line tolerant parse; see §3.4. |
| `readNote(project, slug)` | per-note viewer | allowlisted read of `projects/<enc>/memory/<slug>.md` (§6). |
| `readUsage()` | rate-limits | whole-file read of `usage-live.json` (tiny). |

**Decoupling rationale (D6):** shelling out to `godmonitor.mjs --json` and `godmode-stats.mjs --json`
uses GODCLAUDE's *own public, documented* machine interfaces — authoritative for mode resolution,
health (drift/integrity/plumbing), and gate/perf math — instead of re-implementing that logic or
`require()`-ing internal `*-core.js` files (which may write files on load and won't exist in a
packaged app). If a CLI is missing/times out, degrade to a documented "unavailable" state and, where
cheap, a raw-file fallback (e.g. read the `godmode-*` flag files directly). Use `services/exec.ts`
(`resolveExecutable`/`wrapForWindows`) + `cleanEnv()` for the spawns, exactly like `analyzer.ts`.

### 3.2 New route — `packages/backend/src/routes/argus.ts`

`export async function argusRoutes(app: FastifyInstance)` (copy the plugin shape from `routes/eod.ts`).
Register in `index.ts` beside the other `await app.register(...)` calls. **GET-only** (CORS
allowlist is GET/POST/DELETE/OPTIONS; keep to GET). Data contract (ported from the proven godmonitor
API, trimmed to read-only):

| Endpoint | Response shape (abridged) |
|----------|---------------------------|
| `GET /api/argus/status` | `{ ok, ts, flags, health, modes[], activity, perf, heartbeats[], sessions, usage }` — the single feed the dashboard polls. |
| `GET /api/argus/sessions` | `{ count, usingGodclaude, live, items:[{ id, project, cwd, label, mode, modes[], autopilot, state:'live'\|'idle'\|'recent', ageMs, lastActive }] }` |
| `GET /api/argus/memory-graph` | `{ ok, ts, nodes:[{id,kind,label,type?,description?,project?}], edges:[{source,target,kind}], counts:{memory,projects,sessions,ghosts} }` |
| `GET /api/argus/memory/note?project=&slug=` | `{ ok, name, description, type, body, backlinks[], outlinks[] }` (per-note viewer). |
| `GET /api/argus/logs?source=monitor\|perf\|audit&limit=N` | `{ source, file, exists, count, lines[] }` (limit clamped 1..2000, default 200). |
| *(phase 2)* `GET /api/argus/session/:id/conversation?limit=N` | transcript blocks for OBSERVE. |
| *(phase 2)* `WS /ws/argus` | live tail / observe stream. |

### 3.3 Live model

- **v1:** the frontend polls `GET /api/argus/status` every ~1.5–2s (status/sessions/usage are tiny
  cached files). Memory graph polls slower (~30s). Precedent exists (`TerminalTab` already runs an
  800 ms liveness poll). **No `ws.ts` change for v1.**
- **Phase 2 (OBSERVE live-tail):** add a `MONITOR_WS_RE = /^\/ws\/argus$/` branch to the `ws.ts`
  upgrade switchboard, re-running `isAllowedOrigin` + `isAllowedHost` + `isValidToken(token)` (WS
  bypasses Fastify hooks), backed by a module-level `Set<WebSocket>` fed by an **interval** re-read
  (not `fs.watch` — flaky on Windows), mirroring the `runner.ts` subscriber fan-out. Client copies
  `TerminalTab`'s `openSocket()` pattern. **Do not add SSE** (no precedent; fights the global auth hook).

### 3.4 Security & robustness invariants (non-negotiable)

1. **No client-supplied paths — server-side allowlist only.** `source` ∈ `{monitor, perf, audit}`
   maps through a fixed table to a fixed filename. A raw path query would be an arbitrary local-file
   read hole. The memory `note` reader resolves strictly under `projects/*/memory/` and rejects
   `..`/absolute/symlink escapes (realpath check), analogous to `files.ts` `resolveInProject` but
   rooted at `CLAUDE_DIR`.
2. **Never expose secrets.** `~/.claude/.credentials.json` and similar live in this tree — the reader
   allowlists specific monitor files/subtrees, never the whole directory, even though it is token-gated.
3. **Tail, never slurp, the big append-only logs.** `godmode-perf.log` (~2.4 MB) and `hook-audit.log`
   (~3 MB) grow unbounded and rotate at 10 MB → `.1`. Use `fs.stat` → `createReadStream` from
   `size − N` (or read-last-N-KB), detect truncation/rotation (offset reset when size shrinks), and
   tolerate a partial trailing line. `files.ts` (1 MiB cap + full slurp) is the **wrong** primitive here.
4. **Tolerant parsing everywhere.** JSONL lines can be half-written mid-append (concurrent writers) →
   `try/catch` per line, skip unparseable. Frontmatter is **not strict YAML** (bare vs quoted
   `description`, trailing space after `metadata:`) → tolerant regex, never a throwing YAML lib. Some
   memory files contain a raw **NUL byte** → `raw.replace(/\0/g,'')` before parse.
5. **Read-only, coexist.** The standalone `godmonitor-server` daemon may still be running and writing
   these files; Argus only reads, so two readers are safe. Do not touch/kill the daemon.

---

## 4. Frontend design

### 4.1 Tab wiring — the one structural change

Every existing tab (`runner`/`editor`/`eod`) lives **inside** the `selected ?` project guard in
`App.tsx` (the `.view-switch` only renders when a project is selected). Argus is **global** (D1), so
it must render **without** a selected project. Plan:

1. `types.ts`: extend `UiSettings.view` union to include `'argus'`.
2. `App.tsx`: extend the `useState<'runner'|'editor'|'eod'>` generic (line ~26) to add `'argus'`; add
   `'argus'` to the boot-restore allowlist guard (line ~105) and to the persistence effect (already
   covered by the `ui` blob).
3. **Global nav entry (not a `.vs-btn`):** add an **Argus button in the app header** (the top bar next
   to the "NARUKAMI" title / sidebar toggle) — a global control, always visible, that sets
   `view='argus'`. Give it its **own class** (e.g. `argus-nav-btn`) and an eye/⊙ glyph — do **not**
   reuse the per-project `.view-switch`/`.vs-btn` styling (design must be independent).
4. **Render branch** in `<main>`: restructure so Argus wins before the project guard —
   `view === 'argus' ? <ArgusPanoptes/> : selected ? (<>view-switch + runner/editor/eod</>) : <empty/>`.
   Entering Argus hides the project workspace; a "back to project" affordance restores the last
   per-project view.
5. **Terminal dock while in Argus:** ptys always stay mounted (unchanged). In `argus` view the
   project-scoped dock can be hidden (it only ever shows the selected project's terminals) — minor
   UX detail, no behavioral risk.

> All line numbers are approximate — verify against `App.tsx` at implementation time.

### 4.2 Component tree — `packages/frontend/src/components/argus/`

Cloned from the `EodView.tsx` data pattern (`useState` data + `loading` + `err`, a `load()` in
`useEffect` via the `api` client):

```
ArgusPanoptes.tsx        // container: owns polling loop, error/empty states, layout grid
panels/
  SessionFleet.tsx       // live Claude sessions table (P1)
  HealthPanel.tsx        // drift / integrity / plumbing (P2)
  MemoryGraph.tsx        // Obsidian-style canvas force graph (P3, mandatory) — see §6
  GatePanel.tsx          // proof-of-work allow/block + UNSETTLED alarm (P4)
  LatencyPanel.tsx       // per-hook p50/p95/max + dispatch mix (P5)
  UsageMeters.tsx        // 5h / 7-day rate-limit gauges (P6)
  LogFeed.tsx            // tailed log streams + autopilot switches (P7)
NoteViewer.tsx           // per-memory-note markdown + backlinks drawer (reuses Monaco or marked)
argus.css                // ALL styles scoped under `.argus` — its own token block
```

### 4.3 Styling

`styles.css` is one flat **global** namespace with no scoping. The Argus stylesheet ships its **own**
design and scopes **every** selector under a `.argus` wrapper (or its own token block) to avoid
colliding with existing global classes (`.tab`, `.stat`, `.card`, …). Import `argus.css` from
`ArgusPanoptes.tsx`. Semantic color language (live=green, idle=amber, fault=red) and monospace for
all numeric/log text; respect `prefers-reduced-motion`. See Appendix B for godclaude's palette/fonts
as *reference cues* (we are redesigning, not copying the skin).

### 4.4 API client

Add to the `api` object in `api.ts` (they inherit the bearer-token `request<T>()` wrapper):
`getArgusStatus()`, `getArgusSessions()`, `getArgusMemoryGraph()`, `getArgusNote(project, slug)`,
`getArgusLogs(source, limit)`. Add response types to `types.ts`. Phase 2: `argusWsUrl()` mirroring
`runWsUrl()`.

---

## 5. Panels — v1 grid and phase 2

Ranked by actionable value; each tied to a verified data source. **P1–P3 are the v1 core (P3 is
mandatory per the request). P4–P6 are cheap adds off the same `/status` snapshot. P7 + hero are phase 2.**

| # | Panel | Data source | Notes |
|---|-------|-------------|-------|
| P1 | **Live Claude session fleet** | `sessions/*.json` (pid, cwd, `status:busy\|idle`, version, name, `updatedAt`) + `godmode-sessions/<sid>/mode` | "What is every agent doing right now." Highest value. State via staleness: <2 min live, <30 min idle, else recent. |
| P2 | **Drift / integrity / plumbing** | `godmonitor.mjs --json` health + `godmonitor.log` (`requested` vs `effective`, `drift`, `ok`, `issues[]`) | Flagship godmonitor signal ("LOST PATH: requested qa, running general"). Render drift/`ok`/`issues` as **normally-silent red-alert tiles**. |
| P3 | **Memory / Obsidian graph** | `projects/*/memory/*.md` frontmatter + `[[links]]` | **Mandatory.** Global (all stores). Full detail in §6. |
| P4 | **Proof-of-work gate** | `hook-audit.log` (`ALLOW`/`BLOCK`/`DIAG`) + `godmode-stats.mjs --json` gate | allow/block counts, block-rate, per-mode split, **`UNSETTLED` = fail-open alarm**. |
| P5 | **Hook performance** | `godmode-perf.log` (JSONL) via `godmode-stats.mjs --json` | p50/p95/max per hook + dispatch mix. **`dispatch=error` (hook failed open) and `dispatch=spawn` (stale install) are red flags.** |
| P6 | **Usage / rate-limits** | `usage-live.json` | 5h% + 7-day% with reset countdowns. `resets_at` is epoch **seconds**; windows independently optional; step-shaped (updates only on real API render). Thresholds green<50 / yellow 50–79 / red≥80. |
| P7 | **Live log / activity feed** | tail `godmonitor.log` + `hook-audit.log` + `[autopilot] switched to <mode>` | Phase 2 — the one panel that justifies `/ws/argus`. |
| — | **Signature "hundred-eyes" hero** | — | Phase 2 (D3). Eye/neural-core connectome identity + animation. |

---

## 6. Memory / Obsidian panel — detailed spec (mandatory)

**Data model (synthesized — no vault on disk):** port `collectMemoryGraph()` logic into
`services/argus.ts` (re-implement in TS; there is no CLI for it). Walk
`CLAUDE_DIR/projects/<enc>/memory/*.md` (exclude `MEMORY.md`), decode the project dir
(`C--Users-lloyd-NARUKAMI` → `C:/Users/lloyd/NARUKAMI`), tolerant-regex-parse frontmatter, extract
`[[slug]]` links.

- **Nodes:** `memory` (typed by `metadata.type`), `project`, `session` (from `originSessionId`),
  `ghost` (unresolved link). IDs: `mem:<proj>:<slug>`, `proj:<proj>`, `sess:<sid>`, `ghost:<proj>:<link>`.
- **Edges:** `in-project` (note→project), `origin-session` (note→session), `links-to` (note→note/ghost).
- **Frontmatter fields:** `name` (slug = filename minus `.md`, the `[[link]]` resolution key),
  `description` (bare or quoted), `metadata.node_type` (always `memory`), `metadata.type`
  (`feedback`/`project`/`reference`, else default `note`), `metadata.originSessionId`.

**Render:** dependency-free **canvas force simulation** (repulsion + springs + centering, alpha
decay), hover hit-test tooltip, legend, color by node kind/type via CSS custom props. **Do not add
d3.** Convert the proven `MemoryGraph()`/`useMemoryGraph()` from the god UI's `app.js` to a TSX
component (the canvas loop translates 1:1).

**Panel features:**
1. Force-directed graph (nodes/edges as above), **global by default** (all 14 stores; NARUKAMI's own
   store has 1 note — a project-scoped graph would be near-empty).
2. Live counts header: N memories · N projects · N sessions · N ghosts (illustrative, never hardcode
   — the corpus is live-growing; measured ~50 notes / 14 stores today).
3. **Per-note viewer** (`GET /api/argus/memory/note`): rendered markdown body + frontmatter +
   computed **backlinks** (who links here) and outlinks.
4. **Orphan detection** (zero inbound *and* outbound links) and **broken-link detection** (link →
   ghost).
5. Type/kind **filter chips** (feedback / project / reference / note).

**Slug-match landmine (must handle):** older underscore files (`v2_audit_backlog.md`) are linked with
hyphens (`[[v2-audit-backlog]]`). Exact-match → a wall of false ghosts. Implement **slug
normalization** (lowercase, unify `-`/`_`) as the matching path, and surface normalization-only hits
as a distinct **"fuzzy link"** style so genuine broken links stay legible.

---

## 7. Correctness landmines to encode (from the audit)

1. **Dead sentinels.** `godmode-session` and `godmode-sense` still contain `"enabled"` on disk but are
   **DEAD** (merged into autopilot). Auto-routing is authoritative **only** from `godmode-autosession`.
   Reading sense/session as live toggles ships a wrong status. Get routing state from the god CLI's
   health output (which already applies `routingOn`), not from raw sentinel existence.
2. **Mode id vs pseudonym.** Canonical ids (`developer`, `qa`, …) are FROZEN on-disk dir names + log
   tokens; kami names (Mahitotsu, Kuebiko, **Argus Panoptes = godmonitor**, Amaterasu = general —
   originally Greek: Hephaestus, Athena, Zeus, before the kami rename) are an **additive display
   layer only**. Any parser keying on `mode=<id>` (`/\bmode=([a-z-]+)/i`) uses canonical ids;
   pseudonyms are labels rendered via the `KAMI` map (formerly `FALLBACK_PSEUDONYM`).
3. **Two source copies exist** — `~/.claude/godmonitor-server.mjs` (deployed, v1.7.1) and
   `~/godclaude/assets/godmonitor-server.mjs` (source, v1.8.0, carries the Argus identity). **Port from
   the source copy (`~/godclaude/assets/*`)** and re-verify all cited line numbers there — different
   copies have different line numbers and feature sets.
4. **Recency window + fixture skip.** Log stats can be stale/fixture-polluted. Apply the god default
   **14-day** window and skip test-fixture lines (which `godmode-stats.mjs` already does — another
   reason to shell out to it rather than re-parse).
5. **Census is a moving target.** Memory-file counts, perf-log line counts, etc. are snapshots of
   live-growing files. Never hardcode counts; always compute.
6. **Ephemeral sessions.** `godmode-sessions/<sid>/` are GC'd (14-day / 200-cap) and cleared on genuine
   SessionEnd; `sessions/<pid>.json` PIDs are reused. Treat the session list as ephemeral; use
   `sessionId` (stable) as the key and `updatedAt` staleness as the liveness proxy.

---

## 8. File change map

**Touch (existing):**
- `packages/backend/src/index.ts` — register `argusRoutes`.
- `packages/frontend/src/App.tsx` — `view` union + `'argus'`, boot guard, header nav button, render branch.
- `packages/frontend/src/types.ts` — `UiSettings.view` union + Argus response types.
- `packages/frontend/src/api.ts` — `getArgus*` client methods.
- *(phase 2)* `packages/backend/src/ws.ts` — `/ws/argus` upgrade branch.

**Add (new):**
- `packages/backend/src/services/argus.ts` — read-only collectors (§3.1).
- `packages/backend/src/routes/argus.ts` — `/api/argus/*` (§3.2).
- `packages/backend/src/services/argus.test.ts` — parser unit tests (fixtures; mirror `gitLog.test.ts`).
- `packages/frontend/src/components/argus/ArgusPanoptes.tsx` + `panels/*` + `NoteViewer.tsx`.
- `packages/frontend/src/components/argus/argus.css` — scoped under `.argus`.

**No changes:** Prisma schema (data is on-disk; UI prefs ride the existing `AppSetting` `ui` blob).
No `react-router`. No new frontend graph dependency.

---

## 9. Phased build plan

**Phase 0 — Backend spine (read-only, testable headless)**
- `services/argus.ts`: `readSnapshot`/`readStats` (shell CLIs) + `collectSessions` + `readUsage` +
  `tailLog` with byte-offset tail/rotation handling.
- `routes/argus.ts`: `/status`, `/sessions`, `/logs`; register in `index.ts`.
- Unit tests over captured fixtures incl. the NUL-byte file and half-written JSONL lines.
- **Milestone:** `curl -H "Authorization: Bearer …" /api/argus/status` returns a valid snapshot.

**Phase 1 — Tab shell + P1/P2 panels**
- App.tsx global-tab wiring (header nav, render branch, persistence).
- `ArgusPanoptes.tsx` polling container; `SessionFleet` (P1) + `HealthPanel` (P2); scoped `argus.css`.
- **Milestone:** Argus tab opens with no project selected and shows the live session fleet + health,
  refreshing every ~2s.

**Phase 2 — Memory graph (mandatory)**
- `collectMemoryGraph()` in the service + `/api/argus/memory-graph` + `/api/argus/memory/note`.
- `MemoryGraph.tsx` (canvas force sim) + `NoteViewer.tsx`; slug-normalization + orphan/broken-link.
- **Milestone:** graph renders all stores; clicking a node opens the note with backlinks; fuzzy links
  distinguished from real ghosts.

**Phase 3 — Telemetry panels**
- `GatePanel` (P4), `LatencyPanel` (P5), `UsageMeters` (P6) off the same snapshot; silent-until-fault
  alert tiles (drift, UNSETTLED, dispatch=error).
- **Milestone:** full v1 grid.

**Phase 4 (later) — Live tail + OBSERVE + hero**
- `/ws/argus` streaming; `LogFeed` (P7) + read-only transcript OBSERVE; signature hero + animation.
- Requires reading the raw Claude Code transcript `.jsonl` format first (currently unspeced — see Open items).

---

## 10. Testing

- **Backend:** vitest parser tests over a captured fixture corpus (a sanitized copy of real files under
  a temp `ARGUS_CLAUDE_DIR`), including: NUL-byte memory file, half-written trailing JSONL line, an
  old perf line missing `dispatch`, a `requested != effective` drift line, underscore/hyphen slug
  mismatches, and a `usage-live.json` missing a window. Assert fail-soft (never throws).
- **Tail correctness:** simulate rotation (shrink the file) and assert offset reset.
- **Frontend:** `@testing-library/react` for loading/error/empty states; graph math (force step,
  hit-test, slug-normalization) as pure unit tests.
- **Security:** assert `/api/argus/logs?source=../../secret` is rejected (allowlist), and the note
  reader rejects `..`/absolute/symlink escapes.

---

## 11. Risks, non-goals, open items

**Non-goals (v1):**
- No NARUKAMI-own run/terminal/EOD data in Argus (D1).
- No control plane — no spawn/resume/drive of sessions (D2). NARUKAMI's existing Claude terminals cover that.
- No writes to `~/.claude`, ever.
- No signature hero/heavy animation (D3, phase 2+).

**Risks:**
- **God-layer format drift.** `~/.claude` file formats are owned by GODCLAUDE tooling and can change.
  Mitigation: shell the god CLIs for the volatile logic (§3.1), tolerant parsers everywhere,
  `ARGUS_CLAUDE_DIR` overridable for tests.
- **CLI latency.** Spawning `node godmonitor.mjs --json` per poll could be slow; mitigate with a
  server-side cache (2s for status, 30–60s for stats) so polling never re-spawns hot.
- **Packaged-app absence.** In a packaged build the god CLIs/files may not be present on a given
  machine; degrade to a clear "GODCLAUDE not detected" empty state rather than erroring.

**Open items to resolve at implementation time (not blocking the plan):**
- Raw Claude Code transcript `.jsonl` format (needed for OBSERVE/session-mode detection in phase 4) —
  not yet documented; read it before building P7/OBSERVE.
- Exact line numbers for the port targets — re-verify against `~/godclaude/assets/*` (v1.8.0), not the
  deployed v1.7.1 copy.
- Whether to keep the standalone `godmonitor-server` daemon running in parallel (harmless, read-only
  coexist) or have the user retire it once the native tab lands — user's call, no code impact.

---

## Appendix A — Native vocabulary (use verbatim so Argus reads as part of the ecosystem)

- **Deterministic Operating Contract** — the injected 8-rule stance ("take the expensive path and prove it").
- **The gate / proof-of-work gate** — the Stop-hook that blocks edit+claim turns lacking post-edit verification.
- **Proof / evidence** — a command that ran this turn with output, a re-read of the changed file, or a captured artifact ("evidence or flag").
- **Mode** — a role-specific proof profile (8 roles + `general`). **Kami roster** — the Shinto-kami
  display alias layer (originally the Greek Pantheon; renamed to the kami roster, see
  `packages/frontend/src/components/argus/lib.ts`).
  Mapping: developer·Mahitotsu, researcher·Kuebiko, data-analyst·Tsukuyomi, qa·Enma, reviewer·Susanoo,
  planner·Omoikane, ci-cd·Sarutahiko, web-builder·Uzume, general·Amaterasu, **godmonitor·Argus Panoptes**.
- **godmonitor** — the guardian verifying the active mode is intact (drift / integrity / plumbing).
- **autopilot** — the opt-in auto-router (deterministic weighted signal scorer, not comprehension).
- **armed** — layer active for this session. **drift** — requested mode ≠ effective mode. **live / idle / fault** — semantic states.

## Appendix B — Theming reference cues (redesign FROM these, don't copy)

godclaude's default "indigo" skin (semantic, not decorative): primary `#7d83ff`, gold `#f3c969`,
live/green `#3ed9a6`, idle/amber `#f0b54e`, fault/red `#ff6b78`, page `#0a0e15`, panel `#11151f`,
card `#171c28`, text `#e8ebf2`. Fonts: Space Grotesk (UI) + JetBrains Mono (all numeric/technical/log
text). Signature elements (phase 2): heartbeat "scope" pulse-sweep, neural-core connectome. ⚡ =
autopilot. Mode names render lowercase in heroes. NARUKAMI = 鳴神 (thunder god) already fits the
kami/lightning motif (originally framed around Zeus/the Greek Pantheon). Ship both light + dark via CSS custom properties; respect
`prefers-reduced-motion`.

## Appendix C — On-disk data formats reference (verified samples)

- `usage-live.json`: `{ts(ms), model, session_id, rate_limits:{five_hour:{used_percentage,resets_at(sec)}, seven_day:{…}, seven_day_opus?:{…}}}` — each window optional.
- `sessions/<pid>.json`: `{pid, sessionId, cwd, startedAt(ms), version, kind, name, status:'busy'|'idle', updatedAt(ms), statusUpdatedAt(ms)}`.
- `godmode-perf.log` (NDJSON): `{ts(ISO), hook, event, active, ms, emitted, blocked, dispatch?}` — `dispatch ∈ in-process|spawn|error|legacy` (older lines omit it).
- `godmonitor.log` (NDJSON): `{ts, event:'SessionStart'|'switch', requested, effective, drift, ok, sensing, autopilot?, issues[]}`.
- `hook-audit.log` (text): `[<ISO ts>] [<gate>] ALLOW|BLOCK|DIAG: <detail>`; `gate ∈ proof-gate|persist-gate`; DIAG lines embed `event=… mode=<id> tx=<sid>.jsonl settled=… tools=[…]`.
- `godmode-sessions/<sid>/mode`: plain text, mode name(s), newline-separated (multi-mode).
- memory note frontmatter: `name`, `description` (bare/quoted), `metadata.{node_type:'memory', type, originSessionId}`; body `[[slug]]` links; some files contain raw NUL bytes.
- `MEMORY.md` index line grammar: `- [Human Title](slug.md) — <description>` (optional `# Memory index` header).
