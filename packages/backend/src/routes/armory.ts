import type { FastifyInstance } from 'fastify';
import { prisma } from '../db';
import { collectArmory } from '../services/armory';

/**
 * Armory — read-only inventory of the Claude Code arsenal (skills / hooks /
 * memory pins / agents / commands), scoped global + per registered project.
 * Token-gated by the global onRequest hook (path starts with /api).
 */
export async function armoryRoutes(app: FastifyInstance): Promise<void> {
  app.get('/api/armory', async () => {
    const projects = await prisma.project.findMany({ select: { name: true, path: true } });
    return collectArmory(projects);
  });
}
