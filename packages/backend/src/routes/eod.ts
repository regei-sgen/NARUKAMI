import type { FastifyInstance } from 'fastify';
import { prisma } from '../db';
import {
  AnalyzerError,
  generateEodReport,
  summarizeSession,
  type EodProjectInput,
} from '../services/analyzer';
import { commitsToText, gitCommitsForDay } from '../services/gitLog';
import {
  claudeSessionActivity,
  collectActiveProjects,
  normPath,
  prettyName,
  type RegisteredProject,
} from '../services/eodActivity';
import {
  collectSessionsForRange,
  isSubstantiveSession,
  sessionSubstance,
  sessionToPromptText,
  type SessionRecord,
} from '../services/eodSessions';

/** Local 'YYYY-MM-DD' key for a date (server local time). */
export function dayKey(d: Date): string {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
}

/** [startOfLocalDay, startOfNextLocalDay) for the day containing `d`. */
export function dayBounds(d: Date): { start: Date; end: Date } {
  const start = new Date(d.getFullYear(), d.getMonth(), d.getDate(), 0, 0, 0, 0);
  const end = new Date(start);
  end.setDate(end.getDate() + 1);
  return { start, end };
}

/** Local-day bounds from a 'YYYY-MM-DD' key. */
export function boundsForDayKey(day: string): { start: Date; end: Date } {
  const [y, m, d] = day.split('-').map(Number);
  return dayBounds(new Date(y, (m || 1) - 1, d || 1));
}

const MONTHS = [
  'January', 'February', 'March', 'April', 'May', 'June',
  'July', 'August', 'September', 'October', 'November', 'December',
];

/** 'YYYY-MM-DD' → 'Month D, YYYY' (the report heading date). */
export function prettyDate(day: string): string {
  const [y, m, d] = day.split('-').map(Number);
  return `${MONTHS[(m || 1) - 1]} ${d}, ${y}`;
}

/** Accept only a well-formed day key; else undefined (caller defaults to today). */
function validDay(s: unknown): string | undefined {
  return typeof s === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(s) ? s : undefined;
}

/**
 * Bounds for an INCLUSIVE day range: from the start of `from`'s local day to the
 * start of the day AFTER `to` — i.e. [from 00:00, (to+1) 00:00). Single-day
 * (from === to) reduces to boundsForDayKey. Every EOD activity source
 * (sessions/runs/commits) already windows on these bounds, so ranges "just work".
 */
export function boundsForRange(from: string, to: string): { start: Date; end: Date } {
  return { start: boundsForDayKey(from).start, end: boundsForDayKey(to).end };
}

/**
 * Stable identity for a report: a single day keeps its plain 'YYYY-MM-DD' key
 * (so pre-range reports keep working unchanged); a multi-day range is 'from_to'.
 * This is the EodReport.day unique key — no schema change needed.
 */
export function rangeKey(from: string, to: string): string {
  return from === to ? from : `${from}_${to}`;
}

/** Inverse of rangeKey: a stored key → {from, to} (single day → from === to). */
export function parseRangeKey(key: string): { from: string; to: string } {
  const m = /^(\d{4}-\d{2}-\d{2})_(\d{4}-\d{2}-\d{2})$/.exec(key);
  return m ? { from: m[1], to: m[2] } : { from: key, to: key };
}

/**
 * Human heading for the report: 'Month D, YYYY' for a single day; for a range,
 * collapse shared month/year — 'July 1–11, 2026', 'July 28 – August 2, 2026',
 * or 'December 30, 2025 – January 2, 2026'.
 */
export function prettyRange(from: string, to: string): string {
  if (from === to) return prettyDate(from);
  const [fy, fm, fd] = from.split('-').map(Number);
  const [ty, tm, td] = to.split('-').map(Number);
  if (fy === ty && fm === tm) return `${MONTHS[(fm || 1) - 1]} ${fd}–${td}, ${fy}`;
  if (fy === ty) return `${MONTHS[(fm || 1) - 1]} ${fd} – ${MONTHS[(tm || 1) - 1]} ${td}, ${fy}`;
  return `${prettyDate(from)} – ${prettyDate(to)}`;
}

/**
 * Resolve a request's date window. Prefers from/to; falls back to the legacy
 * single `day`; then today. Orders the pair (swaps a reversed range) and caps the
 * end at today so a stray future date can't widen the window. String comparison
 * is valid for zero-padded 'YYYY-MM-DD'.
 */
export function normalizeRange(fromRaw: unknown, toRaw: unknown, dayRaw?: unknown): { from: string; to: string } {
  const today = dayKey(new Date());
  const day = validDay(dayRaw);
  let from = validDay(fromRaw) ?? day ?? today;
  let to = validDay(toRaw) ?? day ?? from;
  if (from > to) [from, to] = [to, from];
  if (to > today) to = today;
  if (from > to) from = to;
  return { from, to };
}

// ── legacy run-item helpers (kept: still unit-tested and used for the report's
//    "runs finished today" context text) ──────────────────────────────────────
export interface EodItem {
  label: string;
  kind: string;
  command: string | null;
  status: string;
  exitCode: number | null;
  startedAt: string | null;
  endedAt: string | null;
  durationMs: number | null;
}

export function toItem(run: {
  kind: string;
  name: string | null;
  status: string;
  exitCode: number | null;
  startedAt: Date;
  endedAt: Date | null;
  command: { label: string; command: string } | null;
}): EodItem {
  const label = run.kind === 'command' ? run.command?.label ?? run.name ?? 'command' : run.name ?? run.kind;
  const durationMs = run.endedAt ? run.endedAt.getTime() - run.startedAt.getTime() : null;
  return {
    label,
    kind: run.kind,
    command: run.kind === 'command' ? run.command?.command ?? null : null,
    status: run.status,
    exitCode: run.exitCode,
    startedAt: run.startedAt.toISOString(),
    endedAt: run.endedAt ? run.endedAt.toISOString() : null,
    durationMs: durationMs != null && durationMs >= 0 ? durationMs : null,
  };
}

export function itemLine(it: EodItem): string {
  const dur = it.durationMs != null ? ` · ${Math.round(it.durationMs / 1000)}s` : '';
  const code = it.exitCode != null ? ` (exit ${it.exitCode})` : '';
  const cmd = it.command ? ` — \`${it.command}\`` : '';
  return `${it.label} · ${it.kind} · ${it.status}${code}${dur}${cmd}`;
}

export function parseItems(raw: string): EodItem[] {
  try {
    const v: unknown = JSON.parse(raw);
    return Array.isArray(v) ? (v as EodItem[]) : [];
  } catch {
    return [];
  }
}

interface EodReportRow {
  id: string;
  day: string;
  markdown: string;
  projects: string;
  createdAt: Date;
  updatedAt: Date;
}
function serializeReport(r: EodReportRow) {
  let projects: Array<{ name: string; path: string }> = [];
  try {
    projects = JSON.parse(r.projects) as Array<{ name: string; path: string }>;
  } catch {
    projects = [];
  }
  return { ...r, projects };
}

// ── session-digest layer ────────────────────────────────────────────────────
// Digesting a session is one `claude -p` call, so a busy day is the expensive
// part of the report. Three guards keep it bounded: a per-project cap (with the
// remainder REPORTED, never silently dropped), a small concurrency pool, and a
// content-addressed cache so regenerating a report doesn't re-read yesterday.

/** Most sessions digested per project per report. Spent on the MOST SUBSTANTIAL
 *  sessions (see isSubstantiveSession); any remainder is reported to the prompt. */
const MAX_SESSIONS_PER_PROJECT = 16;
/** Parallel `claude -p` digests. Each spawns a Claude process — keep it modest. */
const DIGEST_CONCURRENCY = 4;
const DIGEST_CACHE_PREFIX = 'eodDigest:';
/** Cached digests older than this are swept on each generation. */
const DIGEST_CACHE_TTL_MS = 14 * 24 * 60 * 60 * 1000;

/** Cache key: session + its byte size + last entry, so an extended session re-digests. */
function digestKey(rec: SessionRecord): string {
  return `${DIGEST_CACHE_PREFIX}${rec.sessionId}:${rec.bytes}:${rec.endedAt ?? ''}`;
}

async function cachedDigest(rec: SessionRecord): Promise<string | null> {
  try {
    const row = await prisma.appSetting.findUnique({ where: { key: digestKey(rec) } });
    if (!row) return null;
    const v: unknown = JSON.parse(row.value);
    return typeof v === 'string' && v.trim() ? v : null;
  } catch {
    return null;
  }
}

async function storeDigest(rec: SessionRecord, digest: string): Promise<void> {
  try {
    const key = digestKey(rec);
    await prisma.appSetting.upsert({
      where: { key },
      update: { value: JSON.stringify(digest) },
      create: { key, value: JSON.stringify(digest) },
    });
  } catch {
    // Caching is an optimization — never fail a report over it.
  }
}

/** Drop digest rows we haven't touched in a fortnight so the table can't grow forever. */
async function sweepDigestCache(): Promise<void> {
  try {
    await prisma.appSetting.deleteMany({
      where: {
        key: { startsWith: DIGEST_CACHE_PREFIX },
        updatedAt: { lt: new Date(Date.now() - DIGEST_CACHE_TTL_MS) },
      },
    });
  } catch {
    // best-effort
  }
}

/**
 * Layer 1: digest each session of a project, at most DIGEST_CONCURRENCY at a
 * time. A session whose digest fails is skipped rather than sinking the report —
 * the roll-up still has the remaining digests, commits and runs to work from.
 */
async function digestSessions(
  projectName: string,
  projectPath: string,
  records: SessionRecord[],
): Promise<string[]> {
  const out: string[] = new Array<string>(records.length).fill('');
  let next = 0;
  const worker = async (): Promise<void> => {
    for (;;) {
      const i = next;
      next += 1;
      if (i >= records.length) return;
      const rec = records[i];
      try {
        const hit = await cachedDigest(rec);
        if (hit) {
          out[i] = hit;
          continue;
        }
        const digest = await summarizeSession(projectPath, projectName, sessionToPromptText(rec));
        if (digest) {
          out[i] = digest;
          await storeDigest(rec, digest);
        }
      } catch (err) {
        process.stderr.write(
          `[narukami] EOD: session ${rec.sessionId} digest failed — ${String(err)}\n`,
        );
      }
    }
  };
  await Promise.all(
    Array.from({ length: Math.min(DIGEST_CONCURRENCY, records.length) }, () => worker()),
  );
  return out.filter((d) => d.trim().length > 0);
}

/** Runs (started or ended) within [start,end) for a project path. */
function runsWhere(path: string, start: Date, end: Date) {
  return {
    project: { path },
    OR: [{ startedAt: { gte: start, lt: end } }, { endedAt: { gte: start, lt: end } }],
  };
}

export async function eodRoutes(app: FastifyInstance): Promise<void> {
  // Projects active on a day (default today): Claude sessions (native + NARUKAMI),
  // NARUKAMI runs, and git commits, unioned. Feeds the include-checkbox list.
  app.get<{ Querystring: { from?: string; to?: string; day?: string } }>('/api/eod/active', async (req) => {
    const { from, to } = normalizeRange(req.query.from, req.query.to, req.query.day);
    const { start, end } = boundsForRange(from, to);

    const registered: RegisteredProject[] = await prisma.project.findMany({
      select: { id: true, name: true, path: true },
    });

    const runs = await prisma.run.findMany({
      where: { OR: [{ startedAt: { gte: start, lt: end } }, { endedAt: { gte: start, lt: end } }] },
      select: { project: { select: { path: true } } },
    });
    const runsByPath = new Map<string, number>();
    for (const r of runs) {
      const k = normPath(r.project.path);
      runsByPath.set(k, (runsByPath.get(k) ?? 0) + 1);
    }

    const projects = await collectActiveProjects({ registered, runsByPath, start, end });
    return { from, to, day: rangeKey(from, to), projects };
  });

  // Generate + save the day's cross-project report from the selected paths (AI).
  app.post<{ Body: { from?: string; to?: string; day?: string; paths?: string[]; note?: string } }>(
    '/api/eod/report',
    async (req, reply) => {
      const { from, to } = normalizeRange(req.body?.from, req.body?.to, req.body?.day);
      const paths = Array.isArray(req.body?.paths)
        ? req.body.paths.filter((p): p is string => typeof p === 'string' && p.length > 0)
        : [];
      if (paths.length === 0) {
        return reply.code(400).send({ error: 'Select at least one project to include.' });
      }
      const note = typeof req.body?.note === 'string' ? req.body.note.trim().slice(0, 2000) : '';
      const { start, end } = boundsForRange(from, to);

      const registered = await prisma.project.findMany({ select: { name: true, path: true } });
      const nameByPath = new Map(registered.map((r) => [normPath(r.path), r.name]));
      const sessionMap = claudeSessionActivity(start, end);
      // Layer 0: read every in-range transcript END TO END, one record per session.
      const sessionsByPath = await collectSessionsForRange(start, end);
      void sweepDigestCache();

      const inputs: EodProjectInput[] = [];
      const included: Array<{ name: string; path: string }> = [];
      for (const p of paths) {
        const commits = await gitCommitsForDay(p, start, end);
        const runRows = await prisma.run.findMany({
          where: runsWhere(p, start, end),
          include: { command: true },
          orderBy: { startedAt: 'asc' },
        });
        const runsText = runRows.map((r) => itemLine(toItem(r))).join('\n');
        const name = nameByPath.get(normPath(p)) ?? prettyName(p);

        const all = sessionsByPath.get(normPath(p)) ?? [];
        // Drop the headless one-shot stubs first (report generation writes its
        // own transcripts), then spend the budget on the MOST SUBSTANTIAL
        // sessions rather than the most recent — newest-first handed the budget
        // to the stubs. Restored to chronological order so the day still reads
        // in sequence.
        const real = all.filter(isSubstantiveSession);
        const picked = [...real]
          .sort((a, b) => sessionSubstance(b) - sessionSubstance(a))
          .slice(0, MAX_SESSIONS_PER_PROJECT)
          .sort((a, b) => String(a.startedAt ?? '').localeCompare(String(b.startedAt ?? '')));
        const sessionsOmitted = real.length - picked.length;
        // Layer 1: one digest per session.
        const sessionDigests = await digestSessions(name, p, picked);
        // Coverage is the report's credibility: say plainly how much of the day
        // actually reached the model, so a partial report is never mistaken for
        // a complete one.
        process.stderr.write(
          `[narukami] EOD ${name}: ${all.length} transcript(s) in range, ${real.length} substantive ` +
            `(${all.length - real.length} one-shot stub(s) skipped), ${picked.length} selected, ` +
            `${sessionDigests.length} digested, ${sessionsOmitted} over budget\n`,
        );

        inputs.push({
          name,
          commitsText: commitsToText(commits),
          runsText,
          // Prefer the count we actually read; fall back to the mtime scan.
          sessions: real.length || sessionMap.get(normPath(p))?.count || 0,
          sessionDigests,
          sessionsOmitted,
        });
        included.push({ name, path: p });
      }

      try {
        const markdown = await generateEodReport(paths[0], prettyRange(from, to), inputs, note);
        const key = rangeKey(from, to);
        const report = await prisma.eodReport.upsert({
          where: { day: key },
          update: { markdown, projects: JSON.stringify(included) },
          create: { day: key, markdown, projects: JSON.stringify(included) },
        });
        return reply.code(201).send(serializeReport(report));
      } catch (err) {
        if (err instanceof AnalyzerError) return reply.code(502).send({ error: err.message });
        return reply.code(500).send({ error: 'Report generation failed.', detail: String(err) });
      }
    },
  );

  // Saved reports, newest day first.
  app.get('/api/eod/reports', async () => {
    const rows = await prisma.eodReport.findMany({ orderBy: { day: 'desc' } });
    return rows.map(serializeReport);
  });

  app.get<{ Params: { id: string } }>('/api/eod/reports/:id', async (req, reply) => {
    const r = await prisma.eodReport.findUnique({ where: { id: req.params.id } });
    if (!r) return reply.code(404).send({ error: 'Report not found.' });
    return serializeReport(r);
  });

  app.delete<{ Params: { id: string } }>('/api/eod/reports/:id', async (req, reply) => {
    const r = await prisma.eodReport.findUnique({ where: { id: req.params.id } });
    if (!r) return reply.code(404).send({ error: 'Report not found.' });
    await prisma.eodReport.delete({ where: { id: r.id } });
    return { ok: true };
  });
}
