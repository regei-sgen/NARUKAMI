import { describe, it, expect } from 'vitest';
import { computeStats, fmtDuration, fmtTime, isOk, statusClass } from './eod';
import type { EodItem } from '../types';

function item(over: Partial<EodItem> = {}): EodItem {
  return {
    label: 'dev',
    kind: 'command',
    command: 'npm run dev',
    status: 'exited',
    exitCode: 0,
    startedAt: '2026-07-04T10:00:00.000Z',
    endedAt: '2026-07-04T10:00:05.000Z',
    durationMs: 5000,
    ...over,
  };
}

describe('isOk', () => {
  it('true only for a clean exit (exit 0 or null)', () => {
    expect(isOk(item({ status: 'exited', exitCode: 0 }))).toBe(true);
    expect(isOk(item({ status: 'exited', exitCode: null }))).toBe(true);
    expect(isOk(item({ status: 'exited', exitCode: 1 }))).toBe(false);
    expect(isOk(item({ status: 'killed', exitCode: null }))).toBe(false);
    expect(isOk(item({ status: 'error', exitCode: null }))).toBe(false);
  });
});

describe('statusClass', () => {
  it('buckets into ok / warn / err', () => {
    expect(statusClass(item({ status: 'exited', exitCode: 0 }))).toBe('ok');
    expect(statusClass(item({ status: 'killed' }))).toBe('warn');
    expect(statusClass(item({ status: 'error' }))).toBe('err');
    expect(statusClass(item({ status: 'exited', exitCode: 2 }))).toBe('err');
  });
});

describe('fmtDuration', () => {
  it('formats null / sub-second / seconds / minutes', () => {
    expect(fmtDuration(null)).toBe('—');
    expect(fmtDuration(850)).toBe('850ms');
    expect(fmtDuration(5000)).toBe('5s');
    expect(fmtDuration(60_000)).toBe('1m');
    expect(fmtDuration(90_000)).toBe('1m 30s');
    expect(fmtDuration(3_600_000)).toBe('60m');
  });
});

describe('fmtTime', () => {
  it('empty for null; HH:MM otherwise', () => {
    expect(fmtTime(null)).toBe('');
    // local time — assert shape not exact hour (tz-independent)
    expect(fmtTime('2026-07-04T10:07:00.000Z')).toMatch(/^\d{2}:07$/);
  });
});

describe('computeStats', () => {
  it('is all-zero for no items', () => {
    const s = computeStats([]);
    expect(s).toMatchObject({ total: 0, ok: 0, failed: 0, activeMs: 0, spanStart: null, spanEnd: null });
    expect(s.byKind).toEqual({});
  });

  it('counts ok vs failed, sums active time, tracks span + kinds', () => {
    const items: EodItem[] = [
      item({ kind: 'command', status: 'exited', exitCode: 0, durationMs: 5000, startedAt: '2026-07-04T10:00:00.000Z', endedAt: '2026-07-04T10:00:05.000Z' }),
      item({ kind: 'shell', status: 'killed', exitCode: -1, durationMs: 2000, startedAt: '2026-07-04T09:00:00.000Z', endedAt: '2026-07-04T09:00:02.000Z' }),
      item({ kind: 'claude', status: 'exited', exitCode: null, durationMs: 10000, startedAt: '2026-07-04T11:00:00.000Z', endedAt: '2026-07-04T12:00:00.000Z' }),
    ];
    const s = computeStats(items);
    expect(s.total).toBe(3);
    expect(s.ok).toBe(2);
    expect(s.failed).toBe(1);
    expect(s.activeMs).toBe(17000);
    expect(s.byKind).toEqual({ command: 1, shell: 1, claude: 1 });
    expect(s.spanStart).toBe('2026-07-04T09:00:00.000Z'); // earliest start
    expect(s.spanEnd).toBe('2026-07-04T12:00:00.000Z'); // latest end
  });

  it('ignores null durations in the active sum', () => {
    const s = computeStats([item({ durationMs: null }), item({ durationMs: 3000 })]);
    expect(s.activeMs).toBe(3000);
  });
});
