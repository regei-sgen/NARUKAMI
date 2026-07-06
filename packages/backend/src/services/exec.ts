import fs from 'node:fs';
import path from 'node:path';

/**
 * Resolve an executable to a full path via PATH + PATHEXT. Unlike libuv's
 * execFile, node-pty's spawn does NOT search PATH/PATHEXT for a bare name on
 * Windows, so `claude` must be resolved to `…\claude.exe` (or `…\claude.cmd`)
 * before spawning. Returns the bare name if not found (let spawn surface a
 * clear ENOENT).
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

/**
 * Prepare a resolved executable + args for spawning on Windows. A `.cmd`/`.bat`
 * shim (how npm global installs expose CLIs like `claude`) is NOT a real
 * executable image, so both node-pty's ConPTY CreateProcess and — since the fix
 * for CVE-2024-27980 — Node's execFile/spawn refuse to launch it directly
 * (EINVAL). Route those through `cmd.exe /c`. A real `.exe`, or any non-Windows
 * platform, is returned unchanged.
 */
export function wrapForWindows(file: string, args: string[]): { file: string; args: string[] } {
  if (process.platform === 'win32' && /\.(cmd|bat)$/i.test(file)) {
    return { file: process.env.COMSPEC || 'cmd.exe', args: ['/c', file, ...args] };
  }
  return { file, args };
}
