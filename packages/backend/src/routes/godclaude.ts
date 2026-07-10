import type { FastifyInstance } from 'fastify';
import { narukamiSessionIds } from './argus';
import { tailLog } from '../services/argus';
import {
  collectStatus,
  godClaudeDir,
  isProvisioned,
  provision,
  sessionGodActive,
  sessionModes,
  setArmed,
  setAutopilot,
  setMode,
  setSessionArmed,
} from '../services/godclaude';

/**
 * NARUKAMI's embedded GODCLAUDE — control plane over the app's OWN god home
 * (~/.narukami/godclaude). Writable by design: unlike Argus (a read-only
 * projection over the native ~/.claude), this instance belongs to NARUKAMI.
 * Nothing here touches the native install. Token-gated by the global
 * onRequest hook (paths start with /api).
 */
/** Session-id set for fleet scoping; empty when the DB is unavailable (tests). */
async function idsSafe(): Promise<ReadonlySet<string>> {
  try {
    return await narukamiSessionIds();
  } catch {
    return new Set();
  }
}

export async function godclaudeRoutes(app: FastifyInstance): Promise<void> {
  // Full embedded snapshot: install/armed/mode/autopilot + native hook-wiring +
  // health/stats + the NARUKAMI-launched session fleet + account usage.
  app.get('/api/godclaude/status', async () => collectStatus(await idsSafe()));

  // Provision (or repair/upgrade) the embedded home from the vendored assets.
  app.post('/api/godclaude/install', async (_req, reply) => {
    const res = await provision();
    if (!res.ok) return reply.code(500).send({ error: res.error });
    return collectStatus(await idsSafe());
  });

  // Arm / disarm the embedded layer — globally, or for ONE session's overlay
  // (the terminal-toolbar god toggle).
  app.post<{ Body: { on?: boolean; sessionId?: string } }>(
    '/api/godclaude/arm',
    async (req, reply) => {
      const on = Boolean(req.body?.on);
      const sessionId = req.body?.sessionId;
      const res = sessionId ? await setSessionArmed(sessionId, on) : await setArmed(on);
      if (!res.ok) return reply.code(sessionId ? 400 : 500).send({ error: res.output });
      if (sessionId) {
        return { output: res.output, active: sessionGodActive(sessionId) };
      }
      return { output: res.output, status: await collectStatus(await idsSafe()) };
    },
  );

  // Switch the mode — global, or one NARUKAMI-launched session's overlay.
  app.post<{ Body: { mode?: string; sessionId?: string } }>(
    '/api/godclaude/mode',
    async (req, reply) => {
      const mode = req.body?.mode;
      if (!mode) return reply.code(400).send({ error: 'mode is required.' });
      const res = await setMode(mode, req.body?.sessionId);
      if (!res.ok) return reply.code(400).send({ error: res.output });
      return { output: res.output, status: await collectStatus(await idsSafe()) };
    },
  );

  // Autopilot (auto-routing) on/off.
  app.post<{ Body: { on?: boolean } }>('/api/godclaude/autopilot', async (req, reply) => {
    const res = await setAutopilot(Boolean(req.body?.on));
    if (!res.ok) return reply.code(500).send({ error: res.output });
    return { output: res.output, status: await collectStatus(await idsSafe()) };
  });

  // One session's god state (terminal-toolbar chips): active resolves overlay →
  // global, exactly like the layer's own armed() check.
  app.get<{ Params: { sessionId: string } }>(
    '/api/godclaude/sessions/:sessionId/state',
    async (req) => ({
      installed: isProvisioned(),
      active: sessionGodActive(req.params.sessionId),
      modes: sessionModes(req.params.sessionId),
    }),
  );

  // Byte-bounded tail of the EMBEDDED home's god logs (monitor|perf|audit).
  app.get<{ Querystring: { source?: string; limit?: string } }>(
    '/api/godclaude/logs',
    async (req, reply) => {
      const source = req.query.source ?? 'monitor';
      const limit = Number(req.query.limit ?? 200);
      const result = await tailLog(source, Number.isFinite(limit) ? limit : 200, godClaudeDir());
      if ('error' in result) return reply.code(400).send(result);
      return result;
    },
  );
}
