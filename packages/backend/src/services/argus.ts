import { execFile } from 'node:child_process';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);

/**
 * Argus Panoptes — read-only projection over the GODCLAUDE hook layer under
 * ~/.claude. Everything here READS; nothing ever writes into ~/.claude.
 *
 * Two data strategies (see docs/ARGUS-PANOPTES-PLAN.md):
 *   - Mode resolution / health / gate+perf math → shell GODCLAUDE's own `--json`
 *     CLIs (authoritative; never diverges from the god layer's logic).
 *   - Sessions / usage / logs / memory-graph → parse the on-disk files directly,
 *     fail-soft (a bad/missing file yields a documented empty default, never throws).
 */

/** Root of the GODCLAUDE state tree. Overridable for tests. */
export function claudeDir(): string {
  return process.env.ARGUS_CLAUDE_DIR ?? path.join(os.homedir(), '.claude');
}

// ── shell-out to the god CLIs ────────────────────────────────────────────────

const CLI_TIMEOUT_MS = 15_000;
const CLI_MAX_BUFFER = 16 * 1024 * 1024;

/**
 * Run a GODCLAUDE `.mjs` CLI with `--json` and parse its stdout. Uses the current
 * Node/Electron binary; ELECTRON_RUN_AS_NODE lets a packaged Electron run it as
 * plain Node. Returns null (never throws) if the script is absent, errors, times
 * out, or emits non-JSON.
 */
async function runGodJson<T>(scriptName: string): Promise<T | null> {
  const scriptPath = path.join(claudeDir(), scriptName);
  if (!fs.existsSync(scriptPath)) return null;
  try {
    const { stdout } = await execFileAsync(process.execPath, [scriptPath, '--json'], {
      timeout: CLI_TIMEOUT_MS,
      maxBuffer: CLI_MAX_BUFFER,
      windowsHide: true,
      env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' },
    });
    return JSON.parse(stdout) as T;
  } catch {
    return null;
  }
}

// Small TTL cache so a ~2s frontend poll doesn't re-spawn the CLIs on every tick.
interface CacheEntry<T> {
  t: number;
  v: T;
}
const cache = new Map<string, CacheEntry<unknown>>();

async function cached<T>(key: string, ttlMs: number, produce: () => Promise<T>): Promise<T> {
  const hit = cache.get(key) as CacheEntry<T> | undefined;
  const now = Date.now();
  if (hit && now - hit.t < ttlMs) return hit.v;
  const v = await produce();
  cache.set(key, { t: now, v });
  return v;
}

/** godmonitor.mjs --json → health / modes / activity / heartbeats / routing. */
export interface GodSnapshot {
  health: Record<string, unknown>;
  modes: Array<Record<string, unknown>>;
  activity: Record<string, { allow: number; block: number }>;
  heartbeats: Array<Record<string, unknown>>;
  routing: Record<string, unknown>;
}

/** godmode-stats.mjs --json → perf / gate aggregates / suggestions. */
export interface GodStats {
  perfSpan: { from: string; to: string } | null;
  dispatch: Record<string, number>;
  hookStats: Array<Record<string, unknown>>;
  gate: Record<string, unknown>;
  suggestions: string[];
}

export function readSnapshot(): Promise<GodSnapshot | null> {
  return cached('snapshot', 2500, () => runGodJson<GodSnapshot>('godmonitor.mjs'));
}

export function readStats(): Promise<GodStats | null> {
  return cached('stats', 30_000, () => runGodJson<GodStats>('godmode-stats.mjs'));
}

// ── live Claude session fleet ────────────────────────────────────────────────

export interface ArgusSession {
  pid: number | null;
  sessionId: string;
  cwd: string;
  name: string;
  version: string;
  /** the session's own busy/idle self-report (from the registry) */
  status: 'busy' | 'idle' | string;
  /** god mode(s) this session is running, from its overlay dir */
  modes: string[];
  /** liveness derived from updatedAt staleness */
  state: 'live' | 'idle' | 'recent';
  ageMs: number;
  updatedAt: number | null;
  /**
   * Who launched this session: 'narukami' if its id matches a Run this NARUKAMI
   * instance spawned (via `--session-id`), else 'native' (a plain `claude` CLI).
   * undefined when the caller didn't supply the NARUKAMI id set (e.g. unit tests).
   */
  origin?: 'narukami' | 'native';
}

export interface ArgusSessions {
  count: number;
  live: number;
  items: ArgusSession[];
}

const LIVE_MS = 2 * 60 * 1000;
const IDLE_MS = 30 * 60 * 1000;

/** Liveness bucket from how long ago the session last reported. Pure. */
export function sessionState(ageMs: number): 'live' | 'idle' | 'recent' {
  if (ageMs < LIVE_MS) return 'live';
  if (ageMs < IDLE_MS) return 'idle';
  return 'recent';
}

/** Read the god mode(s) for a session from its overlay dir (newline-separated). Pure-ish (one read). */
function readSessionModes(sessionId: string, godDir: string = claudeDir()): string[] {
  if (!/^[A-Za-z0-9._-]+$/.test(sessionId)) return [];
  const modeFile = path.join(godDir, 'godmode-sessions', sessionId, 'mode');
  try {
    return fs
      .readFileSync(modeFile, 'utf8')
      .split('\n')
      .map((l) => l.trim())
      .filter((l) => l && l !== 'general');
  } catch {
    return [];
  }
}

/**
 * Enumerate live Claude sessions from the ~/.claude/sessions/<pid>.json registry,
 * joined to each session's god-mode overlay. Read-only, fail-soft. `now` is
 * injectable for tests. `narukamiIds` (the session ids this NARUKAMI instance
 * launched) tags each item's `origin`; omit it to leave `origin` undefined.
 *
 * The registry is written by Claude Code itself (always under ~/.claude — it
 * does not follow DET_HOOKS_HOME), but the god-mode overlay is per-instance:
 * `godDir` selects which godclaude home the MODE column reads from (native
 * ~/.claude by default; the embedded status passes NARUKAMI's own home).
 */
export async function collectSessions(
  now: number = Date.now(),
  narukamiIds?: ReadonlySet<string>,
  godDir: string = claudeDir(),
): Promise<ArgusSessions> {
  const dir = path.join(claudeDir(), 'sessions');
  let files: string[] = [];
  try {
    files = (await fsp.readdir(dir)).filter((f) => f.endsWith('.json'));
  } catch {
    return { count: 0, live: 0, items: [] };
  }

  const items: ArgusSession[] = [];
  for (const f of files) {
    let raw: string;
    try {
      raw = await fsp.readFile(path.join(dir, f), 'utf8');
    } catch {
      continue;
    }
    let o: Record<string, unknown>;
    try {
      o = JSON.parse(raw) as Record<string, unknown>;
    } catch {
      continue; // torn/half-written file — skip
    }
    const sessionId = typeof o.sessionId === 'string' ? o.sessionId : f.replace(/\.json$/, '');
    const updatedAt = typeof o.updatedAt === 'number' ? o.updatedAt : null;
    const ageMs = updatedAt != null ? Math.max(0, now - updatedAt) : Number.MAX_SAFE_INTEGER;
    items.push({
      pid: typeof o.pid === 'number' ? o.pid : null,
      sessionId,
      cwd: typeof o.cwd === 'string' ? o.cwd.replace(/\\\\/g, '\\') : '',
      name: typeof o.name === 'string' ? o.name : '',
      version: typeof o.version === 'string' ? o.version : '',
      status: typeof o.status === 'string' ? o.status : 'idle',
      modes: readSessionModes(sessionId, godDir),
      state: sessionState(ageMs),
      ageMs: ageMs === Number.MAX_SAFE_INTEGER ? -1 : ageMs,
      updatedAt,
      origin: narukamiIds ? (narukamiIds.has(sessionId) ? 'narukami' : 'native') : undefined,
    });
  }
  items.sort((a, b) => a.ageMs - b.ageMs);
  return { count: items.length, live: items.filter((s) => s.state === 'live').length, items };
}

// ── usage / rate-limits ──────────────────────────────────────────────────────

export interface Usage {
  ts: number;
  model?: string;
  session_id?: string;
  rate_limits?: Record<string, { used_percentage?: number; resets_at?: number }>;
}

export async function readUsage(): Promise<Usage | null> {
  try {
    const raw = await fsp.readFile(path.join(claudeDir(), 'usage-live.json'), 'utf8');
    return JSON.parse(raw) as Usage;
  } catch {
    return null;
  }
}

// ── memory / Obsidian knowledge graph ────────────────────────────────────────

export interface MemoryNodeRaw {
  proj: string;
  slug: string;
  description: string;
  type: string;
  sid: string;
  links: string[];
}

export interface GraphNode {
  id: string;
  kind: 'memory' | 'project' | 'session' | 'ghost';
  label: string;
  type?: string;
  description?: string;
  project?: string;
}

export interface GraphEdge {
  source: string;
  target: string;
  kind: 'in-project' | 'origin-session' | 'links-to';
  /** true when a links-to edge only resolved after slug-normalization (naming drift, not a real break) */
  fuzzy?: boolean;
}

export interface MemoryGraph {
  ok: boolean;
  ts: string;
  nodes: GraphNode[];
  edges: GraphEdge[];
  counts: { memory: number; projects: number; sessions: number; ghosts: number };
}

/** Decode an encoded project dir name back to a cwd-ish path. Pure. */
export function decodeProjectDir(d: string): string {
  return String(d || '')
    .replace(/^([A-Za-z])--/, '$1:/')
    .replace(/-/g, '/');
}

/** Normalize a slug for tolerant [[link]] matching: lowercase, unify - and _. Pure. */
export function normalizeSlug(s: string): string {
  return String(s || '')
    .toLowerCase()
    .replace(/_/g, '-');
}

/** Parse one memory note's raw text into its graph fields. Pure — NUL-safe, tolerant (never strict YAML). */
export function parseMemoryNote(raw: string, filename: string): Omit<MemoryNodeRaw, 'proj'> {
  const clean = raw.replace(/\0/g, ''); // one real memory file carries a raw NUL byte
  const fm = clean.match(/^---\r?\n([\s\S]*?)\r?\n---/);
  const front = fm ? fm[1] : '';
  const body = fm ? clean.slice(fm[0].length) : clean;
  const grab = (re: RegExp): string => {
    const m = front.match(re);
    return m ? m[1].trim() : '';
  };
  const slug = grab(/^name:[ \t]*(.+)$/m) || filename.replace(/\.md$/i, '');
  const typeMatch = front.match(/^[ \t]*type:[ \t]*([A-Za-z]+)/m);
  const type = (typeMatch ? typeMatch[1] : 'note').toLowerCase();
  const sidMatch = front.match(/originSessionId:[ \t]*([0-9a-fA-F-]{8,})/);
  const sid = sidMatch ? sidMatch[1] : '';
  // strip surrounding quotes on description if present
  const description = grab(/^description:[ \t]*(.+)$/m).replace(/^["']|["']$/g, '');
  const links = Array.from(body.matchAll(/\[\[([^\]]+)\]\]/g))
    .map((m) => m[1].trim())
    .filter(Boolean);
  return { slug, description, type, sid, links };
}

/**
 * Build the graph from parsed notes. Pure — no I/O, so it is directly unit-tested.
 * Links resolve within the same project: exact slug first, then a normalized
 * (case/`-`/`_`-insensitive) match flagged `fuzzy`; anything else becomes a ghost.
 */
export function buildMemoryGraph(notes: MemoryNodeRaw[]): MemoryGraph {
  const nodes: GraphNode[] = [];
  const edges: GraphEdge[] = [];
  const ids = new Set<string>();
  const addNode = (id: string, node: Omit<GraphNode, 'id'>): void => {
    if (!ids.has(id)) {
      ids.add(id);
      nodes.push({ id, ...node });
    }
  };

  // Per-project slug indexes: exact + normalized.
  const bySlug: Record<string, Record<string, string>> = {};
  const byNorm: Record<string, Record<string, string>> = {};
  for (const it of notes) {
    const mid = `mem:${it.proj}:${it.slug}`;
    (bySlug[it.proj] ||= {})[it.slug] = mid;
    (byNorm[it.proj] ||= {})[normalizeSlug(it.slug)] = mid;
  }

  for (const it of notes) {
    const mid = `mem:${it.proj}:${it.slug}`;
    addNode(mid, {
      kind: 'memory',
      label: it.slug,
      type: it.type,
      description: it.description,
      project: it.proj,
    });
    const pid = `proj:${it.proj}`;
    addNode(pid, {
      kind: 'project',
      label: decodeProjectDir(it.proj).split('/').filter(Boolean).pop() || it.proj,
    });
    edges.push({ source: mid, target: pid, kind: 'in-project' });
    if (it.sid) {
      const sid = `sess:${it.sid}`;
      addNode(sid, { kind: 'session', label: it.sid.slice(0, 8) });
      edges.push({ source: mid, target: sid, kind: 'origin-session' });
    }
  }

  for (const it of notes) {
    const mid = `mem:${it.proj}:${it.slug}`;
    for (const link of it.links) {
      const exact = bySlug[it.proj]?.[link];
      if (exact) {
        edges.push({ source: mid, target: exact, kind: 'links-to' });
        continue;
      }
      const fuzzy = byNorm[it.proj]?.[normalizeSlug(link)];
      if (fuzzy) {
        edges.push({ source: mid, target: fuzzy, kind: 'links-to', fuzzy: true });
        continue;
      }
      const ghost = `ghost:${it.proj}:${link}`;
      addNode(ghost, { kind: 'ghost', label: link, project: it.proj });
      edges.push({ source: mid, target: ghost, kind: 'links-to' });
    }
  }

  const projectsWithMem = new Set(notes.map((n) => n.proj));
  return {
    ok: true,
    ts: new Date().toISOString(),
    nodes,
    edges,
    counts: {
      memory: notes.length,
      projects: projectsWithMem.size,
      sessions: nodes.filter((n) => n.kind === 'session').length,
      ghosts: nodes.filter((n) => n.kind === 'ghost').length,
    },
  };
}

const memGraphCache = { t: 0, dir: '', data: null as MemoryGraph | null };

/** Walk ~/.claude/projects/<proj>/memory/*.md and synthesize the graph. Read-only, 30s cached (per dir). */
export async function collectMemoryGraph(now: number = Date.now()): Promise<MemoryGraph> {
  const dir = claudeDir();
  if (memGraphCache.data && memGraphCache.dir === dir && now - memGraphCache.t < 30_000) {
    return memGraphCache.data;
  }
  const root = path.join(dir, 'projects');
  let projDirs: string[] = [];
  try {
    projDirs = (await fsp.readdir(root, { withFileTypes: true }))
      .filter((d) => d.isDirectory())
      .map((d) => d.name);
  } catch {
    const empty: MemoryGraph = {
      ok: true,
      ts: new Date().toISOString(),
      nodes: [],
      edges: [],
      counts: { memory: 0, projects: 0, sessions: 0, ghosts: 0 },
    };
    return empty;
  }

  const notes: MemoryNodeRaw[] = [];
  for (const proj of projDirs) {
    const memDir = path.join(root, proj, 'memory');
    let names: string[];
    try {
      names = (await fsp.readdir(memDir)).filter((f) => f.endsWith('.md') && f !== 'MEMORY.md');
    } catch {
      continue;
    }
    for (const f of names) {
      let raw: string;
      try {
        raw = await fsp.readFile(path.join(memDir, f), 'utf8');
      } catch {
        continue;
      }
      notes.push({ proj, ...parseMemoryNote(raw, f) });
    }
  }

  const data = buildMemoryGraph(notes);
  memGraphCache.t = now;
  memGraphCache.dir = dir;
  memGraphCache.data = data;
  return data;
}

// ── per-note viewer ──────────────────────────────────────────────────────────

export interface MemoryNoteDetail {
  ok: boolean;
  project: string;
  slug: string;
  name: string;
  description: string;
  type: string;
  body: string;
  outlinks: string[];
  backlinks: string[];
}

/**
 * Read one memory note + compute its outlinks and same-project backlinks.
 * `project` and `slug` are client-supplied → strictly validated (charset only,
 * no separators) so this can never read outside projects/<proj>/memory/.
 */
export async function readNote(project: string, slug: string): Promise<MemoryNoteDetail | null> {
  if (!/^[A-Za-z0-9._-]+$/.test(project) || !/^[A-Za-z0-9._-]+$/.test(slug)) return null;
  const memDir = path.join(claudeDir(), 'projects', project, 'memory');
  const file = path.join(memDir, `${slug}.md`);
  let raw: string;
  try {
    raw = await fsp.readFile(file, 'utf8');
  } catch {
    return null;
  }
  const parsed = parseMemoryNote(raw, `${slug}.md`);
  const body = raw.replace(/\0/g, '').replace(/^---\r?\n[\s\S]*?\r?\n---/, '').trim();

  // Backlinks: same-project notes whose body links to this slug (exact or fuzzy).
  const target = normalizeSlug(slug);
  const backlinks: string[] = [];
  try {
    const names = (await fsp.readdir(memDir)).filter((f) => f.endsWith('.md') && f !== 'MEMORY.md' && f !== `${slug}.md`);
    for (const f of names) {
      let other: string;
      try {
        other = await fsp.readFile(path.join(memDir, f), 'utf8');
      } catch {
        continue;
      }
      const links = Array.from(other.replace(/\0/g, '').matchAll(/\[\[([^\]]+)\]\]/g)).map((m) =>
        normalizeSlug(m[1].trim()),
      );
      if (links.includes(target)) backlinks.push(f.replace(/\.md$/i, ''));
    }
  } catch {
    /* no backlinks */
  }

  return {
    ok: true,
    project,
    slug,
    name: parsed.slug,
    description: parsed.description,
    type: parsed.type,
    body,
    outlinks: parsed.links,
    backlinks,
  };
}

// ── log tails (byte-bounded — never slurp the multi-MB append-only logs) ──────

export type LogSource = 'monitor' | 'perf' | 'audit';

const LOG_FILES: Record<LogSource, { file: string; json: boolean }> = {
  monitor: { file: 'godmonitor.log', json: true },
  perf: { file: 'godmode-perf.log', json: true },
  audit: { file: 'hook-audit.log', json: false },
};

/** Split a tail buffer into the last `n` complete lines. `partialFirst` drops a
 *  leading half-line when the read started mid-file. Pure. */
export function splitTail(text: string, n: number, partialFirst: boolean): string[] {
  let lines = text.split(/\r?\n/);
  if (partialFirst && lines.length) lines = lines.slice(1);
  lines = lines.filter((l) => l.length > 0);
  return lines.slice(-n);
}

export interface LogResult {
  source: string;
  file: string;
  exists: boolean;
  count: number;
  lines: unknown[];
}

/**
 * Tail an allowlisted god log. `source` maps through a fixed table (never a
 * client path). Reads only the last window of bytes, so a 3 MB append-only log
 * is cheap and rotation-safe. `baseDir` selects the god state tree — native
 * ~/.claude by default; the embedded godclaude routes pass their own home.
 */
export async function tailLog(
  source: string,
  limit: number,
  baseDir: string = claudeDir(),
): Promise<LogResult | { error: string }> {
  const spec = LOG_FILES[source as LogSource];
  if (!spec) return { error: `unknown log source "${source}" (use monitor|perf|audit)` };
  const n = Math.max(1, Math.min(2000, Math.floor(limit) || 200));
  const file = path.join(baseDir, spec.file);

  let size = 0;
  try {
    size = (await fsp.stat(file)).size;
  } catch {
    return { source, file, exists: false, count: 0, lines: [] };
  }

  // Read a window sized to the request (bounded 64 KB .. 4 MB).
  const window = Math.min(size, Math.max(64 * 1024, Math.min(4 * 1024 * 1024, n * 600)));
  const start = size - window;
  let text = '';
  try {
    const fd = await fsp.open(file, 'r');
    try {
      const buf = Buffer.alloc(window);
      await fd.read(buf, 0, window, start);
      text = buf.toString('utf8');
    } finally {
      await fd.close();
    }
  } catch {
    return { source, file, exists: true, count: 0, lines: [] };
  }

  const rawLines = splitTail(text, n, start > 0);
  const lines = spec.json
    ? rawLines.map((l) => {
        try {
          return JSON.parse(l);
        } catch {
          return { raw: l };
        }
      })
    : rawLines.map((l) => ({ raw: l }));

  return { source, file, exists: true, count: lines.length, lines };
}

// ── combined status snapshot (the single feed the tab polls) ─────────────────

export interface ArgusStatus {
  ok: boolean;
  ts: string;
  godclaudeDetected: boolean;
  health: Record<string, unknown> | null;
  modes: Array<Record<string, unknown>>;
  activity: Record<string, { allow: number; block: number }>;
  heartbeats: Array<Record<string, unknown>>;
  routing: Record<string, unknown> | null;
  stats: GodStats | null;
  sessions: ArgusSessions;
  usage: Usage | null;
}

export async function collectStatus(narukamiIds?: ReadonlySet<string>): Promise<ArgusStatus> {
  const [snap, stats, sessions, usage] = await Promise.all([
    readSnapshot(),
    readStats(),
    collectSessions(Date.now(), narukamiIds),
    readUsage(),
  ]);
  return {
    ok: true,
    ts: new Date().toISOString(),
    godclaudeDetected: snap != null,
    health: snap?.health ?? null,
    modes: snap?.modes ?? [],
    activity: snap?.activity ?? {},
    heartbeats: snap?.heartbeats ?? [],
    routing: snap?.routing ?? null,
    stats,
    sessions,
    usage,
  };
}
