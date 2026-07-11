import type { ArgusSessions } from '../../../types';
import { fmtAge, godName } from '../lib';

interface Props {
  sessions: ArgusSessions;
}

/** P1 — live Claude session fleet: "what is every agent doing right now." */
export function SessionFleet({ sessions }: Props) {
  const items = sessions.items;
  return (
    <section className="argus-panel argus-panel-wide">
      <div className="argus-panel-head">
        <h3>Session Fleet</h3>
        <span className="argus-panel-sub">
          {sessions.count} session{sessions.count === 1 ? '' : 's'} · {sessions.live} live
        </span>
      </div>
      {items.length === 0 ? (
        <div className="argus-empty">No Claude sessions reporting.</div>
      ) : (
        <div className="argus-table-wrap">
          <table className="argus-table">
            <thead>
              <tr>
                <th>Session</th>
                <th>Mode</th>
                <th>State</th>
                <th>Busy</th>
                <th>Age</th>
                <th>cwd</th>
                <th>Ver</th>
              </tr>
            </thead>
            <tbody>
              {items.map((s) => (
                <tr key={s.sessionId}>
                  <td>
                    <span className="argus-mono">{s.name || s.sessionId.slice(0, 8)}</span>
                    {s.origin === 'narukami' ? (
                      <span className="argus-origin argus-origin-narukami" title={`NARUKAMI session ${s.sessionId}`}>
                        NARUKAMI
                      </span>
                    ) : s.origin === 'native' ? (
                      <span className="argus-origin argus-origin-native" title="Native claude CLI session">
                        native
                      </span>
                    ) : null}
                  </td>
                  <td>
                    {s.modes.length === 0 ? (
                      <span className="argus-dim">general</span>
                    ) : (
                      s.modes.map((m) => (
                        <span key={m} className="argus-mode-chip" title={godName(m) || undefined}>
                          {m}
                          {godName(m) && <span className="argus-god">· {godName(m)}</span>}
                        </span>
                      ))
                    )}
                  </td>
                  <td>
                    <span className={`argus-state argus-state-${s.state}`}>
                      <span className="argus-dot" /> {s.state}
                    </span>
                  </td>
                  <td>
                    <span className={s.status === 'busy' ? 'argus-busy' : 'argus-idle'}>{s.status}</span>
                  </td>
                  <td className="argus-mono">{fmtAge(s.ageMs)}</td>
                  <td className="argus-mono argus-cwd" title={s.cwd}>
                    {s.cwd.split(/[\\/]/).filter(Boolean).slice(-2).join('/')}
                  </td>
                  <td className="argus-mono argus-dim">{s.version}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </section>
  );
}
