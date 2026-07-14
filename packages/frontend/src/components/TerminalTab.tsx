import { memo, useCallback, useEffect, useRef, useState } from 'react';
import { Terminal, type IDisposable } from '@xterm/xterm';
import { FitAddon } from '@xterm/addon-fit';
import { WebglAddon } from '@xterm/addon-webgl';
import { api, runWsUrl } from '../api';
import { onWindowVisibility, windowHidden } from '../lib/visibility';
import { normalizeStatus } from '../lib/runStatus';
import { scanForMarker } from '../lib/wrapupMarker';
import { nextReconnectAction, type ReconnectAction } from '../lib/reconnect';
import { detectDevUrl, pushWindow } from '../lib/devUrl';
import type { ActiveRun, MobileDeviceInfo, RunStatus } from '../types';
import { Ic } from './icons';
import { ShareQrModal } from './ShareQrModal';

// The forced wrap-up gate (claude tabs only). While a run is being wrapped up,
// `wrapupPhase` is non-null and the tab's own Stop/close is replaced by the
// wrap-up affordances: an indicator while the injected prompt runs, then a
// "Close now" once the completion marker is seen. `pending` = injected, not yet
// seen working; `working` = seen working after inject; `ready` = marker seen.
export type WrapupPhase = 'pending' | 'working' | 'ready';

// A one-shot request to inject a submitted line into THIS run's pty over the
// existing ws input channel. `nonce` changes per request so the effect refires.
export interface InjectSignal {
  text: string; // the prompt line (submitted by a separate, delayed \r)
  nonce: number;
}

// The injected wrap-up prompt asks the session to print this exact line ONLY when
// the wrap-up (log consolidation + memory) is genuinely finished. The gate reaches
// "Close now" solely on seeing this in the session's OUTPUT — never on a mere
// idle, which fires early.
export const WRAPUP_DONE_MARKER = '<<NARUKAMI:WRAPUP-DONE>>';

interface Props {
  run: ActiveRun;
  onStatus: (runId: string, status: RunStatus, exitCode: number | null) => void;
  onRestart: (runId: string) => void;
  // Claude tabs only: resume the last conversation instead of a fresh session.
  onContinue?: (runId: string) => void;
  // Output-activity signal. `working` toggles while the pty is/ isn't streaming
  // output; `taskDone` is true on the working→idle edge IF the user had sent
  // input since the last idle (so booting/replay doesn't count as a task).
  onActivity?: (runId: string, working: boolean, taskDone: boolean) => void;
  // Fires when a dev-server URL is detected in this run's output (command/shell
  // runs only) — lets App feed the Browser view's per-project default URL.
  onDevUrl?: (runId: string, url: string) => void;
  // Claude tabs only: this project's Code Map embed flag (for the map toggle).
  codeMapEmbed?: boolean;
  // Detach this terminal into its own desktop window. Only supplied by the main
  // app window when running under the Electron shell — omitted in a pop-out
  // window (no re-detaching) and in the browser (no window to open).
  onPopOut?: (runId: string) => void;
  // Forced wrap-up gate (claude tabs). Stop delegates to onRequestWrapup instead
  // of killing immediately; while wrapupPhase is set the tab shows the gate UI.
  onRequestWrapup?: (runId: string) => void;
  wrapupPhase?: WrapupPhase | null;
  onWrapupClose?: (runId: string) => void; // "Close now" — respects Stop/close origin
  onWrapupForceClose?: (runId: string) => void; // always-available safety valve
  injectSignal?: InjectSignal | null; // one-shot pty injection for this run
  onWrapupComplete?: (runId: string) => void; // fired when the injected wrap-up prints its done-marker
}

/**
 * Claude-tab toolbar toggles: per-session embedded-godclaude activation ("god",
 * default ON — a session with no overlay inherits the globally armed layer) and
 * the project's Code Map embed ("map", default OFF; attaches at launch, so a
 * flip applies on the next Restart/Continue). The session id comes from the Run
 * row (fetched once — restored tabs don't carry it in props).
 */
function ClaudeToggles({ run, codeMapEmbed }: { run: ActiveRun; codeMapEmbed: boolean }) {
  const [sessionId, setSessionId] = useState<string | null>(null);
  const [godInstalled, setGodInstalled] = useState(false);
  const [godOn, setGodOn] = useState(false);
  const [mapOn, setMapOn] = useState(codeMapEmbed);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    let gone = false;
    void (async () => {
      try {
        const info = await api.getRun(run.runId);
        const sid = (info as { claudeSessionId?: string | null }).claudeSessionId;
        if (gone || !sid) return;
        setSessionId(sid);
        const state = await api.godSessionState(sid);
        if (gone) return;
        setGodInstalled(state.installed);
        setGodOn(state.active);
      } catch {
        /* toggles stay hidden/off */
      }
    })();
    return () => {
      gone = true;
    };
  }, [run.runId]);

  const toggleGod = useCallback(async () => {
    if (!sessionId) return;
    setBusy(true);
    try {
      const res = await api.godArmSession(sessionId, !godOn);
      setGodOn(res.active);
    } catch {
      /* keep prior state */
    } finally {
      setBusy(false);
    }
  }, [sessionId, godOn]);

  const toggleMap = useCallback(async () => {
    setBusy(true);
    try {
      const res = await api.setCodeMapEmbed(run.projectId, !mapOn);
      setMapOn(res.codeMapEmbed);
    } catch {
      /* keep prior state */
    } finally {
      setBusy(false);
    }
  }, [run.projectId, mapOn]);

  return (
    <span className="term-toggles">
      {godInstalled && sessionId && (
        <button
          className={`term-toggle ${godOn ? 'on' : ''}`}
          disabled={busy}
          title={
            godOn
              ? 'GODCLAUDE active for this session (embedded layer) — click to switch this session off; takes effect next turn'
              : 'GODCLAUDE off for this session — click to activate; takes effect next turn'
          }
          onClick={() => void toggleGod()}
        >
          <Ic name="bolt" /> god
        </button>
      )}
      <button
        className={`term-toggle ${mapOn ? 'on' : ''}`}
        disabled={busy}
        title={
          (mapOn
            ? 'Code Map embedded in this project\'s Claude sessions — click to disable'
            : 'Code Map not embedded — click to enable') +
          ' (attaches at launch: applies on next Restart/Continue)'
        }
        onClick={() => void toggleMap()}
      >
        <Ic name="hex" /> map
      </button>
    </span>
  );
}

// Quiet period after the last output byte before we call the run "idle"/done.
// Must span Claude's mid-response pauses (tool calls / thinking) so we don't
// fire a premature "task done" while it's still working — hence a few seconds,
// not sub-second.
const IDLE_MS = 5000;

interface ServerMessage {
  type: 'data' | 'exit' | 'error' | 'ready' | 'resize' | 'device';
  chunk?: string;
  status?: string;
  exitCode?: number | null;
  message?: string;
  // 'resize': another client (e.g. a phone) changed the shared pty grid.
  cols?: number;
  rows?: number;
  // 'device': a phone knocked on / connected to / left this run's share.
  event?: string;
  device?: MobileDeviceInfo;
}

// Memoized: App re-renders on every activity edge / status flip / dock drag
// frame, and every open terminal would re-render with it. All props are stable
// (primitives, per-run object identity, useCallback handlers), so memo cuts
// that churn to the tabs whose run actually changed.
export const TerminalTab = memo(function TerminalTab({ run, onStatus, onRestart, onContinue, onActivity, onDevUrl, codeMapEmbed, onPopOut, onRequestWrapup, wrapupPhase, onWrapupClose, onWrapupForceClose, injectSignal, onWrapupComplete }: Props) {
  const containerRef = useRef<HTMLDivElement>(null);
  const termRef = useRef<Terminal | null>(null);
  const fitRef = useRef<FitAddon | null>(null);
  // Live ws handle, exposed to the injection effect (below) so the wrap-up prompt
  // can be sent over the SAME input channel keystrokes use. Null between mounts.
  const wsRef = useRef<WebSocket | null>(null);
  // Guards against a double-send of the same injection (React StrictMode mounts
  // the effect twice in dev; a re-render must not re-inject the same nonce).
  const lastInjectedNonce = useRef<number | null>(null);
  // Wrap-up completion detection: after injecting the wrap-up prompt we watch the
  // pty OUTPUT for WRAPUP_DONE_MARKER. wrapInjectAt gates a grace window that skips
  // the prompt's own input echo; wrapFired makes it one-shot; wrapCarry stitches a
  // marker split across two chunks. onWrapupComplete via a ref (the ws.onmessage
  // closure is created once at mount and would otherwise capture a stale prop).
  const wrapInjectAtRef = useRef(0);
  const wrapFiredRef = useRef(false);
  const wrapCarryRef = useRef('');
  const onWrapupCompleteRef = useRef(onWrapupComplete);
  onWrapupCompleteRef.current = onWrapupComplete;
  // Detected local dev-server URL (command/shell runs) → the "Open" button.
  const urlWindowRef = useRef('');
  const [devUrl, setDevUrl] = useState<string | null>(null);
  // Mobile-share QR modal (open per terminal).
  const [sharing, setSharing] = useState(false);
  // Phones seen on this run's share (pushed over the ws) → toolbar indicator.
  const [devices, setDevices] = useState<Record<string, MobileDeviceInfo>>({});

  useEffect(() => {
    let disposed = false;
    // True once the server reports the run ended (exit/error). Keeps the ws
    // close handler from overwriting the real terminal status with 'error'.
    let gotExit = false;

    let term: Terminal | null = null;
    let ws: WebSocket | null = null;
    let ro: ResizeObserver | null = null;
    let dataDisposable: IDisposable | null = null;
    let onWinResize: (() => void) | null = null;
    let onContextMenu: ((ev: MouseEvent) => void) | null = null;
    let offVisibility: (() => void) | null = null;

    // Output-activity tracking for the "working" indicator + "task done" toast.
    let working = false;
    let pendingTask = false; // user sent input since the last idle → next idle is a task
    let idleTimer: ReturnType<typeof setTimeout> | null = null;
    let lastOutputAt = 0;
    // rAF handle coalescing refit work (see scheduleFit below).
    let fitRaf = 0;
    // Trailing-debounce timer for pty resize notifications (see sendResize).
    let resizeDebounce: ReturnType<typeof setTimeout> | null = null;
    // For elevated shells: the liveness poll timer while awaiting UAC + broker.
    // Also reused to schedule reconnect attempts after a dropped socket.
    let pollTimer: ReturnType<typeof setTimeout> | null = null;
    // Auto-reconnect: a dropped websocket does NOT kill the server-side pty, so
    // rather than stranding the tab in 'error' we poll liveness and reattach.
    // `isReconnect` makes the next open reset the terminal before the backend
    // replays scrollback, so history isn't printed twice.
    let reconnectAttempts = 0;
    let isReconnect = false;
    // Idle detection without per-chunk timer churn: output only stamps
    // lastOutputAt; ONE timer re-arms itself for the remaining quiet gap when it
    // wakes early. Under heavy streaming this replaces a clearTimeout+setTimeout
    // pair per message with a plain assignment.
    const goIdle = () => {
      const remaining = lastOutputAt + IDLE_MS - Date.now();
      if (remaining > 0) {
        idleTimer = setTimeout(goIdle, remaining);
        return;
      }
      idleTimer = null;
      if (!working) return;
      working = false;
      const wasTask = pendingTask;
      pendingTask = false;
      if (!disposed) onActivity?.(run.runId, false, wasTask);
    };
    const bumpActivity = () => {
      lastOutputAt = Date.now();
      if (!working) {
        working = true;
        if (!disposed) onActivity?.(run.runId, true, false);
      }
      if (!idleTimer) idleTimer = setTimeout(goIdle, IDLE_MS);
    };

    // Defer creation one frame. Under React StrictMode the effect is mounted,
    // cleaned up, then remounted synchronously; cancelling the frame on that
    // throwaway cleanup means we never build (and immediately dispose) a
    // terminal whose internal viewport rAF would then fire on a dead instance.
    const raf = requestAnimationFrame(() => {
      if (disposed) return;
      const container = containerRef.current;

      const t = new Terminal({
        cursorBlink: true,
        // The Windows Terminal face (Cascadia Mono ships with Windows 10/11).
        fontFamily: '"Cascadia Mono", Consolas, monospace',
        fontSize: 14,
        scrollback: 5000,
        theme: { background: '#050506', foreground: '#e8e8ee', cursor: '#ff2d3c' },
      });
      const fit = new FitAddon();
      t.loadAddon(fit);
      term = t;
      termRef.current = t;
      fitRef.current = fit;

      // Cursor blink repaints the terminal twice a second forever; with
      // backgroundThrottling:false that continues while minimized. Follow the
      // real window visibility instead (output rendering is unaffected — only
      // the blink pauses).
      t.options.cursorBlink = !windowHidden();
      offVisibility = onWindowVisibility((hidden) => {
        t.options.cursorBlink = !hidden;
      });

      // Clipboard keys. xterm maps plain Ctrl+V to the C0 byte \x16 and cancels
      // the browser event, so the native paste never reaches its textarea — a
      // dead shortcut in cmd/Claude tabs (PSReadLine's own ^V binding masked it
      // in PowerShell). Returning false hands the combo back to the browser,
      // whose paste event xterm forwards properly (bracketed-paste aware).
      t.attachCustomKeyEventHandler((ev) => {
        if (ev.type !== 'keydown') return true;
        const key = ev.key.toLowerCase();
        // Paste: Ctrl+V / Ctrl+Shift+V / Shift+Insert → browser default.
        if (ev.ctrlKey && !ev.altKey && key === 'v') return false;
        if (ev.shiftKey && !ev.ctrlKey && key === 'insert') return false;
        // Copy: Ctrl+Shift+C / Ctrl+Insert copy the selection (plain Ctrl+C
        // stays SIGINT — terminals must never lose it).
        if (((ev.ctrlKey && ev.shiftKey && key === 'c') || (ev.ctrlKey && key === 'insert')) && t.hasSelection()) {
          void navigator.clipboard?.writeText(t.getSelection()).catch(() => undefined);
          return false;
        }
        return true;
      });

      // Only fit a laid-out element; fit() on a zero-size (hidden) tab corrupts
      // xterm's render dimensions and throws later in the viewport scroll sync.
      const safeFit = () => {
        if (disposed || !container) return;
        if (container.clientWidth <= 0 || container.clientHeight <= 0) return;
        try {
          fit.fit();
        } catch {
          /* noop */
        }
      };

      if (container) {
        // conhost-style right-click (Windows terminal muscle memory): copy the
        // selection if there is one, otherwise paste the clipboard. There is no
        // native context menu on the xterm surface, so right-click was dead.
        onContextMenu = (ev: MouseEvent) => {
          ev.preventDefault();
          if (t.hasSelection()) {
            void navigator.clipboard?.writeText(t.getSelection()).catch(() => undefined);
            t.clearSelection();
            return;
          }
          void navigator.clipboard
            ?.readText()
            .then((text) => {
              if (text) t.paste(text);
            })
            .catch(() => undefined); // permission denied → do nothing
        };
        container.addEventListener('contextmenu', onContextMenu);
        t.open(container);
        // GPU renderer: the default DOM renderer re-lays-out entire rows on
        // every write and is what makes several busy shells stutter. WebGL must
        // load after open(); if the context can't be created (GPU blocklist) or
        // is later evicted (browser context-limit pressure with many tabs),
        // dispose() falls back to the DOM renderer transparently.
        try {
          const webgl = new WebglAddon();
          webgl.onContextLoss(() => webgl.dispose());
          t.loadAddon(webgl);
        } catch {
          /* DOM renderer fallback */
        }
        safeFit();
      }

      const openSocket = () => {
        if (disposed) return;
        // Tear down the previous connection's per-socket listeners so reconnects
        // don't stack duplicate handlers/observers.
        if (dataDisposable) {
          dataDisposable.dispose();
          dataDisposable = null;
        }
        if (onWinResize) {
          window.removeEventListener('resize', onWinResize);
          onWinResize = null;
        }
        if (ro) {
          ro.disconnect();
          ro = null;
        }
        if (resizeDebounce) {
          clearTimeout(resizeDebounce); // never push a stale grid on a dead socket
          resizeDebounce = null;
        }
        const socket = new WebSocket(runWsUrl(run.runId));
        ws = socket;
        wsRef.current = socket;

        // Only tell the pty about a resize when the grid actually changed:
        // ConPTY re-lays-out its whole buffer on every resize, so the
        // pixel-level ResizeObserver storm during a dock drag must not reach it.
        // `lastCols/lastRows` track the pty's grid as WE know it — updated when
        // we notify it AND when the server broadcasts another client's resize.
        let lastCols = 0;
        let lastRows = 0;
        let lastPtySendAt = 0;
        const pushResize = () => {
          resizeDebounce = null;
          if (socket.readyState !== WebSocket.OPEN) return;
          if (t.cols === lastCols && t.rows === lastRows) return;
          lastCols = t.cols;
          lastRows = t.rows;
          lastPtySendAt = Date.now();
          socket.send(JSON.stringify({ type: 'resize', cols: t.cols, rows: t.rows }));
        };
        // Leading + trailing: a lone refit (tab switch, maximize, open) reaches
        // the pty immediately, but a dock-drag storm coalesces into one reflow
        // shortly after the drag settles — ConPTY re-lays-out its whole buffer
        // per resize, and a reflow per pointer-move garbles the repaint (the
        // xterm grid itself still tracks every frame via safeFit).
        const sendResize = () => {
          if (t.cols === lastCols && t.rows === lastRows) return;
          if (resizeDebounce) clearTimeout(resizeDebounce);
          if (Date.now() - lastPtySendAt > 350) {
            pushResize();
            return;
          }
          resizeDebounce = setTimeout(pushResize, 150);
        };

        socket.onopen = () => {
          // On a reconnect the backend replays the full scrollback as the first
          // message — clear first so it repaints instead of duplicating.
          if (isReconnect) {
            t.reset();
            isReconnect = false;
          }
          reconnectAttempts = 0;
          // Don't assume 'running' on open: a dead/restored run reaches the
          // server's replay path and gets an 'exit' (never 'ready'), so setting
          // running here flashed it briefly before correcting. Wait for the
          // explicit 'ready' (run is actually live) message below instead.
          sendResize();
        };

        dataDisposable = t.onData((data) => {
          // Arm "a task is in progress" only on a SUBMIT (Enter/carriage-return),
          // not on every keystroke. Otherwise arrow keys, tab-completion, Ctrl-C,
          // scrolling, or a bare Enter would each arm a false "task done" toast on
          // the next output pause. Booting/replay has no input → no toast.
          if (data.includes('\r') || data.includes('\n')) pendingTask = true;
          if (socket.readyState === WebSocket.OPEN) {
            socket.send(JSON.stringify({ type: 'input', data }));
          }
        });

        socket.onmessage = (ev) => {
          if (disposed) return;
          let msg: ServerMessage;
          try {
            msg = JSON.parse(ev.data as string) as ServerMessage;
          } catch {
            return;
          }
          if (msg.type === 'data' && typeof msg.chunk === 'string') {
            t.write(msg.chunk);
            bumpActivity();
            // Wrap-up completion: fire only on the marker appearing in OUTPUT, and only
            // after a 5s grace (skips the prompt's immediate input echo, which contains
            // the marker text). The literal marker has no ANSI inside it, so a raw scan
            // is safe; the scan's carry stitches a marker split across chunk boundaries.
            if (wrapInjectAtRef.current > 0 && !wrapFiredRef.current) {
              const scan = scanForMarker(wrapCarryRef.current, msg.chunk, WRAPUP_DONE_MARKER);
              if (Date.now() - wrapInjectAtRef.current > 5000 && scan.found) {
                wrapFiredRef.current = true;
                onWrapupCompleteRef.current?.(run.runId);
              }
              wrapCarryRef.current = scan.carry;
            }
            // Cheap dev-server URL sniffing (claude output is not a server's).
            if (run.kind !== 'claude') {
              urlWindowRef.current = pushWindow(urlWindowRef.current, msg.chunk);
              if (msg.chunk.includes('http')) {
                const found = detectDevUrl(urlWindowRef.current);
                if (found) {
                  setDevUrl((prev) => (prev === found ? prev : found));
                  onDevUrl?.(run.runId, found);
                }
              }
            }
          } else if (
            msg.type === 'resize' &&
            typeof msg.cols === 'number' &&
            typeof msg.rows === 'number'
          ) {
            // Another client (e.g. a phone that pressed "fit") resized the
            // shared pty — adopt the one true grid so this view doesn't render
            // mis-wrapped output. Record it as the pty's known size so we don't
            // echo it straight back; the next LOCAL adjustment reclaims the grid.
            const cols = Math.max(2, Math.min(500, Math.floor(msg.cols)));
            const rows = Math.max(1, Math.min(300, Math.floor(msg.rows)));
            lastCols = cols;
            lastRows = rows;
            if (t.cols !== cols || t.rows !== rows) t.resize(cols, rows);
          } else if (msg.type === 'device' && msg.device) {
            // Phone lifecycle on this run's share → the toolbar phone indicator.
            // 'removed' (the run's shares all died) deletes the entry — keeping
            // it around left permanent ghost "1 connected" badges.
            const d = msg.device;
            if (msg.event === 'removed') {
              setDevices((prev) => {
                if (!(d.deviceId in prev)) return prev;
                const next = { ...prev };
                delete next[d.deviceId];
                return next;
              });
            } else {
              setDevices((prev) => ({ ...prev, [d.deviceId]: d }));
            }
          } else if (msg.type === 'ready') {
            // Server confirmed the run is live — safe to show 'running'.
            onStatus(run.runId, 'running', null);
          } else if (msg.type === 'exit') {
            gotExit = true;
            if (idleTimer) clearTimeout(idleTimer);
            idleTimer = null;
            working = false;
            onActivity?.(run.runId, false, false); // process ended → finish-toast handles "done"
            const status = normalizeStatus(msg.status);
            onStatus(run.runId, status, msg.exitCode ?? null);
            // A hard-killed full-screen TUI (vim/htop) can't restore the terminal
            // itself — leave the alt buffer, re-show the cursor, and turn off mouse
            // tracking / bracketed paste so the tab isn't left on a frozen frame.
            t.write('\x1b[?1049l\x1b[?25h\x1b[?1000l\x1b[?1002l\x1b[?1006l\x1b[?2004l');
            const code = msg.exitCode != null ? ` — exit ${msg.exitCode}` : '';
            t.write(`\r\n\x1b[90m[process ${status}${code}]\x1b[0m\r\n`);
          } else if (msg.type === 'error') {
            gotExit = true;
            if (idleTimer) clearTimeout(idleTimer);
            idleTimer = null;
            working = false;
            onActivity?.(run.runId, false, false);
            onStatus(run.runId, 'error', null);
            t.write(`\r\n\x1b[31m[error] ${msg.message ?? 'unknown'}\x1b[0m\r\n`);
          }
        };

        // Let onclose drive recovery — errors are always followed by a close.
        socket.onerror = () => {};

        // An abnormal close (backend hiccup/restart, transient network) never
        // sends an exit message. The pty is still alive server-side, so try to
        // reconnect instead of stranding the tab in 'error'.
        socket.onclose = () => {
          if (disposed || gotExit) return;
          scheduleReconnect();
        };

        // Coalesce refits to one per frame: during a dock-resize drag the
        // ResizeObserver and window listener each fire per pointer move, and
        // every fit() forces a synchronous DOM measure. One rAF absorbs the
        // whole burst (sendResize above already ignores no-op grid sizes).
        const scheduleFit = () => {
          if (fitRaf) return;
          fitRaf = requestAnimationFrame(() => {
            fitRaf = 0;
            safeFit();
            sendResize();
          });
        };
        onWinResize = scheduleFit;
        window.addEventListener('resize', onWinResize);

        // Refit when the container becomes visible / changes size (tab switch).
        ro = new ResizeObserver(scheduleFit);
        if (container) ro.observe(container);
      };

      // Backoff schedule for reconnect attempts (ms). Caps out, then keeps
      // retrying at the last interval so a long backend restart still recovers.
      const RECONNECT_DELAYS = [250, 500, 1000, 1500, 2500, 4000];
      // After this many consecutive failures we assume the backend is really gone
      // and surface an error (the user can still Restart). Generous so ordinary
      // hiccups always self-heal silently.
      const MAX_RECONNECT = 40;

      const scheduleReconnect = () => {
        if (disposed || gotExit) return;
        onStatus(run.runId, 'connecting', null);
        const delay = RECONNECT_DELAYS[Math.min(reconnectAttempts, RECONNECT_DELAYS.length - 1)];
        reconnectAttempts += 1;
        if (pollTimer) clearTimeout(pollTimer);
        pollTimer = setTimeout(() => void tryReconnect(), delay);
      };

      const tryReconnect = async () => {
        if (disposed || gotExit) return;
        let action: ReconnectAction;
        try {
          const info = await api.getRun(run.runId);
          if (disposed || gotExit) return;
          action = nextReconnectAction(info, reconnectAttempts, MAX_RECONNECT);
          if (action.kind === 'reconnect') {
            isReconnect = true; // reset + repaint on the next open
            openSocket();
            return;
          }
          if (action.kind === 'settle') {
            // The process ended while we were disconnected — replay its final
            // history and settle on the real status (don't reconnect to a corpse).
            const hist = (info.logs ?? []).map((l) => l.chunk).join('');
            t.reset();
            if (hist) t.write(hist);
            gotExit = true;
            onStatus(run.runId, action.status, action.exitCode);
            return;
          }
        } catch {
          // Backend momentarily unreachable — retry until the cap, then give up.
          action = reconnectAttempts >= MAX_RECONNECT ? { kind: 'giveup' } : { kind: 'retry' };
        }
        if (action.kind === 'giveup') {
          onStatus(run.runId, 'error', null);
          t.write('\r\n\x1b[31m[disconnected — Restart to reconnect]\x1b[0m\r\n');
          return;
        }
        scheduleReconnect();
      };

      // An elevated (admin) shell isn't live until the broker connects back after
      // the UAC prompt. Streaming before then would make the ws slow-path report a
      // premature exit — so poll liveness first and only open the socket once live.
      if (run.pending) {
        t.write(
          '\x1b[90m⏳ Waiting for Administrator elevation — approve the UAC prompt…\x1b[0m\r\n',
        );
        const poll = async () => {
          if (disposed) return;
          try {
            const info = await api.getRun(run.runId);
            if (disposed) return;
            if (info.live) {
              openSocket();
              return;
            }
            const s = info.status;
            if (s && s !== 'running' && s !== 'connecting') {
              // Errored/ended before going live (UAC cancelled or timed out).
              const hist = (info.logs ?? []).map((l) => l.chunk).join('');
              if (hist) t.write(hist);
              gotExit = true;
              onStatus(run.runId, normalizeStatus(s), info.exitCode ?? null);
              return;
            }
          } catch {
            /* transient — keep polling */
          }
          pollTimer = setTimeout(poll, 800);
        };
        void poll();
      } else {
        openSocket();
      }
    });

    return () => {
      disposed = true;
      cancelAnimationFrame(raf);
      if (fitRaf) cancelAnimationFrame(fitRaf);
      if (resizeDebounce) clearTimeout(resizeDebounce);
      if (pollTimer) clearTimeout(pollTimer);
      if (idleTimer) clearTimeout(idleTimer);
      if (working) onActivity?.(run.runId, false, false); // tab unmounting → clear working
      if (offVisibility) offVisibility();
      if (onWinResize) window.removeEventListener('resize', onWinResize);
      if (onContextMenu) containerRef.current?.removeEventListener('contextmenu', onContextMenu);
      if (ro) ro.disconnect();
      if (dataDisposable) dataDisposable.dispose();
      wsRef.current = null;
      if (ws) {
        try {
          ws.close();
        } catch {
          /* noop */
        }
      }
      if (term) term.dispose();
    };
    // Re-create everything only when the run identity changes.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [run.runId]);

  // Inject the wrap-up prompt into the pty over the SAME input frame keystrokes use
  // ({type:'input',data}). CRITICAL: send the prompt text FIRST, then Enter as a SEPARATE,
  // slightly-delayed keystroke. A trailing \r glued onto the text frame is swallowed by the
  // CLI's bracketed-paste handling — it lands as a literal newline in the input box instead
  // of submitting (the bug: the prompt got typed but never sent). A discrete CR after the
  // paste settles actually submits it. Fail-soft throughout; the Force-close valve still
  // lets the user close a stuck tab if any send is skipped.
  useEffect(() => {
    const sig = injectSignal;
    if (!sig) return;
    if (lastInjectedNonce.current === sig.nonce) return;
    lastInjectedNonce.current = sig.nonce;
    // Arm wrap-up completion detection for the output scanner (above).
    wrapInjectAtRef.current = Date.now();
    wrapFiredRef.current = false;
    wrapCarryRef.current = '';
    const socket = wsRef.current;
    if (!socket || socket.readyState !== WebSocket.OPEN) return;
    const text = sig.text.replace(/[\r\n]+$/, ''); // paste the text without a trailing newline
    try {
      socket.send(JSON.stringify({ type: 'input', data: text }));
      window.setTimeout(() => {
        const s = wsRef.current;
        if (s && s.readyState === WebSocket.OPEN) {
          try {
            s.send(JSON.stringify({ type: 'input', data: '\r' }));
          } catch {
            /* fail-soft */
          }
        }
      }, 250);
    } catch {
      /* fail-soft — Force-close remains available */
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [injectSignal?.nonce]);

  const stop = async () => {
    // Claude tabs: don't kill immediately — run the forced wrap-up gate first.
    // Shell/command tabs keep the immediate stop.
    if (run.kind === 'claude' && onRequestWrapup) {
      onRequestWrapup(run.runId);
      return;
    }
    try {
      await api.stopRun(run.runId);
    } catch {
      /* ignore — status will update via the exit message if it lands */
    }
  };

  const stoppable = run.status === 'running' || run.status === 'connecting';
  // Phone share monitor (fed by ws 'device' pushes): live streams + knocks.
  const deviceList = Object.values(devices);
  const connectedPhones = deviceList.filter((d) => d.connections > 0).length;
  const pendingPhones = deviceList.filter((d) => d.state === 'pending').length;

  return (
    <div className="terminal-tab">
      <div className="terminal-toolbar">
        <span className="term-title">
          {run.elevated ? <><Ic name="shield" />{' '}</> : null}
          {run.kind === 'shell' ? (
            <>
              <Ic name="shell" />{' '}
            </>
          ) : run.kind === 'claude' ? (
            <>
              <Ic name="spark" />{' '}
            </>
          ) : null}
          {run.projectName} · {run.customLabel ?? run.label}
        </span>
        <span className={`badge badge-${run.status}`}>
          {run.status}
          {run.exitCode != null ? ` (${run.exitCode})` : ''}
        </span>
        {(connectedPhones > 0 || pendingPhones > 0) && (
          <button
            className={`term-devices${pendingPhones > 0 ? ' waiting' : ''}`}
            title={
              pendingPhones > 0
                ? `${pendingPhones} phone${pendingPhones > 1 ? 's' : ''} awaiting approval — click to review`
                : `${connectedPhones} phone${connectedPhones > 1 ? 's' : ''} connected — click to manage`
            }
            onClick={() => setSharing(true)}
          >
            <Ic name="qr" /> {pendingPhones > 0 ? `${pendingPhones} waiting` : connectedPhones}
          </button>
        )}
        {run.kind === 'claude' && (
          <ClaudeToggles run={run} codeMapEmbed={codeMapEmbed ?? false} />
        )}
        {onPopOut && (
          <button
            className="btn term-action term-popout"
            title="Open this terminal in its own window (drag it back to re-dock)"
            aria-label="Pop terminal out to its own window"
            onClick={() => onPopOut(run.runId)}
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
        {stoppable && (
          <button
            className="btn term-action term-share"
            title="Share this terminal to your phone via QR (same network)"
            aria-label="Share terminal to phone"
            onClick={() => setSharing(true)}
          >
            <Ic name="qr" /> Share
          </button>
        )}
        {wrapupPhase ? (
          <div className="wrapup-gate term-action">
            {wrapupPhase === 'ready' ? (
              <>
                <span className="wrapup-indicator done">✓ wrapped up</span>
                <button
                  className="btn btn-primary wrapup-close"
                  title="End this session now"
                  onClick={() => onWrapupClose?.(run.runId)}
                >
                  Close now
                </button>
              </>
            ) : (
              <span className="wrapup-indicator">
                <span className="wrapup-spinner" aria-hidden="true" />
                wrapping up — logging + memory…
              </span>
            )}
            <button
              className="btn btn-ghost wrapup-force"
              title="Close anyway, even if the session is stuck (the verdict was already recorded)"
              onClick={() => onWrapupForceClose?.(run.runId)}
            >
              Force close
            </button>
          </div>
        ) : stoppable ? (
          <>
            {run.kind !== 'claude' && devUrl && (
              <button
                className="btn term-action"
                title={`Open ${devUrl} in your default browser`}
                onClick={() => void api.openUrl(devUrl).catch(() => undefined)}
              >
                <Ic name="external" /> Open
              </button>
            )}
            {run.kind !== 'claude' && (
              <button
                className="btn btn-run term-action"
                title="Restart this process (stops it first — a dev server picks up config/code changes)"
                onClick={() => onRestart(run.runId)}
              >
                <Ic name="refresh" /> Restart
              </button>
            )}
            <button className="btn btn-danger term-action" onClick={stop}>
              Stop
            </button>
          </>
        ) : (
          <>
            {run.kind === 'claude' && onContinue && (
              <button
                className="btn btn-claude term-action"
                title="Resume the last Claude conversation in this project (claude --continue)"
                onClick={() => onContinue(run.runId)}
              >
                <Ic name="spark" /> Continue
              </button>
            )}
            <button
              className="btn btn-run term-action"
              title="Re-run this terminal (fresh process)"
              onClick={() => onRestart(run.runId)}
            >
              Restart
            </button>
          </>
        )}
      </div>
      <div className="terminal-surface" ref={containerRef} />
      {sharing && (
        <ShareQrModal
          runId={run.runId}
          label={run.customLabel ?? run.label}
          onClose={() => setSharing(false)}
        />
      )}
    </div>
  );
});
