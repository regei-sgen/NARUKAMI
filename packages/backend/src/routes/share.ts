import type { FastifyInstance } from 'fastify';
import { prisma } from '../db';
import { isRunning } from '../services/runner';
import { createShare, removeShare, relayStatus } from '../services/mobileShare';
import { listShares, validateShare } from '../services/shareTokens';
import { relayPeerAddress } from '../services/lanRelay';
import { listDevices, setDeviceState, touchDevice } from '../services/mobileDevices';
import { publicDevice } from '../ws';

/**
 * Mobile-share routes. Two audiences, two auth models:
 *  - The desktop (master-token-gated by the global onRequest hook): create, list,
 *    and revoke shares. These live under /api/runs and /api/shares.
 *  - The phone (NO master token — it never left the machine): /api/mobile/*,
 *    which the onRequest hook exempts from master auth; each endpoint instead
 *    validates the per-terminal share token itself and is scoped to one run.
 */
export async function shareRoutes(app: FastifyInstance): Promise<void> {
  // ── desktop side (master-token-gated) ──────────────────────────────────────

  // Create a LAN share for one terminal → returns the QR URL (contains the
  // secret token). Starts the relay if it wasn't already running.
  app.post<{ Params: { runId: string }; Body: { canInput?: boolean; ttlMs?: number } }>(
    '/api/runs/:runId/share',
    async (req, reply) => {
      const run = await prisma.run.findUnique({ where: { id: req.params.runId } });
      if (!run) return reply.code(404).send({ error: 'Run not found.' });
      // Only live terminals are worth sharing — a dead pty can't stream to a phone.
      if (!isRunning(run.id)) {
        return reply.code(409).send({ error: 'This terminal is not live.' });
      }
      const canInput = req.body?.canInput ?? true;
      const ttlMs = typeof req.body?.ttlMs === 'number' ? req.body.ttlMs : undefined;
      try {
        const result = await createShare(run.id, { canInput, ttlMs });
        return result;
      } catch (e) {
        // Most likely: no routable LAN interface (offline / loopback-only).
        return reply.code(503).send({ error: (e as Error).message });
      }
    },
  );

  // List active shares (for the desktop's "sharing" UI). Never includes secrets.
  // `devices` is the monitor: every phone that has knocked (pending), been
  // allowed/denied, and how many live streams each holds right now.
  app.get('/api/shares', async () => {
    return { shares: listShares(), relay: relayStatus(), devices: listDevices().map(publicDevice) };
  });

  // Desktop verdict on a knocking device: allow it to stream, or deny it (which
  // also kicks any of its live sockets — see the ws-side deny handler).
  app.post<{ Params: { runId: string; deviceId: string }; Body: { action?: string } }>(
    '/api/runs/:runId/devices/:deviceId',
    async (req, reply) => {
      const action = req.body?.action;
      if (action !== 'allow' && action !== 'deny') {
        return reply.code(400).send({ error: "action must be 'allow' or 'deny'." });
      }
      const device = setDeviceState(
        req.params.runId,
        req.params.deviceId,
        action === 'allow' ? 'approved' : 'denied',
      );
      if (!device) return reply.code(404).send({ error: 'Device not found.' });
      return { device: publicDevice(device) };
    },
  );

  // Revoke a share; stops the relay if it was the last one.
  app.delete<{ Params: { id: string } }>('/api/shares/:id', async (req, reply) => {
    const removed = await removeShare(req.params.id);
    if (!removed) return reply.code(404).send({ error: 'Share not found.' });
    return { ok: true };
  });

  // ── phone side (share-token-gated, exempt from master auth) ────────────────

  // Metadata + liveness for the one shared terminal. The mobile terminal polls
  // this to drive its reconnect loop, exactly like the desktop polls /api/runs/:id.
  // The phone also identifies itself here (`device`) — its first poll is what
  // creates the 'pending' entry that prompts Allow/Deny on the desktop, and the
  // returned `approval` drives the phone's waiting/denied screens.
  app.get<{ Querystring: { run?: string; m?: string; device?: string } }>(
    '/api/mobile/run',
    async (req, reply) => {
      const runId = req.query.run;
      const token = req.query.m;
      if (!runId) return reply.code(400).send({ error: 'run is required.' });
      const share = validateShare(token, runId);
      if (!share) return reply.code(401).send({ error: 'Invalid or expired share.' });

      const run = await prisma.run.findUnique({
        where: { id: runId },
        include: { project: true, command: true },
      });
      if (!run) return reply.code(404).send({ error: 'Run not found.' });

      // Record the sighting. The phone's real LAN address is behind the raw-TCP
      // relay, so resolve it via the relay's peer map (loopback fallback covers
      // direct/local requests, e.g. tests).
      let approval: string = 'pending';
      const deviceId = req.query.device;
      if (deviceId) {
        const ip =
          relayPeerAddress(req.raw.socket.remotePort) ?? req.raw.socket.remoteAddress ?? 'unknown';
        const device = touchDevice(runId, deviceId, ip, String(req.headers['user-agent'] ?? ''));
        approval = device ? device.state : 'denied'; // registry full/invalid id → fail closed
      }

      return {
        runId: run.id,
        projectName: run.project.name,
        kind: run.kind,
        label: run.name ?? (run.kind === 'command' ? run.command?.label ?? 'command' : run.kind),
        live: isRunning(run.id),
        status: run.status,
        exitCode: run.exitCode,
        canInput: share.canInput,
        expiresAt: share.expiresAt,
        approval,
      };
    },
  );
}
