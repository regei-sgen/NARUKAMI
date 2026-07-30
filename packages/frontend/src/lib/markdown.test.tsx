import { describe, it, expect } from 'vitest';
import { render, screen } from '@testing-library/react';
import { Markdown, isMarkdownPath } from './markdown';

const md = (source: string) => render(<Markdown source={source} />).container;

describe('isMarkdownPath', () => {
  it('accepts markdown extensions, case-insensitively', () => {
    expect(isMarkdownPath('docs/README.md')).toBe(true);
    expect(isMarkdownPath('A.MARKDOWN')).toBe(true);
    expect(isMarkdownPath('notes.mdx')).toBe(true);
  });
  it('rejects everything else', () => {
    expect(isMarkdownPath('src/index.ts')).toBe(false);
    expect(isMarkdownPath('mdfile.txt')).toBe(false);
  });
});

describe('block rendering', () => {
  it('renders ATX headings at the right level', () => {
    const c = md('# One\n\n### Three');
    expect(c.querySelector('h1')?.textContent).toBe('One');
    expect(c.querySelector('h3')?.textContent).toBe('Three');
  });

  it('renders paragraphs', () => {
    const c = md('hello world\n\nsecond para');
    expect(c.querySelectorAll('p')).toHaveLength(2);
  });

  it('renders fenced code verbatim, including markdown-looking text', () => {
    const c = md('```ts\nconst a = **1**;\n# not a heading\n```');
    const pre = c.querySelector('pre code')!;
    expect(pre.textContent).toBe('const a = **1**;\n# not a heading');
    expect(c.querySelector('h1')).toBeNull();
    expect(c.querySelector('strong')).toBeNull();
  });

  it('renders a thematic break', () => {
    expect(md('a\n\n---\n\nb').querySelector('hr')).not.toBeNull();
  });

  it('renders blockquotes with nested blocks', () => {
    const c = md('> quoted **text**\n> \n> - item');
    expect(c.querySelector('blockquote strong')?.textContent).toBe('text');
    expect(c.querySelector('blockquote li')?.textContent).toContain('item');
  });

  it('renders unordered and ordered lists', () => {
    const ul = md('- a\n- b\n- c');
    expect(ul.querySelectorAll('ul > li')).toHaveLength(3);
    const ol = md('3. three\n4. four');
    expect(ol.querySelector('ol')?.getAttribute('start')).toBe('3');
    expect(ol.querySelectorAll('ol > li')).toHaveLength(2);
  });

  it('nests sub-lists under their parent item', () => {
    const c = md('- parent\n  - child\n  - child2\n- sibling');
    const top = c.querySelectorAll('.md-body > ul > li');
    expect(top).toHaveLength(2);
    expect(top[0].querySelectorAll('ul > li')).toHaveLength(2);
  });

  it('renders task list checkboxes', () => {
    const c = md('- [x] done\n- [ ] todo');
    const boxes = c.querySelectorAll('input[type=checkbox]');
    expect(boxes).toHaveLength(2);
    expect((boxes[0] as HTMLInputElement).checked).toBe(true);
    expect((boxes[1] as HTMLInputElement).checked).toBe(false);
  });

  it('renders GFM tables with alignment', () => {
    const c = md('| a | b |\n| :-- | --: |\n| 1 | 2 |\n| 3 | 4 |');
    expect(c.querySelectorAll('thead th')).toHaveLength(2);
    expect(c.querySelectorAll('tbody tr')).toHaveLength(2);
    expect((c.querySelectorAll('thead th')[1] as HTMLElement).style.textAlign).toBe('right');
  });

  it('does not treat a lone pipe line as a table', () => {
    const c = md('a | b\n\nplain');
    expect(c.querySelector('table')).toBeNull();
  });
});

describe('inline rendering', () => {
  it('renders strong, em, strikethrough and code spans', () => {
    const c = md('**bold** _em_ ~~gone~~ `code()`');
    expect(c.querySelector('strong')?.textContent).toBe('bold');
    expect(c.querySelector('em')?.textContent).toBe('em');
    expect(c.querySelector('del')?.textContent).toBe('gone');
    expect(c.querySelector('code')?.textContent).toBe('code()');
  });

  it('leaves snake_case words alone', () => {
    const c = md('call some_var_name here');
    expect(c.querySelector('em')).toBeNull();
    expect(c.textContent).toContain('some_var_name');
  });

  it('renders links that open externally', () => {
    md('[site](https://example.com)');
    const a = screen.getByRole('link', { name: 'site' }) as HTMLAnchorElement;
    expect(a.getAttribute('href')).toBe('https://example.com');
    expect(a.getAttribute('rel')).toContain('noopener');
    expect(a.getAttribute('target')).toBe('_blank');
  });

  it('autolinks bare and angle-bracket URLs', () => {
    const c = md('see https://example.com/x and <https://b.test>');
    const hrefs = Array.from(c.querySelectorAll('a')).map((a) => a.getAttribute('href'));
    expect(hrefs).toEqual(['https://example.com/x', 'https://b.test']);
  });

  it('never emits a javascript: link', () => {
    const c = md('[click](javascript:alert(1))');
    expect(c.querySelector('a')).toBeNull();
    expect(c.textContent).toContain('click');
  });

  it('renders repo-relative links as inert text', () => {
    const c = md('[doc](../other/file.md)');
    expect(c.querySelector('a')).toBeNull();
    expect(c.querySelector('.md-link-rel')?.textContent).toBe('doc');
  });

  it('renders http images and falls back to alt text for relative ones', () => {
    const remote = md('![pic](https://example.com/a.png)');
    expect(remote.querySelector('img')?.getAttribute('src')).toBe('https://example.com/a.png');
    const local = md('![diagram](./assets/x.png)');
    expect(local.querySelector('img')).toBeNull();
    expect(local.textContent).toContain('diagram');
  });

  it('honours backslash escapes', () => {
    const c = md('\\*not em\\*');
    expect(c.querySelector('em')).toBeNull();
    expect(c.textContent).toBe('*not em*');
  });

  it('renders raw HTML as text, never as markup', () => {
    const c = md('<img src=x onerror="boom()"> <script>bad()</script>');
    expect(c.querySelector('img')).toBeNull();
    expect(c.querySelector('script')).toBeNull();
    expect(c.textContent).toContain('<script>bad()</script>');
  });

  it('turns two trailing spaces into a hard break', () => {
    const c = md('line one  \nline two');
    expect(c.querySelectorAll('br')).toHaveLength(1);
  });
});

describe('robustness', () => {
  it('renders an empty document without throwing', () => {
    expect(md('').textContent).toBe('');
  });

  it('handles an unterminated code fence', () => {
    const c = md('```\nstill code\n');
    expect(c.querySelector('pre code')?.textContent).toBe('still code');
  });

  it('handles CRLF input', () => {
    const c = md('# title\r\n\r\nbody');
    expect(c.querySelector('h1')?.textContent).toBe('title');
    expect(c.querySelector('p')?.textContent).toBe('body');
  });
});
