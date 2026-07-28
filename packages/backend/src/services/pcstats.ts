import { execFile } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import { resolveExecutable } from './exec';
import { vitalsHistory } from './vitals';

/**
 * PC Stats popup feed — the machine detail the header sparklines can't carry:
 * per-GPU load / VRAM / temperature, whatever temperature sensors this box
 * actually exposes, and machine status (uptime, disk, battery).
 *
 * Every probe is best-effort and reports its OWN availability. A missing sensor
 * must surface as "n/a" with a reason, never as a fabricated number — hardware
 * differs wildly here. On a typical NVIDIA laptop, for instance, GPU temp is
 * readable through nvidia-smi while the ACPI thermal zone answers "Not
 * supported", so CPU temp is genuinely unknowable without a kernel driver.
 *
 * Nothing is sampled in the background: the stats are pull-through cached, so a
 * session that never opens the popup never spawns a probe process.
 */

export interface GpuStat {
  name: string;
  tempC: number | null;
  utilPct: number | null;
  memUtilPct: number | null;
  memUsedMB: number | null;
  memTotalMB: number | null;
  powerW: number | null;
  powerLimitW: number | null;
  clockMHz: number | null;
  fanPct: number | null;
}

export interface TempReading {
  label: string;
  celsius: number | null;
  /** why it is null, when it is — the UI shows this instead of a fake number */
  note?: string;
}

/**
 * Recent history for the sparklines. CPU/MEM come from the always-on vitals
 * sampler, so those lines are populated the instant the window opens; the GPU
 * series accrues while the readout is actually being polled (nothing samples
 * the GPU in the background — probing it costs a process spawn).
 */
export interface PcSeries {
  cpu: number[];
  mem: number[];
  cpuTemp: number[];
  gpuLoad: number[];
  gpuTemp: number[];
}

export interface PcStats {
  ts: number;
  cpu: {
    model: string;
    /** logical processors (threads) */
    cores: number;
    /** physical cores, when the OS will tell us */
    physicalCores: number | null;
    speedMHz: number;
    loadPct: number;
    /** throttle temperature, derived from the sensor rather than assumed */
    tjMaxC: number | null;
  };
  mem: { usedMB: number; totalMB: number };
  series: PcSeries;
  gpus: GpuStat[];
  /** null when no GPU telemetry tool answered (no NVIDIA driver, or non-Windows) */
  gpuSource: 'nvidia-smi' | null;
  temps: TempReading[];
  status: {
    hostname: string;
    platform: string;
    release: string;
    arch: string;
    uptimeSec: number;
    battery: { percent: number; charging: boolean; label: string } | null;
    disk: { freeGB: number; totalGB: number } | null;
  };
}

// ── pure parsers (unit-tested against output captured from real hardware) ────

/**
 * One nvidia-smi CSV field → number. nvidia-smi prints bracketed placeholders
 * ("[N/A]", "[Not Supported]") for fields a given card doesn't report, which
 * Number() would happily turn into NaN — those must become null.
 */
export function numOrNull(raw: string | undefined): number | null {
  const s = (raw ?? '').trim();
  if (!s || s.startsWith('[') || /^(n\/a|unknown)$/i.test(s)) return null;
  const n = Number(s);
  return Number.isFinite(n) ? n : null;
}

/** Fields requested from nvidia-smi, in the order parseGpuCsv expects them. */
export const GPU_QUERY = [
  'name',
  'temperature.gpu',
  'utilization.gpu',
  'utilization.memory',
  'memory.used',
  'memory.total',
  'power.draw',
  'power.limit',
  'clocks.sm',
  'fan.speed',
].join(',');

const GPU_FIELDS = 10;

/**
 * Parse `nvidia-smi --query-gpu=<GPU_QUERY> --format=csv,noheader,nounits`
 * (one line per GPU). Pure.
 *
 * The name is taken from the FRONT and the metrics from the BACK so a card
 * whose model name contains a comma cannot shift every numeric column.
 */
export function parseGpuCsv(stdout: string): GpuStat[] {
  const out: GpuStat[] = [];
  for (const line of stdout.split(/\r?\n/)) {
    if (!line.trim()) continue;
    const parts = line.split(',');
    if (parts.length < GPU_FIELDS) continue;
    const nameParts = parts.length - (GPU_FIELDS - 1);
    const name = parts.slice(0, nameParts).join(',').trim();
    const f = parts.slice(nameParts);
    out.push({
      name,
      tempC: numOrNull(f[0]),
      utilPct: numOrNull(f[1]),
      memUtilPct: numOrNull(f[2]),
      memUsedMB: numOrNull(f[3]),
      memTotalMB: numOrNull(f[4]),
      powerW: numOrNull(f[5]),
      powerLimitW: numOrNull(f[6]),
      clockMHz: numOrNull(f[7]),
      fanPct: numOrNull(f[8]),
    });
  }
  return out;
}

/**
 * ACPI thermal zone readings are tenths of a Kelvin. Pure; null for an absent
 * or physically impossible reading (some firmware reports 0 or a sentinel).
 */
export function deciKelvinToC(raw: string | undefined): number | null {
  const n = numOrNull(raw);
  if (n === null || n <= 0) return null;
  const c = n / 10 - 273.15;
  if (c < -50 || c > 150) return null;
  return Math.round(c * 10) / 10;
}

/**
 * Win32_Battery BatteryStatus code → external-power flag + label, per the
 * documented CIM_Battery mapping. Note `charging` means "running on external
 * power", which is the honest reading of code 2 — Microsoft defines it as "the
 * system has access to AC so no battery is being discharged. However, the
 * battery is not necessarily charging" — hence its separate "on AC" label.
 * Pure.
 */
export function batteryStatus(code: number | null): { charging: boolean; label: string } {
  switch (code) {
    case 1:
      return { charging: false, label: 'discharging' };
    case 2:
      return { charging: true, label: 'on AC' };
    case 3:
      return { charging: true, label: 'fully charged' };
    case 4:
      return { charging: false, label: 'low' };
    case 5:
      return { charging: false, label: 'critical' };
    case 6:
      return { charging: true, label: 'charging' };
    case 7:
      return { charging: true, label: 'charging (high)' };
    case 8:
      return { charging: true, label: 'charging (low)' };
    case 9:
      return { charging: true, label: 'charging (critical)' };
    case 11:
      return { charging: false, label: 'partially charged' };
    default:
      return { charging: false, label: 'unknown' };
  }
}

export type CpuTempSource = 'lhm-web' | 'hwmonitor-wmi' | 'acpi';

export interface WinProbe {
  battery: { percent: number; code: number | null } | null;
  cpuTempC: number | null;
  /** which provider answered — surfaced so the UI can attribute the reading */
  cpuTempSource: CpuTempSource | null;
  tjMaxC: number | null;
  physicalCores: number | null;
}

/** A node of LibreHardwareMonitor's /data.json tree. */
interface LhmNode {
  Text?: string;
  Value?: string;
  Children?: LhmNode[];
}

/**
 * Pull the CPU package temperature out of LibreHardwareMonitor's /data.json.
 *
 * Current LHM builds ship NO WMI provider (the lib only consumes WMI) — sensors
 * are published by its optional HTTP server instead, as a tree of nodes whose
 * values are display strings like "66.0 °C". We walk it and prefer the package
 * sensor (what iCUE shows); the hottest core is the fallback, since some CPUs
 * expose per-core sensors only.
 *
 * Pure, so it can be tested against a captured payload.
 */
export function parseLhmJson(raw: string): number | null {
  return parseLhmCpu(raw).tempC;
}

/**
 * CPU temperature AND the throttle ceiling from LibreHardwareMonitor.
 *
 * Tj max isn't published directly, but LHM exposes "CPU Core #N Distance to
 * TjMax" alongside "CPU Core #N" — their sum IS Tj max. Deriving it beats
 * hard-coding 100 °C, which is wrong on plenty of chips.
 */
export function parseLhmCpu(raw: string): { tempC: number | null; tjMaxC: number | null } {
  let root: LhmNode;
  try {
    root = JSON.parse(raw) as LhmNode;
  } catch {
    return { tempC: null, tjMaxC: null };
  }

  let pkg: number | null = null;
  let hottestCore: number | null = null;
  /** core label -> its temperature / its distance-to-TjMax */
  const coreTemp = new Map<string, number>();
  const coreDist = new Map<string, number>();

  // "66.0 °C" / "66,0 °C" → 66 (LHM formats with the machine's decimal comma)
  const celsius = (v: string | undefined): number | null => {
    if (!v || !/°\s*C/i.test(v)) return null;
    const n = Number(v.replace(/°\s*C/i, '').replace(',', '.').trim());
    return Number.isFinite(n) && n > 0 && n < 150 ? n : null;
  };

  const walk = (node: LhmNode, underCpu: boolean): void => {
    const text = node.Text ?? '';
    // Intel/AMD CPU branches are named by model; match the vendor prefixes.
    const isCpu = underCpu || /\b(intel|amd)\b.*\b(core|ryzen|xeon|threadripper)\b/i.test(text);
    // Real payloads carry sensors that LOOK like core temperatures but aren't a
    // reading of one: "Core Max"/"Core Average" are derived aggregates, and
    // "CPU Core #1 Distance to TjMax" is a headroom delta (a low number like
    // 12 °C) that would badly under-report the CPU if treated as a temperature.
    const derived = /distance to/i.test(text) || /\b(max|average)\b/i.test(text);
    const c = celsius(node.Value);
    if (c !== null && isCpu) {
      const distMatch = /^(.*?)\s*distance to tjmax$/i.exec(text);
      if (distMatch) {
        coreDist.set(distMatch[1].trim().toLowerCase(), c);
      } else if (/package/i.test(text)) {
        pkg = pkg === null ? c : Math.max(pkg, c);
      } else if (/core/i.test(text) && !derived) {
        hottestCore = hottestCore === null ? c : Math.max(hottestCore, c);
        coreTemp.set(text.trim().toLowerCase(), c);
      }
    }
    for (const child of node.Children ?? []) walk(child, isCpu);
  };
  walk(root, false);

  // Tj max = a core's temperature + that core's distance to Tj max.
  let tjMaxC: number | null = null;
  for (const [label, temp] of coreTemp) {
    const dist = coreDist.get(label);
    if (dist === undefined) continue;
    const candidate = Math.round(temp + dist);
    if (candidate >= 60 && candidate <= 130) {
      tjMaxC = tjMaxC === null ? candidate : Math.max(tjMaxC, candidate);
    }
  }

  const picked = pkg ?? hottestCore;
  return {
    tempC: picked === null ? null : Math.round(picked * 10) / 10,
    tjMaxC,
  };
}

/**
 * Parse the two-line output of the single PowerShell probe below. Pure.
 * Both lines are optional-by-value: "BATT none" on a desktop, "TEMP" with an
 * empty value on the (common) machines whose ACPI thermal zone is unsupported.
 */
export function parseWinProbe(stdout: string): WinProbe {
  const probe: WinProbe = {
    battery: null,
    cpuTempC: null,
    cpuTempSource: null,
    tjMaxC: null,
    physicalCores: null,
  };
  let acpi: number | null = null;
  for (const line of stdout.split(/\r?\n/)) {
    const s = line.trim();
    if (s.startsWith('CORES ')) {
      const n = numOrNull(s.slice(6));
      if (n !== null && n > 0 && n <= 512) probe.physicalCores = n;
    } else if (s.startsWith('BATT ')) {
      const [pct, code] = s.slice(5).split(',');
      const percent = numOrNull(pct);
      if (percent !== null) probe.battery = { percent, code: numOrNull(code) };
    } else if (s.startsWith('CPUTEMP')) {
      // A hardware-monitor provider reports plain celsius.
      const c = numOrNull(s.slice(7));
      if (c !== null && c > 0 && c < 150) {
        probe.cpuTempC = Math.round(c * 10) / 10;
        probe.cpuTempSource = 'hwmonitor-wmi';
      }
    } else if (s.startsWith('TEMP')) {
      acpi = deciKelvinToC(s.slice(4));
    }
  }
  // Prefer the hardware-monitor reading; ACPI is the coarse fallback.
  if (probe.cpuTempC === null && acpi !== null) {
    probe.cpuTempC = acpi;
    probe.cpuTempSource = 'acpi';
  }
  return probe;
}

/** Bytes-from-statfs → GB, one decimal. Pure. */
export function toGB(bytes: number): number {
  return Math.round((bytes / 1024 ** 3) * 10) / 10;
}

// ── probes ──────────────────────────────────────────────────────────────────

const EXEC_TIMEOUT_MS = 8000;

/** execFile → stdout, or null on any failure (missing binary, timeout, non-zero). */
function run(file: string, args: string[]): Promise<string | null> {
  return new Promise((resolve) => {
    execFile(
      file,
      args,
      { timeout: EXEC_TIMEOUT_MS, windowsHide: true, maxBuffer: 1024 * 1024 },
      (err, stdout) => resolve(err ? null : stdout),
    );
  });
}

/**
 * One PowerShell spawn (~0.5s) for the slow-moving Windows-only readings.
 *
 * CPU temperature: Windows exposes no first-party API for the CPU's on-die
 * sensor — reading the Intel/AMD MSR needs a kernel driver, which is why tools
 * like iCUE and HWMonitor ship one (iCUE's own SDK is lighting-only and cannot
 * be queried for it). So we ask any HARDWARE MONITOR the user already runs that
 * publishes its sensors over WMI — LibreHardwareMonitor or OpenHardwareMonitor
 * — and fall back to the coarse ACPI thermal zone. Absent both, the reading is
 * honestly reported as unavailable.
 */
const PS_PROBE = [
  "$b = Get-CimInstance Win32_Battery -ErrorAction SilentlyContinue | Select-Object -First 1;",
  "if ($b) { 'BATT ' + ('{0},{1}' -f $b.EstimatedChargeRemaining, $b.BatteryStatus) } else { 'BATT none' };",
  "$c = ''; foreach ($ns in @('root/LibreHardwareMonitor','root/OpenHardwareMonitor')) {",
  "try { $s = Get-CimInstance -Namespace $ns -ClassName Sensor -ErrorAction Stop |",
  "Where-Object { $_.SensorType -eq 'Temperature' -and $_.Name -match 'CPU Package|Package|CPU Total|Core Max' } |",
  "Select-Object -First 1; if ($s) { $c = $s.Value; break } } catch { } };",
  "'CPUTEMP ' + $c;",
  "$cores = (Get-CimInstance Win32_Processor -ErrorAction SilentlyContinue |",
  "Measure-Object -Property NumberOfCores -Sum).Sum; 'CORES ' + $cores;",
  "$t = ''; try { $t = (Get-CimInstance -Namespace root/wmi -ClassName MSAcpi_ThermalZoneTemperature",
  "-ErrorAction Stop | Measure-Object -Property CurrentTemperature -Maximum).Maximum } catch { $t = '' };",
  "'TEMP ' + $t",
].join(' ');

async function readGpus(): Promise<{ gpus: GpuStat[]; source: 'nvidia-smi' | null }> {
  const out = await run(resolveExecutable('nvidia-smi'), [
    `--query-gpu=${GPU_QUERY}`,
    '--format=csv,noheader,nounits',
  ]);
  if (out == null) return { gpus: [], source: null };
  const gpus = parseGpuCsv(out);
  return gpus.length > 0 ? { gpus, source: 'nvidia-smi' } : { gpus: [], source: null };
}

/** LibreHardwareMonitor's HTTP sensor feed (Options → Remote Web Server). */
const LHM_PORT = Number(process.env.NARUKAMI_LHM_PORT) || 8085;

/**
 * Read the CPU temperature from a running LibreHardwareMonitor. Silent and fast
 * when it isn't running — this is polled while the stats window is open.
 */
async function readLhmWeb(): Promise<{ tempC: number | null; tjMaxC: number | null }> {
  try {
    const ctrl = new AbortController();
    const t = setTimeout(() => ctrl.abort(), 1200);
    const res = await fetch(`http://127.0.0.1:${LHM_PORT}/data.json`, { signal: ctrl.signal });
    clearTimeout(t);
    if (!res.ok) return { tempC: null, tjMaxC: null };
    return parseLhmCpu(await res.text());
  } catch {
    return { tempC: null, tjMaxC: null }; // not running / not enabled / wrong port
  }
}

async function readWinProbe(): Promise<WinProbe> {
  if (process.platform !== 'win32') return { battery: null, cpuTempC: null, cpuTempSource: null, tjMaxC: null, physicalCores: null };
  const out = await run('powershell.exe', [
    '-NoProfile',
    '-NonInteractive',
    '-ExecutionPolicy',
    'Bypass',
    '-Command',
    PS_PROBE,
  ]);
  const probe = out == null
    ? { battery: null, cpuTempC: null, cpuTempSource: null, tjMaxC: null, physicalCores: null }
    : parseWinProbe(out);

  // A running LibreHardwareMonitor is the most accurate source available to an
  // unelevated app (it owns the driver), so it wins over the WMI/ACPI fallbacks.
  const lhm = await readLhmWeb();
  if (lhm.tempC !== null) {
    probe.cpuTempC = lhm.tempC;
    probe.cpuTempSource = 'lhm-web';
  }
  if (lhm.tjMaxC !== null) probe.tjMaxC = lhm.tjMaxC;
  return probe;
}

function readDisk(): { freeGB: number; totalGB: number } | null {
  try {
    const root = process.platform === 'win32' ? process.cwd().slice(0, 3) : '/';
    const s = fs.statfsSync(root);
    return { freeGB: toGB(s.bsize * s.bfree), totalGB: toGB(s.bsize * s.blocks) };
  } catch {
    return null;
  }
}

// ── pull-through cache ──────────────────────────────────────────────────────

const FRESH_MS = 2000; // GPU probe is ~70ms; matches the popup's poll rate
const SLOW_FRESH_MS = 20000; // PowerShell probe is ~500ms and moves slowly

let cache: { at: number; value: PcStats } | null = null;
let slow: { at: number; value: WinProbe } | null = null;
let inflight: Promise<PcStats> | null = null;

/** Sparkline ring for the on-demand probes — appended once per real collection. */
const GPU_RING = 60;
const gpuRing: { load: number | null; temp: number | null; cpuTemp: number | null }[] = [];

/** Drop leading nulls and coerce to a plottable series. Pure. */
export function plottable(values: (number | null)[]): number[] {
  const out = values.filter((v): v is number => v !== null);
  return out.length >= 2 ? out : [];
}

async function slowProbe(): Promise<WinProbe> {
  if (slow && Date.now() - slow.at < SLOW_FRESH_MS) return slow.value;
  const value = await readWinProbe();
  slow = { at: Date.now(), value };
  return value;
}

async function collect(): Promise<PcStats> {
  const [{ gpus, source }, probe] = await Promise.all([readGpus(), slowProbe()]);
  const cpus = os.cpus();
  const vitals = vitalsHistory();
  const last = vitals.at(-1);

  gpuRing.push({
    load: gpus[0]?.utilPct ?? null,
    temp: gpus[0]?.tempC ?? null,
    cpuTemp: probe.cpuTempC,
  });
  if (gpuRing.length > GPU_RING) gpuRing.splice(0, gpuRing.length - GPU_RING);

  const temps: TempReading[] = [];
  temps.push(
    probe.cpuTempC !== null
      ? { label: 'CPU', celsius: probe.cpuTempC, note: `via ${probe.cpuTempSource}` }
      : {
          label: 'CPU',
          celsius: null,
          // Actionable, not just a shrug: Windows has no first-party CPU-temp
          // API, and iCUE keeps its reading behind a private driver.
          note:
            process.platform === 'win32'
              ? 'admin-gated sensor — enable LibreHardwareMonitor web server'
              : 'no sensor source on this platform',
        },
  );
  for (const g of gpus) {
    temps.push(
      g.tempC !== null
        ? { label: gpus.length > 1 ? `GPU · ${g.name}` : 'GPU', celsius: g.tempC }
        : { label: 'GPU', celsius: null, note: 'not reported by driver' },
    );
  }

  return {
    ts: Date.now(),
    cpu: {
      model: cpus[0]?.model?.trim() ?? 'unknown',
      cores: cpus.length,
      physicalCores: probe.physicalCores,
      speedMHz: cpus[0]?.speed ?? 0,
      loadPct: last?.cpu ?? 0,
      tjMaxC: probe.tjMaxC,
    },
    mem: {
      usedMB: Math.round((os.totalmem() - os.freemem()) / (1024 * 1024)),
      totalMB: Math.round(os.totalmem() / (1024 * 1024)),
    },
    series: {
      cpu: vitals.map((v) => v.cpu),
      mem: vitals.map((v) => v.memMB),
      cpuTemp: plottable(gpuRing.map((g) => g.cpuTemp)),
      gpuLoad: plottable(gpuRing.map((g) => g.load)),
      gpuTemp: plottable(gpuRing.map((g) => g.temp)),
    },
    gpus,
    gpuSource: source,
    temps,
    status: {
      hostname: os.hostname(),
      platform: process.platform,
      release: os.release(),
      arch: os.arch(),
      uptimeSec: Math.round(os.uptime()),
      battery: probe.battery
        ? { percent: probe.battery.percent, ...batteryStatus(probe.battery.code) }
        : null,
      disk: readDisk(),
    },
  };
}

/**
 * Current stats, cached for FRESH_MS. Concurrent callers share one collection
 * so an open popup in two windows can't fan out into duplicate probe processes.
 */
export async function getPcStats(): Promise<PcStats> {
  if (cache && Date.now() - cache.at < FRESH_MS) return cache.value;
  if (inflight) return inflight;
  const p = collect()
    .then((value) => {
      cache = { at: Date.now(), value };
      return value;
    })
    .finally(() => {
      if (inflight === p) inflight = null;
    });
  inflight = p;
  return p;
}

/** Test seam: drop cached probes so a following call re-collects. */
export function resetPcStatsCache(): void {
  cache = null;
  slow = null;
  gpuRing.length = 0;
}
