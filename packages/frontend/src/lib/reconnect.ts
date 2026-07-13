import { normalizeStatus } from './runStatus';
import type { RunStatus } from '../types';

// The run's liveness as reported by GET /api/runs/:id — `live` is the in-memory
// pty state; `status`/`exitCode` are the persisted row.
export interface RunLiveness {
  live: boolean;
  status: string;
  exitCode: number | null;
}

// What a dropped terminal socket should do next, decided purely from liveness:
// - reconnect: the pty is still alive → reattach and replay scrollback.
// - settle:    the pty has really ended → show its final status (don't reconnect).
// - retry:     transient (backend unreachable / status in flux) → try again.
// - giveup:    retried past the cap → surface an error the user can Restart from.
export type ReconnectAction =
  | { kind: 'reconnect' }
  | { kind: 'settle'; status: RunStatus; exitCode: number | null }
  | { kind: 'retry' }
  | { kind: 'giveup' };

/**
 * Decide how a terminal should recover after its socket dropped, given the run's
 * liveness and how many reconnect attempts have already been made. Kept pure (no
 * timers, no websocket) so the recovery policy is unit-testable.
 */
export function nextReconnectAction(
  info: RunLiveness,
  attempts: number,
  max: number,
): ReconnectAction {
  if (info.live) return { kind: 'reconnect' };
  const s = info.status;
  // A concrete terminal status means the process genuinely ended while we were
  // disconnected — settle on it rather than reconnecting to a dead run.
  if (s && s !== 'running' && s !== 'connecting') {
    return { kind: 'settle', status: normalizeStatus(s), exitCode: info.exitCode ?? null };
  }
  // Not live yet, but not conclusively ended either (backend still coming up, or
  // a stale 'running' row): keep trying until the attempt cap.
  return attempts >= max ? { kind: 'giveup' } : { kind: 'retry' };
}
