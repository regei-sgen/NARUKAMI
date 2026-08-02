import type { FastifyInstance } from 'fastify';
import { prisma } from '../db';
import {
  getLiveTranscriptTail,
  getRunActivity,
  isRunning,
  liveRunIds,
  stripAnsi,
  tailLines,
  writeToRun,
} from '../services/runner';

const MAX_SEND_CHARS = 10_000;
const DEFAULT_READ_LINES = 120;
const MAX_READ_LINES = 2_000;

// Idle-detection window for GET /:id/idle. The floor stops a caller from turning
// the endpoint into a busy-wait on sub-100ms gaps between pty chunks (ConPTY
// emits a storm of them); the 10-minute ceiling keeps a mistyped threshold from
// making `idle` effectively unreachable for the run's whole life.
const DEFAULT_IDLE_MS = 1_500;
const MIN_IDLE_MS = 100;
const MAX_IDLE_MS = 600_000;

// Newest-first page size / hard page cap for the persisted-history read below.
// 200 rows is ~90 KB of a real run's logs (measured: 3,155 rows / 1.39 MB on a
// busy tab ≈ 440 B per flushed chunk), so the default 64 KB window is normally
// satisfied by ONE query.
const LOG_PAGE = 200;
const MAX_LOG_PAGES = 20;

/**
 * Tail of a dead run's persisted logs, bounded to `maxChars`.
 *
 * The route used to load EVERY RunLog row for the run just to hand tailLines()
 * the last ~120 lines — on a path an orchestrator polls repeatedly. Walk the
 * rows newest-first instead and stop as soon as the window is full, so the cost
 * is proportional to what is returned, not to how long the tab was open. Same
 * budget discipline the live branch already applies.
 */
async function persistedTail(runId: string, maxChars: number): Promise<string> {
  const parts: string[] = [];
  let chars = 0;
  for (let page = 0; page < MAX_LOG_PAGES; page += 1) {
    const rows = await prisma.runLog.findMany({
      where: { runId },
      // Secondary sort on the (monotonic) cuid so identical timestamps can't
      // make the pages overlap or skip a row.
      orderBy: [{ ts: 'desc' }, { id: 'desc' }],
      skip: page * LOG_PAGE,
      take: LOG_PAGE,
      select: { chunk: true },
    });
    for (const r of rows) {
      parts.push(r.chunk);
      chars += r.chunk.length;
      if (chars >= maxChars) return parts.reverse().join('');
    }
    if (rows.length < LOG_PAGE) break; // reached the start of the run
  }
  return parts.reverse().join('');
}

/** Epoch ms → ISO string for the wire, preserving "never produced output". */
function isoOrNull(ms: number | null): string | null {
  return ms === null ? null : new Date(ms).toISOString();
}

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

      // Bound the work: only the tail can survive tailLines(), so join/strip a
      // window (~512 chars/line, 64KB floor) instead of the potentially multi-MB
      // transcript. getLiveTranscriptTail walks whole chunks from the end, so a
      // truncated escape at the window edge can only dirty the first (dropped)
      // line of the window.
      const window = Math.max(64 * 1024, lines * 512);
      const live = getLiveTranscriptTail(req.params.id, window);
      if (live !== null) {
        const raw = live.length > window ? live.slice(-window) : live;
        return { live: true, text: tailLines(stripAnsi(raw), lines) };
      }

      // Not live — hand back persisted history if the run exists at all. The
      // existence check is a bare row; the history comes from the bounded tail.
      const run = await prisma.run.findUnique({
        where: { id: req.params.id },
        select: { id: true },
      });
      if (!run) return reply.code(404).send({ error: 'Terminal not found.' });

      const text = await persistedTail(run.id, window);
      return { live: false, text: tailLines(stripAnsi(text), lines) };
    },
  );

  // Has this terminal gone quiet? The prerequisite for an orchestrator that
  // AWAITS a terminal instead of spending a turn per read_terminal poll (and
  // reading half-finished output). Reports how long ago the pty last produced
  // output and whether that exceeds `ms`.
  //
  // An ENDED run is idle unconditionally: it can never speak again, so a waiter
  // that treated "no output yet, still under threshold" as busy would hang.
  app.get<{ Params: { id: string }; Querystring: { ms?: string } }>(
    '/api/terminals/:id/idle',
    async (req, reply) => {
      const raw = req.query?.ms;
      let thresholdMs = DEFAULT_IDLE_MS;
      if (raw !== undefined) {
        // Only an ABSENT ms defaults. Anything present is validated: Number('')
        // is 0 and Number(['1','2']) (a repeated query key) is NaN, so both fall
        // outside the range and are rejected rather than silently defaulted —
        // an orchestrator must never think it waited on a threshold it didn't.
        const n = Number(raw);
        if (!Number.isInteger(n) || n < MIN_IDLE_MS || n > MAX_IDLE_MS) {
          return reply.code(400).send({
            error: `ms must be an integer between ${MIN_IDLE_MS} and ${MAX_IDLE_MS}.`,
          });
        }
        thresholdMs = n;
      }

      const activity = getRunActivity(req.params.id);
      const now = Date.now();

      if (activity && activity.live) {
        // Live: answered entirely from the in-memory record. This endpoint is
        // polled in a wait loop, so it must not cost a query per call — and the
        // Run row holds nothing the live answer needs.
        const idleMs =
          activity.lastOutputAt === null ? 0 : Math.max(0, now - activity.lastOutputAt);
        return {
          runId: req.params.id,
          live: true,
          lastOutputAt: isoOrNull(activity.lastOutputAt),
          idleMs,
          // A live run that has never produced a byte reports idleMs 0, and the
          // threshold floor is 100 — so it is never called idle here.
          idle: idleMs >= thresholdMs,
          exited: false,
          exitCode: null,
        };
      }

      // Not live: either the record is gone (the normal ended case) or it is in
      // the brief window between pty exit and the final log flush. Load the row —
      // it both proves the id ever existed and is the contract's source for the
      // exit code.
      const run = await prisma.run.findUnique({
        where: { id: req.params.id },
        select: { id: true, exitCode: true },
      });
      if (!run && !activity) return reply.code(404).send({ error: 'Terminal not found.' });

      const lastOutputAt = activity?.lastOutputAt ?? null;
      return {
        runId: req.params.id,
        live: false,
        // Only the in-memory record carries this timestamp. Once it is forgotten
        // the answer is null rather than a RunLog query to date output that has,
        // by definition, already finished — `idle` is true either way.
        lastOutputAt: isoOrNull(lastOutputAt),
        idleMs: lastOutputAt === null ? 0 : Math.max(0, now - lastOutputAt),
        idle: true,
        exited: true,
        // The row is authoritative, but during the post-exit window it is still
        // null (the status write lands after the final flush) while the record
        // already knows the code — so fall back to it rather than report null.
        exitCode: run?.exitCode ?? activity?.exitCode ?? null,
      };
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
