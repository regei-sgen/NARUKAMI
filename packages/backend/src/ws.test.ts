import { describe, it, expect, vi, beforeEach, beforeAll, afterAll } from 'vitest';
import fs from 'node:fs';
import http from 'node:http';
import WebSocketClient from 'ws';
import type { WebSocket } from 'ws';

// Master token → a temp file (config reads RUNNER_TOKEN_FILE at import time,
// and vi.hoisted runs before imports — so no imported modules in here).
const { file: tokenFile } = vi.hoisted(() => {
  const tmp = process.env.TEMP ?? process.env.TMPDIR ?? '.';
  const file = `${tmp}/narukami-ws-test-token-${process.pid}`;
  process.env.RUNNER_TOKEN_FILE = file;
  return { file };
});

// The relay is the ONLY trustworthy locality signal (Host/Origin are attacker
// controlled through the raw byte pipe), so tests drive it directly.
const relayState = vi.hoisted(() => ({ peer: null as string | null }));
vi.mock('./services/lanRelay', () => ({
  relayPeerAddress: () => relayState.peer,
  activeLanAddress: () => null,
}));

// Replay path only: a controllable Run row + its logs.
const dbState = vi.hoisted(() => ({
  findUnique: null as null | ((args: unknown) => unknown),
  lastArgs: null as unknown,
}));
vi.mock('./db', () => ({
  prisma: {
    run: {
      findUnique: (args: unknown) => {
        dbState.lastArgs = args;
        return Promise.resolve(dbState.findUnique ? dbState.findUnique(args) : null);
      },
      update: vi.fn().mockResolvedValue({}),
    },
    runLog: { create: vi.fn().mockResolvedValue({}), createMany: vi.fn().mockResolvedValue({}) },
  },
}));

// Keep the REAL runner (attach / transcript / batching are under test here) but
// stub the two pty writes so handleClientMessage's forwarding stays assertable.
vi.mock('./services/runner', async (importOriginal) => ({
  ...(await importOriginal<typeof import('./services/runner')>()),
  writeToRun: vi.fn(),
  resizeRun: vi.fn(),
}));

import {
  handleClientMessage,
  handleConnection,
  heartbeatSweep,
  markAlive,
  setupWebSocket,
} from './ws';
import { getToken } from './auth';
import { registerRun, writeToRun, resizeRun, type RunTransport } from './services/runner';
import {
  getDevice,
  setDeviceState,
  touchDevice,
  _clearAllDevices,
} from './services/mobileDevices';

const wt = vi.mocked(writeToRun);
const rs = vi.mocked(resizeRun);

beforeEach(() => {
  wt.mockClear();
  rs.mockClear();
  relayState.peer = null;
  dbState.findUnique = null;
  dbState.lastArgs = null;
});

describe('handleClientMessage', () => {
  it('forwards input to writeToRun', () => {
    handleClientMessage('run1', JSON.stringify({ type: 'input', data: 'ls\r' }));
    expect(wt).toHaveBeenCalledWith('run1', 'ls\r');
    expect(rs).not.toHaveBeenCalled();
  });

  it('forwards resize to resizeRun', () => {
    handleClientMessage('run1', JSON.stringify({ type: 'resize', cols: 120, rows: 40 }));
    expect(rs).toHaveBeenCalledWith('run1', 120, 40);
    expect(wt).not.toHaveBeenCalled();
  });

  it('accepts a Buffer payload', () => {
    handleClientMessage('run1', Buffer.from(JSON.stringify({ type: 'input', data: 'x' })));
    expect(wt).toHaveBeenCalledWith('run1', 'x');
  });

  it('ignores malformed JSON', () => {
    handleClientMessage('run1', 'not json {');
    expect(wt).not.toHaveBeenCalled();
    expect(rs).not.toHaveBeenCalled();
  });

  it('ignores input without a string data field', () => {
    handleClientMessage('run1', JSON.stringify({ type: 'input' }));
    handleClientMessage('run1', JSON.stringify({ type: 'input', data: 42 }));
    expect(wt).not.toHaveBeenCalled();
  });

  it('ignores resize with non-numeric dimensions', () => {
    handleClientMessage('run1', JSON.stringify({ type: 'resize', cols: '80', rows: 24 }));
    expect(rs).not.toHaveBeenCalled();
  });

  it('ignores unknown message types', () => {
    handleClientMessage('run1', JSON.stringify({ type: 'bogus' }));
    expect(wt).not.toHaveBeenCalled();
    expect(rs).not.toHaveBeenCalled();
  });

  // Read-only share (canInput=false): a mirror may neither write to the pty NOR
  // resize it — it adopts the desktop's grid, it never reshapes it.
  it('drops both input and resize from a read-only share', () => {
    handleClientMessage('run1', JSON.stringify({ type: 'input', data: 'rm -rf /\r' }), false);
    expect(wt).not.toHaveBeenCalled();
    handleClientMessage('run1', JSON.stringify({ type: 'resize', cols: 80, rows: 24 }), false);
    expect(rs).not.toHaveBeenCalled();
  });

  it('blocks resize when canResize=false even with input rights', () => {
    handleClientMessage('run1', JSON.stringify({ type: 'input', data: 'a' }), true, false);
    expect(wt).toHaveBeenCalledWith('run1', 'a');
    handleClientMessage('run1', JSON.stringify({ type: 'resize', cols: 80, rows: 24 }), true, false);
    expect(rs).not.toHaveBeenCalled();
  });

  it('allows input when canInput=true (explicit) and by default', () => {
    handleClientMessage('run1', JSON.stringify({ type: 'input', data: 'a' }), true);
    expect(wt).toHaveBeenCalledWith('run1', 'a');
  });
});

// ── test doubles ──────────────────────────────────────────────────────────────

/** A pty stand-in whose output we drive by hand. */
function fakeTransport(): { transport: RunTransport; emit: (chunk: string) => void; exit: () => void } {
  let onData: (c: string) => void = () => undefined;
  let onExit: (e: { exitCode: number; signal?: number }) => void = () => undefined;
  return {
    emit: (chunk) => onData(chunk),
    exit: () => onExit({ exitCode: 0 }),
    transport: {
      pid: 4242,
      write: () => undefined,
      resize: () => undefined,
      kill: () => undefined,
      onData: (cb) => {
        onData = cb;
      },
      onExit: (cb) => {
        onExit = cb;
      },
    },
  };
}

/**
 * A WebSocket stand-in with a writable `bufferedAmount` — the real socket's
 * send queue can't be forced past a high-water mark deterministically, and
 * bufferedAmount is exactly the signal under test.
 */
class FakeSocket {
  readonly OPEN = 1;
  readyState = 1;
  bufferedAmount = 0;
  sent: string[] = [];
  closed = false;
  terminated = false;
  pings = 0;
  private handlers = new Map<string, Array<(...a: unknown[]) => void>>();

  send(wire: string): void {
    this.sent.push(wire);
  }
  close(): void {
    this.closed = true;
    this.readyState = 3;
    this.fire('close');
  }
  // Mirrors ws: terminate() destroys the socket and still emits 'close', which
  // is what makes the existing cleanup path run for a half-open connection.
  terminate(): void {
    this.terminated = true;
    this.readyState = 3;
    this.fire('close');
  }
  ping(): void {
    this.pings += 1;
  }
  on(event: string, fn: (...a: unknown[]) => void): this {
    const list = this.handlers.get(event) ?? [];
    list.push(fn);
    this.handlers.set(event, list);
    return this;
  }
  fire(event: string, ...args: unknown[]): void {
    for (const fn of this.handlers.get(event) ?? []) fn(...args);
  }
  msgs(): Array<Record<string, unknown>> {
    return this.sent.map((s) => JSON.parse(s) as Record<string, unknown>);
  }
  ofType(type: string): Array<Record<string, unknown>> {
    return this.msgs().filter((m) => m.type === type);
  }
  asWs(): WebSocket {
    return this as unknown as WebSocket;
  }
}

const tick = (ms = 30): Promise<void> => new Promise((r) => setTimeout(r, ms));

// ── item 19a: backpressure ────────────────────────────────────────────────────

describe('flow control: a mirror that falls behind is dropped, never the exit', () => {
  it('drops DATA batches while bufferedAmount is over the high-water mark', async () => {
    const runId = 'bp-drop';
    const fake = fakeTransport();
    registerRun(runId, fake.transport);
    const ws = new FakeSocket();
    await handleConnection(ws.asWs(), runId, {
      canInput: false,
      canResize: false,
      isMaster: true,
      deviceId: null,
    });
    expect(ws.ofType('ready')).toHaveLength(1);
    const before = ws.ofType('data').length;

    // The phone's link stalled: 5 MB already queued in this process's memory.
    ws.bufferedAmount = 5 * 1024 * 1024;
    fake.emit('SHOULD-NOT-BE-QUEUED');
    await tick();
    expect(ws.ofType('data')).toHaveLength(before);

    // …but the exit event is NEVER droppable, or the tab never settles.
    fake.exit();
    await tick();
    expect(ws.ofType('exit')).toHaveLength(1);
    ws.fire('close');
  });

  it('re-syncs from the live transcript tail once the socket drains', async () => {
    const runId = 'bp-resync';
    const fake = fakeTransport();
    registerRun(runId, fake.transport);
    const ws = new FakeSocket();
    await handleConnection(ws.asWs(), runId, {
      canInput: false,
      canResize: false,
      isMaster: true,
      deviceId: null,
    });

    ws.bufferedAmount = 5 * 1024 * 1024;
    fake.emit('DROPPED-WHILE-BEHIND');
    await tick();
    expect(ws.ofType('data')).toHaveLength(0);

    // Link recovers. The next batch must not silently resume mid-stream: the
    // client is missing bytes, so it gets the transcript tail instead.
    ws.bufferedAmount = 0;
    fake.emit('LIVE-AGAIN');
    await tick();
    const data = ws.ofType('data').map((m) => String(m.chunk));
    expect(data.length).toBeGreaterThan(0);
    const joined = data.join('');
    expect(joined).toContain('DROPPED-WHILE-BEHIND');
    expect(joined).toContain('LIVE-AGAIN');
    expect(joined).toMatch(/\[output dropped/);
    ws.fire('close');
  });
});

// ── item 19b: liveness ────────────────────────────────────────────────────────

describe('liveness: half-open sockets are reaped through the existing cleanup', () => {
  it('pings on the first sweep and terminates a socket that never ponged', () => {
    const ws = new FakeSocket();
    markAlive(ws.asWs());
    heartbeatSweep([ws.asWs()]);
    expect(ws.pings).toBe(1);
    expect(ws.terminated).toBe(false);

    // No pong arrived between sweeps → the peer is gone.
    heartbeatSweep([ws.asWs()]);
    expect(ws.terminated).toBe(true);
  });

  it('keeps ponging sockets alive indefinitely', () => {
    const ws = new FakeSocket();
    markAlive(ws.asWs());
    for (let i = 0; i < 5; i += 1) {
      heartbeatSweep([ws.asWs()]);
      markAlive(ws.asWs()); // the 'pong' handler
    }
    expect(ws.terminated).toBe(false);
    expect(ws.pings).toBe(5);
  });

  it('terminating a half-open phone runs deviceDisconnected', async () => {
    _clearAllDevices();
    const runId = 'halfopen';
    const fake = fakeTransport();
    registerRun(runId, fake.transport);
    touchDevice(runId, 'p1', '192.168.1.9', 'iPhone');
    setDeviceState(runId, 'p1', 'approved');

    const ws = new FakeSocket();
    markAlive(ws.asWs());
    await handleConnection(ws.asWs(), runId, {
      canInput: true,
      canResize: true,
      isMaster: false,
      deviceId: 'p1',
    });
    expect(getDevice(runId, 'p1')?.connections).toBe(1);

    // The phone locked its screen: no pong, so the second sweep reaps it and
    // the toolbar's phantom "1 connected" clears.
    heartbeatSweep([ws.asWs()]);
    heartbeatSweep([ws.asWs()]);
    expect(ws.terminated).toBe(true);
    expect(getDevice(runId, 'p1')?.connections).toBe(0);
  });
});

// ── item 4: bounded DB replay ─────────────────────────────────────────────────

describe('dead-run replay from the DB is bounded on rows and bytes', () => {
  it('queries newest-first with a take, marks truncation, and chunks the send', async () => {
    // 3,000 rows x 1,000 chars = 3 MB — bigger than the real DB's largest
    // pinned run (3,155 rows / 1,390,804 bytes) and past the 2 M-char ceiling.
    const rows = Array.from({ length: 3000 }, (_, i) => ({
      chunk: `${String(i).padStart(6, '0')}`.padEnd(1000, '.'),
    }));
    dbState.findUnique = () => ({
      id: 'dead-run',
      status: 'exited',
      exitCode: 0,
      // newest-first, as the bounded query must ask for it
      logs: [...rows].reverse(),
    });

    const ws = new FakeSocket();
    await handleConnection(ws.asWs(), 'dead-run', {
      canInput: true,
      canResize: true,
      isMaster: true,
      deviceId: null,
    });

    const args = dbState.lastArgs as {
      include: { logs: { orderBy: { ts: string }; take?: number } };
    };
    expect(args.include.logs.orderBy.ts).toBe('desc');
    expect(typeof args.include.logs.take).toBe('number');
    expect(args.include.logs.take).toBeLessThanOrEqual(5000);

    const data = ws.ofType('data').map((m) => String(m.chunk));
    expect(data.length).toBeGreaterThan(1); // a few chunks, not one 3 MB frame
    for (const c of data) expect(c.length).toBeLessThanOrEqual(256 * 1024);

    const body = data.join('');
    expect(body.startsWith('[earlier output truncated]')).toBe(true);
    expect(body.length).toBeLessThanOrEqual(2_000_000 + 1024);
    // Oldest kept row first, newest row last — order survives the reverse.
    expect(body).toContain('002999'); // the newest row
    expect(body.indexOf('002998')).toBeLessThan(body.indexOf('002999'));
    // The truly oldest rows were dropped, and visibly so.
    expect(body).not.toContain('000000'.padEnd(1000, '.'));

    expect(ws.ofType('exit')[0]).toMatchObject({ status: 'exited', exitCode: 0 });
  });

  it('replays a small history verbatim with no truncation marker', async () => {
    dbState.findUnique = () => ({
      id: 'small-run',
      status: 'exited',
      exitCode: 3,
      logs: [{ chunk: 'world' }, { chunk: 'hello ' }], // newest-first
    });
    const ws = new FakeSocket();
    await handleConnection(ws.asWs(), 'small-run', {
      canInput: true,
      canResize: true,
      isMaster: true,
      deviceId: null,
    });
    const body = ws
      .ofType('data')
      .map((m) => String(m.chunk))
      .join('');
    expect(body).toBe('hello world');
    expect(ws.ofType('exit')[0]).toMatchObject({ status: 'exited', exitCode: 3 });
  });

  // Seven of this machine's nine pinned runs have zero RunLog rows (an older
  // build's retention sweep emptied them). Pre-fix the join produced '' and the
  // chunking loop sent NO data frame at all, so the tab restored completely
  // blank and read as broken.
  it('explains an emptied pinned run instead of restoring blank', async () => {
    const longAgo = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000);
    dbState.findUnique = () => ({
      id: 'pinned-empty',
      status: 'exited',
      exitCode: 0,
      endedAt: longAgo,
      logs: [],
    });
    const ws = new FakeSocket();
    await handleConnection(ws.asWs(), 'pinned-empty', {
      canInput: true,
      canResize: true,
      isMaster: true,
      deviceId: null,
    });
    const data = ws.ofType('data').map((m) => String(m.chunk));
    expect(data.length).toBe(1); // pre-fix: 0 frames
    expect(data[0]).toContain('history older than the retention window was pruned');
    // The tab must still learn the run is over, exactly as before.
    expect(ws.ofType('exit')[0]).toMatchObject({ status: 'exited', exitCode: 0 });
  });

  it('says a recent empty run simply produced no output (nothing was pruned)', async () => {
    dbState.findUnique = () => ({
      id: 'fresh-empty',
      status: 'error',
      exitCode: 1,
      endedAt: new Date(), // well inside the retention window
      logs: [],
    });
    const ws = new FakeSocket();
    await handleConnection(ws.asWs(), 'fresh-empty', {
      canInput: true,
      canResize: true,
      isMaster: true,
      deviceId: null,
    });
    const body = ws
      .ofType('data')
      .map((m) => String(m.chunk))
      .join('');
    expect(body).toContain('recorded no output');
    expect(body).not.toContain('pruned');
    expect(ws.ofType('exit')[0]).toMatchObject({ status: 'error', exitCode: 1 });
  });

  it('still reports a missing run', async () => {
    dbState.findUnique = () => null;
    const ws = new FakeSocket();
    await handleConnection(ws.asWs(), 'nope', {
      canInput: true,
      canResize: true,
      isMaster: true,
      deviceId: null,
    });
    expect(ws.ofType('error')[0]).toMatchObject({ message: 'Run not found.' });
  });
});

// ── item 2 + maxPayload: over a real HTTP upgrade ─────────────────────────────

describe('upgrade guards over a real HTTP server', () => {
  let server: http.Server;
  let wsBase: string;

  beforeAll(async () => {
    server = http.createServer((_req, res) => {
      res.statusCode = 404;
      res.end();
    });
    setupWebSocket(server);
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const addr = server.address();
    wsBase = `ws://127.0.0.1:${typeof addr === 'object' && addr ? addr.port : 0}`;
  });

  afterAll(async () => {
    await new Promise<void>((resolve) => server.close(() => resolve()));
    try {
      fs.unlinkSync(tokenFile);
    } catch {
      /* not created */
    }
  });

  /** Connect and resolve on open, or reject with the HTTP rejection status. */
  function connect(url: string, origin = 'http://127.0.0.1'): {
    ws: InstanceType<typeof WebSocketClient>;
    opened: Promise<void>;
    closed: Promise<number>;
    next: (ms?: number) => Promise<Record<string, unknown>>;
  } {
    const ws = new WebSocketClient(url, { origin });
    const queue: Array<Record<string, unknown>> = [];
    const waiters: Array<(m: Record<string, unknown>) => void> = [];
    ws.on('message', (raw) => {
      const msg = JSON.parse(String(raw)) as Record<string, unknown>;
      const w = waiters.shift();
      if (w) w(msg);
      else queue.push(msg);
    });
    const opened = new Promise<void>((resolve, reject) => {
      ws.once('open', () => resolve());
      ws.once('error', reject);
    });
    const closed = new Promise<number>((resolve) => {
      ws.once('close', (code) => resolve(code));
    });
    const next = (ms = 3000): Promise<Record<string, unknown>> =>
      new Promise((resolve, reject) => {
        const q = queue.shift();
        if (q) return resolve(q);
        const timer = setTimeout(() => reject(new Error('timed out waiting for ws message')), ms);
        waiters.push((m) => {
          clearTimeout(timer);
          resolve(m);
        });
      });
    return { ws, opened, closed, next };
  }

  it('accepts the master token from a genuinely loopback socket', async () => {
    const runId = 'guard-ok';
    registerRun(runId, fakeTransport().transport);
    const c = connect(`${wsBase}/ws/runs/${runId}?token=${getToken()}`);
    await c.opened;
    expect(await c.next()).toMatchObject({ type: 'ready' });
    c.ws.close();
  });

  // Item 2: the relay is a raw byte pipe, so a LAN phone controls Host AND
  // Origin. A master token lifted off that pipe must not buy master rights.
  it('refuses the master token when the socket came through the LAN relay', async () => {
    const runId = 'guard-relay';
    registerRun(runId, fakeTransport().transport);
    relayState.peer = '192.168.1.50'; // this connection is relayed
    const c = connect(`${wsBase}/ws/runs/${runId}?token=${getToken()}`);
    await expect(c.opened).rejects.toThrow(/401/);
  });

  // Item 19b: an authenticated client must not be able to hand
  // handleClientMessage a 100 MB JSON.parse.
  // Proves the sweep is actually INSTALLED (and that a responsive client keeps
  // sailing through it); heartbeatSweep's terminate branch is unit-tested above.
  it('pings live sockets on the interval and leaves a responsive one open', async () => {
    const fastServer = http.createServer();
    setupWebSocket(fastServer, { pingIntervalMs: 40 });
    await new Promise<void>((resolve) => fastServer.listen(0, '127.0.0.1', resolve));
    const addr = fastServer.address();
    const port = typeof addr === 'object' && addr ? addr.port : 0;
    const runId = 'heartbeat-wired';
    registerRun(runId, fakeTransport().transport);

    const ws = new WebSocketClient(`ws://127.0.0.1:${port}/ws/runs/${runId}?token=${getToken()}`, {
      origin: 'http://127.0.0.1',
    });
    let pings = 0;
    let closedCode: number | null = null;
    ws.on('ping', () => {
      pings += 1;
    });
    ws.on('close', (code) => {
      closedCode = code;
    });
    await new Promise<void>((resolve, reject) => {
      ws.once('open', () => resolve());
      ws.once('error', reject);
    });
    await tick(250);
    expect(pings).toBeGreaterThanOrEqual(2);
    expect(closedCode).toBeNull(); // auto-pong kept it alive across sweeps
    ws.close();
    await new Promise<void>((resolve) => fastServer.close(() => resolve()));
  }, 15000);

  it('closes a socket that sends an oversized frame (maxPayload)', async () => {
    const runId = 'guard-payload';
    registerRun(runId, fakeTransport().transport);
    const c = connect(`${wsBase}/ws/runs/${runId}?token=${getToken()}`);
    await c.opened;
    expect(await c.next()).toMatchObject({ type: 'ready' });
    c.ws.send(JSON.stringify({ type: 'input', data: 'x'.repeat(8 * 1024 * 1024) }));
    await expect(c.closed).resolves.toBe(1009);
  }, 15000);
});
