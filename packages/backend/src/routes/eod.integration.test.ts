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
}));

vi.mock('../db', () => ({
  prisma: {
    project: { findMany: h.projectFindMany },
    run: { findMany: h.runFindMany },
    eodReport: {
      upsert: h.upsert,
      findMany: vi.fn().mockResolvedValue([]),
      findUnique: vi.fn().mockResolvedValue(null),
      delete: vi.fn().mockResolvedValue({}),
    },
  },
}));

vi.mock('../services/eodActivity', () => ({
  collectActiveProjects: h.collectActiveProjects,
  claudeSessionActivity: () => new Map(),
  collectSessionContext: () => new Map(),
  normPath: (p: string) => String(p || '').replace(/\\/g, '/').replace(/\/+$/, '').toLowerCase(),
  prettyName: (p: string) => String(p || '').replace(/\\/g, '/').split('/').filter(Boolean).pop() || p,
}));

vi.mock('../services/analyzer', () => {
  class AnalyzerError extends Error {}
  return { generateEodReport: h.generateEodReport, AnalyzerError };
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
