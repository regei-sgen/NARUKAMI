import type { FastifyInstance } from 'fastify';
import { prisma } from '../db';
import { getToken } from '../auth';
import { isRunning } from '../services/runner';
import {
  getSharePort,
  isShareEnabled,
  lanAddresses,
  SHARE_SETTING_KEY,
} from '../services/share';
import { MOBILE_HTML } from '../services/mobilePage';

export async function shareRoutes(app: FastifyInstance): Promise<void> {
  // Current phone-access state + everything the desktop UI needs to build a
  // project's QR code: the LAN addresses, the bound port, and the token. (This
  // endpoint is token-gated + loopback/LAN-guarded like the rest of /api.)
  app.get('/api/share', async () => ({
    enabled: isShareEnabled(),
    port: getSharePort(),
    addresses: lanAddresses(),
    token: getToken(),
  }));

  // Toggle phone access. Persisted to AppSetting; the actual bind (127.0.0.1 vs
  // 0.0.0.0) is chosen at startup, so a change needs the app to restart.
  app.post<{ Body: { enabled?: boolean } }>('/api/share', async (req) => {
    const on = req.body?.enabled === true;
    await prisma.appSetting.upsert({
      where: { key: SHARE_SETTING_KEY },
      create: { key: SHARE_SETTING_KEY, value: JSON.stringify(on) },
      update: { value: JSON.stringify(on) },
    });
    // needsRestart when the desired state differs from what we booted with.
    return { enabled: on, needsRestart: on !== isShareEnabled() };
  });

  // A project's processes with live status + human labels — the phone dashboard.
  // Most-recent first, capped. Merges the in-memory liveness with the DB row.
  app.get<{ Params: { id: string } }>('/api/projects/:id/processes', async (req, reply) => {
    const project = await prisma.project.findUnique({ where: { id: req.params.id } });
    if (!project) return reply.code(404).send({ error: 'Project not found.' });

    const runs = await prisma.run.findMany({
      where: { projectId: project.id },
      orderBy: { startedAt: 'desc' },
      take: 40,
      include: { command: true },
    });

    return {
      project: { id: project.id, name: project.name, path: project.path },
      processes: runs.map((r) => {
        const live = isRunning(r.id);
        return {
          runId: r.id,
          kind: r.kind,
          name: r.name,
          label: r.name ?? (r.kind === 'command' ? r.command?.label ?? 'command' : r.kind),
          live,
          status: live ? 'running' : r.status,
          exitCode: r.exitCode,
          startedAt: r.startedAt,
          endedAt: r.endedAt,
        };
      }),
    };
  });

  // The self-contained mobile page. Public HTML (no secrets inside) — its API/WS
  // calls carry the token from the QR's query string. The onRequest hook in
  // index.ts restricts reachability to loopback / private-LAN (when sharing is on).
  app.get('/m', async (_req, reply) => reply.type('text/html; charset=utf-8').send(MOBILE_HTML));
}
