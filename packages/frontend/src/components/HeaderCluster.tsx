import { memo, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { api } from '../api';
import type { ActiveRun, VitalsFeed } from '../types';

const POLL_MS = 5000;

/** "(3h52m)" / "(6d10h)" / "(41m)" from a unix-epoch-seconds reset time. */
export function fmtEta(resetsAtSec: number | undefined, nowMs: number): string {
  if (!resetsAtSec) return '';
  const min = Math.max(0, (resetsAtSec * 1000 - nowMs) / 60000);
  if (min >= 1440) return `(${Math.floor(min / 1440)}d${Math.round((min % 1440) / 60)}h)`;
  if (min >= 60) return `(${Math.floor(min / 60)}h${Math.round(min % 60)}m)`;
  return `(${Math.max(1, Math.round(min))}m)`;
}

// Memoized: the canvas redraw effect keys on `points` identity, so with the
// useMemo'd series below a Spark repaints only when a new vitals tick lands —
// not on every parent render.
const Spark = memo(function Spark({ points, max, color, dot, label, value, autoscale }: {
  points: number[];
  max: number;
  color: string;
  /** endpoint ("now") marker — deliberately a different color than the line */
  dot: string;
  label: string;
  value: string;
  /** fit the Y range to the data (for slow-moving series like memory) */
  autoscale?: boolean;
}) {
  const ref = useRef<HTMLCanvasElement>(null);
  useEffect(() => {
    const cv = ref.current;
    const g = cv?.getContext('2d');
    if (!cv || !g) return;
    const W = cv.width;
    const H = cv.height;
    g.clearRect(0, 0, W, H);
    g.strokeStyle = 'rgba(255,255,255,.08)';
    g.beginPath();
    g.moveTo(0, H / 2);
    g.lineTo(W, H / 2);
    g.stroke();
    if (points.length < 2) return;
    // Y scale: absolute 0..max, or fitted to the data so slow-moving series
    // (memory) still show visible motion instead of a flat line at one edge.
    let lo = 0;
    let hi = max;
    if (autoscale) {
      const dMin = Math.min(...points);
      const dMax = Math.max(...points);
      const pad = Math.max((dMax - dMin) * 0.25, max * 0.01);
      lo = Math.max(0, dMin - pad);
      hi = Math.min(max, dMax + pad);
      if (hi - lo <= 0) hi = lo + 1;
    }
    const step = W / (points.length - 1);
    const y = (v: number) => H - 3 - ((Math.min(Math.max(v, lo), hi) - lo) / (hi - lo)) * (H - 7);
    // just the line…
    g.strokeStyle = color;
    g.lineWidth = 1.6;
    g.beginPath();
    points.forEach((p, i) => (i ? g.lineTo(i * step, y(p)) : g.moveTo(0, y(p))));
    g.stroke();
    // …and the "now" dot in its own color
    g.fillStyle = dot;
    g.beginPath();
    g.arc(W - 3, y(points[points.length - 1]), 2.4, 0, 7);
    g.fill();
  }, [points, max, color, dot, autoscale]);
  return (
    <span className="hdrc-vit" title={`system ${label} — whole machine`}>
      <span className="hdrc-lab">{label}</span>
      <canvas ref={ref} width={80} height={24} />
      <span className="hdrc-val">{value}</span>
    </span>
  );
});

interface Props {
  runs: ActiveRun[];
  /** run ids currently streaming output (the sidebar-pulse signal) */
  workingIds: ReadonlySet<string>;
  onFocusRun: (runId: string) => void;
}

/**
 * The header Instrument Cluster — Run Pulse × Vitals × Usage as one strip:
 * a segment per open terminal (click focuses its tab), CPU/MEM sparklines of
 * the spawned-process tree, and the 5h/7d Claude windows with their reset
 * clocks inline. Zones hide themselves when their feed is absent.
 */
// Memoized: App re-renders on every activity edge / toast / dock-drag frame;
// the cluster only needs to follow runs, workingIds, and its own vitals feed.
export const HeaderCluster = memo(function HeaderCluster({ runs, workingIds, onFocusRun }: Props) {
  const [feed, setFeed] = useState<VitalsFeed | null>(null);
  const inflight = useRef(false);

  const load = useCallback(async () => {
    if (inflight.current) return;
    inflight.current = true;
    try {
      setFeed(await api.getVitals());
    } catch {
      /* keep last feed */
    } finally {
      inflight.current = false;
    }
  }, []);

  useEffect(() => {
    void load();
    const id = setInterval(() => void load(), POLL_MS);
    return () => clearInterval(id);
  }, [load]);

  const history = feed?.history ?? [];
  // Stable per feed tick, so the memoized Sparks skip repaints between polls.
  const cpuPts = useMemo(() => history.map((h) => h.cpu), [feed]); // eslint-disable-line react-hooks/exhaustive-deps
  const memPts = useMemo(() => history.map((h) => h.memMB), [feed]); // eslint-disable-line react-hooks/exhaustive-deps
  const last = history[history.length - 1];
  // Scale the memory spark against the machine's real capacity.
  const memMax = feed?.machine?.totalMemMB || Math.max(1024, ...memPts);
  const running = runs.filter((r) => r.status === 'running' || r.status === 'connecting').length;

  const rl = feed?.usage?.rate_limits;
  const now = Date.now();
  const windows = [
    { key: '5H', win: rl?.five_hour },
    { key: '7D', win: rl?.seven_day },
  ].filter((w) => w.win?.used_percentage != null);

  const segClass = (r: ActiveRun): string => {
    if (r.status === 'error' || (r.exitCode != null && r.exitCode !== 0)) return 'bad';
    if (r.status === 'running' || r.status === 'connecting') {
      return workingIds.has(r.runId) ? 'run stream' : 'run';
    }
    return 'done';
  };

  return (
    <div className="hdrc" aria-label="Instrument cluster">
      {runs.length > 0 && (
        <span className="hdrc-zone">
          <span className="hdrc-lab">runs</span>
          <span className="hdrc-segs">
            {runs.map((r) => (
              <button
                key={r.runId}
                className={`hdrc-seg ${segClass(r)}`}
                title={`${r.projectName} · ${r.customLabel ?? r.label} — ${r.status}`}
                onClick={() => onFocusRun(r.runId)}
              />
            ))}
          </span>
          <span className="hdrc-cnt">{running} run</span>
        </span>
      )}

      {runs.length > 0 && history.length > 1 && <span className="hdrc-div" />}

      {history.length > 1 && (
        <span className="hdrc-zone">
          <Spark
            points={cpuPts}
            max={100}
            color="#ff5561"
            dot="#ffffff"
            label="cpu"
            value={last ? `${Math.round(last.cpu)}%` : '—'}
          />
          <Spark
            points={memPts}
            max={memMax}
            color="#58b7ff"
            dot="#ffffff"
            label="mem"
            value={last ? `${(last.memMB / 1024).toFixed(1)}G` : '—'}
            autoscale
          />
        </span>
      )}

      {windows.length > 0 && history.length > 1 && <span className="hdrc-div" />}

      {windows.length > 0 && (
        <span className="hdrc-zone">
          {windows.map(({ key, win }) => {
            const pct = Math.round(win?.used_percentage ?? 0);
            const level = pct >= 80 ? 'crit' : pct >= 50 ? 'warn' : 'ok';
            return (
              <span
                key={key}
                className="hdrc-win"
                title={`${key === '5H' ? '5-hour' : '7-day'} window at ${pct}% — resets in ${fmtEta(win?.resets_at, now).replace(/[()]/g, '')}`}
              >
                <span className="hdrc-lab">
                  {key} <span className={`hdrc-eta ${pct >= 80 ? 'hot' : ''}`}>{fmtEta(win?.resets_at, now)}</span>
                </span>
                <span className="hdrc-track">
                  <span className={`hdrc-fill ${level}`} style={{ width: `${Math.min(100, pct)}%` }} />
                </span>
                <span className="hdrc-pct">{pct}%</span>
              </span>
            );
          })}
        </span>
      )}
    </div>
  );
});
