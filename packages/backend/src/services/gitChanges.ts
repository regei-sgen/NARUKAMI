import { execFile } from 'node:child_process';
import fs from 'node:fs/promises';
import path from 'node:path';
import { promisify } from 'node:util';
import { currentBranch } from './gitEditor';

const execFileAsync = promisify(execFile);
const GIT_TIMEOUT_MS = 10_000;
const GIT_MAX_BUFFER = 64 * 1024 * 1024;
const MAX_STATUS_FILES = 5000;

export type GitChangeType = 'added' | 'modified' | 'deleted' | 'renamed' | 'untracked';

export interface GitChangeEntry {
  path: string; // project-relative, POSIX separators
  type: GitChangeType;
  staged: boolean;
}

export interface GitChangesResult {
  isRepo: boolean;
  branch: string | null;
  detached: boolean;
  staged: GitChangeEntry[];
  unstaged: GitChangeEntry[];
  conflicts: GitChangeEntry[];
}

/**
 * Parse `git status --porcelain=v1 -z --untracked-files=all`, preserving BOTH
 * status columns (X = index, Y = worktree). Pure (no I/O). Each `-z` record is
 * `XY<space>PATH`; a rename/copy (X is R/C) carries the original path as the
 * next NUL field, which is skipped (only the new path is reported).
 */
export function parseStatusFull(raw: string): Array<{ x: string; y: string; path: string }> {
  const tokens = raw.split('\0');
  const out: Array<{ x: string; y: string; path: string }> = [];
  for (let i = 0; i < tokens.length; i += 1) {
    const rec = tokens[i];
    if (!rec || rec.length < 4) continue;
    const x = rec[0];
    const y = rec[1];
    const filePath = rec.slice(3);
    if (x === 'R' || x === 'C') i += 1; // skip the original-path NUL field
    if (!filePath) continue;
    out.push({ x, y, path: filePath });
  }
  return out;
}

function isConflict(x: string, y: string): boolean {
  return x === 'U' || y === 'U' || (x === 'D' && y === 'D') || (x === 'A' && y === 'A');
}

function typeFor(col: string): GitChangeType {
  if (col === '?') return 'untracked';
  if (col === 'A') return 'added';
  if (col === 'D') return 'deleted';
  if (col === 'R' || col === 'C') return 'renamed';
  return 'modified'; // M, T, and anything else that moved
}

/**
 * Bucket parsed status rows into staged / unstaged / conflicts. `prefix` (from
 * `git rev-parse --show-prefix`) is stripped so paths line up with the project
 * subtree; rows outside the subtree are dropped. A file can appear in BOTH
 * staged and unstaged (e.g. `MM`) — matching VS Code.
 */
export function bucketChanges(
  entries: Array<{ x: string; y: string; path: string }>,
  prefix: string,
): Pick<GitChangesResult, 'staged' | 'unstaged' | 'conflicts'> {
  const staged: GitChangeEntry[] = [];
  const unstaged: GitChangeEntry[] = [];
  const conflicts: GitChangeEntry[] = [];

  for (const { x, y, path: p } of entries) {
    if (prefix && !p.startsWith(prefix)) continue;
    const rel = prefix ? p.slice(prefix.length) : p;
    if (!rel) continue;

    if (isConflict(x, y)) {
      conflicts.push({ path: rel, type: 'modified', staged: false });
      continue;
    }
    if (x !== ' ' && x !== '?') {
      staged.push({ path: rel, type: typeFor(x), staged: true });
    }
    if (x === '?') {
      unstaged.push({ path: rel, type: 'untracked', staged: false });
    } else if (y !== ' ') {
      unstaged.push({ path: rel, type: typeFor(y), staged: false });
    }
  }

  return { staged, unstaged, conflicts };
}

async function git(projectPath: string, args: string[]): Promise<string> {
  const { stdout } = await execFileAsync('git', ['-C', projectPath, ...args], {
    timeout: GIT_TIMEOUT_MS,
    windowsHide: true,
    maxBuffer: GIT_MAX_BUFFER,
    env: { ...process.env, GIT_LITERAL_PATHSPECS: '1' },
  });
  return stdout;
}

/** True when a git failure is "HEAD doesn't resolve" (unborn branch / no commits). */
function isUnborn(err: unknown): boolean {
  const msg = String((err as { stderr?: string })?.stderr ?? (err as Error)?.message ?? '');
  return /unknown revision|bad revision|ambiguous argument '?HEAD'?|does not have any commits/i.test(msg);
}

/** Full source-control snapshot: branch + staged/unstaged/conflict buckets. Fail-soft. */
export async function gitSourceControl(projectPath: string): Promise<GitChangesResult> {
  let prefix: string;
  try {
    prefix = (await git(projectPath, ['rev-parse', '--show-prefix'])).trim();
  } catch {
    return { isRepo: false, branch: null, detached: false, staged: [], unstaged: [], conflicts: [] };
  }

  const { branch, detached } = await currentBranch(projectPath);

  let raw = '';
  try {
    raw = await git(projectPath, ['status', '--porcelain=v1', '-z', '--untracked-files=all']);
  } catch {
    return { isRepo: true, branch, detached, staged: [], unstaged: [], conflicts: [] };
  }

  const { staged, unstaged, conflicts } = bucketChanges(parseStatusFull(raw), prefix);
  return {
    isRepo: true,
    branch,
    detached,
    staged: staged.slice(0, MAX_STATUS_FILES),
    unstaged: unstaged.slice(0, MAX_STATUS_FILES),
    conflicts: conflicts.slice(0, MAX_STATUS_FILES),
  };
}

export async function stagePath(projectPath: string, relPath: string): Promise<void> {
  await git(projectPath, ['add', '--', relPath]);
}

export async function unstagePath(projectPath: string, relPath: string): Promise<void> {
  try {
    await git(projectPath, ['restore', '--staged', '--', relPath]);
  } catch (err) {
    if (isUnborn(err)) {
      await git(projectPath, ['rm', '--cached', '--quiet', '--', relPath]);
    } else {
      throw err;
    }
  }
}

export async function discardPath(projectPath: string, relPath: string, untracked: boolean): Promise<void> {
  if (untracked) {
    // Delete the untracked file from disk (path already validated by the route).
    await fs.rm(path.join(projectPath, relPath), { force: true });
    return;
  }
  await git(projectPath, ['restore', '--', relPath]);
}

export async function commitStaged(projectPath: string, message: string): Promise<string> {
  await git(projectPath, ['commit', '-m', message]);
  return (await git(projectPath, ['rev-parse', '--short', 'HEAD'])).trim();
}

export async function stageAll(projectPath: string): Promise<void> {
  await git(projectPath, ['add', '-A', '--', '.']);
}

export async function unstageAll(projectPath: string): Promise<void> {
  try {
    await git(projectPath, ['reset', '-q', '--', '.']);
  } catch (err) {
    if (isUnborn(err)) {
      await git(projectPath, ['rm', '-r', '--cached', '--quiet', '--', '.']);
    } else {
      throw err;
    }
  }
}
