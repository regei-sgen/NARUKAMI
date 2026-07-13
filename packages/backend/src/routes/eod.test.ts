import { describe, it, expect } from 'vitest';
import {
  dayKey,
  dayBounds,
  boundsForDayKey,
  prettyDate,
  toItem,
  itemLine,
  parseItems,
  boundsForRange,
  rangeKey,
  parseRangeKey,
  prettyRange,
  normalizeRange,
  type EodItem,
} from './eod';

describe('boundsForDayKey (local timezone)', () => {
  it('turns a day key into LOCAL midnight → next local midnight', () => {
    const { start, end } = boundsForDayKey('2026-07-06');
    expect(start.getFullYear()).toBe(2026);
    expect(start.getMonth()).toBe(6);
    expect(start.getDate()).toBe(6);
    expect(start.getHours()).toBe(0); // local midnight, not UTC
    expect(end.getDate()).toBe(7);
    expect(end.getTime() - start.getTime()).toBe(24 * 60 * 60 * 1000);
  });
});

describe('prettyDate', () => {
  it('formats a local day key as "Month D, YYYY"', () => {
    expect(prettyDate('2026-07-06')).toBe('July 6, 2026');
    expect(prettyDate('2026-01-09')).toBe('January 9, 2026');
  });
});

describe('range helpers', () => {
  it('boundsForRange spans start-of-`from` to start-of-day-after-`to` (inclusive end day)', () => {
    const { start, end } = boundsForRange('2026-07-01', '2026-07-11');
    expect(start.getFullYear()).toBe(2026);
    expect(start.getMonth()).toBe(6);
    expect(start.getDate()).toBe(1);
    expect(start.getHours()).toBe(0);
    expect(end.getMonth()).toBe(6);
    expect(end.getDate()).toBe(12); // midnight AFTER the 11th → the 11th is included
    expect(end.getHours()).toBe(0);
  });

  it('boundsForRange(single day) equals boundsForDayKey', () => {
    const r = boundsForRange('2026-07-06', '2026-07-06');
    const d = boundsForDayKey('2026-07-06');
    expect(r.start.getTime()).toBe(d.start.getTime());
    expect(r.end.getTime()).toBe(d.end.getTime());
  });

  it('rangeKey: single day stays plain, a range joins with "_"', () => {
    expect(rangeKey('2026-07-06', '2026-07-06')).toBe('2026-07-06');
    expect(rangeKey('2026-07-01', '2026-07-11')).toBe('2026-07-01_2026-07-11');
  });

  it('parseRangeKey inverts rangeKey (single day → from === to)', () => {
    expect(parseRangeKey('2026-07-06')).toEqual({ from: '2026-07-06', to: '2026-07-06' });
    expect(parseRangeKey('2026-07-01_2026-07-11')).toEqual({ from: '2026-07-01', to: '2026-07-11' });
  });

  it('prettyRange: single / same-month / cross-month / cross-year', () => {
    expect(prettyRange('2026-07-06', '2026-07-06')).toBe('July 6, 2026');
    expect(prettyRange('2026-07-01', '2026-07-11')).toBe('July 1–11, 2026');
    expect(prettyRange('2026-07-28', '2026-08-02')).toBe('July 28 – August 2, 2026');
    expect(prettyRange('2025-12-30', '2026-01-02')).toBe('December 30, 2025 – January 2, 2026');
  });

  it('normalizeRange: from/to kept, reversed swapped, legacy day fills both, future capped to today', () => {
    expect(normalizeRange('2020-01-01', '2020-01-05')).toEqual({ from: '2020-01-01', to: '2020-01-05' });
    expect(normalizeRange('2020-01-05', '2020-01-01')).toEqual({ from: '2020-01-01', to: '2020-01-05' });
    expect(normalizeRange(undefined, undefined, '2020-02-02')).toEqual({ from: '2020-02-02', to: '2020-02-02' });
    const today = dayKey(new Date());
    expect(normalizeRange('2020-01-01', '2999-01-01')).toEqual({ from: '2020-01-01', to: today });
  });
});

describe('dayKey', () => {
  it('formats a local date as YYYY-MM-DD (zero-padded)', () => {
    // Local-component constructor → tz-independent assertion.
    expect(dayKey(new Date(2026, 6, 4, 15, 30))).toBe('2026-07-04'); // month 6 = July
    expect(dayKey(new Date(2026, 0, 9, 0, 0))).toBe('2026-01-09');
    expect(dayKey(new Date(2025, 11, 31, 23, 59))).toBe('2025-12-31');
  });
});

describe('dayBounds', () => {
  it('spans local midnight to next local midnight', () => {
    const { start, end } = dayBounds(new Date(2026, 6, 4, 15, 30, 45));
    expect(start.getFullYear()).toBe(2026);
    expect(start.getMonth()).toBe(6);
    expect(start.getDate()).toBe(4);
    expect(start.getHours()).toBe(0);
    expect(start.getMinutes()).toBe(0);
    expect(start.getSeconds()).toBe(0);
    expect(end.getDate()).toBe(5);
    expect(end.getHours()).toBe(0);
    expect(end.getTime() - start.getTime()).toBe(24 * 60 * 60 * 1000);
  });
});

describe('toItem', () => {
  const base = {
    kind: 'command',
    name: null as string | null,
    status: 'exited',
    exitCode: 0 as number | null,
    startedAt: new Date('2026-07-04T10:00:00.000Z'),
    endedAt: new Date('2026-07-04T10:00:05.000Z') as Date | null,
    command: { label: 'dev', command: 'npm run dev' } as { label: string; command: string } | null,
  };

  it('captures command + computes duration for a command run', () => {
    const it = toItem(base);
    expect(it).toMatchObject({
      label: 'dev',
      kind: 'command',
      command: 'npm run dev',
      status: 'exited',
      exitCode: 0,
      durationMs: 5000,
    });
    expect(it.startedAt).toBe('2026-07-04T10:00:00.000Z');
    expect(it.endedAt).toBe('2026-07-04T10:00:05.000Z');
  });

  it('omits command for shell/claude and falls back to kind label', () => {
    const shell = toItem({ ...base, kind: 'shell', command: null });
    expect(shell.command).toBeNull();
    expect(shell.label).toBe('shell');
    const claude = toItem({ ...base, kind: 'claude', command: null, name: null });
    expect(claude.label).toBe('claude');
  });

  it('prefers a custom name over the kind label', () => {
    expect(toItem({ ...base, kind: 'shell', command: null, name: 'my tab' }).label).toBe('my tab');
  });

  it('nulls duration when endedAt is missing or clock-skewed negative', () => {
    expect(toItem({ ...base, endedAt: null }).durationMs).toBeNull();
    expect(
      toItem({ ...base, endedAt: new Date('2026-07-04T09:59:59.000Z') }).durationMs,
    ).toBeNull(); // ended before started → negative → null
  });
});

describe('itemLine', () => {
  const sample: EodItem = {
    label: 'build',
    kind: 'command',
    command: 'npm run build',
    status: 'exited',
    exitCode: 0,
    startedAt: '2026-07-04T10:00:00.000Z',
    endedAt: '2026-07-04T10:00:12.000Z',
    durationMs: 12000,
  };

  it('renders label · kind · status (+exit +duration +command)', () => {
    expect(itemLine(sample)).toBe('build · command · exited (exit 0) · 12s — `npm run build`');
  });

  it('includes the exit code when non-null', () => {
    expect(itemLine({ ...sample, status: 'killed', exitCode: 137, command: null })).toBe(
      'build · command · killed (exit 137) · 12s',
    );
  });
});

describe('parseItems', () => {
  it('parses a valid JSON array', () => {
    expect(parseItems('[{"label":"x"}]')).toEqual([{ label: 'x' }]);
  });
  it('returns [] for invalid JSON', () => {
    expect(parseItems('not json')).toEqual([]);
    expect(parseItems('')).toEqual([]);
  });
  it('returns [] when the JSON is not an array', () => {
    expect(parseItems('{"label":"x"}')).toEqual([]);
    expect(parseItems('42')).toEqual([]);
  });
});
