import { afterEach, describe, expect, it } from 'vitest';
import {
  clearRunActivity,
  feedRunOutput,
  getRunActivity,
  parseAction,
  stripAnsi,
} from './runActivity';

afterEach(() => {
  clearRunActivity('t1');
});

describe('stripAnsi', () => {
  it('removes CSI color codes', () => {
    expect(stripAnsi('\x1b[31mred\x1b[0m')).toBe('red');
  });
  it('removes OSC title sequences', () => {
    expect(stripAnsi('\x1b]0;my title\x07done')).toBe('done');
  });
  it('keeps tabs and newlines but drops other control chars', () => {
    expect(stripAnsi('a\tb\nc\x00\x08d')).toBe('a\tb\ncd');
  });
});

describe('parseAction — Claude tool calls', () => {
  it('detects Edit → Editing', () => {
    const a = parseAction(['● Edit(packages/frontend/src/App.tsx)']);
    expect(a).toEqual({ kind: 'edit', verb: 'Editing', target: 'packages/frontend/src/App.tsx' });
  });
  it('detects Bash → Running', () => {
    const a = parseAction(['⏺ Bash(npm run build)']);
    expect(a).toMatchObject({ kind: 'run', verb: 'Running', target: 'npm run build' });
  });
  it('detects Read → Reading and strips a file_path: label + quotes', () => {
    const a = parseAction(['● Read(file_path: "src/index.ts")']);
    expect(a).toEqual({ kind: 'read', verb: 'Reading', target: 'src/index.ts' });
  });
  it('detects Grep → Searching', () => {
    expect(parseAction(['● Grep(pattern: "foo")'])).toMatchObject({ kind: 'search', verb: 'Searching' });
  });
  it('keeps a Windows drive-letter path intact (no "C:" label strip)', () => {
    expect(parseAction(['● Read(C:\\Users\\x\\file.ts)'])).toEqual({
      kind: 'read',
      verb: 'Reading',
      target: 'C:\\Users\\x\\file.ts',
    });
  });
  it('prefers the most recent action line', () => {
    const a = parseAction(['● Read(a.ts)', '● Edit(b.ts)']);
    expect(a).toMatchObject({ verb: 'Editing', target: 'b.ts' });
  });
});

describe('parseAction — shells', () => {
  it('detects a PowerShell prompt command', () => {
    const a = parseAction(['PS C:\\Users\\x> npm test']);
    expect(a).toMatchObject({ kind: 'run', verb: 'Running', target: 'npm test' });
  });
  it('detects a bare dev command line', () => {
    expect(parseAction(['vite build --mode production'])).toMatchObject({ verb: 'Running' });
  });
  it('does NOT treat a markdown heading as a command', () => {
    expect(parseAction(['# Installing dependencies'])).toMatchObject({ kind: 'output' });
  });
  it('does NOT treat a quote line as a command', () => {
    expect(parseAction(['> just some quoted text'])).toMatchObject({ kind: 'output' });
  });
});

describe('parseAction — thinking + fallback', () => {
  it('detects a thinking/spinner line', () => {
    expect(parseAction(['✻ Thinking… (esc to interrupt)'])).toMatchObject({ kind: 'think', verb: 'Thinking' });
  });
  it('falls back to the latest non-spinner output line', () => {
    expect(parseAction(['building modules', '⠋'])).toMatchObject({ kind: 'output', target: 'building modules' });
  });
  it('returns null for no meaningful lines', () => {
    expect(parseAction([])).toBeNull();
  });
});

describe('feedRunOutput', () => {
  it('accumulates, strips ANSI, and parses the latest action', () => {
    feedRunOutput('t1', '\x1b[32m● Read(a.ts)\x1b[0m\r\n');
    feedRunOutput('t1', '● Edit(src/App.tsx)\r\n');
    const act = getRunActivity('t1');
    expect(act?.action).toMatchObject({ verb: 'Editing', target: 'src/App.tsx' });
    expect(act?.tail[act.tail.length - 1]).toContain('Edit(src/App.tsx)');
    expect(act?.bytes).toBeGreaterThan(0);
  });
  it('collapses repeated spinner frames in the tail', () => {
    feedRunOutput('t1', 'compiling\n⠋\n⠋\n⠋\n');
    const tail = getRunActivity('t1')?.tail ?? [];
    expect(tail.filter((l) => l === '⠋').length).toBe(1);
  });
  it('builds an action trail and a files-touched list', () => {
    feedRunOutput('t1', '● Read(src/a.ts)\n');
    feedRunOutput('t1', '● Edit(src/a.ts)\n');
    feedRunOutput('t1', '● Bash(npm test)\n');
    const act = getRunActivity('t1');
    // trail records distinct transitions, most recent last
    expect(act?.actions.map((a) => a.verb)).toEqual(['Reading', 'Editing', 'Running']);
    // files dedupe by path (Read then Edit of a.ts = one entry, latest kind)
    expect(act?.files).toEqual([{ path: 'src/a.ts', kind: 'edit' }]);
  });
  it('counts output lines and stamps a start time', () => {
    feedRunOutput('t1', 'one\ntwo\nthree\n');
    const act = getRunActivity('t1');
    expect(act?.lines).toBe(3);
    expect(act?.startedTs).toBeGreaterThan(0);
  });
  it('reassembles an ANSI escape split across two chunks (no leaked codes)', () => {
    feedRunOutput('t1', 'hi \x1b[');
    feedRunOutput('t1', '31mRED\x1b[0m\n');
    const tail = (getRunActivity('t1')?.tail ?? []).join('\n');
    expect(tail).toContain('hi RED');
    expect(tail).not.toContain('[31m');
  });
});
