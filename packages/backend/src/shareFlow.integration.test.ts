import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from 'vitest';
import fs from 'node:fs';
import Fastify, { type FastifyInstance } from 'fastify';
import WebSocket from 'ws';

// Master token → a temp file (config reads RUNNER_TOKEN_FILE at import time,
// and vi.hoisted runs before imports — so no imported modules in here).
const { file: tokenFile } = vi.hoisted(() => {
  const tmp = process.env.TEMP ?? process.env.TMPDIR ?? '.';
  const file = `${tmp}/narukami-test-token-${process.pid}`;
  process.env.RUNNER_TOKEN_FILE = file;
  return { file };
});

// The live-run ws path never touches the DB, but /api/mobile/run reads the run
// row — stub prisma so this stays a pure share-flow test.
vi.mock('./db', () => ({
  prisma: {
    run: {
      findUnique: vi.fn().mockImplementation(() =>
        Promise.resolve({
          id: 'share-flow-run',
          kind: 'shell',
          name: null,
          status: 'running',
          exitCode: null,
          project: { name: 'Proj' },
          command: null,
          logs: [],
        }),
      ),
      update: vi.fn().mockResolvedValue({}),
    },
    runLog: { create: vi.fn().mockResolvedValue({}) },
  },
}));

import { getToken } from './auth';
import { setupWebSocket } from './ws';
import { shareRoutes } from './routes/share';
import { registerRun, type RunTransport } from './services/runner';
import { mintShare, revokeShare, _clearAllShares } from './services/shareTokens';
import { _clearAllDevices } from './services/mobileDevices';

const RUN_ID = 'share-flow-run';

/** Scriptable transport: records resizes, never exits. */
function fakeTransport(): { transport: RunTransport; resizes: Array<[number, number]> } {
  const resizes: Array<[number, number]> = [];
  return {
    resizes,
    transport: {
      pid: 4242,
      write: () => undefined,
      resize: (c, r) => {
        resizes.push([c, r]);
      },
      kill: () => undefined,
      onData: () => undefined,
      onExit: () => undefined,
    },
  };
}

/** WS client wrapper: queues parsed messages; await them one by one. */
function wsClient(url: string): {
  ws: WebSocket;
  next: (timeoutMs?: number) => Promise<Record<string, unknown>>;
  opened: Promise<void>;
  closed: Promise<{ code: number }>;
} {
  const ws = new WebSocket(url, { origin: 'http://127.0.0.1' });
  const queue: Record<string, unknown>[] = [];
  const waiters: Array<(m: Record<string, unknown>) => void> = [];
  ws.on('message', (raw) => {
    const msg = JSON.parse(String(raw)) as Record<string, unknown>;
    const w = waiters.shift();
    if (w) w(msg);
    else queue.push(msg);
  });
  const opened = new Promise<void>((resolve, reject) => {
    ws.once('open', resolve);
    ws.once('error', reject);
  });
  const closed = new Promise<{ code: number }>((resolve) => {
    ws.once('close', (code) => resolve({ code }));
  });
  const next = (timeoutMs = 3000): Promise<Record<string, unknown>> =>
    new Promise((resolve, reject) => {
      const q = queue.shift();
      if (q) return resolve(q);
      const timer = setTimeout(() => reject(new Error('timed out waiting for ws message')), timeoutMs);
      waiters.push((m) => {
        clearTimeout(timer);
        resolve(m);
      });
    });
  return { ws, next, opened, closed };
}

let app: FastifyInstance;
let base: string;
let wsBase: string;
let resizes: Array<[number, number]>;

beforeAll(async () => {
  app = Fastify();
  await app.register(shareRoutes);
  await app.ready();
  setupWebSocket(app.server);
  await app.listen({ port: 0, host: '127.0.0.1' });
  const addr = app.server.address();
  const port = typeof addr === 'object' && addr ? addr.port : 0;
  base = `http://127.0.0.1:${port}`;
  wsBase = `ws://127.0.0.1:${port}`;
});

afterAll(async () => {
  await app.close();
  try {
    fs.unlinkSync(tokenFile);
  } catch {
    /* not created */
  }
});

beforeEach(() => {
  _clearAllShares();
  _clearAllDevices();
});

describe('mobile share device gate + one-true-grid (end to end over real HTTP/WS)', () => {
  it('walks the full flow: knock → pending → 403 → allow → stream → resize broadcast → deny kick', async () => {
    const fake = fakeTransport();
    resizes = fake.resizes;
    registerRun(RUN_ID, fake.transport);
    const share = mintShare(RUN_ID);

    // 1. The phone's first metadata poll = the knock. It reports 'pending'.
    const knock = await fetch(
      `${base}/api/mobile/run?run=${RUN_ID}&m=${share.token}&device=phone-1`,
      { headers: { 'user-agent': 'iPhone Test UA' } },
    );
    expect(knock.status).toBe(200);
    expect(((await knock.json()) as { approval: string }).approval).toBe('pending');

    // 2. A ws attempt while pending fails closed (403 upgrade rejection).
    const rejected = wsClient(
      `${wsBase}/ws/runs/${RUN_ID}?token=${share.token}&device=phone-1`,
    );
    await expect(rejected.opened).rejects.toThrow(/403/);

    // 3. Desktop side sees the knock in the monitor…
    const monitor = (await (await fetch(`${base}/api/shares`)).json()) as {
      devices: Array<{ deviceId: string; ip: string; state: string; userAgent: string }>;
    };
    expect(monitor.devices).toHaveLength(1);
    expect(monitor.devices[0]).toMatchObject({
      deviceId: 'phone-1',
      state: 'pending',
      userAgent: 'iPhone Test UA',
    });

    // …and a master (desktop) terminal is attached to watch events.
    const master = wsClient(`${wsBase}/ws/runs/${RUN_ID}?token=${getToken()}`);
    await master.opened;
    expect(await master.next()).toMatchObject({ type: 'ready' }); // no backlog yet
    // A newly attached master is brought up to date on devices it missed —
    // phone-1's knock predates this socket (fixes blank indicators on reload).
    expect(await master.next()).toMatchObject({
      type: 'device',
      event: 'snapshot',
      device: { deviceId: 'phone-1', state: 'pending' },
    });

    // 4. Desktop allows the phone.
    const allow = await fetch(`${base}/api/runs/${RUN_ID}/devices/phone-1`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ action: 'allow' }),
    });
    expect(allow.status).toBe(200);
    // The verdict is pushed live to the watching desktop terminal…
    expect(await master.next()).toMatchObject({
      type: 'device',
      event: 'approved',
      device: { deviceId: 'phone-1' },
    });

    // 5. The phone connects: authoritative grid FIRST (spawn default 80x30),
    //    then ready. Never a backlog byte before the grid.
    const phone = wsClient(`${wsBase}/ws/runs/${RUN_ID}?token=${share.token}&device=phone-1`);
    await phone.opened;
    expect(await phone.next()).toMatchObject({ type: 'resize', cols: 80, rows: 30 });
    expect(await phone.next()).toMatchObject({ type: 'ready' });

    // The desktop is told the phone connected (toolbar indicator).
    expect(await master.next()).toMatchObject({
      type: 'device',
      event: 'connected',
      device: { deviceId: 'phone-1' },
    });

    // 6. The phone claims the grid ("Fit" button) → the pty resizes ONCE and
    //    the desktop adopts the same grid via broadcast.
    phone.ws.send(JSON.stringify({ type: 'resize', cols: 44, rows: 22 }));
    expect(await master.next()).toMatchObject({ type: 'resize', cols: 44, rows: 22 });
    expect(resizes).toEqual([[44, 22]]);

    // A repeat of the SAME grid is a no-op: no pty reflow, no re-broadcast.
    phone.ws.send(JSON.stringify({ type: 'resize', cols: 44, rows: 22 }));
    // (Give it a beat; nothing should arrive and the transport stays at 1 call.)
    await new Promise((r) => setTimeout(r, 150));
    expect(resizes).toEqual([[44, 22]]);

    // 7. The monitor shows a live connection.
    const live = (await (await fetch(`${base}/api/shares`)).json()) as {
      devices: Array<{ state: string; connections: number }>;
    };
    expect(live.devices[0]).toMatchObject({ state: 'approved', connections: 1 });

    // 8. Deny = kick: the phone's socket closes with 4403 and can't come back.
    await fetch(`${base}/api/runs/${RUN_ID}/devices/phone-1`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ action: 'deny' }),
    });
    expect((await phone.closed).code).toBe(4403);
    const again = wsClient(`${wsBase}/ws/runs/${RUN_ID}?token=${share.token}&device=phone-1`);
    await expect(again.opened).rejects.toThrow(/403/);
    // The phone's poll now reports the verdict (drives its "denied" screen).
    const denied = (await (
      await fetch(`${base}/api/mobile/run?run=${RUN_ID}&m=${share.token}&device=phone-1`)
    ).json()) as { approval: string };
    expect(denied.approval).toBe('denied');

    master.ws.close();
  }, 15000);

  it('rejects a share ws with no device id at all (fail closed)', async () => {
    const fake = fakeTransport();
    registerRun(`${RUN_ID}-2`, fake.transport);
    const share = mintShare(`${RUN_ID}-2`);
    const noDevice = wsClient(`${wsBase}/ws/runs/${RUN_ID}-2?token=${share.token}`);
    await expect(noDevice.opened).rejects.toThrow(/403/);
  });

  // Regression: a share dying must SEVER live sockets. The token used to be
  // checked only at upgrade, so a revoked (or view-only-flipped) phone kept
  // streaming and typing for as long as any other share held the relay open.
  it('revoking a share kicks its live phone sockets (4410) and blocks reconnects', async () => {
    const fake = fakeTransport();
    const runId = `${RUN_ID}-3`;
    registerRun(runId, fake.transport);
    const share = mintShare(runId);

    await fetch(`${base}/api/mobile/run?run=${runId}&m=${share.token}&device=p3`);
    await fetch(`${base}/api/runs/${runId}/devices/p3`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ action: 'allow' }),
    });
    const phone = wsClient(`${wsBase}/ws/runs/${runId}?token=${share.token}&device=p3`);
    await phone.opened;
    expect(await phone.next()).toMatchObject({ type: 'resize' });
    expect(await phone.next()).toMatchObject({ type: 'ready' });

    revokeShare(share.id);
    expect((await phone.closed).code).toBe(4410);
    const again = wsClient(`${wsBase}/ws/runs/${runId}?token=${share.token}&device=p3`);
    await expect(again.opened).rejects.toThrow(/401/);
  });
});
