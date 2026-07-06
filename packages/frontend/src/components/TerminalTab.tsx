import { useEffect, useRef } from 'react';
import { Terminal, type IDisposable } from '@xterm/xterm';
import { FitAddon } from '@xterm/addon-fit';
import { api, runWsUrl } from '../api';
import { normalizeStatus } from '../lib/runStatus';
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
}

// Quiet period after the last output byte before we call the run "idle"/done.
// Spans Claude's spinner-frame gaps; short enough to feel responsive.
const IDLE_MS = 2500;

interface ServerMessage {
  type: 'data' | 'exit' | 'error';
  chunk?: string;
  status?: string;
  exitCode?: number | null;
  message?: string;
}

export function TerminalTab({ run, onStatus, onRestart, onContinue, onActivity }: Props) {
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

    // Output-activity tracking for the "working" indicator + "task done" toast.
    let working = false;
    let pendingTask = false; // user sent input since the last idle → next idle is a task
    let idleTimer: ReturnType<typeof setTimeout> | null = null;
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
        safeFit();
      }

      const socket = new WebSocket(runWsUrl(run.runId));
      ws = socket;

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
        // Any user keystroke arms "a task is in progress" so the next idle edge
        // is reported as a completed task (booting/replay has no input → no toast).
        pendingTask = true;
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
    });

    return () => {
      disposed = true;
      cancelAnimationFrame(raf);
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
          {run.kind === 'shell' ? '⌨ ' : run.kind === 'claude' ? '✦ ' : ''}
          {run.projectName} · {run.customLabel ?? run.label}
        </span>
        <span className={`badge badge-${run.status}`}>
          {run.status}
          {run.exitCode != null ? ` (${run.exitCode})` : ''}
        </span>
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
