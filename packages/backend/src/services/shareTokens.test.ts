import { describe, it, expect, beforeEach } from 'vitest';
import {
  mintShare,
  validateShare,
  revokeShare,
  revokeSharesForRun,
  listShares,
  activeShareCount,
  sweepExpiredShares,
  _clearAllShares,
} from './shareTokens';

beforeEach(() => _clearAllShares());

describe('shareTokens', () => {
  it('mints a scoped share whose token validates only for its own run', () => {
    const s = mintShare('run-A', { canInput: true });
    expect(s.runId).toBe('run-A');
    expect(s.token).toMatch(/^[0-9a-f]{64}$/); // 256-bit secret handed to the minter
    expect(validateShare(s.token, 'run-A')?.runId).toBe('run-A');
  });

  it('rejects a token used against the wrong run (cross-run isolation)', () => {
    const s = mintShare('run-A');
    expect(validateShare(s.token, 'run-A')).not.toBeNull();
    expect(validateShare(s.token, 'run-B')).toBeNull(); // scoped — cannot reach B
  });

  it('rejects an unknown / empty token', () => {
    mintShare('run-A');
    expect(validateShare('nope', 'run-A')).toBeNull();
    expect(validateShare('', 'run-A')).toBeNull();
    expect(validateShare(null, 'run-A')).toBeNull();
    expect(validateShare(undefined, 'run-A')).toBeNull();
  });

  it('validates without a runId filter but still checks existence + expiry', () => {
    const s = mintShare('run-A', { ttlMs: 60_000 }, 0);
    expect(validateShare(s.token, undefined, 0)?.runId).toBe('run-A');
    expect(validateShare(s.token, undefined, 60_000)).toBeNull();
  });

  it('expires a share at its TTL and drops it from the store', () => {
    const t0 = 1_000_000;
    const s = mintShare('run-A', { ttlMs: 60_000 }, t0);
    expect(validateShare(s.token, 'run-A', t0 + 59_000)).not.toBeNull();
    expect(validateShare(s.token, 'run-A', t0 + 60_000)).toBeNull(); // exactly at TTL → gone
    expect(activeShareCount(t0 + 60_000)).toBe(0);
  });

  it('clamps TTL to [1min, 24h]', () => {
    const t0 = 0;
    const tooLong = mintShare('r1', { ttlMs: 999 * 60 * 60 * 1000 }, t0);
    expect(tooLong.expiresAt).toBe(24 * 60 * 60 * 1000);
    const tooShort = mintShare('r2', { ttlMs: 1 }, t0);
    expect(tooShort.expiresAt).toBe(60 * 1000);
  });

  it('defaults canInput to true and honors an explicit false (read-only mirror)', () => {
    expect(mintShare('r1').canInput).toBe(true);
    expect(mintShare('r2', { canInput: false }).canInput).toBe(false);
  });

  it('revokes by id', () => {
    const s = mintShare('run-A');
    expect(validateShare(s.token, 'run-A')).not.toBeNull();
    expect(revokeShare(s.id)).toBe(true);
    expect(validateShare(s.token, 'run-A')).toBeNull();
    expect(revokeShare('does-not-exist')).toBe(false);
  });

  it('revokes every share for a run when it ends', () => {
    mintShare('run-A');
    mintShare('run-A');
    mintShare('run-B');
    expect(activeShareCount()).toBe(3);
    expect(revokeSharesForRun('run-A')).toBe(2);
    expect(activeShareCount()).toBe(1);
  });

  it('sweeps expired shares proactively', () => {
    const t0 = 0;
    mintShare('run-A', { ttlMs: 60_000 }, t0);
    mintShare('run-B', { ttlMs: 120_000 }, t0);
    expect(sweepExpiredShares(t0 + 90_000)).toBe(1);
    expect(activeShareCount(t0 + 90_000)).toBe(1);
  });

  it('listShares never exposes the secret token', () => {
    mintShare('run-A');
    const list = listShares();
    expect(list).toHaveLength(1);
    expect(Object.keys(list[0])).not.toContain('token');
  });

  it('mints unique tokens + ids across calls', () => {
    const a = mintShare('r');
    const b = mintShare('r');
    expect(a.token).not.toBe(b.token);
    expect(a.id).not.toBe(b.id);
  });
});
