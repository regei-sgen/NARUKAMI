import type { FastifyInstance } from 'fastify';
import { prisma } from '../db';
import { readAllUsageWindows, readProjectUsage } from '../services/telemetry';

export async function telemetryRoutes(app: FastifyInstance): Promise<void> {
  // Token-usage telemetry for a project, aggregated from its Claude Code
  // transcripts (~/.claude/projects/<encoded-path>/*.jsonl). Read-only.
  app.get<{ Params: { id: string } }>('/api/projects/:id/telemetry', async (req, reply) => {
    const project = await prisma.project.findUnique({ where: { id: req.params.id } });
    if (!project) return reply.code(404).send({ error: 'Project not found.' });
    return readProjectUsage(project.path, project.name);
  });

  // Account-wide rolling-window usage (5-hour + weekly + last-24h hourly), across
  // every project — mirrors how Claude's subscription limits actually accrue.
  app.get('/api/usage/windows', async () => readAllUsageWindows());
}
