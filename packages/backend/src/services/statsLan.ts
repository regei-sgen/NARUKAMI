import crypto from 'node:crypto';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { getPcStats } from './pcstats';

/**
 * Wi-Fi path for the phone app — a DELIBERATELY TINY, read-only server.
 *
 * The main NARUKAMI backend must never be bound to the LAN: it injects its
 * bearer token into the HTML it serves from an unauthenticated `/`, so anything
 * that can reach that port can lift the token and drive /api/runs, which spawns
 * shells. Rather than relax that, this is a separate listener that:
 *
 *   - serves exactly ONE route, GET /api/pcstats (plus /health), and 404s
 *     everything else — no HTML, no token injection, no terminal/file/run APIs;
 *   - has its OWN token, required on every request, never embedded in a page;
 *   - is off unless explicitly started, and is read-only by construction.
 *
 * Worst case if the token leaks on your network: someone learns your CPU
 * temperature. That is the entire blast radius.
 */

export interface StatsLanHandle {
  port: number;
  token: string;
  urls: string[];
  close: () => Promise<void>;
}

let handle: StatsLanHandle | null = null;

/**
 * Rank an IPv4 address by how likely it is to be the one a phone on the house
 * Wi-Fi can actually reach. Lower is better. Pure.
 *
 * A machine typically has several: the real LAN address, plus virtual ones from
 * WSL/Hyper-V (172.16-31) and a Tailscale CGNAT address (100.64/10). Listing
 * those first sends people to an address their phone cannot route to.
 */
export function addressRank(ip: string): number {
  if (/^192\.168\./.test(ip)) return 0; // home LAN
  if (/^10\./.test(ip)) return 1; // larger private nets
  if (/^172\.(1[6-9]|2\d|3[01])\./.test(ip)) return 3; // usually WSL / Hyper-V
  if (/^100\.(6[4-9]|[7-9]\d|1[01]\d|12[0-7])\./.test(ip)) return 4; // CGNAT / Tailscale
  return 2;
}

/** Every non-internal IPv4 address, best candidate first. */
export function lanAddresses(port: number): string[] {
  const ips: string[] = [];
  for (const list of Object.values(os.networkInterfaces())) {
    for (const ni of list ?? []) {
      if (ni.family === 'IPv4' && !ni.internal) ips.push(ni.address);
    }
  }
  return ips.sort((a, b) => addressRank(a) - addressRank(b)).map((ip) => `http://${ip}:${port}`);
}

/**
 * Constant-time bearer comparison — a plain `===` on a secret leaks length and
 * prefix through timing.
 */
export function tokenMatches(header: string | undefined, expected: string): boolean {
  if (!header) return false;
  const got = header.startsWith('Bearer ') ? header.slice(7) : header;
  const a = Buffer.from(got);
  const b = Buffer.from(expected);
  if (a.length !== b.length) return false;
  return crypto.timingSafeEqual(a, b);
}

export function isStatsLanRunning(): boolean {
  return handle !== null;
}

const MIME: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json',
  '.svg': 'image/svg+xml',
  '.woff': 'font/woff',
  '.woff2': 'font/woff2',
  '.ttf': 'font/ttf',
  '.otf': 'font/otf',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
};

/**
 * Resolve a request path to a file inside `rootDir`, or null.
 *
 * Traversal is neutralised by normalising as an ABSOLUTE posix path first —
 * leading `..` segments collapse at the root, so `/../../etc/passwd` becomes
 * `/etc/passwd` and lands inside rootDir rather than escaping it. The
 * relative-path check afterwards is defence in depth, not the primary guard.
 *
 * Pure, so the guard can be unit-tested without a server.
 */
export function safeAssetPath(rootDir: string, urlPath: string): string | null {
  let decoded: string;
  try {
    decoded = decodeURIComponent(urlPath.split('?')[0]);
  } catch {
    return null; // malformed %-escape — decodeURIComponent throws
  }
  if (decoded.includes('\0')) return null;
  // Force an absolute posix path so ".." can never climb above "/".
  const abs = path.posix.normalize('/' + decoded.replace(/\\/g, '/').replace(/^\/+/, ''));
  const resolved = path.resolve(rootDir, '.' + abs);
  const rel = path.relative(rootDir, resolved);
  // Compare SEGMENTS, not string prefixes: rel.startsWith('..') also matches a
  // legitimate first segment like '....' or '..foo.js'.
  const first = rel.split(path.sep)[0];
  if (first === '..' || path.isAbsolute(rel)) return null;
  return resolved;
}

export function statsLanInfo(): Omit<StatsLanHandle, 'close'> | null {
  if (!handle) return null;
  const { port, token, urls } = handle;
  return { port, token, urls };
}

/**
 * Start the read-only stats server (idempotent).
 *
 * `frontendDir` (the built SPA) is optional: when given, the phone can load the
 * SAME readout UI over Wi-Fi instead of raw JSON. The HTML is handed out only to
 * a request that already carries the token (`/?pcstats=1&token=…`), and the
 * token it embeds unlocks nothing but this server's stats route.
 */
export async function startStatsLan(port = 4311, frontendDir?: string): Promise<StatsLanHandle> {
  if (handle) return handle;

  const token = crypto.randomBytes(24).toString('hex');
  const spaIndex =
    frontendDir && fs.existsSync(path.join(frontendDir, 'index.html'))
      ? path.join(frontendDir, 'index.html')
      : null;

  const server = http.createServer((req, res) => {
    const send = (code: number, body: unknown): void => {
      const json = JSON.stringify(body);
      res.writeHead(code, {
        'content-type': 'application/json',
        'cache-control': 'no-store',
        // This server has no HTML and no browser UI to protect, but say so.
        'x-content-type-options': 'nosniff',
        'access-control-allow-origin': '*',
        'access-control-allow-headers': 'authorization',
      });
      res.end(json);
    };

    if (req.method === 'OPTIONS') {
      res.writeHead(204, {
        'access-control-allow-origin': '*',
        'access-control-allow-headers': 'authorization',
        'access-control-allow-methods': 'GET, OPTIONS',
      });
      res.end();
      return;
    }

    const path = (req.url ?? '').split('?')[0];

    // Unauthenticated liveness probe so the phone can find the PC without
    // revealing anything: no stats, no token, no hostname.
    if (req.method === 'GET' && path === '/health') {
      send(200, { ok: true, service: 'narukami-pcstats' });
      return;
    }

    const query = new URLSearchParams((req.url ?? '').split('?')[1] ?? '');
    const authed =
      tokenMatches(req.headers.authorization, token) || tokenMatches(query.get('token') ?? undefined, token);

    // --- optional SPA so the phone gets the real UI over Wi-Fi ---------------
    if (spaIndex && frontendDir && req.method === 'GET') {
      if (path === '/' || path === '/index.html') {
        if (!authed) {
          send(401, { error: 'Unauthorized' });
          return;
        }
        // Same injection the desktop backend uses — but this token opens only
        // /api/pcstats on this listener.
        const html = fs
          .readFileSync(spaIndex, 'utf8')
          .replace('</head>', `<script>window.__NARUKAMI__=${JSON.stringify({ token })};</script></head>`);
        res.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' });
        res.end(html);
        return;
      }
      // Bundle assets carry no secrets, so they're served like any static file.
      const asset = safeAssetPath(frontendDir, path);
      if (asset && asset !== spaIndex && fs.existsSync(asset) && fs.statSync(asset).isFile()) {
        res.writeHead(200, { 'content-type': MIME[path.slice(path.lastIndexOf('.'))] ?? 'application/octet-stream' });
        fs.createReadStream(asset).pipe(res);
        return;
      }
    }

    if (!authed) {
      send(401, { error: 'Unauthorized' });
      return;
    }

    if (req.method === 'GET' && path === '/api/pcstats') {
      void getPcStats()
        .then((stats) => send(200, stats))
        .catch(() => send(500, { error: 'sensor read failed' }));
      return;
    }

    // Everything else is deliberately absent.
    send(404, { error: 'Not found' });
  });

  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, '0.0.0.0', resolve);
  });

  handle = {
    port,
    token,
    urls: lanAddresses(port),
    close: () =>
      new Promise<void>((resolve) => {
        server.close(() => {
          handle = null;
          resolve();
        });
      }),
  };
  return handle;
}

export async function stopStatsLan(): Promise<void> {
  if (handle) await handle.close();
}
