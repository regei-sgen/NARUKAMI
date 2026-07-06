import fs from 'node:fs';
import path from 'node:path';
import * as pty from 'node-pty';
import { prisma } from '../db';
import { buildClaudeMcpArgs } from './mcpConfig';

export type RunFinalStatus = 'exited' | 'killed' | 'error';

export type RunnerEvent =
  | { type: 'data'; chunk: string }
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

/** Wrap a local node-pty process as a RunTransport. */
function ptyTransport(file: string, args: string[], cwd: string): RunTransport {
  const proc = pty.spawn(file, args, {
    name: 'xterm-color',
    cols: 80,
    rows: 30,
    cwd,
    env: cleanEnv(),
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
  /** Un-persisted chunks awaiting a DB flush. */
  logBuffer: string[];
  flushTimer: NodeJS.Timeout | null;
  /** In-memory rolling transcript (capped) for gap-free live (re)connects. */
  transcript: string[];
  transcriptChars: number;
  exited: boolean;
  finalStatus: RunFinalStatus | null;
  finalExitCode: number | null;
}

const runs = new Map<string, ManagedRun>();

const LOG_FLUSH_MS = 300;
// Cap the in-memory transcript so a chatty long-lived run can't grow unbounded.
// The DB still holds the full history for post-mortem; live reconnects see the tail.
const MAX_TRANSCRIPT_CHARS = 2_000_000;

/** Pick a shell + args that run `command` and stay attached to the pty. */
export function shellFor(command: string): { file: string; args: string[] } {
  if (process.platform === 'win32') {
    // PowerShell works with ConPTY and handles npm/python/etc. dev commands.
    return { file: 'powershell.exe', args: ['-NoLogo', '-NoProfile', '-Command', command] };
  }
  const shell = process.env.SHELL || 'bash';
  return { file: shell, args: ['-lc', command] };
}

/**
 * Resolve an executable to a full path via PATH + PATHEXT. Unlike libuv's
 * execFile, node-pty's spawn does NOT search PATH/PATHEXT for a bare name on
 * Windows, so `claude` must be resolved to `…\claude.exe` before spawning.
 * Returns the bare name if not found (let spawn surface a clear error).
 */
export function resolveExecutable(name: string): string {
  const isWin = process.platform === 'win32';
  const sep = isWin ? ';' : ':';
  const exts = isWin
    ? (process.env.PATHEXT || '.EXE;.CMD;.BAT;.COM').split(';')
    : [''];
  const dirs = (process.env.PATH || '').split(sep).filter(Boolean);
  for (const dir of dirs) {
    for (const ext of exts) {
      const candidate = path.join(dir, name + ext);
      try {
        if (fs.statSync(candidate).isFile()) return candidate;
      } catch {
        /* not here — keep looking */
      }
    }
  }
  return name;
}

/** process.env minus undefined values (node-pty wants Record<string,string>). */
export function cleanEnv(): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(process.env)) {
    if (typeof v === 'string') out[k] = v;
  }
  return out;
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

function scheduleFlush(m: ManagedRun): void {
  if (m.flushTimer) return;
  m.flushTimer = setTimeout(() => {
    m.flushTimer = null;
    void flushLogs(m);
  }, LOG_FLUSH_MS);
}

async function flushLogs(m: ManagedRun): Promise<void> {
  if (m.flushTimer) {
    clearTimeout(m.flushTimer);
    m.flushTimer = null;
  }
  if (m.logBuffer.length === 0) return;
  const chunk = m.logBuffer.join('');
  m.logBuffer = [];
  try {
    await prisma.runLog.create({ data: { runId: m.runId, chunk } });
  } catch {
    // Run row gone (e.g. project deleted mid-run) — drop the chunk silently.
  }
}

export interface StartOptions {
  runId: string;
  command: string;
  cwd: string;
}

/** A bare interactive shell (no command) — a project-scoped terminal. */
export function interactiveShell(): { file: string; args: string[] } {
  if (process.platform === 'win32') {
    return { file: 'powershell.exe', args: ['-NoLogo'] };
  }
  const shell = process.env.SHELL || 'bash';
  return { file: shell, args: ['-i'] };
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
    logBuffer: [],
    flushTimer: null,
    transcript: [],
    transcriptChars: 0,
    exited: false,
    finalStatus: null,
    finalExitCode: null,
  };
  runs.set(runId, managed);

  transport.onData((chunk) => {
    appendTranscript(managed, chunk);
    for (const sub of managed.subscribers) sub({ type: 'data', chunk });
    managed.logBuffer.push(chunk);
    scheduleFlush(managed);
  });

  transport.onExit(({ exitCode }) => {
    if (managed.exited) return; // idempotent — a broker socket close + exit frame can race
    managed.exited = true;
    managed.finalStatus = managed.killedByUser ? 'killed' : 'exited';
    managed.finalExitCode = exitCode ?? null;

    // Notify live clients immediately.
    for (const sub of managed.subscribers) {
      sub({ type: 'exit', status: managed.finalStatus, exitCode: managed.finalExitCode });
    }

    // Persist remaining logs + final status, THEN forget the run. Keeping the
    // record in the map until the DB write commits lets getFinalState() serve an
    // authoritative final status to any client that connects during this window.
    void (async () => {
      await flushLogs(managed);
      await prisma.run
        .update({
          where: { id: runId },
          data: {
            status: managed.finalStatus ?? 'exited',
            exitCode: managed.finalExitCode,
            endedAt: new Date(),
          },
        })
        .catch(() => undefined);
      runs.delete(runId);
    })();
  });
}

/** Spawn a local pty, wire it up, and track it. Throws if spawn fails. */
function spawnManaged(runId: string, file: string, args: string[], cwd: string): { pid: number } {
  const transport = ptyTransport(file, args, cwd);
  registerRun(runId, transport);
  return { pid: transport.pid };
}

/** Spawn a pty for `command`. Throws synchronously if the shell can't start. */
export function startRun(opts: StartOptions): { pid: number } {
  const { file, args } = shellFor(opts.command);
  return spawnManaged(opts.runId, file, args, opts.cwd);
}

/** Open a bare interactive shell (PowerShell / $SHELL) in `cwd`. */
export function startShell(opts: { runId: string; cwd: string }): { pid: number } {
  const { file, args } = interactiveShell();
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
 * Open an interactive Claude Code session (`claude`) in `cwd`. Optionally types
 * an initial slash command (e.g. "/effort ultracode") — but ONLY once the TUI
 * output has settled AND no folder-trust prompt is showing, so we never
 * auto-confirm the trust gate or fire into a still-booting UI.
 *
 * `resume: true` launches `claude --continue`, which reopens the most recent
 * conversation in `cwd` instead of starting a blank session.
 */
export function startClaude(opts: {
  runId: string;
  cwd: string;
  initInput?: string;
  resume?: boolean;
  settleMs?: number;
  maxWaitMs?: number;
}): { pid: number } {
  // node-pty won't PATH-resolve a bare "claude" on Windows — give it a full path.
  const claudeBin = resolveExecutable('claude');
  // Attach the NARUKAMI MCP bridge so this session can read/drive other live
  // terminals (list_terminals / read_terminal / send_terminal). No-op (returns
  // []) if orchestration is disabled or the bridge script can't be located.
  const mcpArgs = buildClaudeMcpArgs(opts.runId);
  const args = [...(opts.resume ? ['--continue'] : []), ...mcpArgs];
  const res = spawnManaged(opts.runId, claudeBin, args, opts.cwd);

  if (opts.initInput) {
    scheduleClaudeInit(opts.runId, opts.initInput, opts.settleMs ?? 700, opts.maxWaitMs ?? 15000);
  }
  return res;
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

export function writeToRun(runId: string, data: string): boolean {
  const m = runs.get(runId);
  if (!m || m.exited) return false;
  m.transport.write(data);
  return true;
}

export function resizeRun(runId: string, cols: number, rows: number): boolean {
  const m = runs.get(runId);
  if (!m || m.exited) return false;
  try {
    m.transport.resize(Math.max(1, Math.floor(cols)), Math.max(1, Math.floor(rows)));
    return true;
  } catch {
    return false;
  }
}

export function stopRun(runId: string): boolean {
  const m = runs.get(runId);
  if (!m) return false;
  m.killedByUser = true;
  try {
    m.transport.kill();
  } catch {
    // best effort — onExit will still fire if it was already dying
  }
  return true;
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

/**
 * Snapshot the in-memory transcript of a live run WITHOUT subscribing. Returns
 * null if the run isn't live (its full history still lives in the DB). Used by
 * the orchestration read endpoint so one Claude can read another's output.
 */
export function getLiveTranscript(runId: string): string | null {
  const m = runs.get(runId);
  if (!m || m.exited) return null;
  return m.transcript.join('');
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
 */
export async function reconcileStaleRuns(): Promise<number> {
  const res = await prisma.run.updateMany({
    where: { status: 'running' },
    data: { status: 'exited', endedAt: new Date() },
  });
  return res.count;
}
