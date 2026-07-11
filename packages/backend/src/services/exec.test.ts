import { describe, it, expect, afterEach } from 'vitest';
import fs from 'node:fs';
import { resolveExecutable, wrapForWindows } from './exec';

const realPlatform = process.platform;
function setPlatform(p: NodeJS.Platform): void {
  Object.defineProperty(process, 'platform', { value: p, configurable: true });
}
afterEach(() => {
  Object.defineProperty(process, 'platform', { value: realPlatform, configurable: true });
});

describe('resolveExecutable', () => {
  it('resolves a real executable on PATH to an existing absolute path', () => {
    const resolved = resolveExecutable('node');
    expect(resolved).not.toBe('node');
    expect(fs.existsSync(resolved)).toBe(true);
  });
  it('returns the bare name when not found', () => {
    expect(resolveExecutable('definitely-not-a-real-exe-zzz-999')).toBe(
      'definitely-not-a-real-exe-zzz-999',
    );
  });
});

describe('wrapForWindows', () => {
  it('routes a .cmd/.bat shim through cmd.exe on Windows', () => {
    setPlatform('win32');
    const w = wrapForWindows('C:\\tools\\claude.cmd', ['-p', 'hi']);
    expect(w.file.toLowerCase()).toContain('cmd');
    expect(w.args).toEqual(['/c', 'C:\\tools\\claude.cmd', '-p', 'hi']);

    const bat = wrapForWindows('C:\\tools\\thing.bat', ['x']);
    expect(bat.args).toEqual(['/c', 'C:\\tools\\thing.bat', 'x']);
  });

  it('leaves a real .exe unchanged on Windows', () => {
    setPlatform('win32');
    expect(wrapForWindows('C:\\tools\\claude.exe', ['-p'])).toEqual({
      file: 'C:\\tools\\claude.exe',
      args: ['-p'],
    });
  });

  it('is a no-op on POSIX', () => {
    setPlatform('linux');
    expect(wrapForWindows('/usr/local/bin/claude', ['-p', 'hi'])).toEqual({
      file: '/usr/local/bin/claude',
      args: ['-p', 'hi'],
    });
  });
});
