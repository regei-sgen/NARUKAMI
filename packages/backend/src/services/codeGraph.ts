import { execFile } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);

/**
 * Code Map — a structural knowledge graph of a project's codebase, produced by the
 * `codebase-memory-mcp` engine (a local, MIT-licensed static binary). Everything
 * here shells out to the engine's one-shot `cli` mode and reshapes its JSON into
 * the {nodes, edges} form the frontend globe already renders.
 *
 * Engine quirks (verified against v0.8.1, not the README):
 *   - Subcommands are `cli <tool> '<json>'` — there is NO `--raw` flag.
 *   - Query tools require a `project` arg (the engine's own name for the repo).
 *   - The CLI exits NON-ZERO on logical errors but still prints its JSON to stdout,
 *     and prefixes a `level=info msg=mem.init …` log line — so we recover stdout
 *     from the thrown error and parse from the first `{`.
 *
 * Nothing here mutates the user's repo; the engine writes only its own graph db
 * under ~/.cache/codebase-memory-mcp and a per-repo .codebase-memory/ artifact.
 */

const CLI_TIMEOUT_MS = 30_000;
const INDEX_TIMEOUT_MS = 8 * 60_000; // large repos can take minutes
const CLI_MAX_BUFFER = 128 * 1024 * 1024;
// No node cap: the whole graph is returned. The frontend picks the renderer by
// size — a 3D sphere (GraphGlobe) for small graphs, a flat 2D force graph
// (GraphFlat) once the node count grows past its own threshold.

function binName(): string {
  return process.platform === 'win32' ? 'codebase-memory-mcp.exe' : 'codebase-memory-mcp';
}

/**
 * Locate the engine binary. The official Windows installer drops it in
 * %LOCALAPPDATA%\Programs\codebase-memory-mcp; older docs used ~/.local/bin. An
 * env override wins. Returns an absolute path, or the bare name to defer to PATH.
 */
export function codeGraphBin(): string {
  const override = process.env.NARUKAMI_CBM_BIN;
  if (override && fs.existsSync(override)) return override;

  const candidates: string[] = [];
  const la = process.env.LOCALAPPDATA;
  if (la) candidates.push(path.join(la, 'Programs', 'codebase-memory-mcp', binName()));
  candidates.push(path.join(os.homedir(), '.local', 'bin', binName()));
  candidates.push(path.join(os.homedir(), '.local', 'share', 'codebase-memory-mcp', binName()));
  for (const c of candidates) if (fs.existsSync(c)) return c;
  return binName(); // fall back to PATH resolution
}

export function codeGraphBinInstalled(): boolean {
  const bin = codeGraphBin();
  return path.isAbsolute(bin) ? fs.existsSync(bin) : false;
}

/** The engine's own name for a repo: path segments joined by '-'. */
export function engineProjectName(absPath: string): string {
  return absPath.split(/[\\/:]+/).filter(Boolean).join('-');
}

/** Parse the engine's stdout, tolerating a leading `level=…` log line. */
function parseEngineJson(out: string): unknown {
  const brace = out.indexOf('{');
  const bracket = out.indexOf('[');
  let start = -1;
  if (brace >= 0 && (bracket < 0 || brace < bracket)) start = brace;
  else if (bracket >= 0) start = bracket;
  if (start < 0) return null;
  try {
    return JSON.parse(out.slice(start));
  } catch {
    return null;
  }
}

/**
 * Run one engine CLI subcommand. `args` is the tool's JSON payload object (or null).
 * Recovers stdout even when the engine exits non-zero. Returns parsed JSON + raw.
 */
export async function runCli(
  tool: string,
  args: Record<string, unknown> | null,
  opts: { timeout?: number } = {},
): Promise<{ json: unknown; raw: string }> {
  const bin = codeGraphBin();
  const argv = ['cli', tool];
  if (args) argv.push(JSON.stringify(args));

  let stdout = '';
  try {
    const res = await execFileAsync(bin, argv, {
      timeout: opts.timeout ?? CLI_TIMEOUT_MS,
      maxBuffer: CLI_MAX_BUFFER,
      windowsHide: true,
    });
    stdout = res.stdout ?? '';
  } catch (err) {
    const e = err as { stdout?: string };
    stdout = e.stdout ?? '';
    if (!stdout) throw err;
  }
  return { json: parseEngineJson(stdout), raw: stdout };
}

/** Engine presence + version. Never throws. */
export async function detectEngine(): Promise<{ installed: boolean; version: string | null }> {
  if (!codeGraphBinInstalled()) return { installed: false, version: null };
  try {
    const { stdout } = await execFileAsync(codeGraphBin(), ['--version'], {
      timeout: 10_000,
      windowsHide: true,
    });
    return { installed: true, version: stdout.trim() || 'unknown' };
  } catch {
    return { installed: true, version: null };
  }
}

/** Index a repo. Returns the engine's index result ({project, nodes, edges, …}). */
export async function indexProject(absPath: string): Promise<unknown> {
  const { json, raw } = await runCli('index_repository', { repo_path: absPath }, { timeout: INDEX_TIMEOUT_MS });
  return json ?? raw;
}

export interface CodeChanges {
  /** Git-dirty file paths (repo-relative, POSIX) — nodes on these light up. */
  changed: string[];
  /** The subset whose mtime updated within the last few seconds — nodes pulse. */
  ongoing: string[];
}

// A dirty file counts as "actively changing" for this long after each save.
const ONGOING_WINDOW_MS = 6_000;

/**
 * Which of the project's files are changing right now. Reads `git status`
 * (uncommitted = "changed") and compares mtimes (recently touched = "ongoing").
 * Read-only, fail-soft (a non-git dir yields empty sets).
 */
export async function getChanges(absPath: string): Promise<CodeChanges> {
  let out = '';
  try {
    const res = await execFileAsync('git', ['status', '--porcelain', '--untracked-files=all'], {
      cwd: absPath,
      timeout: 10_000,
      windowsHide: true,
      maxBuffer: 8 * 1024 * 1024,
    });
    out = res.stdout ?? '';
  } catch {
    return { changed: [], ongoing: [] };
  }

  const changed: string[] = [];
  for (const raw of out.split(/\r?\n/)) {
    if (!raw) continue;
    let p = raw.slice(3).trim(); // strip the 2-char XY status + space
    if (p.includes(' -> ')) p = p.slice(p.indexOf(' -> ') + 4).trim(); // rename: take the new path
    p = p.replace(/^"(.*)"$/, '$1'); // git quotes paths with odd chars
    if (p) changed.push(p.replace(/\\/g, '/'));
  }

  const now = Date.now();
  const ongoing: string[] = [];
  for (const rel of changed) {
    try {
      const st = fs.statSync(path.join(absPath, rel));
      if (now - st.mtimeMs < ONGOING_WINDOW_MS) ongoing.push(rel);
    } catch {
      // deleted / unreadable — not "ongoing"
    }
  }
  return { changed, ongoing };
}

export type CodeScope = 'files' | 'functions' | 'architecture';

export interface CodeGraphNode {
  id: string;
  kind: string;
  label: string;
  file?: string;
}
export interface CodeGraphEdge {
  source: string;
  target: string;
  kind: string;
}
export interface CodeGraph {
  ok: boolean;
  scope: CodeScope;
  nodes: CodeGraphNode[];
  edges: CodeGraphEdge[];
  counts: Record<string, number>;
  truncated: boolean;
}

export interface CodeNodeNeighbor {
  /** edge type, e.g. CALLS / DEFINES / IMPORTS */
  rel: string;
  dir: 'out' | 'in';
  id: string;
  label: string;
}
export interface CodeNodeDetail {
  id: string;
  kinds: string[];
  name: string | null;
  file: string | null;
  /** everything the engine stores on the node: signature, lines, complexity, flags… */
  props: Record<string, unknown>;
  neighbors: CodeNodeNeighbor[];
}

const NEIGHBOR_LIMIT = 30;

/**
 * qualified_names are dotted identifiers; they never legitimately contain a
 * quote or backslash. Stripping (rather than escaping — the mini-Cypher's escape
 * rules are undocumented) keeps the interpolated query injection-safe.
 */
export function safeQid(id: string): string {
  return id.replace(/['\\]/g, '');
}

/** labels(n) has come back both as an array and as a JSON-ish string — normalize. */
export function parseKinds(v: unknown): string[] {
  if (Array.isArray(v)) return v.map(String);
  if (typeof v === 'string') {
    try {
      const parsed = JSON.parse(v);
      if (Array.isArray(parsed)) return parsed.map(String);
    } catch {
      /* plain label string */
    }
    return v ? [v] : [];
  }
  return [];
}

/** properties(n) arrives as a JSON string (verified against v0.8.1). */
export function parseProps(v: unknown): Record<string, unknown> {
  if (v && typeof v === 'object') return v as Record<string, unknown>;
  if (typeof v === 'string') {
    try {
      const parsed = JSON.parse(v);
      if (parsed && typeof parsed === 'object') return parsed as Record<string, unknown>;
    } catch {
      /* fall through */
    }
  }
  return {};
}

/**
 * "Project not found / not indexed" is a logical error the engine prints to
 * stderr with EMPTY stdout, so runCli rethrows the raw execFile error (whose
 * message carries the full command line and stderr the machine-wide project
 * list — neither may reach a client).
 */
function isProjectMissingError(err: unknown): boolean {
  const e = err as { stderr?: unknown; message?: unknown } | null;
  const text = [e?.stderr, e?.message].filter((v): v is string => typeof v === 'string').join('\n');
  // Tolerate phrasing variants: "not found", "not indexed", "not been/yet indexed".
  return /\bnot\s+(?:\w+\s+)?(?:found|indexed)\b/i.test(text);
}

/**
 * Everything the engine knows about one node: labels, stored properties, and its
 * edges in both directions. Returns null when the id isn't in the graph (e.g.
 * the project was re-indexed since the frontend loaded its node list) or the
 * project itself was never indexed — the route's 404 covers both cleanly.
 */
export async function getNodeDetail(absPath: string, nodeId: string): Promise<CodeNodeDetail | null> {
  const project = engineProjectName(absPath);
  const qid = safeQid(nodeId);

  let main: { json: unknown };
  try {
    main = await runCli('query_graph', {
      query: `MATCH (n) WHERE n.qualified_name = '${qid}' RETURN labels(n), n.name, n.file_path, properties(n) LIMIT 1`,
      project,
    });
  } catch (err) {
    if (isProjectMissingError(err)) return null;
    throw err;
  }
  const rows = (main.json as { rows?: unknown[] } | null)?.rows;
  if (!Array.isArray(rows) || rows.length === 0 || !Array.isArray(rows[0])) return null;
  const [labelsVal, nameVal, fileVal, propsVal] = rows[0] as unknown[];

  const neighbors: CodeNodeNeighbor[] = [];
  const edgeQueries: Array<{ dir: 'out' | 'in'; query: string }> = [
    {
      dir: 'out',
      query: `MATCH (n)-[r]->(m) WHERE n.qualified_name = '${qid}' RETURN type(r), m.qualified_name, m.name LIMIT ${NEIGHBOR_LIMIT}`,
    },
    {
      dir: 'in',
      query: `MATCH (m)-[r]->(n) WHERE n.qualified_name = '${qid}' RETURN type(r), m.qualified_name, m.name LIMIT ${NEIGHBOR_LIMIT}`,
    },
  ];
  for (const { dir, query } of edgeQueries) {
    try {
      const res = await runCli('query_graph', { query, project });
      const eRows = (res.json as { rows?: unknown[] } | null)?.rows;
      if (!Array.isArray(eRows)) continue;
      for (const row of eRows) {
        if (!Array.isArray(row) || row.length < 2) continue;
        const id = String(row[1] ?? '');
        if (!id) continue;
        neighbors.push({ rel: String(row[0] ?? ''), dir, id, label: row[2] ? String(row[2]) : id });
      }
    } catch {
      // neighbors are best-effort; the node body still renders
    }
  }

  return {
    id: nodeId,
    kinds: parseKinds(labelsVal),
    name: nameVal != null ? String(nameVal) : null,
    file: fileVal != null ? String(fileVal) : null,
    props: parseProps(propsVal),
    neighbors,
  };
}

// Node labels surfaced per scope (level-of-detail). These are the engine's REAL
// labels (verified via get_architecture): Function/Variable/File/Module/Interface/
// Section/Route/Folder/Class/Method/Type/Channel/Project.
const SCOPE_LABELS: Record<CodeScope, string[]> = {
  files: ['Folder', 'File', 'Module'],
  functions: ['File', 'Class', 'Function', 'Method', 'Interface', 'Type'],
  architecture: ['Project', 'Folder', 'Module', 'Route'],
};

/**
 * Build the code graph for a project at a level-of-detail: pull each scope label's
 * nodes, then the edges among them — both via query_graph (Cypher). The full node
 * set is returned UNCAPPED. (search_graph is deliberately NOT used: it silently
 * hard-caps at 200 results per label — an engine default with no override param —
 * which truncated large scopes; query_graph's MATCH has no such cap.)
 */
export async function getProjectGraph(absPath: string, scope: CodeScope): Promise<CodeGraph> {
  const project = engineProjectName(absPath);
  const labels = SCOPE_LABELS[scope];

  const nodes: CodeGraphNode[] = [];
  const seen = new Set<string>();
  // One Cypher query per label returns EVERY node of that label. Labels come from
  // the SCOPE_LABELS constant (never user input), so interpolation is injection-safe.
  for (const label of labels) {
    let res: { json: unknown };
    try {
      res = await runCli('query_graph', {
        query: `MATCH (n:${label}) RETURN n.qualified_name, n.name, n.file_path`,
        project,
      });
    } catch {
      continue;
    }
    const rows = (res.json as { rows?: unknown[] } | null)?.rows;
    if (!Array.isArray(rows)) continue;
    for (const row of rows) {
      if (!Array.isArray(row)) continue;
      const id = String(row[0] ?? '');
      if (!id || seen.has(id)) continue;
      seen.add(id);
      nodes.push({
        id,
        kind: label,
        label: row[1] ? String(row[1]) : id,
        file: row[2] ? String(row[2]) : undefined,
      });
    }
  }
  // Retained in the payload for API stability; nothing is capped, so it is always false.
  const truncated = false;

  // Edges among the kept nodes. query_graph returns {columns, rows}; each row is
  // [a.qualified_name, type(r), b.qualified_name].
  const edges: CodeGraphEdge[] = [];
  try {
    const q = 'MATCH (a)-[r]->(b) RETURN a.qualified_name, type(r), b.qualified_name LIMIT 4000';
    const res = await runCli('query_graph', { query: q, project });
    const rows = (res.json as { rows?: unknown[] } | null)?.rows;
    if (Array.isArray(rows)) {
      for (const row of rows) {
        if (!Array.isArray(row) || row.length < 3) continue;
        const a = String(row[0]);
        const rel = String(row[1]);
        const b = String(row[2]);
        if (seen.has(a) && seen.has(b)) edges.push({ source: a, target: b, kind: rel });
      }
    }
  } catch {
    // edges are best-effort; a graph with nodes but no edges still renders
  }

  const counts: Record<string, number> = {};
  for (const n of nodes) counts[n.kind] = (counts[n.kind] ?? 0) + 1;

  return { ok: true, scope, nodes, edges, counts, truncated };
}
