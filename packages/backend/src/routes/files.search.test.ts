import { describe, it, expect, vi, beforeAll, afterAll } from 'vitest';
import Fastify, { type FastifyInstance } from 'fastify';

// Hoisted so the (also-hoisted) vi.mock factory can read it.
const { SRC_DIR } = vi.hoisted(() => {
  const p = require('node:path');
  return { SRC_DIR: p.resolve(process.cwd(), 'src') }; // packages/backend/src
});

vi.mock('../db', () => ({
  prisma: {
    project: {
      findUnique: vi.fn().mockResolvedValue({ id: 'p1', name: 'backend', path: SRC_DIR }),
    },
  },
}));

import { fileRoutes } from './files';

let app: FastifyInstance;
beforeAll(async () => {
  app = Fastify();
  await app.register(fileRoutes);
  await app.ready();
});
afterAll(async () => {
  await app.close();
});

describe('GET /api/projects/:id/search', () => {
  it('finds a known symbol across files with path + line', async () => {
    const r = await app.inject({ method: 'GET', url: '/api/projects/p1/search?q=registerRun' });
    expect(r.statusCode).toBe(200);
    const body = r.json() as { matches: { path: string; line: number; text: string }[] };
    expect(body.matches.length).toBeGreaterThan(0);
    // runner.ts defines + brokerServer.ts uses registerRun
    expect(body.matches.some((m) => m.path.endsWith('runner.ts'))).toBe(true);
    const hit = body.matches.find((m) => m.text.includes('registerRun'))!;
    expect(hit.line).toBeGreaterThan(0);
    expect(hit.text).toContain('registerRun');
  });

  it('is case-insensitive', async () => {
    const r = await app.inject({ method: 'GET', url: '/api/projects/p1/search?q=REGISTERRUN' });
    expect((r.json() as { matches: unknown[] }).matches.length).toBeGreaterThan(0);
  });

  it('returns empty for a blank query', async () => {
    const r = await app.inject({ method: 'GET', url: '/api/projects/p1/search?q=' });
    expect(r.json()).toEqual({ matches: [], truncated: false });
  });

  it('skips node_modules / ignored dirs (no false hits from deps)', async () => {
    const r = await app.inject({ method: 'GET', url: '/api/projects/p1/search?q=registerRun' });
    const body = r.json() as { matches: { path: string }[] };
    expect(body.matches.every((m) => !m.path.includes('node_modules'))).toBe(true);
  });
});
