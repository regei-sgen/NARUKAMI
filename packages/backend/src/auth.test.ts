import { describe, it, expect, beforeAll } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

// Point the token file at a temp path BEFORE importing the module (config reads
// RUNNER_TOKEN_FILE at load time), so tests never touch the real .runner-token.
const tokenFile = path.join(os.tmpdir(), `narukami-test-token-${process.pid}.txt`);
let auth: typeof import('./auth');

beforeAll(async () => {
  try {
    fs.unlinkSync(tokenFile);
  } catch {
    /* not there */
  }
  process.env.RUNNER_TOKEN_FILE = tokenFile;
  auth = await import('./auth');
});

describe('getToken', () => {
  it('generates a 64-char hex token and persists it', () => {
    const t = auth.getToken();
    expect(t).toMatch(/^[0-9a-f]{64}$/);
    expect(fs.readFileSync(tokenFile, 'utf8').trim()).toBe(t);
  });
  it('is stable across calls (cached)', () => {
    expect(auth.getToken()).toBe(auth.getToken());
  });
});

describe('isValidToken', () => {
  it('accepts the real token and rejects everything else', () => {
    const t = auth.getToken();
    expect(auth.isValidToken(t)).toBe(true);
    expect(auth.isValidToken('wrong')).toBe(false);
    expect(auth.isValidToken('')).toBe(false);
    expect(auth.isValidToken(undefined)).toBe(false);
    expect(auth.isValidToken(null)).toBe(false);
    // same length, different content
    expect(auth.isValidToken('0'.repeat(64))).toBe(false);
  });
});

describe('bearerFromHeader', () => {
  it('extracts the token', () => {
    expect(auth.bearerFromHeader('Bearer abc123')).toBe('abc123');
  });
  it('is case-insensitive on the scheme and trims', () => {
    expect(auth.bearerFromHeader('bearer   abc  ')).toBe('abc');
  });
  it('returns null for other/absent schemes', () => {
    expect(auth.bearerFromHeader('Basic abc')).toBeNull();
    expect(auth.bearerFromHeader('')).toBeNull();
    expect(auth.bearerFromHeader(undefined)).toBeNull();
  });
});

describe('isAllowedOrigin', () => {
  it('allows any loopback origin (any port) and rejects the rest', () => {
    // The packaged desktop app serves the SPA from the backend on a random
    // loopback port, so origin is http://127.0.0.1:<random> — any port is fine.
    expect(auth.isAllowedOrigin('http://localhost:5173')).toBe(true);
    expect(auth.isAllowedOrigin('http://127.0.0.1:5173')).toBe(true);
    expect(auth.isAllowedOrigin('http://localhost:3000')).toBe(true);
    expect(auth.isAllowedOrigin('http://[::1]:4000')).toBe(true);
    // Anything non-loopback stays rejected.
    expect(auth.isAllowedOrigin('http://evil.com')).toBe(false);
    expect(auth.isAllowedOrigin('http://192.168.1.5:5173')).toBe(false);
    expect(auth.isAllowedOrigin(undefined)).toBe(false);
  });
});

describe('isAllowedHost', () => {
  it('allows only loopback hosts', () => {
    expect(auth.isAllowedHost('127.0.0.1:4000')).toBe(true);
    expect(auth.isAllowedHost('localhost:4000')).toBe(true);
    expect(auth.isAllowedHost('127.0.0.1')).toBe(true);
    expect(auth.isAllowedHost('evil.com:4000')).toBe(false);
    expect(auth.isAllowedHost('192.168.1.5:4000')).toBe(false);
    expect(auth.isAllowedHost(undefined)).toBe(false);
  });
});
