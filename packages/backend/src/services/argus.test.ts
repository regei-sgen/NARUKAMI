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
  readUsage,
  sessionState,
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
});

// ── readUsage across BOTH godclaude homes ────────────────────────────────────
// Regression cover for the split-home bug: the statusline hook writes
// usage-live.json into `${DET_HOOKS_HOME}/.claude`, and NARUKAMI sets
// DET_HOOKS_HOME to its EMBEDDED god home on every process it spawns — so
// NARUKAMI-launched sessions write ~/.narukami/godclaude/.claude while native
// `claude` sessions write ~/.claude. Reading only the native side froze the
// always-visible header meter at whatever the last NATIVE session left.

describe('readUsage merges the native and embedded homes (newest ts wins)', () => {
  let nativeDir: string;
  let godRoot: string;
  let godDir: string;
  const prevClaude = process.env.ARGUS_CLAUDE_DIR;
  const prevGod = process.env.NARUKAMI_GOD_HOME;

  const usage = (ts: number, pct: number): string =>
    JSON.stringify({ ts, rate_limits: { five_hour: { used_percentage: pct } } });

  beforeEach(() => {
    nativeDir = fs.mkdtempSync(path.join(os.tmpdir(), 'argus-native-'));
    godRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'argus-god-'));
    godDir = path.join(godRoot, '.claude'); // godClaudeDir() = godHome() + '/.claude'
    fs.mkdirSync(godDir, { recursive: true });
    process.env.ARGUS_CLAUDE_DIR = nativeDir;
    process.env.NARUKAMI_GOD_HOME = godRoot;
  });
  afterEach(() => {
    if (prevClaude === undefined) delete process.env.ARGUS_CLAUDE_DIR;
    else process.env.ARGUS_CLAUDE_DIR = prevClaude;
    if (prevGod === undefined) delete process.env.NARUKAMI_GOD_HOME;
    else process.env.NARUKAMI_GOD_HOME = prevGod;
    fs.rmSync(nativeDir, { recursive: true, force: true });
    fs.rmSync(godRoot, { recursive: true, force: true });
  });

  it('prefers the EMBEDDED file when it is newer (the live NARUKAMI bug)', async () => {
    fs.writeFileSync(path.join(nativeDir, 'usage-live.json'), usage(1_000, 2));
    fs.writeFileSync(path.join(godDir, 'usage-live.json'), usage(2_000, 22));
    const u = await readUsage();
    expect(u?.ts).toBe(2_000);
    expect(u?.rate_limits?.five_hour?.used_percentage).toBe(22);
  });

  it('prefers the NATIVE file when it is newer', async () => {
    fs.writeFileSync(path.join(nativeDir, 'usage-live.json'), usage(9_000, 7));
    fs.writeFileSync(path.join(godDir, 'usage-live.json'), usage(2_000, 22));
    const u = await readUsage();
    expect(u?.ts).toBe(9_000);
    expect(u?.rate_limits?.five_hour?.used_percentage).toBe(7);
  });

  it('falls back to the embedded file when the native one is missing', async () => {
    fs.writeFileSync(path.join(godDir, 'usage-live.json'), usage(2_000, 22));
    expect((await readUsage())?.ts).toBe(2_000);
  });

  it('falls back to the native file when the embedded one is missing', async () => {
    fs.writeFileSync(path.join(nativeDir, 'usage-live.json'), usage(1_000, 2));
    expect((await readUsage())?.ts).toBe(1_000);
  });

  it('never returns null just because ONE side is corrupt', async () => {
    fs.writeFileSync(path.join(nativeDir, 'usage-live.json'), '{ torn half-write');
    fs.writeFileSync(path.join(godDir, 'usage-live.json'), usage(2_000, 22));
    expect((await readUsage())?.ts).toBe(2_000);

    fs.writeFileSync(path.join(nativeDir, 'usage-live.json'), usage(1_000, 2));
    fs.writeFileSync(path.join(godDir, 'usage-live.json'), 'null'); // parses, but not an object
    expect((await readUsage())?.ts).toBe(1_000);
  });

  it('returns null only when neither side has a readable file', async () => {
    expect(await readUsage()).toBeNull();
  });

  it('still returns a file with no ts when it is the only readable one', async () => {
    fs.writeFileSync(path.join(godDir, 'usage-live.json'), JSON.stringify({ model: 'opus' }));
    expect((await readUsage())?.model).toBe('opus');
  });
});
