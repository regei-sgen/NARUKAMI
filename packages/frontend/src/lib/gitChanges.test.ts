import { describe, it, expect } from 'vitest';
import { changedFolders, diffDecorations } from './gitChanges';
import type { DiffRange } from '../types';

describe('changedFolders', () => {
  it('collects every ancestor folder of each changed file', () => {
    const dirs = changedFolders(['a/b/c.ts', 'a/d.ts', 'top.ts']);
    expect([...dirs].sort()).toEqual(['a', 'a/b']);
  });

  it('merges shared ancestors without duplicates', () => {
    const dirs = changedFolders(['x/y/1.ts', 'x/y/2.ts', 'x/z/3.ts']);
    expect([...dirs].sort()).toEqual(['x', 'x/y', 'x/z']);
  });

  it('returns an empty set for only root-level files', () => {
    expect(changedFolders(['a.ts', 'b.ts']).size).toBe(0);
  });

  it('accepts a Map keys iterator and tolerates stray slashes', () => {
    const m = new Map([['src//deep/f.ts', 'modified']]);
    expect([...changedFolders(m.keys())].sort()).toEqual(['src', 'src/deep']);
  });

  it('returns an empty set for no input', () => {
    expect(changedFolders([]).size).toBe(0);
  });
});

describe('diffDecorations', () => {
  const R = (start: number, end: number, type: DiffRange['type']): DiffRange => ({
    start,
    end,
    type,
  });

  it('builds a whole-line tint + gutter stripe for an added range', () => {
    expect(diffDecorations([R(3, 5, 'added')], 100, false)).toEqual([
      {
        startLine: 3,
        endLine: 5,
        isWholeLine: true,
        className: 'nk-diff-add-line',
        linesDecorationsClassName: 'nk-diff-add-gutter',
      },
    ]);
  });

  it('uses modify classes for a modified range', () => {
    const [d] = diffDecorations([R(2, 2, 'modified')], 10, false);
    expect(d.className).toBe('nk-diff-modify-line');
    expect(d.linesDecorationsClassName).toBe('nk-diff-modify-gutter');
    expect(d.isWholeLine).toBe(true);
  });

  it('emits a gutter-only glyph (no whole-line tint) for a deletion', () => {
    expect(diffDecorations([R(4, 4, 'deleted')], 10, false)).toEqual([
      {
        startLine: 4,
        endLine: 4,
        isWholeLine: false,
        linesDecorationsClassName: 'nk-diff-del-gutter',
      },
    ]);
  });

  it('clamps ranges past the end of the file to the last line', () => {
    const [d] = diffDecorations([R(50, 80, 'added')], 12, false);
    expect(d.startLine).toBe(12);
    expect(d.endLine).toBe(12);
  });

  it('clamps a range starting below line 1 up to 1', () => {
    const [d] = diffDecorations([R(0, 0, 'deleted')], 12, false);
    expect(d.startLine).toBe(1);
    expect(d.endLine).toBe(1);
  });

  it('marks the whole file added when untracked (ignoring the ranges arg)', () => {
    expect(diffDecorations([], 7, true)).toEqual([
      {
        startLine: 1,
        endLine: 7,
        isWholeLine: true,
        className: 'nk-diff-add-line',
        linesDecorationsClassName: 'nk-diff-add-gutter',
      },
    ]);
  });

  it('drops inverted (end < start) ranges', () => {
    expect(diffDecorations([R(5, 3, 'added')], 100, false)).toEqual([]);
  });

  it('returns [] for an empty model (lineCount < 1) even when untracked', () => {
    expect(diffDecorations([], 0, true)).toEqual([]);
    expect(diffDecorations([R(1, 1, 'added')], 0, false)).toEqual([]);
  });

  it('returns [] when there are no ranges', () => {
    expect(diffDecorations([], 100, false)).toEqual([]);
  });
});
