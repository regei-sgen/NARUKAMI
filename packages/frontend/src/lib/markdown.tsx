// A small, dependency-free Markdown renderer for the Blueprint tab. The frontend
// ships no markdown library, and the blueprint content is trusted GitHub-flavored
// Markdown we generate ourselves, so a focused parser covering the constructs we
// actually emit (headings, fenced code, lists, tables, blockquotes, rules, and
// inline bold/italic/code/strike/links) is lighter and safer than pulling in a
// full CommonMark engine. Parsing is split into pure functions (parseBlocks,
// tokenizeInline) so the tricky bits are unit-tested without a DOM.
import { useMemo, type ReactNode } from 'react';

// --- inline tokens ---------------------------------------------------------
export type InlineToken =
  | { type: 'text'; text: string }
  | { type: 'code'; text: string }
  | { type: 'strong'; children: InlineToken[] }
  | { type: 'em'; children: InlineToken[] }
  | { type: 'del'; children: InlineToken[] }
  | { type: 'link'; href: string; children: InlineToken[] };

type InlineRule = { type: 'code' | 'link' | 'strong' | 'em' | 'del'; re: RegExp };

// Order matters: `code` first so backtick spans win over emphasis inside them,
// then links, then the emphasis rules. On a tie for earliest index the first
// rule listed wins (see tokenizeInline).
const INLINE_RULES: InlineRule[] = [
  { type: 'code', re: /`([^`]+)`/ },
  { type: 'link', re: /\[([^\]]+)\]\(([^)\s]+)\)/ },
  { type: 'strong', re: /\*\*([^*]+?)\*\*/ },
  { type: 'strong', re: /__([^_]+?)__/ },
  { type: 'del', re: /~~([^~]+?)~~/ },
  { type: 'em', re: /\*([^*]+?)\*/ },
  { type: 'em', re: /_([^_]+?)_/ },
];

// Split a line of text into inline tokens. Recurses into the matched group and
// the remaining tail; each recursion works on a strictly shorter string, so it
// always terminates.
export function tokenizeInline(text: string): InlineToken[] {
  if (!text) return [];
  let best: { rule: InlineRule; match: RegExpExecArray } | null = null;
  for (const rule of INLINE_RULES) {
    const m = rule.re.exec(text);
    if (m && (best === null || m.index < best.match.index)) best = { rule, match: m };
  }
  if (!best) return [{ type: 'text', text }];

  const { rule, match } = best;
  const before = text.slice(0, match.index);
  const after = text.slice(match.index + match[0].length);
  const out: InlineToken[] = [];
  if (before) out.push({ type: 'text', text: before });
  if (rule.type === 'code') {
    out.push({ type: 'code', text: match[1] });
  } else if (rule.type === 'link') {
    out.push({ type: 'link', href: match[2], children: tokenizeInline(match[1]) });
  } else {
    out.push({ type: rule.type, children: tokenizeInline(match[1]) });
  }
  return out.concat(tokenizeInline(after));
}

// --- block parsing ---------------------------------------------------------
export type Block =
  | { type: 'heading'; level: number; text: string }
  | { type: 'paragraph'; text: string }
  | { type: 'code'; lang: string; code: string }
  | { type: 'list'; ordered: boolean; items: string[] }
  | { type: 'quote'; text: string }
  | { type: 'hr' }
  | { type: 'table'; headers: string[]; rows: string[][] };

const UL_RE = /^\s*[-*+]\s+(.*)$/;
const OL_RE = /^\s*\d+[.)]\s+(.*)$/;
const HR_RE = /^(-{3,}|\*{3,}|_{3,})$/;
const HEADING_RE = /^(#{1,6})\s+(.*)$/;

const isBlank = (s: string): boolean => s.trim() === '';
const parseCells = (s: string): string[] =>
  s.trim().replace(/^\|/, '').replace(/\|$/, '').split('|').map((c) => c.trim());

// Parse a Markdown document into a flat list of block tokens.
export function parseBlocks(md: string): Block[] {
  const lines = md.replace(/\r\n?/g, '\n').split('\n');
  const blocks: Block[] = [];
  let i = 0;

  while (i < lines.length) {
    const line = lines[i];
    if (isBlank(line)) {
      i += 1;
      continue;
    }

    // fenced code block ```lang ... ```
    const fence = /^```(.*)$/.exec(line.trim());
    if (fence) {
      const lang = fence[1].trim();
      const buf: string[] = [];
      i += 1;
      while (i < lines.length && !/^```/.test(lines[i].trim())) {
        buf.push(lines[i]);
        i += 1;
      }
      i += 1; // consume the closing fence (if present)
      blocks.push({ type: 'code', lang, code: buf.join('\n') });
      continue;
    }

    // heading
    const h = HEADING_RE.exec(line);
    if (h) {
      blocks.push({ type: 'heading', level: h[1].length, text: h[2].trim() });
      i += 1;
      continue;
    }

    // horizontal rule
    if (HR_RE.test(line.trim())) {
      blocks.push({ type: 'hr' });
      i += 1;
      continue;
    }

    // GFM table: a pipe row followed by a |---|:-:|--- separator row
    const sep = i + 1 < lines.length ? lines[i + 1] : '';
    const isSep = sep.includes('|') && sep.includes('-') && /^[\s:\-|]+$/.test(sep.trim());
    if (line.includes('|') && isSep) {
      const headers = parseCells(line);
      i += 2;
      const rows: string[][] = [];
      while (i < lines.length && lines[i].includes('|') && !isBlank(lines[i])) {
        rows.push(parseCells(lines[i]));
        i += 1;
      }
      blocks.push({ type: 'table', headers, rows });
      continue;
    }

    // blockquote (consecutive `>` lines)
    if (/^\s*>/.test(line)) {
      const buf: string[] = [];
      while (i < lines.length && /^\s*>/.test(lines[i])) {
        buf.push(lines[i].replace(/^\s*>\s?/, ''));
        i += 1;
      }
      blocks.push({ type: 'quote', text: buf.join(' ') });
      continue;
    }

    // list (unordered or ordered) — a run of same-kind item lines
    if (UL_RE.test(line) || OL_RE.test(line)) {
      const ordered = OL_RE.test(line);
      const re = ordered ? OL_RE : UL_RE;
      const items: string[] = [];
      while (i < lines.length && re.test(lines[i])) {
        const m = re.exec(lines[i]) as RegExpExecArray;
        items.push(m[1].trim());
        i += 1;
      }
      blocks.push({ type: 'list', ordered, items });
      continue;
    }

    // paragraph — consecutive lines until a blank or a block starter
    const buf: string[] = [];
    while (
      i < lines.length &&
      !isBlank(lines[i]) &&
      !/^```/.test(lines[i].trim()) &&
      !HEADING_RE.test(lines[i]) &&
      !/^\s*>/.test(lines[i]) &&
      !UL_RE.test(lines[i]) &&
      !OL_RE.test(lines[i]) &&
      !HR_RE.test(lines[i].trim())
    ) {
      buf.push(lines[i].trim());
      i += 1;
    }
    blocks.push({ type: 'paragraph', text: buf.join(' ') });
  }

  return blocks;
}

// --- rendering -------------------------------------------------------------
function renderTokens(tokens: InlineToken[], keyPrefix: string): ReactNode[] {
  return tokens.map((t, idx) => {
    const k = `${keyPrefix}-${idx}`;
    switch (t.type) {
      case 'text':
        return t.text;
      case 'code':
        return (
          <code key={k} className="md-code">
            {t.text}
          </code>
        );
      case 'strong':
        return <strong key={k}>{renderTokens(t.children, k)}</strong>;
      case 'em':
        return <em key={k}>{renderTokens(t.children, k)}</em>;
      case 'del':
        return <del key={k}>{renderTokens(t.children, k)}</del>;
      case 'link':
        return (
          <a key={k} className="md-link" href={t.href} target="_blank" rel="noreferrer">
            {renderTokens(t.children, k)}
          </a>
        );
    }
  });
}

const inlineOf = (text: string, key: string): ReactNode[] => renderTokens(tokenizeInline(text), key);

function renderBlock(b: Block, i: number): ReactNode {
  const key = `b${i}`;
  switch (b.type) {
    case 'heading': {
      const level = Math.min(Math.max(b.level, 1), 6);
      const Tag = `h${level}` as keyof JSX.IntrinsicElements;
      return (
        <Tag key={key} className={`md-h md-h${level}`}>
          {inlineOf(b.text, key)}
        </Tag>
      );
    }
    case 'paragraph':
      return (
        <p key={key} className="md-p">
          {inlineOf(b.text, key)}
        </p>
      );
    case 'code':
      return (
        <pre key={key} className="md-pre">
          <code className={`md-block-code${b.lang ? ` lang-${b.lang}` : ''}`}>{b.code}</code>
        </pre>
      );
    case 'list':
      return b.ordered ? (
        <ol key={key} className="md-ol">
          {b.items.map((it, j) => (
            <li key={j}>{inlineOf(it, `${key}-${j}`)}</li>
          ))}
        </ol>
      ) : (
        <ul key={key} className="md-ul">
          {b.items.map((it, j) => (
            <li key={j}>{inlineOf(it, `${key}-${j}`)}</li>
          ))}
        </ul>
      );
    case 'quote':
      return (
        <blockquote key={key} className="md-quote">
          {inlineOf(b.text, key)}
        </blockquote>
      );
    case 'hr':
      return <hr key={key} className="md-hr" />;
    case 'table':
      return (
        <div key={key} className="md-table-wrap">
          <table className="md-table">
            <thead>
              <tr>
                {b.headers.map((hd, j) => (
                  <th key={j}>{inlineOf(hd, `${key}-h${j}`)}</th>
                ))}
              </tr>
            </thead>
            <tbody>
              {b.rows.map((r, j) => (
                <tr key={j}>
                  {r.map((c, kk) => (
                    <td key={kk}>{inlineOf(c, `${key}-${j}-${kk}`)}</td>
                  ))}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      );
  }
}

// Render a Markdown string as React nodes.
export function Markdown({ text }: { text: string }): JSX.Element {
  const blocks = useMemo(() => parseBlocks(text), [text]);
  return <div className="md">{blocks.map((b, i) => renderBlock(b, i))}</div>;
}
