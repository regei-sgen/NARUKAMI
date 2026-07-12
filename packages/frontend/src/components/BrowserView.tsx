import {
  createElement,
  type PointerEvent as ReactPointerEvent,
  useEffect,
  useMemo,
  useRef,
  useState,
} from 'react';
import { desktop } from '../lib/desktop';
import { api } from '../api';
import type { AccuracyReport } from '../types';
import { RealFrame } from './RealFrame';
import { PopoutButton } from './PopoutButton';
import {
  BROWSER_ENGINES,
  closeBrowser,
  DEFAULT_ENABLED,
  DEFAULT_ENGINE,
  DEFAULT_URL,
  engineUa,
  layoutByHeight,
  layoutFill,
  layoutFit,
  normalizeTabs,
  normalizeUrl,
  pickActive,
  renderEngineFor,
  viewportById,
  VIEWPORT_IDS,
  VIEWPORTS,
  type BrowserTab,
  type FrameLayout,
  type Viewport,
} from '../lib/browserView';

// In the desktop shell we render each viewport in an out-of-process <webview>
// (ignores X-Frame-Options, isolates crashes); in a plain browser tab we fall
// back to an <iframe>, which works for the localhost dev servers people preview.
const ENGINE: 'webview' | 'iframe' = desktop() ? 'webview' : 'iframe';

const key = (projectId: string, k: string) => `narukami:bv:${k}:${projectId}`;
const uid = (): string =>
  typeof crypto !== 'undefined' && 'randomUUID' in crypto
    ? crypto.randomUUID()
    : `b_${Math.random().toString(36).slice(2)}`;

// Load a project's browser tabs from persisted state (migration/seeding handled
// by the pure normalizeTabs helper).
function loadBrowsers(projectId: string): BrowserTab[] {
  return normalizeTabs(
    localStorage.getItem(key(projectId, 'browsers')),
    localStorage.getItem(key(projectId, 'url')),
    localStorage.getItem(key(projectId, 'vps')),
    VIEWPORT_IDS,
    DEFAULT_ENABLED,
    uid,
  );
}

// One device frame: renders the page at `layout.frameW × layout.frameH` (the true
// viewport, which in "fill" mode is taller than the device preset so the page
// fills the panel and scrolls) inside a box scaled by `layout.scale`. The pop-out
// button opens just this viewport in its own full-window view (desktop shell), or
// browser-fullscreens the card in dev.
function DeviceFrame({
  vp,
  src,
  layout,
  token,
  ua,
  onPopOut,
}: {
  vp: Viewport;
  src: string;
  layout: FrameLayout;
  token: string;
  ua: string;
  onPopOut?: (pos?: { x: number; y: number }) => void;
}) {
  const { scale, dispW, dispH, frameW, frameH } = layout;
  const viewRef = useRef<HTMLDivElement>(null);
  const frameStyle = { width: frameW, height: frameH, border: '0', background: '#fff' } as const;
  // Only the out-of-process <webview> can spoof the User-Agent (per-frame
  // `useragent` attribute); the <iframe> dev fallback can't, so it renders as
  // plain Chromium. `token` includes the engine id, so switching browser remounts
  // the frame and the new UA takes effect.
  const frame = src
    ? ENGINE === 'webview'
      ? createElement('webview', { key: token, src, style: frameStyle, useragent: ua })
      : createElement('iframe', { key: token, src, title: vp.name, style: frameStyle })
    : null;

  const activate = (pos?: { x: number; y: number }) => {
    if (onPopOut) onPopOut(pos);
    else viewRef.current?.requestFullscreen?.().catch(() => {});
  };

  return (
    <div className="bv-card" style={{ width: dispW }}>
      <div className="bv-card-head">
        <span className="bv-card-name">{vp.name}</span>
        <span className="bv-card-dim">
          {vp.w}×{vp.h}
          {scale < 1 ? ` · ${Math.round(scale * 100)}%` : ''}
        </span>
        <PopoutButton title={`Open ${vp.name} full-screen in its own window (or drag out)`} onActivate={activate} />
      </div>
      <div className="bv-card-view" style={{ width: dispW, height: dispH }} ref={viewRef}>
        <div
          className="bv-scale"
          style={{ width: frameW, height: frameH, transform: `scale(${scale})`, transformOrigin: 'top left' }}
        >
          {frame}
        </div>
      </div>
    </div>
  );
}

// A project's Browser view: multiple independent browsers (each its own URL +
// viewport set), each a responsive multi-viewport preview of a running app.
// `onPopOut` is supplied only in the main window (adds the tear-off button); the
// torn-off window renders the same tabs without it.
export function BrowserView({
  projectId,
  onPopOut,
}: {
  projectId: string;
  onPopOut?: (pos?: { x: number; y: number }) => void;
}) {
  const initial = useMemo(() => loadBrowsers(projectId), [projectId]);
  const [browsers, setBrowsers] = useState<BrowserTab[]>(initial);
  const [activeId, setActiveId] = useState<string>(() => {
    const saved = localStorage.getItem(key(projectId, 'active'));
    return saved && initial.some((b) => b.id === saved) ? saved : initial[0].id;
  });
  const active = browsers.find((b) => b.id === activeId) ?? browsers[0];

  const [input, setInput] = useState<string>(active.url);
  const [reloadKey, setReloadKey] = useState(0);
  // Board layout: 'fit' shows ONE device filling the whole panel height (like a
  // real browser tab); 'grid' shows every selected device side by side at an
  // equal on-screen height. Both persisted per project.
  const [layout, setLayout] = useState<'fit' | 'grid'>(() =>
    localStorage.getItem(key(projectId, 'layout')) === 'grid' ? 'grid' : 'fit',
  );
  // Which single device 'fit' mode previews (its WIDTH; height fills the panel).
  const [fitVpId, setFitVpId] = useState<string>(() => {
    const saved = localStorage.getItem(key(projectId, 'fitvp'));
    if (saved && viewportById(saved)) return saved;
    const first = active.viewports.find((id) => viewportById(id));
    return first ?? 'desktop';
  });
  // Grid zoom: fraction (0.4–1) of the available panel height each card fills.
  const [gridZoom, setGridZoom] = useState<number>(() => {
    const n = Number(localStorage.getItem(key(projectId, 'gridzoom')));
    return n >= 0.4 && n <= 1 ? n : 1;
  });
  // Live inner size of the board (content box, padding excluded — from the
  // ResizeObserver), used to size the fill/grid frames to the real panel.
  const boardRef = useRef<HTMLDivElement>(null);
  const [board, setBoard] = useState<{ w: number; h: number }>({ w: 0, h: 0 });
  const [renamingId, setRenamingId] = useState<string | null>(null);
  const [renameVal, setRenameVal] = useState('');
  // Accuracy advisor: report of where the real target browser diverges from this
  // Chromium preview. Cleared when the active tab or its emulated engine changes.
  const [accuracy, setAccuracy] = useState<AccuracyReport | null>(null);
  const [checking, setChecking] = useState(false);
  const [accuracyErr, setAccuracyErr] = useState<string | null>(null);
  // Real-render mode per tab (persisted): show genuine Firefox/WebKit pixels via
  // the backend Playwright stream instead of UA-emulated Chromium. Kept off the
  // BrowserTab model (a view preference, not tab data) so persistence stays simple.
  const [realByTab, setRealByTab] = useState<Record<string, boolean>>(() => {
    try {
      return JSON.parse(localStorage.getItem(key(projectId, 'real')) || '{}');
    } catch {
      return {};
    }
  });

  // Persist tabs + which one is active.
  useEffect(() => {
    localStorage.setItem(key(projectId, 'browsers'), JSON.stringify(browsers));
  }, [browsers, projectId]);
  useEffect(() => {
    localStorage.setItem(key(projectId, 'active'), activeId);
  }, [activeId, projectId]);
  useEffect(() => {
    localStorage.setItem(key(projectId, 'real'), JSON.stringify(realByTab));
  }, [realByTab, projectId]);
  useEffect(() => {
    localStorage.setItem(key(projectId, 'layout'), layout);
  }, [layout, projectId]);
  useEffect(() => {
    localStorage.setItem(key(projectId, 'fitvp'), fitVpId);
  }, [fitVpId, projectId]);
  useEffect(() => {
    localStorage.setItem(key(projectId, 'gridzoom'), String(gridZoom));
  }, [gridZoom, projectId]);

  // Track the board's live inner size so fill/grid frames match the real panel.
  // Debounced a little: a fast panel resize (dragging the terminal dock) would
  // otherwise thrash the real-render sockets, which re-open when the frame size
  // changes. contentRect already excludes the board's padding.
  useEffect(() => {
    const el = boardRef.current;
    if (!el) return;
    let t: ReturnType<typeof setTimeout> | null = null;
    const ro = new ResizeObserver((entries) => {
      const r = entries[0]?.contentRect;
      if (!r) return;
      const w = Math.round(r.width);
      const h = Math.round(r.height);
      if (t) clearTimeout(t);
      t = setTimeout(() => {
        setBoard((prev) => (Math.abs(prev.w - w) <= 1 && Math.abs(prev.h - h) <= 1 ? prev : { w, h }));
      }, 80);
    });
    ro.observe(el);
    return () => {
      if (t) clearTimeout(t);
      ro.disconnect();
    };
    // Re-attach when switching layouts (the board element is remounted).
  }, [layout]);
  // Reset the URL bar to the newly-focused tab's URL when switching tabs.
  useEffect(() => {
    setInput(active.url);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [activeId]);
  // A prior report describes the old tab/engine — drop it when either changes.
  useEffect(() => {
    setAccuracy(null);
    setAccuracyErr(null);
  }, [activeId, active.engine]);

  const updateActive = (patch: Partial<BrowserTab>) =>
    setBrowsers((cur) => cur.map((b) => (b.id === activeId ? { ...b, ...patch } : b)));

  const go = (next: string) => {
    const n = normalizeUrl(next);
    if (!n) return;
    setInput(n);
    updateActive({ url: n });
    setReloadKey((k) => k + 1);
  };

  // Ask the backend (curated catalog + Claude over the project source) where the
  // real emulated browser will diverge from this Chromium preview.
  const checkAccuracy = async () => {
    if (checking) return;
    setChecking(true);
    setAccuracyErr(null);
    try {
      const { report } = await api.checkBrowserAccuracy(projectId, active.url, active.engine);
      setAccuracy(report);
    } catch (err) {
      setAccuracyErr(err instanceof Error ? err.message : 'Accuracy check failed.');
    } finally {
      setChecking(false);
    }
  };

  const toggleViewport = (id: string) => {
    const cur = active.viewports;
    updateActive({ viewports: cur.includes(id) ? cur.filter((x) => x !== id) : [...cur, id] });
  };

  const addBrowser = () => {
    const tab: BrowserTab = {
      id: uid(),
      name: `Browser ${browsers.length + 1}`,
      url: DEFAULT_URL,
      viewports: DEFAULT_ENABLED,
      engine: DEFAULT_ENGINE,
    };
    setBrowsers((cur) => [...cur, tab]);
    setActiveId(tab.id);
  };
  const removeBrowser = (id: string) => {
    if (browsers.length <= 1) return;
    setActiveId((cur) => pickActive(browsers, id, cur));
    setBrowsers((cur) => closeBrowser(cur, id));
  };
  const commitRename = (id: string) => {
    const name = renameVal.trim();
    if (name) setBrowsers((cur) => cur.map((b) => (b.id === id ? { ...b, name } : b)));
    setRenamingId(null);
  };

  const shownVps = useMemo(
    () => VIEWPORTS.filter((v) => active.viewports.includes(v.id)),
    [active.viewports],
  );
  // The single device previewed in 'fit' mode (guarded against a stale saved id).
  const fitVp = viewportById(fitVpId) ?? viewportById('desktop') ?? VIEWPORTS[0];

  // Real render only applies to Firefox/WebKit; Chromium-family ids already
  // render natively in the webview, so the toggle is disabled for them.
  const realEngine = renderEngineFor(active.engine);
  const realMode = Boolean(realEngine) && Boolean(realByTab[activeId]);
  const toggleReal = () =>
    setRealByTab((cur) => ({ ...cur, [activeId]: !cur[activeId] }));

  // Per-viewport pop-out: open just one device (of the active browser) in its own
  // full-window view. In the desktop shell each opens a separate window (many can
  // coexist, keyed by project+browser+viewport); in a plain browser tab the frame
  // falls back to the Fullscreen API. Undefined here → the frame uses the fallback.
  const desk = desktop();
  const popOutViewport = desk
    ? (vpId: string, pos?: { x: number; y: number }) =>
        desk.popOutViewport({ projectId, browserId: activeId, vpId, pos })
    : undefined;

  // Tear-off: click pops the whole view out to its own window; press-and-drag
  // pops it out at the cursor (and swallows the trailing click).
  const draggedRef = useRef(false);
  const beginPopOutDrag = (e: ReactPointerEvent) => {
    if (e.button !== 0 || !onPopOut) return;
    const start = { x: e.clientX, y: e.clientY };
    draggedRef.current = false;
    const onMove = (ev: PointerEvent) => {
      if (Math.hypot(ev.clientX - start.x, ev.clientY - start.y) > 8) {
        draggedRef.current = true;
        document.body.classList.add('tab-tearing');
      }
    };
    const onUp = (ev: PointerEvent) => {
      window.removeEventListener('pointermove', onMove);
      window.removeEventListener('pointerup', onUp);
      document.body.classList.remove('tab-tearing');
      if (draggedRef.current) onPopOut({ x: ev.screenX, y: ev.screenY });
    };
    window.addEventListener('pointermove', onMove);
    window.addEventListener('pointerup', onUp);
  };

  return (
    <div className="bv">
      <div className="bv-tabs">
        {browsers.map((b) => (
          <div key={b.id} className={`bv-tab ${b.id === activeId ? 'active' : ''}`}>
            {renamingId === b.id ? (
              <input
                className="bv-tab-rename"
                autoFocus
                value={renameVal}
                spellCheck={false}
                onChange={(e) => setRenameVal(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === 'Enter') commitRename(b.id);
                  else if (e.key === 'Escape') setRenamingId(null);
                }}
                onBlur={() => commitRename(b.id)}
              />
            ) : (
              <button
                className="bv-tab-btn"
                onClick={() => setActiveId(b.id)}
                onDoubleClick={() => {
                  setRenamingId(b.id);
                  setRenameVal(b.name);
                }}
                title="Double-click to rename"
              >
                {b.name}
              </button>
            )}
            {browsers.length > 1 && (
              <button className="bv-tab-close" title="Close browser" onClick={() => removeBrowser(b.id)}>
                ×
              </button>
            )}
          </div>
        ))}
        <button className="bv-tab-add" title="New browser" onClick={addBrowser}>
          +
        </button>
      </div>

      <div className="bv-bar">
        <form
          className="bv-url"
          onSubmit={(e) => {
            e.preventDefault();
            go(input);
          }}
        >
          <input
            className="bv-input"
            value={input}
            spellCheck={false}
            placeholder="http://localhost:3000"
            onChange={(e) => setInput(e.target.value)}
          />
          <button type="submit" className="btn bv-go">
            Go
          </button>
          <button
            type="button"
            className="btn bv-reload"
            title="Reload all viewports"
            onClick={() => setReloadKey((k) => k + 1)}
          >
            ⟳
          </button>
        </form>

        <label className="bv-engine" title="Emulate this browser's User-Agent (pixels still render in Chromium)">
          <select
            className="bv-engine-sel"
            value={active.engine}
            onChange={(e) => updateActive({ engine: e.target.value })}
          >
            {BROWSER_ENGINES.map((eng) => (
              <option key={eng.id} value={eng.id}>
                {eng.name}
              </option>
            ))}
          </select>
        </label>

        <button
          type="button"
          className={`btn bv-realtoggle ${realMode ? 'on' : ''}`}
          disabled={!realEngine}
          title={
            realEngine
              ? 'Render with the REAL engine (Playwright) instead of a User-Agent spoof'
              : 'Chrome-family already renders natively here — real render is for Firefox/Safari'
          }
          onClick={toggleReal}
        >
          {realEngine
            ? realMode
              ? `Real: ${realEngine === 'firefox' ? 'Firefox' : 'WebKit'}`
              : 'Real render'
            : 'Native'}
        </button>

        <button
          type="button"
          className="btn bv-accuracy"
          title="Ask Claude where the real selected browser would render differently from this Chromium preview"
          onClick={checkAccuracy}
          disabled={checking}
        >
          {checking ? 'Checking…' : 'Check accuracy'}
        </button>

        <div
          className="bv-layout"
          role="group"
          aria-label="Board layout"
          title="Fit: one device fills the panel height · Grid: all selected devices at equal height"
        >
          <button
            type="button"
            className={`bv-seg ${layout === 'fit' ? 'on' : ''}`}
            onClick={() => setLayout('fit')}
          >
            Fit
          </button>
          <button
            type="button"
            className={`bv-seg ${layout === 'grid' ? 'on' : ''}`}
            onClick={() => setLayout('grid')}
          >
            Grid
          </button>
        </div>

        {layout === 'fit' ? (
          <label
            className="bv-fitdev"
            title="Device width to preview — the page fills the panel height and scrolls like a real browser"
          >
            <select
              className="bv-engine-sel"
              value={fitVpId}
              onChange={(e) => setFitVpId(e.target.value)}
            >
              {VIEWPORTS.map((v) => (
                <option key={v.id} value={v.id}>
                  {v.name} · {v.w}×{v.h}
                </option>
              ))}
            </select>
          </label>
        ) : (
          <>
            <div className="bv-vps">
              {VIEWPORTS.map((v) => (
                <button
                  key={v.id}
                  className={`bv-chip ${active.viewports.includes(v.id) ? 'on' : ''}`}
                  title={`${v.w}×${v.h}`}
                  onClick={() => toggleViewport(v.id)}
                >
                  {v.name}
                </button>
              ))}
            </div>

            <label className="bv-zoom" title="On-screen size of each device in the grid">
              <span className="bv-zoom-l">size</span>
              <input
                type="range"
                min={0.4}
                max={1}
                step={0.05}
                value={gridZoom}
                onChange={(e) => setGridZoom(Number(e.target.value))}
              />
            </label>
          </>
        )}

        {onPopOut && (
          <button
            type="button"
            className="btn bv-popout"
            title="Open the browser in its own window (drag it back to re-dock)"
            aria-label="Pop browser out to its own window"
            onPointerDown={beginPopOutDrag}
            onClick={() => {
              if (draggedRef.current) {
                draggedRef.current = false;
                return; // this click is the tail of a drag — already popped out
              }
              onPopOut();
            }}
          >
            <svg viewBox="0 0 16 16" width="13" height="13" aria-hidden="true">
              <path
                d="M6.5 3.5H3.5A1 1 0 0 0 2.5 4.5V12.5A1 1 0 0 0 3.5 13.5H11.5A1 1 0 0 0 12.5 12.5V9.5"
                fill="none"
                stroke="currentColor"
                strokeWidth="1.3"
                strokeLinecap="round"
              />
              <path
                d="M9.5 2.5H13.5V6.5M13.5 2.5L8 8"
                fill="none"
                stroke="currentColor"
                strokeWidth="1.3"
                strokeLinecap="round"
                strokeLinejoin="round"
              />
            </svg>
            Pop out
          </button>
        )}
      </div>

      {accuracyErr && (
        <div className="bv-accuracy-panel error">
          <div className="bv-accuracy-head">
            <span className="bv-accuracy-title">Accuracy check failed</span>
            <button className="bv-accuracy-close" title="Dismiss" onClick={() => setAccuracyErr(null)}>
              ×
            </button>
          </div>
          <p className="bv-accuracy-summary">{accuracyErr}</p>
        </div>
      )}

      {accuracy && (
        <div className="bv-accuracy-panel">
          <div className="bv-accuracy-head">
            <span className="bv-accuracy-title">
              {accuracy.engine} vs. this Chromium preview
            </span>
            <span className="bv-accuracy-count">
              {accuracy.findings.length} difference{accuracy.findings.length === 1 ? '' : 's'}
            </span>
            <button className="bv-accuracy-close" title="Dismiss" onClick={() => setAccuracy(null)}>
              ×
            </button>
          </div>
          <p className="bv-accuracy-summary">{accuracy.summary}</p>
          {accuracy.findings.length > 0 && (
            <ul className="bv-findings">
              {accuracy.findings.map((f, i) => (
                <li key={i} className="bv-finding">
                  <div className="bv-finding-head">
                    <span className={`bv-sev ${f.severity}`}>{f.severity}</span>
                    <span className="bv-finding-area">{f.area}</span>
                    <span className={`bv-src ${f.source}`} title={f.source === 'claude' ? 'Found by Claude in this project' : 'From the built-in reference'}>
                      {f.source === 'claude' ? 'this project' : 'reference'}
                    </span>
                  </div>
                  <p className="bv-finding-note">{f.note}</p>
                  {f.fix && <p className="bv-finding-fix">Fix: {f.fix}</p>}
                </li>
              ))}
            </ul>
          )}
        </div>
      )}

      {layout === 'fit' ? (
        <div className="bv-board fit" ref={boardRef}>
          {board.w > 0 &&
            board.h > 0 &&
            (realMode ? (
              <RealFrame
                key={`real:fit:${fitVp.id}`}
                engineId={active.engine}
                src={active.url}
                vp={fitVp}
                layout={layoutFill(fitVp.w, board.w, board.h)}
                reloadKey={reloadKey}
                onPopOut={popOutViewport ? (pos) => popOutViewport(fitVp.id, pos) : undefined}
              />
            ) : (
              <DeviceFrame
                key={`fit:${fitVp.id}`}
                vp={fitVp}
                src={active.url}
                layout={layoutFill(fitVp.w, board.w, board.h)}
                token={`${activeId}:${active.engine}:${reloadKey}`}
                ua={engineUa(active.engine)}
                onPopOut={popOutViewport ? (pos) => popOutViewport(fitVp.id, pos) : undefined}
              />
            ))}
        </div>
      ) : (
        // Board stays mounted even with no viewports selected so the size
        // ResizeObserver (keyed on `layout`) keeps tracking a stable element.
        <div className="bv-board grid" ref={boardRef}>
          {shownVps.length === 0 ? (
            <div className="bv-empty">No viewports selected — enable one above.</div>
          ) : (
            shownVps.map((v) => {
            // Every device to a common on-screen height (fraction of the panel),
            // so the row is equal-height and never forces a vertical scroll.
            const gh = Math.max(160, Math.round((board.h - 28) * gridZoom));
            const gl = layoutByHeight(v.w, v.h, gh);
            return realMode ? (
              <RealFrame
                key={`real:${v.id}`}
                engineId={active.engine}
                src={active.url}
                vp={v}
                layout={gl}
                reloadKey={reloadKey}
                onPopOut={popOutViewport ? (pos) => popOutViewport(v.id, pos) : undefined}
              />
            ) : (
              <DeviceFrame
                key={v.id}
                vp={v}
                src={active.url}
                layout={gl}
                token={`${activeId}:${active.engine}:${reloadKey}`}
                ua={engineUa(active.engine)}
                onPopOut={popOutViewport ? (pos) => popOutViewport(v.id, pos) : undefined}
              />
            );
            })
          )}
        </div>
      )}
    </div>
  );
}

// Full-window view of ONE device viewport for a specific browser tab, rendered
// in a per-viewport pop-out window (`?popout=viewport&project=&browser=&vp=`). It
// reads the tab's persisted URL/engine/real-mode and sizes the viewport to fill
// the window (fitting both dimensions, never upscaling past 1:1). Independent of
// the main board, so many can be open at once.
export function SingleViewport({
  projectId,
  browserId,
  vpId,
}: {
  projectId: string;
  browserId: string;
  vpId: string;
}) {
  const [size, setSize] = useState({ w: window.innerWidth, h: window.innerHeight });
  useEffect(() => {
    const on = () => setSize({ w: window.innerWidth, h: window.innerHeight });
    window.addEventListener('resize', on);
    return () => window.removeEventListener('resize', on);
  }, []);

  const tab = useMemo(
    () => loadBrowsers(projectId).find((b) => b.id === browserId),
    [projectId, browserId],
  );
  const real = useMemo(() => {
    try {
      return Boolean(
        (JSON.parse(localStorage.getItem(key(projectId, 'real')) || '{}') as Record<string, boolean>)[
          browserId
        ],
      );
    } catch {
      return false;
    }
  }, [projectId, browserId]);

  const vp = viewportById(vpId);
  if (!tab || !vp) {
    return <div className="sv-empty">This viewport is no longer available.</div>;
  }

  // Fit the device box within the window (both axes); layoutFit caps at 1:1 so a
  // small viewport shows crisp at native size rather than a blurry upscale.
  const availW = Math.max(120, size.w - 16);
  const availH = Math.max(120, size.h - 44);
  const svLayout = layoutFit(vp.w, vp.h, availW, availH);
  const realEngine = renderEngineFor(tab.engine);

  return (
    <div className="sv-root">
      <div className="sv-head">
        <span className="sv-name">{vp.name}</span>
        <span className="sv-meta">
          {tab.name} · {vp.w}×{vp.h}
          {real && realEngine ? ` · REAL ${realEngine === 'firefox' ? 'Firefox' : 'WebKit'}` : ''}
        </span>
      </div>
      <div className="sv-stage">
        {real && realEngine ? (
          <RealFrame engineId={tab.engine} src={tab.url} vp={vp} layout={svLayout} reloadKey={0} />
        ) : (
          <DeviceFrame
            vp={vp}
            src={tab.url}
            layout={svLayout}
            token={`${browserId}:${tab.engine}:sv`}
            ua={engineUa(tab.engine)}
          />
        )}
      </div>
    </div>
  );
}
