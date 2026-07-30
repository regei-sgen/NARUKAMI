import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import type { FastifyInstance } from 'fastify';
import { prisma } from '../db';
import { currentBranch, fileAtHead } from '../services/gitEditor';
import { gitStatus, gitDiffRanges } from '../services/gitStatus';

// Directories we never descend into when building the file tree — noise + size.
const IGNORE_DIRS = new Set([
  'node_modules',
  '.git',
  'dist',
  'build',
  '.next',
  '.nuxt',
  '.svelte-kit',
  '.cache',
  '.parcel-cache',
  'coverage',
  '.turbo',
  'out',
  'target',
  'vendor',
  '.venv',
  'venv',
  '__pycache__',
  '.pytest_cache',
  '.mypy_cache',
  '.idea',
]);

// Budget for the EAGERLY-sent tree only. It never hides entries: a directory that
// doesn't fit is returned with `loaded:false` and the client fetches its full
// listing from /dir on expand. (The old code shared one budget across a
// depth-first walk, so one huge subtree ate it and every LATER SIBLING was
// silently dropped — a 44-entry project root rendered as 3 rows.)
const MAX_EAGER_NODES = 6000;
const MAX_DEPTH = 32; // recursion rail; deeper dirs are lazy, not hidden
const MAX_READ_BYTES = 1024 * 1024; // 1 MiB — refuse to open anything larger
const MAX_WRITE_BYTES = 5 * 1024 * 1024; // 5 MiB write ceiling
const MAX_NAME_MATCHES = 300; // cap for the file-name search response

// Content-search bounds so grepping a big repo can't hang or blow up the payload.
const MAX_SEARCH_MATCHES = 500;
const MAX_SEARCH_FILE_BYTES = 512 * 1024; // skip files larger than this when searching
const SEARCH_LINE_CLAMP = 240; // trim long matched lines in the response

interface FileNode {
  name: string;
  path: string; // project-relative, POSIX separators
  type: 'dir' | 'file';
  children?: FileNode[];
  // Dirs only. `false` = children were NOT included in this payload (too far past
  // the eager budget); the client loads them on demand from /dir. Absent means
  // `children` is the complete listing.
  loaded?: boolean;
}

class PathError extends Error {}

/**
 * Resolve a project-relative path and guarantee it stays inside the project
 * root. Blocks `..` traversal and absolute-path escapes lexically, then — if
 * the target already exists — verifies its realpath so a symlink can't point
 * outside the root either. Throws PathError on any violation.
 */
export function resolveInProject(root: string, rel: string): string {
  const rootResolved = path.resolve(root);
  // Strip any leading slash/backslash so an "absolute-looking" input is still
  // treated as relative to the project root rather than the filesystem root.
  const normalizedRel = rel.replace(/^[\\/]+/, '');
  const abs = path.resolve(rootResolved, normalizedRel);

  const within = abs === rootResolved || abs.startsWith(rootResolved + path.sep);
  if (!within) throw new PathError('Path escapes the project root.');

  // Symlink guard for existing targets. ENOENT (a not-yet-created file) is fine
  // here — write-time parent checks cover the new-file case.
  try {
    const real = fs.realpathSync(abs);
    const realRoot = fs.realpathSync(rootResolved);
    if (real !== realRoot && !real.startsWith(realRoot + path.sep)) {
      throw new PathError('Path resolves via a symlink outside the project root.');
    }
  } catch (err) {
    if (err instanceof PathError) throw err;
    // non-existent path — allowed (new file); parent is validated on write.
  }

  return abs;
}

/**
 * One directory's listable entries: real files + non-ignored directories, sorted
 * dirs-first then alphabetically. Symlinks are skipped entirely (loops and
 * out-of-root listings). An unreadable directory lists as empty, never throws.
 */
function readEntries(dirAbs: string): fs.Dirent[] {
  let entries: fs.Dirent[];
  try {
    entries = fs.readdirSync(dirAbs, { withFileTypes: true });
  } catch {
    return [];
  }
  const keep = entries.filter((e) => {
    if (e.isSymbolicLink()) return false;
    if (e.isDirectory()) return !IGNORE_DIRS.has(e.name);
    return e.isFile();
  });
  keep.sort((a, b) => {
    const ad = a.isDirectory() ? 0 : 1;
    const bd = b.isDirectory() ? 0 : 1;
    if (ad !== bd) return ad - bd;
    return a.name.localeCompare(b.name);
  });
  return keep;
}

/** Node for one dirent, with the project-relative POSIX path filled in. */
function toNode(rootResolved: string, dirAbs: string, e: fs.Dirent): FileNode {
  const abs = path.join(dirAbs, e.name);
  const rel = path.relative(rootResolved, abs).split(path.sep).join('/');
  return e.isDirectory()
    ? { name: e.name, path: rel, type: 'dir' }
    : { name: e.name, path: rel, type: 'file' };
}

/**
 * Build the ignore-filtered project tree, BREADTH-FIRST and all-or-nothing per
 * directory. Two invariants make the Explorer honest:
 *   1. every directory in the payload is listed COMPLETELY or marked
 *      `loaded:false` — never a partial sibling list;
 *   2. the project root is always complete, whatever the budget.
 * Breadth-first means the budget buys the shallow levels users actually look at
 * first, and anything past it stays reachable through /dir.
 */
export function buildTree(
  root: string,
  maxNodes: number = MAX_EAGER_NODES,
): { tree: FileNode[]; lazy: boolean } {
  const rootResolved = path.resolve(root);
  const tree: FileNode[] = [];
  let count = 0;
  let lazy = false;

  // {abs, node} — node is null for the root level, whose listing is unconditional.
  const queue: { abs: string; node: FileNode | null; depth: number }[] = [
    { abs: rootResolved, node: null, depth: 0 },
  ];

  for (let head = 0; head < queue.length; head += 1) {
    const { abs, node, depth } = queue[head];
    const entries = readEntries(abs);

    // Defer the WHOLE directory rather than cut it off mid-list.
    if (node && (depth > MAX_DEPTH || count + entries.length > maxNodes)) {
      node.loaded = false;
      lazy = true;
      continue;
    }

    const children: FileNode[] = [];
    for (const e of entries) {
      const child = toNode(rootResolved, abs, e);
      count += 1;
      children.push(child);
      if (child.type === 'dir') {
        queue.push({ abs: path.join(abs, e.name), node: child, depth: depth + 1 });
      }
    }
    if (node) node.children = children;
    else tree.push(...children);
  }

  return { tree, lazy };
}

/**
 * Every file in the project, project-relative and path-sorted. Uncapped on
 * purpose: this backs name + content search, which must see the whole project
 * (the old search flattened the capped tree, so it silently never looked past
 * the first few thousand entries).
 */
export function walkAllFiles(root: string): string[] {
  const rootResolved = path.resolve(root);
  const out: string[] = [];
  const stack: { abs: string; depth: number }[] = [{ abs: rootResolved, depth: 0 }];

  while (stack.length) {
    const { abs, depth } = stack.pop()!;
    if (depth > MAX_DEPTH) continue;
    for (const e of readEntries(abs)) {
      const childAbs = path.join(abs, e.name);
      if (e.isDirectory()) stack.push({ abs: childAbs, depth: depth + 1 });
      else out.push(path.relative(rootResolved, childAbs).split(path.sep).join('/'));
    }
  }
  out.sort((a, b) => a.localeCompare(b));
  return out;
}

export interface SearchMatch {
  path: string; // project-relative
  line: number; // 1-based
  text: string; // the matched line (trimmed + clamped)
}

export async function fileRoutes(app: FastifyInstance): Promise<void> {
  // Current git branch of the project (real-time label in the editor). Read-only.
  app.get<{ Params: { id: string } }>('/api/projects/:id/git/branch', async (req, reply) => {
    const project = await prisma.project.findUnique({ where: { id: req.params.id } });
    if (!project) return reply.code(404).send({ error: 'Project not found.' });
    return currentBranch(project.path);
  });

  // Committed (HEAD) content of a file — the LEFT side of the committed-vs-working
  // diff. `committed:false` means the file is new/untracked (diff against empty).
  app.get<{ Params: { id: string }; Querystring: { path?: string } }>(
    '/api/projects/:id/git/file-head',
    async (req, reply) => {
      const project = await prisma.project.findUnique({ where: { id: req.params.id } });
      if (!project) return reply.code(404).send({ error: 'Project not found.' });
      const rel = req.query.path;
      if (typeof rel !== 'string' || !rel.trim()) {
        return reply.code(400).send({ error: 'A file path is required.' });
      }
      let abs: string;
      try {
        abs = resolveInProject(project.path, rel); // reuse the editor's path-escape guard
      } catch (err) {
        return reply.code(400).send({ error: (err as Error).message });
      }
      const relPosix = path.relative(project.path, abs).split(path.sep).join('/');
      const content = await fileAtHead(project.path, relPosix);
      return { path: relPosix, committed: content !== null, content: content ?? '' };
    },
  );

  // Git working-tree status for the whole project — which files changed since the
  // last commit (drives the file-tree change markers). Non-repo → isRepo:false.
  app.get<{ Params: { id: string } }>('/api/projects/:id/git/status', async (req, reply) => {
    const project = await prisma.project.findUnique({ where: { id: req.params.id } });
    if (!project) return reply.code(404).send({ error: 'Project not found.' });
    return gitStatus(project.path);
  });

  // Changed line ranges for one file (drives the editor's diff gutter). The path
  // is lexically validated here (rejects `..`/symlink escapes) and git itself runs
  // with GIT_LITERAL_PATHSPECS so pathspec magic (`:/`, `:(top)`) can't escape.
  app.get<{ Params: { id: string }; Querystring: { path?: string } }>(
    '/api/projects/:id/git/diff',
    async (req, reply) => {
      const project = await prisma.project.findUnique({ where: { id: req.params.id } });
      if (!project) return reply.code(404).send({ error: 'Project not found.' });

      const rel = req.query.path;
      if (typeof rel !== 'string' || !rel.trim()) {
        return reply.code(400).send({ error: 'A file path is required.' });
      }
      try {
        resolveInProject(project.path, rel); // reject `..` / symlink escapes
      } catch (err) {
        return reply.code(400).send({ error: (err as Error).message });
      }

      const normalized = rel.replace(/^[\\/]+/, '').split('\\').join('/');
      return gitDiffRanges(project.path, normalized);
    },
  );

  // Project file tree (ignore-filtered). Complete per directory: anything past the
  // eager budget comes back as `loaded:false` and is fetched from /dir on expand.
  app.get<{ Params: { id: string } }>('/api/projects/:id/tree', async (req, reply) => {
    const project = await prisma.project.findUnique({ where: { id: req.params.id } });
    if (!project) return reply.code(404).send({ error: 'Project not found.' });

    try {
      if (!fs.statSync(project.path).isDirectory()) {
        return reply.code(400).send({ error: 'Project path is not a directory.' });
      }
    } catch {
      return reply.code(400).send({ error: `Project path no longer exists: ${project.path}` });
    }

    const { tree, lazy } = buildTree(project.path);
    return { root: project.path, tree, lazy };
  });

  // Immediate children of ONE directory — the whole listing, no budget. Backs
  // lazy expansion of directories the initial tree deferred; each subdirectory
  // comes back `loaded:false` so expansion stays one level at a time.
  app.get<{ Params: { id: string }; Querystring: { path?: string } }>(
    '/api/projects/:id/dir',
    async (req, reply) => {
      const project = await prisma.project.findUnique({ where: { id: req.params.id } });
      if (!project) return reply.code(404).send({ error: 'Project not found.' });

      const rel = typeof req.query.path === 'string' ? req.query.path : '';
      let abs: string;
      try {
        abs = resolveInProject(project.path, rel); // reject `..` / symlink escapes
      } catch (err) {
        return reply.code(400).send({ error: (err as Error).message });
      }
      try {
        if (!fs.statSync(abs).isDirectory()) {
          return reply.code(400).send({ error: 'Not a directory.' });
        }
      } catch {
        return reply.code(404).send({ error: 'Directory not found.' });
      }

      const rootResolved = path.resolve(project.path);
      const children = readEntries(abs).map((e) => {
        const node = toNode(rootResolved, abs, e);
        if (node.type === 'dir') node.loaded = false;
        return node;
      });
      return { path: path.relative(rootResolved, abs).split(path.sep).join('/'), children };
    },
  );

  // Find files by name across the WHOLE project (case-insensitive substring on the
  // project-relative path). Basename hits rank above directory-only hits.
  app.get<{ Params: { id: string }; Querystring: { q?: string } }>(
    '/api/projects/:id/files',
    async (req, reply) => {
      const project = await prisma.project.findUnique({ where: { id: req.params.id } });
      if (!project) return reply.code(404).send({ error: 'Project not found.' });

      const q = typeof req.query.q === 'string' ? req.query.q : '';
      if (!q.trim()) return { files: [], truncated: false };

      try {
        if (!fs.statSync(project.path).isDirectory()) {
          return reply.code(400).send({ error: 'Project path is not a directory.' });
        }
      } catch {
        return reply.code(400).send({ error: `Project path no longer exists: ${project.path}` });
      }

      const needle = q.trim().toLowerCase();
      const hits = walkAllFiles(project.path).filter((p) => p.toLowerCase().includes(needle));
      hits.sort((a, b) => {
        const an = (a.split('/').pop() ?? '').toLowerCase().includes(needle) ? 0 : 1;
        const bn = (b.split('/').pop() ?? '').toLowerCase().includes(needle) ? 0 : 1;
        if (an !== bn) return an - bn;
        if (a.length !== b.length) return a.length - b.length;
        return a.localeCompare(b);
      });
      return { files: hits.slice(0, MAX_NAME_MATCHES), truncated: hits.length > MAX_NAME_MATCHES };
    },
  );

  // Search file contents across the project (case-insensitive substring). Bounded
  // by ignore-dirs, per-file size, and a total match cap so a big repo is safe.
  app.get<{ Params: { id: string }; Querystring: { q?: string } }>(
    '/api/projects/:id/search',
    async (req, reply) => {
      const project = await prisma.project.findUnique({ where: { id: req.params.id } });
      if (!project) return reply.code(404).send({ error: 'Project not found.' });

      const q = typeof req.query.q === 'string' ? req.query.q : '';
      if (!q.trim()) return { matches: [], truncated: false };

      try {
        if (!fs.statSync(project.path).isDirectory()) {
          return reply.code(400).send({ error: 'Project path is not a directory.' });
        }
      } catch {
        return reply.code(400).send({ error: `Project path no longer exists: ${project.path}` });
      }

      const rootResolved = path.resolve(project.path);
      const needle = q.toLowerCase();
      const files = walkAllFiles(project.path);

      const matches: SearchMatch[] = [];
      let truncated = false;

      // Async per-file I/O, deliberately: each await yields the event loop, so
      // a search over thousands of files can't stall the pty→WebSocket fan-out
      // of live terminals the way a readFileSync loop did.
      outer: for (const rel of files) {
        const abs = path.join(rootResolved, rel);
        let stat: fs.Stats;
        try {
          stat = await fsp.stat(abs);
        } catch {
          continue;
        }
        if (stat.size > MAX_SEARCH_FILE_BYTES) continue;

        let buf: Buffer;
        try {
          buf = await fsp.readFile(abs);
        } catch {
          continue;
        }
        // Skip binaries (NUL in the first 8 KB).
        if (buf.subarray(0, 8192).includes(0)) continue;

        const lines = buf.toString('utf8').split(/\r?\n/);
        for (let i = 0; i < lines.length; i += 1) {
          if (lines[i].toLowerCase().includes(needle)) {
            matches.push({ path: rel, line: i + 1, text: lines[i].trim().slice(0, SEARCH_LINE_CLAMP) });
            if (matches.length >= MAX_SEARCH_MATCHES) {
              truncated = true;
              break outer;
            }
          }
        }
      }

      return { matches, truncated };
    },
  );

  // Read a single file's UTF-8 contents.
  app.get<{ Params: { id: string }; Querystring: { path?: string } }>(
    '/api/projects/:id/file',
    async (req, reply) => {
      const project = await prisma.project.findUnique({ where: { id: req.params.id } });
      if (!project) return reply.code(404).send({ error: 'Project not found.' });

      const rel = req.query.path;
      if (typeof rel !== 'string' || !rel.trim()) {
        return reply.code(400).send({ error: 'A file path is required.' });
      }

      let abs: string;
      try {
        abs = resolveInProject(project.path, rel);
      } catch (err) {
        return reply.code(400).send({ error: (err as Error).message });
      }

      let stat: fs.Stats;
      try {
        stat = fs.statSync(abs);
      } catch {
        return reply.code(404).send({ error: 'File not found.' });
      }
      if (stat.isDirectory()) return reply.code(400).send({ error: 'Path is a directory.' });
      if (stat.size > MAX_READ_BYTES) {
        return reply
          .code(413)
          .send({ error: `File too large to open (${stat.size} bytes; limit ${MAX_READ_BYTES}).` });
      }

      const buf = await fsp.readFile(abs);
      // Cheap binary sniff: a NUL byte in the first 8KB means "not text".
      if (buf.subarray(0, 8192).includes(0)) {
        return reply.code(415).send({ error: 'Binary file — not editable.' });
      }

      return {
        path: rel.replace(/^[\\/]+/, '').split('\\').join('/'),
        content: buf.toString('utf8'),
        size: stat.size,
        // The client sends this back on save so we can detect an on-disk change
        // made since the file was opened (conflict / last-write-wins guard).
        mtimeMs: stat.mtimeMs,
      };
    },
  );

  // Cheap staleness probe for an OPEN file: mtime + size, no content read. The
  // editor polls this to tell whether the copy in the buffer still matches disk
  // (Claude and other tools edit files behind the editor's back), so the poll
  // costs a stat rather than re-reading up to a megabyte every few seconds.
  app.get<{ Params: { id: string }; Querystring: { path?: string } }>(
    '/api/projects/:id/file-stat',
    async (req, reply) => {
      const project = await prisma.project.findUnique({ where: { id: req.params.id } });
      if (!project) return reply.code(404).send({ error: 'Project not found.' });

      const rel = req.query.path;
      if (typeof rel !== 'string' || !rel.trim()) {
        return reply.code(400).send({ error: 'A file path is required.' });
      }

      let abs: string;
      try {
        abs = resolveInProject(project.path, rel);
      } catch (err) {
        return reply.code(400).send({ error: (err as Error).message });
      }

      let stat: fs.Stats;
      try {
        stat = fs.statSync(abs);
      } catch {
        return reply.code(404).send({ error: 'File not found.' });
      }
      if (stat.isDirectory()) return reply.code(400).send({ error: 'Path is a directory.' });

      return {
        path: rel.replace(/^[\\/]+/, '').split('\\').join('/'),
        mtimeMs: stat.mtimeMs,
        size: stat.size,
      };
    },
  );

  // Write a file back to disk (create-or-overwrite within the project root).
  app.post<{ Params: { id: string }; Body: { path?: string; content?: string; baseMtimeMs?: number } }>(
    '/api/projects/:id/file',
    async (req, reply) => {
      const project = await prisma.project.findUnique({ where: { id: req.params.id } });
      if (!project) return reply.code(404).send({ error: 'Project not found.' });

      const rel = req.body?.path;
      const content = req.body?.content;
      const baseMtimeMs = req.body?.baseMtimeMs;
      if (typeof rel !== 'string' || !rel.trim()) {
        return reply.code(400).send({ error: 'A file path is required.' });
      }
      if (typeof content !== 'string') {
        return reply.code(400).send({ error: 'File content is required.' });
      }
      if (Buffer.byteLength(content, 'utf8') > MAX_WRITE_BYTES) {
        return reply.code(413).send({ error: `Content exceeds the ${MAX_WRITE_BYTES}-byte write limit.` });
      }

      let abs: string;
      try {
        abs = resolveInProject(project.path, rel);
      } catch (err) {
        return reply.code(400).send({ error: (err as Error).message });
      }

      // Refuse to clobber a directory; and, if the caller supplied the mtime it
      // opened the file at, refuse to silently overwrite an edit made on disk
      // since then (409). Omitting baseMtimeMs forces the write (explicit override).
      try {
        const st = fs.statSync(abs);
        if (st.isDirectory()) {
          return reply.code(400).send({ error: 'Path is a directory.' });
        }
        if (typeof baseMtimeMs === 'number' && st.mtimeMs > baseMtimeMs) {
          return reply.code(409).send({
            error:
              'This file changed on disk since you opened it. Reload to see the latest, or save again to overwrite.',
          });
        }
      } catch {
        /* target doesn't exist yet — creating a new file, allowed */
      }

      // The parent directory must already exist AND resolve (via realpath, so a
      // symlinked parent can't escape) inside the project root.
      const parent = path.dirname(abs);
      let realParent: string;
      try {
        realParent = fs.realpathSync(parent);
      } catch {
        return reply.code(400).send({ error: 'Parent directory does not exist.' });
      }
      const realRoot = fs.realpathSync(path.resolve(project.path));
      if (realParent !== realRoot && !realParent.startsWith(realRoot + path.sep)) {
        return reply.code(400).send({ error: 'Target directory is outside the project root.' });
      }

      await fsp.writeFile(abs, content, 'utf8');
      // Return the new mtime so the client can update its conflict baseline.
      const written = fs.statSync(abs);
      return { ok: true, bytes: Buffer.byteLength(content, 'utf8'), mtimeMs: written.mtimeMs };
    },
  );
}
