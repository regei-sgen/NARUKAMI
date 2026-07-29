import crypto from 'node:crypto';

/**
 * Per-terminal LAN share tokens. A "share" is a short-lived, revocable
 * credential that grants access to exactly ONE run (terminal) over the LAN relay
 * — never the master bearer token, which stays on the machine. A leaked share is
 * confined to that one terminal and expires on its own.
 *
 * Scope: `{ runId, canInput }`. `canInput=false` is a read-only mirror (the phone
 * can watch but not type). TTL defaults to 4h; a share can also be revoked
 * explicitly (the desktop "stop sharing" button) or implicitly (its run ends —
 * the caller checks liveness).
 *
 * In-memory only: shares never touch the DB. A process restart drops every share
 * (and stops the relay), which is the safe default — you re-share after a restart.
 */

export interface Share {
  id: string; // public handle (used to revoke; safe to show)
  token: string; // secret (goes in the QR URL; treat like a password)
  runId: string; // the ONE terminal this share unlocks
  canInput: boolean; // false → read-only mirror
  createdAt: number;
  expiresAt: number;
}

export interface PublicShare {
  id: string;
  runId: string;
  canInput: boolean;
  createdAt: number;
  expiresAt: number;
}

const DEFAULT_TTL_MS = 4 * 60 * 60 * 1000; // 4 hours
const MAX_TTL_MS = 24 * 60 * 60 * 1000; // never mint longer than a day
const MIN_TTL_MS = 60 * 1000; // ...or shorter than a minute

// token → Share. Keyed by the secret so validation is an O(1) lookup; the token
// is 256 bits of entropy, so enumeration is infeasible and a map lookup leaks
// nothing an attacker could use.
const byToken = new Map<string, Share>();

// Revocation listeners (ws.ts): a share dying must SEVER that run's live phone
// sockets — the token is validated only at upgrade, so without a kick a revoked
// (or expired, or view-only-flipped) phone would keep streaming and typing for
// as long as any other share kept the relay up.
type RevocationListener = (runId: string) => void;
const revocationListeners = new Set<RevocationListener>();

export function onShareRevoked(listener: RevocationListener): () => void {
  revocationListeners.add(listener);
  return () => {
    revocationListeners.delete(listener);
  };
}

function notifyRevoked(runId: string): void {
  for (const l of revocationListeners) {
    try {
      l(runId);
    } catch {
      /* listeners must not break revocation */
    }
  }
}

function isExpired(s: Share, now: number): boolean {
  return s.expiresAt <= now;
}

/** Drop every expired share. Called lazily from the read paths + by the sweeper. */
export function sweepExpiredShares(now: number = Date.now()): number {
  let dropped = 0;
  for (const [tok, s] of byToken) {
    if (isExpired(s, now)) {
      byToken.delete(tok);
      notifyRevoked(s.runId);
      dropped += 1;
    }
  }
  return dropped;
}

/**
 * Mint a share for one run. ttlMs is clamped to [1min, 24h]. Returns the FULL
 * share INCLUDING the secret token — this is the single moment the secret is
 * handed out (the route puts it in the QR URL). Never log or re-return it; every
 * other read path uses the stripped PublicShare.
 */
export function mintShare(
  runId: string,
  opts: { canInput?: boolean; ttlMs?: number } = {},
  now: number = Date.now(),
): Share {
  const ttl = Math.min(MAX_TTL_MS, Math.max(MIN_TTL_MS, opts.ttlMs ?? DEFAULT_TTL_MS));
  const share: Share = {
    id: crypto.randomBytes(9).toString('base64url'), // 12-char handle
    token: crypto.randomBytes(32).toString('hex'), // 64-char secret
    runId,
    canInput: opts.canInput ?? true,
    createdAt: now,
    expiresAt: now + ttl,
  };
  byToken.set(share.token, share);
  return share;
}

/**
 * Validate a token. Returns the live Share when the token exists, isn't expired,
 * and (when `runId` is given) is scoped to THAT run — else null. Always pass the
 * runId being accessed so a share for run A can never reach run B.
 */
export function validateShare(
  token: string | null | undefined,
  runId?: string,
  now: number = Date.now(),
): Share | null {
  if (!token) return null;
  const s = byToken.get(token);
  if (!s) return null;
  if (isExpired(s, now)) {
    byToken.delete(token);
    return null;
  }
  if (runId !== undefined && s.runId !== runId) return null;
  return s;
}

/** Revoke by public id. Returns true if a share was removed. */
export function revokeShare(id: string): boolean {
  for (const [tok, s] of byToken) {
    if (s.id === id) {
      byToken.delete(tok);
      notifyRevoked(s.runId);
      return true;
    }
  }
  return false;
}

/** Revoke every share for a run (its run ended / was closed). Returns the count. */
export function revokeSharesForRun(runId: string): number {
  let removed = 0;
  for (const [tok, s] of byToken) {
    if (s.runId === runId) {
      byToken.delete(tok);
      notifyRevoked(s.runId);
      removed += 1;
    }
  }
  return removed;
}

/** Public view of all non-expired shares (sweeps expired ones first). */
export function listShares(now: number = Date.now()): PublicShare[] {
  sweepExpiredShares(now);
  return [...byToken.values()].map(toPublic);
}

/** How many non-expired shares exist (drives the relay's on/off refcount). */
export function activeShareCount(now: number = Date.now()): number {
  sweepExpiredShares(now);
  return byToken.size;
}

/** Test-only: wipe all shares. */
export function _clearAllShares(): void {
  byToken.clear();
}

function toPublic(s: Share): PublicShare {
  return {
    id: s.id,
    runId: s.runId,
    canInput: s.canInput,
    createdAt: s.createdAt,
    expiresAt: s.expiresAt,
  };
}
