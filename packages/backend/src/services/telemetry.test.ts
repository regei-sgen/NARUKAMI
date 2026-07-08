import { describe, it, expect } from 'vitest';
import {
  encodeProjectDir,
  projectLogDir,
  buildReport,
  computeWindows,
  parseLiveUsage,
  type RawSession,
  type UsageEvent,
} from './telemetry';

describe('encodeProjectDir', () => {
  it('replaces every non-alphanumeric char with a dash (Claude Code layout)', () => {
    expect(encodeProjectDir('C:\\Users\\Stephanie Piape\\Documents\\NARUKAMI')).toBe(
      'C--Users-Stephanie-Piape-Documents-NARUKAMI',
    );
  });
  it('handles POSIX paths', () => {
    expect(encodeProjectDir('/home/me/my.app')).toBe('-home-me-my-app');
  });
});

describe('projectLogDir', () => {
  it('joins the encoded dir under ~/.claude/projects', () => {
    const dir = projectLogDir('/home/me/app', '/home/me');
    expect(dir.replace(/\\/g, '/')).toBe('/home/me/.claude/projects/-home-me-app');
  });
});

function asst(ts: string, model: string, u: Partial<Record<string, number>>): unknown {
  return {
    type: 'assistant',
    timestamp: ts,
    message: {
      model,
      usage: {
        input_tokens: u.input ?? 0,
        output_tokens: u.output ?? 0,
        cache_creation_input_tokens: u.cw ?? 0,
        cache_read_input_tokens: u.cr ?? 0,
      },
    },
  };
}
const userMsg = (ts: string, text: string): unknown => ({ type: 'user', timestamp: ts, message: { content: text } });
const toolMsg = (ts: string): unknown => ({
  type: 'user',
  timestamp: ts,
  message: { content: [{ type: 'tool_result', content: 'ok' }] },
});

describe('buildReport', () => {
  const sessions: RawSession[] = [
    {
      sid: 'aaaaaaaa-1111-2222-3333-444444444444',
      records: [
        userMsg('2026-07-03T02:00:00.000Z', 'build the thing please') as never,
        asst('2026-07-03T02:00:05.000Z', 'claude-opus-4-8', { input: 100, output: 2000, cw: 500, cr: 40000 }) as never,
        toolMsg('2026-07-03T02:01:00.000Z') as never,
        asst('2026-07-03T02:10:00.000Z', 'claude-opus-4-8', { input: 50, output: 1000, cw: 0, cr: 60000 }) as never,
      ],
    },
    {
      sid: 'bbbbbbbb-5555-6666-7777-888888888888',
      records: [
        userMsg('2026-07-04T09:00:00.000Z', 'a quick question') as never,
        asst('2026-07-04T09:00:03.000Z', 'claude-opus-4-8', { input: 30, output: 300, cw: 10, cr: 5000 }) as never,
      ],
    },
    // empty session — no usage, excluded from the table but counted in the total
    { sid: 'cccccccc-9999-0000-1111-222222222222', records: [] },
  ];
  const r = buildReport(sessions, 'DemoProj', '/logs/demo');

  it('sums token totals across all sessions', () => {
    expect(r.totals.input).toBe(180);
    expect(r.totals.output).toBe(3300);
    expect(r.totals.cacheCreate).toBe(510);
    expect(r.totals.cacheRead).toBe(105000);
    expect(r.totals.total).toBe(180 + 3300 + 510 + 105000);
    expect(r.totals.msgs).toBe(3); // assistant messages
  });

  it('counts sessions: total includes empty, active excludes zero-usage', () => {
    expect(r.sessionsTotal).toBe(3);
    expect(r.sessionsActive).toBe(2);
    expect(r.sessions).toHaveLength(2);
  });

  it('orders sessions by total tokens descending', () => {
    expect(r.sessions[0].id).toBe('aaaaaaaa');
    expect(r.sessions[0].total).toBeGreaterThan(r.sessions[1].total);
  });

  it('captures the first real user prompt as the session label', () => {
    expect(r.sessions[0].label).toBe('build the thing please');
  });

  it('computes per-session duration in minutes', () => {
    expect(r.sessions[0].dur).toBe(10); // 02:00:00 → 02:10:00
    expect(r.sessions[1].dur).toBe(0);
  });

  it('buckets usage by UTC day, sorted ascending', () => {
    expect(r.byDay.map((d) => d.day)).toEqual(['2026-07-03', '2026-07-04']);
    expect(r.byDay[0].total).toBe(100 + 2000 + 500 + 40000 + 50 + 1000 + 0 + 60000);
  });

  it('reports the date range and dominant model', () => {
    expect(r.rangeFirst).toBe('2026-07-03');
    expect(r.rangeLast).toBe('2026-07-04');
    expect(r.model).toBe('claude-opus-4-8');
  });

  it('counts user turns and tool results', () => {
    expect(r.counts.assistantMsgs).toBe(3);
    expect(r.counts.userMsgs).toBe(3); // 2 prompts + 1 tool_result message
    expect(r.counts.toolResults).toBe(1);
  });

  it('marks a report built from sessions as found', () => {
    expect(r.found).toBe(true);
    expect(r.logDir).toBe('/logs/demo');
    expect(r.project).toBe('DemoProj');
  });

  it('handles an all-empty project without NaNs', () => {
    const e = buildReport([], 'Empty');
    expect(e.totals.total).toBe(0);
    expect(e.rangeFirst).toBeNull();
    expect(e.sessions).toEqual([]);
    expect(e.byDay).toEqual([]);
  });
});

describe('computeWindows', () => {
  const HOUR = 60 * 60 * 1000;
  const now = 100 * 24 * HOUR; // a fixed, arbitrary "now" (avoids Date.now())
  const ev = (hoursAgo: number, tokens: number): UsageEvent => ({
    ts: now - hoursAgo * HOUR,
    input: tokens,
    output: 0,
    cw: 0,
    cr: 0,
  });
  const events: UsageEvent[] = [
    ev(0.5, 100), // within 5h and week
    ev(3, 200), // within 5h and week
    ev(6, 400), // outside 5h, within week
    ev(30, 800), // outside 5h, within week
    ev(24 * 8, 9999), // older than a week — excluded from both
  ];
  const w = computeWindows(events, now);

  it('sums only the last 5 hours into the 5-hour window', () => {
    expect(w.fiveHour.tokens).toBe(300); // 100 + 200
    expect(w.fiveHour.msgs).toBe(2);
  });

  it('sums the last 7 days into the weekly window', () => {
    expect(w.weekly.tokens).toBe(1500); // 100 + 200 + 400 + 800
    expect(w.weekly.msgs).toBe(4);
  });

  it('excludes events older than a week', () => {
    expect(w.weekly.tokens).not.toContain(9999);
    expect(w.weekly.msgs).toBe(4);
  });

  it('tracks the earliest event in each window (for the reset countdown)', () => {
    expect(w.fiveHour.earliestTs).toBe(now - 3 * HOUR);
    expect(w.weekly.earliestTs).toBe(now - 30 * HOUR);
  });

  it('emits exactly 24 hourly buckets ending at the current hour', () => {
    expect(w.perHour).toHaveLength(24);
    const last = w.perHour[w.perHour.length - 1];
    expect(last.hourStart).toBe(Math.floor(now / HOUR) * HOUR);
    // buckets are sorted oldest → newest
    for (let i = 1; i < w.perHour.length; i++) {
      expect(w.perHour[i].hourStart).toBeGreaterThan(w.perHour[i - 1].hourStart);
    }
  });

  it('drops the 30-hour-old event from the 24h histogram but keeps recent ones', () => {
    const histTotal = w.perHour.reduce((s, b) => s + b.tokens, 0);
    expect(histTotal).toBe(700); // 100 + 200 + 400 (the 30h and 8d events fall outside 24h)
  });

  it('returns zeroed windows for no events', () => {
    const z = computeWindows([], now);
    expect(z.fiveHour.tokens).toBe(0);
    expect(z.weekly.tokens).toBe(0);
    expect(z.fiveHour.earliestTs).toBeNull();
    expect(z.perHour).toHaveLength(24);
    expect(z.live.available).toBe(false);
  });
});

describe('parseLiveUsage', () => {
  const now = 1783500400000;
  const snapshot = {
    ts: 1783500348871,
    model: 'Opus 4.8',
    rate_limits: {
      five_hour: { used_percentage: 49, resets_at: 1783503000 },
      seven_day: { used_percentage: 31, resets_at: 1783695600 },
    },
  };

  it('reads Anthropic real percentages and converts resets_at to ms', () => {
    const u = parseLiveUsage(snapshot, now);
    expect(u.available).toBe(true);
    expect(u.model).toBe('Opus 4.8');
    expect(u.fiveHour).toEqual({ usedPercentage: 49, resetsAt: 1783503000 * 1000 });
    expect(u.sevenDay).toEqual({ usedPercentage: 31, resetsAt: 1783695600 * 1000 });
  });

  it('flags a fresh snapshot as not stale, an old one as stale', () => {
    expect(parseLiveUsage(snapshot, now).stale).toBe(false); // ~51s old
    expect(parseLiveUsage(snapshot, now + 20 * 60 * 1000).stale).toBe(true); // >15 min
  });

  it('is unavailable when rate_limits is missing (pre-first-response / free plan)', () => {
    expect(parseLiveUsage({ ts: now, model: 'Opus 4.8' }, now).available).toBe(false);
    expect(parseLiveUsage(null, now).available).toBe(false);
    expect(parseLiveUsage('garbage', now).available).toBe(false);
  });

  it('handles one window present and the other absent', () => {
    const u = parseLiveUsage({ ts: now, rate_limits: { five_hour: { used_percentage: 12, resets_at: 1783503000 } } }, now);
    expect(u.available).toBe(true);
    expect(u.fiveHour?.usedPercentage).toBe(12);
    expect(u.sevenDay).toBeNull();
  });

  it('tolerates a window with no resets_at', () => {
    const u = parseLiveUsage({ ts: now, rate_limits: { seven_day: { used_percentage: 80 } } }, now);
    expect(u.sevenDay).toEqual({ usedPercentage: 80, resetsAt: null });
  });
});
