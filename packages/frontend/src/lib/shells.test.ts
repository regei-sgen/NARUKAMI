import { describe, expect, it } from 'vitest';
import { shellLabel } from './shells';

describe('shellLabel', () => {
  it('labels each shell kind', () => {
    expect(shellLabel('powershell')).toBe('PowerShell');
    expect(shellLabel('cmd')).toBe('CMD');
    expect(shellLabel('gitbash')).toBe('Git Bash');
  });
});
