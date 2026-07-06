import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import Editor, { type OnMount } from '@monaco-editor/react';
import '../lib/monaco-setup'; // side-effect: offline workers + narukami theme + loader.config
import { api } from '../api';
import type { FileNode, Project } from '../types';

interface Props {
  project: Project;
  initialFile?: string; // restore this file on mount (path re-read from disk)
  onOpenFile?: (path: string) => void; // report opens so the workspace can persist them
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

interface TreeProps {
  nodes: FileNode[];
  depth: number;
  expanded: Set<string>;
  toggle: (p: string) => void;
  onOpen: (n: FileNode) => void;
  currentPath: string | null;
}

function TreeNodes({ nodes, depth, expanded, toggle, onOpen, currentPath }: TreeProps) {
  return (
    <>
      {nodes.map((n) => {
        const isDir = n.type === 'dir';
        const isOpen = expanded.has(n.path);
        const active = !isDir && currentPath === n.path;
        return (
          <div key={n.path}>
            <div
              className={`ft-row ${active ? 'active' : ''} ${isDir ? 'ft-dir' : 'ft-file'}`}
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
            </div>
            {isDir && isOpen && n.children && n.children.length > 0 && (
              <TreeNodes
                nodes={n.children}
                depth={depth + 1}
                expanded={expanded}
                toggle={toggle}
                onOpen={onOpen}
                currentPath={currentPath}
              />
            )}
          </div>
        );
      })}
    </>
  );
}

export function CodeEditor({ project, initialFile, onOpenFile }: Props) {
  const [tree, setTree] = useState<FileNode[]>([]);
  const [truncated, setTruncated] = useState(false);
  const [expanded, setExpanded] = useState<Set<string>>(new Set());
  const [treeErr, setTreeErr] = useState<string | null>(null);
  const [loadingTree, setLoadingTree] = useState(true);

  const [currentPath, setCurrentPath] = useState<string | null>(null);
  const [content, setContent] = useState('');
  const [original, setOriginal] = useState('');
  const [fileErr, setFileErr] = useState<string | null>(null);
  const [loadingFile, setLoadingFile] = useState(false);
  const [saving, setSaving] = useState(false);
  const [saved, setSaved] = useState(false);

  // Search: by file name (client-side filter of the tree) or by code (backend grep).
  const [searchMode, setSearchMode] = useState<'name' | 'code'>('name');
  const [query, setQuery] = useState('');
  const [codeResults, setCodeResults] = useState<{ path: string; line: number; text: string }[]>([]);
  const [codeTruncated, setCodeTruncated] = useState(false);
  const [codeSearching, setCodeSearching] = useState(false);
  const [codeErr, setCodeErr] = useState<string | null>(null);

  // Line to reveal after a file opens (set when jumping from a code-search hit).
  const editorRef = useRef<Parameters<OnMount>[0] | null>(null);
  const [revealLine, setRevealLine] = useState<number | null>(null);

  const dirty = currentPath !== null && content !== original;

  // Load the file tree whenever the selected project changes.
  useEffect(() => {
    let cancelled = false;
    setLoadingTree(true);
    setTreeErr(null);
    setCurrentPath(null);
    setContent('');
    setOriginal('');
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

  const openPath = useCallback(
    async (filePath: string, line?: number) => {
      setLoadingFile(true);
      setFileErr(null);
      setSaved(false);
      try {
        const r = await api.readFile(project.id, filePath);
        setCurrentPath(filePath);
        setContent(r.content);
        setOriginal(r.content);
        if (line && line > 0) setRevealLine(line);
        onOpenFile?.(filePath); // persist as the project's last-open file
      } catch (e) {
        setFileErr((e as Error).message);
      } finally {
        setLoadingFile(false);
      }
    },
    [project.id, onOpenFile],
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

  // Reveal + focus a line once the target file's content has loaded.
  useEffect(() => {
    if (!revealLine || !editorRef.current) return;
    const ed = editorRef.current;
    ed.revealLineInCenter(revealLine);
    ed.setPosition({ lineNumber: revealLine, column: 1 });
    ed.focus();
    setRevealLine(null);
  }, [revealLine, content]);

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
    if (content === original) return;
    setSaving(true);
    setFileErr(null);
    try {
      await api.saveFile(project.id, currentPath, content);
      setOriginal(content);
      setSaved(true);
    } catch (e) {
      setFileErr((e as Error).message);
    } finally {
      setSaving(false);
    }
  }, [project.id, currentPath, content, original, saving]);
  saveRef.current = save;

  const handleMount: OnMount = (editor, monaco) => {
    editorRef.current = editor;
    editor.addCommand(monaco.KeyMod.CtrlCmd | monaco.KeyCode.KeyS, () => saveRef.current());
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
                    nameResults.map((p) => (
                      <div
                        key={p}
                        className={`ft-row ft-file ${currentPath === p ? 'active' : ''}`}
                        style={{ paddingLeft: 8 }}
                        title={p}
                        onClick={() => void openPath(p)}
                      >
                        <span className="ft-chevron-spacer" />
                        <FileIcon />
                        <span className="ft-name ft-name-path">{p}</span>
                      </div>
                    ))
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
                    currentPath={currentPath}
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
        <div className="editor-toolbar">
          <span className="editor-path">
            {currentPath ? (
              <>
                {dirty && <span className="dirty-dot" title="Unsaved changes" />}
                {currentPath}
              </>
            ) : (
              <span className="muted">No file open</span>
            )}
          </span>
          {fileErr && <span className="editor-file-err">{fileErr}</span>}
          {saved && !dirty && <span className="editor-saved">saved ✓</span>}
          <button
            className="btn btn-primary editor-save"
            onClick={() => void save()}
            disabled={!dirty || saving}
          >
            {saving ? 'Saving…' : 'Save'}
          </button>
        </div>

        <div className="editor-host">
          {currentPath === null ? (
            <div className="editor-empty">
              {loadingFile ? 'Opening…' : 'Select a file from the tree to edit it.'}
            </div>
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
