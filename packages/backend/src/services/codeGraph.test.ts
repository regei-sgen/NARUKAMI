import { describe, it, expect, vi, beforeEach } from 'vitest';

// Hoisted so the (also-hoisted) vi.mock factory can hand the same fn to the module.
const { execFileMock } = vi.hoisted(() => ({ execFileMock: vi.fn() }));

// The service consumes execFile via promisify(), so a callback-style mock is
// enough: promisify wraps it, resolving cb(null, value) and rejecting cb(err) —
// and we attach stdout/stderr to errors exactly like the real execFile does.
vi.mock('node:child_process', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:child_process')>();
  return { ...actual, execFile: execFileMock };
});

import { engineProjectName, getNodeDetail, parseKinds, parseProps, safeQid } from './codeGraph';

type ExecResult = { stdout: string; stderr: string };

/** Queue one engine invocation: a stdout payload, or an execFile-shaped error. */
function enqueue(result: string | Error): void {
  execFileMock.mockImplementationOnce(
    (_bin: string, _args: string[], _opts: unknown, cb: (err: Error | null, res?: ExecResult) => void) => {
      if (result instanceof Error) cb(result);
      else cb(null, { stdout: result, stderr: '' });
    },
  );
}

function engineError(message: string, stderr: string): Error {
  return Object.assign(new Error(message), { stdout: '', stderr });
}

beforeEach(() => {
  execFileMock.mockReset();
});

describe('safeQid', () => {
  it("strips apostrophes — a qualified_name containing one can never match (accepted trade-off: the mini-Cypher's escape rules are undocumented)", () => {
    expect(safeQid("a'b")).toBe('ab');
  });

  it('strips backslashes', () => {
    expect(safeQid('a\\b')).toBe('ab');
    expect(safeQid("src\\util's.ts")).toBe('srcutils.ts');
  });

  it('leaves normal dotted ids untouched', () => {
    expect(safeQid('pkg.module.fn')).toBe('pkg.module.fn');
    expect(safeQid('src/app.ts')).toBe('src/app.ts');
  });
});

describe('parseKinds', () => {
  it('passes arrays through, stringified', () => {
    expect(parseKinds(['Function', 'Method'])).toEqual(['Function', 'Method']);
  });

  it('parses a JSON-string array (engine sometimes returns labels(n) that way)', () => {
    expect(parseKinds('["File","Module"]')).toEqual(['File', 'Module']);
  });

  it('wraps a plain label string', () => {
    expect(parseKinds('File')).toEqual(['File']);
  });

  it('returns [] for empty or unknown shapes', () => {
    expect(parseKinds('')).toEqual([]);
    expect(parseKinds(null)).toEqual([]);
    expect(parseKinds(42)).toEqual([]);
  });
});

describe('parseProps', () => {
  it('returns object values as-is', () => {
    expect(parseProps({ signature: '(x) => y' })).toEqual({ signature: '(x) => y' });
  });

  it('parses a JSON string (properties(n) arrives as one, verified against v0.8.1)', () => {
    expect(parseProps('{"start_line":3,"exported":true}')).toEqual({ start_line: 3, exported: true });
  });

  it('returns {} for invalid JSON or non-object values', () => {
    expect(parseProps('not json')).toEqual({});
    expect(parseProps('42')).toEqual({});
    expect(parseProps(null)).toEqual({});
  });
});

describe('getNodeDetail', () => {
  const REPO = 'C:/repo/demo'; // engineProjectName → 'C-repo-demo'

  it('parses labels/name/file/props (properties(n) as a JSON STRING) and neighbors in both directions', async () => {
    // Main node query — with the engine's leading log line before the JSON.
    enqueue(
      'level=info msg=mem.init db=graph\n' +
        JSON.stringify({
          columns: ['labels(n)', 'n.name', 'n.file_path', 'properties(n)'],
          rows: [['["Function"]', 'handler', 'src/app.ts', '{"signature":"() => void","start_line":3}']],
        }),
    );
    // Outgoing edges.
    enqueue(JSON.stringify({ rows: [['CALLS', 'pkg.callee', 'callee']] }));
    // Incoming edges — null m.name falls back to the id as the label.
    enqueue(JSON.stringify({ rows: [['DEFINES', 'pkg.file', null]] }));

    const detail = await getNodeDetail(REPO, 'pkg.handler');
    expect(detail).toEqual({
      id: 'pkg.handler',
      kinds: ['Function'],
      name: 'handler',
      file: 'src/app.ts',
      props: { signature: '() => void', start_line: 3 },
      neighbors: [
        { rel: 'CALLS', dir: 'out', id: 'pkg.callee', label: 'callee' },
        { rel: 'DEFINES', dir: 'in', id: 'pkg.file', label: 'pkg.file' },
      ],
    });

    // The engine was invoked as `cli query_graph <json>` with the engine project name.
    expect(execFileMock).toHaveBeenCalledTimes(3);
    const [, argv] = execFileMock.mock.calls[0] as [string, string[]];
    expect(argv[0]).toBe('cli');
    expect(argv[1]).toBe('query_graph');
    const payload = JSON.parse(argv[2]) as { query: string; project: string };
    expect(payload.project).toBe(engineProjectName(REPO));
    expect(payload.query).toContain("n.qualified_name = 'pkg.handler'");
  });

  it('returns null when the node id is not in the graph (no neighbor queries fired)', async () => {
    enqueue(JSON.stringify({ columns: [], rows: [] }));
    await expect(getNodeDetail(REPO, 'gone.node')).resolves.toBeNull();
    expect(execFileMock).toHaveBeenCalledTimes(1);
  });

  it('returns null when the engine says the project is not found/not indexed (error on stderr, empty stdout)', async () => {
    enqueue(
      engineError(
        'Command failed: codebase-memory-mcp cli query_graph {"query":"MATCH …"}',
        '{"error":"project \'C-repo-demo\' not found. Indexed projects: [C-work-secret-repo, C-Users-lloyd-other]"}',
      ),
    );
    await expect(getNodeDetail(REPO, 'pkg.handler')).resolves.toBeNull();
  });

  it('returns null for the "not indexed" phrasing too', async () => {
    enqueue(engineError('Command failed: codebase-memory-mcp cli query_graph', '{"error":"repository has not been indexed yet"}'));
    await expect(getNodeDetail(REPO, 'pkg.handler')).resolves.toBeNull();
  });

  it('still throws on unrelated engine failures (they are real 500s)', async () => {
    enqueue(engineError('Command failed: codebase-memory-mcp cli query_graph', 'graph db is locked by another process'));
    await expect(getNodeDetail(REPO, 'pkg.handler')).rejects.toThrow('Command failed');
  });

  it('returns the main body with empty neighbors when both edge queries fail', async () => {
    enqueue(
      JSON.stringify({
        rows: [[['Function'], 'handler', 'src/app.ts', '{"start_line":3}']],
      }),
    );
    enqueue(engineError('Command failed', 'edge query exploded'));
    enqueue(engineError('Command failed', 'edge query exploded'));

    const detail = await getNodeDetail(REPO, 'pkg.handler');
    expect(detail).toMatchObject({ id: 'pkg.handler', name: 'handler', file: 'src/app.ts' });
    expect(detail?.neighbors).toEqual([]);
  });
});
