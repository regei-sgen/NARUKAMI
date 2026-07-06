import type { FastifyInstance } from 'fastify';
import { prisma } from '../db';
import {
  getLiveTranscript,
  isRunning,
  liveRunIds,
  stripAnsi,
  tailLines,
  writeToRun,
} from '../services/runner';

const MAX_SEND_CHARS = 10_000;
const DEFAULT_READ_LINES = 120;
const MAX_READ_LINES = 2_000;

/**
 * Sliding-window rate limiter. Pure state + explicit `now` so it's unit-testable
 * and deterministic. Guards against a runaway orchestrator flooding a terminal
 * with input (a Claude-to-Claude feedback loop).
 */
export function makeRateLimiter(max: number, windowMs: number) {
  const hits = new Map<string, number[]>();
  return function allow(key: string, now: number): boolean {
    // Evict keys whose window has fully elapsed so the map can't grow unbounded
    // (one permanent entry per distinct terminal id ever targeted). Cheap here:
    // at most a handful of targets are live within any single window.
    for (const [k, times] of hits) {
      const live = times.filter((t) => now - t < windowMs);
      if (live.length === 0) hits.delete(k);
      else hits.set(k, live);
    }
    const recent = hits.get(key) ?? [];
    if (recent.length >= max) return false;
    recent.push(now);
    hits.set(key, recent);
    return true;
  };
}

// Max 20 injected sends per 5s per target terminal.
const sendLimiter = makeRateLimiter(20, 5_000);

export async function terminalRoutes(app: FastifyInstance): Promise<void> {
  // List every currently-live terminal so an orchestrator can pick a target.
  app.get('/api/terminals', async () => {
    const ids = liveRunIds();
    if (ids.length === 0) return { terminals: [] };

    const rows = await prisma.run.findMany({
      where: { id: { in: ids } },
      include: { project: true, command: true },
    });

    const terminals = rows.map((r) => ({
      id: r.id,
      projectId: r.projectId,
      projectName: r.project.name,
      projectPath: r.project.path,
      kind: r.kind, // shell | claude | command
      label: r.name ?? (r.kind === 'command' ? r.command?.label ?? 'command' : r.kind),
      running: true,
    }));

    return { terminals };
  });

  // Read a terminal's recent output (ANSI-stripped, last N lines). Serves the
  // live in-memory transcript; falls back to persisted logs for an ended run.
  app.get<{ Params: { id: string }; Querystring: { lines?: string } }>(
    '/api/terminals/:id/read',
    async (req, reply) => {
      const requested = Number(req.query?.lines);
      const lines = Number.isFinite(requested)
        ? Math.min(Math.max(1, Math.floor(requested)), MAX_READ_LINES)
        : DEFAULT_READ_LINES;

      const live = getLiveTranscript(req.params.id);
      if (live !== null) {
        return { live: true, text: tailLines(stripAnsi(live), lines) };
      }

      // Not live — hand back persisted history if the run exists at all.
      const run = await prisma.run.findUnique({
        where: { id: req.params.id },
        include: { logs: { orderBy: { ts: 'asc' } } },
      });
      if (!run) return reply.code(404).send({ error: 'Terminal not found.' });

      const text = run.logs.map((l) => l.chunk).join('');
      return { live: false, text: tailLines(stripAnsi(text), lines) };
    },
  );

  // Send input to a terminal's stdin (the core orchestration write). `submit`
  // (default true) presses Enter after the text. `from` is the caller's own run
  // id — sending to yourself is rejected to kill the trivial self-feedback loop.
  app.post<{
    Params: { id: string };
    Body: { text?: string; submit?: boolean; from?: string };
  }>('/api/terminals/:id/send', async (req, reply) => {
    const targetId = req.params.id;
    const text = typeof req.body?.text === 'string' ? req.body.text : '';
    const from = typeof req.body?.from === 'string' ? req.body.from : '';

    if (!text) return reply.code(400).send({ error: 'text is required.' });
    if (text.length > MAX_SEND_CHARS) {
      return reply.code(413).send({ error: `text exceeds ${MAX_SEND_CHARS} chars.` });
    }
    // `from` (the caller's own run id) is REQUIRED: the self-send guard below is
    // the anti-feedback-loop backstop, and it can be trivially bypassed by simply
    // omitting `from`. The only caller — the MCP bridge — always sends it.
    if (!from) {
      return reply.code(400).send({ error: 'from (the caller run id) is required.' });
    }
    if (from === targetId) {
      return reply.code(400).send({ error: 'A terminal cannot send to itself.' });
    }
    if (!isRunning(targetId)) {
      return reply.code(409).send({ error: 'Target terminal is not live.' });
    }
    if (!sendLimiter(targetId, Date.now())) {
      return reply.code(429).send({ error: 'Rate limit: too many sends to this terminal.' });
    }

    const submit = req.body?.submit !== false; // default: press Enter
    const ok = writeToRun(targetId, submit ? `${text}\r` : text);
    if (!ok) return reply.code(409).send({ error: 'Target terminal is not live.' });

    return { ok: true, sent: text.length, submitted: submit };
  });
}
