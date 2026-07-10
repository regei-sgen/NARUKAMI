import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import Fastify, { type FastifyInstance } from 'fastify';
import { godclaudeRoutes } from './godclaude';

// Exercises the embedded-godclaude control plane over HTTP (inject — no socket).
// Runs against a throwaway god home via NARUKAMI_GOD_HOME; the vendored CLIs it
// shells are the real ones. Native ~/.claude is never written.
let app: FastifyInstance;
let tmpHome: string;

beforeAll(async () => {
  tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), 'narukami-god-route-'));
  process.env.NARUKAMI_GOD_HOME = tmpHome;
  app = Fastify();
  app.addContentTypeParser('application/json', { parseAs: 'string' }, (_r, body, done) => {
    const t = typeof body === 'string' ? body.trim() : '';
    done(null, t ? JSON.parse(t) : undefined);
  });
  await app.register(godclaudeRoutes);
  await app.ready();
});

afterAll(async () => {
  await app.close();
  delete process.env.NARUKAMI_GOD_HOME;
  fs.rmSync(tmpHome, { recursive: true, force: true });
});

describe('embedded godclaude lifecycle over HTTP', () => {
  it('GET /status starts uninstalled', async () => {
    const r = await app.inject({ method: 'GET', url: '/api/godclaude/status' });
    expect(r.statusCode).toBe(200);
    const s = r.json();
    expect(s.installed).toBe(false);
    expect(s.armed).toBe(false);
    expect(s.home).toBe(tmpHome);
    // Fleet is scoped to NARUKAMI-launched sessions: with no Run rows (no DB
    // here), native sessions from the machine-global registry must NOT leak in.
    expect(s.sessions).toEqual({ count: 0, live: 0, items: [] });
  });

  it('POST /install provisions and returns the new status', async () => {
    const r = await app.inject({ method: 'POST', url: '/api/godclaude/install' });
    expect(r.statusCode).toBe(200);
    expect(r.json().installed).toBe(true);
    expect(fs.existsSync(path.join(tmpHome, '.claude', 'hooks', 'godmode-gate.mjs'))).toBe(true);
  });

  it('POST /mode switches the global mode and arms', async () => {
    const r = await app.inject({
      method: 'POST',
      url: '/api/godclaude/mode',
      payload: { mode: 'goddev' },
    });
    expect(r.statusCode).toBe(200);
    const { status } = r.json();
    expect(status.armed).toBe(true);
    expect(status.modes).toContain('developer');
  }, 30_000);

  it('POST /mode without a mode is a 400', async () => {
    const r = await app.inject({ method: 'POST', url: '/api/godclaude/mode', payload: {} });
    expect(r.statusCode).toBe(400);
  });

  it('POST /mode with an unknown mode surfaces the CLI rejection as 400', async () => {
    const r = await app.inject({
      method: 'POST',
      url: '/api/godclaude/mode',
      payload: { mode: 'godnothing' },
    });
    expect(r.statusCode).toBe(400);
    expect(r.json().error).toMatch(/unknown mode/i);
  }, 30_000);

  it('POST /arm {on:false} disarms globally; {on:true} re-arms keeping the mode', async () => {
    const off = await app.inject({
      method: 'POST',
      url: '/api/godclaude/arm',
      payload: { on: false },
    });
    expect(off.statusCode).toBe(200);
    expect(off.json().status.armed).toBe(false);

    const on = await app.inject({ method: 'POST', url: '/api/godclaude/arm', payload: { on: true } });
    expect(on.statusCode).toBe(200);
    expect(on.json().status.armed).toBe(true);
    expect(on.json().status.modes).toContain('developer'); // mode survived the off/on cycle
  }, 30_000);

  it('GET /sessions/:id/state — unknown session inherits the global armed state', async () => {
    const r = await app.inject({ method: 'GET', url: '/api/godclaude/sessions/nope-123/state' });
    expect(r.statusCode).toBe(200);
    const s = r.json();
    expect(s.installed).toBe(true);
    expect(s.modes).toEqual([]);
    expect(s.active).toBe(true); // no overlay + globally armed (prior test) → default ON
  });

  it('POST /arm with sessionId toggles ONE session without touching global', async () => {
    const sid = 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee';
    const off = await app.inject({
      method: 'POST',
      url: '/api/godclaude/arm',
      payload: { on: false, sessionId: sid },
    });
    expect(off.statusCode).toBe(200);
    expect(off.json().active).toBe(false);

    // that session reads OFF, global stays armed, other sessions unaffected
    const s = await app.inject({ method: 'GET', url: `/api/godclaude/sessions/${sid}/state` });
    expect(s.json().active).toBe(false);
    const g = await app.inject({ method: 'GET', url: '/api/godclaude/status' });
    expect(g.json().armed).toBe(true);
    const other = await app.inject({ method: 'GET', url: '/api/godclaude/sessions/other-1/state' });
    expect(other.json().active).toBe(true);

    const on = await app.inject({
      method: 'POST',
      url: '/api/godclaude/arm',
      payload: { on: true, sessionId: sid },
    });
    expect(on.statusCode).toBe(200);
    expect(on.json().active).toBe(true);
  }, 30_000);

  it('GET /logs rejects an unknown source (400) and reports a missing log cleanly', async () => {
    const bad = await app.inject({ method: 'GET', url: '/api/godclaude/logs?source=nope' });
    expect(bad.statusCode).toBe(400);

    const ok = await app.inject({ method: 'GET', url: '/api/godclaude/logs?source=audit' });
    expect(ok.statusCode).toBe(200);
    expect(ok.json().exists).toBe(false); // nothing gated yet in a fresh home
  });
});
