import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import Fastify, { type FastifyInstance } from 'fastify';

const h = vi.hoisted(() => ({ projectFindUnique: vi.fn() }));
vi.mock('../db', () => ({ prisma: { project: { findUnique: h.projectFindUnique } } }));

import { gitRoutes } from './git';

function git(repo: string, args: string[]): string {
  return execFileSync('git', ['-C', repo, ...args], { encoding: 'utf8', windowsHide: true });
}

let repo: string;
let base: string; // the initial branch name (master or main, machine-dependent)
let app: FastifyInstance;

beforeEach(async () => {
  repo = fs.mkdtempSync(path.join(os.tmpdir(), 'narukami-git-'));
  git(repo, ['init', '-q']);
  git(repo, ['config', 'user.email', 'test@narukami.local']);
  git(repo, ['config', 'user.name', 'NARUKAMI Test']);
  // Keep line endings byte-exact so the discard assertion isn't perturbed by
  // Windows autocrlf rewriting \n → \r\n on restore.
  git(repo, ['config', 'core.autocrlf', 'false']);
  fs.writeFileSync(path.join(repo, 'keep.ts'), 'const a = 1;\n');
  git(repo, ['add', '-A']);
  git(repo, ['commit', '-q', '-m', 'init']);
  base = git(repo, ['branch', '--show-current']).trim();
  h.projectFindUnique.mockResolvedValue({ id: 'p1', path: repo });
  app = Fastify();
  await app.register(gitRoutes);
  await app.ready();
});

afterEach(async () => {
  await app.close();
  fs.rmSync(repo, { recursive: true, force: true });
});

async function changes() {
  const res = await app.inject({ method: 'GET', url: '/api/projects/p1/git/changes' });
  return res.json();
}

describe('git source-control routes (real repo)', () => {
  it('buckets staged, unstaged, and untracked files', async () => {
    fs.writeFileSync(path.join(repo, 'keep.ts'), 'const a = 2;\n'); // modify tracked
    git(repo, ['add', 'keep.ts']); // stage it
    fs.writeFileSync(path.join(repo, 'keep.ts'), 'const a = 3;\n'); // further worktree edit
    fs.writeFileSync(path.join(repo, 'fresh.ts'), 'x\n'); // untracked
    const c = await changes();
    expect(c.isRepo).toBe(true);
    expect(c.staged.map((e: { path: string }) => e.path)).toContain('keep.ts');
    expect(c.unstaged.map((e: { path: string }) => e.path)).toEqual(
      expect.arrayContaining(['keep.ts', 'fresh.ts']),
    );
  });

  it('reports a real merge conflict in the conflicts bucket', async () => {
    git(repo, ['checkout', '-q', '-b', 'feature']);
    fs.writeFileSync(path.join(repo, 'keep.ts'), 'const a = 99;\n');
    git(repo, ['commit', '-q', '-am', 'feature edit']);
    git(repo, ['checkout', '-q', base]);
    fs.writeFileSync(path.join(repo, 'keep.ts'), 'const a = 77;\n');
    git(repo, ['commit', '-q', '-am', 'main edit']);
    try {
      git(repo, ['merge', '-q', 'feature']);
    } catch {
      /* merge conflict — expected, git exits non-zero */
    }
    const c = await changes();
    expect(c.conflicts.map((e: { path: string }) => e.path)).toContain('keep.ts');
  });

  it('stage then unstage moves a file between buckets', async () => {
    fs.writeFileSync(path.join(repo, 'keep.ts'), 'const a = 2;\n');
    await app.inject({ method: 'POST', url: '/api/projects/p1/git/stage', payload: { path: 'keep.ts' } });
    expect((await changes()).staged.map((e: { path: string }) => e.path)).toContain('keep.ts');
    await app.inject({ method: 'POST', url: '/api/projects/p1/git/unstage', payload: { path: 'keep.ts' } });
    expect((await changes()).staged.map((e: { path: string }) => e.path)).not.toContain('keep.ts');
  });

  it('discards a modified tracked file back to HEAD', async () => {
    fs.writeFileSync(path.join(repo, 'keep.ts'), 'const a = 2;\n');
    await app.inject({ method: 'POST', url: '/api/projects/p1/git/discard', payload: { path: 'keep.ts' } });
    expect(fs.readFileSync(path.join(repo, 'keep.ts'), 'utf8')).toBe('const a = 1;\n');
  });

  it('commits the staged set and advances HEAD', async () => {
    const before = git(repo, ['rev-parse', 'HEAD']).trim();
    fs.writeFileSync(path.join(repo, 'keep.ts'), 'const a = 2;\n');
    await app.inject({ method: 'POST', url: '/api/projects/p1/git/stage', payload: { path: 'keep.ts' } });
    const res = await app.inject({
      method: 'POST',
      url: '/api/projects/p1/git/commit',
      payload: { message: 'test commit' },
    });
    expect(res.json().ok).toBe(true);
    expect(git(repo, ['rev-parse', 'HEAD']).trim()).not.toBe(before);
    expect((await changes()).staged).toEqual([]);
  });

  it('rejects an empty commit message with 400', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/api/projects/p1/git/commit',
      payload: { message: '   ' },
    });
    expect(res.statusCode).toBe(400);
  });
});
