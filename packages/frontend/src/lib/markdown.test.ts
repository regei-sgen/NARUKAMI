import { describe, it, expect } from 'vitest';
import { parseBlocks, tokenizeInline } from './markdown';

describe('parseBlocks', () => {
  it('parses ATX headings with their level', () => {
    expect(parseBlocks('# Title')).toEqual([{ type: 'heading', level: 1, text: 'Title' }]);
    expect(parseBlocks('### Sub head ')).toEqual([{ type: 'heading', level: 3, text: 'Sub head' }]);
  });

  it('joins wrapped lines into a single paragraph and splits on blank lines', () => {
    expect(parseBlocks('one\ntwo\n\nthree')).toEqual([
      { type: 'paragraph', text: 'one two' },
      { type: 'paragraph', text: 'three' },
    ]);
  });

  it('captures a fenced code block verbatim with its language', () => {
    const md = '```ts\nconst a = 1;\nconst b = 2;\n```';
    expect(parseBlocks(md)).toEqual([{ type: 'code', lang: 'ts', code: 'const a = 1;\nconst b = 2;' }]);
  });

  it('does not treat block markers inside a fence as blocks', () => {
    const md = '```\n# not a heading\n- not a list\n```';
    expect(parseBlocks(md)).toEqual([{ type: 'code', lang: '', code: '# not a heading\n- not a list' }]);
  });

  it('parses unordered and ordered lists as runs of items', () => {
    expect(parseBlocks('- a\n- b\n* c')).toEqual([
      { type: 'list', ordered: false, items: ['a', 'b', 'c'] },
    ]);
    expect(parseBlocks('1. first\n2. second')).toEqual([
      { type: 'list', ordered: true, items: ['first', 'second'] },
    ]);
  });

  it('separates an ordered list that immediately follows an unordered one', () => {
    expect(parseBlocks('- a\n1. b')).toEqual([
      { type: 'list', ordered: false, items: ['a'] },
      { type: 'list', ordered: true, items: ['b'] },
    ]);
  });

  it('parses blockquotes and horizontal rules', () => {
    expect(parseBlocks('> quoted\n> lines')).toEqual([{ type: 'quote', text: 'quoted lines' }]);
    expect(parseBlocks('---')).toEqual([{ type: 'hr' }]);
  });

  it('parses a GFM table with a separator row', () => {
    const md = '| Method | Path |\n| --- | --- |\n| GET | /api/projects |\n| POST | /api/projects |';
    expect(parseBlocks(md)).toEqual([
      {
        type: 'table',
        headers: ['Method', 'Path'],
        rows: [
          ['GET', '/api/projects'],
          ['POST', '/api/projects'],
        ],
      },
    ]);
  });

  it('treats a lone pipe line without a separator as a paragraph, not a table', () => {
    expect(parseBlocks('a | b | c')).toEqual([{ type: 'paragraph', text: 'a | b | c' }]);
  });
});

describe('tokenizeInline', () => {
  it('returns a single text token for plain text', () => {
    expect(tokenizeInline('hello world')).toEqual([{ type: 'text', text: 'hello world' }]);
  });

  it('parses inline code, bold, italic and strikethrough', () => {
    expect(tokenizeInline('`x`')).toEqual([{ type: 'code', text: 'x' }]);
    expect(tokenizeInline('**b**')).toEqual([{ type: 'strong', children: [{ type: 'text', text: 'b' }] }]);
    expect(tokenizeInline('_i_')).toEqual([{ type: 'em', children: [{ type: 'text', text: 'i' }] }]);
    expect(tokenizeInline('~~d~~')).toEqual([{ type: 'del', children: [{ type: 'text', text: 'd' }] }]);
  });

  it('splits surrounding text around a match', () => {
    expect(tokenizeInline('a **b** c')).toEqual([
      { type: 'text', text: 'a ' },
      { type: 'strong', children: [{ type: 'text', text: 'b' }] },
      { type: 'text', text: ' c' },
    ]);
  });

  it('prefers bold over the italic it contains (earliest-and-longest wins)', () => {
    expect(tokenizeInline('**bold**')).toEqual([
      { type: 'strong', children: [{ type: 'text', text: 'bold' }] },
    ]);
  });

  it('parses links with their href and inline label', () => {
    expect(tokenizeInline('see [docs](https://x.dev)')).toEqual([
      { type: 'text', text: 'see ' },
      { type: 'link', href: 'https://x.dev', children: [{ type: 'text', text: 'docs' }] },
    ]);
  });

  it('does not parse emphasis inside inline code', () => {
    expect(tokenizeInline('`a * b`')).toEqual([{ type: 'code', text: 'a * b' }]);
  });
});
