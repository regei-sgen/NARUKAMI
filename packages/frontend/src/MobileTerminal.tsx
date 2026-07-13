import { useEffect, useRef, useState } from 'react';
import { Terminal, type IDisposable } from '@xterm/xterm';
import { FitAddon } from '@xterm/addon-fit';
import { getMobileRun, mobileWsUrl } from './api';
import { normalizeStatus } from './lib/runStatus';
import { nextReconnectAction, type ReconnectAction } from './lib/reconnect';
import type { MobileRunInfo, RunStatus } from './types';

/**
 * A single live terminal, streamed to a phone over the LAN share relay. Loaded
 * when the SPA sees `?m=<shareToken>&run=<runId>` (see main.tsx). It authenticates
 * with the scoped share token — never the master token, which the phone's page
 * was served WITHOUT — plus a per-device approval: the desktop must press Allow
 * for THIS phone before the stream opens (state 'pending' below).
 *
 * Rendering model: the phone is a MIRROR. One pty has one grid, and the desktop
 * owns it — instead of imposing its own fit (which used to shrink the desktop's
 * terminal under the user), the phone adopts the pty grid from the server's
 * 'resize' messages and auto-scales its font so that grid fits the screen.
 * An input-capable share can still explicitly claim the grid with the "Fit"
 * key (useful when driving the session from the phone), which the desktop then
 * adopts the same way.
 */

// Fallback glyph ratios (width/height per px of fontSize) for the pre-measure
// window; replaced by the renderer's real cell metrics once available.
const CELL_W_RATIO = 0.6;
const CELL_H_RATIO = 1.4;
const FONT_MIN = 5;
const FONT_MAX = 18;
const FIT_FONT = 13; // comfortable size used when the phone claims the grid

type Approval = 'pending' | 'approved' | 'denied';

export function MobileTerminal({ runId, shareToken }: { runId: string; shareToken: string }) {
  const rootRef = useRef<HTMLDivElement>(null);
  const containerRef = useRef<HTMLDivElement>(null);
  const termRef = useRef<Terminal | null>(null);
  const fitRef = useRef<FitAddon | null>(null);
  const wsRef = useRef<WebSocket | null>(null);
  const [info, setInfo] = useState<MobileRunInfo | null>(null);
  const [status, setStatus] = useState<RunStatus>('connecting');
  const [error, setError] = useState<string | null>(null);
  const [canInput, setCanInput] = useState(true);
  const [approval, setApproval] = useState<Approval>('pending');

  // Metadata + device-approval loop. The first fetch is what makes this phone
  // "knock" (creates the pending entry that prompts Allow/Deny on the desktop);
  // while pending we keep polling until the desktop decides. Transient fetch
  // failures (Wi-Fi blip, phone screen lock, relay hiccup) RETRY — only a
  // definitive "share is gone" response ends the page, otherwise one dropped
  // packet while waiting for Allow would dead-end the phone permanently.
  useEffect(() => {
    let gone = false;
    let timer: ReturnType<typeof setTimeout> | null = null;
    const poll = async (): Promise<void> => {
      try {
        const m = await getMobileRun(runId, shareToken);
        if (gone) return;
        setInfo(m);
        setCanInput(m.canInput);
        setApproval(m.approval);
        document.title = `${m.projectName} · ${m.label} — NARUKAMI`;
        if (m.approval === 'pending') timer = setTimeout(() => void poll(), 1500);
      } catch (e) {
        if (gone) return;
        if (/expired|invalid|not found|401|404/i.test((e as Error).message)) {
          setError('This share has ended.');
          return;
        }
        timer = setTimeout(() => void poll(), 2000); // transient — keep knocking
      }
    };
    void poll();
    return () => {
      gone = true;
      if (timer) clearTimeout(timer);
    };
  }, [runId, shareToken]);

  // Keep the layout pinned to the VISUAL viewport. On iOS (always) and Android
  // Chrome (pre-`interactive-widget` support) the soft keyboard shrinks only the
  // visual viewport — 100dvh keeps the layout full-height, hiding the key bar
  // and the terminal's bottom rows behind the keyboard. Pinning the root's
  // height to visualViewport.height (and scrolling the pan away) keeps the
  // whole UI visible; the container ResizeObserver below then re-scales the font.
  useEffect(() => {
    const vv = window.visualViewport;
    const root = rootRef.current;
    if (!vv || !root) return;
    const apply = (): void => {
      root.style.height = `${Math.round(vv.height)}px`;
      window.scrollTo(0, 0);
    };
    apply();
    vv.addEventListener('resize', apply);
    vv.addEventListener('scroll', apply);
    return () => {
      vv.removeEventListener('resize', apply);
      vv.removeEventListener('scroll', apply);
      root.style.height = '';
    };
  }, []);

  // xterm + websocket lifecycle. Gated on device approval; mirrors the desktop
  // TerminalTab's reconnect policy (the pure nextReconnectAction helper) so a
  // phone locking its screen — which drops the socket — reattaches to the same
  // pty instead of dying.
  useEffect(() => {
    if (error || approval !== 'approved') return; // nothing opened → nothing to tear down
    let disposed = false;
    let gotExit = false;
    let t: Terminal | null = null;
    let dataDisposable: IDisposable | null = null;
    let ro: ResizeObserver | null = null;
    let reconnectTimer: ReturnType<typeof setTimeout> | null = null;
    let reconnectAttempts = 0;
    let isReconnect = false;
    const RECONNECT_DELAYS = [250, 500, 1000, 1500, 2500, 4000];
    const MAX_RECONNECT = 40;

    // The pty's authoritative grid (server-announced). 0 until the first
    // 'resize' message; the mirror only kicks in once it's known.
    let ptyCols = 0;
    let ptyRows = 0;

    const container = containerRef.current;

    /** Current cell-size-per-fontSize-px ratios from the live renderer. */
    const cellRatios = (term: Terminal): { w: number; h: number } => {
      const core = (term as unknown as {
        _core?: { _renderService?: { dimensions?: { css?: { cell?: { width: number; height: number } } } } };
      })._core;
      const cell = core?._renderService?.dimensions?.css?.cell;
      const size = term.options.fontSize ?? FIT_FONT;
      if (cell && cell.width > 0 && cell.height > 0 && size > 0) {
        return { w: cell.width / size, h: cell.height / size };
      }
      return { w: CELL_W_RATIO, h: CELL_H_RATIO };
    };

    // Adopt the pty grid and auto-scale the font so that grid fills the screen
    // as large as possible without clipping. Re-run on every container size
    // change (rotation, keyboard, URL bar) and every server grid change.
    const applyMirror = (): void => {
      if (disposed || !t || !container || !ptyCols || !ptyRows) return;
      const w = container.clientWidth - 12; // .mobile-term-surface padding: 4px 6px
      const h = container.clientHeight - 8;
      if (w <= 0 || h <= 0) return;
      const { w: rw, h: rh } = cellRatios(t);
      const byWidth = w / (ptyCols * rw);
      const byHeight = h / (ptyRows * rh);
      const font = Math.max(FONT_MIN, Math.min(FONT_MAX, Math.floor(Math.min(byWidth, byHeight))));
      if (t.options.fontSize !== font) t.options.fontSize = font;
      if (t.cols !== ptyCols || t.rows !== ptyRows) t.resize(ptyCols, ptyRows);
    };

    const openSocket = (): void => {
      if (disposed || !t) return;
      const term = t;
      if (dataDisposable) {
        dataDisposable.dispose();
        dataDisposable = null;
      }
      const socket = new WebSocket(mobileWsUrl(runId, shareToken));
      wsRef.current = socket;

      socket.onopen = () => {
        if (isReconnect) {
          term.reset();
          isReconnect = false;
        }
        reconnectAttempts = 0;
        // NOTE: deliberately NO resize send here. The server announces the
        // authoritative grid first; connecting must never reshape the desktop's
        // terminal (that was the old behavior, and it garbled both views).
      };

      dataDisposable = term.onData((data) => {
        if (socket.readyState === WebSocket.OPEN) {
          socket.send(JSON.stringify({ type: 'input', data }));
        }
      });

      socket.onmessage = (ev) => {
        if (disposed) return;
        let msg: {
          type: string;
          chunk?: string;
          status?: string;
          exitCode?: number | null;
          message?: string;
          cols?: number;
          rows?: number;
        };
        try {
          msg = JSON.parse(ev.data as string);
        } catch {
          return;
        }
        if (msg.type === 'data' && typeof msg.chunk === 'string') {
          term.write(msg.chunk);
        } else if (
          msg.type === 'resize' &&
          typeof msg.cols === 'number' &&
          typeof msg.rows === 'number'
        ) {
          // The one true grid (sent on attach and whenever any client resizes).
          ptyCols = Math.max(2, Math.min(500, Math.floor(msg.cols)));
          ptyRows = Math.max(1, Math.min(300, Math.floor(msg.rows)));
          applyMirror();
        } else if (msg.type === 'ready') {
          setStatus('running');
        } else if (msg.type === 'exit') {
          gotExit = true;
          setStatus(normalizeStatus(msg.status));
          term.write('\x1b[?1049l\x1b[?25h\x1b[?1000l\x1b[?1002l\x1b[?1006l\x1b[?2004l');
          const code = msg.exitCode != null ? ` — exit ${msg.exitCode}` : '';
          term.write(`\r\n\x1b[90m[process ${normalizeStatus(msg.status)}${code}]\x1b[0m\r\n`);
        } else if (msg.type === 'error') {
          gotExit = true;
          setStatus('error');
          term.write(`\r\n\x1b[31m[error] ${msg.message ?? 'unknown'}\x1b[0m\r\n`);
        }
      };

      socket.onerror = () => {};
      socket.onclose = (ev) => {
        if (disposed || gotExit) return;
        // 4403 = the desktop pressed Deny while we were streaming. Don't spin
        // the reconnect loop against a closed door.
        if (ev.code === 4403) {
          gotExit = true;
          setApproval('denied');
          return;
        }
        // 4410 = the share itself was revoked/expired — over immediately.
        if (ev.code === 4410) {
          gotExit = true;
          setError('This share has ended.');
          return;
        }
        scheduleReconnect();
      };
    };

    const scheduleReconnect = (): void => {
      if (disposed || gotExit) return;
      setStatus('connecting');
      const delay = RECONNECT_DELAYS[Math.min(reconnectAttempts, RECONNECT_DELAYS.length - 1)];
      reconnectAttempts += 1;
      if (reconnectTimer) clearTimeout(reconnectTimer);
      reconnectTimer = setTimeout(() => void tryReconnect(), delay);
    };

    const tryReconnect = async (): Promise<void> => {
      if (disposed || gotExit) return;
      let action: ReconnectAction;
      try {
        const m = await getMobileRun(runId, shareToken);
        if (disposed || gotExit) return;
        if (m.approval !== 'approved') {
          // Revoked mid-session (or approvals were reset) — surface it instead
          // of hammering a socket that will 403.
          gotExit = true;
          setApproval(m.approval);
          return;
        }
        action = nextReconnectAction(m, reconnectAttempts, MAX_RECONNECT);
        if (action.kind === 'reconnect') {
          isReconnect = true;
          openSocket();
          return;
        }
        if (action.kind === 'settle') {
          gotExit = true;
          setStatus(action.status);
          return;
        }
      } catch (e) {
        // A 401 here means the share expired or was revoked — stop, don't spin.
        if (/expired|invalid|401/i.test((e as Error).message)) {
          if (!disposed) setError('This share has ended.');
          return;
        }
        action = reconnectAttempts >= MAX_RECONNECT ? { kind: 'giveup' } : { kind: 'retry' };
      }
      if (action.kind === 'giveup') {
        setStatus('error');
        t?.write('\r\n\x1b[31m[disconnected]\x1b[0m\r\n');
        return;
      }
      scheduleReconnect();
    };

    // Async init: wait (briefly) for the terminal webfont before the first
    // glyph measurement — measuring the fallback font and then swapping to
    // JetBrains Mono leaves every cell mis-sized until the next resize.
    void (async () => {
      try {
        await Promise.race([
          document.fonts.load(`${FIT_FONT}px "JetBrains Mono"`),
          new Promise((resolve) => setTimeout(resolve, 1500)),
        ]);
      } catch {
        /* fallback font it is */
      }
      if (disposed || !container) return;

      const term = new Terminal({
        cursorBlink: true,
        // JetBrains Mono is bundled with the SPA (@fontsource) so phones render
        // the same face the desktop does; Cascadia only exists on Windows.
        fontFamily: '"JetBrains Mono", "Cascadia Mono", Consolas, monospace',
        fontSize: FIT_FONT,
        scrollback: 5000,
        theme: { background: '#050506', foreground: '#e8e8ee', cursor: '#ff2d3c' },
      });
      const fit = new FitAddon();
      term.loadAddon(fit);
      t = term;
      termRef.current = term;
      fitRef.current = fit;
      // DOM renderer (no WebGL): mobile GPUs blocklist WebGL erratically, and the
      // DOM renderer is the reliable baseline for a single phone terminal.
      term.open(container);

      // Rescale the mirror whenever the surface changes size (rotation, soft
      // keyboard via the visualViewport pin, browser URL bar).
      ro = new ResizeObserver(() => applyMirror());
      ro.observe(container);

      openSocket();
    })();

    return () => {
      disposed = true;
      if (reconnectTimer) clearTimeout(reconnectTimer);
      if (ro) ro.disconnect();
      if (dataDisposable) dataDisposable.dispose();
      if (wsRef.current) {
        try {
          wsRef.current.close();
        } catch {
          /* noop */
        }
      }
      t?.dispose();
      termRef.current = null;
      fitRef.current = null;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [runId, shareToken, error, approval]);

  // Send a raw sequence for the keys a mobile soft-keyboard lacks.
  const sendKey = (seq: string): void => {
    const ws = wsRef.current;
    if (ws && ws.readyState === WebSocket.OPEN && canInput) {
      ws.send(JSON.stringify({ type: 'input', data: seq }));
    }
    termRef.current?.focus();
  };

  // Claim the grid for the phone: size the pty to what fits THIS screen at a
  // comfortable font. The desktop view adopts it (mirror in the other
  // direction) until someone adjusts the desktop again. Explicit-only — never
  // automatic — so merely connecting can't reshape the desktop's terminal.
  const fitToPhone = (): void => {
    const term = termRef.current;
    const fit = fitRef.current;
    const ws = wsRef.current;
    if (!term || !fit || !ws || ws.readyState !== WebSocket.OPEN || !canInput) return;
    term.options.fontSize = FIT_FONT;
    // The renderer re-measures its cell size asynchronously after a font
    // change — propose dimensions a frame later or we'd fit with stale metrics.
    requestAnimationFrame(() => {
      if (ws.readyState !== WebSocket.OPEN) return;
      const dims = fit.proposeDimensions();
      if (!dims || Number.isNaN(dims.cols) || Number.isNaN(dims.rows)) return;
      term.resize(dims.cols, dims.rows);
      ws.send(JSON.stringify({ type: 'resize', cols: dims.cols, rows: dims.rows }));
      term.focus();
    });
  };

  if (error) {
    return (
      <div className="mobile-term" ref={rootRef}>
        <div className="mobile-term-empty">{error}</div>
      </div>
    );
  }

  if (approval !== 'approved') {
    return (
      <div className="mobile-term" ref={rootRef}>
        <div className="mobile-term-bar">
          <span className="mobile-term-title">
            {info ? `${info.projectName} · ${info.label}` : 'Connecting…'}
          </span>
          <span className={`mobile-term-badge badge-${approval === 'denied' ? 'error' : 'connecting'}`}>
            {approval === 'denied' ? 'denied' : 'waiting'}
          </span>
        </div>
        <div className="mobile-term-empty">
          {approval === 'denied' ? (
            <span>
              Access denied on the desktop.
              <br />
              Ask the person at the computer to allow this phone, then reload.
            </span>
          ) : (
            <span className="mobile-term-waiting">
              Waiting for approval…
              <br />
              Press <strong>Allow</strong> in the share window on the desktop.
            </span>
          )}
        </div>
      </div>
    );
  }

  return (
    <div className="mobile-term" ref={rootRef}>
      <div className="mobile-term-bar">
        <span className="mobile-term-title">{info ? `${info.projectName} · ${info.label}` : 'Connecting…'}</span>
        <span className={`mobile-term-badge badge-${status}`}>{!canInput ? 'view-only' : status}</span>
      </div>
      <div className="mobile-term-surface" ref={containerRef} onClick={() => termRef.current?.focus()} />
      {canInput && (
        <div className="mobile-keybar" role="toolbar" aria-label="Terminal keys">
          <button onClick={() => sendKey('\x1b')}>Esc</button>
          <button onClick={() => sendKey('\t')}>Tab</button>
          <button onClick={() => sendKey('\x03')}>Ctrl-C</button>
          <button onClick={() => sendKey('\x1b[A')} aria-label="Up">↑</button>
          <button onClick={() => sendKey('\x1b[B')} aria-label="Down">↓</button>
          <button onClick={() => sendKey('\x1b[D')} aria-label="Left">←</button>
          <button onClick={() => sendKey('\x1b[C')} aria-label="Right">→</button>
          <button
            onClick={fitToPhone}
            title="Resize the terminal to fit this phone (the desktop view follows)"
          >
            Fit
          </button>
        </div>
      )}
    </div>
  );
}
