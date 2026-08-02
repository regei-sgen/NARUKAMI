import type { Server } from 'node:http';
import { URL } from 'node:url';
import { WebSocketServer, type WebSocket } from 'ws';
import { prisma } from './db';
import { isAllowedHost, isAllowedOrigin, isTrustedLocalRequest, isValidToken } from './auth';
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
  getLiveTranscriptTail,
  getRunSize,
  LOG_RETENTION_DAYS,
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

// Largest frame we will accept from a client. Everything a client sends is a
// keystroke or a grid; the only large case is a paste, which xterm delivers as
// ONE onData — so this is set well above any realistic paste while still
// stopping an authenticated socket from handing handleClientMessage a 100MB
// JSON.parse. ws answers an over-size frame with close 1009.
const MAX_CLIENT_PAYLOAD_BYTES = 4 * 1024 * 1024;

// Liveness. TCP alone will not tell us a phone locked its screen: the half-open
// socket stays "open" for hours while the runner streams into it.
const PING_INTERVAL_MS = 30_000;

// Backpressure. ws queues everything the kernel hasn't taken in THIS process's
// memory (the Electron main process in packaged mode), and the producer has no
// flow control — runner.ts fans out synchronously and force-flushes at 256KB.
// Past this mark we stop feeding the socket droppable output.
const WS_HIGH_WATER_BYTES = 2 * 1024 * 1024;
// How much of the transcript to re-send once a dropped socket drains. Same
// order as the read endpoint's floor (terminals.ts: Math.max(64 * 1024, …)).
const RESYNC_TAIL_CHARS = 64 * 1024;
const RESYNC_MARKER = '\r\n[output dropped while this device fell behind]\r\n';

// Bounded DB replay for a dead run. Mirrors MAX_TRANSCRIPT_CHARS in runner.ts
// (2_000_000, not exported) so a restored tab sees the same ceiling a live one
// does, instead of the whole table joined into one frame.
const REPLAY_MAX_CHARS = 2_000_000;
const REPLAY_MAX_ROWS = 5000;
const REPLAY_CHUNK_CHARS = 256 * 1024;
const TRUNCATION_MARKER = '[earlier output truncated]\r\n';
// A replay with ZERO rows must still say something. The join produced '' and the
// chunking loop then sent no data frame at all, so a restored tab came back
// completely blank and read as broken — seven of the nine pinned runs in the
// live desktop DB are in exactly that state, emptied by an older retention
// sweep that did not exempt dockOpen runs. Which of the two markers applies is
// decided by age, because only one of the causes is retention.
const PRUNED_MARKER = '[history older than the retention window was pruned]\r\n';
const NO_OUTPUT_MARKER = '[this run recorded no output]\r\n';

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

/** A socket carrying its liveness flag (the standard `ws` heartbeat idiom). */
interface LiveSocket extends WebSocket {
  isAlive?: boolean;
}

/** Record that a socket answered (upgrade or 'pong'). */
export function markAlive(ws: WebSocket): void {
  (ws as LiveSocket).isAlive = true;
}

/**
 * One heartbeat pass: terminate every socket that did not answer the PREVIOUS
 * ping, then ping the rest. terminate() still emits 'close', so a half-open
 * socket runs the same cleanup an honest disconnect does — the runner
 * subscription, the shareSockets registry and deviceDisconnected.
 */
export function heartbeatSweep(clients: Iterable<WebSocket>): void {
  for (const ws of clients) {
    const s = ws as LiveSocket;
    if (s.isAlive === false) {
      try {
        s.terminate();
      } catch {
        /* noop */
      }
      continue;
    }
    s.isAlive = false;
    try {
      s.ping();
    } catch {
      /* noop */
    }
  }
}

/**
 * Attach a raw `ws` server to Fastify's HTTP server for live terminal streams.
 * `pingIntervalMs` exists so a test can watch the heartbeat without waiting the
 * production 30s; callers pass nothing.
 */
export function setupWebSocket(server: Server, opts: { pingIntervalMs?: number } = {}): void {
  const wss = new WebSocketServer({ noServer: true, maxPayload: MAX_CLIENT_PAYLOAD_BYTES });

  // Socket 'close' is the ONLY cleanup path in here, so a half-open connection
  // (screen-locked phone, dropped Wi-Fi) would otherwise keep its subscription,
  // its shareSockets entry and its phantom "connected" indicator forever.
  const heartbeat = setInterval(
    () => heartbeatSweep(wss.clients),
    opts.pingIntervalMs ?? PING_INTERVAL_MS,
  );
  // Never keep the process (or Electron's main loop) alive just for this timer.
  heartbeat.unref();
  wss.on('close', () => clearInterval(heartbeat));

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
    // Master rights come from the SOCKET, never from a header. The relay is a
    // raw byte pipe that forwards Host and Origin untouched, so a phone can
    // forge `Origin: http://127.0.0.1` — and a master token lifted off that
    // pipe would otherwise open a full-rights terminal. Same gate the HTTP
    // surface uses for token injection, so the two can't drift apart.
    const trustedLocal = isTrustedLocalRequest(req.headers.host, req.socket.remotePort);
    // Two credentials are accepted: the master token (desktop/loopback — full
    // access), OR a per-terminal share token that is SCOPED to exactly this runId
    // (a phone over the LAN relay). A share token for run A can never open run B.
    const token = url.searchParams.get('token');
    let canInput = true;
    let canResize = true;
    let isMaster = true;
    let deviceId: string | null = null;
    if (trustedLocal && isValidToken(token)) {
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
      markAlive(ws);
      ws.on('pong', () => markAlive(ws));
      // ws emits 'error' on the socket for protocol violations (an over-size
      // frame past maxPayload) and transport resets. With no listener that is
      // an UNCAUGHT exception in the backend process; 'close' always follows,
      // so the real cleanup still runs and there is nothing to do here.
      ws.on('error', () => {
        /* noop — 'close' does the cleanup */
      });
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
/**
 * Send a runner event. `droppable` marks output that may be sacrificed when the
 * socket is backed up — the client is re-synced from the transcript tail once
 * it drains. Control frames (resize, exit) are NEVER droppable: losing an exit
 * leaves the tab spinning on a run that already ended. Returns false when the
 * frame was not written.
 */
function sendShared(
  ws: WebSocket,
  event: object,
  payload: () => unknown,
  droppable = false,
): boolean {
  if (ws.readyState !== ws.OPEN) return false;
  if (droppable && overHighWater(ws)) return false;
  let wire = wireCache.get(event);
  if (wire === undefined) {
    wire = JSON.stringify(payload());
    wireCache.set(event, wire);
  }
  ws.send(wire);
  return true;
}

/** Is this socket's unflushed send queue past the point we keep feeding it? */
function overHighWater(ws: WebSocket): boolean {
  return (ws.bufferedAmount ?? 0) > WS_HIGH_WATER_BYTES;
}

interface ConnectionAuth {
  canInput: boolean;
  canResize: boolean;
  isMaster: boolean;
  deviceId: string | null;
}

export async function handleConnection(
  ws: WebSocket,
  runId: string,
  auth: ConnectionAuth,
): Promise<void> {
  // Fast path: the run is live. attach() atomically hands us the full in-memory
  // transcript AND subscribes us to future output, so there is no gap between
  // "history" and "live" — every byte arrives exactly once.
  // Backpressure state for THIS socket: once we start dropping batches the
  // client is missing bytes, so we can't just resume mid-stream — the next
  // batch that fits triggers a transcript-tail re-sync instead.
  let behind = false;
  const attachment = attach(runId, (event) => {
    if (event.type === 'data') {
      if (behind) {
        if (overHighWater(ws)) return; // still draining — keep dropping
        behind = false;
        // getFinalTranscript would return null here (the run is LIVE); the tail
        // is the bounded read that exists for exactly this.
        const tail = getLiveTranscriptTail(runId, RESYNC_TAIL_CHARS);
        if (tail !== null) send(ws, { type: 'data', chunk: RESYNC_MARKER + tail });
        return;
      }
      if (!sendShared(ws, event, () => ({ type: 'data', chunk: event.chunk }), true)) {
        behind = ws.readyState === ws.OPEN;
      }
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
    // The backlog is the one pre-stream send that can be megabytes, so it obeys
    // the same mark; a socket already backed up gets the tail re-sync instead.
    if (attachment.backlog) {
      if (overHighWater(ws)) behind = true;
      else send(ws, { type: 'data', chunk: attachment.backlog });
    }
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
  // report the final status. Bounded on BOTH rows and bytes: a pinned run in a
  // real desktop DB reached 3,155 rows / 1.39MB, and loading every row just to
  // join it into ONE frame materialises all of it twice (Prisma objects, then
  // the string) before the socket sees a byte. Newest-first + take, then
  // reverse — the tail is what a restored tab actually wants.
  const run = await prisma.run.findUnique({
    where: { id: runId },
    include: { logs: { orderBy: { ts: 'desc' }, take: REPLAY_MAX_ROWS } },
  });

  if (!run) {
    send(ws, { type: 'error', message: 'Run not found.' });
    ws.close();
    return;
  }

  const newestFirst = run.logs;
  let kept = 0;
  let chars = 0;
  for (const log of newestFirst) {
    // Always keep at least one row, so a single oversized chunk isn't dropped
    // into a replay that shows nothing but the marker.
    if (kept > 0 && chars + log.chunk.length > REPLAY_MAX_CHARS) break;
    chars += log.chunk.length;
    kept += 1;
  }
  const truncated = kept < newestFirst.length || newestFirst.length >= REPLAY_MAX_ROWS;
  const history = newestFirst
    .slice(0, kept)
    .reverse()
    .map((l) => l.chunk)
    .join('');

  // Neither truncation nor an absent history is ever silent, and the replay goes
  // out in a few frames rather than one multi-megabyte send.
  let body: string;
  if (newestFirst.length === 0) {
    // endedAt null (a row still marked running, its pty gone with a previous
    // process) counts as "just now": nothing could have pruned it yet.
    const endedMs = run.endedAt ? run.endedAt.getTime() : Date.now();
    const pruned = Date.now() - endedMs > LOG_RETENTION_DAYS * 24 * 60 * 60 * 1000;
    body = pruned ? PRUNED_MARKER : NO_OUTPUT_MARKER;
  } else {
    body = truncated ? TRUNCATION_MARKER + history : history;
  }
  for (let i = 0; i < body.length; i += REPLAY_CHUNK_CHARS) {
    send(ws, { type: 'data', chunk: body.slice(i, i + REPLAY_CHUNK_CHARS) });
  }

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
