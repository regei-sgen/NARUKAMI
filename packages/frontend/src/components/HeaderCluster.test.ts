import { describe, expect, it } from 'vitest';
import { fmtEta } from './HeaderCluster';

const NOW = 1_700_000_000_000;
const inMin = (m: number) => Math.round((NOW + m * 60000) / 1000);

describe('fmtEta', () => {
  it('formats sub-hour as (Nm)', () => {
    expect(fmtEta(inMin(41), NOW)).toBe('(41m)');
  });
  it('formats hours as (XhYYm)', () => {
    expect(fmtEta(inMin(232), NOW)).toBe('(3h52m)');
  });
  it('formats days as (XdYh)', () => {
    expect(fmtEta(inMin(9240), NOW)).toBe('(6d10h)');
  });
  it('floors at (1m) and empties without a reset time', () => {
    expect(fmtEta(inMin(0.2), NOW)).toBe('(1m)');
    expect(fmtEta(undefined, NOW)).toBe('');
  });
});
