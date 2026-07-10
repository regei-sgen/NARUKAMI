import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor, act } from '@testing-library/react';
import type { CodeGraph, CodeGraphNode, CodeNodeDetail, CodeScope, Project } from '../types';

// Mock the api layer so CodeMap's mount effects resolve deterministically and we
// can assert the toggle persists via api.setCodeMapEmbed. vi.hoisted lets the
// (hoisted) vi.mock factory reference the spies without a TDZ error. getCodeGraph
// and getCodeNodeDetail are hoisted too so individual tests can drive the
// inspector path (node selection + detail fetch) with per-test graphs.
const { setCodeMapEmbed, getCodeGraph, getCodeNodeDetail } = vi.hoisted(() => ({
  setCodeMapEmbed: vi.fn(),
  getCodeGraph: vi.fn(),
  getCodeNodeDetail: vi.fn(),
}));
vi.mock('../api', () => ({
  api: {
    getCodeEngine: vi.fn().mockResolvedValue({ installed: true, version: '0.8.1' }),
    getCodeGraph,
    getCodeNodeDetail,
    getCodeChanges: vi.fn().mockResolvedValue({ changed: [], ongoing: [] }),
    generateCodeGraph: vi.fn(),
    setCodeMapEmbed,
  },
}));

// The real graph views draw to canvas/WebGL, which jsdom can't. Replace both with
// a flat list of buttons so tests can click nodes and reach onNodeClick.
vi.mock('./argus/GraphGlobe', () => ({
  GraphGlobe: ({ nodes, onNodeClick }: { nodes: CodeGraphNode[]; onNodeClick?: (n: CodeGraphNode) => void }) => (
    <div>
      {nodes.map((n) => (
        <button key={n.id} onClick={() => onNodeClick?.(n)}>
          globe:{n.id}
        </button>
      ))}
    </div>
  ),
}));
vi.mock('./argus/GraphFlat', () => ({
  GraphFlat: ({ nodes, onNodeClick }: { nodes: CodeGraphNode[]; onNodeClick?: (n: CodeGraphNode) => void }) => (
    <div>
      {nodes.map((n) => (
        <button key={n.id} onClick={() => onNodeClick?.(n)}>
          flat:{n.id}
        </button>
      ))}
    </div>
  ),
}));

import { CodeMap, describeNode } from './CodeMap';

function project(over: Partial<Project> = {}): Project {
  return {
    id: 'p1',
    name: 'proj',
    path: 'C:/proj',
    type: null,
    packageMgr: null,
    status: 'analyzed',
    createdAt: '',
    updatedAt: '',
    commands: [],
    runs: [],
    ...over,
  };
}

function graphOf(scope: CodeScope, nodes: CodeGraphNode[]): { graph: CodeGraph } {
  return { graph: { ok: true, scope, nodes, edges: [], counts: {}, truncated: false } };
}

function nodeDetail(over: Partial<CodeNodeDetail> = {}): CodeNodeDetail {
  return { id: 'n', kinds: [], name: null, file: null, props: {}, neighbors: [], ...over };
}

beforeEach(() => {
  getCodeGraph.mockReset();
  // empty graph → CodeMap opens the scope picker but still renders the header actions
  getCodeGraph.mockResolvedValue(graphOf('files', []));
  getCodeNodeDetail.mockReset();
  getCodeNodeDetail.mockResolvedValue({ detail: nodeDetail() });
});

describe('CodeMap "Embed in Claude" toggle', () => {
  beforeEach(() => {
    setCodeMapEmbed.mockReset();
    setCodeMapEmbed.mockResolvedValue({ codeMapEmbed: true });
  });

  it('shows the off state, and turning it on persists + reflects', async () => {
    const onChanged = vi.fn();
    render(<CodeMap project={project({ codeMapEmbed: false })} onChanged={onChanged} />);

    // Engine loads async → the toggle appears in the off state.
    const btn = await screen.findByText('Embed in Claude');
    fireEvent.click(btn);

    expect(setCodeMapEmbed).toHaveBeenCalledWith('p1', true);
    // Optimistic + server-confirmed → label flips to the on state, parent notified.
    expect(await screen.findByText('Embedded in Claude')).toBeTruthy();
    await waitFor(() => expect(onChanged).toHaveBeenCalled());
  });

  it('renders the on state when the project already has embed enabled', async () => {
    render(<CodeMap project={project({ codeMapEmbed: true })} />);
    expect(await screen.findByText('Embedded in Claude')).toBeTruthy();
  });
});

describe('CodeMap inspector', () => {
  const fileNode: CodeGraphNode = { id: 'n-file', kind: 'File', label: 'index.ts', file: 'src/index.ts' };
  const fnNode: CodeGraphNode = { id: 'n-fn', kind: 'Function', label: 'boot' };

  it('clears the inspector when switching scope replaces the graph', async () => {
    getCodeGraph.mockImplementation((_id: string, scope: CodeScope) =>
      Promise.resolve(scope === 'functions' ? graphOf('functions', [fnNode]) : graphOf('files', [fileNode])),
    );
    render(<CodeMap project={project()} />);

    // Select a node on the initial (files) graph → inspector opens on it.
    fireEvent.click(await screen.findByText('globe:n-file'));
    expect(await screen.findByText('index.ts')).toBeTruthy();

    // Switch scope → a different graph arrives; the old selection must not survive.
    fireEvent.click(screen.getByText('Full function-level'));
    expect(await screen.findByText('globe:n-fn')).toBeTruthy();
    await waitFor(() => expect(screen.queryByText('index.ts')).toBeNull());
  });

  it('shows the latest node detail when two detail fetches resolve out of order', async () => {
    const a: CodeGraphNode = { id: 'n-a', kind: 'Function', label: 'alpha' };
    const b: CodeGraphNode = { id: 'n-b', kind: 'Function', label: 'beta' };
    getCodeGraph.mockResolvedValue(graphOf('files', [a, b]));
    const resolvers = new Map<string, (v: { detail: CodeNodeDetail }) => void>();
    getCodeNodeDetail.mockImplementation(
      (_id: string, nodeId: string) =>
        new Promise<{ detail: CodeNodeDetail }>((resolve) => resolvers.set(nodeId, resolve)),
    );
    render(<CodeMap project={project()} />);

    // Click alpha, then beta before alpha's detail arrives.
    fireEvent.click(await screen.findByText('globe:n-a'));
    fireEvent.click(screen.getByText('globe:n-b'));

    // The latest (beta) resolves first…
    await act(async () => resolvers.get('n-b')!({ detail: nodeDetail({ id: 'n-b', props: { lines: 222 } }) }));
    expect(await screen.findByText('function beta. 222 lines.')).toBeTruthy();

    // …then the stale alpha response lands late and must be dropped.
    await act(async () => resolvers.get('n-a')!({ detail: nodeDetail({ id: 'n-a', props: { lines: 111 } }) }));
    expect(screen.getByText('function beta. 222 lines.')).toBeTruthy();
    expect(screen.queryByText(/111 lines/)).toBeNull();
  });
});

describe('describeNode', () => {
  const fnNode: CodeGraphNode = { id: 'f1', kind: 'Function', label: 'sum' };

  it('formats a Function node with rich props', () => {
    const detail = nodeDetail({
      id: 'f1',
      props: {
        is_exported: true,
        signature: '(a, b)',
        return_type: ': number',
        lines: 12,
        complexity: 3,
        param_count: 2,
        param_names: ['a', 'b'],
        recursive: true,
      },
      neighbors: [
        { rel: 'CALLS', dir: 'out', id: 'x', label: 'add' },
        { rel: 'CALLS', dir: 'in', id: 'y', label: 'main' },
        { rel: 'DEFINES', dir: 'in', id: 'z', label: 'utils.ts' },
      ],
    });
    expect(describeNode(fnNode, detail)).toBe(
      'exported function sum(a, b): number. ' +
        '12 lines · cyclomatic complexity 3 · 2 parameters (a, b) · recursive. ' +
        'calls 1 symbol · called from 1 place · defined in utils.ts.',
    );
  });

  it('summarizes a sparse File node from its DEFINES neighbors without crashing', () => {
    const file: CodeGraphNode = { id: 'file1', kind: 'File', label: 'utils.ts', file: 'src/utils.ts' };
    const detail = nodeDetail({
      id: 'file1',
      neighbors: [
        { rel: 'DEFINES', dir: 'out', id: 'a', label: 'sum' },
        { rel: 'DEFINES', dir: 'out', id: 'b', label: 'mul' },
      ],
    });
    expect(describeNode(file, detail)).toBe('file utils.ts. defines 2 symbols.');
  });

  it('does not crash when detail is null', () => {
    expect(describeNode(fnNode, null)).toBe('function sum.');
  });
});
