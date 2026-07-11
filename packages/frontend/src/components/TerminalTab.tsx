import { useEffect, useRef } from 'react';
import { Terminal, type IDisposable } from '@xterm/xterm';
import { FitAddon } from '@xterm/addon-fit';
import { api, runWsUrl } from '../api';
import { normalizeStatus } from '../lib/runStatus';
import { pulseActivity } from '../lib/activityBus';
import { clearRunActivity, feedRunOutput } from '../lib/runActivity';
import type { ActiveRun, RunStatus } from '../types';

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
  // Detach this terminal into its own desktop window. Only supplied by the main
  // app window when running under the Electron shell — omitted in a pop-out
  // window (no re-detaching) and in the browser (no window to open).
  onPopOut?: (runId: string) => void;
}

// Quiet period after the last output byte before we call the run "idle"/done.
// Must span Claude's mid-response pauses (tool calls / thinking) so we don't
// fire a premature "task done" while it's still working — hence a few seconds,
// not sub-second.
const IDLE_MS = 5000;

interface ServerMessage {
  type: 'data' | 'exit' | 'error';
  chunk?: string;
  status?: string;
  exitCode?: number | null;
  message?: string;
}

export function TerminalTab({ run, onStatus, onRestart, onContinue, onActivity, onPopOut }: Props) {
  const containerRef = useRef<HTMLDivElement>(null);
  const termRef = useRef<Terminal | null>(null);
  const fitRef = useRef<FitAddon | null>(null);

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
    let onCtxMenu: ((e: MouseEvent) => void) | null = null;

    // Output-activity tracking for the "working" indicator + "task done" toast.
    let working = false;
    let pendingTask = false; // user sent input since the last idle → next idle is a task
    let idleTimer: ReturnType<typeof setTimeout> | null = null;
    // For elevated shells: the liveness poll timer while awaiting UAC + broker.
    let pollTimer: ReturnType<typeof setTimeout> | null = null;
    const goIdle = () => {
      idleTimer = null;
      if (!working) return;
      working = false;
      const wasTask = pendingTask;
      pendingTask = false;
      if (!disposed) onActivity?.(run.runId, false, wasTask);
    };
    const bumpActivity = () => {
      if (!working) {
        working = true;
        if (!disposed) onActivity?.(run.runId, true, false);
      }
      if (idleTimer) clearTimeout(idleTimer);
      idleTimer = setTimeout(goIdle, IDLE_MS);
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
        fontFamily: 'Menlo, Consolas, "DejaVu Sans Mono", monospace',
        fontSize: 13,
        scrollback: 5000,
        // rightClickSelectsWord makes a bare right-click grab the word under the
        // cursor; we drive copy/paste from the context menu instead, so keep off.
        theme: {
          background: '#050506',
          foreground: '#e8e8ee',
          cursor: '#ff2d3c',
          selectionBackground: '#ff2d3c55', // visible drag-selection highlight
        },
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
        safeFit();
      }

      // --- clipboard: copy the xterm selection (which is NOT a native DOM
      // selection, so the browser's own Ctrl+C copies nothing) and paste. ---
      const copySelection = (): boolean => {
        const sel = t.getSelection();
        if (!sel) return false;
        void navigator.clipboard?.writeText(sel).catch(() => {
          /* clipboard write blocked — nothing else we can do */
        });
        return true;
      };
      const pasteClipboard = () => {
        navigator.clipboard
          ?.readText()
          .then((text) => {
            if (text) t.paste(text);
          })
          .catch(() => {
            /* read blocked (fall back to native Ctrl+V, which xterm handles) */
          });
      };

      const isMac = navigator.userAgent.toLowerCase().includes('mac');
      t.attachCustomKeyEventHandler((e) => {
        if (e.type !== 'keydown') return true;
        const k = e.key.toLowerCase();
        // macOS: Cmd+C / Cmd+V are copy/paste unconditionally.
        if (isMac && e.metaKey && !e.ctrlKey) {
          if (k === 'c' && copySelection()) return false;
          if (k === 'v') {
            pasteClipboard();
            return false;
          }
          return true;
        }
        if (e.ctrlKey) {
          // Ctrl+Shift+C / Ctrl+Shift+V — explicit copy/paste (never SIGINT).
          if (e.shiftKey && k === 'c') {
            copySelection();
            return false;
          }
          if (e.shiftKey && k === 'v') {
            pasteClipboard();
            return false;
          }
          // Ctrl+C — copy the selection if there is one, else let ^C (SIGINT)
          // through to the process.
          if (!e.shiftKey && k === 'c' && t.hasSelection()) {
            copySelection();
            t.clearSelection();
            return false;
          }
          // Ctrl+V (no shift) — leave it to xterm's native paste event.
        }
        return true;
      });

      if (container) {
        // Right-click: copy the selection if any, otherwise paste. Classic
        // terminal behaviour, and the discoverable path for mouse-only users.
        onCtxMenu = (e: MouseEvent) => {
          e.preventDefault();
          if (t.hasSelection()) {
            copySelection();
            t.clearSelection();
          } else {
            pasteClipboard();
          }
        };
        container.addEventListener('contextmenu', onCtxMenu);
      }

      const openSocket = () => {
        if (disposed) return;
        const socket = new WebSocket(runWsUrl(run.runId));
        ws = socket;
        // The backend replays the whole scrollback as one data message on
        // (re)connect. Don't parse that backlog as "current work" — it would
        // flash a stale live-process card. Only live chunks after it count.
        let sawBacklog = false;

        const sendResize = () => {
          if (socket.readyState === WebSocket.OPEN) {
            socket.send(JSON.stringify({ type: 'resize', cols: t.cols, rows: t.rows }));
          }
        };

        socket.onopen = () => {
          onStatus(run.runId, 'running', null);
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
            pulseActivity(msg.chunk.length); // feed the global header activity wave
            if (sawBacklog) {
              feedRunOutput(run.runId, msg.chunk); // feed the dashboard live-process cards
            } else {
              sawBacklog = true; // first message = replayed history, skip it
            }
          } else if (msg.type === 'exit') {
            gotExit = true;
            clearRunActivity(run.runId); // process ended → drop its live card
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
            clearRunActivity(run.runId); // process errored → drop its live card
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

        onWinResize = () => {
          safeFit();
          sendResize();
        };
        window.addEventListener('resize', onWinResize);

        // Refit when the container becomes visible / changes size (tab switch).
        ro = new ResizeObserver(() => {
          safeFit();
          sendResize();
        });
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
      clearRunActivity(run.runId); // tab removed (run closed) → drop its live card
      if (pollTimer) clearTimeout(pollTimer);
      if (idleTimer) clearTimeout(idleTimer);
      if (working) onActivity?.(run.runId, false, false); // tab unmounting → clear working
      if (onWinResize) window.removeEventListener('resize', onWinResize);
      if (onCtxMenu && containerRef.current) containerRef.current.removeEventListener('contextmenu', onCtxMenu);
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
          {run.elevated ? '🛡 ' : ''}
          {run.kind === 'shell' ? '⌨ ' : run.kind === 'claude' ? '✦ ' : ''}
          {run.projectName} · {run.customLabel ?? run.label}
        </span>
        <span className={`badge badge-${run.status}`}>
          {run.status}
          {run.exitCode != null ? ` (${run.exitCode})` : ''}
        </span>
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
        {stoppable ? (
          <button className="btn btn-danger term-action" onClick={stop}>
            Stop
          </button>
        ) : (
          <>
            {run.kind === 'claude' && onContinue && (
              <button
                className="btn btn-claude term-action"
                title="Resume the last Claude conversation in this project (claude --continue)"
                onClick={() => onContinue(run.runId)}
              >
                ✦ Continue
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
}
