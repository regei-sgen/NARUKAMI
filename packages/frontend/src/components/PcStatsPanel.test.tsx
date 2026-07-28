import { describe, expect, it, vi, beforeEach } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import {
  PcStatsPanel,
  bootStamp,
  ease,
  fmtUptime,
  loadLevel,
  normTemp,
  rampRgb,
  resample,
  tempLevel,
  tracePaths,
} from './PcStatsPanel';
import type { PcStats } from '../types';
import { api } from '../api';

// Shaped from the real /api/pcstats payload on this machine.
function stats(over: Partial<PcStats> = {}): PcStats {
  return {
    ts: 1,
    cpu: {
      model: 'Intel(R) Core(TM) i7-9750H CPU @ 2.60GHz',
      cores: 12,
      physicalCores: 6,
      speedMHz: 2592,
      loadPct: 33,
      tjMaxC: 100,
    },
    mem: { usedMB: 15721, totalMB: 32647 },
    series: {
      cpu: [10, 22, 33],
      mem: [15000, 15400, 15721],
      cpuTemp: [80, 84, 87],
      gpuLoad: [3, 4, 5],
      gpuTemp: [54, 55, 56],
    },
    gpus: [
      {
        name: 'NVIDIA GeForce RTX 2070 with Max-Q Design',
        tempC: 56,
        utilPct: 5,
        memUtilPct: 1,
        memUsedMB: 1490,
        memTotalMB: 8192,
        powerW: 28.04,
        powerLimitW: null,
        clockMHz: 1140,
        fanPct: null,
      },
    ],
    gpuSource: 'nvidia-smi',
    temps: [
      { label: 'CPU', celsius: 87, note: 'via lhm-web' },
      { label: 'GPU', celsius: 56 },
    ],
    status: {
      hostname: 'Dan',
      platform: 'win32',
      release: '10.0.26200',
      arch: 'x64',
      uptimeSec: 42060,
      battery: { percent: 92, charging: true, label: 'on AC' },
      disk: { freeGB: 94.4, totalGB: 475.7 },
    },
    ...over,
  };
}

describe('fmtUptime / bootStamp', () => {
  it('formats days, hours, and minutes', () => {
    expect(fmtUptime(42060)).toBe('11h 41m');
    expect(fmtUptime(200000)).toBe('2d 7h');
    expect(fmtUptime(2460)).toBe('41m');
  });
  it('guards against nonsense input', () => {
    expect(fmtUptime(-1)).toBe('—');
    expect(fmtUptime(NaN)).toBe('—');
  });
  it('marks a boot time that fell on an earlier day', () => {
    const now = new Date('2026-07-28T09:00:00');
    expect(bootStamp(3 * 3600, now)).toBe('06:00');
    expect(bootStamp(14 * 3600, now)).toBe('19:00 yesterday');
  });
});

describe('rampRgb / normTemp', () => {
  it('runs cold-green to hot-coral across the range', () => {
    expect(rampRgb(0)).toEqual([36, 229, 142]);
    expect(rampRgb(1)).toEqual([255, 106, 85]);
    // hotter input is never "cooler" in the red channel
    expect(rampRgb(0.9)[0]).toBeGreaterThan(rampRgb(0.1)[0]);
  });
  it('clamps out-of-range and non-finite input instead of producing NaN', () => {
    expect(rampRgb(-5)).toEqual([36, 229, 142]);
    expect(rampRgb(9)).toEqual([255, 106, 85]);
    expect(rampRgb(NaN).every(Number.isFinite)).toBe(true);
  });
  it('normalises temperature onto 0..1 across 30-100 °C', () => {
    expect(normTemp(30)).toBe(0);
    expect(normTemp(100)).toBe(1);
    expect(normTemp(65)).toBeCloseTo(0.5, 2);
    expect(normTemp(200)).toBe(1);
  });
});

describe('tracePaths', () => {
  it('draws a SMOOTH curve, not straight segments', () => {
    const { line } = tracePaths([40, 60, 80, 55]);
    // cubic Béziers, not line-tos — the zig-zag look came from "L" segments
    expect(line).toContain(' C ');
    expect(line).not.toMatch(/\sL\s/);
    expect(line.startsWith('M 0.00')).toBe(true);
    expect(line).toContain('120.00');
  });

  it('passes exactly through every sample, so no value is misreported', () => {
    const series = [40, 70, 55, 90];
    const { line } = tracePaths(series);
    // each Bézier ends on its sample point: check the curve endpoints
    const ends = [...line.matchAll(/C [\d.-]+ [\d.-]+, [\d.-]+ [\d.-]+, ([\d.-]+) ([\d.-]+)/g)];
    expect(ends.length).toBe(series.length - 1);
    const yFor = (v: number): number => 40 - normTemp(v) * 38 - 1;
    ends.forEach((m, i) => {
      expect(Number(m[2])).toBeCloseTo(yFor(series[i + 1]), 1);
    });
  });

  it('builds a closed area back to the baseline', () => {
    const { area } = tracePaths([40, 60, 80]);
    expect(area.startsWith('M 0 40')).toBe(true);
    expect(area.endsWith('L 120 40 Z')).toBe(true);
    expect(area).toContain(' C ');
  });

  it('emits nothing for a series too short to draw', () => {
    expect(tracePaths([])).toEqual({ line: '', area: '' });
    expect(tracePaths([50])).toEqual({ line: '', area: '' });
  });

  it('keeps every coordinate inside the viewBox, even out-of-range values', () => {
    const { line } = tracePaths([-40, 20, 300]);
    const ys = [...line.matchAll(/(?:M|,) [\d.-]+ ([\d.-]+)/g)].map((m) => Number(m[1]));
    for (const y of ys) {
      expect(y).toBeGreaterThanOrEqual(0);
      expect(y).toBeLessThanOrEqual(40);
    }
  });

  it('never overshoots past the samples it is drawn from', () => {
    // Unclamped spline tangents bulge beyond the data — on a temperature chart
    // that paints a peak hotter than anything actually measured.
    const series = [40, 95, 40, 95, 40];
    const { line } = tracePaths(series);
    const yFor = (v: number): number => 40 - normTemp(v) * 38 - 1;
    const hottest = yFor(95); // smallest y
    const coolest = yFor(40); // largest y
    const ys = [...line.matchAll(/(?:M|,) [\d.-]+ ([\d.-]+)/g)].map((m) => Number(m[1]));
    for (const y of ys) {
      expect(y).toBeGreaterThanOrEqual(hottest - 0.01);
      expect(y).toBeLessThanOrEqual(coolest + 0.01);
    }
  });
});

describe('ease / resample', () => {
  it('eases toward the target without overshooting', () => {
    expect(ease(0, 10, 0.5)).toBe(5);
    expect(ease(0, 10, 1)).toBe(10);
    expect(ease(0, 10, 0)).toBe(0);
    // a wild k must not fly past the target
    expect(ease(0, 10, 5)).toBe(10);
    expect(ease(0, 10, -3)).toBe(0);
  });

  it('resamples any series to a fixed length so frames can be tweened', () => {
    expect(resample([0, 10], 3)).toEqual([0, 5, 10]);
    expect(resample([5], 4)).toEqual([5, 5, 5, 5]);
    expect(resample([], 3)).toEqual([0, 0, 0]);
    expect(resample([1, 2, 3, 4], 2)).toEqual([1, 4]);
  });

  it('keeps resampled values within the original range', () => {
    const out = resample([30, 90, 45], 40);
    expect(out.length).toBe(40);
    expect(Math.min(...out)).toBeGreaterThanOrEqual(30);
    expect(Math.max(...out)).toBeLessThanOrEqual(90);
  });
});

describe('tempLevel / loadLevel', () => {
  it('bands temperatures, treating an absent reading as its own state', () => {
    expect(tempLevel(null)).toBe('none');
    expect(tempLevel(56)).toBe('ok');
    expect(tempLevel(72)).toBe('warn');
    expect(tempLevel(91)).toBe('crit');
  });
  it('bands load', () => {
    expect(loadLevel(5)).toBe('ok');
    expect(loadLevel(75)).toBe('warn');
    expect(loadLevel(96)).toBe('crit');
  });
});

describe('PcStatsPanel', () => {
  beforeEach(() => vi.restoreAllMocks());

  it('renders the CPU and GPU instrument cards with live values', async () => {
    vi.spyOn(api, 'getPcStats').mockResolvedValue(stats());
    const { container } = render(<PcStatsPanel />);
    await waitFor(() => expect(screen.getByText('CPU')).toBeTruthy());

    // header identity: model cleaned up, physical/logical cores, clock
    expect(screen.getByText(/Intel Core i7-9750H · 6C\/12T · 2\.59 GHz/)).toBeTruthy();
    // Tj max is shown because it was derived from the sensor
    expect(screen.getByText(/Tj max 100/)).toBeTruthy();
    // headroom from the real ceiling, not a guess
    expect(screen.getByText('13°C of headroom')).toBeTruthy();
    // two traces drawn
    expect(container.querySelectorAll('svg.pcv-trace').length).toBe(2);
  });

  it('shows GPU chips and marks unreported ones as unavailable', async () => {
    vi.spyOn(api, 'getPcStats').mockResolvedValue(stats());
    const { container } = render(<PcStatsPanel />);
    await waitFor(() => expect(screen.getByText(/RTX 2070/)).toBeTruthy());
    expect(screen.getByText('28.0 W')).toBeTruthy();
    expect(screen.getByText('1140 MHz')).toBeTruthy();
    // fan is [N/A] on this card — shown as unavailable, never as 0
    expect(screen.getByText('fan —')).toBeTruthy();
    expect(container.querySelector('.pcv-chip.na')).toBeTruthy();
  });

  it('reports an unavailable CPU sensor instead of inventing a number', async () => {
    vi.spyOn(api, 'getPcStats').mockResolvedValue(
      stats({
        cpu: { ...stats().cpu, tjMaxC: null },
        temps: [
          { label: 'CPU', celsius: null, note: 'no sensor — run LibreHardwareMonitor' },
          { label: 'GPU', celsius: 56 },
        ],
      }),
    );
    render(<PcStatsPanel />);
    await waitFor(() => expect(screen.getByText(/run LibreHardwareMonitor/)).toBeTruthy());
    // no Tj max claim when it could not be derived
    expect(screen.queryByText(/Tj max/)).toBeNull();
    expect(screen.queryByText('0°C')).toBeNull();
  });

  it('renders the system rail', async () => {
    vi.spyOn(api, 'getPcStats').mockResolvedValue(stats());
    render(<PcStatsPanel />);
    await waitFor(() => expect(screen.getByText('DAN')).toBeTruthy());
    expect(screen.getByText('11h 41m')).toBeTruthy();
    expect(screen.getByText(/battery 92% · on AC/)).toBeTruthy();
    expect(screen.getByText(/381 G used of 476 G · 20% free/)).toBeTruthy();
    expect(screen.getByText('gpu · nvidia-smi')).toBeTruthy();
  });

  it('keeps metric column widths in CSS, not inline, so narrow layouts can reflow', async () => {
    // An inline flex-basis cannot be overridden by a media query, which is why
    // the three columns overlapped on a portrait phone.
    vi.spyOn(api, 'getPcStats').mockResolvedValue(stats());
    const { container } = render(<PcStatsPanel />);
    await waitFor(() => expect(screen.getByText('CPU')).toBeTruthy());

    expect(container.querySelectorAll('.pcv-m-load').length).toBe(2);
    expect(container.querySelectorAll('.pcv-m-mem').length).toBe(2);
    for (const m of container.querySelectorAll<HTMLElement>('.pcv-metric')) {
      expect(m.style.flex, 'metric width must come from CSS').toBe('');
    }
  });

  it('does not poll while inactive', () => {
    const spy = vi.spyOn(api, 'getPcStats').mockResolvedValue(stats());
    render(<PcStatsPanel active={false} />);
    expect(spy).not.toHaveBeenCalled();
  });

  it('reports a machine with no GPU telemetry', async () => {
    vi.spyOn(api, 'getPcStats').mockResolvedValue(
      stats({ gpus: [], gpuSource: null, temps: [{ label: 'CPU', celsius: 87, note: 'via lhm-web' }] }),
    );
    render(<PcStatsPanel />);
    await waitFor(() => expect(screen.getByText(/no GPU telemetry available/)).toBeTruthy());
    expect(screen.getByText('gpu · unavailable')).toBeTruthy();
  });

  it('surfaces a failed feed rather than rendering blank', async () => {
    vi.spyOn(api, 'getPcStats').mockRejectedValue(new Error('boom'));
    render(<PcStatsPanel />);
    await waitFor(() => expect(screen.getByText('sensor feed unavailable')).toBeTruthy());
  });
});
