import type { Server } from 'node:http';
import { URL } from 'node:url';
import { WebSocketServer, type WebSocket } from 'ws';
import { prisma } from './db';
import { isAllowedHost, isAllowedOrigin, isValidToken } from './auth';
import { attach, getFinalState, resizeRun, writeToRun } from './services/runner';

interface ClientMessage {
  type: 'input' | 'resize';
  data?: string;
  cols?: number;
  rows?: number;
}

const RUN_WS_RE = /^\/ws\/runs\/([^/?]+)$/;

/** Attach a raw `ws` server to Fastify's HTTP server for live terminal streams. */
export function setupWebSocket(server: Server): void {
  const wss = new WebSocketServer({ noServer: true });

  server.on('upgrade', (req, socket, head) => {
    let url: URL;
    try {
      url = new URL(req.url ?? '', `http://${req.headers.host ?? '127.0.0.1'}`);
    } catch {
      socket.destroy();
      return;
    }

    const runMatch = RUN_WS_RE.exec(url.pathname);
    if (!runMatch) {
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

    if (!isValidToken(url.searchParams.get('token'))) {
      socket.write('HTTP/1.1 401 Unauthorized\r\n\r\n');
      socket.destroy();
      return;
    }

    const runId = runMatch[1];
    wss.handleUpgrade(req, socket, head, (ws) => {
      handleConnection(ws, runId).catch(() => {
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

async function handleConnection(ws: WebSocket, runId: string): Promise<void> {
  // Fast path: the run is live. attach() atomically hands us the full in-memory
  // transcript AND subscribes us to future output, so there is no gap between
  // "history" and "live" — every byte arrives exactly once.
  const attachment = attach(runId, (event) => {
    if (event.type === 'data') {
      send(ws, { type: 'data', chunk: event.chunk });
    } else {
      send(ws, { type: 'exit', status: event.status, exitCode: event.exitCode });
      ws.close();
    }
  });

  if (attachment) {
    if (attachment.backlog) send(ws, { type: 'data', chunk: attachment.backlog });

    ws.on('message', (raw) => handleClientMessage(runId, raw));
    ws.on('close', () => attachment.unsubscribe());
    return;
  }

  // Slow path: the run isn't live (already finished, or unknown). Replay the
  // persisted history from the DB and report the final status.
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

export function handleClientMessage(runId: string, raw: unknown): void {
  let msg: ClientMessage;
  try {
    msg = JSON.parse(String(raw)) as ClientMessage;
  } catch {
    return;
  }
  if (msg.type === 'input' && typeof msg.data === 'string') {
    writeToRun(runId, msg.data);
  } else if (
    msg.type === 'resize' &&
    typeof msg.cols === 'number' &&
    typeof msg.rows === 'number'
  ) {
    resizeRun(runId, msg.cols, msg.rows);
  }
}
