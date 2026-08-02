import { describe, it, expect, afterEach, beforeEach, vi } from 'vitest';
import type { Mock } from 'vitest';
import fs from 'node:fs';
import {
  shellFor,
  interactiveShell,
  resolveExecutable,
  cleanEnv,
  spawnEnv,
  capTranscript,
  capLogBuffer,
  stripAnsi,
  looksLikeTrustPrompt,
  buildClaudeArgs,
  registerRun,
  getRunActivity,
  pruneOldRunLogs,
  reconcileStaleRuns,
  MAX_FLUSH_ATTEMPTS,
} from './runner';
import type { RunTransport } from './runner';
import { prisma } from '../db';
import { godSpawnEnv } from './godclaude';

// The runner talks to the DB (runLog flush, retention sweep) and to the embedded
// godclaude layer; both are stubbed so these tests exercise the runner's own
// logic — no SQLite file, no provisioned god home.
vi.mock('../db', () => ({
  prisma: {
    runLog: { create: vi.fn(), deleteMany: vi.fn() },
    run: { update: vi.fn(), deleteMany: vi.fn(), updateMany: vi.fn(), findMany: vi.fn() },
  },
}));
vi.mock('./godclaude', () => ({ godSpawnEnv: vi.fn(() => ({})) }));

const db = prisma as unknown as {
  runLog: { create: Mock; deleteMany: Mock };
  run: { update: Mock; deleteMany: Mock; updateMany: Mock; findMany: Mock };
};

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

/** A RunTransport whose data/exit callbacks are driven by the test. */
function fakeTransport(): {
  transport: RunTransport;
  emit: (chunk: string) => void;
  exit: (code: number) => void;
} {
  let dataCb: ((chunk: string) => void) | null = null;
  let exitCb: ((info: { exitCode: number | null }) => void) | null = null;
  const transport: RunTransport = {
    pid: 4321,
    write: () => {},
    resize: () => {},
    kill: () => {},
    onData: (cb) => {
      dataCb = cb;
    },
    onExit: (cb) => {
      exitCb = cb;
    },
  };
  return {
    transport,
    emit: (chunk) => dataCb?.(chunk),
    exit: (code) => exitCb?.({ exitCode: code }),
  };
}

const realPlatform = process.platform;
function setPlatform(p: NodeJS.Platform): void {
  Object.defineProperty(process, 'platform', { value: p, configurable: true });
}
afterEach(() => {
  Object.defineProperty(process, 'platform', { value: realPlatform, configurable: true });
});

describe('shellFor', () => {
  it('uses a PowerShell -Command invocation on Windows (pwsh 7+ when available)', () => {
    setPlatform('win32');
    const r = shellFor('npm run dev');
    // Args are always the -Command form; the file is pwsh (if PATH-resolvable) so
    // `&&`/`||` chaining works, otherwise Windows PowerShell 5.1.
    expect(r.args).toEqual(['-NoLogo', '-NoProfile', '-Command', 'npm run dev']);
    expect(r.file).toMatch(/pwsh(\.exe)?$|powershell\.exe$/i);
  });
  it("runs in cmd.exe when shell='cmd' on Windows (verbatim string, not argv)", () => {
    setPlatform('win32');
    // A string bypasses node-pty's argv join, whose CRT quote-escaping (\")
    // cmd.exe cannot parse — an array here corrupts quoted commands.
    expect(shellFor('npm run dev', 'cmd')).toEqual({
      file: 'cmd.exe',
      args: '/d /s /c "npm run dev"',
    });
    // Inner quotes must survive verbatim (/s strips only the outer pair).
    expect(shellFor('echo "a b"', 'cmd').args).toBe('/d /s /c "echo "a b""');
  });
  it("ignores shell='cmd' on POSIX (no cmd.exe there)", () => {
    setPlatform('linux');
    const prev = process.env.SHELL;
    process.env.SHELL = '/bin/zsh';
    expect(shellFor('ls', 'cmd').file).toBe('/bin/zsh');
    if (prev === undefined) delete process.env.SHELL;
    else process.env.SHELL = prev;
  });
  it('uses $SHELL -lc on POSIX', () => {
    setPlatform('linux');
    const prev = process.env.SHELL;
    process.env.SHELL = '/bin/zsh';
    expect(shellFor('ls -la')).toEqual({ file: '/bin/zsh', args: ['-lc', 'ls -la'] });
    if (prev === undefined) delete process.env.SHELL;
    else process.env.SHELL = prev;
  });
  it('falls back to bash when SHELL is unset on POSIX', () => {
    setPlatform('linux');
    const prev = process.env.SHELL;
    delete process.env.SHELL;
    expect(shellFor('ls').file).toBe('bash');
    if (prev !== undefined) process.env.SHELL = prev;
  });
});

describe('interactiveShell', () => {
  it('is a bare PowerShell on Windows', () => {
    setPlatform('win32');
    expect(interactiveShell()).toEqual({ file: 'powershell.exe', args: ['-NoLogo'] });
  });
  it("is a bare cmd.exe when shell='cmd' on Windows", () => {
    setPlatform('win32');
    expect(interactiveShell('cmd')).toEqual({ file: 'cmd.exe', args: [] });
  });
  it('is an interactive $SHELL on POSIX', () => {
    setPlatform('linux');
    process.env.SHELL = '/bin/bash';
    expect(interactiveShell()).toEqual({ file: '/bin/bash', args: ['-i'] });
  });
});

describe('resolveExecutable', () => {
  it('resolves a real executable on PATH to an existing absolute path', () => {
    const resolved = resolveExecutable('node');
    expect(resolved).not.toBe('node');
    expect(fs.existsSync(resolved)).toBe(true);
  });
  it('returns the bare name when not found', () => {
    expect(resolveExecutable('definitely-not-a-real-exe-xyz-123')).toBe(
      'definitely-not-a-real-exe-xyz-123',
    );
  });
});

describe('buildClaudeArgs', () => {
  const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

  it('mints a fresh --session-id for a new session (never --continue)', () => {
    const { rawArgs, sessionId } = buildClaudeArgs({
      mcpArgs: ['--mcp-config', 'x.json'],
      newId: () => 'fixed-id',
    });
    expect(sessionId).toBe('fixed-id');
    expect(rawArgs).toEqual(['--session-id', 'fixed-id', '--mcp-config', 'x.json']);
    expect(rawArgs).not.toContain('--continue');
    expect(rawArgs).not.toContain('--resume');
  });

  it('resumes by explicit id with --resume (never --continue or --session-id)', () => {
    const newId = () => {
      throw new Error('newId must NOT be called when resuming');
    };
    const { rawArgs, sessionId } = buildClaudeArgs({
      mcpArgs: [],
      resumeSessionId: 'abc-123',
      newId,
    });
    expect(sessionId).toBe('abc-123');
    expect(rawArgs).toEqual(['--resume', 'abc-123']);
    expect(rawArgs).not.toContain('--continue');
    expect(rawArgs).not.toContain('--session-id');
  });

  it('appends mcpArgs AFTER the id args', () => {
    const { rawArgs } = buildClaudeArgs({
      mcpArgs: ['--mcp-config', '/tmp/run.json'],
      resumeSessionId: 'sid',
    });
    expect(rawArgs).toEqual(['--resume', 'sid', '--mcp-config', '/tmp/run.json']);
  });

  it('defaults to a real UUID and gives each fresh session a distinct id', () => {
    const a = buildClaudeArgs({ mcpArgs: [] });
    const b = buildClaudeArgs({ mcpArgs: [] });
    expect(a.sessionId).toMatch(UUID_RE);
    expect(b.sessionId).toMatch(UUID_RE);
    expect(a.sessionId).not.toBe(b.sessionId); // separate sessions → separate ids
    expect(a.rawArgs[0]).toBe('--session-id');
  });
});

describe('cleanEnv', () => {
  it('includes string env vars and never yields undefined values', () => {
    process.env.__NARUKAMI_TEST__ = 'hi';
    const env = cleanEnv();
    expect(env.__NARUKAMI_TEST__).toBe('hi');
    expect(Object.values(env).every((v) => typeof v === 'string')).toBe(true);
    delete process.env.__NARUKAMI_TEST__;
  });

  it('strips NARUKAMI-internal / secret-bearing vars from the spawned child env', () => {
    const added = {
      DATABASE_URL: 'file:./dev.db',
      RUNNER_TOKEN_FILE: '/tmp/.runner-token',
      PORT: '4000',
      NARUKAMI_TOKEN: 'super-secret',
      NARUKAMI_BASE_URL: 'http://127.0.0.1:4000',
      PRISMA_QUERY_ENGINE_LIBRARY: '/x/engine.node',
      ORDINARY_VAR_XYZ: 'keepme',
    };
    Object.assign(process.env, added);
    try {
      const env = cleanEnv();
      // Secrets / internal wiring must NOT leak into untrusted project commands.
      expect(env.DATABASE_URL).toBeUndefined();
      expect(env.RUNNER_TOKEN_FILE).toBeUndefined();
      expect(env.PORT).toBeUndefined();
      expect(env.NARUKAMI_TOKEN).toBeUndefined();
      expect(env.NARUKAMI_BASE_URL).toBeUndefined();
      expect(env.PRISMA_QUERY_ENGINE_LIBRARY).toBeUndefined();
      // ...but ordinary vars still pass through.
      expect(env.ORDINARY_VAR_XYZ).toBe('keepme');
    } finally {
      for (const k of Object.keys(added)) delete process.env[k];
    }
  });
});

describe('capTranscript', () => {
  it('appends within the cap', () => {
    const t: string[] = [];
    const total = capTranscript(t, 0, 'abc', 100);
    expect(total).toBe(3);
    expect(t).toEqual(['abc']);
  });
  it('drops oldest chunks when over the cap', () => {
    const t = ['aaaa', 'bbbb'];
    const total = capTranscript(t, 8, 'cccc', 10);
    expect(total).toBe(8);
    expect(t).toEqual(['bbbb', 'cccc']);
  });
  it('always keeps at least one chunk even if it exceeds the cap', () => {
    const t = ['x'.repeat(20)];
    const total = capTranscript(t, 20, 'y'.repeat(20), 10);
    expect(t).toHaveLength(1);
    expect(t[0]).toBe('y'.repeat(20));
    expect(total).toBe(20);
  });
});

describe('stripAnsi', () => {
  it('removes SGR color codes', () => {
    expect(stripAnsi('\x1b[31mred\x1b[0m')).toBe('red');
  });
  it('removes private-mode sequences', () => {
    expect(stripAnsi('\x1b[?1049lhi')).toBe('hi');
  });
  it('removes OSC sequences', () => {
    expect(stripAnsi('\x1b]0;title\x07rest')).toBe('rest');
  });
});

describe('spawn env (godclaude layer)', () => {
  const prevHome = process.env.DET_HOOKS_HOME;
  afterEach(() => {
    if (prevHome === undefined) delete process.env.DET_HOOKS_HOME;
    else process.env.DET_HOOKS_HOME = prevHome;
    vi.mocked(godSpawnEnv).mockReturnValue({});
  });

  it('strips an INHERITED DET_HOOKS_HOME when the embedded layer is not provisioned', () => {
    // godSpawnEnv() returns {} until the layer is provisioned, so an inherited
    // value would otherwise survive into every spawned pty — the opposite of the
    // documented "an uninstalled layer changes nothing about spawned sessions".
    process.env.DET_HOOKS_HOME = '/home/someone/.narukami/godclaude';
    vi.mocked(godSpawnEnv).mockReturnValue({});
    expect(cleanEnv().DET_HOOKS_HOME).toBeUndefined();
    expect(spawnEnv().DET_HOOKS_HOME).toBeUndefined();
  });

  it('still lets the PROVISIONED embedded god home win over the inherited one', () => {
    process.env.DET_HOOKS_HOME = '/home/someone/.claude';
    vi.mocked(godSpawnEnv).mockReturnValue({ DET_HOOKS_HOME: '/embedded/god' });
    expect(spawnEnv().DET_HOOKS_HOME).toBe('/embedded/god');
  });

  it('applies the per-launch overlay last (Claude credentials win)', () => {
    vi.mocked(godSpawnEnv).mockReturnValue({ DET_HOOKS_HOME: '/embedded/god' });
    const env = spawnEnv({ ANTHROPIC_API_KEY: 'k' });
    expect(env.ANTHROPIC_API_KEY).toBe('k');
    expect(env.DET_HOOKS_HOME).toBe('/embedded/god');
  });
});

describe('capLogBuffer', () => {
  it('leaves a buffer within the cap untouched', () => {
    const b = ['aaa', 'bbb'];
    expect(capLogBuffer(b, 100)).toBe(0);
    expect(b).toEqual(['aaa', 'bbb']);
  });
  it('drops the oldest un-flushed chunks when over the cap', () => {
    const b = ['aaaa', 'bbbb', 'cccc'];
    expect(capLogBuffer(b, 8)).toBe(1);
    expect(b).toEqual(['bbbb', 'cccc']);
  });
  it('always keeps at least one chunk', () => {
    const b = ['x'.repeat(20)];
    expect(capLogBuffer(b, 5)).toBe(0);
    expect(b).toHaveLength(1);
  });
});

describe('log flushing', () => {
  beforeEach(() => {
    db.runLog.create.mockReset();
    db.run.update.mockReset().mockResolvedValue({});
  });

  // The buffer is only spliced AFTER the write commits (so a transient DB error
  // can't lose output), and flushLogs has two independent callers — the 300ms
  // timer and the exit path. Unserialized, the second sees chunks the first has
  // written but not yet spliced and persists them a SECOND time.
  it('never persists the same chunk twice when the timer and the exit path overlap', async () => {
    const created: string[] = [];
    let openGate: () => void = () => {};
    const gate = new Promise<void>((r) => {
      openGate = r;
    });
    db.runLog.create.mockImplementation(async (args: { data: { chunk: string } }) => {
      created.push(args.data.chunk);
      await gate;
      return { id: 'log' };
    });

    const t = fakeTransport();
    registerRun('race-run', t.transport);
    t.emit('A');
    await sleep(450); // batch (8ms) + flush timer (300ms): create('A') is now in flight
    expect(created).toEqual(['A']);

    t.emit('B'); // lands in the buffer BEHIND the still-unspliced 'A'
    await sleep(40);
    t.exit(0); // exit path flushes while the timer's write is still awaiting
    await sleep(40);
    openGate();
    await sleep(600); // let both writes settle AND any re-armed timer fire

    expect(created).toEqual(['A', 'B']); // pre-fix: ['A', 'AB'] — 'A' persisted twice
  });

  it('gives up on a persistently failing flush instead of rescheduling forever', async () => {
    db.runLog.create.mockRejectedValue(new Error('SQLITE_BUSY: database is locked'));
    const stderr = vi.spyOn(process.stderr, 'write').mockReturnValue(true);
    try {
      const t = fakeTransport();
      registerRun('retry-run', t.transport);
      t.emit('X');
      await sleep(3400); // 300 + 600 + 1200ms of backoff, plus generous slack
      const calls = db.runLog.create.mock.calls.length;
      expect(calls).toBe(MAX_FLUSH_ATTEMPTS); // pre-fix: a 300ms retry every tick, forever
      await sleep(800);
      expect(db.runLog.create.mock.calls.length).toBe(calls); // no timer left running
      expect(stderr.mock.calls.some((c) => String(c[0]).includes('retry-run'))).toBe(true);
    } finally {
      stderr.mockRestore();
    }
  }, 10_000);
});

// The instance lock is the PRIMARY guard against a second boot reconciling a
// live instance's runs; this is the belt-and-braces half, for when the lock is
// bypassed (crash-cleared lock dir, a mixed-version pair, a manual DB copy).
describe('reconcileStaleRuns (boot: only rows whose process is really gone)', () => {
  beforeEach(() => {
    db.run.findMany.mockReset();
    db.run.updateMany.mockReset().mockResolvedValue({ count: 0 });
  });

  it('marks a stale row exited when its recorded pid is dead', async () => {
    // 0x7FFFFFFE: above Windows' and Linux' pid ceilings — never a live process.
    db.run.findMany.mockResolvedValue([{ id: 'dead-run', pid: 0x7ffffffe }]);
    db.run.updateMany.mockResolvedValue({ count: 1 });

    expect(await reconcileStaleRuns()).toBe(1);
    const call = db.run.updateMany.mock.calls[0][0] as {
      where: { id: { in: string[] } };
      data: { status: string; endedAt: Date };
    };
    expect(call.where.id.in).toEqual(['dead-run']);
    expect(call.data.status).toBe('exited');
    expect(call.data.endedAt).toBeInstanceOf(Date);
  });

  it('NEVER touches a row whose recorded pid is still alive', async () => {
    // process.pid is alive by definition — stands in for a second instance's pty.
    db.run.findMany.mockResolvedValue([
      { id: 'live-run', pid: process.pid },
      { id: 'dead-run', pid: 0x7ffffffe },
    ]);
    db.run.updateMany.mockResolvedValue({ count: 1 });

    expect(await reconcileStaleRuns()).toBe(1);
    const where = (db.run.updateMany.mock.calls[0][0] as { where: { id: { in: string[] } } }).where;
    // Pre-fix this was an unconditional { status: 'running' } updateMany, which
    // flipped the live row to 'exited' while its pty was still running.
    expect(where.id.in).toEqual(['dead-run']);
    expect(where.id.in).not.toContain('live-run');
  });

  it('reconciles a row that never recorded a pid (nothing can prove it alive)', async () => {
    db.run.findMany.mockResolvedValue([{ id: 'no-pid', pid: null }]);
    db.run.updateMany.mockResolvedValue({ count: 1 });

    expect(await reconcileStaleRuns()).toBe(1);
    expect(
      (db.run.updateMany.mock.calls[0][0] as { where: { id: { in: string[] } } }).where.id.in,
    ).toEqual(['no-pid']);
  });

  it('issues no write at all when every stale row is still live', async () => {
    db.run.findMany.mockResolvedValue([{ id: 'live-run', pid: process.pid }]);
    expect(await reconcileStaleRuns()).toBe(0);
    expect(db.run.updateMany).not.toHaveBeenCalled();
  });

  it('only ever considers rows the DB still calls running', async () => {
    db.run.findMany.mockResolvedValue([]);
    await reconcileStaleRuns();
    const args = db.run.findMany.mock.calls[0][0] as { where: { status: string } };
    expect(args.where.status).toBe('running');
  });
});

describe('pruneOldRunLogs (boot retention sweep)', () => {
  beforeEach(() => {
    db.runLog.deleteMany.mockReset().mockResolvedValue({ count: 2 });
    db.run.deleteMany.mockReset().mockResolvedValue({ count: 1 });
  });

  // schema.prisma defines dockOpen as "an open tab in the workspace (restored on
  // reopen)" and ws.ts replays a restored tab purely from its RunLog rows —
  // pruning them left the tab permanently blank with no explanation.
  it('never prunes the logs of a PINNED (dockOpen) run', async () => {
    await pruneOldRunLogs(14);
    const where = db.runLog.deleteMany.mock.calls[0][0].where as {
      run: { endedAt: { lt: Date }; dockOpen: boolean };
    };
    expect(where.run.dockOpen).toBe(false);
    expect(where.run.endedAt.lt.getTime()).toBeLessThan(Date.now());
  });

  it('drops Run rows past the (longer) row-retention window, pinned tabs exempt', async () => {
    await pruneOldRunLogs(14, 90);
    const where = db.run.deleteMany.mock.calls[0][0].where as {
      endedAt: { lt: Date };
      dockOpen: boolean;
    };
    expect(where.dockOpen).toBe(false);
    // Rows outlive their logs: EOD can be re-run for any past range from Run alone.
    const logCutoff = (
      db.runLog.deleteMany.mock.calls[0][0].where as { run: { endedAt: { lt: Date } } }
    ).run.endedAt.lt;
    expect(where.endedAt.lt.getTime()).toBeLessThan(logCutoff.getTime());
  });

  it('counts both sweeps', async () => {
    expect(await pruneOldRunLogs()).toBe(3);
  });
});

// Idle detection: the ONLY thing that may move a run's last-output clock is the
// pty actually producing bytes. Reading a terminal must not make it look busy,
// and an ended run must report itself dead — an orchestrator that awaits a
// terminal would otherwise hang on a pty that will never speak again.
describe('getRunActivity (idle detection)', () => {
  beforeEach(() => {
    db.runLog.create.mockReset().mockResolvedValue({ id: 'log' });
    db.run.update.mockReset().mockResolvedValue({});
  });

  it('returns null for a run that was never registered', () => {
    expect(getRunActivity('no-such-run')).toBeNull();
  });

  it('reports no timestamp until the pty has produced its first byte', () => {
    const t = fakeTransport();
    registerRun('quiet-run', t.transport);
    expect(getRunActivity('quiet-run')).toEqual({
      live: true,
      lastOutputAt: null,
      exitCode: null,
    });
    t.exit(0);
  });

  it('stamps the drain path, so the clock advances with each output batch', async () => {
    const t = fakeTransport();
    registerRun('chatty-run', t.transport);
    const before = Date.now();
    t.emit('first');
    // Read WITHOUT waiting out BATCH_MS: the bytes have already left the pty, so
    // the snapshot must fold the micro-batch in rather than report the terminal
    // quieter than it is.
    const first = getRunActivity('chatty-run');
    expect(first?.lastOutputAt).not.toBeNull();
    expect(first?.lastOutputAt ?? 0).toBeGreaterThanOrEqual(before);

    await sleep(25);
    t.emit('second');
    const second = getRunActivity('chatty-run');
    expect(second?.lastOutputAt ?? 0).toBeGreaterThan(first?.lastOutputAt ?? 0);
    t.exit(0);
  });

  it('does not advance the clock when a reader polls and nothing was written', async () => {
    const t = fakeTransport();
    registerRun('poll-run', t.transport);
    t.emit('x');
    const a = getRunActivity('poll-run');
    await sleep(25);
    const b = getRunActivity('poll-run');
    expect(b?.lastOutputAt).toBe(a?.lastOutputAt); // polling is not activity
    t.exit(0);
  });

  it('reports an ended run as not live, carrying its exit code', () => {
    const t = fakeTransport();
    registerRun('ended-run', t.transport);
    t.emit('bye');
    t.exit(3);
    // Read synchronously: the record survives until the final flush commits.
    expect(getRunActivity('ended-run')).toMatchObject({ live: false, exitCode: 3 });
  });
});

describe('looksLikeTrustPrompt', () => {
  it('detects the folder-trust prompt', () => {
    expect(looksLikeTrustPrompt('Do you trust the files in this folder?')).toBe(true);
    expect(looksLikeTrustPrompt('\x1b[1mDo you trust\x1b[0m the files')).toBe(true);
    expect(looksLikeTrustPrompt('...trust this folder...')).toBe(true);
  });
  it('does not fire on normal output', () => {
    expect(looksLikeTrustPrompt('Welcome back Regei!')).toBe(false);
    expect(looksLikeTrustPrompt('')).toBe(false);
  });
});
