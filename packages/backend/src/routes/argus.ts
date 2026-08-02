import type { FastifyInstance } from 'fastify';
import { prisma } from '../db';
import { collectMemoryGraph, readNote } from '../services/argus';

/**
 * Every Claude session id THIS NARUKAMI instance launched (via `--session-id`),
 * so the fleet can mark which sessions are ours vs a native `claude` CLI. Read
 * from the Run table each call (cheap; the set is tiny and the feed is cached).
 * Also used by the embedded-godclaude routes to scope their fleet to ours.
 */
let sessionIdsCache: { t: number; v: Set<string> } | null = null;

export async function narukamiSessionIds(): Promise<Set<string>> {
  // Short TTL cache: the set only changes when a Claude run starts, but this
  // runs on EVERY dashboard status poll — no reason to hit SQLite each time
  // (each query also contends with the live runs' log-flush writers).
  if (sessionIdsCache && Date.now() - sessionIdsCache.t < 10_000) return sessionIdsCache.v;
  const rows = await prisma.run.findMany({
    where: { kind: 'claude', claudeSessionId: { not: null } },
    select: { claudeSessionId: true },
  });
  const v = new Set(rows.map((r) => r.claudeSessionId).filter((id): id is string => Boolean(id)));
  sessionIdsCache = { t: Date.now(), v };
  return v;
}

/**
 * Argus — read-only endpoints over the native ~/.claude state tree. All GET;
 * token-gated for free by the global onRequest hook (paths start with /api).
 * Nothing here mutates the GODCLAUDE state tree.
 *
 * The former /status, /sessions and /logs feeds were removed: the ArgusPanoptes
 * tab now polls the EMBEDDED layer (/api/godclaude/status) and deliberately does
 * not show the native god layer, so nothing consumed them. The /logs tail was
 * backend-only from the start — the planned LogFeed panel was never built, on
 * either the native or the embedded side. What survives here is the memory graph
 * / note viewer, which is genuinely native-scoped.
 */
export async function argusRoutes(app: FastifyInstance): Promise<void> {
  // Obsidian-style memory knowledge graph across all projects.
  app.get('/api/argus/memory-graph', async () => collectMemoryGraph());

  // One memory note's body + frontmatter + backlinks/outlinks.
  app.get<{ Querystring: { project?: string; slug?: string } }>(
    '/api/argus/memory/note',
    async (req, reply) => {
      const { project, slug } = req.query;
      if (!project || !slug) {
        return reply.code(400).send({ error: 'project and slug are required.' });
      }
      const note = await readNote(project, slug);
      if (!note) return reply.code(404).send({ error: 'Note not found.' });
      return note;
    },
  );
}
