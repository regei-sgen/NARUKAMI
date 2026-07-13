# Editor "Changes" Tab Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add an interactive git source-control panel ("Changes" tab) to the NARUKAMI Editor's left sidebar — staged/unstaged/conflict buckets + branch, with stage/unstage/discard/commit, reusing the existing Monaco diff to view a file's changes.

**Architecture:** A new pure parser + I/O service (`gitChanges.ts`) preserves git's index/worktree porcelain columns and buckets files; a new route file (`git.ts`) exposes read + mutation endpoints; a new `ChangesPanel.tsx` renders the panel inside `CodeEditor`, which gains an Explorer↔Changes sidebar toggle and an `onOpenDiff` callback that drives the already-built `DiffEditor`.

**Tech Stack:** TypeScript, Fastify (backend), React + @monaco-editor/react (frontend), Vitest (+ React Testing Library), git CLI via `node:child_process` `execFile`.

## Global Constraints

- **No push.** No push route, no push button, no `git push` anywhere. (GODCLAUDE goddev boundary.)
- **Never commit unless the user asks.** Every task's `git commit` step is written out, but only run it when the user has said to commit; otherwise stage and continue.
- All git calls: `execFile` with an **args array** (never a shell string), `-C <projectPath>`, `timeout: GIT_TIMEOUT_MS` (10_000), `windowsHide: true`, and `env: { ...process.env, GIT_LITERAL_PATHSPECS: '1' }`.
- All mutation routes validate the body `path` via `resolveInProject(project.path, rel)` (exported from `routes/files.ts`) before touching git.
- Backend tests run **serially** to dodge the known tinypool flake: `npx vitest run --no-file-parallelism`.
- Two pre-existing backend failures (`services/godclaude.test.ts`, `routes/godclaude.integration.test.ts`) are environmental and unrelated — they may remain red; nothing in this plan touches them.
- Project-relative paths are **POSIX** (forward slashes) everywhere they cross the wire.
- Reference spec: `docs/superpowers/specs/2026-07-13-editor-changes-tab-design.md`.

---

### Task 1: `gitChanges.ts` — pure parser + bucketing

**Files:**
- Create: `packages/backend/src/services/gitChanges.ts`
- Test: `packages/backend/src/services/gitChanges.test.ts`

**Interfaces:**
- Consumes: nothing (pure).
- Produces:
  - `type GitChangeType = 'added' | 'modified' | 'deleted' | 'renamed' | 'untracked'`
  - `interface GitChangeEntry { path: string; type: GitChangeType; staged: boolean }`
  - `interface GitChangesResult { isRepo: boolean; branch: string | null; detached: boolean; staged: GitChangeEntry[]; unstaged: GitChangeEntry[]; conflicts: GitChangeEntry[] }`
  - `parseStatusFull(raw: string): Array<{ x: string; y: string; path: string }>`
  - `bucketChanges(entries: Array<{ x: string; y: string; path: string }>, prefix: string): Pick<GitChangesResult, 'staged' | 'unstaged' | 'conflicts'>`

- [ ] **Step 1: Write the failing test**

Create `packages/backend/src/services/gitChanges.test.ts`:

```ts
import { describe, it, expect } from 'vitest';
import { parseStatusFull, bucketChanges } from './gitChanges';

// Build a NUL-terminated porcelain -z stream from raw records.
function z(...records: string[]): string {
  return records.map((r) => `${r}\0`).join('');
}

describe('parseStatusFull', () => {
  it('preserves both porcelain columns and the path', () => {
    const raw = z('MM src/a.ts', '?? new.ts', 'A  src/b.ts', ' D src/c.ts');
    expect(parseStatusFull(raw)).toEqual([
      { x: 'M', y: 'M', path: 'src/a.ts' },
      { x: '?', y: '?', path: 'new.ts' },
      { x: 'A', y: ' ', path: 'src/b.ts' },
      { x: ' ', y: 'D', path: 'src/c.ts' },
    ]);
  });

  it('reads a rename new-path and skips the original NUL field', () => {
    const raw = z('R  src/new.ts', 'src/old.ts', ' M src/keep.ts');
    expect(parseStatusFull(raw)).toEqual([
      { x: 'R', y: ' ', path: 'src/new.ts' },
      { x: ' ', y: 'M', path: 'src/keep.ts' },
    ]);
  });

  it('returns [] for empty input', () => {
    expect(parseStatusFull('')).toEqual([]);
  });
});

describe('bucketChanges', () => {
  it('splits staged, unstaged, and both (MM appears twice)', () => {
    const entries = parseStatusFull(z('M  s.ts', ' M w.ts', 'MM b.ts', '?? n.ts'));
    const r = bucketChanges(entries, '');
    expect(r.staged).toEqual([
      { path: 's.ts', type: 'modified', staged: true },
      { path: 'b.ts', type: 'modified', staged: true },
    ]);
    expect(r.unstaged).toEqual([
      { path: 'w.ts', type: 'modified', staged: false },
      { path: 'b.ts', type: 'modified', staged: false },
      { path: 'n.ts', type: 'untracked', staged: false },
    ]);
    expect(r.conflicts).toEqual([]);
  });

  it('derives type from the correct column (staged add, worktree delete)', () => {
    const r = bucketChanges(parseStatusFull(z('A  add.ts', ' D del.ts', 'D  stagedel.ts')), '');
    expect(r.staged).toEqual([
      { path: 'add.ts', type: 'added', staged: true },
      { path: 'stagedel.ts', type: 'deleted', staged: true },
    ]);
    expect(r.unstaged).toEqual([{ path: 'del.ts', type: 'deleted', staged: false }]);
  });

  it('routes every unmerged code to conflicts only', () => {
    for (const code of ['DD', 'AU', 'UD', 'UA', 'DU', 'AA', 'UU']) {
      const r = bucketChanges(parseStatusFull(z(`${code} f.ts`)), '');
      expect(r.conflicts).toEqual([{ path: 'f.ts', type: 'modified', staged: false }]);
      expect(r.staged).toEqual([]);
      expect(r.unstaged).toEqual([]);
    }
  });

  it('strips a monorepo prefix and drops out-of-subtree paths', () => {
    const r = bucketChanges(parseStatusFull(z(' M app/src/a.ts', ' M other/b.ts')), 'app/');
    expect(r.unstaged).toEqual([{ path: 'src/a.ts', type: 'modified', staged: false }]);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd packages/backend && npx vitest run src/services/gitChanges.test.ts`
Expected: FAIL — `parseStatusFull`/`bucketChanges` not exported (module not found).

- [ ] **Step 3: Write minimal implementation**

Create `packages/backend/src/services/gitChanges.ts`:

```ts
export type GitChangeType = 'added' | 'modified' | 'deleted' | 'renamed' | 'untracked';

export interface GitChangeEntry {
  path: string; // project-relative, POSIX separators
  type: GitChangeType;
  staged: boolean;
}

export interface GitChangesResult {
  isRepo: boolean;
  branch: string | null;
  detached: boolean;
  staged: GitChangeEntry[];
  unstaged: GitChangeEntry[];
  conflicts: GitChangeEntry[];
}

/**
 * Parse `git status --porcelain=v1 -z --untracked-files=all`, preserving BOTH
 * status columns (X = index, Y = worktree). Pure (no I/O). Each `-z` record is
 * `XY<space>PATH`; a rename/copy (X is R/C) carries the original path as the
 * next NUL field, which is skipped (only the new path is reported).
 */
export function parseStatusFull(raw: string): Array<{ x: string; y: string; path: string }> {
  const tokens = raw.split('\0');
  const out: Array<{ x: string; y: string; path: string }> = [];
  for (let i = 0; i < tokens.length; i += 1) {
    const rec = tokens[i];
    if (!rec || rec.length < 4) continue;
    const x = rec[0];
    const y = rec[1];
    const filePath = rec.slice(3);
    if (x === 'R' || x === 'C') i += 1; // skip the original-path NUL field
    if (!filePath) continue;
    out.push({ x, y, path: filePath });
  }
  return out;
}

function isConflict(x: string, y: string): boolean {
  return x === 'U' || y === 'U' || (x === 'D' && y === 'D') || (x === 'A' && y === 'A');
}

function typeFor(col: string): GitChangeType {
  if (col === '?') return 'untracked';
  if (col === 'A') return 'added';
  if (col === 'D') return 'deleted';
  if (col === 'R' || col === 'C') return 'renamed';
  return 'modified'; // M, T, and anything else that moved
}

/**
 * Bucket parsed status rows into staged / unstaged / conflicts. `prefix` (from
 * `git rev-parse --show-prefix`) is stripped so paths line up with the project
 * subtree; rows outside the subtree are dropped. A file can appear in BOTH
 * staged and unstaged (e.g. `MM`) — matching VS Code.
 */
export function bucketChanges(
  entries: Array<{ x: string; y: string; path: string }>,
  prefix: string,
): Pick<GitChangesResult, 'staged' | 'unstaged' | 'conflicts'> {
  const staged: GitChangeEntry[] = [];
  const unstaged: GitChangeEntry[] = [];
  const conflicts: GitChangeEntry[] = [];

  for (const { x, y, path: p } of entries) {
    if (prefix && !p.startsWith(prefix)) continue;
    const rel = prefix ? p.slice(prefix.length) : p;
    if (!rel) continue;

    if (isConflict(x, y)) {
      conflicts.push({ path: rel, type: 'modified', staged: false });
      continue;
    }
    if (x !== ' ' && x !== '?') {
      staged.push({ path: rel, type: typeFor(x), staged: true });
    }
    if (x === '?') {
      unstaged.push({ path: rel, type: 'untracked', staged: false });
    } else if (y !== ' ') {
      unstaged.push({ path: rel, type: typeFor(y), staged: false });
    }
  }

  return { staged, unstaged, conflicts };
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd packages/backend && npx vitest run src/services/gitChanges.test.ts`
Expected: PASS (4 + 4 tests green).

- [ ] **Step 5: Commit**

```bash
git add packages/backend/src/services/gitChanges.ts packages/backend/src/services/gitChanges.test.ts
git commit -m "feat(git): pure status parser + staged/unstaged/conflict bucketing"
```

---

### Task 2: `gitChanges.ts` — I/O entrypoint + mutations

**Files:**
- Modify: `packages/backend/src/services/gitChanges.ts`
- Test: covered end-to-end by Task 4's integration test (these functions are thin `git` wrappers; the route test exercises them against a real repo).

**Interfaces:**
- Consumes: `parseStatusFull`, `bucketChanges` (Task 1); `currentBranch` from `./gitEditor`.
- Produces:
  - `gitSourceControl(projectPath: string): Promise<GitChangesResult>`
  - `stagePath(projectPath: string, relPath: string): Promise<void>`
  - `unstagePath(projectPath: string, relPath: string): Promise<void>`
  - `discardPath(projectPath: string, relPath: string, untracked: boolean): Promise<void>`
  - `commitStaged(projectPath: string, message: string): Promise<string>` (returns short HEAD)
  - `stageAll(projectPath: string): Promise<void>`
  - `unstageAll(projectPath: string): Promise<void>`

- [ ] **Step 1: Append the implementation** (no separate unit test — proven by Task 4)

Append to `packages/backend/src/services/gitChanges.ts`:

```ts
import { execFile } from 'node:child_process';
import fs from 'node:fs/promises';
import path from 'node:path';
import { promisify } from 'node:util';
import { currentBranch } from './gitEditor';

const execFileAsync = promisify(execFile);
const GIT_TIMEOUT_MS = 10_000;
const GIT_MAX_BUFFER = 64 * 1024 * 1024;
const MAX_STATUS_FILES = 5000;

async function git(projectPath: string, args: string[]): Promise<string> {
  const { stdout } = await execFileAsync('git', ['-C', projectPath, ...args], {
    timeout: GIT_TIMEOUT_MS,
    windowsHide: true,
    maxBuffer: GIT_MAX_BUFFER,
    env: { ...process.env, GIT_LITERAL_PATHSPECS: '1' },
  });
  return stdout;
}

/** True when a git failure is "HEAD doesn't resolve" (unborn branch / no commits). */
function isUnborn(err: unknown): boolean {
  const msg = String((err as { stderr?: string })?.stderr ?? (err as Error)?.message ?? '');
  return /unknown revision|bad revision|ambiguous argument '?HEAD'?|does not have any commits/i.test(msg);
}

/** Full source-control snapshot: branch + staged/unstaged/conflict buckets. Fail-soft. */
export async function gitSourceControl(projectPath: string): Promise<GitChangesResult> {
  let prefix: string;
  try {
    prefix = (await git(projectPath, ['rev-parse', '--show-prefix'])).trim();
  } catch {
    return { isRepo: false, branch: null, detached: false, staged: [], unstaged: [], conflicts: [] };
  }

  const { branch, detached } = await currentBranch(projectPath);

  let raw = '';
  try {
    raw = await git(projectPath, ['status', '--porcelain=v1', '-z', '--untracked-files=all']);
  } catch {
    return { isRepo: true, branch, detached, staged: [], unstaged: [], conflicts: [] };
  }

  const { staged, unstaged, conflicts } = bucketChanges(parseStatusFull(raw), prefix);
  return {
    isRepo: true,
    branch,
    detached,
    staged: staged.slice(0, MAX_STATUS_FILES),
    unstaged: unstaged.slice(0, MAX_STATUS_FILES),
    conflicts: conflicts.slice(0, MAX_STATUS_FILES),
  };
}

export async function stagePath(projectPath: string, relPath: string): Promise<void> {
  await git(projectPath, ['add', '--', relPath]);
}

export async function unstagePath(projectPath: string, relPath: string): Promise<void> {
  try {
    await git(projectPath, ['restore', '--staged', '--', relPath]);
  } catch (err) {
    if (isUnborn(err)) {
      await git(projectPath, ['rm', '--cached', '--quiet', '--', relPath]);
    } else {
      throw err;
    }
  }
}

export async function discardPath(projectPath: string, relPath: string, untracked: boolean): Promise<void> {
  if (untracked) {
    // Delete the untracked file from disk (path already validated by the route).
    await fs.rm(path.join(projectPath, relPath), { force: true });
    return;
  }
  await git(projectPath, ['restore', '--', relPath]);
}

export async function commitStaged(projectPath: string, message: string): Promise<string> {
  await git(projectPath, ['commit', '-m', message]);
  return (await git(projectPath, ['rev-parse', '--short', 'HEAD'])).trim();
}

export async function stageAll(projectPath: string): Promise<void> {
  await git(projectPath, ['add', '-A', '--', '.']);
}

export async function unstageAll(projectPath: string): Promise<void> {
  try {
    await git(projectPath, ['reset', '-q', '--', '.']);
  } catch (err) {
    if (isUnborn(err)) {
      await git(projectPath, ['rm', '-r', '--cached', '--quiet', '--', '.']);
    } else {
      throw err;
    }
  }
}
```

- [ ] **Step 2: Typecheck compiles**

Run: `cd packages/backend && npx tsc -p tsconfig.typecheck.json`
Expected: exit 0, no errors.

- [ ] **Step 3: Re-run the Task 1 unit tests (nothing regressed)**

Run: `cd packages/backend && npx vitest run src/services/gitChanges.test.ts`
Expected: PASS.

- [ ] **Step 4: Commit**

```bash
git add packages/backend/src/services/gitChanges.ts
git commit -m "feat(git): source-control snapshot + stage/unstage/discard/commit helpers"
```

---

### Task 3: `routes/git.ts` — endpoints, registered in `index.ts`

**Files:**
- Create: `packages/backend/src/routes/git.ts`
- Modify: `packages/backend/src/index.ts` (import + register `gitRoutes`)
- Test: `packages/backend/src/routes/git.integration.test.ts` (Task 4)

**Interfaces:**
- Consumes: `gitSourceControl`, `stagePath`, `unstagePath`, `discardPath`, `commitStaged`, `stageAll`, `unstageAll` (Task 2); `resolveInProject` from `./files`; `prisma` from `../db`.
- Produces route surface:
  - `GET  /api/projects/:id/git/changes` → `GitChangesResult`
  - `POST /api/projects/:id/git/stage` `{path}` → `{ok:true}`
  - `POST /api/projects/:id/git/unstage` `{path}` → `{ok:true}`
  - `POST /api/projects/:id/git/discard` `{path, untracked?}` → `{ok:true}`
  - `POST /api/projects/:id/git/commit` `{message}` → `{ok:true, head}`
  - `POST /api/projects/:id/git/stage-all` → `{ok:true}`
  - `POST /api/projects/:id/git/unstage-all` → `{ok:true}`

- [ ] **Step 1: Create the route file**

Create `packages/backend/src/routes/git.ts`:

```ts
import type { FastifyInstance } from 'fastify';
import { prisma } from '../db';
import { resolveInProject } from './files';
import {
  commitStaged,
  discardPath,
  gitSourceControl,
  stageAll,
  stagePath,
  unstageAll,
  unstagePath,
} from '../services/gitChanges';

/** Validate a project-relative path stays inside the project root; throws → caller sends 400. */
function requireSafePath(root: string, rel: unknown): string {
  if (typeof rel !== 'string' || !rel.trim()) throw new Error('A file path is required.');
  resolveInProject(root, rel); // throws PathError on escape
  return rel;
}

export async function gitRoutes(app: FastifyInstance): Promise<void> {
  // Read: full source-control snapshot. Fail-soft (non-git project → isRepo:false).
  app.get<{ Params: { id: string } }>('/api/projects/:id/git/changes', async (req, reply) => {
    const project = await prisma.project.findUnique({ where: { id: req.params.id } });
    if (!project) return reply.code(404).send({ error: 'Project not found.' });
    return gitSourceControl(project.path);
  });

  app.post<{ Params: { id: string }; Body: { path?: string } }>(
    '/api/projects/:id/git/stage',
    async (req, reply) => {
      const project = await prisma.project.findUnique({ where: { id: req.params.id } });
      if (!project) return reply.code(404).send({ error: 'Project not found.' });
      let rel: string;
      try {
        rel = requireSafePath(project.path, req.body?.path);
      } catch (err) {
        return reply.code(400).send({ error: (err as Error).message });
      }
      try {
        await stagePath(project.path, rel);
        return { ok: true };
      } catch (err) {
        return reply.code(500).send({ error: (err as Error).message });
      }
    },
  );

  app.post<{ Params: { id: string }; Body: { path?: string } }>(
    '/api/projects/:id/git/unstage',
    async (req, reply) => {
      const project = await prisma.project.findUnique({ where: { id: req.params.id } });
      if (!project) return reply.code(404).send({ error: 'Project not found.' });
      let rel: string;
      try {
        rel = requireSafePath(project.path, req.body?.path);
      } catch (err) {
        return reply.code(400).send({ error: (err as Error).message });
      }
      try {
        await unstagePath(project.path, rel);
        return { ok: true };
      } catch (err) {
        return reply.code(500).send({ error: (err as Error).message });
      }
    },
  );

  app.post<{ Params: { id: string }; Body: { path?: string; untracked?: boolean } }>(
    '/api/projects/:id/git/discard',
    async (req, reply) => {
      const project = await prisma.project.findUnique({ where: { id: req.params.id } });
      if (!project) return reply.code(404).send({ error: 'Project not found.' });
      let rel: string;
      try {
        rel = requireSafePath(project.path, req.body?.path);
      } catch (err) {
        return reply.code(400).send({ error: (err as Error).message });
      }
      try {
        await discardPath(project.path, rel, req.body?.untracked === true);
        return { ok: true };
      } catch (err) {
        return reply.code(500).send({ error: (err as Error).message });
      }
    },
  );

  app.post<{ Params: { id: string }; Body: { message?: string } }>(
    '/api/projects/:id/git/commit',
    async (req, reply) => {
      const project = await prisma.project.findUnique({ where: { id: req.params.id } });
      if (!project) return reply.code(404).send({ error: 'Project not found.' });
      const message = req.body?.message;
      if (typeof message !== 'string' || !message.trim()) {
        return reply.code(400).send({ error: 'A commit message is required.' });
      }
      try {
        const head = await commitStaged(project.path, message);
        return { ok: true, head };
      } catch (err) {
        return reply.code(400).send({ error: (err as Error).message });
      }
    },
  );

  app.post<{ Params: { id: string } }>('/api/projects/:id/git/stage-all', async (req, reply) => {
    const project = await prisma.project.findUnique({ where: { id: req.params.id } });
    if (!project) return reply.code(404).send({ error: 'Project not found.' });
    try {
      await stageAll(project.path);
      return { ok: true };
    } catch (err) {
      return reply.code(500).send({ error: (err as Error).message });
    }
  });

  app.post<{ Params: { id: string } }>('/api/projects/:id/git/unstage-all', async (req, reply) => {
    const project = await prisma.project.findUnique({ where: { id: req.params.id } });
    if (!project) return reply.code(404).send({ error: 'Project not found.' });
    try {
      await unstageAll(project.path);
      return { ok: true };
    } catch (err) {
      return reply.code(500).send({ error: (err as Error).message });
    }
  });
}
```

- [ ] **Step 2: Register in `index.ts`**

In `packages/backend/src/index.ts`, add the import next to the other route imports:

```ts
import { gitRoutes } from './routes/git';
```

And register it right after `await app.register(fileRoutes);`:

```ts
  await app.register(fileRoutes);
  await app.register(gitRoutes);
```

- [ ] **Step 3: Typecheck compiles**

Run: `cd packages/backend && npx tsc -p tsconfig.typecheck.json`
Expected: exit 0, no errors.

- [ ] **Step 4: Commit**

```bash
git add packages/backend/src/routes/git.ts packages/backend/src/index.ts
git commit -m "feat(git): source-control routes (changes/stage/unstage/discard/commit)"
```

---

### Task 4: Real-git integration test for the routes

**Files:**
- Create: `packages/backend/src/routes/git.integration.test.ts`

**Interfaces:**
- Consumes: `gitRoutes` (Task 3), mocked `../db` (only `project.findUnique`).

- [ ] **Step 1: Write the failing integration test**

Create `packages/backend/src/routes/git.integration.test.ts`:

```ts
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
let app: FastifyInstance;

beforeEach(async () => {
  repo = fs.mkdtempSync(path.join(os.tmpdir(), 'narukami-git-'));
  git(repo, ['init', '-q']);
  git(repo, ['config', 'user.email', 'test@narukami.local']);
  git(repo, ['config', 'user.name', 'NARUKAMI Test']);
  fs.writeFileSync(path.join(repo, 'keep.ts'), 'const a = 1;\n');
  git(repo, ['add', '-A']);
  git(repo, ['commit', '-q', '-m', 'init']);
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
    git(repo, ['checkout', '-q', 'master']); // default init branch (or 'main' — see note)
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
```

> **Note on the default branch name:** `git init` may create `master` or `main`
> depending on the machine's git config. If the merge-conflict test fails at
> `checkout master`, capture the initial branch once in `beforeEach` with
> `const base = git(repo, ['branch', '--show-current']).trim();` and check that
> branch out instead of the literal `'master'`. Apply this fix if and only if
> the test reports `checkout` failing.

- [ ] **Step 2: Run it (red → green in one file)**

Run: `cd packages/backend && npx vitest run src/routes/git.integration.test.ts`
Expected: all 6 tests PASS. (If `checkout master` errors, apply the default-branch note above, then re-run.)

- [ ] **Step 3: Commit**

```bash
git add packages/backend/src/routes/git.integration.test.ts
git commit -m "test(git): real-repo integration for source-control routes incl. merge conflict"
```

---

### Task 5: Frontend types + api methods

**Files:**
- Modify: `packages/frontend/src/types.ts`
- Modify: `packages/frontend/src/api.ts`

**Interfaces:**
- Produces (types): `GitChangeType`, `GitChangeEntry`, `GitChanges`.
- Produces (api): `getGitChanges`, `stageFile`, `unstageFile`, `discardFile`, `commitChanges`, `stageAll`, `unstageAll`.

- [ ] **Step 1: Add types**

In `packages/frontend/src/types.ts`, after the `FileHead` interface (the git-integration block ~line 72), add:

```ts
export type GitChangeType = 'added' | 'modified' | 'deleted' | 'renamed' | 'untracked';
export interface GitChangeEntry {
  path: string;
  type: GitChangeType;
  staged: boolean;
}
export interface GitChanges {
  isRepo: boolean;
  branch: string | null;
  detached: boolean;
  staged: GitChangeEntry[];
  unstaged: GitChangeEntry[];
  conflicts: GitChangeEntry[];
}
```

- [ ] **Step 2: Import the type in `api.ts`**

In `packages/frontend/src/api.ts`, add `GitChanges` to the type import block (alphabetically, after `GitBranch`):

```ts
  GitBranch,
  GitChanges,
```

- [ ] **Step 3: Add api methods**

In `packages/frontend/src/api.ts`, directly after the `getFileHead` method (the `--- editor git integration (read-only) ---` block), add:

```ts
  // --- editor git source control (Changes tab) ---
  getGitChanges: (projectId: string) =>
    request<GitChanges>(`/api/projects/${projectId}/git/changes`),

  stageFile: (projectId: string, filePath: string) =>
    request<{ ok: boolean }>(`/api/projects/${projectId}/git/stage`, {
      method: 'POST',
      body: JSON.stringify({ path: filePath }),
    }),

  unstageFile: (projectId: string, filePath: string) =>
    request<{ ok: boolean }>(`/api/projects/${projectId}/git/unstage`, {
      method: 'POST',
      body: JSON.stringify({ path: filePath }),
    }),

  discardFile: (projectId: string, filePath: string, untracked: boolean) =>
    request<{ ok: boolean }>(`/api/projects/${projectId}/git/discard`, {
      method: 'POST',
      body: JSON.stringify({ path: filePath, untracked }),
    }),

  commitChanges: (projectId: string, message: string) =>
    request<{ ok: boolean; head: string }>(`/api/projects/${projectId}/git/commit`, {
      method: 'POST',
      body: JSON.stringify({ message }),
    }),

  stageAll: (projectId: string) =>
    request<{ ok: boolean }>(`/api/projects/${projectId}/git/stage-all`, { method: 'POST' }),

  unstageAll: (projectId: string) =>
    request<{ ok: boolean }>(`/api/projects/${projectId}/git/unstage-all`, { method: 'POST' }),
```

- [ ] **Step 4: Typecheck compiles**

Run: `cd packages/frontend && npx tsc --noEmit -p tsconfig.typecheck.json`
Expected: exit 0, no errors.

- [ ] **Step 5: Commit**

```bash
git add packages/frontend/src/types.ts packages/frontend/src/api.ts
git commit -m "feat(git): frontend types + api for source-control endpoints"
```

---

### Task 6: `ChangesPanel.tsx` component + tests

**Files:**
- Create: `packages/frontend/src/components/ChangesPanel.tsx`
- Test: `packages/frontend/src/components/ChangesPanel.test.tsx`

**Interfaces:**
- Consumes: `api` (Task 5), `GitChanges`/`GitChangeEntry` types, `Ic` from `./icons`.
- Produces: `export function ChangesPanel(props: { projectId: string; currentPath: string | null; onOpenDiff: (path: string, deleted: boolean) => void })`.

- [ ] **Step 1: Write the failing test**

Create `packages/frontend/src/components/ChangesPanel.test.tsx`:

```tsx
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { ChangesPanel } from './ChangesPanel';
import { api } from '../api';
import type { GitChanges } from '../types';

vi.mock('../api', () => ({
  api: {
    getGitChanges: vi.fn(),
    stageFile: vi.fn().mockResolvedValue({ ok: true }),
    unstageFile: vi.fn().mockResolvedValue({ ok: true }),
    discardFile: vi.fn().mockResolvedValue({ ok: true }),
    commitChanges: vi.fn().mockResolvedValue({ ok: true, head: 'abc123' }),
    stageAll: vi.fn().mockResolvedValue({ ok: true }),
    unstageAll: vi.fn().mockResolvedValue({ ok: true }),
  },
}));

const SAMPLE: GitChanges = {
  isRepo: true,
  branch: 'local-dev',
  detached: false,
  staged: [{ path: 'src/a.ts', type: 'modified', staged: true }],
  unstaged: [{ path: 'src/b.ts', type: 'modified', staged: false }],
  conflicts: [{ path: 'src/c.ts', type: 'modified', staged: false }],
};

beforeEach(() => {
  vi.clearAllMocks();
  (api.getGitChanges as ReturnType<typeof vi.fn>).mockResolvedValue(SAMPLE);
});

describe('ChangesPanel', () => {
  it('renders the branch name and all three buckets', async () => {
    render(<ChangesPanel projectId="p1" currentPath={null} onOpenDiff={vi.fn()} />);
    expect(await screen.findByText('local-dev')).toBeInTheDocument();
    expect(screen.getByText('a.ts')).toBeInTheDocument();
    expect(screen.getByText('b.ts')).toBeInTheDocument();
    expect(screen.getByText('c.ts')).toBeInTheDocument();
  });

  it('stages an unstaged file and refetches', async () => {
    render(<ChangesPanel projectId="p1" currentPath={null} onOpenDiff={vi.fn()} />);
    await screen.findByText('b.ts');
    fireEvent.click(screen.getByRole('button', { name: /^stage src\/b\.ts$/i }));
    await waitFor(() => expect(api.stageFile).toHaveBeenCalledWith('p1', 'src/b.ts'));
    expect(api.getGitChanges).toHaveBeenCalledTimes(2); // mount + after stage
  });

  it('confirms before discarding, then calls discardFile', async () => {
    const confirmSpy = vi.spyOn(window, 'confirm').mockReturnValue(true);
    render(<ChangesPanel projectId="p1" currentPath={null} onOpenDiff={vi.fn()} />);
    await screen.findByText('b.ts');
    fireEvent.click(screen.getByRole('button', { name: /^discard src\/b\.ts$/i }));
    expect(confirmSpy).toHaveBeenCalled();
    await waitFor(() => expect(api.discardFile).toHaveBeenCalledWith('p1', 'src/b.ts', false));
    confirmSpy.mockRestore();
  });

  it('opens the diff when a file row is clicked', async () => {
    const onOpenDiff = vi.fn();
    render(<ChangesPanel projectId="p1" currentPath={null} onOpenDiff={onOpenDiff} />);
    fireEvent.click(await screen.findByText('a.ts'));
    expect(onOpenDiff).toHaveBeenCalledWith('src/a.ts', false);
  });

  it('disables Commit until a message is typed', async () => {
    render(<ChangesPanel projectId="p1" currentPath={null} onOpenDiff={vi.fn()} />);
    await screen.findByText('a.ts');
    const commit = screen.getByRole('button', { name: /^commit$/i });
    expect(commit).toBeDisabled();
    fireEvent.change(screen.getByPlaceholderText(/commit message/i), {
      target: { value: 'my message' },
    });
    expect(commit).toBeEnabled();
    fireEvent.click(commit);
    await waitFor(() => expect(api.commitChanges).toHaveBeenCalledWith('p1', 'my message'));
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd packages/frontend && npx vitest run src/components/ChangesPanel.test.tsx`
Expected: FAIL — cannot find module `./ChangesPanel`.

- [ ] **Step 3: Write the component**

Create `packages/frontend/src/components/ChangesPanel.tsx`:

```tsx
import { useCallback, useEffect, useRef, useState } from 'react';
import { api } from '../api';
import type { GitChangeEntry, GitChanges } from '../types';
import { Ic } from './icons';

interface Props {
  projectId: string;
  currentPath: string | null;
  onOpenDiff: (path: string, deleted: boolean) => void;
}

const LETTER: Record<GitChangeEntry['type'], string> = {
  added: 'A',
  modified: 'M',
  deleted: 'D',
  renamed: 'R',
  untracked: 'U',
};

function baseName(p: string): string {
  return p.split('/').pop() ?? p;
}
function dirName(p: string): string {
  const i = p.lastIndexOf('/');
  return i < 0 ? '' : p.slice(0, i);
}

function Row({
  entry,
  onOpen,
  actions,
}: {
  entry: GitChangeEntry;
  onOpen: () => void;
  actions: React.ReactNode;
}) {
  return (
    <div className="chg-row" title={entry.path}>
      <button className="chg-row-open" onClick={onOpen}>
        <span className={`chg-badge chg-${entry.type}`}>{LETTER[entry.type]}</span>
        <span className="chg-name">{baseName(entry.path)}</span>
        <span className="chg-dir">{dirName(entry.path)}</span>
      </button>
      <div className="chg-actions">{actions}</div>
    </div>
  );
}

export function ChangesPanel({ projectId, currentPath, onOpenDiff }: Props) {
  const [data, setData] = useState<GitChanges | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [message, setMessage] = useState('');
  const [busy, setBusy] = useState(false);
  const aliveRef = useRef(true);

  const refetch = useCallback(async () => {
    try {
      const c = await api.getGitChanges(projectId);
      if (aliveRef.current) {
        setData(c);
        setErr(null);
      }
    } catch (e) {
      if (aliveRef.current) setErr((e as Error).message);
    }
  }, [projectId]);

  // Fetch on mount + poll every 3.5s (matches the branch-label cadence).
  useEffect(() => {
    aliveRef.current = true;
    void refetch();
    const id = setInterval(() => void refetch(), 3500);
    return () => {
      aliveRef.current = false;
      clearInterval(id);
    };
  }, [refetch]);

  // Run a mutation, then refetch. Serialized by `busy` so double-clicks don't race.
  const act = useCallback(
    async (fn: () => Promise<unknown>) => {
      if (busy) return;
      setBusy(true);
      try {
        await fn();
        await refetch();
      } catch (e) {
        setErr((e as Error).message);
      } finally {
        setBusy(false);
      }
    },
    [busy, refetch],
  );

  const discard = useCallback(
    (entry: GitChangeEntry) => {
      const kind = entry.type === 'untracked' ? 'delete the untracked file' : 'discard changes to';
      if (!window.confirm(`Really ${kind} ${entry.path}? This cannot be undone.`)) return;
      void act(() => api.discardFile(projectId, entry.path, entry.type === 'untracked'));
    },
    [act, projectId],
  );

  const commit = useCallback(() => {
    const msg = message.trim();
    if (!msg) return;
    void act(async () => {
      await api.commitChanges(projectId, msg);
      setMessage('');
    });
  }, [act, message, projectId]);

  if (data && !data.isRepo) {
    return <div className="chg-note">Not a git repository.</div>;
  }

  const staged = data?.staged ?? [];
  const unstaged = data?.unstaged ?? [];
  const conflicts = data?.conflicts ?? [];

  return (
    <div className="changes-panel">
      <div className="chg-branch">
        <Ic name="branch" />
        <span className="chg-branch-name">{data?.branch ?? '—'}</span>
        {data?.detached && <span className="chg-detached">detached</span>}
      </div>

      {err && <div className="chg-err" onClick={() => setErr(null)}>{err}</div>}

      {conflicts.length > 0 && (
        <section className="chg-section chg-section-conflict">
          <div className="chg-head">Merge Conflicts</div>
          {conflicts.map((e) => (
            <Row key={`c-${e.path}`} entry={e} onOpen={() => onOpenDiff(e.path, false)} actions={null} />
          ))}
        </section>
      )}

      <section className="chg-section">
        <div className="chg-head">
          Staged Changes
          {staged.length > 0 && (
            <button className="chg-head-btn" onClick={() => void act(() => api.unstageAll(projectId))}>
              Unstage all
            </button>
          )}
        </div>
        {staged.map((e) => (
          <Row
            key={`s-${e.path}`}
            entry={e}
            onOpen={() => onOpenDiff(e.path, e.type === 'deleted')}
            actions={
              <button
                className="chg-btn"
                aria-label={`Unstage ${e.path}`}
                onClick={() => void act(() => api.unstageFile(projectId, e.path))}
              >
                −
              </button>
            }
          />
        ))}
        <div className="chg-commit">
          <textarea
            className="chg-commit-msg"
            placeholder="Commit message (staged files)…"
            value={message}
            onChange={(ev) => setMessage(ev.target.value)}
            rows={2}
            spellCheck={false}
          />
          <button
            className="btn btn-primary chg-commit-btn"
            onClick={commit}
            disabled={!message.trim() || staged.length === 0 || busy}
          >
            Commit
          </button>
        </div>
      </section>

      <section className="chg-section">
        <div className="chg-head">
          Changes
          {unstaged.length > 0 && (
            <button className="chg-head-btn" onClick={() => void act(() => api.stageAll(projectId))}>
              Stage all
            </button>
          )}
        </div>
        {unstaged.map((e) => (
          <Row
            key={`u-${e.path}`}
            entry={e}
            onOpen={() => onOpenDiff(e.path, e.type === 'deleted')}
            actions={
              <>
                <button
                  className="chg-btn"
                  aria-label={`Discard ${e.path}`}
                  onClick={() => discard(e)}
                >
                  ↺
                </button>
                <button
                  className="chg-btn"
                  aria-label={`Stage ${e.path}`}
                  onClick={() => void act(() => api.stageFile(projectId, e.path))}
                >
                  +
                </button>
              </>
            }
          />
        ))}
      </section>

      {staged.length + unstaged.length + conflicts.length === 0 && data && (
        <div className="chg-note">No changes.</div>
      )}

      {/* currentPath is accepted for future active-row highlighting; unused today. */}
      <span hidden data-current={currentPath ?? ''} />
    </div>
  );
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd packages/frontend && npx vitest run src/components/ChangesPanel.test.tsx`
Expected: all 5 tests PASS.

- [ ] **Step 5: Commit**

```bash
git add packages/frontend/src/components/ChangesPanel.tsx packages/frontend/src/components/ChangesPanel.test.tsx
git commit -m "feat(git): ChangesPanel source-control component"
```

---

### Task 7: Wire the panel into `CodeEditor` (sidebar tabs + onOpenDiff)

**Files:**
- Modify: `packages/frontend/src/components/CodeEditor.tsx`
- Test: `packages/frontend/src/components/CodeEditor.test.tsx` (new)

**Interfaces:**
- Consumes: `ChangesPanel` (Task 6); existing `openPath`, `setShowDiff`, `getFileHead`.

- [ ] **Step 1: Write the failing test**

Create `packages/frontend/src/components/CodeEditor.test.tsx`:

```tsx
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import { CodeEditor } from './CodeEditor';
import { api } from '../api';
import type { Project } from '../types';

vi.mock('../lib/monaco-setup', () => ({}));
vi.mock('@monaco-editor/react', () => ({
  __esModule: true,
  default: () => <div data-testid="monaco" />,
  DiffEditor: () => <div data-testid="monaco-diff" />,
}));
vi.mock('../api', () => ({
  api: {
    getTree: vi.fn().mockResolvedValue({ tree: [], truncated: false }),
    getGitBranch: vi.fn().mockResolvedValue({ branch: 'local-dev', detached: false }),
    getGitChanges: vi.fn().mockResolvedValue({
      isRepo: true, branch: 'local-dev', detached: false, staged: [], unstaged: [], conflicts: [],
    }),
  },
}));

const PROJECT = { id: 'p1', name: 'demo', path: '/tmp/demo', status: 'idle', commands: [] } as unknown as Project;

beforeEach(() => vi.clearAllMocks());

describe('CodeEditor sidebar tabs', () => {
  it('defaults to Explorer and switches to the Changes panel', async () => {
    render(<CodeEditor project={PROJECT} />);
    // Explorer default: the Name/Code search modes are visible.
    expect(await screen.findByRole('button', { name: /^name$/i })).toBeInTheDocument();
    // Switch to Changes.
    fireEvent.click(screen.getByRole('button', { name: /^changes$/i }));
    expect(api.getGitChanges).toHaveBeenCalledWith('p1');
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd packages/frontend && npx vitest run src/components/CodeEditor.test.tsx`
Expected: FAIL — no "Changes" tab button exists yet.

- [ ] **Step 3: Add the import**

In `packages/frontend/src/components/CodeEditor.tsx`, add near the other component imports (after `import { Ic } from './icons';`):

```tsx
import { ChangesPanel } from './ChangesPanel';
```

- [ ] **Step 4: Add the sidebar-tab state**

In `CodeEditor`, add alongside the other `useState` calls (e.g. right after the `searchMode` state at ~line 206):

```tsx
  const [leftTab, setLeftTab] = useState<'explorer' | 'changes'>('explorer');
```

- [ ] **Step 5: Add the `onOpenDiff` callback**

In `CodeEditor`, add after the `openPath` callback (~line 352):

```tsx
  // Open a changed file from the Changes panel in the side-by-side diff. A
  // deleted file has no working copy: load HEAD and diff it against empty.
  const openDiff = useCallback(
    async (filePath: string, deleted: boolean) => {
      setShowDiff(true);
      if (deleted) {
        setCurrentPath(filePath);
        setContent('');
        setOriginal('');
        try {
          const r = await api.getFileHead(project.id, filePath);
          setHeadContent(r.content);
          setHeadCommitted(r.committed);
        } catch {
          setHeadContent('');
          setHeadCommitted(false);
        }
        return;
      }
      await openPath(filePath);
    },
    [openPath, project.id],
  );
```

- [ ] **Step 6: Render the sidebar tab switcher + panel**

In `CodeEditor.tsx`, replace the opening of the `<aside className="file-tree">` block. Find:

```tsx
      <aside className="file-tree">
        {loadingTree ? (
```

Replace with:

```tsx
      <aside className="file-tree">
        <div className="ft-tabs">
          <button
            className={`ft-tab ${leftTab === 'explorer' ? 'active' : ''}`}
            onClick={() => setLeftTab('explorer')}
          >
            Explorer
          </button>
          <button
            className={`ft-tab ${leftTab === 'changes' ? 'active' : ''}`}
            onClick={() => setLeftTab('changes')}
          >
            Changes
          </button>
        </div>
        {leftTab === 'changes' ? (
          <ChangesPanel projectId={project.id} currentPath={currentPath} onOpenDiff={openDiff} />
        ) : loadingTree ? (
```

> This inserts the tab strip and makes the existing `loadingTree ? … : treeErr ? … : ( … )`
> ternary the **Explorer** branch of `leftTab === 'changes' ? <ChangesPanel/> : <existing>`.
> The existing `</aside>` close tag and everything between stays as-is.

- [ ] **Step 7: Run the new test + the existing frontend suite**

Run: `cd packages/frontend && npx vitest run src/components/CodeEditor.test.tsx`
Expected: PASS.

Run: `cd packages/frontend && npx vitest run`
Expected: all files green (no regression in the existing 21 files / 161 tests).

- [ ] **Step 8: Commit**

```bash
git add packages/frontend/src/components/CodeEditor.tsx packages/frontend/src/components/CodeEditor.test.tsx
git commit -m "feat(git): Explorer/Changes sidebar tabs + open-diff wiring in CodeEditor"
```

---

### Task 8: Styles for the Changes panel

**Files:**
- Modify: `packages/frontend/src/styles.css`

**Interfaces:** none (CSS only). Classes used by Tasks 6–7: `ft-tabs`, `ft-tab`, `changes-panel`, `chg-branch`, `chg-branch-name`, `chg-detached`, `chg-err`, `chg-section`, `chg-section-conflict`, `chg-head`, `chg-head-btn`, `chg-row`, `chg-row-open`, `chg-badge`, `chg-added`, `chg-modified`, `chg-deleted`, `chg-renamed`, `chg-untracked`, `chg-name`, `chg-dir`, `chg-actions`, `chg-btn`, `chg-commit`, `chg-commit-msg`, `chg-commit-btn`, `chg-note`.

- [ ] **Step 1: Append the styles**

Append to `packages/frontend/src/styles.css`:

```css
/* --- Editor sidebar tabs (Explorer / Changes) --- */
.ft-tabs {
  display: flex;
  gap: 2px;
  padding: 6px 6px 0;
  border-bottom: 1px solid var(--border, #23232b);
}
.ft-tab {
  flex: 1;
  padding: 6px 8px;
  font-size: 0.78rem;
  background: transparent;
  border: none;
  color: var(--muted, #8a8a94);
  cursor: pointer;
  border-bottom: 2px solid transparent;
}
.ft-tab.active {
  color: var(--text, #e8e8ef);
  border-bottom-color: var(--accent, #ff2d3c);
}

/* --- Changes panel --- */
.changes-panel {
  display: flex;
  flex-direction: column;
  overflow-y: auto;
  height: 100%;
  padding-bottom: 12px;
}
.chg-branch {
  display: flex;
  align-items: center;
  gap: 6px;
  padding: 8px 10px;
  font-size: 0.82rem;
  color: var(--text, #e8e8ef);
}
.chg-branch-name { font-weight: 600; }
.chg-detached {
  font-size: 0.68rem;
  padding: 1px 5px;
  border-radius: 4px;
  background: color-mix(in srgb, var(--accent, #ff2d3c) 18%, transparent);
  color: var(--accent, #ff2d3c);
}
.chg-err {
  margin: 4px 8px;
  padding: 5px 8px;
  font-size: 0.75rem;
  border-radius: 4px;
  background: color-mix(in srgb, #ff2d3c 14%, transparent);
  color: #ff8a8a;
  cursor: pointer;
}
.chg-section { padding: 4px 0; }
.chg-head {
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 4px 10px;
  font-size: 0.72rem;
  text-transform: uppercase;
  letter-spacing: 0.04em;
  color: var(--muted, #8a8a94);
}
.chg-section-conflict .chg-head { color: #ffb454; }
.chg-head-btn {
  background: transparent;
  border: none;
  color: var(--accent, #ff2d3c);
  font-size: 0.72rem;
  cursor: pointer;
}
.chg-row {
  display: flex;
  align-items: center;
  gap: 4px;
  padding: 0 6px 0 10px;
}
.chg-row:hover { background: color-mix(in srgb, var(--text, #e8e8ef) 6%, transparent); }
.chg-row-open {
  flex: 1;
  display: flex;
  align-items: center;
  gap: 6px;
  min-width: 0;
  padding: 4px 0;
  background: transparent;
  border: none;
  color: var(--text, #e8e8ef);
  cursor: pointer;
  text-align: left;
}
.chg-badge {
  flex: none;
  width: 15px;
  text-align: center;
  font-size: 0.72rem;
  font-weight: 700;
}
.chg-added { color: #4ade80; }
.chg-modified { color: #fbbf24; }
.chg-deleted { color: #f87171; }
.chg-renamed { color: #60a5fa; }
.chg-untracked { color: #34d399; }
.chg-name {
  flex: none;
  font-size: 0.8rem;
  white-space: nowrap;
}
.chg-dir {
  flex: 1;
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  font-size: 0.7rem;
  color: var(--muted, #8a8a94);
}
.chg-actions { display: flex; gap: 2px; }
.chg-btn {
  width: 22px;
  height: 22px;
  display: grid;
  place-items: center;
  background: transparent;
  border: none;
  color: var(--muted, #8a8a94);
  cursor: pointer;
  border-radius: 4px;
  font-size: 0.95rem;
}
.chg-btn:hover { background: color-mix(in srgb, var(--text, #e8e8ef) 12%, transparent); color: var(--text, #e8e8ef); }
.chg-commit { padding: 6px 10px; display: flex; flex-direction: column; gap: 6px; }
.chg-commit-msg {
  width: 100%;
  resize: vertical;
  background: var(--input-bg, #14141a);
  border: 1px solid var(--border, #23232b);
  border-radius: 5px;
  color: var(--text, #e8e8ef);
  padding: 6px 8px;
  font-size: 0.78rem;
  font-family: inherit;
}
.chg-commit-btn { align-self: flex-end; }
.chg-note { padding: 12px 10px; font-size: 0.8rem; color: var(--muted, #8a8a94); }
```

- [ ] **Step 2: Build the frontend (styles compile, bundle succeeds)**

Run: `cd packages/frontend && npx vite build`
Expected: exit 0, `dist/` written.

- [ ] **Step 3: Commit**

```bash
git add packages/frontend/src/styles.css
git commit -m "style(git): Changes panel + Explorer/Changes tab styling"
```

---

### Task 9: Full-suite gate + packaged build

**Files:** none (verification only).

- [ ] **Step 1: Backend suite (serial)**

Run: `cd packages/backend && npx vitest run --no-file-parallelism`
Expected: all files green **except** the two known pre-existing environmental failures (`services/godclaude.test.ts`, `routes/godclaude.integration.test.ts`). The new `gitChanges.test.ts` and `git.integration.test.ts` are green.

- [ ] **Step 2: Frontend suite**

Run: `cd packages/frontend && npx vitest run`
Expected: all green, including `ChangesPanel.test.tsx` and `CodeEditor.test.tsx`.

- [ ] **Step 3: Full typecheck**

Run (repo root): `npm run typecheck`
Expected: exit 0 for both backend and frontend.

- [ ] **Step 4: Package the installer** (clear cache first — C: runs near-full)

Run (repo root):
```bash
npm cache clean --force
npm run desktop:dist
```
Expected: `BUILD_EXITCODE=0`; `packages/desktop/release/NARUKAMI-Setup-1.0.0.exe` refreshed. Verify the shipped bundle contains the panel: the win-unpacked frontend JS should contain `changes-panel` and the app.asar should contain `git/changes`.

- [ ] **Step 5: Commit any build metadata (only if the user asked to commit)**

No source changes here — nothing to commit unless prior tasks were left staged.

---

## Self-Review

**Spec coverage:**
- Layout / sidebar tabs → Task 7. ✓
- Branch header, three buckets, per-file + all actions, commit box → Tasks 6–7. ✓
- Reuse Monaco diff, deleted-file committed-vs-empty → Task 7 `openDiff`. ✓
- Backend `gitChanges.ts` pure parser + bucketing (staged/unstaged/both/conflicts, prefix strip) → Task 1. ✓
- I/O snapshot + mutations (stage/unstage/discard/commit/all, unborn fallbacks) → Task 2. ✓
- `routes/git.ts` with `resolveInProject` guard, fail-soft read, no push route → Task 3. ✓
- Pure parser tests + real-merge-conflict integration test → Tasks 1, 4. ✓
- Frontend types/api, ChangesPanel tests, CodeEditor tab test → Tasks 5–7. ✓
- Full-suite + packaged-build gate → Task 9. ✓
- Non-goals (no push/amend/hunk/ahead-behind) respected — no task adds them. ✓

**Placeholder scan:** No TBD/TODO; every code step shows complete code; the one conditional (default-branch name in Task 4) has an explicit, bounded fix. ✓

**Type consistency:** `GitChangeType`, `GitChangeEntry`, `GitChangesResult`/`GitChanges` identical across backend (Tasks 1–2) and frontend (Task 5). Api method names (`getGitChanges`, `stageFile`, `unstageFile`, `discardFile`, `commitChanges`, `stageAll`, `unstageAll`) match between Task 5 (definition), Task 6 (ChangesPanel usage), and Task 7 (mock). Route paths match between Task 3 (definition), Task 5 (api), and Task 4 (integration test). ✓
