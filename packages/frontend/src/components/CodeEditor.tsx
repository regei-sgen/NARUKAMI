import { memo, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import Editor, { DiffEditor, type OnMount } from '@monaco-editor/react';
import '../lib/monaco-setup'; // side-effect: offline workers + narukami theme + loader.config
import { api } from '../api';
import { changedFolders, diffDecorations } from '../lib/gitChanges';
import { onWindowVisibility, windowHidden } from '../lib/visibility';
import { Markdown, isMarkdownPath } from '../lib/markdown';
import type { DiffRange, FileNode, GitBranch, GitChange, Project } from '../types';
import { Ic } from './icons';
import { ChangesPanel } from './ChangesPanel';

interface Props {
  project: Project;
  initialFile?: string; // restore this file on mount (path re-read from disk)
  onOpenFile?: (path: string) => void; // report opens so the workspace can persist them
  onDirtyChange?: (dirty: boolean) => void; // report unsaved-edits state to the parent
}

const LANG_BY_EXT: Record<string, string> = {
  ts: 'typescript',
  tsx: 'typescript',
  mts: 'typescript',
  cts: 'typescript',
  js: 'javascript',
  jsx: 'javascript',
  mjs: 'javascript',
  cjs: 'javascript',
  json: 'json',
  css: 'css',
  scss: 'scss',
  less: 'less',
  html: 'html',
  htm: 'html',
  xml: 'xml',
  svg: 'xml',
  vue: 'html',
  md: 'markdown',
  markdown: 'markdown',
  py: 'python',
  rb: 'ruby',
  go: 'go',
  rs: 'rust',
  java: 'java',
  kt: 'kotlin',
  c: 'c',
  h: 'c',
  cpp: 'cpp',
  cc: 'cpp',
  hpp: 'cpp',
  cs: 'csharp',
  php: 'php',
  phtml: 'php',
  php4: 'php',
  php5: 'php',
  ctp: 'php',
  sh: 'shell',
  bash: 'shell',
  zsh: 'shell',
  ps1: 'powershell',
  yml: 'yaml',
  yaml: 'yaml',
  toml: 'ini',
  ini: 'ini',
  env: 'ini',
  sql: 'sql',
  graphql: 'graphql',
  gql: 'graphql',
};

function languageFor(filePath: string): string {
  const base = filePath.split('/').pop() ?? '';
  const lower = base.toLowerCase();
  if (lower === 'dockerfile' || lower.startsWith('dockerfile.')) return 'dockerfile';
  if (lower === '.gitignore' || lower === '.dockerignore' || lower === '.npmignore') return 'plaintext';
  if (lower.startsWith('.env')) return 'ini';
  const ext = base.includes('.') ? base.split('.').pop()!.toLowerCase() : '';
  return LANG_BY_EXT[ext] ?? 'plaintext';
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

/**
 * Replace one directory's children in an immutable tree. Only the branch on the
 * way to `target` is rebuilt, so every untouched subtree keeps its identity and
 * the memoized rows below it don't reconcile.
 */
function withChildren(nodes: FileNode[], target: string, children: FileNode[]): FileNode[] {
  return nodes.map((n) => {
    if (n.path === target) return { ...n, children, loaded: true };
    if (n.type === 'dir' && n.children && target.startsWith(`${n.path}/`)) {
      return { ...n, children: withChildren(n.children, target, children) };
    }
    return n;
  });
}

interface TreeProps {
  nodes: FileNode[];
  depth: number;
  expanded: Set<string>;
  toggle: (n: FileNode) => void;
  onOpen: (n: FileNode) => void;
  currentPath: string | null;
  // Git working-tree changes: file path → change type, plus the set of folders
  // that contain a change (so a collapsed dir still flags what's inside).
  changed: Map<string, GitChange>;
  changedDirs: Set<string>;
  // Directories whose listing is in flight (big projects load folders on demand).
  loadingDirs: Set<string>;
}

// Memoized: `content` state lives in CodeEditor, so without this the whole
// visible tree would reconcile on every editor keystroke. All props are
// referentially stable across a keystroke, so the shallow compare bails out.
// (Recursion uses the outer `TreeNodes` const, not the inner name, so the
// memoization applies at every level.)
const TreeNodes = memo(function TreeNodesInner({
  nodes,
  depth,
  expanded,
  toggle,
  onOpen,
  currentPath,
  changed,
  changedDirs,
  loadingDirs,
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
              onClick={() => (isDir ? toggle(n) : onOpen(n))}
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
                loadingDirs={loadingDirs}
              />
            )}
            {isDir && isOpen && !n.children && loadingDirs.has(n.path) && (
              <div className="ft-loading" style={{ paddingLeft: 8 + (depth + 1) * 13 }}>
                Loading…
              </div>
            )}
          </div>
        );
      })}
    </>
  );
});

export function CodeEditor({ project, initialFile, onOpenFile, onDirtyChange }: Props) {
  const [tree, setTree] = useState<FileNode[]>([]);
  const [expanded, setExpanded] = useState<Set<string>>(new Set());
  const [loadingDirs, setLoadingDirs] = useState<Set<string>>(new Set());
  const [treeErr, setTreeErr] = useState<string | null>(null);
  const [dirErr, setDirErr] = useState<string | null>(null); // one folder failed to list
  const [loadingTree, setLoadingTree] = useState(true);

  const [currentPath, setCurrentPath] = useState<string | null>(null);
  const [content, setContent] = useState('');
  const [original, setOriginal] = useState('');
  const [originalMtime, setOriginalMtime] = useState<number | null>(null);
  const [conflict, setConflict] = useState(false);
  const [fileErr, setFileErr] = useState<string | null>(null);

  // On-disk state of the OPEN file, polled cheaply (stat, not a re-read). Claude
  // and other tools edit files behind the editor, so the buffer can silently go
  // stale; these drive the Refresh button's "changed on disk" flag.
  const [diskMtime, setDiskMtime] = useState<number | null>(null);
  const [diskGone, setDiskGone] = useState(false);
  const [refreshing, setRefreshing] = useState(false);
  const [loadingFile, setLoadingFile] = useState(false);
  const [saving, setSaving] = useState(false);
  const [saved, setSaved] = useState(false);

  // Sidebar tab: file Explorer (tree + search) or git Changes (source control).
  const [leftTab, setLeftTab] = useState<'explorer' | 'changes'>('explorer');

  // Search: by file name or by code — both server-side, because the tree can be
  // partly lazy on a big project and a client-side filter would only ever see
  // the folders that happen to be loaded.
  const [searchMode, setSearchMode] = useState<'name' | 'code'>('name');
  const [query, setQuery] = useState('');
  const [nameResults, setNameResults] = useState<string[]>([]);
  const [nameTruncated, setNameTruncated] = useState(false);
  const [nameSearching, setNameSearching] = useState(false);
  const [nameErr, setNameErr] = useState<string | null>(null);
  const [codeResults, setCodeResults] = useState<{ path: string; line: number; text: string }[]>([]);
  const [codeTruncated, setCodeTruncated] = useState(false);
  const [codeSearching, setCodeSearching] = useState(false);
  const [codeErr, setCodeErr] = useState<string | null>(null);

  // Markdown files can be read rendered instead of as source. Sticky across
  // files so browsing docs doesn't need a click per file.
  const [mdPreview, setMdPreview] = useState(false);

  const editorRef = useRef<Parameters<OnMount>[0] | null>(null);
  const monacoRef = useRef<Parameters<OnMount>[1] | null>(null);
  // Open sequencing so a slow read can't overwrite a newer file the user clicked.
  const openSeqRef = useRef(0);
  // Line to reveal after a file opens (from a code-search hit). Held in a ref so
  // the reveal survives the <Editor> remount and runs once the new editor mounts;
  // the nonce re-triggers the effect even when the file content is identical.
  const pendingRevealRef = useRef<number | null>(null);
  const [revealNonce, setRevealNonce] = useState(0);
  // Cursor + scroll offset captured just before a disk refresh, reapplied once the
  // reloaded content reaches the model (see the effect near refreshFromDisk).
  // Deliberately NOT Monaco's saveViewState/restoreViewState: restoring a full view
  // state cancels in-flight folding work and leaks a `Canceled` rejection to the
  // window. These two coarse settings are all the position we actually need.
  const pendingViewRef = useRef<{ lineNumber: number; column: number; scrollTop: number } | null>(null);

  // Git working-tree changes (path → change type), polled while the editor is
  // open. Drives the file-tree markers; the open file's diff gutter is fetched
  // separately (see refreshOpenDiff). The signature ref suppresses no-op
  // re-renders — and the whole-tree reconcile — when git state hasn't moved.
  const [changed, setChanged] = useState<Map<string, GitChange>>(new Map());
  const gitSigRef = useRef('');
  const gitBusyRef = useRef(false); // in-flight guard so slow polls don't stack
  // Live diff decorations for the open file (Monaco decoration ids + source data).
  const decorationsRef = useRef<string[]>([]);
  const diffRangesRef = useRef<DiffRange[]>([]);
  const untrackedRef = useRef(false);

  // Git integration (read-only): live branch label + committed-vs-working diff.
  const [branch, setBranch] = useState<GitBranch | null>(null);
  const [showDiff, setShowDiff] = useState(false);
  const [headContent, setHeadContent] = useState('');
  const [headCommitted, setHeadCommitted] = useState(true);
  const [headLoading, setHeadLoading] = useState(false);

  const dirty = currentPath !== null && content !== original;

  // Latest open path, readable from inside an in-flight async save so we don't
  // apply a save's result to a DIFFERENT file the user switched to meanwhile
  // (which corrupted dirty tracking).
  const currentPathRef = useRef(currentPath);
  currentPathRef.current = currentPath;

  // Same idea for the project: a folder listing in flight when the user switches
  // projects must not be merged into the new project's tree.
  const projectIdRef = useRef(project.id);
  projectIdRef.current = project.id;

  // Report unsaved-edits state upward so the parent can guard view/project
  // switches; always clear it on unmount.
  useEffect(() => {
    onDirtyChange?.(dirty);
  }, [dirty, onDirtyChange]);
  useEffect(() => () => onDirtyChange?.(false), [onDirtyChange]);

  // Poll the current git branch (~3.5s) so the label tracks external switches.
  useEffect(() => {
    let alive = true;
    const tick = () => {
      api
        .getGitBranch(project.id)
        .then((b) => {
          // Identity-bail when unchanged so the poll doesn't re-render the
          // whole editor subtree (tree + Monaco wrapper) every 3.5s.
          if (alive)
            setBranch((prev) =>
              prev && b && prev.branch === b.branch && prev.detached === b.detached ? prev : b,
            );
        })
        .catch(() => {
          if (alive) setBranch(null);
        });
    };
    tick();
    // Branch rarely changes and each tick spawns a git process backend-side —
    // pause while the window is hidden, catch up on restore.
    const id = setInterval(() => {
      if (!windowHidden()) tick();
    }, 3500);
    const offVis = onWindowVisibility((hidden) => {
      if (!hidden) tick();
    });
    return () => {
      alive = false;
      clearInterval(id);
      offVis();
    };
  }, [project.id]);

  // Lazily load the committed (HEAD) version when the diff is shown / file changes.
  useEffect(() => {
    if (!showDiff || !currentPath) return;
    let cancelled = false;
    setHeadLoading(true);
    api
      .getFileHead(project.id, currentPath)
      .then((r) => {
        if (cancelled) return;
        setHeadContent(r.content);
        setHeadCommitted(r.committed);
      })
      .catch(() => {
        if (!cancelled) {
          setHeadContent('');
          setHeadCommitted(false);
        }
      })
      .finally(() => {
        if (!cancelled) setHeadLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [showDiff, currentPath, project.id]);

  // Load the file tree whenever the selected project changes.
  useEffect(() => {
    let cancelled = false;
    setLoadingTree(true);
    setTreeErr(null);
    setCurrentPath(null);
    setContent('');
    setOriginal('');
    setOriginalMtime(null);
    setConflict(false);
    setLoadingDirs(new Set());
    setDirErr(null);
    api
      .getTree(project.id)
      .then((r) => {
        if (cancelled) return;
        setTree(r.tree);
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

  const toggle = useCallback((node: FileNode) => {
    setExpanded((cur) => {
      const next = new Set(cur);
      if (next.has(node.path)) next.delete(node.path);
      else next.add(node.path);
      return next;
    });
  }, []);

  // On a big project the tree arrives with distant folders deferred
  // (`loaded === false`). Whenever one of those is expanded — by a click or by
  // the auto-expand above — pull its FULL listing, so an open folder always
  // shows everything it holds rather than a silently clipped slice.
  useEffect(() => {
    const missing: string[] = [];
    const scan = (ns: FileNode[]): void => {
      for (const n of ns) {
        if (n.type !== 'dir') continue;
        if (n.loaded === false && !n.children && expanded.has(n.path) && !loadingDirs.has(n.path)) {
          missing.push(n.path);
        }
        if (n.children) scan(n.children);
      }
    };
    scan(tree);
    if (missing.length === 0) return;

    setLoadingDirs((cur) => {
      const next = new Set(cur);
      for (const p of missing) next.add(p);
      return next;
    });
    for (const p of missing) {
      const forProject = project.id;
      api
        .getDir(forProject, p)
        .then((r) => {
          // Ignore a listing that lands after the user switched projects — the
          // path could collide with a same-named folder in the new tree.
          if (projectIdRef.current !== forProject) return;
          setTree((cur) => withChildren(cur, p, r.children));
        })
        .catch((e) => {
          if (projectIdRef.current !== forProject) return;
          // A folder that won't list must not wipe out the whole Explorer —
          // collapse it again and say so under the tree.
          setDirErr(`${p}: ${(e as Error).message}`);
          setExpanded((cur) => {
            const next = new Set(cur);
            next.delete(p);
            return next;
          });
        })
        .finally(() => {
          setLoadingDirs((cur) => {
            const next = new Set(cur);
            next.delete(p);
            return next;
          });
        });
    }
  }, [tree, expanded, loadingDirs, project.id]);

  const openPath = useCallback(
    async (filePath: string, line?: number) => {
      const seq = (openSeqRef.current += 1); // newest open wins if reads overlap
      setLoadingFile(true);
      setFileErr(null);
      setSaved(false);
      // Drop the previous file's diff so a remount can't paint its ranges here.
      diffRangesRef.current = [];
      untrackedRef.current = false;
      try {
        const r = await api.readFile(project.id, filePath);
        if (openSeqRef.current !== seq) return; // superseded by a newer open
        currentPathRef.current = filePath;
        setCurrentPath(filePath);
        setContent(r.content);
        setOriginal(r.content);
        setOriginalMtime(r.mtimeMs);
        // A just-read file is by definition in sync with disk.
        setDiskMtime(r.mtimeMs);
        setDiskGone(false);
        setConflict(false);
        // Set OR clear the pending reveal: a plain open (no line) must wipe any
        // stale reveal so it can't fire on the wrong file when it mounts.
        pendingRevealRef.current = line && line > 0 ? line : null;
        if (line && line > 0) setRevealNonce((n) => n + 1);
        onOpenFile?.(filePath); // persist as the project's last-open file
      } catch (e) {
        if (openSeqRef.current !== seq) return;
        setFileErr((e as Error).message);
      } finally {
        if (openSeqRef.current === seq) setLoadingFile(false);
      }
    },
    [project.id, onOpenFile],
  );

  // Open a changed file from the Changes panel in the side-by-side diff. A
  // deleted file has no working copy: load HEAD and diff it against empty.
  const openDiff = useCallback(
    async (filePath: string, deleted: boolean) => {
      setShowDiff(true);
      if (deleted) {
        setCurrentPath(filePath);
        setContent('');
        setOriginal('');
        try {
          const r = await api.getFileHead(project.id, filePath);
          setHeadContent(r.content);
          setHeadCommitted(r.committed);
        } catch {
          setHeadContent('');
          setHeadCommitted(false);
        }
        return;
      }
      await openPath(filePath);
    },
    [openPath, project.id],
  );

  // Folders that (transitively) contain a change — collapsed dirs still get a marker.
  const changedDirs = useMemo(() => changedFolders(changed.keys()), [changed]);

  // Paint the open file's changed lines: a colored gutter stripe + subtle line
  // tint (added/modified), or a gutter glyph for a deletion. Reads the latest
  // diff/untracked from refs so it can be called from mount, poll, or edits.
  const applyDecorations = useCallback(() => {
    const ed = editorRef.current;
    const mon = monacoRef.current;
    if (!ed || !mon) return;
    const model = ed.getModel();
    if (!model) return;
    const specs = diffDecorations(
      diffRangesRef.current,
      model.getLineCount(),
      untrackedRef.current,
    );
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
    decorationsRef.current = ed.deltaDecorations(decorationsRef.current, decos);
  }, []);

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

  // Probe the open file's on-disk mtime (stat only — no content). Runs on the same
  // cadence as the git polls so an external edit surfaces within a few seconds.
  const refreshDiskStat = useCallback(async () => {
    const fp = currentPathRef.current;
    if (!fp) {
      setDiskMtime(null);
      setDiskGone(false);
      return;
    }
    try {
      const s = await api.statFile(project.id, fp);
      if (currentPathRef.current !== fp) return; // file switched mid-flight
      setDiskGone(false);
      setDiskMtime(s.mtimeMs);
    } catch (e) {
      if (currentPathRef.current !== fp) return;
      // Only a genuine 404 means "gone"; any other probe failure is transient and
      // must not raise a false alarm on the toolbar.
      setDiskGone(/not found/i.test((e as Error).message));
    }
  }, [project.id]);

  // Fetch changed line ranges for the OPEN file and repaint the gutter. Decoupled
  // from `changed` on purpose: git collapses every edit to the same "modified"
  // bucket, so re-editing an already-modified file leaves the status signature
  // unchanged — the gutter has to refresh on its own cadence (poll + save + open),
  // keyed on the file path rather than the coarse status set, or it would freeze.
  const refreshOpenDiff = useCallback(async () => {
    const fp = currentPathRef.current;
    if (!fp) {
      diffRangesRef.current = [];
      untrackedRef.current = false;
      applyDecorations();
      return;
    }
    try {
      const r = await api.getGitDiff(project.id, fp);
      if (currentPathRef.current !== fp) return; // file switched mid-flight
      untrackedRef.current = r.isRepo && !r.tracked;
      diffRangesRef.current = r.ranges;
    } catch {
      if (currentPathRef.current !== fp) return;
      diffRangesRef.current = [];
      untrackedRef.current = false;
    }
    applyDecorations();
    // applyDecorations is stable; listed for lint completeness.
  }, [project.id, applyDecorations]);

  useEffect(() => {
    gitSigRef.current = '';
    setChanged(new Map());
    void refreshGit();
    void refreshOpenDiff();
    void refreshDiskStat();
    // Every tick spawns git processes backend-side (status + open-file diff) plus
    // one stat for the open file. Skip while the window is hidden — decorations
    // are invisible then anyway — and refresh immediately on restore so nothing
    // looks stale.
    const t = setInterval(() => {
      if (windowHidden()) return;
      void refreshGit();
      void refreshOpenDiff();
      void refreshDiskStat();
    }, 3000);
    const offVis = onWindowVisibility((hidden) => {
      if (hidden) return;
      void refreshGit();
      void refreshOpenDiff();
      void refreshDiskStat();
    });
    return () => {
      clearInterval(t);
      offVis();
    };
  }, [refreshGit, refreshOpenDiff, refreshDiskStat]);

  // Refetch the gutter when the open file changes (independent of the poll), and
  // re-probe disk: the read that opened the file and a write landing right after
  // it can race, so don't wait up to a poll interval to notice.
  useEffect(() => {
    void refreshOpenDiff();
    void refreshDiskStat();
  }, [currentPath, refreshOpenDiff, refreshDiskStat]);

  // True when disk has moved ahead of the copy we loaded — an edit made outside
  // the editor (Claude, git checkout, another tool).
  const stale = !diskGone && diskMtime !== null && originalMtime !== null && diskMtime > originalMtime;

  // Re-read the open file from disk. Never discards unsaved edits silently, and
  // keeps the cursor/scroll where it was so refreshing doesn't lose your place.
  const refreshFromDisk = useCallback(async () => {
    const fp = currentPathRef.current;
    if (!fp || refreshing) return;
    if (content !== original) {
      const ok = window.confirm(
        `${fp} has unsaved changes.\n\nReload it from disk and discard them?`,
      );
      if (!ok) return;
    }
    setRefreshing(true);
    const ed = editorRef.current;
    const pos = ed?.getPosition();
    pendingViewRef.current =
      ed && pos
        ? { lineNumber: pos.lineNumber, column: pos.column, scrollTop: ed.getScrollTop() }
        : null;
    try {
      await openPath(fp);
      void refreshOpenDiff();
    } finally {
      setRefreshing(false);
    }
  }, [content, original, openPath, refreshOpenDiff, refreshing]);

  // Restore the pre-refresh cursor/scroll once the new content has been applied
  // to the model. Keyed on `content` because that is what re-renders the editor;
  // the ref makes it a no-op for ordinary keystrokes.
  useEffect(() => {
    const want = pendingViewRef.current;
    if (!want) return;
    const ed = editorRef.current;
    const model = ed?.getModel();
    if (ed && model) {
      // Clamp: the reloaded file may be shorter than it was.
      const lineNumber = Math.min(want.lineNumber, model.getLineCount());
      ed.setPosition({ lineNumber, column: want.column });
      ed.setScrollTop(want.scrollTop);
      ed.focus();
    }
    pendingViewRef.current = null;
  }, [content]);

  // Re-apply decorations on edits so an untracked file's whole-file highlight
  // tracks new lines and decorations survive buffer changes.
  useEffect(() => {
    applyDecorations();
  }, [content, applyDecorations]);

  // Debounced backend file-name search — covers the whole project, including
  // folders the tree hasn't loaded yet.
  useEffect(() => {
    const q = query.trim();
    if (searchMode !== 'name' || !q) {
      setNameResults([]);
      setNameTruncated(false);
      setNameErr(null);
      setNameSearching(false);
      return;
    }
    setNameSearching(true);
    let cancelled = false;
    const t = setTimeout(() => {
      api
        .searchFileNames(project.id, q)
        .then((r) => {
          if (cancelled) return;
          setNameResults(r.files);
          setNameTruncated(r.truncated);
          setNameErr(null);
        })
        .catch((e) => {
          if (!cancelled) setNameErr((e as Error).message);
        })
        .finally(() => {
          if (!cancelled) setNameSearching(false);
        });
    }, 200);
    return () => {
      cancelled = true;
      clearTimeout(t);
    };
  }, [project.id, query, searchMode]);

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

  // Reveal + focus a pending line on the LIVE editor. Called both from the effect
  // below (same-file jump: editor already mounted) and from onMount (cross-file
  // jump remounts <Editor>, so the reveal must wait for the new editor). Guards on
  // getModel() so a stale/disposed editor no-ops without clearing the pending line.
  const doReveal = useCallback(() => {
    const line = pendingRevealRef.current;
    const ed = editorRef.current;
    if (!line || !ed || !ed.getModel()) return;
    ed.revealLineInCenter(line);
    ed.setPosition({ lineNumber: line, column: 1 });
    ed.focus();
    pendingRevealRef.current = null;
  }, []);

  useEffect(() => {
    doReveal();
  }, [revealNonce, content, doReveal]);

  const openFile = useCallback(
    (node: FileNode) => {
      if (node.type !== 'file') return;
      void openPath(node.path);
    },
    [openPath],
  );

  // Restore the last-open file once the tree has loaded (and nothing else is open).
  useEffect(() => {
    if (loadingTree || !initialFile || currentPath) return;
    void openPath(initialFile);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [loadingTree, initialFile]);

  // Keep a ref to the latest save so Monaco's Ctrl+S command isn't a stale closure.
  const saveRef = useRef<() => void>(() => undefined);
  const save = useCallback(async () => {
    if (currentPath === null || saving) return;
    // Snapshot the file + content at save time — the user may switch files while
    // the request is in flight, and we must not write the results back to the
    // wrong file's state. `conflict` means "the user already saw the on-disk
    // conflict and clicked again" → force the overwrite.
    const pathAtSave = currentPath;
    const contentAtSave = content;
    const forcing = conflict;
    if (contentAtSave === original && !forcing) return;
    setSaving(true);
    setFileErr(null);
    try {
      const res = await api.saveFile(
        project.id,
        pathAtSave,
        contentAtSave,
        originalMtime ?? undefined,
        forcing,
      );
      if (currentPathRef.current !== pathAtSave) return; // switched files mid-save
      setOriginal(contentAtSave);
      setOriginalMtime(res.mtimeMs);
      // Our own write is the newest state on disk — don't let it read as stale.
      setDiskMtime(res.mtimeMs);
      setDiskGone(false);
      setConflict(false);
      setSaved(true);
      // Reflect the save immediately: tree markers (refreshGit) + gutter for the
      // saved file (refreshOpenDiff — needed because git keeps it in the same
      // "modified" bucket, so the status signature alone wouldn't refresh it).
      void refreshGit();
      void refreshOpenDiff();
    } catch (e) {
      if (currentPathRef.current !== pathAtSave) return;
      const msg = (e as Error).message;
      setFileErr(msg);
      if (/changed on disk/i.test(msg)) setConflict(true); // arm force-overwrite
    } finally {
      setSaving(false);
    }
  }, [project.id, currentPath, content, original, saving, originalMtime, conflict, refreshGit, refreshOpenDiff]);
  saveRef.current = () => void save();

  const isMd = currentPath !== null && isMarkdownPath(currentPath);

  // Switching to the preview unmounts Monaco, so drop the editor refs with it —
  // a stale handle would make the next decoration pass touch a disposed editor.
  const showPreview = useCallback(() => {
    editorRef.current = null;
    monacoRef.current = null;
    decorationsRef.current = [];
    setMdPreview(true);
  }, []);
  const showSource = useCallback(() => setMdPreview(false), []);

  const handleMount: OnMount = (editor, monaco) => {
    editorRef.current = editor;
    monacoRef.current = monaco;
    decorationsRef.current = [];
    editor.addCommand(monaco.KeyMod.CtrlCmd | monaco.KeyCode.KeyS, () => saveRef.current());
    applyDecorations(); // paint gutter for the freshly-mounted editor
    doReveal(); // complete a pending cross-file jump-to-line on the new editor
  };

  return (
    <div className="editor-view">
      <aside className="file-tree">
        <div className="ft-tabs">
          <button
            className={`ft-tab ${leftTab === 'explorer' ? 'active' : ''}`}
            onClick={() => setLeftTab('explorer')}
          >
            Explorer
          </button>
          <button
            className={`ft-tab ${leftTab === 'changes' ? 'active' : ''}`}
            onClick={() => setLeftTab('changes')}
          >
            Changes
          </button>
        </div>
        {leftTab === 'changes' ? (
          <ChangesPanel
            projectId={project.id}
            currentPath={currentPath}
            onOpenDiff={(path, deleted) => void openDiff(path, deleted)}
          />
        ) : loadingTree ? (
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
                <Ic name="search" className="ft-glass" />
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
                  <>
                    {nameSearching && <div className="ft-note">Searching…</div>}
                    {nameErr && <div className="ft-note ft-err">{nameErr}</div>}
                    {!nameSearching && !nameErr && nameResults.length === 0 && (
                      <div className="ft-note">No file names match.</div>
                    )}
                    {nameResults.map((p) => {
                      const st = changed.get(p);
                      return (
                        <div
                          key={p}
                          className={`ft-row ft-file ${currentPath === p ? 'active' : ''} ${
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
                    })}
                    {nameTruncated && (
                      <div className="ft-note ft-trunc">
                        Showing the first {nameResults.length} matches — refine the search.
                      </div>
                    )}
                  </>
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
                    currentPath={currentPath}
                    changed={changed}
                    changedDirs={changedDirs}
                    loadingDirs={loadingDirs}
                  />
                  {dirErr && <div className="ft-note ft-err">{dirErr}</div>}
                </>
              )}
            </div>
          </>
        )}
      </aside>

      <div className="editor-main">
        <div className="editor-toolbar">
          <span className="editor-path">
            {currentPath ? (
              <>
                {dirty && <span className="dirty-dot" title="Unsaved changes" />}
                <span title={currentPath}>
                  {currentPath.split('/').map((seg, i, arr) =>
                    i < arr.length - 1 ? (
                      <span key={i} className="crumb-seg">
                        {seg}
                        <span className="crumb-sep">›</span>
                      </span>
                    ) : (
                      <span key={i} className="crumb-leaf">
                        {seg}
                      </span>
                    ),
                  )}
                </span>
              </>
            ) : (
              <span className="muted">No file open</span>
            )}
          </span>
          {branch?.branch && (
            <span
              className={`editor-branch${branch.detached ? ' detached' : ''}`}
              title={branch.detached ? 'detached HEAD (short SHA)' : `on branch ${branch.branch}`}
            >
              <Ic name="branch" /> {branch.branch}
            </span>
          )}
          {isMd && !showDiff && (
            <div className="editor-mdmode" role="group" aria-label="Markdown view">
              <button
                className={`md-mode ${!mdPreview ? 'active' : ''}`}
                onClick={showSource}
                title="Edit the Markdown source"
              >
                Code
              </button>
              <button
                className={`md-mode ${mdPreview ? 'active' : ''}`}
                onClick={showPreview}
                title="Read the rendered Markdown"
              >
                Preview
              </button>
            </div>
          )}
          {fileErr && <span className="editor-file-err">{fileErr}</span>}
          {saved && !dirty && !conflict && <span className="editor-saved">saved ✓</span>}
          {showDiff && (
            <span className="editor-diff-note">
              {headLoading ? 'loading…' : headCommitted ? '‹ committed · working ›' : 'new file — nothing committed yet'}
            </span>
          )}
          {currentPath && (
            <button
              className={`btn btn-ghost editor-refresh${stale ? ' attention' : ''}`}
              onClick={() => void refreshFromDisk()}
              disabled={refreshing || diskGone}
              title={
                diskGone
                  ? 'This file no longer exists on disk'
                  : stale
                    ? 'This file changed on disk — click to reload it'
                    : 'Reload this file from disk'
              }
            >
              <Ic name="refresh" /> {refreshing ? 'Refreshing…' : 'Refresh'}
            </button>
          )}
          {currentPath && (stale || diskGone) && (
            <span className={`editor-disk-note${diskGone ? ' gone' : ''}`}>
              {diskGone ? 'deleted on disk' : 'changed on disk'}
            </span>
          )}
          {currentPath && (
            <button
              className={`btn btn-ghost editor-diff${showDiff ? ' active' : ''}`}
              onClick={() => setShowDiff((v) => !v)}
              title={showDiff ? 'Back to editing' : 'Diff working copy vs last commit (side by side)'}
            >
              {showDiff ? <><Ic name="pen" /> Edit</> : '± Diff'}
            </button>
          )}
          <button
            className={`btn ${conflict ? 'btn-danger' : 'btn-primary'} editor-save`}
            onClick={() => void save()}
            disabled={(!dirty && !conflict) || saving || showDiff}
            title={conflict ? 'The file changed on disk — click to overwrite it' : undefined}
          >
            {saving ? 'Saving…' : conflict ? 'Overwrite' : 'Save'}
          </button>
        </div>

        <div className="editor-host">
          {currentPath === null ? (
            <div className="editor-empty">
              {loadingFile ? 'Opening…' : 'Select a file from the tree to edit it.'}
            </div>
          ) : isMd && mdPreview && !showDiff ? (
            <div className="md-preview" data-testid="md-preview">
              <Markdown source={content} />
            </div>
          ) : showDiff ? (
            <DiffEditor
              key={`diff-${currentPath}`}
              theme="narukami"
              language={languageFor(currentPath)}
              original={headContent}
              modified={content}
              options={{
                readOnly: true,
                renderSideBySide: true,
                automaticLayout: true,
                fontFamily: "'JetBrains Mono', 'Fira Code', Consolas, monospace",
                fontSize: 13,
                minimap: { enabled: false },
                scrollBeyondLastLine: false,
              }}
            />
          ) : (
            <Editor
              key={currentPath}
              theme="narukami"
              language={languageFor(currentPath)}
              value={content}
              onChange={(v) => setContent(v ?? '')}
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
          )}
        </div>
      </div>
    </div>
  );
}
