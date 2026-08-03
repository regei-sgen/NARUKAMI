import { randomUUID } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import * as pty from 'node-pty';
import { Prisma } from '../generated/prisma';
import { prisma } from '../db';
import { buildClaudeMcpArgs, cleanupMcpConfig } from './mcpConfig';
import { claudeSpawnEnv } from './aiProvider';
import { godSpawnEnv } from './godclaude';
import { resolveExecutable, wrapForWindows } from './exec';
// The ONE liveness primitive (process.kill(pid, 0), EPERM => alive-but-not-ours).
// instanceLock.ts owns it; reconcileStaleRuns below is its second consumer.
import { pidAlive } from './instanceLock';

// Re-exported for callers/tests that import it from the runner module.
export { resolveExecutable } from './exec';

export type RunFinalStatus = 'exited' | 'killed' | 'error';

export type RunnerEvent =
  | { type: 'data'; chunk: string }
  // The pty grid changed (any attached client resized it). Broadcast so every
  // OTHER attached view can adopt the same grid — one pty has ONE size, and a
  // desktop and a phone mirroring the same run must agree on it or both render
  // mis-wrapped output.
  | { type: 'resize'; cols: number; rows: number }
  | { type: 'exit'; status: RunFinalStatus; exitCode: number | null };

type Subscriber = (event: RunnerEvent) => void;

/**
 * Everything a managed run needs from its underlying process, regardless of
 * whether that process is a local node-pty (normal runs) or an elevated PTY
 * hosted by a separate admin broker and piped over a loopback socket (admin
 * shells). Decoupling the run bookkeeping from node-pty lets both share the same
 * streaming / persistence / attach machinery.
 */
export interface RunTransport {
  readonly pid: number;
  write(data: string): void;
  resize(cols: number, rows: number): void;
  kill(): void;
  onData(cb: (chunk: string) => void): void;
  onExit(cb: (info: { exitCode: number | null }) => void): void;
}

/** Wrap a local node-pty process as a RunTransport. `args` may be a verbatim
 * command-line STRING: node-pty's argv→string join escapes quotes with CRT
 * backslash rules, which cmd.exe's parser does not understand — so cmd
 * invocations must bypass the join entirely (see shellFor).
 *
 * `extraEnv` is a per-launch overlay applied LAST (it wins over the inherited
 * environment). Only Claude launches pass one — see startClaude. */
function ptyTransport(
  file: string,
  args: string | string[],
  cwd: string,
  extraEnv: Record<string, string> = {},
): RunTransport {
  const proc = pty.spawn(file, args, {
    name: 'xterm-color',
    cols: 80,
    rows: 30,
    cwd,
    env: spawnEnv(extraEnv),
  });
  return {
    pid: proc.pid,
    write: (data) => proc.write(data),
    resize: (cols, rows) => proc.resize(cols, rows),
    kill: () => proc.kill(),
    onData: (cb) => {
      proc.onData(cb);
    },
    onExit: (cb) => {
      proc.onExit(({ exitCode }) => cb({ exitCode: exitCode ?? null }));
    },
  };
}

interface ManagedRun {
  runId: string;
  transport: RunTransport;
  subscribers: Set<Subscriber>;
  killedByUser: boolean;
  /** A kill was already issued — never call transport.kill() twice (see stopRun). */
  killIssued: boolean;
  /** Un-persisted chunks awaiting a DB flush. */
  logBuffer: string[];
  flushTimer: NodeJS.Timeout | null;
  /** In-flight flush, if any — flushes are serialized through it (see flushLogs). */
  flushing: Promise<void> | null;
  /** Consecutive transient flush failures (drives the retry backoff + cap). */
  flushAttempts: number;
  /** Pty chunks not yet fanned out — micro-batched (see BATCH_MS). */
  pendingChunks: string[];
  pendingChars: number;
  batchTimer: NodeJS.Timeout | null;
  /**
   * Date.now() of the last output batch drained to subscribers; null until the
   * pty has produced a byte. A NUMBER, stamped on the drain path and never
   * persisted: idle detection has to be free on the hot path, and this file
   * already writes one RunLog row per 300ms batch — a per-chunk Date or DB write
   * would be pure amplification.
   */
  lastOutputAt: number | null;
  /** In-memory rolling transcript (capped) for gap-free live (re)connects. */
  transcript: string[];
  transcriptChars: number;
  /** Current pty grid (spawn default until a client resizes it). */
  cols: number;
  rows: number;
  exited: boolean;
  finalStatus: RunFinalStatus | null;
  finalExitCode: number | null;
}

const runs = new Map<string, ManagedRun>();

const LOG_FLUSH_MS = 300;
// Micro-batch pty output before fan-out. ConPTY emits a storm of small chunks
// under load, and forwarding each one costs a JSON.stringify + ws frame on the
// backend plus a parse + xterm write on the frontend — per chunk, per shell.
// Coalescing for a few ms collapses that to a handful of larger messages while
// staying well under a frame of added echo latency. The size cap bounds memory
// and keeps a single message comfortably inside one ws frame.
const BATCH_MS = 8;
const BATCH_MAX_CHARS = 256 * 1024;
// Cap the in-memory transcript so a chatty long-lived run can't grow unbounded.
// The DB still holds the full history for post-mortem; live reconnects see the tail.
const MAX_TRANSCRIPT_CHARS = 2_000_000;
// Same idea for the UN-PERSISTED log buffer, which normally holds a single 300ms
// batch: if the DB keeps rejecting writes the chunks stay buffered (deliberately —
// see flushLogs) and nothing else bounds them.
const MAX_LOG_BUFFER_CHARS = 2_000_000;
// A transient flush failure (SQLITE_BUSY) is retried with exponential backoff and
// then abandoned. The old path rescheduled at a flat 300ms with no attempt limit,
// so a permanently failing write left a timer firing — and the whole ManagedRun
// retained — for the rest of the process's life.
export const MAX_FLUSH_ATTEMPTS = 4;

/** Which Windows shell a command / terminal should use. Ignored on POSIX. */
export type ShellKind = 'powershell' | 'cmd';

/** Pick a shell + args that run `command` and stay attached to the pty. */
export function shellFor(command: string, shell: ShellKind = 'powershell'): { file: string; args: string | string[] } {
  if (process.platform === 'win32') {
    if (shell === 'cmd') {
      // /d: skip AutoRun; /s: strip the outer quotes only; /c: run + exit.
      // A verbatim STRING, not an argv array: node-pty would join an array
      // with CRT quote-escaping (\" ) that cmd.exe cannot parse, corrupting
      // any command containing double quotes.
      return { file: 'cmd.exe', args: `/d /s /c "${command}"` };
    }
    // Prefer PowerShell 7+ (pwsh): it supports `&&` / `||` command chaining that
    // Windows PowerShell 5.1 (powershell.exe) PARSE-ERRORS on — very common in
    // detected/custom run commands. Fall back to powershell.exe when pwsh isn't
    // installed. (POSIX `VAR=val cmd` env prefixes still aren't supported by
    // either PowerShell — that's a separate shell-syntax limitation.)
    const pwsh = resolveExecutable('pwsh');
    const file = pwsh !== 'pwsh' ? pwsh : 'powershell.exe';
    return { file, args: ['-NoLogo', '-NoProfile', '-Command', command] };
  }
  const posixShell = process.env.SHELL || 'bash';
  return { file: posixShell, args: ['-lc', command] };
}

// NARUKAMI-internal / secret-bearing env vars that must NOT leak into the
// (untrusted) project commands, shells, and Claude sessions we spawn. A project's
// postinstall/dev script would otherwise inherit the path to the bearer token
// (RUNNER_TOKEN_FILE), the DB URL, and the backend's own PORT (which would also
// make a child dev server try to bind the backend's port).
const ENV_DENYLIST = new Set([
  'DATABASE_URL',
  'RUNNER_TOKEN_FILE',
  'PORT',
  // A backend launched from INSIDE a Claude Code session inherits that session's
  // id; NARUKAMI terminals are not part of that session, and a leaked id would
  // silently re-scope godmode CLI calls to a phantom session overlay.
  'CLAUDE_CODE_SESSION_ID',
  // Its twin. Claude Code stamps CLAUDE_CODE_CHILD_SESSION=1 on every process it
  // spawns so a NESTED claude knows not to write a competing transcript. A Claude-
  // launched backend inherits it, so without this the `claude` in every NARUKAMI
  // terminal — a genuine top-level session — sees the marker and disables
  // transcript persistence: no session file, and --resume cannot find that tab.
  // Verified 2026-08-03 against claude.exe v2.1.220, whose own guard is
  // `if (!(CLAUDE_CODE_CHILD_SESSION && ...)) return false`, overridden only by
  // CLAUDE_CODE_FORCE_SESSION_PERSISTENCE. Claude Code strips this exact var
  // itself before spawning MCP stdio servers, for the same reason.
  'CLAUDE_CODE_CHILD_SESSION',
  // The GODCLAUDE state home is decided by godSpawnEnv() alone (below), which
  // returns {} while the embedded layer is unprovisioned. An INHERITED value
  // would otherwise survive into every spawned process and point it at a god
  // home NARUKAMI never installed — the opposite of the documented fail-open
  // "an uninstalled layer changes nothing about spawned sessions".
  'DET_HOOKS_HOME',
]);
const ENV_DENY_PREFIXES = ['NARUKAMI_', 'PRISMA_'];

/** process.env minus undefined values and NARUKAMI-internal/secret vars. */
export function cleanEnv(): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(process.env)) {
    if (typeof v !== 'string') continue;
    if (ENV_DENYLIST.has(k)) continue;
    if (ENV_DENY_PREFIXES.some((p) => k.startsWith(p))) continue;
    out[k] = v;
  }
  return out;
}

/**
 * The full environment for a spawned process: the sanitized parent env, then the
 * GODCLAUDE overlay (godSpawnEnv points the layer's state home at NARUKAMI's own
 * embedded god home, so Claude sessions and `godmode.mjs` invocations in NARUKAMI
 * terminals use NARUKAMI's godclaude — never the native ~/.claude), then the
 * per-launch overlay. Order matters: the INTENDED embedded home must win over an
 * inherited one, and only the Claude launch path passes `extraEnv`.
 */
export function spawnEnv(extraEnv: Record<string, string> = {}): Record<string, string> {
  return { ...cleanEnv(), ...godSpawnEnv(), ...extraEnv };
}

/**
 * Push `chunk` onto `transcript`, dropping oldest chunks until the total char
 * count is within `max`. Mutates `transcript`; returns the new total. Pure logic
 * (no I/O) so it can be unit-tested directly.
 */
export function capTranscript(
  transcript: string[],
  chars: number,
  chunk: string,
  max: number = MAX_TRANSCRIPT_CHARS,
): number {
  transcript.push(chunk);
  let total = chars + chunk.length;
  while (total > max && transcript.length > 1) {
    const dropped = transcript.shift();
    if (dropped) total -= dropped.length;
  }
  return total;
}

function appendTranscript(m: ManagedRun, chunk: string): void {
  m.transcriptChars = capTranscript(m.transcript, m.transcriptChars, chunk);
}

/**
 * Synchronously drain the micro-batch buffer: append to the transcript, fan out
 * ONE coalesced data event to subscribers, and queue it for the DB flush.
 * Because this is synchronous, callers that need an up-to-date transcript
 * (attach, exit) flush first and see every byte exactly once.
 */
function flushPending(m: ManagedRun): void {
  if (m.batchTimer) {
    clearTimeout(m.batchTimer);
    m.batchTimer = null;
  }
  if (m.pendingChunks.length === 0) return;
  const chunk = m.pendingChunks.length === 1 ? m.pendingChunks[0] : m.pendingChunks.join('');
  m.pendingChunks.length = 0;
  m.pendingChars = 0;
  // The one synchronous point every pty byte passes through, and therefore the
  // only place "when did this terminal last speak" is knowable for free. Stamped
  // AFTER the early return above, so a reader that drains an empty buffer (see
  // getRunActivity/attach) can never make a quiet terminal look busy.
  m.lastOutputAt = Date.now();
  appendTranscript(m, chunk);
  // ONE event object shared by every subscriber, so the ws layer can serialize
  // the wire payload once per batch instead of once per attached socket.
  const event: RunnerEvent = { type: 'data', chunk };
  for (const sub of m.subscribers) sub(event);
  m.logBuffer.push(chunk);
  scheduleFlush(m);
}

function scheduleFlush(m: ManagedRun, delayMs: number = LOG_FLUSH_MS): void {
  if (m.flushTimer) return;
  m.flushTimer = setTimeout(() => {
    m.flushTimer = null;
    void flushLogs(m);
  }, delayMs);
}

/**
 * Drop the OLDEST buffered chunks until the un-flushed log buffer is within
 * `max` characters; returns how many were dropped. Mutates `buffer` and always
 * keeps at least one chunk, mirroring {@link capTranscript}. Pure (no I/O) so it
 * can be unit-tested directly.
 */
export function capLogBuffer(buffer: string[], max: number = MAX_LOG_BUFFER_CHARS): number {
  let total = 0;
  for (const c of buffer) total += c.length;
  let dropped = 0;
  while (total > max && buffer.length > 1) {
    const gone = buffer.shift();
    if (!gone) break;
    total -= gone.length;
    dropped += 1;
  }
  return dropped;
}

/** The referenced Run row no longer exists (record-not-found or FK failure). */
function isMissingRowError(err: unknown): boolean {
  return (
    err instanceof Prisma.PrismaClientKnownRequestError &&
    (err.code === 'P2025' || err.code === 'P2003')
  );
}

/**
 * Persist the buffered chunks, SERIALIZED per run.
 *
 * flushLogs has two independent callers — the 300ms timer and the exit path —
 * and flushOnce only splices the buffer AFTER the write commits (so a transient
 * DB error can't lose output). Left unserialized they interleave: the second
 * caller sees the chunks the first has already written but not yet spliced and
 * persists them a SECOND time. Nothing errors; the duplicate simply repaints when
 * the tab is restored. Chaining (rather than skipping) preserves the exit path's
 * guarantee that everything buffered is written before the run is forgotten.
 */
function flushLogs(m: ManagedRun): Promise<void> {
  const once = (): Promise<void> => flushOnce(m);
  const next = m.flushing ? m.flushing.then(once, once) : once();
  m.flushing = next;
  return next.finally(() => {
    if (m.flushing === next) m.flushing = null;
  });
}

async function flushOnce(m: ManagedRun): Promise<void> {
  if (m.flushTimer) {
    clearTimeout(m.flushTimer);
    m.flushTimer = null;
  }
  if (m.logBuffer.length === 0) return;
  // Bound the buffer BEFORE snapshotting: chunks are dropped from the front, and
  // doing that while a write is in flight would misalign the splice below (which
  // is by index). Only reachable when the DB has been failing for a while.
  const dropped = capLogBuffer(m.logBuffer);
  if (dropped > 0) {
    process.stderr.write(
      `[narukami] dropped ${dropped} un-persisted log chunk(s) for run ${m.runId} (buffer over cap)\n`,
    );
  }
  // Snapshot what we're flushing but DON'T clear the buffer yet — only drop these
  // chunks once the write is durable, so a transient DB error can't silently and
  // permanently lose terminal output. New chunks appended during the await sit
  // after index `count` and are preserved.
  const count = m.logBuffer.length;
  const chunk = m.logBuffer.slice(0, count).join('');
  try {
    await prisma.runLog.create({ data: { runId: m.runId, chunk } });
    m.logBuffer.splice(0, count);
    m.flushAttempts = 0;
  } catch (err) {
    if (isMissingRowError(err)) {
      // Run row gone (e.g. project deleted mid-run) — the chunk can never persist,
      // so drop it rather than retry forever.
      m.logBuffer.splice(0, count);
      m.flushAttempts = 0;
    } else {
      // Transient failure (e.g. SQLite busy) — keep the chunk buffered and retry
      // with backoff, up to a limit. Past the limit we stop TIMING retries but
      // keep the chunks: the next flush the run's own output triggers picks them
      // up again, and capLogBuffer bounds the memory in the meantime.
      m.flushAttempts += 1;
      if (m.flushAttempts >= MAX_FLUSH_ATTEMPTS) {
        m.flushAttempts = 0;
        process.stderr.write(
          `[narukami] log flush for run ${m.runId} failed ${MAX_FLUSH_ATTEMPTS}x, ` +
            `giving up on the retry timer: ${String(err)}\n`,
        );
        return;
      }
      scheduleFlush(m, LOG_FLUSH_MS * 2 ** (m.flushAttempts - 1));
    }
  }
}

export interface StartOptions {
  runId: string;
  command: string;
  cwd: string;
  /** Windows shell to run the command in (default PowerShell). */
  shell?: ShellKind;
}

/** A bare interactive shell (no command) — a project-scoped terminal. */
export function interactiveShell(shell: ShellKind = 'powershell'): { file: string; args: string[] } {
  if (process.platform === 'win32') {
    if (shell === 'cmd') return { file: 'cmd.exe', args: [] };
    return { file: 'powershell.exe', args: ['-NoLogo'] };
  }
  const posixShell = process.env.SHELL || 'bash';
  return { file: posixShell, args: ['-i'] };
}

/**
 * Wire a transport's streaming/persistence/exit handling and track it in the
 * run map. Shared by local-pty runs and admin-broker runs. Throws only if the
 * transport constructor itself threw before calling this.
 */
export function registerRun(runId: string, transport: RunTransport): void {
  const managed: ManagedRun = {
    runId,
    transport,
    subscribers: new Set(),
    killedByUser: false,
    killIssued: false,
    logBuffer: [],
    flushTimer: null,
    flushing: null,
    flushAttempts: 0,
    pendingChunks: [],
    pendingChars: 0,
    batchTimer: null,
    lastOutputAt: null,
    transcript: [],
    transcriptChars: 0,
    cols: 80, // both pty transports spawn at 80x30 (ptyTransport + admin broker)
    rows: 30,
    exited: false,
    finalStatus: null,
    finalExitCode: null,
  };
  runs.set(runId, managed);

  transport.onData((chunk) => {
    managed.pendingChunks.push(chunk);
    managed.pendingChars += chunk.length;
    if (managed.pendingChars >= BATCH_MAX_CHARS) {
      flushPending(managed);
    } else if (!managed.batchTimer) {
      managed.batchTimer = setTimeout(() => flushPending(managed), BATCH_MS);
    }
  });

  transport.onExit(({ exitCode }) => {
    if (managed.exited) return; // idempotent — a broker socket close + exit frame can race
    flushPending(managed); // drain the batch buffer so no tail bytes are lost
    managed.exited = true;
    managed.finalStatus = managed.killedByUser ? 'killed' : 'exited';
    managed.finalExitCode = exitCode ?? null;

    // Notify live clients immediately.
    const exitEvent: RunnerEvent = {
      type: 'exit',
      status: managed.finalStatus,
      exitCode: managed.finalExitCode,
    };
    for (const sub of managed.subscribers) sub(exitEvent);

    // Persist remaining logs + final status, THEN forget the run. Keeping the
    // record in the map until the DB write commits lets getFinalState() serve an
    // authoritative final status to any client that connects during this window.
    void (async () => {
      await flushLogs(managed);
      const data = {
        status: managed.finalStatus ?? 'exited',
        exitCode: managed.finalExitCode,
        endedAt: new Date(),
      };
      try {
        await prisma.run.update({ where: { id: runId }, data });
      } catch (err) {
        if (!isMissingRowError(err)) {
          // One retry, then surface it. If it still fails the row stays 'running'
          // in the DB until the next boot's reconcileStaleRuns flips it — but we
          // no longer swallow it silently (which left runs wrongly 'running' and
          // dropped from EOD).
          try {
            await prisma.run.update({ where: { id: runId }, data });
          } catch (err2) {
            process.stderr.write(
              `[narukami] failed to persist final status for run ${runId}: ${String(err2)}\n`,
            );
          }
        }
      }
      // A final flush that hit a transient error scheduled a retry timer. The
      // record is about to leave the map, so that timer would keep the whole
      // ManagedRun (transcript included) alive and firing with nothing able to
      // observe the result. Cancel it and make ONE last inline attempt instead,
      // so a momentary SQLITE_BUSY still persists the tail.
      if (managed.flushTimer) {
        clearTimeout(managed.flushTimer);
        managed.flushTimer = null;
        await new Promise((resolve) => setTimeout(resolve, LOG_FLUSH_MS));
        await flushLogs(managed);
        if (managed.flushTimer) {
          clearTimeout(managed.flushTimer);
          managed.flushTimer = null;
        }
      }
      runs.delete(runId);
      cleanupMcpConfig(runId); // remove the per-run MCP token file (no-op if none)
    })();
  });
}

/** Spawn a local pty, wire it up, and track it. Throws if spawn fails. */
function spawnManaged(
  runId: string,
  file: string,
  args: string | string[],
  cwd: string,
  extraEnv?: Record<string, string>,
): { pid: number } {
  const transport = ptyTransport(file, args, cwd, extraEnv);
  registerRun(runId, transport);
  return { pid: transport.pid };
}

/** Spawn a pty for `command`. Throws synchronously if the shell can't start. */
export function startRun(opts: StartOptions): { pid: number } {
  const { file, args } = shellFor(opts.command, opts.shell);
  return spawnManaged(opts.runId, file, args, opts.cwd);
}

/** Open a bare interactive shell (PowerShell / cmd / $SHELL) in `cwd`. */
export function startShell(opts: { runId: string; cwd: string; shell?: ShellKind }): { pid: number } {
  const { file, args } = interactiveShell(opts.shell);
  return spawnManaged(opts.runId, file, args, opts.cwd);
}

/** Remove ANSI escape sequences so text markers can be matched. */
export function stripAnsi(s: string): string {
  return s
    .replace(/\x1b\[[0-9;?]*[ -/]*[@-~]/g, '')
    .replace(/\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)/g, '')
    .replace(/\x1b[()][A-Za-z0-9]/g, '');
}

/**
 * True if the output looks like Claude Code's first-run folder-trust prompt.
 * We must NEVER auto-answer this — sending Enter would silently trust the folder.
 */
export function looksLikeTrustPrompt(text: string): boolean {
  const t = stripAnsi(text).toLowerCase();
  return /do you trust|trust the files|trust this folder/.test(t);
}

/**
 * Build the argv for a managed `claude` launch AND the NARUKAMI-owned session id
 * that identifies it. A fresh session gets a freshly minted `--session-id <uuid>`;
 * a resume targets that exact id via `--resume <uuid>`.
 *
 * We deliberately NEVER use `claude --continue`: that reopens whatever
 * conversation was last touched in the cwd — INCLUDING one a plain `claude`
 * running in the same folder started — which would let a NARUKAMI tab silently
 * hijack (or be hijacked by) a native-CLI session. Assigning our own id and only
 * ever resuming by that id guarantees a NARUKAMI session has a stable identity
 * and stays separate from any native-CLI session in the same directory.
 *
 * Pure aside from the injected `mcpArgs`; `newId` is injectable for tests.
 */
export function buildClaudeArgs(opts: {
  mcpArgs: string[];
  resumeSessionId?: string;
  newId?: () => string;
}): { rawArgs: string[]; sessionId: string } {
  const sessionId = opts.resumeSessionId ?? (opts.newId ?? randomUUID)();
  const idArgs = opts.resumeSessionId ? ['--resume', sessionId] : ['--session-id', sessionId];
  return { rawArgs: [...idArgs, ...opts.mcpArgs], sessionId };
}

/**
 * Open an interactive Claude Code session (`claude`) in `cwd`. Optionally types
 * an initial slash command (e.g. "/effort ultracode") — but ONLY once the TUI
 * output has settled AND no folder-trust prompt is showing, so we never
 * auto-confirm the trust gate or fire into a still-booting UI.
 *
 * Every launch carries a NARUKAMI-assigned Claude `--session-id` (returned as
 * `sessionId` so the caller can persist it on the Run). Pass `resumeSessionId`
 * to reopen a specific prior NARUKAMI session (`claude --resume <id>`); omit it
 * for a brand-new session. See {@link buildClaudeArgs} for why `--continue` is
 * never used.
 */
export function startClaude(opts: {
  runId: string;
  cwd: string;
  initInput?: string;
  resumeSessionId?: string;
  settleMs?: number;
  maxWaitMs?: number;
}): { pid: number; sessionId: string } {
  // node-pty won't PATH-resolve a bare "claude" on Windows — give it a full path,
  // and route a .cmd/.bat shim through cmd.exe (ConPTY can't launch it directly).
  const claudeBin = resolveExecutable('claude');
  // Attach the NARUKAMI MCP bridge so this session can read/drive other live
  // terminals (list_terminals / read_terminal / send_terminal). No-op (returns
  // []) if orchestration is disabled or the bridge script can't be located.
  const mcpArgs = buildClaudeMcpArgs(opts.runId);
  const { rawArgs, sessionId } = buildClaudeArgs({
    mcpArgs,
    resumeSessionId: opts.resumeSessionId,
  });
  const { file, args } = wrapForWindows(claudeBin, rawArgs);
  // The configured AI credential (Settings → AI provider). Empty in the default
  // 'claude-code' mode, so the session authenticates with the CLI's own login
  // exactly as before. Applied ONLY here — project commands and plain shells are
  // untrusted and must never see the key.
  const res = spawnManaged(opts.runId, file, args, opts.cwd, claudeSpawnEnv());

  if (opts.initInput) {
    scheduleClaudeInit(opts.runId, opts.initInput, opts.settleMs ?? 700, opts.maxWaitMs ?? 15000);
  }
  return { pid: res.pid, sessionId };
}

function scheduleClaudeInit(
  runId: string,
  initInput: string,
  settleMs: number,
  maxWaitMs: number,
): void {
  let seen = '';
  let done = false;
  let settleTimer: NodeJS.Timeout | null = null;
  let hardTimer: NodeJS.Timeout | null = null;

  const attachment = attach(runId, (event) => {
    if (done) return;
    if (event.type === 'resize') return; // grid change — irrelevant to injection
    if (event.type !== 'data') {
      finish(false); // session exited before we could inject
      return;
    }
    seen += event.chunk;
    if (settleTimer) clearTimeout(settleTimer);
    settleTimer = setTimeout(() => finish(!looksLikeTrustPrompt(seen)), settleMs);
  });

  if (!attachment) return; // not running
  seen += attachment.backlog;

  function finish(send: boolean): void {
    if (done) return;
    done = true;
    if (settleTimer) clearTimeout(settleTimer);
    if (hardTimer) clearTimeout(hardTimer);
    attachment?.unsubscribe();
    // Only inject if the session settled without a trust prompt in the way.
    if (send && !looksLikeTrustPrompt(seen)) {
      writeToRun(runId, `${initInput}\r`);
    }
  }

  // Fallback: if output never settles, decide at the hard cap.
  hardTimer = setTimeout(() => finish(!looksLikeTrustPrompt(seen)), maxWaitMs);
}

export interface Attachment {
  /** Full in-memory transcript so far — send this before streaming live events. */
  backlog: string;
  unsubscribe: () => void;
}

/**
 * Atomically snapshot the current transcript AND register a live subscriber.
 * Because this is fully synchronous, no pty chunk can slip between the snapshot
 * and the subscription — the client sees every byte exactly once (no gap, no dup).
 * Returns null if the run isn't live (already exited or unknown).
 */
export function attach(runId: string, sub: Subscriber): Attachment | null {
  const m = runs.get(runId);
  if (!m || m.exited) return null;
  flushPending(m); // fold any micro-batched bytes into the snapshot first
  const backlog = m.transcript.join('');
  m.subscribers.add(sub);
  return {
    backlog,
    unsubscribe: () => {
      m.subscribers.delete(sub);
    },
  };
}

/** Final status for a run that has exited but whose record is still in memory. */
export function getFinalState(runId: string): { status: RunFinalStatus; exitCode: number | null } | null {
  const m = runs.get(runId);
  if (m && m.exited && m.finalStatus) {
    return { status: m.finalStatus, exitCode: m.finalExitCode };
  }
  return null;
}

/**
 * Liveness + last-output snapshot for a run whose record still exists. Returns
 * null once the record has been forgotten (the run ended and its final flush
 * committed) — the caller then reads the DB row for the exit code.
 *
 * `lastOutputAt` is epoch ms of the most recent drained output batch, so an
 * orchestrator can tell a terminal that is still working from one that has gone
 * quiet WITHOUT re-reading its transcript. `exitCode` is only meaningful once
 * `live` is false.
 */
export function getRunActivity(runId: string): {
  live: boolean;
  lastOutputAt: number | null;
  exitCode: number | null;
} | null {
  const m = runs.get(runId);
  if (!m) return null;
  // Fold in any micro-batched bytes first: they have already left the pty, and
  // without this a caller landing inside the BATCH_MS window would be told the
  // terminal has been quiet for longer than it actually has.
  flushPending(m);
  return {
    live: !m.exited,
    lastOutputAt: m.lastOutputAt,
    exitCode: m.exited ? m.finalExitCode : null,
  };
}

/**
 * Full in-memory transcript for a run whose record still exists — including the
 * brief window AFTER the pty exited but BEFORE its final log flush has committed
 * and the record is deleted. The WS replay path prefers this over the DB so a
 * client reconnecting in that window doesn't miss the last un-flushed chunk.
 * Returns null once the record has been forgotten (DB is then authoritative).
 */
export function getFinalTranscript(runId: string): string | null {
  const m = runs.get(runId);
  if (!m) return null;
  flushPending(m);
  return m.transcript.join('');
}

export function writeToRun(runId: string, data: string): boolean {
  const m = runs.get(runId);
  if (!m || m.exited) return false;
  m.transport.write(data);
  return true;
}

export function resizeRun(runId: string, cols: number, rows: number): boolean {
  const m = runs.get(runId);
  if (!m || m.exited) return false;
  // Clamp to the SAME bounds the clients clamp adoption to (TerminalTab /
  // MobileTerminal): if the server accepted a grid clients refuse to adopt,
  // the one-true-grid invariant would silently break for absurd sizes.
  const c = Math.max(2, Math.min(500, Math.floor(cols)));
  const r = Math.max(1, Math.min(300, Math.floor(rows)));
  try {
    if (c === m.cols && r === m.rows) return true; // no-op — don't reflow or re-broadcast
    m.transport.resize(c, r);
    m.cols = c;
    m.rows = r;
    // Fan the new grid out to every attached client (including the resizer —
    // adopting its own size is a client-side no-op) so all views stay on the
    // one true grid.
    const resizeEvent: RunnerEvent = { type: 'resize', cols: c, rows: r };
    for (const sub of m.subscribers) sub(resizeEvent);
    return true;
  } catch {
    return false;
  }
}

export function stopRun(runId: string): boolean {
  const m = runs.get(runId);
  if (!m) return false;
  m.killedByUser = true;
  // Kill AT MOST ONCE, and never a pty that already exited. A second kill() on
  // a ConPTY mid-teardown (e.g. Stop immediately followed by closing the tab)
  // aborts the whole process with a NATIVE libuv assertion — it never surfaces
  // as a JS exception, so the try/catch below cannot contain it. Reproduced
  // deterministically; the guard is the fix.
  if (m.exited || m.killIssued) return true;
  m.killIssued = true;
  try {
    m.transport.kill();
  } catch {
    // best effort — onExit will still fire if it was already dying
  }
  return true;
}

/** Current pty grid for a live run (null when not live). */
export function getRunSize(runId: string): { cols: number; rows: number } | null {
  const m = runs.get(runId);
  if (!m || m.exited) return null;
  return { cols: m.cols, rows: m.rows };
}

export function isRunning(runId: string): boolean {
  const m = runs.get(runId);
  return Boolean(m && !m.exited);
}

/** Ids of every currently-live pty (for cross-terminal orchestration listing). */
export function liveRunIds(): string[] {
  const ids: string[] = [];
  for (const [id, m] of runs) {
    if (!m.exited) ids.push(id);
  }
  return ids;
}

/** PIDs of every live pty (roots for the header vitals sampler). */
export function livePids(): number[] {
  const pids: number[] = [];
  for (const m of runs.values()) {
    if (!m.exited && m.transport.pid > 0) pids.push(m.transport.pid);
  }
  return pids;
}

/**
 * Snapshot the in-memory transcript of a live run WITHOUT subscribing. Returns
 * null if the run isn't live (its full history still lives in the DB). Used by
 * the orchestration read endpoint so one Claude can read another's output.
 */
export function getLiveTranscript(runId: string): string | null {
  const m = runs.get(runId);
  if (!m || m.exited) return null;
  flushPending(m);
  return m.transcript.join('');
}

/**
 * Tail of a live run's in-memory transcript: at least the last `maxChars`
 * characters (never mid-chunk truncated — whole chunks are taken from the end,
 * so the result may be slightly longer). The read endpoint only ever serves a
 * bounded tail; joining the full ≤2MB transcript to keep ~3% of it allocated
 * megabytes of garbage per orchestration read. Returns null when not live.
 */
export function getLiveTranscriptTail(runId: string, maxChars: number): string | null {
  const m = runs.get(runId);
  if (!m || m.exited) return null;
  flushPending(m);
  let take = 0;
  let chars = 0;
  for (let i = m.transcript.length - 1; i >= 0 && chars < maxChars; i -= 1) {
    chars += m.transcript[i].length;
    take += 1;
  }
  return take === m.transcript.length
    ? m.transcript.join('')
    : m.transcript.slice(m.transcript.length - take).join('');
}

/**
 * Return the last `n` non-empty-trimmed lines of `text`. Pure (no I/O) so the
 * read endpoint's tail behaviour can be unit-tested. Blank trailing lines (a
 * common pty artifact) are dropped before taking the tail.
 */
export function tailLines(text: string, n: number): string {
  const lines = text.replace(/\r\n/g, '\n').replace(/\r/g, '\n').split('\n');
  while (lines.length && lines[lines.length - 1].trim() === '') lines.pop();
  if (n <= 0) return '';
  return lines.slice(-n).join('\n');
}

/**
 * On boot, any runs the DB still thinks are 'running' had their ptys die with
 * the previous server process and can never emit onExit. Mark them 'exited'
 * (neutral) — they remain restorable as read-only tabs with a Restart button.
 *
 * EXCEPT rows whose recorded pid is still alive: those belong to a SECOND
 * instance sharing this database, and flipping them to 'exited' renders its live
 * tabs dead-but-restorable while the ptys keep running (and projects.ts finds
 * live ptys by querying status:'running', so deleting that project then orphans
 * them). instanceLock.ts is the primary guard — it makes a peer-detecting boot
 * skip this function entirely — and this pid predicate is the belt-and-braces
 * half for when the lock is bypassed (crash-cleared lock dir, mixed versions, a
 * copied DB). Cost of the safety: a recycled pid can leave one row stuck at
 * 'running' until a later boot sees it dead. A stale-live row is recoverable
 * (restart the tab); a clobbered live row is not.
 */
export async function reconcileStaleRuns(): Promise<number> {
  const stale = await prisma.run.findMany({
    where: { status: 'running' },
    select: { id: true, pid: true },
  });
  // No recorded pid (elevated shell still waiting on UAC, pre-pid crash) means
  // nothing can prove it alive — reconcile it, as before.
  const dead = stale.filter((r) => r.pid === null || !pidAlive(r.pid)).map((r) => r.id);
  if (dead.length === 0) return 0;
  const res = await prisma.run.updateMany({
    where: { id: { in: dead } },
    data: { status: 'exited', endedAt: new Date() },
  });
  return res.count;
}

/** Run rows outlive their logs by this many days (see pruneOldRunLogs). */
const RUN_RETENTION_DAYS = 90;

/**
 * How long a run's OUTPUT is kept after it ends (see pruneOldRunLogs). Exported
 * so ws.ts can tell a replay with zero rows apart: past this window the history
 * was pruned, inside it the run genuinely never wrote a byte. The two need the
 * same number or the restored tab explains itself wrongly.
 */
export const LOG_RETENTION_DAYS = 14;

/**
 * Boot-time retention sweep, in two parts.
 *
 * RunLog otherwise grows without bound (one row per 300ms flush per live run,
 * forever), which slowly taxes every replay query and bloats the DB file.
 * Deleting logs of runs that ENDED more than `days` ago keeps recent history
 * (EOD, restored-tab replay) intact — EXCEPT for runs still PINNED as workspace
 * tabs. schema.prisma defines dockOpen as "an open tab in the workspace (restored
 * on reopen)" and ws.ts replays a restored tab purely from its RunLog rows, so
 * pruning those emptied the tab: it reopened permanently blank, with no data
 * frame and no explanation. A pinned tab's history is therefore bounded on the
 * REPLAY side (capped tail) rather than by deletion here; closing the tab
 * (dockOpen:false) makes it eligible for this sweep again.
 *
 * Run itself is never bulk-deleted anywhere else — it gains a row per terminal
 * ever opened — so rows that ended more than `runDays` ago and are NOT pinned are
 * dropped whole, their logs following via the FK cascade. That window is
 * deliberately much longer than the log window: an EOD report can be regenerated
 * for any past date range from Run rows alone, and those stay useful long after
 * the terminal output is gone.
 *
 * Returns the number of rows deleted (log rows + expired run rows).
 */
export async function pruneOldRunLogs(
  days = LOG_RETENTION_DAYS,
  runDays = RUN_RETENTION_DAYS,
): Promise<number> {
  const now = Date.now();
  const logCutoff = new Date(now - days * 24 * 60 * 60 * 1000);
  const logs = await prisma.runLog.deleteMany({
    where: { run: { endedAt: { lt: logCutoff }, dockOpen: false } },
  });
  const runCutoff = new Date(now - runDays * 24 * 60 * 60 * 1000);
  const rows = await prisma.run.deleteMany({
    where: { endedAt: { lt: runCutoff }, dockOpen: false },
  });
  return logs.count + rows.count;
}
