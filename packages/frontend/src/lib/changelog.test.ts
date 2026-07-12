import { describe, it, expect } from 'vitest';
import {
  filterCommits,
  fromLocalInput,
  rangeForPreset,
  toLocalInput,
  type LogCommit,
} from './changelog';

const commit = (date: string, subject = 's'): LogCommit => ({
  date,
  author: 'a',
  hash: 'abc',
  subject,
  body: '',
  filesChanged: null,
});

describe('rangeForPreset', () => {
  const now = Date.parse('2026-07-12T12:00:00Z');
  it('computes rolling windows relative to now', () => {
    expect(rangeForPreset('24h', now)).toEqual({ fromMs: now - 86_400_000, toMs: now });
    expect(rangeForPreset('7d', now)).toEqual({ fromMs: now - 7 * 86_400_000, toMs: now });
  });
  it('is unbounded for "all"', () => {
    expect(rangeForPreset('all', now)).toEqual({ fromMs: null, toMs: null });
  });
  it('"today" starts at (local) midnight and ends now', () => {
    const r = rangeForPreset('today', now);
    expect(r.toMs).toBe(now);
    expect(r.fromMs).not.toBeNull();
    expect(r.fromMs as number).toBeLessThanOrEqual(now);
    expect(now - (r.fromMs as number)).toBeLessThanOrEqual(86_400_000);
  });
});

describe('filterCommits', () => {
  const commits = [
    commit('2026-07-12T12:21:00Z', 'newest'),
    commit('2026-07-11T20:00:00Z', 'yesterday-evening'),
    commit('2026-07-10T09:00:00Z', 'older'),
  ];

  it('keeps commits within [from, to]', () => {
    const from = Date.parse('2026-07-11T18:00:00Z');
    const to = Date.parse('2026-07-12T23:59:00Z');
    expect(filterCommits(commits, from, to).map((c) => c.subject)).toEqual([
      'newest',
      'yesterday-evening',
    ]);
  });

  it('treats null bounds as unbounded', () => {
    expect(filterCommits(commits, null, null)).toHaveLength(3);
    const from = Date.parse('2026-07-12T00:00:00Z');
    expect(filterCommits(commits, from, null).map((c) => c.subject)).toEqual(['newest']);
  });

  it('keeps commits with an unparseable date rather than dropping them', () => {
    const weird = [commit('not-a-date', 'weird')];
    expect(filterCommits(weird, Date.now() - 1000, Date.now())).toHaveLength(1);
  });
});

describe('toLocalInput / fromLocalInput', () => {
  it('round-trips a datetime-local value to the same minute', () => {
    const ms = fromLocalInput('2026-07-11T18:00');
    expect(ms).not.toBeNull();
    expect(toLocalInput(ms as number)).toBe('2026-07-11T18:00');
  });
  it('returns null for empty/invalid input', () => {
    expect(fromLocalInput('')).toBeNull();
    expect(fromLocalInput('nope')).toBeNull();
  });
});
