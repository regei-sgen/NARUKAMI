import { useMemo, useRef, useState } from 'react';
import { Markdown } from '../lib/markdown';
import { BLUEPRINT, blueprintMarkdown, orderedSections } from '../lib/blueprint';

// The "Blueprint" tab: a complete, copy-pasteable specification of every function
// and subsystem in NARUKAMI. A table of contents on the left; the rendered spec on
// the right, filterable, with per-section + whole-document copy and a .md download.
// Copy any part, hand it to your own Claude, and rebuild the app.
export function Blueprint() {
  const bp = BLUEPRINT;
  const ordered = useMemo(() => orderedSections(bp), [bp]);
  // The whole-document Markdown is ~440KB — build it once, not per keystroke.
  const fullMd = useMemo(() => blueprintMarkdown(bp), [bp]);
  const [query, setQuery] = useState('');
  const [copied, setCopied] = useState<string | null>(null);
  const docRef = useRef<HTMLDivElement>(null);

  const q = query.trim().toLowerCase();
  const shown = q
    ? ordered.filter((s) => `${s.title} ${s.summary} ${s.markdown}`.toLowerCase().includes(q))
    : ordered;

  const flash = (tag: string) => {
    setCopied(tag);
    setTimeout(() => setCopied((c) => (c === tag ? null : c)), 1500);
  };
  const copy = async (text: string, tag: string) => {
    try {
      await navigator.clipboard.writeText(text);
      flash(tag);
    } catch {
      // Clipboard blocked (rare in the desktop shell) — fall back to a temp
      // textarea + execCommand so copy still works.
      try {
        const ta = document.createElement('textarea');
        ta.value = text;
        ta.style.position = 'fixed';
        ta.style.opacity = '0';
        document.body.appendChild(ta);
        ta.select();
        document.execCommand('copy');
        document.body.removeChild(ta);
        flash(tag);
      } catch {
        /* give up silently */
      }
    }
  };

  const download = () => {
    const blob = new Blob([fullMd], { type: 'text/markdown;charset=utf-8' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = 'NARUKAMI-blueprint.md';
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    URL.revokeObjectURL(url);
  };

  const scrollTo = (anchor: string) => {
    setQuery('');
    // Defer so a cleared filter re-renders the full list before we scroll.
    requestAnimationFrame(() => {
      docRef.current?.querySelector(`#bp-${anchor}`)?.scrollIntoView({ behavior: 'smooth', block: 'start' });
    });
  };

  if (!bp.sections.length) {
    return (
      <div className="bp-empty">
        <p>The app blueprint hasn’t been generated yet.</p>
        <p className="muted">Ask Claude to “regenerate the blueprint” to document the app here.</p>
      </div>
    );
  }

  const count = fullMd.length;

  return (
    <div className="bp">
      <aside className="bp-toc">
        <div className="bp-toc-head">Contents</div>
        <ul className="bp-toc-list">
          {ordered.map((s) => (
            <li key={s.anchor}>
              <button
                className={`bp-toc-link ${q && !shown.includes(s) ? 'dim' : ''}`}
                title={s.summary}
                onClick={() => scrollTo(s.anchor)}
              >
                {s.title}
              </button>
            </li>
          ))}
        </ul>
        <div className="bp-toc-foot">
          {ordered.length} sections · {(count / 1000).toFixed(1)}k chars
        </div>
      </aside>

      <div className="bp-main">
        <div className="bp-bar">
          <div className="bp-title">{bp.title}</div>
          <input
            className="bp-search"
            placeholder="Filter sections…"
            value={query}
            spellCheck={false}
            onChange={(e) => setQuery(e.target.value)}
          />
          <button className="btn btn-primary bp-copyall" onClick={() => copy(fullMd, 'all')}>
            {copied === 'all' ? 'Copied ✓' : 'Copy all (Markdown)'}
          </button>
          <button className="btn" onClick={download}>
            Download .md
          </button>
        </div>

        <div className="bp-doc" ref={docRef}>
          {bp.preamble && (
            <div className="bp-preamble">
              <div className="bp-preamble-head">
                <span className="bp-preamble-title">Paste this to your Claude to rebuild the app</span>
                <button className="btn bp-copy-sm" onClick={() => copy(bp.preamble, 'pre')}>
                  {copied === 'pre' ? 'Copied ✓' : 'Copy'}
                </button>
              </div>
              <pre className="bp-preamble-text">{bp.preamble}</pre>
            </div>
          )}

          {bp.intro && !q && (
            <div className="bp-intro">
              <Markdown text={bp.intro} />
            </div>
          )}

          {shown.map((s) => (
            <section key={s.anchor} id={`bp-${s.anchor}`} className="bp-section">
              <div className="bp-section-actions">
                <button className="btn bp-copy-sm" onClick={() => copy(s.markdown, s.anchor)}>
                  {copied === s.anchor ? 'Copied ✓' : 'Copy section'}
                </button>
              </div>
              <Markdown text={s.markdown} />
            </section>
          ))}

          {q && shown.length === 0 && <div className="bp-empty">No sections match “{query}”.</div>}
        </div>
      </div>
    </div>
  );
}
