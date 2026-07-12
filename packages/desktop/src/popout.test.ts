import { describe, it, expect } from 'vitest';
import { parseViewportPopoutParams, viewportPopoutKey, type ViewportPopoutParams } from './popout';

describe('viewportPopoutKey', () => {
  it('is stable for the same device, so re-opening focuses instead of duplicating', () => {
    expect(viewportPopoutKey('p', 'b', 'desktop')).toBe(viewportPopoutKey('p', 'b', 'desktop'));
  });

  it('differs per viewport — Desktop and Mobile of one browser get separate windows', () => {
    expect(viewportPopoutKey('p', 'b', 'desktop')).not.toBe(viewportPopoutKey('p', 'b', 'mobile'));
  });

  it('differs per browser tab and per project', () => {
    expect(viewportPopoutKey('p', 'b1', 'desktop')).not.toBe(viewportPopoutKey('p', 'b2', 'desktop'));
    expect(viewportPopoutKey('p1', 'b', 'desktop')).not.toBe(viewportPopoutKey('p2', 'b', 'desktop'));
  });

  it('produces a unique key for every distinct triple (no collisions → true multi-popout)', () => {
    const keys = new Set<string>();
    for (const proj of ['p1', 'p2']) {
      for (const b of ['b1', 'b2']) {
        for (const vp of ['mobile', 'tablet', 'desktop']) {
          keys.add(viewportPopoutKey(proj, b, vp));
        }
      }
    }
    expect(keys.size).toBe(2 * 2 * 3);
  });
});

describe('parseViewportPopoutParams', () => {
  it('accepts a drag-out payload and keeps the cursor point', () => {
    expect(
      parseViewportPopoutParams({ projectId: 'p', browserId: 'b', vpId: 'desktop', pos: { x: 10, y: 20 } }),
    ).toEqual<ViewportPopoutParams>({ projectId: 'p', browserId: 'b', vpId: 'desktop', pos: { x: 10, y: 20 } });
  });

  it('accepts a click payload (no pos)', () => {
    expect(parseViewportPopoutParams({ projectId: 'p', browserId: 'b', vpId: 'mobile' })).toEqual<
      ViewportPopoutParams
    >({ projectId: 'p', browserId: 'b', vpId: 'mobile', pos: undefined });
  });

  it('coerces numeric-string coords and drops a non-finite pos', () => {
    expect(parseViewportPopoutParams({ projectId: 'p', browserId: 'b', vpId: 'm', pos: { x: '10', y: '20' } })?.pos)
      .toEqual({ x: 10, y: 20 });
    expect(
      parseViewportPopoutParams({ projectId: 'p', browserId: 'b', vpId: 'm', pos: { x: 'nope', y: 5 } })?.pos,
    ).toBeUndefined();
    expect(
      parseViewportPopoutParams({ projectId: 'p', browserId: 'b', vpId: 'm', pos: { x: NaN, y: 5 } })?.pos,
    ).toBeUndefined();
  });

  it('rejects malformed / hostile payloads', () => {
    expect(parseViewportPopoutParams(null)).toBeNull();
    expect(parseViewportPopoutParams('x')).toBeNull();
    expect(parseViewportPopoutParams(42)).toBeNull();
    expect(parseViewportPopoutParams({})).toBeNull();
    expect(parseViewportPopoutParams({ browserId: 'b', vpId: 'm' })).toBeNull(); // no project
    expect(parseViewportPopoutParams({ projectId: '', browserId: 'b', vpId: 'm' })).toBeNull(); // empty
    expect(parseViewportPopoutParams({ projectId: 'p', browserId: 'b' })).toBeNull(); // no vp
    expect(parseViewportPopoutParams({ projectId: 'p', browserId: 5, vpId: 'm' })).toBeNull(); // wrong type
  });
});
