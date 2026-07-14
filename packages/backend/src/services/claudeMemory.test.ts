import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  capDoc,
  encodeProjectDir,
  memoryToText,
  projectMemoryDir,
  readProjectMemory,
  sortMemoryDocs,
  type MemoryDoc,
} from './claudeMemory';

describe('encodeProjectDir', () => {
  it('matches the live Windows layout exactly', () => {
    expect(encodeProjectDir('C:\\Users\\Stephanie Piape\\Documents\\NARUKAMI')).toBe(
      'C--Users-Stephanie-Piape-Documents-NARUKAMI',
    );
  });

  it('replaces every non-alphanumeric char with a single dash (no collapsing)', () => {
    // ':' + '\' both become '-', giving the leading '--'.
    expect(encodeProjectDir('C:\\a')).toBe('C--a');
    expect(encodeProjectDir('/home/user/proj')).toBe('-home-user-proj');
    expect(encodeProjectDir('a.b_c')).toBe('a-b-c');
  });
});

describe('capDoc', () => {
  it('leaves short content untouched', () => {
    expect(capDoc('hello')).toEqual({ content: 'hello', truncated: false });
  });
  it('clips over-long content and flags truncation', () => {
    const big = 'x'.repeat(9000);
    const out = capDoc(big);
    expect(out.truncated).toBe(true);
    expect(out.content.length).toBe(8000);
  });
});

describe('sortMemoryDocs', () => {
  it('orders index → memory (alpha) → claude-md', () => {
    const docs: MemoryDoc[] = [
      { source: 'claude-md', name: 'CLAUDE.md', content: '', truncated: false },
      { source: 'memory', name: 'b.md', content: '', truncated: false },
      { source: 'index', name: 'MEMORY.md', content: '', truncated: false },
      { source: 'memory', name: 'a.md', content: '', truncated: false },
    ];
    expect(sortMemoryDocs(docs).map((d) => d.name)).toEqual([
      'MEMORY.md',
      'a.md',
      'b.md',
      'CLAUDE.md',
    ]);
  });
});

describe('memoryToText', () => {
  it('renders each doc under its name header, marking truncation', () => {
    const text = memoryToText([
      { source: 'index', name: 'MEMORY.md', content: 'index body', truncated: false },
      { source: 'memory', name: 'a.md', content: 'a body', truncated: true },
    ]);
    expect(text).toContain('## MEMORY.md');
    expect(text).toContain('index body');
    expect(text).toContain('## a.md');
    expect(text).toContain('…(truncated)');
  });
});

describe('readProjectMemory', () => {
  let home: string;
  const projectPath = 'C:\\proj\\Demo'; // arbitrary; encoded into the fake home

  beforeEach(async () => {
    home = await mkdtemp(join(tmpdir(), 'narukami-mem-'));
    const memDir = join(home, '.claude', 'projects', encodeProjectDir(projectPath), 'memory');
    await mkdir(memDir, { recursive: true });
    await writeFile(join(memDir, 'MEMORY.md'), '# index\n- a', 'utf8');
    await writeFile(join(memDir, 'zebra.md'), 'zebra fact', 'utf8');
    await writeFile(join(memDir, 'apple.md'), 'apple fact', 'utf8');
    await writeFile(join(memDir, 'ignore.txt'), 'not markdown', 'utf8');
  });

  afterEach(async () => {
    await rm(home, { recursive: true, force: true });
  });

  it('reads MEMORY.md + memory/*.md, skips non-markdown, and sorts', async () => {
    const docs = await readProjectMemory(projectPath, home);
    expect(docs.map((d) => d.name)).toEqual(['MEMORY.md', 'apple.md', 'zebra.md']);
    expect(docs[0].source).toBe('index');
    expect(docs[1].source).toBe('memory');
    expect(docs.find((d) => d.name === 'ignore.txt')).toBeUndefined();
  });

  it('returns [] for a project with no Claude memory dir', async () => {
    const docs = await readProjectMemory('C:\\proj\\Unknown', home);
    expect(docs).toEqual([]);
  });

  it('projectMemoryDir points under <home>/.claude/projects/<enc>/memory', () => {
    expect(projectMemoryDir(projectPath, home)).toBe(
      join(home, '.claude', 'projects', encodeProjectDir(projectPath), 'memory'),
    );
  });
});
