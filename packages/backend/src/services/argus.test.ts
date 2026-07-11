import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  buildMemoryGraph,
  collectMemoryGraph,
  collectSessions,
  decodeProjectDir,
  normalizeSlug,
  parseMemoryNote,
  readNote,
  sessionState,
  splitTail,
  tailLog,
  type MemoryNodeRaw,
} from './argus';

describe('normalizeSlug', () => {
  it('lowercases and unifies underscore/hyphen', () => {
    expect(normalizeSlug('V2_Audit_Backlog')).toBe('v2-audit-backlog');
    expect(normalizeSlug('v2-audit-backlog')).toBe('v2-audit-backlog');
  });
});

describe('decodeProjectDir', () => {
  it('decodes an encoded project dir back to a path', () => {
    expect(decodeProjectDir('C--Users-lloyd-NARUKAMI')).toBe('C:/Users/lloyd/NARUKAMI');
  });
});

describe('sessionState', () => {
  it('buckets by staleness', () => {
    expect(sessionState(1000)).toBe('live'); // < 2min
    expect(sessionState(5 * 60 * 1000)).toBe('idle'); // < 30min
    expect(sessionState(60 * 60 * 1000)).toBe('recent'); // older
  });
});

describe('parseMemoryNote', () => {
  it('parses frontmatter, quoted description, links; defaults type to note', () => {
    const raw = [
      '---',
      'name: stay-on-branch',
      'description: "Do all work on this branch."',
      'metadata: ',
      '  node_type: memory',
      '  type: feedback',
      '  originSessionId: b95ac8cc-e9da-41ca-a353-8f11c765ccca',
      '---',
      '',
      'Body text. Related: [[narukami-project-overview]], [[v2-audit-backlog]].',
    ].join('\n');
    const p = parseMemoryNote(raw, 'stay-on-branch.md');
    expect(p.slug).toBe('stay-on-branch');
    expect(p.description).toBe('Do all work on this branch.');
    expect(p.type).toBe('feedback');
    expect(p.sid).toBe('b95ac8cc-e9da-41ca-a353-8f11c765ccca');
    expect(p.links).toEqual(['narukami-project-overview', 'v2-audit-backlog']);
  });

  it('strips NUL bytes and falls back to the filename slug with no frontmatter', () => {
    const raw = 'no frontmatter here\x00 with a NUL and a [[link]]';
    const p = parseMemoryNote(raw, 'nul-escape-in-source.md');
    expect(p.slug).toBe('nul-escape-in-source');
    expect(p.type).toBe('note');
    expect(p.links).toEqual(['link']);
  });
});

describe('buildMemoryGraph', () => {
  const notes: MemoryNodeRaw[] = [
    { proj: 'projA', slug: 'a', description: 'A', type: 'feedback', sid: 'sess-1234', links: ['b', 'v2-audit-backlog', 'ghosty'] },
    { proj: 'projA', slug: 'b', description: 'B', type: 'project', sid: '', links: [] },
    { proj: 'projA', slug: 'v2_audit_backlog', description: 'C', type: 'reference', sid: '', links: [] },
  ];

  it('resolves exact links, fuzzy (underscore/hyphen) links, and ghosts', () => {
    const g = buildMemoryGraph(notes);
    const edge = (to: string) => g.edges.find((e) => e.kind === 'links-to' && e.target === to);

    // exact
    expect(edge('mem:projA:b')).toBeTruthy();
    expect(edge('mem:projA:b')?.fuzzy).toBeUndefined();

    // fuzzy: [[v2-audit-backlog]] resolves to file slug "v2_audit_backlog"
    const fuzzy = edge('mem:projA:v2_audit_backlog');
    expect(fuzzy).toBeTruthy();
    expect(fuzzy?.fuzzy).toBe(true);

    // ghost: unresolved link
    expect(edge('ghost:projA:ghosty')).toBeTruthy();
    expect(g.nodes.find((n) => n.id === 'ghost:projA:ghosty')?.kind).toBe('ghost');
  });

  it('emits in-project + origin-session edges and correct counts', () => {
    const g = buildMemoryGraph(notes);
    expect(g.edges.some((e) => e.kind === 'in-project' && e.source === 'mem:projA:a' && e.target === 'proj:projA')).toBe(true);
    expect(g.edges.some((e) => e.kind === 'origin-session' && e.target === 'sess:sess-1234')).toBe(true);
    expect(g.counts.memory).toBe(3);
    expect(g.counts.projects).toBe(1);
    expect(g.counts.sessions).toBe(1);
    expect(g.counts.ghosts).toBe(1);
  });
});

describe('splitTail', () => {
  it('returns the last n non-empty lines and drops a partial first line', () => {
    const text = 'partial-half\nfull-1\nfull-2\nfull-3\n';
    expect(splitTail(text, 2, true)).toEqual(['full-2', 'full-3']);
    expect(splitTail(text, 10, false)).toEqual(['partial-half', 'full-1', 'full-2', 'full-3']);
  });
});

// ── fail-soft disk collectors against a temp CLAUDE_DIR fixture ───────────────

describe('collectors over a fixture ~/.claude', () => {
  let dir: string;
  const prev = process.env.ARGUS_CLAUDE_DIR;

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'argus-fix-'));
    process.env.ARGUS_CLAUDE_DIR = dir;
  });
  afterEach(() => {
    if (prev === undefined) delete process.env.ARGUS_CLAUDE_DIR;
    else process.env.ARGUS_CLAUDE_DIR = prev;
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it('collectSessions returns [] with no sessions dir (fail-soft)', async () => {
    const s = await collectSessions();
    expect(s).toEqual({ count: 0, live: 0, items: [] });
  });

  it('collectSessions parses the registry, joins mode overlay, skips torn files', async () => {
    const sess = path.join(dir, 'sessions');
    fs.mkdirSync(sess, { recursive: true });
    const now = 1_000_000;
    fs.writeFileSync(
      path.join(sess, '100.json'),
      JSON.stringify({ pid: 100, sessionId: 'sid-alive', cwd: 'C:\\proj', name: 'live-one', version: '2.1', status: 'busy', updatedAt: now - 1000 }),
    );
    fs.writeFileSync(path.join(sess, '200.json'), '{ this is: not json'); // torn — must be skipped
    const overlay = path.join(dir, 'godmode-sessions', 'sid-alive');
    fs.mkdirSync(overlay, { recursive: true });
    fs.writeFileSync(path.join(overlay, 'mode'), 'developer\nqa\n');

    const s = await collectSessions(now);
    expect(s.count).toBe(1); // torn file skipped
    expect(s.items[0].sessionId).toBe('sid-alive');
    expect(s.items[0].modes).toEqual(['developer', 'qa']);
    expect(s.items[0].state).toBe('live');
    expect(s.live).toBe(1);
    expect(s.items[0].origin).toBeUndefined(); // no id set supplied → untagged
  });

  it('collectSessions tags origin narukami vs native from the supplied id set', async () => {
    const sess = path.join(dir, 'sessions');
    fs.mkdirSync(sess, { recursive: true });
    const now = 1_000_000;
    fs.writeFileSync(
      path.join(sess, '100.json'),
      JSON.stringify({ pid: 100, sessionId: 'sid-ours', cwd: 'C:\\proj', updatedAt: now - 1000 }),
    );
    fs.writeFileSync(
      path.join(sess, '101.json'),
      JSON.stringify({ pid: 101, sessionId: 'sid-native', cwd: 'C:\\proj', updatedAt: now - 1000 }),
    );

    const s = await collectSessions(now, new Set(['sid-ours']));
    const byId = Object.fromEntries(s.items.map((i) => [i.sessionId, i.origin]));
    expect(byId['sid-ours']).toBe('narukami'); // launched by NARUKAMI
    expect(byId['sid-native']).toBe('native'); // a plain `claude` CLI session
  });

  it('collectMemoryGraph reads real files incl. a NUL-byte note', async () => {
    const mem = path.join(dir, 'projects', 'C--Users-lloyd-NARUKAMI', 'memory');
    fs.mkdirSync(mem, { recursive: true });
    fs.writeFileSync(path.join(mem, 'MEMORY.md'), '# index\n- [x](a.md)\n'); // excluded
    fs.writeFileSync(
      path.join(mem, 'a.md'),
      '---\nname: a\ndescription: A note\nmetadata:\n  type: feedback\n---\nlinks [[b]] and [[ghost-x]]',
    );
    fs.writeFileSync(path.join(mem, 'b.md'), '---\nname: b\n---\nplain\x00 body');

    const g = await collectMemoryGraph(Date.now());
    expect(g.counts.memory).toBe(2); // MEMORY.md excluded
    expect(g.counts.ghosts).toBe(1);
    expect(g.nodes.some((n) => n.id === 'mem:C--Users-lloyd-NARUKAMI:a')).toBe(true);
  });

  it('readNote returns body + backlinks and rejects a traversal slug', async () => {
    const mem = path.join(dir, 'projects', 'proj', 'memory');
    fs.mkdirSync(mem, { recursive: true });
    fs.writeFileSync(path.join(mem, 'target.md'), '---\nname: target\ndescription: T\n---\nI am the target.');
    fs.writeFileSync(path.join(mem, 'linker.md'), '---\nname: linker\n---\nsee [[target]]');

    const note = await readNote('proj', 'target');
    expect(note?.body).toBe('I am the target.');
    expect(note?.backlinks).toEqual(['linker']);

    expect(await readNote('proj', '../../secret')).toBeNull(); // path-traversal rejected
  });

  it('tailLog rejects an unknown source and tails an allowlisted one', async () => {
    const bad = await tailLog('../../secret', 10);
    expect('error' in bad).toBe(true);

    // Write a perf log with a couple of JSONL lines + one torn line.
    fs.writeFileSync(
      path.join(dir, 'godmode-perf.log'),
      '{"ts":"t1","hook":"a","ms":1}\n{"ts":"t2","hook":"b","ms":2}\n{torn line\n',
    );
    const res = await tailLog('perf', 2);
    expect('error' in res).toBe(false);
    if (!('error' in res)) {
      expect(res.count).toBe(2);
      // last two complete records; torn line parsed tolerantly to {raw}
      expect(res.lines[res.lines.length - 1]).toHaveProperty('raw');
    }
  });
});
