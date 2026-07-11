import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);

const GIT_TIMEOUT_MS = 10_000;
const MAX_HEAD_BYTES = 2 * 1024 * 1024; // committed blobs larger than this aren't diffed

export interface BranchInfo {
  /** Branch name, or the short SHA when in detached HEAD. null if not a git repo / git missing. */
  branch: string | null;
  detached: boolean;
}

/**
 * The current branch of the repo at `cwd` — a real-time label for the editor.
 * Uses `git branch --show-current`; an empty result means detached HEAD, so we
 * fall back to the short SHA. Read-only, fail-soft (non-git dir → { branch:null }).
 */
export async function currentBranch(cwd: string): Promise<BranchInfo> {
  try {
    const { stdout } = await execFileAsync('git', ['-C', cwd, 'branch', '--show-current'], {
      timeout: GIT_TIMEOUT_MS,
      windowsHide: true,
    });
    const name = stdout.trim();
    if (name) return { branch: name, detached: false };
    // Detached HEAD → identify by short SHA.
    const { stdout: sha } = await execFileAsync('git', ['-C', cwd, 'rev-parse', '--short', 'HEAD'], {
      timeout: GIT_TIMEOUT_MS,
      windowsHide: true,
    });
    const s = sha.trim();
    return s ? { branch: s, detached: true } : { branch: null, detached: false };
  } catch {
    return { branch: null, detached: false };
  }
}

/**
 * The COMMITTED (HEAD) content of `relPosix` (repo-relative, forward slashes) in
 * the repo at `cwd`. `git -C cwd show HEAD:./<rel>` resolves the path relative to
 * cwd, so it works whether the project is the repo root or a subdirectory.
 * Returns null when the file is new/untracked/absent from HEAD or `cwd` isn't a
 * repo — the caller then diffs against an empty committed side.
 */
export async function fileAtHead(cwd: string, relPosix: string): Promise<string | null> {
  try {
    const { stdout } = await execFileAsync('git', ['-C', cwd, 'show', `HEAD:./${relPosix}`], {
      timeout: GIT_TIMEOUT_MS,
      windowsHide: true,
      maxBuffer: MAX_HEAD_BYTES,
    });
    return stdout;
  } catch {
    return null;
  }
}
