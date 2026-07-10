import type { FastifyInstance } from 'fastify';
import { readUsage } from '../services/argus';
import { machineInfo, vitalsHistory } from '../services/vitals';

/**
 * Header Instrument Cluster feed: whole-machine CPU/MEM history, machine totals
 * (so the memory spark scales against real capacity), and the account-wide
 * Claude usage windows (usage-live.json). One GET feeds all header zones.
 */
export async function vitalsRoutes(app: FastifyInstance): Promise<void> {
  app.get('/api/vitals', async () => ({
    history: vitalsHistory(),
    machine: machineInfo(),
    usage: await readUsage(),
  }));
}
