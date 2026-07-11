import { useCallback, useEffect, useState } from 'react';
import { api } from '../api';
import type { Armory as ArmoryData, ArmoryDoc, ArmoryScope } from '../types';
import { Ic } from './icons';

/**
 * Armory — read-only inventory of the Claude Code arsenal: skills, hooks, memory
 * pins, agents and commands, scoped global + per project. Global (not filtered by
 * the selected project) — it shows it all. Polls once on open; manual refresh.
 */
function ScopeChip({ scope, project }: { scope: ArmoryScope; project?: string }) {
  return (
    <span className={`armory-scope armory-scope-${scope}`} title={scope === 'project' ? project : 'global (~/.claude)'}>
      {scope === 'project' ? project || 'project' : 'global'}
    </span>
  );
}

function DocGrid({ items, empty }: { items: ArmoryDoc[]; empty: string }) {
  if (items.length === 0) return <div className="armory-empty">{empty}</div>;
  return (
    <div className="armory-grid">
      {items.map((d, i) => (
        <div key={`${d.name}-${i}`} className="armory-card">
          <div className="armory-card-top">
            <span className="armory-name">{d.name}</span>
            <ScopeChip scope={d.scope} project={d.project} />
          </div>
          {d.description && <div className="armory-desc">{d.description}</div>}
        </div>
      ))}
    </div>
  );
}

export function Armory() {
  const [data, setData] = useState<ArmoryData | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);

  const load = useCallback(async () => {
    setLoading(true);
    setErr(null);
    try {
      setData(await api.getArmory());
    } catch (e) {
      setErr((e as Error).message);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  const summary: Array<[string, number]> = data
    ? [
        ['Skills', data.counts.skills],
        ['Hooks', data.counts.hooks],
        ['Memory', data.counts.memory],
        ['Agents', data.counts.agents],
        ['Commands', data.counts.commands],
      ]
    : [];

  return (
    <div className="armory">
      <header className="armory-head">
        {/* content-first (Tempered Glass v2): description leads, no wordmark title */}
        <p className="armory-sub">
          Your Claude Code arsenal — skills, hooks, memory pins, agents &amp; commands, global + per project.
        </p>
        <button className="btn" onClick={() => void load()} disabled={loading}>
          {loading ? 'Loading…' : <><Ic name="refresh" /> Refresh</>}
        </button>
      </header>

      {err && (
        <div className="banner banner-error" onClick={() => setErr(null)}>
          {err}
        </div>
      )}

      {data && (
        <>
          <div className="armory-counts">
            {summary.map(([k, v]) => (
              <div key={k} className="armory-count">
                <span className="armory-count-n">{v}</span>
                <span className="armory-count-k">{k}</span>
              </div>
            ))}
          </div>

          <section className="armory-section">
            <h3>
              Skills <span className="armory-n">{data.skills.length}</span>
            </h3>
            <DocGrid items={data.skills} empty="No skills found." />
          </section>

          <section className="armory-section">
            <h3>
              Hooks <span className="armory-n">{data.hooks.length}</span>
            </h3>
            {data.hooks.length === 0 ? (
              <div className="armory-empty">No hooks configured.</div>
            ) : (
              <div className="armory-list">
                {data.hooks.map((h, i) => (
                  <div key={i} className="armory-hook">
                    <span className="armory-hook-event">{h.event}</span>
                    <span className="armory-hook-matcher" title="matcher">
                      {h.matcher}
                    </span>
                    <span className="armory-hook-cmd argus-mono">{h.command}</span>
                    <ScopeChip scope={h.scope} project={h.project} />
                  </div>
                ))}
              </div>
            )}
          </section>

          <section className="armory-section">
            <h3>
              Memory pins <span className="armory-n">{data.memory.length}</span>
            </h3>
            {data.memory.length === 0 ? (
              <div className="armory-empty">No memory pins.</div>
            ) : (
              <div className="armory-grid">
                {data.memory.map((m, i) => (
                  <div key={`${m.name}-${i}`} className="armory-card">
                    <div className="armory-card-top">
                      <span className="armory-name">{m.name}</span>
                      <span className="armory-type">{m.type}</span>
                    </div>
                    {m.description && <div className="armory-desc">{m.description}</div>}
                    <div className="armory-proj" title="origin project">
                      {m.project}
                    </div>
                  </div>
                ))}
              </div>
            )}
          </section>

          <section className="armory-section">
            <h3>
              Agents <span className="armory-n">{data.agents.length}</span>
            </h3>
            <DocGrid items={data.agents} empty="No custom agents (built-in agents are always available)." />
          </section>

          <section className="armory-section">
            <h3>
              Commands <span className="armory-n">{data.commands.length}</span>
            </h3>
            <DocGrid items={data.commands} empty="No slash commands." />
          </section>
        </>
      )}
    </div>
  );
}
