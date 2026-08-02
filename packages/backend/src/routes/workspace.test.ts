import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import Fastify, { type FastifyBaseLogger, type FastifyInstance } from 'fastify';

// The secret the audit proved was leaking: aiProvider stores the raw Anthropic
// key in the SAME AppSetting table /api/workspace used to dump wholesale.
const SECRET = 'sk-ant-api03-THIS-MUST-NOT-LEAK-1234';

const h = vi.hoisted(() => ({
  rows: [] as Array<{ key: string; value: string }>,
  runFindMany: vi.fn(),
  upsert: vi.fn(),
  transaction: vi.fn(),
  isRunning: vi.fn(),
}));

vi.mock('../db', () => ({
  prisma: {
    run: { findMany: h.runFindMany },
    appSetting: {
      // Mimics Prisma's `where: { key: { in: [...] } }`, so a test can tell an
      // allowlisted read apart from a full-table dump.
      findMany: vi.fn(async (args?: { where?: { key?: { in?: string[] } } }) => {
        const allow = args?.where?.key?.in;
        return allow ? h.rows.filter((r) => allow.includes(r.key)) : h.rows;
      }),
      upsert: h.upsert,
    },
    $transaction: h.transaction,
  },
}));

vi.mock('../services/runner', () => ({ isRunning: h.isRunning }));

import { workspaceRoutes } from './workspace';

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
  await app.register(workspaceRoutes);
  await app.ready();
});
afterAll(async () => {
  await app.close();
});

beforeEach(() => {
  h.rows = [
    { key: 'ui', value: JSON.stringify({ view: 'runner', dockHeight: 300 }) },
    { key: 'prefs', value: JSON.stringify({ notifyOnExit: true }) },
    {
      key: 'aiProvider',
      value: JSON.stringify({ provider: 'api-key', apiKey: SECRET, baseUrl: '', defaultEffort: 'ultracode' }),
    },
    { key: 'eodDigest:abc123', value: JSON.stringify({ markdown: 'x'.repeat(2000) }) },
  ];
  h.runFindMany.mockReset().mockResolvedValue([]);
  h.upsert.mockReset().mockReturnValue({});
  h.transaction.mockReset().mockResolvedValue([]);
  h.isRunning.mockReset().mockReturnValue(false);
});

describe('GET /api/workspace', () => {
  it('never returns the stored Anthropic API key', async () => {
    const res = await app.inject({ method: 'GET', url: '/api/workspace' });
    expect(res.statusCode).toBe(200);
    expect(res.payload).not.toContain(SECRET);
    expect(res.json().settings.aiProvider).toBeUndefined();
  });

  it('omits the EOD digest cache rows', async () => {
    const res = await app.inject({ method: 'GET', url: '/api/workspace' });
    const keys = Object.keys(res.json().settings);
    expect(keys.some((k) => k.startsWith('eodDigest:'))).toBe(false);
  });

  it('still returns the UI settings the app restores on boot', async () => {
    const res = await app.inject({ method: 'GET', url: '/api/workspace' });
    const { settings } = res.json();
    expect(settings.ui).toEqual({ view: 'runner', dockHeight: 300 });
    expect(settings.prefs).toEqual({ notifyOnExit: true });
  });

  it('falls back to the raw string when a value is not JSON', async () => {
    h.rows = [{ key: 'ui', value: 'not json' }];
    const res = await app.inject({ method: 'GET', url: '/api/workspace' });
    expect(res.json().settings.ui).toBe('not json');
  });

  it('maps docked runs with their live status', async () => {
    h.runFindMany.mockResolvedValue([
      {
        id: 'r1',
        projectId: 'p1',
        project: { name: 'narukami' },
        command: { label: 'dev' },
        kind: 'command',
        name: null,
      },
    ]);
    h.isRunning.mockReturnValue(true);
    const res = await app.inject({ method: 'GET', url: '/api/workspace' });
    expect(res.json().runs).toEqual([
      {
        runId: 'r1',
        projectId: 'p1',
        projectName: 'narukami',
        kind: 'command',
        name: null,
        label: 'dev',
        live: true,
        status: 'running',
      },
    ]);
  });
});

describe('POST /api/settings', () => {
  it('saves valid keys', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/api/settings',
      payload: { ui: { view: 'eod' }, prefs: { notifyOnExit: false } },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ ok: true, saved: 2 });
    expect(h.transaction).toHaveBeenCalledTimes(1);
  });

  it('rejects a non-object body', async () => {
    const res = await app.inject({ method: 'POST', url: '/api/settings', payload: [1, 2] });
    expect(res.statusCode).toBe(400);
    expect(h.transaction).not.toHaveBeenCalled();
  });

  it('rejects more keys than the ceiling', async () => {
    const body: Record<string, unknown> = {};
    for (let i = 0; i < 33; i += 1) body[`k${i}`] = i;
    const res = await app.inject({ method: 'POST', url: '/api/settings', payload: body });
    expect(res.statusCode).toBe(400);
    expect(h.transaction).not.toHaveBeenCalled();
  });

  it('rejects a malformed key name', async () => {
    const res = await app.inject({ method: 'POST', url: '/api/settings', payload: { 'has space': 1 } });
    expect(res.statusCode).toBe(400);
    expect(h.transaction).not.toHaveBeenCalled();
  });

  it('rejects an oversized value', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/api/settings',
      payload: { ui: { blob: 'x'.repeat(70_000) } },
    });
    expect(res.statusCode).toBe(400);
    expect(h.transaction).not.toHaveBeenCalled();
  });

  it('refuses to write the AI provider secret through the generic store', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/api/settings',
      payload: { aiProvider: { provider: 'api-key', apiKey: SECRET } },
    });
    expect(res.statusCode).toBe(400);
    expect(res.json().error).toMatch(/api\/settings\/ai/);
    expect(h.transaction).not.toHaveBeenCalled();
  });
});
