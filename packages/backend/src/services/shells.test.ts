import { describe, expect, it } from 'vitest';
import {
  gitBashFromGitExe,
  interactiveShellFor,
  resolveGitBash,
  shellKindFromLabel,
  shellLabel,
} from './shells';

describe('shellLabel / shellKindFromLabel', () => {
  it('round-trips every kind', () => {
    for (const kind of ['powershell', 'cmd', 'gitbash'] as const) {
      expect(shellKindFromLabel(shellLabel(kind))).toBe(kind);
    }
  });
  it('falls back to powershell for unknown/legacy names', () => {
    expect(shellKindFromLabel(null)).toBe('powershell');
    expect(shellKindFromLabel('')).toBe('powershell');
    expect(shellKindFromLabel('bash')).toBe('powershell');
  });
});

describe('gitBashFromGitExe', () => {
  it('maps the cmd-rooted git.exe to sibling bin\\bash.exe', () => {
    expect(gitBashFromGitExe('C:\\Program Files\\Git\\cmd\\git.exe')).toBe(
      'C:\\Program Files\\Git\\bin\\bash.exe',
    );
  });
  it('maps the bin-rooted git.exe', () => {
    expect(gitBashFromGitExe('C:\\Program Files\\Git\\bin\\git.exe')).toBe(
      'C:\\Program Files\\Git\\bin\\bash.exe',
    );
  });
  it('handles forward slashes', () => {
    expect(gitBashFromGitExe('C:/Program Files/Git/cmd/git.exe')).toBe(
      'C:\\Program Files\\Git\\bin\\bash.exe',
    );
  });
  it('returns null when git.exe was not resolved to a real Git layout', () => {
    expect(gitBashFromGitExe('git')).toBeNull(); // unresolved bare name
    expect(gitBashFromGitExe('C:\\other\\place\\git.exe')).toBeNull();
  });
});

describe('resolveGitBash', () => {
  it('returns the first candidate that exists on disk', () => {
    // The test runner itself exists; use it as a stand-in "found" path.
    const real = process.execPath;
    expect(resolveGitBash([real], () => 'git')).toBe(real);
  });
  it('returns null when no candidate exists and git has no bash sibling', () => {
    expect(resolveGitBash(['C:\\nope\\bash.exe'], () => 'git')).toBeNull();
  });
  it('does not fall for System32 bash (WSL): a non-Git git path yields null', () => {
    expect(resolveGitBash(['C:\\nope\\bash.exe'], () => 'C:\\Windows\\System32\\where.exe')).toBeNull();
  });
});

describe('interactiveShellFor', () => {
  it('powershell → powershell with -NoLogo', () => {
    const spec = interactiveShellFor('powershell');
    expect(spec).not.toBeNull();
    expect(spec!.file.toLowerCase()).toContain('powershell');
    expect(spec!.args).toEqual(['-NoLogo']);
  });
  it('cmd → cmd with no args', () => {
    const spec = interactiveShellFor('cmd');
    expect(spec).not.toBeNull();
    expect(spec!.file.toLowerCase()).toContain('cmd');
    expect(spec!.args).toEqual([]);
  });
});
