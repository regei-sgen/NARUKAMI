import type { DiffRange } from '../types';

/**
 * Every folder that (transitively) contains a changed file, so a collapsed
 * directory still shows a marker pointing at what's modified inside it. Paths are
 * project-relative POSIX (`a/b/c.ts`); the returned set holds each ancestor dir
 * (`a`, `a/b`). Pure — no React/DOM.
 */
export function changedFolders(paths: Iterable<string>): Set<string> {
  const dirs = new Set<string>();
  for (const p of paths) {
    const segs = p.split('/');
    segs.pop(); // drop the filename
    let acc = '';
    for (const s of segs) {
      if (!s) continue; // tolerate leading/double slashes
      acc = acc ? `${acc}/${s}` : s;
      dirs.add(acc);
    }
  }
  return dirs;
}

// A framework-agnostic decoration spec: which lines to mark and with which CSS
// classes. CodeEditor turns each into a Monaco decoration (start/end → Range).
export interface DecoSpec {
  startLine: number;
  endLine: number;
  isWholeLine: boolean;
  className?: string; // whole-line tint (added/modified only)
  linesDecorationsClassName: string; // gutter stripe/glyph
}

/**
 * Build the editor's diff-gutter decorations from git line ranges, clamped to the
 * file's actual line count. An untracked file is treated as wholly added. Pure —
 * the Monaco `Range` wrapping happens in the component. Returns [] for an empty
 * model (lineCount < 1) or when there are no ranges.
 */
export function diffDecorations(
  ranges: DiffRange[],
  lineCount: number,
  untracked: boolean,
): DecoSpec[] {
  if (lineCount < 1) return [];
  const clamp = (n: number): number => Math.max(1, Math.min(lineCount, n));
  const src: DiffRange[] = untracked ? [{ start: 1, end: lineCount, type: 'added' }] : ranges;

  return src
    .filter((r) => r.end >= r.start)
    .map((r) => {
      if (r.type === 'deleted') {
        return {
          startLine: clamp(r.start),
          endLine: clamp(r.end),
          isWholeLine: false,
          linesDecorationsClassName: 'nk-diff-del-gutter',
        };
      }
      const added = r.type === 'added';
      return {
        startLine: clamp(r.start),
        endLine: clamp(r.end),
        isWholeLine: true,
        className: added ? 'nk-diff-add-line' : 'nk-diff-modify-line',
        linesDecorationsClassName: added ? 'nk-diff-add-gutter' : 'nk-diff-modify-gutter',
      };
    });
}
