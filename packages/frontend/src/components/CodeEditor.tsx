import { memo, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import Editor, { type OnMount } from '@monaco-editor/react';
import '../lib/monaco-setup'; // side-effect: offline workers + narukami theme + loader.config
import { api } from '../api';
import { changedFolders, diffDecorations } from '../lib/gitChanges';
import { languageFor } from '../lib/language';
import type { DiffRange, FileNode, GitChange, Project } from '../types';

interface Props {
  project: Project;
  // Restore these open tabs on mount (paths are re-read from disk); `active` is focused.
  initialTabs?: { open: string[]; active: string | null };
  // Report the open-tab set + active tab so the workspace can persist them.
  onTabsChange?: (open: string[], active: string | null) => void;
}

// --- inline SVG tree icons (no emoji; themed via currentColor) ---
function ChevronIcon({ open }: { open: boolean }) {
  return (
    <svg
      className={`ft-chevron ${open ? 'open' : ''}`}
      viewBox="0 0 16 16"
      width="12"
      height="12"
      aria-hidden="true"
    >
      <path
        d="M6 4l4 4-4 4"
        fill="none"
        stroke="currentColor"
        strokeWidth="1.6"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  );
}

function FolderIcon({ open }: { open: boolean }) {
  if (open) {
    return (
      <svg className="ft-icon ft-folder-icon open" viewBox="0 0 16 16" width="15" height="15" aria-hidden="true">
        {/* back panel */}
        <path
          d="M1.5 4a1 1 0 0 1 1-1h3.1a1 1 0 0 1 .72.3l.9.9a1 1 0 0 0 .72.3H13.5a1 1 0 0 1 1 1v1H4.2a1 1 0 0 0-.95.68L1.6 12.6V4z"
          fill="currentColor"
          opacity="0.5"
        />
        {/* open front flap */}
        <path
          d="M3.5 6.5h11a.6.6 0 0 1 .57.79l-1.35 4.3a1 1 0 0 1-.95.7H2.1a.6.6 0 0 1-.57-.79l1.05-4.3a1 1 0 0 1 .92-.7z"
          fill="currentColor"
        />
      </svg>
    );
  }
  return (
    <svg className="ft-icon ft-folder-icon" viewBox="0 0 16 16" width="15" height="15" aria-hidden="true">
      <path
        d="M1.5 3.8a1 1 0 0 1 1-1h3.1a1 1 0 0 1 .72.3l.9.92a1 1 0 0 0 .72.3H13.5a1 1 0 0 1 1 1v6.08a1 1 0 0 1-1 1h-11a1 1 0 0 1-1-1V3.8z"
        fill="currentColor"
      />
    </svg>
  );
}

function FileIcon() {
  return (
    <svg className="ft-icon ft-file-icon" viewBox="0 0 16 16" width="15" height="15" aria-hidden="true">
      <path
        d="M4 1.8h4.5L13 6.3v7.9a1 1 0 0 1-1 1H4a1 1 0 0 1-1-1V2.8a1 1 0 0 1 1-1z"
        fill="currentColor"
        opacity="0.85"
      />
      <path d="M8.4 2v3.5a.6.6 0 0 0 .6.6h3.4" fill="none" stroke="currentColor" strokeWidth="1" opacity="0.45" />
    </svg>
  );
}

interface TreeProps {
  nodes: FileNode[];
  depth: number;
  expanded: Set<string>;
  toggle: (p: string) => void;
  onOpen: (n: FileNode) => void;
  currentPath: string | null;
  // Git working-tree changes: file path → change type, plus the set of folders
  // that contain a change (so a collapsed dir still flags what's inside).
  changed: Map<string, GitChange>;
  changedDirs: Set<string>;
}

// Memoized: `tabs` state lives in CodeEditor, so without this the whole visible
// tree would reconcile on every editor keystroke. All props are referentially
// stable across a keystroke, so the shallow compare bails out. (Recursion uses
// the outer `TreeNodes` const, not the inner name, so memoization applies at
// every level.)
const TreeNodes = memo(function TreeNodesInner({
  nodes,
  depth,
  expanded,
  toggle,
  onOpen,
  currentPath,
  changed,
  changedDirs,
}: TreeProps) {
  return (
    <>
      {nodes.map((n) => {
        const isDir = n.type === 'dir';
        const isOpen = expanded.has(n.path);
        const active = !isDir && currentPath === n.path;
        const status = isDir ? undefined : changed.get(n.path);
        const dirChanged = isDir && changedDirs.has(n.path);
        const changeClass = status ? `changed changed-${status}` : dirChanged ? 'changed-dir' : '';
        return (
          <div key={n.path}>
            <div
              className={`ft-row ${active ? 'active' : ''} ${isDir ? 'ft-dir' : 'ft-file'} ${changeClass}`}
              style={{ paddingLeft: 8 + depth * 13 }}
              onClick={() => (isDir ? toggle(n.path) : onOpen(n))}
              title={n.path}
            >
              {isDir ? (
                <ChevronIcon open={isOpen} />
              ) : (
                <span className="ft-chevron-spacer" />
              )}
              {isDir ? <FolderIcon open={isOpen} /> : <FileIcon />}
              <span className="ft-name">{n.name}</span>
              {status && <span className={`ft-status-dot ${status}`} title={`Modified (${status})`} />}
              {dirChanged && <span className="ft-status-dot dir" title="Contains changes" />}
            </div>
            {isDir && isOpen && n.children && n.children.length > 0 && (
              <TreeNodes
                nodes={n.children}
                depth={depth + 1}
                expanded={expanded}
                toggle={toggle}
                onOpen={onOpen}
                currentPath={currentPath}
                changed={changed}
                changedDirs={changedDirs}
              />
            )}
          </div>
        );
      })}
    </>
  );
});

// One open file. Each tab owns its own buffer, so switching tabs never loses
// unsaved edits; it is also backed by its own Monaco model (undo history +
// scroll/cursor preserved per file).
interface OpenTab {
  path: string;
  content: string; // live buffer, kept in sync via Monaco onChange
  original: string; // disk content at last read/save — drives the dirty flag
  loading: boolean;
  error: string | null;
  saving: boolean;
  saved: boolean; // transient "saved ✓" flash
}

export function CodeEditor({ project, initialTabs, onTabsChange }: Props) {
  const [tree, setTree] = useState<FileNode[]>([]);
  const [truncated, setTruncated] = useState(false);
  const [expanded, setExpanded] = useState<Set<string>>(new Set());
  const [treeErr, setTreeErr] = useState<string | null>(null);
  const [loadingTree, setLoadingTree] = useState(true);

  // Open files (tabs) + which one is focused.
  const [tabs, setTabs] = useState<OpenTab[]>([]);
  const [activePath, setActivePath] = useState<string | null>(null);

  // Search: by file name (client-side filter of the tree) or by code (backend grep).
  const [searchMode, setSearchMode] = useState<'name' | 'code'>('name');
  const [query, setQuery] = useState('');
  const [codeResults, setCodeResults] = useState<{ path: string; line: number; text: string }[]>([]);
  const [codeTruncated, setCodeTruncated] = useState(false);
  const [codeSearching, setCodeSearching] = useState(false);
  const [codeErr, setCodeErr] = useState<string | null>(null);

  const editorRef = useRef<Parameters<OnMount>[0] | null>(null);
  const monacoRef = useRef<Parameters<OnMount>[1] | null>(null);
  const activeTabRef = useRef<HTMLDivElement | null>(null);

  // Mirrors for stable async callbacks (poll/save/decorations) so they never
  // capture stale state.
  const tabsRef = useRef<OpenTab[]>([]);
  const activePathRef = useRef<string | null>(null);
  // Files whose read completed but whose (initially-empty) Monaco model still
  // needs the content pushed in once — see hydrateActiveModel.
  const hydrateRef = useRef<Set<string>>(new Set());
  // In-flight reads (dedupe a rapid double-open of the same file).
  const openInFlightRef = useRef<Set<string>>(new Set());
  // Models awaiting disposal after their tab closed — deferred until the model
  // is no longer the one attached to the live editor (see the dispose effect).
  const pendingDisposeRef = useRef<Set<string>>(new Set());
  const restoredRef = useRef(false);

  // Line to reveal after a file opens (from a code-search hit). Held in a ref so
  // the reveal survives async load and runs once the target model is active; the
  // nonce re-triggers the effect even when the file content is identical.
  const pendingRevealRef = useRef<number | null>(null);
  const [revealNonce, setRevealNonce] = useState(0);

  // Git working-tree changes (path → change type), polled while the editor is
  // open. Drives the file-tree markers; the open file's diff gutter is fetched
  // separately (see refreshOpenDiff). The signature ref suppresses no-op
  // re-renders — and the whole-tree reconcile — when git state hasn't moved.
  const [changed, setChanged] = useState<Map<string, GitChange>>(new Map());
  const gitSigRef = useRef('');
  const gitBusyRef = useRef(false); // in-flight guard so slow polls don't stack
  // Live diff decorations for the ACTIVE file, tracked per model so switching
  // tabs replaces (not duplicates) the right decoration set.
  const decorationsByPathRef = useRef<Map<string, string[]>>(new Map());
  const diffRangesRef = useRef<DiffRange[]>([]);
  const untrackedRef = useRef(false);

  const activeTab = activePath ? tabs.find((t) => t.path === activePath) ?? null : null;
  const dirty = !!activeTab && !activeTab.loading && activeTab.content !== activeTab.original;

  // Monaco model URI, namespaced by project so two projects with the same
  // relative path can't collide on one shared (stale) model.
  const scopeOf = useCallback((p: string) => `${project.id}/${p}`, [project.id]);

  useEffect(() => {
    tabsRef.current = tabs;
  }, [tabs]);
  useEffect(() => {
    activePathRef.current = activePath;
  }, [activePath]);

  // Load the file tree whenever the selected project changes. (This component is
  // keyed by project id in App, so state is otherwise fresh per project.)
  useEffect(() => {
    let cancelled = false;
    setLoadingTree(true);
    setTreeErr(null);
    api
      .getTree(project.id)
      .then((r) => {
        if (cancelled) return;
        setTree(r.tree);
        setTruncated(r.truncated);
        // Auto-expand the first top-level directory for a useful starting view.
        const firstDir = r.tree.find((n) => n.type === 'dir');
        setExpanded(firstDir ? new Set([firstDir.path]) : new Set());
      })
      .catch((e) => {
        if (!cancelled) setTreeErr((e as Error).message);
      })
      .finally(() => {
        if (!cancelled) setLoadingTree(false);
      });
    return () => {
      cancelled = true;
    };
  }, [project.id]);

  const toggle = useCallback((p: string) => {
    setExpanded((cur) => {
      const next = new Set(cur);
      if (next.has(p)) next.delete(p);
      else next.add(p);
      return next;
    });
  }, []);

  // Open a file into a tab (or focus it if already open). New tabs appear
  // immediately (loading) and are focused; the disk read fills them in.
  const openPath = useCallback(
    async (filePath: string, line?: number) => {
      const already = tabsRef.current.some((t) => t.path === filePath);
      if (already) {
        setActivePath(filePath);
        pendingRevealRef.current = line && line > 0 ? line : null;
        if (line && line > 0) setRevealNonce((n) => n + 1);
        return;
      }
      if (openInFlightRef.current.has(filePath)) return; // dedupe rapid double-open
      openInFlightRef.current.add(filePath);
      setTabs((cur) =>
        cur.some((t) => t.path === filePath)
          ? cur
          : [
              ...cur,
              { path: filePath, content: '', original: '', loading: true, error: null, saving: false, saved: false },
            ],
      );
      setActivePath(filePath);
      try {
        const r = await api.readFile(project.id, filePath);
        hydrateRef.current.add(filePath); // model needs the content pushed in once
        setTabs((cur) =>
          cur.map((t) =>
            t.path === filePath ? { ...t, content: r.content, original: r.content, loading: false, error: null } : t,
          ),
        );
        // Set OR clear the pending reveal so a plain open can't fire a stale jump.
        pendingRevealRef.current = line && line > 0 ? line : null;
        if (line && line > 0) setRevealNonce((n) => n + 1);
      } catch (e) {
        setTabs((cur) =>
          cur.map((t) => (t.path === filePath ? { ...t, loading: false, error: (e as Error).message } : t)),
        );
      } finally {
        openInFlightRef.current.delete(filePath);
      }
    },
    [project.id],
  );

  // Flattened file paths for the name-search filter (rebuilt when the tree changes).
  const flatFiles = useMemo(() => {
    const out: string[] = [];
    const rec = (ns: FileNode[]): void => {
      for (const n of ns) {
        if (n.type === 'dir') {
          if (n.children) rec(n.children);
        } else {
          out.push(n.path);
        }
      }
    };
    rec(tree);
    return out;
  }, [tree]);

  // Folders that (transitively) contain a change — collapsed dirs still get a marker.
  const changedDirs = useMemo(() => changedFolders(changed.keys()), [changed]);

  // Paint the active file's changed lines: a colored gutter stripe + subtle line
  // tint (added/modified), or a gutter glyph for a deletion. Reads the latest
  // diff/untracked from refs, and stores the decoration ids per model path so a
  // later repaint of the same model replaces rather than stacks them.
  const applyDecorations = useCallback(() => {
    const ed = editorRef.current;
    const mon = monacoRef.current;
    if (!ed || !mon) return;
    const model = ed.getModel();
    if (!model) return;
    const path = activePathRef.current;
    // The mounted model must match the active path. During an error-then-open
    // remount, handleMount (a child effect) can run before activePathRef is
    // synced by its parent effect — bail rather than store ids under the wrong
    // key (which would strand decorations on the wrong model).
    if (!path || model.uri.toString() !== mon.Uri.parse(scopeOf(path)).toString()) return;
    const specs = diffDecorations(diffRangesRef.current, model.getLineCount(), untrackedRef.current);
    const decos = specs.map((s) => ({
      range: new mon.Range(s.startLine, 1, s.endLine, 1),
      options: s.className
        ? {
            isWholeLine: s.isWholeLine,
            className: s.className,
            linesDecorationsClassName: s.linesDecorationsClassName,
          }
        : { linesDecorationsClassName: s.linesDecorationsClassName },
    }));
    const prev = decorationsByPathRef.current.get(path) ?? [];
    const next = ed.deltaDecorations(prev, decos);
    decorationsByPathRef.current.set(path, next);
  }, [scopeOf]);

  // Reveal + focus a pending line on the live editor. Guards on getModel() so a
  // stale/disposed editor no-ops without clearing the pending line.
  const doReveal = useCallback(() => {
    const line = pendingRevealRef.current;
    const ed = editorRef.current;
    if (!line || !ed || !ed.getModel()) return;
    ed.revealLineInCenter(line);
    ed.setPosition({ lineNumber: line, column: 1 });
    ed.focus();
    pendingRevealRef.current = null;
  }, []);

  // Push a freshly-read file's content into its Monaco model once. The model was
  // created empty when we switched to the (still-loading) tab, and the library's
  // defaultValue won't retro-fill an already-existing model — so we do it here.
  const hydrateActiveModel = useCallback(() => {
    const ed = editorRef.current;
    if (!ed) return;
    const path = activePathRef.current;
    if (!path || !hydrateRef.current.has(path)) return;
    const tab = tabsRef.current.find((t) => t.path === path);
    if (!tab || tab.loading || tab.error) return;
    const model = ed.getModel();
    if (!model) return; // model not attached yet; onMount / the effect will retry
    if (model.getValue() !== tab.content) model.setValue(tab.content);
    hydrateRef.current.delete(path);
    applyDecorations();
    doReveal();
  }, [applyDecorations, doReveal]);

  // Poll git working-tree status so edits (incl. Claude's, made outside the editor)
  // surface within a few seconds. The signature guard skips setState — and the
  // whole-tree re-render — when nothing actually changed; the busy guard stops
  // slow polls from stacking git spawns.
  const refreshGit = useCallback(async () => {
    if (gitBusyRef.current) return;
    gitBusyRef.current = true;
    try {
      const r = await api.getGitStatus(project.id);
      const sig = r.files.map((f) => `${f.path}:${f.status}`).join('|');
      if (sig === gitSigRef.current) return;
      gitSigRef.current = sig;
      const m = new Map<string, GitChange>();
      for (const f of r.files) m.set(f.path, f.status);
      setChanged(m);
    } catch {
      /* status is a decoration — never fatal */
    } finally {
      gitBusyRef.current = false;
    }
  }, [project.id]);

  // Fetch changed line ranges for the ACTIVE file and repaint its gutter.
  // Decoupled from `changed` on purpose: git collapses every edit to the same
  // "modified" bucket, so re-editing an already-modified file leaves the status
  // signature unchanged — the gutter has to refresh on its own cadence (poll +
  // save + tab switch), keyed on the file path rather than the coarse status set.
  const refreshOpenDiff = useCallback(async () => {
    const fp = activePathRef.current;
    if (!fp) {
      diffRangesRef.current = [];
      untrackedRef.current = false;
      applyDecorations();
      return;
    }
    try {
      const r = await api.getGitDiff(project.id, fp);
      if (activePathRef.current !== fp) return; // file switched mid-flight
      untrackedRef.current = r.isRepo && !r.tracked;
      diffRangesRef.current = r.ranges;
    } catch {
      if (activePathRef.current !== fp) return;
      diffRangesRef.current = [];
      untrackedRef.current = false;
    }
    applyDecorations();
  }, [project.id, applyDecorations]);

  useEffect(() => {
    gitSigRef.current = '';
    setChanged(new Map());
    void refreshGit();
    void refreshOpenDiff();
    const t = setInterval(() => {
      void refreshGit();
      void refreshOpenDiff();
    }, 3000);
    return () => clearInterval(t);
  }, [refreshGit, refreshOpenDiff]);

  // Refetch the gutter when the active file changes (independent of the poll).
  // Drop the previous file's ranges first so they can't paint onto the new
  // model in the window before the refetch resolves.
  useEffect(() => {
    diffRangesRef.current = [];
    untrackedRef.current = false;
    void refreshOpenDiff();
  }, [activePath, refreshOpenDiff]);

  // Hydrate the active model once its content has loaded.
  useEffect(() => {
    hydrateActiveModel();
  }, [tabs, activePath, hydrateActiveModel]);

  // Re-apply decorations on edits / tab switch so an untracked file's whole-file
  // highlight tracks new lines and decorations survive buffer changes.
  useEffect(() => {
    applyDecorations();
  }, [activeTab?.content, activePath, applyDecorations]);

  // Dispose models for closed tabs, but only once the model is no longer the one
  // attached to the live editor (disposing the on-screen model would leave the
  // editor pointed at a dead model until React swaps in the neighbour). Runs
  // every render; cheap no-op when nothing is pending.
  useEffect(() => {
    const mon = monacoRef.current;
    if (!mon || pendingDisposeRef.current.size === 0) return;
    const activeUri = editorRef.current?.getModel()?.uri.toString();
    for (const p of [...pendingDisposeRef.current]) {
      const uri = mon.Uri.parse(scopeOf(p));
      if (uri.toString() === activeUri) continue; // still on screen; wait for the swap
      const m = mon.editor.getModel(uri);
      if (m && !m.isDisposed()) m.dispose();
      decorationsByPathRef.current.delete(p);
      hydrateRef.current.delete(p);
      pendingDisposeRef.current.delete(p);
    }
  });

  // On unmount (project switch remounts this component), dispose every model we
  // created — open tabs plus any still queued for disposal — so a namespaced
  // path can't be reused with stale content next time. (With keepCurrentModel
  // the library no longer disposes the active model for us.)
  useEffect(
    () => () => {
      const mon = monacoRef.current;
      if (!mon) return;
      const paths = new Set<string>([...tabsRef.current.map((t) => t.path), ...pendingDisposeRef.current]);
      for (const p of paths) {
        const m = mon.editor.getModel(mon.Uri.parse(`${project.id}/${p}`));
        if (m && !m.isDisposed()) m.dispose();
      }
    },
    [project.id],
  );

  const nameResults = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (searchMode !== 'name' || !q) return [];
    return flatFiles.filter((p) => p.toLowerCase().includes(q)).slice(0, 300);
  }, [flatFiles, query, searchMode]);

  // Debounced backend content search.
  useEffect(() => {
    const q = query.trim();
    if (searchMode !== 'code' || !q) {
      setCodeResults([]);
      setCodeTruncated(false);
      setCodeErr(null);
      setCodeSearching(false);
      return;
    }
    setCodeSearching(true);
    let cancelled = false;
    const t = setTimeout(() => {
      api
        .searchCode(project.id, q)
        .then((r) => {
          if (cancelled) return;
          setCodeResults(r.matches);
          setCodeTruncated(r.truncated);
          setCodeErr(null);
        })
        .catch((e) => {
          if (!cancelled) setCodeErr((e as Error).message);
        })
        .finally(() => {
          if (!cancelled) setCodeSearching(false);
        });
    }, 300);
    return () => {
      cancelled = true;
      clearTimeout(t);
    };
  }, [project.id, query, searchMode]);

  useEffect(() => {
    doReveal();
  }, [revealNonce, activeTab?.content, doReveal]);

  const openFile = useCallback(
    (node: FileNode) => {
      if (node.type !== 'file') return;
      void openPath(node.path);
    },
    [openPath],
  );

  // Restore the previously-open tab set once the tree has loaded (runs once).
  useEffect(() => {
    if (loadingTree || restoredRef.current) return;
    restoredRef.current = true;
    const it = initialTabs;
    if (!it || it.open.length === 0) return;
    void (async () => {
      for (const p of it.open) await openPath(p);
      if (it.active) setActivePath(it.active);
    })();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [loadingTree]);

  // Report the open-tab set + active tab up for persistence. Keyed on the path
  // signature (not tab objects) so keystrokes don't churn it. Gated on restore:
  // on a fresh remount `tabs` is empty and `restored` is false, so without this
  // guard the first run would report an empty set and clobber the persisted tabs
  // before the (tree-gated) restore effect can read them.
  const openSig = tabs.map((t) => t.path).join('\n');
  useEffect(() => {
    if (!restoredRef.current) return;
    onTabsChange?.(openSig ? openSig.split('\n') : [], activePath);
  }, [openSig, activePath, onTabsChange]);

  // Keep the focused tab visible when the strip overflows horizontally.
  useEffect(() => {
    activeTabRef.current?.scrollIntoView({ inline: 'nearest', block: 'nearest' });
  }, [activePath]);

  // Save the active tab on Ctrl/Cmd+S from anywhere in the editor view (Monaco's
  // own command only fires while the editor widget holds focus; this also stops
  // the host's Save-page default when focus is in the tree/search).
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.ctrlKey || e.metaKey) && !e.altKey && (e.key === 's' || e.key === 'S')) {
        e.preventDefault();
        saveRef.current();
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);

  // Keep a ref to the latest save so Monaco's Ctrl+S command isn't a stale closure.
  const saveRef = useRef<() => void>(() => undefined);
  const save = useCallback(async () => {
    const path = activePathRef.current;
    if (!path) return;
    const tab = tabsRef.current.find((t) => t.path === path);
    if (!tab || tab.saving || tab.loading || tab.content === tab.original) return;
    const body = tab.content;
    setTabs((cur) => cur.map((t) => (t.path === path ? { ...t, saving: true, error: null } : t)));
    try {
      await api.saveFile(project.id, path, body);
      setTabs((cur) => cur.map((t) => (t.path === path ? { ...t, original: body, saving: false, saved: true } : t)));
      // Reflect the save immediately: tree markers (refreshGit) + the saved
      // file's gutter (refreshOpenDiff — git keeps it in the same "modified"
      // bucket, so the status signature alone wouldn't refresh it).
      void refreshGit();
      void refreshOpenDiff();
    } catch (e) {
      setTabs((cur) => cur.map((t) => (t.path === path ? { ...t, saving: false, error: (e as Error).message } : t)));
    }
  }, [project.id, refreshGit, refreshOpenDiff]);
  saveRef.current = save;

  const handleChange = useCallback((v: string | undefined) => {
    const path = activePathRef.current;
    if (!path) return;
    setTabs((cur) => cur.map((t) => (t.path === path && !t.loading ? { ...t, content: v ?? '', saved: false } : t)));
  }, []);

  const closeTab = useCallback((path: string) => {
    const tab = tabsRef.current.find((t) => t.path === path);
    if (tab && !tab.loading && tab.content !== tab.original) {
      const name = path.split('/').pop() ?? path;
      // Closing discards the buffer — confirm before losing unsaved edits.
      if (!window.confirm(`Discard unsaved changes to ${name}?`)) return;
    }
    setActivePath((prev) => {
      if (prev !== path) return prev; // closed a background tab; focus unchanged
      const cur = tabsRef.current;
      const idx = cur.findIndex((t) => t.path === path);
      const remaining = cur.filter((t) => t.path !== path);
      if (remaining.length === 0) return null;
      return remaining[Math.min(idx, remaining.length - 1)].path;
    });
    setTabs((cur) => cur.filter((t) => t.path !== path));
    // Clear the in-flight guard so closing a still-loading file doesn't block
    // reopening it before its (now-orphaned) read resolves.
    openInFlightRef.current.delete(path);
    pendingDisposeRef.current.add(path); // model disposed by the dispose effect
  }, []);

  const handleMount: OnMount = (editor, monaco) => {
    editorRef.current = editor;
    monacoRef.current = monaco;
    editor.addCommand(monaco.KeyMod.CtrlCmd | monaco.KeyCode.KeyS, () => saveRef.current());
    hydrateActiveModel(); // fill content if the read resolved before mount
    applyDecorations(); // paint gutter for the freshly-mounted editor
    doReveal(); // complete a pending jump-to-line on the new editor
  };

  return (
    <div className="editor-view">
      <aside className="file-tree">
        {loadingTree ? (
          <div className="ft-note">Loading tree…</div>
        ) : treeErr ? (
          <div className="ft-note ft-err">{treeErr}</div>
        ) : (
          <>
            <div className="ft-search">
              <div className="ft-search-modes">
                <button
                  className={`ft-mode ${searchMode === 'name' ? 'active' : ''}`}
                  onClick={() => setSearchMode('name')}
                  title="Find files by name"
                >
                  Name
                </button>
                <button
                  className={`ft-mode ${searchMode === 'code' ? 'active' : ''}`}
                  onClick={() => setSearchMode('code')}
                  title="Search inside file contents"
                >
                  Code
                </button>
              </div>
              <div className="ft-search-box">
                <input
                  className="ft-search-input"
                  placeholder={searchMode === 'name' ? 'Search file name…' : 'Search in files…'}
                  value={query}
                  onChange={(e) => setQuery(e.target.value)}
                  spellCheck={false}
                  autoCorrect="off"
                  autoCapitalize="off"
                />
                {query && (
                  <button className="ft-search-clear" title="Clear" onClick={() => setQuery('')}>
                    ×
                  </button>
                )}
              </div>
            </div>

            <div className="ft-body">
              {query.trim() ? (
                searchMode === 'name' ? (
                  nameResults.length === 0 ? (
                    <div className="ft-note">No file names match.</div>
                  ) : (
                    nameResults.map((p) => {
                      const st = changed.get(p);
                      return (
                        <div
                          key={p}
                          className={`ft-row ft-file ${activePath === p ? 'active' : ''} ${
                            st ? `changed changed-${st}` : ''
                          }`}
                          style={{ paddingLeft: 8 }}
                          title={p}
                          onClick={() => void openPath(p)}
                        >
                          <span className="ft-chevron-spacer" />
                          <FileIcon />
                          <span className="ft-name ft-name-path">{p}</span>
                          {st && <span className={`ft-status-dot ${st}`} title={`Modified (${st})`} />}
                        </div>
                      );
                    })
                  )
                ) : (
                  <>
                    {codeSearching && <div className="ft-note">Searching…</div>}
                    {codeErr && <div className="ft-note ft-err">{codeErr}</div>}
                    {!codeSearching && !codeErr && codeResults.length === 0 && (
                      <div className="ft-note">No matches.</div>
                    )}
                    {codeResults.map((m, i) => (
                      <div
                        key={`${m.path}:${m.line}:${i}`}
                        className="ft-hit"
                        title={`${m.path}:${m.line}`}
                        onClick={() => void openPath(m.path, m.line)}
                      >
                        <div className="ft-hit-loc">
                          {m.path.split('/').pop()}
                          <span className="ft-hit-line">:{m.line}</span>
                          <span className="ft-hit-dir">{m.path}</span>
                        </div>
                        <div className="ft-hit-text">{m.text}</div>
                      </div>
                    ))}
                    {codeTruncated && (
                      <div className="ft-note ft-trunc">
                        Showing the first {codeResults.length} matches.
                      </div>
                    )}
                  </>
                )
              ) : tree.length === 0 ? (
                <div className="ft-note">Empty project.</div>
              ) : (
                <>
                  <TreeNodes
                    nodes={tree}
                    depth={0}
                    expanded={expanded}
                    toggle={toggle}
                    onOpen={openFile}
                    currentPath={activePath}
                    changed={changed}
                    changedDirs={changedDirs}
                  />
                  {truncated && (
                    <div className="ft-note ft-trunc">
                      Tree truncated — some files hidden (large project).
                    </div>
                  )}
                </>
              )}
            </div>
          </>
        )}
      </aside>

      <div className="editor-main">
        {tabs.length > 0 && (
          <div className="editor-tabs" role="tablist">
            {tabs.map((t) => {
              const isActive = t.path === activePath;
              const tdirty = !t.loading && t.content !== t.original;
              const name = t.path.split('/').pop() ?? t.path;
              return (
                <div
                  key={t.path}
                  ref={isActive ? activeTabRef : undefined}
                  className={`etab ${isActive ? 'active' : ''} ${tdirty ? 'dirty' : ''} ${t.error ? 'err' : ''}`}
                  role="tab"
                  aria-selected={isActive}
                  title={t.path}
                  onMouseDown={(e) => {
                    if (e.button === 1) {
                      e.preventDefault(); // middle-click closes
                      closeTab(t.path);
                    }
                  }}
                  onClick={() => setActivePath(t.path)}
                >
                  {tdirty ? <span className="etab-dot" title="Unsaved changes" /> : null}
                  <span className="etab-name">{name}</span>
                  <button
                    className="etab-close"
                    title="Close"
                    aria-label={`Close ${name}`}
                    onClick={(e) => {
                      e.stopPropagation();
                      closeTab(t.path);
                    }}
                  >
                    ×
                  </button>
                </div>
              );
            })}
          </div>
        )}

        <div className="editor-toolbar">
          <span className="editor-path">
            {activeTab ? (
              <>
                {dirty && <span className="dirty-dot" title="Unsaved changes" />}
                {activeTab.path}
              </>
            ) : (
              <span className="muted">No file open</span>
            )}
          </span>
          {activeTab?.error && <span className="editor-file-err">{activeTab.error}</span>}
          {activeTab?.saved && !dirty && <span className="editor-saved">saved ✓</span>}
          <button
            className="btn btn-primary editor-save"
            onClick={() => void save()}
            disabled={!dirty || !!activeTab?.saving}
          >
            {activeTab?.saving ? 'Saving…' : 'Save'}
          </button>
        </div>

        <div className="editor-host">
          {!activeTab ? (
            <div className="editor-empty">Select a file from the tree to edit it.</div>
          ) : activeTab.error ? (
            <div className="editor-empty">Couldn’t open this file: {activeTab.error}</div>
          ) : (
            <>
              <Editor
                path={scopeOf(activeTab.path)}
                theme="narukami"
                defaultLanguage={languageFor(activeTab.path)}
                defaultValue={activeTab.content}
                // Keep models across <Editor> unmount (e.g. switching to an error
                // tab or the empty state) so undo history + edits survive; this
                // component disposes models itself on close + on project switch.
                keepCurrentModel
                onChange={handleChange}
                onMount={handleMount}
                options={{
                  fontFamily: "'JetBrains Mono', 'Fira Code', Consolas, monospace",
                  fontSize: 13,
                  minimap: { enabled: true },
                  smoothScrolling: true,
                  scrollBeyondLastLine: false,
                  automaticLayout: true,
                  tabSize: 2,
                  cursorBlinking: 'smooth',
                  renderWhitespace: 'selection',
                  padding: { top: 8 },
                }}
              />
              {activeTab.loading && <div className="editor-loading-overlay">Opening…</div>}
            </>
          )}
        </div>
      </div>
    </div>
  );
}
