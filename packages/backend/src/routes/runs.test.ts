import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import Fastify, { type FastifyBaseLogger, type FastifyInstance } from 'fastify';

// A real-ish transcript tree under a throwaway ARGUS_CLAUDE_DIR, so the "is the
// session still on disk?" check is exercised against actual files rather than a
// stub of itself.
const fx = vi.hoisted(() => ({ claudeHome: '', projectPath: '' }));

const h = vi.hoisted(() => ({
  // Every log CHARACTER the DB layer hands the route, whichever query carries
  // it — the quantity the unbounded-replay bug blew up.
  rows: [] as Array<{ id: string; runId: string; chunk: string; ts: Date }>,
  served: 0,
  projectFindUnique: vi.fn(),
  runFindFirst: vi.fn(),
  runFindUnique: vi.fn(),
  runCreate: vi.fn(),
  runUpdate: vi.fn(),
  logFindMany: vi.fn(),
  isRunning: vi.fn(),
  startClaude: vi.fn(),
  startRun: vi.fn(),
  startShell: vi.fn(),
  stopRun: vi.fn(),
  diagnoseRun: vi.fn(),
}));

vi.mock('../db', () => ({
  prisma: {
    project: { findUnique: h.projectFindUnique },
    run: {
      findFirst: h.runFindFirst,
      findUnique: h.runFindUnique,
      create: h.runCreate,
      update: h.runUpdate,
      delete: vi.fn(),
    },
    runCommand: { findFirst: vi.fn() },
    runLog: { findMany: h.logFindMany },
  },
}));

vi.mock('../services/runner', () => ({
  isRunning: h.isRunning,
  startClaude: h.startClaude,
  startRun: h.startRun,
  startShell: h.startShell,
  stopRun: h.stopRun,
}));

vi.mock('../services/brokerServer', () => ({ startAdminShell: vi.fn() }));

vi.mock('../services/analyzer', () => ({
  diagnoseRun: h.diagnoseRun,
  AnalyzerError: class AnalyzerError extends Error {},
}));

import { runRoutes } from './runs';

const SID = '11111111-2222-3333-4444-555555555555';
const ROW_CHARS = 400;
const ROW_COUNT = 1_000; // ~410 KB of history — the shape measured on a busy tab

/** Where Claude Code would keep this project's transcripts. */
function transcriptDir(): string {
  return path.join(fx.claudeHome, 'projects', fx.projectPath.replace(/[^A-Za-z0-9]/g, '-'));
}

function stubLogger() {
  const log = {
    fatal: () => {}, warn: () => {}, info: () => {}, debug: () => {}, trace: () => {}, error: () => {},
    child: () => log,
  };
  return log;
}

let app: FastifyInstance;
beforeAll(async () => {
  fx.claudeHome = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'narukami-runs-')));
  fx.projectPath = path.join(fx.claudeHome, 'proj');
  fs.mkdirSync(fx.projectPath, { recursive: true });
  process.env.ARGUS_CLAUDE_DIR = fx.claudeHome;
  fs.mkdirSync(transcriptDir(), { recursive: true });

  app = Fastify({ loggerInstance: stubLogger() as unknown as FastifyBaseLogger });
  await app.register(runRoutes);
  await app.ready();
});
afterAll(async () => {
  await app.close();
  delete process.env.ARGUS_CLAUDE_DIR;
  fs.rmSync(fx.claudeHome, { recursive: true, force: true });
});

beforeEach(() => {
  fs.rmSync(path.join(transcriptDir(), `${SID}.jsonl`), { force: true });

  h.rows = Array.from({ length: ROW_COUNT }, (_, i) => ({
    id: `l${String(i).padStart(4, '0')}`,
    runId: 'r1',
    chunk: `row ${i} ${'x'.repeat(ROW_CHARS)}\n`,
    ts: new Date(1_700_000_000_000 + i * 1000),
  }));
  h.served = 0;

  h.projectFindUnique.mockReset().mockResolvedValue({
    id: 'p1',
    name: 'proj',
    path: fx.projectPath,
  });
  h.runFindFirst.mockReset().mockResolvedValue(null);
  h.runCreate.mockReset().mockResolvedValue({ id: 'new-run', kind: 'claude' });
  h.runUpdate.mockReset().mockResolvedValue({});

  // Faithful stand-ins for the real queries: whatever the route asks for, it is
  // charged for. `include: { logs }` returns EVERY row, exactly like the DB.
  h.runFindUnique.mockReset().mockImplementation(async (args: {
    where: { id: string };
    include?: { logs?: unknown };
  }) => {
    if (args.where.id !== 'r1') return null;
    const base = {
      id: 'r1',
      projectId: 'p1',
      kind: 'command' as const,
      status: 'exited',
      exitCode: 1,
      claudeSessionId: null,
      command: { id: 'c1', command: 'npm test', cwd: null, shell: 'powershell', label: 'test' },
      project: { id: 'p1', name: 'proj', path: fx.projectPath },
    };
    if (args.include?.logs) {
      h.served += h.rows.reduce((n, r) => n + r.chunk.length, 0);
      return { ...base, logs: [...h.rows] };
    }
    return base;
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

  h.isRunning.mockReset().mockReturnValue(false);
  h.startClaude.mockReset().mockReturnValue({ pid: 4242, sessionId: SID });
  h.startRun.mockReset().mockReturnValue({ pid: 1 });
  h.startShell.mockReset().mockReturnValue({ pid: 2 });
  h.stopRun.mockReset().mockReturnValue(false);
  h.diagnoseRun.mockReset().mockResolvedValue('because it failed');
});

// ── item 17: Continue is guarded on both ends ───────────────────────────────

describe('POST /api/projects/:id/claude — Continue', () => {
  it('refuses to resume a session a LIVE tab is still writing', async () => {
    h.runFindFirst.mockResolvedValue({ id: 'run-live', claudeSessionId: SID });
    h.isRunning.mockImplementation((id: string) => id === 'run-live');
    fs.writeFileSync(path.join(transcriptDir(), `${SID}.jsonl`), '{}\n');

    const res = await app.inject({
      method: 'POST',
      url: '/api/projects/p1/claude',
      payload: { continue: true },
    });

    // Two `claude --resume <same id>` processes writing one transcript, and two
    // Run rows claiming one session id — refuse, and name the tab to focus.
    expect(res.statusCode).toBe(409);
    expect(res.json().runId).toBe('run-live');
    expect(h.startClaude).not.toHaveBeenCalled();
    expect(h.runCreate).not.toHaveBeenCalled();
  });

  it('resumes the newest ENDED session by id when its transcript is on disk', async () => {
    h.runFindFirst.mockResolvedValue({ id: 'run-old', claudeSessionId: SID });
    fs.writeFileSync(path.join(transcriptDir(), `${SID}.jsonl`), '{}\n');

    const res = await app.inject({
      method: 'POST',
      url: '/api/projects/p1/claude',
      payload: { continue: true },
    });

    expect(res.statusCode).toBe(201);
    expect(h.startClaude).toHaveBeenCalledWith(
      expect.objectContaining({ resumeSessionId: SID, initInput: undefined }),
    );
    expect(res.json().resumed).toBe(true);
  });

  it('starts a FRESH session when the transcript is gone from disk', async () => {
    h.runFindFirst.mockResolvedValue({ id: 'run-old', claudeSessionId: SID });
    // No transcript written → `claude --resume <id>` would die with a raw CLI
    // error (buildClaudeArgs emits --resume unconditionally, no fallback).

    const res = await app.inject({
      method: 'POST',
      url: '/api/projects/p1/claude',
      payload: { continue: true },
    });

    expect(res.statusCode).toBe(201);
    expect(h.startClaude).toHaveBeenCalledWith(
      expect.objectContaining({ resumeSessionId: undefined, initInput: '/effort ultracode' }),
    );
    const body = res.json();
    expect(body.resumed).toBe(false);
    expect(String(body.notice)).toMatch(/no longer on disk/i);
  });

  it('leaves the fresh-launch path untouched', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/api/projects/p1/claude',
      payload: { effort: 'high' },
    });
    expect(res.statusCode).toBe(201);
    expect(h.runFindFirst).not.toHaveBeenCalled();
    expect(h.startClaude).toHaveBeenCalledWith(
      expect.objectContaining({ resumeSessionId: undefined, initInput: '/effort high' }),
    );
  });
});

// ── item 4: bounded RunLog replay ───────────────────────────────────────────

describe('GET /api/runs/:runId', () => {
  it('bounds the replayed history instead of returning every log row', async () => {
    const res = await app.inject({ method: 'GET', url: '/api/runs/r1' });
    expect(res.statusCode).toBe(200);
    const body = res.json();

    // Still a usable replay: the TAIL of the run, in chronological order.
    const text = (body.logs as Array<{ chunk: string }>).map((l) => l.chunk).join('');
    expect(text).toContain('row 999');
    expect(text).not.toContain('row 0 ');
    expect(text).toMatch(/earlier output truncated/);
    expect(body.logsTruncated).toBe(true);

    // The bug: every row of a measured 2.3 MB history materialized as Prisma
    // objects on a route the frontend hits on every Claude tab mount, every
    // reconnect and in the UAC poll loop.
    expect(h.served).toBeLessThan(600_000);
    expect(text.length).toBeLessThan(600_000);
  });

  it('skips the log query entirely for ?logs=0', async () => {
    const res = await app.inject({ method: 'GET', url: '/api/runs/r1?logs=0' });
    expect(res.statusCode).toBe(200);
    expect(h.logFindMany).not.toHaveBeenCalled();
    expect(h.served).toBe(0);
    const body = res.json();
    expect(body.logs).toBeUndefined();
    expect(body.logsOmitted).toBe(true);
    expect(body.live).toBe(false);
  });

  it('404s for an unknown run', async () => {
    const res = await app.inject({ method: 'GET', url: '/api/runs/nope' });
    expect(res.statusCode).toBe(404);
    expect(h.served).toBe(0);
  });
});

describe('POST /api/runs/:runId/diagnose', () => {
  it('feeds the analyzer a bounded tail, not the whole history', async () => {
    const res = await app.inject({ method: 'POST', url: '/api/runs/r1/diagnose' });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ explanation: 'because it failed' });

    const output = h.diagnoseRun.mock.calls[0][2] as string;
    // diagnoseRun only ever prompts with output.slice(-12000) — reading the
    // whole table to throw all but the last 12 KB away is pure waste.
    expect(output).toContain('row 999');
    expect(output.length).toBeLessThan(200_000);
    expect(h.served).toBeLessThan(200_000);
  });
});
