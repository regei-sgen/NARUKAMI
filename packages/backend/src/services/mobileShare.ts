import { getBaseUrl } from './serverInfo';
import {
  activeShareCount,
  listShares,
  mintShare,
  revokeShare,
  sweepExpiredShares,
  type Share,
} from './shareTokens';
import { activeLanAddress, isRelayRunning, startRelay, stopRelay } from './lanRelay';
import { clearDevicesForRun, listDevices } from './mobileDevices';
import { isRunning } from './runner';

/**
 * Orchestrates the two halves of a mobile share: the scoped token (shareTokens)
 * and the LAN reachability (lanRelay). Keeps the "start the relay on the first
 * share, stop it when the last one is gone" refcount in ONE place so routes and
 * the periodic sweep can't drift out of sync.
 */

export interface ShareResult {
  id: string;
  runId: string;
  canInput: boolean;
  expiresAt: number;
  /** The full URL the QR encodes (contains the secret token — treat as private). */
  url: string;
  relay: { host: string; port: number };
}

/** The loopback port the backend is bound to (relay forwards here). */
function loopbackPort(): number {
  const base = getBaseUrl();
  if (!base) throw new Error('Server base URL not set yet.');
  const port = Number(new URL(base).port);
  if (!Number.isFinite(port) || port <= 0) throw new Error('Could not determine backend port.');
  return port;
}

/**
 * Create a share for a run and ensure the LAN relay is up. Returns the QR URL.
 * The caller has already checked the run exists and is master-token-authenticated.
 */
export async function createShare(
  runId: string,
  opts: { canInput?: boolean; ttlMs?: number },
): Promise<ShareResult> {
  // Start the relay FIRST: minting before the relay is confirmed up would leave a
  // dangling token if the bind fails (no LAN interface). This order fails clean.
  const relay = await startRelay(loopbackPort());
  const share: Share = mintShare(runId, opts);
  const url = `http://${relay.host}:${relay.port}/?m=${encodeURIComponent(share.token)}&run=${encodeURIComponent(runId)}`;
  return {
    id: share.id,
    runId: share.runId,
    canInput: share.canInput,
    expiresAt: share.expiresAt,
    url,
    relay,
  };
}

/** Revoke one share and stop the relay if it was the last. */
export async function removeShare(id: string): Promise<boolean> {
  const removed = revokeShare(id);
  await reconcileRelay();
  return removed;
}

/**
 * Reconcile relay state against live shares. Sweeps expired shares AND revokes
 * shares whose terminal has ended (a dead runId's share is useless anyway), then
 * stops the relay once none remain — so the LAN closes when a share expires OR
 * when the shared terminal dies, never lingering past a usable share. Called
 * after a revoke and on a periodic timer.
 */
export async function reconcileRelay(): Promise<void> {
  sweepExpiredShares();
  // Drop shares whose run is no longer live — keeps the LAN open only as long as
  // there's actually something to watch.
  for (const s of listShares()) {
    if (!isRunning(s.runId)) revokeShare(s.id);
  }
  // Device approvals live exactly as long as some share for their run does:
  // once a run has no share, a lingering approval would silently re-admit the
  // phone on the NEXT share of that run — fail closed and make it knock again.
  const sharedRuns = new Set(listShares().map((s) => s.runId));
  for (const d of listDevices()) {
    if (!sharedRuns.has(d.runId)) clearDevicesForRun(d.runId);
  }
  if (activeShareCount() === 0 && isRelayRunning()) {
    await stopRelay();
  }
}

/** Current relay address for status display (null when not sharing). */
export function relayStatus(): { host: string; port: number } | null {
  return activeLanAddress();
}
