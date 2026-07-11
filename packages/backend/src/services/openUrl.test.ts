import { describe, expect, it } from 'vitest';
import { validateDevUrl } from './openUrl';

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
