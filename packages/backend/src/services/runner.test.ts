import { describe, it, expect, afterEach } from 'vitest';
import fs from 'node:fs';
import {
  shellFor,
  interactiveShell,
  resolveExecutable,
  cleanEnv,
  capTranscript,
  stripAnsi,
  looksLikeTrustPrompt,
  buildClaudeArgs,
} from './runner';

const realPlatform = process.platform;
function setPlatform(p: NodeJS.Platform): void {
  Object.defineProperty(process, 'platform', { value: p, configurable: true });
}
afterEach(() => {
  Object.defineProperty(process, 'platform', { value: realPlatform, configurable: true });
});

describe('shellFor', () => {
  it('uses a PowerShell -Command invocation on Windows (pwsh 7+ when available)', () => {
    setPlatform('win32');
    const r = shellFor('npm run dev');
    // Args are always the -Command form; the file is pwsh (if PATH-resolvable) so
    // `&&`/`||` chaining works, otherwise Windows PowerShell 5.1.
    expect(r.args).toEqual(['-NoLogo', '-NoProfile', '-Command', 'npm run dev']);
    expect(r.file).toMatch(/pwsh(\.exe)?$|powershell\.exe$/i);
  });
  it("runs in cmd.exe when shell='cmd' on Windows (verbatim string, not argv)", () => {
    setPlatform('win32');
    // A string bypasses node-pty's argv join, whose CRT quote-escaping (\")
    // cmd.exe cannot parse — an array here corrupts quoted commands.
    expect(shellFor('npm run dev', 'cmd')).toEqual({
      file: 'cmd.exe',
      args: '/d /s /c "npm run dev"',
    });
    // Inner quotes must survive verbatim (/s strips only the outer pair).
    expect(shellFor('echo "a b"', 'cmd').args).toBe('/d /s /c "echo "a b""');
  });
  it("ignores shell='cmd' on POSIX (no cmd.exe there)", () => {
    setPlatform('linux');
    const prev = process.env.SHELL;
    process.env.SHELL = '/bin/zsh';
    expect(shellFor('ls', 'cmd').file).toBe('/bin/zsh');
    if (prev === undefined) delete process.env.SHELL;
    else process.env.SHELL = prev;
  });
  it('uses $SHELL -lc on POSIX', () => {
    setPlatform('linux');
    const prev = process.env.SHELL;
    process.env.SHELL = '/bin/zsh';
    expect(shellFor('ls -la')).toEqual({ file: '/bin/zsh', args: ['-lc', 'ls -la'] });
    if (prev === undefined) delete process.env.SHELL;
    else process.env.SHELL = prev;
  });
  it('falls back to bash when SHELL is unset on POSIX', () => {
    setPlatform('linux');
    const prev = process.env.SHELL;
    delete process.env.SHELL;
    expect(shellFor('ls').file).toBe('bash');
    if (prev !== undefined) process.env.SHELL = prev;
  });
});

describe('interactiveShell', () => {
  it('is a bare PowerShell on Windows', () => {
    setPlatform('win32');
    expect(interactiveShell()).toEqual({ file: 'powershell.exe', args: ['-NoLogo'] });
  });
  it("is a bare cmd.exe when shell='cmd' on Windows", () => {
    setPlatform('win32');
    expect(interactiveShell('cmd')).toEqual({ file: 'cmd.exe', args: [] });
  });
  it('is an interactive $SHELL on POSIX', () => {
    setPlatform('linux');
    process.env.SHELL = '/bin/bash';
    expect(interactiveShell()).toEqual({ file: '/bin/bash', args: ['-i'] });
  });
});

describe('resolveExecutable', () => {
  it('resolves a real executable on PATH to an existing absolute path', () => {
    const resolved = resolveExecutable('node');
    expect(resolved).not.toBe('node');
    expect(fs.existsSync(resolved)).toBe(true);
  });
  it('returns the bare name when not found', () => {
    expect(resolveExecutable('definitely-not-a-real-exe-xyz-123')).toBe(
      'definitely-not-a-real-exe-xyz-123',
    );
  });
});

describe('buildClaudeArgs', () => {
  const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

  it('mints a fresh --session-id for a new session (never --continue)', () => {
    const { rawArgs, sessionId } = buildClaudeArgs({
      mcpArgs: ['--mcp-config', 'x.json'],
      newId: () => 'fixed-id',
    });
    expect(sessionId).toBe('fixed-id');
    expect(rawArgs).toEqual(['--session-id', 'fixed-id', '--mcp-config', 'x.json']);
    expect(rawArgs).not.toContain('--continue');
    expect(rawArgs).not.toContain('--resume');
  });

  it('resumes by explicit id with --resume (never --continue or --session-id)', () => {
    const newId = () => {
      throw new Error('newId must NOT be called when resuming');
    };
    const { rawArgs, sessionId } = buildClaudeArgs({
      mcpArgs: [],
      resumeSessionId: 'abc-123',
      newId,
    });
    expect(sessionId).toBe('abc-123');
    expect(rawArgs).toEqual(['--resume', 'abc-123']);
    expect(rawArgs).not.toContain('--continue');
    expect(rawArgs).not.toContain('--session-id');
  });

  it('appends mcpArgs AFTER the id args', () => {
    const { rawArgs } = buildClaudeArgs({
      mcpArgs: ['--mcp-config', '/tmp/run.json'],
      resumeSessionId: 'sid',
    });
    expect(rawArgs).toEqual(['--resume', 'sid', '--mcp-config', '/tmp/run.json']);
  });

  it('defaults to a real UUID and gives each fresh session a distinct id', () => {
    const a = buildClaudeArgs({ mcpArgs: [] });
    const b = buildClaudeArgs({ mcpArgs: [] });
    expect(a.sessionId).toMatch(UUID_RE);
    expect(b.sessionId).toMatch(UUID_RE);
    expect(a.sessionId).not.toBe(b.sessionId); // separate sessions → separate ids
    expect(a.rawArgs[0]).toBe('--session-id');
  });
});

describe('cleanEnv', () => {
  it('includes string env vars and never yields undefined values', () => {
    process.env.__NARUKAMI_TEST__ = 'hi';
    const env = cleanEnv();
    expect(env.__NARUKAMI_TEST__).toBe('hi');
    expect(Object.values(env).every((v) => typeof v === 'string')).toBe(true);
    delete process.env.__NARUKAMI_TEST__;
  });

  it('strips NARUKAMI-internal / secret-bearing vars from the spawned child env', () => {
    const added = {
      DATABASE_URL: 'file:./dev.db',
      RUNNER_TOKEN_FILE: '/tmp/.runner-token',
      PORT: '4000',
      NARUKAMI_TOKEN: 'super-secret',
      NARUKAMI_BASE_URL: 'http://127.0.0.1:4000',
      PRISMA_QUERY_ENGINE_LIBRARY: '/x/engine.node',
      ORDINARY_VAR_XYZ: 'keepme',
    };
    Object.assign(process.env, added);
    try {
      const env = cleanEnv();
      // Secrets / internal wiring must NOT leak into untrusted project commands.
      expect(env.DATABASE_URL).toBeUndefined();
      expect(env.RUNNER_TOKEN_FILE).toBeUndefined();
      expect(env.PORT).toBeUndefined();
      expect(env.NARUKAMI_TOKEN).toBeUndefined();
      expect(env.NARUKAMI_BASE_URL).toBeUndefined();
      expect(env.PRISMA_QUERY_ENGINE_LIBRARY).toBeUndefined();
      // ...but ordinary vars still pass through.
      expect(env.ORDINARY_VAR_XYZ).toBe('keepme');
    } finally {
      for (const k of Object.keys(added)) delete process.env[k];
    }
  });
});

describe('capTranscript', () => {
  it('appends within the cap', () => {
    const t: string[] = [];
    const total = capTranscript(t, 0, 'abc', 100);
    expect(total).toBe(3);
    expect(t).toEqual(['abc']);
  });
  it('drops oldest chunks when over the cap', () => {
    const t = ['aaaa', 'bbbb'];
    const total = capTranscript(t, 8, 'cccc', 10);
    expect(total).toBe(8);
    expect(t).toEqual(['bbbb', 'cccc']);
  });
  it('always keeps at least one chunk even if it exceeds the cap', () => {
    const t = ['x'.repeat(20)];
    const total = capTranscript(t, 20, 'y'.repeat(20), 10);
    expect(t).toHaveLength(1);
    expect(t[0]).toBe('y'.repeat(20));
    expect(total).toBe(20);
  });
});

describe('stripAnsi', () => {
  it('removes SGR color codes', () => {
    expect(stripAnsi('\x1b[31mred\x1b[0m')).toBe('red');
  });
  it('removes private-mode sequences', () => {
    expect(stripAnsi('\x1b[?1049lhi')).toBe('hi');
  });
  it('removes OSC sequences', () => {
    expect(stripAnsi('\x1b]0;title\x07rest')).toBe('rest');
  });
});

describe('looksLikeTrustPrompt', () => {
  it('detects the folder-trust prompt', () => {
    expect(looksLikeTrustPrompt('Do you trust the files in this folder?')).toBe(true);
    expect(looksLikeTrustPrompt('\x1b[1mDo you trust\x1b[0m the files')).toBe(true);
    expect(looksLikeTrustPrompt('...trust this folder...')).toBe(true);
  });
  it('does not fire on normal output', () => {
    expect(looksLikeTrustPrompt('Welcome back Regei!')).toBe(false);
    expect(looksLikeTrustPrompt('')).toBe(false);
  });
});
