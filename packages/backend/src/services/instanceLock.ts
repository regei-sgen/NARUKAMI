import fs from 'node:fs';
import path from 'node:path';
import { TOKEN_FILE } from '../config';

// A lock file next to the token/DB records the PID of the instance that owns this
// database. It exists so a SECOND backend launched against the same SQLite file
// doesn't run reconcileStaleRuns() and mark the first (live) instance's runs
// 'exited'. This is an advisory, best-effort guard for a single-user local app —
// not a hard mutex (a near-simultaneous double start can still race).
const LOCK_FILE = path.join(path.dirname(TOKEN_FILE), '.narukami.lock');

function pidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    // EPERM => the process exists but is owned by someone else — still "alive".
    return (err as NodeJS.ErrnoException).code === 'EPERM';
  }
}

/** True if another LIVE instance already holds the lock for this database. */
export function anotherInstanceRunning(): boolean {
  try {
    const pid = Number(fs.readFileSync(LOCK_FILE, 'utf8').trim());
    return Number.isInteger(pid) && pid > 0 && pid !== process.pid && pidAlive(pid);
  } catch {
    return false; // no lock file (or unreadable) — treat as free
  }
}

/** Claim the lock for this process and release it on exit (best-effort). */
export function claimInstanceLock(): void {
  try {
    fs.writeFileSync(LOCK_FILE, String(process.pid), 'utf8');
    process.on('exit', () => {
      try {
        if (Number(fs.readFileSync(LOCK_FILE, 'utf8').trim()) === process.pid) {
          fs.rmSync(LOCK_FILE, { force: true });
        }
      } catch {
        /* already gone — ignore */
      }
    });
  } catch {
    /* couldn't write the lock — proceed without it */
  }
}
