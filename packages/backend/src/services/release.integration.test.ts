import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  buildReleaseZip,
  collectNotesMaterial,
  commitVersionBump,
  pushCurrentBranch,
  releasePreflight,
} from './release';

/**
 * End-to-end proof of the zip build against a REAL temp git repo shaped like
 * the SGA (the three version files + CHANGELOG + one extra file). No mocks —
 * this exercises the exact add → stash create → restore → archive sequence.
 */

function git(repo: string, args: string[]): string {
  return execFileSync('git', ['-C', repo, ...args], {
    encoding: 'utf8',
    windowsHide: true,
  });
}

const VERSION_MD = '# Version\n\n**Current:** `0.0.1` — 2026-01-01\n**Main branch:** `main`\n';
const PKG = '{\n  "name": "sga-fixture",\n  "version": "0.0.1"\n}\n';
const MANIFEST = '{\n  "manifest_version": 3,\n  "version": "0.0.1"\n}\n';
const CHANGELOG =
  '# Changelog\n\n## [Unreleased]\n\n- Added the fixture feature.\n\n## [0.0.1] — 2026-01-01\n\n- Initial.\n';

let repo: string;
let outDir: string;

beforeAll(() => {
  repo = fs.mkdtempSync(path.join(os.tmpdir(), 'narukami-release-repo-'));
  outDir = fs.mkdtempSync(path.join(os.tmpdir(), 'narukami-release-out-'));
  fs.mkdirSync(path.join(repo, 'bridge'), { recursive: true });
  fs.mkdirSync(path.join(repo, 'extension'), { recursive: true });
  fs.writeFileSync(path.join(repo, 'VERSION.md'), VERSION_MD);
  fs.writeFileSync(path.join(repo, 'bridge', 'package.json'), PKG);
  fs.writeFileSync(path.join(repo, 'extension', 'manifest.json'), MANIFEST);
  fs.writeFileSync(path.join(repo, 'CHANGELOG.md'), CHANGELOG);
  fs.writeFileSync(path.join(repo, 'other.txt'), 'hello\n');
  git(repo, ['init', '-q']);
  git(repo, ['config', 'user.email', 'test@narukami.local']);
  git(repo, ['config', 'user.name', 'NARUKAMI Test']);
  git(repo, ['add', '-A']);
  git(repo, ['commit', '-q', '-m', 'chore(release): bump to 0.0.1']);
}, 30_000);

afterAll(() => {
  fs.rmSync(repo, { recursive: true, force: true });
  fs.rmSync(outDir, { recursive: true, force: true });
});

describe('buildReleaseZip (real git)', () => {
  it('bumps the tree, archives the bump, and leaves the bump uncommitted', async () => {
    const res = await buildReleaseZip(repo, '0.0.2', outDir);

    // The zip landed and is non-trivial.
    expect(res.zipPath).toBe(path.join(outDir, 'sgen-claude-chat-v0.0.2.zip'));
    expect(fs.existsSync(res.zipPath)).toBe(true);
    expect(res.zipBytes).toBeGreaterThan(100);
    expect(fs.statSync(res.zipPath).size).toBe(res.zipBytes);

    // The archived snapshot (stash commit) carries the bumped version strings.
    expect(res.archivedTree).not.toBe('HEAD');
    expect(git(repo, ['show', `${res.archivedTree}:bridge/package.json`])).toContain('"version": "0.0.2"');
    expect(git(repo, ['show', `${res.archivedTree}:extension/manifest.json`])).toContain('"version": "0.0.2"');
    expect(git(repo, ['show', `${res.archivedTree}:VERSION.md`])).toContain('`0.0.2`');

    // The working tree kept the bump…
    expect(fs.readFileSync(path.join(repo, 'VERSION.md'), 'utf8')).toContain('`0.0.2`');
    expect(fs.readFileSync(path.join(repo, 'bridge', 'package.json'), 'utf8')).toContain('0.0.2');

    // …as modified-but-UNSTAGED (nothing committed, nothing left in the index).
    const status = git(repo, ['status', '--porcelain']);
    expect(status).toContain(' M VERSION.md');
    expect(status).toContain(' M bridge/package.json');
    expect(status).toContain(' M extension/manifest.json');

    // HEAD unchanged and recorded.
    expect(res.headCommit).toBe(git(repo, ['rev-parse', 'HEAD']).trim());
  }, 30_000);

  it('includes other uncommitted changes in the snapshot (the dirty-confirm case)', async () => {
    fs.appendFileSync(path.join(repo, 'other.txt'), 'uncommitted work\n');
    const res = await buildReleaseZip(repo, '0.0.3', outDir);
    expect(git(repo, ['show', `${res.archivedTree}:other.txt`])).toContain('uncommitted work');
  }, 30_000);

  it('rejects a malformed version', async () => {
    await expect(buildReleaseZip(repo, 'not-semver', outDir)).rejects.toThrow(/Invalid version/);
  });

  it('restores the version files when the archive step fails', async () => {
    const before = fs.readFileSync(path.join(repo, 'VERSION.md'), 'utf8');
    const missingDir = path.join(outDir, 'does', 'not', 'exist');
    await expect(buildReleaseZip(repo, '9.9.9', missingDir)).rejects.toThrow();
    expect(fs.readFileSync(path.join(repo, 'VERSION.md'), 'utf8')).toBe(before);
    expect(fs.readFileSync(path.join(repo, 'bridge', 'package.json'), 'utf8')).not.toContain('9.9.9');
  }, 30_000);
});

describe('commitVersionBump + pushCurrentBranch (real git, local bare origin)', () => {
  let repo2: string;
  let bare: string;
  let out2: string;

  beforeAll(() => {
    repo2 = fs.mkdtempSync(path.join(os.tmpdir(), 'narukami-release-cp-'));
    bare = fs.mkdtempSync(path.join(os.tmpdir(), 'narukami-release-bare-'));
    out2 = fs.mkdtempSync(path.join(os.tmpdir(), 'narukami-release-cpout-'));
    fs.mkdirSync(path.join(repo2, 'bridge'), { recursive: true });
    fs.mkdirSync(path.join(repo2, 'extension'), { recursive: true });
    fs.writeFileSync(path.join(repo2, 'VERSION.md'), VERSION_MD);
    fs.writeFileSync(path.join(repo2, 'bridge', 'package.json'), PKG);
    fs.writeFileSync(path.join(repo2, 'extension', 'manifest.json'), MANIFEST);
    fs.writeFileSync(path.join(repo2, 'CHANGELOG.md'), CHANGELOG);
    git(repo2, ['init', '-q', '-b', 'main']);
    git(repo2, ['config', 'user.email', 'test@narukami.local']);
    git(repo2, ['config', 'user.name', 'NARUKAMI Test']);
    git(repo2, ['add', '-A']);
    git(repo2, ['commit', '-q', '-m', 'chore(release): bump to 0.0.1']);
    execFileSync('git', ['init', '-q', '--bare', '-b', 'main', bare], {
      encoding: 'utf8',
      windowsHide: true,
    });
    git(repo2, ['remote', 'add', 'origin', bare]);
  }, 30_000);

  afterAll(() => {
    fs.rmSync(repo2, { recursive: true, force: true });
    fs.rmSync(bare, { recursive: true, force: true });
    fs.rmSync(out2, { recursive: true, force: true });
  });

  it('preflight reports the current branch', async () => {
    const pre = await releasePreflight(repo2);
    expect(pre.branch).toBe('main');
  }, 30_000);

  it('refuses to commit when the version files match HEAD', async () => {
    await expect(commitVersionBump(repo2)).rejects.toThrow(/Nothing to commit/);
  }, 30_000);

  it('commits ONLY the three version files with the automatic message', async () => {
    await buildReleaseZip(repo2, '0.0.2', out2); // leaves the bump uncommitted
    fs.writeFileSync(path.join(repo2, 'unrelated.txt'), 'work in progress\n');

    const res = await commitVersionBump(repo2);
    expect(res.message).toBe('chore(release): bump to v0.0.2');
    expect(res.files.sort()).toEqual(['VERSION.md', 'bridge/package.json', 'extension/manifest.json']);

    // The commit is HEAD, carries the auto message, and contains exactly the 3 files.
    expect(res.commit).toBe(git(repo2, ['rev-parse', 'HEAD']).trim());
    expect(git(repo2, ['log', '-1', '--format=%s'])).toContain('chore(release): bump to v0.0.2');
    const committed = git(repo2, ['show', '--name-only', '--format=', 'HEAD'])
      .trim()
      .split('\n')
      .sort();
    expect(committed).toEqual(['VERSION.md', 'bridge/package.json', 'extension/manifest.json']);

    // Unrelated work is untouched: still present, still uncommitted.
    const status = git(repo2, ['status', '--porcelain']);
    expect(status).toContain('unrelated.txt');
    expect(status).not.toContain('VERSION.md');
  }, 30_000);

  it('pushes the branch, creating the upstream on first push', async () => {
    const res = await pushCurrentBranch(repo2);
    expect(res.branch).toBe('main');
    expect(res.upstreamCreated).toBe(true);
    // The bare origin now has exactly our HEAD.
    const localHead = git(repo2, ['rev-parse', 'HEAD']).trim();
    const remoteHead = execFileSync('git', ['-C', bare, 'rev-parse', 'main'], {
      encoding: 'utf8',
      windowsHide: true,
    }).trim();
    expect(remoteHead).toBe(localHead);
  }, 30_000);

  it('second push reuses the upstream', async () => {
    fs.writeFileSync(path.join(repo2, 'more.txt'), 'more\n');
    git(repo2, ['add', 'more.txt']);
    git(repo2, ['commit', '-q', '-m', 'feat: more']);
    const res = await pushCurrentBranch(repo2);
    expect(res.upstreamCreated).toBe(false);
    const remoteHead = execFileSync('git', ['-C', bare, 'rev-parse', 'main'], {
      encoding: 'utf8',
      windowsHide: true,
    }).trim();
    expect(remoteHead).toBe(git(repo2, ['rev-parse', 'HEAD']).trim());
  }, 30_000);
});

describe('collectNotesMaterial (real git)', () => {
  it('extracts the [Unreleased] section and the commits since the last version bump', async () => {
    // A post-bump feature commit — the material must contain it.
    fs.writeFileSync(path.join(repo, 'feature.txt'), 'new feature\n');
    git(repo, ['add', 'feature.txt']);
    git(repo, ['commit', '-q', '-m', 'feat(core): add the fixture feature']);

    const material = await collectNotesMaterial(repo, null);
    expect(material.changelog).toContain('Added the fixture feature');
    expect(material.changelog).not.toContain('[0.0.1]');
    expect(material.commits).toContain('feat(core): add the fixture feature');
    expect(material.rangeLabel).toContain('last version bump');
  }, 30_000);

  it('uses the recorded previous release HEAD when it exists', async () => {
    const prevHead = git(repo, ['rev-parse', 'HEAD^']).trim();
    const material = await collectNotesMaterial(repo, prevHead);
    expect(material.rangeLabel).toContain('previous release');
    expect(material.commits).toContain('feat(core): add the fixture feature');
  }, 30_000);

  it('falls back cleanly when the recorded HEAD is garbage', async () => {
    const material = await collectNotesMaterial(repo, 'deadbeefdeadbeefdeadbeefdeadbeefdeadbeef');
    expect(material.rangeLabel).not.toContain('previous release');
    expect(material.commits.length).toBeGreaterThan(0);
  }, 30_000);
});
