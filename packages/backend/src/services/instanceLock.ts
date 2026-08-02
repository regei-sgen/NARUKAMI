import fs from 'node:fs';
import path from 'node:path';
import { TOKEN_FILE } from '../config';

// A lock directory next to the token/DB records the PID of EVERY instance using
// this database — one file per pid, named after it. It exists so a SECOND backend
// launched against the same SQLite file doesn't run reconcileStaleRuns() and mark
// the first (live) instance's runs 'exited'. This is an advisory, best-effort
// guard for a single-user local app — not a hard mutex (a near-simultaneous
// double start can still race).
//
// One file PER pid rather than one shared file: with a shared file the FIRST
// instance's exit handler deleted the protection a SURVIVING second instance was
// relying on, and a third boot then reconciled that survivor's genuinely-live
// runs to 'exited'. A departing instance can now only ever remove its own entry.
const LOCK_DIR = path.join(path.dirname(TOKEN_FILE), '.narukami-locks');
// Pre-lock-dir versions wrote a single pid here. Still honoured on READ so a
// mixed-version pair of instances still sees each other — missing a live peer is
// the dangerous direction (we would clobber its runs); seeing a stale one only
// costs a skipped reconcile.
const LEGACY_LOCK_FILE = path.join(path.dirname(TOKEN_FILE), '.narukami.lock');

/**
 * Does a process with this pid currently exist? Signal 0 runs the kernel's
 * existence + permission check without delivering anything.
 *
 * Exported because runner.ts needs the same liveness primitive for its
 * belt-and-braces reconcile guard (see reconcileStaleRuns) — this module owns
 * the single copy. The import direction is safe: this file pulls in only
 * node:fs, node:path and ../config, so there is no cycle with runner.ts.
 */
export function pidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    // EPERM => the process exists but is owned by someone else — still "alive".
    return (err as NodeJS.ErrnoException).code === 'EPERM';
  }
}

/** Pids recorded in the lock dir (garbage entries dropped). */
function lockDirPids(): number[] {
  try {
    return fs
      .readdirSync(LOCK_DIR)
      .map(Number)
      .filter((pid) => Number.isInteger(pid) && pid > 0);
  } catch {
    return []; // no lock dir — nothing recorded
  }
}

/** Every pid recorded as an instance, in either layout. This process included. */
function recordedPids(): number[] {
  const pids = lockDirPids();
  try {
    const legacy = Number(fs.readFileSync(LEGACY_LOCK_FILE, 'utf8').trim());
    if (Number.isInteger(legacy) && legacy > 0) pids.push(legacy);
  } catch {
    /* no legacy lock (or unreadable) — ignore */
  }
  return pids;
}

/** True if another LIVE instance already holds the lock for this database. */
export function anotherInstanceRunning(): boolean {
  return recordedPids().some((pid) => pid !== process.pid && pidAlive(pid));
}

/** Drop this process's own entry. Runs on exit; safe to call more than once. */
export function releaseInstanceLock(): void {
  try {
    fs.rmSync(path.join(LOCK_DIR, String(process.pid)), { force: true });
  } catch {
    /* already gone — ignore */
  }
}

/**
 * Record this process as a live instance and release it on exit (best-effort).
 * EVERY instance claims — including one that found a peer — so a later boot can
 * see it and leave its runs alone.
 */
export function claimInstanceLock(): void {
  try {
    fs.mkdirSync(LOCK_DIR, { recursive: true });
    fs.writeFileSync(path.join(LOCK_DIR, String(process.pid)), String(Date.now()), 'utf8');
    // Sweep entries left by instances that died without running their exit
    // handler (crash / SIGKILL), so a dead pid can't pin the lock forever.
    for (const pid of lockDirPids()) {
      if (pid !== process.pid && !pidAlive(pid)) {
        fs.rmSync(path.join(LOCK_DIR, String(pid)), { force: true });
      }
    }
    process.on('exit', releaseInstanceLock);
  } catch {
    /* couldn't write the lock — proceed without it */
  }
}
