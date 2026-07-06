import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import type { FastifyInstance } from 'fastify';
import { prisma } from '../db';
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

const MAX_ENTRIES = 4000; // cap tree size so a huge repo can't blow up the payload
const MAX_DEPTH = 12;
const MAX_READ_BYTES = 1024 * 1024; // 1 MiB — refuse to open anything larger
const MAX_WRITE_BYTES = 5 * 1024 * 1024; // 5 MiB write ceiling

// Content-search bounds so grepping a big repo can't hang or blow up the payload.
const MAX_SEARCH_MATCHES = 500;
const MAX_SEARCH_FILE_BYTES = 512 * 1024; // skip files larger than this when searching
const SEARCH_LINE_CLAMP = 240; // trim long matched lines in the response

interface FileNode {
  name: string;
  path: string; // project-relative, POSIX separators
  type: 'dir' | 'file';
  children?: FileNode[];
}

class PathError extends Error {}

/**
 * Resolve a project-relative path and guarantee it stays inside the project
 * root. Blocks `..` traversal and absolute-path escapes lexically, then — if
 * the target already exists — verifies its realpath so a symlink can't point
 * outside the root either. Throws PathError on any violation.
 */
function resolveInProject(root: string, rel: string): string {
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

/** Build a bounded, ignore-filtered file tree rooted at the project directory. */
function buildTree(root: string): { tree: FileNode[]; truncated: boolean } {
  const rootResolved = path.resolve(root);
  let count = 0;
  let truncated = false;

  const walk = (dirAbs: string, depth: number): FileNode[] => {
    if (depth > MAX_DEPTH) {
      truncated = true;
      return [];
    }
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(dirAbs, { withFileTypes: true });
    } catch {
      return [];
    }
    // Directories first, then files, each alphabetical.
    entries.sort((a, b) => {
      const ad = a.isDirectory() ? 0 : 1;
      const bd = b.isDirectory() ? 0 : 1;
      if (ad !== bd) return ad - bd;
      return a.name.localeCompare(b.name);
    });

    const nodes: FileNode[] = [];
    for (const e of entries) {
      if (count >= MAX_ENTRIES) {
        truncated = true;
        break;
      }
      // Skip symlinks entirely — avoids loops and out-of-root listings.
      if (e.isSymbolicLink()) continue;
      const isDir = e.isDirectory();
      if (isDir && IGNORE_DIRS.has(e.name)) continue;

      const abs = path.join(dirAbs, e.name);
      const rel = path.relative(rootResolved, abs).split(path.sep).join('/');
      count++;

      if (isDir) {
        nodes.push({ name: e.name, path: rel, type: 'dir', children: walk(abs, depth + 1) });
      } else if (e.isFile()) {
        nodes.push({ name: e.name, path: rel, type: 'file' });
      }
    }
    return nodes;
  };

  return { tree: walk(rootResolved, 0), truncated };
}

/** Flatten a file tree to its file paths (project-relative, POSIX). */
function flattenFiles(nodes: FileNode[]): string[] {
  const out: string[] = [];
  const rec = (ns: FileNode[]): void => {
    for (const n of ns) {
      if (n.type === 'dir') {
        if (n.children) rec(n.children);
      } else {
        out.push(n.path);
      }
    }
  };
  rec(nodes);
  return out;
}

export interface SearchMatch {
  path: string; // project-relative
  line: number; // 1-based
  text: string; // the matched line (trimmed + clamped)
}

export async function fileRoutes(app: FastifyInstance): Promise<void> {
  // Project file tree (bounded, ignore-filtered).
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

    const { tree, truncated } = buildTree(project.path);
    return { root: project.path, tree, truncated };
  });

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
      const files = flattenFiles(buildTree(project.path).tree);

      const matches: SearchMatch[] = [];
      let truncated = false;

      outer: for (const rel of files) {
        const abs = path.join(rootResolved, rel);
        let stat: fs.Stats;
        try {
          stat = fs.statSync(abs);
        } catch {
          continue;
        }
        if (stat.size > MAX_SEARCH_FILE_BYTES) continue;

        let buf: Buffer;
        try {
          buf = fs.readFileSync(abs);
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
      };
    },
  );

  // Write a file back to disk (create-or-overwrite within the project root).
  app.post<{ Params: { id: string }; Body: { path?: string; content?: string } }>(
    '/api/projects/:id/file',
    async (req, reply) => {
      const project = await prisma.project.findUnique({ where: { id: req.params.id } });
      if (!project) return reply.code(404).send({ error: 'Project not found.' });

      const rel = req.body?.path;
      const content = req.body?.content;
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

      // Refuse to clobber a directory.
      try {
        if (fs.statSync(abs).isDirectory()) {
          return reply.code(400).send({ error: 'Path is a directory.' });
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
      return { ok: true, bytes: Buffer.byteLength(content, 'utf8') };
    },
  );
}
