import { describe, it, expect, vi, beforeAll, afterAll, beforeEach } from 'vitest';
import Fastify, { type FastifyBaseLogger, type FastifyInstance } from 'fastify';

// Counts every log CHARACTER the DB layer hands the route, whichever query it
// arrives through — that is the quantity the unbounded-replay bug blew up.
const h = vi.hoisted(() => ({
  rows: [] as Array<{ id: string; runId: string; chunk: string; ts: Date }>,
  served: 0,
  runFindUnique: vi.fn(),
  logFindMany: vi.fn(),
  getLiveTranscriptTail: vi.fn(),
  getRunActivity: vi.fn(),
  isRunning: vi.fn(),
  liveRunIds: vi.fn(),
  writeToRun: vi.fn(),
}));

vi.mock('../db', () => ({
  prisma: {
    run: { findUnique: h.runFindUnique, findMany: vi.fn() },
    runLog: { findMany: h.logFindMany },
  },
}));

// Keep the REAL pure helpers (stripAnsi/tailLines are under test below); stub
// only the process-touching surface.
vi.mock('../services/runner', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../services/runner')>()),
  getLiveTranscriptTail: h.getLiveTranscriptTail,
  getRunActivity: h.getRunActivity,
  isRunning: h.isRunning,
  liveRunIds: h.liveRunIds,
  writeToRun: h.writeToRun,
}));

import { makeRateLimiter, terminalRoutes } from './terminals';
import { tailLines } from '../services/runner';

describe('tailLines', () => {
  it('returns the last n lines', () => {
    expect(tailLines('a\nb\nc\nd', 2)).toBe('c\nd');
  });
  it('normalizes CRLF/CR and drops trailing blank lines', () => {
    expect(tailLines('a\r\nb\r\n\r\n', 5)).toBe('a\nb');
    expect(tailLines('x\ry\r', 5)).toBe('x\ny');
  });
  it('returns everything when n exceeds line count', () => {
    expect(tailLines('a\nb', 10)).toBe('a\nb');
  });
  it('returns empty string for n<=0', () => {
    expect(tailLines('a\nb', 0)).toBe('');
  });
});

describe('makeRateLimiter', () => {
  it('allows up to max within the window, then blocks', () => {
    const allow = makeRateLimiter(3, 1000);
    expect(allow('a', 0)).toBe(true);
    expect(allow('a', 10)).toBe(true);
    expect(allow('a', 20)).toBe(true);
    expect(allow('a', 30)).toBe(false); // 4th in window -> blocked
  });

  it('recovers once the window slides past old hits', () => {
    const allow = makeRateLimiter(2, 1000);
    expect(allow('a', 0)).toBe(true);
    expect(allow('a', 100)).toBe(true);
    expect(allow('a', 200)).toBe(false);
    // At t=1101 the hit at t=100 is still in-window (1101-100=1001>1000 -> expired),
    // and t=0 expired long ago, so one slot frees up.
    expect(allow('a', 1101)).toBe(true);
  });

  it('tracks keys independently', () => {
    const allow = makeRateLimiter(1, 1000);
    expect(allow('a', 0)).toBe(true);
    expect(allow('b', 0)).toBe(true); // different key, own budget
    expect(allow('a', 1)).toBe(false);
  });

  it('evicts a fully-expired key rather than carrying stale hits forward', () => {
    // Exercises the map-eviction path added to stop unbounded growth (one entry
    // per distinct terminal id ever targeted): once a key's window fully elapses,
    // it is deleted and a later hit starts fresh.
    const allow = makeRateLimiter(1, 100);
    expect(allow('t', 0)).toBe(true);
    expect(allow('t', 50)).toBe(false); // still in window
    expect(allow('t', 250)).toBe(true); // window elapsed → evicted → fresh slot
  });
});

// ── GET /api/terminals/:id/read — the dead-run branch ────────────────────────

const ROW_CHARS = 400;
const ROW_COUNT = 1_000; // ~410 KB of history, the shape measured on a busy tab

function stubLogger() {
  const log = {
    fatal: () => {}, warn: () => {}, info: () => {}, debug: () => {}, trace: () => {}, error: () => {},
    child: () => log,
  };
  return log;
}

let app: FastifyInstance;
beforeAll(async () => {
  app = Fastify({ loggerInstance: stubLogger() as unknown as FastifyBaseLogger });
  await app.register(terminalRoutes);
  await app.ready();
});
afterAll(async () => {
  await app.close();
});

beforeEach(() => {
  h.rows = Array.from({ length: ROW_COUNT }, (_, i) => ({
    id: `l${String(i).padStart(4, '0')}`,
    runId: 'r1',
    chunk: `row ${i} ${'x'.repeat(ROW_CHARS)}\n`,
    ts: new Date(1_700_000_000_000 + i * 1000),
  }));
  h.served = 0;

  // Faithful stand-ins for the real queries: whatever the route asks for, it is
  // charged for. `include: { logs }` hands back EVERY row (what the DB does).
  h.runFindUnique.mockReset().mockImplementation(async (args: {
    where: { id: string };
    include?: { logs?: unknown };
  }) => {
    if (args.where.id !== 'r1') return null;
    if (args.include?.logs) {
      h.served += h.rows.reduce((n, r) => n + r.chunk.length, 0);
      return { id: 'r1', logs: [...h.rows] };
    }
    return { id: 'r1' };
  });

  h.logFindMany.mockReset().mockImplementation(async (args: {
    where: { runId: string };
    skip?: number;
    take?: number;
  }) => {
    if (args.where.runId !== 'r1') return [];
    const desc = [...h.rows].reverse(); // orderBy ts desc
    const page = desc.slice(args.skip ?? 0, (args.skip ?? 0) + (args.take ?? desc.length));
    h.served += page.reduce((n, r) => n + r.chunk.length, 0);
    return page;
  });

  h.getLiveTranscriptTail.mockReset().mockReturnValue(null); // not live → DB branch
  h.getRunActivity.mockReset().mockReturnValue(null); // record forgotten → DB branch
  h.isRunning.mockReset().mockReturnValue(false);
  h.liveRunIds.mockReset().mockReturnValue([]);
  h.writeToRun.mockReset().mockReturnValue(true);
});

describe('GET /api/terminals/:id/read (dead run)', () => {
  it('returns the requested tail without materializing the whole history', async () => {
    const res = await app.inject({ method: 'GET', url: '/api/terminals/r1/read?lines=5' });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.live).toBe(false);

    // Correctness: still exactly the last 5 lines of the run.
    const lines = body.text.split('\n');
    expect(lines).toHaveLength(5);
    expect(lines[4]).toContain('row 999');
    expect(lines[0]).toContain('row 995');

    // The bug: the dead branch loaded EVERY RunLog row (here ~410 KB) to return
    // ~2 KB of tail, on a path an orchestrator polls. The live branch already
    // budgets max(64 KB, lines*512); the dead one must not exceed that by more
    // than one page of rows.
    expect(h.served).toBeLessThan(150_000);
  });

  it('still 404s for a terminal that never existed', async () => {
    const res = await app.inject({ method: 'GET', url: '/api/terminals/nope/read' });
    expect(res.statusCode).toBe(404);
    expect(h.served).toBe(0);
  });

  it('serves the live transcript without touching the DB at all', async () => {
    h.getLiveTranscriptTail.mockReturnValue('alpha\nbravo\ncharlie\n');
    const res = await app.inject({ method: 'GET', url: '/api/terminals/r1/read?lines=2' });
    expect(res.json()).toEqual({ live: true, text: 'bravo\ncharlie' });
    expect(h.runFindUnique).not.toHaveBeenCalled();
    expect(h.logFindMany).not.toHaveBeenCalled();
  });
});

// ── GET /api/terminals/:id/idle ──────────────────────────────────────────────
// The prerequisite for an orchestrator AWAITING a terminal instead of burning a
// turn per poll on read_terminal. The invariants that matter: a terminal that
// just spoke is NOT idle, one that has been quiet past the threshold IS, and a
// terminal that has ENDED is idle unconditionally (otherwise a waiter hangs on
// a pty that can never speak again).

describe('GET /api/terminals/:id/idle', () => {
  beforeEach(() => {
    // A row exists for r1 and carries the authoritative exit code once ended.
    h.runFindUnique.mockReset().mockImplementation(async (args: { where: { id: string } }) =>
      args.where.id === 'r1' ? { id: 'r1', exitCode: 3 } : null,
    );
  });

  it('reports a terminal that just produced output as busy', async () => {
    h.getRunActivity.mockReturnValue({ live: true, lastOutputAt: Date.now(), exitCode: null });
    const res = await app.inject({ method: 'GET', url: '/api/terminals/r1/idle' });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body).toMatchObject({ runId: 'r1', live: true, idle: false, exited: false, exitCode: null });
    expect(body.idleMs).toBeLessThan(1500);
    expect(typeof body.lastOutputAt).toBe('string');
    // A polled path: the live answer is fully in memory, so it must not query.
    expect(h.runFindUnique).not.toHaveBeenCalled();
  });

  it('reports a terminal quiet past the threshold as idle', async () => {
    h.getRunActivity.mockReturnValue({
      live: true,
      lastOutputAt: Date.now() - 5_000,
      exitCode: null,
    });
    const res = await app.inject({ method: 'GET', url: '/api/terminals/r1/idle' });
    const body = res.json();
    expect(body.idle).toBe(true);
    expect(body.live).toBe(true);
    expect(body.idleMs).toBeGreaterThanOrEqual(5_000);
  });

  it('honours an explicit ms threshold in both directions', async () => {
    h.getRunActivity.mockReturnValue({
      live: true,
      lastOutputAt: Date.now() - 800,
      exitCode: null,
    });
    const strict = await app.inject({ method: 'GET', url: '/api/terminals/r1/idle?ms=3000' });
    expect(strict.json().idle).toBe(false); // 800ms of quiet is not 3s of quiet
    const loose = await app.inject({ method: 'GET', url: '/api/terminals/r1/idle?ms=500' });
    expect(loose.json().idle).toBe(true);
  });

  it('never calls a live terminal that has not spoken yet idle', async () => {
    h.getRunActivity.mockReturnValue({ live: true, lastOutputAt: null, exitCode: null });
    const body = (await app.inject({ method: 'GET', url: '/api/terminals/r1/idle' })).json();
    expect(body).toMatchObject({ live: true, lastOutputAt: null, idleMs: 0, idle: false });
  });

  it('calls an ended run idle and sources its exit code from the row', async () => {
    h.getRunActivity.mockReturnValue(null); // record already forgotten
    const res = await app.inject({ method: 'GET', url: '/api/terminals/r1/idle?ms=600000' });
    expect(res.statusCode).toBe(200);
    // Idle even at the maximum threshold: deadness beats the clock.
    expect(res.json()).toEqual({
      runId: 'r1',
      live: false,
      lastOutputAt: null,
      idleMs: 0,
      idle: true,
      exited: true,
      exitCode: 3,
    });
  });

  it('serves the in-memory final state during the post-exit window', async () => {
    // The record survives between pty exit and the final log flush; the row's
    // exitCode is still null then, so the in-memory one fills the gap.
    h.runFindUnique.mockImplementation(async () => ({ id: 'r1', exitCode: null }));
    const t = Date.now() - 50;
    h.getRunActivity.mockReturnValue({ live: false, lastOutputAt: t, exitCode: 137 });
    const body = (await app.inject({ method: 'GET', url: '/api/terminals/r1/idle' })).json();
    expect(body).toMatchObject({ live: false, exited: true, idle: true, exitCode: 137 });
    expect(body.lastOutputAt).toBe(new Date(t).toISOString());
    expect(body.idleMs).toBeGreaterThanOrEqual(50);
  });

  it('404s for an unknown terminal', async () => {
    h.getRunActivity.mockReturnValue(null);
    const res = await app.inject({ method: 'GET', url: '/api/terminals/nope/idle' });
    expect(res.statusCode).toBe(404);
    expect(res.json().error).toBeTruthy();
    // Fastify answers an UNREGISTERED route with a 404 too, so assert the
    // handler actually ran — otherwise this passes with no route at all.
    expect(h.getRunActivity).toHaveBeenCalledWith('nope');
    expect(h.runFindUnique).toHaveBeenCalled();
  });

  it('400s on a malformed or out-of-range ms', async () => {
    h.getRunActivity.mockReturnValue({ live: true, lastOutputAt: Date.now(), exitCode: null });
    for (const ms of ['abc', '99', '600001', '1.5', '-1000', '']) {
      const res = await app.inject({ method: 'GET', url: `/api/terminals/r1/idle?ms=${ms}` });
      expect([ms, res.statusCode]).toEqual([ms, 400]);
    }
  });
});
