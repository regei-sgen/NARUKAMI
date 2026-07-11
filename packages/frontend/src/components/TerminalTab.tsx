import { memo, useCallback, useEffect, useRef, useState } from 'react';
import { Terminal, type IDisposable } from '@xterm/xterm';
import { FitAddon } from '@xterm/addon-fit';
import { WebglAddon } from '@xterm/addon-webgl';
import { api, runWsUrl } from '../api';
import { normalizeStatus } from '../lib/runStatus';
import { detectDevUrl, pushWindow } from '../lib/devUrl';
import type { ActiveRun, RunStatus } from '../types';
import { Ic } from './icons';

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
  // Claude tabs only: this project's Code Map embed flag (for the map toggle).
  codeMapEmbed?: boolean;
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
  type: 'data' | 'exit' | 'error' | 'ready';
  chunk?: string;
  status?: string;
  exitCode?: number | null;
  message?: string;
}

// Memoized: App re-renders on every activity edge / status flip / dock drag
// frame, and every open terminal would re-render with it. All props are stable
// (primitives, per-run object identity, useCallback handlers), so memo cuts
// that churn to the tabs whose run actually changed.
export const TerminalTab = memo(function TerminalTab({ run, onStatus, onRestart, onContinue, onActivity, codeMapEmbed }: Props) {
  const containerRef = useRef<HTMLDivElement>(null);
  const termRef = useRef<Terminal | null>(null);
  const fitRef = useRef<FitAddon | null>(null);
  // Detected local dev-server URL (command/shell runs) → the "Open" button.
  const urlWindowRef = useRef('');
  const [devUrl, setDevUrl] = useState<string | null>(null);

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

    // Output-activity tracking for the "working" indicator + "task done" toast.
    let working = false;
    let pendingTask = false; // user sent input since the last idle → next idle is a task
    let idleTimer: ReturnType<typeof setTimeout> | null = null;
    let lastOutputAt = 0;
    // rAF handle coalescing refit work (see scheduleFit below).
    let fitRaf = 0;
    // For elevated shells: the liveness poll timer while awaiting UAC + broker.
    let pollTimer: ReturnType<typeof setTimeout> | null = null;
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
        const socket = new WebSocket(runWsUrl(run.runId));
        ws = socket;

        // Only tell the pty about a resize when the grid actually changed:
        // ConPTY re-lays-out its whole buffer on every resize, so the
        // pixel-level ResizeObserver storm during a dock drag must not reach it.
        let lastCols = 0;
        let lastRows = 0;
        const sendResize = () => {
          if (socket.readyState !== WebSocket.OPEN) return;
          if (t.cols === lastCols && t.rows === lastRows) return;
          lastCols = t.cols;
          lastRows = t.rows;
          socket.send(JSON.stringify({ type: 'resize', cols: t.cols, rows: t.rows }));
        };

        socket.onopen = () => {
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
            // Cheap dev-server URL sniffing (claude output is not a server's).
            if (run.kind !== 'claude') {
              urlWindowRef.current = pushWindow(urlWindowRef.current, msg.chunk);
              if (msg.chunk.includes('http')) {
                const found = detectDevUrl(urlWindowRef.current);
                if (found) setDevUrl((prev) => (prev === found ? prev : found));
              }
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

        socket.onerror = () => {
          if (!disposed) t.write('\r\n\x1b[31m[websocket error — is the backend running?]\x1b[0m\r\n');
        };

        // An abnormal close (backend crash/restart) never sends an exit message —
        // surface it so the tab doesn't stay stuck 'running' forever.
        socket.onclose = () => {
          if (!disposed && !gotExit) onStatus(run.runId, 'error', null);
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
      if (pollTimer) clearTimeout(pollTimer);
      if (idleTimer) clearTimeout(idleTimer);
      if (working) onActivity?.(run.runId, false, false); // tab unmounting → clear working
      if (onWinResize) window.removeEventListener('resize', onWinResize);
      if (ro) ro.disconnect();
      if (dataDisposable) dataDisposable.dispose();
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

  const stop = async () => {
    try {
      await api.stopRun(run.runId);
    } catch {
      /* ignore — status will update via the exit message if it lands */
    }
  };

  const stoppable = run.status === 'running' || run.status === 'connecting';

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
        {run.kind === 'claude' && (
          <ClaudeToggles run={run} codeMapEmbed={codeMapEmbed ?? false} />
        )}
        {stoppable ? (
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
    </div>
  );
});
