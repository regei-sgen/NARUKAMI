import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { currentBranch, fileAtHead } from './gitEditor';

function git(cwd: string, ...args: string[]): void {
  execFileSync('git', ['-C', cwd, ...args], { stdio: 'pipe' });
}

describe('gitEditor against a real temp repo', () => {
  let repo: string;
  let plain: string;

  beforeEach(() => {
    repo = fs.mkdtempSync(path.join(os.tmpdir(), 'git-ed-'));
    execFileSync('git', ['init', repo], { stdio: 'pipe' });
    git(repo, 'symbolic-ref', 'HEAD', 'refs/heads/work'); // deterministic branch name, pre-commit
    git(repo, 'config', 'user.email', 't@t.t');
    git(repo, 'config', 'user.name', 'T');
    git(repo, 'config', 'commit.gpgsign', 'false');
    fs.writeFileSync(path.join(repo, 'a.txt'), 'committed line\n');
    fs.mkdirSync(path.join(repo, 'sub'));
    fs.writeFileSync(path.join(repo, 'sub', 'b.txt'), 'sub committed\n');
    git(repo, 'add', '-A');
    git(repo, 'commit', '-m', 'init');
    plain = fs.mkdtempSync(path.join(os.tmpdir(), 'plain-'));
  });
  afterEach(() => {
    fs.rmSync(repo, { recursive: true, force: true });
    fs.rmSync(plain, { recursive: true, force: true });
  });

  it('reports the current branch', async () => {
    expect(await currentBranch(repo)).toEqual({ branch: 'work', detached: false });
  });

  it('returns committed HEAD content for root AND subdir files', async () => {
    expect(await fileAtHead(repo, 'a.txt')).toBe('committed line\n');
    expect(await fileAtHead(repo, 'sub/b.txt')).toBe('sub committed\n');
  });

  it('returns null for a new/untracked file (caller diffs against empty)', async () => {
    fs.writeFileSync(path.join(repo, 'new.txt'), 'not committed\n');
    expect(await fileAtHead(repo, 'new.txt')).toBeNull();
  });

  it('is fail-soft on a non-git directory', async () => {
    expect(await currentBranch(plain)).toEqual({ branch: null, detached: false });
    expect(await fileAtHead(plain, 'x.txt')).toBeNull();
  });
});
