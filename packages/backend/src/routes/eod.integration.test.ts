import { describe, it, expect, vi, beforeAll, afterAll, beforeEach } from 'vitest';
import Fastify, { type FastifyBaseLogger, type FastifyInstance } from 'fastify';

// Hoisted mocks so the (also-hoisted) vi.mock factories can reference them. The
// date helpers (normalizeRange/boundsForRange/rangeKey/prettyRange) are the REAL
// ones from ./eod — this exercises exactly the range wiring we changed.
const h = vi.hoisted(() => ({
  upsert: vi.fn(),
  projectFindMany: vi.fn(),
  runFindMany: vi.fn(),
  collectActiveProjects: vi.fn(),
  generateEodReport: vi.fn(),
  summarizeSession: vi.fn(),
  collectSessionsForRange: vi.fn(),
}));

vi.mock('../db', () => ({
  prisma: {
    project: { findMany: h.projectFindMany },
    run: { findMany: h.runFindMany },
    // The per-session digest cache lives in AppSetting.
    appSetting: {
      findUnique: vi.fn().mockResolvedValue(null),
      upsert: vi.fn().mockResolvedValue({}),
      deleteMany: vi.fn().mockResolvedValue({ count: 0 }),
    },
    eodReport: {
      upsert: h.upsert,
      findMany: vi.fn().mockResolvedValue([]),
      findUnique: vi.fn().mockResolvedValue(null),
      delete: vi.fn().mockResolvedValue({}),
    },
  },
}));

// Keep the route hermetic: without this it would stream the machine's REAL
// ~/.claude transcripts (tens of MB) and try to spawn `claude -p` per session.
vi.mock('../services/eodSessions', async () => {
  // Only the filesystem-touching collector is stubbed; isSubstantiveSession and
  // sessionSubstance stay REAL so the route's stub-filtering is genuinely tested.
  const actual = await vi.importActual<typeof import('../services/eodSessions')>(
    '../services/eodSessions',
  );
  return {
    ...actual,
    collectSessionsForRange: h.collectSessionsForRange,
    sessionToPromptText: (r: { sessionId: string }) => `SESSION ${r.sessionId}`,
  };
});

vi.mock('../services/eodActivity', () => ({
  collectActiveProjects: h.collectActiveProjects,
  claudeSessionActivity: () => new Map(),
  collectSessionContext: () => new Map(),
  normPath: (p: string) => String(p || '').replace(/\\/g, '/').replace(/\/+$/, '').toLowerCase(),
  prettyName: (p: string) => String(p || '').replace(/\\/g, '/').split('/').filter(Boolean).pop() || p,
}));

vi.mock('../services/analyzer', () => {
  class AnalyzerError extends Error {}
  return { generateEodReport: h.generateEodReport, summarizeSession: h.summarizeSession, AnalyzerError };
});

vi.mock('../services/gitLog', () => ({
  gitCommitsForDay: vi.fn().mockResolvedValue([]),
  commitsToText: () => '',
}));

import { eodRoutes } from './eod';

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
  await app.register(eodRoutes);
  await app.ready();
});
afterAll(async () => {
  await app.close();
});

beforeEach(() => {
  h.upsert.mockReset();
  h.projectFindMany.mockReset().mockResolvedValue([{ id: 'p1', name: 'Demo', path: 'C:/repo/demo' }]);
  h.runFindMany.mockReset().mockResolvedValue([]);
  h.collectActiveProjects.mockReset().mockResolvedValue([
    { name: 'Demo', path: 'C:/repo/demo', registered: true, projectId: 'p1', sessions: 1, runs: 0, commits: 2 },
  ]);
  h.generateEodReport.mockReset().mockResolvedValue('## EOD -- July 1–11, 2026\n### Demo\n-   Did stuff');
  // Two SUBSTANTIVE sessions for the selected project, so the digest layer has
  // work to do. These need the real record shape — the route now filters on
  // files/tools/prompts/elapsed to drop the one-shot stubs that headless
  // `claude -p` calls leave behind.
  const session = (id: string, endedAt: string) => ({
    sessionId: id,
    file: `${id}.jsonl`,
    cwd: 'C:/repo/demo',
    title: `title ${id}`,
    gitBranch: 'main',
    startedAt: endedAt,
    endedAt,
    bytes: 1000,
    userPrompts: ['do the thing', 'and the other thing'],
    assistantNotes: ['did it'],
    tools: [{ name: 'Edit', count: 12 }],
    files: ['src/a.ts', 'src/b.ts'],
    activeMs: 20 * 60_000,
    truncated: false,
  });
  h.collectSessionsForRange.mockReset().mockResolvedValue(
    new Map([
      ['c:/repo/demo', [session('s1', '2026-07-01T10:00:00Z'), session('s2', '2026-07-01T18:00:00Z')]],
    ]),
  );
  h.summarizeSession.mockReset().mockImplementation((_cwd, _name, text: string) => `digest of ${text}`);
});

describe('POST /api/eod/report — session digest layer', () => {
  it('digests EACH session, then hands the digests to the roll-up', async () => {
    const r = await app.inject({
      method: 'POST',
      url: '/api/eod/report',
      payload: { from: '2026-07-01', to: '2026-07-01', paths: ['C:/repo/demo'] },
    });
    expect(r.statusCode).toBe(201);

    // Layer 1 ran once per session…
    expect(h.summarizeSession).toHaveBeenCalledTimes(2);
    // …and layer 2 received those digests, in order, with the real session count.
    const projects = h.generateEodReport.mock.calls[0][2] as Array<{
      sessionDigests: string[];
      sessions: number;
      sessionsOmitted: number;
    }>;
    expect(projects[0].sessions).toBe(2);
    expect(projects[0].sessionsOmitted).toBe(0);
    expect(projects[0].sessionDigests).toEqual(['digest of SESSION s1', 'digest of SESSION s2']);
  });

  it('skips the one-shot stubs that report generation itself leaves behind', async () => {
    // 1 real session + 3 headless stubs (a prompt, no files, no elapsed time) —
    // the shape `claude -p` writes, including this report's own digest calls.
    const stub = (id: string) => ({
      sessionId: id, file: `${id}.jsonl`, cwd: 'C:/repo/demo', title: null, gitBranch: null,
      startedAt: '2026-07-01T23:00:00Z', endedAt: '2026-07-01T23:00:00Z', bytes: 100,
      userPrompts: ['summarize this session'], assistantNotes: [], tools: [{ name: 'Read', count: 1 }],
      files: [], activeMs: 0, truncated: false,
    });
    const real = {
      sessionId: 'real', file: 'real.jsonl', cwd: 'C:/repo/demo', title: 'Real work', gitBranch: 'main',
      startedAt: '2026-07-01T09:00:00Z', endedAt: '2026-07-01T17:00:00Z', bytes: 5000,
      userPrompts: ['build the thing'], assistantNotes: ['built it'],
      tools: [{ name: 'Edit', count: 40 }], files: ['src/a.ts'], activeMs: 60 * 60_000, truncated: false,
    };
    h.collectSessionsForRange.mockResolvedValue(
      new Map([['c:/repo/demo', [real, stub('n1'), stub('n2'), stub('n3')]]]),
    );

    const r = await app.inject({
      method: 'POST',
      url: '/api/eod/report',
      payload: { from: '2026-07-01', to: '2026-07-01', paths: ['C:/repo/demo'] },
    });
    expect(r.statusCode).toBe(201);
    // Only the real session was digested — the stubs never reached Claude.
    expect(h.summarizeSession).toHaveBeenCalledTimes(1);
    const projects = h.generateEodReport.mock.calls[0][2] as Array<{ sessions: number; sessionsOmitted: number }>;
    expect(projects[0].sessions).toBe(1); // the count reported is of REAL sessions
    expect(projects[0].sessionsOmitted).toBe(0);
  });

  it('a failed session digest is skipped, not fatal — the report still generates', async () => {
    h.summarizeSession
      .mockRejectedValueOnce(new Error('claude died'))
      .mockResolvedValueOnce('digest of SESSION s2');
    const r = await app.inject({
      method: 'POST',
      url: '/api/eod/report',
      payload: { from: '2026-07-01', to: '2026-07-01', paths: ['C:/repo/demo'] },
    });
    expect(r.statusCode).toBe(201);
    const projects = h.generateEodReport.mock.calls[0][2] as Array<{ sessionDigests: string[] }>;
    expect(projects[0].sessionDigests).toEqual(['digest of SESSION s2']);
  });
});

describe('GET /api/eod/active (range)', () => {
  it('windows on [from, to] and echoes {from, to, day=rangeKey}', async () => {
    const r = await app.inject({ method: 'GET', url: '/api/eod/active?from=2026-07-01&to=2026-07-11' });
    expect(r.statusCode).toBe(200);
    expect(r.json()).toMatchObject({ from: '2026-07-01', to: '2026-07-11', day: '2026-07-01_2026-07-11' });
    // The activity scan got the inclusive range bounds: July 1 00:00 → July 12 00:00.
    const opts = h.collectActiveProjects.mock.calls[0][0] as { start: Date; end: Date };
    expect(opts.start.getMonth()).toBe(6);
    expect(opts.start.getDate()).toBe(1);
    expect(opts.end.getDate()).toBe(12);
  });

  it('legacy ?day= still works (from === to, plain day key)', async () => {
    const r = await app.inject({ method: 'GET', url: '/api/eod/active?day=2026-07-06' });
    expect(r.json()).toMatchObject({ from: '2026-07-06', to: '2026-07-06', day: '2026-07-06' });
  });

  it('normalizes a reversed range (from > to → swapped)', async () => {
    const r = await app.inject({ method: 'GET', url: '/api/eod/active?from=2026-07-11&to=2026-07-01' });
    expect(r.json()).toMatchObject({ from: '2026-07-01', to: '2026-07-11' });
  });
});

describe('POST /api/eod/report (range)', () => {
  it('generates with the range heading and upserts under the range key', async () => {
    h.upsert.mockResolvedValue({
      id: 'r1', day: '2026-07-01_2026-07-11', markdown: '## EOD -- July 1–11, 2026',
      projects: '[{"name":"Demo","path":"C:/repo/demo"}]', createdAt: new Date(), updatedAt: new Date(),
    });
    const r = await app.inject({
      method: 'POST', url: '/api/eod/report',
      payload: { from: '2026-07-01', to: '2026-07-11', paths: ['C:/repo/demo'], note: 'shipped v2' },
    });
    expect(r.statusCode).toBe(201);
    // Heading uses the pretty range; storage key uses the range key.
    expect(h.generateEodReport.mock.calls[0][1]).toBe('July 1–11, 2026');
    expect((h.upsert.mock.calls[0][0] as { where: unknown }).where).toEqual({ day: '2026-07-01_2026-07-11' });
    expect(r.json()).toMatchObject({ id: 'r1', day: '2026-07-01_2026-07-11' });
  });

  it('single-day report keeps the plain day key (back-compat)', async () => {
    h.upsert.mockResolvedValue({
      id: 'r2', day: '2026-07-06', markdown: 'x', projects: '[]', createdAt: new Date(), updatedAt: new Date(),
    });
    await app.inject({
      method: 'POST', url: '/api/eod/report',
      payload: { from: '2026-07-06', to: '2026-07-06', paths: ['C:/repo/demo'] },
    });
    expect(h.generateEodReport.mock.calls[0][1]).toBe('July 6, 2026');
    expect((h.upsert.mock.calls[0][0] as { where: unknown }).where).toEqual({ day: '2026-07-06' });
  });

  it('400s when no paths are selected', async () => {
    const r = await app.inject({ method: 'POST', url: '/api/eod/report', payload: { from: '2026-07-01', to: '2026-07-11', paths: [] } });
    expect(r.statusCode).toBe(400);
    expect(h.generateEodReport).not.toHaveBeenCalled();
  });
});
