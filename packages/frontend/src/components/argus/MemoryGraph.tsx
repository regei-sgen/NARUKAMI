import { useMemo, useState } from 'react';
import type { GraphEdge, GraphNode, MemoryGraph as MemoryGraphData } from '../../types';
import { GraphFlat } from './GraphFlat';
import { Ic } from '../icons';

interface Props {
  graph: MemoryGraphData | null;
  loading: boolean;
  /** Encoded cwds (see ArgusPanoptes) of the selected project — its nodes glow. */
  activeProjects: Set<string>;
  onSelectNote: (project: string, slug: string) => void;
}

// Semantic node palette (kept as-is — the graph's own colour language). The tab
// CHROME uses the default design system; these encode note type / node kind.
const TYPE_COLOR: Record<string, string> = {
  feedback: '#7d83ff',
  project: '#58b7ff',
  reference: '#f3c969',
  note: '#3ed9a6',
};
const KIND_COLOR: Record<string, string> = {
  project: '#ff8a5c',
  session: '#b28dff',
  ghost: '#5a6172',
};

function nodeColor(n: GraphNode): string {
  if (n.kind === 'memory') return TYPE_COLOR[n.type ?? 'note'] ?? TYPE_COLOR.note;
  return KIND_COLOR[n.kind] ?? '#8a90a2';
}
function baseRadius(n: GraphNode): number {
  return n.kind === 'project' ? 7 : n.kind === 'memory' ? 4.6 : n.kind === 'session' ? 4 : 3.2;
}

/**
 * The encoded project dir a node belongs to. Memory/ghost nodes carry `project`
 * directly; project nodes encode it in their id (`proj:<encoded>`). Lowercased so
 * it matches the encoded-cwd set from ArgusPanoptes.
 */
function nodeEnc(n: GraphNode): string | null {
  if (n.project) return n.project.toLowerCase();
  if (n.kind === 'project' && n.id.startsWith('proj:')) return n.id.slice(5).toLowerCase();
  return null;
}

const KIND_TOGGLES: Array<{ kind: GraphNode['kind']; label: string }> = [
  { kind: 'memory', label: 'memories' },
  { kind: 'project', label: 'projects' },
  { kind: 'session', label: 'sessions' },
  { kind: 'ghost', label: 'ghosts' },
];

/** P3 — the memory knowledge graph as an interactive flat 2D force graph (see GraphFlat). */
export function MemoryGraph({ graph, loading, activeProjects, onSelectNote }: Props) {
  const [hidden, setHidden] = useState<Set<string>>(new Set());

  const { nodes, edges } = useMemo(() => {
    if (!graph) return { nodes: [] as GraphNode[], edges: [] as GraphEdge[] };
    const visNodes = graph.nodes.filter((n) => !hidden.has(n.kind));
    const ids = new Set(visNodes.map((n) => n.id));
    const visEdges = graph.edges.filter((e) => ids.has(e.source) && ids.has(e.target));
    return { nodes: visNodes, edges: visEdges };
  }, [graph, hidden]);

  const activeKey = useMemo(() => [...activeProjects].sort().join('|'), [activeProjects]);
  const activeIds = useMemo(() => {
    const s = new Set<string>();
    if (activeProjects.size === 0) return s;
    for (const n of nodes) {
      const enc = nodeEnc(n);
      if (enc && activeProjects.has(enc)) s.add(n.id);
    }
    return s;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [nodes, activeKey]);
  const hasActive = activeIds.size > 0;

  const toggle = (kind: string) =>
    setHidden((cur) => {
      const next = new Set(cur);
      if (next.has(kind)) next.delete(kind);
      else next.add(kind);
      return next;
    });

  const counts = graph?.counts;

  return (
    <section className="argus-panel argus-panel-graph">
      <div className="argus-panel-head">
        <h3>Memory Graph</h3>
        <span className="argus-panel-sub">
          {counts
            ? `${counts.memory} memories · ${counts.projects} projects · ${counts.sessions} sessions · ${counts.ghosts} ghosts`
            : loading
              ? 'loading…'
              : ''}
        </span>
      </div>

      <div className="argus-graph-legend">
        {KIND_TOGGLES.map((t) => (
          <button
            key={t.kind}
            className={`argus-legend-chip ${hidden.has(t.kind) ? 'off' : ''}`}
            onClick={() => toggle(t.kind)}
          >
            <span className="argus-legend-dot" style={{ background: KIND_COLOR[t.kind] ?? TYPE_COLOR.note }} />
            {t.label}
          </button>
        ))}
        <span className="argus-legend-sep" />
        <span className="argus-legend-note">
          {hasActive ? <><Ic name="eye" /> glowing = selected project</> : 'drag to pan · scroll to zoom · drag a node to move · dbl-click resets'}
        </span>
      </div>

      {(!graph || graph.nodes.length === 0) && !loading ? (
        <div className="mg-graph-wrap" style={{ minHeight: 540 }}>
          <div className="argus-empty argus-graph-empty">No memory notes found under ~/.claude/projects.</div>
        </div>
      ) : (
        <GraphFlat<GraphNode>
          nodes={nodes}
          edges={edges}
          colorOf={nodeColor}
          radiusOf={baseRadius}
          alphaOf={(n) => (n.kind === 'ghost' ? 0.7 : 1)}
          highlightIds={activeIds}
          alwaysLabel={(n) => n.kind === 'project'}
          onNodeClick={(n) => {
            if (n.kind === 'memory' && n.project) onSelectNote(n.project, n.label);
          }}
          renderTooltip={(n) => (
            <>
              <div className="argus-mono argus-tip-label">{n.label}</div>
              <div className="argus-tip-meta">
                {n.kind}
                {n.type ? ` · ${n.type}` : ''}
                {activeIds.has(n.id) ? ' · selected' : ''}
              </div>
              {n.description && <div className="argus-tip-desc">{n.description}</div>}
              {n.kind === 'memory' && <div className="argus-tip-hint">click to open</div>}
            </>
          )}
        />
      )}
    </section>
  );
}
