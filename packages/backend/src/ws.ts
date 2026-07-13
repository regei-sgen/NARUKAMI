import type { Server } from 'node:http';
import { URL } from 'node:url';
import { WebSocketServer, type WebSocket } from 'ws';
import { prisma } from './db';
import { isAllowedHost, isAllowedOrigin, isValidToken } from './auth';
import { onShareRevoked, validateShare } from './services/shareTokens';
import { relayPeerAddress } from './services/lanRelay';
import {
  deviceConnected,
  deviceDisconnected,
  getDevice,
  listDevices,
  onDeviceEvent,
  touchDevice,
  type MobileDevice,
} from './services/mobileDevices';
import {
  attach,
  getFinalState,
  getFinalTranscript,
  getRunSize,
  resizeRun,
  writeToRun,
} from './services/runner';

interface ClientMessage {
  type: 'input' | 'resize';
  data?: string;
  cols?: number;
  rows?: number;
}

const RUN_WS_RE = /^\/ws\/runs\/([^/?]+)$/;

// ── connection registries ─────────────────────────────────────────────────────
// Master (desktop) sockets per runId: device approval/monitor events for a run
// are pushed here so the Allow/Deny prompt appears right on the shared terminal.
const masterSockets = new Map<string, Set<WebSocket>>();
// Share (phone) sockets per (runId, deviceId): a Deny must kick live streams.
const shareSockets = new Map<string, Set<WebSocket>>();

function shareKey(runId: string, deviceId: string): string {
  return `${runId} ${deviceId}`;
}

function addTo(map: Map<string, Set<WebSocket>>, key: string, ws: WebSocket): void {
  let set = map.get(key);
  if (!set) {
    set = new Set();
    map.set(key, set);
  }
  set.add(ws);
}

function removeFrom(map: Map<string, Set<WebSocket>>, key: string, ws: WebSocket): void {
  const set = map.get(key);
  if (!set) return;
  set.delete(ws);
  if (set.size === 0) map.delete(key);
}

/** Wire shape of a device pushed to the desktop / returned by /api/shares. */
export function publicDevice(d: MobileDevice): {
  deviceId: string;
  runId: string;
  ip: string;
  userAgent: string;
  state: string;
  firstSeen: number;
  lastSeen: number;
  connections: number;
} {
  return {
    deviceId: d.deviceId,
    runId: d.runId,
    ip: d.ip,
    userAgent: d.userAgent,
    state: d.state,
    firstSeen: d.firstSeen,
    lastSeen: d.lastSeen,
    connections: d.connections,
  };
}

/** Attach a raw `ws` server to Fastify's HTTP server for live terminal streams. */
export function setupWebSocket(server: Server): void {
  const wss = new WebSocketServer({ noServer: true });

  // Device lifecycle → desktop push + deny enforcement. One global listener; it
  // routes by runId to the desktop sockets watching that terminal.
  onDeviceEvent((event) => {
    const payload = JSON.stringify({
      type: 'device',
      event: event.kind,
      device: publicDevice(event.device),
    });
    for (const ws of masterSockets.get(event.device.runId) ?? []) {
      if (ws.readyState === ws.OPEN) ws.send(payload);
    }
    // Deny is a kick; so is removal (the run's shares all died — without this
    // the socket, authenticated once at upgrade, would stream forever as long
    // as ANY other share kept the relay up).
    if (event.kind === 'denied' || event.kind === 'removed') {
      const set = shareSockets.get(shareKey(event.device.runId, event.device.deviceId));
      for (const ws of set ?? []) {
        try {
          ws.close(4403, event.kind === 'denied' ? 'Access denied.' : 'Share ended.');
        } catch {
          /* noop */
        }
      }
    }
  });

  // A share died (revoked, expired, or view-only re-mint). Kick the run's live
  // phone sockets: their auth (canInput included) was frozen at upgrade against
  // a token that may no longer exist or has different rights. A phone holding a
  // still-valid share simply reconnects and re-authenticates.
  onShareRevoked((runId) => {
    for (const [key, set] of shareSockets) {
      if (!key.startsWith(`${runId} `)) continue;
      for (const ws of set) {
        try {
          ws.close(4410, 'Share revoked.');
        } catch {
          /* noop */
        }
      }
    }
  });

  server.on('upgrade', (req, socket, head) => {
    let url: URL;
    try {
      url = new URL(req.url ?? '', `http://${req.headers.host ?? '127.0.0.1'}`);
    } catch {
      socket.destroy();
      return;
    }

    const match = RUN_WS_RE.exec(url.pathname);
    if (!match) {
      socket.write('HTTP/1.1 404 Not Found\r\n\r\n');
      socket.destroy();
      return;
    }

    // Reject cross-site / non-loopback connections (prevents a malicious page
    // in the browser from opening our terminal socket).
    if (!isAllowedOrigin(req.headers.origin) || !isAllowedHost(req.headers.host)) {
      socket.write('HTTP/1.1 403 Forbidden\r\n\r\n');
      socket.destroy();
      return;
    }

    const runId = match[1];
    // Two credentials are accepted: the master token (desktop/loopback — full
    // access), OR a per-terminal share token that is SCOPED to exactly this runId
    // (a phone over the LAN relay). A share token for run A can never open run B.
    const token = url.searchParams.get('token');
    let canInput = true;
    let canResize = true;
    let isMaster = true;
    let deviceId: string | null = null;
    if (isValidToken(token)) {
      canInput = true;
    } else {
      isMaster = false;
      const share = validateShare(token, runId);
      if (!share) {
        socket.write('HTTP/1.1 401 Unauthorized\r\n\r\n');
        socket.destroy();
        return;
      }
      // Device approval gate: holding the share token is no longer enough — the
      // desktop must have allowed THIS device. Record the attempt (it surfaces
      // the Allow/Deny prompt) and fail closed until state is 'approved'.
      deviceId = url.searchParams.get('device');
      if (!deviceId) {
        socket.write('HTTP/1.1 403 Forbidden\r\n\r\n');
        socket.destroy();
        return;
      }
      const ip = relayPeerAddress(req.socket.remotePort) ?? req.socket.remoteAddress ?? 'unknown';
      const ua = String(req.headers['user-agent'] ?? '');
      touchDevice(runId, deviceId, ip, ua);
      const device = getDevice(runId, deviceId);
      if (!device || device.state !== 'approved') {
        socket.write('HTTP/1.1 403 Forbidden\r\n\r\n');
        socket.destroy();
        return;
      }
      // A read-only mirror (canInput:false) may watch but never type — and never
      // resize the shared pty either (its view mirrors the desktop's grid). An
      // input-capable phone may resize, but only does so via an explicit user
      // action ("fit" button), not automatically on connect.
      canInput = share.canInput;
      canResize = share.canInput;
    }

    wss.handleUpgrade(req, socket, head, (ws) => {
      handleConnection(ws, runId, { canInput, canResize, isMaster, deviceId }).catch(() => {
        try {
          ws.close();
        } catch {
          /* noop */
        }
      });
    });
  });
}

function send(ws: WebSocket, payload: unknown): void {
  if (ws.readyState === ws.OPEN) ws.send(JSON.stringify(payload));
}

// Serialize each runner event ONCE no matter how many sockets are attached.
// The runner fans out one shared event object per batch; a desktop tab plus a
// phone mirror (plus a pop-out) would otherwise re-stringify byte-identical
// payloads — up to one 256KB chunk per 8ms during output storms.
const wireCache = new WeakMap<object, string>();
function sendShared(ws: WebSocket, event: object, payload: () => unknown): void {
  if (ws.readyState !== ws.OPEN) return;
  let wire = wireCache.get(event);
  if (wire === undefined) {
    wire = JSON.stringify(payload());
    wireCache.set(event, wire);
  }
  ws.send(wire);
}

interface ConnectionAuth {
  canInput: boolean;
  canResize: boolean;
  isMaster: boolean;
  deviceId: string | null;
}

async function handleConnection(
  ws: WebSocket,
  runId: string,
  auth: ConnectionAuth,
): Promise<void> {
  // Fast path: the run is live. attach() atomically hands us the full in-memory
  // transcript AND subscribes us to future output, so there is no gap between
  // "history" and "live" — every byte arrives exactly once.
  const attachment = attach(runId, (event) => {
    if (event.type === 'data') {
      sendShared(ws, event, () => ({ type: 'data', chunk: event.chunk }));
    } else if (event.type === 'resize') {
      // Another client resized the pty — tell this one so every attached view
      // adopts the one true grid instead of rendering mis-wrapped output.
      sendShared(ws, event, () => ({ type: 'resize', cols: event.cols, rows: event.rows }));
    } else {
      sendShared(ws, event, () => ({ type: 'exit', status: event.status, exitCode: event.exitCode }));
      ws.close();
    }
  });

  if (attachment) {
    // For mirrors (phones): authoritative grid FIRST so the backlog repaints
    // into the right geometry — a phone adopts this size rather than imposing
    // its own. Masters skip it: the desktop sends its own fit right after open,
    // and adopting a stale grid for one round trip would just flash.
    if (!auth.isMaster) {
      const size = getRunSize(runId);
      if (size) send(ws, { type: 'resize', cols: size.cols, rows: size.rows });
    }
    if (attachment.backlog) send(ws, { type: 'data', chunk: attachment.backlog });
    // Explicit "the run is live" signal so the client can show 'running' only for
    // an actually-live run — a dead/restored run reaches the slow path below and
    // gets an 'exit' instead, so it never flashes 'running'.
    send(ws, { type: 'ready' });

    // Register for pushes/kicks + the connected-devices monitor.
    if (auth.isMaster) {
      addTo(masterSockets, runId, ws);
      // Snapshot of devices already known for this run — a freshly mounted
      // master (window reload, pop-out) would otherwise show no phone
      // indicator while a phone is actively streaming (pushes are incremental).
      for (const d of listDevices(runId)) {
        send(ws, { type: 'device', event: 'snapshot', device: publicDevice(d) });
      }
    } else if (auth.deviceId) {
      addTo(shareSockets, shareKey(runId, auth.deviceId), ws);
      deviceConnected(runId, auth.deviceId);
    }

    ws.on('message', (raw) => handleClientMessage(runId, raw, auth.canInput, auth.canResize));
    ws.on('close', () => {
      attachment.unsubscribe();
      if (auth.isMaster) {
        removeFrom(masterSockets, runId, ws);
      } else if (auth.deviceId) {
        removeFrom(shareSockets, shareKey(runId, auth.deviceId), ws);
        deviceDisconnected(runId, auth.deviceId);
      }
    });
    return;
  }

  // Slow path: the run isn't live. During the brief window AFTER the pty exited
  // but BEFORE its final log flush committed and the record was deleted, the full
  // transcript still lives in memory — including the tail not yet in the DB.
  // Prefer it so a reconnect in that window doesn't replay a truncated history.
  const memTranscript = getFinalTranscript(runId);
  if (memTranscript !== null) {
    if (memTranscript) send(ws, { type: 'data', chunk: memTranscript });
    const finalState = getFinalState(runId);
    send(ws, {
      type: 'exit',
      status: finalState?.status ?? 'exited',
      exitCode: finalState?.exitCode ?? null,
    });
    ws.close();
    return;
  }

  // Otherwise the record is gone — replay the persisted history from the DB and
  // report the final status.
  const run = await prisma.run.findUnique({
    where: { id: runId },
    include: { logs: { orderBy: { ts: 'asc' } } },
  });

  if (!run) {
    send(ws, { type: 'error', message: 'Run not found.' });
    ws.close();
    return;
  }

  const history = run.logs.map((l) => l.chunk).join('');
  if (history) send(ws, { type: 'data', chunk: history });

  // Prefer the in-memory final status if the pty just exited and its DB write
  // may still be in flight; otherwise the persisted row is authoritative.
  const final = getFinalState(runId);
  send(ws, {
    type: 'exit',
    status: final?.status ?? run.status,
    exitCode: final ? final.exitCode : run.exitCode ?? null,
  });
  ws.close();
}

export function handleClientMessage(
  runId: string,
  raw: unknown,
  canInput = true,
  canResize = canInput,
): void {
  let msg: ClientMessage;
  try {
    msg = JSON.parse(String(raw)) as ClientMessage;
  } catch {
    return;
  }
  if (msg.type === 'input' && typeof msg.data === 'string') {
    // A read-only share (canInput:false) may watch but never write to the pty —
    // drop input silently so a mirror can't type into your session.
    if (!canInput) return;
    writeToRun(runId, msg.data);
  } else if (
    msg.type === 'resize' &&
    typeof msg.cols === 'number' &&
    typeof msg.rows === 'number'
  ) {
    // Resize is likewise gated: a mirror adopting the desktop's grid must never
    // be able to shrink the desktop's pty underneath it.
    if (!canResize) return;
    resizeRun(runId, msg.cols, msg.rows);
  }
}
