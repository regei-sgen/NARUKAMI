import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { Project } from '../types';
import {
  DEVICE_PRESETS,
  DevicePreset,
  alignLoopbackHost,
  fitScale,
  isLoopbackUrl,
  normalizeUrl,
  toggleDevice,
} from '../lib/browserView';
import { desktop, PreviewLogEvent } from '../lib/desktop';
import { Ic } from './icons';

interface Props {
  project: Project;
  // Persisted last preview URL for this project (App owns the map; this
  // component is keyed by project id, so initial-value + local state is safe).
  initialUrl?: string;
  // Latest dev-server URL sniffed from this project's runs (ephemeral).
  detectedUrl?: string | null;
  // Enabled device-preset ids. App-owned (global setting) so it survives the
  // keyed remount on project switch.
  devices: string[];
  onUrlChange: (projectId: string, url: string) => void;
  onDevicesChange: (ids: string[]) => void;
}

// Vertical chrome around each iframe inside the strip: frame header + strip
// padding. Used to derive the height available for the scaled device box.
const FRAME_CHROME = 24 + 32;

// Ring-buffer cap for the logs panel.
const MAX_LOG_ROWS = 500;

// Sandbox applied to EXTERNAL (non-loopback) frames only. The desktop shell
// strips X-Frame-Options / CSP frame-ancestors so live sites render, but a site
// can still try to break out of the frame with JS (`if (top !== self) top.location = …`),
// which would navigate the whole NARUKAMI window away. Omitting
// `allow-top-navigation` (while keeping `…-by-user-activation` so real link
// clicks still work) neutralises that on-load framebusting; the rest of the
// grants let ordinary sites run normally. Loopback dev servers get no sandbox —
// their preview path is unchanged.
const EXTERNAL_SANDBOX =
  'allow-forms allow-modals allow-popups allow-popups-to-escape-sandbox ' +
  'allow-same-origin allow-scripts allow-downloads allow-top-navigation-by-user-activation';

// One rendered row in the logs panel. Console rows group consecutive
// duplicates (N preview frames emit N copies of every message) via `count`;
// network rows are updated in place when their response/failure arrives.
type LogRow =
  | { kind: 'console'; level: string; text: string; count: number }
  | { kind: 'net'; id: string; method: string; url: string; rtype: string; status?: number | 'fail'; detail?: string };

function pushLog(rows: LogRow[], evt: PreviewLogEvent): LogRow[] {
  if (evt.kind === 'console') {
    const last = rows[rows.length - 1];
    if (last && last.kind === 'console' && last.level === evt.level && last.text === evt.text) {
      return [...rows.slice(0, -1), { ...last, count: last.count + 1 }];
    }
    return [...rows.slice(-MAX_LOG_ROWS + 1), { kind: 'console', level: evt.level, text: evt.text, count: 1 }];
  }
  if (evt.kind === 'net') {
    return [
      ...rows.slice(-MAX_LOG_ROWS + 1),
      { kind: 'net', id: evt.id, method: evt.method, url: evt.url, rtype: evt.rtype },
    ];
  }
  // netdone / netfail: update the matching request row in place (search from
  // the end — the open request is almost always recent).
  for (let i = rows.length - 1; i >= 0; i--) {
    const r = rows[i];
    if (r.kind === 'net' && r.id === evt.id && r.status === undefined) {
      const next = [...rows];
      next[i] =
        evt.kind === 'netdone'
          ? { ...r, status: evt.status, detail: evt.mime }
          : { ...r, status: 'fail', detail: evt.error };
      return next;
    }
  }
  return rows;
}

/**
 * Browser view: renders the committed URL in every enabled device viewport
 * side by side. Each iframe is laid out at true device CSS pixels (so media
 * queries fire exactly as on-device) and scaled down to fit the pane height;
 * the row scrolls horizontally when frames overflow. In the desktop shell a
 * logs panel streams the preview's console + network activity (captured via
 * CDP in the main process — the renderer can't see into cross-origin frames).
 */
export function BrowserTab({ project, initialUrl, detectedUrl, devices, onUrlChange, onDevicesChange }: Props) {
  // Loopback hosts are aligned to the app's own host: `localhost` and
  // `127.0.0.1` are different SITES for SameSite cookies, so a mismatched
  // preview silently loses its session cookies (logins break).
  const align = useCallback((u: string) => alignLoopbackHost(u, window.location.hostname), []);
  const initial = initialUrl ?? detectedUrl ?? '';
  const [input, setInput] = useState(initial ? align(initial) : '');
  const [url, setUrl] = useState<string | null>(() => {
    const n = normalizeUrl(initial);
    return n ? align(n) : null;
  });
  // Bumping the nonce remounts every iframe — the only reliable cross-origin
  // reload (contentWindow.location.reload() throws cross-origin).
  const [nonce, setNonce] = useState(0);
  const stripRef = useRef<HTMLDivElement>(null);
  const [stripHeight, setStripHeight] = useState(0);

  // Preview logs (desktop shell only).
  const captureAvailable = !!desktop()?.onPreviewLog;
  const [logs, setLogs] = useState<LogRow[]>([]);
  const [logsOpen, setLogsOpen] = useState(false);
  const [logTab, setLogTab] = useState<'console' | 'network'>('console');
  const logScrollRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const el = stripRef.current;
    if (!el) return;
    const ro = new ResizeObserver(() => setStripHeight(el.clientHeight));
    ro.observe(el);
    setStripHeight(el.clientHeight);
    return () => ro.disconnect();
  }, []);

  // Start/stop CDP capture with the committed URL; reload (nonce) restarts it
  // so the panel reflects the fresh page load.
  useEffect(() => {
    const d = desktop();
    if (!d?.previewWatch || !d.onPreviewLog) return;
    setLogs([]);
    if (!url) {
      d.previewWatch(null);
      return;
    }
    d.previewWatch(url);
    const off = d.onPreviewLog((evt) => setLogs((rows) => pushLog(rows, evt)));
    return () => {
      off();
      d.previewWatch?.(null);
    };
  }, [url, nonce]);

  // Keep the panel pinned to the newest entry.
  useEffect(() => {
    const el = logScrollRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [logs, logTab, logsOpen]);

  const commit = (raw: string) => {
    const normalized = normalizeUrl(raw);
    if (!normalized) return;
    const aligned = align(normalized);
    // Pre-arm CDP capture BEFORE the state update mounts the iframes: the
    // watch effect runs post-commit (after navigation already started), and
    // the main process now keeps the CDP domains disabled while nothing is
    // watched — arming here ensures the new page's document request is
    // captured instead of racing the enable.
    desktop()?.previewWatch?.(aligned);
    setInput(aligned);
    setUrl(aligned);
    onUrlChange(project.id, aligned);
  };

  const enabledPresets = useMemo(
    () => DEVICE_PRESETS.filter((d) => devices.includes(d.id)),
    [devices],
  );
  const availHeight = stripHeight - FRAME_CHROME;
  const errorCount = useMemo(
    () =>
      logs.reduce(
        (n, r) =>
          n + (r.kind === 'console' && (r.level === 'error' || r.level === 'assert') ? r.count : 0),
        0,
      ),
    [logs],
  );
  const consoleRows = logs.filter((r) => r.kind === 'console');
  const netRows = logs.filter((r) => r.kind === 'net');

  return (
    <div className="browser-view">
      <div className="browser-toolbar">
        <button
          className="browser-btn"
          title="Reload all frames"
          disabled={!url}
          onClick={() => setNonce((n) => n + 1)}
        >
          <Ic name="refresh" />
        </button>
        <input
          className="browser-url"
          value={input}
          placeholder={detectedUrl ?? 'http://localhost:5173'}
          spellCheck={false}
          onChange={(e) => setInput(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter') commit(input);
          }}
        />
        <button className="browser-btn" disabled={!normalizeUrl(input)} onClick={() => commit(input)}>
          Go
        </button>
        {detectedUrl && align(detectedUrl) !== url && (
          <button
            className="browser-btn browser-detected"
            title="Use the dev-server URL detected from this project's terminal output"
            onClick={() => commit(detectedUrl)}
          >
            <Ic name="bolt" /> {detectedUrl}
          </button>
        )}
        <button
          className={`browser-btn ${logsOpen ? 'active' : ''}`}
          title={
            captureAvailable
              ? "Console + network logs from the preview frames"
              : 'Console/network capture needs the desktop app'
          }
          disabled={!url}
          onClick={() => setLogsOpen((v) => !v)}
        >
          Logs
          {errorCount > 0 && <span className="browser-log-badge">{errorCount}</span>}
        </button>
        <div className="browser-devices">
          {DEVICE_PRESETS.map((d) => (
            <button
              key={d.id}
              className={`browser-dev-btn ${devices.includes(d.id) ? 'active' : ''}`}
              title={`${d.width} × ${d.height}`}
              onClick={() => onDevicesChange(toggleDevice(devices, d.id))}
            >
              {d.label}
            </button>
          ))}
        </div>
      </div>
      {url && !isLoopbackUrl(url) && !desktop() && (
        <div className="browser-hint">
          Running in a browser tab: external sites that forbid embedding (X-Frame-Options / CSP
          frame-ancestors) render blank here. Open the NARUKAMI desktop app to preview live
          external sites.
        </div>
      )}
      <div className="browser-strip" ref={stripRef}>
        {url ? (
          enabledPresets.map((d) => (
            <DeviceFrame key={d.id} device={d} url={url} nonce={nonce} availHeight={availHeight} />
          ))
        ) : (
          <div className="browser-empty">
            Enter a URL above, or start a dev server in the Runner — its URL is picked up
            automatically.
          </div>
        )}
      </div>
      {logsOpen && (
        <div className="browser-logs">
          <div className="browser-logs-bar">
            <button
              className={`browser-log-tab ${logTab === 'console' ? 'active' : ''}`}
              onClick={() => setLogTab('console')}
            >
              Console ({consoleRows.length})
            </button>
            <button
              className={`browser-log-tab ${logTab === 'network' ? 'active' : ''}`}
              onClick={() => setLogTab('network')}
            >
              Network ({netRows.length})
            </button>
            <span className="browser-logs-spacer" />
            <button className="browser-btn" onClick={() => setLogs([])}>
              Clear
            </button>
          </div>
          <div className="browser-logs-scroll" ref={logScrollRef}>
            {!captureAvailable ? (
              <div className="browser-log-row dim">
                Console/network capture is only available in the NARUKAMI desktop app — in a
                browser tab, use DevTools on the frame instead.
              </div>
            ) : logTab === 'console' ? (
              consoleRows.length === 0 ? (
                <div className="browser-log-row dim">No console output yet.</div>
              ) : (
                consoleRows.map((r, i) => (
                  <div
                    key={i}
                    className={`browser-log-row ${
                      r.level === 'error' || r.level === 'assert'
                        ? 'err'
                        : r.level === 'warning'
                          ? 'warn'
                          : ''
                    }`}
                  >
                    {r.count > 1 && <span className="browser-log-count">×{r.count}</span>}
                    {r.text}
                  </div>
                ))
              )
            ) : netRows.length === 0 ? (
              <div className="browser-log-row dim">No requests yet.</div>
            ) : (
              netRows.map((r) => (
                <div
                  key={r.id}
                  className={`browser-log-row ${
                    r.status === 'fail' || (typeof r.status === 'number' && r.status >= 400)
                      ? 'err'
                      : ''
                  }`}
                >
                  <span className="browser-net-status">
                    {r.status === undefined ? '…' : r.status === 'fail' ? 'ERR' : r.status}
                  </span>
                  <span className="browser-net-method">{r.method}</span>
                  <span className="browser-net-url" title={r.url}>
                    {r.url}
                  </span>
                  <span className="browser-net-detail">{r.detail ?? r.rtype}</span>
                </div>
              ))
            )}
          </div>
        </div>
      )}
    </div>
  );
}

function DeviceFrame({
  device,
  url,
  nonce,
  availHeight,
}: {
  device: DevicePreset;
  url: string;
  nonce: number;
  availHeight: number;
}) {
  const k = fitScale(device.height, availHeight);
  const w = Math.round(device.width * k);
  const h = Math.round(device.height * k);
  return (
    <div className="browser-frame" style={{ width: w }}>
      <div className="browser-frame-head">
        <span className="browser-frame-name">{device.label}</span>
        <span className="browser-frame-dims">
          {device.width} × {device.height} · {Math.round(k * 100)}%
        </span>
      </div>
      {/* Transforms don't affect layout — the clip wrapper is what reserves the
          scaled box's space in the flex row. */}
      <div className="browser-frame-clip" style={{ width: w, height: h }}>
        <iframe
          key={`${device.id}:${url}:${nonce}`}
          src={url}
          title={`${device.label} preview`}
          sandbox={isLoopbackUrl(url) ? undefined : EXTERNAL_SANDBOX}
          style={{
            width: device.width,
            height: device.height,
            transform: `scale(${k})`,
            transformOrigin: 'top left',
          }}
        />
      </div>
    </div>
  );
}
