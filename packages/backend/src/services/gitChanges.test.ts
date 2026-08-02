import { afterEach, beforeEach, describe, it, expect, vi } from 'vitest';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { parseStatusFull, bucketChanges, gitSourceControl } from './gitChanges';

// Record every git argv while still running the real git — the source-control
// panel polls, so what matters is HOW MANY child processes a repeated call spawns.
const hoisted = vi.hoisted(() => ({ argv: [] as string[][] }));
vi.mock('node:child_process', async () => {
  const actual = await vi.importActual<typeof import('node:child_process')>('node:child_process');
  const { promisify } = await import('node:util');
  const realAsync = promisify(actual.execFile);
  const execFile = ((...args: unknown[]) =>
    (actual.execFile as (...a: unknown[]) => unknown)(...args)) as unknown as Record<symbol, unknown>;
  execFile[promisify.custom as unknown as symbol] = (file: string, args: string[], opts: object) => {
    hoisted.argv.push(args);
    return (realAsync as (f: string, a: string[], o: object) => Promise<{ stdout: string }>)(file, args, opts);
  };
  return { ...actual, execFile };
});

function countArgv(match: (args: string[]) => boolean): number {
  return hoisted.argv.filter(match).length;
}
const isShowPrefix = (args: string[]) => args.includes('rev-parse') && args.includes('--show-prefix');
const isStatus = (args: string[]) => args.includes('status');

// Build a NUL-terminated porcelain -z stream from raw records.
function z(...records: string[]): string {
  return records.map((r) => `${r}\0`).join('');
}

describe('parseStatusFull', () => {
  it('preserves both porcelain columns and the path', () => {
    const raw = z('MM src/a.ts', '?? new.ts', 'A  src/b.ts', ' D src/c.ts');
    expect(parseStatusFull(raw)).toEqual([
      { x: 'M', y: 'M', path: 'src/a.ts' },
      { x: '?', y: '?', path: 'new.ts' },
      { x: 'A', y: ' ', path: 'src/b.ts' },
      { x: ' ', y: 'D', path: 'src/c.ts' },
    ]);
  });

  it('reads a rename new-path and skips the original NUL field', () => {
    const raw = z('R  src/new.ts', 'src/old.ts', ' M src/keep.ts');
    expect(parseStatusFull(raw)).toEqual([
      { x: 'R', y: ' ', path: 'src/new.ts' },
      { x: ' ', y: 'M', path: 'src/keep.ts' },
    ]);
  });

  it('returns [] for empty input', () => {
    expect(parseStatusFull('')).toEqual([]);
  });
});

describe('bucketChanges', () => {
  it('splits staged, unstaged, and both (MM appears twice)', () => {
    const entries = parseStatusFull(z('M  s.ts', ' M w.ts', 'MM b.ts', '?? n.ts'));
    const r = bucketChanges(entries, '');
    expect(r.staged).toEqual([
      { path: 's.ts', type: 'modified', staged: true },
      { path: 'b.ts', type: 'modified', staged: true },
    ]);
    expect(r.unstaged).toEqual([
      { path: 'w.ts', type: 'modified', staged: false },
      { path: 'b.ts', type: 'modified', staged: false },
      { path: 'n.ts', type: 'untracked', staged: false },
    ]);
    expect(r.conflicts).toEqual([]);
  });

  it('derives type from the correct column (staged add, worktree delete)', () => {
    const r = bucketChanges(parseStatusFull(z('A  add.ts', ' D del.ts', 'D  stagedel.ts')), '');
    expect(r.staged).toEqual([
      { path: 'add.ts', type: 'added', staged: true },
      { path: 'stagedel.ts', type: 'deleted', staged: true },
    ]);
    expect(r.unstaged).toEqual([{ path: 'del.ts', type: 'deleted', staged: false }]);
  });

  it('routes every unmerged code to conflicts only', () => {
    for (const code of ['DD', 'AU', 'UD', 'UA', 'DU', 'AA', 'UU']) {
      const r = bucketChanges(parseStatusFull(z(`${code} f.ts`)), '');
      expect(r.conflicts).toEqual([{ path: 'f.ts', type: 'modified', staged: false }]);
      expect(r.staged).toEqual([]);
      expect(r.unstaged).toEqual([]);
    }
  });

  it('strips a monorepo prefix and drops out-of-subtree paths', () => {
    const r = bucketChanges(parseStatusFull(z(' M app/src/a.ts', ' M other/b.ts')), 'app/');
    expect(r.unstaged).toEqual([{ path: 'src/a.ts', type: 'modified', staged: false }]);
  });
});

describe('gitSourceControl prefix cache (against a real temp repo)', () => {
  let repo: string;

  beforeEach(() => {
    hoisted.argv.length = 0;
    // Every test gets a fresh mkdtemp path, so nothing else can be cached under it.
    repo = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'git-chg-')));
    execFileSync('git', ['init', repo], { stdio: 'pipe' });
    execFileSync('git', ['-C', repo, 'symbolic-ref', 'HEAD', 'refs/heads/work'], { stdio: 'pipe' });
    fs.writeFileSync(path.join(repo, 'a.txt'), 'x\n');
  });
  afterEach(() => {
    fs.rmSync(repo, { recursive: true, force: true });
  });

  it('spawns rev-parse --show-prefix once per path across repeated polls', async () => {
    const first = await gitSourceControl(repo);
    await gitSourceControl(repo);
    const third = await gitSourceControl(repo);

    expect(countArgv(isStatus)).toBe(3); // status still runs every poll
    expect(countArgv(isShowPrefix)).toBe(1); // …the constant prefix does not
    expect(third).toEqual(first); // same answer, one fewer child process
    expect(first.isRepo).toBe(true);
    expect(first.unstaged).toEqual([{ path: 'a.txt', type: 'untracked', staged: false }]);
  });

  it('does not report a repo that has since vanished as a repo forever', async () => {
    expect((await gitSourceControl(repo)).isRepo).toBe(true);
    fs.rmSync(path.join(repo, '.git'), { recursive: true, force: true });
    await gitSourceControl(repo); // status fails here; the stale entry must be dropped
    expect((await gitSourceControl(repo)).isRepo).toBe(false);
  });
});
