import fs from 'node:fs';
import path from 'node:path';

export const HOST = '127.0.0.1';
export const PORT = Number(process.env.PORT ?? 4000);

// The Vite dev server origin(s). Bound to loopback only — this app must never
// be reachable from another machine or another website in the browser.
export const ALLOWED_ORIGINS: ReadonlySet<string> = new Set([
  'http://localhost:5173',
  'http://127.0.0.1:5173',
]);

/**
 * Walk up from `start` looking for the monorepo root (the directory that holds
 * package-lock.json). Works whether we're running from `src/` via tsx or from
 * a compiled `dist/`.
 */
export function findRepoRoot(start: string): string {
  let dir = start;
  for (let i = 0; i < 8; i += 1) {
    if (fs.existsSync(path.join(dir, 'package-lock.json'))) return dir;
    const parent = path.dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  // Fallback: two levels up from packages/backend/{src,dist}
  return path.resolve(start, '..', '..', '..');
}

export const REPO_ROOT = findRepoRoot(__dirname);

export const TOKEN_FILE =
  process.env.RUNNER_TOKEN_FILE ?? path.join(REPO_ROOT, '.runner-token');
