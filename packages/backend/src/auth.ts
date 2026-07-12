import crypto from 'node:crypto';
import fs from 'node:fs';
import type { FastifyReply, FastifyRequest } from 'fastify';
import { ALLOWED_ORIGINS, TOKEN_FILE } from './config';
import { hostAllowed } from './services/share';

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

export function isAllowedOrigin(origin: string | undefined): boolean {
  if (!origin) return false;
  if (ALLOWED_ORIGINS.has(origin)) return true;
  // Accept any loopback origin — the packaged desktop app serves the SPA from
  // the backend itself, so the WS origin is http://127.0.0.1:<random port>.
  // When "phone access" is enabled, hostAllowed also accepts private-LAN origins
  // (never public ones); otherwise it stays loopback-only.
  return hostAllowed(origin);
}

/** Accept loopback Host headers always; private-LAN hosts only while phone access
 *  is enabled (see services/share.ts). */
export function isAllowedHost(host: string | undefined): boolean {
  if (!host) return false;
  return hostAllowed(host);
}
