import type { ArgusHealth, ArgusHeartbeat, ArgusModeIntegrity } from '../../../types';
import { godName } from '../lib';
import { Ic } from '../../icons';

interface Props {
  health: ArgusHealth | null;
  modes: ArgusModeIntegrity[];
  heartbeats: ArgusHeartbeat[];
}

/** P2 — drift / integrity / plumbing. Alert tiles are normally silent (green). */
export function HealthPanel({ health, modes, heartbeats }: Props) {
  const drift = health?.drift === true;
  const notOk = health?.ok === false;
  const issues = health?.issues ?? [];
  const badModes = modes.filter((m) => m.ok === false || m.gateValid === false);

  return (
    <section className="argus-panel">
      <div className="argus-panel-head">
        <h3>Layer Health</h3>
        <span className="argus-panel-sub">
          {health?.armed ? 'armed' : 'dormant'}
        </span>
      </div>

      <div className="argus-health-row">
        <div className="argus-kv">
          <span className="argus-k">requested</span>
          <span className="argus-v argus-mono">{health?.requested || '—'}</span>
        </div>
        <div className="argus-kv">
          <span className="argus-k">effective</span>
          <span className="argus-v argus-mono">
            {health?.effective || '—'}
            {godName(health?.effective) && <span className="argus-god"> · {godName(health?.effective)}</span>}
          </span>
        </div>
      </div>

      {/* Silent-until-fault alert tiles. */}
      <div className="argus-alerts">
        <div className={`argus-alert ${drift ? 'crit' : 'ok'}`}>
          <span className="argus-alert-label">drift</span>
          <span className="argus-alert-val">{drift ? 'LOST PATH' : 'aligned'}</span>
        </div>
        <div className={`argus-alert ${notOk ? 'crit' : 'ok'}`}>
          <span className="argus-alert-label">integrity</span>
          <span className="argus-alert-val">{notOk ? 'issues' : 'ok'}</span>
        </div>
        <div className={`argus-alert ${badModes.length ? 'warn' : 'ok'}`}>
          <span className="argus-alert-label">modes</span>
          <span className="argus-alert-val">
            {badModes.length ? `${badModes.length} bad` : `${modes.length} ok`}
          </span>
        </div>
      </div>

      {issues.length > 0 && (
        <ul className="argus-issues">
          {issues.map((i, idx) => (
            <li key={idx}>{i}</li>
          ))}
        </ul>
      )}

      {/* Per-mode integrity chips. */}
      <div className="argus-mode-grid">
        {modes.map((m) => (
          <span
            key={m.mode}
            className={`argus-mode-int ${m.ok === false || m.gateValid === false ? 'bad' : 'good'}`}
            title={`gate keys: ${m.gateKeys ?? 0}${(m.issues ?? []).length ? ` · ${(m.issues ?? []).join('; ')}` : ''}`}
          >
            {m.mode}
          </span>
        ))}
      </div>

      {/* Heartbeat trail. */}
      {heartbeats.length > 0 && (
        <div className="argus-heartbeats">
          {heartbeats.slice(-6).map((h, idx) => (
            <div key={idx} className="argus-hb" title={h.ts}>
              <span className={`argus-dot ${h.ok === false ? 'argus-dot-crit' : ''}`} />
              <span className="argus-mono argus-dim">{h.event}</span>
              <span className="argus-mono">{h.effective}</span>
              {h.sensing && <span className="argus-hb-auto"><Ic name="bolt" /></span>}
            </div>
          ))}
        </div>
      )}
    </section>
  );
}
