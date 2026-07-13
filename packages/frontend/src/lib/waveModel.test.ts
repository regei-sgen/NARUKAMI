import { describe, it, expect } from 'vitest';
import { pulseAmount, addPulse, decayLevel } from './waveModel';

describe('pulseAmount', () => {
  it('is zero for no output', () => {
    expect(pulseAmount(0)).toBe(0);
    expect(pulseAmount(-50)).toBe(0);
    expect(pulseAmount(NaN)).toBe(0);
  });

  it('grows with chunk size', () => {
    expect(pulseAmount(400)).toBeCloseTo(0.16, 5); // 0.06 + 400/4000
    expect(pulseAmount(400)).toBeGreaterThan(pulseAmount(40));
  });

  it('saturates at 0.5 for a huge burst', () => {
    expect(pulseAmount(1_000_000)).toBe(0.5);
    expect(pulseAmount(10_000)).toBe(0.5);
  });
});

describe('addPulse', () => {
  it('raises the level by the pulse amount', () => {
    expect(addPulse(0, 400)).toBeCloseTo(0.16, 5);
    expect(addPulse(0.2, 400)).toBeCloseTo(0.36, 5);
  });

  it('never exceeds 1 (a streaming burst pins, not overflows)', () => {
    expect(addPulse(0.9, 1_000_000)).toBe(1);
    expect(addPulse(1, 4000)).toBe(1);
  });

  it('treats a negative starting level as zero', () => {
    expect(addPulse(-5, 400)).toBeCloseTo(0.16, 5);
  });
});

describe('decayLevel', () => {
  it('decays toward zero when there is no floor', () => {
    const a = decayLevel(1, 0);
    expect(a).toBeCloseTo(0.94, 5);
    expect(decayLevel(a, 0)).toBeLessThan(a);
  });

  it('snaps to a flat line once it dips below epsilon (idle settles)', () => {
    expect(decayLevel(0.003, 0)).toBe(0);
    // repeated decay converges to exactly 0, never a lingering drift
    let l = 0.5;
    for (let i = 0; i < 200; i++) l = decayLevel(l, 0);
    expect(l).toBe(0);
  });

  it('never falls below the sustained floor while a process is working', () => {
    expect(decayLevel(0.1, 0.34)).toBe(0.34);
    let l = 1;
    for (let i = 0; i < 200; i++) l = decayLevel(l, 0.34);
    expect(l).toBeCloseTo(0.34, 5); // rests at the floor, stays alive
  });

  it('lets a spike ride above the floor, then settles back to it', () => {
    const spiked = decayLevel(0.9, 0.34);
    expect(spiked).toBeGreaterThan(0.34);
    expect(spiked).toBeCloseTo(0.846, 3);
  });

  it('clamps a floor above 1 down to 1', () => {
    expect(decayLevel(0.2, 5)).toBe(1);
  });
});
