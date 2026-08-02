import { describe, it, expect, vi, beforeAll, afterAll, beforeEach } from 'vitest';
import type { Mock } from 'vitest';
import net from 'node:net';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

// The handshake suite at the bottom drives the REAL loopback listener, which
// means calling the real startAdminShell to mint a real one-time token. Two
// things must never happen inside a test run: a UAC prompt, and a stray
// broker-agent process. So the ONLY spawn in this module (launchElevated's
// execFile) is mocked out, and the first handshake test asserts it was called
// but is a mock — that assertion is what proves no elevation was attempted.
// prisma + registerRun are stubbed so the handshake's side effects are
// observable without a DB or a real run registry.
vi.mock('node:child_process', async (importOriginal) => ({
  ...(await importOriginal<typeof import('node:child_process')>()),
  execFile: vi.fn(),
}));
vi.mock('../db', () => ({
  prisma: {
    run: { update: vi.fn(() => Promise.resolve({})) },
    runLog: { create: vi.fn(() => Promise.resolve({})) },
  },
}));
vi.mock('./runner', () => ({ registerRun: vi.fn() }));

import { execFile } from 'node:child_process';
import { prisma } from '../db';
import { registerRun } from './runner';
import {
  BrokerTransport,
  elevationPsCommand,
  startAdminShell,
  stopBrokerServer,
} from './brokerServer';

const execFileMock = execFile as unknown as Mock;
const registerRunMock = registerRun as unknown as Mock;
const runUpdateMock = prisma.run.update as unknown as Mock;

function fakeSocket() {
  const writes: string[] = [];
  const sock = {
    destroyed: false,
    write: (s: string) => {
      writes.push(s);
      return true;
    },
    destroy: () => {
      sock.destroyed = true;
    },
  };
  return { sock, writes };
}

function frames(writes: string[]) {
  return writes.join('').split('\n').filter(Boolean).map((l) => JSON.parse(l));
}

describe('BrokerTransport', () => {
  it('exposes the pid it was constructed with', () => {
    const { sock } = fakeSocket();
    const t = new BrokerTransport(sock as unknown as net.Socket, 4321);
    expect(t.pid).toBe(4321);
  });

  it('encodes input / resize / kill as newline-delimited JSON frames', () => {
    const { sock, writes } = fakeSocket();
    const t = new BrokerTransport(sock as unknown as net.Socket, 1);
    t.write('echo hi');
    t.resize(120, 40);
    t.kill();
    expect(frames(writes)).toEqual([
      { t: 'input', d: 'echo hi' },
      { t: 'resize', cols: 120, rows: 40 },
      { t: 'kill' },
    ]);
  });

  it('decodes base64 data frames to the onData callback', () => {
    const { sock } = fakeSocket();
    const t = new BrokerTransport(sock as unknown as net.Socket, 1);
    const chunks: string[] = [];
    t.onData((c) => chunks.push(c));
    t.handleFrame({ t: 'data', d: Buffer.from('héllo €', 'utf8').toString('base64') });
    expect(chunks).toEqual(['héllo €']);
  });

  it('fires onExit once with the frame code, then is idempotent', () => {
    const { sock } = fakeSocket();
    const t = new BrokerTransport(sock as unknown as net.Socket, 1);
    const exit = vi.fn();
    t.onExit(exit);
    t.handleFrame({ t: 'exit', code: 7 });
    t.handleFrame({ t: 'exit', code: 9 }); // ignored — already exited
    t.socketClosed(); // also ignored
    expect(exit).toHaveBeenCalledTimes(1);
    expect(exit).toHaveBeenCalledWith({ exitCode: 7 });
  });

  it('treats a socket close as exit(null) when no exit frame arrived', () => {
    const { sock } = fakeSocket();
    const t = new BrokerTransport(sock as unknown as net.Socket, 1);
    const exit = vi.fn();
    t.onExit(exit);
    t.socketClosed();
    expect(exit).toHaveBeenCalledTimes(1);
    expect(exit).toHaveBeenCalledWith({ exitCode: null });
    expect(sock.destroyed).toBe(true);
  });

  it('does not throw writing after the socket is destroyed', () => {
    const { sock } = fakeSocket();
    sock.destroyed = true;
    const t = new BrokerTransport(sock as unknown as net.Socket, 1);
    expect(() => t.write('x')).not.toThrow();
  });
});

describe('elevationPsCommand', () => {
  const exe = 'C:\\Program Files\\NARUKAMI\\NARUKAMI.exe';
  const agent = 'C:\\Program Files\\NARUKAMI\\resources\\broker-agent.mjs';
  const cfg = 'C:\\Users\\me\\AppData\\Local\\Temp\\narukami-broker\\run.json'; // portable-exempt: fixture string

  it('elevates a hidden powershell (not the exe directly) via -Verb RunAs', () => {
    const cmd = elevationPsCommand(exe, agent, cfg);
    expect(cmd).toMatch(/^Start-Process -FilePath 'powershell\.exe' -Verb RunAs -WindowStyle Hidden/);
    expect(cmd).toContain("'-NoProfile','-NonInteractive','-Command',");
  });

  it('sets ELECTRON_RUN_AS_NODE INSIDE the elevated command, not in this parent', () => {
    const cmd = elevationPsCommand(exe, agent, cfg);
    // The flag must live inside the -Command payload (elevated context)...
    expect(cmd).toContain("$env:ELECTRON_RUN_AS_NODE=''1''");
    // ...and NOT be set before Start-Process (which UAC would drop).
    expect(cmd.startsWith('$env:')).toBe(false);
    // The exe is invoked with the call operator inside that same payload.
    expect(cmd).toContain('& ');
  });

  it('quotes the exe, agent, and cfg paths for the elevated shell', () => {
    const cmd = elevationPsCommand(exe, agent, cfg);
    // Paths are doubly single-quoted because they sit inside the outer -Command string.
    expect(cmd).toContain(`''${exe}''`);
    expect(cmd).toContain(`''${agent}''`);
    expect(cmd).toContain(`''${cfg}''`);
  });

  it('escapes embedded single quotes in paths', () => {
    const weird = "C:\\Users\\O'Brien\\app.exe"; // portable-exempt: fixture string
    const cmd = elevationPsCommand(weird, agent, cfg);
    // psQuote doubles the quote, then the outer psQuote doubles again → four quotes.
    expect(cmd).toContain("O''''Brien");
    expect(cmd).not.toContain("O'Brien"); // no unescaped single quote survives
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// The broker handshake: the gate that decides who gets control of a
// UAC-ELEVATED pty. These tests speak the wire protocol over a REAL net.Socket
// against the REAL listener startAdminShell brings up, because the point is the
// end-to-end binding — a token minted for run A must open run A and nothing
// else, exactly once. A unit test on a fake socket would not prove that the
// mint and the check agree.
// ─────────────────────────────────────────────────────────────────────────────

/** Shape of the 0600 config startAdminShell hands the elevated agent. */
interface BrokerCfg {
  port: number;
  token: string;
  runId: string;
  cwd: string;
  nodePty: string;
}

const CFG_DIR = path.join(os.tmpdir(), 'narukami-broker');
const cfgPaths: string[] = [];
const openSockets = new Set<net.Socket>();

/**
 * Mint a real pending admin run. Returns the config the (never-launched) agent
 * would have read — which is where the port and the one-time token come from,
 * exactly as the real agent gets them.
 */
async function mint(runId: string): Promise<BrokerCfg> {
  await startAdminShell({ runId, cwd: process.cwd() });
  const p = path.join(CFG_DIR, `${runId}.json`);
  cfgPaths.push(p);
  return JSON.parse(fs.readFileSync(p, 'utf8')) as BrokerCfg;
}

function connect(port: number): Promise<net.Socket> {
  return new Promise((resolve, reject) => {
    const s = net.connect(port, '127.0.0.1', () => resolve(s));
    // A rejected handshake is a destroy, which arrives as ECONNRESET on this
    // side; with no listener that would be an unhandled 'error'.
    s.on('error', () => undefined);
    s.once('close', () => openSockets.delete(s));
    openSockets.add(s);
    setTimeout(() => reject(new Error('broker connect timed out')), 3000).unref();
  });
}

function say(sock: net.Socket, frame: unknown): void {
  sock.write(JSON.stringify(frame) + '\n');
}

/** True when the server tore this socket down within `ms`. */
function closedWithin(sock: net.Socket, ms: number): Promise<boolean> {
  return new Promise((resolve) => {
    if (sock.destroyed) return resolve(true);
    const timer = setTimeout(() => resolve(false), ms);
    sock.once('close', () => {
      clearTimeout(timer);
      resolve(true);
    });
  });
}

const settle = (ms = 120): Promise<void> => new Promise((r) => setTimeout(r, ms));

let brokerPort = 0;

beforeAll(async () => {
  // Bring the listener up and learn its port. This mint is consumed right here
  // by a full valid handshake so it leaves no pending token — and no live 90s
  // elevation timer — behind for the tests below.
  const boot = await mint('brokerhs-boot');
  brokerPort = boot.port;
  const sock = await connect(brokerPort);
  say(sock, { t: 'hello', token: boot.token, runId: boot.runId, pid: 1 });
  await settle();
  sock.destroy();
});

afterAll(() => {
  for (const s of openSockets) s.destroy();
  openSockets.clear();
  stopBrokerServer();
  for (const p of cfgPaths) {
    try {
      fs.rmSync(p, { force: true });
    } catch {
      /* already gone */
    }
  }
});

beforeEach(() => {
  execFileMock.mockClear();
  registerRunMock.mockClear();
  runUpdateMock.mockClear();
});

describe('broker handshake (real socket against the real listener)', () => {
  it('mints a one-time token into the agent config and never elevates in tests', async () => {
    const cfg = await mint('brokerhs-cfg');
    expect(cfg.port).toBe(brokerPort);
    expect(cfg.token).toMatch(/^[0-9a-f]{64}$/); // crypto.randomBytes(32), hex
    expect(cfg.runId).toBe('brokerhs-cfg');
    // Proof that no UAC prompt and no process happened: the module's single
    // spawn point is a mock. No elevation-bypass env var is set here, so a real
    // call would have been `powershell.exe ... -Verb RunAs`.
    expect(execFileMock).toHaveBeenCalledTimes(1);
    expect(execFileMock.mock.calls[0][0]).toBe('powershell.exe');

    // Consume the token so no pending entry (or its timer) survives this test.
    const sock = await connect(brokerPort);
    say(sock, { t: 'hello', token: cfg.token, runId: cfg.runId, pid: 2 });
    await settle();
    expect(registerRunMock).toHaveBeenCalledTimes(1);
    sock.destroy();
  });

  it('destroys a socket whose FIRST frame is not a hello', async () => {
    const sock = await connect(brokerPort);
    say(sock, { t: 'data', d: Buffer.from('whoami').toString('base64') });
    expect(await closedWithin(sock, 2000)).toBe(true);
    expect(registerRunMock).not.toHaveBeenCalled();
  });

  it('destroys a hello carrying an unknown token', async () => {
    const sock = await connect(brokerPort);
    say(sock, { t: 'hello', token: 'f'.repeat(64), runId: 'brokerhs-unknown', pid: 9 });
    expect(await closedWithin(sock, 2000)).toBe(true);
    expect(registerRunMock).not.toHaveBeenCalled();
  });

  it('destroys a VALID token presented for a DIFFERENT runId', async () => {
    const cfg = await mint('brokerhs-bind');
    const sock = await connect(brokerPort);
    // The token is genuine and pending — only the run it names is wrong. This is
    // the clause that stops any pending token opening any elevated run.
    say(sock, { t: 'hello', token: cfg.token, runId: 'brokerhs-someone-elses-run', pid: 9 });
    expect(await closedWithin(sock, 2000)).toBe(true);
    expect(registerRunMock).not.toHaveBeenCalled();

    // A rejected mismatch is not a consume: the token stays pending until it
    // either succeeds or times out. Complete it so this test leaves no pending
    // entry (and no 90s elevation timer) behind.
    const honest = await connect(brokerPort);
    say(honest, { t: 'hello', token: cfg.token, runId: cfg.runId, pid: 10 });
    await settle();
    expect(registerRunMock).toHaveBeenCalledTimes(1);
    honest.destroy();
  });

  it('registers the run exactly once on a valid hello, and the token does not replay', async () => {
    const cfg = await mint('brokerhs-once');
    const first = await connect(brokerPort);
    say(first, { t: 'hello', token: cfg.token, runId: cfg.runId, pid: 4242 });
    await settle(150);

    // Registered once, with a BrokerTransport carrying the agent's pid...
    expect(registerRunMock).toHaveBeenCalledTimes(1);
    expect(registerRunMock.mock.calls[0][0]).toBe('brokerhs-once');
    const transport = registerRunMock.mock.calls[0][1] as BrokerTransport;
    expect(transport).toBeInstanceOf(BrokerTransport);
    expect(transport.pid).toBe(4242);
    // ...and that pid is written back to the run row.
    expect(runUpdateMock).toHaveBeenCalledWith({
      where: { id: 'brokerhs-once' },
      data: { pid: 4242 },
    });
    // The accepted socket is NOT torn down — it is the live elevated pipe.
    expect(await closedWithin(first, 250)).toBe(false);

    // Replay of the very same hello on a SECOND socket: the token was consumed
    // on first use, so this is now an unknown token.
    const replay = await connect(brokerPort);
    say(replay, { t: 'hello', token: cfg.token, runId: cfg.runId, pid: 4243 });
    expect(await closedWithin(replay, 2000)).toBe(true);
    expect(registerRunMock).toHaveBeenCalledTimes(1); // still exactly one

    first.destroy();
  });
});
