import { describe, it, expect, vi, beforeAll, afterAll } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import Fastify, { type FastifyInstance } from 'fastify';

// The search fixture is a throwaway tree with a PLANTED needle, not the backend's
// own source. The old version pointed the mocked project at
// `p.resolve(process.cwd(), 'src')`, so the suite only passed when vitest was
// invoked from packages/backend — from the repo root the path resolved to a
// directory that doesn't exist and files.ts's 400 branch fired, failing 3 of 4
// tests for no product reason. It also grepped for a real backend symbol
// (`registerRun` in runner.ts), so renaming that function would have broken the
// test with nothing actually regressed.
const NEEDLE = 'plantedNeedleSymbol';

// Hoisted holder: the vi.mock factory below is hoisted above beforeAll, so it
// has to read the fixture path lazily, at request time.
const fx = vi.hoisted(() => ({ root: '' }));

vi.mock('../db', () => ({
  prisma: {
    project: {
      findUnique: vi.fn(async () => ({ id: 'p1', name: 'fixture', path: fx.root })),
    },
  },
}));

import { fileRoutes } from './files';

interface Match {
  path: string;
  line: number;
  text: string;
}

let app: FastifyInstance;

beforeAll(async () => {
  fx.root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'narukami-search-')));
  fs.mkdirSync(path.join(fx.root, 'src'));
  // Definition + usage in two files, so a match set spanning files is exercised.
  // The needle sits on line 3 (and indented in the usage) so the reported line
  // number and the handler's line-trimming are both real assertions.
  fs.writeFileSync(
    path.join(fx.root, 'src', 'runner.ts'),
    `// fixture\n\n export function ${NEEDLE}(): void {}\n`,
  );
  fs.writeFileSync(
    path.join(fx.root, 'src', 'brokerServer.ts'),
    `import { ${NEEDLE} } from './runner';\n${NEEDLE}();\n`,
  );
  // Ignored dir carrying the SAME needle — a hit here would mean files.ts stopped
  // honouring the ignore list.
  fs.mkdirSync(path.join(fx.root, 'node_modules', 'dep'), { recursive: true });
  fs.writeFileSync(path.join(fx.root, 'node_modules', 'dep', 'index.js'), `${NEEDLE}();\n`);

  app = Fastify();
  await app.register(fileRoutes);
  await app.ready();
});

afterAll(async () => {
  await app.close();
  fs.rmSync(fx.root, { recursive: true, force: true });
});

describe('GET /api/projects/:id/search', () => {
  it('finds a known symbol across files with path + line', async () => {
    const r = await app.inject({ method: 'GET', url: `/api/projects/p1/search?q=${NEEDLE}` });
    expect(r.statusCode).toBe(200);
    const body = r.json() as { matches: Match[] };
    expect(body.matches.length).toBeGreaterThan(0);
    // runner.ts defines + brokerServer.ts uses the needle
    expect(body.matches.some((m) => m.path.endsWith('runner.ts'))).toBe(true);
    expect(body.matches.some((m) => m.path.endsWith('brokerServer.ts'))).toBe(true);
    const hit = body.matches.find((m) => m.path === 'src/runner.ts')!;
    expect(hit.line).toBe(3);
    expect(hit.text).toBe(`export function ${NEEDLE}(): void {}`);
  });

  it('is case-insensitive', async () => {
    const r = await app.inject({
      method: 'GET',
      url: `/api/projects/p1/search?q=${NEEDLE.toUpperCase()}`,
    });
    const body = r.json() as { matches: Match[] };
    expect(body.matches.length).toBeGreaterThan(0);
    expect(body.matches.some((m) => m.path === 'src/runner.ts')).toBe(true);
  });

  it('returns empty for a blank query', async () => {
    const r = await app.inject({ method: 'GET', url: '/api/projects/p1/search?q=' });
    expect(r.json()).toEqual({ matches: [], truncated: false });
  });

  it('skips node_modules / ignored dirs (no false hits from deps)', async () => {
    const r = await app.inject({ method: 'GET', url: `/api/projects/p1/search?q=${NEEDLE}` });
    const body = r.json() as { matches: Match[] };
    expect(body.matches.every((m) => !m.path.includes('node_modules'))).toBe(true);
    // The needle is planted in node_modules too, so this is a real exclusion:
    // only the two source files may answer.
    expect([...new Set(body.matches.map((m) => m.path))].sort()).toEqual([
      'src/brokerServer.ts',
      'src/runner.ts',
    ]);
  });
});
