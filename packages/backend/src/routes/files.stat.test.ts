import { describe, it, expect, vi, beforeAll, afterAll } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import Fastify, { type FastifyInstance } from 'fastify';

// Backs the editor's Refresh button: the staleness probe must report the CURRENT
// on-disk mtime, so an external edit (Claude writing the file behind the editor)
// is detectable without re-reading the whole file.
const fx = vi.hoisted(() => ({ root: '' }));

vi.mock('../db', () => ({
  prisma: {
    project: {
      findUnique: vi.fn(async () => ({ id: 'p1', name: 'fixture', path: fx.root })),
    },
  },
}));

import { fileRoutes } from './files';

let app: FastifyInstance;

beforeAll(async () => {
  fx.root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'narukami-stat-')));
  fs.writeFileSync(path.join(fx.root, 'note.md'), '# hello\n');
  fs.mkdirSync(path.join(fx.root, 'sub'));
  app = Fastify();
  await app.register(fileRoutes);
  await app.ready();
});

afterAll(async () => {
  await app.close();
  fs.rmSync(fx.root, { recursive: true, force: true });
});

const stat = (q: string) => app.inject({ method: 'GET', url: `/api/projects/p1/file-stat?path=${q}` });

describe('GET /api/projects/:id/file-stat', () => {
  it('reports mtime and size without returning content', async () => {
    const r = await stat('note.md');
    expect(r.statusCode).toBe(200);
    const body = r.json() as Record<string, unknown>;
    expect(body.path).toBe('note.md');
    expect(typeof body.mtimeMs).toBe('number');
    expect(body.size).toBe(fs.statSync(path.join(fx.root, 'note.md')).size);
    expect(body).not.toHaveProperty('content');
  });

  it('reports the NEW mtime after an external write — the staleness signal', async () => {
    const before = (await stat('note.md')).json() as { mtimeMs: number };
    // Stamp the future explicitly: a same-millisecond rewrite would be
    // indistinguishable on a coarse filesystem clock and make this flaky.
    const target = new Date(before.mtimeMs + 5000);
    fs.writeFileSync(path.join(fx.root, 'note.md'), '# hello\n\nedited elsewhere\n');
    fs.utimesSync(path.join(fx.root, 'note.md'), target, target);

    const after = (await stat('note.md')).json() as { mtimeMs: number; size: number };
    expect(after.mtimeMs).toBeGreaterThan(before.mtimeMs);
    expect(after.size).toBe(fs.statSync(path.join(fx.root, 'note.md')).size);
  });

  it('404s a file that is not there (deleted behind the editor)', async () => {
    expect((await stat('ghost.md')).statusCode).toBe(404);
  });

  it('400s a directory', async () => {
    const r = await stat('sub');
    expect(r.statusCode).toBe(400);
    expect((r.json() as { error: string }).error).toMatch(/directory/i);
  });

  it('400s a path that escapes the project root', async () => {
    expect((await stat('..%2F..%2Fsecret.txt')).statusCode).toBe(400);
  });

  it('400s a blank path', async () => {
    expect((await stat('')).statusCode).toBe(400);
  });
});
