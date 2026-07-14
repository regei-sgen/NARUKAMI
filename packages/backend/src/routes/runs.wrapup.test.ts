import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import Fastify, { type FastifyInstance } from 'fastify';

// Point the token file (and therefore the wrapup log dir, dirname(TOKEN_FILE)/logs)
// at a temp location BEFORE config is imported (vi.hoisted runs pre-imports).
const { tokenFile } = vi.hoisted(() => {
  const tmp = process.env.TEMP ?? process.env.TMPDIR ?? '.';
  const file = `${tmp}/narukami-wrapup-test-${process.pid}/.runner-token`;
  process.env.RUNNER_TOKEN_FILE = file;
  return { tokenFile: file };
});

// The wrapup route only reads the run row — stub prisma so this stays a pure
// route test (no SQLite, no migrations).
vi.mock('../db', () => ({
  prisma: {
    run: {
      findUnique: vi.fn().mockImplementation(({ where }: { where: { id: string } }) =>
        Promise.resolve(
          where.id === 'run-1'
            ? {
                id: 'run-1',
                projectId: 'proj-1',
                kind: 'claude',
                name: 'my session',
                status: 'running',
                exitCode: null,
                project: { id: 'proj-1', name: 'Demo Project' },
              }
            : null,
        ),
      ),
      update: vi.fn().mockResolvedValue({}),
    },
  },
}));

import { runRoutes } from './runs';

const LOG_FILE = path.join(path.dirname(tokenFile), 'logs', 'session-wrapups.jsonl');

let app: FastifyInstance;

beforeAll(async () => {
  fs.mkdirSync(path.dirname(tokenFile), { recursive: true });
  app = Fastify();
  await app.register(runRoutes);
  await app.ready();
});

afterAll(async () => {
  await app.close();
  fs.rmSync(path.dirname(tokenFile), { recursive: true, force: true });
});

function readLog(): Array<Record<string, unknown>> {
  if (!fs.existsSync(LOG_FILE)) return [];
  return fs
    .readFileSync(LOG_FILE, 'utf8')
    .split('\n')
    .filter((l) => l.trim() !== '')
    .map((l) => JSON.parse(l) as Record<string, unknown>);
}

describe('POST /api/runs/:runId/wrapup', () => {
  it('404s for an unknown run', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/api/runs/nope/wrapup',
      payload: { verdict: 'successful' },
    });
    expect(res.statusCode).toBe(404);
  });

  it('records a successful verdict + notes as a JSONL line', async () => {
    const before = readLog().length;
    const res = await app.inject({
      method: 'POST',
      url: '/api/runs/run-1/wrapup',
      payload: { verdict: ' Successful ', notes: 'shipped the thing' },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ ok: true, verdict: 'successful' });

    const lines = readLog();
    expect(lines.length).toBe(before + 1);
    const entry = lines[lines.length - 1];
    expect(entry.runId).toBe('run-1');
    expect(entry.projectName).toBe('Demo Project');
    expect(entry.kind).toBe('claude');
    expect(entry.label).toBe('my session');
    expect(entry.verdict).toBe('successful');
    expect(entry.notes).toBe('shipped the thing');
    expect(typeof entry.ts).toBe('string');
  });

  it('normalizes an unknown verdict to "unspecified" and caps notes at 4000 chars', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/api/runs/run-1/wrapup',
      payload: { verdict: 'meh', notes: 'x'.repeat(5000) },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ ok: true, verdict: 'unspecified' });
    const entry = readLog().pop()!;
    expect(entry.verdict).toBe('unspecified');
    expect((entry.notes as string).length).toBe(4000);
  });

  it('accepts a bodyless call (verdict defaults to unspecified, notes empty)', async () => {
    const res = await app.inject({ method: 'POST', url: '/api/runs/run-1/wrapup', payload: {} });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ ok: true, verdict: 'unspecified' });
    const entry = readLog().pop()!;
    expect(entry.notes).toBe('');
  });
});
