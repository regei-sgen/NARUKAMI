import type { GateStats } from '../../../types';
import { fmtNum } from '../lib';

interface Props {
  gate: GateStats | null;
  activity: Record<string, { allow: number; block: number }>;
}

/** P4 — proof-of-work gate: allow/block, block-rate, and the UNSETTLED (fail-open) alarm. */
export function GatePanel({ gate, activity }: Props) {
  if (!gate) {
    return (
      <section className="argus-panel">
        <div className="argus-panel-head">
          <h3>Proof-of-Work Gate</h3>
        </div>
        <div className="argus-empty">No gate telemetry.</div>
      </section>
    );
  }

  const blockPct = Math.round((gate.blockRate ?? 0) * 100);
  const unsettled = gate.unsettled ?? 0;
  const settled = gate.settled ?? 0;
  const unsettledPct = settled + unsettled > 0 ? Math.round((unsettled / (settled + unsettled)) * 100) : 0;

  // Per-mode allow/block, sorted by volume; skip zero-activity modes.
  const rows = Object.entries(activity)
    .filter(([, v]) => v.allow + v.block > 0)
    .sort((a, b) => b[1].allow + b[1].block - (a[1].allow + a[1].block))
    .slice(0, 8);
  const maxTotal = Math.max(1, ...rows.map(([, v]) => v.allow + v.block));

  return (
    <section className="argus-panel">
      <div className="argus-panel-head">
        <h3>Proof-of-Work Gate</h3>
        <span className="argus-panel-sub">block rate {blockPct}%</span>
      </div>

      <div className="argus-stat-row">
        <div className="argus-stat">
          <span className="argus-stat-n s-ok">{fmtNum(gate.allow)}</span>
          <span className="argus-stat-l">allow</span>
        </div>
        <div className="argus-stat">
          <span className="argus-stat-n s-block">{fmtNum(gate.block)}</span>
          <span className="argus-stat-l">block</span>
        </div>
        <div className={`argus-stat ${unsettled > 0 ? 'argus-stat-alarm' : ''}`}>
          <span className={`argus-stat-n ${unsettled > 0 ? 's-crit' : ''}`}>{fmtNum(unsettled)}</span>
          <span className="argus-stat-l">unsettled {unsettledPct > 0 ? `(${unsettledPct}%)` : ''}</span>
        </div>
      </div>

      {unsettled > 0 && (
        <div className="argus-note-warn">
          {unsettledPct}% of gate reads ended UNSETTLED — those turns were under-enforced (fail-open).
        </div>
      )}

      <div className="argus-bars">
        {rows.map(([mode, v]) => {
          const total = v.allow + v.block;
          return (
            <div key={mode} className="argus-bar-row">
              <span className="argus-bar-label argus-mono">{mode}</span>
              <div className="argus-bar" style={{ width: `${(total / maxTotal) * 100}%` }}>
                <span className="argus-bar-allow" style={{ flex: v.allow }} />
                <span className="argus-bar-block" style={{ flex: v.block }} />
              </div>
              <span className="argus-bar-n argus-mono argus-dim">
                {v.allow}/{v.block}
              </span>
            </div>
          );
        })}
      </div>
    </section>
  );
}
