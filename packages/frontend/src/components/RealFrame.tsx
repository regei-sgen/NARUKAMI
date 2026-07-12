import {
  type KeyboardEvent as ReactKeyboardEvent,
  type PointerEvent as ReactPointerEvent,
  type WheelEvent as ReactWheelEvent,
  useEffect,
  useRef,
  useState,
} from 'react';
import { api, renderWsUrl } from '../api';
import type { FrameLayout } from '../lib/browserView';
import { PopoutButton } from './PopoutButton';

// One device viewport rendered by a REAL engine (Firefox/Gecko or WebKit) via
// the backend Playwright stream. Shows live JPEG frames and forwards
// click/scroll/type back into the real page. `engineId` is the selectable id
// (firefox / safari / safari-ios); the backend maps it to the actual engine.
interface Vp {
  id: string;
  name: string;
  w: number;
  h: number;
}

type Status = 'connecting' | 'live' | 'error' | 'install';

// Map a printable single key to text; everything else is sent as a named key
// press (Enter, Backspace, ArrowDown, Tab, …) so real forms are usable.
function isPrintable(e: ReactKeyboardEvent): boolean {
  return e.key.length === 1 && !e.ctrlKey && !e.metaKey && !e.altKey;
}

export function RealFrame({
  engineId,
  src,
  vp,
  layout,
  reloadKey,
  onPopOut,
}: {
  engineId: string;
  src: string;
  vp: Vp;
  layout: FrameLayout;
  reloadKey: number;
  onPopOut?: (pos?: { x: number; y: number }) => void;
}) {
  const { scale, dispW, dispH, frameW, frameH } = layout;
  const [frame, setFrame] = useState<string | null>(null);
  const [status, setStatus] = useState<Status>('connecting');
  const [message, setMessage] = useState('');
  const [installing, setInstalling] = useState(false);
  // Bumping this forces a full socket reconnect (fresh backend session). Used
  // after installing engines, since a session that already answered `open` with
  // needsInstall won't re-open on the same socket.
  const [nonce, setNonce] = useState(0);
  const wsRef = useRef<WebSocket | null>(null);
  const viewRef = useRef<HTMLDivElement>(null);
  const activate = (pos?: { x: number; y: number }) => {
    if (onPopOut) onPopOut(pos);
    else viewRef.current?.requestFullscreen?.().catch(() => {});
  };

  const sendMsg = (m: unknown) => {
    const ws = wsRef.current;
    if (ws && ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(m));
  };

  // (Re)connect whenever the engine or the device viewport changes — the backend
  // session's context is built for a specific engine + size.
  useEffect(() => {
    setFrame(null);
    setStatus('connecting');
    setMessage('');
    let cancelled = false;
    const ws = new WebSocket(renderWsUrl());
    wsRef.current = ws;

    ws.onopen = () => {
      // Render at the frame's intrinsic size (in 'fill' mode this is taller than
      // the device preset, so the real page fills the panel and scrolls).
      if (!cancelled) ws.send(JSON.stringify({ type: 'open', engineId, url: src, w: frameW, h: frameH }));
    };
    ws.onmessage = (ev) => {
      if (cancelled) return;
      let m: { type?: string; mime?: string; data?: string; message?: string; needsInstall?: boolean };
      try {
        m = JSON.parse(String(ev.data));
      } catch {
        return;
      }
      if (m.type === 'frame' && m.data) {
        setFrame(`data:${m.mime ?? 'image/jpeg'};base64,${m.data}`);
        setStatus('live');
      } else if (m.type === 'error') {
        setStatus(m.needsInstall ? 'install' : 'error');
        setMessage(m.message ?? 'Real render failed.');
      } else if (m.type === 'loaderror') {
        setMessage(m.message ?? '');
      }
    };
    ws.onerror = () => {
      if (!cancelled) setStatus((s) => (s === 'live' ? s : 'error'));
    };

    return () => {
      cancelled = true;
      try {
        if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify({ type: 'close' }));
      } catch {
        /* noop */
      }
      ws.close();
      wsRef.current = null;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [engineId, frameW, frameH, nonce]);

  // Same connection: navigate on URL change, reload when the reload button ticks.
  useEffect(() => {
    sendMsg({ type: 'nav', url: src });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [src]);
  useEffect(() => {
    if (reloadKey > 0) sendMsg({ type: 'reload' });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [reloadKey]);

  // Map a DOM event position within the scaled frame back to real viewport px.
  const toViewport = (clientX: number, clientY: number, el: HTMLElement) => {
    const r = el.getBoundingClientRect();
    return { x: (clientX - r.left) / scale, y: (clientY - r.top) / scale };
  };

  const onPointerDown = (e: ReactPointerEvent<HTMLDivElement>) => {
    if (status !== 'live') return;
    const p = toViewport(e.clientX, e.clientY, e.currentTarget);
    e.currentTarget.focus();
    sendMsg({ type: 'input', kind: 'click', x: p.x, y: p.y, button: e.button === 2 ? 'right' : 'left' });
  };
  const onWheel = (e: ReactWheelEvent<HTMLDivElement>) => {
    if (status !== 'live') return;
    sendMsg({ type: 'input', kind: 'scroll', dx: e.deltaX, dy: e.deltaY });
  };
  const onKeyDown = (e: ReactKeyboardEvent<HTMLDivElement>) => {
    if (status !== 'live') return;
    if (isPrintable(e)) {
      sendMsg({ type: 'input', kind: 'text', text: e.key });
      e.preventDefault();
    } else if (['Enter', 'Backspace', 'Tab', 'ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight', 'Delete', 'Escape', 'Home', 'End'].includes(e.key)) {
      sendMsg({ type: 'input', kind: 'key', key: e.key });
      e.preventDefault();
    }
  };

  const doInstall = async () => {
    setInstalling(true);
    setMessage('Downloading real browser engines… this runs once and can take a few minutes.');
    try {
      await api.installRenderBrowsers();
      // Force a full reconnect: the current backend session already answered
      // `open` with needsInstall and won't re-open on the same socket. Bumping
      // the nonce tears down this socket and opens a fresh session.
      setStatus('connecting');
      setNonce((n) => n + 1);
    } catch (err) {
      setStatus('error');
      setMessage(err instanceof Error ? err.message : 'Install failed.');
    } finally {
      setInstalling(false);
    }
  };

  const engineName = engineId === 'firefox' ? 'Firefox' : engineId === 'safari-ios' ? 'Safari (iOS)' : 'Safari';

  return (
    <div className="bv-card" style={{ width: dispW }}>
      <div className="bv-card-head">
        <span className="bv-card-name">
          {vp.name} <span className="bv-real-badge">REAL {engineName}</span>
        </span>
        <span className="bv-card-dim">
          {vp.w}×{vp.h}
          {scale < 1 ? ` · ${Math.round(scale * 100)}%` : ''}
        </span>
        <PopoutButton title={`Open ${vp.name} (${engineName}) full-screen in its own window (or drag out)`} onActivate={activate} />
      </div>
      <div
        ref={viewRef}
        className="bv-card-view bv-real-view"
        style={{ width: dispW, height: dispH }}
        tabIndex={0}
        onPointerDown={onPointerDown}
        onContextMenu={(e) => e.preventDefault()}
        onWheel={onWheel}
        onKeyDown={onKeyDown}
      >
        {frame && <img src={frame} width={dispW} height={dispH} alt={`${engineName} render`} draggable={false} />}
        {status !== 'live' && (
          <div className="bv-real-overlay">
            {status === 'connecting' && <span className="bv-real-spinner">Rendering in real {engineName}…</span>}
            {status === 'error' && <span className="bv-real-err">{message || 'Real render unavailable.'}</span>}
            {status === 'install' && (
              <div className="bv-real-install">
                <p>{message || `Real ${engineName} isn't installed yet.`}</p>
                <button className="btn" onClick={doInstall} disabled={installing}>
                  {installing ? 'Installing…' : `Download ${engineName} engine`}
                </button>
              </div>
            )}
          </div>
        )}
        {status === 'live' && message && <div className="bv-real-toast">{message}</div>}
      </div>
    </div>
  );
}
