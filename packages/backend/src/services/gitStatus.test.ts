import { describe, it, expect } from 'vitest';
import { parseStatus, parseDiffRanges, isUnbornHead } from './gitStatus';

// Build a NUL-terminated porcelain -z stream from raw records.
function z(...records: string[]): string {
  return records.map((r) => `${r}\0`).join('');
}

describe('parseStatus', () => {
  it('classifies untracked, modified, added, and deleted', () => {
    const raw = z('?? new.ts', ' M src/a.ts', 'A  src/b.ts', ' D src/c.ts');
    expect(parseStatus(raw)).toEqual([
      { path: 'new.ts', status: 'added' },
      { path: 'src/a.ts', status: 'modified' },
      { path: 'src/b.ts', status: 'added' },
      { path: 'src/c.ts', status: 'deleted' },
    ]);
  });

  it('reads the new path of a rename and skips the original NUL field', () => {
    // `R  new\0old` then a following change — the "old" token must not be parsed.
    const raw = z('R  src/new.ts', 'src/old.ts', ' M src/keep.ts');
    expect(parseStatus(raw)).toEqual([
      { path: 'src/new.ts', status: 'modified' },
      { path: 'src/keep.ts', status: 'modified' },
    ]);
  });

  it('treats a worktree deletion (space-D) as deleted', () => {
    expect(parseStatus(z(' D gone.ts'))).toEqual([{ path: 'gone.ts', status: 'deleted' }]);
  });

  it('keeps POSIX paths with spaces intact', () => {
    expect(parseStatus(z('?? a b/c d.ts'))).toEqual([
      { path: 'a b/c d.ts', status: 'added' },
    ]);
  });

  it('returns [] for empty input', () => {
    expect(parseStatus('')).toEqual([]);
    expect(parseStatus('\0')).toEqual([]);
  });
});

describe('parseDiffRanges', () => {
  it('marks a single added line (implicit count of 1)', () => {
    const raw = '@@ -287,0 +288 @@ context\n+new line\n';
    expect(parseDiffRanges(raw)).toEqual([{ start: 288, end: 288, type: 'added' }]);
  });

  it('marks a multi-line pure addition as added', () => {
    const raw = '@@ -10,0 +11,3 @@\n+a\n+b\n+c\n';
    expect(parseDiffRanges(raw)).toEqual([{ start: 11, end: 13, type: 'added' }]);
  });

  it('marks a replaced block as modified', () => {
    const raw = '@@ -5,2 +5,2 @@\n-old1\n-old2\n+new1\n+new2\n';
    expect(parseDiffRanges(raw)).toEqual([{ start: 5, end: 6, type: 'modified' }]);
  });

  it('marks a pure deletion (newCount 0) as a one-line deleted marker', () => {
    const raw = '@@ -5,2 +4,0 @@\n-gone1\n-gone2\n';
    expect(parseDiffRanges(raw)).toEqual([{ start: 4, end: 4, type: 'deleted' }]);
  });

  it('clamps a deletion at the top of the file to line 1', () => {
    const raw = '@@ -1,2 +0,0 @@\n-a\n-b\n';
    expect(parseDiffRanges(raw)).toEqual([{ start: 1, end: 1, type: 'deleted' }]);
  });

  it('parses several hunks in one diff', () => {
    const raw = '@@ -1 +1 @@\n-a\n+b\n@@ -10,0 +11,2 @@\n+c\n+d\n';
    expect(parseDiffRanges(raw)).toEqual([
      { start: 1, end: 1, type: 'modified' },
      { start: 11, end: 12, type: 'added' },
    ]);
  });

  it('returns [] when there are no hunks', () => {
    expect(parseDiffRanges('')).toEqual([]);
    expect(parseDiffRanges('diff --git a/x b/x\n')).toEqual([]);
  });
});

describe('isUnbornHead', () => {
  it('matches the stderr git prints when HEAD does not resolve', () => {
    for (const msg of [
      "fatal: ambiguous argument 'HEAD': unknown revision or path not in the working tree.",
      "fatal: bad revision 'HEAD'",
      'fatal: bad default revision "HEAD"',
    ]) {
      expect(isUnbornHead({ stderr: msg })).toBe(true);
      expect(isUnbornHead(new Error(msg))).toBe(true);
    }
  });

  it('does NOT match a maxBuffer overflow (must not be treated as unborn)', () => {
    const err = Object.assign(new Error('stdout maxBuffer length exceeded'), {
      code: 'ERR_CHILD_PROCESS_STDIO_MAXBUFFER',
    });
    expect(isUnbornHead(err)).toBe(false);
  });

  it('does NOT match a timeout or an unrelated failure', () => {
    expect(isUnbornHead(new Error('spawn git ETIMEDOUT'))).toBe(false);
    expect(isUnbornHead(new Error('some other git error'))).toBe(false);
    expect(isUnbornHead(undefined)).toBe(false);
    expect(isUnbornHead(null)).toBe(false);
  });
});
