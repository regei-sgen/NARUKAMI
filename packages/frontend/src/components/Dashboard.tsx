import { useCallback, useEffect, useMemo, useState } from 'react';
import { api } from '../api';
import type { Project, SessionUsage, UsageReport, UsageWindow, UsageWindows } from '../types';

// Opus 4.8 pricing, $/token: input $5/M, output $25/M, cache write (5m) $6.25/M
// (1.25×), cache read $0.50/M (0.1×). Cost is an estimate from token counts.
const PRICE = { input: 5e-6, output: 25e-6, cw: 6.25e-6, cr: 0.5e-6 };

const BUCKETS = [
  { key: 'cr', name: 'Cache read', cssVar: '--purple', note: 'reused prompt prefix', rate: '0.1×' },
  { key: 'output', name: 'Output', cssVar: '--accent', note: 'generated tokens', rate: '$25/M' },
  { key: 'cw', name: 'Cache write', cssVar: '--yellow', note: 'new prompt cached', rate: '1.25×' },
  { key: 'input', name: 'Input', cssVar: '--green', note: 'uncached prompt', rate: '$5/M' },
] as const;

const nf = new Intl.NumberFormat('en-US');
const tok = (n: number): string =>
  n >= 1e9 ? `${(n / 1e9).toFixed(2)}B` : n >= 1e6 ? `${(n / 1e6).toFixed(1)}M` : n >= 1e3 ? `${(n / 1e3).toFixed(1)}K` : String(n);
const usd = (n: number): string => `$${n.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
const usdc = (n: number): string => (n >= 1 ? usd(n) : `$${n.toFixed(n < 0.01 ? 4 : 3)}`);
const pctS = (x: number): string => `${(x * 100).toFixed(1)}%`;

const FIVE_H_MS = 5 * 60 * 60 * 1000;
const WEEK_MS = 7 * 24 * 60 * 60 * 1000;
const winCost = (w: UsageWindow): number =>
  w.input * PRICE.input + w.output * PRICE.output + w.cacheCreate * PRICE.cw + w.cacheRead * PRICE.cr;
function fmtDur(ms: number): string {
  if (ms <= 0) return 'now';
  const m = Math.floor(ms / 60000);
  const d = Math.floor(m / 1440);
  const h = Math.floor((m % 1440) / 60);
  const mm = m % 60;
  if (d > 0) return `${d}d ${h}h`;
  if (h > 0) return `${h}h ${mm}m`;
  return `${mm}m`;
}

interface Caps {
  fiveHour?: number;
  weekly?: number;
}

const pctLevel = (pct: number): string => (pct >= 90 ? 'crit' : pct >= 70 ? 'warn' : 'ok');

/** Account-wide "how close to full am I" section. Prefers Anthropic's REAL
 *  subscription percentages (from ~/.claude/usage-live.json — same as claude.ai);
 *  falls back to a local token estimate + user cap when that snapshot is absent.
 *  Always shows a 24-hour tokens/hour histogram. */
function UsageLimits({ win, caps, onCap }: { win: UsageWindows; caps: Caps; onCap: (k: keyof Caps, tokens: number) => void }): JSX.Element {
  const live = win.live;
  const nowMs = Date.now();
  const hourMax = Math.max(1, ...win.perHour.map((b) => b.tokens));

  const liveRows = [
    { label: '5-hour session', lw: live.fiveHour, local: win.fiveHour },
    { label: 'Weekly', lw: live.sevenDay, local: win.weekly },
  ];
  const estRows = [
    { k: 'fiveHour' as const, label: '5-hour window', w: win.fiveHour, cap: caps.fiveHour ?? 0, windowMs: FIVE_H_MS },
    { k: 'weekly' as const, label: 'Weekly window', w: win.weekly, cap: caps.weekly ?? 0, windowMs: WEEK_MS },
  ];

  return (
    <div className="dash-panel">
      <h3>
        Claude usage
        <span className="dash-eyebrow dash-inline">{live.available ? 'live · matches claude.ai' : `estimated · ${win.projects} projects`}</span>
      </h3>

      {live.available ? (
        <>
          <p className="dash-cap">
            Anthropic's real subscription usage — the same numbers as <b>claude.ai → Settings → Usage</b> and <code>/usage</code>.
            {live.ts != null && (live.stale
              ? <> Snapshot is <b>{fmtDur(nowMs - live.ts)}</b> old — interact with a Claude session to refresh.</>
              : <> Updated {fmtDur(nowMs - live.ts)} ago.</>)}
          </p>
          <div className="dash-gauges">
            {liveRows.map((r) => {
              if (!r.lw) {
                return (
                  <div key={r.label} className="dash-gauge lvl-none">
                    <div className="dash-gauge-top"><span className="dash-gauge-label">{r.label}</span></div>
                    <div className="dash-gauge-meta"><span>not reported yet</span></div>
                  </div>
                );
              }
              const pct = r.lw.usedPercentage;
              return (
                <div key={r.label} className={`dash-gauge lvl-${pctLevel(pct)}`}>
                  <div className="dash-gauge-top">
                    <span className="dash-gauge-label">{r.label}</span>
                    <span className="dash-gauge-pct">{pct}%</span>
                  </div>
                  <div className="dash-gauge-track">
                    <span className="dash-gauge-fill" style={{ width: `${Math.min(pct, 100)}%` }} />
                  </div>
                  <div className="dash-gauge-meta">
                    {r.lw.resetsAt != null && <span>resets in {fmtDur(r.lw.resetsAt - nowMs)}</span>}
                    <span title="local token estimate for this window">~{tok(r.local.tokens)} tok</span>
                  </div>
                </div>
              );
            })}
          </div>
        </>
      ) : (
        <>
          <p className="dash-cap">
            Estimated from local logs across every project. The real subscription % (matching claude.ai) needs the Claude Code usage reporter writing <code>~/.claude/usage-live.json</code> — not present yet. Set a cap to gauge how close to full you are.
          </p>
          <div className="dash-gauges">
            {estRows.map((r) => {
              const ratio = r.cap > 0 ? r.w.tokens / r.cap : 0;
              const level = r.cap <= 0 ? 'none' : ratio >= 0.9 ? 'crit' : ratio >= 0.7 ? 'warn' : 'ok';
              const freeIn = r.w.earliestTs != null ? r.w.earliestTs + r.windowMs - win.now : null;
              return (
                <div key={r.k} className={`dash-gauge lvl-${level}`}>
                  <div className="dash-gauge-top">
                    <span className="dash-gauge-label">{r.label}</span>
                    {r.cap > 0 && <span className="dash-gauge-pct">{Math.round(ratio * 100)}%{ratio > 1 ? ' · OVER' : ''}</span>}
                  </div>
                  <div className="dash-gauge-track">
                    <span className="dash-gauge-fill" style={{ width: `${Math.min(ratio, 1) * 100}%` }} />
                  </div>
                  <div className="dash-gauge-meta">
                    <span>{tok(r.w.tokens)} tok · {usdc(winCost(r.w))} · {r.w.msgs} msgs</span>
                    {freeIn != null && r.w.tokens > 0 && (
                      <span title="when the oldest counted usage ages out of the window">oldest clears in {fmtDur(freeIn)}</span>
                    )}
                  </div>
                  <label className="dash-cap-in">
                    cap
                    <input
                      type="number"
                      min="0"
                      step="1"
                      inputMode="decimal"
                      value={r.cap ? +(r.cap / 1e6).toFixed(1) : ''}
                      placeholder="set"
                      onChange={(e) => {
                        const v = parseFloat(e.target.value);
                        onCap(r.k, Number.isFinite(v) && v > 0 ? Math.round(v * 1e6) : 0);
                      }}
                    />
                    M&nbsp;tok
                  </label>
                </div>
              );
            })}
          </div>
        </>
      )}

      <div className="dash-hourly">
        <div className="dash-hourly-head">Last 24 hours · tokens / hour</div>
        <div className="dash-hourbars">
          {win.perHour.map((b) => (
            <div key={b.hourStart} className="dash-hourbar" title={`${new Date(b.hourStart).getHours()}:00 — ${tok(b.tokens)} tok · ${b.msgs} msgs`}>
              <span style={{ height: `${(b.tokens / hourMax) * 100}%` }} />
            </div>
          ))}
        </div>
        <div className="dash-houraxis">
          {win.perHour.map((b, i) => (i % 6 === 0 ? <span key={b.hourStart}>{new Date(b.hourStart).getHours()}:00</span> : null))}
        </div>
      </div>
    </div>
  );
}

type Row = SessionUsage & { cost: number; cachep: number };
type SortKey = keyof Row;

const COLS: { k: SortKey; t: string; left?: boolean }[] = [
  { k: 'label', t: 'Session', left: true },
  { k: 'day', t: 'Day' },
  { k: 'msgs', t: 'Msgs' },
  { k: 'dur', t: 'Min' },
  { k: 'input', t: 'Input' },
  { k: 'output', t: 'Output' },
  { k: 'cw', t: 'Cache wr' },
  { k: 'cr', t: 'Cache rd' },
  { k: 'total', t: 'Tokens' },
  { k: 'cost', t: 'Est cost' },
  { k: 'cachep', t: 'Cache%' },
];
const PAGE = 8;

export function Dashboard({ project }: { project: Project }): JSX.Element {
  const [rep, setRep] = useState<UsageReport | null>(null);
  const [win, setWin] = useState<UsageWindows | null>(null);
  const [loading, setLoading] = useState(true);
  const [err, setErr] = useState<string | null>(null);
  const [page, setPage] = useState(0);
  const [sortKey, setSortKey] = useState<SortKey>('total');
  const [sortDir, setSortDir] = useState<1 | -1>(-1);
  const [caps, setCaps] = useState<Caps>(() => {
    try {
      return JSON.parse(localStorage.getItem('narukami.usageCaps') || '{}') as Caps;
    } catch {
      return {};
    }
  });
  const onCap = useCallback((k: keyof Caps, tokens: number) => {
    setCaps((prev) => {
      const next = { ...prev, [k]: tokens };
      try {
        localStorage.setItem('narukami.usageCaps', JSON.stringify(next));
      } catch {
        /* private mode — gauge just won't persist */
      }
      return next;
    });
  }, []);

  const load = useCallback(async () => {
    setLoading(true);
    setErr(null);
    try {
      // Windows are account-wide and independent — don't let their failure sink
      // the per-project report.
      const [report, windows] = await Promise.all([
        api.getTelemetry(project.id),
        api.getUsageWindows().catch(() => null),
      ]);
      setRep(report);
      setWin(windows);
    } catch (e) {
      setErr((e as Error).message);
    } finally {
      setLoading(false);
    }
  }, [project.id]);

  useEffect(() => {
    setPage(0);
    void load();
  }, [load]);

  const derived = useMemo(() => {
    if (!rep) return null;
    const t = rep.totals;
    const tokBy: Record<string, number> = { cr: t.cacheRead, output: t.output, cw: t.cacheCreate, input: t.input };
    const costBy: Record<string, number> = {};
    let totalCost = 0;
    for (const k of Object.keys(tokBy)) {
      costBy[k] = tokBy[k] * PRICE[k as keyof typeof PRICE];
      totalCost += costBy[k];
    }
    const rows: Row[] = rep.sessions.map((s) => ({
      ...s,
      cost: s.input * PRICE.input + s.output * PRICE.output + s.cw * PRICE.cw + s.cr * PRICE.cr,
      cachep: s.total ? s.cr / s.total : 0,
    }));
    return {
      tokBy,
      costBy,
      totalCost,
      rows,
      cacheRatio: t.total ? t.cacheRead / t.total : 0,
      blended: t.total ? (totalCost / t.total) * 1e6 : 0,
      maxTot: Math.max(1, ...rows.map((r) => r.total)),
    };
  }, [rep]);

  if (loading) return <div className="dash"><div className="muted dash-empty">Loading telemetry…</div></div>;
  if (err) {
    return (
      <div className="dash">
        <div className="banner banner-error" onClick={() => setErr(null)}>{err}</div>
        <button className="btn" onClick={() => void load()}>Retry</button>
      </div>
    );
  }
  if (!rep || !derived) return <div className="dash" />;

  if (!rep.found || rep.sessionsActive === 0) {
    return (
      <div className="dash">
        <div className="dash-head">
          <div>
            <h2>Dashboard</h2>
            <div className="muted">{project.name} · token usage</div>
          </div>
          <button className="btn dash-refresh" onClick={() => void load()} title="Re-read Claude Code logs">↻ Refresh</button>
        </div>
        {win && <UsageLimits win={win} caps={caps} onCap={onCap} />}
        <div className="muted dash-empty">
          {rep.found
            ? 'No recorded token usage for this project yet.'
            : 'No Claude Code sessions found for this project yet.'}
          <br />
          Open a <b>Claude</b> tab and run something — this project's detail shows up here.
          <div className="dash-logdir">looked in <code>{rep.logDir}</code></div>
        </div>
      </div>
    );
  }

  const { tokBy, costBy, totalCost, rows, cacheRatio, blended, maxTot } = derived;
  const t = rep.totals;

  // ---- KPI tiles ----
  const kpis = [
    { lead: true, label: 'Total tokens', val: tok(t.total), note: `${nf.format(t.total)} across all buckets` },
    { lead: true, label: 'Estimated spend', val: usd(totalCost), note: `≈ ${usd(blended)} / 1M tokens (blended)` },
    { label: 'Sessions', val: String(rep.sessionsActive), sub: `/ ${rep.sessionsTotal}`, note: `${rep.byDay.length} active days` },
    { label: 'Assistant msgs', val: nf.format(rep.counts.assistantMsgs), note: `${nf.format(rep.counts.userMsgs)} user turns` },
    { label: 'Tool calls', val: nf.format(rep.counts.toolResults), note: rep.model.replace('claude-', '') },
    { label: 'Cache-read ratio', pill: pctS(cacheRatio), note: 'served from cache' },
  ];

  // ---- cost donut geometry ----
  const R = 68, C = 2 * Math.PI * R, GAP = 3;
  let off = 0;
  const donutSegs = ['cr', 'output', 'cw', 'input'].map((k) => {
    const frac = totalCost ? costBy[k] / totalCost : 0;
    const len = Math.max(frac * C - GAP, 0.5);
    const seg = { k, len, dash: `${len} ${C - len}`, offset: -off };
    off += frac * C;
    return seg;
  });
  const bucketCss = (k: string): string => `var(${BUCKETS.find((b) => b.key === k)!.cssVar})`;

  // ---- daily chart geometry (fixed viewBox, scales to width) ----
  const VW = 820, VH = 240, padT = 24, padB = 34, plotH = VH - padT - padB;
  const dayMax = Math.max(1, ...rep.byDay.map((d) => d.total));
  const step = VW / Math.max(1, rep.byDay.length);
  const bw = Math.min(64, step * 0.56);
  const stack: ['cacheRead' | 'cacheCreate' | 'output' | 'input', string][] = [
    ['cacheRead', '--purple'],
    ['cacheCreate', '--yellow'],
    ['output', '--accent'],
    ['input', '--green'],
  ];

  // ---- table ----
  const sorted = [...rows].sort((a, b) => {
    const x = a[sortKey], y = b[sortKey];
    if (typeof x === 'string' && typeof y === 'string') return sortDir * x.localeCompare(y);
    return sortDir * ((x as number) - (y as number));
  });
  const pageCount = Math.max(1, Math.ceil(sorted.length / PAGE));
  const p = Math.min(page, pageCount - 1);
  const view = sorted.slice(p * PAGE, p * PAGE + PAGE);
  const sortOn = (k: SortKey): void => {
    if (k === sortKey) setSortDir((d) => (d === 1 ? -1 : 1));
    else {
      setSortKey(k);
      setSortDir(k === 'label' || k === 'day' ? 1 : -1);
    }
    setPage(0);
  };

  return (
    <div className="dash">
      <div className="dash-head">
        <div>
          <h2>Dashboard</h2>
          <div className="muted">
            {project.name} · {rep.model} · {rep.rangeFirst} → {rep.rangeLast} · billed at Opus 4.8 rates
          </div>
        </div>
        <button className="btn dash-refresh" onClick={() => void load()} title="Re-read Claude Code logs">↻ Refresh</button>
      </div>

      {win && <UsageLimits win={win} caps={caps} onCap={onCap} />}

      {/* KPI row */}
      <div className="dash-kpis">
        {kpis.map((k) => (
          <div key={k.label} className={`dash-kpi${k.lead ? ' lead' : ''}`}>
            <div className="dash-eyebrow">{k.label}</div>
            <div className="dash-kpi-val">
              {k.pill ? (
                <span className="dash-pill"><span className="dash-dot" />{k.pill}</span>
              ) : (
                <>{k.val}{k.sub ? <small> {k.sub}</small> : null}</>
              )}
            </div>
            <div className="dash-note">{k.note}</div>
          </div>
        ))}
      </div>

      <div className="dash-grid2">
        {/* token composition */}
        <div className="dash-panel">
          <h3>Where the tokens go</h3>
          <p className="dash-cap">
            <b>{pctS(cacheRatio)}</b> of tokens are cache reads — heavy prompt reuse. The rest is where most spend lives.
          </p>
          <div className="dash-compbar">
            {BUCKETS.map((b) => {
              const share = t.total ? tokBy[b.key] / t.total : 0;
              return <div key={b.key} className="dash-seg" style={{ flex: Math.max(share, 0.0008), background: `var(${b.cssVar})` }} title={`${b.name}: ${nf.format(tokBy[b.key])} (${pctS(share)})`} />;
            })}
          </div>
          <div className="dash-legend">
            {BUCKETS.map((b) => {
              const share = t.total ? tokBy[b.key] / t.total : 0;
              return (
                <div key={b.key} className="dash-lrow">
                  <span className="dash-sw" style={{ background: `var(${b.cssVar})` }} />
                  <span className="dash-nm"><b>{b.name}</b> · {b.note}</span>
                  <span className="dash-tk">{nf.format(tokBy[b.key])}</span>
                  <span className="dash-pc">{(share * 100).toFixed(share < 0.01 ? 2 : 1)}%</span>
                </div>
              );
            })}
          </div>
        </div>

        {/* cost donut */}
        <div className="dash-panel">
          <h3>Where the money goes</h3>
          <p className="dash-cap">
            Cache reads are cheapest per token yet still the largest bill. <b>Output</b> is {pctS(t.total ? t.output / t.total : 0)} of tokens but <b>{pctS(totalCost ? costBy.output / totalCost : 0)}</b> of cost.
          </p>
          <div className="dash-donutwrap">
            <svg className="dash-donut" viewBox="0 0 200 200" role="img" aria-label="Cost by token bucket">
              {donutSegs.map((s) => (
                <circle key={s.k} r={R} cx="100" cy="100" fill="none" stroke={bucketCss(s.k)} strokeWidth="26"
                  strokeDasharray={s.dash} strokeDashoffset={s.offset} transform="rotate(-90 100 100)">
                  <title>{`${BUCKETS.find((b) => b.key === s.k)!.name}: ${usdc(costBy[s.k])} (${pctS(totalCost ? costBy[s.k] / totalCost : 0)})`}</title>
                </circle>
              ))}
              <text x="100" y="99" textAnchor="middle" className="dash-donut-v">{usd(totalCost).replace('.00', '')}</text>
              <text x="100" y="114" textAnchor="middle" className="dash-donut-l">EST. TOTAL</text>
            </svg>
            <div className="dash-legend">
              {['cr', 'output', 'cw', 'input'].map((k) => (
                <div key={k} className="dash-lrow">
                  <span className="dash-sw" style={{ background: bucketCss(k) }} />
                  <span className="dash-nm"><b>{BUCKETS.find((b) => b.key === k)!.name}</b></span>
                  <span className="dash-tk">{usdc(costBy[k])}</span>
                  <span className="dash-pc">{((totalCost ? costBy[k] / totalCost : 0) * 100).toFixed(1)}%</span>
                </div>
              ))}
            </div>
          </div>
        </div>
      </div>

      {/* daily activity */}
      <div className="dash-panel">
        <h3>Daily activity <span className="dash-eyebrow dash-inline">{rep.byDay.length} active days</span></h3>
        <p className="dash-cap">Total tokens per day (all buckets, stacked).</p>
        <svg className="dash-daychart" viewBox={`0 0 ${VW} ${VH}`} role="img" aria-label="Tokens per day">
          {[0, 1, 2, 3].map((i) => {
            const y = padT + plotH - (plotH * i) / 3;
            return <line key={i} className="dash-gridline" x1="0" y1={y} x2={VW} y2={y} />;
          })}
          {rep.byDay.map((d, i) => {
            const cx = step * i + step / 2;
            const x = cx - bw / 2;
            let yTop = padT + plotH;
            const rects = stack.map(([key, css]) => {
              const h = (d[key] / dayMax) * plotH;
              if (h <= 0) return null;
              const hh = Math.max(h - 2, 0.5);
              const rect = <rect key={key} className="dash-bar" x={x} y={yTop - hh} width={bw} height={hh} rx="2" fill={`var(${css})`} />;
              yTop -= h;
              return rect;
            });
            const topY = padT + plotH - (d.total / dayMax) * plotH;
            return (
              <g key={d.day}>
                <title>{`${d.day} — ${tok(d.total)} tokens · ${d.msgs} msgs`}</title>
                {rects}
                <text className="dash-dtot" x={cx} y={topY - 7} textAnchor="middle">{tok(d.total)}</text>
                <text className="dash-dlab" x={cx} y={VH - 14} textAnchor="middle">{d.day.slice(5)}</text>
              </g>
            );
          })}
        </svg>
      </div>

      {/* session table */}
      <div className="dash-panel">
        <h3>Session analysis <span className="dash-eyebrow dash-inline">{rows.length} sessions</span></h3>
        <div className="dash-tscroll">
          <table className="dash-table">
            <thead>
              <tr>
                {COLS.map((c) => (
                  <th key={c.k} onClick={() => sortOn(c.k)} tabIndex={0}
                    onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); sortOn(c.k); } }}
                    style={{ textAlign: c.left ? 'left' : 'right' }}>
                    {c.t}{c.k === sortKey ? <span className="dash-ar">{sortDir < 0 ? '▼' : '▲'}</span> : null}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {view.map((r) => (
                <tr key={r.id}>
                  <td className="dash-td-l"><span className="dash-sess">{r.label}</span><br /><span className="dash-sid">{r.id} · {r.msgs} msgs</span></td>
                  <td className="dash-num dash-daytag">{r.day.slice(5)}</td>
                  <td className="dash-num">{nf.format(r.msgs)}</td>
                  <td className="dash-num">{r.dur ? nf.format(r.dur) : '·'}</td>
                  <td className="dash-num">{tok(r.input)}</td>
                  <td className="dash-num">{tok(r.output)}</td>
                  <td className="dash-num">{tok(r.cw)}</td>
                  <td className="dash-num">{tok(r.cr)}</td>
                  <td className="dash-num">
                    <span className="dash-totcell">
                      <span className="dash-minibar"><span style={{ width: `${(r.total / maxTot) * 100}%` }} /></span>
                      {tok(r.total)}
                    </span>
                  </td>
                  <td className="dash-num">{usdc(r.cost)}</td>
                  <td className="dash-num dash-cachetag">{(r.cachep * 100).toFixed(1)}%</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        <div className="dash-pager">
          <span className="dash-pinfo">
            Showing <b>{sorted.length ? p * PAGE + 1 : 0}–{Math.min(sorted.length, (p + 1) * PAGE)}</b> of {sorted.length} · page {p + 1}/{pageCount}
          </span>
          <button type="button" disabled={p === 0} onClick={() => setPage(p - 1)}>‹ Prev</button>
          <button type="button" disabled={p >= pageCount - 1} onClick={() => setPage(p + 1)}>Next ›</button>
        </div>
      </div>

      <div className="dash-foot">
        Parsed from {rep.sessionsTotal} Claude Code session transcript{rep.sessionsTotal === 1 ? '' : 's'} in <code>{rep.logDir}</code>. Cost is an estimate from token counts at Opus 4.8 rates, not a billing statement.
      </div>
    </div>
  );
}
