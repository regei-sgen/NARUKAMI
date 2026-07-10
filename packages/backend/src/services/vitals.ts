import os from 'node:os';

/**
 * Header vitals — WHOLE-MACHINE CPU and memory (not just NARUKAMI's own
 * process tree): the header cluster reads as a PC performance meter.
 *
 * Sampling is pure Node — CPU% from the delta of aggregate os.cpus() times
 * between ticks (busy = everything but idle), memory from totalmem-freemem.
 * No child processes, no platform branches, nothing to fail.
 */

export interface CpuTimes {
  idle: number;
  total: number;
}

export interface VitalsSample {
  ts: number;
  /** whole-machine CPU busy %, 0-100 */
  cpu: number;
  /** whole-machine memory in use, MB */
  memMB: number;
}

/** Aggregate os.cpus() times into one idle/total pair. Pure. */
export function aggregateTimes(cpus: ReadonlyArray<{ times: Record<string, number> }>): CpuTimes {
  let idle = 0;
  let total = 0;
  for (const c of cpus) {
    for (const [k, v] of Object.entries(c.times)) {
      total += v;
      if (k === 'idle') idle += v;
    }
  }
  return { idle, total };
}

/** CPU busy % between two aggregate readings. Pure; 0 on a degenerate delta. */
export function cpuPercent(prev: CpuTimes, cur: CpuTimes): number {
  const dTotal = cur.total - prev.total;
  const dIdle = cur.idle - prev.idle;
  if (dTotal <= 0) return 0;
  const pct = (1 - dIdle / dTotal) * 100;
  return Math.round(Math.min(100, Math.max(0, pct)) * 10) / 10;
}

// ── sampler loop + ring buffer ───────────────────────────────────────────────

const SAMPLE_MS = 5000;
const HISTORY = 36; // 3 minutes of context for the sparklines

const history: VitalsSample[] = [];
let prevTimes: CpuTimes | null = null;
let timer: NodeJS.Timeout | null = null;

function tick(): void {
  const cur = aggregateTimes(os.cpus());
  const cpu = prevTimes ? cpuPercent(prevTimes, cur) : 0;
  prevTimes = cur;
  history.push({
    ts: Date.now(),
    cpu,
    memMB: Math.round((os.totalmem() - os.freemem()) / (1024 * 1024)),
  });
  if (history.length > HISTORY) history.splice(0, history.length - HISTORY);
}

/** Start the background sampler (idempotent). */
export function startVitalsSampler(): void {
  if (timer) return;
  timer = setInterval(tick, SAMPLE_MS);
  timer.unref?.();
  tick();
}

export function stopVitalsSampler(): void {
  if (timer) clearInterval(timer);
  timer = null;
}

export function vitalsHistory(): VitalsSample[] {
  return history.slice();
}

/** Machine totals so the frontend can scale the memory spark meaningfully. */
export function machineInfo(): { totalMemMB: number; cores: number } {
  return {
    totalMemMB: Math.round(os.totalmem() / (1024 * 1024)),
    cores: os.cpus().length,
  };
}
