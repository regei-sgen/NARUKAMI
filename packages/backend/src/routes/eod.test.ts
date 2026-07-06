import { describe, it, expect } from 'vitest';
import { dayKey, dayBounds, toItem, itemLine, parseItems, type EodItem } from './eod';

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
