import { useCallback, useEffect, useRef, useState } from 'react';
import { api } from '../api';
import type { GitChangeEntry, GitChanges } from '../types';
import { Ic } from './icons';

interface Props {
  projectId: string;
  currentPath: string | null;
  onOpenDiff: (path: string, deleted: boolean) => void;
}

const LETTER: Record<GitChangeEntry['type'], string> = {
  added: 'A',
  modified: 'M',
  deleted: 'D',
  renamed: 'R',
  untracked: 'U',
};

function baseName(p: string): string {
  return p.split('/').pop() ?? p;
}
function dirName(p: string): string {
  const i = p.lastIndexOf('/');
  return i < 0 ? '' : p.slice(0, i);
}

function Row({
  entry,
  onOpen,
  actions,
}: {
  entry: GitChangeEntry;
  onOpen: () => void;
  actions: React.ReactNode;
}) {
  return (
    <div className="chg-row" title={entry.path}>
      <button className="chg-row-open" onClick={onOpen}>
        <span className={`chg-badge chg-${entry.type}`}>{LETTER[entry.type]}</span>
        <span className="chg-name">{baseName(entry.path)}</span>
        <span className="chg-dir">{dirName(entry.path)}</span>
      </button>
      <div className="chg-actions">{actions}</div>
    </div>
  );
}

export function ChangesPanel({ projectId, currentPath, onOpenDiff }: Props) {
  const [data, setData] = useState<GitChanges | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [message, setMessage] = useState('');
  const [busy, setBusy] = useState(false);
  const aliveRef = useRef(true);

  const refetch = useCallback(async () => {
    try {
      const c = await api.getGitChanges(projectId);
      if (aliveRef.current) {
        setData(c);
        setErr(null);
      }
    } catch (e) {
      if (aliveRef.current) setErr((e as Error).message);
    }
  }, [projectId]);

  // Fetch on mount + poll every 3.5s (matches the branch-label cadence).
  useEffect(() => {
    aliveRef.current = true;
    void refetch();
    const id = setInterval(() => void refetch(), 3500);
    return () => {
      aliveRef.current = false;
      clearInterval(id);
    };
  }, [refetch]);

  // Run a mutation, then refetch. Serialized by `busy` so double-clicks don't race.
  const act = useCallback(
    async (fn: () => Promise<unknown>) => {
      if (busy) return;
      setBusy(true);
      try {
        await fn();
        await refetch();
      } catch (e) {
        setErr((e as Error).message);
      } finally {
        setBusy(false);
      }
    },
    [busy, refetch],
  );

  const discard = useCallback(
    (entry: GitChangeEntry) => {
      const kind = entry.type === 'untracked' ? 'delete the untracked file' : 'discard changes to';
      if (!window.confirm(`Really ${kind} ${entry.path}? This cannot be undone.`)) return;
      void act(() => api.discardFile(projectId, entry.path, entry.type === 'untracked'));
    },
    [act, projectId],
  );

  const commit = useCallback(() => {
    const msg = message.trim();
    if (!msg) return;
    void act(async () => {
      await api.commitChanges(projectId, msg);
      setMessage('');
    });
  }, [act, message, projectId]);

  if (data && !data.isRepo) {
    return <div className="chg-note">Not a git repository.</div>;
  }

  const staged = data?.staged ?? [];
  const unstaged = data?.unstaged ?? [];
  const conflicts = data?.conflicts ?? [];

  return (
    <div className="changes-panel">
      <div className="chg-branch">
        <Ic name="branch" />
        <span className="chg-branch-name">{data?.branch ?? '—'}</span>
        {data?.detached && <span className="chg-detached">detached</span>}
      </div>

      {err && <div className="chg-err" onClick={() => setErr(null)}>{err}</div>}

      {conflicts.length > 0 && (
        <section className="chg-section chg-section-conflict">
          <div className="chg-head">Merge Conflicts</div>
          {conflicts.map((e) => (
            <Row key={`c-${e.path}`} entry={e} onOpen={() => onOpenDiff(e.path, false)} actions={null} />
          ))}
        </section>
      )}

      <section className="chg-section">
        <div className="chg-head">
          Staged Changes
          {staged.length > 0 && (
            <button className="chg-head-btn" onClick={() => void act(() => api.unstageAll(projectId))}>
              Unstage all
            </button>
          )}
        </div>
        {staged.map((e) => (
          <Row
            key={`s-${e.path}`}
            entry={e}
            onOpen={() => onOpenDiff(e.path, e.type === 'deleted')}
            actions={
              <button
                className="chg-btn"
                aria-label={`Unstage ${e.path}`}
                onClick={() => void act(() => api.unstageFile(projectId, e.path))}
              >
                −
              </button>
            }
          />
        ))}
        <div className="chg-commit">
          <textarea
            className="chg-commit-msg"
            placeholder="Commit message (staged files)…"
            value={message}
            onChange={(ev) => setMessage(ev.target.value)}
            rows={2}
            spellCheck={false}
          />
          <button
            className="btn btn-primary chg-commit-btn"
            onClick={commit}
            disabled={!message.trim() || staged.length === 0 || busy}
          >
            Commit
          </button>
        </div>
      </section>

      <section className="chg-section">
        <div className="chg-head">
          Changes
          {unstaged.length > 0 && (
            <button className="chg-head-btn" onClick={() => void act(() => api.stageAll(projectId))}>
              Stage all
            </button>
          )}
        </div>
        {unstaged.map((e) => (
          <Row
            key={`u-${e.path}`}
            entry={e}
            onOpen={() => onOpenDiff(e.path, e.type === 'deleted')}
            actions={
              <>
                <button
                  className="chg-btn"
                  aria-label={`Discard ${e.path}`}
                  onClick={() => discard(e)}
                >
                  ↺
                </button>
                <button
                  className="chg-btn"
                  aria-label={`Stage ${e.path}`}
                  onClick={() => void act(() => api.stageFile(projectId, e.path))}
                >
                  +
                </button>
              </>
            }
          />
        ))}
      </section>

      {staged.length + unstaged.length + conflicts.length === 0 && data && (
        <div className="chg-note">No changes.</div>
      )}

      {/* currentPath is accepted for future active-row highlighting; unused today. */}
      <span hidden data-current={currentPath ?? ''} />
    </div>
  );
}
