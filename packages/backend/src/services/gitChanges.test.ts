import { describe, it, expect } from 'vitest';
import { parseStatusFull, bucketChanges } from './gitChanges';

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
