import { useEffect, useMemo, useState } from 'react';
import { api } from '../api';
import {
  filterCommits,
  fromLocalInput,
  rangeForPreset,
  toLocalInput,
  type LogCommit,
  type Preset,
} from '../lib/changelog';

// The "Changelog" view: this app's git commits, filterable by a date/time range
// (From/To inputs + quick presets). Answers "what did we do between X and Y".
const PRESETS: { id: Preset; label: string }[] = [
  { id: 'today', label: 'Today' },
  { id: '24h', label: '24h' },
  { id: '7d', label: '7d' },
  { id: 'all', label: 'All' },
];

function fmtWhen(iso: string): string {
  const t = Date.parse(iso);
  if (Number.isNaN(t)) return iso;
  return new Date(t).toLocaleString([], {
    month: 'short',
    day: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
  });
}

export function Changelog() {
  const [commits, setCommits] = useState<LogCommit[] | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [fromStr, setFromStr] = useState('');
  const [toStr, setToStr] = useState('');

  useEffect(() => {
    let live = true;
    api
      .getChangelog()
      .then((r) => {
        if (live) setCommits(r.commits);
      })
      .catch((e) => {
        if (live) setErr((e as Error).message);
      });
    return () => {
      live = false;
    };
  }, []);

  const fromMs = fromLocalInput(fromStr);
  const toMs = fromLocalInput(toStr);
  const shown = useMemo(
    () => (commits ? filterCommits(commits, fromMs, toMs) : []),
    [commits, fromMs, toMs],
  );

  const applyPreset = (p: Preset) => {
    const { fromMs: f, toMs: t } = rangeForPreset(p, Date.now());
    setFromStr(f == null ? '' : toLocalInput(f));
    setToStr(t == null ? '' : toLocalInput(t));
  };
  const clear = () => {
    setFromStr('');
    setToStr('');
  };

  return (
    <div className="cl">
      <div className="cl-filter">
        <label className="cl-field">
          <span>From</span>
          <input
            type="datetime-local"
            value={fromStr}
            onChange={(e) => setFromStr(e.target.value)}
          />
        </label>
        <label className="cl-field">
          <span>To</span>
          <input type="datetime-local" value={toStr} onChange={(e) => setToStr(e.target.value)} />
        </label>
        <div className="cl-presets">
          {PRESETS.map((p) => (
            <button key={p.id} className="cl-preset" onClick={() => applyPreset(p.id)}>
              {p.label}
            </button>
          ))}
          {(fromStr || toStr) && (
            <button className="cl-preset cl-clear" onClick={clear}>
              Clear
            </button>
          )}
        </div>
        <span className="cl-count">
          {commits == null ? '…' : `${shown.length} commit${shown.length === 1 ? '' : 's'}`}
        </span>
      </div>

      {err && (
        <div className="banner banner-error" onClick={() => setErr(null)}>
          {err}
        </div>
      )}

      {commits == null && !err ? (
        <div className="cl-empty muted">Loading history…</div>
      ) : shown.length === 0 ? (
        <div className="cl-empty muted">
          {commits && commits.length === 0
            ? 'No commit history available here.'
            : 'No commits in this range.'}
        </div>
      ) : (
        <ul className="cl-list">
          {shown.map((c, i) => (
            <li key={`${c.hash}-${i}`} className="cl-item">
              <div className="cl-when">{fmtWhen(c.date)}</div>
              <div className="cl-body">
                <div className="cl-subject">{c.subject}</div>
                <div className="cl-meta">
                  <code className="cl-hash">{c.hash}</code>
                  {c.filesChanged != null && (
                    <span>
                      {c.filesChanged} file{c.filesChanged === 1 ? '' : 's'}
                    </span>
                  )}
                  {c.author && <span>{c.author}</span>}
                </div>
                {c.body && <pre className="cl-text">{c.body}</pre>}
              </div>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
