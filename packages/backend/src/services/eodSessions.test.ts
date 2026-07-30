import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

let tmp: string;

vi.mock('./argus', () => ({
  claudeDir: () => tmp,
  decodeProjectDir: (d: string) => d.replace(/^C--/, 'C:/').replace(/-/g, '/'),
}));

import {
  collectSessionsForRange,
  isSubstantiveSession,
  readSessionTranscript,
  sessionSubstance,
  sessionToPromptText,
} from './eodSessions';

const DAY = new Date(2026, 6, 29, 0, 0, 0);
const NEXT = new Date(2026, 6, 30, 0, 0, 0);
/** An ISO timestamp inside the test day (local → UTC safe: midday). */
const at = (h: number, m = 0): string => new Date(2026, 6, 29, h, m, 0).toISOString();

function line(o: unknown): string {
  return `${JSON.stringify(o)}\n`;
}

function userLine(text: string, ts: string): string {
  return line({ type: 'user', sessionId: 'sess-1', cwd: 'C:\\proj', timestamp: ts, message: { content: text } });
}

function assistantLine(text: string, ts: string, tool?: { name: string; file?: string }): string {
  const content: unknown[] = [{ type: 'text', text }];
  if (tool) {
    content.push({ type: 'tool_use', name: tool.name, input: tool.file ? { file_path: tool.file } : {} });
  }
  return line({ type: 'assistant', sessionId: 'sess-1', cwd: 'C:\\proj', timestamp: ts, message: { content } });
}

beforeEach(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'nk-eodsessions-'));
  fs.mkdirSync(path.join(tmp, 'projects', 'C--proj'), { recursive: true });
});
afterEach(() => {
  fs.rmSync(tmp, { recursive: true, force: true });
});

/** Write a transcript whose decisive content sits PAST the first megabyte. */
function writeHugeTranscript(file: string): void {
  const parts: string[] = [
    line({ type: 'ai-title', sessionId: 'sess-1', aiTitle: 'Rework the EOD report pipeline' }),
    userLine('Kick off the morning work on the report generator', at(9)),
  ];
  // Padding: assistant chatter until the file is comfortably over 1 MiB, which
  // is exactly where the old reader stopped looking.
  let bytes = parts.join('').length;
  let i = 0;
  while (bytes < 1_400_000) {
    const l = assistantLine(`padding turn ${i} — routine progress narration ${'x'.repeat(400)}`, at(10));
    parts.push(l);
    bytes += l.length;
    i += 1;
  }
  // The decisive end-of-day material, beyond the old 1 MiB horizon.
  parts.push(userLine('LATE_TASK: fix the mobile scrollback dead zone', at(17)));
  parts.push(assistantLine('Forwarded wheel/touch into scrollLines', at(17, 30), { name: 'Edit', file: 'C:/proj/MobileTerminal.tsx' }));
  parts.push(line({ type: 'system', subtype: 'turn_duration', durationMs: 120000, timestamp: at(17, 31) }));
  fs.writeFileSync(file, parts.join(''));
}

describe('readSessionTranscript', () => {
  it('reads PAST the first megabyte — the old 1 MiB cap hid the end of the day', async () => {
    const file = path.join(tmp, 'projects', 'C--proj', 'sess-1.jsonl');
    writeHugeTranscript(file);
    expect(fs.statSync(file).size).toBeGreaterThan(1024 * 1024);

    const rec = await readSessionTranscript(file, DAY, NEXT);
    expect(rec).not.toBeNull();
    const joined = rec!.userPrompts.join(' ');
    // The morning prompt AND the late-afternoon one both survive.
    expect(joined).toContain('Kick off the morning work');
    expect(joined).toContain('LATE_TASK: fix the mobile scrollback dead zone');
    expect(rec!.truncated).toBe(true); // padding was dropped, and it says so
  });

  it('captures the session identity, tools, files and active time', async () => {
    const file = path.join(tmp, 'projects', 'C--proj', 'sess-1.jsonl');
    writeHugeTranscript(file);
    const rec = (await readSessionTranscript(file, DAY, NEXT))!;

    expect(rec.title).toBe('Rework the EOD report pipeline');
    expect(rec.cwd).toBe('C:\\proj');
    expect(rec.files).toContain('C:/proj/MobileTerminal.tsx');
    expect(rec.tools.find((t) => t.name === 'Edit')?.count).toBe(1);
    expect(rec.activeMs).toBe(120000);
    expect(rec.startedAt).toBeTruthy();
    expect(rec.endedAt).toBeTruthy();
  });

  it('windows entries by timestamp, so a session is not credited to the wrong day', async () => {
    const file = path.join(tmp, 'projects', 'C--proj', 'sess-2.jsonl');
    fs.writeFileSync(
      file,
      userLine('yesterday work', new Date(2026, 6, 28, 10).toISOString()) +
        userLine('today work on the report', at(11)),
    );
    const rec = (await readSessionTranscript(file, DAY, NEXT))!;
    const joined = rec.userPrompts.join(' ');
    expect(joined).toContain('today work on the report');
    expect(joined).not.toContain('yesterday work');
  });

  it('returns null when nothing falls inside the window', async () => {
    const file = path.join(tmp, 'projects', 'C--proj', 'sess-3.jsonl');
    fs.writeFileSync(file, userLine('old work', new Date(2026, 6, 20, 10).toISOString()));
    expect(await readSessionTranscript(file, DAY, NEXT)).toBeNull();
  });

  it('skips tool-result noise, slash commands and injected blocks', async () => {
    const file = path.join(tmp, 'projects', 'C--proj', 'sess-4.jsonl');
    fs.writeFileSync(
      file,
      userLine('/effort ultracode', at(9)) +
        userLine('<system-reminder>injected</system-reminder>', at(9, 1)) +
        userLine('a genuine instruction about the report', at(9, 2)),
    );
    const rec = (await readSessionTranscript(file, DAY, NEXT))!;
    expect(rec.userPrompts).toEqual(['a genuine instruction about the report']);
  });

  it('survives a truncated final line (a live session being written)', async () => {
    const file = path.join(tmp, 'projects', 'C--proj', 'sess-5.jsonl');
    fs.writeFileSync(file, userLine('real instruction here', at(12)) + '{"type":"assist');
    const rec = (await readSessionTranscript(file, DAY, NEXT))!;
    expect(rec.userPrompts).toContain('real instruction here');
  });
});

describe('collectSessionsForRange', () => {
  it('returns ONE record per session, grouped by cwd and ordered chronologically', async () => {
    const dir = path.join(tmp, 'projects', 'C--proj');
    fs.writeFileSync(path.join(dir, 'later.jsonl'), userLine('afternoon task', at(15)));
    fs.writeFileSync(path.join(dir, 'earlier.jsonl'), userLine('morning task', at(8)));

    const byPath = await collectSessionsForRange(DAY, NEXT);
    const list = byPath.get('c:/proj');
    expect(list).toBeDefined();
    expect(list!).toHaveLength(2); // per SESSION, not merged into one blob
    expect(list![0].userPrompts[0]).toContain('morning task');
    expect(list![1].userPrompts[0]).toContain('afternoon task');
  });
});

describe('sessionToPromptText', () => {
  it('renders both sides of the conversation plus the tool/file evidence', async () => {
    const file = path.join(tmp, 'projects', 'C--proj', 'sess-1.jsonl');
    writeHugeTranscript(file);
    const text = sessionToPromptText((await readSessionTranscript(file, DAY, NEXT))!);

    expect(text).toContain('Rework the EOD report pipeline');
    expect(text).toContain("The developer's messages, in order:");
    expect(text).toContain('What the assistant said it was doing:');
    expect(text).toContain('Edit×1');
    expect(text).toContain('C:/proj/MobileTerminal.tsx');
    expect(text).toContain('the middle was dropped'); // truncation is disclosed
  });
});

describe('isSubstantiveSession / sessionSubstance', () => {
  /** Shape of the one-shot stubs that headless `claude -p` calls leave behind —
   *  including the digests this very report makes. Measured on a real day. */
  const stub = {
    userPrompts: ['summarize this session'],
    tools: [{ name: 'Read', count: 1 }],
    files: [],
    activeMs: 0,
  } as unknown as import('./eodSessions').SessionRecord;

  /** The smallest session on that day that was genuinely real work. */
  const realWork = {
    userPrompts: ['add the postgres UI', 'use a container instead'],
    tools: [{ name: 'Bash', count: 40 }, { name: 'Edit', count: 16 }],
    files: new Array(13).fill('f.ts'),
    activeMs: 13 * 60_000,
  } as unknown as import('./eodSessions').SessionRecord;

  it('rejects the one-shot stubs that would otherwise crowd out real work', () => {
    expect(isSubstantiveSession(stub)).toBe(false);
  });

  it('keeps genuine work, including a short session that still touched files', () => {
    expect(isSubstantiveSession(realWork)).toBe(true);
  });

  it('ranks real work far above a stub, so the digest budget goes to the work', () => {
    expect(sessionSubstance(realWork)).toBeGreaterThan(sessionSubstance(stub) * 10);
  });
});
