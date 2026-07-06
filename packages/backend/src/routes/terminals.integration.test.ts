import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import Fastify, { type FastifyInstance } from 'fastify';
import { terminalRoutes } from './terminals';

// Exercises the terminal-orchestration route guards via inject (no socket, no
// pty). Every path here short-circuits before any DB query, so no live runs or
// database fixtures are needed.
let app: FastifyInstance;

beforeAll(async () => {
  app = Fastify();
  app.addContentTypeParser('application/json', { parseAs: 'string' }, (_r, body, done) => {
    const t = typeof body === 'string' ? body.trim() : '';
    done(null, t ? JSON.parse(t) : undefined);
  });
  await app.register(terminalRoutes);
  await app.ready();
});

afterAll(async () => {
  await app.close();
});

describe('POST /api/terminals/:id/send guards', () => {
  it('rejects sending to yourself (400)', async () => {
    const r = await app.inject({
      method: 'POST',
      url: '/api/terminals/xyz/send',
      payload: { text: 'hi', from: 'xyz' },
    });
    expect(r.statusCode).toBe(400);
    expect(r.json().error).toMatch(/itself/);
  });

  it('rejects a non-live target (409)', async () => {
    const r = await app.inject({
      method: 'POST',
      url: '/api/terminals/ghost/send',
      payload: { text: 'hi', from: 'me' },
    });
    expect(r.statusCode).toBe(409);
    expect(r.json().error).toMatch(/not live/);
  });

  it('requires text (400)', async () => {
    const r = await app.inject({
      method: 'POST',
      url: '/api/terminals/ghost/send',
      payload: { from: 'me' },
    });
    expect(r.statusCode).toBe(400);
    expect(r.json().error).toMatch(/text is required/);
  });

  it('rejects oversize text (413)', async () => {
    const r = await app.inject({
      method: 'POST',
      url: '/api/terminals/ghost/send',
      payload: { text: 'x'.repeat(10_001), from: 'me' },
    });
    expect(r.statusCode).toBe(413);
  });
});

describe('GET /api/terminals', () => {
  it('returns an empty list when nothing is live', async () => {
    const r = await app.inject({ method: 'GET', url: '/api/terminals' });
    expect(r.statusCode).toBe(200);
    expect(r.json().terminals).toEqual([]);
  });
});
