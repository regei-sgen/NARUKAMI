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
