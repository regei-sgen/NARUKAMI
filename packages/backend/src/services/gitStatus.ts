import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);

const GIT_TIMEOUT_MS = 10_000;
const MAX_STATUS_FILES = 5000; // bound the tree-decoration payload on a huge working tree
const GIT_MAX_BUFFER = 64 * 1024 * 1024; // tolerate a large `status`/`diff` before rejecting

// A file's working-tree state relative to the last commit — collapsed to the
// three buckets the editor cares about (green add / amber modify / red delete).
export type GitChange = 'added' | 'modified' | 'deleted';

export interface GitFileStatus {
  path: string; // project-relative, POSIX separators
  status: GitChange;
}

export interface GitStatusResult {
  isRepo: boolean;
  files: GitFileStatus[];
}

// One contiguous run of changed lines in a file (1-based, inclusive), keyed to
// the NEW (working-tree) side of the diff so it maps straight onto editor lines.
export interface DiffRange {
  start: number;
  end: number;
  type: GitChange;
}

export interface GitDiffResult {
  isRepo: boolean;
  tracked: boolean; // false → untracked file; caller treats the whole file as added
  ranges: DiffRange[];
}

// ── near-invariant fact caches ───────────────────────────────────────────────
// The editor polls /git/status and /git/diff every ~3s; before these caches
// each tick paid 3 extra git.exe spawns (rev-parse --show-prefix, rev-parse
// --is-inside-work-tree, ls-files) re-verifying facts that essentially never
// change: whether the project is a repo, its prefix inside it, and whether the
// open file is tracked. Windows process creation is the expensive part, so the
// steady-state poll now costs 1 spawn (status) + 1 (diff) instead of 5.
// TTL-bounded so the rare real transitions (repo created/deleted, `git add` of
// an open untracked file, a nested .git appearing) surface within seconds —
// all consumers are visual decorations, never correctness.
const FACT_TTL_MS = 15_000;
const FACT_CACHE_MAX = 1000; // safety bound; one tracked entry per opened file

interface FactEntry<T> {
  v: T;
  at: number;
}
const prefixCache = new Map<string, FactEntry<string>>(); // projectPath → show-prefix
const trackedCache = new Map<string, FactEntry<boolean>>(); // projectPath\0relPath → tracked

function factGet<T>(map: Map<string, FactEntry<T>>, key: string, now: number): T | null {
  const hit = map.get(key);
  return hit && now - hit.at < FACT_TTL_MS ? hit.v : null;
}

function factSet<T>(map: Map<string, FactEntry<T>>, key: string, v: T, at: number): void {
  if (map.size >= FACT_CACHE_MAX) map.clear();
  map.set(key, { v, at });
}

/** Drop all cached repo facts (tests / explicit invalidation). */
export function clearGitFactCaches(): void {
  prefixCache.clear();
  trackedCache.clear();
}

async function git(projectPath: string, args: string[]): Promise<string> {
  const { stdout } = await execFileAsync('git', ['-C', projectPath, ...args], {
    timeout: GIT_TIMEOUT_MS,
    windowsHide: true,
    maxBuffer: GIT_MAX_BUFFER,
    // Treat every pathspec literally: neutralizes git magic (`:/`, `:(top)`, `:!`)
    // so a caller-supplied path can't escape the project dir into the wider repo.
    env: { ...process.env, GIT_LITERAL_PATHSPECS: '1' },
  });
  return stdout;
}

/** True when a git failure is "HEAD doesn't resolve" (unborn branch / no commits). */
export function isUnbornHead(err: unknown): boolean {
  const msg = String(
    (err as { stderr?: string })?.stderr ?? (err as Error)?.message ?? '',
  );
  return /unknown revision|bad revision|ambiguous argument '?HEAD'?|bad default revision/i.test(msg);
}

/**
 * Collapse a porcelain XY status pair to one display bucket. X is the index
 * (staged) state, Y the working-tree state; a file counts as changed if either
 * side moved. Untracked is reported as `??` (X === '?').
 */
function classify(x: string, y: string): GitChange {
  if (x === '?') return 'added'; // untracked (??)
  if (x === 'D' || y === 'D') return 'deleted';
  if (x === 'A' || y === 'A') return 'added';
  return 'modified'; // M, R, C, T, U, …
}

/**
 * Parse `git status --porcelain=v1 -z --untracked-files=all`. Pure (no I/O) so
 * it can be unit-tested against captured git output.
 *
 * With `-z` each record is NUL-terminated and paths are never quoted. A record
 * is `XY<space>PATH`; for a rename/copy (X is R/C) the original path follows as
 * its own NUL field, which we skip (only the new path is highlighted).
 */
export function parseStatus(raw: string): GitFileStatus[] {
  const tokens = raw.split('\0');
  const out: GitFileStatus[] = [];

  for (let i = 0; i < tokens.length; i += 1) {
    const rec = tokens[i];
    if (!rec || rec.length < 4) continue; // trailing empty / malformed
    const x = rec[0];
    const y = rec[1];
    const filePath = rec.slice(3); // skip "XY " (2 status chars + separator space)

    // Rename/copy records carry the original path as the next NUL field — drop it.
    if (x === 'R' || x === 'C') i += 1;

    if (!filePath) continue;
    out.push({ path: filePath, status: classify(x, y) });
  }

  return out;
}

/**
 * Parse `git diff -U0` hunk headers into changed line ranges on the new side.
 * Pure (no I/O). Header shape: `@@ -oldStart[,oldCount] +newStart[,newCount] @@`.
 *  - newCount 0  → a pure deletion (nothing on the new side): mark one line.
 *  - oldCount 0  → a pure addition: `added`.
 *  - otherwise   → lines replaced: `modified`.
 */
export function parseDiffRanges(raw: string): DiffRange[] {
  const ranges: DiffRange[] = [];
  const re = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/gm;
  let m: RegExpExecArray | null;

  while ((m = re.exec(raw)) !== null) {
    const oldCount = m[2] === undefined ? 1 : Number(m[2]);
    const newStart = Number(m[3]);
    const newCount = m[4] === undefined ? 1 : Number(m[4]);

    if (newCount === 0) {
      const line = Math.max(1, newStart);
      ranges.push({ start: line, end: line, type: 'deleted' });
    } else {
      ranges.push({
        start: newStart,
        end: newStart + newCount - 1,
        type: oldCount === 0 ? 'added' : 'modified',
      });
    }
  }

  return ranges;
}

/**
 * Working-tree status for every changed file, project-relative. Returns
 * `{ isRepo:false }` if the path isn't a git repo (or git is missing) — status
 * is a decoration, never fatal.
 *
 * When the project is a *subdirectory* of a larger repo, git reports paths from
 * the repo root; we strip the cwd prefix (from `rev-parse --show-prefix`) and
 * drop changes outside the project so the paths line up with the file tree.
 */
export async function gitStatus(projectPath: string): Promise<GitStatusResult> {
  const now = Date.now();
  let prefix = factGet(prefixCache, projectPath, now);
  const fromCache = prefix !== null;
  if (prefix === null) {
    try {
      // Doubles as the repo check: throws outside a work tree.
      prefix = (await git(projectPath, ['rev-parse', '--show-prefix'])).trim();
      factSet(prefixCache, projectPath, prefix, now);
    } catch {
      prefixCache.delete(projectPath);
      return { isRepo: false, files: [] };
    }
  }

  let raw: string;
  try {
    raw = await git(projectPath, [
      'status',
      '--porcelain=v1',
      '-z',
      '--untracked-files=all',
    ]);
  } catch {
    // A cached prefix may be the stale fact here (repo deleted / re-rooted
    // since it was learned) — drop it and redo the tick from scratch so the
    // isRepo answer stays truthful. A fresh-prefix failure is a plain status
    // error (huge tree timeout etc.): report "repo, no data" as before.
    prefixCache.delete(projectPath);
    if (fromCache) return gitStatus(projectPath);
    return { isRepo: true, files: [] };
  }

  // Filter to the project subtree FIRST, then cap — so a flood of changes in a
  // sibling directory of a monorepo can't truncate away the project's own files.
  const files = parseStatus(raw)
    .filter((f) => !prefix || f.path.startsWith(prefix))
    .map((f) => ({ path: prefix ? f.path.slice(prefix.length) : f.path, status: f.status }))
    .slice(0, MAX_STATUS_FILES);

  return { isRepo: true, files };
}

/**
 * Changed line ranges for one file (project-relative path). The pathspec is
 * resolved relative to the project dir (`-C`), so it lines up with the tree even
 * when the project is nested inside a bigger repo. Diffs against HEAD so both
 * staged and unstaged edits show; falls back to the index on an unborn branch.
 */
export async function gitDiffRanges(
  projectPath: string,
  relPath: string,
): Promise<GitDiffResult> {
  const now = Date.now();
  // Repo-ness rides the same cache as gitStatus's prefix (the status poll fills
  // it every tick, and any non-null prefix entry proves we're in a work tree).
  if (factGet(prefixCache, projectPath, now) === null) {
    try {
      const prefix = (await git(projectPath, ['rev-parse', '--show-prefix'])).trim();
      factSet(prefixCache, projectPath, prefix, now);
    } catch {
      prefixCache.delete(projectPath);
      return { isRepo: false, tracked: false, ranges: [] };
    }
  }

  const trackedKey = `${projectPath}\0${relPath}`;
  let tracked = factGet(trackedCache, trackedKey, now);
  if (tracked === null) {
    tracked = true;
    try {
      await git(projectPath, ['ls-files', '--error-unmatch', '--', relPath]);
    } catch {
      tracked = false;
    }
    factSet(trackedCache, trackedKey, tracked, now);
  }
  if (!tracked) return { isRepo: true, tracked: false, ranges: [] };

  let raw = '';
  try {
    raw = await git(projectPath, ['diff', '-U0', 'HEAD', '--', relPath]);
  } catch (err) {
    // Only an unborn branch (no HEAD) warrants a fallback; a maxBuffer/timeout
    // failure must NOT be misread as unborn (the fallback would fail the same
    // way and silently hide a real diff) — leave ranges empty in that case.
    if (isUnbornHead(err)) {
      // No HEAD yet → compare the index against the empty tree so a staged new
      // file still shows its added lines (plain `git diff` would be empty).
      try {
        raw = await git(projectPath, ['diff', '-U0', '--cached', '--', relPath]);
      } catch {
        raw = '';
      }
    }
  }

  return { isRepo: true, tracked: true, ranges: parseDiffRanges(raw) };
}
