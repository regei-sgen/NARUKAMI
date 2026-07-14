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
} from './runner';

const realPlatform = process.platform;
function setPlatform(p: NodeJS.Platform): void {
  Object.defineProperty(process, 'platform', { value: p, configurable: true });
}
afterEach(() => {
  Object.defineProperty(process, 'platform', { value: realPlatform, configurable: true });
});

describe('shellFor', () => {
  it('uses PowerShell -Command on Windows', () => {
    setPlatform('win32');
    expect(shellFor('npm run dev')).toEqual({
      file: 'powershell.exe',
      args: ['-NoLogo', '-NoProfile', '-Command', 'npm run dev'],
    });
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
  it('defaults to PowerShell (-NoLogo) on Windows', () => {
    setPlatform('win32');
    const spec = interactiveShell();
    expect(spec).not.toBeNull();
    // file is the resolved powershell path (or the bare name if PATH lookup missed).
    expect(spec!.file.toLowerCase()).toContain('powershell');
    expect(spec!.args).toEqual(['-NoLogo']);
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

describe('cleanEnv', () => {
  it('includes string env vars and never yields undefined values', () => {
    process.env.__NARUKAMI_TEST__ = 'hi';
    const env = cleanEnv();
    expect(env.__NARUKAMI_TEST__).toBe('hi');
    expect(Object.values(env).every((v) => typeof v === 'string')).toBe(true);
    delete process.env.__NARUKAMI_TEST__;
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
