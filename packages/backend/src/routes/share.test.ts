import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from 'vitest';
import Fastify, { type FastifyInstance } from 'fastify';

// Mock the module boundaries so the route handlers can be exercised in isolation
// (no real DB, no pty runner, no token file). Hoisted so the (also-hoisted)
// vi.mock factories can reference them.
const { prismaMock, isRunningMock } = vi.hoisted(() => ({
  prismaMock: {
    appSetting: { upsert: vi.fn().mockResolvedValue({}) },
    project: { findUnique: vi.fn() },
    run: { findMany: vi.fn() },
  },
  isRunningMock: vi.fn(),
}));
vi.mock('../db', () => ({ prisma: prismaMock }));
vi.mock('../auth', () => ({ getToken: () => 'tkn-123' }));
vi.mock('../services/runner', () => ({ isRunning: (id: string) => isRunningMock(id) }));

import { shareRoutes } from './share';
import { setShareEnabled, setSharePort } from '../services/share';

let app: FastifyInstance;
beforeAll(async () => {
  app = Fastify();
  await app.register(shareRoutes);
  await app.ready();
});
afterAll(async () => {
  await app.close();
  setShareEnabled(false);
});
beforeEach(() => {
  vi.clearAllMocks();
});

describe('GET /api/share', () => {
  it('reports the runtime state + everything needed to build a QR', async () => {
    setShareEnabled(true);
    setSharePort(4321);
    const r = await app.inject({ method: 'GET', url: '/api/share' });
    expect(r.statusCode).toBe(200);
    const body = r.json() as { enabled: boolean; port: number; token: string; addresses: string[] };
    expect(body.enabled).toBe(true);
    expect(body.port).toBe(4321);
    expect(body.token).toBe('tkn-123');
    expect(Array.isArray(body.addresses)).toBe(true);
  });
});

describe('POST /api/share', () => {
  it('persists the flag and flags a restart when the desired state differs from runtime', async () => {
    setShareEnabled(false); // booted OFF
    const r = await app.inject({ method: 'POST', url: '/api/share', payload: { enabled: true } });
    expect(r.statusCode).toBe(200);
    expect(r.json()).toEqual({ enabled: true, needsRestart: true });
    expect(prismaMock.appSetting.upsert).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { key: 'phoneAccess' },
        create: { key: 'phoneAccess', value: 'true' },
        update: { value: 'true' },
      }),
    );
  });

  it('does not require a restart when the desired state already matches runtime', async () => {
    setShareEnabled(true); // already ON
    const r = await app.inject({ method: 'POST', url: '/api/share', payload: { enabled: true } });
    expect(r.json()).toEqual({ enabled: true, needsRestart: false });
  });

  it('coerces a missing/invalid body to disabled', async () => {
    setShareEnabled(false);
    const r = await app.inject({ method: 'POST', url: '/api/share', payload: {} });
    expect(r.json()).toEqual({ enabled: false, needsRestart: false });
    expect(prismaMock.appSetting.upsert).toHaveBeenCalledWith(
      expect.objectContaining({ create: { key: 'phoneAccess', value: 'false' } }),
    );
  });
});

describe('GET /api/projects/:id/processes', () => {
  it('404s for an unknown project', async () => {
    prismaMock.project.findUnique.mockResolvedValueOnce(null);
    const r = await app.inject({ method: 'GET', url: '/api/projects/nope/processes' });
    expect(r.statusCode).toBe(404);
  });

  it('maps runs to live status + human labels', async () => {
    prismaMock.project.findUnique.mockResolvedValueOnce({ id: 'p1', name: 'demo', path: '/tmp/demo' });
    prismaMock.run.findMany.mockResolvedValueOnce([
      { id: 'r1', kind: 'command', name: null, command: { label: 'dev' }, status: 'exited', exitCode: 0, startedAt: null, endedAt: null },
      { id: 'r2', kind: 'shell', name: 'my shell', command: null, status: 'killed', exitCode: null, startedAt: null, endedAt: null },
      { id: 'r3', kind: 'claude', name: null, command: null, status: 'exited', exitCode: 1, startedAt: null, endedAt: null },
    ]);
    isRunningMock.mockImplementation((id: string) => id === 'r1'); // only r1 is live

    const r = await app.inject({ method: 'GET', url: '/api/projects/p1/processes' });
    expect(r.statusCode).toBe(200);
    const body = r.json() as {
      project: { id: string; name: string };
      processes: { runId: string; label: string; live: boolean; status: string; exitCode: number | null }[];
    };
    expect(body.project).toMatchObject({ id: 'p1', name: 'demo' });
    expect(body.processes).toEqual([
      { runId: 'r1', kind: 'command', name: null, label: 'dev', live: true, status: 'running', exitCode: 0, startedAt: null, endedAt: null },
      { runId: 'r2', kind: 'shell', name: 'my shell', label: 'my shell', live: false, status: 'killed', exitCode: null, startedAt: null, endedAt: null },
      { runId: 'r3', kind: 'claude', name: null, label: 'claude', live: false, status: 'exited', exitCode: 1, startedAt: null, endedAt: null },
    ]);
  });
});

describe('GET /m', () => {
  it('serves the self-contained mobile page as HTML', async () => {
    const r = await app.inject({ method: 'GET', url: '/m' });
    expect(r.statusCode).toBe(200);
    expect(r.headers['content-type']).toContain('text/html');
    expect(r.body.startsWith('<!DOCTYPE html>')).toBe(true);
    expect(r.body).toContain('<title>NARUKAMI');
  });
});
