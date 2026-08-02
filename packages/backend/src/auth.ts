import crypto from 'node:crypto';
import fs from 'node:fs';
import type { FastifyReply, FastifyRequest } from 'fastify';
import { ALLOWED_ORIGINS, TOKEN_FILE } from './config';
import { activeLanAddress, relayPeerAddress } from './services/lanRelay';

let cachedToken: string | null = null;

/**
 * Return the bearer token, generating and persisting one on first use.
 * NEVER log the return value.
 */
export function getToken(): string {
  if (cachedToken) return cachedToken;

  try {
    const existing = fs.readFileSync(TOKEN_FILE, 'utf8').trim();
    if (existing) {
      cachedToken = existing;
      return existing;
    }
  } catch {
    // file missing → fall through and generate
  }

  const token = crypto.randomBytes(32).toString('hex');
  fs.writeFileSync(TOKEN_FILE, token, { encoding: 'utf8', mode: 0o600 });
  cachedToken = token;
  return token;
}

function constantTimeEquals(a: string, b: string): boolean {
  const ab = Buffer.from(a, 'utf8');
  const bb = Buffer.from(b, 'utf8');
  if (ab.length !== bb.length) return false;
  return crypto.timingSafeEqual(ab, bb);
}

export function isValidToken(token: string | undefined | null): boolean {
  if (!token) return false;
  return constantTimeEquals(token, getToken());
}

export function bearerFromHeader(header: string | undefined): string | null {
  if (!header) return null;
  const match = /^Bearer\s+(.+)$/i.exec(header);
  return match ? match[1].trim() : null;
}

/** Fastify onRequest hook: reject any request without a valid bearer token. */
export async function requireAuth(
  req: FastifyRequest,
  reply: FastifyReply,
): Promise<void> {
  const token = bearerFromHeader(req.headers.authorization);
  if (!isValidToken(token)) {
    await reply
      .code(401)
      .send({ error: 'Unauthorized: missing or invalid bearer token.' });
  }
}

/**
 * The machine's own LAN IP, but ONLY while the LAN relay is running. This is the
 * single gate that lets a phone through the Host/Origin guards: no relay → null →
 * LAN access denied. It never accepts anything but the exact bound LAN IP, so a
 * DNS-rebinding page (which sends its own domain as Host/Origin, never the raw
 * IP) stays rejected.
 */
function lanHostWhileShared(): string | null {
  return activeLanAddress()?.host ?? null;
}

export function isAllowedOrigin(origin: string | undefined): boolean {
  if (!origin) return false;
  if (ALLOWED_ORIGINS.has(origin)) return true;
  // Accept any loopback origin — the packaged desktop app serves the SPA from
  // the backend itself, so the WS origin is http://127.0.0.1:<random port>.
  try {
    const h = new URL(origin).hostname;
    if (h === '127.0.0.1' || h === 'localhost' || h === '[::1]') return true;
    // LAN share: accept the relay's own LAN IP as an origin, only while sharing.
    const lan = lanHostWhileShared();
    return lan !== null && h === lan;
  } catch {
    return false;
  }
}

/**
 * Accept loopback Host headers (127.0.0.1 / localhost / [::1], any port), plus —
 * ONLY while the LAN relay is active — the relay's own LAN IP (so a phone
 * reaching us through the relay isn't rejected as "non-loopback").
 */
export function isAllowedHost(host: string | undefined): boolean {
  if (!host) return false;
  const h = host.toLowerCase().trim();
  // Bracketed IPv6 literal, optionally with a port: "[::1]" or "[::1]:4000".
  // (The old `split(':')[0]` returned "[" here, so the loopback IPv6 branch was
  // dead and every [::1] Host was wrongly rejected — disagreeing with
  // isAllowedOrigin, which accepts it.)
  if (h.startsWith('[')) {
    const end = h.indexOf(']');
    if (end === -1) return false;
    return h.slice(1, end) === '::1';
  }
  // hostname[:port] — strip the port.
  const name = h.split(':')[0];
  if (name === '127.0.0.1' || name === 'localhost') return true;
  // LAN share: the relay's own LAN IP, only while sharing.
  const lan = lanHostWhileShared();
  return lan !== null && name === lan;
}

/** True when the Host header names the (loopback) machine, NOT the LAN IP.
 * NOT sufficient on its own to prove the caller is local — the Host header is
 * client-supplied and the relay forwards it verbatim. Use
 * {@link isTrustedLocalRequest} for anything master-scoped. */
export function isLoopbackHost(host: string | undefined): boolean {
  if (!host) return false;
  const h = host.toLowerCase().trim();
  if (h.startsWith('[')) {
    const end = h.indexOf(']');
    if (end === -1) return false;
    return h.slice(1, end) === '::1';
  }
  const name = h.split(':')[0];
  return name === '127.0.0.1' || name === 'localhost';
}

/**
 * True when this connection arrived through the LAN share relay. The relay is a
 * raw byte pipe that never rewrites headers (lanRelay.ts:12-13), so a LAN client
 * can claim any Host/Origin it likes and the backend sees it verbatim on a
 * 127.0.0.1 socket — headers are NOT evidence of locality once a share is up.
 * What the client cannot forge is the relay's own upstream leg: lanRelay records
 * each one's ephemeral port, so the SOCKET tells the truth where the header lies.
 * Pass `req.raw.socket.remotePort` (Fastify) or `req.socket.remotePort` (raw http).
 */
export function isViaRelay(remotePort: number | undefined): boolean {
  return relayPeerAddress(remotePort) !== null;
}

/**
 * True only for a caller that is BOTH addressed to loopback AND on a genuinely
 * local socket. This — never isLoopbackHost alone — is the gate for handing out
 * anything master-scoped (the token injected into index.html, WS master rights):
 * that token reaches POST /api/projects/:id/shell, i.e. full RCE.
 */
export function isTrustedLocalRequest(
  host: string | undefined,
  remotePort: number | undefined,
): boolean {
  return isLoopbackHost(host) && !isViaRelay(remotePort);
}
