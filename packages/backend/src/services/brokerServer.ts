import net from 'node:net';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { REPO_ROOT } from '../config';
import { prisma } from '../db';
import { registerRun, type RunTransport } from './runner';

// An admin shell works around the Windows integrity wall like this: NARUKAMI
// (Medium integrity) can't attach a console to an elevated (High) child, but a
// loopback TCP socket crosses integrity levels freely. So we spawn a small
// ELEVATED broker agent (via UAC) that hosts the elevated PowerShell PTY and
// relays its bytes back over 127.0.0.1 to this non-elevated process, which then
// streams them to the browser exactly like a local run.
//
// Trust: the listener binds 127.0.0.1 only and accepts a broker connection ONLY
// if it presents the one-time token minted for a specific pending run. The token
// travels in a 0600 temp file (not argv), is consumed on first use, and expires.

const ELEVATION_TIMEOUT_MS = 90_000; // UAC can sit unanswered for a while
const CFG_DIR = path.join(os.tmpdir(), 'narukami-broker');

interface Pending {
  runId: string;
  timer: NodeJS.Timeout;
}

// token -> pending admin run awaiting its broker connection
const pending = new Map<string, Pending>();

let server: net.Server | null = null;
let serverPort = 0;

/** Locate the standalone elevated broker agent across dev + packaged layouts. */
export function locateAgent(): string | null {
  const resourcesPath = (process as { resourcesPath?: string }).resourcesPath ?? '';
  const candidates = [
    path.join(REPO_ROOT, 'packages', 'backend', 'broker-agent.mjs'),
    path.resolve(__dirname, '..', '..', 'broker-agent.mjs'),
    path.resolve(__dirname, '..', '..', '..', 'broker-agent.mjs'),
    ...(resourcesPath ? [path.join(resourcesPath, 'broker-agent.mjs')] : []),
  ];
  for (const c of candidates) {
    try {
      if (fs.statSync(c).isFile()) return c;
    } catch {
      /* keep looking */
    }
  }
  return null;
}

/** The resolved node-pty entry to hand the agent (resolved where it already loads). */
function nodePtyPath(): string {
  return require.resolve('node-pty');
}

async function ensureServer(): Promise<number> {
  if (server && serverPort) return serverPort;
  const srv = net.createServer((socket) => handleBrokerSocket(socket));
  await new Promise<void>((resolve, reject) => {
    srv.once('error', reject);
    srv.listen(0, '127.0.0.1', () => resolve());
  });
  server = srv;
  const addr = srv.address();
  serverPort = typeof addr === 'object' && addr ? addr.port : 0;
  return serverPort;
}

/**
 * A RunTransport backed by the elevated broker's socket. Frames are
 * newline-delimited JSON; terminal bytes are base64 so control characters can't
 * corrupt the framing.
 */
export class BrokerTransport implements RunTransport {
  readonly pid: number;
  private readonly socket: net.Socket;
  private dataCb: ((chunk: string) => void) | null = null;
  private exitCb: ((info: { exitCode: number | null }) => void) | null = null;
  private exited = false;

  constructor(socket: net.Socket, pid: number) {
    this.socket = socket;
    this.pid = pid;
  }

  onData(cb: (chunk: string) => void): void {
    this.dataCb = cb;
  }
  onExit(cb: (info: { exitCode: number | null }) => void): void {
    this.exitCb = cb;
  }

  private send(obj: unknown): void {
    try {
      if (!this.socket.destroyed) this.socket.write(JSON.stringify(obj) + '\n');
    } catch {
      /* socket gone — exit will be surfaced by the close handler */
    }
  }

  write(data: string): void {
    this.send({ t: 'input', d: data });
  }
  resize(cols: number, rows: number): void {
    this.send({ t: 'resize', cols, rows });
  }
  kill(): void {
    this.send({ t: 'kill' });
  }

  /** Dispatch a parsed frame coming FROM the agent. */
  handleFrame(msg: { t?: string; d?: unknown; code?: unknown }): void {
    if (msg.t === 'data' && typeof msg.d === 'string') {
      this.dataCb?.(Buffer.from(msg.d, 'base64').toString('utf8'));
    } else if (msg.t === 'exit') {
      this.fireExit(typeof msg.code === 'number' ? msg.code : null);
    }
  }

  socketClosed(): void {
    this.fireExit(null);
    try {
      this.socket.destroy();
    } catch {
      /* noop */
    }
  }

  private fireExit(code: number | null): void {
    if (this.exited) return;
    this.exited = true;
    this.exitCb?.({ exitCode: code });
  }
}

function handleBrokerSocket(socket: net.Socket): void {
  socket.setEncoding('utf8');
  let buf = '';
  let transport: BrokerTransport | null = null;

  socket.on('data', (chunk: string) => {
    buf += chunk;
    let nl: number;
    while ((nl = buf.indexOf('\n')) !== -1) {
      const line = buf.slice(0, nl);
      buf = buf.slice(nl + 1);
      if (!line) continue;
      let msg: { t?: string; token?: unknown; runId?: unknown; pid?: unknown };
      try {
        msg = JSON.parse(line);
      } catch {
        continue;
      }
      if (!transport) {
        // First frame MUST be a valid hello for a pending token.
        if (msg.t !== 'hello' || typeof msg.token !== 'string') {
          socket.destroy();
          return;
        }
        const p = pending.get(msg.token);
        if (!p || p.runId !== msg.runId) {
          socket.destroy();
          return;
        }
        clearTimeout(p.timer);
        pending.delete(msg.token);
        transport = new BrokerTransport(socket, typeof msg.pid === 'number' ? msg.pid : -1);
        registerRun(p.runId, transport);
        void prisma.run
          .update({ where: { id: p.runId }, data: { pid: transport.pid } })
          .catch(() => undefined);
      } else {
        transport.handleFrame(msg);
      }
    }
  });

  socket.on('close', () => transport?.socketClosed());
  socket.on('error', () => {
    /* 'close' fires next and handles teardown */
  });
}

/** PowerShell single-quote a string (double any embedded single quotes). */
function psQuote(s: string): string {
  return `'${s.replace(/'/g, "''")}'`;
}

/** Launch the broker agent ELEVATED via UAC. Returns nothing; success is signalled
 *  by the agent connecting back. On a synchronous failure (UAC denied) the caller's
 *  pending timeout — or the err path here — surfaces the error. */
function launchElevated(agentPath: string, cfgPath: string, token: string): void {
  const exe = process.execPath;

  // Escape hatch: run the agent WITHOUT elevation (no UAC). The resulting shell
  // has normal privileges — used to verify the broker plumbing end-to-end. Never
  // set this in normal use; it defeats the purpose of an admin shell.
  if (process.env.NARUKAMI_BROKER_NO_ELEVATE === '1') {
    execFile(
      exe,
      [agentPath, cfgPath],
      { windowsHide: true, env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' } },
      (err) => {
        if (err) void cancelPending(token, 'broker agent failed to start');
      },
    );
    return;
  }

  // ELECTRON_RUN_AS_NODE lets a packaged Electron binary run the .mjs as plain
  // Node; a real node.exe (dev) ignores it. -Verb RunAs triggers the UAC prompt.
  const psCmd =
    `$env:ELECTRON_RUN_AS_NODE='1'; ` +
    `Start-Process -FilePath ${psQuote(exe)} -Verb RunAs -WindowStyle Hidden ` +
    `-ArgumentList @(${psQuote(agentPath)}, ${psQuote(cfgPath)})`;

  execFile(
    'powershell.exe',
    ['-NoProfile', '-NonInteractive', '-Command', psCmd],
    { windowsHide: true },
    (err) => {
      // Non-zero exit = Start-Process failed (most commonly the user clicked "No"
      // on UAC). Fail fast instead of waiting out the elevation timeout.
      if (err) void cancelPending(token, 'elevation was denied');
    },
  );
}

async function cancelPending(token: string, reason: string): Promise<void> {
  const p = pending.get(token);
  if (!p) return;
  clearTimeout(p.timer);
  pending.delete(token);
  await prisma.runLog
    .create({
      data: {
        runId: p.runId,
        chunk: `\r\n\x1b[31m[admin shell] ${reason} — no elevated session was started.\x1b[0m\r\n`,
      },
    })
    .catch(() => undefined);
  await prisma.run
    .update({ where: { id: p.runId }, data: { status: 'error', endedAt: new Date() } })
    .catch(() => undefined);
}

/**
 * Begin an elevated admin shell for an already-created Run row. Mints a one-time
 * token, writes a 0600 config for the agent, and fires the UAC elevation. The run
 * goes live (streamable) once the agent connects back; if the user cancels UAC or
 * it times out, the run is marked errored with an explanatory log line.
 */
export async function startAdminShell(opts: { runId: string; cwd: string }): Promise<void> {
  if (process.platform !== 'win32') {
    throw new Error('Admin shells are only supported on Windows.');
  }
  const agent = locateAgent();
  if (!agent) throw new Error('Admin broker agent (broker-agent.mjs) was not found.');

  const port = await ensureServer();
  const token = crypto.randomBytes(32).toString('hex');
  const cfg = {
    port,
    token,
    runId: opts.runId,
    cwd: opts.cwd,
    cols: 80,
    rows: 30,
    nodePty: nodePtyPath(),
  };

  fs.mkdirSync(CFG_DIR, { recursive: true });
  const cfgPath = path.join(CFG_DIR, `${opts.runId}.json`);
  fs.writeFileSync(cfgPath, JSON.stringify(cfg), { encoding: 'utf8', mode: 0o600 });

  const timer = setTimeout(() => void cancelPending(token, 'elevation timed out'), ELEVATION_TIMEOUT_MS);
  pending.set(token, { runId: opts.runId, timer });

  launchElevated(agent, cfgPath, token);
}
