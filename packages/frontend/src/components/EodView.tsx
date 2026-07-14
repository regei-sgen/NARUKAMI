import { useCallback, useEffect, useState } from 'react';
import { api } from '../api';
import type { EodEntry, EodItem, EodSources, Project } from '../types';
import {
  compilesFromMemory,
  computeStats,
  featureSource,
  fmtDuration,
  fmtTime,
  memorySourceLabel,
  statusClass,
  todayKey,
} from '../lib/eod';

interface Props {
  project: Project;
}

const KIND_ICON: Record<string, string> = { shell: '⌨', claude: '✦', command: '▶' };

export function EodView({ project }: Props) {
  const [entries, setEntries] = useState<EodEntry[]>([]);
  const [sources, setSources] = useState<EodSources | null>(null);
  const [loading, setLoading] = useState(true);
  const [err, setErr] = useState<string | null>(null);
  const [note, setNote] = useState('');
  const [compiling, setCompiling] = useState(false);
  const [expandedId, setExpandedId] = useState<string | null>(null);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [editValue, setEditValue] = useState('');
  const [summarizingId, setSummarizingId] = useState<string | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    setErr(null);
    try {
      const [list, src] = await Promise.all([
        api.listEod(project.id),
        api.getEodSources(project.id).catch(() => null),
      ]);
      setEntries(list);
      if (src) setSources(src);
    } catch (e) {
      setErr((e as Error).message);
    } finally {
      setLoading(false);
    }
  }, [project.id]);

  useEffect(() => {
    setSources(null);
    void load();
  }, [load]);

  // A non-git project compiles its "features" from Claude memory instead of commits.
  const fromMemory = compilesFromMemory(sources);
  const memoryCount = sources?.memory.length ?? 0;

  // Replace one entry in place (after note/summary edits) without a full reload.
  const patchEntry = (e: EodEntry) => setEntries((cur) => cur.map((x) => (x.id === e.id ? e : x)));

  const compile = async () => {
    setCompiling(true);
    setErr(null);
    try {
      const entry = await api.compileEod(project.id, note.trim() || undefined);
      setNote('');
      setExpandedId(entry.id);
      await load();
    } catch (e) {
      setErr((e as Error).message);
    } finally {
      setCompiling(false);
    }
  };

  const saveNote = async (id: string) => {
    try {
      patchEntry(await api.updateEodNote(id, editValue.trim()));
      setEditingId(null);
    } catch (e) {
      setErr((e as Error).message);
    }
  };

  const summarize = async (id: string) => {
    setSummarizingId(id);
    setErr(null);
    try {
      patchEntry(await api.summarizeEod(id));
    } catch (e) {
      setErr((e as Error).message);
    } finally {
      setSummarizingId(null);
    }
  };

  const remove = async (id: string) => {
    try {
      await api.deleteEod(id);
      await load();
    } catch (e) {
      setErr((e as Error).message);
    }
  };

  const today = todayKey();

  return (
    <div className="eod">
      <div className="eod-head">
        <h2>End of Day</h2>
        <div className="muted">
          {project.name} · keeps the last 10 days · compiles today's finished runs
          {fromMemory && (
            <>
              {' · '}
              <span className="eod-src-badge" title="Not a git repo — features come from this project's Claude memory">
                no git · using Claude memory{memoryCount ? ` (${memoryCount})` : ''}
              </span>
            </>
          )}
        </div>
      </div>

      {err && (
        <div className="banner banner-error" onClick={() => setErr(null)}>
          {err}
        </div>
      )}

      <div className="eod-compile">
        <textarea
          className="eod-note-input"
          value={note}
          onChange={(e) => setNote(e.target.value)}
          placeholder="What did you get done today? (optional note — added to today's EOD)"
          rows={2}
          spellCheck
        />
        <button
          className="btn btn-claude eod-compile-btn"
          onClick={compile}
          disabled={compiling}
          title={
            fromMemory
              ? "Snapshot today's runs and this project's Claude memory"
              : "Snapshot today's finished runs + git commits"
          }
        >
          {compiling
            ? 'Compiling…'
            : fromMemory
              ? '✦ Compile from Claude memory'
              : '✦ Compile today'}
        </button>
      </div>

      {loading ? (
        <div className="muted eod-empty">Loading…</div>
      ) : entries.length === 0 ? (
        <div className="muted eod-empty">
          No EOD entries yet. Click <b>Compile today</b> to snapshot what this project finished today.
        </div>
      ) : (
        <ul className="eod-list">
          {entries.map((e) => {
            const open = expandedId === e.id;
            const stats = computeStats(e.items);
            return (
              <li key={e.id} className={`eod-entry${e.day === today ? ' eod-today' : ''}`}>
                <div className="eod-entry-head" onClick={() => setExpandedId(open ? null : e.id)}>
                  <span className="eod-caret">{open ? '▾' : '▸'}</span>
                  <span className="eod-title">
                    EOD — {project.name} · {e.day}
                    {e.day === today && <span className="eod-badge">today</span>}
                  </span>
                  <span className="eod-count">{stats.total} finished</span>
                  <button
                    className="btn-icon eod-del"
                    title="Delete this EOD"
                    onClick={(ev) => {
                      ev.stopPropagation();
                      void remove(e.id);
                    }}
                  >
                    ×
                  </button>
                </div>

                {/* Always-visible stats strip. */}
                <div className="eod-stats">
                  <span className="eod-stat">
                    <b>{stats.total}</b> runs
                  </span>
                  <span className="eod-stat s-ok">
                    <b>{stats.ok}</b> ok
                  </span>
                  <span className={`eod-stat ${stats.failed ? 's-err' : ''}`}>
                    <b>{stats.failed}</b> failed
                  </span>
                  <span className="eod-stat">
                    active <b>{fmtDuration(stats.activeMs)}</b>
                  </span>
                  {stats.spanStart && (
                    <span className="eod-stat">
                      {fmtTime(stats.spanStart)}–{fmtTime(stats.spanEnd)}
                    </span>
                  )}
                  {Object.entries(stats.byKind).map(([k, n]) => (
                    <span key={k} className="eod-stat eod-kindchip">
                      {KIND_ICON[k] ?? '•'} {n}
                    </span>
                  ))}
                  {e.commits.length > 0 ? (
                    <span className="eod-stat eod-featchip">
                      ✚ {e.commits.length} {e.commits.length === 1 ? 'feature' : 'features'}
                    </span>
                  ) : (
                    e.memory.length > 0 && (
                      <span className="eod-stat eod-featchip eod-memchip">
                        ✦ {e.memory.length} memory
                      </span>
                    )
                  )}
                </div>

                {open && (
                  <div className="eod-body">
                    {/* Features/changes added that day: git commits when the project
                        is a git repo, otherwise the project's Claude memory. */}
                    {featureSource(e) === 'memory' ? (
                      <div className="eod-features">
                        <div className="eod-features-head">
                          Claude memory
                          <span className="eod-features-count">{e.memory.length}</span>
                          <span className="eod-features-src">no git repo</span>
                        </div>
                        <ul className="eod-memory">
                          {e.memory.map((m) => (
                            <li key={m.name} className="eod-mem-doc">
                              <div className="eod-mem-top">
                                <span className="eod-mem-name">{m.name}</span>
                                <span className={`eod-mem-src eod-mem-src-${m.source}`}>
                                  {memorySourceLabel(m.source)}
                                </span>
                              </div>
                              <pre className="eod-mem-content">
                                {m.content}
                                {m.truncated ? '\n…(truncated)' : ''}
                              </pre>
                            </li>
                          ))}
                        </ul>
                      </div>
                    ) : (
                      <div className="eod-features">
                        <div className="eod-features-head">
                          Features added
                          <span className="eod-features-count">{e.commits.length}</span>
                        </div>
                        {e.commits.length === 0 ? (
                          <div className="muted eod-features-empty">
                            No commits recorded for this day (not a git repo, or nothing committed).
                            {e.git === false &&
                              ' No Claude memory found for this project either.'}
                          </div>
                        ) : (
                          <ul className="eod-commits">
                            {e.commits.map((c) => (
                              <li key={c.hash} className="eod-commit">
                                <div className="eod-commit-top">
                                  <span className="eod-commit-subject">{c.subject}</span>
                                  {c.filesChanged != null && (
                                    <span className="eod-commit-files">
                                      {c.filesChanged} {c.filesChanged === 1 ? 'file' : 'files'}
                                    </span>
                                  )}
                                  <code className="eod-commit-hash">{c.hash}</code>
                                </div>
                                {c.body && <pre className="eod-commit-body">{c.body}</pre>}
                              </li>
                            ))}
                          </ul>
                        )}
                      </div>
                    )}

                    {e.items.length === 0 ? (
                      <div className="muted">No finished runs recorded for this day.</div>
                    ) : (
                      <ul className="eod-items">
                        {e.items.map((it: EodItem, i) => (
                          <li key={i} className="eod-item">
                            <span className="eod-item-icon">{KIND_ICON[it.kind] ?? '•'}</span>
                            <span className="eod-item-label">{it.label}</span>
                            {it.command && <code className="eod-item-cmd">{it.command}</code>}
                            <span className="eod-item-dur">{fmtDuration(it.durationMs)}</span>
                            <span className="eod-item-time">{fmtTime(it.endedAt)}</span>
                            <span className={`eod-item-status s-${statusClass(it)}`}>
                              {it.status}
                              {it.exitCode != null ? ` (${it.exitCode})` : ''}
                            </span>
                          </li>
                        ))}
                      </ul>
                    )}

                    {/* AI narrative summary. */}
                    <div className="eod-summary">
                      <div className="eod-summary-head">
                        <span className="eod-summary-label">Summary</span>
                        <button
                          className="btn btn-claude eod-sum-btn"
                          onClick={() => void summarize(e.id)}
                          disabled={summarizingId === e.id}
                        >
                          {summarizingId === e.id
                            ? 'Summarizing…'
                            : e.summary
                              ? '✦ Regenerate'
                              : '✦ Summarize with Claude'}
                        </button>
                      </div>
                      {e.summary ? (
                        <p className="eod-summary-text">{e.summary}</p>
                      ) : (
                        <p className="muted eod-summary-text">
                          No AI summary yet — click <b>Summarize with Claude</b> to generate one from
                          this day's runs and note.
                        </p>
                      )}
                    </div>

                    {/* Editable note. */}
                    <div className="eod-note">
                      {editingId === e.id ? (
                        <div className="eod-note-edit">
                          <textarea
                            className="eod-note-input"
                            value={editValue}
                            onChange={(ev) => setEditValue(ev.target.value)}
                            rows={2}
                            spellCheck
                          />
                          <div className="eod-note-actions">
                            <button className="btn" onClick={() => void saveNote(e.id)}>
                              Save
                            </button>
                            <button className="btn btn-ghost" onClick={() => setEditingId(null)}>
                              Cancel
                            </button>
                          </div>
                        </div>
                      ) : (
                        <div
                          className="eod-note-view"
                          onClick={() => {
                            setEditingId(e.id);
                            setEditValue(e.note ?? '');
                          }}
                          title="Click to edit note"
                        >
                          <span className="eod-note-label">Note:</span>{' '}
                          {e.note ? e.note : <span className="muted">— click to add —</span>}
                        </div>
                      )}
                    </div>
                  </div>
                )}
              </li>
            );
          })}
        </ul>
      )}
    </div>
  );
}
