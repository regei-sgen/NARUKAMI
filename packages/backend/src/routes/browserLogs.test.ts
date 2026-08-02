import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import Fastify, { type FastifyBaseLogger, type FastifyInstance } from 'fastify';

const h = vi.hoisted(() => ({ findUnique: vi.fn() }));
vi.mock('../db', () => ({
  prisma: { project: { findUnique: h.findUnique }, appSetting: { findUnique: vi.fn() } },
}));

import { browserLogRoutes } from './browserLogs';
import { clearBrowserEvents, recordBrowserEvents } from '../services/browserLogs';

function stubLogger() {
  const log = {
    fatal: () => {}, warn: () => {}, info: () => {}, debug: () => {}, trace: () => {}, error: () => {},
    child: () => log,
  };
  return log;
}

const PID = 'proj-1';

function consoleCall(type: string, text: string): { method: string; params: unknown } {
  return { method: 'Runtime.consoleAPICalled', params: { type, args: [{ type: 'string', value: text }] } };
}

let app: FastifyInstance;
beforeAll(async () => {
  app = Fastify({ loggerInstance: stubLogger() as unknown as FastifyBaseLogger });
  await app.register(browserLogRoutes);
  await app.ready();
});
afterAll(async () => {
  await app.close();
});

beforeEach(() => {
  h.findUnique.mockReset().mockResolvedValue({ id: PID, name: 'demo', path: 'C:/demo' });
  clearBrowserEvents(PID);
});

const get = (q = ''): Promise<{ statusCode: number; json: () => never }> =>
  app.inject({ method: 'GET', url: `/api/projects/${PID}/browser-logs${q}` }) as never;

describe('GET /api/projects/:id/browser-logs', () => {
  it('404s for a project that does not exist', async () => {
    h.findUnique.mockResolvedValue(null);
    const res = await get();
    expect(res.statusCode).toBe(404);
  });

  it('returns an empty buffer with a cursor for a project that has captured nothing', async () => {
    const res = await get();
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ events: [] });
    expect(typeof (res.json() as unknown as { nextSeq: number }).nextSeq).toBe('number');
  });

  it('hands back the captured events and a resumable cursor', async () => {
    recordBrowserEvents(PID, [consoleCall('error', 'boom'), consoleCall('log', 'tick')]);
    const res = await get();
    expect(res.statusCode).toBe(200);
    const body = res.json() as unknown as {
      events: Array<{ seq: number; level: string; kind: string; text: string }>;
      nextSeq: number;
    };
    expect(body.events.map((e) => e.text)).toEqual(['boom', 'tick']);
    expect(body.events[0]).toMatchObject({ level: 'error', kind: 'console.error' });
    expect(body.nextSeq).toBe(body.events[body.events.length - 1].seq);
  });

  it('returns only events after `since`', async () => {
    recordBrowserEvents(PID, [consoleCall('log', 'old')]);
    const first = (await get()).json() as unknown as { nextSeq: number };
    recordBrowserEvents(PID, [consoleCall('log', 'new')]);
    const body = (await get(`?since=${first.nextSeq}`)).json() as unknown as {
      events: Array<{ text: string }>;
    };
    expect(body.events.map((e) => e.text)).toEqual(['new']);
  });

  it('filters by level and caps by limit', async () => {
    recordBrowserEvents(PID, [
      consoleCall('error', 'e1'),
      consoleCall('log', 'l1'),
      consoleCall('error', 'e2'),
    ]);
    const errs = (await get('?level=error')).json() as unknown as { events: Array<{ text: string }> };
    expect(errs.events.map((e) => e.text)).toEqual(['e1', 'e2']);

    const one = (await get('?limit=1')).json() as unknown as { events: Array<{ text: string }> };
    expect(one.events.map((e) => e.text)).toEqual(['e2']);
  });

  it('treats absent and empty query params as unset', async () => {
    recordBrowserEvents(PID, [consoleCall('log', 'x')]);
    const res = await get('?since=&level=&limit=');
    expect(res.statusCode).toBe(200);
    expect((res.json() as unknown as { events: unknown[] }).events).toHaveLength(1);
  });

  it('400s on a garbage since', async () => {
    for (const q of ['?since=abc', '?since=-1', '?since=1.5', '?since=1&since=2']) {
      const res = await get(q);
      expect(res.statusCode, q).toBe(400);
    }
  });

  it('400s on a garbage limit, including one past the ceiling', async () => {
    for (const q of ['?limit=abc', '?limit=0', '?limit=-3', '?limit=301', '?limit=2.5']) {
      const res = await get(q);
      expect(res.statusCode, q).toBe(400);
    }
  });

  it('400s on a level that is not one of the five buckets', async () => {
    for (const q of ['?level=warning', '?level=ERROR', '?level=everything']) {
      const res = await get(q);
      expect(res.statusCode, q).toBe(400);
    }
  });
});

// The tests above drive the plugin directly, which proves the handler but NOT
// that the running server ever mounts it. Nothing in this repo boots the real
// app (start() reconciles runs and touches the user's profile), so guard the
// wiring statically instead: dropping the register line is exactly the mistake
// that would leave every test green and the endpoint 404.
describe('registration in the server', () => {
  it('is registered by index.ts', () => {
    const source = fs.readFileSync(path.resolve(__dirname, '..', 'index.ts'), 'utf8');
    expect(source).toContain("import { browserLogRoutes } from './routes/browserLogs'");
    expect(source).toContain('await app.register(browserLogRoutes)');
  });
});
