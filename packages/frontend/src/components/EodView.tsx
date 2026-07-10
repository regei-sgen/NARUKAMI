import { type ReactNode, useCallback, useEffect, useMemo, useState } from 'react';
import { api } from '../api';
import type { EodActiveProject, EodReportDoc } from '../types';
import { todayKey } from '../lib/eod';
import { Ic } from './icons';

/**
 * Convert the report markdown to Slack mrkdwn so it can be pasted straight into
 * Slack: `#`/`##`/`###` headings → `*bold*`, `-`/`*` bullets → `• `, `---` → blank.
 * Exported for testing.
 */
export function toSlack(md: string): string {
  const out: string[] = [];
  for (const raw of md.split('\n')) {
    const line = raw.replace(/\s+$/, '');
    if (/^-{3,}$/.test(line.trim())) {
      out.push('');
      continue;
    }
    const h = line.match(/^#{1,6}\s+(.*)$/);
    if (h) {
      out.push(`*${h[1].replace(/^EOD\s*--\s*/, 'EOD — ')}*`);
      continue;
    }
    const b = line.match(/^\s*[-*]\s+(.*)$/);
    if (b) {
      out.push(`• ${b[1]}`);
      continue;
    }
    out.push(line);
  }
  return out.join('\n').replace(/\n{3,}/g, '\n\n').trim();
}

/** Render Slack mrkdwn to styled elements for the on-screen preview. */
export function renderSlack(slack: string): ReactNode[] {
  return slack.split('\n').map((line, i) => {
    if (!line.trim()) return <div key={i} className="eods-gap" />;
    const bold = line.match(/^\*(.+)\*$/);
    if (bold) return <div key={i} className="eods-h">{bold[1]}</div>;
    if (line.startsWith('• ')) return <div key={i} className="eods-b">{line}</div>;
    return <div key={i} className="eods-p">{line}</div>;
  });
}

export function EodView() {
  const [day, setDay] = useState<string>(todayKey());
  const [active, setActive] = useState<EodActiveProject[]>([]);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [note, setNote] = useState('');
  const [loadingActive, setLoadingActive] = useState(true);
  const [generating, setGenerating] = useState(false);
  const [report, setReport] = useState<EodReportDoc | null>(null);
  const [reports, setReports] = useState<EodReportDoc[]>([]);
  const [err, setErr] = useState<string | null>(null);

  const loadReports = useCallback(async () => {
    try {
      setReports(await api.listEodReports());
    } catch (e) {
      setErr((e as Error).message);
    }
  }, []);

  // On day change: detect active projects (default all selected) + load any saved
  // report already generated for that day.
  const loadDay = useCallback(async (d: string) => {
    setLoadingActive(true);
    setErr(null);
    setReport(null);
    try {
      const [res, saved] = await Promise.all([api.getEodActive(d), api.listEodReports()]);
      setActive(res.projects);
      setSelected(new Set(res.projects.map((p) => p.path)));
      setReports(saved);
      setReport(saved.find((r) => r.day === d) ?? null);
    } catch (e) {
      setErr((e as Error).message);
    } finally {
      setLoadingActive(false);
    }
  }, []);

  useEffect(() => {
    void loadDay(day);
  }, [day, loadDay]);

  const toggle = (path: string) =>
    setSelected((cur) => {
      const next = new Set(cur);
      if (next.has(path)) next.delete(path);
      else next.add(path);
      return next;
    });

  const generate = async () => {
    const paths = active.filter((p) => selected.has(p.path)).map((p) => p.path);
    if (paths.length === 0) return;
    setGenerating(true);
    setErr(null);
    try {
      const r = await api.generateEodReport(day, paths, note.trim() || undefined);
      setReport(r);
      await loadReports();
    } catch (e) {
      setErr((e as Error).message);
    } finally {
      setGenerating(false);
    }
  };

  const openSaved = async (r: EodReportDoc) => {
    setDay(r.day); // triggers loadDay, which will pick up this saved report
  };

  const removeReport = async (id: string) => {
    try {
      await api.deleteEodReport(id);
      if (report?.id === id) setReport(null);
      await loadReports();
    } catch (e) {
      setErr((e as Error).message);
    }
  };

  const copy = () => {
    if (report) void navigator.clipboard?.writeText(toSlack(report.markdown));
  };
  const download = () => {
    if (!report) return;
    const blob = new Blob([toSlack(report.markdown)], { type: 'text/plain' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `EOD_${report.day}_slack.txt`;
    document.body.appendChild(a);
    a.click();
    a.remove();
    URL.revokeObjectURL(url);
  };

  const selectedCount = useMemo(() => active.filter((p) => selected.has(p.path)).length, [active, selected]);

  return (
    <div className="eod">
      <div className="eod-head">
        <h2>End of Day</h2>
        <div className="muted">
          Detects every project active on a day (native + NARUKAMI Claude sessions, runs, git commits) and generates a
          report you can include, copy, or download.
        </div>
      </div>

      {err && (
        <div className="banner banner-error" onClick={() => setErr(null)}>
          {err}
        </div>
      )}

      <div className="eod-layout">
        <aside className="eod-card eod-saved">
          <div className="eod-card-head">
            <span>Saved days</span>
            <span className="eod-card-sub">{reports.length || 'none'}</span>
          </div>
          {reports.length === 0 ? (
            <div className="muted eod-saved-empty">Generated reports land here.</div>
          ) : (
            <ul className="eod-saved-list">
              {reports.map((r) => (
                <li key={r.id} className={`eod-saved-item${r.day === day ? ' active' : ''}`}>
                  <button className="eod-saved-day" onClick={() => void openSaved(r)}>
                    <span>{r.day}</span>
                    <span className="eod-saved-count">{r.projects.length} proj</span>
                  </button>
                  <button className="btn-icon eod-saved-del" title="Delete report" onClick={() => void removeReport(r.id)}>
                    ×
                  </button>
                </li>
              ))}
            </ul>
          )}
        </aside>

        <div className="eod-main">
          {/* 01 — the day and what was touched */}
          <section className="eod-card">
            <div className="eod-card-head">
              <span><b className="eod-step">01</b> Day &amp; projects</span>
              <span className="eod-card-sub">
                {loadingActive ? 'detecting…' : `${active.length} active · ${selectedCount} selected`}
              </span>
            </div>
            <div className="eod-controls">
              <label className="eod-daypick">
                Day
                <input type="date" value={day} max={todayKey()} onChange={(e) => setDay(e.target.value || todayKey())} />
              </label>
              <button
                className="btn btn-ghost eod-refresh"
                onClick={() => void loadDay(day)}
                disabled={loadingActive}
                title="Re-scan Claude sessions, runs and commits for this day"
              >
                {loadingActive ? <><Ic name="refresh" /> Detecting…</> : <><Ic name="refresh" /> Refresh</>}
              </button>
            </div>

            {!loadingActive && active.length === 0 ? (
              <div className="muted eod-empty">No project activity detected on {day}.</div>
            ) : (
              <ul className="eod-active">
                {active.map((p) => (
                  <li key={p.path} className="eod-active-item">
                    <label className="eod-check">
                      <input type="checkbox" checked={selected.has(p.path)} onChange={() => toggle(p.path)} />
                      <span className="eod-active-name">{p.name}</span>
                      {!p.registered && <span className="eod-tag-ext" title={p.path}>ext</span>}
                    </label>
                    <div className="eod-active-badges">
                      {p.commits > 0 && <span className="eod-badge-c" title="git commits"><Ic name="plus" /> {p.commits}</span>}
                      {p.sessions > 0 && <span className="eod-badge-s" title="Claude sessions (native + NARUKAMI)"><Ic name="spark" /> {p.sessions}</span>}
                      {p.runs > 0 && <span className="eod-badge-r" title="NARUKAMI runs"><Ic name="play" /> {p.runs}</span>}
                    </div>
                    <code className="eod-active-path" title={p.path}>{p.path}</code>
                  </li>
                ))}
              </ul>
            )}
          </section>

          {/* 02 — note + generate */}
          <section className="eod-card">
            <div className="eod-card-head">
              <span><b className="eod-step">02</b> Note &amp; generate</span>
              {generating && <span className="eod-card-sub">Claude is writing — up to a minute</span>}
            </div>
            <textarea
              className="eod-note-input"
              value={note}
              onChange={(e) => setNote(e.target.value)}
              placeholder="Optional note to weave into the report…"
              rows={2}
              spellCheck
            />
            <div className="eod-gen-row">
              <button className="btn btn-claude" onClick={() => void generate()} disabled={generating || selectedCount === 0}>
                {generating ? <><Ic name="spark" /> Generating…</> : report ? <><Ic name="spark" /> Regenerate report</> : <><Ic name="spark" /> Generate report</>}
              </button>
            </div>
          </section>

          {/* 03 — the result */}
          {report && (
            <section className="eod-card eod-report">
              <div className="eod-card-head">
                <span><b className="eod-step">03</b> Report · {report.day}</span>
                <span className="eod-report-btns">
                  <button className="btn" onClick={copy}>Copy for Slack</button>
                  <button className="btn" onClick={download}>Download .txt</button>
                </span>
              </div>
              <div className="eod-report-body eod-slack">{renderSlack(toSlack(report.markdown))}</div>
            </section>
          )}
        </div>
      </div>
    </div>
  );
}
