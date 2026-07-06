import {
  type PointerEvent as ReactPointerEvent,
  useCallback,
  useEffect,
  useRef,
  useState,
} from 'react';
import { api, hasToken } from './api';
import type { ActiveRun, Project, RestoredRun, RunCommand, RunStatus, Toast, UiSettings } from './types';
import { ProjectSidebar } from './components/ProjectSidebar';
import { ProjectPanel } from './components/ProjectPanel';
import { CodeEditor } from './components/CodeEditor';
import { EodView } from './components/EodView';
import { TerminalTab } from './components/TerminalTab';
import { Toasts } from './components/Toasts';
import { finishToastFor, fireNativeNotification, primeNotifications, taskToast } from './lib/notify';

export default function App() {
  const [projects, setProjects] = useState<Project[]>([]);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [activeRuns, setActiveRuns] = useState<ActiveRun[]>([]);
  // Which terminal tab is focused, remembered PER project. Every run stays
  // mounted (see the term-stack below) so ptys survive project switches; this
  // only controls which one is visible for the currently selected project.
  const [activeTabByProject, setActiveTabByProject] = useState<Record<string, string>>({});
  const [view, setView] = useState<'runner' | 'editor' | 'eod'>('runner');
  // Terminal dock: docked bottom (resizable height) or right (resizable width),
  // plus minimize. All persisted server-side.
  const [dockPosition, setDockPosition] = useState<'bottom' | 'right'>('bottom');
  const [dockHeight, setDockHeight] = useState<number>(320);
  const [dockWidth, setDockWidth] = useState<number>(480);
  const [dockMinimized, setDockMinimized] = useState<boolean>(false);
  const [sidebarCollapsed, setSidebarCollapsed] = useState<boolean>(false);
  // Last-open editor file per project (restored on reopen).
  const [editorFileByProject, setEditorFileByProject] = useState<Record<string, string>>({});
  // Inline tab rename.
  const [renamingId, setRenamingId] = useState<string | null>(null);
  const [renameValue, setRenameValue] = useState('');
  const renameSkipBlur = useRef(false);
  const [error, setError] = useState<string | null>(null);
  // Finished-process notifications (click routes to the run's tab).
  const [toasts, setToasts] = useState<Toast[]>([]);
  // Runs currently producing output ("working") — drives the sidebar pulse.
  const [workingIds, setWorkingIds] = useState<Set<string>>(new Set());
  // Mirror of activeRuns for stable callbacks (activity/toast handlers).
  const activeRunsRef = useRef<ActiveRun[]>([]);
  const taskSeqRef = useRef(0);
  // Runs the user started THIS session — only these get a finish notification,
  // so restored (and already-dead-on-reconnect) tabs don't spam toasts on boot.
  const sessionRunsRef = useRef<Set<string>>(new Set());
  // Runs already notified — dedupe repeat terminal-status events per run.
  const notifiedRef = useRef<Set<string>>(new Set());
  const toastTimers = useRef<Record<string, ReturnType<typeof setTimeout>>>({});
  // Gate settings-persistence until after the initial workspace has been applied,
  // so restoring state doesn't immediately re-save (and clobber) it.
  const booted = useRef(false);

  const refresh = useCallback(async () => {
    try {
      const list = await api.listProjects();
      setProjects(list);
      setSelectedId((cur) => cur ?? list[0]?.id ?? null);
    } catch (e) {
      setError((e as Error).message);
    }
  }, []);

  // Ask once for OS-notification permission so backgrounded finishes can surface.
  useEffect(() => {
    primeNotifications();
  }, []);

  // Boot: load projects + the persisted workspace (open terminals + UI layout).
  useEffect(() => {
    void (async () => {
      let list: Project[] = [];
      try {
        list = await api.listProjects();
        setProjects(list);
      } catch (e) {
        setError((e as Error).message);
      }
      try {
        const ws = await api.getWorkspace();
        setActiveRuns(
          ws.runs.map((r) => ({
            runId: r.runId,
            projectId: r.projectId,
            projectName: r.projectName,
            label: r.label,
            customLabel: r.name ?? undefined,
            kind: r.kind,
            status: 'connecting', // TerminalTab reconnects → live resumes, dead replays history
            exitCode: null,
          })),
        );
        const ui = ws.settings.ui ?? {};
        if (ui.dockPosition === 'bottom' || ui.dockPosition === 'right') setDockPosition(ui.dockPosition);
        if (typeof ui.dockHeight === 'number' && ui.dockHeight >= 140) setDockHeight(ui.dockHeight);
        if (typeof ui.dockWidth === 'number' && ui.dockWidth >= 240) setDockWidth(ui.dockWidth);
        if (typeof ui.dockMinimized === 'boolean') setDockMinimized(ui.dockMinimized);
        if (typeof ui.sidebarCollapsed === 'boolean') setSidebarCollapsed(ui.sidebarCollapsed);
        if (ui.view === 'runner' || ui.view === 'editor' || ui.view === 'eod') setView(ui.view);
        if (ui.activeTabByProject) setActiveTabByProject(ui.activeTabByProject);
        if (ui.editorFileByProject) setEditorFileByProject(ui.editorFileByProject);
        const savedSel =
          ui.selectedId && list.some((p) => p.id === ui.selectedId)
            ? ui.selectedId
            : list[0]?.id ?? null;
        setSelectedId(savedSel);
      } catch {
        // No workspace yet (or backend hiccup) — fall back to first project.
        setSelectedId((cur) => cur ?? list[0]?.id ?? null);
      } finally {
        booted.current = true;
      }
    })();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Persist UI layout (debounced) whenever it changes, once booted.
  useEffect(() => {
    if (!booted.current) return;
    const ui: UiSettings = {
      selectedId,
      view,
      dockPosition,
      dockHeight,
      dockWidth,
      dockMinimized,
      sidebarCollapsed,
      activeTabByProject,
      editorFileByProject,
    };
    const t = setTimeout(() => {
      void api.saveSettings({ ui }).catch(() => undefined);
    }, 300);
    return () => clearTimeout(t);
  }, [
    selectedId,
    view,
    dockPosition,
    dockHeight,
    dockWidth,
    dockMinimized,
    sidebarCollapsed,
    activeTabByProject,
    editorFileByProject,
  ]);

  // Drag the dock's inner edge to resize it. Docked bottom → drag the top edge
  // to change height (up = taller); docked right → drag the left edge to change
  // width (left = wider). Clamped so it stays usable and never eats the whole
  // window. Window-level listeners keep tracking even when the pointer moves
  // fast off the thin handle.
  const startResize = (e: ReactPointerEvent) => {
    e.preventDefault();
    const horizontal = dockPosition === 'right'; // dragging width along the x-axis
    const start = horizontal ? e.clientX : e.clientY;
    const startSize = horizontal ? dockWidth : dockHeight;
    const cursorClass = horizontal ? 'resizing-h' : 'resizing-v';
    const onMove = (ev: PointerEvent) => {
      if (horizontal) {
        const dx = start - ev.clientX;
        const max = Math.round(window.innerWidth * 0.85);
        setDockWidth(Math.min(max, Math.max(240, startSize + dx)));
      } else {
        const dy = start - ev.clientY;
        const max = Math.round(window.innerHeight * 0.85);
        setDockHeight(Math.min(max, Math.max(140, startSize + dy)));
      }
    };
    const onUp = () => {
      window.removeEventListener('pointermove', onMove);
      window.removeEventListener('pointerup', onUp);
      document.body.classList.remove(cursorClass);
    };
    window.addEventListener('pointermove', onMove);
    window.addEventListener('pointerup', onUp);
    document.body.classList.add(cursorClass);
  };

  const selected = projects.find((p) => p.id === selectedId) ?? null;

  // Sidebar indicator, two states:
  //  - workingProjectIds: a run in this project is actively producing output → bright pulse.
  //  - claudeIdleProjectIds: a Claude session is open but idle (alive, not working) → dim steady.
  const workingProjectIds = new Set(
    activeRuns.filter((r) => workingIds.has(r.runId)).map((r) => r.projectId),
  );
  const claudeIdleProjectIds = new Set(
    activeRuns
      .filter(
        (r) =>
          r.kind === 'claude' &&
          (r.status === 'running' || r.status === 'connecting') &&
          !workingIds.has(r.runId),
      )
      .map((r) => r.projectId),
  );

  // Terminals scoped to the selected project. The dock only ever shows these;
  // other projects' terminals keep running, just hidden.
  const projectRuns = selected ? activeRuns.filter((r) => r.projectId === selected.id) : [];
  const remembered = selected ? activeTabByProject[selected.id] : undefined;
  const activeTab =
    remembered && projectRuns.some((r) => r.runId === remembered)
      ? remembered
      : projectRuns[projectRuns.length - 1]?.runId ?? null;

  const selectTab = (runId: string) => {
    const run = activeRuns.find((r) => r.runId === runId);
    if (run) setActiveTabByProject((m) => ({ ...m, [run.projectId]: runId }));
  };

  const startRename = (r: ActiveRun) => {
    setRenamingId(r.runId);
    setRenameValue(r.customLabel ?? r.label);
  };
  const commitRename = (runId: string) => {
    const name = renameValue.trim();
    setActiveRuns((cur) =>
      cur.map((r) => (r.runId === runId ? { ...r, customLabel: name || undefined } : r)),
    );
    void api.renameRun(runId, name).catch(() => undefined); // persist server-side ('' clears)
    setRenamingId(null);
  };

  const setEditorFile = useCallback((projectId: string, filePath: string) => {
    setEditorFileByProject((m) => (m[projectId] === filePath ? m : { ...m, [projectId]: filePath }));
  }, []);

  const restartRun = async (oldRunId: string, resume = false) => {
    setError(null);
    try {
      const r: RestoredRun = await api.restartRun(oldRunId, resume);
      sessionRunsRef.current.add(r.runId); // the fresh/resumed run can notify on finish
      setActiveRuns((cur) =>
        cur.map((run) =>
          run.runId === oldRunId
            ? {
                ...run,
                runId: r.runId,
                label: r.label,
                customLabel: r.name ?? undefined,
                kind: r.kind,
                status: 'connecting',
                exitCode: null,
              }
            : run,
        ),
      );
      // Re-point any project's focused-tab reference at the new runId.
      setActiveTabByProject((m) => {
        const next = { ...m };
        for (const k of Object.keys(next)) if (next[k] === oldRunId) next[k] = r.runId;
        return next;
      });
    } catch (e) {
      setError((e as Error).message);
    }
  };

  const addProject = async (path: string) => {
    setError(null);
    try {
      const p = await api.addProject(path);
      await refresh();
      setSelectedId(p.id);
    } catch (e) {
      setError((e as Error).message);
    }
  };

  const deleteProject = async (id: string) => {
    setError(null);
    try {
      await api.deleteProject(id);
      setSelectedId((cur) => (cur === id ? null : cur));
      await refresh();
    } catch (e) {
      setError((e as Error).message);
    }
  };

  const analyze = (id: string) => api.analyze(id).then((res) => {
    void refresh();
    return res;
  });

  const openRunTab = (
    runId: string,
    project: Project,
    label: string,
    kind: 'command' | 'shell' | 'claude',
  ) => {
    sessionRunsRef.current.add(runId); // eligible for a finish notification
    setActiveRuns((cur) => [
      ...cur,
      {
        runId,
        projectId: project.id,
        projectName: project.name,
        label,
        kind,
        status: 'connecting',
        exitCode: null,
      },
    ]);
    setActiveTabByProject((m) => ({ ...m, [project.id]: runId }));
  };

  const runCommand = async (project: Project, command: RunCommand) => {
    setError(null);
    try {
      const { runId } = await api.run(project.id, command.id);
      openRunTab(runId, project, command.label, 'command');
    } catch (e) {
      setError((e as Error).message);
    }
  };

  const openShell = async (project: Project) => {
    setError(null);
    try {
      const { runId } = await api.openShell(project.id);
      openRunTab(runId, project, 'shell', 'shell');
    } catch (e) {
      setError((e as Error).message);
    }
  };

  const openClaude = async (project: Project, resume = false) => {
    setError(null);
    try {
      const { runId } = await api.openClaude(project.id, resume ? { resume: true } : {});
      openRunTab(runId, project, 'claude', 'claude');
    } catch (e) {
      setError((e as Error).message);
    }
  };

  const onRunStatus = useCallback(
    (runId: string, status: RunStatus, exitCode: number | null) => {
      setActiveRuns((cur) =>
        cur.map((r) => (r.runId === runId ? { ...r, status, exitCode } : r)),
      );
    },
    [],
  );

  const dismissToast = useCallback((id: string) => {
    setToasts((cur) => cur.filter((t) => t.id !== id));
    const timer = toastTimers.current[id];
    if (timer) {
      clearTimeout(timer);
      delete toastTimers.current[id];
    }
  }, []);

  // Route to a finished run's tab: select its project, focus the tab, and make
  // sure the terminal dock is visible.
  const focusRun = useCallback(
    (t: Toast) => {
      setSelectedId(t.projectId);
      setActiveTabByProject((m) => ({ ...m, [t.projectId]: t.runId }));
      setDockMinimized(false);
      dismissToast(t.id);
    },
    [dismissToast],
  );

  const pushToast = useCallback(
    (t: Toast) => {
      setToasts((cur) => [...cur.filter((x) => x.id !== t.id), t].slice(-4));
      const prev = toastTimers.current[t.id];
      if (prev) clearTimeout(prev);
      toastTimers.current[t.id] = setTimeout(() => dismissToast(t.id), 10000);
      fireNativeNotification(t, () => focusRun(t));
    },
    [dismissToast, focusRun],
  );

  // Notify when a session-started shell/claude process reaches a terminal state.
  // Gating lives in finishToastFor (pure, unit-tested); here we just record the
  // dedupe and enqueue.
  useEffect(() => {
    for (const r of activeRuns) {
      const toast = finishToastFor(r, {
        sessionRuns: sessionRunsRef.current,
        notified: notifiedRef.current,
      });
      if (!toast) continue;
      notifiedRef.current.add(r.runId);
      pushToast(toast);
    }
  }, [activeRuns, pushToast]);

  // Clear any pending auto-dismiss timers on unmount.
  useEffect(() => {
    const timers = toastTimers.current;
    return () => {
      for (const id of Object.keys(timers)) clearTimeout(timers[id]);
    };
  }, []);

  // Keep a ref of activeRuns so the stable onActivity callback can look runs up.
  useEffect(() => {
    activeRunsRef.current = activeRuns;
  }, [activeRuns]);

  // Output-activity from a terminal: toggle the "working" set (sidebar pulse),
  // and on a working→idle edge that completed a user task, raise a "task done"
  // toast — only for session-started runs that are still alive (so history
  // replay on a restored tab can't fire it).
  const onActivity = useCallback(
    (runId: string, working: boolean, taskDone: boolean) => {
      setWorkingIds((prev) => {
        if (prev.has(runId) === working) return prev;
        const next = new Set(prev);
        if (working) next.add(runId);
        else next.delete(runId);
        return next;
      });
      if (working || !taskDone) return;
      const run = activeRunsRef.current.find((r) => r.runId === runId);
      if (!run || run.status !== 'running') return;
      if (!sessionRunsRef.current.has(runId)) return;
      if (run.kind !== 'claude' && run.kind !== 'shell' && run.kind !== 'command') return;
      taskSeqRef.current += 1;
      pushToast(taskToast(run, taskSeqRef.current));
    },
    [pushToast],
  );

  const closeTab = (runId: string) => {
    // Close server-side too: stops the pty (if live) and drops it from the
    // workspace so it won't be restored on reopen.
    const run = activeRuns.find((r) => r.runId === runId);
    void api.closeRun(runId).catch(() => undefined);
    setActiveRuns((cur) => {
      const remaining = cur.filter((r) => r.runId !== runId);
      if (run) {
        // If we closed the focused tab, fall back to another terminal from the
        // SAME project (most-recent), else drop the project's remembered focus.
        setActiveTabByProject((m) => {
          if (m[run.projectId] !== runId) return m;
          const sibling = [...remaining].reverse().find((r) => r.projectId === run.projectId);
          const next = { ...m };
          if (sibling) next[run.projectId] = sibling.runId;
          else delete next[run.projectId];
          return next;
        });
      }
      return remaining;
    });
  };

  return (
    <div className="app">
      <header className="app-header">
        <button
          className="sidebar-toggle"
          title={sidebarCollapsed ? 'Show sidebar' : 'Hide sidebar'}
          aria-label="Toggle sidebar"
          onClick={() => setSidebarCollapsed((c) => !c)}
        >
          <svg viewBox="0 0 16 16" width="18" height="18" aria-hidden="true">
            <rect x="1.5" y="2.5" width="13" height="11" rx="1.5" fill="none" stroke="currentColor" strokeWidth="1.3" />
            <line x1="6" y1="2.5" x2="6" y2="13.5" stroke="currentColor" strokeWidth="1.3" />
          </svg>
        </button>
        <h1>NARUKAMI</h1>
      </header>

      {!hasToken() && (
        <div className="banner banner-warn">
          No <code>VITE_RUNNER_TOKEN</code> is set. Run <code>npm run token</code> at the repo
          root, then restart the frontend.
        </div>
      )}
      {error && (
        <div className="banner banner-error" onClick={() => setError(null)}>
          {error}
        </div>
      )}

      <div className={`workspace dock-${dockPosition}`}>
        <div className="body">
          <ProjectSidebar
            projects={projects}
            selectedId={selectedId}
            collapsed={sidebarCollapsed}
            workingProjectIds={workingProjectIds}
            claudeIdleProjectIds={claudeIdleProjectIds}
            onSelect={setSelectedId}
            onAdd={addProject}
            onDelete={deleteProject}
          />
          <main className="main">
            {selected ? (
              <>
                <div className="view-switch">
                  <button
                    className={`vs-btn ${view === 'runner' ? 'active' : ''}`}
                    onClick={() => setView('runner')}
                  >
                    Runner
                  </button>
                  <button
                    className={`vs-btn ${view === 'editor' ? 'active' : ''}`}
                    onClick={() => setView('editor')}
                  >
                    Editor
                  </button>
                  <button
                    className={`vs-btn ${view === 'eod' ? 'active' : ''}`}
                    onClick={() => setView('eod')}
                  >
                    EOD
                  </button>
                </div>
                {view === 'runner' ? (
                  <div className="runner-scroll">
                    <ProjectPanel
                      key={selected.id}
                      project={selected}
                      onAnalyze={analyze}
                      onRun={runCommand}
                      onShell={openShell}
                      onClaude={openClaude}
                      onContinueClaude={(p) => openClaude(p, true)}
                      onChanged={refresh}
                    />
                  </div>
                ) : view === 'eod' ? (
                  <div className="runner-scroll">
                    <EodView key={selected.id} project={selected} />
                  </div>
                ) : (
                  <CodeEditor
                    key={selected.id}
                    project={selected}
                    initialFile={editorFileByProject[selected.id]}
                    onOpenFile={(p) => setEditorFile(selected.id, p)}
                  />
                )}
              </>
            ) : (
              <div className="empty">Select or add a project to get started.</div>
            )}
          </main>
        </div>

        <section
          className={`terminals dock-${dockPosition} ${projectRuns.length ? 'open' : ''} ${
            dockMinimized ? 'minimized' : ''
          }`}
          style={
            projectRuns.length && !dockMinimized
              ? dockPosition === 'right'
                ? { width: dockWidth }
                : { height: dockHeight }
              : undefined
          }
        >
          {activeRuns.length > 0 && (
            <>
              {projectRuns.length > 0 && !dockMinimized && (
                <div
                  className="term-resize-handle"
                  onPointerDown={startResize}
                  onDoubleClick={() =>
                    dockPosition === 'right' ? setDockWidth(480) : setDockHeight(320)
                  }
                  title="Drag to resize · double-click to reset"
                />
              )}
              {projectRuns.length > 0 && (
                <div className="tabbar">
                  <div className="tabbar-tabs">
                    {projectRuns.map((r) => (
                      <div key={r.runId} className={`tab ${activeTab === r.runId ? 'active' : ''}`}>
                        {renamingId === r.runId ? (
                          <input
                            className="tab-rename"
                            autoFocus
                            value={renameValue}
                            spellCheck={false}
                            onChange={(e) => setRenameValue(e.target.value)}
                            onKeyDown={(e) => {
                              if (e.key === 'Enter') commitRename(r.runId);
                              else if (e.key === 'Escape') {
                                renameSkipBlur.current = true;
                                setRenamingId(null);
                              }
                            }}
                            onBlur={() => {
                              if (renameSkipBlur.current) {
                                renameSkipBlur.current = false;
                                return;
                              }
                              commitRename(r.runId);
                            }}
                          />
                        ) : (
                          <button
                            className="tab-btn"
                            onClick={() => {
                              selectTab(r.runId);
                              if (dockMinimized) setDockMinimized(false);
                            }}
                            onDoubleClick={() => startRename(r)}
                            title="Double-click to rename"
                          >
                            <span className={`dot dot-${r.status}`} />
                            {r.kind === 'shell' ? '⌨ ' : r.kind === 'claude' ? '✦ ' : ''}
                            {r.customLabel ?? r.label}
                          </button>
                        )}
                        <button className="tab-close" title="Close tab" onClick={() => closeTab(r.runId)}>
                          ×
                        </button>
                      </div>
                    ))}
                  </div>
                  <div className="tabbar-actions">
                    <button
                      className="dock-btn"
                      title={dockPosition === 'right' ? 'Dock to bottom' : 'Dock to right'}
                      onClick={() =>
                        setDockPosition((p) => (p === 'right' ? 'bottom' : 'right'))
                      }
                    >
                      {dockPosition === 'right' ? (
                        <svg viewBox="0 0 16 16" aria-hidden="true">
                          <rect x="1.5" y="2.5" width="13" height="11" rx="1.5" fill="none" stroke="currentColor" strokeWidth="1.3" />
                          <rect x="1.5" y="9.5" width="13" height="4" fill="currentColor" />
                        </svg>
                      ) : (
                        <svg viewBox="0 0 16 16" aria-hidden="true">
                          <rect x="1.5" y="2.5" width="13" height="11" rx="1.5" fill="none" stroke="currentColor" strokeWidth="1.3" />
                          <rect x="9.5" y="2.5" width="5" height="11" fill="currentColor" />
                        </svg>
                      )}
                    </button>
                    <button
                      className="dock-btn"
                      title={dockMinimized ? 'Restore terminal' : 'Minimize terminal'}
                      onClick={() => setDockMinimized((m) => !m)}
                    >
                      {dockMinimized ? (
                        <svg viewBox="0 0 16 16" aria-hidden="true">
                          <path
                            d="M4 10l4-4 4 4"
                            fill="none"
                            stroke="currentColor"
                            strokeWidth="1.6"
                            strokeLinecap="round"
                            strokeLinejoin="round"
                          />
                        </svg>
                      ) : (
                        <svg viewBox="0 0 16 16" aria-hidden="true">
                          <path d="M3 8h10" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" />
                        </svg>
                      )}
                    </button>
                  </div>
                </div>
              )}
              {/* Every run stays mounted regardless of the selected project so its
                  pty/websocket survives project switches; only the selected
                  project's active tab is displayed. */}
              <div className="term-stack">
                {activeRuns.map((r) => (
                  <div
                    key={r.runId}
                    className="term-slot"
                    style={{ display: activeTab === r.runId ? 'flex' : 'none' }}
                  >
                    <TerminalTab
                      run={r}
                      onStatus={onRunStatus}
                      onRestart={restartRun}
                      onContinue={(id) => restartRun(id, true)}
                      onActivity={onActivity}
                    />
                  </div>
                ))}
              </div>
            </>
          )}
        </section>
      </div>
      <Toasts toasts={toasts} onFocus={focusRun} onDismiss={dismissToast} />
    </div>
  );
}
