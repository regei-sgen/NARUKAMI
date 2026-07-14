import fs from 'node:fs';
import path from 'node:path';

/**
 * Resolve an executable to a full path via PATH + PATHEXT. Unlike libuv's
 * execFile, node-pty's spawn does NOT search PATH/PATHEXT for a bare name on
 * Windows, so e.g. `claude` / `bash` must be resolved to `…\claude.exe` before
 * spawning. Returns the bare name if not found (let spawn surface a clear error).
 *
 * Kept in its own module so both runner.ts and shells.ts can use it without an
 * import cycle.
 */
export function resolveExecutable(name: string): string {
  const isWin = process.platform === 'win32';
  const sep = isWin ? ';' : ':';
  const exts = isWin ? (process.env.PATHEXT || '.EXE;.CMD;.BAT;.COM').split(';') : [''];
  const dirs = (process.env.PATH || '').split(sep).filter(Boolean);
  for (const dir of dirs) {
    for (const ext of exts) {
      const candidate = path.join(dir, name + ext);
      try {
        if (fs.statSync(candidate).isFile()) return candidate;
      } catch {
        /* not here — keep looking */
      }
    }
  }
  return name;
}
