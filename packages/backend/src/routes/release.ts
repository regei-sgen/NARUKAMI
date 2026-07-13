import type { FastifyInstance } from 'fastify';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { prisma } from '../db';
import { AnalyzerError, generateReleaseNotes } from '../services/analyzer';
import {
  SGA_PRODUCT_NAME,
  VERSION_RE,
  ZIP_DIR_SETTING_KEY,
  buildReleaseZip,
  collectNotesMaterial,
  commitVersionBump,
  dirtyBeyondVersionFiles,
  ensureZipDir,
  pushCurrentBranch,
  releasePreflight,
} from '../services/release';

// One release build at a time per project — a double-click must not race two
// bumps/archives in the same working tree. In-process is enough: the backend is
// a single local instance.
const releasing = new Set<string>();

interface ReleaseRow {
  id: string;
  projectId: string;
  version: string;
  zipPath: string;
  zipBytes: number;
  headCommit: string | null;
  dirtyIncluded: boolean;
  summary: string | null;
  notes: string | null;
  createdAt: Date;
  updatedAt: Date;
}

/** The permanent zip output folder — the saved AppSetting, else the home dir. */
async function readZipDirSetting(): Promise<string> {
  try {
    const row = await prisma.appSetting.findUnique({ where: { key: ZIP_DIR_SETTING_KEY } });
    if (row) {
      const v: unknown = JSON.parse(row.value);
      if (typeof v === 'string' && v.trim()) return v;
    }
  } catch {
    // fall through to the default
  }
  return os.homedir();
}

function serializeRelease(r: ReleaseRow) {
  let zipExists = false;
  try {
    zipExists = fs.existsSync(r.zipPath);
  } catch {
    zipExists = false;
  }
  return { ...r, zipExists };
}

export async function releaseRoutes(app: FastifyInstance): Promise<void> {
  // Everything the Release tab needs up front: SGA fingerprint, versions,
  // working-tree dirt, and the saved release history.
  app.get<{ Params: { id: string } }>(
    '/api/projects/:id/release/preflight',
    async (req, reply) => {
      const project = await prisma.project.findUnique({ where: { id: req.params.id } });
      if (!project) return reply.code(404).send({ error: 'Project not found.' });
      const pre = await releasePreflight(project.path);
      const releases = await prisma.release.findMany({
        where: { projectId: project.id },
        orderBy: { createdAt: 'desc' },
        take: 20,
      });
      return {
        ...pre,
        zipDir: await readZipDirSetting(),
        releasing: releasing.has(project.id),
        releases: releases.map(serializeRelease),
      };
    },
  );

  // Set (or reset, with an empty dir) the PERMANENT zip output folder. Persisted
  // as an AppSetting, so it survives restarts and only changes via this call.
  app.post<{ Body: { dir?: string } }>('/api/release/zip-dir', async (req, reply) => {
    const raw = typeof req.body?.dir === 'string' ? req.body.dir.trim() : '';
    if (!raw) {
      await prisma.appSetting.deleteMany({ where: { key: ZIP_DIR_SETTING_KEY } });
      return { ok: true, zipDir: os.homedir(), isDefault: true };
    }
    try {
      const dir = ensureZipDir(raw);
      await prisma.appSetting.upsert({
        where: { key: ZIP_DIR_SETTING_KEY },
        update: { value: JSON.stringify(dir) },
        create: { key: ZIP_DIR_SETTING_KEY, value: JSON.stringify(dir) },
      });
      return { ok: true, zipDir: dir, isDefault: false };
    } catch (err) {
      return reply.code(400).send({ error: String((err as Error).message) });
    }
  });

  // The deterministic half of a release: bump the 3 version files (working tree,
  // uncommitted), git-archive the snapshot to ~/sgen-claude-chat-v<version>.zip,
  // record a Release row. Notes are a separate call so the zip surfaces fast.
  app.post<{ Params: { id: string }; Body: { version?: string; includeDirty?: boolean } }>(
    '/api/projects/:id/release',
    async (req, reply) => {
      const project = await prisma.project.findUnique({ where: { id: req.params.id } });
      if (!project) return reply.code(404).send({ error: 'Project not found.' });
      if (releasing.has(project.id)) {
        return reply.code(409).send({ error: 'A release is already running for this project.' });
      }

      releasing.add(project.id);
      try {
        const pre = await releasePreflight(project.path);
        if (!pre.isRepo) {
          return reply.code(400).send({ error: 'The project folder is not a git repository.' });
        }
        if (!pre.isSga) {
          return reply.code(400).send({
            error:
              `This project doesn't look like the SG Claude Assistant repo — ` +
              `missing: ${pre.missing.join(', ')}.`,
          });
        }
        const version =
          typeof req.body?.version === 'string' && req.body.version.trim()
            ? req.body.version.trim()
            : pre.suggestedVersion ?? '';
        if (!VERSION_RE.test(version)) {
          return reply.code(400).send({
            error: `Invalid version "${version}" — expected MAJOR.MINOR.PATCH (e.g. 2.7.1).`,
          });
        }
        // The archive snapshots the whole working tree, so uncommitted work
        // ships in the zip — require an explicit opt-in (the version files
        // themselves are exempt: they change as part of the release).
        const dirtyOthers = dirtyBeyondVersionFiles(pre.dirty);
        if (dirtyOthers.length > 0 && req.body?.includeDirty !== true) {
          return reply.code(409).send({
            error:
              `The repo has ${dirtyOthers.length} uncommitted change(s) that would ship in ` +
              `the zip — confirm "include uncommitted changes" to proceed.`,
            dirty: dirtyOthers,
          });
        }

        // Resolve the permanent output folder (recreating it if it vanished) —
        // an invalid setting fails the release BEFORE any file is bumped.
        let outDir: string;
        try {
          outDir = ensureZipDir(await readZipDirSetting());
        } catch (err) {
          return reply.code(400).send({ error: `Zip output folder is invalid: ${String((err as Error).message)}` });
        }
        const zip = await buildReleaseZip(project.path, version, outDir);
        const row = await prisma.release.create({
          data: {
            projectId: project.id,
            version,
            zipPath: zip.zipPath,
            zipBytes: zip.zipBytes,
            headCommit: zip.headCommit,
            dirtyIncluded: dirtyOthers.length > 0,
          },
        });
        return reply.code(201).send(serializeRelease(row));
      } catch (err) {
        return reply.code(500).send({ error: 'Release build failed.', detail: String(err) });
      } finally {
        releasing.delete(project.id);
      }
    },
  );

  // Commit the version bump (only the three version files, automatic message).
  app.post<{ Params: { id: string } }>('/api/projects/:id/release/commit', async (req, reply) => {
    const project = await prisma.project.findUnique({ where: { id: req.params.id } });
    if (!project) return reply.code(404).send({ error: 'Project not found.' });
    try {
      const res = await commitVersionBump(project.path);
      return { ok: true, ...res };
    } catch (err) {
      const msg = String((err as Error).message ?? err);
      if (msg.includes('Nothing to commit')) return reply.code(409).send({ error: msg });
      return reply.code(500).send({ error: 'Commit failed.', detail: msg });
    }
  });

  // Push the current branch (creates the origin upstream on first push).
  app.post<{ Params: { id: string } }>('/api/projects/:id/release/push', async (req, reply) => {
    const project = await prisma.project.findUnique({ where: { id: req.params.id } });
    if (!project) return reply.code(404).send({ error: 'Project not found.' });
    try {
      const res = await pushCurrentBranch(project.path);
      return { ok: true, ...res };
    } catch (err) {
      // Network / auth / no-remote failures land here — surface git's own words.
      const e = err as Error & { stderr?: string };
      return reply.code(502).send({ error: 'Push failed.', detail: (e.stderr || e.message || String(err)).slice(0, 2000) });
    }
  });

  // The AI half: patch-note summary + description from CHANGELOG [Unreleased] +
  // the release's commit range. Idempotent — safe to retry after a timeout.
  app.post<{ Params: { id: string } }>('/api/releases/:id/notes', async (req, reply) => {
    const release = await prisma.release.findUnique({
      where: { id: req.params.id },
      include: { project: true },
    });
    if (!release) return reply.code(404).send({ error: 'Release not found.' });

    const prev = await prisma.release.findFirst({
      where: {
        projectId: release.projectId,
        createdAt: { lt: release.createdAt },
        headCommit: { not: null },
        NOT: { id: release.id },
      },
      orderBy: { createdAt: 'desc' },
    });

    try {
      const material = await collectNotesMaterial(release.project.path, prev?.headCommit ?? null);
      const notes = await generateReleaseNotes(release.project.path, {
        product: SGA_PRODUCT_NAME,
        version: release.version,
        changelog: material.changelog,
        commits: material.commits,
        rangeLabel: material.rangeLabel,
      });
      const row = await prisma.release.update({
        where: { id: release.id },
        data: { summary: notes.summary, notes: notes.description },
      });
      return serializeRelease(row);
    } catch (err) {
      if (err instanceof AnalyzerError) return reply.code(502).send({ error: err.message });
      return reply
        .code(500)
        .send({ error: 'Release notes generation failed.', detail: String(err) });
    }
  });

  app.get<{ Params: { id: string } }>('/api/projects/:id/releases', async (req, reply) => {
    const project = await prisma.project.findUnique({ where: { id: req.params.id } });
    if (!project) return reply.code(404).send({ error: 'Project not found.' });
    const rows = await prisma.release.findMany({
      where: { projectId: project.id },
      orderBy: { createdAt: 'desc' },
    });
    return rows.map(serializeRelease);
  });

  // Browser download of the zip (authed fetch → blob on the frontend).
  app.get<{ Params: { id: string } }>('/api/releases/:id/zip', async (req, reply) => {
    const release = await prisma.release.findUnique({ where: { id: req.params.id } });
    if (!release) return reply.code(404).send({ error: 'Release not found.' });
    if (!fs.existsSync(release.zipPath)) {
      return reply.code(404).send({ error: 'The zip file no longer exists on disk.' });
    }
    const filename = path.basename(release.zipPath);
    return reply
      .type('application/zip')
      .header('Content-Disposition', `attachment; filename="${filename}"`)
      .send(fs.createReadStream(release.zipPath));
  });

  // Deletes the history row only — the zip on disk stays (it's the user's file).
  app.delete<{ Params: { id: string } }>('/api/releases/:id', async (req, reply) => {
    const release = await prisma.release.findUnique({ where: { id: req.params.id } });
    if (!release) return reply.code(404).send({ error: 'Release not found.' });
    await prisma.release.delete({ where: { id: release.id } });
    return { ok: true };
  });
}
