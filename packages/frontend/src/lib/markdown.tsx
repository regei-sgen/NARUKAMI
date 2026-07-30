import type { ReactNode } from 'react';

/**
 * A small, dependency-free Markdown renderer for the editor's preview pane.
 *
 * It renders to React elements — never to an HTML string — so there is no
 * `dangerouslySetInnerHTML` anywhere and raw HTML in a document cannot execute;
 * it is shown as text. URLs are scheme-checked on top of that, so a
 * `javascript:` link degrades to plain text.
 *
 * Supported: ATX headings, fenced code, blockquotes, nested ordered/unordered
 * lists (incl. task lists), GFM pipe tables, thematic breaks, paragraphs, and
 * the inline set (code, strong, em, strikethrough, links, images, autolinks,
 * hard breaks, backslash escapes).
 */

type Block =
  | { kind: 'code'; lang: string; text: string }
  | { kind: 'heading'; level: number; text: string }
  | { kind: 'hr' }
  | { kind: 'quote'; blocks: Block[] }
  | { kind: 'list'; ordered: boolean; start: number; items: ListItem[] }
  | { kind: 'table'; header: string[]; align: Align[]; rows: string[][] }
  | { kind: 'para'; text: string };

interface ListItem {
  checked: boolean | null; // null = not a task-list item
  blocks: Block[];
}

type Align = 'left' | 'center' | 'right' | null;

const FENCE_RE = /^(\s{0,3})(`{3,}|~{3,})\s*([^`]*)$/;
const HEADING_RE = /^\s{0,3}(#{1,6})\s+(.*?)\s*#*\s*$/;
const HR_RE = /^\s{0,3}([-*_])\s*(?:\1\s*){2,}$/;
const QUOTE_RE = /^\s{0,3}>\s?(.*)$/;
const ITEM_RE = /^(\s*)([-*+]|\d{1,9}[.)])\s+(.*)$/;
const TABLE_DELIM_RE = /^\s*\|?\s*:?-{1,}:?\s*(\|\s*:?-{1,}:?\s*)*\|?\s*$/;

/** Split a GFM table row into cells, honouring escaped pipes. */
function splitRow(line: string): string[] {
  const cells: string[] = [];
  let cur = '';
  for (let i = 0; i < line.length; i += 1) {
    const c = line[i];
    if (c === '\\' && line[i + 1] === '|') {
      cur += '|';
      i += 1;
    } else if (c === '|') {
      cells.push(cur);
      cur = '';
    } else {
      cur += c;
    }
  }
  cells.push(cur);
  // A leading/trailing pipe produces an empty edge cell — drop those, not inner ones.
  if (cells.length && cells[0].trim() === '' && /^\s*\|/.test(line)) cells.shift();
  if (cells.length && cells[cells.length - 1].trim() === '' && /\|\s*$/.test(line)) cells.pop();
  return cells.map((c) => c.trim());
}

function parseAlign(delim: string): Align[] {
  return splitRow(delim).map((c) => {
    const left = c.startsWith(':');
    const right = c.endsWith(':');
    if (left && right) return 'center';
    if (right) return 'right';
    if (left) return 'left';
    return null;
  });
}

function isBlockStart(line: string): boolean {
  return (
    HEADING_RE.test(line) ||
    HR_RE.test(line) ||
    QUOTE_RE.test(line) ||
    ITEM_RE.test(line) ||
    FENCE_RE.test(line)
  );
}

function parseBlocks(lines: string[]): Block[] {
  const blocks: Block[] = [];
  let i = 0;

  while (i < lines.length) {
    const line = lines[i];

    if (!line.trim()) {
      i += 1;
      continue;
    }

    // ``` fenced code — everything inside is literal, including markers.
    const fence = line.match(FENCE_RE);
    if (fence) {
      const marker = fence[2][0];
      const len = fence[2].length;
      const lang = fence[3].trim();
      const body: string[] = [];
      i += 1;
      while (i < lines.length) {
        const close = lines[i].match(/^\s{0,3}(`{3,}|~{3,})\s*$/);
        if (close && close[1][0] === marker && close[1].length >= len) {
          i += 1;
          break;
        }
        body.push(lines[i]);
        i += 1;
      }
      // Trailing blank lines are an artifact of the fence/EOF, not content.
      blocks.push({ kind: 'code', lang, text: body.join('\n').replace(/\s+$/, '') });
      continue;
    }

    const hr = line.match(HR_RE);
    if (hr) {
      blocks.push({ kind: 'hr' });
      i += 1;
      continue;
    }

    const heading = line.match(HEADING_RE);
    if (heading) {
      blocks.push({ kind: 'heading', level: heading[1].length, text: heading[2] });
      i += 1;
      continue;
    }

    if (QUOTE_RE.test(line)) {
      const inner: string[] = [];
      while (i < lines.length && QUOTE_RE.test(lines[i])) {
        inner.push(lines[i].match(QUOTE_RE)![1]);
        i += 1;
      }
      blocks.push({ kind: 'quote', blocks: parseBlocks(inner) });
      continue;
    }

    // GFM table: a header row followed by a |---|:--:| delimiter row.
    if (line.includes('|') && i + 1 < lines.length && TABLE_DELIM_RE.test(lines[i + 1])) {
      const header = splitRow(line);
      const align = parseAlign(lines[i + 1]);
      i += 2;
      const rows: string[][] = [];
      while (i < lines.length && lines[i].includes('|') && lines[i].trim()) {
        rows.push(splitRow(lines[i]));
        i += 1;
      }
      blocks.push({ kind: 'table', header, align, rows });
      continue;
    }

    const item = line.match(ITEM_RE);
    if (item) {
      const baseIndent = item[1].length;
      const ordered = /\d/.test(item[2]);
      const start = ordered ? parseInt(item[2], 10) : 1;
      const raw: string[] = [];
      // Own the list until a non-indented line that isn't another item at this level.
      while (i < lines.length) {
        const l = lines[i];
        if (!l.trim()) {
          // A blank line ends the list unless what follows still belongs to it.
          let j = i + 1;
          while (j < lines.length && !lines[j].trim()) j += 1;
          const next = j < lines.length ? lines[j] : null;
          if (!next) break;
          const nextIndent = next.length - next.trimStart().length;
          const continues =
            nextIndent > baseIndent || (nextIndent === baseIndent && ITEM_RE.test(next));
          if (!continues) break;
          raw.push('');
          i += 1;
          continue;
        }
        const indent = l.length - l.trimStart().length;
        const m = l.match(ITEM_RE);
        if (indent < baseIndent || (indent === baseIndent && !m)) break;
        if (m && indent === baseIndent && /\d/.test(m[2]) !== ordered) break; // list type flipped
        raw.push(l);
        i += 1;
      }
      blocks.push({ kind: 'list', ordered, start, items: parseItems(raw, baseIndent) });
      continue;
    }

    // Paragraph: run until a blank line or the start of another block.
    const para: string[] = [line];
    i += 1;
    while (i < lines.length && lines[i].trim() && !isBlockStart(lines[i])) {
      // A table header only counts as a block once its delimiter row follows.
      if (lines[i].includes('|') && TABLE_DELIM_RE.test(lines[i + 1] ?? '')) break;
      para.push(lines[i]);
      i += 1;
    }
    blocks.push({ kind: 'para', text: para.join('\n') });
  }

  return blocks;
}

/** Split the raw lines of one list into items, then parse each item's content. */
function parseItems(raw: string[], baseIndent: number): ListItem[] {
  const items: ListItem[] = [];
  let cur: string[] | null = null;
  let curChecked: boolean | null = null;
  let contentIndent = 0;

  const flush = () => {
    if (cur === null) return;
    items.push({ checked: curChecked, blocks: parseBlocks(cur) });
    cur = null;
    curChecked = null;
  };

  for (const line of raw) {
    const m = line.match(ITEM_RE);
    const indent = line.length - line.trimStart().length;
    if (m && indent === baseIndent) {
      flush();
      contentIndent = m[1].length + m[2].length + 1;
      let text = m[3];
      const task = text.match(/^\[([ xX])\]\s+(.*)$/);
      if (task) {
        curChecked = task[1].toLowerCase() === 'x';
        text = task[2];
      } else {
        curChecked = null;
      }
      cur = [text];
    } else if (cur) {
      // Continuation / nested content — dedent by the marker width.
      cur.push(line.slice(Math.min(contentIndent, indent)));
    }
  }
  flush();
  return items;
}

// --- inline ---------------------------------------------------------------

/**
 * Only absolute web links (and in-document anchors) become real anchors. A
 * `javascript:`/`data:` URL is rejected outright, and a repo-relative link has
 * no served URL to point at — both render as inert text instead of navigating
 * the app window somewhere unexpected.
 */
function safeHref(href: string): string | null {
  const trimmed = href.trim();
  if (!trimmed) return null;
  return /^(https?:\/\/|mailto:|#)/i.test(trimmed) ? trimmed : null;
}

function safeSrc(src: string): string | null {
  const trimmed = src.trim();
  if (/^data:image\/(png|jpe?g|gif|webp|svg\+xml);/i.test(trimmed)) return trimmed;
  if (/^https?:\/\//i.test(trimmed)) return trimmed;
  return null; // relative paths have no served URL — the alt text stands in
}

const BARE_URL_RE = /^https?:\/\/[^\s<>[\]()]+/;

export function parseInline(text: string, keyBase = 'i'): ReactNode[] {
  const out: ReactNode[] = [];
  let buf = '';
  let n = 0;
  const push = (node: ReactNode) => {
    if (buf) {
      out.push(buf);
      buf = '';
    }
    out.push(node);
  };
  const key = () => `${keyBase}-${(n += 1)}`;

  let i = 0;
  while (i < text.length) {
    const rest = text.slice(i);
    const c = text[i];

    // Backslash escape.
    if (c === '\\' && i + 1 < text.length && /[\\`*_{}[\]()#+\-.!|~>]/.test(text[i + 1])) {
      buf += text[i + 1];
      i += 2;
      continue;
    }

    // Hard break: two+ trailing spaces before a newline, or a trailing backslash.
    if (c === '\n') {
      if (/ {2}$/.test(buf) || /\\$/.test(buf)) {
        buf = buf.replace(/(?: {2,}|\\)$/, '');
        push(<br key={key()} />);
      } else {
        buf += '\n';
      }
      i += 1;
      continue;
    }

    // `code span`
    if (c === '`') {
      const m = rest.match(/^(`+)([\s\S]*?)\1(?!`)/);
      if (m) {
        push(
          <code className="md-code" key={key()}>
            {m[2].replace(/^ | $/g, '')}
          </code>,
        );
        i += m[0].length;
        continue;
      }
    }

    // ![alt](src "title")
    if (c === '!' && text[i + 1] === '[') {
      const m = rest.match(/^!\[([^\]]*)\]\(\s*([^\s)]*)(?:\s+"[^"]*")?\s*\)/);
      if (m) {
        const src = safeSrc(m[2]);
        push(
          src ? (
            <img className="md-img" key={key()} src={src} alt={m[1]} loading="lazy" />
          ) : (
            <span className="md-img-missing" key={key()} title={m[2]}>
              {m[1] || m[2]}
            </span>
          ),
        );
        i += m[0].length;
        continue;
      }
    }

    // [text](href "title")
    if (c === '[') {
      const m = rest.match(/^\[([^\]]*)\]\(\s*([^\s)]*)(?:\s+"[^"]*")?\s*\)/);
      if (m) {
        const href = safeHref(m[2]);
        push(
          href ? (
            <a className="md-link" key={key()} href={href} target="_blank" rel="noreferrer noopener">
              {parseInline(m[1], `${keyBase}l${n}`)}
            </a>
          ) : (
            <span className="md-link-rel" key={key()} title={m[2]}>
              {parseInline(m[1], `${keyBase}l${n}`)}
            </span>
          ),
        );
        i += m[0].length;
        continue;
      }
    }

    // <https://autolink>
    if (c === '<') {
      const m = rest.match(/^<((?:https?:\/\/|mailto:)[^>\s]+)>/i);
      if (m) {
        push(
          <a className="md-link" key={key()} href={m[1]} target="_blank" rel="noreferrer noopener">
            {m[1]}
          </a>,
        );
        i += m[0].length;
        continue;
      }
    }

    // ~~strikethrough~~
    if (c === '~' && text[i + 1] === '~') {
      const m = rest.match(/^~~([\s\S]+?)~~/);
      if (m) {
        push(<del key={key()}>{parseInline(m[1], `${keyBase}d${n}`)}</del>);
        i += m[0].length;
        continue;
      }
    }

    // **strong** / __strong__
    if ((c === '*' || c === '_') && text[i + 1] === c) {
      const m = rest.match(c === '*' ? /^\*\*([\s\S]+?)\*\*/ : /^__([\s\S]+?)__/);
      if (m) {
        push(<strong key={key()}>{parseInline(m[1], `${keyBase}s${n}`)}</strong>);
        i += m[0].length;
        continue;
      }
    }

    // *em* / _em_ (underscore only at a word boundary, so snake_case survives)
    if (c === '*' || c === '_') {
      const prev = i > 0 ? text[i - 1] : '';
      const wordBoundary = c === '*' || !/[A-Za-z0-9]/.test(prev);
      const m = wordBoundary ? rest.match(c === '*' ? /^\*([^*\n]+?)\*/ : /^_([^_\n]+?)_(?![A-Za-z0-9])/) : null;
      if (m) {
        push(<em key={key()}>{parseInline(m[1], `${keyBase}e${n}`)}</em>);
        i += m[0].length;
        continue;
      }
    }

    // Bare URL.
    if (c === 'h') {
      const m = rest.match(BARE_URL_RE);
      if (m) {
        const url = m[0].replace(/[.,;:!?)]+$/, '');
        push(
          <a className="md-link" key={key()} href={url} target="_blank" rel="noreferrer noopener">
            {url}
          </a>,
        );
        i += url.length;
        continue;
      }
    }

    buf += c;
    i += 1;
  }

  if (buf) out.push(buf);
  return out;
}

// --- render ---------------------------------------------------------------

function renderBlocks(blocks: Block[], keyBase: string): ReactNode[] {
  return blocks.map((b, idx) => {
    const k = `${keyBase}-${idx}`;
    switch (b.kind) {
      case 'code':
        return (
          <pre className="md-pre" key={k} data-lang={b.lang || undefined}>
            {b.lang && <span className="md-pre-lang">{b.lang}</span>}
            <code>{b.text}</code>
          </pre>
        );
      case 'heading': {
        const Tag = `h${Math.min(b.level, 6)}` as 'h1';
        return (
          <Tag className={`md-h md-h${b.level}`} key={k}>
            {parseInline(b.text, k)}
          </Tag>
        );
      }
      case 'hr':
        return <hr className="md-hr" key={k} />;
      case 'quote':
        return (
          <blockquote className="md-quote" key={k}>
            {renderBlocks(b.blocks, k)}
          </blockquote>
        );
      case 'table':
        return (
          <div className="md-table-wrap" key={k}>
            <table className="md-table">
              <thead>
                <tr>
                  {b.header.map((h, ci) => (
                    <th key={ci} style={b.align[ci] ? { textAlign: b.align[ci]! } : undefined}>
                      {parseInline(h, `${k}h${ci}`)}
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {b.rows.map((row, ri) => (
                  <tr key={ri}>
                    {row.map((cell, ci) => (
                      <td key={ci} style={b.align[ci] ? { textAlign: b.align[ci]! } : undefined}>
                        {parseInline(cell, `${k}r${ri}c${ci}`)}
                      </td>
                    ))}
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        );
      case 'list': {
        const items = b.items.map((it, ii) => {
          const tight = it.blocks.length === 1 && it.blocks[0].kind === 'para';
          const body = tight
            ? parseInline((it.blocks[0] as { text: string }).text, `${k}-${ii}`)
            : renderBlocks(it.blocks, `${k}-${ii}`);
          return (
            <li className={it.checked === null ? 'md-li' : 'md-li md-task'} key={ii}>
              {it.checked !== null && (
                <input type="checkbox" className="md-check" checked={it.checked} readOnly />
              )}
              {body}
            </li>
          );
        });
        return b.ordered ? (
          <ol className="md-list" key={k} start={b.start}>
            {items}
          </ol>
        ) : (
          <ul className="md-list" key={k}>
            {items}
          </ul>
        );
      }
      case 'para':
      default:
        return (
          <p className="md-p" key={k}>
            {parseInline(b.text, k)}
          </p>
        );
    }
  });
}

/** Parse + render a Markdown document to React elements. */
export function renderMarkdown(source: string): ReactNode[] {
  const lines = source.replace(/\r\n?/g, '\n').split('\n');
  return renderBlocks(parseBlocks(lines), 'b');
}

export function Markdown({ source }: { source: string }) {
  return <div className="md-body">{renderMarkdown(source)}</div>;
}

/** True when a path should offer the rendered-Markdown preview. */
export function isMarkdownPath(filePath: string): boolean {
  return /\.(md|markdown|mdx)$/i.test(filePath);
}
