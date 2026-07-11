import { afterAll, describe, it, expect } from 'vitest';
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  isRecord,
  stripFences,
  extractJsonObject,
  toCommand,
  toStringArray,
  normalize,
  unwrapEnvelope,
  readPriorEods,
  saveEodHistory,
} from './analyzer';

describe('isRecord', () => {
  it('is true only for non-null objects', () => {
    expect(isRecord({})).toBe(true);
    expect(isRecord({ a: 1 })).toBe(true);
    expect(isRecord(null)).toBe(false);
    expect(isRecord(undefined)).toBe(false);
    expect(isRecord('x')).toBe(false);
    expect(isRecord(42)).toBe(false);
    // arrays are objects — typeof [] === 'object'
    expect(isRecord([])).toBe(true);
  });
});

describe('stripFences', () => {
  it('strips ```json fences', () => {
    expect(stripFences('```json\n{"a":1}\n```')).toBe('{"a":1}');
  });
  it('strips bare ``` fences', () => {
    expect(stripFences('```\n{"a":1}\n```')).toBe('{"a":1}');
  });
  it('returns trimmed text when unfenced', () => {
    expect(stripFences('  {"a":1}  ')).toBe('{"a":1}');
  });
});

describe('extractJsonObject', () => {
  it('returns a clean object unchanged', () => {
    expect(extractJsonObject('{"a":1}')).toBe('{"a":1}');
  });
  it('extracts the object from surrounding prose', () => {
    expect(extractJsonObject('here it is: {"a":1} thanks')).toBe('{"a":1}');
  });
  it('is not fooled by braces inside preceding prose (the bug this fixes)', () => {
    const input = 'Based on the Makefile targets {build, test}, here is: {"type":"node"}';
    expect(extractJsonObject(input)).toBe('{"type":"node"}');
  });
  it('is not fooled by braces inside string literals', () => {
    const input = '{"cmd":"echo {hi}","x":1}';
    expect(extractJsonObject(input)).toBe('{"cmd":"echo {hi}","x":1}');
  });
  it('handles nested objects', () => {
    const input = 'prose {"a":{"b":2},"c":3} more';
    expect(extractJsonObject(input)).toBe('{"a":{"b":2},"c":3}');
  });
  it('handles escaped quotes inside strings', () => {
    const input = '{"s":"a \\" }","n":1}';
    expect(extractJsonObject(input)).toBe('{"s":"a \\" }","n":1}');
  });
  it('skips multiple non-JSON brace groups to reach the real object', () => {
    const input = 'notes {a, b} and {c: d} then {"type":"node","packageManager":"npm"}';
    expect(extractJsonObject(input)).toBe('{"type":"node","packageManager":"npm"}');
  });
  it('falls back to the first balanced group when none parse (for a precise error)', () => {
    // No candidate is valid JSON — hand back the first balanced group so the
    // caller's JSON.parse reports where it broke, rather than swallowing it.
    expect(extractJsonObject('junk {build, test} more {x, y}')).toBe('{build, test}');
  });
  it('returns from the first brace when unbalanced', () => {
    expect(extractJsonObject('{"a":1')).toBe('{"a":1');
  });
  it('returns the input when there is no brace', () => {
    expect(extractJsonObject('no json here')).toBe('no json here');
  });
});

describe('unwrapEnvelope', () => {
  it('returns the result field of the claude -p envelope', () => {
    const env = JSON.stringify({ type: 'result', result: '{"a":1}' });
    expect(unwrapEnvelope(env)).toBe('{"a":1}');
  });
  it('returns raw stdout when result is missing', () => {
    expect(unwrapEnvelope('{"type":"result"}')).toBe('{"type":"result"}');
  });
  it('returns raw stdout when not JSON', () => {
    expect(unwrapEnvelope('plain text')).toBe('plain text');
  });
});

describe('toCommand', () => {
  it('builds a command from a valid object', () => {
    expect(toCommand({ label: 'dev', command: 'npm run dev', isDefault: true })).toEqual({
      label: 'dev',
      command: 'npm run dev',
      isDefault: true,
    });
  });
  it('defaults the label to "run"', () => {
    expect(toCommand({ command: 'ls' })).toEqual({ label: 'run', command: 'ls', isDefault: false });
  });
  it('rejects entries without a command', () => {
    expect(toCommand({ label: 'x' })).toBeNull();
    expect(toCommand({ command: '   ' })).toBeNull();
    expect(toCommand('nope')).toBeNull();
    expect(toCommand(null)).toBeNull();
  });
});

describe('toStringArray', () => {
  it('keeps only strings', () => {
    expect(toStringArray(['a', 1, 'b', null, {}])).toEqual(['a', 'b']);
  });
  it('returns [] for non-arrays', () => {
    expect(toStringArray('a')).toEqual([]);
    expect(toStringArray(undefined)).toEqual([]);
  });
});

describe('normalize', () => {
  it('normalizes a full result', () => {
    const out = normalize({
      type: 'node',
      packageManager: 'npm',
      installCommand: 'npm i',
      commands: [{ label: 'dev', command: 'npm run dev', isDefault: true }],
      envVarsNeeded: ['DATABASE_URL', 2],
      warnings: ['w'],
    });
    expect(out).toEqual({
      type: 'node',
      packageManager: 'npm',
      installCommand: 'npm i',
      commands: [{ label: 'dev', command: 'npm run dev', isDefault: true }],
      envVarsNeeded: ['DATABASE_URL'],
      warnings: ['w'],
    });
  });

  it('applies safe defaults for garbage input', () => {
    const out = normalize(null);
    expect(out.type).toBe('other');
    expect(out.packageManager).toBe('unknown');
    expect(out.installCommand).toBeNull();
    expect(out.commands).toEqual([]);
    expect(out.envVarsNeeded).toEqual([]);
    expect(out.warnings).toEqual([]);
  });

  it('coerces installCommand "null"/empty to null', () => {
    expect(normalize({ installCommand: '   ' }).installCommand).toBeNull();
  });

  it('forces exactly one default when none is marked', () => {
    const out = normalize({
      commands: [
        { label: 'a', command: 'x' },
        { label: 'b', command: 'y' },
      ],
    });
    expect(out.commands[0].isDefault).toBe(true);
    expect(out.commands[1].isDefault).toBe(false);
  });

  it('drops commands with no runnable command string', () => {
    const out = normalize({ commands: [{ label: 'a' }, { label: 'b', command: 'y' }] });
    expect(out.commands).toEqual([{ label: 'b', command: 'y', isDefault: true }]);
  });
});

describe('EOD history persistence', () => {
  const dirs: string[] = [];
  const tmp = async () => {
    const d = await mkdtemp(join(tmpdir(), 'narukami-eod-'));
    dirs.push(d);
    return d;
  };
  afterAll(async () => {
    for (const d of dirs) await rm(d, { recursive: true, force: true }).catch(() => {});
  });

  it('readPriorEods returns "" when there is no history dir', async () => {
    expect(await readPriorEods(join(tmpdir(), 'does-not-exist-narukami-xyz'), '2026-07-11')).toBe('');
  });

  it('readPriorEods returns the 3 newest prior days, newest first, excluding today', async () => {
    const dir = await tmp();
    for (const day of ['2026-07-06', '2026-07-07', '2026-07-08', '2026-07-09', '2026-07-11']) {
      await writeFile(join(dir, `${day}.md`), `report ${day}`, 'utf8');
    }
    const out = await readPriorEods(dir, '2026-07-11'); // today excluded
    // newest-first, capped at 3 → 09, 08, 07 (never 11, never 06)
    expect(out.indexOf('2026-07-09')).toBeGreaterThanOrEqual(0);
    expect(out.indexOf('2026-07-08')).toBeGreaterThan(out.indexOf('2026-07-09'));
    expect(out.indexOf('2026-07-07')).toBeGreaterThan(out.indexOf('2026-07-08'));
    expect(out).not.toContain('2026-07-06'); // pruned by the 3-day cap
    expect(out).not.toContain('report 2026-07-11'); // today's own file excluded
  });

  it('saveEodHistory writes today and prunes to the 3 newest days', async () => {
    const dir = await tmp();
    await mkdir(dir, { recursive: true });
    for (const day of ['2026-07-01', '2026-07-02', '2026-07-03']) {
      await writeFile(join(dir, `${day}.md`), `old ${day}`, 'utf8');
    }
    await saveEodHistory(dir, '2026-07-11', 'EOD - Test\n\nSummary\n\nAll good.');
    const files = (await readdir(dir)).filter((f) => f.endsWith('.md')).sort();
    expect(files).toEqual(['2026-07-02.md', '2026-07-03.md', '2026-07-11.md']); // oldest pruned
    const saved = await readFile(join(dir, '2026-07-11.md'), 'utf8');
    expect(saved).toContain('EOD - Test');
    expect(saved.endsWith('\n')).toBe(true); // trailing newline ensured
  });

  it('saveEodHistory overwrites the same day rather than stacking', async () => {
    const dir = await tmp();
    await saveEodHistory(dir, '2026-07-11', 'first');
    await saveEodHistory(dir, '2026-07-11', 'second');
    const files = (await readdir(dir)).filter((f) => f.endsWith('.md'));
    expect(files).toEqual(['2026-07-11.md']);
    expect(await readFile(join(dir, '2026-07-11.md'), 'utf8')).toContain('second');
  });
});
