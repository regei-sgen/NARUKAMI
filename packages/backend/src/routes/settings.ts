import type { FastifyInstance } from 'fastify';
import {
  SettingsError,
  aboutInfo,
  loadAiConfig,
  publicAiConfig,
  writeAiConfig,
} from '../services/aiProvider';

/**
 * Settings surface for the Settings tab.
 *
 * The AI provider config is the only setting that holds a SECRET, so it gets
 * dedicated endpoints rather than riding the generic key/value `/api/settings`
 * bulk-upsert (which echoes every stored value straight back through
 * `/api/workspace`). The stored API key is never serialized — responses carry a
 * masked preview only. Everything else the tab edits (theme, dock layout,
 * notification prefs) is non-secret and keeps using the generic store.
 */
export async function settingsRoutes(app: FastifyInstance): Promise<void> {
  app.get('/api/settings/ai', async () => publicAiConfig(await loadAiConfig()));

  app.post<{
    Body: { provider?: unknown; apiKey?: unknown; baseUrl?: unknown; defaultEffort?: unknown };
  }>('/api/settings/ai', async (req, reply) => {
    const body = req.body ?? {};
    if (typeof body !== 'object' || Array.isArray(body)) {
      return reply.code(400).send({ error: 'Body must be an object.' });
    }
    try {
      return publicAiConfig(await writeAiConfig(body));
    } catch (err) {
      if (err instanceof SettingsError) return reply.code(400).send({ error: err.message });
      throw err;
    }
  });

  // Forget the stored key and fall back to the signed-in Claude Code CLI. Also
  // resets the provider — leaving it on 'api-key' with no key would claim a
  // credential that isn't there.
  app.delete('/api/settings/ai/key', async () =>
    publicAiConfig(await writeAiConfig({ provider: 'claude-code', apiKey: '', baseUrl: '' })),
  );

  // Read-only diagnostics for the Settings tab's About block.
  app.get('/api/settings/about', async () => aboutInfo());
}
