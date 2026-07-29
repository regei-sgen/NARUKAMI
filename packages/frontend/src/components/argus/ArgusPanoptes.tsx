import { useCallback, useMemo, useRef, useState } from 'react';
import { api } from '../../api';
import { usePollWhileVisible } from '../../lib/usePoll';
import type { EmbeddedGodStatus, MemoryGraph as MemoryGraphData } from '../../types';
import { SessionFleet } from './panels/SessionFleet';
import { EmbeddedGod } from './panels/EmbeddedGod';
import { HealthPanel } from './panels/HealthPanel';
import { GatePanel } from './panels/GatePanel';
import { LatencyPanel } from './panels/LatencyPanel';
import { ModeCatalog } from './panels/ModeCatalog';
import { MemoryGraph } from './MemoryGraph';
import { NoteViewer } from './NoteViewer';

// 5s, not 2s: each status tick costs the backend a Prisma query plus a pile of
// godclaude fs reads — a dashboard doesn't need sub-5s freshness, and the saved
// cycles matter while shells are streaming.
const STATUS_POLL_MS = 5000;
const GRAPH_POLL_MS = 30_000;

interface Props {
  /** Absolute path of the project selected in the sidebar. Its memory nodes glow. */
  selectedPath: string | null;
}

/**
 * The GODCLAUDE tab — NARUKAMI's OWN embedded godclaude instance
 * (~/.narukami/godclaude), and nothing else: controls, health, gate, latency,
 * and the fleet of sessions NARUKAMI launched. The native ~/.claude layer is
 * deliberately absent from this view. One panel is instance-NEUTRAL by
 * nature and stays: the memory graph (Claude auto-memory).
 */
export function ArgusPanoptes({ selectedPath }: Props) {
  const [status, setStatus] = useState<EmbeddedGodStatus | null>(null);
  const [graph, setGraph] = useState<MemoryGraphData | null>(null);
  const [graphLoading, setGraphLoading] = useState(true);
  const [err, setErr] = useState<string | null>(null);
  const [note, setNote] = useState<{ project: string; slug: string } | null>(null);
  const inflight = useRef(false);

  const loadStatus = useCallback(async () => {
    if (inflight.current) return;
    inflight.current = true;
    try {
      setStatus(await api.getGodStatus());
      setErr(null);
    } catch (e) {
      setErr((e as Error).message);
    } finally {
      inflight.current = false;
    }
  }, []);

  const loadGraph = useCallback(async () => {
    try {
      setGraph(await api.getArgusMemoryGraph());
    } catch {
      /* keep last graph */
    } finally {
      setGraphLoading(false);
    }
  }, []);

  // Both polls pause while the window is hidden: each status tick reaches a
  // Prisma query + godclaude fs reads (and, on cache expiry, an
  // Electron-as-node godmonitor spawn) — leaving this tab selected and
  // minimizing overnight used to keep all of that running for zero viewers.
  usePollWhileVisible(loadStatus, STATUS_POLL_MS);
  usePollWhileVisible(loadGraph, GRAPH_POLL_MS);

  // Only the project selected in the sidebar lights up. The graph's project field
  // is the Claude-encoded dir name (every non-alphanumeric char → '-'); encoding
  // the selected path the same way (rather than decoding, which is lossy) matches.
  const activeProjects = useMemo(() => {
    const set = new Set<string>();
    if (selectedPath) set.add(selectedPath.replace(/[^a-zA-Z0-9]/g, '-').toLowerCase());
    return set;
  }, [selectedPath]);

  return (
    <div className="argus">
      {/* No tab-level header: the control panel below is the single status source. */}
      {err && !status && <div className="argus-error">Failed to reach the monitor: {err}</div>}

      {!status ? (
        <div className="argus-empty argus-boot">Reading the embedded god layer…</div>
      ) : (
        <div className="argus-grid">
          {/* NARUKAMI's own embedded godclaude — the writable control plane. */}
          <EmbeddedGod status={status} onStatus={setStatus} />

          <div className="argus-graph-area">
            <MemoryGraph
              graph={graph}
              loading={graphLoading}
              activeProjects={activeProjects}
              onSelectNote={(project, slug) => setNote({ project, slug })}
            />
            {note && (
              <NoteViewer
                project={note.project}
                slug={note.slug}
                onClose={() => setNote(null)}
                onOpenSlug={(project, slug) => setNote({ project, slug })}
              />
            )}
          </div>

          <SessionFleet sessions={status.sessions} />

          <div className="argus-cols">
            <HealthPanel health={status.health} modes={status.monitorModes} heartbeats={status.heartbeats} />
            <GatePanel gate={status.stats?.gate ?? null} activity={status.activity} />
            <LatencyPanel stats={status.stats} />
          </div>

          {/* full-width row: the whole kami roster with the live mode lit */}
          <ModeCatalog active={status.modes} />
        </div>
      )}
    </div>
  );
}
