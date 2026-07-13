import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { api } from '../api';
import { onWindowVisibility, windowHidden } from '../lib/visibility';
import type {
  CodeChanges,
  CodeEngineStatus,
  CodeGraph,
  CodeGraphNode,
  CodeNodeDetail,
  CodeScope,
  Project,
} from '../types';
import { GraphFlat } from './argus/GraphFlat';
import { GraphGlobe } from './argus/GraphGlobe';
import { Ic } from './icons';

interface Props {
  project: Project;
  /** Called after the "Embed in Claude" toggle persists, so the parent can refresh. */
  onChanged?: () => void;
}

const SCOPES: Array<{ scope: CodeScope; title: string; blurb: string; recommended?: boolean }> = [
  {
    scope: 'files',
    title: 'Files + modules',
    blurb: 'Folders, files and modules — the readable structural skeleton.',
    recommended: true,
  },
  { scope: 'functions', title: 'Full function-level', blurb: 'Classes, functions, methods and their call/define edges. Dense.' },
  { scope: 'architecture', title: 'Architecture overview', blurb: 'Project → folders → modules → routes. The high-level shape.' },
];

const CODE_KIND_COLOR: Record<string, string> = {
  Project: '#f3c969',
  Package: '#f3c969',
  Folder: '#ff8a5c',
  File: '#58b7ff',
  Module: '#7d83ff',
  Class: '#3ed9a6',
  Interface: '#3ed9a6',
  Type: '#3ed9a6',
  Function: '#b28dff',
  Method: '#b28dff',
  Route: '#ff6b78',
  Resource: '#ff6b78',
  Channel: '#5ac8fa',
  Section: '#8a90a2',
  Variable: '#8a90a2',
};
function codeColor(n: CodeGraphNode): string {
  return CODE_KIND_COLOR[n.kind] ?? '#8a90a2';
}
function codeRadius(n: CodeGraphNode): number {
  if (n.kind === 'Project') return 9;
  if (n.kind === 'Package' || n.kind === 'Folder') return 6.5;
  if (n.kind === 'File' || n.kind === 'Module' || n.kind === 'Route') return 5;
  return 4;
}

/**
 * Node ids whose file path is touched by any of `paths`. A path matches a node
 * when it IS the node's file, sits UNDER it (folder/package), or is the file for
 * that module (node file + extension). Case-insensitive (Windows).
 */
function matchIds(nodes: CodeGraphNode[], paths: string[]): Set<string> {
  const set = new Set<string>();
  if (paths.length === 0) return set;
  const norm = paths.map((p) => p.toLowerCase());
  for (const n of nodes) {
    if (!n.file) continue;
    const nf = n.file.toLowerCase();
    for (const cp of norm) {
      if (cp === nf || cp.startsWith(`${nf}/`) || cp.startsWith(`${nf}.`) || nf.startsWith(`${cp}/`)) {
        set.add(n.id);
        break;
      }
    }
  }
  return set;
}

/**
 * Plain-English description of a node from the engine's stored properties.
 * Every fact here comes from the engine (signature, lines, complexity, flags) —
 * absent properties are simply skipped, so sparse kinds (Folder/File) still read.
 */
export function describeNode(node: CodeGraphNode, detail: CodeNodeDetail | null): string {
  const p = detail?.props ?? {};
  const parts: string[] = [];

  const flags: string[] = [];
  if (p.is_exported === true) flags.push('exported');
  if (p.is_entry_point === true) flags.push('entry point');
  if (p.is_test === true) flags.push('test');
  const kindWord = node.kind.toLowerCase();
  const signature = typeof p.signature === 'string' ? p.signature : '';
  const ret = typeof p.return_type === 'string' ? p.return_type : '';
  parts.push(
    `${flags.length ? `${flags.join(', ')} ` : ''}${kindWord} ${node.label}${signature}${ret}`.trim(),
  );

  const facts: string[] = [];
  if (typeof p.lines === 'number') facts.push(`${p.lines} lines`);
  if (typeof p.complexity === 'number') facts.push(`cyclomatic complexity ${p.complexity}`);
  if (typeof p.cognitive === 'number') facts.push(`cognitive complexity ${p.cognitive}`);
  if (typeof p.param_count === 'number' && p.param_count > 0) {
    const names = Array.isArray(p.param_names) ? ` (${(p.param_names as unknown[]).map(String).join(', ')})` : '';
    facts.push(`${p.param_count} parameter${p.param_count === 1 ? '' : 's'}${names}`);
  }
  if (p.recursive === true || p.self_recursive === true) facts.push('recursive');
  if (typeof p.loop_count === 'number' && p.loop_count > 0) facts.push(`${p.loop_count} loops`);
  if (facts.length) parts.push(facts.join(' · '));

  if (detail) {
    const out = detail.neighbors.filter((n) => n.dir === 'out');
    const inn = detail.neighbors.filter((n) => n.dir === 'in');
    const rel: string[] = [];
    const calls = out.filter((n) => n.rel === 'CALLS').length;
    const defines = out.filter((n) => n.rel === 'DEFINES').length;
    const calledBy = inn.filter((n) => n.rel === 'CALLS').length;
    const definedIn = inn.find((n) => n.rel === 'DEFINES');
    if (defines) rel.push(`defines ${defines} symbol${defines === 1 ? '' : 's'}`);
    if (calls) rel.push(`calls ${calls} symbol${calls === 1 ? '' : 's'}`);
    if (calledBy) rel.push(`called from ${calledBy} place${calledBy === 1 ? '' : 's'}`);
    if (definedIn) rel.push(`defined in ${definedIn.label}`);
    if (rel.length) parts.push(rel.join(' · '));
  }

  return parts.join('. ') + '.';
}

/**
 * Code Map — a structural graph of the selected project's codebase, produced by
 * the codebase-memory-mcp engine and drawn with the shared 3D GraphGlobe. Picks a
 * level-of-detail via a popup, indexes the repo, then renders it.
 */
export function CodeMap({ project, onChanged }: Props) {
  const [engine, setEngine] = useState<CodeEngineStatus | null>(null);
  const [graph, setGraph] = useState<CodeGraph | null>(null);
  const [scope, setScope] = useState<CodeScope>('files');
  const [busy, setBusy] = useState<'idle' | 'indexing' | 'querying'>('idle');
  const [modalOpen, setModalOpen] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [selected, setSelected] = useState<CodeGraphNode | null>(null);
  const [detail, setDetail] = useState<CodeNodeDetail | null>(null);
  const [detailBusy, setDetailBusy] = useState(false);
  const [changes, setChanges] = useState<CodeChanges>({ changed: [], ongoing: [] });
  // "Embed in Claude" toggle — whether this project's Claude sessions get the
  // Code Map MCP server. Seeded from the project; optimistic on click.
  const [embed, setEmbed] = useState<boolean>(project.codeMapEmbed ?? false);
  const [embedBusy, setEmbedBusy] = useState(false);
  // Guard the boot check so it runs once per project.
  const booted = useRef<string | null>(null);
  // Sequence id of the newest detail fetch — bumped by every select/clear so a
  // late response can be recognized as stale and dropped.
  const detailReq = useRef(0);

  // Drop the inspector. Bumping detailReq invalidates any in-flight detail
  // fetch, so a late response can't flip detailBusy after the close.
  const clearSelection = useCallback(() => {
    detailReq.current += 1;
    setSelected(null);
    setDetail(null);
    setDetailBusy(false);
  }, []);

  // Click a node → select it and pull everything the engine stores about it.
  // A stale response (user already clicked elsewhere) is dropped by request id.
  const selectNode = useCallback(
    (n: CodeGraphNode) => {
      const req = ++detailReq.current;
      setSelected(n);
      setDetail(null);
      setDetailBusy(true);
      void api
        .getCodeNodeDetail(project.id, n.id)
        .then((res) => {
          if (detailReq.current !== req) return; // stale — a newer click/clear won
          setDetail(res.detail);
          setDetailBusy(false);
        })
        .catch(() => {
          if (detailReq.current === req) setDetailBusy(false);
        });
    },
    [project.id],
  );

  const toggleEmbed = useCallback(async () => {
    const next = !embed;
    setEmbed(next); // optimistic
    setEmbedBusy(true);
    try {
      const res = await api.setCodeMapEmbed(project.id, next);
      setEmbed(res.codeMapEmbed);
      onChanged?.();
    } catch (e) {
      setEmbed(!next); // revert on failure
      setErr((e as Error).message);
    } finally {
      setEmbedBusy(false);
    }
  }, [embed, project.id, onChanged]);

  const generate = useCallback(
    async (s: CodeScope) => {
      setModalOpen(false);
      setScope(s);
      setErr(null);
      setBusy('indexing');
      try {
        const res = await api.generateCodeGraph(project.id, s);
        setGraph(res.graph);
        setEngine(res.engine);
        clearSelection(); // the selected node belongs to the replaced graph
      } catch (e) {
        setErr((e as Error).message);
      } finally {
        setBusy('idle');
      }
    },
    [project.id, clearSelection],
  );

  const switchScope = useCallback(
    async (s: CodeScope) => {
      setScope(s);
      setErr(null);
      setBusy('querying');
      try {
        const res = await api.getCodeGraph(project.id, s);
        if (res.graph.nodes.length > 0) {
          setGraph(res.graph);
          clearSelection(); // the selected node belongs to the replaced graph
        } else {
          await generate(s); // not indexed for this scope yet — index now
        }
      } catch (e) {
        setErr((e as Error).message);
      } finally {
        setBusy('idle');
      }
    },
    [project.id, generate, clearSelection],
  );

  // Boot per project: detect the engine and, if already indexed, load the graph;
  // otherwise pop the scope picker.
  useEffect(() => {
    if (booted.current === project.id) return;
    booted.current = project.id;
    setGraph(null);
    setSelected(null);
    setDetail(null);
    void (async () => {
      try {
        const eng = await api.getCodeEngine();
        setEngine(eng);
        if (!eng.installed) return;
        const res = await api.getCodeGraph(project.id, 'files');
        if (res.graph.nodes.length > 0) setGraph(res.graph);
        else setModalOpen(true);
      } catch (e) {
        setErr((e as Error).message);
      }
    })();
  }, [project.id]);

  // Poll git changes while a graph is shown: nodes on changed paths light up,
  // actively-saving ones pulse.
  useEffect(() => {
    if (!graph) return;
    let alive = true;
    const tick = async () => {
      try {
        const c = await api.getCodeChanges(project.id);
        // Identity-bail when the change set is the same as last tick, so the
        // 2.5s poll doesn't re-render the map (and reset litIds identity,
        // which keeps the graph glow loop awake) while nothing moved.
        if (alive)
          setChanges((prev) =>
            prev.changed.join('\n') === c.changed.join('\n') &&
            prev.ongoing.join('\n') === c.ongoing.join('\n')
              ? prev
              : c,
          );
      } catch {
        /* transient — keep the last snapshot */
      }
    };
    void tick();
    // Each tick spawns a `git status` backend-side — skip it while the window
    // is hidden (backgroundThrottling:false means the interval itself never
    // slows down) and catch up immediately on restore.
    const id = setInterval(() => {
      if (!windowHidden()) void tick();
    }, 2500);
    const offVis = onWindowVisibility((hidden) => {
      if (!hidden) void tick();
    });
    return () => {
      alive = false;
      clearInterval(id);
      offVis();
    };
  }, [graph, project.id]);

  const nodes = graph?.nodes ?? [];
  const changedIds = useMemo(() => matchIds(nodes, changes.changed), [nodes, changes.changed]);
  const ongoingIds = useMemo(() => matchIds(nodes, changes.ongoing), [nodes, changes.ongoing]);

  const counts = graph?.counts;
  const total = graph ? graph.nodes.length : 0;
  // GraphFlat has a single glow tier, so fold "changed" and "editing" into one set.
  const litIds = useMemo(() => new Set<string>([...changedIds, ...ongoingIds]), [changedIds, ongoingIds]);
  // Shared tooltip body for both the sphere (GraphGlobe) and flat (GraphFlat) views.
  const codeTip = (n: CodeGraphNode) => (
    <>
      <div className="argus-mono argus-tip-label">{n.label}</div>
      <div className="argus-tip-meta">
        {n.kind}
        {ongoingIds.has(n.id) ? ' · editing' : changedIds.has(n.id) ? ' · changed' : ''}
      </div>
      {n.file && <div className="argus-tip-desc argus-mono">{n.file}</div>}
    </>
  );

  return (
    <div className="codemap">
      <header className="codemap-header">
        {/* content-first (Tempered Glass v2): scope pills lead, actions trail — no wordmark */}
        {graph ? (
          <div className="codemap-scope-pills">
            {SCOPES.map((s) => (
              <button
                key={s.scope}
                className={`codemap-pill ${scope === s.scope ? 'active' : ''}`}
                disabled={busy !== 'idle'}
                onClick={() => switchScope(s.scope)}
              >
                {s.title}
              </button>
            ))}
          </div>
        ) : (
          <div className="codemap-sub">
            <Ic name="hex" /> {project.name} · structural codebase graph
          </div>
        )}
        <div className="codemap-actions">
          {engine?.installed && (
            <button
              className={`codemap-embed-toggle ${embed ? 'on' : ''}`}
              disabled={embedBusy}
              onClick={toggleEmbed}
              title={
                embed
                  ? 'Claude sessions for this project can inspect the Code Map (codebase-memory MCP). Click to disable.'
                  : "Embed the Code Map into this project's Claude sessions so Claude can inspect it on demand."
              }
            >
              <span className="codemap-embed-dot" aria-hidden="true" />
              {embed ? 'Embedded in Claude' : 'Embed in Claude'}
            </button>
          )}
          {engine?.installed && (
            <button className="btn btn-primary" disabled={busy !== 'idle'} onClick={() => setModalOpen(true)}>
              {graph ? (
                <>
                  <Ic name="refresh" /> Regenerate
                </>
              ) : (
                'Generate'
              )}
            </button>
          )}
        </div>
      </header>

      {err && (
        <div className="banner banner-error" onClick={() => setErr(null)}>
          {err}
        </div>
      )}

      <div className="codemap-body">
        {engine && !engine.installed ? (
          <div className="codemap-empty">
            <h3>Code Map engine not installed</h3>
            <p>
              The Code Map is built by <code>codebase-memory-mcp</code> — a local, MIT-licensed engine.
              Install it, then reopen this tab.
            </p>
            <pre className="codemap-install">
              iwr https://raw.githubusercontent.com/DeusData/codebase-memory-mcp/main/install.ps1 -OutFile
              "$env:TEMP\cbm.ps1"; &amp; "$env:TEMP\cbm.ps1" --skip-config
            </pre>
          </div>
        ) : busy === 'indexing' ? (
          <div className="codemap-empty codemap-boot">Indexing {project.name}…</div>
        ) : graph ? (
          <>
            <div className="codemap-statsbar argus-mono">
              <span>{total} nodes</span>
              <span>{graph.edges.length} edges</span>
              {counts &&
                Object.entries(counts)
                  .sort((a, b) => b[1] - a[1])
                  .slice(0, 8)
                  .map(([k, v]) => (
                    <span key={k} className="codemap-kind">
                      <span className="codemap-dot" style={{ background: CODE_KIND_COLOR[k] ?? '#8a90a2' }} />
                      {k} {v}
                    </span>
                  ))}
              {total > 600 && <span className="codemap-trunc">· flat view ({total.toLocaleString()} nodes)</span>}
              {changedIds.size > 0 && (
                <span className="codemap-changed">
                  <span
                    aria-hidden="true"
                    style={{
                      display: 'inline-block',
                      width: 8,
                      height: 8,
                      borderRadius: '50%',
                      background: 'currentColor',
                    }}
                  />{' '}
                  {changedIds.size} changed{ongoingIds.size > 0 ? ` · ${ongoingIds.size} live` : ''}
                </span>
              )}
              {busy === 'querying' && <span>· loading…</span>}
            </div>
            {total > 600 ? (
              <GraphFlat<CodeGraphNode>
                nodes={graph.nodes}
                edges={graph.edges}
                height={560}
                colorOf={codeColor}
                radiusOf={codeRadius}
                highlightIds={litIds}
                alwaysLabel={(n) => n.kind === 'Project' || n.kind === 'Package'}
                onNodeClick={selectNode}
                renderTooltip={codeTip}
              />
            ) : (
              <GraphGlobe<CodeGraphNode>
                nodes={graph.nodes}
                edges={graph.edges}
                height={560}
                colorOf={codeColor}
                radiusOf={codeRadius}
                highlightIds={ongoingIds}
                steadyIds={changedIds}
                haloGlow={false}
                alwaysLabel={(n) => n.kind === 'Project' || n.kind === 'Package'}
                onNodeClick={selectNode}
                renderTooltip={codeTip}
              />
            )}
            {selected && (
              <section className="codemap-inspector">
                <div className="codemap-inspector-head">
                  <span className="codemap-dot" style={{ background: codeColor(selected) }} />
                  <span className="codemap-inspector-kind">{selected.kind}</span>
                  <span className="codemap-inspector-name argus-mono">{selected.label}</span>
                  {selected.file && <code className="codemap-inspector-file argus-mono">{selected.file}</code>}
                  <button className="argus-x" title="Close" aria-label="Close" onClick={clearSelection}>
                    ×
                  </button>
                </div>
                {detailBusy ? (
                  <div className="codemap-inspector-desc codemap-inspector-dim">Reading node…</div>
                ) : (
                  <>
                    <p className="codemap-inspector-desc">{describeNode(selected, detail)}</p>
                    {detail && detail.neighbors.length > 0 && (
                      <div className="codemap-inspector-links">
                        {(['out', 'in'] as const).map((dir) => {
                          const list = detail.neighbors.filter((n) => n.dir === dir);
                          if (list.length === 0) return null;
                          return (
                            <div key={dir} className="codemap-inspector-col">
                              <div className="codemap-inspector-col-title">
                                {dir === 'out' ? '→ outgoing' : '← incoming'} ({list.length})
                              </div>
                              <ul>
                                {list.slice(0, 12).map((nb) => {
                                  const target = nodes.find((gn) => gn.id === nb.id);
                                  return (
                                    <li key={`${nb.rel}-${nb.id}`}>
                                      <span className="codemap-inspector-rel argus-mono">{nb.rel}</span>
                                      {target ? (
                                        <button className="codemap-inspector-link" onClick={() => selectNode(target)}>
                                          {nb.label}
                                        </button>
                                      ) : (
                                        <span className="codemap-inspector-plain" title={nb.id}>
                                          {nb.label}
                                        </span>
                                      )}
                                    </li>
                                  );
                                })}
                                {list.length > 12 && <li className="codemap-inspector-dim">+{list.length - 12} more</li>}
                              </ul>
                            </div>
                          );
                        })}
                      </div>
                    )}
                  </>
                )}
              </section>
            )}
          </>
        ) : (
          <div className="codemap-empty">
            <h3>No Code Map yet</h3>
            <p>Generate a structural graph of this project's codebase.</p>
            <button className="btn btn-primary" onClick={() => setModalOpen(true)}>
              Generate Code Map
            </button>
          </div>
        )}
      </div>

      {modalOpen && (
        <div className="codemap-modal-scrim" onClick={() => setModalOpen(false)}>
          <div className="codemap-modal" onClick={(e) => e.stopPropagation()}>
            <div className="codemap-modal-head">
              <h3>Generate Code Map</h3>
              <button className="argus-x" onClick={() => setModalOpen(false)} title="Close" aria-label="Close">
                ×
              </button>
            </div>
            <p className="codemap-modal-sub">Choose how much detail to map for {project.name}.</p>
            <div className="codemap-scope-cards">
              {SCOPES.map((s) => (
                <button key={s.scope} className="codemap-scope-card" onClick={() => generate(s.scope)}>
                  <div className="codemap-scope-title">
                    {s.title}
                    {s.recommended && <span className="codemap-reco">Recommended</span>}
                  </div>
                  <div className="codemap-scope-blurb">{s.blurb}</div>
                </button>
              ))}
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
