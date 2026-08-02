import fs from 'node:fs';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
// Cycle-safe: godclaude.ts imports collectSessions/readUsage from here, but both
// directions only dereference the binding INSIDE function bodies, never at
// module-evaluation time.
import { godClaudeDir } from './godclaude';

/**
 * Argus — read-only projection over the GODCLAUDE state tree under ~/.claude.
 * Everything here READS; nothing ever writes into ~/.claude.
 *
 * Sessions / usage / memory-graph are parsed off disk directly and fail-soft (a
 * bad or missing file yields a documented empty default, never throws). The
 * original plan's other half — shelling the native god `--json` CLIs for
 * health/gate/perf — was superseded by the EMBEDDED god layer
 * (services/godclaude.ts, which runs those CLIs against NARUKAMI's own home),
 * so the native shell-out path and its combined status snapshot were removed.
 *
 * The byte-bounded log tailer (`tailLog` + its allowlist and `splitTail` helper)
 * was removed too: it only ever fed the planned LogFeed panel, which was never
 * built on either the native or the embedded side, so both /api/argus/logs and
 * /api/godclaude/logs had zero clients.
 */

/** Root of the GODCLAUDE state tree. Overridable for tests. */
export function claudeDir(): string {
  return process.env.ARGUS_CLAUDE_DIR ?? path.join(os.homedir(), '.claude');
}

/**
 * godmode-stats.mjs --json → perf / gate aggregates / suggestions. The shape is
 * shared: services/godclaude.ts runs that CLI against the EMBEDDED home and
 * parses into this interface.
 */
export interface GodStats {
  perfSpan: { from: string; to: string } | null;
  dispatch: Record<string, number>;
  hookStats: Array<Record<string, unknown>>;
  gate: Record<string, unknown>;
  suggestions: string[];
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

/** Read one home's usage-live.json. Fail-soft: missing/torn/non-object → null. */
async function readUsageFile(dir: string): Promise<Usage | null> {
  try {
    const raw = await fsp.readFile(path.join(dir, 'usage-live.json'), 'utf8');
    const parsed: unknown = JSON.parse(raw);
    return parsed && typeof parsed === 'object' ? (parsed as Usage) : null;
  } catch {
    return null;
  }
}

/** `ts` for ordering; a file without a numeric ts sorts oldest but still counts. */
function usageTs(u: Usage): number {
  return typeof u.ts === 'number' ? u.ts : Number.NEGATIVE_INFINITY;
}

/**
 * Account rate-limit usage, merged across BOTH godclaude homes, newest `ts` wins.
 *
 * usage-live.json is written by the statusline hook into `${DET_HOOKS_HOME}/.claude`,
 * and NARUKAMI sets DET_HOOKS_HOME to its EMBEDDED god home (services/godclaude.ts
 * godSpawnEnv) on every pty, headless analyzer run and broker shell. So sessions
 * launched from NARUKAMI write ~/.narukami/godclaude/.claude/usage-live.json while
 * native `claude` terminals write ~/.claude/usage-live.json. Reading only the
 * native path froze the always-visible header meter (routes/vitals.ts) at whatever
 * the last NATIVE session left — observed a full day stale with different numbers.
 *
 * Fail-soft in both directions: if one side is missing or corrupt we return the
 * other, and only return null when NEITHER side yields a readable object.
 *
 * NOTE: this also changes the semantics of the native Argus panel, which used to
 * show strictly the native home's reading. That is intended — rate limits are
 * ACCOUNT-wide, not per-home, so the newest reading from either home is the truest
 * picture of the account regardless of which home's session produced it.
 */
export async function readUsage(): Promise<Usage | null> {
  // Deduped: a test/config where the two resolve to the same dir must not double-read.
  const dirs = Array.from(new Set([claudeDir(), godClaudeDir()]));
  const found = (await Promise.all(dirs.map(readUsageFile))).filter((u): u is Usage => u !== null);
  if (found.length === 0) return null;
  return found.reduce((best, u) => (usageTs(u) > usageTs(best) ? u : best));
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

/** Walk ~/.claude/projects/<proj>/memory/*.md and synthesize the graph. Read-only, 90s cached (per dir). */
export async function collectMemoryGraph(now: number = Date.now()): Promise<MemoryGraph> {
  const dir = claudeDir();
  // TTL must comfortably exceed the frontend's 30s poll — at exactly 30s every
  // poll missed and re-walked every project's memory dir for a graph that
  // changes a few times a day.
  if (memGraphCache.data && memGraphCache.dir === dir && now - memGraphCache.t < 90_000) {
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

