import { describe, expect, it } from 'vitest';
import { scanForMarker } from './wrapupMarker';

const MARKER = '<<NARUKAMI:WRAPUP-DONE>>';

describe('scanForMarker', () => {
  it('finds the marker inside a single chunk', () => {
    const r = scanForMarker('', `done!\r\n${MARKER}\r\n`, MARKER);
    expect(r.found).toBe(true);
  });

  it('misses when the marker is absent', () => {
    const r = scanForMarker('', 'just some output', MARKER);
    expect(r.found).toBe(false);
  });

  it('stitches a marker split across two chunks via the carry', () => {
    const first = scanForMarker('', `output ${MARKER.slice(0, 10)}`, MARKER);
    expect(first.found).toBe(false);
    const second = scanForMarker(first.carry, MARKER.slice(10), MARKER);
    expect(second.found).toBe(true);
  });

  it('bounds the carry to marker length - 1 so memory never grows', () => {
    const r = scanForMarker('', 'x'.repeat(10_000), MARKER);
    expect(r.carry.length).toBe(MARKER.length - 1);
  });

  it('a three-way split (marker across three chunks) still lands', () => {
    const a = scanForMarker('', MARKER.slice(0, 8), MARKER);
    const b = scanForMarker(a.carry, MARKER.slice(8, 16), MARKER);
    const c = scanForMarker(b.carry, MARKER.slice(16), MARKER);
    expect(a.found).toBe(false);
    expect(b.found).toBe(false);
    expect(c.found).toBe(true);
  });
});
