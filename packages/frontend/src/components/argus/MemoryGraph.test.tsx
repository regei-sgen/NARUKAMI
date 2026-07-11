import { describe, it, expect } from 'vitest';
import { render } from '@testing-library/react';
import { MemoryGraph } from './MemoryGraph';
import type { MemoryGraph as MemoryGraphData } from '../../types';

const graph: MemoryGraphData = {
  ok: true,
  ts: '',
  nodes: [
    { id: 'mem:p:a', kind: 'memory', label: 'a', type: 'feedback', project: 'p' },
    { id: 'proj:p', kind: 'project', label: 'p' },
  ],
  edges: [{ source: 'mem:p:a', target: 'proj:p', kind: 'in-project' }],
  counts: { memory: 1, projects: 1, sessions: 0, ghosts: 0 },
};

describe('MemoryGraph', () => {
  it('renders the flat 2D graph, not the sphere/globe', () => {
    const { container } = render(
      <MemoryGraph graph={graph} loading={false} activeProjects={new Set()} onSelectNote={() => {}} />,
    );
    // the flat renderer is mounted…
    expect(container.querySelector('.mg-graph-wrap')).toBeTruthy();
    expect(container.querySelector('.mg-graph-canvas')).toBeTruthy();
    // …and the globe's canvas class is gone from the memory graph
    expect(container.querySelector('.argus-graph-canvas')).toBeNull();
  });
});
