import { describe, it, expect, vi, beforeAll, afterAll } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import Fastify, { type FastifyInstance } from 'fastify';

// The shape that broke the old tree builder: a directory large enough to eat the
// node budget, followed (alphabetically) by siblings that MUST still be listed.
// The old walk was depth-first behind a single shared counter, so it descended
// into `big/`, spent the budget there, and dropped every later sibling — a
// 44-entry project root rendered as 3 rows. The budget is injected below rather
// than filling a fixture past the real one, so the suite stays fast.
const BIG_FILES = 350;

// Hoisted holder: the vi.mock factory below is hoisted above beforeAll, so it
// has to read the fixture path lazily, at request time.
const fx = vi.hoisted(() => ({ root: '' }));

vi.mock('../db', () => ({
  prisma: {
    project: {
      findUnique: vi.fn(async () => ({ id: 'p1', name: 'fixture', path: fx.root })),
    },
  },
}));

import { fileRoutes, buildTree, walkAllFiles } from './files';

interface Node {
  name: string;
  path: string;
  type: 'dir' | 'file';
  children?: Node[];
  loaded?: boolean;
}

// Every top-level entry the OS reports for the fixture, minus the ignored dir.
const TOP_LEVEL = ['README.md', 'big', 'deep', 'zeta', 'zzz.txt'].sort();

/** Collect every directory node in a tree payload. */
function allDirs(nodes: Node[]): Node[] {
  const out: Node[] = [];
  const rec = (ns: Node[]) => {
    for (const n of ns) {
      if (n.type !== 'dir') continue;
      out.push(n);
      if (n.children) rec(n.children);
    }
  };
  rec(nodes);
  return out;
}

let app: FastifyInstance;

beforeAll(async () => {
  fx.root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'narukami-tree-')));
  fs.mkdirSync(path.join(fx.root, 'big'));
  for (let i = 0; i < BIG_FILES; i += 1) {
    fs.writeFileSync(path.join(fx.root, 'big', `f${String(i).padStart(5, '0')}.txt`), 'x');
  }
  fs.mkdirSync(path.join(fx.root, 'deep', 'a', 'b', 'c'), { recursive: true });
  fs.writeFileSync(path.join(fx.root, 'deep', 'a', 'b', 'c', 'leaf.txt'), 'needle-in-the-deep');
  fs.mkdirSync(path.join(fx.root, 'zeta'));
  fs.writeFileSync(path.join(fx.root, 'zeta', 'one.txt'), 'one');
  fs.writeFileSync(path.join(fx.root, 'zeta', 'two.txt'), 'two');
  // Ignored dir — must never surface in the tree or in either search.
  fs.mkdirSync(path.join(fx.root, 'node_modules', 'dep'), { recursive: true });
  fs.writeFileSync(path.join(fx.root, 'node_modules', 'dep', 'index.js'), 'needle-in-the-deep');
  fs.writeFileSync(path.join(fx.root, 'README.md'), '# hi');
  fs.writeFileSync(path.join(fx.root, 'zzz.txt'), 'last');

  app = Fastify();
  await app.register(fileRoutes);
  await app.ready();
}, 120_000);

afterAll(async () => {
  await app.close();
  fs.rmSync(fx.root, { recursive: true, force: true });
}, 120_000);

describe('GET /api/projects/:id/tree', () => {
  it('lists EVERY top-level entry even when one subtree dwarfs the rest', async () => {
    const r = await app.inject({ method: 'GET', url: '/api/projects/p1/tree' });
    expect(r.statusCode).toBe(200);
    const body = r.json() as { tree: Node[]; lazy: boolean };
    expect(body.tree.map((n) => n.name).sort()).toEqual(TOP_LEVEL);
  });

  it('lists the big directory completely, not partially', async () => {
    const r = await app.inject({ method: 'GET', url: '/api/projects/p1/tree' });
    const body = r.json() as { tree: Node[] };
    const big = body.tree.find((n) => n.name === 'big')!;
    expect(big.loaded).not.toBe(false);
    expect(big.children).toHaveLength(BIG_FILES);
  });

  it('omits ignored directories', async () => {
    const r = await app.inject({ method: 'GET', url: '/api/projects/p1/tree' });
    const body = r.json() as { tree: Node[] };
    expect(body.tree.some((n) => n.name === 'node_modules')).toBe(false);
  });

  it('reaches nested files', async () => {
    const r = await app.inject({ method: 'GET', url: '/api/projects/p1/tree' });
    const body = r.json() as { tree: Node[] };
    const leaf = allDirs(body.tree)
      .flatMap((d) => d.children ?? [])
      .find((n) => n.name === 'leaf.txt');
    expect(leaf?.path).toBe('deep/a/b/c/leaf.txt');
  });
});

describe('buildTree budget behaviour', () => {
  it('keeps the project root complete even with a budget smaller than the tree', () => {
    const { tree } = buildTree(fx.root, 3);
    expect(tree.map((n) => n.name).sort()).toEqual(TOP_LEVEL);
  });

  it('never returns a half-listed directory — deferred dirs are flagged instead', () => {
    const { tree, lazy } = buildTree(fx.root, 10);
    expect(lazy).toBe(true);
    const dirs = allDirs(tree as Node[]);
    expect(dirs.some((d) => d.loaded === false)).toBe(true);
    for (const dir of dirs) {
      if (dir.loaded === false) {
        expect(dir.children).toBeUndefined();
        continue;
      }
      // Loaded → the listing must match what the filesystem actually holds.
      const onDisk = fs
        .readdirSync(path.join(fx.root, dir.path), { withFileTypes: true })
        .filter((e) => e.isFile() || (e.isDirectory() && e.name !== 'node_modules')).length;
      expect(dir.children ?? []).toHaveLength(onDisk);
    }
  });

  it('loads the whole tree eagerly when it fits the budget', () => {
    const { lazy } = buildTree(fx.root);
    expect(lazy).toBe(false);
  });
});

describe('GET /api/projects/:id/dir', () => {
  it('returns every entry of a directory', async () => {
    const r = await app.inject({ method: 'GET', url: '/api/projects/p1/dir?path=big' });
    expect(r.statusCode).toBe(200);
    const body = r.json() as { path: string; children: Node[] };
    expect(body.path).toBe('big');
    expect(body.children).toHaveLength(BIG_FILES);
  });

  it('marks subdirectories unloaded so expansion stays one level at a time', async () => {
    const r = await app.inject({ method: 'GET', url: '/api/projects/p1/dir?path=deep' });
    const body = r.json() as { children: Node[] };
    expect(body.children).toEqual([{ name: 'a', path: 'deep/a', type: 'dir', loaded: false }]);
  });

  it('defaults to the project root', async () => {
    const r = await app.inject({ method: 'GET', url: '/api/projects/p1/dir' });
    const body = r.json() as { children: Node[] };
    expect(body.children.map((n) => n.name).sort()).toEqual(TOP_LEVEL);
  });

  it('rejects a path that escapes the project root', async () => {
    const r = await app.inject({ method: 'GET', url: '/api/projects/p1/dir?path=../..' });
    expect(r.statusCode).toBe(400);
  });

  it('404s a directory that does not exist', async () => {
    const r = await app.inject({ method: 'GET', url: '/api/projects/p1/dir?path=nope' });
    expect(r.statusCode).toBe(404);
  });
});

describe('GET /api/projects/:id/files (name search)', () => {
  it('finds a deeply nested file', async () => {
    const r = await app.inject({ method: 'GET', url: '/api/projects/p1/files?q=leaf' });
    expect(r.statusCode).toBe(200);
    const body = r.json() as { files: string[]; truncated: boolean };
    expect(body.files).toContain('deep/a/b/c/leaf.txt');
  });

  it('is case-insensitive and matches on the directory part too', async () => {
    const r = await app.inject({ method: 'GET', url: '/api/projects/p1/files?q=ZETA' });
    const body = r.json() as { files: string[] };
    expect(body.files.sort()).toEqual(['zeta/one.txt', 'zeta/two.txt']);
  });

  it('caps the response and reports it', async () => {
    const r = await app.inject({ method: 'GET', url: '/api/projects/p1/files?q=.txt' });
    const body = r.json() as { files: string[]; truncated: boolean };
    expect(body.files).toHaveLength(300);
    expect(body.truncated).toBe(true);
  });

  it('returns nothing for a blank query', async () => {
    const r = await app.inject({ method: 'GET', url: '/api/projects/p1/files?q=' });
    expect(r.json()).toEqual({ files: [], truncated: false });
  });
});

describe('walkAllFiles', () => {
  it('sees past the tree budget so search covers the whole project', () => {
    const files = walkAllFiles(fx.root);
    expect(files).toHaveLength(BIG_FILES + 5); // big/* + leaf + 2 zeta + README + zzz
    expect(files).toContain('deep/a/b/c/leaf.txt');
    expect(files.some((f) => f.includes('node_modules'))).toBe(false);
  });
});

describe('GET /api/projects/:id/search (content)', () => {
  // Reads every file in the fixture; the generous timeout is for disk contention
  // when the whole suite runs in parallel, not for the assertion.
  it(
    'finds matches in files the old capped walk never reached',
    async () => {
      const r = await app.inject({
        method: 'GET',
        url: '/api/projects/p1/search?q=needle-in-the-deep',
      });
      const body = r.json() as { matches: { path: string }[] };
      expect(body.matches.map((m) => m.path)).toEqual(['deep/a/b/c/leaf.txt']);
    },
    30_000,
  );
});
