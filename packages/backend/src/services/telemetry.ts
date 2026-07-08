import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

// Reads a project's Claude Code session transcripts and aggregates token usage
// for the in-app Dashboard. The heavy lifting (`buildReport`) is a pure fold so
// it can be unit-tested without touching the filesystem.

export interface UsageTotals {
  input: number;
  output: number;
  cacheCreate: number;
  cacheRead: number;
  msgs: number;
  total: number;
}

export interface DayUsage {
  day: string; // 'YYYY-MM-DD' (UTC, matching the transcript timestamps)
  input: number;
  output: number;
  cacheCreate: number;
  cacheRead: number;
  msgs: number;
  total: number;
}

export interface SessionUsage {
  id: string; // short session id (first 8 chars)
  label: string; // first real user prompt, trimmed
  day: string;
  msgs: number; // assistant messages
  dur: number; // minutes between first and last event
  input: number;
  output: number;
  cw: number; // cache creation (write)
  cr: number; // cache read
  total: number;
}

export interface UsageReport {
  project: string;
  found: boolean; // false when the project has no Claude Code logs yet
  logDir: string;
  model: string; // dominant model across the sessions
  sessionsTotal: number;
  sessionsActive: number; // sessions with recorded usage
  rangeFirst: string | null;
  rangeLast: string | null;
  totals: UsageTotals;
  counts: { userMsgs: number; assistantMsgs: number; toolResults: number };
  byDay: DayUsage[];
  sessions: SessionUsage[];
}

interface RawUsage {
  input_tokens?: number;
  output_tokens?: number;
  cache_creation_input_tokens?: number;
  cache_read_input_tokens?: number;
}

interface RawRecord {
  type?: string;
  timestamp?: string;
  message?: { role?: string; model?: string; usage?: RawUsage; content?: unknown };
}

export interface RawSession {
  sid: string;
  records: RawRecord[];
}

/**
 * Claude Code stores a project's transcripts under a directory whose name is the
 * project's absolute path with every non-alphanumeric character replaced by '-'.
 * e.g. `C:\Users\me\My App` → `C--Users-me-My-App`.
 */
export function encodeProjectDir(projectPath: string): string {
  return projectPath.replace(/[^A-Za-z0-9]/g, '-');
}

/** Absolute path to a project's Claude Code transcript directory. */
export function projectLogDir(projectPath: string, home = os.homedir()): string {
  return path.join(home, '.claude', 'projects', encodeProjectDir(projectPath));
}

function labelFor(text: string | null): string {
  if (!text) return '(session init)';
  const t = text.replace(/\s+/g, ' ').trim();
  if (!t) return '(session init)';
  if (t.startsWith('You are ')) return `⚙ ${t.slice(0, 46)}`;
  return t.length > 60 ? `${t.slice(0, 60)}…` : t;
}

/** Pure aggregation of parsed session records into a usage report. */
export function buildReport(sessions: RawSession[], projectName: string, logDir = ''): UsageReport {
  const totals: UsageTotals = { input: 0, output: 0, cacheCreate: 0, cacheRead: 0, msgs: 0, total: 0 };
  const byDay = new Map<string, DayUsage>();
  const byModel = new Map<string, number>();
  const outSessions: SessionUsage[] = [];
  let firstTs: number | null = null;
  let lastTs: number | null = null;
  let userMsgs = 0;
  let assistantMsgs = 0;
  let toolResults = 0;

  const dayBucket = (day: string): DayUsage => {
    let d = byDay.get(day);
    if (!d) {
      d = { day, input: 0, output: 0, cacheCreate: 0, cacheRead: 0, msgs: 0, total: 0 };
      byDay.set(day, d);
    }
    return d;
  };

  for (const { sid, records } of sessions) {
    let sInput = 0;
    let sOutput = 0;
    let sCw = 0;
    let sCr = 0;
    let sMsgs = 0;
    let sFirst: number | null = null;
    let sLast: number | null = null;
    let firstUserText: string | null = null;

    for (const o of records) {
      const ts = o.timestamp ? Date.parse(o.timestamp) : NaN;
      if (!Number.isNaN(ts)) {
        if (sFirst === null || ts < sFirst) sFirst = ts;
        if (sLast === null || ts > sLast) sLast = ts;
        if (firstTs === null || ts < firstTs) firstTs = ts;
        if (lastTs === null || ts > lastTs) lastTs = ts;
      }
      if (o.type === 'user') {
        userMsgs++;
        const c = o.message?.content;
        if (typeof c === 'string' && !firstUserText && c.trim() && !c.startsWith('<')) {
          firstUserText = c.slice(0, 90);
        }
        if (Array.isArray(c) && c.some((b) => (b as { type?: string }).type === 'tool_result')) {
          toolResults++;
        }
      }
      if (o.type === 'assistant' && o.message?.usage) {
        assistantMsgs++;
        sMsgs++;
        const u = o.message.usage;
        const inp = u.input_tokens || 0;
        const out = u.output_tokens || 0;
        const cc = u.cache_creation_input_tokens || 0;
        const cr = u.cache_read_input_tokens || 0;
        sInput += inp;
        sOutput += out;
        sCw += cc;
        sCr += cr;
        totals.input += inp;
        totals.output += out;
        totals.cacheCreate += cc;
        totals.cacheRead += cr;
        totals.msgs++;
        const model = o.message.model || 'unknown';
        byModel.set(model, (byModel.get(model) || 0) + 1);
        const day = o.timestamp ? o.timestamp.slice(0, 10) : 'unknown';
        const d = dayBucket(day);
        d.input += inp;
        d.output += out;
        d.cacheCreate += cc;
        d.cacheRead += cr;
        d.msgs++;
        d.total += inp + out + cc + cr;
      }
    }

    const total = sInput + sOutput + sCw + sCr;
    if (total > 0) {
      outSessions.push({
        id: sid.slice(0, 8),
        label: labelFor(firstUserText),
        day: sFirst !== null ? new Date(sFirst).toISOString().slice(0, 10) : 'unknown',
        msgs: sMsgs,
        dur: sFirst !== null && sLast !== null ? Math.round((sLast - sFirst) / 60000) : 0,
        input: sInput,
        output: sOutput,
        cw: sCw,
        cr: sCr,
        total,
      });
    }
  }

  totals.total = totals.input + totals.output + totals.cacheCreate + totals.cacheRead;
  outSessions.sort((a, b) => b.total - a.total);
  const days = [...byDay.values()].sort((a, b) => a.day.localeCompare(b.day));

  let model = 'unknown';
  let best = -1;
  for (const [m, n] of byModel) {
    if (m !== '<synthetic>' && n > best) {
      best = n;
      model = m;
    }
  }

  return {
    project: projectName,
    found: true,
    logDir,
    model,
    sessionsTotal: sessions.length,
    sessionsActive: outSessions.length,
    rangeFirst: firstTs !== null ? new Date(firstTs).toISOString().slice(0, 10) : null,
    rangeLast: lastTs !== null ? new Date(lastTs).toISOString().slice(0, 10) : null,
    totals,
    counts: { userMsgs, assistantMsgs, toolResults },
    byDay: days,
    sessions: outSessions,
  };
}

function emptyReport(projectName: string, logDir: string): UsageReport {
  return {
    project: projectName,
    found: false,
    logDir,
    model: 'unknown',
    sessionsTotal: 0,
    sessionsActive: 0,
    rangeFirst: null,
    rangeLast: null,
    totals: { input: 0, output: 0, cacheCreate: 0, cacheRead: 0, msgs: 0, total: 0 },
    counts: { userMsgs: 0, assistantMsgs: 0, toolResults: 0 },
    byDay: [],
    sessions: [],
  };
}

/** Read + aggregate a project's Claude Code usage from disk. Never throws —
 *  a missing log directory yields a `found: false` empty report. */
export function readProjectUsage(projectPath: string, projectName: string): UsageReport {
  const dir = projectLogDir(projectPath);
  let files: string[];
  try {
    files = fs.readdirSync(dir).filter((f) => f.endsWith('.jsonl'));
  } catch {
    return emptyReport(projectName, dir);
  }
  const sessions: RawSession[] = [];
  for (const file of files) {
    let raw: string;
    try {
      raw = fs.readFileSync(path.join(dir, file), 'utf8');
    } catch {
      continue;
    }
    const records: RawRecord[] = [];
    for (const line of raw.split('\n')) {
      if (!line.trim()) continue;
      try {
        records.push(JSON.parse(line) as RawRecord);
      } catch {
        /* tolerate a truncated/half-written final line */
      }
    }
    sessions.push({ sid: file.replace(/\.jsonl$/, ''), records });
  }
  return buildReport(sessions, projectName, dir);
}

// ---- Account-wide rolling-window usage (for the "almost full" limit gauge) ----
// Claude's subscription limits are per-account and reset on rolling 5-hour and
// weekly windows, so this aggregates EVERY project's transcripts, not just one.

const FIVE_HOURS_MS = 5 * 60 * 60 * 1000;
const WEEK_MS = 7 * 24 * 60 * 60 * 1000;
const HOUR_MS = 60 * 60 * 1000;

export interface UsageEvent {
  ts: number;
  input: number;
  output: number;
  cw: number;
  cr: number;
}

export interface UsageWindow {
  tokens: number;
  input: number;
  output: number;
  cacheCreate: number;
  cacheRead: number;
  msgs: number;
  // Oldest event still counted in the window; `earliestTs + windowMs` is when the
  // soonest slice of usage ages out and capacity starts to free up.
  earliestTs: number | null;
}

export interface HourBucket {
  hourStart: number; // epoch ms, aligned to the hour
  tokens: number;
  msgs: number;
}

// ---- Anthropic's REAL subscription usage (matches claude.ai → Usage) ----
// A statusline reporter (~/.claude/usage-live.json) captures the `rate_limits`
// block Claude Code receives on each render — the same 5-hour / weekly
// percentages `/usage` shows. We read that snapshot rather than estimate.

const LIVE_STALE_MS = 15 * 60 * 1000;

export interface LiveWindow {
  usedPercentage: number; // 0–100, straight from Anthropic
  resetsAt: number | null; // epoch ms
}

export interface LiveUsage {
  available: boolean; // true only when a real rate_limits window was present
  ts: number | null; // when the snapshot was written (epoch ms)
  model: string | null;
  fiveHour: LiveWindow | null;
  sevenDay: LiveWindow | null;
  stale: boolean; // snapshot older than LIVE_STALE_MS (interact with Claude to refresh)
}

/** Pure parse of a usage-live.json object into LiveUsage (guards every field —
 *  windows are independently optional and absent before a session's first reply). */
export function parseLiveUsage(obj: unknown, now: number): LiveUsage {
  const none: LiveUsage = { available: false, ts: null, model: null, fiveHour: null, sevenDay: null, stale: true };
  if (!obj || typeof obj !== 'object') return none;
  const o = obj as Record<string, unknown>;
  const rl = o.rate_limits && typeof o.rate_limits === 'object' ? (o.rate_limits as Record<string, unknown>) : {};
  const win = (v: unknown): LiveWindow | null => {
    if (!v || typeof v !== 'object') return null;
    const w = v as Record<string, unknown>;
    if (typeof w.used_percentage !== 'number') return null;
    return { usedPercentage: w.used_percentage, resetsAt: typeof w.resets_at === 'number' ? w.resets_at * 1000 : null };
  };
  const fiveHour = win(rl.five_hour);
  const sevenDay = win(rl.seven_day);
  const ts = typeof o.ts === 'number' ? o.ts : null;
  return {
    available: fiveHour !== null || sevenDay !== null,
    ts,
    model: typeof o.model === 'string' ? o.model : null,
    fiveHour,
    sevenDay,
    stale: ts != null ? now - ts > LIVE_STALE_MS : true,
  };
}

/** Read the shared usage-live.json snapshot (never throws). */
export function readLiveUsage(now: number = Date.now(), home: string = os.homedir()): LiveUsage {
  const fp = path.join(home, '.claude', 'usage-live.json');
  try {
    return parseLiveUsage(JSON.parse(fs.readFileSync(fp, 'utf8')), now);
  } catch {
    return parseLiveUsage(null, now);
  }
}

export interface UsageWindows {
  now: number;
  projects: number; // how many project dirs contributed usage
  fiveHour: UsageWindow;
  weekly: UsageWindow;
  perHour: HourBucket[]; // last 24 hours, one bucket each (oldest first)
  live: LiveUsage; // Anthropic's real percentages, when available
}

function emptyWindow(): UsageWindow {
  return { tokens: 0, input: 0, output: 0, cacheCreate: 0, cacheRead: 0, msgs: 0, earliestTs: null };
}

function addToWindow(w: UsageWindow, e: UsageEvent, total: number): void {
  w.tokens += total;
  w.input += e.input;
  w.output += e.output;
  w.cacheCreate += e.cw;
  w.cacheRead += e.cr;
  w.msgs++;
  if (w.earliestTs === null || e.ts < w.earliestTs) w.earliestTs = e.ts;
}

/** Pure: fold timestamped usage events into rolling 5h / weekly windows plus a
 *  24-hour hourly histogram, relative to `now`. */
export function computeWindows(events: UsageEvent[], now: number): UsageWindows {
  const fiveHour = emptyWindow();
  const weekly = emptyWindow();
  const hourStart = (t: number): number => Math.floor(t / HOUR_MS) * HOUR_MS;
  const curHour = hourStart(now);
  const buckets = new Map<number, HourBucket>();
  for (let i = 23; i >= 0; i--) {
    const hs = curHour - i * HOUR_MS;
    buckets.set(hs, { hourStart: hs, tokens: 0, msgs: 0 });
  }
  for (const e of events) {
    const total = e.input + e.output + e.cw + e.cr;
    if (e.ts <= now && e.ts >= now - FIVE_HOURS_MS) addToWindow(fiveHour, e, total);
    if (e.ts <= now && e.ts >= now - WEEK_MS) addToWindow(weekly, e, total);
    const b = buckets.get(hourStart(e.ts));
    if (b) {
      b.tokens += total;
      b.msgs++;
    }
  }
  return {
    now,
    projects: 0,
    fiveHour,
    weekly,
    perHour: [...buckets.values()].sort((a, b) => a.hourStart - b.hourStart),
    live: parseLiveUsage(null, now),
  };
}

/** Read every project's transcripts and compute account-wide rolling windows.
 *  Files not touched within the last week are skipped (their events can't be in
 *  any window). Never throws. */
export function readAllUsageWindows(now: number = Date.now(), home: string = os.homedir()): UsageWindows {
  const base = path.join(home, '.claude', 'projects');
  let dirs: string[];
  try {
    dirs = fs.readdirSync(base);
  } catch {
    return computeWindows([], now);
  }
  const cutoff = now - WEEK_MS;
  const events: UsageEvent[] = [];
  let projects = 0;
  for (const d of dirs) {
    const dir = path.join(base, d);
    let files: string[];
    try {
      files = fs.readdirSync(dir).filter((f) => f.endsWith('.jsonl'));
    } catch {
      continue;
    }
    let counted = false;
    for (const f of files) {
      const fp = path.join(dir, f);
      try {
        if (fs.statSync(fp).mtimeMs < cutoff) continue; // whole file is older than a week
      } catch {
        continue;
      }
      let raw: string;
      try {
        raw = fs.readFileSync(fp, 'utf8');
      } catch {
        continue;
      }
      for (const line of raw.split('\n')) {
        if (!line.trim()) continue;
        let o: RawRecord;
        try {
          o = JSON.parse(line) as RawRecord;
        } catch {
          continue;
        }
        if (o.type !== 'assistant' || !o.message?.usage || !o.timestamp) continue;
        const ts = Date.parse(o.timestamp);
        if (Number.isNaN(ts) || ts < cutoff) continue;
        const u = o.message.usage;
        events.push({
          ts,
          input: u.input_tokens || 0,
          output: u.output_tokens || 0,
          cw: u.cache_creation_input_tokens || 0,
          cr: u.cache_read_input_tokens || 0,
        });
        counted = true;
      }
    }
    if (counted) projects++;
  }
  const windows = computeWindows(events, now);
  windows.projects = projects;
  windows.live = readLiveUsage(now, home);
  return windows;
}
