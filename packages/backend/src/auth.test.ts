import { describe, it, expect, beforeAll, afterAll, afterEach, vi } from 'vitest';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import Fastify, { type FastifyInstance } from 'fastify';

// Point the token file at a temp path and suppress the CLI auto-start BEFORE any
// import runs (config.ts reads RUNNER_TOKEN_FILE at load time and index.ts calls
// main() unless NARUKAMI_EMBEDDED=1) — vi.hoisted runs before the imports below,
// so tests never touch the real .runner-token and never boot a server.
const { tokenFile } = vi.hoisted(() => {
  const tmp = process.env.TEMP ?? process.env.TMPDIR ?? '.';
  const file = `${tmp}/narukami-test-token-${process.pid}-${Date.now()}`;
  process.env.RUNNER_TOKEN_FILE = file;
  process.env.NARUKAMI_EMBEDDED = '1';
  return { tokenFile: file };
});

// The relay's peer map is what tells a relayed connection apart from a genuinely
// local one. Default to the REAL implementation (so the end-to-end relay test
// below exercises it for real) but allow a test to force an answer, so the
// security gate is also covered on a box with no routable LAN interface.
const relayOverride = vi.hoisted(() => ({
  peer: null as null | ((remotePort: number | undefined) => string | null),
}));
vi.mock('./services/lanRelay', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./services/lanRelay')>();
  return {
    ...actual,
    relayPeerAddress: (remotePort: number | undefined): string | null =>
      relayOverride.peer ? relayOverride.peer(remotePort) : actual.relayPeerAddress(remotePort),
  };
});

import * as auth from './auth';
import { makeIndexSender } from './index';
import { detectLanIp, startRelay, stopRelay } from './services/lanRelay';

afterAll(() => {
  try {
    fs.unlinkSync(tokenFile);
  } catch {
    /* never created */
  }
});

describe('getToken', () => {
  it('generates a 64-char hex token and persists it', () => {
    const t = auth.getToken();
    expect(t).toMatch(/^[0-9a-f]{64}$/);
    expect(fs.readFileSync(tokenFile, 'utf8').trim()).toBe(t);
  });
  it('is stable across calls (cached)', () => {
    expect(auth.getToken()).toBe(auth.getToken());
  });
});

describe('isValidToken', () => {
  it('accepts the real token and rejects everything else', () => {
    const t = auth.getToken();
    expect(auth.isValidToken(t)).toBe(true);
    expect(auth.isValidToken('wrong')).toBe(false);
    expect(auth.isValidToken('')).toBe(false);
    expect(auth.isValidToken(undefined)).toBe(false);
    expect(auth.isValidToken(null)).toBe(false);
    // same length, different content
    expect(auth.isValidToken('0'.repeat(64))).toBe(false);
  });
});

describe('bearerFromHeader', () => {
  it('extracts the token', () => {
    expect(auth.bearerFromHeader('Bearer abc123')).toBe('abc123');
  });
  it('is case-insensitive on the scheme and trims', () => {
    expect(auth.bearerFromHeader('bearer   abc  ')).toBe('abc');
  });
  it('returns null for other/absent schemes', () => {
    expect(auth.bearerFromHeader('Basic abc')).toBeNull();
    expect(auth.bearerFromHeader('')).toBeNull();
    expect(auth.bearerFromHeader(undefined)).toBeNull();
  });
});

describe('isAllowedOrigin', () => {
  it('allows any loopback origin (any port) and rejects the rest', () => {
    // The packaged desktop app serves the SPA from the backend on a random
    // loopback port, so origin is http://127.0.0.1:<random> — any port is fine.
    expect(auth.isAllowedOrigin('http://localhost:5173')).toBe(true);
    expect(auth.isAllowedOrigin('http://127.0.0.1:5173')).toBe(true);
    expect(auth.isAllowedOrigin('http://localhost:3000')).toBe(true);
    expect(auth.isAllowedOrigin('http://[::1]:4000')).toBe(true);
    // Anything non-loopback stays rejected.
    expect(auth.isAllowedOrigin('http://evil.com')).toBe(false);
    expect(auth.isAllowedOrigin('http://192.168.1.5:5173')).toBe(false);
    expect(auth.isAllowedOrigin(undefined)).toBe(false);
  });
});

describe('isAllowedHost', () => {
  it('allows only loopback hosts', () => {
    expect(auth.isAllowedHost('127.0.0.1:4000')).toBe(true);
    expect(auth.isAllowedHost('localhost:4000')).toBe(true);
    expect(auth.isAllowedHost('127.0.0.1')).toBe(true);
    expect(auth.isAllowedHost('evil.com:4000')).toBe(false);
    expect(auth.isAllowedHost('192.168.1.5:4000')).toBe(false);
    expect(auth.isAllowedHost(undefined)).toBe(false);
  });

  it('handles bracketed IPv6 loopback with and without a port', () => {
    // Regression: the old split(':')[0] returned "[" for "[::1]:4000", so the
    // IPv6 loopback branch was dead and every [::1] Host was wrongly rejected —
    // disagreeing with isAllowedOrigin (which accepts it).
    expect(auth.isAllowedHost('[::1]')).toBe(true);
    expect(auth.isAllowedHost('[::1]:4000')).toBe(true);
    expect(auth.isAllowedOrigin('http://[::1]:4000')).toBe(true); // now consistent
    // Non-loopback IPv6 is still rejected.
    expect(auth.isAllowedHost('[2001:db8::1]:4000')).toBe(false);
    expect(auth.isAllowedHost('[::1')).toBe(false); // malformed
  });
});

describe('isViaRelay / isTrustedLocalRequest', () => {
  afterEach(() => {
    relayOverride.peer = null;
  });

  it('reads the SOCKET, not the header', () => {
    relayOverride.peer = (p) => (p === 55555 ? '192.168.1.77' : null);
    expect(auth.isViaRelay(55555)).toBe(true);
    expect(auth.isViaRelay(44444)).toBe(false);
    expect(auth.isViaRelay(undefined)).toBe(false);
    // A forged loopback Host over a relayed socket is NOT a trusted local caller.
    expect(auth.isTrustedLocalRequest('127.0.0.1:4000', 55555)).toBe(false);
    expect(auth.isTrustedLocalRequest('localhost:4000', 55555)).toBe(false);
    // The genuine desktop renderer (loopback Host, unrelayed socket) still is.
    expect(auth.isTrustedLocalRequest('127.0.0.1:4000', 44444)).toBe(true);
    expect(auth.isTrustedLocalRequest('[::1]:4000', 44444)).toBe(true);
    // A non-loopback Host is never trusted, relay or not.
    expect(auth.isTrustedLocalRequest('192.168.1.5:4000', 44444)).toBe(false);
  });
});

// ── item 2: the master token must never reach a LAN client ──────────────────
// index.ts used to decide this from the client-supplied Host header alone. The
// LAN relay is a raw byte pipe (lanRelay.ts:12-13) that forwards the phone's own
// Host verbatim over a loopback socket, so `curl -H 'Host: 127.0.0.1'` from the
// LAN was handed the 64-hex master token — full RCE via POST /api/projects/:id/shell.
describe('index.html token injection is gated on the socket, not the Host header', () => {
  let app: FastifyInstance;
  let port: number;
  let spaDir: string;

  const get = (opts: http.RequestOptions): Promise<string> =>
    new Promise((resolve, reject) => {
      http
        .get(opts, (res) => {
          let body = '';
          res.on('data', (c) => (body += c));
          res.on('end', () => resolve(body));
        })
        .on('error', reject);
    });

  beforeAll(async () => {
    spaDir = fs.mkdtempSync(path.join(os.tmpdir(), 'narukami-spa-'));
    fs.writeFileSync(
      path.join(spaDir, 'index.html'),
      '<!doctype html><html><head><title>NARUKAMI</title></head><body></body></html>',
      'utf8',
    );
    const sendIndex = makeIndexSender(spaDir, auth.getToken());
    app = Fastify();
    app.get('/', async (req, reply) => sendIndex(req, reply));
    await app.listen({ port: 0, host: '127.0.0.1' });
    const addr = app.server.address();
    port = typeof addr === 'object' && addr ? addr.port : 0;
  });

  afterAll(async () => {
    await stopRelay();
    await app.close();
    fs.rmSync(spaDir, { recursive: true, force: true });
  });

  afterEach(() => {
    relayOverride.peer = null;
  });

  it('still injects the token for the real (loopback, unrelayed) renderer', async () => {
    const body = await get({ host: '127.0.0.1', port, path: '/' });
    expect(body).toContain('window.__NARUKAMI__');
    expect(body).toContain(auth.getToken());
  });

  it('withholds the token from a relayed socket that forges Host: 127.0.0.1', async () => {
    relayOverride.peer = () => '192.168.1.77'; // every socket looks relayed
    const body = await get({ host: '127.0.0.1', port, path: '/', headers: { host: '127.0.0.1' } });
    expect(body).not.toContain('__NARUKAMI__');
    expect(body).not.toContain(auth.getToken());
    expect(body).toContain('<title>NARUKAMI</title>'); // the raw page, still served
  });

  it('withholds the token from an honest LAN Host (unchanged behaviour)', async () => {
    const body = await get({ host: '127.0.0.1', port, path: '/', headers: { host: '192.168.1.5:4311' } });
    expect(body).not.toContain('__NARUKAMI__');
  });

  // The end-to-end proof of the reported attack, over a REAL relay socket. Needs
  // a routable LAN interface — on a loopback-only box detectLanIp() is null, so
  // skip rather than fail (same convention as lanRelay.test.ts).
  const maybe = detectLanIp() !== null ? it : it.skip;
  maybe('a real LAN relay client forging Host: 127.0.0.1 gets the tokenless page', async () => {
    const relay = await startRelay(port);
    const forged = await get({
      host: relay.host,
      port: relay.port,
      path: '/',
      headers: { host: '127.0.0.1' },
    });
    expect(forged).not.toContain('__NARUKAMI__');
    expect(forged).not.toContain(auth.getToken());
    // …while the desktop, still on its own loopback socket, keeps its token.
    const local = await get({ host: '127.0.0.1', port, path: '/' });
    expect(local).toContain(auth.getToken());
  });
});
