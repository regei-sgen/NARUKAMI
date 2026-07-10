import fs from 'node:fs';
import path from 'node:path';
import { claudeDir, decodeProjectDir } from './argus';
import { gitCommitsForDay } from './gitLog';

/**
 * EOD activity detection — which projects were ACTIVE on a given day, unioned
 * across three signals:
 *   1. Claude sessions (BOTH native CLI and NARUKAMI-spawned) — transcripts under
 *      ~/.claude/projects/<encoded-cwd>/<session>.jsonl, filtered by mtime.
 *   2. NARUKAMI runs that day (passed in from the DB by the route).
 *   3. git commits authored that day.
 * Read-only, fail-soft. The real cwd of each session is read from the transcript
 * (its `cwd` field) so non-registered projects resolve to a real path for git.
 */

export interface ActiveProject {
  name: string;
  path: string;
  registered: boolean;
  projectId: string | null;
  sessions: number; // Claude session transcripts active that day (native + NARUKAMI)
  runs: number; // NARUKAMI runs that day
  commits: number; // git commits that day
}

export interface RegisteredProject {
  id: string;
  name: string;
  path: string;
}

/** Normalize a path for cross-source matching: forward slashes, no trailing slash, lowercased. */
export function normPath(p: string): string {
  return String(p || '')
    .replace(/\\/g, '/')
    .replace(/\/+$/, '')
    .toLowerCase();
}

/** Prettify a cwd into a display name (last path segment). */
export function prettyName(cwd: string): string {
  return (
    String(cwd || '')
      .replace(/\\/g, '/')
      .replace(/\/+$/, '')
      .split('/')
      .filter(Boolean)
      .pop() || cwd
  );
}

/**
 * Read the real `cwd` from a transcript. Claude Code's FIRST jsonl line is often
 * a meta/summary line with no `cwd`, so we scan the head of each file for the
 * first entry that carries one (the lossy dir-name decode is only a last resort,
 * because it mis-splits names with hyphens/dots — e.g. dashboard.sgen.com → com).
 */
function sessionRealCwd(dirPath: string, files: string[]): string | null {
  for (const f of files) {
    try {
      const fd = fs.openSync(path.join(dirPath, f), 'r');
      const buf = Buffer.alloc(65536);
      const n = fs.readSync(fd, buf, 0, 65536, 0);
      fs.closeSync(fd);
      for (const line of buf.toString('utf8', 0, n).split('\n')) {
        if (!line.includes('"cwd"')) continue;
        try {
          const obj = JSON.parse(line) as { cwd?: unknown };
          if (obj && typeof obj.cwd === 'string' && obj.cwd) return obj.cwd;
        } catch {
          // partial/truncated last line — keep scanning
        }
      }
    } catch {
      // try next file
    }
  }
  return null;
}

/**
 * Map of normalized-cwd → { cwd, count } for Claude session transcripts whose
 * mtime falls in [start, end). Both native-CLI and NARUKAMI sessions write here.
 */
export function claudeSessionActivity(start: Date, end: Date): Map<string, { cwd: string; count: number }> {
  const out = new Map<string, { cwd: string; count: number }>();
  const root = path.join(claudeDir(), 'projects');
  let dirs: string[];
  try {
    dirs = fs.readdirSync(root, { withFileTypes: true }).filter((d) => d.isDirectory()).map((d) => d.name);
  } catch {
    return out;
  }
  const s = start.getTime();
  const e = end.getTime();
  for (const dir of dirs) {
    const dirPath = path.join(root, dir);
    let files: string[];
    try {
      files = fs.readdirSync(dirPath).filter((f) => f.endsWith('.jsonl'));
    } catch {
      continue;
    }
    let count = 0;
    for (const f of files) {
      try {
        const mt = fs.statSync(path.join(dirPath, f)).mtimeMs;
        if (mt >= s && mt < e) count += 1;
      } catch {
        // skip unreadable transcript
      }
    }
    if (count === 0) continue;
    // Prefer the transcript's real cwd; fall back to the (lossy) decoded dir name.
    const cwd = sessionRealCwd(dirPath, files) ?? decodeProjectDir(dir);
    out.set(normPath(cwd), { cwd, count });
  }
  return out;
}

/**
 * Extract the developer's real prompts (the tasks they asked) from a transcript.
 * These give the report real content for commit-less projects instead of a bare
 * session count. Skips tool-result messages, slash-commands, and injected markers.
 */
function extractUserPrompts(file: string, out: string[], cap: number): void {
  let text: string;
  try {
    const fd = fs.openSync(file, 'r');
    const buf = Buffer.alloc(1024 * 1024);
    const n = fs.readSync(fd, buf, 0, buf.length, 0);
    fs.closeSync(fd);
    text = buf.toString('utf8', 0, n);
  } catch {
    return;
  }
  for (const line of text.split('\n')) {
    if (out.length >= cap) return;
    if (!line.includes('"type":"user"')) continue;
    let o: { type?: string; message?: { content?: unknown } };
    try {
      o = JSON.parse(line);
    } catch {
      continue;
    }
    if (o.type !== 'user' || !o.message) continue;
    const c = o.message.content;
    let t = '';
    if (typeof c === 'string') t = c;
    else if (Array.isArray(c)) {
      const block = c.find(
        (x): x is { type: string; text: string } =>
          !!x && typeof x === 'object' && (x as { type?: unknown }).type === 'text' && typeof (x as { text?: unknown }).text === 'string',
      );
      if (block) t = block.text;
    }
    t = t.trim();
    // Drop tool-results (no text), slash-commands, injected xml/markers, and noise.
    if (!t || t.length < 8 || t.startsWith('/') || t.startsWith('<')) continue;
    out.push(t.replace(/\s+/g, ' ').slice(0, 220));
  }
}

/**
 * cwd → the developer's session context (their prompts) for transcripts active in
 * [start, end). Feeds the report so commit-less projects get real bullets.
 */
export function collectSessionContext(start: Date, end: Date, maxPerProject = 2600): Map<string, string> {
  const out = new Map<string, string>();
  const root = path.join(claudeDir(), 'projects');
  let dirs: string[];
  try {
    dirs = fs.readdirSync(root, { withFileTypes: true }).filter((d) => d.isDirectory()).map((d) => d.name);
  } catch {
    return out;
  }
  const s = start.getTime();
  const e = end.getTime();
  for (const dir of dirs) {
    const dirPath = path.join(root, dir);
    let files: string[];
    try {
      files = fs.readdirSync(dirPath).filter((f) => f.endsWith('.jsonl'));
    } catch {
      continue;
    }
    const active = files.filter((f) => {
      try {
        const mt = fs.statSync(path.join(dirPath, f)).mtimeMs;
        return mt >= s && mt < e;
      } catch {
        return false;
      }
    });
    if (active.length === 0) continue;
    const cwd = sessionRealCwd(dirPath, active) ?? decodeProjectDir(dir);
    const prompts: string[] = [];
    for (const f of active) {
      extractUserPrompts(path.join(dirPath, f), prompts, 10);
    }
    if (prompts.length === 0) continue;
    const text = prompts.map((p) => `- ${p}`).join('\n').slice(0, maxPerProject);
    const key = normPath(cwd);
    out.set(key, out.has(key) ? `${out.get(key)}\n${text}`.slice(0, maxPerProject) : text);
  }
  return out;
}

/**
 * Assemble the active-project list for a day. Seeds registered projects (for
 * their names), folds in session + run activity, then attaches git commit counts,
 * and keeps only projects with ANY activity that day. Sorted by activity volume.
 */
export async function collectActiveProjects(opts: {
  registered: RegisteredProject[];
  runsByPath: Map<string, number>;
  start: Date;
  end: Date;
}): Promise<ActiveProject[]> {
  const map = new Map<string, ActiveProject>();
  const ensure = (cwd: string, name: string): ActiveProject => {
    const key = normPath(cwd);
    let ap = map.get(key);
    if (!ap) {
      ap = { name, path: cwd, registered: false, projectId: null, sessions: 0, runs: 0, commits: 0 };
      map.set(key, ap);
    }
    return ap;
  };

  // Registered projects (authoritative name + path).
  for (const r of opts.registered) {
    const ap = ensure(r.path, r.name);
    ap.registered = true;
    ap.projectId = r.id;
    ap.name = r.name;
    ap.path = r.path;
  }

  // Claude session activity (native + NARUKAMI).
  for (const { cwd, count } of claudeSessionActivity(opts.start, opts.end).values()) {
    const existing = map.get(normPath(cwd));
    const ap = existing ?? ensure(cwd, prettyName(cwd));
    ap.sessions += count;
  }

  // NARUKAMI runs that day (keyed by normalized project path).
  for (const [key, count] of opts.runsByPath) {
    const ap = map.get(key);
    if (ap) ap.runs += count;
  }

  // git commits per candidate, then keep only projects with real activity.
  const result: ActiveProject[] = [];
  for (const ap of map.values()) {
    try {
      const commits = await gitCommitsForDay(ap.path, opts.start, opts.end);
      ap.commits = commits.length;
    } catch {
      ap.commits = 0;
    }
    if (ap.sessions > 0 || ap.runs > 0 || ap.commits > 0) result.push(ap);
  }

  result.sort((a, b) => b.commits + b.sessions + b.runs - (a.commits + a.sessions + a.runs) || a.name.localeCompare(b.name));
  return result;
}
