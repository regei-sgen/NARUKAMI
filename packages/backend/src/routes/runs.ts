import fs from 'node:fs';
import path from 'node:path';
import type { FastifyInstance } from 'fastify';
import { prisma } from '../db';
import { TOKEN_FILE } from '../config';
import { isRunning, startClaude, startRun, startShell, stopRun } from '../services/runner';
import { startAdminShell } from '../services/brokerServer';
import { AnalyzerError, diagnoseRun } from '../services/analyzer';

// Append one session-wrap-up record as a JSON line. Deterministic capture that
// survives even if the Claude session ignores the injected prompt. Lives next to
// the token file so it lands in the repo root on a repo install and in the
// Electron userData dir for the packaged desktop app. Throwing is the caller's
// problem to swallow — the wrap-up/close flow must never be blocked by a
// log-write failure (disk full, perms, etc.).
function appendWrapupLog(entry: {
  runId: string;
  projectId: string | null;
  projectName: string | null;
  kind: string;
  label: string | null;
  verdict: string;
  notes: string;
}): void {
  const dir = path.join(path.dirname(TOKEN_FILE), 'logs');
  fs.mkdirSync(dir, { recursive: true });
  const line = JSON.stringify({ ts: new Date().toISOString(), ...entry }) + '\n';
  fs.appendFileSync(path.join(dir, 'session-wrapups.jsonl'), line, 'utf8');
}

// Effort injected into fresh Claude tabs when the caller doesn't pick one.
// `ultracode` = xhigh + dynamic workflow fan-out — maximum thoroughness, by
// the owner's explicit choice. Its parallel subagents' tool storms are the
// dominant CPU cost of a busy Claude tab (NARUKAMI's own runtime is ~1%), so
// anyone chasing "NARUKAMI CPU usage" should look here first, not at the
// streaming pipeline. One constant so launch and restart can never disagree.
const DEFAULT_CLAUDE_EFFORT = 'ultracode';

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
        const shell = cmd.shell === 'cmd' ? 'cmd' : 'powershell';
        const { pid } = startRun({ runId: run.id, command: cmd.command, cwd, shell });
        await prisma.run.update({ where: { id: run.id }, data: { pid } });
        return reply.code(201).send({ runId: run.id, pid });
      } catch (err) {
        // dockOpen:false so a run that never actually started isn't restored as
        // a permanent phantom dead tab on the next workspace reload.
        await prisma.run.update({
          where: { id: run.id },
          data: { status: 'error', endedAt: new Date(), dockOpen: false },
        });
        return reply.code(500).send({ error: `Failed to start process: ${String(err)}` });
      }
    },
  );

  // Open an interactive shell (PowerShell / cmd / $SHELL) rooted at the project
  // dir. `shell: 'cmd'` (Windows only) opens cmd.exe instead of PowerShell.
  // `admin: true` (Windows only) opens an ELEVATED shell via the broker: it fires
  // a UAC prompt and the run goes live once the elevated agent connects back.
  app.post<{ Params: { id: string }; Body: { admin?: boolean; shell?: string } }>(
    '/api/projects/:id/shell',
    async (req, reply) => {
      const project = await prisma.project.findUnique({ where: { id: req.params.id } });
      if (!project) return reply.code(404).send({ error: 'Project not found.' });

      const admin = req.body?.admin === true;
      if (admin && process.platform !== 'win32') {
        return reply.code(400).send({ error: 'Admin shells are only supported on Windows.' });
      }
      const shell = req.body?.shell === 'cmd' ? 'cmd' : 'powershell';

      const run = await prisma.run.create({
        // Name cmd tabs "cmd" so the dock distinguishes them from PowerShell;
        // `shell` is the durable marker (a rename can overwrite the name).
        data: {
          projectId: project.id,
          kind: 'shell',
          name: shell === 'cmd' ? 'cmd' : null,
          shell,
          dockOpen: true,
          status: 'running',
        },
      });

      try {
        if (admin) {
          // No local pid — elevation is async. The tab shows "waiting for UAC"
          // until the broker connects (then /api/runs/:id reports live=true).
          // Admin shells are always PowerShell (the broker's contract).
          await startAdminShell({ runId: run.id, cwd: project.path });
          return reply.code(201).send({ runId: run.id, elevated: true, pending: true });
        }
        const { pid } = startShell({ runId: run.id, cwd: project.path, shell });
        await prisma.run.update({ where: { id: run.id }, data: { pid } });
        return reply.code(201).send({ runId: run.id, pid, elevated: false });
      } catch (err) {
        await prisma.run.update({
          where: { id: run.id },
          data: { status: 'error', endedAt: new Date(), dockOpen: false },
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
      const raw =
        typeof req.body?.effort === 'string' ? req.body.effort.trim() : DEFAULT_CLAUDE_EFFORT;
      const effort = /^[a-zA-Z0-9-]{1,32}$/.test(raw) ? raw : DEFAULT_CLAUDE_EFFORT;
      const setEffort = req.body?.setEffort !== false; // default on

      // "Continue" resumes THIS project's most recent NARUKAMI Claude session by
      // its stored id — never `claude --continue`, which would reopen whatever
      // conversation was last touched in the folder (possibly a native-CLI one).
      let resumeSessionId: string | undefined;
      if (resume) {
        const prior = await prisma.run.findFirst({
          where: { projectId: project.id, kind: 'claude', claudeSessionId: { not: null } },
          orderBy: { startedAt: 'desc' },
          select: { claudeSessionId: true },
        });
        resumeSessionId = prior?.claudeSessionId ?? undefined;
      }

      const run = await prisma.run.create({
        data: { projectId: project.id, kind: 'claude', dockOpen: true, status: 'running' },
      });

      try {
        const { pid, sessionId } = startClaude({
          runId: run.id,
          cwd: project.path,
          resumeSessionId,
          embedCodeMap: project.codeMapEmbed,
          initInput: resume ? undefined : setEffort ? `/effort ${effort}` : undefined,
        });
        await prisma.run.update({
          where: { id: run.id },
          data: { pid, claudeSessionId: sessionId },
        });
        return reply.code(201).send({ runId: run.id, pid, sessionId });
      } catch (err) {
        await prisma.run.update({
          where: { id: run.id },
          data: { status: 'error', endedAt: new Date(), dockOpen: false },
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

  // Record a forced session wrap-up (verdict + optional notes) before a claude
  // tab's Stop/close actually ends the session. This is the deterministic capture
  // that survives even if the session ignores the injected wrap-up prompt. The
  // log write is fully fail-soft: any error is swallowed so the close flow (which
  // the frontend runs in parallel) is never blocked by a bad disk/perms state.
  app.post<{ Params: { runId: string }; Body: { verdict?: string; notes?: string } }>(
    '/api/runs/:runId/wrapup',
    async (req, reply) => {
      const run = await prisma.run.findUnique({
        where: { id: req.params.runId },
        include: { project: true },
      });
      if (!run) return reply.code(404).send({ error: 'Run not found.' });

      const rawVerdict =
        typeof req.body?.verdict === 'string' ? req.body.verdict.trim().toLowerCase() : '';
      const verdict =
        rawVerdict === 'successful'
          ? 'successful'
          : rawVerdict === 'unsuccessful'
            ? 'unsuccessful'
            : 'unspecified';
      const notes = typeof req.body?.notes === 'string' ? req.body.notes.slice(0, 4000) : '';

      try {
        appendWrapupLog({
          runId: run.id,
          projectId: run.projectId,
          projectName: run.project?.name ?? null,
          kind: run.kind,
          label: run.name ?? run.kind,
          verdict,
          notes,
        });
      } catch {
        // Never block the close flow on a log-write failure.
      }

      return { ok: true, verdict };
    },
  );

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

    // Stop the old pty if it's still live BEFORE spawning the replacement.
    // Without this, restarting a still-running tab orphaned the old process
    // (kept running, detached and unreachable) — and a server run would fail the
    // new spawn with EADDRINUSE. No-op if the old run already ended.
    stopRun(old.id);

    const project = old.project;
    const run = await prisma.run.create({
      data: {
        projectId: project.id,
        commandId: old.commandId,
        kind: old.kind,
        name: old.name,
        shell: old.shell,
        dockOpen: true,
        status: 'running',
      },
    });

    try {
      let pid: number;
      let claudeSessionId: string | undefined;
      if (old.kind === 'shell') {
        // A cmd shell tab restarts as cmd, not PowerShell.
        ({ pid } = startShell({
          runId: run.id,
          cwd: project.path,
          shell: old.shell === 'cmd' ? 'cmd' : 'powershell',
        }));
      } else if (old.kind === 'claude') {
        // Resume reopens exactly THIS tab's own prior Claude session by id — so a
        // restarted Claude tab continues its own conversation, never a native one.
        const started = startClaude({
          runId: run.id,
          cwd: project.path,
          resumeSessionId: resume ? old.claudeSessionId ?? undefined : undefined,
          embedCodeMap: project.codeMapEmbed,
          initInput: resume ? undefined : `/effort ${DEFAULT_CLAUDE_EFFORT}`,
        });
        pid = started.pid;
        claudeSessionId = started.sessionId;
      } else {
        if (!old.command) {
          await prisma.run.delete({ where: { id: run.id } }).catch(() => undefined);
          return reply.code(400).send({ error: 'The original command no longer exists.' });
        }
        ({ pid } = startRun({
          runId: run.id,
          command: old.command.command,
          cwd: old.command.cwd || project.path,
          shell: old.command.shell === 'cmd' ? 'cmd' : 'powershell',
        }));
      }
      // `claudeSessionId` is undefined for shell/command runs → Prisma leaves it null.
      await prisma.run.update({ where: { id: run.id }, data: { pid, claudeSessionId } });
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
        .update({
          where: { id: run.id },
          data: { status: 'error', endedAt: new Date(), dockOpen: false },
        })
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
