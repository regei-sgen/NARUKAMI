import fs from 'node:fs';
import path from 'node:path';
import { resolveExecutable } from './resolveExecutable';

// The interactive shells a Windows terminal can open. On non-Windows there is a
// single POSIX login shell (`$SHELL`), reported under the 'powershell' slot as
// the generic default so the frontend has one stable entry to show.
export type ShellKind = 'powershell' | 'cmd' | 'gitbash';

export interface ShellInfo {
  kind: ShellKind;
  label: string;
  available: boolean;
}

const LABELS: Record<ShellKind, string> = {
  powershell: 'PowerShell',
  cmd: 'CMD',
  gitbash: 'Git Bash',
};

/** Display name for a shell kind (also stored in Run.name so restart/reload can
 *  recover the kind via {@link shellKindFromLabel}). */
export function shellLabel(kind: ShellKind): string {
  return LABELS[kind];
}

/** Inverse of {@link shellLabel}: recover a kind from a stored Run.name label.
 *  Falls back to PowerShell for unknown/legacy names. Pure. */
export function shellKindFromLabel(name: string | null | undefined): ShellKind {
  const hit = (Object.keys(LABELS) as ShellKind[]).find((k) => LABELS[k] === name);
  return hit ?? 'powershell';
}

/**
 * Map a resolved `git.exe` path to the sibling Git Bash, or null if the layout
 * isn't a recognizable Git-for-Windows install. Git ships `git.exe` in either
 * `<root>\cmd\git.exe` (the one usually on PATH) or `<root>\bin\git.exe`, with
 * `bash.exe` at `<root>\bin\bash.exe`. Pure (no I/O) so it's unit-testable.
 */
export function gitBashFromGitExe(gitPath: string): string | null {
  const norm = gitPath.replace(/\//g, '\\');
  const m = /^(.*)\\(?:cmd|bin|mingw64\\bin)\\git\.exe$/i.exec(norm);
  if (!m) return null;
  return path.join(m[1], 'bin', 'bash.exe');
}

/** Well-known Git-for-Windows bash locations (checked before deriving from git). */
function gitBashCandidates(): string[] {
  const out: string[] = [];
  const pf = process.env.ProgramFiles;
  const pf86 = process.env['ProgramFiles(x86)'];
  const local = process.env.LOCALAPPDATA;
  if (pf) out.push(path.join(pf, 'Git', 'bin', 'bash.exe'));
  if (pf86) out.push(path.join(pf86, 'Git', 'bin', 'bash.exe'));
  if (local) out.push(path.join(local, 'Programs', 'Git', 'bin', 'bash.exe'));
  return out;
}

/**
 * Locate Git Bash (`bash.exe` from Git for Windows), or null if not installed.
 * Deliberately does NOT use a bare PATH lookup for `bash`, because that finds
 * `C:\Windows\System32\bash.exe` — the WSL launcher, not Git Bash. `candidates`
 * is injectable for tests; `derive` supplies the git.exe path (defaults to the
 * PATH-resolved one).
 */
export function resolveGitBash(
  candidates: string[] = gitBashCandidates(),
  derive: () => string = () => resolveExecutable('git'),
): string | null {
  for (const c of candidates) {
    try {
      if (fs.statSync(c).isFile()) return c;
    } catch {
      /* not here */
    }
  }
  const fromGit = gitBashFromGitExe(derive());
  if (fromGit) {
    try {
      if (fs.statSync(fromGit).isFile()) return fromGit;
    } catch {
      /* git.exe resolved but no sibling bash — treat as absent */
    }
  }
  return null;
}

/**
 * The file + args to open an interactive shell of `kind`, or null if that shell
 * isn't available on this machine. Windows only — callers handle POSIX via the
 * `$SHELL` branch in runner.interactiveShell().
 */
export function interactiveShellFor(kind: ShellKind): { file: string; args: string[] } | null {
  switch (kind) {
    case 'powershell':
      return { file: resolveExecutable('powershell'), args: ['-NoLogo'] };
    case 'cmd':
      return { file: resolveExecutable('cmd'), args: [] };
    case 'gitbash': {
      const bash = resolveGitBash();
      // `-i` interactive, `-l` login so PATH and ~/.bash_profile/.bashrc load.
      return bash ? { file: bash, args: ['-i', '-l'] } : null;
    }
  }
}

/**
 * Which shells this machine can open, for the terminal's shell menu. Windows
 * reports all three with an `available` flag (PowerShell + CMD are always
 * present; Git Bash depends on Git for Windows). Non-Windows reports a single
 * generic "Shell" entry (the login `$SHELL`).
 */
export function availableShells(): ShellInfo[] {
  if (process.platform !== 'win32') {
    return [{ kind: 'powershell', label: 'Shell', available: true }];
  }
  return (Object.keys(LABELS) as ShellKind[]).map((kind) => ({
    kind,
    label: LABELS[kind],
    available: interactiveShellFor(kind) !== null,
  }));
}
