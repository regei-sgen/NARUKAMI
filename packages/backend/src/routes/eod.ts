import type { FastifyInstance } from 'fastify';
import { prisma } from '../db';
import { AnalyzerError, generateEodReport, type EodProjectInput } from '../services/analyzer';
import { commitsToText, gitCommitsForDay } from '../services/gitLog';
import {
  claudeSessionActivity,
  collectActiveProjects,
  collectSessionContext,
  normPath,
  prettyName,
  type RegisteredProject,
} from '../services/eodActivity';

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
    projects = JSON.parse(r.projects);
  } catch {
    projects = [];
  }
  return { ...r, projects };
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
  app.get<{ Querystring: { day?: string } }>('/api/eod/active', async (req) => {
    const day = validDay(req.query.day) ?? dayKey(new Date());
    const { start, end } = boundsForDayKey(day);

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
    return { day, projects };
  });

  // Generate + save the day's cross-project report from the selected paths (AI).
  app.post<{ Body: { day?: string; paths?: string[]; note?: string } }>(
    '/api/eod/report',
    async (req, reply) => {
      const day = validDay(req.body?.day) ?? dayKey(new Date());
      const paths = Array.isArray(req.body?.paths)
        ? req.body.paths.filter((p): p is string => typeof p === 'string' && p.length > 0)
        : [];
      if (paths.length === 0) {
        return reply.code(400).send({ error: 'Select at least one project to include.' });
      }
      const note = typeof req.body?.note === 'string' ? req.body.note.trim().slice(0, 2000) : '';
      const { start, end } = boundsForDayKey(day);

      const registered = await prisma.project.findMany({ select: { name: true, path: true } });
      const nameByPath = new Map(registered.map((r) => [normPath(r.path), r.name]));
      const sessionMap = claudeSessionActivity(start, end);
      const contextMap = collectSessionContext(start, end);

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
        const sessions = sessionMap.get(normPath(p))?.count ?? 0;
        const sessionContext = contextMap.get(normPath(p)) ?? '';
        const name = nameByPath.get(normPath(p)) ?? prettyName(p);
        inputs.push({ name, commitsText: commitsToText(commits), runsText, sessions, sessionContext });
        included.push({ name, path: p });
      }

      try {
        const markdown = await generateEodReport(paths[0], prettyDate(day), inputs, note);
        const report = await prisma.eodReport.upsert({
          where: { day },
          update: { markdown, projects: JSON.stringify(included) },
          create: { day, markdown, projects: JSON.stringify(included) },
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
