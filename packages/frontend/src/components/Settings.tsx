import { useCallback, useEffect, useState, type ReactNode } from 'react';
import { api } from '../api';
import type { AboutInfo, AiSettings, AppPrefs } from '../types';
import { Ic } from './icons';

/**
 * Settings — NARUKAMI's configuration surface.
 *
 * Device-scoped prefs (theme, dock layout) are lifted from App so the live app
 * reflects a change instantly; the server-side ones (AI provider, notification
 * prefs, release output folder) are owned here and persisted through the API.
 *
 * The AI provider is the headline: the DEFAULT is 'claude-code' — NARUKAMI
 * injects nothing and every Claude session authenticates with the CLI's own
 * signed-in login, exactly as it always has. Adding an API key is opt-in.
 */

export interface ThemeOption {
  value: string;
  label: string;
  accent: string;
}

export interface SettingsProps {
  themes: ReadonlyArray<ThemeOption>;
  theme: string;
  onThemeChange: (value: string) => void;
  dockPosition: 'bottom' | 'right';
  onDockPositionChange: (value: 'bottom' | 'right') => void;
  dockHeight: number;
  dockWidth: number;
  onDockSizeReset: () => void;
  sidebarCollapsed: boolean;
  onSidebarCollapsedChange: (value: boolean) => void;
  prefs: AppPrefs;
  onPrefsChange: (patch: AppPrefs) => void;
}

/** Effort levels NARUKAMI can inject into a fresh Claude tab (`/effort <x>`). */
const EFFORT_LEVELS: ReadonlyArray<{ value: string; hint: string }> = [
  { value: 'low', hint: 'fastest, cheapest' },
  { value: 'medium', hint: 'balanced' },
  { value: 'high', hint: 'thorough' },
  { value: 'xhigh', hint: 'very thorough' },
  { value: 'ultracode', hint: 'xhigh + workflow fan-out (default)' },
];

function Row({ label, hint, children }: { label: string; hint?: string; children: ReactNode }) {
  return (
    <div className="set-row">
      <div className="set-row-label">
        <span className="set-label">{label}</span>
        {hint && <span className="set-hint">{hint}</span>}
      </div>
      <div className="set-row-control">{children}</div>
    </div>
  );
}

function Toggle({
  checked,
  onChange,
  label,
}: {
  checked: boolean;
  onChange: (v: boolean) => void;
  label: string;
}) {
  return (
    <label className="set-check">
      <input
        type="checkbox"
        checked={checked}
        aria-label={label}
        onChange={(e) => onChange(e.target.checked)}
      />
      <span>{label}</span>
    </label>
  );
}

/** Plain-language statement of which credential a Claude launch will actually use. */
function EffectiveNote({ ai }: { ai: AiSettings }) {
  if (ai.effective === 'api-key') {
    return (
      <div className="set-note set-note-ok">
        Claude sessions authenticate with your saved API key
        {ai.baseUrl ? (
          <>
            {' '}
            via <code>{ai.baseUrl}</code>
          </>
        ) : null}
        . Usage bills to that Console account at pay-as-you-go rates, not to your subscription.
      </div>
    );
  }
  if (ai.effective === 'inherited-env') {
    return (
      <div className="set-note set-note-warn">
        NARUKAMI injects nothing — but{' '}
        {ai.inheritedAuthVars.map((v) => (
          <code key={v}>{v}</code>
        ))}{' '}
        {ai.inheritedAuthVars.length > 1 ? 'are' : 'is'} already set in the environment NARUKAMI was
        launched from, and Claude Code uses that ahead of your login. Unset it and restart NARUKAMI
        to fall back to the signed-in CLI.
      </div>
    );
  }
  return (
    <div className="set-note">
      Claude sessions use the Claude Code CLI's own signed-in login (<code>claude /login</code>) —
      your Pro / Max / Team subscription or Console account. Nothing extra is injected.
    </div>
  );
}

export function Settings(props: SettingsProps) {
  const {
    themes,
    theme,
    onThemeChange,
    dockPosition,
    onDockPositionChange,
    dockHeight,
    dockWidth,
    onDockSizeReset,
    sidebarCollapsed,
    onSidebarCollapsedChange,
    prefs,
    onPrefsChange,
  } = props;

  const [ai, setAi] = useState<AiSettings | null>(null);
  const [about, setAbout] = useState<AboutInfo | null>(null);
  const [keyDraft, setKeyDraft] = useState('');
  const [urlDraft, setUrlDraft] = useState('');
  const [showKey, setShowKey] = useState(false);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [saved, setSaved] = useState<string | null>(null);

  // Release zip output folder — an existing backend setting whose only control
  // used to live inside the Release view.
  const [zipDir, setZipDir] = useState<string | null>(null);
  const [zipDraft, setZipDraft] = useState('');

  const load = useCallback(async () => {
    setErr(null);
    try {
      const [aiCfg, aboutInfo] = await Promise.all([api.getAiSettings(), api.getAbout()]);
      setAi(aiCfg);
      setUrlDraft(aiCfg.baseUrl);
      setAbout(aboutInfo);
    } catch (e) {
      setErr((e as Error).message);
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  const flash = (message: string) => {
    setSaved(message);
    setTimeout(() => setSaved((cur) => (cur === message ? null : cur)), 2500);
  };

  // One writer for every AI-config change, so a rejected write can never leave
  // the controls showing a state the backend refused.
  const patchAi = async (
    patch: Parameters<typeof api.saveAiSettings>[0],
    message: string,
  ): Promise<boolean> => {
    setBusy(true);
    setErr(null);
    try {
      const next = await api.saveAiSettings(patch);
      setAi(next);
      setUrlDraft(next.baseUrl);
      flash(message);
      return true;
    } catch (e) {
      setErr((e as Error).message);
      return false;
    } finally {
      setBusy(false);
    }
  };

  const saveKey = async () => {
    const key = keyDraft.trim();
    if (!key) {
      setErr('Paste an API key first.');
      return;
    }
    const ok = await patchAi(
      { provider: 'api-key', apiKey: key, baseUrl: urlDraft.trim() },
      'API key saved',
    );
    if (ok) {
      setKeyDraft('');
      setShowKey(false);
    }
  };

  const removeKey = async () => {
    setBusy(true);
    setErr(null);
    try {
      const next = await api.clearAiKey();
      setAi(next);
      setUrlDraft(next.baseUrl);
      setKeyDraft('');
      flash('API key removed');
    } catch (e) {
      setErr((e as Error).message);
    } finally {
      setBusy(false);
    }
  };

  const saveZipDir = async () => {
    setBusy(true);
    setErr(null);
    try {
      const res = await api.setReleaseZipDir(zipDraft.trim());
      setZipDir(res.zipDir);
      flash(res.isDefault ? 'Reset to the default folder' : 'Release folder saved');
    } catch (e) {
      setErr((e as Error).message);
    } finally {
      setBusy(false);
    }
  };

  const usingKey = ai?.provider === 'api-key';

  return (
    <div className="settings">
      <header className="settings-head">
        <p className="settings-sub">
          How NARUKAMI runs — the AI credential behind every Claude session, appearance, the
          terminal dock, notifications, and release output.
        </p>
        <button className="btn" onClick={() => void load()} disabled={busy}>
          <Ic name="refresh" /> Reload
        </button>
      </header>

      {err && (
        <div className="banner banner-error" onClick={() => setErr(null)}>
          {err}
        </div>
      )}
      {saved && <div className="set-saved">{saved}</div>}

      {/* ── AI provider ─────────────────────────────────────────────────── */}
      <section className="settings-section">
        <h3>AI provider</h3>

        {!ai ? (
          <div className="set-empty">Loading…</div>
        ) : (
          <>
            <div className="set-providers">
              <button
                className={`set-provider ${!usingKey ? 'active' : ''}`}
                disabled={busy}
                onClick={() => void patchAi({ provider: 'claude-code' }, 'Using Claude Code login')}
              >
                <span className="set-provider-name">Claude Code</span>
                <span className="set-provider-tag">default</span>
                <span className="set-provider-desc">
                  Use the CLI you're already signed in to. No key stored, nothing injected.
                </span>
              </button>
              <button
                className={`set-provider ${usingKey ? 'active' : ''}`}
                disabled={busy || !ai.hasKey}
                title={ai.hasKey ? undefined : 'Add an API key below first'}
                onClick={() => void patchAi({ provider: 'api-key' }, 'Using your API key')}
              >
                <span className="set-provider-name">Anthropic API key</span>
                <span className="set-provider-tag">{ai.hasKey ? 'ready' : 'no key yet'}</span>
                <span className="set-provider-desc">
                  Bill Claude sessions to a Console API key instead of your subscription.
                </span>
              </button>
            </div>

            <EffectiveNote ai={ai} />

            <Row
              label="API key"
              hint={
                ai.hasKey
                  ? 'Stored on this machine only — shown masked, never sent back to the UI.'
                  : 'Optional. Create one at platform.claude.com → API keys.'
              }
            >
              <div className="set-key">
                {ai.hasKey && !keyDraft && <code className="set-key-preview">{ai.keyPreview}</code>}
                <input
                  type={showKey ? 'text' : 'password'}
                  className="set-input set-input-mono"
                  placeholder={ai.hasKey ? 'Paste a new key to replace it…' : 'sk-ant-…'}
                  value={keyDraft}
                  spellCheck={false}
                  autoComplete="off"
                  aria-label="Anthropic API key"
                  onChange={(e) => setKeyDraft(e.target.value)}
                  onKeyDown={(e) => e.key === 'Enter' && void saveKey()}
                />
                <button
                  className="btn"
                  onClick={() => setShowKey((s) => !s)}
                  disabled={!keyDraft}
                  title={showKey ? 'Hide the key' : 'Show the key'}
                >
                  {showKey ? 'Hide' : 'Show'}
                </button>
                <button
                  className="btn btn-primary"
                  onClick={() => void saveKey()}
                  disabled={busy || !keyDraft.trim()}
                >
                  Save key
                </button>
                {ai.hasKey && (
                  <button className="btn btn-danger" onClick={() => void removeKey()} disabled={busy}>
                    Remove
                  </button>
                )}
              </div>
            </Row>

            <Row
              label="Custom endpoint"
              hint="Optional — route requests through an LLM gateway or proxy (ANTHROPIC_BASE_URL)."
            >
              <div className="set-key">
                <input
                  type="text"
                  className="set-input set-input-mono"
                  placeholder="https://gateway.example.com"
                  value={urlDraft}
                  spellCheck={false}
                  aria-label="Custom API base URL"
                  onChange={(e) => setUrlDraft(e.target.value)}
                />
                <button
                  className="btn"
                  disabled={busy || urlDraft.trim() === ai.baseUrl}
                  onClick={() => void patchAi({ baseUrl: urlDraft.trim() }, 'Endpoint saved')}
                >
                  Save
                </button>
              </div>
            </Row>

            <Row
              label="Default effort"
              hint="Typed into every new Claude tab as /effort <level>. Higher levels spawn more subagents — the main driver of CPU use."
            >
              <select
                className="set-select"
                value={ai.defaultEffort}
                aria-label="Default effort"
                disabled={busy}
                onChange={(e) =>
                  void patchAi({ defaultEffort: e.target.value }, 'Default effort saved')
                }
              >
                {EFFORT_LEVELS.map((l) => (
                  <option key={l.value} value={l.value}>
                    {l.value} — {l.hint}
                  </option>
                ))}
              </select>
            </Row>

            {usingKey && (
              <div className="set-note set-note-warn">
                An interactive Claude tab asks you once to approve a detected API key; headless work
                (project analysis, EOD summaries, release notes) uses it with no prompt.
              </div>
            )}
          </>
        )}
      </section>

      {/* ── Appearance ──────────────────────────────────────────────────── */}
      <section className="settings-section">
        <h3>Appearance</h3>
        <Row label="Theme" hint="Accent + surface palette. Saved per device.">
          <div className="set-themes">
            {themes.map((t) => (
              <button
                key={t.value || 'default'}
                className={`set-theme ${theme === t.value ? 'active' : ''}`}
                onClick={() => onThemeChange(t.value)}
                title={t.label}
              >
                <span className="set-theme-dot" style={{ background: t.accent }} />
                {t.label}
              </button>
            ))}
          </div>
        </Row>
      </section>

      {/* ── Terminals & layout ──────────────────────────────────────────── */}
      <section className="settings-section">
        <h3>Terminals &amp; layout</h3>
        <Row label="Dock position" hint="Where the terminal dock sits in the workspace.">
          <div className="set-seg">
            {(['bottom', 'right'] as const).map((p) => (
              <button
                key={p}
                className={`set-seg-btn ${dockPosition === p ? 'active' : ''}`}
                onClick={() => onDockPositionChange(p)}
              >
                {p}
              </button>
            ))}
          </div>
        </Row>
        <Row
          label="Dock size"
          hint={`Currently ${
            dockPosition === 'right' ? `${dockWidth}px wide` : `${dockHeight}px tall`
          } — drag its inner edge to resize.`}
        >
          <button className="btn" onClick={onDockSizeReset}>
            Reset to default
          </button>
        </Row>
        <Row label="Sidebar" hint="The project list on the left.">
          <Toggle
            checked={!sidebarCollapsed}
            onChange={(v) => onSidebarCollapsedChange(!v)}
            label="Show the project sidebar"
          />
        </Row>
      </section>

      {/* ── Notifications ───────────────────────────────────────────────── */}
      <section className="settings-section">
        <h3>Notifications</h3>
        <Row label="In-app toasts" hint="Cards in the corner when a run finishes.">
          <Toggle
            checked={prefs.inAppToasts !== false}
            onChange={(v) => onPrefsChange({ inAppToasts: v })}
            label="Show in-app toasts"
          />
        </Row>
        <Row
          label="Desktop notifications"
          hint="Native OS notification when NARUKAMI is in the background."
        >
          <Toggle
            checked={prefs.desktopNotifications !== false}
            onChange={(v) => onPrefsChange({ desktopNotifications: v })}
            label="Show desktop notifications"
          />
        </Row>
        <Row
          label="Claude task-done"
          hint="Notify when a Claude session goes idle after finishing a task."
        >
          <Toggle
            checked={prefs.taskDoneNotifications !== false}
            onChange={(v) => onPrefsChange({ taskDoneNotifications: v })}
            label="Notify when Claude finishes a task"
          />
        </Row>
      </section>

      {/* ── Release ─────────────────────────────────────────────────────── */}
      <section className="settings-section">
        <h3>Release output</h3>
        <Row
          label="Zip folder"
          hint={
            zipDir
              ? `Saved to ${zipDir}`
              : 'Where the Release view writes its build zips. Leave blank to reset to your home folder.'
          }
        >
          <div className="set-key">
            <input
              type="text"
              className="set-input set-input-mono"
              placeholder="An absolute folder path"
              value={zipDraft}
              spellCheck={false}
              aria-label="Release zip folder"
              onChange={(e) => setZipDraft(e.target.value)}
            />
            <button className="btn" onClick={() => void saveZipDir()} disabled={busy}>
              Save
            </button>
          </div>
        </Row>
      </section>

      {/* ── About ───────────────────────────────────────────────────────── */}
      <section className="settings-section">
        <h3>About</h3>
        {!about ? (
          <div className="set-empty">Loading…</div>
        ) : (
          <dl className="set-about">
            <dt>Version</dt>
            <dd>{about.version ?? 'unknown'}</dd>
            <dt>Platform</dt>
            <dd>
              {about.platform} · {about.arch} · Node {about.node}
            </dd>
            <dt>Backend</dt>
            <dd>{about.backendUrl ?? 'not bound'}</dd>
            <dt>GODCLAUDE home</dt>
            <dd>
              {about.godHome}{' '}
              <span className={about.godInstalled ? 'set-ok' : 'muted'}>
                ({about.godInstalled ? 'installed' : 'not installed'})
              </span>
            </dd>
            <dt>Database</dt>
            <dd>{about.database ?? 'unknown'}</dd>
          </dl>
        )}
      </section>
    </div>
  );
}
