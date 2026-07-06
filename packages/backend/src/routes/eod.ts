import type { FastifyInstance } from 'fastify';
import { prisma } from '../db';
import { AnalyzerError, summarizeDay } from '../services/analyzer';
import { commitsToText, gitCommitsForDay, type Commit } from '../services/gitLog';

// Keep the newest N days of EOD entries per project; older ones are pruned.
const RETENTION_DAYS = 10;

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

/** Local-day bounds from a 'YYYY-MM-DD' key (for recomputing a past day's commits). */
export function boundsForDayKey(day: string): { start: Date; end: Date } {
  const [y, m, d] = day.split('-').map(Number);
  return dayBounds(new Date(y, (m || 1) - 1, d || 1));
}

export interface EodItem {
  label: string;
  kind: string;
  command: string | null; // the actual shell command, for 'command' runs
  status: string;
  exitCode: number | null;
  startedAt: string | null;
  endedAt: string | null;
  durationMs: number | null;
}

/** Shape one finished Run into a detailed EOD line item. */
export function toItem(run: {
  kind: string;
  name: string | null;
  status: string;
  exitCode: number | null;
  startedAt: Date;
  endedAt: Date | null;
  command: { label: string; command: string } | null;
}): EodItem {
  const label =
    run.kind === 'command'
      ? run.command?.label ?? run.name ?? 'command'
      : run.name ?? run.kind;
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

/** One-line text form of an item for the AI summary prompt. */
export function itemLine(it: EodItem): string {
  const dur = it.durationMs != null ? ` · ${Math.round(it.durationMs / 1000)}s` : '';
  const code = it.exitCode != null ? ` (exit ${it.exitCode})` : '';
  const cmd = it.command ? ` — \`${it.command}\`` : '';
  return `${it.label} · ${it.kind} · ${it.status}${code}${dur}${cmd}`;
}

/** Parse the stored items JSON back into an array (tolerant of bad data). */
export function parseItems(raw: string): EodItem[] {
  try {
    const v: unknown = JSON.parse(raw);
    return Array.isArray(v) ? (v as EodItem[]) : [];
  } catch {
    return [];
  }
}

function serialize(
  entry: {
    id: string;
    projectId: string;
    day: string;
    items: string;
    note: string | null;
    summary: string | null;
    createdAt: Date;
    updatedAt: Date;
  },
  commits: Commit[] = [],
) {
  return { ...entry, items: parseItems(entry.items), commits };
}

export async function eodRoutes(app: FastifyInstance): Promise<void> {
  // List a project's saved EOD entries, newest day first.
  app.get<{ Params: { id: string } }>('/api/projects/:id/eod', async (req, reply) => {
    const project = await prisma.project.findUnique({ where: { id: req.params.id } });
    if (!project) return reply.code(404).send({ error: 'Project not found.' });

    const entries = await prisma.eodEntry.findMany({
      where: { projectId: project.id },
      orderBy: { day: 'desc' },
    });
    // Recompute each day's commits from git on read (no schema/storage needed;
    // git history is immutable). One git call per kept day (≤10) — cheap.
    return Promise.all(
      entries.map(async (e) => {
        const { start, end } = boundsForDayKey(e.day);
        return serialize(e, await gitCommitsForDay(project.path, start, end));
      }),
    );
  });

  // Compile (or re-compile) today's EOD for a project: snapshot every run that
  // finished today, upsert the day's entry, attach an optional note, then prune
  // to the newest RETENTION_DAYS days for this project.
  app.post<{ Params: { id: string }; Body: { note?: string } }>(
    '/api/projects/:id/eod/compile',
    async (req, reply) => {
      const project = await prisma.project.findUnique({ where: { id: req.params.id } });
      if (!project) return reply.code(404).send({ error: 'Project not found.' });

      const now = new Date();
      const day = dayKey(now);
      const { start, end } = dayBounds(now);

      const runs = await prisma.run.findMany({
        where: {
          projectId: project.id,
          endedAt: { gte: start, lt: end },
          status: { in: ['exited', 'killed', 'error'] },
        },
        include: { command: true },
        orderBy: { endedAt: 'asc' },
      });
      const items = runs.map(toItem);

      // Preserve an existing note when the caller doesn't send one.
      const rawNote = typeof req.body?.note === 'string' ? req.body.note.trim() : undefined;
      const note = rawNote ? rawNote.slice(0, 2000) : rawNote === '' ? '' : undefined;

      const entry = await prisma.eodEntry.upsert({
        where: { projectId_day: { projectId: project.id, day } },
        update: { items: JSON.stringify(items), ...(note !== undefined ? { note: note || null } : {}) },
        create: { projectId: project.id, day, items: JSON.stringify(items), note: note || null },
      });

      // Retention: delete everything older than the newest RETENTION_DAYS days.
      const keep = await prisma.eodEntry.findMany({
        where: { projectId: project.id },
        orderBy: { day: 'desc' },
        select: { id: true },
        take: RETENTION_DAYS,
      });
      const keepIds = new Set(keep.map((k) => k.id));
      await prisma.eodEntry.deleteMany({
        where: { projectId: project.id, id: { notIn: [...keepIds] } },
      });

      const commits = await gitCommitsForDay(project.path, start, end);
      return reply.code(201).send(serialize(entry, commits));
    },
  );

  // Edit the note on an existing EOD entry (any day) without re-compiling.
  app.post<{ Params: { eodId: string }; Body: { note?: string } }>(
    '/api/eod/:eodId/note',
    async (req, reply) => {
      const existing = await prisma.eodEntry.findUnique({
        where: { id: req.params.eodId },
        include: { project: true },
      });
      if (!existing) return reply.code(404).send({ error: 'EOD entry not found.' });
      const raw = typeof req.body?.note === 'string' ? req.body.note.trim().slice(0, 2000) : '';
      const entry = await prisma.eodEntry.update({
        where: { id: existing.id },
        data: { note: raw || null },
      });
      const { start, end } = boundsForDayKey(existing.day);
      const commits = await gitCommitsForDay(existing.project.path, start, end);
      return serialize(entry, commits);
    },
  );

  // Generate an AI narrative summary of an EOD entry via `claude -p`.
  app.post<{ Params: { eodId: string } }>('/api/eod/:eodId/summarize', async (req, reply) => {
    const entry = await prisma.eodEntry.findUnique({
      where: { id: req.params.eodId },
      include: { project: true },
    });
    if (!entry) return reply.code(404).send({ error: 'EOD entry not found.' });

    const items = parseItems(entry.items);
    const runsText = items.map(itemLine).join('\n');
    const { start, end } = boundsForDayKey(entry.day);
    const commits = await gitCommitsForDay(entry.project.path, start, end);
    const commitsText = commitsToText(commits);

    try {
      const summary = await summarizeDay(
        entry.project.path,
        entry.day,
        runsText,
        commitsText,
        entry.note ?? '',
      );
      const updated = await prisma.eodEntry.update({
        where: { id: entry.id },
        data: { summary: summary || null },
      });
      return serialize(updated, commits);
    } catch (err) {
      if (err instanceof AnalyzerError) {
        return reply.code(502).send({ error: err.message });
      }
      return reply.code(500).send({ error: 'Summarize failed.', detail: String(err) });
    }
  });

  // Delete a single EOD entry.
  app.delete<{ Params: { eodId: string } }>('/api/eod/:eodId', async (req, reply) => {
    const existing = await prisma.eodEntry.findUnique({ where: { id: req.params.eodId } });
    if (!existing) return reply.code(404).send({ error: 'EOD entry not found.' });
    await prisma.eodEntry.delete({ where: { id: existing.id } });
    return { ok: true };
  });
}
