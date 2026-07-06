import fs from 'node:fs';
import path from 'node:path';
import type { FastifyInstance } from 'fastify';
import { Prisma } from '../generated/prisma';
import { prisma } from '../db';
import { analyzeProject, AnalyzerError, suggestCommand } from '../services/analyzer';
import { stopRun } from '../services/runner';

// Serialize analysis per project so two overlapping requests can't interleave
// the deleteMany/createMany replacement and produce a duplicated command set.
const analyzing = new Set<string>();

export async function projectRoutes(app: FastifyInstance): Promise<void> {
  // List projects with their commands + latest run.
  app.get('/api/projects', async () => {
    return prisma.project.findMany({
      orderBy: { createdAt: 'desc' },
      include: {
        commands: { orderBy: [{ isDefault: 'desc' }, { label: 'asc' }] },
        runs: { orderBy: { startedAt: 'desc' }, take: 1 },
      },
    });
  });

  // Register a project by absolute (or resolvable) path.
  app.post<{ Body: { path?: string } }>('/api/projects', async (req, reply) => {
    const raw = req.body?.path;
    if (typeof raw !== 'string' || !raw.trim()) {
      return reply.code(400).send({ error: 'A project path is required.' });
    }

    const resolved = path.resolve(raw.trim());

    let stat: fs.Stats;
    try {
      stat = fs.statSync(resolved);
    } catch {
      return reply.code(400).send({ error: `Path does not exist: ${resolved}` });
    }
    if (!stat.isDirectory()) {
      return reply.code(400).send({ error: `Path is not a directory: ${resolved}` });
    }

    // Canonicalize so the unique-path dedup can't be dodged by an alias of the
    // SAME physical dir: realpathSync.native collapses symlinks, Windows 8.3
    // short names (STEPHA~1) and case differences into one true path. Without
    // this, two spellings register as two projects sharing one cwd — their
    // `claude -p` / runs then contend on the same .claude state.
    let projectPath = resolved;
    try {
      projectPath = fs.realpathSync.native(resolved);
    } catch {
      // Keep the resolved path if the OS can't canonicalize it.
    }

    const existing = await prisma.project.findUnique({ where: { path: projectPath } });
    if (existing) {
      return reply.code(409).send({ error: 'That project is already registered.' });
    }

    const name = path.basename(projectPath) || projectPath;
    const project = await prisma.project.create({
      data: { name, path: projectPath, status: 'registered' },
      include: { commands: true, runs: true },
    });
    return reply.code(201).send(project);
  });

  // Delete a project (cascades to commands/runs/logs/analyses).
  app.delete<{ Params: { id: string } }>('/api/projects/:id', async (req, reply) => {
    try {
      // Stop any live ptys for this project FIRST. The cascade delete removes the
      // Run rows, after which those processes would be orphaned — still running,
      // no longer in the DB, and thus impossible to stop via /stop.
      const liveRuns = await prisma.run.findMany({
        where: { projectId: req.params.id, status: 'running' },
        select: { id: true },
      });
      for (const r of liveRuns) stopRun(r.id);

      await prisma.project.delete({ where: { id: req.params.id } });
    } catch (err) {
      // P2025 = record to delete not found. Anything else is a real failure.
      if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === 'P2025') {
        return reply.code(404).send({ error: 'Project not found.' });
      }
      return reply.code(500).send({ error: 'Failed to delete project.', detail: String(err) });
    }
    return reply.code(204).send();
  });

  // Analyze a project via `claude -p` and persist detected commands.
  app.post<{ Params: { id: string } }>('/api/projects/:id/analyze', async (req, reply) => {
    const project = await prisma.project.findUnique({ where: { id: req.params.id } });
    if (!project) return reply.code(404).send({ error: 'Project not found.' });

    if (analyzing.has(project.id)) {
      return reply.code(409).send({ error: 'An analysis is already in progress for this project.' });
    }
    analyzing.add(project.id);

    try {
      const { parsed, raw } = await analyzeProject(project.path);

      // Replace commands atomically: if any step fails, the old set survives.
      const updated = await prisma.$transaction(async (tx) => {
        await tx.analysis.create({
          data: { projectId: project.id, rawResult: raw as Prisma.InputJsonValue },
        });
        // Only replace analyze-detected commands; user-added custom ones survive.
        await tx.runCommand.deleteMany({ where: { projectId: project.id, source: 'detected' } });
        // Uphold the "at most one default per project" invariant that
        // createCommand enforces: if the detected set carries a default, clear
        // any surviving custom default first so we don't end up with two.
        if (parsed.commands.some((c) => c.isDefault)) {
          await tx.runCommand.updateMany({
            where: { projectId: project.id, isDefault: true },
            data: { isDefault: false },
          });
        }
        if (parsed.commands.length) {
          await tx.runCommand.createMany({
            data: parsed.commands.map((c) => ({
              projectId: project.id,
              label: c.label,
              command: c.command,
              isDefault: c.isDefault,
              source: 'detected',
            })),
          });
        }
        return tx.project.update({
          where: { id: project.id },
          data: {
            type: parsed.type,
            packageMgr: parsed.packageManager,
            status: 'analyzed',
          },
          // Include `runs` so the response matches the Project shape the client
          // expects (the list endpoint returns it too); omitting it dropped the
          // field the frontend types require.
          include: {
            commands: { orderBy: [{ isDefault: 'desc' }, { label: 'asc' }] },
            runs: { orderBy: { startedAt: 'desc' }, take: 1 },
          },
        });
      });

      return { project: updated, analysis: parsed };
    } catch (err) {
      await prisma.project
        .update({ where: { id: project.id }, data: { status: 'error' } })
        .catch(() => undefined);

      if (err instanceof AnalyzerError) {
        return reply.code(502).send({ error: err.message, raw: err.raw ?? null });
      }
      return reply.code(500).send({ error: 'Analysis failed.', detail: String(err) });
    } finally {
      analyzing.delete(project.id);
    }
  });

  // Add a custom run command manually.
  app.post<{
    Params: { id: string };
    Body: { label?: string; command?: string; cwd?: string; isDefault?: boolean };
  }>('/api/projects/:id/commands', async (req, reply) => {
    const project = await prisma.project.findUnique({ where: { id: req.params.id } });
    if (!project) return reply.code(404).send({ error: 'Project not found.' });

    const label = req.body?.label?.trim();
    const command = req.body?.command?.trim();
    if (!label) return reply.code(400).send({ error: 'A command label is required.' });
    if (!command) return reply.code(400).send({ error: 'A command is required.' });

    const created = await createCommand(project.id, {
      label,
      command,
      cwd: req.body?.cwd?.trim() || null,
      isDefault: Boolean(req.body?.isDefault),
    });
    return reply.code(201).send(created);
  });

  // Add a run command by describing it to Claude Code (natural language -> command).
  app.post<{ Params: { id: string }; Body: { request?: string; isDefault?: boolean } }>(
    '/api/projects/:id/commands/suggest',
    async (req, reply) => {
      const project = await prisma.project.findUnique({ where: { id: req.params.id } });
      if (!project) return reply.code(404).send({ error: 'Project not found.' });

      const request = req.body?.request?.trim();
      if (!request) return reply.code(400).send({ error: 'Describe what you want to run.' });

      try {
        const { label, command } = await suggestCommand(project.path, request);
        const created = await createCommand(project.id, {
          label,
          command,
          cwd: null,
          isDefault: Boolean(req.body?.isDefault),
        });
        return reply.code(201).send(created);
      } catch (err) {
        if (err instanceof AnalyzerError) {
          return reply.code(502).send({ error: err.message, raw: err.raw ?? null });
        }
        return reply.code(500).send({ error: 'Command suggestion failed.', detail: String(err) });
      }
    },
  );

  // Delete a run command (detected or custom).
  app.delete<{ Params: { commandId: string } }>('/api/commands/:commandId', async (req, reply) => {
    try {
      await prisma.runCommand.delete({ where: { id: req.params.commandId } });
    } catch (err) {
      if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === 'P2025') {
        return reply.code(404).send({ error: 'Command not found.' });
      }
      return reply.code(500).send({ error: 'Failed to delete command.', detail: String(err) });
    }
    return reply.code(204).send();
  });
}

interface NewCommand {
  label: string;
  command: string;
  cwd: string | null;
  isDefault: boolean;
}

/** Create a custom command, enforcing at most one default per project. */
async function createCommand(projectId: string, data: NewCommand) {
  return prisma.$transaction(async (tx) => {
    if (data.isDefault) {
      await tx.runCommand.updateMany({ where: { projectId }, data: { isDefault: false } });
    }
    return tx.runCommand.create({
      data: {
        projectId,
        label: data.label,
        command: data.command,
        cwd: data.cwd,
        isDefault: data.isDefault,
        source: 'custom',
      },
    });
  });
}
