import { useEffect, useState } from 'react';
import { api } from '../../api';
import type { MemoryNoteDetail } from '../../types';

interface Props {
  project: string;
  slug: string;
  onClose: () => void;
  onOpenSlug: (project: string, slug: string) => void;
}

/** Per-note viewer drawer: frontmatter + body + backlinks/outlinks. */
export function NoteViewer({ project, slug, onClose, onOpenSlug }: Props) {
  const [note, setNote] = useState<MemoryNoteDetail | null>(null);
  const [err, setErr] = useState<string | null>(null);

  useEffect(() => {
    let alive = true;
    setNote(null);
    setErr(null);
    api
      .getArgusNote(project, slug)
      .then((n) => alive && setNote(n))
      .catch((e) => alive && setErr((e as Error).message));
    return () => {
      alive = false;
    };
  }, [project, slug]);

  return (
    <aside className="argus-note-drawer">
      <div className="argus-note-drawer-head">
        <div>
          <span className="argus-note-type">{note?.type ?? 'note'}</span>
          <h4 className="argus-mono">{note?.name ?? slug}</h4>
        </div>
        <button className="argus-x" onClick={onClose} title="Close">
          ×
        </button>
      </div>

      {err ? (
        <div className="argus-empty">{err}</div>
      ) : !note ? (
        <div className="argus-empty">Loading…</div>
      ) : (
        <div className="argus-note-body-wrap">
          {note.description && <p className="argus-note-desc">{note.description}</p>}

          {(note.outlinks.length > 0 || note.backlinks.length > 0) && (
            <div className="argus-note-links">
              {note.backlinks.length > 0 && (
                <div className="argus-note-linkgroup">
                  <span className="argus-note-linklabel">← backlinks</span>
                  {note.backlinks.map((b) => (
                    <button key={b} className="argus-link-chip" onClick={() => onOpenSlug(project, b)}>
                      {b}
                    </button>
                  ))}
                </div>
              )}
              {note.outlinks.length > 0 && (
                <div className="argus-note-linkgroup">
                  <span className="argus-note-linklabel">→ links to</span>
                  {note.outlinks.map((o) => (
                    <button key={o} className="argus-link-chip" onClick={() => onOpenSlug(project, o)}>
                      {o}
                    </button>
                  ))}
                </div>
              )}
            </div>
          )}

          <pre className="argus-note-body">{note.body}</pre>
        </div>
      )}
    </aside>
  );
}
