import fs from 'node:fs';
import path from 'node:path';
import type { FastifyInstance } from 'fastify';
import { REPO_ROOT } from '../config';
import { isStatsLanRunning, startStatsLan, statsLanInfo, stopStatsLan } from '../services/statsLan';

/**
 * The built SPA to hand the phone. Packaged desktop passes its own path via
 * NARUKAMI_FRONTEND_DIR; in a dev checkout it's the workspace's dist.
 */
function statsFrontendDir(): string | undefined {
  const candidates = [
    process.env.NARUKAMI_FRONTEND_DIR,
    path.join(REPO_ROOT, 'packages', 'frontend', 'dist'),
  ].filter((p): p is string => Boolean(p));
  return candidates.find((p) => fs.existsSync(path.join(p, 'index.html')));
}

const DEFAULT_STATS_PORT = 4311;

/** Below 1024 needs privilege; 65535 is the ceiling. */
function isUsablePort(p: unknown): p is number {
  return typeof p === 'number' && Number.isInteger(p) && p >= 1024 && p <= 65535;
}

/**
 * Control surface for the phone's Wi-Fi path. These routes live on the normal
 * loopback-only backend (so they're already token-gated); they just turn the
 * separate read-only stats listener on and off and report where to point the
 * phone. USB (adb reverse) needs none of this — it's the default.
 */
export async function statsLanRoutes(app: FastifyInstance): Promise<void> {
  app.get('/api/pcstats/lan', async () => ({
    running: isStatsLanRunning(),
    info: statsLanInfo(),
  }));

  app.post('/api/pcstats/lan/start', async (req, reply) => {
    // The directory is NOT caller-supplied: honouring one would turn this into
    // a general file server for any directory containing an index.html.
    const body = (req.body ?? {}) as { port?: unknown };
    const port = body.port ?? DEFAULT_STATS_PORT;
    if (!isUsablePort(port)) {
      return reply.code(400).send({ error: 'port must be an integer in [1024,65535]' });
    }
    const h = await startStatsLan(port, statsFrontendDir());
    return {
      running: true,
      info: {
        port: h.port,
        token: h.token,
        urls: h.urls,
        // ready-to-use addresses for the phone (token included)
        phoneUrls: h.urls.map((u) => `${u}/?pcstats=1&token=${h.token}`),
      },
    };
  });

  app.post('/api/pcstats/lan/stop', async () => {
    await stopStatsLan();
    return { running: false };
  });
}
