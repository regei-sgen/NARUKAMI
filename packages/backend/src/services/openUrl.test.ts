import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const h = vi.hoisted(() => ({ spawn: vi.fn() }));
vi.mock('node:child_process', () => ({ spawn: h.spawn }));

import { openInBrowser, validateDevUrl } from './openUrl';

const realPlatform = process.platform;
function setPlatform(p: NodeJS.Platform): void {
  Object.defineProperty(process, 'platform', { value: p, configurable: true });
}

describe('validateDevUrl', () => {
  it('accepts loopback http(s) URLs', () => {
    expect(validateDevUrl('http://localhost:5173/')).toBe('http://localhost:5173/');
    expect(validateDevUrl('http://127.0.0.1:4000/app')).toBe('http://127.0.0.1:4000/app');
    expect(validateDevUrl('https://localhost:8443/')).toBe('https://localhost:8443/');
    expect(validateDevUrl('http://[::1]:3000/')).toBe('http://[::1]:3000/');
  });

  it('normalizes 0.0.0.0 to localhost', () => {
    expect(validateDevUrl('http://0.0.0.0:8080/')).toBe('http://localhost:8080/');
  });

  it('rejects external hosts', () => {
    expect(validateDevUrl('https://evil.example.com/')).toBeNull();
    expect(validateDevUrl('http://192.168.1.10:3000/')).toBeNull();
    expect(validateDevUrl('http://localhost.evil.com/')).toBeNull();
  });

  it('rejects non-http schemes and credentials', () => {
    expect(validateDevUrl('file:///C:/Windows/system32')).toBeNull();
    expect(validateDevUrl('javascript:alert(1)')).toBeNull();
    expect(validateDevUrl('http://user:pass@localhost:3000/')).toBeNull();
  });

  it('rejects garbage', () => {
    expect(validateDevUrl('not a url')).toBeNull();
    expect(validateDevUrl(42)).toBeNull();
    expect(validateDevUrl('http://localhost:5173/'.padEnd(3000, 'x'))).toBeNull();
  });
});

describe('openInBrowser', () => {
  beforeEach(() => {
    h.spawn.mockReset();
    h.spawn.mockReturnValue({ unref: () => {} });
  });
  afterEach(() => {
    Object.defineProperty(process, 'platform', { value: realPlatform, configurable: true });
  });

  /** The (file, args) handed to child_process.spawn on the most recent call. */
  function lastLaunch(): { file: string; args: string[] } {
    const call = h.spawn.mock.calls.at(-1) as [string, string[]] | undefined;
    if (!call) throw new Error('spawn was never called');
    return { file: call[0], args: call[1] };
  }

  // validateDevUrl round-trips `&` on purpose (multi-param query strings are
  // legitimate dev-server URLs), so the launcher — not the validator — has to be
  // the thing that can't be talked into running a second command. cmd.exe treats
  // `&` as a statement separator and libuv only quotes argv elements containing
  // a space/tab/quote, so a bare `&` in the URL used to split the command line.
  it('never routes a URL through a command interpreter on Windows', () => {
    setPlatform('win32');
    const url = validateDevUrl('http://localhost:3000/?x=1&C:\\tmp\\pwn.bat');
    expect(url).toBe('http://localhost:3000/?x=1&C:\\tmp\\pwn.bat');
    openInBrowser(url as string);

    const { file, args } = lastLaunch();
    const launcher = file.toLowerCase();
    for (const shell of ['cmd.exe', 'cmd', 'powershell', 'pwsh', 'sh', 'bash']) {
      expect(launcher.replace(/^.*[\\/]/, '')).not.toBe(shell);
    }
    // The URL survives as exactly ONE argv element, byte-for-byte: nothing after
    // the `&` can become a command, and nothing before it is mangled.
    expect(args.filter((a) => a.includes('pwn.bat'))).toEqual([url]);
  });

  it('preserves a legitimate multi-param query string verbatim', () => {
    setPlatform('win32');
    const url = validateDevUrl('http://localhost:5173/?a=1&b=2&c=3') as string;
    openInBrowser(url);
    expect(lastLaunch().args).toContain('http://localhost:5173/?a=1&b=2&c=3');
  });

  it('still uses open/xdg-open off Windows', () => {
    setPlatform('darwin');
    openInBrowser('http://localhost:5173/');
    expect(lastLaunch()).toEqual({ file: 'open', args: ['http://localhost:5173/'] });

    setPlatform('linux');
    openInBrowser('http://localhost:5173/');
    expect(lastLaunch()).toEqual({ file: 'xdg-open', args: ['http://localhost:5173/'] });
  });
});
