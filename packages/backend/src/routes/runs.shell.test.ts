import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from 'vitest';
import Fastify, { type FastifyInstance } from 'fastify';

// Mock the module boundaries so the shell route can be exercised without a real
// DB, pty runner, or elevation broker. Hoisted so the vi.mock factories can see them.
const { prismaMock, startShellMock, startAdminShellMock } = vi.hoisted(() => ({
  prismaMock: {
    project: { findUnique: vi.fn() },
    run: { create: vi.fn(), update: vi.fn(), findUnique: vi.fn() },
  },
  startShellMock: vi.fn(),
  startAdminShellMock: vi.fn(),
}));

vi.mock('../db', () => ({ prisma: prismaMock }));
vi.mock('../services/runner', () => ({
  startShell: (opts: unknown) => startShellMock(opts),
  startRun: vi.fn(),
  startClaude: vi.fn(),
  stopRun: vi.fn(),
  isRunning: vi.fn(),
}));
vi.mock('../services/brokerServer', () => ({
  startAdminShell: (opts: unknown) => startAdminShellMock(opts),
}));
vi.mock('../services/analyzer', () => ({
  AnalyzerError: class AnalyzerError extends Error {},
  diagnoseRun: vi.fn(),
}));
// Note: ../services/shells is NOT mocked — the real catalog/label logic runs.

import { runRoutes } from './runs';

const PROJECT = { id: 'p1', name: 'demo', path: 'C:\\proj\\demo' };

let app: FastifyInstance;
beforeAll(async () => {
  app = Fastify();
  await app.register(runRoutes);
  await app.ready();
});
afterAll(async () => {
  await app.close();
});
beforeEach(() => {
  vi.clearAllMocks();
  prismaMock.project.findUnique.mockResolvedValue(PROJECT);
  prismaMock.run.create.mockResolvedValue({ id: 'run1', kind: 'shell' });
  prismaMock.run.update.mockResolvedValue({});
  startShellMock.mockReturnValue({ pid: 4242 });
});

function openShell(body: Record<string, unknown>) {
  return app.inject({ method: 'POST', url: '/api/projects/p1/shell', payload: body });
}

describe('GET /api/shells', () => {
  it('returns a catalog of {kind,label,available} entries incl. PowerShell', async () => {
    const r = await app.inject({ method: 'GET', url: '/api/shells' });
    expect(r.statusCode).toBe(200);
    const { shells } = r.json() as {
      shells: { kind: string; label: string; available: boolean }[];
    };
    expect(Array.isArray(shells)).toBe(true);
    expect(shells.length).toBeGreaterThan(0);
    for (const s of shells) {
      expect(typeof s.kind).toBe('string');
      expect(typeof s.label).toBe('string');
      expect(typeof s.available).toBe('boolean');
    }
    expect(shells.some((s) => s.kind === 'powershell')).toBe(true);
  });
});

describe('POST /api/projects/:id/shell — shell kind', () => {
  it('opens Git Bash: startShell gets kind:gitbash and the Run is named "Git Bash"', async () => {
    const r = await openShell({ kind: 'gitbash' });
    expect(r.statusCode).toBe(201);
    expect(startShellMock).toHaveBeenCalledTimes(1);
    expect(startShellMock.mock.calls[0][0]).toMatchObject({ cwd: PROJECT.path, kind: 'gitbash' });
    expect(prismaMock.run.create.mock.calls[0][0].data).toMatchObject({
      kind: 'shell',
      name: 'Git Bash',
    });
  });

  it('opens CMD: kind:cmd, Run named "CMD"', async () => {
    await openShell({ kind: 'cmd' });
    expect(startShellMock.mock.calls[0][0]).toMatchObject({ kind: 'cmd' });
    expect(prismaMock.run.create.mock.calls[0][0].data.name).toBe('CMD');
  });

  it('defaults to PowerShell when no kind is given', async () => {
    await openShell({});
    expect(startShellMock.mock.calls[0][0]).toMatchObject({ kind: 'powershell' });
    expect(prismaMock.run.create.mock.calls[0][0].data.name).toBe('PowerShell');
  });

  it('ignores an unknown kind and falls back to PowerShell', async () => {
    await openShell({ kind: 'nonsense' });
    expect(startShellMock.mock.calls[0][0]).toMatchObject({ kind: 'powershell' });
  });

  it('rejects a non-PowerShell ADMIN shell with 400 and spawns nothing', async () => {
    const r = await openShell({ admin: true, kind: 'gitbash' });
    expect(r.statusCode).toBe(400);
    expect(startShellMock).not.toHaveBeenCalled();
    expect(startAdminShellMock).not.toHaveBeenCalled();
  });

  it('404s when the project does not exist', async () => {
    prismaMock.project.findUnique.mockResolvedValueOnce(null);
    const r = await openShell({ kind: 'cmd' });
    expect(r.statusCode).toBe(404);
    expect(startShellMock).not.toHaveBeenCalled();
  });
});
