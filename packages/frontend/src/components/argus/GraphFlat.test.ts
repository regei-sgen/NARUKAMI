import { describe, it, expect } from 'vitest';
import { layoutStep, project2d, hitTest2d, type P2 } from './GraphFlat';

const node = (id: string) => ({ id, label: id, kind: 'memory' });

describe('project2d', () => {
  it('maps world → screen with center + pan + zoom', () => {
    expect(project2d({ x: 10, y: 0 }, 800, 600, { x: 0, y: 0 }, 1)).toEqual({ sx: 410, sy: 300 });
    expect(project2d({ x: 0, y: 0 }, 800, 600, { x: 20, y: -10 }, 2)).toEqual({ sx: 420, sy: 290 });
    expect(project2d({ x: 5, y: 5 }, 800, 600, { x: 0, y: 0 }, 2)).toEqual({ sx: 410, sy: 310 });
  });
});

describe('hitTest2d', () => {
  const nodes = [node('a'), node('b')];
  const scr = new Map([
    ['a', { sx: 100, sy: 100 }],
    ['b', { sx: 300, sy: 100 }],
  ]);
  const r = () => 6;
  it('returns the node under the cursor', () => {
    expect(hitTest2d(nodes, scr, { x: 102, y: 101 }, r, 1)?.id).toBe('a');
  });
  it('returns null on empty space', () => {
    expect(hitTest2d(nodes, scr, { x: 200, y: 400 }, r, 1)).toBeNull();
  });
  it('picks the nearest candidate', () => {
    expect(hitTest2d(nodes, scr, { x: 298, y: 100 }, r, 1)?.id).toBe('b');
  });
});

describe('layoutStep (flat 2D force sim — not a sphere)', () => {
  it('repels two overlapping nodes apart', () => {
    const nodes = [node('a'), node('b')];
    const pos = new Map<string, P2>([
      ['a', { x: -1, y: 0, vx: 0, vy: 0 }],
      ['b', { x: 1, y: 0, vx: 0, vy: 0 }],
    ]);
    const before = pos.get('b')!.x - pos.get('a')!.x;
    layoutStep(nodes, [], pos, 1, new Set());
    expect(pos.get('b')!.x - pos.get('a')!.x).toBeGreaterThan(before);
  });

  it('holds a pinned node fixed while a free node moves', () => {
    const nodes = [node('a'), node('b')];
    const pos = new Map<string, P2>([
      ['a', { x: 0, y: 0, vx: 0, vy: 0 }],
      ['b', { x: 2, y: 0, vx: 0, vy: 0 }],
    ]);
    layoutStep(nodes, [], pos, 1, new Set(['a']));
    expect(pos.get('a')).toMatchObject({ x: 0, y: 0, vx: 0, vy: 0 });
    expect(pos.get('b')!.x).not.toBe(2);
  });

  it('does NOT snap nodes onto a fixed radius (unlike the globe): a spring pulls them inward', () => {
    const nodes = [node('a'), node('b')];
    const pos = new Map<string, P2>([
      ['a', { x: -200, y: 0, vx: 0, vy: 0 }],
      ['b', { x: 200, y: 0, vx: 0, vy: 0 }],
    ]);
    layoutStep(nodes, [{ source: 'a', target: 'b' }], pos, 1, new Set());
    // rest length ~74, they start 400 apart → distance from origin shrinks freely
    expect(Math.abs(pos.get('a')!.x)).toBeLessThan(200);
  });
});
