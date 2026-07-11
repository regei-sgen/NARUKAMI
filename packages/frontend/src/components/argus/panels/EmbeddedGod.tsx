import { useCallback, useState } from 'react';
import { api } from '../../../api';
import { Ic } from '../../icons';
import type { EmbeddedGodStatus } from '../../../types';
import { godName } from '../lib';

/** Canonical mode ids the picker offers, in kami-roster order. `general` = base layer. */
const MODES = [
  'general',
  'developer',
  'researcher',
  'data-analyst',
  'qa',
  'reviewer',
  'planner',
  'ci-cd',
  'web-builder',
];

interface Props {
  status: EmbeddedGodStatus;
  /** Actions return a fresh status — pushed up so the whole tab re-renders at once. */
  onStatus: (s: EmbeddedGodStatus) => void;
}

/**
 * Control panel for NARUKAMI's OWN godclaude — the embedded instance under
 * ~/.narukami/godclaude that every NARUKAMI-spawned session runs against.
 * Writable by design (the embedded home belongs to NARUKAMI); the native
 * ~/.claude install is never touched. The surrounding tab (ArgusPanoptes)
 * owns the status polling; this panel only issues actions.
 */
export function EmbeddedGod({ status, onStatus }: Props) {
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  const act = useCallback(
    async (fn: () => Promise<EmbeddedGodStatus>) => {
      setBusy(true);
      setErr(null);
      try {
        onStatus(await fn());
      } catch (e) {
        setErr((e as Error).message);
      } finally {
        setBusy(false);
      }
    },
    [onStatus],
  );

  const activeMode = status.modes[0] ?? 'general';
  const wired = status.nativeWiring.settingsWired && status.nativeWiring.hooksPresent;
  const updatedAgo = status.ts ? Math.max(0, Math.round((Date.now() - Date.parse(status.ts)) / 1000)) : null;

  return (
    <section className="argus-panel argus-panel-wide argus-embed">
      <div className="argus-panel-head">
        <span className="argus-embed-title">
          <h3>
            <Ic name="bolt" /> NARUKAMI godclaude
          </h3>
          {status.installed && (
            <>
              <span className={`argus-badge ${status.armed ? 'argus-badge-live' : 'argus-badge-dim'}`}>
                {status.armed ? 'ARMED' : 'DORMANT'}
              </span>
              <span className="argus-badge argus-badge-mode">
                {activeMode}
                {godName(activeMode) && <span className="argus-god"> · {godName(activeMode)}</span>}
              </span>
              <span className="argus-embed-version argus-mono argus-dim">
                v{status.installedVersion}
                {status.vendoredVersion && status.vendoredVersion !== status.installedVersion
                  ? ` (v${status.vendoredVersion} available)`
                  : ''}
              </span>
            </>
          )}
        </span>
        <span className="argus-embed-head-actions">
          {status.installed && (
            <>
              <button
                className={`argus-embed-btn ${status.armed ? '' : 'argus-embed-btn-primary'}`}
                disabled={busy}
                onClick={() => void act(async () => (await api.godArm(!status.armed)).status)}
              >
                <Ic name={status.armed ? 'stop' : 'play'} /> {status.armed ? 'Disarm' : 'Arm'}
              </button>
              {/* one control = state + switch (dot glows gold while on), instead of a
                  state pill AND an "autopilot off" action button saying the same word */}
              <button
                className={`argus-embed-btn argus-auto-toggle ${status.autopilot ? 'on' : ''}`}
                disabled={busy}
                title={
                  status.autopilot
                    ? 'Autopilot is ON — GODCLAUDE senses each task and switches modes itself. Click to turn off.'
                    : 'Autopilot is OFF — the mode only changes when you pick one. Click to turn on.'
                }
                onClick={() => void act(async () => (await api.godAutopilot(!status.autopilot)).status)}
              >
                <span className="argus-auto-dot" aria-hidden="true" /> autopilot {status.autopilot ? 'on' : 'off'}
              </button>
            </>
          )}
          {updatedAgo != null && (
            <span className="argus-updated argus-mono">
              <span className="argus-dot argus-dot-live" /> {updatedAgo}s ago
            </span>
          )}
        </span>
      </div>
      <p className="argus-embed-sub">
        embedded instance — applies to sessions NARUKAMI spawns; the native ~/.claude layer is untouched
      </p>

      {err && <div className="argus-embed-err">{err}</div>}

      {!status.installed ? (
        <div className="argus-embed-install">
          <p className="argus-dim">
            Not installed yet. Installing provisions NARUKAMI's own GODCLAUDE home
            (<span className="argus-mono">{status.home}</span>) from the assets bundled with this build
            {status.vendoredVersion ? ` (v${status.vendoredVersion})` : ''} — its armed state, modes,
            contracts, and logs stay fully separate from your native terminal's godclaude.
          </p>
          <button className="argus-embed-btn argus-embed-btn-primary" disabled={busy} onClick={() => void act(() => api.godInstall())}>
            <Ic name="plus" /> {busy ? 'Installing…' : 'Install embedded godclaude'}
          </button>
        </div>
      ) : (
        <>
          <div className="argus-embed-modes">
            {MODES.map((m) => (
              <button
                key={m}
                className={`argus-embed-mode ${m === activeMode ? 'active' : ''}`}
                disabled={busy || m === activeMode}
                title={godName(m) ? `${m} · ${godName(m)}` : m}
                onClick={() => void act(async () => (await api.godMode(m)).status)}
              >
                {m}
              </button>
            ))}
          </div>

          {!wired && (
            <div className="argus-embed-warn">
              <Ic name="warn" /> Hook wiring not detected in the native ~/.claude — the embedded layer's
              contract/gate can't fire in spawned sessions until godclaude is installed natively
              (its settings.json wiring is what invokes the hooks; state still resolves here).
            </div>
          )}
        </>
      )}
    </section>
  );
}
