import type { FastifyInstance } from 'fastify';
import { prisma } from '../db';
import { isRunning } from '../services/runner';

export async function workspaceRoutes(app: FastifyInstance): Promise<void> {
  // The full restorable workspace: open terminal tabs + persisted UI settings.
  app.get('/api/workspace', async () => {
    const runs = await prisma.run.findMany({
      where: { dockOpen: true },
      orderBy: { startedAt: 'asc' },
      include: { command: true, project: true },
    });

    const settingsRows = await prisma.appSetting.findMany();
    const settings: Record<string, unknown> = {};
    for (const s of settingsRows) {
      try {
        settings[s.key] = JSON.parse(s.value);
      } catch {
        settings[s.key] = s.value;
      }
    }

    return {
      runs: runs.map((r) => {
        const live = isRunning(r.id);
        return {
          runId: r.id,
          projectId: r.projectId,
          projectName: r.project.name,
          kind: r.kind,
          name: r.name,
          label: r.kind === 'command' ? r.command?.label ?? 'command' : r.kind,
          live,
          status: live ? 'running' : 'exited',
        };
      }),
      settings,
    };
  });

  // Bulk-upsert UI settings. Body = { [key]: jsonValue }. POST (not PUT) to stay
  // within the CORS method allowlist.
  app.post<{ Body: Record<string, unknown> }>('/api/settings', async (req, reply) => {
    const body = req.body;
    if (!body || typeof body !== 'object' || Array.isArray(body)) {
      return reply.code(400).send({ error: 'Body must be an object of key → value.' });
    }
    const entries = Object.entries(body);
    if (entries.length) {
      await prisma.$transaction(
        entries.map(([key, value]) =>
          prisma.appSetting.upsert({
            where: { key },
            create: { key, value: JSON.stringify(value) },
            update: { value: JSON.stringify(value) },
          }),
        ),
      );
    }
    return { ok: true, saved: entries.length };
  });
}
