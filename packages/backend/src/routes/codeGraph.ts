import type { FastifyInstance } from 'fastify';
import { prisma } from '../db';
import {
  type CodeScope,
  detectEngine,
  getChanges,
  getNodeDetail,
  getProjectGraph,
  indexProject,
} from '../services/codeGraph';

// Serialize indexing per project so overlapping "generate" clicks don't stack.
const indexing = new Set<string>();

function parseScope(raw: unknown): CodeScope {
  return raw === 'functions' || raw === 'architecture' ? raw : 'files';
}

/**
 * Code Map — structural codebase graph for a project, produced by the
 * codebase-memory-mcp engine. All under /api (token-gated by the global hook).
 */
export async function codeGraphRoutes(app: FastifyInstance): Promise<void> {
  // Is the engine installed? (global, not project-specific)
  app.get('/api/code-graph/engine', async () => detectEngine());

  // Index the project, then return its graph at the requested scope.
  app.post<{ Params: { id: string }; Body: { scope?: string } }>(
    '/api/projects/:id/code-graph/generate',
    async (req, reply) => {
      const project = await prisma.project.findUnique({ where: { id: req.params.id } });
      if (!project) return reply.code(404).send({ error: 'Project not found.' });

      const engine = await detectEngine();
      if (!engine.installed) {
        return reply.code(412).send({ error: 'The Code Map engine is not installed.', engine });
      }
      if (indexing.has(project.id)) {
        return reply.code(409).send({ error: 'Indexing is already in progress for this project.' });
      }
      indexing.add(project.id);
      try {
        const scope = parseScope(req.body?.scope);
        await indexProject(project.path);
        const graph = await getProjectGraph(project.path, scope);
        return { graph, engine };
      } catch (err) {
        // Raw engine errors carry the command line + machine-wide project list:
        // log server-side, keep the response body generic.
        req.log.error({ err }, 'code map generation failed');
        return reply.code(500).send({ error: 'Code Map generation failed.' });
      } finally {
        indexing.delete(project.id);
      }
    },
  );

  // Re-query the (already indexed) graph at a different scope — no re-index.
  app.get<{ Params: { id: string }; Querystring: { scope?: string } }>(
    '/api/projects/:id/code-graph',
    async (req, reply) => {
      const project = await prisma.project.findUnique({ where: { id: req.params.id } });
      if (!project) return reply.code(404).send({ error: 'Project not found.' });
      try {
        const graph = await getProjectGraph(project.path, parseScope(req.query.scope));
        return { graph };
      } catch (err) {
        req.log.error({ err }, 'code map query failed');
        return reply.code(500).send({ error: 'Code Map query failed.' });
      }
    },
  );

  // Everything the engine stores about one node (properties + edges both ways) —
  // backs the inspector shown under the graph when a node is clicked.
  app.get<{ Params: { id: string }; Querystring: { nodeId?: string | string[] } }>(
    '/api/projects/:id/code-graph/node',
    async (req, reply) => {
      // A duplicated ?nodeId= arrives as an array — only a single string is valid.
      const raw = req.query.nodeId;
      const nodeId = typeof raw === 'string' ? raw.trim() : '';
      if (!nodeId) return reply.code(400).send({ error: 'nodeId is required (exactly once).' });
      const project = await prisma.project.findUnique({ where: { id: req.params.id } });
      if (!project) return reply.code(404).send({ error: 'Project not found.' });
      try {
        const detail = await getNodeDetail(project.path, nodeId);
        if (!detail) return reply.code(404).send({ error: 'Node not found (the graph may have been re-indexed).' });
        return { detail };
      } catch (err) {
        req.log.error({ err }, 'code map node lookup failed');
        return reply.code(500).send({ error: 'Node lookup failed.' });
      }
    },
  );

  // Which files are changing right now (git-dirty = changed, recently-touched =
  // ongoing) — polled to light up / pulse the corresponding nodes.
  app.get<{ Params: { id: string } }>('/api/projects/:id/code-graph/changes', async (req, reply) => {
    const project = await prisma.project.findUnique({ where: { id: req.params.id } });
    if (!project) return reply.code(404).send({ error: 'Project not found.' });
    return getChanges(project.path);
  });

  // Toggle "Embed in Claude": when on, Claude sessions launched for this project
  // get the codebase-memory-mcp (Code Map) MCP server attached, so Claude can
  // inspect the project's structural graph on demand. Persisted per project.
  app.post<{ Params: { id: string }; Body: { enabled?: boolean } }>(
    '/api/projects/:id/code-graph/embed',
    async (req, reply) => {
      const enabled = req.body?.enabled === true;
      const project = await prisma.project.findUnique({ where: { id: req.params.id } });
      if (!project) return reply.code(404).send({ error: 'Project not found.' });
      const updated = await prisma.project.update({
        where: { id: project.id },
        data: { codeMapEmbed: enabled },
        select: { codeMapEmbed: true },
      });
      return { codeMapEmbed: updated.codeMapEmbed };
    },
  );
}
