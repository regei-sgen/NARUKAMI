import { describe, it, expect } from 'vitest';
import { makeRateLimiter } from './terminals';
import { tailLines } from '../services/runner';

describe('tailLines', () => {
  it('returns the last n lines', () => {
    expect(tailLines('a\nb\nc\nd', 2)).toBe('c\nd');
  });
  it('normalizes CRLF/CR and drops trailing blank lines', () => {
    expect(tailLines('a\r\nb\r\n\r\n', 5)).toBe('a\nb');
    expect(tailLines('x\ry\r', 5)).toBe('x\ny');
  });
  it('returns everything when n exceeds line count', () => {
    expect(tailLines('a\nb', 10)).toBe('a\nb');
  });
  it('returns empty string for n<=0', () => {
    expect(tailLines('a\nb', 0)).toBe('');
  });
});

describe('makeRateLimiter', () => {
  it('allows up to max within the window, then blocks', () => {
    const allow = makeRateLimiter(3, 1000);
    expect(allow('a', 0)).toBe(true);
    expect(allow('a', 10)).toBe(true);
    expect(allow('a', 20)).toBe(true);
    expect(allow('a', 30)).toBe(false); // 4th in window -> blocked
  });

  it('recovers once the window slides past old hits', () => {
    const allow = makeRateLimiter(2, 1000);
    expect(allow('a', 0)).toBe(true);
    expect(allow('a', 100)).toBe(true);
    expect(allow('a', 200)).toBe(false);
    // At t=1101 the hit at t=100 is still in-window (1101-100=1001>1000 -> expired),
    // and t=0 expired long ago, so one slot frees up.
    expect(allow('a', 1101)).toBe(true);
  });

  it('tracks keys independently', () => {
    const allow = makeRateLimiter(1, 1000);
    expect(allow('a', 0)).toBe(true);
    expect(allow('b', 0)).toBe(true); // different key, own budget
    expect(allow('a', 1)).toBe(false);
  });

  it('evicts a fully-expired key rather than carrying stale hits forward', () => {
    // Exercises the map-eviction path added to stop unbounded growth (one entry
    // per distinct terminal id ever targeted): once a key's window fully elapses,
    // it is deleted and a later hit starts fresh.
    const allow = makeRateLimiter(1, 100);
    expect(allow('t', 0)).toBe(true);
    expect(allow('t', 50)).toBe(false); // still in window
    expect(allow('t', 250)).toBe(true); // window elapsed → evicted → fresh slot
  });
});
