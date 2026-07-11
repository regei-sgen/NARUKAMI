import { describe, expect, it } from 'vitest';
import { aggregateTimes, cpuPercent } from './vitals';

const cpu = (idle: number, busy: number) => ({
  times: { user: busy, nice: 0, sys: 0, idle, irq: 0 },
});

describe('aggregateTimes', () => {
  it('sums idle and total across cores', () => {
    const agg = aggregateTimes([cpu(100, 50), cpu(200, 30)]);
    expect(agg.idle).toBe(300);
    expect(agg.total).toBe(380);
  });
});

describe('cpuPercent', () => {
  it('computes busy% from the delta between readings', () => {
    // over the interval: total +100, idle +40 → busy 60%
    const prev = { idle: 1000, total: 5000 };
    const cur = { idle: 1040, total: 5100 };
    expect(cpuPercent(prev, cur)).toBe(60);
  });

  it('returns 0 on a degenerate (no-progress) delta', () => {
    const t = { idle: 1000, total: 5000 };
    expect(cpuPercent(t, t)).toBe(0);
  });

  it('clamps to 0..100 on clock weirdness', () => {
    expect(cpuPercent({ idle: 100, total: 100 }, { idle: 90, total: 200 })).toBe(100);
    expect(cpuPercent({ idle: 0, total: 100 }, { idle: 300, total: 200 })).toBe(0);
  });
});
