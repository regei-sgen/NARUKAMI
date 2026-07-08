import { describe, it, expect, vi } from 'vitest';
import { pulseActivity, subscribeActivity } from './activityBus';

describe('activityBus', () => {
  it('delivers the pulse byte count to a subscriber', () => {
    const seen: number[] = [];
    const off = subscribeActivity((b) => seen.push(b));
    pulseActivity(120);
    pulseActivity(3);
    off();
    expect(seen).toEqual([120, 3]);
  });

  it('defaults the pulse weight to 1', () => {
    const fn = vi.fn();
    const off = subscribeActivity(fn);
    pulseActivity();
    off();
    expect(fn).toHaveBeenCalledWith(1);
  });

  it('stops delivering after unsubscribe', () => {
    const fn = vi.fn();
    const off = subscribeActivity(fn);
    pulseActivity(5);
    off();
    pulseActivity(6);
    expect(fn).toHaveBeenCalledTimes(1);
  });

  it('fans out to every active subscriber', () => {
    const a = vi.fn(), b = vi.fn();
    const offA = subscribeActivity(a);
    const offB = subscribeActivity(b);
    pulseActivity(9);
    offA();
    offB();
    expect(a).toHaveBeenCalledWith(9);
    expect(b).toHaveBeenCalledWith(9);
  });

  it('a throwing subscriber does not stop the others', () => {
    const good = vi.fn();
    const offBad = subscribeActivity(() => {
      throw new Error('boom');
    });
    const offGood = subscribeActivity(good);
    expect(() => pulseActivity(7)).not.toThrow();
    offBad();
    offGood();
    expect(good).toHaveBeenCalledWith(7);
  });
});
