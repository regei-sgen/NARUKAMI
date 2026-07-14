import {
  lazy,
  type CSSProperties,
  type DragEvent as ReactDragEvent,
  type PointerEvent as ReactPointerEvent,
  Suspense,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from 'react';
import { api, hasToken } from './api';
import type { ActiveRun, Project, RestoredRun, RunCommand, RunStatus, Toast, UiSettings, WrapupVerdict } from './types';
import { ProjectSidebar } from './components/ProjectSidebar';
import { ProjectPanel } from './components/ProjectPanel';

// Lazy: CodeEditor drags in ALL of Monaco (its module-scope setup + 5 workers —
// the bulk of the SPA bundle). Splitting it means popped-out terminal windows
// and the phone share page never parse/execute megabytes of editor code to
// render one xterm, and the main window pays for Monaco only when the Editor
// view is first opened.
const CodeEditor = lazy(() =>
  import('./components/CodeEditor').then((m) => ({ default: m.CodeEditor })),
);
import { EodView } from './components/EodView';
import { SgaRelease } from './components/SgaRelease';
import { ArgusPanoptes } from './components/argus/ArgusPanoptes';
import { CodeMap } from './components/CodeMap';
import { Armory } from './components/Armory';
import { Changelog } from './components/Changelog';
import { BrowserTab } from './components/BrowserTab';
import { DEFAULT_DEVICE_IDS, DEVICE_PRESETS } from './lib/browserView';
import { TerminalTab, type InjectSignal, type WrapupPhase, WRAPUP_DONE_MARKER } from './components/TerminalTab';
import { ThemeSelector } from './components/ThemeSelector';
import { HeaderCluster } from './components/HeaderCluster';
import { Toasts } from './components/Toasts';
import { Ic } from './components/icons';
import { finishToastFor, fireNativeNotification, primeNotifications, shouldShowInAppToast, taskToast } from './lib/notify';
import { desktop } from './lib/desktop';

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

// Which action opened the forced wrap-up: Stop (end process, keep the tab for
// Restart/Continue) or ✕ (drop the tab entirely) — "Close now" honours it.
type WrapupOrigin = 'stop' | 'close';
interface WrapupEntry {
  phase: WrapupPhase;
  origin: WrapupOrigin;
}

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
  const [view, setView] = useState<'runner' | 'editor' | 'eod' | 'release' | 'argus' | 'codemap' | 'armory' | 'browser' | 'changelog'>('runner');
  // Terminal dock: docked bottom (resizable height) or right (resizable width),
  // plus minimize. All persisted server-side.
  const [dockPosition, setDockPosition] = useState<'bottom' | 'right'>('bottom');
  const [dockHeight, setDockHeight] = useState<number>(320);
  const [dockWidth, setDockWidth] = useState<number>(480);
  const [dockMinimized, setDockMinimized] = useState<boolean>(false);
  const [sidebarCollapsed, setSidebarCollapsed] = useState<boolean>(false);
  // S|S split view: the terminal dock shows two side-by-side panes (primary =
  // activeTab, secondary = secondaryTab; splitRatio = the primary's fraction).
  // Persisted server-side with the rest of the UI layout. While the split is ON,
  // tab chips become HTML5-draggable into the right pane and the pointer
  // tear-off gesture pauses (the two drag interactions can't share a tab).
  const [splitView, setSplitView] = useState<boolean>(false);
  const [secondaryTab, setSecondaryTab] = useState<string | null>(null);
  const [splitRatio, setSplitRatio] = useState<number>(0.5);
  const dragRunId = useRef<string | null>(null);
  const [paneDropActive, setPaneDropActive] = useState(false);
  const termStackRef = useRef<HTMLDivElement>(null);
  // The terminal dock element + a highlight flag, for dragging a torn-off window
  // back over it to re-dock (desktop shell only).
  const dockRef = useRef<HTMLElement>(null);
  const [dockHint, setDockHint] = useState<boolean>(false);
  // Theme variant ('' = Beni, the default blade-red). Persisted per device.
  const [theme, setTheme] = useState<string>(() => localStorage.getItem('narukami-theme') ?? '');
  useEffect(() => {
    if (theme) document.documentElement.dataset.theme = theme;
    else delete document.documentElement.dataset.theme;
    localStorage.setItem('narukami-theme', theme);
  }, [theme]);
  // Last-open editor file per project (restored on reopen).
  const [editorFileByProject, setEditorFileByProject] = useState<Record<string, string>>({});
  // Browser view: last committed preview URL per project (persisted) and the
  // enabled device presets (global). Detected dev-server URLs are ephemeral —
  // a stale port from a previous session would be worse than nothing.
  const [browserUrlByProject, setBrowserUrlByProject] = useState<Record<string, string>>({});
  const [browserDevices, setBrowserDevices] = useState<string[]>(DEFAULT_DEVICE_IDS);
  const [devUrlByProject, setDevUrlByProject] = useState<Record<string, string>>({});
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
  // ── Forced wrap-up gate (claude tabs only). A Stop/✕ on a claude tab first
  // opens a modal (verdict required + optional notes); on submit we record the
  // verdict server-side, inject a wrap-up prompt into the pty, and gate the real
  // close until the session prints the completion marker. wrapupModalRunId
  // drives the modal; wrappingUp tracks the gated-close phase per run;
  // injectSignal is the one-shot prompt injection for a single run.
  const [wrapupModalRunId, setWrapupModalRunId] = useState<string | null>(null);
  const [wrapupOrigin, setWrapupOrigin] = useState<WrapupOrigin>('close');
  const [wrapupVerdict, setWrapupVerdict] = useState<WrapupVerdict | null>(null);
  const [wrapupNotes, setWrapupNotes] = useState('');
  const [wrappingUp, setWrappingUp] = useState<Record<string, WrapupEntry>>({});
  const [injectSignal, setInjectSignal] = useState<(InjectSignal & { runId: string }) | null>(null);
  // Mirror of wrappingUp for identity-stable callbacks (memoized TerminalTabs).
  const wrappingUpRef = useRef<Record<string, WrapupEntry>>({});
  useEffect(() => {
    wrappingUpRef.current = wrappingUp;
  }, [wrappingUp]);

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
        if (typeof ui.splitView === 'boolean') setSplitView(ui.splitView);
        if (typeof ui.secondaryTab === 'string' && ui.secondaryTab) setSecondaryTab(ui.secondaryTab);
        if (typeof ui.splitRatio === 'number' && ui.splitRatio >= 0.2 && ui.splitRatio <= 0.8)
          setSplitRatio(ui.splitRatio);
        if (
          ui.view === 'runner' ||
          ui.view === 'editor' ||
          ui.view === 'eod' ||
          ui.view === 'release' ||
          ui.view === 'argus' ||
          ui.view === 'codemap' ||
          ui.view === 'armory' ||
          ui.view === 'browser' ||
          ui.view === 'changelog'
        )
          setView(ui.view);
        if (ui.activeTabByProject) setActiveTabByProject(ui.activeTabByProject);
        if (ui.editorFileByProject) setEditorFileByProject(ui.editorFileByProject);
        if (ui.browserUrlByProject) setBrowserUrlByProject(ui.browserUrlByProject);
        if (Array.isArray(ui.browserDevices)) {
          // Drop ids that no longer match a preset (renames/removals).
          const known = ui.browserDevices.filter((id) => DEVICE_PRESETS.some((d) => d.id === id));
          if (known.length) setBrowserDevices(known);
        }
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
      splitView,
      secondaryTab,
      splitRatio,
      activeTabByProject,
      editorFileByProject,
      browserUrlByProject,
      browserDevices,
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
    splitView,
    secondaryTab,
    splitRatio,
    activeTabByProject,
    editorFileByProject,
    browserUrlByProject,
    browserDevices,
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

  // The run the wrap-up modal is currently asking about (for its subtitle).
  const wrapupRun = wrapupModalRunId
    ? activeRuns.find((r) => r.runId === wrapupModalRunId) ?? null
    : null;

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

  // S|S derivations. The secondary pane's run must still exist, differ from the
  // primary, AND belong to the selected project — resolving against projectRuns
  // (not all activeRuns) keeps the dock scoped so a project switch can never leak
  // a foreign project's terminal into the right pane; anything else resolves to
  // null (fail-soft). secondaryTab stays persisted, so returning to its project
  // restores the split. splitActive = the two-column layout being live.
  const secondaryRun =
    secondaryTab && secondaryTab !== activeTab
      ? projectRuns.find((r) => r.runId === secondaryTab) ?? null
      : null;
  const splitActive = splitView && !!activeTab;
  // The split panes' widths derive from splitRatio (primary spans 0→ratio,
  // secondary ratio→1).
  const leftPct = `${splitRatio * 100}%`;
  const rightRemainder = `${(1 - splitRatio) * 100}%`;

  const selectTab = (runId: string) => {
    const run = activeRuns.find((r) => r.runId === runId);
    if (!run) return;
    // In split mode, a single click on a tab that's ALREADY shown in a pane must
    // NOT rearrange the panes (it would also swallow double-click-to-rename).
    // Only a tab that isn't currently visible becomes the new primary.
    if (splitView && (runId === activeTab || runId === secondaryTab)) {
      return;
    }
    setActiveTabByProject((m) => ({ ...m, [run.projectId]: runId }));
  };

  // Drop a stale secondary-pane pointer once its run is gone (closed/popped out).
  useEffect(() => {
    if (secondaryTab && !activeRuns.some((r) => r.runId === secondaryTab)) setSecondaryTab(null);
  }, [activeRuns, secondaryTab]);

  // Assign the dragged tab to the secondary pane. Never mirror the primary — a
  // pane split with itself is meaningless (no-op in that case).
  const assignSecondary = (srcId: string) => {
    if (!srcId || srcId === activeTab) return;
    setSecondaryTab(srcId);
  };

  // Shared pane drop-target handlers (secondary pane + the empty dropzone). The
  // dragged runId lives in dragRunId.current; fall back to the dataTransfer text
  // channel for standards-compliant drops that lose the ref.
  const onPaneDragOver = (e: ReactDragEvent) => {
    if (!dragRunId.current) return; // only react to a tab drag, not arbitrary drags
    e.preventDefault();
    e.dataTransfer.dropEffect = 'move';
    setPaneDropActive(true);
  };
  const onPaneDrop = (e: ReactDragEvent) => {
    e.preventDefault();
    let src = dragRunId.current;
    if (!src) {
      try {
        src = e.dataTransfer.getData('text/plain') || null;
      } catch {
        src = null;
      }
    }
    dragRunId.current = null;
    setPaneDropActive(false);
    if (src) assignSecondary(src);
  };

  // Drag the divider between the two split panes. Maps the cursor's x within the
  // term-stack to splitRatio (clamped 0.2–0.8), mirroring startResize's global
  // pointermove/up + body-cursor-class pattern (resizing-h also disables child
  // pointer-events so the terminal doesn't swallow the move).
  const startSplitResize = (e: ReactPointerEvent) => {
    e.preventDefault();
    const stack = termStackRef.current;
    if (!stack) return;
    const onMove = (ev: PointerEvent) => {
      const rect = stack.getBoundingClientRect();
      if (rect.width <= 0) return;
      const ratio = (ev.clientX - rect.left) / rect.width;
      setSplitRatio(Math.min(0.8, Math.max(0.2, ratio)));
    };
    const onUp = () => {
      window.removeEventListener('pointermove', onMove);
      window.removeEventListener('pointerup', onUp);
      document.body.classList.remove('resizing-h');
    };
    window.addEventListener('pointermove', onMove);
    window.addEventListener('pointerup', onUp);
    document.body.classList.add('resizing-h');
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

  const setBrowserUrl = useCallback((projectId: string, url: string) => {
    setBrowserUrlByProject((m) => (m[projectId] === url ? m : { ...m, [projectId]: url }));
  }, []);

  // Stable (empty deps, reads via activeRunsRef) so memoized TerminalTabs
  // don't re-render every time App does.
  const handleDevUrl = useCallback((runId: string, url: string) => {
    const run = activeRunsRef.current.find((r) => r.runId === runId);
    if (!run) return;
    setDevUrlByProject((m) => (m[run.projectId] === url ? m : { ...m, [run.projectId]: url }));
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

  // Tear a terminal off into its own desktop window (move semantics): ask the
  // shell to open it — spawned at the cursor when `pos` is given — and drop the
  // tab from THIS window. The pty keeps running server-side; the window owns the
  // live view until it's re-docked (dragged back or closed) via reclaimRun.
  // Stable (reads the run from the setter's current value) so the memoized
  // TerminalTabs aren't re-rendered by a changing onPopOut identity.
  const popOut = useCallback((runId: string, pos?: { x: number; y: number }) => {
    const bridge = desktop();
    if (!bridge) return;
    // A run mid-wrap-up must stay docked: the gate UI (and the injected prompt's
    // marker watch) lives in THIS window's tab — tearing it off would orphan it.
    if (wrappingUpRef.current[runId]) return;
    setActiveRuns((cur) => {
      const run = cur.find((r) => r.runId === runId);
      if (!run) return cur;
      bridge.popOut(runId, pos);
      const remaining = cur.filter((r) => r.runId !== runId);
      setActiveTabByProject((m) => {
        if (m[run.projectId] !== runId) return m;
        const sibling = [...remaining].reverse().find((r) => r.projectId === run.projectId);
        const next = { ...m };
        if (sibling) next[run.projectId] = sibling.runId;
        else delete next[run.projectId];
        return next;
      });
      return remaining;
    });
  }, []);

  // Re-dock a torn-off terminal (its window was dragged back over the dock, or
  // closed). Read current metadata from the workspace by runId — not a stale
  // snapshot — so a restart done in the torn-off window is reflected here.
  const reclaimRun = useCallback(async (runId: string) => {
    try {
      const ws = await api.getWorkspace();
      const r = ws.runs.find((x) => x.runId === runId);
      if (!r) return; // ended while detached — nothing to re-dock
      setActiveRuns((cur) =>
        cur.some((x) => x.runId === runId)
          ? cur
          : [
              ...cur,
              {
                runId: r.runId,
                projectId: r.projectId,
                projectName: r.projectName,
                label: r.label,
                customLabel: r.name ?? undefined,
                kind: r.kind,
                status: 'connecting',
                exitCode: null,
              },
            ],
      );
      setActiveTabByProject((m) => ({ ...m, [r.projectId]: runId }));
    } catch {
      /* transient — the run stays live server-side and restores on reopen */
    }
  }, []);

  useEffect(() => {
    const bridge = desktop();
    if (!bridge) return;
    return bridge.onReclaim((runId) => void reclaimRun(runId));
  }, [reclaimRun]);

  // Highlight the dock while a torn-off window is dragged back over it.
  useEffect(() => {
    const bridge = desktop();
    if (!bridge) return;
    return bridge.onDockHint((active) => setDockHint(active));
  }, []);

  // Report the dock's on-screen rectangle to the shell so it can tell when a
  // torn-off window is dragged back over it. Re-measured whenever the layout that
  // affects the dock's size/position changes, and on window resize.
  useEffect(() => {
    const bridge = desktop();
    if (!bridge) return;
    const report = () => {
      const el = dockRef.current;
      const r = el?.getBoundingClientRect();
      bridge.reportDockRect(
        r && r.width > 0 && r.height > 0
          ? { x: r.left, y: r.top, width: r.width, height: r.height }
          : null,
      );
    };
    report();
    window.addEventListener('resize', report);
    return () => window.removeEventListener('resize', report);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [dockPosition, dockHeight, dockWidth, dockMinimized, sidebarCollapsed, view, selectedId, activeRuns.length]);

  // Drag a terminal tab out of the strip to tear it off. We don't hijack the
  // click: only a press that travels a real distance AND is released outside the
  // dock detaches (at the cursor). A plain click still just selects the tab.
  const beginTabDrag = (e: ReactPointerEvent, runId: string) => {
    // Split mode: the HTML5 drag (assign-to-pane) owns the tab-drag gesture;
    // tear-off resumes when the split is toggled off (Pop out stays available
    // on the terminal toolbar either way).
    if (splitView) return;
    if (e.button !== 0 || !desktop()) return;
    const start = { x: e.clientX, y: e.clientY };
    const onMove = (ev: PointerEvent) => {
      if (Math.hypot(ev.clientX - start.x, ev.clientY - start.y) > 8) {
        document.body.classList.add('tab-tearing');
      }
    };
    const onUp = (ev: PointerEvent) => {
      window.removeEventListener('pointermove', onMove);
      window.removeEventListener('pointerup', onUp);
      document.body.classList.remove('tab-tearing');
      const dist = Math.hypot(ev.clientX - start.x, ev.clientY - start.y);
      const rect = dockRef.current?.getBoundingClientRect();
      const outside =
        !rect ||
        ev.clientX < rect.left ||
        ev.clientX > rect.right ||
        ev.clientY < rect.top ||
        ev.clientY > rect.bottom;
      if (dist > 30 && outside) popOut(runId, { x: ev.screenX, y: ev.screenY });
    };
    window.addEventListener('pointermove', onMove);
    window.addEventListener('pointerup', onUp);
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

  const openShell = async (project: Project, admin = false, shell: 'powershell' | 'cmd' = 'powershell') => {
    setError(null);
    try {
      const { runId, elevated, pending } = await api.openShell(project.id, admin, shell);
      const label = admin ? 'shell (admin)' : shell === 'cmd' ? 'cmd' : 'shell';
      openRunTab(runId, project, label, 'shell', {
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
      // Forced wrap-up gate: this only advances pending→working (drives the spinner).
      // 'ready' ("Close now") is NOT reached by going idle — an idle is a weak proxy that
      // fires BEFORE the wrap-up actually finishes (consolidation + memory can pause mid-way
      // past IDLE_MS). 'ready' comes solely from the session printing the completion marker,
      // detected in output by TerminalTab → onWrapupComplete.
      setWrappingUp((prev) => {
        const entry = prev[runId];
        if (!entry) return prev;
        if (entry.phase === 'pending' && working) {
          return { ...prev, [runId]: { ...entry, phase: 'working' } };
        }
        return prev;
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

  // Actually drop a tab: stop the pty (if live) server-side, drop it from the
  // workspace so it won't be restored on reopen, and re-focus a sibling.
  const performClose = useCallback((runId: string) => {
    const run = activeRunsRef.current.find((r) => r.runId === runId);
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
  }, []);

  // The injected wrap-up printed its completion marker → the wrap-up is GENUINELY done.
  // Only now do we advance the gate to 'ready' ("Close now"). This is the real signal —
  // an idle-based guess could offer the close before the wrap-up ran.
  const onWrapupComplete = useCallback((runId: string) => {
    setWrappingUp((prev) => {
      const entry = prev[runId];
      if (!entry || entry.phase === 'ready') return prev;
      return { ...prev, [runId]: { ...entry, phase: 'ready' } };
    });
  }, []);

  // Clear a run's wrap-up gate state (entry + any pending injection for it).
  const clearWrapup = useCallback((runId: string) => {
    setWrappingUp((prev) => {
      if (!(runId in prev)) return prev;
      const next = { ...prev };
      delete next[runId];
      return next;
    });
    setInjectSignal((cur) => (cur && cur.runId === runId ? null : cur));
  }, []);

  // Open the forced-wrap-up modal for a claude tab. `origin` records whether the
  // user hit Stop (keep the tab) or ✕ (drop the tab) so "Close now" matches.
  const requestWrapup = useCallback((runId: string, origin: WrapupOrigin) => {
    setWrapupOrigin(origin);
    setWrapupVerdict(null);
    setWrapupNotes('');
    setWrapupModalRunId(runId);
  }, []);

  const cancelWrapup = useCallback(() => {
    // Abort — tab stays open, nothing killed, nothing recorded.
    setWrapupModalRunId(null);
  }, []);

  // Finish the gated close honouring the origin: Stop stops the process but keeps
  // the tab (restartable); ✕ drops the tab entirely.
  const finalizeClose = useCallback(
    (runId: string, origin: WrapupOrigin) => {
      clearWrapup(runId);
      if (origin === 'close') {
        performClose(runId);
      } else {
        void api.stopRun(runId).catch(() => undefined);
      }
    },
    [clearWrapup, performClose],
  );

  // Safety valve — always available while wrapping. Drops the tab no matter what
  // (a hung/misbehaving session must never trap the user; verdict already saved).
  const forceCloseWrapup = useCallback(
    (runId: string) => {
      clearWrapup(runId);
      performClose(runId);
    },
    [clearWrapup, performClose],
  );

  // Submit the modal: record the verdict server-side (fail-soft), then either
  // inject the wrap-up prompt + gate the close (live pty) or just close (dead pty).
  const submitWrapup = useCallback(() => {
    const runId = wrapupModalRunId;
    const verdict = wrapupVerdict;
    if (!runId || !verdict) return;
    const origin = wrapupOrigin;
    const notes = wrapupNotes;
    const run = activeRunsRef.current.find((r) => r.runId === runId);
    // Deterministic capture — never blocks the close flow (server also fail-soft).
    void api.wrapup(runId, verdict, notes).catch(() => undefined);
    setWrapupModalRunId(null);

    const alive = run ? run.status === 'running' || run.status === 'connecting' : false;
    if (!alive) {
      // Dead pty — nothing to run the wrap-up in. Record + close immediately.
      finalizeClose(runId, origin);
      return;
    }

    // Build a single submitted line (collapse newlines so it submits as one).
    const verdictWord = verdict === 'successful' ? 'SUCCESSFUL' : 'UNSUCCESSFUL';
    const notePart = notes.replace(/[\r\n]+/g, ' ').trim() || 'none';
    const text =
      `Run your /wrap-up skill now. Verdict: ${verdictWord}. Notes: ${notePart}. ` +
      `When the wrap-up is FULLY complete, print this exact line on its own as your final output: ${WRAPUP_DONE_MARKER}`;
    setInjectSignal({ runId, text, nonce: Date.now() });
    // Always gate from 'pending' — never from 'working'. Seeding 'working' when
    // the session merely happened to be mid-task at submit time would let the
    // PRE-EXISTING task's next idle read as the wrap-up finishing. From 'pending'
    // those pre-inject idles are ignored; only a FRESH post-inject working edge
    // advances pending→working, and 'ready' comes only from the output marker.
    // (Residual: a fully-merged task→wrap-up output stream that never yields a
    // fresh working edge stays 'pending' — which fails SAFE: Force close still
    // ends the tab and the verdict/notes were already recorded.)
    setWrappingUp((prev) => ({ ...prev, [runId]: { phase: 'pending', origin } }));
  }, [wrapupModalRunId, wrapupVerdict, wrapupOrigin, wrapupNotes, finalizeClose]);

  // "Nothing to log": end the session with NO ceremony — records nothing (no
  // api.wrapup) and injects nothing (no memory/log-consolidation prompt, no gated
  // phase). Just closes the modal and finalizes per origin.
  const closeWithoutLog = useCallback(() => {
    const runId = wrapupModalRunId;
    if (!runId) return;
    const origin = wrapupOrigin;
    setWrapupModalRunId(null);
    finalizeClose(runId, origin);
  }, [wrapupModalRunId, wrapupOrigin, finalizeClose]);

  const closeTab = (runId: string) => {
    // Claude tabs go through the forced wrap-up gate; shell/command tabs close now.
    const run = activeRuns.find((r) => r.runId === runId);
    if (run && run.kind === 'claude') {
      requestWrapup(runId, 'close');
      return;
    }
    performClose(runId);
  };

  // Identity-stable per-run handlers for the memoized TerminalTabs: Stop opens
  // the gate with origin 'stop'; "Close now" finalizes honouring the recorded
  // origin (read via the ref so the callback identity never changes).
  const requestWrapupStop = useCallback(
    (runId: string) => requestWrapup(runId, 'stop'),
    [requestWrapup],
  );
  const wrapupCloseNow = useCallback(
    (runId: string) => {
      const entry = wrappingUpRef.current[runId];
      finalizeClose(runId, entry ? entry.origin : 'close');
    },
    [finalizeClose],
  );

  // Close the wrap-up modal on Escape (same as Cancel — nothing killed).
  useEffect(() => {
    if (!wrapupModalRunId) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.stopPropagation();
        cancelWrapup();
      }
    };
    window.addEventListener('keydown', onKey, true);
    return () => window.removeEventListener('keydown', onKey, true);
  }, [wrapupModalRunId, cancelWrapup]);

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
                    className={`vs-btn ${view === 'browser' ? 'active' : ''}`}
                    onClick={() => confirmLeaveEditor() && setView('browser')}
                  >
                    Browser
                  </button>
                  <button
                    className={`vs-btn ${view === 'eod' ? 'active' : ''}`}
                    onClick={() => confirmLeaveEditor() && setView('eod')}
                  >
                    EOD
                  </button>
                  <button
                    className={`vs-btn ${view === 'release' ? 'active' : ''}`}
                    onClick={() => confirmLeaveEditor() && setView('release')}
                  >
                    Release
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
                  <button
                    className={`vs-btn ${view === 'changelog' ? 'active' : ''}`}
                    onClick={() => confirmLeaveEditor() && setView('changelog')}
                  >
                    Changelog
                  </button>
                  {/* Toggles the terminal dock's two-pane split ONLY — does not
                      change `view`. */}
                  <button
                    className={`vs-btn vs-btn-split ${splitView ? 'active' : ''}`}
                    onClick={() => setSplitView((s) => !s)}
                    title="Side-by-side (two sessions)"
                    aria-pressed={splitView}
                  >
                    S|S
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
                ) : view === 'release' ? (
                  <div className="runner-scroll">
                    <SgaRelease
                      key={selected.id}
                      project={selected}
                      projects={projects}
                      onSelectProject={setSelectedId}
                    />
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
                ) : view === 'changelog' ? (
                  // Repo-global (this app's own commits) — not project-scoped, but
                  // lives in the view-switch alongside EOD/Arsenal.
                  <div className="runner-scroll">
                    <Changelog />
                  </div>
                ) : view === 'browser' ? (
                  <BrowserTab
                    key={selected.id}
                    project={selected}
                    initialUrl={browserUrlByProject[selected.id]}
                    detectedUrl={devUrlByProject[selected.id] ?? null}
                    devices={browserDevices}
                    onUrlChange={setBrowserUrl}
                    onDevicesChange={setBrowserDevices}
                  />
                ) : (
                  <Suspense fallback={<div className="empty">Loading editor…</div>}>
                    <CodeEditor
                      key={selected.id}
                      project={selected}
                      initialFile={editorFileByProject[selected.id]}
                      onOpenFile={(p) => setEditorFile(selected.id, p)}
                      onDirtyChange={setEditorDirty}
                    />
                  </Suspense>
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
          ref={dockRef}
          className={`terminals dock-${dockPosition} ${projectRuns.length ? 'open' : ''} ${
            dockMinimized ? 'minimized' : ''
          } ${dockHint ? 'dock-hint' : ''}`}
          style={
            projectRuns.length && !dockMinimized
              ? dockPosition === 'right'
                ? { width: dockWidth }
                : { height: dockHeight }
              : undefined
          }
        >
          {dockHint && <div className="dock-drop-hint">Drop to dock terminal</div>}
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
                            draggable={splitView}
                            onDragStart={(e) => {
                              dragRunId.current = r.runId;
                              try {
                                e.dataTransfer.setData('text/plain', r.runId);
                              } catch {
                                /* some engines refuse setData on buttons — the ref carries it */
                              }
                              e.dataTransfer.effectAllowed = 'move';
                            }}
                            onDragEnd={() => {
                              dragRunId.current = null;
                              setPaneDropActive(false);
                            }}
                            onPointerDown={(e) => beginTabDrag(e, r.runId)}
                            onClick={() => {
                              selectTab(r.runId);
                              if (dockMinimized) setDockMinimized(false);
                            }}
                            onDoubleClick={() => startRename(r)}
                            title={
                              splitView
                                ? 'Drag into the right pane · double-click to rename'
                                : 'Drag out to a window · double-click to rename'
                            }
                          >
                            <span className={`dot dot-${r.status}`} />
                            {r.elevated ? <><Ic name="shield" /> </> : null}
                            {r.kind === 'shell' ? <><Ic name="shell" /> </> : r.kind === 'claude' ? <><Ic name="spark" /> </> : null}
                            {r.customLabel ?? r.label}
                          </button>
                        )}
                        <button
                          className="tab-close"
                          title={wrappingUp[r.runId] ? 'Wrapping up…' : 'Close tab'}
                          disabled={!!wrappingUp[r.runId]}
                          onClick={() => closeTab(r.runId)}
                        >
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
              <div
                ref={termStackRef}
                className={`term-stack ${splitActive && secondaryRun ? 'split' : ''}`}
              >
                {activeRuns.map((r) => {
                  const isPrimary = activeTab === r.runId;
                  const isSecondary =
                    splitActive && !!secondaryRun && secondaryRun.runId === r.runId;
                  const visible = isPrimary || isSecondary;
                  // In split mode the primary takes the left portion and the
                  // secondary the right; otherwise the visible slot fills the
                  // stack. All other runs stay mounted but display:none (ptys
                  // survive project/tab switches).
                  let style: CSSProperties;
                  if (!visible) style = { display: 'none' };
                  else if (splitActive && isPrimary)
                    style = { display: 'flex', left: 0, right: rightRemainder };
                  else if (isSecondary) style = { display: 'flex', left: leftPct, right: 0 };
                  else style = { display: 'flex' };
                  return (
                    <div
                      key={r.runId}
                      className={`term-slot ${isPrimary ? 'pane-primary' : ''} ${
                        isSecondary ? 'pane-secondary' : ''
                      } ${isSecondary && paneDropActive ? 'drag-over' : ''}`}
                      style={style}
                      // The secondary pane is itself a drop target so the user can
                      // swap which session it shows without unsplitting first.
                      onDragOver={isSecondary ? onPaneDragOver : undefined}
                      onDragLeave={isSecondary ? () => setPaneDropActive(false) : undefined}
                      onDrop={isSecondary ? onPaneDrop : undefined}
                    >
                      {isSecondary && (
                        <button
                          className="pane-unsplit"
                          title="Clear secondary pane"
                          onClick={() => setSecondaryTab(null)}
                        >
                          ×
                        </button>
                      )}
                      <TerminalTab
                        run={r}
                        onStatus={onRunStatus}
                        onRestart={restartRun}
                        onContinue={continueRun}
                        onActivity={onActivity}
                        onDevUrl={handleDevUrl}
                        codeMapEmbed={codeMapEmbedByProject.get(r.projectId) ?? false}
                        onPopOut={desktop() ? popOut : undefined}
                        onRequestWrapup={requestWrapupStop}
                        wrapupPhase={wrappingUp[r.runId]?.phase ?? null}
                        onWrapupClose={wrapupCloseNow}
                        onWrapupForceClose={forceCloseWrapup}
                        injectSignal={
                          injectSignal && injectSignal.runId === r.runId ? injectSignal : null
                        }
                        onWrapupComplete={onWrapupComplete}
                      />
                    </div>
                  );
                })}
                {/* Split on but no secondary yet → right-portion dropzone. */}
                {splitActive && !secondaryRun && (
                  <div
                    className={`term-slot pane-dropzone ${paneDropActive ? 'drag-over' : ''}`}
                    style={{ display: 'flex', left: leftPct, right: 0 }}
                    onDragOver={onPaneDragOver}
                    onDragLeave={() => setPaneDropActive(false)}
                    onDrop={onPaneDrop}
                  >
                    <div className="dropzone-hint">
                      Drag a tab here
                      <span>for a side-by-side session</span>
                    </div>
                  </div>
                )}
                {/* Draggable divider — only with two live panes. Drag to
                    re-proportion, double-click to reset to 50/50. */}
                {splitActive && secondaryRun && (
                  <div
                    className="split-divider"
                    style={{ left: leftPct }}
                    onPointerDown={startSplitResize}
                    onDoubleClick={() => setSplitRatio(0.5)}
                    title="Drag to resize · double-click to reset"
                  />
                )}
              </div>
            </>
          )}
        </section>
      </div>
      {wrapupModalRunId && (
        <div
          className="wrapup-overlay"
          role="dialog"
          aria-modal="true"
          aria-label="Wrap up this session"
          onMouseDown={(e) => {
            // Backdrop click (not a click inside the card) = cancel.
            if (e.target === e.currentTarget) cancelWrapup();
          }}
        >
          <div className="wrapup-modal">
            <div className="wrapup-modal-head">
              <h2>Wrap up this session</h2>
              {wrapupRun && (
                <p className="wrapup-modal-sub">
                  ✦ {wrapupRun.customLabel ?? wrapupRun.label} · {wrapupRun.projectName}
                </p>
              )}
            </div>
            <div className="wrapup-field">
              <span className="wrapup-field-label">Verdict</span>
              <div className="wrapup-verdicts">
                <button
                  type="button"
                  className={`wrapup-verdict ok ${wrapupVerdict === 'successful' ? 'sel' : ''}`}
                  aria-pressed={wrapupVerdict === 'successful'}
                  onClick={() => setWrapupVerdict('successful')}
                >
                  Successful
                </button>
                <button
                  type="button"
                  className={`wrapup-verdict bad ${wrapupVerdict === 'unsuccessful' ? 'sel' : ''}`}
                  aria-pressed={wrapupVerdict === 'unsuccessful'}
                  onClick={() => setWrapupVerdict('unsuccessful')}
                >
                  Unsuccessful
                </button>
              </div>
            </div>
            <div className="wrapup-field">
              <span className="wrapup-field-label">Notes (optional)</span>
              <textarea
                className="wrapup-notes"
                rows={4}
                autoFocus
                value={wrapupNotes}
                placeholder="What happened / anything to remember?"
                onChange={(e) => setWrapupNotes(e.target.value)}
              />
            </div>
            <div className="wrapup-actions">
              <button className="btn btn-ghost" onClick={cancelWrapup}>
                Cancel
              </button>
              <button
                className="btn btn-ghost wrapup-skip"
                title="End the session without logging or a memory pass"
                onClick={closeWithoutLog}
              >
                Nothing to log
              </button>
              <button
                className="btn btn-primary"
                disabled={!wrapupVerdict}
                title={
                  wrapupVerdict
                    ? 'Record the verdict and run the session wrap-up'
                    : 'Pick a verdict first'
                }
                onClick={submitWrapup}
              >
                Wrap up &amp; close
              </button>
            </div>
          </div>
        </div>
      )}
      <Toasts toasts={toasts} onFocus={focusRun} onDismiss={dismissToast} />
    </div>
  );
}
