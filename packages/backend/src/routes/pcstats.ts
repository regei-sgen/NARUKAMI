import type { FastifyInstance } from 'fastify';
import { getPcStats } from '../services/pcstats';

/**
 * PC Stats popup feed: GPU load/VRAM/temperature, the temperature sensors this
 * machine actually exposes, and machine status (uptime, disk, battery). Probes
 * are pull-through cached in the service, so this only costs a process spawn
 * when the popup is genuinely open and its cache has gone stale.
 */
export async function pcStatsRoutes(app: FastifyInstance): Promise<void> {
  app.get('/api/pcstats', async () => getPcStats());
}
