import type { GodStats } from '../../../types';
import { fmtNum } from '../lib';

interface Props {
  stats: GodStats | null;
}

/** P5 — hook performance: p50/p95/max per hook + dispatch mix (error/spawn = red flags). */
export function LatencyPanel({ stats }: Props) {
  if (!stats) {
    return (
      <section className="argus-panel">
        <div className="argus-panel-head">
          <h3>Hook Performance</h3>
        </div>
        <div className="argus-empty">No perf telemetry.</div>
      </section>
    );
  }

  const dispatch = stats.dispatch ?? {};
  const errFlag = (dispatch.error ?? 0) > 0;
  const spawnFlag = (dispatch.spawn ?? 0) > 0;
  const hooks = [...(stats.hookStats ?? [])].sort((a, b) => b.p95 - a.p95).slice(0, 8);

  return (
    <section className="argus-panel">
      <div className="argus-panel-head">
        <h3>Hook Performance</h3>
        <span className="argus-panel-sub">
          {stats.perfSpan ? `since ${stats.perfSpan.from.slice(0, 10)}` : ''}
        </span>
      </div>

      <div className="argus-dispatch">
        <span className="argus-dispatch-item">in-process {fmtNum(dispatch['in-process'])}</span>
        <span className={`argus-dispatch-item ${spawnFlag ? 'crit' : 'dim'}`}>spawn {fmtNum(dispatch.spawn)}</span>
        <span className={`argus-dispatch-item ${errFlag ? 'crit' : 'dim'}`}>error {fmtNum(dispatch.error)}</span>
        <span className="argus-dispatch-item dim">legacy {fmtNum(dispatch.legacy)}</span>
      </div>
      {(errFlag || spawnFlag) && (
        <div className="argus-note-warn">
          {errFlag && 'dispatch=error means a hook threw and failed OPEN (not enforced). '}
          {spawnFlag && 'dispatch=spawn indicates a stale install (double node spawn).'}
        </div>
      )}

      <div className="argus-table-wrap">
        <table className="argus-table argus-table-compact">
          <thead>
            <tr>
              <th>Hook</th>
              <th>n</th>
              <th>p50</th>
              <th>p95</th>
              <th>max</th>
              <th>blk</th>
            </tr>
          </thead>
          <tbody>
            {hooks.map((h) => (
              <tr key={h.hook}>
                <td className="argus-mono">{h.hook}</td>
                <td className="argus-mono argus-dim">{fmtNum(h.count)}</td>
                <td className="argus-mono">{h.p50.toFixed(1)}</td>
                <td className={`argus-mono ${h.p95 > 1000 ? 's-warn' : ''}`}>{h.p95.toFixed(0)}</td>
                <td className="argus-mono argus-dim">{h.max.toFixed(0)}</td>
                <td className="argus-mono">{h.blocked > 0 ? <span className="s-block">{h.blocked}</span> : '—'}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </section>
  );
}
