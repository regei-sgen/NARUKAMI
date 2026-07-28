import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  addressRank,
  lanAddresses,
  safeAssetPath,
  startStatsLan,
  statsLanInfo,
  stopStatsLan,
  tokenMatches,
} from './statsLan';

describe('safeAssetPath', () => {
  const root = path.resolve('/srv/dist');

  it('resolves normal asset paths inside the root', () => {
    expect(safeAssetPath(root, '/assets/index-abc.js')).toBe(
      path.join(root, 'assets', 'index-abc.js'),
    );
  });

  it('never escapes the root, however the path is crafted', () => {
    // The property that matters is CONTAINMENT: a hostile path may resolve to a
    // (probably non-existent) file, but never to one outside the SPA dir.
    const hostile = [
      '/../../../../Windows/win.ini',
      '/..%2f..%2fsecret.txt',
      '/assets/../../../etc/passwd',
      '/....//....//boot.ini',
      '/assets/..\\..\\..\\Windows\\win.ini', // backslashes on Windows
      '/%2e%2e/%2e%2e/secret',
    ];
    for (const p of hostile) {
      const got = safeAssetPath(root, p);
      expect(got, `${p} must not escape`).not.toBeNull();
      const rel = path.relative(root, got as string);
      expect(rel.split(path.sep)[0], `${p} escaped`).not.toBe('..');
      expect(path.isAbsolute(rel), `${p} escaped`).toBe(false);
    }
  });

  it('does not reject legitimate names that merely start with dots', () => {
    // Guarding with rel.startsWith('..') would 404 these real files.
    expect(safeAssetPath(root, '/assets/..foo.js')).toBe(path.join(root, 'assets', '..foo.js'));
    expect(safeAssetPath(root, '/..../x.js')).toBe(path.join(root, '....', 'x.js'));
  });

  it('returns null for input that cannot be decoded or is NUL-poisoned', () => {
    // decodeURIComponent throws on a malformed escape — that must not reach the
    // request handler as an exception.
    expect(safeAssetPath(root, '/%zz')).toBeNull();
    expect(safeAssetPath(root, '/assets/%E0%A4%A')).toBeNull();
    expect(safeAssetPath(root, '/assets/x\0.js')).toBeNull();
  });
});

describe('tokenMatches', () => {
  it('accepts the exact token, with or without the Bearer prefix', () => {
    expect(tokenMatches('Bearer abc123', 'abc123')).toBe(true);
    expect(tokenMatches('abc123', 'abc123')).toBe(true);
  });

  it('rejects a wrong, absent, or differently-sized token', () => {
    expect(tokenMatches('Bearer nope', 'abc123')).toBe(false);
    expect(tokenMatches(undefined, 'abc123')).toBe(false);
    expect(tokenMatches('Bearer ', 'abc123')).toBe(false);
    // a prefix must not pass — this is why the compare is length-checked first
    expect(tokenMatches('Bearer abc', 'abc123')).toBe(false);
  });
});

describe('lanAddresses / addressRank', () => {
  it('returns loopback-free http URLs on the requested port', () => {
    const urls = lanAddresses(4311);
    for (const u of urls) {
      expect(u).toMatch(/^http:\/\/\d+\.\d+\.\d+\.\d+:4311$/);
      expect(u).not.toContain('127.0.0.1');
    }
  });

  it('ranks the real LAN address above virtual adapters', () => {
    // This machine really does expose 192.168.1.15 (LAN), 172.24.128.1 (WSL)
    // and 100.72.13.48 (Tailscale) — offering the last two first would send the
    // phone to an address it cannot route to.
    expect(addressRank('192.168.1.15')).toBeLessThan(addressRank('172.24.128.1'));
    expect(addressRank('192.168.1.15')).toBeLessThan(addressRank('100.72.13.48'));
    expect(addressRank('10.0.0.5')).toBeLessThan(addressRank('172.24.128.1'));
    // a plain routable address still beats the virtual ones
    expect(addressRank('192.168.1.15')).toBeLessThan(addressRank('100.100.100.1'));
  });

  it('sorts a mixed list so the LAN address comes first', () => {
    const sorted = ['100.72.13.48', '172.24.128.1', '192.168.1.15'].sort(
      (a, b) => addressRank(a) - addressRank(b),
    );
    expect(sorted[0]).toBe('192.168.1.15');
  });
});

describe('read-only LAN stats server', () => {
  // Port 0 would be ideal, but the handle reports the requested port; use a
  // high fixed port unlikely to clash in CI.
  const PORT = 44311;
  let token = '';
  const base = `http://127.0.0.1:${PORT}`;

  beforeAll(async () => {
    const h = await startStatsLan(PORT);
    token = h.token;
  });
  afterAll(async () => {
    await stopStatsLan();
  });

  it('mints a non-trivial token and reports where to point the phone', () => {
    expect(token).toMatch(/^[0-9a-f]{48}$/);
    expect(statsLanInfo()?.port).toBe(PORT);
  });

  it('serves stats only WITH the token', async () => {
    const res = await fetch(`${base}/api/pcstats`, {
      headers: { authorization: `Bearer ${token}` },
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { cpu?: { model?: string } };
    expect(typeof body.cpu?.model).toBe('string');
  });

  it('refuses stats without a token', async () => {
    expect((await fetch(`${base}/api/pcstats`)).status).toBe(401);
    const bad = await fetch(`${base}/api/pcstats`, { headers: { authorization: 'Bearer wrong' } });
    expect(bad.status).toBe(401);
  });

  it('exposes NOTHING but stats — no HTML, no token, no shell surface', async () => {
    const auth = { authorization: `Bearer ${token}` };
    // The dangerous routes of the main backend must not exist here at all.
    for (const path of ['/', '/index.html', '/api/runs', '/api/terminals', '/api/projects', '/api/files']) {
      const res = await fetch(base + path, { headers: auth });
      expect(res.status, `${path} must not be served`).toBe(404);
      // and must never leak the injected-token HTML the main server serves
      expect(await res.text()).not.toContain('__NARUKAMI__');
    }
  });

  it('has an unauthenticated health probe that reveals nothing', async () => {
    const res = await fetch(`${base}/health`);
    expect(res.status).toBe(200);
    const body = await res.text();
    expect(body).toContain('narukami-pcstats');
    expect(body).not.toContain(token);
  });

  it('is idempotent — starting twice reuses the one listener', async () => {
    const again = await startStatsLan(PORT);
    expect(again.token).toBe(token);
  });

  it('accepts the token via query string too, for the phone URL', async () => {
    const ok = await fetch(`${base}/api/pcstats?token=${token}`);
    expect(ok.status).toBe(200);
    const bad = await fetch(`${base}/api/pcstats?token=deadbeef`);
    expect(bad.status).toBe(401);
  });
});
