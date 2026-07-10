import { useEffect, useLayoutEffect, useReducer, useRef, useState } from 'react';
import type { ActiveRun } from '../types';
import { getRunActivityMap, subscribeRunActivity, type ActionKind, type RunActivity } from '../lib/runActivity';
import { AlienLifeform } from './AlienLifeform';

interface Props {
  // Runs already scoped to the dashboard's project.
  runs: ActiveRun[];
  // Runs currently streaming output ("processing").
  workingIds: Set<string>;
}

// Re-render on store updates, but COALESCED to a calm cadence so a chatty pty
// (or several at once) can't thrash the DOM into flicker. Bursts within the
// window collapse to a single render; a 1s heartbeat keeps "elapsed" fresh and
// lets just-idle cards fall away. Only updates for runs shown here count —
// output from other (backgrounded) projects' terminals is ignored.
const UPDATE_MS = 350;
function useLiveTick(visibleRunIds: string[]): void {
  const idsRef = useRef<Set<string>>(new Set());
  idsRef.current = new Set(visibleRunIds);
  const [, force] = useReducer((x: number) => x + 1, 0);
  useEffect(() => {
    let timer: ReturnType<typeof setTimeout> | null = null;
    const unsub = subscribeRunActivity((runId) => {
      if (!idsRef.current.has(runId)) return;
      if (timer) return; // a render is already scheduled — coalesce
      timer = setTimeout(() => {
        timer = null;
        force();
      }, UPDATE_MS);
    });
    const iv = setInterval(force, 1000);
    return () => {
      unsub();
      clearInterval(iv);
      if (timer) clearTimeout(timer);
    };
  }, []);
}

const KIND_ICON: Record<ActiveRun['kind'], string> = { claude: '✦', shell: '⌨', command: '▶' };

function ago(ms: number): string {
  const s = Math.max(0, Math.round(ms / 1000));
  if (s < 1) return 'now';
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  return `${m}m ${s % 60}s`;
}

function bytesFmt(n: number): string {
  if (n >= 1e6) return `${(n / 1e6).toFixed(1)}MB`;
  if (n >= 1e3) return `${(n / 1e3).toFixed(1)}KB`;
  return `${n}B`;
}

// A tiny SVG glyph per action kind — keeps the card readable at a glance.
const KIND_GLYPH: Record<ActionKind, string> = {
  edit: '✎',
  write: '＋',
  read: '◇',
  run: '»',
  search: '⌕',
  think: '✻',
  output: '·',
};

function baseName(p: string): string {
  return p.split(/[\\/]/).pop() || p;
}

function ProcessCard({ run, activity, now }: { run: ActiveRun; activity: RunActivity | undefined; now: number }): JSX.Element {
  const action = activity?.action ?? null;
  const kind: ActionKind = action?.kind ?? 'output';
  const title = run.customLabel ?? run.label;
  const lastTs = activity?.lastTs ?? now;
  const activeMs = activity ? Math.max(0, now - activity.startedTs) : 0;
  const lines = activity?.lines ?? 0;
  const bytes = activity?.bytes ?? 0;
  const rate = activeMs > 500 ? (bytes / activeMs) * 1000 : 0; // bytes/sec

  // Prior actions (exclude the one shown big) as a compact breadcrumb.
  const all = activity?.actions ?? [];
  let trail = all;
  const last = all[all.length - 1];
  if (action && last && last.kind === action.kind && last.target === action.target) trail = all.slice(0, -1);
  trail = trail.slice(-4);
  const files = (activity?.files ?? []).slice(-4);

  return (
    <article className={`lp-card act-${kind}`}>
      <span className="lp-beam" aria-hidden="true" />
      <span className="lp-scan" aria-hidden="true" />
      <header className="lp-head">
        <span className="lp-kind" title={run.kind}>
          {run.elevated ? '🛡 ' : ''}
          {KIND_ICON[run.kind]}
        </span>
        <span className="lp-title" title={`${run.projectName} · ${title}`}>
          {title}
        </span>
        <span className={`badge badge-${run.status} lp-badge`}>{run.status}</span>
      </header>

      <div className="lp-action">
        <span className="lp-glyph" aria-hidden="true">
          {KIND_GLYPH[kind]}
        </span>
        <span className="lp-verb">{action ? action.verb : 'Starting'}</span>
        {action?.target ? <span className="lp-target">{action.target}</span> : <span className="lp-caret" aria-hidden="true" />}
      </div>

      {trail.length > 0 && (
        <div className="lp-trail">
          {trail.map((a, i) => (
            <span key={i} className={`lp-chip act-${a.kind}`} title={a.target ? `${a.verb} ${a.target}` : a.verb}>
              <span className="lp-chip-g" aria-hidden="true">
                {KIND_GLYPH[a.kind]}
              </span>
              {a.verb}
            </span>
          ))}
        </div>
      )}

      {files.length > 0 && (
        <div className="lp-files">
          <span className="lp-files-h">FILES</span>
          {files.map((f) => (
            <span key={f.path} className={`lp-file act-${f.kind}`} title={f.path}>
              {baseName(f.path)}
            </span>
          ))}
        </div>
      )}

      <div className="lp-stats">
        <div className="lp-stat">
          <span className="lp-stat-v">{ago(activeMs)}</span>
          <span className="lp-stat-l">active</span>
        </div>
        <div className="lp-stat">
          <span className="lp-stat-v">{lines}</span>
          <span className="lp-stat-l">lines</span>
        </div>
        <div className="lp-stat">
          <span className="lp-stat-v">{bytesFmt(bytes)}</span>
          <span className="lp-stat-l">output</span>
        </div>
        <div className="lp-stat">
          <span className="lp-stat-v">{rate > 0 ? `${bytesFmt(rate)}/s` : '—'}</span>
          <span className="lp-stat-l">rate</span>
        </div>
      </div>

      {activity && activity.tail.length > 0 && (
        <div className="lp-tail" aria-hidden="true">
          {activity.tail.map((line, i) => (
            <div key={i} className="lp-line" style={{ opacity: 0.32 + (0.63 * (i + 1)) / activity.tail.length }}>
              {line}
            </div>
          ))}
        </div>
      )}

      <footer className="lp-foot">
        <span className="lp-live">
          <span className="lp-pulse" aria-hidden="true" />
          PROCESSING
        </span>
        <span className="lp-ago">updated {ago(now - lastTs)} ago</span>
      </footer>
    </article>
  );
}

// A light beam the organism projects out to one floating process card. Endpoints
// are measured in stage-local pixels so the SVG overlay lines up with the DOM.
interface Beam {
  x2: number;
  y2: number;
}

export function LiveProcesses({ runs, workingIds }: Props): JSX.Element {
  useLiveTick(runs.map((r) => r.runId));
  const now = Date.now();
  const map = getRunActivityMap();

  // Alive + currently streaming output = "processing". Keep the runs' own
  // (creation) order — sorting by last-activity would reshuffle the cards on
  // every output chunk and make them jump/flicker.
  const active = runs.filter(
    (r) => (r.status === 'running' || r.status === 'connecting') && workingIds.has(r.runId),
  );
  const intensity = Math.min(1, active.length / 3);

  // Tether geometry: the organism (via the emitter "core" node) projects a beam
  // to each card. We measure the core + every card in stage-local coordinates
  // and re-measure whenever the stage reflows (resize, wrap) or the card set
  // changes. The live-tick heartbeat re-renders but doesn't move cards, so it
  // doesn't trigger a re-measure.
  const stageRef = useRef<HTMLDivElement>(null);
  const coreRef = useRef<HTMLDivElement>(null);
  const gridRef = useRef<HTMLDivElement>(null);
  const [core, setCore] = useState<{ x: number; y: number }>({ x: 0, y: 0 });
  const [beams, setBeams] = useState<Beam[]>([]);
  const idKey = active.map((r) => r.runId).join('|');

  useLayoutEffect(() => {
    const stage = stageRef.current;
    const coreEl = coreRef.current;
    if (!stage || !coreEl) return;
    const measure = (): void => {
      const sb = stage.getBoundingClientRect();
      const cb = coreEl.getBoundingClientRect();
      const cx = cb.left + cb.width / 2 - sb.left;
      const cy = cb.top + cb.height / 2 - sb.top;
      setCore({ x: cx, y: cy });
      const cards = stage.querySelectorAll<HTMLElement>('.lp-card');
      const next: Beam[] = [];
      cards.forEach((el) => {
        const r = el.getBoundingClientRect();
        next.push({ x2: r.left + r.width / 2 - sb.left, y2: r.top - sb.top });
      });
      setBeams(next);
    };
    measure();
    const ro = new ResizeObserver(measure);
    ro.observe(stage);
    if (gridRef.current) ro.observe(gridRef.current);
    return () => ro.disconnect();
  }, [idKey]);

  return (
    <section className="lp lp--full">
      <div className="lp-hd">
        <span className="lp-hd-glyph" aria-hidden="true">
          ◢
        </span>
        <span className="lp-hd-title">LIVE PROCESSES</span>
        <span className={`lp-hd-count${active.length ? ' on' : ''}`}>
          {active.length ? `${active.length} processing` : 'idle'}
        </span>
      </div>

      <div ref={stageRef} className={`lp-stage${active.length ? ' on' : ''}`}>
        {/* the living organism, big + centered, filling the panel as the backdrop */}
        <AlienLifeform active={active.length > 0} intensity={intensity} offsetY={0} camZ={3.0} />

        {/* the emitter "core" — the point the organism projects its processes from */}
        <div ref={coreRef} className="lp-core" aria-hidden="true">
          <span className="lp-core-ring" />
          <span className="lp-core-dot" />
        </div>

        {/* tether beams from the core out to each floating card */}
        {beams.length > 0 && (
          <svg className="lp-tethers" aria-hidden="true">
            {beams.map((b, i) => (
              <g key={i}>
                <line className="lp-beam-line" x1={core.x} y1={core.y} x2={b.x2} y2={b.y2} />
                <circle className="lp-beam-node" cx={b.x2} cy={b.y2} r={3.2} />
              </g>
            ))}
          </svg>
        )}

        <div className="lp-hero-label">
          <span className={`lp-hero-state${active.length ? ' on' : ''}`}>
            {active.length ? 'ORGANISM · ACTIVE' : 'ORGANISM · DORMANT'}
          </span>
          <span className="lp-hero-sub">
            {active.length
              ? `projecting ${active.length} process${active.length > 1 ? 'es' : ''}`
              : 'awaiting activity'}
          </span>
        </div>

        {active.length > 0 ? (
          <div ref={gridRef} className="lp-grid">
            {active.map((r) => (
              <ProcessCard key={r.runId} run={r} activity={map.get(r.runId)} now={now} />
            ))}
          </div>
        ) : (
          <div className="lp-idle">
            <span className="lp-idle-dot" aria-hidden="true" />
            No active operations — this project&rsquo;s terminals are idle. Run a{' '}
            <b>Claude</b> or <b>shell</b> tab and its live work shows here in real time.
          </div>
        )}
      </div>
    </section>
  );
}
