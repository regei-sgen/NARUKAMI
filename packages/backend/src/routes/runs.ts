import fs from 'node:fs';
import path from 'node:path';
import type { FastifyInstance } from 'fastify';
import { prisma } from '../db';
import { isRunning, startClaude, startRun, startShell, stopRun } from '../services/runner';
import { startAdminShell } from '../services/brokerServer';
import { AnalyzerError, diagnoseRun } from '../services/analyzer';
import { DEFAULT_EFFORT, cachedAiConfig } from '../services/aiProvider';
import { claudeDir } from '../services/argus';

// Effort injected into fresh Claude tabs when the caller doesn't pick one.
// Shipped default `ultracode` = xhigh + dynamic workflow fan-out — maximum
// thoroughness. Its parallel subagents' tool storms are the dominant CPU cost of
// a busy Claude tab (NARUKAMI's own runtime is ~1%), so anyone chasing "NARUKAMI
// CPU usage" should look here first, not at the streaming pipeline — turning it
// down in Settings → AI provider is the lever. One accessor so launch and
// restart can never disagree.
function defaultClaudeEffort(): string {
  return cachedAiConfig().defaultEffort || DEFAULT_EFFORT;
}

/**
 * Does Claude Code still hold the transcript for `sessionId` in `cwd`?
 *
 * Transcripts live at `<claudeDir>/projects/<cwd, every non-alphanumeric char
 * replaced by '-'>/<sessionId>.jsonl` — the tree eodSessions.ts walks (see
 * decodeProjectDir in argus.ts for the inverse mapping).
 *
 * FAIL-OPEN by design: it returns false ONLY when the project's transcript dir
 * is readable and the file is genuinely absent. Any uncertainty (no ~/.claude,
 * an encoded dir name we can't derive) returns true, so a wrong guess here can
 * never turn a working Continue into a surprise fresh session — it can only fail
 * to catch a pruned one.
 */
export function claudeTranscriptExists(cwd: string, sessionId: string): boolean {
  // Session ids are minted with randomUUID; anything else can't be trusted into
  // a path join, and starting fresh is the safe answer for it.
  if (!/^[A-Za-z0-9-]{8,64}$/.test(sessionId)) return false;
  const dir = path.join(claudeDir(), 'projects', cwd.replace(/[^A-Za-z0-9]/g, '-'));
  try {
    if (!fs.statSync(dir).isDirectory()) return true;
  } catch {
    return true; // can't look → don't interfere
  }
  return fs.existsSync(path.join(dir, `${sessionId}.jsonl`));
}

// Bounded RunLog replay. The full history of a long-lived tab was measured at
// 2.3 MB / 3k rows, and every consumer either repaints it into xterm's
// 5000-line scrollback or ignores it entirely — so cap the replay at roughly
// that scrollback (5000 × ~80 cols) and read it newest-first in pages, stopping
// as soon as the budget is met. 200 rows is ~90 KB of real logs (≈440 B per
// flushed chunk), so a normal reply is ONE query.
const MAX_REPLAY_CHARS = 400_000;
// diagnoseRun only ever prompts with output.slice(-12000); reading the whole
// table to throw all but the last 12 KB away is pure waste.
const DIAGNOSE_CHARS = 64_000;
const LOG_PAGE = 200;
const MAX_LOG_PAGES = 20;

interface LogRow {
  id: string;
  runId: string;
  chunk: string;
  ts: Date;
}

/**
 * The tail of a run's persisted logs in chronological order, bounded to
 * `maxChars`. `truncated` means the budget stopped the walk — i.e. earlier
 * output exists and is NOT in the result, which the caller must make visible
 * rather than silently pass off as the whole history.
 */
async function tailLogs(
  runId: string,
  maxChars: number,
): Promise<{ logs: LogRow[]; truncated: boolean }> {
  const out: LogRow[] = [];
  let chars = 0;
  for (let page = 0; page < MAX_LOG_PAGES; page += 1) {
    const rows = (await prisma.runLog.findMany({
      where: { runId },
      // Secondary sort on the (monotonic) cuid so identical timestamps can't
      // make the pages overlap or skip a row.
      orderBy: [{ ts: 'desc' }, { id: 'desc' }],
      skip: page * LOG_PAGE,
      take: LOG_PAGE,
    })) as LogRow[];
    for (const r of rows) {
      out.push(r);
      chars += r.chunk.length;
      if (chars >= maxChars) return { logs: out.reverse(), truncated: true };
    }
    if (rows.length < LOG_PAGE) return { logs: out.reverse(), truncated: false };
  }
  return { logs: out.reverse(), truncated: true };
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
      const fallback = defaultClaudeEffort();
      const raw = typeof req.body?.effort === 'string' ? req.body.effort.trim() : fallback;
      const effort = /^[a-zA-Z0-9-]{1,32}$/.test(raw) ? raw : fallback;
      const setEffort = req.body?.setEffort !== false; // default on

      // "Continue" resumes THIS project's most recent NARUKAMI Claude session by
      // its stored id — never `claude --continue`, which would reopen whatever
      // conversation was last touched in the folder (possibly a native-CLI one).
      let resumeSessionId: string | undefined;
      let staleSession = false;
      if (resume) {
        const prior = await prisma.run.findFirst({
          where: { projectId: project.id, kind: 'claude', claudeSessionId: { not: null } },
          orderBy: { startedAt: 'desc' },
          select: { id: true, claudeSessionId: true },
        });

        // A LIVE tab still owns that session and is writing its transcript.
        // Resuming it would spawn a second `claude --resume <same id>` against
        // that same conversation and persist the id on a second Run row — two
        // rows, two ptys, one session. Refuse and name the tab to focus. (The
        // restart route gets this right the other way: it stops the old pty
        // BEFORE reusing the id.)
        if (prior && isRunning(prior.id)) {
          return reply.code(409).send({
            error: 'That Claude session is already open in a live tab — switch to it, or start a new Claude tab.',
            runId: prior.id,
            sessionId: prior.claudeSessionId,
          });
        }

        // buildClaudeArgs emits `--resume <id>` unconditionally with no fallback,
        // so a pruned transcript kills the tab on spawn with a raw CLI error.
        // Check the file first and fall through to a fresh session when it's gone.
        if (prior?.claudeSessionId) {
          if (claudeTranscriptExists(project.path, prior.claudeSessionId)) {
            resumeSessionId = prior.claudeSessionId;
          } else {
            staleSession = true;
          }
        }
      }

      const run = await prisma.run.create({
        data: { projectId: project.id, kind: 'claude', dockOpen: true, status: 'running' },
      });

      try {
        const { pid, sessionId } = startClaude({
          runId: run.id,
          cwd: project.path,
          resumeSessionId,
          // Keyed off the RESOLVED id, not the request: a Continue that fell
          // through to a fresh session is a fresh session and gets the effort
          // injection like any other; only a real resume is left untouched.
          initInput: resumeSessionId ? undefined : setEffort ? `/effort ${effort}` : undefined,
        });
        await prisma.run.update({
          where: { id: run.id },
          data: { pid, claudeSessionId: sessionId },
        });
        return reply.code(201).send({
          runId: run.id,
          pid,
          sessionId,
          ...(resume ? { resumed: Boolean(resumeSessionId) } : {}),
          ...(staleSession
            ? { notice: 'The previous Claude session is no longer on disk — started a fresh one.' }
            : {}),
        });
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
          initInput: resume ? undefined : `/effort ${defaultClaudeEffort()}`,
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

  // Run details + persisted logs (for reconnecting to history). The replay is
  // BOUNDED (see tailLogs) — the old query returned every RunLog row, and this
  // route is hit on every Claude tab mount, every reconnect and in the UAC poll
  // loop. `?logs=0` skips the log query entirely, for the callers that only want
  // the row itself (the claudeSessionId lookup, the liveness poll).
  app.get<{ Params: { runId: string }; Querystring: { logs?: string } }>(
    '/api/runs/:runId',
    async (req, reply) => {
      const raw = String(req.query?.logs ?? '').toLowerCase();
      const wantLogs = !(raw === '0' || raw === 'false' || raw === 'none');

      const run = await prisma.run.findUnique({
        where: { id: req.params.runId },
        include: { command: true, project: true },
      });
      if (!run) return reply.code(404).send({ error: 'Run not found.' });
      if (!wantLogs) return { ...run, logsOmitted: true, live: isRunning(run.id) };

      const { logs, truncated } = await tailLogs(run.id, MAX_REPLAY_CHARS);
      // Make the cut visible: consumers concatenate these chunks straight into a
      // terminal, and silently dropping the head would read as lost output.
      if (truncated) {
        logs.unshift({
          id: `${run.id}:truncated`,
          runId: run.id,
          chunk: '\x1b[90m[earlier output truncated]\x1b[0m\r\n',
          ts: logs[0]?.ts ?? new Date(),
        });
      }
      return { ...run, logs, logsTruncated: truncated, live: isRunning(run.id) };
    },
  );

  // Diagnose a failed run via `claude -p` (nice-to-have).
  app.post<{ Params: { runId: string } }>('/api/runs/:runId/diagnose', async (req, reply) => {
    const run = await prisma.run.findUnique({
      where: { id: req.params.runId },
      include: { command: true, project: true },
    });
    if (!run) return reply.code(404).send({ error: 'Run not found.' });

    const { logs } = await tailLogs(run.id, DIAGNOSE_CHARS);
    const output = logs.map((l) => l.chunk).join('');
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
