import type { FastifyInstance } from 'fastify';
import { prisma } from '../db';
import { isRunning, startClaude, startRun, startShell, stopRun } from '../services/runner';
import { startAdminShell } from '../services/brokerServer';
import { AnalyzerError, diagnoseRun } from '../services/analyzer';
import {
  availableShells,
  shellKindFromLabel,
  shellLabel,
  type ShellKind,
} from '../services/shells';

const SHELL_KINDS: ShellKind[] = ['powershell', 'cmd', 'gitbash'];
function parseShellKind(v: unknown): ShellKind | undefined {
  return typeof v === 'string' && (SHELL_KINDS as string[]).includes(v)
    ? (v as ShellKind)
    : undefined;
}

export async function runRoutes(app: FastifyInstance): Promise<void> {
  // Start a run for one of a project's detected commands.
  app.post<{ Params: { id: string }; Body: { commandId?: string } }>(
    '/api/projects/:id/run',
    async (req, reply) => {
      const project = await prisma.project.findUnique({ where: { id: req.params.id } });
      if (!project) return reply.code(404).send({ error: 'Project not found.' });

      const commandId = req.body?.commandId;
      if (!commandId) return reply.code(400).send({ error: 'commandId is required.' });

      const cmd = await prisma.runCommand.findFirst({
        where: { id: commandId, projectId: project.id },
      });
      if (!cmd) return reply.code(404).send({ error: 'Run command not found for this project.' });

      const cwd = cmd.cwd || project.path;

      // Create the Run row first so RunLog foreign keys are valid.
      const run = await prisma.run.create({
        data: {
          projectId: project.id,
          commandId: cmd.id,
          kind: 'command',
          dockOpen: true,
          status: 'running',
        },
      });

      try {
        const { pid } = startRun({ runId: run.id, command: cmd.command, cwd });
        await prisma.run.update({ where: { id: run.id }, data: { pid } });
        return reply.code(201).send({ runId: run.id, pid });
      } catch (err) {
        await prisma.run.update({
          where: { id: run.id },
          data: { status: 'error', endedAt: new Date() },
        });
        return reply.code(500).send({ error: `Failed to start process: ${String(err)}` });
      }
    },
  );

  // Which interactive shells this machine can open (for the terminal's shell
  // menu). Machine-global, so it takes no project.
  app.get('/api/shells', async () => ({ shells: availableShells() }));

  // Open an interactive shell rooted at the project dir. `kind` picks the Windows
  // shell (powershell | cmd | gitbash; default powershell). `admin: true`
  // (Windows only) opens an ELEVATED shell via the broker: it fires a UAC prompt
  // and the run goes live once the elevated agent connects back. Admin is
  // PowerShell-only for now (the broker spawns an elevated powershell.exe).
  app.post<{ Params: { id: string }; Body: { admin?: boolean; kind?: string } }>(
    '/api/projects/:id/shell',
    async (req, reply) => {
      const project = await prisma.project.findUnique({ where: { id: req.params.id } });
      if (!project) return reply.code(404).send({ error: 'Project not found.' });

      const admin = req.body?.admin === true;
      if (admin && process.platform !== 'win32') {
        return reply.code(400).send({ error: 'Admin shells are only supported on Windows.' });
      }
      const kind = parseShellKind(req.body?.kind) ?? 'powershell';
      if (admin && kind !== 'powershell') {
        return reply.code(400).send({ error: 'Admin shells are PowerShell-only.' });
      }

      // Store the shell label as the Run name so restart + reload recover the
      // kind (see the restart handler below), and the tab shows the right name.
      const run = await prisma.run.create({
        data: {
          projectId: project.id,
          kind: 'shell',
          name: shellLabel(kind),
          dockOpen: true,
          status: 'running',
        },
      });

      try {
        if (admin) {
          // No local pid — elevation is async. The tab shows "waiting for UAC"
          // until the broker connects (then /api/runs/:id reports live=true).
          await startAdminShell({ runId: run.id, cwd: project.path });
          return reply.code(201).send({ runId: run.id, elevated: true, pending: true });
        }
        const { pid } = startShell({ runId: run.id, cwd: project.path, kind });
        await prisma.run.update({ where: { id: run.id }, data: { pid } });
        return reply.code(201).send({ runId: run.id, pid, elevated: false });
      } catch (err) {
        await prisma.run.update({
          where: { id: run.id },
          data: { status: 'error', endedAt: new Date() },
        });
        return reply.code(500).send({ error: `Failed to open shell: ${String(err)}` });
      }
    },
  );

  // Open an interactive Claude Code session in the project dir. `continue: true`
  // resumes the most recent conversation in that dir (`claude --continue`) and
  // skips the /effort injection so the restored session is left untouched.
  app.post<{ Params: { id: string }; Body: { effort?: string; setEffort?: boolean; continue?: boolean } }>(
    '/api/projects/:id/claude',
    async (req, reply) => {
      const project = await prisma.project.findUnique({ where: { id: req.params.id } });
      if (!project) return reply.code(404).send({ error: 'Project not found.' });

      const resume = req.body?.continue === true;
      // Sanitize the effort level (slash-command arg) — word chars only.
      const raw = typeof req.body?.effort === 'string' ? req.body.effort.trim() : 'ultracode';
      const effort = /^[a-zA-Z0-9-]{1,32}$/.test(raw) ? raw : 'ultracode';
      const setEffort = req.body?.setEffort !== false; // default on

      const run = await prisma.run.create({
        data: { projectId: project.id, kind: 'claude', dockOpen: true, status: 'running' },
      });

      try {
        const { pid } = startClaude({
          runId: run.id,
          cwd: project.path,
          resume,
          initInput: resume ? undefined : setEffort ? `/effort ${effort}` : undefined,
        });
        await prisma.run.update({ where: { id: run.id }, data: { pid } });
        return reply.code(201).send({ runId: run.id, pid });
      } catch (err) {
        await prisma.run.update({
          where: { id: run.id },
          data: { status: 'error', endedAt: new Date() },
        });
        return reply.code(500).send({ error: `Failed to start Claude Code: ${String(err)}` });
      }
    },
  );

  // Stop a running process.
  app.post<{ Params: { runId: string } }>('/api/runs/:runId/stop', async (req, reply) => {
    const run = await prisma.run.findUnique({ where: { id: req.params.runId } });
    if (!run) return reply.code(404).send({ error: 'Run not found.' });

    const stopped = stopRun(run.id);
    if (!stopped && run.status === 'running') {
      // Process already gone but DB still says running — reconcile.
      await prisma.run.update({
        where: { id: run.id },
        data: { status: 'killed', endedAt: new Date() },
      });
    }
    return { ok: true, stopped };
  });

  // Close a workspace tab: stop the pty (if live) and drop it from the dock so
  // it won't be restored on reopen. The Run row + logs stay for history.
  app.post<{ Params: { runId: string } }>('/api/runs/:runId/close', async (req, reply) => {
    const run = await prisma.run.findUnique({ where: { id: req.params.runId } });
    if (!run) return reply.code(404).send({ error: 'Run not found.' });
    const stopped = stopRun(run.id); // best-effort; fine if already dead
    await prisma.run.update({ where: { id: run.id }, data: { dockOpen: false } });
    return { ok: true, stopped };
  });

  // Persist a tab's custom name (blank clears it).
  app.post<{ Params: { runId: string }; Body: { name?: string } }>(
    '/api/runs/:runId/name',
    async (req, reply) => {
      const run = await prisma.run.findUnique({ where: { id: req.params.runId } });
      if (!run) return reply.code(404).send({ error: 'Run not found.' });
      const raw = typeof req.body?.name === 'string' ? req.body.name.trim() : '';
      const name = raw ? raw.slice(0, 80) : null;
      await prisma.run.update({ where: { id: run.id }, data: { name } });
      return { ok: true, name };
    },
  );

  // Restart a closed/ended tab: spawn a FRESH process of the same kind (clean
  // logs, new runId), carrying over the custom name, and close the old row.
  // For a Claude tab, `continue: true` resumes the most recent conversation in
  // the project dir (`claude --continue`) instead of starting blank.
  app.post<{ Params: { runId: string }; Body: { continue?: boolean } }>('/api/runs/:runId/restart', async (req, reply) => {
    const resume = req.body?.continue === true;
    const old = await prisma.run.findUnique({
      where: { id: req.params.runId },
      include: { command: true, project: true },
    });
    if (!old) return reply.code(404).send({ error: 'Run not found.' });

    const project = old.project;
    const run = await prisma.run.create({
      data: {
        projectId: project.id,
        commandId: old.commandId,
        kind: old.kind,
        name: old.name,
        dockOpen: true,
        status: 'running',
      },
    });

    try {
      let pid: number;
      if (old.kind === 'shell') {
        // Reopen the same shell type: the kind is encoded in the Run name.
        ({ pid } = startShell({
          runId: run.id,
          cwd: project.path,
          kind: shellKindFromLabel(old.name),
        }));
      } else if (old.kind === 'claude') {
        ({ pid } = startClaude({
          runId: run.id,
          cwd: project.path,
          resume,
          initInput: resume ? undefined : '/effort ultracode',
        }));
      } else {
        if (!old.command) {
          await prisma.run.delete({ where: { id: run.id } }).catch(() => undefined);
          return reply.code(400).send({ error: 'The original command no longer exists.' });
        }
        ({ pid } = startRun({
          runId: run.id,
          command: old.command.command,
          cwd: old.command.cwd || project.path,
        }));
      }
      await prisma.run.update({ where: { id: run.id }, data: { pid } });
      await prisma.run.update({ where: { id: old.id }, data: { dockOpen: false } });

      return reply.code(201).send({
        runId: run.id,
        projectId: project.id,
        projectName: project.name,
        kind: run.kind,
        name: run.name,
        label: run.kind === 'command' ? old.command?.label ?? 'command' : run.kind,
        pid,
      });
    } catch (err) {
      await prisma.run
        .update({ where: { id: run.id }, data: { status: 'error', endedAt: new Date() } })
        .catch(() => undefined);
      return reply.code(500).send({ error: `Failed to restart: ${String(err)}` });
    }
  });

  // Run details + persisted logs (for reconnecting to history).
  app.get<{ Params: { runId: string } }>('/api/runs/:runId', async (req, reply) => {
    const run = await prisma.run.findUnique({
      where: { id: req.params.runId },
      include: {
        logs: { orderBy: { ts: 'asc' } },
        command: true,
        project: true,
      },
    });
    if (!run) return reply.code(404).send({ error: 'Run not found.' });
    return { ...run, live: isRunning(run.id) };
  });

  // Diagnose a failed run via `claude -p` (nice-to-have).
  app.post<{ Params: { runId: string } }>('/api/runs/:runId/diagnose', async (req, reply) => {
    const run = await prisma.run.findUnique({
      where: { id: req.params.runId },
      include: { logs: { orderBy: { ts: 'asc' } }, command: true, project: true },
    });
    if (!run) return reply.code(404).send({ error: 'Run not found.' });

    const output = run.logs.map((l) => l.chunk).join('');
    const command = run.command?.command ?? '(unknown command)';

    try {
      const explanation = await diagnoseRun(run.project.path, command, output);
      return { explanation };
    } catch (err) {
      if (err instanceof AnalyzerError) {
        return reply.code(502).send({ error: err.message });
      }
      return reply.code(500).send({ error: 'Diagnose failed.', detail: String(err) });
    }
  });
}
