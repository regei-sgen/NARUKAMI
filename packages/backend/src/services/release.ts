import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { gitStatus, type GitFileStatus } from './gitStatus';
import { currentBranch } from './gitEditor';

const execFileAsync = promisify(execFile);

// `git archive` zips the whole tracked tree — give it more room than the 10s
// status budget, but still bounded so a wedged git can't hang a request forever.
const GIT_TIMEOUT_MS = 60_000;
const GIT_MAX_BUFFER = 64 * 1024 * 1024;

/** The three files the SGA version lives in (VERSION.md § Versioning policy). */
export const SGA_VERSION_FILES = [
  'VERSION.md',
  'bridge/package.json',
  'extension/manifest.json',
] as const;

/** Product name used in the patch-note heading ("**SG Assistant 2.7.1** — …"). */
export const SGA_PRODUCT_NAME = 'SG Assistant';
/** Zip filename prefix — matches the historical release zips (~/sgen-claude-chat-v<x>.zip). */
export const SGA_ZIP_PREFIX = 'sgen-claude-chat';

export const VERSION_RE = /^\d+\.\d+\.\d+$/;

async function git(repoPath: string, args: string[]): Promise<string> {
  const { stdout } = await execFileAsync('git', ['-C', repoPath, ...args], {
    timeout: GIT_TIMEOUT_MS,
    windowsHide: true,
    maxBuffer: GIT_MAX_BUFFER,
    // Treat every pathspec literally so a caller-supplied path can't use git magic.
    env: { ...process.env, GIT_LITERAL_PATHSPECS: '1' },
  });
  return stdout;
}

/** Local 'YYYY-MM-DD' — the date stamped into VERSION.md's header line. */
export function localDateKey(d: Date = new Date()): string {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
}

/**
 * Surgical version bump for package.json / manifest.json: replace only the FIRST
 * `"version": "…"` occurrence. Never JSON.parse+stringify — that would reformat
 * the whole file and produce a noisy diff.
 */
export function bumpJsonVersion(content: string, version: string): string {
  return content.replace(/("version"\s*:\s*")[^"]*(")/, `$1${version}$2`);
}

/**
 * Bump VERSION.md's header line: `**Current:** \`2.7.0\` — 2026-07-01` →
 * new version + today. Tolerates an em dash or hyphen separator.
 */
export function bumpVersionMd(content: string, version: string, date: string): string {
  return content.replace(
    /^(\*\*Current:\*\*\s*`)[^`]*(`\s*[—-]+\s*).*$/m,
    `$1${version}$2${date}`,
  );
}

/** `2.7.0` → `2.7.1` (patch + 1); null when the current version isn't SemVer. */
export function suggestNextVersion(current: string | null): string | null {
  if (!current || !VERSION_RE.test(current)) return null;
  const [maj, min, pat] = current.split('.').map(Number);
  return `${maj}.${min}.${pat + 1}`;
}

/** The `## [Unreleased]` section body of a Keep-a-Changelog file ('' if absent). */
export function extractUnreleased(changelog: string): string {
  const start = changelog.search(/^##\s*\[Unreleased\]/im);
  if (start === -1) return '';
  const rest = changelog.slice(start);
  const afterHeading = rest.indexOf('\n');
  if (afterHeading === -1) return '';
  const body = rest.slice(afterHeading + 1);
  const next = body.search(/^##\s*\[/m);
  return (next === -1 ? body : body.slice(0, next)).trim();
}

/** AppSetting key holding the permanent zip output folder (JSON string value). */
export const ZIP_DIR_SETTING_KEY = 'releaseZipDir';

/**
 * Validate + prepare the zip output folder: absolute path required; created
 * (recursively) when missing; a file at the path is refused. Returns the
 * resolved path.
 */
export function ensureZipDir(raw: string): string {
  const trimmed = raw.trim();
  if (!trimmed || !path.isAbsolute(trimmed)) {
    throw new Error('Zip folder must be an absolute path (e.g. C:\\Users\\you\\Releases).');
  }
  const resolved = path.resolve(trimmed);
  if (fs.existsSync(resolved)) {
    if (!fs.statSync(resolved).isDirectory()) {
      throw new Error('Zip folder path points at a file, not a folder.');
    }
  } else {
    fs.mkdirSync(resolved, { recursive: true });
  }
  return resolved;
}

export interface SgaFingerprint {
  isSga: boolean;
  missing: string[];
}

/** A project "is the SGA" when all three version files exist at their known paths. */
export function fingerprintSga(projectPath: string): SgaFingerprint {
  const missing = SGA_VERSION_FILES.filter(
    (rel) => !fs.existsSync(path.join(projectPath, rel)),
  );
  return { isSga: missing.length === 0, missing };
}

/** Current version from bridge/package.json (the machine-readable source of truth). */
export function readCurrentVersion(projectPath: string): string | null {
  try {
    const raw = fs.readFileSync(path.join(projectPath, 'bridge', 'package.json'), 'utf8');
    const v = (JSON.parse(raw) as { version?: unknown }).version;
    return typeof v === 'string' ? v : null;
  } catch {
    return null;
  }
}

/** Dirty files that are NOT the three version files (those change as part of a release). */
export function dirtyBeyondVersionFiles(files: GitFileStatus[]): GitFileStatus[] {
  const versionFiles = new Set<string>(SGA_VERSION_FILES);
  return files.filter((f) => !versionFiles.has(f.path));
}

export interface ReleasePreflightResult {
  isRepo: boolean;
  isSga: boolean;
  missing: string[];
  currentVersion: string | null;
  suggestedVersion: string | null;
  dirty: GitFileStatus[];
  /** Current branch name (short SHA when detached; null off-repo). */
  branch: string | null;
}

export async function releasePreflight(projectPath: string): Promise<ReleasePreflightResult> {
  const { isSga, missing } = fingerprintSga(projectPath);
  const currentVersion = readCurrentVersion(projectPath);
  const [status, branchInfo] = await Promise.all([
    gitStatus(projectPath),
    currentBranch(projectPath),
  ]);
  return {
    isRepo: status.isRepo,
    isSga,
    missing,
    currentVersion,
    suggestedVersion: suggestNextVersion(currentVersion),
    dirty: status.files,
    branch: branchInfo.branch,
  };
}

export interface CommitBumpResult {
  commit: string;
  message: string;
  files: string[];
}

/**
 * Commit ONLY the three version files with the automatic release message
 * (`chore(release): bump to v<version>` — version read from the already-bumped
 * bridge/package.json). Pathspec commit, so other dirty/staged work is left
 * exactly as it was. Throws when the version files match HEAD.
 */
export async function commitVersionBump(projectPath: string): Promise<CommitBumpResult> {
  const status = await gitStatus(projectPath);
  const versionFiles = new Set<string>(SGA_VERSION_FILES);
  const pending = status.files.filter((f) => versionFiles.has(f.path));
  if (pending.length === 0) {
    throw new Error('Nothing to commit — the three version files match HEAD.');
  }
  const version = readCurrentVersion(projectPath);
  const message = version ? `chore(release): bump to v${version}` : 'chore(release): version bump';
  await git(projectPath, ['commit', '-m', message, '--', ...SGA_VERSION_FILES]);
  const commit = (await git(projectPath, ['rev-parse', 'HEAD'])).trim();
  return { commit, message, files: pending.map((f) => f.path) };
}

export interface PushResult {
  branch: string;
  /** True when this push created the upstream (`push -u origin <branch>`). */
  upstreamCreated: boolean;
  detail: string;
}

// A push crosses the network — allow more than the local-git budget, and never
// let git sit on a credential prompt (fail fast instead).
const PUSH_TIMEOUT_MS = 120_000;

/** Push the current branch (creating origin upstream on the first push). */
export async function pushCurrentBranch(projectPath: string): Promise<PushResult> {
  const info = await currentBranch(projectPath);
  if (!info.branch || info.detached) {
    throw new Error('Not on a branch (detached HEAD?) — check out a branch before pushing.');
  }
  let hasUpstream = true;
  try {
    await git(projectPath, ['rev-parse', '--abbrev-ref', '--symbolic-full-name', '@{u}']);
  } catch {
    hasUpstream = false;
  }
  const args = hasUpstream ? ['push'] : ['push', '-u', 'origin', info.branch];
  const { stdout, stderr } = await execFileAsync('git', ['-C', projectPath, ...args], {
    timeout: PUSH_TIMEOUT_MS,
    windowsHide: true,
    maxBuffer: GIT_MAX_BUFFER,
    env: { ...process.env, GIT_LITERAL_PATHSPECS: '1', GIT_TERMINAL_PROMPT: '0' },
  });
  return {
    branch: info.branch,
    upstreamCreated: !hasUpstream,
    detail: (stderr || stdout).trim().slice(0, 2000),
  };
}

export interface ReleaseZipResult {
  zipPath: string;
  zipBytes: number;
  headCommit: string | null;
  /** The throwaway stash commit that was archived, or 'HEAD' when nothing changed. */
  archivedTree: string;
}

/**
 * The release-zip flow: bump the three version files in the WORKING TREE
 * (uncommitted — the user commits when they choose), snapshot HEAD + working
 * tree via `git stash create` (no ref, no visible side effect), and
 * `git archive` that snapshot to ~/sgen-claude-chat-v<version>.zip. Tracked
 * files only — .git, node_modules, logs and uploads never ship. On any failure
 * the three files are restored to their pre-call contents.
 */
export async function buildReleaseZip(
  projectPath: string,
  version: string,
  outDir: string = os.homedir(),
): Promise<ReleaseZipResult> {
  if (!VERSION_RE.test(version)) {
    throw new Error(`Invalid version "${version}" — expected MAJOR.MINOR.PATCH.`);
  }

  const originals = new Map<string, string>();
  for (const rel of SGA_VERSION_FILES) {
    const abs = path.join(projectPath, rel);
    const raw = fs.readFileSync(abs, 'utf8');
    originals.set(abs, raw);
    const next =
      rel === 'VERSION.md'
        ? bumpVersionMd(raw, version, localDateKey())
        : bumpJsonVersion(raw, version);
    fs.writeFileSync(abs, next, 'utf8');
  }

  try {
    // Stage the bumps so `git stash create` includes them, snapshot, unstage —
    // the working tree keeps the bump as "modified, not staged".
    await git(projectPath, ['add', '--', ...SGA_VERSION_FILES]);
    let tree = '';
    try {
      tree = (await git(projectPath, ['stash', 'create'])).trim();
    } finally {
      await git(projectPath, ['restore', '--staged', '--', ...SGA_VERSION_FILES]);
    }
    // Empty output = nothing differs from HEAD (e.g. re-zipping the same version).
    const archivedTree = tree || 'HEAD';

    const zipPath = path.join(outDir, `${SGA_ZIP_PREFIX}-v${version}.zip`);
    await git(projectPath, ['archive', '--format=zip', '-o', zipPath, archivedTree]);

    const zipBytes = fs.statSync(zipPath).size;
    let headCommit: string | null = null;
    try {
      headCommit = (await git(projectPath, ['rev-parse', 'HEAD'])).trim();
    } catch {
      headCommit = null;
    }
    return { zipPath, zipBytes, headCommit, archivedTree };
  } catch (err) {
    for (const [abs, raw] of originals) {
      try {
        fs.writeFileSync(abs, raw, 'utf8');
      } catch {
        // best-effort restore — the original error below matters more
      }
    }
    throw err;
  }
}

export interface NotesMaterial {
  /** CHANGELOG.md's [Unreleased] section (capped; '' when absent). */
  changelog: string;
  /** `git log --oneline` for the release's commit range (capped; '' on failure). */
  commits: string;
  /** Human description of which commit range was used. */
  rangeLabel: string;
}

// The prompt travels on the claude argv (Windows command lines cap ~32k chars) —
// keep the embedded material well under that.
const CHANGELOG_CAP = 12_000;
const COMMITS_CAP = 6_000;

/**
 * Source material for the patch notes. Commit range: since the previous
 * NARUKAMI-recorded release HEAD; first run falls back to the last commit that
 * touched VERSION.md (the previous manual bump); last resort = newest 150.
 */
export async function collectNotesMaterial(
  projectPath: string,
  prevHeadCommit: string | null,
): Promise<NotesMaterial> {
  let changelog = '';
  try {
    changelog = extractUnreleased(
      fs.readFileSync(path.join(projectPath, 'CHANGELOG.md'), 'utf8'),
    ).slice(0, CHANGELOG_CAP);
  } catch {
    changelog = '';
  }

  let range: string | null = null;
  let rangeLabel = 'the most recent 150 commits';
  if (prevHeadCommit && /^[0-9a-f]{7,40}$/i.test(prevHeadCommit)) {
    try {
      await git(projectPath, ['cat-file', '-e', `${prevHeadCommit}^{commit}`]);
      range = `${prevHeadCommit}..HEAD`;
      rangeLabel = `commits since the previous release (${prevHeadCommit.slice(0, 7)}..HEAD)`;
    } catch {
      range = null;
    }
  }
  if (!range) {
    try {
      const lastBump = (
        await git(projectPath, ['log', '-1', '--format=%H', '--', 'VERSION.md'])
      ).trim();
      if (lastBump) {
        range = `${lastBump}..HEAD`;
        rangeLabel = `commits since the last version bump (${lastBump.slice(0, 7)}..HEAD)`;
      }
    } catch {
      // fall through to the count fallback
    }
  }

  let commits = '';
  try {
    const args = range
      ? ['log', '--no-merges', '--oneline', range]
      : ['log', '--no-merges', '--oneline', '-150'];
    commits = (await git(projectPath, args)).trim().slice(0, COMMITS_CAP);
  } catch {
    commits = '';
  }

  return { changelog, commits, rangeLabel };
}
