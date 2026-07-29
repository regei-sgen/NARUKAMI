import net from 'node:net';
import os from 'node:os';

/**
 * On-demand LAN relay: a raw TCP proxy bound to the machine's LAN interface that
 * pipes bytes straight to the loopback backend. It exists ONLY while at least one
 * terminal is being shared to a phone; stopping it is a hard kill switch that
 * severs all LAN reachability without touching the loopback Fastify server.
 *
 * Why a relay instead of binding Fastify to 0.0.0.0: the relay is runtime on/off
 * (share → start, last share revoked → stop) and never widens the loopback
 * server's own bind. HTTP and WebSocket upgrade both pass through untouched —
 * it's a byte pipe, it doesn't parse the protocol (verified by spike).
 *
 * SECURITY: turning the relay on is what makes the box reachable from the LAN.
 * The share-token layer (scoped, TTL'd) and the tokenless-SPA gating in index.ts
 * are what keep that reachability safe. `activeLanAddress()` is the single source
 * of truth other modules (auth host/origin widening) consult to know whether LAN
 * access is currently permitted and from which address.
 */

export interface LanAddress {
  host: string; // the LAN IPv4 the relay is bound to (e.g. 192.168.1.42)
  port: number; // the relay's listen port
}

let server: net.Server | null = null;
let bound: LanAddress | null = null;
let targetPort = 0; // loopback port we forward to
// Live client sockets, so stopRelay() can force-drop them (net.Server has no
// closeAllConnections() — that's an http.Server method — so we track our own).
const openSockets = new Set<net.Socket>();
// Because the relay is a raw byte pipe, the backend sees every relayed request
// as coming from 127.0.0.1. To still know WHO is on the other end (device
// approval prompts + the connected-devices monitor), map the loopback leg's
// ephemeral source port → the LAN client's real address. The backend looks its
// peer up via req.socket.remotePort.
const peerByUpstreamPort = new Map<number, string>();

/**
 * Best LAN IPv4 for this machine: the first non-internal IPv4 that isn't a
 * link-local (169.254.x) address. Returns null when the machine has no routable
 * LAN interface (e.g. offline) — the caller then refuses to start a share.
 */
export function detectLanIp(): string | null {
  const ifaces = os.networkInterfaces();
  const candidates: string[] = [];
  for (const addrs of Object.values(ifaces)) {
    for (const a of addrs ?? []) {
      if (a.family !== 'IPv4' || a.internal) continue;
      if (a.address.startsWith('169.254.')) continue; // link-local, not routable
      candidates.push(a.address);
    }
  }
  // Prefer private LAN ranges (192.168 / 10 / 172.16-31) over anything else.
  const isPrivate = (ip: string): boolean =>
    ip.startsWith('192.168.') ||
    ip.startsWith('10.') ||
    /^172\.(1[6-9]|2\d|3[01])\./.test(ip);
  return candidates.find(isPrivate) ?? candidates[0] ?? null;
}

/** The relay's current LAN address, or null when it isn't running. */
export function activeLanAddress(): LanAddress | null {
  return bound;
}

/**
 * Real LAN address of the client behind a relayed connection, looked up by the
 * loopback socket's remote (= the relay upstream's local) port. Null for
 * connections that didn't come through the relay (e.g. the desktop on loopback).
 */
export function relayPeerAddress(remotePort: number | undefined): string | null {
  if (typeof remotePort !== 'number') return null;
  return peerByUpstreamPort.get(remotePort) ?? null;
}

/** Is the LAN relay currently accepting connections? */
export function isRelayRunning(): boolean {
  return server !== null && bound !== null;
}

/**
 * Start the relay (idempotent — a second call while running just returns the
 * current address). Binds to the detected LAN IP and forwards every connection
 * to `loopbackPort` on 127.0.0.1.
 */
export async function startRelay(loopbackPort: number): Promise<LanAddress> {
  if (bound) return bound;
  const lanIp = detectLanIp();
  if (!lanIp) throw new Error('No routable LAN interface found — connect to a network first.');
  targetPort = loopbackPort;

  const srv = net.createServer((client) => {
    // Forward to the loopback backend. The backend sees Host: <lan-ip>:<port>
    // (the phone's target), which auth.ts accepts ONLY while this relay is up.
    const upstream = net.connect(targetPort, '127.0.0.1');
    const clientAddr = client.remoteAddress ?? 'unknown';
    // localPort is only known once connected, and unreadable again after close —
    // capture it here for the close-time cleanup.
    let upstreamPort: number | null = null;
    upstream.on('connect', () => {
      if (typeof upstream.localPort === 'number') {
        upstreamPort = upstream.localPort;
        peerByUpstreamPort.set(upstreamPort, clientAddr);
      }
    });
    openSockets.add(client);
    client.pipe(upstream);
    upstream.pipe(client);
    const kill = (): void => {
      client.destroy();
      upstream.destroy();
    };
    client.on('error', kill);
    upstream.on('error', kill);
    client.on('close', () => {
      openSockets.delete(client);
      upstream.destroy();
    });
    upstream.on('close', () => {
      if (upstreamPort !== null) peerByUpstreamPort.delete(upstreamPort);
      client.destroy();
    });
  });

  await new Promise<void>((resolve, reject) => {
    srv.once('error', reject);
    // Port 0 → OS picks a free ephemeral port, avoiding a fixed-port collision.
    srv.listen(0, lanIp, () => {
      srv.removeListener('error', reject);
      resolve();
    });
  });

  const addr = srv.address();
  const port = typeof addr === 'object' && addr ? addr.port : 0;
  server = srv;
  bound = { host: lanIp, port };
  return bound;
}

/** Stop the relay and drop every LAN connection. Idempotent. Hard kill switch. */
export async function stopRelay(): Promise<void> {
  const srv = server;
  server = null;
  bound = null;
  if (!srv) return;
  // close() only stops NEW connections and waits for existing ones to end — a
  // phone holding its socket open would keep the relay alive forever. Force every
  // live client socket shut so "stop sharing" is immediate and total.
  for (const sock of openSockets) sock.destroy();
  openSockets.clear();
  peerByUpstreamPort.clear();
  await new Promise<void>((resolve) => {
    srv.close(() => resolve());
  });
}
