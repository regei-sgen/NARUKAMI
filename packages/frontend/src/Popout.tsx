import { useCallback, useEffect, useState } from 'react';
import { api } from './api';
import { TerminalTab } from './components/TerminalTab';
import { desktop } from './lib/desktop';
import type { ActiveRun, RunStatus } from './types';

// A single terminal detached into its own desktop window (loaded with
// `?popout=<runId>`). The pty lives server-side, so this window just rebuilds
// the run's metadata from the workspace and mounts one TerminalTab full-window;
// the terminal reconnects its websocket and replays scrollback on open.
export function Popout({ runId }: { runId: string }) {
  const [run, setRun] = useState<ActiveRun | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      try {
        const ws = await api.getWorkspace();
        if (cancelled) return;
        const r = ws.runs.find((x) => x.runId === runId);
        if (!r) {
          setError('This terminal is no longer open.');
          return;
        }
        setRun({
          runId: r.runId,
          projectId: r.projectId,
          projectName: r.projectName,
          label: r.label,
          customLabel: r.name ?? undefined,
          kind: r.kind,
          status: 'connecting', // TerminalTab reconnects → live resumes, dead replays history
          exitCode: null,
        });
        document.title = `${r.projectName} · ${r.name ?? r.label} — NARUKAMI`;
      } catch (e) {
        if (!cancelled) setError((e as Error).message);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [runId]);

  const onStatus = useCallback((_id: string, status: RunStatus, exitCode: number | null) => {
    setRun((cur) => (cur ? { ...cur, status, exitCode } : cur));
  }, []);

  // Restart/continue re-key the run server-side; follow the new runId locally so
  // the detached window keeps driving the same tab.
  const onRestart = useCallback(
    async (oldRunId: string, resume = false) => {
      try {
        const r = await api.restartRun(oldRunId, resume);
        desktop()?.signalRunChanged(oldRunId, r.runId); // keep the shell's mapping current
        setRun((cur) =>
          cur
            ? {
                ...cur,
                runId: r.runId,
                label: r.label,
                customLabel: r.name ?? undefined,
                kind: r.kind,
                status: 'connecting',
                exitCode: null,
              }
            : cur,
        );
      } catch (e) {
        setError((e as Error).message);
      }
    },
    [],
  );

  if (error) {
    return <div className="popout-empty">{error}</div>;
  }
  if (!run) {
    return <div className="popout-empty">Connecting…</div>;
  }

  return (
    <div className="popout-app">
      <TerminalTab
        key={run.runId}
        run={run}
        onStatus={onStatus}
        onRestart={onRestart}
        onContinue={(id) => onRestart(id, true)}
      />
    </div>
  );
}
