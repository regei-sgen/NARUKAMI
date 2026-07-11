import { describe, it, expect, vi, beforeAll, afterAll, beforeEach } from 'vitest';
import Fastify, { type FastifyBaseLogger, type FastifyInstance } from 'fastify';

vi.mock('../db', () => ({
  prisma: {
    project: {
      findUnique: vi.fn().mockResolvedValue({ id: 'p1', name: 'demo', path: 'C:/repo/demo' }),
    },
  },
}));

vi.mock('../services/codeGraph', () => ({
  detectEngine: vi.fn(),
  getChanges: vi.fn(),
  getNodeDetail: vi.fn(),
  getProjectGraph: vi.fn(),
  indexProject: vi.fn(),
}));

import { codeGraphRoutes } from './codeGraph';
import { detectEngine, getNodeDetail, getProjectGraph, indexProject } from '../services/codeGraph';

const detect = vi.mocked(detectEngine);
const nodeDetail = vi.mocked(getNodeDetail);
const projectGraph = vi.mocked(getProjectGraph);
const index = vi.mocked(indexProject);

// What a raw engine failure looks like — the command line plus the machine-wide
// project list. None of this may ever reach an HTTP response body.
const SENSITIVE =
  'Command failed: C:\\bin\\codebase-memory-mcp.exe cli query_graph {"query":"MATCH …"}\n' +
  '{"error":"project not found. Indexed projects: [C-work-secret-repo, C-Users-lloyd-other]"}';

// Capture req.log.error calls so we can prove the full error IS logged server-side.
const errorLogs: unknown[][] = [];

// JSON.stringify drops Error messages (non-enumerable), so unwrap them explicitly.
function loggedText(): string {
  return errorLogs
    .flat()
    .map((a) => {
      if (a instanceof Error) return a.message;
      const err = (a as { err?: unknown } | null)?.err;
      if (err instanceof Error) return err.message;
      return String(a);
    })
    .join('\n');
}
function stubLogger() {
  const log = {
    fatal: () => {},
    warn: () => {},
    info: () => {},
    debug: () => {},
    trace: () => {},
    error: (...args: unknown[]) => {
      errorLogs.push(args);
    },
    child: () => log,
  };
  return log;
}

let app: FastifyInstance;
beforeAll(async () => {
  app = Fastify({ loggerInstance: stubLogger() as unknown as FastifyBaseLogger });
  await app.register(codeGraphRoutes);
  await app.ready();
});
afterAll(async () => {
  await app.close();
});

beforeEach(() => {
  detect.mockReset();
  nodeDetail.mockReset();
  projectGraph.mockReset();
  index.mockReset();
  errorLogs.length = 0;
});

describe('GET /api/projects/:id/code-graph/node', () => {
  it('400s when nodeId is missing or blank', async () => {
    const missing = await app.inject({ method: 'GET', url: '/api/projects/p1/code-graph/node' });
    expect(missing.statusCode).toBe(400);
    const blank = await app.inject({ method: 'GET', url: '/api/projects/p1/code-graph/node?nodeId=%20' });
    expect(blank.statusCode).toBe(400);
    expect(nodeDetail).not.toHaveBeenCalled();
  });

  it('400s (not 500s) when nodeId is duplicated and arrives as an array', async () => {
    const r = await app.inject({
      method: 'GET',
      url: '/api/projects/p1/code-graph/node?nodeId=a&nodeId=b',
    });
    expect(r.statusCode).toBe(400);
    expect(nodeDetail).not.toHaveBeenCalled();
  });

  it('404s with a clean message when the node is unknown', async () => {
    nodeDetail.mockResolvedValueOnce(null);
    const r = await app.inject({ method: 'GET', url: '/api/projects/p1/code-graph/node?nodeId=x' });
    expect(r.statusCode).toBe(404);
    expect(r.json()).toEqual({ error: 'Node not found (the graph may have been re-indexed).' });
  });

  it('returns the detail on success', async () => {
    const detail = { id: 'x', kinds: ['File'], name: 'x', file: 'x.ts', props: {}, neighbors: [] };
    nodeDetail.mockResolvedValueOnce(detail);
    const r = await app.inject({ method: 'GET', url: '/api/projects/p1/code-graph/node?nodeId=x' });
    expect(r.statusCode).toBe(200);
    expect(r.json()).toEqual({ detail });
  });

  it('500s with a generic body — never the engine command line or project list', async () => {
    nodeDetail.mockRejectedValueOnce(new Error(SENSITIVE));
    const r = await app.inject({ method: 'GET', url: '/api/projects/p1/code-graph/node?nodeId=x' });
    expect(r.statusCode).toBe(500);
    expect(r.json()).toEqual({ error: 'Node lookup failed.' });
    expect(r.body).not.toContain('secret-repo');
    expect(r.body).not.toContain('codebase-memory-mcp');
    // …but the full error is still logged server-side.
    expect(loggedText()).toContain('secret-repo');
  });
});

describe('GET /api/projects/:id/code-graph', () => {
  it('500s with a generic body on query failure (same leak class)', async () => {
    projectGraph.mockRejectedValueOnce(new Error(SENSITIVE));
    const r = await app.inject({ method: 'GET', url: '/api/projects/p1/code-graph' });
    expect(r.statusCode).toBe(500);
    expect(r.json()).toEqual({ error: 'Code Map query failed.' });
    expect(r.body).not.toContain('secret-repo');
    expect(loggedText()).toContain('secret-repo');
  });
});

describe('POST /api/projects/:id/code-graph/generate', () => {
  it('500s with a generic body on indexing failure (same leak class)', async () => {
    detect.mockResolvedValueOnce({ installed: true, version: '0.8.1' });
    index.mockRejectedValueOnce(new Error(SENSITIVE));
    const r = await app.inject({
      method: 'POST',
      url: '/api/projects/p1/code-graph/generate',
      payload: { scope: 'files' },
    });
    expect(r.statusCode).toBe(500);
    expect(r.json()).toEqual({ error: 'Code Map generation failed.' });
    expect(r.body).not.toContain('secret-repo');
    expect(loggedText()).toContain('secret-repo');
  });
});
