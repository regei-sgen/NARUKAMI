import {
  type PointerEvent as ReactPointerEvent,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from 'react';
import { api, hasToken } from './api';
import type { ActiveRun, Project, RestoredRun, RunCommand, RunStatus, Toast, UiSettings } from './types';
import { ProjectSidebar } from './components/ProjectSidebar';
import { ProjectPanel } from './components/ProjectPanel';
import { CodeEditor } from './components/CodeEditor';
import { EodView } from './components/EodView';
import { ArgusPanoptes } from './components/argus/ArgusPanoptes';
import { CodeMap } from './components/CodeMap';
import { Armory } from './components/Armory';
import { TerminalTab } from './components/TerminalTab';
import { ThemeSelector } from './components/ThemeSelector';
import { HeaderCluster } from './components/HeaderCluster';
import { Toasts } from './components/Toasts';
import { Ic } from './components/icons';
import { finishToastFor, fireNativeNotification, primeNotifications, shouldShowInAppToast, taskToast } from './lib/notify';

/** Theme variants — '' is Beni, the default blade-red. Values map to [data-theme];
 *  each accent mirrors the variant's --accent token for the picker swatch. */
const THEMES: ReadonlyArray<{ value: string; label: string; accent: string }> = [
  { value: '', label: 'Beni', accent: '#ff2d3c' },
  { value: 'raiden', label: 'Raiden', accent: '#7c5cff' },
  { value: 'kitsune', label: 'Kitsune', accent: '#ff7a2d' },
  { value: 'jade', label: 'Jade', accent: '#2fd9a0' },
  { value: 'yuki', label: 'Yuki', accent: '#4db8ff' },
  { value: 'sakura', label: 'Sakura', accent: '#ff5c8a' },
];

export default function App() {
  const [projects, setProjects] = useState<Project[]>([]);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [activeRuns, setActiveRuns] = useState<ActiveRun[]>([]);
  // Which terminal tab is focused, remembered PER project. Every run stays
  // mounted (see the term-stack below) so ptys survive project switches; this
  // only controls which one is visible for the currently selected project.
  const [activeTabByProject, setActiveTabByProject] = useState<Record<string, string>>({});
  // Views are peer tabs (Runner / Editor / EOD / Argus / Code Map). Argus is a
  // global read-only monitor; the rest are scoped to the selected project.
  const [view, setView] = useState<'runner' | 'editor' | 'eod' | 'argus' | 'codemap' | 'armory'>('runner');
  // Terminal dock: docked bottom (resizable height) or right (resizable width),
  // plus minimize. All persisted server-side.
  const [dockPosition, setDockPosition] = useState<'bottom' | 'right'>('bottom');
  const [dockHeight, setDockHeight] = useState<number>(320);
  const [dockWidth, setDockWidth] = useState<number>(480);
  const [dockMinimized, setDockMinimized] = useState<boolean>(false);
  const [sidebarCollapsed, setSidebarCollapsed] = useState<boolean>(false);
  // Theme variant ('' = Beni, the default blade-red). Persisted per device.
  const [theme, setTheme] = useState<string>(() => localStorage.getItem('narukami-theme') ?? '');
  useEffect(() => {
    if (theme) document.documentElement.dataset.theme = theme;
    else delete document.documentElement.dataset.theme;
    localStorage.setItem('narukami-theme', theme);
  }, [theme]);
  // Last-open editor file per project (restored on reopen).
  const [editorFileByProject, setEditorFileByProject] = useState<Record<string, string>>({});
  // Inline tab rename.
  const [renamingId, setRenamingId] = useState<string | null>(null);
  const [renameValue, setRenameValue] = useState('');
  const renameSkipBlur = useRef(false);
  const [error, setError] = useState<string | null>(null);
  // Whether the code editor has unsaved edits — used to guard leaving it.
  const [editorDirty, setEditorDirty] = useState(false);
  // Finished-process notifications (click routes to the run's tab).
  const [toasts, setToasts] = useState<Toast[]>([]);
  // Runs currently producing output ("working") — drives the sidebar pulse.
  const [workingIds, setWorkingIds] = useState<Set<string>>(new Set());
  // Mirror of activeRuns for stable callbacks (activity/toast handlers).
  const activeRunsRef = useRef<ActiveRun[]>([]);
  // Mirror of selectedId so the stable pushToast callback can tell whether the
  // finishing run belongs to the project the user is currently viewing.
  const selectedIdRef = useRef<string | null>(null);
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
        if (
          ui.view === 'runner' ||
          ui.view === 'editor' ||
          ui.view === 'eod' ||
          ui.view === 'argus' ||
          ui.view === 'codemap' ||
          ui.view === 'armory'
        )
          setView(ui.view);
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
    // Coalesce to one setState per frame: pointermove can fire faster than the
    // display refreshes (120Hz+ mice), and each set re-renders the whole app.
    let dragRaf = 0;
    let lastPos = start;
    const applyDrag = () => {
      dragRaf = 0;
      if (horizontal) {
        const dx = start - lastPos;
        const max = Math.round(window.innerWidth * 0.85);
        setDockWidth(Math.min(max, Math.max(240, startSize + dx)));
      } else {
        const dy = start - lastPos;
        const max = Math.round(window.innerHeight * 0.85);
        setDockHeight(Math.min(max, Math.max(140, startSize + dy)));
      }
    };
    const onMove = (ev: PointerEvent) => {
      lastPos = horizontal ? ev.clientX : ev.clientY;
      if (!dragRaf) dragRaf = requestAnimationFrame(applyDrag);
    };
    const onUp = () => {
      if (dragRaf) {
        cancelAnimationFrame(dragRaf);
        applyDrag(); // commit the final position
      }
      window.removeEventListener('pointermove', onMove);
      window.removeEventListener('pointerup', onUp);
      document.body.classList.remove(cursorClass);
    };
    window.addEventListener('pointermove', onMove);
    window.addEventListener('pointerup', onUp);
    document.body.classList.add(cursorClass);
  };

  const selected = projects.find((p) => p.id === selectedId) ?? null;

  // Primitive per-tab lookup so memoized TerminalTabs get a stable prop instead
  // of a fresh projects.find() per tab per App render.
  const codeMapEmbedByProject = useMemo(() => {
    const m = new Map<string, boolean>();
    for (const p of projects) m.set(p.id, p.codeMapEmbed ?? false);
    return m;
  }, [projects]);

  // Leaving the editor (switching view or project) unmounts it and would silently
  // drop unsaved edits — confirm first when the editor is dirty.
  const confirmLeaveEditor = useCallback((): boolean => {
    if (view === 'editor' && editorDirty) {
      return window.confirm('You have unsaved changes in the editor. Discard them?');
    }
    return true;
  }, [view, editorDirty]);

  // Sidebar indicator, two states:
  //  - workingProjectIds: a run in this project is actively producing output → bright pulse.
  //  - claudeIdleProjectIds: a Claude session is open but idle (alive, not working) → dim steady.
  // Memoized so their identity only changes with runs/working state, not on
  // every unrelated App render.
  const workingProjectIds = useMemo(
    () => new Set(activeRuns.filter((r) => workingIds.has(r.runId)).map((r) => r.projectId)),
    [activeRuns, workingIds],
  );
  const claudeIdleProjectIds = useMemo(
    () =>
      new Set(
        activeRuns
          .filter(
            (r) =>
              r.kind === 'claude' &&
              (r.status === 'running' || r.status === 'connecting') &&
              !workingIds.has(r.runId),
          )
          .map((r) => r.projectId),
      ),
    [activeRuns, workingIds],
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

  // Stable (useCallback, setters/refs only) so memoized TerminalTabs don't
  // re-render every time App does.
  const restartRun = useCallback(async (oldRunId: string, resume = false) => {
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
  }, []);

  const continueRun = useCallback((runId: string) => void restartRun(runId, true), [restartRun]);

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
    opts: { elevated?: boolean; pending?: boolean } = {},
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
        elevated: opts.elevated,
        pending: opts.pending,
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

  const openShell = async (project: Project, admin = false) => {
    setError(null);
    try {
      const { runId, elevated, pending } = await api.openShell(project.id, admin);
      openRunTab(runId, project, admin ? 'shell (admin)' : 'shell', 'shell', {
        elevated: elevated ?? admin,
        pending: pending ?? admin,
      });
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

  // Header cluster: jump to a run's tab from its pulse segment. Reads runs via
  // the ref so the callback stays identity-stable (memoized HeaderCluster).
  const focusRunById = useCallback((runId: string) => {
    const run = activeRunsRef.current.find((r) => r.runId === runId);
    if (!run) return;
    setSelectedId(run.projectId);
    setActiveTabByProject((m) => ({ ...m, [run.projectId]: runId }));
    setDockMinimized(false);
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
      // Don't pop an in-app toast for a run in the project you're already
      // looking at (focused window) — you can see it finish. The native
      // notification below still fires; it self-gates on window focus, so a
      // backgrounded finish in the selected project isn't lost.
      const inApp = shouldShowInAppToast(t, {
        selectedProjectId: selectedIdRef.current,
        focused: typeof document === 'undefined' ? true : document.hasFocus(),
        visible: typeof document === 'undefined' ? true : document.visibilityState === 'visible',
      });
      if (inApp) {
        setToasts((cur) => [...cur.filter((x) => x.id !== t.id), t].slice(-4));
        const prev = toastTimers.current[t.id];
        if (prev) clearTimeout(prev);
        toastTimers.current[t.id] = setTimeout(() => dismissToast(t.id), 10000);
      }
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

  // Keep a ref of the selected project for the stable pushToast callback.
  useEffect(() => {
    selectedIdRef.current = selectedId;
  }, [selectedId]);

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
      // Task-done toasts fire for Claude sessions only. Shell/command tabs run
      // long-lived processes (dev servers, watchers) whose output pauses look
      // identical to "done" on a timer — a guaranteed false-positive source.
      // Those still get the reliable finish toast when the process actually exits.
      if (run.kind !== 'claude') return;
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

  // Lives in the view-switch strip (beside Runner); also rendered in the
  // no-project state so a collapsed sidebar can always be reopened.
  const sidebarToggle = (
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
  );

  return (
    <div className="app">
      <header className="app-header">
        <h1>NARUKAMI</h1>
        <HeaderCluster runs={activeRuns} workingIds={workingIds} onFocusRun={focusRunById} />
        <ThemeSelector themes={THEMES} value={theme} onChange={setTheme} />
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
            onSelect={(id) => {
              if (!confirmLeaveEditor()) return;
              setSelectedId(id);
            }}
            onAdd={addProject}
            onDelete={deleteProject}
          />
          <main className="main">
            {selected ? (
              <>
                <div className="view-switch">
                  {sidebarToggle}
                  <button
                    className={`vs-btn ${view === 'runner' ? 'active' : ''}`}
                    onClick={() => confirmLeaveEditor() && setView('runner')}
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
                    onClick={() => confirmLeaveEditor() && setView('eod')}
                  >
                    EOD
                  </button>
                  <button
                    className={`vs-btn ${view === 'argus' ? 'active' : ''}`}
                    onClick={() => confirmLeaveEditor() && setView('argus')}
                  >
                    GODCLAUDE
                  </button>
                  <button
                    className={`vs-btn ${view === 'codemap' ? 'active' : ''}`}
                    onClick={() => confirmLeaveEditor() && setView('codemap')}
                  >
                    Code Map
                  </button>
                  <button
                    className={`vs-btn ${view === 'armory' ? 'active' : ''}`}
                    onClick={() => confirmLeaveEditor() && setView('armory')}
                  >
                    Arsenal
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
                    <EodView />
                  </div>
                ) : view === 'argus' ? (
                  // Argus is global (no project key) — it stays mounted across
                  // project switches. The relative-positioned pane is the
                  // containing block for `.argus` (position:absolute; inset:0),
                  // so it fills this content region instead of the whole window.
                  <div className="argus-pane">
                    <ArgusPanoptes selectedPath={selected.path} />
                  </div>
                ) : view === 'codemap' ? (
                  <div className="runner-scroll">
                    <CodeMap key={selected.id} project={selected} onChanged={refresh} />
                  </div>
                ) : view === 'armory' ? (
                  // Armory is global (no project key) — an inventory of all skills,
                  // hooks, memory pins, agents and commands, not project-filtered.
                  <div className="runner-scroll">
                    <Armory />
                  </div>
                ) : (
                  <CodeEditor
                    key={selected.id}
                    project={selected}
                    initialFile={editorFileByProject[selected.id]}
                    onOpenFile={(p) => setEditorFile(selected.id, p)}
                    onDirtyChange={setEditorDirty}
                  />
                )}
              </>
            ) : (
              <>
                <div className="view-switch">{sidebarToggle}</div>
                <div className="empty">Select or add a project to get started.</div>
              </>
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
              {projectRuns.length > 0 && dockPosition === 'right' && dockMinimized ? (
                // Side dock, minimized → collapse to an ultra-slim full-height
                // icon rail: one status dot per terminal + a restore control.
                // No clipped tabs, no empty void.
                <div className="term-rail">
                  <button
                    className="term-rail-restore"
                    title="Restore terminal"
                    aria-label="Restore terminal"
                    onClick={() => setDockMinimized(false)}
                  >
                    <svg viewBox="0 0 16 16" aria-hidden="true">
                      <path
                        d="M10 4L6 8l4 4"
                        fill="none"
                        stroke="currentColor"
                        strokeWidth="1.6"
                        strokeLinecap="round"
                        strokeLinejoin="round"
                      />
                    </svg>
                  </button>
                  <div className="term-rail-dots">
                    {projectRuns.map((r) => (
                      <button
                        key={r.runId}
                        className={`term-rail-dot ${activeTab === r.runId ? 'active' : ''}`}
                        title={r.customLabel ?? r.label}
                        aria-label={r.customLabel ?? r.label}
                        onClick={() => {
                          selectTab(r.runId);
                          setDockMinimized(false);
                        }}
                      >
                        <span className={`dot dot-${r.status}`} />
                      </button>
                    ))}
                  </div>
                </div>
              ) : projectRuns.length > 0 ? (
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
                            {r.elevated ? <><Ic name="shield" /> </> : null}
                            {r.kind === 'shell' ? <><Ic name="shell" /> </> : r.kind === 'claude' ? <><Ic name="spark" /> </> : null}
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
              ) : null}
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
                      onContinue={continueRun}
                      onActivity={onActivity}
                      codeMapEmbed={codeMapEmbedByProject.get(r.projectId) ?? false}
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
