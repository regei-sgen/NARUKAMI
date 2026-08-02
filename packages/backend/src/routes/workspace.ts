import type { FastifyInstance } from 'fastify';
import { prisma } from '../db';
import { isRunning } from '../services/runner';
import { openInBrowser, validateDevUrl } from '../services/openUrl';
import { AI_SETTING_KEY } from '../services/aiProvider';

/**
 * The AppSetting keys /api/workspace is allowed to hand back — deliberately the
 * two the UI actually restores (App.tsx reads `settings.ui` and `settings.prefs`
 * on boot), NOT everything in the table. The same table also holds the AI config
 * with the RAW Anthropic key (aiProvider.ts) and the EOD digest cache
 * (`eodDigest:<hash>`, tens of KB), and this endpoint runs on every boot, every
 * re-dock and every pop-out. Adding a key here is how a new UI setting becomes
 * restorable; secrets get a dedicated masked route instead (routes/settings.ts).
 */
const UI_SETTING_KEYS = ['ui', 'prefs'] as const;

// Bounds for the generic bulk-upsert. It used to accept any key name, any count
// and any value size — one POST could bloat the table without limit.
const MAX_SETTING_KEYS = 32;
const MAX_SETTING_VALUE_CHARS = 64 * 1024;
/** Key shape, matching what's already in the table ('ui', 'eodDigest:<hash>'). */
const SETTING_KEY_RE = /^[A-Za-z0-9_.:-]{1,64}$/;

export async function workspaceRoutes(app: FastifyInstance): Promise<void> {
  // Open a detected dev-server URL in the system default browser (terminal
  // toolbar "Open"). Loopback-only — validateDevUrl rejects everything else.
  app.post<{ Body: { url?: string } }>('/api/open-url', async (req, reply) => {
    const url = validateDevUrl(req.body?.url);
    if (!url) return reply.code(400).send({ error: 'Only local http(s) dev-server URLs can be opened.' });
    openInBrowser(url);
    return { ok: true, url };
  });

  // The full restorable workspace: open terminal tabs + persisted UI settings.
  app.get('/api/workspace', async () => {
    const runs = await prisma.run.findMany({
      where: { dockOpen: true },
      orderBy: { startedAt: 'asc' },
      include: { command: true, project: true },
    });

    const settingsRows = await prisma.appSetting.findMany({
      where: { key: { in: [...UI_SETTING_KEYS] } },
    });
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
    if (entries.length > MAX_SETTING_KEYS) {
      return reply.code(400).send({ error: `At most ${MAX_SETTING_KEYS} settings can be saved at once.` });
    }
    for (const [key, value] of entries) {
      if (!SETTING_KEY_RE.test(key)) {
        return reply.code(400).send({ error: `Not a valid setting key: ${key.slice(0, 64)}` });
      }
      // The AI config holds a SECRET and has its own validated, masked routes —
      // letting it through here would store an unsanitized key AND leave
      // aiProvider's in-memory cache (which the pty spawn path reads
      // synchronously) pointing at the old value.
      if (key === AI_SETTING_KEY) {
        return reply.code(400).send({ error: 'The AI provider config is written through /api/settings/ai.' });
      }
      if (JSON.stringify(value ?? null).length > MAX_SETTING_VALUE_CHARS) {
        return reply.code(400).send({ error: `Setting "${key}" is too large (max ${MAX_SETTING_VALUE_CHARS} characters).` });
      }
    }
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
