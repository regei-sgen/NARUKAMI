import { describe, it, expect, vi } from 'vitest';

// Capture the options `claude -p` is spawned with (analyzer promisifies execFile
// at module load, so the mock must be in place before ./analyzer is imported).
const spawn = vi.hoisted(() => ({
  env: undefined as NodeJS.ProcessEnv | undefined,
  stdout: '',
}));
vi.mock('node:child_process', () => ({
  execFile: (
    _file: string,
    _args: string[],
    options: { env?: NodeJS.ProcessEnv },
    cb: (err: null, out: { stdout: string; stderr: string }) => void,
  ) => {
    spawn.env = options.env;
    cb(null, { stdout: spawn.stdout, stderr: '' });
  },
}));

import {
  isRecord,
  stripFences,
  extractJsonObject,
  toCommand,
  toStringArray,
  normalize,
  unwrapEnvelope,
  analyzeProject,
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

describe('runClaude env', () => {
  it('spawns claude -p with cleanEnv, not a raw process.env', async () => {
    // A headless `claude -p` is a spawned (untrusted) session like any other —
    // it must not inherit the backend's secrets/internal wiring.
    const added = {
      DATABASE_URL: 'file:./dev.db',
      RUNNER_TOKEN_FILE: '/tmp/.runner-token',
      PORT: '4000',
      CLAUDE_CODE_SESSION_ID: 'outer-session',
      NARUKAMI_TOKEN: 'super-secret',
      PRISMA_QUERY_ENGINE_LIBRARY: '/x/engine.node',
      ORDINARY_VAR_XYZ: 'keepme',
    };
    Object.assign(process.env, added);
    spawn.env = undefined;
    spawn.stdout = JSON.stringify({ type: 'result', result: '{"type":"node"}' });
    try {
      await analyzeProject('/tmp/project');
      const env: NodeJS.ProcessEnv = spawn.env ?? {};
      expect(env.DATABASE_URL).toBeUndefined();
      expect(env.RUNNER_TOKEN_FILE).toBeUndefined();
      expect(env.PORT).toBeUndefined();
      expect(env.CLAUDE_CODE_SESSION_ID).toBeUndefined();
      expect(env.NARUKAMI_TOKEN).toBeUndefined();
      expect(env.PRISMA_QUERY_ENGINE_LIBRARY).toBeUndefined();
      // ...but ordinary vars still reach the child.
      expect(env.ORDINARY_VAR_XYZ).toBe('keepme');
    } finally {
      for (const k of Object.keys(added)) delete process.env[k];
    }
  });
});
