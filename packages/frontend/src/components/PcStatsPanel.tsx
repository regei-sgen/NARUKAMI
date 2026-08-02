import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { api } from '../api';
import type { GpuStat, PcStats, TempReading } from '../types';

const POLL_MS = 2000;

/** Temperature range the traces are drawn across. */
const LO = 30;
const HI = 100;

/** Cold -> hot colour ramp (green, lime, yellow, amber, red, coral). */
const RAMP: [number, [number, number, number]][] = [
  [0, [36, 229, 142]],
  [0.3, [156, 240, 60]],
  [0.52, [255, 212, 41]],
  [0.72, [255, 158, 36]],
  [0.88, [255, 68, 56]],
  [1, [255, 106, 85]],
];

/** Interpolate the ramp at t (0..1). Pure. */
export function rampRgb(t: number): [number, number, number] {
  const x = Math.max(0, Math.min(1, Number.isFinite(t) ? t : 0));
  for (let i = 0; i < RAMP.length - 1; i += 1) {
    const [a, ca] = RAMP[i];
    const [b, cb] = RAMP[i + 1];
    if (x <= b) {
      const k = b === a ? 0 : (x - a) / (b - a);
      return [
        Math.round(ca[0] + (cb[0] - ca[0]) * k),
        Math.round(ca[1] + (cb[1] - ca[1]) * k),
        Math.round(ca[2] + (cb[2] - ca[2]) * k),
      ];
    }
  }
  return [255, 106, 85];
}

/** Normalise a temperature onto the drawn range. Pure. */
export function normTemp(c: number): number {
  return Math.max(0, Math.min(1, (c - LO) / (HI - LO)));
}

const css = (c: [number, number, number]): string => `rgb(${c[0]},${c[1]},${c[2]})`;
const lift = (c: [number, number, number], a: number): string =>
  `rgb(${c.map((v) => Math.round(v + (255 - v) * a)).join(',')})`;
const drop = (c: [number, number, number], a: number): string =>
  `rgb(${c.map((v) => Math.round(v * (1 - a))).join(',')})`;

/** "3h 52m" / "6d 10h" / "41m" from a second count. Pure. */
export function fmtUptime(sec: number): string {
  if (!Number.isFinite(sec) || sec < 0) return '—';
  const d = Math.floor(sec / 86400);
  const h = Math.floor((sec % 86400) / 3600);
  const m = Math.floor((sec % 3600) / 60);
  if (d > 0) return `${d}d ${h}h`;
  if (h > 0) return `${h}h ${m}m`;
  return `${m}m`;
}

/** Clock time of the last boot, for the "last boot …" line. Pure. */
export function bootStamp(uptimeSec: number, now: Date): string {
  const boot = new Date(now.getTime() - uptimeSec * 1000);
  const hh = String(boot.getHours()).padStart(2, '0');
  const mm = String(boot.getMinutes()).padStart(2, '0');
  const sameDay = boot.toDateString() === now.toDateString();
  return `${hh}:${mm}${sameDay ? '' : ' yesterday'}`;
}

/** Thermal banding, kept for the meters. Pure. */
export function tempLevel(c: number | null): 'none' | 'ok' | 'warn' | 'crit' {
  if (c === null) return 'none';
  if (c >= 85) return 'crit';
  if (c >= 70) return 'warn';
  return 'ok';
}

/** Load banding. Pure. */
export function loadLevel(pct: number): 'ok' | 'warn' | 'crit' {
  if (pct >= 90) return 'crit';
  if (pct >= 70) return 'warn';
  return 'ok';
}

/**
 * SVG path pair (line + filled area) for a temperature series across a 120x40
 * viewBox, drawn as a SMOOTH curve.
 *
 * Straight segments between samples made the trace read as hard zig-zags. This
 * converts the points to a Catmull-Rom spline expressed as cubic Béziers, which
 * passes exactly through every sample (so nothing is misreported) while
 * rounding the corners between them.
 *
 * Pure, so the geometry is testable without a renderer.
 */
export function tracePaths(series: number[]): { line: string; area: string } {
  if (series.length < 2) return { line: '', area: '' };
  const y = (v: number): number => 40 - normTemp(v) * 38 - 1;
  const step = 120 / (series.length - 1);
  const pts = series.map((v, i) => ({ x: i * step, y: y(v) }));
  const n = (v: number): string => v.toFixed(2);

  let line = `M ${n(pts[0].x)} ${n(pts[0].y)}`;
  for (let i = 0; i < pts.length - 1; i += 1) {
    const p0 = pts[i - 1] ?? pts[i];
    const p1 = pts[i];
    const p2 = pts[i + 1];
    const p3 = pts[i + 2] ?? p2;
    // Catmull-Rom -> Bézier control points (tension 1/6 = the standard form).
    const c1x = p1.x + (p2.x - p0.x) / 6;
    const c2x = p2.x - (p3.x - p1.x) / 6;
    // Clamp the vertical tangents to the segment's own range. Unclamped
    // Catmull-Rom overshoots between samples, which on a temperature chart
    // would draw a peak HOTTER than anything actually measured.
    const loY = Math.min(p1.y, p2.y);
    const hiY = Math.max(p1.y, p2.y);
    const clampY = (v: number): number => Math.max(loY, Math.min(hiY, v));
    const c1y = clampY(p1.y + (p2.y - p0.y) / 6);
    const c2y = clampY(p2.y - (p3.y - p1.y) / 6);
    line += ` C ${n(c1x)} ${n(c1y)}, ${n(c2x)} ${n(c2y)}, ${n(p2.x)} ${n(p2.y)}`;
  }
  // The fill is the same curve, closed down to the baseline.
  const area = `M 0 40 L ${n(pts[0].x)} ${n(pts[0].y)}${line.slice(
    line.indexOf(' C') === -1 ? line.length : line.indexOf(' C'),
  )} L 120 40 Z`;
  return { line, area };
}

const val = (n: number | null, digits = 0): string =>
  n === null ? '—' : digits ? n.toFixed(digits) : String(Math.round(n));

/** Exponential ease toward a target. Pure. */
export function ease(from: number, to: number, k: number): number {
  return from + (to - from) * Math.max(0, Math.min(1, k));
}

/**
 * Resample a series to a fixed length by linear interpolation, so a growing
 * history can be tweened against the previous frame element-by-element. Pure.
 */
export function resample(series: number[], length: number): number[] {
  if (length <= 0) return [];
  if (series.length === 0) return new Array<number>(length).fill(0);
  if (series.length === 1) return new Array<number>(length).fill(series[0]);
  const out: number[] = [];
  for (let i = 0; i < length; i += 1) {
    const t = (i / (length - 1)) * (series.length - 1);
    const lo = Math.floor(t);
    const hi = Math.min(series.length - 1, lo + 1);
    out.push(series[lo] + (series[hi] - series[lo]) * (t - lo));
  }
  return out;
}

const TWEEN_POINTS = 72;

/**
 * Ease a series toward the freshly polled one every animation frame.
 *
 * The readout polls every 2 s; drawing each payload directly made the trace and
 * the figures jump. Tweening turns those steps into continuous motion without
 * inventing data — the target is always the real sample set.
 */
function useAnimatedSeries(target: number[]): number[] {
  const [shown, setShown] = useState<number[]>([]);
  const cur = useRef<number[]>([]);
  const goal = useRef<number[]>([]);

  goal.current = target.length >= 2 ? resample(target, TWEEN_POINTS) : [];

  useEffect(() => {
    let raf = 0;
    const step = (): void => {
      const g = goal.current;
      if (g.length === 0) {
        if (cur.current.length) {
          cur.current = [];
          setShown([]);
        }
      } else {
        if (cur.current.length !== g.length) cur.current = g.slice();
        else cur.current = cur.current.map((v, i) => ease(v, g[i], 0.12));
        setShown(cur.current.slice());
      }
      raf = requestAnimationFrame(step);
    };
    raf = requestAnimationFrame(step);
    return () => cancelAnimationFrame(raf);
  }, []);

  return shown;
}

/** Ease a single number toward its target (for the big figures). */
function useAnimatedNumber(target: number | null): number | null {
  const [shown, setShown] = useState<number | null>(target);
  const cur = useRef<number | null>(target);
  const goal = useRef<number | null>(target);
  goal.current = target;

  useEffect(() => {
    let raf = 0;
    const step = (): void => {
      const g = goal.current;
      if (g === null) {
        if (cur.current !== null) {
          cur.current = null;
          setShown(null);
        }
      } else {
        cur.current = cur.current === null ? g : ease(cur.current, g, 0.14);
        if (Math.abs((cur.current ?? 0) - g) < 0.05) cur.current = g;
        setShown(cur.current);
      }
      raf = requestAnimationFrame(step);
    };
    raf = requestAnimationFrame(step);
    return () => cancelAnimationFrame(raf);
  }, []);

  return shown;
}

/** A metric column: label, big gloss value, and a thin bar. */
function Metric({ label, value, unit, pct, size }: {
  label: string;
  value: string;
  unit?: string;
  pct?: number;
  /** column width class — kept in CSS, not inline, so narrow layouts can reflow it */
  size?: 'load' | 'mem';
}): JSX.Element {
  const c = pct === undefined ? null : rampRgb(pct);
  return (
    <div className={`pcv-metric${size ? ` pcv-m-${size}` : ''}`}>
      <span className="pcv-lbl">{label}</span>
      <span className="pcv-val pcv-gloss">
        {value}
        {unit && <span className="pcv-u">{unit}</span>}
      </span>
      {pct !== undefined && c && (
        <span className="pcv-bar">
          <i
            style={{
              width: `${Math.max(3, Math.min(100, pct * 100))}%`,
              background: `linear-gradient(180deg,${lift(c, 0.62)},${css(c)})`,
              boxShadow: `0 0 ${9 + 16 * pct}px rgba(${c[0]},${c[1]},${c[2]},.9), inset 0 1px 0 rgba(255,255,255,.5)`,
            }}
          />
        </span>
      )}
    </div>
  );
}

/**
 * One instrument card: a full-bleed temperature trace behind the readouts, both
 * tinted by how hot the part currently is.
 */
function Unit({ tag, part, ceiling, series, tempC, warn, children }: {
  tag: string;
  part: string;
  ceiling: string;
  series: number[];
  tempC: number | null;
  warn: string | null;
  children: React.ReactNode;
}): JSX.Element {
  const id = tag.toLowerCase();
  const smooth = useAnimatedSeries(series);
  const { line, area } = useMemo(() => tracePaths(smooth), [smooth]);
  const animTemp = useAnimatedNumber(tempC);
  const n = animTemp === null ? 0 : normTemp(animTemp);
  const c = rampRgb(n);
  const stroke = css(c);

  return (
    <section
      className="pcv-unit"
      style={{
        boxShadow:
          'inset 0 1px 0 rgba(255,255,255,.22), inset 0 -1px 0 rgba(0,0,0,.55),' +
          `0 10px 36px rgba(0,0,0,.8), 0 0 ${58 + 64 * n}px -14px rgba(${c[0]},${c[1]},${c[2]},${(0.5 + 0.45 * n).toFixed(2)})`,
      }}
    >
      <svg className="pcv-trace" preserveAspectRatio="none" viewBox="0 0 120 40" aria-hidden="true">
        <defs>
          <linearGradient id={`pcvFill-${id}`} x1="0" y1="0" x2="0" y2="1">
            <stop offset="0%" stopColor={stroke} stopOpacity=".54" />
            <stop offset="60%" stopColor={stroke} stopOpacity=".15" />
            <stop offset="100%" stopColor={stroke} stopOpacity="0" />
          </linearGradient>
        </defs>
        <g stroke="#fff" strokeOpacity=".08" strokeWidth=".35" vectorEffect="non-scaling-stroke">
          {[80, 60, 40].map((v) => {
            const y = 40 - normTemp(v) * 38 - 1;
            return <line key={v} x1="0" x2="120" y1={y} y2={y} />;
          })}
        </g>
        {area && <path d={area} fill={`url(#pcvFill-${id})`} />}
        {line && (
          <path
            d={line}
            fill="none"
            stroke={stroke}
            strokeOpacity=".34"
            strokeWidth="7"
            strokeLinejoin="round"
            vectorEffect="non-scaling-stroke"
          />
        )}
        {line && (
          <path
            d={line}
            fill="none"
            stroke={stroke}
            strokeWidth="2.1"
            strokeLinejoin="round"
            vectorEffect="non-scaling-stroke"
          />
        )}
      </svg>
      <div className="pcv-scrim" />
      <div className="pcv-fg">
        <div className="pcv-head">
          <span className="pcv-tag pcv-gloss">{tag}</span>
          <span className="pcv-part" title={part}>
            {part}
          </span>
          <span className="pcv-spacer" />
          {warn && <span className="pcv-warn">{warn}</span>}
          <span className="pcv-ceil">{ceiling}</span>
        </div>
        <div className="pcv-readouts">{children}</div>
      </div>
    </section>
  );
}

/** Big temperature figure, lit in its own state colour. */
function DieTemp({ tempC, note }: { tempC: number | null; note: React.ReactNode }): JSX.Element {
  const anim = useAnimatedNumber(tempC);
  const n = anim === null ? 0 : normTemp(anim);
  const c = rampRgb(n);
  return (
    <div className="pcv-metric">
      <span className="pcv-lbl">DIE TEMP</span>
      <span
        className="pcv-val pcv-gloss"
        style={
          anim === null
            ? undefined
            : {
                backgroundImage: `linear-gradient(180deg,${lift(c, 0.8)} 0%,${css(c)} 48%,${drop(c, 0.42)} 100%)`,
                filter: `drop-shadow(0 0 ${9 + 22 * n}px rgba(${c[0]},${c[1]},${c[2]},.85))`,
              }
        }
      >
        {anim === null ? '—' : Math.round(anim)}
        <span className="pcv-u">°C</span>
      </span>
      <span className="pcv-note">{note}</span>
    </div>
  );
}

/**
 * The PC Stats readout, in the vivid instrument style: two glass instrument
 * cards (CPU, GPU) with live temperature traces, plus a system rail. Laid out
 * landscape-first — cards left, rail right — and collapsing to one column in
 * portrait.
 *
 * Sensors the machine doesn't expose render as "—" with the reason, never as a
 * fabricated number.
 */
export function PcStatsPanel({ active = true, onMenu }: {
  active?: boolean;
  onMenu?: () => void;
}): JSX.Element {
  const [stats, setStats] = useState<PcStats | null>(null);
  const [err, setErr] = useState(false);
  const [age, setAge] = useState(0);
  const inflight = useRef(false);

  const load = useCallback(async () => {
    if (inflight.current) return;
    inflight.current = true;
    try {
      setStats(await api.getPcStats());
      setErr(false);
      setAge(0);
    } catch {
      setErr(true);
    } finally {
      inflight.current = false;
    }
  }, []);

  useEffect(() => {
    if (!active) return;
    void load();
    const poll = setInterval(() => void load(), POLL_MS);
    const clock = setInterval(() => setAge((a) => a + 1), 1000);
    return () => {
      clearInterval(poll);
      clearInterval(clock);
    };
  }, [active, load]);

  if (!stats) {
    return <div className={`pcv-empty ${err ? 'bad' : ''}`}>{err ? 'sensor feed unavailable' : 'reading sensors…'}</div>;
  }

  const cpuTemp = stats.temps.find((t) => t.label === 'CPU');
  const gpuTemps = stats.temps.filter((t) => t.label.startsWith('GPU'));
  const gpu: GpuStat | undefined = stats.gpus[0];
  const gpuTemp: TempReading | undefined = gpuTemps[0];

  const memG = stats.mem.usedMB / 1024;
  const memTotalG = stats.mem.totalMB / 1024;
  const disk = stats.status.disk;
  const battery = stats.status.battery;
  const tj = stats.cpu.tjMaxC;

  const coreLabel = stats.cpu.physicalCores
    ? `${stats.cpu.physicalCores}C/${stats.cpu.cores}T`
    : `${stats.cpu.cores}T`;
  // "Intel(R) Core(TM) i7-9750H CPU @ 2.60GHz" -> "Intel Core i7-9750H"
  const cpuName = stats.cpu.model
    .replace(/\((R|TM)\)/g, '')
    .replace(/\s*CPU\s*@.*$/, '')
    .replace(/\s+/g, ' ')
    .trim();

  const hot = (t: number | null, limit: number | null): string | null => {
    if (t === null || limit === null) return null;
    if (t >= limit - 8) return `${Math.round(t)}°C — near limit`;
    return null;
  };

  return (
    <div className="pcv">
      <div className="pcv-stack">
        <Unit
          tag="CPU"
          part={`${cpuName} · ${coreLabel} · ${(stats.cpu.speedMHz / 1000).toFixed(2)} GHz`}
          ceiling={`die temp · ${LO}–${HI}°C${tj ? ` · Tj max ${tj}` : ''}`}
          series={stats.series?.cpuTemp ?? []}
          tempC={cpuTemp?.celsius ?? null}
          warn={hot(cpuTemp?.celsius ?? null, tj)}
        >
          <Metric
            label="LOAD"
            value={String(Math.round(stats.cpu.loadPct))}
            unit="%"
            pct={stats.cpu.loadPct / 100}
            size="load"
          />
          <Metric
            label="MEMORY"
            value={memG.toFixed(1)}
            unit={`/ ${Math.round(memTotalG)} G`}
            pct={memG / memTotalG}
            size="mem"
          />
          <DieTemp
            tempC={cpuTemp?.celsius ?? null}
            note={
              cpuTemp?.celsius === null || cpuTemp === undefined
                ? (cpuTemp?.note ?? 'no sensor')
                : tj
                  ? `${Math.max(0, Math.round(tj - cpuTemp.celsius))}°C of headroom`
                  : (cpuTemp.note ?? '')
            }
          />
        </Unit>

        <Unit
          tag="GPU"
          part={
            gpu
              ? `${gpu.name.replace(/NVIDIA GeForce /, '').replace(/ with Max-Q Design/, ' Max-Q')} · ${
                  gpu.memTotalMB ? `${Math.round(gpu.memTotalMB / 1024)} GB` : '—'
                }`
              : 'no GPU telemetry available'
          }
          ceiling={`die temp · ${LO}–${HI}°C`}
          series={stats.series?.gpuTemp ?? []}
          tempC={gpuTemp?.celsius ?? null}
          warn={null}
        >
          <Metric
            label="LOAD"
            value={val(gpu?.utilPct ?? null)}
            unit="%"
            pct={(gpu?.utilPct ?? 0) / 100}
            size="load"
          />
          <Metric
            label="VRAM"
            value={gpu?.memUsedMB != null ? (gpu.memUsedMB / 1024).toFixed(1) : '—'}
            unit={gpu?.memTotalMB ? `/ ${Math.round(gpu.memTotalMB / 1024)} G` : ''}
            pct={gpu?.memUsedMB != null && gpu.memTotalMB ? gpu.memUsedMB / gpu.memTotalMB : 0}
            size="mem"
          />
          <DieTemp
            tempC={gpuTemp?.celsius ?? null}
            note={
              <span className="pcv-chips">
                <span className={`pcv-chip ${gpu?.powerW == null ? 'na' : ''}`}>
                  {gpu?.powerW != null ? `${gpu.powerW.toFixed(1)} W` : 'W —'}
                </span>
                <span className={`pcv-chip ${gpu?.clockMHz == null ? 'na' : ''}`}>
                  {gpu?.clockMHz != null ? `${gpu.clockMHz} MHz` : 'clock —'}
                </span>
                <span className={`pcv-chip ${gpu?.fanPct == null ? 'na' : ''}`}>
                  {gpu?.fanPct != null ? `fan ${gpu.fanPct}%` : 'fan —'}
                </span>
              </span>
            }
          />
        </Unit>
      </div>

      <aside className="pcv-sys">
        <div className="pcv-ident">
          <span className="pcv-dot" />
          <span className="pcv-host pcv-gloss">{stats.status.hostname.toUpperCase()}</span>
          <span className="pcv-spacer" />
          {onMenu && (
            <button className="pcv-kebab" onClick={onMenu} aria-label="Panel menu">
              ⋮
            </button>
          )}
        </div>
        <div className="pcv-stamp">
          {stats.status.platform} · {stats.status.arch} · {age}s ago
        </div>

        {disk && (
          <div className="pcv-row">
            <div className="pcv-top">
              <span className="pcv-k">STORAGE</span>
              <span className="pcv-v pcv-gloss">
                {Math.round(disk.freeGB)}
                <span className="pcv-vu"> G free</span>
              </span>
            </div>
            <span className="pcv-track">
              <i
                style={{
                  width: `${Math.min(100, ((disk.totalGB - disk.freeGB) / disk.totalGB) * 100)}%`,
                  background: `linear-gradient(180deg,${lift(rampRgb((disk.totalGB - disk.freeGB) / disk.totalGB), 0.62)},${css(rampRgb((disk.totalGB - disk.freeGB) / disk.totalGB))})`,
                }}
              />
            </span>
            <span className="pcv-sub">
              {Math.round(disk.totalGB - disk.freeGB)} G used of {Math.round(disk.totalGB)} G ·{' '}
              {Math.round((disk.freeGB / disk.totalGB) * 100)}% free
            </span>
          </div>
        )}

        <div className="pcv-row">
          <div className="pcv-top">
            <span className="pcv-k">POWER</span>
            <span className="pcv-v pcv-gloss pcv-ac">{battery?.charging ? 'AC' : battery ? 'BATT' : 'AC'}</span>
          </div>
          <span className="pcv-track">
            <i
              style={{
                width: `${battery ? battery.percent : 100}%`,
                background: 'linear-gradient(180deg,rgb(146,244,199),rgb(36,229,142))',
              }}
            />
          </span>
          <span className="pcv-sub">
            {battery ? `battery ${battery.percent}% · ${battery.label}` : 'no battery · on AC'}
          </span>
        </div>

        <div className="pcv-row">
          <div className="pcv-top">
            <span className="pcv-k">UPTIME</span>
            <span className="pcv-v pcv-gloss">{fmtUptime(stats.status.uptimeSec)}</span>
          </div>
          <span className="pcv-sub">last boot {bootStamp(stats.status.uptimeSec, new Date())}</span>
        </div>

        <div className="pcv-foot">
          <span>cpu · {cpuTemp?.celsius != null ? (cpuTemp.note ?? 'sensor').replace('via ', '') : 'no sensor'}</span>
          <span>gpu · {stats.gpuSource ?? 'unavailable'}</span>
          <span>poll {POLL_MS / 1000}s · {stats.series?.cpuTemp?.length ?? 0} samples</span>
        </div>
      </aside>
    </div>
  );
}
