import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { claudeSessionActivity, collectSessionContext, normPath, prettyName } from './eodActivity';

describe('normPath', () => {
  it('lowercases, forward-slashes, and trims a trailing slash', () => {
    expect(normPath('C:\\Users\\X\\Proj\\')).toBe('c:/users/x/proj');
    expect(normPath('C:/Users/x/proj')).toBe('c:/users/x/proj');
  });
});

describe('prettyName', () => {
  it('is the last path segment', () => {
    expect(prettyName('C:/Users/lloyd/lumen-assets')).toBe('lumen-assets');
    expect(prettyName('C:\\Users\\lloyd\\dashboard.sgen.com')).toBe('dashboard.sgen.com');
  });
});

describe('claudeSessionActivity over a fixture ~/.claude/projects', () => {
  let dir: string;
  const prev = process.env.ARGUS_CLAUDE_DIR;
  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'eodact-'));
    process.env.ARGUS_CLAUDE_DIR = dir;
  });
  afterEach(() => {
    if (prev === undefined) delete process.env.ARGUS_CLAUDE_DIR;
    else process.env.ARGUS_CLAUDE_DIR = prev;
    fs.rmSync(dir, { recursive: true, force: true });
  });

  function writeTranscript(encoded: string, file: string, cwd: string, mtime: Date): void {
    const p = path.join(dir, 'projects', encoded);
    fs.mkdirSync(p, { recursive: true });
    const f = path.join(p, file);
    fs.writeFileSync(f, JSON.stringify({ cwd, type: 'user' }) + '\n' + JSON.stringify({ type: 'assistant' }) + '\n');
    fs.utimesSync(f, mtime, mtime);
  }

  it('detects a transcript touched within the day and resolves its real cwd (native or NARUKAMI)', () => {
    writeTranscript('C--Users-x-lumen-assets', 'sess-1.jsonl', 'C:\\Users\\x\\lumen-assets', new Date(2026, 6, 6, 12, 0, 0));
    const m = claudeSessionActivity(new Date(2026, 6, 6, 0, 0, 0), new Date(2026, 6, 7, 0, 0, 0));
    expect(m.get('c:/users/x/lumen-assets')).toEqual({ cwd: 'C:\\Users\\x\\lumen-assets', count: 1 });
  });

  it('resolves the real cwd when the FIRST transcript line has no cwd (avoids lossy name mis-split)', () => {
    const p = path.join(dir, 'projects', 'C--Users-x-dashboard-sgen-com');
    fs.mkdirSync(p, { recursive: true });
    const f = path.join(p, 's.jsonl');
    // first line: a summary with no cwd; the real cwd is on a later entry
    fs.writeFileSync(
      f,
      JSON.stringify({ type: 'summary', summary: 'x' }) + '\n' + JSON.stringify({ cwd: 'C:/Users/x/dashboard.sgen.com', type: 'user' }) + '\n',
    );
    const t = new Date(2026, 6, 6, 9, 0, 0);
    fs.utimesSync(f, t, t);
    const m = claudeSessionActivity(new Date(2026, 6, 6, 0, 0, 0), new Date(2026, 6, 7, 0, 0, 0));
    // must be the full name, NOT the mis-decoded 'com'
    expect(m.get('c:/users/x/dashboard.sgen.com')).toEqual({ cwd: 'C:/Users/x/dashboard.sgen.com', count: 1 });
  });

  it('ignores transcripts whose mtime is outside the day window', () => {
    writeTranscript('C--Users-x-old', 's.jsonl', 'C:/Users/x/old', new Date(2026, 6, 5, 10, 0, 0)); // day before
    const m = claudeSessionActivity(new Date(2026, 6, 6, 0, 0, 0), new Date(2026, 6, 7, 0, 0, 0));
    expect(m.size).toBe(0);
  });

  it('extracts the developer prompts as session context (skips tool-results + slash commands)', () => {
    const p = path.join(dir, 'projects', 'C--Users-x-proj');
    fs.mkdirSync(p, { recursive: true });
    const f = path.join(p, 's.jsonl');
    fs.writeFileSync(
      f,
      [
        JSON.stringify({ type: 'summary', summary: 't' }),
        JSON.stringify({ type: 'user', cwd: 'C:/Users/x/proj', message: { role: 'user', content: 'Add a login page with sessions' } }),
        JSON.stringify({ type: 'assistant', message: { content: 'ok' } }),
        JSON.stringify({ type: 'user', message: { content: [{ type: 'tool_result', content: 'x' }] } }), // no text → skipped
        JSON.stringify({ type: 'user', message: { content: '/effort ultracode' } }), // slash command → skipped
        JSON.stringify({ type: 'user', message: { content: 'Fix the timezone bug in reports' } }),
      ].join('\n') + '\n',
    );
    const t = new Date(2026, 6, 6, 10, 0, 0);
    fs.utimesSync(f, t, t);
    const ctx = collectSessionContext(new Date(2026, 6, 6, 0, 0, 0), new Date(2026, 6, 7, 0, 0, 0)).get('c:/users/x/proj');
    expect(ctx).toContain('Add a login page with sessions');
    expect(ctx).toContain('Fix the timezone bug in reports');
    expect(ctx).not.toContain('/effort'); // slash command filtered
    expect(ctx).not.toContain('tool_result'); // tool result filtered
  });
});
